import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startGuiServer, type GuiServerAddress } from '../lib/gui/server.js'
import {
  isExactLoopbackHost,
  isExactLoopbackRemoteAddress,
  LocalControlManager,
  type LocalControlActivation,
} from '../lib/gui/local-control.js'
import type { GuiControlRequestMeta } from '../lib/gui/control-contract.js'
import {
  ensureGuiSetupBinding,
  ensureGuiSetupTerritory,
  formatGuiLaunchCommandResult,
  MINIMAL_CAPABILITY_JSON,
} from '../lib/index.js'
import { KingdomManager } from '../lib/core/kingdom.js'
import { bindRole, setExecutionProfile } from '../lib/core/binding.js'
import { issueOwnerControlCapability, ownerControlAuth } from '../lib/core/owner-control.js'
import { planTask } from '../lib/core/task-service.js'
import { setCapabilityCeiling } from '../lib/capability/admin.js'
import { setTerritorySupervisor } from '../lib/core/territory.js'

const ORIGIN = 'http://127.0.0.1:43123'
const HOST = '127.0.0.1:43123'

function meta(origin: string | null = ORIGIN, host = HOST): GuiControlRequestMeta {
  return {
    host,
    origin,
    remoteAddress: '127.0.0.1',
    fetchSite: 'same-origin',
  }
}

function managerFor(options: {
  now?: () => number
  expectedOrigin?: string | (() => string)
  ticketTtlMs?: number
  sessionTtlMs?: number
} = {}): LocalControlManager {
  let sequence = 0
  return new LocalControlManager({
    expectedOrigin: options.expectedOrigin ?? ORIGIN,
    now: options.now,
    ticketTtlMs: options.ticketTtlMs,
    sessionTtlMs: options.sessionTtlMs,
    tokenFactory: () => `transport-secret-${++sequence}`,
  })
}

function redeem(
  manager: LocalControlManager,
  agent: unknown = { session: { id: 'activation-agent-session' } },
): {
  activation: LocalControlActivation
  cookie: string
  csrf: string
} {
  const activation = manager.activate(agent)
  const result = manager.redeem(activation.launchTicket, meta(null))
  if (!result.ok) throw new Error(result.message)
  return { activation, cookie: result.cookieValue, csrf: result.view.csrfToken }
}

function assertSecretFree(value: unknown, secrets: readonly string[]): void {
  const serialized = JSON.stringify(value)
  for (const secret of secrets) assert.equal(serialized.includes(secret), false, `secret leaked: ${secret}`)
}

test('loopback and Origin admission use the exact local transport boundary', () => {
  assert.equal(isExactLoopbackHost('127.0.0.1'), true)
  assert.equal(isExactLoopbackHost(HOST), true)
  assert.equal(isExactLoopbackHost('127.0.0.1:1'), true)
  assert.equal(isExactLoopbackHost('localhost:43123'), false)
  assert.equal(isExactLoopbackHost('127.0.0.2:43123'), false)
  assert.equal(isExactLoopbackHost('[::1]:43123'), false)
  assert.equal(isExactLoopbackHost('127.0.0.1:0'), false)
  assert.equal(isExactLoopbackRemoteAddress('127.0.0.1'), true)
  assert.equal(isExactLoopbackRemoteAddress('::ffff:127.0.0.1'), true)
  assert.equal(isExactLoopbackRemoteAddress('::1'), false)
})

