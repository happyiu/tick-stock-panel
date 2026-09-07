import { CheckCircle2, ChevronDown, Circle, Eye, EyeOff, HelpCircle, XCircle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ChanlunCandidateKind, ChanlunCondition } from '@/lib/chanlun'
import { fmtAssetPrice, fmtPct } from '@/lib/format'
import type { SignalRiskContext } from '@/lib/signalRisk'
import { selectPreferredSignal } from '@/lib/signalRisk'

interface Props {
  contexts: SignalRiskContext[]
  period: '30m' | '1d' | '1w' | '1mo'
  assetType?: 'stock' | 'etf' | 'index'
  collapsed?: boolean
  onToggleCollapsed?: () => void
  showInvalidationLine?: boolean
  onToggleShowInvalidationLine?: () => void
  selectedSignalId?: string | null
  onSelectSignal?: (signalId: string | null) => void
}

type Direction = 'buy' | 'sell'

const KIND_LABELS: Record<ChanlunCandidateKind, string> = {
  first_buy: '一买候选', second_buy: '二买候选', third_buy: '三买候选',
  first_sell: '一卖候选', second_sell: '二卖候选', third_sell: '三卖候选',
}
const STATUS_LABELS = {
  waiting_pullback: '等待', candidate: '候选', invalidated: '失效', rejected: '不成立',
} as const
const PERIOD_LABELS = { '30m': '30F', '1d': '日K', '1w': '周K', '1mo': '月K' } as const

function isBuy(context: SignalRiskContext): boolean { return context.direction === 'buy' }
function signalLabel(context: SignalRiskContext): string {
  const base = KIND_LABELS[context.signal.kind]
  return context.signal.origin === 'consolidation_divergence' ? `盘整背驰观察 · ${base}` : base
}
function shortDate(value: string | null | undefined): string { return value ? value.slice(0, 16).replace('T', ' ') : '—' }
function statusClass(status: keyof typeof STATUS_LABELS): string {
  return status === 'candidate' ? 'bg-bull/15 text-bull' : status === 'invalidated' || status === 'rejected' ? 'bg-bear/15 text-bear' : 'bg-elevated text-secondary'
}

function ConditionRow({ item }: { item: ChanlunCondition }) {
  const Icon = item.state === 'met' ? CheckCircle2 : item.state === 'failed' ? XCircle : item.state === 'unavailable' ? HelpCircle : Circle
  const color = item.state === 'met' ? 'text-bull' : item.state === 'failed' ? 'text-bear' : 'text-muted'
  const state = item.state === 'met' ? '满足' : item.state === 'failed' ? '不满足' : item.state === 'unavailable' ? '数据不足' : '等待'
  return <div className="flex items-start gap-1.5 border-b border-border/40 py-1.5 last:border-0"><Icon className={`mt-0.5 h-3 w-3 shrink-0 ${color}`} /><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2 text-[9px]"><span className="text-secondary">{item.label}</span><span className={color}>{state}</span></div><div className="break-words text-[8px] text-muted">{item.evidence}</div></div></div>
}

function RiskMetric({ label, value, tone = 'text-secondary' }: { label: string; value: string; tone?: string }) {
  return <div className="min-w-0"><div className="text-[8px] text-muted">{label}</div><div className={`truncate font-mono text-[10px] tabular-nums ${tone}`} title={value}>{value}</div></div>
}

function ContextCard({ context, selected, assetType, onSelect }: { context: SignalRiskContext; selected: boolean; assetType?: string; onSelect: () => void }) {
  const status = context.signal.status
  return <button type="button" onClick={onSelect} aria-pressed={selected} className={`w-full rounded-card border p-2 text-left transition-colors ${selected ? 'border-accent/70 bg-accent/10' : 'border-border bg-surface/60 hover:bg-elevated'}`}><div className="flex items-center justify-between gap-2"><span className={`min-w-0 truncate text-[10px] font-medium ${isBuy(context) ? 'text-bull' : 'text-bear'}`} title={signalLabel(context)}>{signalLabel(context)}</span><span className={`shrink-0 rounded px-1.5 py-0.5 text-[8px] ${statusClass(status)}`}>{STATUS_LABELS[status]}</span></div><div className="mt-1 grid grid-cols-3 gap-2 text-[8px]"><RiskMetric label="最早可知" value={shortDate(context.signal.availableDate)} /><RiskMetric label="结构发生" value={shortDate(context.signal.structureDate)} /><RiskMetric label="结构价" value={fmtAssetPrice(context.signal.price, assetType)} /></div></button>
}

