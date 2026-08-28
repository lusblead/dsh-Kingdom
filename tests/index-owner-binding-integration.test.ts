import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  apply,
  resolveTrustedToolSession,
  type KingdomDshAgentLike,
  type KingdomDshAgentRegistryLike,
  type KingdomDshSessionRegistryLike,
} from '../lib/index.js'
import { KingdomStore } from '../lib/core/db.js'

interface TestSession {
  id: string
}

interface TestAgent extends KingdomDshAgentLike {
  id: string
  session: TestSession
  status: 'idle' | 'running' | 'expired'
}

interface CapturedTool {
  name: string
  execute(args: Record<string, unknown>, exec?: unknown): Promise<unknown>
}

interface CapturedCommand {
  name: string
  handler(input: { rawInput: string }): Promise<{ kind: string; text: string }>
}

function makeHarness(options: { includeRegistry?: boolean } = {}) {
  const includeRegistry = options.includeRegistry ?? true
  const root = mkdtempSync(join(tmpdir(), 'dsh-kingdom-index-owner-binding-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const tools = new Map<string, CapturedTool>()
  const commands = new Map<string, CapturedCommand>()
  const disposers: Array<() => void> = []
  const agents = new Map<string, TestAgent>()
  const sessions = new Map<string, TestSession>()
  let initiator: TestAgent | undefined
  let listedAgents: readonly TestAgent[] | null = null

  const agentsService: KingdomDshAgentRegistryLike = {
    currentInitiator: () => initiator,
    get: (id: string) => agents.get(id),
    list: () => listedAgents ?? [...agents.values()],
  }
  const sessionsService: KingdomDshSessionRegistryLike = {
    get: (id: string) => sessions.get(id),
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
      if (!includeRegistry) return undefined
      if (name === 'agents') return agentsService
      if (name === 'sessions') return sessionsService
      return undefined
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }

  const addAgent = (id: string, status: TestAgent['status'] = 'running'): TestAgent => {
    const session = { id }
    const agent: TestAgent = { id, session, status }
    agents.set(id, agent)
    sessions.set(id, session)
    return agent
  }

  apply(context as never, {
    kingdomName: 'index-owner-binding-test',
    ownerName: 'test-owner',
    workerProvider: 'spawn',
    guiPort: 0,
    guiToken: '',
    guiAllowOrigins: ['*'],
    authMode: 'session-bound',
    migrateV4: true,
  })

  const close = (): void => {
    for (const dispose of disposers.reverse()) dispose()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }

  return {
    root,
    tools,
    commands,
    agents,
    sessions,
    agentsService,
    sessionsService,
    addAgent,
    setInitiator(agent: TestAgent | undefined): void { initiator = agent },
    setListedAgents(value: readonly TestAgent[] | null): void { listedAgents = value },
    close,
  }
}

function execution(agent: TestAgent, signal: AbortSignal = new AbortController().signal): Record<string, unknown> {
  return { agent, signal }
}

test('trusted Tool session resolver requires the complete DSH identity conjunction', () => {
  const session = { id: 'target' }
  const agent: TestAgent = { id: 'target', session, status: 'running' }
  const other: TestAgent = { id: 'other', session: { id: 'other' }, status: 'running' }
  const sessions = { get: (id: string) => id === 'target' ? session : undefined }
  const agents = {
    currentInitiator: () => agent,
    get: (id: string) => id === 'target' ? agent : undefined,
    list: () => [agent],
  }

  assert.equal(resolveTrustedToolSession({ agent, signal: new AbortController().signal }, { agents, sessions }).classification, 'ACTIVE')
  assert.equal(resolveTrustedToolSession({ agent, signal: new AbortController().signal }, {
    agents: { ...agents, currentInitiator: () => other }, sessions,
  }).classification, 'FOREIGN')
  const expired = { ...agent, status: 'expired' as const }
  assert.equal(resolveTrustedToolSession({ agent: expired, signal: new AbortController().signal }, {
    agents: { ...agents, currentInitiator: () => expired, get: () => expired, list: () => [expired] }, sessions,
  }).classification, 'EXPIRED')
  assert.equal(resolveTrustedToolSession({ agent, signal: AbortSignal.abort() }, { agents, sessions }).classification, 'ABORTED')
  assert.equal(resolveTrustedToolSession({ agent, signal: new AbortController().signal }, {
    agents: { ...agents, list: () => [agent, { ...agent }] }, sessions,
  }).classification, 'MULTIPLE')
  assert.equal(resolveTrustedToolSession({ agent, signal: new AbortController().signal }, { agents }).classification, 'UNKNOWN')
  assert.equal(resolveTrustedToolSession({ signal: new AbortController().signal }, { agents, sessions }).classification, 'ABSENT')
  assert.equal(resolveTrustedToolSession({ agent, signal: undefined }, { agents, sessions }).classification, 'UNKNOWN')
})

test('direct Owner session writes fail closed when the DSH registry seam is missing', async (t) => {
  const harness = makeHarness({ includeRegistry: false })
  t.after(harness.close)
  const command = harness.commands.get('kingdom')!
  assert.equal((await command.handler({ rawInput: 'init' })).kind, 'success')

  const store = new KingdomStore(join(harness.root, 'kingdom', 'kingdom.db'), { allowSchemaV4: true })
  try {
    const kingdom = store.getDefaultKingdom()!
    const eventsBefore = store.listEvents(kingdom.kingdom_id, 100).length
    const rejected = await command.handler({
      rawInput: 'role.bind {"role_type":"SUPERVISOR","session_id":"unverifiable-session"}',
    })

    assert.equal(rejected.kind, 'error')
    assert.match(rejected.text, /SESSION_UNKNOWN/u)
    assert.equal(store.listEvents(kingdom.kingdom_id, 100).length, eventsBefore)
    assert.equal(store.getBindingsByRole(kingdom.kingdom_id, 'SUPERVISOR').length, 0)
  } finally {
    store.close()
  }
})

test('direct role.session validates envelope grammar before Owner gate and rejects before live-session proof with zero writes', async (t) => {
  const harness = makeHarness()
  t.after(harness.close)
  const command = harness.commands.get('kingdom')!
  assert.equal((await command.handler({ rawInput: 'init' })).kind, 'success')

  const store = new KingdomStore(join(harness.root, 'kingdom', 'kingdom.db'), { allowSchemaV4: true })
  try {
    const kingdom = store.getDefaultKingdom()!
    const owner = store.getBindingByRole(kingdom.kingdom_id, 'OWNER')!
    const beforeEvents = store.listEvents(kingdom.kingdom_id, 100).length
    const beforeOwner = store.getBindingById(owner.binding_id)!

    const requests = [
      `role.session ${JSON.stringify({ role_type: 'OWNER', binding_id: owner.binding_id, session_id: 'unverifiable-session' })}`,
      `role.session ${JSON.stringify({ binding_id: owner.binding_id, session_id: 'unverifiable-session' })}`,
      `role.session ${JSON.stringify({ role_type: 'OWNER', session_id: 'unverifiable-session' })}`,
    ]
    for (const rawInput of requests) {
      const rejected = await command.handler({ rawInput })
      assert.equal(rejected.kind, 'error')
      assert.match(rejected.text, /^OWNER_CONTROL_REQUIRED:/u)
      assert.equal(store.listEvents(kingdom.kingdom_id, 100).length, beforeEvents)
      assert.deepEqual(store.getBindingById(owner.binding_id), beforeOwner)
    }
  } finally {
    store.close()
  }
})

test('registered NL/Draft tools are zero-write, use classification, and emit canonical steps', async (t) => {
  const harness = makeHarness()
  t.after(harness.close)
  const init = harness.commands.get('kingdom')!
  assert.equal((await init.handler({ rawInput: 'init' })).kind, 'success')

  const target = harness.addAgent('target-session', 'running')
  harness.setInitiator(target)
  const draftTool = harness.tools.get('kingdom_draft_owner_binding_intent')!
  const draft = JSON.parse(String(await draftTool.execute(
    { text: '把当前会话设为宰相' }, execution(target),
  ))) as Record<string, any>
  assert.equal(draft.status, 'DRAFT_READY')
  assert.equal(draft.write_effect, 'ZERO_WRITE')
  assert.equal(draft.operation.kind, 'role.bind')
  assert.match(draft.canonical_direct_slash, /^\/kingdom role\.bind /u)
  assert.equal(draft.intent.target_session_ref, 'target-session')

  const before = harness.tools.size
  const bindTool = harness.tools.get('kingdom_bind_role')!
  const rejected = JSON.parse(String(await bindTool.execute({
    role_type: 'CHANCELLOR',
    session_id: 'forged-argument-session',
  }, execution(target)))) as Record<string, any>
  assert.equal(rejected.write_effect, 'ZERO_WRITE')
  assert.equal(rejected.owner_authority, false)
  assert.equal(rejected.ambiguity.code, 'SESSION_FOREIGN')
  assert.equal(harness.tools.size, before, 'rejection must not mutate registrations or domain state')

  const unknown = JSON.parse(String(await draftTool.execute(
    { text: '把当前会话设为宰相' }, { agent: target },
  ))) as Record<string, any>
  assert.equal(unknown.write_effect, 'ZERO_WRITE')
  assert.equal(unknown.status, 'AMBIGUOUS')
  assert.equal(unknown.ambiguity.code, 'SESSION_UNRESOLVED')
})

test('Supervisor Draft preserves exact territory binding and direct Slash validates live target session', async (t) => {
  const harness = makeHarness()
  t.after(harness.close)
  const command = harness.commands.get('kingdom')!
  assert.equal((await command.handler({ rawInput: 'init' })).kind, 'success')

  const live = harness.addAgent('direct-live-session', 'idle')
  const target = harness.addAgent('draft-supervisor-session', 'running')
  harness.setInitiator(target)
  const createTerritory = await command.handler({ rawInput: 'territory.create {"name":"研发领"}' })
  assert.equal(createTerritory.kind, 'success')
  const bindSupervisor = await command.handler({
    rawInput: 'role.bind {"role_type":"SUPERVISOR","role_name":"原主管","session_id":"direct-live-session"}',
  })
  assert.equal(bindSupervisor.kind, 'success', bindSupervisor.text)

  const store = new KingdomStore(join(harness.root, 'kingdom', 'kingdom.db'), { allowSchemaV4: true })
  try {
    const kingdom = store.getDefaultKingdom()!
    const territory = store.listTerritories(kingdom.kingdom_id)[0]!
    const supervisor = store.getBindingByRole(kingdom.kingdom_id, 'SUPERVISOR')!
    const scope = await command.handler({
      rawInput: `territory.supervisor ${JSON.stringify({ territory_id: territory.territory_id, supervisor_binding_id: supervisor.binding_id })}`,
    })
    assert.equal(scope.kind, 'success', scope.text)

    const draftTool = harness.tools.get('kingdom_draft_owner_binding_intent')!
    const existing = JSON.parse(String(await draftTool.execute(
      { text: '让当前会话主管研发领' }, execution(target),
    ))) as Record<string, any>
    assert.equal(existing.operation.kind, 'role.session')
    assert.deepEqual(existing.steps.map((step: Record<string, unknown>) => step.kind), ['role.session'])
    assert.equal(existing.intent.territory.territory_id, territory.territory_id)

    const createNewTerritory = await command.handler({ rawInput: 'territory.create {"name":"新领地"}' })
    assert.equal(createNewTerritory.kind, 'success', createNewTerritory.text)
    const newSupervisor = JSON.parse(String(await draftTool.execute(
      { text: '让当前会话主管新领地' }, execution(target),
    ))) as Record<string, any>
    assert.equal(newSupervisor.write_effect, 'ZERO_WRITE')
    assert.equal(newSupervisor.status, 'DRAFT_READY')
    assert.deepEqual(newSupervisor.steps.map((step: Record<string, unknown>) => step.kind), ['role.bind', 'territory.supervisor'])

    const eventsBefore = store.listEvents(kingdom.kingdom_id, 100).length
    const rejected = await command.handler({
      rawInput: 'role.session {"binding_id":"missing","session_id":"not-live"}',
    })
    assert.equal(rejected.kind, 'error')
    assert.match(rejected.text, /SESSION_(?:ABSENT|UNKNOWN)/u)
    assert.equal(store.listEvents(kingdom.kingdom_id, 100).length, eventsBefore)

    const session = await command.handler({
      rawInput: 'role.session {"binding_id":"' + supervisor.binding_id + '","session_id":"direct-live-session"}',
    })
    assert.equal(session.kind, 'success', session.text)
    assert.equal(store.getBindingById(supervisor.binding_id)?.session_id, 'direct-live-session')
    void live
  } finally {
    store.close()
  }
})

test('kingdom_bind_session Tool accepts binding_id-only and returns zero-write canonical role.session Draft', async (t) => {
  const harness = makeHarness()
  t.after(harness.close)
  const command = harness.commands.get('kingdom')!
  assert.equal((await command.handler({ rawInput: 'init' })).kind, 'success')

  const target = harness.addAgent('binding-id-only-target', 'running')
  harness.setInitiator(target)
  const created = await command.handler({
    rawInput: 'role.bind {"role_type":"WORKER","role_name":"Binding ID only"}',
  })
  assert.equal(created.kind, 'success', created.text)

  const store = new KingdomStore(join(harness.root, 'kingdom', 'kingdom.db'), { allowSchemaV4: true })
  try {
    const kingdom = store.getDefaultKingdom()!
    const binding = store.getBindingByRole(kingdom.kingdom_id, 'WORKER')!
    const eventsBefore = store.listEvents(kingdom.kingdom_id, 100).length
    const tool = harness.tools.get('kingdom_bind_session')!
    const draft = JSON.parse(String(await tool.execute(
      { binding_id: binding.binding_id }, execution(target),
    ))) as Record<string, any>

    assert.equal(draft.status, 'DRAFT_READY')
    assert.equal(draft.write_effect, 'ZERO_WRITE')
    assert.equal(draft.operation.kind, 'role.session')
    assert.deepEqual(draft.operation.args, {
      binding_id: binding.binding_id,
      session_id: target.id,
    })
    assert.equal(draft.canonical_direct_slash, `/kingdom role.session {"binding_id":"${binding.binding_id}","session_id":"${target.id}"}`)
    assert.equal(store.listEvents(kingdom.kingdom_id, 100).length, eventsBefore)

    const missing = JSON.parse(String(await tool.execute(
      { binding_id: 'missing-binding' }, execution(target),
    ))) as Record<string, any>
    assert.equal(missing.status, 'AMBIGUOUS')
    assert.equal(missing.write_effect, 'ZERO_WRITE')
    assert.equal(missing.ambiguity.code, 'ROLE_BINDING_UNSAFE')

    target.status = 'expired'
    const expired = JSON.parse(String(await tool.execute(
      { binding_id: binding.binding_id }, execution(target),
    ))) as Record<string, any>
    assert.equal(expired.status, 'AMBIGUOUS')
    assert.equal(expired.ambiguity.code, 'SESSION_EXPIRED')
    assert.equal(expired.write_effect, 'ZERO_WRITE')
    target.status = 'running'
  } finally {
    store.close()
  }
})
