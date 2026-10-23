import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type IndicatorMonitorEvent, type IndicatorMonitorRule } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { Modal } from '@/components/Modal'
import { KLineCandlestick } from '@/components/KLineCandlestick'
import { toOHLC } from '@/components/StockDailyKChart'
import { IndicatorMonitorEditor, monitorInput, useIndicatorMonitors } from './IndicatorMonitorEditor'

const statuses: Record<string, string> = { running: '运行中', waiting: '等待数据', paused: '已暂停', history_short: '历史不足', version_changed: '版本待更新', context_changed: '上下文待更新', capability_missing: '能力不足', error: '计算异常' }
const modes = { preview: '实时预警', confirmed: '收盘确认', both: '实时＋确认' }
const confirmation = { pending: '待收盘确认', confirmed: '已确认', unconfirmed: '收盘未确认', missing_data: '数据缺失，未能确认' }
const delivery = { pending: '待发送', sent: '已发送', failed: '发送失败' }
const channelNames: Record<string, string> = { system: '系统', feishu: '飞书', wecom: '企业微信', custom: 'Webhook', email: '邮件' }

function Snapshot({ target, close }: { target: { id: string; event?: IndicatorMonitorEvent }; close: () => void }) {
  const query = useQuery({ queryKey: QK.indicatorMonitorSnapshot(target.id, target.event?.event_id), queryFn: () => api.indicatorMonitorSnapshot(target.id, target.event?.event_id), refetchInterval: target.event ? false : 15000 })
  const data = query.data
  return <Modal ariaLabel="指标监控详情" onClose={close} panelClassName="max-h-[94dvh] w-[96vw] max-w-6xl overflow-auto rounded-card border border-border bg-surface p-4 shadow-xl">
    <div className="mb-3 flex justify-between gap-3"><h2 className="text-sm font-semibold">{data?.symbol} · {data?.definition.name} · {data?.period === '30m' ? '30f' : '日线'}</h2><button onClick={close}>关闭</button></div>
    <p className="mb-3 text-xs text-muted">{target.event ? '使用触发时的指标版本及K线快照。' : '使用后台监控的固定计算上下文。'}{target.event?.message}</p>
    {query.isLoading && <p>加载监控快照…</p>}{query.isError && <p role="alert" className="text-danger">{query.error.message} <button onClick={() => query.refetch()}>重试</button></p>}
    {data && <KLineCandlestick data={toOHLC(data.rows, data.period)} symbol={data.symbol} assetType={data.asset_type} period={data.period} indicatorDefinitions={[data.definition]} indicatorResults={data.indicator_results} activeIndicators={[data.definition.id]} showMA={data.definition.id === 'ma'} selectedDate={target.event?.bar_end.slice(0, data.period === '30m' ? 16 : 10)} visibleBars={60} height={520} />}
  </Modal>
}

