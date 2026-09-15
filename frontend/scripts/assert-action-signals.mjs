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
    54: { close: 100.0, open: 100.2, high: 100.5, low: 99.5, volume: 180, rsi_14: 20, macd_hist: -1.0, atr14: 0.8, ma20: 100 },
    55: { close: 99.0, open: 99.3, high: 99.6, low: 98.8, rsi_14: 31, macd_hist: -0.4, atr14: 0.5, ma20: 100 },
    56: { close: 98.5, open: 99.0, high: 99.2, low: 98.2, rsi_14: 26, macd_hist: -0.8, atr14: 0.5, ma20: 100 },
    57: { close: 98.8, open: 98.5, high: 99.1, low: 98.6, rsi_14: 27, macd_hist: -0.7, atr14: 0.5, ma20: 100 },
    58: { close: 99.0, open: 98.8, high: 99.4, low: 98.8, volume: 100, rsi_14: 30, macd_hist: -0.5, atr14: 0.8, ma20: 100 },
    59: { close: 99.4, open: 99.2, high: 99.8, low: 99.2, rsi_14: 34, macd_hist: -0.4, atr14: 1.0, ma20: 100 },
    60: { close: 99.3, open: 99.7, high: 99.9, low: 98.6, rsi_14: 32, macd_hist: -0.6, atr14: 0.5, ma20: 100 },
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

function makeRearmedReduceScenario(period = '1d') {
  const rows = makeScenario(period, 78).map(bar => ({ ...bar }))
  const continuation = {
    71: { close: 103.6, open: 103.2, high: 103.9, low: 103.0, volume: 100, rsi_14: 72, macd_hist: 1.1, atr14: 0.8, ma20: 101.5 },
    72: { close: 103.7, open: 103.5, high: 104.0, low: 103.2, volume: 100, rsi_14: 73, macd_hist: 1.2, atr14: 0.8, ma20: 101.6 },
    73: { close: 103.8, open: 103.6, high: 104.2, low: 103.4, volume: 100, rsi_14: 74, macd_hist: 1.25, atr14: 0.8, ma20: 101.7 },
    74: { close: 103.9, open: 103.7, high: 104.3, low: 103.5, volume: 100, rsi_14: 75, macd_hist: 1.3, atr14: 0.8, ma20: 101.8 },
    75: { close: 104.0, open: 103.8, high: 104.4, low: 103.6, volume: 100, rsi_14: 76, macd_hist: 1.35, atr14: 0.8, ma20: 101.9 },
    76: { close: 104.8, open: 104.0, high: 105.0, low: 103.9, volume: 130, rsi_14: 77, macd_hist: 1.5, atr14: 0.8, ma20: 102.0 },
    77: { close: 104.0, open: 104.8, high: 105.2, low: 103.5, volume: 80, rsi_14: 68, macd_hist: 0.8, atr14: 0.8, ma20: 102.0 },
  }
  for (const [index, override] of Object.entries(continuation)) rows[Number(index)] = { ...rows[Number(index)], ...override }
  return rows
}

function makeDeclineAfterReduceScenario(period = '1d') {
  const rows = makeScenario(period, 78).map(bar => ({ ...bar }))
  const decline = {
    71: { close: 102.0, open: 102.6, high: 102.8, low: 101.7, volume: 90, rsi_14: 64, macd_hist: 0.5, atr14: 0.8, ma20: 101.4 },
    72: { close: 101.4, open: 101.9, high: 102.1, low: 101.0, volume: 90, rsi_14: 60, macd_hist: 0.3, atr14: 0.8, ma20: 101.2 },
    73: { close: 101.0, open: 101.5, high: 101.7, low: 100.7, volume: 90, rsi_14: 57, macd_hist: 0.1, atr14: 0.8, ma20: 101.0 },
    74: { close: 101.3, open: 101.0, high: 101.6, low: 100.8, volume: 100, rsi_14: 58, macd_hist: 0.2, atr14: 0.8, ma20: 100.9 },
    75: { close: 100.9, open: 101.3, high: 101.4, low: 100.5, volume: 90, rsi_14: 54, macd_hist: 0.0, atr14: 0.8, ma20: 100.8 },
    76: { close: 100.7, open: 101.0, high: 101.1, low: 100.3, volume: 90, rsi_14: 52, macd_hist: -0.1, atr14: 0.8, ma20: 100.7 },
    77: { close: 100.4, open: 100.8, high: 100.9, low: 100.1, volume: 90, rsi_14: 50, macd_hist: -0.2, atr14: 0.8, ma20: 100.5 },
  }
  for (const [index, override] of Object.entries(decline)) rows[Number(index)] = { ...rows[Number(index)], ...override }
  return rows
}

