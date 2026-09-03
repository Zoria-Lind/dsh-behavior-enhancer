import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { detectFailure } from './failureDetect.js'

// 并行收敛(parallelConvergence):在失败与上下文压力时动态降低工具并行度,
// 恢复条件满足后还原用户配置。
//
// 机制(核心源码核实):
//   - DSH 并行 = 工具定义 isConcurrencySafe 分类(仅 read/read_image 并行,
//     edit/write/pwsh 等天然 exclusive 屏障)+ 池上限 maxParallelToolCalls
//     (默认 10,settings 命名空间 agent-loop,活 getter,运行时 update 即生效)
//   - 插件唯一动态杠杆 = 池上限;失败降 1 让模型逐步修正,避免"基于错误前提
//     的批量调用"继续并行消耗
//   - settings 服务经 ctx.inject 访问(可选服务正道);记住用户原值,
//     session/disposed 或恢复条件满足时还原,只还原本插件改过的值
//   - 压力降档在 agent/status idle 时测量(与 compactionDriver 同款
//     request/context 事件读窗口),滞回 90% 防抖动

export function createParallelConvergenceModule(ctx, config, stats, deps = {}) {
  if (!config?.enabled) return () => {}
  if (!ctx || typeof ctx.on !== 'function') return () => {}

  // 跨 boot 状态文件:串行化时落盘,还原时清除。修复"上一个实例串行化后
  // 进程重启,新实例 serialized=false 永不还原陈旧 maxParallelToolCalls=1"的 bug
  const stateFile = deps.stateFile ?? join(homedir(), '.dsh', 'behavior-enhancer', 'state.json')
  function loadState() {
    try { return JSON.parse(readFileSync(stateFile, 'utf8')) } catch { return null }
  }
  function saveState(state) {
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(stateFile, JSON.stringify(state), 'utf8')
    } catch { /* 落盘失败不致命 */ }
  }
  function clearState() {
    try { unlinkSync(stateFile) } catch { /* 不存在 */ }
  }

  let settingsProvider
  let tokenMeter
  let originalParallel = undefined // 首次改动前读到的用户值
  let serialized = false
  let pressureMode = false
  let successStreak = 0
  let warned = false

  try {
    ctx.inject?.(['settings'], (sctx) => {
      settingsProvider = sctx.settings
      // 启动接管:上次 boot 串行化后没还原(进程被杀/会话未结束)→ 还原
      const stale = loadState()
      if (stale?.serialized && typeof stale.originalParallel === 'number') {
        const current = readCurrent()
        if (current === 1) {
          setParallel(stale.originalParallel)
          console.log(`[dsh-behavior-enhancer] 接管上次未还原的串行状态:maxParallelToolCalls 已还原为 ${stale.originalParallel}`)
        }
        clearState()
      }
    })
    ctx.inject?.(['tokenMeter'], (sctx) => {
      tokenMeter = sctx.tokenMeter
    })
  } catch { /* inject 不可用:全部降级 */ }

  function readCurrent() {
    try {
      const v = settingsProvider?.get?.('agent-loop')?.maxParallelToolCalls
      return typeof v === 'number' && v >= 1 ? v : config.defaultParallel
    } catch {
      return config.defaultParallel
    }
  }

  function setParallel(value) {
    const p = settingsProvider
    if (!p || typeof p.update !== 'function') {
      if (!warned) {
        warned = true
        console.warn('[dsh-behavior-enhancer] settings 服务不可用,并行收敛降级为纯计数(不实际改并行度)')
      }
      return
    }
    try {
      p.update('agent-loop', { maxParallelToolCalls: value }).catch(() => {})
    } catch (err) {
      if (!warned) {
        warned = true
        console.warn(`[dsh-behavior-enhancer] settings.update 失败:${err?.message ?? err}`)
      }
    }
  }

  function serialize() {
    if (serialized) {
      successStreak = 0
      return
    }
    if (originalParallel === undefined) originalParallel = readCurrent()
    serialized = true
    pressureMode = false
    successStreak = 0
    stats?.bump('behavior.serialized', 1)
    console.log('[dsh-behavior-enhancer] 检测到工具失败,并行池上限压到 1(连续 ' + config.recoveryThreshold + ' 次成功后恢复)')
    saveState({ serialized: true, originalParallel })
    setParallel(1)
  }

  function restore() {
    if (!serialized && !pressureMode) return
    if (originalParallel !== undefined) setParallel(originalParallel)
    serialized = false
    pressureMode = false
    successStreak = 0
    clearState()
    stats?.bump('behavior.restored', 1)
    console.log('[dsh-behavior-enhancer] 并行度已恢复')
  }

  // 工具结果:失败(含命令级失败签名)→ 串行;连续 recoveryThreshold 次成功 → 恢复
  const onResult = (_exec, result) => {
    if (detectFailure(result, config)) {
      serialize()
    } else {
      successStreak += 1
      if (serialized && successStreak >= config.recoveryThreshold) restore()
    }
  }

  // idle 时测上下文压力:超 complexRatio → 降到 minParallel;滞回恢复
  const onStatus = (payload) => {
    const agent = payload?.agent
    if (!agent || payload?.status !== 'idle') return
    const session = agent.session
    if (!session || !tokenMeter || typeof tokenMeter.measure !== 'function') return
    let totalTokens
    try {
      totalTokens = tokenMeter.measure(session)?.totalTokens
    } catch {
      return
    }
    if (typeof totalTokens !== 'number') return

    let window = config.contextWindowFallback
    const events = session.events
    if (Array.isArray(events)) {
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (e?.type === 'request/context' && typeof e?.data?.contextWindow === 'number') {
          window = e.data.contextWindow
          break
        }
      }
    }
    const pressure = window > 0 ? totalTokens / window : 0
    if (pressure >= config.complexRatio) {
      if (!pressureMode) {
        pressureMode = true
        if (originalParallel === undefined) originalParallel = readCurrent()
        stats?.bump('behavior.pressureDown', 1)
        setParallel(config.minParallel)
      }
    } else if (pressureMode && pressure < config.complexRatio * 0.9) {
      restore() // 滞回:低于阈值 90% 才恢复,避免边界抖动
    }
  }

  const onDisposed = () => restore()

  ctx.on('tools/result', onResult)
  ctx.on('agent/status', onStatus)
  ctx.on('session/disposed', onDisposed)

  return () => {
    ctx.off('tools/result', onResult)
    ctx.off('agent/status', onStatus)
    ctx.off('session/disposed', onDisposed)
  }
}
