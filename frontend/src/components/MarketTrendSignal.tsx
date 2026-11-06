import type { MarketTrendSummary } from '@/lib/api'

export function MarketTrendSignal({ summary, loading = false, error = false, period, compact = false }: {
  summary?: MarketTrendSummary; loading?: boolean; error?: boolean; period: string; compact?: boolean
}) {
  const state = !summary ? loading ? '计算中…' : error ? '加载失败' : '暂无数据'
    : summary.status === 'error' ? '加载失败' : summary.status === 'empty' ? '暂无K线'
      : summary.status === 'insufficient' ? '样本不足' : summary.status === 'no_signal' ? '暂无交叉'
        : summary.signal === 'attack' ? '进攻' : '撤退'
  const pct = summary?.change_percent
  const tone = summary?.signal === 'attack' ? 'text-bull' : summary?.signal === 'retreat' ? 'text-bear' : 'text-muted'
  if (compact) return <div className="min-w-0 space-y-0.5 text-left text-[10px] leading-snug"
    title={`信号时间：${summary?.date ?? '—'}；数据截至：${summary?.data_through ?? '—'}${error ? '；刷新失败' : ''}`}>
    <div className="whitespace-nowrap">
      <span className="text-muted">{period === '1w' ? '周' : period === '1d' ? '日' : '30F'}：</span>
      <strong className={tone}>{state}</strong>
      {pct != null && Number.isFinite(pct) && <span className={`font-mono ${pct > 0 ? 'text-bull' : pct < 0 ? 'text-bear' : 'text-muted'}`}> · {pct > 0 ? '+' : ''}{pct.toFixed(2)}%</span>}
    </div>
    <div className="whitespace-nowrap text-muted">{summary?.date?.slice(0, 10) ?? '—'} · {summary?.bars ?? '—'}根{error && summary ? ' · 刷新失败' : ''}</div>
  </div>
  return <div className="min-w-0 space-y-0.5 text-center text-[10px] leading-snug"
    title={`仅用已收盘K线；截至 ${summary?.data_through ?? '—'}。涨跌幅从信号K线收盘价起算，K线数包含信号K线。`}>
    <strong className={`block text-xs ${tone}`}>{state}</strong>
    {summary?.date && <span className="block whitespace-nowrap text-muted">{summary.date.replace('T', ' ').slice(0, period === '30m' ? 16 : 10)}</span>}
    {pct != null && Number.isFinite(pct) && <span className={`block whitespace-nowrap font-mono ${pct > 0 ? 'text-bull' : pct < 0 ? 'text-bear' : 'text-muted'}`}>
      {pct > 0 ? '+' : ''}{pct.toFixed(2)}% · {summary?.bars ?? '—'}根
    </span>}
    {error && summary && <span className="block text-muted">刷新失败</span>}
  </div>
}
