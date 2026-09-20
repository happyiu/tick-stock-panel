export type StockChatPeriod = '30m' | '1d' | '1w' | '1mo'

export function stockChatBarKey(value: unknown, period: StockChatPeriod): string {
  const text = String(value ?? '').replace('T', ' ')
  return period === '30m' ? text.slice(0, 16) : text.slice(0, 10)
}

/** Select bars visible at a fixed observation point, capped for chat context. */
export function selectStockChatRows<T extends { date?: unknown }>(
  rows: T[],
  period: StockChatPeriod,
  asOf: string | null,
  limit = 90,
): T[] {
  const cutoff = asOf ? stockChatBarKey(asOf, period) : ''
  const eligible = rows.filter(row => !cutoff || stockChatBarKey(row.date, period) <= cutoff)
  return eligible.slice(-limit)
}

/** Keep whole user/assistant turns when limiting the visible session history. */
export function trimStockChatMessages<T extends { role: 'user' | 'assistant' }>(messages: T[], limit = 40): T[] {
  const result = [...messages]
  // Remove complete turns only. This can leave one spare slot unused for an
  // odd limit, but it never makes the next request start with an assistant.
  while (result.length > limit) result.splice(0, Math.min(2, result.length))
  return result
}