test('ticket redemption is one-time and captures the exact Agent/session without Owner capability', () => {
  const manager = managerFor()
  const agent = { id: 'exact-agent', session: { id: 'exact-session' } }
  try {
    const activation = manager.activate(agent)
    const first = manager.redeem(activation.launchTicket, meta(null))
    assert.equal(first.ok, true)
    if (!first.ok) return
    const second = manager.redeem(activation.launchTicket, meta(null))
    assert.equal(second.ok, false)
    if (second.ok) return
    assert.equal(second.code, 'CONTROL_TICKET_INVALID')

    const admitted = manager.authorize(
      first.cookieValue,
      first.view.csrfToken,
      'request-exact-1',
      meta(),
    )
    assert.equal(admitted.ok, true)
    if (!admitted.ok) return
    assert.equal(admitted.context.principalSessionId, 'exact-session')
    assert.equal((admitted.context as { agent?: unknown }).agent, agent)
    assert.equal(Object.hasOwn(admitted.context, 'ownerCapability'), false)
    admitted.finish()

    const inspected = manager.inspect(first.cookieValue, meta())
    assert.equal(inspected.ok, true)
    if (inspected.ok) {
      assert.deepEqual(inspected.readContext, { principalSessionId: 'exact-session' })
      assert.equal(Object.hasOwn(inspected.readContext, 'agent'), false)
      assert.equal(Object.hasOwn(inspected.readContext, 'ownerCapability'), false)
    }
  } finally {
    manager.dispose()
  }
})

test('v1 control view advertises session commands and keeps Owner-only actions direct-Slash-only', () => {
  const manager = managerFor()
  try {
    const bound = manager.activate({ session: { id: 'bound-role-session' } })
    const redeemed = manager.redeem(bound.launchTicket, meta(null))
    assert.equal(redeemed.ok, true)
    if (!redeemed.ok) return
    const view = redeemed.view
    assert.deepEqual(view.reviewDecisions, ['ACCEPT', 'REWORK', 'FAIL', 'HANDOFF'])
    assert.deepEqual(view.sandboxModes, ['workspace-write', 'read-only'])
    for (const command of [
      'plan', 'assign', 'start', 'review',
      'execution.pause', 'execution.resume', 'execution.abort', 'control.revoke',
    ]) {
      assert.equal(view.commands.includes(command), true, `missing advertised command ${command}`)
    }
    assert.equal(view.commands.includes('setup.basic'), false)
    assert.equal(view.actions['setup.basic'], undefined)
    assert.deepEqual(view.actions['review:handoff'], {
      executable: true,
      disabledReason: null,
      command: 'review',
      directSlashHint: null,
    })
    assert.equal(view.actions['execution:pause']?.command, 'execution.pause')
    for (const action of [
      'init', 'reset', 'ceiling', 'territory.create', 'territory.delete',
      'territory.supervisor', 'role.bind', 'role.unbind', 'role.session', 'execution-profile',
    ]) {
      assert.equal(view.actions[action]?.executable, false, `${action} must stay disabled`)
      assert.equal(view.actions[action]?.disabledReason, 'DIRECT_SLASH_REQUIRED')
      assert.match(view.actions[action]?.directSlashHint ?? '', /^\/kingdom /u)
    }
  } finally {
    manager.dispose()
  }

  const unbound = managerFor()
  try {
    const activation = unbound.activate({ id: 'agent-without-session' })
    const redeemed = unbound.redeem(activation.launchTicket, meta(null))
    assert.equal(redeemed.ok, true)
    if (!redeemed.ok) return
    assert.equal(redeemed.view.roleSessionBound, false)
    assert.equal(redeemed.view.actions.assign?.executable, false)
    assert.equal(redeemed.view.actions.assign?.disabledReason, 'SESSION_AUTH_REQUIRED')
    assert.equal(redeemed.view.actions['control.revoke']?.executable, true)
    const inspected = unbound.inspect(redeemed.cookieValue, meta())
    assert.equal(inspected.ok, true)
    if (inspected.ok) assert.equal(inspected.readContext.principalSessionId, null)
  } finally {
    unbound.dispose()
  }
})

