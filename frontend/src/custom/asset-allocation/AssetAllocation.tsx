import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Check, ChevronDown, History, ListPlus, Loader2, PieChart, Plus, RefreshCw, Save, Search, Settings, Trash2, X } from 'lucide-react'
import * as echarts from 'echarts'
import { Modal } from '@/components/Modal'
import { NumericInput } from '@/components/NumericInput'
import { PageHeader } from '@/components/PageHeader'
import { StockMarketTrendAnalysis } from '@/components/StockMarketTrendPanel'
import { toast } from '@/components/Toast'
import { WatchlistGroupMenu } from '@/components/WatchlistAddMenu'
import { api, type AllocationPortfolio, type AllocationResult, type AllocationTracking, type AllocationTrackingHistory } from '@/lib/api'
import { INDEX_PAGE_ITEMS } from '@/lib/indexSymbols'
import { cnToday } from '@/lib/kline'
import { QK } from '@/lib/queryKeys'

const MARKET_BENCHMARK = INDEX_PAGE_ITEMS[0]

const initial: AllocationPortfolio = { name: '新配置', symbols: [], initial_capital: 100_000, lookback: 252, max_weight: .35, auto_refresh: true, rebalance: 'daily_threshold', threshold: .10 }
const trackingDefinition = (p: AllocationPortfolio) => [p.scheme_id ?? null, p.symbols, p.lookback, p.max_weight, p.threshold ?? .10]
const pct = (n: number) => `${(n * 100).toFixed(2)}%`
const scoreText = (value: number | null | undefined) => value == null ? '—' : value.toFixed(2)
const money = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const validCapital = (value: number | null | undefined) => value != null && Number.isInteger(value) && value >= 1 && value < 1_000_000_000_000
const control = 'h-9 w-full rounded-lg border border-border bg-base px-3 text-sm text-foreground outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 disabled:opacity-40'
const button = 'inline-flex shrink-0 whitespace-nowrap min-h-9 items-center justify-center gap-2 rounded-lg border border-border bg-elevated px-3 py-2 text-xs font-medium text-secondary transition-colors hover:border-accent/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40'
const primary = button + ' border-accent bg-accent text-white hover:bg-accent/90 hover:text-white'
const card = 'rounded-xl border border-border bg-surface'
const tableStyle = 'w-full text-left text-xs [&_th]:py-3 [&_th]:font-medium [&_th]:text-muted [&_td]:py-3 [&_tbody_tr]:border-t [&_tbody_tr]:border-border'
const table = tableStyle + ' min-w-[540px] [&_th]:px-4 [&_td]:px-4'
const allocationColors = ['bg-accent', 'bg-cyan-400', 'bg-violet-400', 'bg-amber-400', 'bg-emerald-400', 'bg-pink-400']

function hasPerformanceHistory(result: AllocationResult | undefined): result is AllocationResult & { history: NonNullable<AllocationResult['history']> } {
  return result?.history != null
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="block min-w-0 space-y-2">
    <span className="block text-xs font-medium text-secondary">{label}</span>
    {children}
    {hint && <span className="block text-[11px] leading-5 text-muted">{hint}</span>}
  </label>
}

function ScoreAllocation({ result, totalPosition }: { result: AllocationResult; totalPosition: number }) {
  const rows = result.etf_allocations
  const cash = result.cash_weight
  const showAmounts = result.cash_amount != null
  return <section className={card} aria-label="魔鬼操盘手总仓位">
    <div className="flex flex-wrap items-center justify-between gap-4 p-5">
      <div>
        <h2 className="text-sm font-semibold">魔鬼操盘手 · 总仓位上限</h2>
        <p className="mt-1 text-xs text-muted">市场环境5日均分 {scoreText(result.market_score)} · {result.market_regime} · 截至 {result.as_of}</p>
        <p className="mt-1 text-[11px] text-muted">环境分 ≤ 60：70% · &gt; 60：90%</p>
        <p className="mt-1 text-[11px] text-muted">市场环境分和 ETF 得分均取最近 5 个交易日均值；市场趋势栏显示当日分。</p>
      </div>
      <strong className="font-mono text-3xl text-accent">{pct(totalPosition)}</strong>
    </div>
    {rows && cash != null && <div className="border-t border-border">
      <div className="flex flex-wrap gap-x-5 gap-y-2 px-5 py-3 text-xs">
        <span>ETF 合计 <strong className="font-mono">{pct(1 - cash)}</strong></span>
        <span>现金 <strong className="font-mono">{pct(cash)}</strong>{result.cash_amount != null && <span className="ml-2 font-mono text-muted">{money.format(result.cash_amount)}</span>}</span>
      </div>
      <div className="px-5 pb-4">
        <div className="flex h-3 overflow-hidden rounded-full bg-elevated" role="img" aria-label={`目标配比：${rows.map(row => `${result.names[row.symbol] ?? row.symbol} ${pct(row.weight)}`).join('、')}、现金 ${pct(cash)}`}>
          {rows.map((row, index) => <span key={row.symbol} className={`h-full shrink-0 ${allocationColors[index % allocationColors.length]}`} style={{ width: `${Math.max(0, Math.min(1, row.weight)) * 100}%` }} />)}
          <span className="h-full shrink-0 bg-muted/50" style={{ width: `${Math.max(0, Math.min(1, cash)) * 100}%` }} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
          {rows.map((row, index) => {
            const name = result.names[row.symbol] ?? row.symbol
            return <div key={row.symbol} className="flex min-w-0 items-center gap-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${allocationColors[index % allocationColors.length]}`} />
              <span className="min-w-0 flex-1 truncate text-[11px] text-secondary" title={name}>{name}</span>
              <strong className="shrink-0 font-mono text-[11px] font-medium">{pct(row.weight)}</strong>
            </div>
          })}
          <div className="flex min-w-0 items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-muted/50" />
            <span className="flex-1 text-[11px] text-secondary">现金</span>
            <strong className="shrink-0 font-mono text-[11px] font-medium">{pct(cash)}</strong>
          </div>
        </div>
      </div>
      {rows.length ? <div className="overflow-x-auto">
        <table className={tableStyle + ' [&_th]:px-4 [&_td]:px-4'} aria-label="ETF 目标配比">
          <thead><tr><th>ETF</th><th>5日平均得分</th><th>目标仓位</th>{showAmounts && <th>目标金额</th>}</tr></thead>
          <tbody>{rows.map(row => <tr key={row.symbol}>
            <td>{result.names[row.symbol] ?? row.symbol}<p className="mt-1 font-mono text-[10px] text-muted">{row.symbol}</p></td>
            <td className="whitespace-nowrap font-mono">{row.score == null ? <span className="text-muted">数据不足</span> : scoreText(row.score)}</td>
            <td className="font-mono font-semibold text-accent">{pct(row.weight)}</td>
            {showAmounts && <td className="whitespace-nowrap font-mono">{row.amount == null ? '—' : money.format(row.amount)}</td>}
          </tr>)}</tbody>
        </table>
      </div> : <p className="px-5 pb-4 text-xs text-muted">添加 ETF 后可计算目标配比。</p>}
    </div>}
  </section>
}

