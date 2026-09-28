import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KingdomStore } from '../lib/core/db.js'
import { establishAffinity } from '../lib/core/governed.js'
import { initializeKingdomFacts } from '../lib/core/kingdom.js'
import { bindRole, rebindSession, setExecutionProfile, unbindRole } from '../lib/core/binding.js'
import { createTerritory, setTerritorySupervisor } from '../lib/core/territory.js'
import { issueOwnerControlCapability, issueOwnerOperationCapability, isOwnerControlCapability, ownerControlAuth } from '../lib/core/owner-control.js'
import { OwnerDecisionController, type OwnerDecisionInput, type OwnerDecisionControllerOptions, type OwnerOperationInput } from '../lib/core/owner-window.js'
import { proposeCollaborationPlan, readCollaborationPlan } from '../lib/core/collaboration.js'

const now = () => new Date().toISOString()
const emptyScope = () => ({ kingdomWide: false, territoryIds: [], bindingIds: [], roleTypes: [], targetSessionIds: [], workspaceRoots: [] })
const defaults: OwnerDecisionControllerOptions = {
  validateTargetSession: async () => ({ ok: true }), validateExecutionProfile: async () => ({ ok: true }),
  listTargetSessions: async ({ sessionIds }) => sessionIds.map(id => ({ id, label: id })),
}
function fixture(t: { after(fn: () => void): void }, options: Partial<OwnerDecisionControllerOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kingdom-owner-window-'))
  const outside = mkdtempSync(join(tmpdir(), 'kingdom-owner-outside-'))
  const store = new KingdomStore(':memory:')
  const initialized = store.withImmediateTransaction(() => initializeKingdomFacts(store, 'Test Kingdom', 'Human'))
  const kingdomId = initialized.kingdomId
  const capability = issueOwnerControlCapability(), auth = ownerControlAuth(capability)
  bindRole(store, { kingdomId, roleType: 'SUPERVISOR', roleName: 'Supervisor', sessionId: 'old-supervisor' }, auth)
  bindRole(store, { kingdomId, roleType: 'WORKER', roleName: 'Worker' }, auth)
  const supervisor = store.getBindingByRole(kingdomId, 'SUPERVISOR')!
  const worker = store.getBindingByRole(kingdomId, 'WORKER')!
  createTerritory(store, { kingdomId, name: 'Existing', workspacePath: root }, auth)
  const territory = store.listTerritories(kingdomId)[0]!
  setTerritorySupervisor(store, { kingdomId, territoryId: territory.territory_id, supervisorBindingId: supervisor.binding_id }, auth)
  const controller = new OwnerDecisionController(store, { ...defaults, ...options })
  const decision: OwnerDecisionInput = {
    kingdomId, actions: ['territory.create', 'territory.update', 'territory.supervisor', 'role.bind', 'role.session', 'ceiling', 'execution-profile'], ttlMs: 600000,
    scope: { kingdomWide: true, territoryIds: [territory.territory_id], bindingIds: [supervisor.binding_id, worker.binding_id],
      roleTypes: ['CHANCELLOR', 'SUPERVISOR', 'WORKER'], targetSessionIds: ['next-supervisor', 'new-chancellor'], workspaceRoots: [root] },
  }
  t.after(() => { controller.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) })
  const activate = (input: OwnerDecisionInput = decision) => controller.activate(capability, input).handle
  return { root, outside, store, kingdomId, supervisor, worker, territory, controller, decision, capability, auth, activate }
}
async function execute(f: ReturnType<typeof fixture>, handle: ReturnType<ReturnType<typeof fixture>['activate']>, input: OwnerOperationInput) {
  const preview = await f.controller.prepare(handle, input)
  return f.controller.commit(handle, { prepareId: preview.prepareId, operationId: preview.operationId })
}
function insertTask(f: ReturnType<typeof fixture>, taskId = 'task') {
  return f.store.insertTask({ task_id: taskId, territory_id: f.territory.territory_id, parent_task_id: null, title: taskId, description: null,
    assigned_binding_id: f.worker.binding_id, status: 'ASSIGNED', acceptance_criteria: null, result_summary: null, created_at: now(), updated_at: now() })
}

function proposedTeam(f: ReturnType<typeof fixture>) {
  bindRole(f.store, { kingdomId: f.kingdomId, roleType: 'CHANCELLOR', roleName: 'Planner', sessionId: 'planner' }, f.auth)
  bindRole(f.store, { kingdomId: f.kingdomId, roleType: 'WORKER', roleName: 'Expert' }, f.auth)
  const expert = f.store.getBindingsByRole(f.kingdomId, 'WORKER').find(row => row.binding_id !== f.worker.binding_id)!
  f.store.insertTask({ task_id: 'team-parent', territory_id: f.territory.territory_id, parent_task_id: null, title: 'Combined deliverable',
    description: 'Integrate evidence', assigned_binding_id: null, status: 'CREATED', acceptance_criteria: 'Verified result', result_summary: null, created_at: now(), updated_at: now() })
  const input = { parentTaskId: 'team-parent', mode: 'EXPERT' as const, reason: 'Independent read-only verification',
    integratorBindingId: f.worker.binding_id, budgetTokens: 10000, reserveTokens: 1000, items: [{ key: 'check', title: 'Check the source',
      description: 'Read scoped source only', acceptanceCriteria: 'Cite findings', territoryId: f.territory.territory_id,
      workerBindingId: expert.binding_id, access: 'READ_ONLY' as const, dependsOn: [], expectedArtifact: 'Findings report' }] }
  const ctx = { kingdomId: f.kingdomId, principal: { sessionId: 'planner' }, auth: { mode: 'session-bound' as const, trustLevel: 'session-verified' as const, note: 'fixture' } }
  const plan = proposeCollaborationPlan(f.store, ctx, input)
  f.decision.actions.push('plan.adopt'); f.decision.scope.bindingIds.push(expert.binding_id)
  return { plan, expert, input, ctx, operation: { action: 'plan.adopt' as const, parameters: { plan_id: plan.planId, version: plan.version, digest: plan.digest } } }
}

