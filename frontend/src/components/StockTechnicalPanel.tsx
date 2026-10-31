import { useMemo, useState } from 'react'
import { MomentumReversionCard } from './MomentumReversionCard'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Download, RefreshCw } from 'lucide-react'
import { api, type KlinePeriod, type KlineRow } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { fmtAssetPrice } from '@/lib/format'
import { Modal } from './Modal'
import {
  PATTERN_CATEGORIES, PATTERN_TRENDS, plainPatternText,
  type PatternDirection, type PatternHit, type PatternLevel, type TeachingPattern, type TrendPatternAnalysis,
} from '@/lib/trendPatterns'

export interface StockTechnicalPanelProps {
  selectedPattern?: string | null
  onPatternSelect?: (pattern: PatternHit | null) => void
  symbol: string
  name?: string
  rows: KlineRow[]
  period: KlinePeriod
  selectedDate: string | null
  assetType?: 'stock' | 'etf' | 'index'
  isLoading?: boolean
  error?: Error | null
  onRetry?: () => void
  collapsed?: boolean
  onToggleCollapsed?: () => void
}
const directionLabel = { bull: '偏多', bear: '偏空', neutral: '中性' }
const tone = { bull: 'text-bull', bear: 'text-bear', neutral: 'text-secondary' }
const periodLabel = { '1d': '日K', '1w': '周K', '1mo': '月K', '30m': '30F' }
const card = 'rounded-card border border-border bg-surface/60 p-2.5'
const valueText = (value: number | null | undefined, digits = 2) => value == null ? '—' : value.toFixed(digits)

