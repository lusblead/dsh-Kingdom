/**
 * dsh-kingdom — v0.8 RuntimeAdapter Contract（Runtime-independent，M3-S3）。
 *
 * 依 M3-S1 Design v3（FROZEN）+ M3-S3 Thin Spec（DRAFT）：
 * - Core 只依赖本接口，绝不 import 任何 Runtime 实现（M3-S1「禁写实现泄漏」）；
 * - 全部引用走泛化 `RuntimeRefs`，Core 不解释内部格式；
 * - `dispatch()` 只在 Kingdom COMMIT POINT（createDispatchIntent 提交后）调用；
 * - `DispatchReceipt ≠ Terminal Evidence`；terminal 由 Adapter 从事件链重建；
 * - Runtime 无法证明 enforce → CANNOT_ENFORCE（DENIED + zero execution）。
 *
 * 本文件零 dsh 依赖（无 import），因此 Core 与自测都不需要活的 DSH。
 */
import type { SessionIdentity } from '../core/governed.js'

/** 泛化 Runtime 引用（Core 保存/关联/比较，不解释格式）。 */
export interface RuntimeRefs {
  readonly runtimeType: string
  readonly runtimeInstanceRef: string
  readonly sessionRef: string
  /** 一次 dispatch 的 runtime 侧引用（DSH：UserMessage.id）。 */
  readonly runtimeDispatchRef?: string
  /** 一次 execution 的 runtime 侧引用（DSH：turn/session log 游标）。 */
  readonly runtimeExecutionRef?: string
}

/** Adapter 侧持有的 Session 句柄（agent/session 为 Adapter 私有，不升格 Core 类型）。 */
export interface SessionHandle {
  readonly refs: RuntimeRefs
  /** Adapter 私有的 live agent 句柄（DSH：Agent）。Core 不触碰。 */
  readonly agent: unknown
  /** Adapter 私有的 session 对象（DSH：Session）。Core 不触碰。 */
  readonly session: unknown
  /** 退役/卸载：停 loop、注销、删 session、unwind scope。 */
  dispose(): Promise<void>
}

/** Session 观测：idle/running/maintenance/gone/unknown（两维 reconcile 的 session 维输入）。 */
export type SessionObservation = 'idle' | 'running' | 'maintenance' | 'gone' | 'unknown'

/** Execution 观测：QUEUED/RUNNING/TERMINAL/UNKNOWN（两维 reconcile 的 execution 维）。 */
export type ExecutionObservation = 'QUEUED' | 'RUNNING' | 'TERMINAL' | 'UNKNOWN'

export interface DispatchReceipt {
  readonly refs: RuntimeRefs
  readonly acceptedAt: string
}

/** Runtime event projection consumed by the dispatch trust-fence seam. */
export interface RuntimeEvent {
  readonly type: string
  readonly data?: Record<string, unknown>
  readonly [key: string]: unknown
}

/**
 * An opaque, adapter-issued reservation for one governed dispatch.
 *
 * The brand is deliberately module-private at the type level. Runtime
 * implementations must also validate object identity; callers must never
 * construct a fence from its visible shape or copy its fields between
 * sessions/leases.
 */
declare const runtimeTrustFenceBrand: unique symbol
export interface RuntimeTrustFence {
  readonly [runtimeTrustFenceBrand]: 'RuntimeTrustFence'
}

/**
 * The Core-side identity proof required when an opaque fence is consumed.
 *
 * `leaseId` and `sessionRef` are correlation facts, not authority.  The
 * adapter must compare them with the values captured when it issued the
 * fence; callers must not be able to retarget a fence by passing a different
 * lease/session pair at cleanup or settlement time.
 */
export interface RuntimeTrustFenceExpectation {
  readonly leaseId: string
  readonly sessionRef: string
}

export type RuntimeTrustFencePhase =
  | 'terminal-write'
  | 'cleanup-reserved'
  | 'cleanup'
  | 'settlement'
  | 'release'

export type RuntimeTrustFenceOutcome = 'RELEASED' | 'RECOVERING'

export interface RuntimeTrustFenceInput {
  readonly leaseId: string
  readonly sessionRef: string
  /** Runtime dispatch ref is bound after the adapter accepts the owned message. */
  readonly runtimeDispatchRef: string | null
  /** Snapshot taken before the owned Runtime dispatch side effect. */
  readonly baselineEvents: readonly RuntimeEvent[]
}

export interface RuntimeTrustFenceCheck {
  readonly ok: boolean
  readonly status: 'VALID' | 'TAINTED' | 'UNKNOWN' | 'RELEASED'
  readonly reservation: 'SERIALIZED' | 'DETECT_ONLY' | 'UNKNOWN'
  readonly generation: number | null
  readonly reason: string
}

export interface ReconcileResult {
  readonly executionObservation: ExecutionObservation
  readonly sessionObservation: 'AVAILABLE' | 'GONE' | 'UNKNOWN'
  readonly evidence?: unknown
  readonly terminalOutcome?: unknown
}

/** context-bound Runtime Enforceable Set（Stage 3 冻结：静态声明不参与安全公式）。 */
export interface RuntimeEnforceableSet {
  readonly tools: readonly string[]
  readonly sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access' | null
  readonly approvalPolicy: 'never' | 'ask' | null
  readonly presetId: string | null
}

