import { useId, useState } from 'react'
import { Bell, Check, SlidersHorizontal, X } from 'lucide-react'
import { useChartIndicators } from '@/lib/useChartIndicators'
import type { IndicatorMonitorInput, IndicatorMonitorRule } from '@/lib/api'
import { IndicatorMonitorEditor, useIndicatorMonitors } from './monitor/IndicatorMonitorEditor'

export function ChartIndicatorMenu({ activeIndicators, onToggle, allowMA = true, monitorContext }: {
  activeIndicators: string[]
  allowMA?: boolean
  onToggle: (key: string) => void
  monitorContext?: Pick<IndicatorMonitorInput, 'symbol' | 'asset_type' | 'period' | 'compare_days'>
}) {
  const catalog = useChartIndicators()
  const [open, setOpen] = useState(false)
  const [source, setSource] = useState<'custom' | 'builtin'>('custom')
  const [category, setCategory] = useState<'main' | 'sub'>('main')
  const id = useId()
  const monitors = useIndicatorMonitors(Boolean(monitorContext))
  const [editor, setEditor] = useState<{ rule?: IndicatorMonitorRule; preset?: Partial<IndicatorMonitorInput> } | null>(null)
  const indicators = (category === 'main' ? catalog.main : catalog.sub)
    .filter(indicator => (allowMA || indicator.key !== 'ma') && indicator.source === source)
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
        onClick={() => {
          if (!open) setSource('custom')
          setOpen(value => !value)
        }}
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
          <div role="tablist" aria-label="指标来源" className="mb-2 flex rounded bg-base p-0.5">
            {([['custom', '自建'], ['builtin', '内置']] as const).map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={source === key}
                onClick={() => setSource(key)}
                className={`flex-1 rounded px-2 py-1.5 text-xs ${source === key ? 'bg-elevated text-accent' : 'text-muted hover:text-secondary'}`}
              >{label}</button>
            ))}
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
            {catalog.isLoading && <p className="p-2 text-xs text-muted">加载指标…</p>}
            {catalog.isError && <button className="p-2 text-xs text-danger" onClick={() => catalog.refetch()}>加载失败，重试</button>}
            {indicators.map(indicator => {
              const active = activeIndicators.includes(indicator.key)
              return (
                <div key={indicator.key} className="flex items-center"><button type="button" role="checkbox" aria-label={indicator.label} aria-checked={active}
                  onClick={() => onToggle(indicator.key)}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-btn px-2 py-2 text-left text-xs text-secondary transition-colors hover:bg-elevated hover:text-foreground"
                >
                  <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${active ? 'border-accent bg-accent' : 'border-border bg-base'}`}>
                    {active && <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />}
                  </span>
                  <span>{indicator.label}{indicator.description && <span className="mt-0.5 block text-[10px] text-muted">{indicator.description}</span>}</span>
                </button>{monitorContext && indicator.source === 'custom' && (() => {
                  const rule = monitors.data?.items.find(r => r.symbol === monitorContext.symbol && r.indicator_id === indicator.key && r.period === monitorContext.period)
                  return <button type="button" disabled={monitors.isLoading || monitors.isError} aria-label={`${rule ? '编辑监控' : '添加监控'}${indicator.label}`} title={monitors.isError ? '监控加载失败，请重开菜单重试' : rule ? '已监控 · 编辑' : '添加指标监控'} className={`shrink-0 rounded p-2 ${rule ? 'text-accent' : 'text-muted'} hover:bg-elevated disabled:opacity-40`} onClick={() => {
                    setOpen(false)
                    setEditor({ rule, preset: { ...monitorContext, indicator_id: indicator.key } })
                  }}><Bell className="h-3.5 w-3.5" /></button>
                })()}</div>
              )
            })}
          </div>
        </div>
      )}
      {editor && <IndicatorMonitorEditor rule={editor.rule} preset={editor.preset} onClose={() => setEditor(null)} />}
    </div>
  )
}
