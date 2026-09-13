import assert from 'node:assert/strict'
import test from 'node:test'
import { CONSOLE_APP_HTML, parseConsoleFragment } from '../lib/gui/console-app.js'

class ViewNode {
  id = ''; tagName: string; textContent = ''; className = ''; value = ''; disabled = false; hidden = false; open = false; isConnected = true
  selectionStart: number | null = null; selectionEnd: number | null = null; top = 180; height = 80
  children: ViewNode[] = []; dataset: Record<string, string> = {}; attributes: Record<string, string> = {}
  owner: { activeElement: ViewNode | null } | null = null
  constructor(tag = 'div') { this.tagName = tag }
  append(...nodes: ViewNode[]) { this.children.push(...nodes); nodes.forEach(node => { node.owner = this.owner }) }
  replaceChildren(...nodes: ViewNode[]) { this.children.forEach(node => { node.isConnected = false }); this.children = []; this.append(...nodes) }
  setAttribute(name: string, value: string) { this.attributes[name] = String(value) }
  getAttribute(name: string) { return this.attributes[name] ?? null }
  removeAttribute(name: string) { delete this.attributes[name] }
  focus() { if (this.owner) this.owner.activeElement = this }
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end }
  getBoundingClientRect() { return { top: this.top, bottom: this.top + this.height, height: this.height } }
  scrollIntoView() {}
  set innerHTML(_value: string) { throw new Error('Host content must not enter innerHTML') }
}

function harness(fetcher: (url: string, init?: any) => Promise<unknown> = async () => { throw new Error('unexpected request') }) {
  const nodes = new Map<string, ViewNode>(); const doc = {
    activeElement: null as ViewNode | null,
    getElementById(id: string) { return nodes.get(id) || allNodes().find(node => node.id === id) || null },
    createElement(tag: string) { const node = new ViewNode(tag); node.owner = doc; return node },
    querySelector(_selector: string) { return null },
    querySelectorAll(selector: string) {
      if (selector === 'details[data-read-key], details[id]') return allNodes().filter(node => node.tagName === 'details' && (node.id || node.getAttribute('data-read-key')))
      if (selector === '[data-read-anchor]') return allNodes().filter(node => node.getAttribute('data-read-anchor'))
      if (selector === '[data-focus-key]') return allNodes().filter(node => node.getAttribute('data-focus-key'))
      return []
    },
  }
  const allNodes = (): ViewNode[] => { const result: ViewNode[] = []; const walk = (node: ViewNode) => { result.push(node); node.children.forEach(walk) }; nodes.forEach(walk); return result }
  const node = (id: string, tag = 'div') => { const item = doc.createElement(tag); item.id = id; nodes.set(id, item); return item }
  const location = { hash: '#today' }; const history = { pushState(_state: unknown, _title: string, hash: string) { location.hash = hash } }
  const sink: any = {}; const script = CONSOLE_APP_HTML.match(/<script>([\s\S]*?)<\/script>/u)![1]; const cutoff = script.indexOf('      const formValue =')
  assert.ok(cutoff > 0)
  new Function('document', 'location', 'history', 'fetch', 'sink', script.slice(0, cutoff) + '\n sink.api = { state, stateMeaning, statusTone, preserveWorkbenchView, renderWorkbenchTaskDetail, renderWorkbench, renderWorkbenchUsage, renderWorkbenchQueue, submit, normalizeCapabilities, renderSnapshot, consumeSubmittedDraft, stageWorkbenchGoal }; })();')(doc, location, history, fetcher, sink)
  return { ...sink.api, doc, node, nodes, allNodes, location }
}

const textOf = (node: ViewNode): string => [node.textContent, ...node.children.map(textOf)].join('\n')

