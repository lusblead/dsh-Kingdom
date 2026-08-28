/** R11 product-side Runner context port regressions. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { KingdomStore } from '../lib/core/db.js'
import {
  acquireExecutionLease,
  advanceLeaseState,
  bindCapabilityDecision,
  correlateRuntimeExecution,
  createRunnerContextPort,
  establishAffinity,
  prepareGovernedDispatch,
  recordCapabilityDecision,
  recordDispatchReceipt,
  recordTerminalEvidence,
  setLeasePlan,
  type RunnerContextHandle,
  type RunnerContextVersion,
} from '../lib/core/governed.js'
import { settleAndRelease, type CleanupReceipt } from '../lib/dispatch/service.js'
import { DshRuntimeAdapter } from '../lib/adapter/dsh-backend.js'

const now = (): string => new Date().toISOString()

const confirmedCleanup = (): CleanupReceipt => ({
  status: 'CONFIRMED',
  evidenceJson: JSON.stringify({ type: 'R11CleanupEvidence/v1', payload: { confirmed: true } }),
  reason: 'R11 cleanup confirmed',
})

const returnedFalse = (): CleanupReceipt => ({
  status: 'RETURNED_FALSE',
  evidenceJson: null,
  reason: 'R11 cleanup returned false',
})

interface Fixture {
  store: KingdomStore
  kingdomId: string
  taskId: string
  workerBindingId: string
  territoryId: string
  leaseId: string
  dispatchId: string
  executionId: string
  sessionRef: string
  runtimeDispatchRef: string
}

function makeFixture(): Fixture {
  const store = new KingdomStore(':memory:')
  const kingdomId = `r11-kingdom-${randomUUID()}`
  const supervisorBindingId = `r11-supervisor-${randomUUID()}`
  const workerBindingId = `r11-worker-${randomUUID()}`
  const territoryId = `r11-territory-${randomUUID()}`
  const taskId = `r11-task-${randomUUID()}`
  const sessionRef = `r11-session-${randomUUID()}`
  const runtimeDispatchRef = `r11-runtime-dispatch-${randomUUID()}`
  const attemptNo = 1
  const at = now()

  store.insertKingdom({
    kingdom_id: kingdomId,
    name: 'R11',
    created_at: at,
    owner_id: 'owner',
    owner_name: 'Owner',
  })
  for (const row of [
    {
      binding_id: supervisorBindingId,
      role_type: 'SUPERVISOR',
      role_name: 'R11 Supervisor',
      session_id: 'r11-supervisor-session',
    },
    {
      binding_id: workerBindingId,
      role_type: 'WORKER',
      role_name: 'R11 Worker',
      session_id: null,
    },
  ] as const) {
    store.insertBinding({
      binding_id: row.binding_id,
      kingdom_id: kingdomId,
      role_type: row.role_type,
      role_name: row.role_name,
      runtime_type: 'dsh',
      session_id: row.session_id,
      model_name: null,
      agent_name: null,
      session_meta: null,
      execution_profile_json: null,
      status: 'ACTIVE',
      retired_at: null,
      retired_reason: null,
      principal_id: null,
      created_at: at,
      updated_at: at,
    })
  }
  store.insertTerritory({
    territory_id: territoryId,
    kingdom_id: kingdomId,
    name: 'R11 Territory',
    workspace_path: 'C:/r11',
    summary: null,
    supervisor_binding_id: supervisorBindingId,
    status: 'ACTIVE',
    deleted_at: null,
    deleted_reason: null,
    created_at: at,
  })
  store.insertTask({
    task_id: taskId,
    territory_id: territoryId,
    parent_task_id: null,
    title: 'R11 task',
    description: null,
    assigned_binding_id: workerBindingId,
    status: 'ASSIGNED',
    acceptance_criteria: 'R11',
    result_summary: null,
    created_at: at,
    updated_at: at,
  })
  store.insertTaskAssignment({
    assignment_id: `r11-assignment-${randomUUID()}`,
    task_id: taskId,
    territory_id: territoryId,
    worker_binding_id: workerBindingId,
    assigned_by: supervisorBindingId,
    assigned_at: at,
    ended_at: null,
    end_reason: null,
    previous_assignment_id: null,
    handoff_reason: null,
    created_at: at,
  })
  store.transitionTask(store.getTask(taskId)!, 'RUNNING')

  const session = { runtimeType: 'dsh', runtimeInstanceRef: 'r11-runtime', sessionRef }
  establishAffinity(store, { kingdomId, workerBindingId, session, territoryId })
  const lease = acquireExecutionLease(store, {
    kingdomId,
    workerBindingId,
    session,
    territoryId,
    taskId,
    attemptNo,
  })
  setLeasePlan(store, lease.lease_id, JSON.stringify({ type: 'R11Plan/v1' }))
  advanceLeaseState(store, lease.lease_id, 'PREPARING')
  advanceLeaseState(store, lease.lease_id, 'MATERIALIZING')
  const decision = recordCapabilityDecision(store, {
    kingdomId,
    taskId,
    workerBindingId,
    supervisorBindingId,
    decision: 'GRANTED',
    enforcementStatus: 'ENFORCED',
    enforcementEvidenceJson: JSON.stringify({ type: 'R11EnforcementEvidence/v1' }),
    requirementCoverage: 'FULL',
  })
  bindCapabilityDecision(store, lease.lease_id, decision.decision_id)
  advanceLeaseState(store, lease.lease_id, 'DISPATCH_READY')
  const prepared = prepareGovernedDispatch(store, {
    kingdomId,
    taskId,
    attemptNo,
    workerBindingId,
    leaseId: lease.lease_id,
    capabilityDecisionId: decision.decision_id,
    session,
    requestSnapshot: JSON.stringify({ type: 'R11Request/v1' }),
    inputRefJson: JSON.stringify({ task: taskId }),
    payloadHash: 'r11-hash',
  })
  return {
    store,
    kingdomId,
    taskId,
    workerBindingId,
    territoryId,
    leaseId: lease.lease_id,
    dispatchId: prepared.intent.dispatch_id,
    executionId: prepared.execution.execution_id,
    sessionRef,
    runtimeDispatchRef,
  }
}

function makeAdapter(fixture: Fixture): DshRuntimeAdapter {
  const session = { header: { cwd: 'C:/r11' }, events: [] as { type: string; data?: Record<string, unknown> }[] }
  const agent = {
    id: fixture.sessionRef,
    status: 'idle' as const,
    session,
    followup: (_message: { id: string }): void => {},
    runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return job(new AbortController().signal)
    },
  }
  const agents = new Map([[fixture.sessionRef, agent]])
  return new DshRuntimeAdapter({
    runtimeInstanceRef: 'r11-runtime',
    provider: 'spawn',
    model: null,
    agents: {
      agents,
      create: async () => { throw new Error('unused') },
      resume: async () => { throw new Error('unused') },
      get: (id: string) => agents.get(id),
      list: () => [...agents.values()],
    },
  })
}

function makeTerminal(fixture: Fixture): void {
  const received = recordDispatchReceipt(fixture.store, fixture.dispatchId, {
    runtimeDispatchRef: fixture.runtimeDispatchRef,
    receiptJson: JSON.stringify({ type: 'R11Receipt/v1' }),
  })
  const correlated = correlateRuntimeExecution(fixture.store, received.dispatch_id, 'r11-turn-1')
  const running = fixture.store.getExecution(fixture.executionId)
  assert.ok(running)
  fixture.store.transitionExecution(running, 'RUNNING')
  const terminal = recordTerminalEvidence(fixture.store, correlated.dispatch_id, {
    evidenceJson: JSON.stringify({ type: 'R11Terminal/v1', outcome: 'COMPLETED' }),
    executionTerminalState: 'COMPLETED',
    settleLease: true,
  })
  assert.equal(terminal.dispatch.state, 'TERMINAL')
  assert.equal(terminal.execution?.state, 'COMPLETED')
  assert.equal(terminal.lease?.state, 'SETTLING')
}

function patchRowGetter(
  store: KingdomStore,
  method: 'getTask' | 'getExecution' | 'getLease',
  mutate: (row: Record<string, unknown>) => Record<string, unknown>,
): () => void {
  const target = store as unknown as Record<string, (id: string) => unknown>
  const original = target[method]
  target[method] = (id: string) => {
    const row = original.call(store, id)
    return row && typeof row === 'object' ? mutate(row as Record<string, unknown>) : row
  }
  return () => { target[method] = original }
}

test('R11 RunnerContext happy path consumes one handle through acquire/receipt/terminal/settle', async () => {
  const fixture = makeFixture()
  try {
    const port = createRunnerContextPort(fixture.store, { dispatchId: fixture.dispatchId })
    const acquired = port.acquire(port.handle, port.initialVersion)
    assert.equal(acquired.phase, 'ACQUIRED')

    const bound = port.bindRuntimeReceipt(
      port.handle,
      acquired.version,
      fixture.runtimeDispatchRef,
      () => recordDispatchReceipt(fixture.store, fixture.dispatchId, {
        runtimeDispatchRef: fixture.runtimeDispatchRef,
        receiptJson: JSON.stringify({ type: 'R11Receipt/v1' }),
      }),
    )
    assert.equal(bound.view.phase, 'BOUND')

    const terminal = port.observeTerminal(port.handle, bound.view.version, () => {
      const correlated = correlateRuntimeExecution(fixture.store, fixture.dispatchId, 'r11-turn-1')
      const running = fixture.store.getExecution(fixture.executionId)
      assert.ok(running)
      fixture.store.transitionExecution(running, 'RUNNING')
      return recordTerminalEvidence(fixture.store, correlated.dispatch_id, {
        evidenceJson: JSON.stringify({ type: 'R11Terminal/v1', outcome: 'COMPLETED' }),
        executionTerminalState: 'COMPLETED',
        settleLease: true,
      })
    })
    assert.equal(terminal.view.phase, 'TERMINAL')

    const adapter = makeAdapter(fixture)
    const opened = await adapter.openTrustFence({
      leaseId: fixture.leaseId,
      sessionRef: fixture.sessionRef,
      runtimeDispatchRef: null,
      baselineEvents: [],
    })
    assert.equal(adapter.bindTrustFence(opened, fixture.runtimeDispatchRef, {
      leaseId: fixture.leaseId,
      sessionRef: fixture.sessionRef,
    }).ok, true)
    const settled = port.settle(port.handle, terminal.view.version, context => {
      assert.equal(context.handle, port.handle)
      assert.equal(context.version, terminal.view.version)
      return settleAndRelease(fixture.store, context.view.leaseId, confirmedCleanup(), 'R11 happy settle', {
        adapter,
        fence: opened,
        leaseId: context.view.leaseId,
        sessionRef: context.view.sessionRef,
      })
    })
    assert.equal(settled.value.state, 'RELEASED')
    assert.equal(settled.view.phase, 'RELEASED')
    assert.throws(
      () => port.read(port.handle, terminal.view.version),
      (error: unknown) => (error as { code?: string }).code === 'STALE_VERSION',
    )
    assert.throws(
      () => createRunnerContextPort(fixture.store, fixture.dispatchId),
      (error: unknown) => (error as { code?: string }).code === 'RELEASED',
    )
  } finally {
    fixture.store.close()
  }
})

test('R11 copied/foreign/stale handle and version fail closed before product action', () => {
  const fixture = makeFixture()
  const foreign = makeFixture()
  try {
    const port = createRunnerContextPort(fixture.store, fixture.dispatchId)
    const copiedHandle = Object.assign({}, port.handle) as unknown as RunnerContextHandle
    assert.throws(
      () => port.read(copiedHandle, port.initialVersion),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_HANDLE',
    )

    const versionPort = createRunnerContextPort(fixture.store, fixture.dispatchId)
    const copiedVersion = Object.assign({}, versionPort.initialVersion) as unknown as RunnerContextVersion
    assert.throws(
      () => versionPort.read(versionPort.handle, copiedVersion),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_VERSION',
    )

    const cross = createRunnerContextPort(foreign.store, foreign.dispatchId)
    assert.throws(
      () => cross.read(cross.handle, port.initialVersion),
      (error: unknown) => (error as { code?: string }).code === 'STALE_VERSION',
    )

    const stalePort = createRunnerContextPort(fixture.store, fixture.dispatchId)
    const staleVersion = stalePort.initialVersion
    fixture.store.appendEvent({
      event_id: randomUUID(),
      kingdom_id: fixture.kingdomId,
      event_type: 'R11_UNRELATED_VERSION_BUMP',
      actor_role: 'SYSTEM',
      actor_id: 'r11-test',
      target_type: 'task',
      target_id: fixture.taskId,
      payload_json: '{}',
      created_at: now(),
    })
    assert.throws(
      () => stalePort.read(stalePort.handle, staleVersion),
      (error: unknown) => (error as { code?: string }).code === 'STALE_VERSION',
    )
  } finally {
    fixture.store.close()
    foreign.store.close()
  }
})

test('R18 receipt and correlation are mutations of the same RunnerContext Port/version', () => {
  const fixture = makeFixture()
  try {
    const port = createRunnerContextPort(fixture.store, fixture.dispatchId)
    const acquired = port.acquire(port.handle, port.initialVersion)
    const bound = port.bindRuntimeReceipt(
      port.handle,
      acquired.version,
      fixture.runtimeDispatchRef,
      () => recordDispatchReceipt(fixture.store, fixture.dispatchId, {
        runtimeDispatchRef: fixture.runtimeDispatchRef,
        receiptJson: JSON.stringify({ type: 'R18Receipt/v1' }),
      }),
    )
    const correlated = port.correlateRuntimeExecution(
      port.handle,
      bound.view.version,
      'r18-turn-1',
      () => {
        const dispatch = correlateRuntimeExecution(fixture.store, fixture.dispatchId, 'r18-turn-1')
        const execution = fixture.store.getExecution(fixture.executionId)
        assert.ok(execution)
        const running = execution.state === 'STARTING'
          ? fixture.store.transitionExecution(execution, 'RUNNING')
          : execution
        return { dispatch, execution: running }
      },
    )
    assert.equal(correlated.value.dispatch.state, 'CORRELATED')
    assert.equal(correlated.value.execution.state, 'RUNNING')
    assert.equal(correlated.view.phase, 'BOUND')
    assert.equal(correlated.view.version.sequence, bound.view.version.sequence + 1)
  } finally {
    fixture.store.close()
  }
})

test('R11 public sequence tampering cannot mint a negative next version', () => {
  const fixture = makeFixture()
  try {
    const port = createRunnerContextPort(fixture.store, fixture.dispatchId)
    const initial = port.initialVersion
    assert.equal(initial.sequence, 0)

    // Deliberately shadow the public diagnostic projection. The product must
    // still advance from its module-private metadata record, not from -100.
    Object.defineProperty(initial, 'sequence', { configurable: true, value: -100 })
    const advanced = port.read(port.handle, initial)
    assert.equal(advanced.version.sequence, 1)
    assert.notEqual(advanced.version.sequence, -99)
  } finally {
    fixture.store.close()
  }
})

test('R11 wrong Task/attempt/Lease/Session and non-governed composite relations fail closed', () => {
  const cases: ReadonlyArray<{
    label: string
    method: 'getTask' | 'getExecution' | 'getLease'
    mutate: (row: Record<string, unknown>) => Record<string, unknown>
  }> = [
    {
      label: 'wrong task',
      method: 'getTask',
      mutate: row => ({ ...row, task_id: `${String(row.task_id)}-foreign` }),
    },
    {
      label: 'wrong attempt',
      method: 'getExecution',
      mutate: row => ({ ...row, attempt_no: Number(row.attempt_no) + 1 }),
    },
    {
      label: 'wrong lease',
      method: 'getLease',
      mutate: row => ({ ...row, lease_id: `${String(row.lease_id)}-foreign` }),
    },
    {
      label: 'wrong session',
      method: 'getLease',
      mutate: row => ({ ...row, session_ref: `${String(row.session_ref)}-foreign` }),
    },
    {
      label: 'non-governed execution contract',
      method: 'getExecution',
      mutate: row => ({ ...row, execution_contract: 'LEGACY_COMPAT' }),
    },
  ]

  for (const entry of cases) {
    const fixture = makeFixture()
    const restore = patchRowGetter(fixture.store, entry.method, entry.mutate)
    try {
      assert.throws(
        () => createRunnerContextPort(fixture.store, fixture.dispatchId),
        (error: unknown) => (error as { code?: string }).code === 'RELATION_MISMATCH',
        entry.label,
      )
    } finally {
      restore()
      fixture.store.close()
    }
  }
})

test('R11 wrong order, duplicate token, and recovery/released contexts cannot be reused', () => {
  const fixture = makeFixture()
  try {
    const port = createRunnerContextPort(fixture.store, fixture.dispatchId)
    const acquired = port.acquire(port.handle, port.initialVersion)
    assert.throws(
      () => port.observeTerminal(port.handle, acquired.version, () => undefined),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_ORDER',
    )

    const duplicatePort = createRunnerContextPort(fixture.store, fixture.dispatchId)
    const duplicateVersion = duplicatePort.initialVersion
    const first = duplicatePort.read(duplicatePort.handle, duplicateVersion)
    assert.throws(
      () => duplicatePort.read(duplicatePort.handle, duplicateVersion),
      (error: unknown) => (error as { code?: string }).code === 'STALE_VERSION',
    )
    assert.equal(first.phase, 'OPEN')
  } finally {
    fixture.store.close()
  }

  const recovering = makeFixture()
  try {
    makeTerminal(recovering)
    settleAndRelease(recovering.store, recovering.leaseId, returnedFalse(), 'R11 recovery')
    assert.throws(
      () => createRunnerContextPort(recovering.store, recovering.dispatchId),
      (error: unknown) => (error as { code?: string }).code === 'RECOVERING',
    )
  } finally {
    recovering.store.close()
  }
})
