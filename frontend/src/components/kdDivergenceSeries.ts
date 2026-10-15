import { buildFormulaSticks } from './formulaSeries'
import type { KdDivergenceRow } from '@/lib/kdDivergence'
import { getTheme } from '@/lib/theme'

/** STICKLINE的上下端均来自公式值，不能用从0起画的普通柱图替代。 */
export function buildKdDivergenceSeries(rows: (KdDivergenceRow & { trial?: boolean; reduce?: boolean })[], dates: string[], enhanced = false): any[] {
  const name = enhanced ? 'K/D精准背离增强版' : 'KD背离'
  const light = getTheme() === 'light'
  const red = light ? '#DC2626' : '#FF0000'
  const green = light ? '#15803D' : '#00FF00'
  const yellow = light ? '#A16207' : '#FFFF00'
  const line = (label: string, data: (number | null)[], color: string) => ({
    name: `${name} ${label}`, type: 'line', data: data.map(value => value ?? '-'),
    symbol: 'none', smooth: false, connectNulls: false, silent: true, animation: false,
    lineStyle: { color, width: 1 }, itemStyle: { color },
  })
  const sticks = rows.flatMap((row, index) => {
    const points: any[] = []
    if (row.k !== null && row.d !== null && row.k !== row.d) {
      points.push({ value: [index, row.k, row.d, enhanced ? 2 : 2.5], itemStyle: { color: row.k > row.d ? red : green } })
    }
    if (!enhanced && row.buy) points.push({ value: [index, 3, 20, 8], itemStyle: { color: red } })
    if (!enhanced && row.sell) points.push({ value: [index, 85, 70, 8], itemStyle: { color: green } })
    return points
  })
  const series: any[] = [
    buildFormulaSticks(`${name} 柱线`, sticks),
    line('K', rows.map(row => row.k), enhanced ? (light ? '#374151' : '#FFFFFF') : yellow),
    line('D', rows.map(row => row.d), enhanced ? yellow : (light ? '#2563EB' : '#FFFFFF')),
    ...(enhanced ? [] : [
      line('底背离', rows.map(row => Number(row.bottomDivergence)), red),
      line('顶背离', rows.map(row => Number(row.topDivergence)), green),
    ]),
  ]
  if (enhanced) series[1].lineStyle.width = 2
  const reference = series[1]
  reference.markLine = {
    silent: true, symbol: 'none', animation: false,
    data: [
      { yAxis: 90, lineStyle: { color: green, type: 'solid' }, label: { formatter: '逃顶线 90', color: green } },
      { yAxis: 50, lineStyle: { color: red, type: 'solid' }, label: { formatter: '中轴线 50', color: red } },
      { yAxis: 10, lineStyle: { color: yellow, type: 'solid' }, label: { formatter: '抄底线 10', color: yellow } },
    ].map(item => ({ ...item, label: { ...item.label, position: 'insideEndTop', fontSize: 9 } })),
  }
  if (!enhanced) for (const [key, color, label] of [
    ['bottomLineStart', red, '底背离连线'], ['topLineStart', green, '顶背离连线'],
  ] as const) {
    const segments = rows.flatMap((row, index) => {
      const start = row[key]
      return start === null || rows[start]?.d == null || row.d === null ? [] : [[
        { coord: [dates[start], rows[start].d] }, { coord: [dates[index], row.d] },
      ]]
    })
    series.push({
      ...line(label, [], color),
      markLine: { data: segments, symbol: 'none', silent: true, label: { show: false }, lineStyle: { color, width: 1, type: 'solid' } },
    })
  }
  const markers = enhanced ? [
    ['lowCross', red, '金叉', 12, true], ['highCross', green, '死叉', 88, true],
    ['bottomDivergence', red, '底背离', 18, false], ['topDivergence', green, '顶背离', 82, false],
    ['buy', red, '超卖金叉', 30, false], ['sell', green, '超买死叉', 70, false],
    ['trial', yellow, '试仓', 40, false], ['reduce', green, '减仓', 60, false],
  ] as const : [
    ['lowCross', red, '金叉', 12, true], ['highCross', green, '死叉', 88, true],
    ['bottomDivergence', red, '加仓', null, false], ['topDivergence', green, '减仓', null, false],
    ['buy', red, '买', 30, false], ['sell', green, '卖', 70, false],
  ] as const
  for (const [key, color, text, y, arrow] of markers) {
    series.push({
      name: `${name} ${text}`, type: 'scatter',
      data: rows.flatMap((row, index) => row[key] ? [[dates[index], y ?? row.d! - 5]] : []),
      symbol: arrow ? 'arrow' : 'circle', symbolSize: arrow ? 9 : 0,
      symbolRotate: key === 'highCross' ? 180 : 0,
      itemStyle: { color, opacity: 1 },
      label: { show: !arrow, formatter: text, position: 'right', distance: 0, color, fontSize: 11 },
      labelLayout: { hideOverlap: true }, silent: true, animation: false, z: 10,
    })
  }
  return series
}
