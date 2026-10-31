import './EtfRadar.css'
import { cnDateTimeFromUtc } from '@/lib/format'
import { cnToday } from '@/lib/kline'
import { DatePicker } from '@/components/DatePicker'
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type EtfRadarSignal } from '@/lib/api'
import { QK } from '@/lib/queryKeys'

const control = 'rounded border border-border bg-surface px-2 py-1 text-xs'
export function EtfRadar({ onSelect }: { onSelect: (signal: EtfRadarSignal, range: { start: string; end: string }, intraday?: boolean) => void }) {
  const expanded = true
  const [visible, setVisible] = useState(!document.hidden)
  const [date, setDate] = useState('')
  const [category, setCategory] = useState('')
  const [side, setSide] = useState('')
  const [kind, setKind] = useState('')
  const [all, setAll] = useState(false)
  const [jobDate, setJobDate] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const enabled = expanded && visible
  useEffect(() => {
    const change = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', change)
    return () => document.removeEventListener('visibilitychange', change)
  }, [])
  const query = useQuery({ queryKey: QK.etfRadar(date), queryFn: () => api.etfRadar(date), enabled, refetchInterval: false, retry: false })
  const job = useQuery({ queryKey: QK.etfRadarJob(jobId ?? ''), queryFn: () => api.etfRadarJob(jobId!), enabled: enabled && !!jobId, refetchInterval: enabled && jobId ? 2000 : false, retry: false })
  const data = query.data
  const snapshot = data?.snapshot && data.snapshot.date === (date || data?.date) ? data.snapshot : undefined
  const busy = !!jobId
  useEffect(() => {
    if (!enabled || !data) return
    if (data.job_id && data.job_date === (date || data.date)) {
      setJobDate(data.job_date)
      setJobId(data.job_id)
    }
  }, [enabled, data, date])
  useEffect(() => {
    if (!job.data || !['succeeded', 'failed'].includes(job.data.status)) return
    if (job.data.status === 'failed' && jobDate === (date || data?.date)) setError(job.data.error || '扫描失败')
    setJobId(null)
    void query.refetch()
  }, [job.data])
  const signals = snapshot?.signals.filter(s => (!category || s.category === category) && (!side || s.variant.startsWith(side)) && (!kind || s.variant.endsWith(kind))) ?? []
  const select = (s: EtfRadarSignal) => snapshot && onSelect(s, snapshot.range, snapshot.mode === 'intraday')
  const ringUsed = [0, 0, 0]
  const bubbles = signals.filter(s => {
    const ring = s.age === 0 ? 0 : s.age < 3 ? 1 : 2
    return ringUsed[ring]++ < [1, 5, 6][ring]
  }).slice(0, 12)
  const counts = [bubbles.filter(s => s.age === 0).length, bubbles.filter(s => s.age > 0 && s.age < 3).length, bubbles.filter(s => s.age >= 3).length]
  const positions = [0, 0, 0]
  return <section className="etf-radar-panel shrink-0 rounded-xl border border-border bg-surface p-4" aria-label="ETF市场雷达">
    <div className="flex items-start gap-3">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
      <h2 className="font-semibold">市场雷达</h2><span className="text-xs text-muted">全 ETF 池 · 日线 · {snapshot?.mode === 'intraday' ? '盘中候选 · ' : ''}<span title={snapshot ? `分析日期：${snapshot.date}` : undefined}>{cnDateTimeFromUtc(snapshot?.computed_at).slice(0, 16) || date || data?.date || '等待数据'}</span></span>
      <span role="status" className="text-xs text-muted">{busy && !snapshot ? (jobDate === (date || data?.date) ? job.data?.log.at(-1)?.msg ?? '扫描排队中' : '等待前一任务完成后计算所选日期…') : ''}</span>
      </div>
      <button className={control} disabled={query.isFetching} onClick={() => void query.refetch()}>刷新快照</button>
      <div className="ml-auto flex shrink-0 items-center" aria-label="雷达日期"><DatePicker value={date || data?.date || ''} min={data?.dates.at(-1)} max={cnToday()} onChange={value => { setDate(value); setJobId(null); setJobDate(null); setError(''); setAll(false) }} align="right" /></div>
    </div>
    {expanded && <>
      {(error || query.error || job.error) && <p role="alert" className="mt-3 text-sm text-down">{error || query.error?.message || job.error?.message}<button className="ml-2 underline" onClick={() => { setError(''); void query.refetch() }}>重试</button></p>}
      {query.isPending && <p role="status" className="py-4 text-sm text-muted">正在读取雷达快照…</p>}
      {!snapshot && !query.isPending && <div className="grid min-h-[220px] place-items-center text-sm text-muted" aria-label="雷达空状态">{busy ? '所选日期暂无快照，正在等待计算完成…' : query.isError || error ? '所选日期快照不可用' : '所选日期暂无快照，等待定时扫描'}</div>}
      {snapshot && <>
        <div className="my-3 flex flex-wrap gap-2">
          <select aria-label="雷达分类" className={control} value={category} onChange={e => setCategory(e.target.value)}><option value="">全部分类</option>{[...new Set(snapshot.signals.map(s => s.category))].sort().map(c => <option key={c}>{c}</option>)}</select>
          <select aria-label="雷达方向" className={control} value={side} onChange={e => setSide(e.target.value)}><option value="">全部方向</option><option value="B">B类</option><option value="S">S类</option></select>
          <select aria-label="雷达类型" className={control} value={kind} onChange={e => setKind(e.target.value)}><option value="">全部类型</option>{[1, 2, 3].map(n => <option key={n} value={n}>{n}类</option>)}</select>
        </div>
        <div className="etf-radar-layout">
          <div className="etf-radar-chart-group">
          <div className={`etf-radar-field ${visible ? '' : 'etf-radar-paused'}`} aria-label="信号雷达气泡图">
            <div className="etf-radar-glow" aria-hidden="true" />
            {[96, 68, 38].map((size, i) => <div key={size} className="etf-radar-ring" style={{ width: `${size}%`, height: `${size}%` }}><span>{['5个交易日内', '3个交易日内', '当日'][i]}</span></div>)}
            {bubbles.map((s, index) => {
              const ring = s.age === 0 ? 0 : s.age < 3 ? 1 : 2
              const angle = -Math.PI / 2 + (ring === 2 ? .35 : 0) + positions[ring]++ * 2 * Math.PI / counts[ring]
              const radius = [0, 24, 37][ring]
              const size = 18 + Number(s.variant[1]) * 2
              return <div key={`${s.symbol}:${s.id}`} className="etf-radar-position" style={{ left: `${50 + radius * Math.cos(angle)}%`, top: `${50 + radius * Math.sin(angle)}%`, width: `${size}%`, zIndex: ring === 0 ? 3 : 2 }}>
                <button onClick={() => select(s)} title={`${s.name} ${s.symbol} · ${s.variant} · ${s.availableDate.slice(0, 10)}`} aria-label={`${s.name} ${s.variant}`} className={`etf-radar-bubble ${s.variant.startsWith('B') ? 'etf-radar-buy' : 'etf-radar-sell'} etf-radar-type-${s.variant[1]}`} style={{ animationDelay: `${-index * .47}s`, animationDuration: `${4 + index % 3 * .6}s` }}>
                  <strong className="etf-radar-code">{s.code}</strong><span className="etf-radar-name">{s.name}</span><span className="etf-radar-type">{s.variant}</span>
                </button>
                {s.age === 0 && <span className="etf-radar-new" aria-label="当日新信号">新</span>}
              </div>
            })}
            {!signals.length && <span className="etf-radar-empty">当前条件下暂无有效候选信号</span>}
          </div>
        <div className="etf-radar-legend"><span><i className="etf-radar-dot buy" /><i className="etf-radar-dot sell" />红 B · 绿 S</span><span>大小与深浅表示一、二、三类</span><span>新：当日出现</span></div>
          </div>
          <div className="min-w-0">
          <div className="etf-radar-list" aria-label="雷达信号列表">
            {(all ? signals : signals.slice(0, 5)).map(s => <button key={`${s.symbol}:${s.id}`} onClick={() => select(s)} className="flex w-full items-center gap-3 border-b border-border py-3 text-left text-xs"><strong className={s.variant.startsWith('B') ? 'text-up' : 'text-down'}>{s.variant}</strong><span className="min-w-0 flex-1"><strong className="block">{s.name}</strong>{s.symbol} · {s.availableDate.slice(0, 10)}</span><span>{s.structureConfirmed ? '笔已确认' : '笔待确认'}<br />{snapshot.mode === 'intraday' ? '盘中候选' : '辅助候选'}</span></button>)}
            {signals.length > 5 && <button className="mt-2 block w-full text-center text-sm text-accent" onClick={() => setAll(!all)}>{all ? '收起列表' : `另有 ${signals.length - 5} 条 · 查看全部`}</button>}
          </div>
          </div>
        </div>
        {snapshot.failures.length > 0 && <details className="mt-2 text-xs text-muted"><summary>失败明细</summary>{snapshot.failures.map(f => <p key={f.symbol}>{f.symbol}：{f.message}</p>)}</details>}
      </>}
    </>}
  </section>
}
