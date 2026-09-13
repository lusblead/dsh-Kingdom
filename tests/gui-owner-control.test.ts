import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { OwnerLocalControlManager, OWNER_CONTROL_COOKIE } from '../lib/gui/owner-control.js'
import { startGuiServer } from '../lib/gui/server.js'
import { issueOwnerControlCapability } from '../lib/core/owner-control.js'
import type { OwnerDecisionController, OwnerDecisionInput, OwnerDecisionView } from '../lib/core/owner-window.js'

const scope = { kingdomWide: false, territoryIds: [], bindingIds: [], roleTypes: [], targetSessionIds: [], workspaceRoots: [] }
const input: OwnerDecisionInput = { kingdomId: null, actions: ['init'], scope, ttlMs: 600_000 }

function fixtureController(clock: () => number) {
  const decisions = new Map<object, OwnerDecisionView>()
  const receipts = new Map<string, unknown>()
  let sequence = 0
  let applyCount = 0
  let waitForPreparation: (() => Promise<void>) | null = null
  const fail = (code: string): never => { throw Object.assign(new Error(code), { code }) }
  const controller = {
    activate(_capability: unknown, value: OwnerDecisionInput) {
      if (!value.actions.length) return fail('OWNER_ACTION_DENIED')
      const handle = Object.freeze({ fixture: ++sequence })
      const decision: OwnerDecisionView = { decisionId: 'decision-' + sequence, kingdomId: value.kingdomId, ownerId: null,
        actions: value.actions, scope: value.scope, createdAt: new Date(clock()).toISOString(), expiresAt: new Date(clock() + value.ttlMs).toISOString(), state: 'ACTIVE' }
      decisions.set(handle, decision); return { handle, decision }
    },
    inspect(handle: object) {
      const view = decisions.get(handle)
      if (view && view.state === 'ACTIVE' && Date.parse(view.expiresAt) <= clock()) view.state = 'EXPIRED'
      return view ? structuredClone(view) : null
    },
    catalog() { return Promise.resolve({ territories: [], bindings: [], runtimeSessions: [], workspaceRoots: [] }) },
    async prepare(handle: object, value: Record<string, unknown>, options: { signal: AbortSignal }) {
      if (waitForPreparation) await waitForPreparation()
      if (options.signal.aborted || controller.inspect(handle)?.state !== 'ACTIVE') return fail('OWNER_DECISION_REVOKED')
      if (value.action !== 'init') return fail('OWNER_ACTION_DENIED')
      if (Object.keys(value.parameters as object).some(key => !['kingdom_name', 'owner_name'].includes(key))) return fail('OWNER_INPUT_INVALID')
      return { prepareId: 'prepare-1', operationId: 'operation-1', decisionId: controller.inspect(handle)!.decisionId, action: 'init',
        summary: '初始化', changes: [{ label: '王国', before: null, after: '验证王国' }], affected: { territoryIds: [], bindingIds: [] }, createdAt: new Date(clock()).toISOString(), expiresAt: new Date(clock() + 30_000).toISOString() }
    },
    async commit(handle: object, value: { prepareId: string; operationId: string }) {
      if (controller.inspect(handle)?.state !== 'ACTIVE') return fail('OWNER_DECISION_REVOKED')
      if (value.prepareId !== 'prepare-1' || value.operationId !== 'operation-1') return fail('OWNER_PREPARE_MISMATCH')
      if (receipts.has(value.operationId)) return receipts.get(value.operationId)
      applyCount++
      const receipt = { type: 'KingdomOwnerOperationReceipt/v1', ...value, decisionId: controller.inspect(handle)!.decisionId,
        kingdomId: 'kingdom-1', ownerId: 'owner-human', action: 'init', inputHash: 'fixture-sha', status: 'APPLIED',
        target: { type: 'kingdom', id: 'kingdom-1' }, receiptSeq: applyCount, appliedAt: new Date(clock()).toISOString(), message: '变更已应用' }
      receipts.set(value.operationId, receipt); return receipt
    },
    receipt(handle: object, id: string) {
      const receipt = receipts.get(id) as { decisionId: string } | undefined
      return receipt?.decisionId === controller.inspect(handle)?.decisionId ? receipt : null
    },
    revoke(handle: object) { const view = decisions.get(handle); if (view) view.state = 'REVOKED'; return view },
    dispose() { for (const view of decisions.values()) view.state = 'REVOKED' },
  }
  return { controller: controller as unknown as OwnerDecisionController, applied: () => applyCount,
    waitPrepare: (fn: (() => Promise<void>) | null) => { waitForPreparation = fn } }
}

