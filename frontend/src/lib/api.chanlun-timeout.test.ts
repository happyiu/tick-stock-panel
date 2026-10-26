// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { api } from './api'

vi.mock('@/components/Toast', () => ({ toast: vi.fn() }))
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it.each(['daily', 'period'] as const)('长窗口缠论%s请求可超过30秒，普通行情仍及时超时', async kind => {
  vi.useFakeTimers()
  const pending: ((response: Response) => void)[] = []
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    pending.push(resolve)
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  })))
  const request = (chanlun = false) => kind === 'daily'
    ? api.klineDaily('A', 120, undefined, undefined, false, chanlun ? { source: 'stroke' } : undefined)
    : api.klinePeriod('A', '30m', { start: '2025-01-01', end: '2026-10-26' }, 120, false, chanlun ? { source: 'stroke' } : undefined)
  const ordinary = request().catch(error => error)
  let completed = false
  const analysis = request(true).then(value => { completed = true; return value })
  await vi.advanceTimersByTimeAsync(35_000)
  expect(await ordinary).toMatchObject({ status: 0, message: expect.stringContaining('请求超时（30s）') })
  expect(completed).toBe(false)
  pending[1](new Response(JSON.stringify({ symbol: 'A', rows: [] }), { headers: { 'Content-Type': 'application/json' } }))
  expect(await analysis).toMatchObject({ symbol: 'A', rows: [] })
})
