import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import * as echarts from 'echarts'
import { api, type VolumeTrend } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { INDEX_PAGE_ITEMS } from '@/lib/indexSymbols'

const PAIRS = [
  { key: 'ma5/ma13', fast: 'ma5', slow: 'ma13', label: 'MA5 / MA13' },
  { key: 'ma5/ma28', fast: 'ma5', slow: 'ma28', label: 'MA5 / MA28' },
  { key: 'ma13/ma28', fast: 'ma13', slow: 'ma28', label: 'MA13 / MA28' },
] as const

const VIEW_PREFERENCES_KEY = 'volume-analysis:view-preferences:v1'
const ZOOM_STORAGE_PREFIX = 'volume-analysis:zoom:v1:'

function isPairKey(value: unknown): value is (typeof PAIRS)[number]['key'] {
  return PAIRS.some(pair => pair.key === value)
}

function readViewPreferences() {
  const defaults = { showKline: false, selectedPairs: PAIRS.map(pair => pair.key) }
  try {
    const raw = localStorage.getItem(VIEW_PREFERENCES_KEY)
    if (!raw) return defaults
    const value = JSON.parse(raw) as { showKline?: unknown; selectedPairs?: unknown }
    return {
      showKline: typeof value.showKline === 'boolean' ? value.showKline : defaults.showKline,
      selectedPairs: Array.isArray(value.selectedPairs) ? value.selectedPairs.filter(isPairKey) : defaults.selectedPairs,
    }
  } catch {
    return defaults
  }
}

function readZoomRange(symbol: string) {
  try {
    const raw = localStorage.getItem(`${ZOOM_STORAGE_PREFIX}${symbol}`)
    if (!raw) return null
    const value = JSON.parse(raw) as { start?: unknown; end?: unknown }
    const start = Number(value.start)
    const end = Number(value.end)
    return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end <= 100 && start < end
      ? { start, end }
      : null
  } catch {
    return null
  }
}

function money(value: number | null | undefined) {
  if (value == null) return '—'
  return `${(value / 1e8).toFixed(2)} 亿`
}

