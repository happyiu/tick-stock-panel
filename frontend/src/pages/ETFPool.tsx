import { lazy, Suspense, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronLeft, ChevronRight, RefreshCw, Search } from 'lucide-react'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { api, type EtfPoolParams, type EtfPoolRow } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { fmtAssetPrice, fmtPct, priceColorClass } from '@/lib/format'

const StockPreviewDialog = lazy(() => import('@/components/StockPreviewDialog').then(m => ({ default: m.StockPreviewDialog })))
const control = 'h-8 rounded-lg border border-border bg-surface px-3 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-40'

export function ETFPool() {
  const [search, setSearch] = useState('')
  const [params, setParams] = useState<EtfPoolParams>({ q: '', category: '', page: 1, pageSize: 20 })
  const [selected, setSelected] = useState<EtfPoolRow | null>(null)
  const [categories, setCategories] = useState<{ name: string; count: number }[]>([])
  useEffect(() => {
    const timer = setTimeout(() => setParams(p => p.q === search.trim() ? p : { ...p, q: search.trim(), page: 1 }), 300)
    return () => clearTimeout(timer)
  }, [search])
  const query = useQuery({
    queryKey: QK.etfPool(params),
    queryFn: () => api.etfPool(params),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
  const data = query.data
  useEffect(() => {
    if (data) setCategories(data.categories)
  }, [data])
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / params.pageSize))
  const pageItems: (number | string)[] = pages <= 7
    ? Array.from({ length: pages }, (_, i) => i + 1)
    : params.page <= 4 ? [1, 2, 3, 4, 5, 'end', pages]
    : params.page >= pages - 3 ? [1, 'start', ...Array.from({ length: 5 }, (_, i) => pages - 4 + i)]
    : [1, 'start', params.page - 1, params.page, params.page + 1, 'end', pages]
  useEffect(() => {
    if (data && params.page > pages) setParams(p => ({ ...p, page: pages }))
  }, [data, params.page, pages])
  const update = (value: Partial<EtfPoolParams>) => setParams(p => ({ ...p, ...value, page: 1 }))
  const reset = () => {
    setSearch('')
    setParams(p => ({ ...p, q: '', category: '', page: 1 }))
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <PageHeader title="ETF池" className="shrink-0 pl-16 md:pl-5" right={
        <button className={`${control} grid place-items-center`} onClick={() => void query.refetch()} disabled={query.isFetching} aria-label="刷新 ETF 列表">
          <RefreshCw className={`h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} />
        </button>
      } />
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 sm:p-5">
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-2 h-4 w-4 text-muted" />
            <input className={`${control} w-full pl-9`} aria-label="搜索 ETF" placeholder="搜索 ETF 代码 / 名称" maxLength={50} value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <select className={control} aria-label="ETF 分类" value={params.category} onChange={e => update({ category: e.target.value })}>
            <option value="">全部分类</option>
            {categories.map(c => <option key={c.name} value={c.name}>{c.name}（{c.count}）</option>)}
          </select>
          <button className="text-sm text-muted hover:text-accent" onClick={reset}>重置筛选</button>
        </div>
        {query.isError && <div role="alert" className="shrink-0 rounded-lg border border-down/30 bg-down/5 p-4 text-sm">
          ETF 列表加载失败：{query.error.message}
          <button className="ml-3 text-accent" onClick={() => void query.refetch()}>重试</button>
        </div>}
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain rounded-xl border border-border bg-surface" aria-busy={query.isFetching}>
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="sticky top-0 z-10 border-b border-border bg-elevated text-xs text-muted"><tr>
              <th className="px-4 py-3 font-medium">代码</th><th className="px-4 py-3 font-medium">ETF 名称</th>
              <th className="px-4 py-3 text-right font-medium" title="场内成交价，下方为行情数据日期">最新价</th>
              <th className="px-4 py-3 text-right font-medium">涨跌幅</th>
              <th className="px-4 py-3 font-medium">分类</th>
            </tr></thead>
            <tbody className="divide-y divide-border">
              {data?.rows.map(row => <tr key={row.symbol} className="hover:bg-elevated/60">
                <td className="px-4 py-3 font-mono"><button className="text-accent hover:underline" onClick={() => setSelected(row)}>{row.symbol}</button></td>
                <td className="px-4 py-3"><button className="text-foreground hover:text-accent" onClick={() => setSelected(row)}>{row.name || row.code}</button></td>
                <td className="px-4 py-3 text-right font-mono tabular-nums" title={row.quote_date ? `行情日期：${row.quote_date}` : '暂无行情数据'}>
                  <div>{fmtAssetPrice(row.last_price, 'etf')}</div>
                  {row.quote_date && <div className="mt-0.5 text-[10px] text-muted">{row.quote_date}</div>}
                </td>
                <td className={`px-4 py-3 text-right font-mono tabular-nums ${priceColorClass(row.change_pct)}`}>{fmtPct(row.change_pct)}</td>
                <td className="px-4 py-3"><span className="rounded-md bg-accent/10 px-2 py-1 text-xs text-accent">{row.category}</span></td>
              </tr>)}
            </tbody>
          </table>
          {query.isPending && <div className="p-12 text-center text-sm text-muted" role="status">正在加载 ETF 列表…</div>}
          {data?.total === 0 && <div className="space-y-2 p-12 text-center text-sm text-muted">
            <p>{data.catalog_total === 0 ? '暂无 ETF 目录，请先在数据页同步 ETF 标的信息。' : '没有符合条件的 ETF，请调整筛选条件。'}</p>
            {data.catalog_total === 0 ? <Link className="text-accent" to="/data">前往数据页</Link> : <button className="text-accent" onClick={reset}>清空筛选</button>}
          </div>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-5 gap-y-3 border-t border-border pt-3 text-sm text-secondary">
          <span className="whitespace-nowrap">共 {data ? data.total.toLocaleString() : '—'} 条</span>
          <nav aria-label="ETF 分页" className="flex items-center justify-center gap-1">
            <button className="grid h-8 w-6 place-items-center hover:text-accent disabled:opacity-30 sm:w-8" aria-label="上一页" disabled={!data || params.page <= 1 || query.isFetching} onClick={() => setParams(p => ({ ...p, page: p.page - 1 }))}><ChevronLeft className="h-4 w-4" /></button>
            {pageItems.map(page => typeof page === 'number' ? <button key={page} aria-label={`第 ${page} 页`} aria-current={page === params.page ? 'page' : undefined} disabled={!data || query.isFetching} className={`h-8 min-w-6 px-1 text-sm font-semibold tabular-nums hover:text-accent disabled:opacity-40 sm:min-w-8 ${page === params.page ? 'text-accent' : 'text-foreground'}`} onClick={() => setParams(p => ({ ...p, page }))}>{page}</button> : <span key={page} className="grid h-8 w-6 place-items-center text-muted">…</span>)}
            <button className="grid h-8 w-6 place-items-center hover:text-accent disabled:opacity-30 sm:w-8" aria-label="下一页" disabled={!data || params.page >= pages || query.isFetching} onClick={() => setParams(p => ({ ...p, page: p.page + 1 }))}><ChevronRight className="h-4 w-4" /></button>
          </nav>
          <div className="relative">
            <select className="h-8 w-28 cursor-pointer appearance-none rounded border border-border bg-surface pl-3 pr-8 text-sm outline-none transition-colors hover:border-accent/40 focus:ring-1 focus:ring-accent" aria-label="每页条数" value={params.pageSize} onChange={e => update({ pageSize: Number(e.target.value) })}>
              {[20, 50, 100].map(n => <option key={n} value={n}>{n}条/页</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
          </div>
        </div>
      </div>
      {selected && <Suspense fallback={<div role="status" className="p-4 text-muted">加载 ETF 详情…</div>}>
        <StockPreviewDialog symbol={selected.symbol} name={selected.name} triggerInfo={{ asset_type: 'etf' }} onClose={() => setSelected(null)} navList={data?.rows} onNavigate={(symbol, name) => setSelected({ ...selected, symbol, name: name ?? '' })} />
      </Suspense>}
    </div>
  )
}
