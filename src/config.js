// 配置默认值与校验。与 token-optimizer 同款 resolveSection 模式。

export const DEFAULT_CONFIG = {
  // 系统提示词行为约束段:经 ctx.inject(['systemPrompt']) 注册静态 section
  // (静态文本 = 前缀缓存友好;软约束,强制靠 parallelConvergence / hardGate)
  // B2:discipline* 三键为扁平键(走 resolveSection 浅校验);text 是逃生舱,
  // 显式自定义时原样注册(旧配置行为不变)
  behaviorPrompt: {
    enabled: true,
    order: -98,              // 内核不可解析时的回退值;可解析时取 identity(-1000)与 persona(0)的中点
    text: `## 工具调用行为纪律(本会话,来自 dsh-behavior-enhancer)
- 先读后写:修改任何文件前先 read 确认当前内容,禁止盲写。
- 批量操作前先验证:对多个目标做同类操作时,先对其中一个试做并确认结果,再批量执行。
- 失败立即收敛:任何工具调用失败后,停下分析原因,不要基于错误前提继续发起新调用;用更小的单步重试。
- 同类修改串行:对同一文件/同一资源的修改按顺序进行,不要并行发出相互冲突的修改。
- 证据与诚实:回答用户前核实证据;引用文件路径前先确认文件存在;不确定就明说不知道,禁止编造或臆想。
- 上下文已压缩时:若历史被压缩为摘要(compacted-summary),对细节有疑问先查日志或重新获取,不要臆造。`,
    disciplinePreset: 'default',   // 'default' | 'strict'(B2:预设切换)
    disciplineIncludeTags: [],     // 按条目 tags 筛选(空 = 全部)
    disciplineMaxBytes: 4000,      // 字节预算;超预算整条丢弃并留显式告警
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
  // 项目记忆写后校验(v1.3):模型写入 AGENTS.md/CLAUDE.md/.local 后做建议性检查。
  // 只追加提示文本,绝不回滚、不注入、不新增存储。注入归内核 agent-instructions,
  // 跨项目/用户级记忆池归 dsh-ecolink。
  projectMemory: {
    enabled: true,
    writeTools: ['write', 'edit'],
    fileNames: ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'],
    maxBytes: 65536,             // 对齐内核 maxBytes(按单文件计;内核按整批渲染计)
    maxLineLength: 200,          // 字符数
    duplicateMinLength: 8,       // 短行(表格分隔线等)不计重复
    shrinkRatio: 0.3,            // 写后 < 写前 30% 判定缩水
    shrinkMinBytes: 2048,        // 写前小于该值不判缩水
    checkPathLeak: true,         // 主目录/用户名/盘符绝对路径泄漏
  },
  // 项目纪律周期重述(v1.3):内核只在首请求注入一次 AGENTS.md 基线,压缩会吃掉它;
  // 本模块按"距上次 N 小时 / N 轮"惰性判定,到点用 agent.steer 重述 `## 项目纪律` 节。
  // 动态内容绝不进 systemPrompt section(会杀前缀缓存)。
  disciplineInject: {
    enabled: true,
    heading: '## 项目纪律',       // 只重述这一节;缺节/超限只 warn,不猜内容
    candidates: ['AGENTS.md', 'CLAUDE.md'], // 从会话 cwd 向上找最近一份
    everyHours: 3,              // 0 = 关(只按轮次);两键都 0 = 完全静默
    everyTurns: 0,              // 0 = 关(只按时间)
    maxDigestBytes: 1600,       // 节体超过即不重述并提示精简
    skipUnchanged: true,        // 内容没变且未压缩过 → 跳过,只推进周期
    compactReinject: true,      // 压缩后必补一次(补偿基线被摘要)
    pointer: '',                // 非空:重述末尾追加一行(如进度索引路径)
    stateFile: '~/.dsh/behavior-enhancer/discipline-state.json',
  },
  // B7 变更核验:write 追加 meta.diffs 摘要;pwsh 做前后差集(git status --porcelain),
  // 只报本次新增的变更,删除行标 ⚠。扁平键,全部走 resolveSection 浅校验。
  writeDiffVerify: {
    enabled: true,
    gitStatusOnPwsh: true,       // pwsh 前后差集开关(非 git 目录静默跳过)
    writeDiffTimeoutMs: 5000,    // git 调用超时,绝不阻塞工具链
    writeDiffMaxLines: 400,      // 截断口径与 better-edit 对齐(400 行 / 80KB)
  },
  // B3 高风险命令闸门(软闸门 + 计数逃生;真硬闸门 ctx.tools.guard 一期不注册)
  hardGate: {
    enabled: true,
    maxStrikes: 3,               // 同一原因连续拦截超过该次数 → 自动放行(防空转死锁)
    highRiskMode: 'ask',         // 'ask'(默认,无审批服务时内核降级 deny)| 'deny'
  },
  // B4 强制验证环:改过文件且当轮无验证证据 → steer 注入一次验证要求(单轮 1 次)
  verifyLoop: {
    enabled: true,
  },
  // B5 遵守度统计:session/flush 落盘 + /behavior-status 命令
  compliance: {
    enabled: true,
    statsPath: '~/.dsh/behavior-enhancer/stats.json', // 沿用 ~/.dsh 布局(DSH home);可改 D 盘
  },
  // ===== memory-bridge 联动占位(dsh-memory-bridge 阶段 3b 完成后开开关即可) =====
  memory_bridge: {
    enabled: false,
    sync_on_check: true,
    rollback_from_memory: true,
    post_write_check: true,
  },
}

// 宿主把 Config schema 里 `.volatile()` 标记的字段解析成**引用对象**再传给 apply:
//   Object.freeze({ get: () => current, [Symbol.for('cosmokit.volatile.write')]: (v) => { current = v } })
// 它不是普通值:JSON.stringify 后只剩 `{}`(get 是函数会被省略),typeof 仍是 'object'。
// 必须 .get() 取活值;宿主设置面板的写入(settings.mutate / configForms.mutate)更新的
// 就是同一个引用,所以每轮读取即可看到最新值,不必重启。
export const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

export function isVolatileRef(value) {
  return !!value && typeof value === 'object' && VOLATILE_WRITE in value
}

export function unwrapVolatile(value) {
  return isVolatileRef(value) ? value.get() : value
}

const NUMERIC_KEYS = new Set([
  'order', 'recoveryThreshold', 'complexRatio', 'minParallel', 'defaultParallel',
  'contextWindowFallback', 'maxFailures',
  'maxFileBytes', 'keepBackups', 'askThreshold', 'askTimeoutMs',
  'writeDiffTimeoutMs', 'writeDiffMaxLines', 'disciplineMaxBytes',
  'maxBytes', 'maxLineLength', 'duplicateMinLength', 'shrinkRatio', 'shrinkMinBytes',
  'everyHours', 'everyTurns', 'maxDigestBytes',
])
const STRING_KEYS = new Set(['text', 'followupMessage', 'feedbackText', 'snapshotDir', 'highRiskMode', 'statsPath', 'disciplinePreset', 'heading', 'pointer', 'stateFile'])
const STRING_ARRAY_KEYS = new Set(['writeTools', 'checkExtensions', 'disciplineIncludeTags', 'fileNames', 'candidates'])

function assertNumber(name, value, { min = 0, max = Infinity } = {}) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`dsh-behavior-enhancer config: ${name} (${value}) must be a number in [${min}, ${max}]`)
  }
}

