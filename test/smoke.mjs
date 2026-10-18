// 单进程 smoke 验证(与 token-optimizer 同款风格)。
// 用法: node test/smoke.mjs

import { writeFileSync, existsSync, readFileSync, readdirSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { resolveConfig } from '../src/config.js'
import { createStats } from '../src/stats.js'
import { createBehaviorPromptModule } from '../src/modules/behaviorPrompt.js'
import { createParallelConvergenceModule } from '../src/modules/parallelConvergence.js'
import { createFailureGuardModule } from '../src/modules/failureGuard.js'
import { createPostWriteCheckModule, lightParse } from '../src/modules/postWriteCheck.js'
import { createProjectMemoryModule, checkMemoryContent, isMemoryFilePath } from '../src/modules/projectMemory.js'
import { createDisciplineInjectModule, extractSection, findDisciplineFile } from '../src/modules/disciplineInject.js'
import { createWriteDiffVerifyModule, findGitRootsFromCommand } from '../src/modules/writeDiffVerify.js'
import { createHardGateModule } from '../src/modules/hardGate.js'
import { createVerifyLoopModule } from '../src/modules/verifyLoop.js'
import { createComplianceModule } from '../src/modules/compliance.js'

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
  // waterfall 组合语义(0A §D2 实测):最外层返回值唯一有效;
  // prepend 之间后注册者更外层;默认之间先注册者更外层
  const handlers = new Map() // event -> [{fn}] 按执行顺序(最外层在前)
  const insert = (event, fn, opts) => {
    const arr = handlers.get(event) ?? []
    if (opts && opts.prepend) arr.unshift({ fn }) // prepend:上浮到最外层(后 prepend 者更外层)
    else arr.push({ fn })                          // 默认:先注册者更外层
    handlers.set(event, arr)
  }
  return {
    on(event, handler, opts) { insert(event, handler, opts); return () => this.off(event, handler) },
    off(event, handler) {
      const arr = handlers.get(event)
      if (!arr) return
      const i = arr.findIndex((h) => h.fn === handler)
      if (i >= 0) arr.splice(i, 1)
    },
    async emit(event, ...args) {
      const arr = handlers.get(event)
      if (!arr || arr.length === 0) throw new Error(`no handler for ${event}`)
      // 测试把"终止 next"作为最后一个参数传入(内核同款调用形状)→ 它是链条终点
      const terminal = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null
      const baseArgs = terminal ? args.slice(0, -1) : args
      const run = async (i, a) => {
        if (i >= arr.length) return terminal ? terminal(...a) : undefined
        return arr[i].fn(...a, (...na) => run(i + 1, na.length ? na : a))
      }
      return run(0, baseArgs)
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
  check('v1.3 projectMemory 默认开启', cfg.projectMemory.enabled === true)
  check('v1.3 projectMemory maxBytes 65536', cfg.projectMemory.maxBytes === 65536)
  check('v1.3 projectMemory 文件名为内核四个候选',
    JSON.stringify(cfg.projectMemory.fileNames) === JSON.stringify(['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']))
  check('v1.3 disciplineInject 默认开启', cfg.disciplineInject.enabled === true)
  check('v1.3 disciplineInject 默认每 3 小时(轮次关)', cfg.disciplineInject.everyHours === 3 && cfg.disciplineInject.everyTurns === 0)
  check('v1.3 disciplineInject skipUnchanged 默认 true', cfg.disciplineInject.skipUnchanged === true)
  check('v1.3 disciplineInject 默认只认 AGENTS.md/CLAUDE.md',
    JSON.stringify(cfg.disciplineInject.candidates) === JSON.stringify(['AGENTS.md', 'CLAUDE.md']))
  let threw = false
  try { resolveConfig({ behaviorPrompt: { bogus: 1 } }) } catch { threw = true }
  check('未知键报错', threw)
  threw = false
  try { resolveConfig({ postWriteCheck: { writeTools: ['write', 3] } }) } catch { threw = true }
  check('writeTools 非字符串数组报错', threw)
  threw = false
  try { resolveConfig({ projectMemory: { bogus: 1 } }) } catch { threw = true }
  check('projectMemory 未知键报错', threw)
  threw = false
  try { resolveConfig({ projectMemory: { shrinkRatio: 1.5 } }) } catch { threw = true }
  check('projectMemory shrinkRatio 越界报错', threw)
  // 宿主若用 volatile Config 强转 config,叶子值会变 {};必须视为未设置而不是报错
  const coerced = resolveConfig({ disciplineInject: { enabled: {}, everyHours: {}, everyTurns: {} } })
  check('volatile 强转的空对象视为未设置', coerced.disciplineInject.everyHours === 3 && coerced.disciplineInject.enabled === true)
}

console.log('== npm 打包与 bundle patch 一致性(回归:Issue #2) ==')
{
  const root = new URL('..', import.meta.url)
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
  check('package name 为 scoped 名 @zoria-lind/dsh-behavior-enhancer', pkg.name === '@zoria-lind/dsh-behavior-enhancer')
  // 2026-10-02 回归:awesome-dsh-plugin 的 npm 回填靠 repository 字段关联 GitHub
  // 条目;缺失会导致市场目录里 npm:null → 市场只装 git 旧版(实测事故)
  check('package.json 声明 repository(市场 npm 回填依赖)', typeof pkg.repository?.url === 'string' && pkg.repository.url.includes('github.com/Zoria-Lind/dsh-behavior-enhancer'))
  const patchRel = pkg.dsh?.bundle?.patch
  check('package.json 声明 dsh.bundle.patch', typeof patchRel === 'string' && patchRel.length > 0)
  const patchUrl = new URL(patchRel.replace(/^\.\//, ''), root)
  check('bundle patch 文件存在', existsSync(fileURLToPath(patchUrl)))
  check('npm files 包含 cordis.patch.yml(发布包内 patch 生效)', Array.isArray(pkg.files) && pkg.files.includes('cordis.patch.yml'))
  // 最小 YAML 提取(本项目 patch 结构固定:顶层 insert 列表 → id/name 行)
  const lines = readFileSync(patchUrl, 'utf8').split(/\r?\n/)
  const entries = []
  let cur = null
  for (const line of lines) {
    const idM = line.match(/^\s*-\s+id:\s*['"]?([^'"]+?)['"]?\s*$/)
    if (idM) { cur = { id: idM[1], name: null }; entries.push(cur); continue }
    const nameM = line.match(/^\s*name:\s*['"]?([^'"]+?)['"]?\s*$/)
    if (cur && nameM && cur.name === null) cur.name = nameM[1]
  }
  const beh = entries.find((e) => e.id === 'behavior-enhancer')
  check('cordis.patch.yml 含 id: behavior-enhancer 条目', !!beh)
  check('patch entry 的 name 与 package name 一致', beh?.name === pkg.name)
  check('patch entry 的 name 保持 scoped 形式(防退回裸 dsh-behavior-enhancer)', typeof beh?.name === 'string' && beh.name.startsWith('@') && beh.name.includes('/'))
  // 2026-10-18 回归:旧区间以 <0.2.0-0 结尾,按 semver 把 0.2.0-rc.2(桌面端内核)排除在外,
  // 与 dshReleases 里声明的 compatible 自相矛盾
  const compat = pkg.dsh?.compatibility ?? {}
  check('compat 区间覆盖 0.2.0-rc.x 与 0.2.1-rc.x', typeof compat.dsh === 'string' && compat.dsh.includes('>=0.2.0-rc.0 <0.2.2-0'))
  check('dshReleases 声明 0.2.0-rc.2 compatible', compat.dshReleases?.['0.2.0-rc.2'] === 'compatible')
  check('dshReleases 声明 0.2.1-rc.2 compatible(当前桌面端)', compat.dshReleases?.['0.2.1-rc.2'] === 'compatible')
  check('版本已升到 1.3(项目记忆)', typeof pkg.version === 'string' && pkg.version.startsWith('1.3.'))
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
  check('order 有限且落在 identity(-1000)与 persona(0)之间(内核可解析时取中点)',
    Number.isFinite(sections[0].order) && sections[0].order > -1000 && sections[0].order < 0)
  check('文本为静态配置', sections[0].text.length > 50)
  check('promptApplied 计数', stats.snapshot().counters['behavior.promptApplied'] === 1)
  cleanup()
  check('dispose 后 section 已撤', sections.length === 0)
}

console.log('== behaviorPrompt B2(纪律数据层) ==')
{
  const sections = []
  const spSvc = { section: (s) => { sections.push(s); return () => { const i = sections.indexOf(s); if (i >= 0) sections.splice(i, 1) } } }
  const baseCfg = resolveConfig({}).behaviorPrompt

  // 默认预设:保留内核没有的条目,删除内核已强制的两条
  const cleanup1 = createBehaviorPromptModule(makeFakeCtx({ systemPrompt: spSvc }), baseCfg, createStats())
  check('B2:默认预设注入批量验证/证据条目', /批量操作前先验证/.test(sections[0].text) && /证据与诚实/.test(sections[0].text))
  check('B2:内核已强制的两条不再重复(先读后写/同类修改串行)', !/先读后写/.test(sections[0].text) && !/同类修改串行/.test(sections[0].text))
  // v1.3 验收第 9 条:静态纪律必须含「进度即记」,且不写具体路径/日期
  check('B2:静态纪律含「进度即记」(每完成一个进度就更新进度文件)', /进度即记/.test(sections[0].text) && /每完成一个进度/.test(sections[0].text))
  check('B2:进度即记不含具体路径/日期', !/[A-Za-z]:[\\/]|\.md\b|\d{4}-\d{2}-\d{2}/.test(sections[0].text.split('\n').find((l) => l.includes('进度即记')) ?? ''))
  cleanup1()

  // 预设切换:strict 增加安全条目
  sections.length = 0
  const cleanup2 = createBehaviorPromptModule(makeFakeCtx({ systemPrompt: spSvc }), { ...baseCfg, disciplinePreset: 'strict' }, createStats())
  check('B2:strict 预设注入新增安全条目', sections.length === 1 && /先向用户确认/.test(sections[0].text) && /dry-run|预演/.test(sections[0].text))
  cleanup2()

  // 字节预算:极小预算 → 整条丢弃 + 显式截断告警
  sections.length = 0
  const cleanup3 = createBehaviorPromptModule(makeFakeCtx({ systemPrompt: spSvc }), { ...baseCfg, disciplineMaxBytes: 300 }, createStats())
  check('B2:超字节预算截断留显式告警', sections.length === 1 && /截断/.test(sections[0].text))
  cleanup3()

  // includeTags:strict + safety → 只剩 safety 条目
  sections.length = 0
  const cleanup4 = createBehaviorPromptModule(makeFakeCtx({ systemPrompt: spSvc }), { ...baseCfg, disciplinePreset: 'strict', disciplineIncludeTags: ['safety'] }, createStats())
  check('B2:includeTags 过滤生效', sections.length === 1 && /先向用户确认/.test(sections[0].text) && !/批量操作前先验证/.test(sections[0].text))
  cleanup4()

  // 逃生舱:显式自定义 text 原样注册(旧配置行为不变)
  sections.length = 0
  const cleanup5 = createBehaviorPromptModule(makeFakeCtx({ systemPrompt: spSvc }), { ...baseCfg, text: '自定义纪律文本' }, createStats())
  check('B2:text 逃生舱原样注册', sections.length === 1 && sections[0].text === '自定义纪律文本')
  cleanup5()

  // persona 探测:assemble waterfall 出现 persona 段 → 告警计数一次
  sections.length = 0
  const statsP = createStats()
  const ctxP = makeFakeCtx({ systemPrompt: spSvc })
  createBehaviorPromptModule(ctxP, baseCfg, statsP)
  await ctxP.emit('system-prompt/assemble', { sections: [{ name: 'deployment:persona-prefix', text: 'persona' }, { name: 'behavior-discipline', text: 'discipline' }] }, {}, async () => ({ sections: [] }))
  check('B2:persona 段出现 → 探测计数', statsP.snapshot().counters['behavior.personaDetected'] === 1)
  // 未知 preset → 回退 default 不崩
  sections.length = 0
  const cleanup6 = createBehaviorPromptModule(makeFakeCtx({ systemPrompt: spSvc }), { ...baseCfg, disciplinePreset: 'bogus' }, createStats())
  check('B2:未知预设回退 default 不崩', sections.length === 1 && /批量操作前先验证/.test(sections[0].text))
  cleanup6()

  // 真内核探针(本机可解析 dsh-system-prompt 时)
  {
    const { resolveKernelModule } = await import('../src/kernel.js')
    const spMod = resolveKernelModule('@deepseek-ai/dsh-system-prompt')
    if (spMod && typeof spMod.getSectionOrder === 'function') {
      const identity = spMod.getSectionOrder('HARNESS_IDENTITY')
      const persona = spMod.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX')
      check('B2 探针:真内核 getSectionOrder(HARNESS_IDENTITY)=-1000 / persona=0', identity === -1000 && persona === 0)
    }
  }
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
  // B1(P2):followup 必须收到 UserMessage——按"构造路径"断言(对象含 content 数组与
  // source.kind='plugin'),不再用假 agent 吞类型错误
  const fakeCreateUserMessage = (input) => ({ role: 'user', content: input.content, source: input.source })
  const followed = []
  const ctx = makeFakeCtx()
  const stats = createStats()
  const agent = { id: 'a1', followup: (m) => followed.push(m) }
  createFailureGuardModule(ctx, resolveConfig({}).failureGuard, stats, { createUserMessage: fakeCreateUserMessage })
  const mkResult = (isError) => ({ isError })

  await ctx.emit('tools/result', { name: 'grep', agent }, mkResult(true))
  await ctx.emit('tools/result', { name: 'read', agent }, mkResult(true))
  check('不同工具各失败一次不触发', followed.length === 0)
  await ctx.emit('tools/result', { name: 'grep', agent }, mkResult(true))
  const msg1 = followed[0]
  check('同工具连续失败 2 次触发 followup', followed.length === 1)
  check('B1:followup 收到 UserMessage(非 string,content 数组 + source.kind=plugin)',
    typeof msg1 === 'object' && msg1 !== null && !(typeof msg1 === 'string')
    && Array.isArray(msg1.content) && msg1.content[0]?.type === 'text'
    && msg1.source?.kind === 'plugin:behavior-enhancer')
  check('B1:提示文本仍含工具名与次数', /grep/.test(msg1.content[0].text) && /2 次/.test(msg1.content[0].text))
  await ctx.emit('tools/result', { name: 'grep', agent }, mkResult(true))
  await ctx.emit('tools/result', { name: 'grep', agent }, mkResult(true))
  check('提示后计数重置,再次 2 连败再提示', followed.length === 2)
  await ctx.emit('tools/result', { name: 'grep', agent }, mkResult(false))
  await ctx.emit('tools/result', { name: 'grep', agent }, mkResult(true))
  check('成功后计数清零', followed.length === 2)
  check('failures 计数', stats.snapshot().counters['behavior.failures'] === 6)
  check('alerts 计数', stats.snapshot().counters['behavior.alerts'] === 2)

  // B1 探针:本机能解析内核 dsh-llm 时,用真 createUserMessage 走一遍构造路径
  {
    const { resolveKernelModule } = await import('../src/kernel.js')
    const llm = resolveKernelModule('@deepseek-ai/dsh-llm')
    if (llm && typeof llm.createUserMessage === 'function') {
      const real = llm.createUserMessage({
        content: [{ type: 'text', text: 'probe' }],
        source: { kind: 'plugin:behavior-enhancer', form: 'notice', summary: 'failure-guard' },
      })
      check('B1 探针:真内核 createUserMessage 产出冻结 UserMessage(role=user)',
        real?.role === 'user' && Array.isArray(real.content) && Object.isFrozen(real))
    }
  }
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
  // 12) B1:会话 cwd ≠ 进程 cwd → 相对路径按会话 cwd 解析(改前用 process.cwd() 解析错目录,检查静默失效)
  {
    const relDir = join(tmpBase, 'sesscwd')
    mkdirSync(relDir, { recursive: true })
    const relPath = 'rel-target.json'
    const absRel = join(relDir, relPath)
    const ctx = makeFakeCtx()
    createPostWriteCheckModule(ctx, cfg, createStats(), { snapshotDir: join(tmpBase, 'snap-cwd') })
    const execWithCwd = { name: 'write', arguments: { file_path: relPath }, agent: { id: 'a1', session: { header: { cwd: relDir } } } }
    await ctx.emit('tools/execute', execWithCwd, async () => { writeFileSync(absRel, badJson, 'utf8'); return { isError: false, value: 'ok' } })
    await ctx.emit('tools/post-execute', execWithCwd, { isError: false, content: [{ type: 'text', text: 'ok' }] }, async () => ({ kind: 'accept', content: [{ type: 'text', text: 'wrote' }] }))
    check('B1:会话 cwd ≠ 进程 cwd,相对路径仍命中并回滚(新文件被删)', !existsSync(absRel))
    // 相对路径 + 无会话 cwd → 显式跳过(不崩、不误查)
    const ctx2 = makeFakeCtx()
    createPostWriteCheckModule(ctx2, cfg, createStats(), { snapshotDir: join(tmpBase, 'snap-cwd2') })
    const execNoCwd = { name: 'write', arguments: { file_path: relPath } }
    await ctx2.emit('tools/execute', execNoCwd, async () => ({ isError: false, value: 'ok' }))
    const d2 = await ctx2.emit('tools/post-execute', execNoCwd, { isError: false, content: [{ type: 'text', text: 'ok' }] }, async () => ({ kind: 'accept', content: [{ type: 'text', text: 'wrote' }] }))
    check('B1:相对路径无会话 cwd → 显式跳过不崩', d2.kind === 'accept' && d2.content[0].text === 'wrote')
  }

  rmSync(tmpBase, { recursive: true, force: true })
}

console.log('== projectMemory 项目记忆写后校验(v1.3) ==')
{
  const tmpBase = mkdtempSync(join(tmpdir(), 'beh-pm-'))
  const cfg = resolveConfig({}).projectMemory
  const leakOpts = { homedir: 'C:\\Users\\tester', username: 'tester', checkPathLeak: true }
  const agentsPath = join(tmpBase, 'AGENTS.md')
  const dupContent = '- 记住:构建要用 pnpm\n- 另一条事实\n- 记住:构建要用 pnpm\n'
  const memFlow = async (ctx, path, content, { isError = false, cwd, noWrite = false, writeTo = null, name = 'write' } = {}) => {
    const exec = { name, arguments: { file_path: path } }
    if (cwd) exec.agent = { id: 'a1', session: { header: { cwd } } }
    await ctx.emit('tools/execute', exec, async () => {
      if (!isError && !noWrite) writeFileSync(writeTo ?? path, content, 'utf8')
      return { isError, value: 'ok' }
    })
    return ctx.emit('tools/post-execute', exec,
      { isError, content: [{ type: 'text', text: 'ok' }] },
      async () => ({ kind: 'accept', content: [{ type: 'text', text: 'base' }] }))
  }

  // 纯函数:文件名匹配
  check('pm 记忆文件名命中(四个候选)',
    ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'].every((n) => isMemoryFilePath(join(tmpBase, n), cfg)))
  check('pm 文件名大小写不敏感', isMemoryFilePath('C:\\proj\\AGENTS.MD', cfg) && isMemoryFilePath('C:\\proj\\agents.md', cfg))
  check('pm 非记忆文件不命中', !isMemoryFilePath('C:\\proj\\README.md', cfg) && !isMemoryFilePath('C:\\proj\\notes.md', cfg))

  // 纯函数:内容检查
  const dupIssue = checkMemoryContent(dupContent, cfg).issues.find((i) => i.kind === 'duplicate')
  check('pm 重复行检出且报第二次出现行号', !!dupIssue && dupIssue.line === 3 && /重复/.test(dupIssue.msg))
  check('pm 短行不计重复', checkMemoryContent('---\n---\n', cfg).issues.every((i) => i.kind !== 'duplicate'))
  check('pm 体量超限检出', checkMemoryContent('x'.repeat(30), { ...cfg, maxBytes: 10 }).issues.some((i) => i.kind === 'size'))
  check('pm 超长行检出', checkMemoryContent('a'.repeat(250), cfg).issues.some((i) => i.kind === 'long-line'))
  check('pm 泄漏检出(主目录)', checkMemoryContent('see C:\\Users\\tester\\secret.txt', leakOpts).issues.some((i) => i.kind === 'leak'))
  check('pm 泄漏检出(盘符绝对路径)', checkMemoryContent('see D:\\private\\notes.md', leakOpts).issues.some((i) => i.kind === 'leak'))
  check('pm URL/相对路径不误报', checkMemoryContent('see https://example.com/x and docs/notes.md', leakOpts).issues.every((i) => i.kind !== 'leak'))
  check('pm 缩水检出', checkMemoryContent('只剩两行\n', { ...cfg, previousSize: 5000 }).issues.some((i) => i.kind === 'shrink'))
  check('pm 小文件不判缩水', checkMemoryContent('x\n', { ...cfg, previousSize: 1000 }).issues.every((i) => i.kind !== 'shrink'))

  // 模块:干净写入
  {
    const ctx = makeFakeCtx()
    const stats = createStats()
    createProjectMemoryModule(ctx, cfg, stats, leakOpts)
    const d = await memFlow(ctx, agentsPath, '- 事实一:构建用 pnpm\n- 事实二:测试跑 node test/smoke.mjs\n')
    const c = stats.snapshot().counters
    check('pm 干净写入不追加报告', d.content.length === 1 && d.content[0].text === 'base')
    check('pm checked 计数且无 reports', c['projectMemory.checked'] === 1 && c['projectMemory.reports'] === undefined)
  }
  // 模块:重复行 → 追加(不是替换)
  {
    const ctx = makeFakeCtx()
    const stats = createStats()
    createProjectMemoryModule(ctx, cfg, stats, leakOpts)
    const d = await memFlow(ctx, agentsPath, dupContent)
    check('pm 报告追加且原 content 保留', d.content.length === 2 && d.content[0].text === 'base')
    check('pm 报告文案含标记与问题', /项目记忆检查/.test(d.content[1].text) && /重复/.test(d.content[1].text))
    check('pm reports/issues 计数', stats.snapshot().counters['projectMemory.reports'] === 1 && stats.snapshot().counters['projectMemory.issues'] >= 1)
  }
  // 模块:泄漏只提示,绝不回滚
  {
    const ctx = makeFakeCtx()
    createProjectMemoryModule(ctx, cfg, createStats(), leakOpts)
    const leakContent = '部署目录:C:\\Users\\tester\\app\n'
    const d = await memFlow(ctx, agentsPath, leakContent)
    check('pm 泄漏只提示', d.content.length === 2 && /路径|本机/.test(d.content[1].text))
    check('pm 绝不回滚记忆文件', readFileSync(agentsPath, 'utf8') === leakContent)
  }
  // 模块:非记忆文件 / 写失败 / 相对路径
  {
    const ctx = makeFakeCtx()
    const stats = createStats()
    createProjectMemoryModule(ctx, cfg, stats, leakOpts)
    const d = await memFlow(ctx, join(tmpBase, 'README.md'), dupContent)
    check('pm 非记忆文件忽略', d.content.length === 1 && stats.snapshot().counters['projectMemory.checked'] === undefined)
    const d2 = await memFlow(ctx, agentsPath, dupContent, { isError: true })
    check('pm 写失败不检查', d2.content.length === 1 && stats.snapshot().counters['projectMemory.checked'] === undefined)
    const relDir = join(tmpBase, 'sesscwd')
    mkdirSync(relDir, { recursive: true })
    const d3 = await memFlow(ctx, 'AGENTS.md', dupContent, { cwd: relDir, writeTo: join(relDir, 'AGENTS.md') })
    check('pm 相对路径按会话 cwd 校验', d3.content.length === 2 && existsSync(join(relDir, 'AGENTS.md')))
    const d4 = await memFlow(ctx, 'AGENTS.md', dupContent, { noWrite: true })
    check('pm 相对路径无 cwd → 跳过不崩', d4.kind === 'accept' && d4.content.length === 1)
  }
  // 模块:缩水(同进程内两次写)
  {
    const ctx = makeFakeCtx()
    createProjectMemoryModule(ctx, cfg, createStats(), leakOpts)
    const big = Array.from({ length: 120 }, (_, i) => `- 第 ${i + 1} 条事实:某个足够长的项目说明`).join('\n')
    await memFlow(ctx, agentsPath, big)
    const d = await memFlow(ctx, agentsPath, '- 只剩一条\n')
    check('pm 缩水告警', d.content.length === 2 && /缩水|不足原来/.test(d.content[1].text))
  }
  // enabled=false:空转
  {
    const ctx = makeFakeCtx()
    ctx.on('tools/execute', async (exec, next) => next())
    ctx.on('tools/post-execute', async (exec, result, next) => next())
    const cleanup = createProjectMemoryModule(ctx, { ...cfg, enabled: false }, createStats(), leakOpts)
    const d = await memFlow(ctx, agentsPath, dupContent)
    check('pm enabled=false 空转', d.content.length === 1)
    cleanup()
  }
  // cleanup:解绑后不再检查
  {
    const ctx = makeFakeCtx()
    ctx.on('tools/execute', async (exec, next) => next())
    ctx.on('tools/post-execute', async (exec, result, next) => next())
    const stats = createStats()
    const cleanup = createProjectMemoryModule(ctx, cfg, stats, leakOpts)
    cleanup()
    const d = await memFlow(ctx, agentsPath, dupContent)
    check('pm cleanup 后不再检查', d.content.length === 1 && stats.snapshot().counters['projectMemory.checked'] === undefined)
  }

  rmSync(tmpBase, { recursive: true, force: true })
}

console.log('== disciplineInject 项目纪律周期重述(v1.3) ==')
{
  const tmpBase = mkdtempSync(join(tmpdir(), 'beh-di-'))
  const agents = join(tmpBase, 'AGENTS.md')
  const fakeCreateUserMessage = (input) => ({ role: 'user', content: input.content, source: input.source })
  let fakeNow = 1_000_000_000_000
  const baseCfg = resolveConfig({}).disciplineInject
  const mkAgent = () => ({ id: 'a1', session: { header: { cwd: tmpBase } }, steered: [], steer(m) { this.steered.push(m) } })
  const mk = (sf, over = {}) => {
    const ctx = makeFakeCtx()
    const stats = createStats()
    createDisciplineInjectModule(ctx, { ...baseCfg, ...over }, stats,
      { createUserMessage: fakeCreateUserMessage, now: () => fakeNow, stateFile: sf })
    return { ctx, stats }
  }
  const md = '## 项目纪律\n- 主题:X\n- 流程:Y\n## 其他\n- 不该出现\n'
  writeFileSync(agents, md, 'utf8')

  // 纯函数
  const sec = extractSection(md, '## 项目纪律')
  check('di 取节只到下一条同级标题', !!sec && /主题:X/.test(sec.text) && !/不该出现/.test(sec.text))
  check('di 缺节返回 null', extractSection(md, '## 不存在的节') === null)
  check('di 空节返回 null', extractSection('## 项目纪律\n\n## 其他\n', '## 项目纪律') === null)
  check('di 从 cwd 向上找到 AGENTS.md', findDisciplineFile(tmpBase) === agents)

  // 1) 到点注入 / 未到点 / 未变跳过 / 变化再注入
  {
    const { ctx, stats } = mk(join(tmpBase, 's1.json'))
    const agent = mkAgent()
    const r = await ctx.emit('agent/turn-stopping', { agent })
    check('di 首轮即注入(无状态视为到期)', agent.steered.length === 1)
    check('di 注入只含纪律节', /主题:X/.test(agent.steered[0].content[0].text) && !/不该出现/.test(agent.steered[0].content[0].text))
    check('di steer 收到 UserMessage 形状', agent.steered[0].source?.kind === 'plugin:behavior-enhancer' && Array.isArray(agent.steered[0].content))
    check('di serial 事件返回 undefined', r === undefined)
    check('di injected 计数', stats.snapshot().counters['discipline.injected'] === 1)

    fakeNow += 60 * 1000
    await ctx.emit('agent/turn-stopping', { agent })
    check('di 未到点不注入', agent.steered.length === 1)

    fakeNow += 4 * 3600 * 1000
    await ctx.emit('agent/turn-stopping', { agent })
    check('di skipUnchanged:内容未变不重复注入', agent.steered.length === 1)
    check('di skippedUnchanged 计数', stats.snapshot().counters['discipline.skippedUnchanged'] === 1)

    writeFileSync(agents, md.replace('- 主题:X', '- 主题:Z'), 'utf8')
    fakeNow += 4 * 3600 * 1000
    await ctx.emit('agent/turn-stopping', { agent })
    check('di 内容变化后再注入', agent.steered.length === 2 && /主题:Z/.test(agent.steered[1].content[0].text))
    check('di 状态已落盘', existsSync(join(tmpBase, 's1.json')))
  }
  // 1b) 内容变化 → 不必等到点,立刻重述(刚写完规则马上生效)
  {
    writeFileSync(agents, md, 'utf8')
    const { ctx } = mk(join(tmpBase, 's1b.json'))
    const agent = mkAgent()
    await ctx.emit('agent/turn-stopping', { agent })
    writeFileSync(agents, md.replace('- 流程:Y', '- 流程:W'), 'utf8')
    await ctx.emit('agent/turn-stopping', { agent })
    check('di 内容变化立刻重述(不等周期)', agent.steered.length === 2 && /流程:W/.test(agent.steered[1].content[0].text))
  }
  // 2) 压缩后补注入(未到点、内容未变)
  {
    writeFileSync(agents, md, 'utf8')
    const { ctx } = mk(join(tmpBase, 's2.json'))
    const agent = mkAgent()
    await ctx.emit('agent/turn-stopping', { agent })
    await ctx.emit('compaction/end')
    await ctx.emit('agent/turn-stopping', { agent })
    check('di 压缩后补注入', agent.steered.length === 2)
  }
  // 3) everyTurns 口径(首轮先建立一次,之后按轮次)
  {
    const { ctx } = mk(join(tmpBase, 's3.json'), { everyHours: 0, everyTurns: 2, skipUnchanged: false })
    const agent = mkAgent()
    await ctx.emit('agent/turn-stopping', { agent })
    check('di everyTurns 首轮建立一次', agent.steered.length === 1)
    await ctx.emit('agent/turn-stopping', { agent })
    check('di everyTurns 未到不动', agent.steered.length === 1)
    await ctx.emit('agent/turn-stopping', { agent })
    check('di everyTurns 两轮后再注入', agent.steered.length === 2)
  }
  // 4) 超限不注入
  {
    const { ctx, stats } = mk(join(tmpBase, 's4.json'), { maxDigestBytes: 10 })
    const agent = mkAgent()
    await ctx.emit('agent/turn-stopping', { agent })
    check('di 节超 maxDigestBytes 不注入', agent.steered.length === 0 && stats.snapshot().counters['discipline.oversize'] === 1)
  }
  // 5) 缺节
  {
    writeFileSync(agents, '## 别的\n- 内容\n', 'utf8')
    const { ctx, stats } = mk(join(tmpBase, 's5.json'))
    const agent = mkAgent()
    await ctx.emit('agent/turn-stopping', { agent })
    check('di 缺节不注入且计数', agent.steered.length === 0 && stats.snapshot().counters['discipline.noSection'] === 1)
  }
  // 6) 两个触发器都关 → 完全静默
  {
    writeFileSync(agents, md, 'utf8')
    const ctx = makeFakeCtx()
    ctx.on('agent/turn-stopping', () => undefined)
    const stats = createStats()
    createDisciplineInjectModule(ctx, { ...baseCfg, everyHours: 0, everyTurns: 0 }, stats,
      { createUserMessage: fakeCreateUserMessage, now: () => fakeNow, stateFile: join(tmpBase, 's6.json') })
    const agent = mkAgent()
    await ctx.emit('agent/turn-stopping', { agent })
    check('di 双 0 完全静默', agent.steered.length === 0 && stats.snapshot().counters['discipline.injected'] === undefined)
  }
  // 7) 状态落盘 → 新实例未到点不重复
  {
    writeFileSync(agents, md, 'utf8')
    const sf = join(tmpBase, 's7.json')
    const a = mk(sf)
    const agent1 = mkAgent()
    await a.ctx.emit('agent/turn-stopping', { agent: agent1 })
    const b = mk(sf)
    const agent2 = mkAgent()
    await b.ctx.emit('agent/turn-stopping', { agent: agent2 })
    check('di 跨实例未到点不重复注入', agent1.steered.length === 1 && agent2.steered.length === 0)
  }
  // 8) cleanup 后不再注入
  {
    const ctx = makeFakeCtx()
    ctx.on('agent/turn-stopping', () => undefined)
    const cleanup = createDisciplineInjectModule(ctx, baseCfg, createStats(),
      { createUserMessage: fakeCreateUserMessage, now: () => fakeNow, stateFile: join(tmpBase, 's8.json') })
    cleanup()
    const agent = mkAgent()
    await ctx.emit('agent/turn-stopping', { agent })
    check('di cleanup 后不再注入', agent.steered.length === 0)
  }

  // 9) 运行期读活设置:面板关掉 → 立即不注入
  {
    writeFileSync(agents, md, 'utf8')
    const ctx0 = makeFakeCtx({
      settings: { describe: () => [{ ns: 'behavior-enhancer', value: { disciplineInject: { enabled: false } } }] },
    })
    const stats = createStats()
    createDisciplineInjectModule(ctx0, baseCfg, stats,
      { createUserMessage: fakeCreateUserMessage, now: () => fakeNow, stateFile: join(tmpBase, 's9.json') })
    const agent = mkAgent()
    await ctx0.emit('agent/turn-stopping', { agent })
    check('di 面板关闭后不注入(读活设置)', agent.steered.length === 0 && stats.snapshot().counters['discipline.injected'] === undefined)
  }
  // 10) 运行期读活设置:面板改小时数 → 立即按新周期判定
  {
    writeFileSync(agents, md, 'utf8')
    const sf = join(tmpBase, 's10.json')
    const a = mk(sf)
    const agent1 = mkAgent()
    await a.ctx.emit('agent/turn-stopping', { agent: agent1 }) // 先注入一次,把 lastInjectAt 推到"现在"
    const ctx2 = makeFakeCtx({
      settings: { describe: () => [{ ns: 'behavior-enhancer', value: { disciplineInject: { enabled: true, everyHours: 0.00001 } } }] },
    })
    createDisciplineInjectModule(ctx2, { ...baseCfg, skipUnchanged: false }, createStats(),
      { createUserMessage: fakeCreateUserMessage, now: () => fakeNow, stateFile: sf })
    const agent2 = mkAgent()
    fakeNow += 1000 // 1 秒 ≫ 0.00001 小时(36ms)
    await ctx2.emit('agent/turn-stopping', { agent: agent2 })
    check('di 面板改小时数立即生效(读活设置)', agent1.steered.length === 1 && agent2.steered.length === 1)
  }

  rmSync(tmpBase, { recursive: true, force: true })
}

console.log('== client 入口(P3-a 加载探针) ==')
{
  let captured = null
  globalThis.window = { __ModuleLoader__: { load: (spec) => { captured = spec } } }
  await import(new URL('../src/client.js', import.meta.url).href)
  check('client 调用 __ModuleLoader__.load 且 id 正确',
    !!captured && captured.id === '@zoria-lind/dsh-behavior-enhancer')
  const fakeReact = {
    createElement: (...args) => ({ type: 'el', args }),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useState: (init) => [init, () => {}],
    useEffect: (fn) => { fn() },
  }
  const mod = captured.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error('unexpected require ' + name)
  })
  check('client 导出 apply/inject', typeof mod.apply === 'function' && Array.isArray(mod.inject))
  const regs = []
  let slotName = ''
  const fakeForm = {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: 'ready', value: { disciplineInject: { enabled: true, everyHours: 5 } }, writable: true }),
    mutate: () => Promise.resolve(true),
  }
  const ctx = {
    slots: {
      inject: (name, cb) => { slotName = name; cb() },
      register: (opts, comp) => { regs.push({ opts, comp }); return () => {} },
    },
    configForms: { get: () => fakeForm },
  }
  mod.apply(ctx)
  check('client 注册进 settings.general.item 槽',
    slotName === 'settings.general.item' && regs.length === 1 && regs[0].opts.name === 'settings.general.item')
  check('client 行组件可渲染', typeof regs[0].comp === 'function' && !!regs[0].comp())
  delete globalThis.window
}

console.log('== writeDiffVerify(B7) ==')
{
  const execGit = (repo, args) => new Promise((res, rej) => {
    execFile('git', args, { cwd: repo, windowsHide: true }, (e, so, se) => (e ? rej(new Error(String(se))) : res(String(so))))
  })
  const repo = mkdtempSync(join(tmpdir(), 'beh-wdv-'))
  await execGit(repo, ['init'])
  await execGit(repo, ['config', 'user.email', 't@t.local'])
  await execGit(repo, ['config', 'user.name', 't'])
  writeFileSync(join(repo, 'tracked.txt'), 'v1', 'utf8')
  await execGit(repo, ['add', '.'])
  await execGit(repo, ['commit', '-m', 'init', '--no-gpg-sign'])
  // 命令执行前就存在的改动(不该出现在本次报告中——前后差集的核心判据)
  writeFileSync(join(repo, 'pre-existing.txt'), 'dirty before command', 'utf8')

  // 1) pwsh 删除已跟踪文件 → content 出现 ⚠ D,且只报本次新增
  {
    const ctx = makeFakeCtx()
    const stats = createStats()
    createWriteDiffVerifyModule(ctx, resolveConfig({}).writeDiffVerify, stats)
    const exec = { name: 'pwsh', callId: 'c1', arguments: { command: 'Remove-Item tracked.txt', workdir: repo }, agent: { id: 'a1', session: { header: { cwd: repo } } } }
    await ctx.emit('tools/execute', exec, async () => ({ isError: false, value: { exitCode: 0 } })) // 记基线(execute 阶段,审批链已过)
    rmSync(join(repo, 'tracked.txt'))                                          // 命令效果:删除
    const d = await ctx.emit('tools/post-execute', exec,
      { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'done' }] },
      async () => ({ kind: 'accept', content: [{ type: 'text', text: 'done' }] }))
    const texts = d.content.map((b) => b.text).join('\n')
    check('B7:pwsh 删除文件 → content 出现 ⚠ D', /⚠\s*D\s+tracked\.txt/.test(texts))
    check('B7:只报本次新增(命令前的改动不出现)', !texts.includes('pre-existing.txt'))
    check('B7:原 content 保留(基线重建不丢)', d.content[0].text === 'done')
    check('B7:notices 计数', stats.snapshot().counters['writeDiffVerify.notices'] === 1)
  }
  // 2) 层序:默认注册的"模拟 outputLadder"(用 result.content 重建)在内层,本插件 prepend 在外层
  {
    const ctx2 = makeFakeCtx()
    const outerLikeLadder = async (exec, result, next) => {
      const decision = await next()
      if (decision?.kind !== 'accept') return decision
      return { kind: 'accept', content: [...(result.content ?? []), { type: 'text', text: '[outer-rebuild]' }] }
    }
    ctx2.on('tools/post-execute', outerLikeLadder) // 默认注册(内层)
    createWriteDiffVerifyModule(ctx2, resolveConfig({}).writeDiffVerify, createStats()) // prepend(外层)
    const e = { name: 'write', callId: 'c2', arguments: { file_path: 'x' }, agent: { id: 'a2', session: { header: { cwd: repo } } } }
    const result = { isError: false, value: { before: null, path: 'x' }, content: [{ type: 'text', text: 'orig' }], meta: { diffs: [] } }
    const d = await ctx2.emit('tools/post-execute', e, result, async () => ({ kind: 'accept', content: result.content }))
    const joined = d.content.map((b) => b.text).join('|')
    check('B7:prepend 上浮 → 外层重建后本插件 diff 仍在', joined.includes('orig') && joined.includes('[write-new]') && joined.includes('[outer-rebuild]'))
  }
  // 3) subagent(exec.parent !== undefined)→ 优雅跳过
  {
    const ctx3 = makeFakeCtx()
    createWriteDiffVerifyModule(ctx3, resolveConfig({}).writeDiffVerify, createStats())
    const e = { name: 'write', parent: { token: 1 }, callId: 'c3', arguments: { file_path: 'y' }, agent: { id: 'a3', session: { header: { cwd: repo } } } }
    const result = { isError: false, value: { before: null, path: 'y' }, content: [{ type: 'text', text: 'orig' }] }
    const d = await ctx3.emit('tools/post-execute', e, result, async () => ({ kind: 'accept', content: result.content }))
    check('B7:subagent 优雅跳过不抛错', d.content.length === 1 && d.content[0].text === 'orig')
  }
  // 4) 非 git 目录 → 不追加、不报错
  {
    const nonGit = mkdtempSync(join(tmpdir(), 'beh-wdv-nogit-'))
    const ctx4 = makeFakeCtx()
    createWriteDiffVerifyModule(ctx4, resolveConfig({}).writeDiffVerify, createStats())
    const e = { name: 'pwsh', callId: 'c4', arguments: { command: 'ls', workdir: nonGit }, agent: { id: 'a4', session: { header: { cwd: nonGit } } } }
    await ctx4.emit('tools/execute', e, async () => ({ isError: false, value: { exitCode: 0 } }))
    const d = await ctx4.emit('tools/post-execute', e, { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'out' }] }, async () => ({ kind: 'accept', content: [{ type: 'text', text: 'out' }] }))
    check('B7:非 git 目录不追加不报错', d.content.length === 1 && d.content[0].text === 'out')
    rmSync(nonGit, { recursive: true, force: true })
  }
  // 5) enabled:false → 完全不介入(未注册任何 listener)
  {
    const ctx5 = makeFakeCtx()
    createWriteDiffVerifyModule(ctx5, { ...resolveConfig({}).writeDiffVerify, enabled: false }, createStats())
    let threw = false
    try { await ctx5.emit('tools/post-execute', { name: 'write' }, {}, async () => ({ kind: 'accept', content: [] })) } catch { threw = true }
    check('B7:enabled=false 完全不介入', threw)
  }

  rmSync(repo, { recursive: true, force: true })
}

