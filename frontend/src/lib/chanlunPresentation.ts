import type { KlinePeriod } from './api'
import type { ChanlunAnalysis, ChanlunCandidateSignal } from './chanlun'

export const CHANLUN_OVERVIEW_PERIODS = ['1w', '1d', '30m'] as const
export type ChanlunOverviewPeriod = typeof CHANLUN_OVERVIEW_PERIODS[number]
export interface ChanlunPeriodItem {
  period: ChanlunOverviewPeriod
  analysis?: ChanlunAnalysis
  isLoading?: boolean
  error?: Error | null
  unavailable?: string
  onRetry?: () => void
}
export const CHANLUN_PERIOD_LABELS: Record<ChanlunOverviewPeriod, string> = { '1w': '周线', '1d': '日线', '30m': '30分钟' }

export function overviewPeriod(period: KlinePeriod): ChanlunOverviewPeriod {
  return period === '1w' || period === '30m' ? period : '1d'
}

/** Presentation of backend fields only; does not calculate pens, centers or signals. */
export function periodPresentation(item: ChanlunPeriodItem, asOf?: string | null, hideDates = false) {
  const a = item.analysis
  const unavailable = item.unavailable || item.error?.message
    || (a && ['invalid_data', 'engine_unavailable', 'unsupported'].includes(a.status) ? a.issues[0] || '分析暂不可用' : undefined)
  if (!a || unavailable) {
    return { trend: unavailable ? '暂不可用' : item.isLoading ? '计算中…' : '等待数据', direction: 'none' as const,
      phase: unavailable ? '分析失败 · 点击重试' : '结构待确认', signal: item.unavailable ? '当前周期暂不支持' : unavailable ? '未获取结构信号' : '正在读取周期数据' }
  }
  const direction = a.trendType === 'uptrend_proxy' ? 'up' : a.trendType === 'downtrend_proxy' ? 'down' : 'none'
  const trend = direction === 'up' ? '上涨趋势' : direction === 'down' ? '下跌趋势' : a.latestCenter ? '盘整' : '结构不足'
  const states = {
    newborn: '中枢形成 · 刚形成', extension: '中枢震荡 · 中枢延伸', oscillating: '中枢震荡 · 区间震荡',
    broken_up: '离开中枢 · 向上离开', broken_down: '离开中枢 · 向下离开',
  }
  const phase = a.interpretation ? `${a.interpretation.phase.label} · ${a.interpretation.phase.subtitle}`
    : a.latestCenter ? states[a.latestCenter.state] : '中枢待形成'
  const end = asOf || a.window.end
  let signal = '暂无结构信号'
  if (end) {
    const cutoff = end.length === 10 ? `${end} 23:59:59` : end.replace('T', ' ')
    const day = new Date(`${end.slice(0, 10)}T00:00:00Z`)
    // Month/week captions mean trailing 30/7 calendar dates, including observation day.
    day.setUTCDate(day.getUTCDate() - (item.period === '1w' ? 29 : item.period === '1d' ? 6 : 0))
    const start = day.toISOString().slice(0, 10)
    const latest = a.candidateSignals.filter(s => ['candidate', 'invalidated'].includes(s.status)
      && s.availableDate >= start && s.availableDate.replace('T', ' ') <= cutoff)
      .sort((x, y) => y.availableDate.localeCompare(x.availableDate)).at(0)
    if (latest) {
      const code = `${latest.kind.endsWith('_buy') ? 'B' : 'S'}${{ first: 1, second: 2, third: 3 }[latest.kind.split('_')[0] as 'first' | 'second' | 'third']}`
      const invalidated = latest.invalidatedAt && latest.invalidatedAt.replace('T', ' ') <= cutoff
      signal = `${code}${hideDates ? '' : ` ${latest.availableDate.slice(5, 10)}`} · ${invalidated ? '已失效' : '候选'}`
    } else if (a.window.start && a.window.start > start) {
      signal = '当前窗口无结构信号'
    } else {
      signal = `${item.period === '1w' ? '近一个月' : item.period === '1d' ? '近一周' : '当天'}无结构信号`
    }
  }
  return { trend, direction, phase, signal }
}

