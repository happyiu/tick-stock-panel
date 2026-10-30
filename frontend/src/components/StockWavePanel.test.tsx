// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { StockWavePanel } from './StockWavePanel'
it('缺少候选时不编造数浪，主图周期不匹配时禁用波浪标注', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div'); const root = createRoot(host)
  await act(async () => root.render(<StockWavePanel selected="" onSelect={() => {}} loading={false} error={false} retry={() => {}} enabled={false} toggle={() => {}} supported={false} />))
  expect(host.textContent).toContain('暂时无法可靠数浪')
  expect(host.textContent).toContain('内部子浪证据待验证')
  expect(host.querySelector('button')?.disabled).toBe(true)
  expect(host.querySelector('details')?.open).toBe(false)
  await act(async () => root.unmount())
})

it('展示具体复权差异和各周期数据，避免把有数据说成覆盖不足', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div'); const root = createRoot(host)
  const summary = '日线为前复权，30分钟为不复权，暂不进行跨周期对照'
  await act(async () => root.render(<StockWavePanel selected="" onSelect={() => {}} loading={false} error={false} retry={() => {}} enabled={false} toggle={() => {}} supported={true} confluence={summary} comparison={{status: 'adjustment_mismatch', summary, reasons: [summary], coverage: [{period: '1d', label: '日线', bars: 726, candidates: 3, start: '2023-10-30', end: '2026-10-27', adjustment: '前复权', stale: false}, {period: '30m', label: '30分钟', bars: 304, candidates: 3, start: '2026-09-01', end: '2026-10-27 15:00', adjustment: '不复权', stale: false}]}} />))
  expect(host.textContent).toContain(summary)
  expect(host.textContent).toContain('日线：726根已收盘K线，3个候选；前复权')
  expect(host.textContent).toContain('30分钟：304根已收盘K线，3个候选；不复权')
  expect(host.textContent).not.toContain('覆盖不足或复权口径不一致')
  await act(async () => root.unmount())
})
