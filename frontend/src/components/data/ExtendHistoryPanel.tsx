import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { MissingCapChip } from '@/lib/capability-labels'

// hasCap: 日K批量能力当前是否可用 (路由矩阵判定, 生效源含插件/自定义源)
export function ExtendHistoryPanel({ hasCap, isRunning, earliestDate, onStart, assetType = 'stock' }: {
  hasCap: boolean
  isRunning: boolean
  earliestDate: string | null
  onStart: () => void
  assetType?: 'stock' | 'etf'
}) {
  const qc = useQueryClient()
  const [value, setValue] = useState(assetType === 'etf' ? 1 : 6)
  const [unit, setUnit] = useState<'month' | 'year'>(assetType === 'etf' ? 'year' : 'month')
  const [mode, setMode] = useState<'extend' | 'range'>('extend')
  const [rangeStart, setRangeStart] = useState('')
  const [rangeEnd, setRangeEnd] = useState('')
  const hasBatchCap = hasCap
  const rangeInvalid = !!rangeStart && !!rangeEnd && rangeStart > rangeEnd
  const canStart = mode === 'range'
    ? !!rangeStart && !!rangeEnd && !rangeInvalid
    : !!earliestDate

  const extend = useMutation({
    mutationFn: () => assetType === 'etf'
      ? api.extendEtfHistory(
          value,
          unit,
          mode === 'range' ? { start: rangeStart, end: rangeEnd } : undefined,
        )
      : api.extendHistory(value, unit),
    onSuccess: () => {
      onStart()
      qc.invalidateQueries({ queryKey: QK.pipelineJobs })
      qc.invalidateQueries({ queryKey: QK.dataStatus })
    },
  })

  const offsetDays = unit === 'month' ? value * 30 : value * 365
  const estimate = earliestDate
    ? (() => {
        const d = new Date(earliestDate)
        d.setDate(d.getDate() - offsetDays)
        return d.toISOString().slice(0, 10)
      })()
    : null

  return (
    <div className="px-4 pb-4 pt-3 border-t border-accent/20 space-y-3">
      <div className="text-[10px] text-secondary">
        {mode === 'range' ? '按指定日期区间补齐 ETF 历史数据' : `向前扩展${assetType === 'etf' ? ' ETF' : ''}历史数据`}
      </div>

      {assetType === 'etf' && (
        <div className="flex rounded-btn border border-border overflow-hidden">
          {(['extend', 'range'] as const).map(item => (
            <button
              key={item}
              onClick={() => setMode(item)}
              disabled={isRunning}
              className={`flex-1 px-2 py-1 text-[10px] font-medium transition-colors ${
                mode === item ? 'bg-accent/15 text-accent' : 'text-secondary hover:bg-elevated'
              }`}
            >{item === 'extend' ? '向前扩展' : '指定区间补齐'}</button>
          ))}
        </div>
      )}

      {mode === 'range' ? (
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1 text-[10px] text-muted">
            <span>开始日期</span>
            <input
              type="date"
              value={rangeStart}
              onChange={event => setRangeStart(event.target.value)}
              disabled={!hasBatchCap || isRunning}
              className="h-7 w-full rounded-btn border border-border bg-base px-2 text-[11px] font-mono text-foreground disabled:opacity-40"
            />
          </label>
          <label className="space-y-1 text-[10px] text-muted">
            <span>结束日期</span>
            <input
              type="date"
              value={rangeEnd}
              onChange={event => setRangeEnd(event.target.value)}
              disabled={!hasBatchCap || isRunning}
              className="h-7 w-full rounded-btn border border-border bg-base px-2 text-[11px] font-mono text-foreground disabled:opacity-40"
            />
          </label>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <div className="flex items-center">
            <button
              onClick={() => setValue(Math.max(1, value - 1))}
              disabled={!hasBatchCap || isRunning}
              className="h-6 w-6 flex items-center justify-center rounded-l-btn bg-elevated border border-border text-secondary hover:bg-border/50 disabled:opacity-30 transition-colors text-xs"
            >−</button>
            <div className="h-6 w-8 flex items-center justify-center border-y border-border text-[11px] font-mono tabular-nums text-foreground bg-base">
              {value}
            </div>
            <button
              onClick={() => setValue(Math.min(unit === 'year' ? 10 : 36, value + 1))}
              disabled={!hasBatchCap || isRunning}
              className="h-6 w-6 flex items-center justify-center rounded-r-btn bg-elevated border border-border text-secondary hover:bg-border/50 disabled:opacity-30 transition-colors text-xs"
            >+</button>
          </div>

          <div className="flex rounded-btn border border-border overflow-hidden">
            {(['month', 'year'] as const).map(u => (
              <button
                key={u}
                onClick={() => { setUnit(u); if (u === 'year' && value > 10) setValue(1); if (u === 'month' && value > 36) setValue(6) }}
                className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                  unit === u ? 'bg-accent/15 text-accent' : 'text-secondary hover:bg-elevated'
                }`}
              >{u === 'month' ? '月' : '年'}</button>
            ))}
          </div>
        </div>
      )}

      {mode === 'range' && rangeInvalid && (
        <div className="text-[10px] text-danger">开始日期不能晚于结束日期</div>
      )}

      {mode === 'extend' && estimate && (
        <div className="text-[10px] text-muted">
          预计扩展至 <span className="font-mono text-secondary">{estimate}</span>
          {earliestDate && <span> (当前最早: <span className="font-mono text-secondary">{earliestDate}</span>)</span>}
        </div>
      )}

      {mode === 'range' && (
        <div className="text-[10px] text-muted">
          会重新拉取该区间的全部 ETF 标的，已有数据自动合并，不会清除其他历史数据。
        </div>
      )}

      <button
        onClick={() => extend.mutate()}
        disabled={!hasBatchCap || isRunning || extend.isPending || !canStart}
        className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-btn bg-accent/90 text-base text-xs font-medium hover:bg-accent disabled:opacity-40 disabled:pointer-events-none transition-colors duration-150"
      >
        {extend.isPending ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin" />
            请求中…
          </>
        ) : (
          <>{mode === 'range' ? '补齐指定区间' : '获取数据'}</>
        )}
      </button>

      {extend.isError && (
        <div className="text-[10px] text-danger">启动失败: {String((extend.error as any)?.message ?? extend.error)}</div>
      )}

      {!hasBatchCap && (
        <MissingCapChip capKey="kline.daily.batch" />
      )}
    </div>
  )
}
