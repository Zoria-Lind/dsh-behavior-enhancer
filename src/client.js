// 客户端入口(web/桌面 UI):挂在宿主 window.__ModuleLoader__ 上,由 DSH 客户端加载。
// 形态照搬 deepseek-harness-background 的约定:
//   window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
//   exports.inject = [客户端服务名...];exports.apply = (ctx) => {...}
// React 由宿主提供(require('react')),本文件不打包、不构建。
//
// 数据通道:ctx.configForms.get(<profile 条目 id>) —— 快照 { status, value, base, user, revision, writable };
// 写入用 mutate([{ op:'set', path:[...], value }])(set(field) 只支持顶层字段,我们是嵌套配置)。
// 服务端必须导出带 .volatile() 的 Config(见 src/configSchema.js),否则写会被 isVolatilePath 拒绝。

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

    const styles = {
      wrap: { padding: '10px 0', fontSize: '13px', lineHeight: 1.7 },
      title: { fontWeight: 600, marginBottom: '4px' },
      hint: { opacity: 0.65, fontSize: '12px' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' },
      num: { width: '64px', padding: '2px 6px' },
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
        return el('div', { style: styles.wrap },
          el('div', { style: styles.title }, '项目记忆'),
          el('div', { style: styles.hint }, '设置服务未就绪(本插件的 Config 需由宿主 settings 服务投影;未投影时不影响插件其它功能)'))
      }
      const section = (snapshot.value && snapshot.value.disciplineInject) || {}
      const enabled = section.enabled !== false
      const hours = Number.isFinite(section.everyHours) ? section.everyHours : 3
      const writable = snapshot.writable === true
      const [draft, setDraft] = React.useState(hours)
      React.useEffect(() => { setDraft(hours) }, [hours])

      const write = (path, value) => {
        if (!form) return
        try {
          const p = form.mutate([{ op: 'set', path, value }])
          if (p && typeof p.catch === 'function') p.catch(() => {})
        } catch { /* 写失败保持原值,mirror 会回读 */ }
      }
      const commitHours = () => {
        const n = Number(draft)
        const safe = Number.isFinite(n) && n >= 0 ? n : 0
        setDraft(safe)
        if (safe !== hours) write(['disciplineInject', 'everyHours'], safe)
      }

      return el('div', { style: styles.wrap },
        el('div', { style: styles.title }, '项目记忆'),
        el('label', { style: styles.row },
          el('input', {
            type: 'checkbox',
            checked: enabled,
            disabled: !writable,
            onChange: (e) => write(['disciplineInject', 'enabled'], e.target.checked),
          }),
          '项目纪律周期重述(压缩后必补一次;内容变化立即重述)'),
        el('label', { style: styles.row },
          '每',
          el('input', {
            type: 'number',
            min: 0,
            step: 1,
            value: draft,
            disabled: !writable || !enabled,
            style: styles.num,
            onChange: (e) => setDraft(e.target.value),
            onBlur: commitHours,
            onKeyDown: (e) => { if (e.key === 'Enter') commitHours() },
          }),
          '小时重述一次(0 = 关闭)'),
        el('div', { style: styles.hint },
          writable ? '修改会写回当前 profile 配置' : '当前配置不可写(由 profile 覆盖层决定)'))
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
