import assert from 'node:assert/strict'
import { buildPriceZones } from '../src/lib/priceZones.ts'
import { buildSignalRiskContext } from '../src/lib/signalRisk.ts'

const analysis = {
  period: '1d',
  source: 'stroke',
  status: 'ready',
  currentPrice: 10,
  bars: [{ date: '2026-01-10', close: 10, ma20: null, ma60: null, atr14: 0.2 }],
  fractals: [
    { type: 'bottom', price: 9, date: '2026-01-08' },
    { type: 'top', price: 11, date: '2026-01-07' },
    { type: 'bottom', price: 8, date: '2026-01-01' },
    { type: 'top', price: 12, date: '2025-12-30' },
  ],
  strokes: [
    { confirmed: true, direction: 'down', endPrice: 9, endDate: '2026-01-08' },
  ],
  segments: [],
  centers: [],
}

const zones = buildPriceZones(analysis)
assert.equal(zones.filter(zone => zone.side === 'support').length, 2)
assert.equal(zones.filter(zone => zone.side === 'resistance').length, 2)
const nineZone = zones.find(zone => zone.sources.some(source => source.price === 9))
assert.equal(nineZone.sources.filter(source => source.price === 9).length, 1, '分型和同点笔端点应去重')
assert.ok(zones.every(zone => zone.ruleVersion === 'price-zone-v1'))
assert.ok(zones.every(zone => zone.atrAvailable))

const buy = buildSignalRiskContext({
  id: 'buy-1', kind: 'first_buy', status: 'candidate', source: 'stroke',
  structureDate: '2026-01-08', availableDate: '2026-01-09', price: 9, boundary: 9,
  invalidatedAt: null, relatedSignalId: null, conditions: [], nextWatch: 'wait',
}, zones, 10)
assert.equal(buy.status, 'calculable')
assert.equal(buy.riskPct, 0.1)
assert.ok(Math.abs(buy.target1Pct - 0.097) < 1e-9)
assert.ok(Math.abs(buy.riskReward1 - 0.97) < 1e-9)

const sell = buildSignalRiskContext({
  id: 'sell-1', kind: 'first_sell', status: 'candidate', source: 'stroke',
  structureDate: '2026-01-07', availableDate: '2026-01-08', price: 11, boundary: 11,
  invalidatedAt: null, relatedSignalId: null, conditions: [], nextWatch: 'wait',
}, zones, 10)
assert.equal(sell.status, 'calculable')
assert.ok(Math.abs(sell.target1Pct - 0.097) < 1e-9)
assert.ok(Math.abs(sell.riskReward1 - 0.97) < 1e-9)

const unavailable = buildSignalRiskContext({ ...buy.signal, boundary: 10 }, zones, 10)
assert.equal(unavailable.status, 'unavailable')
assert.match(unavailable.reason, /方向/)

const noAtr = buildPriceZones({ ...analysis, bars: [{ ...analysis.bars[0], atr14: null }] })
assert.ok(noAtr.length > 0)
assert.ok(noAtr.every(zone => zone.atrAvailable === false))

console.log('decision assertions passed')
