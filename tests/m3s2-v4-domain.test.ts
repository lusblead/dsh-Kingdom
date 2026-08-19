/**
 * dsh-kingdom — M3-S2 v4 Domain API 验收测试（v0.8）。
 *
 * 覆盖（Owner v0.8 施工 Prompt §15/§16）：
 * valid path / invalid state transition / stale state CAS / concurrent lease /
 * mismatched territory / invalid decision / immutable ledger / fake relation / delete rejection。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KingdomStore, StaleStateError } from '../lib/core/db.js'
import {
  establishAffinity,
  retireAffinity,
  acquireExecutionLease,
  advanceLeaseState,
  setLeasePlan,
  bindCapabilityDecision,
  releaseExecutionLease,
  recordCapabilityDecision,
  createGovernedExecution,
  createDispatchIntent,
  recordDispatchReceipt,
  correlateRuntimeExecution,
  recordTerminalEvidence,
  advanceDispatchState,
  markLeaseRecovering,
  markDispatchRecovering,
  markExecutionRecovering,
  GovernedApiError,
} from '../lib/core/governed.js'

const KID = 'k'
const SESSION = { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 's-1' }
const NOW = () => new Date().toISOString()

function makeStore(): { store: KingdomStore; worker: string; sup: string; terrA: string; taskId: string } {
  const store = new KingdomStore(':memory:')
  store.insertKingdom({ kingdom_id: KID, name: 'K', created_at: NOW(), owner_id: 'o1', owner_name: 'T' })
  const sup = `sup-${Math.random().toString(36).slice(2, 8)}`
  const worker = `w-${Math.random().toString(36).slice(2, 8)}`
  store.insertBinding({
    binding_id: sup, kingdom_id: KID, role_type: 'SUPERVISOR', role_name: 'Sup',
    runtime_type: 'dsh', session_id: null, model_name: null, agent_name: null, session_meta: null,
    execution_profile_json: null, status: 'ACTIVE', retired_at: null, retired_reason: null,
    principal_id: null, created_at: NOW(), updated_at: NOW(),
  })
  store.insertBinding({
    binding_id: worker, kingdom_id: KID, role_type: 'WORKER', role_name: 'W',
    runtime_type: 'dsh', session_id: null, model_name: null, agent_name: null, session_meta: null,
    execution_profile_json: null, status: 'ACTIVE', retired_at: null, retired_reason: null,
    principal_id: null, created_at: NOW(), updated_at: NOW(),
  })
  const terrA = `terr-${Math.random().toString(36).slice(2, 8)}`
  store.insertTerritory({
    territory_id: terrA, kingdom_id: KID, name: 'A', workspace_path: null, summary: null,
    supervisor_binding_id: sup, status: 'ACTIVE', deleted_at: null, deleted_reason: null, created_at: NOW(),
  })
  const taskId = `task-${Math.random().toString(36).slice(2, 8)}`
  store.insertTask({
    task_id: taskId, territory_id: terrA, parent_task_id: null, title: 'T', description: null,
    assigned_binding_id: worker, status: 'ASSIGNED', acceptance_criteria: 'AC', result_summary: null,
    created_at: NOW(), updated_at: NOW(),
  })
  return { store, worker, sup, terrA, taskId }
}

/** 完整走到 DISPATCH_READY（含 GRANTED+ENFORCED decision 绑定）的夹具。 */
function readyLease(env: ReturnType<typeof makeStore>): { leaseId: string; decisionId: string } {
  const { store, worker, terrA, taskId } = env
  const affinity = establishAffinity(store, { kingdomId: KID, workerBindingId: worker, session: SESSION, territoryId: terrA })
  const lease = acquireExecutionLease(store, { kingdomId: KID, workerBindingId: worker, session: SESSION, territoryId: terrA, taskId, attemptNo: 1 })
  setLeasePlan(store, lease.lease_id, '{"type":"plan/v1"}')
  advanceLeaseState(store, lease.lease_id, 'PREPARING')
  advanceLeaseState(store, lease.lease_id, 'MATERIALIZING')
  const decision = recordCapabilityDecision(store, {
    kingdomId: KID, taskId, workerBindingId: worker, supervisorBindingId: env.sup,
    decision: 'GRANTED', enforcementStatus: 'ENFORCED',
    enforcementEvidenceJson: '{"type":"DshEnforcementEvidence/v1","payload":{}}',
    requirementCoverage: 'FULL',
  })
  bindCapabilityDecision(store, lease.lease_id, decision.decision_id)
  advanceLeaseState(store, lease.lease_id, 'DISPATCH_READY')
  assert.equal(affinity.territory_id, terrA)
  return { leaseId: lease.lease_id, decisionId: decision.decision_id }
}

