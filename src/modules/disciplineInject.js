// dsh-behavior-enhancer v1.3(B9):项目纪律周期重述。
// 目的:内核 dsh-agent-instructions 只在首请求注入一条 AGENTS.md 基线消息,`/compact`
// 会把它摘要掉;本模块按"距上次 N 小时 / N 轮"惰性判定,到点从 `## 项目纪律` 节重述一次。
//
// 通道:agent.steer()(不是 followup——followup 会另起一轮,verifyLoop 注释里有实证);
// 动态内容绝不进 systemPrompt section(会杀前缀缓存)。
// 状态落盘:跨进程有效(桌面端重启不会一开机就轰炸);压缩后必补一次(补偿基线被摘要)。
// 触发:到点(everyHours/everyTurns)/ 压缩后 / **纪律内容变化**(刚写完规则立刻生效)。
// 缺节/超限时只 warn + 计数,绝不猜内容。

import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { resolveKernelModule } from '../kernel.js'
import { isVolatileRef } from '../config.js'

const DISCIPLINE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md']

function expandHome(p) {
  if (typeof p !== 'string' || !p) return p
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

// 从 Markdown 里取指定标题下的正文:到下一条同级(或更高级)标题为止。
export function extractSection(text, heading) {
  const lines = String(text ?? '').split(/\r?\n/)
  const target = String(heading ?? '').trim()
  if (!target) return null
  const level = (target.match(/^#+/) ?? ['##'])[0].length
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === target) { start = i + 1; break }
  }
  if (start < 0) return null
  const body = []
  for (let i = start; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s/)
    if (m && m[1].length <= level) break
    body.push(lines[i])
  }
  const sectionText = body.join('\n').trim()
  if (!sectionText) return null
  return { text: sectionText, hash: createHash('sha1').update(sectionText).digest('hex') }
}

