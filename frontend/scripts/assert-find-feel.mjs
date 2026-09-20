import assert from 'node:assert/strict'
import {
  FIND_FEEL_QUANTITY,
  applyFindFeelAction,
  createFindFeelSession,
  getFindFeelActionAvailability,
  getFindFeelMaxQuantity,
  normalizeFindFeelQuantity,
  normalizeFindFeelBars,
  resolveFindFeelStartIndex,
} from '../src/lib/findFeel.ts'

const rows = [
  { date: '2026-01-05', open: 10, high: 10.5, low: 9.5, close: 10, is_closed: true },
  { date: '2026-01-06', open: 12, high: 12.5, low: 11.5, close: 12, is_closed: true },
  { date: '2026-01-07', open: 11, high: 11.5, low: 10.5, close: 11, is_closed: true },
  { date: '2026-01-08', open: 14, high: 14.5, low: 13.5, close: 14, is_closed: true },
  { date: '2026-01-09', open: 16, high: 16.5, low: 15.5, close: 16, is_closed: false },
]
const bars = normalizeFindFeelBars(rows, '1d')
assert.equal(bars.length, 4, '未收盘 K 线不能参与玩法')
assert.deepEqual(bars.map(bar => bar.key), ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'])
assert.equal(FIND_FEEL_QUANTITY, 100)

const intradayBars = normalizeFindFeelBars([
  { date: '2026-01-05T09:30:00', open: 10, high: 10, low: 10, close: 10, is_closed: true },
  { date: '2026-01-05T10:00:00', open: 11, high: 11, low: 11, close: 11, is_closed: true },
  { date: '2026-01-05T10:30:00', open: 12, high: 12, low: 12, close: 12, is_closed: false },
], '30m')
assert.deepEqual(intradayBars.map(bar => bar.key), ['2026-01-05 09:30', '2026-01-05 10:00'])
assert.equal(resolveFindFeelStartIndex(intradayBars, {
  mode: 'selected',
  period: '30m',
  selectedBarKey: '2026-01-05T09:30:00',
}), 0)

assert.equal(resolveFindFeelStartIndex(bars, { mode: 'random', random: () => 0 }), 0)
assert.equal(resolveFindFeelStartIndex(bars, { mode: 'random', random: () => 0.999999 }), 2, '随机起点应优先保留下一根 K 线')
assert.equal(resolveFindFeelStartIndex(bars, { mode: 'random', random: () => 1 }), 2, '随机边界不能落到最新一根')
assert.equal(resolveFindFeelStartIndex(bars, { mode: 'selected', selectedBarKey: '2026-01-06' }), 1)
assert.equal(resolveFindFeelStartIndex(bars, { mode: 'selected', selectedBarKey: null }), 3, '未选中时回退到最新已收盘 K 线')
assert.equal(normalizeFindFeelQuantity(200), 200)
assert.equal(normalizeFindFeelQuantity(250), 0, '交易数量必须是 100 股的整数倍')

const sized = createFindFeelSession({
  initialCash: 5_000,
  targetSteps: 3,
  bars,
  mode: 'selected',
  selectedBarKey: '2026-01-05',
})
assert.equal(getFindFeelMaxQuantity(sized, 'buy'), 500)
assert.equal(getFindFeelMaxQuantity(sized, 'sell'), 0)
assert.equal(getFindFeelActionAvailability(sized, 200).buy, true)
assert.equal(getFindFeelActionAvailability(sized, 600).buy, false)
assert.equal(getFindFeelActionAvailability(sized, 250).buy, false)
let sizedResult = applyFindFeelAction(sized, bars, 'buy', 250)
assert.equal(sizedResult.accepted, false, '非整手数量不应推进')
assert.equal(sizedResult.session.currentIndex, sized.currentIndex)
sizedResult = applyFindFeelAction(sized, bars, 'buy', 300)
assert.equal(sizedResult.accepted, true)
assert.equal(sizedResult.session.cash, 2_000)
assert.equal(sizedResult.session.shares, 300)
assert.equal(sizedResult.session.metrics.equity, 5_600)
assert.equal(getFindFeelMaxQuantity(sizedResult.session, 'buy'), 100)
assert.equal(getFindFeelMaxQuantity(sizedResult.session, 'sell'), 300)
assert.equal(getFindFeelActionAvailability(sizedResult.session, 200).sell, true)
assert.equal(getFindFeelActionAvailability(sizedResult.session, 400).sell, false)
sizedResult = applyFindFeelAction(sizedResult.session, bars, 'sell', 200)
assert.equal(sizedResult.session.cash, 4_400)
assert.equal(sizedResult.session.shares, 100)
assert.equal(sizedResult.session.metrics.equity, 5_500)

let session = createFindFeelSession({
  initialCash: 2_000,
  targetSteps: 3,
  bars,
  mode: 'random',
  random: () => 0,
})
assert.equal(session.completedSteps, 0, '初始 K 线不计步数')
assert.equal(session.currentBarKey, '2026-01-05')
assert.equal(session.metrics.equity, 2_000)
assert.equal(session.phase, 'playing')

let result = applyFindFeelAction(session, bars, 'sell')
assert.equal(result.accepted, false, '没有持仓时卖出应置灰且不推进')
assert.equal(result.session.completedSteps, 0)
session = result.session

result = applyFindFeelAction(session, bars, 'buy')
assert.equal(result.accepted, true)
session = result.session
assert.equal(session.cash, 1_000)
assert.equal(session.shares, 100)
assert.equal(session.currentBarKey, '2026-01-06')
assert.equal(session.metrics.equity, 2_200)
assert.equal(session.metrics.totalPnl, 200)
assert.ok(Math.abs(session.metrics.totalReturn - 0.1) < 1e-12)
assert.equal(session.metrics.positionPct, 1_200 / 2_200)

result = applyFindFeelAction(session, bars, 'skip')
assert.equal(result.accepted, true)
session = result.session
assert.equal(session.currentBarKey, '2026-01-07')
assert.equal(session.metrics.equity, 2_100)
assert.ok(Math.abs(session.metrics.maxDrawdown - 100 / 2_200) < 1e-12)

result = applyFindFeelAction(session, bars, 'sell')
assert.equal(result.accepted, true)
session = result.session
assert.equal(session.cash, 2_100)
assert.equal(session.shares, 0)
assert.equal(session.metrics.equity, 2_100)
assert.equal(session.metrics.totalPnl, 100)
assert.ok(Math.abs(session.metrics.totalReturn - 0.05) < 1e-12)
assert.equal(session.phase, 'finished')
assert.equal(session.endReason, 'target_steps')
assert.equal(session.equityCurve.length, 4)

const cashLimited = createFindFeelSession({
  initialCash: 1_000,
  targetSteps: 2,
  bars,
  mode: 'selected',
  selectedBarKey: '2026-01-06',
})
assert.equal(getFindFeelActionAvailability(cashLimited).buy, false)
assert.equal(getFindFeelActionAvailability(cashLimited).sell, false)
assert.equal(applyFindFeelAction(cashLimited, bars, 'buy').accepted, false, '现金不足时买入不应推进')
assert.equal(applyFindFeelAction(cashLimited, bars, 'buy').session.currentIndex, 1)

const latest = createFindFeelSession({
  initialCash: 1_000,
  targetSteps: 20,
  bars,
  mode: 'selected',
  selectedBarKey: '2026-01-08',
})
assert.equal(latest.phase, 'finished', '从最新已收盘 K 线开始时应自动结束')
assert.equal(latest.endReason, 'no_next_bar')
assert.equal(applyFindFeelAction(latest, bars, 'skip').accepted, false)

let shortRun = createFindFeelSession({
  initialCash: 1_000,
  targetSteps: 20,
  bars,
  mode: 'selected',
  selectedBarKey: '2026-01-07',
})
shortRun = applyFindFeelAction(shortRun, bars, 'skip').session
assert.equal(shortRun.phase, 'playing')
shortRun = applyFindFeelAction(shortRun, bars, 'skip').session
assert.equal(shortRun.phase, 'finished', '数据不足时应在最新 K 线自动结束')
assert.equal(shortRun.endReason, 'no_next_bar')

console.log('find feel assertions passed')
