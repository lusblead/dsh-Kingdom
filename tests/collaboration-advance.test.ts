import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { KingdomStore } from '../lib/core/db.js'
import { initializeKingdomFacts } from '../lib/core/kingdom.js'
import { bindRole } from '../lib/core/binding.js'
import { issueOwnerControlCapability, ownerControlAuth } from '../lib/core/owner-control.js'
import { assignTask, reviewTask, type CommandContext } from '../lib/core/task-service.js'
import { proposeCollaborationPlan, adoptCollaborationPlan } from '../lib/core/collaboration.js'
import { reserveBudgetAdmission, finishBudgetAdmissionInvocation } from '../lib/core/budget.js'
import { advanceCollaboration, type AdvanceCollaborationInput, type CollaborationStartInput, type CollaborationStartResult } from '../lib/worker/collaboration.js'

const now = () => new Date().toISOString()
function fixture(t: { after(fn: () => void): void }, options: { adopted?: boolean; otherSupervisor?: boolean } = {}) {
  const store = new KingdomStore(':memory:')
  const { kingdomId } = store.withImmediateTransaction(() => initializeKingdomFacts(store, 'Advance', 'Human'))
  const auth = ownerControlAuth(issueOwnerControlCapability())
  bindRole(store, { kingdomId, roleType: 'CHANCELLOR', roleName: 'C', sessionId: 'c-session' }, auth)
  bindRole(store, { kingdomId, roleType: 'SUPERVISOR', roleName: 'S', sessionId: 's-session' }, auth)
  const supervisor = store.getBindingByRole(kingdomId, 'SUPERVISOR')!.binding_id
  for (const name of ['I', 'A', 'B']) bindRole(store, { kingdomId, roleType: 'WORKER', roleName: name }, auth)
  const workers = store.getBindingsByRole(kingdomId, 'WORKER').map(row => row.binding_id)
  const context = (sessionId: string): CommandContext => ({ kingdomId, principal: { sessionId }, auth: { mode: 'session-bound', trustLevel: 'session-verified', note: 'test' } })
  const addTerritory = (id: string, sup: string) => store.insertTerritory({ territory_id: id, kingdom_id: kingdomId, name: id, workspace_path: `C:/advance-${id}`,
    summary: null, supervisor_binding_id: sup, status: 'ACTIVE', deleted_at: null, deleted_reason: null, created_at: now() })
  addTerritory('primary', supervisor)
  if (options.otherSupervisor) {
    bindRole(store, { kingdomId, roleType: 'SUPERVISOR', roleName: 'Other', sessionId: 'other-session' }, auth)
    addTerritory('secondary', store.getBindingsByRole(kingdomId, 'SUPERVISOR').find(row => row.session_id === 'other-session')!.binding_id)
  }
  store.insertTask({ task_id: 'parent', territory_id: 'primary', parent_task_id: null, title: 'Integration', description: 'Combine the results',
    assigned_binding_id: null, status: 'CREATED', acceptance_criteria: 'Check complete result', result_summary: null, created_at: now(), updated_at: now() })
  const plan = proposeCollaborationPlan(store, context('c-session'), { parentTaskId: 'parent', mode: 'EXPERT', reason: 'Two independent expert checks',
    integratorBindingId: workers[0]!, budgetTokens: 1000, reserveTokens: 100, items: [
      { key: 'a', title: 'Expert A', description: 'First scope', acceptanceCriteria: 'First report', territoryId: 'primary', workerBindingId: workers[1]!,
        access: 'READ_ONLY', dependsOn: [], expectedArtifact: 'report-a' },
      { key: 'b', title: 'Expert B', description: 'Second scope', acceptanceCriteria: 'Second report', territoryId: options.otherSupervisor ? 'secondary' : 'primary',
        workerBindingId: workers[2]!, access: 'READ_ONLY', dependsOn: [], expectedArtifact: 'report-b' },
    ] })
  if (options.adopted !== false) adoptCollaborationPlan(store, { kingdomId, plan_id: plan.planId, version: plan.version, digest: plan.digest }, auth)
  const input = (strategy: 'SERIAL' | 'PARALLEL' = 'PARALLEL'): AdvanceCollaborationInput => ({ planId: plan.planId, version: plan.version, digest: plan.digest, strategy,
    items: plan.items.slice(0, strategy === 'SERIAL' ? 1 : 2).map(item => ({ taskId: item.taskId, grant: { 'tool:read': true, 'tool:write': false } })) })
  t.after(() => store.close())
  return { store, kingdomId, auth, plan, workers, context, supervisor, input }
}
type Fixture = ReturnType<typeof fixture>
function reworkFixture(f: Fixture, emitRework: boolean, outcome = 'COMPLETED') {
  const member = f.plan.items[0]!
  assignTask(f.store, f.context('s-session'), { taskId: member.taskId, workerBindingId: member.workerBindingId })
  let task = f.store.transitionTask(f.store.getTask(member.taskId)!, 'RUNNING')
  f.store.insertExecution({ execution_id: randomUUID(), task_id: member.taskId, attempt_no: 1, worker_binding_id: member.workerBindingId, session_id: 'worker-session',
    state: outcome, detail: null, started_at: now(), heartbeat_at: null, ended_at: now(), pause_requested_at: null, executor_kind: 'legacy', provider: null,
    provider_source: null, requested_model: null, resolved_model: null, model_source: null, execution_profile_json: null,
    execution_contract: 'LEGACY_COMPAT', lease_id: null, capability_decision_id: null })
  f.store.insertWorkerResult({ result_id: randomUUID(), task_id: member.taskId, attempt_no: 1, worker_binding_id: member.workerBindingId, session_id: 'worker-session',
    outcome, result_json: JSON.stringify({ outcome, summary: 'First attempt' }), created_at: now() })
  if (emitRework) {
    task = f.store.transitionTask(task, 'REVIEW')
    assert.equal(reviewTask(f.store, f.context('s-session'), { taskId: member.taskId, decision: 'REWORK', reason: 'Fix exact issue' }).ok, true)
  }
}

