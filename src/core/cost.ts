import { randomUUID } from 'node:crypto'
import type { KingdomStore } from './db.js'

/** Provider buckets are disjoint; reasoning is already included in output. */
export interface ProviderTokenCounts {
  uncachedInputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  routes?: readonly { provider: string; model: string }[]
}

/** Neutral source observation. It cannot change role, task, or execution authority. */
export interface RoleUsageObservation {
  type: 'KingdomRoleUsage/v1'
  source: 'provider-reported'
  sourceUnitRef: string
  runtimeInstanceRef: string
  sessionRef: string
  bindingId: string
  roleType: 'CHANCELLOR' | 'SUPERVISOR'
  taskIds: string[]
  attribution: 'TASK' | 'SHARED' | 'UNATTRIBUTED'
  startedAt: string
  startedLedgerSeq: number
  observationSequence: number
  status: 'IN_PROGRESS' | 'COMPLETE' | 'UNAVAILABLE'
  reasonCode: string | null
  observedRequests: number
  reportedRequests: number
  usage: ProviderTokenCounts | null
}

export interface PromptCostObservation {
  type: 'KingdomPromptCost/v1'
  source: 'assembly-byte-observation'
  sourceUnitRef: string
  bindingId: string
  roleType: string
  toolsBefore: number
  toolsAfter: number
  toolsBytesBefore: number
  toolsBytesAfter: number
  sections: { name: string; bytes: number }[]
  contexts: { name: string; bytes: number }[]
  /** Assembly has no final history envelope; never substitute a zero. */
  historyBytes: null
  tokenEstimate: null
  mode: 'off' | 'pilot'
  reasonCode: string | null
}

interface UsageCoverageGap { type: 'KingdomUsageCoverageGap/v1'; sourceUnitRef: string; reasonCode: string }

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const ref = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 768

export function validProviderCounts(usage: ProviderTokenCounts): boolean {
  if (!usage || !count(usage.uncachedInputTokens) || !count(usage.outputTokens) || !count(usage.totalTokens)) return false
  for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) if (usage[key] !== undefined && !count(usage[key])) return false
  const prompt = usage.uncachedInputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  return count(prompt) && usage.totalTokens >= prompt + usage.outputTokens
    && (usage.reasoningTokens === undefined || usage.reasoningTokens <= usage.outputTokens)
    && (usage.cacheReadTokens === undefined || usage.cacheWriteTokens === undefined || usage.totalTokens === prompt + usage.outputTokens)
    && (usage.routes === undefined || Array.isArray(usage.routes) && usage.routes.length <= 128 && usage.routes.every(route => ref(route.provider) && ref(route.model)))
}

function roleRecords(store: KingdomStore, kingdomId: string): Map<string, { value: RoleUsageObservation; firstSeq: number; seq: number }> {
  const latest = new Map<string, { value: RoleUsageObservation; firstSeq: number; seq: number }>()
  for (const event of store.listRuntimeCostEvents(kingdomId)) {
    if (event.event_type !== 'RUNTIME_ROLE_USAGE_OBSERVED') continue
    try {
      const value = JSON.parse(event.payload_json) as RoleUsageObservation
      if (value.type !== 'KingdomRoleUsage/v1' || value.sourceUnitRef !== event.target_id) continue
      const previous = latest.get(value.sourceUnitRef)
      if (previous && (previous.value.observationSequence > value.observationSequence || previous.value.status === 'COMPLETE' && value.status !== 'COMPLETE')) continue
      latest.set(value.sourceUnitRef, { value, firstSeq: previous?.firstSeq ?? event.seq, seq: event.seq })
    } catch { /* An invalid historical observation is not free usage. */ }
  }
  return latest
}

function coverageGaps(store: KingdomStore, kingdomId: string, sinceSeq = 0, carriedSourceRefs: readonly string[] = []): number {
  const units = new Set<string>()
  const carried = new Set(carriedSourceRefs)
  for (const event of store.listRuntimeCostEvents(kingdomId)) {
    if (event.event_type !== 'RUNTIME_ROLE_USAGE_OBSERVED') continue
    try {
      const value = JSON.parse(event.payload_json) as UsageCoverageGap
      if (value.type === 'KingdomUsageCoverageGap/v1' && (event.seq > sinceSeq || carried.has(value.sourceUnitRef))) units.add(value.sourceUnitRef)
    } catch { if (event.seq > sinceSeq || carried.has(event.target_id ?? event.event_id)) units.add(event.target_id ?? event.event_id) }
  }
  return units.size
}

