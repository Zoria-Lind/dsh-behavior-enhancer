// dsh-behavior-enhancer v1.2(B7):write / pwsh 后的变更核验模块。
// 通道(10-ecolink B7 卡硬性规定):{prepend:true} + await next() + 以
// decision.content ?? result.content 为基线重建 content——本插件在 profile bundles
// 里最内层,外层 handler(outputLadder/fileDiff/better-edit)会用 result.content
// 重建并丢掉 additionalContexts,所以不能用 additionalContexts 当通道。
// 层序边界(0A §D2):prepend 只保证压过默认 listener;若将来有人在我们外侧再
// prepend 一个"用 result.content 重建"的 handler,我们的 diff 会丢——设计上接受的
// 边界(00 P14),不用层序技巧对抗。
// 分工:edit 不做(better-edit 已输出 diff 块);write 追加 meta.diffs 摘要(可选实现);
// pwsh 是主战场——tools/pre-execute 记 git 基线,post-execute 做前后差集,只报本次新增。
// 铁律:pre/post 任何分支都必须显式 return decision;git 调用带超时,绝不阻塞工具链。
import { execFile, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const MAX_DIFF_BYTES = 80 * 1024 // 截断口径与 better-edit 对齐(400 行 / 80KB)

// git 绝对路径解析:execFile('git') 走进程 PATH,在部分宿主环境(托盘/沙箱拉起)里
// 找不到 git → spawn ENOENT → 基线永远 null(2026-09-14 实测:解析器找到仓库根但
// 标注仍为 0,noBaseline 689)。`where git` 解析 + 常见安装位兜底。
const GIT_CANDIDATES = [
  (() => { try { const out = String(execFileSync('where', ['git'], { windowsHide: true, timeout: 2000 })); const hit = out.split(/\r?\n/)[0]?.trim(); return hit || null } catch { return null } })(),
  'D:\\download\\Git\\cmd\\git.exe',
  'C:\\Program Files\\Git\\cmd\\git.exe',
]
const GIT_BIN = GIT_CANDIDATES.find((p) => p && existsSync(p)) ?? 'git'

// 诊断埋点(2026-09-14 深夜排查 ⚠ D 三次修复未生效):每条 pwsh 一行,
// 落本地文件(harness stdout 被丢弃,文件是唯一可见通道)。排查完可删。
const DEBUG_LOG = 'D:/dsh/behavior-enhancer/wdv-debug.log'
const dbg = (msg) => { try { appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`, 'utf8') } catch { /* ignore */ } }

// 与 dsh-tool-pwsh 的 resolveWorkdir 同款:相对 workdir 要相对会话 cwd 解析。
// exec 上没有 cwd 字段,只能拼 exec.arguments.workdir ?? session.header.cwd;禁止 process.cwd()。
function resolveCwd(exec) {
  const headerCwd = exec?.agent?.session?.header?.cwd
  const requested = exec?.arguments?.workdir
  if (typeof requested === 'string' && requested.trim().length > 0) {
    return (headerCwd && !isAbsolute(requested)) ? resolve(headerCwd, requested) : requested
  }
  return typeof headerCwd === 'string' && headerCwd.length > 0 ? headerCwd : undefined
}

function gitPorcelain(cwd, timeoutMs) {
  return new Promise((resolvePromise) => {
    if (typeof cwd !== 'string' || cwd === '') return resolvePromise(null)
    // 非 -z 模式:`--porcelain -z` 的 rename/copy 记录是 `XY new\0old\0`,配对解析易错
    execFile(GIT_BIN, ['status', '--porcelain'], { cwd, timeout: timeoutMs, windowsHide: true },
      (error, stdout) => resolvePromise(error ? null : String(stdout)))
  })
}

// 从 pwsh 命令文本提取 Windows 绝对路径候选,逐级向上找 .git 根。
// 动机(2026-09-14 实测):模型对目标仓库执行 pwsh 时通常不带 workdir →
// resolveCwd 落回会话 cwd(往往不是 git 仓库)→ 基线 null → noBaseline 358 次、
// ⚠ D 标注从未出现。命令文本里的目标路径才是仓库位置的可靠线索。
const WIN_PATH_RE = /(?:^|[\s'"`(])([A-Za-z]:\\[^\s'"`;|&<>()]+)/g
export function findGitRootsFromCommand(command) {
  const roots = []
  const seen = new Set()
  const text = String(command ?? '')
  let m
  WIN_PATH_RE.lastIndex = 0
  while ((m = WIN_PATH_RE.exec(text))) {
    let cur = m[1].replace(/["'`]+$/, '')
    for (let depth = 0; depth < 12; depth++) {
      if (existsSync(join(cur, '.git'))) {
        if (!seen.has(cur)) { seen.add(cur); roots.push(cur) }
        break
      }
      const parent = dirname(cur)
      if (parent === cur) break
      cur = parent
    }
  }
  return roots
}

// write:内核已算好 meta.diffs(computeHunkDiffs)但不进模型可见 content → 只补"注入"。
// 新建文件(before===null)时 meta.diffs 为空,给专门标记。
function summarizeWrite(result) {
  if (result?.value?.before === null) return `[write-new] ${result?.value?.path ?? '(unknown)'}`
  const diffs = result?.meta?.diffs
  if (!Array.isArray(diffs) || diffs.length === 0) return ''
  return `[write-diff] ${diffs.length} 个文件\n${diffs.slice(0, 20).map((d) => `- ${d?.path ?? '?'}`).join('\n')}`
}

export function createWriteDiffVerifyModule(ctx, config, stats) {
  if (!config?.enabled) return () => {}
  if (!ctx || typeof ctx.on !== 'function') return () => {}
  const timeoutMs = config.writeDiffTimeoutMs
  const maxLines = config.writeDiffMaxLines

  const baseline = new Map() // key → 命令执行前的 git 快照(只观测,不改参数)

  // ① execute 阶段记基线(整仓快照,post 端做差集 → 只报本次新增)。
  // ⚠ 必须挂 tools/execute 而不是 pre-execute(2026-09-14 两轮修复的血泪):
  //   - pre-execute 链会被审批系统(approval:ask)与 hardGate 截断——它们返回
  //     ask/deny 时不调 next(),且 scope 链装配把 agent 层的审批钩子排在 root 层
  //     监听器(本插件)之外,prepend 也越不过去 → 基线捕获永远轮不到跑;
  //   - execute 链只在审批通过、真正要执行时走;cache 模块(同款钩子)只截断
  //     可缓存工具,pwsh 不在此列 → 捕获必达。
  //   本 handler 必须原样返回 next() 结果(execute 链的返回值是工具结果,不是决策)。
  const onExecute = async (exec, next) => {
    if (exec?.name === 'pwsh' && config.gitStatusOnPwsh) {
      const key = exec?.callId ?? exec
      // 基线根目录:优先从命令文本解析 .git 根(模型常不带 workdir);解析不到再回落 resolveCwd
      const roots = findGitRootsFromCommand(exec?.arguments?.command)
      const fallback = resolveCwd(exec)
      let snapshot = null
      let resolvedRoot = null
      for (const root of [...roots, ...(typeof fallback === 'string' ? [fallback] : [])]) {
        snapshot = await gitPorcelain(root, timeoutMs)
        if (typeof snapshot === 'string') { resolvedRoot = root; break }
      }
      baseline.set(key, { root: resolvedRoot, snapshot })
      dbg(`EXEC key=${String(key).slice(0, 12)} roots=${JSON.stringify(roots)} root=${resolvedRoot} snapshot=${snapshot === null ? 'null' : 'len:' + snapshot.length}`)
    }
    return next()
  }

  // ② post-execute:必须 prepend 上浮 + 重建 content
  const onPost = async (exec, result, next) => {
    const decision = await next()
    try {
      // 先取基线再删(deny/失败等任何决策路径都要清理,防 Map 泄漏),再做核验分支
      const key = exec?.callId ?? exec
      const isPwshGit = exec?.name === 'pwsh' && config.gitStatusOnPwsh
      const entry = isPwshGit ? baseline.get(key) : undefined
      if (isPwshGit) baseline.delete(key)
      const baselineBefore = entry?.snapshot
      if (decision?.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
      if (exec?.parent !== undefined) return decision // subagent:meta 不存在,优雅降级
      let text = ''
      if (exec?.name === 'write') {
        text = summarizeWrite(result)
      } else if (exec?.name === 'edit') {
        text = '' // edit 的 diff 由 dsh-better-edit 负责,不做第二份(避免重复)
      } else if (isPwshGit) {
        if (typeof baselineBefore !== 'string') {
          stats?.bump('writeDiffVerify.noBaseline', 1)
          dbg(`POST key=${String(key).slice(0, 12)} NO-BASELINE kind=${decision?.kind}`)
          return decision
        }
        // ⚠ 与捕获端同根比较:旧代码这里用 resolveCwd(exec)(会话 cwd,常非仓库)
        // → after 恒 null → 标注从未出现(2026-09-15 凌晨诊断日志破案)
        const after = await gitPorcelain(entry?.root, timeoutMs)
        if (after === null) {
          stats?.bump('writeDiffVerify.noBaseline', 1)
          dbg(`POST key=${String(key).slice(0, 12)} AFTER-NULL root=${entry?.root}`)
          return decision // 非 git 目录 / git 缺失 / 超时:静默不追加,不报错不阻塞
        }
        const seen = new Set(baselineBefore.split('\n').filter(Boolean))
        const changed = after.split('\n').filter(Boolean).filter((line) => !seen.has(line)) // 只报本次新增
        dbg(`POST key=${String(key).slice(0, 12)} changed=${changed.length} after=${JSON.stringify(after.slice(0, 80))}`)
        if (changed.length === 0) return decision
        // 删除码只用 "D " / " D"( porcelain XY;" M" 是工作区修改,不是删除)
        const marked = changed
          .slice(0, maxLines)
          .map((l) => (/^D\s|^\sD/.test(l) ? `⚠ ${l}` : `  ${l}`))
        const truncated = changed.length > maxLines ? `\n  …另有 ${changed.length - maxLines} 条未展示` : ''
        const byteTruncated = marked.join('\n').length > MAX_DIFF_BYTES
          ? `${marked.join('\n').slice(0, MAX_DIFF_BYTES)}\n  …(超过 80KB 已截断)`
          : marked.join('\n')
        text = `[workspace-diff] 退出码 ${result?.value?.exitCode ?? '?'}，本次新增 ${changed.length} 处变更\n${byteTruncated}${truncated}`
      }
      if (text === '') return decision
      stats?.bump('writeDiffVerify.notices', 1)
      const base = decision.content ?? result.content // 基线必须是 decision(对层序不敏感的唯一写法)
      return { ...decision, content: [...(base ?? []), { type: 'text', text }] }
    } catch (err) {
      console.warn(`[dsh-behavior-enhancer] writeDiffVerify 失败,放行原结果(${err?.message ?? err})`)
      return decision
    }
  }

  // ⚠ post 监听器保持 prepend(层序:外层 handler 用 result.content 重建时本插件 diff 不丢)
  const offExe = ctx.on('tools/execute', onExecute)
  const offPost = ctx.on('tools/post-execute', onPost, { prepend: true })
  return () => {
    baseline.clear()
    try { offExe?.() } catch { /* noop */ }
    try { offPost?.() } catch { /* noop */ }
  }
}
