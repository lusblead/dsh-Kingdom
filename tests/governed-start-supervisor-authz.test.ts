/**
 * Public `kingdom_start_task_governed` authorization boundary.
 *
 * These tests deliberately use `apply()` plus the captured registered Tool instead
 * of calling a Core helper or runner directly.  Each harness points DSH_HOME at a
 * fresh OS temp directory, seeds only that non-formal DB, and supplies fake DSH
 * agents, so no real model or user kingdom.db can be reached.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { DshRuntimeAdapter } from '../lib/adapter/dsh-backend.js'
import { KingdomStore } from '../lib/core/db.js'
import {
  acquireExecutionLease,
  advanceLeaseState,
  bindCapabilityDecision,
  createGovernedExecution,
  establishAffinity,
  recordCapabilityDecision,
  setLeasePlan,
} from '../lib/core/governed.js'

const NOW = (): string => new Date().toISOString()
const CAPABILITY = 'tool:pwsh'
const GRANT = JSON.stringify({ [CAPABILITY]: true })

const S = {
  owner: 'session-owner',
  chancellor: 'session-chancellor',
  supervisorA: 'session-supervisor-a',
  supervisorB: 'session-supervisor-b',
  sharedSupervisors: 'session-supervisors-shared',
  worker: 'session-worker',
  stranger: 'session-stranger',
}

interface CapturedTool {
  name: string
  description?: string
  execute(args: Record<string, unknown>, exec: unknown): Promise<unknown>
}

interface CapturedCommand {
  name: string
  handler(invocation: { rawInput: string }): Promise<{ kind: string; text: string }>
}

interface FakeAgents {
  service: {
    agents: Map<string, unknown>
    currentInitiator(): unknown
    create(options: { sessionId: string; meta?: { cwd?: string }; setup?: (ctx: unknown) => unknown }): Promise<{ agent: unknown; dispose(): Promise<void> }>
    resume(options: { resumeSessionId: string; setup?: (ctx: unknown) => unknown }): Promise<{ agent: unknown; dispose(): Promise<void> }>
    get(sessionId: string): unknown
    list(): unknown[]
  }
  sessions: { get(sessionId: string): unknown }
  counts(): { create: number; resume: number; followup: number }
  setCurrent(sessionId: string | undefined): void
  ensure(sessionId: string): unknown
}

interface FakeAgentOptions {
  allowTerminal?: boolean
  cleanupThrows?: boolean
}

function makeFakeAgents(options: FakeAgentOptions = {}): FakeAgents {
  const agents = new Map<string, unknown>()
  let create = 0
  let resume = 0
  let followup = 0
  let currentInitiator: unknown

  const makeAgent = (id: string, cwd: string, status: 'idle' | 'running' = 'running') => ({
    id,
    status,
    session: { id, header: { cwd }, events: [] as { type: string; data?: Record<string, unknown> }[] },
    ctx: {
      tools: {
        schemas: () => [{ name: 'pwsh' }],
        restrict: () => options.cleanupThrows ? () => { throw new Error('fixture cleanup failure') } : () => {},
        guard: () => options.cleanupThrows ? () => { throw new Error('fixture cleanup failure') } : () => {},
      },
    },
    followup: (message?: { id?: string }) => {
      followup++
      if (!options.allowTerminal) return
      const events = (agents.get(id) as { session: { events: { type: string; data?: Record<string, unknown> }[] } } | undefined)?.session.events
      if (!events) return
      events.push({ type: 'user/message', data: { id: message?.id ?? 'fixture-dispatch' } })
      events.push({ type: 'turn/start', data: { turn: 1 } })
      events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      events.push({ type: 'assistant/message', data: { text: '入口测试完成。' } })
    },
    whenIdle: async () => {},
    cancel: () => {},
    runMaintenance: async <T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> => job(new AbortController().signal),
  })

  const ensure = (sessionId: string): unknown => {
    const existing = agents.get(sessionId)
    if (existing) return existing
    const created = makeAgent(sessionId, 'C:/test-territory')
    agents.set(sessionId, created)
    return created
  }

  return {
    service: {
      agents,
      currentInitiator: () => currentInitiator,
      async create(options) {
        create++
        const agent = makeAgent(options.sessionId, options.meta?.cwd ?? 'C:/test-territory', 'idle')
        agents.set(options.sessionId, agent)
        await options.setup?.({})
        return { agent, dispose: async () => { agents.delete(options.sessionId) } }
      },
      async resume(options) {
        resume++
        const agent = makeAgent(options.resumeSessionId, 'C:/test-territory', 'idle')
        agents.set(options.resumeSessionId, agent)
        await options.setup?.({})
        return { agent, dispose: async () => { agents.delete(options.resumeSessionId) } }
      },
      get(sessionId) {
        return agents.get(sessionId)
      },
      list() {
        return [...agents.values()]
      },
    },
    sessions: {
      get(sessionId) {
        return (agents.get(sessionId) as { session?: unknown } | undefined)?.session
      },
    },
    counts: () => ({ create, resume, followup }),
    setCurrent(sessionId) {
      currentInitiator = sessionId === undefined ? undefined : ensure(sessionId)
    },
    ensure,
  }
}

interface Harness {
  root: string
  store: KingdomStore
  tool: CapturedTool
  legacyTool: CapturedTool
  agents: FakeAgents
  kingdomId: string
  worker: string
  supA: string
  supB: string
  supSharedFirst: string
  supSharedSecond: string
  taskA: string
  taskB: string
  taskShared: string
  taskUnassigned: string
  help(): Promise<string>
  close(): void
}

interface HarnessOptions extends FakeAgentOptions {
  allowCapability?: boolean
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-kingdom-governed-authz-'))
  const originalDshHome = process.env.DSH_HOME
  const tools = new Map<string, CapturedTool>()
  const commands = new Map<string, CapturedCommand>()
  const disposers: (() => void)[] = []
  const agents = makeFakeAgents(options)
  const context = {
    tools: {
      register(tool: CapturedTool): () => void {
        tools.set(tool.name, tool)
        return () => { tools.delete(tool.name) }
      },
    },
    commands: {
      register(command: CapturedCommand): () => void {
        commands.set(command.name, command)
        return () => { commands.delete(command.name) }
      },
    },
    effect(callback: () => unknown): void {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer as () => void)
    },
    get(name: string): unknown {
      if (name === 'agents') return agents.service
      if (name === 'sessions') return agents.sessions
      return undefined
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  }

  try {
    process.env.DSH_HOME = root
    apply(context as never, {
      kingdomName: 'public-governed-start-test',
      ownerName: 'test-owner',
      workerProvider: 'spawn',
      guiPort: 0,
      guiToken: '',
      guiAllowOrigins: ['*'],
      // The public governed endpoint must override this intentionally weaker mode.
      authMode: 'declarative',
      migrateV4: true,
    }, {
      loadS4Policy: async () => ({
        sandboxPolicy: {
          setSandboxMode: (session: unknown, mode: string) => {
            const events = (session as { events?: { type: string; data?: Record<string, unknown> }[] }).events
            events?.push({ type: 'sandbox/mode', data: { mode } })
          },
        },
        approval: {
          setApprovalPolicy: (session: unknown, policy: string) => {
            const events = (session as { events?: { type: string; data?: Record<string, unknown> }[] }).events
            events?.push({ type: 'approval/policy', data: { policy } })
          },
        },
      }),
    })
  } finally {
    if (originalDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalDshHome
  }

  const init = tools.get('kingdom_init')
  const tool = tools.get('kingdom_start_task_governed')
  const legacyTool = tools.get('kingdom_start_task')
  assert.ok(init, 'apply() 必须注册 kingdom_init')
  assert.ok(tool, 'apply() 必须注册 kingdom_start_task_governed')
  assert.ok(legacyTool, 'apply() 必须保留显式 LEGACY_COMPAT kingdom_start_task')
  const kingdomCommand = commands.get('kingdom')
  assert.ok(kingdomCommand, 'apply() 必须注册 /kingdom command')
  // Owner-only initialization now has a zero-write Agent Tool boundary;
  // create the fixture through the canonical direct Slash command.
  await kingdomCommand.handler({ rawInput: 'init' })
  assert.match(await init.execute({}, {}), /^OWNER_CONTROL_REQUIRED:/)

  const store = new KingdomStore(join(root, 'kingdom', 'kingdom.db'), { allowSchemaV4: true })
  assert.equal(store.isSchemaV4, true, '临时测试库必须是 v4，不能接触正式 DB')
  const kingdomId = store.getDefaultKingdom()!.kingdom_id
  const owner = store.getBindingByRole(kingdomId, 'OWNER')!
  store.updateBindingSession(owner.binding_id, S.owner, NOW())

  const bind = (bindingId: string, roleType: string, sessionId: string | null, executionProfileJson: string | null = null): void => {
    store.insertBinding({
      binding_id: bindingId,
      kingdom_id: kingdomId,
      role_type: roleType,
      role_name: bindingId,
      runtime_type: 'dsh',
      session_id: sessionId,
      model_name: null,
      agent_name: null,
      session_meta: null,
      execution_profile_json: executionProfileJson,
      status: 'ACTIVE',
      retired_at: null,
      retired_reason: null,
      principal_id: null,
      created_at: NOW(),
      updated_at: NOW(),
    })
  }

  const supA = 'binding-supervisor-a'
  const supB = 'binding-supervisor-b'
  const supSharedFirst = 'binding-supervisor-shared-first'
  const supSharedSecond = 'binding-supervisor-shared-second'
  const worker = 'binding-worker'
  bind('binding-chancellor', 'CHANCELLOR', S.chancellor)
  // 用独立 Worker binding 代表实际调用者；任务 Worker 保持无 Session，便于
  // AUTHZ_DENIED 精确证明没有为它创建或写入 persistent Session projection。
  bind('binding-caller-worker', 'WORKER', S.worker)
  bind(supA, 'SUPERVISOR', S.supervisorA)
  bind(supB, 'SUPERVISOR', S.supervisorB)
  bind(supSharedFirst, 'SUPERVISOR', S.sharedSupervisors)
  bind(supSharedSecond, 'SUPERVISOR', S.sharedSupervisors)
  bind(worker, 'WORKER', null, JSON.stringify({ provider: 'spawn', model: 'test-model' }))

  const territoryA = 'territory-a'
  const territoryB = 'territory-b'
  const territoryShared = 'territory-shared'
  const territoryUnassigned = 'territory-unassigned'
  for (const [territoryId, name, supervisorBindingId] of [
    [territoryA, 'Territory A', supA],
    [territoryB, 'Territory B', supB],
    [territoryShared, 'Shared-session Territory', supSharedSecond],
    [territoryUnassigned, 'Unassigned Territory', null],
  ] as const) {
    store.insertTerritory({
      territory_id: territoryId,
      kingdom_id: kingdomId,
      name,
      workspace_path: 'C:/test-territory',
      summary: null,
      supervisor_binding_id: supervisorBindingId,
      status: 'ACTIVE',
      deleted_at: null,
      deleted_reason: null,
      created_at: NOW(),
    })
  }

  const taskA = 'task-a'
  const taskB = 'task-b'
  const taskShared = 'task-shared'
  const taskUnassigned = 'task-unassigned'
  for (const [taskId, territoryId, title] of [
    [taskA, territoryA, 'A task'],
    [taskB, territoryB, 'B task'],
    [taskShared, territoryShared, 'Shared-session task'],
    [taskUnassigned, territoryUnassigned, 'Unassigned task'],
  ] as const) {
    store.insertTask({
      task_id: taskId,
      territory_id: territoryId,
      parent_task_id: null,
      title,
      description: null,
      assigned_binding_id: worker,
      status: 'ASSIGNED',
      acceptance_criteria: 'capability test',
      result_summary: null,
      created_at: NOW(),
      updated_at: NOW(),
    })
    store.setTaskCapabilityRequirement(taskId, JSON.stringify({ [CAPABILITY]: true }))
  }
  // Authenticated paths enter the existing Capability Gate, which will deny the
  // requested tool because the Owner ceiling intentionally excludes it.
  store.setKingdomCapabilityCeiling(kingdomId, JSON.stringify(options.allowCapability
    ? { [CAPABILITY]: true }
    : { 'tool:other': true }))

  return {
    root,
    store,
    tool,
    legacyTool,
    agents,
    kingdomId,
    worker,
    supA,
    supB,
    supSharedFirst,
    supSharedSecond,
    taskA,
    taskB,
    taskShared,
    taskUnassigned,
    help: async () => (await kingdomCommand.handler({ rawInput: 'help' })).text,
    close: () => {
      store.close()
      for (const dispose of disposers.reverse()) dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

async function executeGoverned(
  harness: Harness,
  taskId: string,
  sessionId: string | undefined,
  grantJson = GRANT,
): Promise<string> {
  harness.agents.setCurrent(sessionId)
  const exec = sessionId === undefined
    ? { signal: { aborted: false } }
    : { agent: harness.agents.ensure(sessionId), signal: { aborted: false } }
  const result = await harness.tool.execute({ task_id: taskId, grant_json: grantJson }, exec)
  assert.equal(typeof result, 'string')
  return result as string
}

function assertOnlyCurrentCaller(harness: Harness): void {
  // The trusted caller itself must remain in the exact DSH registry seam so
  // resolveTrustedToolSession can prove currentInitiator + agents.get object
  // identity.  The no-side-effect assertion is about the task Worker: no
  // second live Agent may be created or retained by the rejected request.
  const caller = harness.agents.service.currentInitiator()
  const liveAgents = [...harness.agents.service.agents.values()]
  assert.equal(liveAgents.length, caller === undefined ? 0 : 1, '拒绝路径不得新增 live Worker session')
  if (caller !== undefined) assert.equal(liveAgents[0], caller, 'registry 中只能保留 exact current initiator fixture')
}

function assertNoRunnerSideEffects(harness: Harness, taskId: string, taskExists = true): void {
  assert.deepEqual(harness.agents.counts(), { create: 0, resume: 0, followup: 0 })
  assertOnlyCurrentCaller(harness)
  assert.equal(harness.store.listAffinities(harness.kingdomId).length, 0)
  assert.equal(harness.store.getBindingById(harness.worker)!.session_id, null, 'AUTHZ_DENIED 不得写入 Worker Session projection')
  assert.equal(harness.store.listLeases(harness.kingdomId).length, 0)
  assert.equal(harness.store.listCapabilityDecisions(harness.kingdomId).length, 0)
  assert.equal(harness.store.listDispatches(harness.kingdomId).length, 0)
  assert.equal(harness.store.listExecutions(taskId).length, 0)
  assert.equal(harness.store.listWorkerResults(taskId).length, 0)
  if (taskExists) assert.equal(harness.store.getTask(taskId)!.status, 'ASSIGNED')
  else assert.equal(harness.store.getTask(taskId), null)
}

/** Capability 拒绝与 AUTHZ 拒绝不同：前者允许准备 Session/Lease/Decision，但必须清理 Lease。 */
function assertCapabilityDeniedCleanup(harness: Harness, taskId: string, supervisorBindingId: string): void {
  assert.deepEqual(harness.agents.counts(), { create: 1, resume: 0, followup: 0 })
  assert.equal(harness.store.listAffinities(harness.kingdomId).length, 1, 'Capability Gate 前已建立 persistent session affinity')

  const decisions = harness.store.listCapabilityDecisions(harness.kingdomId)
  assert.equal(decisions.length, 1)
  const decision = decisions[0]!
  assert.equal(decision.decision, 'DENIED')
  assert.equal(decision.supervisor_binding_id, supervisorBindingId, 'Decision 必须记录 caller-resolved Supervisor binding')

  const leases = harness.store.listLeases(harness.kingdomId)
  assert.equal(leases.length, 1)
  const lease = leases[0]!
  assert.equal(lease.state, 'RELEASED', 'Capability DENIED 的 zero-execution cleanup 必须释放 Lease')
  assert.ok(lease.released_at, 'Capability DENIED 的 RELEASED Lease 必须有 released_at')
  assert.ok(lease.release_evidence_json, 'Capability DENIED 的 RELEASED Lease 必须有 release_evidence_json')

  assert.equal(harness.store.listDispatches(harness.kingdomId).length, 0)
  assert.equal(harness.store.listExecutions(taskId).length, 0)
  assert.equal(harness.store.listWorkerResults(taskId).length, 0)
  assert.equal(harness.store.getTask(taskId)!.status, 'ASSIGNED')
}

