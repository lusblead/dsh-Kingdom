/**
 * dsh-kingdom — M3-S5 Dispatch Evidence + Reconciliation / Recovery 验收测试。
 *
 * 覆盖（M3-S5 Thin Spec §2/§3/§4/§5）：
 * 事件链重建四态 / G12 外来检测 / fail-closed 恢复决策（SESSION_GONE≠TERMINAL、UNKNOWN 不超时 ABORT）/
 * TX-3..TX-5 完整派发 / Crash Matrix（§30 A–J 语义）/ settle 前置（cleanup 不明不 RELEASED）/
 * 全程不改 Task 治理状态。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KingdomStore } from '../lib/core/db.js'
import {
  establishAffinity,
  acquireExecutionLease,
  advanceLeaseState,
  createDispatchIntent,
  createGovernedExecution,
  markGovernedDispatchRecovering,
} from '../lib/core/governed.js'
import { runCapabilityGate } from '../lib/capability/service.js'
import { reconstructDispatchEvidence, hasForeignDispatch } from '../lib/dispatch/evidence.js'
import { decideRecovery, applyRecovery } from '../lib/dispatch/reconcile.js'
import { runGovernedDispatch, settleAndRelease } from '../lib/dispatch/service.js'
import type { CleanupReceipt } from '../lib/dispatch/service.js'
import { DshRuntimeAdapter } from '../lib/adapter/dsh-backend.js'
import {
  activateRunnerContextBrokerLaunch,
  createRunnerContextBrokerLaunch,
  deactivateRunnerContextBrokerLaunch,
} from '../lib/runner-context-broker.js'

const NOW = () => new Date().toISOString()

const confirmedCleanup = (): CleanupReceipt => ({
  status: 'CONFIRMED',
  evidenceJson: JSON.stringify({ type: 'DshEnforcementTeardownEvidence/v1', payload: { test: true } }),
  reason: 'test cleanup confirmed',
})

const unconfirmedCleanup = (status: 'RETURNED_FALSE' | 'THREW' | 'MISSING_EVIDENCE'): CleanupReceipt => ({
  status,
  evidenceJson: null,
  reason: `test cleanup ${status.toLowerCase()}`,
})

function makeEvents(events: { type: string; data?: Record<string, unknown> }[]): { events: readonly { type: string; data?: Record<string, unknown> }[] } {
  return { events }
}

// ── 1. 证据重建 ─────────────────────────────────────────────────────────────

test('S5 evidence: QUEUED/RUNNING/TERMINAL/UNKNOWN 四态 + terminalReason', () => {
  const ref = 'msg-1'
  // 找不到引用 → UNKNOWN
  assert.equal(reconstructDispatchEvidence(makeEvents([]), ref).state, 'UNKNOWN')
  // QUEUED：消息已入日志、无 turn
  let ev = reconstructDispatchEvidence(makeEvents([{ type: 'user/message', data: { id: ref } }]), ref)
  assert.equal(ev.state, 'QUEUED')
  assert.equal(ev.located, true)
  // RUNNING：turn/start 无 turn/end
  ev = reconstructDispatchEvidence(makeEvents([
    { type: 'user/message', data: { id: ref } },
    { type: 'turn/start', data: { turn: 1 } },
  ]), ref)
  assert.equal(ev.state, 'RUNNING')
  assert.equal(ev.turnObserved, 1)
  // TERMINAL：turn/end(completed) + assistant/message → COMPLETED
  ev = reconstructDispatchEvidence(makeEvents([
    { type: 'user/message', data: { id: ref } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'assistant/message', data: {} },
  ]), ref)
  assert.equal(ev.state, 'TERMINAL')
  assert.equal(ev.terminalOutcome, 'COMPLETED')
  assert.ok(ev.terminalReason?.includes('turn=1'))
  assert.equal(ev.assistantMessageObserved, true)
  // ★ 已知终态收敛（Owner FINAL WINDOW）：aborted→ABORTED；blocked/error/max-tokens→FAILED；interrupted→RECOVERING(null)
  const aborted = reconstructDispatchEvidence(makeEvents([
    { type: 'user/message', data: { id: ref } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } },
  ]), ref)
  assert.equal(aborted.state, 'TERMINAL')
  assert.equal(aborted.terminalOutcome, 'ABORTED', 'aborted → ABORTED')
  for (const kind of ['blocked', 'error', 'max-tokens']) {
    const ev2 = reconstructDispatchEvidence(makeEvents([
      { type: 'user/message', data: { id: ref } },
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind } } },
    ]), ref)
    assert.equal(ev2.state, 'TERMINAL', `${kind} 为明确终止 reason`)
    assert.equal(ev2.terminalOutcome, 'FAILED', `${kind} → FAILED`)
  }
  // interrupted → UNKNOWN（RECOVERING，非终态）
  const interrupted = reconstructDispatchEvidence(makeEvents([
    { type: 'user/message', data: { id: ref } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } },
  ]), ref)
  assert.equal(interrupted.state, 'UNKNOWN', 'interrupted 不得判 TERMINAL')
  assert.equal(interrupted.terminalOutcome, null, 'interrupted → RECOVERING（outcome null）')
  assert.equal(interrupted.turnEndReason, 'interrupted')
  // reason 缺失 → UNKNOWN（ambiguous → RECOVERING）
  const noReason = reconstructDispatchEvidence(makeEvents([
    { type: 'user/message', data: { id: ref } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { turn: 1 } },
  ]), ref)
  assert.equal(noReason.state, 'UNKNOWN', 'reason 缺失 → ambiguous → RECOVERING')
  // completed 但无 assistant → UNKNOWN（证据不足）
  const noAssistant = reconstructDispatchEvidence(makeEvents([
    { type: 'user/message', data: { id: ref } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]), ref)
  assert.equal(noAssistant.state, 'UNKNOWN', 'completed 但无 assistant/message → 证据不足，非 TERMINAL')
})

test('S5 evidence: G12 外来 user 消息检测', () => {
  const ref = 'msg-1'
  const session = makeEvents([
    { type: 'user/message', data: { id: ref } },
    { type: 'user/message', data: { id: 'foreign-msg' } },   // 非本 dispatch
    { type: 'turn/start', data: { turn: 1 } },
  ])
  const ev = reconstructDispatchEvidence(session, ref)
  assert.deepEqual(ev.foreignUserMessages, ['foreign-msg'])
  assert.equal(hasForeignDispatch(session, ref), true)
  assert.equal(hasForeignDispatch(makeEvents([{ type: 'user/message', data: { id: ref } }]), ref), false)
})

// ── 2. reconcile 决策 ───────────────────────────────────────────────────────

function makeDispatchRow(overrides: Partial<Record<string, unknown>> = {}): import('../lib/core/db.js').DispatchRecordRow {
  return {
    dispatch_id: 'd1', kingdom_id: 'k', lease_id: 'l1', execution_id: 'e1', task_id: 't1',
    attempt_no: 1, runtime_type: 'dsh', runtime_instance_ref: 'i', session_ref: 's1',
    state: 'CORRELATED', dispatch_request_snapshot: '{}', dispatch_input_ref_json: '{}',
    dispatch_payload_hash: 'h', runtime_dispatch_ref: 'msg-1', runtime_execution_ref: null,
    receipt_json: null, terminal_evidence_json: null, output_ref_json: null,
    dispatched_at: null, receipt_at: null, terminal_at: null, created_at: NOW(), updated_at: NOW(),
    ...overrides,
  } as import('../lib/core/db.js').DispatchRecordRow
}

test('S5 reconcile: 决策规则（WAIT/TERMINAL_OK/RECOVERING/UNTRUSTED）', () => {
  // 在途 → WAIT（不重发、不开新 attempt）
  assert.equal(decideRecovery({ store: {} as never, dispatch: makeDispatchRow(), sessionObservation: 'AVAILABLE', evidence: { located: true, turnObserved: 1, turnEndObserved: false, assistantMessageObserved: false, foreignUserMessages: [], state: 'RUNNING', terminalReason: null } }).action, 'WAIT')
  assert.equal(decideRecovery({ store: {} as never, dispatch: makeDispatchRow(), sessionObservation: 'AVAILABLE', evidence: { located: true, turnObserved: null, turnEndObserved: false, assistantMessageObserved: false, foreignUserMessages: [], state: 'QUEUED', terminalReason: null } }).action, 'WAIT')
  // terminal → TERMINAL_OK
  const ok = decideRecovery({ store: {} as never, dispatch: makeDispatchRow(), sessionObservation: 'AVAILABLE', evidence: { located: true, turnObserved: 1, turnEndObserved: true, assistantMessageObserved: true, foreignUserMessages: [], state: 'TERMINAL', terminalReason: 'ok' } })
  assert.equal(ok.action, 'TERMINAL_OK')
  // SESSION_GONE + UNKNOWN → RECOVERING（SESSION_GONE ≠ TERMINAL）
  const gone = decideRecovery({ store: {} as never, dispatch: makeDispatchRow(), sessionObservation: 'GONE', evidence: { located: false, turnObserved: null, turnEndObserved: false, assistantMessageObserved: false, foreignUserMessages: [], state: 'UNKNOWN', terminalReason: null } })
  assert.equal(gone.action, 'RECOVERING')
  // UNKNOWN 禁超时自动 ABORT（决策集里没有 ABORTED）
  const unknown = decideRecovery({ store: {} as never, dispatch: makeDispatchRow(), sessionObservation: 'UNKNOWN', evidence: { located: false, turnObserved: null, turnEndObserved: false, assistantMessageObserved: false, foreignUserMessages: [], state: 'UNKNOWN', terminalReason: null } })
  assert.equal(unknown.action, 'RECOVERING')
  // G12 外来 → UNTRUSTED_RECOVERING（最高优先级）
  const untrusted = decideRecovery({ store: {} as never, dispatch: makeDispatchRow(), sessionObservation: 'AVAILABLE', evidence: { located: true, turnObserved: 1, turnEndObserved: true, assistantMessageObserved: true, foreignUserMessages: ['x'], state: 'TERMINAL', terminalReason: 'ok' } })
  assert.equal(untrusted.action, 'UNTRUSTED_RECOVERING')
})

// ── 3. Crash Matrix 语义（§30 A–J → 状态 + 决策断言）──────────────────────

function makeCrashEnv(): { store: KingdomStore; kingdomId: string; worker: string; sup: string; terrA: string; taskId: string } {
  const store = new KingdomStore(':memory:')
  const kingdomId = 'k'
  store.insertKingdom({ kingdom_id: kingdomId, name: 'K', created_at: NOW(), owner_id: 'o1', owner_name: 'T' })
  const worker = `w-${Math.random().toString(36).slice(2, 8)}`
  const sup = `s-${Math.random().toString(36).slice(2, 8)}`
  store.insertBinding({ binding_id: worker, kingdom_id: kingdomId, role_type: 'WORKER', role_name: 'W', runtime_type: 'dsh', session_id: null, model_name: null, agent_name: null, session_meta: null, execution_profile_json: null, status: 'ACTIVE', retired_at: null, retired_reason: null, principal_id: null, created_at: NOW(), updated_at: NOW() })
  store.insertBinding({ binding_id: sup, kingdom_id: kingdomId, role_type: 'SUPERVISOR', role_name: 'S', runtime_type: 'dsh', session_id: null, model_name: null, agent_name: null, session_meta: null, execution_profile_json: null, status: 'ACTIVE', retired_at: null, retired_reason: null, principal_id: null, created_at: NOW(), updated_at: NOW() })
  const terrA = `t-${Math.random().toString(36).slice(2, 8)}`
  store.insertTerritory({ territory_id: terrA, kingdom_id: kingdomId, name: 'A', workspace_path: 'C:/terr-a', summary: null, supervisor_binding_id: sup, status: 'ACTIVE', deleted_at: null, deleted_reason: null, created_at: NOW() })
  const taskId = `task-${Math.random().toString(36).slice(2, 8)}`
  store.insertTask({ task_id: taskId, territory_id: terrA, parent_task_id: null, title: 'T', description: null, assigned_binding_id: worker, status: 'ASSIGNED', acceptance_criteria: null, result_summary: null, created_at: NOW(), updated_at: NOW() })
  return { store, kingdomId, worker, sup, terrA, taskId }
}

function makeFakePolicyAdapter(): DshRuntimeAdapter {
  const append = (s: { events: { type: string; data?: Record<string, unknown> }[] }, type: string, data?: Record<string, unknown>) => s.events.push({ type, ...(data ? { data } : {}) })
  return new DshRuntimeAdapter({
    runtimeInstanceRef: 'inst-1', provider: 'spawn', model: null,
    agents: { agents: new Map(), create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') }, get: () => undefined, list: () => [] },
    permission: { set: (s: never, name: string) => { append(s, 'permission/preset', { preset: name }); append(s, 'sandbox/mode', { mode: 'workspace-write' }); append(s, 'approval/policy', { policy: 'never' }) } },
    sandboxPolicy: { setSandboxMode: (s: never, mode: string) => append(s, 'sandbox/mode', { mode }) },
    approval: { setApprovalPolicy: (s: never, policy: string) => append(s, 'approval/policy', { policy }) },
  })
}

async function makeDispatchGateFixture(): Promise<{
  store: KingdomStore
  kingdomId: string
  worker: string
  taskId: string
  gate: Awaited<ReturnType<typeof runCapabilityGate>>
}> {
  const env = makeCrashEnv()
  const { store, kingdomId, worker, sup, terrA, taskId } = env
  store.setKingdomCapabilityCeiling(kingdomId, JSON.stringify({ 'tool:pwsh': true }))
  establishAffinity(store, {
    kingdomId,
    workerBindingId: worker,
    session: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 's-1' },
    territoryId: terrA,
  })
  const lease = acquireExecutionLease(store, {
    kingdomId,
    workerBindingId: worker,
    session: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 's-1' },
    territoryId: terrA,
    taskId,
    attemptNo: 1,
  })
  const context = {
    sessionRef: 's-1',
    agent: {
      ctx: { tools: { restrict: () => () => {}, guard: () => () => {}, schemas: () => [{ name: 'pwsh' }] } },
      session: { header: { cwd: 'C:/terr-a' }, events: [] as { type: string; data?: Record<string, unknown> }[] },
    },
  }
  const gate = await runCapabilityGate({
    store,
    adapter: makeFakePolicyAdapter(),
    kingdomId,
    taskId,
    attemptNo: 1,
    workerBindingId: worker,
    supervisorBindingId: sup,
    leaseId: lease.lease_id,
    requirementJson: JSON.stringify({ 'tool:pwsh': true }),
    ceilingJson: JSON.stringify({ 'tool:pwsh': true }),
    grant: { 'tool:pwsh': true },
    sandboxMode: 'workspace-write',
    context,
  })
  assert.equal(gate.materialized, true)
  return { store, kingdomId, worker, taskId, gate }
}

async function makeTx3FaultFixture() {
  const { store, kingdomId, worker, taskId, gate } = await makeDispatchGateFixture()
  const fakeAgent = {
    id: 's-1',
    status: 'idle' as const,
    session: {
      header: { cwd: 'C:/terr-a' },
      events: [] as { type: string; data?: Record<string, unknown> }[],
    },
    followupCalls: [] as { id: string }[],
    followup(message: { id: string }): void {
      this.followupCalls.push(message)
    },
    runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return job(new AbortController().signal)
    },
  }
  const agents = new Map<string, typeof fakeAgent>([['s-1', fakeAgent]])
  const adapter = new DshRuntimeAdapter({
    runtimeInstanceRef: 'inst-1',
    provider: 'spawn',
    model: null,
    agents: {
      agents,
      create: async () => { throw new Error('unused') },
      resume: async () => { throw new Error('unused') },
      get: id => agents.get(id),
      list: () => [...agents.values()],
    },
  })
  const before = {
    task: { ...store.getTask(taskId)! },
    decision: { ...store.getCapabilityDecision(gate.decision.decision_id)! },
    lease: { ...store.getLease(gate.lease.lease_id)! },
    events: store.listEventsSince(kingdomId, 0, 1000).map(row => ({ ...row })),
    revision: store.revision(kingdomId),
  }
  const run = (): ReturnType<typeof runGovernedDispatch> => runGovernedDispatch({
    store,
    adapter,
    kingdomId,
    taskId,
    attemptNo: 1,
    workerBindingId: worker,
    leaseId: gate.lease.lease_id,
    capabilityDecisionId: gate.decision.decision_id,
    sessionHandle: {
      refs: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 's-1' },
      agent: fakeAgent,
      session: fakeAgent.session,
      dispose: async () => {},
    },
    text: 'tx3 fault injection',
    requestSnapshot: '{}',
    inputRefJson: '{}',
    payloadHash: 'tx3-fault-hash',
    pollIntervalMs: 0,
    maxPolls: 0,
  })
  return { store, kingdomId, worker, taskId, gate, fakeAgent, adapter, before, run }
}

function assertTx3PreparationRolledBack(fixture: Awaited<ReturnType<typeof makeTx3FaultFixture>>): void {
  const { store, kingdomId, taskId, gate, fakeAgent, before } = fixture
  assert.equal(store.listExecutions(taskId).length, 0, 'TX-3 failure must not leave or retry an Execution')
  const currentDecision = store.getCapabilityDecision(gate.decision.decision_id)!
  assert.equal(currentDecision.execution_id, null, 'TX-3 failure must roll back Decision.execution_id')
  assert.deepEqual({ ...currentDecision }, before.decision, 'Decision must be byte-for-field unchanged')
  assert.equal(store.listDispatches(kingdomId).length, 0, 'TX-3 failure must not leave or retry a Dispatch')
  const currentLease = store.getLease(gate.lease.lease_id)!
  assert.equal(currentLease.state, 'DISPATCH_READY')
  assert.equal(currentLease.released_at, null)
  assert.equal(currentLease.release_evidence_json, null)
  assert.deepEqual({ ...currentLease }, before.lease, 'Lease progression/release fields must fully roll back')
  assert.deepEqual({ ...store.getTask(taskId)! }, before.task, 'TX-3 failure must not change Task governance')
  assert.equal(fakeAgent.followupCalls.length, 0, 'Runtime dispatch must not run before TX-3 commits')
  assert.equal(store.listWorkerResults(taskId).length, 0, 'TX-3 failure must not create terminal/claim evidence')
  assert.equal(store.revision(kingdomId), before.revision, 'rolled-back TX-3 events must not advance revision')
  assert.deepEqual(
    store.listEventsSince(kingdomId, 0, 1000).map(row => ({ ...row })),
    before.events,
    'all TX-3 events must roll back with ledger writes',
  )
}

test('S5 TX-3: Runtime identity failure happens before every preparation write', async (t) => {
  const fixture = await makeTx3FaultFixture()
  t.after(() => fixture.store.close())
  const originalIdentify = fixture.adapter.identify
  fixture.adapter.identify = () => { throw new Error('fault: tx3 identity') }
  try {
    await assert.rejects(fixture.run, /fault: tx3 identity/u)
  } finally {
    fixture.adapter.identify = originalIdentify
  }
  assertTx3PreparationRolledBack(fixture)
})

test('S5 TX-3: Intent preparation failure rolls back Execution and Decision binding', async (t) => {
  const fixture = await makeTx3FaultFixture()
  t.after(() => fixture.store.close())
  const originalInsertDispatchIntent = fixture.store.insertDispatchIntent
  fixture.store.insertDispatchIntent = (() => {
    throw new Error('fault: tx3 intent')
  }) as KingdomStore['insertDispatchIntent']
  try {
    await assert.rejects(fixture.run, /fault: tx3 intent/u)
  } finally {
    fixture.store.insertDispatchIntent = originalInsertDispatchIntent
  }
  assertTx3PreparationRolledBack(fixture)
})

test('S5 TX-3: Lease progression failure rolls back Intent, Execution, and Decision binding', async (t) => {
  const fixture = await makeTx3FaultFixture()
  t.after(() => fixture.store.close())
  const originalUpdateLeaseState = fixture.store.updateLeaseState
  const updateLeaseStateWithFault: KingdomStore['updateLeaseState'] = (
    leaseId,
    expectedState,
    nextState,
    extra = {},
    at,
  ) => {
    if (
      leaseId === fixture.gate.lease.lease_id
      && expectedState === 'DISPATCH_READY'
      && nextState === 'EXECUTING'
    ) {
      throw new Error('fault: tx3 lease progression')
    }
    return originalUpdateLeaseState.call(fixture.store, leaseId, expectedState, nextState, extra, at)
  }
  fixture.store.updateLeaseState = updateLeaseStateWithFault
  try {
    await assert.rejects(fixture.run, /fault: tx3 lease progression/u)
  } finally {
    fixture.store.updateLeaseState = originalUpdateLeaseState
  }
  assertTx3PreparationRolledBack(fixture)
})

test('R18 TX-3 broker registration failure recovers all three ledgers before Runtime dispatch', async (t) => {
  const fixture = await makeTx3FaultFixture()
  t.after(() => fixture.store.close())

  // A regular file at runRoot deterministically makes the Product-child
  // broker start fail. The Product still owns the committed TX-3 rows, so
  // registration must be the first fail-closed recovery boundary.
  const root = await mkdtemp(join(tmpdir(), 'dsh-kingdom-r18-register-fail-'))
  await rm(root, { recursive: true, force: true })
  await writeFile(root, 'not-a-directory', { encoding: 'utf8', flag: 'wx' })
  const launch = createRunnerContextBrokerLaunch({ runRoot: root })
  try {
    await assert.rejects(() => launch.connect(), 'failed broker launch must not become usable')
    activateRunnerContextBrokerLaunch(launch)
    await assert.rejects(fixture.run, /START_FAILED|RunnerContextBroker/u)

    const dispatch = fixture.store.listDispatches(fixture.kingdomId)[0]
    assert.ok(dispatch)
    assert.equal(dispatch.state, 'RECOVERING', 'registration failure must recover the committed Dispatch')
    assert.equal(fixture.store.getExecution(dispatch.execution_id)?.state, 'RECOVERING', 'Execution must recover atomically')
    assert.equal(fixture.store.getLease(dispatch.lease_id)?.state, 'RECOVERING', 'Lease must recover atomically')
    assert.equal(fixture.fakeAgent.followupCalls.length, 0, 'registration failure must not call Runtime dispatch')
    assert.equal(fixture.store.listWorkerResults(fixture.taskId).length, 0, 'registration failure must not create Claim evidence')
  } finally {
    deactivateRunnerContextBrokerLaunch(launch)
    await launch.close()
    await rm(root, { recursive: true, force: true })
  }
})

/** 走到 CORRELATED 的完整前置（affinity→lease→gate→execution→intent→receipt→correlate）。 */
// （本文件各用例自行装配；此处不再提供共享 helper）

