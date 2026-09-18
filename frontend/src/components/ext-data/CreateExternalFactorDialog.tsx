import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BarChart3, GitCompareArrows, Loader2, X } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { toast } from '@/components/Toast'
import { api, type ExternalFactorCategory } from '@/lib/api'
import { QK } from '@/lib/queryKeys'

type SourceMode = 'index' | 'ext' | 'difference'

const CATEGORY_LABELS: Record<ExternalFactorCategory, string> = {
  market: '市场',
  industry: '行业',
  constituents: '成分股',
  relative: '相对强弱',
  cross_market: '跨市场',
  flow: '资金流',
  liquidity: '流动性',
  sentiment: '情绪',
  valuation: '估值',
  fundamental: '基本面',
  commodity: '商品',
  event: '事件',
}

const CATEGORIES = Object.entries(CATEGORY_LABELS) as [ExternalFactorCategory, string][]
const INPUT_CLS = 'h-9 w-full rounded-lg border border-border bg-base px-3 text-xs text-foreground focus:border-accent/50 focus:outline-none'

export function CreateExternalFactorDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const [sourceMode, setSourceMode] = useState<SourceMode>('index')
  const [id, setId] = useState('ef_market_hs300_return_20')
  const [label, setLabel] = useState('沪深300 20日收益')
  const [category, setCategory] = useState<ExternalFactorCategory>('market')
  const [sourceSymbol, setSourceSymbol] = useState('000300.SH')
  const [window, setWindow] = useState(20)
  const [sourceConfigId, setSourceConfigId] = useState('')
  const [sourceField, setSourceField] = useState('')
  const [leftFactorId, setLeftFactorId] = useState('momentum_20d')
  const [rightFactorId, setRightFactorId] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')

  const extQuery = useQuery({ queryKey: QK.extData, queryFn: api.extDataList })
  const factorQuery = useQuery({ queryKey: QK.factorLibrary('all'), queryFn: () => api.factorLibrary() })
  const extConfigs = (extQuery.data?.items ?? []).filter(item => item.mode === 'timeseries')
  const activeConfig = extConfigs.find(item => item.id === sourceConfigId) ?? extConfigs[0]
  const numericFields = activeConfig?.fields.filter(field => field.dtype === 'int' || field.dtype === 'float') ?? []
  const factors = factorQuery.data?.factors ?? []

  const create = useMutation({
    mutationFn: () => api.externalFactorCreate({
      id: id.trim(),
      label: label.trim(),
      category,
      operation: sourceMode === 'difference' ? 'difference' : 'direct',
      source_type: sourceMode === 'index' ? 'index_daily' : sourceMode === 'ext' ? 'ext_timeseries' : 'factor_pair',
      source_symbol: sourceMode === 'index' ? sourceSymbol.trim() : undefined,
      source_config_id: sourceMode === 'ext' ? (sourceConfigId || activeConfig?.id) : undefined,
      source_field: sourceMode === 'ext' ? (sourceField || numericFields[0]?.name) : sourceMode === 'index' ? 'close' : undefined,
      transform: sourceMode === 'index' ? 'return' : 'value',
      window: sourceMode === 'index' ? window : 1,
      left_factor_id: sourceMode === 'difference' ? leftFactorId : undefined,
      right_factor_id: sourceMode === 'difference' ? rightFactorId : undefined,
      description: description.trim() || undefined,
      unit: 'ratio',
      asset_types: ['stock', 'etf'],
      status: 'active',
    }),
    onSuccess: result => {
      void queryClient.invalidateQueries({ queryKey: QK.factorLibrary('all') })
      void queryClient.invalidateQueries({ queryKey: QK.factorColumns })
      void queryClient.invalidateQueries({ queryKey: QK.externalFactors })
      toast(`${result.factor.label} 已创建并进入因子库`, 'success')
      onClose()
    },
    onError: value => setError(value instanceof Error ? value.message : String(value)),
  })

  const valid = Boolean(
    id.trim() && label.trim()
      && (sourceMode === 'index'
        ? sourceSymbol.trim() && Number.isInteger(window) && window >= 1
        : sourceMode === 'ext'
          ? activeConfig && (sourceField || numericFields[0]?.name)
          : leftFactorId && rightFactorId && leftFactorId !== rightFactorId),
  )

  const setMode = (mode: SourceMode) => {
    setSourceMode(mode)
    setError('')
    if (mode === 'difference') setCategory('relative')
  }

  const extFieldValue = sourceField || numericFields[0]?.name || ''
  const pairCandidates = useMemo(
    () => factors.filter(item => item.asset_types.includes('stock') || item.asset_types.includes('etf')),
    [factors],
  )

  return (
    <Modal onClose={onClose} labelledBy="external-factor-dialog-title" panelClassName="w-[92vw] max-w-2xl max-h-[88vh] overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h3 id="external-factor-dialog-title" className="text-base font-semibold text-foreground">创建外部因子</h3>
          <p className="mt-1 text-[11px] text-muted">外部数据按交易日广播到 ETF / 股票面板，不与当前标的代码做 JOIN。</p>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg p-1 text-secondary transition-colors hover:bg-elevated">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="max-h-[calc(88vh-132px)] space-y-5 overflow-y-auto px-6 py-5">
        <div className="grid grid-cols-3 gap-2 rounded-xl bg-elevated/40 p-1">
          {([
            ['index', '内置指数日线', BarChart3],
            ['ext', '时序扩展数据', BarChart3],
            ['difference', '相对强弱 A - B', GitCompareArrows],
          ] as const).map(([mode, text, Icon]) => (
            <button
              key={mode}
              type="button"
              onClick={() => setMode(mode)}
              className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium transition-colors ${sourceMode === mode ? 'bg-surface text-foreground shadow-sm' : 'text-muted hover:text-secondary'}`}
            >
              <Icon className="h-3.5 w-3.5" />
              {text}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1.5">
            <span className="text-[11px] font-medium text-secondary">显示名称</span>
            <input value={label} onChange={event => setLabel(event.target.value)} className={INPUT_CLS} placeholder="例：沪深300 20日收益" />
          </label>
          <label className="space-y-1.5">
            <span className="text-[11px] font-medium text-secondary">因子 ID</span>
            <input value={id} onChange={event => setId(event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} className={`${INPUT_CLS} font-mono`} placeholder="ef_market_hs300_return_20" />
          </label>
        </div>

        <label className="block space-y-1.5">
          <span className="text-[11px] font-medium text-secondary">因子分类</span>
          <select value={category} onChange={event => setCategory(event.target.value as ExternalFactorCategory)} className={INPUT_CLS}>
            {CATEGORIES.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select>
        </label>

        {sourceMode === 'index' && (
          <div className="grid grid-cols-[1fr_150px] gap-3 rounded-xl border border-border/60 bg-elevated/20 p-3">
            <label className="space-y-1.5">
              <span className="text-[11px] font-medium text-secondary">指数代码</span>
              <input value={sourceSymbol} onChange={event => setSourceSymbol(event.target.value.toUpperCase())} className={`${INPUT_CLS} font-mono`} placeholder="000300.SH" />
              <span className="block text-[10px] text-muted">需要先在数据页同步指数日线；例如沪深300为 000300.SH。</span>
            </label>
            <label className="space-y-1.5">
              <span className="text-[11px] font-medium text-secondary">收益窗口</span>
              <input type="number" min={1} max={512} value={window} onChange={event => setWindow(Number(event.target.value) || 1)} className={`${INPUT_CLS} font-mono`} />
              <span className="block text-[10px] text-muted">输出 close / close[-N] - 1</span>
            </label>
          </div>
        )}

        {sourceMode === 'ext' && (
          <div className="space-y-3 rounded-xl border border-border/60 bg-elevated/20 p-3">
            <label className="block space-y-1.5">
              <span className="text-[11px] font-medium text-secondary">时序扩展数据</span>
              <select value={activeConfig?.id ?? ''} onChange={event => { setSourceConfigId(event.target.value); setSourceField('') }} className={INPUT_CLS}>
                <option value="">请选择 timeseries 数据源</option>
                {extConfigs.map(item => <option key={item.id} value={item.id}>{item.label} · {item.id}</option>)}
              </select>
            </label>
            <label className="block space-y-1.5">
              <span className="text-[11px] font-medium text-secondary">数值字段</span>
              <select value={extFieldValue} onChange={event => setSourceField(event.target.value)} className={INPUT_CLS} disabled={!activeConfig}>
                <option value="">请选择数值字段</option>
                {numericFields.map(field => <option key={field.name} value={field.name}>{field.label || field.name} · {field.name}</option>)}
              </select>
            </label>
            <p className="text-[10px] leading-relaxed text-muted">同一个交易日必须只有一个有效值；如果数据含多个标的，请先在原始数据层聚合成市场/行业指标。</p>
            {!extQuery.isLoading && extConfigs.length === 0 && <p className="text-[10px] text-amber-500">暂无 timeseries 数据源，请先在数据页创建原始时序数据。</p>}
          </div>
        )}

        {sourceMode === 'difference' && (
          <div className="space-y-3 rounded-xl border border-border/60 bg-elevated/20 p-3">
            <label className="block space-y-1.5">
              <span className="text-[11px] font-medium text-secondary">左侧因子 A</span>
              <select value={leftFactorId} onChange={event => setLeftFactorId(event.target.value)} className={INPUT_CLS}>
                <option value="">请选择因子</option>
                {pairCandidates.map(item => <option key={item.id} value={item.id}>{item.label} · {item.id}</option>)}
              </select>
            </label>
            <label className="block space-y-1.5">
              <span className="text-[11px] font-medium text-secondary">右侧因子 B</span>
              <select value={rightFactorId} onChange={event => setRightFactorId(event.target.value)} className={INPUT_CLS}>
                <option value="">请选择因子</option>
                {pairCandidates.map(item => <option key={item.id} value={item.id}>{item.label} · {item.id}</option>)}
              </select>
            </label>
            <p className="text-[10px] leading-relaxed text-muted">例如 `momentum_20d - ef_market_hs300_return_20`，用于判断 ETF 是否跑赢市场基准。</p>
          </div>
        )}

        <label className="block space-y-1.5">
          <span className="text-[11px] font-medium text-secondary">描述（可选）</span>
          <input value={description} onChange={event => setDescription(event.target.value)} className={INPUT_CLS} placeholder="记录口径、来源或研究备注" />
        </label>

        {error && <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[11px] text-danger">{error}</div>}
      </div>

      <div className="flex items-center justify-between border-t border-border/50 bg-elevated/20 px-6 py-4">
        <span className="text-[10px] text-muted">首期仅支持“按日期广播”；缺失日期保持为空，不前视填充。</span>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onClose} className="rounded-lg bg-elevated px-4 py-2 text-xs text-secondary transition-colors hover:bg-elevated/80">取消</button>
          <button type="button" onClick={() => create.mutate()} disabled={!valid || create.isPending} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-5 py-2 text-xs font-medium text-base transition-colors hover:bg-accent/90 disabled:opacity-40">
            {create.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {create.isPending ? '创建中…' : '创建外部因子'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
