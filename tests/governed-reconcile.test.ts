import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KingdomStore } from '../lib/core/db.js'
import { DshRuntimeAdapter } from '../lib/adapter/dsh-backend.js'
import { acquireExecutionLease, createRunnerContextPort, establishAffinity } from '../lib/core/governed.js'
import { runCapabilityGate } from '../lib/capability/service.js'
import { discardGovernedRecoveryContexts, reconcileGovernedDispatch, runGovernedDispatch } from '../lib/dispatch/service.js'
import { submitGovernedClaim } from '../lib/core/governed-claim.js'
import { readDispatchUsage, recordDispatchUsage } from '../lib/core/usage.js'
import { buildActionAvailability, buildTaskGovernance } from '../lib/gui/snapshot.js'

async function fixture(options: { cleanup?: 'false' | 'throw'; onCleanup?: () => void | Promise<void> } = {}) {
  const store = new KingdomStore(':memory:')
  const at = new Date().toISOString()
  store.insertKingdom({ kingdom_id: 'k', name: 'K', owner_id: 'owner', owner_name: 'Owner', created_at: at })
  for (const [id, role, session] of [['worker', 'WORKER', null], ['supervisor', 'SUPERVISOR', 'supervisor-session']] as const) {
    store.insertBinding({ binding_id: id, kingdom_id: 'k', role_type: role, role_name: id, runtime_type: 'dsh', session_id: session,
      model_name: null, agent_name: null, session_meta: null, execution_profile_json: null, status: 'ACTIVE', retired_at: null,
      retired_reason: null, principal_id: null, created_at: at, updated_at: at })
  }
  store.insertTerritory({ territory_id: 'territory', kingdom_id: 'k', name: 'Territory', workspace_path: 'C:/test-territory', summary: null,
    supervisor_binding_id: 'supervisor', status: 'ACTIVE', deleted_at: null, deleted_reason: null, created_at: at })
  store.insertTask({ task_id: 'task', territory_id: 'territory', parent_task_id: null, title: 'Late task', description: null,
    assigned_binding_id: 'worker', status: 'ASSIGNED', acceptance_criteria: null, result_summary: null, created_at: at, updated_at: at })
  const events: { type: string; data?: Record<string, unknown> }[] = []
  let followups = 0
  let cleanupCalls = 0
  const agent = {
    id: 'worker-session', status: 'idle' as const,
    session: { id: 'worker-session', header: { cwd: 'C:/test-territory' }, events },
    ctx: { tools: { schemas: () => [{ name: 'pwsh' }], restrict: () => () => {}, guard: () => () => {} } },
    followup(message: { id: string }) { followups++; events.push({ type: 'user/message', data: { id: message.id } }, { type: 'turn/start', data: { turn: 1 } }) },
    runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> { return job(new AbortController().signal) },
  }
  const adapter = new DshRuntimeAdapter({ runtimeInstanceRef: 'instance', provider: 'spawn', model: null,
    agents: { agents: new Map([[agent.id, agent]]), get: id => id === agent.id ? agent : undefined, list: () => [agent],
      create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') } },
    sandboxPolicy: { setSandboxMode: (_session: unknown, mode: string) => events.push({ type: 'sandbox/mode', data: { mode } }) },
    approval: { setApprovalPolicy: (_session: unknown, policy: string) => events.push({ type: 'approval/policy', data: { policy } }) },
  })
  const refs = { runtimeType: 'dsh', runtimeInstanceRef: 'instance', sessionRef: agent.id }
  establishAffinity(store, { kingdomId: 'k', workerBindingId: 'worker', session: refs, territoryId: 'territory' })
  const lease = acquireExecutionLease(store, { kingdomId: 'k', workerBindingId: 'worker', session: refs, territoryId: 'territory', taskId: 'task', attemptNo: 1 })
  const context = { sessionRef: agent.id, agent }
  const gate = await runCapabilityGate({ store, adapter, kingdomId: 'k', taskId: 'task', attemptNo: 1, workerBindingId: 'worker', supervisorBindingId: 'supervisor', leaseId: lease.lease_id,
    requirementJson: '{"tool:pwsh":true}', ceilingJson: '{"tool:pwsh":true}', grant: { 'tool:pwsh': true }, sandboxMode: 'workspace-write', context })
  assert.equal(gate.materialized, true)
  const run = await runGovernedDispatch({ store, adapter, kingdomId: 'k', taskId: 'task', attemptNo: 1, workerBindingId: 'worker', leaseId: lease.lease_id,
    capabilityDecisionId: gate.decision.decision_id, sessionHandle: { refs, agent, session: agent.session, dispose: async () => {} },
    text: 'late work', requestSnapshot: '{}', inputRefJson: '{}', payloadHash: 'fixture', pollIntervalMs: 0, maxPolls: 0,
    cleanup: async (fence, expectation) => {
      cleanupCalls++
      await options.onCleanup?.()
      if (options.cleanup === 'throw') throw new Error('cleanup fixture throw')
      if (options.cleanup === 'false') return { status: 'RETURNED_FALSE', evidenceJson: null, reason: 'fixture uncertain cleanup' }
      const cleaned = await adapter.cleanup(gate.enforcementRequest!, context, fence, expectation)
      return cleaned.ok && cleaned.evidenceJson
        ? { status: 'CONFIRMED', evidenceJson: cleaned.evidenceJson, reason: 'original cleanup confirmed' }
        : { status: 'MISSING_EVIDENCE', evidenceJson: null, reason: 'missing original cleanup evidence' }
    } })
  return { store, run, events, adapter, complete: () => events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, { type: 'assistant/message', data: { text: 'late verified claim' } }),
    counts: () => ({ followups, cleanupCalls }), close: () => { discardGovernedRecoveryContexts(store); store.close() } }
}

