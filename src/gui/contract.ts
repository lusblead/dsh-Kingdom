/**
 * dsh-kingdom — 插件 ↔ GUI 的线上契约（Phase 3）。
 *
 * ## 唯一架构原则
 *
 * ```text
 * 插件输出治理事实和活动语义
 * GUI 决定使用哪个人物、场景和动画
 * ```
 *
 * 因此本文件里**不会**出现 `chancellor.png`、`sleep.gif`、
 * `sprite.knight.default.forge.work.idle` 之类的美术知识。
 * 插件只输出 `{ role, state, activity }`，这正是 GUI 端 Visual Resolver 的输入
 * （另外两维 `skin` / `scene` 属于 GUI 部署配置，插件不参与）。
 *
 * 角色、模型、工具、运行时与皮肤因此保持解耦：
 * 换一套贴图、换一个场景、把骑士换成别的形象，插件一行都不用改。
 *
 * ## 两类事实必须分开读
 *
 * - `TaskView.status`   —— 治理事实：组织对这件事的裁定进度。
 * - `ExecutionView.state` —— 运行事实：某一次执行此刻的状况。
 *
 * `Task.RUNNING` **不代表**人物正在工作（REWORK 后任务立刻回 RUNNING，
 * 但新 Execution 还没创建）。GUI 判断"是否播放工作动画"必须看 Execution。
 */

/** 组织角色。GUI 自行决定每个角色用哪个人物形象。 */
export const ACTOR_ROLES = ['OWNER', 'CHANCELLOR', 'SUPERVISOR', 'WORKER'] as const

export type ActorRole = (typeof ACTOR_ROLES)[number]

/**
 * 人物状态（Resolver 的 `state` 维）。
 *
 * `absent` 表示该角色没有绑定：GUI 应当**保留组织节点与姓名牌**，只是不渲染人物 Sprite。
 *
 * 这份清单是**契约的一部分**：GUI 侧 Visual Resolver 必须逐个处理它们，
 * 漏掉任何一个都会让人物静默退化成 idle。改动本数组前请同步 GUI。
 */
export const ACTOR_STATES = [
  'absent',
  'idle',
  'planning',
  'assigning',
  'working',
  'sleeping',
  'reviewing',
  'waiting',
  'confused',
  'celebrating',
] as const

export type ActorState = (typeof ACTOR_STATES)[number]

/**
 * 角色专属动作（Resolver 的 `activity` 维）。
 *
 * 这是**语义**而不是动画名：`review` 表示"正在复核"，
 * 至于播哪个 clip 由 GUI 的 visual-map 决定。
 */
export type ActorActivity =
  | 'plan'
  | 'read'
  | 'assign'
  | 'review'
  | 'rework'
  | 'accept'
  | 'execute'
  | null

/** 命令返回的稳定错误码。GUI 据此决定提示与可用按钮，不解析中文文案。 */
export type KingdomErrorCode =
  | 'KINGDOM_NOT_INITIALIZED'
  | 'ROLE_BINDING_MISSING'
  | 'UNAUTHORIZED_PRINCIPAL'
  | 'SESSION_AUTH_REQUIRED'
  | 'TERRITORY_MISSING'
  | 'TERRITORY_AMBIGUOUS'
  | 'TERRITORY_NOT_IN_KINGDOM'
  | 'TASK_NOT_FOUND'
  | 'TASK_NOT_IN_KINGDOM'
  | 'ILLEGAL_TASK_STATE'
  | 'INVALID_INPUT'
  | 'INVALID_DECISION'
  | 'REASON_REQUIRED'
  | 'WORKER_BINDING_INVALID'
  | 'WORKER_AMBIGUOUS'
  | 'TERRITORY_SUPERVISOR_MISSING'
  | 'TASK_OUT_OF_SCOPE'
  | 'EXECUTOR_UNAVAILABLE'
  | 'WORKER_EXECUTION_FAILED'
  | 'CLAIM_INTEGRITY_BLOCKED'
  | 'EXECUTION_NOT_FOUND'
  | 'ILLEGAL_EXECUTION_STATE'

/**
 * v0.5.2（M1-B/P0-B）：GUI 写命令守卫。
 *
 * GUI 网关没有可信 DSH Principal（HTTP payload 的 session_id 一律不再被信任），
 * R02 Owner Control ruling：GUI/HTTP 没有可信 direct Owner capability，
 * 因此所有写命令都 fail-closed；declarative 仅保留为历史 fixture 语义，
 * 不能解锁产品写入。
 */
