/**
 * dsh-kingdom — M3-S3 Adapter + DSH Persistent Backend 验收测试。
 *
 * 依 M3-S3 Thin Spec §4（E2E 验收 6 项，本层以 fake AgentsLike 做确定性验证；
 * 真 DSH session 的 E2E 在运行实例注入阶段执行——与 dsh-subagent 同款「单测 fake + 实机验证」模式）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KingdomStore } from '../lib/core/db.js'
import { DshRuntimeAdapter, reconstructExecutionObservation } from '../lib/adapter/dsh-backend.js'
import { ensureWorkerSession, bindWorkerSession, retireWorkerSession } from '../lib/adapter/session-store.js'
import type { RuntimeAdapter } from '../lib/adapter/contract.js'

// ── fake DSH（结构面）────────────────────────────────────────────────────────

interface UserMessageLike { id: string; role: 'user'; content: { type: 'text'; text: string }[]; source: { kind: 'user' } }

class FakeAgent {
  id: string
  status: 'idle' | 'running' = 'idle'
  session: { header: { cwd?: string }; events: { type: string; data?: Record<string, unknown> }[] }
  followupCalls: UserMessageLike[] = []
  cancelled: unknown[] = []
  constructor(id: string, cwd?: string) {
    this.id = id
    this.session = { header: cwd ? { cwd } : {}, events: [] }
  }
  followup(m: UserMessageLike): void { this.followupCalls.push(m) }
  async whenIdle(): Promise<void> { /* fake */ }
  cancel(cause: unknown): void { this.cancelled.push(cause) }
  async runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> { return job(new AbortController().signal) }
  pushEvent(type: string, data?: Record<string, unknown>): void { this.session.events.push({ type, ...(data ? { data } : {}) }) }
}

class FakeAgents {
  agents = new Map<string, FakeAgent>()
  created: Record<string, unknown>[] = []
  resumed: Record<string, unknown>[] = []
  disposed: string[] = []
  async create(options: { sessionId: string; meta?: { cwd?: string }; setup?: (ctx: unknown) => unknown }): Promise<{ agent: FakeAgent; dispose(): Promise<void> }> {
    const agent = new FakeAgent(options.sessionId, options.meta?.cwd)
    if (options.setup) await options.setup({})
    this.agents.set(agent.id, agent)
    this.created.push(options)
    return { agent, dispose: async () => { this.agents.delete(agent.id); this.disposed.push(agent.id) } }
  }
  async resume(options: { resumeSessionId: string; setup?: (ctx: unknown) => unknown }): Promise<{ agent: FakeAgent; dispose(): Promise<void> }> {
    const agent = new FakeAgent(options.resumeSessionId)
    if (options.setup) await options.setup({})
    this.agents.set(agent.id, agent)
    this.resumed.push(options)
    return { agent, dispose: async () => { this.agents.delete(agent.id); this.disposed.push(agent.id) } }
  }
  get(id: string): FakeAgent | undefined { return this.agents.get(id) }
  list(): FakeAgent[] { return [...this.agents.values()] }
}

function makeAdapter(agents: FakeAgents, presets?: { mounted: string[] }): DshRuntimeAdapter {
  return new DshRuntimeAdapter({
    runtimeInstanceRef: 'inst-1',
    provider: 'spawn',
    model: 'deepseek-v4-pro',
    agents,
    presets: presets ? { mount: async (_ctx: unknown, id?: string) => { presets.mounted.push(id ?? '(default)') } } : undefined,
  })
}

// ── 1. create / resume / retire ─────────────────────────────────────────────

