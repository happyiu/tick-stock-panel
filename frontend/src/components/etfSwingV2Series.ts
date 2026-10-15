import type { EtfSwingV2Row } from '@/lib/etfSwingV2'
import { getTheme } from '@/lib/theme'

export function buildEtfSwingV2Series(rows: EtfSwingV2Row[], dates: string[]): any[] {
  const light = getTheme() === 'light'
  const white = light ? '#374151' : '#FFFFFF'
  const yellow = light ? '#A16207' : '#FFFF00'
  const red = light ? '#DC2626' : '#FF0000'
  const green = light ? '#15803D' : '#00FF00'
  const magenta = light ? '#C026D3' : '#FF00FF'
  const cyan = light ? '#0E7490' : '#00FFFF'
  // 通达信COLOR按BBGGRR书写：FF66CC、009966分别对应这两种RGB色。
  const pink = light ? '#8B5CF6' : '#CC66FF'
  const olive = light ? '#4D7C0F' : '#669900'
  const series: any[] = [
    {
      name: 'ETF波段操盘V2 趋势柱', type: 'bar', barWidth: '45%',
      data: rows.map(row => row.k === null ? '-' : { value: row.k, itemStyle: { color: row.kUp ? pink : olive } }),
      animation: false, silent: true,
    },
    ...([
      ['k', '趋势强度', white, 2], ['d', '慢速线', yellow, 1],
    ] as const).map(([key, label, color, width]) => ({
      name: `ETF波段操盘V2 ${label}`, type: 'line', data: rows.map(row => row[key] ?? '-'),
      smooth: false, symbol: 'none', connectNulls: false, animation: false, silent: true,
      lineStyle: { color, width }, itemStyle: { color }, z: 3,
    })),
  ]
  series[1].markLine = {
    silent: true, symbol: 'none', animation: false, label: { show: false },
    data: [[20, olive], [50, '#888888'], [80, red]].map(([value, color]) => ({
      yAxis: value, lineStyle: { color, width: 1, type: 'dotted' },
    })),
  }
  for (const [key, text, y, color] of [
    ['bottomSignal', '底部观察', 8, yellow], ['buySignal', '试仓', 20, red], ['addSignal', '加仓', 35, magenta],
    ['topSignal', '高位观察', 90, cyan], ['sellSignal', '减仓', 78, green], ['exitSignal', '退出预警', 96, white],
  ] as const) {
    series.push({
      name: `ETF波段操盘V2 ${text}`, type: 'scatter',
      data: rows.flatMap((row, i) => row[key] ? [[dates[i], y]] : []),
      symbolSize: 0, itemStyle: { color, opacity: 1 },
      label: { show: true, formatter: text, color, fontSize: 11, position: 'left', distance: 0 },
      labelLayout: { hideOverlap: true }, animation: false, silent: true, z: 10,
    })
  }
  return series
}