test('public governed start: 正确 Supervisor 进入既有 Capability Gate，Ceiling 拒绝仍保留 cleanup', async (t) => {
  const harness = await makeHarness()
  t.after(() => harness.close())

  const output = await executeGoverned(harness, harness.taskA, S.supervisorA)
  assert.match(output, /^CAPABILITY_DENIED: Capability DENIED/)
  assertCapabilityDeniedCleanup(harness, harness.taskA, harness.supA)
})

test('public governed start: 第二位 Supervisor 只能在自己领地进入 Capability Gate', async (t) => {
  const harness = await makeHarness()
  t.after(() => harness.close())

  const output = await executeGoverned(harness, harness.taskB, S.supervisorB)
  assert.match(output, /^CAPABILITY_DENIED: Capability DENIED/)
  assertCapabilityDeniedCleanup(harness, harness.taskB, harness.supB)
})

test('public governed start: 同一 DSH session 的多个 Supervisor 必须解析为 Territory 指定 binding', async (t) => {
  const harness = await makeHarness()
  t.after(() => harness.close())

  const output = await executeGoverned(harness, harness.taskShared, S.sharedSupervisors)
  assert.match(output, /^CAPABILITY_DENIED: Capability DENIED/)
  assertCapabilityDeniedCleanup(harness, harness.taskShared, harness.supSharedSecond)
  const decision = harness.store.listCapabilityDecisions(harness.kingdomId)[0]!
  // Capability Decision 是 runGovernedTask 入参的持久化证据：必须是 Territory
  // 指定的第二个 binding，不得退回同 session 的首个匹配 binding。
  assert.equal(decision.supervisor_binding_id, harness.supSharedSecond)
  assert.notEqual(decision.supervisor_binding_id, harness.supSharedFirst)
})

