/**
 * dsh-kingdom — M3-S4 Capability Resolver + DSH Enforcement 验收测试。
 *
 * 覆盖（M3-S4 Thin Spec §4，G4/G6/G8/G9 种子）：
 * 无自授 / 超 Ceiling / scope 外 / partial policy / guard bypass / escalation / evidence 诚实性 /
 * GRANTED+ENFORCED 只在实际装 policy 后产生。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KingdomStore } from '../lib/core/db.js'
import { establishAffinity, acquireExecutionLease } from '../lib/core/governed.js'
import { resolveEffectiveCapability, isEnforceable, effectiveTools, type GrantMap } from '../lib/capability/resolver.js'
import {
  materializeDshEnforcement,
  cleanupDshEnforcement,
  readEnforceableSet,
  normalizeToolInventory,
  ENFORCEMENT_EVIDENCE_TYPE,
  type DshEnforcementContext,
} from '../lib/capability/dsh-enforcement.js'
import { runCapabilityGate } from '../lib/capability/service.js'
import { DshRuntimeAdapter } from '../lib/adapter/dsh-backend.js'

const NOW = () => new Date().toISOString()

// ── 1. resolver 纯函数 ───────────────────────────────────────────────────────

const ENF = { tools: ['pwsh', 'read'], sandboxMode: 'workspace-write' as const, approvalPolicy: 'never' as const, presetId: null }

// ── S4 seam 修复（Owner 裁决 A+B 组合）──────────────────────────────────────

test('S4 seam: real-shape normalization（真实 tools.schemas() shape）', () => {
  // 真实 DSH schemas() 实证 shape：数组 [{name, description, parameters}]
  const real = [{ name: 'pwsh', description: 'x', parameters: {} }, { name: 'read' }, { name: 'pwsh' }]
  assert.deepEqual(normalizeToolInventory(real), ['pwsh', 'read'], '取 name 字段 + 去重')
  // 字符串数组
  assert.deepEqual(normalizeToolInventory(['a', 'b']), ['a', 'b'])
  // 声明容器（preset 面）：{tools:[...]} / {toolSurface:{...}}
  assert.deepEqual(normalizeToolInventory({ tools: ['a', 'b'] }), ['a', 'b'])
  assert.deepEqual(normalizeToolInventory({ toolSurface: { a: {}, b: {} } }), ['a', 'b'])
  // 坏 shape → 空（fail-closed，不默认放行）
  assert.deepEqual(normalizeToolInventory(undefined), [])
  assert.deepEqual(normalizeToolInventory(null), [])
  assert.deepEqual(normalizeToolInventory(42), [])
  assert.deepEqual(normalizeToolInventory([{ nope: 1 }]), [])
  assert.deepEqual(normalizeToolInventory({}), [])
  // preset 元信息（resolveMountable 真实返回：{id,name,description,…}，无工具字段）→ 空（不得把 name 当工具名）
  assert.deepEqual(normalizeToolInventory({ id: 'standard', trust: 'system', path: 'x', name: '标准模式', description: 'd', order: 1 }), [])
  // 带容器字段的 preset 声明仍生效
  assert.deepEqual(normalizeToolInventory({ id: 'p', name: 'P', tools: ['a', 'b'] }), ['a', 'b'])
})

test('S4 seam: Runtime inventory ∩ preset surface（A∩B）', async () => {
  const agent = makeAgent(new FakeTools())
  const ctx = { ...ctxOf(agent, 's-1'), agentPresetId: 'standard' }
  // B = preset 声明面（resolveMountable(standard) 返回 {tools:[pwsh, read]}）→ 交集过滤
  const set = await readEnforceableSet(ctx, {
    presets: { resolveMountable: () => ({ tools: ['pwsh', 'read'] }) },
  })
  assert.deepEqual(set.tools, ['pwsh', 'read'], 'A∩B 交集')
})

test('S4 seam: preset/runtime drift（preset 声明与 runtime 不一致 → 交集收窄）', async () => {
  const agent = makeAgent(new FakeTools()) // runtime inventory = [pwsh, read, edit, web_search]
  const ctx = { ...ctxOf(agent, 's-1'), agentPresetId: 'worker-safe' }
  // preset 声明面 = [pwsh, edit]（不含 read/web_search）
  const set = await readEnforceableSet(ctx, {
    presets: { resolveMountable: () => ({ tools: ['pwsh', 'edit'] }) },
  })
  assert.equal(set.presetId, null, 'presetId 为 permission preset 信息；本 ctx 无 permission/preset 事件 → null')
  // A∩B：pwsh∈两者、edit∈两者、read 只在 runtime、web_search 只在 runtime → 排除
  assert.deepEqual(set.tools, ['pwsh', 'edit'], 'drift 时交集收窄，runtime-only 工具不得进入 enforceable')
})

test('S4 seam: preset 面无法解析 → 回退 session 装配面（live schemas）', async () => {
  const agent = makeAgent(new FakeTools())
  const ctx = { ...ctxOf(agent, 's-1'), agentPresetId: 'worker-safe' }
  // resolveMountable 返回空（真实实例行为）→ 回退 inventory
  const set = await readEnforceableSet(ctx, { presets: { resolveMountable: () => ({}) } })
  assert.deepEqual(set.tools, ['pwsh', 'read', 'edit', 'web_search'])
})

test('S4 resolver: 交集语义 effective = grant ∩ ceiling ∩ enforceable', () => {
  const r = resolveEffectiveCapability({
    requirement: { 'tool:pwsh': true, 'filesystem.write': true, 'tool:web_search': true },
    grant: { 'tool:pwsh': true, 'filesystem.write': true, 'tool:web_search': true },
    ceiling: { 'tool:pwsh': true, 'filesystem.write': true, 'tool:web_search': true },
    enforceable: ENF,
  })
  assert.deepEqual(r.effective, { 'tool:pwsh': true, 'filesystem.write': true }, 'web_search 不在 enforceable.tools → 不生效')
  assert.equal(r.coverage, 'PARTIAL')
  assert.ok(r.deniedReasons.some(x => x.includes('tool:web_search') && x.includes('enforce')))
})

test('S4 resolver: 无自授（grant 缺）/ 超 ceiling / ceiling 缺失', () => {
  // grant 缺失 → 拒
  const r1 = resolveEffectiveCapability({
    requirement: { 'tool:pwsh': true }, grant: {}, ceiling: { 'tool:pwsh': true }, enforceable: ENF,
  })
  assert.deepEqual(r1.effective, {})
  assert.equal(r1.coverage, 'NONE')
  assert.ok(r1.deniedReasons[0]?.includes('Supervisor grant'))
  // 超 ceiling（不在允许清单）→ 拒
  const r2 = resolveEffectiveCapability({
    requirement: { 'tool:pwsh': true }, grant: { 'tool:pwsh': true }, ceiling: {}, enforceable: ENF,
  })
  assert.deepEqual(r2.effective, {})
  assert.ok(r2.deniedReasons[0]?.includes('Owner ceiling'))
  // ceiling 缺失 → 全拒（B-7）
  const r3 = resolveEffectiveCapability({
    requirement: { 'tool:pwsh': true }, grant: { 'tool:pwsh': true }, ceiling: null, enforceable: ENF,
  })
  assert.equal(r3.coverage, 'NONE')
  assert.ok(r3.deniedReasons[0]?.includes('capability ceiling'))
})

test('S4 resolver: isEnforceable 映射（未知能力 fail-closed；filesystem.read 只读/写可 enforce）', () => {
  assert.equal(isEnforceable('tool:pwsh', ENF), true)
  assert.equal(isEnforceable('tool:web_search', ENF), false)
  assert.equal(isEnforceable('filesystem.write', ENF), true)
  assert.equal(isEnforceable('filesystem.write', { ...ENF, sandboxMode: 'read-only' }), false)
  assert.equal(isEnforceable('filesystem.read', { ...ENF, sandboxMode: 'read-only' }), true)
  assert.equal(isEnforceable('shell.exec', { ...ENF, sandboxMode: 'read-only' }), true)
  assert.equal(isEnforceable('approval.never', ENF), true)
  assert.equal(isEnforceable('mystery.cap', ENF), false)
  assert.deepEqual(effectiveTools({ 'tool:pwsh': true, 'filesystem.write': true }), ['pwsh'])
})

// ── 2. materialize / cleanup ────────────────────────────────────────────────

class FakeTools {
  restrictCalls: { allow?: string[] }[] = []
  guardCalls: ((exec: { name: string }) => string | undefined)[] = []
  disposed = 0
  restrict(filter: { allow?: string[] }): () => void {
    this.restrictCalls.push(filter)
    return () => { this.disposed++ }
  }
  guard(fn: (exec: { name: string }) => string | undefined): () => void {
    this.guardCalls.push(fn)
    return () => { this.disposed++ }
  }
  schemas(): unknown { return [{ name: 'pwsh' }, { name: 'read' }, { name: 'edit' }, { name: 'web_search' }] }
}

function makeAgent(tools = new FakeTools()): { ctx: { tools: FakeTools }; session: { header: { cwd: string }; events: { type: string; data?: Record<string, unknown> }[] } } {
  return {
    ctx: { tools },
    session: { header: { cwd: 'C:/terr-a' }, events: [] },
  }
}

function makePolicyDeps(overrides: { sandbox?: boolean; approval?: boolean; permission?: boolean } = {}) {
  const append = (s: { events: { type: string; data?: Record<string, unknown> }[] }, type: string, data?: Record<string, unknown>) =>
    s.events.push({ type, ...(data ? { data } : {}) })
  return {
    sandboxPolicy: overrides.sandbox === false ? undefined : { setSandboxMode: (s: never, mode: string) => append(s, 'sandbox/mode', { mode }) },
    approval: overrides.approval === false ? undefined : { setApprovalPolicy: (s: never, policy: string) => append(s, 'approval/policy', { policy }) },
    permission: overrides.permission === false ? undefined : {
      set: (s: never, name: string) => {
        // 真实 permissionPresets.set 内部会落 sandbox+approval（permission-presets/src/index.ts:375-392）
        append(s, 'permission/preset', { preset: name })
        append(s, 'sandbox/mode', { mode: 'workspace-write' })
        append(s, 'approval/policy', { policy: 'never' })
      },
    },
  }
}

function ctxOf(agent: ReturnType<typeof makeAgent>, sessionRef = 's-1'): DshEnforcementContext {
  return { sessionRef, agent }
}

test('S4 enforcement: materialize 应用 4 面 + typed evidence；cleanup 拆除 disposer', async () => {
  const agent = makeAgent()
  const deps = makePolicyDeps()
  const result = await materializeDshEnforcement(deps, ctxOf(agent), {
    tools: ['pwsh', 'read'], territoryPath: 'C:/terr-a', sandboxMode: 'workspace-write', approvalPolicy: 'never',
  })
  assert.equal(result.ok, true)
  const evidence = JSON.parse(result.evidenceJson!)
  assert.equal(evidence.type, ENFORCEMENT_EVIDENCE_TYPE)
  assert.deepEqual(evidence.payload.tools, ['pwsh', 'read'])
  assert.equal(evidence.payload.sandboxMode, 'workspace-write')
  assert.equal(evidence.payload.approvalPolicy, 'never')
  assert.equal(evidence.payload.guards, 2)
  // 证据核验：事件必须落 session 日志
  const types = agent.session.events.map(e => e.type)
  assert.ok(types.includes('sandbox/mode'))
  assert.ok(types.includes('approval/policy'))
  // guard 单调拒绝：未授权工具 → 拒绝理由；已授权 → undefined 放行
  // （dsh ToolGuard 运行时契约：仅 `undefined` 放行，`null` 会被当作拒绝 reason → `Error: null`；
  //   正式入口 E2E seam——materialize 的 guard 对允许工具必须返回 undefined）
  const guard = agent.ctx.tools.guardCalls[0]
  assert.equal(guard({ name: 'pwsh' }), undefined)
  assert.ok(guard({ name: 'web_search' })!.includes('capability not granted'))
  // cleanup 拆除
  const cleanup = await cleanupDshEnforcement(ctxOf(agent))
  assert.equal(cleanup.ok, true)
  assert.equal(agent.ctx.tools.disposed, 2)
})

test('S4 enforcement: 缺 sandbox/approval 后端 → CANNOT_ENFORCE（fail-closed）+ 无 disposer 泄漏', async () => {
  const agent = makeAgent()
  const deps = makePolicyDeps({ sandbox: false, approval: false })
  const result = await materializeDshEnforcement(deps, ctxOf(agent), {
    tools: ['pwsh'], territoryPath: 'C:/terr-a', sandboxMode: 'workspace-write', approvalPolicy: 'never',
  })
  assert.equal(result.ok, false)
  assert.ok(result.reasons.some(r => r.includes('sandboxPolicy 缺失')))
  assert.ok(result.reasons.some(r => r.includes('approval 服务缺失')))
  assert.equal(agent.ctx.tools.disposed, 2, '失败路径必须拆除已注册 disposer')
})

test('S4 enforcement: preset 一键路径（permission.set）+ readEnforceableSet 从事件重建', async () => {
  const agent = makeAgent()
  const deps = makePolicyDeps({ permission: true, sandbox: false, approval: false })
  const result = await materializeDshEnforcement(deps, ctxOf(agent), {
    tools: ['pwsh'], territoryPath: 'C:/terr-a', sandboxMode: 'workspace-write', approvalPolicy: 'never', presetId: 'worker-safe',
  })
  assert.equal(result.ok, true, `preset 路径不应要求独立 sandbox/approval：${result.reasons.join(';')}`)
  assert.ok(agent.session.events.some(e => e.type === 'permission/preset' && e.data?.preset === 'worker-safe'))
  // readEnforceableSet：从事件重建 context-bound 集合
  const set = await readEnforceableSet(ctxOf(agent))
  assert.equal(set.sandboxMode, 'workspace-write')
  assert.equal(set.approvalPolicy, 'never')
  assert.equal(set.presetId, 'worker-safe')
  assert.deepEqual(set.tools, ['pwsh', 'read', 'edit', 'web_search'])
})

// ── 2b. BLOCKER #2 回归（Owner 指令 A–D：agentPresetId 与 sandboxMode 严格分离 + rejection 不泄漏）──

/** 收集测试进程内 unhandledRejection（断言无泄漏）。 */
async function withRejectionProbe(fn: () => Promise<void>): Promise<unknown[]> {
  const captured: unknown[] = []
  const handler = (reason: unknown): void => { captured.push(reason) }
  process.on('unhandledRejection', handler)
  try { await fn() } finally { process.off('unhandledRejection', handler) }
  return captured
}

