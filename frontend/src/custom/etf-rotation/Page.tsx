import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type RotationCheck, type RotationConfig, type RotationRun, type RotationSaved, type RotationSignal } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { RotationCharts } from './Charts'

const input = 'w-full rounded-btn border border-border bg-elevated px-3 py-2 text-sm'
const button = 'rounded-btn border border-border bg-elevated px-3 py-2 text-sm hover:bg-accent/10 disabled:opacity-40'
const panel = 'rounded-lg border border-border bg-surface p-4 space-y-4'
const pct = (n: number) => `${(n * 100).toFixed(2)}%`
const money = (n: number) => n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const labels: Record<string, string> = {
  market_ma_period: '市场环境均线周期（交易日）', market_band: '牛熊偏离阈值（小数）', bull_exposure: '牛市目标仓位', neutral_exposure: '震荡目标仓位', bear_exposure: '熊市目标仓位',
  min_hold: '最小持有交易日', adjustment_days: '渐进调仓天数', momentum_window: '动量窗口（交易日）', switch_gap: '切换最小动量差（小数）', switch_std: '切换标准差倍数',
  trend_weight: '趋势权重', sharpe_weight: 'Sharpe权重', quality_weight: '趋势质量权重', volume_weight: '成交量权重', short_confirmation: '启用短期动量确认',
  bull_filter: '启用参考ETF牛市过滤', panic_drop: '恐慌：最差5日收益低于', panic_vol: '恐慌：波动率比高于', panic_breadth: '恐慌：下跌比例高于',
  gold_min_hold: '避险最小持有交易日', gold_max_hold: '避险最长持有交易日', gold_stop: '避险ETF5日止损', panic_exit: '正常池平均5日收益恢复至',
  risk_mode: '单标的风控模式', account_guard: '启用账户回撤保护', max_drawdown: '账户回撤退出阈值', take_profit: '浮动止盈激活收益', trailing_drawdown: '浮动止盈回撤阈值', atr_multiple: 'ATR止损倍数',
}
const factorLabels: Record<string, string> = { trend: '趋势', sharpe: 'Sharpe', quality: '质量', volume_factor: '量价' }
const statusLabels: Record<string, string> = { queued: '排队中', running: '运行中', completed: '已完成', failed: '失败', canceled: '已取消', interrupted: '已中断' }

export function Environment({ environment }: { environment: RotationSignal['environment'] }) {
  if (!environment) return null
  const e = environment
  const labels: Record<string, string> = { bull: '牛市', neutral: '震荡', bear: '熊市', strong: '强势', lean_strong: '偏强', range: '震荡', lean_weak: '偏弱', weak: '弱势' }
  return <div className="rounded border border-border bg-elevated p-3 text-sm space-y-2">
    <div className="font-medium">轮动市场环境：{labels[e.regime] ?? e.regime}</div>
    <p>沪深300 {e.close.toFixed(2)} · MA{e.ma_period} {e.ma.toFixed(2)} · 偏离 {pct(e.deviation)} · 牛熊阈值 ±{pct(e.band)}</p>
    <p>{e.controls_exposure ? `环境增强已启用，目标仓位 ${pct(e.target_exposure)}，收盘决策后在下一交易日开盘调整（另预留2%现金及整手余量）。` : `评分倍率 ×${e.score_multiplier.toFixed(1)}；当前策略未启用市场环境仓位控制。`}</p>
    {e.market_context ? <p>系统综合市场环境：{labels[e.market_context.state] ?? e.market_context.state}{e.market_context.score == null ? '' : ` · ${e.market_context.score.toFixed(0)}分`}（{e.market_context.date}，仅作参考）</p> : <p className="text-muted">当日系统综合环境尚无数据；轮动环境仍由沪深300均线独立判断。</p>}
    <a className="text-accent" href="/regime">查看系统市场环境</a>
  </div>
}

