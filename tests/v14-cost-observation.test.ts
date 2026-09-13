import test from 'node:test'
import assert from 'node:assert/strict'
import { KingdomStore } from '../lib/core/db.js'
import { recordRoleUsage, readAdditionalRoleCost, readAdditionalBudgetUsage, readLatestPromptCosts, type RoleUsageObservation } from '../lib/core/cost.js'
import { extractDshTurnCost } from '../lib/adapter/dsh-cost.js'
import { loadDshUsageReader } from '../lib/adapter/dsh-usage.js'
import { installRuntimeCostObservers, type RuntimeCostHost } from '../lib/runtime-cost-observer.js'
import type { RuntimeEvent } from '../lib/adapter/contract.js'

const KID = 'cost-observation-kingdom'
const NOW = '2026-09-12T15:00:00.000Z'
const INSTANCE = 'fixture-runtime'
const SID = 'fixture-supervisor-session'

function setup() {
  const store = new KingdomStore(':memory:')
  store.insertKingdom({ kingdom_id: KID, name: '观测隔离验证', owner_id: 'owner', owner_name: '人类', created_at: NOW })
  for (const role of ['SUPERVISOR', 'WORKER']) store.insertBinding({ binding_id: role, kingdom_id: KID, role_type: role, role_name: role,
    runtime_type: 'dsh', session_id: role === 'SUPERVISOR' ? SID : null, model_name: null, agent_name: null, session_meta: null,
    execution_profile_json: null, status: 'ACTIVE', retired_at: null, retired_reason: null, principal_id: null, created_at: NOW, updated_at: NOW })
  store.insertTerritory({ territory_id: 'territory', kingdom_id: KID, name: '观测领地', workspace_path: null, summary: null,
    supervisor_binding_id: 'SUPERVISOR', status: 'ACTIVE', deleted_at: null, deleted_reason: null, created_at: NOW })
  for (const task of ['task-a', 'task-b']) store.insertTask({ task_id: task, territory_id: 'territory', parent_task_id: null, title: task,
    description: '', assigned_binding_id: 'WORKER', status: 'ASSIGNED', acceptance_criteria: '', result_summary: null, created_at: NOW, updated_at: NOW })
  return store
}

const usage = { uncachedInputTokens: 12, cacheReadTokens: 5, cacheWriteTokens: 0, outputTokens: 8, totalTokens: 25, reasoningTokens: 3,
  routes: [{ provider: 'fixture-provider', model: 'fixture-model' }] }
const observation = (changes: Partial<RoleUsageObservation> = {}): RoleUsageObservation => ({
  type: 'KingdomRoleUsage/v1', source: 'provider-reported', sourceUnitRef: 'source-turn-1', runtimeInstanceRef: INSTANCE,
  sessionRef: SID, bindingId: 'SUPERVISOR', roleType: 'SUPERVISOR', taskIds: [], attribution: 'UNATTRIBUTED', startedAt: NOW,
  startedLedgerSeq: 0, observationSequence: 1, status: 'IN_PROGRESS', reasonCode: 'TURN_IN_PROGRESS', observedRequests: 0, reportedRequests: 0, usage: null,
  ...changes,
})
const event = (seq: number, type: string, data: Record<string, unknown> = {}): RuntimeEvent => ({ seq, type, data })
const completedEvents = () => [event(10, 'turn/start', { turn: 2 }), event(11, 'step/start', { turn: 2, step: 0 }),
  event(12, 'assistant/attempt', { usage: { inputTokens: 7, outputTokens: 3 } }),
  event(13, 'llm/retry-started', { turn: 2, step: 0 }),
  event(14, 'assistant/message', { stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } } }] }),
  event(15, 'turn/end', { turn: 2 })]

