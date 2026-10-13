import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LocalControlManager, type LocalControlOptions } from '../lib/gui/local-control.js'
import { GUI_OWNER_ONLY_ACTIONS, type GuiControlRequestMeta, type GuiSessionCommand } from '../lib/gui/control-contract.js'
import { startGuiServer, type GuiServerAddress } from '../lib/gui/server.js'

const ORIGIN = 'http://127.0.0.1:43123'
const META: GuiControlRequestMeta = {
  host: '127.0.0.1:43123', origin: ORIGIN, remoteAddress: '127.0.0.1', fetchSite: 'same-origin',
}

function fixture(inspectRoleAction?: LocalControlOptions['inspectRoleAction'], sessionId: string | null = 'captured-session') {
  let sequence = 0
  const manager = new LocalControlManager({
    expectedOrigin: ORIGIN, inspectRoleAction, tokenFactory: () => `role-test-token-${++sequence}`,
  })
  const activation = manager.activate(sessionId === null ? {} : { session: { id: sessionId } })
  const redeemed = manager.redeem(activation.launchTicket, { ...META, origin: null })
  assert.equal(redeemed.ok, true)
  if (!redeemed.ok) throw new Error(redeemed.message)
  return { manager, cookie: redeemed.cookieValue, csrf: redeemed.view.csrfToken, view: redeemed.view }
}

test('Supervisor preflight disables task creation and rejects the submitted plan', () => {
  const seen: GuiSessionCommand[] = []
  const { manager, cookie, csrf, view } = fixture((principal, command) => {
    assert.deepEqual(principal, { sessionId: 'captured-session' })
    assert.equal(Object.isFrozen(principal), true)
    seen.push(command)
    return command === 'plan'
      ? { executable: false, disabledReason: 'CHANCELLOR_REQUIRED' }
      : { executable: true }
  })
  try {
    assert.equal(view.actions['task.create']?.executable, false)
    assert.equal(view.actions.plan?.disabledReason, 'CHANCELLOR_REQUIRED')
    assert.equal(view.actions.start?.executable, true)
    assert.equal(view.actions['review:accept']?.executable, true)
    assert.equal(seen.filter(command => command === 'plan').length, 1, 'aliases use the same preflight result')
    assert.equal(seen.includes('control.revoke'), false)
    const admitted = manager.authorize(cookie, csrf, 'supervisor-plan', META, 'plan')
    assert.equal(admitted.ok, false)
    if (!admitted.ok) {
      assert.equal(admitted.code, 'CONTROL_ROLE_DENIED')
      assert.match(admitted.message, /宰相/u)
    }
  } finally { manager.dispose() }
})

test('Chancellor preflight allows plan while all Supervisor commands remain unavailable', () => {
  const { manager, cookie, csrf, view } = fixture((_principal, command) => command === 'plan'
    ? { executable: true }
    : { executable: false, disabledReason: 'SUPERVISOR_REQUIRED' })
  try {
    assert.equal(view.actions['task.create']?.executable, true)
    for (const command of ['assign', 'start', 'review', 'reconcile', 'execution.pause', 'execution.resume', 'execution.abort'] as const) {
      assert.equal(view.actions[command]?.executable, false, command)
      assert.equal(view.actions[command]?.disabledReason, 'SUPERVISOR_REQUIRED')
      const denied = manager.authorize(cookie, csrf, `chancellor-${command}`, META, command)
      assert.equal(denied.ok, false)
      if (!denied.ok) assert.equal(denied.code, 'CONTROL_ROLE_DENIED')
    }
    const accepted = manager.authorize(cookie, csrf, 'chancellor-plan', META, 'plan')
    assert.equal(accepted.ok, true)
    if (accepted.ok) accepted.finish()
    assert.equal(view.actions['control.revoke']?.executable, true)
  } finally { manager.dispose() }
})

test('live rebind narrows both refreshed controls and mutation admission without consuming denied requests', () => {
  let isChancellor = true
  const { manager, cookie, csrf, view } = fixture((_principal, command) => command === 'plan' && isChancellor
    ? { executable: true }
    : { executable: false, disabledReason: 'ROLE_AUTH_REQUIRED' })
  try {
    assert.equal(view.actions.plan?.executable, true)
    isChancellor = false
    const refreshed = manager.inspect(cookie, META)
    assert.equal(refreshed.ok, true)
    if (refreshed.ok) assert.equal(refreshed.view.actions.plan?.executable, false)
    const denied = manager.authorize(cookie, csrf, 'rebind-request', META, 'plan')
    assert.equal(denied.ok, false)
    isChancellor = true
    const accepted = manager.authorize(cookie, csrf, 'rebind-request', META, 'plan')
    assert.equal(accepted.ok, true, 'a preflight denial must not reserve the request or in-flight lock')
    if (accepted.ok) accepted.finish()
  } finally { manager.dispose() }
})

