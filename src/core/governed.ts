/**
 * dsh-kingdom — v0.8 Runtime Governance Domain API（M3-S2 Schema v4 Design v6）。
 *
 * 这是 Kingdom Core 与四套 v4 Ledger（Affinity / Lease / Capability Decision / Dispatch）
 * 之间的**最小权威写入面**：上层（S3 Adapter / S4 Resolver / S5 Dispatch/Reconcile /
 * 既有 TaskService 的 governed 路径）只允许经本模块进入这些 Ledger，不散写 SQL。
 *
 * 纪律（Owner v0.8 施工 Prompt §15）：
 * - transaction boundary 清晰：多步写（如 TX-3：Execution + Decision.execution_id 回填 +
 *   Dispatch Intent + Lease 推进）在单个 withImmediateTransaction 内原子完成；
 * - fail-closed：任何一步抛错整体回滚，不产生半状态；
 * - 禁止客户端自报权威值：状态推进一律 CAS（期望旧态）+ DB trigger 权威校验；
 * - 非 v4 库：一律抛 SchemaV4NotMigratedError（正式库 Gate 保护下可用 v3 功能，
 *   governed 路径拒绝执行）。
 *
 * 状态机的**权威**在 DB trigger（v6 硬编码 transition matrix + INSERT 守卫），
 * 本模块的 CAS 只是并发防护与错误信息的第二道防线。
 */
import { randomUUID } from 'node:crypto'
import {
  KingdomStore,
  type AffinityRow,
  type LeaseRow,
  type CapabilityDecisionRow,
  type DispatchRecordRow,
  type ExecutionRow,
  StaleStateError,
} from './db.js'
import { asExecutionState, transitionExecution, isTerminalExecutionState } from './execution.js'

/** 完整 Runtime Session identity（M3-S1 冻结：(runtime_type, runtime_instance_ref, session_ref)）。 */
export interface SessionIdentity {
  runtimeType: string
  runtimeInstanceRef: string
  sessionRef: string
}

/** v0.8 governed 路径统一错误基类。 */
export class GovernedApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GovernedApiError'
  }
}

/** 库未迁移 v4 时调用 governed API。fail-closed：不静默降级。 */
export class SchemaV4NotMigratedError extends GovernedApiError {
  constructor() {
    super('Schema v4 未迁移：governed Runtime Governance API 不可用（正式 kingdom.db 迁移须经 Formal DB Migration Gate）')
    this.name = 'SchemaV4NotMigratedError'
  }
}

/** 期望旧态与当前库态不一致（CAS 失败）。 */
export class StaleLeaseError extends StaleStateError {}
export class StaleDispatchError extends StaleStateError {}

function requireV4(store: KingdomStore): void {
  if (!store.isSchemaV4) throw new SchemaV4NotMigratedError()
}

function now(): string {
  return new Date().toISOString()
}

interface EventSeed {
  kingdomId: string
  eventType: string
  targetType: string
  targetId: string
  payload?: Record<string, unknown>
}

/** 在事务内追加治理事件（appendEvent 已支持嵌套事务）。 */
function emit(store: KingdomStore, seed: EventSeed): void {
  store.appendEvent({
    event_id: randomUUID(),
    kingdom_id: seed.kingdomId,
    event_type: seed.eventType,
    actor_role: 'SYSTEM',
    actor_id: 'kingdom-core',
    target_type: seed.targetType,
    target_id: seed.targetId,
    payload_json: JSON.stringify(seed.payload ?? {}),
    created_at: now(),
  })
}

// ── 1. Affinity（Session ↔ Territory）───────────────────────────────────────

export interface EstablishAffinityInput {
  kingdomId: string
  /** 须为 ACTIVE 的 WORKER binding（v0.8 Worker 模型）。 */
  workerBindingId: string
  session: SessionIdentity
  /** 须为本王国 ACTIVE Territory。 */
  territoryId: string
  affinityId?: string
  establishedAt?: string
}

