export const PAPER_TRADING_STEP_MINUTES = 15

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

const SESSION_DEFINITIONS = [
  { label: '上午', startMinutes: 9 * 60 + 30, endMinutes: 11 * 60 + 30 },
  { label: '下午', startMinutes: 13 * 60, endMinutes: 15 * 60 },
] as const

const pad = (value: number) => String(value).padStart(2, '0')

const formatTimelineTime = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`

export const PAPER_TRADING_SESSIONS: readonly PaperTradingSession[] = SESSION_DEFINITIONS.map(session => ({
  label: session.label,
  start: formatTimelineTime(session.startMinutes),
  end: formatTimelineTime(session.endMinutes),
  points: Array.from(
    { length: Math.floor((session.endMinutes - session.startMinutes) / PAPER_TRADING_STEP_MINUTES) + 1 },
    (_, index) => {
      const minutes = session.startMinutes + index * PAPER_TRADING_STEP_MINUTES
      return { label: formatTimelineTime(minutes), minutes }
    },
  ),
}))

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
): PaperTradingTimelineState {
  if (minutes == null || !tradingDay) {
    return { phase: 'closed', activeIndex: null, completedIndex: -1, currentStepIndex: null, currentStepLabel: null }
  }

  const morning = SESSION_DEFINITIONS[0]
  const afternoon = SESSION_DEFINITIONS[1]
  const morningPointCount = PAPER_TRADING_SESSIONS[0].points.length

  if (minutes < morning.startMinutes) {
    return { phase: 'preopen', activeIndex: null, completedIndex: -1, currentStepIndex: null, currentStepLabel: null }
  }

  if (minutes <= morning.endMinutes) {
    const localIndex = Math.min(
      Math.floor((minutes - morning.startMinutes) / PAPER_TRADING_STEP_MINUTES),
      morningPointCount - 1,
    )
    const point = PAPER_TRADING_TIMELINE[localIndex]
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
    const localIndex = Math.min(
      Math.floor((minutes - afternoon.startMinutes) / PAPER_TRADING_STEP_MINUTES),
      PAPER_TRADING_SESSIONS[1].points.length - 1,
    )
    const globalIndex = morningPointCount + localIndex
    const point = PAPER_TRADING_TIMELINE[globalIndex]
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
    completedIndex: PAPER_TRADING_TIMELINE.length - 1,
    currentStepIndex: null,
    currentStepLabel: null,
  }
}
