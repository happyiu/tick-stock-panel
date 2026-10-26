// @vitest-environment jsdom
import { act } from 'react'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StockDailyKChart } from './StockDailyKChart'
import type { CandlestickProps } from '@/lib/kline-chart'
import { emptyChanlunAnalysis } from '@/lib/chanlun'

const directory = resolve(import.meta.dirname, '../../../backend/app/indicators/chart_defaults')
const definitions = readdirSync(directory).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(resolve(directory, name), 'utf8')))

vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    isLoading: false, isError: false, isSuccess: true,
    data: queryKey[0] === 'chart-indicators' ? { items: definitions, errors: [] } : queryKey[0].startsWith('kline') ? {
      asset_type: 'etf', rows: [{ date: '2026-10-08', open: 3, high: 4, low: 2, close: 3 }],
    } : undefined,
  }),
}))
vi.mock('./KLineCandlestick', async importOriginal => ({
  ...await importOriginal<typeof import('./KLineCandlestick')>(),
  KLineCandlestick: ({ activeIndicators = [], period, showMA, toolbarControls, volumeCompareControls }: CandlestickProps) =>
    <div data-indicators={activeIndicators.join(',')} data-period={period} data-show-ma={String(showMA)}>{toolbarControls}{activeIndicators.includes('vol') && volumeCompareControls}</div>,
}))

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  localStorage.clear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === text)
  expect(button, text).toBeDefined()
  await act(async () => button!.click())
}
async function render(symbol = '510300.SH') {
  await act(async () => root.render(<StockDailyKChart symbol={symbol} />))
}

it('量比控件传入成交量副图，周期和开关沿用原有持久化，关闭副图时不残留', async () => {
  await render()
  expect(host.querySelectorAll('[aria-label="开启量能对比"]')).toHaveLength(1)
  expect(host.querySelector('[data-indicators] [aria-label="量能对比周期"]')).not.toBeNull()
  const select = host.querySelector<HTMLSelectElement>('[aria-label="量能对比周期"]')!
  await act(async () => { select.value = '5'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="开启量能对比"]')!.click())
  expect(select.disabled).toBe(true)
  await act(async () => root.render(null))
  await render('159915.SZ')
  expect(host.querySelector('[aria-label="开启量能对比"]')?.getAttribute('aria-checked')).toBe('false')
  expect(host.querySelector<HTMLSelectElement>('[aria-label="量能对比周期"]')?.value).toBe('5')
  await click('指标'); await click('副图')
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="成交量"]')!.click())
  expect(host.querySelector('[aria-label="量能对比周期"]')).toBeNull()
})

it('指标按主图叠加和副图分类，切换主图不改变已有副图，关闭恢复默认', async () => {
  localStorage.setItem('stock_preview_sub_charts', JSON.stringify(['vol', 'macd']))
  await render()
  await click('指标')
  expect(host.querySelector('[aria-label="指标类型"] [role="tab"][aria-selected="true"]')?.textContent).toBe('主图叠加')
  expect(host.querySelector('[role="checkbox"][aria-label="天使魔鬼"]')).not.toBeNull()
  const toggle = host.querySelector('[aria-label="天使魔鬼"]') as HTMLButtonElement
  await act(async () => toggle.click())
  expect(host.querySelector('[data-indicators]')?.getAttribute('data-indicators')).toBe('vol,macd,angel-devil')
  await click('副图')
  expect(host.querySelector('[role="checkbox"][aria-label="MACD"]')?.getAttribute('aria-checked')).toBe('true')
  await click('主图叠加')
  await act(async () => (host.querySelector('[aria-label="天使魔鬼"]') as HTMLButtonElement).click())
  expect(host.querySelector('[data-indicators]')?.getAttribute('data-indicators')).toBe('vol,macd')
})