test('BLOCKER2 A: agentPreset=standard + sandbox 事件 workspace-write → resolveMountable 永不被传 workspace-write', async () => {
  const agent = makeAgent()
  // session 事件带 permission/preset='workspace-write'（PermissionPresetService 预设名——历史错误数据来源）
  agent.session.events.push({ type: 'permission/preset', data: { preset: 'workspace-write' } })
  agent.session.events.push({ type: 'sandbox/mode', data: { mode: 'workspace-write' } })
  const called: string[] = []
  const deps = { presets: { resolveMountable: (id: string) => { called.push(id); return { tools: ['pwsh'] } } } }
  const ctx = { ...ctxOf(agent), agentPresetId: 'standard' }
  const set = await readEnforceableSet(ctx, deps)
  assert.deepEqual(called, ['standard'], 'resolveMountable 只能收到 agentPresetId（standard），绝不能收到 workspace-write')
  assert.deepEqual(set.tools, ['pwsh'], 'A∩B：inventory ∩ standard preset 面')
})

test('BLOCKER2 B/C: resolveMountable 不存在/拒绝 → fail-closed 回退 + 无 unhandledRejection', async () => {
  const agent = makeAgent()
  const ctx = { ...ctxOf(agent), agentPresetId: 'standard' }
  // B：preset 不存在（resolveMountable 同步抛错）
  const thrown = await withRejectionProbe(async () => {
    const set = await readEnforceableSet(ctx, { presets: { resolveMountable: () => { throw new Error('preset not found') } } })
    assert.deepEqual(set.tools, ['pwsh', 'read', 'edit', 'web_search'], 'B 面失败 → 回退 session 装配面（fail-closed 不空手）')
  })
  assert.equal(thrown.length, 0, '同步抛错必须被 catch，不产生 unhandledRejection')
  // C：resolveMountable 返回 rejected Promise（BLOCKER #2 原始形态）
  const rejected = await withRejectionProbe(async () => {
    const set = await readEnforceableSet(ctx, { presets: { resolveMountable: async () => { throw new Error('async reject') } } })
    assert.deepEqual(set.tools, ['pwsh', 'read', 'edit', 'web_search'], 'rejection 被 await+catch 消费 → 回退装配面')
  })
  assert.equal(rejected.length, 0, 'rejected Promise 必须被 await/catch 消费，绝不泄漏到 host')
})

