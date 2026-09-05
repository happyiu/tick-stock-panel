import { useCallback, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, Settings2 } from 'lucide-react'
import { type KlinePeriod, type KlineRow } from '@/lib/api'
import type { ChanlunAnalysis } from '@/lib/chanlun'
import { DEFAULT_30M_DAYS, defaultKlineRange, klinePeriodQueryOptions } from '@/lib/kline'
import { ChartDataNotice } from '@/components/ChartDataNotice'
import { storage, type StockPreviewChanlunOverlayConfig } from '@/lib/storage'
import {
  EChartsCandlestick,
  OVERLAY_INDICATORS,
  SUB_CHARTS,
  type ChartMarker,
  type ChartPriceLine,
  type ChartRange,
  type OHLC,
  type VolumeCompareConfig,
} from '@/components/EChartsCandlestick'

const SUB_INFO_H = 16
const SUB_GAP = 4
const DEFAULT_VOLUME_COMPARE: VolumeCompareConfig = { enabled: true, days: 1 }
const DEFAULT_CHANLUN_OVERLAY: StockPreviewChanlunOverlayConfig = {
  enabled: true,
  fractals: false,
  strokes: true,
  centers: true,
  candidates: true,
}

function normalizeVolumeCompare(config: VolumeCompareConfig): VolumeCompareConfig {
  return {
    enabled: config.enabled !== false,
    days: Math.max(1, Math.min(20, Math.round(Number(config.days) || 1))),
  }
}

function normalizeChanlunOverlay(config: StockPreviewChanlunOverlayConfig): StockPreviewChanlunOverlayConfig {
  return {
    enabled: config?.enabled !== false,
    fractals: config?.fractals === true,
    strokes: config?.strokes !== false,
    centers: config?.centers !== false,
    candidates: config?.candidates !== false,
  }
}

interface Props {
  symbol: string
  height?: number
  className?: string
  dateRange?: { start: string; end: string }
  markers?: ChartMarker[]
  ranges?: ChartRange[]
  priceLines?: ChartPriceLine[]
  showLimitMarkers?: boolean
  showIndicatorControls?: boolean
  showMarkerToggle?: boolean
  showMA?: boolean
  showInfoBar?: boolean
  visibleBars?: number
  linkedPrice?: number | null
  onDateClick?: (date: string) => void
  onPriceDoubleClick?: (price: number, currentPrice: number) => void
  /** 扩展数据列参数（逗号分隔 config_id.field_name），透传给 klineDaily 接口 */
  extColumns?: string
  /** 日K自动刷新间隔(ms)。undefined = 不轮询(默认)。个股对话框实时刷新时传入, 盘中今日蜡烛随之更新 */
  refetchIntervalMs?: number
  period?: KlinePeriod
  periodDays?: number
  /** 当前周期、当前历史截面的缠论结构近似结果；未传入时不显示相关控件和覆盖层。 */
  chanlunAnalysis?: ChanlunAnalysis
}

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
      volume: Number(r.volume ?? 0),
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