async function setup() {
  let now = Date.now()
  let origin = ''
  const fixture = fixtureController(() => now)
  const manager = new OwnerLocalControlManager({ controller: fixture.controller, expectedOrigin: () => origin, now: () => now })
  let resolveReady!: (value: string) => void
  const ready = new Promise<string>(resolve => { resolveReady = resolve })
  let roleCalls = 0
  const close = startGuiServer({ snapshot: () => ({}) as never, taskDetail: () => null, eventsSince: () => ({ revision: 0, events: [] }),
    command: async () => { roleCalls++; return {} as never } },
  { port: 0, token: 'unrelated-role-bearer', ownerControl: manager, onListening: address => { origin = address.origin; resolveReady(origin) } })
  await ready
  const activate = (value: OwnerDecisionInput = input) => manager.activate(issueOwnerControlCapability(), value)
  async function redeem(ticket: string) {
    const response = await fetch(origin + '/owner?ticket=' + encodeURIComponent(ticket), { redirect: 'manual' })
    return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' }
  }
  async function login() {
    const activation = activate(); const redemption = await redeem(activation.launchTicket)
    assert.equal(redemption.response.status, 303)
    const response = await fetch(origin + '/api/owner/control', { headers: { Cookie: redemption.cookie } })
    assert.equal(response.status, 200)
    const view = await response.json()
    return { cookie: redemption.cookie, csrf: view.csrfToken as string, view, ticket: activation.launchTicket }
  }
  let requests = 0
  const post = (auth: { cookie: string; csrf: string }, route: string, value: unknown, headers: Record<string, string> = {}) => fetch(origin + '/api/owner/' + route, {
    method: 'POST', headers: { Cookie: auth.cookie, Origin: origin, 'Content-Type': 'application/json', 'X-Kingdom-Client': 'owner-gui',
      'X-Kingdom-CSRF': auth.csrf, 'X-Kingdom-Request-Id': 'request-' + (++requests), ...headers }, body: typeof value === 'string' ? value : JSON.stringify(value),
  })
  return { manager, fixture, close, activate, redeem, login, post, origin, roleCalls: () => roleCalls, advance: (ms: number) => { now += ms } }
}

test('owner HTTP uses a separate one-time ticket and cookie with no Role/bearer upgrade', async () => {
  const f = await setup()
  try {
    const anonymous = await fetch(f.origin + '/owner')
    assert.equal(anonymous.status, 200)
    assert.match(await anonymous.text(), /从本地打开管理窗口/u)
    const auth = await f.login()
    assert.match(auth.cookie, new RegExp('^' + OWNER_CONTROL_COOKIE + '='))
    assert.equal((await f.redeem(auth.ticket)).response.status, 410)
    const denied = await fetch(f.origin + '/api/owner/control', { headers: { Cookie: 'dsh_kingdom_control=role-cookie', Authorization: 'Bearer unrelated-role-bearer' } })
    assert.equal(denied.status, 401)
    const role = await fetch(f.origin + '/api/commands/plan', { method: 'POST', headers: { Cookie: auth.cookie, Origin: f.origin, 'Content-Type': 'application/json', 'X-Kingdom-Client': 'owner-gui' }, body: '{}' })
    assert.equal(role.status, 401)
    assert.equal(f.roleCalls(), 0)
    assert.equal((await f.post(auth, 'prepare', { action: 'init', parameters: { kingdom_name: '验证王国', owner_name: '人类' } })).status, 200)
  } finally { f.close() }
})

