/**
 * dsh-kingdom — Role Binding 基础 CRUD（Phase 1）+ v0.4 换届/会话归属。
 *
 * Role、Runtime、Model、Session 解耦：
 *   Role → Binding → DSH Session → Model/Tools
 * Binding 可以更换 Session；Role 的组织身份不因模型或 Session 改变而改变。
 *
 * Phase 1：绑定角色↔session（role_type 枚举 + role_name + session_id 可选）、列出绑定。
 * 角色类型固定 OWNER/CHANCELLOR/SUPERVISOR/WORKER，不支持动态创建角色类型。
 *
 * v0.4 增量：
 * - 绑定可携带**会话身份预留字段**：model_name（模型名，如 deepseek-v4-pro）、
 *   agent_name（agent 工具名，如 codex/dsh）、session_meta（JSON 扩展槽，
 *   承载 provider/版本/runtime 等任意未来字段）——现在不必每次都填，但已留位。
 * - `unbindRole`：解绑（换届通道）；OWNER 受保护不可解绑。
 * - `rebindSession`：把角色绑定到（或改绑到）某个独立会话，并可顺带更新身份字段。
 *   配合 `authMode: 'session-bound'`，`requireRole` 会按调用方 session 校验。
 */
import { randomUUID } from 'node:crypto'
import { KingdomStore, RoleBindingRow } from './db.js'

export const ROLE_TYPES = ['OWNER', 'CHANCELLOR', 'SUPERVISOR', 'WORKER'] as const
export type RoleType = (typeof ROLE_TYPES)[number]

/** 会话身份预留字段（v0.4）。现在可空，未来完整会话会逐步填满。 */
export interface SessionIdentity {
  /** DSH 会话 id（绑定即“角色属于这个独立会话”）。 */
  sessionId?: string | null
  /** 模型名，如 deepseek-v4-pro / gpt-5.6（预留，可空）。 */
  modelName?: string | null
  /** agent 工具名，如 codex / dsh（预留，可空）。 */
  agentName?: string | null
  /** 通用扩展槽：JSON 对象，承载任意未来字段（provider/版本/runtime/…）。 */
  sessionMeta?: Record<string, unknown> | string | null
}

/** 把 session_meta 归一化为可入库的 JSON 字符串（非法 JSON 一律落 null，不猜）。 */
export function normalizeSessionMeta(meta: Record<string, unknown> | string | null | undefined): string | null {
  if (meta === undefined || meta === null) return null
  try {
    const text = typeof meta === 'string' ? meta : JSON.stringify(meta)
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return JSON.stringify(parsed)
  } catch {
    return null
  }
}

export interface BindRoleInput extends SessionIdentity {
  kingdomId: string
  roleType: string
  roleName?: string
}

export interface UnbindRoleInput {
  kingdomId: string
  /** 二选一：roleType（按角色解绑）或 bindingId（按绑定解绑）。 */
  roleType?: string
  bindingId?: string
  reason?: string
}

export interface RebindSessionInput extends SessionIdentity {
  kingdomId: string
  /** 二选一：roleType 或 bindingId。 */
  roleType?: string
  bindingId?: string
}

/**
 * v0.5.2：Trusted Governance Administration Plane 的授权输入。
 *
 * 管理面（任命/罢免/改绑/换届）的调用者身份只允许来自 DSH Runtime
 * （工具面经 `sessionPrincipal(exec)` 注入），**绝不允许调用参数自报**。
 * - `declarative`（本地演示）：不校验调用者（snapshot 如实标注 local-demo）；
 * - `session-bound`（真实权限边界）：只有 OWNER binding 关联的真实会话可执行。
 */
export interface AdminAuth {
  mode: 'declarative' | 'session-bound'
  /** 调用方会话（来自 DSH Runtime 证明，工具面注入）。 */
  principalSessionId?: string | null
}

/**
 * v0.5.2 管理面守卫：组织管理（bind/unbind/rebind）在 session-bound 模式下
 * 仅 OWNER 真实会话可执行；OWNER 未绑定会话时 fail-closed（不猜、不放行）。
 */
export function requireAdmin(
  store: KingdomStore,
  kingdomId: string,
  auth?: AdminAuth,
): { ok: true; owner: RoleBindingRow | null } | { ok: false; message: string } {
  if (!auth || auth.mode !== 'session-bound') {
    return { ok: true, owner: null } // declarative：本地可信演示权限，保持现状
  }
  const owner = store.getBindingByRole(kingdomId, 'OWNER')
  if (!owner) {
    return { ok: false, message: '错误：当前王国没有 OWNER 绑定，组织管理无法验证管理者身份。' }
  }
  if (!owner.session_id) {
    return {
      ok: false,
      message: '错误：OWNER 绑定未关联会话，session-bound 模式下无法验证管理者身份。'
        + '请先用真实 OWNER 会话执行 kingdom_bind_session(role_type="OWNER", session_id=<该会话>) 后重试。',
    }
  }
  if (auth.principalSessionId !== owner.session_id) {
    return { ok: false, message: '错误：组织管理（任命/罢免/改绑）只有 OWNER 会话可以执行，当前调用者被拒绝。' }
  }
  return { ok: true, owner }
}

