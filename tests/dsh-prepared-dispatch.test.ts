import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DshRuntimeAdapter } from '../lib/adapter/dsh-backend.js'
import type { DshBackendDeps, RuntimeEvent } from '../lib/adapter/contract.js'

const sessionRef = 'owned-session'
const kingdomDispatchId = 'kingdom-dispatch'
const text = 'bounded task input'
const input = { kingdomDispatchId, sessionRef, text }

function fixture(options: { flush?: 'missing' | (() => Promise<boolean>); timeout?: number; followupThrows?: boolean } = {}) {
  const events: RuntimeEvent[] = []
  const messages: { id: string; content: { type: string; text: string }[]; source: { kind: string } }[] = []
  const session = { header: {}, events }
  const agent = {
    id: sessionRef,
    status: 'idle',
    session,
    followup(message: typeof messages[number]) {
      messages.push(message)
      if (options.followupThrows) throw new Error('private runtime detail')
      events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } })
    },
  }
  const registry = new Map([[sessionRef, agent]])
  const flushed: unknown[] = []
  const deps: DshBackendDeps = {
    runtimeInstanceRef: 'runtime-instance', provider: 'keyless-test', model: null,
    agents: { get: (id: string) => registry.get(id) },
    dispatchFlushTimeoutMs: options.timeout,
    sessions: options.flush === 'missing' ? undefined : { async flush(current: unknown) {
      flushed.push(current)
      return options.flush ? options.flush() : true
    } },
  }
  return { adapter: new DshRuntimeAdapter(deps), deps, agent, registry, events, messages, session, flushed }
}

test('prepared DSH dispatch: pure independent ref, frozen exact message, true durability barrier, one use', async () => {
  const f = fixture()
  const prepared = await f.adapter.prepareDispatch(input)
  assert.notEqual(prepared.runtimeDispatchRef, kingdomDispatchId)
  assert.ok(Object.isFrozen(prepared))
  assert.equal(f.events.length, 0)
  assert.equal(f.messages.length, 0)
  assert.equal(f.flushed.length, 0)
  const receipt = await f.adapter.dispatch({ ...input, preparedDispatch: prepared })
  assert.equal(receipt.refs.runtimeDispatchRef, prepared.runtimeDispatchRef)
  assert.equal(f.messages[0].id, prepared.runtimeDispatchRef)
  assert.equal(f.messages[0].content[0].text, text)
  assert.ok(Object.isFrozen(f.messages[0]))
  assert.ok(Object.isFrozen(f.messages[0].content))
  assert.ok(Object.isFrozen(f.messages[0].content[0]))
  assert.ok(Object.isFrozen(f.messages[0].source))
  assert.deepEqual(f.flushed, [f.session])
  await assert.rejects(f.adapter.dispatch({ ...input, preparedDispatch: prepared }), /ALREADY_USED/)
  assert.equal(f.messages.length, 1)
})

test('prepared DSH dispatch rejects forged, foreign-instance and identity-mismatched tokens before followup', async () => {
  const f = fixture()
  const prepared = await f.adapter.prepareDispatch(input)
  const other = fixture()
  for (const token of [{ ...prepared }, await other.adapter.prepareDispatch(input)]) {
    await assert.rejects(f.adapter.dispatch({ ...input, preparedDispatch: token }), /UNKNOWN_PREPARED_TOKEN/)
  }
  for (const changed of [{ text: 'changed' }, { kingdomDispatchId: 'different' }]) {
    await assert.rejects(f.adapter.dispatch({ ...input, ...changed, preparedDispatch: prepared }), /IDENTITY_MISMATCH/)
  }
  f.registry.set('another-session', { ...f.agent, id: 'another-session' })
  await assert.rejects(f.adapter.dispatch({ ...input, sessionRef: 'another-session', preparedDispatch: prepared }), /IDENTITY_MISMATCH/)
  assert.equal(f.messages.length, 0)
  await f.adapter.dispatch({ ...input, preparedDispatch: prepared })
  assert.equal(f.messages.length, 1)
})