/** 建立 Affinity（v6 I-5：session identity 唯一、一 Worker 一 current；DB 唯一索引/CHECK 权威强制）。 */
export function establishAffinity(store: KingdomStore, input: EstablishAffinityInput): AffinityRow {
  requireV4(store)
  const binding = store.getBindingById(input.workerBindingId)
  if (!binding || binding.role_type !== 'WORKER' || binding.status !== 'ACTIVE') {
    throw new GovernedApiError(`establishAffinity: worker binding ${input.workerBindingId} 不存在或非 ACTIVE WORKER`)
  }
  const territory = store.getTerritoryById(input.territoryId)
  if (!territory || territory.kingdom_id !== input.kingdomId || territory.status === 'DELETED') {
    throw new GovernedApiError(`establishAffinity: territory ${input.territoryId} 不存在、非本王国或已删除`)
  }
  return store.withImmediateTransaction(() => {
    const at = input.establishedAt ?? now()
    const row: AffinityRow = {
      affinity_id: input.affinityId ?? randomUUID(),
      kingdom_id: input.kingdomId,
      worker_binding_id: input.workerBindingId,
      runtime_type: input.session.runtimeType,
      runtime_instance_ref: input.session.runtimeInstanceRef,
      session_ref: input.session.sessionRef,
      territory_id: input.territoryId,
      established_at: at,
      retired_at: null,
      is_current: 1,
      created_at: at,
    }
    const inserted = store.insertAffinity(row)
    emit(store, {
      kingdomId: input.kingdomId,
      eventType: 'AFFINITY_ESTABLISHED',
      targetType: 'affinity',
      targetId: inserted.affinity_id,
      payload: { worker: input.workerBindingId, session: input.session, territory: input.territoryId },
    })
    return inserted
  })
}

/** 退役 Affinity（v6：唯一合法联合转换 (1,NULL)→(0,val) 且只能一次；跨 Territory 必须新 Session）。 */
export function retireAffinity(store: KingdomStore, affinityId: string, retiredAt?: string): AffinityRow {
  requireV4(store)
  const current = store.getAffinity(affinityId)
  if (!current) throw new GovernedApiError(`retireAffinity: affinity ${affinityId} 不存在`)
  if (current.is_current === 0) throw new GovernedApiError(`retireAffinity: affinity ${affinityId} 已退役（不可二次退役）`)
  return store.withImmediateTransaction(() => {
    const updated = store.retireAffinityRow(affinityId, retiredAt ?? now())
    if (!updated) throw new GovernedApiError(`retireAffinity: affinity ${affinityId} 更新后消失`)
    emit(store, {
      kingdomId: current.kingdom_id,
      eventType: 'AFFINITY_RETIRED',
      targetType: 'affinity',
      targetId: affinityId,
      payload: { session: current.session_ref, territory: current.territory_id, retiredAt: updated.retired_at },
    })
    return updated
  })
}

// ── 2. Execution Lease ────────────────────────────────────────────────────────

export interface AcquireLeaseInput {
  kingdomId: string
  workerBindingId: string
  session: SessionIdentity
  territoryId: string
  taskId: string
  attemptNo: number
  leaseId?: string
  acquiredAt?: string
}

/** acquire Lease（v6 I-11：acquire 时验证 current Affinity + Task Territory 闭环；trigger 权威强制）。 */
export function acquireExecutionLease(store: KingdomStore, input: AcquireLeaseInput): LeaseRow {
  requireV4(store)
  const task = store.getTask(input.taskId)
  if (!task) throw new GovernedApiError(`acquireExecutionLease: task ${input.taskId} 不存在`)
  if (task.territory_id !== input.territoryId) {
    throw new GovernedApiError(`acquireExecutionLease: task ${input.taskId} 的 territory ${task.territory_id} ≠ lease territory ${input.territoryId}`)
  }
  return store.withImmediateTransaction(() => {
    const at = input.acquiredAt ?? now()
    const row: LeaseRow = {
      lease_id: input.leaseId ?? randomUUID(),
      kingdom_id: input.kingdomId,
      worker_binding_id: input.workerBindingId,
      runtime_type: input.session.runtimeType,
      runtime_instance_ref: input.session.runtimeInstanceRef,
      session_ref: input.session.sessionRef,
      territory_id: input.territoryId,
      task_id: input.taskId,
      attempt_no: input.attemptNo,
      state: 'ACQUIRED',
      capability_decision_id: null,
      enforcement_plan_snapshot: null,
      release_evidence_json: null,
      release_reason: null,
      acquired_at: at,
      released_at: null,
      updated_at: at,
    }
    const inserted = store.insertLease(row)
    emit(store, {
      kingdomId: input.kingdomId,
      eventType: 'LEASE_ACQUIRED',
      targetType: 'lease',
      targetId: inserted.lease_id,
      payload: { task: input.taskId, attempt: input.attemptNo, session: input.session, worker: input.workerBindingId },
    })
    return inserted
  })
}