console.log('== writeDiffVerify:git 根解析(2026-09-14 修复) ==')
{
  const outer = mkdtempSync(join(tmpdir(), 'beh-gr-'))
  const repo = join(outer, 'sub', 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, 'src'), { recursive: true })

  check('绝对路径(引号)→ 找到 .git 根', findGitRootsFromCommand(`Remove-Item '${join(repo, 'b.txt')}' -Force`).includes(repo))
  check('深层文件路径 → 向上走到仓库根', findGitRootsFromCommand(`Get-Content "${join(repo, 'src', 'x.txt')}"`).includes(repo))
  check('同一仓库多路径 → 去重为单个根', findGitRootsFromCommand(`Copy-Item '${join(repo, 'a')}' '${join(repo, 'src', 'b')}'`).length === 1)
  check('无路径命令 → 空', findGitRootsFromCommand('Get-Location').length === 0)
  check('仓库外路径 → 空', findGitRootsFromCommand(`Remove-Item '${join(outer, 'notrepo', 'f.txt')}'`).length === 0)

  rmSync(outer, { recursive: true, force: true })
}

console.log('== hardGate(B3) ==')
{
  const cmd = (text) => ({ name: 'pwsh', arguments: { command: text } })
  const read = { name: 'read', arguments: { path: 'x' } }

  // ① 连续 deny 达阈值后确实降级为 allow(软闸门逃生)
  {
    const ctx = makeFakeCtx()
    const stats = createStats()
    createHardGateModule(ctx, { ...resolveConfig({}).hardGate, highRiskMode: 'deny' }, stats)
    const decisions = []
    for (let i = 0; i < 5; i++) {
      decisions.push(await ctx.emit('tools/pre-execute', cmd('Remove-Item C:\\x -Recurse -Force'), async () => ({ kind: 'allow' })))
    }
    check('B3:前 3 次返回合法 deny', decisions.slice(0, 3).every((d) => d?.kind === 'deny' && typeof d.reason === 'string' && d.reason.length > 0))
    check('B3:第 4 次起逃生为 allow', decisions[3]?.kind === 'allow' && decisions[4]?.kind === 'allow')
    check('B3:denied/escape 计数', stats.snapshot().counters['hardGate.denied'] === 3 && stats.snapshot().counters['hardGate.escape'] === 2)
  }
  // ② ask 形状合法(无审批服务时内核把它降级为 deny——kernel 侧契约 07 §A,插件侧只保证形状)
  {
    const ctx = makeFakeCtx()
    createHardGateModule(ctx, resolveConfig({}).hardGate, createStats())
    const d = await ctx.emit('tools/pre-execute', cmd('rm -rf /tmp/x'), async () => ({ kind: 'allow' }))
    check('B3:ask 模式返回合法 ask 决策(reason 非空)', d?.kind === 'ask' && typeof d.reason === 'string' && d.reason.length > 0)
  }
  // ③ 所有分支都返回合法 decision(不出现 undefined)
  {
    const ctx = makeFakeCtx()
    createHardGateModule(ctx, resolveConfig({}).hardGate, createStats())
    const d1 = await ctx.emit('tools/pre-execute', read, async () => ({ kind: 'allow' }))      // 非 pwsh
    const d2 = await ctx.emit('tools/pre-execute', cmd('Get-ChildItem'), async () => ({ kind: 'allow' })) // 不命中
    check('B3:放行分支全部显式 return', d1?.kind === 'allow' && d2?.kind === 'allow')
  }
}

