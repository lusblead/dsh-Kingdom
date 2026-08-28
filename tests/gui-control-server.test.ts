import { test } from 'node:test'
import assert from 'node:assert/strict'
import type {
  GuiControlAuthorizeResult,
  GuiControlBroker,
  GuiControlInspectResult,
  GuiControlRedeemResult,
  GuiControlRequestMeta,
} from '../lib/gui/control-contract.js'
import { GUI_CHARACTER_ASSET_FILES } from '../lib/gui/console-app.js'
import { startGuiServer, type GuiServerAddress } from '../lib/gui/server.js'

function fakeBroker(expectedOrigin: () => string): GuiControlBroker & {
  disposed: boolean
  finishes: number
  revokes: number
} {
  const controller = new AbortController()
  const view = {
    active: true as const,
    activationId: 'activation-public-ref',
    expiresAt: '2099-01-01T00:00:00.000Z',
    csrfToken: 'csrf-test',
    roleSessionBound: true,
    commands: [
      'plan', 'assign', 'start', 'review',
      'execution.pause', 'execution.resume', 'execution.abort', 'control.revoke',
    ],
    reviewDecisions: ['ACCEPT', 'REWORK', 'FAIL', 'HANDOFF'],
    sandboxModes: ['workspace-write', 'read-only'],
    actions: {},
    disabledReason: null,
  }
  const loopbackAllowed = (meta: GuiControlRequestMeta): boolean => {
    const origin = expectedOrigin()
    return origin.length > 0
      && meta.host === new URL(origin).host
      && (meta.remoteAddress === '127.0.0.1' || meta.remoteAddress === '::ffff:127.0.0.1')
  }
  const readMetaAllowed = (meta: GuiControlRequestMeta): boolean =>
    loopbackAllowed(meta) && (meta.origin === null || meta.origin === expectedOrigin())
  return {
    disposed: false,
    finishes: 0,
    revokes: 0,
    redeem(ticket, meta): GuiControlRedeemResult {
      return ticket === 'launch-once' && readMetaAllowed(meta)
        ? { ok: true, cookieValue: 'cookie-test', view }
        : { ok: false, code: 'CONTROL_TICKET_INVALID', message: 'invalid ticket' }
    },
    inspect(cookie, meta): GuiControlInspectResult {
      if (!readMetaAllowed(meta)) return { ok: false, code: 'CONTROL_ORIGIN_DENIED', message: 'foreign transport' }
      if (cookie === 'expired-cookie') return { ok: false, code: 'CONTROL_SESSION_EXPIRED', message: 'expired session' }
      return cookie === 'cookie-test'
        ? { ok: true, view, readContext: { principalSessionId: 'session-from-direct-command' } }
        : { ok: false, code: 'CONTROL_SESSION_REQUIRED', message: 'missing session' }
    },
    authorize(cookie, csrf, requestId, meta): GuiControlAuthorizeResult {
      if (cookie !== 'cookie-test') return { ok: false, code: 'CONTROL_SESSION_REQUIRED', message: 'missing session' }
      if (!loopbackAllowed(meta) || meta.origin !== expectedOrigin()) {
        return { ok: false, code: 'CONTROL_ORIGIN_DENIED', message: 'foreign transport' }
      }
      if (csrf !== 'csrf-test') return { ok: false, code: 'CONTROL_CSRF_DENIED', message: 'bad csrf' }
      if (!requestId) return { ok: false, code: 'CONTROL_REPLAY_DENIED', message: 'missing request id' }
      return {
        ok: true,
        context: {
          activationId: view.activationId,
          principalSessionId: 'session-from-direct-command',
          signal: controller.signal,
        },
        view,
        finish: () => { this.finishes++ },
      }
    },
    revoke() { this.revokes++; controller.abort('revoked') },
    dispose() { this.disposed = true; controller.abort('disposed') },
  }
}

test('production GUI server serves only the exact character allowlist', async () => {
  let resolveAddress!: (address: GuiServerAddress) => void
  const ready = new Promise<GuiServerAddress>(resolve => { resolveAddress = resolve })
  const close = startGuiServer({
    snapshot: () => ({}) as never,
    taskDetail: () => null,
    eventsSince: () => ({ revision: 0, events: [] }),
    command: async () => ({
      ok: true, errorCode: null, message: 'accepted', task: null, execution: null,
      emittedEvents: [], allowedActions: [], revision: 1,
    }),
  }, { port: 0, onListening: resolveAddress })
  const address = await ready
  try {
    const allowed = await fetch(`${address.origin}/gui-assets/characters/supervisor-working.svg`)
    assert.equal(allowed.status, 200)
    assert.equal(allowed.headers.get('content-type'), 'image/svg+xml; charset=utf-8')
    assert.match(await allowed.text(), /@keyframes/u)

    const denied = await fetch(`${address.origin}/gui-assets/characters/not-allowlisted.svg`)
    assert.equal(denied.status, 404)
    assert.equal((await denied.json()).errorCode, 'GUI_ASSET_NOT_FOUND')
  } finally {
    close()
  }
})

