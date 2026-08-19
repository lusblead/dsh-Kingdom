/**
 * dsh-kingdom — M3-S6 Release Gate G1–G12 验证测试（v0.8）。
 *
 * 依 Owner v0.8 施工 Prompt §31：S6 不写新设计，只执行既有 Gate。
 * 本文件补齐各 Gate 的聚焦断言；完整证据映射见 docs/M3-S6-RELEASE-GATE-REPORT.md。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KingdomStore } from '../lib/core/db.js'
import { establishAffinity, acquireExecutionLease, advanceLeaseState, releaseExecutionLease } from '../lib/core/governed.js'
import { materializeDshEnforcement, cleanupDshEnforcement, ENFORCEMENT_EVIDENCE_TYPE, type DshEnforcementContext } from '../lib/capability/dsh-enforcement.js'
import { hasForeignDispatch } from '../lib/dispatch/evidence.js'
import { decideRecovery } from '../lib/dispatch/reconcile.js'

const NOW = () => new Date().toISOString()

// ── G5 / G9：Enforcement 强度与证据诚实（不夸大）────────────────────────────

test('G5/G9: evidence 只含真实应用事实，不冒充 OS-level/kernel sandbox', async () => {
  const agent = {
    ctx: { tools: { restrict: () => () => {}, guard: () => () => {}, schemas: () => [{ name: 'pwsh' }] } },
    session: { events: [] as { type: string; data?: Record<string, unknown> }[] },
  }
  const append = (type: string, data?: Record<string, unknown>) => agent.session.events.push({ type, ...(data ? { data } : {}) })
  const deps = {
    sandboxPolicy: { setSandboxMode: () => append('sandbox/mode', { mode: 'workspace-write' }) },
    approval: { setApprovalPolicy: () => append('approval/policy', { policy: 'never' }) },
  }
  const result = await materializeDshEnforcement(deps, { sessionRef: 's-1', agent } as DshEnforcementContext, {
    tools: ['pwsh'], territoryPath: 'C:/terr-a', sandboxMode: 'workspace-write', approvalPolicy: 'never',
  })
  assert.equal(result.ok, true)
  const payload = JSON.parse(result.evidenceJson!).payload
  assert.equal(JSON.parse(result.evidenceJson!).type, ENFORCEMENT_EVIDENCE_TYPE)
  // 诚实：只声明 workspace-write 路径围栏（非 OS isolation / kernel sandbox）
  const serialized = JSON.stringify(payload).toLowerCase()
  assert.equal(payload.sandboxMode, 'workspace-write')
  assert.ok(!serialized.includes('kernel') && !serialized.includes('os-level') && !serialized.includes('isolated vm'), 'evidence 不得夸大为内核级沙箱')
  assert.equal(payload.approvalPolicy, 'never')
  assert.deepEqual(payload.tools, ['pwsh'])
})

// ── G7：并发/连续 Execution 政策不串线（disposer 按 session 隔离）────────────

test('G7: 连续两次 materialize+cleanup 同 session → disposer 精确配对（政策不串线）', async () => {
  const mkAgent = () => ({
    ctx: { tools: { restrict: () => () => { /* noop */ }, guard: () => () => { /* noop */ }, schemas: () => [{ name: 'pwsh' }, { name: 'read' }] } },
    session: { events: [] as { type: string; data?: Record<string, unknown> }[] },
  })
  const append = (session: { events: { type: string; data?: Record<string, unknown> }[] }, type: string, data?: Record<string, unknown>) =>
    session.events.push({ type, ...(data ? { data } : {}) })
  const deps = {
    sandboxPolicy: { setSandboxMode: (s: { events: { type: string; data?: Record<string, unknown> }[] }, m: string) => append(s, 'sandbox/mode', { mode: m }) },
    approval: { setApprovalPolicy: (s: { events: { type: string; data?: Record<string, unknown> }[] }, p: string) => append(s, 'approval/policy', { policy: p }) },
  }
  // session A 两次执行（每次 cleanup 后再 materialize）
  const a = mkAgent()
  const r1 = await materializeDshEnforcement(deps, { sessionRef: 'sA', agent: a } as DshEnforcementContext, { tools: ['pwsh'], territoryPath: 'C:/a', sandboxMode: 'workspace-write', approvalPolicy: 'never' })
  assert.equal(r1.ok, true)
  const c1 = await cleanupDshEnforcement({ sessionRef: 'sA', agent: a } as DshEnforcementContext)
  assert.equal(c1.ok, true)
  const r2 = await materializeDshEnforcement(deps, { sessionRef: 'sA', agent: a } as DshEnforcementContext, { tools: ['pwsh', 'read'], territoryPath: 'C:/a', sandboxMode: 'workspace-write', approvalPolicy: 'never' })
  assert.equal(r2.ok, true)
  const c2 = await cleanupDshEnforcement({ sessionRef: 'sA', agent: a } as DshEnforcementContext)
  assert.equal(c2.ok, true)
  // session B 独立：不受 A 影响（registry 按 session 隔离）
  const b = mkAgent()
  const r3 = await materializeDshEnforcement(deps, { sessionRef: 'sB', agent: b } as DshEnforcementContext, { tools: ['pwsh'], territoryPath: 'C:/b', sandboxMode: 'workspace-write', approvalPolicy: 'never' })
  assert.equal(r3.ok, true)
  const c3 = await cleanupDshEnforcement({ sessionRef: 'sB', agent: b } as DshEnforcementContext)
  assert.equal(c3.ok, true)
})

