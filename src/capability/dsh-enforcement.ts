/**
 * dsh-kingdom — v0.8 DSH Capability Enforcement（M3-S4，materialize/cleanup）。
 *
 * 依 M3-S4 Thin Spec §3（seam 均 @ 00b7102f1d 源码核实）：
 * - 一键 preset 路径：`permissionPresets.set(session, name)`（sandbox+approval+permission/preset 事件）；
 * - 逐 knob：`setSandboxMode(session, mode)`（sandbox-policy/session-mode.ts:69）+
 *   `setApprovalPolicy(session, 'never')`（user-approval/src/index.ts:142）；
 * - 工具面：`agent.ctx.tools.restrict({allow})`（tools/src/index.ts:1071）+
 *   `agent.ctx.tools.guard(...)`（:1110，单调拒绝、body 不执行，C-009）；
 *   只有同时存在这两个 context-bound seam 时，schemas inventory 才能进入
 *   RuntimeEnforceableSet；schemas 本身只是声明面，不是 enforcement 证据；
 * - fail-before-dispatch：任一步失败 → cleanup + DENIED，zero execution；
 * - evidence 诚实：typed envelope 只记录真实应用的事实与事件证据，不夸大（G5/G9）。
 */
import type {
  CleanupResult,
  EnforcementRequest,
  MaterializeResult,
  RuntimeEnforceableSet,
} from '../adapter/contract.js'

/** DSH 政策注入面（结构型）。 */
export interface DshPolicyDeps {
  /** ctx.get('permission')——permissionPresets.set(session, name)。 */
  permission?: { set(session: unknown, name: string): void }
  /** @deepseek-ai/dsh-sandbox-policy 的 setSandboxMode。 */
  sandboxPolicy?: { setSandboxMode(session: unknown, mode: string): void }
  /** @deepseek-ai/dsh-user-approval 的 setApprovalPolicy。 */
  approval?: { setApprovalPolicy(session: unknown, policy: string): void }
}

/** 结构面：live agent 的作用域工具 API（guard/restrict 返回 disposer；schemas 为真实 Runtime inventory）。 */
export interface DshAgentScopeLike {
  tools?: {
    guard?(guard: (exec: { name: string }) => string | undefined): () => void
    restrict?(filter: { allow?: string[]; deny?: string[] }): () => void
    /** 真实 `tools.schemas()`：返回 `[{name, description, parameters}, …]`（实证 @ 00b7102f1d）。 */
    schemas?(): unknown
  }
}

/** readEnforceableSet 的 preset/mountable 注入面（S4 seam 修复用）。 */
export interface EnforceableSetDeps {
  presets?: { resolveMountable?(id: string): unknown }
}

export interface DshEnforcementContext {
  sessionRef: string
  /** live agent（agent.ctx.tools 用于 per-execution guard/restrict）。 */
  agent: {
    ctx: DshAgentScopeLike
    session: { events: readonly { type: string; data?: Record<string, unknown> }[] }
  }
  /**
   * 真实 **agent preset** id（createSession 时装配的 preset：standard/code/minimal/…）。
   * 与 permission/preset 事件值（PermissionPresetService 的预设名，如 workspace-write）**严格分离**——
   * 只有本字段可传给 agentPresets.resolveMountable；缺省 → B 面回退 session 装配面（fail-closed）。
   */
  agentPresetId?: string
}

/**
 * 真实工具面 shape 归一化（Owner S4 seam 裁决 · A/B 组合）。
 * 接受：字符串数组 / `[{name, description, parameters}, …]`（真实 `tools.schemas()` 实证 shape）/
 *       对象含 `tools`/`toolSurface`/`name` 字段（preset/mountable 声明 shape）。
 * 解析失败 → 空数组（fail-closed，不默认放行）。
 */
