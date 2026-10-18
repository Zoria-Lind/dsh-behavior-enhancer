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
      if (!form || !snapshot) {
        return el('div', { style: css.wrap },
          el('div', { style: css.title }, '项目记忆'),
          el('div', { style: css.hint }, '设置服务未就绪(不影响插件其它功能)'))
      }
      const section = (snapshot.value && snapshot.value.disciplineInject) || {}
      const hours = Number.isFinite(section.everyHours) ? section.everyHours : 3
      const writable = snapshot.writable === true
      const [draft, setDraft] = React.useState(hours)
      const [msg, setMsg] = React.useState('')
      React.useEffect(() => { setDraft(hours) }, [hours])

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
        const n = Number(draft)
        const safe = Number.isFinite(n) && n >= 0 ? Math.round(n) : 0
        setDraft(safe)
        if (safe !== hours) write(['disciplineInject', 'everyHours'], safe)
      }

      return el('div', { style: css.wrap },
        el('div', { style: css.title }, '项目记忆'),
        el('div', { style: css.row },
          el('span', { style: css.label }, '每'),
          el('input', {
            type: 'number',
            min: 0,
            step: 1,
            value: draft,
            disabled: !writable,
            style: { ...css.num, opacity: writable ? 1 : 0.6 },
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
      // 官方页面用法:whileServed 负责订阅命名空间,并把挂载限制在"被服务期间"
      try {
        if (ctx.configForms && typeof ctx.configForms.whileServed === 'function') {
          ctx.configForms.whileServed([ENTRY_ID], register)
          return
        }
      } catch { /* 退回直接注册 */ }
      ctx.slots.inject('settings.general.item', register)
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
