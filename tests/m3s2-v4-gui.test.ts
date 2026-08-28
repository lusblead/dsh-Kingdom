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
  recordTerminalEvidence,
  markDispatchRecovering,
  markLeaseRecovering,
} from '../lib/core/governed.js'
import { runCapabilityGate } from '../lib/capability/service.js'
import { boundedSourceRefs, buildActionAvailability, buildSnapshot, buildTaskDetail, buildTimeline, toEventView, toExecutionView, buildGovernance } from '../lib/gui/snapshot.js'
import { DshRuntimeAdapter } from '../lib/adapter/dsh-backend.js'
import { startGuiServer, READONLY_CONSOLE_HTML } from '../lib/gui/server.js'

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

async function makeGovernedStore(options: { leaveDispatchCorrelated?: boolean } = {}): Promise<{ store: KingdomStore; kingdomId: string; worker: string; sup: string; terrA: string; taskId: string }> {
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
  if (!options.leaveDispatchCorrelated) {
    markDispatchRecovering(store, intent.dispatch_id)
    markLeaseRecovering(store, lease2.lease_id)
  }
  return { store, kingdomId, worker, sup, terrA, taskId }
}

function captureProjectionPersistence(store: KingdomStore, kingdomId: string, taskId: string) {
  return {
    revision: store.revision(kingdomId),
    nextAttemptNo: store.nextAttemptNo(taskId),
    task: store.getTask(taskId),
    bindings: store.listBindings(kingdomId),
    territories: store.listTerritories(kingdomId),
    workerResults: store.listWorkerResults(taskId),
    executions: store.listExecutions(taskId),
    affinities: store.listAffinities(kingdomId),
    leases: store.listLeases(kingdomId),
    decisions: store.listCapabilityDecisions(kingdomId),
    dispatches: store.listDispatches(kingdomId),
    events: store.listEvents(kingdomId, 1000),
  }
}

