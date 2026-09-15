// dsh-behavior-enhancer v1.2(B4):强制验证环——"改错了"要在当轮被验证要求兜住。
// 机制(30 B4 / 骨架 §3):
//   - tools/post-execute 记录"本会话写过哪些文件"(按 agent 分桶;subagent 与顶层共用
//     agent 实例作为键,内核 agentEvents() 保证 payload 里有 agent)
//   - agent/turn-stopping(serial)时若 dirty 且无验证证据 → agent.steer(createUserMessage)
//     注入一次验证要求;同族事件里只有 turn-stopping 是 serial——listener 返回任何
//     非 null/false/undefined 的值都会短路后面的 listener → 本 handler 必须返回 undefined
//   - 单轮上限 1 次(nudged WeakSet),防死循环;动态内容走 steer,绝不进 systemPrompt
//     section(P4:动态内容会杀前缀缓存)
//   - 不要用 agent.followup():那会另起一轮,语义完全不同

import { resolveKernelModule } from '../kernel.js'

// 验证命令签名:测试/构建/lint/类型检查,且必须成功退出(exitCode===0)才算证据
const VERIFY_RE = /(npm|pnpm|yarn)\s+(run\s+)?(test|build|lint|typecheck)|node\s+[^\s]*test|--test\b/i

export function createVerifyLoopModule(ctx, config, stats, deps = {}) {
  if (!config?.enabled) return () => {}
  if (!ctx || typeof ctx.on !== 'function') return () => {}

  const createUserMessage = typeof deps.createUserMessage === 'function'
    ? deps.createUserMessage
    : (() => {
      const llm = resolveKernelModule('@deepseek-ai/dsh-llm')
      return llm && typeof llm.createUserMessage === 'function' ? llm.createUserMessage : null
    })()
  if (typeof createUserMessage !== 'function') {
    stats?.bump('verifyLoop.noLlm', 1)
    return () => {}
  }

  const dirty = new Set()
  const nudged = new WeakSet()

  const onPost = async (exec, result, next) => {
    const decision = await next() // post-execute 也是 waterfall:必须 return decision(漏 return → TypeError 被吞成 isError)
    try {
      const agent = exec?.agent
      if (agent && (exec?.name === 'write' || exec?.name === 'edit')) {
        dirty.add(agent)
        nudged.delete(agent) // 新一轮写入重置提醒闸:新 dirty 周期允许再提醒一次
        stats?.bump('verifyLoop.dirty', 1)
      }
      if (agent && exec?.name === 'pwsh'
        && VERIFY_RE.test(String(exec?.arguments?.command ?? ''))
        && result?.value?.exitCode === 0) {
        dirty.delete(agent) // 光有命令文本不算验证,必须成功退出
        stats?.bump('verifyLoop.verified', 1)
      }
    } catch { /* 记录失败不影响决策 */ }
    return decision
  }

  const onTurnStopping = (payload) => {
    // serial:必须返回 undefined;steer 让机器重读 inbox 再走一步(官方先例
    // dsh-agent/lib/types/runtime-types.d.ts:374-399 + 内核 hooks 桥:293-305)
    try {
      const agent = payload?.agent
      if (!agent || !dirty.has(agent) || nudged.has(agent)) return undefined
      nudged.add(agent)
      stats?.bump('verifyLoop.nudged', 1)
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: '你刚改过文件但还没有验证证据:请运行项目自带的测试/构建命令,并贴出结果,再向用户汇报。' }],
        source: { kind: 'plugin', plugin: 'behavior-enhancer', form: 'notice', summary: 'verify-once' },
      }))
    } catch (err) {
      console.warn(`[dsh-behavior-enhancer] verifyLoop steer 失败(${err?.message ?? err})`)
    }
    return undefined
  }

  ctx.on('tools/post-execute', onPost)
  ctx.on('agent/turn-stopping', onTurnStopping)
  return () => {
    dirty.clear()
    try { ctx.off?.('tools/post-execute', onPost) } catch { /* noop */ }
    try { ctx.off?.('agent/turn-stopping', onTurnStopping) } catch { /* noop */ }
  }
}
