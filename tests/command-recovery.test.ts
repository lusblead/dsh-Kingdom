import assert from 'node:assert/strict'
import { test } from 'node:test'
import { KingdomStore } from '../lib/core/db.js'
import {
  acquireExecutionLease,
  advanceLeaseState,
  bindCapabilityDecision,
  createGovernedExecution,
  establishAffinity,
  recordCapabilityDecision,
  setLeasePlan,
} from '../lib/core/governed.js'
import {
  abortExecution,
  pauseExecution,
  reclaimOrphanExecutions,
  resumeExecution,
  type CommandContext,
} from '../lib/core/task-service.js'

const KID = 'command-recovery-kingdom'
const SUPERVISOR = 'command-recovery-supervisor'
const SUPERVISOR_SESSION = 'command-recovery-supervisor-session'
const WORKER = 'command-recovery-worker'
const TERRITORY = 'command-recovery-territory'
const RUNTIME_SESSION = {
  runtimeType: 'dsh',
  runtimeInstanceRef: 'command-recovery-runtime',
  sessionRef: 'command-recovery-worker-session',
}
const now = (): string => new Date().toISOString()

function makeStore(): KingdomStore {
  const store = new KingdomStore(':memory:')
  const at = now()
  store.insertKingdom({
    kingdom_id: KID, name: 'Command Recovery', created_at: at,
    owner_id: 'owner', owner_name: 'Owner',
  })
  store.insertBinding({
    binding_id: SUPERVISOR, kingdom_id: KID, role_type: 'SUPERVISOR', role_name: 'Supervisor',
    runtime_type: 'dsh', session_id: SUPERVISOR_SESSION, model_name: null, agent_name: null,
    session_meta: null, execution_profile_json: null, status: 'ACTIVE', retired_at: null,
    retired_reason: null, principal_id: null, created_at: at, updated_at: at,
  })
  store.insertBinding({
    binding_id: WORKER, kingdom_id: KID, role_type: 'WORKER', role_name: 'Worker',
    runtime_type: 'dsh', session_id: null, model_name: null, agent_name: null,
    session_meta: null, execution_profile_json: null, status: 'ACTIVE', retired_at: null,
    retired_reason: null, principal_id: null, created_at: at, updated_at: at,
  })
  store.insertTerritory({
    territory_id: TERRITORY, kingdom_id: KID, name: 'Recovery Territory', workspace_path: null,
    summary: null, supervisor_binding_id: SUPERVISOR, status: 'ACTIVE', deleted_at: null,
    deleted_reason: null, created_at: at,
  })
  return store
}

function insertTask(store: KingdomStore, taskId: string): void {
  const at = now()
  store.insertTask({
    task_id: taskId, territory_id: TERRITORY, parent_task_id: null, title: taskId,
    description: null, assigned_binding_id: WORKER, status: 'RUNNING', acceptance_criteria: null,
    result_summary: null, created_at: at, updated_at: at,
  })
}

function insertLegacyExecution(
  store: KingdomStore,
  taskId: string,
  executionId: string,
  state = 'RUNNING',
  pauseRequestedAt: string | null = null,
): void {
  const at = now()
  store.insertExecution({
    execution_id: executionId, task_id: taskId, attempt_no: 1, worker_binding_id: WORKER,
    session_id: null, state, detail: null, started_at: at, heartbeat_at: at,
    ended_at: state === 'ABORTED' ? at : null, pause_requested_at: pauseRequestedAt,
    executor_kind: 'command-recovery-fixture', provider: null, provider_source: null,
    requested_model: null, resolved_model: null, model_source: null,
    execution_profile_json: null, execution_contract: 'LEGACY_COMPAT', lease_id: null,
    capability_decision_id: null,
  })
}

function insertGovernedExecution(
  store: KingdomStore,
  taskId: string,
  executionId: string,
): { executionId: string; leaseId: string } {
  establishAffinity(store, {
    kingdomId: KID, workerBindingId: WORKER, session: RUNTIME_SESSION, territoryId: TERRITORY,
  })
  const lease = acquireExecutionLease(store, {
    kingdomId: KID, workerBindingId: WORKER, session: RUNTIME_SESSION,
    territoryId: TERRITORY, taskId, attemptNo: 1,
  })
  setLeasePlan(store, lease.lease_id, '{"type":"CommandRecoveryPlan/v1"}')
  advanceLeaseState(store, lease.lease_id, 'PREPARING')
  advanceLeaseState(store, lease.lease_id, 'MATERIALIZING')
  const decision = recordCapabilityDecision(store, {
    kingdomId: KID, taskId, workerBindingId: WORKER, supervisorBindingId: SUPERVISOR,
    decision: 'GRANTED', enforcementStatus: 'ENFORCED', requirementCoverage: 'FULL',
    enforcementEvidenceJson: '{"type":"CommandRecoveryEvidence/v1"}',
  })
  bindCapabilityDecision(store, lease.lease_id, decision.decision_id)
  advanceLeaseState(store, lease.lease_id, 'DISPATCH_READY')
  const execution = createGovernedExecution(store, {
    taskId, attemptNo: 1, workerBindingId: WORKER, leaseId: lease.lease_id,
    capabilityDecisionId: decision.decision_id, executionId,
  })
  return { executionId: execution.execution_id, leaseId: lease.lease_id }
}

