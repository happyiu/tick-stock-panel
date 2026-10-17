import {
  useEffect, useState, useCallback, useRef, useMemo, useId,
  type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent,
} from 'react'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { PanelRightClose, PanelRightOpen, RefreshCw } from 'lucide-react'
import { api, type KlinePeriod, type KlineResponse, type KlineRow } from '@/lib/api'
import {
  canAutoRefreshAnalysis,
  DEFAULT_30M_DAYS,
  DEFAULT_INTRADAY_DAYS,
  defaultKlineRange,
  filterKlineRowsThrough,
  klineDailyQueryOptions,
  klineMinuteQueryOptions,
  klineMinuteRangeQueryOptions,
  klinePeriodQueryOptions,
  normalizeKlineBarKey,
  nextThirtyMinuteBoundaryAt,
} from '@/lib/kline'
import { StockInfoBar } from '@/components/StockInfoBar'
import {
  StockDailyKChart,
  getDefaultRange,
  toOHLC,
  type ChartSignalSelection,
  type ChartStrategySelection,
} from '@/components/StockDailyKChart'
import { StockIntradayChart } from '@/components/StockIntradayChart'
import { StockTechnicalPanel } from '@/components/StockTechnicalPanel'
import { StockChanlunPanel } from '@/components/StockChanlunPanel'
import { LevelOverview, PriceLevelControls, usePriceLevels } from './stock-analysis/PriceLevels'
import { QK } from '@/lib/queryKeys'
import { StockAiChatPanel } from '@/components/StockAiChatPanel'
import { useQuoteStatus } from '@/lib/useSharedQueries'
import { scheduleNeighborPrefetch } from '@/lib/neighborPrefetch'
import type { ChartMarker, ChartPriceLine, ChartRange } from '@/lib/kline-chart'
import {
  loadInfoFields,
  buildInfoExtColumnsParam,
} from '@/lib/stock-info-fields'
import { emptyChanlunAnalysis, type ChanlunStructureSource } from '@/lib/chanlun'
import { chanlunQueryOptions } from '@/lib/chanlunQuery'
import { storage, type StockPreviewAnalysisSectionsV2, type StockPreviewAnalysisSectionsV3 } from '@/lib/storage'
import { buildStockChatSnapshot } from '@/lib/stockChatContext'

const DEFAULT_SPLIT_RATIO = 1.4 / 2.4
const MIN_SPLIT_RATIO = 0.25
const MAX_SPLIT_RATIO = 0.75
const SPLIT_GAP_PX = 12
const CHANLUN_PERIODS: KlinePeriod[] = ['30m', '1d', '1w', '1mo']