test('late terminal keeps original capability, permits unrelated revision, and concurrently submits only one Claim', async t => {
  const f = await fixture(); t.after(f.close)
  assert.throws(() => createRunnerContextPort(f.store, f.run.dispatch.dispatch_id), /RECOVERING/)
  assert.equal(f.store.getTask('task')!.status, 'ASSIGNED')
  f.store.appendEvent({ event_id: 'unrelated', kingdom_id: 'k', event_type: 'UNRELATED_TEST', actor_role: 'SYSTEM', actor_id: 'test', target_type: null,
    target_id: null, payload_json: '{}', created_at: new Date().toISOString() })
  f.complete()
  const results = await Promise.all([reconcileGovernedDispatch(f.store, f.run.dispatch.dispatch_id, () => true), reconcileGovernedDispatch(f.store, f.run.dispatch.dispatch_id, () => true)])
  assert.ok(results.every(result => result.status === 'TERMINAL'))
  const claims = results.map(result => submitGovernedClaim(f.store, result.dispatchId, result.summary!))
  assert.deepEqual(claims.map(claim => claim.created), [true, false])
  assert.deepEqual(f.counts(), { followups: 1, cleanupCalls: 1 })
  assert.equal(f.store.getTask('task')!.status, 'REVIEW')
  assert.equal(f.store.getLease(f.run.lease.lease_id)!.state, 'RELEASED')
  assert.equal(f.store.listWorkerResults('task').length, 1)
  assert.equal(f.store.listEventsSince('k', 0, 100).filter(event => event.event_type === 'WORKER_RESULT_SUBMITTED').length, 1)
  const duplicate = await reconcileGovernedDispatch(f.store, f.run.dispatch.dispatch_id, () => true)
  assert.equal(duplicate.status, 'TERMINAL')
  assert.deepEqual(f.counts(), { followups: 1, cleanupCalls: 1 })
})

test('running evidence waits without cleanup; process teardown cannot restore an old fence', async t => {
  const f = await fixture(); t.after(f.close)
  const waiting = await reconcileGovernedDispatch(f.store, f.run.dispatch.dispatch_id, () => true)
  assert.equal(waiting.status, 'WAIT')
  assert.equal(f.counts().cleanupCalls, 0)
  discardGovernedRecoveryContexts(f.store)
  f.complete()
  const unavailable = await reconcileGovernedDispatch(f.store, f.run.dispatch.dispatch_id, () => true)
  assert.match(unavailable.reason, /ORIGINAL_PROCESS_CONTEXT_UNAVAILABLE/)
  assert.equal(f.store.getLease(f.run.lease.lease_id)!.state, 'RECOVERING')
  assert.equal(f.store.getExecution(f.run.execution.execution_id)!.state, 'RECOVERING')
})