test('owner ticket redemption removes secrets from URL and sets restrictive page headers', async () => {
  const f = await setup()
  try {
    const activation = f.activate()
    assert.equal(activation.ttlMs, 600_000)
    assert.ok(Date.parse(activation.expiresAt) > Date.now() + 590_000)
    const { response, cookie } = await f.redeem(activation.launchTicket)
    assert.equal(response.headers.get('location'), '/owner')
    assert.match(response.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/u)
    assert.match(response.headers.get('set-cookie')!, /Max-Age=900(?:;|$)/u)
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const page = await fetch(f.origin + '/owner', { headers: { Cookie: cookie } })
    const body = await page.text()
    assert.equal(body.includes(activation.launchTicket), false)
    assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/u)
    const nonce = /script-src 'nonce-([^']+)'/u.exec(page.headers.get('content-security-policy')!)![1]
    assert.ok(body.includes('<script nonce="' + nonce + '">'))
    const foreign = await f.redeem('bad-secret-token')
    assert.equal((await foreign.response.text()).includes('bad-secret-token'), false)
  } finally { f.close() }
})

test('owner control reads reject cross Origin, same-site metadata, duplicate cookie and wrong Host', async () => {
  const f = await setup()
  try {
    const auth = await f.login()
    for (const extra of [{ Origin: 'https://foreign.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) {
      const response = await fetch(f.origin + '/api/owner/control', { headers: { Cookie: auth.cookie, ...extra } })
      assert.equal(response.status, 403, JSON.stringify(extra))
      assert.equal((await response.text()).includes(auth.csrf), false)
    }
    // Native fetch replaces a supplied Host in this Node version; send the exact wire header.
    const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(f.origin + '/api/owner/control', { headers: { Cookie: auth.cookie, Host: 'localhost:' + new URL(f.origin).port } }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode))
      })
      request.on('error', reject); request.end()
    })
    assert.equal(foreignHost, 403)
    const repeated = await fetch(f.origin + '/api/owner/control', { headers: { Cookie: auth.cookie + '; ' + auth.cookie } })
    assert.equal(repeated.status, 401)
    const launch = f.activate()
    const crossLaunch = await fetch(f.origin + '/owner?ticket=' + launch.launchTicket, { redirect: 'manual', headers: { 'Sec-Fetch-Site': 'cross-site' } })
    assert.equal(crossLaunch.status, 403)
  } finally { f.close() }
})

test('owner mutation rejects missing CSRF, authority injection, duplicate fields, and oversized body', async () => {
  const f = await setup()
  try {
    const auth = await f.login()
    const value = { action: 'init', parameters: { kingdom_name: '验证王国', owner_name: '人类' } }
    assert.equal((await f.post(auth, 'prepare', value, { 'X-Kingdom-CSRF': 'wrong' })).status, 403)
    assert.equal((await f.post(auth, 'prepare', value, { Origin: 'https://foreign.invalid' })).status, 403)
    assert.equal((await f.post(auth, 'prepare', { ...value, authority: 'Owner' })).status, 400)
    assert.equal((await f.post(auth, 'prepare', { ...value, parameters: { ...value.parameters, principal: { owner: true } } })).status, 409)
    assert.equal((await f.post(auth, 'prepare', '{"action":"init","action":"ceiling","parameters":{}}')).status, 400)
    assert.equal((await f.post(auth, 'prepare', { ...value, parameters: { kingdom_name: 'x'.repeat(33_000) } })).status, 413)
    assert.equal(f.fixture.applied(), 0)
  } finally { f.close() }
})

