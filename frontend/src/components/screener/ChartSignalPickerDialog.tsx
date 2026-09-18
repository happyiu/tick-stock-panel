import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, Check, Loader2, PenLine, Search, X } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { api, type KlinePeriod } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import {
  BUILTIN_SIGNAL_DEFINITIONS,
  type ChartSignalSelection,
  type SignalKind,
} from '@/lib/signals'

const DAILY_ONLY_SIGNAL_IDS = new Set([
  'signal_limit_up',
  'signal_limit_down',
  'signal_limit_down_recovery',
  'signal_broken_limit_up',
  'signal_n_day_high',
  'signal_n_day_low',
])
const MAX_SELECTED_SIGNALS = 32

const PERIOD_LABEL: Record<KlinePeriod, string> = {
  '30m': '30F',
  '1d': '日线',
  '1w': '周线',
  '1mo': '月线',
}

const KIND_META: Record<SignalKind, { label: string; className: string }> = {
  entry: { label: '入场', className: 'border-cyan-400/25 bg-cyan-400/10 text-cyan-300' },
  exit: { label: '出场', className: 'border-rose-400/25 bg-rose-400/10 text-rose-300' },
  both: { label: '出入', className: 'border-violet-400/25 bg-violet-400/10 text-violet-300' },
}

interface SignalOption extends ChartSignalSelection {
  category: string
  description: string
  custom?: boolean
}

interface Props {
  open: boolean
  period: KlinePeriod
  selected: ChartSignalSelection[]
  onClose: () => void
  onApply: (signals: ChartSignalSelection[]) => void
}