it('重开图表保留主图选择，切股沿用设置，旧配置和未知key安全回退', async () => {
  localStorage.setItem('stock_preview_main_charts', JSON.stringify(['angel-devil', 'boll', 'unknown', 'angel-devil']))
  await render()
  expect(host.querySelector('[data-indicators]')?.getAttribute('data-indicators')).toBe('vol,angel-devil,boll')
  await render('159915.SZ')
  expect(host.querySelector('[data-indicators]')?.getAttribute('data-indicators')).toBe('vol,angel-devil,boll')
  await click('指标')
  await act(async () => (host.querySelector('[aria-label="天使魔鬼"]') as HTMLButtonElement).click())
  expect(JSON.parse(localStorage.getItem('stock_preview_main_charts')!)).toEqual(['boll'])
  expect(JSON.parse(localStorage.getItem('stock_preview_sub_charts')!)).toEqual(['vol'])
  await act(async () => root.unmount())
  root = createRoot(host)
  await render()
  expect(host.querySelector('[data-indicators]')?.getAttribute('data-indicators')).toBe('vol,boll')
})

it('boll2归类为主图叠加，和副图独立保存，重开仍保持选择', async () => {
  await render()
  await click('指标')
  const toggle = host.querySelector('[role="checkbox"][aria-label="boll2"]') as HTMLButtonElement
  expect(toggle).not.toBeNull()
  await act(async () => toggle.click())
  expect(host.querySelector('[data-indicators]')?.getAttribute('data-indicators')).toBe('vol,boll2')
  expect(JSON.parse(localStorage.getItem('stock_preview_main_charts')!)).toEqual(['boll2'])
  await click('副图')
  expect(host.querySelector('[aria-label="boll2"]')).toBeNull()
  await act(async () => root.unmount())
  root = createRoot(host)
  await render('159915.SZ')
  expect(host.querySelector('[data-indicators]')?.getAttribute('data-indicators')).toBe('vol,boll2')
})

it('KD背离只出现在副图菜单，保存选择并与主图指标同时恢复', async () => {
  localStorage.setItem('stock_preview_main_charts', JSON.stringify(['boll2']))
  await render()
  await click('指标')
  expect(host.querySelector('[role="checkbox"][aria-label="KD背离"]')).toBeNull()
  await click('副图')
  const toggle = host.querySelector('[role="checkbox"][aria-label="KD背离"]') as HTMLButtonElement
  expect(toggle).not.toBeNull()
  await act(async () => toggle.click())
  expect(JSON.parse(localStorage.getItem('stock_preview_sub_charts')!)).toEqual(['vol', 'kd-divergence'])
  expect(JSON.parse(localStorage.getItem('stock_preview_main_charts')!)).toEqual(['boll2'])
  await act(async () => root.unmount())
  root = createRoot(host)
  await render('159915.SZ')
  expect(host.querySelector('[data-indicators]')?.getAttribute('data-indicators')).toBe('vol,kd-divergence,boll2')
})

it('精准背离增强版作为独立副图保存，不覆盖原KD背离', async () => {
  localStorage.setItem('stock_preview_sub_charts', JSON.stringify(['kd-divergence']))
  await render()
  await click('指标')
  await click('副图')
  const toggle = host.querySelector('[role="checkbox"][aria-label="K/D精准背离增强版"]') as HTMLButtonElement
  expect(toggle).not.toBeNull()
  await act(async () => toggle.click())
  expect(JSON.parse(localStorage.getItem('stock_preview_sub_charts')!)).toEqual(['kd-divergence', 'kd-enhanced'])
  await act(async () => root.unmount())
  root = createRoot(host)
  await render('159915.SZ')
  expect(host.querySelector('[data-indicators]')?.getAttribute('data-indicators')).toBe('kd-divergence,kd-enhanced')
})

