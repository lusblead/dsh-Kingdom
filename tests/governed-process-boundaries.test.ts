import { after, test } from 'node:test'
import { writeFile } from 'node:fs/promises'
import {
  CRASH_POINTS, runCrashScenario, assertCrashBoundary, runLeaseContention, assertLeaseContention,
} from '../scripts/e2e/governed-process-probe.mjs'

const crashes = []
let contention = null
after(async () => {
  if (process.env.KINGDOM_PROCESS_PROBE_REPORT && crashes.length === CRASH_POINTS.length && contention) {
    await writeFile(process.env.KINGDOM_PROCESS_PROBE_REPORT, JSON.stringify({ schema: 'GovernedProcessBoundaryReport/v1',
      evidenceKind: 'LOCAL_NODE_SQLITE_WITH_FAKE_RUNTIME', realDshProvider: 'NOT_RUN', effectiveModel: 'UNKNOWN', crashes, contention }, null, 2))
  }
})

for (const point of CRASH_POINTS) {
  test(`real child crash/reopen preserves dispatch boundary: ${point}`, { timeout: 60000 }, async t => {
    const result = await runCrashScenario(point)
    assertCrashBoundary(result)
    crashes.push(result)
    t.diagnostic(JSON.stringify({ evidenceKind: 'LOCAL_NODE_SQLITE_WITH_FAKE_RUNTIME', ...result }))
  })
}

test('two real processes contend for one Session lease without duplicate dispatch', { timeout: 60000 }, async t => {
  const result = await runLeaseContention()
  assertLeaseContention(result)
  contention = result
  t.diagnostic(JSON.stringify({ evidenceKind: 'LOCAL_NODE_SQLITE_WITH_FAKE_RUNTIME', ...result }))
})
