import assert from 'node:assert/strict'
import test from 'node:test'
import { KingdomStore } from '../lib/core/db.js'
import { buildSnapshot, buildTaskDetail } from '../lib/gui/snapshot.js'
import { buildPersonalWorkbench, buildWorkbenchUsage, WORKBENCH_ITEM_LIMIT } from '../lib/gui/workbench.js'
import type { PersonalWorkbenchInput } from '../lib/gui/workbench.js'
import type { DispatchView } from '../lib/gui/contract.js'

const NOW = '2026-09-12T06:00:00.000Z'
const KID = 'workbench-test'
const auth = { mode: 'session-bound' as const, trustLevel: 'session-verified' as const, note: '' }
const security = { principalSessionId: 'session-sup-b', sessionVerified: true, scope: ['territory-b'], hostContext: true, commandCoverage: ['assign', 'start', 'review', 'reconcile'] }

function setup(): KingdomStore {
  const store = new KingdomStore(':memory:')
  store.insertKingdom({ kingdom_id: KID, name: '个人工作台测试', owner_id: 'owner', owner_name: '用户', created_at: NOW })
  for (const [id, role] of [['ch', 'CHANCELLOR'], ['sup-a', 'SUPERVISOR'], ['sup-b', 'SUPERVISOR'], ['worker-a', 'WORKER'], ['worker-b', 'WORKER']]) {
    store.insertBinding({ binding_id: id!, kingdom_id: KID, role_type: role!, role_name: id!, runtime_type: 'dsh', session_id: `session-${id}`,
      model_name: null, agent_name: null, session_meta: null, execution_profile_json: null, status: 'ACTIVE', retired_at: null,
      retired_reason: null, principal_id: null, created_at: NOW, updated_at: NOW })
  }
  for (const suffix of ['a', 'b']) {
    store.insertTerritory({ territory_id: `territory-${suffix}`, kingdom_id: KID, name: `领地${suffix}`, workspace_path: null, summary: null,
      supervisor_binding_id: `sup-${suffix}`, status: 'ACTIVE', deleted_at: null, deleted_reason: null, created_at: NOW })
  }
  return store
}

function addTask(store: KingdomStore, id: string, status = 'REVIEW', territory = 'territory-b', claim = true): void {
  store.insertTask({ task_id: id, territory_id: territory, parent_task_id: null, title: id, description: '清楚的范围',
    assigned_binding_id: 'worker-b', status, acceptance_criteria: '核验产物', result_summary: null, created_at: NOW, updated_at: NOW })
  if (claim) store.insertWorkerResult({ result_id: `claim-${id}`, task_id: id, attempt_no: 1, worker_binding_id: 'worker-b',
    session_id: 'private-session', outcome: 'COMPLETED', result_json: JSON.stringify({ summary: '执行者自述', artifacts: ['可验证产物'], risks: [] }), created_at: NOW })
}

function event(store: KingdomStore, id: string, type: string, actor = 'SUPERVISOR', payload: Record<string, unknown> = {}): void {
  const seq = store.revision(KID) + 1
  store.appendEvent({ event_id: `event-${seq}`, kingdom_id: KID, event_type: type, actor_role: actor, actor_id: actor === 'SUPERVISOR' ? 'sup-b' : 'runtime',
    target_type: 'task', target_id: id, payload_json: JSON.stringify(payload), created_at: NOW })
}

function projected(store: KingdomStore) {
  return buildSnapshot(store, { auth, security, nowMs: Date.parse(NOW) }).projection.workbench.data
}

