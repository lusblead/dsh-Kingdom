/**
 * dsh-kingdom — v0.8 Capability Gate（M3-S4 服务层，TX-0D..TX-2S/2F 编排）。
 *
 * 依 M3-S4 Thin Spec §1 + v6 §4 TX 流程：
 * - TX-0D：ceiling/grant/交集为空 → DENIED Decision + zero execution；
 * - TX-1：写 Enforcement Plan（lease.enforcement_plan_snapshot）→ PREPARING → MATERIALIZING；
 * - TX-2S：preflight → materialize 成功 → GRANTED+ENFORCED + evidence → bind → DISPATCH_READY；
 * - TX-2F：materialize/preflight 失败 → DENIED（UNAVAILABLE/FAILED）→ cleanup → RELEASED（zero execution）。
 *
 * fail-closed：requirement_coverage 仅信息字段；部分/无覆盖不单独拒绝，
 * 但没有有效交集或 Runtime enforcement 失败仍绝不 dispatch；
 * materialize 失败绝不产生声称 GRANTED+ENFORCED 但实际没装 policy 的 Execution。
 */
import type { KingdomStore, CapabilityDecisionRow, LeaseRow } from '../core/db.js'
import {
  advanceLeaseState,
  bindCapabilityDecision,
  releaseExecutionLease,
  recordCapabilityDecision,
  setLeasePlan,
} from '../core/governed.js'
import type { EnforcementRequest, RuntimeAdapter } from '../adapter/contract.js'
import type { DshEnforcementContext } from './dsh-enforcement.js'
import { effectiveTools, resolveEffectiveCapability, type GrantMap, type Resolution } from './resolver.js'

export interface CapabilityGateInput {
  store: KingdomStore
  adapter: RuntimeAdapter
  kingdomId: string
  taskId: string
  attemptNo: number
  workerBindingId: string
  supervisorBindingId: string | null
  /** TX-A 已 acquire 的 Lease。 */
  leaseId: string
  /** tasks.capability_requirement_json（非权威自述；null/非法 → 空 requirement）。 */
  requirementJson: string | null
  /** kingdoms.capability_ceiling_json（null → B-7 拒）。 */
  ceilingJson: string | null
  /** Supervisor Grant（本 Attempt 权威授权）。 */
  grant: GrantMap
  sandboxMode: 'read-only' | 'workspace-write'
  presetId?: string
  /** live session 的 enforcement context。 */
  context: DshEnforcementContext
}

export interface CapabilityGateResult {
  decision: CapabilityDecisionRow
  lease: LeaseRow
  materialized: boolean
  /**
   * 成功 Gate 交给后续 dispatch/settlement 的同一份 materialized request。
   * 失败时为 null；禁止消费者自行重算 teardown target。
   */
  enforcementRequest: EnforcementRequest | null
}

type RequestedSandboxMode = CapabilityGateInput['sandboxMode']

interface SandboxModeSelection {
  requested: RequestedSandboxMode
  effective: RequestedSandboxMode
  boundedNarrowing: boolean
}

function parseJson(json: string | null): Record<string, boolean> | null {
  if (!json) return null
  try {
    const value = JSON.parse(json) as unknown
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, boolean>
    return null
  } catch {
    return null
  }
}

/**
 * requested mode 只能被 Effective Capability 收窄，不能反向扩大授权：
 * - 只有 effective 含 filesystem.write 时，workspace-write 才可 materialize；
 * - 没有 write 时，非 write-required Task 只能以 read-only 继续；
 * - write-required Task 在交集缺失时由调用方 fail-closed。
 */
function selectSandboxMode(requested: RequestedSandboxMode, resolution: Resolution): SandboxModeSelection {
  const effective = requested === 'workspace-write' && resolution.effective['filesystem.write'] === true
    ? 'workspace-write'
    : 'read-only'
  return {
    requested,
    effective,
    boundedNarrowing: requested !== effective,
  }
}

/**
 * A read-only request is also an upper bound on the materialized effective set.
 * The resolver may observe an extra write grant/ceiling/runtime capability, but
 * that capability is not materialized when the caller requested read-only.
 */
