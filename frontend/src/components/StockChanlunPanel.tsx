import { ChevronDown } from 'lucide-react'
import type { KlinePeriod } from '@/lib/api'
import type { ChanlunAnalysis, ChanlunStructureSource } from '@/lib/chanlun'
import { fmtAssetPrice, fmtPct } from '@/lib/format'

type Tone = 'bull' | 'bear' | 'neutral'

const PERIOD_LABELS: Record<KlinePeriod, string> = { '30m': '30F', '1d': '日K', '1w': '周K', '1mo': '月K' }
const TREND_LABELS: Record<ChanlunAnalysis['trendType'], string> = {
  uptrend_proxy: '上涨趋势近似', downtrend_proxy: '下跌趋势近似', consolidation_proxy: '盘整近似', unclear: '结构不明',
}
const CENTER_LABELS = {
  oscillating: '中枢震荡', extension: '中枢延伸', newborn: '中枢新生', broken_up: '向上离开', broken_down: '向下离开',
} as const
const SIGNAL_LABELS: Record<ChanlunAnalysis['candidateSignals'][number]['kind'], string> = {
  first_buy: '一买候选', second_buy: '二买候选', third_buy: '三买候选',
  first_sell: '一卖候选', second_sell: '二卖候选', third_sell: '三卖候选',
}

export interface ChanlunMultiPeriodItem {
  period: KlinePeriod
  analysis?: ChanlunAnalysis
  isLoading?: boolean
  error?: Error | null
}

export interface StockChanlunPanelProps {
  analysis: ChanlunAnalysis
  period: KlinePeriod
  assetType?: 'stock' | 'etf' | 'index'
  collapsed?: boolean
  onToggleCollapsed?: () => void
  isLoading?: boolean
  error?: Error | null
  source?: ChanlunStructureSource
  onSourceChange?: (source: ChanlunStructureSource) => void
  multiPeriodExpanded?: boolean
  onToggleMultiPeriod?: () => void
  multiPeriod?: ChanlunMultiPeriodItem[]
}

function shortDate(value: string | null | undefined, period: KlinePeriod): string {
  if (!value) return '—'
  return period === '30m' ? value.slice(5, 16) : value.slice(0, 10)
}
function directionLabel(direction: 'up' | 'down' | undefined) { return direction === 'up' ? '向上' : direction === 'down' ? '向下' : '—' }
function directionTone(direction: 'up' | 'down' | undefined): Tone { return direction === 'up' ? 'bull' : direction === 'down' ? 'bear' : 'neutral' }
function toneClass(tone: Tone) { return tone === 'bull' ? 'text-bull' : tone === 'bear' ? 'text-bear' : 'text-secondary' }
function positionLabel(analysis: ChanlunAnalysis) {
  return analysis.pricePosition === 'above' ? '中枢上方' : analysis.pricePosition === 'below' ? '中枢下方' : analysis.pricePosition === 'inside' ? '中枢内部' : '等待中枢'
}

function Metric({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: Tone }) {
  return <div className="min-w-0"><div className="text-[12px] text-muted">{label}</div><div className={`truncate font-mono text-[13px] tabular-nums ${toneClass(tone)}`} title={value}>{value}</div></div>
}

function Section({ title, badge, children }: { title: string; badge?: string; children: React.ReactNode }) {
  return <section className="rounded-card border border-border bg-surface/70 p-2.5 shadow-sm"><div className="mb-2 flex items-center justify-between gap-2"><div className="text-[12px] font-medium text-foreground">{title}</div>{badge && <span className="rounded border border-border bg-elevated px-1.5 py-0.5 text-[12px] text-secondary">{badge}</span>}</div>{children}</section>
}

