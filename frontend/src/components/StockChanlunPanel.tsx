import { ChevronDown } from 'lucide-react'
import type { KlinePeriod } from '@/lib/api'
import type {
  ChanlunAnalysis,
  ChanlunCenterState,
  ChanlunSignalKind,
  ChanlunSignalStatus,
} from '@/lib/chanlun'
import { fmtAssetPrice, fmtPct } from '@/lib/format'

type Tone = 'bull' | 'bear' | 'neutral'

interface CardMetric {
  label: string
  value: string
  tone?: Tone
}

interface ChanlunCardModel {
  title: string
  status: string
  tone: Tone
  metrics: CardMetric[]
  detail: string
}

const PERIOD_LABELS: Record<KlinePeriod, string> = {
  '30m': '30F',
  '1d': '日K',
  '1w': '周K',
  '1mo': '月K',
}

const TONE_CLASSES: Record<Tone, { badge: string; value: string; dot: string }> = {
  bull: {
    badge: 'border-bull/30 bg-bull/10 text-bull',
    value: 'text-bull',
    dot: 'bg-bull',
  },
  bear: {
    badge: 'border-bear/30 bg-bear/10 text-bear',
    value: 'text-bear',
    dot: 'bg-bear',
  },
  neutral: {
    badge: 'border-border bg-elevated text-secondary',
    value: 'text-secondary',
    dot: 'bg-muted',
  },
}

const CENTER_STATUS: Record<ChanlunCenterState, string> = {
  oscillating: '中枢震荡',
  extension: '中枢延伸',
  broken_up: '向上离开',
  broken_down: '向下离开',
}

function shortDate(value: string | null | undefined, period: KlinePeriod): string {
  if (!value) return '—'
  return period === '30m' ? value.slice(5) : value.slice(0, 10)
}

function dateRange(start: string | null | undefined, end: string | null | undefined, period: KlinePeriod): string {
  if (!start || !end) return '—'
  return `${shortDate(start, period)} → ${shortDate(end, period)}`
}

function directionLabel(direction: 'up' | 'down' | undefined): string {
  return direction === 'up' ? '向上' : direction === 'down' ? '向下' : '—'
}

function directionTone(direction: 'up' | 'down' | undefined): Tone {
  return direction === 'up' ? 'bull' : direction === 'down' ? 'bear' : 'neutral'
}

function signalName(kind: ChanlunSignalKind | undefined): string {
  return kind === 'third_buy' ? '三买' : kind === 'third_sell' ? '三卖' : '三类'
}

function signalStatus(kind: ChanlunSignalKind | undefined, status: ChanlunSignalStatus | undefined): string {
  const name = signalName(kind)
  if (status === 'waiting_pullback') return `等待${name}回抽`
  if (status === 'candidate') return `${name}候选`
  if (status === 'invalidated') return `${name}候选失效`
  if (status === 'rejected') return '回抽进入中枢'
  return '等待离开'
}

