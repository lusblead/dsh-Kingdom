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
  // 非授权 hint 只接受字符串，且重复字段在严格 JSON 层就被拒绝；两种失败都不激活任何窗口。
  const badHintType = await slash.handler({ rawInput: 'owner.gui {"kingdomId":null,"actions":["init"],"scope":' + JSON.stringify(scope) + ',"ttlMs":600000,"taskHint":7}' })
  assert.equal(badHintType.kind, 'error'); assert.equal(badHintType.text.includes('taskHint'), true); assert.equal(launchUrl, '')
  const duplicateHint = await slash.handler({ rawInput: 'owner.gui {"kingdomId":null,"actions":["init"],"scope":' + JSON.stringify(scope) + ',"ttlMs":600000,"taskHint":"a","taskHint":"b"}' })
  assert.equal(duplicateHint.kind, 'error'); assert.equal(duplicateHint.text.includes('重复字段'), true); assert.equal(launchUrl, '')
  const unknownHint = await slash.handler({ rawInput: 'owner.gui {"kingdomId":null,"actions":["init"],"scope":' + JSON.stringify(scope) + ',"ttlMs":600000,"unknownHint":"a"}' })
  assert.equal(unknownHint.kind, 'error'); assert.equal(unknownHint.text.includes('不允许的字段'), true, unknownHint.text)
  assert.equal(launchUrl, '')
  const started = await slash.handler({ rawInput: 'owner.gui ' + JSON.stringify(bootstrap) })
  assert.equal(started.kind, 'success', started.text)
  assert.ok(!started.text.includes('ticket=')); assert.ok(!started.text.includes(new URL(launchUrl).searchParams.get('ticket')))
  const origin = new URL(launchUrl).origin
  let cookie = ''; let csrf = ''
  // 兑换 launchUrl 指向的票据；成功时返回 303 后浏览器地址栏里的 Location。
  // 不携带定位提示时必须精确落在 /owner：不附加任何 ack_*、ticket 或兜底参数。
  const redeem = async (expectedLocation = '/owner') => {
    const response = await fetch(launchUrl, { redirect: 'manual' })
    assert.equal(response.status, 303)
    const location = response.headers.get('location') || ''
    assert.equal(location, expectedLocation, 'the redirect lands on the exact Owner URL for this launch')
    assert.equal(location.includes('ticket'), false, 'the redirect never carries the one-time ticket')
    cookie = (response.headers.get('set-cookie') || '').split(';', 1)[0]
    assert.ok(cookie.startsWith('dsh_kingdom_owner='))
    const replay = await fetch(launchUrl, { redirect: 'manual' }); assert.notEqual(replay.status, 303)
    const control = await fetch(origin + '/api/owner/control', { headers: { cookie, origin } })
    assert.equal(control.status, 200)
    const view = await control.json() as any; csrf = view.csrfToken
    assert.equal(view.decision.state, 'ACTIVE'); assert.equal(typeof csrf, 'string')
    return { view, location }
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
  // v3.2.0：目录与提交同判据——主管的 role.bind 要求目标领地**显式**在授权范围内
  // （不再用 kingdomWide 放宽）。领地是本窗口里新建的，因此按 GUI 的真实用法重新激活一个
  // 包含它的窗口，再完成任命。
  scope.territoryIds.push(store.listTerritories(kingdom.kingdom_id)[0]!.territory_id)
  const roleWindow = await slash.handler({ rawInput: 'owner.gui ' + JSON.stringify({ kingdomId: kingdom.kingdom_id, actions: ['role.bind'], scope: activeScope, ttlMs: 600_000 }) })
  assert.equal(roleWindow.kind, 'success', roleWindow.text); await redeem()
  const rolePreview = await request('prepare', { action: 'role.bind', parameters: { role_type: 'SUPERVISOR', role_name: 'Fixture supervisor', session_id: targetSession.id,
    // v3.2.0：主管任命必须同时给出领地（席位与主理在同一事务原子写入）。
    territory_id: store.listTerritories(kingdom.kingdom_id)[0]!.territory_id } })
  assert.equal(rolePreview.status, 200, JSON.stringify(rolePreview.body))
  agents.delete(targetSession.id)
  const staleRole = await request('commit', { prepareId: rolePreview.body.preview.prepareId, operationId: rolePreview.body.preview.operationId })
  assert.notEqual(staleRole.status, 200, 'real registry must be checked again before binding')
  assert.equal(store.getBindingsByRole(kingdom.kingdom_id, 'SUPERVISOR').length, 0)
  const revoked = await request('revoke', {}); assert.equal(revoked.status, 200)
  const afterRevoke = await request('prepare', { action: 'territory.create', parameters: { name: 'Denied', workspace_path: testRoot } })
  assert.notEqual(afterRevoke.status, 200)
  assert.equal(store.listTerritories(kingdom.kingdom_id).length, 1); assert.equal(modelLookups, 0)

  // 定位提示必须三字段完整：只带一个 hint 的命令在激活前被拒绝，不产生任何窗口或票据 URL。
  const startUrl = launchUrl
  const partialHint = await slash.handler({ rawInput: 'owner.gui ' + JSON.stringify({ kingdomId: kingdom.kingdom_id, actions: ['territory.create'],
    scope: activeScope, ttlMs: 600_000, itemHint: 'item:' + 'a'.repeat(32) }) })
  assert.equal(partialHint.kind, 'error', partialHint.text)
  assert.equal(partialHint.text.includes('contentHashHint'), true, partialHint.text)
  assert.equal(launchUrl, startUrl, 'a rejected hint never opens a new window')
  // 三字段完整且格式有效时激活成功；票据兑换后 303 到只带这三个提示的无票据地址。
  const hints = { taskHint: 'task-fixture', itemHint: 'item:' + 'b'.repeat(32), contentHashHint: 'c'.repeat(64) }
  const hinted = await slash.handler({ rawInput: 'owner.gui ' + JSON.stringify({ kingdomId: kingdom.kingdom_id, actions: ['territory.create'],
    scope: activeScope, ttlMs: 600_000, ...hints }) })
  assert.equal(hinted.kind, 'success', hinted.text)
  assert.ok(launchUrl !== startUrl, 'a complete hint still activates with a fresh one-time ticket')
  assert.equal(launchUrl.includes('ack_'), false, 'the copied launch URL carries no ack query before redemption')
  const hintedRedemption = await redeem('/owner?ack_task=task-fixture&ack_item=' + encodeURIComponent(hints.itemHint) + '&ack_hash=' + hints.contentHashHint)
  assert.equal(hintedRedemption.location, '/owner?ack_task=task-fixture&ack_item=' + encodeURIComponent(hints.itemHint) + '&ack_hash=' + hints.contentHashHint)
  // hintAction 随 direct 命令透传：提问命令兑换后 303 到 ask_*，不会退化成知悉入口。
  const askedHints = { ...hints, hintAction: 'ask' }
  const asked = await slash.handler({ rawInput: 'owner.gui ' + JSON.stringify({ kingdomId: kingdom.kingdom_id, actions: ['delivery.item.question'],
    scope: activeScope, ttlMs: 600_000, ...askedHints }) })
  assert.equal(asked.kind, 'success', asked.text)
  await redeem('/owner?ask_task=task-fixture&ask_item=' + encodeURIComponent(hints.itemHint) + '&ask_hash=' + hints.contentHashHint)
  // 非法 hintAction 在激活前整体拒绝，不打开任何窗口。
  const beforeBadAction = launchUrl
  const badAction = await slash.handler({ rawInput: 'owner.gui ' + JSON.stringify({ kingdomId: kingdom.kingdom_id, actions: ['delivery.item.question'],
    scope: activeScope, ttlMs: 600_000, ...hints, hintAction: 'delete' }) })
  assert.equal(badAction.kind, 'error', badAction.text)
  assert.equal(badAction.text.includes('hintAction'), true, badAction.text)
  assert.equal(launchUrl, beforeBadAction, 'a rejected hintAction never opens a new window')
})
