import { beforeEach, expect, it, vi } from 'vitest'
import extension from './extension'

beforeEach(() => vi.resetModules())

it('registers the ETF route and menu using the supported extension contract', async () => {
  const registry = await import('@/extensions/registry')
  await registry.loadFrontendExtensions({ etf: async () => ({ default: extension }) })
  registry.finalizeFrontendExtensions(new Set(['/settings']))
  expect(registry.getFrontendExtensionRoutes().map(route => route.path)).toEqual(['/etf-pool'])
  expect(registry.getFrontendExtensionNavigation().map(item => [item.label, item.route.path])).toEqual([['ETF池', '/etf-pool']])
  expect(registry.getFrontendExtensionLoadErrors()).toEqual([])
})

it('disables the extension if an upstream core route occupies its path', async () => {
  const registry = await import('@/extensions/registry')
  await registry.loadFrontendExtensions({ etf: async () => ({ default: extension }) })
  registry.finalizeFrontendExtensions(new Set(['/etf-pool']))
  expect(registry.getFrontendExtensionRoutes()).toEqual([])
  expect(registry.getFrontendExtensionNavigation()).toEqual([])
  expect(registry.getFrontendExtensionLoadErrors()[0].error).toContain('覆盖核心路由')
})

it('rejects a duplicate path without affecting the ETF page', async () => {
  const registry = await import('@/extensions/registry')
  await registry.loadFrontendExtensions({
    a: async () => ({ default: extension }),
    b: async () => ({ default: { ...extension, id: 'duplicate.etf', routes: [{ ...extension.routes![0], id: 'duplicate-route' }] } }),
  })
  registry.finalizeFrontendExtensions(new Set())
  expect(registry.getFrontendExtensionRoutes()).toHaveLength(1)
  expect(registry.getFrontendExtensionLoadErrors()[0].error).toContain('路径重复')
})
