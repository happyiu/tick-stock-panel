import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as echarts from 'echarts'
import { api, type AllocationPortfolio, type AllocationResult } from '@/lib/api'
import { QK } from '@/lib/queryKeys'

const initial: AllocationPortfolio = { name: '新组合', symbols: [], lookback: 252, max_weight: .35, auto_refresh: true, rebalance: 'daily_threshold', threshold: .05 }
const pct = (n: number) => `${(n * 100).toFixed(2)}%`

function Performance({ result, title }: { result: AllocationResult; title: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const chart = echarts.init(ref.current!)
    chart.setOption({
      tooltip: { trigger: 'axis' }, legend: { data: ['HRP', '等权'], textStyle: { color: '#888' } },
      xAxis: { type: 'category', data: result.history.hrp.points.map(p => p.date) },
      yAxis: { type: 'value', scale: true },
      series: Object.entries(result.history).map(([name, data]) => ({
        name: name === 'hrp' ? 'HRP' : '等权', type: 'line', showSymbol: false, data: data.points.map(p => p.value),
      })),
    })
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(ref.current!)
    return () => { observer.disconnect(); chart.dispose() }
  }, [result])
  return <section className="rounded-xl border border-border p-4 space-y-3">
    <h2 className="font-semibold">{title}</h2>
    <p className="text-xs text-muted">数据截至 {result.as_of} · 回看 {result.samples} 期 · 引擎 {result.engine_version}</p>
    <p className="text-xs text-muted">{result.history.hrp.points[0]?.date} 至 {result.history.hrp.points.at(-1)?.date}</p>
    <div className="flex flex-wrap gap-6 text-sm">{Object.entries(result.history).map(([name, data]) =>
      <div key={name}>{name === 'hrp' ? 'HRP' : '等权'} 收益 {pct(data.return)} · 最大回撤 {pct(data.drawdown)}</div>)}</div>
    <div ref={ref} className="h-64 w-full" />
  </section>
}