test('review remains internal and accepted delivery never becomes human acceptance', () => {
  const store = setup()
  try {
    addTask(store, 'review')
    addTask(store, 'accepted', 'DONE')
    event(store, 'accepted', 'TASK_ACCEPTED', 'SUPERVISOR', { decision: 'ACCEPT', reviewed_attempt_no: 1, reviewer_binding_id: 'sup-b' })
    addTask(store, 'unconfirmed-done', 'DONE')
    const workbench = projected(store)
    assert.equal(workbench.ownerActions.totalCount, 0)
    const review = workbench.internalActions.items.find(item => item.taskId === 'review')!
    assert.equal(review.responsibility, 'SUPERVISOR')
    assert.equal(review.responsibleBindingId, 'sup-b', 'use exact territory supervisor rather than the first binding')
    assert.ok(review.actionAvailability.some(action => action.action === 'review:accept' && action.executable))
    const accepted = workbench.deliveries.items.find(item => item.taskId === 'accepted')!
    assert.equal(accepted.supervisorAccepted, true)
    assert.equal(accepted.humanAcceptance, 'NOT_RECORDED')
    assert.equal(workbench.deliveries.items.find(item => item.taskId === 'unconfirmed-done')!.supervisorAccepted, false)
    assert.equal(buildTaskDetail(store, KID, 'accepted')!.humanAcceptance, 'NOT_RECORDED')
    assert.equal(JSON.stringify(workbench).includes('private-session'), false)
    const denied = buildSnapshot(store, { auth, nowMs: Date.parse(NOW) }).projection.workbench.data.internalActions.items[0]!
    assert.ok(denied.actionAvailability.every(action => !action.executable), 'responsibility never grants authority')
  } finally { store.close() }
})

test('actual missing owner configuration is separate from unassigned internal review', () => {
  const empty = new KingdomStore(':memory:')
  const store = setup()
  try {
    assert.equal(projected(empty).ownerActions.items[0]!.kind, 'KINGDOM_CONFIGURATION_REQUIRED')
    addTask(store, 'missing-supervisor')
    store.retireBinding('sup-b', 'fixture retirement')
    const workbench = projected(store)
    assert.deepEqual(workbench.ownerActions.items.map(item => item.kind), ['TERRITORY_SUPERVISOR_CONFIGURATION_REQUIRED'])
    assert.equal(workbench.ownerActions.items[0]!.responsibility, 'OWNER')
    assert.deepEqual(workbench.ownerActions.items[0]!.actionAvailability, [])
    assert.equal(workbench.internalActions.items[0]!.responsibility, 'UNDETERMINED')
    assert.equal(workbench.internalActions.items[0]!.responsibleBindingId, null)
  } finally { empty.close(); store.close() }
})

function publicInput(): PersonalWorkbenchInput {
  return {
    kingdomPresent: true,
    bindings: [{ bindingId: 'ch', roleType: 'CHANCELLOR', roleName: '宰相', status: 'ACTIVE', sessionBound: true },
      { bindingId: 'sup', roleType: 'SUPERVISOR', roleName: '主管', status: 'ACTIVE', sessionBound: true }],
    territories: [{ territoryId: 'territory', name: '领地', status: 'ACTIVE', supervisorBindingId: 'sup' }],
    tasks: [{ task: { taskId: 'task', territoryId: 'territory', title: '任务', status: 'ASSIGNED', assignedBindingId: null,
      latestClaim: null, latestExecution: null, updatedAt: NOW }, actionAvailability: [{ action: 'start', lifecycleAllowed: true,
      executable: false, disabledReason: null, sourceRefs: [] }], latestReview: null, claimExecutionMismatch: false }],
    executions: [], governance: { workerSessions: [], leases: [], decisions: [], dispatches: [] },
  }
}

function dispatch(id: string, state = 'TERMINAL'): DispatchView {
  return { dispatchId: id, leaseId: `lease-${id}`, executionId: `execution-${id}`, taskId: 'task', attemptNo: 1, state,
    runtimeDispatchRef: null, runtimeExecutionRef: null, hasReceipt: true, hasTerminalEvidence: state === 'TERMINAL', createdAt: NOW }
}