test('S3: createSession → AgentRegistry.create（meta.cwd + setup 装配 preset）+ dispose', async () => {
  const agents = new FakeAgents()
  const presets = { mounted: [] as string[] }
  const adapter = makeAdapter(agents, presets)
  const handle = await adapter.createSession({ cwd: 'C:/terr-a', agentPreset: 'worker-safe' })
  assert.equal(agents.created.length, 1)
  const call = agents.created[0] as { sessionId: string; meta: { cwd: string; agentPreset: string }; agentOptions: { provider: string; model: string } }
  assert.equal(call.meta.cwd, 'C:/terr-a')
  assert.equal(call.meta.agentPreset, 'worker-safe')
  assert.equal(call.agentOptions.provider, 'spawn')
  assert.equal(call.agentOptions.model, 'deepseek-v4-pro')
  assert.equal(handle.refs.runtimeType, 'dsh')
  assert.equal(handle.refs.sessionRef, call.sessionId)
  assert.deepEqual(presets.mounted, ['worker-safe'], 'setup 必须 mount preset')
  assert.equal(agents.get(call.sessionId)?.session.header.cwd, 'C:/terr-a')
  await handle.dispose()
  assert.deepEqual(agents.disposed, [call.sessionId])
})

test('S3: resumeSession → AgentRegistry.resume（同一 session_ref 恢复同一会话）', async () => {
  const agents = new FakeAgents()
  const adapter = makeAdapter(agents)
  const handle = await adapter.resumeSession({ sessionRef: 'sess-123' })
  assert.equal(agents.resumed.length, 1)
  assert.equal((agents.resumed[0] as { resumeSessionId: string }).resumeSessionId, 'sess-123')
  assert.equal(handle.refs.sessionRef, 'sess-123')
})

// ── 2. dispatch / receipt ───────────────────────────────────────────────────

test('S3: dispatch → followup(完整 UserMessage) → DispatchReceipt（runtimeDispatchRef=messageId）', async () => {
  const agents = new FakeAgents()
  const adapter = makeAdapter(agents)
  const handle = await adapter.createSession({ cwd: 'C:/terr-a' })
  const receipt = await adapter.dispatch({ sessionRef: handle.refs.sessionRef, text: '执行任务 X' })
  const agent = agents.get(handle.refs.sessionRef)!
  assert.equal(agent.followupCalls.length, 1)
  const msg = agent.followupCalls[0]
  assert.equal(msg.role, 'user')
  assert.deepEqual(msg.content, [{ type: 'text', text: '执行任务 X' }])
  assert.equal(msg.source.kind, 'user')
  assert.ok(msg.id.length > 0, 'UserMessage 必须带 id')
  assert.equal(receipt.refs.runtimeDispatchRef, msg.id, 'Receipt 引用 = UserMessage.id')
  assert.ok(receipt.acceptedAt)
  // 不存在的 session → 拒绝（不盲发）
  await assert.rejects(() => adapter.dispatch({ sessionRef: 'NO_SUCH', text: 'x' }), /不在 live registry/)
})

// ── 3. observeExecution 事件链重建 ──────────────────────────────────────────

test('S3: observeExecution — QUEUED/RUNNING/TERMINAL/UNKNOWN 事件链重建', async () => {
  const agents = new FakeAgents()
  const adapter = makeAdapter(agents)
  const handle = await adapter.createSession({ cwd: 'C:/terr-a' })
  const agent = agents.get(handle.refs.sessionRef)!
  const ref = { sessionRef: handle.refs.sessionRef, runtimeDispatchRef: 'msg-1' }

  // QUEUED：消息已入日志、无 turn/start
  agent.pushEvent('user/message', { id: 'msg-1' })
  assert.equal(await adapter.observeExecution(ref, agent.session), 'QUEUED')

  // RUNNING：有 turn/start 无 turn/end
  agent.pushEvent('turn/start', { turn: 1 })
  assert.equal(await adapter.observeExecution(ref, agent.session), 'RUNNING')

  // TERMINAL：turn/end(completed) 完成 + assistant/message
  agent.pushEvent('turn/end', { turn: 1, reason: { kind: 'completed' } })
  agent.pushEvent('assistant/message', {})
  assert.equal(await adapter.observeExecution(ref, agent.session), 'TERMINAL')

  // ★ fail-closed（STABILITY-FINDINGS §4.2）：interrupted → UNKNOWN（非 TERMINAL）
  agent.pushEvent('turn/start', { turn: 2 })
  agent.pushEvent('turn/end', { turn: 2, reason: { kind: 'interrupted' } })
  assert.equal(await adapter.observeExecution(ref, agent.session), 'UNKNOWN', 'interrupted 不得判 TERMINAL')

  // UNKNOWN：引用不在日志 / 事件不可判
  assert.equal(reconstructExecutionObservation(agent.session, 'msg-UNKNOWN'), 'UNKNOWN')
  assert.equal(await adapter.observeExecution({ sessionRef: 'x', runtimeDispatchRef: 'y' }, undefined), 'UNKNOWN')
})

