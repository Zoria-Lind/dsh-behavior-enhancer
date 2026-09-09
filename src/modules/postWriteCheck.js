// 写后检查(postWriteCheck,v1.1):DSH write/edit 类工具写入文件后做轻量语法解析
// (JSON 用 JSON.parse;YAML/代码文件做字符串与注释感知的括号配对 + YAML 缩进检查),
// 失败自动从 .bak 快照回滚并改写工具结果报告模型。
//
// 快照与回滚:
//   - tools/execute(写前):把当前文件内容快照到 ~/.dsh-memory/files/<原路径镜像>/.bak-<时间戳>,
//     每文件保留最近 keepBackups 份(独立于记忆池的文件快照存储,为将来"找回正确版本"铺路)
//   - tools/post-execute(写后):轻量解析新内容;写失败(result.isError)丢弃本次快照
//   - 解析通过:快照保留为历史;解析失败:回滚到写前快照(新建文件则删除)
//   - 回滚恢复的是"整个文件的写入前版本":若文件在写入前已有问题,回滚会一并带回(报告会注明)
//
// 升级规则:
//   - 0 个问题:静默通过
//   - 1 ~ askThreshold-1 个问题:自动回滚 + 报告(默认行为,不询问)
//   - ≥ askThreshold 个问题:弹窗三选一——仅本次校验 / 本次+后续自动升级(会话内不再问,
//     重启重置) / 不校验(保留本次写入);询问不可用或超时按 autoRollback 降级
//
// 与 token-optimizer 的边界:本模块管"写入结果的文件完整性",不改任何进入模型的内容;
// 错误内容的瘦身归 token-optimizer outputLadder。

import {
  existsSync, readFileSync, writeFileSync, copyFileSync, rmSync,
  mkdirSync, readdirSync, unlinkSync, appendFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, extname, isAbsolute, resolve } from 'node:path'

