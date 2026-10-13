// Keyless real DSH + product Adapter/Core probe; stores and prerequisites are isolated fixtures.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))
const ids = { kingdom: 'probe-kingdom', worker: 'probe-worker', supervisor: 'probe-supervisor', territory: 'probe-territory', task: 'probe-task' }
const text = 'Isolated dispatch identity probe; no provider or tool may execute.'
const now = () => new Date().toISOString()
const MAX_READ_EVENTS = 4096
export const CASES = ['SENT_AFTER_FLUSH', 'COMMIT_BEFORE_SEND']

async function composition(runtimeRoot, storageRoot, writer) {
  const require = createRequire(join(runtimeRoot, 'package.json'))
  const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
  const { Context } = await load('cordis')
  const names = writer
    ? ['dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-llm', 'dsh-agent', 'dsh-session-persistence-jsonl', 'dsh-agent-loop']
    : ['dsh-session', 'dsh-session-persistence-jsonl']
  const ctx = new Context()
  const versions = {}
  for (const name of names) {
    const mod = await load(name)
    versions[name] = JSON.parse(await readFile(require.resolve(`@deepseek-ai/${name}/package.json`), 'utf8')).version
    await ctx.plugin(mod.default, name === 'dsh-session-persistence-jsonl' ? { root: storageRoot, compression: 'none' }
      : name === 'dsh-agent-loop' ? { agents: [], maxParallelToolCalls: 1 } : {})
  }
  const service = writer ? 'agentLoop' : 'sessionPersistence'
  for (let i = 0; i < 200 && !ctx.get(service); i++) await delay(10)
  if (!ctx.get(service)) throw new Error(`DSH_PUBLIC_SERVICE_UNAVAILABLE:${service}`)
  return { ctx, versions }
}

// Direct fixture seed supplies only TX-3 prerequisites, not governed E2E proof.
function seed(store, governed, session, cwd) {
  store.insertKingdom({ kingdom_id: ids.kingdom, name: 'Identity test', created_at: now(), owner_id: 'probe-owner', owner_name: 'Test fixture' })
  for (const [binding, role] of [[ids.worker, 'WORKER'], [ids.supervisor, 'SUPERVISOR']]) {
    store.insertBinding({ binding_id: binding, kingdom_id: ids.kingdom, role_type: role, role_name: role,
      runtime_type: 'dsh', session_id: null, model_name: null, agent_name: null, session_meta: null,
      execution_profile_json: role === 'WORKER' ? JSON.stringify({ provider: 'probe-keyless', model: 'UNKNOWN' }) : null,
      status: 'ACTIVE', retired_at: null, retired_reason: null, principal_id: null, created_at: now(), updated_at: now() })
  }
  store.insertTerritory({ territory_id: ids.territory, kingdom_id: ids.kingdom, name: 'Identity test', workspace_path: cwd,
    summary: null, supervisor_binding_id: ids.supervisor, status: 'ACTIVE', deleted_at: null, deleted_reason: null, created_at: now() })
  store.insertTask({ task_id: ids.task, territory_id: ids.territory, parent_task_id: null, title: 'Identity test', description: null,
    assigned_binding_id: ids.worker, status: 'ASSIGNED', acceptance_criteria: null, result_summary: null, created_at: now(), updated_at: now() })
  governed.establishAffinity(store, { kingdomId: ids.kingdom, workerBindingId: ids.worker, session, territoryId: ids.territory })
  const lease = governed.acquireExecutionLease(store, { kingdomId: ids.kingdom, workerBindingId: ids.worker,
    territoryId: ids.territory, session, taskId: ids.task, attemptNo: 1 })
  governed.setLeasePlan(store, lease.lease_id, JSON.stringify({ fixture: 'FAKE_ENFORCEMENT_ONLY' }))
  governed.advanceLeaseState(store, lease.lease_id, 'PREPARING')
  governed.advanceLeaseState(store, lease.lease_id, 'MATERIALIZING')
  const decision = governed.recordCapabilityDecision(store, { kingdomId: ids.kingdom, taskId: ids.task, workerBindingId: ids.worker,
    supervisorBindingId: ids.supervisor, decision: 'GRANTED', enforcementStatus: 'ENFORCED',
    enforcementEvidenceJson: JSON.stringify({ type: 'FAKE_ENFORCEMENT_ONLY', payload: { testFixture: true } }) })
  governed.bindCapabilityDecision(store, lease.lease_id, decision.decision_id)
  governed.advanceLeaseState(store, lease.lease_id, 'DISPATCH_READY')
  return { lease, decision }
}

