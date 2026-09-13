import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as echarts from 'echarts'
import { Archive, ChevronDown, ChevronUp, Pause, Play, RotateCcw, Settings, StepForward, X } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { PageHeader } from '@/components/PageHeader'
import { PaperTradingControls, PaperTradingSymbolField } from '@/components/PaperTradingControls'
import { StockPreviewDialog, toNavItems } from '@/components/StockPreviewDialog'
import { api, type PaperPosition, type PaperSnapshot, type PositionEquityPoint } from '@/lib/api'
import {
  buildPaperTradingTimelineState,
  getBeijingPaperClock,
  PAPER_TRADING_SESSIONS,
  PAPER_TRADING_STEP_MINUTES,
  parsePaperClockMinutes,
  type PaperTradingClock,
  type PaperTradingSession,
  type PaperTradingTimelineState,
} from '@/lib/paper-trading-time'
import { QK } from '@/lib/queryKeys'
import { useChartTheme } from '@/lib/theme'

type Mode = 'live' | 'replay'
type RecordTab = 'orders' | 'fills' | 'conditions' | 'ledger'
type EquityChartPoint = {
  bar_time: string
  equity: number
  drawdown: number
  return_rate?: number
}
type AccountFormState = {
  name: string
  initial_cash: number
  commission_rate: number
  minimum_commission: number
  slippage_bps: number
  max_positions: number
  max_exposure_pct: number
  max_symbol_exposure_pct: number
}
const input = 'h-9 w-full rounded-btn border border-border bg-base px-2.5 text-sm outline-none focus:border-accent'
const button = 'inline-flex h-9 items-center justify-center gap-1.5 rounded-btn border border-border bg-surface px-3 text-sm font-medium transition-colors hover:border-accent/50 disabled:cursor-not-allowed disabled:opacity-40'
const primary = `${button} border-accent bg-accent text-white hover:bg-accent/90`

