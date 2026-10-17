import { useEffect, useRef, useState } from 'react'
import type { Chart, OverlayCreate, OverlayMode, Point } from 'klinecharts'
import { Pencil, MousePointer2, Magnet, LockKeyhole, Trash2, X } from 'lucide-react'
import { storage } from '@/lib/storage'

export const DRAWING_GROUP = 'tsp-user-drawings'
export const DRAWING_TOOLS = [
  { name: 'segment', label: '趋势线', points: 2 },
  { name: 'horizontalStraightLine', label: '水平线', points: 1 },
  { name: 'horizontalRayLine', label: '水平射线', points: 1 },
  { name: 'rayLine', label: '射线', points: 2 },
  { name: 'straightLine', label: '直线', points: 2 },
  { name: 'verticalStraightLine', label: '垂直线', points: 1 },
  { name: 'priceChannelLine', label: '价格通道', points: 3 },
  { name: 'parallelStraightLine', label: '平行线', points: 3 },
  { name: 'fibonacciLine', label: '斐波那契', points: 2 },
  { name: 'brush', label: '画笔', points: 2 },
]
type SavedDrawing = { name: string; points: Array<Partial<Point>>; lock: boolean }

/** 只恢复工具名和有限坐标，不从本地存储恢复事件、任意样式或系统覆盖物。 */
export function normalizeDrawings(value: unknown): SavedDrawing[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const tool = DRAWING_TOOLS.find(tool => tool.name === item?.name)
    if (!tool || !Array.isArray(item.points) || item.points.length < tool.points) return []
    const points = item.points.map((point: Partial<Point>) => ({ timestamp: point?.timestamp, value: point?.value }))
    if (points.some((point: Partial<Point>) => !Number.isFinite(point.timestamp) || !Number.isFinite(point.value))) return []
    return [{ name: tool.name, points, lock: item.lock === true }]
  })
}