function snapshot(store) {
  const dispatch = store.listDispatches(ids.kingdom)[0]
  const lease = store.listLeases(ids.kingdom)[0]
  const execution = store.listExecutions(ids.task)[0]
  return { dispatchState: dispatch?.state ?? null, leaseState: lease?.state ?? null, executionState: execution?.state ?? null,
    plannedRefPresent: Boolean(dispatch?.runtime_dispatch_ref), receiptPresent: Boolean(dispatch?.receipt_json),
    taskStatus: store.getTask(ids.task)?.status, claimCount: store.listWorkerResults(ids.task).length }
}

async function child(mode, runtimeRoot, caseRoot, libraryRoot) {
  const load = name => import(pathToFileURL(join(libraryRoot, name)).href)
  const { DshRuntimeAdapter } = await load('adapter/dsh-backend.js')
  const { KingdomStore } = await load('core/db.js')
  const { ctx, versions } = await composition(runtimeRoot, join(caseRoot, 'owned-test-sessions'), mode === 'writer')
  const databasePath = join(caseRoot, 'isolated-kernel.db')
  if (mode === 'reader') {
    const store = new KingdomStore(databasePath, { openExistingOnly: true })
    try {
      const dispatch = store.listDispatches(ids.kingdom)[0]
      assert.ok(dispatch?.runtime_dispatch_ref)
      // No Agent services are mounted. Empty live-registry view forces public cold read.
      const adapter = new DshRuntimeAdapter({ runtimeInstanceRef: dispatch.runtime_instance_ref, provider: 'probe-keyless', model: null,
        agents: { get: () => undefined }, sessions: ctx.sessions, sessionPersistence: ctx.sessionPersistence })
      const before = snapshot(store)
      const beforeEvents = store.listEvents(ids.kingdom, 200).length
      const observation = await adapter.reconcile(dispatch.dispatch_id, { sessionRef: dispatch.session_ref, runtimeDispatchRef: dispatch.runtime_dispatch_ref })
      const handle = await ctx.sessionPersistence.open(dispatch.session_ref, 'read')
      let events
      try { events = (await handle.read(0, MAX_READ_EVENTS + 1)).events }
      finally { await handle.close() }
      assert.ok(events.length <= MAX_READ_EVENTS)
      const inboxIds = events.filter(event => event.type === 'agent/inbox/spliced').flatMap(event => event.data.inserted.map(message => message.id))
      assert.deepEqual(snapshot(store), before)
      assert.equal(store.listEvents(ids.kingdom, 200).length, beforeEvents)
      process.send?.({ phase: 'READ', pid: process.pid, observation, core: snapshot(store), coreUnchanged: true,
        persistedExactRefCount: inboxIds.filter(id => id === dispatch.runtime_dispatch_ref).length,
        turnCount: events.filter(event => event.type === 'turn/start').length, eventCount: events.length,
        persistedRefMatches: observation.evidence?.runtimeDispatchRef === dispatch.runtime_dispatch_ref,
        persistedIdMatches: observation.evidence?.kingdomDispatchId === dispatch.dispatch_id, liveAgentCount: 0 })
    } finally { store.close(); await ctx.fiber.dispose() }
    return
  }
  const adapter = new DshRuntimeAdapter({ runtimeInstanceRef: `keyless-product-probe-${randomUUID()}`, provider: 'probe-keyless', model: null,
    agents: ctx.agents, sessions: ctx.sessions, sessionPersistence: ctx.sessionPersistence })
  assert.equal(typeof adapter.prepareDispatch, 'function', 'Current compiled product library must provide prepareDispatch')
  const handle = await adapter.createSession({ cwd: caseRoot })
  const store = new KingdomStore(databasePath)
  const governed = await load('core/governed.js')
  const { lease, decision } = seed(store, governed, handle.refs, caseRoot)
  // Public maintenance reserves the real driver: no Provider/model turn can start.
  await handle.agent.runMaintenance(async signal => {
    const kingdomDispatchId = randomUUID()
    const preparedDispatch = await adapter.prepareDispatch({ kingdomDispatchId, sessionRef: handle.refs.sessionRef, text })
    const prepared = governed.prepareGovernedDispatch(store, { kingdomId: ids.kingdom, taskId: ids.task, attemptNo: 1,
      workerBindingId: ids.worker, leaseId: lease.lease_id, capabilityDecisionId: decision.decision_id, session: handle.refs,
      requestSnapshot: '{}', inputRefJson: '{}', payloadHash: 'fixture-placeholder-not-computed', dispatchId: kingdomDispatchId,
      preparedRuntimeDispatchRef: preparedDispatch.runtimeDispatchRef })
    assert.equal(prepared.intent.runtime_dispatch_ref, preparedDispatch.runtimeDispatchRef)
    assert.equal(prepared.intent.receipt_json, null)
    // Materialize the empty Session for the unsent case. Baseline flush is not a dispatch receipt.
    assert.equal(await ctx.sessions.flush(handle.agent.session), true, 'BASELINE_DURABILITY_LISTENER_REQUIRED')
    assert.equal(handle.agent.inbox.nextTurn.length, 0)
    process.send?.({ phase: 'COMMITTED', pid: process.pid, versions, core: snapshot(store), plannedRefMatchesPrepared: true,
      plannedIdMatchesPrepared: prepared.intent.dispatch_id === kingdomDispatchId, inputCountBeforeSend: 0 })
    await new Promise((resolveMaintenance, reject) => {
      let sent = false
      const send = async command => {
        if (command?.action !== 'SEND' || sent) return
        sent = true
        try {
          const receipt = await adapter.dispatch({ kingdomDispatchId, sessionRef: handle.refs.sessionRef, text, preparedDispatch })
          assert.equal(receipt.refs.runtimeDispatchRef, prepared.intent.runtime_dispatch_ref)
          process.send?.({ phase: 'FLUSHED', receiptMatchesPlanned: true,
            queued: handle.agent.inbox.nextTurn.some(message => message.id === prepared.intent.runtime_dispatch_ref) })
          // Never write the Core receipt. Parent kills this exact writer at the barrier.
        } catch (error) { reject(error) }
      }
      process.on('message', send)
      signal.addEventListener('abort', () => resolveMaintenance(), { once: true })
    })
  })
  store.close()
  await handle.dispose()
  await ctx.fiber.dispose()
}

