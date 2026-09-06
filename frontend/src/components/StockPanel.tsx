import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PanelRightOpen, X } from 'lucide-react'
import { type KlinePeriod, type KlineRow, type FinancialMetricRecord } from '@/lib/api'
import {
  DEFAULT_30M_DAYS,
  DEFAULT_INTRADAY_DAYS,
  defaultKlineRange,
  klineDailyQueryOptions,
  klineMinuteQueryOptions,
  klineMinuteRangeQueryOptions,
  klinePeriodQueryOptions,
} from '@/lib/kline'
import { StockInfoBar } from '@/components/StockInfoBar'
import { StockDailyKChart, getDefaultRange, toOHLC } from '@/components/StockDailyKChart'
import { StockIntradayChart } from '@/components/StockIntradayChart'
import { StockTechnicalPanel } from '@/components/StockTechnicalPanel'
import { StockChanlunPanel } from '@/components/StockChanlunPanel'
import { financialMetricsQueryOptions, useFinancialMetrics } from '@/lib/useFinancials'
import { useCapabilities } from '@/lib/useSharedQueries'
import type { ChartMarker, ChartPriceLine, ChartRange } from '@/components/EChartsCandlestick'
import {
  loadInfoFields,
  saveInfoFields,
  buildInfoExtColumnsParam,
  type ColumnConfig,
} from '@/lib/stock-info-fields'
import { analyzeChanlun } from '@/lib/chanlun'
import { storage, type StockPreviewAnalysisSectionsState } from '@/lib/storage'

const DEFAULT_SPLIT_RATIO = 1.4 / 2.4
const MIN_SPLIT_RATIO = 0.25
const MAX_SPLIT_RATIO = 0.75
const SPLIT_GAP_PX = 12
const DEFAULT_ANALYSIS_SECTIONS: StockPreviewAnalysisSectionsState = {
  technicalCollapsed: false,
  chanlunCollapsed: false,
}

function clampSplitRatioValue(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPLIT_RATIO
  return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, value))
}

function normalizeAnalysisSections(value: StockPreviewAnalysisSectionsState): StockPreviewAnalysisSectionsState {
  return {
    technicalCollapsed: value?.technicalCollapsed === true,
    chanlunCollapsed: value?.chanlunCollapsed === true,
  }
}