function Ranking({ signal, names }: { signal: RotationSignal; names: Record<string, string> }) {
  if (!signal.valid) return <p className="text-muted">{signal.reason}</p>
  return <div className="space-y-3">
    <Environment environment={signal.environment} />
    <div className="text-sm text-muted">{signal.date} · {({ bull: '牛市', bear: '熊市', neutral: '中性' })[signal.regime ?? 'neutral']} {signal.panic_triggered ? '· 恐慌条件触发' : ''}</div>
    {signal.panic && <div className="text-xs text-muted">最差5日收益 {pct(signal.panic.drop)} · 波动率比 {signal.panic.vol_ratio.toFixed(2)} · 下跌比例 {pct(signal.panic.breadth)}</div>}
    <div className="overflow-auto"><table className="w-full text-sm"><thead><tr className="text-left text-muted"><th className="p-2">排名</th><th>ETF</th><th>得分</th><th>因子原值 / Z-Score</th></tr></thead><tbody>{signal.ranking.map((row, i) => <tr key={row.symbol} className="border-t border-border"><td className="p-2">{i + 1}</td><td>{names[row.symbol]} <span className="text-muted">{row.symbol}</span></td><td>{row.score.toFixed(4)}</td><td>{Object.entries(row.factors).map(([k, v]) => <span key={k} className="mr-3 whitespace-nowrap">{factorLabels[k]} {v.raw.toFixed(4)} / {v.zscore.toFixed(3)}</span>)}</td></tr>)}</tbody></table></div>
  </div>
}

