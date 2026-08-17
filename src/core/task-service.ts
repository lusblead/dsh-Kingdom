/**
 * dsh-kingdom — Task 治理闭环（Phase 2 语义 + Phase 3 结构化输出）。
 *
 * ## Phase 2 的治理不变量（Owner 裁决 1/4/6，未变）
 *
 * 1. **Claim ≠ Fact**：Worker 交回结果只让 Task 到 REVIEW，永远不到 DONE。
 * 2. Worker 自称 FAILED 仍然只到 REVIEW；只有 Supervisor 的 FAIL 决定才 FAILED。
 * 3. 只有 executor **客观**失败才由 Core 直接 RUNNING → FAILED。
 * 4. 没有任何工具能把 Task 直接置 DONE —— DONE 只有 REVIEW + ACCEPT 一条入口。
 *
 * ## Phase 3 增量（GUI 适配）
 *
 * - 所有写命令返回结构化 {@link CommandResultView}，GUI 不再解析中文字符串。
 * - 每次 Worker 执行独立建 Execution 行（运行事实），与 Task.status（治理事实）分开。
 * - 命令回传本次产生的事件（已带单调 seq），GUI 可直接接到事件流尾部。
 */
import { randomUUID } from 'node:crypto'
import { asTaskStatus, REVIEW_DECISION_TARGET, type ReviewDecision } from './task.js'
import { asExecutionState, isLiveExecutionState } from './execution.js'
import type { EventRow, ExecutionRow, KingdomStore, RoleBindingRow, TaskRow } from './db.js'
import type { WorkerContext, WorkerExecutor } from '../worker/executor.js'
import type { AllowedAction, AuthView, CommandResultView, KingdomErrorCode } from '../gui/contract.js'
import { allowedActionsFor, toEventView, toExecutionView, toTaskView } from '../gui/snapshot.js'

/** 调用主体。Phase 3 的最低鉴权只认 sessionId（见 {@link AuthView}）。 */
export interface Principal {
  sessionId?: string | null
}

export interface CommandContext {
  kingdomId: string
  principal?: Principal
  auth: AuthView
}

function now(): string {
  return new Date().toISOString()
}

/**
 * 收集一条命令产生的全部事件，供 {@link CommandResultView.emittedEvents} 回传。
 *
 * GUI 拿到它就能把新事件直接追加到本地事件流尾部，
 * 不必为了看到自己刚触发的效果而立刻重拉 snapshot。
 */
class EventCollector {
  readonly rows: EventRow[] = []

  constructor(private readonly store: KingdomStore, private readonly kingdomId: string) {}

  emit(
    eventType: string,
    actor: { role: string | null; id: string | null },
    target: { type: string; id: string },
    payload: Record<string, unknown>,
  ): EventRow {
    const row = this.store.appendEvent({
      event_id: randomUUID(),
      kingdom_id: this.kingdomId,
      event_type: eventType,
      actor_role: actor.role,
      actor_id: actor.id,
      target_type: target.type,
      target_id: target.id,
      payload_json: JSON.stringify(payload),
      created_at: now(),
    })
    this.rows.push(row)
    return row
  }
}

function fail(
  store: KingdomStore,
  kingdomId: string,
  errorCode: KingdomErrorCode,
  message: string,
  collector?: EventCollector,
): CommandResultView {
  return {
    ok: false,
    errorCode,
    message,
    task: null,
    execution: null,
    emittedEvents: (collector?.rows ?? []).map(toEventView),
    allowedActions: [],
    revision: store.revision(kingdomId),
  }
}

function succeed(
  store: KingdomStore,
  kingdomId: string,
  message: string,
  task: TaskRow | null,
  execution: ExecutionRow | null,
  collector: EventCollector,
  ok = true,
  errorCode: KingdomErrorCode | null = null,
): CommandResultView {
  const latestExecution = task ? store.latestExecution(task.task_id) : execution
  const actions: AllowedAction[] = task ? allowedActionsFor(task, latestExecution) : []
  return {
    ok,
    errorCode,
    message,
    task: task ? toTaskView(store, task) : null,
    execution: execution ? toExecutionView(execution) : null,
    emittedEvents: collector.rows.map(toEventView),
    allowedActions: actions,
    revision: store.revision(kingdomId),
  }
}