test('same revision reconnect and control changes replace stale status without retrying writes', async () => {
  const script = CONSOLE_APP_HTML.match(/<script>([\s\S]*?)<\/script>/u)![1]
  const start = script.indexOf('     const load = async')
  const end = script.indexOf('     const submit = async', start)
  assert.ok(start > 0 && end > start)
  const state: any = { loading: false, commandBusy: false, capabilities: { state: 'ACTIVE' }, lastRevision: 7, stale: false }
  let unavailable = true; let controlState = 'ACTIVE'; let message = ''; let writes = 0
  const env = {
    state, CONFIG: { endpoints: { control: '/control', snapshot: '/snapshot' } }, location: { hash: '#tasks' },
    requestJson: async (url: string) => { if (url === '/control') return { state: controlState }; if (url !== '/snapshot') { writes++; throw new Error('unexpected write') } if (unavailable) throw new Error('unavailable'); return { revision: 7 } },
    renderCapabilities: (value: any) => { state.capabilities = value }, status: (value: string) => { message = value },
    controlFailureView: () => ({ state: 'FAILED' }), loadDetail: async () => {}, reconcileSelections: () => {},
    renderSnapshot: () => {}, renderGates: () => {}, setText: () => {}, parseFragment: () => ({ known: true }),
    text: String, reasonDisplay: (value: string) => value,
  }
  const load = new Function('env', 'const {' + Object.keys(env).join(',') + '} = env;\n' + script.slice(start, end) + '\nreturn load;')(env)
  await load(true); assert.equal(state.stale, true); assert.match(message, /暂不可用/)
  unavailable = false; await load(true); assert.equal(state.stale, false); assert.match(message, /投影已刷新/)
  controlState = 'REVOKED'; await load(true); assert.match(message, /REVOKED.*写动作已禁用/)
  controlState = 'ACTIVE'; await load(true); assert.match(message, /投影已刷新/)
  assert.equal(writes, 0)
})
const emptyQueue = () => ({ totalCount: 0, items: [], truncated: false })
const task = (id: string) => ({ taskId: id, territoryId: 'territory-1', title: '任务 ' + id, description: '明确范围', acceptanceCriteria: '验证条件', status: 'RUNNING', attemptCount: 1, assignedBindingId: 'worker-1', latestClaim: null, latestExecution: { state: 'RECOVERING' } })

test('workbench has six navigation entries and defaults to today', () => {
  assert.equal(parseConsoleFragment('').section, 'today')
  const nav = CONSOLE_APP_HTML.match(/<nav id="main-navigation"[\s\S]*?<\/nav>/u)![0]
  assert.equal((nav.match(/data-nav-section=/gu) || []).length, 6)
  for (const value of ['today', 'tasks', 'inbox', 'map', 'usage', 'settings']) assert.equal(parseConsoleFragment('#' + value).known, true)
  assert.equal(parseConsoleFragment('#task=task%2Fone').taskId, 'task/one')
  assert.equal(parseConsoleFragment('#overview').section, 'overview')
})

test('task detail separates recovering execution, claim, supervisor decision and human acceptance', () => {
  const h = harness(); const root = h.node('task-detail-content'); h.node('task-detail-revision')
  const rawClaim = JSON.stringify({ summary: '执行者自述成功', outcome: 'SUCCESS', artifacts: ['原始JSON产物引用'] })
  const selected = { ...task('task-a'), title: '<img src=x onerror=alert(1)>', latestClaim: { attemptNo: 1, claimedOutcome: 'SUCCESS', summary: rawClaim, artifacts: ['artifact.txt'], risks: [] } }
  const snapshot = { tasks: [selected], territories: [], projection: { organization: { data: { roles: [{ bindingRef: { type: 'binding', id: 'supervisor-multi' }, roleType: 'SUPERVISOR', roleName: '多领地主理人', territoryRef: null }], territories: [{ territoryRef: { type: 'territory', id: 'territory-1' }, supervisorBindingRef: { type: 'binding', id: 'supervisor-multi' } }] } } } }
  const detail = { task: selected, revision: 6, claims: [selected.latestClaim], reviews: [{ decision: 'REWORK', reason: '仍需补充验证', createdAt: '2026-09-12', seq: 7 }], assignments: [], executions: [], governance: { dispatches: [] }, reviewsTruncated: true }
  h.state.snapshot = snapshot; h.state.selectedTaskId = 'task-a'; h.state.detailTaskId = 'task-a'; h.renderWorkbenchTaskDetail(snapshot, detail)
  const rendered = textOf(root)
  for (const marker of ['<img src=x onerror=alert(1)>', '明确范围', '验证条件', 'RUNNING', 'RECOVERING', '执行者自述成功', 'artifact.txt', 'REWORK', '人类验收', '尚未记录', '不能按零计算', '当前契约没有独立验证结果字段', '多领地主理人', '不代表完整历史']) assert.ok(rendered.includes(marker), marker)
  assert.equal(h.allNodes().some((node: ViewNode) => node.tagName === 'img'), false)
  assert.ok(rendered.includes(rawClaim), 'Task detail retains the complete original claim summary')
  assert.equal(h.allNodes().filter((node: ViewNode) => node.className === 'task-detail-section').length, 6)
})

