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
//   4. postWriteCheck     写后检查(v1.1):write/edit 后轻量语法解析,失败自动
//      .bak 回滚并报告;≥3 个问题弹窗三选一(仅本次/自动升级/不校验)
//   5. projectMemory      项目记忆写后校验(v1.3):AGENTS.md/CLAUDE.md 等写入后查重复行/
//      体量/超长行/本机路径泄漏/异常缩水;只提示、绝不回滚(注入归内核 agent-instructions)
//
// 与核心的关系:核心已保证写操作 exclusive(edit/write/pwsh 串行)、
// read/read_image 并行安全;本插件只动池上限,不碰工具定义。

import { DEFAULT_CONFIG, resolveConfig } from './config.js'
import { createBehaviorPromptModule } from './modules/behaviorPrompt.js'
import { createParallelConvergenceModule } from './modules/parallelConvergence.js'
import { createFailureGuardModule } from './modules/failureGuard.js'
import { createPostWriteCheckModule } from './modules/postWriteCheck.js'
import { createProjectMemoryModule } from './modules/projectMemory.js'
import { createDisciplineInjectModule } from './modules/disciplineInject.js'
import { createWriteDiffVerifyModule } from './modules/writeDiffVerify.js'
import { createHardGateModule } from './modules/hardGate.js'
import { createVerifyLoopModule } from './modules/verifyLoop.js'
import { createComplianceModule } from './modules/compliance.js'
import { createStats } from './stats.js'

export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  const stats = createStats()

  const modules = []
  if (resolved.behaviorPrompt.enabled) modules.push(createBehaviorPromptModule(ctx, resolved.behaviorPrompt, stats))
  if (resolved.parallelConvergence.enabled) modules.push(createParallelConvergenceModule(ctx, resolved.parallelConvergence, stats))
  if (resolved.failureGuard.enabled) modules.push(createFailureGuardModule(ctx, resolved.failureGuard, stats))
  if (resolved.disciplineInject.enabled) modules.push(createDisciplineInjectModule(ctx, resolved.disciplineInject, stats))
  // projectMemory 必须先于 postWriteCheck 注册:先注册者更外层,而 postWriteCheck 报错时
  // 会整体替换 decision.content;放外层才能"await next() 后追加",两份报告都不被吞。
  if (resolved.projectMemory.enabled) modules.push(createProjectMemoryModule(ctx, resolved.projectMemory, stats))
  if (resolved.postWriteCheck.enabled) modules.push(createPostWriteCheckModule(ctx, resolved.postWriteCheck, stats))
  // hardGate 必须先于 writeDiffVerify 注册(pre-execute 默认注册序:先注册者更外层):
  // 高风险命令在 hardGate 处即被 deny,不再付 writeDiffVerify 的 git 快照成本
  if (resolved.hardGate.enabled) modules.push(createHardGateModule(ctx, resolved.hardGate, stats))
  if (resolved.writeDiffVerify.enabled) modules.push(createWriteDiffVerifyModule(ctx, resolved.writeDiffVerify, stats))
  if (resolved.verifyLoop.enabled) modules.push(createVerifyLoopModule(ctx, resolved.verifyLoop, stats))
  if (resolved.compliance.enabled) modules.push(createComplianceModule(ctx, resolved.compliance, stats))
  return () => {
    for (const cleanup of modules) cleanup()
    stats.dispose()
  }
}

export { DEFAULT_CONFIG, resolveConfig }
