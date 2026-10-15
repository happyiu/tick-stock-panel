import { useEffect, useMemo, useRef, useState } from 'react'
import { dispose, init, registerIndicator, registerOverlay, type Chart, type Crosshair, type KLineData } from 'klinecharts'
import { chartTheme, useTheme } from '@/lib/theme'
import { fmtAssetPrice, fmtPct, priceDigits } from '@/lib/format'
import { EChartsCandlestick, SUB_CHARTS, type CandlestickProps } from './EChartsCandlestick'
import {
  chartIndicators, classifyBarUpdate, COLORS, toChartBars,
  type ChartBar,
} from '@/lib/kline-chart'
import { annotationTemplate, ANNOTATION_GROUP, buildAnnotations } from '@/lib/kline-chart-overlays'
import { formulaHeaderHeight, formulaIndicators, formulaName } from '@/lib/kline-chart-formulas'
import { ANGEL_DEVIL_MA, calculateAngelDevil } from '@/lib/angelDevil'
import { BOLL2_LINES, calculateBoll2 } from '@/lib/boll2'
import { storage } from '@/lib/storage'

export { SUB_CHARTS, OVERLAY_INDICATORS } from './EChartsCandlestick'
export type { ChartMarker, ChartPriceLine, ChartRange, OHLC, VolumeCompareConfig } from '@/lib/kline-chart'

chartIndicators.forEach(indicator => registerIndicator(indicator))
formulaIndicators.forEach(indicator => registerIndicator(indicator))
registerOverlay(annotationTemplate)

const EMPTY: never[] = []
const DEFAULT_COMPARE = { enabled: true, days: 1 }

export function usesLegacyChart(props: CandlestickProps): boolean {
  return Boolean(props.hideCurrentDate
    || (props.chanlunAnalysis && props.chanlunOverlay?.enabled)
    || props.activeIndicators?.some(key => !['vol', 'macd', 'rsi', 'kdj', 'boll',
      'angel-devil', 'boll2', 'kd-divergence', 'kd-enhanced', 'etf-swing-v2', 'bull-bear-trend-v2'].includes(key)))
}

/** 缠论和隐藏日期调试仍保留原实现，其余指标共用 KLineChart。 */
export function KLineCandlestick(props: CandlestickProps) {
  return usesLegacyChart(props) ? <EChartsCandlestick {...props} /> : <BasicKLineCandlestick {...props} />
}