console.log('== verifyLoop(B4) ==')
{
  const fakeCreateUserMessage = (input) => ({ role: 'user', content: input.content, source: input.source })
  const steered = []
  const agent = { id: 'a1', session: {}, steer: (m) => steered.push(m) }
  const ctx = makeFakeCtx()
  const stats = createStats()
  createVerifyLoopModule(ctx, resolveConfig({}).verifyLoop, stats, { createUserMessage: fakeCreateUserMessage })

  const writePost = async (name = 'write') => ctx.emit('tools/post-execute',
    { name, agent, arguments: {} },
    { isError: false, value: {}, content: [] },
    async () => ({ kind: 'accept', content: [] }))
  const verifyPost = async (exitCode) => ctx.emit('tools/post-execute',
    { name: 'pwsh', agent, arguments: { command: 'npm test' } },
    { isError: false, value: { exitCode }, content: [] },
    async () => ({ kind: 'accept', content: [] }))
  const turnStop = () => ctx.emit('agent/turn-stopping', { agent, turn: 1 }) // 无终止 next:emit 兼容无函数尾参

  // 无写入 → 不提醒
  await turnStop()
  check('B4:无写入不提醒', steered.length === 0)
  // 写入 → 提醒一次,内容为 UserMessage 形状
  await writePost()
  await turnStop()
  check('B4:改文件无证据 → 提醒一次', steered.length === 1)
  check('B4:steer 参数为 UserMessage 形状(plugin source)', steered[0]?.source?.kind === 'plugin:behavior-enhancer' && Array.isArray(steered[0].content))
  // 第二轮 → 不再提醒(单轮上限 1 次,防死循环)
  await turnStop()
  check('B4:第二轮不再提醒', steered.length === 1)
  // 有成功验证证据 → 不再提醒;随后再写 → 又提醒一次
  await verifyPost(0)
  await turnStop()
  check('B4:有验证证据不提醒', steered.length === 1)
  await writePost()
  await turnStop()
  check('B4:再次写入再次提醒', steered.length === 2)
  // 验证命令失败退出 ≠ 证据
  await writePost()
  await verifyPost(1)
  await turnStop()
  check('B4:验证命令失败不算证据,仍提醒', steered.length === 3)
  check('B4:nudged/verified 计数', stats.snapshot().counters['verifyLoop.nudged'] === 3 && stats.snapshot().counters['verifyLoop.verified'] === 1)
}

