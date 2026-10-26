// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { emptyChanlunAnalysis } from '@/lib/chanlun'
import { StockChanlunPanel } from './StockChanlunPanel'
import type { ChanlunPeriodItem } from '@/lib/chanlunPresentation'

function items(): ChanlunPeriodItem[] {
  return (['1w', '1d', '30m'] as const).map(period => {
    const a = emptyChanlunAnalysis(period)
    Object.assign(a, { status: 'ready', trendType: 'uptrend_proxy', latestCenter: { state: period === '1w' ? 'extension' : 'newborn' }, window: { start: '2026-01-01', end: '2026-10-26', bars: 100, mergedBars: 80 } })
    a.bars = [1, 2, 1.5, 3].map(close => ({ date: '2026-10-26', open: close, close, high: close, low: close }))
    a.latestCenter = { id: period, source: 'stroke', state: 'newborn', startStrokeIndex: 0, endStrokeIndex: 2, startDate: '2026-10-10', endDate: '2026-10-23', formedAt: '2026-10-26', zd: 1, zg: 2, dd: .8, gg: 2.2, componentCount: 3 }
    a.currentPrice = 1.5
    a.interpretation = { version: 1, ruleSource: 'project', asOf: '2026-10-26', closedPrice: 1.5,
      phase: { key: 'forming', label: '中枢形成', subtitle: '刚形成', description: '三笔形成有效重叠区间。' }, centerOrdinal: 1,
      legs: [{ label: 'a', strokes: [] }, { label: 'b', strokes: [] }], facts: [`${period}实际结构事实`],
      observation: { title: `${period}观察条件`, conditions: [{ id: 'upper', text: `${period}收盘越过 2.000 后继续观察`, state: 'waiting', warning: false }] },
      levels: [{ key: 'upper', label: '中枢上沿', price: 2 }, { key: 'lower', label: '中枢下沿', price: 1 }],
    }
    return { period, analysis: a }
  })
}

it('保留概览并接入走势解读，日线默认选中且阶段联动', () => {
  const html = renderToStaticMarkup(<StockChanlunPanel items={items()} period="1d" />)
  expect(html).not.toContain('缠论分析')
  expect(html).toContain('上行推进')
  expect(html).toContain('多级')
  for (const text of ['周线', '日线', '30分钟', '近一个月无结构信号', '近一周无结构信号', '当天无结构信号']) expect(html).toContain(text)
  expect(html).toContain('日线近期收盘走势')
  expect(html.match(/class="chanlun-overview-level" aria-pressed="true"/g)).toHaveLength(1)
  expect(html).toContain('日线 · 中枢形成 · 刚形成')
  expect(html).toContain('1d实际结构事实')
  expect(html).toContain('当前暂未提供')
  expect(html).not.toMatch(/买卖点候选|背驰分析|ZG|ZD|递归升级/)
})

it('切换卡片更新选中状态与迷你图，失败卡片可重试', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div'), root = createRoot(host), data = items()
  const retry = vi.fn()
  data[2] = { period: '30m', error: new Error('分钟源不可用'), onRetry: retry }
  await act(async () => root.render(<StockChanlunPanel items={data} period="1d" />))
  const buttons = host.querySelectorAll('button')
  expect(buttons[1].getAttribute('aria-pressed')).toBe('true')
  await act(async () => buttons[0].click())
  expect(buttons[0].getAttribute('aria-pressed')).toBe('true')
  expect(host.querySelector('svg')?.getAttribute('aria-label')).toBe('周线近期收盘走势')
  await act(async () => buttons[2].click())
  expect(retry).toHaveBeenCalledOnce()
  expect(host.querySelector('svg')).toBeNull()
  expect(host.textContent).toContain('暂不可用')
  await act(async () => root.unmount())
})

it('下一步观察展示本级、相邻级别和价位梯，切换级别保持当前视角', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div'), root = createRoot(host)
  await act(async () => root.render(<StockChanlunPanel items={items()} period="1d" assetType="etf" />))
  const click = async (label: string) => {
    const button = [...host.querySelectorAll('button')].find(b => b.textContent?.includes(label))!
    expect(button).toBeDefined()
    await act(async () => button.click())
  }
  await click('下一步观察')
  expect(host.textContent).toContain('本级（日线）')
  expect(host.textContent).toContain('下一级 · 区间套观察（30分钟）')
  expect(host.textContent).toContain('上一级 · 大环境（周线）')
  expect(host.textContent).toContain('关键价位')
  expect(host.textContent).toContain('2.000')
  await click('下一级 · 区间套观察')
  expect(host.textContent).toContain('本级（30分钟）')
  expect(host.textContent).toContain('30m收盘越过')
  expect(host.textContent).toContain('当前未接入该级别')
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('下一步观察')
  await click('走势分析')
  expect(host.textContent).toContain('30分钟 · 中枢形成 · 刚形成')
  expect(host.textContent).not.toContain('1d实际结构事实')
  await act(async () => root.unmount())
})

it('只展示当时有效的官方候选，区分首次可知、结构完成和项目失效边界，隐藏日期生效', () => {
  const data = items(), a = data[1].analysis!
  a.candidateSignals = [{ id: 'active', kind: 'first_buy', status: 'candidate', source: 'stroke', structureDate: '2026-10-20', availableDate: '2026-10-22', price: 1.234, boundary: 1.2, invalidatedAt: null, relatedSignalId: null, structureConfirmed: false, conditions: [], nextWatch: '', rule: { function: 'cxt_first_buy_V221126', params: { di: 1 } }, rawSignal: { key: 'key', value: '一买_任意_任意_0' } },
    { id: 'future', kind: 'second_sell', status: 'candidate', source: 'stroke', structureDate: '2026-10-26', availableDate: '2026-10-27', price: 9, boundary: 10, invalidatedAt: null, relatedSignalId: null, conditions: [], nextWatch: '' }]
  const html = renderToStaticMarkup(<StockChanlunPanel items={data} period="1d" asOf="2026-10-26" assetType="etf" />)
  expect(html).toContain('首次可知：2026-10-22')
  expect(html).toContain('对应笔：未完成')
  expect(html).toContain('1.234')
  expect(html).toContain('触及即失效，本项目规则')
  expect(html).toContain('cxt_first_buy_V221126')
  expect(html).not.toContain('辅助信号 · 已确认')
  expect(html).not.toContain('2026-10-27')
  const hidden = renderToStaticMarkup(<StockChanlunPanel items={data} period="1d" asOf="2026-10-26" hideDates />)
  expect(hidden).not.toContain('2026-10-22')
  expect(hidden).not.toContain('2026-10-20')
})

it('加载、空态和旧响应缺少解读时，不编造阶段与价位', () => {
  const render = (data: ChanlunPeriodItem[]) => renderToStaticMarkup(<StockChanlunPanel items={data} period="1d" />)
  expect(render([{ period: '1d', isLoading: true }])).toContain('正在计算日线结构')
  expect(render([{ period: '1d', analysis: emptyChanlunAnalysis() }])).toContain('当前结构不足')
  const a = emptyChanlunAnalysis(); a.status = 'ready'
  expect(render([{ period: '1d', analysis: a }])).toContain('结构解读尚未返回')
})