function RiskDetails({ context, assetType }: { context: SignalRiskContext; assetType?: string }) {
  const { signal } = context
  return <div className="rounded-card border border-border bg-surface/70 p-2.5"><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><div><span className={`text-[11px] font-medium ${isBuy(context) ? 'text-bull' : 'text-bear'}`}>{signalLabel(context)}</span><span className="ml-1.5 text-[8px] text-muted">结构近似 · {shortDate(signal.availableDate)} 可知</span></div><span className="rounded px-1.5 py-0.5 text-[8px] text-muted">{signal.status === 'candidate' ? '候选，不是严格确认' : STATUS_LABELS[signal.status]}</span></div><div className="grid grid-cols-2 gap-x-3 gap-y-1.5 border-b border-border/50 pb-2 sm:grid-cols-4"><RiskMetric label="观察时点价格" value={fmtAssetPrice(context.referencePrice, assetType)} /><RiskMetric label="结构失效边界" value={fmtAssetPrice(context.invalidation, assetType)} tone={isBuy(context) ? 'text-bear' : 'text-bull'} /><RiskMetric label="目标一" value={context.target1 ? `${fmtAssetPrice(context.target1.low, assetType)} ~ ${fmtAssetPrice(context.target1.high, assetType)}` : '—'} /><RiskMetric label="目标二" value={context.target2 ? `${fmtAssetPrice(context.target2.low, assetType)} ~ ${fmtAssetPrice(context.target2.high, assetType)}` : '—'} /></div>{context.status === 'calculable' ? <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-4"><RiskMetric label={isBuy(context) ? '风险距离' : '上行失效距离'} value={fmtPct(context.riskPct)} tone="text-bear" /><RiskMetric label={isBuy(context) ? '目标一空间' : '目标一下行空间'} value={fmtPct(context.target1Pct)} tone="text-bull" /><RiskMetric label={isBuy(context) ? '空间比 T1 / 风险' : '下行观察空间比 T1'} value={context.riskReward1 != null ? `1 : ${context.riskReward1.toFixed(2)}` : '—'} tone="text-accent" /><RiskMetric label={isBuy(context) ? '空间比 T2 / 风险' : '下行观察空间比 T2'} value={context.riskReward2 != null ? `1 : ${context.riskReward2.toFixed(2)}` : '—'} tone="text-accent" /></div> : <div className="mt-2 rounded bg-elevated/60 px-2 py-1.5 text-[9px] text-muted">风险收益暂不可计算：{context.reason ?? '缺少有效边界或目标区间'}</div>}<div className="mt-2 border-t border-border/50 pt-2"><div className="mb-1 text-[9px] font-medium text-foreground">买卖点条件检查器</div>{signal.conditions.map(item => <ConditionRow key={item.id} item={item} />)}<div className="mt-1 text-[8px] text-muted">下一观察：{signal.nextWatch}</div></div><div className="mt-2 text-[8px] text-muted">风险收益是按观察时点价格计算的结构空间测算，不计费用、滑点或成交约束；卖侧仅表示下行观察空间。</div></div>
}

export function StockSignalRiskPanel({ contexts, period, assetType, collapsed = false, onToggleCollapsed, showInvalidationLine = true, onToggleShowInvalidationLine, selectedSignalId, onSelectSignal }: Props) {
  const [direction, setDirection] = useState<Direction>('buy')
  const preferred = useMemo(() => selectPreferredSignal(contexts), [contexts])
  const key = `${period}:${contexts.map(context => context.signal.id).join(',')}`
  useEffect(() => {
    const selectedContext = selectedSignalId
      ? contexts.find(context => context.signal.id === selectedSignalId)
      : null
    if (selectedContext) {
      setDirection(selectedContext.direction)
    } else if (preferred) {
      onSelectSignal?.(preferred.signal.id)
      setDirection(preferred.direction)
    }
  }, [contexts, key, onSelectSignal, preferred, selectedSignalId])

  const sideContexts = contexts.filter(context => context.direction === direction)
  const active = sideContexts.filter(context => context.signal.status === 'candidate' || context.signal.status === 'waiting_pullback')
  const history = sideContexts.filter(context => context.signal.status === 'invalidated' || context.signal.status === 'rejected').sort((a, b) => b.signal.availableDate.localeCompare(a.signal.availableDate))
  const selected = sideContexts.find(context => context.signal.id === selectedSignalId) ?? active[0] ?? history[0] ?? null

  return <section className="border-b border-border/70">
    <div className={`flex items-start justify-between gap-2 px-2.5 py-2 ${collapsed ? '' : 'border-b border-border/70'}`}>
      <div className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-1.5"><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#22C55E]" /><span className="text-xs font-medium text-foreground">缠论信号与风险收益</span><span className="rounded bg-[#8B5CF6]/10 px-1.5 py-0.5 text-[9px] text-[#A78BFA]">结构近似</span><span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[9px] text-secondary">{PERIOD_LABELS[period]}</span></span>{!collapsed && <span className="mt-0.5 block truncate text-[9px] text-muted">候选状态独立于技术评分；缺少低级别递归时不会升级为严格确认。</span>}</div>
      <div className="flex shrink-0 items-center gap-1">{onToggleShowInvalidationLine && <button type="button" onClick={onToggleShowInvalidationLine} className={`flex shrink-0 items-center gap-1 rounded-btn px-1.5 py-1 text-[9px] ${showInvalidationLine ? 'bg-accent/15 text-accent' : 'bg-elevated text-muted'}`} aria-pressed={showInvalidationLine} title={showInvalidationLine ? '隐藏结构失效线' : '显示结构失效线'}>{showInvalidationLine ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}失效线</button>}
        {onToggleCollapsed && <button type="button" onClick={onToggleCollapsed} className="rounded-btn p-1 text-muted transition-colors hover:bg-elevated hover:text-foreground" aria-expanded={!collapsed} aria-label={collapsed ? '展开缠论信号与风险收益' : '收起缠论信号与风险收益'} title={collapsed ? '展开缠论信号与风险收益' : '收起缠论信号与风险收益'}><ChevronDown className={`h-3.5 w-3.5 transition-transform ${collapsed ? '-rotate-90' : ''}`} /></button>}
      </div></div>{!collapsed && <div className="grid gap-2 p-2"><div className="flex rounded border border-border bg-base p-0.5 text-[9px]"><button type="button" onClick={() => setDirection('buy')} className={`flex-1 rounded px-2 py-1 ${direction === 'buy' ? 'bg-bull/15 text-bull' : 'text-muted'}`}>买侧 {contexts.filter(context => context.direction === 'buy').length}</button><button type="button" onClick={() => setDirection('sell')} className={`flex-1 rounded px-2 py-1 ${direction === 'sell' ? 'bg-bear/15 text-bear' : 'text-muted'}`}>卖侧 {contexts.filter(context => context.direction === 'sell').length}</button></div>{active.length > 0 ? <div className="grid gap-1.5">{active.map(context => <ContextCard key={context.signal.id} context={context} selected={selected?.signal.id === context.signal.id} assetType={assetType} onSelect={() => onSelectSignal?.(context.signal.id)} />)}</div> : <div className="rounded-card border border-border/60 px-2 py-2 text-[9px] text-muted">当前周期暂无{direction === 'buy' ? '买侧' : '卖侧'}有效候选。</div>}{selected && <RiskDetails context={selected} assetType={assetType} />}{history.length > 0 && <details className="rounded-card border border-border/60 bg-elevated/30 px-2 py-1.5"><summary className="cursor-pointer text-[9px] text-secondary">历史失效／不成立（{history.length}）</summary><div className="mt-1.5 grid gap-1.5">{history.map(context => <ContextCard key={context.signal.id} context={context} selected={selected?.signal.id === context.signal.id} assetType={assetType} onSelect={() => onSelectSignal?.(context.signal.id)} />)}</div></details>}{contexts.length === 0 && <div className="rounded-card border border-border bg-elevated/40 px-2 py-2 text-[9px] text-muted">尚未形成可追溯的一、二、三类候选；请等待更多已闭合 K 线。</div>}</div>}</section>
}