test('advance retries only the explicitly reworked failed member once', async t => {
  for (const outcome of ['FAILED', 'ABORTED']) {
    const f = fixture(t); reworkFixture(f, true, outcome)
    const requests: string[] = []
    const start = async (input: CollaborationStartInput) => { requests.push(input.taskId); return { ok: true, message: 'retry callback' } }
    const sibling = { ...f.input('SERIAL'), items: [f.input().items[1]!] }
    assert.equal((await advanceCollaboration(f.store, () => f.context('s-session'), sibling, start)).ok, false)
    assert.equal(requests.length, 0)
    assert.equal((await advanceCollaboration(f.store, () => f.context('s-session'), f.input('SERIAL'), start)).ok, true)
    assert.deepEqual(requests, [f.plan.items[0]!.taskId])
  }
})

test('advance requires exact adopted plan and current session-bound Supervisor before any assignment', async t => {
  const f = fixture(t), called: string[] = []
  const start = async (input: CollaborationStartInput) => { called.push(input.taskId); return { ok: true, message: 'test callback' } }
  for (const context of [null, f.context('c-session'), { ...f.context('s-session'), auth: { mode: 'declarative' as const, trustLevel: 'local-demo' as const, note: 'test' } }]) {
    const result = await advanceCollaboration(f.store, () => context, f.input(), start)
    assert.equal(result.ok, false)
  }
  assert.equal((await advanceCollaboration(f.store, () => f.context('s-session'), { ...f.input(), version: 2 }, start)).reasonCode, 'ADVANCE_PLAN_STALE')
  assert.equal(called.length, 0)
  for (const item of f.plan.items) assert.equal(f.store.getTask(item.taskId)!.status, 'CREATED')
  const proposed = fixture(t, { adopted: false })
  assert.equal((await advanceCollaboration(proposed.store, () => proposed.context('s-session'), proposed.input(), start)).reasonCode, 'ADVANCE_PLAN_STALE')
  assert.equal(proposed.store.listTasks(proposed.kingdomId).length, 1)
  assert.equal(assignTask(proposed.store, proposed.context('s-session'), { taskId: 'parent', workerBindingId: proposed.workers[0]! }).ok, true,
    'an unadopted suggestion does not remove the ordinary single-Worker assignment path')
})

test('advance preflights the entire batch scope and rejects duplicate or invalid Grant inputs with zero writes', async t => {
  const f = fixture(t, { otherSupervisor: true }), before = f.store.eventSequence()
  let calls = 0
  const start = async () => { calls++; return { ok: true, message: 'test' } }
  assert.equal((await advanceCollaboration(f.store, () => f.context('s-session'), f.input(), start)).reasonCode, 'TASK_OUT_OF_SCOPE')
  const duplicate = { ...f.input(), items: [f.input().items[0]!, f.input().items[0]!] }
  assert.equal((await advanceCollaboration(f.store, () => f.context('s-session'), duplicate, start)).reasonCode, 'ADVANCE_DUPLICATE_ITEM')
  const malformed = { ...f.input('SERIAL'), items: [{ taskId: f.plan.items[0]!.taskId, grant: { 'tool:read': 'true' } }] }
  assert.equal((await advanceCollaboration(f.store, () => f.context('s-session'), malformed as never, start)).reasonCode, 'ADVANCE_GRANT_INVALID')
  assert.equal(calls, 0); assert.equal(f.store.eventSequence(), before)
  assert.equal(f.store.getTask(f.plan.items[0]!.taskId)!.assigned_binding_id, null)
})

