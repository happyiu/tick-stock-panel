/**
 * 日K查询配置 — klineDaily 的唯一权威 options。
 *
 * StockDailyKChart(图表) 与 StockPanel(信息条) 各自 useQuery 共享同一 cache key,
 * React Query 按 key 去重只发一次请求; 邻近预取 prefetchQuery 也复用本配置, 三处不会漂移。
 *
 * placeholderData 内置"仅同 symbol 占位"守卫: 改日期范围/扩展字段时旧数据可暂显(不闪),
 * 切股时不透传上一只股票的数据(不误显示)。
 */
import type { UseQueryOptions } from '@tanstack/react-query'
import { api, type KlinePeriod, type KlineResponse } from '@/lib/api'
import { QK } from '@/lib/queryKeys'

/** 分时 tab 多日分时默认周期 (StockPanel 预取与弹窗存储回退共用, 避免魔数两处漂移) */
export const DEFAULT_INTRADAY_DAYS = 10
export const DEFAULT_30M_DAYS = 20

export const KLINE_PERIOD_OPTIONS: { value: KlinePeriod; label: string }[] = [
  { value: '30m', label: '30F' },
  { value: '1d', label: '日 K' },
  { value: '1w', label: '周 K' },
  { value: '1mo', label: '月 K' },
]

/** 各周期首次切换时采用的展示范围。30F 的精确交易日数量由后端 days 参数裁剪。 */
export function defaultKlineRange(period: KlinePeriod, now = new Date()): { start: string; end: string } {
  const formatLocalDate = (value: Date) => [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0'),
  ].join('-')
  const end = formatLocalDate(now)
  const start = new Date(now)
  if (period === '30m') start.setDate(start.getDate() - 60)
  else if (period === '1d') start.setMonth(start.getMonth() - 6)
  else if (period === '1w') start.setFullYear(start.getFullYear() - 1)
  else start.setFullYear(start.getFullYear() - 2)
  return { start: formatLocalDate(start), end }
}

export function klineDailyQueryOptions(
  symbol: string,
  dateRange: { start: string; end: string },
  extColumns?: string,
) {
  return {
    queryKey: QK.kline(symbol, dateRange.start, dateRange.end, extColumns),
    queryFn: () => api.klineDaily(symbol, undefined, dateRange, extColumns),
    // 工厂无 TData 泛型, 参数用 any 以便 useQuery/prefetchQuery 共用
    placeholderData: (prev: any, prevQuery: any) => {
      const prevKey = prevQuery?.queryKey as readonly unknown[] | undefined
      return prevKey?.[1] === symbol ? prev : undefined
    },
  }
}

export function klinePeriodQueryOptions(
  symbol: string,
  period: KlinePeriod,
  dateRange: { start: string; end: string },
  days = DEFAULT_30M_DAYS,
  extColumns?: string,
): UseQueryOptions<KlineResponse, Error, KlineResponse, readonly unknown[]> {
  if (period === '1d') return klineDailyQueryOptions(symbol, dateRange, extColumns)
  return {
    queryKey: QK.klinePeriod(symbol, period, dateRange.start, dateRange.end, days),
    queryFn: () => api.klinePeriod(symbol, period, dateRange, days),
    placeholderData: (prev: any, prevQuery: any) => {
      const prevKey = prevQuery?.queryKey as readonly unknown[] | undefined
      return prevKey?.[1] === symbol && prevKey?.[2] === period ? prev : undefined
    },
  }
}

/**
 * 单日分时查询配置 — 与 klineDailyQueryOptions 同风格的单源 options (date 为空 = 最新日内)。
 *
 * live 仅当日盘中生效: 传 true 时后端实时拉取最新K, 不被分钟增量落盘(≥60s 一轮)拖慢;
 * 历史日期后端自行忽略 live, 故多日图与预取恒传 true 亦不影响历史读取。
 */
export function klineMinuteQueryOptions(symbol: string, date?: string, live?: boolean) {
  return {
    queryKey: QK.klineMinute(symbol, date ?? ''),
    queryFn: () => api.klineMinute(symbol, date ?? undefined, live),
  }
}

/** 多日分时查询配置 — 分时 tab 的 StockMultiDayIntradayChart 与 邻近预取 共用。
 * 内嵌「仅同 symbol 占位」守卫 (key 结构 ['kline-minute-range', symbol, days], index 1 为 symbol),
 * 与 klineDailyQueryOptions 同源, 调用点不再各自手写。 */
export function klineMinuteRangeQueryOptions(symbol: string, days: number) {
  return {
    queryKey: QK.klineMinuteRange(symbol, days),
    queryFn: () => api.klineMinuteRange(symbol, days),
    placeholderData: (prev: any, prevQuery: any) => {
      const prevKey = prevQuery?.queryKey as readonly unknown[] | undefined
      return prevKey?.[1] === symbol ? prev : undefined
    },
  }
}
