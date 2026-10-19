// dsh-behavior-enhancer v1.3(B10):/pm 命令 —— 项目记忆设置的可靠控制通道。
//
// 为什么需要它:客户端设置表单依赖"命名空间被客户端镜像订阅",实测在桌面端一直
// status=unavailable(写入被宿主拒绝);而**服务端** settings 服务本身有
// describe / update / replace / mutate,直接调用即可落盘到 profile 配置,
// 完全绕开客户端订阅。设置面板仍保留为显示用途。
//
// 用法:/pm 3h | /pm off | /pm status

const PATH = ['disciplineInject', 'everyHours']

export function createSettingsCommandModule(ctx, config, stats, deps = {}) {
  // 常驻注册:即使配置里关着也要能用 `/pm 3h` 把它打开(否则关掉就再无命令行入口)。
  if (!ctx || typeof ctx.inject !== 'function') return () => {}

  const entryId = (() => {
    try { return ctx?.fiber?.entry?.options?.id ?? 'behavior-enhancer' } catch { return 'behavior-enhancer' }
  })()
  let settings = null
  const disposers = []

  function readHours() {
    try {
      if (!settings || typeof settings.describe !== 'function') return null
      const hit = settings.describe().find((d) => d && d.ns === entryId)
      const value = hit && hit.value && hit.value.disciplineInject
      return Number.isFinite(value?.everyHours) ? value.everyHours : null
    } catch { return null }
  }

  async function writeHours(hours) {
    const ops = [{ op: 'set', path: PATH, value: hours }]
    if (settings && typeof settings.mutate === 'function') {
      const ok = await settings.mutate(entryId, ops)
      return ok !== false
    }
    if (settings && typeof settings.update === 'function') {
      await settings.update(entryId, { disciplineInject: { everyHours: hours } })
      return true
    }
    throw new Error('当前 settings 服务没有 mutate/update,无法写入')
  }

  const parse = (raw) => {
    const text = String(raw ?? '').trim().toLowerCase()
    if (!text || text === 'status') return { kind: 'status' }
    if (text === 'off' || text === '0' || text === '0h') return { kind: 'set', hours: 0 }
    const m = text.match(/^(\d+(?:\.\d+)?)\s*h?$/)
    if (m) return { kind: 'set', hours: Number(m[1]) }
    return { kind: 'bad' }
  }

  ctx.inject(['commands', 'settings'], (cctx) => {
    settings = cctx?.settings ?? null
    try {
      const off = cctx.commands.register({
        name: 'pm',
        description: '项目记忆:查看或设置「每 N 小时重述一次」的间隔(/pm 3h、/pm off、/pm status)',
        handler: async (invocation) => {
          const raw = invocation?.args ?? invocation?.rawInput ?? ''
          const cmd = parse(raw)
          if (cmd.kind === 'bad') {
            return { kind: 'error', text: '用法:/pm 3h(每 3 小时)| /pm off(关闭)| /pm status(查看)' }
          }
          if (cmd.kind === 'status') {
            const now = readHours()
            return { kind: 'success', text: now === null ? '读不到当前值(settings 服务不可用)' : (now > 0 ? `当前:每 ${now} 小时重述一次` : '当前:已关闭') }
          }
          try {
            const ok = await writeHours(cmd.hours)
            if (!ok) return { kind: 'error', text: '写入被宿主拒绝(settings.mutate 返回 false)' }
            stats?.bump('discipline.commandSet', 1)
            return { kind: 'success', text: cmd.hours > 0 ? `已设置为每 ${cmd.hours} 小时重述一次` : '已关闭纪律周期重述' }
          } catch (err) {
            return { kind: 'error', text: `写入失败:${err?.message ?? err}` }
          }
        },
      })
      if (typeof off === 'function') disposers.push(off)
    } catch (err) {
      console.warn(`[dsh-behavior-enhancer] /pm 注册失败(${err?.message ?? err})`)
    }
  })

  return () => {
    for (const off of disposers) { try { off?.() } catch { /* noop */ } }
  }
}
