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
  correlateRuntimeExecution,
  createRunnerContextPort,
  markGovernedDispatchRecovering,
  prepareGovernedDispatch,
  recordDispatchTerminalIntegrityIncident,
  recordDispatchReceipt,
  recordTerminalEvidence,
  releaseExecutionLease,
} from '../core/governed.js'
import type { RunnerContextPort } from '../core/governed.js'
import type { TerminalIntegrityPhase, TerminalIntegrityReasonCode } from '../core/governed.js'
import type {
  RuntimeAdapter,
  RuntimeTrustFence,
  RuntimeTrustFenceExpectation,
  SessionHandle,
  DispatchReceipt,
} from '../adapter/contract.js'
import { reconstructDispatchEvidence } from './evidence.js'
import {
  forgetRunnerContextPort,
  registerProductRunnerContext,
  revokeRunnerContextBrokerContext,
} from '../runner-context-broker.js'

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
  /** Primary-owned exact teardown callback. It runs while the same Runtime
   * fence is open and before terminal ledger persistence. */
  cleanup?: GovernedTerminalCleanup
}

export interface GovernedDispatchResult {
  /** Current rows at return time; timeout returns all three as RECOVERING. */
  execution: ExecutionRow
  lease: LeaseRow
  decision: CapabilityDecisionRow
  intent: DispatchRecordRow
  receipt: DispatchReceipt
  dispatch: DispatchRecordRow
  /** TX-4 terminal evidence; null = poll exhausted and current rows are RECOVERING. */
  terminal: { dispatch: DispatchRecordRow; execution: ExecutionRow; lease: LeaseRow } | null
  /** Adapter-issued opaque fence held through terminal settlement. */
  trustFence: RuntimeTrustFence
  /** One cleanup attempt, when the caller supplied the governed callback. */
  cleanupReceipt?: CleanupReceipt
}

export type GovernedTerminalCleanup = (
  fence: RuntimeTrustFence,
  expectation: RuntimeTrustFenceExpectation,
) => Promise<CleanupReceipt>

/**
 * Evidence-bearing result of the one terminal enforcement teardown attempt.
 *
 * A bare boolean is intentionally not part of this contract: settlement must
 * be able to distinguish a confirmed teardown from a false return, a throw,
 * and an adapter response that cannot prove what it did.
 */
export type CleanupReceipt =
  | {
      readonly status: 'CONFIRMED'
      readonly evidenceJson: string
      readonly reason: string
    }
  | {
      readonly status: 'RETURNED_FALSE' | 'THREW' | 'MISSING_EVIDENCE'
      readonly evidenceJson: string | null
      readonly reason: string
    }

/** Keep adapter evidence and settlement reasons bounded before persistence. */
export const MAX_CLEANUP_EVIDENCE_LENGTH = 16_384
const MAX_SETTLEMENT_REASON_LENGTH = 256

