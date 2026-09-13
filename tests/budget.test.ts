import assert from 'node:assert/strict'
import test from 'node:test'
import { KingdomStore } from '../lib/core/db.js'
import { initializeKingdomFacts } from '../lib/core/kingdom.js'
import { issueOwnerControlCapability, issueOwnerOperationCapability, ownerControlAuth } from '../lib/core/owner-control.js'
import { OwnerDecisionController } from '../lib/core/owner-window.js'
import { bindRole } from '../lib/core/binding.js'
import {
  normalizeBudgetPolicyParameters, readBudgetPolicy, setBudgetPolicy, readBudgetView,
  reserveBudgetAdmission, bindBudgetAdmissionInTransaction, cancelBudgetAdmissionIfSafe, finishBudgetAdmissionInvocation,
  type BudgetAdmissionHandle, type BudgetPolicyParameters,
} from '../lib/core/budget.js'
import {
  establishAffinity, acquireExecutionLease, prepareGovernedDispatch, recordDispatchReceipt,
  correlateRuntimeExecution, recordTerminalEvidence, markGovernedDispatchRecovering,
} from '../lib/core/governed.js'
import { runCapabilityGate } from '../lib/capability/service.js'
import { DshRuntimeAdapter } from '../lib/adapter/dsh-backend.js'
import { runGovernedTask } from '../lib/worker/governed-executor.js'
import { recordDispatchUsage } from '../lib/core/usage.js'
import { recordRoleUsage, recordUsageCoverageGap, readAdditionalRoleCost, type RoleUsageObservation } from '../lib/core/cost.js'

