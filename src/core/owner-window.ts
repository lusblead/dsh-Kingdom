import { createHash, randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import type { EventRow, KingdomStore, RoleBindingRow, TerritoryRow } from './db.js'
import { bindRole, rebindSession, setExecutionProfile, type AdminAuth, type ExecutionProfileV1 } from './binding.js'
import { createTerritory, setTerritorySupervisor, updateTerritory } from './territory.js'
import { setCapabilityCeiling } from '../capability/admin.js'
import {
  isOwnerControlCapability, issueOwnerOperationCapability, revokeOwnerOperationCapability,
  ownerEventPayload, ownerInputHash, type OwnerControlCapability, type OwnerEventSource,
} from './owner-control.js'
import { initializeKingdomFacts } from './kingdom.js'
import { normalizeBudgetPolicyParameters, readBudgetPolicy, setBudgetPolicy, type BudgetPolicyParameters } from './budget.js'
import { adoptCollaborationPlan, listCollaborationPlans, readCollaborationPlan, normalizePlanAdoptionParameters, type PlanAdoptionParameters, type CollaborationPlanView } from './collaboration.js'

export const OWNER_MUTATION_ACTIONS = ['init', 'territory.create', 'territory.update', 'territory.supervisor', 'role.bind', 'role.session', 'ceiling', 'execution-profile', 'budget.policy', 'plan.adopt'] as const
export type OwnerMutationAction = typeof OWNER_MUTATION_ACTIONS[number]
export type OwnerManagedRole = 'CHANCELLOR' | 'SUPERVISOR' | 'WORKER'
export interface OwnerDecisionScope {
  kingdomWide: boolean
  territoryIds: string[]
  bindingIds: string[]
  roleTypes: OwnerManagedRole[]
  targetSessionIds: string[]
  workspaceRoots: string[]
}
export interface OwnerDecisionInput {
  kingdomId: string | null
  actions: OwnerMutationAction[]
  scope: OwnerDecisionScope
  ttlMs: number
}
declare const OWNER_DECISION_HANDLE: unique symbol
export interface OwnerDecisionHandle { readonly [OWNER_DECISION_HANDLE]: true }
export interface OwnerDecisionView {
  decisionId: string
  kingdomId: string | null
  ownerId: string | null
  actions: OwnerMutationAction[]
  scope: OwnerDecisionScope
  createdAt: string
  expiresAt: string
  state: 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'CONSUMED'
}
export interface OwnerValidationFailure { ok: false; code: string; message: string }
export type OwnerValidationResult = { ok: true } | OwnerValidationFailure
export interface OwnerSessionValidationInput {
  kingdomId: string
  roleType: 'CHANCELLOR' | 'SUPERVISOR'
  bindingId: string | null
  sessionId: string
  signal: AbortSignal
}
export interface OwnerProfileValidationInput {
  kingdomId: string
  bindingId: string
  roleType: OwnerManagedRole
  profile: Readonly<ExecutionProfileV1> | null
  signal: AbortSignal
}
export interface OwnerRuntimeSessionChoice { id: string; label: string }
export interface OwnerDecisionControllerOptions {
  now?: () => number
  validationTimeoutMs?: number
  validateTargetSession: (input: OwnerSessionValidationInput) => Promise<OwnerValidationResult>
  validateExecutionProfile: (input: OwnerProfileValidationInput) => Promise<OwnerValidationResult>
  listTargetSessions: (input: { sessionIds: readonly string[]; signal: AbortSignal }) => Promise<readonly OwnerRuntimeSessionChoice[]>
}
export interface OwnerOperationCatalog {
  plans?: CollaborationPlanView[]
  territories: { id: string; name: string }[]
  bindings: { id: string; roleType: string; roleName: string }[]
  runtimeSessions: OwnerRuntimeSessionChoice[]
  workspaceRoots: string[]
}
export type OwnerOperationInput =
  | { action: 'init'; parameters: { kingdom_name: string; owner_name: string } }
  | { action: 'territory.create'; parameters: { name: string; workspace_path: string; summary?: string | null } }
  | { action: 'territory.update'; parameters: { territory_id: string; name?: string; summary?: string | null } }
  | { action: 'territory.supervisor'; parameters: { territory_id: string; supervisor_binding_id: string } }
  | { action: 'role.bind'; parameters: { role_type: OwnerManagedRole; role_name: string; session_id?: string | null } }
  | { action: 'role.session'; parameters: { binding_id: string; session_id: string } }
  | { action: 'ceiling'; parameters: { ceiling: Record<string, boolean> } }
  | { action: 'execution-profile'; parameters: { binding_id: string; profile: ExecutionProfileV1 | null } }
  | { action: 'budget.policy'; parameters: BudgetPolicyParameters }
  | { action: 'plan.adopt'; parameters: PlanAdoptionParameters }
export interface OwnerOperationPreview {
  prepareId: string
  operationId: string
  decisionId: string
  action: OwnerMutationAction
  summary: string
  changes: { label: string; before: string | null; after: string | null }[]
  affected: { territoryIds: string[]; bindingIds: string[] }
  createdAt: string
  expiresAt: string
}
export interface OwnerOperationReceipt {
  type: 'KingdomOwnerOperationReceipt/v1'
  operationId: string
  prepareId: string
  decisionId: string
  kingdomId: string
  ownerId: string
  action: OwnerMutationAction
  inputHash: string
  status: 'APPLIED'
  target: { type: 'kingdom' | 'territory' | 'binding' | 'collaboration-plan'; id: string }
  receiptSeq: number
  appliedAt: string
  message: string
}
export class OwnerOperationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'OwnerOperationError' }
}

// Controller implementation follows the shared interfaces above. Only Core owns
// decision/preparation objects; transport receives an opaque handle and public views.

