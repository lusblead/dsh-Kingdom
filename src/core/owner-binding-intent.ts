/**
 * Pure natural-language -> Owner binding intent Draft.
 *
 * This module deliberately has no KingdomStore, filesystem, event, runtime, or
 * capability dependency.  A caller may provide an exact target_session_ref,
 * but that value is only a target reference; it never becomes Owner authority.
 */

export const DIRECT_SLASH_CONFIRM_REQUIRED = 'DIRECT_SLASH_CONFIRM_REQUIRED' as const

export type IntentRoleType = 'CHANCELLOR' | 'SUPERVISOR' | 'WORKER'
export type ParsedRoleType = IntentRoleType | 'OWNER'

export type TargetSessionClassification =
  | 'ACTIVE'
  | 'FOREIGN'
  | 'EXPIRED'
  | 'ABORTED'
  | 'MULTIPLE'
  | 'ABSENT'
  | 'UNKNOWN'

/** @deprecated Use TargetSessionClassification for the explicit seam. */
export type TargetSessionState = TargetSessionClassification | 'MISSING'

export type RejectedOwnerBindingOperation =
  | 'kingdom_bind_role'
  | 'kingdom_bind_session'
  | 'role.bind'
  | 'role.session'

export interface StructuredOwnerBindingRejection {
  code: string
  operation: RejectedOwnerBindingOperation
  request?: {
    role_type?: string | null
    role_name?: string | null
    session_id?: string | null
    binding_id?: string | null
    territory_id?: string | null
  }
  context?: OwnerBindingIntentContext
}

export interface OwnerBindingStepPolicy {
  failure: 'STOP_NO_AGENT_RETRY_OR_COMPENSATION'
}

export interface RoleBindDraftStep {
  step_id: 'ROLE_BIND'
  kind: 'role.bind'
  args: RoleBindDraftOperation['args']
  canonical_direct_slash: string
  canonical_direct_slash_template: null
  depends_on: readonly []
  confirmation: typeof DIRECT_SLASH_CONFIRM_REQUIRED
  policy: OwnerBindingStepPolicy
}

export interface RoleSessionDraftStep {
  step_id: 'ROLE_SESSION'
  kind: 'role.session'
  args: RoleSessionDraftOperation['args']
  canonical_direct_slash: string
  canonical_direct_slash_template: null
  depends_on: readonly []
  confirmation: typeof DIRECT_SLASH_CONFIRM_REQUIRED
  policy: OwnerBindingStepPolicy
}

export interface TerritorySupervisorDraftStep {
  step_id: 'TERRITORY_SUPERVISOR'
  kind: 'territory.supervisor'
  args: {
    territory_id: string
    supervisor_binding_id_ref: string
  }
  canonical_direct_slash: string | null
  canonical_direct_slash_template: string | null
  depends_on: readonly string[]
  confirmation: typeof DIRECT_SLASH_CONFIRM_REQUIRED
  policy: OwnerBindingStepPolicy
}

export type CanonicalDraftStep = RoleBindDraftStep | RoleSessionDraftStep | TerritorySupervisorDraftStep

export interface TargetSessionCandidate {
  session_ref: string
  status?: TargetSessionState
  kingdom_id?: string | null
}

export interface BindingSnapshot {
  binding_id: string
  role_type: string
  role_name?: string | null
  session_id?: string | null
  status?: 'ACTIVE' | 'RETIRED' | 'DELETED' | 'EXPIRED' | string
  kingdom_id?: string | null
}

export interface TerritorySnapshot {
  territory_id: string
  name: string
  aliases?: readonly string[]
  status?: 'ACTIVE' | 'DELETED' | 'EXPIRED' | string
  kingdom_id?: string | null
  supervisor_binding_id?: string | null
}

/**
 * The only session input accepted for “当前会话/这个会话/该会话” is the
 * exact target_session_ref supplied by the invocation context.  The optional
 * resolution fields let an adapter report foreign, expired, or multi-match
 * context without making this pure module inspect a runtime or database.
 */
export interface OwnerBindingIntentContext {
  target_session_ref?: string | null
  /**
   * Trusted adapter proof seam. ACTIVE is valid only after the adapter proves
   * current initiator + agents.get/session.get object identity + matching ids
   * + running + non-aborted signal; absent or failed proof never becomes ACTIVE.
   */
  target_session_classification?: TargetSessionClassification
  /**
   * Legacy compatibility hint only. It is intentionally not an authority or
   * liveness proof; callers must migrate to target_session_classification.
   */
  target_session_state?: TargetSessionState
  target_session_matches?: readonly string[]
  target_session_candidates?: readonly TargetSessionCandidate[]
  kingdom_id?: string | null
  role_bindings?: readonly BindingSnapshot[]
  territories?: readonly TerritorySnapshot[]
}

export interface OwnerBindingIntentInput {
  text: string
  context?: OwnerBindingIntentContext
}

export type IntentAmbiguityCode =
  | 'UNSUPPORTED_INPUT'
  | 'REJECTION_UNSUPPORTED'
  | 'OWNER_ROLE_DIRECT_ONLY'
  | 'SESSION_MISSING'
  | 'SESSION_FOREIGN'
  | 'SESSION_EXPIRED'
  | 'SESSION_MULTIPLE'
  | 'SESSION_UNRESOLVED'
  | 'ROLE_MULTIPLE'
  | 'ROLE_FOREIGN'
  | 'ROLE_BINDING_UNSAFE'
  | 'TERRITORY_REQUIRED'
  | 'TERRITORY_NOT_FOUND'
  | 'TERRITORY_FOREIGN'
  | 'TERRITORY_UNAVAILABLE'
  | 'TERRITORY_MULTIPLE'
  | 'TERRITORY_UNRESOLVED'

export interface DraftAmbiguity {
  code: IntentAmbiguityCode
  question: string
}

export interface DraftIntent {
  role_type: ParsedRoleType | null
  role_alias: string | null
  target: 'CALL_CONTEXT_TARGET_SESSION' | null
  target_session_ref: string | null
  territory: { territory_id: string; name: string } | null
}

export interface RoleBindDraftOperation {
  kind: 'role.bind'
  args: {
    role_type: IntentRoleType
    role_name: string
    session_id: string
    /**
     * v3.2.0：主管的任命必须同时给出领地，且席位与主理在同一事务里一次写完。
     * 因此主管 Draft 是**单步** `role.bind`（带 territory_id），不再有第二步 territory.supervisor。
     */
    territory_id?: string
  }
}

export interface RoleSessionDraftOperation {
  kind: 'role.session'
  args: {
    binding_id: string
    session_id: string
  }
}

export type DraftOperation = RoleBindDraftOperation | RoleSessionDraftOperation

export interface AffectedSupervisorTerritorySnapshot {
  territory_id: string
  name: string
  supervisor_binding_id: string
  status: string | null
  kingdom_id: string | null
}

export interface OwnerBindingIntentDraft {
  kind: 'OWNER_BINDING_INTENT_DRAFT'
  status: 'DRAFT_READY' | 'AMBIGUOUS'
  /** Natural language never supplies an Owner principal or capability. */
  authority_source: 'NONE'
  owner_authority: false
  write_effect: 'ZERO_WRITE'
  normalized_input: string
  intent: DraftIntent
  operation: DraftOperation | null
  steps: readonly CanonicalDraftStep[]
  /** Alias kept for integrations that name the collection explicitly. */
  canonical_steps: readonly CanonicalDraftStep[]
  policy: OwnerBindingStepPolicy
  canonical_direct_slash: string | null
  confirmation: typeof DIRECT_SLASH_CONFIRM_REQUIRED | null
  ambiguity: DraftAmbiguity | null
  /** Read-only scope snapshot for a seat-wide session change; never authorization. */
  affected_territories?: readonly AffectedSupervisorTerritorySnapshot[]
}