const now = () => new Date().toISOString()
const defaultPolicy: BudgetPolicyParameters = { enabled: true, limit_tokens: 1000, reserve_tokens: 100, unknown_policy: 'BLOCK' }
function fixture(t: { after(fn: () => void): void }) {
  const store = new KingdomStore(':memory:')
  const { kingdomId } = store.withImmediateTransaction(() => initializeKingdomFacts(store, 'Budget kingdom', 'Human'))
  const capability = issueOwnerControlCapability(), auth = ownerControlAuth(capability)
  bindRole(store, { kingdomId, roleType: 'SUPERVISOR', roleName: 'S', sessionId: 'supervisor-session' }, auth)
  bindRole(store, { kingdomId, roleType: 'WORKER', roleName: 'W' }, auth)
  const worker = store.getBindingByRole(kingdomId, 'WORKER')!.binding_id
  const supervisor = store.getBindingByRole(kingdomId, 'SUPERVISOR')!.binding_id
  store.db.prepare('UPDATE role_bindings SET execution_profile_json = ? WHERE binding_id = ?').run('{"provider":"spawn","model":"test-model"}', worker)
  const territoryId = 'territory'
  store.insertTerritory({ territory_id: territoryId, kingdom_id: kingdomId, name: 'A', workspace_path: 'C:/terr-a', summary: null,
    supervisor_binding_id: supervisor, status: 'ACTIVE', deleted_at: null, deleted_reason: null, created_at: now() })
  const addTask = (taskId: string) => store.insertTask({ task_id: taskId, territory_id: territoryId, parent_task_id: null,
    title: taskId, description: null, assigned_binding_id: worker, status: 'ASSIGNED', acceptance_criteria: null,
    result_summary: null, created_at: now(), updated_at: now() })
  addTask('task-1'); addTask('task-2')
  const controller = new OwnerDecisionController(store, { validateTargetSession: async () => ({ ok: true }), validateExecutionProfile: async () => ({ ok: true }) })
  const handles: BudgetAdmissionHandle[] = []
  const policy = (changes: Partial<BudgetPolicyParameters> = {}) => {
    assert.match(setBudgetPolicy(store, { kingdomId, policy: { ...defaultPolicy, ...changes } }, auth), /预算/)
    return readBudgetPolicy(store, kingdomId)!
  }
  const input = (taskId = 'task-1', attemptNo = 1) => ({ kingdomId, taskId, attemptNo, workerBindingId: worker })
  const reserve = (taskId = 'task-1', attemptNo = 1) => { const handle = reserveBudgetAdmission(store, input(taskId, attemptNo)); handles.push(handle); return handle }
  t.after(() => { handles.forEach(finishBudgetAdmissionInvocation); controller.dispose(); store.close() })
  return { store, kingdomId, worker, supervisor, territoryId, capability, auth, controller, addTask, input, reserve, policy }
}
type Fixture = ReturnType<typeof fixture>
function adapterWithCounters() {
  const calls = { create: 0, resume: 0, dispatch: 0 }
  const append = (s: { events: unknown[] }, type: string, data: Record<string, unknown>) => s.events.push({ type, data })
  const adapter = new DshRuntimeAdapter({ runtimeInstanceRef: 'inst-1', provider: 'spawn', model: null,
    agents: { agents: new Map(), create: async () => { calls.create++; throw new Error('safe preparation fixture') },
      resume: async () => { calls.resume++; throw new Error('unexpected resume') }, get: () => undefined, list: () => [] },
    permission: { set: (s: never, name: string) => { append(s, 'permission/preset', { preset: name }); append(s, 'sandbox/mode', { mode: 'workspace-write' }); append(s, 'approval/policy', { policy: 'never' }) } },
    sandboxPolicy: { setSandboxMode: (s: never, mode: string) => append(s, 'sandbox/mode', { mode }) },
    approval: { setApprovalPolicy: (s: never, policy: string) => append(s, 'approval/policy', { policy }) },
  })
  adapter.dispatch = async () => { calls.dispatch++; throw new Error('unexpected dispatch') }
  return { adapter, calls }
}
function run(f: Fixture, adapter: DshRuntimeAdapter, taskId = 'task-1') {
  return runGovernedTask({ store: f.store, adapter, ...f.input(taskId), territoryId: f.territoryId, cwd: 'C:/terr-a',
    supervisorBindingId: f.supervisor, grant: { 'tool:pwsh': true }, requirementJson: '{"tool:pwsh":true}', sandboxMode: 'workspace-write', maxPolls: 0 })
}
async function gateFixture(f: Fixture) {
  f.store.setKingdomCapabilityCeiling(f.kingdomId, '{"tool:pwsh":true}')
  const session = { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 's-1' }
  establishAffinity(f.store, { kingdomId: f.kingdomId, workerBindingId: f.worker, territoryId: f.territoryId, session })
  const lease = acquireExecutionLease(f.store, { ...f.input(), territoryId: f.territoryId, session })
  const gate = await runCapabilityGate({ store: f.store, adapter: adapterWithCounters().adapter, ...f.input(),
    supervisorBindingId: f.supervisor, leaseId: lease.lease_id, requirementJson: '{"tool:pwsh":true}', ceilingJson: '{"tool:pwsh":true}',
    grant: { 'tool:pwsh': true }, sandboxMode: 'workspace-write', context: { sessionRef: 's-1', agent: {
      ctx: { tools: { restrict: () => () => {}, guard: () => () => {}, schemas: () => [{ name: 'pwsh' }] } },
      session: { header: { cwd: 'C:/terr-a' }, events: [] },
    } } })
  assert.equal(gate.materialized, true)
  return { gate, prepare: (budgetAdmission?: BudgetAdmissionHandle) => prepareGovernedDispatch(f.store, {
    ...f.input(), leaseId: gate.lease.lease_id, capabilityDecisionId: gate.decision.decision_id, session,
    requestSnapshot: '{}', inputRefJson: '{}', payloadHash: 'budget-fixture', budgetAdmission,
  }) }
}
function receipt(f: Fixture, dispatchId: string) {
  recordDispatchReceipt(f.store, dispatchId, { runtimeDispatchRef: 'msg-1', receiptJson: '{"type":"receipt/v1"}' })
  correlateRuntimeExecution(f.store, dispatchId, 'turn-1')
  const execution = f.store.getExecution(f.store.getDispatch(dispatchId)!.execution_id)!
  f.store.transitionExecution(execution, 'RUNNING')
}
function terminal(f: Fixture, dispatchId: string) {
  recordTerminalEvidence(f.store, dispatchId, { evidenceJson: '{"type":"terminal/v1"}', executionTerminalState: 'COMPLETED', settleLease: true })
}
function usage(f: Fixture, dispatchId: string, tokens: number | null, sequence = 5) {
  recordDispatchUsage(f.store, dispatchId, { type: 'DshDispatchUsage/v1', source: 'provider-reported', runtimeDispatchRef: 'msg-1',
    status: tokens === null ? 'PARTIAL' : 'COMPLETE', reasonCode: tokens === null ? 'MISSING_REQUEST_USAGE' : null,
    observedRequests: 1, reportedRequests: tokens === null ? 0 : 1, turn: 1, fromSeq: 1, throughSeq: sequence,
    usage: tokens === null ? null : { uncachedInputTokens: tokens - 5, outputTokens: 5, totalTokens: tokens } })
}
function roleObservation(f: Fixture, overrides: Partial<RoleUsageObservation> = {}): RoleUsageObservation {
  return { type: 'KingdomRoleUsage/v1', source: 'provider-reported', sourceUnitRef: 'inst-1/supervisor-session/turn-1',
    runtimeInstanceRef: 'inst-1', sessionRef: 'supervisor-session', bindingId: f.supervisor, roleType: 'SUPERVISOR',
    taskIds: [], attribution: 'UNATTRIBUTED', startedAt: now(), startedLedgerSeq: f.store.eventSequence(), observationSequence: 1,
    status: 'IN_PROGRESS', reasonCode: null, observedRequests: 1, reportedRequests: 0, usage: null, ...overrides }
}