// ── Affinity ────────────────────────────────────────────────────────────────

test('Domain: establishAffinity 合法建立 + current 唯一', () => {
  const env = makeStore()
  const { store, worker, terrA } = env
  const a1 = establishAffinity(store, { kingdomId: KID, workerBindingId: worker, session: SESSION, territoryId: terrA })
  assert.equal(a1.is_current, 1)
  assert.equal(store.getCurrentAffinityForWorker(KID, worker)?.affinity_id, a1.affinity_id)
  // 同 worker 第二个 current → DB 部分唯一索引拒绝
  assert.throws(() => establishAffinity(store, {
    kingdomId: KID, workerBindingId: worker,
    session: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 's-OTHER' },
    territoryId: terrA,
  }), /UNIQUE/)
  // 非 WORKER / 不存在 binding 拒绝
  assert.throws(() => establishAffinity(store, {
    kingdomId: KID, workerBindingId: env.sup, session: SESSION, territoryId: terrA,
  }), GovernedApiError)
  assert.throws(() => establishAffinity(store, {
    kingdomId: KID, workerBindingId: 'nope', session: SESSION, territoryId: terrA,
  }), GovernedApiError)
})

test('Domain: retireAffinity 合法一次；二次退役拒绝', () => {
  const env = makeStore()
  const { store, worker, terrA } = env
  const a = establishAffinity(store, { kingdomId: KID, workerBindingId: worker, session: SESSION, territoryId: terrA })
  const retired = retireAffinity(store, a.affinity_id)
  assert.equal(retired.is_current, 0)
  assert.ok(retired.retired_at)
  assert.throws(() => retireAffinity(store, a.affinity_id), GovernedApiError)
  // 退役后该 worker 无 current affinity
  assert.equal(store.getCurrentAffinityForWorker(KID, worker), null)
})

// ── Lease ───────────────────────────────────────────────────────────────────

test('Domain: acquireExecutionLease 验证 I-11 闭环；并发互斥由 DB 保证', () => {
  const env = makeStore()
  const { store, worker, terrA, taskId } = env
  establishAffinity(store, { kingdomId: KID, workerBindingId: worker, session: SESSION, territoryId: terrA })
  const lease = acquireExecutionLease(store, { kingdomId: KID, workerBindingId: worker, session: SESSION, territoryId: terrA, taskId, attemptNo: 1 })
  assert.equal(lease.state, 'ACQUIRED')
  // 同 session 第二个 active lease → DB 部分唯一索引拒绝（并发场景的权威保证）
  assert.throws(() => acquireExecutionLease(store, {
    kingdomId: KID, workerBindingId: worker, session: SESSION, territoryId: terrA, taskId, attemptNo: 2,
  }), /UNIQUE/)
  // territory 不匹配 Task.territory → 拒绝
  assert.throws(() => acquireExecutionLease(store, {
    kingdomId: KID, workerBindingId: worker, session: SESSION, territoryId: 'terr-NONE', taskId, attemptNo: 3,
  }), GovernedApiError)
  // 无 affinity 的 session → DB trigger 拒绝
  assert.throws(() => acquireExecutionLease(store, {
    kingdomId: KID, workerBindingId: worker,
    session: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-9', sessionRef: 's-NO-AFF' },
    territoryId: terrA, taskId, attemptNo: 4,
  }), /LEASE_REQUIRES_MATCHING_CURRENT_AFFINITY/)
})

