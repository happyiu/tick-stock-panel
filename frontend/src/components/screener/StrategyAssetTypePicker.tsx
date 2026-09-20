type StrategyAssetType = 'stock' | 'etf'

export const DEFAULT_ASSET_TYPES: StrategyAssetType[] = ['stock']

const ASSET_TYPE_OPTIONS: { value: StrategyAssetType; label: string }[] = [
  { value: 'stock', label: '股票' },
  { value: 'etf', label: 'ETF' },
]

export function normalizeAssetTypes(value: unknown): StrategyAssetType[] {
  const types = Array.isArray(value)
    ? value.filter((item): item is StrategyAssetType => item === 'stock' || item === 'etf')
    : []
  const normalized = Array.from(new Set(types))
  return normalized.length > 0 ? normalized : [...DEFAULT_ASSET_TYPES]
}

export function parseAssetTypes(code: string): StrategyAssetType[] | null {
  const match = code.match(/["']asset_types["']\s*:\s*\[([^\]]*)\]/)
  if (!match) return null
  const types = [...match[1].matchAll(/["'](stock|etf)["']/g)].map(item => item[1] as StrategyAssetType)
  return types.length > 0 ? normalizeAssetTypes(types) : null
}

export function applyAssetTypes(code: string, assetTypes: StrategyAssetType[]): string {
  if (!code) return code
  const value = `[${assetTypes.map(assetType => JSON.stringify(assetType)).join(', ')}]`
  return code.replace(
    /(["']asset_types["']\s*:\s*)\[[^\]]*\]/,
    `$1${value}`,
  )
}

export function AssetTypePicker({
  assetTypes,
  onChange,
  disabled = false,
}: {
  assetTypes: StrategyAssetType[]
  onChange?: (assetTypes: StrategyAssetType[]) => void
  disabled?: boolean
}) {
  const toggle = (assetType: StrategyAssetType) => {
    if (disabled || !onChange) return
    const next = assetTypes.includes(assetType)
      ? assetTypes.filter(item => item !== assetType)
      : [...assetTypes, assetType]
    if (next.length > 0) onChange(next)
  }

  return (
    <div>
      <span className="text-[10px] text-muted/50 uppercase tracking-wider mb-1.5 block">适用资产（可多选）</span>
      <div className="flex gap-1">
        {ASSET_TYPE_OPTIONS.map(option => (
          <button
            key={option.value}
            type="button"
            aria-pressed={assetTypes.includes(option.value)}
            disabled={disabled}
            onClick={() => toggle(option.value)}
            className={'px-2.5 py-1 rounded text-[11px] font-medium border transition-colors ' + (
              assetTypes.includes(option.value)
                ? 'border-accent/40 bg-accent/10 text-accent'
                : 'border-border bg-base text-muted hover:border-accent/30'
            ) + (disabled ? ' cursor-not-allowed opacity-70' : '')}
          >
            {option.label}
          </button>
        ))}
        <span className="ml-1 self-center text-[10px] text-muted/50">
          {assetTypes.length === 2 ? '股票与 ETF 均可用' : `仅${assetTypes[0] === 'etf' ? 'ETF' : '股票'}`}
        </span>
      </div>
    </div>
  )
}

export type { StrategyAssetType }
