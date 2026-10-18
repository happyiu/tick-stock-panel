// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { Chart, OverlayCreate } from 'klinecharts'
import { ChartDrawingToolbar, DRAWING_GROUP, normalizeDrawings } from './ChartDrawingToolbar'
import { storage } from '@/lib/storage'

let overlays: OverlayCreate[]
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
let sequence = 0
const chart = {
  getOverlays: vi.fn(({ groupId }) => overlays.filter(overlay => overlay.groupId === groupId)),
  createOverlay: vi.fn((value: OverlayCreate | OverlayCreate[]) => {
    const items = [value].flat().map(item => ({ ...item, id: `draw-${++sequence}` }))
    overlays.push(...items)
    return Array.isArray(value) ? items.map(item => item.id) : items[0].id
  }),
  removeOverlay: vi.fn((filter: { groupId?: string; id?: string }) => {
    const removed = overlays.filter(overlay => filter.id ? overlay.id === filter.id : overlay.groupId === filter.groupId)
    removed.forEach(overlay => overlay.onRemoved?.({ overlay } as never))
    overlays = overlays.filter(overlay => !removed.includes(overlay))
  }),
  overrideOverlay: vi.fn((value: OverlayCreate) => {
    overlays.forEach(overlay => { if (overlay.groupId === value.groupId) Object.assign(overlay, value) })
  }),
}
const chartRef = { current: chart as unknown as Chart }
const points = [{ timestamp: 1790812800000, value: 11 }, { timestamp: 1790899200000, value: 12 }]
const saved = [{ name: 'segment', points, lock: false }]
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.clearAllMocks(); localStorage.clear(); overlays = []; sequence = 0
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
const render = async (symbol = 'A', period = '1d', ready = true, hidden = false) => {
  await act(async () => root.render(<ChartDrawingToolbar chart={chartRef.current} symbol={symbol} period={period} ready={ready} hidden={hidden} />))
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find(button => button.textContent === label)
  expect(button, label).toBeDefined()
  await act(async () => button!.click())
}

it('坐标恢复拒绝未知工具、损坏数据和非有限值', () => {
  expect(normalizeDrawings(null)).toEqual([])
  expect(normalizeDrawings([null, {}, { name: 'system', points }, { name: 'segment', points: [points[0]] },
    { name: 'segment', points: [{ timestamp: NaN, value: 11 }, points[1]] }, ...saved])).toEqual(saved)
})

it('绘制、修改、吸附、锁定和删除只操作用户组，并保存最终坐标', async () => {
  overlays.push({ id: 'system', groupId: 'tsp-chanlun', name: 'system' })
  await render()
  expect(host.querySelector('[role="status"]')?.textContent).toBe('0 条')
  await click('画线'); await click('趋势线')
  const line = overlays.find(overlay => overlay.groupId === DRAWING_GROUP)!
  expect(line).toMatchObject({ name: 'segment', paneId: 'candle_pane', mode: 'normal' })
  expect(storage.chartDrawings('A', '1d').get([])).toEqual([])
  await act(async () => { line.points = points; line.onDrawEnd?.({ overlay: line } as never) })
  expect(storage.chartDrawings('A', '1d').get([])).toEqual(saved)
  await act(async () => line.onDeselected?.({ overlay: line } as never))
  expect(host.querySelector<HTMLButtonElement>('[aria-label="删除选中画线"]')?.disabled).toBe(true)
  await act(async () => line.onSelected?.({ overlay: line } as never))
  await click('吸附')
  expect(line.mode).toBe('strong_magnet')
  await act(async () => { line.points = [{ ...points[0], value: 15 }, points[1]]; line.onPressedMoveEnd?.({ overlay: line } as never) })
  expect((storage.chartDrawings('A', '1d').get([]) as typeof saved)[0].points[0].value).toBe(15)
  await click('锁定')
  expect(line.lock).toBe(true)
  expect((storage.chartDrawings('A', '1d').get([]) as typeof saved)[0].lock).toBe(true)
  await click('解锁'); await click('删除')
  expect(storage.chartDrawings('A', '1d').get([])).toEqual([])
  expect(overlays).toEqual([expect.objectContaining({ id: 'system' })])
})

it('切股、切周期和重新打开恢复各自画线，清空不删除其他上下文或系统覆盖层', async () => {
  storage.chartDrawings('A', '1d').set(saved)
  await render()
  expect(overlays).toHaveLength(1)
  await render('B')
  expect(overlays).toHaveLength(0)
  expect(storage.chartDrawings('A', '1d').get([])).toEqual(saved)
  await render('A', '30m')
  expect(overlays).toHaveLength(0)
  await render()
  expect(overlays).toHaveLength(1)
  await act(async () => root.render(null))
  await render()
  expect(overlays).toHaveLength(1)
  overlays.push({ id: 'system', name: 'system', groupId: 'tsp-levels' })
  await click('清空')
  expect(overlays.map(overlay => overlay.id)).toEqual(['system'])
  expect(storage.chartDrawings('A', '1d').get([])).toEqual([])
})

it('Esc取消未完成画线，空数据禁用；隐藏日期时不恢复历史标注', async () => {
  storage.chartDrawings('A', '1d').set(saved)
  await render('A', '1d', false)
  expect(host.querySelector<HTMLButtonElement>('[aria-label="画线工具"]')?.disabled).toBe(true)
  await render()
  await click('画线'); await click('价格通道')
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  await act(async () => document.dispatchEvent(event))
  expect(event.defaultPrevented).toBe(true)
  expect(overlays).toHaveLength(1)
  expect(storage.chartDrawings('A', '1d').get([])).toEqual(saved)
  await render('A', '1d', true, true)
  expect(overlays).toHaveLength(0)
  expect(host.textContent).toBe('')
  expect(storage.chartDrawings('A', '1d').get([])).toEqual(saved)
})


it('工具创建失败可重试，不写入未完成记录', async () => {
  await render()
  chart.createOverlay.mockReturnValueOnce(null as never)
  await click('画线'); await click('趋势线')
  expect(host.textContent).toContain('画线工具未就绪，请重试')
  expect(storage.chartDrawings('A', '1d').get([])).toEqual([])
  await click('趋势线')
  expect(overlays).toHaveLength(1)
  expect(host.textContent).toContain('Esc取消')
})
