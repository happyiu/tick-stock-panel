import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Clock, LineChart, Loader2, Lock, RefreshCw } from 'lucide-react'
import { api, type IndexInstrument, type KlinePeriod, type MinuteKlineRow, type StrategyDetail } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { cnDateFromUtc } from '@/lib/format'
import { useCapabilities } from '@/lib/useSharedQueries'
import { StockPanel } from '@/components/StockPanel'
import { toOHLC, type ChartSignalSelection } from '@/components/StockDailyKChart'
import { StrategyPickerDialog } from '@/components/screener/StrategyPickerDialog'
import { ChartSignalPickerDialog } from '@/components/screener/ChartSignalPickerDialog'
import { cnToday, defaultKlineRange, KLINE_PERIOD_OPTIONS, PERIOD_30M_DAY_OPTIONS, DEFAULT_30M_DAYS } from '@/lib/kline'
import { EChartsIntraday } from '@/components/EChartsIntraday'

function fmtPct(v: number | null | undefined) {
  if (v == null || Number.isNaN(Number(v))) return '--'
  return `${Number(v).toFixed(2)}%`
}

function fmtNum(v: number | null | undefined, digits = 2) {
  if (v == null || Number.isNaN(Number(v))) return '--'
  return Number(v).toFixed(digits)
}

const PINNED_INDEXES = [
  { symbol: '000001.SH', name: '上证指数' },
  { symbol: '399001.SZ', name: '深证成指' },
  { symbol: '399006.SZ', name: '创业板指' },
  { symbol: '000680.SH', name: '科创综指' },
]

