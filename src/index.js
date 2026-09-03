// dsh-behavior-enhancer: 行为管理插件(v1)
//
// 与 dsh-token-optimizer 的职责边界:
//   - token-optimizer 管"进入模型的内容"(压缩/裁剪/采样/摘要)
//   - 本插件管"模型怎么调用工具"(串行纪律/失败收敛/连续失败介入)
// 两者互不依赖,可独立安装;同时安装时注意错误内容瘦身归 token-optimizer,
// 失败策略归本插件,不重叠。
//
// 真实 DSH API(0.1.1-rc.2 核心源码核实):
//   - ctx.inject(['systemPrompt' | 'settings' | 'tokenMeter'], cb)  可选服务正道
//   - systemPrompt.section({name, order, text})  静态提示词段(前缀缓存友好)
//   - tools/result(exec, result) emit,exec.agent 可用
//   - settings.update('agent-loop', {maxParallelToolCalls}) 运行时改并行池上限(活 getter)
//   - agent.followup(message)  向模型注入下轮提示(goal-round-driver 同款)
//
// 模块清单:
//   1. behaviorPrompt     系统提示词行为约束段(软约束)
//   2. parallelConvergence 失败 → 并行度压 1;连续成功恢复;上下文压力降档
//   3. failureGuard       同工具连续失败 ≥2 → 提示模型向用户确认
//
// 与核心的关系:核心已保证写操作 exclusive(edit/write/pwsh 串行)、
// read/read_image 并行安全;本插件只动池上限,不碰工具定义。

import { DEFAULT_CONFIG, resolveConfig } from './config.js'
import { createBehaviorPromptModule } from './modules/behaviorPrompt.js'
import { createParallelConvergenceModule } from './modules/parallelConvergence.js'
import { createFailureGuardModule } from './modules/failureGuard.js'
import { createStats } from './stats.js'

export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  const stats = createStats()

  const modules = []
  if (resolved.behaviorPrompt.enabled) modules.push(createBehaviorPromptModule(ctx, resolved.behaviorPrompt, stats))
  if (resolved.parallelConvergence.enabled) modules.push(createParallelConvergenceModule(ctx, resolved.parallelConvergence, stats))
  if (resolved.failureGuard.enabled) modules.push(createFailureGuardModule(ctx, resolved.failureGuard, stats))
  return () => {
    for (const cleanup of modules) cleanup()
    stats.dispose()
  }
}

export { DEFAULT_CONFIG, resolveConfig }