test('Owner plan adoption previews full scoped plan and atomically records one human receipt without assignments', async t => {
  const f = fixture(t), team = proposedTeam(f), handle = f.activate()
  assert.equal((await f.controller.catalog(handle)).plans?.[0]?.planId, team.plan.planId)
  const preview = await f.controller.prepare(handle, team.operation)
  const shown = JSON.stringify(preview.changes)
  for (const value of [team.plan.reason, team.plan.items[0]!.description, team.plan.items[0]!.acceptanceCriteria, team.plan.items[0]!.expectedArtifact, team.plan.digest]) assert.ok(shown.includes(value))
  const params = { prepareId: preview.prepareId, operationId: preview.operationId }
  const [first, second] = await Promise.all([f.controller.commit(handle, params), f.controller.commit(handle, params)])
  assert.deepEqual(first, second); assert.equal(first.target.type, 'collaboration-plan')
  assert.equal(readCollaborationPlan(f.store, f.kingdomId, team.plan.planId)!.state, 'ADOPTED')
  assert.equal(f.store.getTask(team.plan.childTaskIds[0]!)!.status, 'CREATED')
  assert.equal(f.store.getActiveAssignmentForTask(team.plan.childTaskIds[0]!), null)
  assert.equal(f.store.listEvents(f.kingdomId, 100).filter(e => e.event_type === 'COLLABORATION_PLAN_ADOPTED').length, 1)
})

test('Owner plan adoption rejects partial scope, changed proposal and revoked decision without children', async t => {
  const f = fixture(t), team = proposedTeam(f)
  const partial = structuredClone(f.decision); partial.scope.bindingIds = [f.worker.binding_id]
  const partialHandle = f.activate(partial)
  assert.deepEqual((await f.controller.catalog(partialHandle)).plans, [])
  await assert.rejects(f.controller.prepare(partialHandle, team.operation), { code: 'SCOPE_DENIED' })
  const handle = f.activate(), preview = await f.controller.prepare(handle, team.operation)
  proposeCollaborationPlan(f.store, team.ctx, { ...team.input, expectedVersion: 1, reason: 'Changed reason' })
  await assert.rejects(f.controller.commit(handle, { prepareId: preview.prepareId, operationId: preview.operationId }), { code: 'PLAN_VERSION_STALE' })
  f.controller.revoke(handle)
  assert.equal(f.store.listTasks(f.kingdomId).length, 1)
})

test('Owner plan adoption receipt failure rolls back all child facts and allows exact retry', async t => {
  const f = fixture(t), team = proposedTeam(f), handle = f.activate()
  const preview = await f.controller.prepare(handle, team.operation), params = { prepareId: preview.prepareId, operationId: preview.operationId }
  const append = f.store.appendEvent.bind(f.store)
  f.store.appendEvent = row => { if (row.event_type === 'OWNER_OPERATION_APPLIED') throw new Error('receipt fixture'); return append(row) }
  await assert.rejects(f.controller.commit(handle, params), /receipt fixture/)
  assert.equal(f.store.listTasks(f.kingdomId).length, 1)
  assert.equal(readCollaborationPlan(f.store, f.kingdomId, team.plan.planId)!.state, 'PROPOSED')
  f.store.appendEvent = append
  assert.equal((await f.controller.commit(handle, params)).status, 'APPLIED')
})
function insertExecution(f: ReturnType<typeof fixture>, state: string, taskId = 'task', sessionId = 'worker-session') {
  return f.store.insertExecution({ execution_id: `execution-${taskId}`, task_id: taskId, attempt_no: 1, worker_binding_id: f.worker.binding_id,
    session_id: sessionId, state, detail: null, started_at: now(), heartbeat_at: null, ended_at: null, pause_requested_at: null,
    executor_kind: 'legacy', provider: null, provider_source: null, requested_model: null, resolved_model: null, model_source: null,
    execution_profile_json: null, execution_contract: 'LEGACY_COMPAT', lease_id: null, capability_decision_id: null })
}

