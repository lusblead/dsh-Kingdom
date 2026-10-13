/** Owned, isolated child for process-boundary tests. No real Runtime/provider is used. */
import { existsSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const [mode, databasePath, libraryRoot, optionsJson = '{}'] = process.argv.slice(2)
const options = JSON.parse(optionsJson)
const load = name => import(pathToFileURL(join(libraryRoot, name)).href)
const { KingdomStore } = await load('core/db.js')
const governed = await load('core/governed.js')
const identity = { runtimeType: 'dsh', runtimeInstanceRef: 'fake-process-probe', sessionRef: 'probe-session' }
const ids = { kingdom: 'probe-kingdom', worker: 'probe-worker', supervisor: 'probe-supervisor', territory: 'probe-territory' }
const now = () => new Date().toISOString()
const send = (type, data = {}) => process.send?.({ type, ...data })
const park = () => { for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000) }

function seedStore(store, withPreparedLease) {
  store.insertKingdom({ kingdom_id: ids.kingdom, name: 'Process test', created_at: now(), owner_id: 'probe-owner', owner_name: 'Test fixture' })
  for (const [binding, role] of [[ids.worker, 'WORKER'], [ids.supervisor, 'SUPERVISOR']]) {
    store.insertBinding({ binding_id: binding, kingdom_id: ids.kingdom, role_type: role, role_name: role,
      runtime_type: 'dsh', session_id: null, model_name: null, agent_name: null, session_meta: null,
      execution_profile_json: role === 'WORKER' ? JSON.stringify({ provider: 'spawn', model: 'fake-process-probe' }) : null,
      status: 'ACTIVE', retired_at: null, retired_reason: null, principal_id: null, created_at: now(), updated_at: now() })
  }
  store.insertTerritory({ territory_id: ids.territory, kingdom_id: ids.kingdom, name: 'Process test',
    workspace_path: null, summary: null, supervisor_binding_id: ids.supervisor, status: 'ACTIVE', deleted_at: null,
    deleted_reason: null, created_at: now() })
  for (const taskId of ['probe-task-1', 'probe-task-2']) {
    store.insertTask({ task_id: taskId, territory_id: ids.territory, parent_task_id: null, title: taskId,
      description: null, assigned_binding_id: ids.worker, status: 'ASSIGNED', acceptance_criteria: null,
      result_summary: null, created_at: now(), updated_at: now() })
  }
  governed.establishAffinity(store, { kingdomId: ids.kingdom, workerBindingId: ids.worker, session: identity, territoryId: ids.territory })
  if (!withPreparedLease) return
  const lease = governed.acquireExecutionLease(store, leaseInput('probe-task-1'))
  governed.setLeasePlan(store, lease.lease_id, JSON.stringify({ fixture: 'FAKE_ENFORCEMENT_ONLY' }))
  governed.advanceLeaseState(store, lease.lease_id, 'PREPARING')
  governed.advanceLeaseState(store, lease.lease_id, 'MATERIALIZING')
  // This is an explicit test prerequisite, not evidence of real DSH enforcement.
  const decision = governed.recordCapabilityDecision(store, { kingdomId: ids.kingdom, taskId: 'probe-task-1',
    workerBindingId: ids.worker, supervisorBindingId: ids.supervisor, decision: 'GRANTED', enforcementStatus: 'ENFORCED',
    enforcementEvidenceJson: JSON.stringify({ type: 'FAKE_ENFORCEMENT_ONLY', payload: { testFixture: true } }) })
  governed.bindCapabilityDecision(store, lease.lease_id, decision.decision_id)
  governed.advanceLeaseState(store, lease.lease_id, 'DISPATCH_READY')
}

function leaseInput(taskId) {
  return { kingdomId: ids.kingdom, workerBindingId: ids.worker, territoryId: ids.territory, session: identity, taskId, attemptNo: 1 }
}

function prepareInput(store) {
  const lease = store.listLeases(ids.kingdom)[0]
  return { ...leaseInput('probe-task-1'), leaseId: lease.lease_id, capabilityDecisionId: lease.capability_decision_id,
    requestSnapshot: '{}', inputRefJson: '{}', payloadHash: 'fixture-placeholder-not-computed',
    executionId: 'probe-execution', dispatchId: 'probe-dispatch' }
}

function snapshot(store) {
  const executions = store.listExecutions('probe-task-1')
  const dispatches = store.listDispatches(ids.kingdom)
  const leases = store.listLeases(ids.kingdom)
  return { executionCount: executions.length, dispatchCount: dispatches.length, leaseCount: leases.length,
    executionState: executions[0]?.state ?? null, dispatchState: dispatches[0]?.state ?? null,
    leaseState: leases[0]?.state ?? null, receiptPresent: Boolean(dispatches[0]?.receipt_json),
    runtimeRefPresent: Boolean(dispatches[0]?.runtime_dispatch_ref), taskStatus: store.getTask('probe-task-1')?.status }
}

function classify(error) {
  if (/UNIQUE constraint failed: execution_leases\.(runtime_type|session_ref)/u.test(error.message)) return 'SESSION_LEASE_UNIQUE'
  if (/UNIQUE constraint failed: execution_leases\.task_id/u.test(error.message)) return 'TASK_ATTEMPT_LEASE_UNIQUE'
  if (/database is locked|SQLITE_BUSY/u.test(error.message)) return 'SQLITE_BUSY'
  return 'UNEXPECTED'
}