test('Owner budget policy is default off and requires exact human authority and kingdom-wide scope', async t => {
  const f = fixture(t)
  assert.equal(readBudgetView(f.store, f.kingdomId).state, 'OFF')
  assert.equal(readBudgetPolicy(f.store, f.kingdomId), null)
  const input = { kingdomId: f.kingdomId, policy: defaultPolicy }
  assert.match(setBudgetPolicy(f.store, input), /OWNER_CONTROL_REQUIRED/)
  const narrow = issueOwnerOperationCapability(f.capability, f.store, f.kingdomId, { operation: 'budget.policy', input },
    { source_channel: 'LOCAL_OWNER_GUI', authorization_source: 'LOCAL_DIRECT_SLASH', decision_id: 'decision', operation_id: 'operation' })
  assert.match(setBudgetPolicy(f.store, { ...input, policy: { ...defaultPolicy, limit_tokens: 2000 } }, ownerControlAuth(narrow)), /MISMATCH/)
  assert.equal(readBudgetPolicy(f.store, f.kingdomId), null)
  const scope = { kingdomWide: false, territoryIds: [], bindingIds: [], roleTypes: [], targetSessionIds: [], workspaceRoots: [] }
  assert.throws(() => f.controller.activate(f.capability, { kingdomId: f.kingdomId, actions: ['budget.policy'], scope, ttlMs: 600000 }), /SCOPE|王国/)
  const handle = f.controller.activate(f.capability, { kingdomId: f.kingdomId, actions: ['budget.policy'], scope: { ...scope, kingdomWide: true }, ttlMs: 600000 }).handle
  const preview = await f.controller.prepare(handle, { action: 'budget.policy', parameters: defaultPolicy })
  const result = await f.controller.commit(handle, { prepareId: preview.prepareId, operationId: preview.operationId })
  assert.equal(result.status, 'APPLIED')
  const policyEvent = f.store.listBudgetEvents(f.kingdomId).find(e => e.event_type === 'BUDGET_POLICY_UPDATED')!
  const payload = JSON.parse(policyEvent.payload_json)
  assert.equal(policyEvent.actor_role, 'OWNER'); assert.equal(payload.operation_id, result.operationId)
  assert.equal(payload.decision_id, result.decisionId); assert.equal(payload.source_channel, 'LOCAL_OWNER_GUI')
  assert.deepEqual(f.controller.receipt(handle, result.operationId), result)
})

