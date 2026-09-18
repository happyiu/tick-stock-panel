import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Database, ExternalLink, Package, RefreshCw } from 'lucide-react'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { toast } from '@/components/Toast'
import { api, type CommodityDefinition, type CommodityRow } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { useDataStatus } from '@/lib/useSharedQueries'

const CATEGORY_META = {
  precious_metal: { label: '贵金属', description: '国际现货贵金属', source: 'Gold API' },
  energy: { label: '能源', description: '原油与天然气价格', source: 'FRED / EIA' },
  energy_fundamental: { label: '能源基本面', description: '库存、产量与炼厂利用率', source: 'EIA' },
} as const

const CATEGORY_ORDER = ['precious_metal', 'energy', 'energy_fundamental'] as const

function localDate(date = new Date()) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
}

function startDateMonthsAgo(months: number, end = localDate()) {
  const date = new Date(end + 'T00:00:00')
  const day = date.getDate()
  date.setDate(1)
  date.setMonth(date.getMonth() - months)
  date.setDate(Math.min(day, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()))
  return localDate(date)
}

function formatValue(value: number | null | undefined, unit?: string) {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  const digits = unit === '%' ? 2 : unit === '千桶' || unit === '千桶/日' ? 0 : 3
  return Number(value).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function formatRetrievedAt(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function sourceLabel(source?: string | null) {
  return source === 'goldapi' ? 'Gold API' : source === 'fred' ? 'FRED' : source === 'eia' ? 'EIA' : source || '—'
}

function frequencyLabel(frequency?: string | null) {
  return frequency === '1d' ? '日频' : frequency === '1w' ? '周频' : frequency || '—'
}

function latestRowsBySymbol(rows: CommodityRow[]) {
  const latest = new Map<string, CommodityRow>()
  for (const row of rows) {
    const previous = latest.get(row.symbol)
    if (!previous || row.date > previous.date || (row.date === previous.date && row.retrieved_at > previous.retrieved_at)) {
      latest.set(row.symbol, row)
    }
  }
  return latest
}

function CommodityChart({ rows, item }: { rows: CommodityRow[]; item?: CommodityDefinition }) {
  const points = useMemo(
    () => rows.filter(row => row.symbol === item?.symbol).sort((a, b) => a.date.localeCompare(b.date)),
    [item?.symbol, rows],
  )

  if (!item || points.length === 0) {
    return <div className="grid h-52 place-items-center rounded-card bg-elevated/30 text-sm text-muted">当前日期范围暂无数据</div>
  }

  const values = points.map(point => point.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const spread = Math.max(max - min, Math.abs(max) * 0.01, 0.0001)
  const plotMin = min - spread * 0.15
  const plotMax = max + spread * 0.15
  const plotLeft = 72
  const plotRight = 1188
  const plotTop = 14
  const plotBottom = 184
  const x = (index: number) => plotLeft + (index / Math.max(points.length - 1, 1)) * (plotRight - plotLeft)
  const y = (value: number) => plotTop + ((plotMax - value) / (plotMax - plotMin)) * (plotBottom - plotTop)
  const gridValues = [plotMax, (plotMax + plotMin) / 2, plotMin]
  const ticks = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])]

  return (
    <div className="rounded-card border border-border bg-base/30 p-2">
      <svg viewBox="0 0 1200 230" className="block h-auto w-full" role="img" aria-label={item.name + '历史曲线'}>
        {gridValues.map(value => (
          <g key={value}>
            <line x1={plotLeft} x2={plotRight} y1={y(value)} y2={y(value)} stroke="hsl(var(--border) / 0.7)" />
            <text x={plotLeft - 8} y={y(value) + 4} textAnchor="end" fill="hsl(var(--fg-muted))" fontSize="10">{formatValue(value, item.unit)}</text>
          </g>
        ))}
        <line x1={plotLeft} x2={plotLeft} y1={plotTop} y2={plotBottom} stroke="hsl(var(--fg-muted) / 0.85)" />
        <line x1={plotLeft} x2={plotRight} y1={plotBottom} y2={plotBottom} stroke="hsl(var(--fg-muted) / 0.85)" />
        {ticks.map(index => (
          <g key={points[index].date}>
            <line x1={x(index)} x2={x(index)} y1={plotBottom} y2={plotBottom + 5} stroke="hsl(var(--fg-muted) / 0.85)" />
            <text x={x(index)} y={plotBottom + 19} textAnchor="middle" fill="hsl(var(--fg-muted))" fontSize="10">{points[index].date}</text>
          </g>
        ))}
        <polyline
          points={points.map((point, index) => String(x(index)) + ',' + String(y(point.value))).join(' ')}
          fill="none"
          stroke="hsl(var(--accent))"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx={x(points.length - 1)} cy={y(points[points.length - 1].value)} r="3.5" fill="hsl(var(--accent))" />
      </svg>
      <div className="flex items-center justify-between text-[10px] text-muted">
        <span>{points.length} 个原始数据点 · 不补齐频率缺口</span>
        <span className="font-mono">最新 {formatValue(points[points.length - 1].value, item.unit)} {item.unit}</span>
      </div>
    </div>
  )
}

