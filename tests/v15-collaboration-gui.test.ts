import test from 'node:test'
import assert from 'node:assert/strict'
import { KingdomStore } from '../lib/core/db.js'
import { initializeKingdomFacts } from '../lib/core/kingdom.js'
import { bindRole } from '../lib/core/binding.js'
import { assignTask } from '../lib/core/task-service.js'
import { issueOwnerControlCapability, ownerControlAuth } from '../lib/core/owner-control.js'
import { proposeCollaborationPlan, adoptCollaborationPlan, type ProposeCollaborationPlanInput } from '../lib/core/collaboration.js'
import { reserveWorkspaceAdmission, finishWorkspaceAdmissionInvocation } from '../lib/core/workspace-admission.js'
import { buildSnapshot } from '../lib/gui/snapshot.js'
import { WORKBENCH_SCRIPT } from '../lib/gui/workbench-ui.js'
import { renderOwnerApp } from '../lib/gui/owner-ui.js'
import type { WorkbenchCollaborationView } from '../lib/gui/contract.js'

const NOW = '2026-09-12T18:00:00.000Z'
const auth = { mode: 'session-bound' as const, trustLevel: 'session-verified' as const, note: 'fixture' }
function setup(t: { after(fn: () => void): void }) {
  const store = new KingdomStore(':memory:')
  const { kingdomId } = store.withImmediateTransaction(() => initializeKingdomFacts(store, '协作界面验证', '人类'))
  const owner = ownerControlAuth(issueOwnerControlCapability())
  bindRole(store, { kingdomId, roleType: 'CHANCELLOR', roleName: '宰相', sessionId: 'private-chancellor-session' }, owner)
  bindRole(store, { kingdomId, roleType: 'SUPERVISOR', roleName: '主管', sessionId: 'private-supervisor-session' }, owner)
  for (const name of ['主整合者', '只读检查者', '执行者']) bindRole(store, { kingdomId, roleType: 'WORKER', roleName: name }, owner)
  const workers = store.getBindingsByRole(kingdomId, 'WORKER').map(item => item.binding_id)
  store.insertTerritory({ territory_id: 'territory', kingdom_id: kingdomId, name: '产品领地', workspace_path: process.cwd(), summary: null,
    supervisor_binding_id: store.getBindingByRole(kingdomId, 'SUPERVISOR')!.binding_id, status: 'ACTIVE', deleted_at: null, deleted_reason: null, created_at: NOW })
  const parent = (id: string) => store.insertTask({ task_id: id, territory_id: 'territory', parent_task_id: null, title: '清楚的整体目标 ' + id,
    description: '最终整合', assigned_binding_id: null, status: 'CREATED', acceptance_criteria: '父任务需实际整合并审查', result_summary: null, created_at: NOW, updated_at: NOW })
  parent('parent')
  const input: ProposeCollaborationPlanInput = { parentTaskId: 'parent', mode: 'TEAM', reason: '独立检查后整合，减少手工搬运',
    integratorBindingId: workers[0]!, budgetTokens: 1000, reserveTokens: 100, items: [
      { key: 'inspect', title: '检查材料', description: '只读核对已有来源', acceptanceCriteria: '每个判断有证据', territoryId: 'territory',
        workerBindingId: workers[1]!, access: 'READ_ONLY', dependsOn: [], expectedArtifact: '检查结果' },
      { key: 'apply', title: '应用结果', description: '根据已接受检查进行修改', acceptanceCriteria: '结果可以核验', territoryId: 'territory',
        workerBindingId: workers[2]!, access: 'WRITE', dependsOn: ['inspect'], expectedArtifact: '修改产物' },
    ] }
  const propose = (id = 'parent') => proposeCollaborationPlan(store, { kingdomId, principal: { sessionId: 'private-chancellor-session' }, auth }, { ...input, parentTaskId: id })
  const read = () => buildSnapshot(store, { auth }).projection.workbench.data
  const adopt = (plan: ReturnType<typeof propose>) => adoptCollaborationPlan(store, { kingdomId, plan_id: plan.planId, version: plan.version, digest: plan.digest }, owner)
  t.after(() => store.close())
  return { store, kingdomId, workers, parent, input, propose, read, adopt }
}

