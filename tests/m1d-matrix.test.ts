/**
 * dsh-kingdom — M1-D 对抗矩阵（4+1 身份 × 命令）+ startTask 执行证据落库链。
 *
 * 矩阵语义：lib 级 requireRole 只比较 sessionId 字符串——真实 DSH 会话与
 * 测试 principal 在职权校验层等价（工具面注入的是 exec.agent.session.id）。
 * session-bound 下 5 个身份（OWNER/CHANCELLOR/SUPERVISOR/WORKER/STRANGER）
 * 对治理命令的 PASS/DENY 全矩阵。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { KingdomStore, type ExecutionRow } from '../lib/core/db.js'
import { bindRole, setExecutionProfile, type AdminAuth } from '../lib/core/binding.js'
import { planTask, assignTask, startTask, reviewTask } from '../lib/core/task-service.js'
import type { ExecutorInfo, WorkerExecutor } from '../lib/worker/executor.js'

const KID = 'kingdom-m1d-1'
const S = {
  OWNER: 'session-owner',
  CHANCELLOR: 'session-chancellor',
  SUPERVISOR: 'session-supervisor',
  WORKER: 'session-worker',
  STRANGER: 'session-stranger',
}
const authBound: AdminAuth = { mode: 'session-bound', principalSessionId: null }

function makeStore(): KingdomStore {
  const store = new KingdomStore(':memory:')
  store.insertKingdom({
    kingdom_id: KID, name: 'M1D 王国', created_at: new Date().toISOString(),
    owner_id: 'o1', owner_name: 'Tester',
  })
  const now = new Date().toISOString()
  const insert = (bindingId: string, role: string, session: string | null): void => {
    store.insertBinding({
      binding_id: bindingId, kingdom_id: KID, role_type: role, role_name: `${role}-${bindingId.slice(-4)}`,
      runtime_type: 'dsh', session_id: session, model_name: null, agent_name: null, session_meta: null,
      execution_profile_json: null, principal_id: null, created_at: now, updated_at: now,
    })
  }
  insert('b-owner', 'OWNER', S.OWNER)
  insert('b-chancellor', 'CHANCELLOR', S.CHANCELLOR)
  insert('b-supervisor', 'SUPERVISOR', S.SUPERVISOR)
  insert('b-worker', 'WORKER', S.WORKER)
  return store
}

const ctx = (sessionId: string | null) => ({
  kingdomId: KID,
  auth: { mode: 'session-bound' as const, trustLevel: 'session-verified' as const, note: '' },
  principal: sessionId ? { sessionId } : undefined,
})

function seedTerritory(store: KingdomStore): void {
  store.insertTerritory({
    territory_id: 't-1', kingdom_id: KID, name: '矩阵领', workspace_path: null, summary: null,
    supervisor_binding_id: null, status: 'ACTIVE', created_at: new Date().toISOString(),
  })
}

test('M1-D 身份矩阵：4+1 Session × 治理命令（session-bound）', async () => {
  const store = makeStore()
  seedTerritory(store)
  const plan = (sessionId: string) => planTask(store, ctx(sessionId), { title: '矩阵任务' })
  const assign = (sessionId: string, taskId: string) => assignTask(store, ctx(sessionId), { taskId }).message
  const review = (sessionId: string, taskId: string) => reviewTask(store, ctx(sessionId), { taskId, decision: 'ACCEPT' }).message

  // plan：仅 CHANCELLOR PASS
  const planResult = plan(S.CHANCELLOR)
  assert.match(planResult.message, /^已创建任务/)
  const taskId = planResult.task!.taskId
  assert.match(plan(S.SUPERVISOR).message, /不是 CHANCELLOR/)
  assert.match(plan(S.WORKER).message, /不是 CHANCELLOR/)
  assert.match(plan(S.STRANGER).message, /不是 CHANCELLOR/)
  assert.match(plan(null).message, /不是 CHANCELLOR/)

  // assign：仅 SUPERVISOR PASS
  assert.match(assign(S.CHANCELLOR, taskId), /不是 SUPERVISOR/)
  assert.match(assign(S.WORKER, taskId), /不是 SUPERVISOR/)
  assert.match(assign(S.STRANGER, taskId), /不是 SUPERVISOR/)
  assert.match(assign(S.SUPERVISOR, taskId), /已把任务/)

  // start：仅 SUPERVISOR PASS（fake executor）
  const fake: WorkerExecutor = {
    kind: 'dsh-subagent:spawn',
    info: { provider: 'spawn', providerSource: 'global-fallback', requestedModel: null, modelSource: 'parent-inherited' },
    execute: async () => ({
      kind: 'result',
      result: { outcome: 'COMPLETED', summary: '矩阵执行完成' },
      sessionId: 'run-1',
      resolvedModel: 'deepseek-x',
    }),
  }
  const start = async (sessionId: string) => (await startTask(store, fake, ctx(sessionId), { taskId })).message
  assert.match(await start(S.WORKER), /不是 SUPERVISOR/)
  assert.match(await start(S.STRANGER), /不是 SUPERVISOR/)
  assert.match(await start(S.SUPERVISOR), /REVIEW/)

  // review：仅 SUPERVISOR PASS → DONE
  assert.match(review(S.WORKER, taskId), /不是 SUPERVISOR/)
  assert.match(review(S.STRANGER, taskId), /不是 SUPERVISOR/)
  assert.match(review(S.SUPERVISOR, taskId), /DONE/)
  assert.equal(store.getTask(taskId)!.status, 'DONE')

  // 管理面（Trusted Admin Plane）：仅 OWNER
  const setProfile = (sessionId: string | null) => setExecutionProfile(
    store, { kingdomId: KID, roleType: 'WORKER', profile: { provider: 'spawn' } },
    { mode: 'session-bound', principalSessionId: sessionId },
  )
  assert.match(setProfile(S.CHANCELLOR), /只有 OWNER/)
  assert.match(setProfile(S.SUPERVISOR), /只有 OWNER/)
  assert.match(setProfile(S.WORKER), /只有 OWNER/)
  assert.match(setProfile(S.STRANGER), /只有 OWNER/)
  assert.match(setProfile(S.OWNER), /执行配置已更新/)
})

test('M1-D 身份矩阵：换届后旧 Supervisor Session DENY，新任 PASS', async () => {
  const store = makeStore()
  seedTerritory(store)
  const planned = planTask(store, ctx(S.CHANCELLOR), { title: '换届任务' })
  const taskId = planned.task!.taskId
  assert.equal(store.getTask(taskId)!.status, 'CREATED')
  // 换届：OWNER 把 SUPERVISOR 改绑到新会话
  const { rebindSession } = await import('../lib/core/binding.js')
  rebindSession(store, { kingdomId: KID, roleType: 'SUPERVISOR', sessionId: 'session-supervisor-2' }, { mode: 'session-bound', principalSessionId: S.OWNER })
  const assignOld = assignTask(store, ctx(S.SUPERVISOR), { taskId }).message
  assert.match(assignOld, /不是 SUPERVISOR/) // 旧 Session 已被解职
  const assignNew = assignTask(store, ctx('session-supervisor-2'), { taskId }).message
  assert.match(assignNew, /已把任务/) // 新任 Session 可用
})

test('startTask 执行证据落库链：requested 列 + 结算补 resolved + 快照', async () => {
  const store = makeStore()
  seedTerritory(store)
  const planned = planTask(store, ctx(S.CHANCELLOR), { title: '证据链任务' })
  const taskId = planned.task!.taskId
  assignTask(store, ctx(S.SUPERVISOR), { taskId })

  const info: ExecutorInfo = {
    provider: 'spawn', providerSource: 'binding', requestedModel: 'gpt-5.6', modelSource: 'binding',
  }
  const fake: WorkerExecutor = {
    kind: 'dsh-subagent:spawn',
    info,
    execute: async () => ({
      kind: 'result',
      result: { outcome: 'COMPLETED', summary: '证据链完成' },
      sessionId: 'run-evidence-1',
      resolvedModel: 'gpt-5.6',
    }),
  }
  await startTask(store, fake, ctx(S.SUPERVISOR), { taskId })

  const row = store.latestExecution(taskId)!
  assert.equal(row.provider, 'spawn')
  assert.equal(row.provider_source, 'binding')
  assert.equal(row.requested_model, 'gpt-5.6')
  assert.equal(row.resolved_model, 'gpt-5.6')
  assert.equal(row.model_source, 'binding')
  assert.equal(row.executor_kind, 'dsh-subagent:spawn')
  assert.equal(row.worker_binding_id, 'b-worker')
  assert.ok(row.session_id, '实际 run/session id 必须记录')
  const snap = JSON.parse(row.execution_profile_json!)
  assert.equal(snap.source.provider, 'binding')
  assert.equal(snap.resolved.model, 'gpt-5.6')
  // 事件 payload 携带证据
  const events = store.listEvents(KID, 100)
  const started = events.find(e => e.event_type === 'WORKER_EXECUTION_STARTED')!
  const payload = JSON.parse(started.payload_json)
  assert.equal(payload.provider, 'spawn')
  assert.equal(payload.provider_source, 'binding')
  assert.equal(payload.requested_model, 'gpt-5.6')
  const submitted = events.find(e => e.event_type === 'WORKER_RESULT_SUBMITTED')!
  assert.equal(JSON.parse(submitted.payload_json).resolved_model, 'gpt-5.6')
})

test('startTask E3 场景：无 profile → global-fallback + parent-inherited 证据落库', async () => {
  const store = makeStore()
  seedTerritory(store)
  const planned = planTask(store, ctx(S.CHANCELLOR), { title: '回退任务' })
  const taskId = planned.task!.taskId
  assignTask(store, ctx(S.SUPERVISOR), { taskId })
  const fake: WorkerExecutor = {
    kind: 'dsh-subagent:spawn',
    info: { provider: 'spawn', providerSource: 'global-fallback', requestedModel: null, modelSource: 'parent-inherited' },
    execute: async () => ({
      kind: 'executor-failure', reason: 'fake 失败', sessionId: null, resolvedModel: 'deepseek-x',
    }),
  }
  await startTask(store, fake, ctx(S.SUPERVISOR), { taskId })
  const row = store.latestExecution(taskId)!
  assert.equal(row.provider_source, 'global-fallback')
  assert.equal(row.requested_model, null)
  assert.equal(row.model_source, 'parent-inherited')
  assert.equal(row.resolved_model, 'deepseek-x')
  const failed = store.listEvents(KID, 100).find(e => e.event_type === 'WORKER_EXECUTION_FAILED')!
  assert.equal(JSON.parse(failed.payload_json).resolved_model, 'deepseek-x')
})