export function ChartDrawingToolbar({ chart, symbol, period, ready, hidden }: {
  chart: Chart | null
  symbol?: string
  period: string
  ready: boolean
  hidden: boolean
}) {
  const [open, setOpen] = useState(false)
  const [tool, setTool] = useState<string | null>(null)
  const [magnet, setMagnet] = useState(false)
  const [locked, setLocked] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [count, setCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef<string | null>(null)
  const suppressSave = useRef(false)
  const callbacks = useRef<{ save: (exclude?: string) => void; attach: (drawing: OverlayCreate) => OverlayCreate } | null>(null)

  useEffect(() => {
    setTool(null); setSelected(null); setLocked(false); setMagnet(false); setCount(0); setOpen(false); setError(null)
    pending.current = null
    callbacks.current = null
    if (!chart || !symbol || !ready || hidden) return
    const store = storage.chartDrawings(symbol, period)
    const save = (exclude?: string) => {
      if (suppressSave.current) return
      const values = chart.getOverlays({ groupId: DRAWING_GROUP })
        .filter(overlay => overlay.id !== exclude && overlay.id !== pending.current)
      const drawings = normalizeDrawings(values)
      store.set(drawings)
      setCount(drawings.length)
      setLocked(drawings.length > 0 && drawings.every(drawing => drawing.lock))
    }
    const attach = (drawing: OverlayCreate): OverlayCreate => ({
      ...drawing, groupId: DRAWING_GROUP, paneId: 'candle_pane',
      onDrawEnd: ({ overlay }) => {
        pending.current = null; setTool(null); setSelected(overlay.id); save()
      },
      onSelected: ({ overlay }) => { setSelected(overlay.id) },
      onDeselected: ({ overlay }) => { setSelected(current => current === overlay.id ? null : current) },
      onPressedMoveEnd: () => { save() },
      onRemoved: ({ overlay }) => {
        if (!suppressSave.current) { setSelected(null); save(overlay.id) }
      },
    })
    callbacks.current = { save, attach }
    const saved = normalizeDrawings(store.get([]))
    setCount(saved.length)
    setLocked(saved.length > 0 && saved.every(drawing => drawing.lock))
    if (saved.length) chart.createOverlay(saved.map(drawing => attach(drawing)))
    return () => {
      suppressSave.current = true
      chart.removeOverlay({ groupId: DRAWING_GROUP })
      suppressSave.current = false
      callbacks.current = null
      pending.current = null
    }
  }, [chart, symbol, period, ready, hidden])

  const cancel = () => {
    if (pending.current) chart?.removeOverlay({ id: pending.current })
    pending.current = null; setTool(null)
  }
  useEffect(() => {
    if (!tool) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); cancel()
    }
    document.addEventListener('keydown', escape, true)
    return () => document.removeEventListener('keydown', escape, true)
  }, [tool])

  if (hidden) return null
  const disabled = !chart || !ready || !symbol
  const mode: OverlayMode = magnet ? 'strong_magnet' : 'normal'
  const start = (name: string) => {
    cancel(); setError(null)
    if (!callbacks.current) return
    const id = chart?.createOverlay(callbacks.current.attach({ name, mode, lock: false }))
    if (typeof id === 'string') { pending.current = id; setTool(name); setOpen(false) }
    else setError('画线工具未就绪，请重试')
  }
  const buttonClass = 'inline-flex h-6 items-center justify-center gap-1 rounded border border-border/40 px-2 text-[10px] text-muted hover:bg-elevated hover:text-foreground aria-pressed:bg-accent/10 aria-pressed:text-accent aria-pressed:border-accent/40 disabled:opacity-40 disabled:cursor-not-allowed'
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1" aria-label="画线工具栏">
      <div className="relative" onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }}>
        <button type="button" className={buttonClass} disabled={disabled} aria-expanded={open} aria-label="画线工具" onClick={() => setOpen(value => !value)}>
          <Pencil className="h-3 w-3" />画线
        </button>
        {open && <div role="dialog" aria-label="选择画线工具" className="absolute left-0 top-full z-40 mt-1 grid w-60 max-w-[calc(100vw-2rem)] grid-cols-2 gap-1 rounded border border-border bg-surface p-2 shadow-xl">
          {DRAWING_TOOLS.map(item => <button key={item.name} type="button" className={`${buttonClass} justify-start`} onClick={() => start(item.name)}>{item.label}</button>)}
          <p className="col-span-2 text-[10px] text-muted">点击依次取点；画笔按住拖动。Esc 取消。</p>
        </div>}
      </div>
      <button type="button" className={buttonClass} disabled={disabled} aria-pressed={!tool} title="结束画线，恢复选择（Esc）" onClick={cancel}><MousePointer2 className="h-3 w-3" />选择</button>
      <button type="button" className={buttonClass} disabled={disabled} aria-pressed={magnet} title="吸附K线高低点" onClick={() => {
        setMagnet(!magnet)
        chart?.overrideOverlay({ groupId: DRAWING_GROUP, mode: magnet ? 'normal' : 'strong_magnet' })
      }}><Magnet className="h-3 w-3" />吸附</button>
      <button type="button" className={buttonClass} disabled={!count} aria-pressed={locked} title="锁定或解锁全部手动画线" onClick={() => {
        setLocked(!locked); chart?.overrideOverlay({ groupId: DRAWING_GROUP, lock: !locked }); callbacks.current?.save()
      }}><LockKeyhole className="h-3 w-3" />{locked ? '解锁' : '锁定'}</button>
      <button type="button" className={buttonClass} disabled={!selected} aria-label="删除选中画线" onClick={() => {
        if (selected) chart?.removeOverlay({ id: selected })
        setSelected(null); callbacks.current?.save()
      }}><Trash2 className="h-3 w-3" />删除</button>
      <button type="button" className={buttonClass} disabled={!count && !tool} title="仅清空当前标的和周期的手动画线" onClick={() => {
        cancel(); chart?.removeOverlay({ groupId: DRAWING_GROUP }); setSelected(null); setLocked(false); callbacks.current?.save()
      }}><X className="h-3 w-3" />清空</button>
      <span role="status" className="text-[10px] text-muted">{error ?? (tool ? `${DRAWING_TOOLS.find(item => item.name === tool)?.label} · Esc取消` : `${count} 条 · 自动保存`)}</span>
    </div>
  )
}
