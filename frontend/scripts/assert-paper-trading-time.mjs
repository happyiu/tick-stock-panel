import assert from 'node:assert/strict'
import {
  createPaperTradingSessions,
  PAPER_TRADING_SESSIONS,
  PAPER_TRADING_STEP_OPTIONS,
  PAPER_TRADING_STEP_MINUTES,
  PAPER_TRADING_TIMELINE,
  buildPaperTradingTimelineState,
  getBeijingPaperClock,
  getPaperTradingSystemTimelinePoints,
  parsePaperClockMinutes,
} from '../src/lib/paper-trading-time.ts'

assert.equal(PAPER_TRADING_STEP_MINUTES, 15)
assert.deepEqual(PAPER_TRADING_STEP_OPTIONS, [5, 15, 30, 60])
assert.deepEqual(PAPER_TRADING_SESSIONS.map(session => [session.start, session.end]), [
  ['09:30', '11:30'],
  ['13:00', '15:00'],
])
assert.equal(PAPER_TRADING_TIMELINE.length, 18)
assert.equal(PAPER_TRADING_TIMELINE[0].label, '09:30')
assert.equal(PAPER_TRADING_TIMELINE[8].label, '11:30')
assert.equal(PAPER_TRADING_TIMELINE[9].label, '13:00')
assert.equal(PAPER_TRADING_TIMELINE[17].label, '15:00')

for (const step of PAPER_TRADING_STEP_OPTIONS) {
  const sessions = createPaperTradingSessions(step)
  assert.equal(sessions[0].points.length, 120 / step + 1)
  assert.equal(sessions[1].points.length, 120 / step + 1)
  assert.equal(sessions[0].points.at(-1).label, '11:30')
  assert.equal(sessions[1].points.at(-1).label, '15:00')
  assert.equal(buildPaperTradingTimelineState(10 * 60, true, step).currentStepLabel, step === 60 ? '09:30' : '10:00')
}

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

assert.deepEqual(getPaperTradingSystemTimelinePoints({ enabled: false, hour: 15, minute: 40 }).map(point => point.time), ['08:00', '09:10', '15:35'])
assert.equal(getPaperTradingSystemTimelinePoints({ enabled: false })[0]?.name, 'ai追踪分析启动')
assert.equal(getPaperTradingSystemTimelinePoints({ enabled: false })[0]?.description, 'ai追踪分析启动')
assert.equal(getPaperTradingSystemTimelinePoints({ enabled: false })[0]?.method, 'seekhub_daily_start')
const enabledReviewPoints = getPaperTradingSystemTimelinePoints({ enabled: true, hour: 15, minute: 40 })
assert.deepEqual(enabledReviewPoints.map(point => point.time), ['08:00', '09:10', '15:35', '15:40'])
assert.equal(enabledReviewPoints.at(-1).description, '每日复盘 · 生成并归档 AI 复盘报告')
assert.deepEqual(getPaperTradingSystemTimelinePoints({ enabled: true, hour: 15, minute: 0 }).map(point => point.time), ['08:00', '09:10', '15:00', '15:35'])

console.log('paper trading time assertions passed')
