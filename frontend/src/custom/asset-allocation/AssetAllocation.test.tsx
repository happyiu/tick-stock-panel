// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AssetAllocation from './AssetAllocation'

const calls = vi.hoisted(() => ({ calculations: 0, payloads: [] as { mode: string; body: Record<string, unknown> }[] }))
vi.mock('echarts', () => ({ init: () => ({ setOption() {}, resize() {}, dispose() {} }) }))
vi.mock('@/lib/api', () => ({ api: {
  instrumentNames: async () => ({ names: { '510300.SH': '沪深300 ETF' } }),
  allocationTracking: async () => ({}),
  allocationPortfolios: async () => ({ one: { name: '已保存', symbols: ['510300.SH'], lookback: 126, max_weight: 1 } }),
  allocationCalculate: async (mode: string, body: Record<string, unknown>) => {
    calls.calculations++
    calls.payloads.push({ mode, body })
    const history = { return: .1, drawdown: -.05, points: [{ date: '2026-01-01', value: 1 }, { date: '2026-11-06', value: 1.1 }] }
    return { weights: [1], risk_contribution: [1], parameters: { symbols: ['510300.SH'] }, history: { hrp: history, equal: history },
      as_of: '2026-11-06', samples: 126, names: { '510300.SH': '沪深300 ETF' }, engine_version: '7.4.1' }
  },
} }))

let host: HTMLDivElement
let root: Root
let client: QueryClient
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } })
  calls.calculations = 0
  calls.payloads = []
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['allocation-portfolios'], { one: { name: '已保存', symbols: ['510300.SH'], lookback: 126, max_weight: 1 } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<QueryClientProvider client={client}><AssetAllocation /></QueryClientProvider>))
})
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove() })
const click = async (label: string) => {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === label)!
  expect(button).toBeTruthy()
  await act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
}
const selectSaved = async () => {
  const currentConfig = host.querySelector<HTMLButtonElement>('[aria-label^="配置 "]')!
  await act(async () => { currentConfig.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
  const savedConfig = host.querySelector<HTMLButtonElement>('#allocation-portfolio-menu button')!
  await act(async () => { savedConfig.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
}

it('restores a saved portfolio and displays its ETF and parameters', async () => {
  await selectSaved()
  expect(host.textContent).toContain('510300.SH')
  expect(host.querySelector<HTMLInputElement>('[aria-label="回看交易日"]')!.value).toBe('126')
})

it('guides new users and keeps tracking and backtest separate from configuration', async () => {
  await click('新建配置')
  const configName = host.querySelector<HTMLInputElement>('[aria-label="新建配置名称"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(configName, '测试配置')
    configName.dispatchEvent(new Event('input', { bubbles: true }))
    configName.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await click('创建配置')
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('配置仓位')
  expect(host.textContent).toContain('先算一组目标仓位')
  expect(host.querySelector<HTMLInputElement>('[aria-label="开始日期"]')).toBeNull()
  await click('调仓跟踪')
  expect(host.textContent).toContain('请先保存配置，再更新调仓建议')
  expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === '更新调仓建议')?.disabled).toBe(true)
  await click('历史回测')
  expect(host.textContent).toContain('填写 0.02 代表')
  expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === '运行历史回测')?.disabled).toBe(true)
})

it('keeps selected ETFs across tabs and clears stale calculated results after edits', async () => {
  await selectSaved()
  await click('计算目标仓位')
  expect(calls.calculations).toBe(1)
  expect(host.textContent).toContain('目标仓位')
  expect(host.textContent).toContain('100.00%')
  await click('调仓跟踪')
  await click('配置仓位')
  expect(host.textContent).toContain('100.00%')
  const remove = host.querySelector<HTMLButtonElement>('[aria-label="移除 510300.SH"]')!
  await act(async () => remove.click())
  expect(host.textContent).toContain('先算一组目标仓位')
  expect(host.textContent).not.toContain('100.00%')
})


it('runs the fixed Angel Devil close-price rule with explicit fee units', async () => {
  await selectSaved()
  await click('历史回测')
  expect(host.textContent).toContain('首日没有进攻信号就保持现金')
  expect(host.querySelector('[aria-label="调仓规则"]')).toBeNull()
  const fill = async (label: string, value: string) => {
    const input = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }
  await fill('开始日期', '2026-06-01')
  await fill('结束日期', '2026-11-07')
  await fill('单边费率', '0.02')
  await click('运行历史回测')
  expect(calls.payloads.at(-1)).toMatchObject({
    mode: 'backtest', body: { rebalance: 'angel_devil', start: '2026-06-01', end: '2026-11-07', fee: .0002 },
  })
  expect(host.textContent).toContain('天使魔鬼信号与动态配比回测')
})
