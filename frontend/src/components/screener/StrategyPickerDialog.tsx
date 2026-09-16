import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Layers, Loader2, Search, X } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { api, type KlinePeriod, type StrategyDetail, type StrategyTimeframe } from '@/lib/api'
import { QK } from '@/lib/queryKeys'

type StrategyAssetType = 'stock' | 'etf'

const ASSET_TYPE_LABEL: Record<StrategyAssetType, string> = {
  stock: '股票',
  etf: 'ETF',
}

const PERIOD_LABEL: Record<KlinePeriod, string> = {
  '30m': '30F',
  '1d': '日线',
  '1w': '周线',
  '1mo': '月线',
}

const SOURCE_META: Record<string, { label: string; className: string }> = {
  builtin: { label: '内置', className: 'border-accent/25 bg-accent/10 text-accent' },
  custom: { label: '自定义', className: 'border-amber-400/25 bg-amber-400/10 text-amber-400' },
  ai: { label: 'AI', className: 'border-purple-400/25 bg-purple-400/10 text-purple-400' },
  composite: { label: '叠加', className: 'border-teal-400/25 bg-teal-400/10 text-teal-400' },
}

/** K 线周期与策略执行周期保持一一对应；月线目前没有策略执行契约。 */
export function strategyTimeframeForPeriod(period: KlinePeriod): StrategyTimeframe | null {
  return period === '1mo' ? null : period
}

interface Props {
  open: boolean
  assetType: StrategyAssetType
  period: KlinePeriod
  onClose: () => void
  onSelect: (strategy: StrategyDetail) => void
}

export function StrategyPickerDialog({ open, assetType, period, onClose, onSelect }: Props) {
  const [search, setSearch] = useState('')
  const timeframe = strategyTimeframeForPeriod(period)
  const queryTimeframe = timeframe ?? 'all'
  const strategiesQuery = useQuery({
    queryKey: QK.screenerStrategies(assetType, queryTimeframe),
    queryFn: () => api.screenerStrategies(assetType, queryTimeframe),
    enabled: open && timeframe != null,
  })

  const strategies = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase()
    return (strategiesQuery.data?.presets ?? [])
      // 后端已按资产/周期过滤；客户端再校验一次，避免旧服务或缓存返回错误上下文。
      .filter(strategy => !strategy.research_only)
      .filter(strategy => strategy.asset_types.includes(assetType))
      .filter(strategy => timeframe == null || strategy.timeframes.includes(timeframe))
      .filter(strategy => {
        if (!normalizedSearch) return true
        return [strategy.name, strategy.description, strategy.id].some(value => (
          value.toLowerCase().includes(normalizedSearch)
        ))
      })
  }, [assetType, search, strategiesQuery.data?.presets, timeframe])

  if (!open) return null

  const assetLabel = ASSET_TYPE_LABEL[assetType]
  const periodLabel = PERIOD_LABEL[period]

  return (
    <Modal
      onClose={onClose}
      labelledBy="strategy-picker-title"
      overlayClassName="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-3 backdrop-blur-sm sm:p-4"
      panelClassName="flex max-h-[78vh] w-[min(92vw,720px)] flex-col overflow-hidden rounded-card border border-border bg-surface shadow-2xl"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Layers className="h-4 w-4 shrink-0 text-accent" />
          <div className="min-w-0">
            <h2 id="strategy-picker-title" className="text-sm font-medium text-foreground">添加策略</h2>
            <p className="mt-0.5 truncate text-[10px] text-muted">选择应用到当前 K 线的策略</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-btn p-1 text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label="关闭策略选择"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/70 bg-elevated/30 px-4 py-2.5">
        <span className="text-[10px] text-muted">当前 K 线</span>
        <span className="rounded border border-accent/25 bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
          {assetLabel}
        </span>
        <span className="text-[10px] text-muted/50">·</span>
        <span className="rounded border border-border bg-base px-1.5 py-0.5 text-[10px] text-secondary">
          {periodLabel}
        </span>
        <span className="text-[10px] text-muted">仅显示匹配当前资产和周期的策略</span>
        <label className="relative ml-auto flex min-w-[150px] items-center">
          <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-muted/60" />
          <input
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="搜索策略"
            aria-label="搜索策略"
            className="h-7 w-full rounded-btn border border-border bg-base pl-7 pr-2 text-[11px] text-foreground outline-none placeholder:text-muted/50 focus:border-accent/50"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {timeframe == null ? (
          <div className="flex min-h-32 items-center justify-center rounded-btn border border-dashed border-border px-4 text-center text-xs text-muted">
            月 K 暂无可直接加载的策略
          </div>
        ) : strategiesQuery.isLoading ? (
          <div className="flex min-h-32 items-center justify-center gap-2 text-xs text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            加载{assetLabel}策略…
          </div>
        ) : strategiesQuery.isError ? (
          <div className="flex min-h-32 flex-col items-center justify-center gap-2 text-center">
            <span className="text-xs text-danger">策略列表加载失败</span>
            <button
              type="button"
              onClick={() => void strategiesQuery.refetch()}
              className="rounded-btn border border-border px-2.5 py-1 text-[11px] text-secondary transition-colors hover:border-accent/40 hover:text-accent"
            >
              重试
            </button>
          </div>
        ) : strategies.length === 0 ? (
          <div className="flex min-h-32 items-center justify-center rounded-btn border border-dashed border-border px-4 text-center text-xs text-muted">
            {search.trim() ? '没有匹配的策略' : `暂无适用于${assetLabel} · ${periodLabel}的策略`}
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {strategies.map(strategy => {
              const source = SOURCE_META[strategy.source] ?? SOURCE_META.builtin
              return (
                <button
                  key={strategy.id}
                  type="button"
                  onClick={() => onSelect(strategy)}
                  className="group rounded-btn border border-border bg-base p-3 text-left transition-colors hover:border-accent/45 hover:bg-accent/[0.04]"
                >
                  <div className="flex items-start gap-2">
                    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-medium ${source.className}`}>
                      {source.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground group-hover:text-accent">
                      {strategy.name}
                    </span>
                  </div>
                  <p className="mt-1.5 line-clamp-2 min-h-8 text-[10px] leading-relaxed text-muted">
                    {strategy.description || '暂无策略说明'}
                  </p>
                  <div className="mt-2 flex items-center justify-between gap-2 text-[9px] text-muted/60">
                    <span className="truncate font-mono">{strategy.id}</span>
                    <span className="shrink-0">{periodLabel}</span>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-2.5">
        <span className="truncate text-[10px] text-muted">已按当前资产类型与 K 线周期筛选策略</span>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-btn border border-border px-3 py-1 text-xs text-secondary transition-colors hover:border-border/80 hover:text-foreground"
        >
          取消
        </button>
      </div>
    </Modal>
  )
}