test('S5 crash matrix: 各 Crash 点的恢复决策（不改 Task 治理、不重复执行、不伪造 terminal）', async () => {
  const env = makeCrashEnv()
  const { store, kingdomId, worker, sup, terrA, taskId } = env
  store.setKingdomCapabilityCeiling(kingdomId, JSON.stringify({ 'tool:pwsh': true }))
  establishAffinity(store, { kingdomId, workerBindingId: worker, session: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 's-1' }, territoryId: terrA })
  const lease = acquireExecutionLease(store, { kingdomId, workerBindingId: worker, session: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 's-1' }, territoryId: terrA, taskId, attemptNo: 1 })
  const ctx = { sessionRef: 's-1', agent: { ctx: { tools: { restrict: () => () => {}, guard: () => () => {}, schemas: () => [{ name: 'pwsh' }] } }, session: { header: { cwd: 'C:/terr-a' }, events: [] as { type: string; data?: Record<string, unknown> }[] } } }
  const gate = await runCapabilityGate({
    store, adapter: makeFakePolicyAdapter(), kingdomId, taskId, attemptNo: 1, workerBindingId: worker, supervisorBindingId: sup,
    leaseId: lease.lease_id, requirementJson: JSON.stringify({ 'tool:pwsh': true }), ceilingJson: JSON.stringify({ 'tool:pwsh': true }),
    grant: { 'tool:pwsh': true }, sandboxMode: 'workspace-write', context: ctx,
  })
  assert.equal(gate.materialized, true)

  // ── Crash D：INTENDED 已 commit、dispatch 未发生（无 runtime ref）──
  // 直接查：dispatch 不存在 → reconcile 语义 = 未见 dispatch → 可安全不重发（UNKNOWN → RECOVERING 或 zero-exec 释放）
  const dispatchRow = makeDispatchRow({ state: 'INTENDED', runtime_dispatch_ref: null })
  const d = decideRecovery({ store, dispatch: dispatchRow, sessionObservation: 'AVAILABLE', evidence: { located: false, turnObserved: null, turnEndObserved: false, assistantMessageObserved: false, foreignUserMessages: [], state: 'UNKNOWN', terminalReason: null } })
  assert.equal(d.action, 'RECOVERING')
  assert.equal(store.getTask(taskId)?.status, 'ASSIGNED', 'Crash 恢复不得改 Task 治理状态')

  // ── Crash G：CORRELATED、无 terminal 证据（事件显示 RUNNING）──
  const g = decideRecovery({ store, dispatch: makeDispatchRow({ state: 'CORRELATED' }), sessionObservation: 'AVAILABLE', evidence: { located: true, turnObserved: 1, turnEndObserved: false, assistantMessageObserved: false, foreignUserMessages: [], state: 'RUNNING', terminalReason: null } })
  assert.equal(g.action, 'WAIT', '执行在途：等待，不 settle、不开新 attempt')

  // ── Crash H：terminal 证据已到、cleanup 未确认（Lease SETTLING）──
  advanceLeaseState(store, gate.lease.lease_id, 'EXECUTING')
  advanceLeaseState(store, gate.lease.lease_id, 'SETTLING')
  const h = settleAndRelease(store, gate.lease.lease_id, unconfirmedCleanup('RETURNED_FALSE'), 'cleanup-unconfirmed')
  assert.equal(h.state, 'RECOVERING', 'cleanup 不明 → 禁 RELEASED，进 RECOVERING')

  // ── Crash I：cleanup 中（RELEASING）──
  // 从 RECOVERING 带 evidence 释放前，先确认 RECOVERING 语义
  assert.equal(store.getTask(taskId)?.status, 'ASSIGNED', '全程 Task 治理状态不变')
})