export function Indices() {
  const qc = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const symbolParam = searchParams.get('symbol') ?? ''
  const [selected, setSelected] = useState<string>(symbolParam)
  const [range, setRange] = useState(() => defaultKlineRange('1d'))
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [view, setView] = useState<'daily' | 'intraday'>('daily')

  const [period, setPeriod] = useState<KlinePeriod>('1d')
  const [periodDays, setPeriodDays] = useState(DEFAULT_30M_DAYS)
  const [strategyPicker, setStrategyPicker] = useState(false)
  const [signalPicker, setSignalPicker] = useState(false)
  const [selectedStrategy, setSelectedStrategy] = useState<StrategyDetail | null>(null)
  const [selectedSignals, setSelectedSignals] = useState<ChartSignalSelection[]>([])
  const selectDate = useCallback((date: string | null) => setSelectedDate(date?.slice(0, 10) ?? null), [])

  // 分时数据依赖分钟K批量数据 (kline.minute.batch)
  const caps = useCapabilities()
  const hasMinuteCap = !!caps.data?.capabilities?.['kline.minute.batch']

  // 指数标的固定核心四只 (产品契约, 不再提供全指数搜索/浏览)
  const topRows: IndexInstrument[] = PINNED_INDEXES.map(p => ({
    symbol: p.symbol, name: p.name, asset_type: 'index' as const,
  }))

  const selectedSymbol = selected || topRows[0]?.symbol || ''

  useEffect(() => {
    if (symbolParam && symbolParam !== selected) setSelected(symbolParam)
  }, [selected, symbolParam])

  const selectIndex = (symbol: string) => {
    setSelected(symbol)
    setSearchParams({ symbol })
  }

  const quotes = useQuery({
    queryKey: QK.indexQuotes,
    queryFn: () => api.indexQuotes(),
    placeholderData: (prev) => prev,
  })

  const watchlist = useQuery({ queryKey: QK.watchlist, queryFn: api.watchlistList })
  const watchlistEntry = watchlist.data?.symbols.find(item => item.symbol === selectedSymbol)
  const addedDate = cnDateFromUtc(watchlistEntry?.added_at) || null
  const toggleWatchlist = useMutation({
    mutationFn: ({ remove, groupId }: { remove?: boolean; groupId?: string | null }) => remove
      ? api.watchlistRemove(selectedSymbol)
      : api.watchlistAdd(selectedSymbol, '', groupId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QK.watchlist })
      qc.invalidateQueries({ queryKey: ['watchlist-enriched'] })
    },
  })

  const minuteRange = useMemo(() => defaultKlineRange('1d', selectedDate ? new Date(`${selectedDate}T12:00:00`) : new Date()), [selectedSymbol, selectedDate])
  const daily = useQuery({
    queryKey: QK.indexDaily(selectedSymbol, minuteRange.start, minuteRange.end),
    queryFn: () => api.indexDaily(selectedSymbol, 180, minuteRange),
    enabled: view === 'intraday' && !!selectedSymbol,
  })

  const minute = useQuery({
    queryKey: QK.indexMinute(selectedSymbol, selectedDate ?? ''),
    queryFn: () => api.indexMinute(selectedSymbol, selectedDate ?? undefined),
    enabled: view === 'intraday' && !!selectedSymbol && !!selectedDate && hasMinuteCap,
  })

  const syncDaily = useMutation({
    mutationFn: () => api.syncIndexDaily(365),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QK.indexQuotes })
      qc.invalidateQueries({ queryKey: ['index-daily'] })
      qc.invalidateQueries({ queryKey: ['kline', selectedSymbol] })
      qc.invalidateQueries({ queryKey: ['kline-period', selectedSymbol] })
    },
  })

  const quoteBySymbol = useMemo(() => {
    const m = new Map<string, any>()
    for (const q of quotes.data?.rows ?? []) m.set(q.symbol, q)
    return m
  }, [quotes.data?.rows])
  const selectedQuote = selectedSymbol ? quoteBySymbol.get(selectedSymbol) : null
  const selectedQuoteValue = selectedQuote?.last_price ?? selectedQuote?.price ?? selectedQuote?.close
  const selectedQuotePct = selectedQuote?.change_pct ?? selectedQuote?.pct

  const chartRows = useMemo(() => toOHLC(daily.data?.rows ?? []), [daily.data?.rows])
  const selectedInfo = topRows.find(r => r.symbol === selectedSymbol) || daily.data?.index_info
  const minuteRows: MinuteKlineRow[] = minute.data?.symbol === selectedSymbol
    && minute.data?.date === selectedDate && daily.data?.symbol === selectedSymbol
    ? minute.data.rows : []
  const selectedIdx = selectedDate ? chartRows.findIndex(r => r.date === selectedDate) : -1
  const prevClose = selectedIdx > 0
    ? chartRows[selectedIdx - 1].close
    : chartRows.length >= 2
      ? chartRows[chartRows.length - 2].close
      : undefined

  useEffect(() => {
    setSelectedDate(null)
    setSelectedStrategy(null)
    setSelectedSignals([])
    setStrategyPicker(false)
    setSignalPicker(false)
  }, [selectedSymbol, period])

  useEffect(() => {
    if (!selectedDate && chartRows.length > 0 && daily.data?.symbol === selectedSymbol) {
      setSelectedDate(chartRows[chartRows.length - 1].date)
    }
  }, [chartRows, daily.data?.symbol, selectedDate, selectedSymbol])
  const renderIndexItem = (item: IndexInstrument) => {
    const q = quoteBySymbol.get(item.symbol)
    const pct = q?.change_pct ?? q?.pct
    const current = q?.last_price ?? q?.price ?? q?.close
    const active = item.symbol === selectedSymbol
    return (
      <button
        key={item.symbol}
        onClick={() => selectIndex(item.symbol)}
        className={`w-full rounded-btn px-2 py-2 text-left transition-colors ${active ? 'bg-accent/15 text-foreground' : 'hover:bg-elevated text-secondary'}`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs font-medium">{item.name || item.symbol}</span>
          <span className={`text-[10px] font-mono ${Number(pct ?? 0) >= 0 ? 'text-bull' : 'text-bear'}`}>{fmtPct(pct)}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between text-[10px] font-mono text-muted">
          <span>{item.symbol}</span>
          <span>{fmtNum(current)}</span>
        </div>
      </button>
    )
  }

  return (
    <div className="h-full overflow-auto bg-base p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">指数</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => syncDaily.mutate()}
            disabled={syncDaily.isPending}
            className="inline-flex items-center gap-1.5 rounded-btn bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {syncDaily.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            同步指数日K
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="rounded-card border border-border bg-surface p-3">
          <div className="mb-2 px-1 text-[11px] uppercase tracking-wider text-muted">核心指数</div>
          <div className="space-y-1">
            {topRows.map(renderIndexItem)}
          </div>
        </aside>

        <main className="min-w-0 rounded-card border border-border bg-surface p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-accent" />
                <h2 className="truncate text-sm font-semibold text-foreground">
                  {selectedInfo?.name || selectedSymbol || '未选择指数'}
                </h2>
                {selectedSymbol && <span className="font-mono text-xs text-muted">{selectedSymbol}</span>}
                {selectedSymbol && <span className="font-mono text-xs text-foreground">{fmtNum(selectedQuoteValue)}</span>}
                {selectedSymbol && <span className={`font-mono text-xs ${Number(selectedQuotePct ?? 0) >= 0 ? 'text-bull' : 'text-bear'}`}>{fmtPct(selectedQuotePct)}</span>}
              </div>
              <div className="mt-1 text-xs text-muted">
                {selectedInfo?.name}行情与技术分析
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {view === 'daily' ? (
                <>
                  <input
                    type="date"
                    aria-label="K线起始日期"
                    value={range.start}
                    onChange={e => setRange(r => ({ ...r, start: e.target.value }))}
                    className="rounded-btn border border-border bg-base px-2 py-1 text-secondary outline-none focus:border-accent"
                  />
                  <span className="text-muted">至</span>
                  <input
                    type="date"
                    aria-label="K线截止日期"
                    value={range.end}
                    onChange={e => setRange(r => ({ ...r, end: e.target.value }))}
                    className="rounded-btn border border-border bg-base px-2 py-1 text-secondary outline-none focus:border-accent"
                  />
                  <div className="inline-flex items-center rounded border border-border bg-elevated p-0.5" aria-label="K线周期">
                    {KLINE_PERIOD_OPTIONS.map(option => (
                      <button key={option.value} type="button" aria-pressed={period === option.value}
                        onClick={() => { setPeriod(option.value); setRange(defaultKlineRange(option.value, new Date(), periodDays, 'index')) }}
                        className={`h-6 rounded px-2 text-[11px] ${period === option.value ? 'bg-accent/20 text-accent' : 'text-muted hover:text-secondary'}`}>
                        {option.label}
                      </button>
                    ))}
                  </div>
                  {period === '30m' && (
                    <select aria-label="30F交易日范围" value={periodDays} onChange={event => {
                      const days = Number(event.target.value)
                      setPeriodDays(days)
                      setRange(defaultKlineRange('30m', new Date(), days, 'index'))
                    }} className="rounded-btn border border-border bg-base px-2 py-1 text-secondary">
                      {PERIOD_30M_DAY_OPTIONS.map(days => <option key={days} value={days}>{days}日</option>)}
                    </select>
                  )}
                </>
              ) : (
                <label className="flex items-center gap-2 text-muted">
                  分时日期
                  <input
                    type="date"
                    value={selectedDate ?? ''}
                    max={cnToday()}
                    onChange={e => setSelectedDate(e.target.value || null)}
                    className="rounded-btn border border-border bg-base px-2 py-1 text-secondary outline-none focus:border-accent"
                  />
                </label>
              )}
              <div role="tablist" aria-label="图表视图" className="inline-flex shrink-0 items-center rounded border border-border bg-elevated p-0.5">
                <button
                  type="button"
                  role="tab"
                  id="index-kline-tab"
                  aria-controls="index-kline-panel"
                  aria-selected={view === 'daily'}
                  onClick={() => setView('daily')}
                  className={`inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] transition-colors ${view === 'daily' ? 'bg-surface text-foreground shadow-sm' : 'text-muted hover:text-secondary'}`}
                >
                  <LineChart className="h-3 w-3" />K 线
                </button>
                <button
                  type="button"
                  role="tab"
                  id="index-intraday-tab"
                  aria-controls="index-intraday-panel"
                  aria-selected={view === 'intraday'}
                  onClick={() => setView('intraday')}
                  className={`inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] transition-colors ${view === 'intraday' ? 'bg-surface text-foreground shadow-sm' : 'text-muted hover:text-secondary'}`}
                >
                  <Clock className="h-3 w-3" />分时
                </button>
              </div>
            </div>
          </div>

          <div id="index-kline-panel" role="tabpanel" aria-labelledby="index-kline-tab" hidden={view !== 'daily'}>
            <div className="h-[780px] overflow-x-auto">
              <StockPanel
                key={selectedSymbol}
                className="min-w-[800px]"
                symbol={selectedSymbol}
                height={420}
                visibleBars={period === '30m' ? 60 : 48}
                dateRange={range}
                period={period}
                periodDays={periodDays}
                showIntraday
                rightPaneMode="technical"
                showLimitMarkers={false}
                dailyKlineFlex="flex-[1.4]"
                resizableSplit
                independentPaneScroll
                addedDate={addedDate}
                inWatchlist={!!watchlistEntry}
                onAddToWatchlist={groupId => toggleWatchlist.mutate({ groupId })}
                onRemoveFromWatchlist={() => toggleWatchlist.mutate({ remove: true })}
                watchlistPending={toggleWatchlist.isPending}
                onSelectedDateChange={selectDate}
                onAddStrategy={() => setStrategyPicker(true)}
                selectedStrategy={selectedStrategy}
                onClearStrategy={() => setSelectedStrategy(null)}
                onAddSignal={() => setSignalPicker(true)}
                selectedSignals={selectedSignals}
                onClearSignals={() => setSelectedSignals([])}
              />
            </div>
          </div>
          <div id="index-intraday-panel" role="tabpanel" aria-labelledby="index-intraday-tab" hidden={view !== 'intraday'}>
            {view === 'intraday' && (
              <div className="min-w-0" style={{ height: 620 }}>
                {!hasMinuteCap ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                    <Lock className="h-5 w-5 text-muted" />
                    <div className="text-xs text-secondary">指数分时数据不可用</div>
                    <div className="text-[10px] text-muted">分钟K(批量)数据不可用</div>
                  </div>
                ) : (
                  <>
                    {minute.isLoading && <div className="py-2 text-xs text-muted">分时加载中…</div>}
                    {minute.isError && (
                      <div role="alert" className="py-4 text-sm text-danger">
                        指数分时加载失败
                        <button type="button" onClick={() => void minute.refetch()} className="ml-2 underline">重试</button>
                      </div>
                    )}
                    {!minute.isLoading && !minute.isError && minuteRows.length === 0 && (
                      <div className="flex h-full items-center justify-center text-xs text-muted">
                        暂无分时数据
                      </div>
                    )}
                    {minuteRows.length > 0 && (
                      <EChartsIntraday
                        key={`${selectedSymbol}:${selectedDate}`}
                        data={minuteRows}
                        height={620}
                        prevClose={prevClose}
                        date={selectedDate ?? undefined}
                        showLimitLines={false}
                        showAvgLine={false}
                      />
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </main>
      </div>
      {strategyPicker && <StrategyPickerDialog open assetType="index" period={period}
        onClose={() => setStrategyPicker(false)}
        onSelect={strategy => { setSelectedStrategy(strategy); setStrategyPicker(false) }} />}
      {signalPicker && <ChartSignalPickerDialog open assetType="index" period={period} selected={selectedSignals}
        onClose={() => setSignalPicker(false)}
        onApply={signals => { setSelectedSignals(signals); setSignalPicker(false) }} />}
    </div>
  )
}
