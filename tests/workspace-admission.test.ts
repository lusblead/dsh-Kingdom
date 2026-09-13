import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { KingdomStore } from '../lib/core/db.js'
import { bindRole } from '../lib/core/binding.js'
import { issueOwnerControlCapability, ownerControlAuth } from '../lib/core/owner-control.js'
import { startTask, type CommandContext } from '../lib/core/task-service.js'
import type { WorkerExecutionOutcome } from '../lib/worker/executor.js'
import {
  canonicalWorkspaceKey, workspaceKeysOverlap, reserveWorkspaceAdmission, bindWorkspaceAdmissionInTransaction,
  cancelWorkspaceAdmissionIfSafe, finishWorkspaceAdmissionInvocation, readWorkspaceReservations,
  type WorkspaceAdmissionHandle, type WorkspaceAdmissionInput,
} from '../lib/core/workspace-admission.js'
import { reserveBudgetAdmission, finishBudgetAdmissionInvocation, type BudgetAdmissionHandle } from '../lib/core/budget.js'
import {
  establishAffinity, acquireExecutionLease, setLeasePlan, advanceLeaseState, recordCapabilityDecision,
  bindCapabilityDecision, prepareGovernedDispatch, markGovernedDispatchRecovering,
  recordDispatchReceipt, correlateRuntimeExecution, recordTerminalEvidence, releaseExecutionLease,
} from '../lib/core/governed.js'

const now = () => new Date().toISOString()
function fixture(t: { after(fn: () => void): void }, persistent = false) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kingdom-workspace-admission-')))
  let store = new KingdomStore(persistent ? join(root, 'kingdom.db') : ':memory:')
  const kingdomId = randomUUID(), workspaceHandles: WorkspaceAdmissionHandle[] = [], budgetHandles: BudgetAdmissionHandle[] = []
  store.insertKingdom({ kingdom_id: kingdomId, name: 'Workspace fixture', owner_id: 'owner', owner_name: 'Fixture Owner', created_at: now() })
  const task = (workspacePath: string, access: 'WRITE' | 'READ_ONLY' = 'WRITE'): WorkspaceAdmissionInput => {
    const taskId = randomUUID(), territoryId = randomUUID(), workerBindingId = randomUUID()
    store.insertBinding({ binding_id: workerBindingId, kingdom_id: kingdomId, role_type: 'WORKER', role_name: 'Fixture Worker',
      runtime_type: 'dsh', session_id: null, model_name: null, agent_name: null, session_meta: null, execution_profile_json: null,
      status: 'ACTIVE', retired_at: null, retired_reason: null, principal_id: null, created_at: now(), updated_at: now() })
    store.insertTerritory({ territory_id: territoryId, kingdom_id: kingdomId, name: `Fixture Territory ${territoryId}`, workspace_path: workspacePath,
      summary: null, supervisor_binding_id: null, status: 'ACTIVE', deleted_at: null, deleted_reason: null, created_at: now() })
    store.insertTask({ task_id: taskId, territory_id: territoryId, parent_task_id: null, title: 'Fixture Task', description: null,
      assigned_binding_id: workerBindingId, status: 'ASSIGNED', acceptance_criteria: null, result_summary: null, created_at: now(), updated_at: now() })
    return { kingdomId, taskId, attemptNo: 1, workerBindingId, workspacePath, access }
  }
  const directory = (name: string) => { const path = join(root, name); mkdirSync(path, { recursive: true }); return path }
  const reserve = (input: WorkspaceAdmissionInput) => { const handle = reserveWorkspaceAdmission(store, input); workspaceHandles.push(handle); return handle }
  const budget = (input: WorkspaceAdmissionInput) => { const handle = reserveBudgetAdmission(store, input); budgetHandles.push(handle); return handle }
  const lease = (input: WorkspaceAdmissionInput) => {
    const territoryId = store.getTask(input.taskId)!.territory_id
    const session = { runtimeType: 'dsh', runtimeInstanceRef: 'workspace-fixture', sessionRef: randomUUID() }
    establishAffinity(store, { kingdomId, workerBindingId: input.workerBindingId, territoryId, session })
    return { session, row: acquireExecutionLease(store, { kingdomId, taskId: input.taskId, attemptNo: input.attemptNo,
      workerBindingId: input.workerBindingId, territoryId, session }) }
  }
  const prepare = (input: WorkspaceAdmissionInput, workspaceAdmission?: WorkspaceAdmissionHandle, budgetAdmission?: BudgetAdmissionHandle,
    gateSandboxMode: 'read-only' | 'workspace-write' = input.access === 'READ_ONLY' ? 'read-only' : 'workspace-write') => {
    const leased = lease(input)
    setLeasePlan(store, leased.row.lease_id, JSON.stringify({ type: 'DshEnforcementPlan/v1', payload: { sandboxMode: gateSandboxMode } }))
    advanceLeaseState(store, leased.row.lease_id, 'PREPARING')
    advanceLeaseState(store, leased.row.lease_id, 'MATERIALIZING')
    const decision = recordCapabilityDecision(store, { kingdomId, taskId: input.taskId, workerBindingId: input.workerBindingId,
      decision: 'GRANTED', enforcementStatus: 'ENFORCED', enforcementEvidenceJson: '{"type":"WorkspaceFixtureEnforcement/v1"}' })
    bindCapabilityDecision(store, leased.row.lease_id, decision.decision_id)
    advanceLeaseState(store, leased.row.lease_id, 'DISPATCH_READY')
    const invoke = (handle = workspaceAdmission) => prepareGovernedDispatch(store, {
      kingdomId, taskId: input.taskId, attemptNo: input.attemptNo, workerBindingId: input.workerBindingId,
      leaseId: leased.row.lease_id, capabilityDecisionId: decision.decision_id, session: leased.session,
      requestSnapshot: '{}', inputRefJson: '{}', payloadHash: 'workspace-fixture', workspaceAdmission: handle, budgetAdmission,
    })
    return { ...leased, decision, invoke }
  }
  t.after(() => {
    workspaceHandles.forEach(finishWorkspaceAdmissionInvocation)
    budgetHandles.forEach(finishBudgetAdmissionInvocation)
    store.close()
    const target = realpathSync.native(root), delta = relative(realpathSync.native(tmpdir()), target)
    assert.ok(delta && !delta.startsWith('..') && !isAbsolute(delta) && dirname(target) === realpathSync.native(tmpdir())
      && target.includes('kingdom-workspace-admission-'), 'recursive cleanup remains within the uniquely owned temporary fixture')
    rmSync(target, { recursive: true, force: true })
  })
  return { root, get store() { return store }, kingdomId, task, directory, reserve, budget, lease, prepare,
    reopen() { assert.equal(persistent, true); store.close(); store = new KingdomStore(join(root, 'kingdom.db')) } }
}

