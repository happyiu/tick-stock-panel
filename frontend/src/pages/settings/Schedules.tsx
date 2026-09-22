import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Plus, Save, Timer, Trash2 } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { toast } from '@/components/Toast'
import {
  clonePaperTradingTimelineSettings,
  loadPaperTradingTimelineSettings,
  type PaperTradingTimelineCustomPoint,
  type PaperTradingTimelineSettings,
} from '@/components/PaperTradingTimeline'
import {
  getPaperTradingSystemTimelinePoints,
  PAPER_TRADING_STEP_OPTIONS,
  type PaperTradingStepMinutes,
} from '@/lib/paper-trading-time'
import { api } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { storage } from '@/lib/storage'
import { usePreferences } from '@/lib/useSharedQueries'

const input = 'h-9 w-full rounded-btn border border-border bg-base px-2.5 text-sm outline-none focus:border-accent'
const button = 'inline-flex h-9 items-center justify-center gap-1.5 rounded-btn border border-border bg-surface px-3 text-sm font-medium transition-colors hover:border-accent/50 disabled:cursor-not-allowed disabled:opacity-40'
const primary = `${button} border-accent bg-accent text-white hover:bg-accent/90`
const TIMER_METHODS = [
  { name: 'ai追踪分析启动', method: 'seekhub_daily_start', ai: true, defaultParameter: 'YYYY-MM-DD 分析' },
  { name: 'ai追踪分析监控', method: 'seekhub_daily_decision', ai: true, defaultParameter: '开始盘中分析吧' },
] as const
const textareaInput = 'min-h-9 min-w-[20rem] w-full rounded-btn border border-border bg-base px-2.5 py-2 text-sm leading-5 outline-none focus:border-accent resize-none overflow-hidden'

