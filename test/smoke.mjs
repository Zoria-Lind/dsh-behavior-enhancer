// 单进程 smoke 验证(与 token-optimizer 同款风格)。
// 用法: node test/smoke.mjs

import { writeFileSync, existsSync, readFileSync, readdirSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.js'
import { createStats } from '../src/stats.js'
import { createBehaviorPromptModule } from '../src/modules/behaviorPrompt.js'
import { createParallelConvergenceModule } from '../src/modules/parallelConvergence.js'
import { createFailureGuardModule } from '../src/modules/failureGuard.js'
import { createPostWriteCheckModule, lightParse } from '../src/modules/postWriteCheck.js'

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
  check('v1.1 postWriteCheck 默认开启', cfg.postWriteCheck.enabled === true)
  check('v1.1 askThreshold 默认 3', cfg.postWriteCheck.askThreshold === 3)
  check('v1.1 keepBackups 默认 5', cfg.postWriteCheck.keepBackups === 5)
  check('v1.1 快照目录默认 ~/.dsh-memory/files', cfg.postWriteCheck.snapshotDir === '~/.dsh-memory/files')
  check('memory_bridge 占位节 enabled=false', cfg.memory_bridge.enabled === false)
  let threw = false
  try { resolveConfig({ behaviorPrompt: { bogus: 1 } }) } catch { threw = true }
  check('未知键报错', threw)
  threw = false
  try { resolveConfig({ postWriteCheck: { writeTools: ['write', 3] } }) } catch { threw = true }
  check('writeTools 非字符串数组报错', threw)
}