function TrendChart({ data, symbol, selectedPairs, showKline, onActiveDate }: { data: VolumeTrend; symbol: string; selectedPairs: Set<string>; showKline: boolean; onActiveDate: (date: string | null) => void }) {
  const node = useRef<HTMLDivElement>(null)
  const chart = useRef<echarts.ECharts | null>(null)
  const pointsRef = useRef(data.points)
  const onActiveDateRef = useRef(onActiveDate)
  const activeDateRef = useRef<string | null>(null)
  const symbolRef = useRef(symbol)
  const lastSavedZoomRef = useRef('')
  pointsRef.current = data.points
  onActiveDateRef.current = onActiveDate
  symbolRef.current = symbol
  useEffect(() => {
    if (!node.current) return
    chart.current = echarts.init(node.current)
    chart.current.on('updateAxisPointer', (event: { axesInfo?: Array<{ value?: unknown }> }) => {
      const value = event.axesInfo?.[0]?.value
      const point = pointsRef.current.find(row => row.date === String(value))
        ?? (Number.isInteger(Number(value)) ? pointsRef.current[Number(value)] : undefined)
      if (point && activeDateRef.current !== point.date) {
        activeDateRef.current = point.date
        onActiveDateRef.current(point.date)
      }
    })
    chart.current.on('globalout', () => {
      if (activeDateRef.current !== null) {
        activeDateRef.current = null
        onActiveDateRef.current(null)
      }
    })
    chart.current.on('datazoom', (event: { start?: unknown; end?: unknown; batch?: Array<{ start?: unknown; end?: unknown }> }) => {
      const payload = event.batch?.[0] ?? event
      const zoomOptions = chart.current?.getOption().dataZoom
      const currentZoom = (Array.isArray(zoomOptions) ? zoomOptions[0] : zoomOptions) as { start?: unknown; end?: unknown } | undefined
      const start = Number(payload.start ?? event.start ?? currentZoom?.start)
      const end = Number(payload.end ?? event.end ?? currentZoom?.end)
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > 100 || start >= end) return
      const range = { start: Number(start.toFixed(2)), end: Number(end.toFixed(2)) }
      const signature = `${symbolRef.current}:${range.start}:${range.end}`
      if (lastSavedZoomRef.current === signature) return
      lastSavedZoomRef.current = signature
      try {
        localStorage.setItem(`${ZOOM_STORAGE_PREFIX}${symbolRef.current}`, JSON.stringify(range))
      } catch {
        // The chart remains usable when browser storage is unavailable.
      }
    })
    const observer = new ResizeObserver(() => chart.current?.resize())
    observer.observe(node.current)
    return () => { observer.disconnect(); chart.current?.dispose(); chart.current = null }
  }, [])
  const option = useMemo<echarts.EChartsOption>(() => {
    const dates = data.points.map(point => point.date)
    const zoom = readZoomRange(symbol) ?? { start: 0, end: 100 }
    const series: echarts.SeriesOption[] = [
      { name: '成交额', type: 'bar', data: data.points.map(point => point.amount == null ? null : point.amount / 1e8),
        itemStyle: { color: '#64748b', opacity: 0.38 }, barMaxWidth: 12 },
      ...(['ma5', 'ma13', 'ma28'] as const).map((key, index) => ({
        name: key.toUpperCase(), type: 'line' as const, showSymbol: false, connectNulls: false,
        data: data.points.map(point => point[key] == null ? null : point[key]! / 1e8),
        lineStyle: { width: 2 }, itemStyle: { color: ['#8b5cf6', '#f59e0b', '#06b6d4'][index] },
      })),
      ...(showKline ? [{
        name: '指数K线', type: 'candlestick' as const, yAxisIndex: 1,
        data: data.points.map(point => point.open != null && point.close != null && point.low != null && point.high != null
          ? [point.open, point.close, point.low, point.high] : null),
        itemStyle: { color: '#ef4444', color0: '#22c55e', borderColor: '#ef4444', borderColor0: '#22c55e' },
        barMaxWidth: 8,
      }] : []),
      ...PAIRS.filter(pair => selectedPairs.has(pair.key)).flatMap(pair => (['golden', 'death'] as const).map(kind => ({
        name: `${pair.label} ${kind === 'golden' ? '金叉' : '死叉'}`,
        type: 'scatter' as const, symbol: kind === 'golden' ? 'triangle' : 'triangle',
        symbolRotate: kind === 'death' ? 180 : 0, symbolSize: 10,
        itemStyle: { color: kind === 'golden' ? '#16a34a' : '#ef4444',
          borderColor: '#fff', borderWidth: 1 },
        data: data.crosses.filter(event => event.fast === pair.fast && event.slow === pair.slow && event.kind === kind)
          .map(event => ({ value: [event.date, event.value / 1e8], provisional: event.provisional })),
      }))),
    ]
    return {
      animation: false,
      grid: { left: 62, right: 20, top: 32, bottom: 65 },
      tooltip: { trigger: 'axis', showContent: false, axisPointer: { type: 'cross' } },
      xAxis: { type: 'category', data: dates, axisLabel: { color: '#94a3b8', fontSize: 10, hideOverlap: true }, axisLine: { lineStyle: { color: '#64748b' } } },
      yAxis: [
        { type: 'value', name: '亿元', scale: true, nameTextStyle: { color: '#94a3b8', fontSize: 10 }, axisLabel: { color: '#94a3b8', fontSize: 10 }, splitLine: { lineStyle: { color: '#475569', opacity: 0.22 } } },
        ...(showKline ? [{ type: 'value' as const, scale: true, show: false, splitLine: { show: false } }] : []),
      ],
      dataZoom: [
        { type: 'inside', start: zoom.start, end: zoom.end },
        { type: 'slider', start: zoom.start, end: zoom.end, bottom: 12, height: 16, textStyle: { fontSize: 10 } },
      ],
      series,
    }
  }, [data, selectedPairs, showKline, symbol])
  useEffect(() => { chart.current?.setOption(option, true) }, [option])
  return <div ref={node} role="img" aria-label="近90个交易日指数成交额与均线趋势图" className="h-[360px] w-full" />
}

