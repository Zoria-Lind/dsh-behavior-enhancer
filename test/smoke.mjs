// 单进程 smoke 验证(与 token-optimizer 同款风格)。
// 用法: node test/smoke.mjs

import { writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.js'
import { createStats } from '../src/stats.js'
import { createBehaviorPromptModule } from '../src/modules/behaviorPrompt.js'
import { createParallelConvergenceModule } from '../src/modules/parallelConvergence.js'
import { createFailureGuardModule } from '../src/modules/failureGuard.js'

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.error(`FAIL  ${name}`)
  }
}

function makeFakeCtx(services = {}) {
  const handlers = new Map()
  return {
    on(event, handler) { handlers.set(event, handler) },
    off(event, handler) { if (handlers.get(event) === handler) handlers.delete(event) },
    async emit(event, ...args) {
      const h = handlers.get(event)
      if (!h) throw new Error(`no handler for ${event}`)
      return h(...args)
    },
    inject(keys, cb) {
      const sctx = {}
      for (const k of keys) sctx[k] = services[k]
      cb(sctx)
    },
  }
}

console.log('== config ==')
{
  const cfg = resolveConfig({})
  check('默认 order -98', cfg.behaviorPrompt.order === -98)
  check('默认 recoveryThreshold 3', cfg.parallelConvergence.recoveryThreshold === 3)
  let threw = false
  try { resolveConfig({ behaviorPrompt: { bogus: 1 } }) } catch { threw = true }
  check('未知键报错', threw)
}

console.log('== behaviorPrompt ==')
{
  const sections = []
  const ctx = makeFakeCtx({ systemPrompt: { section: (s) => { sections.push(s); return () => { sections.length = 0 } } } })
  const stats = createStats()
  const cleanup = createBehaviorPromptModule(ctx, resolveConfig({}).behaviorPrompt, stats)
  check('section 已注册', sections.length === 1 && sections[0].name === 'behavior-discipline')
  check('order 为 -98', sections[0].order === -98)
  check('文本为静态配置', sections[0].text.length > 50)
  check('promptApplied 计数', stats.snapshot().counters['behavior.promptApplied'] === 1)
  cleanup()
  check('dispose 后 section 已撤', sections.length === 0)
}

