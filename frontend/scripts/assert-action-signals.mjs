import assert from 'node:assert/strict'
import { ACTION_SIGNAL_WARMUP_BARS, ACTION_SIGNAL_VERSION, actionSignalMarkers, buildActionSignals, compareActionSignals } from '../src/lib/actionSignals.ts'

function barDate(index, period) {
  const date = new Date(Date.UTC(2026, 0, 1, period === '30m' ? 9 : 0, period === '30m' ? 30 : 0))
  if (period === '30m') date.setUTCMinutes(date.getUTCMinutes() + index * 30)
  else date.setUTCDate(date.getUTCDate() + index)
  return period === '30m' ? date.toISOString().slice(0, 16).replace('T', ' ') : date.toISOString().slice(0, 10)
}

function makeScenario(period = '1d', count = 75) {
  const overrides = {
    55: { close: 99.0, open: 99.3, high: 99.6, low: 98.8, rsi_14: 31, macd_hist: -0.4, atr14: 0.5, ma20: 100 },
    56: { close: 98.5, open: 99.0, high: 99.2, low: 98.2, rsi_14: 26, macd_hist: -0.8, atr14: 0.5, ma20: 100 },
    57: { close: 98.8, open: 98.5, high: 99.1, low: 98.6, rsi_14: 27, macd_hist: -0.7, atr14: 0.5, ma20: 100 },
    58: { close: 99.4, open: 98.8, high: 99.8, low: 99.2, rsi_14: 30, macd_hist: -0.5, atr14: 0.5, ma20: 100 },
    59: { close: 99.8, open: 99.4, high: 100.1, low: 99.5, rsi_14: 34, macd_hist: -0.4, atr14: 0.5, ma20: 100 },
    60: { close: 99.3, open: 99.7, high: 99.9, low: 99.0, rsi_14: 32, macd_hist: -0.6, atr14: 0.5, ma20: 100 },
    61: { close: 99.4, open: 99.2, high: 100.0, low: 99.2, rsi_14: 34, macd_hist: -0.5, atr14: 0.5, ma20: 100 },
    62: { close: 99.9, open: 99.5, high: 100.1, low: 99.6, volume: 120, rsi_14: 37, macd_hist: -0.4, atr14: 0.5, ma20: 100 },
    63: { close: 100.0, open: 99.8, high: 100.5, low: 99.8, rsi_14: 40, macd_hist: -0.2, atr14: 0.8, ma20: 100.2 },
    64: { close: 100.3, open: 100.0, high: 100.8, low: 100.0, rsi_14: 44, macd_hist: 0.0, atr14: 0.8, ma20: 100.3 },
    65: { close: 100.5, open: 100.3, high: 101.0, low: 100.2, rsi_14: 48, macd_hist: 0.2, atr14: 0.8, ma20: 100.4 },
    66: { close: 100.7, open: 100.5, high: 101.2, low: 100.4, rsi_14: 51, macd_hist: 0.3, atr14: 0.8, ma20: 100.6 },
    67: { close: 101.5, open: 101.0, high: 101.8, low: 100.9, rsi_14: 58, macd_hist: 0.5, atr14: 0.8, ma20: 100.8 },
    68: { close: 102.2, open: 101.9, high: 102.6, low: 101.7, rsi_14: 70, macd_hist: 0.8, atr14: 0.8, ma20: 101.0 },
    69: { close: 103.0, open: 102.5, high: 103.5, low: 102.4, volume: 140, rsi_14: 74, macd_hist: 1.2, atr14: 0.8, ma20: 101.2 },
    70: { close: 102.6, open: 103.0, high: 103.0, low: 102.2, rsi_14: 70, macd_hist: 0.9, atr14: 0.8, ma20: 101.3 },
    71: { close: 102.0, open: 102.6, high: 102.8, low: 101.7, volume: 90, rsi_14: 64, macd_hist: 0.5, atr14: 0.8, ma20: 101.4 },
    72: { close: 98.5, open: 99.0, high: 99.2, low: 98.2, rsi_14: 30, macd_hist: -0.4, atr14: 0.8, ma20: 101.0 },
    73: { close: 98.1, open: 98.6, high: 98.8, low: 97.8, rsi_14: 27, macd_hist: -0.6, atr14: 0.8, ma20: 100.8 },
    74: { close: 98.3, open: 97.9, high: 98.7, low: 97.7, rsi_14: 29, macd_hist: -0.5, atr14: 0.8, ma20: 100.6 },
  }
  return Array.from({ length: count }, (_, index) => {
    const close = 100
    return {
      date: barDate(index, period),
      open: 99.8,
      high: index === 50 ? 103 : 100.8,
      low: 99.5,
      close,
      volume: 100,
      atr14: 0.8,
      ma20: 100,
      ma60: 100,
      boll_upper: 104,
      boll_lower: 96,
      rsi_14: 50,
      macd_hist: 0,
      isClosed: true,
      ...overrides[index],
    }
  })
}

