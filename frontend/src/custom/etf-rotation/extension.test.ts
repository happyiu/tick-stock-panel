import { beforeEach, expect, it, vi } from 'vitest'
import extension from './extension'

beforeEach(() => vi.resetModules())
it('registers the independent rotation page and menu', async () => {
  const registry = await import('@/extensions/registry')
  await registry.loadFrontendExtensions({ rotation: async () => ({ default: extension }) })
  registry.finalizeFrontendExtensions(new Set(['/backtest']))
  expect(registry.getFrontendExtensionRoutes().map(r => r.path)).toEqual(['/etf-rotation'])
  expect(registry.getFrontendExtensionNavigation().map(n => n.label)).toEqual(['ETF轮动'])
})
it('isolates a conflicting rotation route without overriding core backtests', async () => {
  const registry = await import('@/extensions/registry')
  await registry.loadFrontendExtensions({ rotation: async () => ({ default: extension }) })
  registry.finalizeFrontendExtensions(new Set(['/etf-rotation']))
  expect(registry.getFrontendExtensionRoutes()).toEqual([])
  expect(registry.getFrontendExtensionLoadErrors()).toHaveLength(1)
})
