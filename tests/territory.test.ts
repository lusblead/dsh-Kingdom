/**
 * dsh-kingdom — 领地删除（v0.5.1）治理语义测试。
 *
 * 运行：先构建 lib（bash scripts/build.sh），再 `node --test tests/*.test.ts`。
 * 隔离：全部使用 `:memory:` 内存库，不触碰任何真实 DB。
 *
 * 覆盖（Owner 裁决 2026-08-18）：
 * - 领地不存在（id / name）→ 错误；
 * - 无任务 → 删除成功 + TERRITORY_DELETED 留痕；
 * - 有任务且未 force → 拒绝，行与任务状态原样保留；
 * - force 级联 → 未终态任务 FAILED（逐条 TASK_FAILED 事件、活跃 Execution ABORTED）、
 *   DONE/FAILED 终态不篡改、TERRITORY_DELETED payload 携带完整任务清单。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { KingdomStore, type TaskRow, type ExecutionRow, type EventRow } from '../lib/core/db.js'
import { createTerritory, deleteTerritory } from '../lib/core/territory.js'

const KID = 'kingdom-test-1'
const NOW = () => new Date().toISOString()

function makeStore(): KingdomStore {
  const store = new KingdomStore(':memory:')
  store.insertKingdom({
    kingdom_id: KID,
    name: '测试王国',
    created_at: NOW(),
    owner_id: 'owner-1',
    owner_name: 'Tester',
  })
  return store
}

function seedTerritory(store: KingdomStore, name = '研发领'): { id: string; name: string } {
  const id = randomUUID()
  store.insertTerritory({
    territory_id: id,
    kingdom_id: KID,
    name,
    workspace_path: 'D:/ws',
    summary: '测试领地',
    supervisor_binding_id: null,
    status: 'ACTIVE',
    created_at: NOW(),
  })
  return { id, name }
}

function seedTask(store: KingdomStore, territoryId: string, status: string, title?: string): TaskRow {
  const row: TaskRow = {
    task_id: randomUUID(),
    territory_id: territoryId,
    parent_task_id: null,
    title: title ?? `任务-${status}`,
    description: null,
    assigned_binding_id: null,
    status,
    acceptance_criteria: null,
    result_summary: null,
    created_at: NOW(),
    updated_at: NOW(),
  }
  store.insertTask(row)
  return row
}

function seedLiveExecution(store: KingdomStore, taskId: string, state = 'RUNNING'): ExecutionRow {
  const row: ExecutionRow = {
    execution_id: randomUUID(),
    task_id: taskId,
    attempt_no: 1,
    worker_binding_id: null,
    session_id: 'session-1',
    state,
    detail: null,
    started_at: NOW(),
    heartbeat_at: NOW(),
    ended_at: null,
    pause_requested_at: null,
    // v0.6.0 执行证据列（测试种子不涉及执行解析，全 null）
    executor_kind: null,
    provider: null,
    provider_source: null,
    requested_model: null,
    resolved_model: null,
    model_source: null,
    execution_profile_json: null,
  }
  store.insertExecution(row)
  return row
}

function eventsOf(store: KingdomStore, type: string): EventRow[] {
  return store.listEvents(KID, 200).filter(e => e.event_type === type)
}

function territoryNames(store: KingdomStore): string[] {
  return store.listTerritories(KID).map(t => t.name)
}

/** declarative 演示模式（Topology Admin 在 declarative 下保持现状）。 */
const demoAuth = () => ({ mode: 'declarative' as const, principalSessionId: null })

test('领地不存在：按 id 与按 name 均返回错误', () => {
  const store = makeStore()
  const byId = deleteTerritory(store, { kingdomId: KID, territoryId: 'no-such-id' }, demoAuth())
  assert.match(byId, /^错误：领地不存在/)
  const byName = deleteTerritory(store, { kingdomId: KID, name: '不存在的领地' }, demoAuth())
  assert.match(byName, /^错误：领地不存在/)
})

test('无任务：删除成功（tombstone DELETED），TERRITORY_DELETED 留痕，历史可解析', () => {
  const store = makeStore()
  const t = seedTerritory(store)
  const result = deleteTerritory(store, { kingdomId: KID, territoryId: t.id }, demoAuth())
  assert.match(result, /^已删除领地「研发领」/)
  assert.deepEqual(territoryNames(store), [])
  // v0.7.0 tombstone：行不物理删除，历史归属永远可解析
  const tomb = store.getTerritoryById(t.id)!
  assert.equal(tomb.status, 'DELETED')
  assert.ok(tomb.deleted_at)

  const events = eventsOf(store, 'TERRITORY_DELETED')
  assert.equal(events.length, 1)
  const payload = JSON.parse(events[0]!.payload_json) as {
    name: string; force: boolean; task_count: number; tasks: unknown[]; status: string
  }
  assert.equal(payload.name, '研发领')
  assert.equal(payload.force, false)
  assert.equal(payload.task_count, 0)
  assert.equal(payload.status, 'DELETED')
  assert.deepEqual(payload.tasks, [])
})

