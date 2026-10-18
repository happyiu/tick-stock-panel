import { useState } from 'react'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { fmtAssetPrice, fmtPct, priceColorClass } from '@/lib/format'
import { cn } from '@/lib/cn'

export interface PreviewWatchlistRow {
  symbol: string
  name?: string | null
  rt_name?: string | null
  asset_type?: string
  close?: number | null
  change_pct?: number | null
  rt_price?: number | null
  rt_pct?: number | null
}

export function StockPreviewWatchlist({ rows, symbol, onNavigate, disabled }: {
  rows: PreviewWatchlistRow[]
  symbol: string
  onNavigate?: (symbol: string, name?: string) => void
  disabled?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const label = expanded ? '收起自选列表' : '展开自选列表'
  return (
    <div className={cn('relative shrink-0', expanded && 'w-36 border-r border-border sm:w-44')}>
      {expanded && (
        <aside aria-label="详情自选列表" className="h-full min-h-0 overflow-y-auto">
          <div className="sticky top-0 bg-surface px-2 py-2 text-xs font-medium text-secondary">自选列表 · {rows.length}</div>
          {rows.length === 0 && <p className="px-2 py-3 text-xs text-muted">当前自选列表为空</p>}
          {rows.map(row => {
            const name = row.rt_name ?? row.name ?? undefined
            const pct = row.rt_pct ?? row.change_pct
            return (
              <button
                key={row.symbol}
                type="button"
                aria-label={`查看 ${name ?? row.symbol} ${row.symbol}`}
                aria-current={row.symbol === symbol}
                disabled={disabled || !onNavigate}
                onClick={() => onNavigate?.(row.symbol, name)}
                className={cn('mb-1 block w-full rounded-btn border-b border-border last:border-b-0 px-2 py-2 text-left transition-colors hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-50', row.symbol === symbol && 'bg-accent/10 ring-1 ring-inset ring-accent/30')}
              >
                <div className="truncate text-xs font-medium text-foreground" title={name}>{name ?? '—'}</div>
                <div className="mt-1 font-mono text-[11px] text-muted">{row.symbol}</div>
                <div className={cn('mt-1 flex justify-between gap-1 font-mono text-[11px] tabular-nums', priceColorClass(pct))}>
                  <span>{fmtAssetPrice(row.rt_price ?? row.close, row.asset_type)}</span>
                  <span>{fmtPct(pct)}</span>
                </div>
              </button>
            )
          })}
        </aside>
      )}
      <button
        type="button"
        onClick={() => setExpanded(value => !value)}
        title={label}
        aria-label={label}
        aria-expanded={expanded}
        className="absolute right-0 top-1/2 z-20 flex h-7 w-7 translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-surface text-muted shadow-sm transition-colors hover:bg-elevated hover:text-foreground"
      >
        {expanded ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelLeftOpen className="h-3.5 w-3.5" />}
      </button>
    </div>
  )
}