test('only current denials and unresolved recovery enter exceptions with evidence-based responsibility', () => {
  const input = publicInput()
  input.governance.decisions.push({ decisionId: 'old-denial', taskId: 'task', decision: 'DENIED', enforcementStatus: 'NOT_ENFORCED',
    requirementCoverage: 'NONE', reasonCode: 'CEILING_NOT_CONFIGURED', hasEvidence: false, createdAt: '2026-09-12T04:00:00.000Z' })
  assert.equal(buildPersonalWorkbench(input).exceptions.items[0]!.kind, 'CAPABILITY_DENIED')
  assert.equal(buildPersonalWorkbench(input).ownerActions.totalCount, 0, 'denial does not ask user to expand permissions')
  input.governance.decisions.push({ ...input.governance.decisions[0]!, decisionId: 'new-grant', decision: 'GRANTED', createdAt: NOW })
  assert.equal(buildPersonalWorkbench(input).exceptions.totalCount, 0, 'historical denial was superseded')
  input.governance.dispatches.push(dispatch('inflight', 'CORRELATED'))
  assert.equal(buildPersonalWorkbench(input).exceptions.totalCount, 0, 'ordinary running receipt is not an incident')
  input.governance.dispatches[0]!.state = 'RECOVERING'
  const recovery = buildPersonalWorkbench(input)
  assert.equal(recovery.exceptions.items[0]!.kind, 'EXECUTION_RECOVERY_REQUIRED')
  assert.equal(recovery.exceptions.items[0]!.responsibleBindingId, 'sup')
  assert.equal(recovery.internalActions.totalCount, 0, 'recovery never invites another start')
  assert.ok(recovery.exceptions.items[0]!.sourceRefs.some(ref => ref.entityId === 'inflight'))
  input.bindings[1]!.status = 'RETIRED'
  assert.equal(buildPersonalWorkbench(input).exceptions.items[0]!.responsibility, 'UNDETERMINED')
})

test('usage totals only complete matching reports and exposes uncovered executions', () => {
  const input = publicInput()
  for (const id of ['complete', 'partial', 'missing', 'foreign', 'invalid']) input.governance.dispatches.push(dispatch(id))
  const report = { type: 'KingdomDispatchUsage/v1' as const, dispatchId: 'complete', taskId: 'task', attemptNo: 1,
    source: 'provider-reported' as const, status: 'COMPLETE' as const, reasonCode: null, observedRequests: 2, reportedRequests: 2,
    turn: 1, throughSeq: 4, usage: { uncachedInputTokens: 12, outputTokens: 8, totalTokens: 20 } }
  input.governance.dispatches[0]!.usage = report
  input.governance.dispatches[1]!.usage = { ...report, dispatchId: 'partial', status: 'PARTIAL', usage: null }
  input.governance.dispatches[3]!.usage = { ...report, dispatchId: 'another-dispatch' }
  input.governance.dispatches[4]!.usage = { ...report, dispatchId: 'invalid', usage: { ...report.usage, totalTokens: Number.NaN } }
  input.executions.push({ executionId: 'legacy-execution', taskId: 'task', workerBindingId: null, state: 'COMPLETED' })
  const usage = buildWorkbenchUsage(input)
  assert.equal(usage.scope, 'WORKER_DISPATCH_ONLY')
  assert.equal(usage.totalDispatches, 5)
  assert.equal(usage.completeDispatches, 1)
  assert.equal(usage.partialDispatches, 1)
  assert.equal(usage.unavailableDispatches, 3)
  assert.equal(usage.executionsWithoutDispatch, 1)
  assert.equal(usage.coverage, 'PARTIAL')
  assert.deepEqual(usage.reportedTotals, report.usage)
  assert.equal(usage.cost, null)
  input.governance.dispatches = [dispatch('missing')]
  assert.equal(buildWorkbenchUsage(input).reportedTotals, null, 'missing report is not zero tokens')
  assert.equal(buildWorkbenchUsage(input).coverage, 'UNAVAILABLE')
})

