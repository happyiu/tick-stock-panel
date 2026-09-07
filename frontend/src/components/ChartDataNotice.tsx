import type { ChartDataStatus } from '@/lib/api'

export function ChartDataNotice({ status }: { status?: ChartDataStatus }) {
  if (!status) return null
  const fetched = status.fetched_at
    ? new Date(status.fetched_at).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })
    : null
  return (
    <div className="px-1 py-1 text-[11px] text-muted break-words" role="status">
      {status.stale
        ? (fetched ? `刷新暂不可用，保留 ${fetched} 获取的行情` : '行情源暂不可用，显示本地数据（如有）。可在数据源配置中检查图表行情。')
        : `行情获取于 ${fetched}`}
      {status.data_through && ` · 数据截至 ${status.data_through.slice(0, 16)}`}
      {!status.stale && status.adjustment === 'none' && ' · 不复权'}
      {status.amount_estimated && ' · 成交额为估算值'}
    </div>
  )
}