test('refresh preserves task expansion, edited input, caret, focus and reading anchor', () => {
  const h = harness(); const root = h.node('reading-root'); const oldDetails = h.doc.createElement('details'); oldDetails.setAttribute('data-read-key', 'task-a:technical'); oldDetails.open = true; root.append(oldDetails)
  const input = h.node('draft-input', 'textarea'); input.value = '用户仍在编辑'; input.selectionStart = 2; input.selectionEnd = 4; input.focus()
  const anchor = h.doc.createElement('section'); anchor.setAttribute('data-read-anchor', 'task-a:delivery'); root.append(anchor)
  const previousScrollTo = globalThis.scrollTo; const positions: any[] = []; globalThis.scrollTo = ((options: unknown) => { positions.push(options) }) as any
  let next: ViewNode
  try {
    h.preserveWorkbenchView(() => { next = h.doc.createElement('details'); next.setAttribute('data-read-key', 'task-a:technical'); const newAnchor = h.doc.createElement('section'); newAnchor.setAttribute('data-read-anchor', 'task-a:delivery'); newAnchor.top = 230; root.replaceChildren(next, newAnchor) })
    assert.equal(next!.open, true); assert.equal(input.value, '用户仍在编辑'); assert.equal(h.doc.activeElement, input); assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 4); assert.equal(positions[0].top, 50)
    const focused = h.doc.createElement('button'); focused.setAttribute('data-focus-key', 'task-nav:task-a'); root.append(focused); focused.focus(); let replaced: ViewNode
    h.preserveWorkbenchView(() => { replaced = h.doc.createElement('button'); replaced.setAttribute('data-focus-key', 'task-nav:task-a'); root.replaceChildren(replaced) })
    assert.equal(h.doc.activeElement, replaced!)
  } finally { globalThis.scrollTo = previousScrollTo }
})

test('owner queue never invents work from internal reviews and usage gaps are visible', () => {
  const h = harness(); for (const id of ['today-owner', 'inbox-owner', 'today-internal', 'inbox-internal', 'today-exceptions', 'today-active', 'today-deliveries', 'usage-summary', 'usage-content']) h.node(id)
  const usage = { totalDispatches: 3, completeDispatches: 1, partialDispatches: 1, unavailableDispatches: 1, executionsWithoutDispatch: 2, coverage: 'PARTIAL', reportedTotals: { totalTokens: 25, uncachedInputTokens: 20, outputTokens: 5 } }
  const data = { ownerActions: emptyQueue(), exceptions: emptyQueue(), internalActions: { ...emptyQueue(), totalCount: 1, items: [{ id: 'review-1', taskId: 'task-a', title: '主管审查', summary: '内部复核', responsibility: 'SUPERVISOR' }] }, deliveries: { ...emptyQueue(), totalCount: 1, items: [{ taskId: 'task-a', title: '已有交付', claim: { summary: JSON.stringify({ summary: '易读的首页摘要', outcome: 'SUCCESS', artifacts: ['不应从内层提取的引用'] }) }, supervisorAccepted: false }] }, roles: emptyQueue(), usage }
  const snapshot = { tasks: [], governance: { dispatches: [] }, projection: { workbench: { data } } }; h.state.snapshot = snapshot; h.renderWorkbench(snapshot)
  assert.doesNotMatch(textOf(h.nodes.get('today-owner')), /内部复核/u); assert.match(textOf(h.nodes.get('today-internal')), /内部复核/u)
  assert.match(textOf(h.nodes.get('today-deliveries')), /执行者自述：易读的首页摘要/u); assert.doesNotMatch(textOf(h.nodes.get('today-deliveries')), /不应从内层提取的引用|SUCCESS/u); assert.match(textOf(h.nodes.get('today-deliveries')), /主管接受尚未确认/u)
  assert.match(textOf(h.nodes.get('usage-summary')), /部分覆盖/u); assert.match(textOf(h.nodes.get('usage-summary')), /不是整个任务或平台的总用量/u)
  h.renderWorkbenchUsage({ ...usage, completeDispatches: 0, coverage: 'UNAVAILABLE', reportedTotals: null }); assert.match(textOf(h.nodes.get('usage-summary')), /合计无法确认，不能按零计算/u)
})

