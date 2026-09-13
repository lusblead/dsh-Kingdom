import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { establishAffinity, acquireExecutionLease, setLeasePlan, advanceLeaseState, recordCapabilityDecision, bindCapabilityDecision, prepareGovernedDispatch } from '../lib/core/governed.js'
import { reserveWorkspaceAdmission, finishWorkspaceAdmissionInvocation } from '../lib/core/workspace-admission.js'
import { KingdomStore } from '../lib/core/db.js'
import { initializeKingdomFacts } from '../lib/core/kingdom.js'
import { bindRole } from '../lib/core/binding.js'
import { issueOwnerControlCapability, issueOwnerOperationCapability, ownerControlAuth } from '../lib/core/owner-control.js'
import { assignTask, reviewTask, type CommandContext } from '../lib/core/task-service.js'
import { proposeCollaborationPlan, readCollaborationPlan, listCollaborationPlans, normalizePlanAdoptionParameters,
  adoptCollaborationPlan, readCollaborationReadiness, validateCollaborationHandoffs, readPlanBudgetView,
  type ProposeCollaborationPlanInput, type CollaborationPlanView } from '../lib/core/collaboration.js'
import { reserveBudgetAdmission, cancelBudgetAdmissionIfSafe, finishBudgetAdmissionInvocation, type BudgetAdmissionHandle } from '../lib/core/budget.js'
import { recordRoleUsage, recordUsageCoverageGap, type RoleUsageObservation } from '../lib/core/cost.js'

