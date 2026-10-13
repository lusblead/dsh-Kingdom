import assert from 'node:assert/strict'
import test from 'node:test'
import { WORKBENCH_HTML, WORKBENCH_SCRIPT } from '../lib/gui/workbench-ui.js'

class NodeView {
  id = ''; tagName: string; textContent = ''; className = ''; value = ''; hidden = false; open = false; disabled = false
  children: NodeView[] = []; parentElement: NodeView | null = null; attributes: Record<string, string> = {}
  onclick: (() => void) | null = null; listeners = new Map<string, (event: any) => void>()
  style = { minHeight: '', setProperty() {} }; owner: any
  constructor(tag = 'div') { this.tagName = tag }
  append(...nodes: NodeView[]) { nodes.forEach(node => { node.remove(); node.parentElement = this; node.owner = this.owner; this.children.push(node) }) }
  replaceChildren(...nodes: NodeView[]) { this.children.forEach(node => { node.parentElement = null }); this.children = []; this.append(...nodes) }
  remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null } }
  setAttribute(name: string, value: string) { this.attributes[name] = String(value) }
  getAttribute(name: string) { return this.attributes[name] ?? null }
  get classList() { return { add: (name: string) => { this.className += ' ' + name } } }
  addEventListener(name: string, listener: (event: any) => void) { this.listeners.set(name, listener) }
  matches(selector: string): boolean { return selector.startsWith('.') ? this.className.split(/\s/u).includes(selector.slice(1)) : selector.startsWith('[') ? this.getAttribute(selector.slice(1, -1)) !== null : this.tagName === selector }
  descendants(): NodeView[] { return this.children.flatMap(node => [node, ...node.descendants()]) }
  querySelectorAll(selector: string) { return this.descendants().filter(node => node.matches(selector)) }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null }
  closest(selector: string): NodeView | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null }
  focus() { if (this.owner) this.owner.activeElement = this }
  scrollIntoView() {}
  set innerHTML(_value: string) { throw new Error('Host text must never enter innerHTML') }
}

function harness() {
  const root = new NodeView('body'); const copied: string[] = []; const notices: string[] = []
  const document = {
    activeElement: null as NodeView | null,
    documentElement: new NodeView('html'),
    createElement(tag: string) { const node = new NodeView(tag); node.owner = document; return node },
    getElementById(id: string) { return root.descendants().find(node => node.id === id) || null },
    querySelector(selector: string) { return root.querySelector(selector) },
    querySelectorAll(selector: string) { return root.querySelectorAll(selector) },
    addEventListener() {},
  }
  root.owner = document
  const node = (id: string, tag = 'div', parent = root) => { const result = document.createElement(tag); result.id = id; parent.append(result); return result }
  const location = { hash: '#today' }; const history = { pushState(_state: unknown, _title: string, hash: string) { location.hash = hash } }
  const state = { snapshot: null, selectedRoleId: '', selectedTerritoryId: '', activeSection: 'today' }
  const env = {
    document, history, state,
    globalThis: { navigator: { clipboard: { async writeText(text: string) { copied.push(text) } } } },
    byId: (id: string) => document.getElementById(id),
    record: (value: any) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    clear: (id: string) => { const parent = document.getElementById(id); parent?.replaceChildren(); return parent },
    append: (parent: NodeView, tag: string, text?: any, className?: string) => { const child = document.createElement(tag); child.textContent = text === undefined || text === null || text === '' ? 'UNKNOWN' : String(text); child.className = className || ''; parent.append(child); return child },
    addEmpty: (parent: NodeView, text: string) => { const child = document.createElement('p'); child.textContent = text; parent.append(child) },
    typedEntityId: (value: any, type: string) => value?.type === type ? value.id : null,
    stateDisplay: (value: string) => ({ RUNNING: '执行中 (RUNNING)', REVIEW: '待审 (REVIEW)', RECOVERING: '恢复核对 (RECOVERING)' })[value] || value,
    status: (text: string) => { notices.push(text) },
    applyNavigationFromLocation: () => {}, load: async () => {},
  }
  const api = new Function('env', 'const {' + Object.keys(env).join(',') + '} = env;\n' + WORKBENCH_SCRIPT + '\nreturn { renderRuntimeOverview, renderSupervisorSettings, mountWorkbench };')(env)
  return { ...api, root, document, node, copied, notices, location, env }
}
const textOf = (node: NodeView): string => [node.textContent, ...node.children.map(textOf)].join('\n')
const emptyGovernance = () => ({ workerSessions: [], leases: [], decisions: [], dispatches: [] })
function fixture() {
  return {
    territories: [{ territoryId: 'alpha', name: '前端' }, { territoryId: 'beta', name: '接口' }, { territoryId: 'gamma', name: '文档' }],
    bindings: [
      { bindingId: 'ch', roleType: 'CHANCELLOR', roleName: '统筹', sessionDisplay: '…ch', sessionBound: true },
      { bindingId: 'sup-a', roleType: 'SUPERVISOR', roleName: '前端主管', sessionDisplay: '…sup-a', sessionBound: true },
      { bindingId: 'sup-b', roleType: 'SUPERVISOR', roleName: '接口主管', sessionDisplay: '…sup-b', sessionBound: true },
      { bindingId: 'worker-a', roleType: 'WORKER', roleName: '前端执行者', sessionDisplay: '…registration', sessionBound: true },
      { bindingId: 'worker-b', roleType: 'WORKER', roleName: '接口执行者', sessionDisplay: null, sessionBound: false },
    ],
    tasks: [
      { taskId: 'task-a', territoryId: 'alpha', title: '<img src=x>界面任务', assignedBindingId: 'worker-a', status: 'RUNNING', latestExecution: { state: 'RUNNING' } },
      { taskId: 'task-b', territoryId: 'beta', title: '接口任务', assignedBindingId: 'worker-b', status: 'REVIEW', latestExecution: { state: 'COMPLETED' } },
    ],
    liveExecutions: [{ executionId: 'execution-a', taskId: 'task-a', workerBindingId: 'worker-a', sessionId: '…persistent-a', state: 'RUNNING' }],
    stage: ['ch', 'sup-a', 'sup-b', 'worker-a', 'worker-b'].map(bindingId => ({ bindingId })),
    governance: { ...emptyGovernance(), workerSessions: [
      { affinityId: 'current-a', workerBindingId: 'worker-a', territoryId: 'alpha', sessionDisplay: '…persistent-a', isCurrent: true },
      { affinityId: 'old-a', workerBindingId: 'worker-a', territoryId: 'beta', sessionDisplay: '…retired', isCurrent: false },
    ] },
    projection: { organization: { data: { territories: [
      { territoryRef: { type: 'territory', id: 'alpha' }, supervisorBindingRef: { type: 'binding', id: 'sup-a' } },
      { territoryRef: { type: 'territory', id: 'beta' }, supervisorBindingRef: { type: 'binding', id: 'sup-b' } },
      { territoryRef: { type: 'territory', id: 'gamma' }, supervisorBindingRef: null },
    ] } }, workbench: { data: { roles: { items: [{ bindingId: 'sup-a', activeExecutionCount: 99 }] } } } },
  }
}

