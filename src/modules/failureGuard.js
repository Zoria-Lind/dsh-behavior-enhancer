// 连续失败守护(failureGuard):按工具名统计连续失败,达到阈值后经
// agent.followup 向模型注入提示(goal-round-driver 同款软通道,模型会
// 在下轮开始时看到,引导它向用户确认而不是继续重试)。
//
// 与 token-optimizer 的边界:错误内容的瘦身(摘要)是 token-optimizer
// outputLadder 的活;本模块只做失败后的"策略响应",不碰内容。
//
// 可选 blockFeedback(默认关):错误结果以 {kind:'block', feedback} 拦截,
// 模型看不到错误正文——风险是模型不知道失败细节而盲目重试,慎用。

import { detectFailure } from './failureDetect.js'
import { resolveKernelModule } from '../kernel.js'

export function createFailureGuardModule(ctx, config, stats, deps = {}) {
  if (!config?.enabled) return () => {}
  if (!ctx || typeof ctx.on !== 'function') return () => {}

  const streaks = new Map() // toolName -> 连续失败次数
  let warned = false

  // B1 硬伤修复:followup 必须传 UserMessage。裸字符串在调用点不校验、失败推迟到
  // 消息被 claim/投影时才爆(插件抓不到,P2)。经 createUserMessage 构造——内核先例
  // dsh-command-goal/lib/index.js:99 同款;deps.createUserMessage 供测试注入假实现。
  const createUserMessage = typeof deps.createUserMessage === 'function'
    ? deps.createUserMessage
    : (() => {
      const llm = resolveKernelModule('@deepseek-ai/dsh-llm')
      return llm && typeof llm.createUserMessage === 'function' ? llm.createUserMessage : null
    })()
  let warnedNoLlm = false

  const alert = (agent, name, count) => {
    const text = String(config.followupMessage)
      .replace('{tool}', String(name))
      .replace('{count}', String(count))
    if (!agent || typeof agent.followup !== 'function') {
      if (!warned) {
        warned = true
        console.warn('[dsh-behavior-enhancer] tools/result 拿不到 agent.followup,连续失败提示未送达(模型仍能从错误内容自行感知)')
      }
      return
    }
    if (typeof createUserMessage !== 'function') {
      if (!warnedNoLlm) {
        warnedNoLlm = true
        console.warn('[dsh-behavior-enhancer] 未能解析 @deepseek-ai/dsh-llm,无法构造 UserMessage,连续失败提示未送达')
      }
      return
    }
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'behavior-enhancer', form: 'notice', summary: 'failure-guard' },
      }))
      stats?.bump('behavior.alerts', 1)
    } catch (err) {
      if (!warned) {
        warned = true
        console.warn(`[dsh-behavior-enhancer] agent.followup 失败:${err?.message ?? err}`)
      }
    }
  }

  const onResult = (exec, result) => {
    const name = exec?.name
    if (!name) return
    // B1:显式传选项对象,不把整个 config 当第二参(此前靠解构巧合成立)
    if (!detectFailure(result, { stderrAsFailure: config.stderrAsFailure })) {
      streaks.delete(name)
      return
    }
    const n = (streaks.get(name) ?? 0) + 1
    streaks.set(name, n)
    stats?.bump('behavior.failures', 1)
    if (n >= config.maxFailures) {
      streaks.delete(name) // 提示后重置计数,避免每轮重复提示
      alert(exec?.agent, name, n)
    }
  }

  ctx.on('tools/result', onResult)

  const disposers = []
  if (config.blockFeedback) {
    const onPost = async (_exec, result, next) => {
      const decision = await next()
      if (decision?.kind === 'accept' && detectFailure(result, config)) {
        return { kind: 'block', feedback: config.feedbackText }
      }
      return decision
    }
    ctx.on('tools/post-execute', onPost)
    disposers.push(() => ctx.off('tools/post-execute', onPost))
  }

  return () => {
    ctx.off('tools/result', onResult)
    for (const off of disposers) off()
  }
}