export function recordUsageCoverageGap(store: KingdomStore, kingdomId: string, sourceUnitRef: string, reasonCode: 'ROLE_IDENTITY_AMBIGUOUS'): void {
  if (!ref(sourceUnitRef) || store.getDefaultKingdom()?.kingdom_id !== kingdomId) return
  const previous = store.getLatestRuntimeRoleUsageEvent(kingdomId, sourceUnitRef)
  if (previous) return
  const value: UsageCoverageGap = { type: 'KingdomUsageCoverageGap/v1', sourceUnitRef, reasonCode }
  store.appendEvent({ event_id: randomUUID(), kingdom_id: kingdomId, event_type: 'RUNTIME_ROLE_USAGE_OBSERVED', actor_role: 'SYSTEM',
    actor_id: 'kingdom-cost-observer', target_type: 'runtime-usage', target_id: sourceUnitRef, payload_json: JSON.stringify(value), created_at: new Date().toISOString() })
}

/** Arbitrary plugin names are not trusted metadata. Only fixed public categories reach the ledger. */
export function safePromptPartName(value: string, index: number, type: 'section' | 'context'): string {
  const known: Record<string, string> = { 'harness:identity': 'harness identity', 'agent:identity': 'agent identity',
    'tools': 'tool guidance', 'skills': 'skill catalog', 'plugins': 'plugin guidance', 'AGENTS.md': 'workspace guidance',
    'runtime': 'runtime context', 'runtime:snapshot': 'runtime snapshot' }
  return known[value] ?? `${type} ${index + 1}`
}

export function recordRoleUsage(store: KingdomStore, kingdomId: string, input: RoleUsageObservation): boolean {
  const value = structuredClone(input)
  const binding = store.getBindingById(value.bindingId)
  if (!binding || binding.kingdom_id !== kingdomId || !['CHANCELLOR', 'SUPERVISOR'].includes(binding.role_type)
    || binding.role_type !== value.roleType || value.type !== 'KingdomRoleUsage/v1' || value.source !== 'provider-reported'
    || ![value.sourceUnitRef, value.runtimeInstanceRef, value.sessionRef].every(ref)
    || !count(value.startedLedgerSeq) || !count(value.observationSequence) || !Number.isFinite(Date.parse(value.startedAt))
    || !count(value.observedRequests) || !count(value.reportedRequests) || value.reportedRequests > value.observedRequests
    || !['IN_PROGRESS', 'COMPLETE', 'UNAVAILABLE'].includes(value.status)
    || !['TASK', 'SHARED', 'UNATTRIBUTED'].includes(value.attribution)
    || !Array.isArray(value.taskIds) || value.taskIds.length > 32 || new Set(value.taskIds).size !== value.taskIds.length
    || value.taskIds.some(id => { const task = store.getTask(id); return !task || store.getTerritoryById(task.territory_id)?.kingdom_id !== kingdomId })
    || (value.attribution === 'TASK' ? value.taskIds.length !== 1 : value.attribution === 'UNATTRIBUTED' ? value.taskIds.length !== 0 : value.taskIds.length < 1)
    || (value.status === 'COMPLETE' ? !value.usage || !validProviderCounts(value.usage) || value.observedRequests !== value.reportedRequests : value.usage !== null)) return false
  return store.withImmediateTransaction(() => {
    const event = store.getLatestRuntimeRoleUsageEvent(kingdomId, value.sourceUnitRef)
    let previous: RoleUsageObservation | undefined
    try { previous = event ? JSON.parse(event.payload_json) as RoleUsageObservation : undefined } catch { return false }
    if (previous && previous.type !== 'KingdomRoleUsage/v1') return false
    if (previous && (previous.bindingId !== value.bindingId || previous.sessionRef !== value.sessionRef
      || previous.runtimeInstanceRef !== value.runtimeInstanceRef || previous.startedLedgerSeq !== value.startedLedgerSeq
      || previous.observationSequence > value.observationSequence || previous.status === 'COMPLETE' && value.status !== 'COMPLETE')) return false
    if (previous && JSON.stringify(previous) === JSON.stringify(value)) return true
    // A complete turn is an immutable source unit; rescanning after a budget
    // boundary must not move old usage into the new accounting period.
    if (previous?.status === 'COMPLETE') return false
    store.appendEvent({ event_id: randomUUID(), kingdom_id: kingdomId, event_type: 'RUNTIME_ROLE_USAGE_OBSERVED',
      actor_role: 'SYSTEM', actor_id: 'kingdom-cost-observer', target_type: 'runtime-usage', target_id: value.sourceUnitRef,
      payload_json: JSON.stringify(value), created_at: new Date().toISOString() })
    return true
  })
}

