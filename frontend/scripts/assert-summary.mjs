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
assert.equal(empty.decision.inputState, 'blocked')
assert.equal(empty.decision.state, 'wait')
assert.equal(empty.decision.flatAction, '等待')
assert.equal(empty.decision.holdingAction, '持有观察')

const noScore = buildStockSummary({ ...input, technicalScores: undefined })
assert.equal(noScore.decision.inputState, 'blocked')
assert.equal(noScore.decision.state, 'wait')

const blockedChanlun = buildStockSummary({
  ...input,
  chanlun: { ...chanlun, status: 'blocked', issues: ['缠论结构不可用'] },
})
assert.equal(blockedChanlun.decision.inputState, 'blocked')
assert.equal(blockedChanlun.decision.state, 'wait')

const invalidated = buildStockSummary({
  ...input,
  signalRiskContexts: [{ ...candidate, signal: { ...candidate.signal, status: 'invalidated' } }],
  preferredSignal: { ...candidate, signal: { ...candidate.signal, status: 'invalidated' } },
})
assert.equal(invalidated.observation.status, 'invalidated')

const signalConditions = (lowerState = 'unavailable') => [
  { id: 'context', label: '结构上下文', state: 'met', evidence: '结构成立' },
  { id: 'rebound', label: '首次反向运动完成', state: 'met', evidence: '反向运动完成' },
  { id: 'pullback', label: '首次回抽完成', state: 'met', evidence: '回抽完成' },
  { id: 'outside', label: '回抽不破结构边界', state: 'met', evidence: '边界保持' },
  { id: 'lower_level', label: '低级别结构确认', state: lowerState, evidence: lowerState === 'met' ? '低级别已确认' : '尚未实现严格多级别递归确认' },
]

const scoreInput = (source, scores) => ({
  ...source,
  technicalScores: {
    ...source.technicalScores,
    rows: [{ ...source.technicalScores.rows[0], ...scores }],
  },
})

const bullishChanlun = { ...chanlun, trendType: 'uptrend_proxy' }
const bearishSellSignal = {
  ...candidate.signal,
  id: 'sell-3',
  kind: 'third_sell',
  conditions: signalConditions('unavailable'),
}
const bearishSellContext = {
  ...candidate,
  signal: bearishSellSignal,
  direction: 'sell',
  invalidation: 11,
  target1: { ...candidate.target1, id: 'support-1', side: 'support', low: 8.8, high: 9, center: 8.9 },
  riskReward1: 2,
}

const reduce = buildStockSummary({
  ...scoreInput(input, { direction_score: 38, trend: 28, momentum: 41, volume_price: 50 }),
  chanlun,
  signalRiskContexts: [bearishSellContext],
  preferredSignal: bearishSellContext,
})
assert.equal(reduce.decision.state, 'reduce', '三卖候选和弱势结构应进入减仓状态')
assert.equal(reduce.decision.flatAction, '暂不介入')
assert.equal(reduce.decision.holdingAction, '减仓')
assert.match(reduce.decision.reason, /低级别确认缺失/)

const bullishTechnicalSell = buildStockSummary({
  ...scoreInput(input, { direction_score: 76, trend: 72, momentum: 70, volume_price: 68 }),
  chanlun: { ...chanlun, trendType: 'downtrend_proxy' },
  signalRiskContexts: [bearishSellContext],
  preferredSignal: bearishSellContext,
})
assert.equal(bullishTechnicalSell.decision.state, 'wait', '技术明显偏多时卖侧候选应等待复核')

const probeSignal = {
  ...candidate.signal,
  id: 'buy-2-probe',
  kind: 'second_buy',
  conditions: signalConditions('unavailable'),
}
const probeContext = {
  ...candidate,
  signal: probeSignal,
  direction: 'buy',
  target1: { ...candidate.target1, id: 'r-probe', low: 13, high: 13.1, center: 13.05 },
  riskReward1: 3,
}
const probe = buildStockSummary({
  ...scoreInput(input, { direction_score: 72, trend: 70, momentum: 68, volume_price: 66 }),
  chanlun: bullishChanlun,
  signalRiskContexts: [probeContext],
  preferredSignal: probeContext,
})
assert.equal(probe.decision.state, 'probe', '低级别确认缺失时最多进入试仓观察')
assert.equal(probe.decision.flatAction, '试仓')
assert.equal(probe.decision.holdingAction, '持有观察')

const buySignal = { ...probeSignal, id: 'buy-2-confirmed', conditions: signalConditions('met') }
const buyContext = { ...probeContext, signal: buySignal }
const buy = buildStockSummary({
  ...scoreInput(input, { direction_score: 72, trend: 70, momentum: 68, volume_price: 66 }),
  chanlun: bullishChanlun,
  signalRiskContexts: [buyContext],
  preferredSignal: buyContext,
})
assert.equal(buy.decision.state, 'buy', '全部确认门满足时应生成买侧确认状态')
assert.equal(buy.decision.flatAction, '买入')
assert.equal(buy.decision.holdingAction, '持有')

