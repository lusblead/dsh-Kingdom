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
  AllowedAction,
  ActorActivity,
  ActorRole,
  ActorState,
  BindingView,
  ClaimView,
  EventView,
  ExecutionView,
  StageActorView,
  TaskDetailView,
  TaskView,
  TerritoryView,
  SnapshotView,
  AuthView,
} from './contract.js'
import { GUI_SCHEMA_VERSION, TRANSIENT_WINDOW_MS } from './contract.js'
import {
  type EventRow,
  type ExecutionRow,
  type KingdomStore,
  type RoleBindingRow,
  type TaskRow,
  type TerritoryRow,
  type WorkerResultRow,
} from '../core/db.js'
import { asExecutionState, isLiveExecutionState } from '../core/execution.js'
import { asTaskStatus } from '../core/task.js'

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

export function toEventView(row: EventRow): EventView {
  return {
    seq: row.seq,
    eventId: row.event_id,
    type: row.event_type,
    actorRole: row.actor_role,
    actorId: row.actor_id,
    targetType: row.target_type,
    targetId: row.target_id,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
  }
}

export function toBindingView(row: RoleBindingRow): BindingView {
  return {
    bindingId: row.binding_id,
    roleType: row.role_type,
    roleName: row.role_name,
    runtimeType: row.runtime_type,
    sessionId: row.session_id,
    createdAt: row.created_at,
  }
}

export function toTerritoryView(row: TerritoryRow): TerritoryView {
  return {
    territoryId: row.territory_id,
    name: row.name,
    workspacePath: row.workspace_path,
    summary: row.summary,
    status: row.status,
    createdAt: row.created_at,
  }
}

export function toClaimView(row: WorkerResultRow): ClaimView {
  const payload = parseJson(row.result_json)
  return {
    resultId: row.result_id,
    attemptNo: row.attempt_no,
    workerBindingId: row.worker_binding_id,
    sessionId: row.session_id,
    claimedOutcome: row.outcome,
    summary: typeof payload.summary === 'string' ? payload.summary : null,
    artifacts: stringList(payload.artifacts),
    risks: stringList(payload.risks),
    createdAt: row.created_at,
  }
}