test('S5 crash: 完整 TX-3..TX-5 派发 + settle release 前置', async () => {
  const env = makeCrashEnv()
  const { store, kingdomId, worker, sup, terrA, taskId } = env
  store.setKingdomCapabilityCeiling(kingdomId, JSON.stringify({ 'tool:pwsh': true }))
  establishAffinity(store, { kingdomId, workerBindingId: worker, session: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 's-1' }, territoryId: terrA })
  const lease = acquireExecutionLease(store, { kingdomId, workerBindingId: worker, session: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 's-1' }, territoryId: terrA, taskId, attemptNo: 1 })
  const ctx = { sessionRef: 's-1', agent: { ctx: { tools: { restrict: () => () => {}, guard: () => () => {}, schemas: () => [{ name: 'pwsh' }] } }, session: { header: { cwd: 'C:/terr-a' }, events: [] as { type: string; data?: Record<string, unknown> }[] } } }
  const gate = await runCapabilityGate({
    store, adapter: makeFakePolicyAdapter(), kingdomId, taskId, attemptNo: 1, workerBindingId: worker, supervisorBindingId: sup,
    leaseId: lease.lease_id, requirementJson: JSON.stringify({ 'tool:pwsh': true }), ceilingJson: JSON.stringify({ 'tool:pwsh': true }),
    grant: { 'tool:pwsh': true }, sandboxMode: 'workspace-write', context: ctx,
  })
  assert.equal(gate.materialized, true)
  const leaseId = gate.lease.lease_id
  const decisionId = gate.decision.decision_id

  // fake agent：dispatch 时同步落事件（模拟 turn 完成）
  const agents = new Map<string, { id: string; status: 'idle'; session: { header: { cwd: string }; events: { type: string; data?: Record<string, unknown> }[] }; followupCalls: { id: string }[]; followup(msg: { id: string }): void }>()
  const fakeAgent = {
    id: 's-1', status: 'idle' as const, session: { header: { cwd: 'C:/terr-a' }, events: ctx.agent.session.events },
    followupCalls: [] as { id: string }[],
    followup(msg: { id: string }): void {
      this.followupCalls.push(msg)
      // 同步模拟 turn 完成（事件链 = terminal 证据）
      this.session.events.push({ type: 'user/message', data: { id: msg.id } })
      this.session.events.push({ type: 'turn/start', data: { turn: 1 } })
      this.session.events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      this.session.events.push({ type: 'assistant/message', data: {} })
    },
    runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return job(new AbortController().signal)
    },
  }
  agents.set('s-1', fakeAgent)
  const adapter = new DshRuntimeAdapter({
    runtimeInstanceRef: 'inst-1', provider: 'spawn', model: null,
    agents: {
      agents, create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') },
      get: (id: string) => agents.get(id), list: () => [...agents.values()],
    },
  })

  const run = await runGovernedDispatch({
    store, adapter,
    kingdomId, taskId, attemptNo: 1, workerBindingId: worker, leaseId, capabilityDecisionId: decisionId,
    sessionHandle: { refs: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 's-1' }, agent: fakeAgent, session: fakeAgent.session, dispose: async () => {} },
    text: 'do the task', requestSnapshot: '{"type":"req/v1"}', inputRefJson: '{"ref":"in"}', payloadHash: 'h',
    pollIntervalMs: 5, maxPolls: 50,
  })
  // TX-3..TX-5 终态
  assert.equal(run.execution.execution_contract, 'GOVERNED_PERSISTENT')
  assert.equal(store.getCapabilityDecision(decisionId)?.execution_id, run.execution.execution_id, 'decision.execution_id 已回填')
  assert.equal(run.receipt.refs.runtimeDispatchRef, fakeAgent.followupCalls[0].id, 'Receipt 引用 = UserMessage.id')
  assert.equal(run.dispatch.state, 'TERMINAL')
  assert.equal(run.terminal?.dispatch.state, 'TERMINAL')
  assert.equal(run.terminal?.execution.state, 'COMPLETED')
  assert.equal(run.terminal?.lease.state, 'SETTLING')
  // settle 后 release（cleanup ok）
  const released = settleAndRelease(store, leaseId, confirmedCleanup(), 'settled')
  assert.equal(released.state, 'RELEASED')
  assert.ok(released.release_evidence_json)
  // Task 治理状态不变（terminal ≠ DONE）
  assert.equal(store.getTask(taskId)?.status, 'ASSIGNED')
})

