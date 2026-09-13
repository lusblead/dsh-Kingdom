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
import { createHash } from 'node:crypto'

const OWNER_CONTROL_MARKER = Symbol('dsh-kingdom.owner-control')
const directCapabilities = new WeakSet<object>()
const operationCapabilities = new WeakMap<object, {
  store: KingdomStore; kingdomId: string; ownerId: string; operation: string; inputHash: string; source: OwnerEventSource
}>()

export interface OwnerEventSource {
  source_channel: 'LOCAL_DIRECT_SLASH' | 'LOCAL_OWNER_GUI'
  authorization_source?: 'LOCAL_DIRECT_SLASH'
  decision_id?: string
  operation_id?: string
}
export interface OwnerOperationMatch { operation: string; input: unknown }

/** Stable JSON for exact, immutable operation matching. Undefined follows JSON semantics. */
export function ownerInputHash(input: unknown): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort)
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
      .filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => [key, sort((value as Record<string, unknown>)[key])]))
    return value
  }
  return createHash('sha256').update(JSON.stringify(sort(input))).digest('hex')
}

export interface OwnerControlCapability {
  readonly [OWNER_CONTROL_MARKER]: true
}

/** Mint a capability for the direct local Slash handler only. */
export function issueOwnerControlCapability(): OwnerControlCapability {
  const capability = Object.freeze({ [OWNER_CONTROL_MARKER]: true }) as OwnerControlCapability
  directCapabilities.add(capability)
  return capability
}

export function isOwnerControlCapability(value: unknown): value is OwnerControlCapability {
  return typeof value === 'object'
    && value !== null
    && directCapabilities.has(value)
}

/** Internal controller seam; requires the original direct capability, never HTTP data. */
export function issueOwnerOperationCapability(
  authority: OwnerControlCapability, store: KingdomStore, kingdomId: string,
  match: OwnerOperationMatch, source: OwnerEventSource,
): OwnerControlCapability {
  const checked = requireOwnerControl(store, kingdomId, authority)
  if (!checked.ok) throw new Error(checked.message)
  const capability = Object.freeze({ [OWNER_CONTROL_MARKER]: true }) as OwnerControlCapability
  operationCapabilities.set(capability, { store, kingdomId, ownerId: checked.ownerId,
    operation: match.operation, inputHash: ownerInputHash(match.input), source: { ...source } })
  return capability
}

export function revokeOwnerOperationCapability(capability: OwnerControlCapability): void {
  operationCapabilities.delete(capability)
}

export interface OwnerControlCheck {
  ok: true
  owner: RoleBindingRow | null
  ownerId: string
  sourceChannel: 'LOCAL_DIRECT_SLASH' | 'LOCAL_OWNER_GUI'
  eventSource: OwnerEventSource
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
  match?: OwnerOperationMatch,
): OwnerControlCheck | OwnerControlFailure {
  const narrow = typeof capability === 'object' && capability !== null ? operationCapabilities.get(capability) : undefined
  if (!isOwnerControlCapability(capability) && !narrow) {
    return {
      ok: false,
      message: 'OWNER_CONTROL_REQUIRED: 该写操作只能通过 direct /kingdom Slash 的 Owner Control Plane 执行。',
    }
  }
  const kingdom = store.getDefaultKingdom()
  if (!kingdom || kingdom.kingdom_id !== kingdomId) {
    return { ok: false, message: 'OWNER_CONTROL_REQUIRED: 当前王国不存在或不属于本 Owner Control Plane。' }
  }
  if (narrow) {
    if (narrow.store !== store || narrow.kingdomId !== kingdomId || narrow.ownerId !== kingdom.owner_id
      || !match || match.operation !== narrow.operation || ownerInputHash(match.input) !== narrow.inputHash) {
      return { ok: false, message: 'OWNER_OPERATION_MISMATCH: 一次性能力与操作或参数不匹配。' }
    }
    operationCapabilities.delete(capability as object)
  }
  const eventSource: OwnerEventSource = narrow?.source ?? { source_channel: 'LOCAL_DIRECT_SLASH' }
  return {
    ok: true,
    owner: store.getBindingByRole(kingdomId, 'OWNER'),
    ownerId: kingdom.owner_id,
    sourceChannel: eventSource.source_channel,
    eventSource,
  }
}

/** Convert the direct capability into the shared Core admin input. */
export function ownerControlAuth(capability: OwnerControlCapability): AdminAuth {
  return { mode: 'session-bound', ownerControl: capability }
}

export function ownerEventPayload(
  operation: string,
  fields: Record<string, unknown> = {},
  source: OwnerEventSource = { source_channel: 'LOCAL_DIRECT_SLASH' },
): Record<string, unknown> {
  return {
    operation,
    ...fields,
    ...source,
  }
}
