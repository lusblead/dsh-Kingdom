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
  | 'EXECUTOR_UNAVAILABLE'
  | 'WORKER_EXECUTION_FAILED'
  | 'EXECUTION_NOT_FOUND'
  | 'ILLEGAL_EXECUTION_STATE'

/**
 * v0.5.2（M1-B/P0-B）：GUI 写命令守卫。
 *
 * GUI 网关没有可信 DSH Principal（HTTP payload 的 session_id 一律不再被信任），
 * 因此 `session-bound` 模式下所有写命令 fail-closed——宁可少一个按钮能用，
 * 也不能让 GUI 伪造治理身份。`declarative` 是本地可信演示模式，保持可用。
 */
export function guiWriteGuard(authMode: string): { allowed: true } | { allowed: false; code: 'SESSION_AUTH_REQUIRED' } {
  return authMode === 'session-bound'
    ? { allowed: false, code: 'SESSION_AUTH_REQUIRED' }
    : { allowed: true }
}

/** GUI 可以呈现为按钮的下一步动作。 */
export type AllowedAction =
  | 'assign'
  | 'start'
  | 'review:accept'
  | 'review:rework'
  | 'review:fail'
  | 'execution:pause'
  | 'execution:resume'
  | 'execution:abort'

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
  /** v0.5.2（M1-B/P0-C）：脱敏后的会话标识（如 …8f21）。完整 session id 只进审计事件面，不出普通快照。 */
  sessionDisplay: string | null
  /** 是否已绑定会话（session-bound 模式下该绑定可被验证身份）。 */
  sessionBound: boolean
  /** v0.4：会话身份预留字段（模型名 / agent 工具名 / 扩展槽），可空。 */
  modelName: string | null
  agentName: string | null
  sessionMeta: Record<string, unknown> | null
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
}

/** 任务详情：验收标准、尝试历史、Claim、Supervisor 决策、关联事件、下一步动作。 */
export interface TaskDetailView {
  schemaVersion: number
  revision: number
  task: TaskView
  territory: TerritoryView | null
  assignedBinding: BindingView | null
  claims: ClaimView[]
  executions: ExecutionView[]
  /** Supervisor 的历次裁定（从 events 还原，不存在 task_reviews 表）。 */
  reviews: {
    seq: number
    decision: string
    reason: string | null
    reviewerBindingId: string | null
    reviewedAttemptNo: number | null
    claimedOutcome: string | null
    createdAt: string
  }[]
  relatedEvents: EventView[]
  allowedActions: AllowedAction[]
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
