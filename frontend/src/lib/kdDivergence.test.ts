import { expect, it } from 'vitest'
import { calculateKdDivergence } from './kdDivergence'

const bars = (closes: number[]) => closes.map(close => ({ close, high: 100, low: 0 }))
const closes = [...Array<number>(12).fill(50), 100, 5, 0, 30, 20, 20, 10, 5, 100, 90, 5, 95, 70, 0, 0, 5, 20, 20, 90, 95, 0, 90, 20]

it('9周期高低窗口、双EMA3和MA3按顺序计算，阈值信号在交叉当根触发', () => {
  const result = calculateKdDivergence(bars([...Array<number>(12).fill(0), 4]))
  expect(result.slice(0, 8).every(row => row.k === null)).toBe(true)
  expect(result[8].k).toBe(0)
  expect(result[9].d).toBeNull()
  expect(result[10].d).toBe(0)
  expect(result[12]).toMatchObject({ rsv: 2, k: 1, goldenCross: true, lowCross: true, buy: true, bottomDivergence: false })
  expect(result[12].d).toBeCloseTo(1 / 3, 12)
  const top = calculateKdDivergence(bars([...Array<number>(12).fill(100), 96]))[12]
  expect(top).toMatchObject({ rsv: 98, k: 99, deadCross: true, highCross: true, sell: true, topDivergence: false })
  expect(top.d).toBeCloseTo(299 / 3, 12)
})

it('动态REF对比上一次同方向交叉，DRAWLINE从其下一根D值起画', () => {
  const result = calculateKdDivergence(bars(closes))
  expect(result.flatMap((row, index) => row.bottomDivergence ? [index] : [])).toEqual([30])
  expect(result[30].bottomLineStart).toBe(21)
  expect(result[30].k).toBeCloseTo(36.06041908, 8)
  expect(result.flatMap((row, index) => row.topDivergence ? [index] : [])).toEqual([34])
  expect(result[34].topLineStart).toBe(26)
  expect(result[34].d).toBeCloseTo(49.84085063, 8)
  expect(result[12].bottomLineStart).toBeNull()
})

it('只读取当时可见数据，背离不提前发出，已有历史结果不被后续K线改写', () => {
  const full = calculateKdDivergence(bars(closes))
  const prefix = calculateKdDivergence(bars(closes.slice(0, 30)))
  expect(full.slice(0, 30)).toEqual(prefix)
  expect(prefix.some(row => row.bottomDivergence || row.topDivergence)).toBe(false)
})

it('空数据、零振幅和缺失价格不产生NaN或虚假信号，缺口后重新预热', () => {
  expect(calculateKdDivergence([])).toEqual([])
  const flat = calculateKdDivergence(Array.from({ length: 20 }, () => ({ close: 10, high: 10, low: 10 })))
  expect(flat.every(row => row.k === null && row.d === null && !row.buy && !row.sell)).toBe(true)
  const result = calculateKdDivergence([...bars(closes), { high: NaN, low: 0, close: 1 }, ...bars(Array<number>(12).fill(50))])
  expect(result.slice(35, 44).every(row => row.k === null && !row.goldenCross && !row.deadCross)).toBe(true)
  expect(result.at(-1)).toMatchObject({ k: 50, d: 50, bottomLineStart: null, topLineStart: null })
})

it('9根窗口滚动后排除旧极值，不把RSV直接当成K或复用标准KDJ', () => {
  const data = Array.from({ length: 12 }, (_, index) => ({ low: index, high: index + 2, close: index + 1 }))
  data[0].high = 100
  const result = calculateKdDivergence(data)
  expect(result[8]).toMatchObject({ rsv: 9, k: 9, d: null })
  expect(result[9]).toMatchObject({ rsv: 49.5, k: 29.25, d: null })
  expect(result[10].d).toBeCloseTo(29.25, 12)
})