function AutoResizeTextarea({ value, onChange, placeholder, ariaLabel }: { value: string; onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void; placeholder: string; ariaLabel: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const textarea = ref.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight}px`
  }, [value])
  return <textarea
    ref={ref}
    rows={1}
    className={textareaInput}
    value={value}
    onChange={onChange}
    placeholder={placeholder}
    aria-label={ariaLabel}
  />
}

export function SettingsSchedulesPanel() {
  const queryClient = useQueryClient()
  const preferences = usePreferences()
  const [timelineSettingsDraft, setTimelineSettingsDraft] = useState<PaperTradingTimelineSettings>(() => loadPaperTradingTimelineSettings())
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>(() => Object.fromEntries(TIMER_METHODS.map(timer => [timer.method, timer.defaultParameter])))
  const nextTimelinePointId = useRef(Math.max(0, ...timelineSettingsDraft.customPoints.map(point => point.id)) + 1)
  const reviewSchedule = preferences.data?.review_schedule
  const systemTimelinePoints = useMemo(
    () => getPaperTradingSystemTimelinePoints(reviewSchedule),
    [reviewSchedule?.enabled, reviewSchedule?.hour, reviewSchedule?.minute],
  )
  useEffect(() => {
    const prompts = preferences.data?.seekhub_daily_prompts
    if (!prompts) return
    setPromptDrafts(current => Object.fromEntries(TIMER_METHODS.map(timer => [
      timer.method,
      prompts[timer.method] ?? current[timer.method] ?? timer.defaultParameter,
    ])))
  }, [preferences.data?.seekhub_daily_prompts])

  const updateTimelineDraft = (patch: Partial<PaperTradingTimelineSettings>) => {
    setTimelineSettingsDraft(current => ({ ...current, ...patch }))
  }
  const updateTimelinePoint = (id: number, patch: Partial<Omit<PaperTradingTimelineCustomPoint, 'id'>>) => {
    setTimelineSettingsDraft(current => ({
      ...current,
      customPoints: current.customPoints.map(point => point.id === id ? { ...point, ...patch } : point),
    }))
  }
  const addTimelinePoint = () => {
    const id = nextTimelinePointId.current++
    setTimelineSettingsDraft(current => ({
      ...current,
      customPoints: [...current.customPoints, { id, time: '09:30', description: '', timerMethod: '' }],
    }))
  }
  const removeTimelinePoint = (id: number) => {
    setTimelineSettingsDraft(current => ({ ...current, customPoints: current.customPoints.filter(point => point.id !== id) }))
  }
  const toggleTimelineTimerMethod = (method: string) => {
    setTimelineSettingsDraft(current => ({
      ...current,
      timerMethods: current.timerMethods.includes(method)
        ? current.timerMethods.filter(value => value !== method)
        : [...current.timerMethods, method],
    }))
  }
  const savePrompt = useMutation({
    mutationFn: (prompts: Record<string, string>) => Promise.all(
      TIMER_METHODS.map(timer => api.updateSeekhubDailyPrompt(timer.method, prompts[timer.method])),
    ),
    onSuccess: results => {
      setPromptDrafts(Object.fromEntries(results.map(result => [result.method, result.prompt])))
      void queryClient.invalidateQueries({ queryKey: QK.preferences })
      toast('定时任务设置已保存', 'success')
    },
    onError: (error: Error) => toast(error.message || '定时任务设置保存失败', 'error'),
  })
  const saveTimelineSettings = () => {
    const prompts = Object.fromEntries(TIMER_METHODS.map(timer => [timer.method, (promptDrafts[timer.method] ?? '').trim()]))
    if (Object.values(prompts).some(prompt => !prompt)) {
      toast('提示词不能为空', 'error')
      return
    }
    storage.paperTimelineSettings.set(clonePaperTradingTimelineSettings(timelineSettingsDraft))
    savePrompt.mutate(prompts)
  }

  return (
    <>
      <PageHeader title="定时任务" subtitle="配置时间轴步长、系统时间点和自定义时间点。" />
      <div className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.5fr)]">
          <section className="rounded-card border border-border bg-surface p-4">
            <div className="flex items-center gap-2">
              <Timer className="h-4 w-4 text-accent" aria-hidden="true" />
              <h2 className="text-sm font-semibold">时间轴任务</h2>
            </div>
            <div className="mt-3 space-y-3">
              <label className="block space-y-1">
                <span className="text-xs text-secondary">时间轴步长</span>
                <select
                  className={input}
                  value={timelineSettingsDraft.stepMinutes}
                  onChange={event => updateTimelineDraft({ stepMinutes: Number(event.target.value) as PaperTradingStepMinutes })}
                >
                  {PAPER_TRADING_STEP_OPTIONS.map(stepMinutes => <option key={stepMinutes} value={stepMinutes}>{stepMinutes} 分钟</option>)}
                </select>
              </label>
              <div className="block space-y-1">
                <span className="text-xs text-secondary">定时器方法</span>
                <details className="relative">
                  <summary className={input + ' flex cursor-pointer list-none items-center justify-between gap-2 [&::-webkit-details-marker]:hidden'} aria-label="步长定时器方法">
                    <span className="min-w-0 truncate">
                      {TIMER_METHODS.filter(timer => timelineSettingsDraft.timerMethods.includes(timer.method)).map(timer => timer.name).join('、') || '请选择定时器方法'}
                    </span>
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                  </summary>
                  <div className="absolute z-30 mt-1 w-full rounded-btn border border-border bg-elevated p-1 shadow-lg">
                    {TIMER_METHODS.map(timer => (
                      <label key={timer.method} className="flex cursor-pointer items-start gap-2 rounded px-2 py-2 text-xs text-secondary hover:bg-base">
                        <input
                          type="checkbox"
                          className="mt-0.5 h-3.5 w-3.5 accent-accent"
                          checked={timelineSettingsDraft.timerMethods.includes(timer.method)}
                          onChange={() => toggleTimelineTimerMethod(timer.method)}
                        />
                        <span className="min-w-0">
                          <span className="block">{timer.name}</span>
                          <code className="font-mono text-[10px] text-accent">{timer.method}</code>
                        </span>
                      </label>
                    ))}
                  </div>
                </details>
              </div>
            </div>
          </section>

          <section className="rounded-card border border-border bg-surface p-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold">自定义时间点</h2>
                <p className="mt-1 text-xs text-muted">可配置多个时间点、说明和触发方法。</p>
              </div>
              <button type="button" className={button + ' shrink-0'} onClick={addTimelinePoint}>
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                新增时间点
              </button>
            </div>
            <div className="mt-3 space-y-2">
              {timelineSettingsDraft.customPoints.length > 0 && (
                <div className="hidden grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)_2.25rem] gap-2 px-1 text-[11px] text-muted sm:grid">
                  <span>时间点</span><span>说明</span><span>定时器方法</span><span />
                </div>
              )}
              {timelineSettingsDraft.customPoints.map((point, index) => (
                <div key={point.id} className="grid gap-2 rounded-btn border border-border/70 bg-base p-2 sm:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)_2.25rem] sm:items-center sm:border-0 sm:bg-transparent sm:p-0">
                  <label className="space-y-1 sm:space-y-0">
                    <span className="text-[11px] text-muted sm:hidden">时间点</span>
                    <input type="time" className={input} value={point.time} aria-label={`第 ${index + 1} 个自定义时间点`} onChange={event => updateTimelinePoint(point.id, { time: event.target.value })} />
                  </label>
                  <label className="space-y-1 sm:space-y-0">
                    <span className="text-[11px] text-muted sm:hidden">说明</span>
                    <input type="text" className={input} placeholder="例如：开盘检查" value={point.description} aria-label={`第 ${index + 1} 个时间点说明`} onChange={event => updateTimelinePoint(point.id, { description: event.target.value })} />
                  </label>
                  <label className="space-y-1 sm:space-y-0">
                    <span className="text-[11px] text-muted sm:hidden">定时器方法</span>
                    <input type="text" className={input} value={point.timerMethod} readOnly placeholder="由后端返回可执行方法" aria-label={`第 ${index + 1} 个时间点定时器方法`} />
                  </label>
                  <button type="button" className="inline-flex h-9 w-9 items-center justify-center rounded-btn text-muted transition-colors hover:bg-elevated hover:text-bear" aria-label={`删除第 ${index + 1} 个自定义时间点`} title="删除时间点" onClick={() => removeTimelinePoint(point.id)}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              ))}
              {!timelineSettingsDraft.customPoints.length && <div className="rounded-btn border border-dashed border-border px-3 py-6 text-center text-xs text-muted">暂无自定义时间点，点击“新增时间点”开始配置。</div>}
            </div>
          </section>

          <section className="rounded-card border border-border bg-surface p-4 lg:col-span-2">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">系统时间点</h2>
              <span className="rounded border border-yellow-400/30 px-1.5 py-0.5 text-[10px] text-yellow-400">只读</span>
            </div>
            <p className="mt-1 text-xs text-muted">每日复盘时间来自“复盘”页面的“定时复盘”设置。</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {systemTimelinePoints.map(point => (
                <div key={`${point.time}-${point.description}`} className="flex items-center gap-3 rounded-btn border border-border/70 bg-base px-3 py-2">
                  <span className="shrink-0 font-medium tabular-nums text-yellow-400">{point.time}</span>
                  <span className="min-w-0 truncate text-xs text-secondary">{point.description}</span>
                </div>
              ))}
              {!preferences.isLoading && !reviewSchedule?.enabled && (
                <div className="flex items-center gap-3 rounded-btn border border-dashed border-border/70 px-3 py-2 text-muted">
                  <span className="shrink-0 font-medium">每日复盘</span>
                  <span className="min-w-0 truncate text-xs">未启用，请到“复盘”页面开启“定时复盘”</span>
                </div>
              )}
            </div>
          </section>
        </div>

        <section className="rounded-card border border-border bg-surface p-4">
          <h2 className="text-sm font-semibold">定时器方法</h2>
          <div className="mt-3 overflow-hidden rounded-btn border border-border/70">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="bg-base text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">定时器名称</th>
                  <th className="px-3 py-2 font-medium">定时器方法</th>
                  <th className="px-3 py-2 font-medium">参数</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {TIMER_METHODS.map(timer => (
                  <tr key={timer.method}>
                    <td className="px-3 py-2 text-secondary">
                      <span>{timer.name}</span>
                      {timer.ai && <span className="ml-2 rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">AI</span>}
                    </td>
                    <td className="px-3 py-2"><code className="font-mono text-accent">{timer.method}</code></td>
                    <td className="px-3 py-2">
                      <AutoResizeTextarea
                        value={promptDrafts[timer.method] ?? timer.defaultParameter}
                        onChange={event => setPromptDrafts(current => ({ ...current, [timer.method]: event.target.value }))}
                        placeholder={timer.defaultParameter}
                        ariaLabel={`${timer.method} 参数`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted">AI 参数会作为 Hermes 对话内容发送；参数中的 `YYYY-MM-DD` 会在执行时替换为当天日期，没有占位符则按原文发送。</p>
        </section>

        <div className="flex items-center justify-between gap-3 rounded-card border border-border bg-surface px-4 py-3">
          <p className="text-xs leading-5 text-muted">步长任务默认循环执行；自定义时间点的定时器方法由后端返回，前端只保存后端提供的方法标识，不执行任意输入代码。</p>
          <button type="button" className={primary + ' shrink-0'} onClick={saveTimelineSettings} disabled={!preferences.data || savePrompt.isPending}>
            <Save className="h-3.5 w-3.5" aria-hidden="true" />
            {preferences.isLoading ? '加载中...' : savePrompt.isPending ? '保存中...' : '保存并生效'}
          </button>
        </div>
      </div>
    </>
  )
}