console.log('== parallelConvergence ==')
{
  const tick = () => new Promise((r) => setTimeout(r, 5))
  const tmpState = () => join(tmpdir(), 'beh-state-' + Math.random().toString(36).slice(2) + '.json')
  let current = 10
  const updates = []
  const settings = {
    get: () => ({ maxParallelToolCalls: current }),
    update: async (ns, patch) => { updates.push(patch.maxParallelToolCalls); current = patch.maxParallelToolCalls },
  }
  const ctx = makeFakeCtx({ settings, tokenMeter: { measure: () => ({ totalTokens: 1000 }) } })
  const stats = createStats()
  createParallelConvergenceModule(ctx, resolveConfig({}).parallelConvergence, stats, { stateFile: tmpState() })
  const mkResult = (isError, content) => ({ isError, content })

  // 失败 → 压 1
  await ctx.emit('tools/result', { name: 'grep' }, mkResult(true))
  await tick()
  check('失败压到 1', updates.length === 1 && updates[0] === 1 && current === 1)

  // 失败期间重复失败:不重复 update
  await ctx.emit('tools/result', { name: 'grep' }, mkResult(true))
  await tick()
  check('已串行时重复失败不重复写', updates.length === 1)

  // 连续 3 次成功 → 恢复原值 10
  for (let i = 0; i < 3; i++) await ctx.emit('tools/result', { name: 'grep' }, mkResult(false))
  await tick()
  check('连续 3 次成功恢复原值', updates.length === 2 && updates[1] === 10 && current === 10)

  // 成功后失败 → 再次压 1
  await ctx.emit('tools/result', { name: 'grep' }, mkResult(true))
  await tick()
  check('恢复后再次失败再次压 1', updates.length === 3 && updates[2] === 1)
  // 3 次成功 → 恢复(为 stderr 签名测试腾出状态)
  for (let i = 0; i < 3; i++) await ctx.emit('tools/result', { name: 'grep' }, mkResult(false))
  await tick()
  check('stderr 测试前已恢复', current === 10)

  // 命令级失败签名:isError=false 但带 stderr 错误 + 退出码 → 也压 1
  await ctx.emit('tools/result', { name: 'pwsh' }, mkResult(false, [{ type: 'text', text: '[stderr] Get-Item : Cannot find path ... because it does not exist. [exit code: 1]' }]))
  await tick()
  const lastUpdate = updates[updates.length - 1]
  check('stderr 退出码签名识别为失败', lastUpdate === 1 && current === 1)
  // 普通 stderr 警告不算失败,连续 3 次成功恢复
  await ctx.emit('tools/result', { name: 'pwsh' }, mkResult(false, [{ type: 'text', text: '[stderr] warning: some deprecated flag' }]))
  await ctx.emit('tools/result', { name: 'pwsh' }, mkResult(false))
  await ctx.emit('tools/result', { name: 'pwsh' }, mkResult(false))
  await tick()
  check('stderr 警告不误判,连续 3 次成功恢复', current === 10)

  // session/disposed → 还原
  await ctx.emit('session/disposed', { id: 's1' })
  await tick()
  check('会话结束还原', current === 10)

  // 上下文压力:idle + 高 token → 降到 minParallel;回落 → 滞回恢复
  let pressureTokens = 700000
  const pressureMeter = { measure: () => ({ totalTokens: pressureTokens }) }
  const ctx2 = makeFakeCtx({ settings, tokenMeter: pressureMeter })
  const stats2 = createStats()
  createParallelConvergenceModule(ctx2, resolveConfig({}).parallelConvergence, stats2, { stateFile: tmpState() })
  const events = [{ type: 'request/context', data: { contextWindow: 1000000 } }]
  const agent = { id: 'a1', session: { events } }
  await ctx2.emit('agent/status', { agent, status: 'idle' })
  await tick()
  check('压力超阈值降档到 1', current === 1 && stats2.snapshot().counters['behavior.pressureDown'] === 1)
  pressureTokens = 1000
  await ctx2.emit('agent/status', { agent, status: 'idle' })
  await tick()
  check('压力回落后滞回恢复', current === 10)

  // 启动接管:上个 boot 串行化后没还原(进程被杀),state 文件存在 + settings 为 1 → 自动还原
  {
    const statePath = tmpState()
    writeFileSync(statePath, JSON.stringify({ serialized: true, originalParallel: 10 }))
    let cur = 1
    const updates2 = []
    const staleSettings = {
      get: () => ({ maxParallelToolCalls: cur }),
      update: async (ns, patch) => { updates2.push(patch.maxParallelToolCalls); cur = patch.maxParallelToolCalls },
    }
    const ctx3 = makeFakeCtx({ settings: staleSettings, tokenMeter: { measure: () => ({ totalTokens: 1000 }) } })
    createParallelConvergenceModule(ctx3, resolveConfig({}).parallelConvergence, createStats(), { stateFile: statePath })
    await tick()
    check('启动接管还原陈旧串行状态', updates2.length === 1 && updates2[0] === 10 && cur === 10)
    check('接管后状态文件清除', !existsSync(statePath))
  }
}

console.log('== failureGuard ==')
{
  const followed = []
  const ctx = makeFakeCtx()
  const stats = createStats()
  const agent = { id: 'a1', followup: (m) => followed.push(m) }
  createFailureGuardModule(ctx, resolveConfig({}).failureGuard, stats)
  const mkResult = (isError) => ({ isError })

  await ctx.emit('tools/result', { name: 'grep', agent }, mkResult(true))
  await ctx.emit('tools/result', { name: 'read', agent }, mkResult(true))
  check('不同工具各失败一次不触发', followed.length === 0)
  await ctx.emit('tools/result', { name: 'grep', agent }, mkResult(true))
  check('同工具连续失败 2 次触发 followup', followed.length === 1 && /grep/.test(followed[0]) && /2 次/.test(followed[0]))
  await ctx.emit('tools/result', { name: 'grep', agent }, mkResult(true))
  await ctx.emit('tools/result', { name: 'grep', agent }, mkResult(true))
  check('提示后计数重置,再次 2 连败再提示', followed.length === 2)
  await ctx.emit('tools/result', { name: 'grep', agent }, mkResult(false))
  await ctx.emit('tools/result', { name: 'grep', agent }, mkResult(true))
  check('成功后计数清零', followed.length === 2)
  check('failures 计数', stats.snapshot().counters['behavior.failures'] === 6)
  check('alerts 计数', stats.snapshot().counters['behavior.alerts'] === 2)
}

console.log('')
if (failures === 0) {
  console.log('ALL CHECKS PASSED')
  process.exit(0)
} else {
  console.error(`${failures} CHECK(S) FAILED`)
  process.exit(1)
}