test('public governed start: trusted terminal cleanup failure 保留 Claim/REVIEW 并进入 Lease RECOVERING', async (t) => {
  const harness = await makeHarness({ allowCapability: true, allowTerminal: true, cleanupThrows: true })
  t.after(() => harness.close())

  const output = await executeGoverned(harness, harness.taskA, S.supervisorA)
  assert.match(output, /enforcement cleanup 未确认/u)
  assert.match(output, /Lease=RECOVERING/u)
  assert.match(output, /不得复用该 Session 或发起新 Dispatch/u)
  assert.equal(harness.store.getTask(harness.taskA)?.status, 'REVIEW')
  assert.equal(harness.store.latestWorkerResult(harness.taskA)?.outcome, 'COMPLETED')
  assert.equal(harness.store.listLeases(harness.kingdomId)[0]?.state, 'RECOVERING')
  assert.equal(harness.store.listEvents(harness.kingdomId, 1000).filter(e => e.event_type === 'SESSION_STOPPED').length, 0)
})

test('public governed start: settlement precedes Worker Claim insertion', async (t) => {
  const harness = await makeHarness({ allowCapability: true, allowTerminal: true, cleanupThrows: true })
  const observedLeaseStates: string[] = []
  const originalInsertWorkerResult = KingdomStore.prototype.insertWorkerResult
  KingdomStore.prototype.insertWorkerResult = function (
    this: KingdomStore,
    row: Parameters<KingdomStore['insertWorkerResult']>[0],
  ) {
    observedLeaseStates.push(this.getLeaseByTaskAttempt(row.task_id, row.attempt_no)?.state ?? 'MISSING')
    return originalInsertWorkerResult.call(this, row)
  }
  t.after(() => {
    KingdomStore.prototype.insertWorkerResult = originalInsertWorkerResult
    harness.close()
  })

  const output = await executeGoverned(harness, harness.taskA, S.supervisorA)
  assert.match(output, /Lease=RECOVERING/u)
  assert.deepEqual(observedLeaseStates, ['RECOVERING'], 'Claim 写入前 Lease 必须已完成 settlement')
  assert.equal(harness.store.getTask(harness.taskA)?.status, 'REVIEW')
  assert.equal(harness.store.latestWorkerResult(harness.taskA)?.outcome, 'COMPLETED')
})