function legacy(f: ReturnType<typeof fixture>, input: WorkspaceAdmissionInput) {
  const sessionId = randomUUID()
  bindRole(f.store, { kingdomId: f.kingdomId, roleType: 'SUPERVISOR', roleName: sessionId, sessionId }, ownerControlAuth(issueOwnerControlCapability()))
  const supervisor = f.store.getBindingsByRole(f.kingdomId, 'SUPERVISOR').find(row => row.session_id === sessionId)!
  f.store.updateTerritorySupervisor(f.store.getTask(input.taskId)!.territory_id, supervisor.binding_id)
  const ctx: CommandContext = { kingdomId: f.kingdomId, principal: { sessionId }, auth: { mode: 'session-bound', trustLevel: 'session-verified', note: 'test' } }
  let calls = 0, release!: (outcome: WorkerExecutionOutcome) => void
  const waiting = new Promise<WorkerExecutionOutcome>(resolve => { release = resolve })
  const start = () => startTask(f.store, { kind: 'held-test', execute: async () => { calls++; return waiting } }, ctx, { taskId: input.taskId })
  return { start, get calls() { return calls }, release: () => release({ kind: 'result', result: { outcome: 'COMPLETED', summary: 'Fixture only' }, sessionId: null }) }
}

test('workspace Legacy and governed admission exclude each other before any execution effects', async t => {
  for (const relation of ['same', 'ancestor', 'descendant', 'alias', 'missing-alias'] as const) {
    const f = fixture(t), root = f.directory('shared'), child = f.directory('shared/child'), alias = join(f.root, 'alias')
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const paths = relation === 'ancestor' ? [child, root] : relation === 'descendant' ? [root, child]
      : relation === 'alias' ? [root, alias] : relation === 'missing-alias' ? [join(root, 'new'), join(alias, 'new')] : [root, root]
    const first = f.task(paths[0]!), second = f.task(paths[1]!), runner = legacy(f, first)
    const running = runner.start()
    assert.equal(runner.calls, 1)
    const before = f.store.eventSequence()
    assert.throws(() => f.reserve(second), { code: 'WORKSPACE_LEGACY_EXECUTION_BUSY' })
    assert.equal(f.store.eventSequence(), before)
    runner.release(); assert.equal((await running).ok, true)
    const held = f.reserve(second)
    const next = f.task(paths[0]!), blocked = legacy(f, next), seq = f.store.eventSequence()
    assert.equal((await blocked.start()).ok, false)
    assert.equal(blocked.calls, 0); assert.equal(f.store.eventSequence(), seq)
    assert.equal(f.store.getTask(next.taskId)!.status, 'ASSIGNED'); assert.equal(f.store.listExecutions(next.taskId).length, 0)
    assert.equal(cancelWorkspaceAdmissionIfSafe(f.store, held), true)
    const retry = blocked.start(); assert.equal(blocked.calls, 1); blocked.release(); assert.equal((await retry).ok, true)
  }
})