console.log('== compliance(B5) ==')
{
  const stateFile = join(tmpdir(), 'beh-stats-' + Math.random().toString(36).slice(2) + '.json')
  const registered = []
  const ctx = makeFakeCtx({ commands: { register: (def) => { registered.push(def); return () => { const i = registered.indexOf(def); if (i >= 0) registered.splice(i, 1) } } } })
  const stats = createStats()
  stats.bump('hardGate.denied', 2)
  stats.bump('verifyLoop.nudged', 1)
  createComplianceModule(ctx, { ...resolveConfig({}).compliance, statsPath: stateFile }, stats)
  check('B5:/behavior-status 已注册', registered.length === 1 && registered[0].name === 'behavior-status')

  // session/flush → 落盘(totals = 累计);命令输出含两列数字
  await ctx.emit('session/flush', { session: {} })
  check('B5:flush 后 stats.json 落盘', existsSync(stateFile))
  const persisted = JSON.parse(readFileSync(stateFile, 'utf8'))
  check('B5:落盘内容含 totals', persisted?.totals?.['hardGate.denied'] === 2 && persisted?.totals?.['verifyLoop.nudged'] === 1)

  const out = await registered[0].handler({})
  check('B5:命令返回 success 且含两列数字(本会话/累计)', out.kind === 'success' && /hardGate\.denied \| 2 \| 2/.test(out.text))

  // 第二个实例(模拟重启):从文件载入 totals,新会话计数并入
  const stats2 = createStats()
  stats2.bump('hardGate.denied', 1)
  const ctx2 = makeFakeCtx({ commands: { register: (def) => { registered.push(def); return () => {} } } })
  createComplianceModule(ctx2, { ...resolveConfig({}).compliance, statsPath: stateFile }, stats2)
  await ctx2.emit('session/flush', { session: {} })
  const persisted2 = JSON.parse(readFileSync(stateFile, 'utf8'))
  check('B5:跨会话累计(2+1=3)', persisted2?.totals?.['hardGate.denied'] === 3)
  rmSync(stateFile, { recursive: true, force: true })
}

console.log('')
if (failures === 0) {
  console.log('ALL CHECKS PASSED')
  process.exit(0)
} else {
  console.error(`${failures} CHECK(S) FAILED`)
  process.exit(1)
}