test('Domain: advanceLeaseState 非法转移拒绝；CAS 陈旧态拒绝', () => {
  const env = makeStore()
  const { store, worker, terrA, taskId } = env
  establishAffinity(store, { kingdomId: KID, workerBindingId: worker, session: SESSION, territoryId: terrA })
  const lease = acquireExecutionLease(store, { kingdomId: KID, workerBindingId: worker, session: SESSION, territoryId: terrA, taskId, attemptNo: 1 })
  // ACQUIRED 不能直接 RELEASED（无 release evidence 且非法跳转）
  assert.throws(() => advanceLeaseState(store, lease.lease_id, 'RELEASED', { releaseEvidence: '{}', releaseReason: 'x', releasedAt: NOW() }), /ILLEGAL_LEASE_TRANSITION|GOVERNED/)
  // plan 写一次后不可重写
  setLeasePlan(store, lease.lease_id, '{"type":"plan/v1"}')
  assert.throws(() => setLeasePlan(store, lease.lease_id, '{"type":"plan/v2"}'), /LEASE_PLAN_ALREADY_SET/)
  // 合法链：ACQUIRED→PREPARING→MATERIALIZING（plan 已写）
  advanceLeaseState(store, lease.lease_id, 'PREPARING')
  advanceLeaseState(store, lease.lease_id, 'MATERIALIZING')
  // DISPATCH_READY 需要 GRANTED+ENFORCED decision（尚无）→ 拒绝
  assert.throws(() => advanceLeaseState(store, lease.lease_id, 'DISPATCH_READY'), /LEASE_DISPATCH_READY_REQUIRES_DECISION/)
  // CAS 陈旧态（store 层权威守卫）：期望旧态与库态不一致 → StaleStateError
  store.db.prepare(`UPDATE execution_leases SET state='RECOVERING' WHERE lease_id=?`).run(lease.lease_id)
  assert.throws(() => store.updateLeaseState(lease.lease_id, 'ACQUIRED', 'PREPARING', {}, NOW()), StaleStateError)
})

test('Domain: recordCapabilityDecision 组合校验 + 不可改写', () => {
  const env = makeStore()
  const { store, taskId } = env
  const ok = recordCapabilityDecision(store, {
    kingdomId: KID, taskId, decision: 'GRANTED', enforcementStatus: 'ENFORCED',
    enforcementEvidenceJson: '{"type":"e/v1"}', requirementCoverage: 'FULL',
  })
  assert.equal(ok.decision, 'GRANTED')
  assert.throws(() => recordCapabilityDecision(store, {
    kingdomId: KID, taskId, decision: 'GRANTED', enforcementStatus: 'UNAVAILABLE',
  }), GovernedApiError)
  assert.throws(() => recordCapabilityDecision(store, {
    kingdomId: KID, taskId, decision: 'DENIED', enforcementStatus: 'ENFORCED',
  }), GovernedApiError)
  // 不可改写
  assert.throws(() => store.db.prepare(`UPDATE capability_decisions SET decision='DENIED' WHERE decision_id=?`).run(ok.decision_id), /CAPABILITY_DECISION_IMMUTABLE/)
})

test('Domain: createGovernedExecution 回填 decision.execution_id；伪造关系拒绝', () => {
  const env = makeStore()
  const { store, worker, taskId } = env
  const { leaseId, decisionId } = readyLease(env)
  const exec = createGovernedExecution(store, {
    taskId, attemptNo: 1, workerBindingId: worker, leaseId, capabilityDecisionId: decisionId,
  })
  assert.equal(exec.execution_contract, 'GOVERNED_PERSISTENT')
  assert.equal(exec.state, 'STARTING')
  // decision.execution_id 已回填
  assert.equal(store.getCapabilityDecision(decisionId)?.execution_id, exec.execution_id)
  // 伪造：不存在的 lease / decision → 拒绝
  assert.throws(() => createGovernedExecution(store, {
    taskId, attemptNo: 2, workerBindingId: worker, leaseId: 'NO_SUCH', capabilityDecisionId: decisionId,
  }), GovernedApiError)
  assert.throws(() => createGovernedExecution(store, {
    taskId, attemptNo: 2, workerBindingId: worker, leaseId, capabilityDecisionId: 'NO_SUCH',
  }), GovernedApiError)
})

