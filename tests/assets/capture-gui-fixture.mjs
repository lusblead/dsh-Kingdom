/**
 * Local visual fixture capture for the v1.0 organization graph.
 *
 * This intentionally serves renderConsoleApp() from an in-memory HTTP server
 * with an explicit synthetic Snapshot. It never starts DSH, a Provider, or a
 * Kingdom Runtime. The resulting PNGs are fixture evidence only.
 */
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { GUI_CHARACTER_ASSET_FILES, renderConsoleApp } from '../../src/gui/console-app.ts'

const ref = (type, id) => ({ type, id })
const role = (bindingId, roleType, roleName, territoryId, _fixtureState) => ({
  bindingRef: ref('binding', bindingId), roleType, roleName,
  territoryRef: territoryId ? ref('territory', territoryId) : undefined,
  // OrganizationRoleSummary.status is the binding lifecycle fact. The
  // character's presentation state remains in the explicit stage fixture.
  status: 'ACTIVE',
})

const territories = [
  { territoryRef: ref('territory', 'rag'), name: 'RAG 研发领地', status: 'RUNNING', taskCount: 4, supervisorBindingRef: ref('binding', 'atlas') },
  { territoryRef: ref('territory', 'content'), name: '内容与演示', status: 'REVIEW', taskCount: 3, supervisorBindingRef: ref('binding', 'iris') },
  { territoryRef: ref('territory', 'infra'), name: 'Agent 基础设施', status: 'FROZEN', taskCount: 3, supervisorBindingRef: ref('binding', 'relay') },
]

const roles = [
  role('meridian', 'CHANCELLOR', 'Meridian', undefined, 'RUNNING'),
  role('atlas', 'SUPERVISOR', 'Atlas', 'rag', 'RUNNING'),
  role('iris', 'SUPERVISOR', 'Iris', 'content', 'REVIEW'),
  role('relay', 'SUPERVISOR', 'Relay', 'infra', 'UNKNOWN'),
  role('codex-03', 'WORKER', 'Codex 03', 'rag', 'RUNNING'),
  role('claude-01', 'WORKER', 'Claude 01', 'rag', 'REVIEW'),
  role('opencode-02', 'WORKER', 'OpenCode 02', 'rag', 'IDLE'),
  role('codex-07', 'WORKER', 'Codex 07', 'content', 'REVIEW'),
  role('claude-04', 'WORKER', 'Claude 04', 'content', 'RUNNING'),
  role('opencode-05', 'WORKER', 'OpenCode 05', 'infra', 'DONE'),
  role('codex-11', 'WORKER', 'Codex 11', 'infra', 'IDLE'),
]

const stage = [
  { role: 'CHANCELLOR', bindingId: 'meridian', roleName: 'Meridian', state: 'planning', activity: 'plan', transient: false, remainingMs: null, fallbackState: 'idle' },
  { role: 'SUPERVISOR', bindingId: 'atlas', roleName: 'Atlas', state: 'assigning', activity: 'assign', transient: false, remainingMs: null, fallbackState: 'idle' },
  { role: 'SUPERVISOR', bindingId: 'iris', roleName: 'Iris', state: 'reviewing', activity: 'review', transient: false, remainingMs: null, fallbackState: 'idle' },
  { role: 'SUPERVISOR', bindingId: 'relay', roleName: 'Relay', state: 'sleeping', activity: null, transient: false, remainingMs: null, fallbackState: 'sleeping' },
  { role: 'WORKER', bindingId: 'codex-03', roleName: 'Codex 03', state: 'working', activity: 'execute', transient: false, remainingMs: null, fallbackState: 'working' },
  { role: 'WORKER', bindingId: 'claude-01', roleName: 'Claude 01', state: 'sleeping', activity: null, transient: false, remainingMs: null, fallbackState: 'sleeping' },
  { role: 'WORKER', bindingId: 'opencode-02', roleName: 'OpenCode 02', state: 'idle', activity: null, transient: false, remainingMs: null, fallbackState: 'idle' },
  { role: 'WORKER', bindingId: 'codex-07', roleName: 'Codex 07', state: 'confused', activity: null, transient: false, remainingMs: null, fallbackState: 'idle' },
  { role: 'WORKER', bindingId: 'claude-04', roleName: 'Claude 04', state: 'working', activity: 'execute', transient: false, remainingMs: null, fallbackState: 'working' },
  { role: 'WORKER', bindingId: 'opencode-05', roleName: 'OpenCode 05', state: 'celebrating', activity: null, transient: true, remainingMs: 1200, fallbackState: 'idle' },
  { role: 'WORKER', bindingId: 'codex-11', roleName: 'Codex 11', state: 'waiting', activity: null, transient: false, remainingMs: null, fallbackState: 'idle' },
]

