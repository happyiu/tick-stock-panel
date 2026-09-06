import { AlertTriangle, ChevronDown, ChevronRight, CircleAlert, Database, Info, Target } from 'lucide-react'
import { useState } from 'react'
import { fmtAssetPrice, fmtPct } from '@/lib/format'
import type { PriceZone } from '@/lib/priceZones'
import type {
  StockDecisionState,
  StockSummaryEvidence,
  StockSummarySnapshot,
  StockSummaryTone,
} from '@/lib/stockSummary'
import type { ActionCurrentAction, ActionSignalComparison, ActionSignalResult } from '@/lib/actionSignals'

type FocusSection = 'technical' | 'structure' | 'levels' | 'risk'

interface Props {
  snapshot: StockSummarySnapshot
  onSelectZone?: (zone: PriceZone) => void
  onSelectSignal?: (signalId: string) => void
  onFocusSection?: (section: FocusSection) => void
  onLatest?: () => void
  isLoading?: boolean
  error?: Error | null
  onRetry?: () => void
}

const PERIOD_LABELS = { '30m': '30F', '1d': '日K', '1w': '周K', '1mo': '月K' } as const

const TONE_CLASSES: Record<StockSummaryTone, { text: string; badge: string; dot: string }> = {
  bull: { text: 'text-bull', badge: 'border-bull/30 bg-bull/10 text-bull', dot: 'bg-bull' },
  bear: { text: 'text-bear', badge: 'border-bear/30 bg-bear/10 text-bear', dot: 'bg-bear' },
  neutral: { text: 'text-secondary', badge: 'border-border bg-elevated text-secondary', dot: 'bg-muted' },
  warning: { text: 'text-warning', badge: 'border-warning/30 bg-warning/10 text-warning', dot: 'bg-warning' },
}

function scoreText(value: number | null): string {
  return value == null ? '—' : `${Math.round(value)}`
}

function shortDate(value: string | null | undefined, period: keyof typeof PERIOD_LABELS): string {
  if (!value) return '—'
  return period === '30m' ? value.slice(5, 16) : value.slice(0, 10)
}

function sourceLabel(source: StockSummaryEvidence['source']): string {
  return ({ quality: '数据', technical: '技术', structure: '结构', wave: '波浪', level: '价位', risk: '风险' })[source]
}