test('S5 settlement: false/throw/missing evidence 均保持 RECOVERING，只有 confirmed 才 RELEASED', async () => {
  for (const status of ['RETURNED_FALSE', 'THREW', 'MISSING_EVIDENCE'] as const) {
    const fixture = await makeDispatchGateFixture()
    const leaseId = fixture.gate.lease.lease_id
    advanceLeaseState(fixture.store, leaseId, 'EXECUTING')
    advanceLeaseState(fixture.store, leaseId, 'SETTLING')
    const recovering = settleAndRelease(
      fixture.store,
      leaseId,
      unconfirmedCleanup(status),
      'cleanup-recovery-test',
    )
    assert.equal(recovering.state, 'RECOVERING', status)
    assert.equal(recovering.released_at, null, `${status} 不得写 released_at`)
    assert.equal(recovering.release_evidence_json, null, `${status} 不得伪造 release evidence`)
    assert.match(recovering.release_reason ?? '', new RegExp(`cleanup=${status}`))
  }
})

test('G14/G17 trust fence unrecognized/tainted token 在 check、cleanup、release 上均 fail-closed', async () => {
  const events: { type: string; data?: Record<string, unknown> }[] = []
  const agent = {
    id: 's-fence',
    status: 'idle' as const,
    session: { header: { cwd: 'C:/terr-a' }, events },
    followup: (_message: { id: string }): void => {},
    runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return job(new AbortController().signal)
    },
  }
  const agents = new Map([[agent.id, agent]])
  const adapter = new DshRuntimeAdapter({
    runtimeInstanceRef: 'inst-fence',
    provider: 'spawn',
    model: null,
    agents: {
      agents,
      create: async () => { throw new Error('unused') },
      resume: async () => { throw new Error('unused') },
      get: (id: string) => agents.get(id),
      list: () => [...agents.values()],
    },
  })
  const request = {
    tools: ['tool:pwsh'],
    territoryPath: 'C:/terr-a',
    sandboxMode: 'workspace-write' as const,
    approvalPolicy: 'never' as const,
  }
  const context = { sessionRef: agent.id, agent }
  const expectation = { leaseId: 'lease-fence', sessionRef: agent.id }
  const unknownFence = {} as never

  assert.equal(adapter.checkTrustFence(unknownFence, 'settlement', expectation).status, 'UNKNOWN')
  assert.equal(adapter.releaseTrustFence(unknownFence, 'RELEASED', expectation).ok, false)
  await assert.rejects(
    () => adapter.cleanup(request, context, unknownFence, expectation),
    /unknown trust fence token/u,
  )

  const fence = await adapter.openTrustFence({
    leaseId: 'lease-fence',
    sessionRef: agent.id,
    runtimeDispatchRef: null,
    baselineEvents: [],
  })
  const tainted = adapter.bindTrustFence(fence, '', expectation)
  assert.equal(tainted.status, 'TAINTED')
  assert.equal(adapter.checkTrustFence(fence, 'settlement', expectation).ok, false)
  assert.equal(adapter.releaseTrustFence(fence, 'RELEASED', expectation).ok, false)
  assert.equal(adapter.releaseTrustFence(fence, 'RECOVERING', expectation).ok, true, 'tainted fence 只能关闭为 recovery，不得声明 RELEASED')
})

