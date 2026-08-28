/**
 * dsh-kingdom — v0.8 DSH Persistent Session Backend（M3-S3，RuntimeAdapter 的 DSH 实现）。
 *
 * 依 M3-S3 Thin Spec §2（DSH Mapping，seam 均 @ 00b7102f1d 源码核实）：
 * - createSession  → AgentRegistry.create（meta.cwd=territory.workspace_path；setup 装配 preset）
 * - resumeSession  → AgentRegistry.resume（resumeSessionId=session_ref，恢复同一长期会话）
 * - dispatch       → agent.followup(完整 UserMessage)（C-007 负知识：禁裸 text block）
 * - observeExecution → session.events 事件链重建（turn/start → turn/end → assistant/message，C-006/C-010）
 * - reconcile      → 两维独立（execution 事件链 / session live+persistence）
 *
 * 结构型局部类型（同 dsh-subagent.ts 模式）：不 import dsh 类型、不新增 peer dep。
 * 缺 seam 诚实返回：S4 未实现的 enforcement 面一律 CANNOT_ENFORCE（fail-closed）。
 */
import { randomUUID } from 'node:crypto'
import type {
  CleanupResult,
  DshBackendDeps,
  DispatchInput,
  DispatchReceipt,
  EnforcementRequest,
  ExecutionObservation,
  MaterializeResult,
  PreflightResult,
  ReconcileResult,
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeEnforceableSet,
  RuntimeTrustFence,
  RuntimeTrustFenceCheck,
  RuntimeTrustFenceExpectation,
  RuntimeTrustFenceInput,
  RuntimeTrustFenceOutcome,
  RuntimeTrustFencePhase,
  SessionHandle,
  SessionObservation,
} from './contract.js'
import {
  cleanupDshEnforcement,
  materializeDshEnforcement,
  readEnforceableSet,
  type DshEnforcementContext,
  type DshPolicyDeps,
} from '../capability/dsh-enforcement.js'
import { terminalOutcomeOf } from '../dispatch/evidence.js'

// ── dsh 结构面（@ 00b7102f1d）───────────────────────────────────────────────

interface UserMessageLike {
  id: string
  role: 'user'
  content: { type: 'text'; text: string }[]
  source: { kind: 'user' }
}

interface SessionLike {
  header: { cwd?: string }
  events: readonly { type: string; data?: Record<string, unknown>; [key: string]: unknown }[]
}

interface AgentLike {
  readonly id: string
  readonly status: 'idle' | 'running'
  readonly session: SessionLike
  followup(message: UserMessageLike): void
  whenIdle(): Promise<void>
  cancel(cause: unknown): void
  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T>
}

type FenceState = {
  readonly token: DshTrustFenceToken
  readonly leaseId: string
  readonly sessionRef: string
  runtimeDispatchRef: string | null
  readonly agent: AgentLike
  readonly session: SessionLike
  readonly baselineKeys: readonly string[]
  lastKeys: string[]
  /** Monotonic observation generation; it never moves backwards. */
  generation: number
  lastPhase: RuntimeTrustFencePhase | null
  status: 'OPEN' | 'TAINTED' | 'RELEASED'
  taintReason: string | null
  cleanupUsed: boolean
  maintenanceRelease: (() => void) | null
  maintenance: Promise<void> | null
  readonly reservation: 'SERIALIZED'
}

/** Deliberately not exported: only this backend can issue a fence token. */
class DshTrustFenceToken {
  // Runtime identity is checked through an Adapter-instance-private WeakMap;
  // prevents a plain object from being mistaken for an issued token by code
  // that happens to hold the structural type.
  readonly #opaque = true
}

const FENCE_PHASE_ORDER: Record<RuntimeTrustFencePhase, number> = {
  'terminal-write': 0,
  'cleanup-reserved': 1,
  cleanup: 2,
  settlement: 3,
  release: 4,
}

function eventKey(event: RuntimeEvent): string {
  try {
    return JSON.stringify(event)
  } catch {
    return '<unserializable-event>'
  }
}