export function bindRole(store: KingdomStore, input: BindRoleInput, auth?: AdminAuth): string {
  const admin = requireAdmin(store, input.kingdomId, auth)
  if (!admin.ok) return admin.message
  const roleType = input.roleType.trim().toUpperCase()
  if (!ROLE_TYPES.includes(roleType as RoleType)) {
    return `错误：role_type 必须是 ${ROLE_TYPES.join(' / ')} 之一。`
  }
  const roleName = input.roleName?.trim() || `${roleType}-${randomUUID().slice(0, 8)}`
  const sessionId = input.sessionId?.trim() || null
  const modelName = input.modelName?.trim() || null
  const agentName = input.agentName?.trim() || null
  const sessionMeta = normalizeSessionMeta(input.sessionMeta)

  // 同角色已存在：v0.4 起提示改用 kingdom_bind_session 重绑（或先解绑再绑）
  const existing = store.getBindingByRole(input.kingdomId, roleType)
  if (existing) {
    return `角色 ${roleType} 已有绑定（${existing.role_name}，session=${existing.session_id ?? '未绑定 session'}` +
      `${existing.model_name ? `，model=${existing.model_name}` : ''}` +
      `${existing.agent_name ? `，agent=${existing.agent_name}` : ''}）。` +
      `如需更换会话/身份，用 kingdom_bind_session（或先 kingdom_unbind_role 再绑定）。`
  }

  const now = new Date().toISOString()
  store.insertBinding({
    binding_id: randomUUID(),
    kingdom_id: input.kingdomId,
    role_type: roleType,
    role_name: roleName,
    runtime_type: 'dsh',
    session_id: sessionId,
    model_name: modelName,
    agent_name: agentName,
    session_meta: sessionMeta,
    principal_id: null,
    created_at: now,
    updated_at: now,
  })
  store.appendEvent({
    event_id: randomUUID(),
    kingdom_id: input.kingdomId,
    event_type: 'ROLE_BOUND',
    // v0.5.2 审计修正：actor = 实际操作者（session-bound 下为可信 OWNER）；
    // declarative 演示模式无可信 principal，保留被操作角色作兼容标注。
    actor_role: admin.owner ? 'OWNER' : roleType,
    actor_id: admin.owner?.binding_id ?? null,
    target_type: 'binding',
    target_id: null,
    payload_json: JSON.stringify({
      role_name: roleName,
      role_type: roleType,
      session_id: sessionId,
      model_name: modelName,
      agent_name: agentName,
      session_meta: sessionMeta ? JSON.parse(sessionMeta) : null,
    }),
    created_at: now,
  })
  const identity = [
    sessionId ? `session=${sessionId}` : null,
    modelName ? `model=${modelName}` : null,
    agentName ? `agent=${agentName}` : null,
  ].filter(Boolean).join('，')
  return `已绑定角色 ${roleType}（${roleName}${identity ? `，${identity}` : '，未指定会话身份'}）。`
}

/**
 * v0.4：解绑（换届通道）。
 * - OWNER 受保护：王国需要常驻 Owner，解绑直接拒绝。
 * - 被解绑角色若已被任务引用（assigned_binding_id），任务保留引用、
 *   展示层显示为“未指派”；相关治理操作会因缺绑定而明确报错（ROLE_BINDING_MISSING）。
 */
export function unbindRole(store: KingdomStore, input: UnbindRoleInput, auth?: AdminAuth): string {
  const admin = requireAdmin(store, input.kingdomId, auth)
  if (!admin.ok) return admin.message
  const binding = resolveBinding(store, input.kingdomId, input.roleType, input.bindingId)
  if (binding === null) {
    if (input.bindingId?.trim()) {
      return `错误：找不到绑定 ${input.bindingId.trim()}（请核对 binding_id 是否属于当前王国）。`
    }
    return input.roleType?.trim()
      ? `错误：当前王国没有 ${input.roleType.trim().toUpperCase()} 角色绑定可解绑。`
      : '错误：找不到要解绑的绑定（请提供 role_type 或 binding_id）。'
  }
  if (binding.role_type === 'OWNER') {
    return `错误：OWNER 是王国的常驻所有者身份，不允许解绑。如需更换 Owner 请重建王国或等待未来版本。`
  }
  store.deleteBinding(binding.binding_id)
  store.appendEvent({
    event_id: randomUUID(),
    kingdom_id: input.kingdomId,
    event_type: 'ROLE_UNBOUND',
    // v0.5.2 审计修正：actor = 实际操作者（OWNER），target = 被罢免的绑定。
    actor_role: admin.owner ? 'OWNER' : binding.role_type,
    actor_id: admin.owner?.binding_id ?? null,
    target_type: 'binding',
    target_id: binding.binding_id,
    payload_json: JSON.stringify({
      role_type: binding.role_type,
      role_name: binding.role_name,
      session_id: binding.session_id,
      reason: input.reason?.trim() ?? null,
    }),
    created_at: new Date().toISOString(),
  })
  return `已解绑角色 ${binding.role_type}（${binding.role_name}，session=${binding.session_id ?? '未绑定'}）。` +
    `该角色现在空缺，可重新 kingdom_bind_role。`
}