export interface AdvanceLeaseInput {
  plan?: string | null
  decisionId?: string | null
  releaseEvidence?: string | null
  releaseReason?: string | null
  releasedAt?: string | null
}

/** CAS 推进 Lease 状态（转移合法性由 lease_state_guard trigger 权威执行）。 */
export function advanceLeaseState(store: KingdomStore, leaseId: string, to: string, extra: AdvanceLeaseInput = {}): LeaseRow {
  requireV4(store)
  const lease = store.getLease(leaseId)
  if (!lease) throw new GovernedApiError(`advanceLeaseState: lease ${leaseId} 不存在`)
  if (lease.state === 'RELEASED' && to === 'RELEASED') return lease
  return store.withImmediateTransaction(() => {
    const at = now()
    const updated = store.updateLeaseState(leaseId, lease.state, to, {
      plan: extra.plan,
      decisionId: extra.decisionId,
      releaseEvidence: extra.releaseEvidence,
      releaseReason: extra.releaseReason,
      releasedAt: extra.releasedAt,
    }, at)
    emit(store, {
      kingdomId: lease.kingdom_id,
      eventType: 'LEASE_STATE_CHANGED',
      targetType: 'lease',
      targetId: leaseId,
      payload: { from: lease.state, to, plan: extra.plan !== undefined, decisionId: extra.decisionId ?? undefined },
    })
    return updated
  })
}

/** 写 Enforcement Plan（一次 NULL→value；lease_plan_once trigger 强制）。 */
export function setLeasePlan(store: KingdomStore, leaseId: string, planJson: string): LeaseRow {
  return advanceLeaseState(store, leaseId, store.getLease(leaseId)!.state, { plan: planJson })
}

/** late-bind Capability Decision（一次 NULL→value；lease_decision_once trigger 强制）。 */
export function bindCapabilityDecision(store: KingdomStore, leaseId: string, decisionId: string): LeaseRow {
  const lease = store.getLease(leaseId)
  if (!lease) throw new GovernedApiError(`bindCapabilityDecision: lease ${leaseId} 不存在`)
  if (lease.capability_decision_id !== null) {
    throw new GovernedApiError(`bindCapabilityDecision: lease ${leaseId} 已绑定 ${lease.capability_decision_id}（不可重绑）`)
  }
  return advanceLeaseState(store, leaseId, lease.state, { decisionId })
}

/**
 * release Lease（v6：仅 RELEASED 释放；必须带 release/cleanup evidence + released_at；
 * cleanup 不明 → 进 RECOVERING，禁止直接 RELEASED）。
 */
export function releaseExecutionLease(store: KingdomStore, leaseId: string, evidence: Record<string, unknown>, reason: string): LeaseRow {
  requireV4(store)
  const lease = store.getLease(leaseId)
  if (!lease) throw new GovernedApiError(`releaseExecutionLease: lease ${leaseId} 不存在`)
  if (lease.state === 'RELEASED') return lease
  const releasableFrom = new Set(['MATERIALIZING', 'RELEASING', 'RECOVERING'])
  if (!releasableFrom.has(lease.state)) {
    throw new GovernedApiError(`releaseExecutionLease: lease ${leaseId} 不能从 ${lease.state} 释放（合法：MATERIALIZING/RELEASING/RECOVERING）`)
  }
  return store.withImmediateTransaction(() => {
    const at = now()
    const updated = store.updateLeaseState(leaseId, lease.state, 'RELEASED', {
      releaseEvidence: JSON.stringify({ type: 'ReleaseEvidence/v1', payload: evidence }),
      releaseReason: reason,
      releasedAt: at,
    }, at)
    emit(store, {
      kingdomId: lease.kingdom_id,
      eventType: 'LEASE_RELEASED',
      targetType: 'lease',
      targetId: leaseId,
      payload: { reason, session: lease.session_ref },
    })
    return updated
  })
}

// ── 3. Capability Decision ───────────────────────────────────────────────────

