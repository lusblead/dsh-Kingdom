import { randomUUID } from 'node:crypto'
import type { KingdomStore } from './db.js'
import { asExecutionState, isTerminalExecutionState } from './execution.js'

/** One terminal dispatch produces one Claim. Runtime completion never accepts a task. */
export function submitGovernedClaim(store: KingdomStore, dispatchId: string, summary: string): { created: boolean; summary: string; outcome: string } {
  return store.withImmediateTransaction(() => {
    const dispatch = store.getDispatch(dispatchId)
    const task = dispatch && store.getTask(dispatch.task_id)
    const execution = dispatch && store.getExecution(dispatch.execution_id)
    const lease = dispatch && store.getLease(dispatch.lease_id)
    if (!dispatch || !task || !execution || !lease || dispatch.state !== 'TERMINAL' || !dispatch.terminal_evidence_json
      || !isTerminalExecutionState(asExecutionState(execution.state)) || !['RELEASED', 'RECOVERING'].includes(lease.state)
      || execution.execution_contract !== 'GOVERNED_PERSISTENT' || execution.lease_id !== lease.lease_id
      || execution.task_id !== task.task_id || lease.task_id !== task.task_id || lease.attempt_no !== dispatch.attempt_no
      || execution.attempt_no !== dispatch.attempt_no || execution.worker_binding_id !== lease.worker_binding_id
      || execution.session_id !== dispatch.session_ref || lease.session_ref !== dispatch.session_ref) {
      throw new Error('Claim requires a settled exact terminal Dispatch/Execution/Lease relation')
    }
    const existing = store.listWorkerResults(task.task_id).find(row => row.attempt_no === dispatch.attempt_no)
    if (existing) {
      if (existing.worker_binding_id !== execution.worker_binding_id || existing.session_id !== dispatch.session_ref || existing.outcome !== execution.state) {
        throw new Error('Existing Claim conflicts with this terminal dispatch')
      }
      const saved = JSON.parse(existing.result_json) as { summary?: unknown }
      return { created: false, summary: typeof saved.summary === 'string' ? saved.summary : '', outcome: existing.outcome }
    }
    if (!['ASSIGNED', 'RUNNING'].includes(task.status) || task.assigned_binding_id !== execution.worker_binding_id
      || store.maxExecutionAttemptNo(task.task_id) !== dispatch.attempt_no) {
      throw new Error('Task or latest attempt changed before Claim submission')
    }
    const at = new Date().toISOString()
    store.insertWorkerResult({ result_id: randomUUID(), task_id: task.task_id, attempt_no: dispatch.attempt_no,
      worker_binding_id: execution.worker_binding_id, session_id: dispatch.session_ref, outcome: execution.state,
      result_json: JSON.stringify({ outcome: execution.state, summary }), created_at: at })
    const running = task.status === 'ASSIGNED' ? store.transitionTask(task, 'RUNNING') : task
    store.transitionTask(running, 'REVIEW', { result_summary: summary })
    store.appendEvent({ event_id: randomUUID(), kingdom_id: dispatch.kingdom_id, event_type: 'WORKER_RESULT_SUBMITTED',
      actor_role: 'WORKER', actor_id: execution.worker_binding_id, target_type: 'task', target_id: task.task_id,
      payload_json: JSON.stringify({ attempt_no: dispatch.attempt_no, claimed_outcome: execution.state, session_id: dispatch.session_ref, executor: 'dsh-governed:persistent', dispatch_id: dispatchId }), created_at: at })
    if (lease.state === 'RELEASED') store.appendEvent({ event_id: randomUUID(), kingdom_id: dispatch.kingdom_id, event_type: 'SESSION_STOPPED',
      actor_role: 'WORKER', actor_id: execution.worker_binding_id, target_type: 'execution', target_id: execution.execution_id,
      payload_json: JSON.stringify({ task_id: task.task_id, attempt_no: dispatch.attempt_no, reason: execution.state === 'COMPLETED' ? 'completed' : execution.state.toLowerCase() }), created_at: at })
    return { created: true, summary, outcome: execution.state }
  })
}
