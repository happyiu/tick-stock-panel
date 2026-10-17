import { useEffect, useMemo, useState } from 'react'
import { chartTheme, getTheme } from '@/lib/theme'
import type { KlineRow, LevelSeries, LevelType, PriceLevel } from '@/lib/api'
import { fmtAssetPrice } from '@/lib/format'
export type { LevelType, PriceLevel } from '@/lib/api'

/** 当前主题的图表调色板。 */
const CT = () => chartTheme(getTheme())

/** 价位组开关配置:label = 按钮文案,color = markLine 颜色 */
export const LEVEL_GROUPS: { key: LevelType; label: string; color: string }[] = [
  { key: 'sr',       label: '压力支撑',  color: '#F97316' },   // 橙(成交密集区,价量驱动)
  { key: 'pivot',    label: '枢轴点',    color: '#8B5CF6' },   // 紫
  { key: 'extreme',  label: '前高前低',  color: '#EAB308' },   // 黄
  { key: 'boll',     label: '布林带',    color: '#F97316' },   // 橙(MA20±2σ 曲线)
  { key: 'keltner_s',label: 'Keltner短期',  color: '#06B6D4' },   // 青(MA20±2ATR 曲线)
  { key: 'keltner_m',label: 'Keltner中期',  color: '#22D3EE' },   // 浅青(MA60±2.5ATR 曲线)
  { key: 'keltner_l',label: 'Keltner长期',  color: '#67E8F9' },   // 更浅青(MA120±3ATR 曲线)
  { key: 'atr_stop', label: 'ATR波动通道',  color: '#EF4444' },   // 红(警示)
  { key: 'gap',      label: '缺口位',    color: '#EC4899' },   // 粉
  { key: 'fib',      label: '斐波那契',  color: '#F59E0B' },   // 金
  { key: 'round',    label: '整数关口',  color: '#71717A' },   // 灰(心理位,弱视觉)
]

// 通道曲线元数据(单一数据源):供图表画线 + 右侧面板取最新值共用。
//   alignedKey: alignedSeries 中的 key(由 series.boll/keltner/atr 对齐而来)
//   group:      属于哪个价位开关组(开关该组即开关这条曲线)
//   endLabel:   右侧端点标签(显示最新值的文字)
const CURVE_DEFS: { alignedKey: string; group: LevelType; endLabel: string; color: string; dashed?: boolean }[] = [
  { alignedKey: 'boll_upper',     group: 'boll',      endLabel: '布林上轨', color: '#F97316', dashed: true },
  { alignedKey: 'boll_lower',     group: 'boll',      endLabel: '布林下轨', color: '#F97316', dashed: true },
  { alignedKey: 'boll_mid',       group: 'boll',      endLabel: '布林中轨', color: '#FB923C', dashed: false },
  { alignedKey: 'keltner_s_upper',group: 'keltner_s', endLabel: 'Keltner短上', color: '#06B6D4', dashed: true },
  { alignedKey: 'keltner_s_lower',group: 'keltner_s', endLabel: 'Keltner短下', color: '#06B6D4', dashed: true },
  { alignedKey: 'keltner_m_upper',group: 'keltner_m', endLabel: 'Keltner中上', color: '#22D3EE', dashed: true },
  { alignedKey: 'keltner_m_lower',group: 'keltner_m', endLabel: 'Keltner中下', color: '#22D3EE', dashed: true },
  { alignedKey: 'keltner_l_upper',group: 'keltner_l', endLabel: 'Keltner长上', color: '#67E8F9', dashed: true },
  { alignedKey: 'keltner_l_lower',group: 'keltner_l', endLabel: 'Keltner长下', color: '#67E8F9', dashed: true },
  { alignedKey: 'atr_stop',       group: 'atr_stop',  endLabel: 'ATR下轨', color: '#EF4444', dashed: true },
  { alignedKey: 'atr_tp',         group: 'atr_stop',  endLabel: 'ATR上轨', color: '#F87171', dashed: true },
]

interface PriceLevelData {
  rows: KlineRow[]
  levels?: Record<LevelType, PriceLevel[]>
  series?: LevelSeries
  seriesDates?: string[]
  defaultLevelTypes?: LevelType[]
  assetType?: string
}