test('Owner GUI complete management chain records stable human actor, exact sources and durable receipts', async t => {
  const f = fixture(t), handle = f.activate()
  const operations: OwnerOperationInput[] = [
    { action: 'territory.create', parameters: { name: 'New', workspace_path: f.root, summary: 'Scope' } },
    { action: 'territory.update', parameters: { territory_id: f.territory.territory_id, name: 'Renamed', summary: 'Updated' } },
    { action: 'territory.supervisor', parameters: { territory_id: f.territory.territory_id, supervisor_binding_id: f.supervisor.binding_id } },
    { action: 'role.bind', parameters: { role_type: 'CHANCELLOR', role_name: 'Chancellor', session_id: 'new-chancellor' } },
    { action: 'role.bind', parameters: { role_type: 'WORKER', role_name: 'New Worker' } },
    { action: 'role.session', parameters: { binding_id: f.supervisor.binding_id, session_id: 'next-supervisor' } },
    { action: 'ceiling', parameters: { ceiling: { 'tool:read': true, 'tool:write': false } } },
    { action: 'execution-profile', parameters: { binding_id: f.worker.binding_id, profile: { provider: 'llm-provider', model: 'requested-model' } } },
  ]
  for (const input of operations) {
    const result = await execute(f, handle, input)
    assert.equal(result.status, 'APPLIED')
    assert.deepEqual(f.controller.receipt(handle, result.operationId), result)
    const event = f.store.listEvents(f.kingdomId, 100).find(e => e.seq === result.receiptSeq)!
    const payload = JSON.parse(event.payload_json)
    assert.equal(payload.receiptSeq, result.receiptSeq)
    assert.equal(event.actor_role, 'OWNER'); assert.equal(event.actor_id, f.store.getDefaultKingdom()!.owner_id)
    assert.equal(payload.source_channel, 'LOCAL_OWNER_GUI'); assert.equal(payload.authorization_source, 'LOCAL_DIRECT_SLASH')
    const business = f.store.listEvents(f.kingdomId, 100).find(e => e.seq < result.receiptSeq && JSON.parse(e.payload_json).operation_id === result.operationId)!
    assert.equal(business.actor_role, 'OWNER'); assert.equal(business.actor_id, result.ownerId)
    assert.equal(JSON.parse(business.payload_json).decision_id, result.decisionId)
  }
  assert.equal(f.store.getBindingByRole(f.kingdomId, 'OWNER')!.session_id, null)
  assert.equal(f.store.getBindingById(f.supervisor.binding_id)!.session_id, 'next-supervisor')
  assert.equal(f.store.getBindingById(f.worker.binding_id)!.execution_profile_json, '{"provider":"llm-provider","model":"requested-model"}')
  assert.equal(f.store.listUnsettledOwnerExecutions(f.kingdomId).length, 0)
})

test('Catalog and authority are fully scoped; exposed JSON/handle copies do not grant authority', async t => {
  const f = fixture(t, { listTargetSessions: async () => [{ id: 'next-supervisor', label: 'Allowed' }, { id: 'secret-session', label: 'Must not leak' }] })
  const decision = structuredClone(f.decision)
  decision.scope.bindingIds = [f.supervisor.binding_id]; decision.scope.roleTypes = ['SUPERVISOR']
  const handle = f.activate(decision)
  decision.scope.bindingIds.push(f.worker.binding_id)
  const view = f.controller.inspect(handle)!; view.scope.bindingIds.push(f.worker.binding_id); view.actions.push('init')
  const catalog = await f.controller.catalog(handle)
  assert.deepEqual(catalog.bindings.map(x => x.id), [f.supervisor.binding_id])
  assert.deepEqual(catalog.runtimeSessions, [{ id: 'next-supervisor', label: 'Allowed' }])
  assert.equal(f.controller.inspect({ ...handle } as never), null)
  assert.throws(() => f.controller.activate({ ...f.capability } as never, f.decision), /OWNER|可信/)
  await assert.rejects(f.controller.prepare(handle, { action: 'execution-profile', parameters: { binding_id: f.worker.binding_id, profile: { model: 'm' } } }), { code: 'SCOPE_DENIED' })
  await assert.rejects(f.controller.prepare(handle, { action: 'territory.create', parameters: { name: 'No', workspace_path: f.outside } }), { code: 'SCOPE_DENIED' })
  await assert.rejects(f.controller.prepare(handle, { action: 'ceiling', parameters: { ceiling: {}, actor_id: 'forged' } } as never), { code: 'INVALID_INPUT' })
})

test('One-operation Core capability requires instance identity, realm, exact action and complete parameters', t => {
  const f = fixture(t)
  const input = { kingdomId: f.kingdomId, bindingId: f.supervisor.binding_id, sessionId: 'next-supervisor' }
  const narrow = issueOwnerOperationCapability(f.capability, f.store, f.kingdomId, { operation: 'role.session', input },
    { source_channel: 'LOCAL_OWNER_GUI', authorization_source: 'LOCAL_DIRECT_SLASH', decision_id: 'd', operation_id: 'op' })
  const auth = ownerControlAuth(narrow)
  assert.equal(isOwnerControlCapability(narrow), false)
  assert.match(setExecutionProfile(f.store, { kingdomId: f.kingdomId, bindingId: f.supervisor.binding_id, profile: { model: 'x' } }, auth), /MISMATCH/)
  assert.match(rebindSession(f.store, { ...input, sessionId: 'forged' }, auth), /MISMATCH/)
  assert.match(rebindSession(f.store, { ...input, modelName: 'smuggled' }, auth), /MISMATCH/)
  const second = new KingdomStore(':memory:')
  try {
    second.insertKingdom({ kingdom_id: f.kingdomId, owner_id: f.store.getDefaultKingdom()!.owner_id, name: 'Other', owner_name: 'Human', created_at: now() })
    assert.match(rebindSession(second, input, auth), /MISMATCH/)
  } finally { second.close() }
  assert.match(rebindSession(f.store, input, auth), /已更新/)
  assert.match(rebindSession(f.store, input, auth), /OWNER_CONTROL_REQUIRED/)
  assert.equal(f.store.getBindingById(f.supervisor.binding_id)!.session_id, 'next-supervisor')
})

