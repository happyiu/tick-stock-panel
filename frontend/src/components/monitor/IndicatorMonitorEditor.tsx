import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type IndicatorMonitorInput, type IndicatorMonitorRule } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { useChartIndicators } from '@/lib/useChartIndicators'
import { Modal } from '@/components/Modal'

export const monitorInput = (rule: IndicatorMonitorInput): IndicatorMonitorInput => ({
  symbol: rule.symbol, asset_type: rule.asset_type, indicator_id: rule.indicator_id, period: rule.period,
  signal_ids: rule.signal_ids, mode: rule.mode, channels: rule.channels, enabled: rule.enabled, compare_days: rule.compare_days,
})
export const useIndicatorMonitors = (enabled = true) => useQuery({ queryKey: QK.indicatorMonitors, queryFn: api.indicatorMonitors, enabled, staleTime: 10000, refetchInterval: enabled ? 15000 : false })
const field = 'w-full rounded border border-border bg-base px-3 py-2 text-sm text-foreground'

export function IndicatorMonitorEditor({ rule, preset, onClose }: { rule?: IndicatorMonitorRule; preset?: Partial<IndicatorMonitorInput>; onClose: () => void }) {
  const catalog = useChartIndicators()
  const qc = useQueryClient()
  const [draft, setDraft] = useState<IndicatorMonitorInput>(() => rule ? monitorInput(rule) : {
    symbol: '', asset_type: 'stock', indicator_id: '', period: '30m', signal_ids: [], mode: 'both', channels: [], enabled: true, compare_days: 1, ...preset,
  })
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const search = useQuery({ queryKey: QK.instrumentSearch(query, 'stock,etf'), queryFn: () => api.instrumentSearch(query, 10, 'stock,etf'), enabled: query.trim().length > 0 })
  const items = catalog.items.filter(i => i.source === 'custom')
  const item = items.find(i => i.id === draft.indicator_id)
  const signals = item?.monitor_signals?.filter(s => s.periods.includes(draft.period)) ?? []
  const save = async () => {
    setBusy(true); setError('')
    try {
      await api.saveIndicatorMonitor(draft, rule?.id)
      await qc.invalidateQueries({ queryKey: QK.indicatorMonitors }); onClose()
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败') }
    finally { setBusy(false) }
  }
  return <Modal ariaLabel={rule ? '编辑指标监控' : '添加指标监控'} onClose={() => !busy && onClose()} panelClassName="max-h-[92dvh] w-[94vw] max-w-xl overflow-auto rounded-card border border-border bg-surface p-5 shadow-xl">
    <div className="mb-4 flex justify-between"><h2 className="font-semibold">{rule ? '编辑指标监控' : '添加指标监控'}</h2><button aria-label="关闭指标监控" disabled={busy} onClick={onClose}>关闭</button></div>
    <div className="space-y-4">
      <div><label className="text-sm">标的<input aria-label="搜索监控标的" placeholder="搜索股票或ETF名称、代码" className={`${field} mt-1`} value={query} onChange={e => setQuery(e.target.value)} /></label>
        {search.isError && <p className="text-xs text-danger">搜索失败，请重试</p>}
        {query && <div className="max-h-36 overflow-auto">{search.data?.results.map(result => <button key={result.symbol} className="block w-full p-2 text-left text-xs hover:bg-elevated" onClick={() => { setDraft(d => ({ ...d, symbol: result.symbol, asset_type: result.asset_type === 'etf' ? 'etf' : 'stock' })); setQuery('') }}>{result.name} · {result.symbol}</button>)}</div>}
        <p className="mt-1 text-xs text-muted">已选：{draft.symbol || '请选择标的'} {draft.symbol && (draft.asset_type === 'etf' ? 'ETF' : '股票')}</p>
      </div>
      <label className="block text-sm">自建指标<select aria-label="监控指标" className={`${field} mt-1`} value={draft.indicator_id} onChange={e => setDraft(d => ({ ...d, indicator_id: e.target.value, signal_ids: [] }))}><option value="">选择主图或副图指标</option>{items.map(i => <option key={i.id} value={i.id}>{i.name} · {i.pane === 'main' ? '主图' : '副图'}</option>)}</select></label>
      {catalog.isError && <button className="text-sm text-danger" onClick={() => catalog.refetch()}>指标加载失败，重试</button>}
      <label className="block text-sm">周期<select aria-label="监控周期" className={`${field} mt-1`} value={draft.period} onChange={e => setDraft(d => ({ ...d, period: e.target.value as '30m' | '1d', signal_ids: [] }))}><option value="30m">30f</option><option value="1d">日线</option></select></label>
      <fieldset className="space-y-2"><legend className="mb-2 text-sm">监控信号</legend>{signals.map(signal => <label key={signal.id} className="mr-4 inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.signal_ids.includes(signal.id)} onChange={e => setDraft(d => ({ ...d, signal_ids: e.target.checked ? [...d.signal_ids, signal.id] : d.signal_ids.filter(id => id !== signal.id) }))} />{signal.name}</label>)}
        {item && !signals.length && <p className="text-xs text-muted">该周期没有可监控信号，请先为当前指标“{item.name}”配置信号，再添加监控。<a className="text-accent underline" href={`/indicators?edit=${encodeURIComponent(item.id)}`}>编辑当前指标的监控信号</a></p>}
      </fieldset>
      <label className="block text-sm">触发方式<select aria-label="触发方式" className={`${field} mt-1`} value={draft.mode} onChange={e => setDraft(d => ({ ...d, mode: e.target.value as IndicatorMonitorInput['mode'] }))}><option value="both">实时预警＋收盘确认</option><option value="preview">仅实时预警</option><option value="confirmed">仅收盘确认</option></select></label>
      <p className="text-xs leading-5 text-muted">后台每60秒检查。盘中预警可能消失；收盘不成立只更新记录，不再通知。关闭图表不影响后台监控。</p>
      <fieldset><legend className="mb-2 text-sm">通知渠道</legend><p className="mb-2 text-xs text-muted">应用内记录始终开启。其他渠道须先在设置中配置；系统通知受全局开关控制。</p>{[['system','系统通知'],['feishu','飞书'],['wecom','企业微信'],['custom','自定义Webhook'],['email','邮件']].map(([id, label]) => <label key={id} className="mb-2 mr-3 inline-flex items-center gap-1 text-xs"><input type="checkbox" checked={draft.channels.includes(id)} onChange={e => setDraft(d => ({ ...d, channels: e.target.checked ? [...d.channels, id] : d.channels.filter(c => c !== id) }))} />{label}</label>)}</fieldset>
      <label className="flex items-center gap-2 text-xs">量能对比天数<input aria-label="量能对比天数" type="number" min={1} max={20} className={`${field} !w-20`} value={draft.compare_days} onChange={e => setDraft(d => ({ ...d, compare_days: Number(e.target.value) }))} /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft(d => ({ ...d, enabled: e.target.checked }))} />开启监控</label>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-3"><button disabled={busy} onClick={onClose}>取消</button><button disabled={busy || !draft.symbol || !draft.signal_ids.length} onClick={save} className="rounded-btn bg-accent px-4 py-2 text-sm text-white disabled:opacity-50">{busy ? '保存中…' : '保存监控'}</button></div>
    </div>
  </Modal>
}