export function normalizeToolInventory(value: unknown): string[] {
  const names = new Set<string>()
  const walk = (node: unknown, isElement: boolean, depth: number): void => {
    if (depth > 3) return
    if (typeof node === 'string') {
      if (node.length > 0) names.add(node)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, true, depth + 1)
      return
    }
    if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>
      // 仅数组元素提取 name（schemas() 的 [{name,description,parameters}] 形态）；
      // 顶层/嵌套对象自身的 name（如 preset 元信息 {id,name,description}）**不**作为工具名。
      if (isElement && typeof record.name === 'string') {
        names.add(record.name)
        return
      }
      // 常见声明容器字段（tools 数组 / toolSurface·toolNames 映射）
      for (const key of ['tools', 'toolSurface', 'toolNames', 'allow']) {
        if (record[key] !== undefined) {
          const value = record[key]
          if (Array.isArray(value)) {
            for (const item of value) walk(item, true, depth + 1)
          } else if (value && typeof value === 'object') {
            // 工具名映射形态：{ toolName: definition }
            for (const name of Object.keys(value)) names.add(name)
          } else {
            walk(value, false, depth + 1)
          }
          return
        }
      }
    }
  }
  walk(value, false, 0)
  return [...names]
}

/** preset/mountable 面解析：resolveMountable 返回值 → 工具名集（无法解析 → 空）。 */
function presetSurfaceOf(value: unknown): string[] {
  if (value === undefined || value === null) return []
  return normalizeToolInventory(value)
}

export const ENFORCEMENT_EVIDENCE_TYPE = 'DshEnforcementEvidence/v1'
export const TEARDOWN_EVIDENCE_TYPE = 'DshEnforcementTeardownEvidence/v1'

/** per-session disposer 注册表（materialize 注册、cleanup 消费；避免把 disposer 塞进 Core 类型）。 */
const disposerRegistry = new WeakMap<object, (() => void)[]>()

function sessionKey(context: DshEnforcementContext): object {
  return context.agent.session as unknown as object
}

type ToolEnforcementSeam = NonNullable<DshAgentScopeLike['tools']> & Required<Pick<NonNullable<DshAgentScopeLike['tools']>, 'restrict' | 'guard'>>

function hasToolEnforcementSeam(tools: DshAgentScopeLike['tools'] | undefined): tools is ToolEnforcementSeam {
  return typeof tools?.restrict === 'function' && typeof tools?.guard === 'function'
}

interface DisposerFailure {
  index: number
  detail: string
}

interface DisposerSummary {
  disposed: number
  failures: DisposerFailure[]
}

/**
 * 尝试拆除全部 disposer；失败项继续留在 registry，便于 recovery 重试。
 * disposer 抛错只能证明 teardown UNKNOWN，不能被转换为 ok:true。
 */
function disposeDisposers(context: DshEnforcementContext, disposers: readonly (() => void)[]): DisposerSummary {
  let disposed = 0
  const failures: DisposerFailure[] = []
  const remaining: (() => void)[] = []
  disposers.forEach((dispose, index) => {
    try {
      dispose()
      disposed++
    } catch (error: unknown) {
      failures.push({
        index,
        detail: error instanceof Error ? error.message : String(error),
      })
      remaining.push(dispose)
    }
  })
  if (remaining.length > 0) disposerRegistry.set(sessionKey(context), remaining)
  else disposerRegistry.delete(sessionKey(context))
  return { disposed, failures }
}

type SessionEvent = DshEnforcementContext['agent']['session']['events'][number]

/** 只接受本次 setter 调用后追加、且字段值精确匹配的政策事件。 */
function hasAppendedPolicyEvent(
  context: DshEnforcementContext,
  startIndex: number,
  type: string,
  field: string,
  expected: string,
): boolean {
  const events = context.agent.session.events
  return events.slice(startIndex).some((event: SessionEvent) => event.type === type && event.data?.[field] === expected)
}

