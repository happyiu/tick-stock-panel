// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AnalysisKChart, LEVEL_GROUPS, type LevelType, type PriceLevel } from './AnalysisKChart'
import type { CandlestickProps } from '@/lib/kline-chart'
const state = vi.hoisted(() => ({ props: {} as CandlestickProps }))
vi.mock('../KLineCandlestick', () => ({ KLineCandlestick: (props: CandlestickProps) => { state.props = props; return <div data-kline-chart /> } }))
vi.mock('echarts', () => { throw new Error('个股分析K线不应加载ECharts') })
let host: HTMLDivElement, root: ReturnType<typeof createRoot>
const rows = Array.from({ length: 3 }, (_, i) => ({ date: `2026-10-${12 + i}`, open: 0.49, close: 0.497, high: 0.5, low: 0.48, volume: 100, amount: null }))
const levels = Object.fromEntries(LEVEL_GROUPS.map(group => [group.key, [] as PriceLevel[]])) as Record<LevelType, PriceLevel[]>
levels.sr = [{ type: 'sr', value: 0.49, label: '支撑', side: 'support' }]
levels.pivot = [
  { type: 'pivot', value: 0.50, label: 'P', side: 'neutral', rank: 0 },
  { type: 'pivot', value: 0.51, label: 'R1', side: 'resistance', rank: 1 },
  { type: 'pivot', value: 0.52, label: 'R2', side: 'resistance', rank: 2 },
]
levels.keltner_s = [{ type: 'keltner_s', value: 0.53, label: 'Keltner', side: 'resistance' }]
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
async function render(symbol = 'A') {
  await act(async () => root.render(<AnalysisKChart rows={rows} symbol={symbol} levels={levels} assetType="etf"
    seriesDates={[rows[2].date, rows[0].date]} series={{ keltner_s: { upper: [0.55, 0.54], lower: [0.45, 0.44] } }} />))
}
it('个股分析复用新引擎，曲线按日期对齐并保留缺失，枢轴按档位过滤', async () => {
  await render()
  expect(state.props).toMatchObject({ symbol: 'A', showMA: false, showInfoBar: false, visibleBars: 120, activeIndicators: ['vol'], showRangeSelector: true, priceLabelWidth: 144 })
  expect(state.props.priceLines?.map(line => line.label)).toEqual(['支撑', 'P', 'R1'])
  expect(state.props.priceCurves?.[0].data.map(row => row.value)).toEqual([0.54, null, 0.55])
  const rank2 = [...host.querySelectorAll('button')].find(button => button.textContent === '2')!
  await act(async () => rank2.click())
  expect(state.props.priceLines?.map(line => line.label)).toEqual(['支撑', 'P', 'R1', 'R2'])
  const sr = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('压力支撑'))!
  await act(async () => sr.click())
  expect(state.props.priceLines?.some(line => line.label === '支撑')).toBe(false)
  await render('B')
  expect(state.props.symbol).toBe('B')
})
it('图上价位与下方统计面板双向高亮，关闭曲线组立即移除', async () => {
  await render()
  await act(async () => state.props.onHighlightChange?.('sr-0.490'))
  expect(state.props.highlightedKey).toBe('sr-0.490')
  const support = [...host.querySelectorAll('span')].find(span => span.textContent === '支撑')!.parentElement!
  await act(async () => support.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })))
  expect(state.props.highlightedKey).toBeNull()
  await act(async () => support.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })))
  expect(state.props.highlightedKey).toBe('sr-0.490')
  const keltner = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('Keltner短期'))!
  await act(async () => keltner.click())
  expect(state.props.priceCurves).toEqual([])
})