test('collaboration projection is read-only and distinguishes one plan adoption from dependency readiness and parent integration', t => {
  const f = setup(t), plan = f.propose(), before = { revision: f.store.eventSequence(), tasks: f.store.listTasks(f.kingdomId), leases: f.store.listLeases(f.kingdomId) }
  const proposed = f.read()
  assert.deepEqual({ revision: f.store.eventSequence(), tasks: f.store.listTasks(f.kingdomId), leases: f.store.listLeases(f.kingdomId) }, before)
  assert.equal(proposed.ownerActions.items.filter(item => item.kind === 'PLAN_ADOPTION').length, 1)
  const first = proposed.collaboration.plans.items[0]!
  assert.equal(first.state, 'PROPOSED'); assert.equal(first.version, plan.version); assert.equal(first.digest, plan.digest)
  assert.equal(first.items[0]!.status, 'NOT_CREATED'); assert.equal(first.budget, null)
  assert.equal(first.integration?.reasonCode, 'PLAN_NOT_ADOPTED')
  f.adopt(plan)
  const adopted = f.read(), current = adopted.collaboration.plans.items[0]!
  assert.equal(current.state, 'ADOPTED')
  assert.equal(adopted.ownerActions.items.filter(item => item.kind === 'PLAN_ADOPTION').length, 0)
  assert.equal(current.items[0]!.readiness?.ready, true)
  assert.equal(current.items[1]!.readiness?.reasonCode, 'DEPENDENCY_NOT_ACCEPTED_OR_STALE')
  assert.deepEqual(current.items[1]!.readiness?.blockingTaskIds, [plan.items[0]!.taskId])
  assert.equal(current.integration?.ready, false)
  assert.equal(current.parentStatus, 'CREATED')
  assert.equal(current.budget?.scope, 'PLAN_WITH_KINGDOM_COORDINATION_UPPER_BOUND')
  assert.equal(current.budget?.amount, null)
  const raw = JSON.stringify(adopted.collaboration)
  for (const secret of [process.cwd(), 'private-chancellor-session', 'private-supervisor-session', 'contextDigest', 'workspaceKey', 'runtimeInstanceRef']) assert.equal(raw.includes(secret), false)
})

test('collaboration resource projection exposes actual held task reservations without paths or invented queue status', t => {
  const f = setup(t), plan = f.propose(); f.adopt(plan)
  assert.equal(assignTask(f.store, { kingdomId: f.kingdomId, principal: { sessionId: 'private-supervisor-session' }, auth },
    { taskId: plan.items[0]!.taskId, workerBindingId: f.workers[1]! }).ok, true)
  const handle = reserveWorkspaceAdmission(f.store, { kingdomId: f.kingdomId, taskId: plan.items[0]!.taskId, attemptNo: 1,
    workerBindingId: f.workers[1]!, workspacePath: process.cwd(), access: 'READ_ONLY' })
  try {
    const before = f.store.eventSequence(), view = f.read().collaboration
    assert.equal(f.store.eventSequence(), before)
    assert.deepEqual(view.resources.items, [{ taskId: plan.items[0]!.taskId, attemptNo: 1, access: 'READ_ONLY', state: 'RESERVED', recovery: false }])
    assert.equal(Object.hasOwn(view.plans.items[0]!.items[1]!, 'queued'), false)
    assert.equal(JSON.stringify(view.resources).includes(process.cwd()), false)
  } finally { finishWorkspaceAdmissionInvocation(handle) }
})

test('collaboration plan display is bounded without turning omitted plans into a complete list', t => {
  const f = setup(t); f.propose()
  for (let i = 1; i < 41; i++) { const id = 'parent-' + i; f.parent(id); f.propose(id) }
  const data = f.read(), result = data.collaboration.plans
  assert.equal(result.totalCount, 41); assert.equal(result.items.length, 40); assert.equal(result.truncated, true)
  assert.equal(data.ownerActions.totalCount, 41); assert.equal(data.ownerActions.truncated, true)
})