test('BLOCKER2 D: 正常 standard preset → capabilities 正确得到 A∩B 工具面', async () => {
  const agent = makeAgent()
  const ctx = { ...ctxOf(agent), agentPresetId: 'standard' }
  const set = await readEnforceableSet(ctx, { presets: { resolveMountable: (id: string) => {
    assert.equal(id, 'standard')
    return { tools: ['pwsh', 'read'] }
  } } })
  assert.deepEqual(set.tools, ['pwsh', 'read'], 'A∩B = inventory ∩ preset 声明（web_search/edit 被 preset 面排除）')
})

// ── 3. adapter capability surface ───────────────────────────────────────────

test('S4 adapter: capabilities/preflight/materialize/cleanup 全接通', async () => {
  const agents = {
    agents: new Map<string, { id: string; status: 'idle'; session: unknown }>(),
    create: async () => { throw new Error('unused') },
    resume: async () => { throw new Error('unused') },
    get: () => undefined,
    list: () => [],
  }
  const adapter = new DshRuntimeAdapter({
    runtimeInstanceRef: 'inst-1', provider: 'spawn', model: null, agents,
    permission: makePolicyDeps().permission,
    sandboxPolicy: makePolicyDeps().sandboxPolicy,
    approval: makePolicyDeps().approval,
  })
  const agent = makeAgent()
  const ctx = ctxOf(agent)
  // capabilities：机制可用性（policy 后端齐备）→ 可 enforce 领地写 + 禁扩权 + 工具面
  assert.deepEqual(await adapter.capabilities(ctx), { tools: ['pwsh', 'read', 'edit', 'web_search'], sandboxMode: 'workspace-write', approvalPolicy: 'never', presetId: null })
  // 无 policy 后端 → 空集（fail-closed）
  const bareAdapter = new DshRuntimeAdapter({
    runtimeInstanceRef: 'inst-1', provider: 'spawn', model: null,
    agents: { agents: new Map(), create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') }, get: () => undefined, list: () => [] },
  })
  assert.deepEqual(await bareAdapter.capabilities(ctx), { tools: ['pwsh', 'read', 'edit', 'web_search'], sandboxMode: null, approvalPolicy: null, presetId: null })
  // preflight：approval≠never 拒；机制齐备通过
  const bad = await adapter.preflight({ tools: ['pwsh'], territoryPath: 'C:/terr-a', sandboxMode: 'workspace-write', approvalPolicy: 'ask' }, ctx)
  assert.equal(bad.ok, false)
  const good = await adapter.preflight({ tools: ['pwsh'], territoryPath: 'C:/terr-a', sandboxMode: 'workspace-write', approvalPolicy: 'never' }, ctx)
  assert.equal(good.ok, true)
  // materialize + cleanup
  const m = await adapter.materialize({ tools: ['pwsh'], territoryPath: 'C:/terr-a', sandboxMode: 'workspace-write', approvalPolicy: 'never' }, ctx)
  assert.equal(m.ok, true)
  assert.ok(m.evidenceJson)
  const c = await adapter.cleanup({ tools: ['pwsh'], territoryPath: 'C:/terr-a', sandboxMode: 'workspace-write', approvalPolicy: 'never' }, ctx)
  assert.equal(c.ok, true)
})

// ── 4. runCapabilityGate（TX-0D..TX-2S/2F）──────────────────────────────────

function makeGateEnv(): { store: KingdomStore; kingdomId: string; worker: string; sup: string; terrA: string; taskId: string; leaseId: string; adapter: DshRuntimeAdapter; agent: ReturnType<typeof makeAgent> } {
  const store = new KingdomStore(':memory:')
  const kingdomId = 'k'
  store.insertKingdom({ kingdom_id: kingdomId, name: 'K', created_at: NOW(), owner_id: 'o1', owner_name: 'T' })
  const worker = `w-${Math.random().toString(36).slice(2, 8)}`
  const sup = `s-${Math.random().toString(36).slice(2, 8)}`
  store.insertBinding({ binding_id: worker, kingdom_id: kingdomId, role_type: 'WORKER', role_name: 'W', runtime_type: 'dsh', session_id: null, model_name: null, agent_name: null, session_meta: null, execution_profile_json: null, status: 'ACTIVE', retired_at: null, retired_reason: null, principal_id: null, created_at: NOW(), updated_at: NOW() })
  store.insertBinding({ binding_id: sup, kingdom_id: kingdomId, role_type: 'SUPERVISOR', role_name: 'S', runtime_type: 'dsh', session_id: null, model_name: null, agent_name: null, session_meta: null, execution_profile_json: null, status: 'ACTIVE', retired_at: null, retired_reason: null, principal_id: null, created_at: NOW(), updated_at: NOW() })
  const terrA = `t-${Math.random().toString(36).slice(2, 8)}`
  store.insertTerritory({ territory_id: terrA, kingdom_id: kingdomId, name: 'A', workspace_path: 'C:/terr-a', summary: null, supervisor_binding_id: sup, status: 'ACTIVE', deleted_at: null, deleted_reason: null, created_at: NOW() })
  const taskId = `task-${Math.random().toString(36).slice(2, 8)}`
  store.insertTask({ task_id: taskId, territory_id: terrA, parent_task_id: null, title: 'T', description: null, assigned_binding_id: worker, status: 'ASSIGNED', acceptance_criteria: null, result_summary: null, created_at: NOW(), updated_at: NOW() })
  const agent = makeAgent()
  const adapter = new DshRuntimeAdapter({
    runtimeInstanceRef: 'inst-1', provider: 'spawn', model: null,
    agents: { agents: new Map(), create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') }, get: () => undefined, list: () => [] },
    permission: makePolicyDeps().permission,
    sandboxPolicy: makePolicyDeps().sandboxPolicy,
    approval: makePolicyDeps().approval,
  })
  // 建 affinity + acquire lease（TX-A）
  establishAffinity(store, { kingdomId, workerBindingId: worker, session: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 's-1' }, territoryId: terrA })
  const lease = acquireExecutionLease(store, { kingdomId, workerBindingId: worker, session: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 's-1' }, territoryId: terrA, taskId, attemptNo: 1 })
  return { store, kingdomId, worker, sup, terrA, taskId, leaseId: lease.lease_id, adapter, agent }
}

