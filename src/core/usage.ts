import { randomUUID } from 'node:crypto'
import type { KingdomStore } from './db.js'
import type { DshDispatchUsageObservation } from '../adapter/dsh-usage.js'

export interface DispatchUsageView {
  type: 'KingdomDispatchUsage/v1'
  dispatchId: string
  taskId: string
  attemptNo: number
  source: 'provider-reported'
  status: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE'
  reasonCode: string | null
  observedRequests: number
  reportedRequests: number
  turn: number | null
  throughSeq: number | null
  usage: { uncachedInputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number } | null
}

export function readDispatchUsage(store: KingdomStore, dispatchId: string): DispatchUsageView | null {
  const events = store.listDispatchUsageEvents(dispatchId)
  for (let index = events.length - 1; index >= 0; index--) {
    try {
      const value = JSON.parse(events[index]!.payload_json) as DispatchUsageView
      if (value.type === 'KingdomDispatchUsage/v1' && value.dispatchId === dispatchId) return value
    } catch { /* Invalid historical observation is not a zero-cost measurement. */ }
  }
  return null
}

/** Runtime usage is a separate observation, never terminal/cleanup or task governance evidence. */
export function recordDispatchUsage(store: KingdomStore, dispatchId: string, observed: DshDispatchUsageObservation): void {
  const dispatch = store.getDispatch(dispatchId)
  if (!dispatch || !dispatch.runtime_dispatch_ref || dispatch.runtime_dispatch_ref !== observed.runtimeDispatchRef) return
  const usage = observed.status === 'COMPLETE' && observed.usage ? {
    uncachedInputTokens: observed.usage.uncachedInputTokens, outputTokens: observed.usage.outputTokens, totalTokens: observed.usage.totalTokens,
    ...(observed.usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: observed.usage.cacheReadTokens }),
    ...(observed.usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: observed.usage.cacheWriteTokens }),
    ...(observed.usage.reasoningTokens === undefined ? {} : { reasoningTokens: observed.usage.reasoningTokens }),
  } : null
  const view: DispatchUsageView = { type: 'KingdomDispatchUsage/v1', dispatchId, taskId: dispatch.task_id, attemptNo: dispatch.attempt_no,
    source: 'provider-reported', status: observed.status, reasonCode: observed.reasonCode, observedRequests: observed.observedRequests,
    reportedRequests: observed.reportedRequests, turn: observed.turn, throughSeq: observed.throughSeq, usage }
  store.withImmediateTransaction(() => {
    const previous = readDispatchUsage(store, dispatchId)
    if (JSON.stringify(previous) === JSON.stringify(view)) return
    // An unavailable later lookup cannot erase an earlier complete provider report.
    if (previous?.status === 'COMPLETE' && view.status !== 'COMPLETE') return
    store.appendEvent({ event_id: randomUUID(), kingdom_id: dispatch.kingdom_id, event_type: 'DISPATCH_USAGE_OBSERVED', actor_role: 'SYSTEM',
      actor_id: 'kingdom-runtime-observer', target_type: 'dispatch', target_id: dispatchId, payload_json: JSON.stringify(view), created_at: new Date().toISOString() })
  })
}
