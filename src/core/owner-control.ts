/**
 * Trusted-local Owner Control Plane.
 *
 * The capability below is deliberately opaque to runtime callers.  Only the
 * canonical direct `/kingdom` command handler may mint one; Agent Tools,
 * GUI/HTTP handlers, arguments, and DSH session attribution never receive a
 * path to construct or forward it.
 */
import type { KingdomStore, RoleBindingRow } from './db.js'
import type { AdminAuth } from './binding.js'

const OWNER_CONTROL_MARKER = Symbol('dsh-kingdom.owner-control')

export interface OwnerControlCapability {
  readonly [OWNER_CONTROL_MARKER]: true
}

/** Mint a capability for the direct local Slash handler only. */
export function issueOwnerControlCapability(): OwnerControlCapability {
  return Object.freeze({ [OWNER_CONTROL_MARKER]: true }) as OwnerControlCapability
}

export function isOwnerControlCapability(value: unknown): value is OwnerControlCapability {
  return typeof value === 'object'
    && value !== null
    && (value as Record<symbol, unknown>)[OWNER_CONTROL_MARKER] === true
}

export interface OwnerControlCheck {
  ok: true
  owner: RoleBindingRow | null
  ownerId: string
  sourceChannel: 'LOCAL_DIRECT_SLASH'
}

export interface OwnerControlFailure {
  ok: false
  message: string
}

/**
 * The single Core gate for Owner-only writes.  It intentionally ignores
 * OWNER.session_id and all caller/session fields; the only authority input is
 * the opaque capability minted by the direct Slash adapter.
 */
export function requireOwnerControl(
  store: KingdomStore,
  kingdomId: string,
  capability: unknown,
): OwnerControlCheck | OwnerControlFailure {
  if (!isOwnerControlCapability(capability)) {
    return {
      ok: false,
      message: 'OWNER_CONTROL_REQUIRED: 该写操作只能通过 direct /kingdom Slash 的 Owner Control Plane 执行。',
    }
  }
  const kingdom = store.getDefaultKingdom()
  if (!kingdom || kingdom.kingdom_id !== kingdomId) {
    return { ok: false, message: 'OWNER_CONTROL_REQUIRED: 当前王国不存在或不属于本 Owner Control Plane。' }
  }
  return {
    ok: true,
    owner: store.getBindingByRole(kingdomId, 'OWNER'),
    ownerId: kingdom.owner_id,
    sourceChannel: 'LOCAL_DIRECT_SLASH',
  }
}

/** Convert the direct capability into the shared Core admin input. */
export function ownerControlAuth(capability: OwnerControlCapability): AdminAuth {
  return { mode: 'session-bound', ownerControl: capability }
}

export function ownerEventPayload(
  operation: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    operation,
    ...fields,
    source_channel: 'LOCAL_DIRECT_SLASH',
  }
}