export interface AdditionalRoleCostSummary {
  scope: 'OBSERVED_GOVERNANCE_TURNS'
  units: number
  completeUnits: number
  pendingUnits: number
  unknownUnits: number
  attributionGapCount: number
  observedRequests: number
  reportedRequests: number
  verifiedTokens: number | null
  byRole: { roleType: string; units: number; completeUnits: number; verifiedTokens: number | null }[]
  sharedTokens: number | null
  unattributedTokens: number | null
  amount: null
  amountStatus: 'PRICE_NOT_CONFIGURED'
  coverageNote: string
}

/** Lost observer continuity is unknown usage, never proof a Runtime stopped. */
export function closeInterruptedRoleObservations(store: KingdomStore, kingdomId: string, runtimeInstanceRef: string): number {
  let closed = 0
  for (const { value } of roleRecords(store, kingdomId).values()) {
    if (value.runtimeInstanceRef !== runtimeInstanceRef || value.status !== 'IN_PROGRESS') continue
    if (recordRoleUsage(store, kingdomId, { ...value, status: 'UNAVAILABLE', reasonCode: 'OBSERVER_RESTARTED', usage: null })) closed++
  }
  return closed
}

export function readAdditionalRoleCost(store: KingdomStore, kingdomId: string, taskId?: string): AdditionalRoleCostSummary {
  const all = [...roleRecords(store, kingdomId).values()].map(record => record.value)
  const values = taskId ? all.filter(value => value.attribution === 'TASK' && value.taskIds[0] === taskId) : all
  const complete = values.filter(value => value.status === 'COMPLETE' && value.usage && validProviderCounts(value.usage))
  const sum = (items: RoleUsageObservation[]) => {
    if (!items.length) return null
    const total = items.reduce((total, item) => total + item.usage!.totalTokens, 0)
    return count(total) ? total : null
  }
  const shared = all.filter(value => value.attribution === 'SHARED' && value.status === 'COMPLETE' && value.usage)
  const unassigned = all.filter(value => value.attribution === 'UNATTRIBUTED' && value.status === 'COMPLETE' && value.usage)
  return { scope: 'OBSERVED_GOVERNANCE_TURNS', units: values.length, completeUnits: complete.length,
    pendingUnits: values.filter(value => value.status === 'IN_PROGRESS').length,
    unknownUnits: values.filter(value => value.status === 'UNAVAILABLE').length + coverageGaps(store, kingdomId),
    attributionGapCount: all.filter(value => value.attribution !== 'TASK').length,
    observedRequests: values.reduce((sum, value) => sum + value.observedRequests, 0),
    reportedRequests: values.reduce((sum, value) => sum + value.reportedRequests, 0), verifiedTokens: sum(complete),
    byRole: ['CHANCELLOR', 'SUPERVISOR'].map(roleType => ({ roleType,
      units: values.filter(value => value.roleType === roleType).length,
      completeUnits: complete.filter(value => value.roleType === roleType).length,
      verifiedTokens: sum(complete.filter(value => value.roleType === roleType)) })),
    sharedTokens: sum(shared), unattributedTokens: sum(unassigned), amount: null, amountStatus: 'PRICE_NOT_CONFIGURED',
    coverageNote: '仅包含本次观测接入后可核对的宰相/主管轮次；共享及未归属不摊入单任务，未接入的外部参与者和旧历史仍是覆盖缺口。' }
}

