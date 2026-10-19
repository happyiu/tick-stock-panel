import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { dispose, init, registerIndicator, registerOverlay, type Chart, type Crosshair, type IndicatorFigure, type KLineData } from 'klinecharts'
import { chartTheme, useTheme } from '@/lib/theme'
import { fmtAssetPrice, fmtPct, priceDigits } from '@/lib/format'
import {
  chartIndicators, classifyBarUpdate, COLORS, SUB_CHARTS as DEFAULT_SUB_CHARTS, OVERLAY_INDICATORS as DEFAULT_MAIN_CHARTS, toChartBars,
  type ChartBar, type CandlestickProps,
} from '@/lib/kline-chart'
import { annotationTemplate, ANNOTATION_GROUP, buildAnnotations } from '@/lib/kline-chart-overlays'
import { formulaHeaderHeight, formulaName, formulaIndicators } from '@/lib/kline-chart-formulas'
import { ANGEL_DEVIL_MA, calculateAngelDevil } from '@/lib/angelDevil'
import { BOLL2_LINES, calculateBoll2 } from '@/lib/boll2'
import { storage } from '@/lib/storage'
import { formulaColor, formulaContext, serverFormulaFigures, serverFormulaTemplate } from '@/lib/chart-formula-renderer'
import { builtinIndicator } from '@/lib/kline-chart-builtins'
import { ChartDrawingToolbar, DRAWING_GROUP } from './ChartDrawingToolbar'
import { buildChanlunOverlays, CHANLUN_GROUP, chanlunTemplate } from '@/lib/kline-chart-chanlun'
import { buildLevelOverlays, LEVEL_GROUP, levelTemplate } from '@/lib/kline-chart-levels'

export { SUB_CHARTS, OVERLAY_INDICATORS } from '@/lib/kline-chart'
export type { CandlestickProps, ChartMarker, ChartPriceLine, ChartPriceCurve, ChartRange, OHLC, VolumeCompareConfig } from '@/lib/kline-chart'

chartIndicators.forEach(indicator => registerIndicator(indicator))
formulaIndicators.forEach(indicator => registerIndicator(indicator))
const registeredServerFormulas = new Set<string>()
const legacyDefinitions = [...DEFAULT_SUB_CHARTS.map(i => ({ ...i, pane: 'sub' as const })), ...DEFAULT_MAIN_CHARTS.map(i => ({ ...i, height: 100, pane: 'main' as const }))].map(i => ({ ...i, id: i.key, name: i.label, source: i.key.startsWith('builtin-') ? 'builtin' : 'custom', revision: 1 }))
registerOverlay(annotationTemplate)
registerOverlay(chanlunTemplate)
registerOverlay(levelTemplate)

const EMPTY: never[] = []
const DEFAULT_COMPARE = { enabled: true, days: 1 }

