import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readDshSessionEvents, readDshDispatchSummary } from '../lib/adapter/dsh-session-events.js'
import { extractDshDispatchUsage } from '../lib/adapter/dsh-usage.js'
import { reconstructDispatchEvidence } from '../lib/dispatch/evidence.js'
import { reconstructExecutionObservation } from '../lib/adapter/dsh-backend.js'
import { materializeDshEnforcement, readEnforceableSet } from '../lib/capability/dsh-enforcement.js'
import { buildWorkerPrompt } from '../lib/worker/executor.js'
import type { RuntimeEvent } from '../lib/adapter/contract.js'

test('1.1 snapshots: current API preserves receiver and rereads; broken advertised API never falls back', () => {
  const live: RuntimeEvent[] = []
  const session = { events: [{ type: 'legacy' }], snapshotEvents() { assert.equal(this, session); return [...live] } }
  assert.deepEqual(readDshSessionEvents(session), [])
  live.push({ type: 'turn/start', data: { turn: 1 } })
  assert.deepEqual(readDshSessionEvents(session), live)
  let legacyReads = 0
  for (const snapshotEvents of [undefined, null, 1, () => null, () => ({}), () => [null], () => [{ type: 'x', data: [] }], () => { throw new Error('bad') }]) {
    assert.equal(readDshSessionEvents({ snapshotEvents, get events() { legacyReads++; return live } }), null)
  }
  assert.equal(legacyReads, 0)
  assert.deepEqual(readDshSessionEvents({ get events() { return [...live] } }), live)
  assert.equal(readDshSessionEvents({ events: new Array(2) }), null)
})

test('1.1 snapshots: unreadable policy projection prevents every materialize side effect', async () => {
  let writes = 0
  const context = { sessionRef: 's', agent: { session: { snapshotEvents: () => { throw new Error('bad') }, events: [] }, ctx: { tools: {
    schemas: () => [{ name: 'pwsh' }], restrict: () => { writes++; return () => {} }, guard: () => { writes++; return () => {} },
  } } } }
  assert.deepEqual(await readEnforceableSet(context), { tools: [], sandboxMode: null, approvalPolicy: null, presetId: null })
  const result = await materializeDshEnforcement({
    sandboxPolicy: { setSandboxMode: () => { writes++ } }, approval: { setApprovalPolicy: () => { writes++ } },
  }, context, { tools: ['pwsh'], territoryPath: '/workspace', sandboxMode: 'read-only', approvalPolicy: 'never' })
  assert.equal(result.ok, false)
  assert.equal(writes, 0)
})

