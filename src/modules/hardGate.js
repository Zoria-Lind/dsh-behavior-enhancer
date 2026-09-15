// dsh-behavior-enhancer v1.2(B3):高风险命令闸门(软实现)。
// 定位(30 B3 / 07 §H):pre-execute 不是真硬闸门——外层 listener 的 allow 可以抹掉
// 内层 deny;真硬闸门必须落 ctx.tools.guard()(只有 deny、无逃生、不可撤销)。
// "高风险命令"需要逃生(模型/用户确认后要能放行),所以放软闸门 + 计数降级;
// guard 一期不注册(留给"任何情况下都不许发生"类约束)。
// 逃生语义(内核 deny 单调不可逆 → 降级只能发生在自己 handler 内):
//   同一原因连续拦截超过 maxStrikes 次 → 第 N+1 次起放行并计 escape,防空转死锁。
// mode='ask'(默认):返回合法 ask 决策;无审批服务时内核把 ask 降级为 deny(07 §A),
// 不会卡住。铁律:任何分支显式 return decision(漏 return → 内核读 decision.kind TypeError)。

const FORBIDDEN = [
  { re: /\bRemove-Item\b[^\n]*-(Recurse|Force)/i, label: 'Remove-Item -Recurse/-Force' },
  { re: /\bformat\b\s+[a-z]:/i, label: 'format 盘符' },
  { re: /\bdel\b[^\n]*\/[fsq]/i, label: 'del /f /s /q' },
  { re: /\brm\b\s+-[rf]{1,2}\b/i, label: 'rm -r/-f/-rf' },
  { re: /\bri\b[^\n]*-Recurse/i, label: 'ri -Recurse' },
]

export function createHardGateModule(ctx, config, stats) {
  if (!config?.enabled) return () => {}
  if (!ctx || typeof ctx.on !== 'function') return () => {}

  const strikes = new Map() // reason -> 已拦截次数
  const limit = Number.isFinite(config.maxStrikes) ? config.maxStrikes : 3 // 兜底:否则 n>undefined 恒 false → 永久 deny 自锁

  const handler = async (exec, next) => {
    if (exec?.name !== 'pwsh') return next()
    const command = String(exec?.arguments?.command ?? '')
    const hit = FORBIDDEN.find((f) => f.re.test(command))
    if (!hit) return next()
    const reason = 'high-risk-command'
    const n = (strikes.get(reason) ?? 0) + 1
    strikes.set(reason, n)
    if (n > limit) {
      stats?.bump('hardGate.escape', 1)
      return next() // 逃生:超过阈值放行,不再 deny
    }
    stats?.bump('hardGate.denied', 1)
    if (config.highRiskMode === 'ask') {
      return { kind: 'ask', reason: `高风险命令已拦截(${hit.label},第 ${n} 次)。请确认后重试;连续超过 ${limit} 次将自动放行。` }
    }
    return { kind: 'deny', reason: `高风险命令已拦截(${hit.label},第 ${n} 次)。请先用更小粒度的单步验证;连续超过 ${limit} 次将自动放行以防空转。` }
  }

  const off = ctx.on('tools/pre-execute', handler)
  return () => {
    try { off?.() } catch { /* noop */ }
  }
}
