import assert from 'node:assert/strict'
import {
  analyzeChanlun,
  buildChanlunCenters,
  buildChanlunStrokes,
  detectChanlunFractals,
  detectChanlunThirdSignals,
  mergeChanlunBars,
} from '../src/lib/chanlun.ts'

const bar = (date, low, high, close = (low + high) / 2) => ({ date, open: close, high, low, close })

const contained = mergeChanlunBars([
  bar('2026-01-01', 8, 10),
  bar('2026-01-02', 8.5, 9.5),
  bar('2026-01-03', 9, 11),
  bar('2026-01-04', 9.5, 10.5),
])
assert.equal(contained.length, 2)
assert.equal(contained[0].uncertain, true)
assert.equal(contained[1].direction, 'up')
assert.equal(contained[1].high, 11)
assert.equal(contained[1].low, 9.5)

const mergedForFractals = [
  { sourceStartIndex: 0, sourceEndIndex: 0, startDate: 'd0', endDate: 'd0', high: 10, low: 8, highDate: 'd0', lowDate: 'd0', highSourceIndex: 0, lowSourceIndex: 0, direction: 'up', uncertain: false },
  { sourceStartIndex: 1, sourceEndIndex: 1, startDate: 'd1', endDate: 'd1', high: 12, low: 10, highDate: 'd1', lowDate: 'd1', highSourceIndex: 1, lowSourceIndex: 1, direction: 'up', uncertain: false },
  { sourceStartIndex: 2, sourceEndIndex: 2, startDate: 'd2', endDate: 'd2', high: 11, low: 9, highDate: 'd2', lowDate: 'd2', highSourceIndex: 2, lowSourceIndex: 2, direction: 'down', uncertain: false },
  { sourceStartIndex: 3, sourceEndIndex: 3, startDate: 'd3', endDate: 'd3', high: 10, low: 8, highDate: 'd3', lowDate: 'd3', highSourceIndex: 3, lowSourceIndex: 3, direction: 'down', uncertain: false },
]
assert.deepEqual(detectChanlunFractals(mergedForFractals).map(item => item.type), ['top'])
assert.equal(detectChanlunFractals(mergedForFractals.slice(0, 3)).length, 0)
assert.equal(detectChanlunFractals(mergedForFractals)[0].confirmedAt, 'd3')
assert.equal(detectChanlunFractals([{ ...mergedForFractals[0], high: 12 }, ...mergedForFractals.slice(1)]).length, 0)

const mergedForStrokes = Array.from({ length: 19 }, (_, index) => ({
  sourceStartIndex: index,
  sourceEndIndex: index,
  startDate: `d${index}`,
  endDate: `d${index}`,
  high: 9,
  low: 7,
  highDate: `d${index}`,
  lowDate: `d${index}`,
  highSourceIndex: index,
  lowSourceIndex: index,
  direction: 'up',
  uncertain: false,
}))
mergedForStrokes[1].low = 5
mergedForStrokes[5].high = 10
mergedForStrokes[9].low = 6
mergedForStrokes[13].high = 11
mergedForStrokes[17].low = 7
const fractal = (type, mergedIndex, price) => ({
  type,
  mergedIndex,
  sourceIndex: mergedIndex,
  date: `d${mergedIndex}`,
  price,
  confirmedAt: `d${mergedIndex + 1}`,
  confirmedSourceIndex: mergedIndex + 1,
})
const strokes = buildChanlunStrokes([
  fractal('bottom', 1, 5),
  fractal('top', 5, 10),
  fractal('bottom', 9, 6),
  fractal('top', 13, 11),
  fractal('bottom', 17, 7),
], mergedForStrokes)
assert.equal(strokes.length, 4)
assert.deepEqual(strokes.map(item => item.confirmed), [true, true, true, false])
assert.equal(strokes.at(-1).direction, 'down')

mergedForStrokes[7].high = 12
mergedForStrokes[11].low = 6
mergedForStrokes[15].high = 11
const replacedEndpointStrokes = buildChanlunStrokes([
  fractal('bottom', 1, 5),
  fractal('top', 5, 10),
  fractal('top', 7, 12),
  fractal('bottom', 11, 6),
  fractal('top', 15, 11),
], mergedForStrokes)
assert.equal(replacedEndpointStrokes[0].end.mergedIndex, 7)