test('Prepare copies parameters and ignores unrelated events while related object changes invalidate preview', async t => {
  const f = fixture(t), handle = f.activate()
  const input: OwnerOperationInput = { action: 'execution-profile', parameters: { binding_id: f.worker.binding_id, profile: { model: 'chosen' } } }
  const preview = await f.controller.prepare(handle, input)
  input.parameters.profile!.model = 'tampered'
  f.store.appendEvent({ event_id: 'unrelated', kingdom_id: f.kingdomId, event_type: 'UNRELATED', actor_role: null, actor_id: null, target_type: null, target_id: null, payload_json: '{}', created_at: now() })
  await f.controller.commit(handle, { prepareId: preview.prepareId, operationId: preview.operationId })
  assert.equal(f.store.getBindingById(f.worker.binding_id)!.execution_profile_json, '{"model":"chosen"}')
  const stale = await f.controller.prepare(handle, { action: 'territory.update', parameters: { territory_id: f.territory.territory_id, name: 'Preview' } })
  f.store.updateTerritoryMetadata(f.territory.territory_id, 'Changed elsewhere', null)
  await assert.rejects(f.controller.commit(handle, { prepareId: stale.prepareId, operationId: stale.operationId }), { code: 'PREVIEW_STALE' })
  assert.equal(f.store.getTerritoryById(f.territory.territory_id)!.name, 'Changed elsewhere')
})

test('Concurrent identical commits, lost response and post-revoke receipt read perform exactly one mutation', async t => {
  const f = fixture(t), handle = f.activate()
  const p = await f.controller.prepare(handle, { action: 'role.bind', parameters: { role_type: 'WORKER', role_name: 'Once' } })
  const input = { prepareId: p.prepareId, operationId: p.operationId }
  const [a, b] = await Promise.all([f.controller.commit(handle, input), f.controller.commit(handle, input)])
  assert.deepEqual(a, b)
  const revision = f.store.revision(f.kingdomId)
  assert.deepEqual(await f.controller.commit(handle, input), a)
  assert.equal(f.store.revision(f.kingdomId), revision)
  await assert.rejects(f.controller.commit(handle, { ...input, operationId: 'another' }), { code: 'OPERATION_MISMATCH' })
  f.controller.revoke(handle)
  assert.deepEqual(f.controller.receipt(handle, p.operationId), a)
  assert.deepEqual(await f.controller.commit(handle, input), a)
  assert.equal(f.store.getBindingsByRole(f.kingdomId, 'WORKER').filter(b => b.role_name === 'Once').length, 1)
})

test('Receipt write failure rolls back the business object and business event', async t => {
  const f = fixture(t), handle = f.activate()
  const p = await f.controller.prepare(handle, { action: 'territory.create', parameters: { name: 'Rollback', workspace_path: f.root } })
  const revision = f.store.revision(f.kingdomId), append = f.store.appendEvent.bind(f.store)
  f.store.appendEvent = row => { if (row.event_type === 'OWNER_OPERATION_APPLIED') throw new Error('receipt storage failure'); return append(row) }
  await assert.rejects(f.controller.commit(handle, { prepareId: p.prepareId, operationId: p.operationId }), /receipt storage failure/)
  assert.equal(f.store.getTerritoryByName(f.kingdomId, 'Rollback'), null)
  assert.equal(f.store.revision(f.kingdomId), revision)
  assert.equal(f.controller.receipt(handle, p.operationId), null)
  f.store.appendEvent = append
  const receipt = await f.controller.commit(handle, { prepareId: p.prepareId, operationId: p.operationId })
  assert.equal(receipt.status, 'APPLIED')
})

test('Expiry, replacement and disposal invalidate writing without altering completed receipts', async t => {
  let time = Date.now()
  const f = fixture(t, { now: () => time })
  const handle = f.activate({ ...f.decision, ttlMs: 10 })
  const p = await f.controller.prepare(handle, { action: 'ceiling', parameters: { ceiling: {} } })
  time += 10
  await assert.rejects(f.controller.commit(handle, { prepareId: p.prepareId, operationId: p.operationId }), { code: 'OWNER_DECISION_EXPIRED' })
  assert.equal(f.controller.inspect(handle)!.state, 'EXPIRED')
  assert.equal(f.controller.revoke(handle).state, 'EXPIRED')
  const second = f.activate(), third = f.activate()
  assert.equal(f.controller.inspect(second)!.state, 'REVOKED')
  f.controller.dispose()
  assert.equal(f.controller.inspect(third)!.state, 'REVOKED')
  assert.throws(() => f.activate(), { code: 'CONTROLLER_DISPOSED' })
})

test('Revoke interrupts validation that ignores AbortSignal and prevents writes', async t => {
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const f = fixture(t, { validateTargetSession: async () => { started(); return new Promise(() => {}) } })
  const handle = f.activate()
  const pending = f.controller.prepare(handle, { action: 'role.session', parameters: { binding_id: f.supervisor.binding_id, session_id: 'next-supervisor' } })
  await ready
  f.controller.revoke(handle)
  await assert.rejects(pending, { code: 'OWNER_DECISION_REVOKED' })
  assert.equal(f.store.getBindingById(f.supervisor.binding_id)!.session_id, 'old-supervisor')
})

