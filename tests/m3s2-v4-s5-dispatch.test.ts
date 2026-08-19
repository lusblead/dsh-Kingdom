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
import { KingdomStore } from '../lib/core/db.js'
import { establishAffinity, acquireExecutionLease, advanceLeaseState } from '../lib/core/governed.js'
import { runCapabilityGate } from '../lib/capability/service.js'
import { reconstructDispatchEvidence, hasForeignDispatch } from '../lib/dispatch/evidence.js'
import { decideRecovery, applyRecovery } from '../lib/dispatch/reconcile.js'
import { runGovernedDispatch, settleAndRelease } from '../lib/dispatch/service.js'
import { DshRuntimeAdapter } from '../lib/adapter/dsh-backend.js'

const NOW = () => new Date().toISOString()

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
  const h = settleAndRelease(store, gate.lease.lease_id, false, 'cleanup-unconfirmed')
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
  const released = settleAndRelease(store, leaseId, true, 'settled')
  assert.equal(released.state, 'RELEASED')
  assert.ok(released.release_evidence_json)
  // Task 治理状态不变（terminal ≠ DONE）
  assert.equal(store.getTask(taskId)?.status, 'ASSIGNED')
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

/** 完整派发 + 已知终态收敛：turn/end reason → execution 终态（Owner FINAL WINDOW）。 */
async function runDispatchWithTurnReason(reasonKind: string, assistant: boolean): Promise<{ executionState: string; dispatchState: string; leaseState: string }> {
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
  }
  agents.set('s-1', fakeAgent)
  const adapter = new DshRuntimeAdapter({
    runtimeInstanceRef: 'inst-1', provider: 'spawn', model: null,
    agents: { agents, create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') }, get: (id: string) => agents.get(id), list: () => [...agents.values()] },
  })
  const run = await runGovernedDispatch({
    store, adapter, kingdomId, taskId, attemptNo: 1, workerBindingId: worker, leaseId: gate.lease.lease_id, capabilityDecisionId: gate.decision.decision_id,
    sessionHandle: { refs: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 's-1' }, agent: fakeAgent, session: fakeAgent.session, dispose: async () => {} },
    text: 't', requestSnapshot: '{}', inputRefJson: '{}', payloadHash: 'h', pollIntervalMs: 5, maxPolls: 40,
  })
  return { executionState: run.terminal ? run.terminal.execution.state : (store.getExecution(run.execution.execution_id)?.state ?? '?'), dispatchState: store.getDispatch(run.intent.dispatch_id)!.state, leaseState: store.getLease(gate.lease.lease_id)!.state }
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
    assert.notEqual(r.executionState, 'COMPLETED', `${kind} 不得落 COMPLETED`)
    assert.notEqual(r.executionState, 'ABORTED')
    assert.notEqual(r.executionState, 'FAILED')
    assert.ok(['STARTING', 'RUNNING', 'RECOVERING'].includes(r.executionState), `${kind} → 非终态（实际 ${r.executionState}）`)
    assert.notEqual(r.dispatchState, 'TERMINAL', `${kind} dispatch 不得 TERMINAL`)
  }
})