test('Owner budget policy validates all numeric fields and rejects smuggled fields', t => {
  fixture(t)
  for (const change of [ { limit_tokens: 0 }, { reserve_tokens: 0 }, { reserve_tokens: 1001 }, { limit_tokens: 1.5 },
    { reserve_tokens: Number.MAX_SAFE_INTEGER + 1 }, { warning_percent: 0 }, { warning_percent: 101 }, { warning_percent: 1.1 },
    { enabled: 'yes' }, { unknown_policy: 'IGNORE' }, { actor_id: 'owner' } ]) {
    assert.throws(() => normalizeBudgetPolicyParameters({ ...defaultPolicy, ...change }), { code: 'BUDGET_POLICY_INVALID' })
  }
  assert.equal(normalizeBudgetPolicyParameters(defaultPolicy).warning_percent, 80)
})

test('Owner budget policy receipt failure rolls back policy and a retry applies exactly once', async t => {
  const f = fixture(t)
  const handle = f.controller.activate(f.capability, { kingdomId: f.kingdomId, actions: ['budget.policy'], ttlMs: 600000,
    scope: { kingdomWide: true, territoryIds: [], bindingIds: [], roleTypes: [], targetSessionIds: [], workspaceRoots: [] } }).handle
  const preview = await f.controller.prepare(handle, { action: 'budget.policy', parameters: defaultPolicy })
  const append = f.store.appendEvent.bind(f.store), before = f.store.eventSequence()
  f.store.appendEvent = row => { if (row.event_type === 'OWNER_OPERATION_APPLIED') throw new Error('receipt fault'); return append(row) }
  await assert.rejects(f.controller.commit(handle, { prepareId: preview.prepareId, operationId: preview.operationId }), /receipt fault/)
  assert.equal(readBudgetPolicy(f.store, f.kingdomId), null); assert.equal(f.store.eventSequence(), before)
  f.store.appendEvent = append
  const result = await f.controller.commit(handle, { prepareId: preview.prepareId, operationId: preview.operationId })
  assert.equal(result.status, 'APPLIED')
  assert.equal(f.store.listBudgetEvents(f.kingdomId).filter(e => e.event_type === 'BUDGET_POLICY_UPDATED').length, 1)
})

test('last budget slot admits only one competing attempt and rejects duplicate replay', async t => {
  const f = fixture(t); f.policy({ limit_tokens: 100 })
  const results = await Promise.allSettled([Promise.resolve().then(() => f.reserve()), Promise.resolve().then(() => f.reserve('task-2'))])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult
  assert.equal(rejected.reason.code, 'BUDGET_LIMIT_REACHED')
  assert.throws(() => f.reserve(), { code: 'BUDGET_ADMISSION_DUPLICATE' })
  const view = readBudgetView(f.store, f.kingdomId)
  assert.equal(view.reservedEstimateTokens, 100); assert.equal(view.pendingUnits, 1); assert.equal(view.unknownUnits, 0)
  assert.equal(f.store.listLeases(f.kingdomId).length, 0); assert.equal(f.store.listExecutions('task-1').length, 0)
})

test('budget rejection precedes Session create resume and dispatch without changing Task or Lease', async t => {
  const f = fixture(t); f.policy({ limit_tokens: 100 })
  // Isolate the kingdom-wide budget limit from the new same-workspace guard.
  const territory = f.store.getTerritoryById(f.territoryId)!
  f.store.insertTerritory({ ...territory, territory_id: 'other-budget-workspace', name: 'Independent budget work', workspace_path: 'C:/independent-budget-fixture' })
  f.store.db.prepare('UPDATE tasks SET territory_id = ? WHERE task_id = ?').run('other-budget-workspace', 'task-2')
  f.reserve('task-2')
  const { adapter, calls } = adapterWithCounters(), task = { ...f.store.getTask('task-1')! }
  const result = await run(f, adapter)
  assert.equal(result.ok, false); if (!result.ok) assert.match(result.reason, /BUDGET_LIMIT_REACHED/)
  assert.deepEqual(calls, { create: 0, resume: 0, dispatch: 0 })
  assert.deepEqual({ ...f.store.getTask('task-1')! }, task)
  assert.equal(f.store.listLeases(f.kingdomId).length, 0); assert.equal(f.store.listExecutions('task-1').length, 0)
})