test('public governed start: unproven terminal relation blocks Claim insertion', async (t) => {
  const harness = await makeHarness({ allowCapability: true, allowTerminal: true })
  const originalGetDispatch = KingdomStore.prototype.getDispatch
  const originalGetTask = KingdomStore.prototype.getTask
  let corrupted = false
  let corruptNextTaskRead = false
  KingdomStore.prototype.getDispatch = function (this: KingdomStore, dispatchId: string) {
    const row = originalGetDispatch.call(this, dispatchId)
    if (!corrupted && row?.state === 'TERMINAL') {
      corrupted = true
      corruptNextTaskRead = true
    }
    return row
  }
  KingdomStore.prototype.getTask = function (this: KingdomStore, taskId: string) {
    const row = originalGetTask.call(this, taskId)
    if (corruptNextTaskRead) {
      corruptNextTaskRead = false
      return null
    }
    return row
  }
  t.after(() => {
    KingdomStore.prototype.getDispatch = originalGetDispatch
    KingdomStore.prototype.getTask = originalGetTask
    harness.close()
  })

  const output = await executeGoverned(harness, harness.taskA, S.supervisorA)
  assert.equal(corrupted, true, 'test must corrupt the post-terminal Dispatch read')
  assert.match(output, /^GOVERNED_SETTLEMENT_BLOCKED \[(RELATION_MISSING|UNPROVEN_TERMINAL_RELATION)\]:/)
  assert.equal(harness.store.listWorkerResults(harness.taskA).length, 0, 'exact relation 无法证明时不得写 Claim')
  assert.equal(harness.store.getTask(harness.taskA)?.status, 'ASSIGNED')
})

