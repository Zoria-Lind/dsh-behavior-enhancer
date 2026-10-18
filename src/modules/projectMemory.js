// dsh-behavior-enhancer v1.3(B8)项目记忆写后校验(建议性,绝不回滚)。
// 职责边界:
//   内核 @deepseek-ai/dsh-agent-instructions 负责**注入**(AGENTS.md / CLAUDE.md 及 .local 叠加层);
//   dsh-ecolink 负责跨项目/用户级记忆池;
//   本模块只做一件事——模型写完记忆文件后检查内容,把问题追回到该次工具结果。
// 不写盘、不注入、不新增存储、永不回滚(回滚一份回忆录的代价远大于它的问题)。
// 与 postWriteCheck 同一套路径规矩:相对路径只按会话 cwd 解析,绝不回落到 process.cwd()。

import { readFileSync, statSync } from 'node:fs'
import { homedir as osHomedir, userInfo as osUserInfo } from 'node:os'
import { basename, isAbsolute, resolve } from 'node:path'

export const MEMORY_FILE_NAMES = Object.freeze(['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'])

const MAX_TRACKED = 256 // 长会话不无限增长

function num(value, fallback) {
  return Number.isFinite(value) ? value : fallback
}
function safeHome() {
  try { return osHomedir() } catch { return '' }
}
function safeUser() {
  try { return osUserInfo().username ?? '' } catch { return '' }
}
function namesOf(config) {
  const list = Array.isArray(config?.fileNames) && config.fileNames.length ? config.fileNames : MEMORY_FILE_NAMES
  return new Set(list.map((name) => String(name).toLowerCase()))
}

// 只按 basename 匹配(Windows 大小写不敏感);两侧都小写。
export function isMemoryFilePath(filePath, config = {}) {
  if (typeof filePath !== 'string' || !filePath) return false
  return namesOf(config).has(basename(filePath).toLowerCase())
}