test('GUI: snapshot 含 Runtime Governance 投影（脱敏 session / 诚实状态）', async () => {
  const { store, kingdomId } = await makeGovernedStore()
  const snapshot = buildSnapshot(store, {
    auth: { mode: 'declarative', trustLevel: 'local-demo', note: '' },
    nowMs: Date.now(),
  })
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

test('testProjectionPreservesSchemaV4AndNegativeStates', async () => {
  const { store, kingdomId, taskId } = await makeGovernedStore()
  store.insertWorkerResult({
    result_id: 'claim-projection-1',
    task_id: taskId,
    attempt_no: 2,
    worker_binding_id: null,
    session_id: null,
    outcome: 'COMPLETED',
    result_json: JSON.stringify({ summary: 'claim only' }),
    created_at: NOW(),
  })
  const snapshot = buildSnapshot(store, {
    auth: { mode: 'session-bound', trustLevel: 'session-verified', note: '' },
    nowMs: Date.now(),
  })
  assert.equal(snapshot.schemaVersion, 1)
  assert.ok(snapshot.projection.overview.data.health !== 'OK', 'DENIED/RECOVERING must surface attention')
  assert.ok(snapshot.projection.timeline.data.some(item => item.kind === 'GOVERNANCE_FACT'))
  assert.ok(snapshot.projection.timeline.data.some(item => item.kind === 'RUNTIME_OBSERVATION'))
  assert.ok(snapshot.projection.timeline.data.some(item => item.kind === 'WORKER_CLAIM'))
  assert.ok(snapshot.projection.timeline.data.some(item => item.kind === 'DERIVED_EXPLANATION'))
  const attentionCodes = snapshot.projection.attention.data.map(item => item.reason.code)
  assert.ok(attentionCodes.includes('CAPABILITY_DENIED'))
  assert.ok(attentionCodes.includes('LEASE_NOT_RELEASED'))
  const projectionJson = JSON.stringify(snapshot.projection)
  assert.doesNotMatch(projectionJson, /sess-long-id-12345678/u)
  assert.doesNotMatch(projectionJson, /C:\/terr-a/u)
  for (const item of snapshot.projection.timeline.data) assert.ok(item.sourceRefs.length <= 8)
  const detail = buildTaskDetail(store, kingdomId, taskId, { nowMs: Date.now() })!
  assert.equal(detail.projection.data.status.value, 'ASSIGNED')
  assert.ok(detail.projection.data.claim)
  assert.ok(detail.projection.data.execution)
})

test('testProjectionEmptyAndUnknownBranches', () => {
  const store = new KingdomStore(':memory:')
  const snapshot = buildSnapshot(store, {
    auth: { mode: 'declarative', trustLevel: 'local-demo', note: '' },
    nowMs: Date.now(),
  })
  assert.equal(snapshot.projection.overview.data.health, 'UNKNOWN')
  assert.equal(snapshot.projection.attention.data[0]?.reason.code, 'CONFIGURATION_INCOMPLETE')
  assert.equal(snapshot.projection.timeline.data.length, 0)
})

test('testProjectionHasNoWriteSideEffect', async () => {
  const { store, kingdomId, taskId } = await makeGovernedStore()
  const beforeRevision = store.revision(kingdomId)
  const beforeEvents = store.listEvents(kingdomId, 1000).length
  buildSnapshot(store, { auth: { mode: 'declarative', trustLevel: 'local-demo', note: '' } })
  buildTaskDetail(store, kingdomId, taskId)
  assert.equal(store.revision(kingdomId), beforeRevision)
  assert.equal(store.listEvents(kingdomId, 1000).length, beforeEvents)
})

test('testProjectionObservesClaimExecutionMismatchWithoutMutation', async () => {
  const { store, kingdomId, taskId } = await makeGovernedStore({ leaveDispatchCorrelated: true })
  const dispatch = store.listDispatches(kingdomId)[0]!
  recordTerminalEvidence(store, dispatch.dispatch_id, {
    evidenceJson: JSON.stringify({ kind: 'terminal', outcome: 'FAILED' }),
    executionTerminalState: 'FAILED',
  })
  store.insertWorkerResult({
    result_id: 'claim-mismatch-1',
    task_id: taskId,
    attempt_no: 2,
    worker_binding_id: null,
    session_id: null,
    outcome: 'COMPLETED',
    result_json: JSON.stringify({ summary: 'claim says completed' }),
    created_at: NOW(),
  })

  const before = captureProjectionPersistence(store, kingdomId, taskId)
  const snapshot = buildSnapshot(store, {
    auth: { mode: 'declarative', trustLevel: 'local-demo', note: '' },
    nowMs: Date.now(),
  })
  const detail = buildTaskDetail(store, kingdomId, taskId, { nowMs: Date.now() })!
  const mismatch = snapshot.projection.attention.data.find(item => item.reason.code === 'CLAIM_EXECUTION_MISMATCH')
  assert.ok(mismatch, '必须独立观察 Claim/terminal Execution 不一致')
  assert.equal(mismatch!.severity, 'CRITICAL')
  assert.ok(mismatch!.sourceRefs.some(ref => ref.sourceType === 'table-row' && ref.entityType === 'worker_results'))
  assert.ok(mismatch!.sourceRefs.some(ref => ref.sourceType === 'table-row' && ref.entityType === 'executions'))
  assert.equal(detail.projection.attentionReason?.code, 'CLAIM_EXECUTION_MISMATCH')
  assert.ok(snapshot.projection.timeline.data.some(item =>
    item.kind === 'DERIVED_EXPLANATION' && item.attentionReason?.code === 'CLAIM_EXECUTION_MISMATCH'))

  const after = captureProjectionPersistence(store, kingdomId, taskId)
  assert.deepEqual(after, before, 'projection 不得 retry、accept、创建新 attempt 或产生持久化副作用')
  assert.equal(after.nextAttemptNo, before.nextAttemptNo, 'projection 不得推进 next attempt')
})

test('testProjectionRetainsLatestEvidenceWhenTimelineExceedsCap', async () => {
  const { store, kingdomId, worker, terrA, taskId } = await makeGovernedStore({ leaveDispatchCorrelated: true })
  const dispatch = store.listDispatches(kingdomId)[0]!
  recordTerminalEvidence(store, dispatch.dispatch_id, {
    evidenceJson: JSON.stringify({ kind: 'terminal', outcome: 'FAILED' }),
    executionTerminalState: 'FAILED',
  })
  const execution = store.latestExecution(taskId)!
  const latestClaimId = 'claim-retention-latest'
  store.insertWorkerResult({
    result_id: latestClaimId,
    task_id: taskId,
    attempt_no: execution.attempt_no,
    worker_binding_id: worker,
    session_id: null,
    outcome: 'COMPLETED',
    result_json: JSON.stringify({ summary: 'latest claim' }),
    created_at: '2099-01-01T00:00:00.000Z',
  })

  // 69 older mismatch groups plus the latest base task produce at least 210
  // Claim/FAILED Execution/Derived Explanation candidates. The latest task id
  // intentionally sorts below every old id to prove id is not the recency key.
  const oldMismatchTaskIds: string[] = []
  const oldestMismatchTaskId = 'zzzz-oldest-but-lexically-largest'
  for (let taskIndex = 0; taskIndex < 69; taskIndex += 1) {
    const oldTaskId = taskIndex === 0
      ? oldestMismatchTaskId
      : `z-old-mismatch-${String(taskIndex).padStart(2, '0')}`
    oldMismatchTaskIds.push(oldTaskId)
    const timestamp = taskIndex === 0
      ? '2010-01-01T00:00:00.000Z'
      : new Date(Date.UTC(2020, 0, taskIndex)).toISOString()
    store.insertTask({
      task_id: oldTaskId,
      territory_id: terrA,
      parent_task_id: null,
      title: `Old mismatch ${taskIndex}`,
      description: null,
      assigned_binding_id: worker,
      status: 'ASSIGNED',
      acceptance_criteria: null,
      result_summary: null,
      created_at: timestamp,
      updated_at: timestamp,
    })
    store.insertWorkerResult({
      result_id: `timeline-retention-old-claim-${taskIndex}`,
      task_id: oldTaskId,
      attempt_no: 1,
      worker_binding_id: worker,
      session_id: null,
      outcome: 'COMPLETED',
      result_json: JSON.stringify({ summary: 'old mismatch claim' }),
      created_at: timestamp,
    })
    store.insertExecution({
      execution_id: `timeline-retention-old-execution-${taskIndex}`,
      task_id: oldTaskId,
      attempt_no: 1,
      worker_binding_id: worker,
      session_id: null,
      state: 'FAILED',
      detail: 'old mismatch execution',
      started_at: timestamp,
      heartbeat_at: null,
      ended_at: timestamp,
      pause_requested_at: null,
      executor_kind: 'test-fixture',
      provider: null,
      provider_source: null,
      requested_model: null,
      resolved_model: null,
      model_source: null,
      execution_profile_json: null,
      execution_contract: 'LEGACY_COMPAT',
      lease_id: null,
      capability_decision_id: null,
    })
  }

  assert.ok(oldMismatchTaskIds.every(oldTaskId => taskId < oldTaskId), '最新 task id 必须低于旧组 id')
  assert.equal([...oldMismatchTaskIds].sort().pop(), oldestMismatchTaskId, '实际最旧组必须使用最大字典序 id')
  const before = captureProjectionPersistence(store, kingdomId, taskId)
  const snapshot = buildSnapshot(store, {
    auth: { mode: 'declarative', trustLevel: 'local-demo', note: '' },
    nowMs: Date.now(),
  })
  const mismatchAttentions = snapshot.projection.attention.data.filter(item =>
    item.reason.code === 'CLAIM_EXECUTION_MISMATCH')
  assert.equal(mismatchAttentions.length, 70, '必须有至少 70 个合法 mismatch 组')
  const observedCandidateLowerBound = store.listTasks(kingdomId).reduce((total, task) =>
    total + Math.min(10, store.listWorkerResults(task.task_id).length)
      + Math.min(10, store.listExecutions(task.task_id).length), 0) + mismatchAttentions.length
  assert.ok(observedCandidateLowerBound > 200, '候选必须超过默认 200 cap')

  const beforeRevision = store.revision(kingdomId)
  const beforeEvents = store.listEvents(kingdomId, 1000).length
  const timeline = snapshot.projection.timeline.data
  assert.ok(timeline.length <= 200)
  assert.ok(timeline.some(item => item.id === `claim:${latestClaimId}`), '最新 Worker Claim 必须保留')
  assert.ok(timeline.some(item =>
    item.id === `execution:${execution.execution_id}`
       && item.kind === 'RUNTIME_OBSERVATION'
       && item.authoritativeState?.value === 'FAILED'), '对应 FAILED Execution 必须保留')
  const mismatch = timeline.find(item =>
    item.kind === 'DERIVED_EXPLANATION'
      && item.attentionReason?.code === 'CLAIM_EXECUTION_MISMATCH'
      && item.sourceRefs.some(ref => ref.entityType === 'worker_results' && ref.entityId === latestClaimId)
      && item.sourceRefs.some(ref => ref.entityType === 'executions' && ref.entityId === execution.execution_id))
  assert.ok(mismatch, '对应 CLAIM_EXECUTION_MISMATCH Derived Explanation 必须保留')
  const latestAttention = mismatchAttentions.find(item => item.entityRef?.id === taskId)
  assert.ok(latestAttention, 'Attention 必须指向最新 mismatch 组')
  assert.deepEqual(mismatch!.sourceRefs, latestAttention!.sourceRefs, 'Attention/Timeline sourceRefs 必须一致')
  assert.equal(mismatch!.sourceRefs.length <= 8, true)
  const sameSourceRef = (left: typeof timeline[number]['sourceRefs'][number], right: typeof timeline[number]['sourceRefs'][number]) =>
    left.sourceType === right.sourceType
      && left.entityType === right.entityType
      && left.entityId === right.entityId
      && left.eventSeq === right.eventSeq
      && left.ruleCode === right.ruleCode
  const retainedMismatchExplanations = timeline.filter(item =>
    item.kind === 'DERIVED_EXPLANATION'
      && item.attentionReason?.code === 'CLAIM_EXECUTION_MISMATCH')
  let orphanedMismatchExplanations = 0
  for (const explanation of retainedMismatchExplanations) {
    const claimRefs = explanation.sourceRefs.filter(ref =>
      ref.sourceType === 'table-row' && ref.entityType === 'worker_results')
    const executionRefs = explanation.sourceRefs.filter(ref =>
      ref.sourceType === 'table-row' && ref.entityType === 'executions')
    const hasClaim = claimRefs.some(ref => timeline.some(item =>
      item.kind === 'WORKER_CLAIM' && item.sourceRefs.some(candidate => sameSourceRef(candidate, ref))))
    const hasFailedExecution = executionRefs.some(ref => timeline.some(item =>
      item.kind === 'RUNTIME_OBSERVATION'
        && item.authoritativeState?.value === 'FAILED'
        && item.sourceRefs.some(candidate => sameSourceRef(candidate, ref))))
    if (!hasClaim || !hasFailedExecution) orphanedMismatchExplanations += 1
  }
  assert.equal(orphanedMismatchExplanations, 0, '所有保留 mismatch Explanation 都必须与 Claim/FAILED Execution 成组存在')
  assert.deepEqual(buildTimeline(store, kingdomId), timeline, '截断顺序必须稳定')
  const kinds = new Set(timeline.map(item => item.kind))
  for (const kind of ['GOVERNANCE_FACT', 'RUNTIME_OBSERVATION', 'WORKER_CLAIM', 'DERIVED_EXPLANATION']) {
    assert.ok(kinds.has(kind as never), `${kind} 分层必须保持`)
  }
  for (let index = 1; index < timeline.length; index += 1) {
    const previous = timeline[index - 1]!.occurredAt ? Date.parse(timeline[index - 1]!.occurredAt!) : Number.POSITIVE_INFINITY
    const current = timeline[index]!.occurredAt ? Date.parse(timeline[index]!.occurredAt!) : Number.POSITIVE_INFINITY
    assert.ok(previous <= current, 'Timeline 必须保持稳定时间顺序')
  }
  for (const item of timeline) assert.ok(item.sourceRefs.length <= 8)
  const after = captureProjectionPersistence(store, kingdomId, taskId)
  assert.deepEqual(after, before, 'projection 必须保持 zero-write')
  assert.equal(store.revision(kingdomId), beforeRevision, 'projection 不得写入 revision')
  assert.equal(store.listEvents(kingdomId, 1000).length, beforeEvents, 'projection 不得写入 events')
})

test('testProjectionObservesTerminalEvidenceMissingWithoutMutation', async () => {
  const { store, kingdomId, taskId } = await makeGovernedStore({ leaveDispatchCorrelated: true })
  const before = captureProjectionPersistence(store, kingdomId, taskId)
  const dispatchBefore = store.listDispatches(kingdomId)[0]!
  assert.equal(dispatchBefore.state, 'CORRELATED')
  assert.ok(dispatchBefore.receipt_json)
  assert.equal(dispatchBefore.terminal_evidence_json, null)

  const snapshot = buildSnapshot(store, {
    auth: { mode: 'declarative', trustLevel: 'local-demo', note: '' },
    nowMs: Date.now(),
  })
  const missing = snapshot.projection.attention.data.find(item => item.reason.code === 'TERMINAL_EVIDENCE_MISSING')
  assert.ok(missing, '必须独立观察 receipt 存在但 terminal evidence 缺失')
  assert.equal(missing!.severity, 'UNKNOWN')
  assert.ok(missing!.sourceRefs.some(ref => ref.sourceType === 'table-row' && ref.entityType === 'dispatch_records'))
  assert.ok(missing!.sourceRefs.some(ref => ref.sourceType === 'derived-rule' && ref.ruleCode === 'TERMINAL_EVIDENCE_REQUIRED'))
  assert.ok(snapshot.projection.timeline.data.some(item =>
    item.kind === 'DERIVED_EXPLANATION' && item.attentionReason?.code === 'TERMINAL_EVIDENCE_MISSING'))

  const after = captureProjectionPersistence(store, kingdomId, taskId)
  assert.deepEqual(after, before, 'projection 不得 retry、accept、创建新 attempt 或产生持久化副作用')
  assert.equal(store.listDispatches(kingdomId)[0]!.state, 'CORRELATED')
  assert.equal(store.listDispatches(kingdomId)[0]!.terminal_evidence_json, null)
})

test('testProjectionSourceRefsAreBoundedAndClassified', async () => {
  const { store, kingdomId, taskId } = await makeGovernedStore()
  const snapshot = buildSnapshot(store, { auth: { mode: 'declarative', trustLevel: 'local-demo', note: '' } })
  const detail = buildTaskDetail(store, kingdomId, taskId)!
  for (const ref of [...snapshot.projection.overview.sourceRefs, ...detail.projection.sourceRefs]) {
    assert.ok(ref.entityId === null || ref.entityId.length <= 96)
    assert.ok(!ref.entityId?.includes('sess-long-id-12345678'))
  }
  assert.ok(snapshot.projection.timeline.data.every(item => item.kind !== 'WORKER_CLAIM' || item.authoritativeState === null))
  assert.ok(snapshot.projection.timeline.data.every(item => item.kind !== 'DERIVED_EXPLANATION' || item.authoritativeState === null))
})

test('testOwnerAndAgentActionsFailClosed', async () => {
  const { store, kingdomId, taskId } = await makeGovernedStore()
  const snapshot = buildSnapshot(store, { auth: { mode: 'declarative', trustLevel: 'local-demo', note: '' } })
  assert.ok(snapshot.projection.overview.data.ownerActions.length > 0)
  assert.ok(snapshot.projection.overview.data.ownerActions.every(action =>
    action.executable === false && action.disabledReason?.code === 'DIRECT_SLASH_REQUIRED'))
  const detail = buildTaskDetail(store, kingdomId, taskId)!
  assert.equal(detail.projection.data.actionAvailability[0]?.executable, false)
  assert.equal(detail.projection.data.actionAvailability[0]?.lifecycleAllowed, false)
  assert.equal(detail.projection.data.actionAvailability[0]?.disabledReason?.code, 'ILLEGAL_EXECUTION_STATE')
})

test('testProjectionActionAvailabilityUsesOpaqueSupervisorSessionAndCanonicalCommands', async () => {
  const { store, kingdomId, worker, sup, terrA } = await makeGovernedStore()
  const supervisorSessionId = 'opaque-supervisor-session'
  const workerSessionId = 'opaque-worker-session'
  store.updateBindingSession(sup, supervisorSessionId, NOW())
  store.updateBindingSession(worker, workerSessionId, NOW())
  assert.equal(store.getBindingById(sup)!.principal_id, null, 'new Role binding principal_id remains null')

  const addTask = (taskId: string, status: string) => {
    store.insertTask({
      task_id: taskId,
      territory_id: terrA,
      parent_task_id: null,
      title: taskId,
      description: null,
      assigned_binding_id: status === 'CREATED' ? null : worker,
      status,
      acceptance_criteria: null,
      result_summary: null,
      created_at: NOW(),
      updated_at: NOW(),
    })
    return store.getTask(taskId)!
  }
  const addExecution = (taskId: string, state: string, attemptNo: number) => {
    const execution = store.insertExecution({
      execution_id: `${taskId}-execution`,
      task_id: taskId,
      attempt_no: attemptNo,
      worker_binding_id: worker,
      session_id: workerSessionId,
      state,
      detail: null,
      started_at: NOW(),
      heartbeat_at: null,
      ended_at: null,
      pause_requested_at: null,
      executor_kind: 'test-fixture',
      provider: null,
      provider_source: null,
      requested_model: null,
      resolved_model: null,
      model_source: null,
      execution_profile_json: null,
      execution_contract: 'LEGACY_COMPAT',
      lease_id: null,
      capability_decision_id: null,
    })
    return execution
  }

  const created = { task: addTask('action-created', 'CREATED'), execution: null }
  const assigned = { task: addTask('action-assigned', 'ASSIGNED'), execution: null }
  const review = { task: addTask('action-review', 'REVIEW'), execution: null }
  const runningTask = addTask('action-running', 'RUNNING')
  const running = { task: runningTask, execution: addExecution(runningTask.task_id, 'RUNNING', 1) }
  const pausedTask = addTask('action-paused', 'RUNNING')
  const paused = { task: pausedTask, execution: addExecution(pausedTask.task_id, 'PAUSED', 1) }
  const cases = [created, assigned, review, running, paused]
  const security = {
    principalSessionId: supervisorSessionId,
    sessionVerified: true,
    scope: [terrA],
    hostContext: true,
    commandCoverage: ['assign', 'start', 'review', 'execution.pause', 'execution.resume', 'execution.abort'],
  }

  const createdActions = buildActionAvailability(store, created.task, created.execution, security)
  assert.deepEqual(createdActions.map(action => action.action), ['assign'])
  assert.ok(createdActions.every(action => action.executable))
  const assignedActions = buildActionAvailability(store, assigned.task, assigned.execution, security)
  assert.deepEqual(assignedActions.map(action => action.action), ['start'])
  assert.ok(assignedActions.every(action => action.executable))
  const reviewActions = buildActionAvailability(store, review.task, review.execution, security)
  assert.deepEqual(reviewActions.map(action => action.action), ['review:accept', 'review:rework', 'review:fail', 'review:handoff'])
  assert.ok(reviewActions.every(action => action.executable), 'review:* maps to canonical review command')
  const runningActions = buildActionAvailability(store, running.task, running.execution, security)
  assert.equal(running.execution.execution_contract, 'LEGACY_COMPAT')
  assert.deepEqual(runningActions.map(action => action.action), ['execution:pause', 'execution:abort'])
  assert.ok(runningActions.every(action => action.executable), 'execution:* maps to canonical execution.* commands')
  store.setExecutionPauseRequest(running.execution.execution_id, NOW())
  const pausePendingExecution = store.getExecution(running.execution.execution_id)!
  assert.equal(toExecutionView(pausePendingExecution).pausePending, true)
  const pausePendingActions = buildActionAvailability(store, running.task, pausePendingExecution, security)
  assert.deepEqual(pausePendingActions.map(action => action.action), ['execution:resume', 'execution:abort'])
  assert.ok(pausePendingActions.every(action => action.executable), 'legacy resume can clear a pending pause request')
  store.setExecutionPauseRequest(pausePendingExecution.execution_id, null)
  const pauseClearedExecution = store.getExecution(running.execution.execution_id)!
  assert.equal(toExecutionView(pauseClearedExecution).pausePending, false)
  const pauseClearedActions = buildActionAvailability(store, running.task, pauseClearedExecution, security)
  assert.deepEqual(pauseClearedActions.map(action => action.action), ['execution:pause', 'execution:abort'])
  assert.ok(pauseClearedActions.every(action => action.executable), 'legacy pause becomes available after resume clears pending')
  const pausedActions = buildActionAvailability(store, paused.task, paused.execution, security)
  assert.deepEqual(pausedActions.map(action => action.action), ['execution:resume', 'execution:abort'])
  assert.ok(pausedActions.every(action => action.executable))

  for (const value of cases) {
    const wrongSession = buildActionAvailability(store, value.task, value.execution, {
      ...security,
      principalSessionId: workerSessionId,
    })
    assert.ok(wrongSession.every(action => !action.executable && action.disabledReason?.code === 'SESSION_AUTH_REQUIRED'))
    const wrongTerritory = buildActionAvailability(store, value.task, value.execution, {
      ...security,
      scope: ['territory:other'],
    })
    assert.ok(wrongTerritory.every(action => !action.executable && action.disabledReason?.code === 'ROLE_SCOPE_REQUIRED'))
    const missingHost = buildActionAvailability(store, value.task, value.execution, {
      ...security,
      hostContext: false,
    })
    assert.ok(missingHost.every(action => !action.executable && action.disabledReason?.code === 'HOST_CONTEXT_REQUIRED'))
  }

  assert.ok(buildActionAvailability(store, review.task, review.execution, {
    ...security,
    principalSessionId: null,
  }).every(action => !action.executable && action.disabledReason?.code === 'SESSION_AUTH_REQUIRED'))
  assert.ok(buildActionAvailability(store, review.task, review.execution, {
    ...security,
    commandCoverage: ['review:accept', 'review:rework', 'review:fail', 'review:handoff'],
  }).every(action => !action.executable && action.disabledReason?.code === 'COMMAND_UNAVAILABLE'))
  assert.ok(buildActionAvailability(store, running.task, running.execution, {
    ...security,
    commandCoverage: ['execution:pause', 'execution:abort'],
  }).every(action => !action.executable && action.disabledReason?.code === 'COMMAND_UNAVAILABLE'))
  assert.doesNotMatch(JSON.stringify([...createdActions, ...assignedActions, ...reviewActions, ...runningActions, ...pausedActions]), /opaque-(?:supervisor|worker)-session/u)
  assert.equal(store.getDefaultKingdom()!.kingdom_id, kingdomId)
})

test('testGovernedPersistentLatestExecutionBlocksStart', async () => {
  const { store, kingdomId, taskId, sup, terrA } = await makeGovernedStore({ leaveDispatchCorrelated: true })
  const supervisorSessionId = 'opaque-governed-supervisor-session'
  store.updateBindingSession(sup, supervisorSessionId, NOW())
  const task = store.getTask(taskId)!
  assert.equal(task.status, 'ASSIGNED', 'governed dispatch remains ASSIGNED until authoritative settlement')
  let execution = store.latestExecution(taskId)!
  assert.equal(execution.execution_contract, 'GOVERNED_PERSISTENT')
  assert.ok(execution.lease_id)

  const security = {
    principalSessionId: supervisorSessionId,
    sessionVerified: true,
    scope: [terrA],
    hostContext: true,
    commandCoverage: ['start', 'execution.pause', 'execution.resume', 'execution.abort'],
  }
  const assertStartBlocked = (expectedReason: string) => {
    const detail = buildTaskDetail(store, kingdomId, taskId, { security })!
    assert.ok(!detail.task.allowedActions.includes('start'), 'legacy lifecycle candidates must not advertise duplicate start')
    const start = detail.projection.data.actionAvailability.find(action => action.action === 'start')
    assert.ok(start, 'structured action truth must retain an explicit disabled start')
    assert.equal(start!.lifecycleAllowed, false)
    assert.equal(start!.executable, false)
    assert.equal(start!.disabledReason?.code, expectedReason)
    assert.ok(start!.sourceRefs.some(ref => ref.entityType === 'executions' && ref.entityId === execution.execution_id))
    assert.ok(start!.sourceRefs.some(ref => ref.entityType === 'execution_leases' && ref.entityId === execution.lease_id))
    assert.doesNotMatch(JSON.stringify(detail.projection), /opaque-governed-supervisor-session/u)
  }

  assert.equal(execution.state, 'STARTING')
  assertStartBlocked('ILLEGAL_EXECUTION_STATE')
  execution = store.transitionExecution(execution, 'RUNNING')
  assertStartBlocked('ILLEGAL_EXECUTION_STATE')
  execution = store.transitionExecution(execution, 'PAUSED')
  assertStartBlocked('ILLEGAL_EXECUTION_STATE')
  execution = store.transitionExecution(execution, 'RECOVERING')
  assertStartBlocked('EXECUTION_RECOVERING')
})

test('testProjectionGovernedRuntimeControlsFailClosed', async () => {
  const { store, taskId, sup, terrA } = await makeGovernedStore({ leaveDispatchCorrelated: true })
  const supervisorSessionId = 'opaque-runtime-control-supervisor-session'
  store.updateBindingSession(sup, supervisorSessionId, NOW())
  const security = {
    principalSessionId: supervisorSessionId,
    sessionVerified: true,
    scope: [terrA],
    hostContext: true,
    commandCoverage: ['execution.pause', 'execution.resume', 'execution.abort'],
  }
  const task = store.transitionTask(store.getTask(taskId)!, 'RUNNING')
  let execution = store.transitionExecution(store.latestExecution(taskId)!, 'RUNNING')

  const assertUnavailable = (expectedActions: string[]) => {
    const actions = buildActionAvailability(store, task, execution, security)
    const controls = actions.filter(action => action.action.startsWith('execution:'))
    assert.deepEqual(controls.map(action => action.action), expectedActions)
    for (const action of controls) {
      assert.equal(action.lifecycleAllowed, true)
      assert.equal(action.executable, false)
      assert.equal(action.disabledReason?.code, 'GOVERNED_RUNTIME_CONTROL_UNAVAILABLE')
      assert.ok(action.sourceRefs.some(ref =>
        ref.entityType === 'executions' && ref.entityId === execution.execution_id))
      assert.ok(action.sourceRefs.some(ref =>
        ref.sourceType === 'derived-rule' && ref.ruleCode === 'GOVERNED_RUNTIME_CONTROL_UNAVAILABLE'))
    }
  }

  assert.equal(execution.execution_contract, 'GOVERNED_PERSISTENT')
  assertUnavailable(['execution:pause', 'execution:abort'])
  store.setExecutionPauseRequest(execution.execution_id, NOW())
  execution = store.getExecution(execution.execution_id)!
  assertUnavailable(['execution:abort'])
  store.setExecutionPauseRequest(execution.execution_id, null)
  execution = store.getExecution(execution.execution_id)!
  execution = store.transitionExecution(execution, 'PAUSED')
  assertUnavailable(['execution:resume', 'execution:abort'])
})

test('testTaskDetailProjectsBoundedHandoffSupervisorDecision', () => {
  const store = new KingdomStore(':memory:')
  const kingdomId = 'handoff-kingdom'
  const supervisorId = 'handoff-supervisor'
  const fromWorkerId = 'handoff-worker-from'
  const toWorkerId = 'handoff-worker-to'
  const territoryId = 'handoff-territory'
  const taskId = 'handoff-task'
  const fromAssignmentId = 'handoff-assignment-from'
  const toAssignmentId = 'handoff-assignment-to'
  const timestamp = NOW()
  const freeTextSecret = 'opaqueHandoffSecret42'
  const privateReason = `move evidence from C:/private/handoff/reason.txt token ${freeTextSecret} ${'r'.repeat(220)}`

  store.insertKingdom({ kingdom_id: kingdomId, name: 'Handoff', created_at: timestamp, owner_id: 'owner', owner_name: 'Owner' })
  for (const [bindingId, roleType] of [
    [supervisorId, 'SUPERVISOR'],
    [fromWorkerId, 'WORKER'],
    [toWorkerId, 'WORKER'],
  ] as const) {
    store.insertBinding({
      binding_id: bindingId,
      kingdom_id: kingdomId,
      role_type: roleType,
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
      created_at: timestamp,
      updated_at: timestamp,
    })
  }
  store.insertTerritory({
    territory_id: territoryId,
    kingdom_id: kingdomId,
    name: 'Handoff Territory',
    workspace_path: 'C:/private/territory',
    summary: null,
    supervisor_binding_id: supervisorId,
    status: 'ACTIVE',
    deleted_at: null,
    deleted_reason: null,
    created_at: timestamp,
  })
  store.insertTask({
    task_id: taskId,
    territory_id: territoryId,
    parent_task_id: null,
    title: 'Handoff task',
    description: null,
    assigned_binding_id: toWorkerId,
    status: 'RUNNING',
    acceptance_criteria: null,
    result_summary: null,
    created_at: timestamp,
    updated_at: timestamp,
  })
  store.insertTaskAssignment({
    assignment_id: fromAssignmentId,
    task_id: taskId,
    territory_id: territoryId,
    worker_binding_id: fromWorkerId,
    assigned_by: supervisorId,
    assigned_at: timestamp,
    ended_at: timestamp,
    end_reason: 'handoff',
    previous_assignment_id: null,
    handoff_reason: null,
    created_at: timestamp,
  })
  store.insertTaskAssignment({
    assignment_id: toAssignmentId,
    task_id: taskId,
    territory_id: territoryId,
    worker_binding_id: toWorkerId,
    assigned_by: supervisorId,
    assigned_at: timestamp,
    ended_at: null,
    end_reason: null,
    previous_assignment_id: fromAssignmentId,
    handoff_reason: privateReason,
    created_at: timestamp,
  })
  store.appendEvent({
    event_id: 'handoff-event',
    kingdom_id: kingdomId,
    event_type: 'TASK_HANDED_OFF',
    actor_role: 'SUPERVISOR',
    actor_id: supervisorId,
    target_type: 'task',
    target_id: taskId,
    payload_json: JSON.stringify({
      from_assignment_id: fromAssignmentId,
      from_worker_binding_id: fromWorkerId,
      to_assignment_id: toAssignmentId,
      to_worker_binding_id: toWorkerId,
      handoff_reason: privateReason,
      reviewed_attempt_no: 7,
      reviewer_binding_id: toWorkerId,
      claimed_outcome: 'COMPLETED',
    }),
    created_at: timestamp,
  })

  const detail = buildTaskDetail(store, kingdomId, taskId)!
  assert.equal(detail.reviews.length, 1)
  const decision = detail.reviews[0]!
  assert.equal(decision.decision, 'HANDOFF')
  assert.equal(decision.reviewerBindingId, supervisorId)
  assert.equal(decision.reviewedAttemptNo, 7)
  assert.equal(decision.claimedOutcome, null)
  assert.equal(decision.fromAssignmentId, fromAssignmentId)
  assert.equal(decision.fromWorkerBindingId, fromWorkerId)
  assert.equal(decision.toAssignmentId, toAssignmentId)
  assert.equal(decision.toWorkerBindingId, toWorkerId)
  assert.ok(decision.reason?.includes('[redacted-path]'))
  assert.ok((decision.reason?.length ?? 0) <= 140)
  assert.doesNotMatch(decision.reason ?? '', /C:\/private|reason[.]txt/u)
  assert.equal(decision.reason?.includes(freeTextSecret), false)
  assert.ok(decision.sourceRefs.length <= 8)
  assert.ok(decision.sourceRefs.some(ref => ref.sourceType === 'event'))
  assert.ok(decision.sourceRefs.some(ref => ref.entityType === 'task_assignments' && ref.entityId === toAssignmentId))
  assert.ok(decision.sourceRefs.every(ref => ref.entityId === null || ref.entityId.length <= 96))
  assert.equal(detail.assignments.find(item => item.assignmentId === toAssignmentId)?.handoffReason?.includes(freeTextSecret), false)
  assert.equal(JSON.stringify(detail).includes(freeTextSecret), false)
})

test('testV1ProjectionAddsBoundedOrganizationExecutionHistoryAndActionTruth', async () => {
  const { store, kingdomId, worker, sup, terrA } = await makeGovernedStore()
  const freeTextSecret = 'opaqueFreeTextSecret42'

  for (let index = 0; index < 65; index += 1) {
    store.insertBinding({
      binding_id: `v1-extra-worker-${String(index).padStart(2, '0')}`,
      kingdom_id: kingdomId,
      role_type: 'WORKER',
      role_name: `Extra Worker ${index}`,
      runtime_type: 'dsh',
      session_id: 'private-session-must-not-project',
      model_name: 'private-model-must-not-project',
      agent_name: 'private-agent-must-not-project',
      session_meta: JSON.stringify({ token: 'private-token-must-not-project' }),
      execution_profile_json: JSON.stringify({ provider: 'private-provider-must-not-project' }),
      status: 'ACTIVE',
      retired_at: null,
      retired_reason: null,
      principal_id: null,
      created_at: NOW(),
      updated_at: NOW(),
    })
    store.insertTerritory({
      territory_id: `v1-extra-territory-${String(index).padStart(2, '0')}`,
      kingdom_id: kingdomId,
      name: `Extra Territory ${index}`,
      workspace_path: `C:/private/territory-${index}`,
      summary: `safe territory summary token ${freeTextSecret} private-token-must-not-project`,
      supervisor_binding_id: sup,
      status: 'ACTIVE',
      deleted_at: null,
      deleted_reason: null,
      created_at: NOW(),
    })
  }

  const recoveringTaskId = 'v1-task-recovering'
  store.insertTask({
    task_id: recoveringTaskId,
    territory_id: terrA,
    parent_task_id: null,
    title: 'Recovering history',
    description: null,
    assigned_binding_id: worker,
    status: 'RUNNING',
    acceptance_criteria: null,
    result_summary: `safe task result token ${freeTextSecret} C:/private/result.txt private-result-must-not-project`,
    created_at: NOW(),
    updated_at: NOW(),
  })
  for (let attemptNo = 1; attemptNo <= 101; attemptNo += 1) {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, attemptNo)).toISOString()
    store.insertExecution({
      execution_id: `v1-history-execution-${String(attemptNo).padStart(3, '0')}`,
      task_id: recoveringTaskId,
      attempt_no: attemptNo,
      worker_binding_id: worker,
      session_id: 'private-execution-session-must-not-project',
      state: attemptNo === 101 ? 'RECOVERING' : 'COMPLETED',
      detail: `safe execution detail token ${freeTextSecret} C:/private/runtime/detail.txt private-detail-must-not-project`,
      started_at: timestamp,
      heartbeat_at: null,
      ended_at: attemptNo === 101 ? null : timestamp,
      pause_requested_at: null,
      executor_kind: 'private-executor-must-not-project',
      provider: 'private-provider-must-not-project',
      provider_source: 'binding',
      requested_model: 'private-requested-model-must-not-project',
      resolved_model: 'private-effective-model-must-not-project',
      model_source: 'binding',
      execution_profile_json: JSON.stringify({ token: 'private-profile-token-must-not-project' }),
      execution_contract: 'LEGACY_COMPAT',
      lease_id: null,
      capability_decision_id: null,
    })
  }

  const reviewTaskId = 'v1-task-review'
  store.insertTask({
    task_id: reviewTaskId,
    territory_id: terrA,
    parent_task_id: null,
    title: 'Review history',
    description: null,
    assigned_binding_id: worker,
    status: 'REVIEW',
    acceptance_criteria: null,
    result_summary: null,
    created_at: NOW(),
    updated_at: NOW(),
  })
  store.insertTaskAssignment({
    assignment_id: 'v1-assignment-review',
    task_id: reviewTaskId,
    territory_id: terrA,
    worker_binding_id: worker,
    assigned_by: sup,
    assigned_at: NOW(),
    ended_at: null,
    end_reason: null,
    previous_assignment_id: null,
    handoff_reason: null,
    created_at: NOW(),
  })
  store.insertWorkerResult({
    result_id: 'v1-claim-safe',
    task_id: reviewTaskId,
    attempt_no: 1,
    worker_binding_id: worker,
    session_id: 'private-claim-session-must-not-project',
    outcome: 'NOT_RUN',
    result_json: JSON.stringify({
      summary: `safe claim summary token ${freeTextSecret} C:/private/claim.txt private-summary-must-not-project`,
      artifacts: ['safe-artifact', `safe artifact token ${freeTextSecret}`, 'C:/private/artifact.txt', 'private-artifact-must-not-project'],
      risks: ['safe-risk', `safe risk cookie ${freeTextSecret}`, 'private-risk-must-not-project'],
    }),
    created_at: NOW(),
  })
  store.appendEvent({
    event_id: 'v1-event-not-run',
    kingdom_id: kingdomId,
    event_type: 'NOT_RUN',
    actor_role: null,
    actor_id: null,
    target_type: 'task',
    target_id: reviewTaskId,
    payload_json: JSON.stringify({ cookie: 'private-event-cookie-must-not-project' }),
    created_at: NOW(),
  })

  const beforeRevision = store.revision(kingdomId)
  const snapshot = buildSnapshot(store, {
    auth: { mode: 'session-bound', trustLevel: 'session-verified', note: '' },
    nowMs: Date.now(),
  })
  const organization = snapshot.projection.organization.data
  assert.ok(organization.bindingCount > organization.roles.length)
  assert.ok(organization.roles.length <= 64)
  assert.equal(organization.rolesTruncated, true)
  assert.ok(organization.territoryCount > organization.territories.length)
  assert.ok(organization.territories.length <= 64)
  assert.equal(organization.territoriesTruncated, true)
  assert.ok(organization.roles.every(item => item.status.sourceKind === 'GOVERNANCE_FACT'))

  const executionProjection = snapshot.projection.executions.data
  assert.ok(executionProjection.totalExecutionCount > executionProjection.items.length)
  assert.equal(executionProjection.items.length, 100)
  assert.equal(executionProjection.truncated, true)
  const recovering = executionProjection.items.find(item => item.state === 'RECOVERING')
  assert.ok(recovering)
  assert.equal(recovering!.authoritativeState.sourceKind, 'RUNTIME_OBSERVATION')
  assert.equal(recovering!.terminality, 'UNKNOWN')
  assert.equal(recovering!.executionContract, 'LEGACY_COMPAT')
  assert.deepEqual(recovering!.actionAvailability, [])
  assert.equal(recovering!.attentionReason?.code, 'EXECUTION_RECOVERING')
  assert.ok(snapshot.projection.timeline.data.some(item => item.authoritativeState?.value === 'NOT_RUN'))

  const recoveringTask = snapshot.tasks.find(task => task.taskId === recoveringTaskId)!
  assert.match(recoveringTask.resultSummary ?? '', /^safe task result /u)
  assert.ok(recoveringTask.resultSummary?.includes('[redacted-path]'))
  assert.equal(recoveringTask.resultSummary?.includes(freeTextSecret), false)

  const ownerActions = new Map(snapshot.projection.overview.data.ownerActions.map(action => [action.action, action]))
  for (const actionName of ['init', 'reset', 'ceiling', 'territory.supervisor', 'role.bind', 'role.unbind', 'role.session', 'execution-profile']) {
    const action = ownerActions.get(actionName)
    assert.ok(action, `missing Owner action truth for ${actionName}`)
    assert.equal(action!.executable, false)
    assert.equal(action!.disabledReason?.code, 'DIRECT_SLASH_REQUIRED')
  }

  const reviewDetail = buildTaskDetail(store, kingdomId, reviewTaskId)!
  assert.ok(reviewDetail.projection.data.actionAvailability.some(action => action.action === 'review:handoff'))
  assert.equal(reviewDetail.assignments.length, 1)
  assert.equal(reviewDetail.assignments[0]!.assignmentId, 'v1-assignment-review')
  const recoveringDetail = buildTaskDetail(store, kingdomId, recoveringTaskId)!
  assert.deepEqual(recoveringDetail.projection.data.actionAvailability, [], 'RECOVERING must not expose duplicate start')
  assert.equal(recoveringDetail.task.resultSummary, recoveringTask.resultSummary)

  const extraBinding = snapshot.bindings.find(binding => binding.bindingId === 'v1-extra-worker-00')!
  assert.equal(extraBinding.roleName, 'Extra Worker 0')
  assert.equal(extraBinding.runtimeType, 'dsh')
  assert.equal(extraBinding.modelName, '[REDACTED]')
  assert.equal(extraBinding.agentName, '[REDACTED]')
  assert.deepEqual(extraBinding.executionProfile, { provider: '[REDACTED]', model: null })
  const extraTerritory = snapshot.territories.find(territory => territory.territoryId === 'v1-extra-territory-00')!
  assert.equal(extraTerritory.name, 'Extra Territory 0')
  assert.equal(extraTerritory.status, 'ACTIVE')
  assert.equal(extraTerritory.workspacePath, '[redacted-path]')
  assert.match(extraTerritory.summary ?? '', /^safe territory summary /u)
  assert.equal(extraTerritory.summary?.includes(freeTextSecret), false)
  const recoveringExecution = recoveringDetail.executions.find(execution => execution.attemptNo === 101)!
  assert.match(recoveringExecution.detail ?? '', /^safe execution detail /u)
  assert.ok(recoveringExecution.detail?.includes('[redacted-path]'))
  assert.equal(recoveringExecution.detail?.includes(freeTextSecret), false)
  assert.ok(recoveringExecution.sessionId?.startsWith('…'))
  const projectedClaim = reviewDetail.claims.find(claim => claim.resultId === 'v1-claim-safe')!
  assert.match(projectedClaim.summary ?? '', /^safe claim summary /u)
  assert.ok(projectedClaim.artifacts.includes('safe-artifact'))
  assert.ok(projectedClaim.risks.includes('safe-risk'))

  const snapshotJson = JSON.stringify(snapshot)
  const fullProjectionBodies = [snapshotJson, JSON.stringify(reviewDetail), JSON.stringify(recoveringDetail)]
  for (const body of fullProjectionBodies) {
    assert.doesNotMatch(body, /private-[A-Za-z0-9._/-]+/iu)
    assert.doesNotMatch(body, /C:\/private/iu)
    assert.equal(body.includes(freeTextSecret), false)
  }

  const port = 19287 + Math.floor(Math.random() * 100)
  const bearer = 'v1-bounded-projection-http-fixture'
  const close = startGuiServer({
    snapshot: () => snapshot,
    taskDetail: requestedTaskId => buildTaskDetail(store, kingdomId, requestedTaskId),
    eventsSince: (afterSeq, limit) => ({
      revision: store.revision(kingdomId),
      events: store.listEventsSince(kingdomId, afterSeq, limit).map(toEventView),
    }),
    command: async () => ({}) as never,
  }, { port, token: bearer })
  try {
    for (const url of [
      `http://127.0.0.1:${port}/api/snapshot`,
      `http://127.0.0.1:${port}/api/tasks/${encodeURIComponent(reviewTaskId)}`,
      `http://127.0.0.1:${port}/api/tasks/${encodeURIComponent(recoveringTaskId)}`,
      `http://127.0.0.1:${port}/api/events?since=0&limit=1000`,
    ]) {
      const response = await eventuallyFetch(url, { headers: { authorization: `Bearer ${bearer}` } })
      const body = await response.text()
      assert.equal(response.status, 200)
      assert.doesNotMatch(body, /private-[A-Za-z0-9._/-]+/iu)
      assert.doesNotMatch(body, /C:\/private/iu)
      assert.equal(body.includes(freeTextSecret), false)
    }
  } finally {
    close()
  }
  assert.equal(store.revision(kingdomId), beforeRevision, 'v1 projection remains zero-write')
})