test('turn cost delegates only the exact complete turn to an injected public-deriver contract and counts retry requests', () => {
  const turn = completedEvents()
  let received: readonly RuntimeEvent[] = []
  let calls = 0
  const result = extractDshTurnCost([event(9, 'unrelated'), ...turn, event(16, 'turn/start', { turn: 3 })], 10,
    events => { calls++; received = events; return usage })
  assert.equal(calls, 1)
  assert.deepEqual(received, turn)
  assert.equal(result.status, 'COMPLETE')
  assert.equal(result.observedRequests, 2)
  assert.equal(result.reportedRequests, 2)
  assert.equal(result.observationSequence, 15)
  assert.deepEqual(result.usage, usage)
  assert.equal(result.usage!.totalTokens, 25, 'reasoning remains within output, not an extra charge')
})

test('turn cost preserves unknown rather than a free request for missing usage, sequence gaps or unavailable readers', () => {
  const full = completedEvents()
  const missing = full.map(item => item.seq === 12 ? event(12, 'assistant/attempt', { error: 'first attempt missing usage' }) : item)
  let calls = 0
  const derive = () => { calls++; return usage }
  const result = extractDshTurnCost(missing, 10, derive)
  assert.equal(result.status, 'UNAVAILABLE')
  assert.equal(result.reasonCode, 'REQUEST_USAGE_MISSING')
  assert.equal(result.observedRequests, 2)
  assert.equal(result.reportedRequests, 1)
  assert.equal(result.usage, null)
  assert.equal(calls, 0)
  assert.equal(extractDshTurnCost(full.filter(item => item.seq !== 13), 10, derive).reasonCode, 'EVENT_SEQUENCE_INVALID')
  assert.equal(extractDshTurnCost(full.slice(0, -1), 10, derive).status, 'IN_PROGRESS')
  assert.equal(extractDshTurnCost(full, 10, null).reasonCode, 'USAGE_READER_UNAVAILABLE')
  assert.equal(extractDshTurnCost(full, 10, () => { throw new Error('fixture reader failed') }).reasonCode, 'USAGE_READER_FAILED')
  assert.equal(extractDshTurnCost(full, 10, () => ({ ...usage, reasoningTokens: 99 })).reasonCode, 'USAGE_INCOMPLETE')
  assert.equal(extractDshTurnCost(null, 10, derive).reasonCode, 'EVENTS_UNREADABLE')
})

test('role observations resample monotonically, freeze COMPLETE, and do not move old usage across a budget boundary', () => {
  const store = setup()
  try {
    const pending = observation()
    assert.equal(recordRoleUsage(store, KID, pending), true)
    const firstSeq = store.eventSequence()
    assert.equal(recordRoleUsage(store, KID, pending), true)
    assert.equal(store.eventSequence(), firstSeq, 'same sample is idempotent')
    assert.equal(recordRoleUsage(store, KID, observation({ observationSequence: 0 })), false)
    const complete = observation({ observationSequence: 8, status: 'COMPLETE', reasonCode: null, observedRequests: 2, reportedRequests: 2, usage })
    assert.equal(recordRoleUsage(store, KID, complete), true)
    const boundary = store.eventSequence()
    assert.equal(recordRoleUsage(store, KID, complete), true)
    assert.equal(recordRoleUsage(store, KID, { ...complete, observationSequence: 9 }), false)
    assert.equal(recordRoleUsage(store, KID, observation({ observationSequence: 10, status: 'UNAVAILABLE', reasonCode: 'OBSERVER_CLOSED' })), false)
    assert.equal(store.eventSequence(), boundary)
    assert.equal(readAdditionalRoleCost(store, KID).verifiedTokens, 25)
    assert.equal(readAdditionalBudgetUsage(store, KID, boundary).verifiedTokens, 0)
  } finally { store.close() }
})

