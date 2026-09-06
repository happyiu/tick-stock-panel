import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download, Loader2, RefreshCw } from 'lucide-react'
import { type MinuteKlineSession } from '@/lib/api'
import { klineMinuteQueryOptions, klineMinuteRangeQueryOptions, minuteRefetchInterval } from '@/lib/kline'
import { ChartDataNotice } from '@/components/ChartDataNotice'
import { EChartsMultiDayIntraday } from '@/components/EChartsMultiDayIntraday'

interface Props {
  symbol: string
  days: number
  height?: number
  refetchIntervalMs?: number
  onPriceDoubleClick?: (price: number, currentPrice: number) => void
  priceLines?: { value: number; label?: string; color?: string }[]
  assetType?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '分钟数据获取失败'
}

export function StockMultiDayIntradayChart({
  symbol,
  days,
  height = 420,
  refetchIntervalMs,
  onPriceDoubleClick,
  priceLines,
  assetType,
}: Props) {
  const history = useQuery({
    ...klineMinuteRangeQueryOptions(symbol, days),
    enabled: !!symbol,
  })
  const latest = useQuery({
    // live: 当日盘中直接实时拉取, 不被分钟增量落盘的本地分区(≥60s一轮)拖慢
    ...klineMinuteQueryOptions(symbol, undefined, true),
    enabled: !!symbol,
    refetchInterval: minuteRefetchInterval(refetchIntervalMs),
  })

  const sessions = useMemo(() => {
    const byDate = new Map<string, MinuteKlineSession>()
    for (const session of history.data?.sessions ?? []) byDate.set(session.date, session)

    const latestDate = latest.data?.date
    const latestRows = latest.data?.rows ?? []
    if (latestDate && latestRows.length > 0) {
      const existing = byDate.get(latestDate)
      byDate.set(latestDate, {
        date: latestDate,
        prev_close: latest.data?.prev_close ?? existing?.prev_close ?? null,
        rows: latestRows,
      })
    }

    return Array.from(byDate.values())
      .sort((left, right) => left.date.localeCompare(right.date))
      .slice(-days)
  }, [days, history.data?.sessions, latest.data])

  // 图表刷新只读取展示缓存，不触发分钟数据落库。
  const syncMinute = {
    isPending: history.isFetching || latest.isFetching,
    isError: history.isError || latest.isError,
    error: history.error ?? latest.error,
    mutate: () => { void history.refetch(); void latest.refetch() },
  }

  const loading = sessions.length === 0 && (history.isLoading || latest.isLoading)
  const queryError = sessions.length === 0 ? history.error ?? latest.error : null
  const isIndex = history.data?.asset_type === 'index' || latest.data?.asset_type === 'index'
  const missingDays = Math.max(0, days - sessions.length)
  const showCoverage = !history.isPlaceholderData && sessions.length > 0 && missingDays > 0 && !isIndex

  const chartHeight = Math.max(260, height - (showCoverage || syncMinute.isPending ? 32 : 0))

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 text-xs text-muted" style={{ height }}>
        <Loader2 className="h-4 w-4 animate-spin text-accent" />
        正在加载近 {days} 日分时…
      </div>
    )
  }

  if (queryError) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 text-xs" style={{ height }}>
        <span className="text-danger">{errorMessage(queryError)}</span>
        <button
          type="button"
          onClick={() => { void history.refetch(); void latest.refetch() }}
          className="inline-flex items-center gap-1.5 rounded-btn border border-border bg-elevated px-3 py-1.5 text-secondary hover:text-foreground"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          重新加载
        </button>
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 text-xs" style={{ height }}>
        {syncMinute.isPending ? (
          <>
            <Loader2 className="h-5 w-5 animate-spin text-accent" />
            <span className="text-secondary">正在获取近 {days} 日分钟 K…</span>
          </>
        ) : (
          <>
            <span className="text-muted">{isIndex ? '指数暂无分钟数据' : '数据源暂无可展示的分钟数据'}</span>
            {!isIndex && (
              <button
                type="button"
                onClick={() => syncMinute.mutate()}
                className="inline-flex items-center gap-1.5 rounded-btn bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90"
              >
                <Download className="h-3.5 w-3.5" />
                获取近 {days} 日
              </button>
            )}
          </>
        )}
        {syncMinute.isError && <span className="max-w-md text-center text-danger">{errorMessage(syncMinute.error)}</span>}
      </div>
    )
  }

  return (
    <div style={{ height }}>
      <ChartDataNotice status={latest.data?.data_status ?? history.data?.data_status} />
      {(showCoverage || (syncMinute.isPending && !isIndex)) && (
        <div className="flex h-8 items-center justify-between gap-3 border-b border-border/60 bg-elevated/40 px-3 text-[11px]">
          {syncMinute.isPending ? (
            <span className="truncate text-accent flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" />
              正在补齐最近 {days} 日分时数据…
            </span>
          ) : syncMinute.isError ? (
            <span className="truncate text-muted">当前 {sessions.length} 日，目标 {days} 日 — 获取失败</span>
          ) : (
            <span className="truncate text-muted">当前 {sessions.length} 个交易日数据，目标 {days} 日</span>
          )}
          {!syncMinute.isPending && (
            <button
              type="button"
              onClick={() => {
                syncMinute.mutate()
              }}
              className="inline-flex shrink-0 items-center gap-1 text-accent hover:text-accent/80"
            >
              <Download className="h-3 w-3" />
              重新获取
            </button>
          )}
        </div>
      )}
      <EChartsMultiDayIntraday
        sessions={sessions}
        height={chartHeight}
        onPriceDoubleClick={onPriceDoubleClick}
        priceLines={priceLines}
        assetType={assetType ?? history.data?.asset_type ?? latest.data?.asset_type}
      />
      {syncMinute.isError && (
        <div className="px-3 pt-1 text-center text-[11px] text-danger">{errorMessage(syncMinute.error)}</div>
      )}
    </div>
  )
}