interface DecisionRecord {
  view: OwnerDecisionView
  authority: OwnerControlCapability
  abort: AbortController
  timer: ReturnType<typeof setTimeout>
  preparations: Map<string, Preparation>
}
interface Preparation {
  input: OwnerOperationInput
  inputHash: string
  fingerprint: string
  preview: OwnerOperationPreview
  receipt?: OwnerOperationReceipt
  committing?: Promise<OwnerOperationReceipt>
}
interface OperationContext {
  territoryIds: string[]
  bindingIds: string[]
  sessionIds: string[]
  fingerprint: string
  before: string | null
  after: string | null
  summary: string
}
const MANAGED_ROLES: readonly string[] = ['CHANCELLOR', 'SUPERVISOR', 'WORKER']
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function fail(code: string, message: string): never { throw new OwnerOperationError(code, message) }
function object(value: unknown, allowed: readonly string[], required: readonly string[] = allowed): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.getOwnPropertySymbols(value).length > 0) fail('INVALID_INPUT', '输入必须是普通 JSON 对象。')
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(result, key))) {
    fail('INVALID_INPUT', '输入存在未知字段或缺少必填字段。')
  }
  return result
}
function string(value: unknown, label: string, limit = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('INVALID_INPUT', `${label}必须是非空、长度受限的文本。`)
  }
  return value.trim()
}
function textOrNull(value: unknown, label: string): string | null {
  return value === null || value === '' ? null : string(value, label, 2000)
}
function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 200) fail('INVALID_INPUT', `${label}必须是至多 200 项的列表。`)
  return [...new Set(value.map(item => string(item, label)))].sort()
}
function directory(value: unknown): string {
  const path = string(value, '目录', 4096)
  if (!isAbsolute(path) || /^[\\/]{2}/u.test(path)) fail('INVALID_PATH', '目录必须是本机绝对路径，不能是网络共享。')
  try {
    const result = realpathSync.native(path)
    if (/^[\\/]{2}/u.test(result) || !statSync(result).isDirectory()) fail('INVALID_PATH', '目录必须是现存本机目录。')
    return result
  } catch (error) {
    if (error instanceof OwnerOperationError) throw error
    fail('INVALID_PATH', '目录不存在或无法解析。')
  }
}
function within(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}
function normalizeInput(raw: OwnerOperationInput): OwnerOperationInput {
  const outer = object(raw, ['action', 'parameters'])
  switch (outer.action) {
    case 'plan.adopt': return { action: 'plan.adopt', parameters: normalizePlanAdoptionParameters(outer.parameters) }
    case 'budget.policy': return { action: 'budget.policy', parameters: normalizeBudgetPolicyParameters(outer.parameters) }
    case 'init': {
      const p = object(outer.parameters, ['kingdom_name', 'owner_name'])
      return { action: 'init', parameters: { kingdom_name: string(p.kingdom_name, '王国名称', 120), owner_name: string(p.owner_name, 'Owner 名称', 120) } }
    }
    case 'territory.create': {
      const p = object(outer.parameters, ['name', 'workspace_path', 'summary'], ['name', 'workspace_path'])
      return { action: 'territory.create', parameters: { name: string(p.name, '领地名称', 120), workspace_path: directory(p.workspace_path), summary: p.summary === undefined ? null : textOrNull(p.summary, '领地说明') } }
    }
    case 'territory.update': {
      const p = object(outer.parameters, ['territory_id', 'name', 'summary'], ['territory_id'])
      if (!Object.hasOwn(p, 'name') && !Object.hasOwn(p, 'summary')) fail('INVALID_INPUT', '至少提供名称或说明。')
      return { action: 'territory.update', parameters: { territory_id: string(p.territory_id, '领地 ID'),
        ...(Object.hasOwn(p, 'name') ? { name: string(p.name, '领地名称', 120) } : {}),
        ...(Object.hasOwn(p, 'summary') ? { summary: textOrNull(p.summary, '领地说明') } : {}) } }
    }
    case 'territory.supervisor': {
      const p = object(outer.parameters, ['territory_id', 'supervisor_binding_id'])
      return { action: 'territory.supervisor', parameters: { territory_id: string(p.territory_id, '领地 ID'), supervisor_binding_id: string(p.supervisor_binding_id, '主管绑定 ID') } }
    }
    case 'role.bind': {
      const p = object(outer.parameters, ['role_type', 'role_name', 'session_id'], ['role_type', 'role_name'])
      if (!MANAGED_ROLES.includes(p.role_type as string)) fail('INVALID_ROLE', '仅支持宰相、主管和执行者。')
      const session = p.session_id === undefined || p.session_id === null ? null : string(p.session_id, 'Session ID')
      if (p.role_type === 'WORKER' && session !== null) fail('WORKER_SESSION_UNSUPPORTED', '执行者 Session 由正常 governed 执行路径建立。')
      if (p.role_type !== 'WORKER' && session === null) fail('TARGET_SESSION_REQUIRED', '主管和宰相必须选择已有真实 Session。')
      return { action: 'role.bind', parameters: { role_type: p.role_type as OwnerManagedRole, role_name: string(p.role_name, '角色名称', 120), session_id: session } }
    }
    case 'role.session': {
      const p = object(outer.parameters, ['binding_id', 'session_id'])
      return { action: 'role.session', parameters: { binding_id: string(p.binding_id, '绑定 ID'), session_id: string(p.session_id, 'Session ID') } }
    }
    case 'ceiling': {
      const p = object(outer.parameters, ['ceiling'])
      const ceiling = object(p.ceiling, p.ceiling && typeof p.ceiling === 'object' ? Object.keys(p.ceiling) : [])
      if (Object.keys(ceiling).length > 256) fail('INVALID_INPUT', '权限上限项过多。')
      const entries = Object.entries(ceiling).map(([key, value]) => {
        if (typeof value !== 'boolean' || string(key, '能力名称', 160) !== key) fail('INVALID_INPUT', '能力名必须规范、取值必须是布尔值。')
        return [key, value] as const
      }).sort(([a], [b]) => a.localeCompare(b))
      return { action: 'ceiling', parameters: { ceiling: Object.fromEntries(entries) } }
    }
    case 'execution-profile': {
      const p = object(outer.parameters, ['binding_id', 'profile'])
      let profile: ExecutionProfileV1 | null = null
      if (p.profile !== null) {
        const config = object(p.profile, ['provider', 'model'], [])
        if (!Object.keys(config).length) fail('INVALID_INPUT', '执行配置不能为空对象；清空请使用 null。')
        profile = { ...(Object.hasOwn(config, 'provider') ? { provider: string(config.provider, 'Provider') } : {}),
          ...(Object.hasOwn(config, 'model') ? { model: string(config.model, 'Model') } : {}) }
      }
      return { action: 'execution-profile', parameters: { binding_id: string(p.binding_id, '绑定 ID'), profile } }
    }
    default: return fail('INVALID_ACTION', '不支持该管理动作。')
  }
}

/** Trusted-local decision registry. Public IDs and JSON views never confer authority. */
export class OwnerDecisionController {
  private readonly decisions = new Map<OwnerDecisionHandle, DecisionRecord>()
  private readonly now: () => number
  private readonly timeout: number
  private disposed = false

