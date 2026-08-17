/**
 * dsh-kingdom — Role Binding 基础 CRUD（Phase 1）。
 *
 * Role、Runtime、Model、Session 解耦：
 *   Role → Binding → DSH Session → Model/Tools
 * Binding 可以更换 Session；Role 的组织身份不因模型或 Session 改变而改变。
 *
 * Phase 1 仅支持：绑定角色↔session（role_type 枚举 + role_name + session_id 可选）、
 * 列出绑定。角色类型固定 OWNER/CHANCELLOR/SUPERVISOR/WORKER，不支持动态创建角色类型。
 */
import { randomUUID } from 'node:crypto'
import { KingdomStore, RoleBindingRow } from './db.js'

export const ROLE_TYPES = ['OWNER', 'CHANCELLOR', 'SUPERVISOR', 'WORKER'] as const
export type RoleType = (typeof ROLE_TYPES)[number]

export interface BindRoleInput {
  kingdomId: string
  roleType: string
  roleName?: string
  sessionId?: string
}

export function bindRole(store: KingdomStore, input: BindRoleInput): string {
  const roleType = input.roleType.trim().toUpperCase()
  if (!ROLE_TYPES.includes(roleType as RoleType)) {
    return `错误：role_type 必须是 ${ROLE_TYPES.join(' / ')} 之一。`
  }
  const roleName = input.roleName?.trim() || `${roleType}-${randomUUID().slice(0, 8)}`

  // 同角色已存在：Phase 1 同一角色只保留一个绑定（重复绑定返回既有，不改）
  const existing = store.getBindingByRole(input.kingdomId, roleType)
  if (existing) {
    return `角色 ${roleType} 已有绑定（${existing.role_name}，session=${existing.session_id ?? '未绑定 session'}）。如需更换 session，先解绑或未来版本支持。`
  }

  const now = new Date().toISOString()
  store.insertBinding({
    binding_id: randomUUID(),
    kingdom_id: input.kingdomId,
    role_type: roleType,
    role_name: roleName,
    runtime_type: 'dsh',
    session_id: input.sessionId?.trim() || null,
    principal_id: null,
    created_at: now,
    updated_at: now,
  })
  store.appendEvent({
    event_id: randomUUID(),
    kingdom_id: input.kingdomId,
    event_type: 'ROLE_BOUND',
    actor_role: roleType,
    actor_id: null,
    target_type: 'binding',
    target_id: null,
    payload_json: JSON.stringify({ role_name: roleName, session_id: input.sessionId ?? null }),
    created_at: now,
  })
  return `已绑定角色 ${roleType}（${roleName}${input.sessionId ? `，session=${input.sessionId}` : '，未指定 session'}）。`
}

export function listBindings(store: KingdomStore, kingdomId: string): string {
  const rows: RoleBindingRow[] = store.listBindings(kingdomId)
  if (rows.length === 0) return '当前王国还没有角色绑定。'
  return rows
    .map((b: RoleBindingRow) => `- ${b.role_type}（${b.role_name}，session=${b.session_id ?? '未绑定'}）`)
    .join('\n')
}
