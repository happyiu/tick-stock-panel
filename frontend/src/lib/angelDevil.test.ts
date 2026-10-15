import { expect, it } from 'vitest'
import { calculateAngelDevil } from './angelDevil'

const closes = [...Array<number>(30).fill(100), 110, 112, 90, 88, 105]

it('按原公式计算均线、EMA和21周期回归外推，并在交叉当根发出信号', () => {
  const result = calculateAngelDevil(closes)
  expect(result[30].ma5).toBe(102)
  expect(result[30].ma13).toBeCloseTo(100 + 10 / 13, 10)
  expect(result[30].ma21).toBeCloseTo(100 + 10 / 21, 10)
  expect(result[30].ma34).toBeNull()
  expect(result[33].ma34).toBe(100)
  expect(result[30].angel).toBeCloseTo(106.66666666666667, 10)
  expect(result[30].devil).toBeCloseTo(100.58592570220476, 10)
  expect(result[32].angel).toBeCloseTo(96.74074074074075, 10)
  expect(result[32].devil).toBeCloseTo(100.94796390548964, 10)
  expect(result.slice(30).map(row => row.signal)).toEqual(['buy', null, 'sell', null, null])
  expect(result[30].bull).toBe(true)
  expect(result[32].bull).toBe(false)
})

it('空数据、历史不足和相等的两条线不产生虚假交叉', () => {
  expect(calculateAngelDevil([])).toEqual([])
  const result = calculateAngelDevil(Array<number>(100).fill(3.14159))
  expect(result.slice(0, 20).every(row => row.devil === null && row.bull === null)).toBe(true)
  expect(result.every(row => row.signal === null)).toBe(true)
  expect(result[20].devil).toBe(3.14159)
  expect(result[20].bull).toBe(true)
})

it('追加未来K线不修改历史信号；未收盘K线的信号随当前收盘价变化', () => {
  const prefix = closes.slice(0, 31)
  expect(calculateAngelDevil(closes).slice(0, 31)).toEqual(calculateAngelDevil(prefix))
  expect(calculateAngelDevil([...closes.slice(0, 30), 90]).at(-1)?.signal).toBe('sell')
  expect(calculateAngelDevil(prefix).at(-1)?.signal).toBe('buy')
})

it('无效价格打断窗口，不跨越缺失数据制造交叉', () => {
  const result = calculateAngelDevil([...closes, NaN, 120])
  expect(result.at(-2)?.angel).toBeNull()
  expect(result.at(-1)?.devil).toBeNull()
  expect(result.at(-1)?.ma5).toBeNull()
  expect(result.at(-1)?.signal).toBeNull()
})
