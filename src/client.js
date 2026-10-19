// 客户端入口(web/桌面 UI):挂在宿主 window.__ModuleLoader__ 上,由 DSH 客户端加载。
//   window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
//   exports.inject = [客户端服务名...];exports.apply = (ctx) => {...}
// React 由宿主提供(require('react')),本文件不打包、不构建。
//
// 数据通道(2026-10-18 按宿主官方页面实现纠正):
//   用 ctx.configForms.whileServed([ns], register) **包住** slot 注册 —— 它负责订阅命名空间,
//   命名空间进入共享镜像时才挂载;只调 get(ns) 不订阅会一直 status=unavailable。
//   读写:快照 { status, value, base, user, revision, writable };写 mutate([{op:'set', path, value}]).

window.__ModuleLoader__.load({
  id: '@zoria-lind/dsh-behavior-enhancer',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    let React = null
    try { React = require('react') } catch { /* 宿主没给 react 时不渲染 */ }

    const inject = ['slots', 'configForms']

    // profile 里的条目 id(cordis.patch.yml 的 `- id: behavior-enhancer`)
    const ENTRY_ID = 'behavior-enhancer'
    const ROW_ID = 'behavior-enhancer.project-memory'

    let clientCtx = null
    let form = null

    function attachForm() {
      if (form || !clientCtx || !clientCtx.configForms || typeof clientCtx.configForms.get !== 'function') return
      try { form = clientCtx.configForms.get(ENTRY_ID) } catch { form = null }
    }

    const css = {
      wrap: { padding: '12px 0', lineHeight: 1.6 },
      title: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: '6px' },
      hint: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', marginTop: '6px' },
      row: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '8px' },
      label: { color: 'var(--dsw-alias-label-secondary)' },
      num: {
        width: '64px', padding: '3px 8px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit', textAlign: 'right',
      },
      unit: { color: 'var(--dsw-alias-label-tertiary)' },
    }

    function ProjectMemoryRow() {
      if (!React) return null
      attachForm()
      const el = React.createElement
      const snapshot = React.useSyncExternalStore(
        (listener) => (form ? form.subscribe(listener) : () => {}),
        () => (form ? form.getSnapshot() : null),
        () => (form ? form.getSnapshot() : null),
      )
      // hooks 必须在任何条件 return 之前:form/snapshot 由空变非空时若改变 hooks 数量,
      // React 会抛 "Rendered more hooks than during the previous render"。
      const section = (snapshot && snapshot.value && snapshot.value.disciplineInject) || {}
      const hours = Number.isFinite(section.everyHours) ? section.everyHours : 3
      const writable = !!snapshot && snapshot.writable === true
      const [draft, setDraft] = React.useState(hours)
      const [msg, setMsg] = React.useState('')
      React.useEffect(() => { setDraft(hours) }, [hours])
      if (!form || !snapshot) {
        return el('div', { style: css.wrap },
          el('div', { style: css.title }, '项目纪律重述'),
          el('div', { style: css.hint }, '设置服务未就绪(不影响插件其它功能)'))
      }

      const write = (path, value) => {
        if (!form) { setMsg('form 未绑定'); return }
        try {
          const p = form.mutate([{ op: 'set', path, value }])
          if (p && typeof p.then === 'function') {
            p.then((ok) => setMsg(ok ? '已保存' : '写入被宿主拒绝'), () => setMsg('写入失败'))
          } else setMsg('写入已提交')
        } catch (e) { setMsg('写入异常:' + (e && e.message ? e.message : e)) }
      }
      const commit = () => {
        const raw = String(draft).trim()
        const n = Number(raw)
        // 清空或非法输入**不写 0**:那会静默关掉周期重述。回退到当前值。
        if (raw === '' || !Number.isFinite(n) || n < 0) { setDraft(hours); return }
        const safe = Math.round(n)
        setDraft(safe)
        if (safe !== hours) write(['disciplineInject', 'everyHours'], safe)
      }

      return el('div', { style: css.wrap },
        el('div', { style: css.title }, '项目纪律重述'),
        el('div', { style: css.row },
          el('span', { style: css.label }, '每'),
          el('input', {
            type: 'number',
            min: 0,
            step: 1,
            value: draft,
            disabled: !writable || snapshot.status !== 'ready',
            style: { ...css.num, opacity: writable && snapshot.status === 'ready' ? 1 : 0.6 },
            onChange: (e) => setDraft(e.target.value),
            onBlur: commit,
            onKeyDown: (e) => { if (e.key === 'Enter') commit() },
          }),
          el('span', { style: css.unit }, '小时重述一次(0 = 关闭)')),
        el('div', { style: css.hint },
          hours > 0 ? ('当前:每 ' + hours + ' 小时') : '当前:已关闭'),
        el('div', { style: css.hint },
          'status=' + (snapshot.status || '-') + ' · writable=' + String(writable) + (msg ? ' · ' + msg : '')))
    }

    function apply(ctx) {
      clientCtx = ctx
      attachForm()
      if (!ctx || !ctx.slots || typeof ctx.slots.register !== 'function') return
      const register = () => ctx.slots.register({
        name: 'settings.general.item',
        id: ROW_ID,
        order: 700,
      }, ProjectMemoryRow)
      // 订阅命名空间:whileServed 的回调里不挂载,只用来触发客户端镜像订阅。
      // 它返回 disposer,按契约由调用方持有 —— 放进 ctx.effect,模块重载时自动解绑。
      try {
        if (ctx.configForms && typeof ctx.configForms.whileServed === 'function') {
          const mount = () => {
            const off = ctx.configForms.whileServed([ENTRY_ID], () => () => {})
            return () => { try { off?.() } catch { /* noop */ } }
          }
          if (typeof ctx.effect === 'function') ctx.effect(mount)
          else mount()
        }
      } catch { /* 忽略:订阅失败也要显示行 */ }
      // 无条件挂载:设置服务没就绪时也显示(带诊断),不能因为未订阅而整行消失
      try {
        if (typeof ctx.slots.inject === 'function') ctx.slots.inject('settings.general.item', register)
        else register()
      } catch {
        try { register() } catch { /* noop */ }
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