test('有任务且未 force：拒绝删除，领地与任务状态原样保留，无 TERRITORY_DELETED', () => {
  const store = makeStore()
  const t = seedTerritory(store)
  seedTask(store, t.id, 'CREATED')
  seedTask(store, t.id, 'DONE')

  const result = deleteTerritory(store, { kingdomId: KID, territoryId: t.id }, demoAuth())
  assert.match(result, /^错误：领地「研发领」下还有 2 个任务/)
  assert.deepEqual(territoryNames(store), ['研发领'])
  const tasks = store.listTasks(KID, { territoryId: t.id })
  assert.deepEqual(tasks.map(x => x.status).sort(), ['CREATED', 'DONE'])
  assert.equal(eventsOf(store, 'TERRITORY_DELETED').length, 0)
  assert.equal(eventsOf(store, 'TASK_FAILED').length, 0)
})

test('force 级联：未终态统一 FAILED、终态不篡改、活跃执行 ABORTED、全链路留痕', () => {
  const store = makeStore()
  const t = seedTerritory(store)
  const created = seedTask(store, t.id, 'CREATED')
  const assigned = seedTask(store, t.id, 'ASSIGNED')
  const running = seedTask(store, t.id, 'RUNNING')
  seedLiveExecution(store, running.task_id, 'RUNNING')
  const review = seedTask(store, t.id, 'REVIEW')
  const done = seedTask(store, t.id, 'DONE')
  const failed = seedTask(store, t.id, 'FAILED')

  const result = deleteTerritory(store, {
    kingdomId: KID,
    territoryId: t.id,
    force: true,
    reason: '测试级联',
  }, demoAuth())
  assert.match(result, /^已删除领地「研发领」/)
  assert.match(result, /其中 4 个未终态任务标记 FAILED、2 个终态任务原样保留/)
  assert.match(result, /终止 1 条活跃执行/)
  assert.deepEqual(territoryNames(store), [])

  // 任务行保留，状态符合语义
  const statuses = new Map<string, string>()
  for (const id of [created.task_id, assigned.task_id, running.task_id, review.task_id, done.task_id, failed.task_id]) {
    statuses.set(id, store.getTask(id)!.status)
  }
  assert.equal(statuses.get(created.task_id), 'FAILED')
  assert.equal(statuses.get(assigned.task_id), 'FAILED')
  assert.equal(statuses.get(running.task_id), 'FAILED')
  assert.equal(statuses.get(review.task_id), 'FAILED')
  assert.equal(statuses.get(done.task_id), 'DONE')      // 终态事实不篡改
  assert.equal(statuses.get(failed.task_id), 'FAILED')

  // 活跃 Execution 被 ABORTED
  assert.equal(store.latestExecution(running.task_id)!.state, 'ABORTED')

  // 逐条 TASK_FAILED 事件（仅未终态 4 条），携带原状态与级联原因
  const taskFailed = eventsOf(store, 'TASK_FAILED')
  assert.equal(taskFailed.length, 4)
  const originals = taskFailed
    .map(e => (JSON.parse(e.payload_json) as { original_status: string }).original_status)
    .sort()
  assert.deepEqual(originals, ['ASSIGNED', 'CREATED', 'REVIEW', 'RUNNING'])
  for (const e of taskFailed) {
    const payload = JSON.parse(e.payload_json) as { reason: string; cascade_from_territory: string }
    assert.equal(payload.reason, '领地级联删除')
    assert.equal(payload.cascade_from_territory, t.id)
  }

  // TERRITORY_DELETED payload 携带完整清单
  const deleted = eventsOf(store, 'TERRITORY_DELETED')
  assert.equal(deleted.length, 1)
  const payload = JSON.parse(deleted[0]!.payload_json) as {
    force: boolean; reason: string; task_count: number; aborted_executions: number
    tasks: { task_id: string; original_status: string; final_status: string }[]
  }
  assert.equal(payload.force, true)
  assert.equal(payload.reason, '测试级联')
  assert.equal(payload.task_count, 6)
  assert.equal(payload.aborted_executions, 1)
  assert.equal(payload.tasks.length, 6)
  const byOriginal = new Map(payload.tasks.map(x => [x.original_status, x.final_status]))
  assert.equal(byOriginal.get('CREATED'), 'FAILED')
  assert.equal(byOriginal.get('RUNNING'), 'FAILED')
  assert.equal(byOriginal.get('DONE'), 'DONE')
  assert.equal(byOriginal.get('FAILED'), 'FAILED')
})

test('按 name 删除；id 与 name 同时给出时 id 优先', () => {
  const store = makeStore()
  const t = seedTerritory(store, '按名删除领')

  const byName = deleteTerritory(store, { kingdomId: KID, name: '按名删除领' }, demoAuth())
  assert.match(byName, /^已删除领地「按名删除领」/)
  assert.deepEqual(territoryNames(store), [])

  const t2 = seedTerritory(store, 'id 优先领')
  // 故意给一个错误 name + 正确 id：id 应获胜
  const byId = deleteTerritory(store, { kingdomId: KID, territoryId: t2.id, name: '错误名字' }, demoAuth())
  assert.match(byId, /^已删除领地「id 优先领」/)
  assert.deepEqual(territoryNames(store), [])
})

test('createTerritory 产物可按 name 删除（真实路径冒烟）', () => {
  const store = makeStore()
  createTerritory(store, { kingdomId: KID, name: '临时领' }, demoAuth())
  const result = deleteTerritory(store, { kingdomId: KID, name: '临时领' }, demoAuth())
  assert.match(result, /^已删除领地「临时领」/)
  assert.deepEqual(territoryNames(store), [])
})
