import test from 'node:test'
import assert from 'node:assert/strict'
import { KingdomStore } from '../lib/core/db.js'
import { recordRoleUsage, recordPromptCost, type RoleUsageObservation } from '../lib/core/cost.js'
import { buildSnapshot, buildTaskDetail } from '../lib/gui/snapshot.js'
import { WORKBENCH_SCRIPT } from '../lib/gui/workbench-ui.js'
import { renderOwnerApp } from '../lib/gui/owner-ui.js'
import type { WorkbenchCostSummary } from '../lib/gui/contract.js'

const now = '2026-09-12T14:00:00.000Z'
const kingdomId = 'cost-gui-kingdom'
const auth = { mode: 'session-bound' as const, trustLevel: 'session-verified' as const, note: '' }

function setup() {
  const store = new KingdomStore(':memory:')
  store.insertKingdom({ kingdom_id: kingdomId, name: '成本投影验证', owner_id: 'owner', owner_name: '用户', created_at: now })
  for (const role of ['CHANCELLOR', 'SUPERVISOR']) store.insertBinding({ binding_id: role, kingdom_id: kingdomId, role_type: role, role_name: role,
    runtime_type: 'dsh', session_id: 'sensitive-runtime-session', model_name: null, agent_name: null, session_meta: null, execution_profile_json: null,
    status: 'ACTIVE', retired_at: null, retired_reason: null, principal_id: null, created_at: now, updated_at: now })
  store.insertTerritory({ territory_id: 'territory', kingdom_id: kingdomId, name: '工作领地', workspace_path: null, summary: null,
    supervisor_binding_id: 'SUPERVISOR', status: 'ACTIVE', deleted_at: null, deleted_reason: null, created_at: now })
  for (const id of ['task-a', 'task-b']) store.insertTask({ task_id: id, territory_id: 'territory', parent_task_id: null, title: id, description: '',
    assigned_binding_id: null, status: 'CREATED', acceptance_criteria: '', result_summary: null, created_at: now, updated_at: now })
  return store
}

function observation(id: string, taskIds: string[], total: number | null): RoleUsageObservation {
  return { type: 'KingdomRoleUsage/v1', source: 'provider-reported', sourceUnitRef: id,
    runtimeInstanceRef: 'sensitive-runtime-instance', sessionRef: 'sensitive-runtime-session', bindingId: 'SUPERVISOR', roleType: 'SUPERVISOR',
    taskIds, attribution: taskIds.length === 1 ? 'TASK' : taskIds.length > 1 ? 'SHARED' : 'UNATTRIBUTED', startedAt: now, startedLedgerSeq: 0,
    observationSequence: 1, status: total === null ? 'IN_PROGRESS' : 'COMPLETE', reasonCode: null, observedRequests: 1, reportedRequests: total === null ? 0 : 1,
    usage: total === null ? null : { uncachedInputTokens: total - 5, outputTokens: 5, totalTokens: total } }
}

test('cost projection keeps Worker totals separate and does not allocate shared usage into a task', () => {
  const store = setup()
  try {
    for (const [id, tasks, tokens] of [['one', ['task-a'], 30], ['shared', ['task-a', 'task-b'], 20], ['unassigned', [], 40], ['pending', [], null]] as const) {
      assert.equal(recordRoleUsage(store, kingdomId, observation(id, [...tasks], tokens)), true)
    }
    const workbench = buildSnapshot(store, { auth, costRuntime: { toolDisclosureMode: 'off', observerAvailable: true } }).projection.workbench.data
    assert.equal(workbench.usage.scope, 'WORKER_DISPATCH_ONLY')
    assert.equal(workbench.usage.reportedTotals, null)
    assert.equal(workbench.cost.additionalRoles?.verifiedTokens, 90)
    assert.equal(workbench.cost.additionalRoles?.pendingUnits, 1)
    assert.equal(workbench.cost.additionalRoles?.attributionGapCount, 3)
    assert.equal(workbench.cost.additionalRoles?.amount, null)
    assert.equal(buildTaskDetail(store, kingdomId, 'task-a')?.additionalRoleCost?.verifiedTokens, 30)
    assert.equal(buildTaskDetail(store, kingdomId, 'task-b')?.additionalRoleCost?.verifiedTokens, null)
    assert.equal(JSON.stringify(workbench.cost).includes('sensitive-runtime'), false)
  } finally { store.close() }
})

test('cost projection exposes actual runtime mode and bounded assembly bytes without prompt text or invented history tokens', () => {
  const store = setup()
  try {
    recordPromptCost(store, kingdomId, { type: 'KingdomPromptCost/v1', source: 'assembly-byte-observation', sourceUnitRef: 'secret-runtime-reference',
      bindingId: 'SUPERVISOR', roleType: 'SUPERVISOR', toolsBefore: 30, toolsAfter: 4, toolsBytesBefore: 4000, toolsBytesAfter: 700,
      sections: Array.from({ length: 25 }, (_, i) => ({ name: i ? 'section-' + i : 'secret=do-not-leak', bytes: 60 })),
      contexts: [{ name: 'workspace', bytes: 120 }], historyBytes: null, tokenEstimate: null, mode: 'pilot', reasonCode: null })
    const unknown = buildSnapshot(store, { auth }).projection.workbench.data.cost
    assert.deepEqual(unknown.runtime, { toolDisclosureMode: 'UNKNOWN', observerAvailable: null })
    const cost = buildSnapshot(store, { auth, costRuntime: { toolDisclosureMode: 'off', observerAvailable: false } }).projection.workbench.data.cost
    assert.equal(cost.runtime.toolDisclosureMode, 'off')
    assert.equal(cost.runtime.observerAvailable, false)
    const prompt = cost.prompts.items[0]!
    assert.equal(prompt.mode, 'pilot', 'a historic observation must not become the current runtime mode')
    assert.equal(prompt.historyBytes, null)
    assert.equal(prompt.tokenEstimate, null)
    assert.equal(prompt.toolsBytesAfter, 700)
    assert.equal(prompt.sections.length, 24)
    assert.equal(prompt.partsTruncated, true)
    assert.equal(JSON.stringify(cost).includes('do-not-leak'), false)
    assert.equal(JSON.stringify(cost).includes('secret-runtime-reference'), false)
  } finally { store.close() }
})