test('public governed start: incident write failure blocks Claim insertion', async (t) => {
  const harness = await makeHarness({ allowCapability: true, allowTerminal: true })
  let settlementChecks = 0
  const originalCheckTrustFence = DshRuntimeAdapter.prototype.checkTrustFence
  const originalAppendEvent = KingdomStore.prototype.appendEvent
  DshRuntimeAdapter.prototype.checkTrustFence = function (
    this: DshRuntimeAdapter,
    fence: Parameters<DshRuntimeAdapter['checkTrustFence']>[0],
    phase: Parameters<DshRuntimeAdapter['checkTrustFence']>[1],
    expectation: Parameters<DshRuntimeAdapter['checkTrustFence']>[2],
  ): ReturnType<DshRuntimeAdapter['checkTrustFence']> {
    if (phase === 'settlement') {
      settlementChecks++
      // The first settlement check belongs to the pre-terminal dispatch path;
      // the second is the product settlement path after terminal persistence.
      if (settlementChecks === 2) return {
        ok: false,
        status: 'TAINTED',
        reservation: 'DETECT_ONLY',
        generation: null,
        reason: 'R11 injected post-terminal fence mismatch',
      }
    }
    return originalCheckTrustFence.call(this, fence, phase, expectation)
  }
  KingdomStore.prototype.appendEvent = function (
    this: KingdomStore,
    row: Parameters<KingdomStore['appendEvent']>[0],
  ) {
    if (row.event_type === 'DISPATCH_TERMINAL_INTEGRITY_INCIDENT') {
      throw new Error('R11 injected incident write failure')
    }
    return originalAppendEvent.call(this, row)
  }
  t.after(() => {
    DshRuntimeAdapter.prototype.checkTrustFence = originalCheckTrustFence
    KingdomStore.prototype.appendEvent = originalAppendEvent
    harness.close()
  })

  const output = await executeGoverned(harness, harness.taskA, S.supervisorA)
  assert.match(output, /^GOVERNED_SETTLEMENT_BLOCKED \[UNPROVEN_TERMINAL_RELATION\]:/)
  assert.equal(harness.store.listWorkerResults(harness.taskA).length, 0, 'incident 无法落账时不得写 Claim')
  assert.equal(harness.store.getTask(harness.taskA)?.status, 'ASSIGNED')
  assert.equal(harness.store.listEvents(harness.kingdomId, 1000)
    .filter(event => event.event_type === 'DISPATCH_TERMINAL_INTEGRITY_INCIDENT').length, 0)
})