export function KLineCandlestick({
  data, indicatorResults, indicatorDefinitions, toolbarControls, markers = EMPTY, ranges = EMPTY, priceLines = EMPTY, height = 480,
  showMA: requestedMA = true, showInfoBar = true, showMarkers = true, stockInfo, symbol = '', linkedPrice,
  onDateClick, onPriceDoubleClick, visibleBars = 60, activeIndicators = EMPTY,
  volumeCompare = DEFAULT_COMPARE, volumeCompareControls, addedDate, assetType, period = '1d', selectedDate,
  chanlunAnalysis, chanlunOverlay, hideCurrentDate = false,
  priceCurves = EMPTY, priceLabelWidth = 0, highlightedKey, onHighlightChange, showRangeSelector = false,
}: CandlestickProps) {
  const managed = indicatorDefinitions != null
  const definitions = indicatorDefinitions ?? legacyDefinitions
  const catalog = { items: definitions, data: indicatorDefinitions }
  const showMA = requestedMA && definitions.some(i => i.id === 'ma')
  const SUB_CHARTS = definitions.filter(i => i.pane === 'sub').map(i => ({ ...i, key: i.id, label: i.name }))
  const definitionsRef = useRef(SUB_CHARTS)
  definitionsRef.current = SUB_CHARTS
  const OVERLAY_INDICATORS = definitions.filter(i => i.pane === 'main').map(i => ({ ...i, key: i.id, label: i.name }))
  const theme = useTheme()
  const ct = chartTheme(theme)
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<Chart | null>(null)
  const appliedFormulaInputs = useRef(new Map<string, unknown[]>())
  const [chartInstance, setChartInstance] = useState<Chart | null>(null)
  const [volumePane, setVolumePane] = useState<HTMLElement | null>(null)
  const hasVolumeControls = Boolean(volumeCompareControls)
  const volumeControlsRef = useRef(hasVolumeControls)
  volumeControlsRef.current = hasVolumeControls
  const userInteracted = useRef(false)
  const bars = useMemo(() => toChartBars(data, volumeCompare.days), [data, volumeCompare.days])
  const barsRef = useRef(bars)
  barsRef.current = bars
  const previousRef = useRef<ChartBar[]>([])
  const previousSymbol = useRef(symbol)
  const previousPeriod = useRef(period)
  const pushBar = useRef<((bar: KLineData) => void) | null>(null)
  const fitInitialView = useRef(true)
  const restoreView = useRef<{ spacing: number; timestamp: number } | null>(null)
  const subKeysRef = useRef<string[]>([])
  const headerHeights = useRef(new Map<string, number>())
  const paneHeights = useRef(new Map<string, number>())
  const lastPaneResize = useRef<{
    pointerId: number
    key: string
    startY: number
    startHeight: number
    startChartHeightAdjustment: number
    header: number
    fixedPanes: Array<{ key: string; height: number; header: number }>
  } | null>(null)
  const lastPaneResizeFrame = useRef<number | null>(null)
  const lastPaneResizeY = useRef(0)
  const [minimumChartHeight, setMinimumChartHeight] = useState(150)
  const [mainPaneHeight, setMainPaneHeight] = useState<number | null>(() => {
    const saved = storage.stockPreviewMainChartHeight.get(0)
    return Number.isFinite(saved) && saved >= 120 && saved <= 2000 ? saved : null
  })
  const mainPaneHeightRef = useRef(mainPaneHeight)
  mainPaneHeightRef.current = mainPaneHeight
  const [chartHeightAdjustment, setChartHeightAdjustment] = useState(() => {
    const saved = storage.stockPreviewChartHeightAdjustment.get(0)
    return Number.isFinite(saved) ? saved : 0
  })
  const callbacks = useRef({ onDateClick, onPriceDoubleClick, visibleBars, priceLabelWidth, showRangeSelector })
  callbacks.current = { onDateClick, onPriceDoubleClick, visibleBars, priceLabelWidth, showRangeSelector }
  const [structureTooltip, setStructureTooltip] = useState<string | null>(null)
  const [visibleRange, setVisibleRange] = useState({ from: 0, to: bars.length })
  const precision = priceDigits(assetType)
  const price = (value: unknown) => fmtAssetPrice(typeof value === 'number' ? value : null, assetType)
  const [hover, setHover] = useState<{ symbol: string; date: string } | null>(null)
  const [hiddenMaLines, setHiddenMaLines] = useState<string[]>(() => {
    const saved = storage.stockPreviewHiddenMaLines.get([])
    return Array.isArray(saved) ? ['ma5', 'ma10', 'ma20', 'ma60'].filter(key => saved.includes(key)) : []
  })
  useEffect(() => { storage.stockPreviewHiddenMaLines.set(hiddenMaLines) }, [hiddenMaLines])
  const hoverIndex = hover?.symbol === symbol ? bars.findIndex(bar => bar.date === hover.date) : -1
  const infoIndex = hoverIndex >= 0 ? hoverIndex : bars.length - 1
  const rawRow = bars[infoIndex]
  const maPacket = indicatorResults?.ma
  const maRow = maPacket?.rows[maPacket.dates.indexOf(rawRow?.date ?? '')]
  const row = rawRow && maRow ? { ...rawRow, ...Object.fromEntries(['ma5','ma10','ma20','ma60'].map(key => [key, maRow[key]])) } : rawRow
  const bollPacket = indicatorResults?.boll
  const bollRow = bollPacket?.rows[bollPacket.dates.indexOf(rawRow?.date ?? '')]

  const previous = bars[infoIndex - 1]
  const subKey = [...(showMA && SUB_CHARTS.some(def => def.key === 'ma') ? ['ma'] : []), ...activeIndicators.filter(key => SUB_CHARTS.some(def => def.key === key))].join(',')
  subKeysRef.current = subKey.split(',').filter(Boolean)
  const boll = activeIndicators.includes('boll')
  const angel = activeIndicators.includes('angel-devil')
  const boll2 = activeIndicators.includes('boll2')
  const angelRows = useMemo(() => {
    if (!managed) return angel ? calculateAngelDevil(bars.map(b => b.close)) : null
    const packet = indicatorResults?.['angel-devil']
    if (!angel || !packet) return null
    const context = formulaContext('angel-devil', packet, volumeCompare.enabled, volumeCompare.days)
    return bars.map(bar => context.values[bar.date] ?? {})
  }, [bars, angel, indicatorResults, managed])
  const boll2Rows = useMemo(() => {
    if (!managed) return boll2 ? calculateBoll2(bars.map(b => b.close)) : null
    const packet = indicatorResults?.boll2
    if (!boll2 || !packet) return null
    const context = formulaContext('boll2', packet, volumeCompare.enabled, volumeCompare.days)
    return bars.map(bar => context.values[bar.date] ?? {})
  }, [bars, boll2, indicatorResults, managed])
  const candleTrends = useMemo(() => new Map(bars.map((bar, i) => [bar.timestamp, angelRows?.[i]?.bull])), [bars, angelRows])
  const chartHeight = mainPaneHeight != null ? minimumChartHeight
    : Math.max(height - (showInfoBar ? 40 : 0) + (subKey ? chartHeightAdjustment : 0), minimumChartHeight)
  const fitPaneHeights = () => {
    // 恢复较大的副图或窄屏提示换行时，扩展画布，给主图留下120px。
    const chart = chartRef.current
    const xAxisHeight = Math.max(22, chart?.getSize('x_axis_pane')?.height ?? 22)
    setMinimumChartHeight(Math.ceil(xAxisHeight + (mainPaneHeightRef.current ?? 142) + subKeysRef.current.reduce((total, key) => {
      const def = definitionsRef.current.find(d => d.key === key)
      if (!def) return total
      const header = headerHeights.current.get(key) ?? 28
      const options = chart?.getPaneOptions(`tsp_${key.replaceAll('-', '_')}`)
      const height = options && !Array.isArray(options) && Number.isFinite(options.height)
        ? Math.max(50, options.height - header)
        : paneHeights.current.get(key) ?? def.height
      return total + height + header + 4
    }, 0)))
  }

  useEffect(() => {
    const saved = storage.stockPreviewSubChartHeights.get({})
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return
    for (const definition of SUB_CHARTS) {
      const value = saved[definition.key]
      if (!paneHeights.current.has(definition.key) && typeof value === 'number' && value >= 50 && value <= 2000) paneHeights.current.set(definition.key, value)
    }
  }, [catalog.data])

  // 图表消费现有查询缓存，不另建请求或 SSE 订阅。
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const chart = init(element, {
      locale: 'zh-CN', timezone: 'Asia/Shanghai',
      layout: { barSpaceLimit: { min: 0.5, max: 40 }, yAxis: { position: 'left' } },
    })
    if (!chart) return
    chartRef.current = chart
    setChartInstance(chart)
    const savedHeights = storage.stockPreviewSubChartHeights.get({})
    if (savedHeights && typeof savedHeights === 'object' && !Array.isArray(savedHeights)) {
      for (const { key } of SUB_CHARTS) {
        const value = savedHeights[key]
        if (typeof value === 'number' && Number.isFinite(value) && value >= 50 && value <= 2000) paneHeights.current.set(key, value)
      }
    }
    // 日期轴固定在主图与副图之间，与缠论视图保持一致。
    chart.setPaneOptions({ id: 'candle_pane', minHeight: 120, order: -1 })
    chart.setPaneOptions({ id: 'x_axis_pane', order: 0 })
    let alive = true
    let frame = 0
    let resizeFrame = 0
    const fitView = () => {
      const width = chart.getSize('candle_pane', 'main')?.width ?? element.clientWidth
      const count = callbacks.current.visibleBars === 'all' ? barsRef.current.length : callbacks.current.visibleBars
      if (width <= 0 || !barsRef.current.length) return
      const padding = Math.max(8, Math.min(callbacks.current.priceLabelWidth, width * 0.4))
      chart.setOffsetRightDistance(padding)
      chart.setBarSpace(Math.max(0.5, Math.min(40, (width - padding) / Math.max(1, Math.min(count, barsRef.current.length)))))
      chart.scrollToRealTime()
      fitInitialView.current = false
    }
    // 右侧分时在日K就绪后才展开，首次布局宽度会再次变化。
    const observer = new ResizeObserver(() => {
      chart.resize()
      for (const key of subKeysRef.current) layoutSubPane(chart, key, element.clientWidth, headerHeights.current, paneHeights.current, undefined, volumeControlsRef.current, definitionsRef.current)
      fitPaneHeights()
      // resize 的布局异步完成，下一帧才能读到新的绘图区宽度。
      cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(() => {
        if (alive && !userInteracted.current) fitView()
      })
    })
    observer.observe(element)
    const onCrosshair = (value: unknown) => {
      const crosshair = value as Crosshair | undefined
      const bar = crosshair?.dataIndex != null ? barsRef.current[crosshair.dataIndex] : undefined
      if (bar) setHover(current => current?.symbol === previousSymbol.current && current.date === bar.date
        ? current : { symbol: previousSymbol.current, date: bar.date })
    }
    const onCandleClick = (value: unknown) => {
      if (chart.getOverlays({ groupId: DRAWING_GROUP }).some(overlay => overlay.currentStep !== -1)) return
      const event = value as { dataIndex?: number }
      const bar = event?.dataIndex != null ? barsRef.current[event.dataIndex] : undefined
      if (bar) callbacks.current.onDateClick?.(bar.date)
    }
    const onPaneDrag = () => {
      userInteracted.current = true
      const mainHeight = chart.getSize('candle_pane')?.height
      if (mainHeight != null && mainHeight >= 120 && mainHeight <= 2000) {
        mainPaneHeightRef.current = mainHeight
        setMainPaneHeight(mainHeight)
        storage.stockPreviewMainChartHeight.set(mainHeight)
      }
      // 一次拖动会同时改变相邻两块区域，保存所有副图的绘图区高度。
      for (const key of subKeysRef.current) {
        const options = chart.getPaneOptions(`tsp_${key.replaceAll('-', '_')}`)
        const header = headerHeights.current.get(key)
        if (options && !Array.isArray(options) && header != null && Number.isFinite(options.height)) {
          paneHeights.current.set(key, Math.max(50, options.height - header))
        }
      }
      storage.stockPreviewSubChartHeights.set(Object.fromEntries(paneHeights.current))
      fitPaneHeights()
    }
    const onVisibleRange = () => {
      if (!callbacks.current.showRangeSelector) return
      const range = chart.getVisibleRange()
      const width = chart.getSize('candle_pane', 'main')?.width ?? element.clientWidth
      const padding = Math.max(8, Math.min(callbacks.current.priceLabelWidth, width * 0.4))
      // 原生可见范围含右侧标签留白，范围条只显示实际选中的 K 线。
      const points = chart.convertFromPixel([{ x: 0 }, { x: width - padding }], { paneId: 'candle_pane' })
      const [left, right] = Array.isArray(points) ? points : []
      const from = Math.max(0, Math.min(barsRef.current.length - 1, left?.dataIndex != null ? left.dataIndex + 1 : range.from))
      const to = Math.max(from + 1, Math.min(barsRef.current.length, right?.dataIndex != null ? right.dataIndex + 1 : range.to))
      setVisibleRange(current => current.from === from && current.to === to ? current : { from, to })
    }
    chart.subscribeAction('onCrosshairChange', onCrosshair)
    chart.subscribeAction('onCandleBarClick', onCandleClick)
    chart.subscribeAction('onPaneDrag', onPaneDrag)
    chart.subscribeAction('onVisibleRangeChange', onVisibleRange)
    chart.setSymbol({ ticker: previousSymbol.current || 'daily', pricePrecision: precision, volumePrecision: 0 })
    chart.setPeriod(chartPeriod(previousPeriod.current))
    chart.setDataLoader({
      getBars: ({ type, callback }) => {
        if (!alive) return
        callback(type === 'init' ? barsRef.current : [], false)
        if (type !== 'init') return
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => {
          if (!alive) return
          if (fitInitialView.current) {
            fitView()
          } else if (restoreView.current) {
            chart.setBarSpace(restoreView.current.spacing)
            chart.scrollToTimestamp(restoreView.current.timestamp)
            restoreView.current = null
          }
        })
      },
      subscribeBar: ({ callback }) => { if (alive) pushBar.current = callback },
      unsubscribeBar: () => { pushBar.current = null },
    })
    return () => {
      alive = false
      cancelAnimationFrame(frame)
      cancelAnimationFrame(resizeFrame)
      observer.disconnect()
      pushBar.current = null
      chartRef.current = null
      previousRef.current = []
      headerHeights.current.clear()
      paneHeights.current.clear()
      chart.unsubscribeAction('onCrosshairChange', onCrosshair)
      chart.unsubscribeAction('onCandleBarClick', onCandleClick)
      chart.unsubscribeAction('onPaneDrag', onPaneDrag)
      chart.unsubscribeAction('onVisibleRangeChange', onVisibleRange)
      dispose(element)
    }
  }, [])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const changedSymbol = previousSymbol.current !== symbol
    const changedPeriod = previousPeriod.current !== period
    const update = classifyBarUpdate(previousRef.current, bars)
    const first = previousRef.current.length === 0
    if (changedSymbol || changedPeriod) {
      previousSymbol.current = symbol
      previousPeriod.current = period
      fitInitialView.current = true
      userInteracted.current = false
      restoreView.current = null
      setHover(null)
      setStructureTooltip(null)
      if (changedSymbol) chart.setSymbol({ ticker: symbol || 'daily', pricePrecision: precision, volumePrecision: 0 })
      if (changedPeriod) chart.setPeriod(chartPeriod(period))
    } else if (update === 'tail' && pushBar.current) {
      pushBar.current(bars.at(-1)!)
    } else if (update === 'reset' && !first) {
      const range = chart.getVisibleRange()
      const right = previousRef.current[Math.min(previousRef.current.length - 1, range.to - 1)]
      if (right) restoreView.current = { spacing: chart.getBarSpace().bar, timestamp: right.timestamp }
      if (userInteracted.current) fitInitialView.current = false
      chart.resetData()
    } else if (first && !changedSymbol) {
      chart.resetData()
    }
    previousRef.current = bars
  }, [bars, symbol, period, precision])

  useEffect(() => {
    if (!selectedDate || !chartRef.current) return
    const selected = barsRef.current.find(bar => bar.date === selectedDate)
    if (selected) chartRef.current.scrollToTimestamp(selected.timestamp)
  }, [selectedDate, symbol, period])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    chart.setStyles({
      grid: { horizontal: { color: ct.grid }, vertical: { show: false } },
      candle: {
        type: 'candle_solid', bar: ({ current }) => {
          const bull = current ? candleTrends.get(current.timestamp) : null
          if (bull != null) return { color: bull ? 'transparent' : '#00FFFF', borderColor: bull ? '#FF0000' : '#00DDFF', wickColor: bull ? '#FF0000' : '#00DDFF' }
          const color = current && current.close < current.open ? COLORS.bear : COLORS.bull
          return { color, borderColor: color, wickColor: color }
        },
        tooltip: { showRule: 'none' },
        priceMark: { high: { show: false }, low: { show: false }, last: { show: false } },
      },
      indicator: { tooltip: {
        offsetTop: 2, offsetLeft: 4,
        legend: { color: ct.text, size: 10, marginLeft: 0, marginRight: 8, marginTop: 1, marginBottom: 1 },
        title: { color: ct.text, size: 10, marginLeft: 0, marginRight: 8, marginTop: 1, marginBottom: 1 },
      } },
      xAxis: { tickText: { show: !hideCurrentDate, color: ct.text, size: 10 }, axisLine: { color: ct.border }, tickLine: { show: false } },
      yAxis: { tickText: { color: ct.text, size: 10 }, axisLine: { show: false }, tickLine: { show: false } },
      separator: { size: 4, color: ct.border, activeBackgroundColor: ct.crosshair },
      crosshair: {
        horizontal: { line: { color: ct.crosshair }, text: { backgroundColor: ct.crosshairLabelBg, color: '#fff' } },
        vertical: { line: { color: ct.crosshair }, text: { show: !hideCurrentDate, backgroundColor: ct.crosshairLabelBg, color: '#fff' } },
      },
    })
  }, [theme, candleTrends, hideCurrentDate])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const keys = [...new Set([
      ...(angel && OVERLAY_INDICATORS.some(i => i.key === 'angel-devil') ? ['angel-devil'] : showMA ? ['ma'] : []),
      ...activeIndicators.filter(key => key !== 'ma' && (OVERLAY_INDICATORS.some(def => def.key === key) || SUB_CHARTS.some(def => def.key === key))),
    ])]
    const packetFor = (key: string) => {
      const packet = indicatorResults?.[key]
      return packet && packet.revision === catalog.items.find(i => i.id === key)?.revision ? packet : undefined
    }
    const nameForKey = (key: string) => builtinIndicator(key)?.name ?? (packetFor(key) ? `SERVER_${key}` : formulaName(key))
    const wanted = new Set(keys.filter(key => builtinIndicator(key) || packetFor(key) || !managed).map(nameForKey))
    for (const indicator of chart.getIndicators()) {
      if (!wanted.has(indicator.name)) chart.removeIndicator({ id: indicator.id })
    }
    for (const key of keys) {
      const builtin = builtinIndicator(key), packet = packetFor(key), name = nameForKey(key)
      if (!builtin && !packet && (managed || ![...chartIndicators, ...formulaIndicators].some(i => i.name === name))) continue
      if (packet && !registeredServerFormulas.has(name)) {
        registerIndicator(serverFormulaTemplate(name)); registeredServerFormulas.add(name)
      }
      const definition = catalog.items.find(i => i.id === key)
      const existing = chart.getIndicators({ name })[0]
      const inputs = [packet, theme, precision, definition?.name, definition?.pane,
        key === 'vol' ? volumeCompare.enabled : undefined, key === 'vol' ? volumeCompare.days : undefined,
        key === 'ma' ? hiddenMaLines : undefined]
      const previousInputs = appliedFormulaInputs.current.get(key)
      if (packet && existing && previousInputs?.every((value, index) => value === inputs[index])) continue
      const options = {
        name, ...(packet ? { shortName: definition?.name ?? name } : {}),
        paneId: definition?.pane === 'main' || key === 'ma' && !definition ? 'candle_pane' : `tsp_${key.replaceAll('-', '_')}`,
        ...(!managed && !builtin ? { extendData: key === 'vol' ? volumeCompare.enabled : { period }, ...(key === 'vol' ? { calcParams: [volumeCompare.days] } : {}) } : {}),
        ...(packet ? { precision: packet.precision ?? (packet.pane === 'main' ? precision : 2), series: packet.pane === 'main' ? 'price' as const : key === 'vol' ? 'volume' as const : 'normal' as const,
          figures: serverFormulaFigures(packet).filter(f => key !== 'ma' || !hiddenMaLines.includes(f.key)) as IndicatorFigure[],
          minValue: packet.min_value ?? undefined, maxValue: packet.max_value ?? undefined,
          extendData: formulaContext(key, packet, volumeCompare.enabled, volumeCompare.days),
        } : {}),
      }
      if (existing && existing.paneId !== options.paneId) { chart.removeIndicator({ id: existing.id }); chart.createIndicator(options, true) }
      else if (existing) chart.overrideIndicator({ ...options, id: existing.id })
      else chart.createIndicator(options, true)
      if (packet) appliedFormulaInputs.current.set(key, inputs)
    }
    for (const key of appliedFormulaInputs.current.keys()) if (!keys.includes(key)) appliedFormulaInputs.current.delete(key)
    subKey.split(',').filter(Boolean).forEach((key, index) => {
      layoutSubPane(chart, key, containerRef.current?.clientWidth ?? 600, headerHeights.current, paneHeights.current, index, hasVolumeControls, SUB_CHARTS)
    })
    setVolumePane(activeIndicators.includes('vol') && hasVolumeControls ? chart.getDom('tsp_vol', 'main') : null)
    fitPaneHeights()
    chart.resize()
  }, [showMA, activeIndicators, volumeCompare.enabled, volumeCompare.days, period, theme, hasVolumeControls, indicatorResults, catalog.data, hiddenMaLines, managed])


  useEffect(() => {
    if (managed || !showMA || angel) return
    const figures = chartIndicators.find(i => i.name === 'TSP_MA')!.figures!
    chartRef.current?.overrideIndicator({ name: 'TSP_MA', figures: figures.filter(f => !hiddenMaLines.includes(f.key)) as IndicatorFigure[] })
  }, [managed, showMA, angel, hiddenMaLines])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    chart.overrideYAxis({
      paneId: 'candle_pane', gap: { top: 32, bottom: 32 },
      createRange: ({ defaultRange }) => {
        const values = priceLines.map(line => line.value).filter(value => Number.isFinite(value) && value > 0)
        const visible = chart.getVisibleRange()
        const dates = new Set(bars.slice(Math.max(0, visible.from), visible.to).map(bar => bar.date))
        for (const curve of priceCurves) for (const row of curve.data) {
          if (dates.has(row.date) && row.value != null && Number.isFinite(row.value)) values.push(row.value)
        }
        const from = Math.min(defaultRange.from, ...values)
        const to = Math.max(defaultRange.to, ...values)
        const range = to - from
        return { from, to, range, realFrom: from, realTo: to, realRange: range, displayFrom: from, displayTo: to, displayRange: range }
      },
    })
    chart.removeOverlay({ groupId: ANNOTATION_GROUP })
    const overlays = buildAnnotations(bars, showMarkers ? markers : [], ranges, priceLines.filter(line => !line.key), addedDate, linkedPrice, ct.text, onDateClick, precision)
    if (overlays.length) chart.createOverlay(overlays)
  }, [bars, markers, ranges, priceLines, priceCurves, showMarkers, addedDate, linkedPrice, theme, onDateClick, precision])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    chart.removeOverlay({ groupId: CHANLUN_GROUP })
    setStructureTooltip(null)
    const overlays = buildChanlunOverlays(bars, chanlunAnalysis, chanlunOverlay, ct.text, hideCurrentDate, setStructureTooltip, onDateClick)
    if (overlays.length) chart.createOverlay(overlays)
  }, [bars, chanlunAnalysis, chanlunOverlay, theme, hideCurrentDate, onDateClick])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const overlays = buildLevelOverlays(bars, priceLines, priceCurves, priceLabelWidth, highlightedKey, onHighlightChange, assetType)
    const existing = chart.getOverlays({ groupId: LEVEL_GROUP })
    const ids = new Set(overlays.map(overlay => overlay.id))
    for (const overlay of existing) if (!ids.has(overlay.id)) chart.removeOverlay({ id: overlay.id })
    const previous = new Set(existing.map(overlay => overlay.id))
    for (const overlay of overlays) {
      if (previous.has(overlay.id!)) chart.overrideOverlay(overlay)
      else chart.createOverlay(overlay)
    }
  }, [bars, priceLines, priceCurves, priceLabelWidth, highlightedKey, onHighlightChange, assetType, theme])

  useEffect(() => { chartRef.current?.resize() }, [chartHeight])

  const doubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const chart = chartRef.current
    if (chart?.getOverlays({ groupId: DRAWING_GROUP }).some(overlay => overlay.currentStep !== -1)) return
    const main = chart?.getDom('candle_pane', 'main')
    if (!chart || !main) return
    const rect = main.getBoundingClientRect()
    const x = event.clientX - rect.left, y = event.clientY - rect.top
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return
    const converted = chart.convertFromPixel([{ x, y }], { paneId: 'candle_pane' })
    const point = Array.isArray(converted) ? converted[0] : converted
    const price = point.value, current = barsRef.current.at(-1)?.close
    if (price != null && Number.isFinite(price) && price > 0 && current != null && current > 0) {
      callbacks.current.onPriceDoubleClick?.(price, current)
    }
  }

  const change = row && previous?.close > 0 ? (row.close - previous.close) / previous.close : undefined
  const amplitude = row && previous?.close > 0 && row.high >= row.low
    ? (row.high - row.low) / previous.close
    : undefined
  const selectRange = (from: number, to: number) => {
    const chart = chartRef.current
    const width = chart?.getSize('candle_pane', 'main')?.width
    if (!chart || !width || !bars.length) return
    userInteracted.current = true
    setVisibleRange({ from, to })
    const padding = Math.max(8, Math.min(priceLabelWidth, width * 0.4))
    chart.setBarSpace(Math.max(0.5, Math.min(40, (width - padding) / Math.max(1, to - from))))
    chart.scrollToDataIndex(to - 1)
    chart.scrollByDistance(-padding)
  }
  const applyLastPaneResize = (clientY: number) => {
    const chart = chartRef.current
    const drag = lastPaneResize.current
    if (!chart || !drag) return null
    const isMain = drag.key === 'main'
    const height = Math.min(2000, Math.max(isMain ? 120 : 50, Math.round(drag.startHeight + clientY - drag.startY)))
    for (const pane of drag.fixedPanes) {
      paneHeights.current.set(pane.key, pane.height)
      chart.setPaneOptions({
        id: `tsp_${pane.key.replaceAll('-', '_')}`,
        height: pane.height + pane.header,
        minHeight: pane.header + 50,
        dragEnabled: true,
      })
    }
    if (isMain) {
      mainPaneHeightRef.current = height
      setMainPaneHeight(height)
    } else paneHeights.current.set(drag.key, height)
    chart.setPaneOptions({
      id: isMain ? 'candle_pane' : `tsp_${drag.key.replaceAll('-', '_')}`,
      height: height + drag.header,
      minHeight: isMain ? 120 : drag.header + 50,
      dragEnabled: true,
    })
    const adjustment = drag.startChartHeightAdjustment + height - drag.startHeight
    setChartHeightAdjustment(adjustment)
    fitPaneHeights()
    return adjustment
  }
  const startLastPaneResize = (event: React.PointerEvent<HTMLDivElement>, main = false) => {
    if (event.button !== 0) return
    const chart = chartRef.current
    const key = main ? 'main' : subKeysRef.current.at(-1)
    if (!chart || !key) return
    const options = chart.getPaneOptions(main ? 'candle_pane' : `tsp_${key.replaceAll('-', '_')}`)
    const header = main ? 0 : headerHeights.current.get(key)
    if (!options || Array.isArray(options) || header == null) return
    const fixedPanes = subKeysRef.current.filter(otherKey => otherKey !== key).flatMap(otherKey => {
      const otherOptions = chart.getPaneOptions(`tsp_${otherKey.replaceAll('-', '_')}`)
      const otherHeader = headerHeights.current.get(otherKey)
      if (!otherOptions || Array.isArray(otherOptions) || otherHeader == null) return []
      const height = Math.max(50, otherOptions.height - otherHeader)
      paneHeights.current.set(otherKey, height)
      return [{ key: otherKey, height, header: otherHeader }]
    })
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    userInteracted.current = true
    const startHeight = main ? chart.getSize('candle_pane')?.height ?? 120 : Math.max(50, options.height - header)
    if (!main) paneHeights.current.set(key, startHeight)
    lastPaneResize.current = {
      pointerId: event.pointerId,
      key,
      startY: event.clientY,
      startHeight,
      startChartHeightAdjustment: chartHeight - (height - (showInfoBar ? 40 : 0)),
      header,
      fixedPanes,
    }
  }
  const moveLastPaneResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (lastPaneResize.current?.pointerId !== event.pointerId) return
    lastPaneResizeY.current = event.clientY
    if (lastPaneResizeFrame.current == null) {
      lastPaneResizeFrame.current = requestAnimationFrame(() => {
        lastPaneResizeFrame.current = null
        applyLastPaneResize(lastPaneResizeY.current)
      })
    }
  }
  const endLastPaneResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (lastPaneResize.current?.pointerId !== event.pointerId) return
    if (lastPaneResizeFrame.current != null) {
      cancelAnimationFrame(lastPaneResizeFrame.current)
      lastPaneResizeFrame.current = null
    }
    const adjustment = applyLastPaneResize(event.clientY)
    if (lastPaneResize.current.key === 'main' && mainPaneHeightRef.current != null) {
      storage.stockPreviewMainChartHeight.set(mainPaneHeightRef.current)
    }
    lastPaneResize.current = null
    storage.stockPreviewSubChartHeights.set(Object.fromEntries(paneHeights.current))
    if (adjustment != null) storage.stockPreviewChartHeightAdjustment.set(adjustment)
  }
  const turnover = row?.volume && stockInfo?.float_shares ? row.volume * 100 / stockInfo.float_shares * 100 : undefined
  return (
    <div className="w-full relative" onMouseLeave={() => { setHover(null); setStructureTooltip(null); onHighlightChange?.(null) }}>
      <div className="mb-2 flex flex-wrap items-start gap-x-3 gap-y-2">
        {toolbarControls}
        <ChartDrawingToolbar chart={chartInstance} symbol={symbol} period={period} ready={bars.length > 0} hidden={hideCurrentDate} />
      </div>
      {showInfoBar && (
        <div className="mb-2 min-h-10 rounded-md border border-border/30 bg-base/20 px-2 font-mono text-xs" style={{ color: ct.text }}>
          {row && <>
            <div className="flex min-h-5 flex-wrap items-center gap-x-1.5">
              {!hideCurrentDate && <span>{row.date}</span>}<span>开</span><span style={{ color: row.open >= row.close ? COLORS.bear : COLORS.bull }}>{price(row.open)}</span>
              <span>高</span><span style={{ color: COLORS.bull }}>{price(row.high)}</span>
              <span>低</span><span style={{ color: COLORS.bear }}>{price(row.low)}</span>
              <span>收</span><span style={{ color: (change ?? 0) >= 0 ? COLORS.bull : COLORS.bear }}>{price(row.close)}</span>
              {change != null && <span style={{ color: change >= 0 ? COLORS.bull : COLORS.bear }}>{fmtPct(change)}</span>}
              {amplitude != null && <><span>振幅</span><span>{(amplitude * 100).toFixed(2)}%</span></>}
              {turnover != null && <span>换手 {turnover.toFixed(2)}%</span>}
              {hoverIndex >= 0 && previous?.close > 0 && <>
                <span>至今</span><span>{fmtPct((bars.at(-1)!.close - previous.close) / previous.close)}</span>
                <span>周期 {bars.length - infoIndex}</span>
              </>}
            </div>
            <div className="flex min-h-5 flex-wrap items-center gap-x-2.5">
              {showMA && !angel && (['ma5', 'ma10', 'ma20', 'ma60'] as const).map(key => row[key] != null && (
                <button
                  key={key}
                  type="button"
                  aria-label={`${hiddenMaLines.includes(key) ? '显示' : '隐藏'} ${key.toUpperCase()}`}
                  aria-pressed={!hiddenMaLines.includes(key)}
                  title={`${hiddenMaLines.includes(key) ? '显示' : '隐藏'} ${key.toUpperCase()}均线`}
                  onClick={() => setHiddenMaLines(previous => previous.includes(key) ? previous.filter(item => item !== key) : [...previous, key])}
                  className={`rounded-sm transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${hiddenMaLines.includes(key) ? 'opacity-40' : ''}`}
                  style={{ color: COLORS[key] }}
                >{key.toUpperCase()}:{price(row[key])}</button>
              ))}
              {boll && (bollRow?.boll_upper ?? row.boll_upper) != null && <span style={{ color: '#E879F9' }}>BOLL:{price(bollRow ? bollRow.boll_upper : row.boll_upper)}/{price(bollRow ? bollRow.mid : row.ma20)}/{price(bollRow ? bollRow.boll_lower : row.boll_lower)}</span>}
              {angelRows && ANGEL_DEVIL_MA.map(ma => angelRows[infoIndex]?.[ma.key] != null && (
                <span key={ma.key} style={{ color: theme === 'light' ? ma.lightColor : ma.color }}>{ma.label}:{price(angelRows[infoIndex][ma.key])}</span>
              ))}
              {boll2Rows && BOLL2_LINES.map(line => boll2Rows[infoIndex]?.[line.key] != null && (
                <span key={line.key} style={{ color: theme === 'light' ? line.lightColor : line.color }}>{line.key === 'mid' ? 'boll2 ' : ''}{line.label}:{price(boll2Rows[infoIndex][line.key])}</span>
              ))}
              {Object.entries(indicatorResults ?? {}).flatMap(([key, packet]) => {
                if (packet.pane !== 'main' || !(key === 'ma' ? showMA && !angel : activeIndicators.includes(key))) return []
                const known: Record<string, string[]> = { ma: ['ma5','ma10','ma20','ma60'], boll: ['boll_upper','boll_lower'], 'angel-devil': ['ma5','ma13','ma21','ma34'], boll2: ['mid','upper','lower'] }
                const values = packet.rows[packet.dates.indexOf(row.date)]
                return packet.figures.filter(f => !f.hidden && !known[key]?.includes(f.key)).map(f => values?.[f.key] != null && <span key={`${key}-${f.key}`} style={{ color: formulaColor(f.color, f.light_color) }}>{packet.name} {f.key}:{price(values[f.key])}</span>)
              })}
            </div>
          </>}
        </div>
      )}
      <div className="relative w-full" style={{ height: chartHeight }}>
        {volumePane && activeIndicators.includes('vol') && volumeCompareControls && createPortal(
          <div className="absolute inset-x-0 top-7 z-10 flex h-[26px] items-center justify-end px-1" aria-label="成交量副图设置" onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
            {volumeCompareControls}
          </div>, volumePane,
        )}
        <div ref={containerRef} data-kline-chart className="h-full w-full" onDoubleClick={doubleClick}
          onPointerDown={() => { userInteracted.current = true }} onWheel={() => { userInteracted.current = true }} />
        {chartInstance?.getDom('candle_pane') && createPortal(<div
          role="separator" aria-label="调整主图高度" aria-orientation="horizontal"
          aria-valuemin={120} aria-valuemax={2000} aria-valuenow={mainPaneHeight ?? chartInstance.getSize('candle_pane')?.height ?? 120}
          title="拖动调整主图高度" tabIndex={0}
          className="group absolute bottom-0 left-0 z-20 h-2 w-full cursor-row-resize touch-none hover:bg-sky-400/10 active:bg-sky-400/20 focus-visible:bg-sky-400/10"
          onPointerDown={event => { event.stopPropagation(); startLastPaneResize(event, true) }}
          onPointerMove={moveLastPaneResize} onPointerUp={endLastPaneResize}
          onPointerCancel={endLastPaneResize} onLostPointerCapture={endLastPaneResize}
          onKeyDown={event => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
            event.preventDefault()
            const current = mainPaneHeightRef.current ?? chartInstance.getSize('candle_pane')?.height ?? 120
            const next = Math.min(2000, Math.max(120, current + (event.key === 'ArrowDown' ? 20 : -20)))
            userInteracted.current = true
            mainPaneHeightRef.current = next
            setMainPaneHeight(next)
            storage.stockPreviewMainChartHeight.set(next)
            fitPaneHeights()
          }}>
          <div className="mx-auto mt-0.5 h-0.5 w-10 rounded-full bg-border/60 transition-colors group-hover:bg-sky-400/70" />
        </div>, chartInstance.getDom('candle_pane')!)}
        {subKeysRef.current.length > 0 && <div
          role="separator" aria-label="调整最后一个副图高度" aria-orientation="horizontal"
          aria-valuemin={50} aria-valuemax={2000}
          aria-valuenow={paneHeights.current.get(subKeysRef.current.at(-1)!) ?? SUB_CHARTS.find(def => def.key === subKeysRef.current.at(-1))?.height ?? 90}
          tabIndex={0} className="group absolute bottom-0 left-0 z-10 h-2 w-full cursor-row-resize touch-none hover:bg-sky-400/10 active:bg-sky-400/20"
          onPointerDown={startLastPaneResize} onPointerMove={moveLastPaneResize} onPointerUp={endLastPaneResize}
          onPointerCancel={endLastPaneResize} onLostPointerCapture={endLastPaneResize}
          onKeyDown={event => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
            event.preventDefault()
            const key = subKeysRef.current.at(-1)
            const chart = chartRef.current
            if (!chart || !key) return
            const def = SUB_CHARTS.find(item => item.key === key)
            const current = paneHeights.current.get(key) ?? def?.height ?? 90
            const height = Math.min(2000, Math.max(50, current + (event.key === 'ArrowUp' ? 20 : -20)))
            const header = headerHeights.current.get(key) ?? 28
            paneHeights.current.set(key, height)
            chart.setPaneOptions({ id: `tsp_${key.replaceAll('-', '_')}`, height: height + header, minHeight: header + 50, dragEnabled: true })
            const adjustment = chartHeightAdjustment + height - current
            setChartHeightAdjustment(adjustment)
            storage.stockPreviewChartHeightAdjustment.set(adjustment)
            storage.stockPreviewSubChartHeights.set(Object.fromEntries(paneHeights.current))
            fitPaneHeights()
          }}>
          <div className="mx-auto h-0.5 w-10 rounded-full bg-transparent transition-colors group-hover:bg-sky-400/70" />
        </div>}
      </div>
      {structureTooltip && <div role="status" className="absolute top-10 right-2 z-20 max-w-xs rounded px-2 py-1 text-[10px] whitespace-pre-line pointer-events-none" style={{ color: ct.text, backgroundColor: ct.tooltipBg }}>{structureTooltip}</div>}
      {showRangeSelector && bars.length > 1 && <div className="mt-2 flex gap-3 rounded-md border border-border/30 bg-base/20 px-2 py-1 text-[10px] text-muted">
        <label className="flex min-w-0 flex-1 items-center gap-1 whitespace-nowrap">起点<input aria-label="可见起始K线" className="w-full min-w-0 accent-sky-500" type="range" min={0} max={bars.length - 1} value={Math.min(visibleRange.from, bars.length - 1)} onChange={event => selectRange(Number(event.target.value), Math.max(Number(event.target.value) + 1, visibleRange.to))} /></label>
        <label className="flex min-w-0 flex-1 items-center gap-1 whitespace-nowrap">终点<input aria-label="可见结束K线" className="w-full min-w-0 accent-sky-500" type="range" min={1} max={bars.length} value={Math.min(visibleRange.to, bars.length)} onChange={event => selectRange(Math.min(visibleRange.from, Number(event.target.value) - 1), Number(event.target.value))} /></label>
      </div>}
      {!bars.length && <div className="text-sm text-muted py-2">暂无有效日K数据</div>}
    </div>
  )
}

function chartPeriod(period: NonNullable<CandlestickProps['period']>) {
  return period === '30m' ? { span: 30, type: 'minute' as const }
    : { span: 1, type: period === '1w' ? 'week' as const : period === '1mo' ? 'month' as const : 'day' as const }
}

function layoutSubPane(chart: Chart, key: string, width: number, headers: Map<string, number>, heights: Map<string, number>, order?: number, volumeControls = false, definitions: { key: string; height: number }[] = DEFAULT_SUB_CHARTS) {
  const paneId = `tsp_${key.replaceAll('-', '_')}`
  const def = definitions.find(d => d.key === key)
  if (!def || !chart.getDom(paneId)) return
  const header = formulaHeaderHeight(key, chart.getSize(paneId, 'main')?.width ?? width) + (key === 'vol' && volumeControls ? 26 : 0)
  if (order == null && headers.get(key) === header) return
  headers.set(key, header)
  chart.setPaneOptions({ id: paneId, height: (heights.get(key) ?? def.height) + header, minHeight: header + 50, ...(order == null ? {} : { order: order + 1 }), dragEnabled: true })
  chart.overrideYAxis({ paneId, gap: { top: header, bottom: 4 } })
}
