import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { RefreshCw } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { MarkdownRenderer } from '@/components/financials/MarkdownRenderer'
import { api, type TimelineExecution } from '@/lib/api'
import {
  buildPaperTradingTimelineState,
  createPaperTradingSessions,
  getBeijingPaperClock,
  PAPER_TRADING_STEP_OPTIONS,
  PAPER_TRADING_STEP_MINUTES,
  type PaperTradingClock,
  type PaperTradingSession,
  type PaperTradingSystemTimelinePoint,
  type PaperTradingStepMinutes,
  type PaperTradingTimelineState,
} from '@/lib/paper-trading-time'
import { storage } from '@/lib/storage'

export type PaperTradingTimelineCustomPoint = {
  id: number
  time: string
  description: string
  timerMethod: string
}

export type PaperTradingTimelineSettings = {
  stepMinutes: PaperTradingStepMinutes
  timerMethods: string[]
  customPoints: PaperTradingTimelineCustomPoint[]
}

const DEFAULT_TIMELINE_SETTINGS: PaperTradingTimelineSettings = {
  stepMinutes: PAPER_TRADING_STEP_MINUTES,
  timerMethods: [],
  customPoints: [],
}

export const clonePaperTradingTimelineSettings = (settings: PaperTradingTimelineSettings): PaperTradingTimelineSettings => ({
  ...settings,
  timerMethods: [...settings.timerMethods],
  customPoints: settings.customPoints.map(point => ({ ...point })),
})

const isTimelineStepMinutes = (value: unknown): value is PaperTradingStepMinutes => PAPER_TRADING_STEP_OPTIONS.some(step => step === value)

export const loadPaperTradingTimelineSettings = (): PaperTradingTimelineSettings => {
  const saved = storage.paperTimelineSettings.get(null)
  if (!saved || typeof saved !== 'object') return clonePaperTradingTimelineSettings(DEFAULT_TIMELINE_SETTINGS)
  const raw = saved as Partial<PaperTradingTimelineSettings> & { timerMethod?: unknown }
  const timerMethods = Array.isArray(raw.timerMethods)
    ? raw.timerMethods.filter((value): value is string => typeof value === 'string')
    : typeof raw.timerMethod === 'string' && raw.timerMethod ? [raw.timerMethod] : []
  const customPoints = Array.isArray(raw.customPoints) ? raw.customPoints.flatMap(point => {
    if (!point || typeof point !== 'object') return []
    const value = point as Partial<PaperTradingTimelineCustomPoint>
    return typeof value.id === 'number' && Number.isInteger(value.id) && typeof value.time === 'string' && typeof value.description === 'string' && typeof value.timerMethod === 'string'
      ? [{ id: value.id, time: value.time, description: value.description, timerMethod: value.timerMethod }]
      : []
  }) : []
  return {
    stepMinutes: isTimelineStepMinutes(raw.stepMinutes) ? raw.stepMinutes : PAPER_TRADING_STEP_MINUTES,
    timerMethods,
    customPoints,
  }
}

const parseTimelinePointMinutes = (value: string) => {
  const match = value.match(/^(\d{2}):(\d{2})$/)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  return hours <= 23 && minutes <= 59 ? hours * 60 + minutes : null
}

const TIMELINE_PRE_POST_WIDTH = 144
const TIMELINE_LUNCH_WIDTH = 96

type ParsedTimelineCustomPoint = PaperTradingTimelineCustomPoint & { minutes: number }
type TimelinePointDescriptor = {
  time: string
  description?: string
  method?: string
  methods?: string[]
}
type SelectedTimelinePoint = TimelinePointDescriptor & { date: string }

const timelinePointTitle = (point: TimelinePointDescriptor, fallbackMethods: readonly string[] = []) => {
  const methods = [point.method, ...(point.methods ?? []), ...fallbackMethods].filter((method): method is string => Boolean(method?.trim()))
  return [
    point.description && `工作：${point.description}`,
    methods.length ? `定时器方法：${methods.join('、')}` : '',
    '点击查看执行详情',
  ].filter(Boolean).join(' · ')
}