test('owner commit pins both IDs and uses receipts for duplicate requests and response-loss lookup', async () => {
  const f = await setup()
  try {
    const auth = await f.login()
    const preview = await (await f.post(auth, 'prepare', { action: 'init', parameters: { kingdom_name: '验证王国', owner_name: '人类' } })).json()
    const body = { prepareId: preview.preview.prepareId, operationId: preview.preview.operationId }
    assert.equal((await f.post(auth, 'commit', { ...body, parameters: {} })).status, 400)
    const applied = await f.post(auth, 'commit', body, { 'X-Kingdom-Request-Id': 'same-transport-request' })
    assert.equal(applied.status, 200)
    // Treat its response as lost, then retrieve the existing server-side record.
    const lookup = await fetch(f.origin + '/api/owner/receipts/' + body.operationId, { headers: { Cookie: auth.cookie, 'X-Kingdom-Decision-Id': auth.view.decision.decisionId } })
    assert.equal((await lookup.json()).receipt.status, 'APPLIED')
    assert.equal((await f.post(auth, 'commit', body, { 'X-Kingdom-Request-Id': 'same-transport-request' })).status, 409)
    assert.equal((await f.post(auth, 'commit', body)).status, 200)
    assert.equal(f.fixture.applied(), 1)
    assert.equal((await f.post(auth, 'commit', { ...body, prepareId: 'different' })).status, 409)
  } finally { f.close() }
})

test('owner revoke bypasses busy preparation, aborts awaiting validation, and prevents later commit', async () => {
  const f = await setup()
  try {
    const auth = await f.login()
    let release!: () => void
    let started!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const begun = new Promise<void>(resolve => { started = resolve })
    f.fixture.waitPrepare(() => { started(); return waiting })
    const pending = f.post(auth, 'prepare', { action: 'init', parameters: { kingdom_name: '验证王国', owner_name: '人类' } })
    await begun
    assert.equal((await f.post(auth, 'prepare', { action: 'init', parameters: {} })).status, 409)
    assert.equal((await f.post(auth, 'revoke', {})).status, 200)
    release()
    assert.equal((await pending).status, 409)
    assert.equal((await f.post(auth, 'commit', { prepareId: 'prepare-1', operationId: 'operation-1' })).status, 410)
    assert.equal(f.fixture.applied(), 0)
  } finally { f.close() }
})

test('owner expiry, replacement, failed activation, and disposal do not recreate writable decisions', async () => {
  const f = await setup()
  try {
    const auth = await f.login()
    assert.throws(() => f.activate({ ...input, actions: [] }), /OWNER_ACTION_DENIED/u)
    assert.equal((await f.post(auth, 'prepare', { action: 'init', parameters: { kingdom_name: '验证王国', owner_name: '人类' } })).status, 200)
    const next = f.activate()
    assert.equal((await f.post(auth, 'commit', { prepareId: 'prepare-1', operationId: 'operation-1' })).status, 410)
    f.advance(30_001)
    assert.equal((await f.redeem(next.launchTicket)).response.status, 410)
    const current = await f.login()
    f.advance(600_001)
    assert.equal((await f.post(current, 'prepare', { action: 'init', parameters: {} })).status, 410)
    f.manager.dispose()
    assert.throws(() => f.activate(), /管理通道已关闭/u)
  } finally { f.close() }
})