test('safe preparation failure cancels accounting and permits retry of the same attempt', async t => {
  const f = fixture(t); f.policy({ limit_tokens: 100 })
  const { adapter, calls } = adapterWithCounters()
  const result = await run(f, adapter)
  assert.equal(result.ok, false); if (!result.ok) assert.match(result.reason, /safe preparation fixture/)
  assert.equal(calls.create, 1)
  assert.equal(readBudgetView(f.store, f.kingdomId).reservedEstimateTokens, 0)
  assert.equal(f.store.listBudgetEvents(f.kingdomId).filter(e => e.event_type === 'BUDGET_ADMISSION_CANCELLED').length, 1)
  const next = f.reserve()
  assert.equal(cancelBudgetAdmissionIfSafe(f.store, next), true)
  assert.equal(f.store.listLeases(f.kingdomId).length, 0); assert.equal(f.store.getTask('task-1')!.status, 'ASSIGNED')
})

test('safe preparation cancellation never releases an active Lease or a RECOVERING dispatch', async t => {
  const f = fixture(t); f.policy(); const handle = f.reserve(), g = await gateFixture(f)
  const before = { ...f.store.getLease(g.gate.lease.lease_id)! }
  assert.equal(cancelBudgetAdmissionIfSafe(f.store, handle), false)
  assert.deepEqual({ ...f.store.getLease(before.lease_id)! }, before)
  const prepared = g.prepare(handle)
  markGovernedDispatchRecovering(f.store, prepared.intent.dispatch_id, 'RECONCILE_UNKNOWN')
  const recoveringLease = { ...f.store.getLease(before.lease_id)! }
  assert.equal(cancelBudgetAdmissionIfSafe(f.store, handle), false)
  assert.deepEqual({ ...f.store.getLease(before.lease_id)! }, recoveringLease)
  assert.equal(readBudgetView(f.store, f.kingdomId).recoveryUnits, 1)
  assert.equal(readBudgetView(f.store, f.kingdomId).reservedEstimateTokens, 100)
  assert.equal(f.store.getTask('task-1')!.status, 'ASSIGNED')
})

test('unfinished invocation remains unknown and historical copies cannot recover admission authority', t => {
  const f = fixture(t); f.policy(); const handle = f.reserve()
  finishBudgetAdmissionInvocation(handle)
  const view = readBudgetView(f.store, f.kingdomId)
  assert.equal(view.state, 'BLOCK_UNKNOWN'); assert.equal(view.unknownUnits, 1); assert.equal(view.reservedEstimateTokens, 100)
  assert.throws(() => f.reserve('task-2'), { code: 'BUDGET_UNKNOWN_USAGE' })
  assert.throws(() => cancelBudgetAdmissionIfSafe(f.store, handle), { code: 'BUDGET_ADMISSION_REQUIRED' })
  assert.throws(() => cancelBudgetAdmissionIfSafe(f.store, JSON.parse(JSON.stringify(handle))), { code: 'BUDGET_ADMISSION_REQUIRED' })
  f.policy({ unknown_policy: 'WARN' })
  assert.equal(readBudgetView(f.store, f.kingdomId).state, 'WARN')
  f.reserve('task-2')
})

test('TX-3 rejects missing forged cross-store and wrong-attempt admission handles atomically', async t => {
  const f = fixture(t); f.policy(); const handle = f.reserve(), g = await gateFixture(f)
  const other = fixture(t); other.policy(); const otherHandle = other.reserve()
  for (const invalid of [undefined, {} as BudgetAdmissionHandle, otherHandle]) {
    assert.throws(() => g.prepare(invalid), { code: 'BUDGET_ADMISSION_REQUIRED' })
    assert.equal(f.store.listDispatches(f.kingdomId).length, 0); assert.equal(f.store.listExecutions('task-1').length, 0)
    assert.equal(f.store.getLease(g.gate.lease.lease_id)!.state, 'DISPATCH_READY')
  }
  assert.throws(() => bindBudgetAdmissionInTransaction(f.store, handle, { ...f.input(), dispatchId: 'none', leaseId: g.gate.lease.lease_id }), { code: 'BUDGET_TRANSACTION_REQUIRED' })
  assert.throws(() => f.store.withImmediateTransaction(() => bindBudgetAdmissionInTransaction(f.store, handle,
    { ...f.input('task-1', 2), dispatchId: 'none', leaseId: g.gate.lease.lease_id })), { code: 'BUDGET_ADMISSION_MISMATCH' })
  const prepared = g.prepare(handle)
  assert.equal(prepared.intent.state, 'INTENDED')
  assert.equal(f.store.listBudgetEvents(f.kingdomId).filter(e => e.event_type === 'BUDGET_ADMISSION_BOUND').length, 1)
})