// 纯内容检查,不碰文件系统。previousSize 为写入前字节数(未知时传 null)。
export function checkMemoryContent(content, options = {}) {
  const text = typeof content === 'string' ? content : ''
  const maxBytes = num(options.maxBytes, 65536)
  const maxLineLength = num(options.maxLineLength, 200)
  const duplicateMinLength = num(options.duplicateMinLength, 8)
  const shrinkRatio = num(options.shrinkRatio, 0.3)
  const shrinkMinBytes = num(options.shrinkMinBytes, 2048)
  const previousSize = Number.isFinite(options.previousSize) ? options.previousSize : null
  const home = typeof options.homedir === 'string' ? options.homedir : safeHome()
  const username = typeof options.username === 'string' ? options.username : safeUser()
  const sizeBytes = Buffer.byteLength(text, 'utf8')
  const lines = text.split(/\r?\n/)
  const issues = []

  // 1) 缩水:同进程内写过的大文件被大幅重写
  if (previousSize !== null && previousSize >= shrinkMinBytes && sizeBytes < previousSize * shrinkRatio) {
    issues.push({
      kind: 'shrink',
      line: null,
      msg: `文件从 ${previousSize} B 缩到 ${sizeBytes} B(不足原来的 ${Math.round(shrinkRatio * 100)}%),确认是有意重写而不是被覆盖`,
    })
  }

  // 2) 体量:对齐内核 maxBytes(内核按整批渲染计,这里按单文件计)
  if (sizeBytes > maxBytes) {
    issues.push({
      kind: 'size',
      line: null,
      msg: `文件 ${sizeBytes} B 超过 ${maxBytes} B;内核 agent-instructions 的 maxBytes 对整个渲染批次生效,单文件也吃这份预算`,
    })
  }

  // 3) 重复行(忽略行尾空白;短行如表格分隔线不计)
  const firstSeen = new Map()
  const dups = []
  lines.forEach((raw, index) => {
    const norm = raw.trimEnd()
    if (!norm.trim() || norm.trim().length < duplicateMinLength) return
    const first = firstSeen.get(norm)
    if (first === undefined) { firstSeen.set(norm, index + 1); return }
    dups.push({ line: index + 1, first })
  })
  if (dups.length) {
    const shown = dups.slice(0, 3).map((d) => `第 ${d.line} 行(首见第 ${d.first} 行)`).join('、')
    issues.push({ kind: 'duplicate', line: dups[0].line, msg: `${dups.length} 行重复:${shown}` })
  }

  // 4) 超长行
  const longs = []
  lines.forEach((line, index) => {
    if (line.length > maxLineLength) longs.push({ line: index + 1, len: line.length })
  })
  if (longs.length) {
    const shown = longs.slice(0, 3).map((l) => `第 ${l.line} 行 ${l.len} 字符`).join('、')
    issues.push({ kind: 'long-line', line: longs[0].line, msg: `${longs.length} 行超过 ${maxLineLength} 字符:${shown}` })
  }

  // 5) 本机路径/身份泄漏(项目记忆常进 git,先确认)
  if (options.checkPathLeak !== false) {
    const homeLower = home.toLowerCase()
    const userOk = username.length >= 3
    const userLower = username.toLowerCase()
    const leaks = []
    lines.forEach((line, index) => {
      const low = line.toLowerCase()
      const why = []
      if (homeLower && low.includes(homeLower)) why.push('主目录')
      else if (userOk && low.includes(userLower)) why.push('用户名')
      // 盘符绝对路径:要求前面是行首/空白/引号/括号等,排除 https:// 这类
      if (/[A-Za-z]:[\\/](?![\\/])/.test(line) && /(?:^|[\s("'`（【:：=])[A-Za-z]:[\\/]/.test(line)) why.push('盘符绝对路径')
      if (/\\\\[A-Za-z0-9._-]+\\/.test(line)) why.push('UNC 路径')
      if (/\/(?:Users|home)\/[^\s"'`]+/.test(line)) why.push('POSIX 主目录')
      if (!why.length) return
      leaks.push({ line: index + 1, why: [...new Set(why)].join('/'), snippet: line.trim().slice(0, 60) })
    })
    if (leaks.length) {
      const shown = leaks.slice(0, 3).map((x) => `第 ${x.line} 行(${x.why}):${x.snippet}`).join(';')
      issues.push({ kind: 'leak', line: leaks[0].line, msg: `${leaks.length} 行含本机路径/用户名,要进 git 的话先确认:${shown}` })
    }
  }

  return { sizeBytes, issues }
}

export function formatMemoryReport(absPath, issues, sizeBytes) {
  const shown = issues.slice(0, 6).map((it, index) => `  ${index + 1}. ${it.line ? `第 ${it.line} 行:` : ''}${it.msg}`).join('\n')
  const more = issues.length > 6 ? `\n  …另有 ${issues.length - 6} 项` : ''
  return `[dsh-behavior-enhancer 项目记忆检查] ${absPath}(${sizeBytes} B)发现 ${issues.length} 项,均为建议、文件未改动:\n${shown}${more}\n提示:项目级事实写 AGENTS.md、仅本机相关写 AGENTS.local.md,一行一条;拿不准就不记。`
}

export function createProjectMemoryModule(ctx, config, stats, deps = {}) {
  if (!config?.enabled) return () => {}
  if (!ctx || typeof ctx.on !== 'function') return () => {}

  const writeTools = new Set(
    Array.isArray(config.writeTools) && config.writeTools.length ? config.writeTools : ['write', 'edit'],
  )
  const names = namesOf(config)
  const home = typeof deps.homedir === 'string' ? deps.homedir : safeHome()
  const username = typeof deps.username === 'string' ? deps.username : safeUser()
  const pending = new Map()   // key -> { prevSize }
  const lastSizes = new Map() // key -> 上次写后字节数
  const keyOf = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
  let warnedNoCwd = false

  function remember(map, key, value) {
    map.set(key, value)
    if (map.size > MAX_TRACKED) {
      const oldest = map.keys().next().value
      map.delete(oldest)
    }
  }

  // 命中记忆文件才返回绝对路径;写工具/路径/扩展名任一项不满足返回 null。
  function targetOf(exec) {
    if (!exec || !writeTools.has(exec.name)) return null
    const args = exec.arguments ?? {}
    const filePath = typeof args.file_path === 'string' && args.file_path.trim()
      ? args.file_path.trim()
      : (typeof args.path === 'string' && args.path.trim() ? args.path.trim() : null)
    if (!filePath) return null
    let absPath
    if (isAbsolute(filePath)) {
      absPath = resolve(filePath)
    } else {
      const cwd = exec?.agent?.session?.header?.cwd
      if (typeof cwd !== 'string' || !cwd) {
        if (!warnedNoCwd) {
          warnedNoCwd = true
          console.warn(`[dsh-behavior-enhancer] 项目记忆检查:相对路径 "${filePath}" 且无法确定会话 cwd,跳过(仅提示一次)`)
        }
        return null
      }
      absPath = resolve(cwd, filePath)
    }
    if (!names.has(basename(absPath).toLowerCase())) return null
    return absPath
  }

  // 写前:记录写入前的字节数(文件不存在则沿用本进程上次写后的大小)
  const onExecute = async (exec, next) => {
    const absPath = targetOf(exec)
    if (!absPath) return next()
    const key = keyOf(absPath)
    let prevSize = lastSizes.get(key) ?? null
    try { prevSize = statSync(absPath).size } catch { /* 新文件 */ }
    remember(pending, key, { prevSize })
    try {
      return await next()
    } catch (err) {
      pending.delete(key)
      throw err
    }
  }

  // 写后:先跑内层链路,再读最终落盘内容做建议性检查(绝不回滚)
  const onPost = async (exec, result, next) => {
    const decision = await next()
    const absPath = targetOf(exec)
    if (!absPath) return decision
    const key = keyOf(absPath)
    const entry = pending.get(key)
    pending.delete(key)
    if (result?.isError) return decision
    let content
    try { content = readFileSync(absPath, 'utf8') } catch { return decision }
    const previousSize = entry?.prevSize ?? lastSizes.get(key) ?? null
    const { sizeBytes, issues } = checkMemoryContent(content, { ...config, previousSize, homedir: home, username })
    remember(lastSizes, key, sizeBytes)
    stats?.bump('projectMemory.checked', 1)
    if (issues.length === 0) return decision
    stats?.bump('projectMemory.reports', 1)
    stats?.bump('projectMemory.issues', issues.length)
    const text = formatMemoryReport(absPath, issues, sizeBytes)
    if (decision?.kind === 'accept') {
      const existing = Array.isArray(decision.content) ? decision.content : []
      return { ...decision, content: [...existing, { type: 'text', text }] }
    }
    console.log(`[dsh-behavior-enhancer] ${text}`)
    return decision
  }

  const offs = []
  offs.push(ctx.on('tools/execute', onExecute))
  offs.push(ctx.on('tools/post-execute', onPost))
  return () => {
    for (const off of offs) { try { off?.() } catch { /* noop */ } }
    try { ctx.off?.('tools/execute', onExecute) } catch { /* noop */ }
    try { ctx.off?.('tools/post-execute', onPost) } catch { /* noop */ }
    pending.clear()
    lastSizes.clear()
  }
}