const now = () => new Date().toISOString()
function fixture(t: { after(fn: () => void): void }) {
  const store = new KingdomStore(':memory:')
  const { kingdomId } = store.withImmediateTransaction(() => initializeKingdomFacts(store, 'Team', 'Human'))
  const capability = issueOwnerControlCapability(), auth = ownerControlAuth(capability)
  bindRole(store, { kingdomId, roleType: 'CHANCELLOR', roleName: 'C', sessionId: 'chancellor-session' }, auth)
  bindRole(store, { kingdomId, roleType: 'SUPERVISOR', roleName: 'S', sessionId: 'supervisor-session' }, auth)
  for (const name of ['Integrator', 'Expert one', 'Expert two']) bindRole(store, { kingdomId, roleType: 'WORKER', roleName: name }, auth)
  const chancellor = store.getBindingByRole(kingdomId, 'CHANCELLOR')!.binding_id
  const supervisor = store.getBindingByRole(kingdomId, 'SUPERVISOR')!.binding_id
  const workers = store.getBindingsByRole(kingdomId, 'WORKER').map(row => row.binding_id)
  const territoryId = 'territory', parentTaskId = 'parent'
  store.insertTerritory({ territory_id: territoryId, kingdom_id: kingdomId, name: 'Workspace', workspace_path: 'C:/team-fixture', summary: null,
    supervisor_binding_id: supervisor, status: 'ACTIVE', deleted_at: null, deleted_reason: null, created_at: now() })
  store.insertTask({ task_id: parentTaskId, territory_id: territoryId, parent_task_id: null, title: 'Integrated result', description: 'The parent result',
    assigned_binding_id: null, status: 'CREATED', acceptance_criteria: 'All acceptance criteria', result_summary: null, created_at: now(), updated_at: now() })
  const context = (sessionId: string): CommandContext => ({ kingdomId, principal: { sessionId }, auth: { mode: 'session-bound', trustLevel: 'session-verified', note: 'test' } })
  const ctx = context('chancellor-session'), sup = context('supervisor-session')
  const input: ProposeCollaborationPlanInput = { parentTaskId, mode: 'TEAM', reason: 'Two independent scopes and one integration result', integratorBindingId: workers[0]!,
    budgetTokens: 1000, reserveTokens: 100, items: [
      { key: 'first', title: 'First work', description: 'First exact scope', acceptanceCriteria: 'First evidence', territoryId,
        workerBindingId: workers[1]!, access: 'READ_ONLY', dependsOn: [], expectedArtifact: 'first-report' },
      { key: 'second', title: 'Second work', description: 'Second exact scope', acceptanceCriteria: 'Second evidence', territoryId,
        workerBindingId: workers[2]!, access: 'WRITE', dependsOn: ['first'], expectedArtifact: 'second-report' },
    ] }
  const propose = (changes: Partial<ProposeCollaborationPlanInput> = {}) => proposeCollaborationPlan(store, ctx, { ...structuredClone(input), ...changes })
  const adopt = (plan: CollaborationPlanView) => adoptCollaborationPlan(store, { kingdomId, plan_id: plan.planId, version: plan.version, digest: plan.digest }, auth)
  const handles: BudgetAdmissionHandle[] = []
  const reserve = (taskId: string, workerBindingId: string) => { const h = reserveBudgetAdmission(store, { kingdomId, taskId, workerBindingId, attemptNo: 1 }); handles.push(h); return h }
  t.after(() => { handles.forEach(finishBudgetAdmissionInvocation); store.close() })
  return { store, kingdomId, capability, auth, chancellor, supervisor, workers, territoryId, parentTaskId, input, ctx, sup, context, propose, adopt, reserve }
}
type Fixture = ReturnType<typeof fixture>
function completeClaim(f: Fixture, taskId: string, worker: string, decision: 'ACCEPT' | 'FAIL' | 'REWORK' | null = 'ACCEPT', summary = 'Verified fixture result', outcome = 'COMPLETED') {
  const assigned = assignTask(f.store, f.sup, { taskId, workerBindingId: worker })
  assert.equal(assigned.ok, true)
  const task = f.store.transitionTask(f.store.getTask(taskId)!, 'RUNNING')
  const execution = f.store.insertExecution({ execution_id: randomUUID(), task_id: taskId, attempt_no: 1, worker_binding_id: worker, session_id: `session-${worker}`,
    state: 'STARTING', detail: null, started_at: now(), heartbeat_at: null, ended_at: null, pause_requested_at: null, executor_kind: 'legacy', provider: null,
    provider_source: null, requested_model: null, resolved_model: null, model_source: null, execution_profile_json: null,
    execution_contract: 'LEGACY_COMPAT', lease_id: null, capability_decision_id: null })
  const running = f.store.transitionExecution(execution, 'RUNNING')
  f.store.transitionExecution(running, outcome as 'COMPLETED' | 'FAILED' | 'ABORTED')
  const resultId = randomUUID()
  f.store.insertWorkerResult({ result_id: resultId, task_id: taskId, attempt_no: 1, worker_binding_id: worker, session_id: `session-${worker}`,
    outcome, result_json: JSON.stringify({ outcome, summary, artifacts: ['artifact-a', 'artifact-b'] }), created_at: now() })
  f.store.transitionTask(task, 'REVIEW', { result_summary: summary })
  if (decision) assert.equal(reviewTask(f.store, f.sup, { taskId, decision, reason: 'Fixture review' }).ok, true)
  return resultId
}
function role(f: Fixture, overrides: Partial<RoleUsageObservation> = {}): RoleUsageObservation {
  return { type: 'KingdomRoleUsage/v1', source: 'provider-reported', sourceUnitRef: 'supervisor-turn', runtimeInstanceRef: 'runtime', sessionRef: 'supervisor-session',
    bindingId: f.supervisor, roleType: 'SUPERVISOR', taskIds: [], attribution: 'UNATTRIBUTED', startedAt: now(), startedLedgerSeq: f.store.eventSequence(),
    observationSequence: 1, status: 'IN_PROGRESS', reasonCode: null, observedRequests: 1, reportedRequests: 0, usage: null, ...overrides }
}