test('TX-3 budget bind fault rolls back all preparation and leaves the same handle retryable', async t => {
  const f = fixture(t); f.policy(); const handle = f.reserve(), g = await gateFixture(f)
  const before = f.store.eventSequence(), lease = { ...f.store.getLease(g.gate.lease.lease_id)! }, append = f.store.appendEvent.bind(f.store)
  f.store.appendEvent = row => { if (row.event_type === 'BUDGET_ADMISSION_BOUND') throw new Error('bind fault'); return append(row) }
  assert.throws(() => g.prepare(handle), /bind fault/)
  assert.equal(f.store.eventSequence(), before); assert.deepEqual({ ...f.store.getLease(lease.lease_id)! }, lease)
  assert.equal(f.store.listDispatches(f.kingdomId).length, 0); assert.equal(f.store.listExecutions('task-1').length, 0)
  assert.equal(f.store.getCapabilityDecision(g.gate.decision.decision_id)!.execution_id, null)
  f.store.appendEvent = append
  assert.equal(g.prepare(handle).intent.state, 'INTENDED')
})

test('Owner budget policy tightening affects new admission while TX-3 accepts prior work and accounting survives off-on', async t => {
  const f = fixture(t), first = f.policy(), handle = f.reserve(), g = await gateFixture(f)
  const narrowed = f.policy({ limit_tokens: 100 })
  assert.equal(narrowed.budgetId, first.budgetId); assert.equal(narrowed.sinceEventSeq, first.sinceEventSeq)
  assert.throws(() => f.reserve('task-2'), { code: 'BUDGET_LIMIT_REACHED' })
  const prepared = g.prepare(handle)
  f.policy({ enabled: false })
  assert.equal(readBudgetView(f.store, f.kingdomId).state, 'OFF'); assert.equal(readBudgetView(f.store, f.kingdomId).reservedEstimateTokens, 100)
  const enabled = f.policy()
  assert.equal(enabled.budgetId, first.budgetId); assert.equal(enabled.sinceEventSeq, first.sinceEventSeq)
  assert.equal(f.store.getDispatch(prepared.intent.dispatch_id)!.state, 'INTENDED')
})

test('observations replace estimates once and late complete usage resolves terminal missing coverage', async t => {
  const f = fixture(t); f.policy(); const handle = f.reserve(), g = await gateFixture(f), d = g.prepare(handle).intent.dispatch_id
  receipt(f, d); usage(f, d, null)
  assert.equal(readBudgetView(f.store, f.kingdomId).pendingUnits, 1)
  terminal(f, d)
  let view = readBudgetView(f.store, f.kingdomId)
  assert.equal(view.state, 'BLOCK_UNKNOWN'); assert.equal(view.unknownUnits, 1); assert.equal(view.reservedEstimateTokens, 100)
  usage(f, d, 35); usage(f, d, 35, 6)
  view = readBudgetView(f.store, f.kingdomId)
  assert.equal(view.workerVerifiedTokens, 35); assert.equal(view.verifiedTokens, 35); assert.equal(view.reservedEstimateTokens, 0)
  assert.equal(view.unknownUnits, 0); assert.equal(view.amount, null); assert.equal(view.amountStatus, 'UNKNOWN')
  usage(f, d, null, 7)
  assert.equal(readBudgetView(f.store, f.kingdomId).verifiedTokens, 35)
  assert.equal(f.store.getLease(g.gate.lease.lease_id)!.state, 'SETTLING', 'accounting does not release the lease')
  assert.equal(f.store.getTask('task-1')!.status, 'ASSIGNED')
})

