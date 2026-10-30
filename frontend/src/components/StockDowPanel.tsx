import { dowLabel, dowPeriod, dowTrend, type DowAnalysis } from '@/lib/dow'

const reason = (a: DowAnalysis) => a.structure === 'up'
  ? '最近的高点和低点都在抬高，价格结构正在走强。'
  : a.structure === 'down' ? '最近反弹的高点逐渐降低，回落后的低点也在下移，价格结构仍偏弱。'
  : '高点和低点的变化方向还不一致，暂时没有形成统一方向。'
const reading = (a?: DowAnalysis) => !a || a.status !== 'ok' ? dowTrend(a)
  : a.damaged ? `${a.trend === 'up' ? '上涨' : '下跌'}趋势已被打破，反向趋势尚未确认`
  : a.trend === 'unknown' ? '方向还需等待确认' : a.trend === 'up' ? '上涨趋势仍在延续' : '下跌趋势仍在延续'

export function StockDowPanel({ items, selected, onSelect, enabled, onToggle, supported }: {
  items: { period: string; analysis?: DowAnalysis; loading: boolean; error: boolean; retry: () => void }[]
  selected: string; onSelect: (p: string) => void; enabled: boolean; onToggle: () => void; supported: boolean
}) {
  const active = items.find(i => i.period === selected)
  const a = active?.analysis
  const valid = (i: typeof active) => !!i && !i.error && !i.loading && i.analysis?.status === 'ok'
  const daily = items.find(i => i.period === '1d')
  const same = items.length === 3 && items.every(i => valid(i) && !i.analysis!.damaged && i.analysis!.trend !== 'unknown' && i.analysis!.trend === items[0].analysis!.trend)
  const volume = a?.breakoutVolume
  const latest = a?.events.filter(e => e.kind !== 'wick').at(-1)
  return <section aria-label="道氏趋势分析" className="space-y-4 p-3 text-xs leading-relaxed">
    <div><h3 className="font-medium text-muted">当前怎么看</h3>
      <p className="mt-1 text-sm font-semibold">{same ? `周、日、30分钟共同${daily?.analysis?.trend === 'up' ? '偏强' : '偏弱'}` : `日线：${daily?.error ? '加载失败' : daily?.loading ? '计算中…' : reading(daily?.analysis)}`}</p>
      {!same && <p className="mt-1 text-muted">{items.filter(i => i.period !== '1d').map(i => `${dowPeriod(i.period)}${i.period === '1w' ? '背景' : '短期'}：${i.error ? '加载失败' : i.loading ? '计算中…' : reading(i.analysis)}`).join('；')}。短期变化需结合日线确认。</p>}
    </div>
    <div><h3 className="mb-2 font-medium text-muted">周期对照</h3>
      <div className="grid grid-cols-3 gap-2">{items.map(i => <button key={i.period} aria-pressed={selected === i.period} onClick={() => onSelect(i.period)} className="rounded border border-border p-2 aria-pressed:border-accent">
        {dowPeriod(i.period)}<strong className="block">{i.loading ? '计算中…' : i.error ? '加载失败' : dowTrend(i.analysis)}</strong>
      </button>)}</div>
      <p className="mt-2 text-muted">正在解读：{dowPeriod(selected)}；主图标注跟随主图周期。</p>
    </div>
    {active?.loading ? <p role="status">正在计算{dowPeriod(selected)}分析…</p> : active?.error ? <button onClick={active.retry}>分析加载失败，点击重试</button> : !a ? <p>暂无分析结果</p> : a.status !== 'ok' ? <div role="status"><p>{dowTrend(a)}</p>{a.issues.map(issue => <p key={issue}>{issue}</p>)}</div> : <>
      <div><h3 className="font-medium text-muted">为什么这样判断</h3><p>{reason(a)}{a.damaged ? '原趋势已受损，需要新的结构和收盘突破才能重新确认方向。' : a.trend === 'unknown' ? '结构变化尚未满足趋势确认条件。' : ''}</p>
        {a.basis?.confirmation && <p className="mt-1 text-muted">上次确认：{a.basis.confirmation.date}，收盘{a.basis.confirmation.direction === 'up' ? '突破' : '跌破'} {a.basis.confirmation.value}。</p>}
        {latest && <p className="mt-1 text-muted">最近变化：{latest.date}，{latest.kind === 'damage' ? '原趋势受损' : latest.kind === 'reversal' ? '趋势方向发生确认切换' : '趋势得到确认'}。</p>}
      </div>
      <div><h3 className="font-medium text-muted">接下来关注什么</h3><ul className="list-disc space-y-1 pl-4">{a.paths?.slice(0, 3).map((p, i) => <li key={i}>{p.kind === 'damage'
        ? p.satisfied ? `收盘已${p.direction === 'up' ? '突破' : '跌破'}原保护位 ${p.value}，原趋势已受损；这还不等于反转确认。` : `收盘${p.direction === 'up' ? '突破' : '跌破'}保护位 ${p.value}，会打破当前趋势。`
        : p.kind === 'confirmation' ? p.satisfied ? `当前${p.direction === 'up' ? '上涨' : '下跌'}结构已确认，后续观察高低点能否继续同向发展。` : `现有${p.direction === 'up' ? '抬高' : '降低'}结构需配合收盘${p.direction === 'up' ? '突破' : '跌破'} ${p.value}，才支持${p.direction === a.trend ? '重新确认原趋势' : '确认新方向'}。`
        : p.kind === 'recovery' ? '等待新的同向高低点结构；形成后再观察收盘突破，旧结构不能用于恢复趋势。' : `先等待高点和低点共同${p.direction === 'up' ? '抬高' : '降低'}，再观察收盘突破；目前没有可确认的反转价位。`}</li>)}</ul>
        <p className="mt-2 text-muted">{volume ? `${volume.date} ${volume.direction === 'up' ? '向上' : '向下'}确认的量能：${volume.volumeRatio == null ? '成交量证据不足' : `${volume.volumeRatio.toFixed(2)}倍，${volume.volumeRatio >= 1.2 ? '量能支持' : '量能支持不足'}`}。` : '成交量证据不足。'}价格结构独立判断。</p>
      </div>
    </>}
    <button className="rounded border border-border p-1" disabled={!supported} aria-pressed={enabled} onClick={onToggle}>主图标注{enabled ? '：开' : '：关'}</button>
    {!supported && <p>首版主图标注支持周线、日线、30分钟。</p>}
    {a && <details><summary className="cursor-pointer text-muted">查看分析依据</summary><div className="mt-2 space-y-1 text-muted">
      <p>覆盖 {a.coverageStart ?? '—'} 至 {a.dataThrough ?? '—'}。拐点需等待右侧两根收盘K线确认。</p>
      {a.pivots.map((p, i) => <p key={i}>{dowLabel(p.label)}：{p.value}（发生 {p.date}，确认于 {p.confirmedAt}）</p>)}
      {a.events.map((e, i) => <p key={i}>{e.date}：{e.kind === 'wick' ? '盘中越界' : e.kind === 'damage' ? '趋势受损' : e.kind === 'reversal' ? '反转确认' : '趋势确认'}，参考位 {e.value}</p>)}
      <p>单标的道氏趋势应用；多周期对照不代表传统道氏指数互相确认。左3右2确认，量能1.2倍为工程阈值。</p>
    </div></details>}
  </section>
}