function BasicKLineCandlestick({
  data, markers = EMPTY, ranges = EMPTY, priceLines = EMPTY, height = 480,
  showMA = true, showInfoBar = true, showMarkers = true, stockInfo, symbol = '', linkedPrice,
  onDateClick, onPriceDoubleClick, visibleBars = 60, activeIndicators = EMPTY,
  volumeCompare = DEFAULT_COMPARE, addedDate, assetType, period = '1d', selectedDate,
}: CandlestickProps) {
  const theme = useTheme()
  const ct = chartTheme(theme)
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<Chart | null>(null)
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
  const [minimumChartHeight, setMinimumChartHeight] = useState(150)
  const callbacks = useRef({ onDateClick, onPriceDoubleClick, visibleBars })
  callbacks.current = { onDateClick, onPriceDoubleClick, visibleBars }
  const precision = priceDigits(assetType)
  const price = (value: unknown) => fmtAssetPrice(typeof value === 'number' ? value : null, assetType)
  const [hover, setHover] = useState<{ symbol: string; date: string } | null>(null)
  const hoverIndex = hover?.symbol === symbol ? bars.findIndex(bar => bar.date === hover.date) : -1
  const infoIndex = hoverIndex >= 0 ? hoverIndex : bars.length - 1
  const row = bars[infoIndex]
  const previous = bars[infoIndex - 1]
  const subKey = activeIndicators.filter(key => SUB_CHARTS.some(def => def.key === key)).join(',')
  subKeysRef.current = subKey.split(',').filter(Boolean)
  const boll = activeIndicators.includes('boll')
  const angel = activeIndicators.includes('angel-devil')
  const boll2 = activeIndicators.includes('boll2')
  const angelRows = useMemo(() => angel ? calculateAngelDevil(bars.map(b => b.close)) : null, [bars, angel])
  const boll2Rows = useMemo(() => boll2 ? calculateBoll2(bars.map(b => b.close)) : null, [bars, boll2])
  const candleTrends = useMemo(() => new Map(bars.map((bar, i) => [bar.timestamp, angelRows?.[i]?.bull])), [bars, angelRows])
  const chartHeight = Math.max(height - (showInfoBar ? 40 : 0), minimumChartHeight)
  const fitPaneHeights = () => {
    // 恢复较大的副图或窄屏提示换行时，扩展画布，给主图留下120px。
    setMinimumChartHeight(142 + subKeysRef.current.reduce((total, key) => {
      const def = SUB_CHARTS.find(d => d.key === key)!
      return total + (paneHeights.current.get(key) ?? def.height) + (headerHeights.current.get(key) ?? 28) + 4
    }, 0))
  }

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
    const savedHeights = storage.stockPreviewSubChartHeights.get({})
    if (savedHeights && typeof savedHeights === 'object' && !Array.isArray(savedHeights)) {
      for (const { key } of SUB_CHARTS) {
        const value = savedHeights[key]
        if (typeof value === 'number' && Number.isFinite(value) && value >= 50 && value <= 2000) paneHeights.current.set(key, value)
      }
    }
    chart.setPaneOptions({ id: 'candle_pane', minHeight: 120 })
    let alive = true
    let frame = 0
    const fitView = () => {
      const width = chart.getSize('candle_pane', 'main')?.width ?? element.clientWidth
      const count = callbacks.current.visibleBars === 'all' ? barsRef.current.length : callbacks.current.visibleBars
      if (width <= 0 || !barsRef.current.length) return
      chart.setOffsetRightDistance(8)
      chart.setBarSpace(Math.max(0.5, Math.min(40, (width - 8) / Math.max(1, Math.min(count, barsRef.current.length)))))
      chart.scrollToRealTime()
      fitInitialView.current = false
    }
    // 右侧分时在日K就绪后才展开，首次布局宽度会再次变化。
    const observer = new ResizeObserver(() => {
      chart.resize()
      for (const key of subKeysRef.current) layoutSubPane(chart, key, element.clientWidth, headerHeights.current, paneHeights.current)
      fitPaneHeights()
      if (!userInteracted.current) fitView()
    })
    observer.observe(element)
    const onCrosshair = (value: unknown) => {
      const crosshair = value as Crosshair | undefined
      const bar = crosshair?.dataIndex != null ? barsRef.current[crosshair.dataIndex] : undefined
      if (bar) setHover(current => current?.symbol === previousSymbol.current && current.date === bar.date
        ? current : { symbol: previousSymbol.current, date: bar.date })
    }
    const onCandleClick = (value: unknown) => {
      const event = value as { dataIndex?: number }
      const bar = event?.dataIndex != null ? barsRef.current[event.dataIndex] : undefined
      if (bar) callbacks.current.onDateClick?.(bar.date)
    }
    const onPaneDrag = () => {
      userInteracted.current = true
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
    chart.subscribeAction('onCrosshairChange', onCrosshair)
    chart.subscribeAction('onCandleBarClick', onCandleClick)
    chart.subscribeAction('onPaneDrag', onPaneDrag)
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
      observer.disconnect()
      pushBar.current = null
      chartRef.current = null
      previousRef.current = []
      headerHeights.current.clear()
      paneHeights.current.clear()
      chart.unsubscribeAction('onCrosshairChange', onCrosshair)
      chart.unsubscribeAction('onCandleBarClick', onCandleClick)
      chart.unsubscribeAction('onPaneDrag', onPaneDrag)
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
      xAxis: { tickText: { color: ct.text, size: 10 }, axisLine: { color: ct.border }, tickLine: { show: false } },
      yAxis: { tickText: { color: ct.text, size: 10 }, axisLine: { show: false }, tickLine: { show: false } },
      separator: { size: 4, color: ct.border, activeBackgroundColor: ct.crosshair },
      crosshair: {
        horizontal: { line: { color: ct.crosshair }, text: { backgroundColor: ct.crosshairLabelBg, color: '#fff' } },
        vertical: { line: { color: ct.crosshair }, text: { backgroundColor: ct.crosshairLabelBg, color: '#fff' } },
      },
    })
  }, [theme, candleTrends])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const wanted = new Set([
      ...(angel ? ['angel-devil'] : showMA ? ['ma'] : []), ...(boll ? ['boll'] : []), ...(boll2 ? ['boll2'] : []),
      ...subKey.split(',').filter(Boolean),
    ].map(formulaName))
    for (const indicator of chart.getIndicators()) {
      if (!wanted.has(indicator.name)) chart.removeIndicator({ id: indicator.id })
    }
    for (const name of wanted) {
      const existing = chart.getIndicators({ name })[0]
      const key = name.slice(4)
      const options = {
        name, paneId: ['MA', 'BOLL', 'ANGEL_DEVIL', 'BOLL2'].includes(key) ? 'candle_pane' : `tsp_${key.toLowerCase()}`,
        ...(key === 'VOL' ? { extendData: volumeCompare.enabled, calcParams: [volumeCompare.days] }
          : { extendData: { period } }),
      }
      if (existing) chart.overrideIndicator({ ...options, id: existing.id })
      else chart.createIndicator(options, true)
    }
    subKey.split(',').filter(Boolean).forEach((key, index) => {
      layoutSubPane(chart, key, containerRef.current?.clientWidth ?? 600, headerHeights.current, paneHeights.current, index)
    })
    fitPaneHeights()
    chart.resize()
  }, [showMA, angel, boll, boll2, subKey, volumeCompare.enabled, volumeCompare.days, period, theme])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    chart.overrideYAxis({
      paneId: 'candle_pane', gap: { top: 0.08, bottom: 0.08 },
      createRange: ({ defaultRange }) => {
        const values = priceLines.map(line => line.value).filter(value => Number.isFinite(value) && value > 0)
        const from = Math.min(defaultRange.from, ...values)
        const to = Math.max(defaultRange.to, ...values)
        const range = to - from
        return { from, to, range, realFrom: from, realTo: to, realRange: range, displayFrom: from, displayTo: to, displayRange: range }
      },
    })
    chart.removeOverlay({ groupId: ANNOTATION_GROUP })
    const overlays = buildAnnotations(bars, showMarkers ? markers : [], ranges, priceLines, addedDate, linkedPrice, ct.text, onDateClick, precision)
    if (overlays.length) chart.createOverlay(overlays)
  }, [bars, markers, ranges, priceLines, showMarkers, addedDate, linkedPrice, theme, onDateClick, precision])

  useEffect(() => { chartRef.current?.resize() }, [chartHeight])

  const doubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const chart = chartRef.current
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
  const turnover = row?.volume && stockInfo?.float_shares ? row.volume * 100 / stockInfo.float_shares * 100 : undefined
  return (
    <div className="w-full" onMouseLeave={() => setHover(null)}>
      {showInfoBar && (
        <div className="min-h-10 px-2 font-mono text-[11px]" style={{ backgroundColor: ct.infoBarBg, color: ct.text }}>
          {row && <>
            <div className="flex min-h-5 flex-wrap items-center gap-x-1.5">
              <span>{row.date}</span><span>开</span><span style={{ color: row.open >= row.close ? COLORS.bear : COLORS.bull }}>{price(row.open)}</span>
              <span>高</span><span style={{ color: COLORS.bull }}>{price(row.high)}</span>
              <span>低</span><span style={{ color: COLORS.bear }}>{price(row.low)}</span>
              <span>收</span><span style={{ color: (change ?? 0) >= 0 ? COLORS.bull : COLORS.bear }}>{price(row.close)}</span>
              {change != null && <span style={{ color: change >= 0 ? COLORS.bull : COLORS.bear }}>{fmtPct(change)}</span>}
              {turnover != null && <span>换手 {turnover.toFixed(2)}%</span>}
              {hoverIndex >= 0 && previous?.close > 0 && <>
                <span>至今</span><span>{fmtPct((bars.at(-1)!.close - previous.close) / previous.close)}</span>
                <span>周期 {bars.length - infoIndex}</span>
              </>}
            </div>
            <div className="flex min-h-5 flex-wrap items-center gap-x-2.5">
              {showMA && !angel && (['ma5', 'ma10', 'ma20', 'ma60'] as const).map(key => row[key] != null && (
                <span key={key} style={{ color: COLORS[key] }}>{key.toUpperCase()}:{price(row[key])}</span>
              ))}
              {boll && row.boll_upper != null && <span style={{ color: '#E879F9' }}>BOLL:{price(row.boll_upper)}/{price(row.ma20)}/{price(row.boll_lower)}</span>}
              {angelRows && ANGEL_DEVIL_MA.map(ma => angelRows[infoIndex]?.[ma.key] != null && (
                <span key={ma.key} style={{ color: theme === 'light' ? ma.lightColor : ma.color }}>{ma.label}:{price(angelRows[infoIndex][ma.key])}</span>
              ))}
              {boll2Rows && BOLL2_LINES.map(line => boll2Rows[infoIndex]?.[line.key] != null && (
                <span key={line.key} style={{ color: theme === 'light' ? line.lightColor : line.color }}>{line.key === 'mid' ? 'boll2 ' : ''}{line.label}:{price(boll2Rows[infoIndex][line.key])}</span>
              ))}
            </div>
          </>}
        </div>
      )}
      <div ref={containerRef} data-kline-chart className="w-full" style={{ height: chartHeight }} onDoubleClick={doubleClick}
        onPointerDown={() => { userInteracted.current = true }} onWheel={() => { userInteracted.current = true }} />
      {subKey && <div className="px-2 py-1 text-right text-[10px] text-muted">上下拖动副图之间的分隔线可调整高度</div>}
      {!bars.length && <div className="text-sm text-muted py-2">暂无有效日K数据</div>}
    </div>
  )
}

function chartPeriod(period: NonNullable<CandlestickProps['period']>) {
  return period === '30m' ? { span: 30, type: 'minute' as const }
    : { span: 1, type: period === '1w' ? 'week' as const : period === '1mo' ? 'month' as const : 'day' as const }
}

function layoutSubPane(chart: Chart, key: string, width: number, headers: Map<string, number>, heights: Map<string, number>, order?: number) {
  const paneId = `tsp_${key.replaceAll('-', '_')}`
  const def = SUB_CHARTS.find(d => d.key === key)
  if (!def || !chart.getDom(paneId)) return
  const header = formulaHeaderHeight(key, chart.getSize(paneId, 'main')?.width ?? width)
  if (order == null && headers.get(key) === header) return
  headers.set(key, header)
  chart.setPaneOptions({ id: paneId, height: (heights.get(key) ?? def.height) + header, minHeight: header + 50, ...(order == null ? {} : { order: order + 1 }), dragEnabled: true })
  chart.overrideYAxis({ paneId, gap: { top: header, bottom: 4 } })
}
