/**
 * dsh-kingdom — v0.8 Governed Dispatch Service（M3-S5，TX-3..TX-5 编排）。
 *
 * 依 M3-S5 Thin Spec §1 + v6 §4：
 * TX-3  写 Execution（GOVERNED_PERSISTENT + decision.execution_id 回填）→ 写 Dispatch INTENDED
 *       （COMMIT POINT）→ Lease DISPATCH_READY→EXECUTING；
 * TX-3R adapter.dispatch()（COMMIT 之后）→ Receipt（INTENDED→DISPATCHED→RECEIVED）→ Correlation（→CORRELATED）；
 * TX-4  Terminal Evidence（→TERMINAL + Execution 终态 + Lease SETTLING）；
 * TX-5  settlement 后由调用方 release（本服务返回 SETTLING 态 lease）。
 *
 * 硬纪律：COMMIT POINT 之前绝不调用 adapter.dispatch()；Receipt ≠ Terminal；
 * 外部证据（session 事件链）是 terminal 的唯一来源。
 */
import type {
  KingdomStore,
  ExecutionRow,
  DispatchRecordRow,
  LeaseRow,
  CapabilityDecisionRow,
} from '../core/db.js'
import {
  advanceLeaseState,
  createDispatchIntent,
  createGovernedExecution,
  correlateRuntimeExecution,
  recordDispatchReceipt,
  recordTerminalEvidence,
  releaseExecutionLease,
} from '../core/governed.js'
import type { RuntimeAdapter, SessionHandle, DispatchReceipt } from '../adapter/contract.js'
import { reconstructDispatchEvidence } from './evidence.js'

export interface GovernedDispatchInput {
  store: KingdomStore
  adapter: RuntimeAdapter
  kingdomId: string
  taskId: string
  attemptNo: number
  workerBindingId: string
  leaseId: string
  capabilityDecisionId: string
  /** 已建立/恢复的 live session（含事件日志）。 */
  sessionHandle: SessionHandle
  /** dispatch 给 Worker 的 prompt 文本。 */
  text: string
  requestSnapshot: string
  inputRefJson: string
  payloadHash: string
  /** 终端等待选项（测试可调小）。 */
  pollIntervalMs?: number
  maxPolls?: number
}

