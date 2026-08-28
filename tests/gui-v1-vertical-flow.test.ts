/**
 * v1 public GUI mainline vertical verification.
 *
 * The product is entered through the direct `/kingdom gui` activation, its
 * loopback HTTP admission, and public `/api/commands/*` routes. A fresh
 * temporary DSH_HOME owns the only SQLite v4 database used here. The Agent and
 * enforcement surfaces are explicit process-local fakes, so successful starts
 * prove Adapter/Core orchestration only: they are not real DSH/Provider or
 * effective-model evidence.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KingdomStore } from '../lib/core/db.js'
import {
  buildConsoleCommand,
  parseConsoleFragment,
  renderConsoleApp,
  shouldCommitConsoleTaskDetail,
} from '../src/gui/console-app.ts'

const CAPABILITY_JSON = '{"tool:pwsh":true}'
const ACTIVATION_SESSION = 'v1-vertical-supervisor-session'

interface CapturedTool {
  name: string
}

interface CapturedCommand {
  name: string
  handler(invocation: { rawInput: string; agent?: unknown }): Promise<{ kind: string; text: string }>
}

type FakeEvent = { type: string; data?: Record<string, unknown> }
type FakeSession = { id: string; header: { cwd: string }; events: FakeEvent[]; status: 'idle' | 'running' }

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

function append(session: unknown, type: string, data: Record<string, unknown>): void {
  ;(session as FakeSession).events.push({ type, data })
}

function fakeAgents(): {
  service: Record<string, unknown>
  sessionRefs(): string[]
  followupCount(): number
} {
  type Agent = {
    id: string
    session: FakeSession
    status: 'idle' | 'running'
    ctx: { tools: Record<string, unknown> }
    followup(message: { id: string }): void
    runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T>
  }

  const agents = new Map<string, Agent>()
  const sessions = new Map<string, FakeSession>()
  const workerSessionIds = new Set<string>()
  let currentInitiator: Agent | undefined
  let followups = 0

  const makeAgent = (id: string, cwd: string, status: 'idle' | 'running' = 'running'): Agent => ({
    id,
    status,
    session: { id, header: { cwd }, events: [], status },
    ctx: {
      tools: {
        schemas: () => [{ name: 'pwsh' }],
        restrict: () => () => {},
        guard: () => () => {},
      },
    },
    followup(message): void {
      followups++
      const turn = followups
      this.session.events.push({ type: 'user/message', data: { id: message.id } })
      this.session.events.push({ type: 'turn/start', data: { turn } })
      this.session.events.push({
        type: 'turn/end',
        data: { turn, reason: { kind: 'completed' } },
      })
      this.session.events.push({
        type: 'assistant/message',
        data: { text: `v1 fake Claim ${turn}: bounded acceptance evidence` },
      })
    },
    runMaintenance: async <T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> => job(new AbortController().signal),
  })
  const registerAgent = (id: string, status: 'idle' | 'running' = 'running', workerSession = false): Agent => {
    const agent = makeAgent(id, process.cwd(), status)
    agents.set(id, agent)
    sessions.set(id, agent.session)
    if (workerSession) workerSessionIds.add(id)
    currentInitiator = agent
    return agent
  }

  const service = {
    agents,
    currentInitiator: () => currentInitiator,
    async create(options: {
      sessionId: string
      meta?: { cwd?: string }
      setup?: (ctx: unknown) => unknown
    }) {
      const agent = registerAgent(options.sessionId, 'idle', true)
      agent.session.header.cwd = options.meta?.cwd ?? process.cwd()
      await options.setup?.({})
      return { agent, dispose: async () => { agents.delete(options.sessionId); sessions.delete(options.sessionId); workerSessionIds.delete(options.sessionId); if (currentInitiator === agent) currentInitiator = undefined } }
    },
    async resume(options: {
      resumeSessionId: string
      setup?: (ctx: unknown) => unknown
    }) {
      const agent = registerAgent(options.resumeSessionId, 'idle', true)
      await options.setup?.({})
      return { agent, dispose: async () => { agents.delete(options.resumeSessionId); sessions.delete(options.resumeSessionId); workerSessionIds.delete(options.resumeSessionId); if (currentInitiator === agent) currentInitiator = undefined } }
    },
    get: (id: string) => agents.get(id),
    list: () => [...agents.values()],
  }

  return {
    service,
    sessions: { get: (id: string) => sessions.get(id) },
    registerAgent,
    sessionRefs: () => [...workerSessionIds],
    followupCount: () => followups,
  }
}

test('v1 Console fragment and Task navigator preserve public navigation without browser Authority', () => {
  assert.deepEqual(parseConsoleFragment('#overview'), {
    known: true,
    section: 'overview',
    taskId: null,
  })
  assert.deepEqual(parseConsoleFragment('#task=task%2Fvertical%20one'), {
    known: true,
    section: 'tasks',
    taskId: 'task/vertical one',
  })
  assert.deepEqual(parseConsoleFragment('#tasks'), {
    known: true,
    section: 'tasks',
    taskId: null,
  })
  assert.deepEqual(parseConsoleFragment('#task=%E0%A4%A'), {
    known: false,
    section: 'overview',
    taskId: null,
  })
  assert.deepEqual(parseConsoleFragment('#untrusted-location'), {
    known: false,
    section: 'overview',
    taskId: null,
  })

  const detail = { task: { taskId: 'task-vertical' } }
  assert.equal(shouldCommitConsoleTaskDetail('task-vertical', 'task-vertical', detail, 4, 4), true)
  assert.equal(shouldCommitConsoleTaskDetail('task-newer', 'task-vertical', detail, 4, 4), false)
  assert.equal(shouldCommitConsoleTaskDetail('task-vertical', 'task-vertical', detail, 3, 4), false)

  const command = buildConsoleCommand(' plan ', {
    title: 'bounded task',
    session_id: 'forged-session',
    owner_capability: 'forged-owner-capability',
    authorization: 'forged-authorization',
  })
  assert.deepEqual(command, { name: 'plan', payload: { title: 'bounded task' } })

  const html = renderConsoleApp()
  for (const section of ['overview', 'management', 'ledger']) {
    assert.match(html, new RegExp(`href="#${section}"[^>]+data-nav-section="${section}"`, 'u'))
  }
  for (const section of ['organization', 'tasks', 'executions', 'activity']) {
    assert.match(html, new RegExp(`href="#${section}"[^>]+data-nav-section="ledger"`, 'u'))
  }
  assert.match(html, /aria-label="任务导航器"/u)
  assert.match(html, /'#task=' \+ encodeURIComponent/u)
})

test('v1 public GUI covers governed DONE, HANDOFF, execution controls, and Owner boundary', async (t) => {
  const tempPrefix = join(tmpdir(), 'dsh-kingdom-v1-vertical-')
  const root = mkdtempSync(tempPrefix)
  const dbPath = join(root, 'kingdom', 'kingdom.db')
  const previousDshHome = process.env.DSH_HOME
  const tools = new Map<string, CapturedTool>()
  const commands = new Map<string, CapturedCommand>()
  const disposers: Array<() => void> = []
  const agents = fakeAgents()
  agents.registerAgent(ACTIVATION_SESSION, 'running')
  let launchUrl = ''
  let store: KingdomStore | null = null

  const permission = {
    set(session: unknown, preset: string): void {
      append(session, 'permission/preset', { preset })
      append(session, 'sandbox/mode', { mode: 'workspace-write' })
      append(session, 'approval/policy', { policy: 'never' })
    },
  }
  const context = {
    tools: {
      register(tool: CapturedTool): () => void {
        tools.set(tool.name, tool)
        return () => { tools.delete(tool.name) }
      },
    },
    commands: {
      register(command: CapturedCommand): () => void {
        commands.set(command.name, command)
        return () => { commands.delete(command.name) }
      },
    },
    effect(callback: () => unknown): void {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer as () => void)
    },
    get(name: string): unknown {
      if (name === 'agents') return agents.service
      if (name === 'sessions') return agents.sessions
      if (name === 'permission') return permission
      return undefined
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  }

  t.after(() => {
    store?.close()
    for (const dispose of disposers.reverse()) dispose()
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
    assert.equal(root.startsWith(tempPrefix), true, 'cleanup must stay inside the test-owned temp prefix')
    rmSync(root, { recursive: true, force: true })
  })

  process.env.DSH_HOME = root
  const plugin = await import('../lib/index.js')
  plugin.apply(context as never, {
    kingdomName: 'v1 vertical kingdom',
    ownerName: 'local owner',
    workerProvider: 'spawn',
    guiPort: 0,
    guiToken: '',
    guiAllowOrigins: ['*'],
    authMode: 'session-bound',
    migrateV4: true,
  }, {
    openLocalConsole(url: string) {
      launchUrl = url
      return true
    },
    // Supported dependency seams backed by fake DSH session events. This does
    // not replace or monkeypatch the product Capability Gate.
    loadS4Policy: async () => ({
      sandboxPolicy: { setSandboxMode: (session: unknown, mode: string) => append(session, 'sandbox/mode', { mode }) },
      approval: { setApprovalPolicy: (session: unknown, policy: string) => append(session, 'approval/policy', { policy }) },
    }),
  })

  const slash = commands.get('kingdom')
  assert.ok(slash, 'apply() must register the public /kingdom command')
  const activationAgent = { session: { id: ACTIVATION_SESSION } }
  const setupFixture = {
    territory_name: 'Vertical Territory',
    workspace_path: root,
    chancellor_name: 'Vertical Chancellor',
    supervisor_name: 'Vertical Supervisor',
    worker_name: 'Vertical Worker',
    worker_model: 'fake-requested-model',
    worker_provider: 'spawn',
  }
  const directOwner = async (rawInput: string): Promise<void> => {
    const result = await slash.handler({ rawInput })
    assert.equal(result.kind, 'success', `${rawInput}: ${result.text}`)
  }

  // Test-only organization pre-seeding enters the canonical direct Owner
  // Slash seam. The activation Agent supplies Role-plane identity only; it is
  // never treated as the Owner principal.
  await directOwner('init')
  store = new KingdomStore(dbPath, { allowSchemaV4: true })
  const kingdom = store.getDefaultKingdom()
  assert.ok(kingdom)
  await directOwner(`territory.create ${JSON.stringify({
    name: setupFixture.territory_name,
    workspace_path: setupFixture.workspace_path,
  })}`)
  await directOwner(`role.bind ${JSON.stringify({
    role_type: 'SUPERVISOR',
    role_name: setupFixture.supervisor_name,
    session_id: ACTIVATION_SESSION,
  })}`)
  await directOwner(`role.bind ${JSON.stringify({
    role_type: 'CHANCELLOR',
    role_name: setupFixture.chancellor_name,
    session_id: ACTIVATION_SESSION,
  })}`)
  await directOwner(`role.bind ${JSON.stringify({
    role_type: 'WORKER',
    role_name: setupFixture.worker_name,
  })}`)
  const territory = store.listTerritories(kingdom.kingdom_id)[0]!
  const supervisor = store.listBindings(kingdom.kingdom_id)
    .find(binding => binding.role_type === 'SUPERVISOR'
      && binding.role_name === setupFixture.supervisor_name)!
  const worker = store.listBindings(kingdom.kingdom_id)
    .find(binding => binding.role_type === 'WORKER'
      && binding.role_name === setupFixture.worker_name)!
  assert.ok(territory)
  assert.ok(supervisor)
  assert.ok(worker)
  await directOwner(`territory.supervisor ${JSON.stringify({
    territory_id: territory.territory_id,
    supervisor_binding_id: supervisor.binding_id,
  })}`)
  await directOwner(`execution-profile ${JSON.stringify({
    binding_id: worker.binding_id,
    provider: setupFixture.worker_provider,
    model: setupFixture.worker_model,
  })}`)
  await directOwner(`ceiling ${JSON.stringify({ ceiling: JSON.parse(CAPABILITY_JSON) })}`)

  const launched = await slash.handler({ rawInput: 'gui', agent: activationAgent })
  assert.equal(launched.kind, 'success')
  assert.doesNotMatch(launched.text, /ticket=/u)
  assert.match(launchUrl, /^http:\/\/127\.0\.0\.1:\d+\/console\?ticket=/u)
  const origin = new URL(launchUrl).origin

  const redeemed = await fetch(launchUrl, { redirect: 'manual' })
  assert.equal(redeemed.status, 303)
  assert.equal(redeemed.headers.get('location'), '/console')
  const cookie = (redeemed.headers.get('set-cookie') ?? '').split(';', 1)[0]!
  assert.match(cookie, /^dsh_kingdom_control=/u)

  const consoleResponse = await fetch(`${origin}/console`, { headers: { cookie } })
  assert.equal(consoleResponse.status, 200)
  const consoleHtml = await consoleResponse.text()
  assert.match(consoleHtml, /data-console-app/u)
  assert.match(consoleHtml, /aria-label="任务导航器"/u)
  assert.match(consoleHtml, /'#task=' \+ encodeURIComponent/u)

  const inspected = await fetch(`${origin}/api/control`, { headers: { cookie } })
  assert.equal(inspected.status, 200)
  const control = await inspected.json() as { csrfToken: string; commands: string[] }
  assert.ok(control.csrfToken)
  assert.equal(control.commands.includes('setup.basic'), false,
    'browser control must not advertise Owner-only setup.basic')
  for (const command of ['plan', 'assign', 'start', 'review',
    'execution.pause', 'execution.resume', 'execution.abort']) {
    assert.ok(control.commands.includes(command), `active GUI control must advertise ${command}`)
  }

  let requestNo = 0
  const postRaw = async (
    name: string,
    payload: Record<string, unknown>,
    requestId = `v1-vertical-${++requestNo}`,
  ): Promise<HttpResult> => {
    const response = await fetch(`${origin}/api/commands/${name}`, {
      method: 'POST',
      headers: {
        origin,
        cookie,
        'content-type': 'application/json',
        'x-kingdom-client': 'v1-vertical-test',
        'x-kingdom-csrf': control.csrfToken,
        'x-kingdom-request-id': requestId,
      },
      body: JSON.stringify(payload),
    })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  const postOk = async (name: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const result = await postRaw(name, payload)
    assert.equal(result.status, 200, `${name}: ${JSON.stringify(result.body)}`)
    assert.equal(result.body.ok, true, `${name}: ${JSON.stringify(result.body)}`)
    return result.body
  }

  const setupRevision = store.revision(kingdom.kingdom_id)
  const deniedSetup = await postRaw('setup.basic', setupFixture)
  assert.equal(deniedSetup.status, 403)
  assert.equal(deniedSetup.body.ok, false)
  assert.equal(deniedSetup.body.errorCode, 'DIRECT_SLASH_REQUIRED')
  assert.equal(store.revision(kingdom.kingdom_id), setupRevision,
    'browser setup.basic denial must be zero-effect')

  assert.equal(store.isSchemaV4, true, 'only the fresh temporary database may be schema v4')
  assert.equal(store.getBindingByRole(kingdom.kingdom_id, 'OWNER')!.session_id, null)
  assert.equal(worker.session_id, null)
  const profiledWorker = store.getBindingById(worker.binding_id)!
  assert.deepEqual(JSON.parse(String(profiledWorker.execution_profile_json)), {
    model: 'fake-requested-model', provider: 'spawn',
  }, 'model is requested fixture data only; effective model remains UNKNOWN')

  const snapshotResponse = await fetch(`${origin}/api/snapshot`, { headers: { cookie } })
  assert.equal(snapshotResponse.status, 200)
  const snapshot = await snapshotResponse.json() as {
    projection: { overview: { data: { ownerActions: Array<{
      executable: boolean
      disabledReason: { code: string } | null
    }> } } }
  }
  const ownerActions = snapshot.projection.overview.data.ownerActions
  assert.ok(ownerActions.length > 0)
  assert.ok(ownerActions.every(action => action.executable === false
    && action.disabledReason?.code === 'DIRECT_SLASH_REQUIRED'))

  const ownerRevision = store.revision(kingdom.kingdom_id)
  const ownerOnly = await postRaw('init', {})
  assert.equal(ownerOnly.status, 403)
  assert.equal(ownerOnly.body.ok, false)
  assert.equal(ownerOnly.body.errorCode, 'DIRECT_SLASH_REQUIRED')
  assert.match(String(ownerOnly.body.message), /direct.*\/kingdom.*Slash|直接.*\/kingdom.*Slash/iu)
  assert.equal(store.revision(kingdom.kingdom_id), ownerRevision, 'GUI Owner-only attempt must be zero-effect')

  for (const [field, value] of [
    ['session_id', 'forged-browser-principal'],
    ['owner_capability', 'forged-owner-capability'],
  ] as const) {
    const forged = await postRaw('plan', {
      title: 'must not be created',
      territory_id: territory.territory_id,
      [field]: value,
    })
    assert.equal(forged.status, 400)
    assert.equal(forged.body.errorCode, 'INVALID_BODY')
    assert.match(String(forged.body.message), new RegExp(field, 'u'))
    assert.equal(store.revision(kingdom.kingdom_id), ownerRevision,
      `browser ${field} injection must be zero-effect`)
  }

  // HANDOFF needs a second real domain Worker. Create only that fixture through
  // the canonical direct Slash boundary; the GUI remains unable to bind roles.
  const bound = await slash.handler({
    rawInput: `role.bind ${JSON.stringify({ role_type: 'WORKER', role_name: 'Vertical Handoff Worker' })}`,
    agent: activationAgent,
  })
  assert.equal(bound.kind, 'success', bound.text)
  const handoffWorker = store.listBindings(kingdom.kingdom_id)
    .find(binding => binding.role_type === 'WORKER' && binding.role_name === 'Vertical Handoff Worker')!
  assert.ok(handoffWorker)
  assert.equal(handoffWorker.session_id, null)

  const createAssignedTask = async (title: string): Promise<string> => {
    const planned = await postOk('plan', {
      title,
      acceptance_criteria: 'A completed fake terminal event and bounded assistant Claim',
      territory_id: territory.territory_id,
    })
    const taskId = (planned.task as { taskId?: string } | null)?.taskId
    assert.ok(taskId)
    await postOk('assign', { task_id: taskId, worker_binding_id: worker.binding_id })
    assert.equal(store!.getTask(taskId)!.status, 'ASSIGNED')
    assert.equal(store!.getTaskCapabilityRequirement(taskId), CAPABILITY_JSON)
    return taskId
  }

  const startToReview = async (taskId: string, verifySandboxRejection = false): Promise<void> => {
    if (verifySandboxRejection) {
      const revisionBeforeInvalid = store!.revision(kingdom.kingdom_id)
      const followupsBeforeInvalid = agents.followupCount()
      const invalidSandbox = await postRaw('start', {
        task_id: taskId,
        grant_json: CAPABILITY_JSON,
        sandbox_mode: 'danger-full-access',
      })
      assert.equal(invalidSandbox.status, 409)
      assert.equal(invalidSandbox.body.ok, false)
      assert.equal(invalidSandbox.body.errorCode, 'INVALID_INPUT')
      assert.match(String(invalidSandbox.body.message), /INVALID_SANDBOX_MODE/u)
      assert.equal(store!.getTask(taskId)!.status, 'ASSIGNED')
      assert.equal(store!.listExecutions(taskId).length, 0)
      assert.equal(store!.listWorkerResults(taskId).length, 0)
      assert.equal(store!.revision(kingdom.kingdom_id), revisionBeforeInvalid)
      assert.equal(agents.followupCount(), followupsBeforeInvalid)
      assert.equal(agents.sessionRefs().length, 0,
        'invalid sandbox mode must reject before fake Worker Session preparation')
    }
    const started = await postOk('start', {
      task_id: taskId,
      grant_json: CAPABILITY_JSON,
      sandbox_mode: 'workspace-write',
    })
    assert.match(String(started.message), /Claim/u)
    assert.match(String(started.message), /REVIEW/u)
    assert.equal(store!.getTask(taskId)!.status, 'REVIEW', 'Runtime completion only creates a Claim')
    assert.equal(store!.listWorkerResults(taskId).length, 1)
  }

  const acceptedTask = await createAssignedTask('v1 ACCEPT mainline')
  const taskDetailPath = `${origin}/api/tasks/${encodeURIComponent(acceptedTask)}`
  const taskDetailRevision = store.revision(kingdom.kingdom_id)
  const taskDetailResponse = await fetch(taskDetailPath, { headers: { cookie } })
  assert.equal(taskDetailResponse.status, 200)
  const taskDetail = await taskDetailResponse.json() as {
    projection: { data: { actionAvailability: Array<{
      action: string
      executable: boolean
      disabledReason: { code: string } | null
    }> } }
  }
  const startAvailability = taskDetail.projection.data.actionAvailability
    .find(action => action.action === 'start')
  assert.ok(startAvailability)
  assert.equal(startAvailability.executable, true,
    'valid Supervisor control cookie must make the legal ASSIGNED -> start action executable')
  assert.equal(startAvailability.disabledReason, null)

  const missingCookieDetail = await fetch(taskDetailPath)
  assert.equal(missingCookieDetail.status, 401)
  const missingCookieBody = await missingCookieDetail.json() as { errorCode?: string }
  assert.equal(missingCookieBody.errorCode, 'CONTROL_SESSION_REQUIRED')
  assert.equal(store.revision(kingdom.kingdom_id), taskDetailRevision,
    'Task Detail without a control cookie must be zero-effect')

  const wrongCookieDetail = await fetch(taskDetailPath, {
    headers: { cookie: 'dsh_kingdom_control=forged-v1-vertical-cookie' },
  })
  assert.equal(wrongCookieDetail.status, 401)
  const wrongCookieBody = await wrongCookieDetail.json() as { errorCode?: string }
  assert.equal(wrongCookieBody.errorCode, 'CONTROL_SESSION_REQUIRED')
  assert.equal(store.revision(kingdom.kingdom_id), taskDetailRevision,
    'Task Detail with a forged control cookie must fail closed and remain zero-effect')

  await startToReview(acceptedTask, true)
  await postOk('review', { task_id: acceptedTask, decision: 'ACCEPT' })
  assert.equal(store.getTask(acceptedTask)!.status, 'DONE', 'only ACCEPT may create DONE')
  assert.equal(store.getActiveAssignmentForTask(acceptedTask), null)

  const handoffTask = await createAssignedTask('v1 HANDOFF mainline')
  await startToReview(handoffTask)
  const originalAssignment = store.getActiveAssignmentForTask(handoffTask)!
  const beforeInvalidHandoff = store.revision(kingdom.kingdom_id)
  const invalidHandoff = await postRaw('review', {
    task_id: handoffTask,
    decision: 'HANDOFF',
    reason: 'self handoff must be rejected',
    to_binding_id: worker.binding_id,
  })
  assert.equal(invalidHandoff.status, 409)
  assert.equal(invalidHandoff.body.errorCode, 'INVALID_INPUT')
  assert.match(String(invalidHandoff.body.message), /相同/u)
  assert.equal(store.revision(kingdom.kingdom_id), beforeInvalidHandoff)
  assert.equal(store.getActiveAssignmentForTask(handoffTask)!.assignment_id, originalAssignment.assignment_id)

  await postOk('review', {
    task_id: handoffTask,
    decision: 'HANDOFF',
    reason: 'route the reviewed Claim to the replacement Worker',
    to_binding_id: handoffWorker.binding_id,
  })
  assert.equal(store.getTask(handoffTask)!.status, 'RUNNING')
  assert.equal(store.getTask(handoffTask)!.assigned_binding_id, handoffWorker.binding_id)
  const replacementAssignment = store.getActiveAssignmentForTask(handoffTask)!
  assert.equal(replacementAssignment.worker_binding_id, handoffWorker.binding_id)
  assert.equal(replacementAssignment.previous_assignment_id, originalAssignment.assignment_id)
  const closedAssignment = store.listTaskAssignments(handoffTask)
    .find(assignment => assignment.assignment_id === originalAssignment.assignment_id)!
  assert.equal(closedAssignment.end_reason, 'handoff')
  assert.ok(closedAssignment.ended_at)

  const controlTask = await createAssignedTask('v1 execution control states')
  store.transitionTask(store.getTask(controlTask)!, 'RUNNING')
  const executionId = 'v1-vertical-control-fixture'
  const startedAt = new Date().toISOString()
  // A synchronous public governed start waits for terminal evidence before its
  // HTTP mutation settles. Seed only the live-state precondition so the three
  // control commands themselves can still be verified through public HTTP.
  // This row is explicitly test-fixture/LEGACY_COMPAT, never Runtime evidence.
  store.insertExecution({
    execution_id: executionId,
    task_id: controlTask,
    attempt_no: 1,
    worker_binding_id: worker.binding_id,
    session_id: null,
    state: 'RUNNING',
    detail: 'synthetic live-state precondition; not DSH evidence',
    started_at: startedAt,
    heartbeat_at: null,
    ended_at: null,
    pause_requested_at: null,
    executor_kind: 'vertical-test-fixture',
    provider: null,
    provider_source: null,
    requested_model: null,
    resolved_model: null,
    model_source: null,
    execution_profile_json: null,
    execution_contract: 'LEGACY_COMPAT',
    lease_id: null,
    capability_decision_id: null,
  })

  await postOk('execution.pause', { execution_id: executionId, reason: 'bounded legal pause' })
  assert.equal(store.getExecution(executionId)!.state, 'RUNNING',
    'a live one-shot attempt must not be presented as physically paused')
  assert.ok(store.getExecution(executionId)!.pause_requested_at,
    'legal pause records a pending boundary request')
  await postOk('execution.resume', { execution_id: executionId, reason: 'bounded legal resume' })
  assert.equal(store.getExecution(executionId)!.state, 'RUNNING')
  assert.equal(store.getExecution(executionId)!.pause_requested_at, null)
  await postOk('execution.abort', { execution_id: executionId, reason: 'bounded legal abort' })
  assert.equal(store.getExecution(executionId)!.state, 'ABORTED')
  assert.equal(store.getTask(controlTask)!.status, 'RUNNING', 'abort changes Runtime fact, not Task governance')

  const terminalSnapshot = JSON.stringify(store.getExecution(executionId))
  const terminalRevision = store.revision(kingdom.kingdom_id)
  const terminalEvents = store.listEvents(kingdom.kingdom_id, 1000).length
  for (const action of ['pause', 'resume', 'abort'] as const) {
    const rejected = await postRaw(`execution.${action}`, {
      execution_id: executionId,
      reason: `illegal ${action} after terminal`,
    })
    assert.equal(rejected.status, 409)
    assert.equal(rejected.body.errorCode, 'ILLEGAL_EXECUTION_STATE')
  }
  assert.equal(JSON.stringify(store.getExecution(executionId)), terminalSnapshot)
  assert.equal(store.revision(kingdom.kingdom_id), terminalRevision)
  assert.equal(store.listEvents(kingdom.kingdom_id, 1000).length, terminalEvents)

  assert.equal(agents.sessionRefs().length, 1, 'public starts reuse one persistent fake Worker session')
  assert.equal(agents.followupCount(), 2, 'only the two governed starts dispatch to fake agents')
  const stopped = await slash.handler({ rawInput: 'gui stop', agent: activationAgent })
  assert.equal(stopped.kind, 'success')
})
