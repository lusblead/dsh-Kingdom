import type { RuntimeEvent } from './contract.js'
import { readDshSessionEvents } from './dsh-session-events.js'

export interface DshUsageCounts {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  /** Already part of outputTokens; never add it to the total. */
  readonly reasoningTokens?: number
  readonly routes?: readonly { provider: string; model: string }[]
}

/** Neutral observation only; its caller supplies the canonical Kingdom relation. */
export interface DshDispatchUsageObservation {
  readonly type: 'DshDispatchUsage/v1'
  readonly source: 'provider-reported'
  readonly runtimeDispatchRef: string
  readonly status: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE'
  readonly reasonCode: string | null
  readonly turn: number | null
  readonly fromSeq: number | null
  readonly throughSeq: number | null
  readonly observedRequests: number
  readonly reportedRequests: number
  /** Present only if the complete turn and every billed attempt are provable. */
  readonly usage: DshUsageCounts | null
}

export type DshTurnUsageDeriver = (events: readonly RuntimeEvent[]) => unknown

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const messageId = (event: RuntimeEvent): unknown => event.data?.id ?? (record(event.data?.message) ? event.data.message.id : undefined)

export function normalizeDshUsageCounts(value: unknown): DshUsageCounts | null {
  if (!record(value) || !count(value.uncachedInputTokens) || !count(value.outputTokens) || !count(value.totalTokens)) return null
  const result: { uncachedInputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; routes?: { provider: string; model: string }[] } = {
    uncachedInputTokens: value.uncachedInputTokens, outputTokens: value.outputTokens, totalTokens: value.totalTokens,
  }
  for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
    if (value[key] !== undefined) {
      if (!count(value[key])) return null
      result[key] = value[key]
    }
  }
  const knownPrompt = result.uncachedInputTokens + (result.cacheReadTokens ?? 0) + (result.cacheWriteTokens ?? 0)
  const exactPrompt = result.totalTokens - result.outputTokens
  if (!count(knownPrompt) || !count(exactPrompt) || exactPrompt < knownPrompt
    || (result.reasoningTokens !== undefined && result.reasoningTokens > result.outputTokens)
    || (result.cacheReadTokens !== undefined && result.cacheWriteTokens !== undefined && exactPrompt !== knownPrompt)) return null
  if (value.routes !== undefined) {
    if (!Array.isArray(value.routes) || value.routes.length > 128) return null
    const routes: { provider: string; model: string }[] = []
    for (const route of value.routes) {
      if (!record(route) || typeof route.provider !== 'string' || typeof route.model !== 'string'
        || !route.provider.trim() || !route.model.trim() || route.provider.length > 256 || route.model.length > 256) return null
      routes.push({ provider: route.provider, model: route.model })
    }
    result.routes = routes
  }
  return result
}

function hasUsage(event: RuntimeEvent): boolean {
  let sample = event.data?.usage
  if (sample === undefined && Array.isArray(event.data?.stream)) {
    for (const item of event.data.stream) {
      if (record(item) && item.type === 'chunk' && record(item.chunk) && item.chunk.type === 'usage') sample = item.chunk.usage
    }
  }
  return record(sample) && count(sample.inputTokens) && count(sample.outputTokens)
}