const parseTimelineCustomPoints = (points: PaperTradingTimelineCustomPoint[]): ParsedTimelineCustomPoint[] => points.flatMap(point => {
  const minutes = parseTimelinePointMinutes(point.time)
  return minutes == null ? [] : [{ ...point, minutes }]
})

function TimelinePointButton({ ariaLabel, content, className, style, onClick, children }: { ariaLabel: string; content: string; className: string; style?: CSSProperties; onClick: (event: MouseEvent<HTMLButtonElement>) => void; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const pointerRef = useRef<{ x: number; y: number } | null>(null)
  const tooltipId = `timeline-tooltip-${useId().replace(/:/g, '')}`

  const reposition = () => {
    const pointer = pointerRef.current
    const anchor = anchorRef.current?.getBoundingClientRect()
    if (!anchor) return
    const tooltip = tooltipRef.current?.getBoundingClientRect()
    const width = tooltip?.width ?? 320
    const height = tooltip?.height ?? 42
    const x = pointer?.x ?? anchor.left + anchor.width / 2
    const y = pointer?.y ?? anchor.bottom
    const left = Math.max(8, Math.min(pointer ? x + 12 : x - width / 2, window.innerWidth - width - 8))
    const below = y + (pointer ? 14 : 8)
    const top = below + height <= window.innerHeight - 8 || y - height - 8 < 8
      ? below
      : y - height - 8
    setPosition({ top, left })
  }

  useLayoutEffect(() => {
    if (!open) return
    reposition()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [content, open])

  const showAtPointer = (event: MouseEvent<HTMLButtonElement>) => {
    const pointer = { x: event.clientX, y: event.clientY }
    pointerRef.current = pointer
    reposition()
    setOpen(true)
  }

  return <>
    <button
      ref={anchorRef}
      type="button"
      className={className}
      style={style}
      aria-label={ariaLabel}
      aria-describedby={open ? tooltipId : undefined}
      onMouseEnter={showAtPointer}
      onMouseMove={showAtPointer}
      onMouseLeave={() => { pointerRef.current = null; setOpen(false) }}
      onFocus={() => { pointerRef.current = null; reposition(); setOpen(true) }}
      onBlur={() => { pointerRef.current = null; setOpen(false) }}
      onClick={onClick}
    >
      {children}
    </button>
    {open && position && createPortal(
      <div
        ref={tooltipRef}
        id={tooltipId}
        role="tooltip"
        className="pointer-events-none fixed z-[70] w-max max-w-[20rem] rounded-lg border border-border/80 bg-elevated px-3 py-2 text-left text-[10px] font-normal leading-4 text-foreground shadow-xl ring-1 ring-black/10"
        style={{ top: position.top, left: position.left }}
      >
        {content}
      </div>,
      document.body,
    )}
  </>
}

const timelineStatusName: Record<TimelineExecution['status'], string> = {
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  skipped: '已跳过',
}

const timelineStatusClass: Record<TimelineExecution['status'], string> = {
  running: 'border-yellow-400/30 bg-yellow-400/10 text-yellow-400',
  succeeded: 'border-green-400/30 bg-green-400/10 text-green-400',
  failed: 'border-red-400/30 bg-red-400/10 text-red-400',
  skipped: 'border-border bg-base text-muted',
}

const formatTimelineResult = (result: unknown) => {
  if (result == null) return '—'
  const output = typeof result === 'object' && 'output' in result
    ? (result as { output?: unknown }).output
    : result
  if (output == null || output === '') return '—'
  if (typeof output === 'string') return output
  try {
    return JSON.stringify(output, null, 2) ?? String(output)
  } catch {
    return String(output)
  }
}

const formatTimelineTimestamp = (value: string | null) => value ? value.replace('T', ' ').slice(0, 19) : '—'

function TimelineExecutionModal({ point, executions, loading, error, retryingId, onClose, onRetry }: { point: SelectedTimelinePoint; executions: TimelineExecution[]; loading: boolean; error: string; retryingId: string | null; onClose: () => void; onRetry: (execution: TimelineExecution | null, method?: string) => void }) {
  const [activeIndex, setActiveIndex] = useState(0)
  useEffect(() => setActiveIndex(0), [point.date, point.time])
  const active = executions[activeIndex]
  const title = `${point.time}${point.description ? ` · ${point.description}` : ''}`
  const retryMethods = active ? [active.method] : point.method ? [point.method] : point.methods ?? []
  return <Modal
    onClose={onClose}
    labelledBy="timeline-execution-title"
    panelClassName="w-[min(94vw,56rem)] max-h-[88vh] rounded-xl border border-border bg-surface shadow-xl"
  >
    <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
      <div>
        <h2 id="timeline-execution-title" className="text-base font-semibold text-foreground">{title} · 执行详情</h2>
        <p className="mt-1 text-xs text-muted">{point.date}{point.method ? ` · ${point.method}` : ''}</p>
      </div>
      <button type="button" onClick={onClose} className="rounded-btn px-2 py-1 text-sm text-muted hover:bg-elevated hover:text-foreground" aria-label="关闭执行详情">✕</button>
    </div>
    <div className="max-h-[calc(88vh-5rem)] overflow-y-auto p-5">
      {loading && <div className="py-12 text-center text-sm text-muted">正在加载执行记录...</div>}
      {!loading && error && <div className="rounded-btn border border-red-400/30 bg-red-400/10 px-3 py-4 text-sm text-red-300">{error}</div>}
      {!loading && !error && !executions.length && <div className="rounded-btn border border-dashed border-border px-3 py-12 text-center text-sm text-muted">该时间点暂无执行记录</div>}
      {!loading && !error && executions.length > 1 && (
        <div className="mb-4 flex gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label="执行记录">
          {executions.map((execution, index) => (
            <button
              key={execution.id}
              type="button"
              role="tab"
              aria-selected={activeIndex === index}
              className={`shrink-0 border-b-2 px-3 py-2 text-xs ${activeIndex === index ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-foreground'}`}
              onClick={() => setActiveIndex(index)}
            >
              {execution.method || execution.task_name || `记录 ${index + 1}`}
            </button>
          ))}
        </div>
      )}
      {!loading && !error && active && (
        <div className="space-y-4">
          <div className="grid gap-3 text-xs sm:grid-cols-2">
            <div><span className="text-muted">定时器方法</span><code className="mt-1 block break-all font-mono text-accent">{active.method || '—'}</code></div>
            <div><span className="text-muted">任务名称</span><div className="mt-1 text-secondary">{active.task_name || '—'}</div></div>
            <div><span className="text-muted">执行状态</span><div className={`mt-1 inline-flex rounded border px-2 py-0.5 ${timelineStatusClass[active.status]}`}>{timelineStatusName[active.status]}</div></div>
            <div><span className="text-muted">执行时间</span><div className="mt-1 text-secondary">{formatTimelineTimestamp(active.started_at)} → {formatTimelineTimestamp(active.finished_at)}</div></div>
          </div>
          {active.session_id && <div className="rounded-btn border border-border/70 bg-base px-3 py-2 text-xs"><span className="text-muted">session_id：</span><code className="break-all font-mono text-secondary">{active.session_id}</code></div>}
          <div>
            <div className="mb-1 text-xs text-muted">执行结果（output）</div>
            <div className="max-h-80 overflow-auto rounded-btn border border-border/70 bg-base px-3 py-1 text-secondary">
              <MarkdownRenderer content={formatTimelineResult(active.result)} />
            </div>
          </div>
          {active.error && <div className="rounded-btn border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs leading-5 text-red-300">错误：{active.error}</div>}
        </div>
      )}
      {!loading && (active || retryMethods.length > 0) && (
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {retryMethods.map(method => {
            const retryKey = active?.id ?? method
            return <button
              key={method}
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-btn border border-accent/40 px-3 text-xs font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={retryingId === retryKey}
              onClick={() => onRetry(active ?? null, method)}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${retryingId === retryKey ? 'animate-spin' : ''}`} aria-hidden="true" />
              {retryingId === retryKey ? '执行中...' : retryMethods.length > 1 ? `重试 ${method}` : '重试'}
            </button>
          })}
        </div>
      )}
    </div>
  </Modal>
}

function TimelineCustomMarker({ point, left, reached, onSelect }: { point: ParsedTimelineCustomPoint; left: string; reached: boolean; onSelect: (point: TimelinePointDescriptor) => void }) {
  const description = point.description.trim()
  const timerMethod = point.timerMethod.trim()
  return <TimelinePointButton
    className="absolute top-0 z-20 flex -translate-x-1/2 flex-col items-center border-0 bg-transparent p-0 text-purple-400 transition-colors hover:brightness-125 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
    style={{ left }}
    ariaLabel={`自定义时间点 ${point.time}${description ? `，${description}` : ''}${timerMethod ? `，方法 ${timerMethod}` : ''}`}
    content={timelinePointTitle({ time: point.time, description, method: timerMethod || undefined })}
    onClick={event => { event.stopPropagation(); onSelect({ time: point.time, description: description || undefined, method: timerMethod || undefined }) }}
  >
    <span className="block h-4 whitespace-nowrap text-center text-[10px] font-medium leading-4 tabular-nums">{point.time}</span>
    <span className={`mx-auto mt-1 block h-2.5 w-2.5 rounded-full border transition-colors ${reached ? 'border-purple-300 bg-purple-500 ring-4 ring-purple-400/20' : 'border-purple-400 bg-base'}`} />
  </TimelinePointButton>
}

function TimelineSystemMarker({ point, left, onSelect }: { point: PaperTradingSystemTimelinePoint; left: string; onSelect: (point: TimelinePointDescriptor) => void }) {
  const method = point.method?.trim()
  return <TimelinePointButton
    className="absolute top-5 z-20 flex -translate-x-1/2 flex-col items-center border-0 bg-transparent p-0 text-yellow-400 transition-colors hover:brightness-125 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
    style={{ left }}
    ariaLabel={`系统时间点 ${point.time} ${point.description}${method ? `，方法 ${method}` : ''}`}
    content={timelinePointTitle({ time: point.time, description: point.description, method })}
    onClick={event => { event.stopPropagation(); onSelect({ time: point.time, description: point.description, method }) }}
  >
    <span className="mx-auto block h-2.5 w-2.5 rounded-full border border-yellow-300 bg-yellow-400" />
    <span className="mt-2 block whitespace-nowrap text-center text-[10px] font-medium leading-4 tabular-nums">{point.time}</span>
  </TimelinePointButton>
}

function timelineSessionMarkerLeft(minutes: number, session: PaperTradingSession) {
  const start = session.points[0]?.minutes ?? minutes
  const end = session.points[session.points.length - 1]?.minutes ?? start
  const ratio = end === start ? 0 : Math.max(0, Math.min(1, (minutes - start) / (end - start)))
  return `${ratio * 100}%`
}

function TimelineCustomSegment({ label, width, customPoints, systemPoints, clock, onSelect }: { label: string; width: number; customPoints: ParsedTimelineCustomPoint[]; systemPoints: readonly PaperTradingSystemTimelinePoint[]; clock: PaperTradingClock | null; onSelect: (point: TimelinePointDescriptor) => void }) {
  return <div className="relative min-h-[4.5rem] shrink-0 pt-5" style={{ width, minWidth: width }}>
    <div className="relative flex flex-col items-center">
      <span className="z-10 h-2.5 w-2.5 rounded-full border border-border bg-base" />
      <span className="absolute left-1/2 top-14 -translate-x-1/2 whitespace-nowrap text-[10px] text-muted">{label}</span>
    </div>
    {systemPoints.map((point, index) => <TimelineSystemMarker
      key={`${point.time}-${point.description}`}
      point={point}
      left={`${((index + 0.5) / systemPoints.length) * 100}%`}
      onSelect={onSelect}
    />)}
    {customPoints.map((point, index) => <TimelineCustomMarker
      key={point.id}
      point={point}
      left={`${((index + 0.5) / customPoints.length) * 100}%`}
      reached={Boolean(clock?.tradingDay) && (clock?.minutes ?? -1) >= point.minutes}
      onSelect={onSelect}
    />)}
  </div>
}

function TimelineSegment({ session, offset, state, customPoints, clock, timerMethods, onSelect }: { session: PaperTradingSession; offset: number; state: PaperTradingTimelineState; customPoints: ParsedTimelineCustomPoint[]; clock: PaperTradingClock | null; timerMethods: readonly string[]; onSelect: (point: TimelinePointDescriptor) => void }) {
  const start = session.points[0]?.minutes ?? 0
  const end = session.points[session.points.length - 1]?.minutes ?? start
  const markers = customPoints.filter(point => point.minutes >= start && point.minutes <= end)
  return <div className="flex-1" style={{ minWidth: Math.max(340, session.points.length * 32) }}>
    <div className="relative min-h-[4.5rem]">
      <div className="relative min-h-[4.5rem]">
        {session.points.map((point, index) => {
          const globalIndex = offset + index
          const active = state.activeIndex === globalIndex
          const complete = globalIndex <= state.completedIndex
          return <TimelinePointButton
            key={point.label}
            className="absolute top-5 flex -translate-x-1/2 flex-col items-center border-0 bg-transparent p-0 text-blue-400 transition-colors hover:brightness-125 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
            style={{ left: `${(index / Math.max(session.points.length - 1, 1)) * 100}%` }}
            ariaLabel={`时间点 ${point.label}`}
            content={timelinePointTitle({ time: point.label }, timerMethods)}
            onClick={event => { event.stopPropagation(); onSelect({ time: point.label, methods: [...timerMethods] }) }}
          >
            <span className={`z-10 h-2.5 w-2.5 rounded-full border transition-colors ${active ? 'border-blue-300 bg-blue-500 ring-4 ring-blue-400/20' : complete ? 'border-blue-400 bg-blue-500' : 'border-blue-400 bg-base'}`} />
            <span className={`mt-2 whitespace-nowrap text-center text-[10px] tabular-nums text-blue-400 ${active ? 'font-semibold' : ''}`}>{point.label}</span>
          </TimelinePointButton>
        })}
      </div>
      {markers.map(point => <TimelineCustomMarker
        key={point.id}
        point={point}
        left={timelineSessionMarkerLeft(point.minutes, session)}
        reached={Boolean(clock?.tradingDay) && (clock?.minutes ?? -1) >= point.minutes}
        onSelect={onSelect}
      />)}
    </div>
  </div>
}

export function PaperTradingTimeline({ clock, settings, systemPoints }: { clock: PaperTradingClock | null; settings: PaperTradingTimelineSettings; systemPoints: readonly PaperTradingSystemTimelinePoint[] }) {
  const sessions = createPaperTradingSessions(settings.stepMinutes)
  const state = buildPaperTradingTimelineState(clock?.minutes ?? null, clock?.tradingDay ?? false, settings.stepMinutes)
  const afternoonOffset = sessions[0].points.length
  const customPoints = parseTimelineCustomPoints(settings.customPoints).sort((left, right) => left.minutes - right.minutes || left.id - right.id)
  const morningStart = 9 * 60 + 30
  const morningEnd = 11 * 60 + 30
  const afternoonStart = 13 * 60
  const afternoonEnd = 15 * 60
  const preopenPoints = customPoints.filter(point => point.minutes < morningStart)
  const lunchPoints = customPoints.filter(point => point.minutes > morningEnd && point.minutes < afternoonStart)
  const postclosePoints = customPoints.filter(point => point.minutes > afternoonEnd)
  const preopenSystemPoints = systemPoints.filter(point => point.minutes < morningStart)
  const postcloseSystemPoints = systemPoints.filter(point => point.minutes >= afternoonEnd)
  const requestId = useRef(0)
  const [selectedPoint, setSelectedPoint] = useState<SelectedTimelinePoint | null>(null)
  const [executions, setExecutions] = useState<TimelineExecution[]>([])
  const [loadingExecutions, setLoadingExecutions] = useState(false)
  const [executionError, setExecutionError] = useState('')
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const openTimelinePoint = (point: TimelinePointDescriptor) => {
    const date = clock?.display.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? getBeijingPaperClock().display.slice(0, 10)
    const currentRequestId = ++requestId.current
    setSelectedPoint({ ...point, date })
    setExecutions([])
    setExecutionError('')
    setLoadingExecutions(true)
    void api.timelineExecutions(date).then(response => {
      if (currentRequestId !== requestId.current) return
      setExecutions(response.items.filter(item => item.scheduled_time === point.time))
    }).catch(error => {
      if (currentRequestId === requestId.current) setExecutionError(error instanceof Error ? error.message : '执行记录加载失败')
    }).finally(() => {
      if (currentRequestId === requestId.current) setLoadingExecutions(false)
    })
  }
  const closeTimelinePoint = () => {
    requestId.current += 1
    setSelectedPoint(null)
  }
  const retryTimelineExecution = async (execution: TimelineExecution | null, method?: string) => {
    const point = selectedPoint
    if (!point) return
    const currentRequestId = requestId.current
    const retryMethod = method || execution?.method
    if (!retryMethod) return
    const retryKey = execution?.id ?? retryMethod
    setRetryingId(retryKey)
    try {
      if (execution) {
        await api.timelineExecutionRetry(execution.id)
      } else {
        await api.timelineMethodRetry({
          method: retryMethod,
          task_name: point.description || retryMethod,
          scheduled_time: point.time,
        })
      }
      const response = await api.timelineExecutions(point.date)
      if (currentRequestId === requestId.current) {
        setExecutions(response.items.filter(item => item.scheduled_time === point.time))
        setExecutionError('')
      }
    } catch (error) {
      if (currentRequestId === requestId.current) setExecutionError(error instanceof Error ? error.message : '重试执行失败')
    } finally {
      setRetryingId(current => current === retryKey ? null : current)
    }
  }
  return <>
    <div className="basis-full border-t border-border/70 pt-3"><div className="timeline-scrollbar-hidden overflow-x-auto pb-1"><div className="relative flex min-w-[736px] items-start gap-0"><div className="pointer-events-none absolute inset-x-0 top-[25px] h-px bg-border" /><TimelineCustomSegment label="盘前" width={TIMELINE_PRE_POST_WIDTH} customPoints={preopenPoints} systemPoints={preopenSystemPoints} clock={clock} onSelect={openTimelinePoint} /><TimelineSegment session={sessions[0]} offset={0} state={state} customPoints={customPoints} clock={clock} timerMethods={settings.timerMethods} onSelect={openTimelinePoint} /><TimelineCustomSegment label="午休" width={TIMELINE_LUNCH_WIDTH} customPoints={lunchPoints} systemPoints={[]} clock={clock} onSelect={openTimelinePoint} /><TimelineSegment session={sessions[1]} offset={afternoonOffset} state={state} customPoints={customPoints} clock={clock} timerMethods={settings.timerMethods} onSelect={openTimelinePoint} /><TimelineCustomSegment label="盘后" width={TIMELINE_PRE_POST_WIDTH} customPoints={postclosePoints} systemPoints={postcloseSystemPoints} clock={clock} onSelect={openTimelinePoint} /></div></div></div>
    {selectedPoint && <TimelineExecutionModal point={selectedPoint} executions={executions} loading={loadingExecutions} error={executionError} retryingId={retryingId} onRetry={retryTimelineExecution} onClose={closeTimelinePoint} />}
  </>
}
