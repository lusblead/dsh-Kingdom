import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KingdomStore } from '../lib/core/db.js'
import { DshRuntimeAdapter } from '../lib/adapter/dsh-backend.js'
import type { DispatchReceipt, RuntimeAdapter } from '../lib/adapter/contract.js'
import { acquireExecutionLease, establishAffinity, prepareGovernedDispatch, recordDispatchReceipt } from '../lib/core/governed.js'
import { runCapabilityGate } from '../lib/capability/service.js'
import { readDispatchUsage, recordDispatchUsage } from '../lib/core/usage.js'
import type { DshDispatchUsageObservation } from '../lib/adapter/dsh-usage.js'
import { discardGovernedRecoveryContexts, reconcileGovernedDispatch, runGovernedDispatch } from '../lib/dispatch/service.js'

async function fixture() {
  const store = new KingdomStore(':memory:')
  const at = new Date().toISOString()
  store.insertKingdom({ kingdom_id: 'k', name: 'K', owner_id: 'owner', owner_name: 'Owner', created_at: at })
  for (const [id, role] of [['worker', 'WORKER'], ['supervisor', 'SUPERVISOR']] as const) {
    store.insertBinding({ binding_id: id, kingdom_id: 'k', role_type: role, role_name: id, runtime_type: 'dsh', session_id: null,
      model_name: null, agent_name: null, session_meta: null, execution_profile_json: null, status: 'ACTIVE', retired_at: null,
      retired_reason: null, principal_id: null, created_at: at, updated_at: at })
  }
  store.insertTerritory({ territory_id: 'territory', kingdom_id: 'k', name: 'Territory', workspace_path: 'C:/fixture', summary: null,
    supervisor_binding_id: 'supervisor', status: 'ACTIVE', deleted_at: null, deleted_reason: null, created_at: at })
  store.insertTask({ task_id: 'task', territory_id: 'territory', parent_task_id: null, title: 'Correlation fixture', description: null,
    assigned_binding_id: 'worker', status: 'ASSIGNED', acceptance_criteria: null, result_summary: null, created_at: at, updated_at: at })
  const events: { type: string; data?: Record<string, unknown> }[] = []
  let sends = 0
  let onSend = (_message: { id: string }) => {}
  const agent = {
    id: 'session', status: 'idle' as const, session: { id: 'session', header: { cwd: 'C:/fixture' }, events },
    ctx: { tools: { schemas: () => [{ name: 'pwsh' }], restrict: () => () => {}, guard: () => () => {} } },
    followup(message: { id: string }) { sends++; onSend(message); events.push({ type: 'user/message', data: { id: message.id } }) },
    runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> { return job(new AbortController().signal) },
  }
  const adapter = new DshRuntimeAdapter({ runtimeInstanceRef: 'instance', provider: 'spawn', model: null,
    // Fake durability only; the real public persistence path has its own keyless probe.
    sessions: { flush: async () => true },
    agents: { agents: new Map([[agent.id, agent]]), get: id => id === agent.id ? agent : undefined, list: () => [agent],
      create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') } },
    sandboxPolicy: { setSandboxMode: (_session: unknown, mode: string) => events.push({ type: 'sandbox/mode', data: { mode } }) },
    approval: { setApprovalPolicy: (_session: unknown, policy: string) => events.push({ type: 'approval/policy', data: { policy } }) },
  })
  const refs = { runtimeType: 'dsh', runtimeInstanceRef: 'instance', sessionRef: agent.id }
  establishAffinity(store, { kingdomId: 'k', workerBindingId: 'worker', session: refs, territoryId: 'territory' })
  const lease = acquireExecutionLease(store, { kingdomId: 'k', workerBindingId: 'worker', session: refs, territoryId: 'territory', taskId: 'task', attemptNo: 1 })
  const gate = await runCapabilityGate({ store, adapter, kingdomId: 'k', taskId: 'task', attemptNo: 1, workerBindingId: 'worker', supervisorBindingId: 'supervisor', leaseId: lease.lease_id,
    requirementJson: '{"tool:pwsh":true}', ceilingJson: '{"tool:pwsh":true}', grant: { 'tool:pwsh': true }, sandboxMode: 'workspace-write', context: { sessionRef: agent.id, agent } })
  assert.equal(gate.materialized, true)
  const input = { store, adapter, kingdomId: 'k', taskId: 'task', attemptNo: 1, workerBindingId: 'worker', leaseId: lease.lease_id,
    capabilityDecisionId: gate.decision.decision_id, sessionHandle: { refs, agent, session: agent.session, dispose: async () => {} },
    text: 'fixture input', requestSnapshot: '{}', inputRefJson: '{}', payloadHash: 'fixture', maxPolls: 0, pollIntervalMs: 0 }
  const prepare = (runtimeDispatchRef?: string) => prepareGovernedDispatch(store, { ...input, session: refs, dispatchId: 'planned-dispatch', preparedRuntimeDispatchRef: runtimeDispatchRef })
  const snapshot = () => JSON.stringify({ task: store.getTask('task'), executions: store.listExecutions('task'), dispatches: store.listDispatches('k'), lease: store.getLease(lease.lease_id),
    decision: store.getCapabilityDecision(gate.decision.decision_id), events: store.listEventsSince('k', 0, 1000), claims: store.listWorkerResults('task'), revision: store.revision('k') })
  return { store, adapter, input, prepare, snapshot, sends: () => sends, onSend: (callback: typeof onSend) => { onSend = callback },
    close: () => { discardGovernedRecoveryContexts(store); store.close() } }
}

test('prepared correlation saves the exact Runtime reference before first send without claiming Receipt', async t => {
  const f = await fixture(); t.after(f.close)
  let observed = false
  f.onSend(message => {
    const intents = f.store.listDispatches('k')
    assert.equal(intents.length, 1)
    const intent = intents[0]!
    assert.equal(intent.state, 'INTENDED')
    assert.equal(intent.runtime_dispatch_ref, message.id)
    assert.equal(intent.receipt_json, null)
    assert.equal(intent.dispatched_at, null)
    assert.equal(intent.receipt_at, null)
    assert.notEqual(intent.dispatch_id, message.id)
    observed = true
  })
  const run = await runGovernedDispatch(f.input)
  assert.equal(observed, true)
  assert.equal(f.sends(), 1)
  assert.equal(run.intent.runtime_dispatch_ref, run.receipt.refs.runtimeDispatchRef)
})

test('preparation, post-await revocation and TX-3 failure each produce zero dispatch and zero intent', async t => {
  for (const failure of ['prepare', 'authority', 'commit'] as const) {
    const f = await fixture(); t.after(f.close)
    let authorized = true
    if (failure === 'prepare') f.adapter.prepareDispatch = async () => { throw new Error('fixture preparation failure') }
    if (failure === 'authority') {
      const original = f.adapter.prepareDispatch.bind(f.adapter)
      f.adapter.prepareDispatch = async input => { const prepared = await original(input); authorized = false; return prepared }
    }
    if (failure === 'commit') f.store.db.exec("CREATE TRIGGER fixture_commit_failure BEFORE INSERT ON dispatch_records BEGIN SELECT RAISE(ABORT, 'fixture commit failure'); END;")
    await assert.rejects(runGovernedDispatch({ ...f.input, stillAuthorized: () => authorized }), /failure|AUTHORITY_CHANGED/)
    assert.equal(f.sends(), 0)
    assert.equal(f.store.listDispatches('k').length, 0)
    assert.equal(f.store.listExecutions('task').length, 0)
    assert.equal(f.store.getCapabilityDecision(f.input.capabilityDecisionId)!.execution_id, null)
    assert.equal(f.store.getLease(f.input.leaseId)!.state, 'DISPATCH_READY')
  }
})

test('TX-3 rechecks authority inside BEGIN after pure preparation', async t => {
  const f = await fixture(); t.after(f.close)
  let authorized = true
  const original = f.store.withImmediateTransaction.bind(f.store)
  f.store.withImmediateTransaction = (job => {
    authorized = false
    return original(job)
  }) as typeof f.store.withImmediateTransaction
  await assert.rejects(runGovernedDispatch({ ...f.input, stillAuthorized: () => authorized }), /AUTHORITY_CHANGED/)
  assert.equal(f.sends(), 0)
  assert.equal(f.store.listDispatches('k').length, 0)
})

test('Receipt mismatch cannot replace planned reference and mismatched idempotent replay is rejected', async t => {
  const f = await fixture(); t.after(f.close)
  const prepared = f.prepare('planned-runtime')
  const before = f.snapshot()
  assert.throws(() => recordDispatchReceipt(f.store, prepared.intent.dispatch_id, { runtimeDispatchRef: 'foreign', receiptJson: '{}' }), /引用不一致/)
  assert.equal(f.snapshot(), before)
  recordDispatchReceipt(f.store, prepared.intent.dispatch_id, { runtimeDispatchRef: 'planned-runtime', receiptJson: '{}' })
  const received = f.snapshot()
  assert.throws(() => recordDispatchReceipt(f.store, prepared.intent.dispatch_id, { runtimeDispatchRef: 'foreign', receiptJson: '{}' }), /引用不一致/)
  assert.equal(f.snapshot(), received)
  assert.equal(recordDispatchReceipt(f.store, prepared.intent.dispatch_id, { runtimeDispatchRef: 'planned-runtime', receiptJson: '{}' }).state, 'RECEIVED')
})

test('Receipt transaction uses a fresh read and cannot reopen a recovering dispatch', async t => {
  const f = await fixture(); t.after(f.close)
  const prepared = f.prepare('planned-runtime')
  const original = f.store.withImmediateTransaction.bind(f.store)
  let replaced = false
  f.store.withImmediateTransaction = (job => {
    if (!replaced) { replaced = true; f.store.db.prepare("UPDATE dispatch_records SET state='RECOVERING' WHERE dispatch_id=?").run(prepared.intent.dispatch_id) }
    return original(job)
  }) as typeof f.store.withImmediateTransaction
  assert.throws(() => recordDispatchReceipt(f.store, prepared.intent.dispatch_id, { runtimeDispatchRef: 'planned-runtime', receiptJson: '{}' }), /RECOVERING/)
  const row = f.store.getDispatch(prepared.intent.dispatch_id)!
  assert.equal(row.state, 'RECOVERING')
  assert.equal(row.runtime_dispatch_ref, 'planned-runtime')
  assert.equal(row.receipt_json, null)
})

function usageObservation(status: DshDispatchUsageObservation['status']): DshDispatchUsageObservation {
  return { type: 'DshDispatchUsage/v1', source: 'provider-reported', runtimeDispatchRef: 'planned-runtime', status,
    reasonCode: status === 'COMPLETE' ? null : 'USAGE_READER_UNAVAILABLE', observedRequests: 1,
    reportedRequests: status === 'COMPLETE' ? 1 : 0, turn: 1, fromSeq: 2, throughSeq: 5,
    usage: status === 'COMPLETE' ? { uncachedInputTokens: 20, outputTokens: 10, totalTokens: 30 } : null }
}

test('planned Runtime reference without Receipt cannot record any usage status', async t => {
  const f = await fixture(); t.after(f.close)
  const prepared = f.prepare('planned-runtime')
  assert.equal(prepared.intent.state, 'INTENDED')
  assert.equal(prepared.intent.receipt_json, null)
  const before = f.snapshot()
  for (const status of ['UNAVAILABLE', 'PARTIAL', 'COMPLETE'] as const) recordDispatchUsage(f.store, prepared.intent.dispatch_id, usageObservation(status))
  assert.equal(f.store.listDispatchUsageEvents(prepared.intent.dispatch_id).length, 0)
  assert.equal(readDispatchUsage(f.store, prepared.intent.dispatch_id), null)
  assert.equal(f.snapshot(), before)
})

test('receipted exact Runtime reference records usage normally with idempotence and foreign-ref rejection', async t => {
  const f = await fixture(); t.after(f.close)
  const prepared = f.prepare('planned-runtime')
  recordDispatchReceipt(f.store, prepared.intent.dispatch_id, { runtimeDispatchRef: 'planned-runtime', receiptJson: '{}' })
  recordDispatchUsage(f.store, prepared.intent.dispatch_id, usageObservation('UNAVAILABLE'))
  assert.equal(readDispatchUsage(f.store, prepared.intent.dispatch_id)!.status, 'UNAVAILABLE')
  recordDispatchUsage(f.store, prepared.intent.dispatch_id, usageObservation('COMPLETE'))
  const after = f.snapshot()
  recordDispatchUsage(f.store, prepared.intent.dispatch_id, usageObservation('COMPLETE'))
  recordDispatchUsage(f.store, prepared.intent.dispatch_id, { ...usageObservation('COMPLETE'), runtimeDispatchRef: 'foreign' })
  assert.equal(f.snapshot(), after)
  assert.equal(f.store.listDispatchUsageEvents(prepared.intent.dispatch_id).length, 2)
  assert.equal(readDispatchUsage(f.store, prepared.intent.dispatch_id)!.usage!.totalTokens, 30)
})

test('usage admission rereads Receipt inside BEGIN before recording a provider observation', async t => {
  const f = await fixture(); t.after(f.close)
  const prepared = f.prepare('planned-runtime')
  recordDispatchReceipt(f.store, prepared.intent.dispatch_id, { runtimeDispatchRef: 'planned-runtime', receiptJson: '{}' })
  const original = f.store.withImmediateTransaction.bind(f.store)
  f.store.withImmediateTransaction = (job => {
    f.store.db.prepare('UPDATE dispatch_records SET receipt_json=NULL WHERE dispatch_id=?').run(prepared.intent.dispatch_id)
    return original(job)
  }) as typeof f.store.withImmediateTransaction
  recordDispatchUsage(f.store, prepared.intent.dispatch_id, usageObservation('COMPLETE'))
  assert.equal(f.store.listDispatchUsageEvents(prepared.intent.dispatch_id).length, 0)
  assert.equal(readDispatchUsage(f.store, prepared.intent.dispatch_id), null)
})

test('service rejects foreign Receipt runtime, session and prepared reference before receipt persistence', async t => {
  for (const mismatch of ['runtimeType', 'runtimeInstanceRef', 'sessionRef', 'runtimeDispatchRef'] as const) {
    const f = await fixture(); t.after(f.close)
    f.adapter.dispatch = async input => ({ refs: { ...f.input.sessionHandle.refs, runtimeDispatchRef: input.preparedDispatch!.runtimeDispatchRef, [mismatch]: 'foreign' }, acceptedAt: new Date().toISOString() } satisfies DispatchReceipt)
    await assert.rejects(runGovernedDispatch(f.input), /Receipt Runtime\/Session\/reference 不匹配/)
    const row = f.store.listDispatches('k')[0]!
    assert.equal(row.state, 'RECOVERING')
    assert.ok(row.runtime_dispatch_ref)
    assert.equal(row.receipt_json, null)
    assert.equal(row.receipt_at, null)
    assert.equal(f.sends(), 0)
  }
})

function observationAdapter(f: Awaited<ReturnType<typeof fixture>>, reconcile: RuntimeAdapter['reconcile']) {
  const adapter = new DshRuntimeAdapter({ runtimeInstanceRef: 'instance', provider: 'spawn', model: null, agents: {} })
  const forbidden = () => { throw new Error('cold observation must not mutate Runtime or reconstruct ownership') }
  adapter.reconcile = reconcile
  adapter.dispatch = async () => forbidden()
  adapter.createSession = async () => forbidden()
  adapter.resumeSession = async () => forbidden()
  adapter.openTrustFence = async () => forbidden()
  adapter.cleanup = async () => forbidden()
  return adapter
}

test('cold exact observation remains RECOVERING and preserves every governance row, event and Claim', async t => {
  for (const state of ['QUEUED', 'RUNNING', 'TERMINAL', 'UNKNOWN'] as const) {
    const f = await fixture(); t.after(f.close)
    const prepared = f.prepare('planned-runtime')
    const before = f.snapshot()
    let calls = 0
    const adapter = observationAdapter(f, async (dispatchId, refs) => {
      calls++; assert.equal(dispatchId, prepared.intent.dispatch_id)
      assert.deepEqual(refs, { ...f.input.sessionHandle.refs, runtimeDispatchRef: 'planned-runtime' })
      return { executionObservation: state, sessionObservation: 'AVAILABLE', terminalOutcome: 'COMPLETED',
        evidence: { source: 'PERSISTED', located: state !== 'UNKNOWN', complete: true, eventsRead: 2, reason: 'EXACT_INPUT_FOUND', rawText: 'must not escape' } }
    })
    const observed = await reconcileGovernedDispatch(f.store, prepared.intent.dispatch_id, () => true, adapter)
    assert.equal(calls, 1)
    assert.equal(observed.readOnly, true)
    assert.equal(observed.status, 'RECOVERING')
    assert.equal(observed.runtimeObservation!.state, state)
    assert.equal('rawText' in observed.runtimeObservation!.evidence, false)
    assert.equal('terminalOutcome' in observed, false)
    assert.equal(f.snapshot(), before)
    assert.equal(f.sends(), 0)
  }
})

test('cold observation rejects adapter identity mismatch, lost authority and absent legacy reference', async t => {
  for (const failure of ['identity', 'authority-before', 'authority-after', 'legacy', 'read-failure'] as const) {
    const f = await fixture(); t.after(f.close)
    const prepared = f.prepare(failure === 'legacy' ? undefined : 'planned-runtime')
    const before = f.snapshot()
    let authorized = failure !== 'authority-before'
    let calls = 0
    const adapter = observationAdapter(f, async () => {
      calls++
      if (failure === 'read-failure') throw new Error('secret runtime details must not escape')
      if (failure === 'authority-after') authorized = false
      return { executionObservation: 'QUEUED', sessionObservation: 'AVAILABLE', evidence: { source: 'PERSISTED', located: true } }
    })
    if (failure === 'identity') adapter.identify = () => ({ runtimeType: 'dsh', runtimeInstanceRef: 'foreign' })
    const observed = await reconcileGovernedDispatch(f.store, prepared.intent.dispatch_id, () => authorized, adapter)
    assert.equal(observed.status, 'RECOVERING')
    assert.equal(observed.readOnly, true)
    assert.equal(observed.runtimeObservation, undefined)
    assert.equal(calls, failure === 'authority-after' || failure === 'read-failure' ? 1 : 0)
    assert.equal(f.snapshot(), before)
    assert.doesNotMatch(observed.reason, /secret runtime details/)
  }
})

test('cold observation discards positive evidence when Task scope or Execution relation changes during await', async t => {
  for (const change of ['territory', 'worker', 'execution-session'] as const) {
    const f = await fixture(); t.after(f.close)
    const prepared = f.prepare('planned-runtime')
    const at = new Date().toISOString()
    f.store.insertTerritory({ ...f.store.getTerritoryById('territory')!, territory_id: 'territory-2', name: 'Territory 2', created_at: at })
    f.store.insertBinding({ ...f.store.getBindingById('worker')!, binding_id: 'worker-2', created_at: at, updated_at: at })
    let entered!: () => void
    let release!: () => void
    const reading = new Promise<void>(resolve => { entered = resolve })
    const pendingRead = new Promise<void>(resolve => { release = resolve })
    const adapter = observationAdapter(f, async () => {
      entered(); await pendingRead
      return { executionObservation: 'TERMINAL', sessionObservation: 'AVAILABLE',
        evidence: { source: 'PERSISTED', located: true, complete: true, eventsRead: 2, reason: 'EXACT_INPUT_FOUND' } }
    })
    const pending = reconcileGovernedDispatch(f.store, prepared.intent.dispatch_id, () => true, adapter)
    await reading
    if (change === 'territory') f.store.db.prepare("UPDATE tasks SET territory_id='territory-2' WHERE task_id='task'").run()
    if (change === 'worker') f.store.db.prepare("UPDATE tasks SET assigned_binding_id='worker-2' WHERE task_id='task'").run()
    if (change === 'execution-session') f.store.db.prepare("UPDATE executions SET session_id='changed-session' WHERE execution_id=?").run(prepared.execution.execution_id)
    const afterExternalChange = f.snapshot()
    release()
    const observed = await pending
    assert.equal(observed.status, 'RECOVERING')
    assert.equal(observed.readOnly, true)
    assert.match(observed.reason, /OBSERVATION_RELATION_CHANGED/)
    assert.equal(observed.runtimeObservation, undefined)
    assert.equal(f.snapshot(), afterExternalChange, 'observation must add no writes after external relation change')
    assert.equal(f.sends(), 0)
  }
})

test('cold observation accepts a stable already-reassigned Task under its current authorized scope', async t => {
  const f = await fixture(); t.after(f.close)
  const prepared = f.prepare('planned-runtime')
  f.store.insertBinding({ ...f.store.getBindingById('worker')!, binding_id: 'worker-2' })
  f.store.db.prepare("UPDATE tasks SET assigned_binding_id='worker-2' WHERE task_id='task'").run()
  const before = f.snapshot()
  const adapter = observationAdapter(f, async () => ({ executionObservation: 'QUEUED', sessionObservation: 'AVAILABLE',
    evidence: { source: 'PERSISTED', located: true, complete: true, eventsRead: 1, reason: 'EXACT_INPUT_FOUND' } }))
  const observed = await reconcileGovernedDispatch(f.store, prepared.intent.dispatch_id, () => true, adapter)
  assert.equal(observed.status, 'RECOVERING')
  assert.equal(observed.runtimeObservation!.state, 'QUEUED')
  assert.equal(observed.readOnly, true)
  assert.equal(f.snapshot(), before)
})

test('adapters without pure preparation retain explicit legacy dispatch compatibility', async t => {
  const f = await fixture(); t.after(f.close)
  ;(f.adapter as RuntimeAdapter).prepareDispatch = undefined
  const originalDispatch = f.adapter.dispatch.bind(f.adapter)
  f.adapter.dispatch = input => {
    assert.equal(input.preparedDispatch, undefined)
    assert.equal(f.store.listDispatches('k')[0]!.runtime_dispatch_ref, null)
    return originalDispatch({ sessionRef: input.sessionRef, text: input.text })
  }
  const run = await runGovernedDispatch(f.input)
  assert.equal(f.sends(), 1)
  assert.ok(run.receipt.refs.runtimeDispatchRef)
  assert.equal(run.intent.runtime_dispatch_ref, null)
})
