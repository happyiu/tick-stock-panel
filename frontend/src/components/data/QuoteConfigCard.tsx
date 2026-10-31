import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Activity, Settings } from 'lucide-react'
import { Skeleton } from './Skeleton'

interface ScopeConfig {
  intervalS: number
  intervalMin: number
  intervalMax: number
  lastFetchMs: number | null
  onIntervalChange: (value: number) => Promise<unknown>
}

interface QuoteConfigProps extends ScopeConfig {
  enabled: boolean
  running: boolean
  isTrading: boolean
  loading: boolean
  onToggle: (enabled: boolean) => void
  toggling: boolean
  showIntervalEdit: boolean
  onShowIntervalEdit: () => void
  etfWatchlist: ScopeConfig
  etfPool: ScopeConfig & { enabled: boolean; toggling: boolean; onToggle: (enabled: boolean) => void }
}

export function QuoteConfigCard(props: QuoteConfigProps) {
  const { enabled, running, isTrading, loading, toggling, showIntervalEdit, onShowIntervalEdit } = props
  const [editing, setEditing] = useState<string | null>(null)
  const groups = [
    { id: 'stock', label: '股票', ...props },
    { id: 'etf_watchlist', label: '自选 ETF', ...props.etfWatchlist },
    { id: 'etf_pool', label: 'ETF 池', ...props.etfPool },
  ]
  const statusColor = running && isTrading ? 'bg-accent' : enabled && running ? 'bg-warning/60' : 'bg-muted'
  const statusText = !enabled ? '已关闭' : !isTrading ? '非交易时段' : running ? '行情运行中' : '已停止'

  return (
    <div className="rounded-card border border-border bg-surface p-4 relative">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-secondary" />
          <h3 className="text-sm font-medium text-foreground">实时行情</h3>
        </div>
        <button
          aria-label="实时行情" role="switch" aria-checked={enabled}
          onClick={() => props.onToggle(!enabled)} disabled={toggling}
          className={'relative inline-flex h-4 w-7 items-center rounded-full shrink-0 transition-colors ' + (enabled ? 'bg-accent' : 'bg-elevated') + (toggling ? ' opacity-50' : '')}
        >
          <span className={'inline-block h-3 w-3 rounded-full bg-white shadow-sm transition-transform ' + (enabled ? 'translate-x-[14px]' : 'translate-x-0.5')} />
        </button>
      </div>
      {loading ? (
        <div className="space-y-2"><Skeleton w="w-16" /><Skeleton w="w-20" /></div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted">状态</span>
            <div className="flex items-center gap-1.5">
              <span className={'inline-block h-1.5 w-1.5 rounded-full ' + statusColor} />
              <span className="font-mono text-secondary">{statusText}</span>
            </div>
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted">交易时段</span>
            <span className="font-mono text-secondary">{isTrading ? '交易中' : '休市'}</span>
          </div>
          {groups.map(group => {
            const open = (showIntervalEdit ? 'stock' : editing) === group.id
            const lastFetch = group.lastFetchMs ? new Date(group.lastFetchMs).toLocaleString('zh-CN', {
              month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
            }) : '—'
            return (
              <section key={group.id} aria-label={group.label} className="space-y-1.5 border-t border-border/50 pt-2.5 mt-2.5">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-medium text-foreground">{group.label}</div>
                  {group.id === 'etf_pool' && <button
                    aria-label="ETF 池行情" role="switch" aria-checked={props.etfPool.enabled}
                    disabled={props.etfPool.toggling}
                    onClick={() => props.etfPool.onToggle(!props.etfPool.enabled)}
                    className={'relative inline-flex h-4 w-7 items-center rounded-full shrink-0 transition-colors ' + (props.etfPool.enabled ? 'bg-accent' : 'bg-elevated') + (props.etfPool.toggling ? ' opacity-50' : '')}
                  >
                    <span className={'inline-block h-3 w-3 rounded-full bg-white shadow-sm transition-transform ' + (props.etfPool.enabled ? 'translate-x-[14px]' : 'translate-x-0.5')} />
                  </button>}
                </div>
                <div className="flex items-center justify-between text-[11px]">
                  <div className="flex items-center gap-1">
                    <span className="text-muted">轮询间隔</span>
                    <button
                      onClick={() => {
                        if (group.id === 'stock') { setEditing(null); onShowIntervalEdit() }
                        else { setEditing(open ? null : group.id); if (showIntervalEdit) onShowIntervalEdit() }
                      }}
                      className={'p-0.5 rounded hover:bg-elevated transition-colors ' + (open ? 'text-accent' : 'text-secondary')}
                      title={'设置' + group.label + '轮询间隔'} aria-expanded={open}
                    ><Settings className="h-3 w-3" /></button>
                  </div>
                  <span className="font-mono text-secondary">{group.intervalS}s</span>
                </div>
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-muted shrink-0">最后获取</span>
                  <span className="font-mono text-secondary text-right">{lastFetch}</span>
                </div>
                <AnimatePresence>
                  {open && (
                    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                      <IntervalEditor label={group.label} min={group.intervalMin} max={group.intervalMax} value={group.intervalS} onChange={group.onIntervalChange} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

function IntervalEditor({ label, min, max, value, onChange }: {
  label: string; min: number; max: number; value: number; onChange: (v: number) => Promise<unknown>
}) {
  const [draft, setDraft] = useState(String(value))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setDraft(String(value)) }, [value])
  const numeric = Number(draft)
  const valid = draft.trim() !== '' && Number.isFinite(numeric) && numeric >= min && numeric <= max
  return (
    <form className="mt-2 space-y-1.5" onSubmit={async event => {
      event.preventDefault()
      if (!valid || saving) return
      setSaving(true); setError('')
      try { await onChange(numeric) }
      catch { setError('保存失败，请重试') }
      finally { setSaving(false) }
    }}>
      <div className="flex items-center gap-2">
        <input aria-label={label + '轮询间隔（秒）'} type="number" min={min} max={max} step="any"
          value={draft} onChange={event => setDraft(event.target.value)} disabled={saving}
          className="h-7 w-0 min-w-0 flex-1 rounded border border-border bg-base px-2 text-xs text-foreground focus:border-accent focus:outline-none" />
        <span className="text-[11px] text-muted">秒</span>
        <button type="submit" disabled={!valid || saving || numeric === value} className="h-7 rounded bg-accent px-2 text-xs text-white disabled:opacity-40">{saving ? '保存中…' : '保存'}</button>
      </div>
      <div className="text-[10px] text-muted">支持 {min}–{max} 秒，保存后生效</div>
      {error && <div role="alert" className="text-[11px] text-bear">{error}</div>}
    </form>
  )
}