export interface RecordDecisionInput {
  kingdomId: string
  taskId: string
  workerBindingId?: string | null
  supervisorBindingId?: string | null
  requirementSnapshot?: string | null
  ceilingSnapshot?: string | null
  proposedGrantSnapshot?: string | null
  scopeSnapshot?: string | null
  effectiveSnapshot?: string | null
  decision: 'GRANTED' | 'DENIED'
  enforcementStatus: 'ENFORCED' | 'NOT_ATTEMPTED' | 'UNAVAILABLE' | 'FAILED'
  enforcementEvidenceJson?: string | null
  requirementCoverage?: 'FULL' | 'PARTIAL' | 'NONE'
  reasonCode?: string | null
  decisionId?: string
  createdAt?: string
}

/** 落 Final Capability Decision（合法组合由行内双向 CHECK 权威强制；创建后不可改写）。 */
export function recordCapabilityDecision(store: KingdomStore, input: RecordDecisionInput): CapabilityDecisionRow {
  requireV4(store)
  if (input.decision === 'GRANTED' && input.enforcementStatus !== 'ENFORCED') {
    throw new GovernedApiError(`recordCapabilityDecision: GRANTED 只能配 ENFORCED（收到 ${input.enforcementStatus}）`)
  }
  if (input.decision === 'DENIED' && input.enforcementStatus === 'ENFORCED') {
    throw new GovernedApiError('recordCapabilityDecision: DENIED 不能配 ENFORCED')
  }
  return store.withImmediateTransaction(() => {
    const row: CapabilityDecisionRow = {
      decision_id: input.decisionId ?? randomUUID(),
      kingdom_id: input.kingdomId,
      task_id: input.taskId,
      worker_binding_id: input.workerBindingId ?? null,
      supervisor_binding_id: input.supervisorBindingId ?? null,
      requirement_snapshot: input.requirementSnapshot ?? null,
      ceiling_snapshot: input.ceilingSnapshot ?? null,
      proposed_grant_snapshot: input.proposedGrantSnapshot ?? null,
      scope_snapshot: input.scopeSnapshot ?? null,
      effective_snapshot: input.effectiveSnapshot ?? null,
      decision: input.decision,
      enforcement_status: input.enforcementStatus,
      enforcement_evidence_json: input.enforcementEvidenceJson ?? null,
      requirement_coverage: input.requirementCoverage ?? 'NONE',
      reason_code: input.reasonCode ?? null,
      execution_id: null,
      created_at: input.createdAt ?? now(),
    }
    const inserted = store.insertCapabilityDecision(row)
    emit(store, {
      kingdomId: input.kingdomId,
      eventType: 'CAPABILITY_DECISION_RECORDED',
      targetType: 'decision',
      targetId: inserted.decision_id,
      payload: { task: input.taskId, decision: input.decision, enforcementStatus: input.enforcementStatus },
    })
    return inserted
  })
}

// ── 4. Governed Execution ────────────────────────────────────────────────────

export interface CreateGovernedExecutionInput {
  taskId: string
  attemptNo: number
  workerBindingId: string
  leaseId: string
  capabilityDecisionId: string
  sessionId?: string | null
  executionId?: string
  startedAt?: string
  detail?: string | null
}

/**
 * 创建 GOVERNED_PERSISTENT Execution（TX-3 第一步）：
 * 同一事务内：写 Execution（FK+consistency trigger 校验 Lease/Decision 存在且一致）→
 * 回填 Decision.execution_id（单绑，GRANTED+ENFORCED only）。
 */