export default function AssetAllocation() {
  const client = useQueryClient()
  const portfolios = useQuery({ queryKey: QK.allocationPortfolios, queryFn: api.allocationPortfolios })
  const tracking = useQuery({ queryKey: QK.allocationTracking, queryFn: api.allocationTracking, refetchInterval: 30000 })
  const [draft, setDraft] = useState<AllocationPortfolio>(initial)
  const [id, setId] = useState('')
  const [q, setQ] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<AllocationResult>()
  const [backtest, setBacktest] = useState<AllocationResult>()
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [fee, setFee] = useState(0)
  const [slippage, setSlippage] = useState(0)
  const search = useQuery({ queryKey: QK.etfPool({ page: 1, pageSize: 20, category: '', q }), queryFn: () => api.etfPool({ page: 1, pageSize: 20, category: '', q }), enabled: q.trim().length > 0 })
  function update(next: AllocationPortfolio) { setDraft(next); setResult(undefined); setBacktest(undefined); setError('') }
  async function action(fn: () => Promise<void>) {
    setBusy(true); setError('')
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const saved = id ? portfolios.data?.[id] : undefined
  const definition = (p: AllocationPortfolio) => JSON.stringify([p.name, p.symbols, p.lookback, p.max_weight, p.auto_refresh ?? false, p.rebalance ?? 'monthly', p.threshold ?? .05])
  const dirty = !saved || definition(saved) !== definition(draft)
  const tracked = !dirty ? tracking.data?.[id] : undefined
  const refreshTracking = () => client.invalidateQueries({ queryKey: QK.allocationTracking })
  const input = 'rounded border border-border bg-surface px-3 py-2 text-sm'
  return <div className="p-4 pt-16 md:p-6 space-y-5">
    <h1 className="text-xl font-semibold">资产配置</h1>
    <fieldset disabled={busy} className="space-y-5">
    {(error || portfolios.error || search.error || tracking.error) && <div role="alert" className="text-red-400">{error || String(portfolios.error || search.error || tracking.error)}</div>}
    {portfolios.isLoading && <p>加载组合…</p>}
    <div className="flex flex-wrap gap-2">
      <select aria-label="已保存组合" className={input} value={id} onChange={e => {
        const key = e.target.value; setId(key); update(key ? portfolios.data![key] : initial)
      }}><option value="">新建组合</option>{Object.entries(portfolios.data || {}).map(([key, p]) => <option key={key} value={key}>{p.name}</option>)}</select>
      <input aria-label="组合名称" className={input} value={draft.name} onChange={e => update({ ...draft, name: e.target.value })} />
      <button disabled={busy || !draft.name.trim()} onClick={() => action(async () => {
        const key = id || crypto.randomUUID()
        client.setQueryData(QK.allocationPortfolios, await api.allocationSave(key, draft)); setId(key)
      })}>保存组合</button>
      <button disabled={busy || !id} onClick={() => action(async () => {
        if (!window.confirm('删除这个已保存组合？')) return
        client.setQueryData(QK.allocationPortfolios, await api.allocationDelete(id)); setId(''); update(initial)
      })}>删除组合</button>
    </div>
    <div className="flex flex-wrap gap-4 items-center">
      <label>回看交易日 <input aria-label="回看交易日" className={input + ' w-24'} type="number" min="2" value={draft.lookback} onChange={e => update({ ...draft, lookback: Number(e.target.value) })} /></label>
      <label>单只上限 % <input aria-label="单只上限" className={input + ' w-24'} type="number" min="1" max="100" value={draft.max_weight * 100} onChange={e => update({ ...draft, max_weight: Number(e.target.value) / 100 })} /></label>
    </div>
    <section className="space-y-3 rounded-xl border border-border p-4">
      <h2 className="font-semibold">动态调仓跟踪</h2>
      <label className="flex gap-2"><input type="checkbox" checked={draft.auto_refresh ?? false} onChange={e => update({ ...draft, auto_refresh: e.target.checked })} />保存后每天收盘自动重算</label>
      <label>触发偏离（百分点） <input aria-label="触发偏离" className={input + ' w-24'} type="number" min=".1" max="100" step=".1" value={(draft.threshold ?? .05) * 100} onChange={e => update({ ...draft, threshold: Number(e.target.value) / 100 })} /></label>
      <p className="text-xs text-muted">北京时间 16 点后每 15 分钟检查一次。任意 ETF 偏离目标达到阈值时生成建议，计算基于确认时的模拟持仓及之后的价格、分红和拆分。</p>
      {dirty && <p className="text-muted">请先保存组合，再重算调仓建议。</p>}
      <button className={input} disabled={busy || dirty} onClick={() => action(async () => { await api.allocationRefresh(id); await refreshTracking() })}>重算调仓建议</button>
      {tracked && <div className="space-y-2 text-sm">
        <p>{({ initial: '等待建立跟踪基准', rebalance: '已触发调仓建议', hold: '偏离未达到阈值', error: '本次计算失败' })[tracked.status]} · 检查时间 {tracked.checked_at} · 数据截至 {tracked.as_of ?? '—'}</p>
        {tracked.error && <p role="alert">{tracked.error}</p>}
        {tracked.deviation != null && <p>最大偏离 {(tracked.deviation * 100).toFixed(2)} 个百分点</p>}
        {tracked.status !== 'error' && <><div className="overflow-x-auto"><table className="w-full"><thead><tr><th>ETF</th><th>跟踪仓位</th><th>最新目标</th><th>差额</th></tr></thead><tbody>{draft.symbols.map((symbol, i) => <tr key={symbol}><td>{symbol}</td><td>{tracked.current ? pct(tracked.current[i]) : '—'}</td><td>{pct(tracked.target![i])}</td><td>{tracked.current ? pct(tracked.target![i] - tracked.current[i]) : '—'}</td></tr>)}</tbody></table></div>
        <button className={input} onClick={() => action(async () => {
          if (!window.confirm('将此目标权重按所示收盘价确认为新的模拟持仓跟踪基准？')) return
          await api.allocationConfirm(id, tracked.checked_at); await refreshTracking()
        })}>确认目标为跟踪基准</button></>}
      </div>}
    </section>
    <div className="space-y-2">
      <input aria-label="搜索 ETF" className={input + ' w-full'} placeholder="ETF 代码或名称" value={q} onChange={e => setQ(e.target.value)} />
      {search.isFetching && <p className="text-muted">搜索中…</p>}
      <div className="flex flex-wrap gap-2">{search.data?.rows.map(row => <button key={row.symbol} disabled={draft.symbols.includes(row.symbol)} className={input} onClick={() => update({ ...draft, symbols: [...draft.symbols, row.symbol] })}>{row.name} {row.symbol} ＋</button>)}</div>
      {q && search.data?.rows.length === 0 && <p>没有匹配的 ETF</p>}
      <div className="flex flex-wrap gap-2">{draft.symbols.map(symbol => <button className={input} key={symbol} onClick={() => update({ ...draft, symbols: draft.symbols.filter(s => s !== symbol) })}>{symbol} ×</button>)}</div>
      {!draft.symbols.length && <p className="text-muted">搜索并添加 ETF，可以先保存草稿。</p>}
      {draft.symbols.length > 0 && draft.symbols.length * draft.max_weight < 1 && <p className="text-amber-400">最多只能配置 {pct(draft.symbols.length * draft.max_weight)}，请提高单只上限或增加标的。</p>}
      <button className={input} disabled={busy || !draft.symbols.length} onClick={() => action(async () => { setResult(undefined); setResult(await api.allocationCalculate('optimize', draft)) })}>{busy ? '处理中…' : '计算最新收盘配置'}</button>
    </div>
    {result && <>
      <p className="text-sm">样本 {result.sample_start} 至 {result.as_of}，有效收益 {result.samples} 期 · 总仓位 {pct(result.weights!.reduce((a, b) => a + b, 0))}</p>
      <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead><tr>{['ETF', 'HRP 目标权重', '等权', '相对等权', '波动风险贡献'].map(t => <th className="p-2" key={t}>{t}</th>)}</tr></thead><tbody>{result.parameters.symbols.map((s, i) => <tr key={s}><td className="p-2">{result.names[s]} {s}</td><td>{pct(result.weights![i])}</td><td>{pct(1 / draft.symbols.length)}</td><td>{pct(result.weights![i] - 1 / draft.symbols.length)}</td><td>{pct(result.risk_contribution![i])}</td></tr>)}</tbody></table></div>
      <Performance title="当前配置历史表现 · 样本内回看，使用全窗口计算的权重" result={result} />
    </>}
    <section className="space-y-3">
      <h2 className="font-semibold">调仓回测</h2>
      <label>调仓规则 <select aria-label="调仓规则" className={input} value={draft.rebalance ?? 'monthly'} onChange={e => update({ ...draft, rebalance: e.target.value as 'monthly' | 'daily_threshold' })}>
        <option value="daily_threshold">每日收盘信号＋偏离阈值</option><option value="monthly">每月调仓</option>
      </select></label>
      <div className="flex flex-wrap gap-3">
        <label>开始 <input className={input} type="date" value={start} onChange={e => { setStart(e.target.value); setBacktest(undefined) }} /></label>
        <label>结束 <input className={input} type="date" value={end} onChange={e => { setEnd(e.target.value); setBacktest(undefined) }} /></label>
        <label>单边费率 % <input className={input + ' w-24'} type="number" min="0" step=".01" value={fee} onChange={e => { setFee(Number(e.target.value)); setBacktest(undefined) }} /></label>
        <label>滑点 % <input className={input + ' w-24'} type="number" min="0" step=".01" value={slippage} onChange={e => { setSlippage(Number(e.target.value)); setBacktest(undefined) }} /></label>
        <button className={input} disabled={busy || !start || !end || !draft.symbols.length} onClick={() => action(async () => { setBacktest(undefined); setBacktest(await api.allocationCalculate('backtest', { ...draft, start, end, fee: fee / 100, slippage: slippage / 100 })) })}>运行回测</button>
      </div>
      <p className="text-xs text-muted">{draft.rebalance === 'daily_threshold' ? '前一日收盘判断，达到阈值后下一交易日开盘调仓' : '每月首个交易日开盘调仓'} · 可分割份额估算 · 单边费率 {fee}% · 滑点 {slippage}%</p>
      {backtest && <><Performance title={backtest.parameters.rebalance === 'daily_threshold' ? '动态阈值调仓回测' : '按月调仓回测'} result={backtest} /><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th>日期</th><th>模型</th><th>触发原因</th><th>换手</th><th>成本 / 初始资金</th><th>各 ETF 目标权重</th></tr></thead><tbody>{backtest.trades?.map(t => <tr key={t.model + t.date}><td>{t.date}</td><td>{t.model}</td><td>{{ initial: '首次建仓', threshold: '达到偏离阈值', monthly: '月初调仓' }[t.reason ?? 'monthly']}</td><td>{pct(t.turnover)}</td><td>{pct(t.cost)}</td><td>{backtest.parameters.symbols.map((s, i) => `${s} ${pct(t.weights[i])}`).join(' · ')}</td></tr>)}</tbody></table></div></>}
    </section>
    </fieldset>
  </div>
}