test('proposal requires the actual Chancellor and creates no child Task before adoption', t => {
  const f = fixture(t), before = f.store.eventSequence()
  assert.throws(() => proposeCollaborationPlan(f.store, f.context('worker-session'), f.input), { code: 'UNAUTHORIZED_PRINCIPAL' })
  assert.equal(f.store.eventSequence(), before); assert.equal(f.store.listTasks(f.kingdomId).length, 1)
  const plan = f.propose()
  assert.equal(plan.state, 'PROPOSED'); assert.equal(plan.version, 1); assert.equal(plan.proposedBy, f.chancellor)
  assert.equal(plan.childTaskIds.length, 2); assert.equal(new Set(plan.childTaskIds).size, 2)
  assert.equal(f.store.listTasks(f.kingdomId).length, 1)
  assert.equal(readPlanBudgetView(f.store, f.kingdomId, plan.planId), null)
  assert.equal(readCollaborationReadiness(f.store, f.kingdomId, f.parentTaskId)!.reasonCode, 'PLAN_NOT_ADOPTED')
  plan.items[0]!.title = 'Mutated external copy'
  assert.equal(readCollaborationPlan(f.store, f.kingdomId, plan.planId)!.items[0]!.title, f.input.items[0]!.title)
})

test('proposal rejects recursive parents, duplicate members, extra fields and cyclic or foreign dependencies without writes', t => {
  const f = fixture(t)
  const invalid: ProposeCollaborationPlanInput[] = [
    { ...f.input, items: [...f.input.items, { ...f.input.items[0]!, key: 'third' }] },
    { ...f.input, integratorBindingId: f.input.items[0]!.workerBindingId },
    { ...f.input, items: f.input.items.map(item => ({ ...item, workerBindingId: f.workers[1]! })) },
    { ...f.input, mode: 'EXPERT' },
    { ...f.input, reserveTokens: 1001 },
    { ...f.input, items: [{ ...f.input.items[0]!, dependsOn: ['first'] }] },
    { ...f.input, items: f.input.items.map(item => ({ ...item, dependsOn: [item.key === 'first' ? 'second' : 'first'] })) },
    { ...f.input, items: [{ ...f.input.items[0]!, dependsOn: ['outside'] }] },
    { ...f.input, items: [{ ...f.input.items[0]!, workerBindingId: f.supervisor }] },
    { ...f.input, items: [{ ...f.input.items[0]!, territoryId: 'missing' }] },
  ]
  const before = f.store.eventSequence()
  for (const value of invalid) assert.throws(() => proposeCollaborationPlan(f.store, f.ctx, value))
  assert.throws(() => proposeCollaborationPlan(f.store, f.ctx, { ...f.input, ownerId: 'forged' } as never))
  assert.equal(f.store.eventSequence(), before)
  const plan = f.propose(); f.adopt(plan)
  assert.throws(() => f.propose({ parentTaskId: plan.childTaskIds[0]! }), { code: 'PLAN_PARENT_INVALID' })
  assert.equal(f.store.listTasks(f.kingdomId).length, 3)
})

test('proposal revisions require the exact baseline and adoption rejects replaced versions', t => {
  const f = fixture(t), first = f.propose()
  const before = f.store.eventSequence()
  assert.throws(() => f.propose({ reason: 'Lost update' }), { code: 'PLAN_VERSION_STALE' })
  assert.equal(f.store.eventSequence(), before)
  const second = f.propose({ expectedVersion: first.version, reason: 'Reviewed changed scope' })
  assert.equal(second.planId, first.planId); assert.equal(second.version, 2); assert.notEqual(second.digest, first.digest)
  assert.equal(listCollaborationPlans(f.store, f.kingdomId).length, 1)
  assert.throws(() => f.adopt(first), { code: 'PLAN_VERSION_STALE' })
  assert.equal(f.store.listTasks(f.kingdomId).length, 1)
  f.adopt(second)
  assert.throws(() => f.propose({ expectedVersion: 2 }), { code: 'PLAN_ALREADY_ADOPTED' })
})