test('prepared DSH dispatch rejects a replacement live Agent or Session', async () => {
  const f = fixture()
  const prepared = await f.adapter.prepareDispatch(input)
  f.registry.set(sessionRef, { ...f.agent, session: { header: {}, events: [] } })
  await assert.rejects(f.adapter.dispatch({ ...input, preparedDispatch: prepared }), /IDENTITY_MISMATCH/)
  assert.equal(f.messages.length, 0)
})

test('prepared DSH dispatch rejects a missing durability API before send; direct legacy seam remains explicit', async () => {
  const f = fixture({ flush: 'missing' })
  const prepared = await f.adapter.prepareDispatch(input)
  await assert.rejects(f.adapter.dispatch({ ...input, preparedDispatch: prepared }), /BARRIER_UNAVAILABLE/)
  await assert.rejects(f.adapter.dispatch(input), /PREPARED_TOKEN_REQUIRED/)
  assert.equal(f.messages.length, 0)
  await f.adapter.dispatch({ sessionRef, text: 'legacy direct call' })
  assert.equal(f.messages.length, 1)
})

for (const [label, flush] of [
  ['false', async () => false],
  ['throw', async () => { throw new Error('private persistence detail') }],
  ['timeout', () => new Promise<boolean>(() => {})],
] as const) {
  test(`prepared DSH dispatch: ${label} flush creates no receipt and cannot resend`, async () => {
    const f = fixture({ flush, timeout: 5 })
    const prepared = await f.adapter.prepareDispatch(input)
    await assert.rejects(f.adapter.dispatch({ ...input, preparedDispatch: prepared }), /DURABILITY_BARRIER_(NOT_CONFIRMED|UNCERTAIN|TIMEOUT)/)
    await assert.rejects(f.adapter.dispatch({ ...input, preparedDispatch: prepared }), /ALREADY_USED/)
    assert.equal(f.messages.length, 1)
    assert.equal(f.flushed.length, 1)
  })
}

test('prepared DSH dispatch consumes the token even if followup throws', async () => {
  const f = fixture({ followupThrows: true })
  const prepared = await f.adapter.prepareDispatch(input)
  await assert.rejects(f.adapter.dispatch({ ...input, preparedDispatch: prepared }), /private runtime detail/)
  await assert.rejects(f.adapter.dispatch({ ...input, preparedDispatch: prepared }), /ALREADY_USED/)
  assert.equal(f.messages.length, 1)
  assert.equal(f.flushed.length, 0)
})

test('prepared DSH dispatch cannot borrow an ID inserted before its own send', async () => {
  const f = fixture()
  const prepared = await f.adapter.prepareDispatch(input)
  f.events.push({ type: 'user/message', data: { id: prepared.runtimeDispatchRef } })
  await assert.rejects(f.adapter.dispatch({ ...input, preparedDispatch: prepared }), /RUNTIME_REF_ALREADY_PRESENT/)
  assert.equal(f.messages.length, 0)
})

test('prepare rejects unreadable advertised snapshots and empty dispatch identity', async () => {
  const f = fixture()
  Object.assign(f.session, { snapshotEvents: () => { throw new Error('private details') } })
  await assert.rejects(f.adapter.prepareDispatch(input), /BASELINE_UNREADABLE/)
  await assert.rejects(f.adapter.prepareDispatch({ ...input, kingdomDispatchId: '' }), /IDENTITY_REQUIRED/)
  assert.equal(f.messages.length, 0)
})

const runtimeRef = 'exact-runtime-message'
const inbox: RuntimeEvent = { type: 'agent/inbox/spliced', data: { inserted: [{ id: runtimeRef, content: [{ text: 'PRIVATE-INPUT' }] }] } }
const start: RuntimeEvent = { type: 'turn/start', data: { turn: 7 } }
const end: RuntimeEvent = { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } }
const assistant: RuntimeEvent = { type: 'assistant/message', data: { text: 'PRIVATE-OUTPUT' } }

