/**
 * R8 TX-4 integrity regressions.
 *
 * These fixtures deliberately contain the complete post-TX-4 relation:
 * Dispatch=TERMINAL, Execution=COMPLETED, Lease=SETTLING, and a Worker Claim
 * with Task=REVIEW.  A Lease-only fixture cannot prove the integrity contract.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { KingdomStore } from '../lib/core/db.js'
import {
  acquireExecutionLease,
  advanceLeaseState,
  bindCapabilityDecision,
  correlateRuntimeExecution,
  establishAffinity,
  prepareGovernedDispatch,
  recordCapabilityDecision,
  recordDispatchReceipt,
  recordDispatchTerminalIntegrityIncident,
  recordTerminalEvidence,
  setLeasePlan,
} from '../lib/core/governed.js'
import { reviewTask } from '../lib/core/task-service.js'
import { settleAndRelease, type CleanupReceipt } from '../lib/dispatch/service.js'
import { DshRuntimeAdapter } from '../lib/adapter/dsh-backend.js'

const now = (): string => new Date().toISOString()

const confirmedCleanup = (): CleanupReceipt => ({
  status: 'CONFIRMED',
  evidenceJson: JSON.stringify({ type: 'DshEnforcementTeardownEvidence/v1', payload: { r8: true } }),
  reason: 'R8 test cleanup confirmed',
})

const failedCleanup = (status: 'RETURNED_FALSE' | 'THREW' | 'MISSING_EVIDENCE'): CleanupReceipt => ({
  status,
  evidenceJson: null,
  reason: `R8 test cleanup ${status.toLowerCase()}`,
})

interface CompleteFixture {
  store: KingdomStore
  kingdomId: string
  supervisorBindingId: string
  supervisorSession: string
  workerBindingId: string
  territoryId: string
  taskId: string
  leaseId: string
  dispatchId: string
  executionId: string
  attemptNo: number
}

/** Build the exact post-TX-4 relation and a Claim awaiting Supervisor review. */
function makeCompleteFixture(sessionRef = `worker-session-${randomUUID()}`): CompleteFixture {
  const store = new KingdomStore(':memory:')
  const kingdomId = `kingdom-r8-${randomUUID()}`
  const supervisorBindingId = `supervisor-${randomUUID()}`
  const supervisorSession = `supervisor-session-${randomUUID()}`
  const workerBindingId = `worker-${randomUUID()}`
  const territoryId = `territory-${randomUUID()}`
  const taskId = `task-${randomUUID()}`
  const attemptNo = 1
  const at = now()

  store.insertKingdom({ kingdom_id: kingdomId, name: 'R8', created_at: at, owner_id: 'owner', owner_name: 'Owner' })
  store.insertBinding({
    binding_id: supervisorBindingId,
    kingdom_id: kingdomId,
    role_type: 'SUPERVISOR',
    role_name: 'R8 Supervisor',
    runtime_type: 'dsh',
    session_id: supervisorSession,
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
  store.insertBinding({
    binding_id: workerBindingId,
    kingdom_id: kingdomId,
    role_type: 'WORKER',
    role_name: 'R8 Worker',
    runtime_type: 'dsh',
    session_id: null,
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
  store.insertTerritory({
    territory_id: territoryId,
    kingdom_id: kingdomId,
    name: 'R8 Territory',
    workspace_path: 'C:/r8',
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
    title: 'R8 integrity task',
    description: null,
    assigned_binding_id: workerBindingId,
    status: 'ASSIGNED',
    acceptance_criteria: 'R8',
    result_summary: null,
    created_at: at,
    updated_at: at,
  })
  store.insertTaskAssignment({
    assignment_id: `assignment-${randomUUID()}`,
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
  const assignedTask = store.getTask(taskId)
  assert.ok(assignedTask)
  // The public governed start path moves ASSIGNED → RUNNING before TX-3;
  // only RUNNING can later become REVIEW after the terminal Claim.
  store.transitionTask(assignedTask, 'RUNNING')

  const session = { runtimeType: 'dsh', runtimeInstanceRef: 'r8-instance', sessionRef }
  establishAffinity(store, { kingdomId, workerBindingId, session, territoryId })
  const lease = acquireExecutionLease(store, {
    // The helper below is intentionally expanded rather than using a bounded
    // test-only Lease row: the affinity and Task/territory relation are part
    // of the post-TX-4 proof.
    store,
    kingdomId,
    workerBindingId,
    session,
    territoryId,
    taskId,
    attemptNo,
  })
  setLeasePlan(store, lease.lease_id, JSON.stringify({ type: 'R8Plan/v1' }))
  advanceLeaseState(store, lease.lease_id, 'PREPARING')
  advanceLeaseState(store, lease.lease_id, 'MATERIALIZING')
  const decision = recordCapabilityDecision(store, {
    kingdomId,
    taskId,
    workerBindingId,
    supervisorBindingId,
    decision: 'GRANTED',
    enforcementStatus: 'ENFORCED',
    enforcementEvidenceJson: JSON.stringify({ type: 'DshEnforcementEvidence/v1', payload: { r8: true } }),
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
    requestSnapshot: JSON.stringify({ type: 'R8Request/v1' }),
    inputRefJson: JSON.stringify({ ref: 'r8' }),
    payloadHash: 'r8-integrity-hash',
  })
  const received = recordDispatchReceipt(store, prepared.intent.dispatch_id, {
    runtimeDispatchRef: 'r8-runtime-message',
    receiptJson: JSON.stringify({ type: 'DispatchReceipt/v1', r8: true }),
  })
  const correlated = correlateRuntimeExecution(store, received.dispatch_id, 'r8-turn-1')
  const running = store.getExecution(prepared.execution.execution_id)
  assert.ok(running)
  store.transitionExecution(running, 'RUNNING')
  const terminal = recordTerminalEvidence(store, correlated.dispatch_id, {
    evidenceJson: JSON.stringify({ type: 'DshTerminalEvidence/v1', payload: { outcome: 'COMPLETED', r8: true } }),
    executionTerminalState: 'COMPLETED',
    settleLease: true,
  })
  assert.equal(terminal.dispatch.state, 'TERMINAL')
  assert.equal(terminal.execution?.state, 'COMPLETED')
  assert.equal(terminal.lease?.state, 'SETTLING')

  store.insertWorkerResult({
    result_id: `claim-${randomUUID()}`,
    task_id: taskId,
    attempt_no: attemptNo,
    worker_binding_id: workerBindingId,
    session_id: sessionRef,
    outcome: 'COMPLETED',
    result_json: JSON.stringify({ summary: 'R8 Claim' }),
    created_at: now(),
  })
  const reviewTaskRow = store.getTask(taskId)
  assert.ok(reviewTaskRow)
  store.transitionTask(reviewTaskRow, 'REVIEW', { result_summary: 'R8 Claim' })

  return {
    store,
    kingdomId,
    supervisorBindingId,
    supervisorSession,
    workerBindingId,
    territoryId,
    taskId,
    leaseId: lease.lease_id,
    dispatchId: prepared.intent.dispatch_id,
    executionId: prepared.execution.execution_id,
    attemptNo,
  }
}

function makeFenceAdapter(sessionRef: string, runtimeInstanceRef: string): {
  adapter: DshRuntimeAdapter
  session: { header: { cwd: string }; events: { type: string; data?: Record<string, unknown> }[] }
} {
  const session = { header: { cwd: 'C:/r8' }, events: [] as { type: string; data?: Record<string, unknown> }[] }
  const agent = {
    id: sessionRef,
    status: 'idle' as const,
    session,
    followup: (_message: { id: string }): void => {},
    runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return job(new AbortController().signal)
    },
  }
  const agents = new Map([[sessionRef, agent]])
  return {
    adapter: new DshRuntimeAdapter({
      runtimeInstanceRef,
      provider: 'spawn',
      model: null,
      agents: {
        agents,
        create: async () => { throw new Error('unused') },
        resume: async () => { throw new Error('unused') },
        get: (id: string) => agents.get(id),
        list: () => [...agents.values()],
      },
    }),
    session,
  }
}

const incidentEvents = (fixture: CompleteFixture) => fixture.store
  .listEvents(fixture.kingdomId, 1000)
  .filter(event => event.event_type === 'DISPATCH_TERMINAL_INTEGRITY_INCIDENT')

test('R8 post-TX-4 incident uses full relation, recovers only Lease, and replays idempotently', () => {
  const fixture = makeCompleteFixture()
  try {
    const before = fixture.store.listEvents(fixture.kingdomId, 1000).length
    const first = recordDispatchTerminalIntegrityIncident(fixture.store, {
      dispatchId: fixture.dispatchId,
      reasonCode: 'TRUST_FENCE_EXPECTATION_MISMATCH',
      phase: 'settlement',
    })
    assert.equal(first.incidentCreated, true)
    assert.equal(first.escalated, false)
    assert.equal(first.dispatch.state, 'TERMINAL')
    assert.equal(first.execution.state, 'COMPLETED')
    assert.equal(first.lease.state, 'RECOVERING')
    assert.equal(incidentEvents(fixture).length, 1)
    const incidentPayload = JSON.parse(first.incident.payload_json) as Record<string, unknown>
    assert.equal(incidentPayload.incident_code, 'DISPATCH_TERMINAL_INTEGRITY_INCIDENT')
    assert.equal(incidentPayload.attempt_no, fixture.attemptNo)
    assert.equal(incidentPayload.relation, 'exact-dispatch-task-attempt')
    assert.equal('task_id' in incidentPayload, false, 'incident payload must not expose raw Task id')
    assert.equal('lease_id' in incidentPayload, false, 'incident payload must not expose raw Lease id')
    assert.equal('execution_id' in incidentPayload, false, 'incident payload must not expose raw Execution id')
    assert.ok(first.incident.payload_json.length <= 512, 'incident payload must remain bounded')

    const eventCount = fixture.store.listEvents(fixture.kingdomId, 1000).length
    const replay = recordDispatchTerminalIntegrityIncident(fixture.store, {
      dispatchId: fixture.dispatchId,
      reasonCode: 'TRUST_FENCE_EXPECTATION_MISMATCH',
      phase: 'settlement',
    })
    assert.equal(replay.incidentCreated, false)
    assert.equal(replay.dispatch.state, 'TERMINAL')
    assert.equal(replay.execution.state, 'COMPLETED')
    assert.equal(replay.lease.state, 'RECOVERING')
    assert.equal(fixture.store.listEvents(fixture.kingdomId, 1000).length, eventCount,
      'incident replay must not append a duplicate event')
    assert.ok(eventCount > before)
  } finally {
    fixture.store.close()
  }
})

test('R8 settlement cross-Adapter/cross-Lease/cross-Session all fail closed on a complete terminal fixture', async () => {
  const cases: Array<{ name: string; run(): Promise<void> }> = []

  cases.push({
    name: 'cross-adapter',
    async run() {
      const fixture = makeCompleteFixture('r8-cross-adapter')
      try {
        const source = makeFenceAdapter('r8-cross-adapter', 'r8-source-adapter')
        const other = makeFenceAdapter('r8-cross-adapter', 'r8-other-adapter')
        const fence = await source.adapter.openTrustFence({
          leaseId: fixture.leaseId,
          sessionRef: 'r8-cross-adapter',
          runtimeDispatchRef: null,
          baselineEvents: source.session.events,
        })
        const recovered = settleAndRelease(fixture.store, fixture.leaseId, confirmedCleanup(), 'cross-adapter', {
          adapter: other.adapter,
          fence,
          leaseId: fixture.leaseId,
          sessionRef: 'r8-cross-adapter',
        })
        assert.equal(recovered.state, 'RECOVERING', `${cases[0]?.name ?? 'cross-adapter'} target lease`)
        assert.equal(fixture.store.getDispatch(fixture.dispatchId)?.state, 'TERMINAL')
        assert.equal(fixture.store.getExecution(fixture.executionId)?.state, 'COMPLETED')
        assert.equal(incidentEvents(fixture).length, 1)
        const events = fixture.store.listEvents(fixture.kingdomId, 1000).length
        settleAndRelease(fixture.store, fixture.leaseId, confirmedCleanup(), 'cross-adapter replay', {
          adapter: other.adapter,
          fence,
          leaseId: fixture.leaseId,
          sessionRef: 'r8-cross-adapter',
        })
        assert.equal(fixture.store.listEvents(fixture.kingdomId, 1000).length, events)
      } finally {
        fixture.store.close()
      }
    },
  })

  cases.push({
    name: 'cross-lease',
    async run() {
      const source = makeCompleteFixture('r8-cross-lease-source')
      const target = makeCompleteFixture('r8-cross-lease-target')
      try {
        const sourceRuntime = makeFenceAdapter('r8-cross-lease-source', 'r8-cross-lease-instance')
        const fence = await sourceRuntime.adapter.openTrustFence({
          leaseId: source.leaseId,
          sessionRef: 'r8-cross-lease-source',
          runtimeDispatchRef: null,
          baselineEvents: sourceRuntime.session.events,
        })
        const recovered = settleAndRelease(target.store, target.leaseId, confirmedCleanup(), 'cross-lease', {
          adapter: sourceRuntime.adapter,
          fence,
          leaseId: source.leaseId,
          sessionRef: 'r8-cross-lease-source',
        })
        assert.equal(recovered.state, 'RECOVERING')
        assert.equal(target.store.getDispatch(target.dispatchId)?.state, 'TERMINAL')
        assert.equal(target.store.getExecution(target.executionId)?.state, 'COMPLETED')
        assert.equal(incidentEvents(target).length, 1)
      } finally {
        source.store.close()
        target.store.close()
      }
    },
  })

  cases.push({
    name: 'cross-session',
    async run() {
      const fixture = makeCompleteFixture('r8-cross-session-target')
      try {
        const foreign = makeFenceAdapter('r8-cross-session-foreign', 'r8-cross-session-instance')
        const fence = await foreign.adapter.openTrustFence({
          leaseId: fixture.leaseId,
          sessionRef: 'r8-cross-session-foreign',
          runtimeDispatchRef: null,
          baselineEvents: foreign.session.events,
        })
        const recovered = settleAndRelease(fixture.store, fixture.leaseId, confirmedCleanup(), 'cross-session', {
          adapter: foreign.adapter,
          fence,
          leaseId: fixture.leaseId,
          sessionRef: 'r8-cross-session-foreign',
        })
        assert.equal(recovered.state, 'RECOVERING')
        assert.equal(fixture.store.getDispatch(fixture.dispatchId)?.state, 'TERMINAL')
        assert.equal(fixture.store.getExecution(fixture.executionId)?.state, 'COMPLETED')
        assert.equal(incidentEvents(fixture).length, 1)
      } finally {
        fixture.store.close()
      }
    },
  })

  for (const entry of cases) {
    await entry.run()
  }
})

test('R8 ordinary cleanup false/throw/missing keeps terminal Claim/REVIEW and adds no integrity incident', () => {
  for (const status of ['RETURNED_FALSE', 'THREW', 'MISSING_EVIDENCE'] as const) {
    const fixture = makeCompleteFixture(`r8-cleanup-${status}`)
    try {
      const recovering = settleAndRelease(
        fixture.store,
        fixture.leaseId,
        failedCleanup(status),
        `ordinary cleanup ${status}`,
      )
      assert.equal(recovering.state, 'RECOVERING', status)
      assert.equal(fixture.store.getDispatch(fixture.dispatchId)?.state, 'TERMINAL', status)
      assert.equal(fixture.store.getExecution(fixture.executionId)?.state, 'COMPLETED', status)
      assert.equal(fixture.store.getTask(fixture.taskId)?.status, 'REVIEW', status)
      assert.ok(fixture.store.latestWorkerResult(fixture.taskId), status)
      assert.equal(incidentEvents(fixture).length, 0, `${status} 不得升级为完整性事故`)
    } finally {
      fixture.store.close()
    }
  }
})

test('R8 RELEASED mismatch escalates without rolling back immutable terminal history', async () => {
  const fixture = makeCompleteFixture('r8-released')
  try {
    const runtime = makeFenceAdapter('r8-released', 'r8-released-instance')
    const fence = await runtime.adapter.openTrustFence({
      leaseId: fixture.leaseId,
      sessionRef: 'r8-released',
      runtimeDispatchRef: null,
      baselineEvents: runtime.session.events,
    })
    const released = settleAndRelease(fixture.store, fixture.leaseId, confirmedCleanup(), 'release', {
      adapter: runtime.adapter,
      fence,
      leaseId: fixture.leaseId,
      sessionRef: 'r8-released',
    })
    assert.equal(released.state, 'RELEASED')
    const eventCount = incidentEvents(fixture).length

    const mismatched = makeFenceAdapter('r8-released-foreign', 'r8-released-foreign-instance')
    const foreignFence = await mismatched.adapter.openTrustFence({
      leaseId: 'foreign-lease',
      sessionRef: 'r8-released-foreign',
      runtimeDispatchRef: null,
      baselineEvents: mismatched.session.events,
    })
    const stillReleased = settleAndRelease(fixture.store, fixture.leaseId, confirmedCleanup(), 'late mismatch', {
      adapter: mismatched.adapter,
      fence: foreignFence,
      leaseId: 'foreign-lease',
      sessionRef: 'r8-released-foreign',
    })
    assert.equal(stillReleased.state, 'RELEASED')
    assert.equal(fixture.store.getDispatch(fixture.dispatchId)?.state, 'TERMINAL')
    assert.equal(fixture.store.getExecution(fixture.executionId)?.state, 'COMPLETED')
    assert.equal(incidentEvents(fixture).length, eventCount + 1, 'RELEASED mismatch must append escalation incident')
  } finally {
    fixture.store.close()
  }
})

function reviewContext(fixture: CompleteFixture) {
  return {
    kingdomId: fixture.kingdomId,
    auth: { mode: 'session-bound' as const, trustLevel: 'session-verified' as const, note: '' },
    principal: { sessionId: fixture.supervisorSession },
  }
}

test('R8 ACCEPT re-reads exact Task/Claim and blocks only the incident-correlated attempt', () => {
  const blocked = makeCompleteFixture('r8-accept-blocked')
  try {
    recordDispatchTerminalIntegrityIncident(blocked.store, {
      dispatchId: blocked.dispatchId,
      reasonCode: 'TRUST_FENCE_EXPECTATION_MISMATCH',
      phase: 'settlement',
    })
    const beforeEvents = blocked.store.listEvents(blocked.kingdomId, 1000)
    const result = reviewTask(blocked.store, reviewContext(blocked), { taskId: blocked.taskId, decision: 'ACCEPT' })
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'CLAIM_INTEGRITY_BLOCKED')
    assert.equal(blocked.store.getTask(blocked.taskId)?.status, 'REVIEW')
    assert.ok(blocked.store.getActiveAssignmentForTask(blocked.taskId))
    assert.equal(blocked.store.listEvents(blocked.kingdomId, 1000)
      .filter(event => event.event_type === 'TASK_ACCEPTED').length, 0)
    assert.equal(beforeEvents.length, blocked.store.listEvents(blocked.kingdomId, 1000).length,
      'blocked ACCEPT must not write a failure event or close assignment')
  } finally {
    blocked.store.close()
  }

  const unrelated = makeCompleteFixture('r8-accept-unrelated')
  try {
    unrelated.store.appendEvent({
      event_id: randomUUID(),
      kingdom_id: unrelated.kingdomId,
      event_type: 'DISPATCH_TERMINAL_INTEGRITY_INCIDENT',
      actor_role: 'SYSTEM',
      actor_id: 'fixture',
      target_type: 'dispatch',
      target_id: 'foreign-dispatch',
      payload_json: JSON.stringify({
        state: 'OPEN',
        dispatch_id: 'foreign-dispatch',
        task_id: unrelated.taskId,
        attempt_no: unrelated.attemptNo,
      }),
      created_at: now(),
    })
    const accepted = reviewTask(unrelated.store, reviewContext(unrelated), {
      taskId: unrelated.taskId,
      decision: 'ACCEPT',
    })
    assert.equal(accepted.ok, true, 'unrelated dispatch incident must not block exact Claim')
    assert.equal(unrelated.store.getTask(unrelated.taskId)?.status, 'DONE')
    assert.equal(unrelated.store.getActiveAssignmentForTask(unrelated.taskId), null)
    assert.equal(unrelated.store.listEvents(unrelated.kingdomId, 1000)
      .filter(event => event.event_type === 'TASK_ACCEPTED').length, 1)
  } finally {
    unrelated.store.close()
  }
})

test('R8 REWORK and FAIL remain available when an incident blocks ACCEPT', () => {
  const rework = makeCompleteFixture('r8-rework')
  try {
    recordDispatchTerminalIntegrityIncident(rework.store, {
      dispatchId: rework.dispatchId,
      reasonCode: 'TRUST_FENCE_EXPECTATION_MISMATCH',
      phase: 'settlement',
    })
    const result = reviewTask(rework.store, reviewContext(rework), {
      taskId: rework.taskId,
      decision: 'REWORK',
      reason: 'R8 rework remains an explicit recovery decision',
    })
    assert.equal(result.ok, true)
    assert.equal(rework.store.getTask(rework.taskId)?.status, 'RUNNING')
    assert.ok(rework.store.getActiveAssignmentForTask(rework.taskId))
  } finally {
    rework.store.close()
  }

  const failed = makeCompleteFixture('r8-fail')
  try {
    recordDispatchTerminalIntegrityIncident(failed.store, {
      dispatchId: failed.dispatchId,
      reasonCode: 'TRUST_FENCE_EXPECTATION_MISMATCH',
      phase: 'settlement',
    })
    const result = reviewTask(failed.store, reviewContext(failed), {
      taskId: failed.taskId,
      decision: 'FAIL',
      reason: 'R8 fail remains an explicit recovery decision',
    })
    assert.equal(result.ok, true)
    assert.equal(failed.store.getTask(failed.taskId)?.status, 'FAILED')
    assert.equal(failed.store.getActiveAssignmentForTask(failed.taskId), null)
  } finally {
    failed.store.close()
  }
})
