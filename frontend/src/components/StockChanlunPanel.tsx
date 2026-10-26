import { useEffect, useState } from 'react'
import type { KlinePeriod } from '@/lib/api'
import {
  CHANLUN_OVERVIEW_PERIODS, CHANLUN_PERIOD_LABELS, miniTrendPoints, multiPeriodHeadline,
  overviewPeriod, periodPresentation, type ChanlunPeriodItem,
} from '@/lib/chanlunPresentation'
import './StockChanlunPanel.css'
import { StockChanlunInterpretation } from './StockChanlunInterpretation'

export interface StockChanlunPanelProps {
  items: ChanlunPeriodItem[]
  period: KlinePeriod
  asOf?: string | null
  hideDates?: boolean
  assetType?: string
}

export function StockChanlunPanel({ items, period, asOf, hideDates = false, assetType }: StockChanlunPanelProps) {
  const [selected, setSelected] = useState(overviewPeriod(period))
  useEffect(() => setSelected(overviewPeriod(period)), [period])
  const active = items.find(i => i.period === selected)
  const points = miniTrendPoints(active?.analysis)
  const split = Math.max(1, points.length - 5)
  const headline = multiPeriodHeadline(items)
  return <section aria-label="缠论结构概览" className="py-2.5">
    <div className="chanlun-overview" title="走势按笔中枢位置近似描述；多级为周期方向对照，尚非次级别联立确认。">
      <div className="chanlun-overview-heading">
        <div className="chanlun-overview-title"><strong>{headline}</strong><span>多级</span></div>
        {points.length > 1 && <svg className="chanlun-overview-spark" viewBox="0 0 120 44" aria-label={`${CHANLUN_PERIOD_LABELS[selected]}近期收盘走势`} role="img">
          <polyline points={points.join(' ')} fill="none" stroke="currentColor" strokeWidth="8" opacity=".15" strokeLinejoin="round" strokeLinecap="round" />
          <polyline points={points.slice(0, split + 1).join(' ')} fill="none" stroke="var(--chanlun-spark-line)" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
          <polyline points={points.slice(split).join(' ')} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
        </svg>}
      </div>
      <div className="chanlun-overview-levels" role="group" aria-label="缠论结构周期">
        {CHANLUN_OVERVIEW_PERIODS.map(value => {
          const item = items.find(i => i.period === value) ?? { period: value }
          const view = periodPresentation(item, asOf, hideDates)
          return <button key={value} type="button" className="chanlun-overview-level" aria-pressed={selected === value}
            aria-label={`${CHANLUN_PERIOD_LABELS[value]}缠论概览`} aria-busy={item.isLoading && !item.analysis}
            title={item.error?.message || item.unavailable || item.analysis?.issues.join('；') || `${CHANLUN_PERIOD_LABELS[value]}笔中枢结构概览`}
            onClick={() => { setSelected(value); if (item.error) item.onRetry?.() }}>
            <span className="chanlun-overview-period">{CHANLUN_PERIOD_LABELS[value]}</span>
            <strong className={view.direction === 'up' ? 'text-bull' : view.direction === 'down' ? 'text-bear' : 'text-secondary'}>{view.trend}</strong>
            <span className="chanlun-overview-phase">{view.phase}</span>
            <span className="chanlun-overview-signal">{view.signal}</span>
          </button>
        })}
      </div>
    </div>
    <StockChanlunInterpretation items={items} selected={selected} onSelect={setSelected} asOf={asOf} hideDates={hideDates} assetType={assetType} />
  </section>
}