console.log('== lightParse 单元 ==')
{
  check('JSON 合法 0 问题', lightParse('{"a": 1}', 'json').length === 0)
  check('JSON 非法 1 问题', lightParse('{"a": }', 'json').length === 1)
  const codeBad = 'function f() {\n  return 1\n'
  check('括号未闭合检出', lightParse(codeBad, 'js').some((i) => /括号未闭合/.test(i.msg)))
  const codeOk = 'const a = "}"; // {\nconst b = `\n{`\n/* ] */\nfunction f() { return a }\n'
  check('字符串/注释内括号不误报', lightParse(codeOk, 'js').length === 0)
  const yamlTab = 'a:\n\tb: 1\n'
  check('YAML tab 缩进检出', lightParse(yamlTab, 'yaml').some((i) => /tab/.test(i.msg)))
  const pyHash = '# (\nprint("ok")\n'
  check('py # 注释内括号不误报', lightParse(pyHash, 'py').length === 0)
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

console.log('== postWriteCheck 写后检查(v1.1) ==')
{
  const tmpBase = mkdtempSync(join(tmpdir(), 'beh-pwc-'))
  const snapRoot = join(tmpBase, 'snap')
  const filePath = join(tmpBase, 'config.json')
  const writeFlow = async (ctx, path, content, isError = false) => {
    const exec = { name: 'write', arguments: { file_path: path } }
    await ctx.emit('tools/execute', exec, async () => {
      if (!isError) writeFileSync(path, content, 'utf8')
      return { isError, value: 'ok' }
    })
    return ctx.emit('tools/post-execute', exec,
      { isError, content: [{ type: 'text', text: 'ok' }] },
      async () => ({ kind: 'accept', content: [{ type: 'text', text: 'wrote' }] }))
  }
  const cfg = resolveConfig({}).postWriteCheck
  const bad3 = 'const a = {\nconst b = {\nconst c = {\n' // 3 个未闭合 {
  const badJson = '{"a": }' // JSON 1 个错误

  // 1) 合法 JSON 写入:不检查不干预
  {
    writeFileSync(filePath, '{"old": true}', 'utf8')
    const ctx = makeFakeCtx()
    const stats = createStats()
    createPostWriteCheckModule(ctx, cfg, stats, { snapshotDir: snapRoot })
    const d = await writeFlow(ctx, filePath, '{"new": 1}')
    check('pwc 合法写入不干预', d.kind === 'accept' && d.content[0].text === 'wrote' && readFileSync(filePath, 'utf8') === '{"new": 1}')
    check('pwc 合法写入不回滚', stats.snapshot().counters['postWriteCheck.rollbacks'] === undefined)
  }
  // 2) 非法 JSON(1 个问题)→ 自动回滚 + 报告
  {
    writeFileSync(filePath, '{"good": true}', 'utf8')
    const ctx = makeFakeCtx()
    const stats = createStats()
    createPostWriteCheckModule(ctx, cfg, stats, { snapshotDir: snapRoot })
    const d = await writeFlow(ctx, filePath, badJson)
    const text = d.content[0].text
    check('pwc 非法 JSON 自动回滚', readFileSync(filePath, 'utf8') === '{"good": true}')
    check('pwc 报告含写后检查标记', /写后检查/.test(text) && /回滚/.test(text))
    check('pwc 报告含问题数', /1 个问题/.test(text))
    check('pwc 回滚计数', stats.snapshot().counters['postWriteCheck.rollbacks'] === 1)
    check('pwc 快照 .bak 已保留', readdirSync(snapRoot, { recursive: true }).some((n) => String(n).includes('.bak-')))
  }
  // 3) 新建文件 + 非法内容 → 回滚 = 删除新文件
  {
    const newPath = join(tmpBase, 'brand-new.json')
    const ctx = makeFakeCtx()
    const stats = createStats()
    createPostWriteCheckModule(ctx, cfg, stats, { snapshotDir: snapRoot })
    const d = await writeFlow(ctx, newPath, badJson)
    check('pwc 非法新文件已删除', !existsSync(newPath))
    check('pwc 新文件报告含删除说明', /已将其删除/.test(d.content[0].text))
  }
  // 4) 写入失败(isError):丢弃本次快照,不检查不报告
  {
    const snapBefore = readdirSync(snapRoot, { recursive: true }).filter((n) => String(n).includes('.bak-')).length
    writeFileSync(filePath, '{"stable": 1}', 'utf8')
    const ctx = makeFakeCtx()
    const stats = createStats()
    createPostWriteCheckModule(ctx, cfg, stats, { snapshotDir: snapRoot })
    const d = await writeFlow(ctx, filePath, badJson, true)
    const snapAfter = readdirSync(snapRoot, { recursive: true }).filter((n) => String(n).includes('.bak-')).length
    check('pwc 写入失败不干预', d.content[0].text === 'wrote' && readFileSync(filePath, 'utf8') === '{"stable": 1}')
    check('pwc 写入失败快照已丢弃', snapAfter === snapBefore)
  }
  // 5) 非检查扩展名(.txt):不检查
  {
    const txtPath = join(tmpBase, 'notes.txt')
    writeFileSync(txtPath, 'old', 'utf8')
    const ctx = makeFakeCtx()
    createPostWriteCheckModule(ctx, cfg, createStats(), { snapshotDir: snapRoot })
    const d = await writeFlow(ctx, txtPath, '{ broken')
    check('pwc 非检查扩展名不干预', readFileSync(txtPath, 'utf8') === '{ broken' && d.content[0].text === 'wrote')
  }

  // ---- ≥3 个问题的询问三选一(JS 内容必须写在 .js 文件:JSON 分支的 parse 只报 1 个问题) ----
  const jsPath = join(tmpBase, 'config.js')
  const mkAskCtx = (askImpl) => {
    const ctx = makeFakeCtx({ userQuestions: { ask: askImpl } })
    return ctx
  }
  const markRunning = (ctx) => ctx.emit('agent/status', { agent: { id: 'root1' }, status: 'running' })

  // 6) 仅本次校验:回滚;第二个坏文件再次询问
  {
    let askCount = 0
    const ctx = mkAskCtx(async (req) => { askCount += 1; return { answers: [{ id: 'post_write_check', selected: ['仅本次校验'] }] } })
    const stats = createStats()
    createPostWriteCheckModule(ctx, cfg, stats, { snapshotDir: snapRoot })
    await markRunning(ctx)
    writeFileSync(jsPath, 'ok-before', 'utf8')
    await writeFlow(ctx, jsPath, bad3)
    check('pwc 仅本次校验:回滚', readFileSync(jsPath, 'utf8') === 'ok-before')
    writeFileSync(jsPath, 'ok-before2', 'utf8')
    await writeFlow(ctx, jsPath, bad3)
    check('pwc 仅本次校验:下次仍询问', askCount === 2 && readFileSync(jsPath, 'utf8') === 'ok-before2')
    check('pwc 询问计数', stats.snapshot().counters['postWriteCheck.asks'] === 2)
  }
  // 7) 本次+后续自动升级:第二个坏文件不再询问,直接回滚
  {
    let askCount = 0
    const ctx = mkAskCtx(async () => { askCount += 1; return { answers: [{ id: 'post_write_check', selected: ['本次+后续自动升级'] }] } })
    createPostWriteCheckModule(ctx, cfg, createStats(), { snapshotDir: snapRoot })
    await markRunning(ctx)
    writeFileSync(jsPath, 'ok-before', 'utf8')
    const d1 = await writeFlow(ctx, jsPath, bad3)
    writeFileSync(jsPath, 'ok-before2', 'utf8')
    await writeFlow(ctx, jsPath, bad3)
    check('pwc 自动升级:第二次不再询问', askCount === 1 && readFileSync(jsPath, 'utf8') === 'ok-before2')
    check('pwc 自动升级报告含说明', /自动升级/.test(d1.content[0].text))
  }
  // 8) 不校验:保留本次写入
  {
    let askCount = 0
    const ctx = mkAskCtx(async () => { askCount += 1; return { answers: [{ id: 'post_write_check', selected: ['不校验'] }] } })
    const stats = createStats()
    createPostWriteCheckModule(ctx, cfg, stats, { snapshotDir: snapRoot })
    await markRunning(ctx)
    writeFileSync(jsPath, 'ok-before', 'utf8')
    const d = await writeFlow(ctx, jsPath, bad3)
    check('pwc 不校验:保留写入', askCount === 1 && readFileSync(jsPath, 'utf8') === bad3 && d.content[0].text === 'wrote')
    check('pwc 不校验不回滚', stats.snapshot().counters['postWriteCheck.rollbacks'] === undefined)
  }
  // 9) 询问抛错/无 agent → 按 autoRollback 降级回滚
  {
    const ctx = mkAskCtx(async () => { throw new Error('NO_PROVIDER') })
    createPostWriteCheckModule(ctx, cfg, createStats(), { snapshotDir: snapRoot })
    await markRunning(ctx)
    writeFileSync(jsPath, 'ok-before', 'utf8')
    await writeFlow(ctx, jsPath, bad3)
    check('pwc 询问抛错降级回滚', readFileSync(jsPath, 'utf8') === 'ok-before')
    const ctx2 = mkAskCtx(async () => { throw new Error('NO_PROVIDER') })
    createPostWriteCheckModule(ctx2, { ...cfg, autoRollback: false }, createStats(), { snapshotDir: snapRoot })
    await markRunning(ctx2)
    writeFileSync(jsPath, 'ok-before2', 'utf8')
    await writeFlow(ctx2, jsPath, bad3)
    check('pwc autoRollback=false 保留写入', readFileSync(jsPath, 'utf8') === bad3)
  }
  // 10) 询问超时 → 按 autoRollback 降级回滚
  {
    const hangAsk = (req) => new Promise((_, reject) => {
      req.signal.addEventListener('abort', () => reject(new Error('ASK_ABORTED')))
    })
    const ctx = mkAskCtx(hangAsk)
    createPostWriteCheckModule(ctx, { ...cfg, askTimeoutMs: 60 }, createStats(), { snapshotDir: snapRoot })
    await markRunning(ctx)
    writeFileSync(jsPath, 'ok-before', 'utf8')
    await writeFlow(ctx, jsPath, bad3)
    check('pwc 询问超时降级回滚', readFileSync(jsPath, 'utf8') === 'ok-before')
  }
  // 11) keepBackups=5:连续 7 次合法写入只保留 5 份快照
  {
    const snapOnly = join(tmpBase, 'snap-keep')
    const ctx = makeFakeCtx()
    createPostWriteCheckModule(ctx, { ...cfg, keepBackups: 5 }, createStats(), { snapshotDir: snapOnly })
    for (let i = 0; i < 7; i++) {
      writeFileSync(filePath, `{"v": ${i}}`, 'utf8')
      await writeFlow(ctx, filePath, `{"v": ${i + 1}}`)
    }
    const baks = readdirSync(snapOnly, { recursive: true }).filter((n) => String(n).includes('.bak-'))
    check('pwc 快照保留上限 5 份', baks.length === 5)
  }

  rmSync(tmpBase, { recursive: true, force: true })
}

console.log('')
if (failures === 0) {
  console.log('ALL CHECKS PASSED')
  process.exit(0)
} else {
  console.error(`${failures} CHECK(S) FAILED`)
  process.exit(1)
}
