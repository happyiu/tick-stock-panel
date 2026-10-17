import { beforeEach, expect, it, vi } from 'vitest'
import { api } from './api'
import { chanlunQueryOptions } from './chanlunQuery'
import { emptyChanlunAnalysis } from './chanlun'

vi.mock('./api', () => ({ api: { klineDaily: vi.fn(), klinePeriod: vi.fn() } }))
const range = { start: '2025-01-01', end: '2026-10-17' }
beforeEach(() => vi.clearAllMocks())

it('日线和分钟线复用行情入口，历史观察时刻原样传入后端', async () => {
  const analysis = emptyChanlunAnalysis('30m', 'segment')
  vi.mocked(api.klinePeriod).mockResolvedValue({ symbol: 'ETF', rows: [], chanlun: analysis })
  const options = chanlunQueryOptions('ETF', 'etf', '30m', range, 20, 'segment', '2026-10-15 10:00')
  expect(await options.queryFn()).toBe(analysis)
  expect(api.klinePeriod).toHaveBeenCalledWith('ETF', '30m', range, 20, false, { source: 'segment', asOf: '2026-10-15 10:00' })
  vi.mocked(api.klineDaily).mockResolvedValue({ symbol: 'ETF', rows: [], chanlun: emptyChanlunAnalysis() })
  await chanlunQueryOptions('ETF', 'etf', '1d', range, 20, 'stroke', null).queryFn()
  expect(api.klineDaily).toHaveBeenCalledWith('ETF', undefined, range, undefined, false, { source: 'stroke', asOf: null })
})

it('资产、周期、结构来源、历史时间、输入刷新版本均隔离缓存，不使用旧上下文占位', () => {
  const key = (...args: Parameters<typeof chanlunQueryOptions>) => chanlunQueryOptions(...args).queryKey
  const baseline = key('A', 'etf', '1d', range, 20, 'stroke', null, 1)
  for (const changed of [
    key('B', 'etf', '1d', range, 20, 'stroke', null, 1),
    key('A', 'stock', '1d', range, 20, 'stroke', null, 1),
    key('A', 'etf', '30m', range, 20, 'stroke', null, 1),
    key('A', 'etf', '1d', range, 20, 'segment', null, 1),
    key('A', 'etf', '1d', range, 20, 'stroke', '2026-10-14', 1),
    key('A', 'etf', '1d', range, 20, 'stroke', null, 2),
  ]) expect(changed).not.toEqual(baseline)
  expect(chanlunQueryOptions('A', 'etf', '1d', range, 20, 'stroke', null)).not.toHaveProperty('placeholderData')
})

it('旧后端和计算异常显式报错，不回退到前端旧公式', async () => {
  vi.mocked(api.klineDaily).mockResolvedValue({ symbol: 'A', rows: [] })
  const options = chanlunQueryOptions('A', 'etf', '1d', range, 20, 'stroke', null)
  await expect(options.queryFn()).rejects.toThrow('缠论计算结果缺失')
  vi.mocked(api.klineDaily).mockResolvedValue({ symbol: 'A', rows: [], chanlun: {
    ...emptyChanlunAnalysis(), status: 'invalid_data', issues: ['行情异常'],
  } })
  await expect(options.queryFn()).rejects.toThrow('行情异常')
})