function ChartScrollbar({ scrollRef, controlsId, active }: {
  scrollRef: { current: HTMLDivElement | null }
  controlsId: string
  active: boolean
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragStart = useRef<{ pointerY: number; scrollTop: number } | null>(null)
  const [metrics, setMetrics] = useState({ hasOverflow: false, top: 0, height: 0, scrollTop: 0, maxScroll: 0 })
  const [focused, setFocused] = useState(false)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const update = () => {
      const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight)
      const trackHeight = Math.max(0, element.clientHeight - 8)
      const hasOverflow = maxScroll > 0 && trackHeight > 0
      const height = hasOverflow
        ? Math.min(trackHeight, Math.max(24, trackHeight * element.clientHeight / element.scrollHeight))
        : 0
      const top = maxScroll > 0 ? element.scrollTop / maxScroll * (trackHeight - height) : 0
      setMetrics({ hasOverflow, top, height, scrollTop: element.scrollTop, maxScroll })
    }
    update()
    element.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    return () => {
      element.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [scrollRef])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = scrollRef.current
    const track = trackRef.current
    if (!element || !track || event.button !== 0) return
    event.preventDefault()
    setDragging(true)
    const maxThumbTop = Math.max(0, track.clientHeight - metrics.height)
    if ((event.target as HTMLElement).dataset.scrollbarThumb === 'true') {
      dragStart.current = { pointerY: event.clientY, scrollTop: element.scrollTop }
    } else if (maxThumbTop > 0) {
      const clickedTop = event.clientY - track.getBoundingClientRect().top - metrics.height / 2
      element.scrollTop = Math.max(0, Math.min(1, clickedTop / maxThumbTop)) * metrics.maxScroll
      dragStart.current = { pointerY: event.clientY, scrollTop: element.scrollTop }
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = scrollRef.current
    const track = trackRef.current
    if (!element || !track || !dragStart.current) return
    const maxThumbTop = track.clientHeight - metrics.height
    if (maxThumbTop <= 0) return
    element.scrollTop = dragStart.current.scrollTop
      + (event.clientY - dragStart.current.pointerY) / maxThumbTop * metrics.maxScroll
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const element = scrollRef.current
    if (!element) return
    const page = Math.max(40, element.clientHeight * 0.9)
    const destinations: Record<string, number> = {
      ArrowUp: element.scrollTop - 40,
      ArrowDown: element.scrollTop + 40,
      PageUp: element.scrollTop - page,
      PageDown: element.scrollTop + page,
      Home: 0,
      End: metrics.maxScroll,
    }
    if (destinations[event.key] == null) return
    event.preventDefault()
    element.scrollTop = destinations[event.key]
  }

  const visible = active || focused || dragging
  if (!metrics.hasOverflow) return null
  return (
    <div
      ref={trackRef}
      role="scrollbar"
      aria-label="K线图滚动条"
      aria-controls={controlsId}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={metrics.maxScroll}
      aria-valuenow={metrics.scrollTop}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={event => {
        dragStart.current = null
        setDragging(false)
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={() => { dragStart.current = null; setDragging(false) }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onWheel={event => {
        const element = scrollRef.current
        if (!element) return
        event.preventDefault()
        const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY * 32
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? event.deltaY * element.clientHeight
            : event.deltaY
        element.scrollTop += delta
      }}
      onKeyDown={onKeyDown}
      className={`absolute inset-y-1 right-0 z-20 w-4 touch-none select-none cursor-grab outline-none active:cursor-grabbing transition-opacity duration-150 ${visible ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'}`}
    >
      <span
        data-scrollbar-thumb="true"
        className="absolute left-1/2 w-1.5 -translate-x-1/2 rounded-full bg-muted/80 hover:bg-accent/80"
        style={{ top: metrics.top, height: metrics.height }}
      />
    </div>
  )
}

function clampSplitRatioValue(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPLIT_RATIO
  return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, value))
}

function formatAnalysisAsOf(value: string | null, period: KlinePeriod): string {
  if (!value) return '最新'
  const normalized = value.replace('T', ' ')
  return period === '30m' ? normalized.slice(5, 16) : normalized.slice(0, 10)
}

function formatAnalysisCalculatedAt(value: number | null | undefined): string {
  if (value == null) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

function normalizeAnalysisSections(
  value: StockPreviewAnalysisSectionsV3 | null | undefined,
  legacy: StockPreviewAnalysisSectionsV2 | null | undefined,
): StockPreviewAnalysisSectionsV3 {
  return {
    version: 3,
    technicalCollapsed: value?.technicalCollapsed ?? legacy?.technicalCollapsed ?? false,
    chanlunCollapsed: value?.chanlunCollapsed === true,
  }
}

export type StockPanelRightPaneMode = 'intraday' | 'technical' | 'empty'
type StockAnalysisTab = 'indicator' | 'structure' | 'levels' | 'ai'

const STOCK_ANALYSIS_TABS: Array<{ id: StockAnalysisTab; label: string }> = [
  { id: 'indicator', label: '指标分析' },
  { id: 'structure', label: '结构分析' },
  { id: 'levels', label: '关键价位' },
  { id: 'ai', label: 'AI分析' },
]

interface Props {
  symbol: string
  height?: number
  showIntraday?: boolean
  /** 右侧分栏内容；empty 保留空白面板和关闭/展开交互。 */
  rightPaneMode?: StockPanelRightPaneMode
  /** 兼容旧调用方：false 等价于 rightPaneMode="empty"。 */
  showIntradayChart?: boolean
  className?: string
  /** 当用户点击蜡烛选中日期时回调（用于外部自动开启分时图）。 */
  onSelectDate?: (date: string) => void
  /** 将当前图表选中 K 线回传给详情页玩法入口。 */
  onSelectedDateChange?: (date: string | null) => void
  /** 回传当前周期的完整 K 线快照，供详情页玩法在确认时复制。 */
  onPeriodRowsChange?: (rows: KlineRow[]) => void
  /** 外部传入的日期范围 */
  dateRange?: { start: string; end: string }
  markers?: ChartMarker[]
  ranges?: ChartRange[]
  priceLines?: ChartPriceLine[]
  showLimitMarkers?: boolean
  showMarkerToggle?: boolean
  /** 加监控回调 (传入后信息条显示 RadioTower 图标) */
  onMonitor?: () => void
  /** 将查询到的资产类型传给外部弹窗/告警输入。 */
  onAssetTypeChange?: (assetType?: 'stock' | 'etf' | 'index') => void
  onPriceDoubleClick?: (price: number, currentPrice: number) => void
  /** 自选操作（传入后信息条显示 Star 图标） */
  inWatchlist?: boolean
  onAddToWatchlist?: (groupId: string | null) => void
  onRemoveFromWatchlist?: () => void
  watchlistPending?: boolean
  /** 分时图自动刷新间隔(ms)。undefined = 不轮询。个股对话框盘中实时刷新时传入。 */
  refetchIntervalMs?: number
  /** 只渲染信息条, 隐藏图表 (用于分时 tab 共享信息条) */
  infoBarOnly?: boolean
  /** 邻近预取目标 (切股导航的左右邻股): 提前拉取其日K/财务/分时缓存, 切换瞬间免 loading */
  prefetchSymbols?: string[]
  /** 多日分时周期 (分时 tab 使用): 预取邻股 klineMinuteRange 时用同一 days, 保证 queryKey 命中 */
  intradayDays?: number
  /** 日K/分时并排时日K图占宽 (默认 1:1; 弹窗内图表信息栏较宽需更多空间时传 flex-[1.4] 之类) */
  dailyKlineFlex?: string
  /** 日K/分时并排时, 是否允许拖动中间分隔线调整两栏宽度。 */
  resizableSplit?: boolean
  /** 将日K与右侧面板限制在同一高度，并让两栏内容分别滚动。 */
  independentPaneScroll?: boolean
  /** 主蜡烛图周期；常态信息条仍使用日线口径，调试锁定时跟随可见周期截面。 */
  period?: KlinePeriod
  periodDays?: number
  /** 调试进行中时，图表及其附属分析只显示到该根 K 线。 */
  visibleThrough?: string | null
  /** 调试设置开启时，不显示当前推进 K 线的日期。 */
  hideCurrentDate?: boolean
  /** 在标的详情顶部信息条打开策略选择器。 */
  onAddStrategy?: (assetType: 'stock' | 'etf', period: KlinePeriod) => void
  /** 当前日K图已选中的策略。 */
  selectedStrategy?: ChartStrategySelection | null
  /** 清除当前日K图的策略选择。 */
  onClearStrategy?: () => void
  /** 在标的详情顶部信息条打开信号库选择器。 */
  onAddSignal?: (assetType: 'stock' | 'etf', period: KlinePeriod) => void
  /** 当前日K图已选中的信号库信号。 */
  selectedSignals?: ChartSignalSelection[]
  /** 清除当前日K图的信号选择。 */
  onClearSignals?: () => void
  /** 外部锁定的当前 K 线；用于逐根推进时保持详情页各区域同步。 */
  lockedSelectedDate?: string | null
  /** 初始可见蜡烛根数 (默认 60); 'all' = 初始适配显示全部数据 (用于全区间回放) */
  visibleBars?: number | 'all'
  /** 加入自选日 (北京时间 YYYY-MM-DD); 有值时日K主图绘制「自选」竖虚线 */
  addedDate?: string | null
}

interface AnalysisSnapshot {
  contextKey: string
  response: KlineResponse
  calculatedAt: number
}

export { getDefaultRange }

export function StockPanel({
  symbol,
  height = 520,
  showIntraday = true,
  rightPaneMode,
  showIntradayChart = true,
  className,
  onSelectDate,
  onSelectedDateChange,
  onPeriodRowsChange,
  dateRange: externalDateRange,
  markers,
  ranges,
  priceLines,
  showLimitMarkers = true,
  showMarkerToggle = true,
  onMonitor,
  onAssetTypeChange,
  onPriceDoubleClick,
  inWatchlist,
  onAddToWatchlist,
  onRemoveFromWatchlist,
  watchlistPending,
  refetchIntervalMs,
  infoBarOnly = false,
  prefetchSymbols,
  intradayDays = DEFAULT_INTRADAY_DAYS,
  dailyKlineFlex = 'flex-1',
  resizableSplit = false,
  independentPaneScroll = false,
  period = '1d',
  periodDays = DEFAULT_30M_DAYS,
  visibleThrough,
  hideCurrentDate = false,
  onAddStrategy,
  selectedStrategy,
  onClearStrategy,
  onAddSignal,
  selectedSignals,
  onClearSignals,
  lockedSelectedDate,
  visibleBars,
  addedDate,
}: Props) {
  const resolvedRightPaneMode: StockPanelRightPaneMode = rightPaneMode
    ?? (showIntradayChart ? 'intraday' : 'empty')
  const includeTechnicalScores = resolvedRightPaneMode === 'technical'
  const [linkedPrice, setLinkedPrice] = useState<number | null>(null)
  const [selectedBarKey, setSelectedBarKey] = useState<string | null>(null)
  const effectiveSelectedBarKey = lockedSelectedDate ?? selectedBarKey
  const [followsLatest, setFollowsLatest] = useState(true)
  const followsLatestRef = useRef(true)
  const [rightPaneDismissed, setRightPaneDismissed] = useState(false)
  const [chanlunSource, setChanlunSource] = useState<ChanlunStructureSource>('stroke')
  const [multiPeriodExpanded, setMultiPeriodExpanded] = useState(false)
  const [splitRatio, setSplitRatio] = useState(() => clampSplitRatioValue(
    storage.stockPreviewSplitRatio.get(DEFAULT_SPLIT_RATIO),
  ))
  const [analysisSections, setAnalysisSections] = useState(() => normalizeAnalysisSections(
    storage.stockPreviewAnalysisSectionsV3.get(null),
    storage.stockPreviewAnalysisSectionsV2.get(null),
  ))
  const [analysisTab, setAnalysisTab] = useState<StockAnalysisTab>('indicator')
  const [splitDragging, setSplitDragging] = useState(false)
  const [chartScrollbarHovered, setChartScrollbarHovered] = useState(false)
  const setFollowingLatest = useCallback((value: boolean) => {
    followsLatestRef.current = value
    setFollowsLatest(value)
  }, [])
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const dailyPaneRef = useRef<HTMLDivElement>(null)
  const dailyChartScrollRef = useRef<HTMLDivElement>(null)
  const dailyChartScrollId = useId()
  const splitDraggingRef = useRef(false)
  const splitRatioRef = useRef(splitRatio)
  const splitPointerOffsetRef = useRef(0)
  // 沿用已保存的信息字段配置，供K线请求包含 ext 数据列。
  const extColumns = useMemo(() => buildInfoExtColumnsParam(loadInfoFields()), [])

  const toggleAnalysisSection = useCallback((key: keyof Omit<StockPreviewAnalysisSectionsV3, 'version'>) => {
    setAnalysisSections(previous => {
      const next = { ...previous, [key]: !previous[key] }
      storage.stockPreviewAnalysisSectionsV3.set(next)
      return next
    })
  }, [])

  const { data: quoteStatus } = useQuoteStatus({
    enabled: !!symbol && resolvedRightPaneMode === 'technical',
  })

  const chartDateRange = useMemo(
    () => externalDateRange ?? defaultKlineRange(period),
    [externalDateRange, period],
  )
  const infoDateRange = useMemo(
    () => period === '1d' ? chartDateRange : getDefaultRange(),
    [chartDateRange, period],
  )

  // 日K查询由本组件持有 (与 StockDailyKChart 共享同一 cache key/配置, 只发一次请求)。
  // 信息条直接读 query data: 切股到已预取邻股时首帧即有数据, 配合 StockInfoBar 加载态占位,
  // 弹窗整体高度在切换瞬间不塌陷 (不抖动)。
  const kline = useQuery({
    ...klineDailyQueryOptions(symbol, infoDateRange, extColumns, includeTechnicalScores),
    enabled: !!symbol,
    refetchInterval: refetchIntervalMs,
  })
  const rawRows: KlineRow[] = kline.data?.rows ?? []
  const assetType = kline.data?.asset_type
  const visibleRawRows = useMemo(
    () => filterKlineRowsThrough(rawRows, '1d', visibleThrough),
    [rawRows, visibleThrough],
  )
  // OHLC 视图用于日期选中/昨收价推导 (与图表侧同口径)
  const rows = useMemo(() => toOHLC(visibleRawRows, '1d'), [visibleRawRows])
  // 技术面板观察与左侧 K 线完全相同的 period query; 1d 时会与上面的日K query 共享缓存。
  const periodKline = useQuery({
    ...klinePeriodQueryOptions(symbol, period, chartDateRange, periodDays, extColumns, includeTechnicalScores),
    enabled: !!symbol && (
      period === '30m'
      || resolvedRightPaneMode === 'technical'
    ),
    refetchInterval: refetchIntervalMs,
  })
  const periodRawRows: KlineRow[] = useMemo(
    () => periodKline.data?.rows ?? [],
    [periodKline.data?.rows],
  )
  const visiblePeriodRawRows = useMemo(
    () => filterKlineRowsThrough(periodRawRows, period, visibleThrough),
    [period, periodRawRows, visibleThrough],
  )
  const periodRows = useMemo(() => toOHLC(visiblePeriodRawRows, period), [period, visiblePeriodRawRows])
  const refetchPeriod = periodKline.refetch

  useEffect(() => {
    if (!onPeriodRowsChange) return
    onPeriodRowsChange(periodKline.isPlaceholderData ? [] : periodRawRows)
  }, [onPeriodRowsChange, periodKline.isPlaceholderData, periodRawRows])
  const analysisContextKey = `${symbol}|${resolvedRightPaneMode}|${period}|${chartDateRange.start}|${chartDateRange.end}|${periodDays}|${extColumns ?? ''}|${includeTechnicalScores}`
  const [analysisSnapshot, setAnalysisSnapshot] = useState<AnalysisSnapshot | null>(null)
  const [analysisRefreshing, setAnalysisRefreshing] = useState(false)
  const [analysisRefreshError, setAnalysisRefreshError] = useState<Error | null>(null)
  const analysisRefreshRequestRef = useRef(0)
  const previousAnalysisContextRef = useRef(analysisContextKey)

  useEffect(() => {
    if (previousAnalysisContextRef.current === analysisContextKey) return
    previousAnalysisContextRef.current = analysisContextKey
    analysisRefreshRequestRef.current += 1
    setAnalysisSnapshot(null)
    setAnalysisRefreshing(false)
    setAnalysisRefreshError(null)
    setFollowingLatest(true)
  }, [analysisContextKey, setFollowingLatest])

  // 只在当前周期的真实响应首次到达时建立快照；实时查询后续更新继续留给左图。
  useEffect(() => {
    const liveResponse = periodKline.data
    if (resolvedRightPaneMode !== 'technical' || !liveResponse || periodKline.isPlaceholderData) return
    setAnalysisSnapshot(previous => {
      if (previous?.contextKey === analysisContextKey) return previous
      return {
        contextKey: analysisContextKey,
        response: liveResponse,
        calculatedAt: Date.now(),
      }
    })
  }, [analysisContextKey, periodKline.data, periodKline.isPlaceholderData, resolvedRightPaneMode])

  const analysisResponse = analysisSnapshot?.contextKey === analysisContextKey
    ? analysisSnapshot.response
    : undefined
  const displayAnalysisResponse = useMemo(() => {
    if (!analysisResponse || !visibleThrough) return analysisResponse
    const boundary = normalizeKlineBarKey(visibleThrough, period)
    const technicalScores = analysisResponse.technical_scores
      ? {
          ...analysisResponse.technical_scores,
          rows: analysisResponse.technical_scores.rows.filter(row => (
            normalizeKlineBarKey(row.as_of, period) <= boundary
          )),
        }
      : undefined
    const dataStatus = analysisResponse.data_status
      ? { ...analysisResponse.data_status, data_through: visibleThrough }
      : analysisResponse.data_status
    return {
      ...analysisResponse,
      rows: filterKlineRowsThrough(analysisResponse.rows, period, visibleThrough),
      technical_scores: technicalScores,
      data_status: dataStatus,
    }
  }, [analysisResponse, period, visibleThrough])
  const analysisRows = useMemo(
    () => toOHLC(displayAnalysisResponse?.rows ?? [], period),
    [displayAnalysisResponse?.rows, period],
  )
  const analysisAssetType = displayAnalysisResponse?.asset_type ?? assetType
  const analysisLoading = !analysisResponse && (periodKline.isLoading || periodKline.isFetching)
  const analysisError = analysisRefreshError ?? periodKline.error

  const [levelsRequested, setLevelsRequested] = useState(false)
  const priceLevelEnd = [effectiveSelectedBarKey, visibleThrough, chartDateRange.end, analysisRows.at(-1)?.date]
    .filter((value): value is string => !!value).map(value => value.slice(0, 10)).sort()[0]
  const priceLevelsEnabled = resolvedRightPaneMode === 'technical' && period === '1d'
  const priceLevelsQuery = useQuery({
    queryKey: QK.stockLevels(symbol, 250, priceLevelEnd),
    queryFn: () => api.stockAnalysisLevels(symbol, 250, priceLevelEnd),
    enabled: !!symbol && priceLevelsEnabled && levelsRequested && !!priceLevelEnd && !!displayAnalysisResponse && analysisRows.length > 0,
    staleTime: 60_000,
    refetchInterval: refetchIntervalMs,
  })
  const priceLevelData = priceLevelsEnabled && displayAnalysisResponse ? priceLevelsQuery.data : undefined
  const priceLevelState = usePriceLevels({
    rows: displayAnalysisResponse?.rows ?? [],
    levels: priceLevelData?.levels,
    series: priceLevelData?.series,
    seriesDates: priceLevelData?.dates,
    assetType: analysisAssetType,
  })
  const chartPriceLines = useMemo(
    () => [...(priceLines ?? []), ...priceLevelState.priceLines],
    [priceLines, priceLevelState.priceLines],
  )
  const refetchPriceLevels = priceLevelsQuery.refetch
  const hasPriceLevels = priceLevelData && Object.values(priceLevelData.levels).some(group => group.length > 0)

  const chanlunCutoff = [effectiveSelectedBarKey, visibleThrough, analysisRows.at(-1)?.date]
    .filter((value): value is string => !!value).sort()[0] ?? null
  const chanlunQuery = useQuery({
    ...chanlunQueryOptions(symbol, analysisAssetType ?? 'stock', period, chartDateRange, periodDays,
      chanlunSource, chanlunCutoff, analysisSnapshot?.contextKey === analysisContextKey ? analysisSnapshot.calculatedAt : 0),
    enabled: !!symbol && resolvedRightPaneMode === 'technical' && !!displayAnalysisResponse && analysisRows.length > 0,
  })
  const chanlunAnalysis = useMemo(
    () => chanlunQuery.data ?? emptyChanlunAnalysis(period, chanlunSource),
    [chanlunQuery.data, period, chanlunSource],
  )
  const stockChatSnapshot = useMemo(
    () => buildStockChatSnapshot({
      symbol,
      period,
      assetType: analysisAssetType,
      selectedDate: effectiveSelectedBarKey,
      response: displayAnalysisResponse,
      chanlun: chanlunAnalysis,
    }),
    [chanlunAnalysis, displayAnalysisResponse, effectiveSelectedBarKey, period, symbol],
  )
  const recalculateAnalysis = useCallback(async () => {
    const requestId = analysisRefreshRequestRef.current + 1
    analysisRefreshRequestRef.current = requestId
    setAnalysisRefreshing(true)
    setAnalysisRefreshError(null)
    try {
      const primaryResult = await refetchPeriod()
      if (analysisRefreshRequestRef.current !== requestId) return
      if (primaryResult.error || !primaryResult.data) {
        throw primaryResult.error ?? new Error('当前周期行情加载失败，无法计算分析。')
      }

      const calculatedAt = Date.now()
      setAnalysisSnapshot({
        contextKey: analysisContextKey,
        response: primaryResult.data,
        calculatedAt,
      })
      if (followsLatestRef.current) {
        const latestKey = primaryResult.data.rows.at(-1)?.date
        if (latestKey) setSelectedBarKey(latestKey)
      }
      if (priceLevelsEnabled && levelsRequested) await refetchPriceLevels()
      if (analysisRefreshRequestRef.current !== requestId) return
      setAnalysisRefreshError(null)
    } catch (error) {
      if (analysisRefreshRequestRef.current === requestId) {
        setAnalysisRefreshError(error instanceof Error ? error : new Error('分析计算失败，请稍后重试。'))
      }
    } finally {
      if (analysisRefreshRequestRef.current === requestId) setAnalysisRefreshing(false)
    }
  }, [analysisContextKey, refetchPeriod, priceLevelsEnabled, levelsRequested, refetchPriceLevels])

  const autoAnalysisEnabled = canAutoRefreshAnalysis(
    quoteStatus?.is_trading_hours === true,
    followsLatest,
  )
  useEffect(() => {
    if (
      resolvedRightPaneMode !== 'technical'
      || !symbol
      || refetchIntervalMs == null
      || !autoAnalysisEnabled
      || analysisRefreshing
    ) return
    const nextBoundary = nextThirtyMinuteBoundaryAt()
    if (nextBoundary == null) return
    const timer = window.setTimeout(() => {
      if (canAutoRefreshAnalysis(quoteStatus?.is_trading_hours === true, followsLatestRef.current)) {
        void recalculateAnalysis()
      }
    }, Math.max(0, nextBoundary - Date.now()))
    return () => window.clearTimeout(timer)
  }, [analysisRefreshing, autoAnalysisEnabled, quoteStatus?.is_trading_hours, recalculateAnalysis, refetchIntervalMs, resolvedRightPaneMode, symbol])

  // 非日K查询尚未到达时用信息条的日线维持分栏高度，数据到达后自动切换到目标周期。
  const selectableRows = period !== '1d' && periodRows.length > 0 ? periodRows : rows
  const infoRows = visibleThrough && period !== '1d' ? visiblePeriodRawRows : visibleRawRows
  const stockInfo = kline.data?.stock_info
  const name = kline.data?.name

  const multiObservationEnd = effectiveSelectedBarKey?.slice(0, 10) ?? chartDateRange.end
  const multiPeriodQueries = useQueries({
    queries: CHANLUN_PERIODS.map(candidatePeriod => {
      const endDate = new Date(`${multiObservationEnd}T12:00:00`)
      const range = candidatePeriod === period
        ? chartDateRange
        : defaultKlineRange(candidatePeriod, Number.isNaN(endDate.getTime()) ? new Date() : endDate)
      return {
        ...chanlunQueryOptions(symbol, analysisAssetType ?? 'stock', candidatePeriod, range, periodDays,
          chanlunSource, chanlunCutoff, analysisSnapshot?.contextKey === analysisContextKey ? analysisSnapshot.calculatedAt : 0),
        enabled: multiPeriodExpanded && !!symbol && (candidatePeriod === '1d' || assetType !== 'index'),
        staleTime: 30_000,
      }
    }),
  })
  const multiPeriodAnalysis = CHANLUN_PERIODS.map((candidatePeriod, index) => {
    const query = multiPeriodQueries[index]
    return {
      period: candidatePeriod,
      analysis: query.data,
      isLoading: query.isLoading || query.isFetching && !query.data,
      error: query.error,
    }
  })

  useEffect(() => {
    if (assetType) onAssetTypeChange?.(assetType)
  }, [assetType, onAssetTypeChange])

  useEffect(() => {
    onSelectedDateChange?.(selectedBarKey)
  }, [onSelectedDateChange, selectedBarKey])

  const handleDateClick = useCallback((date: string) => {
    if (lockedSelectedDate != null) return
    const selected = period === '30m'
      ? date.replace('T', ' ').slice(0, 16)
      : date.slice(0, 10)
    setSelectedBarKey(selected)
    setFollowingLatest(selected === selectableRows.at(-1)?.date)
    setRightPaneDismissed(false)
    // 兼容外部已有的分时自动打开回调，仍只传交易日。
    if (resolvedRightPaneMode === 'intraday') onSelectDate?.(selected.slice(0, 10))
  }, [lockedSelectedDate, onSelectDate, period, resolvedRightPaneMode, selectableRows, setFollowingLatest])

  const handleLatest = useCallback(() => {
    if (lockedSelectedDate != null) return
    const latestKey = selectableRows.at(-1)?.date ?? null
    if (!latestKey) return
    setFollowingLatest(true)
    setSelectedBarKey(latestKey)
  }, [lockedSelectedDate, selectableRows, setFollowingLatest])

  const clampSplitRatio = useCallback((value: number) => (
    clampSplitRatioValue(value)
  ), [])

  const ratioForClientX = useCallback((clientX: number): number | null => {
    const container = splitContainerRef.current
    if (!container) return null
    const rect = container.getBoundingClientRect()
    if (rect.width <= 0) return null
    // 分隔线位于两栏之间的 gap 右侧, 用 gap 宽度还原左栏占比。
    return clampSplitRatio((clientX - rect.left - SPLIT_GAP_PX) / rect.width)
  }, [clampSplitRatio])

  const applySplitRatio = useCallback((ratio: number) => {
    splitRatioRef.current = ratio
    if (dailyPaneRef.current) {
      dailyPaneRef.current.style.flexBasis = `${ratio * 100}%`
    }
  }, [])

  const handleSplitPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizableSplit || (event.pointerType === 'mouse' && event.button !== 0)) return
    event.preventDefault()
    const dailyPane = dailyPaneRef.current
    if (dailyPane) {
      // 手柄有一定命中宽度, 记录按下点相对分隔线的偏移, 避免开始拖动时跳动。
      const dividerX = dailyPane.getBoundingClientRect().right + SPLIT_GAP_PX
      splitPointerOffsetRef.current = event.clientX - dividerX
    }
    splitDraggingRef.current = true
    setSplitDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [resizableSplit])

  const handleSplitPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!splitDraggingRef.current) return
    const ratio = ratioForClientX(event.clientX - splitPointerOffsetRef.current)
    if (ratio != null) applySplitRatio(ratio)
  }, [applySplitRatio, ratioForClientX])

  const handleSplitPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!splitDraggingRef.current) return
    splitDraggingRef.current = false
    splitPointerOffsetRef.current = 0
    setSplitDragging(false)
    setSplitRatio(splitRatioRef.current)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  const handleSplitKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!resizableSplit) return
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    if (direction === 0) return
    event.preventDefault()
    const ratio = clampSplitRatio(splitRatioRef.current + direction * 0.05)
    applySplitRatio(ratio)
    setSplitRatio(ratio)
  }, [applySplitRatio, clampSplitRatio, resizableSplit])

  useEffect(() => {
    storage.stockPreviewSplitRatio.set(splitRatio)
  }, [splitRatio])

  useEffect(() => {
    if (!splitDragging) return
    const previousUserSelect = document.body.style.userSelect
    const previousCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    return () => {
      document.body.style.userSelect = previousUserSelect
      document.body.style.cursor = previousCursor
    }
  }, [splitDragging])
  // 当前日K就绪后, 等可见查询空闲再串行预取邻股, 避免首屏争抢公网带宽。
  // 日K/分时预取 staleTime 30s 防来回切换重复请求; 成为当前股后 useQuery(staleTime=0) 立即后台刷新,
  // SSE 也只按焦点股精准失效, 实时性不受影响。
  // prefetchKey 按内容 join: 自选页 navList 随行情 tick 重建但邻股集合通常不变, 避免 effect 每次 tick 重跑。
  const qc = useQueryClient()
  const prefetchKey = prefetchSymbols?.join(',') ?? ''
  useEffect(() => {
    if (!symbol || !prefetchKey || !kline.isSuccess || kline.isPlaceholderData) return
    const tasks: Array<() => Promise<unknown>> = []
    for (const s of new Set(prefetchKey.split(',').filter(Boolean))) {
      if (s === symbol) continue
      let lastDate: string | undefined
      tasks.push(async () => {
        const res = await qc.fetchQuery({
          ...klineDailyQueryOptions(s, infoDateRange, extColumns, includeTechnicalScores),
          staleTime: 30_000,
        })
        const date = res?.rows?.at(-1)?.date
        lastDate = date ? String(date).slice(0, 10) : undefined
      })
      // 独立排队, 切股/关闭后的日K响应不会继续级联分钟请求。
      tasks.push(async () => {
        if (lastDate) await qc.prefetchQuery({ ...klineMinuteQueryOptions(s, lastDate, true), staleTime: 30_000 })
      })
      // 分时 tab 的多日分时 + 最新分时: 切股后分时图也免 loading。
      tasks.push(() => qc.prefetchQuery({ ...klineMinuteRangeQueryOptions(s, intradayDays), staleTime: 30_000 }))
      tasks.push(() => qc.prefetchQuery({ ...klineMinuteQueryOptions(s, undefined, true), staleTime: 30_000 }))
      if (period !== '1d') {
        tasks.push(() => qc.prefetchQuery({
          ...klinePeriodQueryOptions(s, period, chartDateRange, periodDays, extColumns, includeTechnicalScores),
          staleTime: 30_000,
        }))
      }
    }
    return scheduleNeighborPrefetch(qc, symbol, tasks)
  }, [prefetchKey, symbol, chartDateRange, infoDateRange, extColumns, intradayDays, period, periodDays, includeTechnicalScores, qc, kline.isSuccess, kline.isPlaceholderData])

  // symbol 变化时重置分时相关状态，避免切股后残留旧日期。
  // 日K信息直接读 query data (切股到已预取邻股首帧即有), 无需清空或门控。
  const prevSymbol = useRef<string | null>(symbol)
  useEffect(() => {
    if (prevSymbol.current === symbol) return
    prevSymbol.current = symbol
    setSelectedBarKey(null)
    setFollowingLatest(true)
    setLinkedPrice(null)
    setRightPaneDismissed(false)
  }, [setFollowingLatest, symbol])

  const prevPeriod = useRef<KlinePeriod>(period)
  useEffect(() => {
    if (prevPeriod.current === period) return
    prevPeriod.current = period
    setSelectedBarKey(null)
    setFollowingLatest(true)
    setLinkedPrice(null)
    setRightPaneDismissed(false)
  }, [period, setFollowingLatest])

  // 目标周期数据到达后，如果此前只是用日线占位选中了日期，则回到该周期最新一根。
  useEffect(() => {
    if (resolvedRightPaneMode !== 'technical' || period === '1d' || !periodRows.length || !selectedBarKey || lockedSelectedDate != null) return
    if (!periodRows.some(row => row.date === selectedBarKey)) {
      setSelectedBarKey(null)
      setFollowingLatest(true)
    }
  }, [lockedSelectedDate, period, periodRows, resolvedRightPaneMode, selectedBarKey, setFollowingLatest])

  // 右侧开启且无选中 K 线时，自动选中最新一根；点击历史 K 线后则保持历史截面。
  useEffect(() => {
    if (showIntraday && !effectiveSelectedBarKey && selectableRows.length > 0) {
      setSelectedBarKey(selectableRows[selectableRows.length - 1].date)
    }
  }, [effectiveSelectedBarKey, selectableRows, showIntraday])

  const selectedIdx = effectiveSelectedBarKey ? selectableRows.findIndex(r => r.date === effectiveSelectedBarKey) : -1
  const prevClose = selectedIdx > 0
    ? selectableRows[selectedIdx - 1].close
    : selectableRows.length >= 2
      ? selectableRows[selectableRows.length - 2].close
      : undefined
  const selectedTradeDate = effectiveSelectedBarKey?.slice(0, 10) ?? null
  const analysisAsOf =
    effectiveSelectedBarKey ?? displayAnalysisResponse?.data_status?.data_through ?? displayAnalysisResponse?.rows.at(-1)?.date ?? null
  const latestBarKey = selectableRows.at(-1)?.date ?? null
  const canReturnLatest = effectiveSelectedBarKey != null && latestBarKey != null && effectiveSelectedBarKey !== latestBarKey
  if (!symbol) return null

  const rightPaneVisible = showIntraday && effectiveSelectedBarKey && !rightPaneDismissed
  const splitVisible = resizableSplit && rightPaneVisible
  const dailyPaneStyle = splitVisible
    ? { flex: `0 0 ${splitRatio * 100}%` }
    : undefined

  const rightPaneLabel = resolvedRightPaneMode === 'technical'
    ? '技术指标'
    : resolvedRightPaneMode === 'intraday' ? '分时图' : '右侧面板'
  // 详情页的独立滚动布局把信息条归入左栏，让右侧分析面板从同一高度开始。
  const splitInfoBar = independentPaneScroll && !infoBarOnly
  const infoBar = (
    <StockInfoBar
      symbol={symbol}
      name={name}
      stockInfo={stockInfo}
      rows={infoRows}
      assetType={assetType}
      period={period}
      onAddStrategy={onAddStrategy}
      onAddSignal={onAddSignal}
      onMonitor={onMonitor}
      inWatchlist={inWatchlist}
      onAddToWatchlist={onAddToWatchlist}
      onRemoveFromWatchlist={onRemoveFromWatchlist}
      watchlistPending={watchlistPending}
    />
  )

  return (
    <div className={`${splitInfoBar ? 'flex h-full min-h-0' : independentPaneScroll ? 'flex h-full min-h-0 flex-col' : ''} ${className ?? ''}`}>
      {!splitInfoBar && (
        <div className={independentPaneScroll ? 'shrink-0' : ''}>
          {infoBar}
        </div>
      )}

      {infoBarOnly ? null : (
      <div
        ref={splitContainerRef}
        className={`relative flex gap-3 items-stretch ${splitInfoBar || independentPaneScroll ? 'min-h-0 flex-1 overflow-hidden' : ''} ${splitDragging ? 'select-none' : ''}`}
      >
        <div
          ref={dailyPaneRef}
          className={`${dailyKlineFlex} min-w-0 ${splitInfoBar ? 'flex min-h-0 flex-col' : independentPaneScroll ? 'min-h-0 overflow-y-auto' : ''}`}
          style={dailyPaneStyle}
        >
          {splitInfoBar && <div className="shrink-0">{infoBar}</div>}
          <div
            className={splitInfoBar ? 'relative min-h-0 flex-1' : undefined}
            onPointerMove={splitInfoBar ? event => {
              const bounds = event.currentTarget.getBoundingClientRect()
              const hovered = event.clientX >= bounds.right - 16
              setChartScrollbarHovered(previous => previous === hovered ? previous : hovered)
            } : undefined}
            onPointerLeave={splitInfoBar ? () => setChartScrollbarHovered(false) : undefined}
          >
            <div
              id={dailyChartScrollId}
              ref={dailyChartScrollRef}
              tabIndex={splitInfoBar ? 0 : undefined}
              aria-label={splitInfoBar ? 'K线图滚动区域' : undefined}
              className={splitInfoBar ? 'stock-panel-chart-scroll absolute inset-0 overflow-y-auto' : undefined}
            >
              <StockDailyKChart
                symbol={symbol}
                height={height}
                dateRange={chartDateRange}
                markers={markers}
                ranges={ranges}
                priceLines={chartPriceLines}
                priceCurves={priceLevelState.priceCurves}
                highlightedKey={priceLevelState.hoveredKey}
                onHighlightChange={priceLevelState.setHoveredKey}
                priceLabelWidth={priceLevelState.priceLines.length || priceLevelState.priceCurves.length ? 110 : 0}
                showLimitMarkers={showLimitMarkers}
                showMarkerToggle={showMarkerToggle}
                linkedPrice={linkedPrice}
                onDateClick={handleDateClick}
                selectedDate={effectiveSelectedBarKey}
                onPriceDoubleClick={onPriceDoubleClick}
                visibleBars={visibleBars ?? (showIntraday ? 40 : 60)}
                extColumns={extColumns}
                refetchIntervalMs={refetchIntervalMs}
                period={period}
                periodDays={periodDays}
                addedDate={addedDate}
                includeTechnicalScores={includeTechnicalScores}
                chanlunAnalysis={resolvedRightPaneMode === 'technical' ? chanlunAnalysis : undefined}
                visibleThrough={visibleThrough}
                hideCurrentDate={hideCurrentDate}
                selectedStrategy={selectedStrategy}
                onClearStrategy={onClearStrategy}
                onAddSignal={onAddSignal}
                selectedSignals={selectedSignals}
                onClearSignals={onClearSignals}
              />
            </div>
            {splitInfoBar && (
              <ChartScrollbar
                scrollRef={dailyChartScrollRef}
                controlsId={dailyChartScrollId}
                active={chartScrollbarHovered}
              />
            )}
          </div>
        </div>

        {rightPaneVisible && (
          <div className="relative flex-1 min-h-0 min-w-0 border-l border-border pl-3">
            {resizableSplit && (
              <div
                role="separator"
                tabIndex={0}
                aria-label={`调整日K与${rightPaneLabel}宽度`}
                aria-orientation="vertical"
                aria-valuemin={MIN_SPLIT_RATIO * 100}
                aria-valuemax={MAX_SPLIT_RATIO * 100}
                aria-valuenow={Math.round(splitRatio * 100)}
                title={`拖动调整日K与${rightPaneLabel}宽度`}
                onKeyDown={handleSplitKeyDown}
                onPointerDown={handleSplitPointerDown}
                onPointerMove={handleSplitPointerMove}
                onPointerUp={handleSplitPointerUp}
                onPointerCancel={handleSplitPointerUp}
                className={`group absolute -left-2 inset-y-0 z-10 w-4 touch-none cursor-col-resize outline-none ${splitDragging ? 'text-accent' : 'text-border'}`}
              >
                <span className={`absolute inset-y-0 left-1/2 w-px transition-colors ${splitDragging ? 'bg-accent' : 'bg-border/70 group-hover:bg-accent/70'}`} />
              </div>
            )}
            <button
              type="button"
              onClick={() => setRightPaneDismissed(true)}
              className="absolute left-0 top-1/2 z-20 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-surface text-muted shadow-sm transition-colors hover:bg-elevated hover:text-foreground"
              title={`收起${rightPaneLabel}`}
              aria-label={`收起${rightPaneLabel}`}
              aria-expanded
            >
              <PanelRightClose className="h-3.5 w-3.5" />
            </button>
            <div className={independentPaneScroll ? 'h-full min-h-0 overflow-hidden' : undefined}>
            {resolvedRightPaneMode === 'intraday' && (
              <StockIntradayChart
                symbol={symbol}
                date={selectedTradeDate}
                height={height}
                prevClose={prevClose}
                onPriceHover={setLinkedPrice}
                onPriceDoubleClick={onPriceDoubleClick}
                currentPrice={rows[rows.length - 1]?.close}
                priceLines={priceLines}
                assetType={assetType}
                refetchIntervalMs={refetchIntervalMs}
              />
            )}
            {resolvedRightPaneMode === 'technical' && (
              <div className={`flex h-full min-h-0 flex-col ${analysisTab === 'ai' ? 'overflow-hidden' : 'overflow-y-auto'}`}>
                <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 px-2.5 py-1.5 text-[11px] text-muted">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span>{hideCurrentDate ? '截至 当前进度' : `截至 ${formatAnalysisAsOf(analysisAsOf, period)}`}</span>
                    {canReturnLatest && (
                      <button
                        type="button"
                        onClick={handleLatest}
                        className="text-accent transition-colors hover:text-accent/80"
                        title="回到最新 K 线"
                        aria-label="回到最新 K 线"
                      >
                        回到最新
                      </button>
                    )}
                    {analysisRefreshing ? <span>计算中…</span> : analysisSnapshot?.calculatedAt != null && <span>计算于 {formatAnalysisCalculatedAt(analysisSnapshot.calculatedAt)}</span>}
                    {analysisRefreshError && <span className="text-bear" title={analysisRefreshError.message}>计算失败，保留上次结果</span>}
                  </div>
                  <button
                    type="button"
                    onClick={() => { void recalculateAnalysis() }}
                    disabled={analysisRefreshing}
                    className="shrink-0 rounded-btn p-1 text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-wait disabled:opacity-60"
                    title="立即计算右侧分析"
                    aria-label="立即计算右侧分析"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${analysisRefreshing ? 'animate-spin' : ''}`} />
                  </button>
                </div>
                <div className="sticky top-0 z-10 shrink-0 border-b border-border/70 bg-surface">
                  <div role="tablist" aria-label="指标详情分析类型" className="grid grid-cols-2 min-[900px]:grid-cols-4">
                    {STOCK_ANALYSIS_TABS.map(tab => {
                      const active = analysisTab === tab.id
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          role="tab"
                          id={`stock-analysis-tab-${tab.id}`}
                          aria-selected={active}
                          aria-controls="stock-analysis-tabpanel"
                          onClick={() => {
                            setAnalysisTab(tab.id)
                            if (tab.id === 'levels') setLevelsRequested(true)
                          }}
                          className={`relative flex-1 px-2.5 py-2 text-xs transition-colors ${active ? 'font-medium text-accent' : 'text-muted hover:text-secondary'}`}
                        >
                          {tab.label}
                          {active && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent" />}
                        </button>
                      )
                    })}
                  </div>
                </div>
                <div
                  id="stock-analysis-tabpanel"
                  role="tabpanel"
                  aria-labelledby={`stock-analysis-tab-${analysisTab}`}
                  className={analysisTab === 'ai' ? 'flex min-h-0 flex-1 flex-col' : 'min-h-0'}
                >
                {analysisTab === 'indicator' && <>
                <StockTechnicalPanel
                  rows={displayAnalysisResponse?.rows ?? []}
                  technicalScores={displayAnalysisResponse?.technical_scores}
                  period={period}
                  selectedDate={effectiveSelectedBarKey}
                  assetType={analysisAssetType}
                  isLoading={analysisLoading}
                  error={analysisError}
                  onRetry={() => { void recalculateAnalysis() }}
                  collapsed={analysisSections.technicalCollapsed}
                  onToggleCollapsed={() => toggleAnalysisSection('technicalCollapsed')}
                />
                </>}
                {analysisTab === 'structure' && <>
                <StockChanlunPanel
                  analysis={chanlunAnalysis}
                  period={period}
                  assetType={analysisAssetType}
                  collapsed={analysisSections.chanlunCollapsed}
                  onToggleCollapsed={() => toggleAnalysisSection('chanlunCollapsed')}
                  isLoading={analysisLoading || chanlunQuery.isFetching}
                  error={analysisError ?? chanlunQuery.error}
                  onRetry={() => { void chanlunQuery.refetch() }}
                  source={chanlunSource}
                  onSourceChange={setChanlunSource}
                  multiPeriodExpanded={multiPeriodExpanded}
                  onToggleMultiPeriod={() => setMultiPeriodExpanded(value => !value)}
                  multiPeriod={multiPeriodAnalysis}
                />
                </>}
                {analysisTab === 'levels' && (
                  <div className="py-3 pr-1 text-xs">
                    {!priceLevelsEnabled ? (
                      <p className="text-muted">关键价位按日K计算，请切换到日K查看和绘制。</p>
                    ) : !priceLevelData && (priceLevelsQuery.isError || analysisError) ? (
                      <div className="text-danger" role="alert">
                        关键价位加载失败
                        <button type="button" className="ml-2 text-accent" onClick={() => { void (analysisError && !displayAnalysisResponse ? recalculateAnalysis() : priceLevelsQuery.refetch()) }}>重试</button>
                      </div>
                    ) : displayAnalysisResponse && analysisRows.length === 0 ? (
                      <p className="text-muted">暂无日K数据，请先同步行情。</p>
                    ) : !priceLevelData ? (
                      <p className="text-muted" role="status">关键价位加载中…</p>
                    ) : !hasPriceLevels ? (
                      <p className="text-muted">暂无关键价位，请先同步日K数据。</p>
                    ) : (
                      <>
                        <p className="mb-3 text-[11px] leading-relaxed text-muted">点击指标在K线图上绘制，再次点击移除。价位按当前选中的日K截面计算。</p>
                        {priceLevelsQuery.isError && <p className="mb-2 text-danger">刷新失败，保留上次价位。<button type="button" className="ml-1 text-accent" onClick={() => { void priceLevelsQuery.refetch() }}>重试</button></p>}
                        <PriceLevelControls levels={priceLevelData.levels} {...priceLevelState} />
                        {priceLevelState.activeTypes.size === 0 && <p className="mt-3 text-muted">选择上方关键价位指标后显示价位明细。</p>}
                        <LevelOverview levels={priceLevelData.levels} {...priceLevelState}
                          close={priceLevelData.close ?? undefined} assetType={analysisAssetType}
                          onHover={priceLevelState.setHoveredKey} compact />
                      </>
                    )}
                  </div>
                )}
                {analysisTab === 'ai' && (
                  <StockAiChatPanel symbol={symbol} snapshot={stockChatSnapshot} />
                )}
                </div>
              </div>
            )}
            </div>
          </div>
        )}

        {showIntraday && effectiveSelectedBarKey && rightPaneDismissed && (
          <button
            type="button"
            onClick={() => setRightPaneDismissed(false)}
            className="absolute right-0 top-1/2 z-10 flex h-7 w-7 -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-full border border-border bg-surface text-muted shadow-sm transition-colors hover:bg-elevated hover:text-foreground"
            title={`展开${rightPaneLabel}`}
            aria-label={`展开${rightPaneLabel}`}
            aria-expanded={false}
          >
            <PanelRightOpen className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      )}
    </div>
  )
}
