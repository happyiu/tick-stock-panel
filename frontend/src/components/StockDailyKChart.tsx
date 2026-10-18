import { useCallback, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, Check, Layers, Loader2, Settings2, X } from 'lucide-react'
import { api, type KlinePeriod, type KlineRow } from '@/lib/api'
import type { ChanlunAnalysis } from '@/lib/chanlun'
import { DEFAULT_30M_DAYS, defaultKlineRange, filterKlineRowsThrough, klinePeriodQueryOptions, normalizeKlineBarKey } from '@/lib/kline'
import { useChartIndicatorSelection } from '@/lib/useChartIndicators'
import { QK } from '@/lib/queryKeys'
import type { ChartSignalSelection as ChartSignalSelectionModel } from '@/lib/signals'
import { storage, type StockPreviewChanlunOverlayConfig } from '@/lib/storage'
import { ChartIndicatorMenu } from './ChartIndicatorMenu'
import {
  KLineCandlestick,
  type ChartMarker,
  type ChartPriceLine,
  type CandlestickProps,
  type ChartRange,
  type OHLC,
} from '@/components/KLineCandlestick'

const SUB_INFO_H = 16
const SUB_GAP = 4
const DEFAULT_CHANLUN_OVERLAY: StockPreviewChanlunOverlayConfig = {
  enabled: true,
  fractals: false,
  strokes: true,
  segments: false,
  centers: true,
  candidates: true,
  divergences: false,
}

function normalizeChanlunOverlay(config: StockPreviewChanlunOverlayConfig): StockPreviewChanlunOverlayConfig {
  return {
    enabled: config?.enabled !== false,
    fractals: config?.fractals === true,
    strokes: config?.strokes !== false,
    segments: config?.segments === true,
    centers: config?.centers !== false,
    candidates: config?.candidates !== false,
    divergences: config?.divergences === true,
  }
}

interface Props {
  indicatorSelection?: ReturnType<typeof useChartIndicatorSelection>
  symbol: string
  height?: number
  className?: string
  dateRange?: { start: string; end: string }
  markers?: ChartMarker[]
  ranges?: ChartRange[]
  priceLines?: ChartPriceLine[]
  priceCurves?: CandlestickProps['priceCurves']
  highlightedKey?: CandlestickProps['highlightedKey']
  onHighlightChange?: CandlestickProps['onHighlightChange']
  priceLabelWidth?: number
  showLimitMarkers?: boolean
  showIndicatorControls?: boolean
  showMarkerToggle?: boolean
  showMA?: boolean
  showInfoBar?: boolean
  /** 初始可见蜡烛根数; 'all' = 适配显示全部数据 */
  visibleBars?: number | 'all'
  linkedPrice?: number | null
  onDateClick?: (date: string) => void
  selectedDate?: string | null
  onPriceDoubleClick?: (price: number, currentPrice: number) => void
  /** 扩展数据列参数（逗号分隔 config_id.field_name），透传给 klineDaily 接口 */
  extColumns?: string
  /** 加入自选日 (北京时间 YYYY-MM-DD); 有值时日K主图绘制「自选」竖虚线 */
  addedDate?: string | null
  /** 日K自动刷新间隔(ms)。undefined = 不轮询(默认)。个股对话框实时刷新时传入, 盘中今日蜡烛随之更新 */
  refetchIntervalMs?: number
  period?: KlinePeriod
  periodDays?: number
  /** 技术分析模式下附带后端统一评分序列。 */
  includeTechnicalScores?: boolean
  /** 当前周期、当前历史截面的缠论结构近似结果；未传入时不显示相关控件和覆盖层。 */
  chanlunAnalysis?: ChanlunAnalysis
  /** 调试进行中时只展示到当前推进的 K 线。 */
  visibleThrough?: string | null
  /** 调试设置开启时隐藏当前推进 K 线的日期。 */
  hideCurrentDate?: boolean
  /** 当前已选中的策略；其入场/退出信号会叠加在 K 线。 */
  selectedStrategy?: { id: string; name: string; source?: string } | null
  /** 清除当前图表上的策略选择。 */
  onClearStrategy?: () => void
  /** 编辑当前周期的已选信号。 */
  onAddSignal?: (assetType: 'stock' | 'etf', period: KlinePeriod) => void
  /** 当前已选中的信号库信号；其命中会叠加在 K 线上。 */
  selectedSignals?: ChartSignalSelectionModel[]
  /** 清除当前图表上的信号选择。 */
  onClearSignals?: () => void
}