test('Domain: createDispatchIntent = COMMIT POINT；非 ready lease 拒绝', () => {
  const env = makeStore()
  const { store, worker, taskId } = env
  const { leaseId, decisionId } = readyLease(env)
  const exec = createGovernedExecution(store, {
    taskId, attemptNo: 1, workerBindingId: worker, leaseId, capabilityDecisionId: decisionId,
  })
  const intent = createDispatchIntent(store, {
    kingdomId: KID, leaseId, executionId: exec.execution_id, taskId, attemptNo: 1, session: SESSION,
    requestSnapshot: '{"type":"req/v1"}', inputRefJson: '{"ref":"in"}', payloadHash: 'abc',
  })
  assert.equal(intent.state, 'INTENDED')
  // lease 未 DISPATCH_READY（推进 EXECUTING 后不能再造 Intent）
  advanceLeaseState(store, leaseId, 'EXECUTING')
  assert.throws(() => createDispatchIntent(store, {
    kingdomId: KID, leaseId, executionId: exec.execution_id, taskId, attemptNo: 1, session: SESSION,
    requestSnapshot: '{}', inputRefJson: '{}', payloadHash: 'x',
  }), /DISPATCH_REQUIRES_MATCHING_READY_LEASE|UNIQUE/)
})

test('Domain: Receipt → Correlation → Terminal Evidence（TX-3R/TX-4）', () => {
  const env = makeStore()
  const { store, worker, taskId } = env
  const { leaseId, decisionId } = readyLease(env)
  const exec = createGovernedExecution(store, {
    taskId, attemptNo: 1, workerBindingId: worker, leaseId, capabilityDecisionId: decisionId,
  })
  const intent = createDispatchIntent(store, {
    kingdomId: KID, leaseId, executionId: exec.execution_id, taskId, attemptNo: 1, session: SESSION,
    requestSnapshot: '{"type":"req/v1"}', inputRefJson: '{"ref":"in"}', payloadHash: 'abc',
  })
  // TX-3 尾：DISPATCH_READY→EXECUTING；Execution STARTING→RUNNING（Adapter 观察到开始）
  advanceLeaseState(store, leaseId, 'EXECUTING')
  store.transitionExecution(exec, 'RUNNING', {})
  // Receipt：INTENDED→DISPATCHED→RECEIVED（缺 receipt 由 trigger 拒绝）
  const received = recordDispatchReceipt(store, intent.dispatch_id, {
    runtimeDispatchRef: 'rd-1', receiptJson: '{"type":"receipt/v1"}',
  })
  assert.equal(received.state, 'RECEIVED')
  assert.equal(received.runtime_dispatch_ref, 'rd-1')
  // 从 CORRELATED 反向回 RECEIVED 非法
  assert.throws(() => advanceDispatchState(store, intent.dispatch_id, 'DISPATCHED'), /ILLEGAL_DISPATCH_TRANSITION/)
  // Correlation
  const correlated = correlateRuntimeExecution(store, intent.dispatch_id, 're-1')
  assert.equal(correlated.state, 'CORRELATED')
  // Terminal（无 evidence 由 trigger 拒绝）
  assert.throws(() => advanceDispatchState(store, intent.dispatch_id, 'TERMINAL'), /DISPATCH_TERMINAL_REQUIRES_EVIDENCE/)
  const terminal = recordTerminalEvidence(store, intent.dispatch_id, {
    evidenceJson: '{"type":"terminal/v1"}',
    executionTerminalState: 'COMPLETED',
    settleLease: true,
  })
  assert.equal(terminal.dispatch.state, 'TERMINAL')
  assert.equal(terminal.execution?.state, 'COMPLETED')
  assert.equal(terminal.lease?.state, 'SETTLING')
})

test('Domain: releaseExecutionLease 需 evidence；cleanup 不明进 RECOVERING', () => {
  const env = makeStore()
  const { store, worker, taskId } = env
  const { leaseId, decisionId } = readyLease(env)
  createGovernedExecution(store, { taskId, attemptNo: 1, workerBindingId: worker, leaseId, capabilityDecisionId: decisionId })
  // 未到可释放状态（DISPATCH_READY 不能直接释放）→ 拒绝
  assert.throws(() => releaseExecutionLease(store, leaseId, { ok: true }, 'cleanup-ok'), GovernedApiError)
  // cleanup 不明 → RECOVERING（不释放）
  markLeaseRecovering(store, leaseId)
  assert.equal(store.getLease(leaseId)?.state, 'RECOVERING')
  // 有 evidence 从 RECOVERING 释放
  const released = releaseExecutionLease(store, leaseId, { ok: true }, 'cleanup-confirmed')
  assert.equal(released.state, 'RELEASED')
  assert.ok(released.release_evidence_json)
  assert.ok(released.released_at)
  // 释放后 session 可接下一项工作（无 active lease）
  assert.equal(store.getActiveLeaseForSession(SESSION), null)
})