test('observations include Supervisor pending risk without blocking its own attributable kingdom work', t => {
  const f = fixture(t); f.policy(); const observation = roleObservation(f)
  assert.equal(recordRoleUsage(f.store, f.kingdomId, observation), true)
  let view = readBudgetView(f.store, f.kingdomId)
  assert.equal(view.state, 'WARN'); assert.equal(view.pendingUnits, 1); assert.equal(view.reservedEstimateTokens, 100)
  assert.equal(view.unknownUnits, 0); assert.equal(view.attributionGapCount, 1)
  f.reserve()
  assert.equal(recordRoleUsage(f.store, f.kingdomId, { ...observation, observationSequence: 2, status: 'COMPLETE', reportedRequests: 1,
    usage: { uncachedInputTokens: 20, outputTokens: 10, totalTokens: 30 } }), true)
  view = readBudgetView(f.store, f.kingdomId)
  assert.equal(view.additionalVerifiedTokens, 30); assert.equal(view.workerVerifiedTokens, 0); assert.equal(view.reservedEstimateTokens, 100)
  assert.equal(readAdditionalRoleCost(f.store, f.kingdomId, 'task-1').verifiedTokens, null, 'unknown task attribution is never hard allocated')
})

test('observations preserve shared cost at kingdom scope and unavailable reports stay explicit', t => {
  const f = fixture(t); f.policy()
  const shared = roleObservation(f, { attribution: 'SHARED', taskIds: ['task-1', 'task-2'], status: 'COMPLETE', reportedRequests: 1,
    usage: { uncachedInputTokens: 10, cacheReadTokens: 15, cacheWriteTokens: 5, outputTokens: 10, reasoningTokens: 5, totalTokens: 40 } })
  assert.equal(recordRoleUsage(f.store, f.kingdomId, shared), true)
  assert.equal(recordRoleUsage(f.store, f.kingdomId, shared), true)
  assert.equal(readBudgetView(f.store, f.kingdomId).additionalVerifiedTokens, 40)
  assert.equal(readBudgetView(f.store, f.kingdomId).state, 'WARN')
  assert.equal(readAdditionalRoleCost(f.store, f.kingdomId, 'task-1').verifiedTokens, null)
  assert.equal(recordRoleUsage(f.store, f.kingdomId, roleObservation(f, { sourceUnitRef: 'missing-turn', status: 'UNAVAILABLE', reasonCode: 'MISSING' })), true)
  assert.equal(readBudgetView(f.store, f.kingdomId).state, 'BLOCK_UNKNOWN'); assert.equal(readBudgetView(f.store, f.kingdomId).unknownUnits, 1)
})

test('observations and admissions remain complete beyond GUI event limits', t => {
  const f = fixture(t); f.policy(); const handle = f.reserve()
  for (let i = 0; i < 260; i++) f.store.appendEvent({ event_id: `noise-${i}`, kingdom_id: f.kingdomId, event_type: 'UNRELATED_TEST',
    actor_role: null, actor_id: null, target_type: null, target_id: null, payload_json: '{}', created_at: now() })
  assert.equal(readBudgetView(f.store, f.kingdomId).reservedEstimateTokens, 100)
  assert.throws(() => f.reserve(), { code: 'BUDGET_ADMISSION_DUPLICATE' })
  assert.equal(cancelBudgetAdmissionIfSafe(f.store, handle), true)
  assert.equal(readBudgetView(f.store, f.kingdomId).reservedEstimateTokens, 0)
})

test('observations carry pre-policy admitted work through completion without resetting its accounting period', async t => {
  const f = fixture(t), handle = f.reserve(), g = await gateFixture(f), d = g.prepare(handle).intent.dispatch_id
  receipt(f, d)
  const first = f.policy()
  assert.equal(readBudgetView(f.store, f.kingdomId).reservedEstimateTokens, 100)
  terminal(f, d); usage(f, d, 45)
  f.policy({ enabled: false }); f.policy()
  const view = readBudgetView(f.store, f.kingdomId)
  assert.equal(view.workerVerifiedTokens, 45); assert.equal(view.reservedEstimateTokens, 0)
  assert.equal(view.policy!.sinceEventSeq, first.sinceEventSeq)
})

