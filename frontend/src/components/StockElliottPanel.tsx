import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, ChevronDown, ExternalLink, Loader2, RefreshCw, Sparkles, XCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import {
  elliottPeriodLabel,
  elliottSnapshotFingerprint,
  type ElliottAnalysis,
  type ElliottAssessmentCount,
  type ElliottAssessmentResponse,
  type ElliottCount,
  type ElliottPeriod,
} from '@/lib/elliott'
import type { OHLC } from '@/components/EChartsCandlestick'

const REFERENCE_URL = 'https://github.com/noahnan-max/elliott-wave-trading-system'

const FAMILY_LABELS: Record<string, string> = {
  impulse: '普通推动浪',
  leading_diagonal: '引导楔形',
  ending_diagonal: '终结楔形',
  zigzag: '锯齿修正',
  flat: '平台修正',
  triangle: '三角形',
  combination: '组合修正',
  unknown: '未定形态',
}

const DIRECTION_LABELS: Record<string, string> = {
  up: '向上',
  down: '向下',
  sideways: '横向',
  mixed: '混合',
}

function countValue(count: ElliottCount | ElliottAssessmentCount | null): ElliottCount | ElliottAssessmentCount | null {
  return count
}

function countFamily(count: ElliottCount | ElliottAssessmentCount | null): string {
  return count ? (FAMILY_LABELS[count.family] ?? count.family) : '暂无主计数'
}

function countDirection(count: ElliottCount | ElliottAssessmentCount | null): string {
  return count ? (DIRECTION_LABELS[count.direction] ?? count.direction) : '等待更多结构'
}

function countPivots(count: ElliottCount | ElliottAssessmentCount | null): string {
  if (!count || count.pivots.length === 0) return '—'
  return count.pivots.map(pivot => `${pivot.label}${pivot.price != null ? ` ${Number(pivot.price).toFixed(2)}` : ''}`).join(' · ')
}

function listText(values: string[] | undefined, fallback: string): string {
  return values?.[0] || fallback
}

function nextObservationValues(count: ElliottCount | ElliottAssessmentCount | null): string[] | undefined {
  if (!count) return undefined
  return 'nextObservation' in count ? count.nextObservation : count.next_observation
}

function ruleId(rule: { ruleId?: string; rule_id?: string }): string {
  return rule.ruleId ?? rule.rule_id ?? '结构规则'
}

function ruleResult(rule: { result: string }): 'pass' | 'fail' | 'unknown' | 'not_applicable' {
  if (rule.result === 'pass' || rule.result === 'fail' || rule.result === 'unknown' || rule.result === 'not_applicable') return rule.result
  return 'unknown'
}

function ruleSummary(rules: Array<{ ruleId?: string; rule_id?: string; result: string; evidence: string }>): { pass: number; fail: number; unknown: number } {
  return rules.reduce((summary, rule) => {
    const result = ruleResult(rule)
    if (result === 'pass') summary.pass += 1
    else if (result === 'fail') summary.fail += 1
    else if (result === 'unknown') summary.unknown += 1
    return summary
  }, { pass: 0, fail: 0, unknown: 0 })
}

function aiRequestRows(rows: OHLC[], asOf: string | null): Array<Pick<OHLC, 'date' | 'open' | 'high' | 'low' | 'close' | 'volume'>> {
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
    }))
}

interface Props {
  symbol: string
  rows: OHLC[]
  period: ElliottPeriod
  analysis: ElliottAnalysis
  collapsed?: boolean
  onToggleCollapsed?: () => void
}