test('Domain: markExecutionRecovering 不改 Task 治理状态；recovery 后可终态', () => {
  const env = makeStore()
  const { store, worker, taskId } = env
  const { leaseId, decisionId } = readyLease(env)
  const exec = createGovernedExecution(store, { taskId, attemptNo: 1, workerBindingId: worker, leaseId, capabilityDecisionId: decisionId })
  const recovering = markExecutionRecovering(store, exec.execution_id)
  assert.equal(recovering.state, 'RECOVERING')
  assert.equal(store.getTask(taskId)?.status, 'ASSIGNED', 'RECOVERING 不得改 Task 治理状态')
  // 有 Terminal Evidence 才允许终态
  const terminal = store.transitionExecution(recovering, 'COMPLETED', { detail: 'evidence ok' })
  assert.equal(terminal.state, 'COMPLETED')
})

test('Domain: Dispatch 完整生命周期到 TERMINAL；陈旧 CAS 拒绝', () => {
  const env = makeStore()
  const { store, worker, taskId } = env
  const { leaseId, decisionId } = readyLease(env)
  const exec = createGovernedExecution(store, { taskId, attemptNo: 1, workerBindingId: worker, leaseId, capabilityDecisionId: decisionId })
  const intent = createDispatchIntent(store, {
    kingdomId: KID, leaseId, executionId: exec.execution_id, taskId, attemptNo: 1, session: SESSION,
    requestSnapshot: '{}', inputRefJson: '{}', payloadHash: 'h',
  })
  // 陈旧 CAS（store 层权威守卫）：期望旧态与库态不一致 → StaleStateError
  assert.throws(() => store.updateDispatchState(intent.dispatch_id, 'DISPATCHED', 'RECEIVED', {
    receiptJson: '{}', receiptAt: NOW(),
  }, NOW()), StaleStateError)
  // API 层对已漂移（RECOVERING）的 dispatch：fail-closed 拒绝继续
  markDispatchRecovering(store, intent.dispatch_id)
  assert.throws(() => recordDispatchReceipt(store, intent.dispatch_id, { runtimeDispatchRef: 'r', receiptJson: '{}' }), GovernedApiError)
  // 从 RECOVERING 持 evidence 走合法链到 TERMINAL
  const terminal = advanceDispatchState(store, intent.dispatch_id, 'TERMINAL', {
    terminalEvidenceJson: '{"type":"terminal/v1"}', terminalAt: NOW(),
  })
  assert.equal(terminal.state, 'TERMINAL')
})

test('Domain: 四 Ledger DELETE 拒绝（immutable ledger）', () => {
  const env = makeStore()
  const { store, worker, taskId } = env
  const { leaseId, decisionId } = readyLease(env) // readyLease 内部已 establishAffinity
  const exec = createGovernedExecution(store, { taskId, attemptNo: 1, workerBindingId: worker, leaseId, capabilityDecisionId: decisionId })
  createDispatchIntent(store, {
    kingdomId: KID, leaseId, executionId: exec.execution_id, taskId, attemptNo: 1, session: SESSION,
    requestSnapshot: '{}', inputRefJson: '{}', payloadHash: 'h',
  })
  assert.throws(() => store.db.prepare('DELETE FROM session_territory_affinities').run(), /NO_DELETE/)
  assert.throws(() => store.db.prepare('DELETE FROM execution_leases').run(), /NO_DELETE/)
  assert.throws(() => store.db.prepare('DELETE FROM capability_decisions').run(), /NO_DELETE/)
  assert.throws(() => store.db.prepare('DELETE FROM dispatch_records').run(), /NO_DELETE/)
})
