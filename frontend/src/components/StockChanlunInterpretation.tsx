import { Fragment, useEffect, useId, useState } from 'react'
import type { ChanlunInterpretation, ChanlunProjection } from '@/lib/chanlun'
import { ChanlunProjectionDetails } from './ChanlunProjectionDetails'
import {
  activeChanlunSignals, chanlunPriceLevels, CHANLUN_OVERVIEW_PERIODS, CHANLUN_PERIOD_LABELS,
  periodPresentation, signalCode, type ChanlunOverviewPeriod, type ChanlunPeriodItem,
} from '@/lib/chanlunPresentation'
import { fmtAssetPrice, fmtPct } from '@/lib/format'

const SIGNAL_NAMES = {
  first_buy: '一买观察', second_buy: '二买观察', third_buy: '三买观察',
  first_sell: '一卖观察', second_sell: '二卖观察', third_sell: '三卖观察',
}

const STAGES = [
  { key: 'forming', label: '中枢形成', hint: '三笔产生重叠区间', description: '采用官方有效笔中枢；至少三笔形成核心重叠区间，边界相等时也保留。' },
  { key: 'oscillating', label: '中枢震荡', hint: '围绕中枢往返', description: '中枢包含更多笔，或已闭合K线曾离开后回到区间。阶段是本项目的展示规则。' },
  { key: 'leaving', label: '离开中枢', hint: '观察离开与回抽', description: '已闭合K线收盘越过最新中枢边界，继续观察后续笔与回抽；穿越边界不直接确认三类信号。' },
  { key: 'diverging', label: '背驰', hint: '当前暂未提供', description: '当前未提供背驰分析，不能依据空结果判断没有背驰，也不能由辅助信号推导背驰阶段。' },
]