test('workspace Legacy start rolls back Task and Execution if fact creation fails', async t => {
  const f = fixture(t), input = f.task(f.directory('shared')), runner = legacy(f, input), seq = f.store.eventSequence()
  const append = f.store.appendEvent.bind(f.store)
  f.store.appendEvent = event => { if (event.event_type === 'WORKER_EXECUTION_STARTED') throw new Error('injected event fault'); return append(event) }
  await assert.rejects(runner.start(), /injected event fault/)
  assert.equal(runner.calls, 0); assert.equal(f.store.eventSequence(), seq)
  assert.equal(f.store.getTask(input.taskId)!.status, 'ASSIGNED'); assert.equal(f.store.listExecutions(input.taskId).length, 0)
})

test('workspace canonical keys normalize aliases and distinguish path-component siblings', t => {
  const f = fixture(t), actual = f.directory('actual'), alias = join(f.root, 'alias')
  symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(canonicalWorkspaceKey(alias), canonicalWorkspaceKey(actual))
  assert.equal(canonicalWorkspaceKey(actual + '/'), canonicalWorkspaceKey(actual))
  if (process.platform === 'win32') assert.equal(canonicalWorkspaceKey(actual.toUpperCase()), canonicalWorkspaceKey(actual))
  assert.equal(workspaceKeysOverlap(canonicalWorkspaceKey(actual), canonicalWorkspaceKey(join(actual, 'nested'))), true)
  assert.equal(workspaceKeysOverlap(canonicalWorkspaceKey(actual), canonicalWorkspaceKey(actual + '-sibling')), false)
})

test('workspace rejects a second writer or reader in the same reserved directory without extra writes', t => {
  const f = fixture(t), path = f.directory('shared'), first = f.task(path)
  f.reserve(first)
  for (const access of ['WRITE', 'READ_ONLY'] as const) {
    const other = f.task(path, access), before = f.store.eventSequence()
    assert.throws(() => f.reserve(other), { code: 'WORKSPACE_BUSY' })
    assert.equal(f.store.eventSequence(), before)
  }
  assert.equal(readWorkspaceReservations(f.store, f.kingdomId).length, 1)
})

test('workspace admits concurrent read-only access but queues a writer', t => {
  const f = fixture(t), path = f.directory('shared')
  f.reserve(f.task(path, 'READ_ONLY')); f.reserve(f.task(path, 'READ_ONLY'))
  assert.throws(() => f.reserve(f.task(path, 'WRITE')), { code: 'WORKSPACE_BUSY' })
  assert.equal(readWorkspaceReservations(f.store, f.kingdomId).length, 2)
})

test('workspace ancestor descendant and junction aliases conflict while distinct directories remain independent', t => {
  const f = fixture(t), parent = f.directory('parent'), child = f.directory('parent/child'), sibling = f.directory('parent-sibling')
  const alias = join(f.root, 'alias'); symlinkSync(parent, alias, process.platform === 'win32' ? 'junction' : 'dir')
  f.reserve(f.task(child))
  assert.throws(() => f.reserve(f.task(parent)), { code: 'WORKSPACE_BUSY' })
  assert.throws(() => f.reserve(f.task(join(alias, 'child'))), { code: 'WORKSPACE_BUSY' })
  f.reserve(f.task(sibling))
  assert.equal(readWorkspaceReservations(f.store, f.kingdomId).length, 2)
})

test('workspace resolves an existing linked ancestor even when the admitted leaf does not exist yet', t => {
  const f = fixture(t), actual = f.directory('actual'), alias = join(f.root, 'alias')
  symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const physicalLeaf = join(actual, 'not-yet-created'), aliasLeaf = join(alias, 'not-yet-created')
  assert.equal(canonicalWorkspaceKey(aliasLeaf), canonicalWorkspaceKey(physicalLeaf))
  f.reserve(f.task(physicalLeaf))
  assert.throws(() => f.reserve(f.task(aliasLeaf)), { code: 'WORKSPACE_BUSY' })
})