test('Commit revalidates registry, abort and current objects after every asynchronous boundary', async t => {
  let calls = 0
  const f = fixture(t, { validateTargetSession: async () => ++calls === 1 ? { ok: true } : { ok: false, code: 'SESSION_GONE', message: 'Session 已离开 registry' } })
  const handle = f.activate()
  const p = await f.controller.prepare(handle, { action: 'role.session', parameters: { binding_id: f.supervisor.binding_id, session_id: 'next-supervisor' } })
  await assert.rejects(f.controller.commit(handle, { prepareId: p.prepareId, operationId: p.operationId }), { code: 'SESSION_GONE' })
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(f.controller.prepare(handle, { action: 'ceiling', parameters: { ceiling: {} } }, { signal: aborted.signal }), { code: 'REQUEST_ABORTED' })
  assert.equal(f.store.getBindingById(f.supervisor.binding_id)!.session_id, 'old-supervisor')
})

test('Bounded validation timeout never leaves an operation in progress or writes facts', async t => {
  const f = fixture(t, { validationTimeoutMs: 10, validateExecutionProfile: async () => new Promise(() => {}) }), handle = f.activate()
  await assert.rejects(f.controller.prepare(handle, { action: 'execution-profile', parameters: { binding_id: f.worker.binding_id, profile: { model: 'm' } } }), { code: 'VALIDATION_TIMEOUT' })
  assert.equal(f.store.getBindingById(f.worker.binding_id)!.execution_profile_json, null)
})

for (const state of ['RUNNING', 'RECOVERING']) test(`${state} execution blocks ceiling, supervisor and profile changes; metadata remains safe`, async t => {
  const f = fixture(t), handle = f.activate()
  insertTask(f); insertExecution(f, state)
  for (const input of [
    { action: 'ceiling', parameters: { ceiling: {} } },
    { action: 'territory.supervisor', parameters: { territory_id: f.territory.territory_id, supervisor_binding_id: f.supervisor.binding_id } },
    { action: 'role.session', parameters: { binding_id: f.supervisor.binding_id, session_id: 'next-supervisor' } },
    { action: 'execution-profile', parameters: { binding_id: f.worker.binding_id, profile: { model: 'm' } } },
  ] as OwnerOperationInput[]) await assert.rejects(f.controller.prepare(handle, input), { code: 'UNSETTLED_EXECUTION' })
  await execute(f, handle, { action: 'territory.update', parameters: { territory_id: f.territory.territory_id, summary: 'Metadata remains safe' } })
  assert.equal(f.store.getTask('task')!.status, 'ASSIGNED')
  assert.equal(f.store.getExecution(`execution-task`)!.state, state)
})

test('An older unreleased Lease blocks topology even when the newest execution is terminal', async t => {
  const f = fixture(t), handle = f.activate(); insertTask(f); insertExecution(f, 'COMPLETED')
  f.store.insertExecution({ ...f.store.getExecution('execution-task')!, execution_id: 'newest-terminal', attempt_no: 3 })
  establishAffinity(f.store, { kingdomId: f.kingdomId, workerBindingId: f.worker.binding_id, territoryId: f.territory.territory_id,
    session: { runtimeType: 'dsh', runtimeInstanceRef: 'instance', sessionRef: 'old-session' } })
  f.store.insertLease({ lease_id: 'old-lease', kingdom_id: f.kingdomId, worker_binding_id: f.worker.binding_id, runtime_type: 'dsh', runtime_instance_ref: 'instance',
    session_ref: 'old-session', territory_id: f.territory.territory_id, task_id: 'task', attempt_no: 2, state: 'ACQUIRED', capability_decision_id: null,
    enforcement_plan_snapshot: null, release_evidence_json: null, release_reason: null, acquired_at: now(), released_at: null, updated_at: now() })
  await assert.rejects(f.controller.prepare(handle, { action: 'role.session', parameters: { binding_id: f.supervisor.binding_id, session_id: 'next-supervisor' } }), { code: 'UNSETTLED_LEASE' })
  assert.equal(f.store.getLease('old-lease')!.state, 'ACQUIRED')
  assert.equal(f.store.listExecutions('task').at(-1)!.attempt_no, 3)
})

test('A target Session active elsewhere blocks binding even outside the authorized territory', async t => {
  const f = fixture(t), handle = f.activate()
  createTerritory(f.store, { kingdomId: f.kingdomId, name: 'Other' }, f.auth)
  const other = f.store.getTerritoryByName(f.kingdomId, 'Other')!
  insertTask(f)
  f.store.db.prepare('UPDATE tasks SET territory_id = ? WHERE task_id = ?').run(other.territory_id, 'task')
  insertExecution(f, 'RUNNING', 'task', 'new-chancellor')
  await assert.rejects(f.controller.prepare(handle, { action: 'role.bind', parameters: { role_type: 'CHANCELLOR', role_name: 'C', session_id: 'new-chancellor' } }), { code: 'UNSETTLED_EXECUTION' })
})