/** 两个页面共享开关、档位过滤及日期对齐，不在前端重算金融指标。 */
export function usePriceLevels({ rows, levels, series, seriesDates, defaultLevelTypes = [], assetType }: PriceLevelData) {
  const [activeTypes, setActiveTypes] = useState<Set<LevelType>>(new Set(defaultLevelTypes))
  /** 枢轴点显示到第几档:1=只P+R1/S1, 2=到R2/S2, 3=全档(R3/S3) */
  const [pivotRank, setPivotRank] = useState<1 | 2 | 3>(1)
  /** 双向联动高亮: hover 价位标签 ↔ hover 下方文字行。值为 levelKey, null=无高亮 */
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)

  useEffect(() => { setHoveredKey(null) }, [levels])

  // 数据预处理 + 带状曲线序列对齐(后端 series 的日期范围可能与 rows 不同,需映射)
  const { dates, alignedSeries } = useMemo(() => {
    const dates = rows.map(r => (typeof r.date === 'string' ? r.date.slice(0, 10) : String(r.date)))
    // 把后端 series(按 seriesDates 对齐)映射到前端 rows 的 dates 顺序
    const alignedSeries: Record<string, (number | null)[]> = {}
    if (series && seriesDates && seriesDates.length > 0) {
      // 构建 seriesDates 索引
      const sIdx = new Map(seriesDates.map((d, i) => [d, i]))
      // 通用对齐:给定 series 里某条数组,返回与 rows dates 对齐的版本
      const align = (arr: (number | null)[] | undefined): (number | null)[] => {
        if (!arr) return dates.map(() => null)
        return dates.map(d => {
          const i = sIdx.get(d)
          return i != null ? arr[i] : null
        })
      }
      if (series.boll) {
        alignedSeries['boll_upper'] = align(series.boll.upper)
        alignedSeries['boll_lower'] = align(series.boll.lower)
        if (series.boll.mid) alignedSeries['boll_mid'] = align(series.boll.mid)
      }
      if (series.keltner_s) {
        alignedSeries['keltner_s_upper'] = align(series.keltner_s.upper)
        alignedSeries['keltner_s_lower'] = align(series.keltner_s.lower)
      }
      if (series.keltner_m) {
        alignedSeries['keltner_m_upper'] = align(series.keltner_m.upper)
        alignedSeries['keltner_m_lower'] = align(series.keltner_m.lower)
      }
      if (series.keltner_l) {
        alignedSeries['keltner_l_upper'] = align(series.keltner_l.upper)
        alignedSeries['keltner_l_lower'] = align(series.keltner_l.lower)
      }
      if (series.atr) {
        alignedSeries['atr_stop'] = align(series.atr.stop_loss)
        alignedSeries['atr_tp'] = align(series.atr.take_profit)
      }
    }

    return { dates, alignedSeries }
  }, [rows, series, seriesDates])

  const priceLines = useMemo(() => collectPriceLines(levels, activeTypes, pivotRank).map(line => ({
    ...line, key: levelKey(line.type, line.value, assetType),
  })), [levels, activeTypes, pivotRank, assetType])
  const priceCurves = useMemo(() => CURVE_DEFS.filter(def => activeTypes.has(def.group) && alignedSeries[def.alignedKey]).map(def => ({
    key: def.group, label: def.endLabel, color: def.color, dashed: def.dashed,
    data: dates.map((date, i) => ({ date, value: alignedSeries[def.alignedKey]?.[i] ?? null })),
  })), [activeTypes, dates, alignedSeries])
  const data = useMemo(() => rows.map((row, i) => ({ ...row, date: dates[i] })), [rows, dates])
  const toggleType = (t: LevelType) => {
    setHoveredKey(null)
    setActiveTypes(prev => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      return next
    })
  }

  return { data, priceLines, priceCurves, activeTypes, pivotRank, setPivotRank, hoveredKey, setHoveredKey, toggleType }
}