test('observations freeze incomplete pre-policy role sources and exclude earlier complete usage across off-on', t => {
  const f = fixture(t)
  const pending = roleObservation(f, { sourceUnitRef: 'carried-pending' })
  const unavailable = roleObservation(f, { sourceUnitRef: 'carried-unavailable', status: 'UNAVAILABLE', reasonCode: 'MISSING' })
  const historical = roleObservation(f, { sourceUnitRef: 'historical-complete', status: 'COMPLETE', reportedRequests: 1,
    usage: { uncachedInputTokens: 90, outputTokens: 10, totalTokens: 100 } })
  for (const observation of [pending, unavailable, historical]) assert.equal(recordRoleUsage(f.store, f.kingdomId, observation), true)
  const first = f.policy()
  let view = readBudgetView(f.store, f.kingdomId)
  assert.equal(view.pendingUnits, 1); assert.equal(view.unknownUnits, 1); assert.equal(view.reservedEstimateTokens, 100)
  assert.equal(view.additionalVerifiedTokens, 0); assert.equal(view.state, 'BLOCK_UNKNOWN')
  const firstStored = JSON.parse(f.store.listBudgetEvents(f.kingdomId).find(e => e.event_type === 'BUDGET_POLICY_UPDATED')!.payload_json)
  assert.deepEqual([...firstStored.carriedRoleSourceRefs].sort(), ['carried-pending', 'carried-unavailable'])
  for (const observation of [pending, unavailable]) assert.equal(recordRoleUsage(f.store, f.kingdomId, {
    ...observation, observationSequence: 2, status: 'COMPLETE', reasonCode: null, reportedRequests: 1,
    usage: { uncachedInputTokens: 15, outputTokens: 5, totalTokens: 20 },
  }), true)
  assert.equal(recordRoleUsage(f.store, f.kingdomId, historical), true)
  f.policy({ enabled: false }); const reopened = f.policy()
  view = readBudgetView(f.store, f.kingdomId)
  assert.equal(view.additionalVerifiedTokens, 40); assert.equal(view.pendingUnits, 0); assert.equal(view.unknownUnits, 0)
  assert.equal(reopened.sinceEventSeq, first.sinceEventSeq); assert.equal(reopened.budgetId, first.budgetId)
  assert.equal(Object.hasOwn(view.policy!, 'carriedRoleSourceRefs'), false, 'internal source identifiers stay outside the public policy')
  const lastStored = JSON.parse(f.store.listBudgetEvents(f.kingdomId).filter(e => e.event_type === 'BUDGET_POLICY_UPDATED').at(-1)!.payload_json)
  assert.deepEqual(lastStored.carriedRoleSourceRefs, firstStored.carriedRoleSourceRefs)
})

test('observations carry a pre-policy role identity gap once and preserve it across policy off-on', t => {
  const f = fixture(t)
  recordUsageCoverageGap(f.store, f.kingdomId, 'ambiguous-role-turn', 'ROLE_IDENTITY_AMBIGUOUS')
  recordUsageCoverageGap(f.store, f.kingdomId, 'ambiguous-role-turn', 'ROLE_IDENTITY_AMBIGUOUS')
  assert.equal(readBudgetView(f.store, f.kingdomId).unknownUnits, 1)
  const first = f.policy()
  let view = readBudgetView(f.store, f.kingdomId)
  assert.equal(view.unknownUnits, 1); assert.equal(view.state, 'BLOCK_UNKNOWN'); assert.equal(view.verifiedTokens, 0)
  assert.throws(() => f.reserve(), { code: 'BUDGET_UNKNOWN_USAGE' })
  f.policy({ enabled: false }); f.policy()
  view = readBudgetView(f.store, f.kingdomId)
  assert.equal(view.unknownUnits, 1); assert.equal(view.state, 'BLOCK_UNKNOWN')
  assert.equal(view.policy!.sinceEventSeq, first.sinceEventSeq)
})