function waitForRelease(path) {
  const deadline = performance.now() + 10000
  while (!existsSync(path)) {
    if (performance.now() > deadline) throw new Error('TEST_BARRIER_TIMEOUT')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  }
}

async function main() {
  const store = new KingdomStore(databasePath, mode === 'seed' ? {} : { openExistingOnly: true })
  try {
    if (mode === 'seed') {
      seedStore(store, options.prepared === true)
      send('RESULT', { snapshot: snapshot(store) })
    } else if (mode === 'crash') {
      if (options.point === 'BEFORE_COMMIT') {
        const transaction = store.withImmediateTransaction.bind(store)
        store.withImmediateTransaction = fn => transaction(() => {
          const result = fn()
          send('CRASH_BARRIER', { point: options.point, uncommitted: snapshot(store) })
          park() // killed while the real BEGIN IMMEDIATE transaction still owns its uncommitted writes
          return result
        })
      }
      const prepared = governed.prepareGovernedDispatch(store, prepareInput(store))
      if (options.point === 'AFTER_COMMIT_BEFORE_DISPATCH') {
        send('CRASH_BARRIER', { point: options.point, committed: snapshot(store) })
        park()
      }
      // Deliberately fake external side effect. Flush a separate marker before receipt persistence.
      const marker = openSync(options.acceptancePath, 'wx')
      try { writeSync(marker, JSON.stringify({ evidenceKind: 'FAKE_RUNTIME_ACCEPTANCE', calls: 1 })); fsyncSync(marker) }
      finally { closeSync(marker) }
      send('CRASH_BARRIER', { point: 'FAKE_ACCEPTED_BEFORE_RECEIPT', committed: snapshot(store) })
      park()
      governed.recordDispatchReceipt(store, prepared.intent.dispatch_id, { runtimeDispatchRef: 'fake-ref', receiptJson: '{}' })
    } else if (mode === 'inspect-crash') {
      const beforeRecovery = snapshot(store)
      const { reconcileGovernedDispatch } = await load('dispatch/service.js')
      const { decideRecovery, applyRecovery } = await load('dispatch/reconcile.js')
      const dispatch = store.listDispatches(ids.kingdom)[0]
      let reconcile = null
      if (dispatch) {
        reconcile = await reconcileGovernedDispatch(store, dispatch.dispatch_id, () => true)
        const decision = decideRecovery({ store, dispatch, sessionObservation: 'UNKNOWN',
          evidence: { state: 'UNKNOWN', located: false, foreignUserMessages: [], terminalReason: null } })
        applyRecovery(store, dispatch, decision)
      }
      let duplicateLease
      try { governed.acquireExecutionLease(store, { ...leaseInput('probe-task-2'), attemptNo: 2 }); duplicateLease = 'UNEXPECTED_ACCEPTED' }
      catch (error) { duplicateLease = classify(error) }
      const { runGovernedTask } = await load('worker/governed-executor.js')
      let runtimeActions = 0
      const fakeAdapter = new Proxy({ runtimeType: 'dsh', identify: () => identity }, {
        get(target, key) {
          if (key in target) return target[key]
          return () => { runtimeActions++; throw new Error('UNEXPECTED_RUNTIME_SIDE_EFFECT') }
        },
      })
      const retry = await runGovernedTask({ store, adapter: fakeAdapter, kingdomId: ids.kingdom,
        workerBindingId: ids.worker, territoryId: ids.territory, cwd: 'unused-test-workspace', taskId: 'probe-task-1', attemptNo: 2,
        supervisorBindingId: ids.supervisor, grant: {}, requirementJson: '{}', sandboxMode: 'read-only' })
      send('RESULT', { beforeRecovery, afterRecovery: snapshot(store), reconcile: reconcile && { status: reconcile.status, reason: reconcile.reason },
        duplicateLease, retryBlocked: retry.ok === false && /active Lease/u.test(retry.reason), runtimeActions })
    } else if (mode === 'contend') {
      send('READY', { participant: options.participant })
      await new Promise(resolve => process.once('message', message => {
        if (message?.type !== 'GO') throw new Error('INVALID_TEST_BARRIER')
        resolve()
      }))
      const started = performance.now()
      let lockAcquiredMs = null
      const transaction = store.withImmediateTransaction.bind(store)
      store.withImmediateTransaction = fn => transaction(() => {
        lockAcquiredMs = performance.now() - started
        send('LOCK_HELD', { participant: options.participant })
        waitForRelease(options.releasePath)
        return fn()
      })
      send('ATTEMPTING', { participant: options.participant })
      let status
      let failureCategory = null
      try { governed.acquireExecutionLease(store, leaseInput(`probe-task-${options.participant}`)); status = 'ACQUIRED' }
      catch (error) { status = 'REJECTED'; failureCategory = classify(error) }
      send('RESULT', { participant: options.participant, status, failureCategory,
        lockAcquiredMs, elapsedMs: performance.now() - started, runtimeDispatchCalls: 0 })
    } else if (mode === 'inspect-contention') {
      send('RESULT', { snapshot: snapshot(store), secondTaskExecutions: store.listExecutions('probe-task-2').length })
    } else throw new Error('UNKNOWN_TEST_MODE')
  } finally { store.close() }
}

try { await main(); process.disconnect?.() }
catch (error) { send('ERROR', { category: 'PROCESS_PROBE_FAILED', message: String(error.message).slice(0, 256) }); process.exitCode = 1; process.disconnect?.() }