test('overview renders tasks and current sessions with exact role and territory relationships', () => {
  const h = harness(); const tasks = h.node('runtime-tasks'); const sessions = h.node('runtime-sessions')
  h.renderRuntimeOverview(fixture())
  assert.equal(tasks.querySelectorAll('tbody')[0].children.length, 2)
  assert.match(textOf(tasks), /<img src=x>界面任务.*前端.*前端执行者.*RUNNING/su)
  assert.equal(tasks.querySelector('img'), null, 'host titles remain text')
  const rows = sessions.querySelector('tbody')!.children
  assert.equal(rows.length, 5, 'current affinity replaces registration row; retired affinities stay out')
  assert.doesNotMatch(textOf(h.root.querySelector('[data-runtime-task]')!.children[0]), /UNKNOWN/u, 'task link cells do not inherit the generic missing-value marker');
  const supervisorA = rows.find((row: NodeView) => row.getAttribute('data-runtime-binding') === 'sup-a')!
  assert.match(textOf(supervisorA), /前端主管.*…sup-a.*前端.*界面任务/su)
  assert.doesNotMatch(textOf(supervisorA), /接口任务|99|执行记录：|RUNNING/u)
  assert.doesNotMatch(textOf(supervisorA.children[3]), /UNKNOWN/u, 'related task cells are blank containers, not unknown scalar values');
  assert.match(textOf(supervisorA), /未知/u, 'supervising a running task does not imply a model run')
  const workerA = rows.find((row: NodeView) => row.getAttribute('data-runtime-binding') === 'worker-a')!
  assert.match(textOf(workerA), /…persistent-a.*长期执行会话.*前端.*界面任务.*执行记录：执行中/su)
  assert.doesNotMatch(textOf(workerA), /registration|retired|接口任务/u)
  assert.equal(rows.find((row: NodeView) => row.getAttribute('data-runtime-binding') === 'sup-b')!.querySelector('a')!.getAttribute('data-focus-key'), 'runtime-session-task:sup-b:binding:task-b')
})

