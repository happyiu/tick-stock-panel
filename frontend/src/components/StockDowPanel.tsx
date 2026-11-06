import { dowLabel, dowPeriod, dowTrend, type DowAnalysis } from '@/lib/dow'

const reason = (a: DowAnalysis) => a.structure === 'up'
  ? '最近的高点和低点都在抬高。'
  : a.structure === 'down' ? '最近的高点和低点都在降低。'
    : '最近的高点和低点变化不一致，暂时没有形成统一方向。'
const reading = (a: DowAnalysis) => a.damaged
  ? `${a.trend === 'up' ? '上涨' : '下跌'}走势已被打断，等待新方向`
  : a.trend === 'unknown' ? '暂时看不清方向' : a.trend === 'up' ? '仍处于上涨阶段' : '仍处于下跌阶段'
const price = (value: number | null | undefined) => value != null && Number.isFinite(value) && value > 0
  ? value.toLocaleString('zh-CN', { maximumFractionDigits: 6 }) : '—'
const date = (value: string | null | undefined) => value?.replace('T', ' ').slice(0, 16) ?? '—'
const role = (period: string) => period === '1w' ? '看大方向' : period === '1d' ? '看波段' : '看短期变化'
type Path = NonNullable<DowAnalysis['paths']>[number]
const pathTitle = (p: Path) => p.kind === 'damage' ? p.satisfied ? '原走势被打断时的价位' : p.direction === 'up' ? '反弹突破观察位' : '回落防守观察位'
  : p.kind === 'confirmation' ? `${p.direction === 'up' ? '上涨' : '下跌'}结构确认位` : '等待新的高低点'
const pathText = (p: Path) => p.kind === 'damage'
  ? p.satisfied ? `已出现收盘${p.direction === 'up' ? '突破' : '跌破'}这里的记录，原有走势已被打断；新的反向走势还需单独确认。`
    : `如果收盘${p.direction === 'up' ? '站上' : '跌破'}这里，当前${p.direction === 'up' ? '下跌' : '上涨'}走势就会被打断。盘中影线越过不算。`
  : p.kind === 'confirmation' ? p.satisfied ? '这次结构已获收盘确认，接下来观察高低点能否继续同向发展。'
    : `已有高点和低点${p.direction === 'up' ? '抬高' : '降低'}，还需要收盘${p.direction === 'up' ? '站上' : '跌破'}这里才能确认这次结构。`
    : p.kind === 'recovery' ? '等待新的同向高低点结构。形成后，系统才会给出新的收盘确认价；旧结构不能直接用于恢复趋势。'
      : `先等高点和低点共同${p.direction === 'up' ? '抬高' : '降低'}，目前还没有明确的反转确认价。`