// ── 4. reconcile 两维 ───────────────────────────────────────────────────────

test('S3: reconcile — session 维 AVAILABLE/UNKNOWN + execution 维独立', async () => {
  const agents = new FakeAgents()
  const adapter = makeAdapter(agents)
  const handle = await adapter.createSession({ cwd: 'C:/terr-a' })
  const agent = agents.get(handle.refs.sessionRef)!
  agent.pushEvent('user/message', { id: 'msg-1' })
  agent.pushEvent('turn/start', { turn: 1 })

  const r1 = await adapter.reconcile('kd-1', { sessionRef: handle.refs.sessionRef, runtimeDispatchRef: 'msg-1' })
  assert.equal(r1.sessionObservation, 'AVAILABLE')
  assert.equal(r1.executionObservation, 'RUNNING')

  // session 不在 live + 无 persistence → UNKNOWN（fail-closed，不盲判 GONE）
  const r2 = await adapter.reconcile('kd-2', { sessionRef: 'GONE-SESSION', runtimeDispatchRef: 'm' })
  assert.equal(r2.sessionObservation, 'UNKNOWN')
  assert.equal(r2.executionObservation, 'UNKNOWN')

  // 有 persistence.has → AVAILABLE
  const adapter2 = new DshRuntimeAdapter({
    runtimeInstanceRef: 'inst-1', provider: 'spawn', model: null,
    agents: new FakeAgents(),
    sessionPersistence: { has: (id: string) => id === 'persisted-1' },
  })
  const r3 = await adapter2.reconcile('kd-3', { sessionRef: 'persisted-1', runtimeDispatchRef: 'm' })
  assert.equal(r3.sessionObservation, 'AVAILABLE')
})

// ── 5. session-store：受治理绑定 ────────────────────────────────────────────

function makeEnv(): { store: KingdomStore; worker: string; terrA: string } {
  const store = new KingdomStore(':memory:')
  store.insertKingdom({ kingdom_id: 'k', name: 'K', created_at: new Date().toISOString(), owner_id: 'o1', owner_name: 'T' })
  const worker = `w-${Math.random().toString(36).slice(2, 8)}`
  store.insertBinding({
    binding_id: worker, kingdom_id: 'k', role_type: 'WORKER', role_name: 'W', runtime_type: 'dsh',
    session_id: null, model_name: null, agent_name: null, session_meta: null, execution_profile_json: null,
    status: 'ACTIVE', retired_at: null, retired_reason: null, principal_id: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  })
  const terrA = `terr-${Math.random().toString(36).slice(2, 8)}`
  store.insertTerritory({
    territory_id: terrA, kingdom_id: 'k', name: 'A', workspace_path: 'C:/terr-a', summary: null,
    supervisor_binding_id: null, status: 'ACTIVE', deleted_at: null, deleted_reason: null,
    created_at: new Date().toISOString(),
  })
  return { store, worker, terrA }
}

