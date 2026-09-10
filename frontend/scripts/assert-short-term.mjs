import assert from 'node:assert/strict'
import { ACTION_SIGNAL_WARMUP_BARS, buildActionSignals } from '../src/lib/actionSignals.ts'

function barDate(index) {
  const date = new Date(Date.UTC(2026, 0, 1 + index))
  return date.toISOString().slice(0, 10)
}

function makeBars(count) {
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
    }
  })
}

function shortRows(bars) {
  return bars.map(bar => ({
    as_of: bar.date,
    total: 80,
    action: '建议买入',
    hold_advice: '可逢低介入，设好止盈止损',
    trend: 1,
    coverage: 1,
    available: true,
    dimensions: [
      { id: 'ma_trend', name: 'MA趋势', score: 6, weight: 10, detail: '上升趋势' },
      { id: 'momentum', name: '短期动量', score: 4, weight: 10, detail: '动量向上' },
      { id: 'volume_price', name: '量价配合', score: 2, weight: 7, detail: '量价同步' },
    ],
    indicators: {},
  }))
}

const bars = makeBars(ACTION_SIGNAL_WARMUP_BARS)
const analysis = {
  version: 'short-term-score-v1',
  period: '1d',
  bar_semantics: 'native-bars',
  rows: shortRows(bars),
  zones: { support: [], resistance: [] },
  signals: {},
  as_of: bars.at(-1).date,
  limitations: [],
}
const result = buildActionSignals({ period: '1d', rows: bars, shortTermAnalysis: analysis })

assert.equal(result.status, 'ready')
assert.equal(result.current.score?.source, 'short-term-score-v1')
assert.equal(result.current.score?.direction, 80)
assert.equal(result.current.score?.trend, 80)
assert.equal(result.current.score?.momentum, 70)
assert.equal(result.current.score?.volumePrice, 60)
assert.ok(result.nextConditions.some(item => item.includes('78')))
assert.equal(result.events.some(event => event.score.source === 'technical-score-v2'), false)

console.log('short-term frontend assertions passed')
