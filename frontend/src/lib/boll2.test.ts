import { expect, it } from 'vitest'
import { calculateBoll2 } from './boll2'

it('双重20周期窗口分别预热，REF使中轨从第21根、上下轨从第40根开始', () => {
  expect(calculateBoll2([])).toEqual([])
  const result = calculateBoll2(Array<number>(40).fill(100))
  expect(result.slice(0, 20).every(row => row.mid === null)).toBe(true)
  expect(result[20]).toEqual({ mid: 100, upper: null, lower: null })
  expect(result.slice(0, 39).every(row => row.upper === null && row.lower === null)).toBe(true)
  expect(result[39]).toEqual({ mid: 100, upper: 100, lower: 100 })
})

it('按每天各自的MA20求偏差，保持原公式而不是标准布林带', () => {
  const result = calculateBoll2(Array.from({ length: 45 }, (_, index) => index + 1))
  // 第39根的MA20为29.5；此前20个有效偏差均为9.5；第40根显示上一根结果。
  expect(result[39]).toEqual({ mid: 29.5, upper: 48.5, lower: 10.5 })
  expect(result[44]).toEqual({ mid: 34.5, upper: 53.5, lower: 15.5 })
})

it('当前收盘价变化不改变当前轨道；追加未来K线不改写历史', () => {
  const prefix = [...Array<number>(39).fill(100), 120]
  const result = calculateBoll2([...prefix, 130])
  expect(result.slice(0, 40)).toEqual(calculateBoll2(prefix))
  expect(result[39]).toEqual({ mid: 100, upper: 100, lower: 100 })
  expect(result[40].mid).toBe(101)
  expect(result[40].upper).toBeCloseTo(101 + 2 * Math.sqrt(361 / 20), 10)
  expect(result[40].lower).toBeCloseTo(101 - 2 * Math.sqrt(361 / 20), 10)
  expect(calculateBoll2([...prefix.slice(0, -1), 80])[39]).toEqual(result[39])
})

it('缺失价格中断窗口，重新预热，不跨过缺口连算', () => {
  const result = calculateBoll2([...Array<number>(40).fill(100), NaN, ...Array<number>(40).fill(10)])
  expect(result[40]).toEqual({ mid: 100, upper: 100, lower: 100 })
  expect(result[41]).toEqual({ mid: null, upper: null, lower: null })
  expect(result[61]).toEqual({ mid: 10, upper: null, lower: null })
  expect(result[80]).toEqual({ mid: 10, upper: 10, lower: 10 })
})