function boundedText(value: string, maxLength: number): string {
  const text = value.trim()
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`
}

function isConfirmedCleanupReceipt(receipt: CleanupReceipt): receipt is Extract<CleanupReceipt, { status: 'CONFIRMED' }> {
  return receipt.status === 'CONFIRMED'
    && receipt.evidenceJson.trim().length > 0
    && receipt.evidenceJson.length <= MAX_CLEANUP_EVIDENCE_LENGTH
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Compatibility handoff for direct callers that settle without options. */
const pendingTrustFences = new Map<string, {
  adapter: RuntimeAdapter
  fence: RuntimeTrustFence
  leaseId: string
  sessionRef: string
}>()

/**
 * 受治理派发（TX-3..TX-5）：
 * 1. Execution + Intent（同一事务，COMMIT POINT）→ 2. dispatch（commit 之后）→
 * 3. Receipt → 4. Correlation（观测到 turn）→ 5. 等待 terminal 证据 → TX-4。
 */
export async function runGovernedDispatch(input: GovernedDispatchInput): Promise<GovernedDispatchResult> {
  const { store, adapter, kingdomId, taskId, attemptNo, workerBindingId, leaseId, capabilityDecisionId, sessionHandle } = input
  const pollIntervalMs = input.pollIntervalMs ?? 100
  const maxPolls = input.maxPolls ?? 40

  // Runtime identity 可能抛错，必须在首个 TX-3 写入前取得并与 live handle 对齐。
  const identified = adapter.identify()
  const session = {
    runtimeType: identified.runtimeType,
    runtimeInstanceRef: identified.runtimeInstanceRef,
    sessionRef: sessionHandle.refs.sessionRef,
  }
  const fenceExpectation: RuntimeTrustFenceExpectation = {
    leaseId,
    sessionRef: session.sessionRef,
  }
  const identityValid = session.runtimeType.trim() !== ''
    && session.runtimeInstanceRef.trim() !== ''
    && session.sessionRef.trim() !== ''
    && adapter.runtimeType === session.runtimeType
    && sessionHandle.refs.runtimeType === session.runtimeType
    && sessionHandle.refs.runtimeInstanceRef === session.runtimeInstanceRef
  if (!identityValid) {
    throw new Error('runGovernedDispatch: Runtime identity 与 live SessionHandle 不一致')
  }

  // TX-3：Execution + Decision.execution_id + Dispatch INTENDED（COMMIT POINT）+
  // Lease DISPATCH_READY→EXECUTING 在一个真实事务内整体提交或整体回滚。
  const prepared = prepareGovernedDispatch(store, {
    kingdomId,
    taskId,
    attemptNo,
    workerBindingId,
    leaseId,
    capabilityDecisionId,
    session,
    requestSnapshot: input.requestSnapshot,
    inputRefJson: input.inputRefJson,
    payloadHash: input.payloadHash,
  })
  let execution = prepared.execution
  const decision = prepared.decision
  const intent = prepared.intent
  let lease = prepared.lease
  let trustFence: RuntimeTrustFence | null = null
  let cleanupReceipt: CleanupReceipt | undefined
  let runnerContext: RunnerContextPort | null = null

  // v0.8：open the opaque Runtime reservation after the Kingdom COMMIT POINT
  // but before the external dispatch side effect. The baseline is captured
  // from the same live Session object used for correlation.
  const readEvents = (): readonly { type: string; data?: Record<string, unknown> }[] =>
    (sessionHandle.session as { events?: readonly { type: string; data?: Record<string, unknown> }[] }).events ?? []

  try {
    // R18: TX-3 is already committed, but no Runtime side effect is allowed
    // until the Product child has acquired the exact canonical relation and
    // registered its single internal RunnerContext entry/ticket.  A failure
    // here recovers all three ledgers and creates no Runtime fence/dispatch.
    runnerContext = createRunnerContextPort(store, { dispatchId: intent.dispatch_id })
    registerProductRunnerContext(intent.dispatch_id, runnerContext)

    trustFence = await adapter.openTrustFence({
      leaseId,
      sessionRef: sessionHandle.refs.sessionRef,
      runtimeDispatchRef: null,
      baselineEvents: readEvents(),
    })

    // COMMIT POINT 之后才允许 Runtime side effect
    const receipt = await adapter.dispatch({ sessionRef: sessionHandle.refs.sessionRef, text: input.text })

    // TX-3R：Receipt（INTENDED→DISPATCHED→RECEIVED）
    if (!runnerContext) throw new Error('runGovernedDispatch: RunnerContext 未注册')
    const boundReceipt = runnerContext.bindRuntimeReceipt(
      runnerContext.handle,
      runnerContext.initialVersion,
      receipt.refs.runtimeDispatchRef!,
      () => recordDispatchReceipt(store, intent.dispatch_id, {
        runtimeDispatchRef: receipt.refs.runtimeDispatchRef!,
        receiptJson: JSON.stringify({ type: 'DispatchReceipt/v1', acceptedAt: receipt.acceptedAt, runtimeDispatchRef: receipt.refs.runtimeDispatchRef }),
      }),
    )
    const received = boundReceipt.value
    let runnerVersion = boundReceipt.view.version

    // Correlation：观测到本 dispatch 的 turn 后绑定 runtime_execution_ref（并推进 Execution STARTING→RUNNING）
    let dispatch = received
    let untrustedRecovery: ReturnType<typeof markGovernedDispatchRecovering> | null = null
    const recoverUntrustedDispatch = (): void => {
      if (untrustedRecovery) return
      // G12：foreign user activity invalidates the whole terminal claim. Do
      // not correlate/record a terminal first; retain the receipt and move all
      // three governed rows to RECOVERING in one transaction.
      untrustedRecovery = markGovernedDispatchRecovering(
        store,
        intent.dispatch_id,
        'RECONCILE_UNTRUSTED',
      )
      dispatch = untrustedRecovery.dispatch
      execution = untrustedRecovery.execution
      lease = untrustedRecovery.lease
      if (trustFence) adapter.releaseTrustFence(trustFence, 'RECOVERING', fenceExpectation)
    }
    const fenceBound = adapter.bindTrustFence(trustFence, receipt.refs.runtimeDispatchRef ?? '', fenceExpectation)
    if (!fenceBound.ok) recoverUntrustedDispatch()

    // v0.8（正式入口 E2E seam）：真实 DSH `session.events` 是 **getter**——每次访问返回新的投影数组；
    // 若捕获一次快照，轮询永远看不到 dispatch 之后才到达的 turn/end/assistant → 必须**每轮重读**。
    let correlated = false
    const correlateObservedTurn = (turnObserved: number): void => {
      if (correlated) return
      if (!runnerContext) throw new Error('runGovernedDispatch: RunnerContext 在 correlation 前丢失')
      const correlation = runnerContext.correlateRuntimeExecution(
        runnerContext.handle,
        runnerVersion,
        `turn-${turnObserved}`,
        () => {
          const correlatedDispatch = correlateRuntimeExecution(store, intent.dispatch_id, `turn-${turnObserved}`)
          const currentExecution = store.getExecution(execution.execution_id)
          if (!currentExecution) {
            throw new Error(`runGovernedDispatch: execution ${execution.execution_id} missing during correlation`)
          }
          let correlatedExecution: ExecutionRow
          if (currentExecution.state === 'STARTING') {
            correlatedExecution = store.transitionExecution(currentExecution, 'RUNNING', {})
          } else if (currentExecution.state === 'RUNNING') {
            correlatedExecution = currentExecution
          } else {
            throw new Error(
              `runGovernedDispatch: execution ${currentExecution.execution_id} state ${currentExecution.state} cannot correlate`,
            )
          }
          return { dispatch: correlatedDispatch, execution: correlatedExecution }
        },
      )
      dispatch = correlation.value.dispatch
      execution = correlation.value.execution
      runnerVersion = correlation.view.version
      correlated = true
    }

    for (let i = 0; i < Math.min(maxPolls, 10) && !correlated && !untrustedRecovery; i++) {
      const sessionEvents = readEvents()
      if (sessionEvents.length) {
        const evidence = reconstructDispatchEvidence({ events: sessionEvents }, receipt.refs.runtimeDispatchRef!)
        if (evidence.foreignUserMessages.length > 0) {
          recoverUntrustedDispatch()
          break
        }
        if (evidence.turnObserved !== null) correlateObservedTurn(evidence.turnObserved)
      }
      if (!correlated) await sleep(pollIntervalMs)
    }

    // TX-4：等待 terminal 证据（事件链；每轮重读 events）。若 turn 与 terminal
    // 首次同时出现，必须先完成 correlation 与 STARTING→RUNNING，再记录 terminal。
    let terminal: GovernedDispatchResult['terminal'] = null
    if (!untrustedRecovery) {
      for (let i = 0; i < maxPolls && !terminal; i++) {
        const sessionEvents = readEvents()
        if (sessionEvents.length) {
          const evidence = reconstructDispatchEvidence({ events: sessionEvents }, receipt.refs.runtimeDispatchRef!)
          // Check foreign activity before correlation and before the terminal
          // ledger write. A terminal-looking event is not trusted if the
          // session contains another user message.
          if (evidence.foreignUserMessages.length > 0) {
            recoverUntrustedDispatch()
            break
          }
          if (evidence.turnObserved !== null) correlateObservedTurn(evidence.turnObserved)
          if (evidence.state === 'TERMINAL' && evidence.terminalOutcome) {
            // The terminal observation and its teardown consume one opaque
            // Runtime fence. Cleanup is deliberately attempted before the
            // terminal ledger write: if a late foreign ingress taints the
            // fence, Core can still atomically move all three rows to
            // RECOVERING (Core cannot legally revert a terminal Execution).
            const terminalCheck = trustFence
              ? adapter.checkTrustFence(trustFence, 'terminal-write', fenceExpectation)
              : { ok: false, reason: 'trust fence missing' }
            if (!terminalCheck.ok) {
              recoverUntrustedDispatch()
              break
            }
            if (input.cleanup && trustFence) cleanupReceipt = await input.cleanup(trustFence, fenceExpectation)
            const settlementCheck = trustFence
              ? adapter.checkTrustFence(trustFence, 'settlement', fenceExpectation)
              : { ok: false, reason: 'trust fence missing' }
            if (!settlementCheck.ok) {
              recoverUntrustedDispatch()
              break
            }

            // Owner FINAL WINDOW：已知终态收敛——completed→COMPLETED / aborted→ABORTED / blocked·error·max-tokens→FAILED
            const executionTerminalState = evidence.terminalOutcome
            if (!runnerContext) throw new Error('runGovernedDispatch: RunnerContext 在 terminal 前丢失')
            const terminalMutation = runnerContext.observeTerminal(
              runnerContext.handle,
              runnerVersion,
              () => recordTerminalEvidence(store, intent.dispatch_id, {
                evidenceJson: JSON.stringify({ type: 'DshTerminalEvidence/v1', payload: { reason: evidence.terminalReason, turn: evidence.turnObserved, outcome: evidence.terminalOutcome } }),
                executionTerminalState,
                settleLease: true,
              }),
            )
            const result = terminalMutation.value
            runnerVersion = terminalMutation.view.version
            terminal = { dispatch: result.dispatch, execution: result.execution!, lease: result.lease! }
            dispatch = result.dispatch
            execution = result.execution!
            lease = result.lease!
            pendingTrustFences.set(lease.lease_id, {
              adapter,
              fence: trustFence,
              leaseId,
              sessionRef: session.sessionRef,
            })
          }
        }
        if (!terminal) await sleep(pollIntervalMs)
      }
    }

    if (!terminal && !untrustedRecovery) {
      const recovered = markGovernedDispatchRecovering(
        store,
        dispatch.dispatch_id,
        'TERMINAL_POLL_EXHAUSTED',
      )
      dispatch = recovered.dispatch
      execution = recovered.execution
      lease = recovered.lease
      if (trustFence) adapter.releaseTrustFence(trustFence, 'RECOVERING', fenceExpectation)
    }

    if (!terminal && trustFence) adapter.releaseTrustFence(trustFence, 'RECOVERING', fenceExpectation)
    if (!terminal) {
      revokeRunnerContextBrokerContext(runnerContext)
      forgetRunnerContextPort(intent.dispatch_id)
    }
    return { execution, lease, decision, intent, receipt, dispatch, terminal, trustFence, cleanupReceipt }
  } catch (error: unknown) {
    try {
      // A RunnerContext mutation can fail after its transactional terminal
      // callback has already committed (for example, an exact relation
      // readback becomes unavailable).  Terminal Dispatch/Execution are
      // immutable post-TX-4 facts; never feed that state back into the
      // pre-terminal three-ledger recovery CAS.
      const currentDispatch = store.getDispatch(intent.dispatch_id)
      if (currentDispatch?.state === 'TERMINAL') {
        recordDispatchTerminalIntegrityIncident(store, {
          dispatchId: intent.dispatch_id,
          reasonCode: 'TRUST_FENCE_CHECK_FAILED',
          phase: 'settlement',
        })
      } else {
        markGovernedDispatchRecovering(store, intent.dispatch_id, 'DISPATCH_EXCEPTION')
      }
      if (trustFence) adapter.releaseTrustFence(trustFence, 'RECOVERING', fenceExpectation)
      revokeRunnerContextBrokerContext(runnerContext)
      forgetRunnerContextPort(intent.dispatch_id)
    } catch (recoveryError: unknown) {
      throw new AggregateError(
        [error, recoveryError],
        `runGovernedDispatch: dispatch ${intent.dispatch_id} failed and recovery could not be recorded`,
      )
    }
    throw error
  }
}

/**
 * TX-5：terminal Claim 后的 settlement/release。
 *
 * 只有带有非空、bounded teardown evidence 的 CONFIRMED receipt 才能走
 * RELEASED；false/throw/missing evidence 均保留 Lease=RECOVERING，阻止
 * Session reuse 与新 Dispatch。
 */
export interface TrustFenceSettlement {
  readonly adapter: RuntimeAdapter
  readonly fence: RuntimeTrustFence
  readonly leaseId: string
  readonly sessionRef: string
}

export function settleAndRelease(
  store: KingdomStore,
  leaseId: string,
  cleanup: CleanupReceipt,
  reason: string,
  explicitFence?: TrustFenceSettlement,
): LeaseRow {
  const lease = store.getLease(leaseId)
  if (!lease) throw new Error(`settleAndRelease: lease ${leaseId} 不存在`)

  const fenceBinding = explicitFence ?? pendingTrustFences.get(leaseId)
  const fenceTargetsLease = Boolean(fenceBinding)
    && fenceBinding!.leaseId === leaseId
    && fenceBinding!.sessionRef === lease.session_ref
  const releaseFenceForRecovery = (): void => {
    if (!fenceBinding || !fenceTargetsLease) return
    fenceBinding.adapter.releaseTrustFence(
      fenceBinding.fence,
      'RECOVERING',
      { leaseId: fenceBinding.leaseId, sessionRef: fenceBinding.sessionRef },
    )
    pendingTrustFences.delete(leaseId)
  }
  const moveToRecovery = (recoveryReason: string): LeaseRow => {
    const recovered = lease.state === 'RECOVERING' && lease.release_reason === recoveryReason
      ? lease
      : advanceLeaseState(store, leaseId, 'RECOVERING', { releaseReason: recoveryReason })
    releaseFenceForRecovery()
    return recovered
  }

  /**
   * A terminal dispatch has a different recovery contract from pre-TX-4
   * ambiguity: preserve Dispatch/Execution terminal state, and atomically
   * record the incident while recovering only the Lease.  Older direct unit
   * fixtures without a terminal Dispatch retain the ordinary Lease-only
   * cleanup behavior; they cannot prove a post-TX-4 incident.
   */
  const moveTerminalIntegrityToRecovery = (
    reasonCode: TerminalIntegrityReasonCode,
    phase: TerminalIntegrityPhase,
    fallbackReason: string,
  ): LeaseRow => {
    const terminalDispatch = store
      .listDispatchesForTaskAttempt(lease.task_id, lease.attempt_no)
      .find(candidate => candidate.lease_id === lease.lease_id && candidate.state === 'TERMINAL')
    if (!terminalDispatch) return moveToRecovery(fallbackReason)
    const incident = recordDispatchTerminalIntegrityIncident(store, {
      dispatchId: terminalDispatch.dispatch_id,
      reasonCode,
      phase,
    })
    releaseFenceForRecovery()
    return incident.lease
  }

  // RELEASED is immutable history.  If a later caller presents an explicitly
  // mismatched fence, append the bounded escalation incident but never roll
  // the Lease or terminal ledgers back.
  if (lease.state === 'RELEASED') {
    if (fenceBinding && !fenceTargetsLease) {
      moveTerminalIntegrityToRecovery(
        'TRUST_FENCE_EXPECTATION_MISMATCH',
        'settlement',
        `trust fence settlement target mismatch after release: lease=${leaseId}`,
      )
    }
    return lease
  }

  const boundedReason = boundedText(reason, MAX_SETTLEMENT_REASON_LENGTH)
  if (fenceBinding && !fenceTargetsLease) {
    return moveTerminalIntegrityToRecovery(
      'TRUST_FENCE_EXPECTATION_MISMATCH',
      'settlement',
      `trust fence settlement target mismatch: lease=${leaseId} `
        + `fence=${fenceBinding?.leaseId ?? 'unknown'}/${fenceBinding?.sessionRef ?? 'unknown'}`,
    )
  }
  if (!isConfirmedCleanupReceipt(cleanup)) {
    // cleanup 不明/失败 → 进 RECOVERING，禁止 RELEASED（v6 TX-5 前置）。
    const recoveryReason = boundedText(
      `cleanup=${cleanup.status}; ${cleanup.reason || 'teardown evidence unavailable'}`,
      MAX_SETTLEMENT_REASON_LENGTH,
    )
    return moveToRecovery(recoveryReason)
  }

  if (!fenceBinding) {
    return moveTerminalIntegrityToRecovery(
      'TRUST_FENCE_MISSING',
      'settlement',
      'trust fence missing; terminal settlement cannot be proven',
    )
  }

  if (fenceBinding) {
    const settlementCheck = fenceBinding.adapter.checkTrustFence(
      fenceBinding.fence,
      'settlement',
      { leaseId: fenceBinding.leaseId, sessionRef: fenceBinding.sessionRef },
    )
    if (!settlementCheck.ok) {
      return moveTerminalIntegrityToRecovery(
        'TRUST_FENCE_CHECK_FAILED',
        'settlement',
        boundedText(`trust fence settlement failed: ${settlementCheck.reason}`, MAX_SETTLEMENT_REASON_LENGTH),
      )
    }
  }

  if (lease.state === 'SETTLING') advanceLeaseState(store, leaseId, 'RELEASING')
  if (fenceBinding) {
    // Release the Runtime ingress reservation only after all settlement
    // checks pass. The lease write immediately follows this bounded receipt;
    // any failure remains fail-closed because the lease is not RELEASED.
    const releaseCheck = fenceBinding.adapter.releaseTrustFence(
      fenceBinding.fence,
      'RELEASED',
      { leaseId: fenceBinding.leaseId, sessionRef: fenceBinding.sessionRef },
    )
    if (!releaseCheck.ok) {
      return moveTerminalIntegrityToRecovery(
        'TRUST_FENCE_RELEASE_FAILED',
        'release',
        boundedText(`trust fence release failed: ${releaseCheck.reason}`, MAX_SETTLEMENT_REASON_LENGTH),
      )
    }
  }
  const released = releaseExecutionLease(
    store,
    leaseId,
    {
      phase: 'settlement',
      reason: boundedReason,
      cleanupStatus: cleanup.status,
      cleanupEvidenceJson: cleanup.evidenceJson,
      cleanupReason: cleanup.reason,
    },
    boundedReason,
  )
  if (fenceBinding) pendingTrustFences.delete(leaseId)
  return released
}