const tasks = [
  { taskId: 'task-rag-03', title: '验证 RRF 去重与跨路由贡献', status: 'RUNNING', territoryRef: ref('territory', 'rag'), assignedBindingId: ref('binding', 'codex-03'), attemptCount: 1 },
  { taskId: 'task-rag-01', title: '复核公开评测底座与 Manifest', status: 'REVIEW', territoryRef: ref('territory', 'rag'), assignedBindingId: ref('binding', 'claude-01'), attemptCount: 1 },
  { taskId: 'task-rag-02', title: '等待基准结果解冻', status: 'IDLE', territoryRef: ref('territory', 'rag'), assignedBindingId: ref('binding', 'opencode-02'), attemptCount: 0 },
  { taskId: 'task-content-07', title: '重绘王国组织与监管闭环', status: 'REVIEW', territoryRef: ref('territory', 'content'), assignedBindingId: ref('binding', 'codex-07'), attemptCount: 2 },
  { taskId: 'task-content-04', title: '70 分钟演示稿：结构收尾', status: 'RUNNING', territoryRef: ref('territory', 'content'), assignedBindingId: ref('binding', 'claude-04'), attemptCount: 1 },
  { taskId: 'task-infra-05', title: '等待管控轮换策略确认', status: 'DONE', territoryRef: ref('territory', 'infra'), assignedBindingId: ref('binding', 'opencode-05'), attemptCount: 1 },
  { taskId: 'task-infra-11', title: '新会话探针方案待定', status: 'IDLE', territoryRef: ref('territory', 'infra'), assignedBindingId: ref('binding', 'codex-11'), attemptCount: 0 },
]

const snapshot = {
  revision: 'fixture-20260824-r1',
  kingdom: { name: '样品王国' },
  bindings: roles,
  territories,
  tasks,
  liveExecutions: [{ executionId: 'fixture-execution-03', taskId: 'task-rag-03', state: 'RUNNING' }],
  stage,
  projection: {
    overview: { data: { health: 'DEGRADED', healthTitle: '样品王国健康', healthLabel: '降级运行', healthMetrics: { blockedWorkers: 1, frozenTerritories: 1, attentionCount: 3 }, taskCount: tasks.length, activeExecutionCount: 1, statusCounts: { REVIEW: 2 }, ownerActions: [] } },
    organization: { data: { kingdomName: '样品王国', bindingCount: roles.length, territoryCount: territories.length, roles, territories, rolesTruncated: false, territoriesTruncated: false } },
    executions: { data: { items: [{ executionId: 'fixture-execution-03', taskId: 'task-rag-03', state: 'RUNNING', executionContract: 'GOVERNED_PERSISTENT', pausePending: false }] } },
    timeline: { data: [] },
    attention: { data: [
      { severity: 'CRITICAL', reason: { code: 'WORKER_REVIEW_REQUIRED' }, summary: '1 名骑士受阻，等待主管确认内容边界', entityRef: ref('task', 'task-content-07'), sourceRefs: [] },
      { severity: 'UNKNOWN', reason: { code: 'TERRITORY_FROZEN' }, summary: '1 个领地冻结，Agent 基础设施等待解冻', entityRef: ref('territory', 'infra'), sourceRefs: [] },
      { severity: 'REVIEW', reason: { code: 'GOVERNANCE_ATTENTION' }, summary: '3 处需关注，等待治理核对', entityRef: ref('task', 'task-rag-01'), sourceRefs: [] },
    ] },
  },
}

const control = {
  state: 'ACTIVE', active: true, roleSessionBound: true, csrfToken: 'fixture-token',
  actions: {}, reviewDecisions: [], sandboxModes: [],
}

let resourceMode = 'normal'
let failedAssetRequests = 0

const snapshotForResourceMode = () => resourceMode === 'recover'
  ? {
      ...snapshot,
      revision: 'fixture-20260824-resource-recovered',
      stage: snapshot.stage.map(actor => actor.bindingId === 'meridian' ? { ...actor, state: 'idle', activity: null } : actor),
    }
  : snapshot

const json = (response, body, status = 200) => {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
  response.end(payload)
}