test('same-origin GET without Origin can inspect, while mutation without/external Origin is zero-effect denied', () => {
  const manager = managerFor()
  try {
    const { cookie, csrf } = redeem(manager)
    const inspectedWithoutOrigin = manager.inspect(cookie, meta(null))
    assert.equal(inspectedWithoutOrigin.ok, true)
    const inspectedWithExactOrigin = manager.inspect(cookie, meta(ORIGIN))
    assert.equal(inspectedWithExactOrigin.ok, true)
    const inspectedForeignOrigin = manager.inspect(cookie, meta('http://evil.example'))
    assert.equal(inspectedForeignOrigin.ok, false)
    if (!inspectedForeignOrigin.ok) assert.equal(inspectedForeignOrigin.code, 'CONTROL_ORIGIN_DENIED')

    const missingOrigin = manager.authorize(cookie, csrf, 'request-no-origin', meta(null))
    assert.equal(missingOrigin.ok, false)
    if (!missingOrigin.ok) assert.equal(missingOrigin.code, 'CONTROL_ORIGIN_DENIED')
    const foreignOrigin = manager.authorize(cookie, csrf, 'request-foreign-origin', meta('http://evil.example'))
    assert.equal(foreignOrigin.ok, false)
    if (!foreignOrigin.ok) assert.equal(foreignOrigin.code, 'CONTROL_ORIGIN_DENIED')

    const accepted = manager.authorize(cookie, csrf, 'request-exact-origin', meta(ORIGIN))
    assert.equal(accepted.ok, true)
    if (accepted.ok) accepted.finish()
  } finally {
    manager.dispose()
  }
})

test('CSRF, request replay, and concurrent mutation admission fail closed', () => {
  const manager = managerFor()
  try {
    const { cookie, csrf } = redeem(manager)
    const badCsrf = manager.authorize(cookie, 'forged-csrf', 'request-csrf', meta())
    assert.equal(badCsrf.ok, false)
    if (!badCsrf.ok) assert.equal(badCsrf.code, 'CONTROL_CSRF_DENIED')

    const first = manager.authorize(cookie, csrf, 'request-1', meta())
    assert.equal(first.ok, true)
    if (!first.ok) return
    const concurrent = manager.authorize(cookie, csrf, 'request-2', meta())
    assert.equal(concurrent.ok, false)
    if (!concurrent.ok) assert.equal(concurrent.code, 'CONTROL_BUSY')
    first.finish()

    const second = manager.authorize(cookie, csrf, 'request-2', meta())
    assert.equal(second.ok, true)
    if (!second.ok) return
    second.finish()
    const replay = manager.authorize(cookie, csrf, 'request-2', meta())
    assert.equal(replay.ok, false)
    if (!replay.ok) assert.equal(replay.code, 'CONTROL_REPLAY_DENIED')
  } finally {
    manager.dispose()
  }
})

test('ticket/session TTL, revoke, replacement, and dispose abort active control contexts', () => {
  let clock = 1_000
  const manager = managerFor({ now: () => clock, ticketTtlMs: 10, sessionTtlMs: 20 })
  try {
    const ticket = manager.activate({ session: { id: 'expired-ticket-session' } })
    clock = 1_011
    const expiredTicket = manager.redeem(ticket.launchTicket, meta(null))
    assert.equal(expiredTicket.ok, false)
    if (!expiredTicket.ok) assert.equal(expiredTicket.code, 'CONTROL_TICKET_INVALID')

    const current = redeem(manager, { session: { id: 'active-session' } })
    const admitted = manager.authorize(current.cookie, current.csrf, 'request-active', meta())
    assert.equal(admitted.ok, true)
    if (!admitted.ok) return
    const signal = admitted.context.signal
    admitted.finish()
    clock = 1_032
    const expiredSession = manager.inspect(current.cookie, meta())
    assert.equal(expiredSession.ok, false)
    if (!expiredSession.ok) assert.equal(expiredSession.code, 'CONTROL_SESSION_EXPIRED')
    assert.equal(signal.aborted, true)
  } finally {
    manager.dispose()
  }

  const revokedManager = managerFor()
  try {
    const current = redeem(revokedManager)
    const admitted = revokedManager.authorize(current.cookie, current.csrf, 'request-revoke', meta())
    assert.equal(admitted.ok, true)
    if (!admitted.ok) return
    const signal = admitted.context.signal
    admitted.finish()
    revokedManager.revoke(current.cookie)
    assert.equal(signal.aborted, true)
    const afterRevoke = revokedManager.inspect(current.cookie, meta())
    assert.equal(afterRevoke.ok, false)
    if (!afterRevoke.ok) assert.equal(afterRevoke.code, 'CONTROL_SESSION_REQUIRED')
  } finally {
    revokedManager.dispose()
  }

  const disposedManager = managerFor()
  const current = redeem(disposedManager)
  const admitted = disposedManager.authorize(current.cookie, current.csrf, 'request-dispose', meta())
  assert.equal(admitted.ok, true)
  if (admitted.ok) {
    const signal = admitted.context.signal
    disposedManager.dispose()
    assert.equal(signal.aborted, true)
  }
})