test('R5 G14 exact fence binding: cross-adapter/cross-lease/cross-session 均 fail-closed 且不释放', async () => {
  const makeAgent = (id: string) => ({
    id,
    status: 'idle' as const,
    session: { header: { cwd: 'C:/terr-a' }, events: [] as { type: string; data?: Record<string, unknown> }[] },
    followup: (_message: { id: string }): void => {},
    runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return job(new AbortController().signal)
    },
  })
  const agentA = makeAgent('s-r5-a')
  const agentB = makeAgent('s-r5-b')
  const agentsA = new Map([[agentA.id, agentA], [agentB.id, agentB]])
  const makeAdapter = (runtimeInstanceRef: string, agents: Map<string, ReturnType<typeof makeAgent>>) => new DshRuntimeAdapter({
    runtimeInstanceRef,
    provider: 'spawn',
    model: null,
    agents: {
      agents,
      create: async () => { throw new Error('unused') },
      resume: async () => { throw new Error('unused') },
      get: (id: string) => agents.get(id),
      list: () => [...agents.values()],
    },
  })
  const adapterA = makeAdapter('inst-r5-a', agentsA)
  const adapterB = makeAdapter('inst-r5-b', agentsA)
  const request = {
    tools: ['tool:pwsh'],
    territoryPath: 'C:/terr-a',
    sandboxMode: 'workspace-write' as const,
    approvalPolicy: 'never' as const,
  }
  const contextA = { sessionRef: agentA.id, agent: agentA }
  const expectationA = { leaseId: 'lease-r5-a', sessionRef: agentA.id }
  const fenceA = await adapterA.openTrustFence({
    ...expectationA,
    runtimeDispatchRef: null,
    baselineEvents: [],
  })

  assert.equal(
    adapterB.checkTrustFence(fenceA, 'settlement', expectationA).status,
    'UNKNOWN',
    '不同 Adapter instance 不得解释或释放对方 token',
  )
  assert.equal(adapterB.releaseTrustFence(fenceA, 'RELEASED', expectationA).ok, false)
  await assert.rejects(
    () => adapterB.cleanup(request, contextA, fenceA, expectationA),
    /unknown trust fence token/u,
  )

  const crossLease = adapterA.checkTrustFence(
    fenceA,
    'settlement',
    { leaseId: 'lease-r5-b', sessionRef: agentA.id },
  )
  assert.equal(crossLease.status, 'TAINTED', '同 Adapter 的 cross-lease expectation 必须污染并 fail-closed')
  assert.equal(adapterA.releaseTrustFence(fenceA, 'RELEASED', expectationA).ok, false)

  const fenceSession = await adapterA.openTrustFence({
    leaseId: 'lease-r5-session',
    sessionRef: agentA.id,
    runtimeDispatchRef: null,
    baselineEvents: [],
  })
  const crossSession = adapterA.checkTrustFence(
    fenceSession,
    'settlement',
    { leaseId: 'lease-r5-session', sessionRef: agentB.id },
  )
  assert.equal(crossSession.status, 'TAINTED', '同 Adapter 的 cross-session expectation 必须污染并 fail-closed')
  assert.equal(
    adapterA.releaseTrustFence(fenceSession, 'RELEASED', { leaseId: 'lease-r5-session', sessionRef: agentA.id }).ok,
    false,
  )
})

test('R5 settlement target binding: cross-lease/cross-session explicit settlement keeps target Lease RECOVERING', async () => {
  const env = makeCrashEnv()
  const { store, kingdomId, worker, sup, terrA, taskId } = env
  const makeAgent = (id: string) => ({
    id,
    status: 'idle' as const,
    session: { header: { cwd: 'C:/terr-a' }, events: [] as { type: string; data?: Record<string, unknown> }[] },
    followup: (_message: { id: string }): void => {},
    runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return job(new AbortController().signal)
    },
    ctx: { tools: { restrict: () => () => {}, guard: () => () => {}, schemas: () => [{ name: 'pwsh' }] } },
  })
  const agentA = makeAgent('s-r5-settle-a')
  const agentB = makeAgent('s-r5-settle-b')
  const agentC = makeAgent('s-r5-settle-c')
  const agents = new Map([[agentA.id, agentA], [agentB.id, agentB], [agentC.id, agentC]])
  const adapter = new DshRuntimeAdapter({
    runtimeInstanceRef: 'inst-r5-settle',
    provider: 'spawn',
    model: null,
    agents: {
      agents,
      create: async () => { throw new Error('unused') },
      resume: async () => { throw new Error('unused') },
      get: (id: string) => agents.get(id),
      list: () => [...agents.values()],
    },
  })
  const addWorker = (bindingId: string, sessionRef: string): void => {
    if (!store.getBindingById(bindingId)) {
      store.insertBinding({
        binding_id: bindingId,
        kingdom_id: kingdomId,
        role_type: 'WORKER',
        role_name: bindingId,
        runtime_type: 'dsh',
        session_id: null,
        model_name: null,
        agent_name: null,
        session_meta: null,
        execution_profile_json: null,
        status: 'ACTIVE',
        retired_at: null,
        retired_reason: null,
        principal_id: null,
        created_at: NOW(),
        updated_at: NOW(),
      })
    }
    establishAffinity(store, {
      kingdomId,
      workerBindingId: bindingId,
      session: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-r5-settle', sessionRef },
      territoryId: terrA,
    })
  }
  const workerB = 'worker-r5-b'
  const workerC = 'worker-r5-c'
  addWorker(worker, agentA.id)
  addWorker(workerB, agentB.id)
  addWorker(workerC, agentC.id)
  store.setKingdomCapabilityCeiling(kingdomId, JSON.stringify({ 'tool:pwsh': true }))
  const leaseA = acquireExecutionLease(store, {
    kingdomId, workerBindingId: worker,
    session: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-r5-settle', sessionRef: agentA.id },
    territoryId: terrA, taskId, attemptNo: 1,
  })
  const leaseB = acquireExecutionLease(store, {
    kingdomId, workerBindingId: workerB,
    session: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-r5-settle', sessionRef: agentB.id },
    territoryId: terrA, taskId, attemptNo: 2,
  })
  const leaseC = acquireExecutionLease(store, {
    kingdomId, workerBindingId: workerC,
    session: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-r5-settle', sessionRef: agentC.id },
    territoryId: terrA, taskId, attemptNo: 3,
  })
  const capabilityContext = (agent: ReturnType<typeof makeAgent>) => ({ sessionRef: agent.id, agent })
  for (const [lease, bindingId, agent] of [[leaseB, workerB, agentB], [leaseC, workerC, agentC]] as const) {
    const gate = await runCapabilityGate({
      store,
      adapter: makeFakePolicyAdapter(),
      kingdomId,
      taskId,
      attemptNo: lease.attempt_no,
      workerBindingId: bindingId,
      supervisorBindingId: sup,
      leaseId: lease.lease_id,
      requirementJson: JSON.stringify({ 'tool:pwsh': true }),
      ceilingJson: JSON.stringify({ 'tool:pwsh': true }),
      grant: { 'tool:pwsh': true },
      sandboxMode: 'workspace-write',
      context: capabilityContext(agent),
    })
    assert.equal(gate.materialized, true)
    advanceLeaseState(store, lease.lease_id, 'EXECUTING')
    advanceLeaseState(store, lease.lease_id, 'SETTLING')
  }

  const fenceA = await adapter.openTrustFence({
    leaseId: leaseA.lease_id,
    sessionRef: agentA.id,
    runtimeDispatchRef: null,
    baselineEvents: [],
  })
  const crossLease = settleAndRelease(
    store,
    leaseB.lease_id,
    confirmedCleanup(),
    'cross-lease-settlement',
    { adapter, fence: fenceA, leaseId: leaseB.lease_id, sessionRef: agentB.id },
  )
  assert.equal(crossLease.state, 'RECOVERING')
  assert.equal(store.getLease(leaseB.lease_id)?.state, 'RECOVERING', 'cross-lease token 不得释放目标 Lease')

  const fenceC = await adapter.openTrustFence({
    leaseId: leaseC.lease_id,
    sessionRef: agentC.id,
    runtimeDispatchRef: null,
    baselineEvents: agentC.session.events,
  })
  const otherAdapter = new DshRuntimeAdapter({
    runtimeInstanceRef: 'inst-r5-other',
    provider: 'spawn',
    model: null,
    agents: {
      agents,
      create: async () => { throw new Error('unused') },
      resume: async () => { throw new Error('unused') },
      get: (id: string) => agents.get(id),
      list: () => [...agents.values()],
    },
  })
  const crossAdapter = settleAndRelease(
    store,
    leaseC.lease_id,
    confirmedCleanup(),
    'cross-adapter-settlement',
    { adapter: otherAdapter, fence: fenceC, leaseId: leaseC.lease_id, sessionRef: agentC.id },
  )
  assert.equal(crossAdapter.state, 'RECOVERING')
  assert.equal(store.getLease(leaseC.lease_id)?.state, 'RECOVERING', 'cross-adapter token 不得释放目标 Lease')

  const crossSession = settleAndRelease(
    store,
    leaseC.lease_id,
    confirmedCleanup(),
    'cross-session-settlement',
    { adapter, fence: fenceC, leaseId: leaseC.lease_id, sessionRef: agentB.id },
  )
  assert.equal(crossSession.state, 'RECOVERING')
  assert.equal(store.getLease(leaseC.lease_id)?.state, 'RECOVERING', 'cross-session token 不得释放目标 Lease')
})

