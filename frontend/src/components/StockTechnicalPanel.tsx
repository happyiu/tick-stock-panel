import { useMemo, useState } from 'react'
import {
  Check,
  ChevronLeft,
  GripVertical,
  Settings2,
} from 'lucide-react'
import type { DragEndEvent } from '@dnd-kit/core'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { KlinePeriod, KlineRow } from '@/lib/api'
import {
  storage,
  type StockPreviewTechnicalCardsConfig,
  type StockTechnicalCardKey,
} from '@/lib/storage'
import { fmtAssetPrice, fmtPct, fmtVolume } from '@/lib/format'

type Tone = 'bull' | 'bear' | 'neutral'

interface TechnicalMetric {
  label: string
  value: string
  tone?: Tone
}

interface TechnicalCardModel {
  key: StockTechnicalCardKey
  label: string
  description: string
  status: string
  tone: Tone
  metrics: TechnicalMetric[]
  detail: string
}

interface TechnicalCardDef {
  key: StockTechnicalCardKey
  label: string
  description: string
}

const TECHNICAL_CARD_DEFS: TechnicalCardDef[] = [
  { key: 'ma', label: '均线趋势', description: 'MA5/10/20/60 趋势排列' },
  { key: 'volume', label: '量能', description: '成交量与量比变化' },
  { key: 'macd', label: 'MACD', description: '趋势动能与交叉状态' },
  { key: 'rsi', label: 'RSI', description: '相对强弱与超买超卖' },
  { key: 'kdj', label: 'KDJ', description: '摆动指标与交叉状态' },
  { key: 'boll', label: 'BOLL', description: '价格通道与带宽' },
  { key: 'momentum', label: '动量', description: '5/20/60 周期收益方向' },
  { key: 'atr', label: 'ATR / 波动', description: '真实波幅与波动状态' },
]

const DEFAULT_ORDER = TECHNICAL_CARD_DEFS.map(def => def.key)
const PERIOD_LABELS: Record<KlinePeriod, string> = {
  '30m': '30F',
  '1d': '日K',
  '1w': '周K',
  '1mo': '月K',
}