export function StockDailyKChart({
  symbol,
  height = 520,
  className,
  dateRange: externalDateRange,
  markers,
  ranges,
  priceLines,
  showLimitMarkers = true,
  showIndicatorControls = true,
  showMarkerToggle = true,
  showMA = true,
  showInfoBar = true,
  visibleBars = 60,
  linkedPrice,
  onDateClick,
  onPriceDoubleClick,
  extColumns,
  refetchIntervalMs,
  period = '1d',
  periodDays = DEFAULT_30M_DAYS,
  chanlunAnalysis,
}: Props) {
  const [activeIndicators, setActiveIndicators] = useState<string[]>(['vol'])
  const [showMarkers, setShowMarkers] = useState(true)
  const [volumeCompare, setVolumeCompare] = useState<VolumeCompareConfig>(() =>
    normalizeVolumeCompare(storage.stockVolumeCompare.get(DEFAULT_VOLUME_COMPARE)),
  )
  const [chanlunMenuOpen, setChanlunMenuOpen] = useState(false)
  const [chanlunOverlay, setChanlunOverlay] = useState<StockPreviewChanlunOverlayConfig>(() =>
    normalizeChanlunOverlay(storage.stockPreviewChanlunOverlay.get(DEFAULT_CHANLUN_OVERLAY)),
  )
  const dateRange = externalDateRange ?? defaultKlineRange(period)

  // 日K仍与 StockPanel 信息条共享 cache key；其余周期走独立、含 period 的查询键。
  const kline = useQuery({
    ...klinePeriodQueryOptions(symbol, period, dateRange, periodDays, extColumns),
    enabled: !!symbol,
    refetchInterval: refetchIntervalMs,
  })

  const rows = useMemo(() => toOHLC(kline.data?.rows ?? [], period), [kline.data?.rows, period])
  const stockInfo = kline.data?.stock_info
  const limitMarkers = useMemo(() => buildLimitUpMarkers(kline.data?.rows ?? []), [kline.data?.rows])
  const effectiveShowLimitMarkers = showLimitMarkers && period === '1d'
  const allMarkers = useMemo(() => [
    ...(markers ?? []),
    ...(effectiveShowLimitMarkers ? limitMarkers : []),
  ], [effectiveShowLimitMarkers, limitMarkers, markers])

  const toggleIndicator = useCallback((key: string) => {
    setActiveIndicators(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key])
  }, [])

  const updateVolumeCompare = useCallback((patch: Partial<VolumeCompareConfig>) => {
    setVolumeCompare(prev => {
      const next = normalizeVolumeCompare({ ...prev, ...patch })
      storage.stockVolumeCompare.set(next)
      return next
    })
  }, [])

  const updateChanlunOverlay = useCallback((patch: Partial<StockPreviewChanlunOverlayConfig>) => {
    setChanlunOverlay(previous => {
      const next = normalizeChanlunOverlay({ ...previous, ...patch })
      storage.stockPreviewChanlunOverlay.set(next)
      return next
    })
  }, [])

  const activeSubDefs = activeIndicators
    .map(key => SUB_CHARTS.find(s => s.key === key))
    .filter((d): d is typeof SUB_CHARTS[number] => !!d)
  let subExtraH = 0
  activeSubDefs.forEach(def => { subExtraH += SUB_INFO_H + def.height })
  if (activeSubDefs.length > 0) subExtraH += activeSubDefs.length * SUB_GAP + 14
  const chartHeight = height + subExtraH

  if (!symbol) return null

  return (
    <div className={className} style={{ minHeight: chartHeight }}>
      <ChartDataNotice status={kline.data?.data_status} />
      {showIndicatorControls && rows.length > 0 && (
        <div className="flex items-center gap-1.5 px-1 pb-0.5">
          {SUB_CHARTS.map(ind => (
            <button
              key={ind.key}
              onClick={() => toggleIndicator(ind.key)}
              className={`px-2 py-0.5 rounded text-[10px] font-mono cursor-pointer transition-colors ${
                activeIndicators.includes(ind.key)
                  ? 'bg-accent/20 text-accent'
                  : 'bg-elevated text-muted hover:text-secondary'
              }`}
            >
              {ind.label}
            </button>
          ))}
          {OVERLAY_INDICATORS.map(ind => (
            <button
              key={ind.key}
              onClick={() => toggleIndicator(ind.key)}
              className={`px-2 py-0.5 rounded text-[10px] font-mono cursor-pointer transition-colors ${
                activeIndicators.includes(ind.key)
                  ? 'bg-accent/20 text-accent'
                  : 'bg-elevated text-muted hover:text-secondary'
              }`}
            >
              {ind.label}
            </button>
          ))}
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
                className={`rounded-l px-2 py-0.5 text-[10px] font-mono transition-colors ${
                  chanlunOverlay.enabled
                    ? 'bg-[#8B5CF6]/20 text-[#A78BFA]'
                    : 'bg-elevated text-muted hover:text-secondary'
                }`}
                aria-pressed={chanlunOverlay.enabled}
                title={chanlunOverlay.enabled ? '隐藏缠论覆盖层' : '显示缠论覆盖层'}
              >
                缠论
              </button>
              <button
                type="button"
                onClick={() => setChanlunMenuOpen(value => !value)}
                className="rounded-r border-l border-border/60 bg-elevated px-1.5 py-0.5 text-muted transition-colors hover:text-secondary"
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
                    ['centers', '中枢'],
                    ['candidates', '三类候选'],
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
          {activeIndicators.includes('vol') && (
            <div className="ml-0.5 flex h-5 items-center gap-1.5 border-l border-border/70 pl-2">
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
                className="h-5 rounded border border-border bg-base px-1 text-[10px] text-secondary outline-none disabled:opacity-40"
              >
                {Array.from({ length: 20 }, (_, index) => index + 1).map(days => (
                  <option key={days} value={days}>前{days}日均量</option>
                ))}
              </select>
            </div>
          )}
          {showMarkerToggle && effectiveShowLimitMarkers && (
            <button
              onClick={() => setShowMarkers(v => !v)}
              className={`ml-auto px-2 py-0.5 rounded text-[10px] font-mono cursor-pointer transition-colors ${
                showMarkers
                  ? 'text-[#FACC15] bg-[#FACC15]/10'
                  : 'bg-elevated text-muted hover:text-secondary'
              }`}
            >
              异动
            </button>
          )}
        </div>
      )}
      {kline.isLoading && <div className="text-sm text-muted py-4">加载中…</div>}
      {kline.isError && <div className="text-sm text-danger py-2">K线加载失败</div>}
      {!kline.isLoading && !kline.isError && (kline.data?.rows?.length ?? 0) === 0 && (
        <div className="flex items-center justify-center text-sm text-muted" style={{ height }}>
          {period === '30m' ? '暂无30分钟K数据，请检查图表行情数据源' : '暂无该周期K线数据'}
        </div>
      )}
      {!kline.isLoading && !kline.isError && (kline.data?.rows?.length ?? 0) > 0 && rows.length === 0 && (
        <div className="text-sm text-danger py-2">数据格式异常，请刷新页面</div>
      )}
      {rows.length > 0 && (
        <EChartsCandlestick
          data={rows}
          markers={allMarkers}
          ranges={ranges}
          priceLines={priceLines}
          height={chartHeight - 22}
          showMA={showMA}
          showInfoBar={showInfoBar}
          showMarkers={showMarkers}
          stockInfo={stockInfo}
          symbol={symbol}
          assetType={kline.data?.asset_type}
          linkedPrice={linkedPrice}
          onDateClick={onDateClick}
          onPriceDoubleClick={onPriceDoubleClick}
          visibleBars={visibleBars}
          activeIndicators={activeIndicators}
          volumeCompare={volumeCompare}
          chanlunAnalysis={chanlunAnalysis}
          chanlunOverlay={chanlunOverlay}
        />
      )}
    </div>
  )
}