test('adoption requires exact Owner capability and preserves separate proposal provenance without assignment or Grant', t => {
  const f = fixture(t), plan = f.propose()
  const input = { kingdomId: f.kingdomId, plan_id: plan.planId, version: plan.version, digest: plan.digest }
  assert.match(adoptCollaborationPlan(f.store, input), /OWNER_CONTROL_REQUIRED/)
  const narrow = issueOwnerOperationCapability(f.capability, f.store, f.kingdomId, { operation: 'plan.adopt', input },
    { source_channel: 'LOCAL_OWNER_GUI', authorization_source: 'LOCAL_DIRECT_SLASH', decision_id: 'window', operation_id: 'adopt-op' })
  assert.match(adoptCollaborationPlan(f.store, { ...input, version: 2 }, ownerControlAuth(narrow)), /MISMATCH/)
  assert.equal(f.store.listTasks(f.kingdomId).length, 1)
  assert.match(adoptCollaborationPlan(f.store, input, ownerControlAuth(narrow)), /已按准确版本采纳/)
  for (const item of plan.items) {
    const child = f.store.getTask(item.taskId)!
    assert.equal(child.parent_task_id, f.parentTaskId); assert.equal(child.status, 'CREATED'); assert.equal(child.assigned_binding_id, null)
    assert.equal(f.store.getActiveAssignmentForTask(item.taskId), null); assert.equal(f.store.listExecutions(item.taskId).length, 0)
    const created = f.store.listEvents(f.kingdomId, 100).find(event => event.event_type === 'COLLABORATION_CHILD_CREATED' && event.target_id === item.taskId)!
    assert.equal(created.actor_role, 'SYSTEM'); assert.equal(JSON.parse(created.payload_json).proposedBy, f.chancellor)
    assert.equal(JSON.parse(created.payload_json).operation_id, 'adopt-op')
  }
  const applied = f.store.listEvents(f.kingdomId, 100).find(event => event.event_type === 'COLLABORATION_PLAN_ADOPTED')!
  assert.equal(applied.actor_role, 'OWNER'); assert.equal(JSON.parse(applied.payload_json).operation_id, 'adopt-op')
  const before = f.store.eventSequence()
  assert.throws(() => f.adopt(plan), { code: 'PLAN_ALREADY_ADOPTED' })
  assert.equal(f.store.eventSequence(), before); assert.equal(f.store.listTasks(f.kingdomId).length, 3)
  assert.throws(() => normalizePlanAdoptionParameters({ plan_id: plan.planId, version: 1, digest: plan.digest, owner: true }))
})

test('adoption rechecks current parent role and territory facts and atomically rolls back children on event failure', t => {
  const f = fixture(t), plan = f.propose()
  f.store.db.prepare('UPDATE territories SET workspace_path = ? WHERE territory_id = ?').run('C:/changed', f.territoryId)
  assert.equal(readCollaborationPlan(f.store, f.kingdomId, plan.planId)!.state, 'STALE')
  assert.throws(() => f.adopt(plan), { code: 'PLAN_CONTEXT_STALE' })
  assert.equal(f.store.listTasks(f.kingdomId).length, 1)
  const fresh = f.propose({ expectedVersion: 1 })
  const append = f.store.appendEvent.bind(f.store), before = f.store.eventSequence()
  f.store.appendEvent = event => { if (event.event_type === 'COLLABORATION_PLAN_ADOPTED') throw new Error('adopt write fault'); return append(event) }
  assert.throws(() => f.adopt(fresh), /adopt write fault/)
  assert.equal(f.store.listTasks(f.kingdomId).length, 1); assert.equal(f.store.eventSequence(), before)
  f.store.appendEvent = append
  f.adopt(fresh)
  assert.equal(readCollaborationPlan(f.store, f.kingdomId, fresh.planId)!.state, 'ADOPTED')
})