export type ChartStrategySelection = NonNullable<Props['selectedStrategy']>
export type ChartSignalSelection = ChartSignalSelectionModel

function isValidRow(r: any): boolean {
  return r && r.date != null && r.open != null && r.close != null
}

export function toOHLC(rows: KlineRow[], period: KlinePeriod = '1d'): OHLC[] {
  return rows
    .filter(isValidRow)
    .map(r => ({
      date: period === '30m'
        ? String(r.date).replace('T', ' ').slice(0, 16)
        : typeof r.date === 'string' ? r.date.slice(0, 10) : String(r.date),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      periodEnd: r.period_end != null ? String(r.period_end).replace('T', ' ').slice(0, 16) : null,
      isClosed: r.is_closed === true,
      volume: Number(r.volume ?? 0),
      amount: r.amount != null ? Number(r.amount) : undefined,
      ma5: r.ma5 != null ? Number(r.ma5) : null,
      ma10: r.ma10 != null ? Number(r.ma10) : null,
      ma20: r.ma20 != null ? Number(r.ma20) : null,
      ma60: r.ma60 != null ? Number(r.ma60) : null,
      macd_dif: r.macd_dif != null ? Number(r.macd_dif) : null,
      macd_dea: r.macd_dea != null ? Number(r.macd_dea) : null,
      macd_hist: r.macd_hist != null ? Number(r.macd_hist) : null,
      rsi_6: r.rsi_6 != null ? Number(r.rsi_6) : null,
      rsi_14: r.rsi_14 != null ? Number(r.rsi_14) : null,
      rsi_24: r.rsi_24 != null ? Number(r.rsi_24) : null,
      kdj_k: r.kdj_k != null ? Number(r.kdj_k) : null,
      kdj_d: r.kdj_d != null ? Number(r.kdj_d) : null,
      kdj_j: r.kdj_j != null ? Number(r.kdj_j) : null,
      boll_upper: r.boll_upper != null ? Number(r.boll_upper) : null,
      boll_lower: r.boll_lower != null ? Number(r.boll_lower) : null,
      atr_14: r.atr_14 != null ? Number(r.atr_14) : null,
      atr14: r.atr_14 != null ? Number(r.atr_14) : null,
    }))
}

function buildLimitUpMarkers(rows: KlineRow[]): ChartMarker[] {
  const markers: ChartMarker[] = []
  for (const r of rows) {
    const date = typeof r.date === 'string' ? r.date.slice(0, 10) : String(r.date)
    if (r.signal_broken_limit_up) {
      markers.push({ date, kind: 'neutral', above: true, color: '#8B5CF6', label: '炸' })
    } else if (r.signal_limit_up) {
      const boards: number = r.consecutive_limit_ups ?? 1
      markers.push({ date, kind: 'buy', above: true, color: '#FACC15', label: boards <= 1 ? '板' : String(boards) })
    }
  }
  return markers
}

export function getDefaultRange(): { start: string; end: string } {
  return defaultKlineRange('1d')
}

/** 工具栏小胶囊开关（指标与标注开关共用一套尺寸/关闭态样式，激活色由调用方给字面量）。 */
function ChartPill({
  active, label, activeClass, title, onClick,
}: {
  active: boolean
  label: string
  activeClass: string
  title?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`h-6 px-2 rounded-md border border-border/40 text-[10px] font-mono cursor-pointer transition-colors ${
        active ? activeClass : 'bg-base/40 text-muted hover:border-border/60 hover:text-secondary'
      }`}
    >
      {label}
    </button>
  )
}

