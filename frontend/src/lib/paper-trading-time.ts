export const PAPER_TRADING_STEP_MINUTES = 15 as const
export const PAPER_TRADING_STEP_OPTIONS = [5, PAPER_TRADING_STEP_MINUTES, 30, 60] as const
export type PaperTradingStepMinutes = typeof PAPER_TRADING_STEP_OPTIONS[number]

export interface PaperTradingTimelinePoint {
  label: string
  minutes: number
}

export interface PaperTradingSession {
  label: string
  start: string
  end: string
  points: readonly PaperTradingTimelinePoint[]
}

export type PaperTradingPhase = 'preopen' | 'morning' | 'lunch' | 'afternoon' | 'closed'

export interface PaperTradingTimelineState {
  phase: PaperTradingPhase
  activeIndex: number | null
  completedIndex: number
  currentStepIndex: number | null
  currentStepLabel: string | null
}

export interface PaperTradingClock {
  display: string
  minutes: number
  tradingDay: boolean
}

export interface PaperTradingSystemTimelinePoint {
  time: string
  minutes: number
  description: string
}

export interface PaperTradingReviewSchedule {
  enabled: boolean
  hour: number
  minute: number
}

const SESSION_DEFINITIONS = [
  { label: '上午', startMinutes: 9 * 60 + 30, endMinutes: 11 * 60 + 30 },
  { label: '下午', startMinutes: 13 * 60, endMinutes: 15 * 60 },
] as const

const pad = (value: number) => String(value).padStart(2, '0')

const formatTimelineTime = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`

const SYSTEM_TIMELINE_POINTS: readonly PaperTradingSystemTimelinePoint[] = [
  { time: '09:10', minutes: 9 * 60 + 10, description: '数据-自动调度-盘前 · 个股维表' },
  { time: '15:35', minutes: 15 * 60 + 35, description: '盘后 · 全量管道' },
]

/** 系统时间点只展示真实启用的后台工作, 未启用的调度保持不可见。 */
export function getPaperTradingSystemTimelinePoints(
  reviewSchedule?: Partial<PaperTradingReviewSchedule>,
): PaperTradingSystemTimelinePoint[] {
  const points = [...SYSTEM_TIMELINE_POINTS]
  const { enabled, hour, minute } = reviewSchedule ?? {}
  if (
    enabled
    && typeof hour === 'number' && Number.isInteger(hour) && hour >= 0 && hour <= 23
    && typeof minute === 'number' && Number.isInteger(minute) && minute >= 0 && minute <= 59
  ) {
    const minutes = hour * 60 + minute
    points.push({ time: formatTimelineTime(minutes), minutes, description: '每日复盘 · 生成并归档 AI 复盘报告' })
  }
  return points.sort((left, right) => left.minutes - right.minutes)
}

export function createPaperTradingSessions(stepMinutes: PaperTradingStepMinutes = PAPER_TRADING_STEP_MINUTES): readonly PaperTradingSession[] {
  return SESSION_DEFINITIONS.map(session => ({
    label: session.label,
    start: formatTimelineTime(session.startMinutes),
    end: formatTimelineTime(session.endMinutes),
    points: Array.from(
      { length: Math.floor((session.endMinutes - session.startMinutes) / stepMinutes) + 1 },
      (_, index) => {
        const minutes = session.startMinutes + index * stepMinutes
        return { label: formatTimelineTime(minutes), minutes }
      },
    ),
  }))
}

export const PAPER_TRADING_SESSIONS: readonly PaperTradingSession[] = createPaperTradingSessions()

export const PAPER_TRADING_TIMELINE = PAPER_TRADING_SESSIONS.flatMap(session => session.points)

export const PAPER_TRADING_PHASE_LABELS: Record<PaperTradingPhase, string> = {
  preopen: '开盘前',
  morning: '上午交易',
  lunch: '午间休市',
  afternoon: '下午交易',
  closed: '已收盘 / 非交易日',
}

/** 从后端北京时间墙钟字符串中取分钟数, 不做本地时区换算。 */
export function parsePaperClockMinutes(clock: string | null | undefined): number | null {
  const match = clock?.match(/(?:T|\s|^)(\d{1,2}):(\d{2})/)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

const BEIJING_CLOCK_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** 读取浏览器当前时间对应的北京时间, 保证客户端时区不会改变时间轴口径。 */
export function getBeijingPaperClock(value: Date = new Date()): PaperTradingClock {
  const parts = BEIJING_CLOCK_FORMATTER.formatToParts(value).reduce<Record<string, string>>((result, part) => {
    result[part.type] = part.value
    return result
  }, {})
  const hours = Number(parts.hour) % 24
  const minutes = Number(parts.minute)
  return {
    display: `${parts.year}-${parts.month}-${parts.day} ${pad(hours)}:${pad(minutes)}`,
    minutes: hours * 60 + minutes,
    tradingDay: parts.weekday !== 'Sat' && parts.weekday !== 'Sun',
  }
}

export function buildPaperTradingTimelineState(
  minutes: number | null,
  tradingDay = true,
  stepMinutes: PaperTradingStepMinutes = PAPER_TRADING_STEP_MINUTES,
): PaperTradingTimelineState {
  if (minutes == null || !tradingDay) {
    return { phase: 'closed', activeIndex: null, completedIndex: -1, currentStepIndex: null, currentStepLabel: null }
  }

  const morning = SESSION_DEFINITIONS[0]
  const afternoon = SESSION_DEFINITIONS[1]
  const sessions = createPaperTradingSessions(stepMinutes)
  const timeline = sessions.flatMap(session => session.points)
  const morningPointCount = sessions[0].points.length

  if (minutes < morning.startMinutes) {
    return { phase: 'preopen', activeIndex: null, completedIndex: -1, currentStepIndex: null, currentStepLabel: null }
  }

  if (minutes <= morning.endMinutes) {
    const localIndex = Math.min(Math.floor((minutes - morning.startMinutes) / stepMinutes), morningPointCount - 1)
    const point = timeline[localIndex]
    return {
      phase: 'morning',
      activeIndex: localIndex,
      completedIndex: localIndex - 1,
      currentStepIndex: localIndex,
      currentStepLabel: point.label,
    }
  }

  if (minutes < afternoon.startMinutes) {
    return {
      phase: 'lunch',
      activeIndex: null,
      completedIndex: morningPointCount - 1,
      currentStepIndex: null,
      currentStepLabel: null,
    }
  }

  if (minutes <= afternoon.endMinutes) {
    const localIndex = Math.min(Math.floor((minutes - afternoon.startMinutes) / stepMinutes), sessions[1].points.length - 1)
    const globalIndex = morningPointCount + localIndex
    const point = timeline[globalIndex]
    return {
      phase: 'afternoon',
      activeIndex: globalIndex,
      completedIndex: globalIndex - 1,
      currentStepIndex: globalIndex,
      currentStepLabel: point.label,
    }
  }

  return {
    phase: 'closed',
    activeIndex: null,
    completedIndex: timeline.length - 1,
    currentStepIndex: null,
    currentStepLabel: null,
  }
}