/** Pure extraction from an already acquired snapshot; no persistence or model calls. */
export function extractDshDispatchUsage(
  events: readonly RuntimeEvent[] | null,
  runtimeDispatchRef: string,
  deriveTurnUsage: DshTurnUsageDeriver | null,
): DshDispatchUsageObservation {
  const base = { type: 'DshDispatchUsage/v1' as const, source: 'provider-reported' as const, runtimeDispatchRef,
    turn: null as number | null, fromSeq: null as number | null, throughSeq: null as number | null,
    observedRequests: 0, reportedRequests: 0, usage: null as DshUsageCounts | null }
  const unavailable = (reasonCode: string): DshDispatchUsageObservation => ({ ...base, status: 'UNAVAILABLE', reasonCode })
  if (events === null) return unavailable('EVENTS_UNREADABLE')
  if (!runtimeDispatchRef.trim() || runtimeDispatchRef.length > 256) return unavailable('DISPATCH_REF_INVALID')
  const users = events.map((event, index) => event.type === 'user/message' && messageId(event) === runtimeDispatchRef ? index : -1).filter(index => index >= 0)
  if (users.length !== 1) return unavailable(users.length === 0 ? 'DISPATCH_NOT_ADMITTED' : 'DISPATCH_AMBIGUOUS')
  const userIndex = users[0]
  const receipts = events.map((event, index) => event.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted)
    && event.data.inserted.some(item => record(item) && item.id === runtimeDispatchRef) ? index : -1).filter(index => index >= 0)
  if (receipts.length > 1 || (receipts.length === 1 && receipts[0] > userIndex)) return unavailable('DISPATCH_AMBIGUOUS')
  const receiptIndex = receipts[0] ?? userIndex
  let start = -1
  // Modern DSH opens the turn before admitting its user/message. Legacy
  // events-only sessions may admit the user before turn/start.
  for (let i = userIndex - 1; i >= (receipts.length ? receiptIndex : 0); i--) {
    if (events[i].type === 'turn/end') break
    if (events[i].type === 'turn/start') { start = i; break }
  }
  if (start < 0) start = events.findIndex((event, index) => index > userIndex && event.type === 'turn/start')
  if (start < 0 || !count(events[start].data?.turn)) return unavailable('TURN_NOT_OBSERVED')
  const turn = events[start].data!.turn as number
  base.turn = turn
  base.fromSeq = count(events[start].seq) ? events[start].seq as number : null
  let end = -1
  for (let i = start + 1; i < events.length; i++) {
    if (events[i].type === 'turn/start') return unavailable('TURN_BOUNDARY_AMBIGUOUS')
    if (events[i].type === 'turn/end') {
      if (events[i].data?.turn !== turn) return unavailable('TURN_BOUNDARY_AMBIGUOUS')
      end = i
      break
    }
  }
  if (end >= 0 && userIndex > end) return unavailable('DISPATCH_OUTSIDE_TURN')
  const through = end >= 0 ? end : events.length - 1
  base.throughSeq = count(events[through]?.seq) ? events[through].seq as number : null
  for (let i = Math.min(receiptIndex, start); i <= through; i++) {
    if (events[i].type === 'user/message' && messageId(events[i]) !== runtimeDispatchRef) return unavailable('FOREIGN_INPUT')
  }
  const local = events.slice(start, through + 1)
  if (local.some(event => event.seq !== undefined)) {
    for (let i = 0; i < local.length; i++) {
      if (!count(local[i].seq) || (i > 0 && local[i].seq !== (local[i - 1].seq as number) + 1)) return unavailable('EVENT_SEQUENCE_INVALID')
    }
  }
  let slot = -1
  const reported = new Set<number>()
  for (const event of local) {
    if (event.type === 'step/start' || event.type === 'llm/retry-started') {
      if (event.data?.turn !== turn || !count(event.data?.step)) return unavailable('REQUEST_BOUNDARY_AMBIGUOUS')
      slot++
      base.observedRequests++
    }
    if ((event.type === 'assistant/message' || event.type === 'assistant/attempt') && hasUsage(event) && slot >= 0) reported.add(slot)
  }
  base.reportedRequests = reported.size
  if (deriveTurnUsage === null) return { ...base, status: 'UNAVAILABLE', reasonCode: 'USAGE_READER_UNAVAILABLE' }
  if (end < 0) return { ...base, status: reported.size ? 'PARTIAL' : 'UNAVAILABLE', reasonCode: 'TURN_IN_PROGRESS' }
  let usage: DshUsageCounts | null
  try { usage = normalizeDshUsageCounts(deriveTurnUsage(local)) } catch { return { ...base, status: 'UNAVAILABLE', reasonCode: 'USAGE_READER_FAILED' } }
  if (usage === null || base.observedRequests === 0) return { ...base, status: reported.size ? 'PARTIAL' : 'UNAVAILABLE', reasonCode: 'USAGE_INCOMPLETE' }
  return { ...base, status: 'COMPLETE', reasonCode: null, usage }
}

let publicUsageReader: Promise<DshTurnUsageDeriver | null> | undefined
/** Optional public package export; never deep-import private runtime files. */
export function loadDshUsageReader(): Promise<DshTurnUsageDeriver | null> {
  publicUsageReader ??= (async () => {
    try {
      const publicEntry = '@deepseek-ai/dsh-token-meter/client'
      const module: unknown = await import(publicEntry)
      return record(module) && typeof module.deriveTurnTokenUsage === 'function'
        ? module.deriveTurnTokenUsage as DshTurnUsageDeriver : null
    } catch { return null }
  })()
  return publicUsageReader
}

export async function observeDshDispatchUsage(session: unknown, runtimeDispatchRef: string): Promise<DshDispatchUsageObservation> {
  const reader = await loadDshUsageReader()
  return extractDshDispatchUsage(readDshSessionEvents(session), runtimeDispatchRef, reader)
}