// 从会话 cwd 向上找最近的 AGENTS.md / CLAUDE.md(内核也是"项目根到 cwd"的链;
// 周期重述只取最近一份,避免把多份拼起来撑爆预算)。
export function findDisciplineFile(startDir, candidates = DISCIPLINE_CANDIDATES, maxDepth = 8) {
  if (typeof startDir !== 'string' || !startDir) return null
  let dir = resolve(startDir)
  for (let depth = 0; depth < maxDepth; depth++) {
    for (const name of candidates) {
      const p = join(dir, name)
      try { if (statSync(p).isFile()) return p } catch { /* 继续找 */ }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function emptyState() {
  return { lastInjectAt: 0, turnsSinceInject: 0, lastDigestHash: '', compactedSinceLastInject: false, lastFile: '' }
}

function loadState(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return {
      lastInjectAt: Number.isFinite(data?.lastInjectAt) ? data.lastInjectAt : 0,
      turnsSinceInject: Number.isFinite(data?.turnsSinceInject) ? data.turnsSinceInject : 0,
      lastDigestHash: typeof data?.lastDigestHash === 'string' ? data.lastDigestHash : '',
      compactedSinceLastInject: data?.compactedSinceLastInject === true,
      lastFile: typeof data?.lastFile === 'string' ? data.lastFile : '',
    }
  } catch {
    return emptyState()
  }
}

export function createDisciplineInjectModule(ctx, config, stats, deps = {}) {
  // 不在创建期按 enabled 早退:宿主对 volatile 字段的修改是**原地提交、不重启插件**,
  // 若关着启动就直接不注册监听器,用户后来打开也永远不会生效(只能重启)。
  // 启用与否改到每轮判定时读活值。
  if (!ctx || typeof ctx.on !== 'function') return () => {}

  const everyHours = Number.isFinite(config.everyHours) ? config.everyHours : 3
  const everyTurns = Number.isFinite(config.everyTurns) ? config.everyTurns : 0

  // 运行期读活设置:UI(设置面板)改完立即生效,不必重启。
  // 命名空间 = profile 条目 id(0.1.7+ 语义);老版 settings 服务没有 describe 时退回纯配置。
  let liveSettings = null
  const entryId = (() => {
    try { return ctx?.fiber?.entry?.options?.id ?? 'behavior-enhancer' } catch { return 'behavior-enhancer' }
  })()
  try {
    ctx.inject?.(['settings'], (sctx) => {
      liveSettings = sctx?.settings ?? null
      try {
        if (liveSettings && typeof liveSettings.configure === 'function' && typeof ctx.effect === 'function') {
          ctx.effect(() => {
            const dispose = liveSettings.configure({ auto: false }, ctx.fiber)
            return () => { try { dispose?.() } catch { /* noop */ } }
          }, 'dsh-behavior-enhancer: settings presentation')
        }
      } catch { /* 老版服务:_auto 不适用,忽略 */ }
    })
  } catch { /* inject 不可用:退回纯配置 */ }

  // 宿主给的是 volatile 引用({get(), [cosmokit.volatile.write]}):每次读都是当前值,
  // 设置面板 / /pm 的写入改的就是它。这是最直接的活值通道,优先于 settings.describe()。
  const rawSection = deps.raw && typeof deps.raw === 'object' ? deps.raw : null
  const LIVE_KEYS = ['enabled', 'everyHours', 'everyTurns', 'skipUnchanged', 'heading', 'pointer', 'maxDigestBytes', 'compactReinject']

  function refValue(key) {
    const v = rawSection ? rawSection[key] : undefined
    return isVolatileRef(v) ? v.get() : v
  }

  function liveSection() {
    if (rawSection) {
      const out = {}
      let any = false
      for (const key of LIVE_KEYS) {
        const v = refValue(key)
        if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') {
          out[key] = v
          any = true
        }
      }
      if (any) return out
    }
    try {
      if (!liveSettings || typeof liveSettings.describe !== 'function') return null
      const hit = liveSettings.describe().find((d) => d && d.ns === entryId)
      return (hit && hit.value && hit.value.disciplineInject) || null
    } catch { return null }
  }

  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const stateFile = expandHome(deps.stateFile ?? config.stateFile)
  const candidates = Array.isArray(config.candidates) && config.candidates.length ? config.candidates : DISCIPLINE_CANDIDATES
  const state = loadState(stateFile)

  const createUserMessage = typeof deps.createUserMessage === 'function'
    ? deps.createUserMessage
    : (() => {
      const llm = resolveKernelModule('@deepseek-ai/dsh-llm')
      return llm && typeof llm.createUserMessage === 'function' ? llm.createUserMessage : null
    })()
  let warnedNoLlm = false
  let warnedNoAgent = false
  let warnedPersist = false

  function persist() {
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      const tmp = `${stateFile}.tmp-${process.pid}-${Date.now()}`
      try {
        writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
        renameSync(tmp, stateFile)
      } catch (err) {
        try { unlinkSync(tmp) } catch { /* 忽略 */ }
        throw err
      }
    } catch (err) {
      if (!warnedPersist) {
        warnedPersist = true
        console.warn(`[dsh-behavior-enhancer] 纪律重述状态落盘失败(${err?.message ?? err})`)
      }
    }
  }

  // 一次判定结束(无论注入/跳过)都把周期归零:避免"缺节"时每轮都读一遍文件
  function advance() {
    state.lastInjectAt = now()
    state.turnsSinceInject = 0
    persist()
  }

  function compose(file, body, pointerText) {
    const head = `[项目纪律·重述] 以下是本项目的既定纪律(来自 ${basename(file)};上下文压缩后重述,不必回复):`
    const pointer = typeof pointerText === 'string' && pointerText.trim() ? `\n${pointerText.trim()}` : ''
    return `${head}\n${body}${pointer}`
  }

  // serial 事件:必须返回 undefined,否则会短路后续 listener
  const onTurnStopping = (payload) => {
    try {
      const agent = payload?.agent
      if (!agent) return undefined
      // 子 agent 也会跑 agent loop 并派发本事件:它的 cwd/会话与主对话不同,往里 steer
      // 既多付一步、主对话又收不到,还会把全局周期计数提前归零 —— 直接跳过。
      const header = agent?.session?.header
      if (header?.origin === 'subagent' || header?.parentSession !== undefined) return undefined

      const live = liveSection()
      const enabledNow = typeof live?.enabled === 'boolean' ? live.enabled : config.enabled !== false
      if (!enabledNow) return undefined
      state.turnsSinceInject += 1

      const headingNow = typeof live?.heading === 'string' && live.heading.trim() ? live.heading : config.heading
      const maxBytesNow = Number.isFinite(live?.maxDigestBytes) ? live.maxDigestBytes : config.maxDigestBytes

      const cwd = agent?.session?.header?.cwd
      const file = (typeof cwd === 'string' && cwd) ? findDisciplineFile(cwd, candidates) : null
      // 状态文件是全局的:换了项目(找到的 AGENTS.md 不同)就把周期计数与内容 hash 归零,
      // 否则 other 项目的轮次/摘要会串到本项目上(尤其 everyTurns 与 skipUnchanged)。
      if ((file ?? '') !== state.lastFile) {
        state.lastFile = file ?? ''
        state.turnsSinceInject = 1
        state.lastDigestHash = ''
      }
      let section = null
      if (file) {
        try { section = extractSection(readFileSync(file, 'utf8'), headingNow) } catch { section = null }
      }

      const hoursNow = Number.isFinite(live?.everyHours) ? live.everyHours : everyHours
      const turnsNow = Number.isFinite(live?.everyTurns) ? live.everyTurns : everyTurns
      if (hoursNow <= 0 && turnsNow <= 0) { persist(); return undefined } // 两个触发器都关 = 完全静默
      const hoursDue = hoursNow > 0 && now() - state.lastInjectAt >= hoursNow * 3600 * 1000
      const turnsDue = turnsNow > 0 && state.turnsSinceInject >= turnsNow
      const compactDue = config.compactReinject !== false && state.compactedSinceLastInject
      // 纪律刚写/刚改也立刻重述(否则补完规则要干等一个周期;首次 hash 为空时同样命中)
      const changed = !!section && section.hash !== state.lastDigestHash
      if (!hoursDue && !turnsDue && !compactDue && !changed) {
        persist() // 轮次计数也要落盘(否则重启后 everyTurns 会漂)
        return undefined
      }

      if (typeof cwd !== 'string' || !cwd) {
        stats?.bump('discipline.noCwd', 1)
        advance()
        return undefined
      }
      if (!file) {
        stats?.bump('discipline.noFile', 1)
        advance()
        return undefined
      }
      if (!section) {
        stats?.bump('discipline.noSection', 1)
        advance()
        return undefined
      }
      const bytes = Buffer.byteLength(section.text, 'utf8')
      if (bytes > maxBytesNow) {
        stats?.bump('discipline.oversize', 1)
        console.warn(`[dsh-behavior-enhancer] ${basename(file)} 的「${headingNow}」节 ${bytes} B 超过 maxDigestBytes(${maxBytesNow}),本轮不重述;请精简该节`)
        advance()
        return undefined
      }
      const skipUnchangedNow = typeof live?.skipUnchanged === 'boolean' ? live.skipUnchanged : config.skipUnchanged !== false
      if (skipUnchangedNow && !state.compactedSinceLastInject && section.hash === state.lastDigestHash) {
        stats?.bump('discipline.skippedUnchanged', 1)
        advance()
        return undefined
      }

      if (typeof createUserMessage !== 'function') {
        if (!warnedNoLlm) {
          warnedNoLlm = true
          console.warn('[dsh-behavior-enhancer] 未能解析 @deepseek-ai/dsh-llm,无法构造 UserMessage,纪律重述未送达')
        }
        advance()
        return undefined
      }
      if (typeof agent.steer !== 'function') {
        if (!warnedNoAgent) {
          warnedNoAgent = true
          console.warn('[dsh-behavior-enhancer] agent 上拿不到 steer,纪律重述未送达')
        }
        advance()
        return undefined
      }

      agent.steer(createUserMessage({
        content: [{ type: 'text', text: compose(file, section.text, typeof live?.pointer === 'string' ? live.pointer : config.pointer) }],
        source: { kind: 'plugin:behavior-enhancer', form: 'notice', summary: 'discipline-reinject' },
      }))
      stats?.bump('discipline.injected', 1)
      state.lastDigestHash = section.hash
      state.compactedSinceLastInject = false
      advance()
    } catch (err) {
      console.warn(`[dsh-behavior-enhancer] 纪律重述失败(${err?.message ?? err})`)
    }
    return undefined
  }

  // 压缩后补一次:内核基线是历史消息,压缩会把纪律吃掉。
  // 注意:压缩**不是 cordis 事件**——内核走 `session.append('compaction/end', …)`,
  // 由 `session/event` 派发(event.type 才是 'compaction/end')。监 'compaction/end'
  // 在 0.2.x 上永远不会触发(2026-10-19 复核实证)。旧名字保留一份只为兼容老内核。
  const markCompacted = () => {
    try {
      if (config.compactReinject === false) return
      state.compactedSinceLastInject = true
      persist()
    } catch { /* noop */ }
  }
  const onSessionEvent = (session, event) => {
    if (event?.type !== 'compaction/end') return
    const header = session?.header
    if (header?.origin === 'subagent' || header?.parentSession !== undefined) return
    markCompacted()
  }
  const onCompactionEnd = () => markCompacted()

  const onFlush = async () => { persist() }

  ctx.on('agent/turn-stopping', onTurnStopping)
  ctx.on?.('session/event', onSessionEvent)
  ctx.on('compaction/end', onCompactionEnd)
  ctx.on('session/flush', onFlush)

  return () => {
    try { ctx.off?.('agent/turn-stopping', onTurnStopping) } catch { /* noop */ }
    try { ctx.off?.('session/event', onSessionEvent) } catch { /* noop */ }
    try { ctx.off?.('compaction/end', onCompactionEnd) } catch { /* noop */ }
    try { ctx.off?.('session/flush', onFlush) } catch { /* noop */ }
    persist()
  }
}