const FULL_REQ = JSON.stringify({ 'tool:pwsh': true, 'filesystem.write': true })
const FULL_CEIL = JSON.stringify({ 'tool:pwsh': true, 'filesystem.write': true })
const FULL_GRANT: GrantMap = { 'tool:pwsh': true, 'filesystem.write': true }

test('S4 gate: 完整 GRANTED 路径（TX-0D..TX-2S）→ GRANTED+ENFORCED + DISPATCH_READY', async () => {
  const env = makeGateEnv()
  const { store, kingdomId, taskId, worker, sup, leaseId, adapter, agent } = env
  store.setKingdomCapabilityCeiling(kingdomId, FULL_CEIL)
  store.setTaskCapabilityRequirement(taskId, FULL_REQ)
  const result = await runCapabilityGate({
    store, adapter, kingdomId, taskId, attemptNo: 1, workerBindingId: worker, supervisorBindingId: sup,
    leaseId, requirementJson: FULL_REQ, ceilingJson: FULL_CEIL, grant: FULL_GRANT,
    sandboxMode: 'workspace-write', context: ctxOf(agent, 's-1'),
  })
  assert.equal(result.materialized, true)
  assert.equal(result.decision.decision, 'GRANTED')
  assert.equal(result.decision.enforcement_status, 'ENFORCED')
  assert.ok(result.decision.enforcement_evidence_json)
  assert.equal(result.lease.state, 'DISPATCH_READY')
  assert.equal(store.getLease(leaseId)?.capability_decision_id, result.decision.decision_id)
  // 计划已持久（materialize 前）
  assert.ok(store.getLease(leaseId)?.enforcement_plan_snapshot)
  // zero execution 未被破坏：无 executions / dispatch
  assert.equal(store.listExecutions(taskId).length, 0)
  assert.equal(store.listDispatches(kingdomId).length, 0)
})

