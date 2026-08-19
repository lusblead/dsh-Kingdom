/**
 * dsh-kingdom — v0.8 GUI 最小 Runtime Governance 接线验收（§32–§33）。
 *
 * §33 blocker 断言：DENIED 不得显示成 Success；RECOVERING 不得显示成 Done；
 * Task/Execution/Claim 不混淆；schema 非 v4 时 governance 为空（不伪造治理状态）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KingdomStore } from '../lib/core/db.js'
import {
  establishAffinity,
  acquireExecutionLease,
  advanceLeaseState,
  recordCapabilityDecision,
  createGovernedExecution,
  createDispatchIntent,
  recordDispatchReceipt,
  correlateRuntimeExecution,
  markDispatchRecovering,
  markLeaseRecovering,
} from '../lib/core/governed.js'
import { runCapabilityGate } from '../lib/capability/service.js'
import { buildSnapshot, buildTaskDetail, toExecutionView, buildGovernance } from '../lib/gui/snapshot.js'
import { DshRuntimeAdapter } from '../lib/adapter/dsh-backend.js'

const NOW = () => new Date().toISOString()

function fakePolicyAdapter(): DshRuntimeAdapter {
  const append = (s: { events: { type: string; data?: Record<string, unknown> }[] }, type: string, data?: Record<string, unknown>) =>
    s.events.push({ type, ...(data ? { data } : {}) })
  return new DshRuntimeAdapter({
    runtimeInstanceRef: 'inst-1', provider: 'spawn', model: null,
    agents: { agents: new Map(), create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') }, get: () => undefined, list: () => [] },
    permission: { set: (s: never, name: string) => { append(s, 'permission/preset', { preset: name }); append(s, 'sandbox/mode', { mode: 'workspace-write' }); append(s, 'approval/policy', { policy: 'never' }) } },
    sandboxPolicy: { setSandboxMode: (s: never, m: string) => append(s, 'sandbox/mode', { mode: m }) },
    approval: { setApprovalPolicy: (s: never, p: string) => append(s, 'approval/policy', { policy: p }) },
  })
}

async function makeGovernedStore(): Promise<{ store: KingdomStore; kingdomId: string; worker: string; sup: string; terrA: string; taskId: string }> {
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
  const session = { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 'sess-long-id-12345678' }
  const ctx = { sessionRef: session.sessionRef, agent: { ctx: { tools: { restrict: () => () => {}, guard: () => () => {}, schemas: () => [{ name: 'pwsh' }] } }, session: { header: { cwd: 'C:/terr-a' }, events: [] as { type: string; data?: Record<string, unknown> }[] } } }
  establishAffinity(store, { kingdomId, workerBindingId: worker, session, territoryId: terrA })

  // 第一次尝试：ceiling 缺失 → DENIED（GUI 必须如实显示 DENIED + 原因）
  const leaseDenied = acquireExecutionLease(store, { kingdomId, workerBindingId: worker, session, territoryId: terrA, taskId, attemptNo: 1 })
  const deniedGate = await runCapabilityGate({
    store, adapter: fakePolicyAdapter(), kingdomId, taskId, attemptNo: 1, workerBindingId: worker, supervisorBindingId: sup,
    leaseId: leaseDenied.lease_id, requirementJson: JSON.stringify({ 'tool:pwsh': true }), ceilingJson: null,
    grant: { 'tool:pwsh': true }, sandboxMode: 'workspace-write', context: ctx,
  })
  assert.equal(deniedGate.materialized, false)

  // 第二次尝试：ceiling 配置后 GRANTED → 走到 DISPATCH 后进 RECOVERING（GUI 必须如实显示）
  store.setKingdomCapabilityCeiling(kingdomId, JSON.stringify({ 'tool:pwsh': true }))
  const lease2 = acquireExecutionLease(store, { kingdomId, workerBindingId: worker, session, territoryId: terrA, taskId, attemptNo: 2 })
  const gate = await runCapabilityGate({
    store, adapter: fakePolicyAdapter(), kingdomId, taskId, attemptNo: 2, workerBindingId: worker, supervisorBindingId: sup,
    leaseId: lease2.lease_id, requirementJson: JSON.stringify({ 'tool:pwsh': true }), ceilingJson: JSON.stringify({ 'tool:pwsh': true }),
    grant: { 'tool:pwsh': true }, sandboxMode: 'workspace-write', context: ctx,
  })
  assert.equal(gate.materialized, true)
  const execution = createGovernedExecution(store, { taskId, attemptNo: 2, workerBindingId: worker, leaseId: lease2.lease_id, capabilityDecisionId: gate.decision.decision_id, sessionId: session.sessionRef })
  const intent = createDispatchIntent(store, {
    kingdomId, leaseId: lease2.lease_id, executionId: execution.execution_id, taskId, attemptNo: 2, session,
    requestSnapshot: '{"type":"req/v1"}', inputRefJson: '{"ref":"in"}', payloadHash: 'h',
  })
  advanceLeaseState(store, lease2.lease_id, 'EXECUTING')
  const received = recordDispatchReceipt(store, intent.dispatch_id, { runtimeDispatchRef: 'msg-1', receiptJson: '{"type":"receipt/v1"}' })
  void received
  correlateRuntimeExecution(store, intent.dispatch_id, 'turn-1')
  markDispatchRecovering(store, intent.dispatch_id)
  markLeaseRecovering(store, lease2.lease_id)
  return { store, kingdomId, worker, sup, terrA, taskId }
}

test('GUI: snapshot 含 Runtime Governance 投影（脱敏 session / 诚实状态）', async () => {
  const { store, kingdomId } = await makeGovernedStore()
  const snapshot = buildSnapshot(store, kingdomId, { mode: 'declarative', trustLevel: 'local-demo', note: '' }, { nowMs: Date.now() })
  const gov = snapshot.governance
  assert.equal(gov.workerSessions.length, 1)
  assert.ok(gov.workerSessions[0].isCurrent)
  assert.ok(gov.workerSessions[0].sessionDisplay!.startsWith('…'), 'session 必须脱敏')
  assert.ok(!gov.workerSessions[0].sessionDisplay!.includes('sess-long-id-12345678'))
  // DENIED decision 如实显示（§33：不得显示成 Success）
  const denied = gov.decisions.find(d => d.decision === 'DENIED')
  assert.ok(denied, 'DENIED decision 必须出现在 governance 视图')
  assert.equal(denied!.reasonCode, 'CEILING_NOT_CONFIGURED')
  assert.equal(denied!.hasEvidence, false)
  // RECOVERING lease/dispatch 如实显示（§33：不得显示成 Done）
  assert.ok(gov.leases.some(l => l.state === 'RECOVERING'))
  assert.ok(gov.dispatches.some(d => d.state === 'RECOVERING'))
})

test('GUI: task detail 含任务级 governance + ExecutionView 带 execution_contract', async () => {
  const { store, kingdomId, taskId } = await makeGovernedStore()
  const detail = buildTaskDetail(store, kingdomId, taskId)!
  assert.ok(detail.governance.leases.length >= 1)
  assert.ok(detail.governance.decisions.length >= 1)
  assert.ok(detail.governance.dispatches.length >= 1)
  // governed execution 视图带 contract + lease/decision 关联
  const governed = detail.executions.find(e => e.executionContract === 'GOVERNED_PERSISTENT')
  assert.ok(governed, 'governed execution 必须标注 contract')
  assert.ok(governed!.leaseId)
  assert.ok(governed!.capabilityDecisionId)
})

test('GUI: schema 非 v4 → governance 全空（不伪造治理状态）', () => {
  const fake = {
    isSchemaV4: false,
    listAffinities: () => { throw new Error('不应调用') },
    listLeases: () => { throw new Error('不应调用') },
    listCapabilityDecisions: () => { throw new Error('不应调用') },
    listDispatches: () => { throw new Error('不应调用') },
  } as unknown as KingdomStore
  assert.deepEqual(buildGovernance(fake, 'k'), { workerSessions: [], leases: [], decisions: [], dispatches: [] })
})
