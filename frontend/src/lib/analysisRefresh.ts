const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const ANALYSIS_CLOSE_MINUTES = [
  10 * 60,
  10 * 60 + 30,
  11 * 60,
  11 * 60 + 30,
  13 * 60 + 30,
  14 * 60,
  14 * 60 + 30,
  15 * 60,
]

function isWeekday(value: Date): boolean {
  const day = value.getUTCDay()
  return day !== 0 && day !== 6
}

function nextWeekdayAtTen(cnDate: Date): number {
  const next = new Date(Date.UTC(
    cnDate.getUTCFullYear(),
    cnDate.getUTCMonth(),
    cnDate.getUTCDate() + 1,
    10,
  ))
  while (!isWeekday(next)) next.setUTCDate(next.getUTCDate() + 1)
  return next.getTime() - BEIJING_OFFSET_MS
}

/**
 * 返回下一次A股30F闭合边界的时间戳。
 * 输入和输出均为真实时间戳，内部按北京时间墙钟计算，不依赖浏览器时区。
 */
export function nextThirtyMinuteBoundaryAt(now = new Date()): number | null {
  if (Number.isNaN(now.getTime())) return null

  const cnNow = new Date(now.getTime() + BEIJING_OFFSET_MS)
  if (!isWeekday(cnNow)) return nextWeekdayAtTen(cnNow)

  const currentMinutes = cnNow.getUTCHours() * 60
    + cnNow.getUTCMinutes()
    + cnNow.getUTCSeconds() / 60
    + cnNow.getUTCMilliseconds() / 60_000
  const nextClose = ANALYSIS_CLOSE_MINUTES.find(minutes => minutes > currentMinutes)
  if (nextClose != null) {
    return Date.UTC(
      cnNow.getUTCFullYear(),
      cnNow.getUTCMonth(),
      cnNow.getUTCDate(),
      Math.floor(nextClose / 60),
      nextClose % 60,
    ) - BEIJING_OFFSET_MS
  }

  return nextWeekdayAtTen(cnNow)
}

export function canAutoRefreshAnalysis(isTradingHours: boolean, followsLatest: boolean): boolean {
  return isTradingHours && followsLatest
}