test('testV1ProjectionSourceRefsRejectPrivateIdentitiesAndRemainBounded', () => {
  const refs = boundedSourceRefs([
    { sourceType: 'table-row', entityType: 'session_exports', entityId: 'private-session-ref' },
    { sourceType: 'derived-rule', entityType: 'private-config', entityId: 'private-cookie-ref', ruleCode: 'C:/private/config.json' },
    ...Array.from({ length: 12 }, (_, index) => ({
      sourceType: 'table-row' as const,
      entityType: 'tasks',
      entityId: `task-safe-${index}`,
    })),
  ])
  const json = JSON.stringify(refs)
  assert.equal(refs.length, 8)
  assert.doesNotMatch(json, /private-session-ref|private-cookie-ref|session_exports|private-config|config\.json/u)
  assert.ok(refs.some(ref => ref.entityType === 'redacted-source' && ref.entityId === null))
})

test('testEventPayloadProjectionIsRecursivelyBoundedAndRedactedAcrossHttpReads', async () => {
  const { store, kingdomId, worker, sup, taskId } = await makeGovernedStore()
  const secrets = {
    bindingSession: 'complete-binding-session-private-value',
    runtimeSession: 'sess-long-id-12345678',
    eventSession: 'complete-event-session-private-value',
    principal: 'complete-principal-private-value',
    token: 'complete-token-private-value',
    cookie: 'complete-cookie-private-value',
    credential: 'complete-credential-private-value',
    privateConfig: 'complete-private-config-value',
    inline: 'complete-inline-secret-value',
    model: 'opaque-model-value-99',
    agent: 'opaque-agent-value-99',
    provider: 'opaque-provider-value-99',
    profileModel: 'opaque-profile-model-value-99',
    shortSession: 's3cr3t',
    freeText: 'opaqueFreeTextSecret99',
  }
  store.updateBindingProfile(worker, {
    sessionId: secrets.bindingSession,
    modelName: secrets.model,
    agentName: secrets.agent,
    sessionMeta: JSON.stringify({
      safe_label: 'keep-session-meta-safe',
      session_id: secrets.eventSession,
      nested: {
        safe: 'keep-session-meta-nested-safe',
        principal_id: secrets.principal,
        token: secrets.token,
        cookie: secrets.cookie,
        credential: secrets.credential,
        private_config: { value: secrets.privateConfig },
      },
      free_note: `safe metadata principal ${secrets.freeText}`,
      long_text: 'm'.repeat(700),
    }),
  }, NOW())
  store.updateBindingSession(sup, secrets.shortSession, NOW())
  store.setExecutionProfileJson(worker, JSON.stringify({
    provider: secrets.provider,
    model: secrets.profileModel,
  }))
  store.appendEvent({
    event_id: 'privacy-projection-fixture',
    kingdom_id: kingdomId,
    event_type: 'PRIVACY_PROJECTION_FIXTURE',
    actor_role: 'SUPERVISOR',
    actor_id: 'safe-supervisor-reference',
    target_type: 'task',
    target_id: taskId,
    payload_json: JSON.stringify({
      task_id: taskId,
      attempt_no: 7,
      decision: 'NOT_RUN',
      safe: 'keep-event-safe',
      session_id: secrets.eventSession,
      nested: {
        safe: 'keep-event-nested-safe',
        principal_id: secrets.principal,
        token: secrets.token,
        cookie: secrets.cookie,
        credential: secrets.credential,
        private_config: secrets.privateConfig,
      },
      inline_note: `token=${secrets.inline}`,
      free_note: `safe event token ${secrets.freeText}`,
      long_text: 'e'.repeat(700),
      many: Array.from({ length: 40 }, (_, index) => `safe-${index}`),
      many_keys: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`safe_${index}`, index])),
      deep: { l1: { l2: { l3: { l4: { l5: { l6: { safe: 'too-deep' } } } } } } },
      node_budget: Array.from({ length: 32 }, () => Array.from({ length: 32 }, (_, index) => index)),
    }),
    created_at: NOW(),
  })

  const before = captureProjectionPersistence(store, kingdomId, taskId)
  const snapshot = buildSnapshot(store, {
    auth: { mode: 'session-bound', trustLevel: 'session-verified', note: '' },
    eventLimit: 200,
  })
  const detail = buildTaskDetail(store, kingdomId, taskId)!
  const snapshotJson = JSON.stringify(snapshot)
  const detailJson = JSON.stringify(detail)
  for (const secret of Object.values(secrets)) {
    assert.equal(snapshotJson.includes(secret), false, `snapshot must redact ${secret}`)
    assert.equal(detailJson.includes(secret), false, `Task Detail must redact ${secret}`)
  }

  const snapshotBinding = snapshot.bindings.find(binding => binding.bindingId === worker)!
  const detailBinding = detail.assignedBinding!
  for (const binding of [snapshotBinding, detailBinding]) {
    assert.equal(binding.roleName, 'W')
    assert.equal(binding.runtimeType, 'dsh')
    assert.equal(binding.modelName, '[REDACTED]')
    assert.equal(binding.agentName, '[REDACTED]')
    assert.deepEqual(binding.executionProfile, { provider: '[REDACTED]', model: '[REDACTED]' })
    assert.equal(binding.sessionMeta?.safe_label, 'keep-session-meta-safe')
    assert.equal(binding.sessionMeta?.session_id, '[REDACTED]')
    assert.equal((binding.sessionMeta?.nested as Record<string, unknown>).safe, 'keep-session-meta-nested-safe')
    assert.equal((binding.sessionMeta?.nested as Record<string, unknown>).principal_id, '[REDACTED]')
    assert.ok(String(binding.sessionMeta?.long_text).endsWith('…[TRUNCATED]'))
    assert.ok(String(binding.sessionMeta?.long_text).length <= 512)
  }
  const unconfiguredBinding = snapshot.bindings.find(binding => binding.bindingId === sup)!
  assert.equal(unconfiguredBinding.sessionDisplay, '[REDACTED]')
  assert.equal(unconfiguredBinding.modelName, null)
  assert.equal(unconfiguredBinding.agentName, null)
  assert.equal(unconfiguredBinding.executionProfile, null)
  const event = snapshot.recentEvents.find(item => item.eventId === 'privacy-projection-fixture')!
  assert.equal(event.payload.safe, 'keep-event-safe')
  assert.equal(event.payload.attempt_no, 7)
  assert.equal(event.payload.session_id, '[REDACTED]')
  assert.equal((event.payload.nested as Record<string, unknown>).safe, 'keep-event-nested-safe')
  assert.equal((event.payload.nested as Record<string, unknown>).token, '[REDACTED]')
  assert.equal(event.payload.inline_note, '[REDACTED]')
  assert.equal(event.payload.free_note, 'safe event [REDACTED]')
  assert.ok(String(event.payload.long_text).endsWith('…[TRUNCATED]'))
  assert.deepEqual((event.payload.many as unknown[]).slice(-1), ['[TRUNCATED_ARRAY]'])
  assert.equal((event.payload.many_keys as Record<string, unknown>).__projectionTruncated__, 8)
  assert.ok(JSON.stringify(event.payload).includes('[TRUNCATED_DEPTH]'))
  assert.ok(JSON.stringify(event.payload).includes('[TRUNCATED_NODES]'))
  assert.deepEqual(store.listEvents(kingdomId, 500).map(toEventView)
    .find(item => item.eventId === event.eventId)?.payload, event.payload)

  const port = 19187 + Math.floor(Math.random() * 100)
  const bearer = 'projection-redaction-http-fixture'
  const close = startGuiServer({
    snapshot: () => buildSnapshot(store, {
      auth: { mode: 'session-bound', trustLevel: 'session-verified', note: '' },
      eventLimit: 200,
    }),
    taskDetail: requestedTaskId => buildTaskDetail(store, kingdomId, requestedTaskId),
    eventsSince: (afterSeq, limit) => ({
      revision: store.revision(kingdomId),
      events: store.listEventsSince(kingdomId, afterSeq, limit).map(toEventView),
    }),
    command: async () => ({}) as never,
  }, { port, token: bearer })
  try {
    const urls = [
      `http://127.0.0.1:${port}/api/snapshot`,
      `http://127.0.0.1:${port}/api/tasks/${encodeURIComponent(taskId)}`,
      `http://127.0.0.1:${port}/api/events?since=0&limit=1000`,
    ]
    for (const url of urls) {
      const response = await eventuallyFetch(url, {
        headers: { authorization: `Bearer ${bearer}` },
      })
      const body = await response.text()
      assert.equal(response.status, 200)
      assert.ok(body.includes('keep-event-safe') || body.includes('keep-session-meta-safe'))
      for (const secret of Object.values(secrets)) {
        assert.equal(body.includes(secret), false, `${url} must redact ${secret}`)
      }
    }
  } finally {
    close()
  }
  assert.deepEqual(captureProjectionPersistence(store, kingdomId, taskId), before)
})

