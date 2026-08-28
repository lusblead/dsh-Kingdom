/**
 * dsh-kingdom — v0.8 Governed Task Runner 验收测试。
 *
 * 覆盖：happy path（session→gate→dispatch→terminal→claim 摘要）/ DENIED zero execution /
 * G11 未 reconcile 禁新 attempt / schema 非 v4 fail-closed /
 * Owner V0.8 PRODUCTION-PATH CLOSURE A+B（provider/model 解析 fail-closed；live session 复用不 resume）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KingdomStore } from '../lib/core/db.js'
import { runGovernedTask } from '../lib/worker/governed-executor.js'
import { resolveGovernedWorkerRuntime } from '../lib/worker/executor-factory.js'
import { DshRuntimeAdapter } from '../lib/adapter/dsh-backend.js'
import type { CleanupReceipt } from '../lib/dispatch/service.js'

const NOW = () => new Date().toISOString()

/** Worker 执行配置（Owner CLOSURE A 的权威来源；缺省给合法 model 使 happy path 可用）。 */
const WORKER_PROFILE = JSON.stringify({ provider: 'spawn', model: 'deepseek-v4-pro' })

function makeEnv(workerProfileJson: string | null = WORKER_PROFILE): { store: KingdomStore; kingdomId: string; worker: string; sup: string; terrA: string; taskId: string } {
  const store = new KingdomStore(':memory:')
  const kingdomId = 'k'
  store.insertKingdom({ kingdom_id: kingdomId, name: 'K', created_at: NOW(), owner_id: 'o1', owner_name: 'T' })
  const worker = `w-${Math.random().toString(36).slice(2, 8)}`
  const sup = `s-${Math.random().toString(36).slice(2, 8)}`
  store.insertBinding({ binding_id: worker, kingdom_id: kingdomId, role_type: 'WORKER', role_name: 'W', runtime_type: 'dsh', session_id: null, model_name: null, agent_name: null, session_meta: null, execution_profile_json: workerProfileJson, status: 'ACTIVE', retired_at: null, retired_reason: null, principal_id: null, created_at: NOW(), updated_at: NOW() })
  store.insertBinding({ binding_id: sup, kingdom_id: kingdomId, role_type: 'SUPERVISOR', role_name: 'S', runtime_type: 'dsh', session_id: null, model_name: null, agent_name: null, session_meta: null, execution_profile_json: null, status: 'ACTIVE', retired_at: null, retired_reason: null, principal_id: null, created_at: NOW(), updated_at: NOW() })
  const terrA = `t-${Math.random().toString(36).slice(2, 8)}`
  store.insertTerritory({ territory_id: terrA, kingdom_id: kingdomId, name: 'A', workspace_path: 'C:/terr-a', summary: null, supervisor_binding_id: sup, status: 'ACTIVE', deleted_at: null, deleted_reason: null, created_at: NOW() })
  const taskId = `task-${Math.random().toString(36).slice(2, 8)}`
  store.insertTask({ task_id: taskId, territory_id: terrA, parent_task_id: null, title: 'T', description: null, assigned_binding_id: worker, status: 'ASSIGNED', acceptance_criteria: 'AC', result_summary: null, created_at: NOW(), updated_at: NOW() })
  return { store, kingdomId, worker, sup, terrA, taskId }
}

/** Auto-terminal mock 的 turn 行为（Release Blocker 测试用）。 */
interface AutoTerminalOptions {
  /** turn/end 的 reason.kind（缺省 completed）。 */
  turnEndReason?: string
  /** 是否产生 assistant/message（缺省 true；completed 判定要求 assistant）。 */
  assistant?: boolean
  /** 在本 dispatch 后注入一条 foreign user message，验证 live trust fence。 */
  foreignUserMessage?: boolean
  /** 在 terminal 观察后、cleanup reservation 入口前注入 foreign activity。 */
  lateForeignUserMessage?: boolean
  /** Lease 已 active、owned dispatch ref 尚未绑定时注入 foreign activity。 */
  foreignBeforeOwnedDispatch?: boolean
  /** Model the DSH runMaintenance ingress reservation by queueing followups. */
  isolateIngress?: boolean
  /** Keep the adapter cleanup Promise pending after the Runtime reservation is established. */
  pendingCleanup?: boolean
  /** 覆盖 terminal 后的唯一 enforcement cleanup 结果。 */
  cleanup?: 'confirmed' | 'false' | 'throw' | 'missing-evidence' | 'pending'
  /** Fail the Runtime ingress reservation before the disposer can run. */
  maintenanceFailure?: 'reject' | 'throw' | 'aborted'
}