test('S3: ensureWorkerSession — 无 current → create+bind；有 current 且 live → 复用 live handle（不 resume）；不 live → resume 同一 session', async () => {
  const { store, worker, terrA } = makeEnv()
  const agents = new FakeAgents()
  const adapter = makeAdapter(agents)

  const first = await ensureWorkerSession(store, adapter, {
    kingdomId: 'k', workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a', agentPreset: 'worker-safe',
  })
  assert.equal(first.created, true)
  assert.equal(agents.created.length, 1)
  // affinity 落账 + current projection 更新
  assert.equal(store.getCurrentAffinityForWorker('k', worker)?.session_ref, first.handle.refs.sessionRef)
  assert.equal(store.getBindingById(worker)?.session_id, first.handle.refs.sessionRef)
  assert.equal(first.affinity.territoryId, terrA)

  // 已有 current 且 session 仍 live（REWORK 同进程续用）→ 复用 live handle，**不调用 resume**
  const second = await ensureWorkerSession(store, adapter, {
    kingdomId: 'k', workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a',
  })
  assert.equal(second.created, false)
  assert.equal(agents.resumed.length, 0, 'live session 存在时不得调用 resume（Owner CLOSURE B）')
  assert.equal(second.handle.refs.sessionRef, first.handle.refs.sessionRef, 'same session_ref / same Worker / same Territory affinity')
  assert.equal(agents.created.length, 1, '不得每次 Task 自动新建 session')
  // 一 Worker 一 current（affinity 无第二行）
  assert.equal(store.listAffinities('k').length, 1)

  // session 不再 live（如实例重启后）→ resume 同一 persistent session_ref
  agents.agents.delete(first.handle.refs.sessionRef)
  const third = await ensureWorkerSession(store, adapter, {
    kingdomId: 'k', workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a',
  })
  assert.equal(third.created, false)
  assert.equal(agents.resumed.length, 1, 'session 不 live、但可恢复 → 走 resumeSession')
  assert.equal((agents.resumed[0] as { resumeSessionId: string }).resumeSessionId, first.handle.refs.sessionRef)
  assert.equal(third.handle.refs.sessionRef, first.handle.refs.sessionRef)
})

test('S3: retireWorkerSession — retire 旧 affinity + 清 projection；可再建新 session（跨 Territory 路径）', async () => {
  const { store, worker, terrA } = makeEnv()
  const agents = new FakeAgents()
  const adapter = makeAdapter(agents)

  await ensureWorkerSession(store, adapter, { kingdomId: 'k', workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a' })
  const oldRef = store.getBindingById(worker)?.session_id

  retireWorkerSession(store, { kingdomId: 'k', workerBindingId: worker })
  const retired = store.getCurrentAffinityForWorker('k', worker)
  assert.equal(retired, null, 'retire 后无 current affinity')
  assert.equal(store.getBindingById(worker)?.session_id, null, 'current projection 清空')
  // 历史仍可查（affinity Ledger 保留）
  assert.equal(store.listAffinities('k').length, 1)

  // 再建 = 新 Session（跨 Territory 语义：新建而非改绑）
  const next = await ensureWorkerSession(store, adapter, { kingdomId: 'k', workerBindingId: worker, territoryId: terrA, cwd: 'C:/terr-a' })
  assert.equal(next.created, true)
  assert.notEqual(next.handle.refs.sessionRef, oldRef)
  assert.equal(store.listAffinities('k').length, 2, '历史 affinity 保留，新 affinity 追加')
})

test('S3: bindWorkerSession 越权防护 — 非 WORKER binding 拒绝；重复绑定撞 one-current-per-worker', () => {
  const { store, terrA } = makeEnv()
  const sup = 'sup-1'
  store.insertBinding({
    binding_id: sup, kingdom_id: 'k', role_type: 'SUPERVISOR', role_name: 'S', runtime_type: 'dsh',
    session_id: null, model_name: null, agent_name: null, session_meta: null, execution_profile_json: null,
    status: 'ACTIVE', retired_at: null, retired_reason: null, principal_id: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  })
  assert.throws(() => bindWorkerSession(store, {
    kingdomId: 'k', workerBindingId: sup,
    session: { runtimeType: 'dsh', runtimeInstanceRef: 'i', sessionRef: 's-1' },
    territoryId: terrA,
  }), /非 ACTIVE WORKER/)
})