test('readiness requires latest exact attempt result and Supervisor ACCEPT while child completion never completes parent integration', t => {
  const f = fixture(t), plan = f.propose(); f.adopt(plan)
  assert.equal(readCollaborationReadiness(f.store, f.kingdomId, plan.items[0]!.taskId)!.ready, true)
  assert.equal(readCollaborationReadiness(f.store, f.kingdomId, plan.items[1]!.taskId)!.reasonCode, 'DEPENDENCY_NOT_ACCEPTED_OR_STALE')
  completeClaim(f, plan.items[0]!.taskId, plan.items[0]!.workerBindingId, null)
  assert.equal(readCollaborationReadiness(f.store, f.kingdomId, plan.items[1]!.taskId)!.ready, false, 'Worker Claim alone cannot satisfy a dependency')
  assert.equal(reviewTask(f.store, f.sup, { taskId: plan.items[0]!.taskId, decision: 'ACCEPT' }).ok, true)
  const ready = readCollaborationReadiness(f.store, f.kingdomId, plan.items[1]!.taskId)!
  assert.equal(ready.ready, true); assert.equal(ready.handoffs.length, 1); assert.equal(ready.handoffs[0]!.attemptNo, 1)
  assert.equal(ready.handoffs[0]!.resultId, f.store.latestWorkerResult(plan.items[0]!.taskId)!.result_id)
  assert.equal(validateCollaborationHandoffs(f.store, f.kingdomId, ready.taskId, ready.handoffs), true)
  completeClaim(f, plan.items[1]!.taskId, plan.items[1]!.workerBindingId)
  assert.equal(f.store.getTask(f.parentTaskId)!.status, 'CREATED')
  const integration = readCollaborationReadiness(f.store, f.kingdomId, f.parentTaskId)!
  assert.equal(integration.kind, 'INTEGRATION'); assert.equal(integration.workerBindingId, f.input.integratorBindingId)
  assert.equal(integration.ready, true); assert.equal(integration.handoffs.length, 2)
  completeClaim(f, f.parentTaskId, f.input.integratorBindingId, null)
  assert.equal(f.store.getTask(f.parentTaskId)!.status, 'REVIEW')
  assert.equal(reviewTask(f.store, f.sup, { taskId: f.parentTaskId, decision: 'ACCEPT' }).ok, true)
  assert.equal(f.store.getTask(f.parentTaskId)!.status, 'DONE')
})

test('handoff rejects altered references and stale attempts while bounding untrusted summaries and artifact lists', t => {
  const f = fixture(t), plan = f.propose(); f.adopt(plan)
  const source = plan.items[0]!, target = plan.items[1]!
  completeClaim(f, source.taskId, source.workerBindingId, 'ACCEPT', 'x'.repeat(5000))
  const handoff = readCollaborationReadiness(f.store, f.kingdomId, target.taskId)!.handoffs
  assert.equal(handoff[0]!.summary.length, 2000)
  assert.equal(validateCollaborationHandoffs(f.store, f.kingdomId, target.taskId, [{ ...handoff[0]!, resultId: 'forged' }]), false)
  const original = f.store.latestWorkerResult(source.taskId)!
  f.store.db.prepare('UPDATE worker_results SET result_json = ? WHERE result_id = ?').run('{"outcome":"COMPLETED","summary":"mutated after ACCEPT"}', original.result_id)
  assert.equal(readCollaborationReadiness(f.store, f.kingdomId, target.taskId)!.ready, false, 'ACCEPT binds the exact reviewed result digest')
  f.store.db.prepare('UPDATE worker_results SET result_json = ? WHERE result_id = ?').run(original.result_json, original.result_id)
  f.store.insertWorkerResult({ ...f.store.latestWorkerResult(source.taskId)!, result_id: randomUUID(), attempt_no: 2, created_at: now() })
  assert.equal(validateCollaborationHandoffs(f.store, f.kingdomId, target.taskId, handoff), false)
  assert.equal(readCollaborationReadiness(f.store, f.kingdomId, target.taskId)!.reasonCode, 'DEPENDENCY_NOT_ACCEPTED_OR_STALE')
})