const stroke = (index, direction, startPrice, endPrice, confirmed = true) => ({
  id: `s${index}`,
  index,
  direction,
  start: fractal(direction === 'up' ? 'bottom' : 'top', index * 4, startPrice),
  end: fractal(direction === 'up' ? 'top' : 'bottom', index * 4 + 4, endPrice),
  startDate: `t${index}`,
  endDate: `t${index + 1}`,
  startPrice,
  endPrice,
  low: Math.min(startPrice, endPrice),
  high: Math.max(startPrice, endPrice),
  mergedBars: 5,
  changePct: endPrice / startPrice - 1,
  confirmed,
  confirmedAt: confirmed ? `a${index}` : null,
})
const centerStrokes = [
  stroke(0, 'up', 8, 12),
  stroke(1, 'down', 12, 9),
  stroke(2, 'up', 9, 11),
  stroke(3, 'down', 11, 9.5),
  stroke(4, 'up', 9.5, 13),
  stroke(5, 'down', 13, 11.5),
]
const centers = buildChanlunCenters(centerStrokes)
assert.equal(centers.length, 1)
assert.equal(centers[0].zd, 9)
assert.equal(centers[0].zg, 11)
assert.equal(centers[0].componentCount, 5)
assert.equal(centers[0].state, 'broken_up')

const boundaryCenter = buildChanlunCenters([
  stroke(0, 'up', 8, 10),
  stroke(1, 'down', 12, 9),
  stroke(2, 'up', 10, 11),
])
assert.equal(boundaryCenter[0].zd, 10)
assert.equal(boundaryCenter[0].zg, 10)

const signalBars = Array.from({ length: 9 }, (_, index) => bar(`a${index}`, 11.6, 13))
let signals = detectChanlunThirdSignals(centers, centerStrokes, signalBars)
assert.equal(signals.at(-1).kind, 'third_buy')
assert.equal(signals.at(-1).status, 'candidate')
assert.equal(signals.at(-1).structureDate, 't6')

signals = detectChanlunThirdSignals(centers, centerStrokes, [
  ...signalBars,
  bar('a9', 10.9, 12),
])
assert.equal(signals.at(-1).status, 'invalidated')
assert.equal(signals.at(-1).invalidatedAt, 'a9')

const touchedPullback = [...centerStrokes.slice(0, 5), stroke(5, 'down', 13, 11)]
const touchedCenters = buildChanlunCenters(touchedPullback)
signals = detectChanlunThirdSignals(touchedCenters, touchedPullback, signalBars)
assert.equal(signals.some(item => item.status === 'candidate'), false)
assert.equal(signals.at(-1).status, 'rejected')

const waitingStrokes = centerStrokes.slice(0, 5)
signals = detectChanlunThirdSignals(buildChanlunCenters(waitingStrokes), waitingStrokes, signalBars)
assert.equal(signals.at(-1).status, 'waiting_pullback')

const sellStrokes = [
  stroke(0, 'down', 12, 8),
  stroke(1, 'up', 8, 11),
  stroke(2, 'down', 11, 9),
  stroke(3, 'up', 9, 10.5),
  stroke(4, 'down', 10.5, 7),
  stroke(5, 'up', 7, 8.5),
]
const sellSignalBars = Array.from({ length: 9 }, (_, index) => bar(`a${index}`, 7, 8.8))
signals = detectChanlunThirdSignals(buildChanlunCenters(sellStrokes), sellStrokes, sellSignalBars)
assert.equal(signals.at(-1).kind, 'third_sell')
assert.equal(signals.at(-1).status, 'candidate')

const history = [5, 6, 7, 8, 7, 6, 5, 4, 5, 6, 7, 8, 7, 6, 5, 4, 5, 6, 7, 8]
  .map((value, index) => bar(`2026-01-${String(index + 1).padStart(2, '0')}`, value - 0.2, value + 0.2, value))
const cutoff = history[14].date
const beforeFuture = analyzeChanlun(history.slice(0, 15), cutoff)
const afterFuture = analyzeChanlun(history, cutoff)
assert.deepEqual(afterFuture, beforeFuture)

console.log('chanlun assertions passed')