function coldFixture(events: readonly RuntimeEvent[], options: { readThrows?: boolean; closeThrows?: boolean; access?: string; id?: string } = {}) {
  const opened: [string, string][] = []
  const reads: [number, number][] = []
  let closes = 0
  let resumes = 0
  const adapter = new DshRuntimeAdapter({
    runtimeInstanceRef: 'runtime-instance', provider: 'keyless-test', model: null,
    agents: { get: () => undefined, resume: () => { resumes += 1; throw new Error('must not resume') } },
    sessionPersistence: { async open(id: string, access: string) {
      opened.push([id, access])
      return {
        id: options.id ?? id, access: options.access ?? access,
        async read(offset: number, length: number) {
          reads.push([offset, length])
          if (options.readThrows) throw new Error('PRIVATE-READ-ERROR')
          return { events: events.slice(offset, offset + length), eventState: 'shared-frozen' }
        },
        async close() { closes += 1; if (options.closeThrows) throw new Error('PRIVATE-CLOSE-ERROR') },
      }
    } },
  })
  return { adapter, opened, reads, closes: () => closes, resumes: () => resumes }
}

for (const [state, events] of [
  ['QUEUED', [inbox]],
  ['RUNNING', [inbox, start]],
  ['TERMINAL', [inbox, start, end, assistant]],
] as const) {
  test(`cold DSH reconcile: fresh public read-only handle observes ${state}, closes and excludes session content`, async () => {
    const f = coldFixture(events)
    const result = await f.adapter.reconcile(kingdomDispatchId, { sessionRef, runtimeDispatchRef: runtimeRef })
    assert.equal(result.executionObservation, state)
    assert.equal(result.sessionObservation, 'AVAILABLE')
    assert.deepEqual(f.opened, [[sessionRef, 'read']])
    assert.deepEqual(f.reads, [[0, 10000]])
    assert.equal(f.closes(), 1)
    assert.equal(f.resumes(), 0)
    assert.equal(result.terminalOutcome, undefined, 'observation never authorizes terminal settlement')
    assert.deepEqual({ ...(result.evidence as object), observedAt: null }, {
      kingdomDispatchId, runtimeDispatchRef: runtimeRef, source: 'PERSISTED', located: true,
      eventsRead: events.length, complete: true, reason: 'EXACT_INPUT_FOUND', observedAt: null,
    })
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-|agent\/inbox|assistant\/message/)
  })
}

test('cold DSH reconcile: complete read with absent input stays UNKNOWN', async () => {
  const f = coldFixture([{ type: 'user/message', data: { id: 'another-input' } }])
  const result = await f.adapter.reconcile(kingdomDispatchId, { sessionRef, runtimeDispatchRef: runtimeRef })
  assert.equal(result.executionObservation, 'UNKNOWN')
  assert.equal(result.sessionObservation, 'AVAILABLE')
  assert.equal((result.evidence as { located: boolean }).located, false)
  assert.equal((result.evidence as { reason: string }).reason, 'INPUT_NOT_LOCATED')
  assert.equal(f.closes(), 1)
})

for (const failure of ['readThrows', 'closeThrows'] as const) {
  test(`cold DSH reconcile: ${failure} invalidates positive observation and closes read handle`, async () => {
    const f = coldFixture([inbox], { [failure]: true })
    const result = await f.adapter.reconcile(kingdomDispatchId, { sessionRef, runtimeDispatchRef: runtimeRef })
    assert.equal(result.executionObservation, 'UNKNOWN')
    assert.equal((result.evidence as { complete: boolean }).complete, false)
    assert.equal(f.closes(), 1)
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-/)
  })
}

for (const options of [{ access: 'write' }, { id: 'another-session' }]) {
  test(`cold DSH reconcile rejects wrong public reader identity ${JSON.stringify(options)}`, async () => {
    const f = coldFixture([inbox], options)
    const result = await f.adapter.reconcile(kingdomDispatchId, { sessionRef, runtimeDispatchRef: runtimeRef })
    assert.equal(result.executionObservation, 'UNKNOWN')
    assert.equal(f.reads.length, 0)
    assert.equal(f.closes(), 1)
  })
}

