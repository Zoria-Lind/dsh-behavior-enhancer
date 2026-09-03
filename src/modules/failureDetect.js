// 失败检测(共享):工具级 isError 之外的命令级失败识别。
//
// 核心事实:dsh-tool-pwsh 只有基础设施错误(spawn 失败/中止)才标 isError,
// 命令级失败(非零退出/stderr 报错)作为普通成功结果返回——DSH 模型实测:
// `$ErrorActionPreference='Stop'; Get-Item missing` 的结果 isError:false,
// 内容带 "[stderr] ... [exit code: 1]"。
// 本模块按失败签名补识别,供 parallelConvergence/failureGuard 使用。

function extractText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
  }
  return ''
}

export function detectFailure(result, { stderrAsFailure = true } = {}) {
  if (result?.isError === true) return true
  if (!stderrAsFailure) return false
  const text = extractText(result?.content)
  if (!text) return false
  // 非零退出码(命令级失败的最强信号)
  if (/\[exit[^\]]*code[^\]]*[:：]\s*[1-9]/.test(text)) return true
  // stderr 段出现典型错误签名(避开 warning 类噪音)
  if (/\[stderr\][\s\S]{0,200}(error|failed|exception|cannot|can't|not found|no such file|does not exist|access denied|找不到|不存在|拒绝访问|无法)/im.test(text)) return true
  return false
}