test('workspace reservation survives lost invocation ownership and copied handles cannot release it', t => {
  const f = fixture(t), path = f.directory('interrupted'), input = f.task(path), handle = f.reserve(input)
  finishWorkspaceAdmissionInvocation(handle)
  assert.throws(() => cancelWorkspaceAdmissionIfSafe(f.store, handle), { code: 'WORKSPACE_ADMISSION_REQUIRED' })
  assert.throws(() => cancelWorkspaceAdmissionIfSafe(f.store, JSON.parse(JSON.stringify(handle))), { code: 'WORKSPACE_ADMISSION_REQUIRED' })
  assert.throws(() => f.reserve(f.task(path)), { code: 'WORKSPACE_BUSY' })
  assert.equal(readWorkspaceReservations(f.store, f.kingdomId)[0]!.state, 'RESERVED')
})

test('workspace restart keeps persisted unresolved preparation blocked without recreating process-local authority', t => {
  const f = fixture(t, true), path = f.directory('restart'), input = f.task(path), handle = f.reserve(input)
  const before = readWorkspaceReservations(f.store, f.kingdomId)
  finishWorkspaceAdmissionInvocation(handle)
  f.reopen()
  assert.deepEqual(readWorkspaceReservations(f.store, f.kingdomId), before)
  assert.throws(() => cancelWorkspaceAdmissionIfSafe(f.store, handle), { code: 'WORKSPACE_ADMISSION_REQUIRED' })
  assert.throws(() => f.reserve(f.task(path)), { code: 'WORKSPACE_BUSY' })
})

test('workspace safe cancellation permits retry while duplicate live attempts remain blocked', t => {
  const f = fixture(t), input = f.task(f.directory('retry')), handle = f.reserve(input)
  assert.throws(() => f.reserve(input), { code: 'WORKSPACE_ADMISSION_DUPLICATE' })
  assert.equal(cancelWorkspaceAdmissionIfSafe(f.store, handle), true)
  assert.equal(readWorkspaceReservations(f.store, f.kingdomId).length, 0)
  f.reserve(input)
  assert.equal(readWorkspaceReservations(f.store, f.kingdomId).length, 1)
})

test('workspace keeps RECOVERING ownership and only a terminal dispatch plus released Lease frees the directory', t => {
  const f = fixture(t), path = f.directory('recovering'), input = f.task(path), handle = f.reserve(input)
  const prepared = f.prepare(input, handle).invoke(), dispatchId = prepared.intent.dispatch_id
  markGovernedDispatchRecovering(f.store, dispatchId, 'FIXTURE_INTERRUPTED')
  const before = { lease: f.store.getLease(prepared.lease.lease_id), dispatch: f.store.getDispatch(dispatchId) }
  assert.equal(cancelWorkspaceAdmissionIfSafe(f.store, handle), false)
  assert.throws(() => f.reserve(f.task(path, 'READ_ONLY')), { code: 'WORKSPACE_BUSY' })
  assert.deepEqual({ lease: f.store.getLease(prepared.lease.lease_id), dispatch: f.store.getDispatch(dispatchId) }, before)
  assert.equal(readWorkspaceReservations(f.store, f.kingdomId)[0]!.recovery, true)
})

test('workspace terminal evidence alone cannot release the resource before Lease cleanup', t => {
  const f = fixture(t), path = f.directory('terminal'), input = f.task(path), handle = f.reserve(input)
  const prepared = f.prepare(input, handle).invoke(), id = prepared.intent.dispatch_id
  recordDispatchReceipt(f.store, id, { runtimeDispatchRef: 'msg', receiptJson: '{"type":"fixture/v1"}' })
  correlateRuntimeExecution(f.store, id, 'turn')
  f.store.transitionExecution(f.store.getExecution(prepared.execution.execution_id)!, 'RUNNING')
  recordTerminalEvidence(f.store, id, { evidenceJson: '{"type":"fixture/v1"}', executionTerminalState: 'COMPLETED', settleLease: true })
  assert.throws(() => f.reserve(f.task(path)), { code: 'WORKSPACE_BUSY' })
  advanceLeaseState(f.store, prepared.lease.lease_id, 'RELEASING')
  releaseExecutionLease(f.store, prepared.lease.lease_id, { fixture: true }, 'fixture cleanup confirmed')
  assert.equal(readWorkspaceReservations(f.store, f.kingdomId).length, 0)
  f.reserve(f.task(path))
})

