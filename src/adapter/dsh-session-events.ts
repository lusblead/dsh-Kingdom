import type { RuntimeEvent } from './contract.js'

/** Supported DSH Session read surfaces; the live Session is never wrapped. */
export interface DshSessionEventSource {
  readonly snapshotEvents?: () => readonly RuntimeEvent[]
  readonly events?: readonly RuntimeEvent[]
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
    if (!Array.isArray(events)) return null
    for (const event of events) {
      if (event === null || typeof event !== 'object' || Array.isArray(event)
        || typeof event.type !== 'string' || event.type.length === 0
        || (event.data !== undefined && (event.data === null || typeof event.data !== 'object' || Array.isArray(event.data)))) return null
    }
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