const http = createHttpServer((request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1')
  if (url.pathname === '/console') {
    const fixture = url.searchParams.get('fixture')
    if (fixture === 'resource-error') resourceMode = 'fail'
    else if (fixture !== 'resource-recovery') resourceMode = 'normal'
    const html = renderConsoleApp()
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) })
    response.end(html)
    return
  }
  if (url.pathname === '/api/control') return json(response, control)
  if (url.pathname === '/api/snapshot') return json(response, snapshotForResourceMode())
  if (url.pathname === '/__fixture/recover-character') {
    resourceMode = 'recover'
    return json(response, { ok: true, mode: resourceMode })
  }
  if (url.pathname.startsWith('/api/tasks/')) return json(response, { task: tasks.find(item => item.taskId === decodeURIComponent(url.pathname.slice('/api/tasks/'.length))) || null })
  if (url.pathname.startsWith('/gui-assets/characters/')) {
    const fileName = decodeURIComponent(url.pathname.slice('/gui-assets/characters/'.length))
    if (!GUI_CHARACTER_ASSET_FILES.includes(fileName)) return json(response, { errorCode: 'GUI_ASSET_NOT_FOUND' }, 404)
    if (resourceMode === 'fail' && fileName === 'chancellor-thinking.svg') {
      failedAssetRequests += 1
      return json(response, { errorCode: 'GUI_ASSET_UNAVAILABLE' }, 404)
    }
    const body = readFileSync(resolve('src/gui/assets/characters', fileName), 'utf8')
    response.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
    response.end(body)
    return
  }
  return json(response, { errorCode: 'NOT_FOUND' }, 404)
})

const reservePort = () => new Promise((resolvePort, reject) => {
  const server = createNetServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    server.close(error => error ? reject(error) : resolvePort(port))
  })
})

const waitFor = async (predicate, label, timeoutMs = 12_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error(`${label}: timeout`)
}

const profileRoot = mkdtempSync(join(tmpdir(), 'dshk-gui-fixture-'))
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
let chrome = null
let socket = null

