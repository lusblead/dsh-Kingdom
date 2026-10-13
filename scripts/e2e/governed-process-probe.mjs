/** Real local Node/SQLite process boundaries with an explicitly fake external Runtime. */
import { fork } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const helper = fileURLToPath(new URL('../../tests/helpers/governed-process-child.mjs', import.meta.url))
const defaultLibraryRoot = fileURLToPath(new URL('../../lib/', import.meta.url))
export const CRASH_POINTS = ['BEFORE_COMMIT', 'AFTER_COMMIT_BEFORE_DISPATCH', 'FAKE_ACCEPTED_BEFORE_RECEIPT']
const timeoutMs = 15000

function startChild(mode, databasePath, libraryRoot, options = {}) {
  const child = fork(helper, [mode, databasePath, libraryRoot, JSON.stringify(options)], { silent: true })
  const messages = []
  const waiters = []
  let stderr = ''
  let exited = false
  child.stderr?.on('data', data => { stderr = (stderr + data.toString()).slice(-2048) })
  child.on('message', message => {
    if (message?.type === 'ERROR') {
      for (const waiter of waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(new Error(message.message)) }
      return
    }
    const index = waiters.findIndex(waiter => waiter.type === message?.type)
    if (index < 0) messages.push(message)
    else { const waiter = waiters.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(message) }
  })
  const exit = new Promise(resolveExit => {
    const finished = (code, signal, error = null) => {
      if (exited) return
      exited = true
      for (const waiter of waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(new Error(`Child exited before ${waiter.type}: ${code}/${signal}; ${error || stderr}`)) }
      resolveExit({ code, signal })
    }
    child.once('exit', (code, signal) => finished(code, signal))
    child.once('error', error => finished(null, null, error.message))
  })
  function next(type) {
    const index = messages.findIndex(message => message?.type === type)
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0])
    if (exited) return Promise.reject(new Error(`Child already exited before ${type}; ${stderr}`))
    return new Promise((resolveMessage, reject) => {
      const waiter = { type, resolve: resolveMessage, reject, timer: null }
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
        reject(new Error(`Child timed out before ${type}; ${stderr}`))
      }, timeoutMs)
      waiters.push(waiter)
    })
  }
  return { child, next, exit, async stop() {
    const killIssued = !exited && child.kill('SIGKILL') // only this fork's ChildProcess; never search or kill by process name
    return { ...await exit, killIssued }
  } }
}

async function isolated(operation, libraryRoot) {
  const scratch = await mkdtemp(join(tmpdir(), 'kingdom-owned-process-probe-'))
  const owned = []
  const launch = (mode, options = {}) => {
    const peer = startChild(mode, join(scratch, 'test.db'), resolve(libraryRoot), options)
    owned.push(peer)
    return peer
  }
  try { return await operation({ scratch, launch }) }
  finally {
    await Promise.all(owned.map(peer => peer.stop()))
    await rm(scratch, { recursive: true, force: true }) // mkdtemp-created directory owned by this invocation
  }
}

async function finish(peer) {
  const result = await peer.next('RESULT')
  const exit = await peer.exit
  assert.equal(exit.code, 0, 'probe child must finish successfully')
  const { type, ...data } = result
  return data
}

export async function runCrashScenario(point, { libraryRoot = process.env.KINGDOM_PROCESS_PROBE_LIB_ROOT || defaultLibraryRoot } = {}) {
  assert.ok(CRASH_POINTS.includes(point), 'only the three named crash barriers are permitted')
  return isolated(async ({ scratch, launch }) => {
    await finish(launch('seed', { prepared: true }))
    const acceptancePath = join(scratch, 'fake-acceptance.json')
    const peer = launch('crash', { point, acceptancePath })
    const barrier = await peer.next('CRASH_BARRIER')
    assert.equal(barrier.point, point)
    const termination = await peer.stop()
    const reopen = await finish(launch('inspect-crash')) // a genuinely new process and SQLite connection
    let fakeRuntimeAcceptedCalls = 0
    try { fakeRuntimeAcceptedCalls = JSON.parse(await readFile(acceptancePath, 'utf8')).calls }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    return { point, termination: { forced: termination.killIssued, exitCode: termination.code, signal: termination.signal },
      barrierSnapshot: barrier.uncommitted ?? barrier.committed, fakeRuntimeAcceptedCalls, ...reopen }
  }, libraryRoot)
}

