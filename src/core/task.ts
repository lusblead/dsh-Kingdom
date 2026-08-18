/**
 * dsh-kingdom — Task 状态机（Phase 2，Owner 裁决 1）。
 *
 * 冻结的状态机：
 *   CREATED → ASSIGNED → RUNNING → REVIEW → DONE / FAILED
 *   REVIEW → RUNNING 表示 REWORK（同一 Worker Binding，attempt_no + 1）
 * 不引入 PLANNED。
 *
 * v0.5.1 治理例外（领地删除级联，Owner 裁决 2026-08-18）：
 *   CREATED / ASSIGNED → FAILED 仅限 deleteTerritory(force=true) 的级联终止路径，
 *   未开工任务随领地删除统一标记 FAILED（附级联原因事件）。DONE/FAILED 是
 *   不可篡改的终态事实，级联不触碰。
 *
 * REVIEW 语义 = “Worker 已提交一个可供 Supervisor 审查的 Result Claim，
 * 但该 Claim 尚未成为任务完成事实”。这是 Phase 2 的核心治理不变量：
 * **Claim ≠ Fact**。
 *
 * 本模块**零 schema 依赖**：只描述合法转移，不碰 SQLite。
 * 裁决 3 已现场确认 tasks.status 无 CHECK 约束，因此状态机只活在 Core 代码层，
 * 零 migration。
 */

/** 冻结的 Task 状态全集（Phase 2 不新增状态）。 */
export const TASK_STATUSES = ['CREATED', 'ASSIGNED', 'RUNNING', 'REVIEW', 'DONE', 'FAILED'] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

/**
 * 唯一合法转移表（Owner 裁决 1 冻结）。
 *
 * - RUNNING → REVIEW：结构化 Worker Claim 到达（**不论 Claim 自称成功还是失败**）。
 * - RUNNING → FAILED：executor 客观失败（宿主观察到的运行事实，非 Worker 自述，裁决 6）。
 * - REVIEW  → DONE / RUNNING / FAILED：Supervisor 的 ACCEPT / REWORK / FAIL 决定。
 * - DONE / FAILED 为 Phase 2 终态（裁决 6）。
 * - CREATED / ASSIGNED → FAILED：v0.5.1 领地删除级联例外（见文件头），仅级联路径使用。
 */
export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  CREATED: ['ASSIGNED', 'FAILED'],
  ASSIGNED: ['RUNNING', 'FAILED'],
  RUNNING: ['REVIEW', 'FAILED'],
  REVIEW: ['DONE', 'RUNNING', 'FAILED'],
  DONE: [],
  FAILED: [],
}

/** Phase 2 终态：不可再转移。 */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['DONE', 'FAILED']

/** Supervisor 审查决定（冻结三选一）。 */
export const REVIEW_DECISIONS = ['ACCEPT', 'REWORK', 'FAIL'] as const

export type ReviewDecision = (typeof REVIEW_DECISIONS)[number]

/** ACCEPT/REWORK/FAIL → 目标状态的唯一映射。 */
export const REVIEW_DECISION_TARGET: Record<ReviewDecision, TaskStatus> = {
  ACCEPT: 'DONE',
  REWORK: 'RUNNING',
  FAIL: 'FAILED',
}

/** 非法状态转移。抛出即表示调用方试图绕过治理闭环。 */
export class TaskTransitionError extends Error {
  readonly from: TaskStatus
  readonly to: string

  constructor(from: TaskStatus, to: string) {
    super(
      `非法 Task 状态转移：${from} → ${to}。`
      + `${from} 的合法后继为 ${TASK_TRANSITIONS[from].length > 0 ? TASK_TRANSITIONS[from].join(' / ') : '（终态，无后继）'}。`,
    )
    this.name = 'TaskTransitionError'
    this.from = from
    this.to = to
  }
}

/** 未知状态字符串（库里读到不认识的值时 fail-loud，不静默降级）。 */
export class UnknownTaskStatusError extends Error {
  constructor(value: string) {
    super(`未知 Task 状态 "${value}"，合法值：${TASK_STATUSES.join(' / ')}。`)
    this.name = 'UnknownTaskStatusError'
  }
}

/** 是否为合法状态字符串。 */
export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value)
}

/** 把库里的 TEXT 状态收敛为 TaskStatus；不认识就抛（不猜、不兜底）。 */
export function asTaskStatus(value: string): TaskStatus {
  if (!isTaskStatus(value)) throw new UnknownTaskStatusError(value)
  return value
}

/** 是否终态。 */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status)
}

/** 纯查询：from → to 是否合法。不抛错。 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to)
}

/**
 * 状态机唯一入口：校验并返回目标状态，非法即抛。
 *
 * 治理纪律：任何写 tasks.status 的代码路径都必须先经过这里
 * （见 KingdomStore.transitionTask —— 全库唯一的 status UPDATE）。
 */
export function transition(from: TaskStatus, to: TaskStatus): TaskStatus {
  if (!canTransition(from, to)) throw new TaskTransitionError(from, to)
  return to
}