test('workspace excludes unresolved legacy Leases and budget-only preparation in an overlapping directory', t => {
  const f = fixture(t), firstPath = f.directory('legacy-lease'), secondPath = f.directory('legacy-budget')
  f.lease(f.task(firstPath))
  assert.throws(() => f.reserve(f.task(firstPath, 'READ_ONLY')), { code: 'WORKSPACE_LEGACY_LEASE_BUSY' })
  const pending = f.task(secondPath); f.budget(pending)
  assert.throws(() => f.reserve(f.task(secondPath)), { code: 'WORKSPACE_LEGACY_PREPARATION_BUSY' })
  f.reserve(f.task(f.directory('unrelated')))
})

test('workspace and budget reservations roll back together when budget admission fails', t => {
  const f = fixture(t), input = f.task(f.directory('atomic')), before = f.store.eventSequence()
  let handle: WorkspaceAdmissionHandle | undefined
  assert.throws(() => f.store.withImmediateTransaction(() => {
    handle = f.reserve(input)
    reserveBudgetAdmission(f.store, { ...input, attemptNo: 0 })
  }), { code: 'BUDGET_ADMISSION_SCOPE' })
  assert.equal(f.store.eventSequence(), before)
  assert.equal(readWorkspaceReservations(f.store, f.kingdomId).length, 0)
  if (handle) assert.throws(() => cancelWorkspaceAdmissionIfSafe(f.store, handle!), { code: 'WORKSPACE_ADMISSION_MISMATCH' })
  f.reserve(input)
})

test('workspace TX3 rejects missing forged and cross-store handles and retains the exact original handle after rollback', t => {
  const f = fixture(t), other = fixture(t), input = f.task(f.directory('tx3')), handle = f.reserve(input)
  const foreign = other.reserve(other.task(other.directory('foreign'))), ready = f.prepare(input, handle)
  const before = { lease: f.store.getLease(ready.row.lease_id), decision: f.store.getCapabilityDecision(ready.decision.decision_id) }
  for (const candidate of [{} as WorkspaceAdmissionHandle, foreign]) {
    assert.throws(() => ready.invoke(candidate), { code: 'WORKSPACE_ADMISSION_REQUIRED' })
    assert.equal(f.store.listDispatches(f.kingdomId).length, 0)
    assert.deepEqual({ lease: f.store.getLease(ready.row.lease_id), decision: f.store.getCapabilityDecision(ready.decision.decision_id) }, before)
  }
  assert.throws(() => bindWorkspaceAdmissionInTransaction(f.store, handle, { ...input, dispatchId: 'missing', leaseId: ready.row.lease_id }), { code: 'WORKSPACE_TRANSACTION_REQUIRED' })
  assert.throws(() => f.store.withImmediateTransaction(() => bindWorkspaceAdmissionInTransaction(f.store, undefined,
    { ...input, dispatchId: 'missing', leaseId: ready.row.lease_id })), { code: 'WORKSPACE_ADMISSION_REQUIRED' })
  assert.equal(ready.invoke().intent.state, 'INTENDED')
})

test('workspace directory retargeting is rechecked atomically before dispatch', t => {
  const f = fixture(t), first = f.directory('first'), second = f.directory('second'), alias = join(f.root, 'movable-alias')
  symlinkSync(first, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const input = f.task(alias), handle = f.reserve(input), ready = f.prepare(input, handle)
  assert.equal(dirname(resolve(alias)), f.root)
  assert.equal(realpathSync.native(alias), realpathSync.native(first))
  assert.ok(!relative(f.root, realpathSync.native(alias)).startsWith('..'))
  rmSync(alias, { recursive: true, force: true })
  symlinkSync(second, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => ready.invoke(), { code: 'WORKSPACE_ADMISSION_MISMATCH' })
  assert.equal(f.store.listDispatches(f.kingdomId).length, 0)
  assert.equal(f.store.getLease(ready.row.lease_id)!.state, 'DISPATCH_READY')
})

test('workspace read-only admission cannot bind a Gate that actually grants workspace-write', t => {
  const f = fixture(t), path = f.directory('under-declared'), input = f.task(path, 'READ_ONLY')
  f.reserve(f.task(path, 'READ_ONLY'))
  const handle = f.reserve(input), ready = f.prepare(input, handle, undefined, 'workspace-write')
  const before = f.store.eventSequence()
  assert.throws(() => ready.invoke(), { code: 'WORKSPACE_ACCESS_MISMATCH' })
  assert.equal(f.store.eventSequence(), before)
  assert.equal(f.store.listDispatches(f.kingdomId).length, 0)
  assert.equal(f.store.getLease(ready.row.lease_id)!.state, 'DISPATCH_READY')
})