function makeAdapterWithAutoTerminal(options?: AutoTerminalOptions): {
  adapter: DshRuntimeAdapter
  getAgent: () => { id: string; session: { header: { cwd: string }; events: { type: string; data?: Record<string, unknown> }[] }; ctx: { tools: unknown }; followup(msg: { id: string }): void } | undefined
  resumeCalls: () => number
  createOptions: () => Record<string, unknown>[]
  dropLive: (sessionRef: string) => void
  preflightRequests: () => unknown[]
  materializeRequests: () => unknown[]
  cleanupRequests: () => unknown[]
  dispatchCalls: () => number
  preflightContexts: () => unknown[]
  materializeContexts: () => unknown[]
  cleanupContexts: () => unknown[]
  cleanupDisposerCalls: () => number
  ingressHeld: () => boolean
  cleanupEntered: () => boolean
  resolvePendingCleanup: () => void
} {
  const reasonKind = options?.turnEndReason ?? 'completed'
  const assistant = options?.assistant ?? true
  const injectForeignUserMessage = options?.foreignUserMessage ?? false
  const cleanupMode = options?.cleanup ?? 'confirmed'
  const isolateIngress = options?.isolateIngress ?? false
  const pendingCleanup = options?.pendingCleanup ?? cleanupMode === 'pending'
  const maintenanceFailure = options?.maintenanceFailure
  let cleanupDisposerCalls = 0
  let cleanupHasEntered = false
  let releasePendingCleanup: () => void = () => {}
  const pendingCleanupRelease = new Promise<void>(resolve => { releasePendingCleanup = resolve })
  let maintenanceActive = false
  const queuedFollowups: { id: string }[] = []
  const append = (s: { events: { type: string; data?: Record<string, unknown> }[] }, type: string, data?: Record<string, unknown>) =>
    s.events.push({ type, ...(data ? { data } : {}) })
  const agents = new Map<string, { id: string; status: 'idle' | 'running'; session: { header: { cwd: string }; events: { type: string; data?: Record<string, unknown> }[] }; ctx: { tools: unknown }; followup(msg: { id: string }): void; runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> }>()
  let resumeCount = 0
  let dispatchCount = 0
  const createdOptions: Record<string, unknown>[] = []
  const adapter = new DshRuntimeAdapter({
    runtimeInstanceRef: 'inst-1', provider: 'spawn', model: null,
    agents: {
      agents,
      create: async (options: { sessionId: string; meta?: { cwd?: string }; agentOptions?: Record<string, unknown>; setup?: (ctx: unknown) => unknown }) => {
        createdOptions.push(options)
        const agent = {
          id: options.sessionId,
          status: 'idle' as const,
          session: { header: { cwd: options.meta?.cwd ?? 'C:/terr-a' }, events: [] as { type: string; data?: Record<string, unknown> }[] },
           ctx: { tools: { restrict: () => () => { cleanupDisposerCalls++ }, guard: () => () => { cleanupDisposerCalls++ }, schemas: () => [{ name: 'pwsh' }] } },
          followup(msg: { id: string }): void {
            if (isolateIngress && maintenanceActive) {
              queuedFollowups.push(msg)
              return
            }
            // live 复用时同一 agent 的第二次 followup = REWORK 第二轮（turn-2 + 返工文案）
            const n = ((this as unknown as { __fc?: number }).__fc = ((this as unknown as { __fc?: number }).__fc ?? 0) + 1)
            this.session.events.push({ type: 'user/message', data: { id: msg.id } })
            if (injectForeignUserMessage) {
              this.session.events.push({ type: 'user/message', data: { id: `foreign-${msg.id}` } })
            }
            this.session.events.push({ type: 'turn/start', data: { turn: n } })
            this.session.events.push({ type: 'turn/end', data: { turn: n, reason: { kind: reasonKind } } })
            if (assistant) {
              this.session.events.push({ type: 'assistant/message', data: { text: n === 1 ? '任务完成：满足验收标准 AC。' : '返工完成：已修正。' } })
            }
          },
          runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
            if (maintenanceFailure === 'reject') {
              return Promise.reject(new Error('maintenance reservation rejected'))
            }
            if (maintenanceFailure === 'throw') {
              throw new Error('maintenance reservation threw')
            }
            if (maintenanceFailure === 'aborted') {
              const controller = new AbortController()
              controller.abort()
              return job(controller.signal)
            }
            if (!isolateIngress) return job(new AbortController().signal)
            maintenanceActive = true
            return job(new AbortController().signal).finally(() => {
              maintenanceActive = false
              const queued = queuedFollowups.splice(0)
              for (const queuedMessage of queued) this.followup(queuedMessage)
            })
          },
        }
        agents.set(agent.id, agent)
        if (options.setup) await options.setup({})
        return { agent, dispose: async () => { agents.delete(agent.id) } }
      },
      resume: async (options: { resumeSessionId: string; setup?: (ctx: unknown) => unknown }) => {
        resumeCount++
        const agent = {
          id: options.resumeSessionId,
          status: 'idle' as const,
          session: { header: { cwd: 'C:/terr-a' }, events: [] as { type: string; data?: Record<string, unknown> }[] },
          ctx: { tools: { restrict: () => () => {}, guard: () => () => {}, schemas: () => [{ name: 'pwsh' }] } },
          followup(msg: { id: string }): void {
            if (isolateIngress && maintenanceActive) {
              queuedFollowups.push(msg)
              return
            }
            this.session.events.push({ type: 'user/message', data: { id: msg.id } })
            this.session.events.push({ type: 'turn/start', data: { turn: 2 } })
            this.session.events.push({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
            this.session.events.push({ type: 'assistant/message', data: { text: '返工完成：已修正。' } })
          },
          runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
            if (maintenanceFailure === 'reject') {
              return Promise.reject(new Error('maintenance reservation rejected'))
            }
            if (maintenanceFailure === 'throw') {
              throw new Error('maintenance reservation threw')
            }
            if (maintenanceFailure === 'aborted') {
              const controller = new AbortController()
              controller.abort()
              return job(controller.signal)
            }
            if (!isolateIngress) return job(new AbortController().signal)
            maintenanceActive = true
            return job(new AbortController().signal).finally(() => {
              maintenanceActive = false
              const queued = queuedFollowups.splice(0)
              for (const queuedMessage of queued) this.followup(queuedMessage)
            })
          },
        }
        agents.set(agent.id, agent)
        if (options.setup) await options.setup({})
        return { agent, dispose: async () => { agents.delete(agent.id) } }
      },
      get: (id: string) => agents.get(id) as never,
      list: () => [...agents.values()] as never[],
    },
    permission: { set: (s: never, name: string) => { append(s, 'permission/preset', { preset: name }); append(s, 'sandbox/mode', { mode: 'workspace-write' }); append(s, 'approval/policy', { policy: 'never' }) } },
    sandboxPolicy: { setSandboxMode: (s: never, m: string) => append(s, 'sandbox/mode', { mode: m }) },
    approval: { setApprovalPolicy: (s: never, p: string) => append(s, 'approval/policy', { policy: p }) },
  })
  const preflightRequests: unknown[] = []
  const materializeRequests: unknown[] = []
  const cleanupRequests: unknown[] = []
  const preflightContexts: unknown[] = []
  const materializeContexts: unknown[] = []
  const cleanupContexts: unknown[] = []
  const originalPreflight = adapter.preflight.bind(adapter)
  const originalMaterialize = adapter.materialize.bind(adapter)
  const originalCleanup = adapter.cleanup.bind(adapter)
  const originalDispatch = adapter.dispatch.bind(adapter)
  adapter.dispatch = async input => {
    dispatchCount++
    if (options?.foreignBeforeOwnedDispatch) {
      const agent = agents.get(input.sessionRef)
      agent?.session.events.push({ type: 'user/message', data: { id: `foreign-before-owned-${dispatchCount}` } })
    }
    return originalDispatch(input)
  }
  adapter.preflight = async (request, context) => {
    preflightRequests.push(request)
    preflightContexts.push(context)
    return originalPreflight(request, context)
  }
  adapter.materialize = async (request, context) => {
    materializeRequests.push(request)
    materializeContexts.push(context)
    return originalMaterialize(request, context)
  }
  adapter.cleanup = async (request, context, fence, expectation) => {
    cleanupRequests.push(request)
    cleanupContexts.push(context)
    if (options?.lateForeignUserMessage) {
      const session = (context as { agent: { session: { events: { type: string; data?: Record<string, unknown> }[] } } }).agent.session
      session.events.push({ type: 'user/message', data: { id: `late-foreign-${session.events.length}` } })
    }
    if (cleanupMode === 'false') return { ok: false, evidenceJson: JSON.stringify({ type: 'cleanup/false' }) }
    if (cleanupMode === 'throw') throw new Error('cleanup disposer failed')
    if (cleanupMode === 'missing-evidence') return { ok: true, evidenceJson: null }
    const result = await originalCleanup(request, context, fence, expectation)
    if (pendingCleanup) {
      cleanupHasEntered = true
      await pendingCleanupRelease
    }
    return result
  }
  return {
    adapter,
    getAgent: () => [...agents.values()][agents.size - 1],
    resumeCalls: () => resumeCount,
    createOptions: () => createdOptions,
    dropLive: (sessionRef: string) => { agents.delete(sessionRef) },
    preflightRequests: () => preflightRequests,
    materializeRequests: () => materializeRequests,
    cleanupRequests: () => cleanupRequests,
    dispatchCalls: () => dispatchCount,
    preflightContexts: () => preflightContexts,
    materializeContexts: () => materializeContexts,
    cleanupContexts: () => cleanupContexts,
    cleanupDisposerCalls: () => cleanupDisposerCalls,
    ingressHeld: () => maintenanceActive,
    cleanupEntered: () => cleanupHasEntered,
    resolvePendingCleanup: () => releasePendingCleanup(),
  }
}

