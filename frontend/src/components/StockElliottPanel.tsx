import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, ChevronDown, ExternalLink, Loader2, RefreshCw, Sparkles, XCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { fmtAssetPrice } from '@/lib/format'
import {
  describeElliottCount,
  elliottFamilyLabel,
  elliottPeriodLabel,
  elliottSnapshotFingerprint,
  type ElliottAnalysis,
  type ElliottAssessmentRequest,
  type ElliottCount,
  type ElliottEvidence,
  type ElliottExplanationResponse,
  type ElliottPeriod,
  type ElliottRuleCheck,
} from '@/lib/elliott'
import type { OHLC } from '@/components/EChartsCandlestick'

const REFERENCE_URL = 'https://github.com/noahnan-max/elliott-wave-trading-system'

const DIRECTION_LABELS: Record<string, string> = {
  up: '向上',
  down: '向下',
  sideways: '横向',
  mixed: '混合',
}

function countDirection(count: ElliottCount | null): string {
  return count ? (DIRECTION_LABELS[count.direction] ?? count.direction) : '等待更多结构'
}

function countPivots(count: ElliottCount | null, sequence: string[], assetType?: string): string {
  if (!count || count.pivots.length === 0) return '—'
  return count.pivots
    .map((pivot, index) => (sequence[index] ?? pivot.label) + ' ' + fmtAssetPrice(pivot.price, assetType))
    .join(' · ')
}

function listText(values: string[] | undefined, fallback: string): string {
  return values?.[0] || fallback
}

function ruleId(rule: ElliottRuleCheck): string {
  return rule.ruleId ?? '结构规则'
}

const RULE_LABELS: Record<string, string> = {
  'impulse.wave2_origin': '二浪不破一浪起点',
  'impulse.wave3_not_shortest': '三浪不是最短浪',
  'impulse.wave4_no_overlap': '四浪不进入一浪区间',
  'impulse.internal_structure': '推动浪内部子浪',
  'diagonal.wave2_origin': '二浪不破一浪起点',
  'diagonal.wave3_not_shortest': '三浪不是最短浪',
  'diagonal.wave4_overlap': '四浪允许重叠',
  'diagonal.progression': '对角线推进关系',
  'diagonal.alternation': '对角线交替关系',
  'diagonal.internal_structure': '对角线内部子浪',
  'zigzag.b_not_origin': 'B 段不破 A 段起点',
  'zigzag.c_extends_a': 'C 段延伸超过 A 段',
  'flat.b_retrace': 'B 段深回撤',
  'flat.c_reaches_a': 'C 段达到 A 段端点',
  'correction.internal_structure': '修正内部结构',
  'triangle.topology_complete': '三角形完整拓扑',
  'combination.internal_structure': '组合内部结构',
}

const EVIDENCE_LABELS: Record<ElliottEvidence['family'], string> = {
  structure: '结构',
  alternation: '交替性',
  proportionality: '比例性',
  fibonacci: 'Fibonacci',
  channel: '通道',
  momentum: '动量',
  volume: '成交量',
  multi_timeframe: '多周期',
}

function ruleLabel(rule: ElliottRuleCheck): string {
  return RULE_LABELS[ruleId(rule)] ?? ruleId(rule)
}

function ruleResult(rule: ElliottRuleCheck): 'pass' | 'fail' | 'unknown' | 'not_applicable' {
  if (rule.result === 'pass' || rule.result === 'fail' || rule.result === 'unknown' || rule.result === 'not_applicable') return rule.result
  return 'unknown'
}

function ruleResultLabel(rule: ElliottRuleCheck): string {
  return ({ pass: '满足', fail: '不满足', unknown: '无法判断', not_applicable: '不适用' })[ruleResult(rule)]
}

function ruleSummary(rules: ElliottRuleCheck[]): { pass: number; fail: number; unknown: number } {
  return rules.reduce((summary, rule) => {
    const result = ruleResult(rule)
    if (result === 'pass') summary.pass += 1
    else if (result === 'fail') summary.fail += 1
    else if (result === 'unknown') summary.unknown += 1
    return summary
  }, { pass: 0, fail: 0, unknown: 0 })
}

