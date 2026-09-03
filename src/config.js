// 配置默认值与校验。与 token-optimizer 同款 resolveSection 模式。

export const DEFAULT_CONFIG = {
  // 系统提示词行为约束段:经 ctx.inject(['systemPrompt']) 注册静态 section
  // (静态文本 = 前缀缓存友好;软约束,强制靠 parallelConvergence)
  behaviorPrompt: {
    enabled: true,
    order: -98,              // identity(-100) / source(-99) 之后,persona(0) 之前
    text: `## 工具调用行为纪律(本会话,来自 dsh-behavior-enhancer)
- 先读后写:修改任何文件前先 read 确认当前内容,禁止盲写。
- 批量操作前先验证:对多个目标做同类操作时,先对其中一个试做并确认结果,再批量执行。
- 失败立即收敛:任何工具调用失败后,停下分析原因,不要基于错误前提继续发起新调用;用更小的单步重试。
- 同类修改串行:对同一文件/同一资源的修改按顺序进行,不要并行发出相互冲突的修改。
- 证据与诚实:回答用户前核实证据;引用文件路径前先确认文件存在;不确定就明说不知道,禁止编造或臆想。
- 上下文已压缩时:若历史被压缩为摘要(compacted-summary),对细节有疑问先查日志或重新获取,不要臆造。`,
  },
  // 并行收敛:工具失败 → 池上限压 1;连续 N 次成功恢复;上下文压力 → 降档
  parallelConvergence: {
    enabled: true,
    recoveryThreshold: 3,        // 连续成功次数达到后恢复原并行度
    complexRatio: 0.6,           // 上下文压力比(idle 时测量),超阈值降档
    minParallel: 1,              // 压力降档目标
    defaultParallel: 10,         // 读不到当前值时的 fallback(核心默认 10)
    contextWindowFallback: 1000000,
    stderrAsFailure: true,       // 命令级失败识别(pwsh 非零退出/stderr 错误签名也算失败)
  },
  // 连续失败计数:同工具连续失败 maxFailures 次 → 提示模型向用户确认
  failureGuard: {
    enabled: true,
    maxFailures: 2,
    stderrAsFailure: true,       // 同上:命令级失败也计入连续失败
    followupMessage: '[dsh-behavior-enhancer] 工具 {tool} 已连续失败 {count} 次。请停止重试,向用户说明失败原因并询问下一步(或切换方案)。',
    blockFeedback: false,        // 可选:错误结果以 block+feedback 拦截(模型看不到错误正文,慎用)
    feedbackText: '该工具调用失败。请先分析失败原因并修正调用参数后再重试,不要原样重复。',
  },
}

const NUMERIC_KEYS = new Set([
  'order', 'recoveryThreshold', 'complexRatio', 'minParallel', 'defaultParallel',
  'contextWindowFallback', 'maxFailures',
])
const STRING_KEYS = new Set(['text', 'followupMessage', 'feedbackText'])

function assertNumber(name, value, { min = 0, max = Infinity } = {}) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`dsh-behavior-enhancer config: ${name} (${value}) must be a number in [${min}, ${max}]`)
  }
}

function resolveSection(section, defaults) {
  const out = { ...defaults }
  if (section && typeof section === 'object') {
    for (const [key, value] of Object.entries(section)) {
      if (!(key in defaults)) {
        throw new Error(`dsh-behavior-enhancer config: unknown key "${key}" (allowed: ${Object.keys(defaults).join(', ')})`)
      }
      if (NUMERIC_KEYS.has(key)) {
        if (key === 'complexRatio') assertNumber(key, value, { min: 0, max: 1 })
        else assertNumber(key, value)
      } else if (STRING_KEYS.has(key)) {
        if (typeof value !== 'string') throw new Error(`dsh-behavior-enhancer config: "${key}" must be a string`)
      } else if (typeof value !== typeof defaults[key]) {
        throw new Error(`dsh-behavior-enhancer config: "${key}" must be ${typeof defaults[key]}`)
      }
      out[key] = value
    }
  }
  return Object.freeze(out)
}

export function resolveConfig(config = {}) {
  if (typeof config !== 'object' || config === null) config = {}
  return Object.freeze({
    behaviorPrompt: resolveSection(config.behaviorPrompt, DEFAULT_CONFIG.behaviorPrompt),
    parallelConvergence: resolveSection(config.parallelConvergence, DEFAULT_CONFIG.parallelConvergence),
    failureGuard: resolveSection(config.failureGuard, DEFAULT_CONFIG.failureGuard),
  })
}
