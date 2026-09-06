import assert from 'node:assert/strict'
import { buildStockSummary } from '../src/lib/stockSummary.ts'

const rows = [
  { date: '2026-01-01', open: 9, high: 10, low: 8.5, close: 9.5, volume: 100, is_closed: true },
  { date: '2026-01-02', open: 9.5, high: 10.5, low: 9, close: 10, volume: 90, is_closed: true },
]

const chanlun = {
  ruleVersion: 2,
  period: '1d',
  source: 'stroke',
  definitionMode: 'structure_proxy',
  approximationLoss: '代理结构',
  status: 'ready',
  issues: [],
  window: { start: '2026-01-01', end: '2026-01-02', bars: 2, mergedBars: 2 },
  bars: [], mergedBars: [], fractals: [], strokes: [], segments: [], centers: [],
  strokeCenters: [], segmentCenters: [], trendType: 'downtrend_proxy', divergences: [],
  candidateSignals: [], thirdSignals: [], latestFractal: null, latestConfirmedStroke: null,
  formingStroke: null, latestCenter: { state: 'oscillating' }, latestSignal: null,
  currentPrice: 10, pricePosition: 'inside',
}
const elliott = {
  schema: 'elliott.assessment.app.v1', status: 'ready', definitionMode: 'swing_proxy',
  dataQuality: { status: 'sufficient', missing: [], limitations: [] },
  approximationLoss: [], ambiguity: 'none', primaryCount: null,
}
const candidate = {
  signal: {
    id: 'buy-1', kind: 'second_buy', status: 'candidate', source: 'stroke',
    structureDate: '2025-12-30', availableDate: '2026-01-01', price: 9.4, boundary: 9,
    invalidatedAt: null, relatedSignalId: null, conditions: [{ id: 'pullback', label: '回抽不破', state: 'waiting', evidence: '等待回抽确认' }], nextWatch: '等待低级别触发',
  },
  direction: 'buy', referencePrice: 10, invalidation: 9, target1: { id: 'r1', side: 'resistance', low: 11, high: 11.1, center: 11.05, distancePct: 0.1, sources: [], sourceCount: 1, lastTouchTime: '2026-01-01', period: '1d', structureSource: 'stroke', ruleVersion: 'price-zone-v1', atrAvailable: true }, target2: null,
  riskPct: 0.1, target1Pct: 0.1, target2Pct: null, riskReward1: 1, riskReward2: null, status: 'calculable',
}
const input = {
  symbol: '000001.SZ', name: '测试标的', assetType: 'stock', period: '1d', rows,
  technicalScores: { version: 'technical-score-v1', rows: [{ as_of: '2026-01-02', direction_score: 72, confidence: 80, coverage: 100, trend: 30, momentum: 70, volume_price: 35, volatility_risk: 40, activity: 60, available: true }] },
  selectedBarKey: null, chanlun, elliott, priceZones: [candidate.target1], signalRiskContexts: [candidate], preferredSignal: candidate,
}

const snapshot = buildStockSummary(input)
assert.equal(snapshot.technical.score, 72)
assert.equal(snapshot.technical.direction, '偏强')
assert.equal(snapshot.quality.status, 'ready')
assert.equal(snapshot.observation.status, 'conflict', '技术方向和结构方向相反时应标记分歧')
assert.ok(snapshot.conflicts.some(item => item.id === 'technical-structure-direction'))
assert.equal(snapshot.conditions[0].state, 'waiting')
assert.equal(snapshot.levels.resistance.id, 'r1')

const historical = buildStockSummary({ ...input, selectedBarKey: '2026-01-01' })
assert.equal(historical.technical.score, null, '没有对应评分时不能回退到最新评分')
assert.equal(historical.quality.status, 'limited')
assert.equal(historical.context.historical, true)

const empty = buildStockSummary({ ...input, rows: [], selectedBarKey: null, technicalScores: undefined })
assert.equal(empty.quality.status, 'blocked')
assert.equal(empty.observation.status, 'unavailable')
assert.match(empty.summary, /数据不足/)

const invalidated = buildStockSummary({
  ...input,
  signalRiskContexts: [{ ...candidate, signal: { ...candidate.signal, status: 'invalidated' } }],
  preferredSignal: { ...candidate, signal: { ...candidate.signal, status: 'invalidated' } },
})
assert.equal(invalidated.observation.status, 'invalidated')

console.log('summary assertions passed')