export function StockDailyKChart(props: Props) {
  return props.indicatorSelection
    ? <StockDailyKChartView {...props} indicatorSelection={props.indicatorSelection} />
    : <StandaloneStockDailyKChart {...props} />
}

function StandaloneStockDailyKChart(props: Props) {
  const indicatorSelection = useChartIndicatorSelection(props.showMA)
  return <StockDailyKChartView {...props} indicatorSelection={indicatorSelection} />
}

function StockDailyKChartView({
  indicatorSelection,
  symbol,
  height = 520,
  className,
  dateRange: externalDateRange,
  markers,
  ranges,
  priceLines,
  priceCurves,
  highlightedKey,
  onHighlightChange,
  priceLabelWidth,
  showLimitMarkers = true,
  showIndicatorControls = true,
  showMarkerToggle = true,
  showMA = true,
  showInfoBar = true,
  visibleBars = 60,
  linkedPrice,
  onDateClick,
  selectedDate,
  onPriceDoubleClick,
  extColumns,
  addedDate,
  refetchIntervalMs,
  period = '1d',
  periodDays = DEFAULT_30M_DAYS,
  includeTechnicalScores = false,
  chanlunAnalysis,
  visibleThrough,
  hideCurrentDate = false,
  selectedStrategy,
  onClearStrategy,
  onAddSignal,
  selectedSignals,
  onClearSignals,
}: Props & { indicatorSelection: ReturnType<typeof useChartIndicatorSelection> }) {
  const { catalog, activeIndicators, effectiveMA, volumeCompare, indicatorRequest, toggleIndicator, updateVolumeCompare } = indicatorSelection
  const SUB_CHARTS = catalog.sub
  const [showMarkers, setShowMarkers] = useState(true)
  // 加入自选日标注（与「异动」标记相互独立）
  const [showAddedMark, setShowAddedMark] = useState(true)
  const [chanlunMenuOpen, setChanlunMenuOpen] = useState(false)
  const [chanlunOverlay, setChanlunOverlay] = useState<StockPreviewChanlunOverlayConfig>(() =>
    normalizeChanlunOverlay(storage.stockPreviewChanlunOverlay.get(DEFAULT_CHANLUN_OVERLAY)),
  )
  const dateRange = externalDateRange ?? defaultKlineRange(period)

  // 日K仍与 StockPanel 信息条共享 cache key；其余周期走独立、含 period 的查询键。
  const kline = useQuery({
    ...klinePeriodQueryOptions(symbol, period, dateRange, periodDays, extColumns, includeTechnicalScores, indicatorRequest),
    enabled: !!symbol && indicatorSelection.ready,
    refetchInterval: refetchIntervalMs,
  })

  const displayRawRows = useMemo(
    () => filterKlineRowsThrough(kline.data?.rows ?? [], period, visibleThrough),
    [kline.data?.rows, period, visibleThrough],
  )
  const rows = useMemo(() => toOHLC(displayRawRows, period), [displayRawRows, period])
  const chartAssetType = kline.data?.asset_type === 'stock' || kline.data?.asset_type === 'etf'
    ? kline.data.asset_type
    : undefined
  const strategyTimeframe: '1d' | '1w' | '30m' | null = period === '1mo' ? null : period
  const signalTimeframe = period
  const strategySignalsQuery = useQuery({
    queryKey: QK.strategySignals(
      selectedStrategy?.id ?? '',
      symbol,
      chartAssetType ?? '',
      strategyTimeframe ?? '',
      dateRange.start,
      dateRange.end,
      periodDays,
    ),
    queryFn: () => api.strategySignals(
      selectedStrategy!.id,
      symbol,
      chartAssetType!,
      strategyTimeframe!,
      dateRange,
      periodDays,
    ),
    enabled: Boolean(
      selectedStrategy
      && chartAssetType
      && strategyTimeframe
      && kline.data
      && rows.length > 0,
    ),
    retry: 1,
  })
  const selectedSignalIds = useMemo(
    () => (selectedSignals ?? []).map(signal => signal.id),
    [selectedSignals],
  )
  const selectedSignalKey = selectedSignalIds.join(',')
  const signalChartQuery = useQuery({
    queryKey: QK.signalChartMarkers(
      symbol,
      chartAssetType ?? '',
      signalTimeframe,
      dateRange.start,
      dateRange.end,
      periodDays,
      selectedSignalKey,
    ),
    queryFn: () => api.signalChartMarkers(
      selectedSignalIds,
      symbol,
      chartAssetType!,
      signalTimeframe,
      dateRange,
      periodDays,
    ),
    enabled: Boolean(
      selectedSignalIds.length > 0
      && chartAssetType
      && signalTimeframe
      && kline.data
      && rows.length > 0,
    ),
    retry: 1,
  })
  const handleSignalChipClick = useCallback(() => {
    if (onAddSignal && chartAssetType) onAddSignal(chartAssetType, period)
  }, [chartAssetType, onAddSignal, period])
  const strategyMarkers = useMemo<ChartMarker[]>(() => {
    const visibleThroughKey = visibleThrough
      ? normalizeKlineBarKey(visibleThrough, period)
      : ''
    return (strategySignalsQuery.data?.markers ?? [])
      .map(marker => ({
        date: normalizeKlineBarKey(marker.date, period),
        kind: marker.kind === 'entry' ? 'buy' as const : 'sell' as const,
        label: marker.kind === 'entry' ? '策略入' : '策略出',
        color: marker.kind === 'entry' ? '#60A5FA' : '#F59E0B',
      }))
      .filter(marker => !visibleThroughKey || marker.date <= visibleThroughKey)
  }, [period, strategySignalsQuery.data?.markers, visibleThrough])
  const signalMarkers = useMemo<ChartMarker[]>(() => {
    const selectedById = new Map((selectedSignals ?? []).map(signal => [signal.id, signal]))
    const visibleThroughKey = visibleThrough
      ? normalizeKlineBarKey(visibleThrough, period)
      : ''
    const groups = [
      { kind: 'entry' as const, chartKind: 'buy' as const, label: '信号入', color: '#22D3EE' },
      { kind: 'exit' as const, chartKind: 'sell' as const, label: '信号出', color: '#FB7185' },
      { kind: 'both' as const, chartKind: 'neutral' as const, label: '信号', color: '#A78BFA' },
    ]
    const result: ChartMarker[] = []
    for (const marker of signalChartQuery.data?.markers ?? []) {
      const activeIds = marker.signals.filter(signalId => selectedById.has(signalId))
      for (const group of groups) {
        const ids = activeIds.filter(signalId => selectedById.get(signalId)?.kind === group.kind)
        if (ids.length === 0) continue
        const names = ids.map(signalId => selectedById.get(signalId)?.name ?? signalId)
        const name = names.length > 2
          ? `${names.slice(0, 2).join('、')}等${names.length}项`
          : names.join('、')
        result.push({
          date: normalizeKlineBarKey(marker.date, period),
          kind: group.chartKind,
          above: group.kind === 'both',
          label: `${group.label}·${name}`,
          color: group.color,
        })
      }
    }
    return result.filter(marker => !visibleThroughKey || marker.date <= visibleThroughKey)
  }, [period, selectedSignals, signalChartQuery.data?.markers, visibleThrough])
  const stockInfo = kline.data?.stock_info
  const limitMarkers = useMemo(() => buildLimitUpMarkers(displayRawRows), [displayRawRows])
  const effectiveShowLimitMarkers = showLimitMarkers && period === '1d' && kline.data?.asset_type !== 'etf'
  const allMarkers = useMemo(() => [
    ...(markers ?? []),
    ...(effectiveShowLimitMarkers ? limitMarkers : []),
    ...strategyMarkers,
    ...signalMarkers,
  ], [effectiveShowLimitMarkers, limitMarkers, markers, signalMarkers, strategyMarkers])

  const updateChanlunOverlay = useCallback((patch: Partial<StockPreviewChanlunOverlayConfig>) => {
    setChanlunOverlay(previous => {
      const next = normalizeChanlunOverlay({ ...previous, ...patch })
      storage.stockPreviewChanlunOverlay.set(next)
      return next
    })
  }, [])

  const activeSubDefs = [...(effectiveMA && catalog.sub.some(i => i.id === 'ma') ? ['ma'] : []), ...activeIndicators]
    .map(key => SUB_CHARTS.find(s => s.key === key))
    .filter((d): d is typeof SUB_CHARTS[number] => !!d)
  let subExtraH = 0
  activeSubDefs.forEach(def => { subExtraH += SUB_INFO_H + def.height })
  if (activeSubDefs.length > 0) subExtraH += activeSubDefs.length * SUB_GAP + 14
  const chartHeight = height + subExtraH

  const toolbarControls = ((showIndicatorControls || selectedStrategy || (selectedSignals?.length ?? 0) > 0) && rows.length > 0 && (
        <div className="max-w-full flex-none">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {showIndicatorControls && (<>
            <ChartIndicatorMenu allowMA={showMA} activeIndicators={effectiveMA ? ['ma', ...activeIndicators] : activeIndicators} onToggle={toggleIndicator} />
          {chanlunAnalysis && (
            <div
              className="relative ml-0.5 flex items-center"
              onBlur={event => {
                if (!event.currentTarget.contains(event.relatedTarget)) setChanlunMenuOpen(false)
              }}
            >
              <button
                type="button"
                onClick={() => updateChanlunOverlay({ enabled: !chanlunOverlay.enabled })}
                className={`h-6 rounded-l-md border border-border/40 px-2 text-[10px] font-mono transition-colors ${
                  chanlunOverlay.enabled
                    ? 'bg-[#8B5CF6]/20 text-[#A78BFA]'
                    : 'bg-base/40 text-muted hover:text-secondary'
                }`}
                aria-pressed={chanlunOverlay.enabled}
                title={chanlunOverlay.enabled ? '隐藏缠论覆盖层' : '显示缠论覆盖层'}
              >
                缠论
              </button>
              <button
                type="button"
                onClick={() => setChanlunMenuOpen(value => !value)}
                className="h-6 rounded-r-md border border-l-0 border-border/40 bg-base/40 px-1.5 text-muted transition-colors hover:text-secondary"
                title="配置缠论覆盖层"
                aria-label="配置缠论覆盖层"
                aria-expanded={chanlunMenuOpen}
              >
                <Settings2 className="h-3 w-3" />
              </button>
              {chanlunMenuOpen && (
                <div className="absolute left-0 top-full z-30 mt-1 w-36 rounded-card border border-border bg-surface p-1.5 shadow-xl">
                  {([
                    ['fractals', '分型'],
                    ['strokes', '笔'],
                    ['segments', '线段代理'],
                    ['centers', '中枢'],
                    ['candidates', '买卖点候选'],
                    ['divergences', '背驰代理'],
                  ] as const).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      role="checkbox"
                      aria-checked={chanlunOverlay[key]}
                      onClick={() => updateChanlunOverlay({ [key]: !chanlunOverlay[key] })}
                      className="flex w-full items-center gap-2 rounded-btn px-2 py-1.5 text-left text-[10px] text-secondary transition-colors hover:bg-elevated hover:text-foreground"
                    >
                      <span className={`flex h-3.5 w-3.5 items-center justify-center rounded border ${chanlunOverlay[key] ? 'border-[#8B5CF6] bg-[#8B5CF6]' : 'border-border bg-base'}`}>
                        {chanlunOverlay[key] && <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />}
                      </span>
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {showMarkerToggle && effectiveShowLimitMarkers && (
            <button
              onClick={() => setShowMarkers(v => !v)}
              className={`ml-auto h-6 px-2 rounded-md border border-border/40 text-[10px] font-mono cursor-pointer transition-colors ${
                showMarkers
                  ? 'text-[#FACC15] bg-[#FACC15]/10'
                  : 'bg-elevated text-muted hover:text-secondary'
              }`}
            >
              异动
            </button>
          )}
          </>)}
          {/* 激活色与图表里的 ADDED_DATE_COLOR 一致; Tailwind 只认字面量类名, 故写死色值 */}
          {showMarkerToggle && addedDate && (
            <ChartPill
              active={showAddedMark}
              label="自选"
              activeClass="text-[#3B82F6] bg-[#3B82F6]/10"
              title={showAddedMark ? '隐藏K线上的加入自选日标注' : '显示K线上的加入自选日标注'}
              onClick={() => setShowAddedMark(v => !v)}
            />
          )}
          {(selectedStrategy
            || (selectedSignals?.length ?? 0) > 0) && (
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {selectedStrategy && (
                <button
                  type="button"
                  onClick={onClearStrategy}
                  title={`移除策略：${selectedStrategy.name}`}
                  className="inline-flex max-w-[190px] shrink-0 items-center gap-1 rounded border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] text-accent transition-colors hover:border-accent/50 hover:bg-accent/15"
                >
                  <Layers className="h-3 w-3 shrink-0" />
                  <span className="truncate">{selectedStrategy.name}</span>
                  {strategySignalsQuery.isLoading && (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin opacity-80" aria-label="策略信号加载中" />
                  )}
                  {strategySignalsQuery.isError && (
                    <span className="shrink-0 text-danger" title="策略信号加载失败">!</span>
                  )}
                  {strategySignalsQuery.isSuccess && (
                    <span className="shrink-0 text-[9px] text-muted" title={`策略命中 ${strategySignalsQuery.data.count} 处`}>
                      {strategySignalsQuery.data.count}处
                    </span>
                  )}
                  <X className="h-3 w-3 shrink-0 opacity-70" />
                </button>
              )}
              {selectedSignals && selectedSignals.length > 0 && (
                <div
                  className="inline-flex max-w-[210px] shrink-0 items-center gap-0 rounded border border-cyan-400/30 bg-cyan-400/10 text-[10px] text-cyan-300 transition-colors hover:border-cyan-400/50"
                >
                  <button
                    type="button"
                    onClick={handleSignalChipClick}
                    title="点击编辑已选择的信号"
                    aria-label="编辑已选择的信号"
                    className="inline-flex min-w-0 flex-1 items-center gap-1 px-2 py-0.5 text-left text-cyan-300 hover:bg-cyan-400/10"
                  >
                    <Activity className="h-3 w-3 shrink-0" />
                    <span className="truncate">{selectedSignals.length === 1 ? selectedSignals[0].name : `信号 ${selectedSignals.length}个`}</span>
                    {signalChartQuery.isLoading && (
                      <Loader2 className="h-3 w-3 shrink-0 animate-spin opacity-80" aria-label="信号加载中" />
                    )}
                    {signalChartQuery.isError && (
                      <span className="shrink-0 text-danger" title="信号加载失败">!</span>
                    )}
                    {signalChartQuery.isSuccess && (
                      <span className="shrink-0 text-[9px] text-muted" title={`信号命中 ${signalChartQuery.data.count} 处`}>
                        {signalChartQuery.data.count}处
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={onClearSignals}
                    aria-label="移除全部已选择信号"
                    title="移除全部已选择信号"
                    className="shrink-0 rounded-r px-1.5 py-0.5 opacity-70 transition-colors hover:bg-cyan-400/15 hover:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>
          )}
          </div>
        </div>
      )
  )

  if (!symbol) return null

  return (
    <div className={`rounded-card border border-border/60 bg-surface/40 p-3 ${className ?? ''}`} style={{ minHeight: height }}>

      {kline.isLoading && <div className="text-sm text-muted py-4">加载中…</div>}
      {kline.data?.indicator_errors?.map(error => <p key={error.id} role="alert" className="py-1 text-xs text-danger">{catalog.items.find(i => i.id === error.id)?.name ?? error.id}：{error.message}</p>)}
      {kline.isError && <div className="text-sm text-danger py-2">K线加载失败</div>}
      {!kline.isLoading && !kline.isError && displayRawRows.length === 0 && (
        <div className="flex items-center justify-center text-sm text-muted" style={{ height }}>
          {period === '30m' ? '暂无30分钟K数据，请检查图表行情数据源' : '暂无该周期K线数据'}
        </div>
      )}
      {!kline.isLoading && !kline.isError && displayRawRows.length > 0 && rows.length === 0 && (
        <div className="text-sm text-danger py-2">数据格式异常，请刷新页面</div>
      )}
      {rows.length > 0 && (
        <KLineCandlestick
          data={rows}
          toolbarControls={toolbarControls}
          period={period}
          markers={allMarkers}
          ranges={ranges}
          priceLines={priceLines}
          priceCurves={priceCurves}
          highlightedKey={highlightedKey}
          onHighlightChange={onHighlightChange}
          priceLabelWidth={priceLabelWidth}
          height={chartHeight - 22}
          showMA={effectiveMA}
          indicatorResults={kline.data?.indicator_results}
          indicatorDefinitions={catalog.items}
          showInfoBar={showInfoBar}
          showMarkers={showMarkers}
          stockInfo={stockInfo}
          symbol={symbol}
          assetType={kline.data?.asset_type}
          linkedPrice={linkedPrice}
          onDateClick={onDateClick}
          selectedDate={selectedDate}
          onPriceDoubleClick={onPriceDoubleClick}
          visibleBars={visibleBars}
          activeIndicators={activeIndicators}
          volumeCompare={volumeCompare}
          volumeCompareControls={
            <div className="flex h-6 items-center gap-1.5">
              <span className="text-[10px] text-muted">量比</span>
              <button
                type="button"
                role="switch"
                aria-checked={volumeCompare.enabled}
                aria-label="开启量能对比"
                title={volumeCompare.enabled ? '关闭量能对比' : '开启量能对比'}
                onClick={() => updateVolumeCompare({ enabled: !volumeCompare.enabled })}
                className={`relative h-3.5 w-6 shrink-0 rounded-full transition-colors ${
                  volumeCompare.enabled ? 'bg-accent' : 'bg-elevated'
                }`}
              >
                <span className={`absolute left-0 top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-transform ${
                  volumeCompare.enabled ? 'translate-x-3' : 'translate-x-0.5'
                }`} />
              </button>
              <select
                aria-label="量能对比周期"
                value={volumeCompare.days}
                disabled={!volumeCompare.enabled}
                onChange={event => updateVolumeCompare({ days: Number(event.target.value) })}
                className="h-6 rounded-md border border-border/40 bg-base px-1 text-[10px] text-secondary outline-none [color-scheme:light] dark:[color-scheme:dark] disabled:opacity-40"
              >
                {Array.from({ length: 20 }, (_, index) => index + 1).map(days => (
                  <option key={days} value={days} className="bg-base text-secondary">前{days}日均量</option>
                ))}
              </select>
            </div>
          }
          addedDate={showAddedMark ? addedDate : null}
          chanlunAnalysis={chanlunAnalysis}
          chanlunOverlay={chanlunOverlay}
          hideCurrentDate={hideCurrentDate}
          showRangeSelector
        />
      )}
    </div>
  )
}
