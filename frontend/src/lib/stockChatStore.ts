import { useSyncExternalStore } from 'react'
import { api, type StockChatMessage as ApiStockChatMessage, type StockChatSnapshotV1 } from './api'
import { trimStockChatMessages } from './stockChatPrimitives'

export type StockChatPhase = 'idle' | 'loading' | 'streaming' | 'done' | 'error' | 'stopped' | 'interrupted'

export interface StockChatMessage extends ApiStockChatMessage {
  id: string
  incomplete?: boolean
}

export interface StockChatConversation {
  symbol: string
  snapshot: StockChatSnapshotV1
  messages: StockChatMessage[]
  phase: StockChatPhase
  error: string
  historyTruncated: boolean
  updatedAt: number
}

const STORAGE_KEY = 'tf-stock-chat-v1'
const STORAGE_VERSION = 1
const MAX_CONVERSATIONS = 10
const MAX_MESSAGES = 40
const MAX_ACTIVE_STREAMS = 3
const MAX_MESSAGE_CHARS = 16_000
const OVERVIEW_PROMPT = '请基于当前图表快照，概括指标状态、结构状态、关键风险和后续验证条件。'

let conversations = new Map<string, StockChatConversation>()
let conversationsSnapshot: Readonly<Record<string, StockChatConversation>> = {}
let hydrated = false
let lastUpdatedAt = 0
const listeners = new Set<() => void>()
const activeStreams = new Map<string, AbortController>()
const EMPTY_CONVERSATIONS: Readonly<Record<string, StockChatConversation>> = {}

const VALID_PHASES = new Set<StockChatPhase>([
  'idle', 'loading', 'streaming', 'done', 'error', 'stopped', 'interrupted',
])

function emit() { listeners.forEach(listener => listener()) }
function subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) }

function rebuildSnapshot() {
  const next: Record<string, StockChatConversation> = {}
  for (const [symbol, conversation] of conversations) next[symbol] = conversation
  conversationsSnapshot = next
}

function safeSessionStorage(): Storage | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage } catch { return null }
}

function persist() {
  const storage = safeSessionStorage()
  if (!storage) return
  try {
    const items = [...conversations.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CONVERSATIONS)
      .map(conversation => ({
        symbol: conversation.symbol,
        snapshot: conversation.snapshot,
        messages: conversation.messages.slice(-MAX_MESSAGES),
        phase: conversation.phase,
        error: conversation.error,
        historyTruncated: conversation.historyTruncated,
        updatedAt: conversation.updatedAt,
      }))
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, conversations: items }))
  } catch { /* quota/private browsing: the in-memory conversation still works */ }
}

function nextUpdatedAt(): number {
  lastUpdatedAt = Math.max(Date.now(), lastUpdatedAt + 1)
  return lastUpdatedAt
}

function restoredUpdatedAt(value: unknown): number {
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > 0) {
    lastUpdatedAt = Math.max(lastUpdatedAt, parsed)
    return parsed
  }
  return nextUpdatedAt()
}

function isSnapshot(value: unknown, symbol: string): value is StockChatSnapshotV1 {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<StockChatSnapshotV1>
  return snapshot.version === 1
    && snapshot.symbol === symbol
    && typeof snapshot.period === 'string'
    && ['30m', '1d', '1w', '1mo'].includes(snapshot.period)
    && Array.isArray(snapshot.bars)
    && !!snapshot.structure
    && typeof snapshot.structure === 'object'
    && Array.isArray(snapshot.price_zones)
    && Array.isArray(snapshot.signal_risk)
}