const EMPTY_METRIC_LABELS: Record<StockTechnicalCardKey, string[]> = {
  ma: ['MA5', 'MA20', 'MA60', '距MA20'],
  volume: ['量比', 'VOL5', 'VOL10', '本周期'],
  macd: ['DIF', 'DEA', 'MACD', '零轴'],
  rsi: ['RSI6', 'RSI14', 'RSI24', '方向'],
  kdj: ['K', 'D', 'J', '交叉'],
  boll: ['上轨', '中轨', '下轨', '带宽'],
  momentum: ['5周期', '20周期', '60周期', '方向'],
  atr: ['ATR14', 'ATR/价', '相对中位', '状态'],
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

interface TechnicalBar {
  key: string
  row: KlineRow
  close: number
}

function numberValue(value: unknown): number | null {
  if (value == null || value === '') return null
  const result = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(result) ? result : null
}

function normalizeBarKey(value: unknown, period: KlinePeriod): string {
  const raw = String(value ?? '')
  if (!raw) return ''
  return period === '30m'
    ? raw.replace('T', ' ').slice(0, 16)
    : raw.slice(0, 10)
}

function normalizeBars(rows: KlineRow[], period: KlinePeriod): TechnicalBar[] {
  return rows
    .map(row => ({ key: normalizeBarKey(row.date, period), row, close: numberValue(row.close) }))
    .filter((bar): bar is TechnicalBar => !!bar.key && bar.close != null)
}

function field(bar: TechnicalBar | undefined, key: keyof KlineRow): number | null {
  return bar ? numberValue(bar.row[key]) : null
}

function fmtIndicator(value: number | null, digits = 2): string {
  return value == null ? '—' : value.toFixed(digits)
}

function fmtUnsignedPct(value: number | null, digits = 2): string {
  return value == null ? '—' : `${(value * 100).toFixed(digits)}%`
}

function fmtRatio(value: number | null): string {
  return value == null ? '—' : `${value.toFixed(2)}x`
}

function toneForChange(value: number | null): Tone {
  if (value == null || Math.abs(value) < 1e-12) return 'neutral'
  return value > 0 ? 'bull' : 'bear'
}

function averageVolumeAt(bars: TechnicalBar[], index: number, window: number): number | null {
  if (index < window - 1) return null
  const values = bars.slice(index - window + 1, index + 1).map(bar => field(bar, 'volume'))
  const numericValues = values.filter((value): value is number => value != null)
  if (numericValues.length !== window) return null
  return numericValues.reduce((sum, value) => sum + value, 0) / window
}

function previousVolumeRatioAt(bars: TechnicalBar[], index: number, window: number): number | null {
  if (index < window) return null
  const current = field(bars[index], 'volume')
  const previous = bars.slice(index - window, index).map(bar => field(bar, 'volume'))
  const numericPrevious = previous.filter((value): value is number => value != null)
  if (current == null || numericPrevious.length !== window) return null
  const average = numericPrevious.reduce((sum, value) => sum + value, 0) / window
  return average > 0 ? current / average : null
}

function momentumAt(bars: TechnicalBar[], index: number, window: number): number | null {
  if (index < window) return null
  const current = bars[index]?.close
  const base = bars[index - window]?.close
  if (current == null || base == null || base <= 0) return null
  return current / base - 1
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function crossLabel(
  currentA: number | null,
  currentB: number | null,
  previousA: number | null,
  previousB: number | null,
  positive: string,
  negative: string,
): string | null {
  if (currentA == null || currentB == null || previousA == null || previousB == null) return null
  if (previousA <= previousB && currentA > currentB) return positive
  if (previousA >= previousB && currentA < currentB) return negative
  return null
}

function emptyCard(def: TechnicalCardDef): TechnicalCardModel {
  return {
    ...def,
    status: '样本不足',
    tone: 'neutral',
    metrics: EMPTY_METRIC_LABELS[def.key].map(label => ({ label, value: '—' })),
    detail: '当前周期暂未获得足够数据，指标不会给出推测结论。',
  }
}

function buildTechnicalCard(
  def: TechnicalCardDef,
  bars: TechnicalBar[],
  index: number,
  assetType?: 'stock' | 'etf' | 'index',
): TechnicalCardModel {
  const current = bars[index]
  if (!current) return emptyCard(def)
  const previous = bars[index - 1]
  const get = (key: keyof KlineRow) => field(current, key)
  const getPrevious = (key: keyof KlineRow) => field(previous, key)
  const price = current.close

  switch (def.key) {
    case 'ma': {
      const ma5 = get('ma5')
      const ma10 = get('ma10')
      const ma20 = get('ma20')
      const ma60 = get('ma60')
      const deviation = ma20 != null && ma20 > 0 ? price / ma20 - 1 : null
      const cross = crossLabel(ma5, ma20, getPrevious('ma5'), getPrevious('ma20'), 'MA5金叉', 'MA5死叉')
      const slope = ma5 != null && getPrevious('ma5') != null
        ? ma5 > (getPrevious('ma5') ?? ma5) ? 'MA5上行' : ma5 < (getPrevious('ma5') ?? ma5) ? 'MA5下行' : 'MA5走平'
        : null
      const complete = [ma5, ma10, ma20, ma60].every(value => value != null)
      const bullish = complete && ma5! > ma10! && ma10! > ma20! && ma20! > ma60!
      const bearish = complete && ma5! < ma10! && ma10! < ma20! && ma20! < ma60!
      return {
        ...def,
        status: !complete ? '样本不足' : bullish ? '多头排列' : bearish ? '空头排列' : '均线纠缠',
        tone: !complete ? 'neutral' : bullish ? 'bull' : bearish ? 'bear' : 'neutral',
        metrics: [
          { label: 'MA5', value: fmtAssetPrice(ma5, assetType) },
          { label: 'MA20', value: fmtAssetPrice(ma20, assetType) },
          { label: 'MA60', value: fmtAssetPrice(ma60, assetType) },
          { label: '距MA20', value: fmtPct(deviation), tone: toneForChange(deviation) },
        ],
        detail: !complete ? '需要 MA5/10/20/60 完整样本' : [cross, slope].filter(Boolean).join(' · ') || '近期未见 MA5/MA20 交叉',
      }
    }

    case 'volume': {
      const vol5 = get('vol_ma5') ?? averageVolumeAt(bars, index, 5)
      const vol10 = get('vol_ma10') ?? averageVolumeAt(bars, index, 10)
      const ratio = get('vol_ratio_5d') ?? previousVolumeRatioAt(bars, index, 5)
      const previousClose = previous?.close ?? null
      const priceChange = get('change_pct') ?? (previousClose && previousClose > 0 ? price / previousClose - 1 : null)
      let status = '样本不足'
      let tone: Tone = 'neutral'
      if (ratio != null) {
        status = ratio >= 2 ? '明显放量' : ratio >= 1.2 ? '温和放量' : ratio <= 0.8 ? '缩量' : '平量'
        tone = ratio >= 1.2 || ratio <= 0.8 ? toneForChange(priceChange) : 'neutral'
      }
      return {
        ...def,
        status,
        tone,
        metrics: [
          { label: '量比', value: fmtRatio(ratio), tone },
          { label: 'VOL5', value: fmtVolume(vol5) },
          { label: 'VOL10', value: fmtVolume(vol10) },
          { label: '本周期', value: fmtPct(priceChange), tone: toneForChange(priceChange) },
        ],
        detail: ratio == null ? '需要当前量及前 5 个周期成交量' : priceChange == null ? '量能已计算，暂缺价量方向' : priceChange >= 0 ? '价格上涨与成交量同步' : '价格下跌伴随成交量变化',
      }
    }

    case 'macd': {
      const dif = get('macd_dif')
      const dea = get('macd_dea')
      const hist = get('macd_hist') ?? (dif != null && dea != null ? (dif - dea) * 2 : null)
      const previousHist = getPrevious('macd_hist')
      const cross = crossLabel(dif, dea, getPrevious('macd_dif'), getPrevious('macd_dea'), '金叉', '死叉')
      const complete = dif != null && dea != null && hist != null
      const zeroAxis = dif != null && dea != null
        ? dif >= 0 && dea >= 0 ? '零轴上方' : dif < 0 && dea < 0 ? '零轴下方' : '跨越零轴'
        : '—'
      const histogramState = hist != null && previousHist != null
        ? Math.abs(hist) > Math.abs(previousHist) ? `${hist >= 0 ? '红' : '绿'}柱放大` : `${hist >= 0 ? '红' : '绿'}柱收敛`
        : null
      const tone: Tone = !complete ? 'neutral' : hist >= 0 && dif! >= dea! ? 'bull' : 'bear'
      return {
        ...def,
        status: !complete ? '样本不足' : cross ?? (dif! >= dea! ? 'DIF在DEA上方' : 'DIF在DEA下方'),
        tone,
        metrics: [
          { label: 'DIF', value: fmtIndicator(dif, 3) },
          { label: 'DEA', value: fmtIndicator(dea, 3) },
          { label: 'MACD', value: fmtIndicator(hist, 3), tone },
          { label: '零轴', value: zeroAxis },
        ],
        detail: !complete ? '需要 DIF、DEA 和柱体完整样本' : [zeroAxis, histogramState].filter(Boolean).join(' · ') || '柱体方向暂未变化',
      }
    }

    case 'rsi': {
      const rsi6 = get('rsi_6')
      const rsi14 = get('rsi_14')
      const rsi24 = get('rsi_24')
      const complete = rsi6 != null && rsi14 != null && rsi24 != null
      const status = !complete ? '样本不足' : rsi14 >= 70 ? '超买区' : rsi14 <= 30 ? '超卖区' : rsi14 >= 50 ? '偏强' : '偏弱'
      const tone: Tone = !complete || rsi14! >= 70 || rsi14! <= 30 ? 'neutral' : rsi14! >= 50 ? 'bull' : 'bear'
      const direction = rsi14 != null && getPrevious('rsi_14') != null
        ? rsi14 > (getPrevious('rsi_14') ?? rsi14) ? 'RSI上行' : rsi14 < (getPrevious('rsi_14') ?? rsi14) ? 'RSI下行' : 'RSI走平'
        : null
      return {
        ...def,
        status,
        tone,
        metrics: [
          { label: 'RSI6', value: fmtIndicator(rsi6, 1) },
          { label: 'RSI14', value: fmtIndicator(rsi14, 1), tone },
          { label: 'RSI24', value: fmtIndicator(rsi24, 1) },
          { label: '方向', value: direction ?? '—' },
        ],
        detail: !complete ? '需要 RSI6/14/24 完整样本' : 'RSI14 ≥70 为超买，≤30 为超卖',
      }
    }

    case 'kdj': {
      const k = get('kdj_k')
      const d = get('kdj_d')
      const j = get('kdj_j')
      const complete = k != null && d != null && j != null
      const cross = crossLabel(k, d, getPrevious('kdj_k'), getPrevious('kdj_d'), '金叉', '死叉')
      const status = !complete ? '样本不足' : Math.max(k, d, j) >= 80 ? '超买区' : Math.min(k, d, j) <= 20 ? '超卖区' : cross ?? (k >= d ? 'K在D上方' : 'K在D下方')
      const tone: Tone = !complete || (Math.max(k ?? 0, d ?? 0, j ?? 0) >= 80) || (Math.min(k ?? 100, d ?? 100, j ?? 100) <= 20)
        ? 'neutral'
        : k! >= d! ? 'bull' : 'bear'
      return {
        ...def,
        status,
        tone,
        metrics: [
          { label: 'K', value: fmtIndicator(k, 1) },
          { label: 'D', value: fmtIndicator(d, 1) },
          { label: 'J', value: fmtIndicator(j, 1) },
          { label: '交叉', value: cross ?? '—' },
        ],
        detail: !complete ? '需要 K/D/J 完整样本' : 'KDJ 80/20 为常用超买超卖参考区间',
      }
    }

    case 'boll': {
      const upper = get('boll_upper')
      const middle = get('ma20')
      const lower = get('boll_lower')
      const complete = upper != null && middle != null && lower != null && middle > 0
      const bandwidth = complete ? (upper - lower) / middle : null
      let status = '样本不足'
      let tone: Tone = 'neutral'
      if (complete) {
        if (price > upper) { status = '突破上轨'; tone = 'bull' }
        else if (price < lower) { status = '跌破下轨'; tone = 'bear' }
        else if (price >= middle) { status = '中轨上方'; tone = 'bull' }
        else { status = '中轨下方'; tone = 'bear' }
      }
      return {
        ...def,
        status,
        tone,
        metrics: [
          { label: '上轨', value: fmtAssetPrice(upper, assetType) },
          { label: '中轨', value: fmtAssetPrice(middle, assetType) },
          { label: '下轨', value: fmtAssetPrice(lower, assetType) },
          { label: '带宽', value: fmtUnsignedPct(bandwidth) },
        ],
        detail: !complete ? '需要 BOLL 上下轨及 MA20 完整样本' : '价格位置用于判断通道方向，带宽用于观察收缩或扩张',
      }
    }

    case 'momentum': {
      const momentum5 = get('momentum_5d') ?? momentumAt(bars, index, 5)
      const momentum20 = get('momentum_20d') ?? momentumAt(bars, index, 20)
      const momentum60 = get('momentum_60d') ?? momentumAt(bars, index, 60)
      const complete = momentum5 != null && momentum20 != null && momentum60 != null
      const status = !complete ? '样本不足' : momentum5 > 0 && momentum20 > 0 && momentum60 > 0 ? '动能向上' : momentum5 < 0 && momentum20 < 0 && momentum60 < 0 ? '动能向下' : '方向分化'
      const tone: Tone = !complete ? 'neutral' : status === '动能向上' ? 'bull' : status === '动能向下' ? 'bear' : 'neutral'
      return {
        ...def,
        status,
        tone,
        metrics: [
          { label: '5周期', value: fmtPct(momentum5), tone: toneForChange(momentum5) },
          { label: '20周期', value: fmtPct(momentum20), tone: toneForChange(momentum20) },
          { label: '60周期', value: fmtPct(momentum60), tone: toneForChange(momentum60) },
          { label: '方向', value: status === '样本不足' ? '—' : status },
        ],
        detail: !complete ? '需要至少 60 个当前周期样本' : '按当前 K 线周期计算，不混用日历天数',
      }
    }

    case 'atr': {
      const atr = get('atr_14')
      const atrPct = atr != null && price > 0 ? atr / price : null
      const previousAtrPcts = bars
        .slice(Math.max(0, index - 20), index)
        .map(bar => {
          const value = field(bar, 'atr_14')
          return value != null && bar.close > 0 ? value / bar.close : null
        })
        .filter((value): value is number => value != null)
      const baseline = previousAtrPcts.length === 20 ? median(previousAtrPcts) : null
      const relative = atrPct != null && baseline != null && baseline > 0 ? atrPct / baseline : null
      const status = atrPct == null ? '样本不足' : relative == null ? '样本不足' : relative >= 1.2 ? '波动放大' : relative <= 0.8 ? '波动收敛' : '波动常态'
      return {
        ...def,
        status,
        tone: 'neutral',
        metrics: [
          { label: 'ATR14', value: fmtAssetPrice(atr, assetType) },
          { label: 'ATR/价', value: fmtUnsignedPct(atrPct) },
          { label: '相对中位', value: fmtRatio(relative) },
          { label: '状态', value: status },
        ],
        detail: relative == null ? '需要 ATR14 及此前 20 个周期作为波动基准' : '相对此前 20 个周期 ATR/价格中位数判断',
      }
    }
  }
}

function defaultTechnicalConfig(): StockPreviewTechnicalCardsConfig {
  return {
    order: [...DEFAULT_ORDER],
    visible: Object.fromEntries(DEFAULT_ORDER.map(key => [key, true])) as Partial<Record<StockTechnicalCardKey, boolean>>,
  }
}

function normalizeTechnicalConfig(raw: StockPreviewTechnicalCardsConfig | null | undefined): StockPreviewTechnicalCardsConfig {
  const savedOrder = Array.isArray(raw?.order) ? raw.order : []
  const known = new Set<string>(DEFAULT_ORDER)
  const order = savedOrder.filter((key): key is StockTechnicalCardKey => typeof key === 'string' && known.has(key))
  for (const key of DEFAULT_ORDER) {
    if (!order.includes(key)) order.push(key)
  }
  const savedVisible = raw?.visible && typeof raw.visible === 'object' ? raw.visible : {}
  const visible: Partial<Record<StockTechnicalCardKey, boolean>> = {}
  for (const key of DEFAULT_ORDER) {
    visible[key] = typeof savedVisible[key] === 'boolean' ? savedVisible[key] : true
  }
  return { order, visible }
}

function persistTechnicalConfig(config: StockPreviewTechnicalCardsConfig) {
  storage.stockPreviewTechnicalCards.set(config)
  window.dispatchEvent(new CustomEvent('stock-preview-technical-cards-change'))
}

function formatAsOf(value: string | null, period: KlinePeriod): string {
  if (!value) return '最新'
  const normalized = normalizeBarKey(value, period)
  return period === '30m' ? normalized.slice(5) : normalized
}

export interface StockTechnicalPanelProps {
  rows: KlineRow[]
  period: KlinePeriod
  selectedDate: string | null
  assetType?: 'stock' | 'etf' | 'index'
  isLoading?: boolean
  error?: Error | null
  onRetry?: () => void
  onLatest?: () => void
}

export function StockTechnicalPanel({
  rows,
  period,
  selectedDate,
  assetType,
  isLoading = false,
  error,
  onRetry,
  onLatest,
}: StockTechnicalPanelProps) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [config, setConfig] = useState<StockPreviewTechnicalCardsConfig>(() => normalizeTechnicalConfig(
    storage.stockPreviewTechnicalCards.get(defaultTechnicalConfig()),
  ))
  const bars = useMemo(() => normalizeBars(rows, period), [rows, period])
  const selectedIndex = useMemo(() => {
    if (!bars.length) return -1
    const selectedKey = selectedDate ? normalizeBarKey(selectedDate, period) : ''
    const index = selectedKey ? bars.findIndex(bar => bar.key === selectedKey) : -1
    return index >= 0 ? index : bars.length - 1
  }, [bars, period, selectedDate])
  const cards = useMemo(
    () => TECHNICAL_CARD_DEFS.map(def => buildTechnicalCard(def, bars, selectedIndex, assetType)),
    [assetType, bars, selectedIndex],
  )
  const cardsByKey = useMemo(() => new Map(cards.map(card => [card.key, card])), [cards])
  const orderedCards = useMemo(
    () => config.order.map(key => cardsByKey.get(key)).filter((card): card is TechnicalCardModel => !!card && config.visible[card.key] !== false),
    [cardsByKey, config.order, config.visible],
  )
  const isLatest = selectedIndex >= 0 && selectedIndex === bars.length - 1

  const updateConfig = (next: StockPreviewTechnicalCardsConfig) => {
    const normalized = normalizeTechnicalConfig(next)
    setConfig(normalized)
    persistTechnicalConfig(normalized)
  }

  const toggleCard = (key: StockTechnicalCardKey) => {
    updateConfig({
      ...config,
      visible: { ...config.visible, [key]: config.visible[key] === false },
    })
  }

  const resetConfig = () => updateConfig(defaultTechnicalConfig())

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = config.order.indexOf(active.id as StockTechnicalCardKey)
    const newIndex = config.order.indexOf(over.id as StockTechnicalCardKey)
    if (oldIndex < 0 || newIndex < 0) return
    updateConfig({ ...config, order: arrayMove(config.order, oldIndex, newIndex) })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {settingsOpen ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between border-b border-border/70 px-2.5 py-2">
            <button
              type="button"
              onClick={() => setSettingsOpen(false)}
              className="inline-flex items-center gap-1 rounded-btn px-1.5 py-1 text-[11px] text-secondary transition-colors hover:bg-elevated hover:text-foreground"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              技术指标
            </button>
            <button
              type="button"
              onClick={resetConfig}
              className="rounded-btn px-1.5 py-1 text-[10px] text-secondary transition-colors hover:bg-elevated hover:text-foreground"
            >
              恢复默认
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
            <p className="mb-2 text-[10px] leading-relaxed text-muted">拖动调整顺序，勾选控制卡片显隐。配置只影响本机展示，不改变行情数据。</p>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={config.order} strategy={verticalListSortingStrategy}>
                <div className="space-y-1.5">
                  {config.order.map(key => {
                    const def = TECHNICAL_CARD_DEFS.find(item => item.key === key)
                    if (!def) return null
                    return (
                      <SortableTechnicalRow
                        key={key}
                        id={key}
                        label={def.label}
                        description={def.description}
                        visible={config.visible[key] !== false}
                        onToggle={() => toggleCard(key)}
                      />
                    )
                  })}
                </div>
              </SortableContext>
            </DndContext>
          </div>
        </div>
      ) : (
        <>
          <div className="flex shrink-0 items-start justify-between border-b border-border/70 px-2.5 py-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                <span className="text-xs font-medium text-foreground">技术指标</span>
                <span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[9px] text-secondary">{PERIOD_LABELS[period]}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted">
                <span>截至 {formatAsOf(selectedDate, period)}</span>
                {!isLatest && bars.length > 0 && (
                  <button
                    type="button"
                    onClick={onLatest}
                    className="text-accent transition-colors hover:text-foreground"
                  >
                    回到最新
                  </button>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="shrink-0 rounded-btn p-1 text-muted transition-colors hover:bg-elevated hover:text-foreground"
              title="配置指标卡片"
              aria-label="配置指标卡片"
            >
              <Settings2 className="h-3.5 w-3.5" />
            </button>
          </div>

          {isLoading && bars.length === 0 ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
                {Array.from({ length: 6 }, (_, index) => (
                  <div key={index} className="h-[116px] animate-pulse rounded-card border border-border bg-surface/60" />
                ))}
              </div>
            </div>
          ) : error && bars.length === 0 ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
              <span className="text-xs text-secondary">技术指标暂时不可用</span>
              <span className="text-[10px] text-muted">周期行情加载失败，请稍后重试。</span>
              {onRetry && (
                <button type="button" onClick={onRetry} className="rounded-btn bg-elevated px-2.5 py-1 text-[10px] text-secondary transition-colors hover:text-foreground">
                  重试
                </button>
              )}
            </div>
          ) : bars.length === 0 ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-xs text-muted">暂无技术指标数据</div>
          ) : orderedCards.length === 0 ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
              <span className="text-xs text-secondary">暂未选择指标卡</span>
              <button type="button" onClick={() => setSettingsOpen(true)} className="rounded-btn bg-elevated px-2.5 py-1 text-[10px] text-accent transition-colors hover:text-foreground">
                选择指标卡
              </button>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
                {orderedCards.map(card => <TechnicalCard key={card.key} card={card} />)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function TechnicalCard({ card }: { card: TechnicalCardModel }) {
  const tone = TONE_CLASSES[card.tone]
  return (
    <div className="rounded-card border border-border bg-surface/70 p-2.5 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[11px] font-medium text-foreground">{card.label}</div>
          <div className="mt-0.5 truncate text-[9px] text-muted">{card.description}</div>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] ${tone.badge}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
          {card.status}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1.5">
        {card.metrics.map(metric => (
          <div key={metric.label} className="min-w-0">
            <div className="text-[9px] text-muted">{metric.label}</div>
            <div className={`truncate font-mono text-[11px] tabular-nums ${metric.tone ? TONE_CLASSES[metric.tone].value : 'text-secondary'}`} title={metric.value}>
              {metric.value}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 truncate border-t border-border/50 pt-1.5 text-[9px] text-muted" title={card.detail}>{card.detail}</div>
    </div>
  )
}

function SortableTechnicalRow({
  id,
  label,
  description,
  visible,
  onToggle,
}: {
  id: StockTechnicalCardKey
  label: string
  description: string
  visible: boolean
  onToggle: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? 10 : undefined,
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-2 rounded-card border px-2.5 py-2 transition-colors ${isDragging ? 'bg-elevated shadow-lg' : ''} ${visible ? 'border-accent/40 bg-accent/[0.05]' : 'border-border bg-base/30'}`}
    >
      <button type="button" {...attributes} {...listeners} className="shrink-0 cursor-grab text-muted transition-colors hover:text-foreground active:cursor-grabbing" title="拖动排序">
        <GripVertical className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onToggle}
        role="checkbox"
        aria-checked={visible}
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${visible ? 'border-accent bg-accent' : 'border-border bg-base'}`}
        title={visible ? '隐藏指标卡' : '显示指标卡'}
      >
        {visible && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-foreground">{label}</div>
        <div className="text-[10px] leading-snug text-muted">{description}</div>
      </div>
    </div>
  )
}
