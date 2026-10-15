import type { BullBearTrendV2Row } from '@/lib/bullBearTrendV2'
import { getTheme } from '@/lib/theme'
import { buildFormulaSticks, type FormulaStick } from './formulaSeries'

export function buildBullBearTrendV2Series(rows: BullBearTrendV2Row[], dates: string[]): any[] {
  const light = getTheme() === 'light'
  const colors = {
    magenta: light ? '#C026D3' : '#FF00FF', green: light ? '#15803D' : '#00FF00',
    cyan: light ? '#0E7490' : '#00FFFF', red: light ? '#DC2626' : '#FF0000',
    yellow: light ? '#A16207' : '#FFFF00', white: light ? '#374151' : '#FFFFFF',
  }
  const series: any[] = ([
    ['dp', '多方强度', colors.magenta], ['lowPos', '低位程度', colors.green],
  ] as const).map(([key, label, color]) => ({
    name: `多空趋势V2 ${label}`, type: 'line', data: rows.map(row => row[key] ?? '-'),
    smooth: false, symbol: 'none', connectNulls: false, animation: false, silent: true,
    lineStyle: { color, width: 2 }, itemStyle: { color }, z: 3,
  }))
  series[0].markLine = {
    silent: true, symbol: 'none', animation: false, label: { show: false },
    data: [80, 50, 20].map(value => ({ yAxis: value, lineStyle: { color: '#808080', width: 1, type: 'dashed' } })),
  }
  const sticks: FormulaStick[] = []
  for (const [key, text, from, to, width, y, color] of [
    ['bottomSignal', '底观', 0, 12, 2, 14, colors.cyan],
    ['trySignal', '试仓', 0, 30, 3, 32, colors.red],
    ['addSignal', '加仓', 0, 50, 3, 52, colors.magenta],
    ['topSignal', '高观', 88, 100, 1, 84, colors.yellow],
    ['reduceSignal', '减仓', 70, 100, 3, 66, colors.green],
    ['exitSignal', '退出', 0, 100, 1, 91, colors.white],
  ] as const) {
    rows.forEach((row, i) => {
      if (row[key]) sticks.push({ value: [i, from, to, width], itemStyle: { color } })
    })
    series.push({
      name: `多空趋势V2 ${text}`, type: 'scatter',
      data: rows.flatMap((row, i) => row[key] ? [[dates[i], y]] : []),
      symbolSize: 0, itemStyle: { color, opacity: 1 },
      label: { show: true, formatter: text, color, fontSize: 11, position: 'left', distance: 0 },
      labelLayout: { hideOverlap: true }, animation: false, silent: true, z: 10,
    })
  }
  series.unshift(buildFormulaSticks('多空趋势V2 信号柱', sticks))
  return series
}
