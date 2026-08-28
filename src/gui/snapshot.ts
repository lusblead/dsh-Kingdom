/**
 * dsh-kingdom — DB 行 → GUI 视图的投影（Phase 3）。
 *
 * 全部是**纯函数**：给定 (库状态, now) 就唯一确定输出。
 * 因此 GUI 轮询即可拿到正确的表演状态，服务端不需要任何定时器或推送状态机。
 *
 * 再次强调边界：本文件只产出 `{ role, state, activity }` 这类语义，
 * 绝不产出贴图、clip、场景文件名——那些是 GUI 的 visual-map 的事。
 */
import type {
  AffinityView,
  AllowedAction,
  ActorActivity,
  ActorRole,
  ActorState,
  ActionAvailability,
  AttentionItem,
  AttentionReason,
  AuthoritativeState,
  BindingView,
  CapabilityDecisionView,
  ClaimView,
  DispatchView,
  EntityRef,
  EventView,
  ExecutionProjectionData,
  ExecutionProjectionSummary,
  ExecutionView,
  LeaseView,
  OrganizationProjectionData,
  OrganizationRoleSummary,
  OrganizationTerritorySummary,
  OverviewProjectionData,
  ProjectionEnvelope,
  ProjectionSecurityContext,
  ProjectionTerminality,
  ReadonlySnapshotProjection,
  RuntimeGovernanceView,
  SourceRef,
  StageActorView,
  SupervisorDecisionView,
  TaskAssignmentHistoryView,
  TaskProjectionData,
  TaskDetailView,
  TaskView,
  TerritoryView,
  SnapshotView,
  TimelineItem,
  AuthView,
} from './contract.js'
import { GUI_SCHEMA_VERSION, TRANSIENT_WINDOW_MS } from './contract.js'
import {
  type EventRow,
  type ExecutionRow,
  type KingdomStore,
  type RoleBindingRow,
  type TaskAssignmentRow,
  type TaskRow,
  type TerritoryRow,
  type WorkerResultRow,
} from '../core/db.js'
import { asExecutionState, isLiveExecutionState, isTerminalExecutionState } from '../core/execution.js'
import { asTaskStatus } from '../core/task.js'
import { parseExecutionProfile } from '../core/binding.js'

// ── 行 → 视图 ───────────────────────────────────────────────────

function parseJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

const REDACTED_JSON_VALUE = '[REDACTED]'
const TRUNCATED_JSON_DEPTH = '[TRUNCATED_DEPTH]'
const TRUNCATED_JSON_NODES = '[TRUNCATED_NODES]'
const TRUNCATED_JSON_ARRAY = '[TRUNCATED_ARRAY]'
const TRUNCATED_JSON_OBJECT_KEY = '__projectionTruncated__'
const MAX_PUBLIC_JSON_DEPTH = 6
const MAX_PUBLIC_JSON_ENTRIES = 32
const MAX_PUBLIC_JSON_NODES = 512
const MAX_PUBLIC_JSON_STRING = 512
const PUBLIC_JSON_TRUNCATION_SUFFIX = '…[TRUNCATED]'
const SENSITIVE_JSON_KEY_FRAGMENTS = [
  'session',
  'principal',
  'private',
  'config',
  'token',
  'cookie',
  'credential',
  'secret',
  'password',
  'authorization',
  'apikey',
  'accesskey',
  'clientsecret',
  'bearer',
  'connectionstring',
  'csrf',
  'authority',
  'ownercontrol',
] as const

function sensitivePublicJsonKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '')
  return SENSITIVE_JSON_KEY_FRAGMENTS.some(fragment => normalized.includes(fragment))
}

