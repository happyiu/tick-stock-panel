import type { MarketTrendComposite } from '@/lib/marketTrendComposite'
import { useState } from 'react'
import {
  latestAngelDevilSignal,
  marketTrendAssessment,
  summarizeDailyMarketTrendHistory,
  summarizeThirtyMinuteMarketTrendHistory,
  summarizeWeeklyMarketTrendHistory,
  type MarketTrendHistoricalSegment,
  type MarketTrendPhaseHistory,
  type MarketTrendPeriod,
} from '@/lib/marketTrend'

const PERIOD_LABELS: Record<MarketTrendPeriod, string> = { '1w': '周线', '1d': '日线', '30m': '30F' }

export interface StockMarketTrendItem {
  period: MarketTrendPeriod
  rows: readonly { date: string; close: number }[]
  loading: boolean
  error: boolean
  retry: () => void
}

function formatSignalDate(date: string, period: MarketTrendPeriod) {
  const value = date.replace('T', ' ')
  return period === '30m' ? value.slice(0, 16) : value.slice(0, 10)
}

function formatPercent(value: number | null) {
  return value == null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function formatAverage(value: number | null, suffix: string, digits = 0) {
  return value == null ? '—' : `${value.toFixed(digits)}${suffix}`
}

function formatPrice(value: number) {
  return value.toFixed(value < 1 ? 3 : 2)
}

function formatHistoryDuration(days: number, period: '1w' | '1d' | '30m') {
  return period === '30m' ? `${(days * 24).toFixed(1)}小时` : `${days}天`
}

function PhaseHistoryCard({ title, phase, period, returnLabel, averageMaxLabel, averageMaxValue, maxLabel, maxValue }: {
  title: string
  phase: MarketTrendPhaseHistory
  period: '1w' | '1d' | '30m'
  returnLabel: string
  averageMaxLabel: string
  averageMaxValue: number | null
  maxLabel: string
  maxValue: number | null
}) {
  return (
    <div className="min-w-0 rounded border border-border/60 p-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <strong className="text-secondary">{title}</strong>
        <span className="text-[10px] text-muted">信号 {phase.signalCount} 次 · 完成 {phase.completedCount} 段</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-[10px]">
        <span className="text-muted">平均{ returnLabel }</span><span className="text-right font-mono text-secondary">{formatPercent(phase.averageChangePercent)}</span>
        <span className="text-muted">平均耗时</span><span className="text-right font-mono text-secondary">{period === '30m' ? formatAverage(phase.averageDurationDays == null ? null : phase.averageDurationDays * 24, '小时', 1) : formatAverage(phase.averageDurationDays, '天')}</span>
        <span className="text-muted">平均K线数</span><span className="text-right font-mono text-secondary">{formatAverage(phase.averageBarCount, ' 根', 1)}</span>
        <span className="text-muted">{averageMaxLabel}</span><span className="text-right font-mono text-secondary">{formatPercent(averageMaxValue)}</span>
        <span className="text-muted">{maxLabel}</span><span className="text-right font-mono text-secondary">{formatPercent(maxValue)}</span>
      </div>
      {phase.current && (
        <p className="mt-2 border-t border-border/40 pt-1.5 text-[10px] text-muted">
          当前进行中：{formatPercent(phase.current.changePercent)} · {formatHistoryDuration(phase.current.durationDays, period)} · {phase.current.barCount}根{period === '30m' ? '30F' : '日K'}
        </p>
      )}
    </div>
  )
}

function MarketTrendHistorySummary({ weeklyItem, dailyItem, thirtyMinuteItem }: { weeklyItem?: StockMarketTrendItem; dailyItem?: StockMarketTrendItem; thirtyMinuteItem?: StockMarketTrendItem }) {
  const [period, setPeriod] = useState<MarketTrendPeriod>('1w')
  const item = period === '1w' ? weeklyItem : period === '1d' ? dailyItem : thirtyMinuteItem
  const priceItem = period === '1w' ? dailyItem : item
  const rows = item?.rows ?? []
  const priceRows = priceItem?.rows ?? []
  const summary = period === '1w'
    ? summarizeWeeklyMarketTrendHistory(rows, priceRows)
    : period === '1d' ? summarizeDailyMarketTrendHistory(rows) : summarizeThirtyMinuteMarketTrendHistory(rows)
  const details: { key: string; title: string; segment: MarketTrendHistoricalSegment; current: boolean }[] = [
    ...summary.retreat.completed.map((segment, index) => ({ key: `retreat-${index}`, title: '撤退信号', segment, current: false })),
    ...summary.attack.completed.map((segment, index) => ({ key: `attack-${index}`, title: '进攻信号', segment, current: false })),
    ...(summary.retreat.current ? [{ key: 'retreat-current', title: '撤退信号', segment: summary.retreat.current, current: true }] : []),
    ...(summary.attack.current ? [{ key: 'attack-current', title: '进攻信号', segment: summary.attack.current, current: true }] : []),
  ].sort((a, b) => b.segment.startDate.localeCompare(a.segment.startDate))

  return (
    <div className="mt-4 border-t border-border/60 pt-3">
      <div role="tablist" aria-label="历史汇总周期" className="flex gap-4 border-b border-border/60">
        {(['1w', '1d', '30m'] as const).map(value => (
          <button key={value} type="button" role="tab" id={`market-trend-history-${value}`} aria-controls="market-trend-history-panel" aria-selected={period === value}
            className={`border-b-2 px-2 pb-2 font-medium ${period === value ? 'border-accent text-accent' : 'border-transparent text-muted'}`}
            onClick={() => setPeriod(value)}>{value === '1w' ? '周线历史汇总' : value === '1d' ? '日线历史汇总' : '30F历史汇总'}</button>
        ))}
      </div>
      <div role="tabpanel" id="market-trend-history-panel" aria-labelledby={`market-trend-history-${period}`}>
      {(item?.loading && rows.length === 0) || (priceItem?.loading && priceRows.length === 0) ? <p className="mt-2 text-[11px] text-muted">正在加载历史数据…</p>
        : (item?.error && rows.length === 0) || (priceItem?.error && priceRows.length === 0) ? <p className="mt-2 text-[11px] text-muted">历史数据加载失败</p>
          : rows.length === 0 || priceRows.length === 0 ? <p className="mt-2 text-[11px] text-muted">暂无完整的历史数据</p>
            : <>
              <p className="mt-1 text-[10px] text-muted">
                {PERIOD_LABELS[period]}信号范围：{summary.startDate ? formatSignalDate(summary.startDate, period) : '—'} 至 {summary.endDate ? formatSignalDate(summary.endDate, period) : '—'}（{period === '1w' ? `${rows.length}根周K，` : ''}{priceRows.length}根{period === '30m' ? '30F' : '日K'}）
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <PhaseHistoryCard title="撤退" phase={summary.retreat} period={period} returnLabel="跌幅" averageMaxLabel="平均最大跌幅" averageMaxValue={summary.retreat.averageMaxFallPercent} maxLabel="最大跌幅" maxValue={summary.retreat.maxFallPercent} />
                <PhaseHistoryCard title="进攻" phase={summary.attack} period={period} returnLabel="涨幅" averageMaxLabel="平均最大涨幅" averageMaxValue={summary.attack.averageMaxRisePercent} maxLabel="最大涨幅" maxValue={summary.attack.maxRisePercent} />
              </div>
              <p className="mt-2 text-[10px] text-muted">
                {period === '1w'
                  ? '周收盘确认信号后，取该周首次临时触发同向周线信号的日K收盘为起点，至反向信号周首次触发日前一根日K收盘为终点。周内首次触发为事后定位；缺少对应日K的区间不计入统计。'
                  : period === '1d' ? '日线信号以日K收盘确认，区间从信号日收盘至反向信号前一根日K收盘。'
                    : '30F信号以30分钟K线收盘确认，区间从信号K线收盘至反向信号前一根30F收盘；仅统计当前已加载的30F数据，耗时含休市时间。'}
                K线数含首尾；最大跌幅按起点到区间最低收盘价计算，最大涨幅按起点到区间最高收盘价计算。平均指标仅统计已完成区间，进行中区间统计至最新K线。
              </p>
              <details className="mt-2 rounded border border-border/60 px-2 py-1.5">
                <summary className="cursor-pointer text-[11px] font-medium text-secondary">
                  查看历史信号明细（{details.length}段，最新在前）
                </summary>
                <div className="mt-2 max-h-72 space-y-1 overflow-y-auto">
                  {details.length === 0 && <p className="text-[10px] text-muted">暂无已触发的历史交叉信号。</p>}
                  {details.map(({ key, title, segment, current }) => (
                    <details key={key} className="rounded border border-border/50 px-2 py-1.5">
                      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-x-2 text-[10px]">
                        <span className="text-secondary">{title}{current ? '（进行中）' : ''} · {formatSignalDate(segment.startDate, period)} → {formatSignalDate(segment.endDate, period)}</span>
                        <span className="font-mono text-secondary">{formatPercent(segment.changePercent)}</span>
                      </summary>
                      <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-[10px]">
                        <span className="text-muted">区间起止收盘价</span><span className="text-right font-mono text-secondary">{formatPrice(segment.startPrice)} → {formatPrice(segment.endPrice)}</span>
                        <span className="text-muted">区间涨跌</span><span className="text-right font-mono text-secondary">{formatPercent(segment.changePercent)}</span>
                        <span className="text-muted">历时</span><span className="text-right font-mono text-secondary">{formatHistoryDuration(segment.durationDays, period)}</span>
                        <span className="text-muted">K线数</span><span className="text-right font-mono text-secondary">{segment.barCount}根{period === '30m' ? '30F' : '日K'}</span>
                        <span className="text-muted">{title === '进攻信号' ? '最大涨幅' : '最大跌幅'}</span><span className="text-right font-mono text-secondary">{formatPercent(title === '进攻信号' ? segment.maxRisePercent : segment.maxFallPercent)}</span>
                      </div>
                    </details>
                  ))}
                </div>
              </details>
              {item?.error && rows.length > 0 && <p className="mt-1 text-[10px] text-muted">刷新失败，保留已有结果</p>}
            </>}
      </div>
    </div>
  )
}

export function StockMarketTrendPanel({ items, composite, compositeLoading, compositeError, onRefreshComposite }: { items: StockMarketTrendItem[]; composite?: MarketTrendComposite; compositeLoading?: boolean; compositeError?: boolean; onRefreshComposite?: () => void }) {
  const summaries = items.map(item => ({ ...item, ...latestAngelDevilSignal(item.rows) }))
  const weeklyItem = summaries.find(item => item.period === '1w')
  const dailyItem = summaries.find(item => item.period === '1d')
  const thirtyMinuteItem = summaries.find(item => item.period === '30m')
  const signalFor = (period: MarketTrendPeriod) => summaries.find(item => item.period === period)?.latest?.signal ?? null
  const thirtyMinuteLoading = summaries.find(item => item.period === '30m')?.loading === true
  const assessment = thirtyMinuteLoading ? null : marketTrendAssessment(signalFor('1w'), signalFor('1d'), signalFor('30m'))

  return (
    <section aria-label="市场趋势分析" className="space-y-4 p-3 text-xs leading-relaxed">
      {composite && <div className="space-y-2 rounded border border-border p-3" aria-label="综合趋势评分">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><strong>综合趋势分</strong>{onRefreshComposite && <button type="button" className="ml-2 text-[10px] text-accent" onClick={onRefreshComposite} disabled={compositeLoading}>刷新评分</button>}</div><strong className="font-mono text-2xl text-accent">{compositeLoading ? '计算中…' : composite.score == null ? '数据不足' : `${composite.score}/100`}</strong></div>
        <p className="text-[10px] text-muted">多空强弱评分 · 越高越偏多 · 非上涨概率 · 日线截止 {composite.asOf ?? '—'}</p>
        {composite.factors.map(factor => <div key={factor.name} className="flex flex-wrap justify-between gap-x-2"><span>{factor.name} · {factor.weight}%</span><span className="font-mono">{factor.score == null ? '数据不足' : `${factor.score.toFixed(1)} × ${factor.weight}% = ${factor.contribution!.toFixed(2)}`}</span></div>)}
        <p className="text-[10px] text-muted">30F仅提供短周期提示，波段转折以日线结构确认。</p>
        {compositeError && <p role="status" className="text-muted">刷新失败；已有结果保留，缺失项暂不可计算。</p>}
      </div>}
      <div>
        <h3 className="font-medium text-muted">各周期最近信号</h3>
        <div className="mt-2 flex min-w-0 items-center gap-2">
          <h3 className="shrink-0 font-medium text-muted">市场环境</h3>
          <p className="min-w-0 truncate text-sm font-semibold" title={assessment?.environment}>
            {assessment?.environment ?? '等待三周期有效信号'}
          </p>
        </div>
        <p className="mt-1 text-[11px] text-muted">
          {assessment?.explanation ?? '周线或日线尚无有效信号，暂不能评分。'}
        </p>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {summaries.map(item => {
            const signal = item.latest
            const label = PERIOD_LABELS[item.period]
            const state = item.loading ? '计算中…'
              : item.error && item.rows.length === 0 ? '加载失败'
                : item.rows.length === 0 ? '暂无K线'
                  : !item.hasComparableBars ? '样本不足'
                    : signal ? signal.signal === 'attack' ? '进攻' : '撤退' : '暂无交叉'
            return (
              <div key={item.period} className="min-w-0 rounded border border-border p-2 text-center">
                <span className="text-muted">{label}</span>
                <strong className={`mt-1 block truncate ${signal ? signal.signal === 'attack' ? 'text-bull' : 'text-bear' : 'text-secondary'}`}>
                  {state}
                </strong>
                {signal && <span className="mt-1 block truncate text-[10px] text-muted">{formatSignalDate(signal.date, item.period)}</span>}
                {signal && item.changePercent !== null && (
                  <span className={`mt-1 block truncate text-[10px] ${item.changePercent > 0 ? 'text-bull' : item.changePercent < 0 ? 'text-bear' : 'text-muted'}`}>
                    {item.changePercent > 0 ? '+' : ''}{item.changePercent.toFixed(2)}% · {item.barCount} k
                  </span>
                )}
                {item.error && item.rows.length > 0 && <span className="mt-1 block text-[10px] text-muted">刷新失败，保留已有结果</span>}
                {item.error && item.rows.length === 0 && (
                  <button type="button" className="mt-1 text-accent" onClick={item.retry}>重试</button>
                )}
              </div>
            )
          })}
        </div>
      </div>
      {!assessment && <p className="text-[11px] text-muted">{thirtyMinuteLoading
            ? '正在计算周线、日线和30F最近信号。'
            : '周线、日线和30F按各自最近的天使魔鬼交叉统计。'}</p>}
      <MarketTrendHistorySummary weeklyItem={weeklyItem} dailyItem={dailyItem} thirtyMinuteItem={thirtyMinuteItem} />
    </section>
  )
}
