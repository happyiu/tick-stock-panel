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

function ruleSummary(rules: ElliottRuleCheck[]): { pass: number; fail: number; unknown: number; notApplicable: number } {
  return rules.reduce((summary, rule) => {
    const result = ruleResult(rule)
    if (result === 'pass') summary.pass += 1
    else if (result === 'fail') summary.fail += 1
    else if (result === 'unknown') summary.unknown += 1
    else if (result === 'not_applicable') summary.notApplicable += 1
    return summary
  }, { pass: 0, fail: 0, unknown: 0, notApplicable: 0 })
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
  const primaryRules = primary ? rules.filter(item => item.candidateId === primary.id) : []
  const primaryRuleCounts = ruleSummary(primaryRules)
  const allRuleCounts = ruleSummary(rules)
  const ruleGroups = [...rules.reduce((groups, item) => {
    const key = item.candidateId ?? 'analysis'
    const current = groups.get(key) ?? []
    groups.set(key, [...current, item])
    return groups
  }, new Map<string, ElliottRuleCheck[]>())]
  const candidateById = new Map(
    [primary, ...alternateCounts]
      .filter((item): item is ElliottCount => item != null && item.id != null)
      .map(item => [item.id as string, item]),
  )
  const path = primary?.wavePath?.length ? primary.wavePath : countDisplay.sequence
  const primaryConflicts = primaryRules.filter(item => ruleResult(item) === 'fail')
  const structuralValidity = !primary
    ? '无法确定'
    : primaryRules.length === 0
      ? '待确认'
      : primaryRuleCounts.fail > 0
        ? '无效'
        : primaryRuleCounts.unknown > 0
          ? '待确认'
          : '可接受'
  const validityTone = structuralValidity === '无效'
    ? 'danger'
    : structuralValidity === '待确认' || structuralValidity === '无法确定'
      ? 'amber'
      : 'success'
  const confirmationStatus = primary ? (primaryConflicts.length > 0 ? '结构无效' : '待确认') : '无法确定'
  const aiCandidateId = aiResult?.verdict?.candidate_id || aiResult?.primary_scenario?.candidate_id || ''
  const aiReview = !aiResult
    ? { label: '未复核', className: 'text-muted' }
    : aiCandidateId && aiCandidateId === primary?.id
      ? { label: '一致', className: 'text-[#22C55E]' }
      : aiCandidateId
        ? { label: '需核对', className: 'text-[#FBBF24]' }
        : { label: '已返回', className: 'text-secondary' }
  const evidenceSummary = [
    { label: '结构关系', items: analysis.guidelineEvidence.filter(item => item.family === 'structure') },
    { label: '交替性', items: analysis.guidelineEvidence.filter(item => item.family === 'alternation') },
    { label: 'Fibonacci', items: analysis.fibonacciRelationships },
    { label: '比例关系', items: analysis.guidelineEvidence.filter(item => item.family === 'proportionality') },
  ].map(item => ({ ...item, state: evidenceState(item.items) }))
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

          <div className="grid gap-2 p-2">
            <WaveCard title="当前判断" tone={validityTone}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-lg font-semibold text-foreground">
                    {primary ? directionMark(primary.direction) + ' ' + countDirection(primary) + (isCorrectionFamily(primary.family) ? '修正' : '推动') : '等待更多结构'}
                  </div>
                  <div className="mt-1 text-sm font-medium text-foreground">{countTitle(primary)}</div>
                  <div className="mt-1 text-secondary">
                    {primary?.currentWave ? '当前：' + primary.currentWave + ' 浪 · ' : ''}{countDisplay.stage}
                  </div>
                </div>
                <span className={'shrink-0 rounded px-1.5 py-0.5 text-[12px] ' + (confirmationStatus === '结构无效' ? 'bg-danger/10 text-danger' : confirmationStatus === '待确认' ? 'bg-[#F59E0B]/15 text-[#FBBF24]' : 'bg-elevated text-secondary')}>
                  {confirmationStatus}
                </span>
              </div>
              {path.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center text-[12px]" aria-label={'波浪路径：' + path.join(' ')}>
                  {path.map((item, index) => (
                    <span key={item + '-' + index} className="inline-flex items-center">
                      {index > 0 && <span className="mx-1 text-muted/60">→</span>}
                      <span className={'rounded px-1.5 py-0.5 ' + (index === path.length - 1 ? 'bg-[#F59E0B]/20 text-[#FBBF24]' : 'bg-elevated text-secondary')}>
                        {item}
                      </span>
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-1.5 truncate font-mono text-[13px] text-muted" title={countPivots(primary, path, assetType)}>
                拐点价格：{countPivots(primary, path, assetType)}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-1.5 border-t border-border/50 pt-2 sm:grid-cols-4">
                <div><div className="text-[11px] text-muted">结构有效性</div><div className={'mt-0.5 font-medium ' + (validityTone === 'danger' ? 'text-danger' : validityTone === 'amber' ? 'text-[#FBBF24]' : 'text-[#22C55E]')}>{structuralValidity}</div></div>
                <div><div className="text-[11px] text-muted">结构证据</div><div className={'mt-0.5 font-medium ' + evidenceSummary[0].state.className}>{evidenceSummary[0].state.label}</div></div>
                <div><div className="text-[11px] text-muted">Fibonacci</div><div className={'mt-0.5 font-medium ' + evidenceSummary[2].state.className}>{evidenceSummary[2].state.label}</div></div>
                <div><div className="text-[11px] text-muted">AI 复核</div><div className={'mt-0.5 font-medium ' + aiReview.className}>{aiReview.label}</div></div>
              </div>
              <div className="mt-2 rounded border border-border/60 bg-elevated/30 px-2 py-1.5 text-secondary">
                <span className="text-muted">判断：</span>{aiResult?.summary || primary?.supportSummary?.[0] || '当前没有足够的本地候选形成结论'}
              </div>
              <div className="mt-2 grid gap-1.5 text-secondary sm:grid-cols-2">
                <div><span className="text-muted">下一确认：</span>{listText(primary?.confirmation ?? analysis.confirmation, '等待更多结构确认')}</div>
                <div><span className="text-muted">失效条件：</span>{listText(primary?.invalidation ?? analysis.invalidation, '当前没有已识别的失效条件')}</div>
              </div>
            </WaveCard>

            <div className="grid gap-2 md:grid-cols-2">
              <WaveCard title="结构状态" tone={validityTone}>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                  {evidenceSummary.map(item => (
                    <div key={item.label} className="flex items-center justify-between gap-2">
                      <span className="text-secondary">{item.label}</span>
                      <span className={'font-medium ' + item.state.className}>{item.state.mark} {item.state.label}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-2 rounded border border-border/60 bg-elevated/30 px-2 py-1.5">
                  <div className="flex items-center gap-1.5 font-medium text-foreground">
                    {structuralValidity === '无效' ? <XCircle className="h-3.5 w-3.5 text-danger" /> : structuralValidity === '待确认' || structuralValidity === '无法确定' ? <AlertTriangle className="h-3.5 w-3.5 text-[#F59E0B]" /> : <CheckCircle2 className="h-3.5 w-3.5 text-[#22C55E]" />}
                    结构有效性：{structuralValidity}
                  </div>
                  <div className="mt-1 text-[12px] text-muted">
                    当前结构 {primaryRuleCounts.pass} 通过 · {primaryRuleCounts.fail} 冲突 · {primaryRuleCounts.unknown} 待定{primaryRuleCounts.notApplicable > 0 ? ' · ' + primaryRuleCounts.notApplicable + ' 不适用' : ''}
                  </div>
                  <div className="mt-1 text-[12px] text-secondary">
                    {primaryConflicts[0]?.evidence || (primaryRuleCounts.unknown > 0 ? '部分当前结构规则仍待确认' : '未发现当前主计数的关键冲突')}
                  </div>
                </div>
                <details className="mt-2 rounded border border-border/60 bg-base/30 px-2 py-1.5">
                  <summary className="cursor-pointer text-[12px] text-secondary">查看完整规则 <span className="text-muted">（全部 {allRuleCounts.pass} 通过 · {allRuleCounts.fail} 冲突 · {allRuleCounts.unknown} 待定）</span></summary>
                  <div className="mt-2 max-h-64 space-y-2 overflow-y-auto text-[12px] text-secondary">
                    {ruleGroups.map(([candidateId, items]) => {
                      const candidate = candidateById.get(candidateId)
                      const groupLabel = candidate
                        ? (candidateId === primary?.id ? '当前主计数 · ' : '其他候选 · ') + countTitle(candidate)
                        : candidateId.startsWith('unresolved:') ? '尚未解决的结构' : '其他规则'
                      return (
                        <div key={candidateId}>
                          <div className="text-[11px] text-muted">{groupLabel}</div>
                          {items.map(item => (
                            <div key={item.id ?? (item.candidateId ?? 'candidate') + '-' + item.ruleId} className="truncate" title={item.evidence}>
                              {ruleLabel(item)}：{ruleResultLabel(item)} · {item.evidence}
                            </div>
                          ))}
                        </div>
                      )
                    })}
                    {rules.length === 0 && <div>暂无可检查的候选规则</div>}
                  </div>
                </details>
              </WaveCard>

              <WaveCard title={'备选计数' + (alternateCounts.length > 0 ? ' · ' + alternateCounts.length + ' 个' : '')} tone={analysis.ambiguity === 'multiple_viable' ? 'amber' : 'neutral'}>
                <div className="text-[12px] text-muted">
                  {analysis.ambiguity === 'multiple_viable' ? '以下是排序靠前的其他可行路径' : analysis.ambiguity === 'unresolved' ? '当前结构尚未解决' : '主计数暂时占优'}
                </div>
                <div className="mt-1.5 space-y-2">
                  {alternateCounts.length > 0
                    ? alternateCounts.slice(0, 2).map((count, index) => {
                      const display = describeElliottCount(count)
                      return (
                        <div key={count.id ?? count.label} className="rounded border border-border/60 bg-base/30 px-2 py-1.5">
                          <div className="font-medium text-foreground">#{count.rank ?? index + 2} · {countDirection(count)} · {countTitle(count)}</div>
                          <div className="mt-0.5 text-secondary">{count.currentWave ? '当前：' + count.currentWave + ' 浪 · ' : ''}{display.stage}</div>
                          <div className="mt-0.5 text-[12px] text-muted">切换条件：{count.confirmation[0] ?? count.nextObservation[0] ?? '等待新的结构证据'}</div>
                        </div>
                      )
                    })
                    : <div className="text-secondary">当前没有保留实质不同的备选</div>}
                </div>
                {analysis.unresolvedFamilies.length > 0 && (
                  <div className="mt-2 text-[12px] text-muted">未展开家族：{analysis.unresolvedFamilies.map(item => elliottFamilyLabel(item.family)).join('、')}</div>
                )}
              </WaveCard>
            </div>

            <details className="rounded-card border border-border bg-surface/70 shadow-sm">
              <summary className="flex cursor-pointer items-center justify-between gap-2 px-2.5 py-2 text-[12px] font-medium text-foreground">
                <span>展开分析依据</span>
                <span className="text-muted">独立证据 · 观察边界 · 限制</span>
              </summary>
              <div className="grid gap-2 border-t border-border/50 p-2 md:grid-cols-2">
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
                  <div className="mt-1 text-secondary">{listText(primary?.confirmation ?? analysis.confirmation, '等待更多结构确认')}</div>
                  <div className="mt-1.5 font-medium text-foreground">失效</div>
                  <div className="mt-1 text-secondary">{listText(primary?.invalidation ?? analysis.invalidation, '当前没有已识别的失效条件')}</div>
                  <div className="mt-1.5 font-medium text-foreground">重计数</div>
                  <div className="mt-1 text-secondary">{listText(primary?.recountConditions ?? analysis.recountConditions, '新增确认拐点或结构冲突时重新计数')}</div>
                  <div className="mt-1.5 font-medium text-foreground">下一观察</div>
                  <div className="mt-1 text-secondary">{listText(primary?.nextObservation ?? analysis.nextObservation, '等待新的确认拐点')}</div>
                </WaveCard>
                <div className="rounded-card border border-border bg-surface/70 p-2.5 text-[12px] leading-relaxed text-secondary md:col-span-2">
                  <div className="font-medium text-foreground">限制与未解决结构</div>
                  <div className="mt-1">{analysis.dataQuality.limitations.length > 0 ? analysis.dataQuality.limitations.join('；') : '当前没有额外数据质量限制'}</div>
                  {analysis.unresolvedFamilies.length > 0 && <div className="mt-1">{analysis.unresolvedFamilies.map(item => item.family + '：' + item.reason).join('；')}</div>}
                </div>
              </div>
            </details>
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

function countTitle(count: ElliottCount | null): string {
  return describeElliottCount(count).title.replace(/候选/g, '').trim()
}

function directionMark(direction: ElliottCount['direction']): string {
  return direction === 'up' ? '↑' : direction === 'down' ? '↓' : direction === 'sideways' ? '→' : '↕'
}

function isCorrectionFamily(family: ElliottCount['family']): boolean {
  return family === 'zigzag' || family === 'flat' || family === 'triangle' || family === 'combination' || family === 'unknown'
}

function evidenceState(items: ElliottEvidence[]): { mark: string; label: string; className: string } {
  if (items.some(item => item.result === 'conflicts')) return { mark: '×', label: '冲突', className: 'text-danger' }
  if (items.some(item => item.result === 'supports')) return { mark: '✓', label: '支持', className: 'text-[#22C55E]' }
  if (items.some(item => item.result === 'unavailable')) return { mark: '○', label: '待定', className: 'text-[#FBBF24]' }
  return { mark: '○', label: '中性', className: 'text-muted' }
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
  const referencedEvidence = (explanation.evidence_refs ?? []).map(id => evidenceById.get(id)).filter((item): item is ElliottEvidence => item != null)
  const primary = analysis.primaryCount
  const fallbackVerdict = {
    candidate_id: primary?.id ?? '',
    label: primary ? countDirection(primary) + ' ' + (primary.currentWave ? primary.currentWave + '浪' : '结构候选') : '无法确定',
    structure_family: primary ? (primary.family === 'impulse' || primary.family === 'leading_diagonal' || primary.family === 'ending_diagonal' ? '推动结构' : '调整结构') : '无法确定',
    direction: primary ? countDirection(primary) : '无法确定',
    current_wave: primary?.currentWave ?? '无法确定',
    phase: primary?.stage ?? '无法确定',
    plain_text: explanation.summary || '无法确定',
  }
  const verdict = explanation.verdict ?? fallbackVerdict
  const fallbackPrimary = primary ? {
    candidate_id: primary.id ?? '',
    current_structure: describeElliottCount(primary).title,
    current_wave: primary.currentWave ?? '无法确定',
    interpretation: explanation.summary || '',
    next_expected: explanation.next_observation?.[0] ?? primary.nextObservation[0] ?? '',
    supporting_reasons: [],
  } : null
  const primaryScenario = explanation.primary_scenario ?? fallbackPrimary
  const localCandidates = [analysis.primaryCount, ...analysis.alternateCounts].filter((item): item is ElliottCount => item != null)
  const candidateById = new Map(localCandidates.filter(item => item.id).map(item => [item.id as string, item]))
  const alternateScenarios = Array.isArray(explanation.alternate_scenarios) && explanation.alternate_scenarios.length > 0
    ? explanation.alternate_scenarios
    : analysis.alternateCounts.map(count => ({
      candidate_id: count.id ?? '',
      scenario: elliottCandidateText(count, describeElliottCount(count).title),
      interpretation: '',
      difference_from_primary: '',
      becomes_more_likely_if: count.confirmation[0] ?? '',
    }))
  const notes = [
    ...(explanation.disagreements ?? []).map(item => '分歧：' + item),
    ...(explanation.limitations ?? []).map(item => '限制：' + item),
  ]
  return (
    <div className="mx-2 mb-2 rounded-card border border-[#F59E0B]/30 bg-[#F59E0B]/5 p-2.5">
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
        <Sparkles className="h-3.5 w-3.5 text-[#FBBF24]" />
        AI 波浪判断 · 只引用本地事实
        <span className="ml-auto font-mono text-[12px] text-muted">{explanation.explanation_id}</span>
      </div>
      <div className="mt-2 rounded border border-[#F59E0B]/25 bg-[#F59E0B]/10 p-2">
        <div className="text-base font-semibold text-[#FBBF24]">{verdict.label || '无法确定'}</div>
        <div className="mt-1 text-[13px] text-secondary">
          {verdict.structure_family || '无法确定'} · {verdict.direction || '无法确定'} · 当前{verdict.current_wave || '无法确定'} · {verdict.phase || '阶段无法确定'}
        </div>
        <div className="mt-1.5 text-[13px] leading-relaxed text-foreground">{verdict.plain_text || explanation.summary || '暂无解释摘要'}</div>
      </div>
      <div className="mt-2 text-[13px] leading-relaxed text-secondary">{explanation.summary || '暂无解释摘要'}</div>
      {primaryScenario && (
        <div className="mt-2 rounded border border-border/70 bg-surface/50 p-2 text-[13px]">
          <div className="font-medium text-foreground">主判断{candidateById.get(primaryScenario.candidate_id)?.rank ? ' · #' + candidateById.get(primaryScenario.candidate_id)?.rank : ''}</div>
          <div className="mt-1 text-secondary">{primaryScenario.current_structure || '结构无法确定'} · 当前{primaryScenario.current_wave || '无法确定'}</div>
          {primaryScenario.interpretation && <div className="mt-1 leading-relaxed text-secondary">{primaryScenario.interpretation}</div>}
          {primaryScenario.next_expected && <div className="mt-1 leading-relaxed text-secondary"><span className="text-muted">接下来：</span>{primaryScenario.next_expected}</div>}
          {primaryScenario.supporting_reasons.length > 0 && (
            <div className="mt-1 space-y-0.5 text-secondary">
              {primaryScenario.supporting_reasons.map((item, index) => <div key={item + '-' + index}>· {item}</div>)}
            </div>
          )}
        </div>
      )}
      {alternateScenarios.length > 0 && (
        <div className="mt-2 rounded border border-[#F59E0B]/20 bg-surface/40 p-2 text-[13px]">
          <div className="font-medium text-foreground">备选方案</div>
          <div className="mt-1.5 space-y-2">
            {alternateScenarios.map(item => {
              const local = candidateById.get(item.candidate_id)
              return (
                <div key={item.candidate_id || item.scenario} className="text-secondary">
                  <div className="font-medium text-foreground">{local?.rank ? '#' + local.rank + ' · ' : ''}{item.scenario || (local ? elliottCandidateText(local, describeElliottCount(local).title) : '无法确定')}</div>
                  {item.interpretation && <div className="mt-0.5">{item.interpretation}</div>}
                  {item.difference_from_primary && <div className="mt-0.5"><span className="text-muted">与主方案差异：</span>{item.difference_from_primary}</div>}
                  {item.becomes_more_likely_if && <div className="mt-0.5"><span className="text-muted">切换条件：</span>{item.becomes_more_likely_if}</div>}
                </div>
              )
            })}
          </div>
        </div>
      )}
      <div className="mt-2 grid gap-2 text-[13px] md:grid-cols-2">
        <div className="rounded border border-border/60 bg-surface/40 p-2">
          <div className="font-medium text-foreground">确认 / 失效 / 重计数</div>
          <div className="mt-1 space-y-1 text-secondary">
            {(explanation.confirmation ?? []).map(item => <div key={'确认-' + item}>确认：{item}</div>)}
            {(explanation.invalidation ?? []).map(item => <div key={'失效-' + item}>失效：{item}</div>)}
            {(explanation.recount_conditions ?? []).map(item => <div key={'重计数-' + item}>重计数：{item}</div>)}
            {(explanation.confirmation ?? []).length === 0 && (explanation.invalidation ?? []).length === 0 && (explanation.recount_conditions ?? []).length === 0 && <div>暂无补充边界</div>}
          </div>
        </div>
        <div className="rounded border border-border/60 bg-surface/40 p-2">
          <div className="font-medium text-foreground">下一观察</div>
          <div className="mt-1 space-y-1 text-secondary">
            {(explanation.next_observation ?? []).map(item => <div key={item}>· {item}</div>)}
            {(explanation.next_observation ?? []).length === 0 && <div>暂无下一观察</div>}
          </div>
        </div>
      </div>
      <div className="mt-2 grid gap-2 text-[13px] md:grid-cols-2">
        <div>
          <div className="text-muted">引用证据</div>
          <div className="mt-1 space-y-1 text-secondary">
            {referencedEvidence.map(item => <div key={item.id}>· {item.observation}</div>)}
            {referencedEvidence.length === 0 && <div>暂无可核对的证据引用</div>}
          </div>
        </div>
        <div>
          <div className="text-muted">分歧 / 限制</div>
          <div className="mt-1 space-y-1 text-secondary">
            {notes.slice(0, 6).map((item, index) => <div key={item + '-' + index}>· {item}</div>)}
            {notes.length === 0 && <div>暂无补充说明</div>}
          </div>
        </div>
      </div>
      <div className="mt-2 border-t border-[#F59E0B]/20 pt-1.5 text-[12px] text-muted">
        AI 不生成新的计数或硬规则，只解释本地排名候选；名次不是概率，本说明仅供研究。
      </div>
    </div>
  )
}