test('owner receipt grace survives write expiry but expires server-side after five minutes', async () => {
  const f = await setup()
  try {
    const auth = await f.login()
    await f.post(auth, 'prepare', { action: 'init', parameters: { kingdom_name: '验证王国', owner_name: '人类' } })
    assert.equal((await f.post(auth, 'commit', { prepareId: 'prepare-1', operationId: 'operation-1' })).status, 200)
    f.advance(600_001)
    const read = await fetch(f.origin + '/api/owner/receipts/operation-1', { headers: { Cookie: auth.cookie, 'X-Kingdom-Decision-Id': auth.view.decision.decisionId } })
    assert.equal(read.status, 200)
    assert.equal((await read.json()).receipt.status, 'APPLIED')
    const control = await (await fetch(f.origin + '/api/owner/control', { headers: { Cookie: auth.cookie } })).json()
    assert.equal(control.csrfToken, null)
    assert.equal(control.catalog, null)
    assert.equal((await f.post(auth, 'prepare', { action: 'init', parameters: {} })).status, 410)
    assert.equal((await f.post(auth, 'commit', { prepareId: 'prepare-1', operationId: 'operation-1' })).status, 410)
    assert.equal((await f.post(auth, 'revoke', {})).status, 410)
    f.advance(300_000)
    // Retain and manually replay the cookie after browser expiry: server must still reject it.
    assert.equal((await fetch(f.origin + '/api/owner/receipts/operation-1', { headers: { Cookie: auth.cookie, 'X-Kingdom-Decision-Id': auth.view.decision.decisionId } })).status, 410)
  } finally { f.close() }
})

test('owner revoke shortens receipt grace to five minutes without allowing another write', async () => {
  const f = await setup()
  try {
    const auth = await f.login()
    await f.post(auth, 'prepare', { action: 'init', parameters: { kingdom_name: '验证王国', owner_name: '人类' } })
    await f.post(auth, 'commit', { prepareId: 'prepare-1', operationId: 'operation-1' })
    const revoked = await f.post(auth, 'revoke', {})
    assert.equal(revoked.status, 200)
    assert.match(revoked.headers.get('set-cookie')!, /Max-Age=300(?:;|$)/u)
    assert.equal((await fetch(f.origin + '/api/owner/receipts/operation-1', { headers: { Cookie: auth.cookie, 'X-Kingdom-Decision-Id': auth.view.decision.decisionId } })).status, 200)
    assert.equal((await f.post(auth, 'commit', { prepareId: 'prepare-1', operationId: 'operation-1' })).status, 410)
    f.advance(300_001)
    assert.equal((await fetch(f.origin + '/api/owner/receipts/operation-1', { headers: { Cookie: auth.cookie, 'X-Kingdom-Decision-Id': auth.view.decision.decisionId } })).status, 410)
  } finally { f.close() }
})

test('owner receipt lookup detects a replaced window and never reports the old operation as unrecorded', async () => {
  const f = await setup()
  try {
    const original = await f.login()
    await f.post(original, 'prepare', { action: 'init', parameters: { kingdom_name: '验证王国', owner_name: '人类' } })
    await f.post(original, 'commit', { prepareId: 'prepare-1', operationId: 'operation-1' })
    const replacement = await f.login()
    const lookup = await fetch(f.origin + '/api/owner/receipts/operation-1', { headers: {
      Cookie: replacement.cookie, 'X-Kingdom-Decision-Id': original.view.decision.decisionId,
    } })
    assert.equal(lookup.status, 409)
    const failure = await lookup.json()
    assert.equal(failure.errorCode, 'OWNER_WINDOW_REPLACED')
    assert.match(failure.message, /不能据此判断原操作未应用/u)
    assert.equal(JSON.stringify(failure).includes('NOT_RECORDED'), false)
    assert.equal((await fetch(f.origin + '/api/owner/receipts/operation-1', { headers: { Cookie: replacement.cookie } })).status, 400)
    const oldCookie = await fetch(f.origin + '/api/owner/receipts/operation-1', { headers: {
      Cookie: original.cookie, 'X-Kingdom-Decision-Id': original.view.decision.decisionId,
    } })
    assert.equal(oldCookie.status, 200)
    assert.equal((await oldCookie.json()).receipt.status, 'APPLIED')
    assert.equal((await f.post({ cookie: replacement.cookie, csrf: original.csrf }, 'commit', { prepareId: 'prepare-1', operationId: 'operation-1' })).status, 403)
    assert.equal(f.fixture.applied(), 1)
  } finally { f.close() }
})
