// 系统提示词行为约束段(behaviorPrompt):经 ctx.inject(['systemPrompt'])
// 注册静态 section,order 排在 harness identity/source 之后、persona 之前。
//
// 关键设计:
//   - ctx.inject 是 cordis 可选服务访问的正道(服务未挂载时回调不运行,
//     不会炸插件树;服务晚激活也没问题,回调在服务可用时执行)
//   - 文本必须静态(禁止时间戳/动态值),否则每请求前缀都变,杀掉 DeepSeek
//     前缀缓存(实测正常会话命中率 99.75%)
//   - 这是软约束;强制收敛由 parallelConvergence 模块负责

export function createBehaviorPromptModule(ctx, config, stats) {
  if (!config?.enabled) return () => {}
  if (!ctx || typeof ctx.inject !== 'function') {
    console.warn('[dsh-behavior-enhancer] ctx.inject 不可用,行为约束段未注册')
    return () => {}
  }

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
        const disposer = sp.section({ name: 'behavior-discipline', order: config.order, text: config.text })
        if (typeof disposer === 'function') disposers.push(disposer)
        if (!applied) {
          applied = true
          stats?.bump('behavior.promptApplied', 1)
          console.log(`[dsh-behavior-enhancer] 行为约束段已注册(order ${config.order},约 ${config.text.length} 字符)`)
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

  return () => {
    for (const disposer of disposers) {
      try { disposer() } catch { /* 忽略 */ }
    }
    disposers.length = 0
  }
}