test('S5 dispatch: session.events 是 getter（真实 DSH 每次访问返回新数组）→ 轮询每轮重读仍达 terminal（正式入口 E2E seam）', async () => {
  const env = makeCrashEnv()
  const { store, kingdomId, worker, sup, terrA, taskId } = env
  store.setKingdomCapabilityCeiling(kingdomId, JSON.stringify({ 'tool:pwsh': true }))
  establishAffinity(store, { kingdomId, workerBindingId: worker, session: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 's-1' }, territoryId: terrA })
  const lease = acquireExecutionLease(store, { kingdomId, workerBindingId: worker, session: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 's-1' }, territoryId: terrA, taskId, attemptNo: 1 })
  const ctx = { sessionRef: 's-1', agent: { ctx: { tools: { restrict: () => () => {}, guard: () => () => {}, schemas: () => [{ name: 'pwsh' }] } }, session: { header: { cwd: 'C:/terr-a' }, events: [] as { type: string; data?: Record<string, unknown> }[] } } }
  const gate = await runCapabilityGate({
    store, adapter: makeFakePolicyAdapter(), kingdomId, taskId, attemptNo: 1, workerBindingId: worker, supervisorBindingId: sup,
    leaseId: lease.lease_id, requirementJson: JSON.stringify({ 'tool:pwsh': true }), ceilingJson: JSON.stringify({ 'tool:pwsh': true }),
    grant: { 'tool:pwsh': true }, sandboxMode: 'workspace-write', context: ctx,
  })
  assert.equal(gate.materialized, true)
  // 真实 DSH Session：`get events()` 每次访问返回**新的投影数组**（@deepseek-ai/dsh-session/src/index.ts:559）。
  // 旧实现捕获一次快照 → 轮询永远看不到 dispatch 之后到达的 turn/end/assistant → 60s 超时（正式入口 E2E 实证）。
  const backing: { type: string; data?: Record<string, unknown> }[] = []
  const sessionLike = {
    header: { cwd: 'C:/terr-a' },
    get events(): { type: string; data?: Record<string, unknown> }[] { return [...backing] },
  }
  const fakeAgent = {
    id: 's-1', status: 'idle' as const, session: sessionLike,
    followup(msg: { id: string }): void {
      backing.push({ type: 'user/message', data: { id: msg.id } })
      backing.push({ type: 'turn/start', data: { turn: 1 } })
      backing.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      backing.push({ type: 'assistant/message', data: {} })
    },
    runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return job(new AbortController().signal)
    },
  }
  const agents = new Map<string, typeof fakeAgent>()
  agents.set('s-1', fakeAgent)
  const adapter = new DshRuntimeAdapter({
    runtimeInstanceRef: 'inst-1', provider: 'spawn', model: null,
    agents: { agents, create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') }, get: (id: string) => agents.get(id) as never, list: () => [...agents.values()] as never[] },
  })
  const run = await runGovernedDispatch({
    store, adapter, kingdomId, taskId, attemptNo: 1, workerBindingId: worker, leaseId: gate.lease.lease_id, capabilityDecisionId: gate.decision.decision_id,
    sessionHandle: { refs: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 's-1' }, agent: fakeAgent, session: sessionLike, dispose: async () => {} },
    text: 't', requestSnapshot: '{}', inputRefJson: '{}', payloadHash: 'h', pollIntervalMs: 5, maxPolls: 50,
  })
  assert.ok(run.terminal !== null, 'getter 版 session.events 必须轮询到 terminal')
  assert.equal(run.dispatch.state, 'TERMINAL')
  assert.equal(run.terminal?.execution.state, 'COMPLETED')
  assert.equal(run.terminal?.lease.state, 'SETTLING')
})

test('S5 dispatch: correlation window 后首次同时看到 turn+terminal 时先 correlate 再 terminal', async (t) => {
  const { store, kingdomId, worker, taskId, gate } = await makeDispatchGateFixture()
  t.after(() => store.close())
  const taskBefore = { ...store.getTask(taskId)! }
  let eventReads = 0
  let runtimeDispatchRef: string | null = null
  const sessionLike = {
    header: { cwd: 'C:/terr-a' },
    get events(): { type: string; data?: Record<string, unknown> }[] {
      eventReads++
      if (eventReads <= 10 || runtimeDispatchRef === null) return []
      return [
        { type: 'user/message', data: { id: runtimeDispatchRef } },
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
        { type: 'assistant/message', data: {} },
      ]
    },
  }
  const fakeAgent = {
    id: 's-1',
    status: 'idle' as const,
    session: sessionLike,
    followup(message: { id: string }): void { runtimeDispatchRef = message.id },
    runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return job(new AbortController().signal)
    },
  }
  const agents = new Map<string, typeof fakeAgent>([['s-1', fakeAgent]])
  const adapter = new DshRuntimeAdapter({
    runtimeInstanceRef: 'inst-1',
    provider: 'spawn',
    model: null,
    agents: {
      agents,
      create: async () => { throw new Error('unused') },
      resume: async () => { throw new Error('unused') },
      get: id => agents.get(id),
      list: () => [...agents.values()],
    },
  })

  const run = await runGovernedDispatch({
    store,
    adapter,
    kingdomId,
    taskId,
    attemptNo: 1,
    workerBindingId: worker,
    leaseId: gate.lease.lease_id,
    capabilityDecisionId: gate.decision.decision_id,
    sessionHandle: {
      refs: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 's-1' },
      agent: fakeAgent,
      session: sessionLike,
      dispose: async () => {},
    },
    text: 'late terminal',
    requestSnapshot: '{}',
    inputRefJson: '{}',
    payloadHash: 'late-terminal-hash',
    pollIntervalMs: 0,
    maxPolls: 11,
  })

  assert.ok(eventReads >= 11, `前十次 correlation poll 无证据，第十一次才同时出现 turn+terminal（含 fence 观察读数=${eventReads}）`)
  assert.equal(run.terminal?.dispatch.state, 'TERMINAL')
  assert.equal(run.execution.state, 'COMPLETED')
  assert.equal(run.lease.state, 'SETTLING')
  assert.equal(store.listExecutions(taskId).length, 1)
  assert.equal(store.listDispatches(kingdomId).length, 1)
  assert.deepEqual({ ...store.getTask(taskId)! }, taskBefore)
})