interface ParsedLanguage {
  role_type: ParsedRoleType
  role_alias: string
  territory_query: string | null
  /** New conversation guidance uses an exact territory name, never a fuzzy suffix match. */
  territory_exact?: boolean
}

interface ResolutionFailure {
  ok: false
  code: IntentAmbiguityCode
  question: string
}

interface SessionResolution {
  ok: true
  session_ref: string
}

interface TerritoryResolution {
  ok: true
  territory: { territory_id: string; name: string }
  supervisor_binding_id: string | null
}

interface ExactBindingResolution {
  ok: true
  role_type: ParsedRoleType
  binding: BindingSnapshot
}

interface RoleAlias {
  role_type: ParsedRoleType
  alias: string
}

const ROLE_ALIASES: readonly RoleAlias[] = [
  { role_type: 'CHANCELLOR', alias: '宰相' },
  { role_type: 'CHANCELLOR', alias: '丞相' },
  { role_type: 'CHANCELLOR', alias: '首相' },
  { role_type: 'CHANCELLOR', alias: 'chancellor' },
  { role_type: 'SUPERVISOR', alias: '领地主管' },
  { role_type: 'SUPERVISOR', alias: '辖区主管' },
  { role_type: 'SUPERVISOR', alias: '监督者' },
  { role_type: 'SUPERVISOR', alias: 'supervisor' },
  { role_type: 'SUPERVISOR', alias: '主管' },
  { role_type: 'SUPERVISOR', alias: '主理' },
  { role_type: 'WORKER', alias: '执行者' },
  { role_type: 'WORKER', alias: '工人' },
  { role_type: 'WORKER', alias: '骑士' },
  { role_type: 'WORKER', alias: 'worker' },
  { role_type: 'OWNER', alias: '所有者' },
  { role_type: 'OWNER', alias: '拥有者' },
  { role_type: 'OWNER', alias: '主人' },
  { role_type: 'OWNER', alias: 'owner' },
]

const SUPERVISOR_ALIASES = ROLE_ALIASES
  .filter(item => item.role_type === 'SUPERVISOR')
  .map(item => item.alias)
  .sort((left, right) => right.length - left.length)

