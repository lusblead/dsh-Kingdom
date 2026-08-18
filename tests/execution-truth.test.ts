/**
 * dsh-kingdom — M1-C Execution Truth（v0.6.0）测试。
 *
 * 覆盖：
 * - Schema v2 迁移（v1 旧库开库收敛 + 事务原子性语义）；
 * - setExecutionProfile 治理（Trusted Admin Plane：session-bound 下仅 OWNER）；
 * - resolveWorkerExecution：E1/E2/E3（provider_source/model_source 证据）+ 硬不变量
 *   （binding.model_name 禁止参与执行解析）+ provider 未注册拒绝；
 * - DshSubagentExecutor：agentOptions.model 传递、resolvedModel 提取（fake run）。
 *
 * 运行：先构建 lib（tsc -p tsconfig.json），再 `node --test tests/*.test.ts`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { KingdomStore } from '../lib/core/db.js'
import { bindRole, setExecutionProfile, type AdminAuth } from '../lib/core/binding.js'
import { resolveWorkerExecution, buildExecutionProfileSnapshot } from '../lib/core/../worker/executor-factory.js'
import { DshSubagentExecutor, type SubagentsLike } from '../lib/worker/dsh-subagent.js'
import { parseStructuredResult } from '../lib/worker/executor.js'

const KID = 'kingdom-m1c-1'
const OWNER_SESSION = 'session-owner'
const OTHER_SESSION = 'session-x'

function makeStore(withOwnerSession = true): KingdomStore {
  const store = new KingdomStore(':memory:')
  store.insertKingdom({
    kingdom_id: KID, name: 'M1C 王国', created_at: new Date().toISOString(),
    owner_id: 'owner-1', owner_name: 'Tester',
  })
  store.insertBinding({
    binding_id: 'binding-owner', kingdom_id: KID, role_type: 'OWNER', role_name: 'Owner',
    runtime_type: 'dsh', session_id: withOwnerSession ? OWNER_SESSION : null,
    model_name: null, agent_name: null, session_meta: null, execution_profile_json: null,
    principal_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  })
  return store
}

function seedWorker(store: KingdomStore, bindingId = 'binding-worker'): void {
  store.insertBinding({
    binding_id: bindingId, kingdom_id: KID, role_type: 'WORKER', role_name: 'Worker-1',
    runtime_type: 'dsh', session_id: null, model_name: null, agent_name: null, session_meta: null,
    execution_profile_json: null, principal_id: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  })
}

function seedTask(store: KingdomStore, assignedBindingId: string): ReturnType<KingdomStore['getTask']> {
  const now = new Date().toISOString()
  store.insertTask({
    task_id: 'task-1', territory_id: 't-1', parent_task_id: null, title: 'M1C 任务',
    description: null, assigned_binding_id: assignedBindingId, status: 'ASSIGNED',
    acceptance_criteria: null, result_summary: null, created_at: now, updated_at: now,
  })
  return store.getTask('task-1')
}

const ownerAuth = (): AdminAuth => ({ mode: 'session-bound', principalSessionId: OWNER_SESSION })
const strangerAuth = (): AdminAuth => ({ mode: 'session-bound', principalSessionId: OTHER_SESSION })

function fakeSubagents(providers = ['spawn', 'fork']): SubagentsLike {
  const starts: Record<string, unknown>[] = []
  return {
    start: async (name, request) => {
      starts.push({ name, agentOptions: request.agentOptions })
      return {
        id: `run-${name}-1`,
        result: Promise.resolve({
          stopReason: 'completed',
          structured: { outcome: 'COMPLETED', summary: 'fake done' },
        }),
        dispose: async () => {},
        localAgent: { options: { model: request.agentOptions?.model ?? 'parent-inherited-model' } },
      }
    },
    getProvider: (name) => providers.includes(name) ? {} : undefined,
    list: () => providers,
    __starts: starts,
  } as SubagentsLike & { __starts: Record<string, unknown>[] }
}

function fakeRuntime(subagents: SubagentsLike) {
  return {
    subagents,
    globalProvider: 'spawn',
    parent: { id: 'supervisor-agent' },
    signal: new AbortController().signal,
  }
}

// ── Schema v2 migration ────────────────────────────────────────────

test('Schema v2：v1 旧库开库收敛（schema_version=2 + 全部预期列）', () => {
  const dir = join(process.cwd(), '.m1c-test')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'v1.db')
  // 手工构造 v1 库（旧表结构 + schema_version=1）
  const raw = new DatabaseSync(dbPath)
  raw.exec(`
    CREATE TABLE kingdoms (kingdom_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL,
      owner_id TEXT NOT NULL, owner_name TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE role_bindings (binding_id TEXT PRIMARY KEY, kingdom_id TEXT NOT NULL, role_type TEXT NOT NULL,
      role_name TEXT NOT NULL, runtime_type TEXT NOT NULL DEFAULT 'dsh', session_id TEXT, model_name TEXT,
      agent_name TEXT, session_meta TEXT, principal_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tasks (task_id TEXT PRIMARY KEY, territory_id TEXT NOT NULL, parent_task_id TEXT, title TEXT NOT NULL,
      description TEXT, assigned_binding_id TEXT, status TEXT NOT NULL DEFAULT 'CREATED', acceptance_criteria TEXT,
      result_summary TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE events (event_id TEXT PRIMARY KEY, kingdom_id TEXT NOT NULL, event_type TEXT NOT NULL,
      actor_role TEXT, actor_id TEXT, target_type TEXT, target_id TEXT, payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL);
    CREATE TABLE executions (execution_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt_no INTEGER NOT NULL,
      worker_binding_id TEXT, session_id TEXT, state TEXT NOT NULL, detail TEXT, started_at TEXT NOT NULL,
      heartbeat_at TEXT, ended_at TEXT, pause_requested_at TEXT);
    INSERT INTO kingdoms VALUES ('k1','v1 王国','2026-01-01','o1','Owner',1);
  `)
  raw.close()

  const store = new KingdomStore(dbPath)
  const v = store.db.prepare('SELECT schema_version FROM kingdoms').get() as { schema_version: number }
  assert.equal(v.schema_version, 2)
  const bindingCols = new Set(
    (store.db.prepare('PRAGMA table_info(role_bindings)').all() as { name: string }[]).map(c => c.name),
  )
  const execCols = new Set(
    (store.db.prepare('PRAGMA table_info(executions)').all() as { name: string }[]).map(c => c.name),
  )
  assert.ok(bindingCols.has('execution_profile_json'))
  for (const col of ['executor_kind', 'provider', 'provider_source', 'requested_model', 'resolved_model', 'model_source', 'execution_profile_json']) {
    assert.ok(execCols.has(col), `executions.${col} must exist`)
  }
  // 幂等：重复打开不再迁移
  store.close()
  const again = new KingdomStore(dbPath)
  assert.equal((again.db.prepare('SELECT schema_version FROM kingdoms').get() as { schema_version: number }).schema_version, 2)
  again.close()
  rmSync(dir, { recursive: true, force: true })
})

// ── setExecutionProfile 治理（Trusted Admin Plane）─────────────────

test('setExecutionProfile：session-bound 下仅 OWNER，其他角色 DENY', () => {
  const store = makeStore()
  seedWorker(store)
  const denied = setExecutionProfile(store, { kingdomId: KID, roleType: 'WORKER', profile: { provider: 'spawn', model: 'Model-B' } }, strangerAuth())
  assert.match(denied, /^错误：组织管理/)
  const noAuth = setExecutionProfile(store, { kingdomId: KID, roleType: 'WORKER', profile: { provider: 'fork' } }, { mode: 'session-bound', principalSessionId: null })
  assert.match(noAuth, /^错误：组织管理/)
  const ok = setExecutionProfile(store, { kingdomId: KID, roleType: 'WORKER', profile: { provider: 'spawn', model: 'Model-B' } }, ownerAuth())
  assert.match(ok, /^角色 WORKER/)
  const row = store.getBindingById('binding-worker')!
  assert.equal(JSON.parse(row.execution_profile_json!).model, 'Model-B')
  // 事件 actor=OWNER
  const ev = store.listEvents(KID, 50).find(e => e.event_type === 'EXECUTION_PROFILE_UPDATED')!
  assert.equal(ev.actor_role, 'OWNER')
  assert.equal(ev.actor_id, 'binding-owner')
  assert.equal(ev.target_id, 'binding-worker')
})

test('setExecutionProfile：declarative 演示模式保持现状；clear 清空', () => {
  const store = makeStore()
  seedWorker(store)
  const ok = setExecutionProfile(store, { kingdomId: KID, roleType: 'WORKER', profile: { provider: 'fork' } }, { mode: 'declarative', principalSessionId: OTHER_SESSION })
  assert.match(ok, /^角色 WORKER/)
  const cleared = setExecutionProfile(store, { kingdomId: KID, roleType: 'WORKER', profile: null }, { mode: 'declarative', principalSessionId: OTHER_SESSION })
  assert.match(cleared, /已清空/)
  assert.equal(store.getBindingById('binding-worker')!.execution_profile_json, null)
})

// ── resolveWorkerExecution：E1/E2/E3 + 硬不变量 ────────────────────

test('E1：Binding 完全指定（provider+model 均来自 binding）', () => {
  const store = makeStore()
  seedWorker(store)
  setExecutionProfile(store, { kingdomId: KID, roleType: 'WORKER', profile: { provider: 'spawn', model: 'Model-A' } }, ownerAuth())
  const task = seedTask(store, 'binding-worker')!
  const resolved = resolveWorkerExecution(store, task, fakeRuntime(fakeSubagents()))
  assert.ok(resolved.ok)
  assert.deepEqual(resolved.info, {
    provider: 'spawn', providerSource: 'binding', requestedModel: 'Model-A', modelSource: 'binding',
  })
  const snap = JSON.parse(buildExecutionProfileSnapshot(resolved.info, 'Model-A'))
  assert.equal(snap.source.provider, 'binding')
  assert.equal(snap.source.model, 'binding')
})

test('E2：Binding 只指定 Provider（model 继承 parent，如实记录）', () => {
  const store = makeStore()
  seedWorker(store)
  setExecutionProfile(store, { kingdomId: KID, roleType: 'WORKER', profile: { provider: 'fork' } }, ownerAuth())
  const task = seedTask(store, 'binding-worker')!
  const resolved = resolveWorkerExecution(store, task, fakeRuntime(fakeSubagents(['fork', 'spawn'])))
  assert.ok(resolved.ok)
  assert.deepEqual(resolved.info, {
    provider: 'fork', providerSource: 'binding', requestedModel: null, modelSource: 'parent-inherited',
  })
})

test('E3：完全无 Profile（global-fallback + parent-inherited 证据）', () => {
  const store = makeStore()
  seedWorker(store)
  const task = seedTask(store, 'binding-worker')!
  const resolved = resolveWorkerExecution(store, task, fakeRuntime(fakeSubagents()))
  assert.ok(resolved.ok)
  assert.deepEqual(resolved.info, {
    provider: 'spawn', providerSource: 'global-fallback', requestedModel: null, modelSource: 'parent-inherited',
  })
})

test('硬不变量：binding.model_name 绝不参与执行解析', () => {
  const store = makeStore()
  seedWorker(store)
  // model_name=Model-A（席位元数据）vs profile.model=Model-B（执行配置）
  store.updateBindingProfile('binding-worker', { modelName: 'Model-A' }, new Date().toISOString())
  setExecutionProfile(store, { kingdomId: KID, roleType: 'WORKER', profile: { provider: 'spawn', model: 'Model-B' } }, ownerAuth())
  const task = seedTask(store, 'binding-worker')!
  const resolved = resolveWorkerExecution(store, task, fakeRuntime(fakeSubagents()))
  assert.ok(resolved.ok)
  assert.equal(resolved.info.requestedModel, 'Model-B')
  assert.equal(resolved.info.requestedModel, 'Model-B')
})

test('resolveWorkerExecution：未指派/非 WORKER/provider 未注册均明确拒绝', () => {
  const store = makeStore()
  seedWorker(store)
  const noAssign = seedTask(store, 'binding-worker')!
  noAssign.assigned_binding_id = null
  const r1 = resolveWorkerExecution(store, noAssign, fakeRuntime(fakeSubagents()))
  assert.ok(!r1.ok && /未指派/.test(r1.error))
  // 第二个任务（不同 id）验证 provider 未注册拒绝
  const now = new Date().toISOString()
  store.insertTask({
    task_id: 'task-2', territory_id: 't-1', parent_task_id: null, title: 'M1C 任务2',
    description: null, assigned_binding_id: 'binding-worker', status: 'ASSIGNED',
    acceptance_criteria: null, result_summary: null, created_at: now, updated_at: now,
  })
  const badProvider = resolveWorkerExecution(store, store.getTask('task-2')!, fakeRuntime(fakeSubagents(['fork'])))
  // global fallback = spawn 未注册
  assert.ok(!badProvider.ok && /未注册/.test(badProvider.error))
})

// ── DshSubagentExecutor：agentOptions.model + resolvedModel ────────

test('DshSubagentExecutor：requested model 经 agentOptions 传递，resolvedModel 从 localAgent 提取', async () => {
  const subagents = fakeSubagents()
  const executor = new DshSubagentExecutor({
    subagents,
    provider: 'spawn',
    model: 'gpt-5.6',
    parent: { id: 'p' },
    signal: new AbortController().signal,
    info: { provider: 'spawn', providerSource: 'binding', requestedModel: 'gpt-5.6', modelSource: 'binding' },
  })
  const store = makeStore()
  seedWorker(store)
  const task = seedTask(store, 'binding-worker')!
  const outcome = await executor.execute(task!, {
    task: task!, acceptanceCriteria: null, attemptNo: 1,
  })
  assert.equal(outcome.kind, 'result')
  assert.equal((subagents as unknown as { __starts: { agentOptions?: { model?: string } }[] }).__starts[0]!.agentOptions?.model, 'gpt-5.6')
  assert.equal(outcome.resolvedModel, 'gpt-5.6')
  assert.equal(executor.info?.providerSource, 'binding')
})

test('DshSubagentExecutor：model 缺省时不传 agentOptions，resolvedModel=parent 模型', async () => {
  const subagents = fakeSubagents()
  const executor = new DshSubagentExecutor({
    subagents, provider: 'spawn', model: null, parent: { id: 'p' },
    signal: new AbortController().signal,
  })
  const store = makeStore()
  seedWorker(store)
  const task = seedTask(store, 'binding-worker')!
  const outcome = await executor.execute(task!, { task: task!, acceptanceCriteria: null, attemptNo: 1 })
  assert.equal(outcome.kind, 'result')
  const starts = (subagents as unknown as { __starts: { agentOptions?: unknown }[] }).__starts
  assert.equal(starts[0]!.agentOptions, undefined)
  assert.equal(outcome.resolvedModel, 'parent-inherited-model')
})