const waveOnlyConflict = buildStockSummary({
  ...scoreInput(input, { direction_score: 72, trend: 70, momentum: 68, volume_price: 66 }),
  chanlun: bullishChanlun,
  elliott: {
    ...elliott,
    definitionMode: 'strict_elliott',
    ambiguity: 'none',
    primaryCount: { id: 'wave-down', family: 'impulse', direction: 'down', currentWave: '4' },
  },
  signalRiskContexts: [buyContext],
  preferredSignal: buyContext,
})
assert.ok(waveOnlyConflict.conflicts.some(item => item.id === 'wave-structure-direction'))
assert.equal(waveOnlyConflict.decision.state, buy.decision.state, '波浪分歧只能进入摘要证据，不得改变行动门槛')
assert.ok(waveOnlyConflict.opposingEvidence.some(item => item.source === 'wave'))

const sellSignal = { ...bearishSellSignal, id: 'sell-3-confirmed', conditions: signalConditions('met') }
const sellContext = { ...bearishSellContext, signal: sellSignal }
const sell = buildStockSummary({
  ...scoreInput(input, { direction_score: 28, trend: 30, momentum: 32, volume_price: 35 }),
  chanlun,
  signalRiskContexts: [sellContext],
  preferredSignal: sellContext,
})
assert.equal(sell.decision.state, 'sell', '卖侧确认门全部满足时应生成卖出状态')
assert.equal(sell.decision.flatAction, '暂不介入')
assert.equal(sell.decision.holdingAction, '卖出')

const firstBuy = buildStockSummary({
  ...scoreInput(input, { direction_score: 72, trend: 70, momentum: 68, volume_price: 66 }),
  chanlun: bullishChanlun,
  signalRiskContexts: [{ ...probeContext, signal: { ...probeSignal, id: 'buy-1', kind: 'first_buy' } }],
  preferredSignal: { ...probeContext, signal: { ...probeSignal, id: 'buy-1', kind: 'first_buy' } },
})
assert.equal(firstBuy.decision.state, 'wait', '一买候选即使技术偏强也不能直接升级为试仓')

const conflict = buildStockSummary({
  ...scoreInput(input, { direction_score: 72, trend: 70, momentum: 68, volume_price: 66 }),
  chanlun,
  signalRiskContexts: [probeContext],
  preferredSignal: probeContext,
})
assert.equal(conflict.decision.state, 'wait', '技术与结构分歧时不得升级行动状态')

const noRisk = buildStockSummary({
  ...scoreInput(input, { direction_score: 72, trend: 70, momentum: 68, volume_price: 66 }),
  chanlun: bullishChanlun,
  signalRiskContexts: [{ ...probeContext, status: 'unavailable', riskReward1: null, reason: '缺少目标区间' }],
  preferredSignal: { ...probeContext, status: 'unavailable', riskReward1: null, reason: '缺少目标区间' },
})
assert.equal(noRisk.decision.state, 'wait', '风险空间不可计算时不得进入试仓')

const stale = buildStockSummary({
  ...scoreInput(input, { direction_score: 72, trend: 70, momentum: 68, volume_price: 66 }),
  chanlun: bullishChanlun,
  dataSource: 'chart',
  dataStatus: { stale: true, data_through: '2026-01-01' },
  signalRiskContexts: [probeContext],
  preferredSignal: probeContext,
})
assert.equal(stale.decision.inputState, 'provisional')
assert.equal(stale.decision.state, 'wait')
assert.equal(stale.decision.flatAction, '等待')
assert.equal(stale.decision.holdingAction, '持有观察')

const enrichedFallback = buildStockSummary({
  ...scoreInput(input, { direction_score: 72, trend: 70, momentum: 68, volume_price: 66 }),
  chanlun: bullishChanlun,
  dataSource: 'enriched',
  dataStatus: { stale: true, data_through: null },
  signalRiskContexts: [probeContext],
  preferredSignal: probeContext,
})
assert.equal(enrichedFallback.quality.stale, false)
assert.match(enrichedFallback.quality.reasons.join(' '), /本地 enriched 数据/)
assert.equal(enrichedFallback.decision.inputState, 'ready')

const unclosed = buildStockSummary({
  ...scoreInput(input, { direction_score: 72, trend: 70, momentum: 68, volume_price: 66 }),
  chanlun: bullishChanlun,
  rows: rows.map((row, index) => index === rows.length - 1 ? { ...row, is_closed: false } : row),
  signalRiskContexts: [probeContext],
  preferredSignal: probeContext,
})
assert.equal(unclosed.decision.inputState, 'provisional')
assert.equal(unclosed.decision.state, 'wait')

console.log('summary assertions passed')
