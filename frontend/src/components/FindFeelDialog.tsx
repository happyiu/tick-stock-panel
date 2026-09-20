import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as echarts from 'echarts'
import { ChevronLeft, Dices, Grip, RotateCcw, X } from 'lucide-react'
import { type KlinePeriod, type KlineRow } from '@/lib/api'
import { normalizeKlineBarKey } from '@/lib/kline'
import { useChartTheme } from '@/lib/theme'
import {
  FIND_FEEL_QUANTITY,
  applyFindFeelAction,
  createFindFeelSession,
  getFindFeelActionAvailability,
  getFindFeelMaxQuantity,
  normalizeFindFeelBars,
  type FindFeelAction,
  type FindFeelEquityPoint,
  type FindFeelPhase,
  type FindFeelSession,
  type FindFeelStartMode,
} from '@/lib/findFeel'

interface FindFeelLockContext {
  period: KlinePeriod
  dateRange: { start: string; end: string }
  periodDays: number
  hideCurrentDate: boolean
}

interface Props {
  open: boolean
  symbol: string
  name?: string
  assetType?: 'stock' | 'etf' | 'index'
  period: KlinePeriod
  dateRange: { start: string; end: string }
  periodDays: number
  rows: KlineRow[]
  selectedDate: string | null
  onLock: (context: FindFeelLockContext) => void
  onProgress: (date: string | null, phase: 'setup' | FindFeelPhase) => void
  onClose: () => void
}

const DEFAULT_CASH = '1000000'
const DEFAULT_STEPS = '20'

