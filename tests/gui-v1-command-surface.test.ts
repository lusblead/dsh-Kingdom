/**
 * v1 GUI command-surface regression.
 *
 * This uses a fresh temporary DSH_HOME and process-local fake Agent/runtime
 * services. It proves the loopback Adapter/Core path only; it does not prove a
 * real Provider, effective model, or production database behavior.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { bindRole } from '../lib/core/binding.js'
import { KingdomStore } from '../lib/core/db.js'
import { issueOwnerControlCapability, ownerControlAuth } from '../lib/core/owner-control.js'

const CAPABILITY_JSON = '{"tool:pwsh":true}'
const OWNER_ROLE_SESSION = 'v1-command-owner-role-session'

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
  ;(session as FakeSession).events.push({ type, data })
}

function fakeAgents(): {
  service: Record<string, unknown>
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
      this.session.events.push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
      this.session.events.push({
        type: 'assistant/message',
        data: { text: `v1 command claim ${turn}: bounded acceptance evidence` },
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
  return {
    service: {
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
    },
    sessions: { get: (id: string) => sessions.get(id) },
    registerAgent,
    followupCount: () => followups,
    sessionRefs: () => [...workerSessionIds],
  }
}

interface ControlClient {
  origin: string
  cookie: string
  csrf: string
}

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

test('v1 GUI command surface is session-bound, state-safe, replay-safe, and direct-Slash fenced', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-kingdom-v1-command-'))
  const previousDshHome = process.env.DSH_HOME
  const tools = new Map<string, CapturedTool>()
  const commands = new Map<string, CapturedCommand>()
  const disposers: Array<() => void> = []
  const agents = fakeAgents()
  agents.registerAgent(OWNER_ROLE_SESSION, 'running')
  const appliedSandboxModes: string[] = []
  let launchUrl = ''
  let store: KingdomStore | null = null
  let requestNo = 0

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
    kingdomName: 'v1 command kingdom',
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
      sandboxPolicy: {
        setSandboxMode(session, mode) {
          appliedSandboxModes.push(mode)
          append(session, 'sandbox/mode', { mode })
        },
      },
      approval: { setApprovalPolicy: (session, policy) => append(session, 'approval/policy', { policy }) },
    }),
  })

  const slash = commands.get('kingdom')
  assert.ok(slash)

  const activate = async (sessionId: string): Promise<ControlClient> => {
    const launched = await slash.handler({ rawInput: 'gui', agent: { session: { id: sessionId } } })
    assert.equal(launched.kind, 'success')
    const origin = new URL(launchUrl).origin
    const redeemed = await fetch(launchUrl, { redirect: 'manual' })
    assert.equal(redeemed.status, 303)
    const cookie = (redeemed.headers.get('set-cookie') ?? '').split(';', 1)[0]!
    const inspected = await fetch(`${origin}/api/control`, { headers: { cookie } })
    assert.equal(inspected.status, 200)
    const control = await inspected.json() as {
      csrfToken: string
      commands: string[]
      reviewDecisions: string[]
      sandboxModes: string[]
      actions: Record<string, { executable: boolean; disabledReason: string | null }>
    }
    assert.deepEqual(control.commands, [
      'plan', 'assign', 'start', 'review',
      'execution.pause', 'execution.resume', 'execution.abort', 'control.revoke',
    ])
    assert.deepEqual(control.reviewDecisions, ['ACCEPT', 'REWORK', 'FAIL', 'HANDOFF'])
    assert.deepEqual(control.sandboxModes, ['workspace-write', 'read-only'])
    assert.equal(control.actions['setup.basic'], undefined)
    assert.equal(control.actions['review:handoff']?.executable, true)
    assert.equal(control.actions['execution:pause']?.executable, true)
    assert.equal(control.actions.init?.executable, false)
    assert.equal(control.actions.init?.disabledReason, 'DIRECT_SLASH_REQUIRED')
    return { origin, cookie, csrf: control.csrfToken }
  }

  const send = async (
    client: ControlClient,
    name: string,
    payload: Record<string, unknown>,
    requestId = `v1-command-${++requestNo}`,
  ): Promise<HttpResult> => {
    const response = await fetch(`${client.origin}/api/commands/${name}`, {
      method: 'POST',
      headers: {
        origin: client.origin,
        cookie: client.cookie,
        'content-type': 'application/json',
        'x-kingdom-client': 'v1-command-test',
        'x-kingdom-csrf': client.csrf,
        'x-kingdom-request-id': requestId,
      },
      body: JSON.stringify(payload),
    })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }

  const expectSuccess = async (
    client: ControlClient,
    name: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<Record<string, unknown>> => {
    const result = await send(client, name, payload, requestId)
    assert.equal(result.status, 200, `${name}: ${JSON.stringify(result.body)}`)
    assert.equal(result.body.ok, true, `${name}: ${JSON.stringify(result.body)}`)
    return result.body
  }

  const ownerClient = await activate(OWNER_ROLE_SESSION)
  const deniedSetup = await send(ownerClient, 'setup.basic', {
    territory_name: 'Command Territory',
    workspace_path: root,
    chancellor_name: 'Command Chancellor',
    supervisor_name: 'Command Supervisor',
    worker_name: 'Command Worker A',
    worker_model: 'fake-requested-model',
    worker_provider: 'spawn',
  })
  assert.equal(deniedSetup.status, 403)
  assert.equal(deniedSetup.body.errorCode, 'DIRECT_SLASH_REQUIRED')

  store = new KingdomStore(join(root, 'kingdom', 'kingdom.db'), { allowSchemaV4: true })
  assert.equal(store.getDefaultKingdom(), null, 'denied setup.basic must not initialize or configure a Kingdom')

  const directOwner = async (rawInput: string): Promise<string> => {
    const result = await slash.handler({ rawInput })
    assert.equal(result.kind, 'success', `${rawInput}: ${result.text}`)
    return result.text
  }
  await directOwner('init')
  await directOwner(`territory.create ${JSON.stringify({ name: 'Command Territory', workspace_path: root })}`)
  await directOwner(`role.bind ${JSON.stringify({
    role_type: 'SUPERVISOR', role_name: 'Command Supervisor', session_id: OWNER_ROLE_SESSION,
  })}`)
  await directOwner(`role.bind ${JSON.stringify({
    role_type: 'CHANCELLOR', role_name: 'Command Chancellor', session_id: OWNER_ROLE_SESSION,
  })}`)
  await directOwner(`role.bind ${JSON.stringify({ role_type: 'WORKER', role_name: 'Command Worker A' })}`)

  const kingdom = store.getDefaultKingdom()!
  const territory = store.listTerritories(kingdom.kingdom_id)[0]!
  const workerA = store.getBindingByRole(kingdom.kingdom_id, 'WORKER')!
  const supervisor = store.getBindingByRole(kingdom.kingdom_id, 'SUPERVISOR')!
  await directOwner(`territory.supervisor ${JSON.stringify({
    territory_id: territory.territory_id, supervisor_binding_id: supervisor.binding_id,
  })}`)
  await directOwner(`execution-profile ${JSON.stringify({
    binding_id: workerA.binding_id, provider: 'spawn', model: 'fake-requested-model',
  })}`)
  await directOwner(`ceiling ${JSON.stringify({ ceiling: { 'tool:pwsh': true } })}`)

  const fixtureOwnerAuth = ownerControlAuth(issueOwnerControlCapability())
  assert.match(bindRole(store, {
    kingdomId: kingdom.kingdom_id,
    roleType: 'WORKER',
    roleName: 'Command Worker B',
  }, fixtureOwnerAuth), /^已绑定角色/u)
  const workerB = store.getBindingsByRole(kingdom.kingdom_id, 'WORKER')
    .find(binding => binding.role_name === 'Command Worker B')!

  const createAssignedTask = async (title: string): Promise<string> => {
    const planned = await expectSuccess(ownerClient, 'plan', {
      title,
      territory_id: territory.territory_id,
      acceptance_criteria: 'bounded v1 command evidence',
    })
    const taskId = (planned.task as { taskId?: string } | null)?.taskId
    assert.ok(taskId)
    await expectSuccess(ownerClient, 'assign', {
      task_id: taskId,
      worker_binding_id: workerA.binding_id,
    })
    return taskId
  }

  const handoffTaskId = await createAssignedTask('GUI HANDOFF')
  const anonymousTaskRead = await fetch(`${ownerClient.origin}/api/tasks/${handoffTaskId}`)
  assert.equal(anonymousTaskRead.status, 401)
  const forgedTaskRead = await fetch(`${ownerClient.origin}/api/tasks/${handoffTaskId}`, {
    headers: { cookie: 'dsh_kingdom_control=forged-browser-cookie' },
  })
  assert.equal(forgedTaskRead.status, 401)
  const foreignTaskRead = await fetch(`${ownerClient.origin}/api/tasks/${handoffTaskId}`, {
    headers: { origin: 'http://evil.example', cookie: ownerClient.cookie },
  })
  assert.equal(foreignTaskRead.status, 403)
  const controlledTaskRead = await fetch(`${ownerClient.origin}/api/tasks/${handoffTaskId}`, {
    headers: { cookie: ownerClient.cookie },
  })
  assert.equal(controlledTaskRead.status, 200)
  const controlledTaskDetail = await controlledTaskRead.json() as {
    projection?: { data?: { actionAvailability?: Array<{ action: string; executable: boolean }> } }
  }
  assert.ok(controlledTaskDetail.projection?.data?.actionAvailability?.some(
    action => action.action === 'start' && action.executable,
  ), 'broker-originated read context should enable only the in-scope Supervisor action')

  const handoffAssigned = store.getTask(handoffTaskId)!
  const handoffRunning = store.transitionTask(handoffAssigned, 'RUNNING')
  store.insertWorkerResult({
    result_id: 'v1-command-handoff-claim',
    task_id: handoffTaskId,
    attempt_no: 1,
    worker_binding_id: workerA.binding_id,
    session_id: null,
    outcome: 'COMPLETED',
    result_json: JSON.stringify({ summary: 'handoff candidate claim' }),
    created_at: new Date().toISOString(),
  })
  store.transitionTask(handoffRunning, 'REVIEW', { result_summary: 'handoff candidate claim' })
  const originalAssignment = store.getActiveAssignmentForTask(handoffTaskId)!
  const revisionBeforeMissingTarget = store.revision(kingdom.kingdom_id)
  const missingTarget = await send(ownerClient, 'review', {
    task_id: handoffTaskId,
    decision: 'HANDOFF',
    reason: 'move to a different Worker',
  })
  assert.equal(missingTarget.status, 409)
  assert.equal(missingTarget.body.errorCode, 'INVALID_INPUT')
  assert.equal(store.revision(kingdom.kingdom_id), revisionBeforeMissingTarget)
  assert.equal(store.getTask(handoffTaskId)!.status, 'REVIEW')
  assert.equal(store.getActiveAssignmentForTask(handoffTaskId)!.assignment_id, originalAssignment.assignment_id)

  const handed = await expectSuccess(ownerClient, 'review', {
    task_id: handoffTaskId,
    decision: 'HANDOFF',
    reason: 'move to a different Worker',
    to_binding_id: workerB.binding_id,
  })
  assert.match(String(handed.message), /HANDOFF/u)
  assert.equal(store.getTask(handoffTaskId)!.status, 'RUNNING')
  assert.equal(store.getTask(handoffTaskId)!.assigned_binding_id, workerB.binding_id)
  const newAssignment = store.getActiveAssignmentForTask(handoffTaskId)!
  assert.equal(newAssignment.previous_assignment_id, originalAssignment.assignment_id)
  assert.equal(store.listTaskAssignments(handoffTaskId).length, 2)

  const executionTaskId = await createAssignedTask('GUI execution control')
  const executionTask = store.transitionTask(store.getTask(executionTaskId)!, 'RUNNING')
  const executionId = 'v1-command-live-execution'
  const startedAt = new Date().toISOString()
  store.insertExecution({
    execution_id: executionId,
    task_id: executionTask.task_id,
    attempt_no: 1,
    worker_binding_id: workerA.binding_id,
    session_id: null,
    state: 'STARTING',
    detail: null,
    started_at: startedAt,
    heartbeat_at: null,
    ended_at: null,
    pause_requested_at: null,
    executor_kind: 'v1-command-fixture',
    provider: null,
    provider_source: null,
    requested_model: null,
    resolved_model: null,
    model_source: null,
    execution_profile_json: null,
    // Synthetic live-state fixture only: no matching Lease/Capability/Dispatch
    // evidence exists, so it must never claim governed runtime provenance.
    execution_contract: 'LEGACY_COMPAT',
    lease_id: null,
    capability_decision_id: null,
  })

  const pauseRequestId = 'v1-command-pause-once'
  await expectSuccess(ownerClient, 'execution.pause', {
    execution_id: executionId,
    reason: 'bounded pause',
  }, pauseRequestId)
  assert.equal(store.getExecution(executionId)!.state, 'PAUSED')
  const revisionAfterPause = store.revision(kingdom.kingdom_id)

  const replay = await send(ownerClient, 'execution.pause', {
    execution_id: executionId,
    reason: 'must not run twice',
  }, pauseRequestId)
  assert.equal(replay.status, 409)
  assert.equal(replay.body.errorCode, 'CONTROL_REPLAY_DENIED')
  assert.equal(store.revision(kingdom.kingdom_id), revisionAfterPause)

  const illegalPause = await send(ownerClient, 'execution.pause', { execution_id: executionId })
  assert.equal(illegalPause.status, 409)
  assert.equal(illegalPause.body.errorCode, 'ILLEGAL_EXECUTION_STATE')
  assert.equal(store.revision(kingdom.kingdom_id), revisionAfterPause)

  await expectSuccess(ownerClient, 'execution.resume', { execution_id: executionId })
  assert.equal(store.getExecution(executionId)!.state, 'RUNNING')
  await expectSuccess(ownerClient, 'execution.abort', {
    execution_id: executionId,
    reason: 'bounded abort',
  })
  assert.equal(store.getExecution(executionId)!.state, 'ABORTED')
  const revisionAfterAbort = store.revision(kingdom.kingdom_id)
  const resumeAborted = await send(ownerClient, 'execution.resume', { execution_id: executionId })
  assert.equal(resumeAborted.status, 409)
  assert.equal(resumeAborted.body.errorCode, 'ILLEGAL_EXECUTION_STATE')
  assert.equal(store.revision(kingdom.kingdom_id), revisionAfterAbort)

  const sandboxTaskId = await createAssignedTask('GUI sandbox selection')
  const followupsBeforeInvalid = agents.followupCount()
  const invalidSandbox = await send(ownerClient, 'start', {
    task_id: sandboxTaskId,
    grant_json: CAPABILITY_JSON,
    sandbox_mode: 'network-admin',
  })
  assert.equal(invalidSandbox.status, 409)
  assert.equal(invalidSandbox.body.errorCode, 'INVALID_INPUT')
  assert.match(String(invalidSandbox.body.message), /INVALID_SANDBOX_MODE/u)
  assert.equal(store.getTask(sandboxTaskId)!.status, 'ASSIGNED')
  assert.equal(store.listExecutions(sandboxTaskId).length, 0)
  assert.equal(agents.followupCount(), followupsBeforeInvalid)

  const readOnlyStart = await expectSuccess(ownerClient, 'start', {
    task_id: sandboxTaskId,
    grant_json: CAPABILITY_JSON,
    sandbox_mode: 'read-only',
  })
  assert.match(String(readOnlyStart.message), /Claim/u)
  assert.equal(store.getTask(sandboxTaskId)!.status, 'REVIEW')
  assert.equal(appliedSandboxModes.at(-1), 'read-only')

  const ownerRevision = store.revision(kingdom.kingdom_id)
  const ownerOnly = await send(ownerClient, 'init', {})
  assert.equal(ownerOnly.status, 403)
  assert.equal(ownerOnly.body.errorCode, 'DIRECT_SLASH_REQUIRED')
  assert.equal(store.revision(kingdom.kingdom_id), ownerRevision)
  assert.equal(store.getBindingByRole(kingdom.kingdom_id, 'OWNER')!.session_id, null)

  const taskCountBeforeIntruder = store.listTasks(kingdom.kingdom_id).length
  const revisionBeforeIntruder = store.revision(kingdom.kingdom_id)
  const intruderClient = await activate('v1-command-intruder-session')
  const unauthorized = await send(intruderClient, 'plan', {
    title: 'must not be created',
    territory_id: territory.territory_id,
  })
  assert.equal(unauthorized.status, 409)
  assert.equal(unauthorized.body.errorCode, 'UNAUTHORIZED_PRINCIPAL')
  assert.equal(store.listTasks(kingdom.kingdom_id).length, taskCountBeforeIntruder)
  assert.equal(store.revision(kingdom.kingdom_id), revisionBeforeIntruder)

  const revoked = await send(intruderClient, 'control.revoke', {})
  assert.equal(revoked.status, 200)
  assert.equal(revoked.body.ok, true)
  const revisionAfterRevoke = store.revision(kingdom.kingdom_id)
  const afterRevoke = await send(intruderClient, 'plan', {
    title: 'revoked control must not write',
    territory_id: territory.territory_id,
  })
  assert.equal(afterRevoke.status, 401)
  assert.equal(afterRevoke.body.errorCode, 'CONTROL_SESSION_REQUIRED')
  assert.equal(store.revision(kingdom.kingdom_id), revisionAfterRevoke)

  const stopped = await slash.handler({
    rawInput: 'gui stop',
    agent: { session: { id: OWNER_ROLE_SESSION } },
  })
  assert.equal(stopped.kind, 'success')
})