function sanitizePublicJsonString(
  value: string,
  sensitivity: 'public-content' | 'private-config' = 'public-content',
): string {
  if (sensitivity === 'private-config') return REDACTED_JSON_VALUE
  const redacted = value
    .replace(/(?:authorization|bearer|session(?:[_ .-]?id)?|principal(?:[_ .-]?id)?|private(?:[_ .-]?config)?|token|cookie|credential|secret|password|api[_ .-]?key|access[_ .-]?key|client[_ .-]?secret|connection[_ .-]?string|csrf)\b(?:\s*["']?\s*(?:=|:)\s*["']?\s*|\s+)[^\s,;&}]+/giu, REDACTED_JSON_VALUE)
    .replace(/[A-Za-z]:[\\/][^\s<>"']*/gu, '[redacted-path]')
    .replace(/\\\\[^\s<>"']*/gu, '[redacted-path]')
    .replace(/(^|[\s("'=])\/[^\s<>"']*/gu, '$1[redacted-path]')
    .replace(/\bprivate[-_][^\s<>"']+/giu, REDACTED_JSON_VALUE)
  if (redacted.length <= MAX_PUBLIC_JSON_STRING) return redacted
  return `${redacted.slice(0, MAX_PUBLIC_JSON_STRING - PUBLIC_JSON_TRUNCATION_SUFFIX.length)}${PUBLIC_JSON_TRUNCATION_SUFFIX}`
}

function sanitizePublicJsonValue(
  value: unknown,
  depth: number,
  budget: { remaining: number },
): unknown {
  if (budget.remaining <= 0) return TRUNCATED_JSON_NODES
  budget.remaining -= 1
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return sanitizePublicJsonString(value)
  if (Array.isArray(value)) {
    if (depth >= MAX_PUBLIC_JSON_DEPTH) return TRUNCATED_JSON_DEPTH
    const result = value
      .slice(0, MAX_PUBLIC_JSON_ENTRIES)
      .map(item => sanitizePublicJsonValue(item, depth + 1, budget))
    if (value.length > MAX_PUBLIC_JSON_ENTRIES) result.push(TRUNCATED_JSON_ARRAY)
    return result
  }
  if (typeof value !== 'object') return null
  if (depth >= MAX_PUBLIC_JSON_DEPTH) return TRUNCATED_JSON_DEPTH

  const entries = Object.entries(value as Record<string, unknown>)
  const result = Object.create(null) as Record<string, unknown>
  for (const [key, item] of entries.slice(0, MAX_PUBLIC_JSON_ENTRIES)) {
    result[key] = sensitivePublicJsonKey(key)
      ? REDACTED_JSON_VALUE
      : sanitizePublicJsonValue(item, depth + 1, budget)
  }
  if (entries.length > MAX_PUBLIC_JSON_ENTRIES) {
    result[TRUNCATED_JSON_OBJECT_KEY] = entries.length - MAX_PUBLIC_JSON_ENTRIES
  }
  return result
}

/** Event payload 与 Binding session metadata 共用的递归、确定性、有界公共 JSON 转换。 */
function sanitizePublicJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizePublicJsonValue(value, 0, { remaining: MAX_PUBLIC_JSON_NODES })
  return typeof sanitized === 'object' && sanitized !== null && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : {}
}

function sanitizePublicStringList(value: unknown): string[] {
  const sanitized = sanitizePublicJsonValue(stringList(value), 0, { remaining: MAX_PUBLIC_JSON_NODES })
  return Array.isArray(sanitized)
    ? sanitized.filter((item): item is string => typeof item === 'string')
    : []
}

// ── v0.9 S1 只读 Projection ──────────────────────────────────────

const MAX_PROJECTION_SOURCE_REFS = 8
const MAX_PROJECTION_TIMELINE_ITEMS = 200
const MAX_PROJECTION_TEXT = 140
const MAX_PROJECTION_ORGANIZATION_ITEMS = 64
const MAX_PROJECTION_EXECUTION_SUMMARIES = 100
const OWNER_ONLY_ACTIONS = [
  'init',
  'reset',
  'ceiling',
  'territory.create',
  'territory.delete',
  'territory.supervisor',
  // v0.9 aliases remain additive for existing JSON consumers.
  'binding.bind',
  'binding.unbind',
  'binding.session',
  // Canonical direct Slash command names used by v1.0.
  'role.bind',
  'role.unbind',
  'role.session',
  'execution-profile',
] as const

const PUBLIC_ENTITY_REF_TYPES = new Set([
  'kingdom',
  'task',
  'execution',
  'territory',
  'binding',
  'affinity',
  'lease',
  'decision',
  'dispatch',
])

const PUBLIC_TABLE_SOURCE_ENTITY_TYPES = new Set([
  'kingdoms',
  'tasks',
  'territories',
  'role_bindings',
  'task_assignments',
  'worker_results',
  'executions',
  'worker_session_affinities',
  'execution_leases',
  'capability_decisions',
  'dispatch_records',
])

function publicReferenceId(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  return /^[A-Za-z0-9_.:@-]{1,96}$/u.test(trimmed) ? trimmed : null
}

function boundedText(value: string | null | undefined): string {
  if (!value) return ''
  return sanitizePublicJsonString(value)
    .replace(/[\r\n\t]+/gu, ' ')
    .trim()
    .slice(0, MAX_PROJECTION_TEXT)
}

function publicEntityRef(type: string, id: string | null | undefined): EntityRef | null {
  if (!PUBLIC_ENTITY_REF_TYPES.has(type)) return null
  const safeId = publicReferenceId(id)
  return safeId ? { type, id: safeId } : null
}

function tableSource(entityType: string, entityId: string | null | undefined): SourceRef {
  return { sourceType: 'table-row', entityType, entityId: publicReferenceId(entityId) }
}

function eventSource(seq: number): SourceRef {
  return { sourceType: 'event', entityType: 'events', entityId: null, eventSeq: seq }
}

function ruleSource(ruleCode: string): SourceRef {
  return { sourceType: 'derived-rule', entityType: 'projection-rule', entityId: null, ruleCode }
}

function publicSourceType(value: string): SourceRef['sourceType'] {
  return value === 'table-row'
    || value === 'event'
    || value === 'runtime-evidence'
    || value === 'derived-rule'
    ? value
    : 'derived-rule'
}

function publicSourceEntityType(sourceType: SourceRef['sourceType'], value: string): string {
  const safeValue = boundedText(value)
  if (sourceType === 'table-row' && PUBLIC_TABLE_SOURCE_ENTITY_TYPES.has(safeValue)) return safeValue
  if (sourceType === 'event' && safeValue === 'events') return safeValue
  if (sourceType === 'runtime-evidence' && safeValue === 'runtime-observation') return safeValue
  if (sourceType === 'derived-rule' && safeValue === 'projection-rule') return safeValue
  return 'redacted-source'
}

function publicRuleCode(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  return /^[A-Z][A-Z0-9_]{0,95}$/u.test(trimmed) ? trimmed : 'REDACTED_RULE'
}

/** 对外暴露前统一限制数量与标识格式；不接受 session/raw payload/path 作为引用。 */
export function boundedSourceRefs(refs: SourceRef[]): SourceRef[] {
  const result: SourceRef[] = []
  const seen = new Set<string>()
  for (const ref of refs) {
    const sourceType = publicSourceType(ref.sourceType)
    const entityType = publicSourceEntityType(sourceType, ref.entityType)
    const ruleCode = sourceType === 'derived-rule' ? publicRuleCode(ref.ruleCode) : undefined
    const normalized: SourceRef = {
      sourceType,
      entityType,
      entityId: sourceType === 'table-row' && entityType !== 'redacted-source'
        ? publicReferenceId(ref.entityId)
        : null,
      ...(sourceType === 'event' && Number.isInteger(ref.eventSeq) && ref.eventSeq! >= 0
        ? { eventSeq: ref.eventSeq }
        : {}),
      ...(ruleCode ? { ruleCode } : {}),
    }
    const key = JSON.stringify(normalized)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
    if (result.length >= MAX_PROJECTION_SOURCE_REFS) break
  }
  return result
}

function safeDate(value: string | null | undefined): string | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

function projectionEnvelope<T>(input: {
  revision: number
  refreshedAt: string
  entityRef: EntityRef | null
  authoritativeState: AuthoritativeState | null
  sourceRefs: SourceRef[]
  allowedActions?: ActionAvailability[] | null
  attentionReason?: AttentionReason | null
  data: T
}): ProjectionEnvelope<T> {
  return {
    revision: input.revision,
    refreshedAt: input.refreshedAt,
    entityRef: input.entityRef,
    authoritativeState: input.authoritativeState,
    sourceRefs: boundedSourceRefs(input.sourceRefs),
    allowedActions: input.allowedActions ?? null,
    attentionReason: input.attentionReason ?? null,
    data: input.data,
  }
}

function attentionReason(code: string, refs: SourceRef[]): AttentionReason {
  return { code, sourceRefs: boundedSourceRefs(refs) }
}

function executionTerminality(state: string): ProjectionTerminality {
  if (state === 'COMPLETED' || state === 'FAILED' || state === 'ABORTED') return 'TERMINAL'
  if (state === 'STARTING' || state === 'RUNNING' || state === 'PAUSED') return 'NON_TERMINAL'
  return 'UNKNOWN'
}

/** 未终结的 governed attempt（含 RECOVERING）在完成对账前绝不能产生新 start。 */
function isGovernedStartBlocked(execution: ExecutionRow | null): boolean {
  return execution?.execution_contract === 'GOVERNED_PERSISTENT'
    && !isTerminalExecutionState(asExecutionState(execution.state))
}

function stateValue(value: string, sourceKind: 'GOVERNANCE_FACT' | 'RUNTIME_OBSERVATION', refs: SourceRef[]): AuthoritativeState {
  return { sourceKind, value: boundedText(value) || 'UNKNOWN', sourceRefs: boundedSourceRefs(refs) }
}

function timelineId(prefix: string, id: string | null | undefined): string {
  return `${prefix}:${publicReferenceId(id) ?? 'unknown'}`
}

function actionBinding(store: KingdomStore, task: TaskRow): RoleBindingRow | null {
  const territory = store.getTerritoryById(task.territory_id)
  return territory?.supervisor_binding_id ? store.getBindingById(territory.supervisor_binding_id) : null
}

function commandForAction(action: AllowedAction): string {
  if (action.startsWith('review:')) return 'review'
  if (action.startsWith('execution:')) return action.replace(':', '.')
  return action
}

function firstMissingActionContext(
  store: KingdomStore,
  task: TaskRow,
  action: AllowedAction,
  security: ProjectionSecurityContext,
): { reason: string; refs: SourceRef[] } | null {
  const refs = [tableSource('tasks', task.task_id)]
  const principalSessionId = security.principalSessionId
  if (security.sessionVerified !== true || typeof principalSessionId !== 'string' || principalSessionId.length === 0) {
    return { reason: 'SESSION_AUTH_REQUIRED', refs: [...refs, ruleSource('ACTION_SESSION_VERIFIED')] }
  }
  const binding = actionBinding(store, task)
  if (!binding || binding.role_type !== 'SUPERVISOR' || binding.status !== 'ACTIVE') {
    return {
      reason: 'TERRITORY_SUPERVISOR_MISSING',
      refs: [...refs, tableSource('territories', task.territory_id), tableSource('role_bindings', binding?.binding_id), ruleSource('ACTION_TERRITORY_SUPERVISOR')],
    }
  }
  if (binding.session_id === null || binding.session_id !== principalSessionId) {
    return {
      reason: 'SESSION_AUTH_REQUIRED',
      refs: [...refs, tableSource('role_bindings', binding.binding_id), ruleSource('ACTION_SUPERVISOR_SESSION_MATCH')],
    }
  }
  const scope = security.scope ?? []
  if (!scope.includes(task.territory_id) && !scope.includes(`territory:${task.territory_id}`)) {
    return { reason: 'ROLE_SCOPE_REQUIRED', refs: [...refs, tableSource('territories', task.territory_id), ruleSource('ACTION_TERRITORY_SCOPE')] }
  }
  if (security.hostContext !== true) {
    return { reason: 'HOST_CONTEXT_REQUIRED', refs: [...refs, ruleSource('ACTION_HOST_CONTEXT')] }
  }
  if (!(security.commandCoverage ?? []).includes(commandForAction(action))) {
    return { reason: 'COMMAND_UNAVAILABLE', refs: [...refs, ruleSource('ACTION_COMMAND_COVERAGE')] }
  }
  return null
}

/** 只返回生命周期候选的可执行性，不执行 action，也不改变任何状态。 */
export function buildActionAvailability(
  store: KingdomStore,
  task: TaskRow,
  execution: ExecutionRow | null,
  security: ProjectionSecurityContext = {},
): ActionAvailability[] {
  const startBlocked = isGovernedStartBlocked(execution)
  const lifecycleActions = allowedActionsFor(task, execution)
  const actions: AllowedAction[] = startBlocked && !lifecycleActions.includes('start')
    ? ['start', ...lifecycleActions]
    : lifecycleActions
  return actions.map((action) => {
    const refs = [tableSource('tasks', task.task_id)]
    if (action === 'start' && startBlocked && execution) {
      const blockedRefs = [
        ...refs,
        tableSource('executions', execution.execution_id),
        ...(execution.lease_id ? [tableSource('execution_leases', execution.lease_id)] : []),
        ruleSource('START_BLOCKED_BY_UNSETTLED_GOVERNED_EXECUTION'),
      ]
      return {
        action,
        lifecycleAllowed: false,
        executable: false,
        disabledReason: attentionReason(
          execution.state === 'RECOVERING' ? 'EXECUTION_RECOVERING' : 'ILLEGAL_EXECUTION_STATE',
          blockedRefs,
        ),
        sourceRefs: boundedSourceRefs(blockedRefs),
      }
    }
    if ((OWNER_ONLY_ACTIONS as readonly string[]).includes(action)) {
      return {
        action,
        lifecycleAllowed: true,
        executable: false,
        disabledReason: attentionReason('DIRECT_SLASH_REQUIRED', [...refs, ruleSource('OWNER_DIRECT_SLASH_ONLY')]),
        sourceRefs: boundedSourceRefs([...refs, ruleSource('OWNER_DIRECT_SLASH_ONLY')]),
      }
    }
    const missing = firstMissingActionContext(store, task, action, security)
    if (missing) {
      return {
        action,
        lifecycleAllowed: true,
        executable: false,
        disabledReason: attentionReason(missing.reason, missing.refs),
        sourceRefs: boundedSourceRefs(missing.refs),
      }
    }
    if (action.startsWith('execution:') && execution?.execution_contract === 'GOVERNED_PERSISTENT') {
      const unavailableRefs = [
        ...refs,
        tableSource('executions', execution.execution_id),
        ...(execution.lease_id ? [tableSource('execution_leases', execution.lease_id)] : []),
        ruleSource('GOVERNED_RUNTIME_CONTROL_UNAVAILABLE'),
      ]
      return {
        action,
        lifecycleAllowed: true,
        executable: false,
        disabledReason: attentionReason('GOVERNED_RUNTIME_CONTROL_UNAVAILABLE', unavailableRefs),
        sourceRefs: boundedSourceRefs(unavailableRefs),
      }
    }
    return {
      action,
      lifecycleAllowed: true,
      executable: true,
      disabledReason: null,
      sourceRefs: boundedSourceRefs([...refs, ruleSource('ACTION_CONTEXT_VERIFIED')]),
    }
  })
}

export function toEventView(row: EventRow): EventView {
  return {
    seq: row.seq,
    eventId: row.event_id,
    type: row.event_type,
    actorRole: row.actor_role,
    actorId: row.actor_id,
    targetType: row.target_type,
    targetId: row.target_id,
    payload: sanitizePublicJsonObject(parseJson(row.payload_json)),
    createdAt: row.created_at,
  }
}

export function toBindingView(row: RoleBindingRow): BindingView {
  const profile = parseExecutionProfile(row.execution_profile_json)
  return {
    bindingId: row.binding_id,
    roleType: row.role_type,
    roleName: row.role_name,
    runtimeType: row.runtime_type,
    sessionDisplay: maskSessionId(row.session_id),
    sessionBound: Boolean(row.session_id),
    modelName: row.model_name === null ? null : sanitizePublicJsonString(row.model_name, 'private-config'),
    agentName: row.agent_name === null ? null : sanitizePublicJsonString(row.agent_name, 'private-config'),
    sessionMeta: row.session_meta ? sanitizePublicJsonObject(parseJson(row.session_meta)) : null,
    executionProfile: profile ? {
      provider: profile.provider === undefined ? null : sanitizePublicJsonString(profile.provider, 'private-config'),
      model: profile.model === undefined ? null : sanitizePublicJsonString(profile.model, 'private-config'),
    } : null,
    createdAt: row.created_at,
  }
}

/**
 * v0.5.2（M1-B/P0-C）：会话标识脱敏——公共 GUI 读面只暴露尾部（如 `…8f21`）。
 * Event payload 和 Binding session metadata 也必须经过递归有界脱敏。
 */
function maskSessionId(id: string | null): string | null {
  if (!id) return null
  return id.length > 8 ? `…${id.slice(-8)}` : REDACTED_JSON_VALUE
}

export function toTerritoryView(row: TerritoryRow): TerritoryView {
  return {
    territoryId: row.territory_id,
    name: row.name,
    workspacePath: row.workspace_path === null ? null : sanitizePublicJsonString(row.workspace_path),
    summary: row.summary === null ? null : sanitizePublicJsonString(row.summary),
    status: row.status,
    createdAt: row.created_at,
  }
}

function toTaskAssignmentHistoryView(row: TaskAssignmentRow): TaskAssignmentHistoryView {
  return {
    assignmentId: publicReferenceId(row.assignment_id) ?? 'unknown',
    workerBindingId: publicReferenceId(row.worker_binding_id) ?? 'unknown',
    assignedByBindingId: publicReferenceId(row.assigned_by) ?? 'unknown',
    assignedAt: safeDate(row.assigned_at),
    endedAt: safeDate(row.ended_at),
    endReason: row.end_reason ? boundedText(row.end_reason) || null : null,
    previousAssignmentId: publicReferenceId(row.previous_assignment_id),
    handoffReason: row.handoff_reason ? boundedText(row.handoff_reason) || null : null,
    sourceRefs: boundedSourceRefs([tableSource('task_assignments', row.assignment_id)]),
  }
}

function toSupervisorDecisionView(row: EventRow): SupervisorDecisionView {
  const payload = parseJson(row.payload_json)
  const payloadReference = (value: unknown): string | null => typeof value === 'string' ? publicReferenceId(value) : null
  const payloadText = (value: unknown): string | null => {
    if (typeof value !== 'string') return null
    return boundedText(value) || null
  }
  const handoff = row.event_type === 'TASK_HANDED_OFF'
  const eventSupervisorId = row.actor_role === 'SUPERVISOR' ? publicReferenceId(row.actor_id) : null
  const reviewerBindingId = handoff
    ? eventSupervisorId
    : payloadReference(payload.reviewer_binding_id) ?? eventSupervisorId
  const fromAssignmentId = handoff ? payloadReference(payload.from_assignment_id) : null
  const fromWorkerBindingId = handoff ? payloadReference(payload.from_worker_binding_id) : null
  const toAssignmentId = handoff ? payloadReference(payload.to_assignment_id) : null
  const toWorkerBindingId = handoff ? payloadReference(payload.to_worker_binding_id) : null
  const reviewedAttemptNo = typeof payload.reviewed_attempt_no === 'number'
    && Number.isSafeInteger(payload.reviewed_attempt_no)
    && payload.reviewed_attempt_no >= 0
    ? payload.reviewed_attempt_no
    : null
  const refs = [
    eventSource(row.seq),
    tableSource('tasks', row.target_id),
    ...(reviewerBindingId ? [tableSource('role_bindings', reviewerBindingId)] : []),
    ...(fromAssignmentId ? [tableSource('task_assignments', fromAssignmentId)] : []),
    ...(fromWorkerBindingId ? [tableSource('role_bindings', fromWorkerBindingId)] : []),
    ...(toAssignmentId ? [tableSource('task_assignments', toAssignmentId)] : []),
    ...(toWorkerBindingId ? [tableSource('role_bindings', toWorkerBindingId)] : []),
  ]
  return {
    seq: row.seq,
    decision: handoff ? 'HANDOFF' : payloadText(payload.decision) ?? (boundedText(row.event_type) || 'UNKNOWN'),
    reason: payloadText(handoff ? payload.handoff_reason : payload.reason),
    reviewerBindingId,
    reviewedAttemptNo,
    claimedOutcome: handoff ? null : payloadText(payload.claimed_outcome),
    fromAssignmentId,
    fromWorkerBindingId,
    toAssignmentId,
    toWorkerBindingId,
    sourceRefs: boundedSourceRefs(refs),
    createdAt: row.created_at,
  }
}

export function toClaimView(row: WorkerResultRow): ClaimView {
  const payload = parseJson(row.result_json)
  return {
    resultId: row.result_id,
    attemptNo: row.attempt_no,
    workerBindingId: row.worker_binding_id,
    sessionId: maskSessionId(row.session_id),
    claimedOutcome: row.outcome,
    summary: typeof payload.summary === 'string' ? sanitizePublicJsonString(payload.summary) : null,
    artifacts: sanitizePublicStringList(payload.artifacts),
    risks: sanitizePublicStringList(payload.risks),
    createdAt: row.created_at,
  }
}

export function toExecutionView(row: ExecutionRow): ExecutionView {
  return {
    executionId: row.execution_id,
    taskId: row.task_id,
    attemptNo: row.attempt_no,
    workerBindingId: row.worker_binding_id,
    sessionId: maskSessionId(row.session_id),
    state: row.state,
    detail: row.detail === null ? null : sanitizePublicJsonString(row.detail),
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    endedAt: row.ended_at,
    pausePending: row.pause_requested_at !== null && row.state === 'RUNNING',
    // v0.8（M3-S2 v6）
    executionContract: row.execution_contract,
    leaseId: row.lease_id,
    capabilityDecisionId: row.capability_decision_id,
  }
}

// ── v0.8 Runtime Governance 投影（§32）──────────────────────────

function emptyGovernance(): RuntimeGovernanceView {
  return { workerSessions: [], leases: [], decisions: [], dispatches: [] }
}

function toAffinityView(row: import('../core/db.js').AffinityRow): AffinityView {
  return {
    affinityId: row.affinity_id,
    workerBindingId: row.worker_binding_id,
    sessionDisplay: maskSessionId(row.session_ref),
    runtimeType: row.runtime_type,
    territoryId: row.territory_id,
    isCurrent: row.is_current === 1,
    establishedAt: row.established_at,
    retiredAt: row.retired_at,
  }
}

function toLeaseView(row: import('../core/db.js').LeaseRow): LeaseView {
  return {
    leaseId: row.lease_id,
    taskId: row.task_id,
    attemptNo: row.attempt_no,
    workerBindingId: row.worker_binding_id,
    sessionDisplay: maskSessionId(row.session_ref),
    territoryId: row.territory_id,
    state: row.state,
    capabilityDecisionId: row.capability_decision_id,
    hasPlan: row.enforcement_plan_snapshot !== null,
    hasReleaseEvidence: row.release_evidence_json !== null,
    acquiredAt: row.acquired_at,
    releasedAt: row.released_at,
  }
}

function toDecisionView(row: import('../core/db.js').CapabilityDecisionRow): CapabilityDecisionView {
  return {
    decisionId: row.decision_id,
    taskId: row.task_id,
    decision: row.decision,
    enforcementStatus: row.enforcement_status,
    requirementCoverage: row.requirement_coverage,
    reasonCode: row.reason_code,
    hasEvidence: row.enforcement_evidence_json !== null,
    createdAt: row.created_at,
  }
}

function toDispatchView(row: import('../core/db.js').DispatchRecordRow): DispatchView {
  return {
    dispatchId: row.dispatch_id,
    leaseId: row.lease_id,
    executionId: row.execution_id,
    taskId: row.task_id,
    attemptNo: row.attempt_no,
    state: row.state,
    runtimeDispatchRef: row.runtime_dispatch_ref,
    runtimeExecutionRef: row.runtime_execution_ref,
    hasReceipt: row.receipt_json !== null,
    hasTerminalEvidence: row.terminal_evidence_json !== null,
    createdAt: row.created_at,
  }
}

/** 王国级 Runtime Governance 投影；schema 非 v4 时返回空视图。 */
export function buildGovernance(store: KingdomStore, kingdomId: string): RuntimeGovernanceView {
  if (!store.isSchemaV4) return emptyGovernance()
  return {
    workerSessions: store.listAffinities(kingdomId).map(toAffinityView),
    leases: store.listLeases(kingdomId).map(toLeaseView),
    decisions: store.listCapabilityDecisions(kingdomId).map(toDecisionView),
    dispatches: store.listDispatches(kingdomId).map(toDispatchView),
  }
}

/** 任务级 Runtime Governance 投影（TaskDetail 用）。 */
export function buildTaskGovernance(store: KingdomStore, taskId: string): RuntimeGovernanceView {
  if (!store.isSchemaV4) return emptyGovernance()
  return {
    workerSessions: [],
    leases: store.listLeases(store.getDefaultKingdom()?.kingdom_id ?? '').filter(l => l.task_id === taskId).map(toLeaseView),
    decisions: store.listCapabilityDecisions(store.getDefaultKingdom()?.kingdom_id ?? '').filter(d => d.task_id === taskId).map(toDecisionView),
    dispatches: store.listDispatches(store.getDefaultKingdom()?.kingdom_id ?? '').filter(d => d.task_id === taskId).map(toDispatchView),
  }
}

/**
 * 任务当前允许的下一步动作。
 *
 * 这是 GUI 按钮可用性的**唯一**依据——GUI 不应自己从 status 推断，
 * 否则状态机一改按钮就错。
 */
export function allowedActionsFor(task: TaskRow, execution: ExecutionRow | null): AllowedAction[] {
  const status = asTaskStatus(task.status)
  const executionState = execution ? asExecutionState(execution.state) : null
  const live = executionState !== null && isLiveExecutionState(executionState)
  switch (status) {
    case 'CREATED':
      return ['assign']
    case 'ASSIGNED':
      return isGovernedStartBlocked(execution) ? [] : ['start']
    case 'RUNNING': {
      // RECOVERING means the Runtime outcome is unknown. Exposing start here would
      // invite a duplicate attempt before reconciliation, so the projection fails closed.
      if (executionState === 'RECOVERING') return []
      if (execution === null || !live) {
        // REWORK 之后：任务已回 RUNNING，但还没有新的 Execution。
        return ['start']
      }
      const actions: AllowedAction[] = ['execution:abort']
      if (executionState === 'PAUSED') actions.unshift('execution:resume')
      else if (execution.pause_requested_at === null) actions.unshift('execution:pause')
      else if (execution.execution_contract === 'LEGACY_COMPAT') actions.unshift('execution:resume')
      return actions
    }
    case 'REVIEW':
      return ['review:accept', 'review:rework', 'review:fail', 'review:handoff']
    default:
      return []
  }
}

export function toTaskView(store: KingdomStore, task: TaskRow): TaskView {
  const claim = store.latestWorkerResult(task.task_id)
  const execution = store.latestExecution(task.task_id)
  return {
    taskId: task.task_id,
    territoryId: task.territory_id,
    title: task.title,
    description: task.description,
    acceptanceCriteria: task.acceptance_criteria,
    status: task.status,
    assignedBindingId: task.assigned_binding_id,
    resultSummary: task.result_summary === null ? null : sanitizePublicJsonString(task.result_summary),
    attemptCount: store.maxAttemptNo(task.task_id),
    latestClaim: claim ? toClaimView(claim) : null,
    latestExecution: execution ? toExecutionView(execution) : null,
    allowedActions: allowedActionsFor(task, execution),
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  }
}

// ── 表演语义投影 ─────────────────────────────────────────────────

interface StageInput {
  bindings: RoleBindingRow[]
  territories: TerritoryRow[]
  tasks: TaskRow[]
  executions: ExecutionRow[]
  events: EventRow[]
  nowMs: number
  transientWindowMs: number
}

function eventBindingId(input: StageInput, event: EventRow, role: ActorRole): string | null {
  const payload = parseJson(event.payload_json)
  const payloadBindingId = (key: string): string | null => {
    const value = payload[key]
    return typeof value === 'string' ? value : null
  }

  if (role === 'WORKER') {
    const explicit = payloadBindingId('worker_binding_id')
      ?? payloadBindingId('to_worker_binding_id')
    if (explicit) return explicit

    // TASK_ACCEPTED is emitted by the Supervisor and carries no worker field;
    // the task's current assigned_binding_id is the exact binding relation for
    // that task. Do not use Task.RUNNING as a live execution signal here.
    if (event.event_type === 'TASK_ACCEPTED') {
      return input.tasks.find(task => task.task_id === event.target_id)?.assigned_binding_id ?? null
    }
    return event.actor_role === 'WORKER' ? event.actor_id : null
  }

  if (role === 'SUPERVISOR') {
    return event.actor_role === 'SUPERVISOR'
      ? event.actor_id
      : payloadBindingId('reviewer_binding_id') ?? payloadBindingId('supervisor_binding_id')
  }

  if (role === 'CHANCELLOR') {
    return event.actor_role === 'CHANCELLOR'
      ? event.actor_id
      : payloadBindingId('chancellor_binding_id')
  }

  return event.actor_role === 'OWNER' ? event.actor_id : null
}

function activeBindingFor(input: StageInput, bindingId: string): RoleBindingRow | null {
  return input.bindings.find(binding =>
    binding.binding_id === bindingId && binding.status === 'ACTIVE',
  ) ?? null
}

function eventTask(input: StageInput, event: EventRow): TaskRow | null {
  if (!event.target_id) return null
  if (event.target_type !== null && event.target_type !== 'task') return null
  return input.tasks.find(task => task.task_id === event.target_id) ?? null
}

/**
 * A transient event is usable only when its actor, role, task assignment, and
 * territory scope all agree. This prevents one recent event from broadcasting
 * to every Supervisor/Worker in the kingdom.
 */
function eventMatchesBinding(
  input: StageInput,
  event: EventRow,
  role: ActorRole,
  bindingId: string,
): boolean {
  const binding = activeBindingFor(input, bindingId)
  if (!binding || binding.role_type !== role) return false
  if (eventBindingId(input, event, role) !== bindingId) return false

  if (role === 'OWNER') return true

  const task = eventTask(input, event)
  if (!task) return false
  const territory = input.territories.find(item => item.territory_id === task.territory_id)
  if (!territory) return false

  if (role === 'CHANCELLOR') {
    return event.actor_role === 'CHANCELLOR'
  }

  if (role === 'SUPERVISOR') {
    return territory.supervisor_binding_id === bindingId
      && event.actor_role === 'SUPERVISOR'
  }

  // Worker transient evidence must point to the task's exact current
  // assignment. The canonical WORKER_EXECUTION_FAILED event is emitted by
  // the Supervisor and carries the affected Worker in payload, so both actor
  // scope and payload binding must agree.
  if (task.assigned_binding_id !== bindingId) return false
  if (event.event_type === 'WORKER_EXECUTION_FAILED') {
    if (event.actor_role !== 'SUPERVISOR' || !event.actor_id) return false
    const supervisorBinding = activeBindingFor(input, event.actor_id)
    return supervisorBinding?.role_type === 'SUPERVISOR'
      && supervisorBinding.binding_id === territory.supervisor_binding_id
  }
  if (event.event_type === 'TASK_ASSIGNED' || event.event_type === 'TASK_ACCEPTED') {
    return event.actor_role === 'SUPERVISOR' && territory.supervisor_binding_id === event.actor_id
  }
  return event.actor_role === 'WORKER'
}

function latestWithinFor(
  input: StageInput,
  types: string[],
  role: ActorRole,
  bindingId: string,
): EventRow | null {
  for (const event of input.events) {
    if (!types.includes(event.event_type) || !eventMatchesBinding(input, event, role, bindingId)) continue
    const age = input.nowMs - Date.parse(event.created_at)
    if (Number.isNaN(age)) continue
    return age <= input.transientWindowMs ? event : null
  }
  return null
}

function actor(
  role: ActorRole,
  binding: RoleBindingRow | null,
  state: ActorState,
  activity: ActorActivity,
  extra: Partial<StageActorView> = {},
): StageActorView {
  return {
    role,
    bindingId: binding?.binding_id ?? null,
    roleName: binding?.role_name ?? null,
    state,
    activity,
    taskId: null,
    executionId: null,
    attemptNo: null,
    since: null,
    transient: false,
    remainingMs: null,
    fallbackState: 'idle',
    sourceSeq: null,
    indeterminate: false,
    ...extra,
  }
}

function transientFrom(input: StageInput, event: EventRow): Pick<StageActorView, 'transient' | 'remainingMs' | 'since' | 'sourceSeq'> {
  const elapsed = input.nowMs - Date.parse(event.created_at)
  return {
    transient: true,
    remainingMs: Math.max(0, input.transientWindowMs - elapsed),
    since: event.created_at,
    sourceSeq: event.seq,
  }
}

/**
 * 宰相：只负责规划。
 * `TASK_PLANNED` → 短暂播放规划动作，之后回待命。
 */
function chancellorActor(input: StageInput, binding: RoleBindingRow | null): StageActorView {
  if (!binding) return actor('CHANCELLOR', null, 'absent', null)
  const planned = latestWithinFor(input, ['TASK_PLANNED'], 'CHANCELLOR', binding.binding_id)
  if (planned) {
    return actor('CHANCELLOR', binding, 'planning', 'plan', {
      taskId: planned.target_id,
      ...transientFrom(input, planned),
    })
  }
  return actor('CHANCELLOR', binding, 'idle', null)
}

/**
 * 主管：派发、复核、返工、确认。
 *
 * 一组一次性动作**一次性**取最新的那条再分派（见 {@link latestWithin} 的语义说明），
 * 否则「刚 ACCEPT 完」会被「几秒前的派发」盖住。
 * 没有一次性动作时，只要还有任务停在 REVIEW，主管就保持 `reviewing` 循环——
 * 这正好对应"Claim 已到达但尚未成为事实"这个治理状态。
 */
function supervisorActor(input: StageInput, binding: RoleBindingRow | null): StageActorView {
  if (!binding) return actor('SUPERVISOR', null, 'absent', null)

  const recent = latestWithinFor(
    input,
    ['TASK_ASSIGNED', 'TASK_REWORK_REQUESTED', 'TASK_ACCEPTED', 'TASK_FAILED'],
    'SUPERVISOR',
    binding.binding_id,
  )
  if (recent) {
    const common = { taskId: recent.target_id, fallbackState: 'idle' as ActorState, ...transientFrom(input, recent) }
    switch (recent.event_type) {
      case 'TASK_ASSIGNED':
        return actor('SUPERVISOR', binding, 'assigning', 'assign', common)
      case 'TASK_REWORK_REQUESTED':
        return actor('SUPERVISOR', binding, 'reviewing', 'rework', common)
      case 'TASK_ACCEPTED':
        return actor('SUPERVISOR', binding, 'reviewing', 'accept', common)
      default:
        return actor('SUPERVISOR', binding, 'reviewing', 'review', common)
    }
  }
  // 持续状态：有待审 Claim 就一直在复核。
  const pending = input.tasks.find(task => {
    if (task.status !== 'REVIEW') return false
    const territory = input.territories.find(item => item.territory_id === task.territory_id)
    return territory?.supervisor_binding_id === binding.binding_id
  })
  if (pending) {
    return actor('SUPERVISOR', binding, 'reviewing', 'review', {
      taskId: pending.task_id,
      since: pending.updated_at,
    })
  }
  return actor('SUPERVISOR', binding, 'idle', null)
}

/**
 * 骑士（Worker）：**只由 Execution 决定是否在工作**，不看 Task.status。
 *
 * 这是整套映射里最容易搞错的一条：REWORK 之后 Task 立刻回到 RUNNING，
 * 但那时还没有新的 Execution，骑士必须处于 `waiting`（等待新 Execution），
 * 而不能立即假装工作。
 */
function workerActor(input: StageInput, binding: RoleBindingRow | null): StageActorView {
  if (!binding) return actor('WORKER', null, 'absent', null)

  const territoryIds = new Set(
    input.tasks
      .filter(task => task.assigned_binding_id === binding.binding_id)
      .map(task => task.territory_id)
      .filter(territoryId => input.territories.some(territory => territory.territory_id === territoryId)),
  )
  const territoryIndeterminate = territoryIds.size !== 1
  const liveExecutions = input.executions.filter(execution => {
    if (execution.worker_binding_id !== binding.binding_id || !isLiveExecutionState(asExecutionState(execution.state))) return false
    const task = input.tasks.find(item => item.task_id === execution.task_id)
    return task?.assigned_binding_id === binding.binding_id
      && input.territories.some(territory => territory.territory_id === task.territory_id)
  })
  if (liveExecutions.length > 1) {
    return actor('WORKER', binding, 'confused', null, {
      fallbackState: 'idle',
      indeterminate: true,
    })
  }
  const live = liveExecutions[0] ?? null
  if (live) {
    const state = asExecutionState(live.state)
    const common = {
      taskId: live.task_id,
      executionId: live.execution_id,
      attemptNo: live.attempt_no,
      since: live.started_at,
      indeterminate: territoryIndeterminate,
    }
    if (state === 'PAUSED') {
      return actor('WORKER', binding, 'sleeping', null, { ...common, fallbackState: 'sleeping' })
    }
    // STARTING / RUNNING 都算在工作；pausePending 由 ExecutionView 单独暴露，
    // GUI 可以据此播"准备休息"，但**不能**直接播睡觉——那会谎报运行状态。
    return actor('WORKER', binding, 'working', 'execute', { ...common, fallbackState: 'working' })
  }

  // 一次性表演：庆祝（任务刚被 ACCEPT）与困惑（宿主观察到执行没跑起来）。
  // 同样一次性取最新再分派，避免旧事件盖住新事件。
  const recent = latestWithinFor(input, ['TASK_ACCEPTED', 'WORKER_EXECUTION_FAILED'], 'WORKER', binding.binding_id)
  if (recent) {
    const common = { taskId: recent.target_id, fallbackState: 'idle' as ActorState, ...transientFrom(input, recent) }
    return recent.event_type === 'TASK_ACCEPTED'
      ? actor('WORKER', binding, 'celebrating', null, common)
      : actor('WORKER', binding, 'confused', null, common)
  }

  // 任务处于 RUNNING 但没有活跃 Execution = 返工后待命，等新一轮执行。
  const awaiting = input.tasks.find(
    t => t.status === 'RUNNING' && t.assigned_binding_id === binding.binding_id,
  )
  if (awaiting) {
    return actor('WORKER', binding, 'waiting', null, {
      taskId: awaiting.task_id,
      since: awaiting.updated_at,
      indeterminate: territoryIndeterminate,
    })
  }

  return actor('WORKER', binding, 'idle', null, { indeterminate: territoryIndeterminate })
}

/** 计算全部角色此刻的表演语义。 */
export function projectStage(input: StageInput): StageActorView[] {
  const bindingsFor = (role: RoleBindingRow['role_type']): RoleBindingRow[] =>
    input.bindings.filter(binding => binding.role_type === role && binding.status === 'ACTIVE')
  const withAbsentFallback = <T extends ActorRole>(
    role: T,
    bindings: RoleBindingRow[],
    project: (binding: RoleBindingRow | null) => StageActorView,
  ): StageActorView[] => bindings.length > 0
    ? bindings.map(project)
    : [project(null)]

  return [
    ...withAbsentFallback('OWNER', bindingsFor('OWNER'), binding =>
      binding ? actor('OWNER', binding, 'idle', null) : actor('OWNER', null, 'absent', null)),
    ...withAbsentFallback('CHANCELLOR', bindingsFor('CHANCELLOR'), binding => chancellorActor(input, binding)),
    ...withAbsentFallback('SUPERVISOR', bindingsFor('SUPERVISOR'), binding => supervisorActor(input, binding)),
    ...withAbsentFallback('WORKER', bindingsFor('WORKER'), binding => workerActor(input, binding)),
  ]
}

function attentionItem(
  id: string,
  severity: AttentionItem['severity'],
  entityRef: EntityRef | null,
  code: string,
  summary: string,
  refs: SourceRef[],
): AttentionItem {
  const reason = attentionReason(code, refs)
  return {
    id,
    severity,
    entityRef,
    reason,
    summary: boundedText(summary),
    sourceRefs: reason.sourceRefs,
  }
}

function claimExecutionMismatch(claim: WorkerResultRow, execution: ExecutionRow): boolean {
  const expected = claim.outcome === 'COMPLETED' || claim.outcome === 'FAILED' ? claim.outcome : null
  return expected !== null
    && execution.attempt_no === claim.attempt_no
    && executionTerminality(execution.state) === 'TERMINAL'
    && execution.state !== expected
}

/** 固定 reason code 的 Attention 派生；只读，不修复、不重试、不推进状态。 */
export function buildAttention(store: KingdomStore, kingdomId: string): AttentionItem[] {
  const kingdom = store.getDefaultKingdom()
  if (!kingdom || kingdom.kingdom_id !== kingdomId) {
    return [attentionItem(
      'kingdom:missing',
      'UNKNOWN',
      null,
      'CONFIGURATION_INCOMPLETE',
      'Kingdom is not initialized; projection remains UNKNOWN',
      [ruleSource('KINGDOM_PRESENT')],
    )]
  }

  const items: AttentionItem[] = []
  const tasks = store.listTasks(kingdomId)
  for (const task of tasks) {
    const claim = store.latestWorkerResult(task.task_id)
    const execution = store.latestExecution(task.task_id)
    if (claim && execution && claimExecutionMismatch(claim, execution)) {
      items.push(attentionItem(
        timelineId('mismatch', task.task_id),
        'CRITICAL',
        publicEntityRef('task', task.task_id),
        'CLAIM_EXECUTION_MISMATCH',
        `Claim ${boundedText(claim.outcome)} does not match terminal Execution ${boundedText(execution.state)}`,
        [tableSource('worker_results', claim.result_id), tableSource('executions', execution.execution_id)],
      ))
    }
    if (execution?.state === 'RECOVERING') {
      items.push(attentionItem(
        timelineId('execution-recovering', execution.execution_id),
        'UNKNOWN',
        publicEntityRef('task', task.task_id),
        'EXECUTION_RECOVERING',
        'Execution is RECOVERING; reconcile Runtime evidence before any new attempt',
        [tableSource('executions', execution.execution_id), ruleSource('RECOVERING_FAIL_CLOSED')],
      ))
    }
  }

  // v4 是只读地标；非 v4 不访问这些表，也不伪造治理状态。
  if (store.isSchemaV4) {
    for (const decision of store.listCapabilityDecisions(kingdomId)) {
      if (decision.decision !== 'DENIED') continue
      items.push(attentionItem(
        timelineId('decision', decision.decision_id),
        'ATTENTION',
        publicEntityRef('task', decision.task_id),
        'CAPABILITY_DENIED',
        `Capability decision DENIED${decision.reason_code ? ` (${boundedText(decision.reason_code)})` : ''}`,
        [tableSource('capability_decisions', decision.decision_id)],
      ))
    }
    for (const lease of store.listLeases(kingdomId)) {
      if (lease.state !== 'RECOVERING' && !(lease.released_at === null && lease.state === 'TERMINAL')) continue
      items.push(attentionItem(
        timelineId('lease', lease.lease_id),
        'UNKNOWN',
        publicEntityRef('task', lease.task_id),
        'LEASE_NOT_RELEASED',
        `Lease ${boundedText(lease.state)} has no confirmed release`,
        [tableSource('execution_leases', lease.lease_id)],
      ))
    }
    for (const dispatch of store.listDispatches(kingdomId)) {
      if (dispatch.state === 'RECOVERING') {
        items.push(attentionItem(
          timelineId('dispatch', dispatch.dispatch_id),
          'UNKNOWN',
          publicEntityRef('task', dispatch.task_id),
          'LEASE_NOT_RELEASED',
          'Dispatch is RECOVERING; no automatic retry is inferred',
          [tableSource('dispatch_records', dispatch.dispatch_id)],
        ))
      } else if (dispatch.receipt_json !== null && !dispatch.terminal_evidence_json
        && dispatch.state !== 'TERMINAL' && dispatch.state !== 'FAILED') {
        items.push(attentionItem(
          timelineId('terminal', dispatch.dispatch_id),
          'UNKNOWN',
          publicEntityRef('task', dispatch.task_id),
          'TERMINAL_EVIDENCE_MISSING',
          'Dispatch receipt exists but terminal evidence is missing',
          [tableSource('dispatch_records', dispatch.dispatch_id), ruleSource('TERMINAL_EVIDENCE_REQUIRED')],
        ))
      }
    }
  }
  return items.slice(0, MAX_PROJECTION_TIMELINE_ITEMS)
}

function timelineAttention(attentions: AttentionItem[], entityRef: EntityRef | null): AttentionReason | null {
  if (!entityRef) return null
  return attentions.find(item => item.entityRef?.id === entityRef.id)?.reason ?? null
}

function timelineSourceRefKey(ref: SourceRef): string {
  return JSON.stringify([ref.sourceType, ref.entityType, ref.entityId, ref.eventSeq, ref.ruleCode])
}

function sortTimeline(items: TimelineItem[]): TimelineItem[] {
  return [...items].sort((a, b) => {
    const aTime = a.occurredAt ? Date.parse(a.occurredAt) : Number.POSITIVE_INFINITY
    const bTime = b.occurredAt ? Date.parse(b.occurredAt) : Number.POSITIVE_INFINITY
    return (aTime - bTime) || a.id.localeCompare(b.id)
  })
}

function mismatchEvidenceTime(explanation: TimelineItem, items: TimelineItem[]): number {
  const sourceKeys = new Set(
    explanation.sourceRefs
      .filter(ref => ref.sourceType === 'table-row'
        && (ref.entityType === 'worker_results' || ref.entityType === 'executions'))
      .map(timelineSourceRefKey),
  )
  const evidenceTimes = items
    .filter(item => item.id !== explanation.id
      && item.sourceRefs.some(ref => sourceKeys.has(timelineSourceRefKey(ref))))
    .map(item => item.occurredAt ? Date.parse(item.occurredAt) : Number.NaN)
    .filter(Number.isFinite)
  return evidenceTimes.length > 0 ? Math.max(...evidenceTimes) : Number.NEGATIVE_INFINITY
}

function mismatchEvidenceGroups(items: TimelineItem[]): TimelineItem[][] {
  const ordered = sortTimeline(items)
  const newestFirst = [...ordered].reverse()
  return newestFirst
    .filter(item => item.kind === 'DERIVED_EXPLANATION'
      && item.attentionReason?.code === 'CLAIM_EXECUTION_MISMATCH')
    .map(explanation => {
      const sourceKeys = new Set(
        explanation.sourceRefs
          .filter(ref => ref.sourceType === 'table-row'
            && (ref.entityType === 'worker_results' || ref.entityType === 'executions'))
          .map(timelineSourceRefKey),
      )
      const related = newestFirst.filter(item => item.id !== explanation.id
        && item.sourceRefs.some(ref => sourceKeys.has(timelineSourceRefKey(ref))))
      return {
        explanation,
        group: [explanation, ...related],
        evidenceTime: mismatchEvidenceTime(explanation, items),
      }
    })
    .sort((a, b) => (b.evidenceTime - a.evidenceTime)
      // ID is only a deterministic tie-break after actual evidence time; it never represents recency.
      || a.explanation.id.localeCompare(b.explanation.id))
      .map(entry => entry.group)
}

function isMismatchExplanation(item: TimelineItem): boolean {
  return item.kind === 'DERIVED_EXPLANATION'
    && item.attentionReason?.code === 'CLAIM_EXECUTION_MISMATCH'
}

/** 超限时保留最新证据；mismatch 的解释与其 Claim/Execution 成组保留。 */
function retainTimelineEvidence(items: TimelineItem[]): TimelineItem[] {
  const ordered = sortTimeline(items)
  if (ordered.length <= MAX_PROJECTION_TIMELINE_ITEMS) return ordered

  const selected: TimelineItem[] = []
  const selectedIds = new Set<string>()
  const add = (item: TimelineItem): void => {
    if (selected.length >= MAX_PROJECTION_TIMELINE_ITEMS || selectedIds.has(item.id)) return
    selected.push(item)
    selectedIds.add(item.id)
  }
  const addNonMismatch = (item: TimelineItem): void => {
    // Mismatch explanations may only enter through addGroup(), never as an orphan.
    if (isMismatchExplanation(item)) return
    add(item)
  }
  const addGroup = (group: TimelineItem[]): void => {
    const unique = group.filter(item => !selectedIds.has(item.id))
    if (selected.length + unique.length > MAX_PROJECTION_TIMELINE_ITEMS) return
    for (const item of unique) add(item)
  }
  const newestFirst = [...ordered].reverse()

  // A negative explanation is only traceable when its two source rows remain visible too.
  for (const group of mismatchEvidenceGroups(items)) addGroup(group)

  // Keep each existing projection layer represented when it has candidates.
  for (const kind of ['GOVERNANCE_FACT', 'RUNTIME_OBSERVATION', 'WORKER_CLAIM', 'DERIVED_EXPLANATION'] as const) {
    const newest = newestFirst.find(item => item.kind === kind)
    if (newest) addNonMismatch(newest)
  }

  // Fill the remaining bounded capacity from newest to oldest, then restore display order.
  for (const item of newestFirst) addNonMismatch(item)
  return sortTimeline(selected)
}

/** 从现有 row/event/observation 重建 timeline；不是新 Ledger。 */
export function buildTimeline(
  store: KingdomStore,
  kingdomId: string,
  options: { eventLimit?: number; security?: ProjectionSecurityContext } = {},
): TimelineItem[] {
  const attentions = buildAttention(store, kingdomId)
  const items: TimelineItem[] = []
  const events = store.listEvents(kingdomId, Math.min(options.eventLimit ?? 50, MAX_PROJECTION_TIMELINE_ITEMS))
  for (const event of events) {
    const refs = [eventSource(event.seq)]
    const entityRef = event.target_type ? publicEntityRef(event.target_type, event.target_id) : null
    items.push({
      id: `event:${event.seq}`,
      kind: 'GOVERNANCE_FACT',
      occurredAt: safeDate(event.created_at),
      entityRef,
      authoritativeState: stateValue(event.event_type, 'GOVERNANCE_FACT', refs),
      sourceRefs: boundedSourceRefs(refs),
      allowedActions: null,
      attentionReason: timelineAttention(attentions, entityRef),
      terminality: 'UNKNOWN',
      summary: `Governance Fact: ${boundedText(event.event_type)}`,
      requiresOwnerAction: false,
      rawEvidenceAvailable: false,
    })
  }

  for (const task of store.listTasks(kingdomId)) {
    for (const claim of store.listWorkerResults(task.task_id).slice(-10)) {
      const refs = [tableSource('worker_results', claim.result_id)]
      const entityRef = publicEntityRef('task', task.task_id)
      items.push({
        id: timelineId('claim', claim.result_id),
        kind: 'WORKER_CLAIM',
        occurredAt: safeDate(claim.created_at),
        entityRef,
        authoritativeState: null,
        sourceRefs: boundedSourceRefs(refs),
        allowedActions: null,
        attentionReason: timelineAttention(attentions, entityRef),
        terminality: 'UNKNOWN',
        summary: `Worker Claim: ${boundedText(claim.outcome) || 'UNKNOWN'}`,
        requiresOwnerAction: false,
        rawEvidenceAvailable: false,
      })
    }
    for (const execution of store.listExecutions(task.task_id).slice(-10)) {
      const refs = [tableSource('executions', execution.execution_id)]
      const entityRef = publicEntityRef('execution', execution.execution_id)
      items.push({
        id: timelineId('execution', execution.execution_id),
        kind: 'RUNTIME_OBSERVATION',
        occurredAt: safeDate(execution.ended_at ?? execution.started_at),
        entityRef,
        authoritativeState: stateValue(execution.state, 'RUNTIME_OBSERVATION', refs),
        sourceRefs: boundedSourceRefs(refs),
        allowedActions: null,
        attentionReason: timelineAttention(attentions, publicEntityRef('task', task.task_id)),
        terminality: executionTerminality(execution.state),
        summary: `Runtime Observation: ${boundedText(execution.state)} (${boundedText(execution.execution_contract)})`,
        requiresOwnerAction: false,
        rawEvidenceAvailable: false,
      })
    }
  }

  if (store.isSchemaV4) {
    for (const decision of store.listCapabilityDecisions(kingdomId)) {
      const refs = [tableSource('capability_decisions', decision.decision_id)]
      items.push({
        id: timelineId('decision', decision.decision_id),
        kind: 'GOVERNANCE_FACT',
        occurredAt: safeDate(decision.created_at),
        entityRef: publicEntityRef('task', decision.task_id),
        authoritativeState: stateValue(`${decision.decision}/${decision.enforcement_status}`, 'GOVERNANCE_FACT', refs),
        sourceRefs: boundedSourceRefs(refs),
        allowedActions: null,
        attentionReason: timelineAttention(attentions, publicEntityRef('task', decision.task_id)),
        terminality: 'UNKNOWN',
        summary: `Governance Fact: Decision ${boundedText(decision.decision)}`,
        requiresOwnerAction: decision.decision === 'DENIED',
        rawEvidenceAvailable: decision.enforcement_evidence_json !== null,
      })
    }
    for (const lease of store.listLeases(kingdomId)) {
      const refs = [tableSource('execution_leases', lease.lease_id)]
      items.push({
        id: timelineId('lease', lease.lease_id),
        kind: 'GOVERNANCE_FACT',
        occurredAt: safeDate(lease.updated_at ?? lease.acquired_at),
        entityRef: publicEntityRef('task', lease.task_id),
        authoritativeState: stateValue(lease.state, 'GOVERNANCE_FACT', refs),
        sourceRefs: boundedSourceRefs(refs),
        allowedActions: null,
        attentionReason: timelineAttention(attentions, publicEntityRef('task', lease.task_id)),
        terminality: lease.state === 'RELEASED' ? 'TERMINAL' : lease.state === 'RECOVERING' ? 'UNKNOWN' : 'NON_TERMINAL',
        summary: `Governance Fact: Lease ${boundedText(lease.state)}`,
        requiresOwnerAction: lease.state === 'RECOVERING',
        rawEvidenceAvailable: lease.release_evidence_json !== null,
      })
    }
    for (const dispatch of store.listDispatches(kingdomId)) {
      const refs = [tableSource('dispatch_records', dispatch.dispatch_id)]
      items.push({
        id: timelineId('dispatch', dispatch.dispatch_id),
        kind: 'GOVERNANCE_FACT',
        occurredAt: safeDate(dispatch.updated_at ?? dispatch.created_at),
        entityRef: publicEntityRef('task', dispatch.task_id),
        authoritativeState: stateValue(dispatch.state, 'GOVERNANCE_FACT', refs),
        sourceRefs: boundedSourceRefs(refs),
        allowedActions: null,
        attentionReason: timelineAttention(attentions, publicEntityRef('task', dispatch.task_id)),
        terminality: dispatch.state === 'TERMINAL' || dispatch.state === 'FAILED'
          ? 'TERMINAL' : dispatch.state === 'RECOVERING' ? 'UNKNOWN' : 'NON_TERMINAL',
        summary: `Governance Fact: Dispatch ${boundedText(dispatch.state)}`,
        requiresOwnerAction: dispatch.state === 'RECOVERING' || !dispatch.terminal_evidence_json,
        rawEvidenceAvailable: dispatch.receipt_json !== null || dispatch.terminal_evidence_json !== null,
      })
    }
  }

  for (const item of attentions) {
    items.push({
      id: `attention:${item.id}`,
      kind: 'DERIVED_EXPLANATION',
      occurredAt: null,
      entityRef: item.entityRef,
      authoritativeState: null,
      sourceRefs: item.sourceRefs,
      allowedActions: null,
      attentionReason: item.reason,
      terminality: 'UNKNOWN',
      summary: `Derived Explanation: ${boundedText(item.reason.code)} — ${item.summary}`,
      requiresOwnerAction: item.severity !== 'UNKNOWN',
      rawEvidenceAvailable: false,
    })
  }
  return retainTimelineEvidence(items)
}

function ownerActionAvailability(): ActionAvailability[] {
  return OWNER_ONLY_ACTIONS.map(action => {
    const refs = boundedSourceRefs([ruleSource('OWNER_DIRECT_SLASH_ONLY')])
    return {
      action,
      lifecycleAllowed: true,
      executable: false,
      disabledReason: attentionReason('DIRECT_SLASH_REQUIRED', refs),
      sourceRefs: refs,
    }
  })
}

function taskAttention(attentions: AttentionItem[], taskId: string): AttentionReason | null {
  return attentions.find(item => item.entityRef?.type === 'task' && item.entityRef.id === publicReferenceId(taskId))?.reason ?? null
}

/** Task Detail 的只读派生 Envelope；保留旧 TaskDetailView 字段，不复刻状态机。 */
export function buildTaskProjection(
  store: KingdomStore,
  kingdomId: string,
  task: TaskRow,
  options: { nowMs?: number; security?: ProjectionSecurityContext } = {},
): ProjectionEnvelope<TaskProjectionData> {
  const refreshedAt = new Date(options.nowMs ?? Date.now()).toISOString()
  const taskRef = publicEntityRef('task', task.task_id) ?? { type: 'task', id: 'unknown' }
  const statusRefs = [tableSource('tasks', task.task_id)]
  const claim = store.latestWorkerResult(task.task_id)
  const execution = store.latestExecution(task.task_id)
  const actions = buildActionAvailability(store, task, execution, options.security)
  const attentions = buildAttention(store, kingdomId)
  const refs = [...statusRefs]
  if (claim) refs.push(tableSource('worker_results', claim.result_id))
  if (execution) refs.push(tableSource('executions', execution.execution_id))
  const taskAttentionReason = taskAttention(attentions, task.task_id)
  return projectionEnvelope({
    revision: store.revision(kingdomId),
    refreshedAt,
    entityRef: taskRef,
    authoritativeState: stateValue(task.status, 'GOVERNANCE_FACT', statusRefs),
    sourceRefs: refs,
    allowedActions: actions,
    attentionReason: taskAttentionReason,
    data: {
      taskRef,
      status: stateValue(task.status, 'GOVERNANCE_FACT', statusRefs),
      claim: claim ? { outcome: boundedText(claim.outcome) || 'UNKNOWN', sourceRefs: boundedSourceRefs([tableSource('worker_results', claim.result_id)]) } : null,
      execution: execution ? {
        state: boundedText(execution.state) || 'UNKNOWN',
        executionContract: boundedText(execution.execution_contract) || 'UNKNOWN',
        terminality: executionTerminality(execution.state),
        sourceRefs: boundedSourceRefs([tableSource('executions', execution.execution_id)]),
      } : null,
      actionAvailability: actions,
    },
  })
}

function buildOrganizationProjectionData(
  store: KingdomStore,
  kingdomId: string,
  tasks: TaskRow[],
): OrganizationProjectionData {
  const kingdom = store.getDefaultKingdom()
  if (!kingdom || kingdom.kingdom_id !== kingdomId) {
    return {
      kingdomName: null,
      bindingCount: 0,
      territoryCount: 0,
      roles: [],
      territories: [],
      rolesTruncated: false,
      territoriesTruncated: false,
    }
  }

  // Organization is a live role projection, not a historical binding ledger.
  // Retired bindings may remain referenced by old Tasks/Territories, but they
  // must not acquire a territoryRef or enter the console organogram.
  const bindings = store.listBindings(kingdomId).filter(binding => binding.status === 'ACTIVE')
  const territoryRows = store.listTerritories(kingdomId)
  const territoryRefByBinding = new Map<string, EntityRef | null>()
  const registerTerritory = (bindingId: string, territoryId: string): void => {
    const territoryRef = publicEntityRef('territory', territoryId)
    if (!territoryRef) return
    if (!territoryRefByBinding.has(bindingId)) {
      territoryRefByBinding.set(bindingId, territoryRef)
      return
    }
    const previous = territoryRefByBinding.get(bindingId)
    if (previous === undefined) {
      territoryRefByBinding.set(bindingId, territoryRef)
      return
    }
    if (previous === null || previous.id !== territoryRef.id) territoryRefByBinding.set(bindingId, null)
  }
  for (const territory of territoryRows) {
    if (territory.supervisor_binding_id) registerTerritory(territory.supervisor_binding_id, territory.territory_id)
  }
  for (const task of tasks) {
    if (task.assigned_binding_id) registerTerritory(task.assigned_binding_id, task.territory_id)
  }
  for (const binding of bindings) {
    if (binding.role_type !== 'WORKER') continue
    const affinity = store.getCurrentAffinityForWorker(kingdomId, binding.binding_id)
    if (affinity) registerTerritory(binding.binding_id, affinity.territory_id)
  }
  const orderedBindings = [...bindings].sort((left, right) => {
    const statusOrder = Number(right.status === 'ACTIVE') - Number(left.status === 'ACTIVE')
    return statusOrder
      || left.role_type.localeCompare(right.role_type)
      || left.role_name.localeCompare(right.role_name)
      || left.binding_id.localeCompare(right.binding_id)
  })
  const roles: OrganizationRoleSummary[] = []
  for (const binding of orderedBindings) {
    if (roles.length >= MAX_PROJECTION_ORGANIZATION_ITEMS) break
    const bindingRef = publicEntityRef('binding', binding.binding_id)
    if (!bindingRef) continue
    const refs = boundedSourceRefs([tableSource('role_bindings', binding.binding_id)])
    roles.push({
      bindingRef,
      roleType: boundedText(binding.role_type) || 'UNKNOWN',
      roleName: boundedText(binding.role_name) || 'UNKNOWN',
      territoryRef: territoryRefByBinding.get(binding.binding_id) ?? null,
      status: stateValue(binding.status, 'GOVERNANCE_FACT', refs),
      sessionBound: binding.session_id !== null,
      sourceRefs: refs,
    })
  }

  const taskCounts = new Map<string, number>()
  for (const task of tasks) taskCounts.set(task.territory_id, (taskCounts.get(task.territory_id) ?? 0) + 1)
  const territories: OrganizationTerritorySummary[] = []
  for (const territory of territoryRows) {
    if (territories.length >= MAX_PROJECTION_ORGANIZATION_ITEMS) break
    const territoryRef = publicEntityRef('territory', territory.territory_id)
    if (!territoryRef) continue
    const refs = boundedSourceRefs([
      tableSource('territories', territory.territory_id),
      ...(territory.supervisor_binding_id
        ? [tableSource('role_bindings', territory.supervisor_binding_id)]
        : [ruleSource('TERRITORY_SUPERVISOR_MISSING')]),
    ])
    territories.push({
      territoryRef,
      name: boundedText(territory.name) || 'UNKNOWN',
      status: stateValue(territory.status, 'GOVERNANCE_FACT', refs),
      supervisorBindingRef: publicEntityRef('binding', territory.supervisor_binding_id),
      taskCount: taskCounts.get(territory.territory_id) ?? 0,
      sourceRefs: refs,
    })
  }

  return {
    kingdomName: boundedText(kingdom.name) || 'UNKNOWN',
    bindingCount: bindings.length,
    territoryCount: territoryRows.length,
    roles,
    territories,
    rolesTruncated: bindings.length > roles.length,
    territoriesTruncated: territoryRows.length > territories.length,
  }
}

interface ExecutionProjectionCandidate {
  task: TaskRow
  execution: ExecutionRow
  latest: boolean
}

function executionEvidenceTime(execution: ExecutionRow): number {
  const timestamp = Date.parse(execution.ended_at ?? execution.heartbeat_at ?? execution.started_at)
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY
}

function buildExecutionProjectionData(
  store: KingdomStore,
  tasks: TaskRow[],
  attentions: AttentionItem[],
  security: ProjectionSecurityContext | undefined,
): ExecutionProjectionData {
  const candidates: ExecutionProjectionCandidate[] = []
  for (const task of tasks) {
    const executions = store.listExecutions(task.task_id)
    for (let index = 0; index < executions.length; index += 1) {
      candidates.push({ task, execution: executions[index]!, latest: index === executions.length - 1 })
    }
  }
  candidates.sort((left, right) => executionEvidenceTime(right.execution) - executionEvidenceTime(left.execution)
    || right.execution.attempt_no - left.execution.attempt_no
    || left.execution.execution_id.localeCompare(right.execution.execution_id))

  const items: ExecutionProjectionSummary[] = []
  for (const candidate of candidates) {
    if (items.length >= MAX_PROJECTION_EXECUTION_SUMMARIES) break
    const { task, execution, latest } = candidate
    const executionRef = publicEntityRef('execution', execution.execution_id)
    const taskRef = publicEntityRef('task', task.task_id)
    if (!executionRef || !taskRef) continue
    const refs = boundedSourceRefs([
      tableSource('executions', execution.execution_id),
      tableSource('tasks', task.task_id),
      ...(execution.worker_binding_id ? [tableSource('role_bindings', execution.worker_binding_id)] : []),
      ...(execution.lease_id ? [tableSource('execution_leases', execution.lease_id)] : []),
      ...(execution.capability_decision_id
        ? [tableSource('capability_decisions', execution.capability_decision_id)]
        : []),
    ])
    const actionAvailability = latest
      ? buildActionAvailability(store, task, execution, security)
        .filter(action => action.action.startsWith('execution:'))
      : []
    const state = boundedText(execution.state) || 'UNKNOWN'
    items.push({
      executionId: executionRef.id,
      taskId: taskRef.id,
      executionRef,
      taskRef,
      workerBindingRef: publicEntityRef('binding', execution.worker_binding_id),
      attemptNo: Number.isSafeInteger(execution.attempt_no) && execution.attempt_no >= 0
        ? execution.attempt_no
        : 0,
      state,
      authoritativeState: stateValue(state, 'RUNTIME_OBSERVATION', [tableSource('executions', execution.execution_id)]),
      executionContract: boundedText(execution.execution_contract) || 'UNKNOWN',
      terminality: executionTerminality(execution.state),
      pausePending: execution.pause_requested_at !== null && execution.state === 'RUNNING',
      startedAt: safeDate(execution.started_at),
      endedAt: safeDate(execution.ended_at),
      actionAvailability,
      attentionReason: taskAttention(attentions, task.task_id),
      sourceRefs: refs,
    })
  }

  return {
    totalExecutionCount: candidates.length,
    items,
    truncated: candidates.length > items.length,
  }
}

export interface ReadonlyProjectionOptions {
  eventLimit?: number
  nowMs?: number
  security?: ProjectionSecurityContext
}

/** S1 顶层只读 Projection；没有 kingdom 时显式返回 UNKNOWN/空数据。 */
export function buildReadonlySnapshotProjection(
  store: KingdomStore,
  kingdomId: string | null,
  options: ReadonlyProjectionOptions = {},
): ReadonlySnapshotProjection {
  const nowMs = options.nowMs ?? Date.now()
  const refreshedAt = new Date(nowMs).toISOString()
  const kingdom = store.getDefaultKingdom()
  const actualKingdomId = kingdom?.kingdom_id ?? kingdomId ?? ''
  const revision = actualKingdomId ? store.revision(actualKingdomId) : 0
  const kingdomRef = publicEntityRef('kingdom', actualKingdomId)
  const sourceRefs = kingdomRef ? [tableSource('kingdoms', actualKingdomId)] : [ruleSource('KINGDOM_PRESENT')]
  const attentions = actualKingdomId
    ? buildAttention(store, actualKingdomId)
    : [attentionItem('kingdom:missing', 'UNKNOWN', null, 'CONFIGURATION_INCOMPLETE', 'Kingdom is not initialized', [ruleSource('KINGDOM_PRESENT')])]
  const timeline = actualKingdomId
    ? buildTimeline(store, actualKingdomId, options)
    : []
  const tasks = actualKingdomId ? store.listTasks(actualKingdomId) : []
  const activeExecutionCount = actualKingdomId ? store.listLiveExecutions(actualKingdomId).length : 0
  const statusCounts: Record<string, number> = {}
  for (const task of tasks) statusCounts[task.status] = (statusCounts[task.status] ?? 0) + 1
  const organizationData = buildOrganizationProjectionData(store, actualKingdomId, tasks)
  const executionData = buildExecutionProjectionData(store, tasks, attentions, options.security)
  const health = attentions.some(item => item.severity === 'CRITICAL')
    ? 'CRITICAL'
    : attentions.some(item => item.severity === 'ATTENTION')
      ? 'ATTENTION'
      : kingdom ? 'OK' : 'UNKNOWN'
  const topAttention = attentions[0]?.reason ?? null
  const authoritative = kingdom
    ? stateValue('PRESENT', 'GOVERNANCE_FACT', sourceRefs)
    : null
  return {
    overview: projectionEnvelope<OverviewProjectionData>({
      revision,
      refreshedAt,
      entityRef: kingdomRef,
      authoritativeState: authoritative,
      sourceRefs,
      attentionReason: topAttention,
      data: { health, taskCount: tasks.length, activeExecutionCount, statusCounts, ownerActions: ownerActionAvailability() },
    }),
    organization: projectionEnvelope<OrganizationProjectionData>({
      revision,
      refreshedAt,
      entityRef: kingdomRef,
      authoritativeState: authoritative,
      sourceRefs: [...sourceRefs, ruleSource('ORGANIZATION_SUMMARY_DERIVED')],
      attentionReason: topAttention,
      data: organizationData,
    }),
    executions: projectionEnvelope<ExecutionProjectionData>({
      revision,
      refreshedAt,
      entityRef: kingdomRef,
      authoritativeState: null,
      sourceRefs: [...sourceRefs, ruleSource('EXECUTION_SUMMARY_DERIVED')],
      attentionReason: topAttention,
      data: executionData,
    }),
    timeline: projectionEnvelope({
      revision,
      refreshedAt,
      entityRef: kingdomRef,
      authoritativeState: null,
      sourceRefs: [...sourceRefs, ruleSource('TIMELINE_RECONSTRUCTED')],
      data: timeline,
    }),
    attention: projectionEnvelope({
      revision,
      refreshedAt,
      entityRef: kingdomRef,
      authoritativeState: null,
      sourceRefs: [...sourceRefs, ruleSource('ATTENTION_DERIVED')],
      attentionReason: topAttention,
      data: attentions,
    }),
  }
}

// ── 顶层快照 ────────────────────────────────────────────────────

export interface SnapshotOptions {
  auth: AuthView
  eventLimit?: number
  transientWindowMs?: number
  /** 注入的"现在"，仅供测试确定性使用。 */
  nowMs?: number
  /** 缺少完整主体/scope/Host context 时 action 保持 fail-closed。 */
  security?: ProjectionSecurityContext
}

export function buildSnapshot(store: KingdomStore, options: SnapshotOptions): SnapshotView {
  const kingdom = store.getDefaultKingdom()
  const nowMs = options.nowMs ?? Date.now()
  const generatedAt = new Date(nowMs).toISOString()

  if (!kingdom) {
    return {
      schemaVersion: GUI_SCHEMA_VERSION,
      revision: 0,
      generatedAt,
      kingdom: null,
      auth: options.auth,
      bindings: [],
      territories: [],
      tasks: [],
      liveExecutions: [],
      stage: [],
      recentEvents: [],
      governance: emptyGovernance(),
      projection: buildReadonlySnapshotProjection(store, null, {
        eventLimit: options.eventLimit,
        nowMs,
        security: options.security,
      }),
    }
  }

  const kingdomId = kingdom.kingdom_id
  const bindings = store.listBindings(kingdomId)
  const territories = store.listTerritories(kingdomId)
  const tasks = store.listTasks(kingdomId)
  const events = store.listEvents(kingdomId, options.eventLimit ?? 50)
  const liveExecutions = store.listLiveExecutions(kingdomId)

  return {
    schemaVersion: GUI_SCHEMA_VERSION,
    revision: store.revision(kingdomId),
    generatedAt,
    kingdom: {
      kingdomId,
      name: kingdom.name,
      ownerId: kingdom.owner_id,
      ownerName: kingdom.owner_name,
      createdAt: kingdom.created_at,
    },
    auth: options.auth,
    bindings: bindings.map(toBindingView),
    territories: territories.map(toTerritoryView),
    tasks: tasks.map(t => toTaskView(store, t)),
    liveExecutions: liveExecutions.map(toExecutionView),
    stage: projectStage({
      bindings,
      territories,
      tasks,
      executions: liveExecutions,
      events,
      nowMs,
      transientWindowMs: options.transientWindowMs ?? TRANSIENT_WINDOW_MS,
    }),
    recentEvents: events.map(toEventView),
    governance: buildGovernance(store, kingdomId),
    projection: buildReadonlySnapshotProjection(store, kingdomId, {
      eventLimit: options.eventLimit,
      nowMs,
      security: options.security,
    }),
  }
}

export function buildTaskDetail(
  store: KingdomStore,
  kingdomId: string,
  taskId: string,
  options: { nowMs?: number; security?: ProjectionSecurityContext } = {},
): TaskDetailView | null {
  const task = store.getTask(taskId)
  if (!task) return null
  const territory = store.getTerritoryById(task.territory_id)
  if (!territory || territory.kingdom_id !== kingdomId) return null

  const binding = task.assigned_binding_id ? store.getBindingById(task.assigned_binding_id) : null
  const assignments = store.listTaskAssignments(taskId)
  const executions = store.listExecutions(taskId)
  const related = store
    .listEvents(kingdomId, 500)
    .filter(e => e.target_id === taskId)
    .sort((a, b) => a.seq - b.seq)

  const reviews = related
    .filter(e => ['TASK_ACCEPTED', 'TASK_REWORK_REQUESTED', 'TASK_FAILED', 'TASK_HANDED_OFF'].includes(e.event_type))
    .map(toSupervisorDecisionView)

  const view = toTaskView(store, task)
  return {
    schemaVersion: GUI_SCHEMA_VERSION,
    revision: store.revision(kingdomId),
    task: view,
    territory: toTerritoryView(territory),
    assignedBinding: binding ? toBindingView(binding) : null,
    assignments: assignments.map(toTaskAssignmentHistoryView),
    claims: store.listWorkerResults(taskId).map(toClaimView),
    executions: executions.map(toExecutionView),
    reviews,
    relatedEvents: related.map(toEventView),
    allowedActions: view.allowedActions,
    governance: buildTaskGovernance(store, taskId),
    projection: buildTaskProjection(store, kingdomId, task, options),
  }
}