/**
 * 从真实 DSH API 重建 context-bound RuntimeEnforceableSet（Owner S4 seam 裁决：A∩B）。
 *
 * - A = **Runtime Tool Inventory**：`tools.schemas()`（实证返回 `[{name,description,parameters}]`），但只有当前 context 同时有 `restrict` 与 `guard` 才能证明 A 可 enforce；
 * - B = **Actual Agent Preset / Session Tool Surface**：仅用 `context.agentPresetId`（真实 agent preset：
 *   standard/code/minimal/…）调 `presets.resolveMountable(agentPresetId)`（await + catch，**禁止未处理
 *   rejection 泄漏**——BLOCKER #2 根因）；`permission/preset` 事件值是 PermissionPresetService 的预设名
 *   （workspace-write 等），**绝不**传给 agentPresets（概念严格分离）。preset 无法解析 → 回退 session 装配面；
 * - **Runtime Enforceable Tool Set = A ∩ B**；任一来源无法证明 → 空（fail-closed，不默认放行）。
 */
export async function readEnforceableSet(context: DshEnforcementContext, deps?: EnforceableSetDeps): Promise<RuntimeEnforceableSet> {
  const events = context.agent.session.events
  const sandboxEvents = events.filter(e => e.type === 'sandbox/mode')
  const approvalEvents = events.filter(e => e.type === 'approval/policy')
  const presetEvents = events.filter(e => e.type === 'permission/preset')
  const lastSandboxRaw = sandboxEvents.length > 0 ? sandboxEvents[sandboxEvents.length - 1]?.data?.mode : undefined
  const lastApprovalRaw = approvalEvents.length > 0 ? approvalEvents[approvalEvents.length - 1]?.data?.policy : undefined
  const lastPresetRaw = presetEvents.length > 0 ? presetEvents[presetEvents.length - 1]?.data?.preset : undefined
  const lastSandbox: RuntimeEnforceableSet['sandboxMode'] = lastSandboxRaw === 'read-only' || lastSandboxRaw === 'workspace-write' || lastSandboxRaw === 'danger-full-access' ? lastSandboxRaw : null
  const lastApproval: RuntimeEnforceableSet['approvalPolicy'] = lastApprovalRaw === 'never' || lastApprovalRaw === 'ask' ? lastApprovalRaw : null
  // permission/preset 事件值 = PermissionPresetService 预设名（materialize 的 permission.set 用）；非 agentPresetId
  const lastPermissionPreset: string | null = typeof lastPresetRaw === 'string' ? lastPresetRaw : null

  // A：Runtime Tool Inventory（真实 schemas API；解析失败 → 空 → fail-closed）。
  // schemas 只有声明能力；没有当前 Session 的 restrict/guard seam 时，不能进入
  // RuntimeEnforceableSet，即使 schemas 本身列出了 pwsh。
  const inventory = hasToolEnforcementSeam(context.agent.ctx.tools)
    ? normalizeToolInventory(context.agent.ctx.tools?.schemas?.())
    : []

  // B：Actual Agent Preset / Session Tool Surface
  //    仅用 context.agentPresetId（真实 agent preset）；await + try/catch 消费一切 rejection（BLOCKER #2 修复）
  let surface: string[] = []
  const agentPresetId = context.agentPresetId
  if (agentPresetId && deps?.presets?.resolveMountable) {
    try {
      const resolved = await deps.presets.resolveMountable(agentPresetId)
      surface = presetSurfaceOf(resolved)
    } catch {
      // resolveMountable rejection/throw → 已消费，不泄漏；B 面视为无法证明 → 回退（fail-closed）
      surface = []
    }
  }
  if (surface.length === 0) {
    // preset 声明面无法证明（无 agentPresetId / 解析失败 / 空面）→ 回退当前 session 装配面（live schemas 实证）
    surface = inventory
  }

  // Enforceable = A ∩ B
  const tools = hasToolEnforcementSeam(context.agent.ctx.tools)
    ? inventory.filter(name => surface.includes(name))
    : []

  return {
    tools,
    sandboxMode: lastSandbox ?? null,
    approvalPolicy: lastApproval ?? null,
    presetId: lastPermissionPreset ?? null,
  }
}

