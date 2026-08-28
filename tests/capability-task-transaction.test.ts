import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KingdomStore } from '../lib/core/db.js'
import { planTask } from '../lib/core/task-service.js'

const NOW = () => new Date().toISOString()

function context(kingdomId: string) {
  return {
    kingdomId,
    auth: { mode: 'declarative' as const, trustLevel: 'local-demo' as const, note: '' },
  }
}

function seed(): { store: KingdomStore; kingdomId: string; territoryId: string } {
  const store = new KingdomStore(':memory:')
  const kingdomId = 'plan-transaction-kingdom'
  const territoryId = 'plan-transaction-territory'
  const now = NOW()
  store.insertKingdom({ kingdom_id: kingdomId, name: 'K', created_at: now, owner_id: 'owner', owner_name: 'Owner' })
  store.insertBinding({
    binding_id: 'chancellor', kingdom_id: kingdomId, role_type: 'CHANCELLOR', role_name: 'C',
    runtime_type: 'dsh', session_id: null, model_name: null, agent_name: null, session_meta: null,
    execution_profile_json: null, status: 'ACTIVE', retired_at: null, retired_reason: null,
    principal_id: null, created_at: now, updated_at: now,
  })
  store.insertTerritory({
    territory_id: territoryId, kingdom_id: kingdomId, name: 'T', workspace_path: null, summary: null,
    supervisor_binding_id: null, status: 'ACTIVE', deleted_at: null, deleted_reason: null,
    created_at: now,
  })
  return { store, kingdomId, territoryId }
}

test('PlanTask: optional capability requirement is inserted with the new Task transaction', () => {
  const { store, kingdomId, territoryId } = seed()
  const requirement = JSON.stringify({ 'tool:pwsh': true })
  const result = planTask(store, context(kingdomId), {
    title: 'atomic task', territoryId, capabilityRequirementJson: requirement,
  })
  assert.equal(result.ok, true)
  const taskId = result.task!.taskId
  assert.equal(store.getTaskCapabilityRequirement(taskId), requirement)
  assert.equal(store.getTask(taskId)?.capability_requirement_json, requirement)
})

test('PlanTask: event failure rolls back both Task and requirement', () => {
  const { store, kingdomId, territoryId } = seed()
  const original = store.appendEvent
  store.appendEvent = (() => { throw new Error('event write failed') }) as typeof original
  assert.throws(() => planTask(store, context(kingdomId), {
    title: 'must rollback', territoryId, capabilityRequirementJson: JSON.stringify({ 'tool:pwsh': true }),
  }), /event write failed/)
  assert.equal(store.listTasks(kingdomId).length, 0)
})
