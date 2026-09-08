import assert from 'node:assert/strict'
import { analyzeElliott, describeElliottCount } from '../src/lib/elliott.ts'

function makeBars(turns) {
  const bars = []
  let day = 1
  for (let segment = 0; segment < turns.length - 1; segment += 1) {
    const start = turns[segment]
    const end = turns[segment + 1]
    for (let step = segment === 0 ? 0 : 1; step <= 5; step += 1) {
      const value = start + (end - start) * step / 5
      const date = new Date(Date.UTC(2026, 0, day)).toISOString().slice(0, 10)
      bars.push({
        date,
        open: value,
        high: value + 0.08,
        low: value - 0.08,
        close: value,
        volume: 100 + segment * 20,
      })
      day += 1
    }
  }
  return bars
}

const bullish = makeBars([12, 10, 15, 12, 25, 20, 28, 27])
const bullishAnalysis = analyzeElliott(bullish, '1d')
assert.equal(bullishAnalysis.status, 'ready')
assert.equal(bullishAnalysis.definitionMode, 'swing_proxy')
assert.equal(bullishAnalysis.primaryCount?.family, 'impulse')
assert.equal(bullishAnalysis.primaryCount?.direction, 'up')
assert.equal(bullishAnalysis.hardRuleChecks.filter(rule => rule.result === 'fail').length, 0)
assert.ok(bullishAnalysis.pivots.every(pivot => pivot.state !== 'projected'))
assert.deepEqual(describeElliottCount(bullishAnalysis.primaryCount), {
  pattern: 'five_wave',
  title: '五浪推动候选',
  stage: '第5浪端点已出现，等待反向拐点确认',
  sequence: ['起点', '1', '2', '3', '4', '5?'],
})

const wave2OriginFailure = analyzeElliott(makeBars([12, 10, 15, 9, 25, 20, 28, 27]), '1d')
assert.notEqual(wave2OriginFailure.primaryCount?.family, 'impulse')
assert.ok(wave2OriginFailure.hardRuleChecks.some(rule => rule.ruleId === 'impulse.wave2_origin' && rule.result === 'fail'))

const wave3Shortest = analyzeElliott(makeBars([12, 10, 15, 14, 16, 13, 17, 16]), '1d')
assert.notEqual(wave3Shortest.primaryCount?.family, 'impulse')
assert.ok(wave3Shortest.hardRuleChecks.some(rule => rule.ruleId === 'impulse.wave3_not_shortest' && rule.result === 'fail'))

const wave4Overlap = analyzeElliott(makeBars([12, 10, 15, 12, 25, 14, 28, 27]), '1d')
assert.notEqual(wave4Overlap.primaryCount?.family, 'impulse')
assert.ok(wave4Overlap.hardRuleChecks.some(rule => rule.ruleId === 'impulse.wave4_no_overlap' && rule.result === 'fail'))

const correction = analyzeElliott(makeBars([12, 20, 15, 24, 16, 22]), '1d')
assert.equal(correction.status, 'ready')
assert.equal(correction.primaryCount?.family, 'unknown')
assert.match(correction.primaryCount?.stage ?? '', /修正/)
assert.deepEqual(describeElliottCount(correction.primaryCount), {
  pattern: 'abc',
  title: 'ABC修正候选（具体类型未确定）',
  stage: 'C浪端点已出现，等待后续反向结构确认',
  sequence: ['起点', 'A', 'B', 'C?'],
})

const insufficient = analyzeElliott(bullish.slice(0, 15), '1d')
assert.equal(insufficient.status, 'insufficient')
assert.equal(describeElliottCount(insufficient.primaryCount).pattern, 'none')

const cutoff = bullish[28].date
const prefix = bullish.filter(bar => bar.date <= cutoff)
assert.deepEqual(analyzeElliott(bullish, '1d', cutoff), analyzeElliott(prefix, '1d', cutoff))

console.log('elliott assertions passed')
