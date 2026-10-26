import { expect, it } from 'vitest'
import { emptyChanlunAnalysis, type ChanlunCandidateSignal } from './chanlun'
import { activeChanlunSignals, chanlunPriceLevels, miniTrendPoints, multiPeriodHeadline, periodPresentation, type ChanlunPeriodItem } from './chanlunPresentation'

function item(period: ChanlunPeriodItem['period'] = '1d', trend: 'uptrend_proxy' | 'downtrend_proxy' | 'consolidation_proxy' = 'uptrend_proxy'): ChanlunPeriodItem {
  const analysis = emptyChanlunAnalysis(period)
  Object.assign(analysis, { status: 'ready', trendType: trend, window: { start: '2026-01-01', end: '2026-10-26', bars: 200, mergedBars: 180 }, latestCenter: { state: 'newborn' } })
  return { period, analysis }
}
const signal = (change: Partial<ChanlunCandidateSignal> = {}): ChanlunCandidateSignal => ({ id: 'b1', kind: 'first_buy', status: 'candidate', source: 'stroke', structureDate: '2026-10-01', availableDate: '2026-10-22', price: 1, boundary: .9, invalidatedAt: null, relatedSignalId: null, conditions: [], nextWatch: '', ...change })

it('按后端趋势和中枢状态展示，不用末笔方向冒充趋势', () => {
  const row = item()
  expect(periodPresentation(row)).toMatchObject({ trend: '上涨趋势', phase: '中枢形成 · 刚形成', direction: 'up' })
  row.analysis!.latestCenter!.state = 'extension'
  expect(periodPresentation(row).phase).toBe('中枢震荡 · 中枢延伸')
  row.analysis!.trendType = 'unclear'
  row.analysis!.latestCenter = null
  expect(periodPresentation(row).trend).toBe('结构不足')
})

it('后端提供解读时，概览阶段与流程图保持一致', () => {
  const row = item()
  row.analysis!.interpretation = { phase: { key: 'leaving', label: '离开中枢', subtitle: '向上离开' } } as never
  expect(periodPresentation(row)).toMatchObject({ trend: '上涨趋势', phase: '离开中枢 · 向上离开' })
})

it('多级标题按相邻周期对照，缺失的中间周期不能跨越', () => {
  const weekly = item('1w'), daily = item(), minute = item('30m')
  expect(multiPeriodHeadline([weekly, daily, minute])).toBe('上行推进')
  daily.analysis!.trendType = 'downtrend_proxy'
  expect(multiPeriodHeadline([weekly, daily, minute])).toBe('上行回落')
  weekly.analysis!.trendType = 'downtrend_proxy'
  daily.analysis!.trendType = 'uptrend_proxy'
  expect(multiPeriodHeadline([weekly, daily, minute])).toBe('下行反弹')
  expect(multiPeriodHeadline([weekly, { period: '1d', error: new Error('失败') }, minute])).toBe('下行结构')
  expect(multiPeriodHeadline([{ period: '1w', isLoading: true }, daily, minute])).toBe('分析中…')
  expect(multiPeriodHeadline([item('1w', 'consolidation_proxy'), item('1d', 'consolidation_proxy')])).toBe('多级盘整')
})

it('周线近30天、日线近7天、分钟当天，按可知日期筛选并保留失效提示', () => {
  for (const period of ['1w', '1d', '30m'] as const) {
    const row = item(period)
    row.analysis!.candidateSignals = [signal()]
    expect(periodPresentation(row).signal).toBe(period === '30m' ? '当天无结构信号' : 'B1 10-22 · 候选')
  }
  const row = item()
  row.analysis!.candidateSignals = [signal({ status: 'invalidated', invalidatedAt: '2026-10-24' }), signal({ id: 'future', kind: 'third_sell', availableDate: '2026-10-27' })]
  expect(periodPresentation(row, '2026-10-26').signal).toBe('B1 10-22 · 已失效')
  expect(periodPresentation(row, '2026-10-23').signal).toBe('B1 10-22 · 候选')
  expect(periodPresentation(row, '2026-10-26', true).signal).toBe('B1 · 已失效')
})

it('分钟观察不读未来信号，窗口不足不声称完整一周无信号', () => {
  const row = item('30m')
  row.analysis!.candidateSignals = [signal({ availableDate: '2026-10-26 11:00' })]
  expect(periodPresentation(row, '2026-10-26 10:00').signal).toBe('当天无结构信号')
  const daily = item()
  daily.analysis!.window.start = '2026-10-25'
  expect(periodPresentation(daily).signal).toBe('当前窗口无结构信号')
})

it('加载、失败和空数据均明确显示，不显示默认上涨', () => {
  expect(periodPresentation({ period: '1d', isLoading: true }).trend).toBe('计算中…')
  expect(periodPresentation({ period: '1d', error: new Error('失败') }).trend).toBe('暂不可用')
  expect(periodPresentation({ period: '1d', analysis: emptyChanlunAnalysis() }).trend).toBe('结构不足')
  expect(multiPeriodHeadline([])).toBe('结构不足')
})

it('迷你图来自近期实际收盘，恒价及空输入无NaN', () => {
  expect(miniTrendPoints()).toEqual([])
  const a = emptyChanlunAnalysis()
  a.bars = [1, 2, 3].map((close, i) => ({ date: `2026-10-${20+i}`, open: close, close, high: close, low: close }))
  expect(miniTrendPoints(a)).toEqual(['4.0,36.0', '60.0,22.0', '116.0,8.0'])
  a.bars.forEach(b => b.close = 1)
  expect(miniTrendPoints(a).every(p => p.endsWith(',22.0'))).toBe(true)
})

it('详情信号在首次可知之后展示，失效当时移除，日周期在实际收盘可知', () => {
  const a = item().analysis!
  a.candidateSignals = [signal({ status: 'invalidated', invalidatedAt: '2026-10-24' }), signal({ id: 'today', availableDate: '2026-10-26' })]
  expect(activeChanlunSignals(a, '2026-10-23').map(s => s.id)).toEqual(['b1'])
  expect(activeChanlunSignals(a, '2026-10-24')).toEqual([])
  expect(activeChanlunSignals(a, '2026-10-26 14:30')).toEqual([])
  expect(activeChanlunSignals(a, '2026-10-26 15:00').map(s => s.id)).toEqual(['today'])
})

it('价位梯用所选周期现价作基准，排除失败周期，零宽中枢保留两个边界', () => {
  const current = item(), failed = item('1w')
  current.analysis!.currentPrice = 1
  current.analysis!.interpretation = { levels: [{ key: 'upper', label: '中枢上沿', price: 1 }, { key: 'lower', label: '中枢下沿', price: 1 }] } as never
  failed.error = new Error('失败')
  failed.analysis!.interpretation = { levels: [{ key: 'upper', label: '中枢上沿', price: 100 }] } as never
  const levels = chanlunPriceLevels([current, failed], '1d')
  expect(levels).toHaveLength(3)
  expect(levels.every(l => l.percent === 0)).toBe(true)
  current.analysis!.currentPrice = 0
  expect(chanlunPriceLevels([current], '1d')).toEqual([])
})
