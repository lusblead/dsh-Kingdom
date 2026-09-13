import type { RuntimeEvent } from './contract.js'
import { loadDshUsageReader, normalizeDshUsageCounts, type DshUsageCounts, type DshTurnUsageDeriver } from './dsh-usage.js'
import { readDshSessionEvents } from './dsh-session-events.js'

export interface DshTurnCostObservation {
  status: 'IN_PROGRESS' | 'COMPLETE' | 'UNAVAILABLE'
  reasonCode: string | null
  observationSequence: number
  observedRequests: number
  reportedRequests: number
  usage: DshUsageCounts | null
}
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** An exact turn start is captured by the host observer, not inferred from a tool argument. */
export function extractDshTurnCost(events: readonly RuntimeEvent[] | null, fromSeq: number, derive: DshTurnUsageDeriver | null): DshTurnCostObservation {
  const base = { observationSequence: fromSeq, observedRequests: 0, reportedRequests: 0, usage: null as DshUsageCounts | null }
  const unavailable = (reasonCode: string): DshTurnCostObservation => ({ ...base, status: 'UNAVAILABLE', reasonCode })
  if (!events || !count(fromSeq)) return unavailable('EVENTS_UNREADABLE')
  const start = events.findIndex(event => event.seq === fromSeq && event.type === 'turn/start')
  if (start < 0 || events.filter(event => event.seq === fromSeq).length !== 1) return unavailable('TURN_START_NOT_FOUND')
  const turn = events[start]!.data?.turn
  if (!count(turn)) return unavailable('TURN_BOUNDARY_INVALID')
  let end = events.length, ended = false, slot = -1
  const reported = new Set<number>()
  for (let i = start; i < events.length; i++) {
    const event = events[i]!
    if (!count(event.seq) || event.seq !== fromSeq + i - start) return unavailable('EVENT_SEQUENCE_INVALID')
    base.observationSequence = event.seq
    if (i > start && event.type === 'turn/start') return unavailable('TURN_BOUNDARY_INVALID')
    if (event.type === 'step/start' || event.type === 'llm/retry-started') {
      if (event.data?.turn !== turn || !count(event.data.step)) return unavailable('REQUEST_BOUNDARY_INVALID')
      slot++; base.observedRequests++
    }
    if ((event.type === 'assistant/message' || event.type === 'assistant/attempt') && slot >= 0) {
      let sample = event.data?.usage
      if (sample === undefined && Array.isArray(event.data?.stream)) for (const item of event.data.stream) {
        if (object(item) && item.type === 'chunk' && object(item.chunk) && item.chunk.type === 'usage') sample = item.chunk.usage
      }
      if (object(sample) && count(sample.inputTokens) && count(sample.outputTokens)) reported.add(slot)
    }
    if (event.type === 'turn/end') {
      if (event.data?.turn !== turn) return unavailable('TURN_BOUNDARY_INVALID')
      end = i + 1; ended = true; break
    }
  }
  base.reportedRequests = reported.size
  if (!ended) return { ...base, status: 'IN_PROGRESS', reasonCode: 'TURN_IN_PROGRESS' }
  if (!derive) return unavailable('USAGE_READER_UNAVAILABLE')
  if (reported.size !== base.observedRequests) return unavailable('REQUEST_USAGE_MISSING')
  try {
    const usage = normalizeDshUsageCounts(derive(events.slice(start, end)))
    return usage ? { ...base, usage, status: 'COMPLETE', reasonCode: null } : unavailable('USAGE_INCOMPLETE')
  } catch { return unavailable('USAGE_READER_FAILED') }
}

export async function observeDshTurnCost(session: unknown, fromSeq: number): Promise<DshTurnCostObservation> {
  return extractDshTurnCost(readDshSessionEvents(session), fromSeq, await loadDshUsageReader())
}
