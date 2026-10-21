// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { storage } from '@/lib/storage'
import { getCardVisibility, PageSettingsModal } from './PageSettingsModal'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  localStorage.clear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  localStorage.clear()
})

it('shows ETF by default while preserving an explicit visibility choice', () => {
  expect(getCardVisibility(undefined).etf).toBe(true)
  storage.dataCardVisible.set({ etf: false })
  expect(getCardVisibility(undefined).etf).toBe(false)
  storage.dataCardVisible.set({ etf: true })
  expect(getCardVisibility(undefined).etf).toBe(true)
})

it('restores ETF with the first six cards and persists later manual changes', async () => {
  storage.dataCardVisible.set({ etf: false, minute: true })
  await act(async () => root.render(<PageSettingsModal caps={undefined} />))
  await act(async () => {
    Array.from(host.querySelectorAll('button')).find(button => button.textContent === '恢复默认')!.click()
  })
  const saved = storage.dataCardVisible.get({})
  expect(Object.entries(saved).filter(([, shown]) => shown).map(([key]) => key)).toEqual([
    'instruments', 'daily', 'adj_factor', 'enriched', 'index', 'etf',
  ])
  const checkbox = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]'))
    .find(button => button.parentElement?.textContent?.includes('场内交易基金日K'))!
  expect(checkbox.getAttribute('aria-checked')).toBe('true')
  await act(async () => checkbox.click())
  expect(getCardVisibility(undefined).etf).toBe(false)
})
