import { useState } from 'react'
import { api } from '@/lib/api'
import type { WaveBundle } from '@/lib/wave'
import type { WaveAnalysis } from '@/lib/wave'
const patternNames: Record<string, string> = { impulse: '推动浪', zigzag: '锯齿', flat: '平台', expanded_flat: '扩张平台', contracting_triangle: '收敛三角形', leading_diagonal: '起始楔形', ending_diagonal: '终结楔形', wxy: 'WXY' }
const patternName = (pattern?: string) => patternNames[pattern ?? ''] ?? pattern ?? '待识别形态'
const waveName = (label: string) => /^\d+$/.test(label) ? `第${label}浪` : `${label}浪`
const cardName = (index: number) => index === 0 ? '主数浪' : `备选${index}`

export function StockWavePanel({ analysis, confluence, comparison, selected, onSelect, loading, error, retry, enabled, toggle, supported, period = '1d', onPeriodChange, symbol, asset, onHistory, onLatest, saved, depth = 0, onDepthChange }: {
  depth?: number; onDepthChange?: (depth: number) => void; period?: '1d' | '30m'; onPeriodChange?: (period: '1d' | '30m') => void; symbol?: string; asset?: string; onHistory?: (data: WaveBundle) => void; onLatest?: () => void; saved?: boolean; comparison?: import("@/lib/wave").WaveComparison; analysis?: WaveAnalysis; confluence?: string; selected: string; onSelect: (id: string) => void; loading: boolean; error: boolean; retry: () => void; enabled: boolean; toggle: () => void; supported: boolean
}) {
  const [history, setHistory] = useState<{id: string; asOf: string}[]>([])
  const [historyError, setHistoryError] = useState('')
  const counts = analysis?.counts ?? []
  const c = counts.find(c => c.id === selected) ?? counts[0]
  const selectedIndex = Math.max(0, counts.findIndex(item => item.id === c?.id))
  const samePivots = c && selectedIndex > 0 && c.points.length === counts[0].points.length && c.points.every((p, i) => p.date === counts[0].points[i].date && p.value === counts[0].points[i].value)
  return <section className="space-y-3 p-3 text-xs leading-relaxed" aria-label="波浪分析">
    <p className="font-semibold">{period === '30m' ? '30分钟' : '日线'}浪位分析 · 内部子浪证据待验证</p>
    {analysis?.isProvisional && <p className="rounded bg-amber-500/10 p-2 text-amber-500">包含当日未收盘日 K，当前结果会随盘中价格变化；拐点仍只由已收盘K线确认。</p>}
    {onPeriodChange && <div className="flex gap-2" aria-label="波浪分析周期">{(['1d', '30m'] as const).map(p => <button key={p} aria-pressed={period === p} className={`rounded border px-3 py-1.5 ${period === p ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted'}`} onClick={() => onPeriodChange(p)}>{p === '1d' ? '日线' : '30分钟'}</button>)}</div>}
    {saved === false && <p>快照未保存</p>}
    {symbol && <details><summary onClick={() => { void api.waveHistory(symbol, asset ?? 'stock').then(setHistory).catch(() => setHistoryError('历史加载失败')) }}>历史快照</summary><button onClick={onLatest}>返回最新分析</button>{history.map(h => <button className="block" key={h.id} onClick={() => { void api.waveSnapshot(h.id).then(data => onHistory?.(data)).catch(() => setHistoryError('快照加载失败')) }}>{h.asOf}</button>)}<p>{historyError}</p></details>}
    {loading ? <p>计算中…</p> : error ? <button onClick={retry}>加载失败，点击重试</button> : <>
      <div className="space-y-2">
        <p className="font-semibold">候选解释 · {counts.length}个</p>
        <p className="text-muted">{supported ? '点击方案查看详情，并在主图显示对应标注。' : '点击方案查看详情；主图周期一致时可显示标注。'}</p>
        {counts.map((item, i) => <button type="button" className={`block w-full space-y-2 rounded-lg border p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${c?.id === item.id ? 'border-accent bg-accent/10 ring-1 ring-accent/30' : 'border-border hover:border-accent/50'}`} key={item.id} aria-label={`${cardName(i)}：${patternName(item.pattern)}`} aria-pressed={c?.id === item.id} onClick={() => onSelect(item.id)}>
          <span className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold">{cardName(i)} · {patternName(item.pattern)}</span><span className={c?.id === item.id ? 'text-accent' : 'text-muted'}>{c?.id === item.id ? '✓ 当前查看' : '查看方案'}</span></span>
          <span className="flex flex-wrap gap-x-4 gap-y-1 text-muted"><span>历史结构：{item.direction === 'up' ? '上行' : '下行'}</span><span>结构尺度：{item.degree ?? '—'}</span><span>规则匹配分：{item.score ? `${(item.score.total * 100).toFixed(1)} / 100` : '暂无'}</span></span>
          <span className="block text-muted">{item.points[0]?.date.slice(0, 10)} → {item.points.at(-1)?.date.slice(0, 10)}</span>
        </button>)}
        <p className="text-muted">匹配分不是概率或胜率；结构尺度数字越大，观察的走势越粗。</p>
      </div>
      {c ? <div className="space-y-2 rounded-lg border border-border p-3" aria-label="当前候选详情" aria-live="polite">
        <p className="font-semibold">当前查看：{cardName(selectedIndex)} · {patternName(c.pattern)}</p>
        {samePivots && <p className="rounded bg-accent/10 p-2 text-accent">与主数浪共用相同拐点，主图连线相同；区别在于形态规则和子浪要求。</p>}
        <p>{c.currentPosition?.active ? `后续情景：可能处于${waveName(c.currentPosition.active)}${c.currentPosition.direction === 'up' ? '上行' : '回落'}中` : '暂时无法可靠判断当前浪位'}</p>
        <p>最后确认端点：{waveName(c.currentPosition?.lastCompleted ?? c.stage)}。{c.currentPosition?.explanation}</p>
        <p>验证程度：{c.validation?.level === 'subdivision_validated' ? '本层子结构通过，完整递归仍待验证' : '外形匹配，内部子浪仍待验证'}</p>
        <p>下一步：{c.nextCondition}</p>
        <p>后续情景失效：{c.provisionalInvalidation ? `盘中未收盘K线${c.provisionalInvalidation.direction === 'below' ? '最低价' : '最高价'} ${c.provisionalInvalidation.price} 越过失效位 ${c.provisionalInvalidation.boundary}，尚待收盘确认。` : c.invalidation.value == null ? c.invalidation.reason : `已收盘K线${c.invalidation.direction === 'below' ? '最低价不高于' : '最高价不低于'} ${c.invalidation.value}。`}</p>
      </div> : <p>暂时无法可靠数浪</p>}
      <details><summary>周期与趋势对照</summary>
      <p>日线 / 30分钟对照：{confluence ?? '证据不足'}</p>
      {comparison && <details><summary>查看周期数据</summary>{comparison.coverage.map(item => <p key={item.period}>{item.label}：{item.bars}根已收盘K线，{item.candidates}个候选；{item.adjustment}；{item.start && item.end ? `${item.start} 至 ${item.end}` : '暂无覆盖范围'}{item.stale ? '；行情快照已过期' : ''}</p>)}</details>}
      {analysis?.dowConfluence && <p>日线道氏对照：{analysis.dowConfluence}</p>}
      </details>
      <p className="text-muted">波浪边界使用收盘K线高低价；道氏突破使用收盘价。候选排序不代表概率。</p>
      {analysis?.issues.map(issue => <p key={issue}>{issue}</p>)}
    </>}
    <div className="space-y-2 rounded-lg border border-border p-3"><p className="font-semibold">主图显示</p>
    <button className="rounded border border-border px-3 py-2 disabled:opacity-50" disabled={!supported || !c} aria-pressed={enabled} onClick={toggle}>主图波浪标注：{enabled ? '已显示' : '已隐藏'}</button>
    <p className="text-muted">在K线主图上显示当前候选的波浪连线与浪序标签。</p>
    {!supported && <p>将主图切换为{period === '30m' ? '30分钟' : '日线'}后可显示波浪标注。</p>}
    {onDepthChange && <label className="inline-flex items-center gap-2">子浪图层 <select className="h-8 min-w-24 rounded border border-border bg-base px-2 text-foreground focus:outline-none focus:border-accent/50 [&>option]:bg-base [&>option]:text-foreground" value={depth} onChange={e => onDepthChange(Number(e.target.value))}><option value={0}>关闭</option><option value={1}>一层</option><option value={2}>两层</option></select></label>}
    </div>
    <details><summary>子浪与参考区</summary>{c?.waveTree?.map(n => <div key={n.label}><p>主浪 {n.label}：内部{n.children.length}段，{n.validation === 'subdivision_validated' ? '本层子结构通过' : '证据不足'}</p>{n.children.map(child => <p key={child.label}>子段 {child.label}：{child.start.value} → {child.end.value}</p>)}</div>)}{c?.projections?.map(p => <p key={p.ratio}>情景参考 {p.ratio} 倍：{p.value.toFixed(3)}（不是目标承诺）</p>)}</details>
    <details><summary>查看分析依据</summary><p>覆盖 {analysis?.coverageStart} 至 {analysis?.dataThrough}；ATR14多尺度确认；递归最多两层。</p>{c?.rules.map(r => <p key={r}>{r}</p>)}{c?.points.map(p => <p key={p.label}>{p.label}：{p.value}，发生 {p.date}，确认 {p.confirmedAt}</p>)}{analysis?.invalidated.map(c => <p key={c.id}>已失效候选 {c.id}：{c.invalidation.reason}</p>)}</details>
  </section>
}