test('local control HTTP wiring denies raw POST and passes only broker context', async () => {
  let expectedOrigin = ''
  const broker = fakeBroker(() => expectedOrigin)
  let commandCalls = 0
  let seenPrincipal: string | null = null
  let resolveAddress!: (address: GuiServerAddress) => void
  const ready = new Promise<GuiServerAddress>(resolve => { resolveAddress = resolve })
  const close = startGuiServer({
    snapshot: () => ({}) as never,
    taskDetail: () => null,
    eventsSince: () => ({ revision: 0, events: [] }),
    command: async (_name, _payload, control) => {
      commandCalls++
      seenPrincipal = control?.principalSessionId ?? null
      return {
        ok: true, errorCode: null, message: 'accepted', task: null, execution: null,
        emittedEvents: [], allowedActions: [], revision: 1,
      }
    },
  }, {
    port: 0,
    token: 'configured-bearer-remains-compatible',
    control: broker,
    onListening: address => { expectedOrigin = address.origin; resolveAddress(address) },
  })
  const address = await ready
  try {
    const raw = await fetch(`${address.origin}/api/commands/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kingdom-client': 'v0.9' },
      body: '{"title":"blocked"}',
    })
    assert.equal(raw.status, 401)
    assert.equal(commandCalls, 0)

    const badTicket = await fetch(`${address.origin}/console?ticket=bad`, { redirect: 'manual' })
    assert.equal(badTicket.status, 410)

    const redeemed = await fetch(`${address.origin}/console?ticket=launch-once`, { redirect: 'manual' })
    assert.equal(redeemed.status, 303)
    assert.equal(redeemed.headers.get('location'), '/console')
    const setCookie = redeemed.headers.get('set-cookie') ?? ''
    assert.match(setCookie, /dsh_kingdom_control=cookie-test/u)
    assert.match(setCookie, /HttpOnly/u)
    assert.match(setCookie, /SameSite=Strict/u)
    const cookie = setCookie.split(';', 1)[0]!

    const consolePage = await fetch(`${address.origin}/console`, { headers: { cookie } })
    assert.equal(consolePage.status, 200)
    const consoleHtml = await consolePage.text()
    assert.doesNotMatch(consoleHtml, /setup-basic-form/u)
    assert.match(consoleHtml, /review-form/u)
    assert.match(consoleHtml, /\/gui-assets\/characters\/chancellor-idle\.svg/u)
    assert.match(consoleHtml, /const CHARACTER_SVGS =/u)
    assert.match(consoleHtml, /data-runtime-role/u)
    assert.doesNotMatch(consoleHtml, /class="pixel-sprite"[^>]+src=/u)
    for (const assetName of GUI_CHARACTER_ASSET_FILES) {
      const asset = await fetch(`${address.origin}/gui-assets/characters/${assetName}`, { headers: { cookie } })
      assert.equal(asset.status, 200, `${assetName} must be served from the allowlist`)
      assert.match(asset.headers.get('content-type') ?? '', /image\/svg\+xml/u)
      const body = await asset.text()
      assert.match(body, /<svg[\s\S]*@keyframes/u, `${assetName} must retain internal animation frames`)
      assert.match(body, /prefers-reduced-motion/u, `${assetName} must retain reduced-motion fallback`)
    }
    const disallowedAsset = await fetch(`${address.origin}/gui-assets/characters/../server.ts`, { headers: { cookie } })
    assert.equal(disallowedAsset.status, 404)

    const control = await fetch(`${address.origin}/api/control`, { headers: { cookie } })
    assert.equal(control.status, 200)
    const publicView = await control.json() as { csrfToken?: string; active?: boolean }
    assert.equal(publicView.active, true)
    assert.equal(publicView.csrfToken, 'csrf-test')
    assert.equal(Object.prototype.hasOwnProperty.call(publicView, 'readContext'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(publicView, 'principalSessionId'), false)

    const deniedCsrf = await fetch(`${address.origin}/api/commands/plan`, {
      method: 'POST',
      headers: {
        origin: address.origin, cookie, 'content-type': 'application/json', 'x-kingdom-client': 'v0.9',
        'x-kingdom-request-id': 'request-1',
      },
      body: '{"title":"blocked"}',
    })
    assert.equal(deniedCsrf.status, 403)
    assert.equal(commandCalls, 0)

    const forgedIdentity = await fetch(`${address.origin}/api/commands/plan`, {
      method: 'POST',
      headers: {
        origin: address.origin, cookie, 'content-type': 'application/json', 'x-kingdom-client': 'v0.9',
        'x-kingdom-csrf': 'csrf-test', 'x-kingdom-request-id': 'request-2',
      },
      body: '{"title":"blocked","session_id":"forged-browser-session"}',
    })
    assert.equal(forgedIdentity.status, 400)
    assert.equal(commandCalls, 0)

    const accepted = await fetch(`${address.origin}/api/commands/plan`, {
      method: 'POST',
      headers: {
        origin: address.origin, cookie, 'content-type': 'application/json', 'x-kingdom-client': 'v0.9',
        'x-kingdom-csrf': 'csrf-test', 'x-kingdom-request-id': 'request-3',
      },
      body: '{"title":"accepted"}',
    })
    assert.equal(accepted.status, 200)
    assert.equal(commandCalls, 1)
    assert.equal(seenPrincipal, 'session-from-direct-command')
    assert.equal(broker.finishes, 2)
  } finally {
    close()
  }
  assert.equal(broker.disposed, true)
})

test('state-bearing GET requires exact local Origin plus valid control cookie or configured bearer', async () => {
  let expectedOrigin = ''
  const broker = fakeBroker(() => expectedOrigin)
  const calls = { snapshot: 0, task: 0, events: 0 }
  const snapshotPrincipals: Array<string | null> = []
  const taskPrincipals: Array<string | null> = []
  const revision = 17
  let resolveAddress!: (address: GuiServerAddress) => void
  const ready = new Promise<GuiServerAddress>(resolve => { resolveAddress = resolve })
  const close = startGuiServer({
    snapshot: (readContext) => {
      calls.snapshot++
      snapshotPrincipals.push(readContext?.principalSessionId ?? null)
      return { revision, source: 'snapshot' } as never
    },
    taskDetail: (_taskId, readContext) => {
      calls.task++
      taskPrincipals.push(readContext?.principalSessionId ?? null)
      return { revision, source: 'task' } as never
    },
    eventsSince: () => {
      calls.events++
      return { revision, events: [] }
    },
    command: async () => ({
      ok: true, errorCode: null, message: 'unused', task: null, execution: null,
      emittedEvents: [], allowedActions: [], revision,
    }),
  }, {
    port: 0,
    token: 'read-bearer',
    control: broker,
    onListening: address => { expectedOrigin = address.origin; resolveAddress(address) },
  })
  const address = await ready
  const routes = ['/api/snapshot', '/api/tasks/task-read', '/api/events?since=0'] as const
  try {
    for (const route of routes) {
      const denied = await fetch(`${address.origin}${route}`)
      assert.equal(denied.status, 401, `${route} must not be anonymous`)
    }
    assert.deepEqual(calls, { snapshot: 0, task: 0, events: 0 })

    for (const route of routes) {
      const bearer = await fetch(`${address.origin}${route}`, {
        headers: { authorization: 'Bearer read-bearer' },
      })
      assert.equal(bearer.status, 200, `${route} accepts configured bearer`)
    }
    assert.deepEqual(calls, { snapshot: 1, task: 1, events: 1 })
    assert.deepEqual(snapshotPrincipals, [null])
    assert.deepEqual(taskPrincipals, [null])

    const cookie = 'dsh_kingdom_control=cookie-test'
    const controlledSnapshot = await fetch(`${address.origin}/api/snapshot`, {
      headers: { origin: address.origin, cookie },
    })
    assert.equal(controlledSnapshot.status, 200)
    const controlledBody = await controlledSnapshot.text()
    assert.equal(controlledBody.includes('session-from-direct-command'), false,
      'opaque read context must not be serialized')
    const controlledTask = await fetch(`${address.origin}/api/tasks/task-read`, { headers: { cookie } })
    assert.equal(controlledTask.status, 200, 'controlled same-origin GET may omit Origin')
    const controlledEvents = await fetch(`${address.origin}/api/events`, { headers: { cookie } })
    assert.equal(controlledEvents.status, 200)
    assert.deepEqual(calls, { snapshot: 2, task: 2, events: 2 })
    assert.deepEqual(snapshotPrincipals, [null, 'session-from-direct-command'])
    assert.deepEqual(taskPrincipals, [null, 'session-from-direct-command'])

    const beforeDenied = { ...calls }
    const invalidCookie = await fetch(`${address.origin}/api/snapshot`, {
      headers: {
        authorization: 'Bearer read-bearer',
        cookie: 'dsh_kingdom_control=forged-cookie',
      },
    })
    assert.equal(invalidCookie.status, 401, 'bad cookie must not downgrade to bearer')
    const expiredCookie = await fetch(`${address.origin}/api/tasks/task-read`, {
      headers: {
        authorization: 'Bearer read-bearer',
        cookie: 'dsh_kingdom_control=expired-cookie',
      },
    })
    assert.equal(expiredCookie.status, 410)

    for (const route of routes) {
      const foreign = await fetch(`${address.origin}${route}`, {
        headers: { origin: 'http://evil.example', cookie },
      })
      assert.equal(foreign.status, 403, `${route} must reject foreign Origin`)
      assert.notEqual(foreign.headers.get('access-control-allow-origin'), 'http://evil.example')
    }
    assert.deepEqual(calls, beforeDenied, 'denied reads must not invoke state handlers')
    assert.equal(revision, 17)
  } finally {
    close()
  }
})

test('GUI command payload grammar rejects authority aliases, duplicates, nesting, and per-command unrecognized fields', async () => {
  let expectedOrigin = ''
  const broker = fakeBroker(() => expectedOrigin)
  let commandCalls = 0
  let revision = 23
  let requestNo = 0
  let resolveAddress!: (address: GuiServerAddress) => void
  const ready = new Promise<GuiServerAddress>(resolve => { resolveAddress = resolve })
  const close = startGuiServer({
    snapshot: () => ({}) as never,
    taskDetail: () => null,
    eventsSince: () => ({ revision, events: [] }),
    command: async () => {
      commandCalls++
      revision++
      return {
        ok: true, errorCode: null, message: 'accepted', task: null, execution: null,
        emittedEvents: [], allowedActions: [], revision,
      }
    },
  }, {
    port: 0,
    control: broker,
    onListening: address => { expectedOrigin = address.origin; resolveAddress(address) },
  })
  const address = await ready
  const postRaw = (name: string, body: string): Promise<Response> => fetch(
    `${address.origin}/api/commands/${name}`,
    {
      method: 'POST',
      headers: {
        origin: address.origin,
        cookie: 'dsh_kingdom_control=cookie-test',
        'content-type': 'application/json',
        'x-kingdom-client': 'strict-payload-test',
        'x-kingdom-csrf': 'csrf-test',
        'x-kingdom-request-id': `strict-${++requestNo}`,
      },
      body,
    },
  )
  try {
    const maliciousBodies = [
      '{"title":"x","principal":"forged"}',
      '{"title":"x","session":"forged"}',
      '{"title":"x","ownerControl":"forged"}',
      '{"title":"x","unknown":"forged"}',
      '{"title":{"principalSessionId":"forged"}}',
      '{"title":42}',
      '{"title":"first","title":"last"}',
    ]
    for (const body of maliciousBodies) {
      const response = await postRaw('plan', body)
      assert.equal(response.status, 400, body)
      assert.equal((await response.json() as { errorCode?: string }).errorCode, 'INVALID_BODY')
    }
    assert.equal(commandCalls, 0)
    assert.equal(revision, 23)

    const validPayloads: Record<string, Record<string, string>> = {
      plan: { title: 't', description: 'd', acceptance_criteria: 'ac', territory_id: 'terr' },
      assign: { task_id: 'task', worker_binding_id: 'worker' },
      start: { task_id: 'task', grant_json: '{}', sandbox_mode: 'read-only' },
      review: { task_id: 'task', decision: 'REWORK', reason: 'r', to_binding_id: 'worker' },
      'execution.pause': { execution_id: 'execution', reason: 'r' },
      'execution.resume': { execution_id: 'execution', reason: 'r' },
      'execution.abort': { execution_id: 'execution', reason: 'r' },
      'control.revoke': {},
    }
    for (const [command, payload] of Object.entries(validPayloads)) {
      const rejected = await postRaw(command, JSON.stringify({ ...payload, unexpected: 'blocked' }))
      assert.equal(rejected.status, 400, `${command} must reject an unknown field`)
    }
    assert.equal(commandCalls, 0)
    assert.equal(broker.revokes, 0)

    for (const [command, payload] of Object.entries(validPayloads)) {
      const accepted = await postRaw(command, JSON.stringify(payload))
      assert.equal(accepted.status, 200, `${command} exact payload must pass transport schema`)
    }
    assert.equal(commandCalls, 7, 'control.revoke is handled by the server, not the command handler')
    assert.equal(revision, 30)
    assert.equal(broker.revokes, 1)

    const ownerOnly = await fetch(`${address.origin}/api/commands/setup.basic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"ownerControl":"forged"}',
    })
    assert.equal(ownerOnly.status, 403)
    assert.equal((await ownerOnly.json() as { errorCode?: string }).errorCode, 'DIRECT_SLASH_REQUIRED')
    assert.equal(commandCalls, 7)
    assert.equal(revision, 30)
  } finally {
    close()
  }
})