export type StockPanelRightPaneMode = 'intraday' | 'technical' | 'empty'

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
}: Props) {
  const resolvedRightPaneMode: StockPanelRightPaneMode = rightPaneMode
    ?? (showIntradayChart ? 'intraday' : 'empty')
  const [linkedPrice, setLinkedPrice] = useState<number | null>(null)
  const [selectedBarKey, setSelectedBarKey] = useState<string | null>(null)
  const [rightPaneDismissed, setRightPaneDismissed] = useState(false)
  const [splitRatio, setSplitRatio] = useState(() => clampSplitRatioValue(
    storage.stockPreviewSplitRatio.get(DEFAULT_SPLIT_RATIO),
  ))
  const [analysisSections, setAnalysisSections] = useState(() => normalizeAnalysisSections(
    storage.stockPreviewAnalysisSections.get(DEFAULT_ANALYSIS_SECTIONS),
  ))
  const [splitDragging, setSplitDragging] = useState(false)
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

  const toggleAnalysisSection = useCallback((key: keyof StockPreviewAnalysisSectionsState) => {
    setAnalysisSections(previous => {
      const next = { ...previous, [key]: !previous[key] }
      storage.stockPreviewAnalysisSections.set(next)
      return next
    })
  }, [])

  // 财务指标：仅当信息条配置含可见的财务字段且用户具备财务数据能力 (financial) 时才请求
  // 无能力时跳过请求, 避免后端抛 CapabilityDenied (403) 导致 free/starter 档弹错误提示
  const { data: caps } = useCapabilities()
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
  const kline = useQuery({ ...klineDailyQueryOptions(symbol, infoDateRange, extColumns), enabled: !!symbol })
  const rawRows: KlineRow[] = kline.data?.rows ?? []
  // OHLC 视图用于日期选中/昨收价推导 (与图表侧同口径)
  const rows = useMemo(() => toOHLC(rawRows, '1d'), [rawRows])
  // 技术面板观察与左侧 K 线完全相同的 period query; 1d 时会与上面的日K query 共享缓存。
  const periodKline = useQuery({
    ...klinePeriodQueryOptions(symbol, period, chartDateRange, periodDays, extColumns),
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
  const chanlunAnalysis = useMemo(
    () => analyzeChanlun(periodRows, selectedBarKey),
    [periodRows, selectedBarKey],
  )
  // 非日K查询尚未到达时用信息条的日线维持分栏高度，数据到达后自动切换到目标周期。
  const selectableRows = period !== '1d' && periodRows.length > 0 ? periodRows : rows
  const stockInfo = kline.data?.stock_info
  const name = kline.data?.name
  const assetType = kline.data?.asset_type

  useEffect(() => {
    if (assetType) onAssetTypeChange?.(assetType)
  }, [assetType, onAssetTypeChange])

  const handleDateClick = useCallback((date: string) => {
    const selected = period === '30m'
      ? date.replace('T', ' ').slice(0, 16)
      : date.slice(0, 10)
    setSelectedBarKey(selected)
    setRightPaneDismissed(false)
    // 兼容外部已有的分时自动打开回调，仍只传交易日。
    if (resolvedRightPaneMode === 'intraday') onSelectDate?.(selected.slice(0, 10))
  }, [onSelectDate, period, resolvedRightPaneMode])

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

  // 邻近预取: 对切股导航的左右邻股提前拉取缓存, 切股瞬间免 loading。
  // 日K/分时预取 staleTime 30s 防来回切换重复请求; 成为当前股后 useQuery(staleTime=0) 立即后台刷新,
  // SSE 也只按焦点股精准失效, 实时性不受影响。财务指标与正式查询同 staleTime, 5min 内不重复拉取。
  // prefetchKey 按内容 join: 自选页 navList 随行情 tick 重建但邻股集合通常不变, 避免 effect 每次 tick 重跑。
  const qc = useQueryClient()
  const prefetchKey = prefetchSymbols?.join(',') ?? ''
  // 守卫快速连续切股: 旧链路上异步回来的日K不再级联预取 (避免串股/浪费)
  const prefetchTickRef = useRef('')
  useEffect(() => {
    if (!prefetchKey) return
    prefetchTickRef.current = prefetchKey
    for (const s of prefetchKey.split(',')) {
      if (s === symbol) continue
      if (hasFinanceField && hasFinancialCap) {
        qc.prefetchQuery(financialMetricsQueryOptions(s))
      }
      // 分时 tab 的多日分时 + 最新分时: 切股后分时图也免 loading (与日K并行预取)
      qc.prefetchQuery({ ...klineMinuteRangeQueryOptions(s, intradayDays), staleTime: 30_000 })
      // latest 当日分时同样 live=true: 预取与渲染同读实时源 (历史日期后端忽略 live)
      qc.prefetchQuery({ ...klineMinuteQueryOptions(s, undefined, true), staleTime: 30_000 })
      // 日K用 fetchQuery (返回数据) 以便级联预取分时; 邻股预取失败静默, 不影响切股。
      if (period !== '1d') {
        qc.prefetchQuery({
          ...klinePeriodQueryOptions(s, period, chartDateRange, periodDays, extColumns),
          staleTime: 30_000,
        })
      }
      void qc.fetchQuery({ ...klineDailyQueryOptions(s, infoDateRange, extColumns), staleTime: 30_000 })
        .then((res) => {
          if (prefetchTickRef.current !== prefetchKey) return
          // 日K到货后级联预取其默认选中日的分时数据: 日K视图并排展示分时图(默认选中最后交易日)。
          const lastDate = res?.rows?.at(-1)?.date
          if (lastDate) {
            const d = String(lastDate).slice(0, 10)
            // 同上 live=true: 该日若为当日即命中实时源 (历史日期后端忽略 live)
            qc.prefetchQuery({ ...klineMinuteQueryOptions(s, d, true), staleTime: 30_000 })
          }
        })
        .catch(() => {})
    }
  }, [prefetchKey, symbol, chartDateRange, infoDateRange, extColumns, hasFinanceField, hasFinancialCap, intradayDays, period, periodDays, qc])

  // symbol 变化时重置分时相关状态，避免切股后残留旧日期。
  // 日K信息直接读 query data (切股到已预取邻股首帧即有), 无需清空或门控。
  const prevSymbol = useRef<string | null>(symbol)
  useEffect(() => {
    if (prevSymbol.current === symbol) return
    prevSymbol.current = symbol
    setSelectedBarKey(null)
    setLinkedPrice(null)
    setRightPaneDismissed(false)
  }, [symbol])

  const prevPeriod = useRef<KlinePeriod>(period)
  useEffect(() => {
    if (prevPeriod.current === period) return
    prevPeriod.current = period
    setSelectedBarKey(null)
    setLinkedPrice(null)
    setRightPaneDismissed(false)
  }, [period])

  // 目标周期数据到达后，如果此前只是用日线占位选中了日期，则回到该周期最新一根。
  useEffect(() => {
    if (resolvedRightPaneMode !== 'technical' || period === '1d' || !periodRows.length || !selectedBarKey) return
    if (!periodRows.some(row => row.date === selectedBarKey)) setSelectedBarKey(null)
  }, [period, periodRows, resolvedRightPaneMode, selectedBarKey])

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
            ranges={ranges}
            priceLines={priceLines}
            showLimitMarkers={showLimitMarkers}
            showMarkerToggle={showMarkerToggle}
            linkedPrice={linkedPrice}
            onDateClick={handleDateClick}
            onPriceDoubleClick={onPriceDoubleClick}
            visibleBars={showIntraday ? 40 : 60}
            extColumns={extColumns}
            refetchIntervalMs={refetchIntervalMs}
            period={period}
            periodDays={periodDays}
            chanlunAnalysis={resolvedRightPaneMode === 'technical' ? chanlunAnalysis : undefined}
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
                priceLines={priceLines}
                assetType={assetType}
                refetchIntervalMs={refetchIntervalMs}
              />
            )}
            {resolvedRightPaneMode === 'technical' && (
              <div className="h-full min-h-0 overflow-y-auto">
                <StockTechnicalPanel
                  rows={periodKline.data?.rows ?? []}
                  period={period}
                  selectedDate={selectedBarKey}
                  assetType={assetType}
                  isLoading={periodKline.isLoading || periodKline.isFetching && !periodKline.data}
                  error={periodKline.error}
                  onRetry={() => { void periodKline.refetch() }}
                  onLatest={() => setSelectedBarKey(selectableRows.at(-1)?.date ?? null)}
                  collapsed={analysisSections.technicalCollapsed}
                  onToggleCollapsed={() => toggleAnalysisSection('technicalCollapsed')}
                />
                <StockChanlunPanel
                  analysis={chanlunAnalysis}
                  period={period}
                  assetType={assetType}
                  collapsed={analysisSections.chanlunCollapsed}
                  onToggleCollapsed={() => toggleAnalysisSection('chanlunCollapsed')}
                  isLoading={periodKline.isLoading || periodKline.isFetching && !periodKline.data}
                  error={periodKline.error}
                />
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