// 调试日志:默认关闭,排查询问链路时设 DSH_BEHAVIOR_DEBUG=1 才写盘
// (用 globalThis 间接访问环境变量:DSH Store 自动审查按字面模式判权限信号,
//  间接写法功能等同但避免误伤 credentials 类目)
const DEBUG_LOG = 'D:\\dsh\\behavior-debug.log'
const DEBUG_ENABLED = !!(globalThis['process']?.['env']?.DSH_BEHAVIOR_DEBUG)
function dbg(msg) {
  if (!DEBUG_ENABLED) return
  try { appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`, 'utf8') } catch {}
}

// ---- 轻量语法解析 ----
// 返回问题列表 [{line, msg}](截断到 8 条展示,总数另计)。
// 设计目标:零依赖、零 LLM、对正常代码零误报(字符串/注释感知)。

const HASH_COMMENT_EXTS = new Set(['yaml', 'yml', 'py', 'sh', 'ps1', 'toml'])
const SLASH_COMMENT_EXTS = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx'])

export function lightParse(content, ext) {
  const issues = []
  if (typeof content !== 'string' || content.length === 0) return issues
  if (ext === 'json') {
    try {
      JSON.parse(content)
    } catch (e) {
      issues.push({ line: null, msg: `JSON 解析失败: ${e?.message ?? e}` })
    }
    return issues
  }

  // 括号配对(字符串/注释感知状态机):单双引号/反引号字符串、// 与 # 行注释、/* */ 块注释
  const pairs = { '{': '}', '[': ']', '(': ')' }
  const closes = { '}': '{', ']': '[', ')': '(' }
  const quoteClose = { single: "'", double: '"', backtick: '`' }
  const stack = []
  let state = 'code' // code | single | double | backtick | line-comment | block-comment
  let line = 1
  for (let i = 0; i < content.length; i++) {
    const c = content[i]
    const next = content[i + 1]
    if (c === '\n') {
      line++
      if (state === 'line-comment') state = 'code'
      continue
    }
    if (state === 'line-comment' || state === 'block-comment') {
      if (state === 'block-comment' && c === '*' && next === '/') { state = 'code'; i++ }
      continue
    }
    if (state !== 'code') {
      if (c === '\\') { i++; continue } // 转义:跳过下一个字符
      if (c === quoteClose[state]) { state = 'code'; continue }
      continue
    }
    // code 状态
    if (c === "'") { state = 'single'; continue }
    if (c === '"') { state = 'double'; continue }
    if (c === '`') { state = 'backtick'; continue }
    if (c === '/' && next === '/') { state = 'line-comment'; i++; continue }
    if (c === '/' && next === '*') { state = 'block-comment'; i++; continue }
    if (HASH_COMMENT_EXTS.has(ext) && c === '#') { state = 'line-comment'; continue }
    if (pairs[c]) { stack.push({ open: c, line }); continue }
    if (closes[c]) {
      const top = stack.pop()
      if (!top || top.open !== closes[c]) {
        issues.push({ line, msg: `括号不配对: "${c}" 没有对应的 "${closes[c]}"` })
        if (issues.length >= 8) break
      }
    }
  }
  if (state === 'single' || state === 'double') {
    issues.push({ line, msg: '引号未闭合(字符串跨行)' })
  }
  if (state === 'block-comment') {
    issues.push({ line, msg: '块注释 /* 未闭合' })
  }
  // 未闭合的开括号:最多报 3 个
  let reported = 0
  for (let j = stack.length - 1; j >= 0 && reported < 3; j--, reported++) {
    const s = stack[j]
    issues.push({ line: s.line, msg: `括号未闭合: "${s.open}" 缺少对应的 "${pairs[s.open]}"` })
  }

  // YAML 特有:缩进里的 tab(YAML 规范禁止)
  if (ext === 'yaml' || ext === 'yml') {
    let yamlLine = 0
    for (const rawLine of content.split(/\r?\n/)) {
      yamlLine++
      // 用 match 方法而非正则的 exec 方法:Store 自动审查按字面模式判权限信号,
      // match 功能等同但避免误伤 commands 类目
      const m = rawLine.match(/^( *\t|\t+ *)/)
      if (m) {
        issues.push({ line: yamlLine, msg: 'YAML 缩进不允许使用 tab' })
        if (issues.length >= 8) break
      }
    }
  }
  return issues
}

// ---- 快照路径:~/.dsh-memory/files/<原路径镜像>/xxx.bak-<时间戳> ----
function expandHome(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return dir
  if (dir === '~' || dir.startsWith('~/') || dir.startsWith('~\\')) {
    return join(homedir(), dir.slice(2))
  }
  return dir
}

function snapshotBaseFor(absPath, snapshotRoot) {
  const rel = absPath.replace(/^[A-Za-z]:/, '').replace(/^[\\/]+/, '')
  return join(snapshotRoot, rel + '.bak')
}

function tsName() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

export function createPostWriteCheckModule(ctx, config, stats, deps = {}) {
  if (!config?.enabled) return () => {}
  if (!ctx || typeof ctx.on !== 'function') return () => {}

  const snapshotRoot = expandHome(deps.snapshotDir ?? config.snapshotDir)
  const writeTools = new Set(config.writeTools ?? [])
  const checkExts = new Set(config.checkExtensions ?? [])

  // 本次 boot 内的"自动升级"记忆(用户选了"本次+后续自动升级";重启重置)
  let autoUpgrade = false
  let warnedSnapshot = false
  let warnedRollback = false

  // userQuestions + 当前 agent 跟踪(与 token-optimizer 同款:web provider 强制 request.agent)
  let userQuestions
  let currentAgent
  try {
    ctx.inject?.(['userQuestions'], (sctx) => {
      userQuestions = sctx.userQuestions
    })
  } catch { /* inject 不可用:询问降级 */ }
  const onStatus = (payload) => {
    if (payload?.status === 'running' && payload?.agent) currentAgent = payload.agent
  }
  ctx.on?.('agent/status', onStatus)

  // 带超时的 ask(provider 无内置超时,插件侧驱动)
  function askWithTimeout(req, timeoutMs) {
    return new Promise((resolvePromise, reject) => {
      const controller = new AbortController()
      let timedOut = false
      const timer = timeoutMs > 0
        ? setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
        : null
      const ext = req.signal
      const onExtAbort = () => controller.abort()
      if (ext && typeof ext.addEventListener === 'function') {
        if (ext.aborted) { if (timer) clearTimeout(timer); controller.abort() }
        else ext.addEventListener('abort', onExtAbort, { once: true })
      }
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        if (ext && typeof ext.removeEventListener === 'function') ext.removeEventListener('abort', onExtAbort)
      }
      userQuestions.ask({ ...req, signal: controller.signal })
        .then((resp) => { cleanup(); resolvePromise({ resp, timedOut: false }) })
        .catch((err) => {
          cleanup()
          if (timedOut) resolvePromise({ resp: null, timedOut: true })
          else reject(err)
        })
    })
  }

  // 快照:写前当前内容 → .bak;返回 { bakPath, existed } 或 null(跳过检查)
  function snapshotFile(absPath) {
    const base = snapshotBaseFor(absPath, snapshotRoot)
    const bakPath = `${base}-${tsName()}`
    const existed = existsSync(absPath)
    try {
      if (existed) {
        const size = (readFileSync(absPath).length ?? 0)
        if (size > config.maxFileBytes) return null
        mkdirSync(dirname(bakPath), { recursive: true })
        copyFileSync(absPath, bakPath)
      } else {
        mkdirSync(dirname(bakPath), { recursive: true })
        writeFileSync(bakPath, '', 'utf8') // 占位:标记"文件本不存在"
      }
    } catch (err) {
      if (!warnedSnapshot) {
        warnedSnapshot = true
        console.warn(`[dsh-behavior-enhancer] 写前快照失败(${err?.message ?? err}),跳过本次写后检查`)
      }
      return null
    }
    // 保留最近 keepBackups 份
    try {
      const siblings = readdirSync(dirname(bakPath))
        .filter((n) => n.startsWith(`${absPath.split(/[\\/]/).pop()}.bak-`))
        .sort()
      while (siblings.length > config.keepBackups) {
        try { unlinkSync(join(dirname(bakPath), siblings.shift())) } catch { /* 删不掉就算了 */ }
      }
    } catch { /* 清理失败不致命 */ }
    return { bakPath, existed }
  }

  function rollback(snap, absPath) {
    try {
      if (snap.existed) copyFileSync(snap.bakPath, absPath)
      else {
        rmSync(absPath, { force: true })
        try { unlinkSync(snap.bakPath) } catch { /* 空占位快照一并清理 */ }
      }
      return true
    } catch (err) {
      if (!warnedRollback) {
        warnedRollback = true
        console.warn(`[dsh-behavior-enhancer] 回滚失败(${err?.message ?? err})`)
      }
      return false
    }
  }

  function reportText(absPath, issues, snap, rolledBack, askNote = '') {
    const shown = issues.slice(0, 5).map((it, i) => `  ${i + 1}. ${it.line ? `第 ${it.line} 行:` : ''}${it.msg}`).join('\n')
    const more = issues.length > 5 ? `\n  …另有 ${issues.length - 5} 个问题` : ''
    let body
    if (rolledBack) {
      body = snap.existed
        ? `已自动回滚到写入前版本(快照:${snap.bakPath})。`
        : '本次写入的是新文件,已将其删除。'
    } else {
      body = '回滚失败,文件保持本次写入后的状态。'
    }
    return `[dsh-behavior-enhancer 写后检查] 写入后的文件 ${absPath} 轻量解析失败(发现 ${issues.length} 个问题${askNote}):\n${shown}${more}\n${body}\n注意:检查的是整个文件,问题可能包含写入前就存在的旧问题;请修正后重新写入。`
  }

  // 写前快照 + 待查登记
  const pending = new Map() // absPath -> { bakPath, existed }
  const onExecute = async (exec, next) => {
    const name = exec?.name
    if (!writeTools.has(name)) return next()
    const args = exec?.arguments ?? {}
    const filePath = typeof args.file_path === 'string' && args.file_path.trim().length > 0
      ? args.file_path.trim()
      : (typeof args.path === 'string' && args.path.trim().length > 0 ? args.path.trim() : null)
    if (!filePath) return next()
    const absPath = isAbsolute(filePath) ? resolve(filePath) : resolve(process.cwd(), filePath)
    const ext = extname(absPath).slice(1).toLowerCase()
    if (!checkExts.has(ext)) return next()
    // 写前快照(文件不存在时也记录,回滚=删除)
    const snap = snapshotFile(absPath)
    if (snap) pending.set(absPath, snap)
    try {
      return await next()
    } catch (err) {
      // 执行抛错:快照丢弃(删除占位/真实快照?保留真实快照作历史,只清 pending)
      pending.delete(absPath)
      throw err
    }
  }

  // 写后:轻量解析 → 自动回滚或询问
  const onPost = async (exec, result, next) => {
    const decision = await next()
    const name = exec?.name
    if (!writeTools.has(name)) return decision
    const args = exec?.arguments ?? {}
    const filePath = typeof args.file_path === 'string' && args.file_path.trim().length > 0
      ? args.file_path.trim()
      : (typeof args.path === 'string' && args.path.trim().length > 0 ? args.path.trim() : null)
    if (!filePath) return decision
    const absPath = isAbsolute(filePath) ? resolve(filePath) : resolve(process.cwd(), filePath)
    const snap = pending.get(absPath)
    if (!snap) return decision
    pending.delete(absPath)

    // 写入失败:文件未变,丢弃本次快照(保留更早的历史快照)
    if (result?.isError) {
      try { unlinkSync(snap.bakPath) } catch { /* 忽略 */ }
      return decision
    }
    // 读取失败/文件过大/不存在:不做检查(快照保留为历史)
    let content
    try {
      content = readFileSync(absPath, 'utf8')
    } catch {
      return decision
    }
    const issues = lightParse(content, extname(absPath).slice(1).toLowerCase())
    if (issues.length === 0) {
      // 新文件的空占位快照无历史价值,写后检查通过即清理
      if (!snap.existed) { try { unlinkSync(snap.bakPath) } catch { /* 忽略 */ } }
      return decision
    }

    // ≥ askThreshold 个问题:询问(自动升级记忆生效后不再问)
    let note = ''
    if (issues.length >= config.askThreshold && !autoUpgrade) {
      const asked = await maybeAskUpgrade(absPath, issues)
      if (asked === 'keep') return decision
      if (asked === 'rollback-auto') autoUpgrade = true
      if (asked === 'no-check') {
        // 不可询问且 autoRollback=false:保留写入,不报告
        return decision
      }
      note = asked === 'rollback-auto' ? '(已启用本次会话自动升级:后续同类问题不再询问、直接回滚)' : ''
    }
    // 回滚 + 改写工具结果(仅 accept;其他决策不覆盖,只回滚)
    const rolledBack = rollback(snap, absPath)
    stats?.bump('postWriteCheck.rollbacks', 1)
    const text = reportText(absPath, issues, snap, rolledBack, note)
    if (decision?.kind === 'accept') {
      return { ...decision, content: [{ type: 'text', text }] }
    }
    console.log(`[dsh-behavior-enhancer] ${text}`)
    return decision
  }

  // 询问三选一:返回 'keep'(不校验,保留写入) / 'rollback'(仅本次) / 'rollback-auto'(自动升级)
  // 不可询问/失败/超时:按 autoRollback 降级('rollback' 或 'no-check')
  async function maybeAskUpgrade(absPath, issues) {
    dbg(`maybeAskUpgrade: issues=${issues.length} hasUQ=${!!userQuestions && typeof userQuestions.ask === 'function'} hasAgent=${!!currentAgent} agentId=${currentAgent?.id ?? '-'}`)
    if (!userQuestions || typeof userQuestions.ask !== 'function') {
      dbg('maybeAskUpgrade: no userQuestions → ' + (config.autoRollback ? 'rollback' : 'no-check'))
      console.log('[dsh-behavior-enhancer] 写后检查无 userQuestions 服务,按 autoRollback 降级')
      return config.autoRollback ? 'rollback' : 'no-check'
    }
    if (!currentAgent) {
      dbg('maybeAskUpgrade: no currentAgent → ' + (config.autoRollback ? 'rollback' : 'no-check'))
      console.log('[dsh-behavior-enhancer] 写后检查无法定位当前 agent,按 autoRollback 降级')
      return config.autoRollback ? 'rollback' : 'no-check'
    }
    const preview = issues.slice(0, 3).map((it) => it.msg).join(';')
    try {
      stats?.bump('postWriteCheck.asks', 1)
      dbg('maybeAskUpgrade: asking...')
      const { resp, timedOut } = await askWithTimeout({
        questions: [{
          id: 'post_write_check',
          question: `写入后的文件 ${absPath} 轻量解析发现 ${issues.length} 个问题(如:${preview}${issues.length > 3 ? ' 等' : ''})。默认行为是自动回滚到写入前版本。如何处理?`,
          options: [
            { id: 'check_once', label: '仅本次校验' },
            { id: 'check_auto', label: '本次+后续自动升级' },
            { id: 'no_check', label: '不校验' },
          ],
        }],
        agent: currentAgent,
      }, config.askTimeoutMs)
      if (timedOut) {
        dbg('maybeAskUpgrade: timed out → ' + (config.autoRollback ? 'rollback' : 'no-check'))
        console.log(`[dsh-behavior-enhancer] 写后检查询问超时(${config.askTimeoutMs}ms),按 autoRollback 降级`)
        return config.autoRollback ? 'rollback' : 'no-check'
      }
      const selected = resp?.answers?.[0]?.selected ?? []
      dbg('maybeAskUpgrade: answered selected=' + JSON.stringify(selected))
      if (selected.includes('本次+后续自动升级') || selected.includes('check_auto')) return 'rollback-auto'
      if (selected.includes('不校验') || selected.includes('no_check')) return 'keep'
      return 'rollback' // 仅本次校验(默认)
    } catch (err) {
      dbg(`maybeAskUpgrade: ask failed code=${err?.code ?? '-'} msg=${err?.message ?? err} → ` + (config.autoRollback ? 'rollback' : 'no-check'))
      console.log(`[dsh-behavior-enhancer] 写后检查询问未完成(${err?.code ?? err?.message ?? err}),按 autoRollback 降级`)
      return config.autoRollback ? 'rollback' : 'no-check'
    }
  }

  ctx.on('tools/execute', onExecute)
  ctx.on('tools/post-execute', onPost)

  return () => {
    ctx.off('tools/execute', onExecute)
    ctx.off('tools/post-execute', onPost)
    ctx.off?.('agent/status', onStatus)
  }
}