test('advance uses normal assignment and copies each explicit Grant while preserving expert read-only access', async t => {
  const f = fixture(t), requests: CollaborationStartInput[] = [], input = f.input()
  const result = await advanceCollaboration(f.store, () => f.context('s-session'), input, async request => {
    requests.push(request); input.items[1]!.grant['tool:write'] = true
    return { ok: true, message: 'governed callback verified' }
  })
  assert.equal(result.ok, true); assert.equal(requests.length, 2)
  for (const request of requests) {
    assert.equal(request.sandboxMode, 'read-only'); assert.equal(JSON.parse(request.grantJson)['tool:write'], false)
    const item = f.plan.items.find(item => item.taskId === request.taskId)!
    assert.equal(f.store.getActiveAssignmentForTask(item.taskId)!.worker_binding_id, item.workerBindingId)
  }
  assert.equal(f.store.getTask('parent')!.status, 'CREATED')
  assert.equal(f.store.listEvents(f.kingdomId, 100).filter(event => event.event_type === 'TASK_ACCEPTED').length, 0)
})

test('advance stops launching new work after the first immediate rejection without pretending to cancel existing work', async t => {
  const f = fixture(t), calls: string[] = []
  const result = await advanceCollaboration(f.store, () => f.context('s-session'), f.input(), async request => {
    calls.push(request.taskId); return { ok: false, message: 'budget refused before dispatch' }
  })
  assert.equal(result.ok, false); assert.equal(result.reasonCode, 'ADVANCE_START_REJECTED'); assert.equal(calls.length, 1)
  assert.equal(result.startedTaskIds.length, 0)
  assert.equal(f.store.getTask(f.plan.items[1]!.taskId)!.status, 'ASSIGNED', 'a real Assignment is retained, not fabricated as a started execution')
})

test('advance refreshes identity before every start and blocks a duplicate pending invocation', async t => {
  const f = fixture(t)
  let context: CommandContext | null = f.context('s-session')
  let release!: (result: CollaborationStartResult) => void
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const first = advanceCollaboration(f.store, () => context, f.input(), async () => {
    context = null; entered()
    return new Promise(resolve => { release = resolve })
  })
  await ready
  const duplicate = await advanceCollaboration(f.store, () => f.context('s-session'), f.input('SERIAL'), async () => ({ ok: true, message: 'must not run' }))
  assert.equal(duplicate.reasonCode, 'ADVANCE_ALREADY_IN_PROGRESS')
  release({ ok: true, message: 'already admitted first work finished' })
  const result = await first
  assert.equal(result.ok, false); assert.equal(result.reasonCode, 'ADVANCE_CONTEXT_UNAVAILABLE')
  assert.deepEqual(result.startedTaskIds, [f.plan.items[0]!.taskId])
})

test('advance SERIAL waits for unresolved plan reservations and never stops or releases them', async t => {
  const f = fixture(t), existing = f.plan.items[1]!
  assignTask(f.store, f.context('s-session'), { taskId: existing.taskId, workerBindingId: existing.workerBindingId })
  const admission = reserveBudgetAdmission(f.store, { kingdomId: f.kingdomId, taskId: existing.taskId, attemptNo: 1, workerBindingId: existing.workerBindingId })
  try {
    const before = f.store.eventSequence()
    const result = await advanceCollaboration(f.store, () => f.context('s-session'), f.input('SERIAL'), async () => ({ ok: true, message: 'must not run' }))
    assert.equal(result.reasonCode, 'ADVANCE_SERIAL_WAIT'); assert.equal(f.store.eventSequence(), before)
    assert.equal(f.store.getTask(f.plan.items[0]!.taskId)!.status, 'CREATED')
  } finally { finishBudgetAdmissionInvocation(admission) }
})

test('advance RUNNING requires the latest exact REWORK and refuses missing review or active execution', async t => {
  const missing = fixture(t); reworkFixture(missing, false)
  assert.equal((await advanceCollaboration(missing.store, () => missing.context('s-session'), missing.input('SERIAL'), async () => ({ ok: true, message: 'must not run' }))).reasonCode, 'ADVANCE_REWORK_REQUIRED')
  const valid = fixture(t); reworkFixture(valid, true)
  assert.equal((await advanceCollaboration(valid.store, () => valid.context('s-session'), valid.input('SERIAL'), async () => ({ ok: true, message: 'new governed attempt' }))).ok, true)
  const active = fixture(t); reworkFixture(active, true)
  const old = active.store.latestExecution(active.plan.items[0]!.taskId)!
  active.store.insertExecution({ ...old, execution_id: randomUUID(), attempt_no: 2, state: 'STARTING', ended_at: null })
  assert.equal((await advanceCollaboration(active.store, () => active.context('s-session'), active.input('SERIAL'), async () => ({ ok: true, message: 'must not run' }))).reasonCode, 'ADVANCE_ALREADY_IN_PROGRESS')
})