function makeMarketOnlyReduceScenario(period = '1d') {
  const rows = makeScenario(period).map(bar => ({ ...bar }))
  for (let index = 54; index < 68; index += 1) {
    rows[index] = {
      ...rows[index],
      close: 100,
      open: 99.8,
      high: 100.8,
      low: 99.5,
      volume: 100,
      rsi_14: 50,
      macd_hist: 0,
      atr14: 0.8,
      ma20: 100,
    }
  }
  return rows
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

function makeEqualLowScenario(period = '1d') {
  const rows = makeScenario(period).map(bar => ({ ...bar }))
  rows[54] = { ...rows[54], low: 98.0 }
  rows[58] = { ...rows[58], low: 98.1 }
  rows[60] = { ...rows[60], close: 99.3, open: 99.0, high: 99.7, low: 98.8, rsi_14: 32, macd_hist: -0.2, atr14: 1.0, ma20: 100 }
  return rows
}

function makeToleratedAddScenario(period = '1d') {
  const rows = makeScenario(period).map(bar => ({ ...bar }))
  rows[60] = { ...rows[60], low: 98.1 }
  return rows
}

function makeVAddScenario(period = '1d') {
  const rows = makeToleratedAddScenario(period)
  rows[60] = { ...rows[60], low: 97.0 }
  rows[67] = { ...rows[67], volume: 130 }
  return rows
}

function makePullbackAddScenario(period = '1d', overextended = false) {
  const rows = makeToleratedAddScenario(period)
  rows[67] = {
    ...rows[67],
    close: overextended ? 102.0 : 101.35,
    open: overextended ? 101.6 : 101.2,
    high: overextended ? 102.2 : 101.5,
    low: overextended ? 101.7 : 101.1,
    ma20: overextended ? 101.5 : 100.8,
  }
  rows[68] = {
    ...rows[68],
    close: 101.3,
    open: 101.15,
    high: 101.5,
    low: 101.1,
    ma20: 101.4,
    rsi_14: 60,
    macd_hist: 0.6,
  }
  return rows
}

function makeStrongEarlyAddScenario(period = '1d') {
  const rows = makeToleratedAddScenario(period)
  rows[62] = {
    ...rows[62],
    close: 100.5,
    open: 100.0,
    high: 100.7,
    low: 100.0,
    volume: 130,
    rsi_14: 55,
    macd_hist: 0.4,
    atr14: 0.8,
    ma20: 100,
  }
  return rows
}

function makeAuxiliaryOnlyScenario(period = '1d') {
  const rows = makeScenario(period).map(bar => ({ ...bar }))
  rows[54] = { ...rows[54], rsi_14: 50, macd_hist: 0, volume: 180 }
  rows[55] = { ...rows[55], rsi_14: 31 }
  rows[56] = { ...rows[56], rsi_14: 50, macd_hist: 0, volume: 100 }
  rows[57] = { ...rows[57], rsi_14: 50, macd_hist: 0 }
  rows[58] = { ...rows[58], rsi_14: 50, macd_hist: 0 }
  rows[59] = { ...rows[59], rsi_14: 50, macd_hist: 0 }
  return rows
}

function makeDelayedReversalScenario(period = '1d') {
  const rows = makeScenario(period).map(bar => ({ ...bar }))
  rows[58] = { ...rows[58], close: 99.3, open: 99.0, high: 99.6, low: 98.7 }
  return rows
}

function makeChasedTrialScenario(period = '1d') {
  const rows = makeScenario(period).map(bar => ({ ...bar }))
  rows[59] = { ...rows[59], close: 100.6, open: 100.3, high: 100.8, low: 100.1 }
  return rows
}

function makeVolumeRatioMismatchScenario(period = '1d') {
  const rows = makeScenario(period).map(bar => ({ ...bar }))
  for (const index of [49, 50, 51, 52, 53]) rows[index] = { ...rows[index], volume: 200 }
  rows[54] = { ...rows[54], volume: 100, rsi_14: 50, macd_hist: -1.0, close: 100, high: 100.8 }
  rows[55] = { ...rows[55], volume: 50, rsi_14: 31, ma20: 100.5, close: 99.8, high: 100.0, low: 98.8 }
  rows[56] = { ...rows[56], volume: 80, rsi_14: 50, macd_hist: -0.8, close: 99.5, high: 99.8, low: 98.2 }
  rows[57] = { ...rows[57], rsi_14: 50, close: 99.4 }
  rows[58] = { ...rows[58], rsi_14: 50, close: 99.3 }
  rows[59] = { ...rows[59], rsi_14: 50, macd_hist: -0.4, close: 99.4 }
  return rows
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
    assert.ok(result.events[0].reasons.some(reason => reason.includes('探底量能收缩')))
    assert.ok(result.events[2].reasons.some(reason => reason.includes('ROC')))
    assert.equal(new Set(result.events.map(event => event.id)).size, result.events.length)
    const defensePrices = result.history.map(item => item.defensePrice).filter(price => Number.isFinite(price))
    assert.equal(defensePrices.every((price, index) => index === 0 || price >= defensePrices[index - 1]), true, `${assetType}/${period} 防守位只能上移不能下移`)

    const rearmedReduce = buildActionSignals({ assetType, period, rows: makeRearmedReduceScenario(period) })
    assert.deepEqual(rearmedReduce.events.map(event => event.type).slice(0, 5), ['attack', 'add', 'reduce', 'add', 'reduce'], `${assetType}/${period} 减仓后突破前高应先走恢复/回补，再允许新高后的减仓`)
    assert.equal(rearmedReduce.events.find(event => event.type === 'add')?.trigger, 'neckline_break')
    assert.equal(rearmedReduce.events.find(event => event.trigger === 'recovery')?.type, 'add', `${assetType}/${period} V型恢复应先小幅回补`)
    assert.equal(rearmedReduce.events.filter(event => event.type === 'reduce').length, 2, `${assetType}/${period} 防守阶段不重复减仓，新波段恢复后才允许下一次减仓`)
    assert.ok(rearmedReduce.events.filter(event => event.type === 'reduce').every(event => event.trigger !== 'deceleration' && event.trigger !== 'peak_drawdown'), `${assetType}/${period} 减仓必须有价格反转确认`)

    const declineAfterReduce = buildActionSignals({ assetType, period, rows: makeDeclineAfterReduceScenario(period) })
    assert.equal(declineAfterReduce.events.filter(event => event.type === 'reduce').length, 1, `${assetType}/${period} 同一轮下跌中不得重复减仓`)
    assert.equal(declineAfterReduce.events.at(-1)?.type, 'reduce', `${assetType}/${period} 减仓后未形成新波段时不应继续发出减仓`)

    const marketOnlyReduce = buildActionSignals({ assetType, period, rows: makeMarketOnlyReduceScenario(period) })
    assert.equal(marketOnlyReduce.events[0]?.type, 'reduce', `${assetType}/${period} 高位风险信号不应依赖持仓或加仓确认`)

    const observation = buildActionSignals({ assetType, period, rows: rows.slice(0, ACTION_SIGNAL_WARMUP_BARS - 1) })
    assert.equal(observation.events.length, 0, `${assetType}/${period} 超跌阶段不能直接买入`)
    assert.equal(observation.status, 'blocked')

    const beforeExit = buildActionSignals({ assetType, period, rows: rows.slice(0, 73) })
    assert.equal(beforeExit.current.action, 'defense_test', `${assetType}/${period} 下影测试不能直接退出`)
    assert.equal(beforeExit.current.phase, 'defensive')
    assert.equal(beforeExit.current.observation, 'bottom_observe', `${assetType}/${period} 底部观察不能覆盖防守主状态`)
    assert.equal(beforeExit.events.at(-1)?.type, 'reduce')

    const shallowBreakRows = rows.slice(0, 73).map(bar => ({ ...bar }))
    shallowBreakRows[72] = { ...shallowBreakRows[72], close: 98.42, open: 98.8, high: 99.0, low: 98.2 }
    const shallowBreak = buildActionSignals({ assetType, period, rows: shallowBreakRows })
    assert.equal(shallowBreak.current.action, 'defensive', `${assetType}/${period} 轻微收盘跌破只进入防守确认中`)
    assert.equal(shallowBreak.current.defenseStatus, 'break_pending')
    assert.equal(shallowBreak.events.at(-1)?.type, 'reduce')

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
    const topThenBottom = buildActionSignals({ assetType, period, rows: topThenBottomRows.slice(0, 73) })
    assert.equal(topThenBottom.current.action, 'defensive', `${assetType}/${period} 防守主状态不能被高位观察覆盖`)
    assert.equal(topThenBottom.current.phase, 'defensive')

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

  const equalLow = buildActionSignals({ assetType: 'stock', period, rows: makeEqualLowScenario(period) })
  assert.equal(equalLow.events[0]?.type, 'attack', `${period} 近似等低重测也应允许试仓`)
  assert.ok(equalLow.events[0]?.reasons.some(reason => reason.includes('近似等低')))

  const delayedReversal = buildActionSignals({ assetType: 'stock', period, rows: makeDelayedReversalScenario(period) })
  assert.equal(delayedReversal.events[0]?.type, 'attack', `${period} 底部后窗口内反转应允许试仓`)
  assert.ok(delayedReversal.events[0]?.reasons.some(reason => reason.includes('上涨反转')))

  const auxiliaryOnly = buildActionSignals({ assetType: 'stock', period, rows: makeAuxiliaryOnlyScenario(period) })
  assert.equal(auxiliaryOnly.events.some(event => event.type === 'attack'), false, `${period} 只有辅助证据不能触发试仓`)

  const chasedTrial = buildActionSignals({ assetType: 'stock', period, rows: makeChasedTrialScenario(period) })
  assert.equal(chasedTrial.events.some(event => event.type === 'attack'), false, `${period} 风险过高或距底部过远不能追高试仓`)

  const volumeRatioMismatch = buildActionSignals({ assetType: 'stock', period, rows: makeVolumeRatioMismatchScenario(period) })
  assert.equal(volumeRatioMismatch.events.some(event => event.type === 'attack'), false, `${period} 原始量缩但RVOL未收缩时不能仅凭量能加分触发试仓`)

  const toleratedAdd = buildActionSignals({ assetType: 'stock', period, rows: makeToleratedAddScenario(period) })
  assert.equal(toleratedAdd.events.find(event => event.type === 'add')?.trigger, 'neckline_break', `${period} 轻微创新低在0.2 ATR容错内仍应允许颈线加仓`)
  assert.ok(toleratedAdd.events.find(event => event.type === 'add')?.reasons.some(reason => reason.includes('低点容错 0.2 ATR')))

  const vAdd = buildActionSignals({ assetType: 'stock', period, rows: makeVAddScenario(period) })
  assert.equal(vAdd.events.find(event => event.type === 'add')?.trigger, 'breakout', `${period} V型反转突破局部高点应允许加仓`)

  const pullbackAdd = buildActionSignals({ assetType: 'stock', period, rows: makePullbackAddScenario(period) })
  assert.equal(pullbackAdd.events.find(event => event.type === 'add')?.trigger, 'pullback', `${period} 弱突破后回踩收回颈线应允许加仓`)
  const waitingPullback = buildActionSignals({ assetType: 'stock', period, rows: makePullbackAddScenario(period).slice(0, 68) })
  assert.equal(waitingPullback.pendingConfirmation, true, `${period} 弱突破后应暴露等待回踩状态`)
  assert.ok(waitingPullback.reason.includes('等待回踩'))

  const chasedBreakout = buildActionSignals({ assetType: 'stock', period, rows: makePullbackAddScenario(period, true) })
  assert.equal(chasedBreakout.events.find(event => event.type === 'add')?.trigger, 'pullback', `${period} 超过0.8 ATR的突破不得直接追高，应等待回踩`)

  const earlyRows = makeStrongEarlyAddScenario(period)
  const earlyAdd = buildActionSignals({ assetType: 'stock', period, rows: earlyRows })
  const earlyAttackIndex = earlyAdd.events.findIndex(event => event.type === 'attack')
  const earlyAddIndex = earlyAdd.events.findIndex(event => event.type === 'add')
  const earlyAttackBar = earlyRows.findIndex(row => row.date === earlyAdd.events[earlyAttackIndex]?.date)
  const earlyAddBar = earlyRows.findIndex(row => row.date === earlyAdd.events[earlyAddIndex]?.date)
  assert.equal(earlyAdd.events[earlyAddIndex]?.trigger, 'neckline_break', `${period} 强确认加仓应走颈线突破`)
  assert.equal(earlyAddBar - earlyAttackBar, 3, `${period} 强确认允许最少间隔3根K线`)
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