test('Path normalization rejects network, nonexistent and junction escape paths', async t => {
  const f = fixture(t), handle = f.activate()
  const escaped = join(f.root, 'escape'); symlinkSync(f.outside, escaped, 'junction')
  for (const path of ['\\\\server\\share', join(f.root, 'missing'), escaped, f.outside]) {
    await assert.rejects(f.controller.prepare(handle, { action: 'territory.create', parameters: { name: 'Invalid', workspace_path: path } }), error => ['INVALID_PATH', 'SCOPE_DENIED'].includes((error as { code: string }).code))
  }
  mkdirSync(join(f.root, 'allowed'))
  const receipt = await execute(f, handle, { action: 'territory.create', parameters: { name: 'Allowed', workspace_path: join(f.root, 'allowed', '..', 'allowed') } })
  assert.equal(f.store.getTerritoryById(receipt.target.id)!.workspace_path, realpathSync.native(join(f.root, 'allowed')))
  unlinkSync(escaped)
})

test('Strict inputs reject authority fields, Worker Session migration, empty model and arbitrary provider options', async t => {
  const f = fixture(t), handle = f.activate()
  for (const input of [
    { action: 'role.bind', parameters: { role_type: 'OWNER', role_name: 'Fake' } },
    { action: 'role.bind', parameters: { role_type: 'WORKER', role_name: 'W', session_id: 'next-supervisor' } },
    { action: 'role.session', parameters: { binding_id: f.worker.binding_id, session_id: 'next-supervisor' } },
    { action: 'execution-profile', parameters: { binding_id: f.worker.binding_id, profile: { model: '' } } },
    { action: 'execution-profile', parameters: { binding_id: f.worker.binding_id, profile: { model: 'm', temperature: 1 } } },
    { action: 'territory.update', parameters: { territory_id: f.territory.territory_id, workspace_path: f.root } },
    { action: 'ceiling', parameters: { ceiling: { 'tool:x': 'true' } } },
  ]) await assert.rejects(f.controller.prepare(handle, input as never))
})

test('Bootstrap is one-shot, atomic, concurrent-safe and does not promote to an ordinary management window', async t => {
  const store = new KingdomStore(':memory:')
  const a = new OwnerDecisionController(store, defaults), b = new OwnerDecisionController(store, defaults)
  t.after(() => { a.dispose(); b.dispose(); store.close() })
  const input: OwnerDecisionInput = { kingdomId: null, actions: ['init'], scope: emptyScope(), ttlMs: 10000 }
  const ha = a.activate(issueOwnerControlCapability(), input).handle, hb = b.activate(issueOwnerControlCapability(), input).handle
  const operation: OwnerOperationInput = { action: 'init', parameters: { kingdom_name: 'Boot', owner_name: 'Human' } }
  const pa = await a.prepare(ha, operation), pb = await b.prepare(hb, operation)
  const results = await Promise.allSettled([
    a.commit(ha, { prepareId: pa.prepareId, operationId: pa.operationId }), b.commit(hb, { prepareId: pb.prepareId, operationId: pb.operationId }),
  ])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(store.listKingdoms().length, 1)
  const kingdom = store.getDefaultKingdom()!, owner = store.getBindingByRole(kingdom.kingdom_id, 'OWNER')!
  assert.equal(owner.session_id, null); assert.equal(owner.principal_id, kingdom.owner_id)
  assert.equal(a.inspect(ha)!.state, 'CONSUMED')
  assert.equal(a.revoke(ha).state, 'CONSUMED')
  await assert.rejects(a.prepare(ha, { action: 'ceiling', parameters: { ceiling: {} } }))
  assert.deepEqual(await a.commit(ha, { prepareId: pa.prepareId, operationId: pa.operationId }), a.receipt(ha, pa.operationId))
  assert.equal(store.listEvents(kingdom.kingdom_id, 10).filter(e => e.event_type === 'OWNER_DECISION_CONSUMED').length, 1)
})

test('Missing OWNER binding still records stable principal; historical direct events stay direct', async t => {
  const f = fixture(t)
  const initial = f.store.listEvents(f.kingdomId, 100).map(row => ({ id: row.event_id, payload: row.payload_json }))
  f.store.deleteBinding(f.store.getBindingByRole(f.kingdomId, 'OWNER')!.binding_id)
  const handle = f.activate()
  const receipt = await execute(f, handle, { action: 'ceiling', parameters: { ceiling: { read: true } } })
  const event = f.store.listEvents(f.kingdomId, 10).find(e => e.event_type === 'CAPABILITY_CEILING_UPDATED')!
  assert.equal(event.actor_role, 'OWNER'); assert.equal(event.actor_id, receipt.ownerId)
  for (const old of initial) assert.equal(f.store.getEventById(old.id)!.payload_json, old.payload)
})

test('Preview shows individual readable fields and an exact permission decrease', async t => {
  const f = fixture(t), handle = f.activate()
  const p = await f.controller.prepare(handle, { action: 'territory.update', parameters: { territory_id: f.territory.territory_id, name: 'Readable', summary: 'Description' } })
  assert.deepEqual(p.changes, [
    { label: '领地名称', before: 'Existing', after: 'Readable' }, { label: '领地说明', before: null, after: 'Description' },
  ])
  f.store.setKingdomCapabilityCeiling(f.kingdomId, '{"tool:read":true,"tool:write":true}')
  const ceiling = await f.controller.prepare(handle, { action: 'ceiling', parameters: { ceiling: { 'tool:read': true } } })
  assert.deepEqual(ceiling.changes.find(c => c.label === '能力 tool:write'), { label: '能力 tool:write', before: '允许', after: '未配置（不授予）' })
})

