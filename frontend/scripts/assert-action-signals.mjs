import assert from 'node:assert/strict'
import { ACTION_SIGNAL_WARMUP_BARS, buildActionSignals, compareActionSignals } from '../src/lib/actionSignals.ts'

function barDate(index) {
  const date = new Date(Date.UTC(2026, 0, 1 + index))
  return date.toISOString().slice(0, 10)
}

function makeBars(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.1
    return {
      date: barDate(index),
      open: close - 0.05,
      high: close + 0.1,
      low: close - 0.1,
      close,
      volume: 100,
      atr14: 0.1,
      isClosed: true,
      ...overrides[index],
    }
  })
}

function scoreRows(bars, overrides = {}) {
  return {
    version: 'technical-score-v2',
    rows: bars.map((bar, index) => ({
      as_of: bar.date,
      direction_score: overrides[index]?.direction_score ?? 70,
      confidence: 80,
      coverage: 100,
      trend: overrides[index]?.trend ?? 70,
      momentum: overrides[index]?.momentum ?? 70,
      volume_price: overrides[index]?.volume_price ?? 70,
      volatility_risk: 20,
      activity: 60,
      available: overrides[index]?.available ?? true,
    })),
  }
}

const bars = makeBars(66, {
  60: { close: 106.5, high: 106.7, volume: 130 },
  61: { close: 107.5, high: 107.7, volume: 140 },
  62: { close: 107.3, high: 107.4, volume: 90 },
  63: { close: 107.1, high: 107.2, volume: 90 },
  64: { close: 99, high: 99.1, low: 98.8, volume: 90 },
  65: { close: 98.5, high: 98.7, low: 98.3, volume: 90 },
})
const scores = scoreRows(bars, {
  62: { direction_score: 35, trend: 35, momentum: 35, volume_price: 35 },
  63: { direction_score: 35, trend: 35, momentum: 35, volume_price: 35 },
  64: { direction_score: 35, trend: 35, momentum: 35, volume_price: 35 },
  65: { direction_score: 35, trend: 35, momentum: 35, volume_price: 35 },
})

const result = buildActionSignals({ period: '1d', rows: bars, technicalScores: scores })
assert.equal(result.version, 'action-signal-v1')
assert.ok(result.events.some(event => event.type === 'attack'), '突破应生成进攻事件')
assert.ok(result.events.some(event => event.type === 'add'), '新的突破应生成加仓事件')
assert.ok(result.events.some(event => event.type === 'reduce'), '连续弱评分应生成减仓事件')
assert.ok(result.events.some(event => event.type === 'retreat'), '跌破核心防守位应生成撤退事件')
assert.equal(result.current.action, 'wait_defensive', '弱势撤退后应回到等待·偏防守')
assert.deepEqual(result.events.map(event => event.type), ['attack', 'add', 'reduce', 'retreat'])
assert.equal(new Set(result.events.map(event => event.id)).size, result.events.length, '同一事件不得重复绘制')

const prefix = buildActionSignals({ period: '1d', rows: bars.slice(0, 62), technicalScores: { ...scores, rows: scores.rows.slice(0, 62) } })
assert.deepEqual(
  prefix.events.map(event => event.id),
  result.events.filter(event => event.date <= bars[61].date).map(event => event.id),
  '追加未来K线不得改变此前已确认事件',
)

const provisional = buildActionSignals({
  period: '1d',
  rows: bars.map((bar, index) => index === bars.length - 1 ? { ...bar, isClosed: false } : bar),
  technicalScores: scores,
})
assert.equal(provisional.status, 'provisional')
assert.equal(provisional.pendingConfirmation, true)

const insufficient = buildActionSignals({
  period: '30m',
  rows: bars.slice(0, ACTION_SIGNAL_WARMUP_BARS - 1),
  technicalScores: { ...scores, rows: scores.rows.slice(0, ACTION_SIGNAL_WARMUP_BARS - 1) },
})
assert.equal(insufficient.status, 'blocked')

const stale = buildActionSignals({ period: '1d', rows: bars, technicalScores: scores, dataStatus: { stale: true } })
assert.equal(stale.status, 'stale')
assert.equal(stale.reason, '当前为过期快照，不确认新的行动信号。')

const enrichedFallback = buildActionSignals({
  period: '1d', rows: bars, technicalScores: scores,
  dataStatus: { stale: true }, dataSource: 'enriched',
})
assert.equal(enrichedFallback.status, 'ready', '本地 enriched 回退数据可用于确认已闭合行动信号')
assert.equal(enrichedFallback.events.length, result.events.length)

const noVolume = makeBars(66, {
  60: { close: 106.5, high: 106.7, volume: 0 },
  61: { close: 107.5, high: 107.7, volume: 0 },
})
const noVolumeResult = buildActionSignals({ period: '1d', rows: noVolume, technicalScores: scoreRows(noVolume) })
assert.equal(noVolumeResult.events.length, 0, '零成交量不得确认突破行动')

const missingScoreRows = scoreRows(bars, { 60: { available: false }, 61: { available: false } })
const missingScoreResult = buildActionSignals({ period: '1d', rows: bars, technicalScores: missingScoreRows })
assert.equal(missingScoreResult.events.length, 0, '指标缺失时不得确认进攻或加仓')

const pullbackBars = makeBars(66, {
  60: { close: 106.5, high: 106.7, volume: 130 },
  61: { close: 107.5, high: 107.7, volume: 140 },
  62: { close: 106.75, high: 107.0, low: 106.68, volume: 90 },
  63: { close: 107.2, high: 107.3, low: 107.1, volume: 90 },
})
const pullbackScores = scoreRows(pullbackBars, {
  61: { direction_score: 50 },
})
const pullbackResult = buildActionSignals({ period: '1d', rows: pullbackBars, technicalScores: pullbackScores })
const pullbackEvent = pullbackResult.events.find(event => event.type === 'add' && event.trigger === 'pullback')
assert.ok(pullbackEvent, '回踩确认应生成加仓事件')
assert.equal(pullbackEvent.structureMode, 'price_event')
assert.equal(pullbackEvent.referencePrice, 106.7)

const aligned = compareActionSignals({ ...result, current: { ...result.current, action: 'wait' } }, { ...result, period: '30m', current: { ...result.current, action: 'wait' } })
assert.equal(aligned.status, 'aligned')
const divergent = compareActionSignals(result, { ...result, period: '30m', current: { ...result.current, action: 'attack' } })
assert.equal(divergent.status, 'divergent')

console.log('action signal assertions passed')