test('public governed start: 每个 AUTHZ_DENIED 分支均在 runner 前 fail-closed', async () => {
  const forgedButUnauthorizedGrant = JSON.stringify({ [CAPABILITY]: true, 'binding:binding-supervisor-a': true })
  const cases: ReadonlyArray<{
    label: string
    taskId: (harness: Harness) => string
    sessionId?: string
    grantJson?: string
    arrange?: (harness: Harness) => void
    taskExists?: boolean
    expected: RegExp
  }> = [
    { label: 'cross territory', taskId: harness => harness.taskA, sessionId: S.supervisorB, expected: /^AUTHZ_DENIED \[TASK_OUT_OF_SCOPE\]:/ },
    { label: 'Worker caller', taskId: harness => harness.taskA, sessionId: S.worker, expected: /^AUTHZ_DENIED \[UNAUTHORIZED_PRINCIPAL\]:/ },
    { label: 'Chancellor caller', taskId: harness => harness.taskA, sessionId: S.chancellor, expected: /^AUTHZ_DENIED \[UNAUTHORIZED_PRINCIPAL\]:/ },
    { label: 'Owner caller', taskId: harness => harness.taskA, sessionId: S.owner, expected: /^AUTHZ_DENIED \[UNAUTHORIZED_PRINCIPAL\]:/ },
    { label: 'missing Runtime principal', taskId: harness => harness.taskA, expected: /^AUTHZ_DENIED \[UNAUTHORIZED_PRINCIPAL\]:/ },
    { label: 'unknown task does not enter fallback', taskId: () => 'task-does-not-exist', sessionId: S.supervisorA, taskExists: false, expected: /^AUTHZ_DENIED \[TASK_NOT_FOUND\]:/ },
    { label: 'forged Grant plus unauthorized caller', taskId: harness => harness.taskA, sessionId: S.stranger, grantJson: forgedButUnauthorizedGrant, expected: /^AUTHZ_DENIED \[UNAUTHORIZED_PRINCIPAL\]:/ },
    { label: 'malformed Grant plus unauthorized caller', taskId: harness => harness.taskA, sessionId: S.stranger, grantJson: '{not-json', expected: /^AUTHZ_DENIED \[UNAUTHORIZED_PRINCIPAL\]:/ },
    {
      label: 'Supervisor binding without session',
      taskId: harness => harness.taskA,
      sessionId: S.supervisorA,
      arrange: harness => harness.store.updateBindingSession(harness.supA, null, NOW()),
      expected: /^AUTHZ_DENIED \[UNAUTHORIZED_PRINCIPAL\]:/,
    },
    {
      label: 'Supervisor session mismatch',
      taskId: harness => harness.taskA,
      sessionId: S.supervisorA,
      arrange: harness => harness.store.updateBindingSession(harness.supA, 'rotated-supervisor-session', NOW()),
      expected: /^AUTHZ_DENIED \[UNAUTHORIZED_PRINCIPAL\]:/,
    },
    {
      label: 'retired Territory Supervisor pointer',
      taskId: harness => harness.taskA,
      sessionId: S.supervisorA,
      arrange: harness => harness.store.retireBinding(harness.supA, 'test retirement'),
      expected: /^AUTHZ_DENIED \[TERRITORY_SUPERVISOR_MISSING\]:/,
    },
    { label: 'unassigned Territory', taskId: harness => harness.taskUnassigned, sessionId: S.supervisorA, expected: /^AUTHZ_DENIED \[TERRITORY_SUPERVISOR_MISSING\]:/ },
  ]

  for (const scenario of cases) {
    const harness = await makeHarness()
    try {
      scenario.arrange?.(harness)
      const taskId = scenario.taskId(harness)
      const output = await executeGoverned(harness, taskId, scenario.sessionId, scenario.grantJson ?? GRANT)
      assert.match(output, scenario.expected, scenario.label)
      assertNoRunnerSideEffects(harness, taskId, scenario.taskExists !== false)
    } finally {
      harness.close()
    }
  }
})