function hydrate() {
  if (hydrated) return
  hydrated = true
  const storage = safeSessionStorage()
  if (!storage) return
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? '') as {
      version?: number
      conversations?: Array<Partial<StockChatConversation> & { symbol?: string }>
    }
    if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.conversations)) return
    for (const raw of parsed.conversations) {
      if (!raw.symbol || !isSnapshot(raw.snapshot, raw.symbol) || !Array.isArray(raw.messages)) continue
      const messages = raw.messages
        .filter(item => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
        .map(item => ({ ...item, id: item.id || makeId('restored') })) as StockChatMessage[]
      if (messages.some((item, index) => index === 0
        ? item.role !== 'user'
        : item.role === messages[index - 1]?.role)) continue
      const interrupted = raw.phase === 'loading' || raw.phase === 'streaming'
      const phase = VALID_PHASES.has(raw.phase as StockChatPhase) ? raw.phase as StockChatPhase : 'idle'
      const visibleMessages = trimVisibleMessages(messages)
      conversations.set(raw.symbol, {
        symbol: raw.symbol,
        snapshot: raw.snapshot,
        messages: interrupted
          ? visibleMessages.map(item => item.role === 'assistant' && item === visibleMessages.at(-1) ? { ...item, incomplete: true } : item)
          : visibleMessages,
        phase: interrupted ? 'interrupted' : phase,
        error: interrupted ? '页面刷新导致上一轮生成中断, 可重试最后一个问题。' : String(raw.error ?? ''),
        historyTruncated: raw.historyTruncated === true,
        updatedAt: restoredUpdatedAt(raw.updatedAt),
      })
    }
    const newest = [...conversations.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CONVERSATIONS)
    conversations = new Map(newest.map(item => [item.symbol, item]))
    rebuildSnapshot()
    persist()
  } catch { /* malformed or stale session data is ignored */ }
}

hydrate()

