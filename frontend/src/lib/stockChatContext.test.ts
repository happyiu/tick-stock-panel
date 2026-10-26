import { expect, it } from 'vitest'
import { emptyChanlunAnalysis } from './chanlun'
import { buildStockChatSnapshot } from './stockChatContext'
import { stripLegacyStockChatContext } from './stockChatPrimitives'

it('AI快照保留行情与基础结构，不再输出价位区间、风险收益和波浪', () => {
  const snapshot = buildStockChatSnapshot({
    symbol: '510300.SH', period: '1d', selectedDate: null,
    response: {
      symbol: '510300.SH', asset_type: 'etf',
      rows: [{ date: '2026-10-08', open: 4, high: 5, low: 3, close: 4 }],
    },
    chanlun: emptyChanlunAnalysis('1d'),
  })
  expect(snapshot?.bars[0].close).toBe(4)
  expect(snapshot?.structure.chanlun).toBeDefined()
  expect(snapshot?.structure).not.toHaveProperty('elliott')
  expect(snapshot).not.toHaveProperty('price_zones')
  expect(snapshot).not.toHaveProperty('signal_risk')
})

it('旧会话读取时移除废弃数据，保留会话与结构字段且不修改原对象', () => {
  const legacy = { symbol: '510300.SH', structure: { chanlun: {}, elliott: { primaryCount: {} } }, price_zones: [{ low: 3 }], signal_risk: [{ riskPct: 0.1 }] }
  expect(stripLegacyStockChatContext(legacy)).toEqual({ symbol: '510300.SH', structure: { chanlun: {} } })
  expect(legacy.price_zones).toHaveLength(1)
  expect(legacy.structure.elliott).toBeDefined()
  expect(stripLegacyStockChatContext({ symbol: '510300.SH' })).toEqual({ symbol: '510300.SH' })
})

it('AI结构解读保留后端阶段和项目规则来源，不将流程图当成背驰确认', () => {
  const a = emptyChanlunAnalysis('30m')
  a.interpretation = { version: 1, ruleSource: 'project', asOf: '2026-10-26 15:00', closedPrice: 1,
    phase: { key: 'forming', label: '中枢形成', subtitle: '刚形成', description: '三笔重叠' },
    centerOrdinal: 1, legs: [], facts: ['实际结构事实'], observation: { title: '观察边界', conditions: [] }, levels: [], }
  const snapshot = buildStockChatSnapshot({ symbol: '510300.SH', period: '30m', selectedDate: null, chanlun: a,
    response: { symbol: '510300.SH', asset_type: 'etf', rows: [{ date: '2026-10-26 15:00', open: 1, high: 1, low: 1, close: 1 }] } })
  expect(snapshot?.structure.chanlun).toMatchObject({ capabilities: { divergences: false }, interpretation: { ruleSource: 'project', phase: { key: 'forming' }, facts: ['实际结构事实'] } })
})