test('S5 dispatch: late correlation 写入异常后原子进入三层 RECOVERING', async (t) => {
  const { store, kingdomId, worker, taskId, gate } = await makeDispatchGateFixture()
  t.after(() => store.close())
  const taskBefore = { ...store.getTask(taskId)! }
  let eventReads = 0
  let runtimeDispatchRef: string | null = null
  const sessionLike = {
    header: { cwd: 'C:/terr-a' },
    get events(): { type: string; data?: Record<string, unknown> }[] {
      eventReads++
      if (eventReads <= 10 || runtimeDispatchRef === null) return []
      return [
        { type: 'user/message', data: { id: runtimeDispatchRef } },
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
        { type: 'assistant/message', data: {} },
      ]
    },
  }
  const fakeAgent = {
    id: 's-1',
    status: 'idle' as const,
    session: sessionLike,
    followup(message: { id: string }): void { runtimeDispatchRef = message.id },
    runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return job(new AbortController().signal)
    },
  }
  const agents = new Map<string, typeof fakeAgent>([['s-1', fakeAgent]])
  const adapter = new DshRuntimeAdapter({
    runtimeInstanceRef: 'inst-1',
    provider: 'spawn',
    model: null,
    agents: {
      agents,
      create: async () => { throw new Error('unused') },
      resume: async () => { throw new Error('unused') },
      get: id => agents.get(id),
      list: () => [...agents.values()],
    },
  })

  const originalTransition = store.transitionExecution
  let injected = false
  const transitionWithFailure: KingdomStore['transitionExecution'] = (execution, to, patch = {}) => {
    if (!injected && to === 'RUNNING') {
      injected = true
      throw new Error('injected late correlation execution failure')
    }
    return originalTransition.call(store, execution, to, patch)
  }
  store.transitionExecution = transitionWithFailure
  try {
    await assert.rejects(
      () => runGovernedDispatch({
        store,
        adapter,
        kingdomId,
        taskId,
        attemptNo: 1,
        workerBindingId: worker,
        leaseId: gate.lease.lease_id,
        capabilityDecisionId: gate.decision.decision_id,
        sessionHandle: {
          refs: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 's-1' },
          agent: fakeAgent,
          session: sessionLike,
          dispose: async () => {},
        },
        text: 'late correlation failure',
        requestSnapshot: '{}',
        inputRefJson: '{}',
        payloadHash: 'late-correlation-failure-hash',
        pollIntervalMs: 0,
        maxPolls: 11,
      }),
      /injected late correlation execution failure/u,
    )
  } finally {
    store.transitionExecution = originalTransition
  }

  const dispatch = store.listDispatches(kingdomId)[0]!
  const execution = store.listExecutions(taskId)[0]!
  const lease = store.getLease(gate.lease.lease_id)!
  assert.equal(eventReads, 11)
  assert.equal(dispatch.state, 'RECOVERING')
  assert.equal(execution.state, 'RECOVERING')
  assert.equal(lease.state, 'RECOVERING')
  assert.equal(dispatch.terminal_evidence_json, null)
  assert.equal(lease.release_evidence_json, null)
  assert.equal(store.listDispatches(kingdomId).length, 1, '异常不得 redispatch')
  assert.equal(store.listExecutions(taskId).length, 1, '异常不得 retry')
  assert.deepEqual({ ...store.getTask(taskId)! }, taskBefore)
})

test('S5 dispatch: terminal poll exhaustion atomically returns all three current RECOVERING rows', async (t) => {
  const { store, kingdomId, worker, taskId, gate } = await makeDispatchGateFixture()
  t.after(() => store.close())
  const taskBefore = { ...store.getTask(taskId)! }
  const fakeAgent = {
    id: 's-1',
    status: 'idle' as const,
    session: { header: { cwd: 'C:/terr-a' }, events: [] as { type: string; data?: Record<string, unknown> }[] },
    followupCalls: [] as { id: string }[],
    followup(message: { id: string }): void {
      this.followupCalls.push(message)
      // Receipt exists, but no Runtime turn/terminal evidence is observable.
    },
    runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return job(new AbortController().signal)
    },
  }
  const agents = new Map<string, typeof fakeAgent>([['s-1', fakeAgent]])
  const adapter = new DshRuntimeAdapter({
    runtimeInstanceRef: 'inst-1',
    provider: 'spawn',
    model: null,
    agents: {
      agents,
      create: async () => { throw new Error('unused') },
      resume: async () => { throw new Error('unused') },
      get: id => agents.get(id),
      list: () => [...agents.values()],
    },
  })

  const run = await runGovernedDispatch({
    store,
    adapter,
    kingdomId,
    taskId,
    attemptNo: 1,
    workerBindingId: worker,
    leaseId: gate.lease.lease_id,
    capabilityDecisionId: gate.decision.decision_id,
    sessionHandle: {
      refs: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 's-1' },
      agent: fakeAgent,
      session: fakeAgent.session,
      dispose: async () => {},
    },
    text: 'bounded timeout',
    requestSnapshot: '{}',
    inputRefJson: '{}',
    payloadHash: 'timeout-hash',
    pollIntervalMs: 0,
    maxPolls: 0,
  })

  assert.equal(run.terminal, null, 'RECOVERING must not be represented as fake terminal evidence')
  assert.equal(run.execution.state, 'RECOVERING')
  assert.equal(run.lease.state, 'RECOVERING')
  assert.equal(run.dispatch.state, 'RECOVERING')
  assert.equal(store.getExecution(run.execution.execution_id)!.state, 'RECOVERING')
  assert.equal(store.getLease(run.lease.lease_id)!.state, 'RECOVERING')
  assert.equal(store.getDispatch(run.dispatch.dispatch_id)!.state, 'RECOVERING')
  assert.deepEqual({ ...store.getTask(taskId)! }, taskBefore)
  assert.equal(store.listExecutions(taskId).length, 1, 'timeout must not open a retry attempt')
  assert.equal(store.listDispatches(kingdomId).length, 1, 'timeout must not redispatch')
  assert.equal(run.lease.release_evidence_json, null)
  assert.equal(run.lease.released_at, null)
  assert.equal(run.dispatch.terminal_evidence_json, null)
  assert.equal(run.dispatch.terminal_at, null)

  const eventCount = store.listEventsSince(kingdomId, 0, 1000).length
  const repeated = markGovernedDispatchRecovering(
    store,
    run.dispatch.dispatch_id,
    'TERMINAL_POLL_EXHAUSTED',
  )
  assert.deepEqual({
    dispatch: { ...repeated.dispatch },
    lease: { ...repeated.lease },
    execution: { ...repeated.execution },
  }, {
    dispatch: { ...run.dispatch },
    lease: { ...run.lease },
    execution: { ...run.execution },
  })
  assert.equal(store.listEventsSince(kingdomId, 0, 1000).length, eventCount,
    'idempotent recovery readback must emit no duplicate event')
})

test('G14/G17 terminal evidence 后的 fence check 发现 late foreign 时不进入 cleanup', async (t) => {
  const { store, kingdomId, worker, taskId, gate } = await makeDispatchGateFixture()
  t.after(() => store.close())
  const events: { type: string; data?: Record<string, unknown> }[] = []
  const fakeAgent = {
    id: 's-1',
    status: 'idle' as const,
    session: { header: { cwd: 'C:/terr-a' }, events },
    followup(message: { id: string }): void {
      events.push({ type: 'user/message', data: { id: message.id } })
      events.push({ type: 'turn/start', data: { turn: 1 } })
      events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      events.push({ type: 'assistant/message', data: {} })
    },
    runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return job(new AbortController().signal)
    },
  }
  const agents = new Map([[fakeAgent.id, fakeAgent]])
  const adapter = new DshRuntimeAdapter({
    runtimeInstanceRef: 'inst-1',
    provider: 'spawn',
    model: null,
    agents: {
      agents,
      create: async () => { throw new Error('unused') },
      resume: async () => { throw new Error('unused') },
      get: (id: string) => agents.get(id),
      list: () => [...agents.values()],
    },
  })
  const originalCheck = adapter.checkTrustFence.bind(adapter)
  let injected = false
  adapter.checkTrustFence = (fence, phase) => {
    // bindTrustFence uses the backend-private inspect path; this hook only
    // fires after the terminal evidence projection has already been observed.
    if (!injected && phase === 'terminal-write') {
      injected = true
      events.push({ type: 'user/message', data: { id: 'late-fence-foreign' } })
    }
    return originalCheck(fence, phase)
  }
  let cleanupCalls = 0
  const run = await runGovernedDispatch({
    store,
    adapter,
    kingdomId,
    taskId,
    attemptNo: 1,
    workerBindingId: worker,
    leaseId: gate.lease.lease_id,
    capabilityDecisionId: gate.decision.decision_id,
    sessionHandle: {
      refs: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 's-1' },
      agent: fakeAgent,
      session: fakeAgent.session,
      dispose: async () => {},
    },
    text: 'late fence check',
    requestSnapshot: '{}',
    inputRefJson: '{}',
    payloadHash: 'late-fence-check-hash',
    pollIntervalMs: 0,
    maxPolls: 3,
    cleanup: async () => {
      cleanupCalls++
      return confirmedCleanup()
    },
  })

  assert.equal(injected, true)
  assert.equal(run.terminal, null, 'late foreign activity must prevent terminal ledger')
  assert.equal(cleanupCalls, 0, 'tainted terminal-write fence must not call cleanup')
  assert.equal(run.dispatch.state, 'RECOVERING')
  assert.equal(run.execution.state, 'RECOVERING')
  assert.equal(run.lease.state, 'RECOVERING')
  assert.equal(store.getDispatch(run.dispatch.dispatch_id)?.terminal_evidence_json, null)
})