export function createGovernedExecution(store: KingdomStore, input: CreateGovernedExecutionInput): ExecutionRow {
  requireV4(store)
  const lease = store.getLease(input.leaseId)
  if (!lease) throw new GovernedApiError(`createGovernedExecution: lease ${input.leaseId} 不存在`)
  const decision = store.getCapabilityDecision(input.capabilityDecisionId)
  if (!decision) throw new GovernedApiError(`createGovernedExecution: decision ${input.capabilityDecisionId} 不存在`)
  return store.withImmediateTransaction(() => {
    const at = input.startedAt ?? now()
    const executionId = input.executionId ?? randomUUID()
    const row: ExecutionRow = {
      execution_id: executionId,
      task_id: input.taskId,
      attempt_no: input.attemptNo,
      worker_binding_id: input.workerBindingId,
      session_id: input.sessionId ?? lease.session_ref,
      state: 'STARTING',
      detail: input.detail ?? null,
      started_at: at,
      heartbeat_at: at,
      ended_at: null,
      pause_requested_at: null,
      executor_kind: null,
      provider: null,
      provider_source: null,
      requested_model: null,
      resolved_model: null,
      model_source: null,
      execution_profile_json: null,
      execution_contract: 'GOVERNED_PERSISTENT',
      lease_id: input.leaseId,
      capability_decision_id: input.capabilityDecisionId,
    }
    const inserted = store.insertExecution(row)
    store.bindDecisionExecution(input.capabilityDecisionId, executionId)
    emit(store, {
      kingdomId: lease.kingdom_id,
      eventType: 'EXECUTION_GOVERNED_CREATED',
      targetType: 'execution',
      targetId: executionId,
      payload: { task: input.taskId, attempt: input.attemptNo, lease: input.leaseId, decision: input.capabilityDecisionId },
    })
    return inserted
  })
}

// ── 5. Dispatch Intent / Evidence ────────────────────────────────────────────

export interface CreateDispatchIntentInput {
  kingdomId: string
  leaseId: string
  executionId: string
  taskId: string
  attemptNo: number
  session: SessionIdentity
  requestSnapshot: string
  inputRefJson: string
  payloadHash: string
  dispatchId?: string
  createdAt?: string
}

/**
 * 写 Dispatch INTENDED（TX-3 的 COMMIT POINT）：
 * Runtime side effect（dispatch()）之前必须已持久化本记录；
 * 调用方在本函数返回（事务已提交）**之后**才允许调用 RuntimeAdapter.dispatch()。
 */
export function createDispatchIntent(store: KingdomStore, input: CreateDispatchIntentInput): DispatchRecordRow {
  requireV4(store)
  const execution = store.getExecution(input.executionId)
  if (!execution) throw new GovernedApiError(`createDispatchIntent: execution ${input.executionId} 不存在`)
  const lease = store.getLease(input.leaseId)
  if (!lease) throw new GovernedApiError(`createDispatchIntent: lease ${input.leaseId} 不存在`)
  return store.withImmediateTransaction(() => {
    const at = input.createdAt ?? now()
    const row: DispatchRecordRow = {
      dispatch_id: input.dispatchId ?? randomUUID(),
      kingdom_id: input.kingdomId,
      lease_id: input.leaseId,
      execution_id: input.executionId,
      task_id: input.taskId,
      attempt_no: input.attemptNo,
      runtime_type: input.session.runtimeType,
      runtime_instance_ref: input.session.runtimeInstanceRef,
      session_ref: input.session.sessionRef,
      state: 'INTENDED',
      dispatch_request_snapshot: input.requestSnapshot,
      dispatch_input_ref_json: input.inputRefJson,
      dispatch_payload_hash: input.payloadHash,
      runtime_dispatch_ref: null,
      runtime_execution_ref: null,
      receipt_json: null,
      terminal_evidence_json: null,
      output_ref_json: null,
      dispatched_at: null,
      receipt_at: null,
      terminal_at: null,
      created_at: at,
      updated_at: at,
    }
    const inserted = store.insertDispatchIntent(row)
    emit(store, {
      kingdomId: input.kingdomId,
      eventType: 'DISPATCH_INTENDED',
      targetType: 'dispatch',
      targetId: inserted.dispatch_id,
      payload: { lease: input.leaseId, execution: input.executionId, task: input.taskId, attempt: input.attemptNo },
    })
    return inserted
  })
}

export interface ReceiptInput {
  runtimeDispatchRef: string
  receiptJson: string
  at?: string
}

/**
 * 记录 Dispatch Receipt（TX-3R）：
 * INTENDED → DISPATCHED（runtime_dispatch_ref + dispatched_at）→ RECEIVED（receipt_json + receipt_at）。
 * DispatchReceipt 只证明 Runtime 接受了 dispatch，不等于 Terminal Evidence。
 */