function EvidenceRow({
  item,
  onClick,
}: {
  item: StockSummaryEvidence
  onClick?: () => void
}) {
  const tone = TONE_CLASSES[item.tone]
  const content = (
    <>
      <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-[9px] text-muted">{sourceLabel(item.source)}</span>
          <span className="truncate text-[10px] font-medium text-secondary">{item.label}</span>
        </span>
        <span className="mt-0.5 block break-words text-[10px] leading-relaxed text-muted">{item.text}</span>
      </span>
      {onClick && <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-muted" />}
    </>
  )
  if (!onClick) return <div className="flex items-start gap-1.5 border-b border-border/40 py-1.5 last:border-0">{content}</div>
  return <button type="button" onClick={onClick} className="flex w-full items-start gap-1.5 border-b border-border/40 py-1.5 text-left transition-colors hover:bg-elevated/50 last:border-0">{content}</button>
}

function scoreTone(value: number | null): StockSummaryTone {
  if (value == null) return 'neutral'
  return value >= 60 ? 'bull' : value <= 40 ? 'bear' : 'neutral'
}

const DECISION_LABELS: Record<StockDecisionState, string> = {
  buy: '买入',
  probe: '试仓',
  wait: '等待',
  reduce: '减仓',
  sell: '卖出',
}

const ACTION_LABELS: Record<ActionCurrentAction, string> = {
  attack: '进攻',
  add: '加仓',
  reduce: '减仓',
  retreat: '撤退',
  hold: '持有',
  defensive: '偏防守',
  wait: '等待',
  wait_defensive: '等待·偏防守',
}

function actionTone(action: ActionSignalResult): StockSummaryTone {
  if (action.status === 'blocked') return 'neutral'
  if (action.status === 'provisional' || action.status === 'stale') return 'warning'
  if (action.current.action === 'attack' || action.current.action === 'add' || action.current.action === 'hold') return 'bull'
  if (action.current.action === 'reduce' || action.current.action === 'retreat' || action.current.action === 'defensive') return 'bear'
  return 'warning'
}

function ActionSignalCard({ action, comparison, assetType }: { action: ActionSignalResult; comparison?: ActionSignalComparison | null; assetType?: string }) {
  const tone = TONE_CLASSES[actionTone(action)]
  const event = action.currentEvent
  const score = action.current.score
  const scoreValues = [score?.direction, score?.trend, score?.momentum, score?.volumePrice]
  const scoreLabel = score && scoreValues.every(value => value != null) ? `方向 ${Math.round(score.direction!)} · 趋势 ${Math.round(score.trend!)} · 动能 ${Math.round(score.momentum!)} · 量价 ${Math.round(score.volumePrice!)}` : '技术评分 —'
  const statusLabel = action.status === 'ready' ? '已确认' : action.status === 'provisional' ? '待收盘确认' : action.status === 'stale' ? '过期快照' : '数据不足'
  return <div className={`rounded-card border p-2.5 shadow-sm ${tone.badge}`}>
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold ${tone.badge}`}>行动信号：{ACTION_LABELS[action.current.action]}</span>
          <span className="text-[9px] text-muted">{statusLabel}</span>
        </div>
        <div className={`mt-1 text-xs font-semibold ${tone.text}`}>{action.reason}</div>
      </div>
      <span className={`shrink-0 font-mono text-[9px] ${tone.text}`}>{scoreLabel}</span>
    </div>
    {event && <div className="mt-2 rounded border border-border/60 bg-base/30 px-2 py-1.5 text-[9px]">
      <div className="flex items-center justify-between gap-2"><span className="font-medium text-secondary">最近事件 · {ACTION_LABELS[event.type]}{event.structureMode === 'structure_proxy' ? ' · 结构代理' : ''}</span><span className="font-mono text-muted">{shortDate(event.confirmedAt, action.period === '30m' ? '30m' : action.period)}</span></div>
      <div className="mt-0.5 leading-relaxed text-muted">{event.reasons.join('；')}</div>
      {event.referencePrice != null && <div className="mt-0.5 text-secondary">参考位 {fmtAssetPrice(event.referencePrice, assetType)}</div>}
      {event.invalidationPrice != null && <div className="mt-0.5 text-bear">防守位 {fmtAssetPrice(event.invalidationPrice, assetType)}</div>}
    </div>}
    <div className="mt-2 grid gap-2 sm:grid-cols-2">
      <div className="rounded border border-border/60 bg-base/30 px-2 py-1.5"><div className="mb-1 text-[9px] font-medium text-foreground">升级条件</div>{action.nextConditions.map((item, index) => <div key={`${item}-${index}`} className="text-[9px] leading-relaxed text-muted">· {item}</div>)}</div>
      <div className="rounded border border-border/60 bg-base/30 px-2 py-1.5"><div className="mb-1 text-[9px] font-medium text-foreground">风险条件</div>{action.riskConditions.map((item, index) => <div key={`${item}-${index}`} className="text-[9px] leading-relaxed text-muted">· {item}</div>)}</div>
    </div>
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[8px] text-muted"><span>回放起点 {shortDate(action.analysisStartDate, action.period === '30m' ? '30m' : action.period)}</span><span>事件 {action.events.length} 次</span>{action.pendingConfirmation && <span className="text-warning">有待确认变化</span>}</div>
    {comparison && <div className={`mt-1.5 rounded border px-2 py-1 text-[9px] ${comparison.status === 'divergent' ? 'border-warning/30 bg-warning/5 text-warning' : comparison.status === 'aligned' ? 'border-bull/20 bg-bull/5 text-bull' : 'border-border/60 bg-base/30 text-muted'}`}>跨周期：{comparison.text}</div>}
  </div>
}

function decisionTone(snapshot: StockSummarySnapshot): StockSummaryTone {
  if (snapshot.decision.inputState !== 'ready') return snapshot.decision.inputState === 'blocked' ? 'neutral' : 'warning'
  if (snapshot.decision.state === 'buy' || snapshot.decision.state === 'probe') return 'bull'
  if (snapshot.decision.state === 'reduce' || snapshot.decision.state === 'sell') return 'bear'
  return 'warning'
}

function ConditionItem({ label, text, state }: { label: string; text: string; state: string }) {
  const tone: StockSummaryTone = state === 'met' ? 'bull' : state === 'failed' ? 'bear' : state === 'unavailable' ? 'warning' : 'neutral'
  const stateLabel = state === 'met' ? '满足' : state === 'failed' ? '不满足' : state === 'unavailable' ? '数据不足' : '等待'
  return <div className="flex items-start gap-1.5 border-b border-border/40 py-1.5 last:border-0"><span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${TONE_CLASSES[tone].dot}`} /><span className="min-w-0 flex-1"><span className="flex items-center justify-between gap-2"><span className="truncate text-[10px] text-secondary">{label}</span><span className={`shrink-0 text-[9px] ${TONE_CLASSES[tone].text}`}>{stateLabel}</span></span><span className="mt-0.5 block break-words text-[9px] text-muted">{text}</span></span></div>
}