/**
 * 角色校验。
 *
 * `declarative`（Phase 1/2 延续）：只确认王国里存在该角色的 binding，
 * **不验证调用者就是该角色** —— 这是本地可信演示权限，
 * snapshot 的 `auth.trustLevel` 会如实报成 `local-demo`，GUI 必须显著标注。
 *
 * `session-bound`：额外要求调用方 session 与 binding.session_id 一致；
 * binding 未绑定 session 时**拒绝**（无法验证就不放行，不猜）。
 */
function requireRole(
  store: KingdomStore,
  ctx: CommandContext,
  roleType: string,
): { ok: true; binding: RoleBindingRow } | { ok: false; code: KingdomErrorCode; message: string } {
  const binding = store.getBindingByRole(ctx.kingdomId, roleType)
  if (!binding) {
    return {
      ok: false,
      code: 'ROLE_BINDING_MISSING',
      message: `错误：当前王国没有 ${roleType} 角色绑定，无法执行该操作。`
        + `请先绑定：kingdom_bind_role(role_type="${roleType}")。`,
    }
  }
  if (ctx.auth.mode === 'session-bound') {
    const caller = ctx.principal?.sessionId ?? null
    if (!binding.session_id) {
      return {
        ok: false,
        code: 'UNAUTHORIZED_PRINCIPAL',
        message: `错误：${roleType} 绑定未关联 session，session-bound 模式下无法验证调用者身份。`,
      }
    }
    if (caller !== binding.session_id) {
      return {
        ok: false,
        code: 'UNAUTHORIZED_PRINCIPAL',
        message: `错误：当前调用者不是 ${roleType}（session 不匹配），拒绝执行。`,
      }
    }
  }
  return { ok: true, binding }
}

function loadTask(
  store: KingdomStore,
  kingdomId: string,
  taskId: string,
): { ok: true; task: TaskRow } | { ok: false; code: KingdomErrorCode; message: string } {
  const task = store.getTask(taskId)
  if (!task) return { ok: false, code: 'TASK_NOT_FOUND', message: `错误：找不到任务 ${taskId}。` }
  const territory = store.getTerritoryById(task.territory_id)
  if (!territory || territory.kingdom_id !== kingdomId) {
    return { ok: false, code: 'TASK_NOT_IN_KINGDOM', message: `错误：任务 ${taskId} 不属于当前王国。` }
  }
  return { ok: true, task }
}

// ── plan（CHANCELLOR）───────────────────────────────────────────

export interface PlanTaskInput {
  territoryId?: string
  title: string
  description?: string
  acceptanceCriteria?: string
}

/** 创建 Task → CREATED。要求 CHANCELLOR binding。 */
export function planTask(
  store: KingdomStore,
  ctx: CommandContext,
  input: PlanTaskInput,
): CommandResultView {
  const role = requireRole(store, ctx, 'CHANCELLOR')
  if (!role.ok) return fail(store, ctx.kingdomId, role.code, role.message)

  const title = input.title.trim()
  if (!title) return fail(store, ctx.kingdomId, 'INVALID_INPUT', '错误：任务标题不能为空。')

  const territories = store.listTerritories(ctx.kingdomId)
  if (territories.length === 0) {
    return fail(store, ctx.kingdomId, 'TERRITORY_MISSING', '错误：当前王国还没有领地。请先 kingdom_create_territory。')
  }
  let territoryId = input.territoryId?.trim()
  if (!territoryId) {
    if (territories.length > 1) {
      return fail(store, ctx.kingdomId, 'TERRITORY_AMBIGUOUS',
        `错误：当前王国有 ${territories.length} 个领地，请显式指定 territory_id。可选：`
        + territories.map(t => `${t.name}(${t.territory_id})`).join('、'))
    }
    territoryId = territories[0]!.territory_id
  } else if (!territories.some(t => t.territory_id === territoryId)) {
    return fail(store, ctx.kingdomId, 'TERRITORY_NOT_IN_KINGDOM', `错误：领地 ${territoryId} 不属于当前王国。`)
  }

  const ts = now()
  const task: TaskRow = {
    task_id: randomUUID(),
    territory_id: territoryId,
    parent_task_id: null,
    title,
    description: input.description?.trim() || null,
    assigned_binding_id: null,
    status: 'CREATED',
    acceptance_criteria: input.acceptanceCriteria?.trim() || null,
    result_summary: null,
    created_at: ts,
    updated_at: ts,
  }
  store.insertTask(task)

  const collector = new EventCollector(store, ctx.kingdomId)
  collector.emit('TASK_PLANNED',
    { role: 'CHANCELLOR', id: role.binding.binding_id },
    { type: 'task', id: task.task_id },
    { title, territory_id: territoryId, acceptance_criteria: task.acceptance_criteria })

  return succeed(store, ctx.kingdomId,
    `已创建任务「${title}」（id=${task.task_id}，状态 CREATED）。`
    + `${task.acceptance_criteria ? '' : '\n提示：未设置验收标准，Supervisor 审查时将缺少客观依据。'}`
    + '\n下一步：kingdom_assign_task 派给 Worker。',
    task, null, collector)
}

