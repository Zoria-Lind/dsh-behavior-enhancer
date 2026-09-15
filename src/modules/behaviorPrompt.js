// 系统提示词行为约束段(behaviorPrompt,B2 重构):经 ctx.inject(['systemPrompt'])
// 注册静态 section,order 由内核常量推导(落在 HARNESS_IDENTITY 与 DEPLOYMENT_PERSONA_PREFIX 之间)。
//
// 关键设计:
//   - ctx.inject 是 cordis 可选服务访问的正道(服务未挂载时回调不运行,
//     不会炸插件树;服务晚激活也没问题,回调在服务可用时执行)
//   - 文本必须静态(禁止时间戳/动态值),否则每请求前缀都变,杀掉 DeepSeek
//     前缀缓存(实测正常会话命中率 99.75%)
//   - 这是软约束;强制收敛由 parallelConvergence / hardGate 负责
//
// B2 变更:
//   - 纪律条目配置化:disciplinePreset 切预设 / disciplineIncludeTags 按标签筛选 /
//     disciplineMaxBytes 字节预算(截断必留显式告警,语义对齐 dsh-agent-instructions)
//   - config.text 保留为逃生舱:显式自定义文本时原样注册(旧配置行为不变,可回滚)
//   - order 不再死写注释:内核可解析时取 HARNESS_IDENTITY(-1000)与
//     DEPLOYMENT_PERSONA_PREFIX(0)的中点;否则回退 config.order(-98,同区间,注释此前失真已修正)
//   - persona complete 风险检测:内核 assembly 的 complete 段会成为唯一 section
//     (dsh-system-prompt/lib/index.js:352-356)并整段吞掉纪律段——complete 标志无公开
//     API 可读,退而求其次:在 system-prompt/assemble waterfall 里检测到 persona 段
//     (deployment:persona-prefix)时告警一次,提示用户检查 persona 配置
//   - 段名固定 'behavior-discipline',避开 dsh-better-edit 占用的 tool:read/edit/undo_last_edit

import { resolveKernelModule } from '../kernel.js'
import { resolvePreset } from '../discipline/presets.js'
import { DEFAULT_CONFIG } from '../config.js'

const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix' // 内核导出常量(稳态名,离线取不到时用此回退)

// 字节预算内的整条截断:丢弃放不下的条目(整条,不截半句),末尾留显式告警
function renderDiscipline(entries, maxBytes) {
  const header = '## 工具调用行为纪律(本会话,来自 dsh-behavior-enhancer)'
  const lines = entries.map((e) => `- ${e.text}`)
  let truncated = false
  const kept = []
  for (const line of lines) {
    const candidate = [header, ...kept, line].join('\n')
    if (Buffer.byteLength(candidate, 'utf8') > maxBytes) {
      truncated = true
      continue
    }
    kept.push(line)
  }
  let text = [header, ...kept].join('\n')
  if (truncated) {
    const note = '\n(纪律条目超出字节预算已被截断,请收紧 disciplinePreset/IncludeTags 或调大 disciplineMaxBytes)'
    if (Buffer.byteLength(text + note, 'utf8') <= maxBytes + Buffer.byteLength(note, 'utf8')) text += note
    else text = text.slice(0, Math.max(0, maxBytes - 24)) + '\n(已截断:超出字节预算)'
  }
  return { text, truncated }
}

export function createBehaviorPromptModule(ctx, config, stats, deps = {}) {
  if (!config?.enabled) return () => {}
  if (!ctx || typeof ctx.inject !== 'function') {
    console.warn('[dsh-behavior-enhancer] ctx.inject 不可用,行为约束段未注册')
    return () => {}
  }

  // ---- 渲染纪律文本(escape hatch:显式自定义 text 时原样使用) ----
  let renderedText = config.text
  if (config.text === DEFAULT_CONFIG.behaviorPrompt.text) {
    const preset = resolvePreset(config.disciplinePreset)
    let entries
    if (preset === null) {
      console.warn(`[dsh-behavior-enhancer] 未知 disciplinePreset "${config.disciplinePreset}",回退 default`)
      entries = resolvePreset('default')
    } else {
      entries = preset
    }
    const tags = Array.isArray(config.disciplineIncludeTags) ? config.disciplineIncludeTags : []
    if (tags.length > 0) entries = entries.filter((e) => (e.tags ?? []).some((t) => tags.includes(t)))
    renderedText = renderDiscipline(entries, config.disciplineMaxBytes).text
  }

  // ---- order:内核可解析时取两锚点中点;否则回退 config.order(-98) ----
  const kernelSP = deps.systemPromptModule ?? resolveKernelModule('@deepseek-ai/dsh-system-prompt')
  function resolveOrder() {
    if (config.order !== DEFAULT_CONFIG.behaviorPrompt.order) return config.order // 用户显式指定 → 尊重
    const identity = kernelSP?.getSectionOrder?.('HARNESS_IDENTITY')
    const persona = kernelSP?.getSectionOrder?.('DEPLOYMENT_PERSONA_PREFIX')
    if (Number.isFinite(identity) && Number.isFinite(persona)) {
      return Math.floor((identity + persona) / 2) // (-1000+0)/2 = -500:仍在 identity 与 persona 之间
    }
    return config.order // 内核不可解析:回退 -98
  }
  const order = resolveOrder()

  const disposers = []
  let applied = false
  let warned = false

  try {
    ctx.inject(['systemPrompt'], (sctx) => {
      try {
        const sp = sctx.systemPrompt
        if (!sp || typeof sp.section !== 'function') {
          if (!warned) {
            warned = true
            console.warn('[dsh-behavior-enhancer] systemPrompt 服务无 section 方法,行为约束段未注册')
          }
          return
        }
        const disposer = sp.section({ name: 'behavior-discipline', order, text: renderedText })
        if (typeof disposer === 'function') disposers.push(disposer)
        if (!applied) {
          applied = true
          stats?.bump('behavior.promptApplied', 1)
          console.log(`[dsh-behavior-enhancer] 行为约束段已注册(order ${order},约 ${Buffer.byteLength(renderedText, 'utf8')} 字节)`)
        }
      } catch (err) {
        if (!warned) {
          warned = true
          console.warn(`[dsh-behavior-enhancer] 行为约束段注册失败:${err?.message ?? err}`)
        }
      }
    })
  } catch {
    // inject 抛出:降级,不注册
  }

  // persona complete 风险探测(complete 标志无公开 API,只能按 persona 段出现做启发式告警)
  let personaWarned = false
  const onAssemble = async (assembly, _context, next) => {
    try {
      if (!personaWarned && Array.isArray(assembly?.sections)
        && assembly.sections.some((s) => s?.name === PERSONA_PREFIX_SECTION)) {
        personaWarned = true
        stats?.bump('behavior.personaDetected', 1)
        console.warn('[dsh-behavior-enhancer] 检测到 deployment:persona-prefix 段:若该段配置了 complete:true,内核 assembly 会把它设为唯一 section(dsh-system-prompt lib/index.js:352-356),本插件纪律段会被静默吞掉;纪律不生效时请先检查 persona 配置')
      }
    } catch { /* 探测失败不影响装配 */ }
    return next() // waterfall:必须透传,不得改写装配结果
  }
  try {
    ctx.on?.('system-prompt/assemble', onAssemble)
  } catch { /* 事件不可用:跳过探测 */ }

  return () => {
    for (const disposer of disposers) {
      try { disposer() } catch { /* 忽略 */ }
    }
    disposers.length = 0
    try { ctx.off?.('system-prompt/assemble', onAssemble) } catch { /* noop */ }
  }
}