const commandContext = (): CommandContext => ({
  kingdomId: KID,
  principal: { sessionId: SUPERVISOR_SESSION },
  auth: { mode: 'session-bound', trustLevel: 'session-verified', note: '' },
})

test('startup reclaim preserves legacy abort while persistent execution becomes recovery-required', (t) => {
  const store = makeStore()
  t.after(() => store.close())
  const legacyTaskId = 'legacy-orphan-task'
  const governedTaskId = 'governed-orphan-task'
  insertTask(store, legacyTaskId)
  insertTask(store, governedTaskId)
  insertLegacyExecution(store, legacyTaskId, 'legacy-orphan-execution')
  const governed = insertGovernedExecution(store, governedTaskId, 'governed-orphan-execution')
  const running = store.transitionExecution(store.getExecution(governed.executionId)!, 'RUNNING', {})

  const legacyTaskBefore = { ...store.getTask(legacyTaskId)! }
  const governedTaskBefore = { ...store.getTask(governedTaskId)! }
  const leaseBefore = { ...store.getLease(governed.leaseId)! }
  const eventCountBefore = store.listEventsSince(KID, 0, 1000).length

  assert.equal(reclaimOrphanExecutions(store, KID), 2)
  assert.equal(store.getExecution('legacy-orphan-execution')!.state, 'ABORTED')
  const recovered = store.getExecution(governed.executionId)!
  assert.equal(running.state, 'RUNNING')
  assert.equal(recovered.state, 'RECOVERING')
  assert.equal(recovered.ended_at, null)
  assert.deepEqual({ ...store.getTask(legacyTaskId)! }, legacyTaskBefore)
  assert.deepEqual({ ...store.getTask(governedTaskId)! }, governedTaskBefore)
  assert.deepEqual({ ...store.getLease(governed.leaseId)! }, leaseBefore)
  assert.equal(store.listExecutions(governedTaskId).length, 1, 'startup recovery must not retry')

  const events = store.listEventsSince(KID, 0, 1000)
  const legacyEvents = events.filter(event => event.target_id === 'legacy-orphan-execution')
  const governedEvents = events.filter(event => event.target_id === governed.executionId)
  assert.equal(legacyEvents.filter(event => event.event_type === 'SESSION_STOPPED').length, 1)
  assert.equal(governedEvents.filter(event => event.event_type === 'SESSION_STOPPED').length, 0)
  const recoveryEvents = governedEvents.filter(event => event.event_type === 'EXECUTION_RECOVERING')
  assert.equal(recoveryEvents.length, 1)
  const recoveryPayload = JSON.parse(recoveryEvents[0]!.payload_json) as Record<string, unknown>
  assert.equal(recoveryPayload.reason, 'recovery-required-on-load')
  assert.equal(recoveryPayload.previous_state, 'RUNNING')
  assert.equal(Object.prototype.hasOwnProperty.call(recoveryPayload, 'session_stopped'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(recoveryPayload, 'lease_released'), false)

  const eventCountAfter = events.length
  assert.equal(eventCountAfter, eventCountBefore + 2)
  assert.equal(reclaimOrphanExecutions(store, KID), 0)
  assert.equal(store.listEventsSince(KID, 0, 1000).length, eventCountAfter)
})

test('persistent runtime controls fail closed and terminal pause residue cannot resume', (t) => {
  const store = makeStore()
  t.after(() => store.close())
  const governedTaskId = 'governed-control-task'
  const terminalTaskId = 'terminal-resume-task'
  insertTask(store, governedTaskId)
  insertTask(store, terminalTaskId)
  const governed = insertGovernedExecution(store, governedTaskId, 'governed-control-execution')
  const taskBefore = { ...store.getTask(governedTaskId)! }
  const executionBefore = { ...store.getExecution(governed.executionId)! }
  const eventsBefore = store.listEventsSince(KID, 0, 1000).length

  for (const invoke of [pauseExecution, resumeExecution, abortExecution]) {
    const result = invoke(store, commandContext(), {
      executionId: governed.executionId,
      reason: 'runtime control evidence is unavailable',
    })
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'EXECUTOR_UNAVAILABLE')
    assert.deepEqual({ ...store.getExecution(governed.executionId)! }, executionBefore)
    assert.deepEqual({ ...store.getTask(governedTaskId)! }, taskBefore)
  }
  assert.equal(store.listEventsSince(KID, 0, 1000).length, eventsBefore)

  const pauseResidue = '2026-08-23T00:00:00.000Z'
  insertLegacyExecution(store, terminalTaskId, 'terminal-resume-execution', 'ABORTED', pauseResidue)
  const terminalBefore = { ...store.getExecution('terminal-resume-execution')! }
  const resume = resumeExecution(store, commandContext(), {
    executionId: 'terminal-resume-execution',
    reason: 'must remain terminal',
  })
  assert.equal(resume.ok, false)
  assert.equal(resume.errorCode, 'ILLEGAL_EXECUTION_STATE')
  assert.deepEqual({ ...store.getExecution('terminal-resume-execution')! }, terminalBefore)
})
