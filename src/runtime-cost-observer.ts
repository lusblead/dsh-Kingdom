import type { KingdomStore, RoleBindingRow } from './core/db.js'
import { recordRoleUsage, recordPromptCost, recordUsageCoverageGap, closeInterruptedRoleObservations, type RoleUsageObservation, type PromptCostObservation } from './core/cost.js'
import type { RuntimeEvent } from './adapter/contract.js'
import { observeDshTurnCost } from './adapter/dsh-cost.js'

type HostAgent = { id: string; session: { id?: string }; ctx?: unknown }
type Assembly = { tools: unknown[]; sections: { name: string; text: string }[]; contexts: { name: string; text: string }[]; variables?: Record<string, unknown> }
export interface RuntimeCostHost {
  on?(event: string, callback: (...args: any[]) => any): () => void
  get(name: string): unknown
}
export interface DisclosureCostMeta { toolsBefore: number; toolsAfter: number; toolsBytesBefore: number; toolsBytesAfter: number; mode: 'off' | 'pilot'; reasonCode: string | null }
type CapturedTurn = { binding: RoleBindingRow; kingdomId: string; session: unknown; fromSeq: number; initial: RoleUsageObservation; latest: RoleUsageObservation; latestSeq: number; ended: boolean }

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const bytes = (value: unknown): number => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')