function eventMessageId(event: RuntimeEvent): string | null {
  const id = event.data?.id ?? (event.data?.message as { id?: unknown } | undefined)?.id
  return typeof id === 'string' ? id : null
}

function boundedFenceReason(value: string): string {
  const text = value.trim()
  return text.length <= 512 ? text : `${text.slice(0, 511)}…`
}

function fenceResult(
  ok: boolean,
  status: RuntimeTrustFenceCheck['status'],
  reservation: RuntimeTrustFenceCheck['reservation'],
  generation: number | null,
  reason: string,
): RuntimeTrustFenceCheck {
  return { ok, status, reservation, generation, reason: boundedFenceReason(reason) }
}

interface AgentHandleLike {
  readonly agent: AgentLike
  dispose(): Promise<void>
}

interface AgentsLike {
  create(options: {
    sessionId: string
    meta?: { cwd?: string; agentPreset?: string }
    agentOptions?: { provider?: string; model?: string }
    setup?: (agentCtx: unknown) => unknown
  }): Promise<AgentHandleLike>
  resume(options: {
    resumeSessionId: string
    agentOptions?: { provider?: string; model?: string }
    setup?: (agentCtx: unknown) => unknown
  }): Promise<AgentHandleLike>
  get(sessionId: string): AgentLike | undefined
  list(): AgentLike[]
}

interface SessionPersistenceLike {
  has?(id: string): boolean
}

interface AgentPresetsLike {
  mount(agentCtx: unknown, id?: string): Promise<unknown>
  resolveMountable?(id: string): unknown
}

function asAgents(value: unknown): AgentsLike {
  return value as AgentsLike
}

function asPersistence(value: unknown): SessionPersistenceLike | undefined {
  return value as SessionPersistenceLike | undefined
}

function asPresets(value: unknown): AgentPresetsLike | undefined {
  return value as AgentPresetsLike | undefined
}