  constructor(private readonly store: KingdomStore, private readonly options: OwnerDecisionControllerOptions) {
    this.now = options.now ?? Date.now
    this.timeout = Math.min(30000, Math.max(1, options.validationTimeoutMs ?? 10000))
  }

  activate(capability: OwnerControlCapability, input: OwnerDecisionInput): { handle: OwnerDecisionHandle; decision: OwnerDecisionView } {
    if (this.disposed) fail('CONTROLLER_DISPOSED', '管理控制器已卸载。')
    if (!isOwnerControlCapability(capability)) fail('OWNER_CONTROL_REQUIRED', '只有可信直接入口能激活管理窗口。')
    const p = object(input, ['kingdomId', 'actions', 'scope', 'ttlMs'])
    const kingdomId = p.kingdomId === null ? null : string(p.kingdomId, '王国 ID')
    const actions = stringList(p.actions, '动作') as OwnerMutationAction[]
    if (!actions.length || actions.some(action => !OWNER_MUTATION_ACTIONS.includes(action))) fail('INVALID_ACTION', '管理动作集为空或不支持。')
    if (!Number.isSafeInteger(p.ttlMs) || (p.ttlMs as number) < 1 || (p.ttlMs as number) > 600000) fail('INVALID_TTL', '窗口有效期必须在 1 到 600000 毫秒内。')
    const s = object(p.scope, ['kingdomWide', 'territoryIds', 'bindingIds', 'roleTypes', 'targetSessionIds', 'workspaceRoots'])
    if (typeof s.kingdomWide !== 'boolean') fail('INVALID_INPUT', 'kingdomWide 必须是布尔值。')
    const scope: OwnerDecisionScope = { kingdomWide: s.kingdomWide,
      territoryIds: stringList(s.territoryIds, '领地 ID'), bindingIds: stringList(s.bindingIds, '绑定 ID'),
      roleTypes: stringList(s.roleTypes, '角色') as OwnerManagedRole[], targetSessionIds: stringList(s.targetSessionIds, 'Session ID'),
      workspaceRoots: stringList(s.workspaceRoots, '目录').map(directory) }
    if (scope.roleTypes.some(role => !MANAGED_ROLES.includes(role))) fail('INVALID_ROLE', '授权角色类型不受支持。')
    const kingdom = this.store.getDefaultKingdom()
    if (kingdomId === null) {
      if (kingdom || actions.length !== 1 || actions[0] !== 'init') fail('BOOTSTRAP_ONLY', '空库窗口只能初始化一次。')
      if (scope.kingdomWide || scope.territoryIds.length || scope.bindingIds.length || scope.roleTypes.length || scope.targetSessionIds.length || scope.workspaceRoots.length) {
        fail('BOOTSTRAP_ONLY', '初始化窗口不能携带后续管理范围。')
      }
    } else {
      if (!kingdom || kingdom.kingdom_id !== kingdomId || actions.includes('init')) fail('KINGDOM_MISMATCH', '王国不存在、已更换或不支持重复初始化。')
      for (const id of scope.territoryIds) {
        const row = this.store.getTerritoryById(id)
        if (!row || row.kingdom_id !== kingdomId || row.status === 'DELETED') fail('SCOPE_DENIED', '授权领地不存在或属于其他王国。')
      }
      for (const id of scope.bindingIds) {
        const row = this.store.getBindingById(id)
        if (!row || row.kingdom_id !== kingdomId || row.status !== 'ACTIVE' || !scope.roleTypes.includes(row.role_type as OwnerManagedRole)) {
          fail('SCOPE_DENIED', '授权绑定不存在、已退任或角色不在范围内。')
        }
      }
      if ((actions.includes('ceiling') || actions.includes('budget.policy')) && !scope.kingdomWide) fail('SCOPE_DENIED', '权限上限与预算政策必须取得王国级授权。')
    }
    const created = this.now()
    const view: OwnerDecisionView = { decisionId: randomUUID(), kingdomId, ownerId: kingdom?.owner_id ?? null,
      actions, scope, createdAt: new Date(created).toISOString(), expiresAt: new Date(created + (p.ttlMs as number)).toISOString(), state: 'ACTIVE' }
    // Persist activation before invalidating the previous usable window. A failed write cannot create authority.
    if (kingdom) this.event(kingdom.kingdom_id, kingdom.owner_id, 'OWNER_DECISION_CREATED', view.decisionId,
      { decision: view, source_channel: 'LOCAL_DIRECT_SLASH', authorization_source: 'LOCAL_DIRECT_SLASH' })
    for (const previous of this.decisions.values()) this.invalidate(previous, 'REVOKED')
    const handle = Object.freeze({}) as OwnerDecisionHandle
    const record: DecisionRecord = { view, authority: capability, abort: new AbortController(),
      timer: setTimeout(() => this.invalidate(record, 'EXPIRED'), p.ttlMs as number), preparations: new Map() }
    record.timer.unref?.()
    this.decisions.set(handle, record)
    return { handle, decision: clone(view) }
  }

  inspect(handle: OwnerDecisionHandle): OwnerDecisionView | null {
    const record = this.decisions.get(handle)
    if (!record) return null
    this.expire(record)
    return clone(record.view)
  }

  async catalog(handle: OwnerDecisionHandle): Promise<OwnerOperationCatalog> {
    const record = this.active(handle)
    const s = record.view.scope
    const sessions = await this.observe(record, undefined, signal => this.options.listTargetSessions({ sessionIds: [...s.targetSessionIds], signal }))
    this.active(handle)
    const kingdomId = record.view.kingdomId
    const bindings = kingdomId ? this.store.listBindings(kingdomId).filter(b => b.status === 'ACTIVE'
      && s.bindingIds.includes(b.binding_id) && s.roleTypes.includes(b.role_type as OwnerManagedRole)) : []
    return { territories: kingdomId ? this.store.listTerritories(kingdomId).filter(t => s.territoryIds.includes(t.territory_id))
      .map(t => ({ id: t.territory_id, name: t.name })) : [],
      bindings: bindings.map(b => ({ id: b.binding_id, roleType: b.role_type, roleName: b.role_name })),
      runtimeSessions: [...new Map(sessions.filter(item => s.targetSessionIds.includes(item.id))
        .map(item => [item.id, { id: item.id, label: string(item.label, 'Session 名称', 512) }])).values()],
      workspaceRoots: [...s.workspaceRoots],
      plans: kingdomId && record.view.actions.includes('plan.adopt') ? listCollaborationPlans(this.store, kingdomId).filter(plan => {
        try { this.context(record, { action: 'plan.adopt', parameters: { plan_id: plan.planId, version: plan.version, digest: plan.digest } }); return true }
        catch { return false }
      }) : [] }
  }