export function recordDispatchReceipt(store: KingdomStore, dispatchId: string, input: ReceiptInput): DispatchRecordRow {
  requireV4(store)
  const dispatch = store.getDispatch(dispatchId)
  if (!dispatch) throw new GovernedApiError(`recordDispatchReceipt: dispatch ${dispatchId} 不存在`)
  if (dispatch.state === 'RECEIVED') return dispatch
  const at = input.at ?? now()
  return store.withImmediateTransaction(() => {
    let current = dispatch
    if (current.state === 'INTENDED') {
      current = store.updateDispatchState(dispatchId, 'INTENDED', 'DISPATCHED', {
        runtimeDispatchRef: input.runtimeDispatchRef,
        dispatchedAt: at,
      }, at)
    }
    if (current.state !== 'DISPATCHED') {
      throw new GovernedApiError(`recordDispatchReceipt: dispatch ${dispatchId} 状态 ${current.state} 不能进入 RECEIVED`)
    }
    const updated = store.updateDispatchState(dispatchId, 'DISPATCHED', 'RECEIVED', {
      receiptJson: input.receiptJson,
      receiptAt: at,
    }, at)
    emit(store, {
      kingdomId: dispatch.kingdom_id,
      eventType: 'DISPATCH_STATE_CHANGED',
      targetType: 'dispatch',
      targetId: dispatchId,
      payload: { from: dispatch.state, to: 'RECEIVED', runtimeDispatchRef: input.runtimeDispatchRef },
    })
    return updated
  })
}

/** RECEIVED → CORRELATED（绑定 runtime_execution_ref；TX-3R）。 */
export function correlateRuntimeExecution(store: KingdomStore, dispatchId: string, runtimeExecutionRef: string): DispatchRecordRow {
  requireV4(store)
  const dispatch = store.getDispatch(dispatchId)
  if (!dispatch) throw new GovernedApiError(`correlateRuntimeExecution: dispatch ${dispatchId} 不存在`)
  if (dispatch.state === 'CORRELATED') return dispatch
  if (dispatch.state !== 'RECEIVED') {
    throw new GovernedApiError(`correlateRuntimeExecution: dispatch ${dispatchId} 状态 ${dispatch.state} ≠ RECEIVED`)
  }
  return store.withImmediateTransaction(() => {
    const at = now()
    const updated = store.updateDispatchState(dispatchId, 'RECEIVED', 'CORRELATED', {
      runtimeExecutionRef,
    }, at)
    emit(store, {
      kingdomId: dispatch.kingdom_id,
      eventType: 'DISPATCH_STATE_CHANGED',
      targetType: 'dispatch',
      targetId: dispatchId,
      payload: { from: 'RECEIVED', to: 'CORRELATED', runtimeExecutionRef },
    })
    return updated
  })
}

export interface TerminalEvidenceInput {
  evidenceJson: string
  terminalAt?: string
  /** 若提供，同事务内把 Execution 推到该终态（须合法；结束后自动补 ended_at）。 */
  executionTerminalState?: 'COMPLETED' | 'FAILED' | 'ABORTED'
  /** 若提供，同事务内推进 Lease 到 SETTLING（须处于 EXECUTING）。 */
  settleLease?: boolean
}

/** 记录 Terminal Evidence（TX-4）：CORRELATED → TERMINAL（terminal_evidence_json + terminal_at）。 */
export function recordTerminalEvidence(store: KingdomStore, dispatchId: string, input: TerminalEvidenceInput): {
  dispatch: DispatchRecordRow
  execution?: ExecutionRow
  lease?: LeaseRow
} {
  requireV4(store)
  const dispatch = store.getDispatch(dispatchId)
  if (!dispatch) throw new GovernedApiError(`recordTerminalEvidence: dispatch ${dispatchId} 不存在`)
  if (dispatch.state === 'TERMINAL') return { dispatch }
  if (dispatch.state !== 'CORRELATED') {
    throw new GovernedApiError(`recordTerminalEvidence: dispatch ${dispatchId} 状态 ${dispatch.state} ≠ CORRELATED`)
  }
  const execution = store.getExecution(dispatch.execution_id)
  const lease = store.getLease(dispatch.lease_id)
  return store.withImmediateTransaction(() => {
    const at = input.terminalAt ?? now()
    const updatedDispatch = store.updateDispatchState(dispatchId, 'CORRELATED', 'TERMINAL', {
      terminalEvidenceJson: input.evidenceJson,
      terminalAt: at,
    }, at)
    let updatedExecution: ExecutionRow | undefined
    if (input.executionTerminalState && execution) {
      const to = asExecutionState(input.executionTerminalState)
      if (!isTerminalExecutionState(to)) {
        throw new GovernedApiError(`recordTerminalEvidence: executionTerminalState 必须是终态（收到 ${to}）`)
      }
      updatedExecution = store.transitionExecution(execution, to, { detail: `terminal evidence: ${dispatchId}` })
    }
    let updatedLease: LeaseRow | undefined
    if (input.settleLease && lease) {
      if (lease.state !== 'EXECUTING') {
        throw new GovernedApiError(`recordTerminalEvidence: settleLease 要求 lease ${lease.lease_id} 处于 EXECUTING（实际 ${lease.state}）`)
      }
      updatedLease = store.updateLeaseState(lease.lease_id, 'EXECUTING', 'SETTLING', {}, at)
    }
    emit(store, {
      kingdomId: dispatch.kingdom_id,
      eventType: 'DISPATCH_STATE_CHANGED',
      targetType: 'dispatch',
      targetId: dispatchId,
      payload: { from: 'CORRELATED', to: 'TERMINAL', executionTerminalState: input.executionTerminalState ?? undefined },
    })
    return { dispatch: updatedDispatch, execution: updatedExecution, lease: updatedLease }
  })
}