test('role and kingdom mismatches are rejected and even single-related-task shared observations are not allocated to TASK', () => {
  const store = setup()
  try {
    store.insertKingdom({ kingdom_id: 'foreign', name: '外部王国', owner_id: 'foreign-owner', owner_name: '外部', created_at: '2026-09-13T00:00:00.000Z' })
    store.insertTerritory({ territory_id: 'foreign-territory', kingdom_id: 'foreign', name: '外部领地', workspace_path: null, summary: null,
      supervisor_binding_id: null, status: 'ACTIVE', deleted_at: null, deleted_reason: null, created_at: NOW })
    store.insertTask({ task_id: 'foreign-task', territory_id: 'foreign-territory', parent_task_id: null, title: '外部任务', description: '',
      assigned_binding_id: null, status: 'CREATED', acceptance_criteria: '', result_summary: null, created_at: NOW, updated_at: NOW })
    assert.equal(recordRoleUsage(store, KID, observation({ roleType: 'CHANCELLOR' })), false)
    assert.equal(recordRoleUsage(store, KID, observation({ bindingId: 'WORKER' })), false)
    assert.equal(recordRoleUsage(store, KID, observation({ taskIds: ['foreign-task'], attribution: 'TASK' })), false)
    const complete = observation({ status: 'COMPLETE', reasonCode: null, observedRequests: 1, reportedRequests: 1, usage,
      taskIds: ['task-a'], attribution: 'SHARED' })
    assert.equal(recordRoleUsage(store, KID, complete), true)
    assert.equal(readAdditionalRoleCost(store, KID).sharedTokens, 25)
    assert.equal(readAdditionalRoleCost(store, KID, 'task-a').verifiedTokens, null)
    assert.equal(readAdditionalRoleCost(store, KID, 'task-a').units, 0)
  } finally { store.close() }
})

function hostFixture() {
  const callbacks = new Map<string, (...args: any[]) => any>()
  const events: RuntimeEvent[] = []
  const session = { id: SID, snapshotEvents: () => [...events] }
  const agent = { id: SID, session }
  let deregistered = 0
  const host: RuntimeCostHost = {
    on(name, callback) { callbacks.set(name, callback); return () => { deregistered++; callbacks.delete(name) } },
    get(name) { return name === 'agents' ? { list: () => [agent] } : undefined },
  }
  const emit = (next: RuntimeEvent, actual: object = session) => { events.push(next); callbacks.get('session/event')!(actual, next) }
  return { host, session, agent, emit, callbacks, deregistered: () => deregistered }
}

function addAffinity(store: KingdomStore, sessionRef = SID) {
  store.insertAffinity({ affinity_id: 'worker-affinity', kingdom_id: KID, worker_binding_id: 'WORKER', runtime_type: 'dsh',
    runtime_instance_ref: INSTANCE, session_ref: sessionRef, territory_id: 'territory', established_at: NOW, retired_at: null, is_current: 1, created_at: NOW })
}

test('runtime observer refuses Worker affinity plus Supervisor dual identity and records one unknown coverage gap', () => {
  const store = setup(); const host = hostFixture()
  addAffinity(store)
  const observer = installRuntimeCostObservers(host.host, store, { runtimeInstanceRef: INSTANCE, mode: 'off' })
  try {
    host.emit(event(1, 'turn/start', { turn: 1 }))
    host.emit(event(1, 'turn/start', { turn: 1 }))
    const summary = readAdditionalRoleCost(store, KID)
    assert.equal(summary.units, 0)
    assert.equal(summary.verifiedTokens, null)
    assert.equal(summary.unknownUnits, 1)
    assert.equal(readAdditionalBudgetUsage(store, KID, 0).unknownUnits, 1)
    const rows = store.listRuntimeCostEvents(KID)
    assert.equal(rows.length, 1)
    assert.equal(JSON.parse(rows[0]!.payload_json).reasonCode, 'ROLE_IDENTITY_AMBIGUOUS')
  } finally { observer.dispose(); store.close() }
})

