import { expect, it } from 'vitest'
import { calculateEtfSwingV2 } from './etfSwingV2'

function sample(count = 1000) {
  let seed = 42
  const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296 }
  let previous = 3
  return Array.from({ length: count }, (_, i) => {
    const close = previous + (random() - 0.5) * 0.06 + Math.sin(i / 17) * 0.008
    const open = previous + (random() - 0.5) * 0.008
    const high = Math.max(open, close) + random() * 0.012
    const low = Math.min(open, close) - random() * 0.012
    const volume = 1000 * (0.6 + random() * 1.2)
    previous = close
    return { open, high, low, close, volume }
  })
}

it('按SMA递归计算K9/D9，66根才允许信号，STD使用20根样本标准差', () => {
  const data = Array.from({ length: 80 }, (_, i) => ({ open: i + 0.9, close: i + 1, high: i + 2, low: i, volume: 100 }))
  const result = calculateEtfSwingV2(data)
  expect(result[7].k).toBeNull()
  expect(result[8]).toMatchObject({ k: 90, d: 90 })
  expect(result[65].std).toBeCloseTo(Math.sqrt(35), 12)
  expect(result[65]).toMatchObject({ ready: true, rsi: 100, atr: 2, volumeRatio: 1, topCount: 4, bottomCount: 0, topSignal: true })
  expect(result[64].ready).toBe(false)
  expect(result.slice(0, 65).every(row => !row.bottomSignal && !row.topSignal && !row.buySignal && !row.addSignal && !row.sellSignal && !row.exitSignal)).toBe(true)
  const changed = data.map(row => ({ ...row }))
  changed[79].volume = 10000
  expect(calculateEtfSwingV2(changed)[79].volumeRatio).toBe(100)
})

it('固定行情样本复核六类信号及各自FILTER冷却，不把原始条件当作已发出的试仓', () => {
  const result = calculateEtfSwingV2(sample())
  // 固定值来自独立按公式逐序列计算的样本；包含试仓、突破加仓与两次收盘防守失败。
  const expected = {
    bottomSignal: [65, 172, 199, 279, 301, 366, 378, 390, 419, 433, 491, 505, 517, 591, 630, 716, 744, 802, 817, 868, 919],
    topSignal: [118, 149, 205, 220, 252, 325, 342, 358, 438, 459, 483, 545, 559, 578, 651, 700, 763, 777, 789, 873, 965, 981, 992],
    buySignal: [107, 194, 204, 315, 371, 418, 437, 510, 540, 624, 638, 735, 760, 822, 851, 954],
    addSignal: [858, 981],
    sellSignal: [144, 156, 170, 208, 228, 247, 264, 277, 290, 328, 339, 350, 363, 375, 447, 458, 478, 491, 505, 546, 565, 583, 598, 662, 686, 699, 712, 723, 766, 784, 796, 807, 818, 887, 906, 919, 931, 969, 991],
    exitSignal: [383, 434, 518, 631, 746, 828, 869],
  }
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    expect(result.flatMap((row, i) => row[key] ? [i] : []), key).toEqual(expected[key])
  }
  expect(result[166]).toMatchObject({ sellPre: true, sellSignal: false })
  expect(result[339]).toMatchObject({ sellPre: true, sellSignal: true })
  expect(result[857]).toMatchObject({ buyPre: true, buySignal: false, buyAge: 6 })
  expect(result[858]).toMatchObject({ addSignal: true, buyAge: 7 })
  expect(result[981]).toMatchObject({ addSignal: true, buyAge: 27 })
  expect(result[65].k).toBeCloseTo(12.505168583356177, 10)
  expect(result[65].d).toBeCloseTo(9.688995725799842, 10)
  expect(result[65].rsi).toBeCloseTo(34.45008078709511, 10)
})

it('防守参考锚定最近试仓时的3根低点、使用当前ATR，第二根收盘才提示退出', () => {
  const data = sample()
  const result = calculateEtfSwingV2(data)
  expect(result[107].buyLow).toBeCloseTo(Math.min(...data.slice(105, 108).map(row => row.low)), 12)
  expect(result[108].buyLow).toBe(result[107].buyLow)
  expect(result[108].stop).not.toBe(result[107].stop)
  expect(result[108].stop).toBeCloseTo(result[107].buyLow! - 0.15 * result[108].atr!, 12)
  expect(data[382].close).toBeLessThan(result[382].stop!)
  expect(result[382]).toMatchObject({ fail: false, exitSignal: false })
  expect(result[383]).toMatchObject({ fail: true, exitSignal: true })
  expect(result[384]).toMatchObject({ fail: true, exitSignal: false })
  expect(result[166]).toMatchObject({ hasBuy: true, buyAge: 59 })
  expect(result[167]).toMatchObject({ hasBuy: false, buyAge: 60, defense: null })
  expect(result[418].buyLow).not.toBe(result[417].buyLow)
})

it('FILTER屏蔽完整后8根，期间原始试仓条件不刷新计时', () => {
  const result = calculateEtfSwingV2(sample(1501))
  expect(result[1492].buySignal).toBe(true)
  expect(result[1500]).toMatchObject({ buyPre: true, buySignal: false, buyAge: 8 })
})

it('前缀不受追加未来数据影响；最新未闭合K线改变只影响当前及后续计算', () => {
  const data = sample(390)
  const full = calculateEtfSwingV2(data)
  expect(full.slice(0, 383)).toEqual(calculateEtfSwingV2(data.slice(0, 383)))
  const changed = data.map(row => ({ ...row }))
  changed[383] = { ...changed[383], close: 3.22, high: 3.23 }
  const result = calculateEtfSwingV2(changed)
  expect(result.slice(0, 383)).toEqual(full.slice(0, 383))
  expect(result[383].exitSignal).toBe(false)
})

it('空数据、零振幅、零成交量和缺口安全降级，缺少成交量不补造量能信号', () => {
  expect(calculateEtfSwingV2([])).toEqual([])
  const flat = Array.from({ length: 80 }, () => ({ open: 10, high: 10, low: 10, close: 10, volume: 0 }))
  const result = calculateEtfSwingV2(flat)
  expect(result[65]).toMatchObject({ k: 0, d: 0, rsi: 0, atr: 0.000001, volumeRatio: 0, buySignal: false, addSignal: false })
  const missingVolume = sample(120).map(row => ({ ...row, volume: undefined }))
  expect(calculateEtfSwingV2(missingVolume)[107]).toMatchObject({ volumeRatio: null, buySignal: false, addSignal: false })
  const gap = sample(200)
  gap[110].close = NaN
  const afterGap = calculateEtfSwingV2(gap)
  expect(afterGap[111]).toMatchObject({ ready: false, hasBuy: false, stop: null, buySignal: false, exitSignal: false })
  expect(afterGap[175].ready).toBe(false)
  expect(afterGap[176].ready).toBe(true)
})
