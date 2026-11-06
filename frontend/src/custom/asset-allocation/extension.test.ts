import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import extension from './extension'

beforeEach(() => vi.resetModules())

it('registers the asset allocation menu and renders its page', async () => {
  const registry = await import('@/extensions/registry')
  await registry.loadFrontendExtensions({ allocation: async () => ({ default: extension }) })
  registry.finalizeFrontendExtensions(new Set(['/settings']))
  const [item] = registry.getFrontendExtensionNavigation()
  expect([item.label, item.route.path]).toEqual(['资产配置', '/asset-allocation'])
  const html = renderToStaticMarkup(createElement(item.route.component))
  expect(html).toContain('资产配置')
  expect(html).toContain('加载资产配置')
  expect(registry.getFrontendExtensionLoadErrors()).toEqual([])
})

it('isolates a conflicting core route', async () => {
  const registry = await import('@/extensions/registry')
  await registry.loadFrontendExtensions({ allocation: async () => ({ default: extension }) })
  registry.finalizeFrontendExtensions(new Set(['/asset-allocation']))
  expect(registry.getFrontendExtensionRoutes()).toEqual([])
  expect(registry.getFrontendExtensionNavigation()).toEqual([])
  expect(registry.getFrontendExtensionLoadErrors()[0].error).toContain('覆盖核心路由')
})