test('disposing an in-progress observer marks OBSERVER_CLOSED while preserving Task and Lease facts', async () => {
  const store = setup(); const host = hostFixture()
  addAffinity(store, 'separate-worker-session')
  store.insertLease({ lease_id: 'lease', kingdom_id: KID, worker_binding_id: 'WORKER', runtime_type: 'dsh', runtime_instance_ref: INSTANCE,
    session_ref: 'separate-worker-session', territory_id: 'territory', task_id: 'task-a', attempt_no: 1, state: 'ACQUIRED', capability_decision_id: null,
    enforcement_plan_snapshot: null, release_evidence_json: null, release_reason: null, acquired_at: NOW, released_at: null, updated_at: NOW })
  const before = { task: store.getTask('task-a'), lease: store.getLease('lease') }
  const observer = installRuntimeCostObservers(host.host, store, { runtimeInstanceRef: INSTANCE, mode: 'off' })
  try {
    host.emit(event(1, 'turn/start', { turn: 1 }))
    host.emit(event(2, 'step/start', { turn: 1, step: 0 }))
    assert.equal(readAdditionalRoleCost(store, KID).pendingUnits, 1)
    observer.dispose(); observer.dispose()
    await new Promise(resolve => setImmediate(resolve))
    const latest = JSON.parse(store.getLatestRuntimeRoleUsageEvent(KID, INSTANCE + ':' + SID + ':1')!.payload_json)
    assert.equal(latest.status, 'UNAVAILABLE')
    assert.equal(latest.reasonCode, 'OBSERVER_CLOSED')
    assert.equal(latest.usage, null)
    assert.equal(readAdditionalRoleCost(store, KID).pendingUnits, 0)
    assert.equal(readAdditionalRoleCost(store, KID).unknownUnits, 1)
    assert.deepEqual({ task: store.getTask('task-a'), lease: store.getLease('lease') }, before)
    assert.equal(host.deregistered(), 2)
  } finally { observer.dispose(); store.close() }
})

test('assembly observation removes arbitrary secret names before the raw ledger and never stores prompt text', async () => {
  const store = setup(); const host = hostFixture()
  const observer = installRuntimeCostObservers(host.host, store, { runtimeInstanceRef: INSTANCE, mode: 'pilot',
    disclosureMeta: () => ({ toolsBefore: 20, toolsAfter: 2, toolsBytesBefore: 8000, toolsBytesAfter: 600, mode: 'pilot', reasonCode: null }) })
  try {
    const assembly = { tools: [{ name: 'fixture_tool' }], sections: [{ name: 'password-super-secret-category', text: 'private system contents' }, { name: 'AGENTS.md', text: 'workspace text' }],
      contexts: [{ name: 'D:/private/secret-context', text: 'private workspace contents' }] }
    const output = await host.callbacks.get('system-prompt/assemble')!(assembly, { agent: host.agent }, async () => assembly)
    assert.equal(output, assembly)
    const rows = store.listRuntimeCostEvents(KID)
    const raw = rows.map(row => row.payload_json).join('\n')
    for (const secret of ['password-super-secret-category', 'D:/private/secret-context', 'private system contents', 'private workspace contents', 'workspace text']) assert.equal(raw.includes(secret), false)
    const view = readLatestPromptCosts(store, KID)[0]!
    assert.deepEqual(view.sections.map(part => part.name), ['section 1', 'workspace guidance'])
    assert.deepEqual(view.contexts.map(part => part.name), ['context 1'])
    assert.equal(view.sections[0]!.bytes, Buffer.byteLength('private system contents'))
    assert.equal(view.toolsBefore, 20); assert.equal(view.toolsAfter, 2)
    assert.equal(view.mode, 'pilot'); assert.equal(view.roleType, 'SUPERVISOR')
    assert.equal(view.reasonCode, null)
    assert.equal(view.historyBytes, null); assert.equal(view.tokenEstimate, null)
  } finally { observer.dispose(); store.close() }
})

test('runtime observer requires the exact registry object and reports unavailable when event subscription is absent', () => {
  const store = setup(); const host = hostFixture()
  const absent = installRuntimeCostObservers({ get: () => undefined }, store, { runtimeInstanceRef: INSTANCE, mode: 'off' })
  assert.equal(absent.available, false)
  const observer = installRuntimeCostObservers(host.host, store, { runtimeInstanceRef: INSTANCE, mode: 'off' })
  try {
    host.emit(event(1, 'turn/start', { turn: 1 }), { id: SID, snapshotEvents: host.session.snapshotEvents })
    assert.equal(store.listRuntimeCostEvents(KID).length, 0)
  } finally { observer.dispose(); absent.dispose(); store.close() }
})