function spawn(mode, runtimeRoot, caseRoot, libraryRoot) {
  const worker = fork(scriptPath, ['--child', mode, runtimeRoot, caseRoot, libraryRoot], {
    windowsHide: true, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let output = ''
  for (const stream of [worker.stdout, worker.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-1000) })
  const messages = []
  worker.on('message', value => messages.push(value))
  let exited = false
  const exit = new Promise(resolveExit => {
    const finish = (code, signal) => { if (!exited) { exited = true; resolveExit({ code, signal }) } }
    worker.once('exit', finish)
    worker.once('error', error => { messages.push({ phase: 'ERROR', message: error.message }); finish(null, null) })
  })
  const wait = async phase => {
    for (let i = 0; i < 750; i++) {
      const failure = messages.find(message => message.phase === 'ERROR')
      if (failure) throw new Error(failure.message)
      const value = messages.find(message => message.phase === phase)
      if (value) return value
      if (exited) throw new Error(`PROBE_CHILD_EXIT:${output}`)
      await delay(20)
    }
    throw new Error(`PROBE_PHASE_TIMEOUT:${phase}:${output}`)
  }
  return { worker, wait, exit, async stop() { const forced = !exited && worker.kill('SIGKILL'); return { forced, ...await exit } } }
}

export function assertIdentityCase(result) {
  assert.ok(CASES.includes(result.case))
  assert.equal(result.termination.forced, true)
  assert.equal(result.termination.signal, 'SIGKILL')
  assert.notEqual(result.writerPid, result.readerPid)
  assert.equal(result.plannedRefMatchesPrepared, true)
  assert.equal(result.plannedIdRecordedBeforeSend, true)
  assert.equal(result.inputCountBeforeSend, 0)
  assert.equal(result.reader.persistedRefMatches, true)
  assert.equal(result.reader.persistedIdMatches, true)
  assert.equal(result.reader.coreUnchanged, true)
  assert.equal(result.reader.turnCount, 0)
  assert.equal(result.reader.liveAgentCount, 0)
  assert.deepEqual(result.reader.core, { dispatchState: 'INTENDED', leaseState: 'EXECUTING', executionState: 'STARTING',
    plannedRefPresent: true, receiptPresent: false, taskStatus: 'ASSIGNED', claimCount: 0 })
  const sent = result.case === 'SENT_AFTER_FLUSH'
  assert.equal(result.reader.persistedExactRefCount, sent ? 1 : 0)
  assert.equal(result.reader.observation.executionObservation, sent ? 'QUEUED' : 'UNKNOWN')
  assert.equal(result.reader.observation.evidence?.located, sent)
  assert.equal(result.reader.observation.evidence?.source, 'PERSISTED')
  assert.equal(result.reader.observation.evidence?.complete, true)
  if (sent) assert.equal(result.receiptMatchesPlanned, true)
}

export async function runDispatchIdentityProbe({ runtimeRoot, outputRoot, libraryRoot } = {}) {
  if (!runtimeRoot || !outputRoot || !libraryRoot) throw new Error('EXPLICIT_RUNTIME_OUTPUT_AND_CURRENT_LIBRARY_ROOT_REQUIRED')
  const runRoot = join(resolve(outputRoot), `owned-product-id-probe-${randomUUID()}`)
  await mkdir(runRoot, { recursive: true })
  const results = []
  let versions
  for (const caseName of CASES) {
    const caseRoot = join(runRoot, caseName)
    await mkdir(caseRoot)
    const writer = spawn('writer', resolve(runtimeRoot), caseRoot, resolve(libraryRoot))
    let reader
    try {
      const committed = await writer.wait('COMMITTED')
      assert.equal(committed.core.plannedRefPresent, true)
      assert.equal(committed.core.receiptPresent, false)
      let flushed = null
      if (caseName === 'SENT_AFTER_FLUSH') { writer.worker.send({ action: 'SEND' }); flushed = await writer.wait('FLUSHED'); assert.equal(flushed.queued, true) }
      const termination = await writer.stop()
      reader = spawn('reader', resolve(runtimeRoot), caseRoot, resolve(libraryRoot))
      const reopened = await reader.wait('READ')
      let exitTimer
      try {
        const finished = await Promise.race([reader.exit, new Promise((_, reject) => {
          exitTimer = setTimeout(() => reject(new Error('PROBE_READER_DISPOSE_TIMEOUT')), 5000)
        })])
        assert.equal(finished.code, 0)
      } finally { clearTimeout(exitTimer) }
      const { phase, pid, ...readerSummary } = reopened
      // Keep exact Session/message refs only in the ignored ledger, not this shareable report.
      if (readerSummary.observation.evidence) {
        const { kingdomDispatchId, runtimeDispatchRef, ...evidence } = readerSummary.observation.evidence
        readerSummary.observation.evidence = evidence
      }
      const result = { case: caseName, writerPid: committed.pid, readerPid: pid, termination,
        plannedRefMatchesPrepared: committed.plannedRefMatchesPrepared,
        plannedIdRecordedBeforeSend: committed.plannedIdMatchesPrepared && committed.core.plannedRefPresent,
        inputCountBeforeSend: committed.inputCountBeforeSend, receiptMatchesPlanned: flushed?.receiptMatchesPlanned ?? null, reader: readerSummary }
      assertIdentityCase(result)
      results.push(result)
      versions = committed.versions
    } finally { await writer.stop(); if (reader) await reader.stop() }
  }
  const report = { schema: 'DshDispatchIdentityProbe/v2', status: 'PASS', evidenceKind: 'REAL_DSH_PRODUCT_ADAPTER_CORE_TX3_WITH_FAKE_PREREQUISITES',
    versions, productLibrary: 'EXPLICIT_CALLER_PROVIDED_CURRENT_COMPILE', keyless: true, providerPluginsLoaded: 0,
    requestedModel: null, effectiveModel: 'UNKNOWN', fakePrerequisites: ['Authority/binding seed', 'GRANTED+ENFORCED decision', 'Capability/cleanup plan'],
    officialApi: ['agents.create', 'agent.runMaintenance', 'agent.followup', 'sessions.flush', 'sessionPersistence.open/read/close'],
    productPath: ['DshRuntimeAdapter.prepareDispatch', 'Core.prepareGovernedDispatch TX-3', 'DshRuntimeAdapter.dispatch', 'fresh DshRuntimeAdapter.reconcile'],
    cases: results, limitations: ['Only explicitly provided compiled product library and recorded installed component versions were tested.',
      'Flush true means a listener participated and all listeners settled; this composition has the official JSONL listener.',
      'Missing input remains UNKNOWN, never proof of non-dispatch or safe retry.',
      'No Provider turn, terminal outcome, real enforcement, Claim, Task completion, recovery cleanup or safe disposal was tested.',
      'Core receipt intentionally was not persisted after the Runtime accepted input.'] }
  await writeFile(join(runRoot, 'dispatch-id-probe-report.json'), JSON.stringify(report, null, 2) + '\n')
  await writeFile(join(resolve(outputRoot), 'dispatch-id-probe-report.json'), JSON.stringify(report, null, 2) + '\n')
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    if (args[0] === '--child') { await child(...args.slice(1)); process.disconnect?.() }
    else {
      const [runtimeRoot, outputRoot, libraryRoot = process.env.KINGDOM_DISPATCH_ID_PROBE_LIB_ROOT] = args
      console.log(JSON.stringify(await runDispatchIdentityProbe({ runtimeRoot, outputRoot, libraryRoot })))
    }
  } catch (error) {
    const message = String(error.message).slice(0, 300)
    process.send?.({ phase: 'ERROR', message })
    console.error(String(error.stack ?? message).slice(0, 1200))
    process.exitCode = 1
    process.disconnect?.()
  }
}
