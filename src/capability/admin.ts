/**
 * Public Owner capability-ceiling administration.
 *
 * The ceiling is an existing v4 Kingdom fact.  This module only exposes the
 * smallest supported write path for it: the direct `/kingdom` Owner Control
 * handler may submit a boolean capability allow-list, which is validated,
 * persisted, and audited. Agent sessions and legacy OWNER.session_id are not
 * an authority source.
 * It deliberately does not change capability-gate ordering or execution
 * semantics.
 */
import { randomUUID } from 'node:crypto'
import type { KingdomStore } from '../core/db.js'
import { requireAdmin, type AdminAuth } from '../core/binding.js'

export interface SetCapabilityCeilingInput {
  kingdomId: string
  /** JSON object string; null clears the ceiling and keeps governed execution fail-closed. */
  ceilingJson: string | null
}

type CeilingMap = Record<string, boolean>

function parseCeiling(json: string): { ok: true; value: CeilingMap } | { ok: false; message: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { ok: false, message: '错误：capability ceiling 必须是合法 JSON 对象。' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: '错误：capability ceiling 必须是 JSON 对象（capability 名称 → boolean）。' }
  }
  const entries = Object.entries(parsed as Record<string, unknown>)
  for (const [capability, allowed] of entries) {
    if (capability.trim().length === 0 || typeof allowed !== 'boolean') {
      return { ok: false, message: '错误：capability ceiling 的每个 key 必须是非空 capability 名称，value 必须是 boolean。' }
    }
  }
  return { ok: true, value: Object.fromEntries(entries.map(([key, value]) => [key.trim(), value])) as CeilingMap }
}

/**
 * Set or clear the existing Owner Ceiling fact through the direct Owner
 * Control plane. A runtime-derived principal or a session id supplied in
 * tool arguments is never accepted here.
 */
export function setCapabilityCeiling(
  store: KingdomStore,
  input: SetCapabilityCeilingInput,
  auth?: AdminAuth,
): string {
  const admin = requireAdmin(store, input.kingdomId, auth)
  if (!admin.ok) return `CONFIG_DENIED: ${admin.message}`

  let normalized: string | null = null
  let value: CeilingMap | null = null
  if (input.ceilingJson !== null) {
    const parsed = parseCeiling(input.ceilingJson)
    if (!parsed.ok) return `CONFIG_DENIED: ${parsed.message}`
    value = parsed.value
    normalized = JSON.stringify(value)
  }

  store.setKingdomCapabilityCeiling(input.kingdomId, normalized)
  store.appendEvent({
    event_id: randomUUID(),
    kingdom_id: input.kingdomId,
    event_type: 'CAPABILITY_CEILING_UPDATED',
    actor_role: admin.owner ? 'OWNER' : null,
    actor_id: admin.ownerControl ? admin.ownerPrincipalId : admin.owner?.binding_id ?? null,
    target_type: 'kingdom',
    target_id: input.kingdomId,
    payload_json: JSON.stringify({
      ceiling: value,
      cleared: value === null,
      source: 'direct-owner-slash',
      ...(admin.ownerControl ? { source_channel: 'LOCAL_DIRECT_SLASH' } : {}),
    }),
    created_at: new Date().toISOString(),
  })

  return value === null
    ? 'Owner Capability Ceiling 已清空；governed persistent execution 将继续 fail-closed，直到重新配置。'
    : `Owner Capability Ceiling 已配置（${Object.keys(value).length} 项）；下一步由已授权的 Supervisor Agent Session 提交本次 Grant 进入既有 Capability Gate；Owner 仍通过 direct /kingdom Slash 管理 Ceiling。`
}
