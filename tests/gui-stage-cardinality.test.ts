import assert from 'node:assert/strict'
import test from 'node:test'
import { KingdomStore } from '../lib/core/db.js'
import { buildSnapshot, projectStage } from '../lib/gui/snapshot.js'
import { renderConsoleApp } from '../lib/gui/console-app.js'

const NOW = '2026-08-24T12:00:00.000Z'
const auth = { mode: 'declarative' as const, trustLevel: 'local-demo' as const, note: '' }

function binding(bindingId: string, roleType: string, roleName: string, status: 'ACTIVE' | 'RETIRED' = 'ACTIVE') {
  return {
    binding_id: bindingId, kingdom_id: 'production-cardinality', role_type: roleType,
    role_name: roleName, runtime_type: 'local', session_id: null, model_name: null,
    agent_name: null, session_meta: null, execution_profile_json: null, status,
    retired_at: status === 'RETIRED' ? NOW : null, retired_reason: status === 'RETIRED' ? 'replacement' : null,
    principal_id: null, created_at: NOW, updated_at: NOW,
  }
}

function task(taskId: string, territoryId: string, workerBindingId: string | null, status = 'RUNNING') {
  return {
    task_id: taskId, territory_id: territoryId, parent_task_id: null, title: taskId,
    description: null, assigned_binding_id: workerBindingId, status,
    acceptance_criteria: null, result_summary: null, created_at: NOW, updated_at: NOW,
  }
}

function execution(executionId: string, taskId: string, workerBindingId: string | null, state = 'RUNNING', attemptNo = 1) {
  return {
    execution_id: executionId, task_id: taskId, attempt_no: attemptNo,
    worker_binding_id: workerBindingId, session_id: null, state, detail: null,
    started_at: NOW, heartbeat_at: NOW, ended_at: state === 'FAILED' ? NOW : null,
    pause_requested_at: null, executor_kind: 'fixture', provider: null, provider_source: null,
    requested_model: null, resolved_model: null, model_source: null, execution_profile_json: null,
    execution_contract: 'LEGACY_COMPAT', lease_id: null, capability_decision_id: null,
  }
}

test('GUI stage projects every ACTIVE Supervisor/Worker binding with exact event and execution identity', () => {
  const stage = projectStage({
    bindings: [
      { binding_id: 'ch-a', role_type: 'CHANCELLOR', role_name: 'Chancellor A', status: 'ACTIVE' },
      { binding_id: 'ch-b', role_type: 'CHANCELLOR', role_name: 'Chancellor B', status: 'ACTIVE' },
      { binding_id: 'sup-a', role_type: 'SUPERVISOR', role_name: 'Supervisor A', status: 'ACTIVE' },
      { binding_id: 'sup-b', role_type: 'SUPERVISOR', role_name: 'Supervisor B', status: 'ACTIVE' },
      { binding_id: 'worker-a', role_type: 'WORKER', role_name: 'Worker A', status: 'ACTIVE' },
      { binding_id: 'worker-b', role_type: 'WORKER', role_name: 'Worker B', status: 'ACTIVE' },
    ] as never,
    territories: [
      { territory_id: 'territory-a', supervisor_binding_id: 'sup-a' },
      { territory_id: 'territory-b', supervisor_binding_id: 'sup-b' },
    ] as never,
    tasks: [
      { task_id: 'task-a', territory_id: 'territory-a', assigned_binding_id: 'worker-a', status: 'RUNNING', updated_at: NOW },
      { task_id: 'task-b', territory_id: 'territory-b', assigned_binding_id: 'worker-b', status: 'RUNNING', updated_at: NOW },
    ] as never,
    executions: [{
      execution_id: 'execution-b', task_id: 'task-b', attempt_no: 1,
      worker_binding_id: 'worker-b', state: 'RUNNING', started_at: NOW,
    }] as never,
    events: [
      {
        event_type: 'TASK_PLANNED', actor_role: 'CHANCELLOR', actor_id: 'ch-b',
        target_type: 'task', target_id: 'task-b', payload_json: '{}', created_at: NOW,
      },
      {
        event_type: 'TASK_ASSIGNED', actor_role: 'SUPERVISOR', actor_id: 'sup-b',
        target_type: 'task', target_id: 'task-b', payload_json: JSON.stringify({ worker_binding_id: 'worker-b' }), created_at: NOW,
      },
    ] as never,
    nowMs: Date.parse(NOW),
    transientWindowMs: 5_000,
  } as never)

  assert.equal(stage.length, 7, 'one absent Owner plus every exact bound role')
  const byBinding = new Map(stage.map(actor => [actor.bindingId, actor]))
  assert.equal(byBinding.get('ch-a')?.state, 'idle')
  assert.equal(byBinding.get('ch-b')?.state, 'planning')
  assert.equal(byBinding.get('sup-a')?.state, 'idle', 'Supervisor transient must not broadcast across territories')
  assert.equal(byBinding.get('sup-b')?.state, 'assigning')
  assert.equal(byBinding.get('worker-a')?.state, 'waiting', 'Task.RUNNING without this Worker execution is not working')
  assert.equal(byBinding.get('worker-b')?.state, 'working')
  assert.equal(byBinding.get('worker-b')?.executionId, 'execution-b')
  assert.ok(stage.some(actor => actor.role === 'OWNER' && actor.bindingId === null && actor.state === 'absent'))
})