/** CAS 推进 Dispatch 状态（转移合法性由 dispatch_state_guard trigger 权威执行）。 */
export function advanceDispatchState(
  store: KingdomStore,
  dispatchId: string,
  to: string,
  extra: {
    runtimeDispatchRef?: string | null
    runtimeExecutionRef?: string | null
    receiptJson?: string | null
    terminalEvidenceJson?: string | null
    outputRefJson?: string | null
    dispatchedAt?: string | null
    receiptAt?: string | null
    terminalAt?: string | null
  } = {},
): DispatchRecordRow {
  requireV4(store)
  const dispatch = store.getDispatch(dispatchId)
  if (!dispatch) throw new GovernedApiError(`advanceDispatchState: dispatch ${dispatchId} 不存在`)
  if (dispatch.state === to) return dispatch
  return store.withImmediateTransaction(() => {
    const at = now()
    const updated = store.updateDispatchState(dispatchId, dispatch.state, to, extra, at)
    emit(store, {
      kingdomId: dispatch.kingdom_id,
      eventType: 'DISPATCH_STATE_CHANGED',
      targetType: 'dispatch',
      targetId: dispatchId,
      payload: { from: dispatch.state, to },
    })
    return updated
  })
}

// ── 6. Recovery（RECOVERING 入口；不改 Task 治理状态）────────────────────────

/** Lease 进 RECOVERING（RECOVERING 不改 Task 治理状态；仅重建证据）。 */
export function markLeaseRecovering(store: KingdomStore, leaseId: string): LeaseRow {
  const lease = store.getLease(leaseId)
  if (!lease) throw new GovernedApiError(`markLeaseRecovering: lease ${leaseId} 不存在`)
  if (lease.state === 'RECOVERING') return lease
  return advanceLeaseState(store, leaseId, 'RECOVERING')
}

/** Dispatch 进 RECOVERING（Intent 已存在但证据链断裂；禁盲目重发）。 */
export function markDispatchRecovering(store: KingdomStore, dispatchId: string): DispatchRecordRow {
  return advanceDispatchState(store, dispatchId, 'RECOVERING')
}

/** Execution 进 RECOVERING（v6 executions 状态；不改 Task 治理状态）。 */
export function markExecutionRecovering(store: KingdomStore, executionId: string): ExecutionRow {
  requireV4(store)
  const execution = store.getExecution(executionId)
  if (!execution) throw new GovernedApiError(`markExecutionRecovering: execution ${executionId} 不存在`)
  if (execution.state === 'RECOVERING') return execution
  return store.withImmediateTransaction(() => {
    const updated = store.transitionExecution(execution, 'RECOVERING', { detail: 'recovery: evidence reconstruction in progress' })
    emit(store, {
      kingdomId: store.getDefaultKingdom()?.kingdom_id ?? execution.task_id,
      eventType: 'EXECUTION_RECOVERING',
      targetType: 'execution',
      targetId: executionId,
      payload: { task: execution.task_id, attempt: execution.attempt_no },
    })
    return updated
  })
}
