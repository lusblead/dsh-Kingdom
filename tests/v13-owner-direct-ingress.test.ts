import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { KingdomStore } from '../lib/core/db.js'

test('canonical command reaches independent Owner HTTP and atomic bootstrap without a role session', async (t) => {
  const testRoot = mkdtempSync(join(tmpdir(), 'kingdom-v13-direct-'))
  const previousHome = process.env.DSH_HOME
  const commands = new Map<string, any>(); const tools = new Map<string, any>(); const disposers: Array<() => void> = []
  const agents = new Map<string, any>(); const sessions = new Map<string, any>()
  const targetSession = { id: 'v13-valid-supervisor', header: { cwd: testRoot } }
  const targetAgent = { id: targetSession.id, session: targetSession, status: 'idle' }
  agents.set(targetSession.id, targetAgent); sessions.set(targetSession.id, targetSession)
  let launchUrl = ''; let modelLookups = 0; let store: KingdomStore | null = null
  const context = {
    commands: { register: (command: any) => { commands.set(command.name, command); return () => commands.delete(command.name) } },
    tools: { register: (tool: any) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    effect: (callback: () => unknown) => { const value = callback(); if (typeof value === 'function') disposers.push(value as () => void) },
    get: (name: string): unknown => ({
      agents: { get: (id: string) => agents.get(id), list: () => [...agents.values()] },
      sessions: { get: (id: string) => sessions.get(id) },
      llm: { resolveModelInfo: async (provider: string, model: string) => { modelLookups++; assert.equal(provider, 'fixture'); assert.equal(model, 'fixture-model'); return { id: model } } },
    }[name]),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }
  t.after(async () => {
    await commands.get('kingdom')?.handler({ rawInput: 'gui stop' })
    store?.close(); for (const dispose of disposers.reverse()) dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
    const absolute = resolve(testRoot)
    assert.equal(dirname(absolute), resolve(tmpdir())); assert.ok(basename(absolute).startsWith('kingdom-v13-direct-'))
    rmSync(absolute, { recursive: true, force: true })
  })
  process.env.DSH_HOME = testRoot
  const plugin = await import('../lib/index.js')
  plugin.apply(context as never, { kingdomName: 'unused defaults', ownerName: 'unused defaults', workerProvider: 'fixture', guiPort: 0, guiToken: '', guiAllowOrigins: ['*'], authMode: 'session-bound', migrateV4: true }, { openLocalConsole: (url: string) => { launchUrl = url; return true } })
  const slash = commands.get('kingdom')
  assert.ok(slash); assert.equal(tools.has('kingdom_owner_gui'), false)
  const scope = { kingdomWide: false, territoryIds: [] as string[], bindingIds: [] as string[], roleTypes: [] as string[], targetSessionIds: [] as string[], workspaceRoots: [] as string[] }
  const bootstrap = { kingdomId: null, actions: ['init'], scope, ttlMs: 600_000 }
  const malformed = await slash.handler({ rawInput: 'owner.gui {"actions":["init"],"principal":"self"}' })
  assert.equal(malformed.kind, 'error'); assert.equal(launchUrl, '')
  const started = await slash.handler({ rawInput: 'owner.gui ' + JSON.stringify(bootstrap) })
  assert.equal(started.kind, 'success', started.text)
  assert.ok(!started.text.includes('ticket=')); assert.ok(!started.text.includes(new URL(launchUrl).searchParams.get('ticket')))
  const origin = new URL(launchUrl).origin
  let cookie = ''; let csrf = ''
  const redeem = async () => {
    const response = await fetch(launchUrl, { redirect: 'manual' })
    assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/owner')
    cookie = (response.headers.get('set-cookie') || '').split(';', 1)[0]
    assert.ok(cookie.startsWith('dsh_kingdom_owner='))
    const replay = await fetch(launchUrl, { redirect: 'manual' }); assert.notEqual(replay.status, 303)
    const control = await fetch(origin + '/api/owner/control', { headers: { cookie, origin } })
    assert.equal(control.status, 200)
    const view = await control.json() as any; csrf = view.csrfToken
    assert.equal(view.decision.state, 'ACTIVE'); assert.equal(typeof csrf, 'string')
    return view
  }
  await redeem()
  const request = async (path: string, payload: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(origin + '/api/owner/' + path, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json', 'x-kingdom-client': 'owner-gui', 'x-kingdom-csrf': csrf, 'x-kingdom-request-id': randomUUID(), ...headers }, body: JSON.stringify(payload) })
    return { status: response.status, body: await response.json() as any }
  }
  const rejected = await request('prepare', { action: 'init', parameters: { kingdom_name: 'bad', owner_name: 'bad' } }, { cookie: 'dsh_kingdom_control=role-cookie' })
  assert.notEqual(rejected.status, 200)
  const prepared = await request('prepare', { action: 'init', parameters: { kingdom_name: 'GUI bootstrap fixture', owner_name: 'Human fixture' } })
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body)); assert.equal(prepared.body.ok, true)
  const ids = { prepareId: prepared.body.preview.prepareId, operationId: prepared.body.preview.operationId }
  const applied = await request('commit', ids)
  assert.equal(applied.status, 200, JSON.stringify(applied.body)); assert.equal(applied.body.receipt.status, 'APPLIED')
  store = new KingdomStore(join(testRoot, 'kingdom', 'kingdom.db'), { allowSchemaV4: true })
  const kingdom = store.getDefaultKingdom()!
  assert.equal(kingdom.name, 'GUI bootstrap fixture'); assert.equal(kingdom.owner_name, 'Human fixture')
  assert.equal(store.getBindingByRole(kingdom.kingdom_id, 'OWNER')?.session_id, null)
  const created = store.listEventsSince(kingdom.kingdom_id, 0, 100).find(event => event.event_type === 'KINGDOM_CREATED')!
  assert.equal(created.actor_id, kingdom.owner_id)
  const source = JSON.parse(created.payload_json)
  assert.equal(source.source_channel, 'LOCAL_OWNER_GUI'); assert.equal(source.authorization_source, 'LOCAL_DIRECT_SLASH')
  const revision = store.revision(kingdom.kingdom_id)
  await request('commit', ids)
  assert.equal(store.revision(kingdom.kingdom_id), revision, 'bootstrap replay cannot create another kingdom or receipt')
  const activeScope = { ...scope, kingdomWide: true, roleTypes: ['SUPERVISOR'], targetSessionIds: [targetSession.id], workspaceRoots: [testRoot] }
  const managed = await slash.handler({ rawInput: 'owner.gui ' + JSON.stringify({ kingdomId: kingdom.kingdom_id, actions: ['territory.create', 'role.bind'], scope: activeScope, ttlMs: 600_000 }) })
  assert.equal(managed.kind, 'success', managed.text); await redeem()
  const territoryPreview = await request('prepare', { action: 'territory.create', parameters: { name: 'Fixture territory', workspace_path: testRoot } })
  assert.equal(territoryPreview.status, 200, JSON.stringify(territoryPreview.body))
  const territoryIds = { prepareId: territoryPreview.body.preview.prepareId, operationId: territoryPreview.body.preview.operationId }
  const territoryApplied = await request('commit', territoryIds); assert.equal(territoryApplied.status, 200, JSON.stringify(territoryApplied.body))
  const territoryReplay = await request('commit', territoryIds); assert.equal(territoryReplay.status, 200)
  assert.deepEqual(territoryReplay.body.receipt, territoryApplied.body.receipt)
  assert.equal(store.listTerritories(kingdom.kingdom_id).length, 1)
  const rolePreview = await request('prepare', { action: 'role.bind', parameters: { role_type: 'SUPERVISOR', role_name: 'Fixture supervisor', session_id: targetSession.id } })
  assert.equal(rolePreview.status, 200, JSON.stringify(rolePreview.body))
  agents.delete(targetSession.id)
  const staleRole = await request('commit', { prepareId: rolePreview.body.preview.prepareId, operationId: rolePreview.body.preview.operationId })
  assert.notEqual(staleRole.status, 200, 'real registry must be checked again before binding')
  assert.equal(store.getBindingsByRole(kingdom.kingdom_id, 'SUPERVISOR').length, 0)
  const revoked = await request('revoke', {}); assert.equal(revoked.status, 200)
  const afterRevoke = await request('prepare', { action: 'territory.create', parameters: { name: 'Denied', workspace_path: testRoot } })
  assert.notEqual(afterRevoke.status, 200)
  assert.equal(store.listTerritories(kingdom.kingdom_id).length, 1); assert.equal(modelLookups, 0)
})
