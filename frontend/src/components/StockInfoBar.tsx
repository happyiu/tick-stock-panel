import { Plus, RadioTower, Star, ExternalLink } from 'lucide-react'
import type { KlinePeriod, KlineRow } from '@/lib/api'
import { fmtAssetPrice, fmtPrice } from '@/lib/format'
import { WatchlistAddMenu } from '@/components/WatchlistAddMenu'
import { buildStockExternalUrl, loadStockExternalTemplate } from '@/lib/stock-external-link'

const BULL = '#C74040'
const BEAR = '#2D9B65'

interface Props {
  symbol: string
  name?: string
  stockInfo?: { name?: string; total_shares?: number; float_shares?: number; ext?: Record<string, unknown> }
  rows: KlineRow[]
  assetType?: string
  period?: KlinePeriod
  onAddStrategy?: (assetType: 'stock' | 'etf', period: KlinePeriod) => void
  onAddSignal?: (assetType: 'stock' | 'etf', period: KlinePeriod) => void
  /** 加监控回调 (个股弹窗传入, 有值时渲染 RadioTower 图标) */
  onMonitor?: () => void
  /** 自选状态与操作（传入对应回调时渲染 Star 图标） */
  inWatchlist?: boolean
  onAddToWatchlist?: (groupId: string | null) => void
  onRemoveFromWatchlist?: () => void
  watchlistPending?: boolean
}

export function StockInfoBar({
  symbol,
  name,
  stockInfo,
  rows,
  assetType,
  period,
  onAddStrategy,
  onAddSignal,
  onMonitor,
  inWatchlist,
  onAddToWatchlist,
  onRemoveFromWatchlist,
  watchlistPending,
}: Props) {
  // 无数据时保持信息条挂载 (切股/首次加载): 只留 symbol+名称+小 spinner 作为加载态,
  // 不渲染假占位值; 数据到位后价格原位填充, 避免整行消失造成布局跳动。
  if (rows.length === 0) {
    return (
      <div className="px-2 pb-3 font-mono text-[12px] select-none space-y-1">
        {/* 首行 min-h-7 对齐完整态的 text-lg 价格行高, 加载中不整体变矮 */}
        <div className="flex min-h-7 items-baseline gap-x-3 flex-wrap">
          <span className="text-foreground font-bold text-sm tracking-wide">{symbol}</span>
          {name && <span className="text-secondary font-medium">{name}</span>}
          <span className="ml-auto self-center text-muted">
            <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
          </span>
        </div>
      </div>
    )
  }

  const latest = rows[rows.length - 1]
  const prev = rows.length >= 2 ? rows[rows.length - 2] : null
  const close = Number(latest.close)
  const chg = prev ? close - Number(prev.close) : 0
  const chgPct = prev ? chg / Number(prev.close) * 100 : 0
  const isUp = chg >= 0
  const clr = isUp ? BULL : BEAR

  const displayName = stockInfo?.name ?? name ?? ''
  const extUrl = buildStockExternalUrl(loadStockExternalTemplate(), symbol)
  const chartAssetType = assetType === 'stock' || assetType === 'etf' ? assetType : undefined
  const canAddStrategy = Boolean(chartAssetType && period && onAddStrategy)
  const canAddSignal = Boolean(chartAssetType && period && onAddSignal)

  return (
    <div className="px-2 pb-3 font-mono text-[12px] select-none space-y-1">
      {/* Row 1: code, name, price, change, change% */}
      <div className="flex items-baseline gap-x-3 flex-wrap">
        <span className="text-foreground font-bold text-sm tracking-wide">{symbol}</span>
        <span className="text-secondary font-medium">{displayName}</span>
        <span style={{ color: clr }} className="text-lg font-bold tabular-nums">
          {fmtAssetPrice(close, assetType)}
        </span>
        <span style={{ color: clr }} className="tabular-nums">
          {isUp ? '+' : ''}{fmtAssetPrice(chg, assetType)}
        </span>
        <span style={{ color: clr }} className="tabular-nums">
          {isUp ? '+' : ''}{fmtPrice(chgPct)}%
        </span>
        {/* 右侧操作按钮：策略/信号 + 外链 + 加自选 + 加监控 */}
        <div className="ml-auto self-center flex shrink-0 items-center gap-1">
          {canAddStrategy && (
            <button
              type="button"
              onClick={() => onAddStrategy?.(chartAssetType!, period!)}
              title={`添加${chartAssetType === 'etf' ? ' ETF' : '股票'}策略`}
              aria-label={`添加${chartAssetType === 'etf' ? ' ETF' : '股票'}策略`}
              className="inline-flex shrink-0 items-center gap-1 rounded border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent transition-colors hover:border-accent/50 hover:bg-accent/15"
            >
              <Plus className="h-3 w-3" />
              <span>添加策略</span>
            </button>
          )}
          {canAddSignal && (
            <button
              type="button"
              onClick={() => onAddSignal?.(chartAssetType!, period!)}
              title="添加信号到当前 K 线"
              aria-label="添加信号到当前 K 线"
              className="inline-flex shrink-0 items-center gap-1 rounded border border-cyan-400/30 bg-cyan-400/10 px-2 py-0.5 text-[10px] font-medium text-cyan-300 transition-colors hover:border-cyan-400/50 hover:bg-cyan-400/15"
            >
              <Plus className="h-3 w-3" />
              <span>添加信号</span>
            </button>
          )}
          {extUrl && (
            <a
              href={extUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={extUrl}
              className="p-1 rounded-btn text-muted hover:text-foreground hover:bg-elevated transition-colors"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
          {inWatchlist && onRemoveFromWatchlist ? (
            <button
              type="button"
              onClick={onRemoveFromWatchlist}
              disabled={watchlistPending}
              className="rounded-btn p-1 text-[#FACC15] transition-colors cursor-pointer hover:bg-elevated disabled:opacity-50"
              title="移出自选"
              aria-label={`将 ${symbol} 移出自选`}
            >
              <Star className="h-3.5 w-3.5" />
            </button>
          ) : !inWatchlist && onAddToWatchlist ? (
            <WatchlistAddMenu
              onSelect={onAddToWatchlist}
              disabled={watchlistPending}
              triggerClassName="rounded-btn p-1 text-muted transition-colors cursor-pointer hover:bg-elevated hover:text-foreground disabled:opacity-50"
              ariaLabel={`将 ${symbol} 加入自选`}
            >
              <Star className="h-3.5 w-3.5" />
            </WatchlistAddMenu>
          ) : null}
          {onMonitor && (
            <button
              onClick={onMonitor}
              className="p-1 rounded-btn text-amber-400 hover:bg-amber-400/10 transition-colors cursor-pointer"
              title="加监控"
            >
              <RadioTower className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