// ── assign（SUPERVISOR）─────────────────────────────────────────

export interface AssignTaskInput {
  taskId: string
  workerBindingId?: string
}

/** CREATED → ASSIGNED。 */
export function assignTask(
  store: KingdomStore,
  ctx: CommandContext,
  input: AssignTaskInput,
): CommandResultView {
  const role = requireRole(store, ctx, 'SUPERVISOR')
  if (!role.ok) return fail(store, ctx.kingdomId, role.code, role.message)

  const loaded = loadTask(store, ctx.kingdomId, input.taskId)
  if (!loaded.ok) return fail(store, ctx.kingdomId, loaded.code, loaded.message)
  const status = asTaskStatus(loaded.task.status)
  if (status !== 'CREATED') {
    return fail(store, ctx.kingdomId, 'ILLEGAL_TASK_STATE',
      `错误：任务当前状态为 ${status}，只有 CREATED 的任务可以派发。`)
  }

  let worker: RoleBindingRow | null
  if (input.workerBindingId?.trim()) {
    worker = store.getBindingById(input.workerBindingId.trim())
    if (!worker || worker.kingdom_id !== ctx.kingdomId) {
      return fail(store, ctx.kingdomId, 'WORKER_BINDING_INVALID',
        `错误：找不到当前王国的绑定 ${input.workerBindingId}。`)
    }
    if (worker.role_type !== 'WORKER') {
      return fail(store, ctx.kingdomId, 'WORKER_BINDING_INVALID',
        `错误：绑定 ${worker.role_name} 的角色是 ${worker.role_type}，不是 WORKER。`)
    }
  } else {
    worker = store.getBindingByRole(ctx.kingdomId, 'WORKER')
    if (!worker) {
      return fail(store, ctx.kingdomId, 'WORKER_BINDING_INVALID',
        '错误：当前王国没有 WORKER 角色绑定。请先 kingdom_bind_role(role_type="WORKER")。')
    }
  }

  const task = store.transitionTask(loaded.task, 'ASSIGNED', { assigned_binding_id: worker.binding_id })
  const collector = new EventCollector(store, ctx.kingdomId)
  collector.emit('TASK_ASSIGNED',
    { role: 'SUPERVISOR', id: role.binding.binding_id },
    { type: 'task', id: task.task_id },
    { worker_binding_id: worker.binding_id, worker_role_name: worker.role_name })

  return succeed(store, ctx.kingdomId,
    `已把任务「${task.title}」派给 ${worker.role_name}（状态 ASSIGNED）。`
    + '\n下一步：kingdom_start_task 触发 Worker 执行。',
    task, null, collector)
}

// ── start（SUPERVISOR，触发 Worker 执行）─────────────────────────

export interface StartTaskInput {
  taskId: string
}

/**
 * 触发一轮 Worker 执行（执行期间阻塞等待 subagent）。
 *
 * 入口状态：`ASSIGNED`（首轮）或 `RUNNING`（Supervisor 刚判 REWORK）。
 *
 * Phase 3 增量：本轮执行会创建一条独立的 Execution 行。
 * Task.status 与 Execution.state 从此分离——
 * GUI 判断"骑士是否在工作"只看后者。
 *
 * 结局仍只有两种（裁决 6）：
 * - 合法结构化 Claim → 落 worker_results → **RUNNING → REVIEW**（无论 Claim 自称成败）；
 * - executor 客观失败 → **RUNNING → FAILED** + `WORKER_EXECUTION_FAILED`，且不落 Claim。
 */