/** 完整 UserMessage（C-007：followup 必须收完整消息，否则毒化会话）。 */
function buildUserMessage(text: string): UserMessageLike {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * 事件链重建 execution 观测（S3 粗粒度；S5 evidence.ts 细化到 splice/turn 边界）。
 * 以「我们的消息 id 在事件流中出现之后」为起点：
 * - 未见 turn/start         → QUEUED（Intent 已持久、Runtime 未开工）
 * - 有 turn/start 无 turn/end → RUNNING
 * - ★ fail-closed（STABILITY-FINDINGS §4.2）：仅当 turn/end.reason.kind=='completed'
 *   **且** 有 assistant/message 才 TERMINAL；interrupted/aborted/error/blocked/max-tokens
 *   或缺失 → UNKNOWN（不得判 TERMINAL，绝不写 COMPLETED）
 * - 无法判定                 → UNKNOWN
 */
export function reconstructExecutionObservation(
  session: SessionLike,
  sinceDispatchRef: string,
): ExecutionObservation {
  try {
    const events = session.events
    const startIndex = events.findIndex((event) =>
      JSON.stringify(event.data ?? {}).includes(sinceDispatchRef) || event.type === 'user/message' && JSON.stringify(event).includes(sinceDispatchRef),
    )
    if (startIndex === -1) return 'UNKNOWN' // 消息不在本 session 日志（可能未落库）
    const tail = events.slice(startIndex)
    const turnStarts = tail.filter(e => e.type === 'turn/start').length
    if (turnStarts === 0) return 'QUEUED'
    const lastTurnStart = [...tail].reverse().find(e => e.type === 'turn/start')
    const lastTurnEnd = [...tail].reverse().find(e => e.type === 'turn/end')
    const startTurn = lastTurnStart?.data?.turn as number | undefined
    const endTurn = lastTurnEnd?.data?.turn as number | undefined
    const endReason = (() => {
      const data = lastTurnEnd?.data ?? {}
      const fromReason = data.reason !== null && typeof data.reason === 'object'
        ? (data.reason as { kind?: unknown }).kind
        : undefined
      return typeof fromReason === 'string' ? fromReason : (typeof data.kind === 'string' ? data.kind : null)
    })()
    const hasAssistant = tail.some(e => e.type === 'assistant/message')
    const outcome = lastTurnEnd && (startTurn === undefined || endTurn === undefined || endTurn >= startTurn) ? terminalOutcomeOf(endReason) : null
    if (lastTurnEnd && outcome === 'COMPLETED' && hasAssistant) return 'TERMINAL'
    if (lastTurnEnd && (outcome === 'FAILED' || outcome === 'ABORTED')) return 'TERMINAL' // 明确终止 reason（aborted/blocked/error/max-tokens）
    if (lastTurnEnd) return 'UNKNOWN' // completed 无 assistant / interrupted / 缺失 → 证据不足（fail-closed）
    if (lastTurnStart) return 'RUNNING'
    return 'UNKNOWN'
  } catch {
    return 'UNKNOWN'
  }
}

/** DSH RuntimeAdapter 实现。 */
export class DshRuntimeAdapter implements RuntimeAdapter {
  readonly runtimeType = 'dsh'
  /** Fence tokens are accepted only by the exact Adapter instance that issued them. */
  private readonly trustFenceStates = new WeakMap<object, FenceState>()
  private readonly deps: Required<Pick<DshBackendDeps, 'runtimeInstanceRef' | 'provider'>> & {
    model: string | null
    agents: AgentsLike
    sessionPersistence: SessionPersistenceLike | undefined
    presets: AgentPresetsLike | undefined
    policy: DshPolicyDeps
  }

  constructor(deps: DshBackendDeps) {
    this.deps = {
      runtimeInstanceRef: deps.runtimeInstanceRef,
      provider: deps.provider,
      model: deps.model ?? null,
      agents: asAgents(deps.agents),
      sessionPersistence: asPersistence(deps.sessionPersistence),
      presets: asPresets(deps.presets),
      policy: {
        permission: deps.permission as DshPolicyDeps['permission'] | undefined,
        sandboxPolicy: deps.sandboxPolicy as DshPolicyDeps['sandboxPolicy'] | undefined,
        approval: deps.approval as DshPolicyDeps['approval'] | undefined,
      },
    }
  }

  identify(): { runtimeType: string; runtimeInstanceRef: string } {
    return { runtimeType: this.runtimeType, runtimeInstanceRef: this.deps.runtimeInstanceRef }
  }

  private agentOptions(): { provider?: string; model?: string } {
    return { provider: this.deps.provider, ...(this.deps.model ? { model: this.deps.model } : {}) }
  }

  private composeSetup(agentPreset?: string): ((agentCtx: unknown) => Promise<void> | void) | undefined {
    if (!agentPreset || !this.deps.presets) return undefined
    return async (agentCtx: unknown) => {
      await this.deps.presets!.mount(agentCtx, agentPreset)
    }
  }

  async createSession(input: { cwd: string; agentPreset?: string; provider?: string; model?: string }): Promise<SessionHandle> {
    const sessionId = randomUUID()
    const handle = await this.deps.agents.create({
      sessionId,
      meta: { cwd: input.cwd, ...(input.agentPreset ? { agentPreset: input.agentPreset } : {}) },
      agentOptions: { provider: input.provider ?? this.deps.provider, ...(input.model ?? this.deps.model ? { model: input.model ?? this.deps.model! } : {}) },
      setup: this.composeSetup(input.agentPreset),
    })
    return this.toHandle(handle)
  }

  async resumeSession(input: { sessionRef: string; provider?: string; model?: string }): Promise<SessionHandle> {
    const handle = await this.deps.agents.resume({
      resumeSessionId: input.sessionRef,
      agentOptions: { provider: input.provider ?? this.deps.provider, ...(input.model ?? this.deps.model ? { model: input.model ?? this.deps.model! } : {}) },
      setup: undefined, // resume 的 enforcement 装配由 S4 提供（Enforcement Plan → setup）
    })
    return this.toHandle(handle)
  }

  /**
   * v0.8（Owner V0.8 PRODUCTION-PATH CLOSURE B）：同进程 live Session 复用。
   * session 已在 live registry → 返回其 handle（**不** resume）；否则 null。
   * DSH seam（真实 E2E 实证）：`agents.resume` 对 live session 抛
   * `cannot prepare ... while it is live`（PersistenceCoordinator.prepare）；
   * 因此「已有 current affinity 且 session 仍 live」时必须复用同一 live handle——
   * 同一 session_ref = 同一持久 Session = 同一 Worker / Territory affinity。
   */
  getLiveHandle(sessionRef: string): SessionHandle | null {
    const agent = this.deps.agents.get(sessionRef)
    if (!agent) return null
    return {
      refs: {
        runtimeType: this.runtimeType,
        runtimeInstanceRef: this.deps.runtimeInstanceRef,
        sessionRef: agent.id,
      },
      agent,
      session: agent.session,
      dispose: async () => {
        // live agent 生命周期由宿主（AgentRegistry）管理；退役走 retireSession
      },
    }
  }

  private toHandle(handle: AgentHandleLike): SessionHandle {
    const agent = handle.agent
    return {
      refs: {
        runtimeType: this.runtimeType,
        runtimeInstanceRef: this.deps.runtimeInstanceRef,
        sessionRef: agent.id,
      },
      agent,
      session: agent.session,
      dispose: () => handle.dispose(),
    }
  }

  async observeSession(handle: SessionHandle): Promise<SessionObservation> {
    const agent = handle.agent as AgentLike
    if (!agent || !agent.status) return 'gone'
    return agent.status === 'idle' ? 'idle' : 'running'
  }

  async retireSession(handle: SessionHandle): Promise<void> {
    await handle.dispose()
  }

  // ── Governed terminal trust fence ─────────────────────────────────────────

  /**
   * Read the current live projection through the exact registry object.  A
   * fence never trusts a copied Session/Agent-shaped object supplied by a
   * caller; the registry identity is the Runtime-local authority.
   */
  private currentFenceEvents(state: FenceState): readonly RuntimeEvent[] {
    const current = this.deps.agents.get(state.sessionRef)
    if (!current || current !== state.agent || current.id !== state.sessionRef || current.session !== state.session) {
      throw new Error(`trust fence session ${state.sessionRef} is no longer the exact live registry object`)
    }
    const events = state.session.events
    if (!Array.isArray(events)) throw new Error(`trust fence session ${state.sessionRef} has no readable event projection`)
    return events as readonly RuntimeEvent[]
  }

  private taintFence(state: FenceState, reason: string): RuntimeTrustFenceCheck {
    state.status = 'TAINTED'
    state.taintReason = boundedFenceReason(reason)
    return fenceResult(false, 'TAINTED', state.reservation, state.generation, state.taintReason)
  }

  private asFenceState(fence: RuntimeTrustFence): FenceState | undefined {
    return this.trustFenceStates.get(fence as unknown as object)
  }

  private checkFenceExpectation(
    state: FenceState,
    expectation: RuntimeTrustFenceExpectation | undefined,
    operation: string,
  ): RuntimeTrustFenceCheck | null {
    if (!expectation || !expectation.leaseId.trim() || !expectation.sessionRef.trim()) {
      return this.taintFence(state, `${operation} 缺少完整 lease/session expectation`)
    }
    if (expectation.leaseId !== state.leaseId || expectation.sessionRef !== state.sessionRef) {
      return this.taintFence(
        state,
        `${operation} expectation 不匹配：fence=${state.leaseId}/${state.sessionRef} `
          + `received=${expectation.leaseId}/${expectation.sessionRef}`,
      )
    }
    return null
  }

  private inspectFence(
    state: FenceState,
    phase: RuntimeTrustFencePhase,
    expectation: RuntimeTrustFenceExpectation,
  ): RuntimeTrustFenceCheck {
    const expectationFailure = this.checkFenceExpectation(state, expectation, `trust fence ${phase}`)
    if (expectationFailure) return expectationFailure
    if (state.status === 'RELEASED') {
      return fenceResult(false, 'RELEASED', state.reservation, state.generation, 'trust fence 已释放')
    }
    if (state.status === 'TAINTED') {
      return fenceResult(false, 'TAINTED', state.reservation, state.generation, state.taintReason ?? 'trust fence 已污染')
    }
    const previousPhase = state.lastPhase ? FENCE_PHASE_ORDER[state.lastPhase] : -1
    if (FENCE_PHASE_ORDER[phase] < previousPhase) {
      return this.taintFence(state, `trust fence phase regression: ${state.lastPhase} -> ${phase}`)
    }

    let events: readonly RuntimeEvent[]
    try {
      events = this.currentFenceEvents(state)
    } catch (error: unknown) {
      return this.taintFence(state, error instanceof Error ? error.message : String(error))
    }
    const keys = events.map(eventKey)
    if (keys.length < state.lastKeys.length) {
      return this.taintFence(state, 'Runtime event generation moved backwards')
    }
    for (let i = 0; i < state.lastKeys.length; i++) {
      if (keys[i] !== state.lastKeys[i]) {
        return this.taintFence(state, `Runtime event prefix changed at index ${i}`)
      }
    }
    for (let i = 0; i < state.baselineKeys.length; i++) {
      if (keys[i] !== state.baselineKeys[i]) {
        return this.taintFence(state, `Runtime baseline event prefix changed at index ${i}`)
      }
    }

    if (state.runtimeDispatchRef !== null) {
      const dispatchIndex = events.findIndex(event => eventKey(event).includes(state.runtimeDispatchRef!))
      // Every user/message appended after the baseline must be the exact
      // owned dispatch message. This catches foreign ingress that arrived
      // while the Lease was active but before the owned Runtime ref existed;
      // slicing only from the owned ref would hide that history.
      for (let i = state.baselineKeys.length; i < events.length; i++) {
        const event = events[i]
        if (event.type !== 'user/message') continue
        const messageId = eventMessageId(event)
        if (messageId !== state.runtimeDispatchRef || (dispatchIndex >= 0 && i < dispatchIndex)) {
          return this.taintFence(state, `foreign user message crossed trust fence${messageId ? `: ${messageId}` : ''}`)
        }
      }
    }

    if (keys.length > state.lastKeys.length) state.generation += 1
    state.lastKeys = keys
    state.lastPhase = phase
    return fenceResult(true, 'VALID', state.reservation, state.generation, 'trust fence valid')
  }

  async openTrustFence(input: RuntimeTrustFenceInput): Promise<RuntimeTrustFence> {
    const sessionRef = input.sessionRef.trim()
    if (!input.leaseId.trim() || !sessionRef) throw new Error('trust fence requires leaseId and sessionRef')
    const agent = this.deps.agents.get(sessionRef)
    if (!agent || agent.id !== sessionRef) throw new Error(`trust fence cannot resolve exact live Agent ${sessionRef}`)
    if (agent.status !== 'idle') throw new Error(`trust fence requires idle Agent ${sessionRef}`)
    if (typeof agent.runMaintenance !== 'function') {
      throw new Error(`trust fence Runtime ingress reservation seam missing for Agent ${sessionRef}`)
    }
    const currentEvents = agent.session?.events
    if (!Array.isArray(currentEvents)) throw new Error(`trust fence cannot read Session events for ${sessionRef}`)
    const baselineKeys = currentEvents.map(eventKey)
    const suppliedKeys = input.baselineEvents.map(eventKey)
    if (baselineKeys.length !== suppliedKeys.length || baselineKeys.some((key, i) => key !== suppliedKeys[i])) {
      throw new Error(`trust fence baseline is stale for Session ${sessionRef}`)
    }
    if (input.runtimeDispatchRef !== null && input.runtimeDispatchRef.trim() === '') {
      throw new Error('trust fence runtimeDispatchRef must be null or non-empty')
    }
    const token = new DshTrustFenceToken()
    this.trustFenceStates.set(token, {
      token,
      leaseId: input.leaseId,
      sessionRef,
      runtimeDispatchRef: input.runtimeDispatchRef,
      agent,
      session: agent.session,
      baselineKeys,
      lastKeys: [...baselineKeys],
      generation: 0,
      lastPhase: null,
      status: 'OPEN',
      taintReason: null,
      cleanupUsed: false,
      maintenanceRelease: null,
      maintenance: null,
      reservation: 'SERIALIZED',
    })
    return token as unknown as RuntimeTrustFence
  }

  bindTrustFence(
    fence: RuntimeTrustFence,
    runtimeDispatchRef: string,
    expectation: RuntimeTrustFenceExpectation,
  ): RuntimeTrustFenceCheck {
    const state = this.asFenceState(fence)
    if (!state) return fenceResult(false, 'UNKNOWN', 'UNKNOWN', null, 'unknown trust fence token')
    const expectationFailure = this.checkFenceExpectation(state, expectation, 'trust fence bind')
    if (expectationFailure) return expectationFailure
    if (!runtimeDispatchRef.trim()) return this.taintFence(state, 'runtimeDispatchRef missing at fence bind')
    if (state.runtimeDispatchRef !== null && state.runtimeDispatchRef !== runtimeDispatchRef) {
      return this.taintFence(state, 'runtimeDispatchRef changed after fence bind')
    }
    state.runtimeDispatchRef = runtimeDispatchRef
    return this.inspectFence(state, 'terminal-write', expectation)
  }

  checkTrustFence(
    fence: RuntimeTrustFence,
    phase: RuntimeTrustFencePhase,
    expectation: RuntimeTrustFenceExpectation,
  ): RuntimeTrustFenceCheck {
    const state = this.asFenceState(fence)
    if (!state) return fenceResult(false, 'UNKNOWN', 'UNKNOWN', null, 'unknown trust fence token')
    return this.inspectFence(state, phase, expectation)
  }

  /**
   * Execute the disposer while the Runtime's own maintenance ingress
   * reservation is held.  Normal followup calls are queued by DSH until the
   * hold is released; an already-running/unmanaged ingress makes the
   * reservation fail and the fence is tainted before any disposer call.
   */
  private async cleanupWithFence(
    request: EnforcementRequest,
    context: DshEnforcementContext,
    fence: RuntimeTrustFence,
    state: FenceState,
    expectation: RuntimeTrustFenceExpectation,
  ): Promise<CleanupResult> {
    if (state.cleanupUsed) throw new Error('trust fence cleanup is exactly-once')
    state.cleanupUsed = true
    if (
      context.sessionRef !== state.sessionRef
      || (context.agent as unknown) !== (state.agent as unknown)
      || (context.agent.session as unknown) !== (state.session as unknown)
    ) {
      this.taintFence(state, 'cleanup context is not bound to the fenced Agent/Session')
      throw new Error('cleanup context does not match trust fence')
    }

    let resultResolve!: (result: CleanupResult) => void
    let resultReject!: (error: unknown) => void
    let resultSettled = false
    const resultPromise = new Promise<CleanupResult>((resolve, reject) => {
      resultResolve = resolve
      resultReject = reject
    })
    let releaseHold!: () => void
    const hold = new Promise<void>(resolve => { releaseHold = resolve })
    state.maintenanceRelease = releaseHold

    const settleResult = (result: CleanupResult): void => {
      if (resultSettled) return
      resultSettled = true
      resultResolve(result)
    }
    const rejectResult = (error: unknown): void => {
      if (resultSettled) return
      resultSettled = true
      resultReject(error)
    }

    try {
      const maintenance = (state.agent as AgentLike).runMaintenance(async (signal: AbortSignal) => {
        if (signal.aborted) {
          this.taintFence(state, 'Runtime maintenance reservation aborted')
          rejectResult(new Error('Runtime maintenance reservation aborted'))
          await hold
          return
        }
        const reserved = this.inspectFence(state, 'cleanup-reserved', expectation)
        if (!reserved.ok) {
          rejectResult(new Error(reserved.reason))
          await hold
          return
        }
        const cleanupCheck = this.inspectFence(state, 'cleanup', expectation)
        if (!cleanupCheck.ok) {
          rejectResult(new Error(cleanupCheck.reason))
          await hold
          return
        }
        try {
          settleResult(await cleanupDshEnforcement(context))
        } catch (error: unknown) {
          rejectResult(error)
        }
        await hold
      })
      state.maintenance = maintenance.then(() => undefined, error => {
        // A rejected reservation is an ingress-fence failure, not merely a
        // cleanup Promise failure.  Taint before propagating so the caller's
        // subsequent settlement check cannot persist terminal evidence or
        // release a Lease on an unprotected Runtime path.
        this.taintFence(
          state,
          `Runtime maintenance reservation rejected: ${error instanceof Error ? error.message : String(error)}`,
        )
        rejectResult(error)
      })
    } catch (error: unknown) {
      this.taintFence(state, `Runtime maintenance reservation failed: ${error instanceof Error ? error.message : String(error)}`)
      rejectResult(error)
      state.maintenance = null
    }
    return resultPromise
  }

  cleanup(
    request: EnforcementRequest,
    context: unknown,
    fence?: RuntimeTrustFence,
    expectation?: RuntimeTrustFenceExpectation,
  ): Promise<CleanupResult> {
    const ctx = context as DshEnforcementContext | undefined
    if (!ctx?.agent?.session) return Promise.resolve({ ok: false, evidenceJson: null })
    if (!fence) return cleanupDshEnforcement(ctx)
    const state = this.asFenceState(fence)
    if (!state) return Promise.reject(new Error('cleanup received unknown trust fence token'))
    const expectationFailure = this.checkFenceExpectation(state, expectation, 'trust fence cleanup')
    if (expectationFailure) return Promise.reject(new Error(expectationFailure.reason))
    const checked = this.inspectFence(state, 'cleanup-reserved', expectation!)
    if (!checked.ok) return Promise.reject(new Error(checked.reason))
    return this.cleanupWithFence(request, ctx, fence, state, expectation!)
  }

  releaseTrustFence(
    fence: RuntimeTrustFence,
    outcome: RuntimeTrustFenceOutcome,
    expectation: RuntimeTrustFenceExpectation,
  ): RuntimeTrustFenceCheck {
    const state = this.asFenceState(fence)
    if (!state) return fenceResult(false, 'UNKNOWN', 'UNKNOWN', null, 'unknown trust fence token')
    const expectationFailure = this.checkFenceExpectation(state, expectation, 'trust fence release')
    if (expectationFailure) return expectationFailure
    if (state.status === 'RELEASED') return fenceResult(true, 'RELEASED', state.reservation, state.generation, 'trust fence already released')
    if (outcome === 'RELEASED') {
      const checked = this.inspectFence(state, 'release', expectation)
      if (!checked.ok) return checked
    }
    state.status = 'RELEASED'
    const release = state.maintenanceRelease
    state.maintenanceRelease = null
    release?.()
    return fenceResult(true, 'RELEASED', state.reservation, state.generation, `trust fence released (${outcome})`)
  }

  // ── Capability（S4：context-bound 集合 + preflight/materialize/cleanup）────────

  /**
   * context-bound Runtime Enforceable Set：回答「这次 Session 下**能** enforce 什么」。
   * - tools：只有当前 context 同时暴露 `restrict`/`guard` 时，才计算
   *   A∩B（A=真实 `tools.schemas()` Runtime inventory；B=preset 声明面，回退 session 装配面）；
   *   schemas 单独存在只代表声明，不进入 RuntimeEnforceableSet，见 `readEnforceableSet`；
   * - sandboxMode/approvalPolicy：只从当前 context-bound Session 的最新政策事件重建；
   *   构造期 setter 是否存在不能证明这次 Session 当前已经可 enforce。
   */
  async capabilities(context: unknown): Promise<RuntimeEnforceableSet> {
    const ctx = context as DshEnforcementContext | undefined
    if (!ctx?.agent?.session) {
      return { tools: [], sandboxMode: null, approvalPolicy: null, presetId: null }
    }
    return readEnforceableSet(ctx, { presets: this.deps.presets })
  }

  /** preflight：纯检查、零副作用（M3-S1 Stage 3）。 */
  async preflight(request: EnforcementRequest, context: unknown): Promise<PreflightResult> {
    const reasons: string[] = []
    const ctx = context as DshEnforcementContext | undefined
    if (request.approvalPolicy !== 'never') {
      reasons.push('governed Execution 要求 approvalPolicy=never（禁扩权）；收到 ' + request.approvalPolicy)
    }
    if (typeof ctx?.agent?.ctx?.tools?.restrict !== 'function' || typeof ctx.agent.ctx.tools.guard !== 'function') {
      reasons.push('agent.ctx.tools 无 restrict/guard（工具面不可 enforce）')
    }
    if (!request.presetId && !this.deps.policy.sandboxPolicy) {
      reasons.push('sandboxPolicy 缺失且未指定 permission preset（领地写边界不可 enforce）')
    }
    if (!request.presetId && !this.deps.policy.approval) {
      reasons.push('approval 服务缺失且未指定 permission preset（禁扩权不可 enforce）')
    }
    if (request.sandboxMode === 'workspace-write' && !request.territoryPath) {
      reasons.push('workspace-write 要求 territoryPath（领地写边界无锚点）')
    }
    return { ok: reasons.length === 0, reasons }
  }

  /** materialize：把 EnforcementRequest 应用到 live session；失败 → DENIED + zero execution。 */
  async materialize(request: EnforcementRequest, context: unknown): Promise<MaterializeResult> {
    const ctx = context as DshEnforcementContext | undefined
    if (!ctx?.agent?.session) return { ok: false, evidenceJson: null, reasons: ['materialize: 缺少 live session context'] }
    return materializeDshEnforcement(this.deps.policy, ctx, request)
  }

  // ── Dispatch / Evidence / Reconcile ────────────────────────────────────────

  async dispatch(input: DispatchInput): Promise<DispatchReceipt> {
    const agent = this.deps.agents.get(input.sessionRef)
    if (!agent) throw new Error(`dsh dispatch: session ${input.sessionRef} 不在 live registry（无法 dispatch）`)
    const message = buildUserMessage(input.text)
    agent.followup(message) // 持久 splice 插入即「已接受」
    return {
      refs: {
        runtimeType: this.runtimeType,
        runtimeInstanceRef: this.deps.runtimeInstanceRef,
        sessionRef: input.sessionRef,
        runtimeDispatchRef: message.id,
      },
      acceptedAt: new Date().toISOString(),
    }
  }

  async observeExecution(refs: { sessionRef: string; runtimeDispatchRef?: string }, session: unknown): Promise<ExecutionObservation> {
    const live = session as SessionLike | undefined
    if (!live || !Array.isArray(live.events) || !refs.runtimeDispatchRef) return 'UNKNOWN'
    return reconstructExecutionObservation(live, refs.runtimeDispatchRef)
  }

  async reconcile(kingdomDispatchId: string, refs: { sessionRef: string; runtimeDispatchRef?: string }): Promise<ReconcileResult> {
    // session 维：live registry 或持久可恢复 → AVAILABLE；否则 UNKNOWN（GONE 需显式删除证据，S5 细化）
    const live = this.deps.agents.get(refs.sessionRef)
    let sessionObservation: ReconcileResult['sessionObservation'] = 'UNKNOWN'
    if (live) sessionObservation = 'AVAILABLE'
    else if (this.deps.sessionPersistence?.has?.(refs.sessionRef) === true) sessionObservation = 'AVAILABLE'

    // execution 维：live 会话事件链；不可判定 → UNKNOWN（fail-closed，不盲发、不 ABORT）
    let executionObservation: ExecutionObservation = 'UNKNOWN'
    if (live && refs.runtimeDispatchRef) {
      executionObservation = reconstructExecutionObservation(live.session, refs.runtimeDispatchRef)
    }
    return {
      executionObservation,
      sessionObservation,
      evidence: { kingdomDispatchId, runtimeDispatchRef: refs.runtimeDispatchRef ?? null, observedAt: new Date().toISOString() },
    }
  }
}
