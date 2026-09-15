// 纪律预设(B2):preset 名 → 条目数组。default 保持旧版语义(去掉内核已强制的两条)。
import { DISCIPLINE_ENTRIES, STRICT_EXTRA_ENTRIES } from './entries.js'

export const DISCIPLINE_PRESETS = {
  default: DISCIPLINE_ENTRIES,
  strict: [...DISCIPLINE_ENTRIES, ...STRICT_EXTRA_ENTRIES],
}

export function resolvePreset(name) {
  const preset = DISCIPLINE_PRESETS[String(name ?? '')]
  return Array.isArray(preset) ? preset : null // 未知 preset → null(调用方告警回退 default)
}
