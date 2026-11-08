import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Check, ChevronDown, Clock3, History, ListPlus, Loader2, PieChart, Plus, RefreshCw, Save, Search, Settings, Trash2, X } from 'lucide-react'
import * as echarts from 'echarts'
import { Modal } from '@/components/Modal'
import { PageHeader } from '@/components/PageHeader'
import { StockMarketTrendAnalysis } from '@/components/StockMarketTrendPanel'
import { toast } from '@/components/Toast'
import { WatchlistGroupMenu } from '@/components/WatchlistAddMenu'
import { api, type AllocationPortfolio, type AllocationResult, type AllocationTracking } from '@/lib/api'
import { INDEX_PAGE_ITEMS } from '@/lib/indexSymbols'
import { cnToday } from '@/lib/kline'
import { QK } from '@/lib/queryKeys'

const MARKET_BENCHMARK = INDEX_PAGE_ITEMS[0]

const initial: AllocationPortfolio = { name: '新配置', symbols: [], initial_capital: 100_000, lookback: 252, max_weight: .35, auto_refresh: true, rebalance: 'daily_threshold', threshold: .05 }
const trackingDefinition = (p: AllocationPortfolio) => [p.scheme_id ?? null, p.symbols, p.lookback, p.max_weight, p.threshold ?? .05]
const pct = (n: number) => `${(n * 100).toFixed(2)}%`
const money = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const validCapital = (value: number | null | undefined) => value != null && Number.isInteger(value) && value >= 1 && value < 1_000_000_000_000
const control = 'h-9 w-full rounded-lg border border-border bg-base px-3 text-sm text-foreground outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 disabled:opacity-40'
const button = 'inline-flex shrink-0 whitespace-nowrap min-h-9 items-center justify-center gap-2 rounded-lg border border-border bg-elevated px-3 py-2 text-xs font-medium text-secondary transition-colors hover:border-accent/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40'
const primary = button + ' border-accent bg-accent text-white hover:bg-accent/90 hover:text-white'
const card = 'rounded-xl border border-border bg-surface'
const tableStyle = 'w-full text-left text-xs [&_th]:py-3 [&_th]:font-medium [&_th]:text-muted [&_td]:py-3 [&_tbody_tr]:border-t [&_tbody_tr]:border-border'
const table = tableStyle + ' min-w-[540px] [&_th]:px-4 [&_td]:px-4'

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="block min-w-0 space-y-2">
    <span className="block text-xs font-medium text-secondary">{label}</span>
    {children}
    {hint && <span className="block text-[11px] leading-5 text-muted">{hint}</span>}
  </label>
}

function hasPerformanceHistory(result: AllocationResult | undefined): result is AllocationResult & { history: NonNullable<AllocationResult['history']> } {
  return result?.history != null
}

function ScoreAllocation({ result, totalPosition }: { result: AllocationResult; totalPosition: number }) {
  const rows = result.etf_allocations
  const cash = result.cash_weight
  const showAmounts = result.cash_amount != null
  return <section className={card} aria-label="魔鬼操盘手总仓位">
    <div className="flex flex-wrap items-center justify-between gap-4 p-5">
      <div>
        <h2 className="text-sm font-semibold">魔鬼操盘手 · 总仓位上限</h2>
        <p className="mt-1 text-xs text-muted">市场环境得分 {result.market_score} · {result.market_regime} · 截至 {result.as_of}</p>
        <p className="mt-1 text-[11px] text-muted">环境分 &lt; 35：50% · 35 至 &lt; 65：70% · ≥ 65：90%</p>
      </div>
      <strong className="font-mono text-3xl text-accent">{pct(totalPosition)}</strong>
    </div>
    {rows && cash != null && <div className="border-t border-border">
      <div className="flex flex-wrap gap-x-5 gap-y-2 px-5 py-3 text-xs">
        <span>ETF 合计 <strong className="font-mono">{pct(1 - cash)}</strong></span>
        <span>现金 <strong className="font-mono">{pct(cash)}</strong>{result.cash_amount != null && <span className="ml-2 font-mono text-muted">{money.format(result.cash_amount)}</span>}</span>
      </div>
      {rows.length ? <div className="overflow-x-auto">
        <table className={tableStyle + ' [&_th]:px-4 [&_td]:px-4'} aria-label="ETF 目标配比">
          <thead><tr><th>ETF</th><th>综合得分</th><th>目标仓位</th>{showAmounts && <th>目标金额</th>}</tr></thead>
          <tbody>{rows.map(row => <tr key={row.symbol}>
            <td>{result.names[row.symbol] ?? row.symbol}<p className="mt-1 font-mono text-[10px] text-muted">{row.symbol}</p></td>
            <td className="whitespace-nowrap font-mono">{row.score ?? <span className="text-muted">数据不足</span>}</td>
            <td className="font-mono font-semibold text-accent">{pct(row.weight)}</td>
            {showAmounts && <td className="whitespace-nowrap font-mono">{row.amount == null ? '—' : money.format(row.amount)}</td>}
          </tr>)}</tbody>
        </table>
      </div> : <p className="px-5 pb-4 text-xs text-muted">添加 ETF 后可计算目标配比。</p>}
    </div>}
  </section>
}