function makeChaseBars(period = '1d') {
  return Array.from({ length: 70 }, (_, index) => {
    const close = 100 + index * 0.12
    return {
      date: barDate(index, period),
      open: close - 0.05,
      high: close + 0.2,
      low: close - 0.1,
      close,
      volume: 100,
      atr14: 0.5,
      ma20: close - 1.8,
      boll_upper: close + 0.1,
      boll_lower: close - 3,
      rsi_14: 74,
      macd_hist: 1,
      isClosed: true,
    }
  })
}

function makeLocationOnlyBars(period = '1d') {
  return Array.from({ length: 70 }, (_, index) => {
    const close = 100
    return {
      date: barDate(index, period),
      open: close - 0.05,
      high: close + 0.1,
      low: close - 0.1,
      close,
      volume: 100,
      atr14: 1,
      ma20: close + 1.2,
      boll_upper: close + 10,
      boll_lower: close - 10,
      rsi_14: 50,
      macd_hist: 0,
      isClosed: true,
    }
  })
}

function makeHighLocationOnlyBars(period = '1d') {
  return Array.from({ length: 70 }, (_, index) => {
    const close = 100
    return {
      date: barDate(index, period),
      open: close - 0.05,
      high: close + 0.1,
      low: close - 0.1,
      close,
      volume: 100,
      atr14: 1,
      ma20: close - 1.2,
      boll_upper: close + 10,
      boll_lower: close - 10,
      rsi_14: 50,
      macd_hist: 0,
      isClosed: true,
    }
  })
}

function makeHighWatchLifecycleBars(period = '1d', refresh = false) {
  const highBars = new Set(refresh ? [60, 86] : [60])
  const count = refresh ? 87 : 64
  return Array.from({ length: count }, (_, index) => {
    const highWatch = highBars.has(index)
    const close = highWatch ? 101.3 : 101.05
    return {
      date: barDate(index, period),
      open: highWatch ? 100.8 : 100.95,
      high: highWatch ? 101.4 : 101.15,
      low: highWatch ? 100.8 : 100.95,
      close,
      volume: 100,
      atr14: 1,
      ma20: highWatch ? 100 : 100.65,
      boll_upper: 105,
      boll_lower: 95,
      rsi_14: highWatch ? 68 : 50,
      macd_hist: 0,
      isClosed: true,
    }
  })
}

