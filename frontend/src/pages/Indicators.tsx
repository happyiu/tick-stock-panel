import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Code2, Copy, Loader2, Pencil, Plus, Search, Trash2, X } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { api, type ChartIndicatorDefinition } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { useChartIndicators } from '@/lib/useChartIndicators'

const field = 'w-full rounded-md border border-border bg-base px-3 py-2 text-sm text-foreground outline-none focus:border-accent'
type Editor = { item?: ChartIndicatorDefinition; readOnly: boolean; copy?: boolean }
const emptyFormula = '{ 自建均线示例 }\n均线:MA(CLOSE,20),COLORYELLOW;\n'

function IndicatorEditor({ editor, close, changed }: { editor: Editor; close: () => void; changed: () => Promise<void> }) {
  const { item, readOnly, copy } = editor
  const [name, setName] = useState(item ? `${item.name}${copy ? ' 副本' : ''}` : '')
  const [pane, setPane] = useState<'main' | 'sub'>(item?.pane ?? 'main')
  const [description, setDescription] = useState(item?.description ?? '')
  const [formula, setFormula] = useState(item?.formula ?? emptyFormula)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [valid, setValid] = useState(false)
  const language = useQuery({ queryKey: QK.chartIndicatorLanguage, queryFn: api.chartIndicatorLanguage, staleTime: Infinity })
  const payload = { name, pane, description, formula }
  const run = async (save: boolean) => {
    setBusy(true); setError(''); setValid(false)
    try {
      if (save) {
        await api.saveChartIndicator({ ...payload, ...(item && !copy ? { revision: item.revision } : {}), ...(item && copy ? { copy_from: item.id } : {}) }, !copy ? item?.id : undefined)
        await changed(); close()
      } else {
        await api.validateChartIndicator(payload); setValid(true)
      }
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败，请重试') }
    finally { setBusy(false) }
  }
  return <Modal onClose={() => !busy && close()} ariaLabel={readOnly ? '指标源码' : item && !copy ? '编辑指标' : '新建指标'} panelClassName="flex max-h-[92dvh] w-[96vw] max-w-5xl flex-col rounded-card border border-border bg-surface shadow-xl">
    <div className="flex items-center justify-between border-b border-border px-5 py-4"><h2 className="font-semibold text-foreground">{readOnly ? `${item?.name} · 公式源码` : item && !copy ? '编辑指标' : '新建指标'}</h2><button aria-label="关闭" disabled={busy} onClick={close} className="text-muted hover:text-foreground"><X size={18} /></button></div>
    <div className="space-y-4 overflow-y-auto p-5">
      <div className="grid gap-4 sm:grid-cols-2"><label className="space-y-1 text-sm text-secondary">名称<input aria-label="指标名称" className={field} value={name} maxLength={80} readOnly={readOnly} onChange={e => { setName(e.target.value); setValid(false) }} /></label>
      <label className="space-y-1 text-sm text-secondary">类型<select aria-label="指标类型" className={field} value={pane} disabled={readOnly} onChange={e => { setPane(e.target.value as 'main' | 'sub'); setValid(false) }}><option value="main">主图叠加</option><option value="sub">副图</option></select></label></div>
      <label className="block space-y-1 text-sm text-secondary">说明<textarea aria-label="指标说明" className={field} value={description} maxLength={2000} readOnly={readOnly} onChange={e => setDescription(e.target.value)} /></label>
      <label className="block space-y-1 text-sm text-secondary">通达信公式<textarea aria-label="指标公式源码" spellCheck={false} className={`${field} min-h-72 resize-y whitespace-pre font-mono text-xs leading-6`} value={formula} maxLength={32768} readOnly={readOnly} onChange={e => { setFormula(e.target.value); setValid(false); setError('') }} /></label>
      {error && <div role="alert" className="whitespace-pre-wrap rounded-md bg-danger/10 p-3 text-sm text-danger">{error}</div>}
      {valid && <p role="status" className="text-sm text-accent">公式校验通过</p>}
      <details className="rounded-md border border-border p-3 text-xs text-muted"><summary className="cursor-pointer text-secondary">函数与语法说明</summary>{language.isLoading ? <p>加载中…</p> : language.isError ? <button onClick={() => language.refetch()}>说明加载失败，点击重试</button> : <><p className="mt-3 whitespace-pre-wrap leading-6">{language.data?.help}</p><p className="mt-2 leading-6">函数：{Object.keys(language.data?.functions ?? {}).join('、')}</p></>}</details>
    </div>
    <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-3"><button disabled={busy} onClick={close} className="rounded-btn px-3 py-2 text-sm text-secondary">{readOnly ? '关闭' : '取消'}</button>{!readOnly && <><button disabled={busy} onClick={() => run(false)} className="rounded-btn border border-border px-3 py-2 text-sm text-secondary disabled:opacity-50">校验公式</button><button disabled={busy || !name.trim() || !formula.trim()} onClick={() => run(true)} className="flex items-center gap-2 rounded-btn bg-accent px-4 py-2 text-sm text-white disabled:opacity-50">{busy && <Loader2 size={14} className="animate-spin" />}保存并应用</button></>}</div>
  </Modal>
}

export function Indicators() {
  const catalog = useChartIndicators()
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [source, setSource] = useState('all')
  const [pane, setPane] = useState('all')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [deleting, setDeleting] = useState<ChartIndicatorDefinition | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const changed = async () => {
    await qc.invalidateQueries({ queryKey: QK.chartIndicators })
    await qc.invalidateQueries({ predicate: q => ['kline', 'kline-period', 'chart-indicator-values'].includes(String(q.queryKey[0])) })
  }
  const remove = async () => {
    if (!deleting) return
    setBusy(true); setError('')
    try { await api.deleteChartIndicator(deleting.id, deleting.revision); await changed(); setDeleting(null) }
    catch (e) { setError(e instanceof Error ? e.message : '删除失败，请重试') }
    finally { setBusy(false) }
  }
  const items = catalog.items.filter(i => (source === 'all' || i.source === source) && (pane === 'all' || i.pane === pane) && `${i.name} ${i.description}`.toLowerCase().includes(search.toLowerCase().trim()))
  return <div className="space-y-5 p-4 sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-semibold text-foreground">指标</h1><p className="mt-1 text-sm text-muted">管理主图叠加与副图指标，自建公式保存后应用于 K 线。</p></div><button onClick={() => setEditor({ readOnly: false })} className="flex items-center gap-2 rounded-btn bg-accent px-4 py-2 text-sm text-white"><Plus size={16} />新建指标</button></div>
    <div className="flex flex-wrap gap-3"><label className="relative min-w-48 flex-1"><Search size={16} className="absolute left-3 top-2.5 text-muted" /><input aria-label="搜索指标" placeholder="搜索指标名称或说明" value={search} onChange={e => setSearch(e.target.value)} className={`${field} pl-9`} /></label><select aria-label="指标来源筛选" value={source} onChange={e => setSource(e.target.value)} className={`${field} !w-auto`}><option value="all">全部来源</option><option value="custom">自建</option><option value="builtin">内置</option></select><select aria-label="主副图筛选" value={pane} onChange={e => setPane(e.target.value)} className={`${field} !w-auto`}><option value="all">全部类型</option><option value="main">主图叠加</option><option value="sub">副图</option></select></div>
    {catalog.isLoading && <p role="status" className="py-6 text-muted">加载指标…</p>}
    {catalog.isError && <div role="alert" className="text-danger">指标加载失败 <button onClick={() => catalog.refetch()} className="underline">重试</button></div>}
    {catalog.data?.errors.map(e => <p key={e.id} role="alert" className="text-sm text-danger">{e.id}：{e.message}</p>)}
    {!catalog.isLoading && !catalog.isError && <div className="overflow-x-auto rounded-card border border-border bg-surface"><table className="w-full text-left text-sm"><thead className="border-b border-border bg-elevated/40 text-muted"><tr><th className="p-4 font-medium">名称</th><th className="p-4 font-medium">来源</th><th className="p-4 font-medium">类型</th><th className="hidden p-4 font-medium lg:table-cell">说明</th><th className="p-4 font-medium">操作</th></tr></thead><tbody>{items.map(item => <tr key={item.id} className="border-b border-border/50 last:border-0 hover:bg-elevated/30"><td className="min-w-32 p-4 font-medium text-foreground">{item.name}</td><td className="whitespace-nowrap p-4"><span className={`rounded px-2 py-1 text-xs ${item.source === 'custom' ? 'bg-accent/10 text-accent' : 'bg-elevated text-muted'}`}>{item.source === 'custom' ? '自建' : '内置'}</span></td><td className="whitespace-nowrap p-4 text-secondary">{item.pane === 'main' ? '主图叠加' : '副图'}</td><td className="hidden max-w-xs p-4 text-xs text-muted lg:table-cell">{item.description || '—'}</td><td className="p-4">{item.source === 'custom' ? <div className="flex flex-wrap gap-3"><button aria-label={`查看${item.name}源码`} title="查看源码" onClick={() => setEditor({ item, readOnly: true })} className="text-muted hover:text-accent"><Code2 size={16} /></button><button aria-label={`编辑${item.name}`} title="编辑" onClick={() => setEditor({ item, readOnly: false })} className="text-muted hover:text-accent"><Pencil size={16} /></button><button aria-label={`复制${item.name}`} title="复制" onClick={() => setEditor({ item, copy: true, readOnly: false })} className="text-muted hover:text-accent"><Copy size={16} /></button><button aria-label={`删除${item.name}`} title="删除" onClick={() => { setDeleting(item); setError('') }} className="text-muted hover:text-danger"><Trash2 size={16} /></button></div> : <span className="text-xs text-muted">只读</span>}</td></tr>)}</tbody></table>{items.length === 0 && <p className="p-8 text-center text-sm text-muted">没有匹配的指标</p>}</div>}
    {editor && <IndicatorEditor editor={editor} close={() => setEditor(null)} changed={changed} />}
    {deleting && <Modal ariaLabel="删除指标" onClose={() => !busy && setDeleting(null)}><div className="space-y-4 p-5"><h2 className="font-semibold text-foreground">删除“{deleting.name}”？</h2><p className="text-sm text-muted">删除后将从指标菜单和已启用的 K 线中移除。</p>{error && <p role="alert" className="text-sm text-danger">{error}</p>}<div className="flex justify-end gap-3"><button disabled={busy} onClick={() => setDeleting(null)} className="px-3 py-2 text-sm text-secondary">取消</button><button disabled={busy} onClick={remove} className="rounded-btn bg-danger px-4 py-2 text-sm text-white disabled:opacity-50">{busy ? '删除中…' : '确认删除'}</button></div></div></Modal>}
  </div>
}
