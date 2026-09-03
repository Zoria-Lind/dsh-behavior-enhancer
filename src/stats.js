// 轻量统计:记录各模块处理次数,会话结束时输出报告(与 token-optimizer 同款)。

export function createStats() {
  const counters = new Map()
  const samples = []

  function bump(key, delta = 1) {
    counters.set(key, (counters.get(key) ?? 0) + delta)
  }

  function addSample(entry) {
    samples.push(entry)
    if (samples.length > 1000) samples.shift()
  }

  function snapshot() {
    return {
      counters: Object.fromEntries(counters),
      samples: [...samples],
    }
  }

  return {
    bump,
    addSample,
    snapshot,
    dispose() {
      counters.clear()
      samples.length = 0
    },
  }
}