function boundResolutionToRequestedSandbox(requested: RequestedSandboxMode, resolution: Resolution): Resolution {
  if (requested !== 'read-only' || resolution.effective['filesystem.write'] !== true) return resolution
  const effective = { ...resolution.effective }
  delete effective['filesystem.write']
  return { ...resolution, effective }
}

/** 为 typed Runtime evidence 增加本次 requested/effective mode 及收窄事实。 */
function annotateSandboxEvidence(evidenceJson: string, mode: SandboxModeSelection): string {
  const parsed = JSON.parse(evidenceJson) as { payload?: Record<string, unknown> }
  return JSON.stringify({
    ...parsed,
    payload: {
      ...(parsed.payload ?? {}),
      requestedSandboxMode: mode.requested,
      effectiveSandboxMode: mode.effective,
      boundedNarrowing: mode.boundedNarrowing,
    },
  })
}

/** 从 effective 集 + 已收窄 mode 构建 EnforcementRequest。 */
function buildRequest(resolution: Resolution, sandboxMode: RequestedSandboxMode, territoryPath: string, presetId?: string): EnforcementRequest {
  return {
    tools: effectiveTools(resolution.effective),
    territoryPath,
    sandboxMode,
    approvalPolicy: 'never',
    ...(presetId ? { presetId } : {}),
  }
}

/** cleanup 必须同时有成功标记和 teardown evidence；缺任一项都属于未知。 */
async function cleanupConfirmed(
  adapter: RuntimeAdapter,
  request: EnforcementRequest,
  context: DshEnforcementContext,
): Promise<boolean> {
  try {
    const result = await adapter.cleanup(request, context)
    return result.ok && typeof result.evidenceJson === 'string' && result.evidenceJson.length > 0
  } catch {
    return false
  }
}

/** 释放 lease 的 zero-execution 收尾（合法源：RECOVERING/MATERIALIZING/RELEASING）。 */
function zeroExecutionRelease(store: KingdomStore, leaseId: string, reason: string): LeaseRow {
  const lease = store.getLease(leaseId)
  if (!lease) throw new Error(`zeroExecutionRelease: lease ${leaseId} 不存在`)
  if (lease.state === 'MATERIALIZING' || lease.state === 'RELEASING' || lease.state === 'RECOVERING') {
    return releaseExecutionLease(store, leaseId, { phase: 'capability-gate', reason }, reason)
  }
  // ACQUIRED/PREPARING 等只能先进 RECOVERING 再带证据释放
  const recovering = advanceLeaseState(store, leaseId, 'RECOVERING')
  void recovering
  return releaseExecutionLease(store, leaseId, { phase: 'capability-gate', reason }, reason)
}

/** cleanup 不可确认时保留 Lease，避免把未知 Runtime policy 状态伪装成 RELEASED。 */
function keepLeaseInRecovery(store: KingdomStore, leaseId: string, reason: string): LeaseRow {
  const lease = store.getLease(leaseId)
  if (!lease) throw new Error(`keepLeaseInRecovery: lease ${leaseId} 不存在`)
  // RECOVERING 仍未释放；把原因持久化，返回值必须反映实际 Ledger 行。
  advanceLeaseState(store, leaseId, 'RECOVERING', { releaseReason: reason })
  const recovering = store.getLease(leaseId)
  if (!recovering) throw new Error(`keepLeaseInRecovery: lease ${leaseId} vanished`)
  return recovering
}

/**
 * 完整能力闸门（TX-0D..TX-2S/2F）：
 * - 返回 materialized=false + DENIED Decision = zero execution（无 Execution / Dispatch）；
 * - 返回 materialized=true + GRANTED+ENFORCED Decision，Lease 停在 DISPATCH_READY（等 TX-3）。
 */