/** Integration observer: Runtime evidence is neutral; all role attribution comes from Core bindings. */
export function installRuntimeCostObservers(host: RuntimeCostHost, store: KingdomStore, input: {
  runtimeInstanceRef: string
  mode: 'off' | 'pilot'
  disclosureMeta?: (assembly: object) => DisclosureCostMeta | undefined
}): { available: boolean; dispose(): void } {
  const existingKingdom = store.getDefaultKingdom()
  if (existingKingdom) closeInterruptedRoleObservations(store, existingKingdom.kingdom_id, input.runtimeInstanceRef)
  if (typeof host.on !== 'function') return { available: false, dispose() {} }
  let disposed = false, assemblyCounter = 0
  const ambiguous = new Map<unknown, { kingdomId: string; sessionRef: string }>()
  const turns = new Map<object, CapturedTurn>(), pending = new Set<CapturedTurn>(), disposers: (() => void)[] = []
  const agents = (): HostAgent[] => {
    const registry = host.get('agents') as { list?(): HostAgent[] } | undefined
    return typeof registry?.list === 'function' ? registry.list() : []
  }
  const identify = (session: unknown, includeWorker = false): { binding: RoleBindingRow; kingdomId: string; agent: HostAgent } | null => {
    const kingdom = store.getDefaultKingdom()
    if (!kingdom) return null
    const matches = agents().filter(agent => agent.session === session && typeof agent.id === 'string' && agent.session.id === agent.id)
    if (matches.length !== 1) return null
    const agent = matches[0]!
    const roles = store.listBindings(kingdom.kingdom_id).filter(binding => {
      if (binding.status !== 'ACTIVE' || binding.role_type === 'OWNER') return false
      if (binding.role_type !== 'WORKER') return binding.session_id === agent.id
      const affinity = store.getCurrentAffinityForWorker(kingdom.kingdom_id, binding.binding_id)
      return affinity?.session_ref === agent.id && affinity.runtime_type === 'dsh' && affinity.runtime_instance_ref === input.runtimeInstanceRef
    })
    ambiguous.delete(session)
    if (roles.length > 1) ambiguous.set(session, { kingdomId: kingdom.kingdom_id, sessionRef: agent.id })
    return roles.length === 1 && (includeWorker || roles[0]!.role_type !== 'WORKER') ? { binding: roles[0]!, kingdomId: kingdom.kingdom_id, agent } : null
  }
  const collect = async (captured: CapturedTurn, endLedgerSeq: number): Promise<void> => {
    const observed = await observeDshTurnCost(captured.session, captured.fromSeq)
    if (disposed) return
    // Successful canonical actor events provide related task references, but
    // do not prove the whole model turn exclusively worked on that task.
    const taskIds = [...new Set(store.listActorEventsSince(captured.kingdomId, captured.binding.binding_id, captured.initial.startedLedgerSeq)
      .filter(event => event.seq <= endLedgerSeq && event.target_type === 'task' && event.target_id && store.getTask(event.target_id))
      .map(event => event.target_id!))]
    const bounded = taskIds.length <= 32 ? taskIds : []
    const value: RoleUsageObservation = { ...captured.initial, ...observed, taskIds: bounded, attribution: bounded.length ? 'SHARED' : 'UNATTRIBUTED' }
    if (value.observationSequence >= captured.latest.observationSequence) captured.latest = value
    recordRoleUsage(store, captured.kingdomId, value)
    if (captured.ended && observed.status !== 'IN_PROGRESS') {
      if (turns.get(captured.session as object) === captured) turns.delete(captured.session as object)
      pending.delete(captured)
    }
  }
  try {
    disposers.push(host.on('session/event', (session: unknown, event: RuntimeEvent) => {
      if (disposed || !session || typeof session !== 'object') return
      try {
        if (event.type === 'turn/start') {
          const actor = identify(session)
          if (!actor || !count(event.seq)) {
            const conflict = ambiguous.get(session)
            if (conflict && count(event.seq)) recordUsageCoverageGap(store, conflict.kingdomId, `${input.runtimeInstanceRef}:${conflict.sessionRef}:${event.seq}`, 'ROLE_IDENTITY_AMBIGUOUS')
            return
          }
          const initial: RoleUsageObservation = {
            type: 'KingdomRoleUsage/v1', source: 'provider-reported',
            sourceUnitRef: `${input.runtimeInstanceRef}:${actor.agent.id}:${event.seq}`,
            runtimeInstanceRef: input.runtimeInstanceRef, sessionRef: actor.agent.id,
            bindingId: actor.binding.binding_id, roleType: actor.binding.role_type as 'CHANCELLOR' | 'SUPERVISOR',
            taskIds: [], attribution: 'UNATTRIBUTED', startedAt: new Date().toISOString(), startedLedgerSeq: store.eventSequence(),
            observationSequence: event.seq, status: 'IN_PROGRESS', reasonCode: 'TURN_IN_PROGRESS', observedRequests: 0, reportedRequests: 0, usage: null,
          }
          const captured: CapturedTurn = { binding: actor.binding, kingdomId: actor.kingdomId, session, fromSeq: event.seq, initial, latest: initial, latestSeq: event.seq, ended: false }
          turns.set(session, captured); pending.add(captured); recordRoleUsage(store, actor.kingdomId, initial)
        } else if (['step/start', 'llm/retry-started', 'assistant/message', 'assistant/attempt', 'turn/end'].includes(event.type)) {
          const captured = turns.get(session)
          if (!captured) return
          if (count(event.seq)) captured.latestSeq = Math.max(captured.latestSeq, event.seq)
          if (event.type === 'turn/end') captured.ended = true
          const endSeq = store.eventSequence()
          void collect(captured, endSeq).catch(() => { /* Never alter execution because an optional observation failed. */ })
        }
      } catch { /* Registry/schema absence is a coverage gap, never a governance action. */ }
    }))
    disposers.push(host.on('system-prompt/assemble', async (_assembly: Assembly, context: { agent?: HostAgent }, next: () => Promise<Assembly>) => {
      const result = await next()
      if (disposed) return result
      try {
        const actor = identify(context.agent?.session, true)
        if (!actor || !result || !Array.isArray(result.tools) || !Array.isArray(result.sections) || !Array.isArray(result.contexts)) return result
        const parts = (items: { name: string; text: string }[]) => items.slice(0, 128).map(item => ({ name: item.name.replace(/[\r\n]/gu, ' ').slice(0, 160), bytes: bytes(item.text) }))
        const actual = bytes(result.tools)
        const disclosure = input.disclosureMeta?.(result)
        const value: PromptCostObservation = {
          type: 'KingdomPromptCost/v1', source: 'assembly-byte-observation', sourceUnitRef: `${input.runtimeInstanceRef}:${actor.agent.id}:assembly:${++assemblyCounter}`,
          bindingId: actor.binding.binding_id, roleType: actor.binding.role_type,
          toolsBefore: disclosure?.toolsBefore ?? result.tools.length, toolsAfter: disclosure?.toolsAfter ?? result.tools.length,
          toolsBytesBefore: disclosure?.toolsBytesBefore ?? actual, toolsBytesAfter: disclosure?.toolsBytesAfter ?? actual,
          sections: parts(result.sections), contexts: parts(result.contexts), historyBytes: null, tokenEstimate: null,
          mode: disclosure?.mode ?? 'off', reasonCode: disclosure ? disclosure.reasonCode : (input.mode === 'pilot' ? 'PILOT_NOT_ACTIVE_FOR_THIS_SCOPE' : null),
        }
        recordPromptCost(store, actor.kingdomId, value)
      } catch { /* Only byte counts are observed; original prompt content is never stored here. */ }
      return result
    }))
  } catch {
    disposed = true
    for (const dispose of disposers.reverse()) dispose()
    return { available: false, dispose() {} }
  }
  return { available: true, dispose() {
    if (disposed) return
    disposed = true
    for (const captured of pending) recordRoleUsage(store, captured.kingdomId, { ...captured.latest,
      observationSequence: captured.latestSeq, status: 'UNAVAILABLE', reasonCode: 'OBSERVER_CLOSED', usage: null })
    turns.clear(); pending.clear(); ambiguous.clear(); for (const dispose of disposers.reverse()) dispose()
  } }
}
