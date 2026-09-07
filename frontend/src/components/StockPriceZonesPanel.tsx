import { Check, ChevronDown, CircleHelp } from 'lucide-react'
import type { ChanlunAnalysis } from '@/lib/chanlun'
import { fmtAssetPrice, fmtPct } from '@/lib/format'
import type { PriceZone, PriceZoneSide } from '@/lib/priceZones'
import { zoneSourcesSummary } from '@/lib/priceZones'

interface Props {
  analysis: ChanlunAnalysis
  zones: PriceZone[]
  assetType?: 'stock' | 'etf' | 'index'
  collapsed?: boolean
  onToggleCollapsed?: () => void
  showZones?: boolean
  onToggleShowZones?: () => void
  selectedZoneId?: string | null
  onSelectZone?: (zone: PriceZone) => void
}

const PERIOD_LABELS: Record<ChanlunAnalysis['period'], string> = {
  '30m': '30F', '1d': '日K', '1w': '周K', '1mo': '月K',
}

function shortDate(value: string | null): string {
  return value ? value.slice(0, 16).replace('T', ' ') : '—'
}

function sideLabel(side: PriceZoneSide): string {
  return side === 'support' ? '支撑' : side === 'resistance' ? '压力' : '当前区间'
}

function sideTone(side: PriceZoneSide): string {
  return side === 'support' ? 'text-bull' : side === 'resistance' ? 'text-bear' : 'text-accent'
}

function ZoneCard({
  zone,
  rank,
  assetType,
  selected,
  onSelect,
}: {
  zone: PriceZone
  rank?: number
  assetType?: string
  selected: boolean
  onSelect?: () => void
}) {
  const label = zone.side === 'support' ? `S${rank}` : zone.side === 'resistance' ? `R${rank}` : '现价'
  const sourceCount = zone.sourceCount > 1 ? `多来源重合 ${zone.sourceCount}` : '单一依据'
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-card border p-2 text-left transition-colors ${selected ? 'border-accent/70 bg-accent/10' : 'border-border bg-surface/60 hover:bg-elevated'}`}
      aria-pressed={selected}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`text-[13px] font-medium ${sideTone(zone.side)}`}>{label} · {sideLabel(zone.side)}</span>
        <span className="font-mono text-[13px] tabular-nums text-foreground">
          {fmtAssetPrice(zone.low, assetType)}{zone.low !== zone.high ? ` ~ ${fmtAssetPrice(zone.high, assetType)}` : ''}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[12px] text-muted">
        <span className="min-w-0 truncate" title={zoneSourcesSummary(zone)}>{zoneSourcesSummary(zone)}</span>
        <span className="shrink-0">{sourceCount}</span>
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-2 text-[12px] text-muted">
        <span>距离 {zone.side === 'current' ? '当前价格' : fmtPct(zone.distancePct)}</span>
        <span>可知 {shortDate(zone.lastTouchTime)}</span>
      </div>
    </button>
  )
}

export function StockPriceZonesPanel({
  analysis,
  zones,
  assetType,
  collapsed = false,
  onToggleCollapsed,
  showZones = true,
  onToggleShowZones,
  selectedZoneId,
  onSelectZone,
}: Props) {
  const supports = zones.filter(zone => zone.side === 'support')
  const resistances = zones.filter(zone => zone.side === 'resistance')
  const current = zones.find(zone => zone.side === 'current')
  const atrNote = zones.length > 0 && !zones[0].atrAvailable
    ? 'ATR14 不可用，已降级为价格比例容差'
    : '区间容差：max(0.3 × ATR14，价格 × 0.3%)'

  return (
    <section className="border-b border-border/70">
      <div className={`flex items-start justify-between gap-2 px-2.5 py-2 ${collapsed ? '' : 'border-b border-border/70'}`}>
        <div className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#F97316]" />
            <span className="text-xs font-medium text-foreground">关键价位</span>
            <span className="rounded bg-[#F97316]/10 px-1.5 py-0.5 text-[12px] text-[#FB923C]">v1</span>
            <span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[12px] text-secondary">{PERIOD_LABELS[analysis.period]}</span>
          </span>
          {!collapsed && <span className="mt-0.5 block truncate text-[12px] text-muted" title={atrNote}>{atrNote}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onToggleShowZones && (
          <button
            type="button"
            onClick={onToggleShowZones}
            className={`flex shrink-0 items-center gap-1 rounded-btn px-1.5 py-1 text-[12px] ${showZones ? 'bg-accent/15 text-accent' : 'bg-elevated text-muted'}`}
            aria-pressed={showZones}
            title={showZones ? '隐藏关键价位带' : '显示关键价位带'}
          >
            {showZones ? <Check className="h-3 w-3" /> : <CircleHelp className="h-3 w-3" />}
            价位带
          </button>
          )}
          {onToggleCollapsed && <button type="button" onClick={onToggleCollapsed} className="rounded-btn p-1 text-muted transition-colors hover:bg-elevated hover:text-foreground" aria-expanded={!collapsed} aria-label={collapsed ? '展开关键价位' : '收起关键价位'} title={collapsed ? '展开关键价位' : '收起关键价位'}><ChevronDown className={`h-3.5 w-3.5 transition-transform ${collapsed ? '-rotate-90' : ''}`} /></button>}
        </div>
      </div>
      {!collapsed && (
        <div className="grid gap-2 p-2">
          {analysis.status !== 'ready' && (
            <div className="rounded-card border border-border bg-elevated/40 px-2 py-1.5 text-[12px] text-muted">
              {analysis.issues[0] ?? '结构数据不足，暂不生成可追溯价位。'}
            </div>
          )}
          {current && <ZoneCard zone={current} assetType={assetType} selected={selectedZoneId === current.id} onSelect={() => onSelectZone?.(current)} />}
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <div className="text-[12px] font-medium text-bull">支撑区 ↓</div>
              {supports.length > 0 ? supports.map((zone, index) => <ZoneCard key={zone.id} zone={zone} rank={index + 1} assetType={assetType} selected={selectedZoneId === zone.id} onSelect={() => onSelectZone?.(zone)} />) : <div className="rounded-card border border-border/60 px-2 py-2 text-[12px] text-muted">当前价格下方暂无可用区间</div>}
            </div>
            <div className="grid gap-1.5">
              <div className="text-[12px] font-medium text-bear">压力区 ↑</div>
              {resistances.length > 0 ? resistances.map((zone, index) => <ZoneCard key={zone.id} zone={zone} rank={index + 1} assetType={assetType} selected={selectedZoneId === zone.id} onSelect={() => onSelectZone?.(zone)} />) : <div className="rounded-card border border-border/60 px-2 py-2 text-[12px] text-muted">当前价格上方暂无可用区间</div>}
            </div>
          </div>
          <div className="text-[12px] text-muted">来源只使用当前周期已确认分型、笔／线段端点、中枢边界和 MA20/MA60；结果按当前数据版本回看。</div>
        </div>
      )}
    </section>
  )
}