const money = (v?: number | null) => v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const price = (v?: number | null) => v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('zh-CN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })
const pct = (v?: number | null) => v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`
const time = (v?: string | null) => v ? v.replace('T', ' ').slice(0, 16) : '—'
const shortTime = (v?: string | null) => time(v).replace(/^20(\d{2})-/, '$1-')
const statusName = (v: string) => ({ queued: '待激活', active: '活动', filled: '已成交', cancelled: '已撤销', expired: '已过期', rejected: '已拒绝', armed: '监控中', triggered: '已触发', waiting_sellable: '等待可卖', running: '运行中', paused: '已暂停', finished: '已完成', ready: '就绪', idle: '空闲', closed: '休市', stale: '数据等待中', unavailable: '不可用' } as Record<string, string>)[v] ?? v

function Panel({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return <section className="rounded-xl border border-border bg-surface"><div className="border-b border-border px-3 py-2.5 text-sm font-semibold">{title}</div><div className="p-3">{children}</div></section>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block space-y-1"><span className="text-xs text-secondary">{label}</span>{children}</label>
}

function TimelineSegment({ session, offset, state }: { session: PaperTradingSession; offset: number; state: PaperTradingTimelineState }) {
  return <div className="min-w-[340px] flex-1"><div className="relative flex items-center"><div className="absolute left-1 right-1 top-1/2 h-px bg-border" />{session.points.map((point, index) => { const globalIndex = offset + index; const active = state.activeIndex === globalIndex; const complete = globalIndex <= state.completedIndex; return <div key={point.label} className="relative flex flex-1 justify-center"><span title={`${point.label} · ${active ? '当前时间步' : complete ? '已完成' : '待推进'}`} className={`h-2.5 w-2.5 rounded-full border transition-colors ${active ? 'border-accent bg-accent ring-4 ring-accent/20' : complete ? 'border-accent bg-accent/80' : 'border-border bg-base'}`} /></div> })}</div><div className="mt-2 flex justify-between text-[10px] tabular-nums text-muted">{session.points.map((point, index) => { const globalIndex = offset + index; const current = state.activeIndex === globalIndex; return <span key={point.label} className={current ? 'font-semibold text-accent' : globalIndex <= state.completedIndex ? 'text-secondary' : undefined}>{point.label}</span> })}</div></div>
}

function TradingSessionTimeline({ clock }: { clock: PaperTradingClock | null }) {
  const state = buildPaperTradingTimelineState(clock?.minutes ?? null, clock?.tradingDay ?? false)
  const afternoonOffset = PAPER_TRADING_SESSIONS[0].points.length
  return <div className="basis-full border-t border-border/70 pt-3"><div className="overflow-x-auto pb-1"><div className="flex min-w-[736px] items-start gap-5"><TimelineSegment session={PAPER_TRADING_SESSIONS[0]} offset={0} state={state} /><div className="w-12 shrink-0 pt-4 text-center text-[10px] text-muted">午休</div><TimelineSegment session={PAPER_TRADING_SESSIONS[1]} offset={afternoonOffset} state={state} /></div></div></div>
}

function EquityChart({ rows, emptyMessage = '成交后将按分钟形成权益曲线' }: { rows: EquityChartPoint[]; emptyMessage?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const theme = useChartTheme()
  useEffect(() => {
    if (!ref.current) return
    const chart = echarts.init(ref.current)
    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(ref.current)
    const initial = rows[0]?.equity
    chart.setOption({
      animation: false,
      tooltip: {
        trigger: 'axis',
        backgroundColor: theme.tooltipBg,
        borderColor: theme.tooltipBorder,
        textStyle: { color: theme.tooltipText },
        formatter: (params: any) => {
          const points = Array.isArray(params) ? params : [params]
          const date = points[0]?.axisValue ?? ''
          let html = `<div style="font-size:11px;margin-bottom:4px">${date}</div>`
          for (const point of points) {
            if (point.value == null) continue
            const rawValue = Array.isArray(point.value)
              ? point.value[point.value.length - 1]
              : point.value
            const value = Number(rawValue)
            if (!Number.isFinite(value)) continue
            const formatted = point.seriesName === '净值' ? money(value) : pct(value)
            html += `<div style="display:flex;justify-content:space-between;gap:16px">
              <span style="color:${point.color}">${point.seriesName}</span>
              <span style="font-family:monospace">${formatted}</span>
            </div>`
          }
          return html
        },
      },
      legend: { top: 0, textStyle: { color: theme.text }, data: ['净值', '累计收益', '回撤'] },
      grid: { left: 52, right: 52, top: 34, bottom: 28 },
      xAxis: { type: 'category', data: rows.map(x => time(x.bar_time)), axisLabel: { color: theme.text }, axisLine: { lineStyle: { color: theme.border } } },
      yAxis: [{ type: 'value', scale: true, axisLabel: { color: theme.text }, splitLine: { lineStyle: { color: theme.grid } } }, { type: 'value', axisLabel: { color: theme.text, formatter: (v: number) => `${(v * 100).toFixed(1)}%` }, splitLine: { show: false } }],
      series: [
        { name: '净值', type: 'line', symbol: rows.length === 1 ? 'circle' : 'none', symbolSize: 6, data: rows.map(x => x.equity), lineStyle: { color: '#3B82F6' } },
        { name: '累计收益', type: 'line', symbol: rows.length === 1 ? 'circle' : 'none', symbolSize: 6, yAxisIndex: 1, data: rows.map(x => x.return_rate ?? (initial ? x.equity / initial - 1 : 0)), lineStyle: { color: '#C74040' } },
        { name: '回撤', type: 'line', symbol: rows.length === 1 ? 'circle' : 'none', symbolSize: 6, yAxisIndex: 1, data: rows.map(x => x.drawdown), lineStyle: { color: '#2D9B65' }, areaStyle: { opacity: 0.08 } },
      ],
    })
    return () => { ro.disconnect(); chart.dispose() }
  }, [rows, theme])
  return rows.length ? <div ref={ref} className="h-40 w-full" /> : <div className="flex h-40 items-center justify-center text-sm text-muted">{emptyMessage}</div>
}

function PositionEquityChart({ rows }: { rows: PositionEquityPoint[] }) {
  return <EquityChart rows={rows} emptyMessage="建仓后将按模拟盘行情形成该标的收益曲线" />
}

const DEFAULT_ACCOUNT_FORM: AccountFormState = {
  name: '',
  initial_cash: 1_000_000,
  commission_rate: 0.02,
  minimum_commission: 5,
  slippage_bps: 5,
  max_positions: 10,
  max_exposure_pct: 100,
  max_symbol_exposure_pct: 20,
}

function accountFormValues(data: PaperSnapshot | null): AccountFormState {
  if (!data) return { ...DEFAULT_ACCOUNT_FORM }
  const a = data.account
  return {
    name: a.name,
    initial_cash: a.initial_cash,
    commission_rate: a.commission_rate * 100,
    minimum_commission: a.minimum_commission,
    slippage_bps: a.slippage_bps,
    max_positions: a.max_positions,
    max_exposure_pct: a.max_exposure_pct * 100,
    max_symbol_exposure_pct: a.max_symbol_exposure_pct * 100,
  }
}

function AccountForm({ data, done }: { data: PaperSnapshot | null; done: () => void | Promise<void> }) {
  const [form, setForm] = useState(() => accountFormValues(data))
  const hasFills = Boolean(data?.fills.length)
  useEffect(() => setForm(accountFormValues(data)), [data?.account.id, data?.account.revision]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: () => {
      const numeric = {
        initial_cash: form.initial_cash,
        commission_rate: form.commission_rate / 100,
        minimum_commission: form.minimum_commission,
        slippage_bps: form.slippage_bps,
        max_positions: form.max_positions,
        max_exposure_pct: form.max_exposure_pct / 100,
        max_symbol_exposure_pct: form.max_symbol_exposure_pct / 100,
      }
      if (data) {
        return api.paperUpdateConfig(data.account.id, hasFills ? { name: form.name.trim() } : { name: form.name.trim(), ...numeric })
      }
      return api.paperCreateLiveAccount({ name: form.name.trim(), ...numeric })
    },
    onSuccess: done,
  })
  const fields: Array<[Exclude<keyof AccountFormState, 'name'>, string, number]> = [['initial_cash', '初始资金（元）', 10000], ['commission_rate', '佣金率（%）', 0.001], ['minimum_commission', '最低佣金（元）', 0.01], ['slippage_bps', '市价滑点（bps）', 0.1], ['max_positions', '最大持仓数', 1], ['max_exposure_pct', '最大总仓位（%）', 1], ['max_symbol_exposure_pct', '单标的上限（%）', 1]]
  return <div className="space-y-3"><Field label="账户名称"><input className={input} maxLength={80} placeholder="例如：ETF 实时账户" value={form.name} onChange={e => setForm(x => ({ ...x, name: e.target.value }))} /></Field><div className="grid grid-cols-2 gap-2">{fields.map(([key, label, step]) => <Field key={key} label={label}><input className={input} disabled={hasFills} type="number" step={step} value={form[key]} onChange={e => setForm(x => ({ ...x, [key]: Number(e.target.value) }))} /></Field>)}</div><button className={primary} disabled={!form.name.trim() || save.isPending} onClick={() => save.mutate()}>{data ? '保存账户设置' : '保存并进入模拟交易'}</button><p className="text-xs leading-5 text-muted">{data ? '首次成交后账户基础配置锁定；需要调整时请归档并重建账户。' : '请先设置账户名称；保存后才能进入模拟交易页面。'}</p></div>
}

function ManualPositionForm({
  data,
  position,
  done,
}: {
  data: PaperSnapshot
  position: PaperPosition | null
  done: () => void | Promise<void>
}) {
  const editing = Boolean(position)
  const [symbol, setSymbol] = useState(position?.symbol ?? '')
  const [quantity, setQuantity] = useState(position ? String(position.quantity) : '100')
  const [averageCost, setAverageCost] = useState(position ? String(position.average_cost) : '')
  useEffect(() => {
    setSymbol(position?.symbol ?? '')
    setQuantity(position ? String(position.quantity) : '100')
    setAverageCost(position ? String(position.average_cost) : '')
  }, [position?.symbol, position?.quantity, position?.average_cost])
  const submit = useMutation({
    mutationFn: () => {
      const payload = {
        account_id: data.account.id,
        symbol,
        quantity: Number(quantity),
        average_cost: Number(averageCost),
      }
      return editing ? api.paperEditManualPosition(payload) : api.paperAddManualPosition(payload)
    },
    onSuccess: done,
  })
  const remove = useMutation({
    mutationFn: () => api.paperDeleteManualPosition(data.account.id, symbol),
    onSuccess: done,
  })
  const valid = Boolean(symbol.trim() && Number(quantity) > 0 && Number(averageCost) > 0)
  const busy = submit.isPending || remove.isPending
  return <div className="space-y-3">
    <Field label="ETF 标的">
      {editing
        ? <input className={`${input} cursor-not-allowed opacity-70`} value={symbol} readOnly aria-readonly="true" />
        : <PaperTradingSymbolField value={symbol} choose={setSymbol} />}
    </Field>
    <div className="grid grid-cols-2 gap-2">
      <Field label="持仓数量（股）"><input className={input} type="number" min="1" step="1" value={quantity} onChange={e => setQuantity(e.target.value)} /></Field>
      <Field label="持仓成本（元/股）"><input className={input} type="number" min="0.001" step="0.001" value={averageCost} onChange={e => setAverageCost(e.target.value)} /></Field>
    </div>
    <div className="flex gap-2">
      {editing && <button
        type="button"
        className="inline-flex h-9 items-center justify-center rounded-btn border border-danger/30 px-3 text-sm font-medium text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
        disabled={busy}
        onClick={() => window.confirm(`确认删除手动持仓“${symbol}”？`) && remove.mutate()}
      >删除持仓</button>}
      <button type="button" className={`${primary} flex-1`} disabled={!valid || busy} onClick={() => submit.mutate()}>{editing ? '保存修改' : '保存持仓'}</button>
    </div>
    <p className="text-xs leading-5 text-muted">{editing ? '标的不可修改；保存后按新的数量和成本重新计算，当前价格继续使用行情数据库中的最新价格。' : '保存时自动读取行情数据库中的最新价格，用于计算市值和未实现盈亏。按手动建仓处理，持仓成本会从账户现金中扣除；相同标的再次添加会合并计算平均成本。'}</p>
  </div>
}

function PositionDescriptionEditor({
  accountId,
  symbol,
  description,
  archived,
  done,
}: {
  accountId: string
  symbol: string
  description?: string
  archived: boolean
  done: () => void | Promise<void>
}) {
  const initialDescription = description ?? ''
  const [value, setValue] = useState(initialDescription)
  const [savedDescription, setSavedDescription] = useState(initialDescription)
  useEffect(() => {
    const next = description ?? ''
    setValue(next)
    setSavedDescription(next)
  }, [description, symbol])
  const save = useMutation({
    mutationFn: () => api.paperUpdatePositionDescription({ account_id: accountId, symbol, description: value }),
    onSuccess: () => {
      setSavedDescription(value)
      void done()
    },
  })
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="paper-position-description" className="text-xs text-muted">描述</label>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted">{value.length}/2000{archived ? ' · 归档账户只读' : ''}</span>
          {!archived && <button
            type="button"
            className={`${button} h-8 px-2.5 text-xs`}
            disabled={save.isPending || value === savedDescription}
            onClick={() => save.mutate()}
          >{save.isPending ? '保存中…' : '保存描述'}</button>}
        </div>
      </div>
      <textarea
        id="paper-position-description"
        className="mt-1 min-h-20 w-full resize-y rounded-btn border border-border bg-base px-2.5 py-2 text-sm leading-5 outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
        maxLength={2000}
        rows={3}
        value={value}
        disabled={archived || save.isPending}
        placeholder="记录该持仓的备注、计划或复盘内容"
        onChange={event => setValue(event.target.value)}
      />
      {save.isError && <div className="mt-1 text-xs text-danger">描述保存失败，请稍后重试</div>}
    </div>
  )
}

function ArchivedAccounts() {
  const client = useQueryClient()
  const archived = useQuery({ queryKey: QK.paperArchivedAccounts, queryFn: api.paperArchivedAccounts })
  const remove = useMutation({
    mutationFn: (accountId: string) => api.paperDeleteArchivedAccount(accountId),
    onSuccess: () => { void client.invalidateQueries({ queryKey: QK.paperArchivedAccounts }) },
  })
  const items = archived.data?.items ?? []
  return <section className="mt-5 border-t border-border pt-4"><div className="mb-2 text-sm font-semibold">归档账户</div><p className="mb-3 text-xs leading-5 text-muted">归档账户仅供查看历史；删除后将永久清除该账户的订单、成交、持仓、流水和权益记录。</p>{archived.isLoading && <div className="py-3 text-sm text-muted">正在加载归档账户…</div>}{archived.isError && <div className="py-3 text-sm text-danger">归档账户加载失败</div>}{!archived.isLoading && !archived.isError && !items.length && <div className="rounded-btn border border-dashed border-border px-3 py-4 text-center text-sm text-muted">暂无归档账户</div>}<div className="space-y-2">{items.map(account => <div key={account.id} className="flex items-center gap-3 rounded-btn border border-border px-3 py-2.5"><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium" title={account.name}>{account.name}</div><div className="mt-1 text-xs text-muted">{account.mode === 'live' ? '实时账户' : '历史回放'} · 创建于 {time(account.created_at)}</div></div><button type="button" className="shrink-0 rounded-btn border border-danger/30 px-2.5 py-1.5 text-xs text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40" disabled={remove.isPending} onClick={() => window.confirm(`确认永久删除归档账户“${account.name}”及其全部历史记录？此操作不可恢复。`) && remove.mutate(account.id)}>删除</button></div>)}</div></section>
}

function ReplayPicker({ selected, choose }: { selected: string; choose: (v: string) => void }) {
  const today = new Date().toISOString().slice(0, 10)
  const [name, setName] = useState('')
  const [start, setStart] = useState(today)
  const [end, setEnd] = useState(today)
  const list = useQuery({ queryKey: QK.paperReplays, queryFn: api.paperReplays })
  const create = useMutation({ mutationFn: () => api.paperCreateReplay({ name, start, end, initial_cash: 1_000_000 }), onSuccess: x => { choose(x.account.id); void list.refetch() } })
  return <div className="space-y-2"><Field label="回放会话"><select className={input} value={selected} onChange={e => choose(e.target.value)}><option value="">选择已保存会话</option>{list.data?.items.map(x => <option key={x.id} value={x.id}>{x.name} · {statusName(x.replay_status ?? '')}</option>)}</select></Field><input className={input} placeholder="新会话名称（可选）" value={name} onChange={e => setName(e.target.value)} /><div className="grid grid-cols-2 gap-2"><input className={input} type="date" value={start} onChange={e => setStart(e.target.value)} /><input className={input} type="date" value={end} onChange={e => setEnd(e.target.value)} /></div><button className={button} disabled={create.isPending} onClick={() => create.mutate()}>创建独立回放会话</button></div>
}

function Records({ data, done }: { data: PaperSnapshot; done: () => void }) {
  const [tab, setTab] = useState<RecordTab>('orders')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const all = data[tab] as Array<Record<string, unknown>>
  const filtered = useMemo(() => status ? all.filter(x => x.status === status) : all, [all, status])
  const rows = filtered.slice((page - 1) * 12, page * 12)
  const cancelOrder = useMutation({ mutationFn: (id: string) => api.paperCancelOrder(data.account.id, id), onSuccess: done })
  const cancelCondition = useMutation({ mutationFn: (id: string) => api.paperCancelCondition(data.account.id, id), onSuccess: done })
  useEffect(() => setPage(1), [tab, status, data.account.id])
  return <Panel title="模拟盘操作记录"><div className="mb-3 flex flex-wrap gap-1.5">{(['orders', 'fills', 'conditions', 'ledger'] as RecordTab[]).map(x => <button key={x} onClick={() => setTab(x)} className={`${button} h-8 px-2.5 text-xs ${tab === x ? 'border-accent text-accent' : ''}`}>{({ orders: '订单', fills: '成交', conditions: '条件单', ledger: '账户流水' })[x]}</button>)}{(tab === 'orders' || tab === 'conditions') && <select className={`${input} ml-auto w-28`} value={status} onChange={e => setStatus(e.target.value)}><option value="">全部状态</option><option value="queued">待激活</option><option value="active">活动</option><option value="armed">监控中</option><option value="filled">已成交</option><option value="cancelled">已撤销</option><option value="rejected">已拒绝</option></select>}</div><div className="max-h-[360px] overflow-auto"><table className="w-full min-w-[760px] text-left text-xs"><thead className="sticky top-0 bg-surface text-muted"><tr><th className="py-2">时间</th><th>标的 / 类型</th><th>方向</th><th>数量</th><th>价格 / 金额</th><th>状态</th><th>原因</th><th className="text-right">操作</th></tr></thead><tbody className="divide-y divide-border">{rows.map((row, i) => { const id = String(row.id ?? i); const active = ['queued', 'active'].includes(String(row.status)); const armed = ['armed', 'waiting_sellable'].includes(String(row.status)); return <tr key={id}><td className="py-2.5 text-muted">{time(String(row.submitted_at ?? row.filled_at ?? row.created_at ?? row.occurred_at ?? ''))}</td><td>{String(row.symbol ?? row.event_type ?? '—')}</td><td>{row.side === 'buy' ? '买入' : row.side === 'sell' ? '卖出' : '—'}</td><td>{String(row.quantity ?? '—')}</td><td>{money(Number(row.trigger_price ?? row.price ?? row.filled_price ?? row.limit_price ?? row.amount))}</td><td>{statusName(String(row.status ?? '已记账'))}</td><td className="max-w-48 truncate text-muted" title={String(row.reason ?? row.note ?? '')}>{String(row.reason ?? row.note ?? '—')}</td><td className="text-right">{active && <button className="text-accent" onClick={() => window.confirm('确认撤销该模拟订单？') && cancelOrder.mutate(id)}>撤单</button>}{armed && <button className="text-accent" onClick={() => window.confirm('确认取消该条件单？') && cancelCondition.mutate(id)}>取消</button>}</td></tr> })}</tbody></table>{!rows.length && <div className="py-12 text-center text-sm text-muted">暂无记录</div>}</div><div className="mt-3 flex justify-end gap-2 text-xs"><button className={button} disabled={page === 1} onClick={() => setPage(x => x - 1)}>上一页</button><span className="self-center text-muted">{page} / {Math.max(1, Math.ceil(filtered.length / 12))}</span><button className={button} disabled={page * 12 >= filtered.length} onClick={() => setPage(x => x + 1)}>下一页</button></div></Panel>
}

function PositionRecords({ data, symbol, done }: { data: PaperSnapshot; symbol: string; done: () => void }) {
  const [tab, setTab] = useState<RecordTab>('orders')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const all = useMemo(
    () => (data[tab] as Array<Record<string, unknown>>).filter(row => String(row.symbol ?? '') === symbol),
    [data, symbol, tab],
  )
  const filtered = useMemo(() => status ? all.filter(row => String(row.status ?? '') === status) : all, [all, status])
  const rows = filtered.slice((page - 1) * 12, page * 12)
  const cancelOrder = useMutation({ mutationFn: (id: string) => api.paperCancelOrder(data.account.id, id), onSuccess: done })
  const cancelCondition = useMutation({ mutationFn: (id: string) => api.paperCancelCondition(data.account.id, id), onSuccess: done })
  useEffect(() => setPage(1), [tab, status, symbol, data.account.id])
  const tabNames: Record<RecordTab, string> = { orders: '订单', fills: '成交', conditions: '条件单', ledger: '账户流水' }
  return (
    <section className="mt-4 border-t border-border pt-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">该标的操作记录</h3>
        <span className="text-xs text-muted">{filtered.length} 条</span>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {(['orders', 'fills', 'conditions', 'ledger'] as RecordTab[]).map(item => (
          <button key={item} type="button" onClick={() => setTab(item)} className={`${button} h-8 px-2.5 text-xs ${tab === item ? 'border-accent text-accent' : ''}`}>{tabNames[item]}</button>
        ))}
        {(tab === 'orders' || tab === 'conditions') && (
          <select className={`${input} ml-auto w-28`} value={status} onChange={event => setStatus(event.target.value)}>
            <option value="">全部状态</option>
            <option value="queued">待激活</option>
            <option value="active">活动</option>
            <option value="armed">监控中</option>
            <option value="filled">已成交</option>
            <option value="cancelled">已撤销</option>
            <option value="rejected">已拒绝</option>
          </select>
        )}
      </div>
      <div className="max-h-72 overflow-auto">
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead className="sticky top-0 bg-surface text-muted">
            <tr>
              <th className="py-2">时间</th>
              <th>标的 / 类型</th>
              <th>方向</th>
              <th>数量</th>
              <th>价格 / 金额</th>
              <th>状态</th>
              <th>原因</th>
              <th className="text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row, index) => {
              const id = String(row.id ?? index)
              const active = ['queued', 'active'].includes(String(row.status))
              const armed = ['armed', 'waiting_sellable'].includes(String(row.status))
              const rawValue = row.trigger_price ?? row.price ?? row.filled_price ?? row.limit_price ?? row.amount
              const note = String(row.reason ?? row.note ?? row.event_type ?? '')
              return (
                <tr key={id}>
                  <td className="py-2.5 text-muted">{time(String(row.submitted_at ?? row.filled_at ?? row.created_at ?? row.occurred_at ?? ''))}</td>
                  <td>{String(row.symbol ?? row.event_type ?? '—')}</td>
                  <td>{row.side === 'buy' ? '买入' : row.side === 'sell' ? '卖出' : '—'}</td>
                  <td>{String(row.quantity ?? '—')}</td>
                  <td>{rawValue == null ? '—' : money(Number(rawValue))}</td>
                  <td>{statusName(String(row.status ?? '已记账'))}</td>
                  <td className="max-w-48 truncate text-muted" title={note}>{note || '—'}</td>
                  <td className="text-right">
                    {active && <button type="button" className="text-accent" onClick={() => window.confirm('确认撤销该模拟订单？') && cancelOrder.mutate(id)}>撤单</button>}
                    {armed && <button type="button" className="text-accent" onClick={() => window.confirm('确认取消该条件单？') && cancelCondition.mutate(id)}>取消</button>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!rows.length && <div className="py-12 text-center text-sm text-muted">暂无该标的{tabNames[tab]}记录</div>}
      </div>
      <div className="mt-3 flex justify-end gap-2 text-xs">
        <button type="button" className={button} disabled={page === 1} onClick={() => setPage(value => value - 1)}>上一页</button>
        <span className="self-center text-muted">{page} / {Math.max(1, Math.ceil(filtered.length / 12))}</span>
        <button type="button" className={button} disabled={page * 12 >= filtered.length} onClick={() => setPage(value => value + 1)}>下一页</button>
      </div>
    </section>
  )
}

export function ETFSimulation() {
  const client = useQueryClient()
  const [mode, setMode] = useState<Mode>('live')
  const [replayId, setReplayId] = useState('')
  const [symbol, setSymbol] = useState('')
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false)
  const [manualPositionOpen, setManualPositionOpen] = useState(false)
  const [editingPosition, setEditingPosition] = useState<PaperPosition | null>(null)
  const [previewPosition, setPreviewPosition] = useState<{ symbol: string; name: string } | null>(null)
  const [positionDetails, setPositionDetails] = useState<PaperPosition | null>(null)
  const positionClickTimer = useRef<number | null>(null)
  const [liveNow, setLiveNow] = useState(() => new Date())
  const accountKey = mode === 'live' ? 'live' : replayId
  const snapshot = useQuery({ queryKey: QK.paperSnapshot(accountKey), queryFn: () => api.paperSnapshot(mode === 'replay' ? replayId : undefined), enabled: mode === 'live' || Boolean(replayId) })
  const setupRequired = mode === 'live'
    && Boolean(snapshot.data && 'setup_required' in snapshot.data && snapshot.data.setup_required)
  const data = snapshot.data && 'account' in snapshot.data ? snapshot.data : undefined
  const refresh = () => { void snapshot.refetch() }
  useEffect(() => {
    if (setupRequired) setAccountSettingsOpen(true)
  }, [setupRequired])
  const finishAccountSettings = async () => {
    const result = await snapshot.refetch()
    if (result.data && 'account' in result.data) setAccountSettingsOpen(false)
  }
  const finishManualPosition = async () => {
    await snapshot.refetch()
    setManualPositionOpen(false)
    setEditingPosition(null)
  }
  const openManualPosition = (position: PaperPosition | null = null) => {
    setEditingPosition(position)
    setManualPositionOpen(true)
  }
  const closeManualPosition = () => {
    setManualPositionOpen(false)
    setEditingPosition(null)
  }
  const openPositionPreview = (position: PaperPosition) => {
    setSymbol(position.symbol)
    if (positionClickTimer.current != null) window.clearTimeout(positionClickTimer.current)
    positionClickTimer.current = window.setTimeout(() => {
      setPreviewPosition({ symbol: position.symbol, name: position.name || position.symbol })
      positionClickTimer.current = null
    }, 220)
  }
  const handlePositionDoubleClick = (position: PaperPosition) => {
    if (positionClickTimer.current != null) {
      window.clearTimeout(positionClickTimer.current)
      positionClickTimer.current = null
    }
    if (position.editable) openManualPosition(position)
  }
  useEffect(() => () => {
    if (positionClickTimer.current != null) window.clearTimeout(positionClickTimer.current)
  }, [])
  useEffect(() => {
    if (mode !== 'live') return
    setLiveNow(new Date())
    const timer = window.setInterval(() => setLiveNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [mode])
  const liveClock = useMemo(() => getBeijingPaperClock(liveNow), [liveNow])
  const replayClock = useMemo<PaperTradingClock | null>(() => {
    if (!data?.clock) return null
    const minutes = parsePaperClockMinutes(data.clock)
    return minutes == null ? null : { display: time(data.clock), minutes, tradingDay: true }
  }, [data?.clock])
  const paperClock = mode === 'live' ? liveClock : replayClock
  useEffect(() => { if (!data?.account.id) return; const es = new EventSource(`/api/paper-trading/stream?account_id=${encodeURIComponent(data.account.id)}`); es.addEventListener('paper_revision', () => { void client.invalidateQueries({ queryKey: QK.paperSnapshot(accountKey) }) }); return () => es.close() }, [accountKey, client, data?.account.id])
  useEffect(() => { if (!symbol && data?.positions[0]) setSymbol(data.positions[0].symbol) }, [data?.positions, symbol])
  const control = useMutation({ mutationFn: (x: { action: 'play' | 'pause' | 'archive'; speed?: number }) => api.paperControlReplay(replayId, x.action, x.speed), onSuccess: (_result, variables) => { refresh(); if (variables.action === 'archive') void client.invalidateQueries({ queryKey: QK.paperArchivedAccounts }) } })
  const step = useMutation({ mutationFn: () => api.paperStepReplay(replayId, PAPER_TRADING_STEP_MINUTES), onSuccess: refresh })
  const rebuild = useMutation({ mutationFn: api.paperRebuildLive, onSuccess: () => { refresh(); void client.invalidateQueries({ queryKey: QK.paperArchivedAccounts }) } })
  const [metricsExpanded, setMetricsExpanded] = useState(false)
  const cards = data ? [['总资产', `¥${money(data.summary.equity)}`], ['现金', `¥${money(data.summary.cash)}`], ['持仓市值', `¥${money(data.summary.market_value)}`], ['当前仓位', pct(data.summary.exposure_pct)], ['累计盈亏', `¥${money(data.summary.total_pnl)}`], ['当日盈亏', `¥${money(data.summary.daily_pnl)}`], ['累计收益', pct(data.summary.total_return)], ['最大回撤', pct(data.summary.max_drawdown)], ['已实现', `¥${money(data.summary.realized_pnl)}`], ['未实现', `¥${money(data.summary.unrealized_pnl)}`]] : []
  return (
    <div className="flex min-h-full flex-col bg-base">
      <PageHeader
        title="ETF 模拟交易"
        right={
          <div className="inline-flex rounded-btn border border-border bg-surface p-0.5">
            {(['live', 'replay'] as Mode[]).map(x => (
              <button
                key={x}
                onClick={() => setMode(x)}
                className={'h-8 rounded-[5px] px-3 text-xs font-medium ' + (mode === x ? 'bg-accent text-white' : 'text-secondary')}
              >
                {x === 'live' ? '实时模拟' : '历史回放'}
              </button>
            ))}
          </div>
        }
      />
      <main className="flex-1 space-y-3 px-3 pb-4 pt-3 lg:px-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-surface px-3 py-2 text-xs">
          <span className="font-medium">北京时间 / {mode === 'live' ? '实时钟' : '回放时钟'}：{paperClock?.display ?? '—'}</span>
          <span className="text-secondary">状态：{setupRequired ? '待设置' : data ? statusName(data.account.runtime_status) : '加载中'}</span>
          <span className="text-muted">{setupRequired ? '请先命名并保存模拟账户' : data?.account.runtime_message || (mode === 'live' ? '实时按已完成 1 分钟 K 撮合' : '回放按 15 分钟步长推进')}</span>
          <span className="ml-auto text-muted" title="当前模拟账户">账户：{data?.account.name ?? (setupRequired ? '待设置' : '加载中')}</span>
          <button
            type="button"
            disabled={!data}
            onClick={() => setAccountSettingsOpen(true)}
            aria-label="打开账户设置"
            title={data ? '账户设置' : '账户设置（账户加载中）'}
            className="inline-flex h-7 w-7 items-center justify-center rounded-btn text-muted transition-colors hover:bg-elevated/70 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Settings className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <TradingSessionTimeline clock={paperClock} />
        </div>
        <div className="grid items-start gap-3 xl:grid-cols-[280px_minmax(0,1fr)]">
          <div className="space-y-3 xl:sticky xl:top-3">
            {mode === 'replay' && (
              <Panel title="历史回放">
                <ReplayPicker selected={replayId} choose={setReplayId} />
                {data && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      className={button}
                      onClick={() => control.mutate({ action: data.account.replay_status === 'running' ? 'pause' : 'play', speed: data.account.replay_speed })}
                    >
                      {data.account.replay_status === 'running' ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                      {data.account.replay_status === 'running' ? '暂停' : '播放'}
                    </button>
                    <button className={button} disabled={step.isPending} onClick={() => step.mutate()}>
                      <StepForward className="h-4 w-4" />
                      单步 {PAPER_TRADING_STEP_MINUTES} 分钟
                    </button>
                    <select
                      className={input + ' w-24'}
                      value={data.account.replay_speed}
                      onChange={e => control.mutate({ action: data.account.replay_status === 'running' ? 'play' : 'pause', speed: Number(e.target.value) })}
                    >
                      {[1, 2, 5, 10, 30, 60].map(x => <option key={x} value={x}>{x} K/秒</option>)}
                    </select>
                    <button title="归档" className={button} onClick={() => window.confirm('确认归档该回放会话？') && control.mutate({ action: 'archive' })}>
                      <Archive className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </Panel>
            )}
            {data && (
              <Panel title="交易控制">
                <PaperTradingControls data={data} selectedSymbol={symbol} onSelectedSymbolChange={setSymbol} done={refresh} />
              </Panel>
            )}
          </div>
          <div className="min-w-0 space-y-3">
            {!data && (
              <Panel title="账户">
                <div className="py-20 text-center text-sm text-muted">
                  {setupRequired ? '请先完成账户设置' : snapshot.isError ? '账户加载失败' : mode === 'replay' ? '请先选择或创建回放会话' : '正在加载模拟账户…'}
                </div>
              </Panel>
            )}
            {data && (
              <>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
                  {cards.map(([label, value], index) => (
                    <div key={label} className={`rounded-xl border border-border bg-surface p-3 ${!metricsExpanded ? index >= 8 ? 'hidden md:hidden' : index >= 4 ? 'hidden md:block' : '' : ''}`}>
                      <div className="text-[11px] text-muted">{label}</div>
                      <div className="mt-1 truncate text-sm font-semibold">{value}</div>
                    </div>
                  ))}
                </div>
                {cards.length > 4 && <button type="button" className="mx-auto flex h-4 w-full items-center justify-center text-muted transition-colors hover:text-foreground" aria-label={metricsExpanded ? '收起指标' : '展开更多指标'} title={metricsExpanded ? '收起指标' : '展开更多指标'} aria-expanded={metricsExpanded} onClick={() => setMetricsExpanded(value => !value)}>{metricsExpanded ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}</button>}
                <div className="grid gap-3 2xl:grid-cols-2">
                  <Panel title="账户收益">
                    <EquityChart rows={data.equity_curve} />
                  </Panel>
                </div>
                <Panel title={<div className="flex items-center justify-between gap-2"><span>当前持仓</span>{!data.account.archived && <button type="button" className="rounded-btn px-2 py-1 text-xs font-normal text-accent transition-colors hover:bg-elevated" onClick={() => openManualPosition()}>手动添加</button>}</div>}>
                  <div className="overflow-auto">
                    <table className="w-full min-w-[820px] text-left text-xs">
                      <thead className="text-muted">
                        <tr>
                          <th className="pb-2">标的</th>
                          <th>数量</th>
                          <th>可卖 / 冻结</th>
                          <th>成本</th>
                          <th>现价</th>
                          <th>市值</th>
                          <th>未实现盈亏</th>
                          <th>价格时间</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {data.positions.map(p => (
                          <tr key={p.symbol} className="cursor-pointer hover:bg-elevated/50" title={p.editable ? '点击标的查看K线，点击其他列查看持仓详情，双击编辑手动持仓' : '点击标的查看K线，点击其他列查看持仓详情'} onClick={() => setPositionDetails(p)} onDoubleClick={() => handlePositionDoubleClick(p)}>
                            <td className="py-2.5 font-medium" title="查看K线" onClick={event => { event.stopPropagation(); openPositionPreview(p) }}>{p.name || p.symbol}<span className="ml-1 text-muted">{p.symbol}</span></td>
                            <td>{p.quantity}</td>
                            <td>{p.available_quantity} / {p.quantity - p.available_quantity}</td>
                            <td>{price(p.average_cost)}</td>
                            <td>{price(p.last_price)}</td>
                            <td>{money(p.market_value)}</td>
                            <td className={p.unrealized_pnl >= 0 ? 'text-bull' : 'text-bear'}>{money(p.unrealized_pnl)} · {pct(p.unrealized_pnl_pct)}</td>
                            <td className="text-muted">{shortTime(p.price_time)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!data.positions.length && <div className="py-10 text-center text-sm text-muted">暂无持仓</div>}
                  </div>
                </Panel>
                <Records data={data} done={refresh} />
              </>
            )}
          </div>
        </div>
      </main>
      <StockPreviewDialog
        symbol={previewPosition?.symbol ?? null}
        name={previewPosition?.name}
        onClose={() => setPreviewPosition(null)}
        navList={data ? toNavItems(data.positions) : []}
        onNavigate={(symbol, name) => setPreviewPosition({ symbol, name: name ?? symbol })}
      />
      {positionDetails && (
        <Modal
          onClose={() => setPositionDetails(null)}
          labelledBy="paper-position-details-title"
          panelClassName="w-[92vw] max-w-2xl max-h-[88vh] rounded-xl border border-border bg-surface shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 id="paper-position-details-title" className="flex items-center gap-2 text-sm font-semibold">
              <Settings className="h-4 w-4 text-accent" aria-hidden="true" />
              持仓详情
            </h2>
            <button
              type="button"
              onClick={() => setPositionDetails(null)}
              className="rounded-btn p-1 text-muted transition-colors hover:bg-elevated hover:text-foreground"
              aria-label="关闭持仓详情"
              title="关闭"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div className="max-h-[calc(88vh-4rem)] overflow-y-auto p-4">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm md:grid-cols-4">
              <div className="col-span-2 rounded-btn border border-border/70 bg-base/40 px-3 py-2 md:col-span-4">
                <dt className="text-xs text-muted">标的</dt>
                <dd className="mt-1 font-medium">{positionDetails.name || positionDetails.symbol}<span className="ml-1 text-xs font-normal text-muted">{positionDetails.symbol}</span></dd>
                {data && <PositionDescriptionEditor
                  accountId={data.account.id}
                  symbol={positionDetails.symbol}
                  description={positionDetails.description}
                  archived={Boolean(data.account.archived)}
                  done={refresh}
                />}
              </div>
              <div><dt className="text-xs text-muted">持仓数量</dt><dd className="mt-1 font-medium tabular-nums">{positionDetails.quantity.toLocaleString('zh-CN')}</dd></div>
              <div><dt className="text-xs text-muted">持仓类型</dt><dd className="mt-1 font-medium">{positionDetails.editable ? '手动持仓' : '交易持仓'}</dd></div>
              <div><dt className="text-xs text-muted">可卖数量</dt><dd className="mt-1 font-medium tabular-nums">{positionDetails.available_quantity.toLocaleString('zh-CN')}</dd></div>
              <div><dt className="text-xs text-muted">冻结数量</dt><dd className="mt-1 font-medium tabular-nums">{positionDetails.reserved_quantity.toLocaleString('zh-CN')}</dd></div>
              <div><dt className="text-xs text-muted">平均成本</dt><dd className="mt-1 font-medium tabular-nums">{price(positionDetails.average_cost)}</dd></div>
              <div><dt className="text-xs text-muted">现价</dt><dd className="mt-1 font-medium tabular-nums">{price(positionDetails.last_price)}</dd></div>
              <div className="col-span-2 md:col-span-2"><dt className="text-xs text-muted">市值</dt><dd className="mt-1 font-medium tabular-nums">{money(positionDetails.market_value)}</dd></div>
              <div className="col-span-2 grid grid-cols-2 gap-x-3 gap-y-2 md:col-span-4 md:grid-cols-4">
                <div><dt className="text-xs text-muted">未实现盈亏</dt><dd className={`mt-1 font-medium tabular-nums ${positionDetails.unrealized_pnl >= 0 ? 'text-bull' : 'text-bear'}`}>{money(positionDetails.unrealized_pnl)}</dd></div>
                <div><dt className="text-xs text-muted">盈亏比例</dt><dd className={`mt-1 font-medium tabular-nums ${positionDetails.unrealized_pnl_pct >= 0 ? 'text-bull' : 'text-bear'}`}>{pct(positionDetails.unrealized_pnl_pct)}</dd></div>
              </div>
            </dl>
            <section className="mt-4 border-t border-border pt-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">持仓收益走势</h3>
                <span className="text-xs text-muted">净值 · 累计收益 · 回撤</span>
              </div>
              <PositionEquityChart rows={data?.position_equity_curves?.[positionDetails.symbol] ?? []} />
            </section>
            {data && <PositionRecords data={data} symbol={positionDetails.symbol} done={refresh} />}
          </div>
        </Modal>
      )}
      {manualPositionOpen && data && (
        <Modal
          onClose={closeManualPosition}
          labelledBy="paper-manual-position-title"
          panelClassName="w-[92vw] max-w-md rounded-xl border border-border bg-surface shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 id="paper-manual-position-title" className="text-sm font-semibold">{editingPosition ? '手动编辑持仓' : '手动添加持仓'}</h2>
            <button
              type="button"
              onClick={closeManualPosition}
              className="rounded-btn p-1 text-muted transition-colors hover:bg-elevated hover:text-foreground"
              aria-label={editingPosition ? '关闭手动编辑持仓' : '关闭手动添加持仓'}
              title="关闭"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div className="p-4">
            <ManualPositionForm key={editingPosition?.symbol ?? 'new'} data={data} position={editingPosition} done={finishManualPosition} />
          </div>
        </Modal>
      )}
      {accountSettingsOpen && (data || setupRequired) && (
        <Modal
          onClose={() => { if (!setupRequired) setAccountSettingsOpen(false) }}
          labelledBy="paper-account-settings-title"
          panelClassName="w-[92vw] max-w-xl max-h-[88vh] rounded-xl border border-border bg-surface shadow-xl"
          closeOnBackdrop={!setupRequired}
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 id="paper-account-settings-title" className="flex items-center gap-2 text-sm font-semibold">
              <Settings className="h-4 w-4 text-accent" aria-hidden="true" />
              账户设置
            </h2>
            {!setupRequired && <button
              type="button"
              onClick={() => setAccountSettingsOpen(false)}
              className="rounded-btn p-1 text-muted transition-colors hover:bg-elevated hover:text-foreground"
              aria-label="关闭账户设置"
              title="关闭"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>}
          </div>
          <div className="max-h-[calc(88vh-4rem)] overflow-y-auto p-4">
            <AccountForm data={data ?? null} done={finishAccountSettings} />
            {data && mode === 'live' && (
              <button
                className={button + ' mt-3 text-xs'}
                disabled={rebuild.isPending}
                onClick={() => window.confirm('旧账户会被归档，随后需要填写新账户名称。确认继续？') && rebuild.mutate()}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                归档并重建实时账户
              </button>
            )}
            <ArchivedAccounts />
          </div>
        </Modal>
      )}
    </div>
  )
}
