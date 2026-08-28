/**
 * dsh-kingdom — M2 Organization Scale（v0.7.0）验收测试。
 *
 * 覆盖 Owner Review 扩充的 Gate 项（lib 级）：
 * Topology（建删领地 Admin Plane）/ Scope（未指派 fail-closed / 跨领地 / 退任 / 接管）/
 * Ledger（one-active / REWORK 不新开 / HANDOFF 关旧开新 / terminal 关闭）/
 * Multi-Worker（0/1/N 规则）/ History（Retired/Deleted 可解析）/ Compatibility（backfill、单 Worker 兼容）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { KingdomStore } from '../lib/core/db.js'
import { bindRole, unbindRole, rebindSession, setExecutionProfile, type AdminAuth } from '../lib/core/binding.js'
import { issueOwnerControlCapability, ownerControlAuth } from '../lib/core/owner-control.js'
import { createTerritory, deleteTerritory, setTerritorySupervisor } from '../lib/core/territory.js'
import { planTask, assignTask, startTask, reviewTask } from '../lib/core/task-service.js'
import type { WorkerExecutor } from '../lib/worker/executor.js'

const KID = 'kingdom-m2-1'
const S = { OWNER: 's-owner', CHANCELLOR: 's-ch', SUP_A: 's-sup-a', SUP_B: 's-sup-b', WORKER: 's-w', STRANGER: 's-x' }
const ownerAuth = (): AdminAuth => ownerControlAuth(issueOwnerControlCapability())
const strangerAuth = (): AdminAuth => ({ mode: 'session-bound', principalSessionId: S.STRANGER })
const ctx = (sessionId: string | null) => ({
  kingdomId: KID,
  auth: { mode: 'session-bound' as const, trustLevel: 'session-verified' as const, note: '' },
  principal: sessionId ? { sessionId } : undefined,
})

let seq = 0
const bind = (store: KingdomStore, role: string, session: string | null, name?: string): string => {
  seq++
  const bindingId = `b-${role.toLowerCase()}-${seq}`
  store.insertBinding({
    binding_id: bindingId, kingdom_id: KID, role_type: role, role_name: name ?? `${role}-${seq}`,
    runtime_type: 'dsh', session_id: session, model_name: null, agent_name: null, session_meta: null,
    execution_profile_json: null, status: 'ACTIVE', retired_at: null, retired_reason: null,
    principal_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  })
  return bindingId
}

function makeOrg(): { store: KingdomStore; supA: string; supB: string; workerA: string; workerB: string; terrA: string; terrB: string } {
  const store = new KingdomStore(':memory:')
  store.insertKingdom({
    kingdom_id: KID, name: 'M2 王国', created_at: new Date().toISOString(),
    owner_id: 'o1', owner_name: 'Tester',
  })
  bind(store, 'OWNER', S.OWNER)
  bind(store, 'CHANCELLOR', S.CHANCELLOR)
  const supA = bind(store, 'SUPERVISOR', S.SUP_A, 'Sup-A')
  const supB = bind(store, 'SUPERVISOR', S.SUP_B, 'Sup-B')
  const workerA = bind(store, 'WORKER', S.WORKER, 'Worker-A')
  const workerB = bind(store, 'WORKER', S.WORKER, 'Worker-B')
  const terrA = randomUUID()
  const terrB = randomUUID()
  const now = new Date().toISOString()
  store.insertTerritory({
    territory_id: terrA, kingdom_id: KID, name: '领地A', workspace_path: null, summary: null,
    supervisor_binding_id: supA, status: 'ACTIVE', deleted_at: null, deleted_reason: null, created_at: now,
  })
  store.insertTerritory({
    territory_id: terrB, kingdom_id: KID, name: '领地B', workspace_path: null, summary: null,
    supervisor_binding_id: supB, status: 'ACTIVE', deleted_at: null, deleted_reason: null, created_at: now,
  })
  return { store, supA, supB, workerA, workerB, terrA, terrB }
}

function planIn(store: KingdomStore, terrId: string, title: string): string {
  const r = planTask(store, ctx(S.CHANCELLOR), { title, territoryId: terrId })
  assert.match(r.message, /^已创建任务/)
  return r.task!.taskId
}

const fakeExec = (): WorkerExecutor => ({
  kind: 'dsh-subagent:spawn',
  info: { provider: 'spawn', providerSource: 'global-fallback', requestedModel: null, modelSource: 'parent-inherited' },
  execute: async () => ({
    kind: 'result', result: { outcome: 'COMPLETED', summary: 'done' }, sessionId: 'run', resolvedModel: 'm',
  }),
})

// ── Topology Admin Plane ────────────────────────────────────────────

test('Topology：session-bound 下仅 OWNER 可建/删领地、设主理', () => {
  const { store, terrA } = makeOrg()
  const denied1 = createTerritory(store, { kingdomId: KID, name: 'X 领地' }, strangerAuth())
  assert.match(denied1, /^OWNER_CONTROL_REQUIRED:/)
  const denied2 = deleteTerritory(store, { kingdomId: KID, territoryId: terrA }, { mode: 'session-bound', principalSessionId: S.SUP_A })
  assert.match(denied2, /^OWNER_CONTROL_REQUIRED:/)
  const denied3 = setTerritorySupervisor(store, { kingdomId: KID, territoryId: terrA, supervisorBindingId: null }, { mode: 'session-bound', principalSessionId: S.SUP_A })
  assert.match(denied3, /^OWNER_CONTROL_REQUIRED:/)
  const ok = createTerritory(store, { kingdomId: KID, name: 'Owner 领地' }, ownerAuth())
  assert.match(ok, /^已创建领地/)
})

// ── Scope ──────────────────────────────────────────────────────────

test('Scope：未指派 Territory fail-closed；Supervisor A 不能治理 B；退任后立即 DENY；接管后 PASS', () => {
  const { store, supA, supB, workerA, terrA } = makeOrg()
  // 未指派领地：任何 Supervisor DENY
  const unassigned = randomUUID()
  const now = new Date().toISOString()
  store.insertTerritory({
    territory_id: unassigned, kingdom_id: KID, name: '无主领', workspace_path: null, summary: null,
    supervisor_binding_id: null, status: 'ACTIVE', deleted_at: null, deleted_reason: null, created_at: now,
  })
  const taskInUnassigned = planIn(store, unassigned, '无主任务')
  const deniedUnassigned = assignTask(store, ctx(S.SUP_A), { taskId: taskInUnassigned }).message
  assert.match(deniedUnassigned, /未指派主理 Supervisor/)

  // 跨领地：Sup-A 治理领地 B 的任务 → TASK_OUT_OF_SCOPE
  const taskB = planIn(store, store.listTerritories(KID).find(t => t.name === '领地B')!.territory_id, 'B 任务')
  const deniedCross = assignTask(store, ctx(S.SUP_A), { taskId: taskB, workerBindingId: workerA }).message
  assert.match(deniedCross, /超出当前 Supervisor 的治理范围/)

  // 领地 A：Sup-A 可派发（PASS）
  const taskA = planIn(store, terrA, 'A 任务')
  assert.match(assignTask(store, ctx(S.SUP_A), { taskId: taskA, workerBindingId: workerA }).message, /已把任务/)

  // Sup-A 退任 → Territory 指针不再指向有效 ACTIVE Supervisor，立即 DENY
  unbindRole(store, { kingdomId: KID, bindingId: supA, reason: '换届' }, ownerAuth())
  const deniedRetired = reviewTask(store, ctx(S.SUP_A), { taskId: taskA, decision: 'ACCEPT' }).message
  assert.match(deniedRetired, /未指派有效的 ACTIVE Supervisor/)

  // 新任 Sup-B 接管领地 A → PASS
  setTerritorySupervisor(store, { kingdomId: KID, territoryId: terrA, supervisorBindingId: supB }, ownerAuth())
  const taskA2 = planIn(store, terrA, 'A 任务 2')
  assert.match(assignTask(store, ctx(S.SUP_B), { taskId: taskA2, workerBindingId: workerA }).message, /已把任务/)
})

test('Scope：两个 ACTIVE Supervisor 时，Territory 指定的非首条 binding 可完成 assign/start/HANDOFF', async () => {
  const { store, supA, supB, workerA, workerB, terrB } = makeOrg()
  const activeSupervisors = store.getBindingsByRole(KID, 'SUPERVISOR')
  assert.equal(activeSupervisors[0]!.binding_id, supA, 'fixture 必须让 Sup-A 成为首条 ACTIVE binding')
  assert.equal(store.getTerritoryById(terrB)!.supervisor_binding_id, supB)

  const taskId = planIn(store, terrB, '非首条 Supervisor 正向任务')
  const assigned = assignTask(store, ctx(S.SUP_B), { taskId, workerBindingId: workerA })
  assert.equal(assigned.ok, true)
  assert.equal(store.getActiveAssignmentForTask(taskId)!.assigned_by, supB)

  const started = await startTask(store, fakeExec(), ctx(S.SUP_B), { taskId })
  assert.equal(started.ok, true)
  assert.equal(store.getTask(taskId)!.status, 'REVIEW')

  const handed = reviewTask(store, ctx(S.SUP_B), {
    taskId,
    decision: 'HANDOFF',
    reason: '验证 canonical Territory Supervisor',
    to_binding_id: workerB,
  })
  assert.equal(handed.ok, true)
  assert.equal(store.getActiveAssignmentForTask(taskId)!.assigned_by, supB)
  assert.equal(store.getActiveAssignmentForTask(taskId)!.worker_binding_id, workerB)
})

test('Scope：两个 ACTIVE Supervisor 时，首条但非 Territory 主理的 session 必须 zero-effect 拒绝', () => {
  const { store, supA, supB, workerA, terrB } = makeOrg()
  assert.equal(store.getBindingsByRole(KID, 'SUPERVISOR')[0]!.binding_id, supA)
  assert.equal(store.getTerritoryById(terrB)!.supervisor_binding_id, supB)

  const taskId = planIn(store, terrB, '非首条 Supervisor 反向任务')
  const taskBefore = { ...store.getTask(taskId)! }
  const revisionBefore = store.revision(KID)
  const denied = assignTask(store, ctx(S.SUP_A), { taskId, workerBindingId: workerA })

  assert.equal(denied.ok, false)
  assert.equal(denied.errorCode, 'TASK_OUT_OF_SCOPE')
  assert.deepEqual({ ...store.getTask(taskId)! }, taskBefore)
  assert.equal(store.getActiveAssignmentForTask(taskId), null)
  assert.equal(store.revision(KID), revisionBefore)
})

// ── Multi-Worker 选择规则 ───────────────────────────────────────────

test('Multi-Worker：0/1/N 规则 + WORKER_AMBIGUOUS + 显式永远按指定', async () => {
  const { store, supA, workerA, workerB, terrA } = makeOrg()
  // N>1 且省略 → AMBIGUOUS
  const t1 = planIn(store, terrA, '歧义任务')
  const ambiguous = assignTask(store, ctx(S.SUP_A), { taskId: t1 }).message
  assert.match(ambiguous, /必须显式指定 worker_binding_id/)
  // 显式 → 按指定
  const t2 = planIn(store, terrA, '显式任务')
  assert.match(assignTask(store, ctx(S.SUP_A), { taskId: t2, workerBindingId: workerB }).message, /Worker-B/)
  assert.equal(store.getTask(t2)!.assigned_binding_id, workerB)
  // 0 Worker：全部退任后 → MISSING
  const { store: s2, supA: supA2, workerA: wa, workerB: wb, terrA: ta } = makeOrg()
  unbindRole(s2, { kingdomId: KID, bindingId: wa, reason: 'r' }, ownerAuth())
  unbindRole(s2, { kingdomId: KID, bindingId: wb, reason: 'r' }, ownerAuth())
  const t3 = planIn(s2, ta, '无 Worker 任务')
  const missing = assignTask(s2, ctx(S.SUP_A), { taskId: t3, workerBindingId: supA2 }).message
  assert.match(missing, /不是 ACTIVE 的 WORKER/)
  // 1 Worker：省略 → 自动用唯一
  const { store: s3, supA: supA3, workerA: wa3, terrA: ta3 } = makeOrg()
  unbindRole(s3, { kingdomId: KID, bindingId: (() => { const all = s3.getBindingsByRole(KID, 'WORKER'); return all.find(b => b.binding_id !== wa3)!.binding_id })(), reason: 'r' }, ownerAuth())
  const t4 = planIn(s3, ta3, '单 Worker 任务')
  const auto = assignTask(s3, ctx(S.SUP_A), { taskId: t4 }).message
  assert.match(auto, /已把任务/)
  assert.equal(s3.getTask(t4)!.assigned_binding_id, wa3)
})

// ── Assignment Ledger ───────────────────────────────────────────────

test('Ledger：one-active 唯一索引；REWORK 不新开；HANDOFF 关旧开新；terminal 关闭', async () => {
  const { store, supA, workerA, workerB, terrA } = makeOrg()
  const t = planIn(store, terrA, 'Ledger 任务')
  assignTask(store, ctx(S.SUP_A), { taskId: t, workerBindingId: workerA })
  const a1 = store.getActiveAssignmentForTask(t)!
  assert.ok(a1)

  // REWORK：Assignment 保持 ACTIVE（不新开）
  await startTask(store, fakeExec(), ctx(S.SUP_A), { taskId: t })
  reviewTask(store, ctx(S.SUP_A), { taskId: t, decision: 'REWORK', reason: '再来' })
  assert.equal(store.getActiveAssignmentForTask(t)!.assignment_id, a1.assignment_id)
  assert.equal(store.listTaskAssignments(t).length, 1)

  // HANDOFF：关旧开新（previous 链）
  await startTask(store, fakeExec(), ctx(S.SUP_A), { taskId: t })
  const handed = reviewTask(store, ctx(S.SUP_A), { taskId: t, decision: 'HANDOFF', reason: '换人', to_binding_id: workerB })
  assert.match(handed.message, /已 HANDOFF/)
  const closed = store.getActiveAssignmentForTask(t)!
  assert.equal(closed.worker_binding_id, workerB)
  assert.equal(closed.previous_assignment_id, a1.assignment_id)
  const a1After = store.listTaskAssignments(t).find(x => x.assignment_id === a1.assignment_id)!
  assert.equal(a1After.ended_at !== null, true)
  assert.equal(a1After.end_reason, 'handoff')
  assert.equal(store.getTask(t)!.assigned_binding_id, workerB)
  assert.equal(store.listTaskAssignments(t).length, 2)

  // HANDOFF 目标 = 当前 Worker → 拒绝
  const t2 = planIn(store, terrA, '自转任务')
  assignTask(store, ctx(S.SUP_A), { taskId: t2, workerBindingId: workerA })
  await startTask(store, fakeExec(), ctx(S.SUP_A), { taskId: t2 })
  const selfHandoff = reviewTask(store, ctx(S.SUP_A), { taskId: t2, decision: 'HANDOFF', reason: 'x', to_binding_id: workerA }).message
  assert.match(selfHandoff, /不是转交/)

  // terminal（ACCEPT）关闭 active assignment
  const t3 = planIn(store, terrA, '终态任务')
  assignTask(store, ctx(S.SUP_A), { taskId: t3, workerBindingId: workerA })
  await startTask(store, fakeExec(), ctx(S.SUP_A), { taskId: t3 })
  reviewTask(store, ctx(S.SUP_A), { taskId: t3, decision: 'ACCEPT' })
  assert.equal(store.getActiveAssignmentForTask(t3), null)
  const closedT3 = store.listTaskAssignments(t3).find(x => x.assignment_id === a1.assignment_id) ?? store.listTaskAssignments(t3)[0]!
  assert.equal(closedT3.end_reason, 'task-terminal')
})

// ── History ─────────────────────────────────────────────────────────

test('History：Retired Worker/Binding 与 Deleted Territory 历史可解析', () => {
  const { store, workerA, terrA } = makeOrg()
  unbindRole(store, { kingdomId: KID, bindingId: workerA, reason: '退任' }, ownerAuth())
  const retired = store.getBindingById(workerA)!
  assert.equal(retired.status, 'RETIRED')
  assert.equal(retired.retired_reason, '退任')
  assert.ok(retired.retired_at)
  // Retired 不再出现在 ACTIVE 查询
  assert.equal(store.getBindingsByRole(KID, 'WORKER').some(b => b.binding_id === workerA), false)
  // Deleted Territory 历史解析
  deleteTerritory(store, { kingdomId: KID, territoryId: terrA }, ownerAuth())
  const tomb = store.getTerritoryById(terrA)!
  assert.equal(tomb.status, 'DELETED')
  assert.ok(tomb.deleted_at)
  assert.equal(store.listTerritories(KID).some(t => t.territory_id === terrA), false)
})

// ── Compatibility ───────────────────────────────────────────────────

test('Compatibility：v3 backfill（单 Supervisor 接管 NULL scope 领地）+ 单 Worker 兼容', () => {
  const { store, supA, workerA, terrA } = makeOrg()
  // 未指派领地 backfill 语义：手动设 NULL 再指派（模拟 v2 库迁移结果由 ensureSchemaV3 完成，
  // 这里验证 setTerritorySupervisor 与 fail-closed 语义）
  store.updateTerritorySupervisor(terrA, null)
  const t = planIn(store, terrA, '无主任务')
  assert.match(assignTask(store, ctx(S.SUP_A), { taskId: t, workerBindingId: workerA }).message, /未指派主理 Supervisor/)
  setTerritorySupervisor(store, { kingdomId: KID, territoryId: terrA, supervisorBindingId: supA }, ownerAuth())
  assert.match(assignTask(store, ctx(S.SUP_A), { taskId: t, workerBindingId: workerA }).message, /已把任务/)
})
