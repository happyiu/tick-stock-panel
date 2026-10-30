import { expect, it } from 'vitest'
import { waveLegLabel, waveSegmentTemplate } from './kline-chart-wave'

it('浪段名称区分主浪、子浪与形成中情景', () => {
  expect(waveLegLabel('1')).toBe('第1浪')
  expect(waveLegLabel('A')).toBe('A浪')
  expect(waveLegLabel('2', '第1浪')).toBe('第1浪 · 子浪 第2浪')
  expect(waveLegLabel('B', undefined, true)).toBe('B浪（形成中）')
})

it('按图表坐标在线段中点绘制说明，形成段保留虚线', () => {
  const figures = waveSegmentTemplate.createPointFigures!({
    chart: { getStyles: () => ({separator: {color: '#111111'}}) },
    overlay: {extendData: {label: 'A浪（形成中）', dashed: true}},
    coordinates: [{x: 10, y: 100}, {x: 110, y: 40}],
  } as never)
  expect(figures).toEqual(expect.arrayContaining([
    expect.objectContaining({type: 'line', styles: expect.objectContaining({style: 'dashed'})}),
    expect.objectContaining({type: 'text', attrs: expect.objectContaining({x: 60, y: 62, text: 'A浪（形成中）'})}),
  ]))
})
