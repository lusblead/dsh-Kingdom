/**
 * dsh-kingdom — v0.8 Governed Task Runner（M3-S5 编排 → 插件接线层）。
 *
 * 把 S3–S5 的 governed 管道组合成一次「受治理 Worker 任务执行」：
 * ensureWorkerSession → runCapabilityGate（DENIED → zero execution）→ runGovernedDispatch
 * → terminal 后从事件链提取 Worker 最终消息作为 Claim 摘要（Claim ≠ Fact，走既有 REVIEW 链）。
 *
 * 与 legacy one-shot（DshSubagentExecutor）并列：本路径只服务 `GOVERNED_PERSISTENT`；
 * legacy 路径继续 `LEGACY_COMPAT`（§34）。
 */
import type { KingdomStore } from '../core/db.js'
import type { EnforcementRequest, RuntimeAdapter, RuntimeTrustFence, RuntimeTrustFenceExpectation, SessionHandle } from '../adapter/contract.js'
import { ensureWorkerSession, type EnsureWorkerSessionResult } from '../adapter/session-store.js'
import { runCapabilityGate } from '../capability/service.js'
import type { DshEnforcementContext } from '../capability/dsh-enforcement.js'
import { MAX_CLEANUP_EVIDENCE_LENGTH, runGovernedDispatch, type CleanupReceipt } from '../dispatch/service.js'
import { buildWorkerPrompt, type WorkerContext } from './executor.js'
import type { GrantMap } from '../capability/resolver.js'
import { resolveGovernedWorkerRuntime } from './executor-factory.js'

export interface GovernedTaskInput {
  store: KingdomStore
  adapter: RuntimeAdapter
  kingdomId: string
  workerBindingId: string
  territoryId: string
  /** Territory 工作区路径（createSession 的 meta.cwd）。 */
  cwd: string
  taskId: string
  attemptNo: number
  supervisorBindingId: string | null
  /** Supervisor 本次 Attempt 的权威授权（Grant）。 */
  grant: GrantMap
  /** Supervisor 规划的 Task capability requirement（非权威自述）。 */
  requirementJson: string | null
  sandboxMode: 'read-only' | 'workspace-write'
  agentPreset?: string
  /**
   * v0.8（Owner V0.8 PRODUCTION-PATH CLOSURE A）：全局 workerProvider config
   * （provider 解析的全局回退；Worker 显式 execution_profile_json 优先）。
   */
  globalProvider?: string
  /** live DSH 注入面（permission/sandbox/approval）。 */
  pollIntervalMs?: number
  maxPolls?: number
}

export type GovernedTaskResult =
  | {
      ok: true
      executionId: string
      leaseId: string
      dispatchId: string
      sessionRef: string
      created: boolean
      summary: string
      /** Trusted terminal 后 exactly-once enforcement teardown 的 bounded receipt。 */
      cleanupReceipt: CleanupReceipt
      /** Same opaque fence consumed by dispatch and settlement. */
      trustFence: RuntimeTrustFence
      /**
       * Owner V0.8 FINAL RELEASE BLOCKER：已由 terminal 证据验证的终态 outcome。
       * 工具层据此收敛 Claim outcome（COMPLETED/FAILED/ABORTED），**禁止 hardcode COMPLETED**。
       */
      terminalOutcome: 'COMPLETED' | 'FAILED' | 'ABORTED'
    }
  | { ok: false; reason: string; deniedDecisionId?: string; sessionRef?: string }

const MAX_CLEANUP_REASON_LENGTH = 256

function boundedCleanupReason(value: string): string {
  const text = value.trim()
  return text.length <= MAX_CLEANUP_REASON_LENGTH ? text : `${text.slice(0, MAX_CLEANUP_REASON_LENGTH - 1)}…`
}

function boundedCleanupEvidence(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const evidence = value.trim()
  if (evidence.length === 0 || evidence.length > MAX_CLEANUP_EVIDENCE_LENGTH) return null
  return value
}