export function StockTechnicalPanel({ symbol, name, rows, period, selectedDate, assetType, isLoading, error, onRetry, collapsed, onToggleCollapsed, selectedPattern, onPatternSelect }: StockTechnicalPanelProps) {
  const [library, setLibrary] = useState(false)
  const [category, setCategory] = useState('all')
  const [search, setSearch] = useState('')
  const [teachingId, setTeachingId] = useState<string | null>(null)
  const candles = useMemo(() => rows.slice(-1500).map(row => ({
    date: row.date, open: row.open, high: row.high, low: row.low, close: row.close,
    volume: row.volume ?? null, is_closed: row.is_closed === true, period_end: row.period_end ?? null,
  })), [rows])
  const asOf = selectedDate ?? rows.at(-1)?.date ?? null
  const analysis = useQuery({
    queryKey: QK.trendPatterns(symbol, assetType ?? 'stock', period, asOf, candles),
    queryFn: () => api.analyzeTrendPatterns(symbol, period, asOf, candles, name),
    enabled: !collapsed && !!symbol && candles.length > 0,
    staleTime: Infinity,
  })
  const catalog = useQuery({ queryKey: QK.patternCatalog, queryFn: api.patternCatalog, enabled: library || teachingId != null, staleTime: Infinity })
  const data = analysis.data
  const retry = () => { onPatternSelect?.(null); onRetry?.(); void analysis.refetch() }
  const teaching = catalog.data?.items.find(pattern => pattern.id === teachingId)
  const filtered = (catalog.data?.items ?? []).filter(pattern => (category === 'all' || pattern.cat === category)
    && `${pattern.name} ${pattern.en} ${pattern.tag}`.toLowerCase().includes(search.toLowerCase()))
  const exportJson = () => {
    if (!data) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = `${symbol}-${period}-${data.lastDate?.replaceAll(':', '-') ?? 'analysis'}.json`
    document.body.appendChild(anchor)
    anchor.click(); anchor.remove()
    // Embedded webviews may consume the blob after the click handler returns.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <section className="space-y-2 py-2" aria-label="趋势与经典形态分析">
    <div className="flex flex-wrap items-center justify-between gap-1.5">
      <div className="flex items-center gap-1.5 text-xs">
        <span className="font-medium text-foreground">趋势与经典形态</span>
        <span className="rounded bg-elevated px-1.5 py-0.5 text-muted">{periodLabel[period]}</span>
      </div>
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => setLibrary(open => !open)} className="rounded px-2 py-1 text-[11px] text-accent hover:bg-elevated">{library ? '返回诊断' : '84形态库'}</button>
        <button type="button" onClick={retry} disabled={analysis.isFetching || !candles.length} aria-label="重新计算形态分析" className="rounded p-1 text-muted disabled:opacity-40"><RefreshCw className={`h-3.5 w-3.5 ${analysis.isFetching ? 'animate-spin' : ''}`} /></button>
        <button type="button" onClick={exportJson} disabled={!data} aria-label="导出完整分析JSON" className="rounded p-1 text-muted disabled:opacity-40"><Download className="h-3.5 w-3.5" /></button>
        {onToggleCollapsed && <button type="button" onClick={onToggleCollapsed} aria-label={collapsed ? '展开指标分析' : '收起指标分析'} aria-expanded={!collapsed} className="rounded p-1 text-muted"><ChevronDown className={`h-3.5 w-3.5 ${collapsed ? '-rotate-90' : ''}`} /></button>}
      </div>
    </div>
    {!collapsed && (library ? <>
      <p className="text-[11px] leading-relaxed text-muted">教学图解中的价格为示例；诊断中的关键位由当前行情结构计算。</p>
      <input aria-label="搜索经典形态" placeholder="搜索名称、英文或特征" value={search} onChange={event => setSearch(event.target.value)} className="w-full rounded border border-border bg-base px-2 py-1.5 text-xs text-foreground" />
      <select aria-label="形态类别" value={category} onChange={event => setCategory(event.target.value)} className="w-full rounded border border-border bg-base p-1.5 text-xs text-secondary">
        <option value="all">全部类别</option>{Object.entries(PATTERN_CATEGORIES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
      {catalog.isPending ? <p className="text-xs text-muted">形态库加载中…</p> : catalog.isError ? <button type="button" onClick={() => { void catalog.refetch() }} className="text-xs text-accent">形态库加载失败，点击重试</button> : <>
        <p className="text-[11px] text-muted">共 {filtered.length} 个形态</p>
        {filtered.map(pattern => <button type="button" key={pattern.id} onClick={() => setTeachingId(pattern.id)} className={`${card} block w-full text-left`}>
          <span className={`text-xs font-medium ${tone[pattern.dir]}`}>{pattern.name}</span>
          <span className="ml-1 text-[10px] text-muted">{PATTERN_CATEGORIES[pattern.cat]}</span>
          <p className="mt-1 text-[11px] text-secondary">{pattern.tag}</p>
        </button>)}
        {!filtered.length && <p className="text-xs text-muted">没有匹配的形态</p>}
      </>}
    </> : error && !rows.length ? <Empty text="行情加载失败，无法分析。" retry={onRetry} />
      : isLoading && !rows.length || analysis.isPending && !!candles.length ? <p role="status" className="p-4 text-xs text-muted">正在计算趋势、指标与经典形态…</p>
        : !rows.length ? <Empty text="暂无K线数据" />
          : analysis.isError && !data ? <Empty text="形态分析失败，请重试。" retry={retry} />
            : data ? <>
              {(analysis.isError || error) && <p role="alert" className="text-[11px] text-warning">刷新失败，正在展示上次有效结果。<button type="button" onClick={retry} className="ml-1 text-accent">重试</button></p>}
              <AnalysisResult data={data} assetType={assetType} onTeaching={setTeachingId} selectedPattern={selectedPattern} onPatternSelect={onPatternSelect} />
            </> : null)}
    {!collapsed && teachingId && <Modal
      onClose={() => setTeachingId(null)}
      labelledBy="pattern-teaching-title"
      overlayClassName="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm sm:p-4"
      panelClassName="flex max-h-[88vh] w-[92vw] max-w-2xl flex-col overflow-hidden rounded-card border border-border bg-surface shadow-2xl"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        <h2 id="pattern-teaching-title" className="truncate text-sm font-semibold text-foreground">{teaching?.name ?? '教学图解'}</h2>
        <button type="button" onClick={() => setTeachingId(null)} className="shrink-0 rounded px-2 py-1 text-xs text-accent hover:bg-elevated">关闭教学</button>
      </header>
      <div className="min-h-0 space-y-2 overflow-y-auto p-4">
        {teaching ? <>
          <p className="text-[11px] text-warning">教学示例，非当前标的行情</p>
          <TeachingChart pattern={teaching} />
          <ol className="list-inside list-decimal space-y-1 text-[11px] leading-relaxed text-secondary">{teaching.steps.map((step, index) => <li key={index}>{plainPatternText(step)}</li>)}</ol>
          <dl className="space-y-1 text-[11px] leading-relaxed">{[['买点示例', teaching.buy], ['卖点示例', teaching.sell], ['止损示例', teaching.stop], ['目标示例', teaching.target], ['量能要求', teaching.vol_note]].map(([label, text]) => <div key={label}><dt className="text-muted">{label}</dt><dd className="text-secondary">{plainPatternText(text)}</dd></div>)}</dl>
        </> : catalog.isError ? <button type="button" onClick={() => { void catalog.refetch() }} className="text-xs text-accent">教学加载失败，点击重试</button> : <p role="status" className="text-xs text-muted">教学加载中…</p>}
      </div>
    </Modal>}
  </section>
}

function Empty({ text, retry }: { text: string; retry?: () => void }) {
  return <div className="space-y-2 p-4 text-center text-xs text-muted"><p>{text}</p>{retry && <button type="button" onClick={retry} className="text-accent">重试</button>}</div>
}

function AnalysisResult({ data, assetType, onTeaching, selectedPattern, onPatternSelect }: { selectedPattern?: string | null; onPatternSelect?: (pattern: PatternHit | null) => void; data: TrendPatternAnalysis; assetType?: StockTechnicalPanelProps['assetType']; onTeaching: (id: string) => void }) {
  const v = data.verdict
  const price = (value: number | null) => fmtAssetPrice(value, assetType)
  const stanceTone = v.stanceEn.includes('bull') ? tone.bull : v.stanceEn.includes('bear') ? tone.bear : tone.neutral
  const [direction, setDirection] = useState<PatternDirection | 'all'>('all')
  const patterns = data.patterns.filter(pattern => direction === 'all' || pattern.dir === direction)
  const ind = data.indicators
  const latestIndicators = [
    ...Object.entries(ind.ma).map(([label, series]) => [label.toUpperCase(), price(series.at(-1) ?? null)]),
    ...Object.entries(ind.macd).map(([label, series]) => [`MACD ${label.toUpperCase()}`, valueText(series.at(-1))]),
    ['RSI14', valueText(ind.rsi.at(-1))], ...Object.entries(ind.kdj).map(([label, series]) => [`KDJ ${label.toUpperCase()}`, valueText(series.at(-1))]),
    ...Object.entries(ind.boll).map(([label, series]) => [`BOLL ${{ mid: '中轨', up: '上轨', dn: '下轨' }[label as 'mid' | 'up' | 'dn']}`, price(series.at(-1) ?? null)]),
    ['OBV', valueText(ind.obv.at(-1), 0)], ['VOL MA5', valueText(ind.volMa5.at(-1), 0)], ['VOL MA20', valueText(ind.volMa20.at(-1), 0)],
  ]
  return <>
    <section aria-label="指标综合研判" className={`${card} space-y-2`}>
      <div className="flex flex-wrap items-center justify-between gap-1 text-[11px] text-muted"><span>综合研判</span><span>截至 {data.lastDate ?? '—'}</span></div>
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className={`text-sm font-semibold ${stanceTone}`}>{v.stance}</h3><span className="font-mono text-xs text-secondary">综合分 {valueText(v.score, 1)}</span></div>
      <div className="grid grid-cols-3 gap-1 text-center text-[11px]">{[['形态分', v.patternScore], ['均线分', v.maScore], ['趋势分', v.trendScore]].map(([label, value]) => <div key={label} className="rounded bg-base/40 p-1.5"><div className="text-muted">{label}</div><div className="mt-1 font-mono text-secondary">{valueText(value as number | null, 1)}</div></div>)}</div>
      <p className={`text-[11px] ${v.agree ? stanceTone : 'text-warning'}`}>{data.status === 'insufficient' ? data.issues.join('；') : v.agree ? '形态、均线与趋势同向确认' : '三个分项未同向，综合倾向仍有分歧'}</p>
      <p className="text-xs leading-relaxed text-secondary">{v.advice}</p>
      <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border/50 pt-2 text-[11px] text-muted"><span>现价 {price(data.price)}</span><span>{v.maAlign}</span><span>量比(5/20) {valueText(v.volRatio)}</span><span>盈亏比 {valueText(v.rr)}</span></div>
      {data.forming && <p className="text-[11px] text-warning">未收盘K线已排除，当前诊断仅使用已收盘行情。</p>}
      <p className="text-[10px] leading-relaxed text-muted">形态匹配度是规则分值，不是胜率；形成中的形态不计入形态方向分。</p>
    </section>
    <MomentumReversionCard data={data.momentumReversion} />
    <section className={card} aria-label="三级趋势">
      <h4 className="mb-2 text-xs font-medium text-foreground">三级趋势</h4>
      <div className="grid grid-cols-3 gap-1">{(['long', 'mid', 'short'] as const).map(key => <div key={key} className="min-w-0 rounded bg-base/30 p-1.5 text-[11px]">
        <p className="text-muted">{{ long: '长期', mid: '中期', short: '短期' }[key]} · {data.trend[key].window}根</p>
        <p className={`mt-1 ${data.trend[key].verdict.startsWith('up') ? tone.bull : data.trend[key].verdict.startsWith('down') ? tone.bear : tone.neutral}`}>{PATTERN_TRENDS[data.trend[key].verdict] ?? '样本不足'}</p>
      </div>)}</div>
      <details className="mt-2 text-[11px] text-muted"><summary className="cursor-pointer">查看摆动高低点</summary><div className="mt-1 space-y-1">{(['long', 'mid', 'short'] as const).map(key => <p key={key}>{{ long: '长期', mid: '中期', short: '短期' }[key]}：高点 {data.trend[key].swingHighs.map(price).join(' / ') || '—'}；低点 {data.trend[key].swingLows.map(price).join(' / ') || '—'}</p>)}</div></details>
    </section>
    <section className={`${card} space-y-2`} aria-label="形态支撑阻力">
      <h4 className="text-xs font-medium text-foreground">支撑与阻力</h4>
      {(['resistance', 'support'] as const).map(side => <div key={side}><p className={`mb-1 text-[11px] ${side === 'support' ? tone.bull : tone.bear}`}>{side === 'support' ? '支撑' : '阻力'}</p>
        {data.levels[side].length ? data.levels[side].map(level => <LevelRow key={level.price} level={level} price={price} />) : <p className="text-[11px] text-muted">暂无已确认价位</p>}
      </div>)}
      <p className="text-[10px] text-muted">按距现价排序；盈亏比为最近阻力空间 / 最近支撑距离。</p>
    </section>
    <section className="space-y-2" aria-label="命中经典形态">
      <div className="flex flex-wrap items-center justify-between gap-1"><h4 className="text-xs font-medium text-foreground">命中形态 · {data.patterns.length}</h4><select aria-label="筛选形态方向" value={direction} onChange={event => setDirection(event.target.value as PatternDirection | 'all')} className="rounded border border-border bg-base p-1 text-[11px] text-secondary"><option value="all">全部方向</option><option value="bull">偏多</option><option value="bear">偏空</option><option value="neutral">中性</option></select></div>
      {patterns.map(pattern => <PatternCard key={pattern.id} pattern={pattern} onTeaching={onTeaching} selected={selectedPattern === pattern.id} onSelect={onPatternSelect} />)}
      {!patterns.length && <p className={`${card} text-xs leading-relaxed text-muted`}>当前样本未匹配到符合条件的经典形态。无形态不等于无趋势，可结合三级趋势与均线观察。</p>}
    </section>
    <details className={`${card} text-[11px] text-secondary`}><summary className="cursor-pointer">指标与数据明细</summary>
      <div className="mt-2 grid grid-cols-2 gap-2">{latestIndicators.map(([label, value]) => <div key={label} className="min-w-0"><div className="text-muted">{label}</div><div className="break-words font-mono">{value}</div></div>)}</div>
      <div className="mt-2 border-t border-border/50 pt-2 text-muted">计算样本 {data.sampleCount} 根 · 返回 {data.candles.length} 根 · 高点 {data.swings.ph.length} / 低点 {data.swings.pl.length}</div>
      <div className="mt-2 overflow-x-auto"><table className="w-full whitespace-nowrap text-right text-[10px]"><caption className="text-left text-muted">最近10根K线 · 日期 / 开 / 高 / 低 / 收 / 成交量</caption><tbody>{data.candles.slice(-10).map(row => <tr key={row[0]}>{row.map((value, index) => <td key={index} className="px-1 py-0.5">{index === 0 ? value : index === 5 ? valueText(value as number | null, 0) : price(value as number)}</td>)}</tr>)}</tbody></table></div>
      <p className="mt-2 text-muted">完整 candles、indicators、trend、swings、levels、patterns、verdict 可通过顶部按钮导出 JSON。</p>
    </details>
  </>
}
function LevelRow({ level, price }: { level: PatternLevel; price: (value: number | null) => string }) {
  return <div className="flex flex-wrap items-baseline justify-between gap-1 border-t border-border/30 py-1 text-[11px]"><span className="font-mono text-secondary">{price(level.price)} <span className="text-muted">{level.dist >= 0 ? '+' : ''}{level.dist.toFixed(2)}%</span></span><span className="text-muted">{level.touches}次 · {level.lastDate}</span></div>
}
function PatternCard({ pattern, onTeaching, selected, onSelect }: { selected?: boolean; onSelect?: (pattern: PatternHit | null) => void; pattern: PatternHit; onTeaching: (id: string) => void }) {
  return <article className={`${card} space-y-1.5 ${selected ? "ring-1 ring-accent" : ""}`}>
    <div className="flex flex-wrap items-center justify-between gap-1"><h5 className={`text-xs font-medium ${tone[pattern.dir]}`}><button type="button" aria-pressed={!!selected} onClick={() => onSelect?.(selected ? null : pattern)} className="text-left hover:underline">{pattern.name}</button></h5><span className="text-[10px] text-muted">{directionLabel[pattern.dir]} · {pattern.status === 'confirmed' ? '已确认' : '形成中'}</span></div>
    <div className="flex flex-wrap justify-between gap-1 text-[10px] text-muted"><span>匹配度 {pattern.conf}/100</span><span>{pattern.confirmedAt ? `确认于 ${pattern.confirmedAt}` : `观察于 ${pattern.date}`}</span></div>
    <p className="text-[11px] leading-relaxed text-secondary">{pattern.note}</p>
    <details className="text-[11px]"><summary className="cursor-pointer text-muted">结构价位与量能依据</summary><dl className="mt-1 space-y-1 leading-relaxed">{[['买点观察', pattern.buy], ['卖点观察', pattern.sell], ['失效参考', pattern.stop], ['测量目标', pattern.target], ['量能', pattern.vol_note]].map(([label, value]) => <div key={label}><dt className="text-muted">{label}</dt><dd className="break-words text-secondary">{value}</dd></div>)}</dl></details>
    <button type="button" onClick={() => onTeaching(pattern.id)} className="text-[11px] text-accent">查看教学图解</button>
  </article>
}
function TeachingChart({ pattern }: { pattern: TeachingPattern }) {
  const candles = pattern.candles
  if (!candles.length) return null
  const high = Math.max(...candles.map(row => row[1])), low = Math.min(...candles.map(row => row[2]))
  const x = (i: number) => 12+(i+.5)*276/candles.length
  const y = (price: number) => 12+(high-price)/Math.max(high-low, .001)*126
  return <svg role="img" aria-label={`${pattern.name}教学示意图`} viewBox="0 0 300 154" className="w-full rounded bg-base">
    {candles.map((row, i) => <g key={i} className={row[3] >= row[0] ? 'text-bull' : 'text-bear'}><line x1={x(i)} y1={y(row[1])} x2={x(i)} y2={y(row[2])} stroke="currentColor" /><rect x={x(i)-Math.max(1, 90/candles.length)} y={y(Math.max(row[0], row[3]))} width={Math.max(2, 180/candles.length)} height={Math.max(1, Math.abs(y(row[0])-y(row[3])))} fill="currentColor" /></g>)}
    {(pattern.lines ?? []).map((line, i) => <line key={i} x1={x(line.k1)} y1={y(line.p1)} x2={x(line.k2)} y2={y(line.p2)} className="text-accent" stroke="currentColor" strokeDasharray="3 3"><title>{line.label}</title></line>)}
  </svg>
}
