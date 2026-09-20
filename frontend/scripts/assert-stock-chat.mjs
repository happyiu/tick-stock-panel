import assert from 'node:assert/strict'
import { selectStockChatRows, stockChatBarKey, trimStockChatMessages } from '../src/lib/stockChatPrimitives.ts'

const rows = Array.from({ length: 95 }, (_, index) => ({
  date: `2026-01-${String(index + 1).padStart(3, '0')}`,
  close: index,
}))
const selected = selectStockChatRows(rows, '1d', null, 90)
assert.equal(selected.length, 90)
assert.equal(selected.at(-1).date, '2026-01-095')

const validRows = Array.from({ length: 95 }, (_, index) => ({
  date: `2026-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')}`,
}))
const visible = selectStockChatRows(validRows, '1d', '2026-03-10', 90)
assert.equal(visible.length, 66)
assert.ok(stockChatBarKey(visible.at(-1).date, '1d') <= '2026-03-10')
assert.equal(selectStockChatRows(validRows, '1d', '2025-12-31', 90).length, 0)

const messages = Array.from({ length: 7 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: String(index) }))
const trimmed = trimStockChatMessages(messages, 5)
assert.equal(trimmed.length, 5)
assert.deepEqual(trimmed.map(item => item.role), ['user', 'assistant', 'user', 'assistant', 'user'])

console.log('stock chat primitive assertions passed')
