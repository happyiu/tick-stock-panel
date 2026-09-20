import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, Bot, Loader2, Plus, RefreshCw, Send, Settings2, Sparkles, Square,
} from 'lucide-react'
import { MarkdownRenderer } from '@/components/financials/MarkdownRenderer'
import { useSettings } from '@/lib/useSharedQueries'
import type { StockChatSnapshotV1 } from '@/lib/api'
import {
  newStockChat,
  retryStockChat,
  sendStockChat,
  stockChatOverviewPrompt,
  stopStockChat,
  useStockChat,
} from '@/lib/stockChatStore'

interface Props {
  symbol: string
  snapshot: StockChatSnapshotV1 | null
}

const HERMES_AGENT_PROVIDER = 'hermes_agent'
const SUGGESTIONS = [
  '当前趋势和均线状态如何？',
  '结构近似的关键确认和失效条件是什么？',
  '当前支撑、压力和主要风险有哪些？',
]

function isWorking(phase: string | undefined): boolean {
  return phase === 'loading' || phase === 'streaming'
}

function snapshotAsOf(snapshot: StockChatSnapshotV1 | null): string {
  if (!snapshot?.as_of) return '最新'
  return snapshot.period === '30m'
    ? snapshot.as_of.replace('T', ' ').slice(5, 16)
    : snapshot.as_of.slice(0, 10)
}

