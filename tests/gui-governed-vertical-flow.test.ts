/**
 * v0.9 public GUI thin-slice vertical verification.
 *
 * A fresh temporary DSH_HOME, loopback HTTP server, real control admission,
 * public command handler, and public governed start path are used. The Agent
 * terminal events and DSH enforcement functions are process-local fakes, so
 * this proves product orchestration and governance transitions, not real
 * DSH/Provider compatibility or effective-model identity.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KingdomStore } from '../lib/core/db.js'

const CAPABILITY_JSON = '{"tool:pwsh":true}'
const ACTIVATION_SESSION = 'vertical-activation-session'

interface CapturedTool {
  name: string
  execute(args: Record<string, unknown>, exec: Record<string, unknown>): Promise<unknown>
}

interface CapturedCommand {
  name: string
  handler(invocation: { rawInput: string; agent?: unknown }): Promise<{ kind: string; text: string }>
}

type FakeEvent = { type: string; data?: Record<string, unknown> }
type FakeSession = { id: string; header: { cwd: string }; events: FakeEvent[]; status: 'idle' | 'running' }

function append(session: unknown, type: string, data: Record<string, unknown>): void {
  const target = session as FakeSession
  target.events.push({ type, data })
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
        data: { text: `vertical claim ${turn}: acceptance evidence supplied` },
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

test('loopback GUI reaches REVIEW and preserves ACCEPT/REWORK/FAIL governance', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-kingdom-v09-vertical-'))
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
    rmSync(root, { recursive: true, force: true })
  })

  process.env.DSH_HOME = root
  const plugin = await import('../lib/index.js')
  plugin.apply(context as never, {
    kingdomName: 'v0.9 vertical kingdom',
    ownerName: 'local owner',
    workerProvider: 'spawn',
    guiPort: 0,
    guiToken: '',
    guiAllowOrigins: ['*'],
    authMode: 'session-bound',
    migrateV4: true,
  }, {
    openLocalConsole(url) {
      launchUrl = url
      return true
    },
    loadS4Policy: async () => ({
      sandboxPolicy: { setSandboxMode: (session, mode) => append(session, 'sandbox/mode', { mode }) },
      approval: { setApprovalPolicy: (session, policy) => append(session, 'approval/policy', { policy }) },
    }),
  })

  const slash = commands.get('kingdom')
  assert.ok(slash)
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

  // Pre-seed only through the canonical direct Owner Slash seam. The
  // activation Agent is a Role-plane principal and never becomes Owner.
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
  const inspected = await fetch(`${origin}/api/control`, { headers: { cookie } })
  assert.equal(inspected.status, 200, 'same-origin GET without Origin remains inspectable')
  const control = await inspected.json() as { csrfToken: string; commands: string[] }
  assert.ok(control.csrfToken)
  assert.equal(control.commands.includes('setup.basic'), false,
    'browser control must not advertise Owner-only setup.basic')

  let requestNo = 0
  const postRaw = async (name: string, payload: Record<string, unknown>): Promise<{
    status: number
    body: Record<string, unknown>
  }> => {
    requestNo++
    const response = await fetch(`${origin}/api/commands/${name}`, {
      method: 'POST',
      headers: {
        origin,
        cookie,
        'content-type': 'application/json',
        'x-kingdom-client': 'vertical-test',
        'x-kingdom-csrf': control.csrfToken,
        'x-kingdom-request-id': `vertical-${requestNo}`,
      },
      body: JSON.stringify(payload),
    })
    const body = await response.json() as Record<string, unknown>
    return { status: response.status, body }
  }
  const post = async (name: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const result = await postRaw(name, payload)
    assert.equal(result.status, 200, `${name}: ${JSON.stringify(result.body)}`)
    const body = result.body
    assert.equal(body.ok, true, `${name}: ${JSON.stringify(body)}`)
    return body
  }

  const setupRevision = store.revision(kingdom.kingdom_id)
  const deniedSetup = await postRaw('setup.basic', setupFixture)
  assert.equal(deniedSetup.status, 403)
  assert.equal(deniedSetup.body.ok, false)
  assert.equal(deniedSetup.body.errorCode, 'DIRECT_SLASH_REQUIRED')
  assert.equal(store.revision(kingdom.kingdom_id), setupRevision,
    'browser setup.basic denial must be zero-effect')

  assert.equal(store.isSchemaV4, true)
  assert.equal(store.getBindingByRole(kingdom.kingdom_id, 'OWNER')!.session_id, null)
  assert.equal(worker.session_id, null)
  const profiledWorker = store.getBindingById(worker.binding_id)!
  assert.deepEqual(JSON.parse(profiledWorker.execution_profile_json!), {
    model: 'fake-requested-model', provider: 'spawn',
  })

  const createAssignedTask = async (title: string): Promise<string> => {
    const planned = await post('plan', {
      title,
      acceptance_criteria: 'A completed fake terminal event and bounded assistant Claim',
      territory_id: territory.territory_id,
    })
    const taskId = (planned.task as { taskId?: string } | null)?.taskId
    assert.ok(taskId)
    await post('assign', { task_id: taskId, worker_binding_id: worker.binding_id })
    assert.equal(store!.getTask(taskId)!.status, 'ASSIGNED')
    assert.equal(store!.getTaskCapabilityRequirement(taskId), CAPABILITY_JSON)
    return taskId
  }

  const startToReview = async (taskId: string): Promise<void> => {
    const started = await post('start', {
      task_id: taskId,
      grant_json: CAPABILITY_JSON,
      sandbox_mode: 'workspace-write',
    })
    assert.match(String(started.message), /Claim/u)
    assert.match(String(started.message), /REVIEW/u)
    assert.equal(store!.getTask(taskId)!.status, 'REVIEW')
    assert.equal(store!.listWorkerResults(taskId).length > 0, true)
  }

  const acceptedTask = await createAssignedTask('Vertical ACCEPT')
  await startToReview(acceptedTask)
  await post('review', { task_id: acceptedTask, decision: 'ACCEPT' })
  assert.equal(store.getTask(acceptedTask)!.status, 'DONE')

  const reworkedTask = await createAssignedTask('Vertical REWORK')
  await startToReview(reworkedTask)
  const workerSessionBeforeRework = store.getBindingById(worker.binding_id)!.session_id
  await post('review', {
    task_id: reworkedTask,
    decision: 'REWORK',
    reason: 'exercise the bounded correction path',
  })
  assert.equal(store.getTask(reworkedTask)!.status, 'RUNNING')
  await startToReview(reworkedTask)
  assert.equal(store.getBindingById(worker.binding_id)!.session_id, workerSessionBeforeRework)
  assert.equal(store.listWorkerResults(reworkedTask).length, 2)

  const failedTask = await createAssignedTask('Vertical FAIL')
  await startToReview(failedTask)
  await post('review', {
    task_id: failedTask,
    decision: 'FAIL',
    reason: 'claim does not meet the product criterion',
  })
  assert.equal(store.getTask(failedTask)!.status, 'FAILED')

  assert.equal(agents.sessionRefs().length, 1, 'same Worker and Territory reuse one persistent fake session')
  assert.equal(agents.followupCount(), 4)
  const stopped = await slash.handler({ rawInput: 'gui stop', agent: activationAgent })
  assert.equal(stopped.kind, 'success')
})