test('GUI stage excludes RETIRED bindings and uses absent fallback when only retired history remains', () => {
  const replacement = projectStage({
    bindings: [
      { binding_id: 'old-chancellor', role_type: 'CHANCELLOR', role_name: '旧宰相', status: 'RETIRED' },
      { binding_id: 'new-chancellor', role_type: 'CHANCELLOR', role_name: '新宰相', status: 'ACTIVE' },
      { binding_id: 'old-worker', role_type: 'WORKER', role_name: '旧骑士', status: 'RETIRED' },
      { binding_id: 'new-worker', role_type: 'WORKER', role_name: '新骑士', status: 'ACTIVE' },
    ] as never,
    territories: [], tasks: [], executions: [], events: [], nowMs: Date.parse(NOW), transientWindowMs: 5_000,
  } as never)
  assert.equal(replacement.some(actor => actor.bindingId === 'old-chancellor' || actor.bindingId === 'old-worker'), false)
  assert.equal(replacement.filter(actor => actor.role === 'CHANCELLOR' && actor.bindingId !== null).length, 1)
  assert.equal(replacement.filter(actor => actor.role === 'WORKER' && actor.bindingId !== null).length, 1)

  const retiredOnly = projectStage({
    bindings: [{ binding_id: 'only-retired', role_type: 'WORKER', role_name: '仅退役骑士', status: 'RETIRED' }] as never,
    territories: [], tasks: [], executions: [], events: [], nowMs: Date.parse(NOW), transientWindowMs: 5_000,
  } as never)
  const absentWorker = retiredOnly.find(actor => actor.role === 'WORKER')
  assert.equal(absentWorker?.bindingId, null)
  assert.equal(absentWorker?.state, 'absent')
})

test('WORKER_EXECUTION_FAILED requires an ACTIVE Supervisor binding matching the current Territory pointer', () => {
  const stage = projectStage({
    bindings: [
      { binding_id: 'sup-current', role_type: 'SUPERVISOR', role_name: '当前主管', status: 'ACTIVE' },
      { binding_id: 'sup-retired', role_type: 'SUPERVISOR', role_name: '退役主管', status: 'RETIRED' },
      { binding_id: 'worker-current', role_type: 'WORKER', role_name: '当前骑士', status: 'ACTIVE' },
      { binding_id: 'worker-retired', role_type: 'WORKER', role_name: '退役指针骑士', status: 'ACTIVE' },
      { binding_id: 'worker-unknown', role_type: 'WORKER', role_name: '未知主管骑士', status: 'ACTIVE' },
      { binding_id: 'worker-role-mismatch', role_type: 'WORKER', role_name: '角色错配骑士', status: 'ACTIVE' },
    ] as never,
    territories: [
      { territory_id: 'territory-current', supervisor_binding_id: 'sup-current' },
      // Historical pointer intentionally remains on the RETIRED Supervisor.
      { territory_id: 'territory-retired', supervisor_binding_id: 'sup-retired' },
      { territory_id: 'territory-unknown', supervisor_binding_id: 'ghost-supervisor' },
      { territory_id: 'territory-role-mismatch', supervisor_binding_id: 'worker-role-mismatch' },
    ] as never,
    tasks: [
      task('task-current', 'territory-current', 'worker-current', 'REVIEW'),
      task('task-retired', 'territory-retired', 'worker-retired', 'REVIEW'),
      task('task-unknown', 'territory-unknown', 'worker-unknown', 'REVIEW'),
      task('task-role-mismatch', 'territory-role-mismatch', 'worker-role-mismatch', 'REVIEW'),
    ] as never,
    executions: [],
    events: [
      {
        event_type: 'WORKER_EXECUTION_FAILED', actor_role: 'SUPERVISOR', actor_id: 'sup-current',
        target_type: 'task', target_id: 'task-current', payload_json: JSON.stringify({ worker_binding_id: 'worker-current' }), created_at: NOW,
      },
      {
        event_type: 'WORKER_EXECUTION_FAILED', actor_role: 'SUPERVISOR', actor_id: 'sup-retired',
        target_type: 'task', target_id: 'task-retired', payload_json: JSON.stringify({ worker_binding_id: 'worker-retired' }), created_at: NOW,
      },
      {
        event_type: 'WORKER_EXECUTION_FAILED', actor_role: 'SUPERVISOR', actor_id: 'ghost-supervisor',
        target_type: 'task', target_id: 'task-unknown', payload_json: JSON.stringify({ worker_binding_id: 'worker-unknown' }), created_at: NOW,
      },
      {
        event_type: 'WORKER_EXECUTION_FAILED', actor_role: 'SUPERVISOR', actor_id: 'worker-role-mismatch',
        target_type: 'task', target_id: 'task-role-mismatch', payload_json: JSON.stringify({ worker_binding_id: 'worker-role-mismatch' }), created_at: NOW,
      },
    ] as never,
    nowMs: Date.parse(NOW),
    transientWindowMs: 5_000,
  } as never)

  const byBinding = new Map(stage.map(actor => [actor.bindingId, actor]))
  assert.equal(byBinding.get('worker-current')?.state, 'confused', 'ACTIVE Supervisor exact pointer is accepted')
  assert.equal(byBinding.get('worker-retired')?.state, 'idle', 'RETIRED historical pointer is rejected')
  assert.equal(byBinding.get('worker-unknown')?.state, 'idle', 'unknown actor is rejected')
  assert.equal(byBinding.get('worker-role-mismatch')?.state, 'idle', 'non-Supervisor actor binding is rejected')
  for (const bindingId of ['worker-retired', 'worker-unknown', 'worker-role-mismatch']) {
    assert.equal(byBinding.get(bindingId)?.transient, false, `${bindingId} does not receive a failure transient`)
  }
})

