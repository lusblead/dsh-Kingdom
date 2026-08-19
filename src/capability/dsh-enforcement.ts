/**
 * dsh-kingdom — v0.8 DSH Capability Enforcement（M3-S4，materialize/cleanup）。
 *
 * 依 M3-S4 Thin Spec §3（seam 均 @ 00b7102f1d 源码核实）：
 * - 一键 preset 路径：`permissionPresets.set(session, name)`（sandbox+approval+permission/preset 事件）；
 * - 逐 knob：`setSandboxMode(session, mode)`（sandbox-policy/session-mode.ts:69）+
 *   `setApprovalPolicy(session, 'never')`（user-approval/src/index.ts:142）；
 * - 工具面：`agent.ctx.tools.restrict({allow})`（tools/src/index.ts:1071）+
 *   `agent.ctx.tools.guard(...)`（:1110，单调拒绝、body 不执行，C-009）；
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

/**
 * 从真实 DSH API 重建 context-bound RuntimeEnforceableSet（Owner S4 seam 裁决：A∩B）。
 *
 * - A = **Runtime Tool Inventory**：`tools.schemas()`（实证返回 `[{name,description,parameters}]`）；
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

  // A：Runtime Tool Inventory（真实 schemas API；解析失败 → 空 → fail-closed）
  const inventory = normalizeToolInventory(context.agent.ctx.tools?.schemas?.())

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
  const tools = inventory.filter(name => surface.includes(name))

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

  // 1) 工具面：restrict（允许清单）+ guard（单调拒绝，body 不执行）
  if (!toolsApi?.restrict || !toolsApi?.guard) {
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
  if (request.presetId && deps.permission) {
    try {
      deps.permission.set(context.agent.session, request.presetId)
      applied.push(`permission:preset=${request.presetId}`)
    } catch (error) {
      reasons.push(`permission preset 应用失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    if (!deps.sandboxPolicy) {
      reasons.push('sandboxPolicy 缺失（领地写边界无法 enforce）')
    } else {
      try {
        deps.sandboxPolicy.setSandboxMode(context.agent.session, request.sandboxMode)
        applied.push(`sandbox:mode=${request.sandboxMode}`)
      } catch (error) {
        reasons.push(`sandbox 应用失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!deps.approval) {
      reasons.push('approval 服务缺失（禁扩权无法 enforce）')
    } else {
      try {
        deps.approval.setApprovalPolicy(context.agent.session, request.approvalPolicy)
        applied.push(`approval:policy=${request.approvalPolicy}`)
      } catch (error) {
        reasons.push(`approval 应用失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // 3) 证据核验：策略事件必须落到持久 session 日志（typed evidence 的诚实基础）
  const types = new Set(context.agent.session.events.map(e => e.type))
  if (request.sandboxMode !== 'read-only' && !types.has('sandbox/mode')) {
    reasons.push('sandbox/mode 事件缺失（无法证明领地写边界已生效）')
  }
  if (!types.has('approval/policy')) {
    reasons.push('approval/policy 事件缺失（无法证明禁扩权已生效）')
  }
  const evidenceEvents = ['sandbox/mode', 'approval/policy', 'permission/preset'].filter(t => types.has(t))
  if (evidenceEvents.length > 0) applied.push(`events=[${evidenceEvents.join(',')}]`)

  if (reasons.length > 0) {
    for (const dispose of disposers) {
      try { dispose() } catch { /* 忽略 */ }
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
  disposerRegistry.delete(key)
  let disposed = 0
  for (const dispose of disposers) {
    try { dispose(); disposed++ } catch { /* 忽略单个失败 */ }
  }
  return {
    ok: true,
    evidenceJson: JSON.stringify({
      type: TEARDOWN_EVIDENCE_TYPE,
      payload: { disposed, sessionRef: context.sessionRef, at: new Date().toISOString() },
    }),
  }
}