test('retired binding history and truncated supervisor seats never become current roles or false missing seats', () => {
  const h = harness(); h.node('runtime-tasks'); const sessions = h.node('runtime-sessions'); const settings = h.node('settings-supervisors'); const snapshot = fixture()
  snapshot.bindings.push({ bindingId: 'old-supervisor', roleType: 'SUPERVISOR', roleName: '退任主管', sessionDisplay: '…old', sessionBound: true })
  snapshot.projection.organization.data.territories = snapshot.projection.organization.data.territories.filter(item => item.territoryRef.id !== 'gamma')
  h.renderRuntimeOverview(snapshot); h.renderSupervisorSettings(snapshot)
  assert.doesNotMatch(textOf(sessions), /退任主管|…old/u)
  const gamma = settings.querySelector('tbody')!.children.find((row: NodeView) => row.getAttribute('data-supervisor-territory') === 'gamma')!
  assert.match(textOf(gamma), /当前主管未确认/u)
  assert.doesNotMatch(textOf(gamma), /尚未绑定可用主管/u)
})

test('a supervisor on territory 65 uses its exact workbench scope beyond the organization display limit', () => {
  const h = harness(); h.node('runtime-tasks'); const sessions = h.node('runtime-sessions'); const settings = h.node('settings-supervisors')
  const snapshot: any = fixture()
  snapshot.territories = Array.from({ length: 65 }, (_, index) => ({ territoryId: 'territory-' + index, name: index === 64 ? '边界研发' : '领地' + index }))
  snapshot.projection.organization.data.territories = snapshot.territories.slice(0, 64).map((territory: any) => ({ territoryRef: { type: 'territory', id: territory.territoryId }, supervisorBindingRef: null }))
  snapshot.projection.organization.data.territoriesTruncated = true
  snapshot.projection.workbench.data.roles.items = [{ bindingId: 'sup-a', roleType: 'SUPERVISOR', territories: [{ territoryId: 'territory-64', name: '旧显示名称' }], activeExecutionCount: 99 }]
  snapshot.tasks = [{ taskId: 'boundary-task', territoryId: 'territory-64', title: '末尾领地任务', assignedBindingId: 'worker-a', status: 'RUNNING', latestExecution: null }]
  snapshot.bindings.push({ bindingId: 'retired', roleType: 'SUPERVISOR', roleName: '退任历史', sessionDisplay: '…retired', sessionBound: true })
  snapshot.projection.workbench.data.roles.items.push({ bindingId: 'retired', roleType: 'SUPERVISOR', territories: [{ territoryId: 'territory-64', name: '边界研发' }] })
  h.renderRuntimeOverview(snapshot); h.renderSupervisorSettings(snapshot)
  const supervisor = sessions.querySelector('tbody')!.children.find((row: NodeView) => row.getAttribute('data-runtime-binding') === 'sup-a')!
  assert.match(textOf(supervisor), /前端主管.*边界研发.*末尾领地任务/su)
  assert.doesNotMatch(textOf(supervisor), /旧显示名称|尚未隶属领地|暂无关联任务|执行记录：|99/u)
  assert.match(textOf(supervisor), /未知/u, 'scope evidence does not become model activity')
  const territory = settings.querySelector('tbody')!.children.find((row: NodeView) => row.getAttribute('data-supervisor-territory') === 'territory-64')!
  assert.match(textOf(territory), /边界研发.*前端主管.*…sup-a.*更换主管请求/su)
  assert.doesNotMatch(textOf(sessions), /退任历史/u)
})

test('missing scope after territory projection truncation remains unknown until an exact empty scope is provided', () => {
  const h = harness(); h.node('runtime-tasks'); const sessions = h.node('runtime-sessions'); const snapshot: any = fixture()
  snapshot.projection.organization.data.territories = snapshot.projection.organization.data.territories.slice(1)
  snapshot.projection.organization.data.territoriesTruncated = true
  h.renderRuntimeOverview(snapshot)
  const supervisor = () => sessions.querySelector('tbody')!.children.find((row: NodeView) => row.getAttribute('data-runtime-binding') === 'sup-a')!
  assert.match(textOf(supervisor()), /领地未确认.*关联任务未确认/su)
  assert.doesNotMatch(textOf(supervisor()), /尚未隶属领地|暂无关联任务/u)
  snapshot.projection.workbench.data.roles.items = [{ bindingId: 'sup-a', roleType: 'SUPERVISOR', territories: [] }]
  h.renderRuntimeOverview(snapshot)
  assert.match(textOf(supervisor()), /尚未隶属领地.*暂无关联任务/su, 'explicit complete empty scope is distinguishable from missing data')
})