export function Commodity() {
  const qc = useQueryClient()
  const [startDate, setStartDate] = useState(() => startDateMonthsAgo(12))
  const [endDate, setEndDate] = useState(localDate)
  const [selectedCategory, setSelectedCategory] = useState<(typeof CATEGORY_ORDER)[number]>('precious_metal')
  const [selectedSymbol, setSelectedSymbol] = useState('XAU/USD')

  const status = useDataStatus({ staleTime: 30_000, refetchInterval: 60_000 })
  const catalog = useQuery({
    queryKey: [...QK.commodity, 'catalog'],
    queryFn: api.commodityCatalog,
    staleTime: 300_000,
  })
  const items = catalog.data?.items ?? []
  const categoryItems = useMemo(() => items.filter(item => item.category === selectedCategory), [items, selectedCategory])
  const selectedItem = items.find(item => item.symbol === selectedSymbol) ?? categoryItems[0]
  const rangeValid = startDate <= endDate

  useEffect(() => {
    if (selectedItem && selectedItem.symbol !== selectedSymbol) setSelectedSymbol(selectedItem.symbol)
  }, [selectedItem, selectedSymbol])

  const history = useQuery({
    queryKey: [...QK.commodity, 'history', selectedSymbol, startDate, endDate],
    queryFn: () => api.commodity({ startDate, endDate, symbol: selectedSymbol, limit: 10_000 }),
    enabled: Boolean(selectedSymbol) && rangeValid,
    placeholderData: previous => previous,
  })
  const categoryHistory = useQuery({
    queryKey: [...QK.commodity, 'category', selectedCategory, startDate, endDate],
    queryFn: () => api.commodity({ startDate, endDate, category: selectedCategory, limit: 10_000 }),
    enabled: rangeValid,
    placeholderData: previous => previous,
  })

  const sync = useMutation({
    mutationFn: () => api.commoditySync({ startDate, endDate }),
    onSuccess: result => {
      qc.invalidateQueries({ queryKey: QK.dataStatus })
      qc.invalidateQueries({ queryKey: QK.commodity })
      const failed = result.providers.filter(provider => !provider.ok)
      toast(
        failed.length > 0
          ? '商品同步完成 · ' + result.rows_written + ' 行落盘 · ' + failed.map(provider => sourceLabel(provider.provider)).join('、') + '失败'
          : '商品同步完成 · ' + result.rows_written + ' 行已落盘',
        failed.length > 0 ? 'error' : 'success',
      )
    },
    onError: (error: Error) => toast('商品同步失败: ' + error.message, 'error'),
  })

  const latestRows = useMemo(() => latestRowsBySymbol(categoryHistory.data?.items ?? []), [categoryHistory.data?.items])
  const stats = status.data?.commodity
  const sources = catalog.data?.sources ?? {}

  return (
    <div className="h-full overflow-auto bg-base">
      <PageHeader title="商品" subtitle="多源商品历史数据 · 原始频率落盘" />
      <main className="space-y-4 p-5">
        <section className="rounded-card border border-border bg-surface p-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Package className="h-4 w-4 text-accent" />
                <h2 className="text-sm font-semibold text-foreground">商品行情</h2>
              </div>
              <p className="mt-1 text-xs text-muted">价格与能源基本面按各数据源原始频率保存，不跨源替代。</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted">已落盘 {stats?.rows?.toLocaleString() ?? 0} 行</span>
              <span className="text-muted">最新 {stats?.latest_date ?? '—'}</span>
              <button
                type="button"
                onClick={() => sync.mutate()}
                disabled={!rangeValid || sync.isPending}
                className="inline-flex items-center gap-1.5 rounded-btn bg-accent px-3 py-1.5 font-medium text-base transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw className={sync.isPending ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
                {sync.isPending ? '同步中…' : '同步当前区间'}
              </button>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-end gap-2 text-xs">
            {[{ label: '近1个月', months: 1 }, { label: '近半年', months: 6 }, { label: '近1年', months: 12 }].map(range => {
              const rangeStart = startDateMonthsAgo(range.months, endDate)
              return (
                <button
                  key={range.label}
                  type="button"
                  onClick={() => setStartDate(rangeStart)}
                  className={startDate === rangeStart ? 'rounded-btn border border-accent/30 bg-accent/15 px-2.5 py-1.5 text-[11px] text-accent' : 'rounded-btn border border-border bg-elevated px-2.5 py-1.5 text-[11px] text-secondary hover:border-accent/40 hover:text-foreground'}
                >
                  {range.label}
                </button>
              )
            })}
            <label className="space-y-1">
              <span className="block text-[10px] text-muted">开始日期</span>
              <input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} className="rounded-btn border border-border bg-base px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:border-accent" />
            </label>
            <span className="pb-2 text-muted">至</span>
            <label className="space-y-1">
              <span className="block text-[10px] text-muted">结束日期</span>
              <input type="date" value={endDate} onChange={event => setEndDate(event.target.value)} className="rounded-btn border border-border bg-base px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:border-accent" />
            </label>
            {!rangeValid && <span className="pb-2 text-danger">开始日期不能晚于结束日期</span>}
          </div>
        </section>

        <section className="grid gap-3 lg:grid-cols-3">
          {CATEGORY_ORDER.map(category => {
            const meta = CATEGORY_META[category]
            const categorySourceNames = [...new Set(items.filter(item => item.category === category).map(item => sourceLabel(item.source)))]
            const active = selectedCategory === category
            return (
              <button
                key={category}
                type="button"
                onClick={() => setSelectedCategory(category)}
                className={active ? 'rounded-card border border-accent/60 bg-accent/10 p-4 text-left' : 'rounded-card border border-border bg-surface p-4 text-left transition-colors hover:border-accent/40'}
                aria-pressed={active}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-foreground">{meta.label}</div>
                    <div className="mt-1 text-[11px] text-muted">{meta.description}</div>
                  </div>
                  <span className="rounded bg-elevated px-2 py-1 text-[10px] text-secondary">{categorySourceNames.join(' / ') || meta.source}</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {items.filter(item => item.category === category).map(item => (
                    <span key={item.symbol} className="rounded bg-elevated/70 px-2 py-1 font-mono text-[10px] text-secondary">{item.symbol}</span>
                  ))}
                </div>
              </button>
            )
          })}
        </section>

        {catalog.isError && (
          <section className="rounded-card border border-danger/20 bg-danger/5 px-4 py-3 text-sm text-danger">
            商品目录加载失败，请检查后端服务。
          </section>
        )}

        <section className="rounded-card border border-border bg-surface p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">{CATEGORY_META[selectedCategory].label}最新快照</h2>
              <p className="mt-0.5 text-[11px] text-muted">每个品种独立显示单位、频率和数据源</p>
            </div>
            <span className="text-[11px] text-muted">数据源状态见下方</span>
          </div>
          {catalog.isLoading ? (
            <div className="rounded-card bg-elevated/30 px-4 py-8 text-center text-sm text-muted">商品目录加载中…</div>
          ) : catalog.isError ? (
            <div className="rounded-card bg-danger/5 px-4 py-8 text-center text-sm text-danger">暂时无法读取商品目录。</div>
          ) : categoryItems.length === 0 ? (
            <div className="rounded-card bg-elevated/30 px-4 py-8 text-center text-sm text-muted">当前分组暂无商品。</div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
              {categoryItems.map(item => {
                const row = latestRows.get(item.symbol)
                return (
                  <button
                    key={item.symbol}
                    type="button"
                    onClick={() => setSelectedSymbol(item.symbol)}
                    className={selectedItem?.symbol === item.symbol ? 'min-w-0 rounded-btn border border-accent/60 bg-accent/10 p-3 text-left' : 'min-w-0 rounded-btn border border-border/60 bg-elevated/35 p-3 text-left transition-colors hover:border-accent/40'}
                    aria-pressed={selectedItem?.symbol === item.symbol}
                  >
                    <div className="truncate text-[11px] text-muted">{item.name}</div>
                    <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground">{formatValue(row?.value ?? stats?.latest_values?.[item.symbol], item.unit)}</div>
                    <div className="mt-1 flex items-center justify-between gap-1 text-[10px] text-muted">
                      <span>{item.unit} · {frequencyLabel(item.frequency)}</span>
                      <span>{row?.date ?? stats?.latest_date ?? '—'}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </section>

        <section className="rounded-card border border-border bg-surface p-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">历史走势</h2>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {categoryItems.map(item => (
                  <button
                    key={item.symbol}
                    type="button"
                    onClick={() => setSelectedSymbol(item.symbol)}
                    className={selectedItem?.symbol === item.symbol ? 'rounded-btn bg-accent px-2.5 py-1 text-[11px] text-base' : 'rounded-btn bg-elevated px-2.5 py-1 text-[11px] text-secondary hover:text-foreground'}
                    aria-pressed={selectedItem?.symbol === item.symbol}
                  >
                    {item.symbol}
                  </button>
                ))}
              </div>
            </div>
            {selectedItem && <span className="text-[11px] text-muted">{selectedItem.unit} · {frequencyLabel(selectedItem.frequency)} · {sourceLabel(selectedItem.source)}</span>}
          </div>
          <div className="mt-4">
            {history.isLoading && <div className="grid h-52 place-items-center rounded-card bg-elevated/30 text-sm text-muted">历史数据加载中…</div>}
            {history.isError && <div className="grid h-52 place-items-center rounded-card bg-danger/5 text-sm text-danger">历史数据加载失败，请检查日期范围或数据源。</div>}
            {!history.isLoading && !history.isError && <CommodityChart rows={history.data?.items ?? []} item={selectedItem} />}
          </div>
        </section>

        <section className="rounded-card border border-border bg-surface p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">{selectedItem?.symbol ?? '商品'}明细</h2>
              <p className="mt-0.5 text-[11px] text-muted">按观测日期倒序，保留源数据原始频率</p>
            </div>
            <span className="text-[11px] text-muted">查询 {history.data?.count ?? 0} 条</span>
          </div>
          {(history.data?.items ?? []).length === 0 ? (
            <div className="rounded-card bg-elevated/30 px-4 py-8 text-center text-sm text-muted">暂无明细数据，请先同步当前日期范围。</div>
          ) : (
            <div className="max-h-[26rem] overflow-auto rounded-card border border-border/70">
              <table className="w-full min-w-[48rem] text-left text-xs">
                <thead className="sticky top-0 bg-elevated text-[10px] text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">日期</th>
                    <th className="px-3 py-2 font-medium">值</th>
                    <th className="px-3 py-2 font-medium">单位</th>
                    <th className="px-3 py-2 font-medium">频率</th>
                    <th className="px-3 py-2 font-medium">来源</th>
                    <th className="px-3 py-2 font-medium">抓取时间</th>
                  </tr>
                </thead>
                <tbody>
                  {(history.data?.items ?? []).slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 160).map(row => (
                    <tr key={row.symbol + '-' + row.date + '-' + row.source + '-' + row.retrieved_at} className="border-t border-border/60 hover:bg-elevated/30">
                      <td className="px-3 py-2 font-mono text-secondary">{row.date}</td>
                      <td className="px-3 py-2 font-mono tabular-nums text-foreground">{formatValue(row.value, row.unit)}</td>
                      <td className="px-3 py-2 text-secondary">{row.unit}</td>
                      <td className="px-3 py-2 text-secondary">{frequencyLabel(row.frequency)}</td>
                      <td className="px-3 py-2 text-secondary">{sourceLabel(row.source)}</td>
                      <td className="px-3 py-2 text-muted">{formatRetrievedAt(row.retrieved_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="rounded-card border border-border bg-surface p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">数据源状态</h2>
              <p className="mt-0.5 text-[11px] text-muted">贵金属不使用 EIA，WTI/Brent 不静默切换到其他源。</p>
            </div>
            <Link to="/settings?tab=data-sources" className="inline-flex items-center gap-1 text-xs text-accent hover:text-accent/80">
              配置 API Key <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {Object.values(sources).map(source => (
              <div key={source.name} className="flex items-center justify-between gap-3 rounded-btn border border-border/60 bg-elevated/30 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Database className="h-3.5 w-3.5 shrink-0 text-secondary" />
                  <span className="truncate text-xs text-foreground">{source.display_name}</span>
                </div>
                <span className={source.available ? 'shrink-0 text-[10px] text-bull' : 'shrink-0 text-[10px] text-warning'}>
                  {source.available ? '已就绪' : source.configured ? '不可用' : '未配置'}
                </span>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  )
}
