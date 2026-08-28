import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { rebindSession } from '../lib/core/binding.js'
import { KingdomStore } from '../lib/core/db.js'
import { issueOwnerControlCapability, ownerControlAuth } from '../lib/core/owner-control.js'
import { apply } from '../lib/index.js'

interface Tool {
  execute(args: Record<string, unknown>, exec?: unknown): Promise<unknown>
}

interface Command {
  handler(input: { rawInput: string }): Promise<{ kind: string; text: string }>
}

function makeContext() {
  const tools = new Map<string, Tool>()
  const commands = new Map<string, Command>()
  const disposers: (() => void)[] = []
  return {
    tools,
    commands,
    context: {
      tools: { register(tool: Tool) { tools.set((tool as Tool & { name?: string }).name ?? '', tool); return () => {} } },
      commands: { register(command: Command & { name?: string }) { commands.set(command.name ?? '', command); return () => {} } },
      effect(callback: () => unknown) { const result = callback(); if (typeof result === 'function') disposers.push(result as () => void) },
      get() { return undefined },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    },
    dispose() { for (const dispose of disposers.reverse()) dispose() },
  }
}

test('Owner Control direct Slash 原子 init、Owner actor 与 Tool zero-write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-kingdom-owner-control-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const harness = makeContext()
  try {
    apply(harness.context as never, {
      kingdomName: 'owner-control-test', ownerName: 'human-owner', workerProvider: 'spawn',
      guiPort: 0, guiToken: '', guiAllowOrigins: ['*'], authMode: 'session-bound', migrateV4: true,
    })
    const command = harness.commands.get('kingdom')!
    const init = harness.tools.get('kingdom_init')!
    const ceilingTool = harness.tools.get('kingdom_set_capability_ceiling')!
    assert.match(String(await init.execute({}, {})), /^OWNER_CONTROL_REQUIRED:/)
    assert.match((await command.handler({ rawInput: 'init' })).text, /已初始化王国/)
    assert.match((await command.handler({ rawInput: 'init extra' })).text, /INPUT_DENIED/)

    const dbPath = join(root, 'kingdom', 'kingdom.db')
    const store = new KingdomStore(dbPath, { allowSchemaV4: true })
    try {
      const kingdom = store.getDefaultKingdom()!
      assert.equal(store.listKingdoms().length, 1)
      const owner = store.getBindingByRole(kingdom.kingdom_id, 'OWNER')!
      assert.equal(owner.session_id, null)
      assert.equal(owner.principal_id, kingdom.owner_id)
      const event = store.listEvents(kingdom.kingdom_id, 10).find(row => row.event_type === 'KINGDOM_CREATED')!
      assert.equal(event.actor_role, 'OWNER')
      assert.equal(event.actor_id, kingdom.owner_id)
      assert.equal(JSON.parse(event.payload_json).source_channel, 'LOCAL_DIRECT_SLASH')

      const before = store.listEvents(kingdom.kingdom_id, 100).length
      assert.match(String(await ceilingTool.execute({ ceiling_json: '{"tool:pwsh":true}' }, { agent: { session: { id: 'agent-session' } } })), /^OWNER_CONTROL_REQUIRED:/)
      assert.equal(store.getKingdomCapabilityCeiling(kingdom.kingdom_id), null)
      assert.equal(store.listEvents(kingdom.kingdom_id, 100).length, before)

      const direct = await command.handler({ rawInput: 'ceiling {"ceiling":{"tool:pwsh":true}}' })
      assert.equal(direct.kind, 'success')
      assert.equal(store.getKingdomCapabilityCeiling(kingdom.kingdom_id), '{"tool:pwsh":true}')

      const unknown = await command.handler({ rawInput: 'ceiling {"ceiling":{"tool:pwsh":true},"owner_session":"forged"}' })
      assert.equal(unknown.kind, 'error')
      assert.match(unknown.text, /不允许的字段/)

      const beforeDuplicateCeiling = store.getKingdomCapabilityCeiling(kingdom.kingdom_id)
      const beforeDuplicateEvents = store.listEvents(kingdom.kingdom_id, 100).length
      const duplicate = await command.handler({ rawInput: 'ceiling {"ceiling":{"tool:pwsh":false},"ceiling":{"tool:pwsh":true}}' })
      assert.equal(duplicate.kind, 'error')
      assert.match(duplicate.text, /重复字段/)
      assert.equal(store.getKingdomCapabilityCeiling(kingdom.kingdom_id), beforeDuplicateCeiling)
      assert.equal(store.listEvents(kingdom.kingdom_id, 100).length, beforeDuplicateEvents)

      const wrongType = await command.handler({ rawInput: 'territory.create {"name":123}' })
      assert.equal(wrongType.kind, 'error')
      assert.match(wrongType.text, /name 必须是 string/)
      assert.equal(store.listTerritories(kingdom.kingdom_id).length, 0)

      const created = await command.handler({ rawInput: 'territory.create {"name":"Headless","workspace_path":"C:/headless"}' })
      assert.equal(created.kind, 'success')
      const territory = store.listTerritories(kingdom.kingdom_id)[0]!
      const missingRegistryEvents = store.listEvents(kingdom.kingdom_id, 100).length
      const missingRegistryBind = await command.handler({ rawInput: 'role.bind {"role_type":"SUPERVISOR","role_name":"Supervisor","session_id":"sup-session"}' })
      assert.equal(missingRegistryBind.kind, 'error')
      assert.match(missingRegistryBind.text, /SESSION_UNKNOWN/u)
      assert.equal(store.listEvents(kingdom.kingdom_id, 100).length, missingRegistryEvents)
      assert.equal(store.getBindingsByRole(kingdom.kingdom_id, 'SUPERVISOR').length, 0)

      const bind = await command.handler({ rawInput: 'role.bind {"role_type":"SUPERVISOR","role_name":"Supervisor"}' })
      assert.equal(bind.kind, 'success')
      const supervisor = store.getBindingsByRole(kingdom.kingdom_id, 'SUPERVISOR')[0]!
      const scope = await command.handler({ rawInput: `territory.supervisor {"territory_id":"${territory.territory_id}","supervisor_binding_id":"${supervisor.binding_id}"}` })
      assert.equal(scope.kind, 'success')
      const scopedEvent = store.listEvents(kingdom.kingdom_id, 100).find(row => row.event_type === 'TERRITORY_SUPERVISOR_UPDATED')!
      const payload = JSON.parse(scopedEvent.payload_json)
      assert.equal(scopedEvent.actor_id, kingdom.owner_id)
      assert.equal(payload.source_channel, 'LOCAL_DIRECT_SLASH')

      const ownerSessionEvents = store.listEvents(kingdom.kingdom_id, 100).length
      const ownerSession = await command.handler({ rawInput: `role.session {"role_type":"OWNER","session_id":"must-not-bind"}` })
      assert.equal(ownerSession.kind, 'error')
      assert.match(ownerSession.text, /OWNER_CONTROL_REQUIRED/)
      assert.equal(store.listEvents(kingdom.kingdom_id, 100).length, ownerSessionEvents)
      assert.equal(store.getBindingByRole(kingdom.kingdom_id, 'OWNER')!.session_id, null)

      const ownerBinding = store.getBindingByRole(kingdom.kingdom_id, 'OWNER')!
      const coreEvents = store.listEvents(kingdom.kingdom_id, 100).length
      const coreRejected = rebindSession(store, {
        kingdomId: kingdom.kingdom_id,
        bindingId: ownerBinding.binding_id,
        sessionId: 'core-forged-session',
      }, ownerControlAuth(issueOwnerControlCapability()))
      assert.match(coreRejected, /^OWNER_CONTROL_REQUIRED:/u)
      assert.equal(store.listEvents(kingdom.kingdom_id, 100).length, coreEvents)
      assert.equal(store.getBindingById(ownerBinding.binding_id)?.session_id, null)
    } finally {
      store.close()
    }
  } finally {
    harness.dispose()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test('Owner transaction exception returns recovery marker without success or persisted state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-kingdom-owner-transaction-recovery-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const harness = makeContext()
  try {
    apply(harness.context as never, {
      kingdomName: 'owner-transaction-recovery-test', ownerName: 'human-owner', workerProvider: 'spawn',
      guiPort: 0, guiToken: '', guiAllowOrigins: ['*'], authMode: 'session-bound', migrateV4: true,
    })
    const command = harness.commands.get('kingdom')!
    assert.equal((await command.handler({ rawInput: 'init' })).kind, 'success')

    const store = new KingdomStore(join(root, 'kingdom', 'kingdom.db'), { allowSchemaV4: true })
    const originalWithImmediateTransaction = KingdomStore.prototype.withImmediateTransaction
    try {
      const kingdom = store.getDefaultKingdom()!
      const eventsBefore = store.listEvents(kingdom.kingdom_id, 100).length

      // Run the real transaction callback, then fail before COMMIT. The public
      // transaction wrapper rolls back; ownerWrite must expose uncertainty,
      // never convert it into a success result.
      KingdomStore.prototype.withImmediateTransaction = function <T>(this: KingdomStore, fn: () => T): T {
        return originalWithImmediateTransaction.call(this, () => {
          fn()
          throw new Error('injected Owner transaction failure before commit')
        })
      }

      const uncertain = await command.handler({ rawInput: 'territory.create {"name":"must-rollback"}' })
      assert.equal(uncertain.kind, 'error')
      assert.match(uncertain.text, /^UNKNOWN\/RECOVERY_REQUIRED:/u)
      assert.equal(store.listTerritories(kingdom.kingdom_id).length, 0)
      assert.equal(store.listEvents(kingdom.kingdom_id, 100).length, eventsBefore)
    } finally {
      KingdomStore.prototype.withImmediateTransaction = originalWithImmediateTransaction
      store.close()
    }
  } finally {
    harness.dispose()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test('LEGACY_COMPAT machine gate rejects implicit one-shot selection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-kingdom-legacy-gate-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const harness = makeContext()
  try {
    apply(harness.context as never, {
      kingdomName: 'legacy-gate-test', ownerName: 'human-owner', workerProvider: 'spawn',
      guiPort: 0, guiToken: '', guiAllowOrigins: ['*'], authMode: 'session-bound', migrateV4: true,
    })
    const command = harness.commands.get('kingdom')!
    await command.handler({ rawInput: 'init' })
    const legacy = harness.tools.get('kingdom_start_task')!
    assert.match(String(await legacy.execute({ task_id: 'missing' }, { agent: { session: { id: 'caller' } } })), /^LEGACY_COMPAT_REQUIRED:/)
    assert.match(String(await legacy.execute({ task_id: 'missing', legacy_opt_in: false }, { agent: { session: { id: 'caller' } } })), /^LEGACY_COMPAT_REQUIRED:/)
  } finally {
    harness.dispose()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
})
