import { api, type KlinePeriod } from './api'
import type { ChanlunStructureSource } from './chanlun'
import { QK } from './queryKeys'

/** 复用现有行情读取链路，服务端在相同标准化K线上计算结构。 */
export function chanlunQueryOptions(
  symbol: string,
  assetType: string,
  period: KlinePeriod,
  range: { start: string; end: string },
  days: number,
  source: ChanlunStructureSource,
  asOf: string | null,
  revision = 0,
) {
  return {
    queryKey: QK.chanlun(symbol, assetType, period, range.start, range.end, days, source, asOf, revision),
    queryFn: async () => {
      const options = { source, asOf }
      const response = period === '1d'
        ? await api.klineDaily(symbol, undefined, range, undefined, false, options)
        : await api.klinePeriod(symbol, period, range, days, false, options)
      if (!response.chanlun) throw new Error('缠论计算结果缺失，请更新后端后重试。')
      if (response.chanlun.ruleVersion !== 4) throw new Error('缠论规则版本不匹配，请更新后端。')
      if (['invalid_data', 'unsupported', 'engine_unavailable'].includes(response.chanlun.status)) throw new Error(response.chanlun.issues[0] ?? '缠论计算失败')
      return response.chanlun
    },
    staleTime: 30_000,
    gcTime: 60_000,
    retry: false,
  }
}