try {
  await new Promise((resolveListen, rejectListen) => http.listen(0, '127.0.0.1', error => error ? rejectListen(error) : resolveListen()))
  const address = http.address()
  const httpPort = typeof address === 'object' && address ? address.port : 0
  const debugPort = await reservePort()
  chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--disable-background-networking',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileRoot}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok } catch { return false } }, 'Chrome debugger')
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about%3Ablank`, { method: 'PUT' })).json()
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolveOpen, rejectOpen) => { socket.addEventListener('open', resolveOpen, { once: true }); socket.addEventListener('error', rejectOpen, { once: true }) })
  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (!message.id || !pending.has(message.id)) return
    const entry = pending.get(message.id); pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result || {})
  })
  const command = (method, params = {}) => new Promise((resolveCommand, rejectCommand) => {
    const id = ++nextId; pending.set(id, { resolve: resolveCommand, reject: rejectCommand }); socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'browser evaluation failed')
    return result.result?.value
  }
  const setViewport = (width, height) => command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width <= 480 })
  const capture = async (width, height, output) => {
    await setViewport(width, height)
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
    const image = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true })
    writeFileSync(resolve(output), Buffer.from(image.data, 'base64'))
    return evaluate(`({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, heading: document.getElementById('kingdom-state-title')?.textContent, chancellorVisible: !!document.querySelector('.chancellor-card'), territoryCount: document.querySelectorAll('.territory-column').length, supervisorCount: document.querySelectorAll('.territory-column .org-node:not(.worker-stack .org-node)').length, workerCount: document.querySelectorAll('.worker-stack .org-node').length, nav: [...document.querySelectorAll('#main-navigation > *')].map(node => node.textContent.trim()), sprites: [...document.querySelectorAll('.pixel-sprite')].map(node => { const scope = node.shadowRoot || node; const svg = scope.querySelector('svg'); return { role: node.dataset.role, animationState: node.dataset.animationState, stageEvidence: node.dataset.stageEvidence, assetUrl: node.dataset.assetUrl, resourceState: node.dataset.resourceState, inlineSvg: !!svg, svgState: svg?.getAttribute('data-state') || null, hidden: node.hidden }; }) })`)
  }

  const probeEmbeddedMotion = () => evaluate(`(async () => {
    const sample = () => [...document.querySelectorAll('.pixel-sprite')].map(wrapper => {
      const scope = wrapper.shadowRoot || wrapper;
      const svg = scope.querySelector('svg');
      const state = svg?.getAttribute('data-state') || 'idle';
      const stateFrames = svg ? [...svg.querySelectorAll('.state-' + state + ' .frame')] : [];
      const frames = stateFrames.length ? stateFrames : svg ? [...svg.querySelectorAll('.frame')] : [];
      const frameStyles = frames.map(frame => { const style = getComputedStyle(frame); return { id: frame.id, visibility: style.visibility, animationName: style.animationName, playState: style.animationPlayState }; });
      return { role: wrapper.dataset.role, animationState: wrapper.dataset.animationState, inlineSvg: !!svg, wrapperAnimationName: getComputedStyle(wrapper).animationName, svgAnimationName: svg ? getComputedStyle(svg).animationName : 'none', frameStyles, visibleFrameIds: frameStyles.filter(item => item.visibility === 'visible').map(item => item.id).join('|') };
    });
    const first = sample();
    await new Promise(resolveWait => setTimeout(resolveWait, 450));
    const second = sample();
    return { matches: matchMedia('(prefers-reduced-motion: reduce)').matches, first, second, changed: JSON.stringify(first) !== JSON.stringify(second), frameChanged: first.some((item, index) => item.visibleFrameIds !== second[index]?.visibleFrameIds), hasRunningAnimation: first.some(item => item.frameStyles.some(frame => frame.animationName !== 'none' && frame.playState === 'running')), allFrameAnimationsDisabled: first.every(item => item.frameStyles.every(frame => frame.animationName === 'none')), stableFirstFrame: first.every((item, index) => item.visibleFrameIds === second[index]?.visibleFrameIds) };
  })()`)

  await command('Page.enable')
  await command('Runtime.enable')
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `
    globalThis.__guiResourceProbe = { errorListeners: 0 };
    const originalAddEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function(type, ...args) {
      if (type === 'error' && typeof HTMLImageElement !== 'undefined' && this instanceof HTMLImageElement) {
        globalThis.__guiResourceProbe.errorListeners += 1;
      }
      return originalAddEventListener.call(this, type, ...args);
    };
  ` })
  await command('Emulation.setEmulatedMedia', { features: [] })
  await setViewport(1024, 768)
  const navigate = async url => {
    const loaded = new Promise(resolveLoad => {
      const listener = event => {
        const message = JSON.parse(event.data)
        if (message.method === 'Page.loadEventFired') { socket.removeEventListener('message', listener); resolveLoad() }
      }
      socket.addEventListener('message', listener)
    })
    await command('Page.navigate', { url })
    await loaded
  }
  await navigate(`http://127.0.0.1:${httpPort}/console?fixture=OWNER_SPECIFIED_0.8_VISUAL_TARGET`)
  await waitFor(() => evaluate("document.querySelectorAll('.territory-column').length === 3 && document.querySelector('.chancellor-card') !== null"), 'organization fixture render')
  const desktop = await capture(1024, 768, 'tests/assets/gui-visual-fixture-1024x768.png')
  const mobile = await capture(390, 844, 'tests/assets/gui-visual-fixture-390x844.png')
  const normalMotion = await probeEmbeddedMotion()
  const normalEmbedded = normalMotion
  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  const reducedMotion = await probeEmbeddedMotion()
  const reducedEmbedded = reducedMotion
  const networkAssetRequests = await evaluate(`performance.getEntriesByType('resource').filter(entry => String(entry.name).includes('/gui-assets/characters/')).length`)
  const assetChecks = await Promise.all(GUI_CHARACTER_ASSET_FILES.map(async assetName => {
    const response = await fetch(`http://127.0.0.1:${httpPort}/gui-assets/characters/${assetName}`)
    const body = await response.text()
    return { assetName, status: response.status, contentType: response.headers.get('content-type'), hasKeyframes: /@keyframes/u.test(body), hasReducedMotion: /prefers-reduced-motion/u.test(body) }
  }))
  if (assetChecks.some(item => item.status !== 200 || !item.hasKeyframes || !item.hasReducedMotion)) throw new Error('allowlisted character asset check failed')
  if (!normalEmbedded.hasRunningAnimation || !normalEmbedded.frameChanged || normalEmbedded.first.some(item => !item.inlineSvg && item.role)) throw new Error('normal inline SVG animation probe did not observe running frame animation')
  if (reducedEmbedded.hasRunningAnimation || !reducedEmbedded.allFrameAnimationsDisabled || !reducedEmbedded.stableFirstFrame) throw new Error('reduced-motion inline SVG animation probe did not settle on the first frame')
  if (networkAssetRequests !== 0 || failedAssetRequests !== 0) throw new Error('inline SVG fixture unexpectedly requested external character assets')
  const resourceErrorEvidence = { failedAssetRequests, networkAssetRequests, inlineRegistry: 'ALL_ALLOWLISTED_SVGS_EMBEDDED', evidence: 'FIXTURE_ONLY_NOT_RUNTIME' }
  writeFileSync(resolve('tests/assets/gui-character-resource-error.json'), JSON.stringify(resourceErrorEvidence, null, 2) + '\n')

  const evidence = { evidence: 'FIXTURE_ONLY_NOT_RUNTIME', desktop, mobile, normalMotion, normalEmbedded, reducedMotion, reducedEmbedded, assetChecks, resourceError: resourceErrorEvidence }
  writeFileSync(resolve('tests/assets/gui-visual-fixture-motion.json'), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  try { if (socket?.readyState === WebSocket.OPEN) socket.close() } catch {}
  try { chrome?.kill() } catch {}
  try { http.close() } catch {}
  if (profileRoot.startsWith(join(tmpdir(), 'dshk-gui-fixture-'))) {
    try { rmSync(profileRoot, { recursive: true, force: true }) } catch {}
  }
}
