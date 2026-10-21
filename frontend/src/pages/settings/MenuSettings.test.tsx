// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { SettingsMenuSettingsPanel } from './MenuSettings'

const fixtures = vi.hoisted(() => ({ hidden: vi.fn(async (_ids: string[]) => ({})) }))
vi.mock('@/lib/api', () => ({ api: {
  analysisMenus: async () => ({ items: [] }),
  saveNavHidden: fixtures.hidden,
} }))
vi.mock('@/lib/useSharedQueries', () => ({ usePreferences: () => ({ data: {
  nav_order: ['/watchlist-etf', '/etf-pool', '/'], nav_hidden: [],
} }) }))
vi.mock('@/extensions/registry', () => ({ getFrontendExtensionNavigation: () => [{
  label: 'ETF池', route: { path: '/etf-pool' },
}] }))

it('registers the ETF extension in menu settings with its page link and visibility control', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  try {
    await act(async () => root.render(<MemoryRouter><QueryClientProvider client={client}><SettingsMenuSettingsPanel /></QueryClientProvider></MemoryRouter>))
    const link = host.querySelector('a[href="/etf-pool"]')!
    expect(link.getAttribute('title')).toBe('打开页面')
    const row = link.parentElement!.parentElement!
    expect(row.textContent).toContain('ETF池')
    const links = Array.from(host.querySelectorAll('a[title="打开页面"]')).map(a => a.getAttribute('href'))
    expect(links.filter(path => ['/watchlist-etf', '/etf-pool', '/'].includes(path!))).toEqual(['/watchlist-etf', '/etf-pool', '/'])
    await act(async () => row.querySelector<HTMLButtonElement>('button[title="隐藏"]')!.click())
    expect(fixtures.hidden).toHaveBeenCalledWith(['/etf-pool'])
  } finally {
    await act(async () => root.unmount())
    client.clear()
    host.remove()
  }
})