export async function startTask(
  store: KingdomStore,
  executor: WorkerExecutor,
  ctx: CommandContext,
  input: StartTaskInput,
): Promise<CommandResultView> {
  const role = requireRole(store, ctx, 'SUPERVISOR')
  if (!role.ok) return fail(store, ctx.kingdomId, role.code, role.message)

  const loaded = loadTask(store, ctx.kingdomId, input.taskId)
  if (!loaded.ok) return fail(store, ctx.kingdomId, loaded.code, loaded.message)
  const status = asTaskStatus(loaded.task.status)
  if (status !== 'ASSIGNED' && status !== 'RUNNING') {
    return fail(store, ctx.kingdomId, 'ILLEGAL_TASK_STATE',
      `错误：任务当前状态为 ${status}，只有 ASSIGNED（首轮）或 RUNNING（Supervisor 已判 REWORK）可以启动 Worker。`)
  }

  const existing = store.latestExecution(loaded.task.task_id)
  if (existing && isLiveExecutionState(asExecutionState(existing.state))) {
    return fail(store, ctx.kingdomId, 'ILLEGAL_EXECUTION_STATE',
      `错误：该任务已有一个未结束的 Execution（${existing.execution_id}，${existing.state}），不能重复启动。`)
  }

  const collector = new EventCollector(store, ctx.kingdomId)
  let task = status === 'ASSIGNED' ? store.transitionTask(loaded.task, 'RUNNING') : loaded.task

  const attemptNo = store.maxAttemptNo(task.task_id) + 1
  const previous = store.latestWorkerResult(task.task_id)
  const reworkReason = attemptNo > 1 ? lastReworkReason(store, ctx.kingdomId, task.task_id) : undefined

  // ── 建立本轮 Execution（运行事实）──
  let execution = store.insertExecution({
    execution_id: randomUUID(),
    task_id: task.task_id,
    attempt_no: attemptNo,
    worker_binding_id: task.assigned_binding_id,
    session_id: null,
    state: 'STARTING',
    detail: null,
    started_at: now(),
    heartbeat_at: now(),
    ended_at: null,
    pause_requested_at: null,
  })
  collector.emit('SESSION_STARTED',
    { role: 'SUPERVISOR', id: role.binding.binding_id },
    { type: 'execution', id: execution.execution_id },
    { task_id: task.task_id, attempt_no: attemptNo, worker_binding_id: task.assigned_binding_id, executor: executor.kind })

  execution = store.transitionExecution(execution, 'RUNNING')
  collector.emit('WORKER_EXECUTION_STARTED',
    { role: 'SUPERVISOR', id: role.binding.binding_id },
    { type: 'task', id: task.task_id },
    { attempt_no: attemptNo, execution_id: execution.execution_id, worker_binding_id: task.assigned_binding_id, executor: executor.kind })

  const context: WorkerContext = {
    task,
    acceptanceCriteria: task.acceptance_criteria,
    attemptNo,
    ...previous ? { prevResultSummary: claimSummary(previous.result_json) } : {},
    ...reworkReason ? { reworkReason } : {},
  }

  const outcome = await executor.execute(task, context)

  if (outcome.kind === 'executor-failure') {
    // 宿主观察到的运行事实：executor 没产出合法 Result（裁决 6）。
    execution = store.transitionExecution(execution, 'FAILED', {
      detail: outcome.reason,
      sessionId: outcome.sessionId,
    })
    task = store.transitionTask(task, 'FAILED')
    collector.emit('WORKER_EXECUTION_FAILED',
      { role: 'SUPERVISOR', id: role.binding.binding_id },
      { type: 'task', id: task.task_id },
      {
        attempt_no: attemptNo,
        execution_id: execution.execution_id,
        worker_binding_id: task.assigned_binding_id,
        session_id: outcome.sessionId,
        executor: executor.kind,
        reason: outcome.reason,
      })
    collector.emit('SESSION_FAILED',
      { role: 'SUPERVISOR', id: role.binding.binding_id },
      { type: 'execution', id: execution.execution_id },
      { task_id: task.task_id, attempt_no: attemptNo, reason: outcome.reason })

    return succeed(store, ctx.kingdomId,
      `Worker 执行客观失败（第 ${attemptNo} 次尝试）：${outcome.reason}\n`
      + `任务「${task.title}」已置为 FAILED（终态），并记录 WORKER_EXECUTION_FAILED 事件。\n`
      + '注意：这是宿主观察到的运行事实（executor 未产出合法结果），不是 Worker 的自述。',
      task, execution, collector, false, 'WORKER_EXECUTION_FAILED')
  }

  // Claim 到达：落 worker_results，Task 推到 REVIEW —— 而不是 DONE。
  const claim = outcome.result
  store.insertWorkerResult({
    result_id: randomUUID(),
    task_id: task.task_id,
    attempt_no: attemptNo,
    worker_binding_id: task.assigned_binding_id,
    session_id: outcome.sessionId,
    outcome: claim.outcome,
    result_json: JSON.stringify(claim),
    created_at: now(),
  })
  execution = store.transitionExecution(execution, 'COMPLETED', { sessionId: outcome.sessionId })
  task = store.transitionTask(task, 'REVIEW', { result_summary: claim.summary })

  collector.emit('WORKER_RESULT_SUBMITTED',
    { role: 'WORKER', id: task.assigned_binding_id },
    { type: 'task', id: task.task_id },
    {
      attempt_no: attemptNo,
      execution_id: execution.execution_id,
      claimed_outcome: claim.outcome,
      session_id: outcome.sessionId,
      executor: executor.kind,
    })
  // Execution 结束 ≠ 任务完成：GUI 收到它只移除人物 Sprite，组织节点保留。
  collector.emit('SESSION_STOPPED',
    { role: 'WORKER', id: task.assigned_binding_id },
    { type: 'execution', id: execution.execution_id },
    { task_id: task.task_id, attempt_no: attemptNo, reason: 'completed' })

  return succeed(store, ctx.kingdomId,
    `Worker 已提交第 ${attemptNo} 次尝试的结果（自称 ${claim.outcome}）。\n`
    + `摘要：${claim.summary}\n`
    + `任务「${task.title}」现在处于 **REVIEW**。\n`
    + '这是一个待审查的 Claim，**尚未成为任务完成事实**。'
    + '请 Supervisor 用 kingdom_review_task 裁定 ACCEPT / REWORK / FAIL。',
    task, execution, collector)
}

