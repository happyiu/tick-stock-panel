// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { StockPreviewWatchlist, type PreviewWatchlistRow } from './StockPreviewWatchlist'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const host = document.createElement('div')
document.body.append(host)
let root = createRoot(host)
afterEach(async () => { await act(async () => root.unmount()); root = createRoot(host) })
const rows: PreviewWatchlistRow[] = [
  { symbol: '512000.SH', name: '证券ETF', asset_type: 'etf', close: 1, change_pct: -0.01, rt_price: 1.234, rt_pct: 0.0366 },
  { symbol: '600000.SH', name: '浦发银行', close: 10, change_pct: -0.02 },
  { symbol: '000001.SZ' },
]
const navigate = vi.fn()
async function render(items = rows, disabled = false) {
  await act(async () => root.render(<StockPreviewWatchlist rows={items} symbol="512000.SH" onNavigate={navigate} disabled={disabled} />))
}
async function click(label: string) {
  await act(async () => (host.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement).click())
}
it('默认收起，展开保持来源顺序、三行行情及当前标的，点击切股后可以收起', async () => {
  await render()
  expect(host.querySelector('aside')).toBeNull()
  await click('展开自选列表')
  const items = [...host.querySelectorAll('aside button[aria-current]')]
  expect(items.map(item => item.children[1].textContent)).toEqual(rows.map(row => row.symbol))
  expect(items[0].getAttribute('aria-current')).toBe('true')
  expect(items[0].children).toHaveLength(3)
  expect(items[0].textContent).toContain('1.234+3.66%')
  expect(items[1].textContent).toContain('10.00-2.00%')
  expect(items[2].textContent).toContain('——')
  await click('查看 浦发银行 600000.SH')
  expect(navigate).toHaveBeenLastCalledWith('600000.SH', '浦发银行')
  await click('收起自选列表')
  expect(host.querySelector('aside')).toBeNull()
})
it('复用新行情、保留缺失值，锁定时禁用切股，空列表有提示', async () => {
  await render(); await click('展开自选列表')
  await render([{ ...rows[0], rt_price: 0, rt_pct: 0 }], true)
  expect(host.textContent).toContain('0.0000.00%')
  expect((host.querySelector('aside button[aria-current]') as HTMLButtonElement).disabled).toBe(true)
  await render([])
  expect(host.textContent).toContain('当前自选列表为空')
})