export default function Page() {
  const client = useQueryClient()
  const [tab, setTab] = useState('config')
  const [config, setConfig] = useState<RotationConfig | null>(null)
  const [saved, setSaved] = useState<RotationSaved | undefined>()
  const [start, setStart] = useState('2024-01-01')
  const [end, setEnd] = useState('')
  const [cash, setCash] = useState(10000)
  const [check, setCheck] = useState<RotationCheck | null>(null)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [addTo, setAddTo] = useState<'pool' | 'haven' | 'reference'>('pool')
  const [jobId, setJobId] = useState('')
  const [dayIndex, setDayIndex] = useState(-1)
  const [withContext, setWithContext] = useState(false)
  const templates = useQuery({ queryKey: QK.rotationStrategies, queryFn: api.rotationStrategies })
  const configs = useQuery({ queryKey: QK.rotationConfigs, queryFn: api.rotationConfigs })
  const jobs = useQuery({ queryKey: QK.rotationJobs, queryFn: api.rotationJobs, refetchInterval: data => data.state.data?.items.some(j => ['queued', 'running'].includes(j.status)) ? 1000 : false })
  const selectedJob = jobs.data?.items.find(j => j.id === jobId)
  const result = useQuery({ queryKey: QK.rotationResult(jobId), queryFn: () => api.rotationResult(jobId), enabled: !!jobId && selectedJob?.kind === 'backtest' && selectedJob.status === 'completed' })
  const found = useQuery({ queryKey: QK.rotationSearch(search), queryFn: () => api.instrumentSearch(search, 20, 'etf'), enabled: search.length > 0 })
  const symbols = [...new Set([...(config?.symbols ?? []), config?.haven_symbol ?? '', config?.reference_symbol ?? '', ...(result.data?.metadata.request.config.symbols ?? [])])].filter(Boolean).sort()
  const nameQuery = useQuery({ queryKey: QK.rotationNames(symbols), queryFn: () => api.instrumentNames(symbols), enabled: symbols.length > 0 })
  const names = nameQuery.data?.names ?? {}
  const preview = useQuery({ queryKey: QK.rotationPreview(config, withContext ? jobId : ''), queryFn: () => api.rotationPreview(config!, withContext ? jobId : undefined), enabled: false, retry: false })
  const action = useMutation({ mutationFn: async (fn: () => Promise<unknown>) => fn() })
  const busy = action.isPending
  useEffect(() => { if (!config && templates.data) { setConfig(structuredClone(templates.data.templates[0])); setEnd(templates.data.closed_date) } }, [templates.data, config])
  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 250); return () => clearTimeout(timer) }, [query])
  useEffect(() => { setCheck(null) }, [config, start, end, cash])
  const run: RotationRun | null = config ? { config, start, end, initial_cash: cash } : null
  const act = (fn: () => Promise<unknown>) => action.mutate(fn)
  const refreshJobs = () => client.invalidateQueries({ queryKey: QK.rotationJobs })
  const load = (value: RotationConfig, record?: RotationSaved) => { setConfig(structuredClone(value)); setSaved(record); setWithContext(false); setAddTo('pool'); setQuery(''); action.reset() }
  const add = (symbol: string) => {
    if (!config) return
    setConfig(addTo === 'pool' ? { ...config, symbols: [...new Set([...config.symbols, symbol])] } : { ...config, [addTo === 'haven' ? 'haven_symbol' : 'reference_symbol']: symbol })
  }
  const changeParameter = (key: string, value: string | number | boolean) => config && setConfig({ ...config, parameters: { ...config.parameters, [key]: value } })
  const schema = templates.data?.parameters.properties ?? {}
  const error = action.error ?? templates.error ?? configs.error ?? jobs.error ?? result.error ?? nameQuery.error
  if (!config) return <div className="p-6">{error ? String(error.message) : '正在加载ETF轮动…'}</div>
  const daily = result.data?.daily
  const invalidDays = result.data?.signals.filter(signal => !signal.valid).length ?? 0
  const index = daily ? dayIndex < 0 ? daily.length - 1 : Math.min(dayIndex, daily.length - 1) : 0
  const selectedDay = daily?.[index]
  const compositeStrategy = config.strategy.startsWith('composite_momentum')
  const hidden = (key: string) => {
    if (['market_ma_period', 'market_band', 'bull_exposure', 'neutral_exposure', 'bear_exposure'].includes(key)) return config.strategy !== 'composite_momentum_enhanced'
    const gold = ['bull_filter', 'panic_drop', 'panic_vol', 'panic_breadth', 'gold_min_hold', 'gold_max_hold', 'gold_stop', 'panic_exit']
    const composite = ['trend_weight', 'sharpe_weight', 'quality_weight', 'volume_weight', 'switch_std']
    return (gold.includes(key) && config.strategy !== 'gold_safe_haven') || (composite.includes(key) && !compositeStrategy) || (['momentum_window', 'switch_gap', 'short_confirmation'].includes(key) && compositeStrategy)
  }
  return <div className="mx-auto max-w-7xl space-y-5 p-4 md:p-6">
    <div><h1 className="text-xl font-semibold">ETF轮动</h1><p className="mt-1 text-sm text-muted">复权价研究回测 · 收盘决策，下一交易日开盘执行 · 三种策略可自定义ETF池</p></div>
    <div className="flex flex-wrap gap-2" role="tablist" aria-label="ETF轮动">{[['config', '策略配置'], ['results', '回测结果'], ['preview', '决策预览']].map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={`${button} ${tab === id ? 'text-accent border-accent' : ''}`} onClick={() => setTab(id)}>{label}</button>)}</div>
    {error && <div role="alert" className="rounded border border-red-500/40 p-3 text-sm text-red-500">{error.message}</div>}
    {tab === 'config' && <fieldset disabled={busy} className="space-y-5">
      <div className={panel}>
        <div className="grid gap-4 md:grid-cols-3">
          <label className="space-y-1 text-sm">策略模板<select aria-label="策略模板" className={input} value={config.strategy} onChange={e => { const t = templates.data?.templates.find(t => t.strategy === e.target.value); if (t) load(t) }}>{templates.data?.templates.map(t => <option key={t.strategy} value={t.strategy}>{t.name}</option>)}</select></label>
          <label className="space-y-1 text-sm">配置名称<input className={input} value={config.name} onChange={e => setConfig({ ...config, name: e.target.value })} /></label>
          <label className="space-y-1 text-sm">已保存配置<select className={input} value={saved?.id ?? ''} onChange={e => { const record = configs.data?.items.find(c => c.id === e.target.value); if (record) load(record.config, record); else setSaved(undefined) }}><option value="">新配置</option>{configs.data?.items.map(c => <option key={c.id} value={c.id}>{c.config.name} · v{c.revision}</option>)}</select></label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className={button} onClick={() => act(async () => { const value = await api.rotationSave(config, saved); setSaved(value); await client.invalidateQueries({ queryKey: QK.rotationConfigs }); await client.invalidateQueries({ queryKey: ['etf-rotation', 'preview'] }) })}>{saved ? '保存修改' : '保存配置'}</button>
          {saved && <><button className={button} onClick={() => { setSaved(undefined); setConfig({ ...config, name: `${config.name} 副本` }) }}>另存为新配置</button><button className={button} onClick={() => { if (window.confirm(`删除配置“${saved.config.name}”？历史回测仍会保留。`)) act(async () => { await api.rotationDelete(saved); setSaved(undefined); await client.invalidateQueries({ queryKey: QK.rotationConfigs }) }) }}>删除配置</button></>}
        </div>
      </div>
      {config.strategy === 'composite_momentum_enhanced' && <div className={panel}><h2 className="font-medium">市场环境增强</h2><p className="text-sm text-muted">沿用复合动量评分，增加沪深300均线环境下的目标仓位。牛市 {pct(Number(config.parameters.bull_exposure))}、震荡 {pct(Number(config.parameters.neutral_exposure))}、熊市 {pct(Number(config.parameters.bear_exposure))}；环境变化优先调整现有持仓，普通选基与轮动目标沿用复合动量规则。每次回测自动提供相同行情的基础版本对照，收益可能变好也可能变差。</p></div>}
      <div className={panel}>
        <h2 className="font-medium">{config.strategy === 'gold_safe_haven' ? '正常轮动ETF池' : '候选ETF池'}（{config.symbols.length}只，至少2只）</h2>
        <div className="flex flex-wrap gap-2">{config.symbols.map(s => <button title="点击移除" key={s} className={button} onClick={() => setConfig({ ...config, symbols: config.symbols.filter(v => v !== s) })}>{names[s] ?? s} <span className="text-xs text-muted">{s} ×</span></button>)}</div>
        {config.strategy === 'gold_safe_haven' && <p className="text-sm">避险ETF：{names[config.haven_symbol]} {config.haven_symbol}　参考ETF：{names[config.reference_symbol]} {config.reference_symbol}</p>}
        <div className="flex flex-wrap gap-2">
          {config.strategy === 'gold_safe_haven' && <select aria-label="添加位置" className={`${input} !w-auto`} value={addTo} onChange={e => setAddTo(e.target.value as typeof addTo)}><option value="pool">添加到正常池</option><option value="haven">替换避险ETF</option><option value="reference">替换参考ETF</option></select>}
          <input aria-label="搜索ETF" className={`${input} max-w-md`} placeholder="搜索ETF名称或代码" value={query} onChange={e => setQuery(e.target.value)} />
        </div>
        {found.isFetching && <p className="text-sm text-muted">正在搜索…</p>}{found.error && <p className="text-red-500 text-sm">{found.error.message}</p>}
        {search && found.data?.results.length === 0 && <p className="text-sm text-muted">没有匹配ETF</p>}
        <div className="flex max-h-48 flex-wrap gap-2 overflow-auto">{found.data?.results.map(s => <button key={s.symbol} className={button} onClick={() => add(s.symbol)}>{s.name} {s.symbol} ＋</button>)}</div>
      </div>
      <details className={panel} open><summary className="cursor-pointer font-medium">策略参数与风控（收益阈值使用小数，例如0.03表示3%）</summary><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{Object.entries(config.parameters).filter(([key]) => !hidden(key)).map(([key, value]) => <label key={key} className="space-y-1 text-sm"><span>{labels[key] ?? key}</span>{typeof value === 'boolean' ? <input className="ml-3" type="checkbox" checked={value} onChange={e => changeParameter(key, e.target.checked)} /> : schema[key]?.enum ? <select className={input} value={String(value)} onChange={e => changeParameter(key, e.target.value)}>{schema[key].enum?.map(v => <option key={v} value={v}>{v === 'A' ? 'A：关闭单标的止盈止损' : v === 'B' ? 'B：止盈与ATR止损' : 'C：仅账户保护'}</option>)}</select> : <input className={input} type="number" disabled={key === 'adjustment_days' && config.strategy === 'gold_safe_haven'} step={schema[key]?.type === 'integer' ? 1 : 'any'} min={schema[key]?.minimum} max={schema[key]?.maximum} value={Number(value)} onChange={e => changeParameter(key, Number(e.target.value))} />}</label>)}</div></details>
      <div className={panel}><h2 className="font-medium">回测与费用</h2><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-sm">开始日期<input aria-label="开始日期" type="date" className={input} value={start} onChange={e => setStart(e.target.value)} /></label>
        <label className="text-sm">结束日期<input aria-label="结束日期" type="date" className={input} value={end} max={templates.data?.closed_date} onChange={e => setEnd(e.target.value)} /></label>
        <label className="text-sm">初始资金（元）<input type="number" min={100} className={input} value={cash} onChange={e => setCash(Number(e.target.value))} /></label>
        {Object.entries(config.fees).map(([key, value]) => <label key={key} className="text-sm">{({ commission: '佣金比例（万二=0.0002）', slippage: '滑点比例（万一=0.0001）', minimum: '最低佣金（元）' })[key]}<input type="number" step="any" min={0} className={input} value={value} onChange={e => setConfig({ ...config, fees: { ...config.fees, [key]: Number(e.target.value) } })} /></label>)}
      </div><div className="flex flex-wrap gap-2">
        <button className={button} onClick={() => run && act(async () => setCheck(await api.rotationCheck(run)))}>检查数据覆盖</button>
        <button className={button} onClick={() => run && act(async () => { const job = await api.rotationPrepare(run); setJobId(job.id); await refreshJobs(); setTab('results') })}>准备所选标的数据</button>
        <button className={`${button} text-accent`} disabled={!check?.ready || config.symbols.length < 2} onClick={() => run && act(async () => { const job = await api.rotationStart(run); setJobId(job.id); setDayIndex(-1); await refreshJobs(); setTab('results') })}>开始回测</button>
      </div>{check && <div className="text-sm space-y-2"><p>{check.ready ? '数据就绪' : check.reason} · 预热 {check.warmup_bars} 个交易日</p>{!!check.missing_index_dates?.length && <p className="text-red-500">沪深300日线缺失 {check.missing_index_dates.length} 日：{check.missing_index_dates.slice(0, 8).join('、')}{check.missing_index_dates.length > 8 ? '…' : ''}</p>}{!check.ready && check.proposed_start && <button className={button} onClick={() => setStart(check.proposed_start!)}>确认采用共同起点 {check.proposed_start}，然后重新检查</button>}<div className="overflow-auto"><table className="w-full text-sm"><thead><tr className="text-left text-muted"><th>ETF / 指数</th><th>最早数据</th><th>最新数据</th><th>行数</th></tr></thead><tbody>{check.coverage.map(r => <tr key={r.symbol}><td>{names[r.symbol]} {r.symbol}</td><td>{r.first ?? '缺失'}</td><td>{r.last ?? '缺失'}</td><td>{r.rows}</td></tr>)}</tbody></table></div></div>}</div>
    </fieldset>}
    {tab === 'results' && <div className="space-y-5">
      <div className={panel}><h2 className="font-medium">任务与历史</h2>{jobs.isLoading && <p>正在加载…</p>}{jobs.data?.items.length === 0 && <p className="text-muted text-sm">尚无回测，先配置ETF池并检查数据。</p>}<div className="max-h-60 overflow-auto space-y-2">{jobs.data?.items.map(job => <div key={job.id} className={`flex flex-wrap items-center justify-between gap-2 rounded border p-2 ${jobId === job.id ? 'border-accent' : 'border-border'}`}><button className="text-left text-sm" onClick={() => { setJobId(job.id); setDayIndex(-1) }}>{job.name} · {job.kind === 'prepare' ? '数据准备' : '回测'} · {statusLabels[job.status] ?? job.status} {job.progress}% <span className="text-muted text-xs">{new Date(job.created_at).toLocaleString()}</span>{job.error && <span className="block text-red-500">{job.error}</span>}</button>{['queued', 'running'].includes(job.status) && <button className={button} disabled={busy} onClick={() => act(async () => { await api.rotationCancel(job.id); await refreshJobs() })}>取消</button>}</div>)}</div>{selectedJob?.data_check && <div className="space-y-1 text-sm"><p>{selectedJob.data_check.ready ? '数据准备完成，请返回配置页重新检查后运行' : selectedJob.data_check.reason}</p>{selectedJob.data_check.index_source && <p className="text-muted">沪深300数据源：{selectedJob.data_check.index_source}{selectedJob.data_check.index_source_note ? ` · ${selectedJob.data_check.index_source_note}` : ''}</p>}</div>}</div>
      {result.isFetching && <p className="text-muted">正在加载回测结果…</p>}
      {result.data && <>
        <div className={panel}><div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-medium">{result.data.metadata.request.config.name}</h2><p className="text-xs text-muted">{result.data.daily[0]?.date} 至 {result.data.daily.at(-1)?.date} · 复权价研究回测</p></div><button className={button} onClick={() => { const r = result.data!.metadata.request; load(r.config); setStart(r.start); setEnd(r.end); setCash(r.initial_cash); setTab('config') }}>载入本次配置</button></div>
          {invalidDays > 0 && <p role="alert" className="rounded border border-amber-500/50 p-3 text-sm text-amber-500">该历史回测有 {invalidDays} 个交易日因行情或预热不完整而暂停新决策，结果不能代表完整数据下的策略表现。请准备数据后重新回测。</p>}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">{[['累计收益', pct(result.data.stats.total_return)], ['年化收益', pct(result.data.stats.annualized_return)], ['最大回撤', pct(result.data.stats.max_drawdown)], ['夏普比率', result.data.stats.sharpe.toFixed(2)], ['期末资产', money(result.data.stats.final_value)], ['佣金费用', money(result.data.stats.fees)], ['滑点成本', money(result.data.stats.slippage)], ['成交笔数', result.data.stats.trades], ['初始资金', money(result.data.stats.initial_cash)]].map(([label, value]) => <div key={label}><div className="text-xs text-muted">{label}</div><div className="mt-1 text-lg font-medium">{value}</div></div>)}</div>
          {result.data.comparison && <div className="overflow-auto"><p className="text-sm font-medium mb-2">同数据基础版本对照</p><table className="w-full text-sm"><thead><tr className="text-left text-muted"><th>版本</th><th>累计收益</th><th>最大回撤</th><th>夏普</th><th>平均仓位</th></tr></thead><tbody>{[['环境增强', result.data.stats], ['基础复合动量', result.data.comparison.stats]].map(([label, stats]) => { const v = stats as Record<string, number>; return <tr className="border-t border-border" key={String(label)}><td className="py-2">{String(label)}</td><td>{pct(v.total_return)}</td><td>{pct(v.max_drawdown)}</td><td>{v.sharpe.toFixed(2)}</td><td>{pct(v.average_exposure)}</td></tr> })}</tbody></table><p className="text-xs text-muted">对照保留相同预热、费用和修正后的风控，不等同于原项目截图。</p></div>}
          <RotationCharts result={result.data} /><div className="flex flex-wrap gap-2">{[['stats', '指标'], ['daily', '净值及持仓'], ['signals', '信号'], ['fills', '成交']].map(([kind, name]) => <a className={button} key={kind} href={api.rotationExportUrl(jobId, kind)}>导出{name}CSV</a>)}</div>
          <details className="text-xs text-muted"><summary>数据快照摘要</summary><p className="break-all">{result.data.metadata.data_digest}</p><p>算法版本 {result.data.algorithm_version}</p><p>源策略版本 {result.data.metadata.source_revision}</p></details>
        </div>
        <div className={panel}><h2 className="font-medium">月度收益</h2><div className="grid grid-cols-3 gap-2 sm:grid-cols-6">{result.data.monthly.map(m => <div key={m.month} className="rounded border border-border p-2 text-sm"><div className="text-muted">{m.month}</div>{pct(m.return)}</div>)}</div></div>
        {selectedDay && <div className={panel}><label className="flex flex-wrap items-center gap-2 text-sm">每日持仓与决策<select className={`${input} !w-auto`} value={index} onChange={e => setDayIndex(Number(e.target.value))}>{daily?.map((d, i) => <option key={d.date} value={i}>{d.date}</option>)}</select></label><p className="text-sm">总资产 {money(selectedDay.total_value)} · 现金 {money(selectedDay.cash)}{selectedDay.exposure == null ? '' : ` · 实际仓位 ${pct(selectedDay.exposure)}`}{selectedDay.stale_marks.length > 0 ? ` · 缺行情沿用上次估值：${selectedDay.stale_marks.join('、')}` : ''}</p>{selectedDay.positions.length === 0 ? <p className="text-sm text-muted">空仓</p> : selectedDay.positions.map(p => <p key={p.symbol} className="text-sm">{names[p.symbol]} {p.symbol} · {p.shares}份 · 市值 {money(p.close * p.shares)} · 剩余成本 {money(p.cost)}</p>)}<p className="text-sm">下一交易日待执行：{selectedDay.pending ? `${selectedDay.pending.reason} → ${selectedDay.pending.target ? names[selectedDay.pending.target] ?? selectedDay.pending.target : '现金'}，剩余${selectedDay.pending.steps}步` : '无'}</p>{selectedDay.reason && <p className="text-sm text-muted">{selectedDay.reason}</p>}<Ranking signal={result.data.signals[index]} names={names} /></div>}
        <div className={panel}><h2 className="font-medium">成交明细</h2>{result.data.fills.length === 0 && <p className="text-sm text-muted">此区间无成交</p>}<div className="max-h-96 overflow-auto"><table className="w-full whitespace-nowrap text-sm"><thead><tr className="text-left text-muted">{['日期', 'ETF', '方向', '份额', '成交价', '费用', '已实现盈亏', '持有交易日', '原因'].map(h => <th className="p-2" key={h}>{h}</th>)}</tr></thead><tbody>{result.data.fills.map((f, i) => <tr key={i} className="border-t border-border"><td className="p-2">{f.date}</td><td>{names[f.symbol]} {f.symbol}</td><td>{f.side === 'buy' ? '买入' : '卖出'}</td><td>{f.shares}</td><td>{f.price.toFixed(4)}</td><td>{money(f.fee)}</td><td>{f.profit == null ? '—' : money(f.profit)}</td><td>{f.days_held == null ? '—' : f.days_held.toFixed(1)}</td><td>{f.reason}</td></tr>)}</tbody></table></div></div>
      </>}
    </div>}
    {tab === 'preview' && <div className={panel}>
      <h2 className="font-medium">{config.name} · 最新完整收盘决策</h2><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={withContext} disabled={!result.data} onChange={e => setWithContext(e.target.checked)} />使用所选回测的期末状态{!result.data && '（先选择一个已完成回测）'}</label>
      <p className="text-sm text-muted">{withContext ? '配置需与所选回测一致；在期末持仓状态上推演到最新完整交易日。' : '仅展示排名和空仓开仓判断。'}</p>
      <button className={button} disabled={preview.isFetching} onClick={() => preview.refetch()}>{preview.isFetching ? '正在计算…' : '刷新决策预览'}</button>
      {preview.error && <p role="alert" className="text-sm text-red-500">{preview.error.message}</p>}
      {preview.data && <><p className="text-sm text-muted">{preview.data.as_of} · {preview.data.context}</p><p className="text-sm">下一交易日建议：{preview.data.pending ? `${preview.data.pending.reason} → ${preview.data.pending.target ? names[preview.data.pending.target] ?? preview.data.pending.target : '现金'}，剩余${preview.data.pending.steps}步` : '无交易指令'}</p><Ranking signal={preview.data.signal} names={names} /></>}
    </div>}
  </div>
}
