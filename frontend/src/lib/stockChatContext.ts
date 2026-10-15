import type {
  ChartDataStatus,
  KlinePeriod,
  KlineResponse,
  KlineRow,
  StockChatSnapshotV1,
} from '@/lib/api'
import type { ChanlunAnalysis, ChanlunCandidateSignal } from '@/lib/chanlun'
import { selectStockChatRows, stockChatBarKey } from './stockChatPrimitives'

/** Inputs owned by StockPanel; the resulting snapshot is safe to persist/send. */
export interface StockChatSnapshotInput {
  symbol: string
  period: KlinePeriod
  assetType?: KlineResponse['asset_type']
  selectedDate: string | null
  response: KlineResponse | undefined
  chanlun: ChanlunAnalysis
}

const BAR_KEYS = [
  'date', 'period_start', 'period_end', 'is_closed',
  'open', 'high', 'low', 'close', 'volume', 'amount', 'change_pct',
  'ma5', 'ma10', 'ma20', 'ma60',
  'macd_dif', 'macd_dea', 'macd_hist',
  'kdj_k', 'kdj_d', 'kdj_j', 'rsi_6', 'rsi_14', 'rsi_24',
  'boll_upper', 'boll_mid', 'boll_lower', 'atr_14', 'vol_ma5', 'vol_ma10',
  'vol_ratio_5d', 'momentum_5d', 'momentum_10d', 'momentum_20d',
  'momentum_30d', 'momentum_60d', 'turnover_rate',
] as const

function clean(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' || typeof value === 'boolean' || value == null) return value
  if (Array.isArray(value)) return value.map(clean)
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = clean(item)
    return out
  }
  return String(value)
}

function compact(source: unknown, keys: readonly string[]): Record<string, unknown> {
  const input = source && typeof source === 'object' ? source as Record<string, unknown> : {}
  const out: Record<string, unknown> = {}
  for (const key of keys) if (key in input) out[key] = clean(input[key])
  return out
}

function compactBar(row: KlineRow): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of BAR_KEYS) {
    if (key in row) out[key] = clean(row[key])
  }
  // Preserve the small boolean signal set already calculated by the page.
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('signal_') && typeof value === 'boolean') out[key] = value
  }
  return out
}

function latestAtOrBefore<T extends { as_of?: string | null }>(
  rows: T[] | undefined,
  asOf: string | null,
  period: KlinePeriod,
): T | null {
  if (!rows?.length) return null
  const cutoff = asOf ? stockChatBarKey(asOf, period) : ''
  if (!cutoff) return rows.at(-1) ?? null
  return rows.filter(row => stockChatBarKey(row.as_of, period) <= cutoff).at(-1) ?? null
}

function compactSignal(signal: ChanlunCandidateSignal): Record<string, unknown> {
  return {
    id: signal.id,
    kind: signal.kind,
    status: signal.status,
    source: signal.source,
    origin: signal.origin,
    structureDate: signal.structureDate,
    availableDate: signal.availableDate,
    price: signal.price,
    boundary: signal.boundary,
    invalidatedAt: signal.invalidatedAt,
    conditions: signal.conditions.map(condition => compact(condition, ['id', 'label', 'state', 'evidence'])),
    nextWatch: signal.nextWatch,
  }
}

function compactChanlun(analysis: ChanlunAnalysis): Record<string, unknown> {
  return {
    ruleVersion: analysis.ruleVersion,
    period: analysis.period,
    source: analysis.source,
    definitionMode: analysis.definitionMode,
    approximationLoss: analysis.approximationLoss,
    status: analysis.status,
    issues: analysis.issues,
    window: analysis.window,
    trendType: analysis.trendType,
    latestFractal: analysis.latestFractal ? compact(analysis.latestFractal, ['type', 'date', 'price', 'confirmedAt']) : null,
    latestConfirmedStroke: analysis.latestConfirmedStroke
      ? compact(analysis.latestConfirmedStroke, ['direction', 'startDate', 'endDate', 'startPrice', 'endPrice', 'changePct', 'confirmed', 'confirmedAt'])
      : null,
    formingStroke: analysis.formingStroke
      ? compact(analysis.formingStroke, ['direction', 'startDate', 'endDate', 'startPrice', 'endPrice', 'changePct', 'confirmed', 'confirmedAt'])
      : null,
    latestCenter: analysis.latestCenter ? compact(analysis.latestCenter, ['startDate', 'endDate', 'zd', 'zg', 'dd', 'gg', 'componentCount', 'state', 'source']) : null,
    divergences: analysis.divergences.slice(-4).map(item => compact(item, ['id', 'kind', 'direction', 'status', 'source', 'a', 'c', 'evidence'])),
    candidateSignals: analysis.candidateSignals.slice(-6).map(compactSignal),
    thirdSignals: analysis.thirdSignals.slice(-4).map(item => compact(item, ['id', 'kind', 'status', 'structureDate', 'availableDate', 'price', 'boundary', 'invalidatedAt'])),
    currentPrice: analysis.currentPrice,
    pricePosition: analysis.pricePosition,
  }
}

/** Build a compact snapshot from the exact response/analysis currently visible. */
export function buildStockChatSnapshot(input: StockChatSnapshotInput): StockChatSnapshotV1 | null {
  const response = input.response
  if (!response || response.symbol !== input.symbol || !response.rows?.length) return null

  const dataThrough = response.data_status?.data_through ?? null
  // A 30m data-through marker is date-only, while its bars are timestamped;
  // use the latest visible bucket when no candle has been selected yet.
  const latestAsOf = input.period === '30m' && dataThrough && !/[T ]/.test(dataThrough)
    ? response.rows.at(-1)?.date ?? dataThrough
    : dataThrough ?? response.rows.at(-1)?.date ?? null
  const asOf = input.selectedDate ?? latestAsOf
  const sourceRows = selectStockChatRows(response.rows, input.period, asOf, 90)
  const technicalScore = latestAtOrBefore(response.technical_scores?.rows, asOf, input.period)
  const status = response.data_status as ChartDataStatus | undefined

  return {
    version: 1,
    symbol: input.symbol,
    name: response.name ?? response.stock_info?.name ?? '',
    asset_type: response.asset_type ?? input.assetType ?? null,
    period: input.period,
    as_of: asOf,
    captured_at: new Date().toISOString(),
    source: response.source ?? null,
    data_status: status ? clean(status) as ChartDataStatus : null,
    bars: sourceRows.map(compactBar),
    technical_score: technicalScore ? clean(technicalScore) as Record<string, unknown> : null,
    structure: {
      chanlun: compactChanlun(input.chanlun),
    },
  }
}