test('forged browser identity fields have zero effect on the opaque activation context', () => {
  const manager = managerFor()
  const exactAgent = { id: 'direct-agent', session: { id: 'direct-session' } }
  try {
    const { cookie, csrf } = redeem(manager, exactAgent)
    const forgedTransport = {
      host: HOST,
      origin: ORIGIN,
      cookie: `dsh_kingdom_control=${cookie}`,
      csrfToken: csrf,
      requestId: 'request-forged-fields',
      principalSessionId: 'browser-principal',
      sessionId: 'browser-session',
      agent: { session: { id: 'browser-session' } },
    } as never
    const admitted = manager.admit(forgedTransport)
    assert.equal(admitted.ok, true)
    if (!admitted.ok) return
    assert.equal(admitted.authority.principal.sessionId, 'direct-session')
    assert.equal(admitted.authority.agent, exactAgent)
    admitted.release()
  } finally {
    manager.dispose()
  }
})

test('fresh governed setup prerequisites keep Worker unbound and prepare ceiling/profile/task requirement', () => {
  const manager = new KingdomManager({ dbPath: ':memory:', migrateV4: true })
  try {
    const initialized = manager.init()
    const store = manager.storeHandle
    assert.equal(store.getKingdomCapabilityCeiling(initialized.kingdomId), null)

    const ownerAuth = ownerControlAuth(issueOwnerControlCapability())
    const ceilingResult = setCapabilityCeiling(store, {
      kingdomId: initialized.kingdomId,
      ceilingJson: MINIMAL_CAPABILITY_JSON,
    }, ownerAuth)
    assert.doesNotMatch(ceilingResult, /错误：|OWNER_CONTROL_REQUIRED/u)

    const activationSession = 'activation-supervisor-session'
    assert.match(bindRole(store, {
      kingdomId: initialized.kingdomId,
      roleType: 'CHANCELLOR',
      roleName: 'Chancellor',
      sessionId: activationSession,
    }, ownerAuth), /^已绑定角色/u)
    assert.match(bindRole(store, {
      kingdomId: initialized.kingdomId,
      roleType: 'SUPERVISOR',
      roleName: 'Supervisor',
      sessionId: activationSession,
    }, ownerAuth), /^已绑定角色/u)
    assert.match(bindRole(store, {
      kingdomId: initialized.kingdomId,
      roleType: 'WORKER',
      roleName: 'Worker',
      // Direct Owner setup deliberately does not bind the activating
      // Supervisor session to the Worker seat.
    }, ownerAuth), /^已绑定角色/u)
    const worker = store.getBindingByRole(initialized.kingdomId, 'WORKER')!
    assert.equal(worker.session_id, null)

    const profileResult = setExecutionProfile(store, {
      kingdomId: initialized.kingdomId,
      bindingId: worker.binding_id,
      profile: { provider: 'spawn', model: 'requested-worker-model' },
    }, ownerAuth)
    assert.match(profileResult, /requested-worker-model/u)
    assert.deepEqual(JSON.parse(store.getBindingById(worker.binding_id)!.execution_profile_json!), {
      provider: 'spawn', model: 'requested-worker-model',
    })

    const now = new Date().toISOString()
    const supervisor = store.getBindingByRole(initialized.kingdomId, 'SUPERVISOR')!
    store.insertTerritory({
      territory_id: 'gui-fresh-territory', kingdom_id: initialized.kingdomId,
      name: 'GUI Fresh Territory', workspace_path: null, summary: null,
      supervisor_binding_id: supervisor.binding_id, status: 'ACTIVE',
      deleted_at: null, deleted_reason: null, created_at: now,
    })
    const planned = planTask(store, {
      kingdomId: initialized.kingdomId,
      auth: { mode: 'session-bound', trustLevel: 'session-verified', note: '' },
      principal: { sessionId: activationSession },
    }, { title: 'GUI fresh governed task', territoryId: 'gui-fresh-territory' })
    assert.equal(planned.ok, true)
    assert.ok(planned.task)
    store.setTaskCapabilityRequirement(planned.task!.taskId, MINIMAL_CAPABILITY_JSON)
    assert.equal(store.getTaskCapabilityRequirement(planned.task!.taskId), MINIMAL_CAPABILITY_JSON)
    assert.deepEqual(JSON.parse(store.getKingdomCapabilityCeiling(initialized.kingdomId)!), { 'tool:pwsh': true })
    assert.equal(store.getBindingByRole(initialized.kingdomId, 'OWNER')!.session_id, null)
  } finally {
    manager.close()
  }
})