export function assertCrashBoundary(result) {
  assert.equal(result.termination.forced, true, 'the owned process must still be alive when the parent issues its kill')
  assert.equal(result.termination.signal, 'SIGKILL', 'verify forced process termination rather than a graceful close')
  const preCommit = result.point === 'BEFORE_COMMIT'
  assert.deepEqual([result.beforeRecovery.executionCount, result.beforeRecovery.dispatchCount, result.beforeRecovery.leaseCount],
    preCommit ? [0, 0, 1] : [1, 1, 1], 'TX-3 must roll back before commit or survive as all three rows after commit')
  assert.equal(result.beforeRecovery.leaseState, preCommit ? 'DISPATCH_READY' : 'EXECUTING')
  assert.equal(result.beforeRecovery.executionState, preCommit ? null : 'STARTING')
  assert.equal(result.beforeRecovery.dispatchState, preCommit ? null : 'INTENDED')
  assert.equal(result.beforeRecovery.receiptPresent, false)
  assert.equal(result.beforeRecovery.runtimeRefPresent, false)
  if (!preCommit) {
    assert.equal(result.reconcile.status, 'RECOVERING')
    assert.match(result.reconcile.reason, /RECEIPT_UNAVAILABLE/u)
    assert.deepEqual([result.afterRecovery.executionState, result.afterRecovery.dispatchState, result.afterRecovery.leaseState],
      ['RECOVERING', 'RECOVERING', 'RECOVERING'])
  }
  assert.equal(result.fakeRuntimeAcceptedCalls, result.point === 'FAKE_ACCEPTED_BEFORE_RECEIPT' ? 1 : 0)
  assert.equal(result.duplicateLease, 'SESSION_LEASE_UNIQUE')
  assert.equal(result.retryBlocked, true)
  assert.equal(result.runtimeActions, 0, 'reopened Worker guard must reject retry before any Runtime side effect')
  assert.equal(result.afterRecovery.taskStatus, 'ASSIGNED', 'Runtime/recovery cannot complete the Task')
}

export async function runLeaseContention({ libraryRoot = process.env.KINGDOM_PROCESS_PROBE_LIB_ROOT || defaultLibraryRoot, testLockHoldMs = 150 } = {}) {
  assert.ok(Number.isInteger(testLockHoldMs) && testLockHoldMs >= 0 && testLockHoldMs <= 1000)
  return isolated(async ({ scratch, launch }) => {
    await finish(launch('seed'))
    const releasePath = join(scratch, 'release-lock')
    const peers = [1, 2].map(participant => launch('contend', { participant, releasePath }))
    assert.ok(peers[0].child.pid && peers[1].child.pid && peers[0].child.pid !== peers[1].child.pid,
      'contention requires two distinct actual child processes')
    await Promise.all(peers.map(peer => peer.next('READY')))
    peers.forEach(peer => peer.child.send({ type: 'GO' }))
    await Promise.all(peers.map(peer => peer.next('ATTEMPTING')))
    await Promise.race(peers.map(peer => peer.next('LOCK_HELD')))
    // Both actual processes have begun acquire. Hold the writer briefly to make lock contention observable.
    await new Promise(resolveDelay => setTimeout(resolveDelay, testLockHoldMs))
    await writeFile(releasePath, 'test-barrier-release', { flag: 'wx' })
    const results = await Promise.all(peers.map(finish))
    const reopened = await finish(launch('inspect-contention'))
    return { participants: results, readyBarrier: true, bothAttemptedBeforeLockRelease: true,
      testLockHoldMs, productionLatencyClaim: 'NOT_MEASURED', ...reopened }
  }, libraryRoot)
}

export function assertLeaseContention(result) {
  assert.equal(result.participants.filter(participant => participant.status === 'ACQUIRED').length, 1)
  const rejected = result.participants.filter(participant => participant.status === 'REJECTED')
  assert.equal(rejected.length, 1)
  assert.ok(['SESSION_LEASE_UNIQUE', 'SQLITE_BUSY'].includes(rejected[0].failureCategory))
  assert.equal(result.snapshot.leaseCount, 1)
  assert.equal(result.snapshot.leaseState, 'ACQUIRED')
  assert.equal(result.snapshot.dispatchCount, 0)
  assert.equal(result.snapshot.executionCount + result.secondTaskExecutions, 0)
  assert.ok(result.participants.every(participant => participant.runtimeDispatchCalls === 0))
  assert.ok(result.participants.every(participant => Number.isFinite(participant.elapsedMs) && participant.elapsedMs >= 0))
}

export async function runGovernedProcessProbe(options = {}) {
  const crashes = []
  for (const point of CRASH_POINTS) { const result = await runCrashScenario(point, options); assertCrashBoundary(result); crashes.push(result) }
  const contention = await runLeaseContention(options)
  assertLeaseContention(contention)
  return { schema: 'GovernedProcessBoundaryReport/v1', evidenceKind: 'LOCAL_NODE_SQLITE_WITH_FAKE_RUNTIME',
    realDshProvider: 'NOT_RUN', effectiveModel: 'UNKNOWN', crashes, contention }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runGovernedProcessProbe(), null, 2)) }
  catch (error) { console.error(String(error.message)); process.exitCode = 1 }
}