test('A newly running execution after preview blocks commit; namespace conflict cannot duplicate a resource', async t => {
  const f = fixture(t), handle = f.activate()
  const p = await f.controller.prepare(handle, { action: 'ceiling', parameters: { ceiling: { read: true } } })
  insertTask(f); insertExecution(f, 'RUNNING')
  await assert.rejects(f.controller.commit(handle, { prepareId: p.prepareId, operationId: p.operationId }), { code: 'UNSETTLED_EXECUTION' })
  assert.equal(f.store.getKingdomCapabilityCeiling(f.kingdomId), null)
  const create = await f.controller.prepare(handle, { action: 'territory.create', parameters: { name: 'Conflict', workspace_path: f.root } })
  createTerritory(f.store, { kingdomId: f.kingdomId, name: 'Conflict', workspacePath: f.root }, f.auth)
  await assert.rejects(f.controller.commit(handle, { prepareId: create.prepareId, operationId: create.operationId }), { code: 'NAME_CONFLICT' })
  assert.equal(f.store.listTerritories(f.kingdomId).filter(row => row.name === 'Conflict').length, 1)
})

test('Restart does not restore historical decisions as write authority', async t => {
  const f = fixture(t), handle = f.activate()
  const applied = await execute(f, handle, { action: 'ceiling', parameters: { ceiling: {} } })
  f.controller.dispose()
  const restarted = new OwnerDecisionController(f.store, defaults)
  try {
    assert.equal(restarted.inspect(handle), null)
    await assert.rejects(restarted.commit(handle, { prepareId: applied.prepareId, operationId: applied.operationId }), { code: 'OWNER_DECISION_REQUIRED' })
    assert.ok(f.store.listEvents(f.kingdomId, 10).some(row => row.event_type === 'OWNER_OPERATION_APPLIED'))
  } finally { restarted.dispose() }
})

test('Retiring a Supervisor releases its territory in the same transaction, while unsettled work still blocks the successor', async t => {
  const f = fixture(t)
  // v3.2.0（Owner D1）：退任与「解除该席位在领地上的主理关系」同一事务完成，
  // 不会留下指向 RETIRED 席位的悬挂引用。
  unbindRole(f.store, { kingdomId: f.kingdomId, bindingId: f.supervisor.binding_id, reason: 'Term ended' }, f.auth)
  assert.equal(f.store.getBindingById(f.supervisor.binding_id)!.status, 'RETIRED')
  assert.equal(f.store.getTerritoryById(f.territory.territory_id)!.supervisor_binding_id, null,
    'the territory is released together with the retirement')
  const releaseEvents = f.store.listEvents(f.kingdomId, 200)
    .filter(event => event.event_type === 'TERRITORY_SUPERVISOR_UPDATED')
    .filter(event => JSON.parse(event.payload_json).unassigned === true)
  assert.equal(releaseEvents.length, 1, 'the release is recorded as its own fact')

  bindRole(f.store, { kingdomId: f.kingdomId, roleType: 'SUPERVISOR', roleName: 'Successor', sessionId: 'successor-session' }, f.auth)
  const successor = f.store.getBindingByRole(f.kingdomId, 'SUPERVISOR')!
  const decision = structuredClone(f.decision)
  decision.scope.bindingIds = [f.worker.binding_id, successor.binding_id]
  const handle = f.activate(decision)
  const input: OwnerOperationInput = { action: 'territory.supervisor', parameters: { territory_id: f.territory.territory_id, supervisor_binding_id: successor.binding_id } }
  const preview = await f.controller.prepare(handle, input)
  assert.equal(preview.changes[0].before, null, 'the released territory has no incumbent to describe')
  assert.match(preview.changes[0].after!, /Successor/)
  insertTask(f); const execution = insertExecution(f, 'RUNNING', 'task', 'old-supervisor')
  await assert.rejects(f.controller.commit(handle, { prepareId: preview.prepareId, operationId: preview.operationId }), { code: 'UNSETTLED_EXECUTION' })
  f.store.transitionExecution(execution, 'COMPLETED')
  const result = await execute(f, handle, input)
  assert.equal(result.status, 'APPLIED')
  assert.equal(f.store.getTerritoryById(f.territory.territory_id)!.supervisor_binding_id, successor.binding_id)
  assert.equal(f.store.getBindingById(f.supervisor.binding_id)!.status, 'RETIRED')
})

