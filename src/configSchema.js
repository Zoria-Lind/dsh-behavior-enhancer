// 设置面板用的 Config 声明(给宿主 settings 服务投影成表单)。
//
// 关键约束(2026-10-18 实测):
//   - schemastery 对 schema 未声明的键是**保留**的(`{zzz:9}` 原样通过),所以这里只声明
//     要在 UI 里暴露的字段,不会吞掉本插件其它配置节;
//   - 只有 `.volatile()` 标记的字段可写(isVolatilePath 会沿祖先找 volatile)。
//
// 失败安全:@deepseek-ai/schemastery 由宿主提供(peer/依赖都可能缺失,特别是 dev 副本
// 用 link: 安装时 Node 按真实路径解析)。导入失败时 Config 为 undefined ⇒ 宿主视为
// "无 schema" ⇒ 只是没有设置表单,插件其它功能照常,绝不因此加载失败。

let Schema = null
try {
  const mod = await import('@deepseek-ai/schemastery')
  Schema = mod?.default ?? mod
} catch {
  Schema = null
}

function build(S) {
  return S.object({
    disciplineInject: S.object({
      enabled: S.boolean().default(true).volatile(),
      everyHours: S.number().min(0).default(3).volatile(),
      everyTurns: S.number().min(0).default(0).volatile(),
    }),
  })
}

// build 也要在 try/catch 里:依赖版本/副本不匹配时(如没有 .volatile())构造会抛,
// 而这里的 re-export 直接挂在插件入口上 —— 抛了就是整个插件加载失败。
let built = null
try { built = Schema ? build(Schema) : null } catch { built = null }

export const Config = built ?? undefined
