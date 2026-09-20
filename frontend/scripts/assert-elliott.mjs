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
        periodEnd: date,
        isClosed: true,
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
assert.equal(bullishAnalysis.definitionMode, 'strict_elliott')
assert.equal(bullishAnalysis.primaryCount?.family, 'impulse')
assert.equal(bullishAnalysis.primaryCount?.direction, 'up')
assert.ok(bullishAnalysis.primaryCount?.id)
assert.equal(bullishAnalysis.primaryCount?.rank, 1)
assert.deepEqual(bullishAnalysis.primaryCount?.wavePath, ['0', '1', '2', '3', '4', '5'])
assert.deepEqual(bullishAnalysis.primaryCount?.rankingBasis, {
  strict: true,
  pivotCount: 6,
  supportingEvidence: bullishAnalysis.primaryCount?.rankingBasis?.supportingEvidence,
})
assert.deepEqual(bullishAnalysis.primaryCount?.pivots.map(pivot => pivot.label), ['0', '1', '2', '3', '4', '5'])
assert.ok(bullishAnalysis.hardRuleChecks.every(rule => rule.candidateId))
assert.ok(bullishAnalysis.guidelineEvidence.every(item => item.id))
assert.ok(bullishAnalysis.hardRuleChecks.some(rule => rule.candidateId === 'unresolved:triangle' && rule.result === 'unknown'))
assert.ok(bullishAnalysis.hardRuleChecks.some(rule => rule.candidateId === 'unresolved:combination' && rule.result === 'unknown'))
assert.ok(bullishAnalysis.primaryCount?.pivots.every(pivot => pivot.eventTime <= bullishAnalysis.asOf && pivot.confirmedAt <= bullishAnalysis.asOf && pivot.availableAt <= bullishAnalysis.asOf))
assert.equal(bullishAnalysis.hardRuleChecks.filter(rule => rule.result === 'fail').length, 0)
assert.ok(bullishAnalysis.pivots.every(pivot => pivot.state !== 'projected'))
assert.deepEqual(analyzeElliott(bullish, '1d').primaryCount?.id, bullishAnalysis.primaryCount?.id)
assert.deepEqual(analyzeElliott(bullish, '1d').alternateCounts.map(count => count.id), bullishAnalysis.alternateCounts.map(count => count.id))
const rankedBullish = [bullishAnalysis.primaryCount, ...bullishAnalysis.alternateCounts].filter(Boolean)
assert.deepEqual(rankedBullish.map(count => count.rank), rankedBullish.map((_, index) => index + 1))
assert.deepEqual(
  analyzeElliott(bullish, '1d').alternateCounts.map(count => ({ id: count.id, rank: count.rank, basis: count.rankingBasis })),
  bullishAnalysis.alternateCounts.map(count => ({ id: count.id, rank: count.rank, basis: count.rankingBasis })),
)
assert.equal(bullishAnalysis.alternateCounts.some(count => count.family === 'triangle' || count.family === 'combination'), false)
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
assert.deepEqual(correction.primaryCount?.wavePath, ['0', 'A', 'B', 'C'])
assert.equal(correction.primaryCount?.rank, 1)
assert.match(correction.primaryCount?.stage ?? '', /修正/)
assert.equal(correction.definitionMode, 'structure_proxy')
assert.ok(correction.hardRuleChecks.some(rule => rule.result === 'unknown'))
assert.equal(correction.hardRuleChecks.some(rule => rule.result === 'pass'), false, 'unknown 不能被提升为 pass')
assert.deepEqual(describeElliottCount(correction.primaryCount), {
  pattern: 'abc',
  title: 'ABC修正候选（具体类型未确定）',
  stage: 'C浪端点已出现，等待后续反向结构确认',
  sequence: ['起点', 'A', 'B', 'C?'],
})

const zigzag = analyzeElliott(makeBars([30, 12, 20, 15, 24, 10]), '1d')
assert.equal(zigzag.primaryCount?.family, 'zigzag')
assert.equal(zigzag.primaryCount?.currentWave, 'C')
assert.deepEqual(zigzag.primaryCount?.wavePath, ['0', 'A', 'B', 'C'])
assert.ok(zigzag.hardRuleChecks.some(rule => rule.ruleId === 'zigzag.c_extends_a' && rule.result === 'pass'))
assert.equal(describeElliottCount(zigzag.primaryCount).title, '锯齿修正候选')

const flat = analyzeElliott(makeBars([30, 12, 20, 10, 24, 18]), '1d')
assert.equal(flat.primaryCount?.family, 'flat')
assert.ok(flat.hardRuleChecks.some(rule => rule.ruleId === 'flat.b_retrace' && rule.result === 'pass'))
assert.equal(describeElliottCount(flat.primaryCount).title, '平台修正候选')

const leadingDiagonal = analyzeElliott(makeBars([12, 10, 15, 12, 25, 14, 28, 27]), '1d')
assert.equal(leadingDiagonal.primaryCount?.family, 'leading_diagonal')
assert.ok(leadingDiagonal.hardRuleChecks.some(rule => rule.ruleId === 'diagonal.wave4_overlap' && rule.result === 'pass'))

const endingDiagonal = analyzeElliott(makeBars([12, 10, 15, 12, 25, 14, 23, 20]), '1d')
assert.equal(endingDiagonal.primaryCount?.family, 'ending_diagonal')
assert.ok(endingDiagonal.hardRuleChecks.some(rule => rule.ruleId === 'diagonal.wave4_overlap' && rule.result === 'pass'))

const repeatedDirection = analyzeElliott(makeBars([20, 10, 18, 12, 24, 16, 30, 20, 34, 26, 40, 32]), '1d')
assert.ok(repeatedDirection.alternateCounts.some(count => count.family === repeatedDirection.primaryCount?.family
  && count.direction === repeatedDirection.primaryCount?.direction
  && count.id !== repeatedDirection.primaryCount?.id), '同家族同方向的不同拐点候选应保留')

const forming = bullish.map((bar, index) => index === bullish.length - 1
  ? { ...bar, open: 19.9, high: 20, low: 19.8, close: 19.9, isClosed: false }
  : bar)
const formingAnalysis = analyzeElliott(forming, '1d')
assert.ok(formingAnalysis.pivots.some(pivot => pivot.state === 'suspected'))
assert.ok(formingAnalysis.primaryCount?.pivots.every(pivot => pivot.state === 'observed'))
assert.equal(formingAnalysis.primaryCount?.pivots.some(pivot => pivot.state === 'suspected'), false)
assert.ok(formingAnalysis.availableAt <= formingAnalysis.asOf, '未闭合尾部的可用时间不能落到快照之后')
assert.equal(bullishAnalysis.pivots.some(pivot => pivot.state === 'suspected'), false, '全量闭合快照不应产生疑似拐点')

assert.deepEqual(
  formingAnalysis.momentumVolumeEvidence.filter(item => item.family === 'multi_timeframe').map(item => item.result),
  ['unavailable'],
)

const insufficient = analyzeElliott(bullish.slice(0, 15), '1d')
assert.equal(insufficient.status, 'insufficient')
assert.equal(describeElliottCount(insufficient.primaryCount).pattern, 'none')

const cutoff = bullish[28].date
const prefix = bullish.filter(bar => bar.date <= cutoff)
assert.deepEqual(analyzeElliott(bullish, '1d', cutoff), analyzeElliott(prefix, '1d', cutoff))

console.log('elliott assertions passed')