function Performance({ result, title, schemeName }: { result: AllocationResult & { history: NonNullable<AllocationResult['history']> }; title: string; schemeName: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const initialCapital = result.parameters.initial_capital
  const primaryHistory = result.history.scheme
  useEffect(() => {
    const chart = echarts.init(ref.current!)
    const series = [
      { name: schemeName, data: primaryHistory, style: 'solid' },
      { name: '等权对照', data: result.history.equal, style: 'dashed' },
    ] as const
    chart.setOption({
      color: ['#3b82f6', '#94a3b8'],
      grid: { left: 46, right: 18, top: 36, bottom: 30 },
      tooltip: { trigger: 'axis', valueFormatter: (value: unknown) => initialCapital == null ? String(value) : money.format(Number(value)) },
      legend: { data: series.map(item => item.name), textStyle: { color: '#94a3b8', fontSize: 11 } },
      xAxis: { type: 'category', boundaryGap: false, data: primaryHistory.points.map(p => p.date), axisLabel: { color: '#94a3b8', fontSize: 10 }, axisTick: { show: false } },
      yAxis: { type: 'value', scale: true, axisLabel: { color: '#94a3b8', fontSize: 10, formatter: initialCapital == null ? undefined : (value: number) => money.format(value) }, splitLine: { lineStyle: { color: '#94a3b8', opacity: .12 } } },
      series: series.map(({ name, data, style }) => ({
        name, type: 'line', showSymbol: false,
        lineStyle: { width: 2, type: style }, data: data.points.map(p => initialCapital == null ? p.value : p.value * initialCapital),
      })),
    })
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(ref.current!)
    return () => { observer.disconnect(); chart.dispose() }
  }, [initialCapital, schemeName, primaryHistory, result.history.equal])
  return <section className={card}>
    <div className="border-b border-border px-4 py-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-[11px] text-muted">{primaryHistory.points[0]?.date} 至 {primaryHistory.points.at(-1)?.date} · {initialCapital == null ? '净值从 1 开始' : `资金 ${money.format(initialCapital)}，曲线显示资产金额`}</p>
    </div>
    <div className="grid grid-cols-2 gap-3 p-4">
      {(['scheme', 'equal'] as const).map(model => {
        const data = model === 'equal' ? result.history.equal : primaryHistory
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
    <div ref={ref} className="h-64 w-full px-2 pb-3" />
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
  const [tab, setTab] = useState<'configure' | 'tracking' | 'backtest'>('configure')
  const [q, setQ] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [allocationCalculating, setAllocationCalculating] = useState(false)
  const [result, setResult] = useState<AllocationResult>()
  const [backtest, setBacktest] = useState<AllocationResult>()
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [fee, setFee] = useState(0)
  const [slippage, setSlippage] = useState(0)
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
    setDraft(next); setResult(undefined); setBacktest(undefined); setError(''); setNotice('')
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
    setResult(undefined); setBacktest(undefined); setError(''); setNotice('')
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
  const canBacktest = schemePositionReady || canAllocate
  const canCalculate = currentWeightsReady ? capitalReady && draft.max_weight > 0 && draft.max_weight <= 1 : canBacktest
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
  const datesChanged = () => setBacktest(undefined)
  const tabs = [
    { id: 'configure', label: '配置仓位', icon: PieChart },
    { id: 'tracking', label: '调仓跟踪', icon: RefreshCw },
    { id: 'backtest', label: '历史回测', icon: History },
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
            {(portfolios.isLoading || dirty) && <p className="w-full text-[11px] text-muted">{portfolios.isLoading ? '加载配置…' : '修改尚未保存。可以先试算，保存后才能启用调仓跟踪。'}</p>}
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
                  <input aria-label="资金" className={control + ' font-mono'} type="number" min="1" max="999999999999" step="1" value={draft.initial_capital ?? ''} onChange={e => update({ ...draft, initial_capital: e.target.value === '' ? undefined : Number(e.target.value) })} />
                </Field>
                <Field label="回看交易日" hint="252 个交易日约为一年">
                  <input aria-label="回看交易日" className={control + ' font-mono'} type="number" min="2" value={draft.lookback} onChange={e => update({ ...draft, lookback: Number(e.target.value) })} />
                </Field>
                <Field label="单只仓位上限（%）" hint="限制任意一只的配置比例">
                  <input aria-label="单只上限" className={control + ' font-mono'} type="number" min="1" max="100" value={draft.max_weight * 100} onChange={e => update({ ...draft, max_weight: Number(e.target.value) / 100 })} />
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
              <Performance title="当前配置历史表现 · 样本内回看" result={result} schemeName={schemeName} />
              <p className="text-[11px] leading-5 text-muted">以上使用整个样本期算出的当前权重回看历史。若要评估逐日使用当时数据调仓的效果，请进入“历史回测”。</p>
              <button className={button} onClick={() => setTab('backtest')}><History size={14} />去做历史回测<ArrowRight size={14} /></button>
            </> : <div className={card + ' flex min-h-[360px] flex-col items-center justify-center px-6 py-12 text-center'}>
              <div className="mb-5 rounded-2xl bg-accent/10 p-4 text-accent"><PieChart size={28} strokeWidth={1.5} /></div>
              <h2 className="text-sm font-semibold">{result ? '计算结果暂不可用' : schemePositionReady && !currentWeightsReady ? '等待总仓位' : '等待目标仓位'}</h2>
              <p className="mt-2 max-w-sm text-xs leading-6 text-muted">{result ? '请点击“更新目标仓位”重试，或检查配置方案是否完整。' : currentWeightsReady ? '加载已保存配置后会自动计算仓位。添加 ETF 或调整参数后，点击“更新目标仓位”。' : schemePositionReady ? '加载已保存配置后会自动计算总仓位；修改配置后可点击“更新目标仓位”。' : '选择 ETF 和规则完整的配置方案后会自动计算目标仓位；调整标的或参数后，点击“更新目标仓位”。这里会显示资金配比、风险贡献和历史表现。'}</p>
            </div>}
          </section>
        </div>}

        {tab === 'tracking' && <section id="allocation-tracking" role="tabpanel" aria-labelledby="tab-tracking" className={card + ' p-4 sm:p-5 space-y-5'}>
          <div><h2 className="text-sm font-semibold">跟踪仓位偏离，查看调仓建议</h2><p className="mt-2 text-xs leading-6 text-muted">配置方案：{schemeName}。保存配置 → 更新建议 → 确认模拟基准。后续根据价格、分红和拆分，比较跟踪仓位与新目标。</p></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg bg-base p-4"><label className="flex cursor-pointer items-center gap-3 text-xs font-medium"><input className="accent-accent" type="checkbox" checked={draft.auto_refresh ?? false} onChange={e => update({ ...draft, auto_refresh: e.target.checked })} />每天收盘自动更新建议</label><p className="mt-2 text-[11px] leading-5 text-muted">保存后生效。系统运行时，工作日北京时间 16 点后每 15 分钟检查收盘数据。</p></div>
            <Field label="触发偏离（百分点）" hint="例如 20% 偏离到 25%，差额是 5 个百分点。">
              <input aria-label="触发偏离" className={control} type="number" min=".1" max="100" step=".1" value={(draft.threshold ?? .05) * 100} onChange={e => update({ ...draft, threshold: Number(e.target.value) / 100 })} />
            </Field>
          </div>
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
        </section>}

        {tab === 'backtest' && <div id="allocation-backtest" role="tabpanel" aria-labelledby="tab-backtest" className="space-y-4">
          <section className={card + ' p-4 sm:p-5 space-y-4'}>
            <div><h2 className="text-sm font-semibold">{schemePositionReady ? '历史环境得分与总仓位' : '检验这组 ETF 的历史配置表现'}</h2><p className="mt-2 text-xs leading-6 text-muted">{schemePositionReady ? '逐个交易日按当日市场环境得分应用仓位规则，只展示目标总仓位，不模拟 ETF 拆分与成交。' : '从空仓开始，每天计算目标配比。日线进攻时买入，撤退时清仓；偏离达标只减仓，加仓等待下一次进攻。'}</p></div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {schemePositionReady ? <div className="rounded-lg border border-accent/20 bg-accent/5 p-3 text-xs leading-6 text-secondary sm:col-span-2 lg:col-span-3">环境分 &lt; 35：熊市 50% 仓位 · 35 至 &lt; 65：中性 70% 仓位 · ≥ 65：牛市 90% 仓位</div> : <div className="rounded-lg border border-accent/20 bg-accent/5 p-3 text-xs leading-6 text-secondary sm:col-span-2 lg:col-span-3">
                天使魔鬼 · 日线信号 · 当日收盘价成交<br />
                每天收盘确认信号和目标配比，先撤退卖出、再按阈值减仓，最后进攻买入。首日没有进攻信号就保持现金。收盘信号确认后按同一收盘价成交，为本回测指定的同价模拟口径。
              </div>}
              <Field label="开始日期"><input aria-label="开始日期" className={control} type="date" value={start} onChange={e => { setStart(e.target.value); datesChanged() }} /></Field>
              <Field label="结束日期"><input aria-label="结束日期" className={control} type="date" value={end} onChange={e => { setEnd(e.target.value); datesChanged() }} /></Field>
              {!schemePositionReady && <>
                <Field label="单边费率（%）" hint="填写 0.02 代表每次成交金额的 0.02%。"><input aria-label="单边费率" className={control} type="number" min="0" step=".01" value={fee} onChange={e => { setFee(Number(e.target.value)); datesChanged() }} /></Field>
                <Field label="滑点（%）" hint="模拟成交价偏差，与费率一起计入成本。"><input aria-label="滑点（%）" className={control} type="number" min="0" step=".01" value={slippage} onChange={e => { setSlippage(Number(e.target.value)); datesChanged() }} /></Field>
                <Field label="强制减仓触发偏离（百分点）" hint="任意 ETF 偏离达标后，仅将超配持仓减至目标；低配部分等进攻信号。"><input aria-label="回测触发偏离" className={control} type="number" min=".1" max="100" step=".1" value={(draft.threshold ?? .05) * 100} onChange={e => update({ ...draft, threshold: Number(e.target.value) / 100 })} /></Field>
              </>}
            </div>
            <div className="flex flex-wrap items-center gap-3"><button className={primary} disabled={busy || !start || !end || start > end || !canBacktest} onClick={() => action(async () => { setBacktest(undefined); setBacktest(await api.allocationCalculate('backtest', { ...draft, scheme_id: schemeId, rebalance: 'angel_devil', start, end, fee: fee / 100, slippage: slippage / 100 })) })}><History size={14} />运行历史回测</button><span className="text-[11px] text-muted">{schemePositionReady ? `${schemeName} · 逐日使用历史环境得分` : `${schemeName} · ${draft.symbols.length} 只 ETF · 回看 ${draft.lookback} 个交易日 · 可分割份额估算`}</span></div>
            {!canBacktest && <p className="text-xs text-warning">{schemeHint ?? '请先在“配置仓位”中添加 ETF，并检查单只仓位上限。'}</p>}
            {start && end && start > end && <p role="alert" className="text-xs text-danger">结束日期应晚于或等于开始日期。</p>}
          </section>
          {backtest?.position_history ? <section className={card}>
            <div className="border-b border-border px-4 py-3"><h3 className="text-sm font-semibold">魔鬼操盘手 · 每日总仓位</h3><p className="mt-1 text-[11px] text-muted">{backtest.position_history[0]?.date} 至 {backtest.position_history.at(-1)?.date} · {backtest.position_history.length} 个交易日 · 只根据环境分计算目标总仓位</p></div>
            <div className="max-h-[32rem] overflow-auto"><table className={table} aria-label="历史市场环境得分与总仓位">
              <thead><tr><th>日期</th><th>环境得分</th><th>市场阶段</th><th>目标总仓位</th><th>现金比例</th></tr></thead>
              <tbody>{backtest.position_history.map(point => <tr key={point.date}><td className="whitespace-nowrap font-mono">{point.date}</td><td className="font-mono">{point.score ?? '—'}</td><td>{point.regime ?? '—'}</td><td className="font-mono font-semibold text-accent">{point.total_position == null ? '—' : pct(point.total_position)}</td><td className="font-mono">{point.total_position == null ? '—' : pct(1 - point.total_position)}</td></tr>)}</tbody>
            </table></div>
          </section> : hasPerformanceHistory(backtest) ? <>
            <Performance title="天使魔鬼信号与动态配比回测" result={backtest} schemeName={schemeName} />
            <details className={card}><summary className="cursor-pointer px-4 py-3 text-sm font-medium">成交明细 <span className="ml-2 text-xs text-muted">{backtest.trades?.length ?? 0} 条</span></summary>
              <div className="overflow-x-auto border-t border-border"><table className={table}>
                <thead><tr><th>日期</th><th>方案</th><th>ETF</th><th>操作 / 原因</th><th>收盘成交价</th><th>成交金额 / 资金占比</th><th>成本 / 资金占比</th><th>当日目标</th></tr></thead>
                <tbody>{backtest.trades?.map((t, index) => <tr key={index}>
                  <td className="whitespace-nowrap font-mono">{t.date}</td><td className="whitespace-nowrap">{t.model === 'equal' ? '等权对照' : schemeName}</td>
                  <td className="whitespace-nowrap">{t.symbol ? nameOf(t.symbol) : '—'}<p className="font-mono text-[10px] text-muted">{t.symbol}</p></td>
                  <td className="whitespace-nowrap">{t.side === 'buy' ? '买入' : '卖出'} · {{ attack: '进攻信号', retreat: '撤退信号', threshold_reduce: '偏离达标，强制减仓' }[t.reason ?? 'attack']}</td>
                  <td className="font-mono">{t.price?.toFixed(4)}</td><td className="whitespace-nowrap font-mono">{backtest.parameters.initial_capital == null ? '—' : <>{money.format((t.amount ?? 0) * backtest.parameters.initial_capital)} / {pct(t.amount ?? 0)}</>}</td><td className="whitespace-nowrap font-mono">{backtest.parameters.initial_capital == null ? '—' : <>{money.format(t.cost * backtest.parameters.initial_capital)} / {pct(t.cost)}</>}</td>
                  <td className="font-mono">{t.symbol ? pct(t.weights[backtest.parameters.symbols.indexOf(t.symbol)]) : '—'}</td>
                </tr>)}</tbody>
              </table></div>
            </details>
            <details className={card}><summary className="cursor-pointer px-4 py-3 text-sm font-medium">每日配比与持仓</summary>
              <div className="max-h-80 overflow-auto border-t border-border"><table className={table}>
                <thead><tr><th>日期</th><th>日线信号</th><th>{schemeName} 目标配比</th><th>{schemeName} 实际持仓</th><th>持仓市值</th><th>现金余额</th><th>账户总资产</th></tr></thead>
                <tbody>{backtest.schedule?.map((day, index) => {
                  const account = backtest.accounts?.scheme?.[index]
                  return <tr key={day.date}><td className="whitespace-nowrap font-mono">{day.date}</td>
                    <td className="min-w-48">{day.signals.map((signal, j) => signal ? <p key={j}>{nameOf(backtest.parameters.symbols[j])} · {signal === 'attack' ? '进攻' : '撤退'}</p> : null)}{!day.signals.some(Boolean) && '无新信号'}</td>
                    <td className="min-w-52">{day.weights.map((weight, j) => <p key={j}>{nameOf(backtest.parameters.symbols[j])} <span className="font-mono">{pct(weight)}</span></p>)}</td>
                    <td className="min-w-52">{account?.weights.map((weight, j) => <p key={j}>{nameOf(backtest.parameters.symbols[j])} <span className="font-mono">{pct(weight)}</span></p>)}</td>
                    <td className="whitespace-nowrap font-mono">{account && backtest.parameters.initial_capital != null ? money.format((account.value - account.cash) * backtest.parameters.initial_capital) : '—'}</td>
                    <td className="whitespace-nowrap font-mono">{account && backtest.parameters.initial_capital != null ? money.format(account.cash * backtest.parameters.initial_capital) : '—'}</td>
                    <td className="whitespace-nowrap font-mono">{account && backtest.parameters.initial_capital != null ? money.format(account.value * backtest.parameters.initial_capital) : '—'}</td>
                  </tr>
                })}</tbody>
              </table></div>
            </details>
          </> : <div className={card + ' flex items-start gap-3 p-5 text-muted'}><Clock3 size={18} className="mt-0.5 shrink-0" /><p className="text-xs leading-6">{backtest ? '当前回测没有可展示的结果明细。' : schemePositionReady ? '设置日期区间后运行回测，查看每个交易日的环境评分、市场阶段与总仓位。' : `设置区间后运行回测，即可查看信号成交、每天的目标与实际仓位、现金及净值。${schemeName} 与等权对照使用相同信号和收盘成交规则。`}</p></div>}
        </div>}
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