export function StockAiChatPanel({ symbol, snapshot }: Props) {
  const settings = useSettings()
  const conversation = useStockChat(symbol)
  const [draft, setDraft] = useState('')
  const [submitError, setSubmitError] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const previousSymbolRef = useRef(symbol)

  const phase = conversation?.phase ?? 'idle'
  const working = isWorking(phase)
  const providerReady = settings.data?.ai_provider === HERMES_AGENT_PROVIDER
  const hermesConfigured = settings.data?.hermes_configured
    ?? (!!settings.data?.hermes_gateway_url && !!settings.data?.hermes_model && !!settings.data?.has_hermes_key)
  const displayedSnapshot = conversation?.snapshot ?? snapshot
  // A restored session must remain usable while the current chart is still
  // loading. Its immutable first-turn snapshot is the source of truth.
  const activeSnapshot = snapshot ?? conversation?.snapshot ?? null
  const canChat = providerReady && hermesConfigured && !!activeSnapshot
  const canRetry = canChat
    && !!conversation
    && !working
    && (phase === 'error' || phase === 'stopped' || phase === 'interrupted')
    && conversation.messages.some(message => message.role === 'user')

  // A different symbol has its own conversation viewport.  Start it at the
  // latest message even if the previous symbol's viewport had been scrolled
  // up by the user.
  useEffect(() => {
    if (previousSymbolRef.current === symbol) return
    previousSymbolRef.current = symbol
    stickToBottomRef.current = true
  }, [symbol])

  useEffect(() => {
    if (!stickToBottomRef.current || !scrollRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [conversation?.messages, phase])

  const headerCaption = useMemo(() => {
    if (!displayedSnapshot) return '等待当前周期行情与结构计算…'
    return `${displayedSnapshot.period} · 截至 ${snapshotAsOf(displayedSnapshot)} · 会话快照固定`
  }, [displayedSnapshot])

  const send = async (value = draft) => {
    const prompt = value.trim()
    if (!prompt || working || !canChat) return
    setSubmitError('')
    // Set this before updating the external store.  The store update can
    // render synchronously before the awaited stream setup returns.
    stickToBottomRef.current = true
    const result = await sendStockChat(symbol, activeSnapshot, prompt)
    if (result.error) {
      setSubmitError(result.error)
      return
    }
    setDraft('')
  }

  const handleNew = () => {
    if (working) return
    if (conversation?.messages.length && !window.confirm('新建对话会清除当前标的的会话内容, 确定继续吗？')) return
    newStockChat(symbol)
    setDraft('')
    setSubmitError('')
  }

  const handleRetry = async () => {
    setSubmitError('')
    stickToBottomRef.current = true
    const result = await retryStockChat(symbol)
    if (result.error) setSubmitError(result.error)
  }

  const onScroll = () => {
    const element = scrollRef.current
    if (!element) return
    stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
  }

  return (
    <section className="flex h-full min-h-[360px] flex-col bg-surface/30">
      <div className="sticky top-0 z-10 flex shrink-0 items-center justify-between gap-2 border-b border-border/70 bg-surface/95 px-3 py-2 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-sky-500/15 text-sky-300">
            <Bot className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
              <span>Hermes 对话</span>
              <span className="rounded-full border border-sky-400/25 bg-sky-400/[0.08] px-1.5 py-px text-[9px] font-normal text-sky-300">Agent</span>
            </div>
            <div className="truncate text-[10px] text-muted" title={headerCaption}>{headerCaption}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {working && (
            <button
              type="button"
              onClick={() => stopStockChat(symbol)}
              className="inline-flex items-center gap-1 rounded-btn px-2 py-1 text-[10px] text-bear transition-colors hover:bg-bear/10"
              title="停止生成"
            >
              <Square className="h-3 w-3" />停止
            </button>
          )}
          {conversation && !working && (
            <button
              type="button"
              onClick={handleNew}
              className="inline-flex items-center gap-1 rounded-btn px-2 py-1 text-[10px] text-muted transition-colors hover:bg-elevated hover:text-foreground"
              title="新建对话"
            >
              <Plus className="h-3 w-3" />新对话
            </button>
          )}
        </div>
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {!providerReady && settings.isLoading && (
          <div className="flex items-center justify-center gap-2 py-12 text-xs text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />正在读取 Hermes 配置…
          </div>
        )}

        {settings.data && !providerReady && (
          <div className="rounded-lg border border-amber-400/25 bg-amber-400/[0.06] p-3 text-xs text-secondary">
            <div className="flex items-center gap-2 font-medium text-amber-300"><AlertTriangle className="h-3.5 w-3.5" />详情页对话仅支持 Hermes Agent</div>
            <p className="mt-1.5 leading-relaxed">当前启用的是其他 AI Provider。请在设置中切换并配置 Hermes，普通模型不会被本功能自动调用。</p>
            <button type="button" onClick={() => { window.location.href = '/settings?tab=ai' }} className="mt-2 inline-flex items-center gap-1.5 rounded-btn border border-border bg-elevated px-2.5 py-1.5 text-[11px] text-secondary hover:text-foreground">
              <Settings2 className="h-3 w-3" />去配置 Hermes
            </button>
          </div>
        )}

        {providerReady && !hermesConfigured && (
          <div className="rounded-lg border border-amber-400/25 bg-amber-400/[0.06] p-3 text-xs text-secondary">
            <div className="flex items-center gap-2 font-medium text-amber-300"><AlertTriangle className="h-3.5 w-3.5" />Hermes 尚未配置完整</div>
            <p className="mt-1.5 leading-relaxed">需要 Gateway 地址、API Server Key 和模型名称后才能开始对话。</p>
            <button type="button" onClick={() => { window.location.href = '/settings?tab=ai' }} className="mt-2 inline-flex items-center gap-1.5 rounded-btn border border-border bg-elevated px-2.5 py-1.5 text-[11px] text-secondary hover:text-foreground">
              <Settings2 className="h-3 w-3" />去配置 Hermes
            </button>
          </div>
        )}

        {canChat && !conversation && (
          <div className="flex min-h-[270px] flex-col items-center justify-center gap-3 px-3 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-sky-400/25 bg-sky-500/10 text-sky-300">
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="text-xs font-medium text-foreground">围绕 {activeSnapshot?.name || symbol} 开始对话</div>
            <p className="max-w-[300px] text-[10px] leading-relaxed text-muted">首轮会固定当前图表快照，后续问题都在同一份指标与结构上下文中回答。</p>
            <button type="button" onClick={() => { void send(stockChatOverviewPrompt()) }} className="inline-flex items-center gap-1.5 rounded-btn border border-sky-400/30 bg-sky-500/15 px-3 py-1.5 text-[11px] font-medium text-sky-300 transition-colors hover:bg-sky-500/25">
              <Sparkles className="h-3.5 w-3.5" />生成当前概览
            </button>
            <div className="flex max-w-[340px] flex-wrap justify-center gap-1.5">
              {SUGGESTIONS.map(suggestion => (
                <button key={suggestion} type="button" onClick={() => { void send(suggestion) }} className="rounded-full border border-border/70 bg-base/50 px-2 py-1 text-[10px] text-muted transition-colors hover:border-sky-400/30 hover:text-secondary">
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {conversation?.messages.map(message => (
          <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[92%] rounded-xl px-3 py-2 text-xs leading-relaxed ${message.role === 'user'
              ? 'bg-sky-500/15 text-foreground ring-1 ring-sky-400/20'
              : 'bg-elevated/65 text-secondary ring-1 ring-border/60'}`}>
              {message.role === 'assistant' ? (
                message.content ? <MarkdownRenderer content={message.content} /> : working ? <span className="inline-flex items-center gap-1.5 text-muted"><Loader2 className="h-3 w-3 animate-spin" />Hermes 正在思考…</span> : <span className="text-muted">暂无正文</span>
              ) : <span className="whitespace-pre-wrap">{message.content}</span>}
              {message.incomplete && <div className="mt-1 text-[10px] text-muted">本轮未完成</div>}
            </div>
          </div>
        ))}

        {conversation?.historyTruncated && (
          <div className="text-center text-[10px] text-muted">为适配 Hermes 上下文窗口，较早消息未发送给模型，但仍保留在本地会话中。</div>
        )}
        {conversation?.error && (
          <div className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger/[0.06] px-3 py-2 text-[11px] text-secondary">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
            <span className="min-w-0 flex-1">{conversation.error}</span>
            {canRetry && <button type="button" onClick={() => { void handleRetry() }} className="inline-flex shrink-0 items-center gap-1 text-sky-300 hover:text-sky-200"><RefreshCw className="h-3 w-3" />重新生成</button>}
          </div>
        )}
        {submitError && <div className="text-center text-[10px] text-danger">{submitError}</div>}
      </div>

      <div className="sticky bottom-0 z-10 shrink-0 border-t border-border/70 bg-surface/95 p-2.5 backdrop-blur-sm">
        {!activeSnapshot && <div className="mb-1.5 text-[10px] text-muted">当前周期分析尚未就绪，完成加载后即可对话。</div>}
        <div className="flex items-end gap-2 rounded-lg border border-border/70 bg-base/60 px-2 py-1.5 focus-within:border-sky-400/40">
          <textarea
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void send()
              }
            }}
            rows={2}
            disabled={!canChat || working}
            placeholder={working ? 'Hermes 正在生成…' : '输入关于当前标的的问题，Enter 发送'}
            className="min-h-[38px] flex-1 resize-none bg-transparent px-1 py-0.5 text-xs text-foreground outline-none placeholder:text-muted/45 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => { void send() }}
            disabled={!canChat || working || !draft.trim()}
            className="mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-sky-500/20 text-sky-300 transition-colors hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-35"
            title="发送"
            aria-label="发送"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </section>
  )
}
