import assert from 'node:assert/strict'
import { zoomWindowEndingAt } from '../src/lib/chartViewport.ts'

assert.deepEqual(zoomWindowEndingAt(80, 100, { start: 40, end: 100 }), {
  startValue: 21,
  endValue: 80,
})
assert.deepEqual(zoomWindowEndingAt(99, 100, { start: 40, end: 100 }), {
  startValue: 40,
  endValue: 99,
})
assert.deepEqual(zoomWindowEndingAt(10, 100, { start: 40, end: 100 }), {
  startValue: 0,
  endValue: 10,
})
assert.deepEqual(zoomWindowEndingAt(2, 3, { start: 0, end: 100 }), {
  startValue: 0,
  endValue: 2,
})
assert.equal(zoomWindowEndingAt(-1, 10, { start: 0, end: 100 }), null)
assert.equal(zoomWindowEndingAt(10, 10, { start: 0, end: 100 }), null)

console.log('chart viewport assertions passed')
