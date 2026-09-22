import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  buildPaperTradingTimelineState,
  createPaperTradingSessions,
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
  timerMethod: string
  customPoints: PaperTradingTimelineCustomPoint[]
}

const DEFAULT_TIMELINE_SETTINGS: PaperTradingTimelineSettings = {
  stepMinutes: PAPER_TRADING_STEP_MINUTES,
  timerMethod: '',
  customPoints: [],
}

export const clonePaperTradingTimelineSettings = (settings: PaperTradingTimelineSettings): PaperTradingTimelineSettings => ({
  ...settings,
  customPoints: settings.customPoints.map(point => ({ ...point })),
})

const isTimelineStepMinutes = (value: unknown): value is PaperTradingStepMinutes => PAPER_TRADING_STEP_OPTIONS.some(step => step === value)

export const loadPaperTradingTimelineSettings = (): PaperTradingTimelineSettings => {
  const saved = storage.paperTimelineSettings.get(null)
  if (!saved || typeof saved !== 'object') return clonePaperTradingTimelineSettings(DEFAULT_TIMELINE_SETTINGS)
  const raw = saved as Partial<PaperTradingTimelineSettings>
  const customPoints = Array.isArray(raw.customPoints) ? raw.customPoints.flatMap(point => {
    if (!point || typeof point !== 'object') return []
    const value = point as Partial<PaperTradingTimelineCustomPoint>
    return typeof value.id === 'number' && Number.isInteger(value.id) && typeof value.time === 'string' && typeof value.description === 'string' && typeof value.timerMethod === 'string'
      ? [{ id: value.id, time: value.time, description: value.description, timerMethod: value.timerMethod }]
      : []
  }) : []
  return {
    stepMinutes: isTimelineStepMinutes(raw.stepMinutes) ? raw.stepMinutes : PAPER_TRADING_STEP_MINUTES,
    timerMethod: typeof raw.timerMethod === 'string' ? raw.timerMethod : '',
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
type TimelineTooltipAlign = 'left' | 'center' | 'right'

const parseTimelineCustomPoints = (points: PaperTradingTimelineCustomPoint[]): ParsedTimelineCustomPoint[] => points.flatMap(point => {
  const minutes = parseTimelinePointMinutes(point.time)
  return minutes == null ? [] : [{ ...point, minutes }]
})

function TimelineMarkerPopover({ content, align = 'center', className, children }: { content: string; align?: TimelineTooltipAlign; className?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number; flipUp: boolean } | null>(null)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const popoverId = `timeline-popover-${useId().replace(/:/g, '')}`
  const arrowPosition = align === 'left' ? 'left-3' : align === 'right' ? 'right-3' : 'left-1/2 -translate-x-1/2'

  const togglePopover = () => {
    if (open) {
      setOpen(false)
      return
    }
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return
    const estimatedWidth = 288
    const anchorX = align === 'left' ? rect.left : align === 'right' ? rect.right - estimatedWidth : rect.left + (rect.width - estimatedWidth) / 2
    setPosition({
      top: rect.bottom + 8,
      left: Math.max(8, Math.min(anchorX, Math.max(8, window.innerWidth - estimatedWidth - 8))),
      flipUp: false,
    })
    setOpen(true)
  }

  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !popoverRef.current) return
    const updatePosition = () => {
      const anchor = anchorRef.current
      const popover = popoverRef.current
      if (!anchor || !popover) return
      const anchorRect = anchor.getBoundingClientRect()
      const popoverRect = popover.getBoundingClientRect()
      const width = Math.min(popoverRect.width, Math.max(0, window.innerWidth - 16))
      const anchorX = align === 'left' ? anchorRect.left : align === 'right' ? anchorRect.right - width : anchorRect.left + (anchorRect.width - width) / 2
      const left = Math.max(8, Math.min(anchorX, Math.max(8, window.innerWidth - width - 8)))
      const belowTop = anchorRect.bottom + 8
      const flipUp = belowTop + popoverRect.height > window.innerHeight - 8 && anchorRect.top - popoverRect.height - 8 >= 8
      const top = flipUp ? anchorRect.top - popoverRect.height - 8 : belowTop
      setPosition(previous => previous && previous.top === top && previous.left === left && previous.flipUp === flipUp ? previous : { top, left, flipUp })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [align, content, open])

  useEffect(() => {
    if (!open) return
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node
      if (anchorRef.current?.contains(target) || popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return <>
    <button
      ref={anchorRef}
      type="button"
      className={`relative cursor-pointer border-0 bg-transparent p-0 text-inherit transition-colors hover:brightness-125 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${className ?? ''}`}
      aria-expanded={open}
      aria-describedby={open ? popoverId : undefined}
      onClick={event => { event.stopPropagation(); togglePopover() }}
    >
      {children}
    </button>
    {open && position && createPortal(
      <div
        ref={popoverRef}
        id={popoverId}
        role="tooltip"
        data-timeline-popover
        style={{ position: 'fixed', top: position.top, left: position.left, maxWidth: 'calc(100vw - 16px)' }}
        className="z-[70] w-max max-w-[18rem] rounded-lg border border-border/80 bg-elevated px-3 py-2 text-left text-[10px] font-normal leading-4 text-foreground shadow-xl ring-1 ring-black/10"
        onMouseDown={event => event.stopPropagation()}
      >
        <span aria-hidden="true" className={`absolute ${arrowPosition} ${position.flipUp ? '-bottom-1 border-r border-b' : '-top-1 border-l border-t'} h-2 w-2 rotate-45 border-border/80 bg-elevated`} />
        {content}
      </div>,
      document.body,
    )}
  </>
}

function TimelineCustomMarker({ point, left, reached, tooltipAlign = 'center' }: { point: ParsedTimelineCustomPoint; left: string; reached: boolean; tooltipAlign?: TimelineTooltipAlign }) {
  const description = point.description.trim()
  const timerMethod = point.timerMethod.trim()
  const tooltip = [description && `工作：${description}`, timerMethod && `定时器：${timerMethod}`].filter(Boolean).join(' · ')
  return <div
    className="absolute top-0 z-20 -translate-x-1/2 text-purple-400"
    style={{ left }}
    aria-label={`自定义时间点 ${point.time}${tooltip ? `，${tooltip}` : ''}`}
  >
    {tooltip ? <TimelineMarkerPopover content={tooltip} align={tooltipAlign} className="block h-4 whitespace-nowrap text-center text-[10px] font-medium leading-4 tabular-nums">{point.time}</TimelineMarkerPopover> : <span className="block h-4 whitespace-nowrap text-center text-[10px] font-medium leading-4 tabular-nums">{point.time}</span>}
    <span className={`mx-auto mt-1 block h-2.5 w-2.5 rounded-full border transition-colors ${reached ? 'border-purple-300 bg-purple-500 ring-4 ring-purple-400/20' : 'border-purple-400 bg-base'}`} />
  </div>
}

function TimelineSystemMarker({ point, left, tooltipAlign = 'center' }: { point: PaperTradingSystemTimelinePoint; left: string; tooltipAlign?: TimelineTooltipAlign }) {
  return <div
    className="absolute top-5 z-20 -translate-x-1/2 text-yellow-400"
    style={{ left }}
    aria-label={`系统时间点 ${point.time} ${point.description}`}
  >
    <span className="mx-auto block h-2.5 w-2.5 rounded-full border border-yellow-300 bg-yellow-400" />
    <TimelineMarkerPopover content={`工作：${point.description}`} align={tooltipAlign} className="mt-2 block whitespace-nowrap text-center text-[10px] font-medium leading-4 tabular-nums">{point.time}</TimelineMarkerPopover>
  </div>
}

function timelineSessionMarkerLeft(minutes: number, session: PaperTradingSession) {
  const start = session.points[0]?.minutes ?? minutes
  const end = session.points[session.points.length - 1]?.minutes ?? start
  const ratio = end === start ? 0 : Math.max(0, Math.min(1, (minutes - start) / (end - start)))
  return `${ratio * 100}%`
}

function TimelineCustomSegment({ label, width, customPoints, systemPoints, clock }: { label: string; width: number; customPoints: ParsedTimelineCustomPoint[]; systemPoints: readonly PaperTradingSystemTimelinePoint[]; clock: PaperTradingClock | null }) {
  return <div className="relative h-[4.5rem] shrink-0 pt-5" style={{ width, minWidth: width }}>
    <div className="relative flex flex-col items-center">
      <span className="z-10 h-2.5 w-2.5 rounded-full border border-border bg-base" />
      <span className="absolute left-1/2 top-14 -translate-x-1/2 whitespace-nowrap text-[10px] text-muted">{label}</span>
    </div>
    {systemPoints.map((point, index) => <TimelineSystemMarker
      key={`${point.time}-${point.description}`}
      point={point}
      left={`${((index + 0.5) / systemPoints.length) * 100}%`}
      tooltipAlign={label === '盘前' && index === 0 ? 'left' : label === '盘后' && index === systemPoints.length - 1 ? 'right' : 'center'}
    />)}
    {customPoints.map((point, index) => <TimelineCustomMarker
      key={point.id}
      point={point}
      left={`${((index + 0.5) / customPoints.length) * 100}%`}
      reached={Boolean(clock?.tradingDay) && (clock?.minutes ?? -1) >= point.minutes}
      tooltipAlign={label === '盘前' && index === 0 ? 'left' : label === '盘后' && index === customPoints.length - 1 ? 'right' : 'center'}
    />)}
  </div>
}

function TimelineSegment({ session, offset, state, customPoints, clock }: { session: PaperTradingSession; offset: number; state: PaperTradingTimelineState; customPoints: ParsedTimelineCustomPoint[]; clock: PaperTradingClock | null }) {
  const start = session.points[0]?.minutes ?? 0
  const end = session.points[session.points.length - 1]?.minutes ?? start
  const markers = customPoints.filter(point => point.minutes >= start && point.minutes <= end)
  return <div className="flex-1" style={{ minWidth: Math.max(340, session.points.length * 32) }}>
    <div className="relative h-[4.5rem]">
      <div className="relative h-full">
        {session.points.map((point, index) => {
          const globalIndex = offset + index
          const active = state.activeIndex === globalIndex
          const complete = globalIndex <= state.completedIndex
          return <div
            key={point.label}
            className="absolute top-5 flex -translate-x-1/2 flex-col items-center"
            style={{ left: `${(index / Math.max(session.points.length - 1, 1)) * 100}%` }}
          >
            <span className={`z-10 h-2.5 w-2.5 rounded-full border transition-colors ${active ? 'border-blue-300 bg-blue-500 ring-4 ring-blue-400/20' : complete ? 'border-blue-400 bg-blue-500' : 'border-blue-400 bg-base'}`} />
            <span className={`mt-2 whitespace-nowrap text-center text-[10px] tabular-nums text-blue-400 ${active ? 'font-semibold' : ''}`}>{point.label}</span>
          </div>
        })}
      </div>
      {markers.map(point => <TimelineCustomMarker
        key={point.id}
        point={point}
        left={timelineSessionMarkerLeft(point.minutes, session)}
        reached={Boolean(clock?.tradingDay) && (clock?.minutes ?? -1) >= point.minutes}
        tooltipAlign={point.minutes === start ? 'left' : point.minutes === end ? 'right' : 'center'}
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
  return <div className="basis-full border-t border-border/70 pt-3"><div className="overflow-x-auto pb-1"><div className="relative flex min-w-[736px] items-start gap-0"><div className="pointer-events-none absolute inset-x-0 top-[25px] h-px bg-border" /><TimelineCustomSegment label="盘前" width={TIMELINE_PRE_POST_WIDTH} customPoints={preopenPoints} systemPoints={preopenSystemPoints} clock={clock} /><TimelineSegment session={sessions[0]} offset={0} state={state} customPoints={customPoints} clock={clock} /><TimelineCustomSegment label="午休" width={TIMELINE_LUNCH_WIDTH} customPoints={lunchPoints} systemPoints={[]} clock={clock} /><TimelineSegment session={sessions[1]} offset={afternoonOffset} state={state} customPoints={customPoints} clock={clock} /><TimelineCustomSegment label="盘后" width={TIMELINE_PRE_POST_WIDTH} customPoints={postclosePoints} systemPoints={postcloseSystemPoints} clock={clock} /></div></div></div>
}
