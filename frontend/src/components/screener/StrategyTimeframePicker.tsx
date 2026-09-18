export type StrategyTimeframe = '1d' | '1w' | '30m' | '1m'

export const DEFAULT_STRATEGY_TIMEFRAMES: StrategyTimeframe[] = ['1d']

const TIMEFRAME_OPTIONS: { value: StrategyTimeframe; label: string }[] = [
  { value: '1d', label: '日线' },
  { value: '1w', label: '周线' },
  { value: '30m', label: '30F' },
  { value: '1m', label: '分钟' },
]

const TIMEFRAME_ORDER: StrategyTimeframe[] = ['1d', '1w', '30m', '1m']

export function normalizeStrategyTimeframes(value: unknown): StrategyTimeframe[] {
  const selected = Array.isArray(value)
    ? value.filter((item): item is StrategyTimeframe => TIMEFRAME_ORDER.includes(item as StrategyTimeframe))
    : []
  const normalized = TIMEFRAME_ORDER.filter(timeframe => selected.includes(timeframe))
  return normalized.length > 0 ? normalized : [...DEFAULT_STRATEGY_TIMEFRAMES]
}

export function parseStrategyTimeframes(code: string): StrategyTimeframe[] | null {
  const match = code.match(/["']timeframes["']\s*:\s*\[([^\]]*)\]/)
  if (!match) return null
  const timeframes = [...match[1].matchAll(/["'](1d|1w|30m|1m)["']/g)].map(item => item[1] as StrategyTimeframe)
  return timeframes.length > 0 ? normalizeStrategyTimeframes(timeframes) : null
}

export function applyStrategyTimeframes(code: string, timeframes: StrategyTimeframe[]): string {
  if (!code) return code
  const value = `[${normalizeStrategyTimeframes(timeframes).map(timeframe => JSON.stringify(timeframe)).join(', ')}]`
  const replaced = code.replace(
    /(["']timeframes["']\s*:\s*)\[[^\]]*\]/,
    `$1${value}`,
  )
  if (replaced !== code) return replaced

  // 允许后端/AI 生成的 META 漏掉字段时, 仍能由界面选择补齐。
  return code.replace(
    /(META\s*=\s*\{)/,
    `$1\n    "timeframes": ${value},`,
  )
}

export function StrategyTimeframePicker({
  timeframes,
  onChange,
  disabled = false,
}: {
  timeframes: StrategyTimeframe[]
  onChange?: (timeframes: StrategyTimeframe[]) => void
  disabled?: boolean
}) {
  const toggle = (timeframe: StrategyTimeframe) => {
    if (disabled || !onChange) return
    const next = timeframes.includes(timeframe)
      ? timeframes.filter(item => item !== timeframe)
      : [...timeframes, timeframe]
    if (next.length > 0) onChange(normalizeStrategyTimeframes(next))
  }

  return (
    <div>
      <span className="text-[10px] text-muted/50 uppercase tracking-wider mb-1.5 block">适用周期（可多选）</span>
      <div className="flex flex-wrap items-center gap-1">
        {TIMEFRAME_OPTIONS.map(option => (
          <button
            key={option.value}
            type="button"
            aria-pressed={timeframes.includes(option.value)}
            disabled={disabled}
            onClick={() => toggle(option.value)}
            className={'px-2.5 py-1 rounded text-[11px] font-medium border transition-colors ' + (
              timeframes.includes(option.value)
                ? 'border-accent/40 bg-accent/10 text-accent'
                : 'border-border bg-base text-muted hover:border-accent/30'
            ) + (disabled ? ' cursor-not-allowed opacity-70' : '')}
          >
            {option.label}
          </button>
        ))}
        <span className="ml-1 self-center text-[10px] text-muted/50">
          {timeframes.length === 1 ? `仅${TIMEFRAME_OPTIONS.find(option => option.value === timeframes[0])?.label ?? '日线'}` : `共${timeframes.length}个周期`}
        </span>
      </div>
      <p className="mt-1 text-[10px] text-muted/40">30F 需要对应资产的历史分钟 K；分钟策略仅适用于专门的分钟数据逻辑。</p>
    </div>
  )
}