test('successful draft submission selects only the returned canonical task and never dispatches', async () => {
  const created = task('created-exact'); const decoy = task('unrelated-first'); const requests: string[] = []
  const snapshot = { revision: 4, tasks: [decoy, created], territories: [{ territoryId: 'territory-1', name: '已有领地' }], bindings: [], liveExecutions: [], projection: {} }
  const caps = { state: 'ACTIVE', active: true, csrfToken: 'fixture-token', roleSessionBound: true, actions: { 'task.create': { executable: true } } }
  const h = harness(async (url, init) => { requests.push((init?.method || 'GET') + ' ' + url); const body = init?.method === 'POST' ? { ok: true, task: created } : url === '/api/control' ? caps : url === '/api/snapshot' ? snapshot : { task: url.endsWith('created-exact') ? created : decoy, revision: 4 }; return { ok: true, status: 200, json: async () => body } })
  h.node('status-line'); h.node('task-draft-panel', 'details'); h.state.capabilities = h.normalizeCapabilities(caps); h.state.snapshot = { tasks: [] }; h.state.stale = false
  for (const [id, value] of [['task-title', 'new goal'], ['task-description', 'scope'], ['task-acceptance', 'criteria'], ['task-territory', 'territory-1']]) h.node(id, 'input').value = value
  h.state.selectedTerritoryId = 'territory-1'
  await h.submit('plan', { title: 'new goal', territory_id: 'territory-1', description: 'scope', acceptance_criteria: 'criteria' }, 'task.create', false)
  assert.equal(h.state.selectedTaskId, 'created-exact'); assert.equal(h.location.hash, '#task=created-exact'); assert.equal(requests.filter(value => value.startsWith('POST')).length, 1); assert.equal(requests.some(value => /commands\/(?:assign|start)/u.test(value)), false)
  assert.equal(h.nodes.get('task-title').value, ''); assert.equal(h.stageWorkbenchGoal('第二项任务'), true); assert.equal(h.nodes.get('task-title').value, '第二项任务')
})

test('draft rejection or success without task identity preserves input and never resends', async () => {
  for (const response of [{ ok: false, errorCode: 'UNAUTHORIZED_PRINCIPAL' }, { ok: true, task: null }]) {
    const requests: string[] = []; const caps = { state: 'ACTIVE', active: true, csrfToken: 'fixture-token', actions: { 'task.create': { executable: true } } }
    const h = harness(async (url, init) => { requests.push((init?.method || 'GET') + ' ' + url); const body = init?.method === 'POST' ? response : url === '/api/control' ? caps : { revision: 4, tasks: [], projection: {} }; return { ok: true, status: 200, json: async () => body } })
    const draft = h.node('task-title', 'input'); draft.value = '保持这份草稿'; h.node('status-line'); h.state.capabilities = h.normalizeCapabilities(caps); h.state.snapshot = { tasks: [] }
    await h.submit('plan', { title: draft.value, territory_id: 'territory-1' }, 'task.create', false)
    assert.equal(draft.value, '保持这份草稿'); assert.equal(h.location.hash, '#today'); assert.equal(requests.filter(item => item.startsWith('POST')).length, 1); assert.equal(requests.some(value => /commands\/(?:assign|start)/u.test(value)), false)
  }
})

test('created and assigned tasks retain clear normal state labels', () => {
  const h = harness()
  for (const [state, label] of [['CREATED', '已建待派发'], ['ASSIGNED', '已分派待启动']]) {
    assert.equal(h.statusTone(state).label, label); assert.equal(h.statusTone(state).tone, 'idle'); assert.equal(h.stateMeaning(state).label, label)
  }
})

test('successful draft consumption preserves edits made while the command is in flight', () => {
  const h = harness(); const payload = { title: '第一目标', description: '范围', acceptance_criteria: '验收', territory_id: 'territory-1' }
  for (const [id, value] of [['task-title', '提交期间的新目标'], ['task-description', '范围'], ['task-acceptance', '验收'], ['task-territory', 'territory-1']]) h.node(id, 'input').value = value
  assert.equal(h.consumeSubmittedDraft(payload), false); assert.equal(h.nodes.get('task-title').value, '提交期间的新目标'); assert.equal(h.nodes.get('task-description').value, '范围')
})
