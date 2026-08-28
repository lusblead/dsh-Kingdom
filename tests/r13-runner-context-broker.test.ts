/** R18 Product-child broker boundary regressions. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KingdomStore } from '../lib/core/db.js'
import {
  acquireExecutionLease,
  advanceLeaseState,
  bindCapabilityDecision,
  createRunnerContextPort,
  establishAffinity,
  prepareGovernedDispatch,
  recordCapabilityDecision,
  setLeasePlan,
} from '../lib/core/governed.js'
import {
  activateRunnerContextBrokerLaunch,
  deactivateRunnerContextBrokerLaunch,
  type RunnerContextBrokerDescriptor,
  type RunnerContextBrokerEnvironment,
  type RunnerContextBrokerLaunch,
  createRunnerContextBrokerLaunch,
  connectRunnerContextBroker,
  registerRunnerContextBrokerContext,
} from '../lib/runner-context-broker.js'
import { connectRunnerContextBroker as connectFromRoot } from '../lib/index.js'

const now = (): string => new Date().toISOString()

interface Fixture {
  readonly store: KingdomStore
  readonly dispatchId: string
  readonly taskId: string
  readonly leaseId: string
  readonly sessionRef: string
}

function makeFixture(): Fixture {
  const store = new KingdomStore(':memory:')
  const at = now()
  const kingdomId = `r18-kingdom-${randomUUID()}`
  const supervisorBindingId = `r18-supervisor-${randomUUID()}`
  const workerBindingId = `r18-worker-${randomUUID()}`
  const territoryId = `r18-territory-${randomUUID()}`
  const taskId = `r18-task-${randomUUID()}`
  const sessionRef = `r18-session-${randomUUID()}`
  store.insertKingdom({ kingdom_id: kingdomId, name: 'R18', created_at: at, owner_id: 'owner', owner_name: 'Owner' })
  store.insertBinding({
    binding_id: supervisorBindingId, kingdom_id: kingdomId, role_type: 'SUPERVISOR', role_name: 'R18 Supervisor',
    runtime_type: 'dsh', session_id: 'r18-supervisor-session', model_name: null, agent_name: null,
    session_meta: null, execution_profile_json: null, status: 'ACTIVE', retired_at: null, retired_reason: null,
    principal_id: null, created_at: at, updated_at: at,
  })
  store.insertBinding({
    binding_id: workerBindingId, kingdom_id: kingdomId, role_type: 'WORKER', role_name: 'R18 Worker',
    runtime_type: 'dsh', session_id: null, model_name: null, agent_name: null,
    session_meta: null, execution_profile_json: null, status: 'ACTIVE', retired_at: null, retired_reason: null,
    principal_id: null, created_at: at, updated_at: at,
  })
  store.insertTerritory({
    territory_id: territoryId, kingdom_id: kingdomId, name: 'R18 Territory', workspace_path: 'C:/r18',
    summary: null, supervisor_binding_id: supervisorBindingId, status: 'ACTIVE', deleted_at: null,
    deleted_reason: null, created_at: at,
  })
  store.insertTask({
    task_id: taskId, territory_id: territoryId, parent_task_id: null, title: 'R18 task', description: null,
    assigned_binding_id: workerBindingId, status: 'ASSIGNED', acceptance_criteria: 'R18', result_summary: null,
    created_at: at, updated_at: at,
  })
  store.insertTaskAssignment({
    assignment_id: `r18-assignment-${randomUUID()}`, task_id: taskId, territory_id: territoryId,
    worker_binding_id: workerBindingId, assigned_by: supervisorBindingId, assigned_at: at, ended_at: null,
    end_reason: null, previous_assignment_id: null, handoff_reason: null, created_at: at,
  })
  store.transitionTask(store.getTask(taskId)!, 'RUNNING')
  const session = { runtimeType: 'dsh', runtimeInstanceRef: 'r18-runtime', sessionRef }
  establishAffinity(store, { kingdomId, workerBindingId, session, territoryId })
  const lease = acquireExecutionLease(store, {
    kingdomId, workerBindingId, session, territoryId, taskId, attemptNo: 1,
  })
  setLeasePlan(store, lease.lease_id, JSON.stringify({ type: 'R18Plan/v1' }))
  advanceLeaseState(store, lease.lease_id, 'PREPARING')
  advanceLeaseState(store, lease.lease_id, 'MATERIALIZING')
  const decision = recordCapabilityDecision(store, {
    kingdomId, taskId, workerBindingId, supervisorBindingId, decision: 'GRANTED',
    enforcementStatus: 'ENFORCED', enforcementEvidenceJson: JSON.stringify({ type: 'R18Evidence/v1' }),
    requirementCoverage: 'FULL',
  })
  bindCapabilityDecision(store, lease.lease_id, decision.decision_id)
  advanceLeaseState(store, lease.lease_id, 'DISPATCH_READY')
  const prepared = prepareGovernedDispatch(store, {
    kingdomId, taskId, attemptNo: 1, workerBindingId, leaseId: lease.lease_id,
    capabilityDecisionId: decision.decision_id, session, requestSnapshot: JSON.stringify({ type: 'R18Request/v1' }),
    inputRefJson: JSON.stringify({ task: taskId }), payloadHash: 'r18-hash',
  })
  return { store, dispatchId: prepared.intent.dispatch_id, taskId, leaseId: lease.lease_id, sessionRef }
}

async function descriptorEndpoint(launch: RunnerContextBrokerLaunch): Promise<string> {
  const environment = launch.childEnvironment()
  const descriptor = join(
    environment.DSH_KINGDOM_BROKER_RENDEZVOUS_DIR,
    `${environment.DSH_KINGDOM_BROKER_LAUNCH_NONCE}.json`,
  )
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const parsed = JSON.parse(await readFile(descriptor, 'utf8')) as { endpoint?: unknown }
      if (typeof parsed.endpoint === 'string' && parsed.endpoint.length > 0) return parsed.endpoint
    } catch {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
  throw new Error('R18 test descriptor was not created')
}

async function descriptorForEnvironment(environment: RunnerContextBrokerEnvironment): Promise<RunnerContextBrokerDescriptor> {
  const descriptorPath = join(
    environment.DSH_KINGDOM_BROKER_RENDEZVOUS_DIR,
    `${environment.DSH_KINGDOM_BROKER_LAUNCH_NONCE}.json`,
  )
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return JSON.parse(await readFile(descriptorPath, 'utf8')) as RunnerContextBrokerDescriptor
    } catch {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
  throw new Error('R20 test descriptor was not created')
}

function runCrossRealmConsumer(
  bootstrap: RunnerContextBrokerEnvironment | {
    readonly environment: RunnerContextBrokerEnvironment
    readonly descriptor: RunnerContextBrokerDescriptor
  },
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  const entry = new URL('../lib/index.js', import.meta.url).href
  const script = `
    const { connectRunnerContextBroker } = await import(process.env.DSH_KINGDOM_BROKER_PUBLIC_ENTRY);
    const environment = JSON.parse(process.env.DSH_KINGDOM_BROKER_SERIALIZED_ENV);
    const client = await connectRunnerContextBroker(environment);
    try {
      process.stdout.write(JSON.stringify(await client.snapshot()));
    } finally {
      await client.close();
    }
  `
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      env: {
        ...process.env,
        DSH_KINGDOM_BROKER_PUBLIC_ENTRY: entry,
        DSH_KINGDOM_BROKER_SERIALIZED_ENV: JSON.stringify(bootstrap),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout, stderr }))
  })
}

function readRawFrame(socket: Socket): Promise<Record<string, unknown>> {
  let buffer = Buffer.alloc(0)
  return new Promise((resolveFrame, rejectFrame) => {
    const cleanup = (): void => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const onError = (error: Error): void => { cleanup(); rejectFrame(error) }
    const onClose = (): void => { cleanup(); rejectFrame(new Error('raw broker socket closed before frame')) }
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      const newline = buffer.indexOf(0x0a)
      if (newline < 0) return
      const text = buffer.subarray(0, newline).toString('utf8')
      cleanup()
      const parsed = JSON.parse(text) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        rejectFrame(new Error('raw broker frame was not an object'))
        return
      }
      resolveFrame(parsed as Record<string, unknown>)
    }
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
  })
}

async function rawConnect(launch: RunnerContextBrokerLaunch): Promise<{ socket: Socket; hello: Record<string, unknown> }> {
  const endpoint = await descriptorEndpoint(launch)
  const socket = await new Promise<Socket>((resolveSocket, rejectSocket) => {
    const connection = createConnection(endpoint)
    const onError = (error: Error): void => {
      connection.destroy()
      rejectSocket(error)
    }
    connection.once('error', onError)
    connection.once('connect', () => {
      connection.off('error', onError)
      connection.setNoDelay(true)
      resolveSocket(connection)
    })
  })
  return { socket, hello: await readRawFrame(socket) }
}

function rawSend(socket: Socket, frame: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = readRawFrame(socket)
  socket.write(`${JSON.stringify(frame)}\n`, 'utf8')
  return response
}

function waitForClose(socket: Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve()
  return new Promise(resolveClosed => {
    const done = (): void => {
      socket.off('close', done)
      socket.off('error', done)
      resolveClosed()
    }
    socket.once('close', done)
    socket.once('error', done)
  })
}

async function closeAfterRawFrame(socket: Socket, frame: string | Record<string, unknown>): Promise<void> {
  const closed = waitForClose(socket)
  socket.write(typeof frame === 'string' ? frame : `${JSON.stringify(frame)}\n`, 'utf8')
  await closed
}

async function withBrokerLaunch(run: (launch: RunnerContextBrokerLaunch) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-kingdom-r18-wire-'))
  const launch = createRunnerContextBrokerLaunch({ runRoot: root })
  try {
    await run(launch)
  } finally {
    await launch.close()
    await rm(root, { recursive: true, force: true })
  }
}

async function authenticateRaw(
  launch: RunnerContextBrokerLaunch,
): Promise<{ socket: Socket; hello: Record<string, unknown>; ready: Record<string, unknown> }> {
  const raw = await rawConnect(launch)
  const environment = launch.childEnvironment()
  const protocol = String(raw.hello.protocol)
  const serverInstance = String(raw.hello.serverInstance)
  const challenge = String(raw.hello.challenge)
  const clientNonce = `r18-client-${randomUUID()}`
  const proof = createHmac('sha256', environment.DSH_KINGDOM_BROKER_LAUNCH_NONCE)
    .update(`${protocol}|${serverInstance}|${challenge}|${clientNonce}`, 'utf8')
    .digest('base64url')
  const ready = await rawSend(raw.socket, { type: 'client.auth', clientNonce, proof })
  return { ...raw, ready }
}

test('R20 serialized cross-realm consumer connects to the existing Product broker and rejects tamper/stale/foreign bootstrap', async () => {
  const fixture = makeFixture()
  const root = await mkdtemp(join(tmpdir(), 'dsh-kingdom-r20-cross-realm-'))
  const launch = createRunnerContextBrokerLaunch({ runRoot: root })
  const port = createRunnerContextPort(fixture.store, { dispatchId: fixture.dispatchId })
  registerRunnerContextBrokerContext(launch, port)
  const environment = launch.childEnvironment()
  const descriptorPath = join(
    environment.DSH_KINGDOM_BROKER_RENDEZVOUS_DIR,
    `${environment.DSH_KINGDOM_BROKER_LAUNCH_NONCE}.json`,
  )
  try {
    const descriptor = await descriptorForEnvironment(environment)
    const serializedEnvironment = JSON.parse(JSON.stringify(environment)) as RunnerContextBrokerEnvironment
    const serializedBootstrap = JSON.parse(JSON.stringify({ environment, descriptor })) as {
      readonly environment: RunnerContextBrokerEnvironment
      readonly descriptor: RunnerContextBrokerDescriptor
    }

    await assert.rejects(
      () => connectRunnerContextBroker({ ...serializedEnvironment, unexpected: true } as never),
      /INVALID_BOOTSTRAP/u,
      'connector must reject environment fields outside the product-issued allowlist',
    )
    await assert.rejects(
      () => connectFromRoot({
        ...serializedBootstrap,
        descriptor: { ...descriptor, endpoint: `${descriptor.endpoint}-foreign` },
      }),
      /FOREIGN_DESCRIPTOR|INVALID_DESCRIPTOR/u,
      'connector must reject a foreign serialized descriptor before socket auth',
    )

    const originalDescriptor = await readFile(descriptorPath, 'utf8')
    await writeFile(descriptorPath, `${JSON.stringify({ ...descriptor, endpoint: `${descriptor.endpoint}-tampered` })}\n`, 'utf8')
    await assert.rejects(
      () => connectFromRoot(serializedEnvironment),
      /FOREIGN_DESCRIPTOR|INVALID_DESCRIPTOR/u,
      'connector must reject a tampered Product descriptor',
    )
    await writeFile(descriptorPath, originalDescriptor, 'utf8')

    const child = await runCrossRealmConsumer(serializedBootstrap)
    assert.equal(child.code, 0, child.stderr)
    const view = JSON.parse(child.stdout) as { phase?: string; dispatchState?: string; executionState?: string }
    assert.equal(view.phase, 'ACQUIRED', 'child must read the already registered Product context')
    assert.equal(view.dispatchState, 'INTENDED')
    assert.equal(view.executionState, 'STARTING')

    await launch.close()
    await assert.rejects(
      () => connectFromRoot(serializedEnvironment),
      /RENDEZVOUS_NOT_FOUND|UNSAFE_RENDEZVOUS|STALE_RENDEZVOUS/u,
      'serialized environment must not reconnect after Product-owned descriptor removal',
    )
  } finally {
    await launch.close()
    fixture.store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('R18 public broker exposes only bootstrap/connect/close and bounded no-ID view', async () => {
  const fixture = makeFixture()
  const root = await mkdtemp(join(tmpdir(), 'dsh-kingdom-r18-broker-'))
  const launch = createRunnerContextBrokerLaunch({ runRoot: root })
  try {
    assert.deepEqual(Object.keys(launch).sort(), ['childEnvironment', 'close', 'connect'])
    const environment = launch.childEnvironment()
    assert.deepEqual(Object.keys(environment).sort(), [
      'DSH_KINGDOM_BROKER_LAUNCH_NONCE',
      'DSH_KINGDOM_BROKER_RENDEZVOUS_DIR',
      'DSH_KINGDOM_BROKER_REQUIRED',
    ])
    assert.equal(environment.DSH_KINGDOM_BROKER_REQUIRED, '1')

    const port = createRunnerContextPort(fixture.store, { dispatchId: fixture.dispatchId })
    registerRunnerContextBrokerContext(launch, port)
    assert.equal(port.currentPhase, 'ACQUIRED', 'TX-3 register must acquire before Runtime dispatch')

    const client = await launch.connect()
    try {
      assert.deepEqual(Object.keys(client).sort(), ['close', 'observe', 'read', 'snapshot', 'wait'])
      const view = await client.snapshot()
      assert.equal(view.phase, 'ACQUIRED')
      assert.equal(view.dispatchState, 'INTENDED')
      assert.equal(view.receiptObserved, false)
      const serialized = JSON.stringify(view)
      for (const forbidden of [fixture.taskId, fixture.dispatchId, fixture.leaseId, fixture.sessionRef, 'provider', 'prompt']) {
        assert.equal(serialized.includes(forbidden), false, `wire view must not expose ${forbidden}`)
      }
      const firstInFlightRead = client.read()
      await assert.rejects(
        () => client.wait(),
        /IN_FLIGHT/u,
        'one authenticated ticket must reject a concurrent second request',
      )
      await firstInFlightRead
      const beforeRead = port.currentPhase
      await client.read()
      await client.wait()
      assert.equal(port.currentPhase, beforeRead, 'broker reads must not consume Product version')
      assert.deepEqual(await client.observe({ phase: 'ACQUIRED', terminalObserved: false }), { accepted: true })

      await assert.rejects(
        () => launch.connect(),
        /SECOND_CONNECTION|DISCONNECTED|ECONNRESET|EPIPE/u,
        'second authenticated socket must be rejected',
      )
      await client.close()
      assert.throws(
        () => registerRunnerContextBrokerContext(launch, port),
        /SECOND_CONTEXT/u,
        'a revoked ticket cannot be replaced inside the same Product epoch',
      )
    } finally {
      await launch.close()
    }
  } finally {
    fixture.store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('R18 wire auth, NDJSON bounds, timeout, half-close, and control data fail closed', async () => {
  await withBrokerLaunch(async launch => {
    const tooManyFields: Record<string, unknown> = { type: 'client.auth', clientNonce: 'c', proof: 'bad' }
    for (let index = 0; index < 16; index++) tooManyFields[`extra${index}`] = index
    const invalidFrames: Array<string | Record<string, unknown>> = [
      { type: 'client.auth', clientNonce: 'c', proof: 'bad' },
      { type: 'unknown.method' },
      { type: 'client.auth', clientNonce: 'c', proof: 'bad', unexpected: true },
      tooManyFields,
      { type: 'client.auth', clientNonce: 'c', proof: 'bad', nested: { a: { b: { c: { d: { e: 1 } } } } } },
      { type: 'client.auth', clientNonce: 'bad\u0000nonce', proof: 'bad' },
      Buffer.alloc(16 * 1024 + 1, 'x').toString('utf8'),
    ]
    for (const frame of invalidFrames) {
      const raw = await rawConnect(launch)
      await closeAfterRawFrame(raw.socket, frame)
    }

    const halfClosed = await rawConnect(launch)
    halfClosed.socket.end()
    await waitForClose(halfClosed.socket)

    const timeoutSocket = await rawConnect(launch)
    await new Promise(resolve => setTimeout(resolve, 5_200))
    await waitForClose(timeoutSocket.socket)
  })
})

test('R18 exact request replay is cached, mismatched replay/stale revision/foreign ticket do zero Product action', async () => {
  const fixture = makeFixture()
  const root = await mkdtemp(join(tmpdir(), 'dsh-kingdom-r18-replay-'))
  const launch = createRunnerContextBrokerLaunch({ runRoot: root })
  const port = createRunnerContextPort(fixture.store, { dispatchId: fixture.dispatchId })
  registerRunnerContextBrokerContext(launch, port)
  try {
    const authenticated = await authenticateRaw(launch)
    const ticket = String(authenticated.ready.ticket)
    const first = await rawSend(authenticated.socket, {
      type: 'context.snapshot', requestId: 'same-request', ticket, revision: 0,
    })
    const replay = await rawSend(authenticated.socket, {
      type: 'context.snapshot', requestId: 'same-request', ticket, revision: 0,
    })
    assert.deepEqual(replay, first, 'exact requestId+payload must return the cached response')

    await closeAfterRawFrame(authenticated.socket, {
      type: 'context.snapshot', requestId: 'same-request', ticket, revision: 1,
    })
  } finally {
    await launch.close()
    fixture.store.close()
    await rm(root, { recursive: true, force: true })
  }

  const foreignFixture = makeFixture()
  const foreignRoot = await mkdtemp(join(tmpdir(), 'dsh-kingdom-r18-foreign-ticket-'))
  const foreignLaunch = createRunnerContextBrokerLaunch({ runRoot: foreignRoot })
  const foreignPort = createRunnerContextPort(foreignFixture.store, { dispatchId: foreignFixture.dispatchId })
  registerRunnerContextBrokerContext(foreignLaunch, foreignPort)
  try {
    const authenticated = await authenticateRaw(foreignLaunch)
    const ticket = String(authenticated.ready.ticket)
    await closeAfterRawFrame(authenticated.socket, {
      type: 'context.read', requestId: 'foreign-ticket', ticket: `${ticket}-foreign`, revision: 0,
    })
  } finally {
    await foreignLaunch.close()
    foreignFixture.store.close()
    await rm(foreignRoot, { recursive: true, force: true })
  }

  const missingFixture = makeFixture()
  const missingRoot = await mkdtemp(join(tmpdir(), 'dsh-kingdom-r18-missing-revision-'))
  const missingLaunch = createRunnerContextBrokerLaunch({ runRoot: missingRoot })
  const missingPort = createRunnerContextPort(missingFixture.store, { dispatchId: missingFixture.dispatchId })
  registerRunnerContextBrokerContext(missingLaunch, missingPort)
  try {
    const authenticated = await authenticateRaw(missingLaunch)
    await closeAfterRawFrame(authenticated.socket, {
      type: 'context.read', requestId: 'missing-revision', ticket: String(authenticated.ready.ticket),
    })
  } finally {
    await missingLaunch.close()
    missingFixture.store.close()
    await rm(missingRoot, { recursive: true, force: true })
  }

  const staleFixture = makeFixture()
  const staleRoot = await mkdtemp(join(tmpdir(), 'dsh-kingdom-r18-stale-'))
  const staleLaunch = createRunnerContextBrokerLaunch({ runRoot: staleRoot })
  const stalePort = createRunnerContextPort(staleFixture.store, { dispatchId: staleFixture.dispatchId })
  registerRunnerContextBrokerContext(staleLaunch, stalePort)
  try {
    const authenticated = await authenticateRaw(staleLaunch)
    const ticket = String(authenticated.ready.ticket)
    await closeAfterRawFrame(authenticated.socket, {
      type: 'context.snapshot', requestId: 'stale-revision', ticket, revision: 99,
    })
  } finally {
    await staleLaunch.close()
    staleFixture.store.close()
    await rm(staleRoot, { recursive: true, force: true })
  }
})

test('R18 forbidden DTO canaries, copied ticket, and second authenticated connection are rejected', async () => {
  const fixture = makeFixture()
  const root = await mkdtemp(join(tmpdir(), 'dsh-kingdom-r18-dto-'))
  const launch = createRunnerContextBrokerLaunch({ runRoot: root })
  const port = createRunnerContextPort(fixture.store, { dispatchId: fixture.dispatchId })
  registerRunnerContextBrokerContext(launch, port)
  try {
    const authenticated = await authenticateRaw(launch)
    const ticket = String(authenticated.ready.ticket)
    await assert.rejects(
      () => authenticateRaw(launch),
      /closed|disconnected|ECONNRESET|EPIPE/u,
      'second authenticated connection must not receive a copied ticket or a new epoch',
    )
    await closeAfterRawFrame(authenticated.socket, {
      type: 'runtime.observe',
      requestId: 'forbidden-canary',
      ticket,
      revision: 0,
      observation: { phase: fixture.taskId, evidence: 'secret', stack: 'raw error' },
    })
  } finally {
    await launch.close()
    fixture.store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('R18 Product epoch activation is single-owner', async () => {
  const firstRoot = await mkdtemp(join(tmpdir(), 'dsh-kingdom-r18-epoch-a-'))
  const secondRoot = await mkdtemp(join(tmpdir(), 'dsh-kingdom-r18-epoch-b-'))
  const first = createRunnerContextBrokerLaunch({ runRoot: firstRoot })
  const second = createRunnerContextBrokerLaunch({ runRoot: secondRoot })
  try {
    activateRunnerContextBrokerLaunch(first)
    assert.throws(
      () => activateRunnerContextBrokerLaunch(second),
      /SECOND_EPOCH/u,
      'a second Product broker epoch must not replace the active launch',
    )
    deactivateRunnerContextBrokerLaunch(first)
    activateRunnerContextBrokerLaunch(second)
  } finally {
    deactivateRunnerContextBrokerLaunch(first)
    deactivateRunnerContextBrokerLaunch(second)
    await first.close()
    await second.close()
    await rm(firstRoot, { recursive: true, force: true })
    await rm(secondRoot, { recursive: true, force: true })
  }
})
