import { useEffect, useMemo, useRef, useState } from 'react'
import { dispose, init, registerIndicator, registerOverlay, type Chart, type Crosshair, type KLineData } from 'klinecharts'
import { chartTheme, useTheme } from '@/lib/theme'
import { fmtAssetPrice, fmtPct, priceDigits } from '@/lib/format'
import { EChartsCandlestick, type CandlestickProps } from './EChartsCandlestick'
import {
  chartIndicators, classifyBarUpdate, COLORS, SUB_CHARTS, toChartBars,
  type ChartBar,
} from '@/lib/kline-chart'
import { annotationTemplate, ANNOTATION_GROUP, buildAnnotations } from '@/lib/kline-chart-overlays'

export { SUB_CHARTS, OVERLAY_INDICATORS } from './EChartsCandlestick'
export type { ChartMarker, ChartPriceLine, ChartRange, OHLC, VolumeCompareConfig } from '@/lib/kline-chart'

chartIndicators.forEach(indicator => registerIndicator(indicator))
registerOverlay(annotationTemplate)

const EMPTY: never[] = []
const DEFAULT_COMPARE = { enabled: true, days: 1 }

export function usesLegacyChart(props: CandlestickProps): boolean {
  return Boolean(props.hideCurrentDate
    || (props.chanlunAnalysis && props.chanlunOverlay?.enabled)
    || props.activeIndicators?.some(key => !['vol', 'macd', 'rsi', 'kdj', 'boll'].includes(key)))
}

/** 分阶段迁移：dev 的公式、缠论和隐藏日期调试继续走已经验证的原实现。 */
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
  const boll = activeIndicators.includes('boll')
  const chartHeight = Math.max(height - (showInfoBar ? 40 : 0), 150 + subKey.split(',').filter(Boolean).length * 100)

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
    chart.subscribeAction('onCrosshairChange', onCrosshair)
    chart.subscribeAction('onCandleBarClick', onCandleClick)
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
      chart.unsubscribeAction('onCrosshairChange', onCrosshair)
      chart.unsubscribeAction('onCandleBarClick', onCandleClick)
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
        type: 'candle_solid', bar: {
          upColor: COLORS.bull, downColor: COLORS.bear, noChangeColor: COLORS.bull,
          upBorderColor: COLORS.bull, downBorderColor: COLORS.bear, noChangeBorderColor: COLORS.bull,
          upWickColor: COLORS.bull, downWickColor: COLORS.bear, noChangeWickColor: COLORS.bull,
        },
        tooltip: { showRule: 'none' },
        priceMark: { high: { show: false }, low: { show: false }, last: { show: false } },
      },
      indicator: { tooltip: { legend: { color: ct.text, size: 10 }, title: { color: ct.text, size: 10 } } },
      xAxis: { tickText: { color: ct.text, size: 10 }, axisLine: { color: ct.border }, tickLine: { show: false } },
      yAxis: { tickText: { color: ct.text, size: 10 }, axisLine: { show: false }, tickLine: { show: false } },
      separator: { color: ct.border, activeBackgroundColor: ct.grid },
      crosshair: {
        horizontal: { line: { color: ct.crosshair }, text: { backgroundColor: ct.crosshairLabelBg, color: '#fff' } },
        vertical: { line: { color: ct.crosshair }, text: { backgroundColor: ct.crosshairLabelBg, color: '#fff' } },
      },
    })
  }, [theme])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const wanted = new Set([
      ...(showMA ? ['MA'] : []), ...(boll ? ['BOLL'] : []),
      ...subKey.split(',').filter(Boolean).map(key => key.toUpperCase()),
    ])
    for (const indicator of chart.getIndicators()) {
      if (!wanted.has(indicator.name.slice(4))) chart.removeIndicator({ id: indicator.id })
    }
    for (const key of wanted) {
      const name = `TSP_${key}`
      const existing = chart.getIndicators({ name })[0]
      const options = {
        name, paneId: key === 'MA' || key === 'BOLL' ? 'candle_pane' : `tsp_${key.toLowerCase()}`,
        ...(key === 'VOL' ? { extendData: volumeCompare.enabled, calcParams: [volumeCompare.days] } : {}),
      }
      if (existing) chart.overrideIndicator({ ...options, id: existing.id })
      else chart.createIndicator(options, true)
    }
    subKey.split(',').filter(Boolean).forEach((key, index) => {
      const def = SUB_CHARTS.find(d => d.key === key)!
      chart.setPaneOptions({ id: `tsp_${key}`, height: def.height + 20, minHeight: 50, order: index + 1, dragEnabled: true })
      chart.overrideYAxis({ paneId: `tsp_${key}`, gap: { top: 28, bottom: 4 } })
    })
    chart.resize()
  }, [showMA, boll, subKey, volumeCompare.enabled, volumeCompare.days])

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
              {showMA && (['ma5', 'ma10', 'ma20', 'ma60'] as const).map(key => row[key] != null && (
                <span key={key} style={{ color: COLORS[key] }}>{key.toUpperCase()}:{price(row[key])}</span>
              ))}
              {boll && row.boll_upper != null && <span style={{ color: '#E879F9' }}>BOLL:{price(row.boll_upper)}/{price(row.ma20)}/{price(row.boll_lower)}</span>}
            </div>
          </>}
        </div>
      )}
      <div ref={containerRef} data-kline-chart className="w-full" style={{ height: chartHeight }} onDoubleClick={doubleClick}
        onPointerDown={() => { userInteracted.current = true }} onWheel={() => { userInteracted.current = true }} />
      {!bars.length && <div className="text-sm text-muted py-2">暂无有效日K数据</div>}
    </div>
  )
}

function chartPeriod(period: NonNullable<CandlestickProps['period']>) {
  return period === '30m' ? { span: 30, type: 'minute' as const }
    : { span: 1, type: period === '1w' ? 'week' as const : period === '1mo' ? 'month' as const : 'day' as const }
}