export async function runCapabilityGate(input: CapabilityGateInput): Promise<CapabilityGateResult> {
  const { store, adapter, kingdomId, taskId, attemptNo, workerBindingId, supervisorBindingId, leaseId } = input
  const requirement = parseJson(input.requirementJson) ?? {}
  const ceiling = parseJson(input.ceilingJson)
  const deny = (
    resolution: Resolution,
    enforcementStatus: 'NOT_ATTEMPTED' | 'UNAVAILABLE' | 'FAILED',
    reasonCode: string | null,
    cleanupConfirmed = true,
  ): CapabilityGateResult => {
    const decision = recordCapabilityDecision(store, {
      kingdomId, taskId, workerBindingId, supervisorBindingId,
      requirementSnapshot: input.requirementJson ?? undefined,
      ceilingSnapshot: input.ceilingJson ?? undefined,
      proposedGrantSnapshot: JSON.stringify(input.grant),
      effectiveSnapshot: JSON.stringify(resolution.effective),
      decision: 'DENIED',
      enforcementStatus,
      requirementCoverage: resolution.coverage,
      reasonCode: reasonCode ?? resolution.deniedReasons[0] ?? null,
    })
    const closeReason = `capability-denied:${enforcementStatus}`
    const lease = cleanupConfirmed
      ? zeroExecutionRelease(store, leaseId, closeReason)
      : keepLeaseInRecovery(store, leaseId, closeReason)
    return { decision, lease, materialized: false, enforcementRequest: null }
  }

  const emptyEnforceable = { tools: [], sandboxMode: null, approvalPolicy: null, presetId: null } as const

  // TX-0D：ceiling 缺失 → 拒（B-7），且不触碰 Runtime。
  if (ceiling === null) {
    const resolution = resolveEffectiveCapability({ requirement, grant: input.grant, ceiling, enforceable: emptyEnforceable })
    return deny(resolution, 'NOT_ATTEMPTED', 'CEILING_NOT_CONFIGURED')
  }

  // Supervisor Grant 是权威输入；没有任何 true Grant 时 fail-closed，
  // 不能因 requirement 为空而把无授权执行误当作 coverage=NONE 的允许。
  if (!Object.values(input.grant).some(value => value === true)) {
    const resolution = resolveEffectiveCapability({ requirement, grant: input.grant, ceiling, enforceable: emptyEnforceable })
    return deny(resolution, 'NOT_ATTEMPTED', 'GRANT_NOT_CONFIGURED')
  }

  let enforceable: Awaited<ReturnType<RuntimeAdapter['capabilities']>>
  try {
    enforceable = await adapter.capabilities(input.context)
  } catch (error: unknown) {
    const resolution = resolveEffectiveCapability({ requirement, grant: input.grant, ceiling, enforceable: emptyEnforceable })
    const detail = error instanceof Error ? error.message : String(error)
    return deny(resolution, 'UNAVAILABLE', `ENFORCEABLE_SET_FAILED:${detail}`)
  }
  const resolution = resolveEffectiveCapability({ requirement, grant: input.grant, ceiling, enforceable })

  const writeRequired = requirement['filesystem.write'] === true
  const writeEffective = resolution.effective['filesystem.write'] === true
  if (writeRequired && !writeEffective) {
    const writeUnavailable = resolution.deniedReasons.some(reason =>
      reason.startsWith('filesystem.write: Runtime 无法证明 enforce'))
    return deny(
      resolution,
      writeUnavailable ? 'UNAVAILABLE' : 'NOT_ATTEMPTED',
      'REQUIRED_WRITE_NOT_EFFECTIVE',
    )
  }
  if (writeRequired && input.sandboxMode === 'read-only') {
    return deny(resolution, 'NOT_ATTEMPTED', 'REQUIRED_WRITE_NOT_REQUESTED')
  }

  // coverage 是信息字段；只有 Grant∩Ceiling∩EnforceableSet 为空才阻断。
  if (Object.keys(resolution.effective).length === 0) {
    const runtimeUnavailable = resolution.deniedReasons.some(reason => reason.includes('Runtime 无法证明 enforce'))
    return deny(
      resolution,
      runtimeUnavailable ? 'UNAVAILABLE' : 'NOT_ATTEMPTED',
      resolution.deniedReasons[0] ?? 'NO_EFFECTIVE_CAPABILITY',
    )
  }

  // The requested mode also constrains what can be recorded as the effective
  // snapshot. Without this second bound, an extra filesystem.write grant could
  // remain in the decision while materialization is read-only.
  const materializationResolution = boundResolutionToRequestedSandbox(input.sandboxMode, resolution)
  if (Object.keys(materializationResolution.effective).length === 0) {
    const runtimeUnavailable = materializationResolution.deniedReasons.some(reason => reason.includes('Runtime 无法证明 enforce'))
    return deny(
      materializationResolution,
      runtimeUnavailable ? 'UNAVAILABLE' : 'NOT_ATTEMPTED',
      materializationResolution.deniedReasons[0] ?? 'NO_EFFECTIVE_CAPABILITY',
    )
  }
  const boundedSandbox = selectSandboxMode(input.sandboxMode, materializationResolution)

  // TX-1：写 plan → PREPARING → MATERIALIZING
  const plan = {
    type: 'DshEnforcementPlan/v1',
    payload: {
      tools: effectiveTools(materializationResolution.effective),
      sandboxMode: boundedSandbox.effective,
      requestedSandboxMode: boundedSandbox.requested,
      effectiveSandboxMode: boundedSandbox.effective,
      boundedNarrowing: boundedSandbox.boundedNarrowing,
      approvalPolicy: 'never',
      presetId: input.presetId ?? null,
      coverage: materializationResolution.coverage,
      effective: materializationResolution.effective,
    },
  }
  setLeasePlan(store, leaseId, JSON.stringify(plan))
  advanceLeaseState(store, leaseId, 'PREPARING')
  advanceLeaseState(store, leaseId, 'MATERIALIZING')

  const territoryPath = (input.context.agent.session as unknown as { header?: { cwd?: string } }).header?.cwd ?? ''
  const request = buildRequest(materializationResolution, boundedSandbox.effective, territoryPath, input.presetId)

  // TX-2 前置：preflight（无副作用）
  let preflight: Awaited<ReturnType<RuntimeAdapter['preflight']>>
  try {
    preflight = await adapter.preflight(request, input.context)
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    const cleanupOk = await cleanupConfirmed(adapter, request, input.context)
    return deny(materializationResolution, 'UNAVAILABLE', `PREFLIGHT_FAILED:${detail}`, cleanupOk)
  }
  if (!preflight.ok) {
    const cleanupOk = await cleanupConfirmed(adapter, request, input.context)
    return deny(materializationResolution, 'UNAVAILABLE', `PREFLIGHT_FAILED:${preflight.reasons.join(';')}`, cleanupOk)
  }

  // TX-2S/2F：materialize
  let materialized: Awaited<ReturnType<RuntimeAdapter['materialize']>>
  try {
    materialized = await adapter.materialize(request, input.context)
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    const cleanupOk = await cleanupConfirmed(adapter, request, input.context)
    return deny(materializationResolution, 'FAILED', `MATERIALIZE_FAILED:${detail}`, cleanupOk)
  }
  if (!materialized.ok || !materialized.evidenceJson) {
    const cleanupOk = await cleanupConfirmed(adapter, request, input.context)
    return deny(
      materializationResolution,
      'FAILED',
      `MATERIALIZE_FAILED:${(materialized.reasons ?? []).join(';') || 'no-reason'}`,
      cleanupOk,
    )
  }

  let enforcementEvidenceJson: string
  try {
    enforcementEvidenceJson = annotateSandboxEvidence(materialized.evidenceJson, boundedSandbox)
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    const cleanupOk = await cleanupConfirmed(adapter, request, input.context)
    return deny(materializationResolution, 'FAILED', `MATERIALIZE_EVIDENCE_INVALID:${detail}`, cleanupOk)
  }

  const decision = recordCapabilityDecision(store, {
    kingdomId, taskId, workerBindingId, supervisorBindingId,
    requirementSnapshot: input.requirementJson ?? undefined,
    ceilingSnapshot: input.ceilingJson ?? undefined,
    proposedGrantSnapshot: JSON.stringify(input.grant),
    effectiveSnapshot: JSON.stringify(materializationResolution.effective),
    decision: 'GRANTED',
    enforcementStatus: 'ENFORCED',
    enforcementEvidenceJson,
    requirementCoverage: materializationResolution.coverage,
    reasonCode: boundedSandbox.boundedNarrowing ? 'BOUNDED_SANDBOX_NARROWING' : null,
  })
  bindCapabilityDecision(store, leaseId, decision.decision_id)
  const lease = advanceLeaseState(store, leaseId, 'DISPATCH_READY')
  // 返回 buildRequest 生成且已通过本次 preflight/materialize 的同一对象；
  // 后续 teardown 必须消费它，不得依据 capability snapshot 重新推导。
  return { decision, lease, materialized: true, enforcementRequest: request }
}