/**
 * v0.4：把角色绑定到（或改绑到）某个独立会话，并更新身份预留字段。
 * - `undefined` = 保持不变；`null` = 显式清空；字符串/对象 = 覆盖。
 * - 这是「角色真正属于某一个独立会话」的写入通道。
 */
export function rebindSession(store: KingdomStore, input: RebindSessionInput, auth?: AdminAuth): string {
  const admin = requireAdmin(store, input.kingdomId, auth)
  if (!admin.ok) return admin.message
  const binding = resolveBinding(store, input.kingdomId, input.roleType, input.bindingId)
  if (binding === null) {
    if (input.bindingId?.trim()) {
      return `错误：找不到绑定 ${input.bindingId.trim()}（请核对 binding_id 是否属于当前王国）。`
    }
    return input.roleType?.trim()
      ? `错误：当前王国没有 ${input.roleType.trim().toUpperCase()} 角色绑定可重绑。`
      : '错误：找不到要重绑的绑定（请提供 role_type 或 binding_id）。'
  }
  const patch: {
    sessionId?: string | null
    modelName?: string | null
    agentName?: string | null
    sessionMeta?: string | null
  } = {}
  if (input.sessionId !== undefined) patch.sessionId = input.sessionId?.trim() || null
  if (input.modelName !== undefined) patch.modelName = input.modelName?.trim() || null
  if (input.agentName !== undefined) patch.agentName = input.agentName?.trim() || null
  if (input.sessionMeta !== undefined) patch.sessionMeta = normalizeSessionMeta(input.sessionMeta)
  if (Object.keys(patch).length === 0) {
    return `角色 ${binding.role_type}（${binding.role_name}）未做任何变更（未提供要更新的字段）。`
  }
  store.updateBindingProfile(binding.binding_id, patch, new Date().toISOString())
  const after = store.getBindingById(binding.binding_id)
  const identity = [
    after?.session_id ? `session=${after.session_id}` : null,
    after?.model_name ? `model=${after.model_name}` : null,
    after?.agent_name ? `agent=${after.agent_name}` : null,
  ].filter(Boolean).join('，')
  store.appendEvent({
    event_id: randomUUID(),
    kingdom_id: input.kingdomId,
    event_type: 'BINDING_PROFILE_UPDATED',
    // v0.5.2 审计修正：actor = 实际操作者（OWNER），target = 被改绑的绑定。
    actor_role: admin.owner ? 'OWNER' : binding.role_type,
    actor_id: admin.owner?.binding_id ?? null,
    target_type: 'binding',
    target_id: binding.binding_id,
    payload_json: JSON.stringify({
      role_type: binding.role_type,
      role_name: binding.role_name,
      session_id: after?.session_id ?? null,
      model_name: after?.model_name ?? null,
      agent_name: after?.agent_name ?? null,
      session_meta: after?.session_meta ? JSON.parse(after.session_meta) : null,
    }),
    created_at: new Date().toISOString(),
  })
  return `角色 ${binding.role_type}（${binding.role_name}）的会话身份已更新：${identity || '全部清空'}。`
}

/** 按 roleType 或 bindingId 解析一条属于本王国的绑定。 */
export function resolveBinding(
  store: KingdomStore,
  kingdomId: string,
  roleType?: string,
  bindingId?: string,
): RoleBindingRow | null {
  if (bindingId?.trim()) {
    const byId = store.getBindingById(bindingId.trim())
    return byId && byId.kingdom_id === kingdomId ? byId : null
  }
  const role = roleType?.trim().toUpperCase()
  if (!role) return null
  const byRole = store.getBindingByRole(kingdomId, role)
  return byRole ?? null
}

export function listBindings(store: KingdomStore, kingdomId: string): string {
  const rows: RoleBindingRow[] = store.listBindings(kingdomId)
  if (rows.length === 0) return '当前王国还没有角色绑定。'
  return rows
    .map((b: RoleBindingRow) => {
      const identity = [
        b.session_id ? `session=${b.session_id}` : null,
        b.model_name ? `model=${b.model_name}` : null,
        b.agent_name ? `agent=${b.agent_name}` : null,
        b.session_meta ? 'meta=有' : null,
      ].filter(Boolean).join('，')
      return `- ${b.role_type}（${b.role_name}${identity ? `，${identity}` : '，未绑定会话身份'}）`
    })
    .join('\n')
}