const trackingReasons = { initial: '确定初始目标', position_change: '总仓位上限变化', deviation: 'ETF 偏离超过阈值' }
const tradeReasons = { attack: '进攻信号', retreat: '撤退信号' }
const pp = (value: number) => (value * 100).toFixed(2)
const signedPp = (value: number) => `${value > 0 ? '+' : ''}${pp(value)}`

function defaultTrackingRange() {
  const end = cnToday()
  const start = new Date(`${end}T00:00:00Z`)
  const day = start.getUTCDate()
  start.setUTCDate(1)
  start.setUTCMonth(start.getUTCMonth() - 6)
  const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate()
  start.setUTCDate(Math.min(day, lastDay))
  return { start: start.toISOString().slice(0, 10), end }
}

function TrackingHistory({ draft }: { draft: AllocationPortfolio }) {
  const [history, setHistory] = useState<AllocationTrackingHistory>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [expandedDate, setExpandedDate] = useState<string>()
  const [tradeModel, setTradeModel] = useState<'scheme' | 'equal'>('scheme')
  const [fee, setFee] = useState(0)
  const [slippage, setSlippage] = useState(0)
  const [dateRange, setDateRange] = useState(defaultTrackingRange)
  const runVersion = useRef(0)
  const { start, end } = dateRange
  const threshold = draft.threshold ?? .10
  const valid = draft.symbols.length > 0 && !!start && !!end && start <= end
    && draft.max_weight > 0 && draft.max_weight <= 1 && threshold > 0 && threshold <= 1
    && fee >= 0 && fee < 10 && slippage >= 0 && slippage < 10

  function changeCost(setCost: (value: number) => void, value: number) {
    runVersion.current += 1
    setCost(value)
    setPending(false)
    setHistory(undefined)
    setError('')
  }

  function changeDate(field: 'start' | 'end', value: string) {
    runVersion.current += 1
    setDateRange(current => ({ ...current, [field]: value }))
    setPending(false)
    setHistory(undefined)
    setError('')
  }

  async function run() {
    const version = ++runVersion.current
    setPending(true)
    setError('')
    setHistory(undefined)
    setExpandedDate(undefined)
    try {
      const result = await api.allocationTrackingHistory({ ...draft, start, end, fee: fee / 100, slippage: slippage / 100 })
      if (version === runVersion.current) setHistory(result)
    } catch (error) {
      if (version === runVersion.current) setError(error instanceof Error ? error.message : '回看计算失败，请重试。')
    } finally {
      if (version === runVersion.current) setPending(false)
    }
  }

  const nameOf = (symbol: string) => history?.names[symbol] ?? symbol
  const firstBuy = history?.trades?.find(trade => trade.model === 'scheme' && trade.side === 'buy')
  const selectedTrades = history?.trades?.filter(trade => trade.model === tradeModel) ?? []
  const realizedPnl = selectedTrades.reduce((total, trade) => total + (trade.realized_pnl ?? 0), 0)
  const formatPnl = (value: number) => draft.initial_capital != null
    ? money.format(draft.initial_capital * value)
    : pct(value)
  return <section className="space-y-4" aria-label="历史调仓回看">
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="开始日期">
        <input aria-label="回看开始日期" className={control} type="date" value={start} max={end || undefined} onChange={e => changeDate('start', e.target.value)} />
      </Field>
      <Field label="结束日期">
        <input aria-label="回看结束日期" className={control} type="date" value={end} min={start || undefined} max={cnToday()} onChange={e => changeDate('end', e.target.value)} />
      </Field>
      <Field label="单边费率（%）" hint="填写 0.02 表示按每次买卖金额收取 0.02%。">
        <NumericInput aria-label="回看单边费率" className={control} min="0" max="9.99" step=".01" value={fee} onValueChange={value => changeCost(setFee, value ?? 0)} />
      </Field>
      <Field label="滑点（%）" hint="按实际买卖金额计入成本。">
        <NumericInput aria-label="回看滑点" className={control} min="0" max="9.99" step=".01" value={slippage} onValueChange={value => changeCost(setSlippage, value ?? 0)} />
      </Field>
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <button className={primary} disabled={!valid || pending} onClick={() => void run()}>
        {pending ? <Loader2 size={14} className="animate-spin" /> : <History size={14} />}
        {pending ? '正在回看调仓历史…' : '回看调仓历史'}
      </button>
      <p className="text-xs text-muted">所选 {start || '—'} 至 {end || '—'} · 单只上限 {pct(draft.max_weight)} · 触发偏离 {pp(threshold)} 个百分点</p>
    </div>
    {!valid && <p className="text-xs text-muted">请选择 ETF 和有效的起止日期，并检查单只上限、触发偏离和交易成本。</p>}
    {pending && <p role="status" className="text-xs text-muted">正在计算各交易日的评分、调仓和收益。</p>}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    {history && <>
      <div className="space-y-2 rounded-lg bg-base p-3 text-xs text-secondary">
        <p>所选区间 {start} 至 {end}</p>
        <p>实际覆盖 {history.start} 至 {history.end} · {history.sessions} 个交易日</p>
        <p>初始目标 {history.events[0]?.date ?? '—'} · 目标更新 {Math.max(0, history.events.length - 1)} 次 · 缺分 {history.skipped.length} 天</p>
        <p>目标变化仅用于后续进攻信号买入，现有持仓等各 ETF 自己的信号再操作。</p>
        {history.history && <p>魔鬼操盘手首次买入 {firstBuy?.date ?? '未买入'}</p>}
        {!history.events.length && <p className="text-warning">回看区间内没有市场和所有 ETF 评分都齐全的交易日，无法确定目标仓位。</p>}
      </div>
      {history.performance_error && <p role="alert" className="rounded-lg bg-warning/10 p-3 text-xs text-warning">收益与回撤暂不可用：{history.performance_error}</p>}
      {history.history && <Performance history={history.history} initialCapital={draft.initial_capital} title="收益与回撤" schemeName="魔鬼操盘手" tracking />}
      {history.trades && <details className="rounded-lg border border-border p-3 text-xs">
        <summary className="cursor-pointer">模拟成交 · {history.trades.length} 笔</summary>
        {history.trades.length > 0 ? <div className="mt-3 space-y-3">
          <div className="flex items-center gap-2" role="tablist" aria-label="模拟成交组合">
            {(['scheme', 'equal'] as const).map(model => <button key={model} type="button" role="tab" aria-selected={tradeModel === model}
              className={`min-w-20 rounded-lg border px-4 py-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${tradeModel === model ? 'border-accent bg-accent text-white shadow-md shadow-accent/25 ring-2 ring-accent/50' : 'border-border bg-elevated text-secondary hover:border-accent/50 hover:text-foreground'}`}
              onClick={() => setTradeModel(model)}>
              {model === 'scheme' ? '方案' : '等权对照'}
            </button>)}
            <span className="ml-auto text-muted">累计已实现盈亏 <strong className={realizedPnl > 0 ? 'text-danger' : realizedPnl < 0 ? 'text-emerald-400' : 'text-muted'}>{realizedPnl > 0 ? '+' : ''}{formatPnl(realizedPnl)}</strong></span>
          </div>
          <p className="text-[11px] text-muted">卖出盈亏已计入费率、滑点和持有期间分红。</p>
          <div className="max-h-80 overflow-auto">
            <table className={table} aria-label="模拟成交">
              <thead><tr><th>日期</th><th>ETF</th><th>成交</th><th>原因</th><th>收盘价</th><th>成交后仓位</th><th>卖出盈亏</th></tr></thead>
              <tbody>{selectedTrades.map(trade => <tr key={`${trade.date}:${trade.symbol}`}>
                <td>{trade.date}</td><td>{nameOf(trade.symbol)}</td>
                <td>{trade.side === 'buy' ? '买入' : '卖出'}</td><td>{tradeReasons[trade.reason]}</td><td>{trade.price}</td><td>{pct(trade.weight)}</td>
                <td className="whitespace-nowrap font-mono">{trade.realized_pnl == null ? '—' : <span className={trade.realized_pnl > 0 ? 'text-danger' : trade.realized_pnl < 0 ? 'text-emerald-400' : 'text-muted'}>{trade.realized_pnl > 0 ? '+' : ''}{formatPnl(trade.realized_pnl)}</span>}</td>
              </tr>)}</tbody>
            </table>
            {!selectedTrades.length && <p className="py-3 text-muted">该组合在此区间没有模拟成交。</p>}
          </div>
        </div> : <p className="mt-2 text-muted">本区间没有产生模拟成交。</p>}
      </details>}
      {history.events.length > 0 && <div className="overflow-x-auto rounded-lg border border-border">
        <table className={tableStyle + ' min-w-[540px] [&>thead_th]:whitespace-nowrap [&>thead_th]:px-3 [&>tbody>tr>td]:px-3'} aria-label="历史调仓事件">
          <thead><tr><th>日期</th><th>触发原因</th><th>总仓位上限</th><th>最大偏离（百分点）</th><th>明细</th></tr></thead>
          <tbody>{history.events.map(event => <Fragment key={event.date}>
            <tr>
              <td className="whitespace-nowrap font-mono">{event.date}</td>
              <td className="whitespace-nowrap">{trackingReasons[event.reason]}</td>
              <td className="whitespace-nowrap font-mono">{event.previous_position == null ? '—' : pct(event.previous_position)} → {pct(event.total_position)}</td>
              <td className="font-mono">{event.max_deviation == null ? '—' : pp(event.max_deviation)}</td>
              <td><button type="button" className="whitespace-nowrap text-accent" aria-label={`${event.date} 仓位明细`}
                aria-expanded={expandedDate === event.date} onClick={() => setExpandedDate(expandedDate === event.date ? undefined : event.date)}>
                {expandedDate === event.date ? '收起明细' : '仓位明细'}
              </button></td>
            </tr>
            {expandedDate === event.date && <tr className="bg-base"><td colSpan={5}>
                <p className="mt-2 text-muted">市场环境5日均分 {scoreText(event.market_score)}</p>
                <table className={tableStyle + ' mt-2 [&_th]:p-1 [&_td]:p-1'} aria-label={`${event.date} 仓位明细`}>
                  <thead><tr><th>标的</th><th>5日均分</th><th>原目标</th><th>新目标</th><th>变动（百分点）</th><th>等权目标</th></tr></thead>
                  <tbody className="whitespace-nowrap">
                    {event.etf_allocations.map(row => <tr key={row.symbol}>
                      <td>{nameOf(row.symbol)} <span className="text-muted">{row.symbol}</span></td><td>{scoreText(row.score)}</td>
                      <td>{pct(row.previous_weight)}</td><td>{pct(row.weight)}</td><td>{signedPp(row.change)}</td><td>{pct(row.equal_weight)}</td>
                    </tr>)}
                    <tr><td>现金</td><td>—</td><td>{pct(event.previous_cash)}</td><td>{pct(event.cash_weight)}</td><td>{signedPp(event.cash_weight - event.previous_cash)}</td><td>{pct(event.equal_cash_weight)}</td></tr>
                  </tbody>
                </table>
            </td></tr>}
          </Fragment>)}</tbody>
        </table>
      </div>}
      {history.skipped.length > 0 && <details className="rounded-lg border border-border p-3 text-xs">
        <summary className="cursor-pointer text-warning">数据不足 · {history.skipped.length} 天未更新目标</summary>
        <ul className="mt-2 max-h-60 space-y-1 overflow-auto text-secondary">
          {history.skipped.map(day => <li key={day.date}>{day.date} · {[
            ...(day.market_missing ? ['市场环境评分'] : []),
            ...day.symbols.map(symbol => `${nameOf(symbol)}（${symbol}）`),
          ].join('、')}</li>)}
        </ul>
      </details>}
    </>}
  </section>
}