export function guiWriteGuard(authMode: string): { allowed: true } | { allowed: false; code: 'SESSION_AUTH_REQUIRED' } {
  void authMode
  return { allowed: false, code: 'SESSION_AUTH_REQUIRED' }
}

/** GUI 可以呈现为按钮的下一步动作。 */
export type AllowedAction =
  | 'assign'
  | 'start'
  | 'review:accept'
  | 'review:rework'
  | 'review:fail'
  | 'review:handoff'
  | 'execution:pause'
  | 'execution:resume'
  | 'execution:abort'

/** v0.9 S1：Projection 的可公开、可追溯来源引用。不得放入 raw payload/session/path。 */
export type ProjectionSourceType = 'table-row' | 'event' | 'runtime-evidence' | 'derived-rule'

export interface SourceRef {
  sourceType: ProjectionSourceType
  entityType: string
  entityId: string | null
  eventSeq?: number
  ruleCode?: string
}

export interface EntityRef {
  type: string
  id: string
}

export type ProjectionSourceKind = 'GOVERNANCE_FACT' | 'RUNTIME_OBSERVATION'

export interface AuthoritativeState {
  sourceKind: ProjectionSourceKind
  value: string
  sourceRefs: SourceRef[]
}

export interface AttentionReason {
  code: string
  sourceRefs: SourceRef[]
}

export interface ActionAvailability {
  action: AllowedAction | string
  lifecycleAllowed: boolean
  executable: boolean
  disabledReason: AttentionReason | null
  sourceRefs: SourceRef[]
}

export type ProjectionItemKind =
  | 'GOVERNANCE_FACT'
  | 'RUNTIME_OBSERVATION'
  | 'WORKER_CLAIM'
  | 'DERIVED_EXPLANATION'

export type ProjectionTerminality = 'NON_TERMINAL' | 'TERMINAL' | 'UNKNOWN'

export interface TimelineItem {
  id: string
  kind: ProjectionItemKind
  occurredAt: string | null
  entityRef: EntityRef | null
  authoritativeState: AuthoritativeState | null
  sourceRefs: SourceRef[]
  allowedActions: ActionAvailability[] | null
  attentionReason: AttentionReason | null
  terminality: ProjectionTerminality
  summary: string
  requiresOwnerAction: boolean
  rawEvidenceAvailable: boolean
}

export interface AttentionItem {
  id: string
  severity: 'ATTENTION' | 'CRITICAL' | 'UNKNOWN'
  entityRef: EntityRef | null
  reason: AttentionReason
  summary: string
  sourceRefs: SourceRef[]
}

export interface ProjectionEnvelope<T> {
  revision: number
  refreshedAt: string
  entityRef: EntityRef | null
  authoritativeState: AuthoritativeState | null
  sourceRefs: SourceRef[]
  allowedActions: ActionAvailability[] | null
  attentionReason: AttentionReason | null
  data: T
}

export interface OverviewProjectionData {
  health: 'OK' | 'ATTENTION' | 'CRITICAL' | 'UNKNOWN'
  /** Optional business-facing health wording supplied by the projection/fixture. */
  healthTitle?: string | null
  healthLabel?: string | null
  healthMetrics?: {
    blockedWorkers: number
    frozenTerritories: number
    attentionCount: number
  } | null
  taskCount: number
  activeExecutionCount: number
  statusCounts: Record<string, number>
  ownerActions: ActionAvailability[]
}

/** v1.0：组织页使用的有界角色摘要；不包含 session/model/meta/private path。 */
export interface OrganizationRoleSummary {
  bindingRef: EntityRef
  roleType: string
  roleName: string
  /**
   * Canonical organization scope for this binding when one exact territory is
   * knowable. `null` is intentional for a worker with no current affinity or
   * with conflicting territory evidence; the GUI must keep that actor visible
   * in an explicit unassigned/unknown area.
   */
  territoryRef: EntityRef | null
  status: AuthoritativeState
  sessionBound: boolean
  sourceRefs: SourceRef[]
}

/** v1.0：组织页使用的有界 Territory 摘要；workspace path 永不进入 Projection。 */
export interface OrganizationTerritorySummary {
  territoryRef: EntityRef
  name: string
  status: AuthoritativeState
  supervisorBindingRef: EntityRef | null
  taskCount: number
  sourceRefs: SourceRef[]
}

