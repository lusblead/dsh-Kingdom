/**
 * dsh-kingdom — Task 治理闭环（Phase 2）。
 *
 * 五个操作对应五个新工具：plan / assign / start / review / list。
 * 全部状态写入都经 KingdomStore.transitionTask → ./task.ts 的 transition()，
 * 这是全库唯一能改 tasks.status 的路径。
 *
 * ## Phase 2 的治理不变量（Owner 裁决 1/4/6）
 *
 * 1. **Claim ≠ Fact**：Worker 交回结果只让 Task 到 REVIEW，永远不到 DONE。
 * 2. Worker 自称 FAILED 仍然只到 REVIEW —— 那是 Claim；
 *    只有 Supervisor 的 FAIL 决定才让 Task 变成 FAILED（组织事实）。
 * 3. 只有 executor **客观**失败（宿主观察到 subagent 没跑出合法结果）
 *    才由 Core 直接 RUNNING → FAILED，并记 WORKER_EXECUTION_FAILED。
 * 4. 没有任何工具能把 Task 直接置 DONE —— DONE 只有 REVIEW + ACCEPT 一条入口。
 *
 * 角色要求延续 Phase 1 的**声明性**口径：校验“对应 role_type 的 binding 存在”，
 * 不做 session 归属强校验（Phase 1 binding.session_id 常为 null）。
 */
import { randomUUID } from 'node:crypto'
import { asTaskStatus, REVIEW_DECISION_TARGET, type ReviewDecision, type TaskStatus } from './task.js'
import type { KingdomStore, RoleBindingRow, TaskRow } from './db.js'
import type { WorkerContext, WorkerExecutor } from '../worker/executor.js'

/** 操作结果：给模型看的文本 + 供自测/诊断读取的结构化事实。 */
export interface TaskOpResult {
  ok: boolean
  text: string
  task?: TaskRow
}

function now(): string {
  return new Date().toISOString()
}

function appendEvent(
  store: KingdomStore,
  kingdomId: string,
  eventType: string,
  actor: { role: string | null; id: string | null },
  target: { type: string; id: string },
  payload: Record<string, unknown>,
): void {
  store.appendEvent({
    event_id: randomUUID(),
    kingdom_id: kingdomId,
    event_type: eventType,
    actor_role: actor.role,
    actor_id: actor.id,
    target_type: target.type,
    target_id: target.id,
    payload_json: JSON.stringify(payload),
    created_at: now(),
  })
}

/**
 * 声明性角色校验：该 role_type 的 binding 是否存在。
 * 存在即放行（Phase 1 口径），返回该 binding 供事件记录 actor。
 */
function requireRoleBinding(
  store: KingdomStore,
  kingdomId: string,
  roleType: string,
): { ok: true; binding: RoleBindingRow } | { ok: false; text: string } {
  const binding = store.getBindingByRole(kingdomId, roleType)
  if (!binding) {
    return {
      ok: false,
      text: `错误：当前王国没有 ${roleType} 角色绑定，无法执行该操作。`
        + `请先绑定：kingdom_bind_role(role_type="${roleType}")。`,
    }
  }
  return { ok: true, binding }
}

/** 取任务并把 status 收敛为 TaskStatus（未知状态 fail-loud）。 */
function loadTask(
  store: KingdomStore,
  kingdomId: string,
  taskId: string,
): { ok: true; task: TaskRow; status: TaskStatus } | { ok: false; text: string } {
  const task = store.getTask(taskId)
  if (!task) return { ok: false, text: `错误：找不到任务 ${taskId}。` }
  // tasks 无 kingdom_id 列，经 territory 校验王国边界，避免跨王国操作。
  const territory = store.getTerritoryById(task.territory_id)
  if (!territory || territory.kingdom_id !== kingdomId) {
    return { ok: false, text: `错误：任务 ${taskId} 不属于当前王国。` }
  }
  return { ok: true, task, status: asTaskStatus(task.status) }
}

// ── plan（CHANCELLOR）───────────────────────────────────────────

export interface PlanTaskInput {
  kingdomId: string
  territoryId?: string
  title: string
  description?: string
  acceptanceCriteria?: string
}

