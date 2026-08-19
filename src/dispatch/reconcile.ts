/**
 * dsh-kingdom — v0.8 Reconcile + Recovery Decision（M3-S5，§3）。
 *
 * 依 M3-S1 Stage 2 冻结：
 * - 两维独立：executionObservation × sessionObservation；
 * - `SESSION_GONE ≠ TERMINAL`：session=GONE + execution=UNKNOWN → 仍 RECOVERING + fail-closed；
 * - `UNKNOWN` 禁止超时自动 ABORT：默认 remain RECOVERING → no new dispatch；
 * - crash 关联用 kingdom_dispatch_id（dispatch 前已知、crash 后仍可查），不盲发；
 * - G12：外来活动检测到 → 标记 untrusted → RECOVERING（禁止 settle/release 并声称可信）。
 */
import type { KingdomStore, DispatchRecordRow, LeaseRow, ExecutionRow } from '../core/db.js'
import {
  markLeaseRecovering,
  markDispatchRecovering,
  markExecutionRecovering,
} from '../core/governed.js'
import type { DispatchEvidence } from './evidence.js'

export type RecoveryAction =
  | 'WAIT'                 // 执行在途（QUEUED/RUNNING）：不动作、不重发、不开新 attempt
  | 'TERMINAL_OK'          // 有可信 terminal 证据：可继续 settle 路径
  | 'RECOVERING'           // 证据不可判定：进 RECOVERING（fail-closed）
  | 'UNTRUSTED_RECOVERING' // G12：外来活动污染 → 进 RECOVERING，禁 settle/release 声称可信

export interface ReconcileInput {
  store: KingdomStore
  dispatch: DispatchRecordRow
  sessionObservation: 'AVAILABLE' | 'GONE' | 'UNKNOWN'
  evidence: DispatchEvidence
}

export interface RecoveryDecision {
  action: RecoveryAction
  reason: string
}

/** fail-closed 恢复决策（纯函数；副作用由调用方按 action 应用）。 */
export function decideRecovery(input: ReconcileInput): RecoveryDecision {
  const { dispatch, sessionObservation, evidence } = input

  // G12：外来活动 → 不可信（最高优先级，禁止 settle/release 声称可信）
  if (evidence.foreignUserMessages.length > 0) {
    return {
      action: 'UNTRUSTED_RECOVERING',
      reason: `G12: active dispatch 期间检测到非本 dispatch 的 user 消息: ${evidence.foreignUserMessages.join(',')}`,
    }
  }

  if (evidence.state === 'TERMINAL') {
    return { action: 'TERMINAL_OK', reason: evidence.terminalReason ?? 'terminal evidence' }
  }
  if (evidence.state === 'RUNNING' || evidence.state === 'QUEUED') {
    return { action: 'WAIT', reason: `execution ${evidence.state}（在途，不重发、不开新 attempt）` }
  }
  // evidence UNKNOWN：SESSION_GONE ≠ TERMINAL；缺证据一律 RECOVERING（禁超时自动 ABORT）
  if (sessionObservation === 'GONE') {
    return { action: 'RECOVERING', reason: `session GONE + execution UNKNOWN（SESSION_GONE ≠ TERMINAL，fail-closed）` }
  }
  return { action: 'RECOVERING', reason: `execution UNKNOWN（dispatch=${dispatch.state}，证据不可判定 → RECOVERING，不盲发）` }
}

/** 按 action 应用恢复副作用（RECOVERING 类动作标记 dispatch/lease/execution）。 */
export function applyRecovery(
  store: KingdomStore,
  dispatch: DispatchRecordRow,
  decision: RecoveryDecision,
): { dispatch: DispatchRecordRow; lease: LeaseRow | null; execution: ExecutionRow | null } {
  if (decision.action !== 'RECOVERING' && decision.action !== 'UNTRUSTED_RECOVERING') {
    return { dispatch, lease: store.getLease(dispatch.lease_id), execution: store.getExecution(dispatch.execution_id) }
  }
  const updatedDispatch = markDispatchRecovering(store, dispatch.dispatch_id)
  const lease = store.getLease(dispatch.lease_id)
  const updatedLease = lease && lease.state !== 'RELEASED' ? markLeaseRecovering(store, lease.lease_id) : null
  const execution = store.getExecution(dispatch.execution_id)
  const updatedExecution = execution && execution.state !== 'RECOVERING' && !['COMPLETED', 'FAILED', 'ABORTED'].includes(execution.state)
    ? markExecutionRecovering(store, execution.execution_id)
    : null
  return { dispatch: updatedDispatch, lease: updatedLease, execution: updatedExecution }
}