export interface OrganizationProjectionData {
  kingdomName: string | null
  bindingCount: number
  territoryCount: number
  roles: OrganizationRoleSummary[]
  territories: OrganizationTerritorySummary[]
  rolesTruncated: boolean
  territoriesTruncated: boolean
}

/** v1.0：Execution 导航使用的运行事实摘要；Claim 与治理 Fact 不在此混写。 */
export interface ExecutionProjectionSummary {
  executionId: string
  taskId: string
  executionRef: EntityRef
  taskRef: EntityRef
  workerBindingRef: EntityRef | null
  attemptNo: number
  state: string
  authoritativeState: AuthoritativeState
  executionContract: string
  terminality: ProjectionTerminality
  pausePending: boolean
  startedAt: string | null
  endedAt: string | null
  actionAvailability: ActionAvailability[]
  attentionReason: AttentionReason | null
  sourceRefs: SourceRef[]
}

export interface ExecutionProjectionData {
  totalExecutionCount: number
  items: ExecutionProjectionSummary[]
  truncated: boolean
}

export interface TaskProjectionData {
  taskRef: EntityRef
  status: AuthoritativeState
  claim: { outcome: string; sourceRefs: SourceRef[] } | null
  execution: {
    state: string
    executionContract: string
    terminality: ProjectionTerminality
    sourceRefs: SourceRef[]
  } | null
  actionAvailability: ActionAvailability[]
}

export interface ReadonlySnapshotProjection {
  overview: ProjectionEnvelope<OverviewProjectionData>
  organization: ProjectionEnvelope<OrganizationProjectionData>
  executions: ProjectionEnvelope<ExecutionProjectionData>
  timeline: ProjectionEnvelope<TimelineItem[]>
  attention: ProjectionEnvelope<AttentionItem[]>
}

/**
 * S1 只读派生所需的 Host-only 可验证上下文；缺任一项时 action 必须 fail-closed。
 * `principalSessionId` 由 local-control Host 以 opaque context 注入，不来自浏览器
 * payload，也不表示 Owner principal。
 */
export interface ProjectionSecurityContext {
  principalSessionId?: string | null
  sessionVerified?: boolean
  scope?: string[] | null
  hostContext?: boolean
  commandCoverage?: string[] | null
}

export interface EventView {
  seq: number
  eventId: string
  type: string
  actorRole: string | null
  actorId: string | null
  targetType: string | null
  targetId: string | null
  payload: Record<string, unknown>
  createdAt: string
}

export interface BindingView {
  bindingId: string
  roleType: string
  roleName: string
  runtimeType: string
  /** v0.5.2（M1-B/P0-C）：脱敏后的会话标识（如 …8f21）；完整 id 不进入公共 GUI JSON。 */
  sessionDisplay: string | null
  /** 是否已绑定会话（session-bound 模式下该绑定可被验证身份）。 */
  sessionBound: boolean
  /** v0.4：字段/null shape 兼容；已配置的私有模型值仅返回稳定脱敏标记。 */
  modelName: string | null
  /** 字段/null shape 兼容；已配置的私有 agent 值仅返回稳定脱敏标记。 */
  agentName: string | null
  /** 保留 object/null shape；敏感 key 递归脱敏，深度、条目、节点与字符串均有界。 */
  sessionMeta: Record<string, unknown> | null
  /** v0.6.0（M1-C）：保留 ExecutionProfile 字段 shape；配置值脱敏，null=未配置（回退全局）。 */
  executionProfile: { provider: string | null; model: string | null } | null
  createdAt: string
}

export interface TerritoryView {
  territoryId: string
  name: string
  workspacePath: string | null
  summary: string | null
  status: string
  createdAt: string
}

/** Worker 的一次自述。**是 Claim，不是完成事实。** */
export interface ClaimView {
  resultId: string
  attemptNo: number
  workerBindingId: string | null
  /** 与 BindingView 一致的脱敏 session id；字段 shape 保持兼容。 */
  sessionId: string | null
  /** Worker 自称的结果，仅供展示与审查，不驱动状态。 */
  claimedOutcome: string
  summary: string | null
  artifacts: string[]
  risks: string[]
  createdAt: string
}