test('An ACTIVE incumbent is never silently replaced, while a legacy pointer to a RETIRED seat can be repaired', async t => {
  const f = fixture(t)
  const incumbent = f.supervisor
  // 挑战者必须在激活窗口之前就存在并进入授权范围（窗口不对候选做隐式放行）。
  bindRole(f.store, { kingdomId: f.kingdomId, roleType: 'SUPERVISOR', roleName: 'Challenger', sessionId: 'challenger-session' }, f.auth)
  const challenger = f.store.getBindingsByRole(f.kingdomId, 'SUPERVISOR').find(binding => binding.role_name === 'Challenger')!
  const decision = structuredClone(f.decision)
  decision.scope.bindingIds = [f.worker.binding_id, incumbent.binding_id, challenger.binding_id]
  const handle = f.activate(decision)

  // (a) 在任主理仍在岗：改派被拒（先解除再指派），库里没有发生任何变化。
  const rejected = await f.controller.prepare(handle, {
    action: 'territory.supervisor', parameters: { territory_id: f.territory.territory_id, supervisor_binding_id: challenger.binding_id },
  }).then(() => null, (error: { code?: string }) => error.code)
  assert.equal(rejected, 'TERRITORY_ALREADY_SUPERVISED')
  assert.equal(f.store.getTerritoryById(f.territory.territory_id)!.supervisor_binding_id, incumbent.binding_id)

  // (b) 遗留悬挂引用（3.2.0 之前的库：席位已 RETIRED，领地指针仍指向它）可以直接改派——
  // 这是修复而不是替换，但在任主管的未结算工作仍受 unsettled 守卫约束。
  unbindRole(f.store, { kingdomId: f.kingdomId, bindingId: incumbent.binding_id, reason: 'Term ended' }, f.auth)
  // 用底层写入复现旧库的悬挂引用（新链路不会产生这种状态）。
  f.store.updateTerritorySupervisor(f.territory.territory_id, incumbent.binding_id)
  const input: OwnerOperationInput = { action: 'territory.supervisor', parameters: { territory_id: f.territory.territory_id, supervisor_binding_id: challenger.binding_id } }
  const preview = await f.controller.prepare(handle, input)
  assert.ok(preview.affected.bindingIds.includes(incumbent.binding_id), 'the historical relationship is still resolved exactly')
  assert.match(preview.changes[0].before!, /Supervisor/)
  const result = await execute(f, handle, input)
  assert.equal(result.status, 'APPLIED')
  assert.equal(f.store.getTerritoryById(f.territory.territory_id)!.supervisor_binding_id, challenger.binding_id)
  assert.equal(f.store.getBindingById(incumbent.binding_id)!.status, 'RETIRED')
})

test('The Owner window can release an incumbent supervisor, and unsettled work still blocks the release', async t => {
  const f = fixture(t)
  const decision = structuredClone(f.decision)
  const handle = f.activate(decision)
  const release: OwnerOperationInput = {
    action: 'territory.supervisor', parameters: { territory_id: f.territory.territory_id, supervisor_binding_id: null },
  }

  // 预览：写清后果（解除 → fail-closed），并把现任主理及其 session 作为相关事实登记。
  const preview = await f.controller.prepare(handle, release)
  assert.equal(preview.changes[0].before, `${f.supervisor.role_name}（${f.supervisor.binding_id}）`)
  assert.equal(preview.changes[0].after, null)
  assert.match(preview.changes[1]!.after!, /fail-closed/u)
  assert.ok(preview.affected.bindingIds.includes(f.supervisor.binding_id))

  // 在途工作时不允许解除责任；完成后才放行。
  insertTask(f); const execution = insertExecution(f, 'RUNNING', 'task', 'old-supervisor')
  await assert.rejects(f.controller.commit(handle, { prepareId: preview.prepareId, operationId: preview.operationId }), { code: 'UNSETTLED_EXECUTION' })
  f.store.transitionExecution(execution, 'COMPLETED')
  const released = await execute(f, handle, release)
  assert.equal(released.status, 'APPLIED')
  assert.equal(f.store.getTerritoryById(f.territory.territory_id)!.supervisor_binding_id, null)
  // 解除是一条明确事实（不是静默删除）：席位仍在，领地明确回到「无主理」。
  assert.equal(f.store.getBindingById(f.supervisor.binding_id)!.status, 'ACTIVE')
  const releaseEvents = f.store.listEvents(f.kingdomId, 100).filter(event => event.event_type === 'TERRITORY_SUPERVISOR_UPDATED')
    .filter(event => JSON.parse(event.payload_json).unassigned === true)
  assert.equal(releaseEvents.length, 1)

  // 再一次解除：仍然 APPLIED、指针保持 null（结论可重复），但它**不是** no-op 去重——
  // 与 direct Slash 通道自 3.1.0 起的既有语义一致，每次都会追加一条 unassigned:true 的解除事实。
  const again = await execute(f, handle, release)
  assert.equal(again.status, 'APPLIED')
  assert.equal(f.store.getTerritoryById(f.territory.territory_id)!.supervisor_binding_id, null)
  const releaseEventsAfterRepeat = f.store.listEvents(f.kingdomId, 100)
    .filter(event => event.event_type === 'TERRITORY_SUPERVISOR_UPDATED')
    .filter(event => JSON.parse(event.payload_json).unassigned === true)
  assert.equal(releaseEventsAfterRepeat.length, 2, '重复解除会追加一条事实，而不是被静默去重')
})

test('The Owner window rejects a release request that omits the field or targets a foreign territory', async t => {
  const f = fixture(t)
  const handle = f.activate()
  // 缺失 supervisor_binding_id 与 null 不是同一件事：前者是输入错误，不会被当成"解除"。
  await assert.rejects(f.controller.prepare(handle, {
    action: 'territory.supervisor', parameters: { territory_id: f.territory.territory_id },
  } as never), { code: 'INVALID_INPUT' })
  // 范围外的领地仍然不可解除（范围判据未因新增的解除语义而放宽）。
  await assert.rejects(f.controller.prepare(handle, {
    action: 'territory.supervisor', parameters: { territory_id: 'not-in-scope', supervisor_binding_id: null },
  }), { code: 'SCOPE_DENIED' })
  assert.equal(f.store.getTerritoryById(f.territory.territory_id)!.supervisor_binding_id, f.supervisor.binding_id)
})