function StructureFlow({ interpretation, macdAvailable }: { interpretation: ChanlunInterpretation; macdAvailable: boolean }) {
  const id = useId().replace(/:/g, '')
  const [help, setHelp] = useState<number | null>(null)
  const stages = macdAvailable ? STAGES.map((s, i) => i === 3 ? { ...s, hint: '仅供MACD观察', description: '图上提供官方MACD背驰条件观察；单次命中不足以确认严格趋势背驰，也不用于自动切换当前阶段。' } : s) : STAGES
  const stage = STAGES.findIndex(s => s.key === interpretation.phase.key)
  return <>
    <div className="chanlun-flow" role="group" aria-label="走势分析阶段流程图">
      <svg viewBox="0 0 360 530" preserveAspectRatio="none" aria-hidden="true">
        <defs><marker id={`${id}-arrow`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M1 1 L7 4 L1 7" fill="none" stroke="context-stroke" /></marker></defs>
        <g fill="none" markerEnd={`url(#${id}-arrow)`}>
          {[0, 1, 2].map(i => <path key={i} className={`chanlun-flow-main${stage === i && i < 2 ? ' outgoing' : ''}`} d={`M180 ${102 + i * 132} V${149 + i * 132}`} />)}
          <path className={`chanlun-flow-renew${stage === 2 ? ' outgoing' : ''}`} d="M95 325 H48 Q22 325 22 299 V87 Q22 61 48 61 H92" />
          <path className={`chanlun-flow-return${stage === 2 ? ' outgoing' : ''}`} d="M267 325 C314 325 314 193 268 193" />
          <path className="chanlun-flow-turn" d="M267 457 H315 Q342 457 342 430 V88 Q342 61 315 61 H268" />
        </g>
      </svg>
      {['延伸', '突破', '比较力度'].map((text, i) => <span key={text} className={`chanlun-flow-edge${stage === i && i < 2 ? ' outgoing' : ''}`} style={{ left: '50%', top: `${24 + i * 25}%` }}>{text}</span>)}
      <span className="chanlun-flow-edge renew">中枢新生</span><span className="chanlun-flow-edge return">回到中枢</span><span className="chanlun-flow-edge turn">转折</span>
      {stages.map((s, i) => <button key={s.key} type="button" className={`chanlun-flow-node${stage === i ? ' active' : ''}${i === 3 && !macdAvailable ? ' unavailable' : ''}`}
        style={{ top: `${(20 + i * 132) / 530 * 100}%` }} aria-pressed={stage === i}
        aria-label={`${s.label}，${stage === i ? interpretation.phase.subtitle : s.hint}，查看阶段说明`} onClick={() => setHelp(help === i ? null : i)}>
        <strong>{stage === i && <span aria-hidden="true">● </span>}{s.label}</strong>
        {stage === i ? <><span className="chanlun-flow-subtitle">{interpretation.phase.subtitle}</span><small>窗口内第 {interpretation.centerOrdinal} 个中枢</small></> : i === 3 && <small>{s.hint}</small>}
      </button>)}
    </div>
    {help != null && <p className="chanlun-detail-note" role="status"><strong>{stages[help].label}：</strong>{stages[help].description}</p>}
  </>
}

function Observation({ item, title, onSelect }: { item?: ChanlunPeriodItem; title: string; onSelect?: () => void }) {
  const interpretation = !item?.error && !item?.unavailable ? item?.analysis?.interpretation : undefined
  return <div className="chanlun-observation-card">
    {onSelect ? <button type="button" className="chanlun-observation-caption" onClick={onSelect}>{title}<span aria-hidden="true">›</span></button> : <span className="chanlun-observation-caption">{title}</span>}
    <strong>{interpretation?.observation.title ?? (item ? periodPresentation(item).trend : '当前未接入该级别')}</strong>
    {interpretation ? interpretation.observation.conditions.length ? <ul className="chanlun-condition-list">{interpretation.observation.conditions.map(c => <li key={c.id} className={c.warning ? 'warning' : ''}>
      <span className={c.state === 'met' ? 'met' : ''} aria-label={c.warning ? '重新评估条件' : c.state === 'met' ? '已出现' : '待观察'}>{c.warning ? '△' : c.state === 'met' ? '✓' : '○'}</span><span>{c.text}</span>
    </li>)}</ul> : <p className="chanlun-detail-note">{interpretation.phase.description}</p>
      : <p className="chanlun-detail-note">{item?.error?.message || item?.unavailable || (item?.isLoading ? '周期结构正在计算。' : item ? '暂无可用的中枢观察条件。' : '当前仅提供周线、日线和30分钟对照，其他级别的确认条件暂不可用。')}</p>}
  </div>
}

export function StockChanlunInterpretation({ items, selected, onSelect, asOf, hideDates, assetType,
  projectionEnabled = false, projection, projectionError, projectionSelection, onProjectionBranchSelect }: {
  items: ChanlunPeriodItem[]; selected: ChanlunOverviewPeriod; onSelect: (period: ChanlunOverviewPeriod) => void
  asOf?: string | null; hideDates: boolean; assetType?: string
  projectionEnabled?: boolean; projection?: ChanlunProjection | null; projectionError?: string
  projectionSelection?: { id: number | null; revision: number } | null; onProjectionBranchSelect?: (id: number | null) => void
}) {
  const id = useId()
  type View = 'trend' | 'next' | 'projection'
  const [tab, setTab] = useState<View>('trend')
  const visibleTab = !projectionEnabled && tab === 'projection' ? 'trend' : tab
  const tabs: View[] = projectionEnabled ? ['trend', 'next', 'projection'] : ['trend', 'next']
  useEffect(() => {
    if (projectionEnabled) setTab('projection')
    else setTab(previous => previous === 'projection' ? 'trend' : previous)
  }, [projectionEnabled, projectionSelection])
  const [allSignals, setAllSignals] = useState(false)
  useEffect(() => setAllSignals(false), [selected])
  const item = items.find(i => i.period === selected)
  const analysis = item?.analysis
  const interpretation = analysis?.interpretation
  const view = periodPresentation(item ?? { period: selected }, asOf, hideDates)
  const error = item?.error?.message || item?.unavailable || (analysis && ['invalid_data', 'engine_unavailable', 'unsupported'].includes(analysis.status) ? analysis.issues[0] || '结构计算暂不可用' : undefined)
  const signals = activeChanlunSignals(analysis, asOf)
  const levels = chanlunPriceLevels(items, selected, asOf)
  const index = CHANLUN_OVERVIEW_PERIODS.indexOf(selected)
  const label = CHANLUN_PERIOD_LABELS[selected]
  const price = (value: number) => fmtAssetPrice(value, assetType)
  return <section className="chanlun-interpretation" aria-label="缠论结构解读">
    <div className="chanlun-content-tabs" role="tablist" aria-label="缠论解读视角" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (tabs.indexOf(visibleTab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
      setTab(tabs[nextIndex])
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[nextIndex].focus()
    }}>
      {tabs.map(value => <button key={value} type="button" role="tab" id={`${id}-${value}`} aria-selected={visibleTab === value}
        aria-controls={`${id}-panel`} tabIndex={visibleTab === value ? 0 : -1} onClick={() => setTab(value)}>{value === 'trend' ? '走势分析' : value === 'next' ? '下一步观察' : '条件推演'}</button>)}
    </div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${visibleTab}`} className="chanlun-detail-card">
      {visibleTab === 'projection' ? <ChanlunProjectionDetails projection={projection} selected={projectionSelection?.id ?? null}
        onSelect={id => onProjectionBranchSelect?.(id)} hideDates={hideDates} assetType={assetType} error={projectionError} />
        : error ? <div className="chanlun-detail-empty" role="alert"><p>{label}分析暂不可用：{error}</p>{item?.onRetry && <button type="button" onClick={item.onRetry}>重新加载</button>}</div>
        : !analysis ? <p className="chanlun-detail-empty" role="status">{item?.isLoading ? '正在计算' : '等待读取'}{label}结构…</p>
        : !interpretation ? <p className="chanlun-detail-empty">{analysis?.status === 'ready' ? '结构解读尚未返回，请重新计算。' : '当前结构不足，等待已闭合K线形成有效笔和中枢。'}</p>
        : visibleTab === 'trend' ? <>
          <h3 className="chanlun-detail-heading">{label} · {interpretation.phase.label} · {interpretation.phase.subtitle}</h3>
          {analysis?.latestCenter && <div className="chanlun-walk-formula">
            <span>当前走势 {view.trend}：</span>
            <div className="chanlun-formula-parts"><span>a</span><span>＋</span><span className="chanlun-formula-center">中枢</span><span>＋</span><span>b</span></div>
            <details><summary>查看笔与中枢</summary>
              <p>中枢区间 {price(analysis.latestCenter.zd)}—{price(analysis.latestCenter.zg)} · {analysis.latestCenter.componentCount} 笔</p>
              {!hideDates && <p>首次可知 {analysis.latestCenter.formedAt}</p>}
              {interpretation.legs.map(leg => <p key={leg.label}>{leg.label}：{leg.strokes.length ? leg.strokes.map(s => `${s.direction === 'up' ? '向上' : '向下'} ${price(s.startPrice)} → ${price(s.endPrice)}（${s.confirmed ? '已完成' : '未完成'}）`).join('；') : leg.label === 'a' ? '当前窗口缺少进入笔' : '后续笔待形成'}</p>)}
              <p>以最新笔中枢展示进入笔 a 和后续笔 b，尚未确认递归走势段。</p>
            </details>
          </div>}
          {interpretation.phase.key !== 'insufficient' && <><p className="chanlun-flow-caption">阶段流程 · {label}级</p><StructureFlow key={selected} interpretation={interpretation} macdAvailable={analysis?.capabilities?.divergences === true} /></>}
          <div className="chanlun-appeared"><h4>已经出现</h4><ul>{(interpretation.facts.length ? interpretation.facts : [interpretation.phase.description]).map(fact => <li key={fact}><span aria-hidden="true">✓</span>{fact}</li>)}</ul>
            {!hideDates && interpretation.asOf && <p className="chanlun-detail-note">结构观察截至 {interpretation.asOf}</p>}
          </div>
          <button type="button" className="chanlun-next-observe" onClick={() => setTab('next')}>接下来观察什么<span aria-hidden="true">›</span></button>
          <div className="chanlun-signal-section"><h4>CZSC 辅助信号 <span>{signals.length}</span></h4>
            {!signals.length && <p className="chanlun-detail-note">当前窗口暂无仍有效的辅助信号。</p>}
            {(allSignals ? signals : signals.slice(0, 3)).map(signal => <details key={signal.id} className="chanlun-signal-item"><summary><span className={signal.kind.endsWith('_buy') ? 'text-bull' : 'text-bear'}>{signalCode(signal)}</span><span>{SIGNAL_NAMES[signal.kind]} · 条件命中</span><strong>{price(signal.price)}</strong></summary>
              <div className="chanlun-signal-body">{!hideDates && <><p>首次可知：{signal.availableDate}</p><p>结构极值：{signal.structureDate}</p></>}
                <p>对应笔：{signal.structureConfirmed ? '已完成' : '未完成'}</p><p>失效边界：{price(signal.boundary)}（触及即失效，本项目规则）</p>
                <p>次级别确认：暂不可用</p><p className="chanlun-rule-name">官方规则：{signal.rule?.function ?? '未提供'} {signal.rule && JSON.stringify(signal.rule.params)}</p>
                {signal.rawSignal && <p className="chanlun-rule-name">原始输出：{signal.rawSignal.key} · {signal.rawSignal.value}</p>}
              </div>
            </details>)}
            {signals.length > 3 && <button type="button" className="chanlun-all-signals" onClick={() => setAllSignals(!allSignals)}>{allSignals ? '收起信号' : `查看全部 ${signals.length} 个信号`}</button>}
          </div>
          <p className="chanlun-detail-note">阶段按已闭合K线和笔中枢描述；{analysis?.capabilities?.divergences ? '图上MACD背驰仅供观察' : '背驰暂未提供'}。信号为辅助条件，尚未联立次级别确认。</p>
        </> : <>
          <Observation item={item} title={`本级（${label}）`} />
          {[{ period: CHANLUN_OVERVIEW_PERIODS[index + 1], title: '下一级 · 区间套观察' }, { period: CHANLUN_OVERVIEW_PERIODS[index - 1], title: '上一级 · 大环境' }].map(adjacent => <Fragment key={adjacent.title}>
            <Observation item={items.find(i => i.period === adjacent.period)} title={`${adjacent.title}${adjacent.period ? `（${CHANLUN_PERIOD_LABELS[adjacent.period]}）` : ''}`} onSelect={adjacent.period ? () => onSelect(adjacent.period) : undefined} />
          </Fragment>)}
          <p className="chanlun-detail-note">相邻周期仅作结构对照，单个小级别信号不足以确认本级转折。</p>
          <div className="chanlun-price-ladder"><h4>关键价位</h4>{levels.length ? levels.map(level => <div key={level.key} className={`chanlun-price-level${level.key === 'current' ? ' current' : ''}`}><span>{level.label}</span><span>{level.key !== 'current' && fmtPct(level.percent / 100)}</span><strong>{price(level.price)}</strong></div>) : <p className="chanlun-detail-note">当前缺少可用价位。</p>}</div>
          <p className="chanlun-detail-note">这里只列待观察的结构条件，未完成的笔可能被后续行情改写。</p>
        </>}
    </div>
  </section>
}