/** 运行事实。GUI 判断"人物是否在场/在工作/在休息"只看这个。 */
export interface ExecutionView {
  executionId: string
  taskId: string
  attemptNo: number
  workerBindingId: string | null
  /** 与 BindingView 一致的脱敏 session id；字段 shape 保持兼容。 */
  sessionId: string | null
  state: string
  detail: string | null
  startedAt: string
  heartbeatAt: string | null
  endedAt: string | null
  /**
   * 已登记暂停请求但尚未生效（one-shot 无法在 turn 中途挂起）。
   * GUI 应显示"准备休息"，**不要**直接播睡觉动画——那会谎报状态。
   */
  pausePending: boolean
  /** v0.8（M3-S2 v6）：LEGACY_COMPAT / GOVERNED_PERSISTENT。 */
  executionContract: string
  /** v0.8：governed 关联的 lease / decision（legacy 为 null）。 */
  leaseId: string | null
  capabilityDecisionId: string | null
}

// ── v0.8 Runtime Governance 视图（§32：Worker/Task·Execution/Runtime Governance/Detail）──

/** Worker ↔ Persistent Session ↔ Territory（Affinity Ledger 投影）。 */
export interface AffinityView {
  affinityId: string
  workerBindingId: string
  /** 脱敏 session_ref（与 BindingView 同款掩码）。 */
  sessionDisplay: string | null
  runtimeType: string
  territoryId: string
  isCurrent: boolean
  establishedAt: string
  retiredAt: string | null
}

/** Execution Lease 投影。 */
export interface LeaseView {
  leaseId: string
  taskId: string
  attemptNo: number
  workerBindingId: string
  sessionDisplay: string | null
  territoryId: string
  state: string
  capabilityDecisionId: string | null
  hasPlan: boolean
  hasReleaseEvidence: boolean
  acquiredAt: string
  releasedAt: string | null
}

/** Capability Decision 投影（DENIED 必须显示原因，禁止显示成 Success）。 */
export interface CapabilityDecisionView {
  decisionId: string
  taskId: string
  decision: string
  enforcementStatus: string
  requirementCoverage: string
  reasonCode: string | null
  hasEvidence: boolean
  createdAt: string
}

/** Dispatch Record 投影（RECOVERING 必须如实显示，禁止显示成 Done）。 */
export interface DispatchView {
  dispatchId: string
  leaseId: string
  executionId: string
  taskId: string
  attemptNo: number
  state: string
  runtimeDispatchRef: string | null
  runtimeExecutionRef: string | null
  hasReceipt: boolean
  hasTerminalEvidence: boolean
  createdAt: string
}

export interface RuntimeGovernanceView {
  workerSessions: AffinityView[]
  leases: LeaseView[]
  decisions: CapabilityDecisionView[]
  dispatches: DispatchView[]
}

export interface TaskView {
  taskId: string
  territoryId: string
  title: string
  description: string | null
  acceptanceCriteria: string | null
  /** 治理事实。注意它 !== 人物是否在工作。 */
  status: string
  assignedBindingId: string | null
  /** 最近一次 Claim 的摘要（Claim，不是事实）。 */
  resultSummary: string | null
  attemptCount: number
  latestClaim: ClaimView | null
  latestExecution: ExecutionView | null
  allowedActions: AllowedAction[]
  createdAt: string
  updatedAt: string
}

/** 一个角色此刻应该怎么演。GUI 拿它去查自己的 visual-map。 */
export interface StageActorView {
  role: ActorRole
  bindingId: string | null
  roleName: string | null
  state: ActorState
  activity: ActorActivity
  /** 该状态关联的任务/执行，便于 GUI 做详情联动与人物定位。 */
  taskId: string | null
  executionId: string | null
  attemptNo: number | null
  /** 状态起始时间（ISO）。GUI 可据此对齐动画进度。 */
  since: string | null
  /**
   * 一次性动作（如庆祝、派发、规划）。GUI 播完应回落到 `fallbackState`。
   * 非 transient 的状态是持续循环。
   */
  transient: boolean
  /** transient 状态的剩余毫秒；GUI 可用它决定是否还要播。 */
  remainingMs: number | null
  /** transient 播完后的稳定状态。 */
  fallbackState: ActorState
  /** 触发本状态的事件序号，便于 GUI 丢弃过期事件。 */
  sourceSeq: number | null
  /**
   * Evidence is present but cannot be uniquely attributed (for example two
   * live executions for one binding) or the actor has no exact territory
   * scope. The renderer must not turn this into a live-success claim.
   */
  indeterminate: boolean
}