class ViewNode {
  children: ViewNode[] = []; textContent = ''; className = ''; attributes: Record<string, string> = {}
  readonly tagName: string
  constructor(tagName: string) { this.tagName = tagName }
  append(...nodes: ViewNode[]) { this.children.push(...nodes) }
  setAttribute(key: string, value: string) { this.attributes[key] = value }
  set innerHTML(_value: string) { throw new Error('cost content must use text nodes') }
}
const textOf = (node: ViewNode): string => [node.textContent, ...node.children.map(textOf)].join('\n')

function renderCost(cost: WorkbenchCostSummary | undefined) {
  const nodes = new Map<string, ViewNode>()
  const append = (parent: ViewNode, tag: string, text: unknown, className = '') => { const node = new ViewNode(tag); node.textContent = String(text); node.className = className; parent.append(node); return node }
  const clear = (id: string) => { const node = new ViewNode('div'); nodes.set(id, node); return node }
  const friendly = (value: unknown, fallback: string) => value === undefined || value === null || value === '' ? fallback : String(value)
  const env = { clear, append, record: (value: unknown) => value && typeof value === 'object' ? value : {}, friendly,
    addEmpty: (parent: ViewNode, text: string) => append(parent, 'p', text),
    addDataRow: (parent: ViewNode, label: string, value: unknown) => append(parent, 'p', label + '：' + value),
    document: { createElement: (tag: string) => new ViewNode(tag) } }
  const start = WORKBENCH_SCRIPT.indexOf('    const renderAdditionalRoleCost =')
  const end = WORKBENCH_SCRIPT.indexOf('    const renderWorkbenchUsage =', start)
  assert.ok(start >= 0 && end > start)
  new Function('env', 'cost', 'const {' + Object.keys(env).join(',') + '}=env;\n' + WORKBENCH_SCRIPT.slice(start, end) + '\nrenderBudgetCost(cost);')(env, cost)
  return [...nodes.values()].map(textOf).join('\n')
}

test('cost page distinguishes reports, estimates, missing observations and pilot status without claiming savings', () => {
  const store = setup()
  try {
    const cost = buildSnapshot(store, { auth, costRuntime: { toolDisclosureMode: 'pilot', observerAvailable: true } }).projection.workbench.data.cost
    cost.budget = { type: 'KingdomBudgetView/v1', scope: 'KINGDOM', coverage: 'OBSERVABLE_ONLY', policy: null, state: 'BLOCK_UNKNOWN',
      verifiedTokens: 100, workerVerifiedTokens: 75, additionalVerifiedTokens: 25, reservedEstimateTokens: 200, exposureTokens: 300, remainingTokens: 50,
      pendingUnits: 2, unknownUnits: 1, recoveryUnits: 1, attributionGapCount: 3, amount: null, amountStatus: 'UNKNOWN', note: '只覆盖已观测部分。' }
    const rendered = renderCost(cost)
    assert.match(rendered, /存在未确认用量，阻止新增执行/u)
    assert.match(rendered, /周期内可核对实报 Token：100/u)
    assert.match(rendered, /已预留估计 Token：200/u)
    assert.match(rendered, /有限试点已开启/u)
    assert.match(rendered, /不宣称节省比例/u)
    assert.match(rendered, /金额未知/u)
    assert.match(rendered, /历史消息字节与 Token 估算未测/u)
    assert.match(renderCost(undefined), /当前没有可读取的预算视图/u)
    assert.match(renderCost(undefined), /接入状态未知/u)
  } finally { store.close() }
})

test('Owner budget form sends typed numbers and booleans and rejects fractional or missing quota values', () => {
  const html = renderOwnerApp('owner-cost-test-nonce-1234567')
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(html)![1]
  const start = script.indexOf('  function payload()')
  const end = script.indexOf('  async function request(', start)
  const fields = new Map<string, { name: string; value: string; disabled: boolean }>(Object.entries({ enabled: 'false', limit_tokens: '1000', reserve_tokens: '250', unknown_policy: 'BLOCK', warning_percent: '80' }).map(([name, value]) => [name, { name, value, disabled: false }]))
  const el = (id: string) => id === 'action' ? { value: 'budget.policy' } : { querySelectorAll: () => [...fields.values()] }
  const payload = new Function('el', script.slice(start, end) + ';return payload;')(el)
  assert.deepEqual(payload(), { action: 'budget.policy', parameters: { enabled: false, limit_tokens: 1000, reserve_tokens: 250, warning_percent: 80, unknown_policy: 'BLOCK' } })
  fields.get('limit_tokens')!.value = '1.5'
  assert.throws(payload, /正整数/u)
  fields.get('limit_tokens')!.value = ''
  assert.throws(payload, /正整数/u)
  fields.get('limit_tokens')!.value = '100'
  assert.throws(payload, /预留不能超过/u)
  assert.match(html, /关闭不重置统计起点/u)
  assert.match(html, /不是费用硬上限/u)
})