function PositionBar({ analysis }: { analysis: ChanlunAnalysis }) {
  const center = analysis.latestCenter
  if (!center || analysis.currentPrice == null) return <div className="text-[12px] text-muted">等待有效中枢</div>
  const width = center.zg - center.zd
  if (width <= 0) return <div className="text-[12px] text-muted">ZG 与 ZD 重合，属于零宽重叠，无法计算中枢位置。</div>
  const raw = (analysis.currentPrice - center.zd) / width
  const percent = Math.max(0, Math.min(1, raw)) * 100
  return <div><div className="relative mt-1 h-1.5 overflow-hidden rounded-full bg-elevated"><div className="absolute inset-y-0 left-0 bg-[#8B5CF6]/60" style={{ width: `${percent}%` }} /><span className="absolute top-1/2 h-2.5 w-0.5 -translate-y-1/2 bg-foreground" style={{ left: `calc(${percent}% - 1px)` }} /></div><div className="mt-1 flex justify-between font-mono text-[12px] text-muted"><span>ZD</span><span>{analysis.pricePosition === 'inside' ? `${Math.round(raw * 100)}%` : positionLabel(analysis)}</span><span>ZG</span></div></div>
}

function MultiPeriodTable({ rows }: { rows: ChanlunMultiPeriodItem[] }) {
  const minute = rows.find(row => row.period === '30m')?.analysis
  const daily = rows.find(row => row.period === '1d')?.analysis
  const summary = minute && daily
    ? `30F 为${TREND_LABELS[minute.trendType]}、${positionLabel(minute)}；日线为${TREND_LABELS[daily.trendType]}、${positionLabel(daily)}。`
    : '周期数据不足，暂不生成结构对照。'
  return <><div className="overflow-x-auto"><table className="w-full min-w-[360px] text-left text-[12px]"><thead className="text-muted"><tr><th className="pb-1 font-normal">周期</th><th className="pb-1 font-normal">走势</th><th className="pb-1 font-normal">位置</th><th className="pb-1 font-normal">信号</th><th className="pb-1 font-normal">截止</th></tr></thead><tbody className="divide-y divide-border/50">{rows.map(row => {
    const latest = row.analysis?.candidateSignals.filter(item => item.status === 'candidate').at(-1)
    return <tr key={row.period}><td className="py-1 font-mono text-secondary">{PERIOD_LABELS[row.period]}</td><td className="py-1 text-secondary">{row.isLoading ? '加载中' : row.error ? '不可用' : row.analysis ? TREND_LABELS[row.analysis.trendType] : '无数据'}</td><td className="py-1 text-secondary">{row.analysis ? positionLabel(row.analysis) : '—'}</td><td className="py-1 text-secondary">{latest ? SIGNAL_LABELS[latest.kind] : '无'}</td><td className="py-1 font-mono text-muted">{shortDate(row.analysis?.window.end, row.period)}</td></tr>
  })}</tbody></table></div><div className="mt-2 rounded bg-elevated/60 px-2 py-1 text-[12px] text-secondary">{summary}</div></>
}

