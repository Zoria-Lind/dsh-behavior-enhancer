// 客户端入口(web/桌面 UI):挂在宿主 window.__ModuleLoader__ 上,由 DSH 客户端加载。
// 形态照搬 deepseek-harness-background 的约定:
//   window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
//   exports.inject = [客户端服务名...];exports.apply = (ctx) => {...}
// React 由宿主提供(require('react')),本文件不打包、不构建。
//
// 第一步(P3-a):只注册一行只读占位,用来验证"客户端入口 + settings.general.item 槽"这条链;
// 第二步(P3-b)再接 configForms 读写(那一步需要 @deepseek-ai/schemastery 支撑的 Config)。

window.__ModuleLoader__.load({
  id: '@zoria-lind/dsh-behavior-enhancer',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    let React = null
    try { React = require('react') } catch { /* 宿主没给 react 时降级为纯文本 */ }

    const inject = ['slots']

    const ROW_ID = '@zoria-lind/dsh-behavior-enhancer'

    function StatusRow() {
      const text = '项目纪律重述 / 项目记忆校验:已启用(本行是加载探针,设置项开发中)'
      if (!React) return null
      return React.createElement('div', {
        style: { padding: '8px 0', fontSize: '13px', opacity: 0.75, lineHeight: 1.5 },
      }, text)
    }

    function apply(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.register !== 'function') return
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: ROW_ID,
        order: 700,
      }, StatusRow))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
