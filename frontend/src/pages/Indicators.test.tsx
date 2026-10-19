// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Indicators } from './Indicators'
import { api, type ChartIndicatorDefinition } from '@/lib/api'
const fixture = vi.hoisted(() => ({ items: [] as ChartIndicatorDefinition[] }))
vi.mock('@/lib/api', () => ({ api: {
  chartIndicators: vi.fn(async () => ({ items: fixture.items, errors: [] })),
  chartIndicatorLanguage: vi.fn(async () => ({ help: '公式语法', functions: { MA: [2,2] }, drawings: {} })),
  saveChartIndicator: vi.fn(async (value, id) => {
    const item = { ...value, id: id ?? 'user-new', source: 'custom', revision: 2, height: 100 }
    fixture.items = [...fixture.items.filter(i => i.id !== item.id), item]
    return item
  }),
  validateChartIndicator: vi.fn(async () => ({ valid: true })),
  deleteChartIndicator: vi.fn(async (id) => { fixture.items = fixture.items.filter(i => i.id !== id); return { deleted: true } }),
} }))
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, client: QueryClient
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.getAttribute('aria-label') === label || b.textContent === label)!
const input = (label: string) => host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!
const settle = async () => { for (let i=0; i<3; i++) await act(async () => { await new Promise(r => setTimeout(r,0)) }) }
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { fn(); return 1 }); vi.stubGlobal('cancelAnimationFrame', vi.fn())
  fixture.items = [{ id: 'ma', name: 'MA 均线', pane: 'main', source: 'custom', description: '均线', formula: '原线:MA(CLOSE,5);', revision: 1, height: 100 }]
  vi.clearAllMocks()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<QueryClientProvider client={client}><Indicators /></QueryClientProvider>)); await settle()
})
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); vi.unstubAllGlobals() })
it('内置只读，自建可以查看真实公式，关闭复制态再新建不会残留旧内容', async () => {
  await act(async () => button('自建').click())
  const builtinRow = [...host.querySelectorAll('tr')].find(r => r.textContent?.includes('EMA 指数均线'))!
  expect(builtinRow.textContent).toContain('只读'); expect(builtinRow.querySelector('button')).toBeNull()
  await act(async () => button('查看MA 均线源码').click())
  expect(input('指标公式源码').readOnly).toBe(true)
  expect(input('指标公式源码').value).toBe('原线:MA(CLOSE,5);')
  expect(button('保存并应用')).toBeUndefined()
  await act(async () => button('关闭').click())
  await act(async () => button('复制MA 均线').click())
  expect(input('指标名称').value).toBe('MA 均线 副本')
  await act(async () => button('取消').click())
  await act(async () => button('新建指标').click())
  expect(input('指标名称').value).toBe('')
  expect(input('指标公式源码').value).toContain('自建均线示例')
})
it('保存使用稳定ID和版本，删除刷新目录', async () => {
  await act(async () => button('编辑MA 均线').click())
  await act(async () => button('保存并应用').click()); await settle()
  expect(api.saveChartIndicator).toHaveBeenCalledWith(expect.objectContaining({ revision: 1, formula: '原线:MA(CLOSE,5);' }), 'ma')
  await act(async () => button('删除MA 均线').click())
  await act(async () => button('确认删除').click()); await settle()
  expect(api.deleteChartIndicator).toHaveBeenCalledWith('ma', 2)
  expect(button('编辑MA 均线')).toBeUndefined()
})

it('监控信号绑定需要明确选择变量，并随指标保存', async () => {
  vi.mocked(api.validateChartIndicator).mockResolvedValueOnce({ valid: true, variables: ['原线'] })
  await act(async () => button('编辑MA 均线').click())
  await act(async () => button('添加信号').click()); await settle()
  const variable = input('信号1变量') as unknown as HTMLSelectElement
  expect(variable.value).toBe('')
  expect(variable.textContent).toContain('原线')
  await act(async () => {
    variable.value = '原线'; variable.dispatchEvent(new Event('change', { bubbles: true }))
    const name = input('信号1名称')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, '条件提醒')
    name.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => button('保存并应用').click()); await settle()
  expect(api.saveChartIndicator).toHaveBeenCalledWith(expect.objectContaining({ monitor_signals: [expect.objectContaining({ name: '条件提醒', variable: '原线', periods: ['30m', '1d'] })], min_history_bars: 100 }), 'ma')
})

it('来源默认自建，类型默认不限，单选项可取消且两组筛选互相独立', async () => {
  fixture.items = [...fixture.items, { ...fixture.items[0], id: 'vol', name: '成交量测试', pane: 'sub' }]
  await act(async () => client.invalidateQueries()); await settle()
  const radio = (label: string) => button(label).getAttribute('aria-checked')
  const rows = () => [...host.querySelectorAll('tbody tr')].map(row => row.textContent)
  expect(radio('自建')).toBe('true')
  expect(radio('内置')).toBe('false')
  expect(radio('主图叠加')).toBe('false')
  expect(radio('副图')).toBe('false')
  expect(rows()).toHaveLength(2)
  await act(async () => button('主图叠加').click())
  expect(rows()).toHaveLength(1)
  expect(rows()[0]).toContain('MA 均线')
  await act(async () => button('主图叠加').click())
  expect(rows()).toHaveLength(2)
  await act(async () => button('副图').click())
  expect(rows()).toHaveLength(1)
  expect(rows()[0]).toContain('成交量测试')
  await act(async () => button('内置').click())
  expect(radio('自建')).toBe('false')
  expect(radio('内置')).toBe('true')
  expect(rows().every(row => row?.includes('内置') && row.includes('副图'))).toBe(true)
  await act(async () => button('内置').click())
  expect(radio('内置')).toBe('false')
  expect(rows().some(row => row?.includes('成交量测试'))).toBe(true)
  expect(rows().some(row => row?.includes('MA 均线'))).toBe(false)
  await act(async () => button('副图').click())
  expect(rows().some(row => row?.includes('MA 均线'))).toBe(true)
  expect(rows().some(row => row?.includes('EMA 指数均线'))).toBe(true)
})