const ACTION_WORDS = [
  '设置为',
  '绑定为',
  '任命为',
  '担任',
  '成为',
  '改为',
  '设成',
  '设为',
  '作为',
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function normalizeInput(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

function withoutTerminalPunctuation(value: string): string {
  return value.replace(/[。！？!?]+$/gu, '').trim()
}

function isExactToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && !/[\s\u0000-\u001f\u007f]/u.test(value)
}

function roleAliasPattern(): string {
  return ROLE_ALIASES
    .map(item => item.alias)
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join('|')
}

function actionPattern(): string {
  return ACTION_WORDS.map(escapeRegExp).join('|')
}

function parseNaturalLanguage(value: string): ParsedLanguage | null {
  const normalized = withoutTerminalPunctuation(normalizeInput(value))
  const currentSession = '(?:当前|这个|该)\\s*会话'
  const replacement = normalized.match(new RegExp(`^(?:把|将)\\s*(.+?)(?:的)?(?:主管|主理)\\s*(?:换成|更换为|改为)\\s*${currentSession}$`, 'u'))
  if (replacement) return parsedExactSupervisorTerritory(replacement[1]!)
  const subject = normalized.match(/^(?:把|将|让)?(?:当前|这个|该)\s*会话(?:的)?(.*)$/u)
  if (!subject) return null

  const remainder = subject[1]!.trim()
  if (!remainder) return null

  const responsible = remainder.match(/^负责\s*(.+)$/u)
  if (responsible) return parsedExactSupervisorTerritory(responsible[1]!)
  const successor = remainder.match(/^接替\s*(.+?)(?:的)?(?:主管|主理)$/u)
  if (successor) return parsedExactSupervisorTerritory(successor[1]!)
  const appointed = remainder.match(/^(?:设置为|设为|绑定为|任命为)\s*(.+?)(?:的)?(?:主管|主理)$/u)
  if (appointed) return parsedExactSupervisorTerritory(appointed[1]!)

  // Supervisor is checked first because its territory tail is meaningful.
  const supervisorPattern = new RegExp(
    `^(?:${actionPattern()})?\\s*(?:角色\\s*)?(?:辖区\\s*)?(${SUPERVISOR_ALIASES.map(escapeRegExp).join('|')})(?:\\s*(?:负责|管理|统辖)?\\s*(.*))?$`,
    'iu',
  )
  const supervisor = remainder.match(supervisorPattern)
  if (supervisor) {
    return {
      role_type: 'SUPERVISOR',
      role_alias: supervisor[1]!,
      territory_query: supervisor[2]?.trim() || null,
    }
  }

  const genericPattern = new RegExp(
    `^(?:${actionPattern()})?\\s*(?:角色\\s*)?(${roleAliasPattern()})$`,
    'iu',
  )
  const generic = remainder.match(genericPattern)
  if (!generic) return null

  const alias = ROLE_ALIASES.find(item => item.alias.toLocaleLowerCase() === generic[1]!.toLocaleLowerCase())
  if (!alias) return null
  return { role_type: alias.role_type, role_alias: alias.alias, territory_query: null }
}

function parsedExactSupervisorTerritory(value: string): ParsedLanguage | null {
  let name = value.trim()
  const quoted = name.match(/^(?:「([^「」]+)」|“([^“”]+)”|"([^"]+)")$/u)
  if (quoted) name = quoted[1] ?? quoted[2] ?? quoted[3]!
  else if (/[「」“”"]/u.test(name)) return null
  if (!name || name.length > 2000) return null
  return { role_type: 'SUPERVISOR', role_alias: '主管', territory_query: name, territory_exact: true }
}

function ambiguityQuestion(code: IntentAmbiguityCode): string {
  switch (code) {
    case 'REJECTION_UNSUPPORTED':
      return '拒绝请求不是受支持的结构化 Owner 写入请求；请由 direct /kingdom Slash 明确确认。'
    case 'OWNER_ROLE_DIRECT_ONLY':
      return 'Owner 角色不能由自然语言或 Agent 代行；请直接使用 canonical /kingdom Owner Control。'
    case 'SESSION_MISSING':
      return '请由调用上下文提供唯一的 exact target_session_ref；自然语言本身不能指定会话。'
    case 'SESSION_FOREIGN':
      return '当前会话属于其他王国或不是本次调用目标，请确认唯一的本王国 target_session_ref。'
    case 'SESSION_EXPIRED':
      return '调用上下文中的 target_session_ref 已过期，请先取得新的活动会话引用。'
    case 'SESSION_MULTIPLE':
      return '调用上下文解析出多个会话，请明确唯一的 target_session_ref。'
    case 'SESSION_UNRESOLVED':
      return '无法证明 target_session_ref 当前有效，请重新提供可验证的唯一会话上下文。'
    case 'ROLE_MULTIPLE':
      return '发现多个同名单席角色绑定，请先由 Owner 明确唯一 binding_id。'
    case 'ROLE_FOREIGN':
      return '发现的角色绑定不属于当前王国，请确认本王国的角色上下文。'
    case 'ROLE_BINDING_UNSAFE':
      return '现有角色绑定引用不安全或不完整，请先取得可验证的 binding_id。'
    case 'TERRITORY_REQUIRED':
      return 'Supervisor 必须明确指定一个唯一辖区；请提供 Territory 名称。'
    case 'TERRITORY_NOT_FOUND':
      return '没有找到该 Territory，请提供当前王国中的准确辖区名称。'
    case 'TERRITORY_FOREIGN':
      return '该 Territory 不属于当前王国，请选择本王国的辖区。'
    case 'TERRITORY_UNAVAILABLE':
      return '该 Territory 已不可用，请选择仍处于 ACTIVE 状态的辖区。'
    case 'TERRITORY_MULTIPLE':
      return '该 Territory 名称对应多个辖区，请明确唯一的 territory_id。'
    case 'TERRITORY_UNRESOLVED':
      return '无法从调用上下文验证 Territory，请提供可验证的辖区快照。'
    case 'UNSUPPORTED_INPUT':
    default:
      return '未能安全识别角色意图；请说明“当前会话/这个会话 + 角色”，不要附加命令或权限字段。'
  }
}

function baseDraft(normalizedInput: string, intent: DraftIntent): OwnerBindingIntentDraft {
  return {
    kind: 'OWNER_BINDING_INTENT_DRAFT',
    status: 'AMBIGUOUS',
    authority_source: 'NONE',
    owner_authority: false,
    write_effect: 'ZERO_WRITE',
    normalized_input: normalizedInput,
    intent,
    operation: null,
    steps: [],
    canonical_steps: [],
    policy: { failure: 'STOP_NO_AGENT_RETRY_OR_COMPENSATION' },
    canonical_direct_slash: null,
    confirmation: null,
    ambiguity: null,
  }
}

function ambiguousDraft(
  normalizedInput: string,
  intent: DraftIntent,
  code: IntentAmbiguityCode,
): OwnerBindingIntentDraft {
  const draft = baseDraft(normalizedInput, intent)
  draft.ambiguity = { code, question: ambiguityQuestion(code) }
  return draft
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

function resolveTargetSession(context: OwnerBindingIntentContext): SessionResolution | ResolutionFailure {
  const target = context.target_session_ref
  if (!isExactToken(target)) return { ok: false, code: 'SESSION_MISSING', question: ambiguityQuestion('SESSION_MISSING') }

  // `target_session_state` predates the trusted seam and is deliberately not
  // accepted as proof. This keeps a caller that merely forwards a non-empty
  // runtime id fail-closed until it supplies an explicit classification.
  const explicitState = context.target_session_classification
  const state = explicitState?.toUpperCase()
  if (state === 'FOREIGN') return { ok: false, code: 'SESSION_FOREIGN', question: ambiguityQuestion('SESSION_FOREIGN') }
  if (state === 'EXPIRED') return { ok: false, code: 'SESSION_EXPIRED', question: ambiguityQuestion('SESSION_EXPIRED') }
  if (state === 'ABORTED') return { ok: false, code: 'SESSION_UNRESOLVED', question: ambiguityQuestion('SESSION_UNRESOLVED') }
  if (state === 'MULTIPLE') return { ok: false, code: 'SESSION_MULTIPLE', question: ambiguityQuestion('SESSION_MULTIPLE') }
  if (state === 'MISSING' || state === 'ABSENT') return { ok: false, code: 'SESSION_MISSING', question: ambiguityQuestion('SESSION_MISSING') }
  if (state === 'UNKNOWN') return { ok: false, code: 'SESSION_UNRESOLVED', question: ambiguityQuestion('SESSION_UNRESOLVED') }

  if (context.target_session_matches !== undefined) {
    if (context.target_session_matches.length === 0) return { ok: false, code: 'SESSION_MISSING', question: ambiguityQuestion('SESSION_MISSING') }
    if (context.target_session_matches.length !== 1) return { ok: false, code: 'SESSION_MULTIPLE', question: ambiguityQuestion('SESSION_MULTIPLE') }
    if (context.target_session_matches[0] !== target) return { ok: false, code: 'SESSION_FOREIGN', question: ambiguityQuestion('SESSION_FOREIGN') }
    if (state !== 'ACTIVE' && context.target_session_candidates === undefined) {
      return { ok: false, code: 'SESSION_UNRESOLVED', question: ambiguityQuestion('SESSION_UNRESOLVED') }
    }
  }

  // Candidate snapshots may explain a failed/unsafe resolution, but they are
  // not an ACTIVE proof. Only the explicit classification seam can carry the
  // resolver's trusted runtime conjunction into this pure module.
  if (context.target_session_candidates !== undefined) {
    if (context.target_session_candidates.length === 0) return { ok: false, code: 'SESSION_MISSING', question: ambiguityQuestion('SESSION_MISSING') }
    if (context.target_session_candidates.length !== 1) return { ok: false, code: 'SESSION_MULTIPLE', question: ambiguityQuestion('SESSION_MULTIPLE') }
    const candidate = context.target_session_candidates[0]!
    if (candidate.session_ref !== target) return { ok: false, code: 'SESSION_FOREIGN', question: ambiguityQuestion('SESSION_FOREIGN') }
    if (candidate.status === 'FOREIGN' || (context.kingdom_id && candidate.kingdom_id && candidate.kingdom_id !== context.kingdom_id)) {
      return { ok: false, code: 'SESSION_FOREIGN', question: ambiguityQuestion('SESSION_FOREIGN') }
    }
    if (candidate.status === 'MISSING') return { ok: false, code: 'SESSION_MISSING', question: ambiguityQuestion('SESSION_MISSING') }
    if (candidate.status === 'EXPIRED') return { ok: false, code: 'SESSION_EXPIRED', question: ambiguityQuestion('SESSION_EXPIRED') }
    if (candidate.status === 'ABORTED') return { ok: false, code: 'SESSION_UNRESOLVED', question: ambiguityQuestion('SESSION_UNRESOLVED') }
    if (candidate.status === 'MULTIPLE') return { ok: false, code: 'SESSION_MULTIPLE', question: ambiguityQuestion('SESSION_MULTIPLE') }
    if (candidate.status === 'UNKNOWN') return { ok: false, code: 'SESSION_UNRESOLVED', question: ambiguityQuestion('SESSION_UNRESOLVED') }
  }

  if (state !== 'ACTIVE') {
    return { ok: false, code: 'SESSION_UNRESOLVED', question: ambiguityQuestion('SESSION_UNRESOLVED') }
  }
  return { ok: true, session_ref: target }
}

function resolveRequestedTargetSession(
  requestedSessionId: string | null | undefined,
  context: OwnerBindingIntentContext,
): SessionResolution | ResolutionFailure {
  if (requestedSessionId !== undefined && requestedSessionId !== null) {
    if (!isExactToken(requestedSessionId)) {
      return { ok: false, code: 'SESSION_UNRESOLVED', question: ambiguityQuestion('SESSION_UNRESOLVED') }
    }
    if (context.target_session_ref !== undefined
      && context.target_session_ref !== null
      && requestedSessionId !== context.target_session_ref) {
      return { ok: false, code: 'SESSION_FOREIGN', question: ambiguityQuestion('SESSION_FOREIGN') }
    }
  }
  return resolveTargetSession(context)
}

function normalizedTerritoryLabel(value: string): string {
  return normalizeInput(value).replace(/(?:辖区|领地|区域)$/u, '').trim().toLocaleLowerCase()
}

function territoryIsPlaceholder(value: string): boolean {
  return /^(?:某|某个|一个|任意|指定的)?(?:辖区|领地|区域)$/u.test(normalizeInput(value))
}

function resolveTerritorySupervisorBinding(
  territory: TerritorySnapshot,
  context: OwnerBindingIntentContext,
): string | null | ResolutionFailure {
  const bindingId = territory.supervisor_binding_id
  if (bindingId === undefined || bindingId === null) return null
  if (!isExactToken(bindingId)) return { ok: false, code: 'ROLE_BINDING_UNSAFE', question: ambiguityQuestion('ROLE_BINDING_UNSAFE') }

  // When a role snapshot is present, prove that the Territory reference is an
  // ACTIVE local SUPERVISOR binding.  Without that optional snapshot, the
  // exact Territory projection remains the bounded read-only proof supplied by
  // the adapter; the module still never writes or treats it as authority.
  if (context.role_bindings !== undefined) {
    const matches = context.role_bindings.filter(row => row.binding_id === bindingId)
    const active = matches.filter(row => !row.status || row.status.toUpperCase() === 'ACTIVE')
    if (active.length === 0) return { ok: false, code: 'ROLE_BINDING_UNSAFE', question: ambiguityQuestion('ROLE_BINDING_UNSAFE') }
    if (active.length > 1) return { ok: false, code: 'ROLE_MULTIPLE', question: ambiguityQuestion('ROLE_MULTIPLE') }
    const row = active[0]!
    if (row.role_type.toUpperCase() !== 'SUPERVISOR') return { ok: false, code: 'ROLE_BINDING_UNSAFE', question: ambiguityQuestion('ROLE_BINDING_UNSAFE') }
    if (context.kingdom_id && row.kingdom_id && row.kingdom_id !== context.kingdom_id) {
      return { ok: false, code: 'ROLE_FOREIGN', question: ambiguityQuestion('ROLE_FOREIGN') }
    }
  }
  return bindingId
}

function resolveTerritory(
  query: string | null,
  context: OwnerBindingIntentContext,
  exactName = false,
): TerritoryResolution | ResolutionFailure {
  if (!query || territoryIsPlaceholder(query)) return { ok: false, code: 'TERRITORY_REQUIRED', question: ambiguityQuestion('TERRITORY_REQUIRED') }
  if (!context.territories) return { ok: false, code: 'TERRITORY_UNRESOLVED', question: ambiguityQuestion('TERRITORY_UNRESOLVED') }

  const wanted = exactName ? normalizeInput(query) : normalizedTerritoryLabel(query)
  const matches = context.territories.filter(row => {
    if (exactName) return normalizeInput(row.name) === wanted
    const labels = [row.name, ...(row.aliases ?? [])].map(normalizedTerritoryLabel)
    return labels.includes(wanted)
  })
  if (matches.length === 0) return { ok: false, code: 'TERRITORY_NOT_FOUND', question: ambiguityQuestion('TERRITORY_NOT_FOUND') }
  if (matches.length !== 1) return { ok: false, code: 'TERRITORY_MULTIPLE', question: ambiguityQuestion('TERRITORY_MULTIPLE') }

  const match = matches[0]!
  if (context.kingdom_id && match.kingdom_id && match.kingdom_id !== context.kingdom_id) {
    return { ok: false, code: 'TERRITORY_FOREIGN', question: ambiguityQuestion('TERRITORY_FOREIGN') }
  }
  if (match.status && match.status.toUpperCase() !== 'ACTIVE') {
    return { ok: false, code: 'TERRITORY_UNAVAILABLE', question: ambiguityQuestion('TERRITORY_UNAVAILABLE') }
  }
  if (!isExactToken(match.territory_id)) return { ok: false, code: 'TERRITORY_UNRESOLVED', question: ambiguityQuestion('TERRITORY_UNRESOLVED') }
  const supervisorBinding = resolveTerritorySupervisorBinding(match, context)
  if (typeof supervisorBinding !== 'string' && supervisorBinding !== null) return supervisorBinding
  return {
    ok: true,
    territory: { territory_id: match.territory_id, name: match.name },
    supervisor_binding_id: supervisorBinding,
  }
}

function canonicalRoleName(roleType: IntentRoleType): string {
  switch (roleType) {
    case 'CHANCELLOR': return '宰相'
    case 'SUPERVISOR': return '主管'
    case 'WORKER': return '骑士'
  }
}

function resolveExistingSingleton(
  roleType: IntentRoleType,
  context: OwnerBindingIntentContext,
): BindingSnapshot | ResolutionFailure | null {
  if (roleType !== 'CHANCELLOR') return null
  const rows = (context.role_bindings ?? []).filter(row => row.role_type.toUpperCase() === roleType)
  const active = rows.filter(row => !row.status || row.status.toUpperCase() === 'ACTIVE')
  const local = active.filter(row => !context.kingdom_id || !row.kingdom_id || row.kingdom_id === context.kingdom_id)
  if (local.length === 0 && active.length > 0) return { ok: false, code: 'ROLE_FOREIGN', question: ambiguityQuestion('ROLE_FOREIGN') }
  if (local.length > 1) return { ok: false, code: 'ROLE_MULTIPLE', question: ambiguityQuestion('ROLE_MULTIPLE') }
  if (local.length === 1) {
    if (!isExactToken(local[0]!.binding_id)) return { ok: false, code: 'ROLE_BINDING_UNSAFE', question: ambiguityQuestion('ROLE_BINDING_UNSAFE') }
    return local[0]!
  }
  return null
}

function canonicalDirectSlash(operation: DraftOperation): string {
  return `/kingdom ${operation.kind} ${stableJson(operation.args)}`
}

function roleBindStep(operation: RoleBindDraftOperation): RoleBindDraftStep {
  return {
    step_id: 'ROLE_BIND',
    kind: 'role.bind',
    args: operation.args,
    canonical_direct_slash: canonicalDirectSlash(operation),
    canonical_direct_slash_template: null,
    depends_on: [],
    confirmation: DIRECT_SLASH_CONFIRM_REQUIRED,
    policy: { failure: 'STOP_NO_AGENT_RETRY_OR_COMPENSATION' },
  }
}

function roleSessionStep(operation: RoleSessionDraftOperation): RoleSessionDraftStep {
  return {
    step_id: 'ROLE_SESSION',
    kind: 'role.session',
    args: operation.args,
    canonical_direct_slash: canonicalDirectSlash(operation),
    canonical_direct_slash_template: null,
    depends_on: [],
    confirmation: DIRECT_SLASH_CONFIRM_REQUIRED,
    policy: { failure: 'STOP_NO_AGENT_RETRY_OR_COMPENSATION' },
  }
}

/**
 * 旧两步流程的材料化（v3.2.0 之前：先 role.bind，再拿返回的 binding_id 执行第二步）。
 * 3.2.0 起主管任命是单步原子命令，本函数只为仍然引用它的调用方保留，不再是 Draft 的步骤。
 */
export function canonicalTerritorySupervisorSlash(territoryId: string, supervisorBindingId: string): string | null {
  if (!isExactToken(territoryId) || !isExactToken(supervisorBindingId)) return null
  return `/kingdom territory.supervisor ${stableJson({ territory_id: territoryId, supervisor_binding_id: supervisorBindingId })}`
}

function territorySupervisorExactStep(territoryId: string, supervisorBindingId: string): TerritorySupervisorDraftStep {
  return {
    step_id: 'TERRITORY_SUPERVISOR',
    kind: 'territory.supervisor',
    args: { territory_id: territoryId, supervisor_binding_id_ref: supervisorBindingId },
    canonical_direct_slash: canonicalTerritorySupervisorSlash(territoryId, supervisorBindingId),
    canonical_direct_slash_template: null,
    depends_on: [],
    confirmation: DIRECT_SLASH_CONFIRM_REQUIRED,
    policy: { failure: 'STOP_NO_AGENT_RETRY_OR_COMPENSATION' },
  }
}

function canonicalSteps(
  parsed: ParsedLanguage,
  operation: DraftOperation,
  territory: { territory_id: string; name: string } | null,
  supervisorBindingId: string | null,
): CanonicalDraftStep[] {
  if (operation.kind === 'role.session') {
    if (parsed.role_type !== 'SUPERVISOR' || territory === null || supervisorBindingId !== null) {
      return [roleSessionStep(operation)]
    }
    // 改绑既有席位后还要把它设为该领地主理：两步（先改 session，再设主理）。
    return [roleSessionStep(operation), territorySupervisorExactStep(territory.territory_id, operation.args.binding_id)]
  }
  // v3.2.0：主管的 role.bind 已经携带 territory_id，席位与主理在同一事务内原子完成，
  // 因此不再需要第二步 `/kingdom territory.supervisor`（旧两步草案在新语法下第一步就会被拒）。
  return [roleBindStep(operation)]
}

function readyDraft(
  normalizedInput: string,
  parsed: ParsedLanguage,
  sessionRef: string,
  territory: { territory_id: string; name: string } | null,
  operation: DraftOperation,
  supervisorBindingId: string | null,
  context: OwnerBindingIntentContext,
): OwnerBindingIntentDraft {
  const draft = baseDraft(normalizedInput, {
    role_type: parsed.role_type,
    role_alias: parsed.role_alias,
    target: 'CALL_CONTEXT_TARGET_SESSION',
    target_session_ref: sessionRef,
    territory,
  })
  draft.status = 'DRAFT_READY'
  draft.operation = operation
  const steps = canonicalSteps(parsed, operation, territory, supervisorBindingId)
  draft.steps = steps
  draft.canonical_steps = steps
  draft.canonical_direct_slash = steps[0]?.canonical_direct_slash ?? null
  draft.confirmation = DIRECT_SLASH_CONFIRM_REQUIRED
  if (parsed.role_type === 'SUPERVISOR' && operation.kind === 'role.session') {
    draft.affected_territories = snapshotAffectedSupervisorTerritories(operation.args.binding_id, context)
  }
  return draft
}

function snapshotAffectedSupervisorTerritories(
  bindingId: string,
  context: OwnerBindingIntentContext,
): AffectedSupervisorTerritorySnapshot[] {
  return (context.territories ?? []).filter(row => row.supervisor_binding_id === bindingId)
    .map(row => ({ territory_id: row.territory_id, name: row.name, supervisor_binding_id: bindingId,
      status: row.status ?? null, kingdom_id: row.kingdom_id ?? null }))
    .sort((left, right) => left.territory_id.localeCompare(right.territory_id))
}

function readyExactRoleSessionDraft(
  normalizedInput: string,
  sessionRef: string,
  bindingId: string,
  roleType: ParsedRoleType,
  context: OwnerBindingIntentContext,
): OwnerBindingIntentDraft {
  const draft = baseDraft(normalizedInput, {
    role_type: roleType,
    role_alias: canonicalRoleAlias(roleType),
    target: 'CALL_CONTEXT_TARGET_SESSION',
    target_session_ref: sessionRef,
    territory: null,
  })
  draft.status = 'DRAFT_READY'
  const operation: RoleSessionDraftOperation = {
    kind: 'role.session',
    args: { binding_id: bindingId, session_id: sessionRef },
  }
  const steps = [roleSessionStep(operation)]
  draft.operation = operation
  draft.steps = steps
  draft.canonical_steps = steps
  draft.canonical_direct_slash = steps[0]!.canonical_direct_slash
  draft.confirmation = DIRECT_SLASH_CONFIRM_REQUIRED
  if (roleType === 'SUPERVISOR') draft.affected_territories = snapshotAffectedSupervisorTerritories(bindingId, context)
  return draft
}

function canonicalRoleAlias(roleType: ParsedRoleType): string {
  return ROLE_ALIASES.find(item => item.role_type === roleType)?.alias ?? roleType
}

function parseStructuredRoleType(value: string | null | undefined): ParsedRoleType | null {
  if (typeof value !== 'string') return null
  const normalized = normalizeInput(value)
  const upper = normalized.toUpperCase()
  if (upper === 'OWNER' || upper === 'CHANCELLOR' || upper === 'SUPERVISOR' || upper === 'WORKER') return upper
  return ROLE_ALIASES.find(item => item.alias.toLocaleLowerCase() === normalized.toLocaleLowerCase())?.role_type ?? null
}

function resolveTerritoryById(
  territoryId: string,
  context: OwnerBindingIntentContext,
): TerritoryResolution | ResolutionFailure {
  if (!isExactToken(territoryId)) return { ok: false, code: 'TERRITORY_UNRESOLVED', question: ambiguityQuestion('TERRITORY_UNRESOLVED') }
  if (!context.territories) return { ok: false, code: 'TERRITORY_UNRESOLVED', question: ambiguityQuestion('TERRITORY_UNRESOLVED') }
  const matches = context.territories.filter(row => row.territory_id === territoryId)
  if (matches.length === 0) return { ok: false, code: 'TERRITORY_NOT_FOUND', question: ambiguityQuestion('TERRITORY_NOT_FOUND') }
  if (matches.length !== 1) return { ok: false, code: 'TERRITORY_MULTIPLE', question: ambiguityQuestion('TERRITORY_MULTIPLE') }
  const match = matches[0]!
  if (context.kingdom_id && match.kingdom_id && match.kingdom_id !== context.kingdom_id) {
    return { ok: false, code: 'TERRITORY_FOREIGN', question: ambiguityQuestion('TERRITORY_FOREIGN') }
  }
  if (match.status && match.status.toUpperCase() !== 'ACTIVE') {
    return { ok: false, code: 'TERRITORY_UNAVAILABLE', question: ambiguityQuestion('TERRITORY_UNAVAILABLE') }
  }
  const supervisorBinding = resolveTerritorySupervisorBinding(match, context)
  if (typeof supervisorBinding !== 'string' && supervisorBinding !== null) return supervisorBinding
  return {
    ok: true,
    territory: { territory_id: match.territory_id, name: match.name },
    supervisor_binding_id: supervisorBinding,
  }
}

function validateExplicitBinding(
  bindingId: string,
  roleType: IntentRoleType,
  context: OwnerBindingIntentContext,
): ResolutionFailure | null {
  if (!isExactToken(bindingId)) return { ok: false, code: 'ROLE_BINDING_UNSAFE', question: ambiguityQuestion('ROLE_BINDING_UNSAFE') }
  if (context.role_bindings === undefined) return null
  const rows = context.role_bindings.filter(row => row.binding_id === bindingId)
  const active = rows.filter(row => !row.status || row.status.toUpperCase() === 'ACTIVE')
  if (active.length === 0) return { ok: false, code: 'ROLE_BINDING_UNSAFE', question: ambiguityQuestion('ROLE_BINDING_UNSAFE') }
  if (active.length !== 1) return { ok: false, code: 'ROLE_MULTIPLE', question: ambiguityQuestion('ROLE_MULTIPLE') }
  const row = active[0]!
  if (row.role_type.toUpperCase() !== roleType) return { ok: false, code: 'ROLE_BINDING_UNSAFE', question: ambiguityQuestion('ROLE_BINDING_UNSAFE') }
  if (context.kingdom_id && row.kingdom_id && row.kingdom_id !== context.kingdom_id) {
    return { ok: false, code: 'ROLE_FOREIGN', question: ambiguityQuestion('ROLE_FOREIGN') }
  }
  return null
}

function resolveExactBindingForSession(
  bindingId: string,
  context: OwnerBindingIntentContext,
): ExactBindingResolution | ResolutionFailure {
  if (!isExactToken(bindingId)) return { ok: false, code: 'ROLE_BINDING_UNSAFE', question: ambiguityQuestion('ROLE_BINDING_UNSAFE') }
  if (context.role_bindings === undefined) {
    return { ok: false, code: 'ROLE_BINDING_UNSAFE', question: ambiguityQuestion('ROLE_BINDING_UNSAFE') }
  }

  const matches = context.role_bindings.filter(row => row.binding_id === bindingId)
  const active = matches.filter(row => !row.status || row.status.toUpperCase() === 'ACTIVE')
  if (active.length === 0) return { ok: false, code: 'ROLE_BINDING_UNSAFE', question: ambiguityQuestion('ROLE_BINDING_UNSAFE') }
  if (active.length > 1) return { ok: false, code: 'ROLE_MULTIPLE', question: ambiguityQuestion('ROLE_MULTIPLE') }

  const row = active[0]!
  const resolvedRoleType = parseStructuredRoleType(row.role_type)
  if (!resolvedRoleType) {
    return { ok: false, code: 'ROLE_BINDING_UNSAFE', question: ambiguityQuestion('ROLE_BINDING_UNSAFE') }
  }
  // This is deliberately only the exact-binding probe.  An OWNER result is
  // consumed before target-session proof; foreign binding, role-hint mismatch,
  // and other remaining binding validation are deferred until after that proof.
  return { ok: true, role_type: resolvedRoleType, binding: row }
}

function buildDraftFromExactBinding(
  normalizedInput: string,
  bindingId: string,
  roleTypeInput: string | null | undefined,
  requestSessionId: string | null | undefined,
  context: OwnerBindingIntentContext,
): OwnerBindingIntentDraft {
  const roleTypeHint = parseStructuredRoleType(roleTypeInput)
  const intent: DraftIntent = {
    role_type: roleTypeHint,
    role_alias: roleTypeHint === null ? null : canonicalRoleAlias(roleTypeHint),
    target: 'CALL_CONTEXT_TARGET_SESSION',
    target_session_ref: null,
    territory: null,
  }
  const binding = resolveExactBindingForSession(bindingId, context)
  const ownerByRoleHint = roleTypeHint === 'OWNER'
  const ownerByExactBinding = binding.ok && binding.role_type === 'OWNER'
  if (ownerByRoleHint || ownerByExactBinding) return ambiguousDraft(normalizedInput, {
    ...intent,
    role_type: 'OWNER',
    role_alias: canonicalRoleAlias('OWNER'),
  }, 'OWNER_ROLE_DIRECT_ONLY')

  // Exact and generic structured requests share the same request/target
  // identity proof.  It must run before invalid hints, foreign bindings, or
  // other remaining role validation.
  const session = resolveRequestedTargetSession(requestSessionId, context)
  if (!session.ok) return ambiguousDraft(normalizedInput, intent, session.code)
  if (roleTypeInput !== undefined && roleTypeInput !== null && roleTypeHint === null) {
    return ambiguousDraft(normalizedInput, intent, 'REJECTION_UNSUPPORTED')
  }
  if (!binding.ok) return ambiguousDraft(normalizedInput, intent, binding.code)
  if (context.kingdom_id && binding.binding.kingdom_id && binding.binding.kingdom_id !== context.kingdom_id) {
    return ambiguousDraft(normalizedInput, intent, 'ROLE_FOREIGN')
  }
  if (roleTypeHint !== null && roleTypeHint !== binding.role_type) {
    return ambiguousDraft(normalizedInput, intent, 'ROLE_BINDING_UNSAFE')
  }
  return readyExactRoleSessionDraft(normalizedInput, session.session_ref, bindingId, binding.role_type, context)
}

function buildDraftFromParsed(
  normalizedInput: string,
  parsed: ParsedLanguage,
  context: OwnerBindingIntentContext,
  forceRoleSession: boolean,
  forcedBindingId: string | null,
  forcedTerritoryId: string | null,
): OwnerBindingIntentDraft {
  const parsedIntent: DraftIntent = {
    role_type: parsed.role_type,
    role_alias: parsed.role_alias,
    target: 'CALL_CONTEXT_TARGET_SESSION',
    target_session_ref: null,
    territory: null,
  }
  if (parsed.role_type === 'OWNER') return ambiguousDraft(normalizedInput, parsedIntent, 'OWNER_ROLE_DIRECT_ONLY')

  const session = resolveTargetSession(context)
  if (!session.ok) return ambiguousDraft(normalizedInput, parsedIntent, session.code)
  parsedIntent.target_session_ref = session.session_ref

  let territory: { territory_id: string; name: string } | null = null
  let territorySupervisorBindingId: string | null = null
  if (parsed.role_type === 'SUPERVISOR') {
    const resolved = forcedTerritoryId === null
      ? resolveTerritory(parsed.territory_query, context, parsed.territory_exact)
      : resolveTerritoryById(forcedTerritoryId, context)
    if (!resolved.ok) return ambiguousDraft(normalizedInput, parsedIntent, resolved.code)
    territory = resolved.territory
    territorySupervisorBindingId = resolved.supervisor_binding_id
    parsedIntent.territory = territory
  }

  if (forceRoleSession && forcedBindingId !== null) {
    const bindingFailure = validateExplicitBinding(forcedBindingId, parsed.role_type, context)
    if (bindingFailure) return ambiguousDraft(normalizedInput, parsedIntent, bindingFailure.code)
    if (parsed.role_type === 'SUPERVISOR' && territorySupervisorBindingId !== null && territorySupervisorBindingId !== forcedBindingId) {
      return ambiguousDraft(normalizedInput, parsedIntent, 'ROLE_MULTIPLE')
    }
    const operation: RoleSessionDraftOperation = {
      kind: 'role.session',
      args: { binding_id: forcedBindingId, session_id: session.session_ref },
    }
    return readyDraft(normalizedInput, parsed, session.session_ref, territory, operation, territorySupervisorBindingId, context)
  }

  if (forceRoleSession) {
    if (parsed.role_type === 'SUPERVISOR' && territorySupervisorBindingId !== null) {
      const operation: RoleSessionDraftOperation = {
        kind: 'role.session',
        args: { binding_id: territorySupervisorBindingId, session_id: session.session_ref },
      }
      return readyDraft(normalizedInput, parsed, session.session_ref, territory, operation, territorySupervisorBindingId, context)
    }
    const existingSingleton = resolveExistingSingleton(parsed.role_type, context)
    if (existingSingleton && 'ok' in existingSingleton) return ambiguousDraft(normalizedInput, parsedIntent, existingSingleton.code)
    if (existingSingleton) {
      const operation: RoleSessionDraftOperation = {
        kind: 'role.session',
        args: { binding_id: existingSingleton.binding_id, session_id: session.session_ref },
      }
      return readyDraft(normalizedInput, parsed, session.session_ref, territory, operation, territorySupervisorBindingId, context)
    }
    return ambiguousDraft(normalizedInput, parsedIntent, 'ROLE_BINDING_UNSAFE')
  }

  if (parsed.role_type === 'SUPERVISOR' && territorySupervisorBindingId !== null) {
    const operation: RoleSessionDraftOperation = {
      kind: 'role.session',
      args: { binding_id: territorySupervisorBindingId, session_id: session.session_ref },
    }
    return readyDraft(normalizedInput, parsed, session.session_ref, territory, operation, territorySupervisorBindingId, context)
  }

  const existing = resolveExistingSingleton(parsed.role_type, context)
  if (existing && 'ok' in existing) return ambiguousDraft(normalizedInput, parsedIntent, existing.code)
  const operation: DraftOperation = existing
    ? { kind: 'role.session', args: { binding_id: existing.binding_id, session_id: session.session_ref } }
    : { kind: 'role.bind', args: { role_type: parsed.role_type, role_name: canonicalRoleName(parsed.role_type), session_id: session.session_ref,
      // 主管的领地归属是任命的一部分：Draft 必须与 direct Slash 语法一致，否则草案不可执行。
      ...(parsed.role_type === 'SUPERVISOR' && territory ? { territory_id: territory.territory_id } : {}) } }
  return readyDraft(normalizedInput, parsed, session.session_ref, territory, operation, territorySupervisorBindingId, context)
}

/** Parse one bounded natural-language intent without performing any write. */
export function draftOwnerBindingIntent(input: OwnerBindingIntentInput): OwnerBindingIntentDraft {
  const normalizedInput = normalizeInput(typeof input.text === 'string' ? input.text : '')
  const parsed = parseNaturalLanguage(normalizedInput)
  if (!parsed) {
    return ambiguousDraft(normalizedInput, {
      role_type: null,
      role_alias: null,
      target: null,
      target_session_ref: null,
      territory: null,
    }, 'UNSUPPORTED_INPUT')
  }
  return buildDraftFromParsed(normalizedInput, parsed, input.context ?? {}, false, null, null)
}

function structuredIntentText(roleType: ParsedRoleType, territoryName: string | null): string {
  if (roleType === 'SUPERVISOR') return `让当前会话主管${territoryName ? `${territoryName}辖区` : '某辖区'}`
  return `把当前会话设为${canonicalRoleAlias(roleType)}`
}

/**
 * Convert a structured OWNER_CONTROL_REQUIRED rejection into the same pure
 * Draft contract.  The rejection is data, not authority; target session still
 * comes only from the explicitly classified invocation context.
 */
export function draftOwnerBindingIntentFromRejectedWrite(
  input: StructuredOwnerBindingRejection,
): OwnerBindingIntentDraft {
  const normalizedInput = 'OWNER_CONTROL_REQUIRED rejected binding request'
  if (!input.code.startsWith('OWNER_CONTROL_REQUIRED')) {
    return ambiguousDraft(normalizedInput, {
      role_type: null,
      role_alias: null,
      target: null,
      target_session_ref: null,
      territory: null,
    }, 'REJECTION_UNSUPPORTED')
  }

  const request = input.request ?? {}
  const context = input.context ?? {}
  const forceRoleSession = input.operation === 'kingdom_bind_session' || input.operation === 'role.session'
  const hasBindingId = request.binding_id !== undefined && request.binding_id !== null

  // kingdom_bind_session permits either role_type or binding_id.  Resolve the
  // exact binding first when binding_id is present; role_type is only a
  // consistency hint and must never be required for the canonical operation.
  if (forceRoleSession && hasBindingId) {
    const roleTypeHint = request.role_type === undefined || request.role_type === null
      ? null
      : parseStructuredRoleType(request.role_type)
    return buildDraftFromExactBinding(
      roleTypeHint === null ? '把当前会话绑定到现有角色绑定' : structuredIntentText(roleTypeHint, null),
      request.binding_id as string,
      request.role_type,
      request.session_id,
      context,
    )
  }

  const parsedRoleType = parseStructuredRoleType(request.role_type)
  const parsedIntent: DraftIntent = {
    role_type: parsedRoleType,
    role_alias: parsedRoleType === null ? null : canonicalRoleAlias(parsedRoleType),
    target: 'CALL_CONTEXT_TARGET_SESSION',
    target_session_ref: null,
    territory: null,
  }
  if (parsedRoleType === 'OWNER') {
    return ambiguousDraft(normalizedInput, {
      ...parsedIntent,
    }, 'OWNER_ROLE_DIRECT_ONLY')
  }

  // Generic structured requests use the same request/target identity proof as
  // exact binding-id requests.  Only after it succeeds do role/territory
  // validation and Draft materialization run.
  const session = resolveRequestedTargetSession(request.session_id, context)
  if (!session.ok) return ambiguousDraft(normalizedInput, parsedIntent, session.code)
  if (!parsedRoleType) return ambiguousDraft(normalizedInput, parsedIntent, 'REJECTION_UNSUPPORTED')
  const roleType = parsedRoleType

  let territoryName: string | null = null
  let forcedTerritoryId: string | null = null
  if (roleType === 'SUPERVISOR' && request.territory_id !== undefined && request.territory_id !== null) {
    const resolved = resolveTerritoryById(request.territory_id, context)
    if (!resolved.ok) {
      return ambiguousDraft(normalizedInput, {
        role_type: roleType,
        role_alias: canonicalRoleAlias(roleType),
        target: 'CALL_CONTEXT_TARGET_SESSION',
        target_session_ref: null,
        territory: null,
      }, resolved.code)
    }
    territoryName = resolved.territory.name
    forcedTerritoryId = resolved.territory.territory_id
  }

  const parsed: ParsedLanguage = {
    role_type: roleType,
    role_alias: canonicalRoleAlias(roleType),
    territory_query: territoryName,
  }
  const forcedBindingId = forceRoleSession && request.binding_id ? request.binding_id : null
  return buildDraftFromParsed(
    structuredIntentText(roleType, territoryName),
    parsed,
    context,
    forceRoleSession,
    forcedBindingId,
    forcedTerritoryId,
  )
}

/** Compatibility-friendly name for callers that prefer a parse verb. */
export const parseOwnerBindingIntent = draftOwnerBindingIntent

/** Stable, JSON-safe rendering for UI/Agent echo and deterministic tests. */
export function serializeOwnerBindingIntentDraft(draft: OwnerBindingIntentDraft): string {
  return stableJson(draft)
}

export interface OwnerBindingGuidance {
  kind: 'OWNER_BINDING_GUIDANCE'
  status: 'READY' | 'NEEDS_CLARIFICATION'
  authority_source: 'NONE'
  owner_authority: false
  write_effect: 'ZERO_WRITE'
  summary: string
  steps: readonly string[]
  /** A bounded human activation command, never an Owner ticket or capability. */
  canonical_owner_gui: string | null
}

/**
 * Explain a verified binding draft without making the user learn IDs or JSON.
 * Prefer the management window: its preview/commit path also guards unsettled
 * work. The legacy canonical_direct_slash stays intact for compatibility.
 */
export function buildOwnerBindingGuidance(
  draft: OwnerBindingIntentDraft,
  context: OwnerBindingIntentContext = {},
): OwnerBindingGuidance {
  const blocked = (summary: string): OwnerBindingGuidance => ({
    kind: 'OWNER_BINDING_GUIDANCE', status: 'NEEDS_CLARIFICATION', authority_source: 'NONE',
    owner_authority: false, write_effect: 'ZERO_WRITE', summary,
    steps: ['在希望担任主管的会话中说明准确领地名称；会话会重新核对并准备操作。'],
    canonical_owner_gui: null,
  })
  if (draft.status !== 'DRAFT_READY' || !draft.operation || draft.steps.length !== 1) {
    const code = draft.ambiguity?.code
    if (code?.startsWith('SESSION_')) return blocked('无法确认当前会话有效，请在希望担任主管的会话中重新提出请求。')
    if (code === 'TERRITORY_REQUIRED') return blocked('请说明准确领地名称，例如：让当前会话负责「研发领」。')
    if (code === 'TERRITORY_NOT_FOUND') return blocked('没有找到这个领地名称，请先查看工作台里的领地名称，再重新提出请求。')
    if (code === 'TERRITORY_MULTIPLE') return blocked('这个名称对应多个领地，不能自动选择；请先在管理窗口区分同名领地。')
    if (code === 'UNSUPPORTED_INPUT') return blocked('请说明要任命还是接替，例如：让当前会话负责「研发领」，或把「研发领」主管换成当前会话。')
    return blocked(draft.ambiguity?.question ?? '本次操作尚不能唯一确定，请先补齐会话和领地信息。')
  }
  if (draft.owner_authority !== false || draft.authority_source !== 'NONE' || draft.write_effect !== 'ZERO_WRITE') {
    return blocked('本次草案不能作为管理授权，请重新准备。')
  }
  const session = resolveTargetSession(context)
  if (!session.ok || session.session_ref !== draft.intent.target_session_ref
    || session.session_ref !== draft.operation.args.session_id) {
    return blocked('当前会话已失效或发生变化，请在要担任角色的会话中重新提出请求。')
  }
  if (!isExactToken(context.kingdom_id)) return blocked('尚未确认当前王国，请先完成初始化后重新提出请求。')

  const operation = draft.operation
  let roleType: 'SUPERVISOR' | 'CHANCELLOR'
  let territory: { territory_id: string; name: string } | null = null
  let affectedTerritories: { territory_id: string; name: string }[] = []
  const bindingIds: string[] = []
  if (operation.kind === 'role.bind') {
    if (operation.args.role_type !== 'SUPERVISOR' && operation.args.role_type !== 'CHANCELLOR') {
      return blocked('本次会话引导支持主管和宰相；执行者会话由正常执行流程建立。')
    }
    roleType = operation.args.role_type
    if (draft.intent.role_type !== roleType) return blocked('角色信息发生变化，请重新准备操作。')
    if (roleType === 'SUPERVISOR') {
      if (!operation.args.territory_id) return blocked('请说明要负责的准确领地名称。')
      const resolved = resolveTerritoryById(operation.args.territory_id, context)
      if (!resolved.ok || resolved.supervisor_binding_id !== null
        || draft.intent.territory?.territory_id !== resolved.territory.territory_id
        || draft.intent.territory?.name !== resolved.territory.name) {
        return blocked('领地或现任主管发生变化，请重新提出任命或更换请求。')
      }
      territory = resolved.territory
      affectedTerritories = [territory]
    } else if (resolveExistingSingleton(roleType, context) !== null) {
      return blocked('宰相席位已有变化，请重新提出接替请求。')
    }
  } else {
    const resolved = resolveExactBindingForSession(operation.args.binding_id, context)
    if (!resolved.ok || (resolved.role_type !== 'SUPERVISOR' && resolved.role_type !== 'CHANCELLOR')
      || resolved.role_type !== draft.intent.role_type
      || (context.kingdom_id && resolved.binding.kingdom_id && resolved.binding.kingdom_id !== context.kingdom_id)) {
      return blocked('现任角色已变化或不可用，请重新准备接替操作。')
    }
    roleType = resolved.role_type
    bindingIds.push(operation.args.binding_id)
    const related = snapshotAffectedSupervisorTerritories(operation.args.binding_id, context)
    if (roleType === 'SUPERVISOR') {
      if (!related.length || !draft.affected_territories
        || stableJson(draft.affected_territories) !== stableJson(related)) {
        return blocked('主管负责的领地范围已变化或无法核对，请重新准备并确认全部受影响领地。')
      }
      for (const row of related) {
        const resolvedTerritory = resolveTerritoryById(row.territory_id, context)
        if (!resolvedTerritory.ok || resolvedTerritory.supervisor_binding_id !== operation.args.binding_id) {
          return blocked('受影响领地已不可用、属于其他王国或关系发生变化，请先核对主管负责范围。')
        }
        affectedTerritories.push(resolvedTerritory.territory)
      }
      if (draft.intent.territory !== null && !affectedTerritories.some(row => row.territory_id === draft.intent.territory!.territory_id
        && row.name === draft.intent.territory!.name)) return blocked('被点名领地与主管关系发生变化，请重新提出接替请求。')
      territory = draft.intent.territory ?? affectedTerritories[0]!
    } else if (related.length) return blocked('角色与领地关系不一致，请先核对现任角色。')
  }
  const input = {
    kingdomId: context.kingdom_id,
    actions: [operation.kind],
    scope: { kingdomWide: false, territoryIds: affectedTerritories.map(row => row.territory_id), bindingIds,
      roleTypes: [roleType], targetSessionIds: [session.session_ref], workspaceRoots: [] },
    ttlMs: 600000,
  }
  const subject = territory ? `领地「${territory.name}」的主管` : '宰相'
  const allTerritoryNames = affectedTerritories.map(row => `「${row.name}」`).join('、')
  const seatScopeNotice = operation.kind === 'role.session' && roleType === 'SUPERVISOR'
    ? `本次更换的是同一主管席位的会话，会同时接替全部领地：${allTerritoryNames}。若只想接替其中一个领地，请停止确认，不执行此变更。`
    : null
  return {
    kind: 'OWNER_BINDING_GUIDANCE', status: 'READY', authority_source: 'NONE', owner_authority: false, write_effect: 'ZERO_WRITE',
    summary: operation.kind === 'role.bind' ? `已准备让当前会话担任${subject}；尚未变更。`
      : `已准备让当前会话接替${subject}；保留原席位及任务历史，尚未变更。${seatScopeNotice ?? ''}`,
    steps: [
      ...(seatScopeNotice ? [seatScopeNotice] : []),
      '复制下方完整命令，在当前 DSH 会话的直接命令入口执行一次，打开十分钟管理窗口。无需修改命令中的字段。',
      '打开返回的管理链接；窗口会预选本次唯一目标。核对领地、角色和当前会话，点击「查看变更预览」。',
      '确认预览准确后点击「确认应用此变更」。只有这一步会提交；仍有未结算工作时窗口会说明阻止原因。',
      '收到成功结果后回到当前会话继续操作；若被拒绝或结果不明，先核对结果，不重复提交或自动解除现任主管。',
    ],
    canonical_owner_gui: `/kingdom owner.gui ${stableJson(input)}`,
  }
}