test('GUI production path buildSnapshot -> projectStage -> console keeps binding cardinality, canonical refs, and fail-closed evidence', () => {
  const store = new KingdomStore(':memory:')
  store.insertKingdom({ kingdom_id: 'production-cardinality', name: '生产路径王国', created_at: NOW, owner_id: 'owner', owner_name: 'Owner', schema_version: 4 })
  for (const row of [
    binding('owner', 'OWNER', 'Owner'),
    binding('old-chancellor', 'CHANCELLOR', 'Old Chancellor', 'RETIRED'),
    binding('chancellor', 'CHANCELLOR', 'Meridian'),
    binding('sup-a', 'SUPERVISOR', 'Atlas'), binding('sup-b', 'SUPERVISOR', 'Iris'), binding('sup-c', 'SUPERVISOR', 'Relay'),
    binding('worker-a', 'WORKER', 'Worker A'), binding('worker-b', 'WORKER', 'Worker B'),
    binding('worker-c', 'WORKER', 'Worker C'), binding('worker-d', 'WORKER', 'Worker D'), binding('worker-unknown', 'WORKER', 'Unassigned Worker'),
    binding('old-worker', 'WORKER', 'Old Worker', 'RETIRED'),
  ]) store.insertBinding(row as never)
  for (const row of [
    ['territory-a', 'A', 'sup-a'], ['territory-b', 'B', 'sup-b'], ['territory-c', 'C', 'sup-c'],
  ]) store.insertTerritory({ territory_id: row[0]!, kingdom_id: 'production-cardinality', name: row[1]!, workspace_path: null, summary: null, supervisor_binding_id: row[2]!, status: 'ACTIVE', deleted_at: null, deleted_reason: null, created_at: NOW })
  for (const row of [
    task('task-a1', 'territory-a', 'worker-a'), task('task-a2', 'territory-a', 'worker-a'),
    task('task-b1', 'territory-b', 'worker-b'), task('task-b2', 'territory-b', 'worker-b'),
    task('task-b3', 'territory-b', 'worker-b'), task('task-c1', 'territory-c', 'worker-c'),
    task('task-d1', 'territory-c', 'worker-d'), task('task-old', 'territory-c', 'old-worker'),
  ]) store.insertTask(row as never)
  for (const row of [
    execution('execution-a1', 'task-a1', 'worker-a'), execution('execution-a2', 'task-a2', 'worker-a', 'RUNNING', 2),
    execution('execution-b', 'task-b1', 'worker-b'), execution('execution-foreign', 'task-b2', 'sup-b'),
    execution('execution-missing', 'task-b3', 'missing-worker'), execution('execution-failed', 'task-c1', 'worker-c', 'FAILED'),
  ]) store.insertExecution(row as never)
  store.appendEvent({ event_id: 'planned', kingdom_id: 'production-cardinality', event_type: 'TASK_PLANNED', actor_role: 'CHANCELLOR', actor_id: 'chancellor', target_type: 'task', target_id: 'task-a1', payload_json: '{}', created_at: NOW })
  store.appendEvent({ event_id: 'assigned-b', kingdom_id: 'production-cardinality', event_type: 'TASK_ASSIGNED', actor_role: 'SUPERVISOR', actor_id: 'sup-b', target_type: 'task', target_id: 'task-b1', payload_json: JSON.stringify({ worker_binding_id: 'worker-b' }), created_at: NOW })
  store.appendEvent({ event_id: 'foreign-failure', kingdom_id: 'production-cardinality', event_type: 'WORKER_EXECUTION_FAILED', actor_role: 'SUPERVISOR', actor_id: 'sup-a', target_type: 'task', target_id: 'task-c1', payload_json: JSON.stringify({ worker_binding_id: 'worker-c' }), created_at: NOW })
  store.appendEvent({ event_id: 'wrong-actor-failure', kingdom_id: 'production-cardinality', event_type: 'WORKER_EXECUTION_FAILED', actor_role: 'WORKER', actor_id: 'worker-c', target_type: 'task', target_id: 'task-c1', payload_json: JSON.stringify({ worker_binding_id: 'worker-c' }), created_at: NOW })
  const canonicalFailure = store.appendEvent({ event_id: 'canonical-failure', kingdom_id: 'production-cardinality', event_type: 'WORKER_EXECUTION_FAILED', actor_role: 'SUPERVISOR', actor_id: 'sup-c', target_type: 'task', target_id: 'task-c1', payload_json: JSON.stringify({ worker_binding_id: 'worker-c' }), created_at: NOW })

  const snapshot = buildSnapshot(store, { auth, nowMs: Date.parse(NOW), transientWindowMs: 5_000 })
  const stageByBinding = new Map(snapshot.stage.map(actor => [actor.bindingId, actor]))
  assert.equal(snapshot.stage.filter(actor => actor.role === 'CHANCELLOR' && actor.bindingId !== null).length, 1)
  assert.equal(snapshot.stage.filter(actor => actor.role === 'SUPERVISOR' && actor.bindingId !== null).length, 3)
  assert.equal(snapshot.stage.filter(actor => actor.role === 'WORKER' && actor.bindingId !== null).length, 5)
  assert.equal(stageByBinding.get('old-chancellor'), undefined)
  assert.equal(stageByBinding.get('old-worker'), undefined)
  assert.equal(stageByBinding.get('worker-a')?.state, 'confused')
  assert.equal(stageByBinding.get('worker-a')?.indeterminate, true, 'multiple active executions must not choose first')
  assert.equal(stageByBinding.get('worker-b')?.executionId, 'execution-b')
  assert.equal(stageByBinding.get('worker-b')?.state, 'working', 'foreign and missing execution bindings do not make the assigned Worker work')
  assert.equal(stageByBinding.get('worker-c')?.state, 'confused', 'canonical Supervisor-authored failure reaches the exact Worker')
  assert.equal(stageByBinding.get('worker-c')?.sourceSeq, canonicalFailure.seq, 'foreign territory and Worker-authored failure events are rejected')
  assert.equal(stageByBinding.get('worker-unknown')?.indeterminate, true)
  assert.equal(stageByBinding.get('worker-unknown')?.state, 'idle')
  assert.equal(snapshot.tasks.find(item => item.taskId === 'task-b1')?.assignedBindingId, 'worker-b')

  const organization = snapshot.projection.organization.data
  assert.equal(organization.bindingCount, 10, 'organization binding count excludes retired history')
  assert.equal(organization.roles.some(role => role.bindingRef.id === 'old-chancellor'), false, 'retired Chancellor is absent from organization projection')
  assert.equal(organization.roles.some(role => role.bindingRef.id === 'old-worker'), false, 'retired Worker is absent from organization projection')
  assert.equal(organization.roles.find(role => role.bindingRef.id === 'sup-b')?.territoryRef?.id, 'territory-b')
  assert.equal(organization.roles.find(role => role.bindingRef.id === 'worker-b')?.territoryRef?.id, 'territory-b')
  assert.equal(organization.roles.find(role => role.bindingRef.id === 'worker-unknown')?.territoryRef, null)
  const consoleHtml = renderConsoleApp()
  assert.match(consoleHtml, /assignedBindingId/u)
  assert.match(consoleHtml, /territoryRef/u)
  assert.match(consoleHtml, /exactStageFor/u)
  assert.match(consoleHtml, /unassigned-worker-rail/u)
})