/**
 * materialize：把 EnforcementRequest 应用到一个 **live** session。
 * 失败即返回 {ok:false, reasons}（调用方负责 DENIED + zero execution）。
 */
export async function materializeDshEnforcement(
  deps: DshPolicyDeps,
  context: DshEnforcementContext,
  request: EnforcementRequest,
): Promise<MaterializeResult> {
  const reasons: string[] = []
  const disposers: (() => void)[] = []
  const applied: string[] = []

  const toolsApi = context.agent.ctx.tools
  const policyEventStart = context.agent.session.events.length

  // 1) 工具面：restrict（允许清单）+ guard（单调拒绝，body 不执行）
  if (!hasToolEnforcementSeam(toolsApi)) {
    reasons.push('agent.ctx.tools 无 restrict/guard（工具面无法 enforce）')
  } else {
    try {
      const d1 = toolsApi.restrict({ allow: [...request.tools] })
      disposers.push(d1)
      applied.push(`restrict:allow=[${request.tools.join(',')}]`)
      const d2 = toolsApi.guard((exec) => {
        // dsh ToolGuard 运行时契约：仅 `undefined` 放行；`null` 会被当作拒绝 reason（实测
        // `Error: null`——正式入口 E2E seam）。允许 → 必须返回 undefined。
        return request.tools.includes(exec.name) ? undefined : `capability not granted: ${exec.name}`
      })
      disposers.push(d2)
      applied.push('guard:monotonic-deny')
    } catch (error) {
      reasons.push(`工具面应用失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 2) 领地写边界 + 禁扩权：一键 preset 或逐 knob
  const presetPath = typeof request.presetId === 'string' && request.presetId.length > 0
  let permissionApplied = false
  if (presetPath) {
    if (!deps.permission) {
      reasons.push('permission preset 服务缺失（preset path 无法证明）')
    }
    try {
      if (deps.permission) {
        deps.permission.set(context.agent.session, request.presetId!)
        permissionApplied = true
      }
    } catch (error) {
      reasons.push(`permission preset 应用失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    if (!deps.sandboxPolicy) {
      reasons.push('sandboxPolicy 缺失（领地写边界无法 enforce）')
    } else {
      try {
        deps.sandboxPolicy.setSandboxMode(context.agent.session, request.sandboxMode)
      } catch (error) {
        reasons.push(`sandbox 应用失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!deps.approval) {
      reasons.push('approval 服务缺失（禁扩权无法 enforce）')
    } else {
      try {
        deps.approval.setApprovalPolicy(context.agent.session, request.approvalPolicy)
      } catch (error) {
        reasons.push(`approval 应用失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // 3) 证据核验：direct knob 必须看到本次 setter 追加的精确政策事件；
  //    preset path 还允许 PermissionPresetService.set 对已生效 preset 的合法幂等 no-op，
  //    但仍必须核对当前 sandbox/approval/preset 三项状态完全匹配。
  const sandboxEventApplied = hasAppendedPolicyEvent(context, policyEventStart, 'sandbox/mode', 'mode', request.sandboxMode)
  if (sandboxEventApplied && !presetPath) {
    applied.push(`sandbox:mode=${request.sandboxMode}`)
  } else if (!presetPath) {
    reasons.push(`sandbox/mode 事件缺失或未反映请求模式=${request.sandboxMode}（setter/effective state 无法证明）`)
  }

  const approvalEventApplied = hasAppendedPolicyEvent(context, policyEventStart, 'approval/policy', 'policy', request.approvalPolicy)
  if (approvalEventApplied && !presetPath) {
    applied.push(`approval:policy=${request.approvalPolicy}`)
  } else if (!presetPath) {
    reasons.push(`approval/policy 事件缺失或未反映请求策略=${request.approvalPolicy}（setter/effective state 无法证明）`)
  }

  if (permissionApplied) {
    const presetEventApplied = hasAppendedPolicyEvent(context, policyEventStart, 'permission/preset', 'preset', request.presetId!)
    if (presetEventApplied) applied.push(`permission:preset=${request.presetId}`)
    else if (!presetPath) reasons.push(`permission/preset 事件缺失或未反映请求 preset=${request.presetId}`)
  }

  let current: Pick<RuntimeEnforceableSet, 'sandboxMode' | 'approvalPolicy' | 'presetId'> = {
    sandboxMode: null,
    approvalPolicy: null,
    presetId: null,
  }
  try {
    const enforceable = await readEnforceableSet(context)
    current = {
      sandboxMode: enforceable.sandboxMode,
      approvalPolicy: enforceable.approvalPolicy,
      presetId: enforceable.presetId,
    }
  } catch (error) {
    reasons.push(`读取当前 Session effective state 失败: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (current.sandboxMode !== request.sandboxMode) {
    reasons.push(`sandbox effective state=${current.sandboxMode ?? 'none'} 与请求 ${request.sandboxMode} 不一致`)
  }
  if (current.approvalPolicy !== request.approvalPolicy) {
    reasons.push(`approval effective state=${current.approvalPolicy ?? 'none'} 与请求 ${request.approvalPolicy} 不一致`)
  }
  if (presetPath && current.presetId !== request.presetId) {
    reasons.push(`permission preset effective state=${current.presetId ?? 'none'} 与请求 ${request.presetId} 不一致`)
  }

  const evidenceEvents = [
    sandboxEventApplied ? 'sandbox/mode' : null,
    approvalEventApplied ? 'approval/policy' : null,
    permissionApplied && hasAppendedPolicyEvent(context, policyEventStart, 'permission/preset', 'preset', request.presetId!) ? 'permission/preset' : null,
  ].filter((type): type is string => type !== null)
  if (evidenceEvents.length > 0) applied.push(`events=[${evidenceEvents.join(',')}]`)
  if (presetPath && permissionApplied && !sandboxEventApplied && !approvalEventApplied && !hasAppendedPolicyEvent(context, policyEventStart, 'permission/preset', 'preset', request.presetId!)) {
    // Existing matching events + a successful preset setter call is the bounded
    // evidence for the valid idempotent path; do not invent new events.
    applied.push(`permission:preset=${request.presetId}:idempotent-existing-state`)
  }

  if (reasons.length > 0) {
    disposerRegistry.set(sessionKey(context), disposers)
    const cleanup = disposeDisposers(context, disposers)
    if (cleanup.failures.length > 0) {
      reasons.push(`cleanup 未确认: ${cleanup.failures.map(failure => `#${failure.index} ${failure.detail}`).join('; ')}`)
    }
    return { ok: false, evidenceJson: null, reasons }
  }

  disposerRegistry.set(sessionKey(context), disposers)
  const evidenceJson = JSON.stringify({
    type: ENFORCEMENT_EVIDENCE_TYPE,
    payload: {
      presetId: request.presetId ?? null,
      sandboxMode: request.sandboxMode,
      approvalPolicy: request.approvalPolicy,
      tools: request.tools,
      guards: disposers.length,
      sessionRef: context.sessionRef,
      applied,
      verifiedAt: new Date().toISOString(),
    },
  })
  return { ok: true, evidenceJson, reasons }
}

/** cleanup：拆除 per-execution guard/restrict（session 级政策保留，由下一 plan 重设）。 */
export async function cleanupDshEnforcement(context: DshEnforcementContext): Promise<CleanupResult> {
  const key = sessionKey(context)
  const disposers = disposerRegistry.get(key) ?? []
  const summary = disposeDisposers(context, disposers)
  return {
    ok: summary.failures.length === 0,
    evidenceJson: JSON.stringify({
      type: TEARDOWN_EVIDENCE_TYPE,
      payload: {
        disposed: summary.disposed,
        failed: summary.failures.length,
        failures: summary.failures,
        sessionRef: context.sessionRef,
        at: new Date().toISOString(),
      },
    }),
  }
}