function updateConversation(symbol: string, updater: (current: StockChatConversation) => StockChatConversation): StockChatConversation | null {
  const current = conversations.get(symbol)
  if (!current) return null
  const next = updater(current)
  conversations.set(symbol, { ...next, updatedAt: nextUpdatedAt() })
  rebuildSnapshot()
  persist()
  emit()
  return next
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function trimVisibleMessages(messages: StockChatMessage[]): StockChatMessage[] {
  return trimStockChatMessages(messages, MAX_MESSAGES)
}

function createConversation(symbol: string, snapshot: StockChatSnapshotV1): StockChatConversation {
  const conversation: StockChatConversation = {
    symbol,
    snapshot,
    messages: [],
    phase: 'idle',
    error: '',
    historyTruncated: false,
    updatedAt: nextUpdatedAt(),
  }
  conversations.set(symbol, conversation)
  // Keep the newest conversations only; never evict the one just created.
  const symbols = [...conversations.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CONVERSATIONS)
    .map(item => item.symbol)
  for (const key of conversations.keys()) if (!symbols.includes(key)) conversations.delete(key)
  rebuildSnapshot()
  persist()
  emit()
  return conversation
}

function getConversation(symbol: string): StockChatConversation | null {
  hydrate()
  return conversations.get(symbol) ?? null
}

export function useStockChat(symbol: string): StockChatConversation | null {
  const all = useSyncExternalStore(subscribe, () => conversationsSnapshot, () => EMPTY_CONVERSATIONS)
  return all[symbol] ?? null
}

export function stockChatOverviewPrompt(): string { return OVERVIEW_PROMPT }

function latestUserAndAssistant(messages: StockChatMessage[]): { user: StockChatMessage | null; assistant: StockChatMessage | null } {
  const assistant = messages.at(-1)?.role === 'assistant' ? messages.at(-1)! : null
  const userIndex = assistant ? messages.length - 2 : messages.length - 1
  const user = userIndex >= 0 && messages[userIndex]?.role === 'user' ? messages[userIndex] : null
  return { user, assistant }
}

export async function sendStockChat(
  symbol: string,
  snapshot: StockChatSnapshotV1 | null,
  text: string,
): Promise<{ error?: string }> {
  const prompt = text.trim()
  if (!prompt) return { error: '请输入问题' }
  if (prompt.length > MAX_MESSAGE_CHARS) return { error: `问题不能超过 ${MAX_MESSAGE_CHARS} 个字符` }
  if (activeStreams.has(symbol)) return { error: '当前问题仍在生成中, 请等待或先停止生成' }
  if (activeStreams.size >= MAX_ACTIVE_STREAMS) return { error: `同时进行的 Hermes 对话不能超过 ${MAX_ACTIVE_STREAMS} 个, 请等待现有对话完成` }

  let conversation = getConversation(symbol)
  if (!conversation) {
    if (!snapshot) return { error: '当前图表数据尚未就绪, 请稍候再试' }
    conversation = createConversation(symbol, snapshot)
  }
  const user: StockChatMessage = { id: makeId('user'), role: 'user', content: prompt }
  const assistant: StockChatMessage = { id: makeId('assistant'), role: 'assistant', content: '' }
  const messages = trimVisibleMessages([...conversation.messages, user, assistant])
  updateConversation(symbol, current => ({
    ...current,
    messages,
    phase: 'loading',
    error: '',
  }))
  void runStream(symbol)
  return {}
}

async function runStream(symbol: string): Promise<void> {
  const conversation = getConversation(symbol)
  if (!conversation || activeStreams.has(symbol)) return
  const controller = new AbortController()
  activeStreams.set(symbol, controller)
  const providerMessages: ApiStockChatMessage[] = conversation.messages
    .slice(0, -1) // the last item is the empty/partial assistant placeholder
    .map(({ role, content }) => ({ role, content }))
  const assistantId = conversation.messages.at(-1)?.role === 'assistant' ? conversation.messages.at(-1)!.id : null
  if (!assistantId) {
    activeStreams.delete(symbol)
    return
  }

  try {
    for await (const event of api.stockChatStream(symbol, conversation.snapshot, providerMessages, controller.signal)) {
      const current = getConversation(symbol)
      if (!current) return
      if (event.type === 'meta') {
        updateConversation(symbol, value => ({ ...value, historyTruncated: event.history_truncated === true }))
      } else if (event.type === 'delta') {
        updateConversation(symbol, value => ({
          ...value,
          phase: 'streaming',
          messages: value.messages.map(message => message.id === assistantId
            ? { ...message, content: message.content + event.content, incomplete: false }
            : message),
        }))
      } else if (event.type === 'error') {
        updateConversation(symbol, value => ({
          ...value,
          phase: 'error',
          error: event.message,
          messages: value.messages.map(message => message.id === assistantId
            ? { ...message, incomplete: true }
            : message),
        }))
        return
      } else if (event.type === 'done') {
        updateConversation(symbol, value => ({
          ...value,
          phase: 'done',
          error: '',
          messages: value.messages.map(message => message.id === assistantId
            ? { ...message, incomplete: false }
            : message),
        }))
        return
      }
      // Heartbeats deliberately do not mutate messages or trigger renders.
    }
    const final = getConversation(symbol)
    if (final && final.phase !== 'error' && final.phase !== 'done') {
      updateConversation(symbol, value => ({
        ...value,
        phase: 'error',
        error: 'Hermes 流提前结束, 请重试。',
        messages: value.messages.map(message => message.id === assistantId
          ? { ...message, incomplete: true }
          : message),
      }))
    }
  } catch (error) {
    if (controller.signal.aborted) {
      updateConversation(symbol, value => ({
        ...value,
        phase: 'stopped',
        error: '已停止生成。',
        messages: value.messages.map(message => message.id === assistantId
          ? { ...message, incomplete: true }
          : message),
      }))
    } else {
      updateConversation(symbol, value => ({
        ...value,
        phase: 'error',
        error: error instanceof Error ? error.message : 'AI 对话失败, 请稍后重试。',
        messages: value.messages.map(message => message.id === assistantId
          ? { ...message, incomplete: true }
          : message),
      }))
    }
  } finally {
    activeStreams.delete(symbol)
    emit()
  }
}

export function stopStockChat(symbol: string): void {
  activeStreams.get(symbol)?.abort()
}

export async function retryStockChat(symbol: string): Promise<{ error?: string }> {
  if (activeStreams.has(symbol)) return { error: '当前问题仍在生成中, 请先停止生成' }
  const conversation = getConversation(symbol)
  if (!conversation) return { error: '没有可重试的对话' }
  const { user, assistant } = latestUserAndAssistant(conversation.messages)
  if (!user) return { error: '没有可重试的问题' }
  const baseMessages = assistant ? conversation.messages.slice(0, -1) : conversation.messages
  while (baseMessages.at(-1)?.role === 'assistant' && baseMessages.at(-1)?.incomplete) baseMessages.pop()
  const next: StockChatConversation = {
    ...conversation,
    messages: trimVisibleMessages([...baseMessages, { id: makeId('assistant'), role: 'assistant', content: '' }]),
    phase: 'loading',
    error: '',
    updatedAt: nextUpdatedAt(),
  }
  conversations.set(symbol, next)
  rebuildSnapshot()
  persist()
  emit()
  void runStream(symbol)
  return {}
}

export function newStockChat(symbol: string): { ok: boolean; error?: string } {
  if (activeStreams.has(symbol)) return { ok: false, error: '请先停止当前生成, 再新建对话' }
  conversations.delete(symbol)
  rebuildSnapshot()
  persist()
  emit()
  return { ok: true }
}