test('readiness stops new independent work after member failure and rejects changed plan assignments', t => {
  const f = fixture(t), plan = f.propose({ items: f.input.items.map(item => ({ ...item, dependsOn: [] })) }); f.adopt(plan)
  completeClaim(f, plan.items[0]!.taskId, plan.items[0]!.workerBindingId, 'FAIL')
  const blocked = readCollaborationReadiness(f.store, f.kingdomId, plan.items[1]!.taskId)!
  assert.equal(blocked.ready, false); assert.equal(blocked.reasonCode, 'PLAN_MEMBER_FAILED_OR_UNKNOWN')
  assert.equal(f.store.getTask(f.parentTaskId)!.status, 'CREATED')
  f.store.transitionTask(f.store.getTask(plan.items[1]!.taskId)!, 'ASSIGNED', { assigned_binding_id: f.workers[0]! })
  assert.equal(readCollaborationReadiness(f.store, f.kingdomId, plan.items[1]!.taskId)!.reasonCode, 'PLAN_MEMBER_CHANGED')
})

test('adopted plan member HANDOFF is rejected atomically and leaves the plan usable', t => {
  const f = fixture(t), plan = f.propose(); f.adopt(plan)
  const item = plan.items[0]!
  completeClaim(f, item.taskId, item.workerBindingId, null)
  const task = f.store.getTask(item.taskId), assignment = f.store.getActiveAssignmentForTask(item.taskId), seq = f.store.eventSequence()
  const result = reviewTask(f.store, f.sup, { taskId: item.taskId, decision: 'HANDOFF', reason: 'Use another worker', to_binding_id: f.workers[0]! })
  assert.equal(result.ok, false); assert.match(result.message, /固定执行者/)
  assert.deepEqual(f.store.getTask(item.taskId), task); assert.deepEqual(f.store.getActiveAssignmentForTask(item.taskId), assignment)
  assert.equal(f.store.eventSequence(), seq)
  assert.equal(reviewTask(f.store, f.sup, { taskId: item.taskId, decision: 'REWORK', reason: 'Fix original scope' }).ok, true)
  assert.equal(readCollaborationReadiness(f.store, f.kingdomId, item.taskId)!.ready, true)
})

test('failed plan member retry requires exact settled REWORK and cannot release sibling work', t => {
  for (const outcome of ['FAILED', 'ABORTED']) {
    const f = fixture(t), plan = f.propose({ items: f.input.items.map(item => ({ ...item, dependsOn: [] })) }); f.adopt(plan)
    const item = plan.items[0]!, sibling = plan.items[1]!
    completeClaim(f, item.taskId, item.workerBindingId, null, 'Attempt failed', outcome)
    assert.equal(readCollaborationReadiness(f.store, f.kingdomId, item.taskId)!.ready, false)
    assert.equal(reviewTask(f.store, f.sup, { taskId: item.taskId, decision: 'REWORK', reason: 'Retry settled failure' }).ok, true)
    assert.equal(readCollaborationReadiness(f.store, f.kingdomId, item.taskId)!.ready, true)
    assert.equal(readCollaborationReadiness(f.store, f.kingdomId, sibling.taskId)!.reasonCode, 'PLAN_MEMBER_FAILED_OR_UNKNOWN')
    const claim = f.store.latestWorkerResult(item.taskId)!
    f.store.db.prepare('UPDATE worker_results SET result_json = ? WHERE result_id = ?').run('{"summary":"Changed after review"}', claim.result_id)
    assert.equal(readCollaborationReadiness(f.store, f.kingdomId, item.taskId)!.ready, false)
    f.store.db.prepare('UPDATE worker_results SET result_json = ? WHERE result_id = ?').run(claim.result_json, claim.result_id)
    const execution = f.store.latestExecution(item.taskId)!
    f.store.insertExecution({ ...execution, execution_id: randomUUID(), attempt_no: 2, state: outcome })
    assert.equal(readCollaborationReadiness(f.store, f.kingdomId, item.taskId)!.ready, false, 'old REWORK does not authorize a different attempt')
  }
})

test('two explicitly reworked settled failures can recover serially without mutual deadlock', t => {
  const f = fixture(t), plan = f.propose({ items: f.input.items.map(item => ({ ...item, dependsOn: [] })) }); f.adopt(plan)
  for (const item of plan.items) completeClaim(f, item.taskId, item.workerBindingId, 'REWORK', 'Retry each exact failure', 'FAILED')
  for (const item of plan.items) assert.equal(readCollaborationReadiness(f.store, f.kingdomId, item.taskId)!.ready, true)
  assert.equal(readCollaborationReadiness(f.store, f.kingdomId, f.parentTaskId)!.ready, false)
})