function buildCards(
  analysis: ChanlunAnalysis,
  period: KlinePeriod,
  assetType?: 'stock' | 'etf' | 'index',
): ChanlunCardModel[] {
  const latestFractal = analysis.latestFractal
  const confirmedStroke = analysis.latestConfirmedStroke
  const formingStroke = analysis.formingStroke
  const center = analysis.latestCenter
  const signal = analysis.latestSignal
  const issue = analysis.issues[0]

  const structureCard: ChanlunCardModel = {
    title: '分型与笔',
    status: analysis.status === 'invalid_data'
      ? '数据异常'
      : latestFractal ? `${latestFractal.type === 'top' ? '顶' : '底'}分型` : '样本不足',
    tone: latestFractal ? (latestFractal.type === 'bottom' ? 'bull' : 'bear') : 'neutral',
    metrics: [
      {
        label: '最新分型',
        value: latestFractal ? `${latestFractal.type === 'top' ? '顶' : '底'} · ${shortDate(latestFractal.date, period)}` : '—',
      },
      {
        label: '已确认笔',
        value: confirmedStroke ? `${directionLabel(confirmedStroke.direction)} · ${shortDate(confirmedStroke.endDate, period)}` : '—',
        tone: directionTone(confirmedStroke?.direction),
      },
      {
        label: '形成中笔',
        value: formingStroke ? `${directionLabel(formingStroke.direction)} · ${shortDate(formingStroke.endDate, period)}` : '—',
        tone: directionTone(formingStroke?.direction),
      },
      {
        label: '最近笔涨跌',
        value: fmtPct((formingStroke ?? confirmedStroke)?.changePct),
        tone: directionTone((formingStroke ?? confirmedStroke)?.direction),
      },
    ],
    detail: issue ?? (latestFractal
      ? `分型于 ${shortDate(latestFractal.confirmedAt, period)} 可确认；形成中笔等待下一条反向笔`
      : '严格三K分型尚未形成'),
  }

  const centerCard: ChanlunCardModel = {
    title: '近似中枢',
    status: center ? CENTER_STATUS[center.state] : '尚未形成',
    tone: center?.state === 'broken_up' ? 'bull' : center?.state === 'broken_down' ? 'bear' : 'neutral',
    metrics: [
      { label: '上沿 ZG', value: fmtAssetPrice(center?.zg, assetType) },
      { label: '下沿 ZD', value: fmtAssetPrice(center?.zd, assetType) },
      { label: '结构区间', value: center ? dateRange(center.startDate, center.endDate, period) : '—' },
      { label: '组成笔数', value: center ? `${center.componentCount} 笔` : '—' },
    ],
    detail: center
      ? `由连续已确认笔重叠近似，${shortDate(center.formedAt, period)} 起可确认`
      : '需要至少三条已确认笔形成共同价格区间',
  }

  const aboveDistance = center && analysis.currentPrice != null && center.zg > 0
    ? analysis.currentPrice / center.zg - 1
    : null
  const belowDistance = center && analysis.currentPrice != null && center.zd > 0
    ? analysis.currentPrice / center.zd - 1
    : null
  const positionLabel = analysis.pricePosition === 'above'
    ? '中枢上方'
    : analysis.pricePosition === 'below' ? '中枢下方' : analysis.pricePosition === 'inside' ? '中枢内部' : '等待中枢'
  const positionTone: Tone = analysis.pricePosition === 'above' ? 'bull' : analysis.pricePosition === 'below' ? 'bear' : 'neutral'
  const positionCard: ChanlunCardModel = {
    title: '价格位置',
    status: positionLabel,
    tone: positionTone,
    metrics: [
      { label: '当前价格', value: fmtAssetPrice(analysis.currentPrice, assetType), tone: positionTone },
      { label: '距上沿', value: fmtPct(aboveDistance), tone: directionTone(aboveDistance == null ? undefined : aboveDistance >= 0 ? 'up' : 'down') },
      { label: '距下沿', value: fmtPct(belowDistance), tone: directionTone(belowDistance == null ? undefined : belowDistance >= 0 ? 'up' : 'down') },
      { label: '分析窗口', value: `${analysis.window.bars} K / ${analysis.window.mergedBars} 合并` },
    ],
    detail: analysis.window.start && analysis.window.end
      ? `${dateRange(analysis.window.start, analysis.window.end, period)}，仅使用该时点及之前数据`
      : '暂无当前周期 K 线',
  }

  const signalTone: Tone = signal?.status === 'candidate'
    ? signal.kind === 'third_buy' ? 'bull' : 'bear'
    : 'neutral'
  const signalCard: ChanlunCardModel = {
    title: '三类候选',
    status: signal ? signalStatus(signal.kind, signal.status) : center ? '等待离开' : '等待中枢',
    tone: signalTone,
    metrics: [
      { label: '结构端点', value: signal ? shortDate(signal.structureDate, period) : '—' },
      { label: '可确认时间', value: signal ? shortDate(signal.availableDate, period) : '—' },
      { label: '失效边界', value: fmtAssetPrice(signal?.boundary, assetType) },
      { label: '低级别确认', value: signal ? '缺失' : '—' },
    ],
    detail: signal?.status === 'rejected'
      ? '回抽触及或重新进入中枢，未形成三类候选'
      : signal?.status === 'invalidated'
        ? `候选于 ${shortDate(signal.invalidatedAt, period)} 触及中枢边界后失效`
        : signal
          ? '这是结构近似候选，缺少低级别递归确认，不是严格缠论买卖点'
          : '等待中枢离开及其后的反向笔确认',
  }

  return [structureCard, centerCard, positionCard, signalCard]
}

