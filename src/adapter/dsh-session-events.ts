import type { RuntimeEvent } from './contract.js'

/** Supported DSH Session read surfaces; the live Session is never wrapped. */
export interface DshSessionEventSource {
  readonly seq?: number
  readonly snapshotEvents?: (fromSeq?: number, toSeqExclusive?: number) => readonly RuntimeEvent[]
  readonly events?: readonly RuntimeEvent[]
}

export const DSH_RECONCILE_EVENT_LIMIT = 10_000

export interface BoundedDshEvents {
  readonly events: readonly RuntimeEvent[]
  readonly complete: boolean
  readonly reason: 'READABLE' | 'UNREADABLE' | 'EVENT_LIMIT'
}

function validEvents(events: unknown): events is readonly RuntimeEvent[] {
  if (!Array.isArray(events)) return false
  // for-of visits sparse slots as undefined; Array.every would skip them and
  // incorrectly admit a non-contiguous projection as readable evidence.
  for (const event of events) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)
      || typeof event.type !== 'string' || event.type.length === 0
      || (event.data !== undefined && (event.data === null || typeof event.data !== 'object' || Array.isArray(event.data)))) return false
  }
  return true
}

/** Bounded read projection only; even a missing ID in a complete read is UNKNOWN. */
export function readBoundedDshSessionEvents(session: unknown, limit = DSH_RECONCILE_EVENT_LIMIT): BoundedDshEvents {
  if (session === null || typeof session !== 'object') return { events: [], complete: false, reason: 'UNREADABLE' }
  try {
    const source = session as DshSessionEventSource
    let events: unknown
    let complete: boolean
    if ('snapshotEvents' in source) {
      if (typeof source.snapshotEvents !== 'function') return { events: [], complete: false, reason: 'UNREADABLE' }
      const count = source.seq
      events = source.snapshotEvents(0, limit)
      complete = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
        ? count <= limit && Array.isArray(events) && events.length === count
        : Array.isArray(events) && events.length < limit
    } else {
      events = source.events
      complete = Array.isArray(events) && events.length <= limit
    }
    if (!Array.isArray(events)) return { events: [], complete: false, reason: 'UNREADABLE' }
    const prefix = events.length > limit ? events.slice(0, limit) : events
    // Legacy arrays or a nonconforming snapshot implementation must not make
    // validation itself traverse more than the observation budget.
    if (!validEvents(prefix)) return { events: [], complete: false, reason: 'UNREADABLE' }
    if (events.length > limit || !complete) return { events: prefix, complete: false, reason: 'EVENT_LIMIT' }
    return { events: prefix, complete: true, reason: 'READABLE' }
  } catch {
    return { events: [], complete: false, reason: 'UNREADABLE' }
  }
}

/**
 * Read the current snapshot on every call. Only absence of the modern API
 * permits legacy access; a broken advertised API must not hide behind stale
 * legacy evidence. null means unreadable, whereas [] is a proven empty log.
 */
export function readDshSessionEvents(session: unknown): readonly RuntimeEvent[] | null {
  if (session === null || typeof session !== 'object') return null
  try {
    const source = session as DshSessionEventSource
    let events: unknown
    if ('snapshotEvents' in source) {
      const read = source.snapshotEvents
      if (typeof read !== 'function') return null
      events = read.call(source)
    } else {
      events = source.events
    }
    if (!validEvents(events)) return null
    return events as readonly RuntimeEvent[]
  } catch {
    return null
  }
}

/** Only explicit message IDs establish correlation, never text substrings. */
export function locateDshDispatchRef(events: readonly RuntimeEvent[], ref: string): number {
  if (!ref.trim()) return -1
  return events.findIndex(event => {
    const nested = event.data?.message as { id?: unknown } | undefined
    if (event.type === 'user/message') return (event.data?.id ?? nested?.id) === ref
    return event.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted)
      && event.data.inserted.some(item => item !== null && typeof item === 'object' && (item as { id?: unknown }).id === ref)
  })
}

/** Read only this dispatch's response; absent output never borrows a prior Claim. */
export function readDshDispatchSummary(session: unknown, dispatchRef: string): string | null {
  const events = readDshSessionEvents(session)
  if (events === null) return null
  const start = locateDshDispatchRef(events, dispatchRef)
  if (start < 0) return null
  let turn: number | null = null
  let summary: string | null = null
  for (let i = start + 1; i < events.length; i++) {
    const event = events[i]
    if (event.type === 'user/message') {
      const id = event.data?.id ?? (event.data?.message as { id?: unknown } | undefined)?.id
      if (id !== dispatchRef) break
    }
    if (event.type === 'turn/start') {
      if (turn !== null) break
      if (typeof event.data?.turn !== 'number') return null
      turn = event.data.turn
    }
    if (event.type !== 'assistant/message' || turn === null) continue
    if (event.data?.turn !== undefined && event.data.turn !== turn) return null
    const data = event.data as { message?: { content?: unknown[]; text?: unknown }; text?: unknown } | undefined
    const parts = Array.isArray(data?.message?.content) ? data.message.content : []
    const texts = parts.flatMap(part => part !== null && typeof part === 'object'
      && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string'
      ? [(part as { text: string }).text] : [])
    const text = texts.length ? texts.join('\n') : data?.message?.text ?? data?.text
    if (typeof text === 'string' && text.trim()) summary = text
  }
  return summary
}