export function PriceLevelControls({ levels, activeTypes, pivotRank, setPivotRank, toggleType }: {
  levels: Record<LevelType, PriceLevel[]>
} & Pick<ReturnType<typeof usePriceLevels>, 'activeTypes' | 'pivotRank' | 'setPivotRank' | 'toggleType'>) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 mb-2">
      <span className="text-[10px] text-muted mr-1">关键价位</span>
      {LEVEL_GROUPS.map(g => {
        const active = activeTypes.has(g.key)
        // 枢轴点数量按当前档位过滤显示;其他组显示原始数量
        const raw = levels[g.key] ?? []
        const count = g.key === 'pivot'
          ? raw.filter(p => p.rank === undefined || p.rank <= pivotRank).length
          : raw.length
        return (
          <button
            key={g.key}
            type="button"
            aria-pressed={active}
            onClick={() => toggleType(g.key)}
            disabled={raw.length === 0}
            title={`${g.label} (${count} 个)`}
            className={`inline-flex items-center gap-1 h-6 px-2 rounded-md text-[10px] font-medium border transition-all disabled:opacity-30 disabled:cursor-not-allowed ${
              active
                ? 'text-foreground'
                : 'text-muted bg-base/40 border-border/30 hover:border-border/60'
            }`}
            style={active ? { borderColor: g.color + '66', backgroundColor: g.color + '1a' } : undefined}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: active ? g.color : '#52525B' }} />
            {g.label}
            <span className="opacity-50">{count}</span>
          </button>
        )
      })}

      {/* 枢轴点档位选择器 —— 仅当枢轴点开启时显示 */}
      {activeTypes.has('pivot') && (levels.pivot?.length ?? 0) > 0 && (
        <div className="inline-flex items-center gap-0.5 ml-1 pl-2 border-l border-border/40">
          <span className="text-[10px] text-muted mr-1">档位</span>
          {([1, 2, 3] as const).map(r => (
            <button
              key={r}
              type="button"
              aria-pressed={pivotRank === r}
              onClick={() => setPivotRank(r)}
              title={r === 1 ? 'P + R1/S1(3 个)' : r === 2 ? '到 R2/S2(5 个)' : '全档 R3/S3(7 个)'}
              className={`h-6 px-2 rounded-md text-[10px] font-mono border transition-all ${
                pivotRank === r
                  ? 'bg-[#8B5CF6]/15 border-[#8B5CF6]/40 text-[#c4b5fd]'
                  : 'text-muted bg-base/40 border-border/30 hover:border-border/60'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ===== 价位统计面板(图表下方,结构化文本展示) =====
export function LevelOverview({
  levels, activeTypes, pivotRank, close, assetType, hoveredKey, onHover, compact = false,
}: {
  levels: Record<LevelType, PriceLevel[]>
  activeTypes: Set<LevelType>
  pivotRank: 1 | 2 | 3
  compact?: boolean
  close?: number
  assetType?: string
  hoveredKey: string | null
  onHover: (k: string | null) => void
}) {
  // 收集当前显示的点位(同 collectPriceLines 的过滤逻辑)
  const visible: PriceLevel[] = []
  for (const g of LEVEL_GROUPS) {
    if (!activeTypes.has(g.key)) continue
    for (const p of levels[g.key] ?? []) {
      if (p.type === 'pivot' && p.rank !== undefined && p.rank > pivotRank) continue
      visible.push(p)
    }
  }
  if (visible.length === 0) return null

  // 按方向分两组:压力位(在当前价之上) / 支撑位(之下),各自按距当前价远近排序
  const cur = close ?? visible[0].value
  const resistances = visible
    .filter(p => p.side === 'resistance')
    .sort((a, b) => a.value - b.value)        // 由近及远(低→高)
  const supports = visible
    .filter(p => p.side === 'support')
    .sort((a, b) => b.value - a.value)         // 由近及远(高→低)
  const neutrals = visible.filter(p => p.side === 'neutral')

  const fmtPct = (v: number) => {
    if (!cur) return ''
    const pct = ((v - cur) / cur) * 100
    const sign = pct >= 0 ? '+' : ''
    return `${sign}${pct.toFixed(1)}%`
  }

  const renderRow = (p: PriceLevel, key: string) => {
    const color = LEVEL_GROUPS.find(g => g.key === p.type)?.color ?? CT().text
    const k = levelKey(p.type, p.value, assetType)
    const hit = hoveredKey === k
    const dim = hoveredKey != null && !hit
    return (
      <div
        key={key}
        onMouseEnter={() => onHover(k)}
        onMouseLeave={() => onHover(null)}
        className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 py-0.5 px-1.5 -mx-1.5 rounded transition-colors cursor-default ${
          hit ? 'bg-elevated/60' : ''
        }`}
        style={dim ? { opacity: 0.35 } : undefined}
      >
        <span className="h-1.5 w-1.5 rounded-full shrink-0 transition-transform" style={{ backgroundColor: color, transform: hit ? 'scale(1.5)' : 'scale(1)' }} />
        <span className={`text-[11px] min-w-0 flex-1 truncate ${hit ? 'text-foreground font-medium' : 'text-secondary'}`} title={p.label}>{p.label}</span>
        <span className={`text-[11px] font-mono ${hit ? 'text-foreground font-bold' : 'text-foreground'}`}>{fmtAssetPrice(p.value, assetType)}</span>
        <span className="text-[9px] font-mono text-muted">{fmtPct(p.value)}</span>
      </div>
    )
  }

  return (
    <div className={`mt-3 grid grid-cols-1 ${compact ? "" : "sm:grid-cols-2"} gap-x-6 gap-y-1 rounded-lg border border-border/40 bg-base/20 px-3 py-2`}>
      {/* 当前价 */}
      <div className={`${compact ? "" : "sm:col-span-2"} flex items-center gap-2 pb-1 border-b border-border/30 mb-0.5`}>
        <span className="text-[10px] text-muted">当前价</span>
        <span className="text-xs font-mono font-medium text-foreground">{fmtAssetPrice(cur, assetType)}</span>
      </div>
      {/* 压力位(从近到远,即从低到高)倒序展示:最高的在最上 */}
      {resistances.length > 0 && (
        <div>
          <div className="text-[10px] font-medium text-bear mb-0.5">压力位 ↑</div>
          {[...resistances].reverse().map((p, i) => renderRow(p, `r-${i}`))}
        </div>
      )}
      {/* 支撑位 + 中性(枢轴位 P) */}
      <div>
        {supports.length > 0 && (
          <>
            <div className="text-[10px] font-medium text-bull mb-0.5">支撑位 ↓</div>
            {supports.map((p, i) => renderRow(p, `s-${i}`))}
          </>
        )}
        {neutrals.length > 0 && (
          <div className={supports.length > 0 ? 'mt-2' : ''}>
            {supports.length === 0 && <div className="text-[10px] font-medium text-muted mb-0.5">枢轴位</div>}
            {neutrals.map((p, i) => renderRow(p, `n-${i}`))}
          </div>
        )}
      </div>
    </div>
  )
}

// ===== 工具:收集要画的水平价位线(按开启的组 + 档位 + 强度配色) =====
// 注意:带状指标(布林带/Keltner/ATR)改用曲线渲染,不在此画水平线,避免重复。
function collectPriceLines(
  levels: Record<LevelType, PriceLevel[]> | undefined,
  active: Set<LevelType>,
  pivotRank: 1 | 2 | 3,
): { value: number; label: string; color: string; type: string }[] {
  if (!levels) return []
  const out: { value: number; label: string; color: string; type: string }[] = []
  for (const g of LEVEL_GROUPS) {
    if (!active.has(g.key)) continue
    for (const p of levels[g.key] ?? []) {
      // 枢轴点:按档位过滤(rank>P 的,只显示到选定的档位)
      if (p.type === 'pivot' && p.rank !== undefined && p.rank > pivotRank) continue
      // 波动通道类(boll / keltner三档 / atr_stop)整组走曲线渲染,不画水平线;
      // sr 组现为成交密集区水平点,直接画线即可,无需特判。
      if (p.type === 'boll' || p.type === 'keltner_s' || p.type === 'keltner_m'
          || p.type === 'keltner_l' || p.type === 'atr_stop') continue
      out.push({ value: p.value, label: p.label, color: strengthColor(p.strength, g.color), type: p.type })
    }
  }
  return out
}

function strengthColor(strength: string | undefined, base: string): string {
  // strong 用实色,medium 用 0.85,weak 用 0.55 透明
  if (strength === 'weak') return base + '8C'
  if (strength === 'medium') return base + 'D9'
  return base
}

/** 价位唯一标识: 同类型同价格视为同一点位(用于联动高亮)。 */
function levelKey(type: string, value: number, assetType?: string): string {
  return `${type}-${fmtAssetPrice(value, assetType)}`
}