export interface StockChanlunPanelProps {
  analysis: ChanlunAnalysis
  period: KlinePeriod
  assetType?: 'stock' | 'etf' | 'index'
  collapsed?: boolean
  onToggleCollapsed?: () => void
  isLoading?: boolean
  error?: Error | null
}

export function StockChanlunPanel({
  analysis,
  period,
  assetType,
  collapsed = false,
  onToggleCollapsed,
  isLoading = false,
  error,
}: StockChanlunPanelProps) {
  const cards = buildCards(analysis, period, assetType)
  const headerContent = (
    <span className="flex min-w-0 items-start gap-1.5">
      {onToggleCollapsed && (
        <ChevronDown className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-muted transition-transform ${collapsed ? '-rotate-90' : ''}`} />
      )}
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-foreground">缠论</span>
          <span className="rounded bg-[#8B5CF6]/10 px-1.5 py-0.5 text-[9px] text-[#A78BFA]">结构近似</span>
          <span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[9px] text-secondary">{PERIOD_LABELS[period]}</span>
        </span>
        {!collapsed && (
          <span className="mt-0.5 block truncate text-[10px] text-muted" title={analysis.approximationLoss}>
            {analysis.window.start && analysis.window.end
              ? `分析 ${dateRange(analysis.window.start, analysis.window.end, period)}`
              : '等待当前周期行情'}
          </span>
        )}
      </span>
    </span>
  )
  const headerClassName = `flex w-full items-start px-2.5 py-2 text-left transition-colors ${collapsed ? 'border-b border-border/70' : ''} ${onToggleCollapsed ? 'hover:bg-elevated/40' : ''}`
  return (
    <section>
      {onToggleCollapsed ? (
        <button
          type="button"
          onClick={onToggleCollapsed}
          className={headerClassName}
          title={collapsed ? '展开缠论' : '收起缠论'}
          aria-label={collapsed ? '展开缠论' : '收起缠论'}
          aria-expanded={!collapsed}
        >
          {headerContent}
        </button>
      ) : (
        <div className={headerClassName}>{headerContent}</div>
      )}

      {!collapsed && (
        isLoading && analysis.window.bars === 0 ? (
          <div className="grid gap-2 p-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="h-[116px] animate-pulse rounded-card border border-border bg-surface/60" />
            ))}
          </div>
        ) : error && analysis.window.bars === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-muted">缠论结构暂时不可用，周期行情加载失败。</div>
        ) : (
          <div className="grid gap-2 p-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            {cards.map(card => <ChanlunCard key={card.title} card={card} />)}
          </div>
        )
      )}
    </section>
  )
}

function ChanlunCard({ card }: { card: ChanlunCardModel }) {
  const tone = TONE_CLASSES[card.tone]
  return (
    <div className="rounded-card border border-border bg-surface/70 p-2.5 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-medium text-foreground">{card.title}</div>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] ${tone.badge}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
          {card.status}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1.5">
        {card.metrics.map(metric => (
          <div key={metric.label} className="min-w-0">
            <div className="text-[9px] text-muted">{metric.label}</div>
            <div className={`truncate font-mono text-[10px] tabular-nums ${metric.tone ? TONE_CLASSES[metric.tone].value : 'text-secondary'}`} title={metric.value}>
              {metric.value}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 line-clamp-2 border-t border-border/50 pt-1.5 text-[9px] leading-relaxed text-muted" title={card.detail}>{card.detail}</div>
    </div>
  )
}
