import type { ChanlunProjection } from '@/lib/chanlun'
import { fmtAssetPrice } from '@/lib/format'

export function ChanlunProjectionDetails({ projection, selected, onSelect, hideDates, assetType, error }: {
  projection?: ChanlunProjection | null; selected: number | null; onSelect: (id: number | null) => void; hideDates: boolean; assetType?: string; error?: string
}) {
  const branch = projection?.branches.find(item => item.id === selected)
  return <section aria-label="条件推演说明" className="mt-2 rounded-md border border-border bg-surface p-2 text-[11px] text-secondary">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <strong className="text-foreground">条件推演</strong>
      {projection?.anchor && <span>{!hideDates && `${projection.anchor.availableDate} · `}收盘 {fmtAssetPrice(projection.anchor.price, assetType)}</span>}
      <span className="text-[10px] text-muted">虚线表示条件分支，横向距离不表示到达时间</span>
    </div>
    {error ? <p role="alert" className="mt-1 text-danger">推演不可用：{error}</p>
      : !projection ? <p className="mt-1 text-muted">推演结果暂不可用，请等待计算完成；旧后端需更新后重新计算。</p>
      : projection.status !== 'ready' ? <p className="mt-1 text-muted">此处尚无有效中枢，等待结构形成。</p>
        : <>
          <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="推演条件分支">{projection.branches.map(item => <button key={item.id} type="button"
            aria-pressed={selected === item.id} onClick={() => onSelect(selected === item.id ? null : item.id)}
            className={`rounded border px-2 py-1 ${selected === item.id ? 'border-accent bg-accent/10 text-accent' : 'border-border hover:bg-elevated'}`}>{item.id} · {item.label}</button>)}</div>
          {branch && <div className="mt-2 space-y-1 border-t border-border pt-2" role="region" aria-label="推演分支详情">
            <p className="text-foreground">{branch.condition}</p><p>{branch.meaning}</p>
            {branch.rule && <p className="break-all text-[10px] text-muted">官方观察规则：{branch.rule.function}（di=1）</p>}
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted">{projection.zones.map(zone => <span key={zone.kind}>{zone.label}：{fmtAssetPrice(zone.zd, assetType)}—{fmtAssetPrice(zone.zg, assetType)}</span>)}</div>
            <p className="text-[10px] text-muted">{projection.description}</p>
          </div>}
        </>}
  </section>
}
