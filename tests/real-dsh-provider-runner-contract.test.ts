import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import * as runnerModule from '../scripts/e2e/real-dsh-provider-v10.mjs'

const execFile = promisify(execFileCallback)

const {
  OPPORTUNITY_LEDGER_FILE,
  buildProfileOverlay,
  buildProfileOverlayEntries,
  createOpportunityLedger,
  createRunnerLayout,
  enqueueFirstPotentialModelPrompt,
  initializeOpportunityLedger,
  isWithinRoot,
  parseRunnerArgs,
  readOpportunityLedger,
  reserveProviderOpportunityAtomically,
  runContractSimulation,
  runRealAttemptBranch,
  transitionProviderOpportunity,
} = runnerModule

async function tempDirectory(prefix) {
  return mkdtemp(join(tmpdir(), prefix))
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function event(sessionId, seq, type, data) {
  return {
    method: 'session.event',
    params: { sessionId, event: { seq, type, data } },
  }
}

function status(sessionId, value = 'idle') {
  return { method: 'session.status', params: { sessionId, status: value } }
}

function productContextPortFixture() {
  let phase = 'OPEN'
  const view = () => ({
    phase,
    dispatchState: 'INTENDED',
    executionState: 'STARTING',
    leaseState: 'EXECUTING',
  })
  return {
    handle: { fixture: 'opaque' },
    initialVersion: { fixture: 0 },
    get currentPhase() { return phase },
    acquire() { phase = 'ACQUIRED'; return view() },
    brokerSnapshot() { return view() },
  }
}

function targetReceipt(sessionId, seq = 1, inserted = [{ id: 'message-1', source: { kind: 'user' } }]) {
  return event(sessionId, seq, 'agent/inbox/spliced', {
    inserted,
  })
}

function targetStart(sessionId, seq = 2, turn = 7) {
  return event(sessionId, seq, 'turn/start', { turn })
}

function targetUser(sessionId, seq = 3, id = 'message-1', sourceKind = 'user') {
  return event(sessionId, seq, 'user/message', {
    id,
    source: { kind: sourceKind },
  })
}

function targetAssistant(sessionId, seq = 4, turn = 7, provider = 'provider-test', model = 'model-test') {
  return event(sessionId, seq, 'assistant/message', {
    turn,
    step: 0,
    message: {
      id: 'assistant-1',
      role: 'assistant',
      content: [],
      source: { provider, model },
    },
  })
}

function targetEnd(sessionId, seq = 5, turn = 7, reasonKind = 'completed') {
  return event(sessionId, seq, 'turn/end', {
    turn,
    reason: { kind: reasonKind },
  })
}

function simulationNotifications(sessionId, variant = 'complete') {
  if (variant === 'pre-turn-user') {
    return [
      targetReceipt(sessionId, 1),
      targetUser(sessionId, 2),
      targetStart(sessionId, 3),
      targetAssistant(sessionId, 4),
      targetEnd(sessionId, 5),
      status(sessionId),
    ]
  }
  if (variant === 'duplicate-user') {
    return [
      targetReceipt(sessionId, 1),
      targetStart(sessionId, 2),
      targetUser(sessionId, 3),
      targetUser(sessionId, 4),
      targetAssistant(sessionId, 5),
      targetEnd(sessionId, 6),
      status(sessionId),
    ]
  }
  if (variant === 'cross-turn') {
    return [
      targetReceipt(sessionId, 1),
      targetStart(sessionId, 2),
      targetUser(sessionId, 3),
      targetAssistant(sessionId, 4, 8),
      targetEnd(sessionId, 5, 8),
      status(sessionId),
    ]
  }
  if (variant === 'missing-assistant') {
    return [
      targetReceipt(sessionId, 1),
      targetStart(sessionId, 2),
      targetUser(sessionId, 3),
      targetEnd(sessionId, 4),
      status(sessionId),
    ]
  }
  if (variant === 'interrupted') {
    return [
      targetReceipt(sessionId, 1),
      targetStart(sessionId, 2),
      targetUser(sessionId, 3),
      targetAssistant(sessionId, 4),
      targetEnd(sessionId, 5, 7, 'interrupted'),
      status(sessionId),
    ]
  }
  if (variant === 'foreign-user') {
    return [
      targetReceipt(sessionId, 1),
      targetUser(sessionId, 2, 'foreign-user'),
      targetStart(sessionId, 3),
      targetUser(sessionId, 4),
      targetAssistant(sessionId, 5),
      targetEnd(sessionId, 6),
      status(sessionId),
    ]
  }
  if (variant === 'out-of-order') {
    return [
      targetReceipt(sessionId, 1),
      targetStart(sessionId, 3),
      targetUser(sessionId, 4),
      targetAssistant(sessionId, 5),
      targetEnd(sessionId, 6),
      status(sessionId),
    ]
  }
  if (variant === 'seq-gap') {
    return [
      targetReceipt(sessionId, 1),
      targetStart(sessionId, 3),
      targetUser(sessionId, 4),
      targetAssistant(sessionId, 5),
      targetEnd(sessionId, 6),
      status(sessionId),
    ]
  }
  if (variant === 'seq-duplicate') {
    return [
      targetReceipt(sessionId, 1),
      targetStart(sessionId, 1),
      targetUser(sessionId, 2),
      targetAssistant(sessionId, 3),
      targetEnd(sessionId, 4),
      status(sessionId),
    ]
  }
  if (variant === 'seq-decrease') {
    return [
      targetReceipt(sessionId, 1),
      targetStart(sessionId, 2),
      targetUser(sessionId, 1),
      targetAssistant(sessionId, 3),
      targetEnd(sessionId, 4),
      status(sessionId),
    ]
  }
  if (variant === 'non-numeric-turn') {
    return [
      targetReceipt(sessionId, 1),
      event(sessionId, 2, 'turn/start', { turn: '7' }),
      targetUser(sessionId, 3),
      targetAssistant(sessionId, 4),
      targetEnd(sessionId, 5),
      status(sessionId),
    ]
  }
  if (variant === 'route-mismatch') {
    return [
      targetReceipt(sessionId, 1),
      targetStart(sessionId, 2),
      targetUser(sessionId, 3),
      targetAssistant(sessionId, 4, 7, 'other-provider', 'other-model'),
      targetEnd(sessionId, 5),
      status(sessionId),
    ]
  }
  if (variant === 'missing-route') {
    return [
      targetReceipt(sessionId, 1),
      targetStart(sessionId, 2),
      targetUser(sessionId, 3),
      event(sessionId, 4, 'assistant/message', {
        turn: 7,
        message: { id: 'assistant-1', role: 'assistant', content: [] },
      }),
      targetEnd(sessionId, 5),
      status(sessionId),
    ]
  }
  if (variant === 'same-envelope-frames') {
    return [
      targetReceipt(sessionId, 1, [
        { id: 'message-1', source: { kind: 'user' } },
        { id: 'synthetic-parser-frame', source: { kind: 'system' } },
      ]),
      targetStart(sessionId, 2),
      targetUser(sessionId, 3),
      targetAssistant(sessionId, 4),
      targetEnd(sessionId, 5),
      status(sessionId),
    ]
  }
  if (variant === 'post-end-plugin' || variant === 'post-end-inject' || variant === 'post-end-goal') {
    const sourceKind = variant.replace('post-end-', '')
    return [
      targetReceipt(sessionId, 1),
      targetStart(sessionId, 2),
      targetUser(sessionId, 3),
      targetAssistant(sessionId, 4),
      targetEnd(sessionId, 5),
      targetStart(sessionId, 6, 8),
      targetUser(sessionId, 7, `${sourceKind}-next-turn`, sourceKind),
      status(sessionId),
    ]
  }
  if (variant === 'post-end-direct-foreign') {
    return [
      targetReceipt(sessionId, 1),
      targetStart(sessionId, 2),
      targetUser(sessionId, 3),
      targetAssistant(sessionId, 4),
      targetEnd(sessionId, 5),
      targetUser(sessionId, 6, 'foreign-after-end', 'user'),
      status(sessionId),
    ]
  }
  return [
    targetReceipt(sessionId, 1),
    targetStart(sessionId, 2),
    targetUser(sessionId, 3),
    targetAssistant(sessionId, 4),
    targetEnd(sessionId, 5),
    status(sessionId),
  ]
}

function fakeRuntimeFactory(variant = 'complete') {
  return async ({ sessionId, routeEvidence }) => {
    let listener
    let subscriptionCloseCalls = 0
    const client = {
      subscribe(filter) {
        listener = filter
        return {
          close() {
            subscriptionCloseCalls += 1
          },
        }
      },
      async prompt(actualSessionId) {
        assert.equal(actualSessionId, sessionId)
        queueMicrotask(() => {
          for (const notification of simulationNotifications(sessionId, variant)) listener?.(notification)
        })
        return { messageId: 'message-1' }
      },
    }
    return {
      client,
      initialized: true,
      runtimeProcessOwnedByRunner: true,
      routeEvidence,
      async close() {
        subscriptionCloseCalls += 1
      },
      get subscriptionCloseCalls() {
        return subscriptionCloseCalls
      },
    }
  }
}

function simulationOptions(root, variant = 'complete', extra = {}) {
  return {
    simulationOptIn: true,
    providerAlias: 'provider-test',
    model: 'model-test',
    requirement: 'bounded simulation requirement',
    runnerRoot: join(root, 'runner'),
    preflightRunner: async () => ({
      ok: true,
      noDshProcessStarted: true,
      noProviderCall: true,
    }),
    stageRunner: async () => ({
      status: 'READY',
      artifactCount: 1,
      artifactNames: ['synthetic.tgz'],
    }),
    runtimeFactory: fakeRuntimeFactory(variant),
    publicRouteSurface: {
      async listProviders() { return [{ id: 'provider-test' }] },
      async listModels() { return [{ id: 'model-test' }] },
    },
    activityTimeoutMs: 1_000,
    ...extra,
  }
}

test('public runner surface excludes low-level observer/control/proof constructors and production provenance shims', async () => {
  for (const name of [
    'createBoundedSessionEventObserver',
    'createControlledStopGateState',
    'createStopGateProof',
    'evaluateStopGates',
    'bindRuntimeDispatchRefToMessageId',
    'runSupervisorAcceptDone',
  ]) {
    assert.equal(Object.hasOwn(runnerModule, name), false, `${name} must not be public`)
  }
  const source = await readFile(new URL('../scripts/e2e/real-dsh-provider-v10.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\bWeakMap\b/u)
  assert.doesNotMatch(source, /Object\.freeze/u)
})

test('parseRunnerArgs rejects caller-supplied runner IDs', () => {
  for (const argument of ['--task-id=caller-task', '--attempt-no=2', '--kingdom-dispatch-id=caller-dispatch', '--session-id=caller-session']) {
    assert.throws(
      () => parseRunnerArgs([argument, '--provider-alias=provider-test', '--model=model-test']),
      /RUNNER_CONTEXT_INPUT_FORBIDDEN/,
    )
  }
})

test('REAL_PRODUCTION fail-closes before any injected callback, ledger, runtime, or route surface', async () => {
  const root = await tempDirectory('dsh-v10-real-context-')
  let callbackCalls = 0
  const previousSerializedEnvironment = process.env.DSH_KINGDOM_BROKER_SERIALIZED_ENV
  delete process.env.DSH_KINGDOM_BROKER_SERIALIZED_ENV
  try {
    const result = await runRealAttemptBranch({
      optIn: true,
      providerAlias: 'provider-test',
      model: 'model-test',
      runnerRoot: join(root, 'runner'),
      reserveOpportunity: async () => { callbackCalls += 1 },
      runtimeFactory: async () => { callbackCalls += 1 },
      preflightRunner: async () => { callbackCalls += 1 },
      governance: { async supervisorAccept() { callbackCalls += 1 } },
      publicRouteSurface: { async listProviders() { callbackCalls += 1; return [] } },
    })
    assert.equal(result.mode, 'REAL_PRODUCTION')
    assert.equal(result.status, 'BLOCKED')
    assert.equal(result.reason, 'PRODUCT_BROKER_SERIALIZED_ENV_REQUIRED')
    assert.equal(result.noProviderCall, true)
    assert.equal(result.providerCalls, 0)
    assert.equal(result.promptInvocations, 0)
    assert.equal(result.providerOpportunityConsumed, false)
    assert.deepEqual(result.providerBoundaryCounter, { start: 0, end: 0, increments: 0 })
    assert.equal(result.contextFailureCode, 'PRODUCT_BROKER_SERIALIZED_ENV_REQUIRED')
    assert.equal(callbackCalls, 0)
    assert.equal(await pathExists(join(root, 'runner')), false)
  } finally {
    if (previousSerializedEnvironment === undefined) delete process.env.DSH_KINGDOM_BROKER_SERIALIZED_ENV
    else process.env.DSH_KINGDOM_BROKER_SERIALIZED_ENV = previousSerializedEnvironment
    await rm(root, { recursive: true, force: true })
  }
})

test('package-root Product lifecycle rejects unsafe input without widening its public contract', async () => {
  const productRootModule = await import('dsh-kingdom')
  assert.equal(typeof productRootModule.createRunnerContextBrokerProductLifecycle, 'function')
  assert.throws(
    () => productRootModule.createRunnerContextBrokerProductLifecycle('relative-run-root'),
    /UNSAFE_RENDEZVOUS/,
  )
  assert.throws(
    () => productRootModule.createRunnerContextBrokerProductLifecycle({ runRoot: resolve('forged') }),
    /UNSAFE_RENDEZVOUS/,
  )
})

test('package-root Product lifecycle issues fresh-child bootstrap and closes owned resources exactly once', async () => {
  const root = await tempDirectory('dsh-r20-product-lifecycle-')
  const productRootModule = await import('dsh-kingdom')
  const brokerInternals = await import('../lib/runner-context-broker.js')
  const lifecycle = productRootModule.createRunnerContextBrokerProductLifecycle(root)
  let dispatchRemembered = false
  try {
    assert.deepEqual(Object.keys(lifecycle).sort(), ['bootstrap', 'close'])
    const bootstrap = await lifecycle.bootstrap()
    assert.deepEqual(Object.keys(bootstrap).sort(), ['descriptor', 'environment'])
    assert.deepEqual(Object.keys(bootstrap.environment).sort(), [
      'DSH_KINGDOM_BROKER_LAUNCH_NONCE',
      'DSH_KINGDOM_BROKER_RENDEZVOUS_DIR',
      'DSH_KINGDOM_BROKER_REQUIRED',
    ])
    assert.deepEqual(Object.keys(bootstrap.descriptor).sort(), ['createdAt', 'endpoint', 'protocol', 'serverInstance'])

    brokerInternals.registerProductRunnerContext('r20-lifecycle-fixture', productContextPortFixture())
    dispatchRemembered = true
    const childScript = `
      const root = await import('dsh-kingdom');
      const bootstrap = JSON.parse(process.env.DSH_KINGDOM_TEST_BOOTSTRAP);
      const client = await root.connectRunnerContextBroker(bootstrap);
      const view = await client.read();
      await client.close();
      const replacement = await root.connectRunnerContextBroker(bootstrap);
      let reconnect = 'UNEXPECTED';
      try { await replacement.read(); } catch (error) { reconnect = error.code ?? 'REJECTED'; }
      await replacement.close().catch(() => undefined);
      process.stdout.write(JSON.stringify({ view, reconnect, rootOnly: typeof root.connectRunnerContextBroker === 'function' }));
    `
    const child = await execFile(process.execPath, ['--input-type=module', '--eval', childScript], {
      cwd: resolve('.'),
      env: { ...process.env, DSH_KINGDOM_TEST_BOOTSTRAP: JSON.stringify(bootstrap) },
      windowsHide: true,
    })
    const observed = JSON.parse(child.stdout)
    assert.equal(observed.rootOnly, true)
    assert.equal(observed.view.phase, 'ACQUIRED')
    assert.equal(observed.view.dispatchState, 'INTENDED')
    assert.equal(observed.view.executionState, 'STARTING')
    assert.equal(observed.view.leaseState, 'EXECUTING')
    assert.equal(observed.reconnect, 'CONTEXT_UNAVAILABLE')

    brokerInternals.forgetRunnerContextPort('r20-lifecycle-fixture')
    dispatchRemembered = false
    const firstClose = lifecycle.close()
    const secondClose = lifecycle.close()
    assert.equal(firstClose, secondClose)
    assert.deepEqual(await firstClose, {
      status: 'CONFIRMED',
      closeExecutions: 1,
      activeConnections: 0,
      activeRegistrations: 0,
      activeServers: 0,
      descriptorStatus: 'ABSENT',
      endpointStatus: process.platform === 'win32' ? 'NOT_APPLICABLE' : 'ABSENT',
    })
    await assert.rejects(productRootModule.connectRunnerContextBroker(bootstrap), /RENDEZVOUS_NOT_FOUND/)
  } finally {
    if (dispatchRemembered) brokerInternals.forgetRunnerContextPort('r20-lifecycle-fixture')
    await lifecycle.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

test('package-root Product lifecycle keeps cleanup uncertainty rejected and memoized without settlement claims', async () => {
  const root = await tempDirectory('dsh-r20-product-cleanup-uncertain-')
  const productRootModule = await import('dsh-kingdom')
  const lifecycle = productRootModule.createRunnerContextBrokerProductLifecycle(root)
  let descriptorPath
  try {
    const bootstrap = await lifecycle.bootstrap()
    descriptorPath = join(
      bootstrap.environment.DSH_KINGDOM_BROKER_RENDEZVOUS_DIR,
      `${bootstrap.environment.DSH_KINGDOM_BROKER_LAUNCH_NONCE}.json`,
    )
    await rm(descriptorPath, { force: true })
    await mkdir(descriptorPath)

    const firstClose = lifecycle.close()
    const secondClose = lifecycle.close()
    assert.equal(firstClose, secondClose)

    let firstError
    await assert.rejects(firstClose, error => {
      assert.ok(error instanceof Error)
      assert.equal(error.code, 'CLEANUP_UNCERTAIN')
      firstError = error
      for (const forbiddenClaim of [
        'receipt',
        'settlement',
        'settled',
        'leaseRelease',
        'leaseReleased',
        'leaseState',
      ]) {
        assert.equal(Object.hasOwn(error, forbiddenClaim), false, forbiddenClaim)
      }
      assert.doesNotMatch(
        JSON.stringify({ name: error.name, code: error.code, message: error.message }),
        /settlement|settled|lease[-_ ]?release(?:d)?/iu,
      )
      return true
    })

    const repeatedOutcomes = await Promise.allSettled([firstClose, secondClose])
    assert.deepEqual(repeatedOutcomes.map(outcome => outcome.status), ['rejected', 'rejected'])
    assert.equal(Object.hasOwn(repeatedOutcomes[0], 'value'), false)
    assert.equal(Object.hasOwn(repeatedOutcomes[1], 'value'), false)
    assert.equal(repeatedOutcomes[0].reason, firstError)
    assert.equal(repeatedOutcomes[1].reason, firstError)

    await rm(descriptorPath, { recursive: true, force: true })
    const thirdClose = lifecycle.close()
    assert.equal(thirdClose, firstClose)
    await assert.rejects(thirdClose, error => {
      assert.equal(error, firstError)
      assert.equal(error.code, 'CLEANUP_UNCERTAIN')
      return true
    })
  } finally {
    if (descriptorPath !== undefined) await rm(descriptorPath, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('REAL_PRODUCTION proves the private Provider-boundary counter stays zero without Provider activity', async () => {
  const previousSerializedEnvironment = process.env.DSH_KINGDOM_BROKER_SERIALIZED_ENV
  delete process.env.DSH_KINGDOM_BROKER_SERIALIZED_ENV
  try {
    const result = await runRealAttemptBranch({
      optIn: true,
      providerAlias: 'provider-test',
      model: 'model-test',
      providerBoundaryCounter: { start: 9, end: 9, increments: 9 },
    })
    assert.deepEqual(result.providerBoundaryCounter, { start: 0, end: 0, increments: 0 })
    assert.equal(result.providerCalls, 0)
    assert.equal(Object.hasOwn(runnerModule, 'runnerProviderBoundaryCalls'), false)
    assert.equal(Object.hasOwn(runnerModule, 'providerBoundaryCounterFrom'), false)
  } finally {
    if (previousSerializedEnvironment === undefined) delete process.env.DSH_KINGDOM_BROKER_SERIALIZED_ENV
    else process.env.DSH_KINGDOM_BROKER_SERIALIZED_ENV = previousSerializedEnvironment
  }
})

test('REAL_PRODUCTION consumes only Product serialized bootstrap through package root and fails before opportunity on stale rendezvous', async () => {
  const productRoot = await tempDirectory('dsh-v10-product-bootstrap-')
  const rendezvousDir = join(productRoot, '.local', 'runner-context-broker')
  await mkdir(rendezvousDir, { recursive: true })
  const previousSerializedEnvironment = process.env.DSH_KINGDOM_BROKER_SERIALIZED_ENV
  const launchNonce = 'A'.repeat(43)
  process.env.DSH_KINGDOM_BROKER_SERIALIZED_ENV = JSON.stringify({
    DSH_KINGDOM_BROKER_REQUIRED: '1',
    DSH_KINGDOM_BROKER_RENDEZVOUS_DIR: rendezvousDir,
    DSH_KINGDOM_BROKER_LAUNCH_NONCE: launchNonce,
  })
  let callbackCalls = 0
  try {
    const productRootModule = await import('dsh-kingdom')
    assert.equal(typeof productRootModule.connectRunnerContextBroker, 'function')
    const source = await readFile(new URL('../scripts/e2e/real-dsh-provider-v10.mjs', import.meta.url), 'utf8')
    assert.match(source, /import\('dsh-kingdom'\)/u)
    assert.doesNotMatch(source, /(?:src\/runner-context-broker|lib\/runner-context-broker)/u)

    const result = await runRealAttemptBranch({
      optIn: true,
      providerAlias: 'provider-test',
      model: 'model-test',
      taskId: 'caller-task',
      attemptNo: 99,
      kingdomDispatchId: 'caller-dispatch',
      sessionId: 'caller-session',
      reserveOpportunity: async () => { callbackCalls += 1 },
      runtimeFactory: async () => { callbackCalls += 1 },
    })
    assert.equal(result.mode, 'REAL_PRODUCTION')
    assert.equal(result.status, 'BLOCKED')
    assert.equal(result.reason, 'PRODUCT_CONTEXT_CONNECT_FAILED')
    assert.equal(result.contextFailureCode, 'RENDEZVOUS_NOT_FOUND')
    assert.equal(result.productContext.status, 'BLOCKED')
    assert.equal(result.providerCalls, 0)
    assert.equal(result.promptInvocations, 0)
    assert.equal(result.providerOpportunityConsumed, false)
    assert.equal(callbackCalls, 0)
    assert.equal(Object.hasOwn(result, 'taskId'), false)
    assert.doesNotMatch(JSON.stringify(result), /caller-task|caller-dispatch|caller-session/u)
    assert.equal(result.stateTrace.includes('PRODUCT_BROKER_CONNECTED'), false)
  } finally {
    if (previousSerializedEnvironment === undefined) delete process.env.DSH_KINGDOM_BROKER_SERIALIZED_ENV
    else process.env.DSH_KINGDOM_BROKER_SERIALIZED_ENV = previousSerializedEnvironment
    await rm(productRoot, { recursive: true, force: true })
  }
})

test('CONTRACT_SIMULATION_ONLY requires explicit opt-in and a high-level runtime seam', async () => {
  const optOut = await runContractSimulation({
    providerAlias: 'provider-test',
    model: 'model-test',
    requirement: 'bounded simulation requirement',
  })
  assert.equal(optOut.mode, 'CONTRACT_SIMULATION_ONLY')
  assert.equal(optOut.reason, 'CONTRACT_SIMULATION_OPT_IN_REQUIRED')
  await assert.rejects(
    runContractSimulation({
      simulationOptIn: true,
      providerAlias: 'provider-test',
      model: 'model-test',
      requirement: 'bounded simulation requirement',
      preflightRunner: async () => ({ ok: true }),
      stageRunner: async () => ({ status: 'READY' }),
      publicRouteSurface: {},
    }),
    /CONTRACT_SIMULATION_RUNNER_SURFACE_REQUIRED/,
  )
})

test('CONTRACT_SIMULATION_ONLY uses generated correlation and cannot be promoted by caller proof/counts', async () => {
  const root = await tempDirectory('dsh-v10-simulation-success-')
  let forgedReservationCalls = 0
  let governanceCalls = 0
  try {
    const result = await runContractSimulation(simulationOptions(root, 'complete', {
      taskId: 'caller-task',
      attemptNo: 99,
      kingdomDispatchId: 'caller-dispatch',
      sessionId: 'caller-session',
      reserveOpportunity: async () => { forgedReservationCalls += 1 },
      observer: { snapshot() { return { completedTurnCount: 99 } } },
      controlledState: { snapshot() { return { leaseReleased: true } } },
      proof: { accepted: true },
      completedTurnCount: 99,
      assistantMessageCount: 99,
      governance: {
        async supervisorAccept() { governanceCalls += 1; return { decision: 'ACCEPT' } },
        async detailDone() { governanceCalls += 1; return { status: 'DONE' } },
      },
    }))
    assert.equal(result.mode, 'CONTRACT_SIMULATION_ONLY')
    assert.equal(result.status, 'CONTRACT_SIMULATION_ONLY')
    assert.equal(result.reason, 'CONTRACT_SIMULATION_NO_GOVERNANCE')
    assert.equal(result.hardGates.accepted, true)
    assert.equal(result.governance.status, 'NOT_RUN')
    assert.equal(result.governance.supervisorDecision, 'NOT_RUN')
    assert.equal(result.governance.taskStatus, 'REVIEW')
    assert.equal(result.providerOpportunity.currentCalls, 1)
    assert.equal(result.providerOpportunity.remaining, 8)
    assert.equal(result.providerCalls, 0)
    assert.equal(result.noProviderCall, true)
    assert.equal(result.providerCallObserved, false)
    assert.equal(result.providerCallObservation, 'CONTRACT_SIMULATION_SYNTHETIC_ASSISTANT_EVENT')
    assert.equal(result.providerOutcome, 'NOT_RUN')
    assert.equal(result.attemptEvidence.exactCorrelation, true)
    assert.equal(result.attemptEvidence.observedTurn, '7')
    assert.equal(result.attemptEvidence.taskCorrelation, 'module-runner-context')
    assert.equal(result.attemptEvidence.eventSeqViolationCount, 0)
    assert.equal(Object.hasOwn(result, 'taskId'), false)
    assert.equal(Object.hasOwn(result.attemptEvidence, 'taskId'), false)
    assert.doesNotMatch(JSON.stringify(result), /caller-task|caller-dispatch|caller-session/u)
    assert.equal(forgedReservationCalls, 0)
    assert.equal(governanceCalls, 0)
    assert.equal(result.stateTrace.includes('SUPERVISOR_ACCEPT'), false)
    assert.equal(result.stateTrace.includes('DETAIL_DONE'), false)
    assert.equal(result.stateTrace.includes('GOV_DONE'), false)
    const ledger = await readOpportunityLedger(join(root, 'runner', 'bounded-evidence', OPPORTUNITY_LEDGER_FILE))
    assert.equal(ledger.currentCalls, result.providerOpportunity.currentCalls)
    assert.equal(ledger.remaining, result.providerOpportunity.remaining)
    const ledgerDocument = JSON.parse(await readFile(join(root, 'runner', 'bounded-evidence', OPPORTUNITY_LEDGER_FILE), 'utf8'))
    assert.equal(ledgerDocument.state, 'RESERVED')
    assert.equal(Object.hasOwn(ledgerDocument, 'accounted'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('contract simulation rejects pre-turn user, duplicate, cross-turn, missing assistant, interrupted, and foreign direct events irreversibly', async () => {
  for (const variant of ['pre-turn-user', 'duplicate-user', 'cross-turn', 'missing-assistant', 'interrupted', 'foreign-user']) {
    const root = await tempDirectory(`dsh-v10-negative-${variant}-`)
    try {
      const result = await runContractSimulation(simulationOptions(root, variant))
      assert.notEqual(result.status, 'CONTRACT_SIMULATION_ONLY', variant)
      assert.equal(result.hardGates?.accepted, false, variant)
      assert.ok(
        (result.attemptEvidence?.preTargetEventCount ?? 0) > 0
          || (result.attemptEvidence?.outOfBoundsEventCount ?? 0) > 0
          || (result.attemptEvidence?.multipleTargetTurnCount ?? 0) > 0
          || (result.attemptEvidence?.correlationMismatches ?? 0) > 0
          || (result.attemptEvidence?.foreignUserCount ?? 0) > 0
          || (result.attemptEvidence?.invalidNotificationCount ?? 0) > 0,
        `${variant} must retain a bounded negative observation`,
      )
      assert.equal(result.providerOpportunity.currentCalls, 1, `${variant} consumes the single reservation once`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('contract simulation rejects non-contiguous event envelopes and non-numeric turn evidence', async () => {
  const sequenceCases = [
    ['seq-gap', 'GAP', 'eventSeqGapCount'],
    ['seq-duplicate', 'DUPLICATE', 'eventSeqDuplicateCount'],
    ['seq-decrease', 'DECREASE', 'eventSeqDecreaseCount'],
  ]
  for (const [variant, reason, counter] of sequenceCases) {
    const root = await tempDirectory(`dsh-v10-order-${variant}-`)
    try {
      const result = await runContractSimulation(simulationOptions(root, variant))
      assert.notEqual(result.status, 'CONTRACT_SIMULATION_ONLY', variant)
      assert.equal(result.hardGates?.accepted, false, variant)
      assert.equal(result.attemptEvidence?.exactCorrelation, false, variant)
      assert.equal(result.attemptEvidence?.eventSeqViolationReason, reason, variant)
      assert.ok((result.attemptEvidence?.[counter] ?? 0) > 0, variant)
      assert.ok((result.attemptEvidence?.eventSeqViolationCount ?? 0) > 0, variant)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
  for (const variant of ['out-of-order', 'non-numeric-turn', 'route-mismatch', 'missing-route']) {
    const root = await tempDirectory(`dsh-v10-order-${variant}-`)
    try {
      const result = await runContractSimulation(simulationOptions(root, variant))
      assert.notEqual(result.status, 'CONTRACT_SIMULATION_ONLY', variant)
      assert.equal(result.hardGates?.accepted, false, variant)
      assert.equal(result.attemptEvidence?.exactCorrelation, false, variant)
      if (variant === 'out-of-order') assert.equal(result.attemptEvidence?.eventSeqViolationReason, 'GAP')
      if (variant === 'non-numeric-turn') assert.ok((result.attemptEvidence?.invalidNotificationCount ?? 0) > 0)
      if (variant === 'missing-route') assert.ok((result.attemptEvidence?.missingEffectiveRouteCount ?? 0) > 0)
      if (variant === 'route-mismatch') assert.ok((result.attemptEvidence?.effectiveRouteMismatches ?? 0) > 0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('synthetic same-envelope inserted frames share one seq without false duplicate rejection', async () => {
  const root = await tempDirectory('dsh-v10-same-envelope-')
  try {
    const result = await runContractSimulation(simulationOptions(root, 'same-envelope-frames'))
    assert.equal(result.status, 'CONTRACT_SIMULATION_ONLY')
    assert.equal(result.hardGates.accepted, true)
    assert.equal(result.attemptEvidence.exactCorrelation, true)
    assert.equal(result.attemptEvidence.eventSeqViolationCount, 0)
    assert.equal(result.attemptEvidence.eventSeqViolationReason, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('post-end next-turn start and plugin/inject/goal frames are out of bounds', async () => {
  for (const variant of ['post-end-plugin', 'post-end-inject', 'post-end-goal', 'post-end-direct-foreign']) {
    const root = await tempDirectory(`dsh-v10-continuation-${variant}-`)
    try {
      const result = await runContractSimulation(simulationOptions(root, variant))
      assert.notEqual(result.status, 'CONTRACT_SIMULATION_ONLY', variant)
      assert.equal(result.hardGates.accepted, false, variant)
      assert.equal(result.attemptEvidence.exactCorrelation, false, variant)
      assert.ok((result.attemptEvidence.outOfBoundsEventCount ?? 0) > 0, variant)
      if (variant === 'post-end-direct-foreign') {
        assert.ok((result.attemptEvidence.foreignUserCount ?? 0) > 0, variant)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('durable opportunity reservation is atomic under concurrency and repeat', async () => {
  const root = await tempDirectory('dsh-v10-opportunity-concurrency-')
  try {
    const layout = await createRunnerLayout({ root: join(root, 'runner') })
    const initialized = await initializeOpportunityLedger(layout)
    let enqueueCalls = 0
    const reserve = () => enqueueFirstPotentialModelPrompt({
      layout,
      enqueue: async () => { enqueueCalls += 1 },
    })
    const outcomes = await Promise.allSettled([reserve(), reserve()])
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1)
    assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 1)
    assert.equal(enqueueCalls, 1)
    assert.deepEqual(await readOpportunityLedger(initialized.path), {
      total: 10,
      priorConsumed: 1,
      currentCalls: 1,
      remaining: 8,
    })
    await assert.rejects(reserve(), /EXTRA_PROVIDER_ATTEMPT|OPPORTUNITY_RESERVATION_LOCKED/)
    assert.equal(enqueueCalls, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('durable reservation consumes once when enqueue fails and never retries or falls back', async () => {
  const root = await tempDirectory('dsh-v10-opportunity-failure-')
  try {
    const layout = await createRunnerLayout({ root: join(root, 'runner') })
    const initialized = await initializeOpportunityLedger(layout)
    let enqueueCalls = 0
    await assert.rejects(
      reserveProviderOpportunityAtomically({
        ledgerPath: initialized.path,
        boundedEvidenceRoot: layout.boundedEvidence,
        enqueue: async () => { enqueueCalls += 1; throw new Error('synthetic enqueue failure') },
      }),
      /PROVIDER_ENQUEUE_FAILED_NO_RETRY/,
    )
    assert.equal(enqueueCalls, 1)
    assert.deepEqual(await readOpportunityLedger(initialized.path), {
      total: 10,
      priorConsumed: 1,
      currentCalls: 1,
      remaining: 8,
    })
    await assert.rejects(
      reserveProviderOpportunityAtomically({
        ledgerPath: initialized.path,
        boundedEvidenceRoot: layout.boundedEvidence,
        enqueue: async () => { enqueueCalls += 1 },
      }),
      /EXTRA_PROVIDER_ATTEMPT/,
    )
    assert.equal(enqueueCalls, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('opportunity state machine keeps Slash and extra attempts closed', () => {
  const ledger = createOpportunityLedger()
  assert.deepEqual(ledger, { total: 10, priorConsumed: 1, currentCalls: 0, remaining: 9 })
  assert.throws(() => transitionProviderOpportunity(ledger, { channel: 'slash' }), /SLASH_HAS_NO_PROVIDER_OPPORTUNITY/)
  const reserved = transitionProviderOpportunity(ledger)
  assert.deepEqual(reserved, {
    total: 10,
    priorConsumed: 1,
    currentCalls: 1,
    remaining: 8,
    reservation: 'first-non-slash-prompt-only',
  })
  assert.throws(() => transitionProviderOpportunity(reserved), /EXTRA_PROVIDER_ATTEMPT/)
})

test('bounded overlay contains only the two runner-owned entries', () => {
  assert.deepEqual(buildProfileOverlayEntries().map(entry => entry.id), ['sdk-jsonrpc-server', 'dsh-kingdom'])
  const overlay = buildProfileOverlay()
  assert.match(overlay, /authMode: session-bound/u)
  assert.match(overlay, /guiPort: 0/u)
  assert.doesNotMatch(overlay.split('\n').slice(1).join('\n'), /api[_-]?key|token|secret|password|credential/u)
  assert.equal(isWithinRoot('C:/runner', 'C:/runner-child'), false)
})