it('ETF波段操盘V2归入副图并提示30分钟，切股重开保留选择', async () => {
  await render()
  await click('指标')
  expect(host.querySelector('[aria-label="ETF波段操盘V2"]')).toBeNull()
  await click('副图')
  const toggle = host.querySelector('[aria-label="ETF波段操盘V2"]') as HTMLButtonElement
  expect(toggle).not.toBeNull()
  expect(toggle.textContent).toContain('建议30分钟')
  await act(async () => toggle.click())
  expect(JSON.parse(localStorage.getItem('stock_preview_sub_charts')!)).toEqual(['vol', 'etf-swing-v2'])
  await act(async () => root.unmount())
  root = createRoot(host)
  await render('159915.SZ')
  expect(host.querySelector('[data-indicators]')?.getAttribute('data-indicators')).toBe('vol,etf-swing-v2')
})


it('多空趋势V2归为副图，图表明确传递30分钟/日线周期并保存选择', async () => {
  await render()
  await click('指标')
  await click('副图')
  const toggle = host.querySelector('[aria-label="多空趋势V2"]') as HTMLButtonElement
  expect(toggle).not.toBeNull()
  await act(async () => toggle.click())
  expect(JSON.parse(localStorage.getItem('stock_preview_sub_charts')!)).toEqual(['vol','bull-bear-trend-v2'])
  await act(async () => root.render(<StockDailyKChart symbol="510300.SH" period="30m" />))
  expect(host.querySelector('[data-indicators]')?.getAttribute('data-period')).toBe('30m')
  await act(async () => root.render(<StockDailyKChart symbol="510300.SH" period="1d" />))
  expect(host.querySelector('[data-indicators]')?.getAttribute('data-period')).toBe('1d')
  expect(host.querySelector('[data-indicators]')?.getAttribute('data-indicators')).toBe('vol,bull-bear-trend-v2')
})

it('内置指标沿用主副图菜单与持久化，重开和切股恢复选择', async () => {
  await render()
  await click('指标')
  expect(host.querySelector('[aria-label="EMA 指数均线"]')).toBeNull()
  await click('内置')
  const ema = host.querySelector<HTMLButtonElement>('[aria-label="EMA 指数均线"]')!
  expect(ema).not.toBeNull()
  await act(async () => ema.click())
  await click('副图')
  const cci = host.querySelector<HTMLButtonElement>('[aria-label="CCI 顺势指标"]')!
  await act(async () => cci.click())
  expect(JSON.parse(localStorage.getItem('stock_preview_main_charts')!)).toEqual(['builtin-ema'])
  expect(JSON.parse(localStorage.getItem('stock_preview_sub_charts')!)).toEqual(['vol', 'builtin-cci'])
  await act(async () => root.render(null))
  await render('159915.SZ')
  expect(host.querySelector('[data-indicators]')?.getAttribute('data-indicators')).toBe('vol,builtin-cci,builtin-ema')
})


it('指标来源默认自建，内置与自建分别保留主副图，重开回到自建且不改选择', async () => {
  localStorage.setItem('stock_preview_main_charts', JSON.stringify(['builtin-ema', 'boll']))
  await render()
  await click('指标')
  expect(host.querySelector('[aria-label="指标来源"] [aria-selected="true"]')?.textContent).toBe('自建')
  expect(host.querySelector('[aria-label="BOLL"]')?.getAttribute('aria-checked')).toBe('true')
  expect(host.querySelector('[aria-label="EMA 指数均线"]')).toBeNull()
  await click('内置')
  expect(host.querySelector('[aria-label="BOLL"]')).toBeNull()
  expect(host.querySelector('[aria-label="EMA 指数均线"]')?.getAttribute('aria-checked')).toBe('true')
  await click('副图')
  expect(host.querySelector('[aria-label="CCI 顺势指标"]')).not.toBeNull()
  expect(host.querySelector('[aria-label="MACD"]')).toBeNull()
  await click('自建')
  expect(host.querySelector('[aria-label="MACD"]')).not.toBeNull()
  expect(host.querySelector('[aria-label="CCI 顺势指标"]')).toBeNull()
  await click('内置')
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="关闭指标"]')!.click())
  await click('指标')
  expect(host.querySelector('[aria-label="指标来源"] [aria-selected="true"]')?.textContent).toBe('自建')
  expect(host.querySelector('[aria-label="MACD"]')).not.toBeNull()
  expect(host.querySelector('[data-indicators]')?.getAttribute('data-indicators')).toBe('vol,builtin-ema,boll')
})


