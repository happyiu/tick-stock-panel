import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type ChartIndicatorDefinition } from './api'
import { QK } from './queryKeys'
import { BUILTIN_MAIN_INDICATORS, BUILTIN_SUB_INDICATORS } from './kline-chart-builtins'
import { storage } from './storage'
import type { VolumeCompareConfig } from './kline-chart'

export const builtinChartDefinitions: ChartIndicatorDefinition[] = [
  ...BUILTIN_MAIN_INDICATORS.map(item => ({ ...item, pane: 'main' as const })),
  ...BUILTIN_SUB_INDICATORS.map(item => ({ ...item, pane: 'sub' as const })),
].map(item => ({ id: item.key, name: item.label, source: 'builtin', pane: item.pane,
  formula: '', description: 'KLineChart 内置指标', revision: 1, height: 'height' in item ? item.height : 100 }))

export function useChartIndicators() {
  const query = useQuery({ queryKey: QK.chartIndicators, queryFn: api.chartIndicators,
    staleTime: 10000, refetchOnWindowFocus: 'always' })
  const items = useMemo(() => [...(query.data?.items ?? []), ...builtinChartDefinitions], [query.data])
  const definitions = useMemo(() => items.map(item => ({ ...item, key: item.id, label: item.name })), [items])
  return { ...query, items, main: definitions.filter(d => d.pane === 'main'), sub: definitions.filter(d => d.pane === 'sub') }
}

/** One selection owner supplies the same request to the chart, info bar and prefetch. */
export function useChartIndicatorSelection(showMA = true) {
  const catalog = useChartIndicators()
  const [activeIndicators, setActiveIndicators] = useState<string[]>(() => {
    const sub = storage.stockPreviewSubCharts.get(['vol']), main = storage.stockPreviewMainCharts.get([])
    return [...new Set([...(Array.isArray(sub) ? sub : ['vol']), ...(Array.isArray(main) ? main : [])])].filter(key => typeof key === 'string' && key !== 'ma')
  })
  const [maVisible, setMaVisible] = useState(() => storage.stockPreviewMaVisible.get(true) !== false)
  const normalize = (config: VolumeCompareConfig) => ({ enabled: config.enabled !== false, days: Math.max(1, Math.min(20, Math.round(Number(config.days) || 1))) })
  const [volumeCompare, setVolumeCompare] = useState<VolumeCompareConfig>(() => normalize(storage.stockVolumeCompare.get({ enabled: true, days: 1 })))
  useEffect(() => {
    if (!catalog.isSuccess) return
    const known = new Set(catalog.items.map(i => i.id))
    setActiveIndicators(previous => {
      const next = previous.filter(key => known.has(key))
      if (next.length === previous.length) return previous
      storage.stockPreviewSubCharts.set(next.filter(key => catalog.sub.some(i => i.id === key)))
      storage.stockPreviewMainCharts.set(next.filter(key => catalog.main.some(i => i.id === key)))
      return next
    })
  }, [catalog.data])
  const effectiveMA = showMA && maVisible && catalog.items.some(i => i.id === 'ma')
  const indicatorRequest = useMemo(() => {
    const ids = [...new Set([...(effectiveMA ? ['ma'] : []), ...activeIndicators])].filter(key => catalog.items.some(i => i.id === key && i.source === 'custom')).sort()
    return { ids, version: catalog.items.filter(i => ids.includes(i.id)).map(i => `${i.id}:${i.revision}`).join(','), compareDays: volumeCompare.days }
  }, [effectiveMA, activeIndicators, catalog.items, volumeCompare.days])
  const toggleIndicator = useCallback((key: string) => {
    if (key === 'ma') {
      setMaVisible(previous => { storage.stockPreviewMaVisible.set(!previous); return !previous })
    } else setActiveIndicators(previous => {
      const next = previous.includes(key) ? previous.filter(k => k !== key) : [...previous, key]
      storage.stockPreviewSubCharts.set(next.filter(item => catalog.sub.some(chart => chart.key === item)))
      storage.stockPreviewMainCharts.set(next.filter(item => catalog.main.some(chart => chart.key === item)))
      return next
    })
  }, [catalog.data])
  const updateVolumeCompare = useCallback((patch: Partial<VolumeCompareConfig>) => setVolumeCompare(previous => {
    const next = normalize({ ...previous, ...patch }); storage.stockVolumeCompare.set(next); return next
  }), [])
  return { catalog, activeIndicators, effectiveMA, volumeCompare, indicatorRequest, toggleIndicator, updateVolumeCompare,
    ready: catalog.isSuccess || catalog.isError }
}

/** Charts already owning a normalized dataset (indices/price levels) share the same interpreter. */
export function useLoadedChartIndicators(rows: unknown[], symbol: string, keys: string[], period: import('./api').KlinePeriod = '1d') {
  const catalog = useChartIndicators()
  const ids = keys.filter(id => catalog.items.some(i => i.id === id && i.source === 'custom'))
  const version = catalog.items.filter(i => ids.includes(i.id)).map(i => `${i.id}:${i.revision}`).join(',')
  const query = useQuery({ queryKey: QK.chartIndicatorValues(symbol, period, version, rows),
    queryFn: () => api.evaluateChartIndicators(ids, rows, symbol, period),
    enabled: catalog.isSuccess && ids.length > 0 && rows.length > 0, staleTime: 30000 })
  return { ...query, definitions: catalog.items }
}