function Performance({ history, initialCapital, title, schemeName, tracking = false }: {
  history: NonNullable<AllocationResult['history']>; initialCapital?: number | null; title: string; schemeName: string; tracking?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [metric, setMetric] = useState<'return' | 'drawdown'>('return')
  const primaryHistory = history.scheme
  const start = primaryHistory.points[0]?.date
  const end = primaryHistory.points.at(-1)?.date
  const benchmark = useQuery({
    queryKey: QK.indexDaily('000001.SH', start ?? '', end ?? ''),
    queryFn: () => api.indexDaily('000001.SH', 120, { start: start!, end: end! }),
    enabled: tracking && !!start && !!end,
    staleTime: 5 * 60_000,
  })
  const benchmarkRows = benchmark.data?.rows
  useEffect(() => {
    const chart = echarts.init(ref.current!)
    const dates = primaryHistory.points.map(point => point.date)
    const indexByDate = new Map((benchmarkRows ?? []).map(row => [row.date.slice(0, 10), row]))
    const showBenchmark = tracking && indexByDate.size > 0
    const series = [
      { name: schemeName, data: primaryHistory, style: 'solid' },
      { name: '等权对照', data: history.equal, style: 'dashed' },
    ] as const
    const format = (value: number) => tracking ? pct(value) : initialCapital == null ? String(value) : money.format(value)
    chart.setOption({
      color: ['#3b82f6', '#94a3b8', '#ef4444'],
      grid: { left: 46, right: showBenchmark ? 52 : 18, top: 36, bottom: 30 },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (value: unknown) => {
          if (Array.isArray(value) && value.length >= 4 && value.every(item => Number.isFinite(Number(item)))) {
            const [open, close, low, high] = value.map(Number)
            return `开 ${open.toFixed(2)} · 收 ${close.toFixed(2)} · 低 ${low.toFixed(2)} · 高 ${high.toFixed(2)}`
          }
          return value == null ? '—' : format(Number(value))
        },
      },
      legend: { data: [...series.map(item => item.name), ...(showBenchmark ? ['上证指数 K 线'] : [])], textStyle: { color: '#94a3b8', fontSize: 11 } },
      xAxis: { type: 'category', boundaryGap: showBenchmark, data: dates, axisLabel: { color: '#94a3b8', fontSize: 10 }, axisTick: { show: false } },
      yAxis: [
        { type: 'value', scale: true, axisLabel: { color: '#94a3b8', fontSize: 10, formatter: tracking || initialCapital != null ? format : undefined }, splitLine: { lineStyle: { color: '#94a3b8', opacity: .12 } } },
        ...(showBenchmark ? [{ type: 'value' as const, scale: true, position: 'right' as const, axisLabel: { color: '#94a3b8', fontSize: 10, formatter: (value: number) => Math.round(value).toString() }, splitLine: { show: false } }] : []),
      ],
      series: [
        ...series.map(({ name, data, style }) => ({
          name, type: 'line' as const, showSymbol: data.points.length === 1,
          lineStyle: { width: 2, type: style },
          data: tracking
            ? data.points.map(p => metric === 'drawdown' ? p.drawdown : p.value - 1)
            : data.points.map(p => initialCapital == null ? p.value : p.value * initialCapital),
        })),
        ...(showBenchmark ? [{
          name: '上证指数 K 线', type: 'candlestick' as const, yAxisIndex: 1,
          data: dates.map(date => {
            const row = indexByDate.get(date)
            return row ? [row.open, row.close, row.low, row.high] : [null, null, null, null]
          }),
          itemStyle: { color: '#ef4444', color0: '#22c55e', borderColor: '#ef4444', borderColor0: '#22c55e' },
          barMaxWidth: 8,
        }] : []),
      ],
    })
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(ref.current!)
    return () => { observer.disconnect(); chart.dispose() }
  }, [initialCapital, schemeName, primaryHistory, history.equal, tracking, metric, benchmarkRows])
  return <section className={card}>
    <div className="border-b border-border px-4 py-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-[11px] text-muted">{primaryHistory.points[0]?.date} 至 {primaryHistory.points.at(-1)?.date} · {tracking ? '按信号当日收盘价模拟成交，含设置的交易成本' : initialCapital == null ? '净值从 1 开始' : `资金 ${money.format(initialCapital)}，曲线显示资产金额`}</p>
      {tracking && <p className="mt-1 text-[11px] text-muted">两组使用同一套进攻和撤退信号，目标更新只影响后续进攻买入。等权组按总仓位上限平分，各 ETF 受单只上限约束。上证指数 K 线使用右侧点位轴。</p>}
      {tracking && benchmark.isError && <p role="status" className="mt-1 text-[11px] text-warning">上证指数 K 线暂不可用。</p>}
      {tracking && benchmark.isSuccess && !benchmarkRows?.length && <p role="status" className="mt-1 text-[11px] text-warning">所选区间没有上证指数 K 线数据。</p>}
    </div>
    <div className="grid grid-cols-2 gap-3 p-4">
      {(['scheme', 'equal'] as const).map(model => {
        const data = model === 'equal' ? history.equal : primaryHistory
        return <div key={model} className="rounded-lg bg-base p-3">
          <p className="text-[11px] text-muted">{model === 'equal' ? '等权对照' : schemeName} · 累计收益</p>
          <p className="mt-1 font-mono text-xl font-semibold">{pct(data.return)}</p>
          {initialCapital != null && <>
            <p className="mt-2 text-[11px] text-muted">期末资产 <span className="font-mono text-secondary">{money.format(initialCapital * (1 + data.return))}</span></p>
            <p className="mt-1 text-[11px] text-muted">累计盈亏 <span className="font-mono text-secondary">{money.format(initialCapital * data.return)}</span></p>
          </>}
          <p className="mt-2 text-[11px] text-muted">最大回撤 <span className="font-mono text-secondary">{pct(data.drawdown)}</span></p>
        </div>
      })}
    </div>
    {tracking && <div className="flex gap-2 px-4" role="group" aria-label="收益图表切换">
      {(['return', 'drawdown'] as const).map(key => <button key={key} type="button" aria-pressed={metric === key}
        className={metric === key ? primary : button} onClick={() => setMetric(key)}>{key === 'return' ? '累计收益曲线' : '回撤曲线'}</button>)}
    </div>}
    <div ref={ref} className="h-64 w-full px-2 pb-3" role={tracking ? 'img' : undefined}
      aria-label={tracking ? `${benchmarkRows?.length ? '上证指数 K 线及' : ''}${metric === 'return' ? '两组累计收益曲线' : '两组回撤曲线'}` : undefined} />
  </section>
}