test('S4 gate: ceiling 缺失 → DENIED+UNAVAILABLE + zero execution（B-7）', async () => {
  const env = makeGateEnv()
  const { store, kingdomId, taskId, worker, sup, leaseId, adapter, agent } = env
  const result = await runCapabilityGate({
    store, adapter, kingdomId, taskId, attemptNo: 1, workerBindingId: worker, supervisorBindingId: sup,
    leaseId, requirementJson: FULL_REQ, ceilingJson: null, grant: FULL_GRANT,
    sandboxMode: 'workspace-write', context: ctxOf(agent, 's-1'),
  })
  assert.equal(result.materialized, false)
  assert.equal(result.decision.decision, 'DENIED')
  assert.equal(result.decision.enforcement_status, 'UNAVAILABLE')
  assert.equal(result.decision.reason_code, 'CEILING_NOT_CONFIGURED')
  assert.equal(store.getLease(leaseId)?.state, 'RELEASED', 'zero execution：lease 必须释放')
  assert.equal(store.listExecutions(taskId).length, 0)
  assert.equal(store.listDispatches(kingdomId).length, 0)
})

test('S4 gate: 无自授/超授权 → coverage≠FULL → DENIED+NOT_ATTEMPTED', async () => {
  const env = makeGateEnv()
  const { store, kingdomId, taskId, worker, sup, leaseId, adapter, agent } = env
  store.setKingdomCapabilityCeiling(kingdomId, FULL_CEIL)
  const result = await runCapabilityGate({
    store, adapter, kingdomId, taskId, attemptNo: 1, workerBindingId: worker, supervisorBindingId: sup,
    leaseId, requirementJson: FULL_REQ, ceilingJson: FULL_CEIL,
    grant: { 'tool:pwsh': true }, // filesystem.write 未授予
    sandboxMode: 'workspace-write', context: ctxOf(agent, 's-1'),
  })
  assert.equal(result.materialized, false)
  assert.equal(result.decision.decision, 'DENIED')
  assert.equal(result.decision.enforcement_status, 'NOT_ATTEMPTED')
  assert.ok(result.decision.reason_code?.includes('filesystem.write'))
  assert.equal(store.getLease(leaseId)?.state, 'RELEASED')
  assert.equal(store.listExecutions(taskId).length, 0)
})

