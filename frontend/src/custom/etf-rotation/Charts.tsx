import { useMemo } from 'react'
import type { EChartsOption } from 'echarts'
import { useChartTheme } from '@/lib/theme'
import { useECharts } from '@/pages/backtest/charts/useECharts'
import type { RotationResult } from '@/lib/api'

export function RotationCharts({ result }: { result: RotationResult }) {
  const theme = useChartTheme()
  const option = useMemo<EChartsOption>(() => ({
    tooltip: { trigger: 'axis', valueFormatter: value => `${Number(value).toFixed(2)}%` },
    legend: { data: ['策略收益', ...(result.comparison ? ['基础复合动量'] : []), '沪深300', '等权基准', '回撤'], textStyle: { color: theme.text } },
    grid: { left: 60, right: 20, top: 40, bottom: 55 },
    xAxis: { type: 'category', data: result.daily.map(r => r.date), axisLabel: { color: theme.text } },
    yAxis: { type: 'value', axisLabel: { color: theme.text, formatter: '{value}%' }, splitLine: { lineStyle: { color: theme.grid } } },
    dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18 }],
    series: [
      { name: '策略收益', type: 'line', showSymbol: false, data: result.daily.map(r => r.return * 100) },
      ...(result.comparison ? [{ name: '基础复合动量', type: 'line' as const, showSymbol: false, data: result.comparison.daily.map(r => r.return * 100) }] : []),
      { name: '沪深300', type: 'line', showSymbol: false, data: result.benchmarks.map(r => r.hs300 * 100) },
      { name: '等权基准', type: 'line', showSymbol: false, data: result.benchmarks.map(r => r.equal_weight * 100) },
      { name: '回撤', type: 'line', showSymbol: false, data: result.daily.map(r => r.drawdown * 100), areaStyle: { opacity: .1 } },
    ],
  }), [result, theme])
  const ref = useECharts(option)
  return <div ref={ref} className="h-80 w-full" aria-label="收益与回撤曲线" />
}