export function StockDowPanel({ items, selected, onSelect, enabled, onToggle, supported }: {
  items: { period: string; analysis?: DowAnalysis; loading: boolean; error: boolean; retry: () => void }[]
  selected: string; onSelect: (p: string) => void; enabled: boolean; onToggle: () => void; supported: boolean
}) {
  const active = items.find(i => i.period === selected)
  const a = active?.analysis
  const same = ['1w', '1d', '30m'].every(period => {
    const item = items.find(i => i.period === period)
    return item && !item.error && !item.loading && item.analysis?.status === 'ok'
      && !item.analysis.damaged && item.analysis.trend !== 'unknown' && item.analysis.trend === items[0]?.analysis?.trend
  })
  const volume = a?.breakoutVolume
  const latest = a?.events.filter(e => e.kind !== 'wick').at(-1)
  const tone = a?.damaged || a?.trend === 'unknown' ? 'text-secondary' : a?.trend === 'up' ? 'text-bull' : 'text-bear'
  return <section aria-label="道氏趋势分析" className="space-y-4 p-3 text-xs leading-relaxed">
    <div>
      <h3 className="font-medium text-secondary">先选要看的周期</h3>
      <div className="mt-2 grid grid-cols-3 gap-2" role="group" aria-label="道氏分析周期">
        {items.map(i => <button type="button" key={i.period} aria-pressed={selected === i.period} onClick={() => onSelect(i.period)}
          className="min-w-0 rounded border border-border p-2 text-left aria-pressed:border-accent aria-pressed:bg-accent/5">
          <span className="block font-medium">{dowPeriod(i.period)}</span>
          <span className="block text-[10px] text-muted">{role(i.period)}</span>
          <strong className="mt-1 block text-[11px]">{i.loading ? '计算中…' : i.error ? '加载失败' : i.analysis?.status === 'ok' ? reading(i.analysis) : dowTrend(i.analysis)}</strong>
        </button>)}
      </div>
      {same && <p className="mt-2 text-muted">三个周期方向一致：共同{items[0]?.analysis?.trend === 'up' ? '偏强' : '偏弱'}。</p>}
    </div>
    {active?.loading ? <p role="status">正在计算{dowPeriod(selected)}分析…</p>
      : active?.error ? <button type="button" className="text-accent" onClick={active.retry}>分析加载失败，点击重试</button>
        : !a ? <p role="status">暂无分析结果</p>
          : a.status !== 'ok' ? <div role="status"><p>{dowTrend(a)}</p>{a.issues.map(issue => <p key={issue} className="text-muted">{issue}</p>)}</div>
            : <>
              <div className="rounded-lg border border-border bg-surface/60 p-3" aria-label="当前周期结论">
                <p className="text-[10px] text-muted">{dowPeriod(selected)} · 当前结论</p>
                <h3 className={`mt-1 text-sm font-semibold ${tone}`}>{reading(a)}</h3>
                <p className="mt-2 text-secondary">{a.damaged
                  ? `原${a.trend === 'up' ? '上涨' : '下跌'}趋势的关键价位曾被收盘穿过，方向进入重新确认阶段。`
                  : a.trend === 'unknown' ? '已有高低点可比较，但还没满足趋势的收盘确认条件。'
                    : `已确认的${a.trend === 'up' ? '上涨' : '下跌'}趋势还没有被收盘破坏。`}</p>
                <p className="mt-1 text-muted">{reason(a)}</p>
                {latest && <p className="mt-2 border-t border-border/50 pt-2 text-[10px] text-muted">最近变化 · {date(latest.date)}：{latest.kind === 'damage' ? '原有走势被打断' : latest.kind === 'reversal' ? '新方向获确认' : '原方向再次得到确认'}</p>}
              </div>
              <div className="space-y-2" aria-label="关键价位与下一步">
                <h3 className="font-medium text-secondary">接下来盯哪里</h3>
                {a.paths?.length ? a.paths.map((p, i) => <div key={`${p.kind}-${i}`} className="rounded border border-border p-2.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <strong className="font-medium">{pathTitle(p)}</strong>
                    <span className="font-mono text-base font-semibold text-accent">{price(p.value)}</span>
                  </div>
                  <p className="mt-1 text-muted">{price(p.value) === '—' && p.kind === 'confirmation'
                    ? '暂无有效确认价，等待新的高低点形成。' : pathText(p)}</p>
                  {p.anchorDate && <p className="mt-1 text-[10px] text-muted">参考拐点发生于 {date(p.anchorDate)}</p>}
                </div>) : <p className="text-muted">暂未提供明确确认价，等待新的高低点结构。</p>}
              </div>
              <div aria-label="近期高低点对比">
                <h3 className="font-medium text-secondary">高点、低点在往哪走</h3>
                <p className="mt-1 text-[10px] text-muted">只比较已经确认的拐点；右侧两根K线收盘后才算确认。</p>
                {(['high', 'low'] as const).map(side => {
                  const points = a.pivots.filter(p => p.side === side).slice(-2)
                  const previous = points.at(-2), current = points.at(-1)
                  const change = !previous || !current ? '等待更多拐点' : current.value > previous.value ? '抬高' : current.value < previous.value ? '降低' : '持平'
                  return <div key={side} className="mt-2 rounded border border-border p-2">
                    <div className="flex flex-wrap items-baseline justify-between gap-2"><strong>{side === 'high' ? '高点' : '低点'} · {change}</strong>
                      <span className="font-mono text-secondary">{price(previous?.value)} → {price(current?.value)}</span></div>
                    {current && <p className="mt-1 text-[10px] text-muted">最近拐点发生于 {date(current.date)}，确认于 {date(current.confirmedAt)}</p>}
                  </div>
                })}
              </div>
            </>}
    <div className="rounded border border-border/60 p-2.5">
      <button type="button" className="rounded border border-border px-2 py-1 disabled:opacity-50" disabled={!supported} aria-pressed={enabled} onClick={onToggle}>主图高低点标注：{enabled ? '已开启' : '未开启'}</button>
      <p className="mt-1 text-[10px] text-muted">{supported ? '标注跟随主图周期；切换上方解读周期不会切换主图。' : '请将主图切换到周线、日线或30分钟后开启标注。'}</p>
    </div>
    {a && <details className="rounded border border-border/60 p-2.5">
      <summary className="cursor-pointer text-secondary">查看确认记录与计算说明</summary>
      <div className="mt-2 space-y-2 text-[10px] text-muted">
        <p>数据范围：{date(a.coverageStart)} 至 {date(a.dataThrough)}。判断只使用已收盘K线。</p>
        <p>高点和低点同时抬高，配合收盘突破支持上涨；同时降低，配合收盘跌破支持下跌。原走势被打断与新方向成立是两个不同阶段。</p>
        <p>每个拐点比较左侧3根和右侧2根K线。因此标注的发生日期早于确认日期，历史回看应以确认时间为准。</p>
        {a.basis?.confirmation && <p>上次趋势确认：{date(a.basis.confirmation.date)}，收盘{a.basis.confirmation.direction === 'up' ? '突破' : '跌破'} {price(a.basis.confirmation.value)}。这是历史确认价，不是新的触发价。</p>}
        <p>{volume ? `${date(volume.date)} ${volume.direction === 'up' ? '向上' : '向下'}确认时的成交量：${volume.volumeRatio == null ? '数据不足' : `前20根均量的 ${volume.volumeRatio.toFixed(2)}倍，${volume.volumeRatio >= 1.2 ? '量能支持' : '量能支持不足'}`}。` : '暂无趋势确认时的量能记录。'}量能作为辅助证据，价格结构独立判断。</p>
        <div className="max-h-64 space-y-1 overflow-y-auto" aria-label="历史确认明细">
          {[...a.pivots].reverse().map((p, i) => <p key={`p-${i}`}>{dowLabel(p.label)}：{price(p.value)}（发生 {date(p.date)}，确认 {date(p.confirmedAt)}）</p>)}
          {[...a.events].reverse().map((e, i) => <p key={`e-${i}`}>{date(e.date)}：{e.kind === 'wick' ? '盘中越界，未按收盘破坏处理' : e.kind === 'damage' ? '原有走势被打断' : e.kind === 'reversal' ? '反转确认' : '趋势确认'}，参考位 {price(e.value)}</p>)}
        </div>
        <p>这里分析单个标的；三个周期方向一致不等于传统道氏理论中的不同指数互相确认。量能1.2倍为工程阈值。</p>
      </div>
    </details>}
  </section>
}