test('S5 recovery seam rolls back Dispatch and Lease when Execution recovery fails', async (t) => {
  const { store, kingdomId, worker, taskId, gate } = await makeDispatchGateFixture()
  t.after(() => store.close())
  const execution = createGovernedExecution(store, {
    taskId,
    attemptNo: 1,
    workerBindingId: worker,
    leaseId: gate.lease.lease_id,
    capabilityDecisionId: gate.decision.decision_id,
  })
  const dispatch = createDispatchIntent(store, {
    kingdomId,
    leaseId: gate.lease.lease_id,
    executionId: execution.execution_id,
    taskId,
    attemptNo: 1,
    session: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 's-1' },
    requestSnapshot: '{}',
    inputRefJson: '{}',
    payloadHash: 'rollback-hash',
  })
  advanceLeaseState(store, gate.lease.lease_id, 'EXECUTING')
  const taskBefore = { ...store.getTask(taskId)! }
  const eventCountBefore = store.listEventsSince(kingdomId, 0, 1000).length
  const originalTransition = store.transitionExecution
  store.transitionExecution = (() => {
    throw new Error('injected execution recovery failure')
  }) as KingdomStore['transitionExecution']
  try {
    assert.throws(
      () => applyRecovery(store, dispatch, {
        action: 'RECOVERING',
        reason: 'test-only unknown evidence',
      }),
      /injected execution recovery failure/u,
    )
  } finally {
    store.transitionExecution = originalTransition
  }

  assert.equal(store.getDispatch(dispatch.dispatch_id)!.state, 'INTENDED')
  assert.equal(store.getLease(gate.lease.lease_id)!.state, 'EXECUTING')
  assert.equal(store.getExecution(execution.execution_id)!.state, 'STARTING')
  assert.deepEqual({ ...store.getTask(taskId)! }, taskBefore)
  assert.equal(store.listEventsSince(kingdomId, 0, 1000).length, eventCountBefore,
    'all recovery events must roll back with the three ledger writes')
})

/** 完整派发 + 已知终态收敛：turn/end reason → execution 终态（Owner FINAL WINDOW）。 */
async function runDispatchWithTurnReason(reasonKind: string, assistant: boolean): Promise<{
  executionState: string
  dispatchState: string
  leaseState: string
  terminal: boolean
  executionCount: number
  dispatchCount: number
  releaseEvidence: string | null
  terminalEvidence: string | null
}> {
  const env = makeCrashEnv()
  const { store, kingdomId, worker, sup, terrA, taskId } = env
  store.setKingdomCapabilityCeiling(kingdomId, JSON.stringify({ 'tool:pwsh': true }))
  establishAffinity(store, { kingdomId, workerBindingId: worker, session: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 's-1' }, territoryId: terrA })
  const lease = acquireExecutionLease(store, { kingdomId, workerBindingId: worker, session: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 's-1' }, territoryId: terrA, taskId, attemptNo: 1 })
  const ctx = { sessionRef: 's-1', agent: { ctx: { tools: { restrict: () => () => {}, guard: () => () => {}, schemas: () => [{ name: 'pwsh' }] } }, session: { header: { cwd: 'C:/terr-a' }, events: [] as { type: string; data?: Record<string, unknown> }[] } } }
  const gate = await runCapabilityGate({
    store, adapter: makeFakePolicyAdapter(), kingdomId, taskId, attemptNo: 1, workerBindingId: worker, supervisorBindingId: sup,
    leaseId: lease.lease_id, requirementJson: JSON.stringify({ 'tool:pwsh': true }), ceilingJson: JSON.stringify({ 'tool:pwsh': true }),
    grant: { 'tool:pwsh': true }, sandboxMode: 'workspace-write', context: ctx,
  })
  assert.equal(gate.materialized, true)
  const agents = new Map<string, { id: string; status: 'idle'; session: { header: { cwd: string }; events: { type: string; data?: Record<string, unknown> }[] }; followup(msg: { id: string }): void }>()
  const fakeAgent = {
    id: 's-1', status: 'idle' as const, session: { header: { cwd: 'C:/terr-a' }, events: ctx.agent.session.events },
    followup(msg: { id: string }): void {
      this.session.events.push({ type: 'user/message', data: { id: msg.id } })
      this.session.events.push({ type: 'turn/start', data: { turn: 1 } })
      this.session.events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: reasonKind } } })
      if (assistant) this.session.events.push({ type: 'assistant/message', data: {} })
    },
    runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return job(new AbortController().signal)
    },
  }
  agents.set('s-1', fakeAgent)
  const adapter = new DshRuntimeAdapter({
    runtimeInstanceRef: 'inst-1', provider: 'spawn', model: null,
    agents: { agents, create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') }, get: (id: string) => agents.get(id), list: () => [...agents.values()] },
  })
  const taskBefore = { ...store.getTask(taskId)! }
  const run = await runGovernedDispatch({
    store, adapter, kingdomId, taskId, attemptNo: 1, workerBindingId: worker, leaseId: gate.lease.lease_id, capabilityDecisionId: gate.decision.decision_id,
    sessionHandle: { refs: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 's-1' }, agent: fakeAgent, session: fakeAgent.session, dispose: async () => {} },
    text: 't', requestSnapshot: '{}', inputRefJson: '{}', payloadHash: 'h', pollIntervalMs: 5, maxPolls: 40,
  })
  assert.deepEqual({ ...store.getTask(taskId)! }, taskBefore, 'Runtime terminal/recovery must not decide Task governance')
  return {
    executionState: run.execution.state,
    dispatchState: run.dispatch.state,
    leaseState: run.lease.state,
    terminal: run.terminal !== null,
    executionCount: store.listExecutions(taskId).length,
    dispatchCount: store.listDispatches(kingdomId).length,
    releaseEvidence: run.lease.release_evidence_json,
    terminalEvidence: run.dispatch.terminal_evidence_json,
  }
}

test('S5 outcome 收敛：aborted→ABORTED；blocked/error/max-tokens→FAILED（执行终态落账）', async () => {
  const aborted = await runDispatchWithTurnReason('aborted', false)
  assert.equal(aborted.executionState, 'ABORTED', 'aborted turn → execution ABORTED')
  assert.equal(aborted.dispatchState, 'TERMINAL')
  assert.equal(aborted.leaseState, 'SETTLING')
  for (const kind of ['blocked', 'error', 'max-tokens']) {
    const r = await runDispatchWithTurnReason(kind, false)
    assert.equal(r.executionState, 'FAILED', `${kind} turn → execution FAILED`)
    assert.equal(r.dispatchState, 'TERMINAL')
  }
})

test('S5 outcome 收敛：interrupted / completed 无 assistant → 不落终态（RECOVERING 语义）', async () => {
  for (const kind of ['interrupted', 'completed']) {
    const r = await runDispatchWithTurnReason(kind, false)
    assert.equal(r.terminal, false, `${kind} must not fabricate terminal evidence`)
    assert.equal(r.executionState, 'RECOVERING')
    assert.equal(r.leaseState, 'RECOVERING')
    assert.equal(r.dispatchState, 'RECOVERING')
    assert.equal(r.executionCount, 1, `${kind} must not retry with another Execution`)
    assert.equal(r.dispatchCount, 1, `${kind} must not redispatch`)
    assert.equal(r.releaseEvidence, null, `${kind} must not claim release cleanup`)
    assert.equal(r.terminalEvidence, null, `${kind} must not persist terminal evidence`)
  }
})
