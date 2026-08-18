/**
 * dsh-kingdom — M1-B Security Closure（v0.5.2）治理测试。
 *
 * 覆盖：
 * - Trusted Admin Plane：session-bound 下 bind/unbind/bind_session 仅 OWNER 会话可执行；
 * - 管理事件 actor 修正（actor=实际操作者 OWNER，target=被操作绑定）；
 * - GUI 写命令守卫 guiWriteGuard（session-bound fail-closed）；
 * - BindingView 会话标识脱敏（sessionDisplay，完整 id 不出普通快照）。
 *
 * 运行：先构建 lib（tsc -p tsconfig.json），再 `node --test tests/*.test.ts`。
 * 隔离：全部使用 `:memory:` 内存库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { KingdomStore } from '../lib/core/db.js'
import { bindRole, rebindSession, unbindRole, type AdminAuth } from '../lib/core/binding.js'
import { toBindingView } from '../lib/gui/snapshot.js'
import { guiWriteGuard } from '../lib/gui/contract.js'

const KID = 'kingdom-governance-1'
const OWNER_SESSION = 'session-owner-real'
const OTHER_SESSION = 'session-stranger'

function makeStore(withOwnerSession = true): KingdomStore {
  const store = new KingdomStore(':memory:')
  store.insertKingdom({
    kingdom_id: KID,
    name: '治理测试王国',
    created_at: new Date().toISOString(),
    owner_id: 'owner-1',
    owner_name: 'Tester',
  })
  store.insertBinding({
    binding_id: 'binding-owner',
    kingdom_id: KID,
    role_type: 'OWNER',
    role_name: 'Owner-Tester',
    runtime_type: 'dsh',
    session_id: withOwnerSession ? OWNER_SESSION : null,
    model_name: null,
    agent_name: null,
    session_meta: null,
    principal_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })
  return store
}

const boundAuth = (sessionId: string): AdminAuth => ({ mode: 'session-bound', principalSessionId: sessionId })
const noAuth = (): AdminAuth => ({ mode: 'session-bound', principalSessionId: null })
const declarative = (): AdminAuth => ({ mode: 'declarative', principalSessionId: OTHER_SESSION })

test('管理面授权：session-bound 下非 OWNER 会话不能任命/改绑/解绑', () => {
  const store = makeStore()
  const denied1 = bindRole(store, { kingdomId: KID, roleType: 'CHANCELLOR', roleName: 'C1' }, boundAuth(OTHER_SESSION))
  assert.match(denied1, /^错误：组织管理（任命\/罢免\/改绑）只有 OWNER 会话可以执行/)
  const denied2 = bindRole(store, { kingdomId: KID, roleType: 'CHANCELLOR', roleName: 'C2' }, noAuth())
  assert.match(denied2, /^错误：组织管理/)
  // 无绑定存在时也应被拦（在任命 CHANCELLOR 之前已拒绝，故无 CHANCELLOR 可解绑/改绑）
  assert.equal(store.getBindingByRole(KID, 'CHANCELLOR'), null)
})

test('管理面授权：session-bound 下 OWNER 会话可任命，事件 actor 记 OWNER', () => {
  const store = makeStore()
  const ok = bindRole(store, { kingdomId: KID, roleType: 'CHANCELLOR', roleName: 'C1' }, boundAuth(OWNER_SESSION))
  assert.match(ok, /^已绑定角色 CHANCELLOR/)
  const event = store.listEvents(KID, 50).find(e => e.event_type === 'ROLE_BOUND')!
  assert.equal(event.actor_role, 'OWNER')
  assert.equal(event.actor_id, 'binding-owner')
  assert.equal(event.target_type, 'binding')
  assert.equal(JSON.parse(event.payload_json).role_type, 'CHANCELLOR')
})

test('管理面授权：OWNER 未绑会话时 session-bound 下管理操作 fail-closed', () => {
  const store = makeStore(false) // OWNER 无 session
  const denied = bindRole(store, { kingdomId: KID, roleType: 'CHANCELLOR', roleName: 'C1' }, boundAuth(OWNER_SESSION))
  assert.match(denied, /OWNER 绑定未关联会话/)
})

test('管理面授权：declarative 演示模式保持现状（本地可信演示）', () => {
  const store = makeStore()
  const ok = bindRole(store, { kingdomId: KID, roleType: 'CHANCELLOR', roleName: 'C1' }, declarative())
  assert.match(ok, /^已绑定角色 CHANCELLOR/)
  // declarative 无可信 principal：事件 actor 保留被操作角色兼容标注
  const event = store.listEvents(KID, 50).find(e => e.event_type === 'ROLE_BOUND')!
  assert.equal(event.actor_role, 'CHANCELLOR')
  // 改绑/解绑同样保持可用
  const rebind = rebindSession(store, { kingdomId: KID, roleType: 'CHANCELLOR', sessionId: 's2' }, declarative())
  assert.match(rebind, /^角色 CHANCELLOR/)
  const unbind = unbindRole(store, { kingdomId: KID, roleType: 'CHANCELLOR' }, declarative())
  assert.match(unbind, /^角色 CHANCELLOR.*已退任/)
})

test('管理面授权：session-bound 下 OWNER 解绑/改绑，事件 actor 记 OWNER', () => {
  const store = makeStore()
  bindRole(store, { kingdomId: KID, roleType: 'WORKER', roleName: 'W1' }, boundAuth(OWNER_SESSION))
  const workerBindingId = store.getBindingByRole(KID, 'WORKER')!.binding_id
  const rebind = rebindSession(store, { kingdomId: KID, roleType: 'WORKER', sessionId: 'worker-session' }, boundAuth(OWNER_SESSION))
  assert.match(rebind, /^角色 WORKER/)
  const e1 = store.listEvents(KID, 50).find(e => e.event_type === 'BINDING_PROFILE_UPDATED')!
  assert.equal(e1.actor_role, 'OWNER')
  assert.equal(e1.actor_id, 'binding-owner')
  assert.equal(e1.target_id, workerBindingId)
  const unbind = unbindRole(store, { kingdomId: KID, roleType: 'WORKER', reason: '换届' }, boundAuth(OWNER_SESSION))
  assert.match(unbind, /^角色 WORKER.*已退任/)
  const e2 = store.listEvents(KID, 50).find(e => e.event_type === 'ROLE_UNBOUND')!
  assert.equal(e2.actor_role, 'OWNER')
  assert.equal(e2.actor_id, 'binding-owner')
  assert.equal(e2.target_id, workerBindingId)
  // v0.7.0 tombstone：绑定行保留为 RETIRED，历史可解析
  const retired = store.getBindingById(workerBindingId)!
  assert.equal(retired.status, 'RETIRED')
  assert.ok(retired.retired_at)
})

test('GUI 写命令守卫：session-bound fail-closed，declarative 放行', () => {
  assert.deepEqual(guiWriteGuard('declarative'), { allowed: true })
  assert.deepEqual(guiWriteGuard('session-bound'), { allowed: false, code: 'SESSION_AUTH_REQUIRED' })
})

test('BindingView 脱敏：完整 session id 不出普通快照', () => {
  const store = makeStore()
  const row = store.getBindingById('binding-owner')!
  const view = toBindingView(row)
  assert.equal(view.sessionBound, true)
  assert.equal(view.sessionDisplay, `…${OWNER_SESSION.slice(-8)}`)
  assert.ok(!('sessionId' in view), 'BindingView 不得包含完整 sessionId 字段')
  // 未绑定会话
  const bare = store.getBindingById('binding-owner')!
  const nullView = toBindingView({ ...bare, session_id: null })
  assert.equal(nullView.sessionBound, false)
  assert.equal(nullView.sessionDisplay, null)
})