test('exceptional or malformed role preflight fails closed and never disables control revoke', () => {
  const callbacks: NonNullable<LocalControlOptions['inspectRoleAction']>[] = [
    () => { throw new Error('private ledger failure') },
    (() => undefined) as never,
    (() => ({ executable: 'true' })) as never,
    (() => ({ executable: true, disabledReason: 'SUPERVISOR_REQUIRED' })) as never,
    (() => ({ executable: false, disabledReason: 'private ledger failure' })) as never,
    (() => ({ get executable() { throw new Error('private getter failure') } })) as never,
  ]
  for (const [index, callback] of callbacks.entries()) {
    const { manager, cookie, csrf, view } = fixture(callback)
    try {
      assert.equal(view.actions.plan?.executable, false, String(index))
      assert.equal(view.actions.plan?.disabledReason, 'ROLE_PREFLIGHT_UNAVAILABLE')
      const denied = manager.authorize(cookie, csrf, `malformed-${index}`, META, 'plan')
      assert.equal(denied.ok, false)
      if (!denied.ok) {
        assert.equal(denied.code, 'CONTROL_ROLE_DENIED')
        assert.doesNotMatch(denied.message, /private/u)
      }
      assert.equal(view.actions['control.revoke']?.executable, true)
      const revoke = manager.authorize(cookie, csrf, `revoke-${index}`, META, 'control.revoke')
      assert.equal(revoke.ok, true)
      if (revoke.ok) revoke.finish()
      manager.revoke(cookie)
      assert.equal(manager.inspect(cookie, META).ok, false)
    } finally { manager.dispose() }
  }
})

test('a permissive callback cannot add Session identity or expose Owner actions', () => {
  let calls = 0
  const { manager, cookie, csrf, view } = fixture(() => { calls++; return { executable: true } }, null)
  try {
    assert.equal(calls, 0, 'missing captured Session must not consult the callback')
    assert.equal(view.roleSessionBound, false)
    assert.equal(view.actions.plan?.executable, false)
    assert.equal(view.actions.plan?.disabledReason, 'SESSION_AUTH_REQUIRED')
    const denied = manager.authorize(cookie, csrf, 'unbound-plan', META, 'plan')
    assert.equal(denied.ok, false)
    if (!denied.ok) assert.equal(denied.code, 'CONTROL_ROLE_DENIED')
    for (const action of GUI_OWNER_ONLY_ACTIONS) {
      assert.equal(view.actions[action]?.executable, false)
      assert.equal(view.actions[action]?.disabledReason, 'DIRECT_SLASH_REQUIRED')
      assert.equal(view.actions[action]?.command, null)
    }
  } finally { manager.dispose() }

  const bound = fixture(() => ({ executable: true }))
  try {
    const forgedCommand = bound.manager.authorize(bound.cookie, bound.csrf, 'forged-owner', META, 'role.bind' as GuiSessionCommand)
    assert.equal(forgedCommand.ok, false)
    if (!forgedCommand.ok) assert.equal(forgedCommand.code, 'CONTROL_ROLE_DENIED')
    assert.equal(bound.view.actions['role.bind']?.executable, false)
  } finally { bound.manager.dispose() }
})

test('omitting the optional preflight preserves the existing session-bound broker behavior', () => {
  const { manager, cookie, csrf, view } = fixture()
  try {
    assert.equal(view.actions.plan?.executable, true)
    assert.equal(view.actions.start?.executable, true)
    const admitted = manager.authorize(cookie, csrf, 'legacy-admission', META)
    assert.equal(admitted.ok, true)
    if (admitted.ok) admitted.finish()
  } finally { manager.dispose() }
})

test('HTTP command admission rereads Role and rejects the wrong Role before invoking the business handler', async () => {
  let expectedOrigin = ''
  let allowPlan = false
  let commandCalls = 0
  let resolveAddress!: (address: GuiServerAddress) => void
  const ready = new Promise<GuiServerAddress>(resolve => { resolveAddress = resolve })
  const manager = new LocalControlManager({
    expectedOrigin: () => expectedOrigin,
    inspectRoleAction: () => allowPlan
      ? { executable: true }
      : { executable: false, disabledReason: 'CHANCELLOR_REQUIRED' },
  })
  const close = startGuiServer({
    snapshot: () => ({}) as never,
    taskDetail: () => null,
    eventsSince: () => ({ revision: 0, events: [] }),
    command: async () => {
      commandCalls++
      return { ok: true, errorCode: null, message: 'accepted', task: null, execution: null, emittedEvents: [], allowedActions: [], revision: 0 }
    },
  }, { port: 0, control: manager, onListening: address => { expectedOrigin = address.origin; resolveAddress(address) } })
  try {
    const address = await ready
    const actualMeta = { ...META, host: `127.0.0.1:${address.port}`, origin: address.origin }
    const activation = manager.activate({ session: { id: 'http-captured-session' } })
    const redemption = manager.redeem(activation.launchTicket, { ...actualMeta, origin: null })
    assert.equal(redemption.ok, true)
    if (!redemption.ok) return
    const headers = {
      cookie: `dsh_kingdom_control=${redemption.cookieValue}`,
      origin: address.origin,
      'content-type': 'application/json',
      'x-kingdom-client': 'v0.9',
      'x-kingdom-csrf': redemption.view.csrfToken,
      'x-kingdom-request-id': 'http-role-request',
    }
    const submitted = () => fetch(`${address.origin}/api/commands/plan`, {
      method: 'POST', headers, body: JSON.stringify({ title: 'Guarded HTTP task', territory_id: 'existing-territory' }),
    })
    const denied = await submitted()
    assert.equal(denied.status, 403)
    assert.equal((await denied.json() as { errorCode: string }).errorCode, 'CONTROL_ROLE_DENIED')
    assert.equal(commandCalls, 0, 'wrong Role must not reach the business handler')
    allowPlan = true
    const accepted = await submitted()
    assert.equal(accepted.status, 200)
    assert.equal(commandCalls, 1)
  } finally {
    close()
    manager.dispose()
  }
})
