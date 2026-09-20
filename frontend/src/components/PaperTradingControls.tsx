import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowLeftRight, CircleAlert, Link as LinkIcon, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api, type EtfTradingRule, type PaperSnapshot } from '@/lib/api'
import { QK } from '@/lib/queryKeys'

export type PaperTradingTab = 'order' | 'condition'

const input = 'h-9 w-full rounded-btn border border-border bg-base px-2.5 text-sm outline-none focus:border-accent'
const button = 'inline-flex h-9 items-center justify-center gap-1.5 rounded-btn border border-border bg-surface px-3 text-sm font-medium transition-colors hover:border-accent/50 disabled:cursor-not-allowed disabled:opacity-40'
const primary = `${button} border-accent bg-accent text-white hover:bg-accent/90`

const money = (value?: number | null) => value == null || !Number.isFinite(value)
  ? '—'
  : value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block space-y-1"><span className="text-xs text-secondary">{label}</span>{children}</label>
}

export function PaperTradingSymbolField({
  value,
  choose,
  locked = false,
}: {
  value: string
  choose: (value: string) => void
  locked?: boolean
}) {
  const [query, setQuery] = useState(value)
  useEffect(() => setQuery(value), [value])
  const result = useQuery({
    queryKey: QK.instrumentSearch(query, 'etf'),
    queryFn: () => api.instrumentSearch(query, 8, 'etf'),
    enabled: !locked && Boolean(query.trim()) && query !== value,
    staleTime: 30_000,
  })

  return (
    <div className="relative">
      <input
        className={`${input}${locked ? ' cursor-not-allowed opacity-70' : ''}`}
        placeholder="ETF 代码或名称"
        value={query}
        readOnly={locked}
        aria-readonly={locked ? 'true' : undefined}
        onChange={event => setQuery(event.target.value)}
      />
      {!locked && result.data?.results.length ? (
        <div className="absolute z-30 mt-1 max-h-48 w-full overflow-auto rounded-btn border border-border bg-elevated shadow-xl">
          {result.data.results.map(item => (
            <button
              type="button"
              key={item.symbol}
              className="flex w-full justify-between px-2.5 py-2 text-left text-sm hover:bg-surface"
              onClick={() => {
                setQuery(item.symbol)
                choose(item.symbol)
              }}
            >
              <span>{item.name}</span>
              <span className="text-muted">{item.symbol}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function RuleEditor({
  symbol,
  initialRule,
  done,
}: {
  symbol: string
  initialRule?: Pick<EtfTradingRule, 'settlement_cycle' | 'lot_size' | 'price_tick'>
  done: () => void | Promise<void>
}) {
  const [cycle, setCycle] = useState<'T0' | 'T1'>(initialRule?.settlement_cycle === 'T0' ? 'T0' : 'T1')
  const [lot, setLot] = useState(initialRule?.lot_size ?? 100)
  const [tick, setTick] = useState(initialRule?.price_tick ?? 0.001)
  const save = useMutation({
    mutationFn: () => api.paperSetRule(symbol, { settlement_cycle: cycle, lot_size: lot, price_tick: tick }),
    onSuccess: () => { void done() },
  })

  return (
    <div className="rounded-btn border border-amber-500/30 bg-amber-500/5 p-2.5">
      <div className="mb-2 flex items-center gap-1 text-xs font-medium text-amber-500">
        <CircleAlert className="h-3.5 w-3.5" />{initialRule ? '修改交易制度' : '默认 T+1，可修改'}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <select className={input} value={cycle} onChange={event => setCycle(event.target.value as 'T0' | 'T1')}>
          <option value="T1">T+1</option>
          <option value="T0">T+0</option>
        </select>
        <input title="每手股数" className={input} type="number" value={lot} onChange={event => setLot(Number(event.target.value))} />
        <input title="价格步长" className={input} type="number" step="0.001" value={tick} onChange={event => setTick(Number(event.target.value))} />
      </div>
      <button type="button" className={`${button} mt-2 h-8 text-xs`} disabled={save.isPending} onClick={() => save.mutate()}>
        {initialRule ? '保存修改' : `确认 ${symbol} 制度`}
      </button>
    </div>
  )
}

function OrderForm({
  data,
  symbol,
  select,
  symbolLocked,
  done,
}: {
  data: PaperSnapshot
  symbol: string
  select: (value: string) => void
  symbolLocked: boolean
  done: () => void | Promise<void>
}) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [kind, setKind] = useState<'market' | 'limit'>('market')
  const [quantity, setQuantity] = useState(100)
  const [quantityUnit, setQuantityUnit] = useState<'shares' | 'lots'>('shares')
  const [limit, setLimit] = useState('')
  const [editingRule, setEditingRule] = useState(false)
  const rules = useQuery({ queryKey: QK.paperRules, queryFn: api.paperRules })
  const configuredRule = rules.data?.items.find(item => item.symbol === symbol)
  const rule: EtfTradingRule | undefined = symbol
    ? (configuredRule ?? {
      symbol,
      settlement_cycle: 'T1',
      lot_size: 100,
      price_tick: 0.001,
      updated_at: null,
    })
    : undefined
  useEffect(() => setEditingRule(false), [symbol])
  const submit = useMutation({
    mutationFn: () => api.paperCreateOrder({
      account_id: data.account.id,
      idempotency_key: crypto.randomUUID(),
      symbol,
      side,
      order_type: kind,
      quantity,
      quantity_unit: quantityUnit,
      limit_price: kind === 'limit' ? Number(limit) : null,
    }),
    onSuccess: () => { void done() },
  })

  return (
    <div className="space-y-3">
      <Field label="ETF 标的">
        <PaperTradingSymbolField value={symbol} choose={select} locked={symbolLocked} />
      </Field>
      {rule && (
        <div className="flex items-center justify-between gap-2 text-xs text-secondary">
          <span>{rule.settlement_cycle} · 每手 {rule.lot_size} 股 · 价格步长 {rule.price_tick}{configuredRule ? '' : ' · 默认'}</span>
          <button type="button" className="shrink-0 text-accent hover:underline" onClick={() => setEditingRule(value => !value)}>
            {editingRule ? '收起' : '修改'}
          </button>
        </div>
      )}
      {symbol && editingRule && (
        <RuleEditor
          symbol={symbol}
          initialRule={configuredRule}
          done={async () => { setEditingRule(false); await rules.refetch(); await done() }}
        />
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label="方向">
          <select className={input} value={side} onChange={event => setSide(event.target.value as 'buy' | 'sell')}>
            <option value="buy">买入</option>
            <option value="sell">卖出</option>
          </select>
        </Field>
        <Field label="订单类型">
          <select className={input} value={kind} onChange={event => setKind(event.target.value as 'market' | 'limit')}>
            <option value="market">市价</option>
            <option value="limit">限价</option>
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-[1fr_92px] gap-2">
        <Field label={`数量（${quantityUnit === 'lots' ? '手' : '股'}）`}>
          <input
            className={input}
            type="number"
            min={1}
            step={quantityUnit === 'lots' ? 1 : rule?.lot_size ?? 100}
            value={quantity}
            onChange={event => setQuantity(Number(event.target.value))}
          />
        </Field>
        <Field label="单位">
          <select
            className={input}
            value={quantityUnit}
            onChange={event => {
              const next = event.target.value as 'shares' | 'lots'
              setQuantityUnit(next)
              setQuantity(next === 'lots' ? 1 : rule?.lot_size ?? 100)
            }}
          >
            <option value="shares">股</option>
            <option value="lots">手</option>
          </select>
        </Field>
      </div>
      <Field label="限价">
        <input
          className={input}
          disabled={kind === 'market'}
          type="number"
          step={rule?.price_tick ?? 0.001}
          value={limit}
          onChange={event => setLimit(event.target.value)}
        />
      </Field>
      <div className="flex justify-between text-xs text-muted">
        <span>可用 ¥{money(data.summary.cash)}</span>
        <span>可卖 {data.positions.find(item => item.symbol === symbol)?.available_quantity ?? 0} 股</span>
      </div>
      <button type="button" className={primary} disabled={!symbol || submit.isPending} onClick={() => submit.mutate()}>
        {side === 'buy' ? '提交买单' : '提交卖单'}
      </button>
    </div>
  )
}

function ConditionForm({
  data,
  symbol,
  select,
  symbolLocked,
  done,
}: {
  data: PaperSnapshot
  symbol: string
  select: (value: string) => void
  symbolLocked: boolean
  done: () => void | Promise<void>
}) {
  const [kind, setKind] = useState<'single' | 'oco'>('single')
  const [side, setSide] = useState<'buy' | 'sell'>('sell')
  const [direction, setDirection] = useState<'above' | 'below'>('above')
  const [quantity, setQuantity] = useState(100)
  const [quantityUnit, setQuantityUnit] = useState<'shares' | 'lots'>('shares')
  const [trigger, setTrigger] = useState('')
  const [take, setTake] = useState('')
  const [stop, setStop] = useState('')
  const submit = useMutation({
    mutationFn: () => api.paperCreateCondition({
      account_id: data.account.id,
      kind,
      symbol,
      side: kind === 'oco' ? 'sell' : side,
      direction,
      quantity,
      quantity_unit: quantityUnit,
      trigger_price: kind === 'single' ? Number(trigger) : null,
      take_profit_price: kind === 'oco' ? Number(take) : null,
      stop_loss_price: kind === 'oco' ? Number(stop) : null,
      child_order_type: 'market',
    }),
    onSuccess: () => { void done() },
  })

  return (
    <div className="space-y-3">
      <Field label="ETF 标的">
        <PaperTradingSymbolField value={symbol} choose={select} locked={symbolLocked} />
      </Field>
      <Field label="条件类型">
        <select className={input} value={kind} onChange={event => setKind(event.target.value as 'single' | 'oco')}>
          <option value="single">价格上穿 / 下穿</option>
          <option value="oco">止盈 + 止损 OCO</option>
        </select>
      </Field>
      {kind === 'single' ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <select className={input} value={side} onChange={event => setSide(event.target.value as 'buy' | 'sell')}>
              <option value="buy">买入</option>
              <option value="sell">卖出</option>
            </select>
            <select className={input} value={direction} onChange={event => setDirection(event.target.value as 'above' | 'below')}>
              <option value="above">价格上穿</option>
              <option value="below">价格下穿</option>
            </select>
          </div>
          <Field label="触发价">
            <input className={input} type="number" step="0.001" value={trigger} onChange={event => setTrigger(event.target.value)} />
          </Field>
        </>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Field label="止盈价"><input className={input} type="number" step="0.001" value={take} onChange={event => setTake(event.target.value)} /></Field>
          <Field label="止损价"><input className={input} type="number" step="0.001" value={stop} onChange={event => setStop(event.target.value)} /></Field>
        </div>
      )}
      <div className="grid grid-cols-[1fr_92px] gap-2">
        <Field label={`数量（${quantityUnit === 'lots' ? '手' : '股'}）`}>
          <input className={input} type="number" min={1} step={quantityUnit === 'lots' ? 1 : 100} value={quantity} onChange={event => setQuantity(Number(event.target.value))} />
        </Field>
        <Field label="单位">
          <select
            className={input}
            value={quantityUnit}
            onChange={event => {
              const next = event.target.value as 'shares' | 'lots'
              setQuantityUnit(next)
              setQuantity(next === 'lots' ? 1 : 100)
            }}
          >
            <option value="shares">股</option>
            <option value="lots">手</option>
          </select>
        </Field>
      </div>
      <button type="button" className={primary} disabled={!symbol || submit.isPending} onClick={() => submit.mutate()}>
        创建条件单
      </button>
      <p className="text-xs leading-5 text-muted">条件跨日有效；触发后下一分钟撮合。OCO 同分钟双触发按不利侧优先。</p>
    </div>
  )
}

export function PaperTradingControls({
  data,
  selectedSymbol,
  onSelectedSymbolChange,
  lockedSymbol,
  done,
}: {
  data: PaperSnapshot
  selectedSymbol?: string
  onSelectedSymbolChange?: (symbol: string) => void
  lockedSymbol?: string
  done: () => void | Promise<void>
}) {
  const [tab, setTab] = useState<PaperTradingTab>('order')
  const [localSymbol, setLocalSymbol] = useState('')
  const symbol = lockedSymbol ?? selectedSymbol ?? localSymbol
  const symbolLocked = Boolean(lockedSymbol)
  const select = (value: string) => {
    if (symbolLocked) return
    setLocalSymbol(value)
    onSelectedSymbolChange?.(value)
  }

  return (
    <div className="space-y-3">
      <div className="flex rounded-btn bg-elevated p-0.5">
        {(['order', 'condition'] as PaperTradingTab[]).map(item => (
          <button
            type="button"
            key={item}
            onClick={() => setTab(item)}
            className={`h-8 flex-1 rounded-[5px] text-xs ${tab === item ? 'bg-surface font-medium text-accent shadow-sm' : 'text-secondary'}`}
          >
            {item === 'order' ? '普通下单' : '条件单'}
          </button>
        ))}
      </div>
      {tab === 'order' ? (
        <OrderForm data={data} symbol={symbol} select={select} symbolLocked={symbolLocked} done={done} />
      ) : (
        <ConditionForm data={data} symbol={symbol} select={select} symbolLocked={symbolLocked} done={done} />
      )}
    </div>
  )
}

export function PaperTradingSidePanel({
  data,
  loading,
  setupRequired,
  error,
  symbol,
  name,
  onClose,
  done,
}: {
  data?: PaperSnapshot
  loading: boolean
  setupRequired: boolean
  error: boolean
  symbol: string
  name?: string
  onClose: () => void
  done: () => void | Promise<void>
}) {
  return (
    <div role="region" aria-label="交易面板" className="relative flex max-h-[min(520px,70vh)] min-h-0 w-full max-w-full shrink-0 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-lg md:h-full md:max-h-full md:w-[min(340px,32%)]">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-elevated/70 px-3 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <ArrowLeftRight className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
          <span className="truncate text-xs font-semibold text-foreground">交易</span>
          <span className="truncate text-[10px] text-muted">{symbol}{name ? ` · ${name}` : ''}</span>
        </div>
        <button type="button" onClick={onClose} className="rounded-btn p-1 text-muted transition-colors hover:bg-surface hover:text-foreground" aria-label="关闭交易" title="关闭">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {loading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm text-muted">正在加载模拟账户…</div>
      ) : setupRequired ? (
        <div className="min-h-0 overflow-y-auto p-3.5">
          <div className="rounded-btn border border-accent/20 bg-accent/5 px-3 py-2.5 text-xs leading-5 text-secondary">
            <div className="font-medium text-foreground">尚未创建实时模拟账户</div>
            <div className="mt-1">请先设置账户名称和模拟盘参数，完成后即可从详情页下单。</div>
            <Link to="/etf-simulation" onClick={onClose} className="mt-3 inline-flex items-center gap-1.5 text-accent hover:underline">
              <LinkIcon className="h-3.5 w-3.5" aria-hidden="true" />前往 ETF 模拟交易设置
            </Link>
          </div>
        </div>
      ) : error ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm text-danger">模拟账户加载失败</div>
      ) : data ? (
        <div className="min-h-0 overflow-y-auto p-3.5">
          <PaperTradingControls data={data} lockedSymbol={symbol} done={done} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm text-muted">模拟账户暂不可用</div>
      )}
    </div>
  )
}