function ZoneButton({
  zone,
  label,
  assetType,
  onClick,
}: {
  zone: PriceZone
  label: string
  assetType?: string
  onClick?: () => void
}) {
  return <button type="button" onClick={onClick} className="min-w-0 rounded border border-border/70 bg-base/30 px-2 py-1.5 text-left transition-colors hover:border-accent/60 hover:bg-elevated"><span className="block text-[9px] text-muted">{label}</span><span className="mt-0.5 block truncate font-mono text-[10px] tabular-nums text-secondary">{fmtAssetPrice(zone.low, assetType)} ~ {fmtAssetPrice(zone.high, assetType)}</span><span className="mt-0.5 block truncate text-[8px] text-muted">距离 {fmtPct(zone.distancePct)}</span></button>
}

export function StockSummaryPanel({ snapshot, onSelectZone, onSelectSignal, onFocusSection, onLatest, isLoading = false, error, onRetry }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const tone = TONE_CLASSES[snapshot.observation.tone]
  const actionTone = TONE_CLASSES[decisionTone(snapshot)]
  const period = snapshot.context.period
  const activeSignalId = snapshot.structure.activeCandidate?.id
  const dimensions: Array<{ label: string; value: number | null; status: string; focus: FocusSection }> = [
    { label: '趋势', value: snapshot.technical.trend, status: snapshot.technical.dimensionLabels.trend, focus: 'technical' },
    { label: '动能', value: snapshot.technical.momentum, status: snapshot.technical.dimensionLabels.momentum, focus: 'technical' },
    { label: '量价', value: snapshot.technical.volumePrice, status: snapshot.technical.dimensionLabels.volumePrice, focus: 'technical' },
    { label: '结构', value: null, status: snapshot.structure.stateLabel, focus: 'structure' },
  ]
  const selectEvidence = (item: StockSummaryEvidence) => {
    if (!item.targetId) return
    if (item.targetId === snapshot.levels.support?.id) onSelectZone?.(snapshot.levels.support)
    else if (item.targetId === snapshot.levels.resistance?.id) onSelectZone?.(snapshot.levels.resistance)
    else if (item.targetId === snapshot.levels.current?.id) onSelectZone?.(snapshot.levels.current)
    else onSelectSignal?.(item.targetId)
  }

  const boundary = snapshot.structure.activeCandidate?.boundary ?? snapshot.risk.invalidation
  const boundaryLabel = snapshot.structure.activeCandidate?.kind.endsWith('_sell')
    ? '卖侧失效 / 风险缓解位'
    : '买侧失效位'
  const formatBoundary = boundary == null ? '—' : fmtAssetPrice(boundary, snapshot.context.assetType)
  const operationZoneClick = (zone: PriceZone | null) => {
    if (!zone) return
    onFocusSection?.('levels')
    onSelectZone?.(zone)
  }

  return <section className="border-b border-border/70">
    <div className={`flex items-start justify-between gap-2 px-2.5 py-2 ${collapsed ? '' : 'border-b border-border/70'}`}>
      <div className="min-w-0 flex-1">
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
            <span className="text-xs font-medium text-foreground">综合研判</span>
            <span className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold ${tone.badge}`}>{snapshot.observation.label}</span>
            <span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[9px] text-secondary">{PERIOD_LABELS[period]}</span>
          </span>
          {!collapsed && <span className="mt-0.5 block truncate text-[9px] text-muted">{snapshot.context.historical ? '历史观察 · ' : ''}截至 {shortDate(snapshot.context.asOf, period)} · {snapshot.quality.label}{snapshot.quality.stale ? ' · 过期快照' : ''}</span>}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!collapsed && snapshot.context.historical && onLatest && <button type="button" onClick={onLatest} className="text-[9px] text-accent hover:text-foreground">回到最新</button>}
        {!collapsed && <span className={`font-mono text-sm font-semibold tabular-nums ${snapshot.technical.score == null ? 'text-muted' : TONE_CLASSES[snapshot.technical.directionTone].text}`}>{scoreText(snapshot.technical.score)}<span className="ml-0.5 text-[9px] font-normal text-muted">/100</span></span>}
        <button type="button" onClick={() => setCollapsed(value => !value)} className="rounded-btn p-1 text-muted transition-colors hover:bg-elevated hover:text-foreground" aria-expanded={!collapsed} aria-label={collapsed ? '展开综合研判' : '收起综合研判'} title={collapsed ? '展开综合研判' : '收起综合研判'}><ChevronDown className={`h-3.5 w-3.5 transition-transform ${collapsed ? '-rotate-90' : ''}`} /></button>
      </div>
    </div>
    {!collapsed && <div className="grid gap-2 p-2">
      {isLoading && snapshot.quality.status === 'blocked' && <div className="rounded border border-border bg-elevated/40 px-2 py-1.5 text-[9px] text-muted">正在加载当前周期综合分析…</div>}
      {error && snapshot.quality.status === 'blocked' && <div className="flex items-center justify-between gap-2 rounded border border-bear/30 bg-bear/5 px-2 py-1.5 text-[9px] text-bear"><span>当前周期行情加载失败，摘要暂不可用。</span>{onRetry && <button type="button" onClick={onRetry} className="rounded-btn bg-elevated px-2 py-1 text-[9px] text-secondary hover:text-foreground">重试</button>}</div>}
      {snapshot.action ? <ActionSignalCard action={snapshot.action} comparison={snapshot.actionComparison} assetType={snapshot.context.assetType} /> : <div className={`rounded-card border p-2.5 shadow-sm ${actionTone.badge}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold ${actionTone.badge}`}>当前行动：{DECISION_LABELS[snapshot.decision.state]}</span>
              <span className="text-[9px] text-muted">规则状态 {snapshot.decision.inputState === 'ready' ? '可用' : snapshot.decision.inputState === 'provisional' ? '待确认' : '数据不足'}</span>
            </div>
            <div className={`mt-1 text-xs font-semibold ${actionTone.text}`}>{snapshot.decision.reason}</div>
          </div>
          <span className={`shrink-0 font-mono text-[10px] ${actionTone.text}`}>{snapshot.technical.score == null ? '技术分 —' : `技术分 ${scoreText(snapshot.technical.score)}`}</span>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          <div className="rounded border border-border/60 bg-base/30 px-2 py-1.5">
            <div className="text-[9px] text-muted">未持有</div>
            <div className={`mt-0.5 text-sm font-semibold ${actionTone.text}`}>{snapshot.decision.flatAction}</div>
            <div className="mt-0.5 text-[9px] text-muted">空仓视角</div>
          </div>
          <div className="rounded border border-border/60 bg-base/30 px-2 py-1.5">
            <div className="text-[9px] text-muted">已持有</div>
            <div className={`mt-0.5 text-sm font-semibold ${actionTone.text}`}>{snapshot.decision.holdingAction}</div>
            <div className="mt-0.5 text-[9px] text-muted">持仓视角</div>
          </div>
        </div>
      </div>}
      {!snapshot.action && <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-card border border-border bg-surface/50 p-2">
            <div className="mb-1 text-[10px] font-medium text-foreground">转强 / 升级需要</div>
            {snapshot.decision.upgradeConditions.length > 0
              ? snapshot.decision.upgradeConditions.slice(0, 3).map(item => <ConditionItem key={item.id} label={item.label} text={item.text} state={item.state} />)
              : <div className="text-[9px] text-muted">当前没有待补条件</div>}
          </div>
          <div className="rounded-card border border-border bg-surface/50 p-2">
            <div className="mb-1 text-[10px] font-medium text-foreground">风险 / 失效观察</div>
            {snapshot.decision.riskConditions.length > 0
              ? snapshot.decision.riskConditions.slice(0, 3).map(item => <ConditionItem key={item.id} label={item.label} text={item.text} state={item.state} />)
              : <div className="text-[9px] text-muted">暂无可追溯风险条件</div>}
          </div>
        </div>}
      <div className="rounded-card border border-border bg-surface/50 p-2">
        <div className="mb-1 text-[10px] font-medium text-foreground">操作参考（观察区，不是自动触发）</div>
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          <div className="rounded border border-border/70 bg-base/30 px-2 py-1.5">
            <span className="block text-[9px] text-muted">当前价</span>
            <span className="mt-0.5 block truncate font-mono text-[10px] tabular-nums text-secondary">{fmtAssetPrice(snapshot.risk.referencePrice, snapshot.context.assetType)}</span>
          </div>
          {snapshot.levels.support && <ZoneButton zone={snapshot.levels.support} label="最近支撑" assetType={snapshot.context.assetType} onClick={() => operationZoneClick(snapshot.levels.support)} />}
          {snapshot.levels.resistance && <ZoneButton zone={snapshot.levels.resistance} label="最近压力" assetType={snapshot.context.assetType} onClick={() => operationZoneClick(snapshot.levels.resistance)} />}
          {boundary != null && <div className="rounded border border-border/70 bg-base/30 px-2 py-1.5"><span className="block text-[9px] text-muted">{boundaryLabel}</span><span className="mt-0.5 block truncate font-mono text-[10px] tabular-nums text-secondary">{formatBoundary}</span></div>}
        </div>
      </div>
      <div className="rounded-card border border-border bg-surface/70 p-2.5 shadow-sm">
        <div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="text-sm font-medium text-foreground">{snapshot.headline}</div><div className="mt-1 text-[10px] leading-relaxed text-secondary">{snapshot.summary}</div></div><span className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] ${TONE_CLASSES[snapshot.quality.status === 'ready' ? 'bull' : snapshot.quality.status === 'limited' ? 'warning' : 'neutral'].badge}`}>{snapshot.quality.label}</span></div>
        <div className="mt-2 grid grid-cols-3 gap-1.5 border-t border-border/50 pt-2 sm:grid-cols-4">
          {dimensions.map(dimension => <button key={dimension.label} type="button" onClick={() => onFocusSection?.(dimension.focus)} className="min-w-0 rounded border border-border/50 bg-base/30 px-1.5 py-1 text-left transition-colors hover:bg-elevated"><span className="block text-[9px] text-muted">{dimension.label}</span><span className={`mt-0.5 block truncate font-mono text-[10px] tabular-nums ${TONE_CLASSES[scoreTone(dimension.value)].text}`}>{dimension.value == null ? dimension.status : `${scoreText(dimension.value)} · ${dimension.status}`}</span></button>)}
        </div>
        {snapshot.conflicts.length > 0 && <div className="mt-2 rounded border border-warning/30 bg-warning/5 px-2 py-1.5 text-[9px] text-warning"><div className="flex items-center gap-1"><AlertTriangle className="h-3 w-3 shrink-0" /><span className="font-medium">主要分歧</span></div><div className="mt-0.5 leading-relaxed">{snapshot.conflicts[0].text}</div></div>}
        <div className="mt-2 flex items-center justify-between gap-2"><span className={`inline-flex items-center gap-1 text-[9px] ${tone.text}`}><Target className="h-3 w-3" />{activeSignalId ? '候选条件未全部确认' : snapshot.observation.label}</span><button type="button" onClick={() => setDetailsOpen(value => !value)} className="inline-flex items-center gap-1 rounded-btn bg-elevated px-2 py-1 text-[9px] text-secondary transition-colors hover:text-foreground">{detailsOpen ? '收起详细依据' : '查看详细依据'}<ChevronDown className={`h-3 w-3 transition-transform ${detailsOpen ? 'rotate-180' : ''}`} /></button></div>
      </div>
      {detailsOpen && <div className="grid gap-2">
        {(snapshot.supportingEvidence.length > 0 || snapshot.opposingEvidence.length > 0) && <div className="grid gap-2 sm:grid-cols-2"><div className="rounded-card border border-border bg-surface/50 p-2"><div className="mb-1 text-[10px] font-medium text-bull">支持依据</div>{snapshot.supportingEvidence.length > 0 ? snapshot.supportingEvidence.map(item => <EvidenceRow key={item.id} item={item} onClick={item.targetId ? () => selectEvidence(item) : undefined} />) : <div className="text-[9px] text-muted">暂无可用支持依据</div>}</div><div className="rounded-card border border-border bg-surface/50 p-2"><div className="mb-1 text-[10px] font-medium text-bear">限制与反向依据</div>{snapshot.opposingEvidence.length > 0 ? snapshot.opposingEvidence.map(item => <EvidenceRow key={item.id} item={item} onClick={item.targetId ? () => selectEvidence(item) : undefined} />) : <div className="text-[9px] text-muted">暂无明显反向依据</div>}</div></div>}
        {snapshot.conditions.length > 0 && <div className="rounded-card border border-border bg-surface/50 p-2"><button type="button" onClick={() => onFocusSection?.('structure')} className="mb-1 flex items-center gap-1 text-[10px] font-medium text-foreground hover:text-accent">候选条件<ChevronRight className="h-3 w-3" /></button>{snapshot.conditions.map(item => <ConditionItem key={item.id} label={item.label} text={item.text} state={item.state} />)}</div>}
        {snapshot.invalidation.length > 0 && <div className="rounded-card border border-bear/30 bg-bear/5 p-2"><div className="mb-1 flex items-center gap-1 text-[10px] font-medium text-bear"><CircleAlert className="h-3 w-3" />失效条件</div>{snapshot.invalidation.map(item => <ConditionItem key={item.id} label={item.label} text={item.text} state={item.state} />)}</div>}
        <div className="grid gap-2 sm:grid-cols-3"><div className="rounded-card border border-border bg-surface/50 p-2"><div className="mb-1 text-[10px] font-medium text-foreground">关键价位</div><div className="grid gap-1.5">{snapshot.levels.support && <ZoneButton zone={snapshot.levels.support} label="最近支撑" assetType={snapshot.context.assetType} onClick={() => { onFocusSection?.('levels'); if (snapshot.levels.support) onSelectZone?.(snapshot.levels.support) }} />}{snapshot.levels.resistance && <ZoneButton zone={snapshot.levels.resistance} label="最近压力" assetType={snapshot.context.assetType} onClick={() => { onFocusSection?.('levels'); if (snapshot.levels.resistance) onSelectZone?.(snapshot.levels.resistance) }} />}{!snapshot.levels.support && !snapshot.levels.resistance && <div className="text-[9px] text-muted">暂无可追溯区间</div>}</div></div><div className="rounded-card border border-border bg-surface/50 p-2"><div className="mb-1 text-[10px] font-medium text-foreground">结构空间</div><div className="text-[9px] leading-relaxed text-muted">{snapshot.risk.status === 'calculable' && snapshot.risk.riskReward1 != null ? <><span>目标一 / 风险</span><span className="ml-1 font-mono text-accent">1 : {snapshot.risk.riskReward1.toFixed(2)}</span></> : snapshot.risk.reason ?? '当前没有可用的活动候选'}</div><button type="button" onClick={() => onFocusSection?.('risk')} className="mt-1 text-[9px] text-accent hover:text-foreground">查看风险依据</button></div><div className="rounded-card border border-border bg-surface/50 p-2"><div className="mb-1 text-[10px] font-medium text-foreground">数据质量</div><div className="text-[9px] leading-relaxed text-muted">{snapshot.quality.reasons.length > 0 ? snapshot.quality.reasons.slice(0, 2).join('；') : '当前观察时点输入完整'}</div><div className="mt-1 text-[8px] text-muted">技术置信度 {snapshot.technical.confidence == null ? '—' : `${Math.round(snapshot.technical.confidence)}%`} · 覆盖率 {snapshot.technical.coverage == null ? '—' : `${Math.round(snapshot.technical.coverage)}%`}</div></div></div>
        {snapshot.limitations.length > 0 && <div className="rounded border border-border/60 bg-elevated/30 px-2 py-1.5 text-[9px] text-muted"><div className="mb-0.5 flex items-center gap-1 text-secondary"><Info className="h-3 w-3" />分析限制</div>{snapshot.limitations.slice(0, 3).map((item, index) => <div key={`${item}-${index}`} className="leading-relaxed">· {item}</div>)}</div>}
        <div className="flex items-center gap-1 text-[8px] text-muted"><Database className="h-3 w-3" />规则版本 {snapshot.versions.summary} · {snapshot.context.priceBasis} · {snapshot.structure.definitionMode}</div>
      </div>}
    </div>}
  </section>
}
