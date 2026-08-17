/**
 * dsh-kingdom — Execution 生命周期（Phase 3 / GUI 适配）。
 *
 * ## 为什么 Execution 必须独立于 Task
 *
 * `Task.status === 'RUNNING'` **不能**可靠表示"骑士正在工作"：
 * REWORK 之后任务立刻回到 RUNNING，但新的 Worker 执行还没启动；
 * 此时 GUI 若按 Task.status 播放工作动画，人物就在假装干活。
 *
 * 所以治理事实（Task）与运行事实（Execution）分开建模：
 *
 * ```text
 * Task.status      = 组织对这件事的裁定进度（CREATED..DONE/FAILED）
 * Execution.state  = 某一次具体执行此刻的运行状况（STARTING..ABORTED）
 * ```
 *
 * 一个 Task 的每个 attempt 至多一个 Execution（`UNIQUE(task_id, attempt_no)`）。
 *
 * 本模块与 `./task.ts` 一样**零 schema 依赖**：只描述合法转移。
 */

/** Execution 的全部状态。 */
export const EXECUTION_STATES = [
  'STARTING',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'ABORTED',
] as const

export type ExecutionState = (typeof EXECUTION_STATES)[number]

/**
 * 合法转移。
 *
 * - `STARTING → RUNNING`：宿主确认执行已真正开始。
 * - `RUNNING ↔ PAUSED`：暂停/恢复（见 `./execution.ts` 关于 one-shot 的诚实边界说明）。
 * - `* → COMPLETED`：执行交回了合法结构化结果（**注意：这只说明跑完了，不代表任务完成**）。
 * - `* → FAILED`：宿主观察到执行没跑出合法结果。
 * - `* → ABORTED`：被显式终止（会话停止/用户取消），与 FAILED 区分开。
 */
export const EXECUTION_TRANSITIONS: Record<ExecutionState, readonly ExecutionState[]> = {
  STARTING: ['RUNNING', 'FAILED', 'ABORTED'],
  RUNNING: ['PAUSED', 'COMPLETED', 'FAILED', 'ABORTED'],
  PAUSED: ['RUNNING', 'ABORTED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  ABORTED: [],
}

/** 终态：不再有后续转移，人物 Sprite 应退场。 */
export const TERMINAL_EXECUTION_STATES: readonly ExecutionState[] = ['COMPLETED', 'FAILED', 'ABORTED']

/** 活跃态：人物应当在场（工作或休息）。 */
export const LIVE_EXECUTION_STATES: readonly ExecutionState[] = ['STARTING', 'RUNNING', 'PAUSED']

export class ExecutionTransitionError extends Error {
  constructor(from: ExecutionState, to: string) {
    super(
      `非法 Execution 状态转移：${from} → ${to}。`
      + `${from} 的合法后继为 ${EXECUTION_TRANSITIONS[from].length > 0 ? EXECUTION_TRANSITIONS[from].join(' / ') : '（终态，无后继）'}。`,
    )
    this.name = 'ExecutionTransitionError'
  }
}

export class UnknownExecutionStateError extends Error {
  constructor(value: string) {
    super(`未知 Execution 状态 "${value}"，合法值：${EXECUTION_STATES.join(' / ')}。`)
    this.name = 'UnknownExecutionStateError'
  }
}

export function isExecutionState(value: string): value is ExecutionState {
  return (EXECUTION_STATES as readonly string[]).includes(value)
}

/** 库里读到的 TEXT 收敛为 ExecutionState；不认识就抛（fail-loud，不猜）。 */
export function asExecutionState(value: string): ExecutionState {
  if (!isExecutionState(value)) throw new UnknownExecutionStateError(value)
  return value
}

export function isTerminalExecutionState(state: ExecutionState): boolean {
  return TERMINAL_EXECUTION_STATES.includes(state)
}

export function isLiveExecutionState(state: ExecutionState): boolean {
  return LIVE_EXECUTION_STATES.includes(state)
}

export function canTransitionExecution(from: ExecutionState, to: ExecutionState): boolean {
  return EXECUTION_TRANSITIONS[from].includes(to)
}

/** 状态机唯一入口：校验并返回目标状态，非法即抛。 */
export function transitionExecution(from: ExecutionState, to: ExecutionState): ExecutionState {
  if (!canTransitionExecution(from, to)) throw new ExecutionTransitionError(from, to)
  return to
}
