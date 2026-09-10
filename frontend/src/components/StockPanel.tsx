import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, PanelRightOpen, RefreshCw, X } from 'lucide-react'
import { type KlinePeriod, type KlineResponse, type KlineRow, type FinancialMetricRecord } from '@/lib/api'
import {
  canAutoRefreshAnalysis,
  DEFAULT_30M_DAYS,
  DEFAULT_INTRADAY_DAYS,
  defaultKlineRange,
  klineDailyQueryOptions,
  klineMinuteQueryOptions,
  klineMinuteRangeQueryOptions,
  klinePeriodQueryOptions,
  nextThirtyMinuteBoundaryAt,
} from '@/lib/kline'
import { StockInfoBar } from '@/components/StockInfoBar'
import { StockDailyKChart, getDefaultRange, toOHLC } from '@/components/StockDailyKChart'
import { StockIntradayChart } from '@/components/StockIntradayChart'
import { StockTechnicalPanel } from '@/components/StockTechnicalPanel'
import { StockChanlunPanel } from '@/components/StockChanlunPanel'
import { StockElliottPanel } from '@/components/StockElliottPanel'
import { StockPriceZonesPanel } from '@/components/StockPriceZonesPanel'
import { StockSignalRiskPanel } from '@/components/StockSignalRiskPanel'
import { financialMetricsQueryOptions, useFinancialMetrics } from '@/lib/useFinancials'
import { useCapabilities, useQuoteStatus } from '@/lib/useSharedQueries'
import { scheduleNeighborPrefetch } from '@/lib/neighborPrefetch'
import type { ChartMarker, ChartPriceBand, ChartPriceLine, ChartRange } from '@/components/EChartsCandlestick'
import {
  loadInfoFields,
  saveInfoFields,
  buildInfoExtColumnsParam,
  type ColumnConfig,
} from '@/lib/stock-info-fields'
import { analyzeChanlun, type ChanlunStructureSource } from '@/lib/chanlun'
import { analyzeElliott } from '@/lib/elliott'
import { storage, type StockPreviewAnalysisSectionsV2, type StockPreviewAnalysisSectionsV3, type StockPreviewDecisionSectionsV1 } from '@/lib/storage'
import { buildPriceZones, type PriceZone } from '@/lib/priceZones'
import { buildSignalRiskContexts, selectPreferredSignal, type SignalRiskContext } from '@/lib/signalRisk'
import { buildStockSummary } from '@/lib/stockSummary'
import { StockSummaryPanel } from '@/components/StockSummaryPanel'
import { actionSignalMarkers, buildActionSignals, compareActionSignals, type ActionSignalInput, type ActionSignalResult } from '@/lib/actionSignals'

const DEFAULT_SPLIT_RATIO = 1.4 / 2.4
const MIN_SPLIT_RATIO = 0.25
const MAX_SPLIT_RATIO = 0.75
const SPLIT_GAP_PX = 12
const CHANLUN_PERIODS: KlinePeriod[] = ['30m', '1d', '1w', '1mo']
const DAILY_CLOSE_TIME = '15:00'

function previousCalendarDate(value: string): string {
  const date = new Date(`${value}T12:00:00`)
  if (Number.isNaN(date.getTime())) return value
  date.setDate(date.getDate() - 1)
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
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
    structureCollapsed: value?.structureCollapsed ?? legacy?.structureCollapsed ?? false,
    chanlunCollapsed: value?.chanlunCollapsed === true,
    elliottCollapsed: value?.elliottCollapsed === true,
  }
}

function normalizeDecisionSections(value: StockPreviewDecisionSectionsV1 | null | undefined): StockPreviewDecisionSectionsV1 {
  return {
    version: 1,
    priceZonesCollapsed: value?.priceZonesCollapsed === true,
    signalRiskCollapsed: value?.signalRiskCollapsed === true,
    showPriceZones: value?.showPriceZones !== false,
    showInvalidationLine: value?.showInvalidationLine !== false,
  }
}

export type StockPanelRightPaneMode = 'intraday' | 'technical' | 'empty'
type StockAnalysisTab = 'indicator' | 'structure' | 'ai'

const STOCK_ANALYSIS_TABS: Array<{ id: StockAnalysisTab; label: string }> = [
  { id: 'indicator', label: '指标分析' },
  { id: 'structure', label: '结构分析' },
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
  /** 主蜡烛图周期；信息条仍使用日线最新两根，避免周期切换改变当日涨跌口径。 */
  period?: KlinePeriod
  periodDays?: number
  /** 初始可见蜡烛根数 (默认 60); 'all' = 初始适配显示全部数据 (用于全区间回放) */
  visibleBars?: number | 'all'
}

