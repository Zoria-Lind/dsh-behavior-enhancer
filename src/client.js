// 客户端入口(web/桌面 UI):挂在宿主 window.__ModuleLoader__ 上,由 DSH 客户端加载。
// 形态照搬 deepseek-harness-background 的约定:
//   window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
//   exports.inject = [客户端服务名...];exports.apply = (ctx) => {...}
// React 由宿主提供(require('react')),本文件不打包、不构建。
//
// 数据通道:ctx.configForms.get(<profile 条目 id>) —— 快照 { status, value, base, user, revision, writable };
// 写入用 mutate([{ op:'set', path:[...], value }])(set(field) 只支持顶层字段,我们是嵌套配置)。
// 服务端必须导出带 .volatile() 的 Config(见 src/configSchema.js),否则写会被 isVolatilePath 拒绝。
//
// 样式:只用宿主主题 token(--dsw-alias-*),不写死颜色;开关用宿主规范 role="switch" + aria-checked,
// 轨道/滑块分别取 brand-primary 与 --dsw-alias-switch-thumb(宿主自己的开关就是这么配的)。

window.__ModuleLoader__.load({
  id: '@zoria-lind/dsh-behavior-enhancer',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    let React = null
    try { React = require('react') } catch { /* 宿主没给 react 时不渲染 */ }

    const inject = ['slots', 'configForms']

    // profile 里的条目 id(cordis.patch.yml 的 `- id: behavior-enhancer`);包名作备选命名空间
    const ENTRY_ID = 'behavior-enhancer'
    const NS_CANDIDATES = [ENTRY_ID, '@zoria-lind/dsh-behavior-enhancer']
    const ROW_ID = 'behavior-enhancer.project-memory'

    let clientCtx = null
    let form = null
    let formKey = ''

    function attachForm() {
      if (!clientCtx || !clientCtx.configForms || typeof clientCtx.configForms.get !== 'function') return
      if (form && typeof form.getSnapshot === 'function' && form.getSnapshot()?.status === 'ready') return
      for (const key of NS_CANDIDATES) {
        try {
          const f = clientCtx.configForms.get(key)
          if (!f) continue
          const snap = typeof f.getSnapshot === 'function' ? f.getSnapshot() : null
          if (!form) { form = f; formKey = key }
          if (snap && snap.status === 'ready') { form = f; formKey = key; return }
        } catch { /* 试下一个 */ }
      }
    }

    // 宿主已服务的命名空间目录(诊断用):不 stringify(代理对象的 toJSON 需要额外注入)
    function servedNamespaces() {
      try {
        if (!clientCtx || !clientCtx.configForms || typeof clientCtx.configForms.describe !== 'function') return 'no-describe'
        const d = clientCtx.configForms.describe()
        if (Array.isArray(d)) {
          return d.map((x) => (x && typeof x === 'object' ? (x.ns ?? x.namespace ?? '?') : String(x))).join(',') || 'empty'
        }
        if (d && typeof d === 'object') {
          const keys = Object.keys(d).join('|')
          const arr = Array.isArray(d.namespaces)
            ? d.namespaces.map((x) => (x && typeof x === 'object' ? (x.ns ?? x.namespace ?? '?') : String(x))).join(',')
            : ''
          return 'keys=' + keys + (arr ? ' ns=' + arr : '')
        }
        return String(d)
      } catch (e) { return 'describe-error:' + (e && e.message ? e.message : e) }
    }

    const css = {
      wrap: { padding: '12px 0', lineHeight: 1.6 },
      title: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: '6px' },
      hint: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', marginTop: '6px' },
      row: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '8px' },
      label: { color: 'var(--dsw-alias-label-secondary)' },
      switch: {
        position: 'relative', flex: 'none', width: '36px', height: '20px', padding: 0,
        border: 'none', borderRadius: '10px', cursor: 'pointer', transition: 'background 120ms',
      },
      thumb: {
        position: 'absolute', top: '2px', width: '16px', height: '16px', borderRadius: '8px',
        background: 'var(--dsw-alias-switch-thumb)', transition: 'left 120ms',
        boxShadow: '0 1px 2px rgba(0,0,0,.18)',
      },
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
      const enabled = section.enabled !== false
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
      const commitHours = () => {
        const n = Number(draft)
        const safe = Number.isFinite(n) && n >= 0 ? n : 0
        setDraft(safe)
        if (safe !== hours) write(['disciplineInject', 'everyHours'], safe)
      }

      return el('div', { style: css.wrap },
        el('div', { style: css.title }, '项目记忆'),
        el('div', { style: css.row },
          el('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': enabled,
            'aria-label': '项目纪律周期重述',
            disabled: !writable,
            onClick: () => { if (writable) write(['disciplineInject', 'enabled'], !enabled) },
            style: {
              ...css.switch,
              background: enabled ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
              cursor: writable ? 'pointer' : 'default',
              opacity: writable ? 1 : 0.6,
            },
          },
          el('span', { style: {
            ...css.thumb,
            left: enabled ? '18px' : '2px',
            // 开:深色钮(亮轨深钮,与宿主一致);关:switch-thumb(亮色纯白/暗色 neutral-bluish 400)
            background: enabled ? 'var(--dsw-alias-label-primary-inverted)' : 'var(--dsw-alias-switch-thumb)',
          } })),
          el('span', { style: css.label }, '项目纪律周期重述(压缩后必补一次;内容变化立即重述)')),
        el('div', { style: css.row },
          el('span', { style: css.label }, '每'),
          el('input', {
            type: 'number',
            min: 0,
            step: 1,
            value: draft,
            disabled: !writable || !enabled,
            style: { ...css.num, opacity: writable && enabled ? 1 : 0.6 },
            onChange: (e) => setDraft(e.target.value),
            onBlur: commitHours,
            onKeyDown: (e) => { if (e.key === 'Enter') commitHours() },
          }),
          el('span', { style: css.unit }, '小时重述一次(0 = 关闭)')),
        el('div', { style: css.hint },
          'ns=' + (formKey || '-') + ' · status=' + (snapshot.status || '-') + ' · writable=' + String(writable) +
          (msg ? ' · ' + msg : '')),
        el('div', { style: css.hint }, 'served=' + servedNamespaces()))
    }

    function apply(ctx) {
      clientCtx = ctx
      attachForm()
      if (!ctx || !ctx.slots || typeof ctx.slots.register !== 'function') return
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: ROW_ID,
        order: 700,
      }, ProjectMemoryRow))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
