export type PatternDirection = 'bull' | 'bear' | 'neutral'
export type PatternCandle = [string, number, number, number, number, number | null]
export interface TrendPatternInputCandle {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number | null
  is_closed: boolean
  period_end: string | null
}
export interface PatternLevel {
  price: number
  kind: 'sup' | 'res'
  touches: number
  lastIdx: number | null
  lastDate: string
  dist: number
}
export interface PatternGeometry {
  start: string
  end: string
  paths: Array<{ label: string; points: Array<{ date: string; price: number }> }>
  zones: Array<{ start: string; end: string; lower: number; upper: number }>
}
export interface PatternHit {
  geometry?: PatternGeometry | null
  id: string
  name: string
  en: string
  dir: PatternDirection
  cat: string
  tag: string
  conf: number
  date: string
  at: number | null
  anchorAt: number | null
  confirmedAt: string | null
  status: 'forming' | 'confirmed'
  fresh: boolean
  note: string
  buy: string
  sell: string
  stop: string
  target: string
  triggerPrice: number | null
  stopPrice: number | null
  targetPrice: number | null
  vol_note: string
  volumeConfirmed: boolean | null
  scaled: false
  adviceSource: 'structure'
}
export interface TrendPatternAnalysis {
  momentumReversion?: MomentumReversionAnalysis
  version: string
  symbol: string
  name: string
  period: string
  status: 'ok' | 'insufficient'
  sampleCount: number
  catalogCount: number
  forming: boolean
  lastDate: string | null
  price: number | null
  prev: number | null
  issues: string[]
  candles: PatternCandle[]
  indicators: {
    ma: Record<'ma5' | 'ma10' | 'ma20' | 'ma60', Array<number | null>>
    macd: Record<'dif' | 'dea' | 'hist', Array<number | null>>
    rsi: Array<number | null>
    kdj: Record<'k' | 'd' | 'j', Array<number | null>>
    boll: Record<'mid' | 'up' | 'dn', Array<number | null>>
    obv: Array<number | null>
    volMa5: Array<number | null>
    volMa20: Array<number | null>
  }
  trend: Record<'short' | 'mid' | 'long', { verdict: string; window: number; swingHighs: number[]; swingLows: number[] }>
  swings: Record<'ph' | 'pl', Array<{ i: number; p: number; d: string; confirmedAt: string; confirmedIndex: number }>>
  levels: { support: PatternLevel[]; resistance: PatternLevel[] }
  patterns: PatternHit[]
  verdict: {
    stance: string
    stanceEn: string
    score: number | null
    patternScore: number | null
    maScore: number | null
    trendScore: number | null
    agree: boolean
    advice: string
    bullCount: number
    bearCount: number
    neutralCount: number
    maAlign: string
    ma: Record<string, number | null>
    volRatio: number | null
    nearestRes: PatternLevel | null
    nearestSup: PatternLevel | null
    rr: number | null
  }
}
export interface TeachingPattern {
  id: string
  name: string
  en: string
  cat: string
  dir: PatternDirection
  tag: string
  candles: Array<[number, number, number, number, number]>
  lines: Array<{ k1: number; p1: number; k2: number; p2: number; label: string }>
  steps: string[]
  buy: string
  sell: string
  stop: string
  target: string
  vol_note: string
}
export const PATTERN_CATEGORIES: Record<string, string> = {
  candle: 'K线组合', top: '顶部反转', bottom: '底部反转', cont: '中继整理', gap: '缺口', trend: '趋势结构',
}
export const PATTERN_TRENDS: Record<string, string> = {
  up: '上升', 'up-warn': '上升转弱', down: '下降', 'down-warn': '下降企稳', flat: '横盘', unknown: '样本不足',
}
export const plainPatternText = (text: string) => text.replace(/<[^>]*>/g, '')

export interface MomentumReversionAnalysis {
  opportunity?: null | { version: string; code: string; title: string; tone: 'neutral' | 'candidate' | 'warning'; reason: string; pending: string[] }
  version: string
  status: 'ok' | 'insufficient' | 'unavailable'
  lastDate: string | null
  environment: 'up' | 'down' | 'range' | 'unknown'
  issues: string[]
  interpretation: string
  metrics: Record<string, number | null>
  momentum: null | { score: number; delta: number; direction: 'strong' | 'weak' | 'neutral'; change: string; components: Record<string, number> }
  reversion: null | { score: number; state: 'none' | 'completed' | 'recovering' | 'deviation'; side: 'none' | 'low' | 'high'; started: boolean; anchorDate: string | null; anchorZ: number | null; components: Record<string, number>; conditions: string[] }
}
