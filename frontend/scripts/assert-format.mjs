import assert from 'node:assert/strict'
import { fmtAssetPrice } from '../src/lib/format.ts'

assert.equal(fmtAssetPrice(4.1234, 'etf'), '4.123')
assert.equal(fmtAssetPrice(12.345, 'stock'), '12.35')
assert.equal(fmtAssetPrice(null, 'etf'), '—')
assert.equal(fmtAssetPrice(undefined, 'stock'), '—')