export default function VolumeAnalysis() {
  const [params, setParams] = useSearchParams()
  const requested = params.get('symbol') ?? ''
  const symbol = INDEX_PAGE_ITEMS.some(item => item.symbol === requested) ? requested : INDEX_PAGE_ITEMS[0].symbol
  const [initialPreferences] = useState(readViewPreferences)
  const [selectedPairs, setSelectedPairs] = useState<Set<string>>(() => new Set(initialPreferences.selectedPairs))
  const [showKline, setShowKline] = useState(initialPreferences.showKline)
  const [activeDate, setActiveDate] = useState<string | null>(null)
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_PREFERENCES_KEY, JSON.stringify({ showKline, selectedPairs: [...selectedPairs] }))
    } catch {
      // The controls remain usable when browser storage is unavailable.
    }
  }, [selectedPairs, showKline])
  const quotes = useQuery({
    queryKey: QK.indexQuotes,
    queryFn: () => api.indexQuotes(INDEX_PAGE_ITEMS.map(item => item.symbol)),
    refetchInterval: 30_000,
    placeholderData: previous => previous,
  })
  const quoteBySymbol = new Map((quotes.data?.rows ?? []).map(quote => [quote.symbol, quote]))
  const trend = useQuery({ queryKey: QK.volumeAnalysis(symbol), queryFn: () => api.volumeTrend(symbol),
    refetchInterval: 30_000, staleTime: 15_000 })
  const latest = trend.data?.points.at(-1)
  const activePoint = trend.data?.points.find(point => point.date === activeDate) ?? latest
  const visibleCrosses = trend.data?.crosses.filter(event => selectedPairs.has(`${event.fast}/${event.slow}`)) ?? []
  const activeCrosses = activePoint ? trend.data?.crosses.filter(event => event.date === activePoint.date && selectedPairs.has(`${event.fast}/${event.slow}`)) ?? [] : []
  return <div className="w-full space-y-4 p-3 text-[15px] md:p-4">
    <div>
      <div className="pl-9 md:pl-0"><h1 className="text-lg font-semibold text-foreground">量能分析</h1><p className="mt-1 text-xs text-muted">指数成交额 · 最近 90 个交易日</p></div>
    </div>
    <div className="grid gap-3 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <aside className="min-w-0 rounded-lg border border-border bg-surface p-2 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
        <h2 className="mb-1 px-2 text-[10px] font-medium text-muted">指数列表</h2>
        <nav aria-label="指数列表" className="flex gap-1 overflow-x-auto lg:block lg:space-y-0.5 lg:overflow-visible">
          {INDEX_PAGE_ITEMS.map(item => {
            const quote = quoteBySymbol.get(item.symbol)
            const pct = quote?.change_pct ?? quote?.pct
            const price = quote?.last_price ?? quote?.price ?? quote?.close
            return <button key={item.symbol} type="button" aria-current={symbol === item.symbol ? 'true' : undefined}
              onClick={() => setParams({ symbol: item.symbol })}
              className={`min-w-[11rem] rounded-md px-2 py-2 text-left transition-colors lg:w-full lg:min-w-0 ${symbol === item.symbol ? 'bg-accent/15 text-foreground' : 'text-secondary hover:bg-elevated'}`}>
              <span className="flex items-center justify-between gap-2"><span className="truncate text-[11px] font-medium">{item.name}</span>
                <span className={`shrink-0 font-mono text-[10px] ${pct == null ? 'text-muted' : pct > 0 ? 'text-bull' : pct < 0 ? 'text-bear' : 'text-secondary'}`}>{pct == null ? '—' : `${pct > 0 ? '+' : ''}${Number(pct).toFixed(2)}%`}</span></span>
              <span className="mt-0.5 flex items-center justify-between gap-2 font-mono text-[10px] text-muted"><span>{item.symbol}</span><span>{price == null ? '—' : Number(price).toFixed(2)}</span></span>
            </button>
          })}
        </nav>
      </aside>
      <main className="min-w-0 space-y-4">
    <h2 className="text-sm font-semibold text-foreground">{INDEX_PAGE_ITEMS.find(item => item.symbol === symbol)?.name} <span className="ml-2 font-mono text-[11px] font-normal text-muted">{symbol}</span></h2>
    {trend.isPending && <div className="rounded-lg border border-border bg-surface p-8 text-center text-muted">正在加载量能数据…</div>}
    {trend.isError && <div className="rounded-lg border border-danger/30 bg-surface p-6 text-danger">量能数据加载失败。<button className="ml-2 underline" onClick={() => trend.refetch()}>重试</button></div>}
    {trend.data && trend.data.points.length === 0 && <div className="rounded-lg border border-border bg-surface p-8 text-center text-muted">暂无指数日线成交额，请先在数据页同步指数日 K。</div>}
    {trend.data && latest && <>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">{([['当日成交额', latest.amount], ['MA5', latest.ma5], ['MA13', latest.ma13], ['MA28', latest.ma28]] as const).map(([label, value]) =>
        <div key={label} className="rounded-lg border border-border bg-surface p-3"><div className="text-[10px] text-muted">{label}</div><div className="mt-1.5 text-sm font-semibold text-foreground">{money(value)}</div></div>)}</div>
      <div className="rounded-lg border border-border bg-surface p-2.5 md:p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 text-[10px] text-secondary"><input type="checkbox" checked={showKline} onChange={event => setShowKline(event.target.checked)} />叠加K线</label>
            {PAIRS.map(pair => <label key={pair.key} className="flex items-center gap-1 text-[10px] text-secondary"><input type="checkbox" checked={selectedPairs.has(pair.key)} onChange={() => setSelectedPairs(current => { const next = new Set(current); next.has(pair.key) ? next.delete(pair.key) : next.add(pair.key); return next })} />{pair.label}</label>)}
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-[10px] text-secondary" aria-label="图表图例">
            <span className="inline-flex items-center gap-1"><i className="h-2.5 w-3.5 rounded-sm bg-slate-500/60" />成交额</span>
            <span className="inline-flex items-center gap-1"><i className="relative h-0.5 w-5 bg-violet-500 after:absolute after:left-1/2 after:top-1/2 after:h-2 after:w-2 after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-full after:border-2 after:border-violet-500 after:bg-surface" />MA5</span>
            <span className="inline-flex items-center gap-1"><i className="relative h-0.5 w-5 bg-amber-500 after:absolute after:left-1/2 after:top-1/2 after:h-2 after:w-2 after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-full after:border-2 after:border-amber-500 after:bg-surface" />MA13</span>
            <span className="inline-flex items-center gap-1"><i className="relative h-0.5 w-5 bg-cyan-500 after:absolute after:left-1/2 after:top-1/2 after:h-2 after:w-2 after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-full after:border-2 after:border-cyan-500 after:bg-surface" />MA28</span>
            {showKline && <span className="inline-flex items-center gap-1"><i className="h-2.5 w-3 rounded-sm bg-red-500" />指数K线</span>}
          </div>
        </div>
        <div className="mb-1.5 flex min-h-5 items-center gap-2 overflow-x-auto whitespace-nowrap text-[10px] text-muted" aria-live="polite">
          {activePoint && <><span className="font-mono text-secondary">{activePoint.date}{activePoint.provisional ? ' · 盘中未确认' : ''}</span>
            <span>成交额 {money(activePoint.amount)}</span><span>MA5 {money(activePoint.ma5)}</span><span>MA13 {money(activePoint.ma13)}</span><span>MA28 {money(activePoint.ma28)}</span>
            {showKline && activePoint.open != null && activePoint.high != null && activePoint.low != null && activePoint.close != null && <span>开 {activePoint.open.toFixed(2)} / 高 {activePoint.high.toFixed(2)} / 低 {activePoint.low.toFixed(2)} / 收 {activePoint.close.toFixed(2)}</span>}
            {activeCrosses.map(event => <span key={`${event.fast}-${event.slow}-${event.kind}`} className={event.kind === 'golden' ? 'text-green-500' : 'text-red-500'}>{event.fast.toUpperCase()}/{event.slow.toUpperCase()} {event.kind === 'golden' ? '金叉' : '死叉'}{event.provisional ? ' · 未确认' : ''}</span>)}</>}
        </div>
        <TrendChart data={trend.data} symbol={symbol} selectedPairs={selectedPairs} showKline={showKline} onActiveDate={setActiveDate} />
        <div className="mt-1.5 text-[10px] text-muted">绿色▲金叉，红色▼死叉；今天的标记随盘中成交额变化，仅供观察。</div>
      </div>
      <section className="rounded-lg border border-border bg-surface p-3"><h2 className="text-xs font-medium text-foreground">交叉记录</h2><div className="mt-2 max-h-40 space-y-1.5 overflow-auto text-[11px] text-secondary">
        {visibleCrosses.length ? [...visibleCrosses].reverse().map(event => <div key={`${event.date}-${event.fast}-${event.slow}`} className="flex flex-wrap justify-between gap-2 border-b border-border/60 pb-2"><span>{event.date} · {event.fast.toUpperCase()}/{event.slow.toUpperCase()}</span><span className={event.kind === 'golden' ? 'text-green-600' : 'text-red-500'}>{event.kind === 'golden' ? '金叉' : '死叉'}{event.provisional ? ' · 未确认' : ''}</span></div>) : <div className="text-muted">所选组合在当前窗口无交叉</div>}
      </div></section>
    </>}
      </main>
    </div>
  </div>
}