export function toExecutionView(row: ExecutionRow): ExecutionView {
  return {
    executionId: row.execution_id,
    taskId: row.task_id,
    attemptNo: row.attempt_no,
    workerBindingId: row.worker_binding_id,
    sessionId: row.session_id,
    state: row.state,
    detail: row.detail,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    endedAt: row.ended_at,
    pausePending: row.pause_requested_at !== null && row.state === 'RUNNING',
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
  const live = execution !== null && isLiveExecutionState(asExecutionState(execution.state))
  switch (status) {
    case 'CREATED':
      return ['assign']
    case 'ASSIGNED':
      return ['start']
    case 'RUNNING': {
      if (!live) {
        // REWORK 之后：任务已回 RUNNING，但还没有新的 Execution。
        return ['start']
      }
      const state = asExecutionState(execution.state)
      const actions: AllowedAction[] = ['execution:abort']
      if (state === 'PAUSED') actions.unshift('execution:resume')
      else if (execution.pause_requested_at === null) actions.unshift('execution:pause')
      return actions
    }
    case 'REVIEW':
      return ['review:accept', 'review:rework', 'review:fail']
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
    resultSummary: task.result_summary,
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
  tasks: TaskRow[]
  executions: ExecutionRow[]
  events: EventRow[]
  nowMs: number
  transientWindowMs: number
}

/**
 * 在窗口期内找出**最近的一条**指定类型事件（events 已按 seq 降序传入）。
 *
 * 注意语义：返回的是这些类型里**最新的那条**，若它已过期则返回 null
 * ——而不是"往前翻到第一条没过期的"。因此调用方必须把一组互斥的候选类型
 * 一次性传进来，再按 `event_type` 分派；分成多次调用会让较早的动作
 * 盖住较晚的动作（例如刚 ACCEPT 完却还在播派发）。
 */
function latestWithin(input: StageInput, types: string[]): EventRow | null {
  for (const event of input.events) {
    if (!types.includes(event.event_type)) continue
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
  const planned = latestWithin(input, ['TASK_PLANNED'])
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

  const recent = latestWithin(input, ['TASK_ASSIGNED', 'TASK_REWORK_REQUESTED', 'TASK_ACCEPTED', 'TASK_FAILED'])
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
  const pending = input.tasks.find(t => t.status === 'REVIEW')
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

  const live = input.executions.find(e => isLiveExecutionState(asExecutionState(e.state)))
  if (live) {
    const state = asExecutionState(live.state)
    const common = {
      taskId: live.task_id,
      executionId: live.execution_id,
      attemptNo: live.attempt_no,
      since: live.started_at,
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
  const recent = latestWithin(input, ['TASK_ACCEPTED', 'WORKER_EXECUTION_FAILED'])
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
    })
  }

  return actor('WORKER', binding, 'idle', null)
}

/** 计算全部角色此刻的表演语义。 */
export function projectStage(input: StageInput): StageActorView[] {
  const byRole = (role: string): RoleBindingRow | null =>
    input.bindings.find(b => b.role_type === role) ?? null

  const owner = byRole('OWNER')
  return [
    owner ? actor('OWNER', owner, 'idle', null) : actor('OWNER', null, 'absent', null),
    chancellorActor(input, byRole('CHANCELLOR')),
    supervisorActor(input, byRole('SUPERVISOR')),
    workerActor(input, byRole('WORKER')),
  ]
}

// ── 顶层快照 ────────────────────────────────────────────────────

export interface SnapshotOptions {
  auth: AuthView
  eventLimit?: number
  transientWindowMs?: number
  /** 注入的"现在"，仅供测试确定性使用。 */
  nowMs?: number
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
    }
  }

  const kingdomId = kingdom.kingdom_id
  const bindings = store.listBindings(kingdomId)
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
    territories: store.listTerritories(kingdomId).map(toTerritoryView),
    tasks: tasks.map(t => toTaskView(store, t)),
    liveExecutions: liveExecutions.map(toExecutionView),
    stage: projectStage({
      bindings,
      tasks,
      executions: liveExecutions,
      events,
      nowMs,
      transientWindowMs: options.transientWindowMs ?? TRANSIENT_WINDOW_MS,
    }),
    recentEvents: events.map(toEventView),
  }
}

export function buildTaskDetail(
  store: KingdomStore,
  kingdomId: string,
  taskId: string,
): TaskDetailView | null {
  const task = store.getTask(taskId)
  if (!task) return null
  const territory = store.getTerritoryById(task.territory_id)
  if (!territory || territory.kingdom_id !== kingdomId) return null

  const binding = task.assigned_binding_id ? store.getBindingById(task.assigned_binding_id) : null
  const executions = store.listExecutions(taskId)
  const related = store
    .listEvents(kingdomId, 500)
    .filter(e => e.target_id === taskId)
    .sort((a, b) => a.seq - b.seq)

  const reviews = related
    .filter(e => ['TASK_ACCEPTED', 'TASK_REWORK_REQUESTED', 'TASK_FAILED'].includes(e.event_type))
    .map((e) => {
      const payload = parseJson(e.payload_json)
      return {
        seq: e.seq,
        decision: typeof payload.decision === 'string' ? payload.decision : e.event_type,
        reason: typeof payload.reason === 'string' ? payload.reason : null,
        reviewerBindingId: typeof payload.reviewer_binding_id === 'string' ? payload.reviewer_binding_id : null,
        reviewedAttemptNo: typeof payload.reviewed_attempt_no === 'number' ? payload.reviewed_attempt_no : null,
        claimedOutcome: typeof payload.claimed_outcome === 'string' ? payload.claimed_outcome : null,
        createdAt: e.created_at,
      }
    })

  const view = toTaskView(store, task)
  return {
    schemaVersion: GUI_SCHEMA_VERSION,
    revision: store.revision(kingdomId),
    task: view,
    territory: toTerritoryView(territory),
    assignedBinding: binding ? toBindingView(binding) : null,
    claims: store.listWorkerResults(taskId).map(toClaimView),
    executions: executions.map(toExecutionView),
    reviews,
    relatedEvents: related.map(toEventView),
    allowedActions: view.allowedActions,
  }
}
