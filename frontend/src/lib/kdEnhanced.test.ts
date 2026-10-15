import { afterEach, expect, it, vi } from 'vitest'
import * as angelDevil from './angelDevil'
import * as kd from './kdDivergence'
import { calculateKdEnhanced } from './kdEnhanced'
import { calculateKdDivergence } from './kdDivergence'

function bottomBars(gap: number) {
  return Array.from({ length: 110 }, (_, i) => ({
    high: 200, low: i === 20 ? 80 : i === 20 + gap ? 70 : 100,
    close: i === 20 ? 90 : i >= 23 ? 170 : 110,
  }))
}
function topBars(gap: number) {
  return Array.from({ length: 110 }, (_, i) => ({
    low: 0, high: i === 20 ? 120 : i === 20 + gap ? 130 : 100,
    close: i === 20 ? 110 : i >= 23 ? 30 : 90,
  }))
}
afterEach(() => vi.restoreAllMocks())

it('增强版零振幅按50计算，原版仍留空；极小价差使用原式MAX下限', () => {
  const flat = Array.from({ length: 30 }, () => ({ high: 10, low: 10, close: 10 }))
  expect(calculateKdEnhanced([])).toEqual([])
  expect(calculateKdEnhanced(flat)[10]).toMatchObject({ rsv: 50, k: 50, d: 50, bottomDivergence: false, trial: false })
  expect(calculateKdDivergence(flat)[10].k).toBeNull()
  const tiny = Array.from({ length: 12 }, () => ({ high: 0.0000001, low: 0, close: 0.0000001 }))
  expect(calculateKdEnhanced(tiny)[10].k).toBeCloseTo(10, 10)
})

it.each([4, 5, 60, 61])('底分型延迟2根确认，前底距%s按5至60的闭区间过滤', gap => {
  const result = calculateKdEnhanced(bottomBars(gap))
  expect(result[20 + gap].bottomFractal).toBe(false)
  expect(result[21 + gap].bottomFractal).toBe(false)
  expect(result[22 + gap].bottomFractal).toBe(true)
  expect(result[22 + gap].bottomDistance).toBe(gap)
  expect(result[22 + gap].bottomDivergence).toBe(gap >= 5 && gap <= 60)
})

it.each([4, 5, 60, 61])('顶分型延迟2根确认，前顶距%s比较价格高点及K的5根高点', gap => {
  const result = calculateKdEnhanced(topBars(gap))
  expect(result[20 + gap].topFractal).toBe(false)
  expect(result[22 + gap].topFractal).toBe(true)
  expect(result[22 + gap].topDistance).toBe(gap)
  expect(result[22 + gap].topDivergence).toBe(gap >= 5 && gap <= 60)
})

it('只使用前一个分型，不越过距离过近的分型另找更早分型', () => {
  const data = bottomBars(10)
  data[26].low = 75
  const result = calculateKdEnhanced(data)
  expect(result[32]).toMatchObject({ bottomFractal: true, bottomDistance: 4, bottomDivergence: false })
})

it('底观察含确认当根及其后24根，趋势确认且K>D才标试仓', () => {
  const data = bottomBars(5)
  const trends = angelDevil.calculateAngelDevil(data.map(row => row.close))
  for (const i of [28, 51, 52]) trends[i].signal = 'buy'
  vi.spyOn(angelDevil, 'calculateAngelDevil').mockReturnValue(trends)
  const result = calculateKdEnhanced(data)
  expect(result[27].bottomDivergence).toBe(true)
  expect(result[28].trial).toBe(true)
  expect(result[51].bottomWatch).toBe(true)
  expect(result[52]).toMatchObject({ bottomWatch: false, trial: false })
  expect(result[26].trial).toBe(false)
})

it('顶观察期间趋势转空可标减仓，窗口到期后不延续', () => {
  const data = topBars(5)
  const trends = angelDevil.calculateAngelDevil(data.map(row => row.close))
  for (const i of [28, 52]) trends[i].signal = 'sell'
  vi.spyOn(angelDevil, 'calculateAngelDevil').mockReturnValue(trends)
  const result = calculateKdEnhanced(data)
  expect(result[27].topDivergence).toBe(true)
  expect(result[28]).toMatchObject({ topWatch: true, reduce: true })
  expect(result[52]).toMatchObject({ topWatch: false, reduce: false })
})

it('追加未来数据不会回写已确认信号，缺失数据清空观察且重新预热', () => {
  const data = bottomBars(5)
  const full = calculateKdEnhanced(data)
  expect(full.slice(0, 27)).toEqual(calculateKdEnhanced(data.slice(0, 27)))
  expect(full.slice(0, 27).every(row => !row.bottomDivergence)).toBe(true)
  const gap = calculateKdEnhanced([...data.slice(0, 29), { high: NaN, low: 1, close: 1 }, ...data.slice(30)])
  expect(gap[30]).toMatchObject({ k: null, bottomWatch: false, trial: false })
})


it('分型左侧必须严格突破，右侧允许同价，确认信号不回填', () => {
  const rightEqual = bottomBars(5)
  rightEqual[26].low = 70
  expect(calculateKdEnhanced(rightEqual)[27].bottomDivergence).toBe(true)
  const leftEqual = bottomBars(5)
  leftEqual[24].low = 70
  expect(calculateKdEnhanced(leftEqual)[27].bottomFractal).toBe(false)
})

it('底观察和趋势转多存在时，K不大于D仍不能试仓', () => {
  const data = bottomBars(5)
  const trends = angelDevil.calculateAngelDevil(data.map(row => row.close))
  trends[28].signal = 'buy'
  const values = kd.calculateKdDivergence(data, true)
  values[28] = { ...values[28], k: 20, d: 30 }
  vi.spyOn(angelDevil, 'calculateAngelDevil').mockReturnValue(trends)
  vi.spyOn(kd, 'calculateKdDivergence').mockReturnValue(values)
  expect(calculateKdEnhanced(data)[28]).toMatchObject({ bottomWatch: true, turnBull: true, trial: false })
})

it.each([49, 50])('顶观察中的死叉K=%s按50的含等号门槛筛减仓', k => {
  const data = topBars(5)
  const trends = angelDevil.calculateAngelDevil(data.map(row => row.close)).map(row => ({ ...row, signal: null }))
  const values = kd.calculateKdDivergence(data, true)
  values[28] = { ...values[28], k, deadCross: true }
  vi.spyOn(angelDevil, 'calculateAngelDevil').mockReturnValue(trends)
  vi.spyOn(kd, 'calculateKdDivergence').mockReturnValue(values)
  expect(calculateKdEnhanced(data)[28]).toMatchObject({ topWatch: true, reduce: k >= 50 })
})
