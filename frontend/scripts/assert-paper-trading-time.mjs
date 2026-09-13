import assert from 'node:assert/strict'
import {
  PAPER_TRADING_SESSIONS,
  PAPER_TRADING_STEP_MINUTES,
  PAPER_TRADING_TIMELINE,
  buildPaperTradingTimelineState,
  getBeijingPaperClock,
  parsePaperClockMinutes,
} from '../src/lib/paper-trading-time.ts'

assert.equal(PAPER_TRADING_STEP_MINUTES, 15)
assert.deepEqual(PAPER_TRADING_SESSIONS.map(session => [session.start, session.end]), [
  ['09:30', '11:30'],
  ['13:00', '15:00'],
])
assert.equal(PAPER_TRADING_TIMELINE.length, 18)
assert.equal(PAPER_TRADING_TIMELINE[0].label, '09:30')
assert.equal(PAPER_TRADING_TIMELINE[8].label, '11:30')
assert.equal(PAPER_TRADING_TIMELINE[9].label, '13:00')
assert.equal(PAPER_TRADING_TIMELINE[17].label, '15:00')

const stateAt = time => buildPaperTradingTimelineState(parsePaperClockMinutes(`2026-09-14T${time}:00`))
assert.equal(stateAt('09:30').currentStepLabel, '09:30')
assert.equal(stateAt('09:44').currentStepLabel, '09:30')
assert.equal(stateAt('09:45').currentStepLabel, '09:45')
assert.equal(stateAt('11:30').currentStepLabel, '11:30')
assert.equal(stateAt('11:31').phase, 'lunch')
assert.equal(stateAt('11:31').completedIndex, 8)
assert.equal(stateAt('13:00').currentStepLabel, '13:00')
assert.equal(stateAt('15:00').currentStepLabel, '15:00')
assert.equal(stateAt('15:01').completedIndex, 17)
assert.equal(buildPaperTradingTimelineState(10 * 60, false).completedIndex, -1)
assert.equal(parsePaperClockMinutes('not-a-clock'), null)
assert.deepEqual(getBeijingPaperClock(new Date('2026-09-14T01:30:00Z')), {
  display: '2026-09-14 09:30',
  minutes: 570,
  tradingDay: true,
})

console.log('paper trading time assertions passed')