// ── G10：同一 Session 并发 acquire Lease 只有一个成功（DB 唯一索引权威）─────

test('G10: 同 Session 第二个 active Lease 被 DB 拒绝（one-active-per-session）', () => {
  const store = new KingdomStore(':memory:')
  store.insertKingdom({ kingdom_id: 'k', name: 'K', created_at: NOW(), owner_id: 'o1', owner_name: 'T' })
  const w = 'w-1'
  store.insertBinding({ binding_id: w, kingdom_id: 'k', role_type: 'WORKER', role_name: 'W', runtime_type: 'dsh', session_id: null, model_name: null, agent_name: null, session_meta: null, execution_profile_json: null, status: 'ACTIVE', retired_at: null, retired_reason: null, principal_id: null, created_at: NOW(), updated_at: NOW() })
  store.insertTerritory({ territory_id: 't1', kingdom_id: 'k', name: 'A', workspace_path: null, summary: null, supervisor_binding_id: null, status: 'ACTIVE', deleted_at: null, deleted_reason: null, created_at: NOW() })
  store.insertTask({ task_id: 'task-1', territory_id: 't1', parent_task_id: null, title: 'T', description: null, assigned_binding_id: w, status: 'ASSIGNED', acceptance_criteria: null, result_summary: null, created_at: NOW(), updated_at: NOW() })
  store.insertTask({ task_id: 'task-2', territory_id: 't1', parent_task_id: null, title: 'T2', description: null, assigned_binding_id: w, status: 'ASSIGNED', acceptance_criteria: null, result_summary: null, created_at: NOW(), updated_at: NOW() })
  const session = { runtimeType: 'dsh', runtimeInstanceRef: 'i', sessionRef: 's-1' }
  establishAffinity(store, { kingdomId: 'k', workerBindingId: w, session, territoryId: 't1' })
  const lease1 = acquireExecutionLease(store, { kingdomId: 'k', workerBindingId: w, session, territoryId: 't1', taskId: 'task-1', attemptNo: 1 })
  assert.equal(lease1.state, 'ACQUIRED')
  // 同 session 第二个（不同 task）→ 拒绝（并发场景的唯一权威）
  assert.throws(() => acquireExecutionLease(store, { kingdomId: 'k', workerBindingId: w, session, territoryId: 't1', taskId: 'task-2', attemptNo: 1 }), /UNIQUE/)
})

// ── G11：Crash 后旧 Execution 未 reconcile（lease 未 RELEASED）→ 禁新 Attempt ──