const REQ = JSON.stringify({ 'tool:pwsh': true })
const GRANT = { 'tool:pwsh': true }
const confirmedCleanup = (): CleanupReceipt => ({
  status: 'CONFIRMED',
  evidenceJson: JSON.stringify({ type: 'DshEnforcementTeardownEvidence/v1', payload: { test: true } }),
  reason: 'test cleanup confirmed',
})

test('governed runner: happy path → session/gate/dispatch/terminal + claim 摘要', async () => {
  const env = makeEnv()
  const { store, kingdomId, worker, sup, terrA, taskId } = env
  store.setKingdomCapabilityCeiling(kingdomId, JSON.stringify({ 'tool:pwsh': true }))
  const { adapter } = makeAdapterWithAutoTerminal()
  const result = await runGovernedTask({
    store, adapter, kingdomId, workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a',
    taskId, attemptNo: 1, supervisorBindingId: sup, grant: GRANT, requirementJson: REQ, sandboxMode: 'workspace-write',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.created, true)
  // 治理链完整：execution GOVERNED + decision 绑定 + dispatch terminal + lease 非 RECOVERING
  const execution = store.getExecution(result.executionId)!
  assert.equal(execution.execution_contract, 'GOVERNED_PERSISTENT')
  assert.ok(execution.lease_id)
  const dispatch = store.getDispatch(result.dispatchId)!
  assert.equal(dispatch.state, 'TERMINAL')
  const lease = store.getLease(result.leaseId)!
  assert.equal(lease.state, 'SETTLING')
  assert.equal(result.summary, '任务完成：满足验收标准 AC。')
})

test('governed runner: trusted terminal 后 exactly-once cleanup 使用同一 request/context', async () => {
  const env = makeEnv()
  const { store, kingdomId, worker, sup, terrA, taskId } = env
  store.setKingdomCapabilityCeiling(kingdomId, JSON.stringify({ 'tool:pwsh': true }))
  const trace = makeAdapterWithAutoTerminal()
  const result = await runGovernedTask({
    store, adapter: trace.adapter, kingdomId, workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a',
    taskId, attemptNo: 1, supervisorBindingId: sup, grant: GRANT, requirementJson: REQ, sandboxMode: 'workspace-write',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.cleanupReceipt.status, 'CONFIRMED')
  assert.equal(trace.cleanupRequests().length, 1, 'trusted terminal 只能 cleanup 一次')
  assert.equal(trace.preflightRequests()[0], trace.materializeRequests()[0], 'preflight/materialize 必须消费同一 request')
  assert.equal(trace.materializeRequests()[0], trace.cleanupRequests()[0], 'cleanup 必须消费 Gate 返回的同一 request')
  assert.equal(trace.preflightContexts()[0], trace.materializeContexts()[0], 'preflight/materialize 必须消费同一 context')
  assert.equal(trace.materializeContexts()[0], trace.cleanupContexts()[0], 'cleanup 必须消费同一 context')
})

test('governed runner: cleanup false/throw/missing evidence 保留 trusted terminal，不伪造 cleanup 成功', async () => {
  for (const [cleanup, expected] of [
    ['false', 'RETURNED_FALSE'],
    ['throw', 'THREW'],
    ['missing-evidence', 'MISSING_EVIDENCE'],
  ] as const) {
    const env = makeEnv()
    const { store, kingdomId, worker, sup, terrA, taskId } = env
    store.setKingdomCapabilityCeiling(kingdomId, JSON.stringify({ 'tool:pwsh': true }))
    const trace = makeAdapterWithAutoTerminal({ cleanup })
    const result = await runGovernedTask({
      store, adapter: trace.adapter, kingdomId, workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a',
      taskId, attemptNo: 1, supervisorBindingId: sup, grant: GRANT, requirementJson: REQ, sandboxMode: 'workspace-write',
    })
    assert.equal(result.ok, true, `${cleanup} 不得抹掉 trusted terminal`)
    if (!result.ok) continue
    assert.equal(result.terminalOutcome, 'COMPLETED')
    assert.equal(result.cleanupReceipt.status, expected)
    assert.equal(trace.cleanupRequests().length, 1)
    assert.equal(store.getLease(result.leaseId)?.state, 'SETTLING', 'runner 只产生 receipt，settlement 再决定 recovery/release')
  }
})

test('governed runner: terminal 不可信时不提前 cleanup', async () => {
  const env = makeEnv()
  const { store, kingdomId, worker, sup, terrA, taskId } = env
  store.setKingdomCapabilityCeiling(kingdomId, JSON.stringify({ 'tool:pwsh': true }))
  const trace = makeAdapterWithAutoTerminal({ turnEndReason: 'interrupted', assistant: false })
  const result = await runGovernedTask({
    store, adapter: trace.adapter, kingdomId, workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a',
    taskId, attemptNo: 1, supervisorBindingId: sup, grant: GRANT, requirementJson: REQ, sandboxMode: 'workspace-write',
    pollIntervalMs: 1, maxPolls: 2,
  })
  assert.equal(result.ok, false)
  assert.equal(trace.cleanupRequests().length, 0, '未知/不可信 terminal 不得 teardown')
})

test('live path: foreign user message 即使伴随 completed terminal 也只能 RECOVERING，不 cleanup/release', async () => {
  const env = makeEnv()
  const { store, kingdomId, worker, sup, terrA, taskId } = env
  store.setKingdomCapabilityCeiling(kingdomId, JSON.stringify({ 'tool:pwsh': true }))
  const trace = makeAdapterWithAutoTerminal({ foreignUserMessage: true })
  const result = await runGovernedTask({
    store, adapter: trace.adapter, kingdomId, workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a',
    taskId, attemptNo: 1, supervisorBindingId: sup, grant: GRANT, requirementJson: REQ, sandboxMode: 'workspace-write',
    pollIntervalMs: 1, maxPolls: 3,
  })
  assert.equal(result.ok, false, 'foreign evidence 不得返回 terminal Claim')
  assert.equal(trace.dispatchCalls(), 1, '仅允许原始一次 dispatch')
  assert.equal(trace.cleanupRequests().length, 0, 'foreign evidence 不得 cleanup')
  assert.equal(store.listDispatches(kingdomId)[0]?.state, 'RECOVERING')
  assert.equal(store.listExecutions(taskId)[0]?.state, 'RECOVERING')
  assert.equal(store.listLeases(kingdomId)[0]?.state, 'RECOVERING')
  assert.equal(store.listDispatches(kingdomId)[0]?.terminal_evidence_json, null, '不得写 trusted terminal evidence')
  assert.ok(store.listDispatches(kingdomId)[0]?.receipt_json, '保留可证 receipt observation')
})

test('G14/G17 late foreign TOCTOU: terminal 观察后 cleanup 前污染仍三层 RECOVERING 且 disposer=0', async () => {
  const env = makeEnv()
  const { store, kingdomId, worker, sup, terrA, taskId } = env
  store.setKingdomCapabilityCeiling(kingdomId, JSON.stringify({ 'tool:pwsh': true }))
  const trace = makeAdapterWithAutoTerminal({ lateForeignUserMessage: true })
  const result = await runGovernedTask({
    store, adapter: trace.adapter, kingdomId, workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a',
    taskId, attemptNo: 1, supervisorBindingId: sup, grant: GRANT, requirementJson: REQ, sandboxMode: 'workspace-write',
    pollIntervalMs: 1, maxPolls: 3,
  })
  assert.equal(result.ok, false, 'late foreign activity 不得形成 terminal Claim')
  assert.equal(trace.cleanupRequests().length, 1, '仅记录一次 cleanup 入口尝试')
  assert.equal(trace.cleanupDisposerCalls(), 0, 'fence 污染后不得调用 Runtime disposer')
  assert.equal(store.listDispatches(kingdomId)[0]?.state, 'RECOVERING')
  assert.equal(store.listExecutions(taskId)[0]?.state, 'RECOVERING')
  assert.equal(store.listLeases(kingdomId)[0]?.state, 'RECOVERING')
  assert.equal(store.listDispatches(kingdomId)[0]?.terminal_evidence_json, null)
})

test('R6 G14/G17 maintenance reservation failure taints fence before cleanup error propagation', async () => {
  for (const maintenanceFailure of ['reject', 'throw', 'aborted'] as const) {
    const env = makeEnv()
    const { store, kingdomId, worker, sup, terrA, taskId } = env
    store.setKingdomCapabilityCeiling(kingdomId, JSON.stringify({ 'tool:pwsh': true }))
    const trace = makeAdapterWithAutoTerminal({ maintenanceFailure })
    const result = await runGovernedTask({
      store, adapter: trace.adapter, kingdomId, workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a', taskId,
      attemptNo: 1, supervisorBindingId: sup, grant: GRANT, requirementJson: REQ, sandboxMode: 'workspace-write',
      pollIntervalMs: 1, maxPolls: 3,
    })

    assert.equal(result.ok, false, `${maintenanceFailure}: failed reservation cannot yield a terminal Claim`)
    assert.equal(trace.cleanupRequests().length, 1, `${maintenanceFailure}: exactly one cleanup ingress attempt is recorded`)
    assert.equal(trace.cleanupDisposerCalls(), 0, `${maintenanceFailure}: disposer must not run`)
    assert.equal(store.listDispatches(kingdomId)[0]?.state, 'RECOVERING', `${maintenanceFailure}: Dispatch recovery`)
    assert.equal(store.listExecutions(taskId)[0]?.state, 'RECOVERING', `${maintenanceFailure}: Execution recovery`)
    assert.equal(store.listLeases(kingdomId)[0]?.state, 'RECOVERING', `${maintenanceFailure}: Lease recovery`)
    assert.equal(store.listDispatches(kingdomId)[0]?.terminal_evidence_json, null, `${maintenanceFailure}: no terminal evidence`)
    assert.equal(store.listLeases(kingdomId)[0]?.released_at, null, `${maintenanceFailure}: no release`)
  }
})

test('G14/G17 active Lease owned-ref 前 foreign activity 不可被 ref slicing 隐藏', async () => {
  const env = makeEnv()
  const { store, kingdomId, worker, sup, terrA, taskId } = env
  store.setKingdomCapabilityCeiling(kingdomId, JSON.stringify({ 'tool:pwsh': true }))
  const trace = makeAdapterWithAutoTerminal({ foreignBeforeOwnedDispatch: true })
  const result = await runGovernedTask({
    store, adapter: trace.adapter, kingdomId, workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a',
    taskId, attemptNo: 1, supervisorBindingId: sup, grant: GRANT, requirementJson: REQ, sandboxMode: 'workspace-write',
    pollIntervalMs: 1, maxPolls: 3,
  })
  assert.equal(result.ok, false)
  assert.equal(trace.cleanupRequests().length, 0, 'owned ref 之前已污染，不得进入 cleanup')
  assert.equal(store.listDispatches(kingdomId)[0]?.state, 'RECOVERING')
  assert.equal(store.listExecutions(taskId)[0]?.state, 'RECOVERING')
  assert.equal(store.listLeases(kingdomId)[0]?.state, 'RECOVERING')
})

test('G14 reservation: cleanup receipt 返回后至 release 前隔离 unmanaged followup，release 后才出队', async () => {
  const env = makeEnv()
  const { store, kingdomId, worker, sup, terrA, taskId } = env
  store.setKingdomCapabilityCeiling(kingdomId, JSON.stringify({ 'tool:pwsh': true }))
  const trace = makeAdapterWithAutoTerminal({ isolateIngress: true })
  const result = await runGovernedTask({
    store, adapter: trace.adapter, kingdomId, workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a',
    taskId, attemptNo: 1, supervisorBindingId: sup, grant: GRANT, requirementJson: REQ, sandboxMode: 'workspace-write',
    pollIntervalMs: 1, maxPolls: 3,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const agent = trace.getAgent() as unknown as { followup(message: { id: string }): void; session: { events: { data?: Record<string, unknown> }[] } }
  assert.equal(trace.ingressHeld(), true, 'cleanup receipt 后 fence reservation 必须仍持有')
  agent.followup({ id: 'unmanaged-during-settlement' })
  assert.equal(
    agent.session.events.some(event => event.data?.id === 'unmanaged-during-settlement'),
    false,
    'reservation 期间 unmanaged ingress 必须被 Runtime 隔离而非直接进入事件链',
  )
  const { settleAndRelease } = await import('../lib/dispatch/service.js')
  const released = settleAndRelease(store, result.leaseId, result.cleanupReceipt, 'reservation-release')
  assert.equal(released.state, 'RELEASED')
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(trace.ingressHeld(), false)
  assert.equal(
    agent.session.events.some(event => event.data?.id === 'unmanaged-during-settlement'),
    true,
    'release 后才允许排队的 unmanaged ingress 收敛',
  )
})

test('R5 G14 pending cleanup Promise: reservation 期间并发 unmanaged ingress 被排队隔离', async () => {
  const env = makeEnv()
  const { store, kingdomId, worker, sup, terrA, taskId } = env
  store.setKingdomCapabilityCeiling(kingdomId, JSON.stringify({ 'tool:pwsh': true }))
  const trace = makeAdapterWithAutoTerminal({ isolateIngress: true, cleanup: 'pending' })
  const runPromise = runGovernedTask({
    store, adapter: trace.adapter, kingdomId, workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a',
    taskId, attemptNo: 1, supervisorBindingId: sup, grant: GRANT, requirementJson: REQ, sandboxMode: 'workspace-write',
    pollIntervalMs: 1, maxPolls: 3,
  })

  for (let i = 0; i < 100 && !trace.cleanupEntered(); i++) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.equal(trace.cleanupEntered(), true, 'cleanup Promise 必须在 reservation 建立后进入 pending 窗口')
  assert.equal(trace.ingressHeld(), true, 'pending cleanup 期间 Runtime reservation 必须仍持有')
  const agent = trace.getAgent() as unknown as {
    followup(message: { id: string }): void
    session: { events: { data?: Record<string, unknown> }[] }
  }
  agent.followup({ id: 'unmanaged-during-pending-cleanup' })
  assert.equal(
    agent.session.events.some(event => event.data?.id === 'unmanaged-during-pending-cleanup'),
    false,
    'pending cleanup 窗口的 unmanaged ingress 必须被排队/隔离，不能污染当前 execution projection',
  )

  trace.resolvePendingCleanup()
  const result = await runPromise
  assert.equal(result.ok, true)
  if (!result.ok) return
  const { settleAndRelease } = await import('../lib/dispatch/service.js')
  assert.equal(settleAndRelease(store, result.leaseId, result.cleanupReceipt, 'pending-cleanup-release').state, 'RELEASED')
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(trace.ingressHeld(), false)
  assert.equal(
    agent.session.events.some(event => event.data?.id === 'unmanaged-during-pending-cleanup'),
    true,
    'release 后才允许排队的 unmanaged ingress 收敛',
  )
})

test('governed runner: 第二次 REWORK → 同一 session_ref（live 复用，不 resume）', async () => {
  const env = makeEnv()
  const { store, kingdomId, worker, sup, terrA, taskId } = env
  store.setKingdomCapabilityCeiling(kingdomId, JSON.stringify({ 'tool:pwsh': true }))
  const { adapter, getAgent, resumeCalls } = makeAdapterWithAutoTerminal()
  const first = await runGovernedTask({
    store, adapter, kingdomId, workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a',
    taskId, attemptNo: 1, supervisorBindingId: sup, grant: GRANT, requirementJson: REQ, sandboxMode: 'workspace-write',
    globalProvider: 'spawn',
  })
  assert.equal(first.ok, true)
  const sessionRef = first.ok ? first.sessionRef : ''
  // 释放 lease（settlement 完成）→ 下一 attempt 可取得新 lease（one-active-per-session）
  const lease = store.listLeases(kingdomId).find(l => l.session_ref === sessionRef && l.state === 'SETTLING')!
  const { settleAndRelease } = await import('../lib/dispatch/service.js')
  settleAndRelease(store, lease.lease_id, confirmedCleanup(), 'settled')
  const second = await runGovernedTask({
    store, adapter, kingdomId, workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a',
    taskId, attemptNo: 2, supervisorBindingId: sup, grant: GRANT, requirementJson: REQ, sandboxMode: 'workspace-write',
    globalProvider: 'spawn',
  })
  assert.equal(second.ok, true)
  assert.equal(second.ok ? second.created : null, false, 'REWORK 必须复用同一 session（不新建）')
  assert.equal(second.ok ? second.sessionRef : null, sessionRef, 'REWORK 必须 same session_ref')
  assert.equal(second.ok ? second.summary : null, '返工完成：已修正。')
  // Owner CLOSURE B：session 仍 live → 复用 live handle，**不调用 resume**
  assert.equal(resumeCalls(), 0, 'live session 存在时不得调用 resume（DSH 会抛 cannot prepare while it is live）')
  // turn-2 事件落在同一 live agent（同一对象）
  assert.equal(getAgent()!.session.events.some(e => e.type === 'turn/start' && e.data?.turn === 2), true, 'REWORK 的 turn-2 事件必须落在同一 session agent')
})

test('governed runner: DENIED → zero execution（无 Execution/Dispatch 落库）', async () => {
  const env = makeEnv()
  const { store, kingdomId, worker, sup, terrA, taskId } = env
  // ceiling 未配置 → B-7 DENIED
  const { adapter } = makeAdapterWithAutoTerminal()
  const result = await runGovernedTask({
    store, adapter, kingdomId, workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a',
    taskId, attemptNo: 1, supervisorBindingId: sup, grant: GRANT, requirementJson: REQ, sandboxMode: 'workspace-write',
  })
  assert.equal(result.ok, false)
  assert.ok(result.reason.includes('DENIED'))
  assert.equal(store.listExecutions(taskId).length, 0, 'zero execution')
  assert.equal(store.listDispatches(kingdomId).length, 0)
})

test('governed runner: 未 reconcile（active lease 未释放）→ G11 禁新 attempt', async () => {
  const env = makeEnv()
  const { store, kingdomId, worker, sup, terrA, taskId } = env
  store.setKingdomCapabilityCeiling(kingdomId, JSON.stringify({ 'tool:pwsh': true }))
  const { adapter } = makeAdapterWithAutoTerminal()
  const first = await runGovernedTask({
    store, adapter, kingdomId, workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a',
    taskId, attemptNo: 1, supervisorBindingId: sup, grant: GRANT, requirementJson: REQ, sandboxMode: 'workspace-write',
    globalProvider: 'spawn',
  })
  assert.equal(first.ok, true)
  // 未释放（模拟 crash 后 reconcile 未完成）→ 新 attempt 被 G11 拒绝
  const second = await runGovernedTask({
    store, adapter, kingdomId, workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a',
    taskId, attemptNo: 2, supervisorBindingId: sup, grant: GRANT, requirementJson: REQ, sandboxMode: 'workspace-write',
    globalProvider: 'spawn',
  })
  assert.equal(second.ok, false)
  assert.ok(second.reason.includes('active Lease'), `应提示 active Lease 阻塞：${second.reason}`)
})

// ── Owner V0.8 PRODUCTION-PATH CLOSURE A：Worker provider/model resolution ───────────

test('CLOSURE A: configured worker → 正确 provider/model 传至 Session 创建（显式配置不被全局覆盖）', async () => {
  const env = makeEnv(JSON.stringify({ provider: 'deepseek-vision', model: 'deepseek-v4-flash' }))
  const { store, kingdomId, worker, sup, terrA, taskId } = env
  store.setKingdomCapabilityCeiling(kingdomId, JSON.stringify({ 'tool:pwsh': true }))
  const { adapter, createOptions } = makeAdapterWithAutoTerminal()
  const result = await runGovernedTask({
    store, adapter, kingdomId, workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a',
    taskId, attemptNo: 1, supervisorBindingId: sup, grant: GRANT, requirementJson: REQ, sandboxMode: 'workspace-write',
    globalProvider: 'spawn', // 全局回退 ≠ Worker 显式配置 → Worker 配置优先
  })
  assert.equal(result.ok, true)
  assert.equal(createOptions().length, 1, '只 create 一次 session')
  const opts = createOptions()[0] as { agentOptions?: { provider?: string; model?: string } }
  assert.equal(opts.agentOptions?.provider, 'deepseek-vision', 'provider 必须来自 Worker 执行配置')
  assert.equal(opts.agentOptions?.model, 'deepseek-v4-flash', 'model 必须来自 Worker 执行配置（不覆盖显式配置）')
})

test('CLOSURE A: model missing → fail closed / zero execution（不创建 Session、不 dispatch）', async () => {
  // 有 provider、无 model（真实 E2E 暴露的 {{model}} 缺陷场景）
  const env = makeEnv(JSON.stringify({ provider: 'deepseek-vision' }))
  const { store, kingdomId, worker, sup, terrA, taskId } = env
  store.setKingdomCapabilityCeiling(kingdomId, JSON.stringify({ 'tool:pwsh': true }))
  const { adapter, createOptions } = makeAdapterWithAutoTerminal()
  const result = await runGovernedTask({
    store, adapter, kingdomId, workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a',
    taskId, attemptNo: 1, supervisorBindingId: sup, grant: GRANT, requirementJson: REQ, sandboxMode: 'workspace-write',
    globalProvider: 'spawn',
  })
  assert.equal(result.ok, false)
  assert.ok(result.reason.includes('configuration error'), `应为 configuration error：${result.reason}`)
  assert.ok(result.reason.includes('model'), `应指明 model 缺失：${result.reason}`)
  assert.equal(createOptions().length, 0, 'fail closed：不得创建 Session')
  assert.equal(store.listExecutions(taskId).length, 0, 'zero execution')
  assert.equal(store.listDispatches(kingdomId).length, 0, 'zero dispatch')
  assert.equal(store.listLeases(kingdomId).length, 0, 'zero lease（未 acquire）')
})

test('CLOSURE A: resolveGovernedWorkerRuntime — 显式 profile 优先于全局回退（纯函数）', () => {
  const env = makeEnv(JSON.stringify({ provider: 'p-custom', model: 'm-custom' }))
  const { store, taskId } = env
  const task = store.getTask(taskId)!
  // 全局回退不同 → profile 值必须胜出（不覆盖已有显式 worker runtime config）
  const r = resolveGovernedWorkerRuntime(store, task, { globalProvider: 'p-global' })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.runtime.provider, 'p-custom')
    assert.equal(r.runtime.model, 'm-custom')
    assert.equal(r.runtime.providerSource, 'binding')
    assert.equal(r.runtime.modelSource, 'binding')
  }
  // 无 profile → provider 全局回退，model 缺失 → fail closed
  const env2 = makeEnv(null)
  const { store: store2, taskId: taskId2 } = env2
  const r2 = resolveGovernedWorkerRuntime(store2, store2.getTask(taskId2)!, { globalProvider: 'p-global' })
  assert.equal(r2.ok, false)
  assert.ok(!r2.ok && r2.error.includes('model'))
})

// ── Owner V0.8 PRODUCTION-PATH CLOSURE B：Live Session reuse ───────────────────────

test('CLOSURE B: session 不 live、但可恢复 → resume persistent session_ref', async () => {
  const env = makeEnv()
  const { store, kingdomId, worker, sup, terrA, taskId } = env
  store.setKingdomCapabilityCeiling(kingdomId, JSON.stringify({ 'tool:pwsh': true }))
  const { adapter, resumeCalls, dropLive } = makeAdapterWithAutoTerminal()
  const first = await runGovernedTask({
    store, adapter, kingdomId, workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a',
    taskId, attemptNo: 1, supervisorBindingId: sup, grant: GRANT, requirementJson: REQ, sandboxMode: 'workspace-write',
    globalProvider: 'spawn',
  })
  assert.equal(first.ok, true)
  const sessionRef = first.ok ? first.sessionRef : ''
  const lease = store.listLeases(kingdomId).find(l => l.session_ref === sessionRef && l.state === 'SETTLING')!
  const { settleAndRelease } = await import('../lib/dispatch/service.js')
  settleAndRelease(store, lease.lease_id, confirmedCleanup(), 'settled')
  // 模拟实例重启后 session 不在 live registry（但 affinity/persistent 仍可恢复）
  dropLive(sessionRef)
  const second = await runGovernedTask({
    store, adapter, kingdomId, workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a',
    taskId, attemptNo: 2, supervisorBindingId: sup, grant: GRANT, requirementJson: REQ, sandboxMode: 'workspace-write',
    globalProvider: 'spawn',
  })
  assert.equal(second.ok, true)
  assert.equal(second.ok ? second.created : null, false, '不新建 session')
  assert.equal(second.ok ? second.sessionRef : null, sessionRef, 'resume 同一 persistent session_ref')
  assert.equal(resumeCalls(), 1, 'session 不 live → 走 resumeSession')
})

test('CLOSURE B: gone / cannot recover → fail closed（不新建第二个 session、不退 one-shot）', async () => {
  const env = makeEnv()
  const { store, kingdomId, worker, sup, terrA, taskId } = env
  store.setKingdomCapabilityCeiling(kingdomId, JSON.stringify({ 'tool:pwsh': true }))
  // resume 抛错（persistent 不可恢复）的 adapter
  const append = (s: { events: { type: string; data?: Record<string, unknown> }[] }, type: string, data?: Record<string, unknown>) => s.events.push({ type, ...(data ? { data } : {}) })
  const agentsMap = new Map<string, { id: string; status: 'idle'; session: { header: { cwd: string }; events: { type: string; data?: Record<string, unknown> }[] }; ctx: { tools: unknown }; followup(msg: { id: string }): void; runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> }>()
  const adapter = new DshRuntimeAdapter({
    runtimeInstanceRef: 'inst-1', provider: 'spawn', model: null,
    agents: {
      agents: agentsMap,
      create: async (options: { sessionId: string; meta?: { cwd?: string }; setup?: (ctx: unknown) => unknown }) => {
        const agent = {
          id: options.sessionId,
          status: 'idle' as const,
          session: { header: { cwd: options.meta?.cwd ?? 'C:/terr-a' }, events: [] as { type: string; data?: Record<string, unknown> }[] },
          ctx: { tools: { restrict: () => () => {}, guard: () => () => {}, schemas: () => [{ name: 'pwsh' }] } },
          followup(msg: { id: string }): void {
            this.session.events.push({ type: 'user/message', data: { id: msg.id } })
            this.session.events.push({ type: 'turn/start', data: { turn: 1 } })
            this.session.events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
            this.session.events.push({ type: 'assistant/message', data: { text: '任务完成。' } })
          },
          runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
            return job(new AbortController().signal)
          },
        }
        agentsMap.set(agent.id, agent)
        if (options.setup) await options.setup({})
        return { agent, dispose: async () => { agentsMap.delete(agent.id) } }
      },
      resume: async () => { throw new Error('session permanently gone / cannot recover') },
      get: (id: string) => agentsMap.get(id) as never,
      list: () => [...agentsMap.values()] as never[],
    },
    permission: { set: (s: never, name: string) => { append(s, 'permission/preset', { preset: name }); append(s, 'sandbox/mode', { mode: 'workspace-write' }); append(s, 'approval/policy', { policy: 'never' }) } },
    sandboxPolicy: { setSandboxMode: (s: never, m: string) => append(s, 'sandbox/mode', { mode: m }) },
    approval: { setApprovalPolicy: (s: never, p: string) => append(s, 'approval/policy', { policy: p }) },
  })
  const first = await runGovernedTask({
    store, adapter, kingdomId, workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a',
    taskId, attemptNo: 1, supervisorBindingId: sup, grant: GRANT, requirementJson: REQ, sandboxMode: 'workspace-write',
    globalProvider: 'spawn',
  })
  assert.equal(first.ok, true)
  const sessionRef = first.ok ? first.sessionRef : ''
  // 释放 lease；并让 session 从 live registry 消失（resume 将失败）
  const lease = store.listLeases(kingdomId).find(l => l.session_ref === sessionRef && l.state === 'SETTLING')!
  const { settleAndRelease } = await import('../lib/dispatch/service.js')
  settleAndRelease(store, lease.lease_id, confirmedCleanup(), 'settled')
  agentsMap.delete(sessionRef)
  const second = await runGovernedTask({
    store, adapter, kingdomId, workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a',
    taskId, attemptNo: 2, supervisorBindingId: sup, grant: GRANT, requirementJson: REQ, sandboxMode: 'workspace-write',
    globalProvider: 'spawn',
  })
  assert.equal(second.ok, false)
  assert.ok(second.reason.includes('Worker Session 建立失败'), `fail closed：${second.reason}`)
  assert.ok(second.reason.includes('cannot recover'), `保留原始错误：${second.reason}`)
  // 不新建第二个 session、零执行（禁止因 resume 失败静默新建/退化 one-shot）
  assert.equal(agentsMap.size, 0, '不得因 resume 失败新建第二个 session')
  assert.equal(store.listExecutions(taskId).length, 1, '仅 attempt1 有 execution（attempt2 zero execution）')
})

test('GI-CAP-002: cleanup false 后 RECOVERING guard 在 Session resume/create 前拒绝第二次运行', async () => {
  const env = makeEnv()
  const { store, kingdomId, worker, sup, terrA, taskId } = env
  store.setKingdomCapabilityCeiling(kingdomId, JSON.stringify({ 'tool:pwsh': true }))
  const trace = makeAdapterWithAutoTerminal({ cleanup: 'false' })
  const first = await runGovernedTask({
    store, adapter: trace.adapter, kingdomId, workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a',
    taskId, attemptNo: 1, supervisorBindingId: sup, grant: GRANT, requirementJson: REQ, sandboxMode: 'workspace-write',
    globalProvider: 'spawn',
  })
  assert.equal(first.ok, true)
  if (!first.ok) return
  assert.equal(first.cleanupReceipt.status, 'RETURNED_FALSE')
  const settlingLease = store.getLease(first.leaseId)!
  const { settleAndRelease } = await import('../lib/dispatch/service.js')
  const recoveringLease = settleAndRelease(store, settlingLease.lease_id, first.cleanupReceipt, 'cleanup-failed')
  assert.equal(recoveringLease.state, 'RECOVERING')

  // Simulate a process restart: current affinity remains, live registry does not.
  trace.dropLive(first.sessionRef)
  const second = await runGovernedTask({
    store, adapter: trace.adapter, kingdomId, workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a',
    taskId, attemptNo: 2, supervisorBindingId: sup, grant: GRANT, requirementJson: REQ, sandboxMode: 'workspace-write',
    globalProvider: 'spawn',
  })
  assert.equal(second.ok, false)
  assert.match(second.reason, /active Lease/u)
  assert.equal(trace.resumeCalls(), 0, 'RECOVERING guard 前移后不得 resume')
  assert.equal(trace.createOptions().length, 1, 'RECOVERING guard 前移后不得 create 第二个 Session')
  assert.equal(trace.dispatchCalls(), 1, 'RECOVERING guard 前移后不得二次 dispatch')
  assert.equal(store.listExecutions(taskId).length, 1, '第二次应在 Execution/Dispatch 前拒绝')
  assert.equal(store.listDispatches(kingdomId).length, 1, '第二次应在 Dispatch 前拒绝')
})

// ── Owner V0.8 FINAL RELEASE BLOCKER：Claim outcome 按 terminalOutcome 收敛 ─────────

/** 按指定 turn 行为跑一次 runGovernedTask（Release Blocker A–E）。 */
async function runGovWithTurn(reasonKind: string, assistant: boolean): Promise<{
  ok: boolean
  terminalOutcome?: string
  executionState?: string
  summary?: string
  reason?: string
  workerResultOutcome?: string | null
  dispatchState?: string
  leaseState?: string
}> {
  const env = makeEnv()
  const { store, kingdomId, worker, sup, terrA, taskId } = env
  store.setKingdomCapabilityCeiling(kingdomId, JSON.stringify({ 'tool:pwsh': true }))
  const { adapter } = makeAdapterWithAutoTerminal({ turnEndReason: reasonKind, assistant })
  const taskBefore = { ...store.getTask(taskId)! }
  const result = await runGovernedTask({
    store, adapter, kingdomId, workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a',
    taskId, attemptNo: 1, supervisorBindingId: sup, grant: GRANT, requirementJson: REQ, sandboxMode: 'workspace-write',
    globalProvider: 'spawn',
  })
  assert.deepEqual({ ...store.getTask(taskId)! }, taskBefore, 'Runtime result must not decide Task governance')
  const dispatchState = store.listDispatches(kingdomId).at(-1)?.state
  const leaseState = store.listLeases(kingdomId).at(-1)?.state
  if (result.ok) {
    return {
      ok: true,
      terminalOutcome: result.terminalOutcome,
      executionState: store.getExecution(result.executionId)?.state,
      summary: result.summary,
      workerResultOutcome: store.latestWorkerResult(taskId)?.outcome ?? null,
      dispatchState,
      leaseState,
    }
  }
  return {
    ok: false,
    reason: result.reason,
    workerResultOutcome: store.latestWorkerResult(taskId)?.outcome ?? null,
    dispatchState,
    leaseState,
    executionState: store.listExecutions(taskId).at(-1)?.state,
  }
}

test('RELEASE BLOCKER A: completed + assistant → terminalOutcome COMPLETED（Claim 收敛 COMPLETED 依据）', async () => {
  const r = await runGovWithTurn('completed', true)
  assert.equal(r.ok, true)
  assert.equal(r.terminalOutcome, 'COMPLETED')
  assert.equal(r.executionState, 'COMPLETED')
  assert.ok(r.summary!.includes('任务完成'), 'completed 有 assistant 文本 → 真实摘要')
})

test('RELEASE BLOCKER B: error / blocked / max-tokens → terminalOutcome FAILED（禁止 COMPLETED Claim）', async () => {
  for (const kind of ['error', 'blocked', 'max-tokens']) {
    const r = await runGovWithTurn(kind, true)
    assert.equal(r.ok, true, `${kind} turn 到达 terminal（FAILED 归终态）`)
    assert.equal(r.terminalOutcome, 'FAILED', `${kind} → FAILED`)
    assert.equal(r.executionState, 'FAILED', `${kind} → execution FAILED`)
    assert.notEqual(r.terminalOutcome, 'COMPLETED', `${kind} 不得收敛为 COMPLETED`)
  }
})

test('RELEASE BLOCKER C: aborted → terminalOutcome ABORTED（Claim 收敛 ABORTED）', async () => {
  const r = await runGovWithTurn('aborted', false)
  assert.equal(r.ok, true)
  assert.equal(r.terminalOutcome, 'ABORTED')
  assert.equal(r.executionState, 'ABORTED')
})

test('RELEASE BLOCKER D: interrupted / ambiguous → 不产生成功 Claim（RECOVERING，fail-closed）', async () => {
  for (const kind of ['interrupted', 'completed']) { // completed 无 assistant = 证据不足
    const r = await runGovWithTurn(kind, false)
    assert.equal(r.ok, false, `${kind} 无 assistant → 非终态 → runGovernedTask ok:false（不创建伪终态 Claim）`)
    assert.equal(r.workerResultOutcome, null, `${kind} → 不得生成任何 Claim`)
    assert.equal(r.executionState, 'RECOVERING')
    assert.equal(r.leaseState, 'RECOVERING')
    assert.equal(r.dispatchState, 'RECOVERING')
    assert.match(r.reason ?? '', /dispatch=RECOVERING/u)
  }
})

test('RELEASE BLOCKER E: FAILED 且无 assistant/message → 不生成“任务完成”类 summary', async () => {
  const r = await runGovWithTurn('error', false)
  assert.equal(r.ok, true)
  assert.equal(r.terminalOutcome, 'FAILED')
  assert.ok(!r.summary!.includes('任务完成'), `FAILED 无 assistant 不得伪造成功摘要：${r.summary}`)
  assert.ok(!r.summary!.includes('满足验收'), `FAILED 无 assistant 不得声称满足验收：${r.summary}`)
  assert.ok(r.summary!.includes('无最终消息文本'), `应以诚实回退占位为摘要：${r.summary}`)
})
