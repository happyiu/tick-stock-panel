// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CustomSignalDialog } from './CustomSignalDialog'
import type { CustomSignal } from '@/lib/api'

const fixtures = vi.hoisted(() => ({ validate: vi.fn(), save: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: {
  customSignalsOptions: async () => ({ fields: [{ key: 'close', label: '收盘价' }], operators: ['>'], kinds: [] }),
  strategyAiStatus: async () => ({ configured: false }),
  customSignalValidate: fixtures.validate,
  customSignalSave: fixtures.save,
} }))
let host: HTMLDivElement
let root: Root
let client: QueryClient
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  fixtures.validate.mockReset().mockResolvedValue({ ok: true, variables: ['angel', 'devil', 'attack'] })
  fixtures.save.mockReset().mockImplementation(async signal => ({ ok: true, signal }))
})
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove() })
async function render(open = true, signal?: CustomSignal) {
  await act(async () => root.render(<QueryClientProvider client={client}><CustomSignalDialog open={open} signal={signal} onClose={() => {}} /></QueryClientProvider>))
}
async function click(text: string) {
  await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === text)!.click())
}
async function input(label: string, value: string) {
  await act(async () => {
    const element = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!
    const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
it('creates a validated formula from the example without changing condition mode', async () => {
  await render()
  expect(host.textContent).toContain('条件（多条件为「且」关系）')
  await click('公式创建')
  expect(host.textContent).not.toContain('AI 生成条件')
  await click('填入天使魔鬼·进攻示例')
  await input('信号标识', 'angel_attack')
  expect(host.querySelector<HTMLButtonElement>('[aria-label="保存信号"]')!.disabled).toBe(true)
  await click('校验公式')
  expect(host.querySelector('[aria-label="输出变量"]')?.textContent).toContain('attack')
  client.setQueryData(['signal-chart-markers', 'A'], [])
  client.setQueryData(['screener-cached', 'all'], {})
  await click('保存')
  expect(client.getQueryState(['signal-chart-markers', 'A'])?.isInvalidated).toBe(true)
  expect(client.getQueryState(['screener-cached', 'all'])?.isInvalidated).toBe(true)
  expect(fixtures.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'angel_attack', definition_type: 'formula', output_var: 'attack', kind: 'entry', min_history_bars: 100, conditions: [] }))
  await input('信号公式', 'out:CLOSE>0;')
  expect(host.querySelector<HTMLButtonElement>('[aria-label="保存信号"]')!.disabled).toBe(true)
  await render(false); await render(true)
  expect(host.textContent).toContain('条件（多条件为「且」关系）')
  expect(host.querySelector('[aria-label="信号公式"]')).toBeNull()
})
it('shows backend line errors and does not allow an unvalidated formula to save', async () => {
  await render(); await click('公式创建')
  fixtures.validate.mockRejectedValueOnce(new Error('第1行，第5列：不支持函数 BAD'))
  await input('信号公式', 'out:BAD(CLOSE);')
  await click('校验公式')
  expect(host.textContent).toContain('第1行，第5列')
  expect(fixtures.save).not.toHaveBeenCalled()
  expect(host.querySelector<HTMLButtonElement>('[aria-label="保存信号"]')!.disabled).toBe(true)
})

it('restores an edited formula and requires validation before saving', async () => {
  const signal: CustomSignal = { id: 'existing', name: '进攻', kind: 'entry', enabled: true, definition_type: 'formula', formula: 'attack:CLOSE>0;', output_var: 'attack', min_history_bars: 150, conditions: [] }
  await render(true, signal)
  expect(host.querySelector<HTMLInputElement>('[aria-label="信号标识"]')!.disabled).toBe(true)
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="信号公式"]')!.value).toBe(signal.formula)
  expect(host.querySelector<HTMLButtonElement>('[aria-label="保存信号"]')!.disabled).toBe(true)
  await click('校验公式')
  expect(host.querySelector<HTMLSelectElement>('[aria-label="输出变量"]')!.value).toBe('attack')
  await click('保存')
  expect(fixtures.save).toHaveBeenCalledWith({ ...signal, timeframe: 'daily' })
})