test('public governed start: fallback propagates non-auth binding lookup errors without execution', async (t) => {
  const harness = await makeHarness()
  t.after(() => harness.close())

  // This caller reaches the resolver's narrow multi-binding fallback: the generic
  // helper sees the first same-session Supervisor, while the Territory names the
  // second. A storage/read failure at the fallback boundary must not be rewritten
  // as AUTHZ_DENIED or become an executable request.
  const originalGetBindingsByRole = KingdomStore.prototype.getBindingsByRole
  KingdomStore.prototype.getBindingsByRole = function (
    this: KingdomStore,
    kingdomId: string,
    roleType: string,
  ) {
    if (kingdomId === harness.kingdomId && roleType === 'SUPERVISOR') {
      throw new Error('intentional fallback binding lookup failure')
    }
    return originalGetBindingsByRole.call(this, kingdomId, roleType)
  }
  try {
    await assert.rejects(
      () => executeGoverned(harness, harness.taskShared, S.sharedSupervisors),
      /intentional fallback binding lookup failure/,
    )
  } finally {
    KingdomStore.prototype.getBindingsByRole = originalGetBindingsByRole
  }
  assertNoRunnerSideEffects(harness, harness.taskShared)
})

test('public governed start: 已认证 Supervisor 的 malformed Grant 是 INPUT_DENIED，且不准备 runner', async (t) => {
  const harness = await makeHarness()
  t.after(() => harness.close())

  const output = await executeGoverned(harness, harness.taskA, S.supervisorA, '{"not-boolean":"yes"}')
  assert.match(output, /^INPUT_DENIED \[INVALID_SUPERVISOR_GRANT\]:/)
  assertNoRunnerSideEffects(harness, harness.taskA)
})

