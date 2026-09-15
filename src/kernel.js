// 内核模块解析(不声明为 inject 依赖,运行时经 createRequire 借道)。
// 照抄仓库既有先例 dsh-token-optimizer/src/modules/toolTrim.js:42-58 的多锚点:
// 插件自身位置(link 挂载时走不到 profile 依赖桥)→ DSH_ROOT →
// DSH_HOME/.dsh 的 profiles/node_modules(CLI 安装器生成的符号链接桥)→ 全局 npm 目录。
// 全部失败返回 undefined,调用方降级禁用对应通道,绝不抛错。
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { homedir } from 'node:os'

export function resolveKernelModule(name) {
  const anchors = []
  anchors.push(import.meta.url) // 插件自身位置
  if (process.env.DSH_ROOT) anchors.push(join(process.env.DSH_ROOT, 'package.json'))
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  anchors.push(join(dshHome, 'profiles', 'node_modules', 'noop.js'))
  if (process.env.APPDATA) anchors.push(join(process.env.APPDATA, 'npm', 'node_modules', 'noop.js'))
  for (const anchor of anchors) {
    try {
      const req = createRequire(anchor)
      req.resolve(name)
      return req(name)
    } catch { /* 下一锚点 */ }
  }
  return undefined
}