test('cold DSH reconcile: event limit stays UNKNOWN even when exact input is in the inspected prefix', async () => {
  const events: RuntimeEvent[] = [inbox, ...Array.from({ length: 10000 }, () => ({ type: 'safe/event' }))]
  const f = coldFixture(events)
  const result = await f.adapter.reconcile(kingdomDispatchId, { sessionRef, runtimeDispatchRef: runtimeRef })
  assert.equal(result.executionObservation, 'UNKNOWN')
  assert.equal((result.evidence as { located: boolean }).located, true)
  assert.equal((result.evidence as { complete: boolean }).complete, false)
  assert.equal((result.evidence as { eventsRead: number }).eventsRead, 10000)
  assert.equal((result.evidence as { reason: string }).reason, 'EVENT_LIMIT')
})

test('cold DSH reconcile cannot borrow the terminal of foreign input', async () => {
  const f = coldFixture([inbox, { type: 'user/message', data: { id: 'foreign-input' } }, start, end, assistant])
  const result = await f.adapter.reconcile(kingdomDispatchId, { sessionRef, runtimeDispatchRef: runtimeRef })
  assert.equal(result.executionObservation, 'UNKNOWN')
  assert.equal((result.evidence as { located: boolean }).located, true)
})

test('cold DSH reconcile: unreadable persistence metadata never proves terminal or absence', async () => {
  const adapter = new DshRuntimeAdapter({
    runtimeInstanceRef: 'runtime-instance', provider: 'keyless-test', model: null,
    agents: { get: () => undefined },
    sessionPersistence: {
      async open() { throw new Error('PRIVATE-OPEN-FAILURE') },
      async stat() { return { revision: 3 } },
    },
  })
  const result = await adapter.reconcile(kingdomDispatchId, { sessionRef, runtimeDispatchRef: runtimeRef })
  assert.equal(result.executionObservation, 'UNKNOWN')
  assert.equal(result.sessionObservation, 'AVAILABLE')
  assert.equal((result.evidence as { located: boolean }).located, false)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-/)
})

test('live DSH reconcile bounds modern snapshot reads and labels live evidence', async () => {
  const calls: unknown[][] = []
  const agent = { id: sessionRef, session: { seq: 10001, snapshotEvents(...args: unknown[]) {
    calls.push(args)
    return [inbox, ...Array.from({ length: 9999 }, () => ({ type: 'safe/event' }))]
  } } }
  const adapter = new DshRuntimeAdapter({ runtimeInstanceRef: 'runtime-instance', provider: 'keyless-test', model: null, agents: { get: () => agent } })
  const result = await adapter.reconcile(kingdomDispatchId, { sessionRef, runtimeDispatchRef: runtimeRef })
  assert.deepEqual(calls, [[0, 10000]])
  assert.equal(result.executionObservation, 'UNKNOWN')
  assert.equal((result.evidence as { source: string }).source, 'LIVE')
})

test('live legacy DSH reconcile does not validate events beyond the observation budget', async () => {
  const events = [inbox, ...Array.from({ length: 9999 }, () => ({ type: 'safe/event' }))]
  Object.defineProperty(events, 10000, { get() { throw new Error('must not traverse beyond limit') } })
  const adapter = new DshRuntimeAdapter({
    runtimeInstanceRef: 'runtime-instance', provider: 'keyless-test', model: null,
    agents: { get: () => ({ id: sessionRef, session: { events } }) },
  })
  const result = await adapter.reconcile(kingdomDispatchId, { sessionRef, runtimeDispatchRef: runtimeRef })
  assert.equal(result.executionObservation, 'UNKNOWN')
  assert.equal((result.evidence as { located: boolean }).located, true)
  assert.equal((result.evidence as { reason: string }).reason, 'EVENT_LIMIT')
})

test('bounded live DSH reconcile rejects sparse event prefixes even when input is located', async () => {
  const events: RuntimeEvent[] = [inbox]
  events.length = 3
  const adapter = new DshRuntimeAdapter({
    runtimeInstanceRef: 'runtime-instance', provider: 'keyless-test', model: null,
    agents: { get: () => ({ id: sessionRef, session: { events } }) },
  })
  const result = await adapter.reconcile(kingdomDispatchId, { sessionRef, runtimeDispatchRef: runtimeRef })
  assert.equal(result.executionObservation, 'UNKNOWN')
  assert.equal((result.evidence as { complete: boolean }).complete, false)
  assert.equal((result.evidence as { reason: string }).reason, 'OBSERVATION_UNREADABLE')
})