test('a late completed collect cannot remove the next turn from the same Session before observer disposal', async () => {
  // Resolve only the public usage module before the race so one event-loop turn
  // deterministically drains collect continuations; this makes no model request.
  await loadDshUsageReader()
  const store = setup(); const host = hostFixture()
  addAffinity(store, 'separate-worker-session')
  store.insertLease({ lease_id: 'overlap-lease', kingdom_id: KID, worker_binding_id: 'WORKER', runtime_type: 'dsh', runtime_instance_ref: INSTANCE,
    session_ref: 'separate-worker-session', territory_id: 'territory', task_id: 'task-a', attempt_no: 1, state: 'ACQUIRED', capability_decision_id: null,
    enforcement_plan_snapshot: null, release_evidence_json: null, release_reason: null, acquired_at: NOW, released_at: null, updated_at: NOW })
  const before = { tasks: store.listTasks(KID), leases: store.listLeases(KID) }
  const observer = installRuntimeCostObservers(host.host, store, { runtimeInstanceRef: INSTANCE, mode: 'off' })
  const oldRef = `${INSTANCE}:${SID}:1`, nextRef = `${INSTANCE}:${SID}:4`
  const latest = (source: string): RoleUsageObservation => JSON.parse(store.getLatestRuntimeRoleUsageEvent(KID, source)!.payload_json)
  try {
    host.emit(event(1, 'turn/start', { turn: 1 }))
    host.emit(event(2, 'step/start', { turn: 1, step: 0 }))
    host.emit(event(3, 'turn/end', { turn: 1 }))
    host.emit(event(4, 'turn/start', { turn: 2 }))
    const nextInitial = latest(nextRef)
    assert.equal(latest(oldRef).status, 'IN_PROGRESS', 'old collect is still behind await when the next turn starts')
    assert.equal(nextInitial.status, 'IN_PROGRESS')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(latest(oldRef).status, 'UNAVAILABLE', 'the old ended turn has now settled without a complete usage report')
    assert.deepEqual(latest(nextRef), nextInitial, 'the old result must not mutate the new source unit')
    const oldSettled = store.getLatestRuntimeRoleUsageEvent(KID, oldRef)

    observer.dispose()
    const nextClosed = latest(nextRef)
    assert.equal(nextClosed.status, 'UNAVAILABLE', 'the new capture must remain tracked until disposal')
    assert.equal(nextClosed.reasonCode, 'OBSERVER_CLOSED')
    assert.equal(nextClosed.sourceUnitRef, nextRef)
    assert.equal(nextClosed.startedLedgerSeq, nextInitial.startedLedgerSeq)
    assert.equal(nextClosed.usage, null)
    assert.deepEqual(store.getLatestRuntimeRoleUsageEvent(KID, oldRef), oldSettled, 'disposal cannot rewrite the previously settled turn')
    assert.equal(readAdditionalRoleCost(store, KID).pendingUnits, 0)
    assert.equal(readAdditionalRoleCost(store, KID).unknownUnits, 2)
    assert.deepEqual({ tasks: store.listTasks(KID), leases: store.listLeases(KID) }, before)
  } finally { observer.dispose(); store.close() }
})