/** Resolver → Adapter 的 EnforcementRequest（S4 消费；本契约先定形状）。 */
export interface EnforcementRequest {
  readonly tools: readonly string[]
  readonly territoryPath: string
  readonly sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly approvalPolicy: 'never' | 'ask'
  readonly presetId?: string
}

/** preflight：side-effect free 纯检查（S4 实现真实核对）。 */
export interface PreflightResult {
  readonly ok: boolean
  readonly reasons: readonly string[]
}

/** materialize：Runtime mutation，必须在 dispatch 前；失败 → DENIED + zero execution + cleanup。 */
export interface MaterializeResult {
  readonly ok: boolean
  /** typed envelope（DshEnforcementEvidence/v1）JSON；Core 只 store/hash/route。 */
  readonly evidenceJson: string | null
  readonly reasons: readonly string[]
}

export interface CleanupResult {
  readonly ok: boolean
  readonly evidenceJson: string | null
}

export interface DispatchInput {
  readonly sessionRef: string
  readonly text: string
}

/** RuntimeAdapter 接口（M3-S3 Thin Spec §1）。 */
export interface RuntimeAdapter {
  readonly runtimeType: string
  identify(): { runtimeType: string; runtimeInstanceRef: string }

  // ── Session 生命周期 ──
  createSession(input: { cwd: string; agentPreset?: string; provider?: string; model?: string }): Promise<SessionHandle>
  resumeSession(input: { sessionRef: string; provider?: string; model?: string }): Promise<SessionHandle>
  /**
   * v0.8（Owner V0.8 PRODUCTION-PATH CLOSURE B）：同进程 live Session 复用。
   * session 已在 live registry → 返回其 handle（**不** resume；resume 对 live session 可能失败/
   * 语义错误）；否则返回 null（调用方走 resumeSession）。
   * 必须保持 same session_ref / same Worker identity / same Territory affinity；
   * 禁止因 resume 失败新建第二个 session；禁止自动退化 one-shot。
   */
  getLiveHandle(sessionRef: string): SessionHandle | null
  observeSession(handle: SessionHandle): Promise<SessionObservation>
  retireSession(handle: SessionHandle): Promise<void>

  // ── Capability（S4 实现；S3 诚实返回 CANNOT_ENFORCE）──
  capabilities(context: unknown): Promise<RuntimeEnforceableSet>
  preflight(request: EnforcementRequest, context: unknown): Promise<PreflightResult>
  materialize(request: EnforcementRequest, context: unknown): Promise<MaterializeResult>
  /**
   * cleanup consumes the same opaque fence as terminal settlement when the
   * call belongs to a governed persistent dispatch. Capability-denial cleanup
   * may omit the fence because no governed terminal exists yet.
   */
  cleanup(
    request: EnforcementRequest,
    context: unknown,
    fence?: RuntimeTrustFence,
    expectation?: RuntimeTrustFenceExpectation,
  ): Promise<CleanupResult>

  // ── Governed terminal trust fence ──
  openTrustFence(input: RuntimeTrustFenceInput): Promise<RuntimeTrustFence>
  bindTrustFence(
    fence: RuntimeTrustFence,
    runtimeDispatchRef: string,
    expectation: RuntimeTrustFenceExpectation,
  ): RuntimeTrustFenceCheck
  checkTrustFence(
    fence: RuntimeTrustFence,
    phase: RuntimeTrustFencePhase,
    expectation: RuntimeTrustFenceExpectation,
  ): RuntimeTrustFenceCheck
  /** Fence release is a synchronous state transition; any held Runtime
   * reservation is released by the adapter before this method returns. */
  releaseTrustFence(
    fence: RuntimeTrustFence,
    outcome: RuntimeTrustFenceOutcome,
    expectation: RuntimeTrustFenceExpectation,
  ): RuntimeTrustFenceCheck

  // ── Dispatch / Evidence / Reconcile ──
  dispatch(input: DispatchInput): Promise<DispatchReceipt>
  observeExecution(refs: RuntimeRefs, session: unknown): Promise<ExecutionObservation>
  reconcile(kingdomDispatchId: string, refs: RuntimeRefs): Promise<ReconcileResult>
}

/** DSH backend 的构造入参（注入面；结构型，不 import dsh 类型——dsh-subagent.ts 同款模式）。 */
export interface DshBackendDeps {
  runtimeInstanceRef: string
  provider: string
  model: string | null
  /** ctx.agents（AgentRegistry，结构面）。 */
  agents: unknown
  /** ctx.get('sessionPersistence')（可选；reconcile 判定 GONE/AVAILABLE）。 */
  sessionPersistence?: unknown
  /** ctx.agentPresets（可选；setup 装配 preset 用）。 */
  presets?: unknown
  /** ctx.get('permission')（S4：permissionPresets.set(session, name)）。 */
  permission?: unknown
  /** @deepseek-ai/dsh-sandbox-policy（S4：setSandboxMode）。 */
  sandboxPolicy?: unknown
  /** @deepseek-ai/dsh-user-approval（S4：setApprovalPolicy）。 */
  approval?: unknown
}

export type { SessionIdentity }
