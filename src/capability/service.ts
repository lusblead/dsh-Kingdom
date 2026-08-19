/**
 * dsh-kingdom — v0.8 Capability Gate（M3-S4 服务层，TX-0D..TX-2S/2F 编排）。
 *
 * 依 M3-S4 Thin Spec §1 + v6 §4 TX 流程：
 * - TX-0D：resolution DENY（coverage ≠ FULL / ceiling 缺失）→ DENIED Decision + zero execution；
 * - TX-1：写 Enforcement Plan（lease.enforcement_plan_snapshot）→ PREPARING → MATERIALIZING；
 * - TX-2S：preflight → materialize 成功 → GRANTED+ENFORCED + evidence → bind → DISPATCH_READY；
 * - TX-2F：materialize/preflight 失败 → DENIED（UNAVAILABLE/FAILED）→ cleanup → RELEASED（zero execution）。
 *
 * fail-closed：coverage≠FULL 即拒（缺少任一必需能力不得「部分治理」蒙混）；
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

/** 从 effective 集 + 请求构建 EnforcementRequest。 */
function buildRequest(resolution: Resolution, sandboxMode: 'read-only' | 'workspace-write', territoryPath: string, presetId?: string): EnforcementRequest {
  return {
    tools: effectiveTools(resolution.effective),
    territoryPath,
    sandboxMode,
    approvalPolicy: 'never',
    ...(presetId ? { presetId } : {}),
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

/**
 * 完整能力闸门（TX-0D..TX-2S/2F）：
 * - 返回 materialized=false + DENIED Decision = zero execution（无 Execution / Dispatch）；
 * - 返回 materialized=true + GRANTED+ENFORCED Decision，Lease 停在 DISPATCH_READY（等 TX-3）。
 */
export async function runCapabilityGate(input: CapabilityGateInput): Promise<CapabilityGateResult> {
  const { store, adapter, kingdomId, taskId, attemptNo, workerBindingId, supervisorBindingId, leaseId } = input
  const requirement = parseJson(input.requirementJson) ?? {}
  const ceiling = parseJson(input.ceilingJson)
  const enforceable = await adapter.capabilities(input.context)
  const resolution = resolveEffectiveCapability({ requirement, grant: input.grant, ceiling, enforceable })

  const deny = (enforcementStatus: 'NOT_ATTEMPTED' | 'UNAVAILABLE' | 'FAILED', reasonCode: string | null): CapabilityGateResult => {
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
    const lease = zeroExecutionRelease(store, leaseId, `capability-denied:${enforcementStatus}`)
    return { decision, lease, materialized: false }
  }

  // TX-0D：ceiling 缺失 → 拒（B-7）
  if (ceiling === null) {
    return deny('UNAVAILABLE', 'CEILING_NOT_CONFIGURED')
  }
  // TX-0D：必需能力未全覆盖 → 拒（fail-closed，不部分治理）
  if (resolution.coverage !== 'FULL') {
    return deny('NOT_ATTEMPTED', resolution.deniedReasons[0] ?? 'REQUIREMENT_NOT_FULLY_EFFECTIVE')
  }

  // TX-1：写 plan → PREPARING → MATERIALIZING
  const plan = {
    type: 'DshEnforcementPlan/v1',
    payload: {
      tools: effectiveTools(resolution.effective),
      sandboxMode: input.sandboxMode,
      approvalPolicy: 'never',
      presetId: input.presetId ?? null,
      coverage: resolution.coverage,
      effective: resolution.effective,
    },
  }
  setLeasePlan(store, leaseId, JSON.stringify(plan))
  advanceLeaseState(store, leaseId, 'PREPARING')
  advanceLeaseState(store, leaseId, 'MATERIALIZING')

  const territoryPath = (input.context.agent.session as unknown as { header?: { cwd?: string } }).header?.cwd ?? ''
  const request = buildRequest(resolution, input.sandboxMode, territoryPath, input.presetId)

  // TX-2 前置：preflight（无副作用）
  const preflight = await adapter.preflight(request, input.context)
  if (!preflight.ok) {
    await adapter.cleanup(request, input.context)
    return deny('UNAVAILABLE', `PREFLIGHT_FAILED:${preflight.reasons.join(';')}`)
  }

  // TX-2S/2F：materialize
  const materialized = await adapter.materialize(request, input.context)
  if (!materialized.ok || !materialized.evidenceJson) {
    await adapter.cleanup(request, input.context)
    return deny('FAILED', `MATERIALIZE_FAILED:${(materialized.reasons ?? []).join(';') || 'no-reason'}`)
  }

  const decision = recordCapabilityDecision(store, {
    kingdomId, taskId, workerBindingId, supervisorBindingId,
    requirementSnapshot: input.requirementJson ?? undefined,
    ceilingSnapshot: input.ceilingJson ?? undefined,
    proposedGrantSnapshot: JSON.stringify(input.grant),
    effectiveSnapshot: JSON.stringify(resolution.effective),
    decision: 'GRANTED',
    enforcementStatus: 'ENFORCED',
    enforcementEvidenceJson: materialized.evidenceJson,
    requirementCoverage: resolution.coverage,
  })
  bindCapabilityDecision(store, leaseId, decision.decision_id)
  const lease = advanceLeaseState(store, leaseId, 'DISPATCH_READY')
  return { decision, lease, materialized: true }
}