async function eventuallyFetch(url: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      return await fetch(url, init)
    } catch (error: unknown) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('server did not become reachable')
}

test('testReadOnlyConsoleRoute', async () => {
  assert.match(READONLY_CONSOLE_HTML, /状态总览/u)
  assert.match(READONLY_CONSOLE_HTML, /Task Detail/u)
  assert.match(READONLY_CONSOLE_HTML, /Timeline/u)
  assert.match(READONLY_CONSOLE_HTML, /Attention/u)
  const port = 18987 + Math.floor(Math.random() * 100)
  const close = startGuiServer({
    snapshot: () => ({}) as never,
    taskDetail: () => null,
    eventsSince: () => ({ revision: 0, events: [] }),
    command: async () => ({}) as never,
  }, { port })
  try {
    const response = await eventuallyFetch(`http://127.0.0.1:${port}/console`)
    const body = await response.text()
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/html/u)
    assert.match(body, /DIRECT_SLASH_REQUIRED/u)
  } finally {
    close()
  }
})

test('testReadOnlyConsoleKeepsPostRoutesFailClosed', async () => {
  let commandCalls = 0
  const port = 19087 + Math.floor(Math.random() * 100)
  const close = startGuiServer({
    snapshot: () => ({}) as never,
    taskDetail: () => null,
    eventsSince: () => ({ revision: 0, events: [] }),
    command: async () => {
      commandCalls++
      return ({ ok: true, errorCode: null, message: 'test', task: null, execution: null, emittedEvents: [], allowedActions: [], revision: 0 }) as never
    },
  }, { port })
  try {
    const response = await eventuallyFetch(`http://127.0.0.1:${port}/console`)
    assert.equal(response.status, 200)
    assert.equal(commandCalls, 0)
    const post = await eventuallyFetch(`http://127.0.0.1:${port}/api/commands/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kingdom-client': 'test' },
      body: '{}',
    })
    assert.equal(post.status, 401)
    assert.equal((await post.json() as { errorCode?: string }).errorCode, 'CONTROL_SESSION_REQUIRED')
    assert.equal(commandCalls, 0)
  } finally {
    close()
  }
})