test('observer installation closes only interrupted observations from its runtime without changing accounting identity or execution facts', () => {
  const store = setup(); const host = hostFixture()
  addAffinity(store, 'separate-worker-session')
  store.insertLease({ lease_id: 'restart-lease', kingdom_id: KID, worker_binding_id: 'WORKER', runtime_type: 'dsh', runtime_instance_ref: INSTANCE,
    session_ref: 'separate-worker-session', territory_id: 'territory', task_id: 'task-a', attempt_no: 1, state: 'ACQUIRED', capability_decision_id: null,
    enforcement_plan_snapshot: null, release_evidence_json: null, release_reason: null, acquired_at: NOW, released_at: null, updated_at: NOW })
  const pending = observation({ sourceUnitRef: 'interrupted-source', observationSequence: 9, startedLedgerSeq: 7,
    taskIds: ['task-a'], attribution: 'SHARED', observedRequests: 2, reportedRequests: 1 })
  const completePending = observation({ sourceUnitRef: 'completed-source', startedLedgerSeq: 3 })
  const complete = { ...completePending, observationSequence: 8, status: 'COMPLETE' as const, reasonCode: null,
    observedRequests: 2, reportedRequests: 2, usage }
  const unrelated = observation({ sourceUnitRef: 'other-runtime-source', runtimeInstanceRef: 'another-runtime', startedLedgerSeq: 4 })
  const unavailable = observation({ sourceUnitRef: 'already-unavailable', status: 'UNAVAILABLE', reasonCode: 'REQUEST_USAGE_MISSING' })
  for (const value of [pending, completePending, complete, unrelated, unavailable]) assert.equal(recordRoleUsage(store, KID, value), true)
  const latest = (source: string) => store.getLatestRuntimeRoleUsageEvent(KID, source)!
  const preserved = [complete.sourceUnitRef, unrelated.sourceUnitRef, unavailable.sourceUnitRef].map(latest)
  const facts = { tasks: store.listTasks(KID), leases: store.listLeases(KID) }
  const revisionBeforeInstall = store.eventSequence()
  const observer = installRuntimeCostObservers(host.host, store, { runtimeInstanceRef: INSTANCE, mode: 'off' })
  try {
    assert.equal(observer.available, true)
    const closed = JSON.parse(latest(pending.sourceUnitRef).payload_json) as RoleUsageObservation
    assert.equal(closed.status, 'UNAVAILABLE')
    assert.equal(closed.reasonCode, 'OBSERVER_RESTARTED', 'continuity was lost; this is not proof that the underlying execution stopped')
    assert.equal(closed.usage, null)
    assert.equal(closed.sourceUnitRef, pending.sourceUnitRef)
    assert.equal(closed.startedLedgerSeq, pending.startedLedgerSeq)
    assert.equal(closed.startedAt, pending.startedAt)
    assert.equal(closed.runtimeInstanceRef, pending.runtimeInstanceRef)
    assert.equal(closed.sessionRef, pending.sessionRef)
    assert.equal(closed.bindingId, pending.bindingId)
    assert.deepEqual(closed.taskIds, pending.taskIds)
    assert.equal(closed.attribution, pending.attribution)
    assert.equal(closed.observedRequests, pending.observedRequests)
    assert.equal(closed.reportedRequests, pending.reportedRequests)
    assert.ok(closed.observationSequence >= pending.observationSequence)
    assert.equal(store.eventSequence(), revisionBeforeInstall + 1, 'only the interrupted source gains an observation event')
    assert.deepEqual([complete.sourceUnitRef, unrelated.sourceUnitRef, unavailable.sourceUnitRef].map(latest), preserved)
    assert.deepEqual({ tasks: store.listTasks(KID), leases: store.listLeases(KID) }, facts)
    assert.equal(readAdditionalRoleCost(store, KID).pendingUnits, 1, 'another runtime remains pending')
    assert.equal(readAdditionalRoleCost(store, KID).verifiedTokens, 25, 'complete evidence is unchanged')

    observer.dispose()
    const revisionAfterClose = store.eventSequence()
    const reinstalled = installRuntimeCostObservers(host.host, store, { runtimeInstanceRef: INSTANCE, mode: 'off' })
    try {
      assert.equal(store.eventSequence(), revisionAfterClose, 'repeated installation does not reclose terminal observations')
      assert.deepEqual({ tasks: store.listTasks(KID), leases: store.listLeases(KID) }, facts)
    } finally { reinstalled.dispose() }
  } finally { observer.dispose(); store.close() }
})