test('G11: RECOVERING 未释放前，同 session 不得取得新 Lease（未 reconcile 禁开新 attempt）', () => {
  const store = new KingdomStore(':memory:')
  store.insertKingdom({ kingdom_id: 'k', name: 'K', created_at: NOW(), owner_id: 'o1', owner_name: 'T' })
  const w = 'w-1'
  store.insertBinding({ binding_id: w, kingdom_id: 'k', role_type: 'WORKER', role_name: 'W', runtime_type: 'dsh', session_id: null, model_name: null, agent_name: null, session_meta: null, execution_profile_json: null, status: 'ACTIVE', retired_at: null, retired_reason: null, principal_id: null, created_at: NOW(), updated_at: NOW() })
  store.insertTerritory({ territory_id: 't1', kingdom_id: 'k', name: 'A', workspace_path: null, summary: null, supervisor_binding_id: null, status: 'ACTIVE', deleted_at: null, deleted_reason: null, created_at: NOW() })
  store.insertTask({ task_id: 'task-1', territory_id: 't1', parent_task_id: null, title: 'T', description: null, assigned_binding_id: w, status: 'ASSIGNED', acceptance_criteria: null, result_summary: null, created_at: NOW(), updated_at: NOW() })
  const session = { runtimeType: 'dsh', runtimeInstanceRef: 'i', sessionRef: 's-1' }
  establishAffinity(store, { kingdomId: 'k', workerBindingId: w, session, territoryId: 't1' })
  const lease = acquireExecutionLease(store, { kingdomId: 'k', workerBindingId: w, session, territoryId: 't1', taskId: 'task-1', attemptNo: 1 })
  // Crash → lease 进 RECOVERING（未 release）
  advanceLeaseState(store, lease.lease_id, 'RECOVERING')
  assert.equal(store.getLease(lease.lease_id)?.state, 'RECOVERING')
  // 同 task 同 attempt 的新 lease → UNIQUE(task_id, attempt_no) 拒绝
  assert.throws(() => acquireExecutionLease(store, { kingdomId: 'k', workerBindingId: w, session, territoryId: 't1', taskId: 'task-1', attemptNo: 1 }), /UNIQUE/)
  // 未 reconcile 完成（lease 未 RELEASED）→ 同 session 其他 task 也不得开新 lease
  store.insertTask({ task_id: 'task-2', territory_id: 't1', parent_task_id: null, title: 'T2', description: null, assigned_binding_id: w, status: 'ASSIGNED', acceptance_criteria: null, result_summary: null, created_at: NOW(), updated_at: NOW() })
  assert.throws(() => acquireExecutionLease(store, { kingdomId: 'k', workerBindingId: w, session, territoryId: 't1', taskId: 'task-2', attemptNo: 1 }), /UNIQUE/, 'one-active-per-session：reconcile 前禁新 attempt')
  // reconcile 完成（带证据释放）→ 才可开新 lease
  releaseExecutionLease(store, lease.lease_id, { phase: 'reconciled' }, 'recovery-complete')
  const lease2 = acquireExecutionLease(store, { kingdomId: 'k', workerBindingId: w, session, territoryId: 't1', taskId: 'task-2', attemptNo: 1 })
  assert.equal(lease2.state, 'ACQUIRED')
})

// ── G12：外来 Dispatch 检测（Detect + fail-closed）──────────────────────────

test('G12: foreign dispatch 检测 → UNTRUSTED_RECOVERING（禁静默 settle/release）', () => {
  const session = {
    events: [
      { type: 'user/message', data: { id: 'kd-msg-1' } },
      { type: 'user/message', data: { id: 'external-actor-msg' } },
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1 } },
    ],
  }
  assert.equal(hasForeignDispatch(session, 'kd-msg-1'), true)
  const decision = decideRecovery({
    store: {} as never,
    dispatch: { dispatch_id: 'd1', lease_id: 'l1', execution_id: 'e1', task_id: 't1', attempt_no: 1, kingdom_id: 'k', runtime_type: 'dsh', runtime_instance_ref: 'i', session_ref: 's1', state: 'CORRELATED', dispatch_request_snapshot: '{}', dispatch_input_ref_json: '{}', dispatch_payload_hash: 'h', runtime_dispatch_ref: 'kd-msg-1', runtime_execution_ref: null, receipt_json: null, terminal_evidence_json: null, output_ref_json: null, dispatched_at: null, receipt_at: null, terminal_at: null, created_at: NOW(), updated_at: NOW() },
    sessionObservation: 'AVAILABLE',
    evidence: { located: true, turnObserved: 1, turnEndObserved: true, assistantMessageObserved: false, foreignUserMessages: ['external-actor-msg'], state: 'TERMINAL', terminalReason: 'turn done' },
  })
  assert.equal(decision.action, 'UNTRUSTED_RECOVERING', '即使 terminal 事件存在，外来消息 → 不可信（最高优先级）')
})
