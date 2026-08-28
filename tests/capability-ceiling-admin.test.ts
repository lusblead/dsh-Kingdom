import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KingdomStore } from '../lib/core/db.js'
import { setCapabilityCeiling } from '../lib/capability/admin.js'
import type { AdminAuth } from '../lib/core/binding.js'
import { issueOwnerControlCapability, ownerControlAuth } from '../lib/core/owner-control.js'

const KINGDOM_ID = 'kingdom-ceiling-admin'
const OWNER_SESSION = 'dsh-owner-session'
const STRANGER_SESSION = 'dsh-stranger-session'

function makeStore(): KingdomStore {
  const store = new KingdomStore(':memory:')
  const now = new Date().toISOString()
  store.insertKingdom({
    kingdom_id: KINGDOM_ID,
    name: 'Ceiling Test Kingdom',
    created_at: now,
    owner_id: 'owner-record',
    owner_name: 'Owner',
  })
  store.insertBinding({
    binding_id: 'binding-owner',
    kingdom_id: KINGDOM_ID,
    role_type: 'OWNER',
    role_name: 'Owner',
    runtime_type: 'dsh',
    session_id: OWNER_SESSION,
    model_name: null,
    agent_name: null,
    session_meta: null,
    execution_profile_json: null,
    principal_id: null,
    created_at: now,
    updated_at: now,
  })
  return store
}

const ownerAuth = (): AdminAuth => ownerControlAuth(issueOwnerControlCapability())
const strangerAuth = (): AdminAuth => ({ mode: 'session-bound', principalSessionId: STRANGER_SESSION })

test('setCapabilityCeiling: only direct Owner Control may configure a ceiling', () => {
  const store = makeStore()
  const denied = setCapabilityCeiling(store, {
    kingdomId: KINGDOM_ID,
    ceilingJson: '{"filesystem.write":true}',
  }, strangerAuth())
  assert.match(denied, /^CONFIG_DENIED:/)
  assert.equal(store.getKingdomCapabilityCeiling(KINGDOM_ID), null)
  assert.equal(store.listEvents(KINGDOM_ID, 20).some(e => e.event_type === 'CAPABILITY_CEILING_UPDATED'), false)

  const allowed = setCapabilityCeiling(store, {
    kingdomId: KINGDOM_ID,
    ceilingJson: '{"filesystem.write":true,"tool:pwsh":false}',
  }, ownerAuth())
  assert.match(allowed, /已配置/)
  assert.match(allowed, /Supervisor Agent Session/)
  assert.doesNotMatch(allowed, /OWNER 会话/)
  assert.deepEqual(JSON.parse(store.getKingdomCapabilityCeiling(KINGDOM_ID)!), {
    'filesystem.write': true,
    'tool:pwsh': false,
  })
  const event = store.listEvents(KINGDOM_ID, 20).find(e => e.event_type === 'CAPABILITY_CEILING_UPDATED')!
  assert.equal(event.actor_role, 'OWNER')
  assert.equal(event.actor_id, 'owner-record')
  assert.equal(event.target_id, KINGDOM_ID)
})

test('setCapabilityCeiling: malformed and non-boolean ceiling input is rejected', () => {
  const store = makeStore()
  for (const ceilingJson of ['not-json', '[]', 'null', '{"filesystem.write":"yes"}', '{"":true}']) {
    const result = setCapabilityCeiling(store, { kingdomId: KINGDOM_ID, ceilingJson }, ownerAuth())
    assert.match(result, /^CONFIG_DENIED:/, ceilingJson)
    assert.equal(store.getKingdomCapabilityCeiling(KINGDOM_ID), null)
  }
  assert.equal(store.listEvents(KINGDOM_ID, 20).some(e => e.event_type === 'CAPABILITY_CEILING_UPDATED'), false)
})

test('setCapabilityCeiling: clear is an auditable fail-closed reset', () => {
  const store = makeStore()
  setCapabilityCeiling(store, { kingdomId: KINGDOM_ID, ceilingJson: '{"filesystem.read":true}' }, ownerAuth())
  const cleared = setCapabilityCeiling(store, { kingdomId: KINGDOM_ID, ceilingJson: null }, ownerAuth())
  assert.match(cleared, /fail-closed/)
  assert.equal(store.getKingdomCapabilityCeiling(KINGDOM_ID), null)
  const events = store.listEvents(KINGDOM_ID, 20).filter(e => e.event_type === 'CAPABILITY_CEILING_UPDATED')
  assert.equal(events.length, 2)
  assert.deepEqual(JSON.parse(events[0]!.payload_json), {
    ceiling: null,
    cleared: true,
    source: 'direct-owner-slash',
    source_channel: 'LOCAL_DIRECT_SLASH',
  })
})

test('setCapabilityCeiling: matching legacy OWNER.session_id remains zero-write', () => {
  const store = makeStore()
  const beforeEvents = store.listEvents(KINGDOM_ID, 20).length
  const denied = setCapabilityCeiling(store, {
    kingdomId: KINGDOM_ID,
    ceilingJson: '{"filesystem.write":true}',
  }, { mode: 'session-bound', principalSessionId: OWNER_SESSION })
  assert.match(denied, /^CONFIG_DENIED: OWNER_CONTROL_REQUIRED:/)
  assert.equal(store.getKingdomCapabilityCeiling(KINGDOM_ID), null)
  assert.equal(store.listEvents(KINGDOM_ID, 20).length, beforeEvents)
})
