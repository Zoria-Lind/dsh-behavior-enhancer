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
  // 写后检查(v1.1):write/edit 类工具写入后轻量语法解析(JSON/YAML + 括号配对),
  // 失败自动从 .bak 快照回滚并报告;≥ askThreshold 个问题弹窗三选一。
  // 文件快照存 snapshotDir(独立于记忆池,为"找回文件正确版本"铺路)。
  postWriteCheck: {
    enabled: true,
    writeTools: ['write', 'edit'],
    checkExtensions: ['json', 'yaml', 'yml', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'ps1', 'sh', 'toml', 'xml'],
    maxFileBytes: 500000,        // 超过该大小的文件跳过检查(也跳过快照)
    keepBackups: 5,              // 每文件保留的 .bak 快照份数
    askThreshold: 3,             // 轻量解析发现 ≥3 个问题才弹窗询问(1~2 个自动回滚)
    askTimeoutMs: 120000,        // 询问超时,超时按 autoRollback 降级
    snapshotDir: '~/.dsh-memory/files',
    autoRollback: true,          // 询问不可用/超时时:true=自动回滚(fail-safe),false=保留写入
  },
  // ===== memory-bridge 联动占位(dsh-memory-bridge 阶段 3b 完成后开开关即可) =====
  memory_bridge: {
    enabled: false,
    sync_on_check: true,
    rollback_from_memory: true,
    post_write_check: true,
  },
}

const NUMERIC_KEYS = new Set([
  'order', 'recoveryThreshold', 'complexRatio', 'minParallel', 'defaultParallel',
  'contextWindowFallback', 'maxFailures',
  'maxFileBytes', 'keepBackups', 'askThreshold', 'askTimeoutMs',
])
const STRING_KEYS = new Set(['text', 'followupMessage', 'feedbackText', 'snapshotDir'])
const STRING_ARRAY_KEYS = new Set(['writeTools', 'checkExtensions'])

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
      } else if (STRING_ARRAY_KEYS.has(key)) {
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
          throw new Error(`dsh-behavior-enhancer config: "${key}" must be an array of strings`)
        }
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
    postWriteCheck: resolveSection(config.postWriteCheck, DEFAULT_CONFIG.postWriteCheck),
    // 占位节:enabled=false 时无模块消费,仅保证配置合法(阶段 3b 后开开关)
    memory_bridge: resolveSection(config.memory_bridge, DEFAULT_CONFIG.memory_bridge),
  })
}