it('MA在自建主图中默认选中，关闭与重开保持选择，不影响其他指标', async () => {
  localStorage.setItem('stock_preview_main_charts', JSON.stringify(['boll']))
  await render()
  await click('指标')
  const ma = () => host.querySelector<HTMLButtonElement>('[aria-label="MA 均线"]')!
  expect(ma()).not.toBeNull()
  expect(ma().getAttribute('aria-checked')).toBe('true')
  expect(host.querySelector('[data-show-ma]')?.getAttribute('data-show-ma')).toBe('true')
  await act(async () => ma().click())
  expect(host.querySelector('[data-show-ma]')?.getAttribute('data-show-ma')).toBe('false')
  expect(JSON.parse(localStorage.getItem('stock_preview_ma_visible')!)).toBe(false)
  expect(JSON.parse(localStorage.getItem('stock_preview_main_charts')!)).toEqual(['boll'])
  await act(async () => root.render(null))
  await render('159915.SZ')
  await click('指标')
  expect(ma().getAttribute('aria-checked')).toBe('false')
  expect(host.querySelector('[data-show-ma]')?.getAttribute('data-show-ma')).toBe('false')
  await act(async () => ma().click())
  expect(host.querySelector('[data-show-ma]')?.getAttribute('data-show-ma')).toBe('true')
  expect(host.querySelector('[data-indicators]')?.getAttribute('data-indicators')).toBe('vol,boll')
  await click('内置')
  expect(ma()).toBeNull()
})


it('调用方明确关闭MA时隐藏菜单中的MA开关，保持原有组件契约', async () => {
  await act(async () => root.render(<StockDailyKChart symbol="A" showMA={false} />))
  await click('指标')
  expect(host.querySelector('[aria-label="MA 均线"]')).toBeNull()
  expect(host.querySelector('[data-show-ma]')?.getAttribute('data-show-ma')).toBe('false')
})

it('缠论新图层按后端能力开放，旧线段背驰配置隔离，新选择切股重开可恢复', async () => {
  localStorage.setItem('stock_preview_chanlun_overlay', JSON.stringify({ enabled: true, segments: true, divergences: true }))
  const analysis = emptyChanlunAnalysis()
  Object.assign(analysis.capabilities!, { segments: true, segmentRuleSource: 'project', divergences: true, trends: true, centerExtensions: true })
  await act(async () => root.render(<StockDailyKChart symbol="A" chanlunAnalysis={analysis} />))
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="配置缠论覆盖层"]')!.click())
  const toggle = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')].find(b => b.textContent?.trim() === label)!
  expect(toggle('线段（推导）').getAttribute('aria-checked')).toBe('false')
  expect(toggle('背驰观察').getAttribute('aria-checked')).toBe('false')
  for (const label of ['线段（推导）', '趋势', '背驰观察', '中枢延长线']) await act(async () => toggle(label).click())
  expect(JSON.parse(localStorage.getItem('stock_preview_chanlun_overlay')!)).toMatchObject({ chartRulesVersion: 1, segments: true, trends: true, divergences: true, centerExtensions: true })
  await act(async () => root.render(null))
  await act(async () => root.render(<StockDailyKChart symbol="B" chanlunAnalysis={analysis} />))
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="配置缠论覆盖层"]')!.click())
  expect(toggle('线段（推导）').getAttribute('aria-checked')).toBe('true')
  await act(async () => root.render(<StockDailyKChart symbol="B" chanlunAnalysis={emptyChanlunAnalysis()} />))
  expect(toggle('线段（推导）').disabled).toBe(true)
  expect(toggle('背驰观察').disabled).toBe(true)
})