export function ChartSignalPickerDialog({ open, period, selected, onClose, onApply }: Props) {
  const [search, setSearch] = useState('')
  const [scope, setScope] = useState<'selected' | 'all'>('all')
  const [draft, setDraft] = useState<ChartSignalSelection[]>(() => selected.map(item => ({ ...item })))
  const customSignalsQuery = useQuery({
    queryKey: QK.customSignals,
    queryFn: () => api.customSignalsList(),
    enabled: open,
  })

  const builtinOptions = useMemo<SignalOption[]>(() => (
    BUILTIN_SIGNAL_DEFINITIONS
      .filter(signal => period === '1d' || !DAILY_ONLY_SIGNAL_IDS.has(signal.id))
      .map(signal => ({ ...signal }))
  ), [period])

  const customOptions = useMemo<SignalOption[]>(() => {
    return (customSignalsQuery.data?.signals ?? [])
      .filter(signal => signal.enabled && (signal.timeframe ?? 'daily') === 'daily')
      .map(signal => ({
        id: `csg_${signal.id}`,
        name: signal.name,
        kind: signal.kind,
        category: '自定义',
        description: '来自信号库的自定义条件信号，按当前 K 线周期计算。',
        custom: true,
      }))
  }, [customSignalsQuery.data?.signals])

  const selectedIds = useMemo(() => new Set(draft.map(signal => signal.id)), [draft])
  const groups = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase()
    const grouped = new Map<string, SignalOption[]>()
    for (const option of [...builtinOptions, ...customOptions]) {
      if (scope === 'selected' && !selectedIds.has(option.id)) continue
      if (normalizedSearch && ![option.id, option.name, option.category, option.description]
        .some(value => value.toLowerCase().includes(normalizedSearch))) {
        continue
      }
      const group = grouped.get(option.category) ?? []
      group.push(option)
      grouped.set(option.category, group)
    }
    return [...grouped.entries()]
  }, [builtinOptions, customOptions, scope, search, selectedIds])

  if (!open) return null

  const toggle = (option: SignalOption) => {
    setDraft(current => {
      if (current.some(signal => signal.id === option.id)) {
        return current.filter(signal => signal.id !== option.id)
      }
      if (current.length >= MAX_SELECTED_SIGNALS) return current
      return [...current, { id: option.id, name: option.name, kind: option.kind }]
    })
  }

  return (
    <Modal
      onClose={onClose}
      labelledBy="chart-signal-picker-title"
      overlayClassName="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-3 backdrop-blur-sm sm:p-4"
      panelClassName="flex max-h-[82vh] w-[min(92vw,760px)] flex-col overflow-hidden rounded-card border border-border bg-surface shadow-2xl"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-btn border border-cyan-400/25 bg-cyan-400/10 text-cyan-300">
            <Activity className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 id="chart-signal-picker-title" className="text-sm font-medium text-foreground">添加信号</h2>
            <p className="mt-0.5 truncate text-[10px] text-muted">选择信号库中的信号叠加到当前 K 线，可多选</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-btn p-1 text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label="关闭信号选择"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/70 bg-elevated/30 px-4 py-2.5">
        <span className="text-[10px] text-muted">当前 K 线</span>
        <span className="rounded border border-cyan-400/25 bg-cyan-400/10 px-1.5 py-0.5 text-[10px] font-medium text-cyan-300">
          {PERIOD_LABEL[period]}
        </span>
        <span className="text-[10px] text-muted">
          {period === '1d' ? '显示全部内置信号和已启用的自定义信号' : '显示当前周期可计算的通用技术信号和自定义信号'}
        </span>
        <div className="flex shrink-0 items-center gap-0.5 rounded border border-border bg-base p-0.5" role="group" aria-label="信号筛选">
          {(['selected', 'all'] as const).map(value => (
            <button
              key={value}
              type="button"
              aria-pressed={scope === value}
              onClick={() => setScope(value)}
              className={`rounded px-2 py-0.5 text-[10px] transition-colors ${scope === value
                ? 'bg-cyan-400/15 text-cyan-300'
                : 'text-muted hover:text-secondary'}`}
            >
              {value === 'selected' ? `已选择${draft.length > 0 ? ` (${draft.length})` : ''}` : '全部'}
            </button>
          ))}
        </div>
        <label className="relative ml-auto flex min-w-[150px] items-center">
          <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-muted/60" />
          <input
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="搜索信号"
            aria-label="搜索信号"
            className="h-7 w-full rounded-btn border border-border bg-base pl-7 pr-2 text-[11px] text-foreground outline-none placeholder:text-muted/50 focus:border-cyan-400/50"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {groups.length === 0 ? (
          <div className="flex min-h-32 items-center justify-center rounded-btn border border-dashed border-border px-4 text-center text-xs text-muted">
            {search.trim() ? '没有匹配的信号' : '暂无可用信号'}
          </div>
        ) : (
          <div className="space-y-4">
            {groups.map(([category, options]) => (
              <section key={category}>
                <h3 className="mb-2 flex items-center gap-2 px-1 text-[10px] font-medium text-secondary">
                  {category}
                  <span className="text-muted/50">{options.length}</span>
                </h3>
                <div className="grid gap-2 sm:grid-cols-2">
                  {options.map(option => {
                    const isSelected = selectedIds.has(option.id)
                    const kind = KIND_META[option.kind]
                    return (
                      <button
                        key={option.id}
                        type="button"
                        role="checkbox"
                        aria-checked={isSelected}
                        onClick={() => toggle(option)}
                        className={`group rounded-btn border p-2.5 text-left transition-colors ${
                          isSelected
                            ? 'border-cyan-400/45 bg-cyan-400/[0.07]'
                            : 'border-border bg-base hover:border-cyan-400/35 hover:bg-cyan-400/[0.03]'
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${isSelected ? 'border-cyan-400 bg-cyan-400 text-slate-950' : 'border-border bg-elevated text-transparent'}`}>
                            <Check className="h-3 w-3" strokeWidth={3} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              {option.custom && <PenLine className="h-3 w-3 shrink-0 text-amber-400" />}
                              <span className="truncate text-xs font-medium text-foreground group-hover:text-cyan-300">{option.name}</span>
                              <span className={`shrink-0 rounded border px-1 py-0.5 text-[9px] ${kind.className}`}>{kind.label}</span>
                            </span>
                            <span className="mt-1 block line-clamp-2 text-[10px] leading-relaxed text-muted">{option.description}</span>
                            <span className="mt-1 block truncate font-mono text-[9px] text-muted/50">{option.id}</span>
                          </span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
        {customSignalsQuery.isLoading && (
          <div className="mt-3 flex items-center gap-2 px-1 text-[10px] text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            加载自定义信号…
          </div>
        )}
        {customSignalsQuery.isError && (
          <p className="mt-3 px-1 text-[10px] text-danger">自定义信号加载失败，内置信号仍可使用。</p>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-2.5">
        <span className="truncate text-[10px] text-muted">
          已选 {draft.length}/{MAX_SELECTED_SIGNALS} 个信号；策略和信号会同时叠加显示
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-btn border border-border px-3 py-1 text-xs text-secondary transition-colors hover:border-border/80 hover:text-foreground"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onApply(draft)}
            className="rounded-btn border border-cyan-400/35 bg-cyan-400/10 px-3 py-1 text-xs font-medium text-cyan-300 transition-colors hover:border-cyan-400/60 hover:bg-cyan-400/15"
          >
            应用{draft.length > 0 ? ` (${draft.length})` : ''}
          </button>
        </div>
      </div>
    </Modal>
  )
}