for (const cleanup of ['false', 'throw'] as const) test(`trusted late terminal preserves Claim but never releases unknown cleanup: ${cleanup}`, async t => {
  const f = await fixture({ cleanup }); t.after(f.close); f.complete()
  const result = await reconcileGovernedDispatch(f.store, f.run.dispatch.dispatch_id, () => true)
  assert.equal(result.status, 'TERMINAL')
  submitGovernedClaim(f.store, result.dispatchId, result.summary!)
  assert.equal(f.store.getTask('task')!.status, 'REVIEW')
  assert.equal(f.store.getLease(f.run.lease.lease_id)!.state, 'RECOVERING')
  await reconcileGovernedDispatch(f.store, result.dispatchId, () => true)
  assert.equal(f.counts().cleanupCalls, 1)
})

test('foreign messages before terminal or during cleanup never mint terminal evidence', async t => {
  for (const duringCleanup of [false, true]) {
    let events: { type: string; data?: Record<string, unknown> }[] = []
    const foreign = () => events.push({ type: 'user/message', data: { id: 'foreign' } })
    const f = await fixture({ onCleanup: duringCleanup ? foreign : undefined }); t.after(f.close); events = f.events
    f.complete(); if (!duringCleanup) foreign()
    const result = await reconcileGovernedDispatch(f.store, f.run.dispatch.dispatch_id, () => true)
    assert.equal(result.status, 'RECOVERING')
    assert.equal(f.store.getDispatch(result.dispatchId)!.terminal_evidence_json, null)
    assert.equal(f.store.getLease(f.run.lease.lease_id)!.state, 'RECOVERING')
    assert.equal(f.store.listWorkerResults('task').length, 0)
  }
})

test('authority loss after cleanup and related task changes both reject recovery before terminal mutation', async t => {
  let authorized = true
  const revoked = await fixture({ onCleanup: () => { authorized = false } }); t.after(revoked.close); revoked.complete()
  const result = await reconcileGovernedDispatch(revoked.store, revoked.run.dispatch.dispatch_id, () => authorized)
  assert.match(result.reason, /AUTHORITY_REVOKED/)
  assert.equal(revoked.store.getDispatch(result.dispatchId)!.state, 'RECOVERING')
  const changed = await fixture(); t.after(changed.close); changed.complete()
  changed.store.transitionTask(changed.store.getTask('task')!, 'RUNNING')
  const stale = await reconcileGovernedDispatch(changed.store, changed.run.dispatch.dispatch_id, () => true)
  assert.match(stale.reason, /STALE_VERSION/)
  assert.equal(changed.counts().cleanupCalls, 0)
})

test('recovered terminal transaction rolls back both rows if execution write fails', async t => {
  const f = await fixture(); t.after(f.close); f.complete()
  f.store.db.exec("CREATE TRIGGER recovery_test_failure BEFORE UPDATE OF state ON executions WHEN NEW.state='COMPLETED' BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END;")
  const result = await reconcileGovernedDispatch(f.store, f.run.dispatch.dispatch_id, () => true)
  assert.equal(result.status, 'RECOVERING')
  assert.equal(f.store.getDispatch(result.dispatchId)!.state, 'RECOVERING')
  assert.equal(f.store.getExecution(f.run.execution.execution_id)!.state, 'RECOVERING')
  assert.equal(f.store.listWorkerResults('task').length, 0)
})

