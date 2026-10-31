import type { MomentumReversionAnalysis } from '@/lib/trendPatterns'
const labels: Record<string, string> = {
  roc5: 'ROC5', roc20: 'ROC20', atr14: 'ATR14', ma20: 'MA20', ma60: 'MA60', slope: 'MA20近5根变化 / ATR',
  er20: 'ER20', z20: 'Z20', macd: 'MACD柱', rsi14: 'RSI14', deviation: '偏离依据', recovery: '均值恢复', turn: '动量转向',
}
const value = (v: number | null) => v == null ? '—' : v.toFixed(3)
export function MomentumReversionCard({ data }: { data?: MomentumReversionAnalysis }) {
  const m = data?.momentum, r = data?.reversion
  return <section aria-label="动量与均值回归" className="space-y-2 rounded-card border border-border bg-surface/60 p-2.5 text-xs">
    <div className="flex flex-wrap justify-between gap-1"><h4 className="font-medium text-foreground">动量与均值回归</h4><span className="text-muted">{data && { up: '上涨', down: '下跌', range: '震荡', unknown: '方向不明确' }[data.environment]}</span></div>
    {!data ? <p className="text-muted">模块暂不可用，请刷新分析。</p> : data.status !== 'ok' ? <p className="text-muted">{data.issues.join('；')}</p> : <>
      <div className="space-y-1 rounded border border-border bg-base/40 p-2" aria-label="机会判断">
        <p className="text-[11px] text-muted">机会判断</p>
        <p className={`break-words text-sm font-semibold ${data.opportunity?.tone === 'warning' ? 'text-warning' : data.opportunity?.tone === 'candidate' ? 'text-accent' : 'text-foreground'}`}>{data.opportunity?.title ?? '机会结论暂不可用，请刷新分析'}</p>
        {data.opportunity && <><p className="leading-relaxed text-secondary">{data.opportunity.reason}</p><ul className="list-inside list-disc text-[10px] leading-relaxed text-muted">{data.opportunity.pending.map(item => <li key={item}>{item}</li>)}</ul></>}
      </div>
      <div className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-2">
        <div className="rounded bg-base/40 p-2"><p className="text-muted">动量分 · −100～100</p><p className="mt-1 font-mono text-base text-foreground">{m?.score.toFixed(1) ?? '—'}</p><p>{m && { strong: '偏强', weak: '偏弱', neutral: '中性' }[m.direction]} · {m?.change}</p><p className="text-[10px] text-muted">较3根前 {m && m.delta > 0 ? '+' : ''}{m?.delta.toFixed(1)}</p></div>
        <div className="rounded bg-base/40 p-2"><p className="text-muted">回归成熟度 · 0～100</p><p className="mt-1 font-mono text-base text-foreground">{r?.score.toFixed(1) ?? '—'}</p><p>{r && { low: '低位回升', high: '高位回落', none: '暂无机会' }[r.side]}</p><p className="text-[10px] text-muted">{r && (r.state === 'completed' ? '回归已完成' : r.state === 'none' ? '暂无明显条件' : r.state === 'deviation' ? '仅有偏离，尚待确认' : r.score >= 70 ? '条件较充分' : r.score >= 40 ? '开始改善' : '尚待确认')}</p></div>
      </div>
      <p className="leading-relaxed text-secondary">{data.interpretation}</p>
      <details className="text-[11px] text-secondary"><summary className="cursor-pointer text-muted">查看评分依据</summary>
        <p className="mt-2">窗口按当前周期K线根数计算；规则 {data.version}</p>
        <div className="mt-2 grid grid-cols-2 gap-2">{Object.entries(data.metrics).map(([k, v]) => <div key={k} className="min-w-0 break-words">{labels[k] ?? k}：{value(k.startsWith('roc') && v != null ? v * 100 : v)}{k.startsWith('roc') ? '%' : ''}</div>)}</div>
        <p className="mt-2">动量贡献：{Object.entries(m?.components ?? {}).map(([k, v]) => `${labels[k] ?? k} ${v.toFixed(1)}`).join(' / ')}</p>
        <p>回归贡献：{Object.entries(r?.components ?? {}).map(([k, v]) => `${labels[k] ?? k} ${v.toFixed(1)}`).join(' / ')}；未开始回归时总分上限39。</p>
        {r?.anchorDate && <p>偏离锚点 {r.anchorDate} · Z {value(r.anchorZ)}</p>}
        <ul className="list-inside list-disc">{r?.conditions.map(condition => <li key={condition}>{condition}</li>)}</ul>
      </details>
    </>}
  </section>
}