export function IndicatorMonitors() {
  const rules = useIndicatorMonitors()
  const events = useQuery({ queryKey: QK.indicatorMonitorEvents, queryFn: api.indicatorMonitorEvents, refetchInterval: 15000 })
  const symbols = [...new Set([
    ...(rules.data?.items.map(rule => rule.symbol) ?? []),
    ...(events.data?.items.map(event => event.symbol) ?? []),
  ])].sort()
  const names = useQuery({ queryKey: QK.instrumentNames(symbols), queryFn: () => api.instrumentNames(symbols), enabled: symbols.length > 0, staleTime: 300000 })
  const symbolNames = names.data?.names ?? {}
  const qc = useQueryClient()
  const [editor, setEditor] = useState<{ rule?: IndicatorMonitorRule } | null>(null)
  const [snapshot, setSnapshot] = useState<{ id: string; event?: IndicatorMonitorEvent } | null>(null)
  const [confirm, setConfirm] = useState<{ text: string; action: () => Promise<unknown> } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null)
  const selectedRule = rules.data?.items.find(rule => rule.id === selectedRuleId)
  const visibleEvents = events.data?.items.filter(event => !selectedRule || event.rule_id === selectedRule.id) ?? []
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await action(); await Promise.all([qc.invalidateQueries({ queryKey: QK.indicatorMonitors }), qc.invalidateQueries({ queryKey: QK.indicatorMonitorEvents })]); setConfirm(null) }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败') }
    finally { setBusy(false) }
  }
  return <div className="space-y-4 overflow-auto p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-lg font-semibold">指标监控</h1><p className="mt-1 text-xs text-muted">自建主图与副图 · 每60秒检查 · 后台独立运行</p></div><button onClick={() => setEditor({})} className="rounded-btn bg-accent px-4 py-2 text-sm text-white">新增指标监控</button></div>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <div className="grid items-start gap-5 md:grid-cols-[360px_minmax(0,1fr)]">
    <section className="min-w-0 space-y-3 text-xs" aria-label="指标监控规则">
      <h2 className="text-xs font-semibold">监控指标</h2>
      {rules.isLoading && <p>加载监控规则…</p>}{rules.isError && <p role="alert" className="text-danger">监控规则加载失败 <button onClick={() => rules.refetch()}>重试</button></p>}
      {rules.isSuccess && !rules.data.items.length && <p className="rounded-card border border-border p-6 text-xs text-muted">暂无指标监控。可以在详情页指标菜单点击铃铛，也可以在这里新增。</p>}
      {rules.data?.items.map(rule => <article key={rule.id} className={`relative w-full min-w-0 rounded-card border bg-surface p-4 [overflow-wrap:anywhere] ${selectedRule?.id === rule.id ? 'border-accent ring-1 ring-accent/30' : 'border-border hover:border-accent/50'}`}>
        <button
          aria-label={`筛选 ${rule.symbol} ${symbolNames[rule.symbol] ?? ''} ${rule.definition.name} 的触发记录`}
          aria-pressed={selectedRule?.id === rule.id}
          title={selectedRule?.id === rule.id ? '取消筛选，显示全部记录' : '仅显示此监控的触发记录'}
          className="absolute inset-0 rounded-card focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          onClick={() => setSelectedRuleId(selectedRule?.id === rule.id ? null : rule.id)}
        />
        <div className="pointer-events-none relative">
        <div className="flex flex-wrap items-center gap-2 text-xs"><strong>{rule.symbol}</strong>{symbolNames[rule.symbol] && <span className="font-medium">{symbolNames[rule.symbol]}</span>}<span>{rule.definition.name}</span><span className="text-muted">{rule.period === '30m' ? '30f' : '日线'} · {modes[rule.mode]}</span><span className={rule.status === 'running' ? 'text-accent' : 'text-warning'}>{statuses[rule.status] ?? '等待数据'}</span></div>
        <p className="mt-2 text-[11px] text-secondary">信号：{rule.definition.monitor_signals?.filter(s => rule.signal_ids.includes(s.id)).map(s => s.name).join('、')}</p>
        <p className="mt-2 text-[11px] text-muted">最近信号：{events.data?.items.find(event => event.rule_id === rule.id)?.message ?? '尚无信号'}</p>
        <p className="mt-2 text-[11px] text-muted">最近检查：{rule.last_checked?.replace('T', ' ').slice(0, 19) ?? '尚未检查'} · 数据截止：{rule.data_through ?? '等待数据'}</p>
        {rule.reason && <p className="mt-2 text-[11px] text-warning">{rule.reason}{rule.status === 'capability_missing' && <a className="pointer-events-auto relative z-10 ml-2 underline" href="/settings?tab=data-sources">数据源配置</a>}</p>}
        <div className="pointer-events-none relative z-10 mt-3 flex flex-wrap items-center gap-4 text-[11px] [&_button]:pointer-events-auto"><button disabled={busy} className="text-accent" onClick={() => setEditor({ rule })}>编辑</button><button disabled={busy} onClick={() => void act(() => api.saveIndicatorMonitor({ ...monitorInput(rule), enabled: !rule.enabled }, rule.id))}>{rule.enabled ? '暂停' : '恢复'}</button>
          {rule.needs_update && <button disabled={busy} className="text-warning" onClick={() => setConfirm({ text: '采用当前指标版本及数据口径，并重新建立基线？已有记录将保留。', action: () => api.adoptIndicatorMonitor(rule.id) })}>采用新版本／重建上下文</button>}
          <button onClick={() => setSnapshot({ id: rule.id })}>查看图表</button><button className="text-danger" disabled={busy} onClick={() => setConfirm({ text: '删除这条指标监控？历史触发记录将保留。', action: () => api.deleteIndicatorMonitor(rule.id) })}>删除</button>
        </div>
        </div>
      </article>)}
    </section>
    <section className="min-w-0 space-y-3" aria-label="指标触发记录"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold">触发记录</h2><button disabled={busy || !events.data?.items.length} className="text-xs text-muted disabled:opacity-50" onClick={() => setConfirm({ text: '清空指标触发记录？监控进度和去重状态将保留。', action: api.clearIndicatorMonitorEvents })}>清空记录</button></div>
      {selectedRule && <div className="flex flex-wrap items-center gap-2 text-xs text-muted"><span>{selectedRule.symbol} {symbolNames[selectedRule.symbol]} · {selectedRule.definition.name}</span><button className="text-accent" onClick={() => setSelectedRuleId(null)}>显示全部记录</button></div>}
      {events.isLoading && <p>加载触发记录…</p>}{events.isError && <p role="alert" className="text-danger">触发记录加载失败 <button onClick={() => events.refetch()}>重试</button></p>}
      {events.isSuccess && !visibleEvents.length && <p className="rounded-card border border-border p-6 text-sm text-muted">{selectedRule ? '此监控暂无触发记录。' : '尚无信号。监控命中后会在这里展示预警和确认。'}</p>}
      {!!visibleEvents.length && <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface" aria-label="触发记录列表">
        {visibleEvents.map(event => <li key={event.event_id} className="space-y-2 p-4 text-sm [overflow-wrap:anywhere] hover:bg-elevated">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <button className="min-w-0 text-left font-medium hover:text-accent" onClick={() => setSnapshot({ id: event.rule_id, event })}>{event.symbol}{symbolNames[event.symbol] && ` ${symbolNames[event.symbol]}`} · {event.indicator_name} · {event.signal_name}</button>
            <span className="shrink-0 text-xs text-muted">{event.bar_end.replace('T', ' ')} · {event.period === '30m' ? '30f' : '日线'}</span>
          </div>
          <p className="text-xs leading-5 text-secondary">{event.message}</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
            <span>信号价 <span className="font-mono text-foreground">{event.price ?? '—'}</span></span>
            <span>{event.phase === 'preview' ? confirmation[event.confirmation] : '收盘已确认'}</span>
            {Object.entries(event.deliveries).map(([channel, state]) => <span key={channel}>{channelNames[channel]}：{delivery[state]}</span>)}
            {Object.values(event.deliveries).includes('failed') && <button disabled={busy} className="text-accent" onClick={() => void act(() => api.retryIndicatorMonitorEvent(event.event_id))}>重试失败通知</button>}
          </div>
        </li>)}
      </ul>}
    </section>
    </div>
    {editor && <IndicatorMonitorEditor rule={editor.rule} onClose={() => setEditor(null)} />}
    {snapshot && <Snapshot target={snapshot} close={() => setSnapshot(null)} />}
    {confirm && <Modal ariaLabel="确认指标监控操作" onClose={() => !busy && setConfirm(null)}><div className="space-y-4 p-5"><p>{confirm.text}</p>{error && <p className="text-sm text-danger" role="alert">{error}</p>}<div className="flex justify-end gap-4"><button disabled={busy} onClick={() => setConfirm(null)}>取消</button><button disabled={busy} className="text-accent" onClick={() => void act(confirm.action)}>确认</button></div></div></Modal>}
  </div>
}