for (const assetType of ['stock', 'etf']) {
  for (const period of ['1d', '30m']) {
    const rows = makeScenario(period)
    const result = buildActionSignals({ assetType, period, rows })
    assert.equal(result.version, ACTION_SIGNAL_VERSION)
    assert.equal(result.status, 'ready')
    assert.deepEqual(result.events.map(event => event.type), ['attack', 'add', 'reduce', 'retreat'], `${assetType}/${period} 应走同一套五段式行动流程`)
    assert.deepEqual(actionSignalMarkers(result).map(marker => marker.label), ['试仓', '加仓', '减仓', '退出'])
    assert.equal(result.events[0].trigger, 'structure')
    assert.equal(result.events[1].trigger, 'neckline_break')
    assert.ok(result.events[0].reasons.some(reason => reason.includes('动能衰竭')))
    assert.ok(result.events[2].reasons.some(reason => reason.includes('ROC')))
    assert.equal(new Set(result.events.map(event => event.id)).size, result.events.length)

    const observation = buildActionSignals({ assetType, period, rows: rows.slice(0, 62) })
    assert.equal(observation.events.length, 0, `${assetType}/${period} 超跌阶段不能直接买入`)
    assert.equal(observation.current.action, 'bottom_observe')

    const beforeExit = buildActionSignals({ assetType, period, rows: rows.slice(0, 74) })
    assert.equal(beforeExit.events.at(-1)?.type, 'reduce', `${assetType}/${period} 第一次破防不能直接退出`)

    const topThenBottomRows = rows.map(bar => ({ ...bar }))
    topThenBottomRows[72] = {
      ...topThenBottomRows[72],
      close: 103,
      open: 102.5,
      high: 103.5,
      low: 102.4,
      ma20: 101.2,
      rsi_14: 74,
      macd_hist: 1.2,
    }
    const topThenBottom = buildActionSignals({ assetType, period, rows: topThenBottomRows.slice(0, 74) })
    assert.equal(topThenBottom.current.action, 'bottom_observe', `${assetType}/${period} 新的底部观察不能沿用旧的高位观察`)

    const prefix = buildActionSignals({ assetType, period, rows: rows.slice(0, 68) })
    assert.deepEqual(
      prefix.events.map(event => event.id),
      result.events.filter(event => event.date <= rows[67].date).map(event => event.id),
      `${assetType}/${period} 追加未来K线不得改写已确认事件`,
    )

    const provisional = buildActionSignals({
      assetType,
      period,
      rows: rows.map((bar, index) => index === rows.length - 1 ? { ...bar, isClosed: false } : bar),
    })
    assert.equal(provisional.status, 'provisional')
    assert.equal(provisional.pendingConfirmation, true)

    const stale = buildActionSignals({ assetType, period, rows, dataStatus: { stale: true } })
    assert.equal(stale.status, 'stale')
    assert.equal(stale.events.length, 0)
  }
}

for (const period of ['1d', '30m']) {
  const chase = buildActionSignals({ assetType: 'stock', period, rows: makeChaseBars(period) })
  assert.equal(chase.events.some(event => event.type === 'attack' || event.type === 'add'), false, `${period} 高位突破不得追涨`)
  assert.equal(chase.current.action, 'extreme_top_observe', `${period} 极端偏离只进入极端高位观察`)

  const locationOnly = buildActionSignals({ assetType: 'stock', period, rows: makeLocationOnlyBars(period) })
  assert.equal(locationOnly.current.action, 'wait', `${period} 只有价格位置偏低时不能进入底部观察`)

  const highLocationOnly = buildActionSignals({ assetType: 'stock', period, rows: makeHighLocationOnlyBars(period) })
  assert.equal(highLocationOnly.current.action, 'wait', `${period} 只有高位位置没有动能时不能进入高位观察`)

  const clearedHighWatch = buildActionSignals({ assetType: 'stock', period, rows: makeHighWatchLifecycleBars(period) })
  assert.equal(clearedHighWatch.current.action, 'wait', `${period} 连续三根进入中性区后应清除高位观察`)

  const refreshedHighWatch = buildActionSignals({ assetType: 'stock', period, rows: makeHighWatchLifecycleBars(period, true) })
  assert.equal(refreshedHighWatch.current.action, 'top_observe', `${period} 新的高位证据应刷新观察期限`)
}

const insufficient = buildActionSignals({ period: '30m', rows: makeScenario('30m').slice(0, ACTION_SIGNAL_WARMUP_BARS - 1) })
assert.equal(insufficient.status, 'blocked')

const scenario = buildActionSignals({ period: '1d', rows: makeScenario('1d') })
const aligned = compareActionSignals(
  { ...scenario, current: { ...scenario.current, action: 'bottom_observe' } },
  { ...scenario, period: '30m', current: { ...scenario.current, action: 'wait' } },
)
assert.equal(aligned.status, 'aligned')
const divergent = compareActionSignals(
  { ...scenario, current: { ...scenario.current, action: 'bottom_observe' } },
  { ...scenario, period: '30m', current: { ...scenario.current, action: 'attack' } },
)
assert.equal(divergent.status, 'divergent')

console.log('action signal assertions passed')