function cleanupReceiptFromAdapterResult(result: unknown): CleanupReceipt {
  if (!result || typeof result !== 'object') {
    return {
      status: 'MISSING_EVIDENCE',
      evidenceJson: null,
      reason: 'adapter cleanup returned no result',
    }
  }
  const candidate = result as { ok?: unknown; evidenceJson?: unknown }
  const evidenceJson = boundedCleanupEvidence(candidate.evidenceJson)
  if (candidate.ok === true && evidenceJson !== null) {
    return {
      status: 'CONFIRMED',
      evidenceJson,
      reason: 'adapter cleanup confirmed with bounded evidence',
    }
  }
  if (candidate.ok === false) {
    return {
      status: 'RETURNED_FALSE',
      evidenceJson,
      reason: 'adapter cleanup returned ok=false',
    }
  }
  return {
    status: 'MISSING_EVIDENCE',
    evidenceJson,
    reason: candidate.ok === true
      ? 'adapter cleanup returned ok=true without bounded evidence'
      : 'adapter cleanup result did not contain a trusted ok flag',
  }
}

/**
 * Consume the exact materialized request once, and never let teardown failure
 * erase an already trusted terminal/Claim result.
 */
async function cleanupAfterTrustedTerminal(
  adapter: RuntimeAdapter,
  request: EnforcementRequest | null,
  context: DshEnforcementContext,
  fence: RuntimeTrustFence,
  expectation: RuntimeTrustFenceExpectation,
): Promise<CleanupReceipt> {
  if (request === null) {
    return {
      status: 'MISSING_EVIDENCE',
      evidenceJson: null,
      reason: 'Capability Gate did not return the exact materialized EnforcementRequest',
    }
  }
  try {
    return cleanupReceiptFromAdapterResult(await adapter.cleanup(request, context, fence, expectation))
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      status: 'THREW',
      evidenceJson: null,
      reason: boundedCleanupReason(`adapter cleanup threw: ${detail}`),
    }
  }
}

/**
 * Guard every persistent Worker Session side effect with the current affinity
 * and active Lease ledger. This intentionally runs before
 * ensureWorkerSession(), whose first observable action may be getLiveHandle,
 * resumeSession, or createSession. A RECOVERING/SETTLING Lease is still an
 * active Lease for this purpose; reconciliation is the only release gate.
 */