test('S4 gate: materialize 失败 → DENIED+FAILED + cleanup + zero execution（TX-2F）', async () => {
  const env = makeGateEnv()
  const { store, kingdomId, taskId, worker, sup, leaseId, adapter, agent } = env
  store.setKingdomCapabilityCeiling(kingdomId, FULL_CEIL)
  // capabilities 声明可 enforce（机制存在），但 sandbox 应用实际抛错 → materialize 失败
  const adapterBrokenSandbox = new DshRuntimeAdapter({
    runtimeInstanceRef: 'inst-1', provider: 'spawn', model: null,
    agents: { agents: new Map(), create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') }, get: () => undefined, list: () => [] },
    permission: makePolicyDeps().permission,
    approval: makePolicyDeps().approval,
    sandboxPolicy: { setSandboxMode: () => { throw new Error('sandbox backend unavailable') } },
  })
  const result = await runCapabilityGate({
    store, adapter: adapterBrokenSandbox, kingdomId, taskId, attemptNo: 1, workerBindingId: worker, supervisorBindingId: sup,
    leaseId, requirementJson: FULL_REQ, ceilingJson: FULL_CEIL, grant: FULL_GRANT,
    sandboxMode: 'workspace-write', context: ctxOf(agent, 's-1'),
  })
  assert.equal(result.materialized, false)
  assert.equal(result.decision.decision, 'DENIED')
  assert.equal(result.decision.enforcement_status, 'FAILED', `期望 MATERIALIZE_FAILED 路径：${result.decision.reason_code}`)
  assert.equal(store.getLease(leaseId)?.state, 'RELEASED')
  assert.equal(store.listExecutions(taskId).length, 0, 'materialize 失败绝不允许产生 Execution')
  assert.equal(store.listDispatches(kingdomId).length, 0)
})
