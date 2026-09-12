import { useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronLeft, Info, Settings2 } from 'lucide-react'
import type {
  KlinePeriod,
  KlineRow,
  ShortTermAnalysis,
  ShortTermAnalysisRow,
  TechnicalScoreCategory,
  TechnicalScoreIndicator,
  TechnicalRocPeriod,
  TechnicalScoreRow,
  TechnicalScores,
} from '@/lib/api'
import {
  storage,
  type StockPreviewTechnicalLayoutConfig,
  type StockTechnicalIndicatorKey,
} from '@/lib/storage'
import { fmtAssetPrice, fmtPct, fmtVolume } from '@/lib/format'

type Tone = 'bull' | 'bear' | 'neutral'
type ScoreKind = 'direction' | 'risk' | 'activity'

interface TechnicalMetric {
  label: string
  value: string
  tone?: Tone
}

interface TechnicalIndicatorModel {
  key: StockTechnicalIndicatorKey
  label: string
  description: string
  status: string
  tone: Tone
  metrics: TechnicalMetric[]
  summary?: string
  detail: string
}

interface TechnicalIndicatorDef {
  key: StockTechnicalIndicatorKey
  label: string
  description: string
}

interface TechnicalGroupDef {
  key: 'trend' | 'momentum' | 'volume_price' | 'environment'
  label: string
  description: string
  scoreKind: ScoreKind
  indicatorKeys: StockTechnicalIndicatorKey[]
}

const INDICATOR_DEFS: TechnicalIndicatorDef[] = [
  { key: 'ma_alignment', label: 'MA排列', description: '价格与 MA5/10/20/60 的多空排列' },
  { key: 'ma_slope', label: 'MA斜率', description: 'MA5/20/60 相对上一周期的方向' },
  { key: 'macd', label: 'MACD', description: '趋势动能与交叉状态' },
  { key: 'rsi', label: 'RSI', description: '相对强弱与超买超卖' },
  { key: 'kdj', label: 'KDJ', description: '摆动指标与交叉状态' },
  { key: 'roc', label: 'ROC', description: '5/20/60 周期方向、斜率与反转预警' },
  { key: 'volume_price', label: '量价共振', description: '价格方向与量比是否同步' },
  { key: 'atr', label: 'ATR / ATR%', description: '真实波幅与价格归一化波动' },
  { key: 'boll_width', label: 'BOLL带宽', description: '布林通道宽度的收缩与扩张' },
  { key: 'volume_ratio', label: '量比', description: '当前成交量相对前5周期均量' },
  { key: 'volume_trend', label: '成交量趋势', description: 'VOL5 与 VOL10 的活跃度变化' },
]

const GROUP_DEFS: TechnicalGroupDef[] = [
  {
    key: 'trend',
    label: '趋势',
    description: '均线排列与方向斜率',
    scoreKind: 'direction',
    indicatorKeys: ['ma_alignment', 'ma_slope'],
  },
  {
    key: 'momentum',
    label: '动能',
    description: 'MACD、摆动指标与 ROC',
    scoreKind: 'direction',
    indicatorKeys: ['macd', 'rsi', 'kdj', 'roc'],
  },
  {
    key: 'volume_price',
    label: '量价',
    description: '价格、当前放量与量能持续性',
    scoreKind: 'direction',
    indicatorKeys: ['volume_price', 'volume_ratio', 'volume_trend'],
  },
  {
    key: 'environment',
    label: '市场环境',
    description: '波动与流动性只作独立风险观察',
    scoreKind: 'risk',
    indicatorKeys: ['atr', 'boll_width'],
  },
]

const SHORT_TERM_GROUP_DEFS: TechnicalGroupDef[] = [
  { key: 'trend', label: 'MA / VWMA', description: '源项目均线与成交量加权均线', scoreKind: 'direction', indicatorKeys: ['ma_alignment', 'ma_slope'] },
  { key: 'momentum', label: 'MACD / KDJ', description: '源项目动能与摆动状态', scoreKind: 'direction', indicatorKeys: ['macd', 'kdj'] },
  { key: 'volume_price', label: '量价 / 换手', description: '价格、量比与成交活跃度', scoreKind: 'direction', indicatorKeys: ['volume_price', 'volume_ratio', 'volume_trend'] },
  { key: 'environment', label: 'BOLL / 位置 / ATR', description: '波动、价格位置与风险观察', scoreKind: 'risk', indicatorKeys: ['boll_width', 'atr'] },
]

const INDICATOR_BY_KEY = new Map(INDICATOR_DEFS.map(def => [def.key, def]))
const DEFAULT_VISIBLE = Object.fromEntries(INDICATOR_DEFS.map(def => [def.key, true])) as Partial<Record<StockTechnicalIndicatorKey, boolean>>
const PERIOD_LABELS: Record<KlinePeriod, string> = {
  '30m': '30F',
  '1d': '日K',
  '1w': '周K',
  '1mo': '月K',
}

const EMPTY_METRIC_LABELS: Record<StockTechnicalIndicatorKey, string[]> = {
  ma_alignment: ['MA5', 'MA20', 'MA60', '排列'],
  ma_slope: ['MA5斜率', 'MA20斜率', 'MA60斜率', '方向'],
  macd: ['DIF', 'DEA', 'MACD', '零轴'],
  rsi: ['RSI6', 'RSI14', 'RSI24', '方向'],
  kdj: ['K', 'D', 'J', '交叉'],
  roc: ['ROC5', 'ROC20', 'ROC60', '状态'],
  volume_price: ['量比', '成交方向', '同步性', '本周期'],
  atr: ['ATR14', 'ATR/价', '相对中位', '状态'],
  boll_width: ['上轨', '中轨', '下轨', '带宽'],
  volume_ratio: ['量比', 'VOL5', '前5均量', '状态'],
  volume_trend: ['VOL5', 'VOL10', 'VOL5/VOL10', '状态'],
}

const TONE_CLASSES: Record<Tone, { badge: string; value: string; dot: string }> = {
  bull: {
    badge: 'border-bull/30 bg-bull/10 text-bull',
    value: 'text-bull',
    dot: 'bg-bull',
  },
  bear: {
    badge: 'border-bear/30 bg-bear/10 text-bear',
    value: 'text-bear',
    dot: 'bg-bear',
  },
  neutral: {
    badge: 'border-border bg-elevated text-secondary',
    value: 'text-secondary',
    dot: 'bg-muted',
  },
}

interface TechnicalBar {
  key: string
  row: KlineRow
  close: number
}

function numberValue(value: unknown): number | null {
  if (value == null || value === '') return null
  const result = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(result) ? result : null
}

function normalizeBarKey(value: unknown, period: KlinePeriod): string {
  const raw = String(value ?? '')
  if (!raw) return ''
  return period === '30m'
    ? raw.replace('T', ' ').slice(0, 16)
    : raw.slice(0, 10)
}

function shortDate(value: string): string {
  return value.replace('T', ' ').slice(0, 16)
}

function normalizeBars(rows: KlineRow[], period: KlinePeriod): TechnicalBar[] {
  return rows
    .map(row => ({ key: normalizeBarKey(row.date, period), row, close: numberValue(row.close) }))
    .filter((bar): bar is TechnicalBar => !!bar.key && bar.close != null)
}

function field(bar: TechnicalBar | undefined, key: keyof KlineRow): number | null {
  return bar ? numberValue(bar.row[key]) : null
}

function fmtIndicator(value: number | null, digits = 2): string {
  return value == null ? '—' : value.toFixed(digits)
}