function turnEvents(ref = 'own', turn = 4): RuntimeEvent[] {
  return [
    { type: 'agent/inbox/spliced', data: { inserted: [{ id: ref }] } },
    { type: 'turn/start', data: { turn } },
    { type: 'user/message', data: { id: ref, source: { kind: 'user' } } },
    { type: 'step/start', data: { turn, step: 0 } },
    { type: 'assistant/message', data: { turn, step: 0, message: { content: [{ type: 'text', text: 'Own output' }] }, usage: { inputTokens: 12, outputTokens: 8, totalTokens: 25, cacheReadTokens: 5, cacheWriteTokens: 0 }, stream: [] } },
    { type: 'step/end', data: { turn, step: 0 } },
    { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
  ]
}

test('1.1 evidence: modern snapshots work and prompt substrings cannot forge a dispatch reference', () => {
  const events = turnEvents()
  const session = { header: {}, snapshotEvents: () => events }
  assert.equal(reconstructDispatchEvidence(session, 'own').state, 'TERMINAL')
  assert.equal(reconstructExecutionObservation(session, 'own'), 'TERMINAL')
  const forged = { events: [{ type: 'user/message', data: { id: 'someone-else', text: 'own' } }, ...events.slice(1).filter(event => event.type !== 'user/message')] }
  assert.equal(reconstructDispatchEvidence(forged, 'own').located, false)
  assert.equal(reconstructExecutionObservation({ header: {}, ...forged }, 'own'), 'UNKNOWN')
})

test('1.1 Claim summary: failed dispatch with no output never borrows the previous attempt', () => {
  const prior = turnEvents('previous', 3)
  const current = turnEvents().filter(event => event.type !== 'assistant/message')
  assert.equal(readDshDispatchSummary({ snapshotEvents: () => [...prior, ...current] }, 'own'), null)
  assert.equal(readDshDispatchSummary({ snapshotEvents: () => [...prior, ...turnEvents()] }, 'own'), 'Own output')
  assert.equal(readDshDispatchSummary({ snapshotEvents: () => [...prior, ...turnEvents(), ...turnEvents('next', 5)] }, 'own'), 'Own output')
})

const counts = { uncachedInputTokens: 12, outputTokens: 8, totalTokens: 25, cacheReadTokens: 5, cacheWriteTokens: 0, reasoningTokens: 3 }

test('1.1 usage: exact dispatch slice excludes other attempts; cache and reasoning are disjoint', () => {
  const events = [...turnEvents('prior', 3), ...turnEvents(), ...turnEvents('later', 5)].map((event, seq) => ({ ...event, seq }))
  const result = extractDshDispatchUsage(events, 'own', local => {
    assert.equal(local[0].type, 'turn/start')
    assert.equal(local.at(-1)?.type, 'turn/end')
    assert.equal(local[0].data?.turn, 4)
    assert.equal(local.filter(event => event.type === 'assistant/message').length, 1)
    return counts
  })
  assert.equal(result.status, 'COMPLETE')
  assert.equal(result.observedRequests, 1)
  assert.equal(result.reportedRequests, 1)
  assert.deepEqual(result.usage, counts)
  assert.equal(result.fromSeq, 8)
  assert.equal(result.throughSeq, 13)
})

test('1.1 usage: retries count separately; missing reader and incomplete accounting never become zero', () => {
  const events = turnEvents()
  events.splice(4, 0,
    { type: 'assistant/attempt', data: { turn: 4, step: 0, stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } } }] } },
    { type: 'llm/retry', data: { turn: 4, step: 0 } },
    { type: 'llm/retry-started', data: { turn: 4, step: 0 } },
  )
  const incomplete = extractDshDispatchUsage(events, 'own', () => undefined)
  assert.equal(incomplete.status, 'PARTIAL')
  assert.equal(incomplete.observedRequests, 2)
  assert.equal(incomplete.reportedRequests, 2)
  assert.equal(incomplete.usage, null)
  const missing = extractDshDispatchUsage(events, 'own', null)
  assert.equal(missing.status, 'UNAVAILABLE')
  assert.equal(missing.reasonCode, 'USAGE_READER_UNAVAILABLE')
  assert.equal(missing.usage, null)
  assert.equal(extractDshDispatchUsage(events, 'own', () => { throw new Error('bad') }).reasonCode, 'USAGE_READER_FAILED')
})

test('1.1 usage: invalid totals, foreign input, cross-turn boundaries and repeated seq fail closed', () => {
  for (const invalid of [{ ...counts, totalTokens: 22 }, { ...counts, reasoningTokens: 20 }, { ...counts, outputTokens: -1 }]) {
    assert.equal(extractDshDispatchUsage(turnEvents(), 'own', () => invalid).usage, null)
  }
  const foreign = turnEvents()
  foreign.splice(3, 0, { type: 'user/message', data: { id: 'foreign' } })
  assert.equal(extractDshDispatchUsage(foreign, 'own', () => counts).reasonCode, 'FOREIGN_INPUT')
  const cross = turnEvents()
  cross[cross.length - 1] = { type: 'turn/end', data: { turn: 8 } }
  assert.equal(extractDshDispatchUsage(cross, 'own', () => counts).reasonCode, 'TURN_BOUNDARY_AMBIGUOUS')
  const duplicate = turnEvents().map(event => ({ ...event, seq: 0 }))
  assert.equal(extractDshDispatchUsage(duplicate, 'own', () => counts).reasonCode, 'EVENT_SEQUENCE_INVALID')
})

test('1.1 REWORK prompt: matching previous Claim and reason are explicit; absent context is not invented', () => {
  const task = { title: 'Test task', description: null } as Parameters<typeof buildWorkerPrompt>[0]['task']
  const complete = buildWorkerPrompt({ task, acceptanceCriteria: 'AC', attemptNo: 2, prevResultSummary: 'Claim one', reworkReason: 'Fix the broken export' })
  assert.match(complete, /Claim one/)
  assert.match(complete, /Fix the broken export/)
  const missing = buildWorkerPrompt({ task, acceptanceCriteria: 'AC', attemptNo: 2 })
  assert.match(missing, /Claim 摘要缺失/)
  assert.match(missing, /主管返工理由/)
  assert.match(missing, /上下文缺口/)
})