function guardBeforeWorkerSessionSideEffect(
  store: KingdomStore,
  adapter: RuntimeAdapter,
  input: { kingdomId: string; workerBindingId: string },
): { ok: true } | { ok: false; reason: string } {
  let identity: { runtimeType: string; runtimeInstanceRef: string }
  try {
    identity = adapter.identify()
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `Worker Runtime identity 无法确认；未访问 Session/Lease side effect: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (
    identity.runtimeType.trim() === ''
    || identity.runtimeInstanceRef.trim() === ''
    || identity.runtimeType !== adapter.runtimeType
  ) {
    return { ok: false, reason: 'Worker Runtime identity 缺失或与 Adapter 不一致；未访问 Session/Lease side effect' }
  }

  const currentAffinity = store.getCurrentAffinityForWorker(input.kingdomId, input.workerBindingId)
  if (currentAffinity) {
    if (
      currentAffinity.runtime_type !== identity.runtimeType
      || currentAffinity.runtime_instance_ref !== identity.runtimeInstanceRef
    ) {
      return {
        ok: false,
        reason: `Worker current affinity 的 Runtime identity 与 Adapter 不一致（session=${currentAffinity.session_ref}）；未访问 Session/Lease side effect`,
      }
    }
    const activeLease = store.getActiveLeaseForSession({
      runtimeType: currentAffinity.runtime_type,
      runtimeInstanceRef: currentAffinity.runtime_instance_ref,
      sessionRef: currentAffinity.session_ref,
    })
    if (activeLease) {
      return {
        ok: false,
        reason: `Session ${currentAffinity.session_ref} 已有 active Lease（${activeLease.lease_id}，${activeLease.state}）；未 reconcile 前禁 Session reuse/create/resume 与新 Dispatch（G11）`,
      }
    }
  }

  // Fail closed if a corrupt/partially rebuilt projection left a lease for the
  // Worker without a current affinity row. This read is still before any
  // Runtime session operation and avoids creating a second session around a
  // stale recovery record.
  const orphanedWorkerLease = store.listLeases(input.kingdomId).find(lease =>
    lease.worker_binding_id === input.workerBindingId
    && lease.runtime_type === identity.runtimeType
    && lease.runtime_instance_ref === identity.runtimeInstanceRef
    && lease.state !== 'RELEASED',
  )
  if (orphanedWorkerLease) {
    return {
      ok: false,
      reason: `Worker ${input.workerBindingId} 已有 active Lease（${orphanedWorkerLease.lease_id}，${orphanedWorkerLease.state}）；未 reconcile 前禁 Session reuse/create/resume 与新 Dispatch`,
    }
  }
  return { ok: true }
}

/** 提取 Worker 最终消息文本（真实 DSH `assistant/message` shape：message.content[{type:'text',text}]）。 */
function lastAssistantMessage(session: unknown): string {
  const events = (session as { events?: readonly { type: string; data?: Record<string, unknown> }[] }).events ?? []
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type !== 'assistant/message') continue
    const data = event.data as { message?: { content?: unknown[]; text?: unknown }; text?: unknown } | undefined
    const content = Array.isArray(data?.message?.content) ? data.message.content : []
    for (const part of content) {
      const p = part as { type?: string; text?: unknown }
      if (p.type === 'text' && typeof p.text === 'string' && p.text.trim().length > 0) return p.text
    }
    if (typeof data?.message?.text === 'string' && data.message.text.trim().length > 0) return data.message.text
    if (typeof data?.text === 'string' && data.text.trim().length > 0) return data.text
  }
  return ''
}

/**
 * 一次受治理 Worker 任务执行。
 * DENIED（能力不足/无法 enforce）→ 返回 {ok:false, reason}，**zero execution**（无 Execution/Dispatch 落库）。
 */
export async function runGovernedTask(input: GovernedTaskInput): Promise<GovernedTaskResult> {
  const { store, adapter, kingdomId, workerBindingId, territoryId, cwd, taskId, attemptNo, supervisorBindingId, grant, requirementJson, sandboxMode } = input
  if (!store.isSchemaV4) {
    return { ok: false, reason: 'Schema v4 未迁移：governed 执行不可用（正式 DB 迁移须经 Formal DB Migration Gate）' }
  }

  // 0. Worker provider/model 解析（Owner CLOSURE A）——fail closed：缺失 model → configuration error，
  //    不创建 Session、不 acquire Lease、不 dispatch（zero execution）。
  const taskRow = store.getTask(taskId)
  if (!taskRow) {
    return { ok: false, reason: `错误：找不到任务 ${taskId}。` }
  }
  const resolved = resolveGovernedWorkerRuntime(store, taskRow, { globalProvider: input.globalProvider ?? 'spawn' })
  if (!resolved.ok) {
    return { ok: false, reason: `Governed 执行未发生（configuration error）：${resolved.error}` }
  }

  // 1. Persistent Worker Session（create / resume 同一 session_ref；provider/model 显式来自 Worker 执行配置）
  //    G11/GI-CAP-002：active/recovery Lease guard 必须在 getLiveHandle、resume、
  //    create 之前，否则 live registry 丢失时会先产生 Runtime side effect 再被拒绝。
  const sessionGuard = guardBeforeWorkerSessionSideEffect(store, adapter, { kingdomId, workerBindingId })
  if (!sessionGuard.ok) return { ok: false, reason: sessionGuard.reason }
  let session: EnsureWorkerSessionResult
  try {
    session = await ensureWorkerSession(store, adapter, {
      kingdomId, workerBindingId, territoryId, cwd,
      agentPreset: input.agentPreset,
      provider: resolved.runtime.provider,
      model: resolved.runtime.model,
    })
  } catch (error) {
    return { ok: false, reason: `Worker Session 建立失败: ${error instanceof Error ? error.message : String(error)}` }
  }

  const context: DshEnforcementContext = {
    sessionRef: session.handle.refs.sessionRef,
    agent: session.handle.agent as DshEnforcementContext['agent'],
    agentPresetId: input.agentPreset ?? undefined,
  }

  // 2. Capability Gate（TX-0D..TX-2S/2F；DENIED → zero execution）
  const lease = store.getActiveLeaseForSession({ runtimeType: adapter.runtimeType, runtimeInstanceRef: adapter.identify().runtimeInstanceRef, sessionRef: session.handle.refs.sessionRef })
  if (lease) {
    return { ok: false, reason: `Session ${session.handle.refs.sessionRef} 已有 active Lease（${lease.lease_id}，${lease.state}）；未 reconcile 前禁新 attempt（G11）`, sessionRef: session.handle.refs.sessionRef }
  }
  const acquired = await import('../core/governed.js').then(m => m.acquireExecutionLease(store, {
    kingdomId, workerBindingId, session: { runtimeType: adapter.runtimeType, runtimeInstanceRef: adapter.identify().runtimeInstanceRef, sessionRef: session.handle.refs.sessionRef },
    territoryId, taskId, attemptNo,
  }))
  const gate = await runCapabilityGate({
    store, adapter, kingdomId, taskId, attemptNo, workerBindingId, supervisorBindingId,
    leaseId: acquired.lease_id, requirementJson, ceilingJson: store.getKingdomCapabilityCeiling(kingdomId),
    grant, sandboxMode, context,
  })
  if (!gate.materialized) {
    return { ok: false, reason: `Capability DENIED（${gate.decision.enforcement_status}）: ${gate.decision.reason_code ?? ''}`, deniedDecisionId: gate.decision.decision_id, sessionRef: session.handle.refs.sessionRef }
  }

  // 3. Governed Dispatch（TX-3..TX-4）
  const workerContext: WorkerContext = {
    task: store.getTask(taskId)!,
    acceptanceCriteria: store.getTask(taskId)!.acceptance_criteria,
    attemptNo,
  }
  const text = buildWorkerPrompt(workerContext)
  const run = await runGovernedDispatch({
    store, adapter, kingdomId, taskId, attemptNo, workerBindingId,
    leaseId: gate.lease.lease_id, capabilityDecisionId: gate.decision.decision_id,
    sessionHandle: session.handle as SessionHandle,
    text,
    requestSnapshot: JSON.stringify({ type: 'req/v1', task: taskId, attempt: attemptNo }),
    inputRefJson: JSON.stringify({ task: taskId, prompt: text.slice(0, 200) }),
    payloadHash: `sha256:${text.length}`,
    pollIntervalMs: input.pollIntervalMs,
    maxPolls: input.maxPolls,
    cleanup: (fence, expectation) => cleanupAfterTrustedTerminal(adapter, gate.enforcementRequest, context, fence, expectation),
  })

  if (!run.terminal) {
    return { ok: false, reason: `dispatch 未在轮询窗口内到达 terminal（dispatch=${run.dispatch.state}）——进 RECOVERING 流程，由 reconcile 处理`, sessionRef: session.handle.refs.sessionRef }
  }

  // 4. Claim 摘要：terminal 后 Worker 最终消息（Claim ≠ Fact；Task 仍走 REVIEW）。
  //    Cleanup 已由 runGovernedDispatch 在同一 trust fence 下 exactly once
  //    执行；这里仅转交 receipt，不再二次调用 disposer。
  const cleanupReceipt = run.cleanupReceipt ?? {
    status: 'MISSING_EVIDENCE' as const,
    evidenceJson: null,
    reason: 'governed dispatch returned no cleanup receipt',
  }
  const summary = lastAssistantMessage(session.handle.session) || '(无最终消息文本；以 terminal 证据为准)'
  //    terminalOutcome = 已由 terminal 证据验证的终态（execution 终态由 recordTerminalEvidence 落账）。
  const terminalOutcome = run.terminal.execution.state as 'COMPLETED' | 'FAILED' | 'ABORTED'
  return {
    ok: true,
    executionId: run.execution.execution_id,
    leaseId: gate.lease.lease_id,
    dispatchId: run.intent.dispatch_id,
    sessionRef: session.handle.refs.sessionRef,
    created: session.created,
    summary,
    cleanupReceipt,
    trustFence: run.trustFence,
    terminalOutcome,
  }
}
