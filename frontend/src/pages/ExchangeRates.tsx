import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Clock, Loader2, RefreshCw } from 'lucide-react'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { toast } from '@/components/Toast'
import { MissingCapChip, routeCapUsable } from '@/lib/capability-labels'
import { api, type ExchangeRateRow } from '@/lib/api'
import { fmtDate } from '@/lib/format'
import { QK } from '@/lib/queryKeys'
import { useCapabilityMatrix, useDataStatus, usePreferences } from '@/lib/useSharedQueries'

const RATE_ITEMS = [
  { symbol: 'USD/CNY', label: '美元 / 人民币' },
  { symbol: 'USD/CNH', label: '美元 / 离岸人民币' },
  { symbol: 'JPY/CNY', label: '日元 / 人民币' },
  { symbol: 'HKD/CNY', label: '港币 / 人民币' },
  { symbol: 'EUR/CNY', label: '欧元 / 人民币' },
  { symbol: 'DXY', label: '美元指数（派生）' },
] as const

function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function defaultStartDate() {
  const date = new Date()
  date.setFullYear(date.getFullYear() - 1)
  return localDate(date)
}

function startDateMonthsAgo(months: number, end = localDate()) {
  const date = new Date(`${end}T00:00:00`)
  const day = date.getDate()
  date.setDate(1)
  date.setMonth(date.getMonth() - months)
  date.setDate(Math.min(day, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()))
  return localDate(date)
}

function formatRate(symbol: string, value: number | null | undefined) {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  return Number(value).toFixed(symbol === 'DXY' ? 2 : 4)
}

function sourceLabel(source?: string | null) {
  if (source === 'OPEN_EXCHANGE_RATES') return 'OXR'
  if (source === 'OPEN_EXCHANGE_RATES_DERIVED') return 'OXR 派生'
  if (source === 'FRANKFURTER_DERIVED') return 'Frankfurter 派生'
  return source || '—'
}

function providerLabel(provider?: string) {
  if (provider === 'openexchangerates') return 'Open Exchange Rates'
  if (provider === 'frankfurter') return 'Frankfurter / CFETS'
  return provider || '默认数据源'
}

function formatRetrievedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatUpdateTime(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function latestRowsBySymbol(rows: ExchangeRateRow[]) {
  const latest = new Map<string, ExchangeRateRow>()
  for (const row of rows) {
    const previous = latest.get(row.symbol)
    if (!previous || row.date > previous.date || (row.date === previous.date && row.retrieved_at > previous.retrieved_at)) {
      latest.set(row.symbol, row)
    }
  }
  return latest
}

type RateTrendState = 'strong_up' | 'up' | 'flat' | 'down' | 'strong_down' | 'insufficient'

interface RateTrend {
  state: RateTrendState
  roc5: number | null
  roc20: number | null
  roc60: number | null
  ma20Slope: number | null
  ma60Slope: number | null
}

const TREND_META: Record<RateTrendState, { mark: string; label: string; className: string }> = {
  strong_up: { mark: '↑↑', label: '持续走强', className: 'text-bull' },
  up: { mark: '↑', label: '走强', className: 'text-bull' },
  flat: { mark: '—', label: '震荡', className: 'text-muted' },
  down: { mark: '↓', label: '走弱', className: 'text-bear' },
  strong_down: { mark: '↓↓', label: '持续走弱', className: 'text-bear' },
  insufficient: { mark: '—', label: '数据不足', className: 'text-muted' },
}

function dailyRowsBySymbol(rows: ExchangeRateRow[], symbol: string) {
  const byDate = new Map<string, ExchangeRateRow>()
  for (const row of rows) {
    if (row.symbol !== symbol) continue
    const previous = byDate.get(row.date)
    if (!previous || row.retrieved_at > previous.retrieved_at) byDate.set(row.date, row)
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

function buildRateTrend(rows: ExchangeRateRow[], symbol: string): RateTrend {
  const points = dailyRowsBySymbol(rows, symbol)
  const lastIndex = points.length - 1
  const current = points[lastIndex]?.rate ?? null

  const valueAt = (daysAgo: number) => points[lastIndex - daysAgo]?.rate ?? null
  const averageAt = (period: number, daysAgo = 0) => {
    const end = lastIndex - daysAgo
    const start = end - period + 1
    if (start < 0) return null
    const values = points.slice(start, end + 1).map(point => point.rate)
    return values.reduce((sum, value) => sum + value, 0) / values.length
  }
  const change = (daysAgo: number) => {
    const previous = valueAt(daysAgo)
    return current != null && previous != null && previous !== 0 ? current / previous - 1 : null
  }

  const ma20 = averageAt(20)
  const ma60 = averageAt(60)
  const ma20Previous = averageAt(20, 5)
  const ma60Previous = averageAt(60, 5)
  const roc5 = change(5)
  const roc20 = change(20)
  const roc60 = change(60)
  const ma20Slope = ma20 != null && ma20Previous != null && ma20Previous !== 0 ? ma20 / ma20Previous - 1 : null
  const ma60Slope = ma60 != null && ma60Previous != null && ma60Previous !== 0 ? ma60 / ma60Previous - 1 : null
  const ready = current != null && ma20 != null && roc5 != null && roc20 != null && ma20Slope != null

  let state: RateTrendState = 'insufficient'
  if (ready) {
    const sustainedUp = ma60 != null && ma60Slope != null
      && current > ma20 && ma20 > ma60
      && roc5 > 0 && roc20 > 0 && roc60 != null && roc60 > 0
      && ma20Slope > 0 && ma60Slope > 0
    const sustainedDown = ma60 != null && ma60Slope != null
      && current < ma20 && ma20 < ma60
      && roc5 < 0 && roc20 < 0 && roc60 != null && roc60 < 0
      && ma20Slope < 0 && ma60Slope < 0
    if (sustainedUp) state = 'strong_up'
    else if (sustainedDown) state = 'strong_down'
    else if (current > ma20 && roc20 > 0 && ma20Slope > 0) state = 'up'
    else if (current < ma20 && roc20 < 0 && ma20Slope < 0) state = 'down'
    else state = 'flat'
  }

  return { state, roc5, roc20, roc60, ma20Slope, ma60Slope }
}

function RateChart({ rows, symbol }: { rows: ExchangeRateRow[]; symbol: string }) {
  const points = useMemo(() => {
    return dailyRowsBySymbol(rows, symbol).slice(-180)
  }, [rows, symbol])

  if (points.length === 0) {
    return <div className="grid h-48 place-items-center rounded-card bg-elevated/30 text-sm text-muted">当前日期范围没有 {symbol} 数据</div>
  }

  const values = points.map(point => point.rate)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const spread = Math.max(max - min, Math.abs(max) * 0.01, 0.0001)
  const plotMin = min - spread * 0.15
  const plotMax = max + spread * 0.15
  const chartWidth = 1200
  const chartHeight = 220
  const plotLeft = 58
  const plotRight = 1188
  const plotTop = 12
  const plotBottom = 180
  const x = (index: number) => plotLeft + (index / Math.max(points.length - 1, 1)) * (plotRight - plotLeft)
  const y = (value: number) => plotTop + ((plotMax - value) / (plotMax - plotMin)) * (plotBottom - plotTop)
  const polyline = points.map((point, index) => `${x(index)},${y(point.rate)}`).join(' ')
  const gridValues = [plotMax, (plotMax + plotMin) / 2, plotMin]
  const xTickIndices = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])]

  return (
    <div className="rounded-card border border-border bg-base/30 p-2">
      <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} className="block h-auto w-full" role="img" aria-label={`${symbol} 历史汇率曲线`}>
        {gridValues.map((value, index) => (
          <g key={value}>
            <line x1={plotLeft} x2={plotRight} y1={y(value)} y2={y(value)} stroke="hsl(var(--border) / 0.7)" strokeWidth="1" />
            <line x1={plotLeft - 5} x2={plotLeft} y1={y(value)} y2={y(value)} stroke="hsl(var(--fg-muted) / 0.85)" strokeWidth="1" />
            <text x={plotLeft - 8} y={y(value) + 4} textAnchor="end" fill="hsl(var(--fg-muted))" fontSize="10">{formatRate(symbol, value)}</text>
            {index === 0 && <text x={plotLeft} y="10" fill="hsl(var(--fg-muted))" fontSize="10">{symbol}</text>}
          </g>
        ))}
        <line x1={plotLeft} x2={plotLeft} y1={plotTop} y2={plotBottom} stroke="hsl(var(--fg-muted) / 0.85)" strokeWidth="1" />
        <line x1={plotLeft} x2={plotRight} y1={plotBottom} y2={plotBottom} stroke="hsl(var(--fg-muted) / 0.85)" strokeWidth="1" />
        {xTickIndices.map(index => (
          <g key={points[index].date}>
            <line x1={x(index)} x2={x(index)} y1={plotBottom} y2={plotBottom + 5} stroke="hsl(var(--fg-muted) / 0.85)" strokeWidth="1" />
            <text x={x(index)} y={plotBottom + 19} textAnchor="middle" fill="hsl(var(--fg-muted))" fontSize="10">{points[index].date}</text>
          </g>
        ))}
        <polyline points={polyline} fill="none" stroke="hsl(var(--accent))" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(points.length - 1)} cy={y(points[points.length - 1].rate)} r="3.5" fill="hsl(var(--accent))" />
      </svg>
      <div className="flex items-center justify-between text-[10px] text-muted">
        <span>展示最近 {points.length} 个数据点</span>
        <span className="font-mono">最新 {formatRate(symbol, points[points.length - 1].rate)}</span>
      </div>
    </div>
  )
}

