export interface DowPoint { date: string; confirmedAt: string; value: number; side: string; label: string }
export interface DowAnalysis {
  basis?: { structure: string; confirmation: DowAnalysis['events'][number] | null }
  paths?: { kind: string; structureReady?: boolean; direction: string; value: number | null; satisfied: boolean; anchorDate: string | null }[]
  breakoutVolume?: DowAnalysis['events'][number] | null
  version: string; period: string; status: string; structure: string; trend: string; damaged: boolean
  pivots: DowPoint[]; events: { kind: string; date: string; anchorDate: string; value: number; direction: string; volumeRatio: number | null }[]
  levels: { upper?: DowPoint; lower?: DowPoint; protection?: DowPoint }; issues: string[]
  dataThrough: string | null; coverageStart: string | null; forming: boolean; volume: number | null
}
export const DOW_PERIODS = ['1w', '1d', '30m'] as const
export const dowPeriod = (p: string) => ({ '1w': '周线', '1d': '日线', '30m': '30分钟' }[p] ?? p)
export const dowLabel = (p: string) => ({ HH: '高点抬高', HL: '低点抬高', LH: '高点降低', LL: '低点降低', EH: '等高', EL: '等低' }[p] ?? '首个拐点')
export const dowTrend = (a?: DowAnalysis) => !a ? '暂无结果' : a.status !== 'ok' ? ({ invalid_data: '数据异常', unsupported: '周期不支持', insufficient: '样本不足' }[a.status] ?? '暂无结果') : a.trend === 'unknown' ? '方向未确认' : `${a.trend === 'up' ? '上涨' : '下跌'}趋势${a.damaged ? '受损' : '有效'}`