test('a different binding, task, session or territory cannot animate an unrelated session as running', () => {
  for (const mismatch of ['binding', 'task', 'session', 'territory']) {
    const h = harness(); h.node('runtime-tasks'); const sessions = h.node('runtime-sessions'); const snapshot = fixture()
    if (mismatch === 'binding') snapshot.liveExecutions[0]!.workerBindingId = 'worker-b'
    if (mismatch === 'task') snapshot.liveExecutions[0]!.taskId = 'task-b'
    if (mismatch === 'session') snapshot.liveExecutions[0]!.sessionId = '…another'
    if (mismatch === 'territory') snapshot.governance.workerSessions[0]!.territoryId = 'beta'
    h.renderRuntimeOverview(snapshot)
    const worker = sessions.querySelector('tbody')!.children.find((row: NodeView) => row.getAttribute('data-runtime-binding') === 'worker-a')!
    assert.match(textOf(worker), /未知/u, mismatch)
    assert.doesNotMatch(textOf(worker), /执行记录：/u, mismatch)
  }
})

test('supervisor settings copy natural language to the target chat without performing a write', async () => {
  const h = harness(); const parent = h.node('settings-supervisors'); h.renderSupervisorSettings(fixture())
  const rows = parent.querySelector('tbody')!.children
  assert.equal(rows.length, 3)
  assert.match(textOf(rows[0]!), /前端.*前端主管.*…sup-a.*把「前端」主管换成当前会话/su)
  assert.match(textOf(rows[2]!), /文档.*尚未绑定.*让当前会话负责「文档」/su)
  rows[0]!.querySelector('button')!.onclick!(); rows[2]!.querySelector('button')!.onclick!(); await Promise.resolve()
  assert.deepEqual(h.copied, ['把「前端」主管换成当前会话', '让当前会话负责「文档」'])
  assert.match(textOf(rows[2]!), /已复制.*目标 DSH 会话.*引导确认/su)
  assert.doesNotMatch(h.copied.join('\n'), /sup-a|gamma|\/kingdom|\{|token|ticket/u)
  assert.equal(h.location.hash, '#today', 'copy does not navigate or grant authority')
})

test('clipboard failure leaves a clear manual chat request and does not report copied', () => {
  const h = harness(); const parent = h.node('settings-supervisors'); h.env.globalThis.navigator.clipboard = null as any
  h.renderSupervisorSettings(fixture()); const row = parent.querySelector('tbody')!.children[0]!
  row.querySelector('button')!.onclick!()
  assert.match(textOf(row), /未能复制.*选中上面的一句话/su)
  assert.doesNotMatch(textOf(row), /已复制/u)
})

test('dispatch mounting preserves original form listeners and leaves review and recovery in task details', () => {
  const h = harness(); const zones = h.node('zones'); zones.className = 'zones'; h.node('tasks'); h.node('management')
  const detail = h.node('task-detail-content'); const dock = h.node('operation-forms'); const forms = h.node('forms', 'div', dock)
  const composer = h.node('composer', 'section', forms); composer.className = 'task-composer-card'
  const assignWrapper = h.node('assign-wrapper', 'details', forms); const assign = h.node('assign-form', 'form', assignWrapper)
  const startWrapper = h.node('start-wrapper', 'details', forms); const start = h.node('start-form', 'form', startWrapper)
  const review = h.node('review-form', 'form', forms); const reconcile = h.node('reconcile-form', 'form', forms); const control = h.node('execution-control-form', 'form', forms)
  const dispatch = h.node('dispatch-content'); const quick = h.node('quick-task-form', 'form'); const goal = h.node('quick-task-goal', 'input'); const title = h.node('task-title', 'input')
  let assigns = 0; assign.addEventListener('submit', () => { assigns++ })
  h.mountWorkbench()
  assert.equal(h.document.getElementById('assign-form'), assign)
  assert.equal(assign.parentElement!.parentElement, dispatch); assert.equal(start.parentElement!.parentElement, dispatch)
  assert.equal(composer.parentElement!.parentElement, dispatch); assert.equal(composer.parentElement!.open, true)
  assert.equal(review.parentElement, forms); assert.equal(reconcile.parentElement, forms); assert.equal(control.parentElement, forms)
  assert.equal(dock.parentElement, detail.parentElement); assign.listeners.get('submit')!({}); assert.equal(assigns, 1)
  goal.value = '写第一条任务'; quick.listeners.get('submit')!({ preventDefault() {} })
  assert.equal(title.value, '写第一条任务'); assert.equal(h.location.hash, '#dispatch')
  assert.match(WORKBENCH_HTML, /id="dispatch-page"[^>]*data-console-page="dispatch"/u)
})