interface AnalysisSnapshot {
  contextKey: string
  comparisonKey: string
  response: KlineResponse
  comparisonResponse?: KlineResponse
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
  visibleBars,
}: Props) {
  const resolvedRightPaneMode: StockPanelRightPaneMode = rightPaneMode
    ?? (showIntradayChart ? 'intraday' : 'empty')
  const includeTechnicalScores = resolvedRightPaneMode === 'technical'
  const includeShortTermAnalysis = resolvedRightPaneMode === 'technical'
  const [linkedPrice, setLinkedPrice] = useState<number | null>(null)
  const [selectedBarKey, setSelectedBarKey] = useState<string | null>(null)
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
  const [decisionSections, setDecisionSections] = useState(() => normalizeDecisionSections(
    storage.stockPreviewDecisionSectionsV1.get(null),
  ))
  const [selectedSignalId, setSelectedSignalId] = useState<string | null>(null)
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null)
  const [splitDragging, setSplitDragging] = useState(false)
  const setFollowingLatest = useCallback((value: boolean) => {
    followsLatestRef.current = value
    setFollowsLatest(value)
  }, [])
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const dailyPaneRef = useRef<HTMLDivElement>(null)
  const splitDraggingRef = useRef(false)
  const splitRatioRef = useRef(splitRatio)
  const splitPointerOffsetRef = useRef(0)
  // 信息条指标配置提升到此层：同时供 StockInfoBar 渲染与 StockDailyKChart 请求 ext 数据
  const [fields, setFields] = useState<ColumnConfig[]>(loadInfoFields)
  const extColumns = useMemo(() => buildInfoExtColumnsParam(fields), [fields])

  const handleFieldsChange = useCallback((next: ColumnConfig[]) => {
    setFields(next)
    saveInfoFields(next)
  }, [])

  const toggleAnalysisSection = useCallback((key: keyof Omit<StockPreviewAnalysisSectionsV3, 'version'>) => {
    setAnalysisSections(previous => {
      const next = { ...previous, [key]: !previous[key] }
      storage.stockPreviewAnalysisSectionsV3.set(next)
      return next
    })
  }, [])

  const toggleDecisionSection = useCallback((key: keyof Omit<StockPreviewDecisionSectionsV1, 'version'>) => {
    setDecisionSections(previous => {
      const next = { ...previous, [key]: !previous[key] }
      storage.stockPreviewDecisionSectionsV1.set(next)
      return next
    })
  }, [])

  // 财务指标：仅当信息条配置含可见的财务字段且用户具备财务数据能力 (financial) 时才请求
  // 无能力时跳过请求, 避免后端抛 CapabilityDenied (403) 导致 free/starter 档弹错误提示
  const { data: caps } = useCapabilities()
  const { data: quoteStatus } = useQuoteStatus({
    enabled: !!symbol && resolvedRightPaneMode === 'technical',
  })
  const hasFinancialCap = !!caps?.capabilities?.['financial']
  const hasFinanceField = useMemo(
    () => fields.some(f => f.visible && f.source.type === 'builtin'
      && ['eps', 'bps', 'roe', 'pe_ttm', 'pb', 'gross_margin', 'net_margin', 'debt_ratio', 'revenue_yoy', 'net_income_yoy'].includes(f.source.key)),
    [fields],
  )
  const financials = useFinancialMetrics(hasFinanceField && hasFinancialCap ? symbol : undefined)

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
    ...klineDailyQueryOptions(symbol, infoDateRange, extColumns, includeTechnicalScores, includeShortTermAnalysis),
    enabled: !!symbol,
    refetchInterval: refetchIntervalMs,
  })
  const rawRows: KlineRow[] = kline.data?.rows ?? []
  const assetType = kline.data?.asset_type
  // OHLC 视图用于日期选中/昨收价推导 (与图表侧同口径)
  const rows = useMemo(() => toOHLC(rawRows, '1d'), [rawRows])
  // 技术面板观察与左侧 K 线完全相同的 period query; 1d 时会与上面的日K query 共享缓存。
  const periodKline = useQuery({
    ...klinePeriodQueryOptions(symbol, period, chartDateRange, periodDays, extColumns, includeTechnicalScores, includeShortTermAnalysis),
    enabled: !!symbol && (
      resolvedRightPaneMode === 'technical'
      || (resolvedRightPaneMode === 'intraday' && period !== '1d')
    ),
    refetchInterval: refetchIntervalMs,
  })
  const periodRows = useMemo(
    () => toOHLC(periodKline.data?.rows ?? [], period),
    [period, periodKline.data?.rows],
  )
  const comparisonPeriod: KlinePeriod | null = period === '1d' ? '30m' : period === '30m' ? '1d' : null
  const comparisonEndDate = selectedBarKey?.slice(0, 10) ?? chartDateRange.end
  const comparisonRange = useMemo(() => {
    const endDate = new Date(`${comparisonEndDate}T12:00:00`)
    return defaultKlineRange(
      comparisonPeriod ?? '1d',
      Number.isNaN(endDate.getTime()) ? new Date() : endDate,
      periodDays,
    )
  }, [comparisonEndDate, comparisonPeriod, periodDays])
  const comparisonKline = useQuery({
    ...klinePeriodQueryOptions(symbol, comparisonPeriod ?? '1d', comparisonRange, periodDays, extColumns, true, includeShortTermAnalysis),
    enabled: !!symbol && resolvedRightPaneMode === 'technical' && comparisonPeriod != null,
    staleTime: 30_000,
  })
  const refetchPeriod = periodKline.refetch
  const refetchComparison = comparisonKline.refetch
  const analysisContextKey = `${symbol}|${resolvedRightPaneMode}|${period}|${chartDateRange.start}|${chartDateRange.end}|${periodDays}|${extColumns ?? ''}|${includeTechnicalScores}|${includeShortTermAnalysis}`
  const comparisonSnapshotKey = `${comparisonPeriod ?? 'none'}|${comparisonRange.start}|${comparisonRange.end}|${selectedBarKey ?? ''}`
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
        comparisonKey: comparisonSnapshotKey,
        response: liveResponse,
        calculatedAt: Date.now(),
      }
    })
  }, [analysisContextKey, comparisonSnapshotKey, periodKline.data, periodKline.isPlaceholderData, resolvedRightPaneMode])

  const analysisResponse = analysisSnapshot?.contextKey === analysisContextKey
    ? analysisSnapshot.response
    : undefined
  const analysisComparisonResponse = analysisSnapshot?.contextKey === analysisContextKey
    && analysisSnapshot.comparisonKey === comparisonSnapshotKey
    ? analysisSnapshot.comparisonResponse
    : undefined
  const analysisRows = useMemo(
    () => toOHLC(analysisResponse?.rows ?? [], period),
    [analysisResponse?.rows, period],
  )
  const analysisAssetType = analysisResponse?.asset_type ?? assetType
  const analysisLoading = !analysisResponse && (periodKline.isLoading || periodKline.isFetching)
  const analysisError = analysisRefreshError ?? periodKline.error

  const chanlunAnalysis = useMemo(
    () => analyzeChanlun(analysisRows, selectedBarKey, { period, source: chanlunSource }),
    [analysisRows, chanlunSource, period, selectedBarKey],
  )
  const elliottAnalysis = useMemo(
    () => analyzeElliott(analysisRows, period, selectedBarKey),
    [analysisRows, period, selectedBarKey],
  )
  const priceZones: PriceZone[] = useMemo(
    () => buildPriceZones(chanlunAnalysis),
    [chanlunAnalysis],
  )
  const signalRiskContexts: SignalRiskContext[] = useMemo(
    () => buildSignalRiskContexts(chanlunAnalysis.candidateSignals, priceZones, chanlunAnalysis.currentPrice),
    [chanlunAnalysis.candidateSignals, chanlunAnalysis.currentPrice, priceZones],
  )
  const preferredSignal = useMemo(
    () => selectPreferredSignal(signalRiskContexts),
    [signalRiskContexts],
  )
  const selectedSignal = useMemo(
    () => signalRiskContexts.find(context => context.signal.id === selectedSignalId) ?? preferredSignal,
    [preferredSignal, selectedSignalId, signalRiskContexts],
  )
  const actionInput = useMemo<ActionSignalInput | null>(() => {
    if (period !== '1d' && period !== '30m') return null
    return {
      symbol,
      assetType: analysisAssetType,
      period,
      rows: analysisRows,
      technicalScores: analysisResponse?.technical_scores,
      shortTermAnalysis: analysisResponse?.short_term_analysis,
      dataStatus: analysisResponse?.data_status,
      dataSource: analysisResponse?.source,
      selectedDate: selectedBarKey,
    }
  }, [analysisAssetType, analysisResponse, analysisRows, period, selectedBarKey, symbol])
  const actionInputKey = `${symbol}|${period}|${chartDateRange.start}|${chartDateRange.end}|${selectedBarKey ?? ''}|${analysisSnapshot?.calculatedAt ?? 0}|${analysisRows.length}`
  const actionContextKey = analysisContextKey
  const actionSnapshotKey = `${analysisContextKey}|${selectedBarKey ?? ''}`
  const actionWorkerRef = useRef<Worker | null>(null)
  const actionWorkerRequestRef = useRef(0)
  const actionResultCacheRef = useRef(new Map<string, ActionSignalResult>())
  const [workerAction, setWorkerAction] = useState<{ key: string; contextKey: string; requestId: number; result: ActionSignalResult } | null>(null)
  useEffect(() => {
    const requestId = actionWorkerRequestRef.current + 1
    actionWorkerRequestRef.current = requestId
    if (!actionInput) {
      setWorkerAction(null)
      return
    }
    const resolveActionResult = (result: ActionSignalResult) => {
      if (result.status === 'stale') {
        const previous = actionResultCacheRef.current.get(actionSnapshotKey)
        if (previous) {
          return {
            ...previous,
            status: 'stale' as const,
            dataStatus: 'stale' as const,
            reason: '当前为过期快照，保留上一份有效行动信号，不确认新的行动信号。',
          }
        }
      } else if (result.status === 'ready' || result.status === 'provisional') {
        const cache = actionResultCacheRef.current
        cache.set(actionSnapshotKey, result)
        if (cache.size > 20) {
          const oldestKey = cache.keys().next().value
          if (typeof oldestKey === 'string') cache.delete(oldestKey)
        }
      }
      return result
    }
    let worker = actionWorkerRef.current
    try {
      if (!worker) {
        worker = new Worker(new URL('../lib/actionSignals.worker.ts', import.meta.url), { type: 'module' })
        actionWorkerRef.current = worker
      }
    } catch {
      setWorkerAction({ key: actionInputKey, contextKey: actionContextKey, requestId, result: resolveActionResult(buildActionSignals(actionInput)) })
      return
    }
    const handleMessage = (event: MessageEvent<{ requestId: number; result: ActionSignalResult }>) => {
      if (event.data.requestId !== requestId || actionWorkerRequestRef.current !== requestId) return
      setWorkerAction({ key: actionInputKey, contextKey: actionContextKey, requestId, result: resolveActionResult(event.data.result) })
    }
    const handleError = () => {
      if (actionWorkerRequestRef.current !== requestId) return
      setWorkerAction({ key: actionInputKey, contextKey: actionContextKey, requestId, result: resolveActionResult(buildActionSignals(actionInput)) })
    }
    worker.addEventListener('message', handleMessage)
    worker.addEventListener('error', handleError)
    worker.postMessage({ requestId, input: actionInput })
    return () => {
      worker?.removeEventListener('message', handleMessage)
      worker?.removeEventListener('error', handleError)
    }
  }, [actionContextKey, actionInput, actionInputKey, actionSnapshotKey])
  useEffect(() => () => {
    actionWorkerRef.current?.terminate()
    actionWorkerRef.current = null
  }, [])
  const actionSignals = useMemo(
    () => {
      if (!actionInput || !workerAction) return null
      // 快照或历史 K 线点选会触发下一次 Worker 计算。保留同一标的、周期和窗口
      // 的上一份结果，避免计算空窗让行动卡在新旧两套摘要之间闪烁。
      if (workerAction.key === actionInputKey || workerAction.contextKey === actionContextKey) return workerAction.result
      return null
    },
    [actionContextKey, actionInput, actionInputKey, workerAction],
  )
  const comparisonRows = useMemo(
    () => comparisonPeriod ? toOHLC(analysisComparisonResponse?.rows ?? [], comparisonPeriod) : [],
    [analysisComparisonResponse?.rows, comparisonPeriod],
  )
  const comparisonSelectedDate = useMemo(() => {
    if (!selectedBarKey || !comparisonPeriod) return null
    const selectedDay = selectedBarKey.slice(0, 10)
    if (period === '30m' && comparisonPeriod === '1d' && selectedBarKey.slice(11, 16) < DAILY_CLOSE_TIME) {
      return previousCalendarDate(selectedDay)
    }
    return comparisonPeriod === '30m' ? `${selectedDay} 23:59` : selectedDay
  }, [comparisonPeriod, period, selectedBarKey])
  const comparisonActionSignals = useMemo(() => {
    if (!comparisonPeriod) return null
    return buildActionSignals({
      symbol,
      assetType: analysisAssetType,
      period: comparisonPeriod,
      rows: comparisonRows,
      technicalScores: analysisComparisonResponse?.technical_scores,
      shortTermAnalysis: analysisComparisonResponse?.short_term_analysis,
      dataStatus: analysisComparisonResponse?.data_status,
      dataSource: analysisComparisonResponse?.source,
      selectedDate: comparisonSelectedDate,
    })
  }, [analysisAssetType, analysisComparisonResponse, comparisonPeriod, comparisonRows, comparisonSelectedDate, symbol])
  const actionComparison = useMemo(
    () => actionSignals ? compareActionSignals(actionSignals, comparisonActionSignals) : null,
    [actionSignals, comparisonActionSignals],
  )
  const actionMarkers = useMemo(
    () => actionSignals ? actionSignalMarkers(actionSignals) : [],
    [actionSignals],
  )
  const recalculateAnalysis = useCallback(async () => {
    const requestId = analysisRefreshRequestRef.current + 1
    analysisRefreshRequestRef.current = requestId
    setAnalysisRefreshing(true)
    setAnalysisRefreshError(null)
    try {
      const [primaryResult, comparisonResult] = await Promise.all([
        refetchPeriod(),
        comparisonPeriod ? refetchComparison() : Promise.resolve(null),
      ])
      if (analysisRefreshRequestRef.current !== requestId) return
      if (primaryResult.error || !primaryResult.data) {
        throw primaryResult.error ?? new Error('当前周期行情加载失败，无法计算分析。')
      }

      const comparisonError = comparisonResult?.error ?? null
      const comparisonResponse = comparisonError ? undefined : comparisonResult?.data
      const calculatedAt = Date.now()
      setAnalysisSnapshot(previous => {
        const previousComparison = previous?.contextKey === analysisContextKey
          && previous.comparisonKey === comparisonSnapshotKey
          ? previous.comparisonResponse
          : undefined
        return {
          contextKey: analysisContextKey,
          comparisonKey: comparisonSnapshotKey,
          response: primaryResult.data!,
          comparisonResponse: comparisonResponse ?? previousComparison,
          calculatedAt,
        }
      })
      if (followsLatestRef.current) {
        const latestKey = primaryResult.data.rows.at(-1)?.date
        if (latestKey) setSelectedBarKey(latestKey)
      }
      setAnalysisRefreshError(comparisonError)
    } catch (error) {
      if (analysisRefreshRequestRef.current === requestId) {
        setAnalysisRefreshError(error instanceof Error ? error : new Error('分析计算失败，请稍后重试。'))
      }
    } finally {
      if (analysisRefreshRequestRef.current === requestId) setAnalysisRefreshing(false)
    }
  }, [analysisContextKey, comparisonPeriod, comparisonSnapshotKey, refetchComparison, refetchPeriod])

  useEffect(() => {
    const comparisonResponse = comparisonKline.data
    if (!analysisResponse || !comparisonResponse || comparisonKline.isPlaceholderData) return
    setAnalysisSnapshot(previous => {
      if (!previous || previous.contextKey !== analysisContextKey) return previous
      if (previous.comparisonKey === comparisonSnapshotKey && previous.comparisonResponse === comparisonResponse) return previous
      return { ...previous, comparisonKey: comparisonSnapshotKey, comparisonResponse }
    })
  }, [analysisContextKey, analysisResponse, comparisonKline.data, comparisonKline.isPlaceholderData, comparisonSnapshotKey])

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

  const summaryRows = analysisResponse?.rows ?? []
  const stockSummary = useMemo(
    () => buildStockSummary({
      symbol,
      name: analysisResponse?.name ?? kline.data?.name,
      assetType: analysisAssetType,
      period,
      rows: summaryRows,
      technicalScores: analysisResponse?.technical_scores,
      shortTermAnalysis: analysisResponse?.short_term_analysis,
      dataStatus: analysisResponse?.data_status,
      dataSource: analysisResponse?.source,
      selectedBarKey,
      chanlun: chanlunAnalysis,
      elliott: elliottAnalysis,
      priceZones,
      signalRiskContexts,
      preferredSignal,
      actionSignals,
      actionComparison,
    }),
    [
      symbol,
      analysisResponse?.name,
      kline.data?.name,
      analysisAssetType,
      period,
      summaryRows,
      analysisResponse?.technical_scores,
      analysisResponse?.data_status,
      analysisResponse?.source,
      selectedBarKey,
      chanlunAnalysis,
      elliottAnalysis,
      priceZones,
      signalRiskContexts,
      preferredSignal,
      actionSignals,
      actionComparison,
      analysisResponse?.short_term_analysis,
    ],
  )
  const priceBands: ChartPriceBand[] = useMemo(() => {
    const shortTerm = analysisResponse?.short_term_analysis
    if (shortTerm) {
      const supports = [...(shortTerm.zones.support ?? [])].sort((a, b) => a.distance_pct - b.distance_pct)
      const resistances = [...(shortTerm.zones.resistance ?? [])].sort((a, b) => a.distance_pct - b.distance_pct)
      const zones = [...supports, ...resistances]
      return zones.map(zone => {
        const support = zone.id.startsWith('support')
        const rank = (support ? supports : resistances).findIndex(item => item.id === zone.id) + 1
        const highlighted = selectedZoneId === zone.id
        return {
          low: zone.low,
          high: zone.high,
          label: support ? `S${rank}` : `R${rank}`,
          color: highlighted ? 'rgba(59,130,246,0.16)' : support ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
          borderColor: highlighted ? '#3B82F6' : support ? 'rgba(34,197,94,0.48)' : 'rgba(239,68,68,0.48)',
        }
      })
    }
    const supports = priceZones.filter(zone => zone.side === 'support').sort((a, b) => (a.distancePct ?? Infinity) - (b.distancePct ?? Infinity))
    const resistances = priceZones.filter(zone => zone.side === 'resistance').sort((a, b) => (a.distancePct ?? Infinity) - (b.distancePct ?? Infinity))
    const highlightedZoneIds = new Set([
      selectedZoneId,
      selectedSignal?.target1?.id,
      selectedSignal?.target2?.id,
    ].filter((id): id is string => !!id))
    return priceZones.map(zone => {
      const rank = zone.side === 'support' ? supports.findIndex(item => item.id === zone.id) + 1 : zone.side === 'resistance' ? resistances.findIndex(item => item.id === zone.id) + 1 : 0
      return {
        low: zone.low,
        high: zone.high,
        label: zone.side === 'support' ? `S${rank}` : zone.side === 'resistance' ? `R${rank}` : '现价区',
        color: highlightedZoneIds.has(zone.id) ? 'rgba(59,130,246,0.16)' : zone.side === 'support' ? 'rgba(34,197,94,0.08)' : zone.side === 'resistance' ? 'rgba(239,68,68,0.08)' : 'rgba(59,130,246,0.08)',
        borderColor: highlightedZoneIds.has(zone.id) ? '#3B82F6' : zone.side === 'support' ? 'rgba(34,197,94,0.48)' : zone.side === 'resistance' ? 'rgba(239,68,68,0.48)' : 'rgba(59,130,246,0.48)',
      }
    })
  }, [analysisResponse?.short_term_analysis, priceZones, selectedSignal, selectedZoneId])
  const decisionPriceLines: ChartPriceLine[] = useMemo(() => {
    if (!selectedSignal) return []
    const lines: ChartPriceLine[] = []
    if (decisionSections.showInvalidationLine && selectedSignal.invalidation != null) {
      lines.push({
        value: selectedSignal.invalidation,
        label: '结构失效',
        color: selectedSignal.direction === 'buy' ? '#EF4444' : '#22C55E',
      })
    }
    return lines
  }, [decisionSections.showInvalidationLine, selectedSignal])
  const chartPriceLines = useMemo(
    () => [...(priceLines ?? []), ...decisionPriceLines],
    [decisionPriceLines, priceLines],
  )
  // 非日K查询尚未到达时用信息条的日线维持分栏高度，数据到达后自动切换到目标周期。
  const selectableRows = period !== '1d' && periodRows.length > 0 ? periodRows : rows
  const stockInfo = kline.data?.stock_info
  const name = kline.data?.name

  const multiObservationEnd = selectedBarKey?.slice(0, 10) ?? chartDateRange.end
  const multiPeriodQueries = useQueries({
    queries: CHANLUN_PERIODS.map(candidatePeriod => {
      const endDate = new Date(`${multiObservationEnd}T12:00:00`)
      const range = defaultKlineRange(candidatePeriod, Number.isNaN(endDate.getTime()) ? new Date() : endDate)
      return {
        ...klinePeriodQueryOptions(symbol, candidatePeriod, range, periodDays, extColumns, true),
        enabled: multiPeriodExpanded && !!symbol && (candidatePeriod === '1d' || assetType !== 'index'),
        staleTime: 30_000,
      }
    }),
  })
  const multiPeriodAnalysis = useMemo(() => CHANLUN_PERIODS.map((candidatePeriod, index) => {
    const query = multiPeriodQueries[index]
    const candidateRows = toOHLC(query.data?.rows ?? [], candidatePeriod)
    return {
      period: candidatePeriod,
      analysis: query.data ? analyzeChanlun(candidateRows, null, { period: candidatePeriod, source: chanlunSource }) : undefined,
      isLoading: query.isLoading || query.isFetching && !query.data,
      error: query.error,
    }
  }), [
    chanlunSource,
    multiPeriodQueries[0].data, multiPeriodQueries[0].error, multiPeriodQueries[0].isFetching, multiPeriodQueries[0].isLoading,
    multiPeriodQueries[1].data, multiPeriodQueries[1].error, multiPeriodQueries[1].isFetching, multiPeriodQueries[1].isLoading,
    multiPeriodQueries[2].data, multiPeriodQueries[2].error, multiPeriodQueries[2].isFetching, multiPeriodQueries[2].isLoading,
    multiPeriodQueries[3].data, multiPeriodQueries[3].error, multiPeriodQueries[3].isFetching, multiPeriodQueries[3].isLoading,
  ])

  useEffect(() => {
    if (assetType) onAssetTypeChange?.(assetType)
  }, [assetType, onAssetTypeChange])

  const handleDateClick = useCallback((date: string) => {
    const selected = period === '30m'
      ? date.replace('T', ' ').slice(0, 16)
      : date.slice(0, 10)
    setSelectedBarKey(selected)
    setFollowingLatest(selected === selectableRows.at(-1)?.date)
    setRightPaneDismissed(false)
    // 兼容外部已有的分时自动打开回调，仍只传交易日。
    if (resolvedRightPaneMode === 'intraday') onSelectDate?.(selected.slice(0, 10))
  }, [onSelectDate, period, resolvedRightPaneMode, selectableRows, setFollowingLatest])

  const handleLatest = useCallback(() => {
    const latestKey = selectableRows.at(-1)?.date ?? null
    if (!latestKey) return
    setFollowingLatest(true)
    setSelectedBarKey(latestKey)
  }, [selectableRows, setFollowingLatest])

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

  const handleSummaryFocus = useCallback((section: 'technical' | 'structure' | 'levels' | 'risk') => {
    if (section === 'technical') {
      setAnalysisTab('indicator')
      setAnalysisSections(previous => ({ ...previous, technicalCollapsed: false }))
      return
    }
    setAnalysisTab('structure')
    if (section === 'structure') {
      setAnalysisSections(previous => ({ ...previous, structureCollapsed: false, chanlunCollapsed: false }))
      return
    }
    if (section === 'levels') {
      setDecisionSections(previous => ({ ...previous, priceZonesCollapsed: false }))
      return
    }
    setDecisionSections(previous => ({ ...previous, signalRiskCollapsed: false }))
  }, [])

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
  // SSE 也只按焦点股精准失效, 实时性不受影响。财务指标与正式查询同 staleTime, 5min 内不重复拉取。
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
          ...klineDailyQueryOptions(s, infoDateRange, extColumns, includeTechnicalScores, includeShortTermAnalysis),
          staleTime: 30_000,
        })
        const date = res?.rows?.at(-1)?.date
        lastDate = date ? String(date).slice(0, 10) : undefined
      })
      // 独立排队, 切股/关闭后的日K响应不会继续级联分钟请求。
      tasks.push(async () => {
        if (lastDate) await qc.prefetchQuery({ ...klineMinuteQueryOptions(s, lastDate, true), staleTime: 30_000 })
      })
      if (hasFinanceField && hasFinancialCap) {
        tasks.push(() => qc.prefetchQuery(financialMetricsQueryOptions(s)))
      }
      // 分时 tab 的多日分时 + 最新分时: 切股后分时图也免 loading。
      tasks.push(() => qc.prefetchQuery({ ...klineMinuteRangeQueryOptions(s, intradayDays), staleTime: 30_000 }))
      tasks.push(() => qc.prefetchQuery({ ...klineMinuteQueryOptions(s, undefined, true), staleTime: 30_000 }))
      if (period !== '1d') {
        tasks.push(() => qc.prefetchQuery({
          ...klinePeriodQueryOptions(s, period, chartDateRange, periodDays, extColumns, includeTechnicalScores, includeShortTermAnalysis),
          staleTime: 30_000,
        }))
      }
    }
    return scheduleNeighborPrefetch(qc, symbol, tasks)
  }, [prefetchKey, symbol, chartDateRange, infoDateRange, extColumns, hasFinanceField, hasFinancialCap, intradayDays, period, periodDays, includeTechnicalScores, includeShortTermAnalysis, qc, kline.isSuccess, kline.isPlaceholderData])

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
    setSelectedSignalId(null)
    setSelectedZoneId(null)
  }, [setFollowingLatest, symbol])

  const prevPeriod = useRef<KlinePeriod>(period)
  useEffect(() => {
    if (prevPeriod.current === period) return
    prevPeriod.current = period
    setSelectedBarKey(null)
    setFollowingLatest(true)
    setLinkedPrice(null)
    setRightPaneDismissed(false)
    setSelectedSignalId(null)
    setSelectedZoneId(null)
  }, [period, setFollowingLatest])

  useEffect(() => {
    setSelectedSignalId(null)
    setSelectedZoneId(null)
  }, [chanlunSource])

  // 目标周期数据到达后，如果此前只是用日线占位选中了日期，则回到该周期最新一根。
  useEffect(() => {
    if (resolvedRightPaneMode !== 'technical' || period === '1d' || !periodRows.length || !selectedBarKey) return
    if (!periodRows.some(row => row.date === selectedBarKey)) {
      setSelectedBarKey(null)
      setFollowingLatest(true)
    }
  }, [period, periodRows, resolvedRightPaneMode, selectedBarKey, setFollowingLatest])

  // 右侧开启且无选中 K 线时，自动选中最新一根；点击历史 K 线后则保持历史截面。
  useEffect(() => {
    if (showIntraday && !selectedBarKey && selectableRows.length > 0) {
      setSelectedBarKey(selectableRows[selectableRows.length - 1].date)
    }
  }, [selectableRows, selectedBarKey, showIntraday])

  const selectedIdx = selectedBarKey ? selectableRows.findIndex(r => r.date === selectedBarKey) : -1
  const prevClose = selectedIdx > 0
    ? selectableRows[selectedIdx - 1].close
    : selectableRows.length >= 2
      ? selectableRows[selectableRows.length - 2].close
      : undefined
  const selectedTradeDate = selectedBarKey?.slice(0, 10) ?? null
  if (!symbol) return null

  const rightPaneVisible = showIntraday && selectedBarKey && !rightPaneDismissed
  const splitVisible = resizableSplit && rightPaneVisible
  const dailyPaneStyle = splitVisible
    ? { flex: `0 0 ${splitRatio * 100}%` }
    : undefined

  // 财务指标最新一期（metrics 按 period_end 排序，取首项）
  const financialMetrics: FinancialMetricRecord | undefined = financials.data?.data?.[0]
  const rightPaneLabel = resolvedRightPaneMode === 'technical'
    ? '技术指标'
    : resolvedRightPaneMode === 'intraday' ? '分时图' : '右侧面板'

  return (
    <div className={`${independentPaneScroll ? 'flex h-full min-h-0 flex-col' : ''} ${className ?? ''}`}>
      <div className={independentPaneScroll ? 'shrink-0' : ''}>
        <StockInfoBar
          symbol={symbol}
          name={name}
          stockInfo={stockInfo}
          rows={rawRows}
          assetType={assetType}
          fields={fields}
          onFieldsChange={handleFieldsChange}
          financialMetrics={financialMetrics}
          onMonitor={onMonitor}
          inWatchlist={inWatchlist}
          onAddToWatchlist={onAddToWatchlist}
          onRemoveFromWatchlist={onRemoveFromWatchlist}
          watchlistPending={watchlistPending}
        />
      </div>

      {infoBarOnly ? null : (
      <div
        ref={splitContainerRef}
        className={`relative flex gap-3 items-stretch ${independentPaneScroll ? 'min-h-0 flex-1 overflow-hidden' : ''} ${splitDragging ? 'select-none' : ''}`}
      >
        <div
          ref={dailyPaneRef}
          className={`${dailyKlineFlex} min-w-0 ${independentPaneScroll ? 'min-h-0 overflow-y-auto' : ''}`}
          style={dailyPaneStyle}
        >
          <StockDailyKChart
            symbol={symbol}
            height={height}
            dateRange={chartDateRange}
            markers={markers}
            actionMarkers={actionMarkers}
            ranges={ranges}
            priceBands={decisionSections.showPriceZones ? priceBands : undefined}
            priceLines={chartPriceLines}
            showLimitMarkers={showLimitMarkers}
            showMarkerToggle={showMarkerToggle}
            linkedPrice={linkedPrice}
            onDateClick={handleDateClick}
            onPriceDoubleClick={onPriceDoubleClick}
            visibleBars={visibleBars ?? (showIntraday ? 40 : 60)}
            extColumns={extColumns}
            refetchIntervalMs={refetchIntervalMs}
            period={period}
            periodDays={periodDays}
            includeTechnicalScores={includeTechnicalScores}
            includeShortTermAnalysis={includeShortTermAnalysis}
            chanlunAnalysis={resolvedRightPaneMode === 'technical' ? chanlunAnalysis : undefined}
            elliottAnalysis={resolvedRightPaneMode === 'technical' ? elliottAnalysis : undefined}
          />
        </div>

        {rightPaneVisible && (
          <div className={`relative flex-1 min-h-0 min-w-0 border-l border-border pl-3 ${independentPaneScroll ? 'overflow-hidden' : ''}`}>
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
              onClick={() => setRightPaneDismissed(true)}
              className="absolute -left-1.5 -top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-surface text-muted shadow-sm transition-colors hover:text-foreground hover:bg-elevated"
              title={`收起${rightPaneLabel}`}
              aria-label={`收起${rightPaneLabel}`}
            >
              <X className="h-3 w-3" />
            </button>
            {resolvedRightPaneMode === 'intraday' && (
              <StockIntradayChart
                symbol={symbol}
                date={selectedTradeDate}
                height={height}
                prevClose={prevClose}
                onPriceHover={setLinkedPrice}
                onPriceDoubleClick={onPriceDoubleClick}
                currentPrice={rows[rows.length - 1]?.close}
                priceLines={chartPriceLines}
                assetType={assetType}
                refetchIntervalMs={refetchIntervalMs}
              />
            )}
            {resolvedRightPaneMode === 'technical' && (
              <div className="h-full min-h-0 overflow-y-auto">
                <div className="flex items-center justify-between gap-2 border-b border-border/70 px-2.5 py-1.5 text-[13px] text-muted">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span>截至 {formatAnalysisAsOf(stockSummary.context.asOf, period)}</span>
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
                <div className="sticky top-0 z-10 border-b border-border/70 bg-surface">
                  <div role="tablist" aria-label="指标详情分析类型" className="flex items-stretch">
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
                          onClick={() => setAnalysisTab(tab.id)}
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
                  className="min-h-0"
                >
                {analysisTab === 'indicator' && <>
                <StockSummaryPanel
                  snapshot={stockSummary}
                  onSelectZone={zone => setSelectedZoneId(current => current === zone.id ? null : zone.id)}
                  onSelectSignal={setSelectedSignalId}
                  onFocusSection={handleSummaryFocus}
                  onLatest={handleLatest}
                  isLoading={analysisLoading}
                  error={analysisError}
                  onRetry={() => { void recalculateAnalysis() }}
                />
                <StockTechnicalPanel
                  rows={analysisResponse?.rows ?? []}
                  technicalScores={analysisResponse?.technical_scores}
                  shortTermAnalysis={analysisResponse?.short_term_analysis}
                  period={period}
                  selectedDate={selectedBarKey}
                  assetType={analysisAssetType}
                  isLoading={analysisLoading}
                  error={analysisError}
                  onRetry={() => { void recalculateAnalysis() }}
                  onLatest={handleLatest}
                  collapsed={analysisSections.technicalCollapsed}
                  onToggleCollapsed={() => toggleAnalysisSection('technicalCollapsed')}
                />
                </>}
                {analysisTab === 'structure' && <>
                <section className="border-b border-border/70">
                  <div className={`flex shrink-0 items-start justify-between px-2.5 py-2 ${analysisSections.structureCollapsed ? '' : 'border-b border-border/70'}`}>
                    <div className="flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#8B5CF6]" />
                      <span className="text-xs font-medium text-foreground">结构分析</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleAnalysisSection('structureCollapsed')}
                      className="rounded-btn p-1 text-muted transition-colors hover:bg-elevated hover:text-foreground"
                      title={analysisSections.structureCollapsed ? '展开结构分析' : '收起结构分析'}
                      aria-label={analysisSections.structureCollapsed ? '展开结构分析' : '收起结构分析'}
                      aria-expanded={!analysisSections.structureCollapsed}
                    >
                      <ChevronDown className={`h-3.5 w-3.5 transition-transform ${analysisSections.structureCollapsed ? '-rotate-90' : ''}`} />
                    </button>
                  </div>
                  {!analysisSections.structureCollapsed && (
                    <>
                      <StockChanlunPanel
                        analysis={chanlunAnalysis}
                        period={period}
                        assetType={analysisAssetType}
                        collapsed={analysisSections.chanlunCollapsed}
                        onToggleCollapsed={() => toggleAnalysisSection('chanlunCollapsed')}
                        isLoading={analysisLoading}
                        error={analysisError}
                        source={chanlunSource}
                        onSourceChange={setChanlunSource}
                        multiPeriodExpanded={multiPeriodExpanded}
                        onToggleMultiPeriod={() => setMultiPeriodExpanded(value => !value)}
                        multiPeriod={multiPeriodAnalysis}
                      />
                      <StockElliottPanel
                        symbol={symbol}
                        rows={analysisRows}
                        period={period}
                        assetType={analysisAssetType}
                        analysis={elliottAnalysis}
                        collapsed={analysisSections.elliottCollapsed}
                        onToggleCollapsed={() => toggleAnalysisSection('elliottCollapsed')}
                      />
                    </>
                  )}
                </section>
                <StockPriceZonesPanel
                  analysis={chanlunAnalysis}
                  zones={priceZones}
                  shortTermAnalysis={analysisResponse?.short_term_analysis}
                  assetType={analysisAssetType}
                  collapsed={decisionSections.priceZonesCollapsed}
                  onToggleCollapsed={() => toggleDecisionSection('priceZonesCollapsed')}
                  showZones={decisionSections.showPriceZones}
                  onToggleShowZones={() => toggleDecisionSection('showPriceZones')}
                  selectedZoneId={selectedZoneId}
                  onSelectZone={zone => setSelectedZoneId(current => current === zone.id ? null : zone.id)}
                />
                <StockSignalRiskPanel
                  contexts={signalRiskContexts}
                  period={period}
                  assetType={analysisAssetType}
                  collapsed={decisionSections.signalRiskCollapsed}
                  onToggleCollapsed={() => toggleDecisionSection('signalRiskCollapsed')}
                  showInvalidationLine={decisionSections.showInvalidationLine}
                  onToggleShowInvalidationLine={() => toggleDecisionSection('showInvalidationLine')}
                  selectedSignalId={selectedSignalId}
                  onSelectSignal={setSelectedSignalId}
                />
                </>}
                {analysisTab === 'ai' && <div className="min-h-[320px]" />}
                </div>
              </div>
            )}
          </div>
        )}

        {showIntraday && selectedBarKey && rightPaneDismissed && (
          <button
            type="button"
            onClick={() => setRightPaneDismissed(false)}
            className="absolute right-0 top-1/2 z-10 flex h-7 w-7 -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-full border border-border bg-surface text-muted shadow-sm transition-colors hover:bg-elevated hover:text-foreground"
            title={`展开${rightPaneLabel}`}
            aria-label={`展开${rightPaneLabel}`}
          >
            <PanelRightOpen className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      )}
    </div>
  )
}
