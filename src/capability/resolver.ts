/**
 * dsh-kingdom — v0.8 Capability Resolver（M3-S4，纯函数，零 dsh 依赖）。
 *
 * 依 M3-S1 Stage 3 裁决 + M3-S4 Thin Spec §1：
 *   Effective Capability = Supervisor Grant ∩ Owner Ceiling ∩ Runtime Enforceable Set
 *
 * 语义（fail-closed）：
 * - Capability 命名约定（v0.8）：
 *   `tool:<name>` 工具面；`filesystem.write` 领地内写；`filesystem.read` 领地内读；
 *   `shell.exec` 受沙箱 shell；`approval.never` 禁扩权。未知能力 → 不可 enforce（拒绝）。
 * - Owner Ceiling 是**允许清单**（交集语义）：ceiling[cap]===true 才算在交集内；
 *   ceiling===null（未配置）→ 全部拒绝（v6 B-4/B-7：NULL ceiling 王国不得进入 GOVERNED_PERSISTENT）。
 * - requirement_coverage 是**信息字段**：FULL/PARTIAL/NONE 不自动决定授权（Stage 3 冻结）。
 */
import type { RuntimeEnforceableSet } from '../adapter/contract.js'

/** Supervisor Grant（本 Attempt 权威授权；capability 名 → 允许）。 */
export type GrantMap = Record<string, boolean>

/** Owner Ceiling（王国上限允许清单；null = 未配置）。 */
export type CeilingMap = Record<string, boolean> | null

/** Task Capability Requirement（非权威自我描述）。 */
export type RequirementMap = Record<string, boolean>

export interface CapabilityInputs {
  requirement: RequirementMap
  grant: GrantMap
  ceiling: CeilingMap
  enforceable: RuntimeEnforceableSet
}

export interface Resolution {
  /** effective 能力集（交集结果）。 */
  effective: Record<string, boolean>
  /** 信息字段：FULL/PARTIAL/NONE（不得据此自动授权）。 */
  coverage: 'FULL' | 'PARTIAL' | 'NONE'
  /** 每个未生效能力的原因（not-granted / over-ceiling / not-enforceable / ceiling-missing）。 */
  deniedReasons: string[]
}

/** 某能力是否可被 Runtime 实际 enforce（context-bound；未知能力 → false，fail-closed）。 */
export function isEnforceable(capability: string, enforceable: RuntimeEnforceableSet): boolean {
  if (capability.startsWith('tool:')) {
    return enforceable.tools.includes(capability.slice('tool:'.length))
  }
  switch (capability) {
    case 'filesystem.write':
      return enforceable.sandboxMode === 'workspace-write'
    case 'filesystem.read':
      return enforceable.sandboxMode === 'read-only' || enforceable.sandboxMode === 'workspace-write'
    case 'shell.exec':
      return enforceable.sandboxMode !== null
    case 'approval.never':
      return enforceable.approvalPolicy === 'never'
    default:
      return false
  }
}

export function resolveEffectiveCapability(input: CapabilityInputs): Resolution {
  const { requirement, grant, ceiling, enforceable } = input
  const effective: Record<string, boolean> = {}
  const deniedReasons: string[] = []

  if (ceiling === null) {
    // B-4/B-7：NULL ceiling 的王国不得进入 GOVERNED_PERSISTENT（交集为空，全部拒绝）
    for (const cap of Object.keys(requirement)) {
      deniedReasons.push(`${cap}: kingdom 未配置 capability ceiling（B-7：NULL ceiling 不得进入 GOVERNED_PERSISTENT）`)
    }
    return { effective, coverage: 'NONE', deniedReasons }
  }

  const required = Object.keys(requirement).filter(cap => requirement[cap] === true)
  for (const cap of required) {
    const granted = grant[cap] === true
    const ceilingOk = ceiling[cap] === true
    const enforceableNow = isEnforceable(cap, enforceable)
    if (!granted) {
      deniedReasons.push(`${cap}: Supervisor grant 未包含`)
      continue
    }
    if (!ceilingOk) {
      deniedReasons.push(`${cap}: 超出 Owner ceiling 允许清单`)
      continue
    }
    if (!enforceableNow) {
      deniedReasons.push(`${cap}: Runtime 无法证明 enforce（sandbox=${enforceable.sandboxMode ?? 'none'}, approval=${enforceable.approvalPolicy ?? 'none'}, tools=${enforceable.tools.length})`)
      continue
    }
    effective[cap] = true
  }

  let coverage: Resolution['coverage']
  if (required.length === 0) coverage = 'NONE'
  else if (Object.keys(effective).length === required.length) coverage = 'FULL'
  else if (Object.keys(effective).length > 0) coverage = 'PARTIAL'
  else coverage = 'NONE'

  return { effective, coverage, deniedReasons }
}

/** 从 effective 集构建 EnforcementPlan 的 tool 面（tool:<name> → name）。 */
export function effectiveTools(effective: Record<string, boolean>): string[] {
  return Object.keys(effective)
    .filter(cap => cap.startsWith('tool:') && effective[cap] === true)
    .map(cap => cap.slice('tool:'.length))
}