export function ExchangeRates() {
  const qc = useQueryClient()
  const [startDate, setStartDate] = useState(defaultStartDate)
  const [endDate, setEndDate] = useState(() => localDate())
  const [selectedSymbol, setSelectedSymbol] = useState('USD/CNY')
  const [intervalInput, setIntervalInput] = useState('3')
  const [editingInterval, setEditingInterval] = useState(false)
  const trendStartDate = defaultStartDate()
  const trendEndDate = localDate()

  const status = useDataStatus({ staleTime: 30_000, refetchInterval: 60_000 })
  const prefs = usePreferences()
  const matrix = useCapabilityMatrix()
  const history = useQuery({
    queryKey: [...QK.exchangeRate, startDate, endDate],
    queryFn: () => api.exchangeRate({ startDate, endDate, limit: 10_000 }),
    enabled: startDate <= endDate,
    placeholderData: previous => previous,
  })
  const trendHistory = useQuery({
    queryKey: [...QK.exchangeRate, trendStartDate, trendEndDate],
    queryFn: () => api.exchangeRate({ startDate: trendStartDate, endDate: trendEndDate, limit: 10_000 }),
    placeholderData: previous => previous,
  })

  const sync = useMutation({
    mutationFn: () => api.exchangeRateSync(),
    onSuccess: result => {
      qc.invalidateQueries({ queryKey: QK.dataStatus })
      qc.invalidateQueries({ queryKey: QK.exchangeRate })
      toast(`汇率同步完成 · ${result.rows_written} 行已落盘`, 'success')
    },
    onError: (error: Error) => toast(`汇率同步失败: ${error.message}`, 'error'),
  })

  const stats = status.data?.exchange_rate
  const rows = history.data?.items ?? []
  const snapshotRows = trendHistory.data?.items ?? rows
  const latestRows = useMemo(() => latestRowsBySymbol(snapshotRows), [snapshotRows])
  const trends = useMemo(
    () => new Map(RATE_ITEMS.map(item => [item.symbol, buildRateTrend(snapshotRows, item.symbol)])),
    [snapshotRows],
  )
  const latestRetrievedAt = useMemo(
    () => [...latestRows.values()].reduce<string | null>((latest, row) => (
      !latest || row.retrieved_at > latest ? row.retrieved_at : latest
    ), null),
    [latestRows],
  )
  const selectedRows = useMemo(
    () => rows.filter(row => row.symbol === selectedSymbol).sort((a, b) => b.date.localeCompare(a.date)),
    [rows, selectedSymbol],
  )
  const provider = providerLabel(prefs.data?.exchange_rate_data_provider)
  const intervalHours = prefs.data?.exchange_rate_interval_hours ?? 3
  const canSync = routeCapUsable(matrix.data, 'exchange_rate') !== false
  const rangeValid = startDate <= endDate
  const rangeBase = endDate || localDate()
  const selectedRangeMonths = [1, 6].find(months => startDate === startDateMonthsAgo(months, rangeBase))

  const setRangeMonths = (months: number) => {
    setStartDate(startDateMonthsAgo(selectedRangeMonths === months ? 12 : months, rangeBase))
  }

  useEffect(() => {
    setIntervalInput(String(intervalHours))
  }, [intervalHours])

  const updateSchedule = useMutation({
    mutationFn: (hours: number) => api.updateExchangeRateSchedule(hours),
    onSuccess: result => {
      qc.invalidateQueries({ queryKey: QK.preferences })
      qc.invalidateQueries({ queryKey: QK.dataStatus })
      setIntervalInput(String(result.interval_hours))
      setEditingInterval(false)
      toast(`已设置为每 ${result.interval_hours} 小时拉取一次`, 'success')
    },
    onError: (error: Error) => toast(`调度更新失败: ${error.message}`, 'error'),
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="汇率"
        subtitle="当前参考快照 · 历史日频数据"
        right={(
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => sync.mutate()}
              disabled={!canSync || sync.isPending}
              className="inline-flex items-center gap-1.5 rounded-btn border border-border bg-elevated px-3 py-1.5 text-xs text-secondary transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {sync.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              同步最新
            </button>
          </div>
        )}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto max-w-7xl space-y-4">
          <section className="flex flex-wrap items-start justify-between gap-3 rounded-card border border-border bg-surface px-4 py-3">
            <div className="flex min-w-0 items-start gap-2">
              <Activity className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
              <div className="min-w-0 text-xs leading-5 text-secondary">
                <div>
                  当前源：<span className="font-medium text-foreground">{provider}</span>
                  <span className="mx-1 text-muted">·</span>
                  每 <span className="font-mono text-foreground">{intervalHours}</span> 小时检查一次
                  <span className="mx-1 text-muted">·</span>
                  数据日期 {stats?.latest_date ?? '—'}{latestRetrievedAt ? ` ${formatUpdateTime(latestRetrievedAt)}` : ''}
                </div>
                <div className="text-[11px] text-muted">
                  OXR 只提供 latest 当前参考快照；历史日期范围固定走 Frankfurter / CFETS 日频数据，不代表交易级实时行情。
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
              {editingInterval ? (
                <>
                  <label className="inline-flex items-center gap-1.5 text-muted">
                    <Clock className="h-3.5 w-3.5" />
                    更新频率
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={intervalInput}
                      onChange={event => setIntervalInput(event.target.value)}
                      className="w-16 rounded-btn border border-border bg-base px-2 py-1.5 font-mono text-foreground outline-none focus:border-accent"
                      aria-label="汇率更新频率（小时）"
                      autoFocus
                    />
                    小时
                  </label>
                  <button
                    type="button"
                    onClick={() => updateSchedule.mutate(Math.max(1, Math.floor(Number(intervalInput) || 1)))}
                    disabled={updateSchedule.isPending}
                    className="rounded-btn bg-accent px-2.5 py-1.5 text-xs font-medium text-base transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {updateSchedule.isPending ? '保存中…' : '保存'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIntervalInput(String(intervalHours))
                      setEditingInterval(false)
                    }}
                    disabled={updateSchedule.isPending}
                    className="rounded-btn border border-border bg-elevated px-2.5 py-1.5 text-xs text-secondary transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    取消
                  </button>
                </>
              ) : (
                <div className="inline-flex items-center gap-2 text-muted">
                  <Clock className="h-3.5 w-3.5" />
                  <span>更新频率</span>
                  <span className="font-mono text-foreground">每 {intervalHours} 小时</span>
                  <button
                    type="button"
                    onClick={() => {
                      setIntervalInput(String(intervalHours))
                      setEditingInterval(true)
                    }}
                    className="text-accent transition-colors hover:text-accent/80"
                  >
                    编辑
                  </button>
                </div>
              )}
              <Link to="/settings?tab=data-sources" className="text-accent hover:text-accent/80">配置数据源</Link>
              {!canSync && <MissingCapChip capKey="exchange_rate" />}
            </div>
          </section>

          <section className="rounded-card border border-border bg-surface p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">最新快照</h2>
                <p className="mt-0.5 text-[11px] text-muted">来源与数据日期按货币对展示</p>
              </div>
              <span className="text-[11px] text-muted">已落盘 {stats?.rows?.toLocaleString() ?? 0} 行</span>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
              {RATE_ITEMS.map(item => {
                const row = latestRows.get(item.symbol)
                const rate = stats?.latest_rates?.[item.symbol] ?? row?.rate
                const source = stats?.sources?.[item.symbol] ?? row?.source
                const date = row?.date ?? stats?.latest_date
                const trend = trends.get(item.symbol)
                const trendMeta = TREND_META[trend?.state ?? 'insufficient']
                return (
                  <button
                    key={item.symbol}
                    type="button"
                    onClick={() => setSelectedSymbol(item.symbol)}
                    className={`min-w-0 rounded-btn border p-3 text-left transition-colors ${selectedSymbol === item.symbol ? 'border-accent/60 bg-accent/10' : 'border-border/60 bg-elevated/35 hover:border-accent/40'}`}
                    aria-pressed={selectedSymbol === item.symbol}
                  >
                    <div className="truncate text-[11px] text-muted">{item.label}</div>
                    <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground">{formatRate(item.symbol, rate)}</div>
                    <div className={`mt-1 text-[10px] font-medium ${trendMeta.className}`}>{trendMeta.mark} {trendMeta.label}</div>
                    <div className="mt-1 flex items-center justify-between gap-1 text-[10px] text-muted">
                      <span>{sourceLabel(source)}</span>
                      <span>{date ?? '—'}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          </section>

          <section className="rounded-card border border-border bg-surface p-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">历史走势</h2>
              </div>
              <div className="flex flex-wrap items-end gap-2 text-xs">
                <div className="flex flex-wrap items-center gap-1">
                  {[{ label: '近1个月', months: 1 }, { label: '近半年', months: 6 }].map(range => (
                    <button
                      key={range.label}
                      type="button"
                      onClick={() => setRangeMonths(range.months)}
                      aria-pressed={selectedRangeMonths === range.months}
                      className={`rounded-btn border px-2 py-1.5 text-[11px] transition-colors ${selectedRangeMonths === range.months
                        ? 'border-accent/30 bg-accent/15 text-accent'
                        : 'border-border bg-elevated text-secondary hover:border-accent/40 hover:text-foreground'}`}
                    >
                      {range.label}
                    </button>
                  ))}
                </div>
                <label className="space-y-1">
                  <span className="block text-[10px] text-muted">开始日期</span>
                  <input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} className="rounded-btn border border-border bg-base px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:border-accent" />
                </label>
                <span className="pb-2 text-muted">至</span>
                <label className="space-y-1">
                  <span className="block text-[10px] text-muted">结束日期</span>
                  <input type="date" value={endDate} onChange={event => setEndDate(event.target.value)} className="rounded-btn border border-border bg-base px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:border-accent" />
                </label>
              </div>
            </div>
            {!rangeValid && <div className="mt-3 text-xs text-danger">开始日期不能晚于结束日期</div>}
            <div className="mt-4">
              {history.isLoading && <div className="grid h-48 place-items-center rounded-card bg-elevated/30 text-sm text-muted">历史数据加载中…</div>}
              {history.isError && <div className="grid h-48 place-items-center rounded-card bg-danger/5 text-sm text-danger">历史数据加载失败，请检查日期范围或数据源。</div>}
              {!history.isLoading && !history.isError && <RateChart rows={rows} symbol={selectedSymbol} />}
            </div>
          </section>

          <section className="rounded-card border border-border bg-surface p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">{selectedSymbol} 明细</h2>
                <p className="mt-0.5 text-[11px] text-muted">按日期倒序，最多展示最近 120 条</p>
              </div>
              <span className="text-[11px] text-muted">查询 {selectedRows.length} 条</span>
            </div>
            {selectedRows.length === 0 ? (
              <div className="rounded-card bg-elevated/30 px-4 py-8 text-center text-sm text-muted">暂无明细数据，请先在数据页同步日期范围。</div>
            ) : (
              <div className="max-h-[26rem] overflow-auto rounded-card border border-border/70">
                <table className="w-full min-w-[38rem] text-left text-xs">
                  <thead className="sticky top-0 bg-elevated text-[10px] text-muted">
                    <tr>
                      <th className="px-3 py-2 font-medium">日期</th>
                      <th className="px-3 py-2 font-medium">汇率</th>
                      <th className="px-3 py-2 font-medium">来源</th>
                      <th className="px-3 py-2 font-medium">频率</th>
                      <th className="px-3 py-2 font-medium">抓取时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedRows.slice(0, 120).map(row => (
                      <tr key={`${row.symbol}-${row.date}-${row.source}-${row.retrieved_at}`} className="border-t border-border/60 hover:bg-elevated/30">
                        <td className="px-3 py-2 font-mono text-secondary">{fmtDate(row.date)}</td>
                        <td className="px-3 py-2 font-mono tabular-nums text-foreground">{formatRate(row.symbol, row.rate)}</td>
                        <td className="px-3 py-2 text-secondary">{sourceLabel(row.source)}</td>
                        <td className="px-3 py-2 text-muted">{row.frequency || '—'}</td>
                        <td className="px-3 py-2 font-mono text-muted">{formatRetrievedAt(row.retrieved_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