/** 创建 Task → CREATED。要求 CHANCELLOR binding 存在。 */
export function planTask(store: KingdomStore, input: PlanTaskInput): TaskOpResult {
  const role = requireRoleBinding(store, input.kingdomId, 'CHANCELLOR')
  if (!role.ok) return { ok: false, text: role.text }

  const title = input.title.trim()
  if (!title) return { ok: false, text: '错误：任务标题不能为空。' }

  // territory_id 省略时，王国只有一个领地则默认落到它，否则要求显式指定。
  const territories = store.listTerritories(input.kingdomId)
  if (territories.length === 0) {
    return { ok: false, text: '错误：当前王国还没有领地。请先 kingdom_create_territory。' }
  }
  let territoryId = input.territoryId?.trim()
  if (!territoryId) {
    if (territories.length > 1) {
      return {
        ok: false,
        text: `错误：当前王国有 ${territories.length} 个领地，请显式指定 territory_id。可选：`
          + territories.map(t => `${t.name}(${t.territory_id})`).join('、'),
      }
    }
    territoryId = territories[0]!.territory_id
  } else if (!territories.some(t => t.territory_id === territoryId)) {
    return { ok: false, text: `错误：领地 ${territoryId} 不属于当前王国。` }
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
  appendEvent(store, input.kingdomId, 'TASK_PLANNED',
    { role: 'CHANCELLOR', id: role.binding.binding_id },
    { type: 'task', id: task.task_id },
    { title, territory_id: territoryId, acceptance_criteria: task.acceptance_criteria })

  return {
    ok: true,
    task,
    text: `已创建任务「${title}」（id=${task.task_id}，状态 CREATED）。`
      + `${task.acceptance_criteria ? '' : '\n提示：未设置验收标准，Supervisor 审查时将缺少客观依据。'}`
      + '\n下一步：kingdom_assign_task 派给 Worker。',
  }
}

// ── assign（SUPERVISOR）─────────────────────────────────────────

export interface AssignTaskInput {
  kingdomId: string
  taskId: string
  workerBindingId?: string
}

/** CREATED → ASSIGNED。要求 SUPERVISOR binding 存在，且目标是 WORKER binding。 */
export function assignTask(store: KingdomStore, input: AssignTaskInput): TaskOpResult {
  const role = requireRoleBinding(store, input.kingdomId, 'SUPERVISOR')
  if (!role.ok) return { ok: false, text: role.text }

  const loaded = loadTask(store, input.kingdomId, input.taskId)
  if (!loaded.ok) return { ok: false, text: loaded.text }
  if (loaded.status !== 'CREATED') {
    return { ok: false, text: `错误：任务当前状态为 ${loaded.status}，只有 CREATED 的任务可以派发。` }
  }

  // 未指定则取王国里的 WORKER binding（Phase 1 每种角色至多一个）。
  let worker: RoleBindingRow | null
  if (input.workerBindingId?.trim()) {
    worker = store.getBindingById(input.workerBindingId.trim())
    if (!worker || worker.kingdom_id !== input.kingdomId) {
      return { ok: false, text: `错误：找不到当前王国的绑定 ${input.workerBindingId}。` }
    }
    if (worker.role_type !== 'WORKER') {
      return { ok: false, text: `错误：绑定 ${worker.role_name} 的角色是 ${worker.role_type}，不是 WORKER。` }
    }
  } else {
    worker = store.getBindingByRole(input.kingdomId, 'WORKER')
    if (!worker) {
      return {
        ok: false,
        text: '错误：当前王国没有 WORKER 角色绑定。请先 kingdom_bind_role(role_type="WORKER")。',
      }
    }
  }

  const task = store.transitionTask(loaded.task, 'ASSIGNED', { assigned_binding_id: worker.binding_id })
  appendEvent(store, input.kingdomId, 'TASK_ASSIGNED',
    { role: 'SUPERVISOR', id: role.binding.binding_id },
    { type: 'task', id: task.task_id },
    { worker_binding_id: worker.binding_id, worker_role_name: worker.role_name })

  return {
    ok: true,
    task,
    text: `已把任务「${task.title}」派给 ${worker.role_name}（状态 ASSIGNED）。`
      + '\n下一步：kingdom_start_task 触发 Worker 执行。',
  }
}

// ── start（SUPERVISOR，触发 Worker 执行）─────────────────────────

export interface StartTaskInput {
  kingdomId: string
  taskId: string
}

/**
 * 触发一轮 Worker 执行（执行期间阻塞等待 subagent）。
 *
 * 入口状态两种：
 * - `ASSIGNED`：首轮，先 ASSIGNED → RUNNING。
 * - `RUNNING`：Supervisor 刚判了 REWORK（REVIEW → RUNNING），这里执行第 N 轮。
 *   此时不再做状态转移（RUNNING → RUNNING 非法），直接跑新的 one-shot subagent。
 *
 * 结局只有两种（裁决 6）：
 * - Worker 交回合法结构化 Claim → 落 worker_results → **RUNNING → REVIEW**
 *   （**不论 Claim 自称 COMPLETED 还是 FAILED**）；
 * - executor 客观失败 → **RUNNING → FAILED** + WORKER_EXECUTION_FAILED，且**不落** worker_results
 *   （没有合法 Result 就没有 Claim 可存）。
 */
export async function startTask(
  store: KingdomStore,
  executor: WorkerExecutor,
  input: StartTaskInput,
): Promise<TaskOpResult> {
  const role = requireRoleBinding(store, input.kingdomId, 'SUPERVISOR')
  if (!role.ok) return { ok: false, text: role.text }

  const loaded = loadTask(store, input.kingdomId, input.taskId)
  if (!loaded.ok) return { ok: false, text: loaded.text }
  if (loaded.status !== 'ASSIGNED' && loaded.status !== 'RUNNING') {
    return {
      ok: false,
      text: `错误：任务当前状态为 ${loaded.status}，只有 ASSIGNED（首轮）或 RUNNING（Supervisor 已判 REWORK）可以启动 Worker。`,
    }
  }

  // ASSIGNED → RUNNING；REWORK 轮次已经是 RUNNING，不重复转移。
  let task = loaded.status === 'ASSIGNED'
    ? store.transitionTask(loaded.task, 'RUNNING')
    : loaded.task

  const attemptNo = store.maxAttemptNo(task.task_id) + 1
  const previous = store.latestWorkerResult(task.task_id)
  const reworkReason = attemptNo > 1 ? lastReworkReason(store, input.kingdomId, task.task_id) : undefined

  const context: WorkerContext = {
    task,
    acceptanceCriteria: task.acceptance_criteria,
    attemptNo,
    ...previous ? { prevResultSummary: claimSummary(previous.result_json) } : {},
    ...reworkReason ? { reworkReason } : {},
  }

  appendEvent(store, input.kingdomId, 'WORKER_EXECUTION_STARTED',
    { role: 'SUPERVISOR', id: role.binding.binding_id },
    { type: 'task', id: task.task_id },
    { attempt_no: attemptNo, worker_binding_id: task.assigned_binding_id, executor: executor.kind })

  const outcome = await executor.execute(task, context)

  if (outcome.kind === 'executor-failure') {
    // 宿主观察到的运行事实：subagent/executor 没产出合法 Result。
    // 这不是相信 Worker 的自述，因此 Core 有权直接判 FAILED（裁决 6）。
    task = store.transitionTask(task, 'FAILED')
    appendEvent(store, input.kingdomId, 'WORKER_EXECUTION_FAILED',
      { role: 'SUPERVISOR', id: role.binding.binding_id },
      { type: 'task', id: task.task_id },
      {
        attempt_no: attemptNo,
        worker_binding_id: task.assigned_binding_id,
        session_id: outcome.sessionId,
        executor: executor.kind,
        reason: outcome.reason,
      })
    return {
      ok: false,
      task,
      text: `Worker 执行客观失败（第 ${attemptNo} 次尝试）：${outcome.reason}\n`
        + `任务「${task.title}」已置为 FAILED（终态），并记录 WORKER_EXECUTION_FAILED 事件。\n`
        + '注意：这是宿主观察到的运行事实（executor 未产出合法结果），不是 Worker 的自述。',
    }
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
  task = store.transitionTask(task, 'REVIEW', { result_summary: claim.summary })
  appendEvent(store, input.kingdomId, 'WORKER_RESULT_SUBMITTED',
    { role: 'WORKER', id: task.assigned_binding_id },
    { type: 'task', id: task.task_id },
    {
      attempt_no: attemptNo,
      claimed_outcome: claim.outcome,
      session_id: outcome.sessionId,
      executor: executor.kind,
    })

  return {
    ok: true,
    task,
    text: `Worker 已提交第 ${attemptNo} 次尝试的结果（自称 ${claim.outcome}）。\n`
      + `摘要：${claim.summary}\n`
      + `任务「${task.title}」现在处于 **REVIEW**。\n`
      + '这是一个待审查的 Claim，**尚未成为任务完成事实**。'
      + '请 Supervisor 用 kingdom_review_task 裁定 ACCEPT / REWORK / FAIL。',
  }
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
  kingdomId: string
  taskId: string
  decision: string
  reason?: string
}

/**
 * Supervisor 审查 Worker Claim，把 Claim 转成组织事实。
 *
 * - ACCEPT → DONE（+ TASK_ACCEPTED 事件；**不新增 task_reviews 表**，裁决 4）
 * - REWORK → RUNNING（同一 Worker Binding；下一次 kingdom_start_task 会以 attempt_no+1 起新 session，裁决 5）
 * - FAIL   → FAILED（终态，裁决 6：只有这里能把 Worker 的失败 Claim 变成组织事实）
 */
export function reviewTask(store: KingdomStore, input: ReviewTaskInput): TaskOpResult {
  const role = requireRoleBinding(store, input.kingdomId, 'SUPERVISOR')
  if (!role.ok) return { ok: false, text: role.text }

  const decision = input.decision.trim().toUpperCase()
  if (!(decision in REVIEW_DECISION_TARGET)) {
    return { ok: false, text: `错误：decision 必须是 ACCEPT / REWORK / FAIL 之一，收到 "${input.decision}"。` }
  }
  const verdict = decision as ReviewDecision

  const loaded = loadTask(store, input.kingdomId, input.taskId)
  if (!loaded.ok) return { ok: false, text: loaded.text }
  if (loaded.status !== 'REVIEW') {
    return {
      ok: false,
      text: `错误：任务当前状态为 ${loaded.status}，只有 REVIEW 状态的任务可以审查。`,
    }
  }

  const claim = store.latestWorkerResult(input.taskId)
  const attemptNo = claim?.attempt_no ?? 0
  const reason = input.reason?.trim() || null
  if (verdict !== 'ACCEPT' && !reason) {
    return { ok: false, text: `错误：${verdict} 必须给出 reason（Worker 返工/失败需要可追溯的理由）。` }
  }

  const task = store.transitionTask(loaded.task, REVIEW_DECISION_TARGET[verdict])
  const eventType = verdict === 'ACCEPT'
    ? 'TASK_ACCEPTED'
    : verdict === 'REWORK' ? 'TASK_REWORK_REQUESTED' : 'TASK_FAILED'
  appendEvent(store, input.kingdomId, eventType,
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
      return {
        ok: true,
        task,
        text: `已 ACCEPT 第 ${attemptNo} 次尝试的结果。任务「${task.title}」→ **DONE**（终态）。\n`
          + `Worker 的 Claim 至此才成为组织事实，已记 TASK_ACCEPTED（reviewer=${role.binding.role_name}）。`,
      }
    case 'REWORK':
      return {
        ok: true,
        task,
        text: `已判 REWORK（理由：${reason}）。任务「${task.title}」回到 **RUNNING**，`
          + `保持同一 Worker Binding。\n`
          + `下一步：再次 kingdom_start_task，将以 attempt_no=${attemptNo + 1} 起一个**新的** one-shot subagent session，`
          + '并注入原任务 + 验收标准 + 上一轮摘要 + 本次返工理由。',
      }
    default:
      return {
        ok: true,
        task,
        text: `已判 FAIL（理由：${reason}）。任务「${task.title}」→ **FAILED**（终态）。\n`
          + 'Worker 的失败声明至此才成为组织事实。',
      }
  }
}

// ── list（任意角色，只读）───────────────────────────────────────

export interface ListTasksInput {
  kingdomId: string
  territoryId?: string
  status?: string
}

/** 列出任务真实状态，含 attempt_no 与最新 Claim 摘要。 */
export function listTasks(store: KingdomStore, input: ListTasksInput): string {
  const status = input.status?.trim().toUpperCase()
  const rows = store.listTasks(input.kingdomId, {
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
    const worker = task.assigned_binding_id ? store.getBindingById(task.assigned_binding_id) : null
    lines.push(
      `- [${task.status}] ${task.title}（id=${task.task_id}）`,
      `    领地：${territory?.name ?? task.territory_id}`
      + `｜Worker：${worker?.role_name ?? '未指派'}`
      + `｜尝试次数：${attempts}`,
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
