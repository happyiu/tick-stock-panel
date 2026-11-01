import { beforeEach, expect, it, vi } from 'vitest'
import extension from './extension'

beforeEach(() => vi.resetModules())

it('registers the volume page and menu', async () => {
  const registry = await import('@/extensions/registry')
  await registry.loadFrontendExtensions({ volume: async () => ({ default: extension }) })
  registry.finalizeFrontendExtensions(new Set(['/indices']))
  expect(registry.getFrontendExtensionRoutes().map(item => item.path)).toEqual(['/volume-analysis'])
  expect(registry.getFrontendExtensionNavigation().map(item => item.label)).toEqual(['量能分析'])
})

it('isolates a conflicting core route', async () => {
  const registry = await import('@/extensions/registry')
  await registry.loadFrontendExtensions({ volume: async () => ({ default: extension }) })
  registry.finalizeFrontendExtensions(new Set(['/volume-analysis']))
  expect(registry.getFrontendExtensionRoutes()).toEqual([])
  expect(registry.getFrontendExtensionLoadErrors()[0].error).toContain('覆盖核心路由')
})