  async prepare(handle: OwnerDecisionHandle, raw: OwnerOperationInput, options: { signal?: AbortSignal } = {}): Promise<OwnerOperationPreview> {
    const record = this.active(handle)
    if (record.preparations.size >= 128) fail('PREPARATION_LIMIT', '当前窗口准备次数已达上限，请重新激活。')
    const input = normalizeInput(raw)
    const context = this.context(record, input)
    await this.validate(record, input, options.signal)
    this.active(handle)
    const checked = this.context(record, input)
    if (checked.fingerprint !== context.fingerprint) fail('PREVIEW_STALE', '校验期间相关事实已改变，请重新预览。')
    const createdAt = new Date(this.now()).toISOString()
    const preview: OwnerOperationPreview = { prepareId: randomUUID(), operationId: randomUUID(), decisionId: record.view.decisionId,
      action: input.action, summary: checked.summary, changes: this.changes(input, checked),
      affected: { territoryIds: checked.territoryIds, bindingIds: checked.bindingIds }, createdAt, expiresAt: record.view.expiresAt }
    record.preparations.set(preview.prepareId, { input: clone(input), inputHash: ownerInputHash(input), fingerprint: checked.fingerprint, preview })
    return clone(preview)
  }

  async commit(handle: OwnerDecisionHandle, input: { prepareId: string; operationId: string }, options: { signal?: AbortSignal } = {}): Promise<OwnerOperationReceipt> {
    object(input, ['prepareId', 'operationId'])
    const record = this.decisions.get(handle)
    if (!record) fail('OWNER_DECISION_REQUIRED', '管理窗口无效。')
    const preparation = record.preparations.get(string(input.prepareId, '准备 ID'))
    if (!preparation || preparation.preview.operationId !== string(input.operationId, '操作 ID')) fail('OPERATION_MISMATCH', '操作 ID 与准备内容不匹配。')
    const existing = this.receipt(handle, input.operationId)
    if (existing) return existing
    this.active(handle)
    if (preparation.committing) return clone(await preparation.committing)
    const pending = this.apply(handle, record, preparation, options.signal)
    preparation.committing = pending
    try { return clone(await pending) } finally { preparation.committing = undefined }
  }

  receipt(handle: OwnerDecisionHandle, operationId: string): OwnerOperationReceipt | null {
    const record = this.decisions.get(handle)
    if (!record) return null
    for (const preparation of record.preparations.values()) {
      if (preparation.preview.operationId !== operationId) continue
      const kingdom = this.store.getDefaultKingdom()
      if (!kingdom || record.view.kingdomId !== null && record.view.kingdomId !== kingdom.kingdom_id) return null
      const row = this.store.getEventById(this.receiptEventId(kingdom.kingdom_id, operationId))
      if (!row) return null
      const payload = JSON.parse(row.payload_json) as OwnerOperationReceipt
      if (row.event_type !== 'OWNER_OPERATION_APPLIED' || row.actor_id !== kingdom.owner_id || payload.decisionId !== record.view.decisionId
        || payload.prepareId !== preparation.preview.prepareId || payload.operationId !== operationId || payload.inputHash !== preparation.inputHash) {
        fail('OPERATION_REPLAY_CONFLICT', '已有回执与该操作引用不一致。')
      }
      const result: OwnerOperationReceipt = { type: payload.type, operationId: payload.operationId, prepareId: payload.prepareId,
        decisionId: payload.decisionId, kingdomId: payload.kingdomId, ownerId: payload.ownerId, action: payload.action,
        inputHash: payload.inputHash, status: payload.status, target: payload.target, receiptSeq: row.seq, appliedAt: payload.appliedAt, message: payload.message }
      return clone(result)
    }
    return null
  }

  revoke(handle: OwnerDecisionHandle): OwnerDecisionView {
    const record = this.decisions.get(handle)
    if (!record) fail('OWNER_DECISION_REQUIRED', '管理窗口无效。')
    this.expire(record)
    const wasActive = record.view.state === 'ACTIVE'
    this.invalidate(record, 'REVOKED')
    if (wasActive && record.view.kingdomId && record.view.ownerId) {
      this.event(record.view.kingdomId, record.view.ownerId, 'OWNER_DECISION_REVOKED', record.view.decisionId,
        ownerEventPayload('revoke', { decision_id: record.view.decisionId }, { source_channel: 'LOCAL_OWNER_GUI', authorization_source: 'LOCAL_DIRECT_SLASH' }))
    }
    return clone(record.view)
  }

  dispose(): void {
    this.disposed = true
    for (const record of this.decisions.values()) this.invalidate(record, 'REVOKED')
  }

  private expire(record: DecisionRecord): void {
    if (this.now() >= Date.parse(record.view.expiresAt)) this.invalidate(record, 'EXPIRED')
  }
  private invalidate(record: DecisionRecord, state: 'EXPIRED' | 'REVOKED' | 'CONSUMED'): void {
    if (record.view.state !== 'ACTIVE') return
    record.view.state = state
    clearTimeout(record.timer)
    record.abort.abort(new OwnerOperationError(`OWNER_DECISION_${state}`, '管理窗口已失效。'))
  }
  private active(handle: OwnerDecisionHandle): DecisionRecord {
    const record = this.decisions.get(handle)
    if (!record) fail('OWNER_DECISION_REQUIRED', '管理窗口无效。')
    this.assertActive(record)
    return record
  }
  private assertActive(record: DecisionRecord): void {
    this.expire(record)
    if (this.disposed || record.view.state !== 'ACTIVE') fail(`OWNER_DECISION_${record.view.state}`, '管理窗口已到期、撤销或消费。')
    const kingdom = this.store.getDefaultKingdom()
    if (record.view.kingdomId === null ? !!kingdom : !kingdom || kingdom.kingdom_id !== record.view.kingdomId || kingdom.owner_id !== record.view.ownerId) {
      fail('KINGDOM_MISMATCH', '当前王国事实已改变。')
    }
  }