test('failed REWORK crosses real TX3 with only its exact new preparation Lease excluded', t => {
  for (const outcome of ['FAILED', 'ABORTED']) {
    const f = fixture(t), plan = f.propose(); f.adopt(plan)
    const item = plan.items[0]!
    completeClaim(f, item.taskId, item.workerBindingId, 'REWORK', 'Retry exact failure', outcome)
    const collaboration = readCollaborationReadiness(f.store, f.kingdomId, item.taskId)!
    assert.equal(collaboration.ready, true)
    const input = { kingdomId: f.kingdomId, taskId: item.taskId, attemptNo: 2, workerBindingId: item.workerBindingId }
    const workspaceAdmission = reserveWorkspaceAdmission(f.store, { ...input, workspacePath: 'C:/team-fixture', access: 'READ_ONLY' })
    const budgetAdmission = reserveBudgetAdmission(f.store, input)
    t.after(() => { finishWorkspaceAdmissionInvocation(workspaceAdmission); finishBudgetAdmissionInvocation(budgetAdmission) })
    const session = { runtimeType: 'dsh', runtimeInstanceRef: 'retry-test', sessionRef: randomUUID() }
    establishAffinity(f.store, { kingdomId: f.kingdomId, workerBindingId: item.workerBindingId, territoryId: f.territoryId, session })
    const lease = acquireExecutionLease(f.store, { ...input, territoryId: f.territoryId, session })
    assert.equal(readCollaborationReadiness(f.store, f.kingdomId, item.taskId)!.ready, false)
    setLeasePlan(f.store, lease.lease_id, JSON.stringify({ type: 'DshEnforcementPlan/v1', payload: { sandboxMode: 'read-only' } }))
    advanceLeaseState(f.store, lease.lease_id, 'PREPARING'); advanceLeaseState(f.store, lease.lease_id, 'MATERIALIZING')
    const decision = recordCapabilityDecision(f.store, { ...input, decision: 'GRANTED', enforcementStatus: 'ENFORCED', enforcementEvidenceJson: '{"fixture":true}' })
    bindCapabilityDecision(f.store, lease.lease_id, decision.decision_id); advanceLeaseState(f.store, lease.lease_id, 'DISPATCH_READY')
    assert.equal(readCollaborationReadiness(f.store, f.kingdomId, item.taskId, lease.lease_id)!.ready, false, 'ordinary reads cannot exclude a held Lease')
    f.store.withImmediateTransaction(() => {
      assert.equal(readCollaborationReadiness(f.store, f.kingdomId, item.taskId, 'wrong-lease')!.ready, false)
      assert.equal(readCollaborationReadiness(f.store, f.kingdomId, item.taskId, lease.lease_id)!.ready, true)
    })
    const prepared = prepareGovernedDispatch(f.store, { ...input, leaseId: lease.lease_id, capabilityDecisionId: decision.decision_id, session,
      requestSnapshot: '{}', inputRefJson: '{}', payloadHash: 'test', workspaceAdmission, budgetAdmission, collaboration })
    assert.equal(prepared.execution.attempt_no, 2); assert.equal(f.store.listDispatchesForTaskAttempt(item.taskId, 2).length, 1)
  }
})

test('budget includes exact member reservations, cancels only unused risk and never resets on reread', t => {
  const f = fixture(t), plan = f.propose({ budgetTokens: 100 }); f.adopt(plan)
  const member = plan.items[0]!
  assert.equal(assignTask(f.store, f.sup, { taskId: member.taskId, workerBindingId: member.workerBindingId }).ok, true)
  const handle = f.reserve(member.taskId, member.workerBindingId)
  let view = readPlanBudgetView(f.store, f.kingdomId, plan.planId)!
  assert.equal(view.reservedEstimateTokens, 100); assert.equal(view.pendingUnits, 1); assert.equal(view.state, 'BLOCK_LIMIT')
  assert.equal(view.amount, null); assert.equal(view.scope, 'PLAN_WITH_KINGDOM_COORDINATION_UPPER_BOUND')
  assert.deepEqual(readPlanBudgetView(f.store, f.kingdomId, plan.planId), view)
  assert.equal(cancelBudgetAdmissionIfSafe(f.store, handle), true)
  view = readPlanBudgetView(f.store, f.kingdomId, plan.planId)!
  assert.equal(view.reservedEstimateTokens, 0); assert.equal(view.state, 'ALLOW')
})

