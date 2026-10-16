import { useId, useState } from 'react'
import { Check, SlidersHorizontal, X } from 'lucide-react'
import { OVERLAY_INDICATORS, SUB_CHARTS } from '@/lib/kline-chart'

export function ChartIndicatorMenu({ activeIndicators, onToggle }: {
  activeIndicators: string[]
  onToggle: (key: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [category, setCategory] = useState<'main' | 'sub'>('main')
  const id = useId()
  const indicators = category === 'main' ? OVERLAY_INDICATORS : SUB_CHARTS
  return (
    <div className="relative shrink-0" onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
    }} onKeyDown={event => {
      if (event.key === 'Escape') {
        setOpen(false)
        event.currentTarget.querySelector('button')?.focus()
      }
    }}>
      <button
        type="button" aria-expanded={open} aria-controls={id}
        onClick={() => setOpen(value => !value)}
        className={`flex h-6 items-center gap-1 rounded-md border px-2 text-[10px] font-medium transition-colors ${open ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border/30 bg-base/40 text-muted hover:border-border/60 hover:text-foreground'}`}
      >
        <SlidersHorizontal className="h-3 w-3" />指标
      </button>
      {open && (
        <div id={id} role="dialog" aria-label="K线指标" className="absolute left-0 top-full z-40 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-card border border-border bg-surface p-2 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <span className="px-1 text-xs font-medium text-foreground">指标</span>
            <button type="button" aria-label="关闭指标" onClick={() => setOpen(false)} className="rounded p-1 text-muted hover:bg-elevated hover:text-foreground">
              <X className="h-3 w-3" />
            </button>
          </div>
          <div role="tablist" aria-label="指标类型" className="mb-1 flex rounded bg-base p-0.5">
            {([['main', '主图叠加'], ['sub', '副图']] as const).map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={category === key}
                onClick={() => setCategory(key)}
                className={`flex-1 rounded px-2 py-1.5 text-xs ${category === key ? 'bg-elevated text-accent' : 'text-muted hover:text-secondary'}`}
              >{label}</button>
            ))}
          </div>
          <div role="tabpanel" aria-label={category === 'main' ? '主图叠加' : '副图'} className="max-h-60 overflow-y-auto">
            {indicators.map(indicator => {
              const active = activeIndicators.includes(indicator.key)
              return (
                <button key={indicator.key} type="button" role="checkbox" aria-label={indicator.label} aria-checked={active}
                  onClick={() => onToggle(indicator.key)}
                  className="flex w-full items-center gap-2 rounded-btn px-2 py-2 text-left text-xs text-secondary transition-colors hover:bg-elevated hover:text-foreground"
                >
                  <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${active ? 'border-accent bg-accent' : 'border-border bg-base'}`}>
                    {active && <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />}
                  </span>
                  <span>{indicator.label}{indicator.key === 'angel-devil' && (
                    <span className="mt-0.5 block text-[10px] text-muted">MA5 / 13 / 21 / 34 · 进攻 / 撤退</span>
                  )}{indicator.key === 'boll2' && (
                    <span className="mt-0.5 block text-[10px] text-muted">20周期 · 自定义通道 · 延后1根K线</span>
                  )}{indicator.key === 'kd-divergence' && (
                    <span className="mt-0.5 block text-[10px] text-muted">9 / 3 / 3 · 背离出现后补画连线</span>
                  )}{indicator.key === 'kd-enhanced' && (
                    <span className="mt-0.5 block text-[10px] text-muted">分型延后2根确认 · 趋势过滤</span>
                  )}{indicator.key === 'etf-swing-v2' && (
                    <span className="mt-0.5 block text-[10px] text-muted">建议30分钟 · 66根起标信号 · 未收盘信号可能变化</span>
                  )}{indicator.key === 'bull-bear-trend-v2' && (
                    <span className="mt-0.5 block text-[10px] text-muted">30分钟 / 日线自适应 · 81根起标信号 · 未收盘信号可能变化</span>
                  )}</span>
                </button>
              )
            })}
          </div>
          {category === 'main' && <p className="mt-1 border-t border-border px-2 pt-2 text-[10px] leading-relaxed text-muted">
            天使魔鬼启用后替换默认均线，K线颜色表示多空状态。未收盘K线上的信号可能变化。
          </p>}
        </div>
      )}
    </div>
  )
}