  private async observe<T>(record: DecisionRecord, request: AbortSignal | undefined, callback: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertActive(record)
    const abort = new AbortController()
    const signals = [record.abort.signal, ...(request ? [request] : [])]
    const listeners = signals.map(signal => {
      const listener = () => abort.abort(signal.reason ?? new OwnerOperationError('REQUEST_ABORTED', '请求已取消。'))
      if (signal.aborted) listener()
      else signal.addEventListener('abort', listener, { once: true })
      return { signal, listener }
    })
    const timer = setTimeout(() => abort.abort(new OwnerOperationError('VALIDATION_TIMEOUT', '运行环境校验超时。')), this.timeout)
    let onAbort: (() => void) | undefined
    try {
      if (abort.signal.aborted) fail('REQUEST_ABORTED', '请求或窗口已取消。')
      const interrupted = new Promise<never>((_, reject) => {
        onAbort = () => reject(abort.signal.reason instanceof OwnerOperationError ? abort.signal.reason : new OwnerOperationError('REQUEST_ABORTED', '请求已取消。'))
        abort.signal.addEventListener('abort', onAbort, { once: true })
      })
      const result = await Promise.race([Promise.resolve().then(() => callback(abort.signal)), interrupted])
      this.assertActive(record)
      if (abort.signal.aborted) fail('REQUEST_ABORTED', '请求已取消。')
      return result
    } catch (error) {
      if (error instanceof OwnerOperationError) throw error
      return fail('VALIDATION_UNAVAILABLE', '运行环境校验不可用。')
    } finally {
      clearTimeout(timer)
      if (onAbort) abort.signal.removeEventListener('abort', onAbort)
      for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener)
    }
  }

  private async validate(record: DecisionRecord, input: OwnerOperationInput, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) fail('REQUEST_ABORTED', '请求已取消。')
    const kingdomId = record.view.kingdomId!
    let result: OwnerValidationResult = { ok: true }
    if (input.action === 'role.bind' && input.parameters.role_type !== 'WORKER') {
      const p = input.parameters
      result = await this.observe(record, signal, signal => this.options.validateTargetSession({ kingdomId,
        roleType: p.role_type as 'CHANCELLOR' | 'SUPERVISOR', bindingId: null, sessionId: p.session_id!, signal }))
    } else if (input.action === 'role.session') {
      const p = input.parameters
      const binding = this.store.getBindingById(p.binding_id)!
      result = await this.observe(record, signal, signal => this.options.validateTargetSession({ kingdomId,
        roleType: binding.role_type as 'CHANCELLOR' | 'SUPERVISOR', bindingId: p.binding_id, sessionId: p.session_id, signal }))
    } else if (input.action === 'execution-profile') {
      const p = input.parameters
      const binding = this.store.getBindingById(p.binding_id)!
      result = await this.observe(record, signal, signal => this.options.validateExecutionProfile({ kingdomId,
        roleType: binding.role_type as OwnerManagedRole, bindingId: p.binding_id, profile: p.profile === null ? null : Object.freeze({ ...p.profile }), signal }))
    }
    this.assertActive(record)
    if (signal?.aborted) fail('REQUEST_ABORTED', '请求已取消。')
    if (!result || result.ok !== true) fail(result?.ok === false ? result.code : 'VALIDATION_UNAVAILABLE', result?.ok === false ? result.message : '运行环境未提供有效校验结果。')
  }

  private context(record: DecisionRecord, input: OwnerOperationInput): OperationContext {
    this.assertActive(record)
    if (!record.view.actions.includes(input.action)) fail('SCOPE_DENIED', '该动作未获本次授权。')
    const kingdomId = record.view.kingdomId
    const scope = record.view.scope
    const territories = new Set<string>(), bindings = new Set<string>(), sessions = new Set<string>()
    const facts: unknown[] = []
    let before: string | null = null, after: string | null = null, summary = ''
    const territory = (id: string): TerritoryRow => {
      const row = this.store.getTerritoryById(id)
      if (!row || row.kingdom_id !== kingdomId || row.status === 'DELETED' || !scope.territoryIds.includes(id)) fail('SCOPE_DENIED', '领地不在授权范围内或不可用。')
      territories.add(id); facts.push(row); return row
    }
    const binding = (id: string): RoleBindingRow => {
      const row = this.store.getBindingById(id)
      if (!row || row.kingdom_id !== kingdomId || row.status !== 'ACTIVE' || !scope.bindingIds.includes(id)
        || !scope.roleTypes.includes(row.role_type as OwnerManagedRole) || !MANAGED_ROLES.includes(row.role_type)) fail('SCOPE_DENIED', '绑定不在授权范围内或不可用。')
      bindings.add(id); facts.push(row); if (row.session_id) sessions.add(row.session_id); return row
    }
    const targetSession = (id: string, bindingId: string | null): void => {
      if (!scope.targetSessionIds.includes(id)) fail('SCOPE_DENIED', '目标 Session 不在授权范围内。')
      sessions.add(id)
      const occupants = this.store.listBindings(kingdomId!).filter(row => row.status === 'ACTIVE' && row.session_id === id && row.binding_id !== bindingId)
      facts.push(occupants)
      if (occupants.length) fail('SESSION_ALREADY_BOUND', '目标 Session 已属于其他活跃角色。')
    }
    const affectedBindingTerritories = (row: RoleBindingRow): void => {
      const related = this.store.listTerritories(kingdomId!).filter(t => t.supervisor_binding_id === row.binding_id)
      for (const t of related) territory(t.territory_id)
      if (row.role_type === 'WORKER') {
        if (this.store.isSchemaV4) {
          const affinities = this.store.listAffinities(kingdomId!).filter(a => a.worker_binding_id === row.binding_id && a.is_current === 1)
          facts.push(affinities)
          for (const affinity of affinities) { territory(affinity.territory_id); sessions.add(affinity.session_ref) }
        }
        for (const task of this.store.listTasks(kingdomId!)) {
          if (task.assigned_binding_id === row.binding_id && !['DONE', 'FAILED'].includes(task.status)) territory(task.territory_id)
        }
      }
      facts.push(related.map(t => t.territory_id).sort())
    }
    switch (input.action) {
      case 'plan.adopt': {
        const p = input.parameters, plan = readCollaborationPlan(this.store, kingdomId!, p.plan_id)
        if (!plan || plan.version !== p.version || plan.digest !== p.digest || plan.state !== 'PROPOSED') fail('PLAN_VERSION_STALE', '计划已变化、已采纳或不可采纳，请重新打开计划。')
        const parent = this.store.getTask(plan.parentTaskId)
        if (!parent || parent.status !== 'CREATED') fail('PLAN_CONTEXT_STALE', '父任务已变化，请重新提案。')
        territory(parent.territory_id); binding(plan.integratorBindingId)
        for (const item of plan.items) { territory(item.territoryId); binding(item.workerBindingId) }
        facts.push(plan, parent)
        after = JSON.stringify(plan); summary = '采纳这份协作计划（创建子项；授权、执行和验收仍由合法主管完成）'; break
      }
      case 'budget.policy': {
        if (!scope.kingdomWide) fail('SCOPE_DENIED', '预算政策需要王国级授权。')
        if (!this.store.isSchemaV4) fail('SCHEMA_V4_REQUIRED', '当前数据库不支持 governed 预算；不会自动迁移。')
        const previous = readBudgetPolicy(this.store, kingdomId!)
        facts.push(previous)
        before = previous ? JSON.stringify(previous) : null
        after = JSON.stringify(input.parameters)
        summary = '更新后续工作的软预算（已接纳工作继续，统计起点不重置）'; break
      }
      case 'init':
        if (kingdomId !== null || this.store.getDefaultKingdom()) fail('BOOTSTRAP_ONLY', '初始化只能用于空库。')
        after = JSON.stringify(input.parameters); summary = '初始化王国及常驻 Owner'; break
      case 'territory.create': {
        const p = input.parameters
        const path = directory(p.workspace_path)
        if (path !== p.workspace_path || !scope.workspaceRoots.some(root => directory(root) === root && within(path, root))) fail('SCOPE_DENIED', '工作目录超出已授权根或路径已变化。')
        const existing = this.store.getTerritoryByName(kingdomId!, p.name)
        facts.push(existing)
        if (existing) fail('NAME_CONFLICT', '该领地名称已存在。')
        after = JSON.stringify(p); summary = '创建领地'; break
      }
      case 'territory.update': {
        const p = input.parameters, row = territory(p.territory_id)
        const name = p.name ?? row.name
        const existing = this.store.getTerritoryByName(kingdomId!, name)
        facts.push(existing)
        if (existing && existing.territory_id !== row.territory_id) fail('NAME_CONFLICT', '该领地名称已存在。')
        before = JSON.stringify({ name: row.name, summary: row.summary })
        after = JSON.stringify({ name, summary: p.summary === undefined ? row.summary : p.summary }); summary = '更新领地名称和说明'; break
      }
      case 'territory.supervisor': {
        const p = input.parameters, row = territory(p.territory_id), supervisor = binding(p.supervisor_binding_id)
        if (supervisor.role_type !== 'SUPERVISOR') fail('INVALID_ROLE', '目标必须是活跃主管。')
        if (row.supervisor_binding_id) {
          // The previous relationship is historical input, not a request to edit
          // or re-authorize a retired role. Its old session still participates in
          // unsettled-work guards, even when the old binding is outside the new-write scope.
          const previous = this.store.getBindingById(row.supervisor_binding_id)
          if (previous && previous.kingdom_id !== kingdomId) fail('RELATED_BINDING_UNAVAILABLE', '旧主管引用不属于当前王国，无法安全修改责任。')
          facts.push({ previousSupervisor: previous, previousSupervisorId: row.supervisor_binding_id })
          bindings.add(row.supervisor_binding_id)
          if (previous?.session_id) sessions.add(previous.session_id)
        }
        before = row.supervisor_binding_id; after = supervisor.binding_id; summary = '更新领地主理主管'; break
      }
      case 'role.bind': {
        const p = input.parameters
        if (!scope.roleTypes.includes(p.role_type)) fail('SCOPE_DENIED', '该角色不在授权范围内。')
        if (p.role_type === 'CHANCELLOR') {
          const existing = this.store.getBindingByRole(kingdomId!, p.role_type)
          facts.push(existing)
          if (existing) fail('ROLE_ALREADY_BOUND', '宰相席位已有活跃绑定。')
        }
        if (p.session_id) targetSession(p.session_id, null)
        after = JSON.stringify(p); summary = '任命角色'; break
      }
      case 'role.session': {
        const p = input.parameters, row = binding(p.binding_id)
        if (!['CHANCELLOR', 'SUPERVISOR'].includes(row.role_type)) fail('WORKER_SESSION_UNSUPPORTED', '只允许改绑主管或宰相；执行者 affinity 不由此迁移。')
        affectedBindingTerritories(row)
        targetSession(p.session_id, row.binding_id)
        before = row.session_id; after = p.session_id; summary = '改绑角色 Session'; break
      }
      case 'ceiling':
        if (!scope.kingdomWide) fail('SCOPE_DENIED', '权限上限需要王国级授权。')
        if (!this.store.isSchemaV4) fail('SCHEMA_V4_REQUIRED', '当前数据库不支持权限上限；此操作不会自动迁移。')
        before = this.store.getKingdomCapabilityCeiling(kingdomId!); after = JSON.stringify(input.parameters.ceiling)
        facts.push(before); summary = '更新王国权限上限（下一次执行生效）'; break
      case 'execution-profile': {
        const p = input.parameters, row = binding(p.binding_id)
        affectedBindingTerritories(row)
        before = row.execution_profile_json; after = p.profile === null ? null : JSON.stringify(p.profile)
        summary = '更新 requested 执行配置（不代表实际运行成功）'; break
      }
    }
    const context: OperationContext = { territoryIds: [...territories].sort(), bindingIds: [...bindings].sort(), sessionIds: [...sessions].sort(),
      fingerprint: ownerInputHash(facts), before, after, summary }
    if (kingdomId && input.action !== 'territory.update' && input.action !== 'territory.create' && input.action !== 'budget.policy' && input.action !== 'plan.adopt') this.guardUnsettled(kingdomId, input.action === 'ceiling', context)
    return context
  }

  private guardUnsettled(kingdomId: string, all: boolean, context: OperationContext): void {
    const affected = (territoryId: string | null, bindingId: string | null, sessionId: string | null): boolean => all
      || !!territoryId && context.territoryIds.includes(territoryId)
      || !!bindingId && context.bindingIds.includes(bindingId)
      || !!sessionId && context.sessionIds.includes(sessionId)
    for (const execution of this.store.listUnsettledOwnerExecutions(kingdomId)) {
      const task = this.store.getTask(execution.task_id)
      if (affected(task?.territory_id ?? null, execution.worker_binding_id, execution.session_id)) fail('UNSETTLED_EXECUTION', '影响范围内存在未结算执行，暂不能变更配置或责任。')
    }
    if (this.store.isSchemaV4) {
      const leases = this.store.listLeases(kingdomId)
      for (const lease of leases) {
        if (lease.state !== 'RELEASED' && affected(lease.territory_id, lease.worker_binding_id, lease.session_ref)) fail('UNSETTLED_LEASE', '影响范围内存在未释放 Lease，暂不能变更。')
      }
      for (const dispatch of this.store.listDispatches(kingdomId)) {
        if (['TERMINAL', 'FAILED'].includes(dispatch.state)) continue
        const lease = leases.find(row => row.lease_id === dispatch.lease_id)
        const task = this.store.getTask(dispatch.task_id)
        if (affected(lease?.territory_id ?? task?.territory_id ?? null, lease?.worker_binding_id ?? null, dispatch.session_ref)) fail('UNSETTLED_DISPATCH', '影响范围内存在未结算派发。')
      }
    }
  }

  private changes(input: OwnerOperationInput, context: OperationContext): OwnerOperationPreview['changes'] {
    const change = (label: string, before: string | null | undefined, after: string | null | undefined) => ({ label, before: before ?? null, after: after ?? null })
    switch (input.action) {
      case 'plan.adopt': {
        const plan = JSON.parse(context.after!) as CollaborationPlanView
        const worker = (id: string) => `${this.store.getBindingById(id)?.role_name ?? '执行者'}（${id}）`
        return [change('计划版本与内容摘要', null, `${plan.planId} / v${plan.version} / ${plan.digest}`),
          change('父任务', null, this.store.getTask(plan.parentTaskId)?.title),
          change('拆分理由', null, plan.reason), change('协作方式', null, plan.mode === 'EXPERT' ? '主执行者与只读专家' : '独立工作项小团队'),
          change('主整合者', null, worker(plan.integratorBindingId)), change('整项 Token 软预算', null, String(plan.budgetTokens)),
          change('每次工作估计预留', null, String(plan.reserveTokens)),
          ...plan.items.flatMap((item, i) => [change(`子项 ${i + 1}：${item.title}`, null, item.description),
            change(`子项 ${i + 1} 负责人及范围`, null, `${worker(item.workerBindingId)}；${this.store.getTerritoryById(item.territoryId)?.name}；${item.access === 'READ_ONLY' ? '只读' : '工作区写入独占'}`),
            change(`子项 ${i + 1} 验收`, null, item.acceptanceCriteria), change(`子项 ${i + 1} 前置依赖`, null, item.dependsOn.join('、') || '无'),
            change(`子项 ${i + 1} 预期产物`, null, item.expectedArtifact)])]
      }
      case 'budget.policy': {
        const previous = context.before ? JSON.parse(context.before) as ReturnType<typeof readBudgetPolicy> : null
        const p = input.parameters
        return [change('限制新增接纳', previous?.enabled ? '开启' : '关闭', p.enabled ? '开启' : '关闭'),
          change('Token 软预算', previous ? String(previous.limitTokens) : null, String(p.limit_tokens)),
          change('每次工作估计预留', previous ? String(previous.reserveTokens) : null, String(p.reserve_tokens)),
          change('用量未确认时', previous ? previous.unknownPolicy === 'BLOCK' ? '阻止新增接纳' : '告警并继续' : null, p.unknown_policy === 'BLOCK' ? '阻止新增接纳' : '告警并继续'),
          change('告警比例', previous ? `${previous.warningPercent}%` : null, `${p.warning_percent ?? 80}%`)]
      }
      case 'init': return [change('王国名称', null, input.parameters.kingdom_name), change('Owner 显示名', null, input.parameters.owner_name)]
      case 'territory.create': return [change('领地名称', null, input.parameters.name), change('本机工作目录', null, input.parameters.workspace_path), change('领地说明', null, input.parameters.summary)]
      case 'territory.update': {
        const before = JSON.parse(context.before!) as { name: string; summary: string | null }
        const after = JSON.parse(context.after!) as { name: string; summary: string | null }
        return [...(input.parameters.name !== undefined ? [change('领地名称', before.name, after.name)] : []),
          ...(input.parameters.summary !== undefined ? [change('领地说明', before.summary, after.summary)] : [])]
      }
      case 'territory.supervisor': {
        const describe = (id: string | null) => id ? `${this.store.getBindingById(id)?.role_name ?? '主管'}（${id}）` : null
        return [change('主理主管', describe(context.before), describe(context.after))]
      }
      case 'role.bind': return [change('角色身份', null, { CHANCELLOR: '宰相', SUPERVISOR: '主管', WORKER: '执行者' }[input.parameters.role_type]),
        change('角色名称', null, input.parameters.role_name), change('目标 Session', null, input.parameters.session_id)]
      case 'role.session': return [change('角色 Session', context.before, context.after)]
      case 'ceiling': {
        const before = context.before ? JSON.parse(context.before) as Record<string, boolean> : {}
        const after = input.parameters.ceiling
        const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
        if (!keys.length) return [change('王国权限上限', context.before === null ? null : '未允许任何能力', '未允许任何能力')]
        const permission = (value: boolean | undefined) => value === undefined ? '未配置（不授予）' : value ? '允许' : '禁止'
        return keys.map(key => change(`能力 ${key}`, permission(before[key]), permission(after[key])))
      }
      case 'execution-profile': {
        const before = context.before ? JSON.parse(context.before) as ExecutionProfileV1 : null
        const after = input.parameters.profile
        return [change('请求的 Provider', before?.provider, after?.provider), change('请求的模型', before?.model, after?.model)]
      }
    }
  }

  private async apply(handle: OwnerDecisionHandle, record: DecisionRecord, preparation: Preparation, signal?: AbortSignal): Promise<OwnerOperationReceipt> {
    this.active(handle)
    const context = this.context(record, preparation.input)
    if (context.fingerprint !== preparation.fingerprint) fail('PREVIEW_STALE', '相关对象已变化，请重新预览。')
    await this.validate(record, preparation.input, signal)
    this.active(handle)
    if (signal?.aborted) fail('REQUEST_ABORTED', '请求已取消。')
    const result = this.store.withImmediateTransaction(() => {
      this.active(handle)
      const current = this.context(record, preparation.input)
      if (current.fingerprint !== preparation.fingerprint || ownerInputHash(preparation.input) !== preparation.inputHash) fail('PREVIEW_STALE', '相关事实或准备内容已变化，请重新预览。')
      const source: OwnerEventSource = { source_channel: 'LOCAL_OWNER_GUI', authorization_source: 'LOCAL_DIRECT_SLASH',
        decision_id: record.view.decisionId, operation_id: preparation.preview.operationId }
      let kingdomId = record.view.kingdomId!, ownerId = record.view.ownerId!, target: OwnerOperationReceipt['target'], message: string
      if (preparation.input.action === 'init') {
        const p = preparation.input.parameters
        const initialized = initializeKingdomFacts(this.store, p.kingdom_name, p.owner_name, source)
        kingdomId = initialized.kingdomId; ownerId = initialized.ownerId; target = { type: 'kingdom', id: kingdomId }; message = initialized.detail
        this.event(kingdomId, ownerId, 'OWNER_DECISION_CONSUMED', record.view.decisionId, { decision: { ...record.view, state: 'CONSUMED' }, ...source })
      } else {
        const dispatched = this.mutate(record, preparation.input, source)
        target = dispatched.target; message = dispatched.message
      }
      const eventId = this.receiptEventId(kingdomId, preparation.preview.operationId)
      if (this.store.getEventById(eventId)) fail('OPERATION_REPLAY_CONFLICT', '操作回执已存在，请查询已有结果。')
      const appliedAt = new Date(this.now()).toISOString()
      const receipt: OwnerOperationReceipt = { type: 'KingdomOwnerOperationReceipt/v1', operationId: preparation.preview.operationId,
        prepareId: preparation.preview.prepareId, decisionId: record.view.decisionId, kingdomId, ownerId, action: preparation.input.action,
        inputHash: preparation.inputHash, status: 'APPLIED', target, receiptSeq: this.store.eventSequence() + 1, appliedAt, message }
      const row = this.store.appendEvent({ event_id: eventId, kingdom_id: kingdomId, event_type: 'OWNER_OPERATION_APPLIED',
        actor_role: 'OWNER', actor_id: ownerId, target_type: target.type, target_id: target.id,
        payload_json: JSON.stringify({ ...receipt, ...source }), created_at: appliedAt })
      receipt.receiptSeq = row.seq
      return receipt
    })
    preparation.receipt = result
    if (preparation.input.action === 'init') this.invalidate(record, 'CONSUMED')
    return result
  }

  /** Synchronous closed dispatcher: no callback or transport receives an administration capability. */
  private mutate(record: DecisionRecord, input: Exclude<OwnerOperationInput, { action: 'init' }>, source: OwnerEventSource): { target: OwnerOperationReceipt['target']; message: string } {
    const kingdomId = record.view.kingdomId!
    const beforeSeq = this.store.revision(kingdomId)
    const run = <T>(parameters: T, mutation: (store: KingdomStore, parameters: T, auth: AdminAuth) => string): string => {
      const capability = issueOwnerOperationCapability(record.authority, this.store, kingdomId, { operation: input.action, input: parameters }, source)
      try { return mutation(this.store, parameters, { mode: 'session-bound', ownerControl: capability }) }
      finally { revokeOwnerOperationCapability(capability) }
    }
    let message: string, eventType: string
    switch (input.action) {
      case 'plan.adopt':
        message = run({ kingdomId, ...input.parameters }, adoptCollaborationPlan)
        eventType = 'COLLABORATION_PLAN_ADOPTED'; break
      case 'budget.policy':
        message = run({ kingdomId, policy: input.parameters }, setBudgetPolicy)
        eventType = 'BUDGET_POLICY_UPDATED'; break
      case 'territory.create': {
        const p = input.parameters
        message = run({ kingdomId, name: p.name, workspacePath: p.workspace_path, summary: p.summary ?? undefined }, createTerritory)
        eventType = 'TERRITORY_CREATED'; break
      }
      case 'territory.update': {
        const p = input.parameters
        message = run({ kingdomId, territoryId: p.territory_id, name: p.name, summary: p.summary }, updateTerritory)
        eventType = 'TERRITORY_UPDATED'; break
      }
      case 'territory.supervisor': {
        const p = input.parameters
        message = run({ kingdomId, territoryId: p.territory_id, supervisorBindingId: p.supervisor_binding_id }, setTerritorySupervisor)
        eventType = 'TERRITORY_SUPERVISOR_UPDATED'; break
      }
      case 'role.bind': {
        const p = input.parameters
        message = run({ kingdomId, roleType: p.role_type, roleName: p.role_name, sessionId: p.session_id }, bindRole)
        eventType = 'ROLE_BOUND'; break
      }
      case 'role.session': {
        const p = input.parameters
        message = run({ kingdomId, bindingId: p.binding_id, sessionId: p.session_id }, rebindSession)
        eventType = 'BINDING_PROFILE_UPDATED'; break
      }
      case 'ceiling':
        run({ kingdomId, ceilingJson: JSON.stringify(input.parameters.ceiling) }, setCapabilityCeiling)
        message = '王国权限上限已保存；将用于后续执行，不改变已开始的工作。'
        eventType = 'CAPABILITY_CEILING_UPDATED'; break
      case 'execution-profile':
        run({ kingdomId, bindingId: input.parameters.binding_id, profile: input.parameters.profile }, setExecutionProfile)
        message = '请求的执行配置已保存；这不代表模型已实际运行成功。'
        eventType = 'EXECUTION_PROFILE_UPDATED'; break
    }
    const events = this.store.listEventsSince(kingdomId, beforeSeq, 20)
    const business = events.filter(event => event.event_type === eventType && event.actor_role === 'OWNER' && event.actor_id === record.view.ownerId
      && JSON.parse(event.payload_json).operation_id === source.operation_id)
    if (business.length !== 1 || !business[0].target_id || !['kingdom', 'territory', 'binding', 'collaboration-plan'].includes(business[0].target_type ?? '')) {
      fail('MUTATION_NOT_APPLIED', 'Core 未产生准确业务事实，事务已回滚。')
    }
    return { target: { type: business[0].target_type as OwnerOperationReceipt['target']['type'], id: business[0].target_id }, message }
  }

  private event(kingdomId: string, ownerId: string, type: string, targetId: string, payload: Record<string, unknown>): EventRow {
    return this.store.appendEvent({ event_id: randomUUID(), kingdom_id: kingdomId, event_type: type, actor_role: 'OWNER', actor_id: ownerId,
      target_type: 'owner-decision', target_id: targetId, payload_json: JSON.stringify(payload), created_at: new Date(this.now()).toISOString() })
  }

  private receiptEventId(kingdomId: string, operationId: string): string {
    return `owner-operation-receipt:${createHash('sha256').update(`${kingdomId}\0${operationId}`).digest('hex')}`
  }
}