export function StockChanlunPanel({ analysis, period, assetType, collapsed = false, onToggleCollapsed, isLoading = false, error, source = 'stroke', onSourceChange, multiPeriodExpanded = false, onToggleMultiPeriod, multiPeriod = [] }: StockChanlunPanelProps) {
  const center = analysis.latestCenter
  const formingStroke = analysis.formingStroke
  const confirmedStroke = analysis.latestConfirmedStroke
  const latestSegment = analysis.segments.at(-1)
  const latestDivergence = analysis.divergences.at(-1)
  const centerTone: Tone = center?.state === 'broken_up' ? 'bull' : center?.state === 'broken_down' ? 'bear' : 'neutral'
  const distanceZg = center && analysis.currentPrice != null && center.zg > 0 ? analysis.currentPrice / center.zg - 1 : null
  const distanceZd = center && analysis.currentPrice != null && center.zd > 0 ? analysis.currentPrice / center.zd - 1 : null
  const nextWatch = center ? '等待中枢离开以及首次回抽结构' : '等待至少三个已确认结构单元形成共同重叠'

  return <section>
    <div className={`flex w-full items-start justify-between gap-2 px-2.5 py-2 ${collapsed ? 'border-b border-border/70' : ''}`}>
      <button type="button" onClick={onToggleCollapsed} className="flex min-w-0 flex-1 items-start gap-1.5 text-left" aria-expanded={!collapsed}>
        <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[#8B5CF6]" />
        <span className="min-w-0"><span className="flex flex-wrap items-center gap-1.5"><span className="text-xs font-medium text-foreground">缠论</span><span className="rounded bg-[#8B5CF6]/10 px-1.5 py-0.5 text-[12px] text-[#A78BFA]">结构近似 v{analysis.ruleVersion}</span><span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[12px] text-secondary">{PERIOD_LABELS[period]}</span></span>{!collapsed && <span className="mt-0.5 block truncate text-[13px] text-muted" title={analysis.approximationLoss}>{analysis.approximationLoss}</span>}</span>
      </button>
      <div className="flex shrink-0 items-center gap-1">
        {!collapsed && onSourceChange && <div className="flex rounded border border-border bg-base p-0.5 text-[12px]">{(['stroke', 'segment'] as const).map(value => <button key={value} type="button" onClick={() => onSourceChange(value)} className={`rounded px-1.5 py-0.5 ${source === value ? 'bg-[#8B5CF6]/20 text-[#A78BFA]' : 'text-muted'}`}>{value === 'stroke' ? '笔中枢' : '线段中枢'}</button>)}</div>}
        {onToggleCollapsed && <button type="button" onClick={onToggleCollapsed} className="rounded-btn p-1 text-muted transition-colors hover:bg-elevated hover:text-foreground" title={collapsed ? '展开缠论' : '收起缠论'} aria-label={collapsed ? '展开缠论' : '收起缠论'} aria-expanded={!collapsed}><ChevronDown className={`h-3.5 w-3.5 transition-transform ${collapsed ? '-rotate-90' : ''}`} /></button>}
      </div>
    </div>

    {!collapsed && (isLoading && analysis.window.bars === 0 ? <div className="grid gap-2 p-2"><div className="h-32 animate-pulse rounded-card border border-border bg-surface/60" /></div> : error && analysis.window.bars === 0 ? <div className="px-4 py-6 text-center text-xs text-muted">缠论结构暂时不可用，周期行情加载失败。</div> : <div className="grid gap-2 p-2">
      <Section title="当前结构总览" badge={analysis.source === 'stroke' ? '笔结构' : '线段代理'}><div className="grid grid-cols-2 gap-x-2 gap-y-1.5"><Metric label="走势类型" value={TREND_LABELS[analysis.trendType]} tone={analysis.trendType === 'uptrend_proxy' ? 'bull' : analysis.trendType === 'downtrend_proxy' ? 'bear' : 'neutral'} /><Metric label="当前笔" value={directionLabel(formingStroke?.direction ?? confirmedStroke?.direction)} tone={directionTone(formingStroke?.direction ?? confirmedStroke?.direction)} /><Metric label="当前线段" value={directionLabel(latestSegment?.direction)} tone={directionTone(latestSegment?.direction)} /><Metric label="结构位置" value={positionLabel(analysis)} tone={analysis.pricePosition === 'above' ? 'bull' : analysis.pricePosition === 'below' ? 'bear' : 'neutral'} /></div><div className="mt-2 border-t border-border/50 pt-1.5 text-[12px] text-muted"><span className="text-secondary">下一观察：</span>{nextWatch}</div></Section>

      <Section title="结构识别" badge={`${analysis.strokes.filter(item => item.confirmed).length} 笔 / ${analysis.segments.filter(item => item.confirmed).length} 段`}><div className="grid grid-cols-2 gap-x-2 gap-y-1.5"><Metric label="最新确认分型" value={analysis.latestFractal ? `${analysis.latestFractal.type === 'top' ? '顶' : '底'} · ${shortDate(analysis.latestFractal.date, period)}` : '—'} /><Metric label="分型可知" value={shortDate(analysis.latestFractal?.confirmedAt, period)} /><Metric label="已确认笔" value={confirmedStroke ? `${directionLabel(confirmedStroke.direction)} · ${shortDate(confirmedStroke.endDate, period)}` : '—'} tone={directionTone(confirmedStroke?.direction)} /><Metric label="形成中笔" value={formingStroke ? `${directionLabel(formingStroke.direction)} · ${shortDate(formingStroke.endDate, period)}` : '—'} tone={directionTone(formingStroke?.direction)} /><Metric label="当前线段代理" value={latestSegment ? `${directionLabel(latestSegment.direction)} · ${latestSegment.componentCount} 笔` : '—'} tone={directionTone(latestSegment?.direction)} /><Metric label="线段状态" value={latestSegment ? latestSegment.confirmed ? `已确认 ${shortDate(latestSegment.confirmedAt, period)}` : '形成中' : '—'} /></div>{analysis.issues[0] && <div className="mt-2 text-[12px] text-muted">{analysis.issues[0]}</div>}</Section>

      <Section title="中枢与结构位置" badge={center ? CENTER_LABELS[center.state] : '尚未形成'}><div className="grid grid-cols-3 gap-x-2 gap-y-1.5"><Metric label="ZG" value={fmtAssetPrice(center?.zg, assetType)} tone={centerTone} /><Metric label="ZD" value={fmtAssetPrice(center?.zd, assetType)} tone={centerTone} /><Metric label="当前价格" value={fmtAssetPrice(analysis.currentPrice, assetType)} /><Metric label="距 ZG" value={fmtPct(distanceZg)} /><Metric label="距 ZD" value={fmtPct(distanceZd)} /><Metric label="GG / DD" value={center ? `${fmtAssetPrice(center.gg, assetType)} / ${fmtAssetPrice(center.dd, assetType)}` : '—'} /><Metric label="组成" value={center ? `${center.componentCount} ${center.source === 'stroke' ? '笔' : '段'}` : '—'} /><Metric label="最早可知" value={shortDate(center?.formedAt, period)} /></div><PositionBar analysis={analysis} /></Section>

      <Section title="背驰分析" badge="价格力度代理">{latestDivergence ? <><div className="grid grid-cols-2 gap-x-2 gap-y-1.5"><Metric label="类型" value={latestDivergence.kind === 'trend' ? '趋势背驰代理' : '盘整背驰代理'} /><Metric label="状态" value={latestDivergence.status === 'candidate' ? '候选' : '未发现'} tone={latestDivergence.status === 'candidate' ? directionTone(latestDivergence.direction === 'down' ? 'up' : 'down') : 'neutral'} /><Metric label="A 段" value={`${shortDate(latestDivergence.a.startDate, period)} → ${shortDate(latestDivergence.a.endDate, period)} · ${fmtPct(latestDivergence.a.changePct)}`} /><Metric label="C 段" value={`${shortDate(latestDivergence.c.startDate, period)} → ${shortDate(latestDivergence.c.endDate, period)} · ${fmtPct(latestDivergence.c.changePct)}`} /><Metric label="价格力度 A / C" value={`${latestDivergence.a.force?.toFixed(4) ?? '—'} / ${latestDivergence.c.force?.toFixed(4) ?? '—'}`} /><Metric label="MACD 面积 A / C" value={`${latestDivergence.a.macdArea?.toFixed(3) ?? '不可计算'} / ${latestDivergence.c.macdArea?.toFixed(3) ?? '不可计算'}`} /></div><div className="mt-2 border-t border-border/50 pt-1.5 text-[12px] text-muted">{latestDivergence.evidence}；MACD 仅作辅助证据。</div></> : <div className="text-[12px] text-muted">尚无同来源、同方向且位于明确中枢两侧的可比走势。</div>}</Section>

      <Section title="多周期结构对照" badge="只读对照"><button type="button" onClick={onToggleMultiPeriod} className="mb-2 flex w-full items-center justify-between rounded-btn bg-elevated px-2 py-1 text-[12px] text-secondary"><span>{multiPeriodExpanded ? '收起多周期分析' : '展开后加载 30F / 日 / 周 / 月结构'}</span><ChevronDown className={`h-3 w-3 transition-transform ${multiPeriodExpanded ? 'rotate-180' : ''}`} /></button>{multiPeriodExpanded && <MultiPeriodTable rows={multiPeriod} />}{multiPeriodExpanded && <div className="mt-2 text-[12px] text-muted">周期之间只描述一致与冲突，不用于升级严格买卖点确认。</div>}</Section>
    </div>)}
  </section>
}