test('budget carries pending coordination and missing coverage conservatively without allocating an exact team bill', t => {
  const f = fixture(t), pending = role(f), historical = role(f, { sourceUnitRef: 'old-complete', status: 'COMPLETE', reportedRequests: 1,
    usage: { uncachedInputTokens: 900, outputTokens: 10, totalTokens: 910 } })
  assert.equal(recordRoleUsage(f.store, f.kingdomId, pending), true); assert.equal(recordRoleUsage(f.store, f.kingdomId, historical), true)
  const plan = f.propose(); f.adopt(plan)
  let view = readPlanBudgetView(f.store, f.kingdomId, plan.planId)!
  assert.equal(view.coordinationUpperBoundTokens, 0); assert.equal(view.reservedEstimateTokens, 100)
  assert.equal(view.unknownUnits, 0); assert.equal(view.attributionGapCount, 1)
  assert.equal(recordRoleUsage(f.store, f.kingdomId, { ...pending, observationSequence: 2, status: 'COMPLETE', reportedRequests: 1,
    usage: { uncachedInputTokens: 20, outputTokens: 10, totalTokens: 30 } }), true)
  const unrelated = role(f, { sourceUnitRef: 'other-team-turn', status: 'COMPLETE', reportedRequests: 1,
    usage: { uncachedInputTokens: 50, outputTokens: 10, totalTokens: 60 } })
  assert.equal(recordRoleUsage(f.store, f.kingdomId, unrelated), true)
  view = readPlanBudgetView(f.store, f.kingdomId, plan.planId)!
  assert.equal(view.coordinationUpperBoundTokens, 90); assert.equal(view.workerVerifiedTokens, 0); assert.equal(view.reservedEstimateTokens, 0)
  recordUsageCoverageGap(f.store, f.kingdomId, 'unknown-coordination', 'ROLE_IDENTITY_AMBIGUOUS')
  assert.equal(readPlanBudgetView(f.store, f.kingdomId, plan.planId)!.state, 'BLOCK_UNKNOWN')
})

test('budget treats a member Execution without Dispatch metering as unknown rather than free', t => {
  const f = fixture(t), plan = f.propose(); f.adopt(plan)
  completeClaim(f, plan.items[0]!.taskId, plan.items[0]!.workerBindingId)
  const view = readPlanBudgetView(f.store, f.kingdomId, plan.planId)!
  assert.equal(view.workerVerifiedTokens, 0); assert.equal(view.unknownUnits, 1)
  assert.equal(view.reservedEstimateTokens, 100); assert.equal(view.state, 'BLOCK_UNKNOWN')
})

test('budget preserves a finished invocation reservation as unknown instead of restoring historical liveness', t => {
  const f = fixture(t), plan = f.propose(); f.adopt(plan)
  const member = plan.items[0]!
  assert.equal(assignTask(f.store, f.sup, { taskId: member.taskId, workerBindingId: member.workerBindingId }).ok, true)
  const handle = f.reserve(member.taskId, member.workerBindingId)
  assert.equal(readPlanBudgetView(f.store, f.kingdomId, plan.planId)!.unknownUnits, 0)
  finishBudgetAdmissionInvocation(handle)
  const view = readPlanBudgetView(f.store, f.kingdomId, plan.planId)!
  assert.equal(view.reservedEstimateTokens, 100); assert.equal(view.unknownUnits, 1); assert.equal(view.state, 'BLOCK_UNKNOWN')
})