function money(value: number): string {
  return `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function percent(value: number, signed = true): string {
  const amount = `${(value * 100).toFixed(2)}%`
  return signed && value > 0 ? `+${amount}` : amount
}

function formatBarKey(value: string, period: KlinePeriod): string {
  return period === '30m' ? value.slice(5, 16) : value.slice(0, 10)
}

function quickQuantity(maxQuantity: number, ratio: 0.25 | 0.5 | 'all'): number {
  if (maxQuantity < FIND_FEEL_QUANTITY) return 0
  if (ratio === 'all') return maxQuantity
  return Math.max(FIND_FEEL_QUANTITY, Math.floor((maxQuantity * ratio) / FIND_FEEL_QUANTITY) * FIND_FEEL_QUANTITY)
}

function valueTone(value: number): string {
  return value > 0 ? 'text-bull' : value < 0 ? 'text-bear' : 'text-foreground'
}

function EquityCurve({ points }: { points: FindFeelEquityPoint[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const theme = useChartTheme()

  useEffect(() => {
    if (!ref.current || !points.length) return
    const chart = echarts.init(ref.current)
    const resizeObserver = new ResizeObserver(() => chart.resize())
    resizeObserver.observe(ref.current)
    chart.setOption({
      animation: false,
      grid: { left: 56, right: 16, top: 16, bottom: 28 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: theme.tooltipBg,
        borderColor: theme.tooltipBorder,
        textStyle: { color: theme.tooltipText },
        formatter: (params: unknown) => {
          const item = Array.isArray(params) ? params[0] as { data?: number; axisValue?: string } : undefined
          return `${item?.axisValue ?? ''}<br/>总资产：${money(Number(item?.data ?? 0))}`
        },
      },
      xAxis: {
        type: 'category',
        data: points.map(point => point.step === 0 ? '开始' : `第${point.step}步`),
        axisLabel: { color: theme.text, fontSize: 10 },
        axisLine: { lineStyle: { color: theme.border } },
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLabel: { color: theme.text, fontSize: 10 },
        splitLine: { lineStyle: { color: theme.grid } },
      },
      series: [{
        name: '总资产',
        type: 'line',
        symbol: 'circle',
        symbolSize: 5,
        data: points.map(point => point.equity),
        lineStyle: { color: '#3B82F6', width: 2 },
        itemStyle: { color: '#3B82F6' },
        areaStyle: { color: 'rgba(59,130,246,0.10)' },
      }],
    })
    return () => {
      resizeObserver.disconnect()
      chart.dispose()
    }
  }, [points, theme])

  return <div ref={ref} className="h-44 w-full" />
}

function MetricCard({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: string }) {
  return (
    <div className="min-w-0 rounded-btn border border-border/70 bg-base/45 px-2.5 py-2">
      <div className="truncate text-[10px] text-muted">{label}</div>
      <div className={`mt-1 truncate font-mono text-[13px] font-semibold tabular-nums ${tone ?? 'text-foreground'}`}>{value}</div>
      {detail && <div className="mt-0.5 truncate text-[9px] text-muted">{detail}</div>}
    </div>
  )
}

function DragHandle({ onPointerDown, onPointerMove, onPointerUp, onPointerCancel }: {
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void
  onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void
}) {
  return (
    <div
      className="flex min-w-0 flex-1 touch-none cursor-move items-center gap-2 select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      style={{ touchAction: 'none' }}
    >
      <Grip className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
      <span className="truncate text-xs font-semibold text-foreground">调试</span>
    </div>
  )
}

export function FindFeelDialog({
  open,
  symbol,
  name,
  assetType,
  period,
  dateRange,
  periodDays,
  rows,
  selectedDate,
  onLock,
  onProgress,
  onClose,
}: Props) {
  const [initialCash, setInitialCash] = useState(DEFAULT_CASH)
  const [targetSteps, setTargetSteps] = useState(DEFAULT_STEPS)
  const [startMode, setStartMode] = useState<FindFeelStartMode>('random')
  const [hideCurrentDate, setHideCurrentDate] = useState(false)
  const [buyQuantity, setBuyQuantity] = useState(FIND_FEEL_QUANTITY)
  const [sellQuantity, setSellQuantity] = useState(FIND_FEEL_QUANTITY)
  const [session, setSession] = useState<FindFeelSession | null>(null)
  const [sessionBars, setSessionBars] = useState<ReturnType<typeof normalizeFindFeelBars>>([])
  const [formError, setFormError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const positionRef = useRef(position)
  const panelRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; position: { x: number; y: number } } | null>(null)
  const [dragging, setDragging] = useState(false)

  const availableBars = useMemo(() => normalizeFindFeelBars(rows, period), [period, rows])
  const normalizedSelectedDate = selectedDate ? normalizeKlineBarKey(selectedDate, period) : ''
  const selectedBar = availableBars.find(bar => bar.key === normalizedSelectedDate)
  const startHint = selectedBar
    ? `当前选中：${formatBarKey(selectedBar.key, period)} · 收盘 ${selectedBar.close}`
    : '未选中已收盘 K 线，将回退到最新已收盘 K 线'

  const updatePosition = useCallback((next: { x: number; y: number }) => {
    positionRef.current = next
    setPosition(next)
  }, [])

  const clampPosition = useCallback((nextX: number, nextY: number) => {
    const panel = panelRef.current
    const host = panel?.parentElement
    if (!panel || !host) return { x: nextX, y: nextY }
    const hostRect = host.getBoundingClientRect()
    const panelRect = panel.getBoundingClientRect()
    const current = positionRef.current
    const baseLeft = panelRect.left - current.x
    const baseTop = panelRect.top - current.y
    const minX = hostRect.left + 8 - baseLeft
    const maxX = hostRect.right - 8 - panelRect.width - baseLeft
    const minY = hostRect.top + 8 - baseTop
    const maxY = hostRect.bottom - 8 - panelRect.height - baseTop
    return {
      x: Math.max(minX, Math.min(maxX, nextX)),
      y: Math.max(minY, Math.min(maxY, nextY)),
    }
  }, [])

  const handleDragStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      position: positionRef.current,
    }
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [])

  const handleDragMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    updatePosition(clampPosition(
      drag.position.x + event.clientX - drag.startX,
      drag.position.y + event.clientY - drag.startY,
    ))
  }, [clampPosition, updatePosition])

  const handleDragEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    updatePosition(clampPosition(positionRef.current.x, positionRef.current.y))
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }, [clampPosition, updatePosition])

  useEffect(() => {
    if (!open) return
    const resize = () => updatePosition(clampPosition(positionRef.current.x, positionRef.current.y))
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [clampPosition, open, updatePosition])

  useEffect(() => {
    if (!open) {
      setSession(null)
      setSessionBars([])
      setFormError(null)
      setActionError(null)
      updatePosition({ x: 0, y: 0 })
    }
  }, [open, updatePosition])

  const close = useCallback(() => {
    onProgress(null, 'setup')
    onClose()
  }, [onClose, onProgress])

  const restart = useCallback(() => {
    setSession(null)
    setSessionBars([])
    setFormError(null)
    setActionError(null)
    setBuyQuantity(FIND_FEEL_QUANTITY)
    setSellQuantity(FIND_FEEL_QUANTITY)
    updatePosition({ x: 0, y: 0 })
    onProgress(null, 'setup')
  }, [onProgress, updatePosition])

  const start = useCallback(() => {
    setFormError(null)
    if (assetType === 'index') {
      setFormError('指数暂不支持调试。')
      return
    }
    const bars = availableBars.map(bar => ({ ...bar }))
    if (!bars.length) {
      setFormError('当前周期和时间范围内没有已收盘 K 线。')
      return
    }
    try {
      const next = createFindFeelSession({
        initialCash: Number(initialCash),
        targetSteps: Number(targetSteps),
        bars,
        mode: startMode,
        period,
        selectedBarKey: normalizedSelectedDate || null,
      })
      setSessionBars(bars)
      setSession(next)
      setActionError(null)
      setBuyQuantity(FIND_FEEL_QUANTITY)
      setSellQuantity(FIND_FEEL_QUANTITY)
      onLock({ period, dateRange: { ...dateRange }, periodDays, hideCurrentDate })
      onProgress(next.currentBarKey, next.phase)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '调试设置无效。')
    }
  }, [assetType, availableBars, dateRange, hideCurrentDate, initialCash, normalizedSelectedDate, onLock, onProgress, period, periodDays, startMode, targetSteps])

  const takeAction = useCallback((action: FindFeelAction, quantity = FIND_FEEL_QUANTITY) => {
    if (!session) return
    const result = applyFindFeelAction(session, sessionBars, action, quantity)
    if (!result.accepted) {
      setActionError(result.reason ?? '当前操作不可用。')
      return
    }
    setActionError(null)
    setSession(result.session)
    setBuyQuantity(FIND_FEEL_QUANTITY)
    setSellQuantity(FIND_FEEL_QUANTITY)
    onProgress(result.session.currentBarKey, result.session.phase)
  }, [onProgress, session, sessionBars])

  if (!open) return null

  const buyMaxQuantity = session ? getFindFeelMaxQuantity(session, 'buy') : 0
  const sellMaxQuantity = session ? getFindFeelMaxQuantity(session, 'sell') : 0
  const buyAvailability = session ? getFindFeelActionAvailability(session, buyQuantity) : null
  const sellAvailability = session ? getFindFeelActionAvailability(session, sellQuantity) : null
  const isPlaying = session?.phase === 'playing'

  return (
    <div
      ref={panelRef}
      role="region"
      aria-label="调试面板"
      className={`relative flex max-h-[min(520px,70vh)] min-h-0 w-full max-w-full shrink-0 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-lg md:h-full md:max-h-full md:w-[min(340px,32%)] ${dragging ? 'transition-none' : 'transition-transform duration-150'}`}
      style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)` }}
    >
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-elevated/70 px-3 py-2.5">
          <DragHandle
            onPointerDown={handleDragStart}
            onPointerMove={handleDragMove}
            onPointerUp={handleDragEnd}
            onPointerCancel={handleDragEnd}
          />
          {name && <span className="hidden max-w-28 truncate text-[10px] text-muted sm:inline">{symbol} · {name}</span>}
          <button type="button" onClick={close} className="rounded-btn p-1 text-muted transition-colors hover:bg-surface hover:text-foreground" aria-label="关闭调试" title="关闭">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {!session ? (
          <div className="min-h-0 overflow-y-auto p-3.5">
            <div className="mb-3 rounded-btn border border-accent/20 bg-accent/5 px-3 py-2 text-[10px] leading-4 text-secondary">
              每次操作按当前收盘价成交并推进一根 K 线；只做多、不计手续费和滑点。未收盘 K 线不会参与本局。
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-[11px] text-secondary">本金（元）</span>
                <input
                  type="number"
                  min="0.01"
                  step="100"
                  value={initialCash}
                  onChange={event => setInitialCash(event.target.value)}
                  className="h-8 w-full rounded-btn border border-border bg-base px-2.5 font-mono text-xs text-foreground outline-none focus:border-accent"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-secondary">推进根数</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={targetSteps}
                  onChange={event => setTargetSteps(event.target.value)}
                  className="h-8 w-full rounded-btn border border-border bg-base px-2.5 font-mono text-xs text-foreground outline-none focus:border-accent"
                />
              </label>
            </div>

            <div className="mt-3">
              <div className="mb-1 text-[11px] text-secondary">初始 K 线</div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setStartMode('random')}
                  className={`flex items-center justify-center gap-1.5 rounded-btn border px-2 py-2 text-xs transition-colors ${startMode === 'random' ? 'border-accent bg-accent/10 text-accent' : 'border-border text-secondary hover:border-accent/50'}`}
                >
                  <Dices className="h-3.5 w-3.5" />随机
                </button>
                <button
                  type="button"
                  onClick={() => setStartMode('selected')}
                  className={`flex items-center justify-center gap-1.5 rounded-btn border px-2 py-2 text-xs transition-colors ${startMode === 'selected' ? 'border-accent bg-accent/10 text-accent' : 'border-border text-secondary hover:border-accent/50'}`}
                >
                  当前选中
                </button>
              </div>
              <div className="mt-1.5 text-[10px] leading-4 text-muted">{startHint}</div>
            </div>

            <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-btn border border-border/70 bg-base/35 px-2.5 py-2">
              <input
                type="checkbox"
                checked={hideCurrentDate}
                onChange={event => setHideCurrentDate(event.target.checked)}
                className="mt-0.5 accent-accent"
              />
              <span className="min-w-0">
                <span className="block text-[11px] text-secondary">隐藏当前 K 线日期</span>
                <span className="mt-0.5 block text-[10px] leading-4 text-muted">隐藏调试过程中当前推进 K 线的日期展示</span>
              </span>
            </label>

            <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-muted">
              <div>周期：<span className="font-mono text-secondary">{period === '30m' ? '30F' : period === '1d' ? '日 K' : period === '1w' ? '周 K' : '月 K'}</span></div>
              <div>范围：<span className="font-mono text-secondary">{dateRange.start} ~ {dateRange.end}</span></div>
              <div className="col-span-2">可用已收盘 K 线：<span className="font-mono text-secondary">{availableBars.length}</span> 根</div>
            </div>
            {formError && <div className="mt-3 rounded-btn border border-bear/30 bg-bear/10 px-2.5 py-2 text-[10px] leading-4 text-bear">{formError}</div>}

            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={close} className="inline-flex h-8 items-center gap-1 rounded-btn border border-border px-3 text-xs text-secondary transition-colors hover:border-accent/50 hover:text-foreground">取消</button>
              <button type="button" onClick={start} className="inline-flex h-8 items-center gap-1 rounded-btn bg-accent px-3 text-xs font-medium text-white transition-colors hover:bg-accent/90">确认开始</button>
            </div>
          </div>
        ) : (
          <div className="min-h-0 overflow-y-auto p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted">
              <span>已推进 <span className="font-mono text-secondary">{session.completedSteps} / {session.targetSteps}</span> 根</span>
              <span>当前 K 线 <span className="font-mono text-secondary">{hideCurrentDate ? '已隐藏' : formatBarKey(session.currentBarKey, period)}</span> · 收盘 <span className="font-mono text-secondary">{session.metrics.currentPrice}</span></span>
            </div>

            <div className="mt-2 grid grid-cols-3 gap-1.5">
              <MetricCard label="总资产" value={money(session.metrics.equity)} />
              <MetricCard label="现金" value={money(session.metrics.cash)} />
              <MetricCard label="持仓市值" value={money(session.metrics.marketValue)} detail={`${session.metrics.shares.toLocaleString()} 股`} />
              <MetricCard label="当前仓位" value={percent(session.metrics.positionPct, false)} />
              <MetricCard label="累计盈亏" value={`${money(session.metrics.totalPnl)} ${percent(session.metrics.totalReturn)}`} tone={valueTone(session.metrics.totalPnl)} />
              <MetricCard label="最大回撤" value={percent(session.metrics.maxDrawdown, false)} tone={session.metrics.maxDrawdown > 0 ? 'text-bear' : 'text-foreground'} />
            </div>

            <div className="mt-3 rounded-btn border border-border/70 bg-base/35 p-1">
              <div className="px-2 pt-1 text-[10px] text-muted">总资产趋势</div>
              <EquityCurve points={session.equityCurve} />
            </div>

            {session.phase === 'finished' ? (
              <div className="mt-3 rounded-btn border border-accent/25 bg-accent/5 px-3 py-2.5">
                <div className="text-xs font-medium text-accent">本局已结束</div>
                <div className="mt-1 text-[10px] leading-4 text-secondary">
                  {session.endReason === 'target_steps' ? `已达到设定的 ${session.targetSteps} 根推进。` : '已到最新的已收盘 K 线，没有下一根可推进。'}
                </div>
              </div>
            ) : (
              <div className="mt-3 text-[10px] text-muted">选择操作后才会推进到下一根 K 线；买入或卖出不可用时不会推进。</div>
            )}
            {actionError && <div className="mt-2 rounded-btn border border-bear/30 bg-bear/10 px-2.5 py-2 text-[10px] text-bear">{actionError}</div>}

            {isPlaying && buyAvailability && sellAvailability && (
              <>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <div className="rounded-btn border border-border/70 bg-base/35 p-2">
                    <div className="flex items-center justify-between gap-2 text-[10px]">
                      <label htmlFor="find-feel-buy-quantity" className="text-secondary">买入数量</label>
                      <span className="text-muted">可买 {buyMaxQuantity.toLocaleString()} 股</span>
                    </div>
                    <input
                      id="find-feel-buy-quantity"
                      type="number"
                      min={FIND_FEEL_QUANTITY}
                      step={FIND_FEEL_QUANTITY}
                      value={buyQuantity > 0 ? buyQuantity : ''}
                      onChange={event => setBuyQuantity(Number(event.target.value))}
                      className="mt-1 h-8 w-full rounded-btn border border-border bg-base px-2 font-mono text-xs text-foreground outline-none focus:border-accent"
                    />
                    <div className="mt-1 grid grid-cols-3 gap-1">
                      {([['1/4', 0.25], ['1/2', 0.5], ['全部', 'all']] as const).map(([label, ratio]) => (
                        <button
                          key={label}
                          type="button"
                          disabled={buyMaxQuantity < FIND_FEEL_QUANTITY}
                          onClick={() => setBuyQuantity(quickQuantity(buyMaxQuantity, ratio))}
                          className="rounded border border-border px-1 py-1 text-[10px] text-muted transition-colors hover:border-accent/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                        >{label}</button>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-btn border border-border/70 bg-base/35 p-2">
                    <div className="flex items-center justify-between gap-2 text-[10px]">
                      <label htmlFor="find-feel-sell-quantity" className="text-secondary">卖出数量</label>
                      <span className="text-muted">可卖 {sellMaxQuantity.toLocaleString()} 股</span>
                    </div>
                    <input
                      id="find-feel-sell-quantity"
                      type="number"
                      min={FIND_FEEL_QUANTITY}
                      step={FIND_FEEL_QUANTITY}
                      value={sellQuantity > 0 ? sellQuantity : ''}
                      onChange={event => setSellQuantity(Number(event.target.value))}
                      className="mt-1 h-8 w-full rounded-btn border border-border bg-base px-2 font-mono text-xs text-foreground outline-none focus:border-accent"
                    />
                    <div className="mt-1 grid grid-cols-3 gap-1">
                      {([['1/4', 0.25], ['1/2', 0.5], ['全部', 'all']] as const).map(([label, ratio]) => (
                        <button
                          key={label}
                          type="button"
                          disabled={sellMaxQuantity < FIND_FEEL_QUANTITY}
                          onClick={() => setSellQuantity(quickQuantity(sellMaxQuantity, ratio))}
                          className="rounded border border-border px-1 py-1 text-[10px] text-muted transition-colors hover:border-accent/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                        >{label}</button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2">
                <button
                  type="button"
                  disabled={!buyAvailability.buy}
                  title={buyAvailability.buy ? `按 ${session.metrics.currentPrice} 买入 ${buyQuantity} 股` : buyAvailability.buyReason}
                  onClick={() => takeAction('buy', buyQuantity)}
                  className="inline-flex h-9 items-center justify-center rounded-btn bg-bull px-2 text-xs font-medium text-white transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35"
                >买入 {buyQuantity > 0 ? buyQuantity.toLocaleString() : '—'} 股</button>
                <button
                  type="button"
                  disabled={!sellAvailability.sell}
                  title={sellAvailability.sell ? `按 ${session.metrics.currentPrice} 卖出 ${sellQuantity} 股` : sellAvailability.sellReason}
                  onClick={() => takeAction('sell', sellQuantity)}
                  className="inline-flex h-9 items-center justify-center rounded-btn bg-bear px-2 text-xs font-medium text-white transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35"
                >卖出 {sellQuantity > 0 ? sellQuantity.toLocaleString() : '—'} 股</button>
                <button
                  type="button"
                  disabled={!buyAvailability.skip}
                  onClick={() => takeAction('skip')}
                  className="inline-flex h-9 items-center justify-center rounded-btn border border-border bg-elevated px-2 text-xs font-medium text-secondary transition-colors hover:border-accent/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
                >跳过</button>
                </div>
              </>
            )}

            <div className="mt-3 flex justify-end gap-2 border-t border-border/70 pt-3">
              <button type="button" onClick={restart} className="inline-flex h-8 items-center gap-1 rounded-btn border border-border px-3 text-xs text-secondary transition-colors hover:border-accent/50 hover:text-foreground">
                <RotateCcw className="h-3.5 w-3.5" />重新开始
              </button>
              <button type="button" onClick={close} className="inline-flex h-8 items-center gap-1 rounded-btn bg-accent px-3 text-xs font-medium text-white transition-colors hover:bg-accent/90">
                <ChevronLeft className="h-3.5 w-3.5" />结束
              </button>
            </div>
          </div>
        )}
    </div>
  )
}

export type { FindFeelLockContext }