/** 从 events 里取最近一条 REWORK 的理由，注入下一轮 Worker Context（裁决 5）。 */
function lastReworkReason(store: KingdomStore, kingdomId: string, taskId: string): string | undefined {
  for (const event of store.listEvents(kingdomId, 200)) {
    if (event.event_type !== 'TASK_REWORK_REQUESTED' || event.target_id !== taskId) continue
    try {
      const payload = JSON.parse(event.payload_json) as { reason?: unknown }
      return typeof payload.reason === 'string' ? payload.reason : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

/** 从存下来的 Claim JSON 中取 summary，坏 JSON 不致命。 */
function claimSummary(resultJson: string): string | undefined {
  try {
    const parsed = JSON.parse(resultJson) as { summary?: unknown }
    return typeof parsed.summary === 'string' ? parsed.summary : undefined
  } catch {
    return undefined
  }
}

// ── review（SUPERVISOR，唯一能产生 DONE 的路径）──────────────────

export interface ReviewTaskInput {
  taskId: string
  decision: string
  reason?: string
}

/**
 * Supervisor 审查 Worker Claim，把 Claim 转成组织事实。
 *
 * - ACCEPT → DONE（+ TASK_ACCEPTED；不新增 task_reviews 表，裁决 4）
 * - REWORK → RUNNING（同一 Worker Binding；下一次 start 会以 attempt+1 起新 Execution）
 * - FAIL   → FAILED（终态；只有这里能把 Worker 的失败 Claim 变成组织事实）
 */
export function reviewTask(
  store: KingdomStore,
  ctx: CommandContext,
  input: ReviewTaskInput,
): CommandResultView {
  const role = requireRole(store, ctx, 'SUPERVISOR')
  if (!role.ok) return fail(store, ctx.kingdomId, role.code, role.message)

  const decision = input.decision.trim().toUpperCase()
  if (!(decision in REVIEW_DECISION_TARGET)) {
    return fail(store, ctx.kingdomId, 'INVALID_DECISION',
      `错误：decision 必须是 ACCEPT / REWORK / FAIL 之一，收到 "${input.decision}"。`)
  }
  const verdict = decision as ReviewDecision

  const loaded = loadTask(store, ctx.kingdomId, input.taskId)
  if (!loaded.ok) return fail(store, ctx.kingdomId, loaded.code, loaded.message)
  const status = asTaskStatus(loaded.task.status)
  if (status !== 'REVIEW') {
    return fail(store, ctx.kingdomId, 'ILLEGAL_TASK_STATE',
      `错误：任务当前状态为 ${status}，只有 REVIEW 状态的任务可以审查。`)
  }

  const claim = store.latestWorkerResult(input.taskId)
  const attemptNo = claim?.attempt_no ?? 0
  const reason = input.reason?.trim() || null
  if (verdict !== 'ACCEPT' && !reason) {
    return fail(store, ctx.kingdomId, 'REASON_REQUIRED',
      `错误：${verdict} 必须给出 reason（Worker 返工/失败需要可追溯的理由）。`)
  }

  const task = store.transitionTask(loaded.task, REVIEW_DECISION_TARGET[verdict])
  const eventType = verdict === 'ACCEPT'
    ? 'TASK_ACCEPTED'
    : verdict === 'REWORK' ? 'TASK_REWORK_REQUESTED' : 'TASK_FAILED'

  const collector = new EventCollector(store, ctx.kingdomId)
  collector.emit(eventType,
    { role: 'SUPERVISOR', id: role.binding.binding_id },
    { type: 'task', id: task.task_id },
    {
      decision: verdict,
      reason,
      reviewer_binding_id: role.binding.binding_id,
      reviewed_attempt_no: attemptNo,
      claimed_outcome: claim?.outcome ?? null,
    })

  switch (verdict) {
    case 'ACCEPT':
      return succeed(store, ctx.kingdomId,
        `已 ACCEPT 第 ${attemptNo} 次尝试的结果。任务「${task.title}」→ **DONE**（终态）。\n`
        + `Worker 的 Claim 至此才成为组织事实，已记 TASK_ACCEPTED（reviewer=${role.binding.role_name}）。`,
        task, null, collector)
    case 'REWORK':
      return succeed(store, ctx.kingdomId,
        `已判 REWORK（理由：${reason}）。任务「${task.title}」回到 **RUNNING**，保持同一 Worker Binding。\n`
        + `下一步：再次 kingdom_start_task，将以 attempt_no=${attemptNo + 1} 起一个**新的** Execution 与 subagent session。\n`
        + '注意：此刻还没有新的 Execution，Worker 处于等待状态，并不在工作。',
        task, null, collector)
    default:
      return succeed(store, ctx.kingdomId,
        `已判 FAIL（理由：${reason}）。任务「${task.title}」→ **FAILED**（终态）。\n`
        + 'Worker 的失败声明至此才成为组织事实。',
        task, null, collector)
  }
}

// ── Execution 控制（P1：暂停 / 恢复 / 终止）──────────────────────

export interface ExecutionCommandInput {
  executionId: string
  reason?: string
}

function loadExecution(
  store: KingdomStore,
  kingdomId: string,
  executionId: string,
): { ok: true; execution: ExecutionRow; task: TaskRow } | { ok: false; code: KingdomErrorCode; message: string } {
  const execution = store.getExecution(executionId)
  if (!execution) {
    return { ok: false, code: 'EXECUTION_NOT_FOUND', message: `错误：找不到 Execution ${executionId}。` }
  }
  const loaded = loadTask(store, kingdomId, execution.task_id)
  if (!loaded.ok) return loaded
  return { ok: true, execution, task: loaded.task }
}

/**
 * 请求暂停一次执行。
 *
 * **诚实的语义边界**：Worker 是 one-shot subagent，宿主无法在一次 turn 中途
 * 真正挂起它。因此：
 * - 执行**尚未真正开始**（STARTING）→ 直接转 PAUSED，人物可以睡觉；
 * - 执行**正在进行**（RUNNING）→ 只登记 `pause_requested_at`，状态保持 RUNNING，
 *   `ExecutionView.pausePending = true`。GUI 应表现为"准备休息"，
 *   **不能**直接播睡觉动画——那会谎报运行状态。
 */
export function pauseExecution(
  store: KingdomStore,
  ctx: CommandContext,
  input: ExecutionCommandInput,
): CommandResultView {
  const role = requireRole(store, ctx, 'SUPERVISOR')
  if (!role.ok) return fail(store, ctx.kingdomId, role.code, role.message)

  const loaded = loadExecution(store, ctx.kingdomId, input.executionId)
  if (!loaded.ok) return fail(store, ctx.kingdomId, loaded.code, loaded.message)
  const state = asExecutionState(loaded.execution.state)
  if (!isLiveExecutionState(state) || state === 'PAUSED') {
    return fail(store, ctx.kingdomId, 'ILLEGAL_EXECUTION_STATE',
      `错误：Execution 当前为 ${state}，无法暂停。`)
  }

  const collector = new EventCollector(store, ctx.kingdomId)
  let execution = loaded.execution
  if (state === 'STARTING') {
    execution = store.transitionExecution(execution, 'PAUSED', { detail: input.reason ?? null })
    collector.emit('SESSION_PAUSED',
      { role: 'SUPERVISOR', id: role.binding.binding_id },
      { type: 'execution', id: execution.execution_id },
      { task_id: execution.task_id, effective: true, reason: input.reason ?? null })
    return succeed(store, ctx.kingdomId,
      `Execution ${execution.execution_id} 已暂停（PAUSED）。`,
      loaded.task, execution, collector)
  }

  store.setExecutionPauseRequest(execution.execution_id, now())
  execution = store.getExecution(execution.execution_id)!
  collector.emit('SESSION_PAUSED',
    { role: 'SUPERVISOR', id: role.binding.binding_id },
    { type: 'execution', id: execution.execution_id },
    { task_id: execution.task_id, effective: false, reason: input.reason ?? null })
  return succeed(store, ctx.kingdomId,
    `已登记暂停请求。该 Execution 正在运行中，one-shot subagent 无法在 turn 中途挂起，`
    + `因此状态仍是 RUNNING（pausePending=true），暂停将在下一个 attempt 边界生效。`,
    loaded.task, execution, collector)
}

/** 恢复执行：撤销暂停请求，或把 PAUSED 转回 RUNNING。 */
export function resumeExecution(
  store: KingdomStore,
  ctx: CommandContext,
  input: ExecutionCommandInput,
): CommandResultView {
  const role = requireRole(store, ctx, 'SUPERVISOR')
  if (!role.ok) return fail(store, ctx.kingdomId, role.code, role.message)

  const loaded = loadExecution(store, ctx.kingdomId, input.executionId)
  if (!loaded.ok) return fail(store, ctx.kingdomId, loaded.code, loaded.message)
  const state = asExecutionState(loaded.execution.state)
  if (state !== 'PAUSED' && loaded.execution.pause_requested_at === null) {
    return fail(store, ctx.kingdomId, 'ILLEGAL_EXECUTION_STATE',
      `错误：Execution 当前为 ${state} 且无暂停请求，无需恢复。`)
  }

  const collector = new EventCollector(store, ctx.kingdomId)
  let execution = loaded.execution
  if (state === 'PAUSED') {
    execution = store.transitionExecution(execution, 'RUNNING', { pauseRequestedAt: null })
  } else {
    store.setExecutionPauseRequest(execution.execution_id, null)
    execution = store.getExecution(execution.execution_id)!
  }
  collector.emit('SESSION_RESUMED',
    { role: 'SUPERVISOR', id: role.binding.binding_id },
    { type: 'execution', id: execution.execution_id },
    { task_id: execution.task_id })

  return succeed(store, ctx.kingdomId,
    `Execution ${execution.execution_id} 已恢复运行。`, loaded.task, execution, collector)
}

/**
 * 终止一次执行（ABORTED）。
 *
 * 与 FAILED 区分开：ABORTED 是"被显式停止"，FAILED 是"宿主观察到跑不出结果"。
 * 终止只影响运行事实；Task 的治理状态由 Supervisor 另行裁定
 * （任务停在 RUNNING，等待重新 start 或人工处理）。
 * GUI 收到 SESSION_STOPPED 只移除人物 Sprite，**组织节点、姓名牌与详情保留**。
 */
export function abortExecution(
  store: KingdomStore,
  ctx: CommandContext,
  input: ExecutionCommandInput,
): CommandResultView {
  const role = requireRole(store, ctx, 'SUPERVISOR')
  if (!role.ok) return fail(store, ctx.kingdomId, role.code, role.message)

  const loaded = loadExecution(store, ctx.kingdomId, input.executionId)
  if (!loaded.ok) return fail(store, ctx.kingdomId, loaded.code, loaded.message)
  const state = asExecutionState(loaded.execution.state)
  if (!isLiveExecutionState(state)) {
    return fail(store, ctx.kingdomId, 'ILLEGAL_EXECUTION_STATE',
      `错误：Execution 当前为 ${state}（已终结），无法终止。`)
  }

  const execution = store.transitionExecution(loaded.execution, 'ABORTED', {
    detail: input.reason ?? 'aborted by supervisor',
  })
  const collector = new EventCollector(store, ctx.kingdomId)
  collector.emit('SESSION_STOPPED',
    { role: 'SUPERVISOR', id: role.binding.binding_id },
    { type: 'execution', id: execution.execution_id },
    { task_id: execution.task_id, reason: input.reason ?? 'aborted' })

  return succeed(store, ctx.kingdomId,
    `Execution ${execution.execution_id} 已终止（ABORTED）。`
    + `任务「${loaded.task.title}」的治理状态未变（仍为 ${loaded.task.status}），`
    + '需要 Supervisor 另行处置（重新 start 或走审查流程）。',
    loaded.task, execution, collector)
}

// ── list（任意角色，只读）───────────────────────────────────────

export interface ListTasksInput {
  territoryId?: string
  status?: string
}

/** 列出任务真实状态，含 attempt_no 与最新 Claim 摘要（面向模型的文本形式）。 */
export function listTasks(store: KingdomStore, kingdomId: string, input: ListTasksInput = {}): string {
  const status = input.status?.trim().toUpperCase()
  const rows = store.listTasks(kingdomId, {
    ...input.territoryId?.trim() ? { territoryId: input.territoryId.trim() } : {},
    ...status ? { status } : {},
  })
  if (rows.length === 0) {
    return status || input.territoryId
      ? '没有符合条件的任务。'
      : '当前王国还没有任务。可以说“规划一个任务”触发 kingdom_plan_task。'
  }

  const lines: string[] = []
  for (const task of rows) {
    const territory = store.getTerritoryById(task.territory_id)
    const attempts = store.maxAttemptNo(task.task_id)
    const latest = store.latestWorkerResult(task.task_id)
    const execution = store.latestExecution(task.task_id)
    const worker = task.assigned_binding_id ? store.getBindingById(task.assigned_binding_id) : null
    lines.push(
      `- [${task.status}] ${task.title}（id=${task.task_id}）`,
      `    领地：${territory?.name ?? task.territory_id}`
      + `｜Worker：${worker?.role_name ?? '未指派'}`
      + `｜尝试次数：${attempts}`
      + `｜执行：${execution ? `${execution.state}(attempt ${execution.attempt_no})` : '无'}`,
    )
    if (latest) {
      lines.push(
        `    最新 Claim（attempt ${latest.attempt_no}，自称 ${latest.outcome}`
        + `${latest.session_id ? `，session=${latest.session_id}` : ''}）：`
        + `${claimSummary(latest.result_json) ?? '（无摘要）'}`,
      )
    }
    if (task.status === 'REVIEW') {
      lines.push('    ↑ 待 Supervisor 审查：以上是 Worker 的 Claim，尚未成为完成事实。')
    }
  }
  return lines.join('\n')
}