export function multiPeriodHeadline(items: ChanlunPeriodItem[]) {
  if (items.some(i => i.isLoading && !i.analysis)) return '分析中…'
  const levels = CHANLUN_OVERVIEW_PERIODS.map(period => items.find(i => i.period === period))
  const directions = levels.map(i => i && !i.error && !i.unavailable && i.analysis?.status === 'ready'
    ? periodPresentation(i).direction : undefined)
  const dominant = directions.findIndex(d => d === 'up' || d === 'down')
  if (dominant < 0) return directions.includes('none') ? '多级盘整' : items.some(i => i.error || i.unavailable) ? '周期数据不足' : '结构不足'
  const parent = directions[dominant], child = directions[dominant + 1]
  const prefix = parent === 'up' ? '上行' : '下行'
  return prefix + (child == null ? '结构' : child === 'none' ? '整理' : child === parent ? '推进' : parent === 'up' ? '回落' : '反弹')
}

export function miniTrendPoints(analysis?: ChanlunAnalysis) {
  const values = analysis?.bars.slice(-24).map(b => b.close).filter(Number.isFinite) ?? []
  if (values.length < 2) return []
  const min = Math.min(...values), span = Math.max(...values) - min
  return values.map((v, i) => `${(4 + i / (values.length - 1) * 112).toFixed(1)},${(span ? 36 - (v - min) / span * 28 : 22).toFixed(1)}`)
}

export function signalCode(signal: ChanlunCandidateSignal) {
  return `${signal.kind.endsWith('_buy') ? 'B' : 'S'}${{ first: 1, second: 2, third: 3 }[signal.kind.split('_')[0] as 'first' | 'second' | 'third']}`
}

/** Filtering by first-known time also protects historical views with later invalidations. */
export function activeChanlunSignals(analysis?: ChanlunAnalysis, asOf?: string | null) {
  const end = asOf || analysis?.window.end
  if (!analysis || !end) return []
  const normalize = (date: string) => date.length === 10 ? `${date} 23:59:59` : date.replace('T', ' ')
  const knownAt = (date: string) => date.length === 10 ? `${date} 15:00` : date.replace('T', ' ')
  const cutoff = normalize(end)
  return analysis.candidateSignals.filter(s => ['candidate', 'invalidated'].includes(s.status)
    && knownAt(s.availableDate) <= cutoff && (!s.invalidatedAt || knownAt(s.invalidatedAt) > cutoff))
    .sort((a, b) => b.availableDate.localeCompare(a.availableDate))
}

export function chanlunPriceLevels(items: ChanlunPeriodItem[], selected: ChanlunOverviewPeriod, asOf?: string | null) {
  const current = items.find(i => i.period === selected)
  const price = current?.analysis?.currentPrice
  if (!current || current.error || current.unavailable || price == null || !Number.isFinite(price) || price <= 0) return []
  const rows = items.filter(i => !i.error && !i.unavailable && i.analysis?.status === 'ready')
    .flatMap(i => (i.analysis?.interpretation?.levels ?? []).map(level => ({
      key: `${i.period}-${level.key}`, label: `${i.period === selected ? '' : CHANLUN_PERIOD_LABELS[i.period]}${level.label}`, price: level.price,
    })))
  const signal = activeChanlunSignals(current.analysis, asOf)[0]
  if (signal) rows.push({ key: 'signal', label: `${signalCode(signal)} 信号价位`, price: signal.price }, { key: 'boundary', label: `${signalCode(signal)} 失效边界`, price: signal.boundary })
  rows.push({ key: 'current', label: current.analysis?.bars.at(-1)?.isClosed === false ? '最新价（未闭合）' : '现价', price })
  return rows.map(row => ({ ...row, percent: (row.price / price - 1) * 100 }))
    .sort((a, b) => b.price - a.price || a.key.localeCompare(b.key))
}