class ViewNode {
  children: ViewNode[] = []; textContent = ''; className = ''; attributes: Record<string, string> = {}; href = ''
  tagName: string
  constructor(tagName: string) { this.tagName = tagName }
  append(...values: ViewNode[]) { this.children.push(...values) }
  replaceChildren(...values: ViewNode[]) { this.children = values }
  setAttribute(name: string, value: string) { this.attributes[name] = value }
  set innerHTML(_value: string) { throw new Error('Runtime plan values must remain text') }
}
const textOf = (node: ViewNode): string => [node.textContent, ...node.children.map(textOf)].join('\n')
function render(view: WorkbenchCollaborationView | undefined) {
  const nodes = new Map<string, ViewNode>(['collaboration-plans', 'collaboration-resources'].map(id => [id, new ViewNode('div')]))
  const append = (parent: ViewNode, tag: string, value: unknown, className = '') => { const node = new ViewNode(tag); node.textContent = String(value ?? ''); node.className = className; parent.append(node); return node }
  const env = { record: (value: unknown) => value && typeof value === 'object' ? value : {}, clear: (id: string) => nodes.get(id),
    queueItems: (queue: { items?: unknown[] } | undefined) => queue?.items ?? [], friendly: (value: unknown, fallback: unknown) => value === null || value === undefined || value === '' ? fallback : String(value),
    append, addEmpty: (parent: ViewNode, value: string) => append(parent, 'p', value),
    addDataRow: (parent: ViewNode, label: string, value: unknown) => append(parent, 'p', label + '：' + value),
    addTaskLink: (parent: ViewNode, _taskId: string | null, label: string) => append(parent, 'a', label), document: { createElement: (tag: string) => new ViewNode(tag) } }
  const start = WORKBENCH_SCRIPT.indexOf('    const renderCollaboration ='), end = WORKBENCH_SCRIPT.indexOf('    const renderAdditionalRoleCost =', start)
  assert.ok(start >= 0 && end > start)
  new Function('env', 'value', 'const {' + Object.keys(env).join(',') + '}=env;\n' + WORKBENCH_SCRIPT.slice(start, end) + '\nrenderCollaboration(value);')(env, view)
  return { nodes, text: [...nodes.values()].map(textOf).join('\n') }
}

test('collaboration display separates accepted results, estimated coordination exposure and resource uncertainty without executable controls', t => {
  const f = setup(t), plan = f.propose(); f.adopt(plan)
  const view = f.read().collaboration, current = view.plans.items[0]!
  current.reason = '<img src=x onerror=alert(1)>'
  current.budget!.state = 'BLOCK_UNKNOWN'; current.budget!.unknownUnits = 2; current.budget!.coordinationUpperBoundTokens = 120
  const output = render(view)
  assert.match(output.text, /<img src=x onerror=alert\(1\)>/u)
  assert.match(output.text, /前置结果尚未接受或已过期/u)
  assert.match(output.text, /存在未确认成本，停止新增工作/u)
  assert.match(output.text, /同期王国协调成本上界 Token：120/u)
  assert.match(output.text, /不表示工作区空闲，也没有自动排队派发/u)
  assert.match(output.text, /不会自动完成父任务/u)
  assert.match(output.text, /金额未知/u)
  const tags = (node: ViewNode): string[] => [node.tagName, ...node.children.flatMap(tags)]
  assert.equal([...output.nodes.values()].flatMap(tags).includes('button'), false)
  assert.match(render(undefined).text, /尚未提供协作投影/u)
})

test('Owner plan adoption sends only the exact catalog plan version and digest and rejects stale or altered references', t => {
  const f = setup(t), plan = f.propose(), html = renderOwnerApp('collaboration-gui-nonce-123456789')
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(html)![1]
  const start = script.indexOf('  function payload()'), end = script.indexOf('  async function request(', start)
  const values = { plan_id: plan.planId, version: String(plan.version), digest: plan.digest, owner: 'injected' }
  const fields = new Map(Object.entries(values).map(([name, value]) => [name, { name, value, disabled: false }]))
  const el = (id: string) => id === 'action' ? { value: 'plan.adopt' } : { querySelectorAll: () => [...fields.values()] }
  const state = { control: { catalog: { plans: [structuredClone(plan)] } } }
  const payload = new Function('el', 'state', script.slice(start, end) + ';return payload;')(el, state)
  assert.deepEqual(payload(), { action: 'plan.adopt', parameters: { plan_id: plan.planId, version: plan.version, digest: plan.digest } })
  fields.get('version')!.value = '2'; assert.throws(payload, /版本或内容指纹/u)
  fields.get('version')!.value = String(plan.version); fields.get('digest')!.value = 'changed'; assert.throws(payload, /版本或内容指纹/u)
  fields.get('digest')!.value = plan.digest; state.control.catalog.plans[0]!.state = 'STALE'; assert.throws(payload, /版本或内容指纹/u)
  state.control.catalog.plans = []; assert.throws(payload, /当前范围内/u)
  assert.match(html, /version\.readOnly=true/u); assert.match(html, /digest\.readOnly=true/u)
  assert.match(html, /plan-adoption-review/u); assert.match(html, /此采纳不代表产物验收/u)
})