test('failure after Runtime fence release preserves terminal history and does not retry cleanup or release', async t => {
  const f = await fixture(); t.after(f.close); f.complete()
  f.store.db.exec("CREATE TRIGGER recovery_release_failure BEFORE UPDATE OF state ON execution_leases WHEN NEW.state='RELEASED' BEGIN SELECT RAISE(ABORT, 'fixture release failure'); END;")
  const result = await reconcileGovernedDispatch(f.store, f.run.dispatch.dispatch_id, () => true)
  assert.equal(result.status, 'RECOVERING')
  assert.equal(f.store.getDispatch(result.dispatchId)!.state, 'TERMINAL')
  assert.equal(f.store.getExecution(f.run.execution.execution_id)!.state, 'COMPLETED')
  assert.equal(f.store.getLease(f.run.lease.lease_id)!.state, 'RECOVERING')
  const repeated = await reconcileGovernedDispatch(f.store, result.dispatchId, () => true)
  assert.equal(repeated.status, 'TERMINAL')
  submitGovernedClaim(f.store, repeated.dispatchId, 'trusted terminal with settlement incident')
  assert.equal(f.store.getLease(f.run.lease.lease_id)!.state, 'RECOVERING')
  assert.equal(f.counts().cleanupCalls, 1)
})

test('plugin teardown while cleanup is awaiting invalidates recovery without releasing a Lease', async t => {
  let entered!: () => void
  let release!: () => void
  const cleanupEntered = new Promise<void>(resolve => { entered = resolve })
  const pendingCleanup = new Promise<void>(resolve => { release = resolve })
  const f = await fixture({ onCleanup: async () => { entered(); await pendingCleanup } }); t.after(f.close); f.complete()
  const pending = reconcileGovernedDispatch(f.store, f.run.dispatch.dispatch_id, () => true)
  await cleanupEntered
  discardGovernedRecoveryContexts(f.store)
  release()
  const result = await pending
  assert.equal(result.status, 'RECOVERING')
  assert.equal(f.store.getDispatch(result.dispatchId)!.state, 'RECOVERING')
  assert.equal(f.store.getLease(f.run.lease.lease_id)!.released_at, null)
  assert.equal(f.store.listWorkerResults('task').length, 0)
})

test('usage observations have exact dispatch identity, idempotent coverage and a scoped GUI recovery action', async t => {
  const f = await fixture(); t.after(f.close)
  const observation = { type: 'DshDispatchUsage/v1' as const, source: 'provider-reported' as const, runtimeDispatchRef: f.run.dispatch.runtime_dispatch_ref!,
    status: 'COMPLETE' as const, reasonCode: null, turn: 1, fromSeq: 2, throughSeq: 9, observedRequests: 2, reportedRequests: 2,
    usage: { uncachedInputTokens: 20, outputTokens: 10, totalTokens: 35, cacheReadTokens: 5, cacheWriteTokens: 0, reasoningTokens: 4 } }
  recordDispatchUsage(f.store, f.run.dispatch.dispatch_id, observation)
  recordDispatchUsage(f.store, f.run.dispatch.dispatch_id, observation)
  recordDispatchUsage(f.store, f.run.dispatch.dispatch_id, { ...observation, runtimeDispatchRef: 'foreign', usage: { ...observation.usage, totalTokens: 99 } })
  assert.equal(f.store.listDispatchUsageEvents(f.run.dispatch.dispatch_id).length, 1)
  assert.equal(readDispatchUsage(f.store, f.run.dispatch.dispatch_id)!.usage!.totalTokens, 35)
  assert.equal(buildTaskGovernance(f.store, 'task').dispatches[0]!.usage!.status, 'COMPLETE')
  const context = { sessionVerified: true, principalSessionId: 'supervisor-session', scope: ['territory'], hostContext: true, commandCoverage: ['reconcile'] }
  const actions = buildActionAvailability(f.store, f.store.getTask('task')!, f.store.getExecution(f.run.execution.execution_id), context)
  assert.equal(actions.find(action => action.action === 'reconcile')?.executable, true)
  assert.equal(actions.find(action => action.action === 'start')?.executable, false)
  const foreign = buildActionAvailability(f.store, f.store.getTask('task')!, f.store.getExecution(f.run.execution.execution_id), { ...context, principalSessionId: 'other-session' })
  assert.equal(foreign.find(action => action.action === 'reconcile')?.executable, false)
})
