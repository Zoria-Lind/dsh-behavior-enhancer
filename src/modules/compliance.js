// dsh-behavior-enhancer v1.2(B5):遵守度统计——把 stats 死代码救活并落盘。
// 落点必须是 session/flush(dsh-session/lib/types/index.d.ts:409:并行持久性屏障,
// 调用方 await 全部、无 veto;@throws 第一个 listener 失败,方法本体 :411)。
// 🚨 写盘必须整体 try/catch 并只 log:listener 内的写盘异常会被升级为"会话持久化
// 检查点失败",绝不能让统计数据拖垮会话。
// 不要放 session/event(post-commit、非持久屏障)、更不要放 tools/result(emit-only,
// 失败被吞)。Session 实例上没有 flush()——落盘唯一入口是 ctx.sessions.flush(session)。
//
// 统计口径:本次插件运行的实时计数来自 stats(内存);历史累计 totals 只反映已落盘数据。
// 启动时读取历史,session/flush 只保存上次成功落盘之后的新增计数。

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

function expandHome(p) {
  if (typeof p !== 'string' || p.length === 0) return p
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

export function createComplianceModule(ctx, config, stats, deps = {}) {
  if (!config?.enabled) return () => {}
  if (!ctx || typeof ctx.on !== 'function') return () => {}

  const file = expandHome(deps.stateFile ?? config.statsPath)

  function loadTotals() {
    try {
      if (!existsSync(file)) return {}
      const data = JSON.parse(readFileSync(file, 'utf8'))
      return data && typeof data === 'object' && typeof data.totals === 'object' ? data.totals : {}
    } catch (err) {
      console.warn(`[dsh-behavior-enhancer] 统计文件读取失败(${err?.message ?? err}),从零开始累计`)
      return {}
    }
  }

  let totals = loadTotals()
  let persistedCounters = {}

  function persistTotals(nextTotals) {
    const payload = { version: 1, updatedAt: new Date().toISOString(), totals: nextTotals }
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
      renameSync(tmp, file)
      return true
    } catch (err) {
      try { unlinkSync(tmp) } catch { /* 忽略 */ }
      console.warn(`[dsh-behavior-enhancer] 统计落盘失败(${err?.message ?? err})`) // 只 log:不能拖垮会话持久化
      return false
    }
  }

  // 同步保存增量;只有原子替换成功才推进总量与检查点,失败可安全重试。
  const onFlush = async () => {
    try {
      const { counters } = stats.snapshot()
      const nextTotals = { ...totals }
      for (const [k, v] of Object.entries(counters)) {
        nextTotals[k] = (totals[k] ?? 0) + v - (persistedCounters[k] ?? 0)
      }
      if (persistTotals(nextTotals)) {
        totals = nextTotals
        persistedCounters = { ...counters }
      }
    } catch (err) {
      console.warn(`[dsh-behavior-enhancer] session/flush 统计处理失败(${err?.message ?? err})`)
    }
  }
  ctx.on?.('session/flush', onFlush)

  // /behavior-status(P6 姿势):输出本次插件运行计数 + 已落盘的历史累计
  const disposers = []
  ctx.inject?.(['commands'], (cmdCtx) => {
    try {
      disposers.push(cmdCtx.commands.register({
        name: 'behavior-status',
        description: '查看 dsh-behavior-enhancer 行为遵守度统计(本次运行 / 历史累计)',
        handler: () => {
          try {
            const { counters } = stats.snapshot()
            const keys = new Set([...Object.keys(counters), ...Object.keys(totals)])
            if (keys.size === 0) return { kind: 'success', text: '[behavior-enhancer] 暂无统计记录(本次运行还没有工具调用/拦截/提醒事件)。' }
            const lines = ['[behavior-enhancer] 遵守度统计', '指标 | 本次运行 | 历史累计']
            for (const k of [...keys].sort()) {
              lines.push(`${k} | ${counters[k] ?? 0} | ${totals[k] ?? 0}`)
            }
            return { kind: 'success', text: lines.join('\n') }
          } catch (err) {
            return { kind: 'error', text: `behavior-status 失败:${err?.message ?? err}` }
          }
        },
      }))
    } catch (err) {
      console.warn(`[dsh-behavior-enhancer] /behavior-status 注册失败(${err?.message ?? err})`)
    }
  })

  return () => {
    for (const dispose of disposers) {
      try { dispose?.() } catch { /* noop */ }
    }
    try { ctx.off?.('session/flush', onFlush) } catch { /* noop */ }
  }
}
