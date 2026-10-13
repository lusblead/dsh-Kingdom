/** Transaction boundary regressions; isolated SQLite fixtures, no real Runtime. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KingdomStore } from '../lib/core/db.js'
import { reviewTask, type CommandContext } from '../lib/core/task-service.js'

const at = '2026-10-13T00:00:00.000Z'

function makeReviewFixture() {
  const store = new KingdomStore(':memory:')
  const kingdomId = 'transaction-authority-kingdom'
  const supervisor = 'supervisor-original'
  const session = 'supervisor-original-session'
  const replacement = 'supervisor-replacement'
  const worker = 'worker-original'
  const territory = 'territory-original'
  const taskId = 'task-review'
  store.insertKingdom({ kingdom_id: kingdomId, name: 'transaction authority', owner_id: 'owner', owner_name: 'Owner', created_at: at })
  for (const [bindingId, roleType, sessionId] of [
    [supervisor, 'SUPERVISOR', session], [replacement, 'SUPERVISOR', 'replacement-session'], [worker, 'WORKER', null],
  ] as const) store.insertBinding({ binding_id: bindingId, kingdom_id: kingdomId, role_type: roleType, role_name: bindingId,
    runtime_type: 'dsh', session_id: sessionId, model_name: null, agent_name: null, session_meta: null, execution_profile_json: null,
    status: 'ACTIVE', retired_at: null, retired_reason: null, principal_id: null, created_at: at, updated_at: at })
  for (const id of [territory, 'territory-other']) store.insertTerritory({ territory_id: id, kingdom_id: kingdomId,
    name: id, workspace_path: null, summary: null, supervisor_binding_id: supervisor,
    status: 'ACTIVE', deleted_at: null, deleted_reason: null, created_at: at })
  store.insertTask({ task_id: taskId, territory_id: territory, parent_task_id: null, title: 'review exact Claim', description: null,
    assigned_binding_id: worker, status: 'REVIEW', acceptance_criteria: 'review', result_summary: 'claim', created_at: at, updated_at: at })
  store.insertTaskAssignment({ assignment_id: 'assignment-original', task_id: taskId, territory_id: territory,
    worker_binding_id: worker, assigned_by: supervisor, assigned_at: at, ended_at: null, end_reason: null,
    previous_assignment_id: null, handoff_reason: null, created_at: at })
  store.insertWorkerResult({ result_id: 'claim-original', task_id: taskId, attempt_no: 1, worker_binding_id: worker,
    session_id: null, outcome: 'COMPLETED', result_json: '{"summary":"claim"}', created_at: at })
  const ctx: CommandContext = { kingdomId, principal: { sessionId: session },
    auth: { mode: 'session-bound', trustLevel: 'session-verified', note: 'isolated fixture' } }
  return { store, ctx, kingdomId, supervisor, session, replacement, worker, territory, taskId }
}
type Fixture = ReturnType<typeof makeReviewFixture>

function replaceBeforeBegin(store: KingdomStore, replace: () => void): () => boolean {
  const original = store.withImmediateTransaction.bind(store)
  let intercepted = false
  store.withImmediateTransaction = <T>(fn: () => T): T => {
    intercepted = true
    store.withImmediateTransaction = original
    replace()
    return original(fn)
  }
  return () => intercepted
}

test('ACCEPT revalidates Supervisor Session and Territory after outer authorization before BEGIN', async t => {
  const cases: { name: string; change(f: Fixture): void; expectedCode: string }[] = [
    { name: 'Session replaced', expectedCode: 'UNAUTHORIZED_PRINCIPAL', change: f => f.store.updateBindingSession(f.supervisor, 'replacement-session', at) },
    { name: 'Supervisor retired', expectedCode: 'TERRITORY_SUPERVISOR_MISSING', change: f => f.store.retireBinding(f.supervisor, 'boundary test') },
    { name: 'Territory Supervisor replaced', expectedCode: 'TASK_OUT_OF_SCOPE', change: f => f.store.updateTerritorySupervisor(f.territory, f.replacement) },
    { name: 'same Session points to another Supervisor', expectedCode: 'TASK_OUT_OF_SCOPE', change: f => {
      f.store.updateBindingSession(f.replacement, f.session, at)
      f.store.updateTerritorySupervisor(f.territory, f.replacement)
    } },
    { name: 'Task Territory replaced', expectedCode: 'TASK_OUT_OF_SCOPE', change: f => f.store.db.prepare('UPDATE tasks SET territory_id = ? WHERE task_id = ?').run('territory-other', f.taskId) },
    { name: 'Territory deleted', expectedCode: 'TERRITORY_NOT_IN_KINGDOM', change: f => f.store.db.prepare('UPDATE territories SET status = ? WHERE territory_id = ?').run('DELETED', f.territory) },
    { name: 'Task left REVIEW', expectedCode: 'ILLEGAL_TASK_STATE', change: f => f.store.db.prepare('UPDATE tasks SET status = ? WHERE task_id = ?').run('RUNNING', f.taskId) },
  ]
  for (const item of cases) await t.test(item.name, () => {
    const f = makeReviewFixture()
    try {
      const intercepted = replaceBeforeBegin(f.store, () => item.change(f))
      const result = reviewTask(f.store, f.ctx, { taskId: f.taskId, decision: 'ACCEPT' })
      assert.equal(intercepted(), true, 'outer authorization must pass before replacement')
      assert.equal(result.ok, false)
      assert.equal(result.errorCode, item.expectedCode)
      assert.notEqual(f.store.getTask(f.taskId)!.status, 'DONE')
      assert.equal(f.store.listEvents(f.kingdomId).filter(event => event.event_type === 'TASK_ACCEPTED').length, 0)
      assert.equal(f.store.getActiveAssignmentForTask(f.taskId)?.assignment_id, 'assignment-original')
      assert.equal(f.store.listWorkerResults(f.taskId).length, 1)
    } finally { f.store.close() }
  })
})

test('ACCEPT ordinary current authorization commits DONE with the reread Supervisor attribution', () => {
  const f = makeReviewFixture()
  try {
    const intercepted = replaceBeforeBegin(f.store, () => f.store.db.prepare('UPDATE role_bindings SET role_name = ? WHERE binding_id = ?').run('current Supervisor name', f.supervisor))
    const result = reviewTask(f.store, f.ctx, { taskId: f.taskId, decision: 'ACCEPT' })
    assert.equal(intercepted(), true)
    assert.equal(result.ok, true)
    assert.equal(f.store.getTask(f.taskId)!.status, 'DONE')
    assert.equal(f.store.getActiveAssignmentForTask(f.taskId), null)
    const events = f.store.listEvents(f.kingdomId).filter(event => event.event_type === 'TASK_ACCEPTED')
    assert.equal(events.length, 1)
    assert.equal(events[0].actor_id, f.supervisor)
    assert.equal(JSON.parse(events[0].payload_json).reviewer_binding_id, f.supervisor)
    assert.match(result.message, /reviewer=current Supervisor name/)
  } finally { f.store.close() }
})

test('ACCEPT targeted compare-and-set cannot overwrite a newer Task state or assignment', () => {
  for (const changed of ['state', 'assignment'] as const) {
    const f = makeReviewFixture()
    try {
      const stale = f.store.getTask(f.taskId)!
      if (changed === 'state') f.store.db.prepare('UPDATE tasks SET status = ? WHERE task_id = ?').run('RUNNING', f.taskId)
      else f.store.db.prepare('UPDATE tasks SET assigned_binding_id = ? WHERE task_id = ?').run(null, f.taskId)
      const before = f.store.getTask(f.taskId)
      assert.throws(() => f.store.transitionTaskIfCurrent(stale, 'DONE'), /TASK_STATE_CHANGED/)
      assert.deepEqual(f.store.getTask(f.taskId), before)
      assert.equal(f.store.listEvents(f.kingdomId).length, 0)
      assert.equal(f.store.getActiveAssignmentForTask(f.taskId)?.assignment_id, 'assignment-original')
    } finally { f.store.close() }
  }
})

test('ACCEPT compare-and-set failure rolls back the entire review transaction', () => {
  const f = makeReviewFixture()
  try {
    const conditional = f.store.transitionTaskIfCurrent.bind(f.store)
    f.store.transitionTaskIfCurrent = (task, to) => {
      f.store.db.prepare('UPDATE tasks SET status = ? WHERE task_id = ?').run('RUNNING', task.task_id)
      return conditional(task, to)
    }
    assert.throws(() => reviewTask(f.store, f.ctx, { taskId: f.taskId, decision: 'ACCEPT' }), /TASK_STATE_CHANGED/)
    assert.equal(f.store.getTask(f.taskId)!.status, 'REVIEW')
    assert.equal(f.store.listEvents(f.kingdomId).length, 0)
    assert.equal(f.store.getActiveAssignmentForTask(f.taskId)?.assignment_id, 'assignment-original')
  } finally { f.store.close() }
})