function resolveSection(section, defaults) {
  const out = { ...defaults }
  section = unwrapVolatile(section)
  if (section && typeof section === 'object') {
    for (const [key, rawValue] of Object.entries(section)) {
      if (!(key in defaults)) {
        throw new Error(`dsh-behavior-enhancer config: unknown key "${key}" (allowed: ${Object.keys(defaults).join(', ')})`)
      }
      // 叶子可能是 volatile 引用(.get() 取活值);取出来仍是空对象时按"未设置"处理
      const value = unwrapVolatile(rawValue)
      if (value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === 0 && defaults[key] !== null && typeof defaults[key] !== 'object') {
        continue
      }
      if (NUMERIC_KEYS.has(key)) {
        if (key === 'complexRatio' || key === 'shrinkRatio') assertNumber(key, value, { min: 0, max: 1 })
        else if (key === 'maxBytes' || key === 'maxLineLength') assertNumber(key, value, { min: 1 })
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
    projectMemory: resolveSection(config.projectMemory, DEFAULT_CONFIG.projectMemory),
    disciplineInject: resolveSection(config.disciplineInject, DEFAULT_CONFIG.disciplineInject),
    writeDiffVerify: resolveSection(config.writeDiffVerify, DEFAULT_CONFIG.writeDiffVerify),
    hardGate: resolveSection(config.hardGate, DEFAULT_CONFIG.hardGate),
    verifyLoop: resolveSection(config.verifyLoop, DEFAULT_CONFIG.verifyLoop),
    compliance: resolveSection(config.compliance, DEFAULT_CONFIG.compliance),
    // 占位节:enabled=false 时无模块消费,仅保证配置合法(阶段 3b 后开开关)
    memory_bridge: resolveSection(config.memory_bridge, DEFAULT_CONFIG.memory_bridge),
  })
}
