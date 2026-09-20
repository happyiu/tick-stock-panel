import assert from 'node:assert/strict'
import { canAutoRefreshAnalysis, nextThirtyMinuteBoundaryAt } from '../src/lib/analysisRefresh.ts'

function assertNextBoundary(input, expected) {
  const actual = nextThirtyMinuteBoundaryAt(new Date(input))
  assert.equal(actual == null ? null : new Date(actual).toISOString(), new Date(expected).toISOString())
}

assertNextBoundary('2026-09-09T09:45:00+08:00', '2026-09-09T10:00:00+08:00')
assertNextBoundary('2026-09-09T11:20:00+08:00', '2026-09-09T11:30:00+08:00')
assertNextBoundary('2026-09-09T11:30:00+08:00', '2026-09-09T13:30:00+08:00')
assertNextBoundary('2026-09-09T13:45:00+08:00', '2026-09-09T14:00:00+08:00')
assertNextBoundary('2026-09-09T14:45:00+08:00', '2026-09-09T15:00:00+08:00')
assertNextBoundary('2026-09-11T15:01:00+08:00', '2026-09-14T10:00:00+08:00')
assertNextBoundary('2026-09-12T10:00:00+08:00', '2026-09-14T10:00:00+08:00')
assert.equal(nextThirtyMinuteBoundaryAt(new Date('invalid')), null)

assert.equal(canAutoRefreshAnalysis(true, true), true)
assert.equal(canAutoRefreshAnalysis(false, true), false)
assert.equal(canAutoRefreshAnalysis(true, false), false)

console.log('analysis refresh assertions passed')
