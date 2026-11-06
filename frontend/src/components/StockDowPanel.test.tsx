// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { StockDowPanel } from './StockDowPanel'
import type { DowAnalysis } from '@/lib/dow'
it('展示缺失周期、受损趋势和重试，不伪造多周期同向', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div'); const root = createRoot(host)
  const analysis = { status: 'ok', trend: 'down', structure: 'down', damaged: true, pivots: [], levels: {}, events: [], issues: [], volume: null } as unknown as DowAnalysis
  let retried = false
  await act(async () => root.render(<StockDowPanel items={[{ period: '1d', analysis, loading: false, error: false, retry: () => {} }, { period: '30m', loading: false, error: true, retry: () => { retried = true } }]} selected="30m" onSelect={() => {}} enabled={false} onToggle={() => {}} supported={false} />))
  expect(host.textContent).toContain('下跌走势已被打断')
  expect(host.textContent).not.toContain('多周期同向')
  expect(host.querySelector('button[disabled]')).not.toBeNull()
  const retry = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('点击重试'))!
  await act(async () => retry.click())
  expect(retried).toBe(true)
  await act(async () => root.unmount())
})

it('默认折叠依据，受损写为已发生，量能引用确认事件', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div'); const root = createRoot(host)
  const analysis = { status: 'ok', trend: 'down', structure: 'mixed', damaged: true,
    pivots: [{ label: 'LH', value: 12, date: '2025-01-01', confirmedAt: '2025-01-03' }], levels: {},
    events: [{ kind: 'wick', date: '2025-01-06', value: 12 }], issues: [], volume: 9,
    breakoutVolume: { date: '2025-01-04', direction: 'down', volumeRatio: 1.3 },
    paths: [{ kind: 'damage', direction: 'up', value: 12, satisfied: true }] } as unknown as DowAnalysis
  await act(async () => root.render(<StockDowPanel items={[{ period: '1d', analysis, loading: false, error: false, retry: () => {} }]} selected="1d" onSelect={() => {}} enabled={false} onToggle={() => {}} supported />))
  expect(host.querySelector('details')?.open).toBe(false)
  expect(host.textContent).toContain('原走势被打断时的价位')
  expect(host.textContent).toContain('已出现收盘突破这里的记录')
  expect(host.textContent).toContain('1.30倍')
  expect(host.textContent).not.toContain('9.00倍')
  expect(host.textContent).not.toContain('共同偏')
  await act(async () => root.unmount())
})

it('历史确认保留原价位，新结构显示待确认，旧结构受损只等待新结构', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div'); const root = createRoot(host)
  const analysis = { status: 'ok', trend: 'up', structure: 'up', damaged: false,
    pivots: [], levels: {}, events: [], issues: [], volume: null,
    basis: { confirmation: { date: '2025-01-23', direction: 'up', value: 105.544 } },
    paths: [{ kind: 'confirmation', direction: 'up', value: 107.420, satisfied: false, structureReady: true }],
  } as unknown as DowAnalysis
  const render = () => root.render(<StockDowPanel items={[{ period: '1d', analysis, loading: false, error: false, retry: () => {} }]} selected="1d" onSelect={() => {}} enabled={false} onToggle={() => {}} supported />)
  await act(async () => render())
  expect(host.textContent).toContain('收盘突破 105.544')
  expect(host.textContent).toContain('107.42')
  expect(host.textContent).toContain('还需要收盘站上这里才能确认这次结构')
  analysis.damaged = true
  analysis.paths = [{ kind: 'recovery', direction: 'up', value: null, satisfied: false, anchorDate: null, structureReady: false }]
  await act(async () => render())
  expect(host.textContent).toContain('等待新的同向高低点结构')
  expect(host.textContent).not.toContain('还需要收盘站上这里')
  await act(async () => root.unmount())
})

it('当前结论跟随所选周期，直观对比高低点并保留标注开关', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div'); const root = createRoot(host)
  const base = { status: 'ok', structure: 'up', trend: 'up', damaged: false, levels: {}, events: [], issues: [], volume: null, paths: [],
    pivots: [
      { side: 'high', value: 10, date: '2026-01-01', confirmedAt: '2026-01-05', label: 'HH' },
      { side: 'low', value: 8, date: '2026-01-02', confirmedAt: '2026-01-06', label: 'HL' },
      { side: 'high', value: 12, date: '2026-01-07', confirmedAt: '2026-01-09', label: 'HH' },
      { side: 'low', value: 9, date: '2026-01-08', confirmedAt: '2026-01-12', label: 'HL' },
    ],
  } as unknown as DowAnalysis
  const items = [{ period: '1w', analysis: base, loading: false, error: false, retry: () => {} }, { period: '1d', analysis: { ...base, trend: 'down', structure: 'mixed' }, loading: false, error: false, retry: () => {} }]
  let selected = '1d', toggled = false
  const render = () => root.render(<StockDowPanel items={items} selected={selected} onSelect={p => { selected = p; render() }} enabled={false} onToggle={() => { toggled = true }} supported />)
  await act(async () => render())
  expect(host.querySelector('[aria-label="当前周期结论"]')?.textContent).toContain('日线 · 当前结论仍处于下跌阶段')
  expect(host.textContent).toContain('最近的高点和低点变化不一致')
  const weekly = [...host.querySelectorAll('button')].find(button => button.textContent?.startsWith('周线'))!
  await act(async () => weekly.click())
  expect(host.querySelector('[aria-label="当前周期结论"]')?.textContent).toContain('周线 · 当前结论仍处于上涨阶段')
  expect(host.textContent).toContain('高点 · 抬高10 → 12')
  expect(host.textContent).toContain('低点 · 抬高8 → 9')
  const toggle = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('主图高低点标注'))!
  await act(async () => toggle.click())
  expect(toggled).toBe(true)
  await act(async () => root.unmount())
})

it('没有有效确认价时不显示可执行价格，缺少周期不宣称共振', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div'); const root = createRoot(host)
  const analysis = { status: 'ok', trend: 'unknown', structure: 'mixed', damaged: false, pivots: [], events: [], levels: {}, issues: [],
    paths: [{ kind: 'confirmation', direction: 'up', value: null, satisfied: false }],
  } as unknown as DowAnalysis
  await act(async () => root.render(<StockDowPanel items={[{ period: '1d', analysis, loading: false, error: false, retry: () => {} }]} selected="1d" onSelect={() => {}} enabled={false} onToggle={() => {}} supported />))
  expect(host.textContent).toContain('暂时看不清方向')
  expect(host.textContent).toContain('暂无有效确认价')
  expect(host.textContent).not.toContain('三个周期方向一致：共同')
  expect(host.textContent).not.toContain('收盘站上这里才能确认')
  await act(async () => root.unmount())
})
