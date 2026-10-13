import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertIdentityCase, runDispatchIdentityProbe } from '../scripts/e2e/dsh-dispatch-id-probe.mjs'

function unsentReport() {
  return { case: 'COMMIT_BEFORE_SEND', termination: { forced: true, signal: 'SIGKILL' }, writerPid: 100, readerPid: 101,
    plannedRefMatchesPrepared: true, plannedIdRecordedBeforeSend: true, inputCountBeforeSend: 0,
    reader: { persistedRefMatches: true, persistedIdMatches: true, coreUnchanged: true, turnCount: 0, liveAgentCount: 0, persistedExactRefCount: 0,
      core: { dispatchState: 'INTENDED', leaseState: 'EXECUTING', executionState: 'STARTING', plannedRefPresent: true,
        receiptPresent: false, taskStatus: 'ASSIGNED', claimCount: 0 },
      observation: { executionObservation: 'UNKNOWN', evidence: { located: false, source: 'PERSISTED', complete: true } } } }
}

test('probe cannot use an implicit or stale root library as current-source evidence', async () => {
  await assert.rejects(runDispatchIdentityProbe({ runtimeRoot: 'placeholder', outputRoot: 'placeholder' }),
    /EXPLICIT_RUNTIME_OUTPUT_AND_CURRENT_LIBRARY_ROOT_REQUIRED/u)
})

test('probe rejects absent-input evidence incorrectly promoted to QUEUED', () => {
  const report = unsentReport()
  report.reader.observation.executionObservation = 'QUEUED'
  assert.throws(() => assertIdentityCase(report))
})

test('probe rejects a resumed model turn or a manufactured governance outcome', () => {
  for (const mutate of [report => { report.reader.turnCount = 1 }, report => { report.reader.core.taskStatus = 'DONE' },
    report => { report.reader.core.receiptPresent = true }, report => { report.reader.core.claimCount = 1 },
    report => { report.reader.core.leaseState = 'RELEASED' }]) {
    const report = unsentReport()
    mutate(report)
    assert.throws(() => assertIdentityCase(report))
  }
})

test('probe rejects graceful shutdown or same-process reopening as crash evidence', () => {
  for (const mutate of [report => { report.termination.forced = false }, report => { report.writerPid = report.readerPid }]) {
    const report = unsentReport()
    mutate(report)
    assert.throws(() => assertIdentityCase(report))
  }
})