/** 权限诚实度声明。Beta 若未做主体校验，必须让 GUI 能显示这个徽章。 */
export interface AuthView {
  /**
   * `declarative`：只校验"王国中存在该角色绑定"，**不验证调用者就是该角色**。
   * `session-bound`：额外要求调用方 session 与 binding.session_id 匹配。
   */
  mode: 'declarative' | 'session-bound'
  /**
   * `local-demo`：本地可信演示权限，不构成真实鉴权。
   * GUI **必须**在提供派发/复核/返工按钮时显著标注这一点。
   */
  trustLevel: 'local-demo' | 'session-verified'
  note: string
}

export interface SnapshotView {
  schemaVersion: number
  /** = 最大事件序号。GUI 比较它决定是否重绘；也是增量拉取的游标。 */
  revision: number
  /** 服务端生成快照的时刻（ISO），GUI 用它换算 transient 剩余时间。 */
  generatedAt: string
  kingdom: {
    kingdomId: string
    name: string
    ownerId: string
    ownerName: string
    createdAt: string
  } | null
  auth: AuthView
  bindings: BindingView[]
  territories: TerritoryView[]
  tasks: TaskView[]
  liveExecutions: ExecutionView[]
  /** 每个组织角色此刻的表演语义。 */
  stage: StageActorView[]
  recentEvents: EventView[]
  /** v0.8：Runtime Governance 投影（§32）。Schema 非 v4 时为全空数组。 */
  governance: RuntimeGovernanceView
  /** v1.0：保留四类证据并 additive 增加 Organization / Execution 摘要。 */
  projection: ReadonlySnapshotProjection
}

/** v1.0：Task Detail 的 Assignment Ledger 历史；不包含 session/private payload。 */
export interface TaskAssignmentHistoryView {
  assignmentId: string
  workerBindingId: string
  assignedByBindingId: string
  assignedAt: string | null
  endedAt: string | null
  endReason: string | null
  previousAssignmentId: string | null
  handoffReason: string | null
  sourceRefs: SourceRef[]
}

/** v1.0：从治理事件还原的 Supervisor decision；HANDOFF 字段均为有界公开引用。 */
export interface SupervisorDecisionView {
  seq: number
  decision: string
  reason: string | null
  reviewerBindingId: string | null
  reviewedAttemptNo: number | null
  claimedOutcome: string | null
  fromAssignmentId: string | null
  fromWorkerBindingId: string | null
  toAssignmentId: string | null
  toWorkerBindingId: string | null
  sourceRefs: SourceRef[]
  createdAt: string
}

/** 任务详情：验收标准、尝试历史、Claim、Supervisor 决策、关联事件、下一步动作。 */
export interface TaskDetailView {
  schemaVersion: number
  revision: number
  task: TaskView
  territory: TerritoryView | null
  assignedBinding: BindingView | null
  assignments: TaskAssignmentHistoryView[]
  claims: ClaimView[]
  executions: ExecutionView[]
  /** Supervisor 的历次裁定（从 events 还原，不存在 task_reviews 表）。 */
  reviews: SupervisorDecisionView[]
  relatedEvents: EventView[]
  allowedActions: AllowedAction[]
  /** v0.8：本任务的 Runtime Governance 投影（Lease/Decision/Dispatch）。 */
  governance: RuntimeGovernanceView
  /** v0.9 S1：Task Detail 的只读 Projection Envelope。 */
  projection: ProjectionEnvelope<TaskProjectionData>
}

/** 所有写命令的统一返回。GUI 只读结构化字段，不解析 `message`。 */
export interface CommandResultView {
  ok: boolean
  errorCode: KingdomErrorCode | null
  /** 给人/模型看的中文说明；GUI 可展示但不得据此判断逻辑。 */
  message: string
  task: TaskView | null
  execution: ExecutionView | null
  /** 本次命令产生的事件（已带 seq，升序）。 */
  emittedEvents: EventView[]
  allowedActions: AllowedAction[]
  revision: number
}

/** GUI 契约版本。破坏性变更时递增，GUI 应拒绝不认识的版本。 */
export const GUI_SCHEMA_VERSION = 1

/** transient 表演动作的默认存活窗口（毫秒）。GUI 轮询 1–2s，足够捕捉。 */
export const TRANSIENT_WINDOW_MS = 3500