test('public governed start: unsettled persistent Execution blocks before Runtime, Session, Lease, or Dispatch effects', async () => {
  for (const state of ['STARTING', 'RUNNING', 'PAUSED', 'RECOVERING'] as const) {
    const harness = await makeHarness()
    try {
      const taskBefore = harness.store.transitionTask(harness.store.getTask(harness.taskA)!, 'RUNNING')
      const executionId = `existing-governed-${state.toLowerCase()}`
      const session = {
        runtimeType: 'dsh',
        runtimeInstanceRef: 'existing-runtime',
        sessionRef: `existing-persistent-session-${state.toLowerCase()}`,
      }
      establishAffinity(harness.store, {
        kingdomId: harness.kingdomId,
        workerBindingId: harness.worker,
        session,
        territoryId: 'territory-a',
      })
      const lease = acquireExecutionLease(harness.store, {
        kingdomId: harness.kingdomId,
        workerBindingId: harness.worker,
        session,
        territoryId: 'territory-a',
        taskId: harness.taskA,
        attemptNo: 1,
      })
      setLeasePlan(harness.store, lease.lease_id, JSON.stringify({
        type: 'GovernedStartUnsettledFixture/v1',
        sandboxMode: 'workspace-write',
      }))
      advanceLeaseState(harness.store, lease.lease_id, 'PREPARING')
      advanceLeaseState(harness.store, lease.lease_id, 'MATERIALIZING')
      const decision = recordCapabilityDecision(harness.store, {
        kingdomId: harness.kingdomId,
        taskId: harness.taskA,
        workerBindingId: harness.worker,
        supervisorBindingId: harness.supA,
        requirementSnapshot: JSON.stringify({ [CAPABILITY]: true }),
        ceilingSnapshot: JSON.stringify({ [CAPABILITY]: true }),
        proposedGrantSnapshot: GRANT,
        effectiveSnapshot: GRANT,
        decision: 'GRANTED',
        enforcementStatus: 'ENFORCED',
        enforcementEvidenceJson: JSON.stringify({ type: 'TestEnforcementEvidence/v1' }),
        requirementCoverage: 'FULL',
      })
      bindCapabilityDecision(harness.store, lease.lease_id, decision.decision_id)
      advanceLeaseState(harness.store, lease.lease_id, 'DISPATCH_READY')
      let execution = createGovernedExecution(harness.store, {
        taskId: harness.taskA,
        attemptNo: 1,
        workerBindingId: harness.worker,
        leaseId: lease.lease_id,
        capabilityDecisionId: decision.decision_id,
        sessionId: session.sessionRef,
        executionId,
        detail: 'schema-valid unsettled governed fixture',
      })
      if (state !== 'STARTING') {
        execution = harness.store.transitionExecution(execution, state, {
          detail: `schema-valid unsettled governed fixture: ${state}`,
        })
      }
      if (state === 'RUNNING' || state === 'PAUSED') {
        advanceLeaseState(harness.store, lease.lease_id, 'EXECUTING')
      } else if (state === 'RECOVERING') {
        advanceLeaseState(harness.store, lease.lease_id, 'RECOVERING')
      }
      const countsBefore = {
        affinities: harness.store.listAffinities(harness.kingdomId).length,
        leases: harness.store.listLeases(harness.kingdomId).length,
        decisions: harness.store.listCapabilityDecisions(harness.kingdomId).length,
        dispatches: harness.store.listDispatches(harness.kingdomId).length,
        executions: harness.store.listExecutions(harness.taskA).length,
        results: harness.store.listWorkerResults(harness.taskA).length,
      }

      const output = await executeGoverned(harness, harness.taskA, S.supervisorA)
      const code = state === 'RECOVERING'
        ? 'EXISTING_EXECUTION_RECOVERING'
        : 'EXISTING_EXECUTION_UNSETTLED'
      assert.match(output, new RegExp(`^GOVERNED_EXECUTION_DENIED \\[${code}\\]:`), state)
      assert.match(output, /未访问 Runtime\/Session\/Lease/)
      assert.deepEqual(harness.agents.counts(), { create: 0, resume: 0, followup: 0 })
      assertOnlyCurrentCaller(harness)
      assert.deepEqual({ ...harness.store.getTask(harness.taskA)! }, taskBefore, 'Task row must remain unchanged')
      assert.deepEqual({
        affinities: harness.store.listAffinities(harness.kingdomId).length,
        leases: harness.store.listLeases(harness.kingdomId).length,
        decisions: harness.store.listCapabilityDecisions(harness.kingdomId).length,
        dispatches: harness.store.listDispatches(harness.kingdomId).length,
        executions: harness.store.listExecutions(harness.taskA).length,
        results: harness.store.listWorkerResults(harness.taskA).length,
      }, countsBefore)
      assert.equal(harness.store.getExecution(executionId)!.state, state)
    } finally {
      harness.close()
    }
  }
})

test('headless route contract: governed is canonical and legacy requires explicit opt-in', async (t) => {
  const harness = await makeHarness()
  t.after(() => harness.close())

  assert.match(harness.tool.description ?? '', /CANONICAL HEADLESS/)
  assert.match(harness.tool.description ?? '', /真实 DSH caller session/)
  assert.match(harness.tool.description ?? '', /不自动降级 LEGACY_COMPAT/)
  assert.match(harness.legacyTool.description ?? '', /^LEGACY_COMPAT（仅显式选择）/)
  assert.match(harness.legacyTool.description ?? '', /不会自动作为 governed persistent 的 fallback/)

  const help = await harness.help()
  assert.match(help, /kingdom_start_task_governed（CANONICAL HEADLESS，Persistent Worker）/)
  assert.match(help, /LEGACY_COMPAT：kingdom_start_task 仅在用户明确选择旧 one-shot 兼容模式时显式调用/)
  assert.doesNotMatch(help, /任务闭环：plan → assign → start（Worker 执行）/)
})

test('headless route contract: governed failure never suggests legacy fallback', async (t) => {
  const harness = await makeHarness()
  t.after(() => harness.close())

  const output = await executeGoverned(harness, harness.taskA, S.supervisorA)
  assert.match(output, /^CAPABILITY_DENIED: Capability DENIED/)
  assert.doesNotMatch(output, /改用 kingdom_start_task/)
  assert.match(output, /不会自动降级为 LEGACY_COMPAT/)
  assertCapabilityDeniedCleanup(harness, harness.taskA, harness.supA)
})