function aiRequestRows(rows: OHLC[], asOf: string | null): ElliottAssessmentRequest['bars'] {
  return rows
    .filter(row => !asOf || row.date <= asOf)
    .slice(-300)
    .map(row => ({
      date: row.date,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      periodEnd: row.periodEnd,
      isClosed: row.isClosed,
    }))
}

interface Props {
  symbol: string
  rows: OHLC[]
  period: ElliottPeriod
  assetType?: 'stock' | 'etf' | 'index'
  analysis: ElliottAnalysis
  collapsed?: boolean
  onToggleCollapsed?: () => void
}

export function StockElliottPanel({
  symbol,
  rows,
  period,
  assetType,
  analysis,
  collapsed = false,
  onToggleCollapsed,
}: Props) {
  const queryClient = useQueryClient()
  const [showAi, setShowAi] = useState(false)
  const asOf = analysis.asOf ?? ''
  const fingerprint = useMemo(() => elliottSnapshotFingerprint(rows, asOf), [asOf, rows])
  const queryKey = useMemo(() => QK.elliottAssessment(symbol, period, asOf, fingerprint), [asOf, fingerprint, period, symbol])
  const queryKeyString = JSON.stringify(queryKey)
  const requestBody = useMemo<ElliottAssessmentRequest>(() => ({
    symbol,
    period,
    as_of: asOf,
    price_basis: analysis.priceBasis,
    bars: aiRequestRows(rows, asOf),
    local_analysis: analysis,
  }), [analysis, asOf, period, rows, symbol])
  const aiMutation = useMutation({
    mutationFn: () => api.elliottExplain(requestBody),
    onSuccess: result => {
      queryClient.setQueryData(queryKey, result)
    },
  })
  const cachedAi = queryClient.getQueryData<ElliottExplanationResponse>(queryKey)
  const aiResult = aiMutation.data ?? cachedAi

  useEffect(() => {
    setShowAi(false)
    aiMutation.reset()
  }, [aiMutation.reset, queryKeyString])

  const runAi = (force = false) => {
    setShowAi(true)
    if (!force && queryClient.getQueryData<ElliottExplanationResponse>(queryKey)) return
    if (force) queryClient.removeQueries({ queryKey })
    aiMutation.mutate()
  }

  const primary = analysis.primaryCount
  const countDisplay = describeElliottCount(primary)
  const alternateCounts = analysis.alternateCounts
  const rules = analysis.hardRuleChecks
  const ruleCounts = ruleSummary(rules)
  const ruleGroups = [...rules.reduce((groups, item) => {
    const key = item.candidateId ?? 'analysis'
    const current = groups.get(key) ?? []
    groups.set(key, [...current, item])
    return groups
  }, new Map<string, ElliottRuleCheck[]>())]
  const modeLabel = analysis.definitionMode === 'strict_elliott'
    ? '严格规则'
    : analysis.definitionMode === 'structure_proxy'
      ? '结构代理'
      : '数据不足'
  const selectedAsOf = analysis.asOf
  const headerContent = (
    <span className="flex min-w-0 items-start gap-1.5">
      {onToggleCollapsed && (
        <ChevronDown className={'mt-0.5 h-3.5 w-3.5 shrink-0 text-muted transition-transform ' + (collapsed ? '-rotate-90' : '')} />
      )}
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-foreground">艾略特波浪理论</span>
          <span className="rounded bg-[#F59E0B]/10 px-1.5 py-0.5 text-[12px] text-[#FBBF24]">{modeLabel}</span>
          <span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[12px] text-secondary">{elliottPeriodLabel(period)}</span>
        </span>
        {!collapsed && (
          <span className="mt-0.5 block truncate text-[13px] text-muted">
            {selectedAsOf ? '截至 ' + selectedAsOf : '等待当前周期行情'} · 研究辅助，不构成买卖建议
          </span>
        )}
      </span>
    </span>
  )
  const headerClassName = 'flex w-full items-start px-2.5 py-2 text-left transition-colors ' + (collapsed ? 'border-b border-border/70 ' : '') + (onToggleCollapsed ? 'hover:bg-elevated/40' : '')

  return (
    <section>
      {onToggleCollapsed ? (
        <button
          type="button"
          onClick={onToggleCollapsed}
          className={headerClassName}
          title={collapsed ? '展开艾略特波浪理论' : '收起艾略特波浪理论'}
          aria-label={collapsed ? '展开艾略特波浪理论' : '收起艾略特波浪理论'}
          aria-expanded={!collapsed}
        >
          {headerContent}
        </button>
      ) : (
        <div className={headerClassName}>{headerContent}</div>
      )}

      {!collapsed && (
        <>
          <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5">
            <button
              type="button"
              onClick={() => runAi(false)}
              disabled={analysis.status !== 'ready' || aiMutation.isPending}
              className="inline-flex items-center gap-1 rounded border border-[#F59E0B]/40 bg-[#F59E0B]/10 px-2 py-1 text-[13px] text-[#FBBF24] transition-colors hover:bg-[#F59E0B]/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {aiMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
              {aiMutation.isPending ? '判断中…' : aiResult ? '查看 AI 判断' : 'AI 判断类型'}
            </button>
            {aiResult && !aiMutation.isPending && (
              <button
                type="button"
                onClick={() => runAi(true)}
                className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[13px] text-muted transition-colors hover:bg-elevated hover:text-foreground"
                title="重新生成本次历史截面的 AI 解释"
              >
                <RefreshCw className="h-3 w-3" />
                重新解释
              </button>
            )}
            <a
              href={REFERENCE_URL}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-1 text-[13px] text-muted transition-colors hover:bg-elevated hover:text-foreground"
              title="查看参考工作流"
            >
              方法参考 <ExternalLink className="h-3 w-3" />
            </a>
          </div>

          {aiMutation.error && (
            <div className="mx-2 mb-2 rounded border border-danger/30 bg-danger/5 px-2.5 py-2 text-[13px] leading-relaxed text-danger">
              AI 解释暂时不可用：{aiMutation.error.message}。可在 <Link to="/settings?tab=ai" className="underline">AI 设置</Link> 中检查配置；本地确定性结果仍可使用。
            </div>
          )}

          <div className="grid grid-cols-1 gap-2 p-2 md:grid-cols-2">
            <WaveCard title="当前计数" tone="amber">
              <div className="font-medium text-foreground">
                {primary ? countDirection(primary) + ' · ' + countDisplay.title : countDisplay.title}
              </div>
              <div className="mt-1 text-secondary">
                {primary?.currentWave ? '当前浪：' + primary.currentWave + ' · ' : ''}{countDisplay.stage}
              </div>
              {countDisplay.sequence.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center text-[12px]" aria-label={'波浪路径：' + countDisplay.sequence.join(' ')}>
                  {countDisplay.sequence.map((item, index) => (
                    <span key={item + '-' + index} className="inline-flex items-center">
                      {index > 0 && <span className="mx-1 text-muted/60">→</span>}
                      <span className={'rounded px-1.5 py-0.5 ' + (index === countDisplay.sequence.length - 1 ? 'bg-[#F59E0B]/20 text-[#FBBF24]' : 'bg-elevated text-secondary')}>
                        {item}
                      </span>
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-1.5 truncate font-mono text-[13px] text-muted" title={countPivots(primary, countDisplay.sequence, assetType)}>
                拐点价格：{countPivots(primary, countDisplay.sequence, assetType)}
              </div>
              {primary && <div className="mt-1 truncate font-mono text-[11px] text-muted" title={primary.id}>候选 {primary.label}</div>}
            </WaveCard>

            <WaveCard title="备选与歧义" tone={analysis.ambiguity === 'multiple_viable' ? 'amber' : 'neutral'}>
              <div className="font-medium text-foreground">
                {analysis.ambiguity === 'multiple_viable' ? '存在多个可行计数' : analysis.ambiguity === 'unresolved' ? '结构尚未解决' : '主计数占优'}
              </div>
              <div className="mt-1 space-y-1 text-secondary">
                {alternateCounts.length > 0
                  ? alternateCounts.map(count => {
                    const display = describeElliottCount(count)
                    return <div key={count.id ?? count.label}>{elliottCandidateText(count, display.title)}</div>
                  })
                  : '当前没有保留实质不同的备选'}
              </div>
              {analysis.unresolvedFamilies.length > 0 && (
                <div className="mt-1.5 space-y-0.5 text-[12px] text-muted">
                  {analysis.unresolvedFamilies.map(item => <div key={item.family}>· {elliottFamilyLabel(item.family)}：unresolved，{item.reason}</div>)}
                </div>
              )}
            </WaveCard>

            <WaveCard title="硬规则检查" tone={ruleCounts.fail > 0 ? 'danger' : ruleCounts.unknown > 0 ? 'amber' : 'success'}>
              <div className="flex items-center gap-1.5 font-medium text-foreground">
                {ruleCounts.fail > 0 ? <XCircle className="h-3.5 w-3.5 text-danger" /> : ruleCounts.unknown > 0 ? <AlertTriangle className="h-3.5 w-3.5 text-[#F59E0B]" /> : <CheckCircle2 className="h-3.5 w-3.5 text-[#22C55E]" />}
                满足 {ruleCounts.pass} · 不满足 {ruleCounts.fail} · 无法判断 {ruleCounts.unknown}
              </div>
              <div className="mt-1 text-[12px] text-muted">硬规则失败会淘汰对应候选；无法判断不会被当作满足。</div>
              <div className="mt-1.5 max-h-48 space-y-2 overflow-y-auto text-[13px] text-secondary">
                {ruleGroups.map(([candidateId, items]) => (
                  <div key={candidateId}>
                    <div className="truncate font-mono text-[11px] text-muted" title={candidateId}>候选 {candidateId.slice(0, 18)}</div>
                    {items.map(item => (
                      <div key={item.id ?? (item.candidateId ?? 'candidate') + '-' + item.ruleId} className="truncate" title={item.evidence}>
                        {ruleLabel(item)}：{ruleResultLabel(item)} · {item.evidence}
                      </div>
                    ))}
                  </div>
                ))}
                {rules.length === 0 && <div>暂无可检查的候选规则</div>}
              </div>
            </WaveCard>

            <WaveCard title="独立证据" tone="neutral">
              <EvidenceList evidence={[
                ...analysis.guidelineEvidence,
                ...analysis.fibonacciRelationships,
                ...analysis.channelChecks,
                ...analysis.momentumVolumeEvidence,
              ]} />
            </WaveCard>

            <WaveCard title="观察边界" tone="neutral">
              <div className="font-medium text-foreground">确认</div>
              <div className="mt-1 line-clamp-2 text-secondary">{listText(primary?.confirmation ?? analysis.confirmation, '等待更多结构确认')}</div>
              <div className="mt-1.5 font-medium text-foreground">失效</div>
              <div className="mt-1 line-clamp-2 text-secondary">{listText(primary?.invalidation ?? analysis.invalidation, '当前没有已识别的失效条件')}</div>
              <div className="mt-1.5 font-medium text-foreground">重计数</div>
              <div className="mt-1 line-clamp-2 text-secondary">{listText(primary?.recountConditions ?? analysis.recountConditions, '新增确认拐点或结构冲突时重新计数')}</div>
              <div className="mt-1.5 font-medium text-foreground">下一观察</div>
              <div className="mt-1 line-clamp-2 text-secondary">{listText(primary?.nextObservation ?? analysis.nextObservation, '等待新的确认拐点')}</div>
            </WaveCard>
          </div>

          {showAi && aiResult && <AiExplanationDetails explanation={aiResult} analysis={analysis} />}

          <div className="border-t border-border/50 px-2.5 py-2 text-[12px] leading-relaxed text-muted">
            本地结果只使用当前周期及截至时间以前的 K 线；未收盘尾部仅作疑似展示，不参与主计数。波浪分析仅供研究，不构成投资建议或交易指令。
          </div>
        </>
      )}
    </section>
  )
}

function elliottCandidateText(count: ElliottCount, title: string): string {
  return countDirection(count) + ' · ' + title + ' · ' + (count.currentWave ? '当前' + count.currentWave + ' · ' : '') + count.stage
}

function EvidenceList({ evidence }: { evidence: ElliottEvidence[] }) {
  const visible = evidence.filter(item => item.family !== 'multi_timeframe')
  if (visible.length === 0) return <div className="text-secondary">暂无独立证据</div>
  return (
    <div className="max-h-48 space-y-2 overflow-y-auto text-[13px] text-secondary">
      {[...visible.reduce((groups, item) => {
        const current = groups.get(item.family) ?? []
        groups.set(item.family, [...current, item])
        return groups
      }, new Map<ElliottEvidence['family'], ElliottEvidence[]>())].map(([family, items]) => (
        <div key={family}>
          <div className="text-[11px] text-muted">{EVIDENCE_LABELS[family]}</div>
          {items.map(item => (
            <div key={item.id ?? item.family + '-' + item.observation} className="truncate" title={item.observation}>
              <span className={item.result === 'supports' ? 'text-[#22C55E]' : item.result === 'conflicts' ? 'text-danger' : 'text-muted'}>
                {item.result === 'supports' ? '支持' : item.result === 'conflicts' ? '冲突' : item.result === 'unavailable' ? '不可用' : '中性'}
              </span>
              {' · '}{item.observation}
            </div>
          ))}
        </div>
      ))}
      {evidence.some(item => item.family === 'multi_timeframe') && <div className="text-[12px] text-muted">多周期证据：不可用（当前版本只分析当前周期）</div>}
    </div>
  )
}

function WaveCard({ title, tone, children }: { title: string; tone: 'amber' | 'neutral' | 'danger' | 'success'; children: ReactNode }) {
  const toneClass = tone === 'amber'
    ? 'border-[#F59E0B]/30'
    : tone === 'danger'
      ? 'border-danger/30'
      : tone === 'success'
        ? 'border-[#22C55E]/30'
        : 'border-border'
  return (
    <div className={'min-h-[108px] rounded-card border bg-surface/70 p-2.5 shadow-sm ' + toneClass}>
      <div className="mb-2 text-[12px] font-medium text-foreground">{title}</div>
      <div className="text-[13px] leading-relaxed">{children}</div>
    </div>
  )
}

function AiExplanationDetails({ explanation, analysis }: { explanation: ElliottExplanationResponse; analysis: ElliottAnalysis }) {
  const evidenceById = new Map([
    ...analysis.guidelineEvidence,
    ...analysis.fibonacciRelationships,
    ...analysis.channelChecks,
    ...analysis.momentumVolumeEvidence,
  ].filter(item => item.id).map(item => [item.id as string, item]))
  const referencedEvidence = explanation.evidence_refs.map(id => evidenceById.get(id)).filter((item): item is ElliottEvidence => item != null)
  const notes = [
    ...explanation.disagreements.map(item => '分歧：' + item),
    ...explanation.limitations.map(item => '限制：' + item),
    ...explanation.confirmation.map(item => '确认：' + item),
    ...explanation.invalidation.map(item => '失效：' + item),
    ...explanation.recount_conditions.map(item => '重计数：' + item),
    ...explanation.next_observation.map(item => '下一观察：' + item),
  ]
  return (
    <div className="mx-2 mb-2 rounded-card border border-[#F59E0B]/30 bg-[#F59E0B]/5 p-2.5">
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
        <Sparkles className="h-3.5 w-3.5 text-[#FBBF24]" />
        AI 类型判断与佐证 · 只引用本地事实
        <span className="ml-auto font-mono text-[12px] text-muted">{explanation.explanation_id}</span>
      </div>
      <div className="mt-2 text-[13px] leading-relaxed text-secondary">{explanation.summary || '暂无解释摘要'}</div>
      <div className="mt-2 grid gap-2 text-[13px] md:grid-cols-2">
        <div>
          <div className="text-muted">引用证据</div>
          <div className="mt-1 space-y-1 text-secondary">
            {referencedEvidence.map(item => <div key={item.id}>· {item.observation}</div>)}
            {referencedEvidence.length === 0 && <div>暂无可核对的证据引用</div>}
          </div>
        </div>
        <div>
          <div className="text-muted">分歧 / 边界 / 下一观察</div>
          <div className="mt-1 space-y-1 text-secondary">
            {notes.slice(0, 6).map((item, index) => <div key={item + '-' + index}>· {item}</div>)}
            {notes.length === 0 && <div>暂无补充说明</div>}
          </div>
        </div>
      </div>
      <div className="mt-2 border-t border-[#F59E0B]/20 pt-1.5 text-[12px] text-muted">
        AI 不生成新的计数或硬规则，只在本地候选中判断类型并解释证据；本说明仅供研究。
      </div>
    </div>
  )
}