export interface GovernedDispatchResult {
  execution: ExecutionRow
  decision: CapabilityDecisionRow
  intent: DispatchRecordRow
  receipt: DispatchReceipt
  dispatch: DispatchRecordRow
  /** TX-4 完成后的 terminal 结果；null = 未在轮询窗口内到达 terminal（调用方应 reconcile）。 */
  terminal: { dispatch: DispatchRecordRow; execution: ExecutionRow; lease: LeaseRow } | null
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 受治理派发（TX-3..TX-5）：
 * 1. Execution + Intent（同一事务，COMMIT POINT）→ 2. dispatch（commit 之后）→
 * 3. Receipt → 4. Correlation（观测到 turn）→ 5. 等待 terminal 证据 → TX-4。
 */
export async function runGovernedDispatch(input: GovernedDispatchInput): Promise<GovernedDispatchResult> {
  const { store, adapter, kingdomId, taskId, attemptNo, workerBindingId, leaseId, capabilityDecisionId, sessionHandle } = input
  const pollIntervalMs = input.pollIntervalMs ?? 100
  const maxPolls = input.maxPolls ?? 40

  // TX-3：Execution + Decision.execution_id 回填 + Dispatch INTENDED（COMMIT POINT）+ Lease EXECUTING
  const execution = createGovernedExecution(store, {
    taskId, attemptNo, workerBindingId, leaseId, capabilityDecisionId,
    sessionId: sessionHandle.refs.sessionRef,
  })
  const decision = store.getCapabilityDecision(capabilityDecisionId)!
  const intent = createDispatchIntent(store, {
    kingdomId, leaseId, executionId: execution.execution_id, taskId, attemptNo,
    session: { runtimeType: adapter.runtimeType, runtimeInstanceRef: adapter.identify().runtimeInstanceRef, sessionRef: sessionHandle.refs.sessionRef },
    requestSnapshot: input.requestSnapshot, inputRefJson: input.inputRefJson, payloadHash: input.payloadHash,
  })
  advanceLeaseState(store, leaseId, 'EXECUTING')

  // COMMIT POINT 之后才允许 Runtime side effect
  const receipt = await adapter.dispatch({ sessionRef: sessionHandle.refs.sessionRef, text: input.text })

  // TX-3R：Receipt（INTENDED→DISPATCHED→RECEIVED）
  const received = recordDispatchReceipt(store, intent.dispatch_id, {
    runtimeDispatchRef: receipt.refs.runtimeDispatchRef!,
    receiptJson: JSON.stringify({ type: 'DispatchReceipt/v1', acceptedAt: receipt.acceptedAt, runtimeDispatchRef: receipt.refs.runtimeDispatchRef }),
  })

  // Correlation：观测到本 dispatch 的 turn 后绑定 runtime_execution_ref（并推进 Execution STARTING→RUNNING）
  let dispatch = received
  // v0.8（正式入口 E2E seam）：真实 DSH `session.events` 是 **getter**——每次访问返回新的投影数组；
  // 若捕获一次快照，轮询永远看不到 dispatch 之后才到达的 turn/end/assistant → 必须**每轮重读**。
  const readEvents = (): readonly { type: string; data?: Record<string, unknown> }[] =>
    (sessionHandle.session as { events?: readonly { type: string; data?: Record<string, unknown> }[] }).events ?? []
  let correlated = false
  for (let i = 0; i < Math.min(maxPolls, 10) && !correlated; i++) {
    const sessionEvents = readEvents()
    if (sessionEvents.length) {
      const evidence = reconstructDispatchEvidence({ events: sessionEvents }, receipt.refs.runtimeDispatchRef!)
      if (evidence.turnObserved !== null) {
        dispatch = correlateRuntimeExecution(store, intent.dispatch_id, `turn-${evidence.turnObserved}`)
        // Adapter 观测到执行开始 → Execution STARTING→RUNNING（host 观察到的运行事实）
        const currentExecution = store.getExecution(execution.execution_id)
        if (currentExecution && currentExecution.state === 'STARTING') {
          store.transitionExecution(currentExecution, 'RUNNING', {})
        }
        correlated = true
      }
    }
    if (!correlated) await sleep(pollIntervalMs)
  }

  // TX-4：等待 terminal 证据（事件链；每轮重读 events）
  let terminal: GovernedDispatchResult['terminal'] = null
  for (let i = 0; i < maxPolls && !terminal; i++) {
    const sessionEvents = readEvents()
    if (sessionEvents.length) {
      const evidence = reconstructDispatchEvidence({ events: sessionEvents }, receipt.refs.runtimeDispatchRef!)
      if (evidence.state === 'TERMINAL' && evidence.terminalOutcome) {
        // Owner FINAL WINDOW：已知终态收敛——completed→COMPLETED / aborted→ABORTED / blocked·error·max-tokens→FAILED
        const executionTerminalState = evidence.terminalOutcome
        const result = recordTerminalEvidence(store, intent.dispatch_id, {
          evidenceJson: JSON.stringify({ type: 'DshTerminalEvidence/v1', payload: { reason: evidence.terminalReason, turn: evidence.turnObserved, outcome: evidence.terminalOutcome } }),
          executionTerminalState,
          settleLease: true,
        })
        terminal = { dispatch: result.dispatch, execution: result.execution!, lease: result.lease! }
        dispatch = result.dispatch
      }
    }
    if (!terminal) await sleep(pollIntervalMs)
  }

  return { execution, decision, intent, receipt, dispatch, terminal }
}

/** TX-5：settlement 完成后的 release（cleanup 证据；cleanup 不明禁止 RELEASED）。 */
export function settleAndRelease(store: KingdomStore, leaseId: string, cleanupOk: boolean, reason: string): LeaseRow {
  const lease = store.getLease(leaseId)
  if (!lease) throw new Error(`settleAndRelease: lease ${leaseId} 不存在`)
  if (lease.state === 'RELEASED') return lease
  if (lease.state === 'SETTLING') advanceLeaseState(store, leaseId, 'RELEASING')
  if (!cleanupOk) {
    // cleanup 不明 → 进 RECOVERING，禁止 RELEASED（v6 TX-5 前置）
    const recovering = advanceLeaseState(store, leaseId, 'RECOVERING')
    void recovering
    return store.getLease(leaseId)!
  }
  return releaseExecutionLease(store, leaseId, { phase: 'settlement', reason }, reason)
}