export default function AssetAllocation() {
  const client = useQueryClient()
  const schemes = useQuery({ queryKey: QK.allocationSchemes, queryFn: api.allocationSchemes })
  const portfolios = useQuery({ queryKey: QK.allocationPortfolios, queryFn: api.allocationPortfolios })
  const tracking = useQuery({ queryKey: QK.allocationTracking, queryFn: api.allocationTracking, refetchInterval: 30000 })
  const [draft, setDraft] = useState<AllocationPortfolio>(initial)
  const [id, setId] = useState('')
  const [portfolioMenuOpen, setPortfolioMenuOpen] = useState(false)
  const [configNameDialog, setConfigNameDialog] = useState<'create' | 'rename' | null>(null)
  const [configNameInput, setConfigNameInput] = useState('')
  const [initialCapitalInput, setInitialCapitalInput] = useState('')
  const portfolioMenuRef = useRef<HTMLDivElement>(null)
  const initialPortfolioHandled = useRef(false)
  const autoCalculatedPortfolio = useRef('')
  const portfolioInteraction = useRef(false)
  const [tab, setTab] = useState<'configure' | 'history'>('configure')
  const [q, setQ] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [allocationCalculating, setAllocationCalculating] = useState(false)
  const [result, setResult] = useState<AllocationResult>()
  const search = useQuery({ queryKey: QK.etfPool({ page: 1, pageSize: 20, category: '', q }), queryFn: () => api.etfPool({ page: 1, pageSize: 20, category: '', q }), enabled: q.trim().length > 0 })
  const watchlist = useQuery({ queryKey: QK.watchlist, queryFn: () => api.watchlistList(), staleTime: 30_000 })
  const watchlistEntries = useMemo(
    () => (watchlist.data?.symbols ?? []).filter(entry => entry.asset_type === 'etf'),
    [watchlist.data],
  )
  const watchlistCounts = useMemo(() => {
    const counts: Record<string, number> = { ungrouped: 0 }
    for (const entry of watchlistEntries) {
      const groups = entry.group_ids ?? []
      if (groups.length === 0) counts.ungrouped += 1
      else for (const groupId of groups) counts[groupId] = (counts[groupId] ?? 0) + 1
    }
    return counts
  }, [watchlistEntries])
  const names = useQuery({ queryKey: QK.instrumentNames(draft.symbols), queryFn: () => api.instrumentNames(draft.symbols), enabled: draft.symbols.length > 0 && typeof api.instrumentNames === 'function' })
  const nameOf = (symbol: string) => names.data?.names[symbol] ?? watchlistEntries.find(entry => entry.symbol === symbol)?.name ?? search.data?.rows.find(row => row.symbol === symbol)?.name ?? result?.names[symbol] ?? symbol
  useEffect(() => {
    if (!portfolioMenuOpen) return
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!portfolioMenuRef.current?.contains(event.target as Node)) setPortfolioMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPortfolioMenuOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [portfolioMenuOpen])
  function update(next: AllocationPortfolio, userInitiated = true) {
    if (userInitiated) portfolioInteraction.current = true
    setDraft(next); setResult(undefined); setError(''); setNotice('')
  }
  function importFromWatchlist(groupId: string | null) {
    const entries = groupId === 'all'
      ? watchlistEntries
      : groupId == null
        ? watchlistEntries.filter(entry => !(entry.group_ids?.length))
        : watchlistEntries.filter(entry => !!entry.group_ids?.includes(groupId))
    if (entries.length === 0) return
    update({ ...draft, symbols: Array.from(new Set([...draft.symbols, ...entries.map(entry => entry.symbol)])) })
  }
  function selectPortfolio(key: string, automatic = false) {
    if (!automatic) portfolioInteraction.current = true
    const next = key ? { ...portfolios.data![key] } : { ...initial }
    delete next.updated_at
    setId(key); setQ(''); setPortfolioMenuOpen(false); update(next, false)
  }
  function submitConfigName() {
    const name = configNameInput.trim()
    if (!name) return
    if (configNameDialog === 'create') {
      const initialCapital = Number(initialCapitalInput)
      if (!validCapital(initialCapital)) return
      const next = { ...initial, name, initial_capital: initialCapital, scheme_id: schemes.data?.default_scheme_id }
      const key = crypto.randomUUID()
      setId(key); setQ(''); setPortfolioMenuOpen(false); setTab('configure')
      update(next)
      setConfigNameDialog(null)
      void action(async () => {
        client.setQueryData(QK.allocationPortfolios, await api.allocationSave(key, next))
        toast('配置已创建并保存。', 'success')
      })
      return
    }
    update({ ...draft, name })
    setConfigNameDialog(null)
  }
  useEffect(() => {
    if (initialPortfolioHandled.current || portfolios.isLoading || portfolios.isFetching || (portfolios.error && !portfolios.data)) return
    initialPortfolioHandled.current = true
    if (portfolioInteraction.current) return
    const entries = Object.entries(portfolios.data || {})
    if (!entries.length) {
      setConfigNameInput('')
      setInitialCapitalInput(String(initial.initial_capital))
      setConfigNameDialog('create')
      return
    }
    const [latestId] = entries.reduce((latest, entry) => {
      const latestTime = Date.parse(latest[1].updated_at || '') || 0
      const entryTime = Date.parse(entry[1].updated_at || '') || 0
      return entryTime >= latestTime ? entry : latest
    })
    const latest = { ...portfolios.data![latestId] }
    delete latest.updated_at
    setId(latestId); setQ(''); setDraft(latest); setPortfolioMenuOpen(false)
    setResult(undefined); setError(''); setNotice('')
  }, [portfolios.data, portfolios.error, portfolios.isFetching, portfolios.isLoading])
  const action = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('')
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }, [])
  const saved = id ? portfolios.data?.[id] : undefined
  const schemeId = draft.scheme_id ?? schemes.data?.default_scheme_id ?? ''
  const schemeOptions = schemes.data?.schemes ?? {}
  const scheme = Object.hasOwn(schemeOptions, schemeId) ? schemeOptions[schemeId] : undefined
  const schemeReady = scheme?.ready === true
  const schemePositionReady = scheme?.position_ready === true
  const currentWeightsReady = scheme?.current_weights_ready === true
  const canReplayTracking = schemeId === 'devil_trader' && currentWeightsReady
  const schemeName = scheme?.name ?? '未选择方案'
  const schemeHint = schemes.isLoading ? '正在加载方案…'
    : currentWeightsReady ? undefined
    : scheme && schemePositionReady && !schemeReady ? `${schemeName}当前先按环境得分确定总仓位，ETF拆分规则待补充。`
    : scheme && !schemeReady ? `${schemeName}的规则待补充。`
    : !scheme ? '请选择可用的配置方案。' : undefined
  const definition = (p: AllocationPortfolio) => JSON.stringify([p.name, trackingDefinition(p), p.initial_capital ?? null, p.auto_refresh ?? false, p.rebalance ?? 'monthly'])
  const dirty = !saved || definition(saved) !== definition(draft)
  const recommendation = tracking.data?.[id]
  const tracked = !dirty && schemeReady && recommendation?.scheme_id === schemeId ? recommendation : undefined
  const refreshTracking = () => client.invalidateQueries({ queryKey: QK.allocationTracking })
  const feasible = draft.symbols.length * draft.max_weight >= 1 - 1e-9
  const capitalReady = id ? draft.initial_capital == null || validCapital(draft.initial_capital) : validCapital(draft.initial_capital)
  const canAllocate = draft.symbols.length > 0 && feasible && capitalReady && schemeReady
  const canCalculateTargets = schemePositionReady || canAllocate
  const canCalculate = currentWeightsReady ? capitalReady && draft.max_weight > 0 && draft.max_weight <= 1 : canCalculateTargets
  const calculateTargets = useCallback(async () => {
    setAllocationCalculating(true)
    try {
      await action(async () => {
        setResult(undefined)
        setResult(await api.allocationCalculate('optimize', { ...draft, scheme_id: schemeId }))
      })
    } finally {
      setAllocationCalculating(false)
    }
  }, [action, draft, schemeId])
  useEffect(() => {
    if (busy || !initialPortfolioHandled.current || !id || !saved || !canCalculate || autoCalculatedPortfolio.current === id) return
    autoCalculatedPortfolio.current = id
    void calculateTargets()
  }, [busy, calculateTargets, canCalculate, id, saved])
  const failure = error || schemes.error?.message || portfolios.error?.message || tracking.error?.message || search.error?.message
  const tabs = [
    { id: 'configure', label: '配置仓位', icon: PieChart },
    { id: 'history', label: '历史回测', icon: History },
  ] as const
  return <div className="flex h-full min-h-0 flex-col">
    <PageHeader title="资产配置" className="shrink-0 pl-16 md:pl-5" subtitle="选好 ETF 和配置方案，再查看资金配比、调仓建议与历史表现。" right={
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
        <button className={button} disabled={busy} onClick={() => { portfolioInteraction.current = true; setConfigNameInput(''); setInitialCapitalInput(String(initial.initial_capital)); setConfigNameDialog('create') }}><Plus size={14} />新建配置</button>
        <div ref={portfolioMenuRef} className="relative flex min-w-0 items-center gap-2">
          <button type="button" className={button + ' w-[132px] justify-between'} aria-label={`配置 ${draft.name || '新配置'}，打开配置列表`} aria-expanded={portfolioMenuOpen} aria-controls={portfolioMenuOpen ? 'allocation-portfolio-menu' : undefined} disabled={busy} onClick={() => { portfolioInteraction.current = true; setPortfolioMenuOpen(open => !open) }}>
            <span className="min-w-0 flex-1 truncate" title={draft.name}>{draft.name || '新配置'}</span><ChevronDown size={14} />
          </button>
          {portfolioMenuOpen && <div id="allocation-portfolio-menu" role="group" aria-label="已保存配置" className="absolute right-0 top-full z-50 mt-2 max-h-80 w-64 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-xl">
            {portfolios.isLoading && <p className="px-3 py-2 text-xs text-muted">加载配置…</p>}
            {!portfolios.isLoading && Object.entries(portfolios.data || {}).map(([key, portfolio]) => <button key={key} type="button" aria-current={id === key ? 'true' : undefined} className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-xs hover:bg-elevated" onClick={() => selectPortfolio(key)}>
              <span className="min-w-0 truncate">{portfolio.name}</span>{id === key && <Check size={14} className="shrink-0 text-accent" />}
            </button>)}
            {!portfolios.isLoading && Object.keys(portfolios.data || {}).length === 0 && <p className="px-3 py-2 text-xs text-muted">暂无已保存配置。</p>}
          </div>}
        </div>
      </div>
    } />
    <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
      <fieldset disabled={busy} className="mx-auto min-w-0 w-full max-w-[1440px] space-y-4">
        <div className="grid items-center gap-4 lg:grid-cols-3">
          <section className={card + ' flex flex-wrap items-center gap-3 p-2'}>
            <div className="flex min-w-0 flex-1 basis-48 items-center gap-2">
              <span className="min-w-0 truncate text-sm text-foreground" title={draft.name}>{draft.name}</span>
              <button type="button" aria-label="编辑配置名称" title="编辑配置名称" className="shrink-0 rounded-md p-1.5 text-muted transition-colors hover:bg-elevated hover:text-foreground" disabled={busy} onClick={() => { setConfigNameInput(draft.name); setConfigNameDialog('rename') }}>
                <Settings size={14} />
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button className={button} disabled={busy || !draft.name.trim() || !capitalReady} onClick={() => {
                portfolioInteraction.current = true
                void action(async () => {
                  const key = id || crypto.randomUUID()
                  const next = { ...draft, scheme_id: schemeId || undefined }
                  const updated = await api.allocationSave(key, next)
                  const trackingChanged = saved && JSON.stringify(trackingDefinition(saved)) !== JSON.stringify(trackingDefinition(next))
                  if (trackingChanged) {
                    await client.cancelQueries({ queryKey: QK.allocationTracking })
                    client.setQueryData<Record<string, AllocationTracking>>(QK.allocationTracking, previous => {
                      const next = { ...previous }
                      delete next[key]
                      return next
                    })
                  }
                  client.setQueryData(QK.allocationPortfolios, updated)
                  setId(key)
                  setDraft(next)
                  if (trackingChanged) void refreshTracking()
                  toast('配置已保存。', 'success')
                })
              }}><Save size={14} />保存配置</button>
              <button aria-label="删除配置" title="删除配置" className={button + ' hover:text-danger'} disabled={busy || !id || !saved} onClick={() => action(async () => {
                if (!window.confirm('删除这个已保存配置？')) return
                client.setQueryData(QK.allocationPortfolios, await api.allocationDelete(id)); setId(''); update(initial)
              })}><Trash2 size={14} /></button>
            </div>
            {portfolios.isLoading && <p className="w-full text-[11px] text-muted">加载配置…</p>}
          </section>
          <section className={card + ' min-w-0 lg:col-span-2'} aria-label="市场环境">
            <StockMarketTrendAnalysis symbol={MARKET_BENCHMARK.symbol} asOf={cnToday()} assetType="index" compact />
          </section>
        </div>
        {failure && <div role="alert" className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs leading-6 text-danger">{failure}</div>}
        {notice && <div role="status" className="flex items-center gap-2 text-xs text-accent"><Check size={14} />{notice}</div>}
        <div role="tablist" aria-label="资产配置功能" className="flex gap-1 border-b border-border">
          {tabs.map(item => <button role="tab" aria-selected={tab === item.id} aria-controls={`allocation-${item.id}`} id={`tab-${item.id}`} key={item.id} onClick={() => setTab(item.id)}
            className={`inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-3 text-xs font-medium transition-colors ${tab === item.id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-foreground'}`}>
            <item.icon size={14} />{item.label}
          </button>)}
        </div>
        {busy && !allocationCalculating && <p role="status" className="flex items-center gap-2 text-xs text-accent"><Loader2 size={14} className="animate-spin" />正在处理，请稍候…</p>}

        {tab === 'configure' && <div id="allocation-configure" role="tabpanel" aria-labelledby="tab-configure" className="grid items-start gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
          <section className={card + ' min-w-0'}>
            <div className="border-b border-border px-4 py-3"><h2 className="text-sm font-semibold">ETF 与配置参数</h2><p className="mt-1 text-[11px] text-muted">按选定方案计算各只 ETF 的目标仓位。</p></div>
            <div className="space-y-4 p-4">
              <div className="relative"><Search size={14} className="pointer-events-none absolute left-3 top-3 text-muted" />
                <input aria-label="搜索 ETF" className={control + ' pl-9'} placeholder="搜索 ETF 名称或代码" value={q} onChange={e => { portfolioInteraction.current = true; setQ(e.target.value) }} />
                {q && <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-lg border border-border bg-base shadow-xl">
                  {search.isFetching && <p className="p-3 text-xs text-muted">搜索中…</p>}
                  {search.data?.rows.map(row => <button key={row.symbol} disabled={draft.symbols.includes(row.symbol)} className="flex w-full items-center justify-between gap-3 border-b border-border px-3 py-2 text-left last:border-0 hover:bg-elevated disabled:opacity-40" onClick={() => { update({ ...draft, symbols: [...draft.symbols, row.symbol] }); setQ('') }}>
                    <span className="min-w-0"><span className="block truncate text-xs">{row.name}</span><span className="font-mono text-[10px] text-muted">{row.symbol}</span></span>{draft.symbols.includes(row.symbol) ? <Check size={14} /> : <Plus size={14} className="text-accent" />}
                  </button>)}
                  {!search.isFetching && search.data?.rows.length === 0 && <p className="p-3 text-xs text-muted">没有匹配的 ETF，试试六位代码。</p>}
                </div>}
              </div>
              <div><div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <p className="text-xs text-muted">已选 ETF <span className="font-mono text-secondary">{draft.symbols.length}</span></p>
                  <button
                    type="button"
                    aria-label="清空已选 ETF"
                    title="清空已选 ETF"
                    disabled={draft.symbols.length === 0}
                    onClick={() => update({ ...draft, symbols: [] })}
                    className="inline-flex items-center gap-1 whitespace-nowrap rounded-input border border-border bg-surface px-1.5 py-1 text-[10px] text-secondary transition-colors hover:border-danger/50 hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <X className="h-2.5 w-2.5" />清空
                  </button>
                </div>
                <WatchlistGroupMenu
                  onSelect={importFromWatchlist}
                  disabled={watchlist.isLoading || watchlistEntries.length === 0}
                  includeAll
                  counts={watchlistCounts}
                  total={watchlistEntries.length}
                  disableEmpty
                  menuLabel="导入自选ETF分组"
                  align="right"
                  triggerClassName="inline-flex items-center gap-1 whitespace-nowrap rounded-input border border-border bg-surface px-2 py-1.5 text-[11px] text-secondary transition-colors hover:border-accent/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  title="选择自选分组并导入 ETF"
                  ariaLabel="从自选分组导入 ETF"
                >
                  <ListPlus className="h-3 w-3" />
                  {watchlist.isLoading ? '加载…' : `导入自选ETF(${watchlistEntries.length})`}
                </WatchlistGroupMenu>
              </div>
                {draft.symbols.length ? <div className="divide-y divide-border">{draft.symbols.map(symbol => <div key={symbol} className="flex items-center justify-between gap-2 py-2">
                  <div className="min-w-0"><p className="truncate text-xs font-medium">{nameOf(symbol)}</p><p className="font-mono text-[10px] text-muted">{symbol}</p></div>
                  <button aria-label={`移除 ${symbol}`} className="rounded-md p-1.5 text-muted hover:bg-elevated hover:text-danger" onClick={() => update({ ...draft, symbols: draft.symbols.filter(s => s !== symbol) })}><X size={14} /></button>
                </div>)}</div> : <div className="rounded-lg border border-dashed border-border p-5 text-center text-xs leading-6 text-muted">搜索并添加 ETF<br />也可以先选择上方已保存的配置。</div>}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="资金（元）" hint="按权重分配资金，金额需为整数">
                  <NumericInput aria-label="资金" className={control + ' font-mono'} min="1" max="999999999999" step="1" value={draft.initial_capital} allowEmpty onValueChange={value => update({ ...draft, initial_capital: value ?? undefined })} />
                </Field>
                <Field label="单只仓位上限（%）" hint="限制任意一只的配置比例">
                  <NumericInput aria-label="单只上限" className={control + ' font-mono'} min="1" max="100" step="any" value={draft.max_weight * 100} onValueChange={value => update({ ...draft, max_weight: (value ?? 0) / 100 })} />
                </Field>
              </div>
              {!currentWeightsReady && !feasible && draft.symbols.length > 0 && <p className="rounded-lg bg-warning/10 p-3 text-xs leading-5 text-warning">当前最多配置 {pct(draft.symbols.length * draft.max_weight)}，请增加 ETF 或提高单只上限，使合计可达到 100%。</p>}
              <Field label="配置方案" hint={schemeHint}>
                <select aria-label="配置方案" className={control} value={schemeId} onChange={e => update({ ...draft, scheme_id: e.target.value || null })}>
                  <option value="" disabled>请选择配置方案</option>
                  {schemeId && !scheme && <option value={schemeId} disabled>方案已不可用</option>}
                  {Object.entries(schemeOptions).map(([value, option]) => <option key={value} value={value}>{option.name}</option>)}
                </select>
              </Field>
              <button className={primary + ' w-full'} disabled={busy || !canCalculate} onClick={() => void calculateTargets()}>
                <PieChart size={14} />更新目标仓位<ArrowRight size={14} />
              </button>
              <p className="text-[11px] leading-5 text-muted">使用最近完整收盘数据。调整标的或参数后，点击“更新目标仓位”刷新结果。</p>
            </div>
          </section>
          <section className="min-w-0 space-y-4" aria-label="仓位结果">
            {allocationCalculating ? <div role="status" className={card + ' flex min-h-[360px] flex-col items-center justify-center px-6 py-12 text-center'}>
              <div className="mb-5 rounded-2xl bg-accent/10 p-4 text-accent"><Loader2 size={28} className="animate-spin" strokeWidth={1.5} /></div>
              <h2 className="text-sm font-semibold">正在计算目标仓位</h2>
              <p className="mt-2 max-w-sm text-xs leading-6 text-muted">正在根据最近完整收盘数据计算，请稍候…</p>
            </div> : result && result.total_position != null ? <ScoreAllocation result={result} totalPosition={result.total_position} />
              : hasPerformanceHistory(result) && result.weights && result.risk_contribution ? <>
              <section className={card}>
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                  <div>
                    <h2 className="text-sm font-semibold">目标仓位与等权对照</h2>
                    <p className="mt-1 text-[11px] text-muted">数据截至 {result.as_of} · 有效收益 {result.samples} 期</p>
                  </div>
                  <span className="rounded-md bg-accent/10 px-2 py-1 font-mono text-xs text-accent">合计 {pct(result.weights!.reduce((a, b) => a + b, 0))}</span>
                </div>
                <div className="overflow-x-auto">
                  <table className={table} aria-label="目标仓位与等权对照">
                    <thead><tr>
                      <th>ETF</th>
                      <th>{schemeName} 目标</th>
                      {result.target_amounts && <th>{schemeName} 金额</th>}
                      <th>波动风险贡献</th>
                      <th className="border-l border-border">等权对照</th>
                      <th>相对等权</th>
                    </tr></thead>
                    <tbody>{result.parameters.symbols.map((symbol, i) => <tr key={symbol} className="transition-colors hover:bg-accent/10">
                      <td><p>{result.names[symbol] ?? symbol}</p><p className="mt-1 font-mono text-[10px] text-muted">{symbol}</p></td>
                      <td className="font-mono font-semibold text-accent">{pct(result.weights![i])}</td>
                      {result.target_amounts && <td className="whitespace-nowrap font-mono">{money.format(result.target_amounts.scheme[i])}</td>}
                      <td className="font-mono">{pct(result.risk_contribution![i])}</td>
                      <td className="border-l border-border font-mono">{pct(1 / result.parameters.symbols.length)}</td>
                      <td className="font-mono">{((result.weights![i] - 1 / result.parameters.symbols.length) * 100).toFixed(2)}%</td>
                    </tr>)}</tbody>
                  </table>
                </div>
              </section>
              <Performance title="当前配置历史表现 · 样本内回看" history={result.history} initialCapital={result.parameters.initial_capital} schemeName={schemeName} />
              <p className="text-[11px] leading-5 text-muted">以上使用整个样本期算出的当前权重回看历史。若要评估逐日使用当时数据调仓的效果，请进入“历史回测”。</p>
              <button className={button} onClick={() => setTab('history')}><History size={14} />查看历史回测<ArrowRight size={14} /></button>
            </> : <div className={card + ' flex min-h-[360px] flex-col items-center justify-center px-6 py-12 text-center'}>
              <div className="mb-5 rounded-2xl bg-accent/10 p-4 text-accent"><PieChart size={28} strokeWidth={1.5} /></div>
              <h2 className="text-sm font-semibold">{result ? '计算结果暂不可用' : schemePositionReady && !currentWeightsReady ? '等待总仓位' : '等待目标仓位'}</h2>
              <p className="mt-2 max-w-sm text-xs leading-6 text-muted">{result ? '请点击“更新目标仓位”重试，或检查配置方案是否完整。' : currentWeightsReady ? '加载已保存配置后会自动计算仓位。添加 ETF 或调整参数后，点击“更新目标仓位”。' : schemePositionReady ? '加载已保存配置后会自动计算总仓位；修改配置后可点击“更新目标仓位”。' : '选择 ETF 和规则完整的配置方案后会自动计算目标仓位；调整标的或参数后，点击“更新目标仓位”。这里会显示资金配比、风险贡献和历史表现。'}</p>
            </div>}
          </section>
        </div>}

        {tab === 'history' && <section id="allocation-history" role="tabpanel" aria-labelledby="tab-history" className={card + ' p-4 sm:p-5 space-y-5'}>
          <div><h2 className="text-sm font-semibold">{canReplayTracking ? '历史调仓回测' : '跟踪仓位偏离，查看调仓建议'}</h2><p className="mt-2 text-xs leading-6 text-muted">配置方案：{schemeName}。{canReplayTracking ? '期初持有现金。按近 5 个交易日均分确定仓位目标，总仓位上限变化或目标占比超过触发偏离时更新目标。已有持仓保持不变，每只 ETF 只在自己的进攻信号按新目标买入、在撤退信号清仓。' : '保存配置 → 更新建议 → 确认模拟基准。后续根据价格、分红和拆分，比较跟踪仓位与新目标。'}</p></div>
          <div className="grid gap-4 sm:grid-cols-2">
            {!canReplayTracking && <div className="rounded-lg bg-base p-4"><label className="flex cursor-pointer items-center gap-3 text-xs font-medium"><input className="accent-accent" type="checkbox" checked={draft.auto_refresh ?? false} onChange={e => update({ ...draft, auto_refresh: e.target.checked })} />每天收盘自动更新建议</label><p className="mt-2 text-[11px] leading-5 text-muted">保存后生效。系统运行时，工作日北京时间 16 点后每 15 分钟检查收盘数据。</p></div>}
            <Field label="触发偏离（百分点）" hint={canReplayTracking ? '与上一次目标配比相比，超过此差额才更新目标。' : '例如 20% 偏离到 25%，差额是 5 个百分点。'}>
              <NumericInput aria-label="触发偏离" className={control} min=".1" max="100" step=".1" value={(draft.threshold ?? .10) * 100} onValueChange={value => update({ ...draft, threshold: (value ?? 0) / 100 })} />
            </Field>
          </div>
          {canReplayTracking ? <TrackingHistory key={JSON.stringify([id, trackingDefinition(draft), draft.initial_capital])} draft={{ ...draft, scheme_id: schemeId }} /> : <>
          {(schemeHint || (currentWeightsReady && !schemeReady)) && <p className="text-xs text-warning">{schemeHint ?? '当前方案暂未开放调仓跟踪。'}</p>}
          {dirty && <p className="rounded-lg bg-warning/10 p-3 text-xs text-warning">请先保存配置，再更新调仓建议。</p>}
          <button className={primary} disabled={busy || dirty || !canAllocate} onClick={() => action(async () => { await api.allocationRefresh(id); await refreshTracking() })}><RefreshCw size={14} />更新调仓建议</button>
          {!tracked && <p className="text-xs text-muted">首次使用，先更新建议，再将目标仓位确认为模拟跟踪基准。</p>}
          {tracked && <div className="space-y-4 border-t border-border pt-4">
            <div className="flex flex-wrap items-center gap-3"><span className={`rounded-md px-2 py-1 text-xs ${tracked.status === 'error' ? 'bg-danger/10 text-danger' : 'bg-accent/10 text-accent'}`}>{{ initial: '等待建立跟踪基准', rebalance: '已触发调仓建议', hold: '偏离未达到阈值', error: '本次计算失败' }[tracked.status]}</span><span className="text-[11px] text-muted">数据截至 {tracked.as_of ?? '—'} · 检查于 {tracked.checked_at.replace('T', ' ').slice(0, 19)}</span></div>
            {tracked.error && <p role="alert" className="text-xs text-danger">{tracked.error}</p>}
            {tracked.deviation != null && <p className="text-sm">当前最大偏离 <span className="font-mono font-semibold">{(tracked.deviation * 100).toFixed(2)}</span> 个百分点</p>}
            {tracked.status !== 'error' && <>
              <div className="overflow-x-auto rounded-lg border border-border"><table className={table}><thead><tr><th>ETF</th><th>模拟跟踪仓位</th><th>最新目标</th><th>差额（百分点）</th></tr></thead><tbody>{draft.symbols.map((symbol, i) => <tr key={symbol}><td>{nameOf(symbol)}<p className="mt-1 font-mono text-[10px] text-muted">{symbol}</p></td><td className="font-mono">{tracked.current ? pct(tracked.current[i]) : '待建立'}</td><td className="font-mono text-accent">{pct(tracked.target![i])}</td><td className="font-mono">{tracked.current ? ((tracked.target![i] - tracked.current[i]) * 100).toFixed(2) : '—'}</td></tr>)}</tbody></table></div>
              <div className="flex flex-wrap items-center gap-3"><button className={button} onClick={() => action(async () => {
                if (!window.confirm('将此目标权重按所示收盘价确认为新的模拟持仓跟踪基准？')) return
                await api.allocationConfirm(id, tracked.checked_at); await refreshTracking(); setNotice('跟踪基准已更新，后续偏离将与此基准比较。')
              })}><Check size={14} />{tracked.status === 'initial' ? '建立模拟跟踪基准' : '将目标设为新基准'}</button><p className="text-[11px] text-muted">确认后，按所示收盘价建立模拟持仓，重新开始跟踪偏离。</p></div>
            </>}
          </div>}
          </>}
        </section>}

      </fieldset>
    </div>
    {configNameDialog && <Modal onClose={() => setConfigNameDialog(null)} labelledBy="allocation-config-name-title" autoFocus={false} panelClassName="w-[92vw] max-w-xl max-h-[88vh] rounded-xl border border-border bg-surface shadow-xl">
      <form onSubmit={event => { event.preventDefault(); submitConfigName() }}>
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 id="allocation-config-name-title" className="flex items-center gap-2 text-sm font-semibold">
            <Settings className="h-4 w-4 text-accent" aria-hidden="true" />
            {configNameDialog === 'create' ? '新建配置' : '编辑配置名称'}
          </h2>
          <button type="button" onClick={() => setConfigNameDialog(null)} className="rounded-md p-1 text-muted transition-colors hover:bg-elevated hover:text-foreground" aria-label="关闭配置名称对话框" title="关闭">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <div className="max-h-[calc(88vh-4rem)] overflow-y-auto p-4">
          <label className="block text-xs font-medium text-secondary"><span className="mb-2 block">配置名称</span>
            <input aria-label={configNameDialog === 'create' ? '新建配置名称' : '配置名称'} className={control} value={configNameInput} maxLength={100} required onChange={e => setConfigNameInput(e.target.value)} placeholder="输入配置名称" />
          </label>
          {configNameDialog === 'create' && <label className="mt-4 block text-xs font-medium text-secondary"><span className="mb-2 block">资金（元）</span>
            <input aria-label="新建配置资金" className={control + ' font-mono'} type="number" min="1" max="999999999999" step="1" value={initialCapitalInput} required onChange={e => setInitialCapitalInput(e.target.value)} placeholder="例如 100000" />
            <span className="mt-2 block text-[11px] leading-5 text-muted">填写正整数，默认 100,000 元。</span>
          </label>}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" className={button} onClick={() => setConfigNameDialog(null)}>取消</button>
          <button type="submit" className={primary} disabled={!configNameInput.trim() || (configNameDialog === 'create' && !validCapital(Number(initialCapitalInput)))}>{configNameDialog === 'create' ? '创建配置' : '确认'}</button>
        </div>
      </form>
    </Modal>}
  </div>
}