function fmtRocPeriod(period: TechnicalRocPeriod | undefined): string {
  const value = period?.value_pct ?? (period?.value != null ? period.value * 100 : null)
  if (value == null) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function fmtUnsignedPct(value: number | null, digits = 2): string {
  return value == null ? '—' : `${(value * 100).toFixed(digits)}%`
}

function fmtRatio(value: number | null): string {
  return value == null ? '—' : `${value.toFixed(2)}x`
}

function toneForChange(value: number | null): Tone {
  if (value == null || Math.abs(value) < 1e-12) return 'neutral'
  return value > 0 ? 'bull' : 'bear'
}

function toneForRocState(state?: string): Tone {
  if (state === 'STRONG_BULL_ACCEL' || state === 'BULL_RUN' || state === 'TURNING_BULLISH') return 'bull'
  if (state === 'STRONG_BEAR_ACCEL' || state === 'BEAR_RUN' || state === 'TURNING_BEARISH') return 'bear'
  return 'neutral'
}

function averageVolumeAt(bars: TechnicalBar[], index: number, window: number): number | null {
  if (index < window - 1) return null
  const values = bars.slice(index - window + 1, index + 1).map(bar => field(bar, 'volume'))
  const numericValues = values.filter((value): value is number => value != null)
  if (numericValues.length !== window) return null
  return numericValues.reduce((sum, value) => sum + value, 0) / window
}

function previousVolumeRatioAt(bars: TechnicalBar[], index: number, window: number): number | null {
  if (index < window) return null
  const current = field(bars[index], 'volume')
  const previous = bars.slice(index - window, index).map(bar => field(bar, 'volume'))
  const numericPrevious = previous.filter((value): value is number => value != null)
  if (current == null || numericPrevious.length !== window) return null
  const average = numericPrevious.reduce((sum, value) => sum + value, 0) / window
  return average > 0 ? current / average : null
}

function momentumAt(bars: TechnicalBar[], index: number, window: number): number | null {
  if (index < window) return null
  const current = bars[index]?.close
  const base = bars[index - window]?.close
  if (current == null || base == null || base <= 0) return null
  return current / base - 1
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function crossLabel(
  currentA: number | null,
  currentB: number | null,
  previousA: number | null,
  previousB: number | null,
  positive: string,
  negative: string,
): string | null {
  if (currentA == null || currentB == null || previousA == null || previousB == null) return null
  if (previousA <= previousB && currentA > currentB) return positive
  if (previousA >= previousB && currentA < currentB) return negative
  return null
}

function emptyIndicator(def: TechnicalIndicatorDef): TechnicalIndicatorModel {
  return {
    ...def,
    status: '样本不足',
    tone: 'neutral',
    metrics: EMPTY_METRIC_LABELS[def.key].map(label => ({ label, value: '—' })),
    detail: '当前周期暂未获得足够数据，指标不会给出推测结论。',
  }
}

function buildIndicator(
  def: TechnicalIndicatorDef,
  bars: TechnicalBar[],
  index: number,
  assetType?: 'stock' | 'etf' | 'index',
  scoreIndicator?: TechnicalScoreIndicator,
): TechnicalIndicatorModel {
  const current = bars[index]
  if (!current) return emptyIndicator(def)
  const previous = bars[index - 1]
  const get = (key: keyof KlineRow) => field(current, key)
  const getPrevious = (key: keyof KlineRow) => field(previous, key)
  const price = current.close

  switch (def.key) {
    case 'ma_alignment': {
      const ma5 = get('ma5')
      const ma10 = get('ma10')
      const ma20 = get('ma20')
      const ma60 = get('ma60')
      const deviation = ma20 != null && ma20 > 0 ? price / ma20 - 1 : null
      const shortComplete = [ma5, ma10, ma20].every(value => value != null)
      const complete = shortComplete && ma60 != null
      const bullish = complete && ma5! > ma10! && ma10! > ma20! && ma20! > ma60!
      const bearish = complete && ma5! < ma10! && ma10! < ma20! && ma20! < ma60!
      const status = !shortComplete
        ? '样本不足'
        : bullish ? '多头排列' : bearish ? '空头排列' : complete ? '均线纠缠' : '短中期排列'
      return {
        ...def,
        status,
        tone: status.includes('多头') ? 'bull' : status.includes('空头') ? 'bear' : 'neutral',
        summary: status,
        metrics: [
          { label: 'MA5', value: fmtAssetPrice(ma5, assetType) },
          { label: 'MA20', value: fmtAssetPrice(ma20, assetType) },
          { label: 'MA60', value: fmtAssetPrice(ma60, assetType) },
          { label: '距MA20', value: fmtPct(deviation), tone: toneForChange(deviation) },
        ],
        detail: !shortComplete
          ? '需要 MA5/10/20 完整样本'
          : complete ? '同时观察短中长期均线的相对位置' : 'MA60 暂无数据，当前仅展示短中期排列',
      }
    }

    case 'ma_slope': {
      const slopes = (['ma5', 'ma20', 'ma60'] as const).map(key => {
        const value = get(key)
        const prior = getPrevious(key)
        return value != null && prior != null && prior !== 0 ? value / prior - 1 : null
      })
      const available = slopes.filter((value): value is number => value != null)
      const status = !available.length
        ? '样本不足'
        : available.every(value => value > 0) ? '整体上行'
          : available.every(value => value < 0) ? '整体下行' : '方向分化'
      const shortStatus = slopes[0] == null ? '短线未知' : Math.abs(slopes[0]) < 0.0001 ? '短线走平' : slopes[0] > 0 ? '短线向上' : '短线向下'
      const medium = slopes.slice(1).filter((value): value is number => value != null)
      const mediumStatus = !medium.length ? '中期未知' : medium.every(value => value > 0) ? '中期向上' : medium.every(value => value < 0) ? '中期向下' : '中期分化'
      return {
        ...def,
        status,
        tone: status === '整体上行' ? 'bull' : status === '整体下行' ? 'bear' : 'neutral',
        summary: shortStatus + ' · ' + mediumStatus,
        metrics: [
          { label: 'MA5斜率', value: fmtUnsignedPct(slopes[0]), tone: toneForChange(slopes[0]) },
          { label: 'MA20斜率', value: fmtUnsignedPct(slopes[1]), tone: toneForChange(slopes[1]) },
          { label: 'MA60斜率', value: fmtUnsignedPct(slopes[2]), tone: toneForChange(slopes[2]) },
          { label: '方向', value: status },
        ],
        detail: !available.length ? '需要当前与上一周期的均线值' : shortStatus + ' · ' + mediumStatus + '；斜率按当前 K 线周期计算',
      }
    }

    case 'macd': {
      const dif = get('macd_dif')
      const dea = get('macd_dea')
      const hist = get('macd_hist') ?? (dif != null && dea != null ? (dif - dea) * 2 : null)
      const previousHist = getPrevious('macd_hist')
      const cross = crossLabel(dif, dea, getPrevious('macd_dif'), getPrevious('macd_dea'), '金叉', '死叉')
      const complete = dif != null && dea != null && hist != null
      const zeroAxis = dif != null && dea != null
        ? dif >= 0 && dea >= 0 ? '零轴上方' : dif < 0 && dea < 0 ? '零轴下方' : '跨越零轴'
        : '—'
      const histogramState = hist != null && previousHist != null
        ? Math.abs(hist) > Math.abs(previousHist) ? `${hist >= 0 ? '红' : '绿'}柱放大` : `${hist >= 0 ? '红' : '绿'}柱收敛`
        : null
      const tone: Tone = !complete ? 'neutral' : hist >= 0 && dif! >= dea! ? 'bull' : 'bear'
      return {
        ...def,
        status: !complete ? '样本不足' : cross ?? (dif! >= dea! ? 'DIF在DEA上方' : 'DIF在DEA下方'),
        tone,
        summary: !complete ? '样本不足' : [histogramState, zeroAxis].filter(Boolean).join(' · ') || '柱体方向暂未变化',
        metrics: [
          { label: 'DIF', value: fmtIndicator(dif, 3) },
          { label: 'DEA', value: fmtIndicator(dea, 3) },
          { label: 'MACD', value: fmtIndicator(hist, 3), tone },
          { label: '零轴', value: zeroAxis },
        ],
        detail: !complete ? '需要 DIF、DEA 和柱体完整样本' : [zeroAxis, histogramState].filter(Boolean).join(' · ') || '柱体方向暂未变化',
      }
    }

    case 'rsi': {
      const rsi6 = get('rsi_6')
      const rsi14 = get('rsi_14')
      const rsi24 = get('rsi_24')
      const complete = rsi6 != null && rsi14 != null && rsi24 != null
      const status = !complete ? '样本不足' : rsi14 >= 70 ? '超买区' : rsi14 <= 30 ? '超卖区' : rsi14 >= 50 ? '偏强' : '偏弱'
      const tone: Tone = !complete || rsi14! >= 70 || rsi14! <= 30 ? 'neutral' : rsi14! >= 50 ? 'bull' : 'bear'
      const direction = rsi14 != null && getPrevious('rsi_14') != null
        ? rsi14 > (getPrevious('rsi_14') ?? rsi14) ? 'RSI上行' : rsi14 < (getPrevious('rsi_14') ?? rsi14) ? 'RSI下行' : 'RSI走平'
        : null
      return {
        ...def,
        status,
        tone,
        summary: !complete ? '样本不足' : [status, direction].filter(Boolean).join(' · '),
        metrics: [
          { label: 'RSI6', value: fmtIndicator(rsi6, 1) },
          { label: 'RSI14', value: fmtIndicator(rsi14, 1), tone },
          { label: 'RSI24', value: fmtIndicator(rsi24, 1) },
          { label: '方向', value: direction ?? '—' },
        ],
        detail: !complete ? '需要 RSI6/14/24 完整样本' : 'RSI14 ≥70 为超买，≤30 为超卖参考区间',
      }
    }

    case 'kdj': {
      const k = get('kdj_k')
      const d = get('kdj_d')
      const j = get('kdj_j')
      const complete = k != null && d != null && j != null
      const cross = crossLabel(k, d, getPrevious('kdj_k'), getPrevious('kdj_d'), '金叉', '死叉')
      const status = !complete ? '样本不足' : Math.max(k, d, j) >= 80 ? '超买区' : Math.min(k, d, j) <= 20 ? '超卖区' : cross ?? (k >= d ? 'K在D上方' : 'K在D下方')
      const tone: Tone = !complete || Math.max(k ?? 0, d ?? 0, j ?? 0) >= 80 || Math.min(k ?? 100, d ?? 100, j ?? 100) <= 20
        ? 'neutral' : k! >= d! ? 'bull' : 'bear'
      return {
        ...def,
        status,
        tone,
        summary: !complete ? '样本不足' : [status, cross].filter(Boolean).join(' · '),
        metrics: [
          { label: 'K', value: fmtIndicator(k, 1) },
          { label: 'D', value: fmtIndicator(d, 1) },
          { label: 'J', value: fmtIndicator(j, 1) },
          { label: '交叉', value: cross ?? '—' },
        ],
        detail: !complete ? '需要 K/D/J 完整样本' : 'KDJ 80/20 为常用超买超卖参考区间',
      }
    }

    case 'roc': {
      const scoredIndicator = scoreIndicator
      const scoredPeriods = scoredIndicator?.periods
      if (scoredIndicator && scoredPeriods?.length) {
        const period5 = scoredPeriods.find(period => period.period === 5)
        const period20 = scoredPeriods.find(period => period.period === 20)
        const period60 = scoredPeriods.find(period => period.period === 60)
        const summary = scoredIndicator.summary ?? scoredIndicator.status
        return {
          ...def,
          status: scoredIndicator.status,
          tone: toneForRocState(scoredIndicator.state),
          summary,
          metrics: [
            { label: 'ROC5', value: fmtRocPeriod(period5), tone: toneForChange(period5?.value ?? null) },
            { label: 'ROC20', value: fmtRocPeriod(period20), tone: toneForChange(period20?.value ?? null) },
            { label: 'ROC60', value: fmtRocPeriod(period60), tone: toneForChange(period60?.value ?? null) },
            { label: '状态', value: summary },
          ],
          detail: scoredIndicator.detail,
        }
      }
      const values = [
        get('momentum_5d') ?? momentumAt(bars, index, 5),
        get('momentum_20d') ?? momentumAt(bars, index, 20),
        get('momentum_60d') ?? momentumAt(bars, index, 60),
      ]
      const available = values.filter((value): value is number => value != null)
      const status = !available.length ? '样本不足'
        : available.every(value => value > 0) ? '动能向上'
          : available.every(value => value < 0) ? '动能向下' : '方向分化'
      return {
        ...def,
        status,
        tone: status === '动能向上' ? 'bull' : status === '动能向下' ? 'bear' : 'neutral',
        summary: status,
        metrics: [
          { label: '5周期', value: fmtPct(values[0]), tone: toneForChange(values[0]) },
          { label: '20周期', value: fmtPct(values[1]), tone: toneForChange(values[1]) },
          { label: '60周期', value: fmtPct(values[2]), tone: toneForChange(values[2]) },
          { label: '方向', value: status },
        ],
        detail: !available.length ? '需要至少一个可用的历史收益窗口' : '使用现有 momentum 字段作为 ROC，按当前 K 线周期计算',
      }
    }

    case 'volume_price': {
      const ratio = get('vol_ratio_5d') ?? previousVolumeRatioAt(bars, index, 5)
      const previousClose = previous?.close ?? null
      const priceChange = get('change_pct') ?? (previousClose && previousClose > 0 ? price / previousClose - 1 : null)
      const status = ratio == null || priceChange == null ? '样本不足'
        : priceChange > 0 && ratio >= 1.2 ? '价涨量增'
          : priceChange < 0 && ratio >= 1.2 ? '价跌量增'
            : priceChange > 0 ? '价涨量平'
              : priceChange < 0 ? '价跌量平' : '价格走平'
      const tone = priceChange == null ? 'neutral' : toneForChange(priceChange)
      return {
        ...def,
        status,
        tone,
        summary: status,
        metrics: [
          { label: '量比', value: fmtRatio(ratio) },
          { label: '成交方向', value: priceChange == null ? '—' : priceChange >= 0 ? '上涨' : '下跌', tone },
          { label: '同步性', value: ratio == null ? '—' : ratio >= 1.2 ? '放量' : ratio <= 0.8 ? '缩量' : '平量' },
          { label: '本周期', value: fmtPct(priceChange), tone },
        ],
        detail: ratio == null ? '需要当前量及前 5 个周期成交量' : priceChange == null ? '量能已计算，暂缺价量方向' : priceChange >= 0 ? '价格上涨与成交量同步性用于量价分评分' : '价格下跌与成交量同步性用于量价分评分',
      }
    }

    case 'atr': {
      const atr = get('atr_14')
      const atrPct = atr != null && price > 0 ? atr / price : null
      const previousAtrPcts = bars.slice(Math.max(0, index - 20), index).map(bar => {
        const value = field(bar, 'atr_14')
        return value != null && bar.close > 0 ? value / bar.close : null
      }).filter((value): value is number => value != null)
      const baseline = previousAtrPcts.length === 20 ? median(previousAtrPcts) : null
      const relative = atrPct != null && baseline != null && baseline > 0 ? atrPct / baseline : null
      const status = atrPct == null ? '样本不足' : relative == null ? '样本不足' : relative >= 1.2 ? '波动放大' : relative <= 0.8 ? '波动收敛' : '波动常态'
      return {
        ...def,
        status,
        tone: 'neutral',
        summary: status,
        metrics: [
          { label: 'ATR14', value: fmtAssetPrice(atr, assetType) },
          { label: 'ATR/价', value: fmtUnsignedPct(atrPct) },
          { label: '相对中位', value: fmtRatio(relative) },
          { label: '状态', value: status },
        ],
        detail: relative == null ? '需要 ATR14 及此前 20 个周期作为波动基准' : '波动风险分使用 ATR/价格相对此前 20 周期中位数',
      }
    }

    case 'boll_width': {
      const upper = get('boll_upper')
      const middle = get('ma20')
      const lower = get('boll_lower')
      const complete = upper != null && middle != null && lower != null && middle > 0
      const bandwidth = complete ? (upper - lower) / middle : null
      const previousWidths = bars.slice(Math.max(0, index - 20), index).map(bar => {
        const u = field(bar, 'boll_upper')
        const m = field(bar, 'ma20')
        const l = field(bar, 'boll_lower')
        return u != null && l != null && m != null && m > 0 ? (u - l) / m : null
      }).filter((value): value is number => value != null)
      const baseline = previousWidths.length === 20 ? median(previousWidths) : null
      const relative = bandwidth != null && baseline != null && baseline > 0 ? bandwidth / baseline : null
      const status = !complete ? '样本不足' : relative == null ? '样本不足' : relative >= 1.2 ? '带宽扩张' : relative <= 0.8 ? '带宽收缩' : '带宽常态'
      return {
        ...def,
        status,
        tone: 'neutral',
        summary: status,
        metrics: [
          { label: '上轨', value: fmtAssetPrice(upper, assetType) },
          { label: '中轨', value: fmtAssetPrice(middle, assetType) },
          { label: '下轨', value: fmtAssetPrice(lower, assetType) },
          { label: '带宽', value: fmtUnsignedPct(bandwidth) },
        ],
        detail: relative == null ? '需要 BOLL 及此前 20 个周期作为带宽基准' : `带宽相对历史中位 ${fmtRatio(relative)}，仅用于波动风险观察`,
      }
    }

    case 'volume_ratio': {
      const ratio = get('vol_ratio_5d') ?? previousVolumeRatioAt(bars, index, 5)
      const vol5 = get('vol_ma5') ?? averageVolumeAt(bars, index, 5)
      const previousAverage = averageVolumeAt(bars, index - 1, 5)
      const status = ratio == null ? '样本不足' : ratio >= 2 ? '明显放量' : ratio >= 1.2 ? '温和放量' : ratio <= 0.8 ? '缩量' : '平量'
      return {
        ...def,
        status,
        tone: 'neutral',
        summary: ratio == null ? '样本不足' : status + ' · 量比 ' + fmtRatio(ratio),
        metrics: [
          { label: '量比', value: fmtRatio(ratio) },
          { label: 'VOL5', value: fmtVolume(vol5) },
          { label: '前5均量', value: fmtVolume(previousAverage) },
          { label: '状态', value: status },
        ],
        detail: ratio == null ? '需要当前量及前 5 个周期成交量' : '量比用于量价与量能持续性观察，不直接表示上涨或下跌',
      }
    }

    case 'volume_trend': {
      const vol5 = get('vol_ma5') ?? averageVolumeAt(bars, index, 5)
      const vol10 = get('vol_ma10') ?? averageVolumeAt(bars, index, 10)
      const relative = vol5 != null && vol10 != null && vol10 > 0 ? vol5 / vol10 : null
      const status = relative == null ? '样本不足' : relative >= 1.2 ? '短期活跃' : relative <= 0.8 ? '短期降温' : '活跃度常态'
      return {
        ...def,
        status,
        tone: 'neutral',
        summary: relative == null ? '样本不足' : status + ' · VOL5/VOL10 ' + fmtRatio(relative),
        metrics: [
          { label: 'VOL5', value: fmtVolume(vol5) },
          { label: 'VOL10', value: fmtVolume(vol10) },
          { label: 'VOL5/VOL10', value: fmtRatio(relative) },
          { label: '状态', value: status },
        ],
        detail: relative == null ? '需要至少 10 个当前周期成交量样本' : '短期均量与中期均量的相对变化用于量能持续性观察',
      }
    }
  }
}

function defaultLayoutConfig(): StockPreviewTechnicalLayoutConfig {
  return { version: 3, visible: { ...DEFAULT_VISIBLE } }
}

function migrateLegacyVisibility(): StockPreviewTechnicalLayoutConfig {
  const saved = storage.stockPreviewTechnicalLayout.get(null) as unknown as { version?: number; visible?: Record<string, boolean> } | null
  const legacy = storage.stockPreviewTechnicalCards.get({ order: [], visible: {} })
  const visible = { ...DEFAULT_VISIBLE }
  const legacyVisible = (saved?.version === 2 ? saved.visible : legacy.visible) ?? {}
  if (legacyVisible.ma === false) {
    visible.ma_alignment = false
    visible.ma_slope = false
  }
  if (legacyVisible.volume === false) {
    visible.volume_price = false
    visible.volume_ratio = false
    visible.volume_trend = false
  }
  if (legacyVisible.macd === false) visible.macd = false
  if (legacyVisible.rsi === false) visible.rsi = false
  if (legacyVisible.kdj === false) visible.kdj = false
  if (legacyVisible.momentum === false) visible.roc = false
  if (legacyVisible.boll === false) visible.boll_width = false
  if (legacyVisible.atr === false) visible.atr = false
  return { version: 3, visible }
}

function normalizeLayoutConfig(raw: StockPreviewTechnicalLayoutConfig | null | undefined): StockPreviewTechnicalLayoutConfig {
  const visible: Partial<Record<StockTechnicalIndicatorKey, boolean>> = {}
  for (const def of INDICATOR_DEFS) {
    visible[def.key] = typeof raw?.visible?.[def.key] === 'boolean' ? raw.visible[def.key] : true
  }
  return { version: 3, visible }
}

function loadLayoutConfig(): StockPreviewTechnicalLayoutConfig {
  const saved = storage.stockPreviewTechnicalLayout.get(null)
  return saved?.version === 3 ? normalizeLayoutConfig(saved) : migrateLegacyVisibility()
}

function persistLayoutConfig(config: StockPreviewTechnicalLayoutConfig) {
  storage.stockPreviewTechnicalLayout.set(config)
  window.dispatchEvent(new CustomEvent('stock-preview-technical-layout-change'))
}

function scoreIndexForDate(scores: TechnicalScores | undefined, selectedDate: string | null, period: KlinePeriod): number {
  const rows = scores?.rows ?? []
  if (!rows.length) return -1
  const selectedKey = selectedDate ? normalizeBarKey(selectedDate, period) : ''
  return selectedKey ? rows.findIndex(row => normalizeBarKey(row.as_of, period) === selectedKey) : rows.length - 1
}

function scoreForDate(scores: TechnicalScores | undefined, selectedDate: string | null, period: KlinePeriod): TechnicalScoreRow | null {
  const index = scoreIndexForDate(scores, selectedDate, period)
  return index >= 0 ? scores?.rows[index] ?? null : null
}

function previousScoreForDate(scores: TechnicalScores | undefined, selectedDate: string | null, period: KlinePeriod): TechnicalScoreRow | null {
  const index = scoreIndexForDate(scores, selectedDate, period)
  return index > 0 ? scores?.rows[index - 1] ?? null : null
}

function scoreDelta(current: number | null | undefined, previous: number | null | undefined): number | null {
  return current != null && previous != null ? current - previous : null
}

function scoreChangeLabel(value: number | null): string {
  if (value == null) return '—'
  const rounded = Math.round(value)
  return rounded === 0 ? '→ 0' : (rounded > 0 ? '↑ +' : '↓ ') + rounded
}

function scoreChangeClass(value: number | null, inverse = false): string {
  if (value == null || Math.abs(value) < 0.5) return 'text-muted'
  const positive = inverse ? value < 0 : value > 0
  return positive ? 'text-bull' : 'text-bear'
}

function scoreDirectionLabel(value: number | null): string {
  if (value == null) return '未评估'
  return value >= 60 ? '偏多' : value <= 40 ? '偏空' : '中性'
}

function technicalStateLabel(value: number | null, change: number | null): string {
  const direction = scoreDirectionLabel(value)
  if (direction === '未评估' || change == null || Math.abs(change) < 0.5) return direction
  if (change > 0) return direction === '偏多' ? '偏多强化' : direction === '偏空' ? '偏空修复' : '中性修复'
  return direction === '偏多' ? '偏多走弱' : direction === '偏空' ? '偏空延续' : '中性走弱'
}

function confidenceLabel(value: number | null | undefined): string {
  if (value == null) return '—'
  return value >= 75 ? '高' : value >= 50 ? '中' : '低'
}

function riskLabel(value: number | null | undefined): string {
  if (value == null) return '未评估'
  return value >= 70 ? '高' : value >= 40 ? '中等' : '正常'
}

function metricValue(indicator: TechnicalIndicatorModel | undefined, label: string): string {
  return indicator?.metrics.find(metric => metric.label === label)?.value ?? '—'
}

function trendPhaseSummary(indicators: Map<StockTechnicalIndicatorKey, TechnicalIndicatorModel>): string {
  const alignment = indicators.get('ma_alignment')?.status
  const slope = indicators.get('ma_slope')?.summary ?? ''
  const shortWeakening = slope.startsWith('短线走平') || slope.startsWith('短线向上')
  if (alignment === '空头排列') return shortWeakening ? '空头运行 → 空头衰减' : '空头运行'
  if (alignment === '多头排列') return slope.startsWith('短线向下') || slope.startsWith('短线走平') ? '多头运行 → 多头衰减' : '多头运行'
  if (alignment === '均线纠缠') return '震荡'
  return alignment === '样本不足' ? '趋势未评估' : '趋势分化'
}

function compactTrendSummary(indicators: Map<StockTechnicalIndicatorKey, TechnicalIndicatorModel>): string {
  return [trendPhaseSummary(indicators), indicators.get('ma_alignment')?.summary, indicators.get('ma_slope')?.summary].filter(Boolean).join(' · ') || '趋势未评估'
}

function compactMomentumSummary(indicators: Map<StockTechnicalIndicatorKey, TechnicalIndicatorModel>): string {
  return [indicators.get('macd')?.summary, indicators.get('rsi')?.summary, indicators.get('kdj')?.summary, indicators.get('roc')?.summary]
    .filter(Boolean)
    .slice(0, 3)
    .join(' · ') || '动能未评估'
}

function compactVolumeSummary(indicators: Map<StockTechnicalIndicatorKey, TechnicalIndicatorModel>): string {
  const price = indicators.get('volume_price')
  const trend = indicators.get('volume_trend')
  if (!price && !trend) return '量价未评估'
  const current = price?.summary ?? '量价未评估'
  const ratio = metricValue(price, '量比')
  const sustained = trend?.status === '短期降温' ? '中期量能不足' : trend?.status === '短期活跃' ? '中期量能偏强' : trend?.status ?? '量能持续性待定'
  return [current, ratio !== '—' ? '量比 ' + ratio : null, sustained].filter(Boolean).join(' · ')
}

function compactEnvironmentSummary(indicators: Map<StockTechnicalIndicatorKey, TechnicalIndicatorModel>): string {
  const atr = indicators.get('atr')?.summary
  const boll = indicators.get('boll_width')?.summary
  return [atr ? 'ATR ' + atr : null, boll ? 'BOLL ' + boll : null].filter(Boolean).join(' · ') || '波动未评估'
}

function dimensionStateLabel(value: number | null | undefined, change: number | null): string {
  const direction = scoreDirectionLabel(value == null ? null : value)
  if (direction === '未评估' || change == null || Math.abs(change) < 0.5) return direction
  if (change > 0) return direction === '偏空' ? '弱势修复' : direction === '偏多' ? '偏多强化' : '中性改善'
  return direction === '偏多' ? '偏多走弱' : direction === '偏空' ? '偏空延续' : '中性走弱'
}

function stateConfirmationLabel(value: number | null | undefined): string {
  if (value == null) return '未评估'
  return value >= 70 ? '偏多一致' : value <= 30 ? '偏空一致' : '存在分歧'
}

function technicalSummary(
  score: TechnicalScoreRow | null,
  previousScore: TechnicalScoreRow | null,
  indicators: Map<StockTechnicalIndicatorKey, TechnicalIndicatorModel>,
): string {
  if (!score?.available) return '当前周期数据不足，暂不形成技术方向结论。'
  const parts: string[] = []
  const momentumChange = scoreDelta(score.momentum, previousScore?.momentum)
  const trend = scoreDirectionLabel(score.trend)
  if (momentumChange != null && momentumChange > 0.5) parts.push('短线动能正在改善')
  else if (momentumChange != null && momentumChange < -0.5) parts.push('短线动能正在走弱')
  else if (indicators.get('macd')?.status !== '样本不足') parts.push('短线动能维持当前状态')
  if (trend === '偏空') parts.push('中期趋势仍偏空')
  else if (trend === '偏多') parts.push('中期趋势偏多')
  const volumeStatus = indicators.get('volume_price')?.status
  if (volumeStatus === '价涨量增') parts.push('短线放量确认，但需观察持续性')
  else if (volumeStatus === '价跌量增') parts.push('下跌伴随放量，量价偏空')
  else if (volumeStatus && volumeStatus !== '样本不足') parts.push('量价持续性一般')
  return (parts.slice(0, 3).join('，') || '技术指标暂未形成一致方向') + '。'
}

function scoreLabel(value: number | null | undefined): string {
  return value == null ? '—' : `${Math.round(value)}分`
}

function scoreBadgeClasses(value: number | null | undefined, kind: ScoreKind, status?: string): string {
  if (value == null) return 'border-border bg-elevated text-secondary'
  if (kind === 'direction') {
    const isBullish = status ? ['弱多', '偏多', '强多'].some(label => status.startsWith(label)) : value >= 60
    const isBearish = status ? ['强空', '偏空', '弱空'].some(label => status.startsWith(label)) : value <= 40
    return isBullish
      ? 'border-bull/30 bg-bull/10 text-bull'
      : isBearish ? 'border-bear/30 bg-bear/10 text-bear' : 'border-border bg-elevated text-secondary'
  }
  return kind === 'risk'
    ? 'border-warning/30 bg-warning/10 text-warning'
    : 'border-sky-400/30 bg-sky-400/10 text-sky-300'
}

export interface StockTechnicalPanelProps {
  rows: KlineRow[]
  technicalScores?: TechnicalScores
  shortTermAnalysis?: ShortTermAnalysis
  amountEstimated?: boolean
  period: KlinePeriod
  selectedDate: string | null
  assetType?: 'stock' | 'etf' | 'index'
  isLoading?: boolean
  error?: Error | null
  onRetry?: () => void
  onLatest?: () => void
  collapsed?: boolean
  onToggleCollapsed?: () => void
}

export function StockTechnicalPanel({
  rows,
  technicalScores,
  shortTermAnalysis,
  amountEstimated,
  period,
  selectedDate,
  assetType,
  isLoading = false,
  error,
  onRetry,
  onLatest,
  collapsed = false,
  onToggleCollapsed,
}: StockTechnicalPanelProps) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [config, setConfig] = useState<StockPreviewTechnicalLayoutConfig>(loadLayoutConfig)
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  const bars = useMemo(() => normalizeBars(rows, period), [rows, period])
  const selectedIndex = useMemo(() => {
    if (!bars.length) return -1
    const selectedKey = selectedDate ? normalizeBarKey(selectedDate, period) : ''
    const index = selectedKey ? bars.findIndex(bar => bar.key === selectedKey) : -1
    return index >= 0 ? index : bars.length - 1
  }, [bars, period, selectedDate])
  const score = useMemo(
    () => scoreForDate(technicalScores, selectedDate, period),
    [period, selectedDate, technicalScores],
  )
  const previousScore = useMemo(
    () => previousScoreForDate(technicalScores, selectedDate, period),
    [period, selectedDate, technicalScores],
  )
  const scoreIndicators = useMemo(() => {
    const entries = score?.categories?.flatMap(category => category.indicators.map(indicator => [indicator.id, indicator] as const)) ?? []
    return new Map(entries)
  }, [score])
  const indicators = useMemo(
    () => INDICATOR_DEFS.map(def => buildIndicator(def, bars, selectedIndex, assetType, scoreIndicators.get(def.key))),
    [assetType, bars, scoreIndicators, selectedIndex],
  )
  const indicatorsByKey = useMemo(() => new Map(indicators.map(indicator => [indicator.key, indicator])), [indicators])
  const isLatest = selectedIndex >= 0 && selectedIndex === bars.length - 1
  const directionChange = scoreDelta(score?.direction_score, previousScore?.direction_score)
  const trendChange = scoreDelta(score?.trend, previousScore?.trend)
  const momentumChange = scoreDelta(score?.momentum, previousScore?.momentum)
  const volumePriceChange = scoreDelta(score?.volume_price, previousScore?.volume_price)
  const stateConfirmationChange = scoreDelta(score?.state_confirmation, previousScore?.state_confirmation)
  const riskChange = scoreDelta(score?.volatility_risk, previousScore?.volatility_risk)
  const currentDirectionScore = score?.available ? score.direction_score : null
  const currentConfidence = score?.available ? score.confidence : null
  const volumeStatus = indicatorsByKey.get('volume_price')?.status
  const volumeState = volumeStatus === '价涨量增' || volumeStatus === '价涨量平'
    ? '偏多确认'
    : volumeStatus === '价跌量增' || volumeStatus === '价跌量平' ? '偏空确认' : volumeStatus ?? '未评估'
  const dimensions = [
    { key: 'trend', label: '趋势', score: score?.trend, change: trendChange, state: dimensionStateLabel(score?.trend, trendChange), summary: compactTrendSummary(indicatorsByKey) },
    { key: 'momentum', label: '动能', score: score?.momentum, change: momentumChange, state: dimensionStateLabel(score?.momentum, momentumChange), summary: compactMomentumSummary(indicatorsByKey) },
    { key: 'volume_price', label: '量价', score: score?.volume_price, change: volumePriceChange, state: volumeState, summary: compactVolumeSummary(indicatorsByKey) },
    { key: 'state_confirmation', label: '状态确认', score: score?.state_confirmation, change: stateConfirmationChange, state: stateConfirmationLabel(score?.state_confirmation), summary: '趋势、动能与量价的一致性' },
  ]

  const updateConfig = (next: StockPreviewTechnicalLayoutConfig) => {
    const normalized = normalizeLayoutConfig(next)
    setConfig(normalized)
    persistLayoutConfig(normalized)
  }

  const resetConfig = () => {
    const next = defaultLayoutConfig()
    setConfig(next)
    persistLayoutConfig(next)
  }

  const toggleIndicator = (key: StockTechnicalIndicatorKey) => {
    updateConfig({ ...config, visible: { ...config.visible, [key]: config.visible[key] === false } })
  }

  const toggleGroup = (key: string) => {
    setCollapsedGroups(previous => ({ ...previous, [key]: !previous[key] }))
  }

  if (shortTermAnalysis && settingsOpen) {
    return (
      <TechnicalSettings
        groups={SHORT_TERM_GROUP_DEFS}
        config={config}
        onBack={() => setSettingsOpen(false)}
        onReset={resetConfig}
        onToggle={toggleIndicator}
      />
    )
  }

  if (shortTermAnalysis) {
    return (
      <>
        <ShortTermPanel
          analysis={shortTermAnalysis}
          period={period}
          selectedDate={selectedDate}
          isLoading={isLoading}
          error={error}
          onRetry={onRetry}
          onLatest={onLatest}
          collapsed={collapsed}
          onToggleCollapsed={onToggleCollapsed}
          onSettings={() => setSettingsOpen(true)}
        />
        {assetType === 'etf' && <ETFIndicatorScores score={score} amountEstimated={amountEstimated} />}
      </>
    )
  }

  return (
    <section className="border-b border-border/70">
      {settingsOpen ? (
        <TechnicalSettings
          config={config}
          onBack={() => setSettingsOpen(false)}
          onReset={resetConfig}
          onToggle={toggleIndicator}
        />
      ) : (
        <>
          <div className={`flex shrink-0 items-start justify-between px-2.5 py-2 ${collapsed ? '' : 'border-b border-border/70'}`}>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                <span className="text-xs font-medium text-foreground">技术指标</span>
                <span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[12px] text-secondary">{PERIOD_LABELS[period]}</span>
              </div>
              {!collapsed && (
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[13px] text-muted">
                  {!isLatest && bars.length > 0 && (
                    <button type="button" onClick={onLatest} className="text-accent transition-colors hover:text-foreground">
                      回到最新
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              {!collapsed && (
                <button
                  type="button"
                  onClick={() => setSettingsOpen(true)}
                  className="rounded-btn p-1 text-muted transition-colors hover:bg-elevated hover:text-foreground"
                  title="配置指标显隐"
                  aria-label="配置指标显隐"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={onToggleCollapsed}
                className="rounded-btn p-1 text-muted transition-colors hover:bg-elevated hover:text-foreground"
                title={collapsed ? '展开技术指标' : '收起技术指标'}
                aria-label={collapsed ? '展开技术指标' : '收起技术指标'}
                aria-expanded={!collapsed}
              >
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
              </button>
            </div>
          </div>

          {!collapsed && (isLoading && bars.length === 0 ? (
            <div className="p-2">
              <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
                {Array.from({ length: 6 }, (_, index) => <div key={index} className="h-[116px] animate-pulse rounded-card border border-border bg-surface/60" />)}
              </div>
            </div>
          ) : error && bars.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-4 py-6 text-center">
              <span className="text-xs text-secondary">技术指标暂时不可用</span>
              <span className="text-[13px] text-muted">周期行情加载失败，请稍后重试。</span>
              {onRetry && <button type="button" onClick={onRetry} className="rounded-btn bg-elevated px-2.5 py-1 text-[13px] text-secondary transition-colors hover:text-foreground">重试</button>}
            </div>
          ) : bars.length === 0 ? (
            <div className="flex items-center justify-center px-4 py-6 text-center text-xs text-muted">暂无技术指标数据</div>
          ) : (
            <div className="space-y-2 p-2">
              <div className="rounded-card border border-border bg-surface/70 p-2.5 shadow-sm">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-[12px] font-medium text-foreground">技术研判</span>
                  <span className="text-[12px] text-muted">状态 → 变化 → 观察</span>
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  <div className="rounded border border-border/70 bg-base/30 p-2">
                    <div className="text-[12px] text-muted">技术状态</div>
                    <div className="mt-1 flex flex-wrap items-baseline gap-1.5">
                      <span className="text-[13px] font-semibold text-foreground">{technicalStateLabel(currentDirectionScore, directionChange)}</span>
                      <span className="font-mono text-[13px] tabular-nums text-secondary">{currentDirectionScore == null ? '—' : `${Math.round(currentDirectionScore)}/100`}</span>
                      <span className={`font-mono text-[12px] tabular-nums ${scoreChangeClass(directionChange)}`}>{scoreChangeLabel(directionChange)}</span>
                    </div>
                  </div>
                  <div className="rounded border border-border/70 bg-base/30 p-2">
                    <div className="text-[12px] text-muted">信号可信度</div>
                    <div className="mt-1 flex flex-wrap items-baseline gap-1.5">
                      <span className="font-mono text-[13px] font-semibold tabular-nums text-foreground">{currentConfidence == null ? '—' : `${Math.round(currentConfidence)}%`}</span>
                      <span className="text-[12px] text-secondary">{confidenceLabel(currentConfidence)}</span>
                    </div>
                  </div>
                  <div className="rounded border border-border/70 bg-base/30 p-2">
                    <div className="text-[12px] text-muted">风险</div>
                    <div className="mt-1 flex flex-wrap items-baseline gap-1.5">
                      <span className="font-mono text-[13px] font-semibold tabular-nums text-warning">{score?.volatility_risk == null ? '—' : `${Math.round(score.volatility_risk)}/100`}</span>
                      <span className="text-[12px] text-warning">{riskLabel(score?.volatility_risk)}</span>
                      <span className={`font-mono text-[12px] tabular-nums ${scoreChangeClass(riskChange, true)}`}>{scoreChangeLabel(riskChange)}</span>
                    </div>
                  </div>
                </div>
                <div className="mt-2 border-t border-border/50 pt-2 text-[12px] leading-relaxed text-secondary">
                  {technicalSummary(score, previousScore, indicatorsByKey)}
                </div>
              </div>

              <div className="grid gap-1.5 sm:grid-cols-2">
                {dimensions.map(dimension => (
                  <div key={dimension.key} className="rounded-card border border-border bg-surface/70 p-2.5 shadow-sm">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[12px] font-medium text-foreground">{dimension.label}</span>
                      <span className="flex items-baseline gap-1.5">
                        <span className="font-mono text-[13px] font-semibold tabular-nums text-foreground">{dimension.score == null ? '—' : `${Math.round(dimension.score)}/100`}</span>
                        <span className={`font-mono text-[12px] tabular-nums ${scoreChangeClass(dimension.change)}`}>{scoreChangeLabel(dimension.change)}</span>
                      </span>
                    </div>
                    <div className="mt-1 text-[12px] text-secondary">{dimension.state}</div>
                    <div className="mt-1 truncate text-[12px] text-muted" title={dimension.summary}>{dimension.summary}</div>
                  </div>
                ))}
              </div>

              <div className="rounded-card border border-border bg-surface/70 px-2.5 py-2 shadow-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[12px] font-medium text-foreground">市场环境</span>
                  <span className="text-[12px] text-warning">{riskLabel(score?.volatility_risk)}</span>
                </div>
                <div className="mt-1 truncate text-[12px] text-muted" title={compactEnvironmentSummary(indicatorsByKey)}>{compactEnvironmentSummary(indicatorsByKey)}</div>
              </div>

              <details className="rounded-card border border-border bg-base/20">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2 text-[12px] text-secondary">
                  <span>展开指标详情</span>
                  <span className="truncate text-muted">MA · MACD · RSI · KDJ · ROC · ATR · BOLL</span>
                </summary>
                <div className="divide-y divide-border/70 border-t border-border/70">
                  {GROUP_DEFS.map(group => {
                    const groupIndicators = group.indicatorKeys
                      .map(key => indicatorsByKey.get(key))
                      .filter((indicator): indicator is TechnicalIndicatorModel => !!indicator && config.visible[indicator.key] !== false)
                    const groupScore = group.key === 'environment'
                      ? score?.volatility_risk
                      : group.key === 'volume_price' ? score?.volume_price : score?.[group.key]
                    return (
                      <TechnicalGroup
                        key={group.key}
                        group={group}
                        score={groupScore}
                        collapsed={collapsedGroups[group.key] === true}
                        onToggle={() => toggleGroup(group.key)}
                        indicators={groupIndicators}
                      />
                    )
                  })}
                </div>
              </details>
            </div>
          ))}
        </>
      )}
    </section>
  )
}

function shortTermRowForDate(
  analysis: ShortTermAnalysis,
  selectedDate: string | null,
  period: KlinePeriod,
): ShortTermAnalysisRow | null {
  const selectedKey = selectedDate ? normalizeBarKey(selectedDate, period) : ''
  const rows = analysis.rows ?? []
  return rows.find(row => normalizeBarKey(row.as_of, period) === selectedKey)
    ?? rows.at(-1)
    ?? null
}

function shortTermScoreTone(value: number | null | undefined): Tone {
  if (value == null || value === 0) return 'neutral'
  return value > 0 ? 'bull' : 'bear'
}

function shortTermDimensionTone(value: number | null): Tone {
  return shortTermScoreTone(value)
}

function shortTermActionTone(action: string): Tone {
  return action.includes('买') ? 'bull' : action.includes('卖') ? 'bear' : 'neutral'
}

function shortTermSignalItems(analysis: ShortTermAnalysis): Array<{ key: string; label: string; asOf: string; direction: string }> {
  const items: Array<{ key: string; label: string; asOf: string; direction: string }> = []
  for (const [key, values] of Object.entries(analysis.signals ?? {})) {
    for (const raw of values) {
      if (!raw || typeof raw !== 'object') continue
      const value = raw as Record<string, unknown>
      items.push({
        key,
        label: String(value.label ?? key),
        asOf: String(value.as_of ?? ''),
        direction: String(value.direction ?? 'neutral'),
      })
    }
  }
  return items.sort((a, b) => b.asOf.localeCompare(a.asOf)).slice(0, 8)
}

function ShortTermPanel({
  analysis,
  period,
  selectedDate,
  isLoading,
  error,
  onRetry,
  onLatest,
  collapsed,
  onToggleCollapsed,
  onSettings,
}: {
  analysis: ShortTermAnalysis
  period: KlinePeriod
  selectedDate: string | null
  isLoading: boolean
  error?: Error | null
  onRetry?: () => void
  onLatest?: () => void
  collapsed: boolean
  onToggleCollapsed?: () => void
  onSettings?: () => void
}) {
  const row = shortTermRowForDate(analysis, selectedDate, period)
  const signalItems = shortTermSignalItems(analysis)
  return (
    <section className="border-b border-border/70">
      <div className={`flex shrink-0 items-start justify-between px-2.5 py-2 ${collapsed ? '' : 'border-b border-border/70'}`}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
            <span className="text-xs font-medium text-foreground">短线评分</span>
            <span className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[12px] text-accent">{analysis.version}</span>
            <span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[12px] text-secondary">{PERIOD_LABELS[period]}</span>
          </div>
          {!collapsed && <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] text-muted"><span>原生K线计数</span>{row && <span>截至 {shortDate(row.as_of)}</span>}{row && !normalizeBarKey(row.as_of, period).startsWith(normalizeBarKey(selectedDate, period)) && <button type="button" onClick={onLatest} className="text-accent hover:text-foreground">回到最新</button>}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {!collapsed && onSettings && <button type="button" onClick={onSettings} className="rounded-btn p-1 text-muted transition-colors hover:bg-elevated hover:text-foreground" title="配置指标显隐" aria-label="配置指标显隐"><Settings2 className="h-3.5 w-3.5" /></button>}
          <button type="button" onClick={onToggleCollapsed} className="rounded-btn p-1 text-muted transition-colors hover:bg-elevated hover:text-foreground" title={collapsed ? '展开短线评分' : '收起短线评分'} aria-label={collapsed ? '展开短线评分' : '收起短线评分'} aria-expanded={!collapsed}><ChevronDown className={`h-3.5 w-3.5 transition-transform ${collapsed ? '-rotate-90' : ''}`} /></button>
        </div>
      </div>
      {!collapsed && (isLoading && !row ? (
        <div className="p-2"><div className="h-28 animate-pulse rounded-card border border-border bg-surface/60" /></div>
      ) : error && !row ? (
        <div className="flex flex-col items-center gap-2 px-4 py-6 text-center"><span className="text-xs text-secondary">短线分析暂时不可用</span><span className="text-[13px] text-muted">周期行情加载失败，请稍后重试。</span>{onRetry && <button type="button" onClick={onRetry} className="rounded-btn bg-elevated px-2.5 py-1 text-[13px] text-secondary hover:text-foreground">重试</button>}</div>
      ) : !row ? (
        <div className="px-4 py-6 text-center text-xs text-muted">暂无短线分析数据</div>
      ) : (
        <div className="space-y-2 p-2">
          <div className="rounded-card border border-border bg-surface/70 p-2.5 shadow-sm">
            <div className="grid grid-cols-3 gap-1.5">
              <div className="rounded border border-border/70 bg-base/30 p-2"><div className="text-[12px] text-muted">短线总分</div><div className={`mt-1 font-mono text-lg font-semibold tabular-nums ${TONE_CLASSES[shortTermActionTone(row.action)].value}`}>{row.total == null ? '—' : `${row.total}/100`}</div></div>
              <div className="rounded border border-border/70 bg-base/30 p-2"><div className="text-[12px] text-muted">源建议</div><div className={`mt-1 text-[13px] font-semibold ${TONE_CLASSES[shortTermActionTone(row.action)].value}`}>{row.action}</div><div className="mt-0.5 truncate text-[12px] text-muted" title={row.hold_advice}>{row.hold_advice}</div></div>
              <div className="rounded border border-border/70 bg-base/30 p-2"><div className="text-[12px] text-muted">覆盖度 / 趋势</div><div className="mt-1 font-mono text-[13px] tabular-nums text-foreground">{Math.round(row.coverage * 100)}%</div><div className="mt-0.5 text-[12px] text-secondary">{row.trend == null ? '趋势未评估' : ['强势下降', '下降', '震荡', '上升', '强势上升'][row.trend + 2]}</div></div>
            </div>
            <div className="mt-2 border-t border-border/50 pt-2 text-[12px] leading-relaxed text-secondary">权重总和 77；单项原始分 −10 至 +10，综合分使用 tanh 归一化。{row.available ? '' : ' 当前历史根数不足，结论仅作占位。'}</div>
          </div>

          <div className="grid gap-1.5 sm:grid-cols-2">
            {row.dimensions.map(dimension => <div key={dimension.id} className="rounded-card border border-border bg-surface/70 p-2.5 shadow-sm"><div className="flex items-baseline justify-between gap-2"><span className="text-[12px] font-medium text-foreground">{dimension.name}</span><span className={`font-mono text-[13px] font-semibold tabular-nums ${TONE_CLASSES[shortTermDimensionTone(dimension.score)].value}`}>{dimension.score == null ? '—' : `${dimension.score > 0 ? '+' : ''}${dimension.score}`} <span className="text-[11px] font-normal text-muted">w{dimension.weight}</span></span></div><div className="mt-1 truncate text-[12px] text-secondary" title={dimension.detail}>{dimension.detail}</div></div>)}
          </div>

          <div className="rounded-card border border-border bg-surface/70 p-2.5 shadow-sm"><div className="mb-1 text-[12px] font-medium text-foreground">降噪后信号 <span className="font-normal text-muted">（仅研究提示，不自动交易）</span></div>{signalItems.length ? <div className="flex flex-wrap gap-1.5">{signalItems.map((item, index) => <span key={`${item.key}-${item.asOf}-${index}`} className={`rounded border px-1.5 py-0.5 text-[12px] ${item.direction === 'bullish' ? 'border-bull/30 bg-bull/10 text-bull' : item.direction === 'bearish' ? 'border-bear/30 bg-bear/10 text-bear' : 'border-border bg-elevated text-secondary'}`}>{item.label} · {item.asOf.slice(period === '30m' ? 5 : 0, period === '30m' ? 16 : 10)}</span>)}</div> : <div className="text-[12px] text-muted">当前窗口无通过确认与去重的信号</div>}</div>

          {analysis.limitations.length > 0 && <div className="rounded-card border border-warning/30 bg-warning/5 px-2.5 py-2 text-[12px] leading-relaxed text-warning">{analysis.limitations.join('；')}</div>}
        </div>
      ))}
    </section>
  )
}

function categoryScoreText(kind: ScoreKind, score: number | null | undefined): string {
  if (score == null) return '—'
  const prefix = kind === 'risk' ? '风险 ' : kind === 'activity' ? '活跃 ' : ''
  return `${prefix}${Math.round(score)}/100`
}

function trendCategoryScoreText(score: number | null | undefined, status?: string): string {
  if (score == null) return status === '数据不足' ? '数据不足' : '—'
  return `${status ?? '趋势'} ${Math.round(score)}/100`
}

function categoryKindLabel(kind: ScoreKind): string {
  return kind === 'risk' ? '独立风险' : kind === 'activity' ? '独立活跃度' : '方向'
}

function categoryRawLabel(key: string): string {
  const labels: Record<string, string> = {
    close: '价格',
    change_pct: '涨跌幅',
    volume_ratio: '量比',
    sample_count: '样本数',
    above_count: '站上MA20',
    ma20: 'MA20',
    ma60: 'MA60',
    momentum_5: '5周期ROC',
    momentum_20: '20周期ROC',
    momentum_60: '60周期ROC',
    rsi14: 'RSI14',
    rsi14_effective: '有效RSI14',
    previous_rsi14: '前RSI14',
    rsi14_change: 'RSI14变化',
    rsi_window_min: '区间最低RSI',
    rsi_window_max: '区间最高RSI',
    rsi_window_count: '区间样本数',
    rsi_below_40_count: '低于40次数',
    rsi_above_60_count: '高于60次数',
    k: 'K',
    d: 'D',
    j: 'J',
    previous_k: '前K',
    previous_d: '前D',
    previous_j: '前J',
    k_change: 'K变化',
    d_change: 'D变化',
    j_change: 'J变化',
    j_turn_age: 'J拐点距今',
    improvement_bars: 'J连续改善周期',
    weakening_bars: 'J连续走弱周期',
    divergence_left_j: '背离前J',
    divergence_right_j: '背离后J',
    divergence_j_change: '背离J变化',
    divergence_left_rsi: '背离前RSI',
    divergence_right_rsi: '背离后RSI',
    divergence_rsi_change: '背离RSI变化',
    failure_first_value: '失败摆动前值',
    failure_second_value: '失败摆动后值',
    failure_trigger_level: '失败摆动触发线',
    failure_pivot_age: '失败摆动距今',
    failure_trigger_age: '失败摆动触发后',
    stagnation_bars: '钝化连续周期',
    previous_dif: '前DIF',
    previous_dea: '前DEA',
    previous_hist: '前柱体',
    dif_pct: 'DIF/价格(%)',
    dea_pct: 'DEA/价格(%)',
    hist_pct: '柱体/价格(%)',
    previous_dif_pct: '前DIF/价格(%)',
    previous_dea_pct: '前DEA/价格(%)',
    previous_hist_pct: '前柱体/价格(%)',
    hist_change_pct: '柱体变化(百分点)',
    hist: 'MACD柱体',
    divergence_price_change_pct: '背离价格变化(%)',
    divergence_dif_change_pct: '背离DIF变化(百分点)',
    divergence_pivot_age: '背离拐点距今',
    divergence_confirmation_lag: '背离确认等待',
    ma120: 'MA120',
    ma5_slope_pct: 'MA5当前斜率',
    ma20_slope_pct: 'MA20当前斜率',
    ma60_slope_pct: 'MA60当前斜率',
    previous_ma5_slope_pct: 'MA5上一段斜率',
    previous_ma20_slope_pct: 'MA20上一段斜率',
    previous_ma60_slope_pct: 'MA60上一段斜率',
    distance_ma20_pct: '距MA20(比例)',
    distance_ma60_pct: '距MA60(比例)',
    distance_ma120_pct: '距MA120(比例)',
    distance_ma20_atr: '距MA20/ATR',
    short_spread_pct: '短期离散度(比例)',
    long_spread_pct: '中长期离散度(比例)',
    baseline_short_spread_pct: '短期离散度3周期前',
    baseline_long_spread_pct: '中长期离散度3周期前',
    medium_spread_pct: '中期离散度(比例)',
    baseline_medium_spread_pct: '中期离散度3周期前',
    short_spread_change_3_pct: '短期离散3周期均变',
    long_spread_change_3_pct: '中长期离散3周期均变',
    medium_spread_change_3_pct: '中期离散3周期均变',
    structure_score: '结构分(-4~+4)',
    short_structure_score: '短期结构分',
    long_structure_score: '中长期结构分',
    medium_structure_score: '中期结构分',
    atr14: 'ATR14',
    atr_pct: 'ATR/价格',
    realized_volatility: '实现波动率',
    drawdown_pct: '回撤',
    deviation_atr: '偏离ATR倍数',
    average_amount: '前20均额',
    amount_ma5: '成交额MA5',
    amount_ma20: '成交额MA20',
    nonzero_count: '非零成交数',
  }
  for (const period of [5, 20, 60]) {
    labels[`roc_${period}_pct`] = `ROC${period}(%)`
    labels[`previous_roc_${period}_pct`] = `前ROC${period}(%)`
    labels[`roc_${period}_change_pct_points`] = `ROC${period}变化(百分点)`
    labels[`roc_${period}_percentile`] = `ROC${period}历史分位`
    labels[`roc_${period}_history_count`] = `ROC${period}历史样本`
    labels[`roc_${period}_history_q05_pct`] = `ROC${period}历史5%分位`
    labels[`roc_${period}_history_q95_pct`] = `ROC${period}历史95%分位`
    labels[`roc_${period}_divergence_price_change_pct`] = `ROC${period}背离价格变化(%)`
    labels[`roc_${period}_divergence_change_pct_points`] = `ROC${period}背离变化(百分点)`
    labels[`roc_${period}_divergence_pivot_age`] = `ROC${period}背离拐点距今`
    labels[`roc_${period}_divergence_confirmation_lag`] = `ROC${period}背离确认等待`
  }
  return labels[key] ?? key.replace(/_/g, ' ')
}

function categoryRawValue(value: number | null): string {
  return value == null ? '—' : Number.isInteger(value) ? String(value) : value.toFixed(3)
}

function categoryRawValueTone(kind: ScoreKind, score: number | null): string {
  if (kind !== 'direction' || score == null) return 'text-secondary'
  return score >= 60 ? 'text-bull' : score <= 40 ? 'text-bear' : 'text-secondary'
}

function categoryIndicatorStatusTone(kind: ScoreKind, score: number | null, indicator?: TechnicalScoreIndicator): string {
  if (indicator?.id === 'kdj') {
    if (indicator.divergence === 'BOTTOM_DIVERGENCE') return 'text-bull'
    if (indicator.divergence === 'TOP_DIVERGENCE') return 'text-bear'
    if (['OVERSOLD_REVERSAL', 'LOW_GOLDEN_CROSS', 'MOMENTUM_STRENGTHENING', 'WEAK_RECOVERY'].includes(indicator.state ?? '')) return 'text-bull'
    if (['HIGH_DEATH_CROSS', 'MOMENTUM_WEAKENING'].includes(indicator.state ?? '')) return 'text-bear'
    if (['HIGH_STAGNATION', 'HIGH_STRENGTH', 'OVERBOUGHT'].includes(indicator.state ?? '')) return 'text-warning'
    return 'text-muted'
  }
  if (score == null) return 'text-muted'
  if (kind === 'direction') return score >= 60 ? 'text-bull' : score <= 40 ? 'text-bear' : 'text-muted'
  return kind === 'risk' ? 'text-warning' : 'text-sky-300'
}

function ETFCategoryIndicator({ category, indicator }: { category: TechnicalScoreCategory; indicator: TechnicalScoreIndicator }) {
  const score = indicator.score
  const [description, ...meaningLines] = indicator.detail.split('\n')
  const detailText = meaningLines.join('\n')
  const isRoc = indicator.id === 'roc'
  const meaning = isRoc ? indicator.summary ?? detailText : detailText
  const [descriptionOpen, setDescriptionOpen] = useState(false)
  const [rawExpanded, setRawExpanded] = useState(false)
  const hasRawValues = Object.keys(indicator.raw_values).length > 0
  return (
    <div className="rounded border border-border/70 bg-base/20 p-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1">
            <div className="min-w-0 truncate text-[12px] font-medium text-foreground">{indicator.name}</div>
            {description && (
              <button
                type="button"
                className="shrink-0 rounded p-0.5 text-muted transition-colors hover:bg-elevated hover:text-foreground"
                title={descriptionOpen ? `收起${indicator.name}说明` : `查看${indicator.name}说明`}
                aria-label={descriptionOpen ? `收起${indicator.name}说明` : `查看${indicator.name}说明`}
                aria-expanded={descriptionOpen}
                onClick={() => setDescriptionOpen(open => !open)}
              >
                <Info className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
        <span className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums ${scoreBadgeClasses(score, category.kind)}`}>
          {categoryScoreText(category.kind, score)}
        </span>
      </div>
      {descriptionOpen && <div className="mt-1 break-words text-[11px] leading-relaxed text-muted">{description}</div>}
      {hasRawValues ? (
        <>
          <button
            type="button"
            className="mt-1.5 flex w-full items-center justify-between gap-2 border-t border-border/50 pt-1 text-left text-[10px] text-muted"
            title={rawExpanded ? '收起原始值' : '查看原始值'}
            aria-label={rawExpanded ? '收起原始值' : '查看原始值'}
            aria-expanded={rawExpanded}
            onClick={() => setRawExpanded(expanded => !expanded)}
          >
            <span className={categoryIndicatorStatusTone(category.kind, score, indicator)}>{indicator.status}</span>
            <span className="flex items-center gap-1">
              <span>权重 {Math.round(indicator.weight * 100)}%</span>
              <ChevronDown className={`h-3 w-3 transition-transform ${rawExpanded ? 'rotate-180' : ''}`} />
            </span>
          </button>
          {meaning && <div className="mt-1 break-words whitespace-pre-line text-[11px] leading-relaxed text-muted">{meaning}</div>}
          {rawExpanded && (
            <div className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-1 border-t border-border/50 pt-1.5">
              {Object.entries(indicator.raw_values).map(([key, value]) => (
                <div key={key} className="min-w-0">
                  <div className="text-[10px] text-muted">{categoryRawLabel(key)}</div>
                  <div className={`truncate font-mono text-[11px] tabular-nums ${categoryRawValueTone(category.kind, score)}`} title={categoryRawValue(value)}>{categoryRawValue(value)}</div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-border/50 pt-1 text-[10px] text-muted">
            <span className={categoryIndicatorStatusTone(category.kind, score, indicator)}>{indicator.status}</span>
            <span>权重 {Math.round(indicator.weight * 100)}%</span>
          </div>
          {meaning && <div className="mt-1 break-words whitespace-pre-line text-[11px] leading-relaxed text-muted">{meaning}</div>}
        </>
      )}
    </div>
  )
}

function ETFIndicatorScores({ score, amountEstimated }: { score: TechnicalScoreRow | null; amountEstimated?: boolean }) {
  const categories = score?.categories ?? []
  const summary = [
    { label: '方向分', kind: 'direction' as const, value: score?.category_direction_score, available: score?.direction_available, coverage: score?.category_direction_coverage },
    { label: '波动风险', kind: 'risk' as const, value: score?.category_risk_score, available: score?.risk_available },
    { label: '成交活跃度', kind: 'activity' as const, value: score?.category_activity_score, available: score?.activity_available },
  ]
  return (
    <section className="rounded-card border border-accent/30 bg-accent/5 p-2.5 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-[12px] font-medium text-foreground">指标评分</div>
          <div className="mt-0.5 text-[11px] text-muted">technical-score-v3 · 后端统一评分 · 研究用途</div>
        </div>
        <span className="text-[11px] text-muted">方向 / 风险 / 活跃度分开计算</span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        {summary.map(item => (
          <div key={item.label} className="rounded border border-border/70 bg-base/40 p-2">
            <div className="text-[11px] text-muted">{item.label}</div>
            <div className={`mt-1 font-mono text-[14px] font-semibold tabular-nums ${item.kind === 'direction' ? 'text-foreground' : item.kind === 'risk' ? 'text-warning' : 'text-sky-300'}`}>
              {item.available === false ? '数据不足' : categoryScoreText(item.kind, item.value)}
            </div>
            {item.coverage != null && <div className="mt-0.5 text-[10px] text-muted">覆盖 {item.coverage}%</div>}
          </div>
        ))}
      </div>
      {categories.length > 0 ? (
        <div className="mt-2 space-y-1.5">
          {categories.map(category => (
            <details key={category.id} className="rounded border border-border/70 bg-base/20">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2 text-[12px] text-secondary">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-medium text-foreground">{category.name}</span>
                  <span className="text-[10px] text-muted">{categoryKindLabel(category.kind)}</span>
                  <span className="text-[10px] text-muted">覆盖 {category.coverage}%</span>
                </span>
                <span className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums ${scoreBadgeClasses(category.score, category.kind, category.status)}`}>
                  {category.id === 'trend' ? trendCategoryScoreText(category.score, category.status) : categoryScoreText(category.kind, category.score)}
                </span>
              </summary>
              <div className="grid gap-1.5 border-t border-border/70 p-1.5 sm:grid-cols-2">
                {category.indicators.map(indicator => <ETFCategoryIndicator key={indicator.id} category={category} indicator={indicator} />)}
              </div>
            </details>
          ))}
        </div>
      ) : (
        <div className="mt-2 rounded border border-border/70 bg-base/20 px-2.5 py-2 text-[11px] text-muted">当前周期暂无分类评分明细。</div>
      )}
      {amountEstimated && <div className="mt-2 rounded border border-warning/30 bg-warning/5 px-2 py-1.5 text-[10px] leading-relaxed text-warning">成交额为估算值，成交活跃度只作相对参考。</div>}
      <div className="mt-2 text-[10px] leading-relaxed text-muted">分类分只用于解释当前 K 线状态，不替代结构分析、基本面判断或交易决策。</div>
    </section>
  )
}

function TechnicalGroup({
  group,
  score,
  collapsed,
  onToggle,
  indicators,
}: {
  group: TechnicalGroupDef
  score: number | null | undefined
  collapsed: boolean
  onToggle: () => void
  indicators: TechnicalIndicatorModel[]
}) {
  return (
    <section>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left transition-colors hover:bg-elevated/40"
        aria-expanded={!collapsed}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${collapsed ? '-rotate-90' : ''}`} />
          <span className="text-[12px] font-medium text-foreground">{group.label}</span>
          <span className="truncate text-[12px] text-muted">{group.description}</span>
        </span>
        <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[12px] font-semibold ${scoreBadgeClasses(score, group.scoreKind)}`}>
          {group.scoreKind === 'risk' ? '风险 ' : ''}{scoreLabel(score)}
        </span>
      </button>
      {!collapsed && (
        indicators.length > 0 ? (
          <div className="grid gap-2 px-2 pb-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
            {indicators.map(indicator => <TechnicalCard key={indicator.key} indicator={indicator} />)}
          </div>
        ) : (
          <div className="px-4 pb-2 text-[13px] text-muted">该维度的指标卡已全部隐藏</div>
        )
      )}
    </section>
  )
}

function TechnicalCard({ indicator }: { indicator: TechnicalIndicatorModel }) {
  const tone = TONE_CLASSES[indicator.tone]
  return (
    <div className="rounded-card border border-border bg-surface/70 p-2.5 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[12px] font-medium text-foreground">{indicator.label}</div>
          <div className="mt-0.5 truncate text-[12px] text-muted">{indicator.description}</div>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[12px] ${tone.badge}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
          {indicator.status}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1.5">
        {indicator.metrics.map(metric => (
          <div key={metric.label} className="min-w-0">
            <div className="text-[12px] text-muted">{metric.label}</div>
            <div className={`truncate font-mono text-[12px] tabular-nums ${metric.tone ? TONE_CLASSES[metric.tone].value : 'text-secondary'}`} title={metric.value}>
              {metric.value}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 truncate border-t border-border/50 pt-1.5 text-[12px] text-muted" title={indicator.detail}>{indicator.detail}</div>
    </div>
  )
}

function TechnicalSettings({
  groups = GROUP_DEFS,
  config,
  onBack,
  onReset,
  onToggle,
}: {
  groups?: TechnicalGroupDef[]
  config: StockPreviewTechnicalLayoutConfig
  onBack: () => void
  onReset: () => void
  onToggle: (key: StockTechnicalIndicatorKey) => void
}) {
  return (
    <div>
      <div className="flex shrink-0 items-center justify-between border-b border-border/70 px-2.5 py-2">
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1 rounded-btn px-1.5 py-1 text-[12px] text-secondary transition-colors hover:bg-elevated hover:text-foreground">
          <ChevronLeft className="h-3.5 w-3.5" />
          技术指标
        </button>
        <button type="button" onClick={onReset} className="rounded-btn px-1.5 py-1 text-[13px] text-secondary transition-colors hover:bg-elevated hover:text-foreground">恢复默认</button>
      </div>
      <div className="p-2.5">
        <p className="mb-2 text-[13px] leading-relaxed text-muted">分组和指标顺序固定，勾选控制指标卡显隐。评分由后端统一计算，不受这里的显隐设置影响。</p>
        <div className="space-y-2">
          {groups.map(group => (
            <div key={group.key} className="rounded-card border border-border bg-base/30 p-2">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[12px] font-medium text-foreground">{group.label}</span>
                <span className="text-[12px] text-muted">{group.scoreKind === 'direction' ? '方向分' : '风险分'}</span>
              </div>
              <div className="space-y-1">
                {group.indicatorKeys.map(key => {
                  const def = INDICATOR_BY_KEY.get(key)
                  if (!def) return null
                  const visible = config.visible[key] !== false
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => onToggle(key)}
                      role="checkbox"
                      aria-checked={visible}
                      className={`flex w-full items-center gap-2 rounded-btn border px-2 py-1.5 text-left transition-colors ${visible ? 'border-accent/40 bg-accent/[0.05]' : 'border-border bg-base/30'}`}
                    >
                      <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${visible ? 'border-accent bg-accent' : 'border-border bg-base'}`}>
                        {visible && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[12px] text-foreground">{def.label}</span>
                        <span className="block truncate text-[12px] text-muted">{def.description}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