test('bounded workbench preserves totals and all active role identities before truncation', () => {
  const store = setup()
  try {
    for (let index = 0; index < WORKBENCH_ITEM_LIMIT + 3; index++) addTask(store, `task-${index}`, 'REVIEW')
    const workbench = projected(store)
    assert.equal(workbench.internalActions.totalCount, WORKBENCH_ITEM_LIMIT + 3)
    assert.equal(workbench.internalActions.items.length, WORKBENCH_ITEM_LIMIT)
    assert.equal(workbench.internalActions.truncated, true)
    assert.equal(workbench.deliveries.truncated, true)
    const a = workbench.roles.items.find(role => role.bindingId === 'sup-a')!
    const b = workbench.roles.items.find(role => role.bindingId === 'sup-b')!
    assert.equal(a.taskCount, 0)
    assert.equal(b.taskCount, WORKBENCH_ITEM_LIMIT + 3)
    assert.equal(b.taskIdsTruncated, true)
    assert.equal(b.reviewTaskCount, WORKBENCH_ITEM_LIMIT + 3)
    assert.equal(workbench.roles.items.find(role => role.bindingId === 'worker-a')!.taskCount, 0)
    assert.equal(workbench.roles.items.find(role => role.bindingId === 'worker-b')!.taskCount, WORKBENCH_ITEM_LIMIT + 3)
  } finally { store.close() }
})

test('workbench projection is read only and task history is scoped before its bound', () => {
  const store = setup()
  try {
    addTask(store, 'accepted', 'DONE')
    event(store, 'accepted', 'TASK_ACCEPTED', 'SUPERVISOR', { decision: 'ACCEPT', reviewed_attempt_no: 1 })
    addTask(store, 'runtime-failed', 'FAILED')
    event(store, 'runtime-failed', 'TASK_FAILED', 'SYSTEM', { reason: 'execution transport failed' })
    for (let index = 0; index < 505; index++) event(store, 'unrelated', 'TASK_PLANNED', 'CHANCELLOR')
    const before = { revision: store.revision(KID), tasks: store.listTasks(KID), events: store.listEvents(KID, 1000) }
    const workbench = projected(store)
    const accepted = buildTaskDetail(store, KID, 'accepted')!
    assert.equal(accepted.relatedEvents.length, 1)
    assert.equal(accepted.relatedEventsTruncated, false)
    assert.equal(accepted.reviews[0]!.decision, 'ACCEPT')
    assert.equal(accepted.reviewsTruncated, false)
    assert.equal(workbench.deliveries.items.find(item => item.taskId === 'accepted')!.supervisorAccepted, true)
    assert.equal(buildTaskDetail(store, KID, 'runtime-failed')!.reviews.length, 0, 'runtime failure is not a Supervisor decision')
    assert.deepEqual({ revision: store.revision(KID), tasks: store.listTasks(KID), events: store.listEvents(KID, 1000) }, before)
    for (let index = 0; index < 501; index++) event(store, 'accepted', 'TASK_NOTE', 'SYSTEM')
    const bounded = buildTaskDetail(store, KID, 'accepted')!
    assert.equal(bounded.relatedEvents.length, 500)
    assert.equal(bounded.relatedEventsTruncated, true)
    assert.equal(bounded.reviews[0]!.decision, 'ACCEPT', 'Supervisor decisions have their own exact-task window')
    assert.equal(bounded.reviewsTruncated, false)
    assert.equal(projected(store).deliveries.items.find(item => item.taskId === 'accepted')!.supervisorAccepted, true, 'latest decision lookup is independent of the display history bound')
  } finally { store.close() }
})

test('organization display truncation never creates a false owner appointment request', () => {
  const store = setup()
  try {
    const original = store.getBindingById('sup-b')!
    for (let index = 0; index < 65; index++) {
      store.insertBinding({ ...original, binding_id: `aaa-extra-${index}`, role_name: `aaa-extra-${index}`, session_id: null })
    }
    addTask(store, 'task-b')
    const snapshot = buildSnapshot(store, { auth, security, nowMs: Date.parse(NOW) })
    assert.equal(snapshot.projection.organization.data.rolesTruncated, true)
    assert.equal(snapshot.projection.organization.data.roles.some(role => role.bindingRef.id === 'sup-b'), false)
    const workbench = snapshot.projection.workbench.data
    assert.equal(workbench.ownerActions.totalCount, 0)
    assert.equal(workbench.internalActions.items[0]!.responsibleBindingId, 'sup-b')
    assert.equal(workbench.roles.totalCount, 70)
    assert.equal(workbench.roles.items.length, WORKBENCH_ITEM_LIMIT)
    assert.equal(workbench.roles.truncated, true)
  } finally { store.close() }
})