test('retained setup helpers are replay-safe and refuse tombstone/workspace topology changes', () => {
  const manager = new KingdomManager({ dbPath: ':memory:', migrateV4: true })
  try {
    const initialized = manager.init()
    const store = manager.storeHandle
    const auth = ownerControlAuth(issueOwnerControlCapability())
    const setup = {
      kingdomId: initialized.kingdomId,
      name: 'Replay Territory',
      workspacePath: 'C:/replay-workspace',
    }
    const firstTerritory = ensureGuiSetupTerritory(store, setup, auth)
    const firstSupervisor = ensureGuiSetupBinding(store, {
      kingdomId: initialized.kingdomId, roleType: 'SUPERVISOR',
      roleName: 'Supervisor', sessionId: 'activation-session',
    }, auth)
    const firstChancellor = ensureGuiSetupBinding(store, {
      kingdomId: initialized.kingdomId, roleType: 'CHANCELLOR',
      roleName: 'Chancellor', sessionId: 'activation-session',
    }, auth)
    const firstWorker = ensureGuiSetupBinding(store, {
      kingdomId: initialized.kingdomId, roleType: 'WORKER',
      roleName: 'Worker', sessionId: null,
    }, auth)
    assert.doesNotMatch(setExecutionProfile(store, {
      kingdomId: initialized.kingdomId, bindingId: firstWorker.binding_id,
      profile: { provider: 'spawn', model: 'replay-model' },
    }, auth), /^错误：/u)
    assert.doesNotMatch(setTerritorySupervisor(store, {
      kingdomId: initialized.kingdomId, territoryId: firstTerritory.territory_id,
      supervisorBindingId: firstSupervisor.binding_id,
    }, auth), /^错误：/u)
    assert.doesNotMatch(setCapabilityCeiling(store, {
      kingdomId: initialized.kingdomId, ceilingJson: MINIMAL_CAPABILITY_JSON,
    }, auth), /^错误：/u)

    const before = {
      territories: store.listTerritories(initialized.kingdomId).length,
      bindings: store.listBindings(initialized.kingdomId).length,
    }
    const secondTerritory = ensureGuiSetupTerritory(store, setup, auth)
    const secondSupervisor = ensureGuiSetupBinding(store, {
      kingdomId: initialized.kingdomId, roleType: 'SUPERVISOR',
      roleName: 'Supervisor', sessionId: 'activation-session',
    }, auth)
    const secondChancellor = ensureGuiSetupBinding(store, {
      kingdomId: initialized.kingdomId, roleType: 'CHANCELLOR',
      roleName: 'Chancellor', sessionId: 'activation-session',
    }, auth)
    const secondWorker = ensureGuiSetupBinding(store, {
      kingdomId: initialized.kingdomId, roleType: 'WORKER',
      roleName: 'Worker', sessionId: null,
    }, auth)
    assert.doesNotMatch(setExecutionProfile(store, {
      kingdomId: initialized.kingdomId, bindingId: secondWorker.binding_id,
      profile: { provider: 'spawn', model: 'replay-model' },
    }, auth), /^错误：/u)
    assert.doesNotMatch(setTerritorySupervisor(store, {
      kingdomId: initialized.kingdomId, territoryId: secondTerritory.territory_id,
      supervisorBindingId: secondSupervisor.binding_id,
    }, auth), /^错误：/u)

    assert.equal(secondTerritory.territory_id, firstTerritory.territory_id)
    assert.equal(secondSupervisor.binding_id, firstSupervisor.binding_id)
    assert.equal(secondChancellor.binding_id, firstChancellor.binding_id)
    assert.equal(secondWorker.binding_id, firstWorker.binding_id)
    assert.deepEqual({
      territories: store.listTerritories(initialized.kingdomId).length,
      bindings: store.listBindings(initialized.kingdomId).length,
    }, before)
    assert.equal(store.getBindingByRole(initialized.kingdomId, 'OWNER')!.session_id, null)
    assert.equal(store.getBindingByRole(initialized.kingdomId, 'WORKER')!.session_id, null)

    assert.throws(() => ensureGuiSetupTerritory(store, {
      ...setup, workspacePath: 'C:/different-workspace',
    }, auth), /workspace 冲突/u)

    store.tombstoneTerritoryRow(firstTerritory.territory_id, 'test tombstone')
    assert.throws(() => ensureGuiSetupTerritory(store, setup, auth), /DELETED\/tombstone/u)
    assert.equal(store.listTerritories(initialized.kingdomId).length, 0)
  } finally {
    manager.close()
  }
})

