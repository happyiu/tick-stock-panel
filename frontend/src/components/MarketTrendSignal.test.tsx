// @vitest-environment node
import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarketTrendSignal } from './MarketTrendSignal'

it('renders the signal date, percentage points, inclusive bars and stale warning', () => {
  const html = renderToStaticMarkup(<MarketTrendSignal period="30m" error summary={{ status: 'ok', signal: 'attack', date: '2026-11-06 11:00:00', change_percent: 2.41, bars: 2, data_through: '2026-11-06 11:30' }} />)
  for (const text of ['进攻', '2026-11-06 11:00', '+2.41% · 2根', '刷新失败']) expect(html).toContain(text)
})

it('distinguishes loading, failure and missing candles', () => {
  expect(renderToStaticMarkup(<MarketTrendSignal period="1d" loading />)).toContain('计算中')
  expect(renderToStaticMarkup(<MarketTrendSignal period="1d" error />)).toContain('加载失败')
  expect(renderToStaticMarkup(<MarketTrendSignal period="1d" summary={{ status: 'empty', signal: null, date: null, change_percent: null, bars: null, data_through: null }} />)).toContain('暂无K线')
})