export function StockElliottPanel({
  symbol,
  rows,
  period,
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
  const requestBody = useMemo(() => ({
    symbol,
    period,
    as_of: asOf,
    price_basis: analysis.priceBasis,
    bars: aiRequestRows(rows, asOf),
    local_analysis: analysis,
  }), [analysis, asOf, period, rows, symbol])
  const aiMutation = useMutation({
    mutationFn: () => api.elliottAnalyze(requestBody),
    onSuccess: result => {
      queryClient.setQueryData(queryKey, result)
    },
  })
  const cachedAi = queryClient.getQueryData<ElliottAssessmentResponse>(queryKey)
  const aiResult = aiMutation.data ?? cachedAi

  useEffect(() => {
    setShowAi(false)
    aiMutation.reset()
  }, [aiMutation.reset, queryKeyString])

  const runAi = (force = false) => {
    setShowAi(true)
    if (!force && queryClient.getQueryData<ElliottAssessmentResponse>(queryKey)) return
    if (force) queryClient.removeQueries({ queryKey })
    aiMutation.mutate()
  }

  const localPrimary = countValue(analysis.primaryCount)
  const primary = (aiResult?.primary_count ?? localPrimary) as ElliottCount | ElliottAssessmentCount | null
  const alternateCounts = aiResult?.alternate_counts ?? analysis.alternateCounts
  const rules = aiResult?.hard_rule_checks ?? analysis.hardRuleChecks
  const ruleCounts = ruleSummary(rules)
  const modeLabel = aiResult ? 'AI增强 · 草稿复核' : analysis.definitionMode === 'swing_proxy' ? '波段近似' : '数据不足'
  const currentStage = primary?.stage ?? '等待更多确认拐点'
  const selectedAsOf = aiResult?.as_of ?? analysis.asOf
  const headerContent = (
    <span className="flex min-w-0 items-start gap-1.5">
      {onToggleCollapsed && (
        <ChevronDown className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-muted transition-transform ${collapsed ? '-rotate-90' : ''}`} />
      )}
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-foreground">艾略特波浪理论</span>
          <span className="rounded bg-[#F59E0B]/10 px-1.5 py-0.5 text-[9px] text-[#FBBF24]">{modeLabel}</span>
          <span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[9px] text-secondary">{elliottPeriodLabel(period)}</span>
        </span>
        {!collapsed && (
          <span className="mt-0.5 block truncate text-[10px] text-muted">
            {selectedAsOf ? `截至 ${selectedAsOf}` : '等待当前周期行情'} · 研究辅助，不构成买卖建议
          </span>
        )}
      </span>
    </span>
  )
  const headerClassName = `flex w-full items-start px-2.5 py-2 text-left transition-colors ${collapsed ? 'border-b border-border/70' : ''} ${onToggleCollapsed ? 'hover:bg-elevated/40' : ''}`

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
              className="inline-flex items-center gap-1 rounded border border-[#F59E0B]/40 bg-[#F59E0B]/10 px-2 py-1 text-[10px] text-[#FBBF24] transition-colors hover:bg-[#F59E0B]/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {aiMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
              {aiMutation.isPending ? '评估中…' : aiResult ? '查看 AI 评估' : 'AI 增强评估'}
            </button>
            {aiResult && !aiMutation.isPending && (
              <button
                type="button"
                onClick={() => runAi(true)}
                className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-muted transition-colors hover:bg-elevated hover:text-foreground"
                title="重新生成本次历史截面的 AI 评估"
              >
                <RefreshCw className="h-3 w-3" />
                重新评估
              </button>
            )}
            <a
              href={REFERENCE_URL}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-muted transition-colors hover:bg-elevated hover:text-foreground"
              title="查看参考工作流"
            >
              方法参考 <ExternalLink className="h-3 w-3" />
            </a>
          </div>

          {aiMutation.error && (
            <div className="mx-2 mb-2 rounded border border-danger/30 bg-danger/5 px-2.5 py-2 text-[10px] leading-relaxed text-danger">
              AI 评估暂时不可用：{aiMutation.error.message}。可在 <Link to="/settings?tab=ai" className="underline">AI 设置</Link> 中检查配置；本地波段近似仍可使用。
            </div>
          )}

          <div className="grid gap-2 p-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
            <WaveCard title="当前计数" tone="amber">
              <div className="font-medium text-foreground">{primary ? `${primary.label} · ${countFamily(primary)}` : '暂无可用主计数'}</div>
              <div className="mt-1 text-secondary">{primary ? `${countDirection(primary)} · ${currentStage}` : '等待新的确认拐点'}</div>
              <div className="mt-1.5 truncate font-mono text-[10px] text-muted" title={countPivots(primary)}>{countPivots(primary)}</div>
            </WaveCard>

            <WaveCard title="备选与歧义" tone={analysis.ambiguity === 'multiple_viable' || aiResult?.ambiguity === 'multiple_viable' ? 'amber' : 'neutral'}>
              <div className="font-medium text-foreground">
                {(aiResult?.ambiguity ?? analysis.ambiguity) === 'multiple_viable' ? '存在多个可行计数' : (aiResult?.ambiguity ?? analysis.ambiguity) === 'unresolved' ? '结构尚未解决' : '主计数占优'}
              </div>
              <div className="mt-1 text-secondary">
                {alternateCounts.length > 0
                  ? alternateCounts.map(count => `${count.label} · ${FAMILY_LABELS[count.family] ?? count.family}`).join('；')
                  : '当前没有保留实质不同的备选'}
              </div>
              <div className="mt-1.5 text-[10px] text-muted">本地代理不会将三段摆动强行命名为具体修正形态</div>
            </WaveCard>

            <WaveCard title="硬规则" tone={ruleCounts.fail > 0 ? 'danger' : ruleCounts.unknown > 0 ? 'amber' : 'success'}>
              <div className="flex items-center gap-1.5 font-medium text-foreground">
                {ruleCounts.fail > 0 ? <XCircle className="h-3.5 w-3.5 text-danger" /> : ruleCounts.unknown > 0 ? <AlertTriangle className="h-3.5 w-3.5 text-[#F59E0B]" /> : <CheckCircle2 className="h-3.5 w-3.5 text-[#22C55E]" />}
                通过 {ruleCounts.pass} · 冲突 {ruleCounts.fail} · 未知 {ruleCounts.unknown}
              </div>
              <div className="mt-1.5 space-y-0.5 text-[10px] text-secondary">
                {rules.slice(0, 3).map(rule => <div key={`${ruleId(rule)}-${rule.result}`} className="truncate" title={rule.evidence}>{ruleId(rule)}：{ruleResult(rule)}</div>)}
                {rules.length === 0 && <div>暂无可检查的推动浪规则</div>}
              </div>
            </WaveCard>

            <WaveCard title="观察边界" tone="neutral">
              <div className="font-medium text-foreground">确认</div>
              <div className="mt-1 line-clamp-2 text-secondary">{listText(aiResult?.confirmation ?? primary?.confirmation ?? analysis.confirmation, '等待更多结构确认')}</div>
              <div className="mt-1.5 font-medium text-foreground">失效 / 下一观察</div>
              <div className="mt-1 line-clamp-2 text-secondary">{listText(aiResult?.invalidation ?? primary?.invalidation ?? analysis.invalidation, listText(aiResult?.next_observation ?? nextObservationValues(primary) ?? analysis.nextObservation, '等待新的确认拐点'))}</div>
            </WaveCard>
          </div>

          {(showAi && aiResult) && <AiAssessmentDetails assessment={aiResult} />}

          <div className="border-t border-border/50 px-2.5 py-2 text-[9px] leading-relaxed text-muted">
            本地结果只使用当前周期及截至时间以前的 K 线；投影点不参与主计数。艾略特波浪分析仅供研究，不构成投资建议或交易指令。
          </div>
        </>
      )}
    </section>
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
    <div className={`min-h-[108px] rounded-card border bg-surface/70 p-2.5 shadow-sm ${toneClass}`}>
      <div className="mb-2 text-[11px] font-medium text-foreground">{title}</div>
      <div className="text-[10px] leading-relaxed">{children}</div>
    </div>
  )
}

function AiAssessmentDetails({ assessment }: { assessment: ElliottAssessmentResponse }) {
  const evidence = [
    ...assessment.guideline_evidence,
    ...assessment.fibonacci_relationships,
    ...assessment.channel_checks,
    ...assessment.momentum_volume_evidence,
  ]
  return (
    <div className="mx-2 mb-2 rounded-card border border-[#F59E0B]/30 bg-[#F59E0B]/5 p-2.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
        <Sparkles className="h-3.5 w-3.5 text-[#FBBF24]" />
        AI 结构化评估 · {assessment.definition_mode}
        <span className="ml-auto font-mono text-[9px] text-muted">{assessment.assessment_id}</span>
      </div>
      <div className="mt-2 grid gap-2 text-[10px] md:grid-cols-2">
        <div>
          <div className="text-muted">支持证据</div>
          <div className="mt-1 space-y-1 text-secondary">
            {evidence.filter(item => item.result === 'supports').slice(0, 3).map(item => <div key={`${item.family}-${item.observation}`}>· {item.observation}</div>)}
            {!evidence.some(item => item.result === 'supports') && <div>暂无独立支持证据</div>}
          </div>
        </div>
        <div>
          <div className="text-muted">重计数条件 / 下一观察</div>
          <div className="mt-1 space-y-1 text-secondary">
            {[...assessment.recount_conditions, ...assessment.next_observation].slice(0, 3).map(item => <div key={item}>· {item}</div>)}
          </div>
        </div>
      </div>
      <div className="mt-2 border-t border-[#F59E0B]/20 pt-1.5 text-[9px] text-muted">
        数据质量：{assessment.data_quality.status}；多周期证据在首版中标记为不可用。该评估是草稿复核状态，只允许观察。
      </div>
    </div>
  )
}