test('port=0 activates only against the actual listening Origin and keeps transport secrets out of result/logger/event payloads', async () => {
  let expectedOrigin = ''
  let resolveAddress!: (address: GuiServerAddress) => void
  const ready = new Promise<GuiServerAddress>(resolve => { resolveAddress = resolve })
  const logs: string[] = []
  const eventPayloads: unknown[] = []
  let commandCalls = 0
  let seenPrincipal = ''
  const manager = managerFor({ expectedOrigin: () => expectedOrigin })
  const close = startGuiServer({
    snapshot: () => ({}) as never,
    taskDetail: () => null,
    eventsSince: () => ({ revision: 0, events: eventPayloads as never }),
    command: async (_name, _payload, control) => {
      commandCalls++
      seenPrincipal = control?.principalSessionId ?? ''
      return {
        ok: true, errorCode: null, message: 'accepted', task: null, execution: null,
        emittedEvents: [], allowedActions: [], revision: 1,
      }
    },
  }, {
    port: 0,
    control: manager,
    onListening: address => { expectedOrigin = address.origin; resolveAddress(address) },
    logger: { info: message => logs.push(message), warn: message => logs.push(message) },
  })

  try {
    const address = await ready
    assert.notEqual(address.port, 0)
    assert.equal(address.origin, `http://127.0.0.1:${address.port}`)
    assert.equal(expectedOrigin, address.origin)

    const exactAgent = { session: { id: 'server-exact-session' } }
    const activation = manager.activate(exactAgent)
    const launchUrl = `${address.origin}/console?ticket=${encodeURIComponent(activation.launchTicket)}`
    const redeemed = await fetch(launchUrl, { redirect: 'manual' })
    assert.equal(redeemed.status, 303)
    assert.equal(redeemed.headers.get('location'), '/console')
    const setCookie = redeemed.headers.get('set-cookie') ?? ''
    const cookie = setCookie.split(';', 1)[0]!
    assert.equal(setCookie.includes(activation.launchTicket), false)

    const controlResponse = await fetch(`${address.origin}/api/control`, { headers: { cookie } })
    assert.equal(controlResponse.status, 200, 'same-origin GET without Origin must be inspectable')
    const controlBody = await controlResponse.text()
    const control = JSON.parse(controlBody) as {
      csrfToken: string
      actions: Record<string, { executable?: boolean; disabledReason?: string | null }>
    }
    assert.equal(typeof control.csrfToken, 'string')
    assert.equal(control.actions.init?.executable, false)
    assert.equal(control.actions.init?.disabledReason, 'DIRECT_SLASH_REQUIRED')

    const ownerOnlyHttpCommands = [
      'setup.basic', 'init', 'reset', 'ceiling',
      'territory.create', 'territory.delete', 'territory.supervisor',
      'role.bind', 'role.unbind', 'role.session',
      'execution-profile',
      'binding.bind', 'binding.unbind', 'binding.session',
    ]
    for (const command of ownerOnlyHttpCommands) {
      const ownerOnly = await fetch(`${address.origin}/api/commands/${command}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      assert.equal(ownerOnly.status, 403, `${command} must stay on direct Slash`)
      assert.deepEqual(await ownerOnly.json(), {
        ok: false,
        errorCode: 'DIRECT_SLASH_REQUIRED',
        message: `Owner-only action "${command}" 只能由人类 Owner 直接执行 /kingdom Slash；GUI/HTTP 始终 executable=false。`,
      })
    }
    assert.equal(commandCalls, 0)

    const noOriginPost = await fetch(`${address.origin}/api/commands/plan`, {
      method: 'POST',
      headers: {
        cookie, 'content-type': 'application/json', 'x-kingdom-client': 'v0.9',
        'x-kingdom-csrf': control.csrfToken, 'x-kingdom-request-id': 'request-no-origin',
      },
      body: '{}',
    })
    assert.equal(noOriginPost.status, 403)
    assert.equal(commandCalls, 0)

    const foreignOriginPost = await fetch(`${address.origin}/api/commands/plan`, {
      method: 'POST',
      headers: {
        cookie, origin: 'http://evil.example', 'content-type': 'application/json',
        'x-kingdom-client': 'v0.9', 'x-kingdom-csrf': control.csrfToken,
        'x-kingdom-request-id': 'request-foreign-origin',
      },
      body: '{}',
    })
    assert.equal(foreignOriginPost.status, 403)
    assert.equal(commandCalls, 0)

    const accepted = await fetch(`${address.origin}/api/commands/plan`, {
      method: 'POST',
      headers: {
        cookie, origin: address.origin, 'content-type': 'application/json',
        'x-kingdom-client': 'v0.9', 'x-kingdom-csrf': control.csrfToken,
        'x-kingdom-request-id': 'request-exact-origin',
      },
      body: '{}',
    })
    assert.equal(accepted.status, 200)
    assert.equal(commandCalls, 1)
    assert.equal(seenPrincipal, 'server-exact-session')

    const replay = await fetch(`${address.origin}/api/commands/plan`, {
      method: 'POST',
      headers: {
        cookie, origin: address.origin, 'content-type': 'application/json',
        'x-kingdom-client': 'v0.9', 'x-kingdom-csrf': control.csrfToken,
        'x-kingdom-request-id': 'request-exact-origin',
      },
      body: '{}',
    })
    assert.equal(replay.status, 409)
    assert.equal(commandCalls, 1)

    const forgedIdentity = await fetch(`${address.origin}/api/commands/plan`, {
      method: 'POST',
      headers: {
        cookie, origin: address.origin, 'content-type': 'application/json',
        'x-kingdom-client': 'v0.9', 'x-kingdom-csrf': control.csrfToken,
        'x-kingdom-request-id': 'request-forged-identity',
      },
      body: '{"title":"ignored","session_id":"browser-forged"}',
    })
    assert.equal(forgedIdentity.status, 400)
    assert.equal(commandCalls, 1)

    const cleanSuccess = formatGuiLaunchCommandResult(address.origin, activation.expiresAt, true)
    const cleanFailure = formatGuiLaunchCommandResult(address.origin, activation.expiresAt, false)
    const secrets = [activation.launchTicket, cookie, control.csrfToken]
    assertSecretFree(cleanSuccess, secrets)
    assertSecretFree(cleanFailure, secrets)
    assertSecretFree(logs, secrets)
    assertSecretFree(eventPayloads, secrets)
    assert.equal(JSON.stringify(cleanSuccess).includes('?ticket='), false)
    assert.equal(JSON.stringify(cleanFailure).includes('?ticket='), false)
  } finally {
    close()
  }
})
