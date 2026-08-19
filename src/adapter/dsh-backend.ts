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
  RuntimeEnforceableSet,
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

  // ── Capability（S4：context-bound 集合 + preflight/materialize/cleanup）────────

  /**
   * context-bound Runtime Enforceable Set：回答「这次 Session 下**能** enforce 什么」。
   * - tools：A∩B（A=真实 `tools.schemas()` Runtime inventory；B=preset 声明面，回退 session 装配面）——
   *   Owner S4 seam 裁决（A+B 组合），见 `readEnforceableSet`；
   * - sandboxMode：有 confining 后端（sandboxPolicy 或 permission preset）→ 'workspace-write'；
   * - approvalPolicy：有禁扩权机制（approval 或 permission preset）→ 'never'。
   */
  async capabilities(context: unknown): Promise<RuntimeEnforceableSet> {
    const ctx = context as DshEnforcementContext | undefined
    const tools = ctx?.agent?.session ? (await readEnforceableSet(ctx, { presets: this.deps.presets })).tools : []
    const hasSandbox = Boolean(this.deps.policy.sandboxPolicy || this.deps.policy.permission)
    const hasApproval = Boolean(this.deps.policy.approval || this.deps.policy.permission)
    return {
      tools,
      sandboxMode: hasSandbox ? 'workspace-write' : null,
      approvalPolicy: hasApproval ? 'never' : null,
      presetId: null,
    }
  }

  /** preflight：纯检查、零副作用（M3-S1 Stage 3）。 */
  async preflight(request: EnforcementRequest, context: unknown): Promise<PreflightResult> {
    const reasons: string[] = []
    const ctx = context as DshEnforcementContext | undefined
    if (request.approvalPolicy !== 'never') {
      reasons.push('governed Execution 要求 approvalPolicy=never（禁扩权）；收到 ' + request.approvalPolicy)
    }
    if (!ctx?.agent?.ctx?.tools?.restrict || !ctx.agent.ctx.tools.guard) {
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

  /** cleanup：拆除 per-execution guard/restrict（session 级政策保留）。 */
  async cleanup(_request: EnforcementRequest, context: unknown): Promise<CleanupResult> {
    const ctx = context as DshEnforcementContext | undefined
    if (!ctx?.agent?.session) return { ok: false, evidenceJson: null }
    return cleanupDshEnforcement(ctx)
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