/** Add only non-Worker observations; Worker dispatch reports are already counted by budget.ts. */
export function readIncompleteRoleUsageSourceRefs(store: KingdomStore, kingdomId: string): string[] {
  const refs = new Set([...roleRecords(store, kingdomId).values()].filter(record => record.value.status !== 'COMPLETE')
    .map(record => record.value.sourceUnitRef))
  for (const event of store.listRuntimeCostEvents(kingdomId)) {
    if (event.event_type !== 'RUNTIME_ROLE_USAGE_OBSERVED') continue
    try {
      const value = JSON.parse(event.payload_json) as UsageCoverageGap
      if (value.type === 'KingdomUsageCoverageGap/v1' && ref(value.sourceUnitRef)) refs.add(value.sourceUnitRef)
    } catch { refs.add(event.target_id ?? event.event_id) }
  }
  return [...refs]
}

/** Frozen carry-in sources preserve work already pending when the first policy was created. */
export function readAdditionalBudgetUsage(store: KingdomStore, kingdomId: string, sinceEventSeq: number, carriedSourceRefs: readonly string[] = []): {
  verifiedTokens: number; unknownUnits: number; pendingUnits: number; attributionGapCount: number
} {
  const carried = new Set(carriedSourceRefs)
  const records = [...roleRecords(store, kingdomId).values()].filter(record => record.seq > sinceEventSeq || carried.has(record.value.sourceUnitRef))
  let verifiedTokens = 0, unknownUnits = 0, pendingUnits = 0, attributionGapCount = 0
  for (const { value } of records) {
    if (value.status === 'IN_PROGRESS') pendingUnits++
    else if (value.status !== 'COMPLETE' || !value.usage || !validProviderCounts(value.usage)) unknownUnits++
    else if (count(verifiedTokens + value.usage.totalTokens)) verifiedTokens += value.usage.totalTokens
    else unknownUnits++
    if (value.attribution !== 'TASK') attributionGapCount++
  }
  return { verifiedTokens, unknownUnits: unknownUnits + coverageGaps(store, kingdomId, sinceEventSeq, carriedSourceRefs), pendingUnits, attributionGapCount }
}

export function recordPromptCost(store: KingdomStore, kingdomId: string, input: PromptCostObservation): void {
  const binding = store.getBindingById(input.bindingId)
  const parts = [...input.sections, ...input.contexts]
  if (!binding || binding.kingdom_id !== kingdomId || !ref(input.sourceUnitRef) || parts.length > 256
    || parts.some(part => !ref(part.name) || !count(part.bytes))
    || ![input.toolsBefore, input.toolsAfter, input.toolsBytesBefore, input.toolsBytesAfter].every(count)) return
  const value: PromptCostObservation = { ...input,
    sections: input.sections.map((part, index) => ({ name: safePromptPartName(part.name, index, 'section'), bytes: part.bytes })),
    contexts: input.contexts.map((part, index) => ({ name: safePromptPartName(part.name, index, 'context'), bytes: part.bytes })) }
  store.appendEvent({ event_id: randomUUID(), kingdom_id: kingdomId, event_type: 'RUNTIME_PROMPT_COST_OBSERVED', actor_role: 'SYSTEM',
    actor_id: 'kingdom-cost-observer', target_type: 'runtime-prompt', target_id: input.sourceUnitRef,
    payload_json: JSON.stringify(value), created_at: new Date().toISOString() })
}

export function readLatestPromptCosts(store: KingdomStore, kingdomId: string): PromptCostObservation[] {
  const latest = new Map<string, PromptCostObservation>()
  for (const event of store.listRuntimeCostEvents(kingdomId)) {
    if (event.event_type !== 'RUNTIME_PROMPT_COST_OBSERVED') continue
    try {
      const value = JSON.parse(event.payload_json) as PromptCostObservation
      if (value.type === 'KingdomPromptCost/v1') latest.set(value.bindingId, value)
    } catch { /* Omit corrupt observations rather than inventing measurements. */ }
  }
  return [...latest.values()]
}
