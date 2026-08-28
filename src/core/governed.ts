/**
 * dsh-kingdom — v0.8 Runtime Governance Domain API（M3-S2 Schema v4 Design v6）。
 *
 * 这是 Kingdom Core 与四套 v4 Ledger（Affinity / Lease / Capability Decision / Dispatch）
 * 之间的**最小权威写入面**：上层（S3 Adapter / S4 Resolver / S5 Dispatch/Reconcile /
 * 既有 TaskService 的 governed 路径）只允许经本模块进入这些 Ledger，不散写 SQL。
 *
 * 纪律（Owner v0.8 施工 Prompt §15）：
 * - transaction boundary 清晰：多步写（如 TX-3：Execution + Decision.execution_id 回填 +
 *   Dispatch Intent + Lease 推进）在单个 withImmediateTransaction 内原子完成；
 * - fail-closed：任何一步抛错整体回滚，不产生半状态；
 * - 禁止客户端自报权威值：状态推进一律 CAS（期望旧态）+ DB trigger 权威校验；
 * - 非 v4 库：一律抛 SchemaV4NotMigratedError（正式库 Gate 保护下可用 v3 功能，
 *   governed 路径拒绝执行）。
 *
 * 状态机的**权威**在 DB trigger（v6 硬编码 transition matrix + INSERT 守卫），
 * 本模块的 CAS 只是并发防护与错误信息的第二道防线。
 */
import { randomUUID } from 'node:crypto'
import {
  KingdomStore,
  type AffinityRow,
  type LeaseRow,
  type CapabilityDecisionRow,
  type DispatchRecordRow,
  type ExecutionRow,
  type EventRow,
  type TaskRow,
  StaleStateError,
} from './db.js'
import { asExecutionState, transitionExecution, isTerminalExecutionState } from './execution.js'

/** 完整 Runtime Session identity（M3-S1 冻结：(runtime_type, runtime_instance_ref, session_ref)）。 */
export interface SessionIdentity {
  runtimeType: string
  runtimeInstanceRef: string
  sessionRef: string
}

/** v0.8 governed 路径统一错误基类。 */
export class GovernedApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GovernedApiError'
  }
}

/** 库未迁移 v4 时调用 governed API。fail-closed：不静默降级。 */
export class SchemaV4NotMigratedError extends GovernedApiError {
  constructor() {
    super('Schema v4 未迁移：governed Runtime Governance API 不可用（正式 kingdom.db 迁移须经 Formal DB Migration Gate）')
    this.name = 'SchemaV4NotMigratedError'
  }
}

// ── R11 canonical Runner context product port ───────────────────────────────
//
// The REAL runner is intentionally not coupled here.  This is the product-side
// port it must consume: the only authority for a context is a fresh exact read
// of the canonical Task/Execution/Lease/Dispatch relation.  The opaque handle
// and version objects below are merely capabilities for selecting that exact
// relation; neither WeakMap membership nor Object.freeze is treated as proof.

export type RunnerContextPhase =
  | 'OPEN'
  | 'ACQUIRED'
  | 'BOUND'
  | 'TERMINAL'
  | 'RECOVERING'
  | 'RELEASED'
  | 'INVALID'

export type RunnerContextErrorCode =
  | 'RELATION_MISSING'
  | 'RELATION_MISMATCH'
  | 'INVALID_HANDLE'
  | 'INVALID_VERSION'
  | 'STALE_VERSION'
  | 'INVALID_ORDER'
  | 'RECOVERING'
  | 'RELEASED'

export class RunnerContextError extends GovernedApiError {
  readonly code: RunnerContextErrorCode

  constructor(code: RunnerContextErrorCode, message: string) {
    super(`RunnerContext ${code}: ${message}`)
    this.name = 'RunnerContextError'
    this.code = code
  }
}

const RUNNER_CONTEXT_SECRET = Symbol('dsh-kingdom.runner-context')

/** Opaque, module-minted identity.  The constructor rejects arbitrary keys. */
export class RunnerContextHandle {
  readonly #opaque = RUNNER_CONTEXT_SECRET

  /** @internal The module-private secret is the only accepted constructor key. */
  constructor(key: symbol) {
    if (key !== RUNNER_CONTEXT_SECRET) throw new Error('RunnerContextHandle: private constructor')
  }
}

/** Opaque monotonic token.  The public sequence is diagnostic only. */
export class RunnerContextVersion {
  #diagnosticSequence: number

  /** @internal The module-private secret is the only accepted constructor key. */
  constructor(key: symbol, sequence: number) {
    if (key !== RUNNER_CONTEXT_SECRET) throw new Error('RunnerContextVersion: private constructor')
    this.#diagnosticSequence = sequence
  }

  /**
   * This value is intentionally only a diagnostic projection. The product
   * never reads it to mint the next token; the authoritative sequence lives in
   * the module-private WeakMap record below.
   */
  get sequence(): number {
    return this.#diagnosticSequence
  }
}

export interface RunnerContextView {
  readonly phase: RunnerContextPhase
  readonly kingdomId: string
  readonly taskId: string
  readonly attemptNo: number
  readonly executionId: string
  readonly leaseId: string
  readonly dispatchId: string
  readonly workerBindingId: string
  readonly sessionRef: string
  readonly dispatchState: string
  readonly executionState: string
  readonly leaseState: string
  readonly version: RunnerContextVersion
}

export interface RunnerContextActionContext {
  readonly handle: RunnerContextHandle
  readonly version: RunnerContextVersion
  readonly view: RunnerContextView
  readonly runtimeDispatchRef?: string
}

export interface RunnerContextMutationResult<T> {
  readonly value: T
  readonly view: RunnerContextView
}

interface RunnerContextRows {
  task: TaskRow
  execution: ExecutionRow
  lease: LeaseRow
  dispatch: DispatchRecordRow
}

interface RunnerContextIdentity {
  kingdomId: string
  taskId: string
  attemptNo: number
  executionId: string
  leaseId: string
  dispatchId: string
  workerBindingId: string
  sessionRef: string
}

interface RunnerContextHandleState extends RunnerContextIdentity {
  readonly store: KingdomStore
}

interface RunnerContextVersionState {
  readonly port: RunnerContextPort
  readonly sequence: number
  readonly relationKey: string
  readonly phase: RunnerContextPhase
}

interface RunnerContextPortState {
  readonly store: KingdomStore
  readonly handle: RunnerContextHandle
  readonly identity: RunnerContextIdentity
  phase: RunnerContextPhase
  currentVersion: RunnerContextVersion
  poisoned: string | null
}

const runnerContextHandleStates = new WeakMap<RunnerContextHandle, RunnerContextHandleState>()
const runnerContextVersionStates = new WeakMap<RunnerContextVersion, RunnerContextVersionState>()
const runnerContextPortStates = new WeakMap<RunnerContextPort, RunnerContextPortState>()

function registerRunnerContextVersion(
  version: RunnerContextVersion,
  state: RunnerContextVersionState,
): void {
  // The record is the trusted sequence source. It is module-private and
  // immutable; callers can only observe the diagnostic getter on the token.
  runnerContextVersionStates.set(version, Object.freeze(state))
}

function runnerContextToken(value: string, label: string): void {
  if (value.length === 0 || value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
    throw new RunnerContextError('RELATION_MISMATCH', `${label} 不是合法的非空 token`)
  }
}

function runnerContextRows(store: KingdomStore, dispatchId: string): RunnerContextRows {
  runnerContextToken(dispatchId, 'dispatchId')
  const dispatch = store.getDispatch(dispatchId)
  if (!dispatch) throw new RunnerContextError('RELATION_MISSING', `Dispatch ${dispatchId} 不存在`)
  const task = store.getTask(dispatch.task_id)
  const execution = store.getExecution(dispatch.execution_id)
  const lease = store.getLease(dispatch.lease_id)
  const territory = task ? store.getTerritoryById(task.territory_id) : null
  if (!task || !execution || !lease || !territory) {
    throw new RunnerContextError('RELATION_MISSING', `Dispatch ${dispatchId} 的 Task/Execution/Lease/Territory 关系不完整`)
  }

  const exact = dispatch.kingdom_id === territory.kingdom_id
    && dispatch.task_id === task.task_id
    && dispatch.execution_id === execution.execution_id
    && dispatch.lease_id === lease.lease_id
    && dispatch.attempt_no === execution.attempt_no
    && dispatch.attempt_no === lease.attempt_no
    && execution.task_id === task.task_id
    && execution.lease_id === lease.lease_id
    && execution.execution_contract === 'GOVERNED_PERSISTENT'
    && execution.worker_binding_id === lease.worker_binding_id
    && execution.session_id === lease.session_ref
    && lease.kingdom_id === dispatch.kingdom_id
    && lease.task_id === task.task_id
    && lease.territory_id === task.territory_id
    && dispatch.session_ref === lease.session_ref
    && dispatch.runtime_type === lease.runtime_type
    && dispatch.runtime_instance_ref === lease.runtime_instance_ref
    && task.assigned_binding_id === lease.worker_binding_id

  if (!exact) {
    throw new RunnerContextError(
      'RELATION_MISMATCH',
      `Dispatch ${dispatchId} 的 Task/attempt/Execution/Lease/Session 关系无法证明`,
    )
  }
  return { task, execution, lease, dispatch }
}

function runnerContextRelationKey(store: KingdomStore, rows: RunnerContextRows): string {
  // `revision` is the existing monotonically increasing event sequence.  The
  // row transition tuple remains part of the key because a few Core updates
  // intentionally do not emit an event.  No synthetic DB version is minted.
  return JSON.stringify([
    store.revision(rows.dispatch.kingdom_id),
    rows.task.updated_at,
    rows.task.status,
    rows.task.assigned_binding_id,
    rows.execution.state,
    rows.execution.heartbeat_at,
    rows.execution.ended_at,
    rows.lease.state,
    rows.lease.updated_at,
    rows.lease.released_at,
    rows.dispatch.state,
    rows.dispatch.updated_at,
    rows.dispatch.runtime_dispatch_ref,
    rows.dispatch.runtime_execution_ref,
    rows.dispatch.receipt_at,
    rows.dispatch.terminal_at,
  ])
}

function runnerContextInitialPhase(rows: RunnerContextRows): RunnerContextPhase {
  if (rows.dispatch.state === 'RECOVERING' || rows.lease.state === 'RECOVERING') {
    throw new RunnerContextError('RECOVERING', 'RECOVERING context 不得重新绑定 Runner')
  }
  if (rows.lease.state === 'RELEASED') {
    throw new RunnerContextError('RELEASED', 'RELEASED context 是不可复用历史')
  }
  if (rows.dispatch.state === 'TERMINAL') {
    if (!isTerminalExecutionState(asExecutionState(rows.execution.state))
      || !['SETTLING', 'RELEASING'].includes(rows.lease.state)) {
      throw new RunnerContextError('RELATION_MISMATCH', 'terminal Dispatch 未与终态 Execution/SETTLING Lease 对齐')
    }
    return 'TERMINAL'
  }
  if (rows.dispatch.state === 'CORRELATED') return 'BOUND'
  if (rows.dispatch.state === 'RECEIVED') return 'ACQUIRED'
  if (['INTENDED', 'DISPATCHED'].includes(rows.dispatch.state)) return 'OPEN'
  throw new RunnerContextError('RELATION_MISMATCH', `Dispatch state=${rows.dispatch.state} 不是可消费的 canonical context`)
}

function runnerContextView(
  state: RunnerContextPortState,
  rows: RunnerContextRows,
): RunnerContextView {
  return Object.freeze({
    phase: state.phase,
    kingdomId: state.identity.kingdomId,
    taskId: state.identity.taskId,
    attemptNo: state.identity.attemptNo,
    executionId: state.identity.executionId,
    leaseId: state.identity.leaseId,
    dispatchId: state.identity.dispatchId,
    workerBindingId: state.identity.workerBindingId,
    sessionRef: state.identity.sessionRef,
    dispatchState: rows.dispatch.state,
    executionState: rows.execution.state,
    leaseState: rows.lease.state,
    version: state.currentVersion,
  })
}

/**
 * Product-side canonical Runner context.  It is intentionally not a DB handle
 * and exposes only bounded identifiers/state views to a Runner.
 */
export class RunnerContextPort {
  /** @internal The module-private secret is the only accepted constructor key. */
  constructor(key: symbol) {
    if (key !== RUNNER_CONTEXT_SECRET) throw new Error('RunnerContextPort: private constructor')
  }

  get handle(): RunnerContextHandle {
    const state = runnerContextPortStates.get(this)
    if (!state) throw new RunnerContextError('INVALID_HANDLE', 'port instance 未被产品工厂签发')
    return state.handle
  }

  get initialVersion(): RunnerContextVersion {
    const state = runnerContextPortStates.get(this)
    if (!state) throw new RunnerContextError('INVALID_VERSION', 'port instance 未被产品工厂签发')
    return state.currentVersion
  }

  /** Product-internal phase probe used by the child broker lifecycle. */
  get currentPhase(): RunnerContextPhase {
    return this.state().phase
  }

  private state(): RunnerContextPortState {
    const state = runnerContextPortStates.get(this)
    if (!state) throw new RunnerContextError('INVALID_HANDLE', '伪造或复制的 RunnerContextPort')
    return state
  }

  private consume(
    handle: RunnerContextHandle,
    version: RunnerContextVersion,
    operation: string,
    allowed: readonly RunnerContextPhase[],
  ): { state: RunnerContextPortState; rows: RunnerContextRows } {
    const state = this.state()
    if (!(handle instanceof RunnerContextHandle) || handle !== state.handle
      || runnerContextHandleStates.get(handle)?.store !== state.store) {
      state.poisoned = `invalid handle at ${operation}`
      state.phase = 'INVALID'
      throw new RunnerContextError('INVALID_HANDLE', `${operation} 使用了伪造/复制/cross-context handle`)
    }
    if (!(version instanceof RunnerContextVersion)) {
      state.poisoned = `invalid version at ${operation}`
      state.phase = 'INVALID'
      throw new RunnerContextError('INVALID_VERSION', `${operation} 的 version 不是产品签发 token`)
    }
    const versionState = runnerContextVersionStates.get(version)
    const currentVersionState = runnerContextVersionStates.get(state.currentVersion)
    if (!versionState || !currentVersionState || versionState.port !== this
      || currentVersionState.port !== this || state.currentVersion !== version
      || versionState.sequence !== currentVersionState.sequence) {
      throw new RunnerContextError('STALE_VERSION', `${operation} 使用了错误、复制或已消费的 version`)
    }
    if (state.poisoned) throw new RunnerContextError('INVALID_ORDER', state.poisoned)
    if (!allowed.includes(state.phase) || versionState.phase !== state.phase) {
      throw new RunnerContextError('INVALID_ORDER', `${operation} 不能从 phase=${state.phase} 执行`)
    }
    const rows = runnerContextRows(state.store, state.identity.dispatchId)
    const actualKey = runnerContextRelationKey(state.store, rows)
    if (actualKey !== versionState.relationKey) {
      state.poisoned = `stale canonical relation at ${operation}`
      state.phase = 'INVALID'
      throw new RunnerContextError('STALE_VERSION', `${operation} 前 exact relation/version 已变化`)
    }
    return { state, rows }
  }

  private advance(state: RunnerContextPortState, rows: RunnerContextRows, phase: RunnerContextPhase): RunnerContextVersion {
    state.phase = phase
    const currentVersionState = runnerContextVersionStates.get(state.currentVersion)
    if (!currentVersionState || currentVersionState.port !== this) {
      state.poisoned = `trusted version metadata missing at ${phase}`
      state.phase = 'INVALID'
      throw new RunnerContextError('INVALID_VERSION', `无法从内部可信 metadata 推进 ${phase} version`)
    }
    // Never derive the next sequence from the public token field. The public
    // diagnostic projection may be shadowed or mutated by a runtime caller;
    // this internal record is the only source of monotonicity.
    const sequence = currentVersionState.sequence + 1
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      state.poisoned = `trusted version sequence overflow at ${phase}`
      state.phase = 'INVALID'
      throw new RunnerContextError('INVALID_VERSION', `内部可信 version sequence 无法推进：${sequence}`)
    }
    const version = new RunnerContextVersion(RUNNER_CONTEXT_SECRET, sequence)
    registerRunnerContextVersion(version, {
      port: this,
      sequence,
      relationKey: runnerContextRelationKey(state.store, rows),
      phase,
    })
    state.currentVersion = version
    return version
  }

  read(handle: RunnerContextHandle, version: RunnerContextVersion): RunnerContextView {
    const { state, rows } = this.consume(handle, version, 'read', ['OPEN', 'ACQUIRED', 'BOUND', 'TERMINAL'])
    this.advance(state, rows, state.phase)
    return runnerContextView(state, rows)
  }

  /**
   * Non-mutating Product-child snapshot.  A broker read may observe the
   * bounded view without consuming the version that the Product uses for its
   * next receipt/correlation/terminal/settlement mutation.
   */
  brokerSnapshot(): RunnerContextView {
    const state = this.state()
    if (state.phase === 'INVALID') {
      throw new RunnerContextError('INVALID_ORDER', 'invalid RunnerContext 不可通过 broker 读取')
    }
    const rows = runnerContextRows(state.store, state.identity.dispatchId)
    const versionState = runnerContextVersionStates.get(state.currentVersion)
    if (!versionState || versionState.port !== this
      || runnerContextRelationKey(state.store, rows) !== versionState.relationKey) {
      state.poisoned = 'stale canonical relation at brokerSnapshot'
      state.phase = 'INVALID'
      throw new RunnerContextError('STALE_VERSION', 'broker snapshot 前 exact relation/version 已变化')
    }
    return runnerContextView(state, rows)
  }

  acquire(handle: RunnerContextHandle, version: RunnerContextVersion): RunnerContextView {
    const { state, rows } = this.consume(handle, version, 'acquire', ['OPEN'])
    if (rows.dispatch.state !== 'INTENDED' || rows.execution.state !== 'STARTING' || rows.lease.state !== 'EXECUTING') {
      throw new RunnerContextError('INVALID_ORDER', 'acquire 要求 INTENDED/STARTING/EXECUTING canonical relation')
    }
    this.advance(state, rows, 'ACQUIRED')
    return runnerContextView(state, rows)
  }

  private mutate<T>(
    handle: RunnerContextHandle,
    version: RunnerContextVersion,
    operation: string,
    allowed: readonly RunnerContextPhase[],
    before: (rows: RunnerContextRows) => void,
    action: (context: RunnerContextActionContext) => T,
    after: (rows: RunnerContextRows) => RunnerContextPhase,
  ): RunnerContextMutationResult<T> {
    const { state, rows } = this.consume(handle, version, operation, allowed)
    before(rows)
    const context: RunnerContextActionContext = Object.freeze({
      handle: state.handle,
      version,
      view: runnerContextView(state, rows),
    })
    let value: T
    try {
      value = action(context)
    } catch (error: unknown) {
      state.poisoned = `${operation} action failed`
      state.phase = 'INVALID'
      throw error
    }
    let afterRows: RunnerContextRows
    let nextPhase: RunnerContextPhase
    try {
      afterRows = runnerContextRows(state.store, state.identity.dispatchId)
      nextPhase = after(afterRows)
    } catch (error: unknown) {
      state.poisoned = `${operation} postcondition failed`
      state.phase = 'INVALID'
      throw error
    }
    this.advance(state, afterRows, nextPhase)
    return { value, view: runnerContextView(state, afterRows) }
  }

  bindRuntimeReceipt<T>(
    handle: RunnerContextHandle,
    version: RunnerContextVersion,
    runtimeDispatchRef: string,
    action: (context: RunnerContextActionContext) => T,
  ): RunnerContextMutationResult<T> {
    runnerContextToken(runtimeDispatchRef, 'runtimeDispatchRef')
    return this.mutate(
      handle,
      version,
      'bindRuntimeReceipt',
      ['ACQUIRED'],
      rows => {
        if (!['INTENDED', 'DISPATCHED'].includes(rows.dispatch.state)
          || rows.execution.state !== 'STARTING'
          || rows.lease.state !== 'EXECUTING') {
          throw new RunnerContextError('INVALID_ORDER', 'bindRuntimeReceipt 前 canonical relation 已乱序')
        }
      },
      context => action(Object.freeze({ ...context, runtimeDispatchRef })),
      rows => {
        if (rows.dispatch.state !== 'RECEIVED'
          || rows.dispatch.runtime_dispatch_ref !== runtimeDispatchRef
          || rows.execution.state !== 'STARTING'
          || rows.lease.state !== 'EXECUTING') {
          throw new RunnerContextError('RELATION_MISMATCH', 'runtime receipt 未绑定到同一 Dispatch/Lease/Session')
        }
        return 'BOUND'
      },
    )
  }

  /**
   * RECEIVED → CORRELATED plus Execution STARTING → RUNNING under the same
   * opaque port/version.  The dispatch service supplies the Core write as the
   * in-port action; callers cannot correlate by using the legacy standalone
   * function outside this seam.
   */
  correlateRuntimeExecution<T>(
    handle: RunnerContextHandle,
    version: RunnerContextVersion,
    runtimeExecutionRef: string,
    action: (context: RunnerContextActionContext) => T,
  ): RunnerContextMutationResult<T> {
    runnerContextToken(runtimeExecutionRef, 'runtimeExecutionRef')
    return this.mutate(
      handle,
      version,
      'correlateRuntimeExecution',
      ['BOUND'],
      rows => {
        if (rows.dispatch.state !== 'RECEIVED'
          || rows.execution.state !== 'STARTING'
          || rows.lease.state !== 'EXECUTING') {
          throw new RunnerContextError('INVALID_ORDER', 'correlateRuntimeExecution 前 canonical relation 已乱序')
        }
      },
      context => action(Object.freeze({ ...context, runtimeExecutionRef })),
      rows => {
        if (rows.dispatch.state !== 'CORRELATED'
          || rows.dispatch.runtime_execution_ref !== runtimeExecutionRef
          || rows.execution.state !== 'RUNNING'
          || rows.lease.state !== 'EXECUTING') {
          throw new RunnerContextError('RELATION_MISMATCH', 'runtime execution correlation 未绑定到同一 Dispatch/Execution/Lease')
        }
        return 'BOUND'
      },
    )
  }

  observeTerminal<T>(
    handle: RunnerContextHandle,
    version: RunnerContextVersion,
    action: (context: RunnerContextActionContext) => T,
  ): RunnerContextMutationResult<T> {
    return this.mutate(
      handle,
      version,
      'observeTerminal',
      ['BOUND'],
      rows => {
        if (!['RECEIVED', 'CORRELATED'].includes(rows.dispatch.state)
          || !['STARTING', 'RUNNING'].includes(rows.execution.state)
          || rows.lease.state !== 'EXECUTING') {
          throw new RunnerContextError('INVALID_ORDER', 'observeTerminal 前 canonical relation 已乱序')
        }
      },
      action,
      rows => {
        if (rows.dispatch.state !== 'TERMINAL'
          || !isTerminalExecutionState(asExecutionState(rows.execution.state))
          || rows.lease.state !== 'SETTLING') {
          throw new RunnerContextError('RELATION_MISMATCH', 'terminal 未同时落在 Dispatch/Execution/Lease exact relation')
        }
        return 'TERMINAL'
      },
    )
  }

  settle<T>(
    handle: RunnerContextHandle,
    version: RunnerContextVersion,
    action: (context: RunnerContextActionContext) => T,
  ): RunnerContextMutationResult<T> {
    return this.mutate(
      handle,
      version,
      'settle',
      ['TERMINAL'],
      rows => {
        if (rows.dispatch.state !== 'TERMINAL'
          || !isTerminalExecutionState(asExecutionState(rows.execution.state))
          || !['SETTLING', 'RELEASING'].includes(rows.lease.state)) {
          throw new RunnerContextError('INVALID_ORDER', 'settle 前不是同一 terminal relation')
        }
      },
      action,
      rows => {
        if (rows.dispatch.state !== 'TERMINAL'
          || !isTerminalExecutionState(asExecutionState(rows.execution.state))) {
          throw new RunnerContextError('RELATION_MISMATCH', 'settle 改写了 terminal Dispatch/Execution 或 relation 丢失')
        }
        if (rows.lease.state === 'RELEASED') return 'RELEASED'
        if (rows.lease.state === 'RECOVERING') return 'RECOVERING'
        throw new RunnerContextError('RELATION_MISMATCH', `settle 未产生 RELEASED/RECOVERING（${rows.lease.state}）`)
      },
    )
  }
}

/**
 * Mint a Runner context only after the DB has committed a canonical Dispatch
 * relation.  The factory never accepts caller-supplied Task/Lease/Session IDs
 * as authority; it derives all relation fields from the exact Dispatch row.
 */
export function createRunnerContextPort(
  store: KingdomStore,
  input: string | { readonly dispatchId: string },
): RunnerContextPort {
  const dispatchId = typeof input === 'string' ? input : input.dispatchId
  const rows = runnerContextRows(store, dispatchId)
  const phase = runnerContextInitialPhase(rows)
  const identity: RunnerContextIdentity = {
    kingdomId: rows.dispatch.kingdom_id,
    taskId: rows.task.task_id,
    attemptNo: rows.dispatch.attempt_no,
    executionId: rows.execution.execution_id,
    leaseId: rows.lease.lease_id,
    dispatchId: rows.dispatch.dispatch_id,
    workerBindingId: rows.lease.worker_binding_id,
    sessionRef: rows.lease.session_ref,
  }
  const handle = new RunnerContextHandle(RUNNER_CONTEXT_SECRET)
  runnerContextHandleStates.set(handle, { ...identity, store })
  const port = new RunnerContextPort(RUNNER_CONTEXT_SECRET)
  const state = {
    store,
    handle,
    identity,
    phase,
    currentVersion: undefined as unknown as RunnerContextVersion,
    poisoned: null,
  } satisfies RunnerContextPortState
  runnerContextPortStates.set(port, state)
  const version = new RunnerContextVersion(RUNNER_CONTEXT_SECRET, 0)
  registerRunnerContextVersion(version, {
    port,
    sequence: 0,
    relationKey: runnerContextRelationKey(store, rows),
    phase,
  })
  state.currentVersion = version
  return port
}

/** 期望旧态与当前库态不一致（CAS 失败）。 */
export class StaleLeaseError extends StaleStateError {}
export class StaleDispatchError extends StaleStateError {}

function requireV4(store: KingdomStore): void {
  if (!store.isSchemaV4) throw new SchemaV4NotMigratedError()
}

function now(): string {
  return new Date().toISOString()
}

interface EventSeed {
  kingdomId: string
  eventType: string
  targetType: string
  targetId: string
  payload?: Record<string, unknown>
}

/** 在事务内追加治理事件（appendEvent 已支持嵌套事务）。 */
function emit(store: KingdomStore, seed: EventSeed): void {
  store.appendEvent({
    event_id: randomUUID(),
    kingdom_id: seed.kingdomId,
    event_type: seed.eventType,
    actor_role: 'SYSTEM',
    actor_id: 'kingdom-core',
    target_type: seed.targetType,
    target_id: seed.targetId,
    payload_json: JSON.stringify(seed.payload ?? {}),
    created_at: now(),
  })
}

// ── 1. Affinity（Session ↔ Territory）───────────────────────────────────────

export interface EstablishAffinityInput {
  kingdomId: string
  /** 须为 ACTIVE 的 WORKER binding（v0.8 Worker 模型）。 */
  workerBindingId: string
  session: SessionIdentity
  /** 须为本王国 ACTIVE Territory。 */
  territoryId: string
  affinityId?: string
  establishedAt?: string
}

/** 建立 Affinity（v6 I-5：session identity 唯一、一 Worker 一 current；DB 唯一索引/CHECK 权威强制）。 */
export function establishAffinity(store: KingdomStore, input: EstablishAffinityInput): AffinityRow {
  requireV4(store)
  const binding = store.getBindingById(input.workerBindingId)
  if (!binding || binding.role_type !== 'WORKER' || binding.status !== 'ACTIVE') {
    throw new GovernedApiError(`establishAffinity: worker binding ${input.workerBindingId} 不存在或非 ACTIVE WORKER`)
  }
  const territory = store.getTerritoryById(input.territoryId)
  if (!territory || territory.kingdom_id !== input.kingdomId || territory.status === 'DELETED') {
    throw new GovernedApiError(`establishAffinity: territory ${input.territoryId} 不存在、非本王国或已删除`)
  }
  return store.withImmediateTransaction(() => {
    const at = input.establishedAt ?? now()
    const row: AffinityRow = {
      affinity_id: input.affinityId ?? randomUUID(),
      kingdom_id: input.kingdomId,
      worker_binding_id: input.workerBindingId,
      runtime_type: input.session.runtimeType,
      runtime_instance_ref: input.session.runtimeInstanceRef,
      session_ref: input.session.sessionRef,
      territory_id: input.territoryId,
      established_at: at,
      retired_at: null,
      is_current: 1,
      created_at: at,
    }
    const inserted = store.insertAffinity(row)
    emit(store, {
      kingdomId: input.kingdomId,
      eventType: 'AFFINITY_ESTABLISHED',
      targetType: 'affinity',
      targetId: inserted.affinity_id,
      payload: { worker: input.workerBindingId, session: input.session, territory: input.territoryId },
    })
    return inserted
  })
}

/** 退役 Affinity（v6：唯一合法联合转换 (1,NULL)→(0,val) 且只能一次；跨 Territory 必须新 Session）。 */
export function retireAffinity(store: KingdomStore, affinityId: string, retiredAt?: string): AffinityRow {
  requireV4(store)
  const current = store.getAffinity(affinityId)
  if (!current) throw new GovernedApiError(`retireAffinity: affinity ${affinityId} 不存在`)
  if (current.is_current === 0) throw new GovernedApiError(`retireAffinity: affinity ${affinityId} 已退役（不可二次退役）`)
  return store.withImmediateTransaction(() => {
    const updated = store.retireAffinityRow(affinityId, retiredAt ?? now())
    if (!updated) throw new GovernedApiError(`retireAffinity: affinity ${affinityId} 更新后消失`)
    emit(store, {
      kingdomId: current.kingdom_id,
      eventType: 'AFFINITY_RETIRED',
      targetType: 'affinity',
      targetId: affinityId,
      payload: { session: current.session_ref, territory: current.territory_id, retiredAt: updated.retired_at },
    })
    return updated
  })
}

// ── 2. Execution Lease ────────────────────────────────────────────────────────

export interface AcquireLeaseInput {
  kingdomId: string
  workerBindingId: string
  session: SessionIdentity
  territoryId: string
  taskId: string
  attemptNo: number
  leaseId?: string
  acquiredAt?: string
}

/** acquire Lease（v6 I-11：acquire 时验证 current Affinity + Task Territory 闭环；trigger 权威强制）。 */
export function acquireExecutionLease(store: KingdomStore, input: AcquireLeaseInput): LeaseRow {
  requireV4(store)
  const task = store.getTask(input.taskId)
  if (!task) throw new GovernedApiError(`acquireExecutionLease: task ${input.taskId} 不存在`)
  if (task.territory_id !== input.territoryId) {
    throw new GovernedApiError(`acquireExecutionLease: task ${input.taskId} 的 territory ${task.territory_id} ≠ lease territory ${input.territoryId}`)
  }
  return store.withImmediateTransaction(() => {
    const at = input.acquiredAt ?? now()
    const row: LeaseRow = {
      lease_id: input.leaseId ?? randomUUID(),
      kingdom_id: input.kingdomId,
      worker_binding_id: input.workerBindingId,
      runtime_type: input.session.runtimeType,
      runtime_instance_ref: input.session.runtimeInstanceRef,
      session_ref: input.session.sessionRef,
      territory_id: input.territoryId,
      task_id: input.taskId,
      attempt_no: input.attemptNo,
      state: 'ACQUIRED',
      capability_decision_id: null,
      enforcement_plan_snapshot: null,
      release_evidence_json: null,
      release_reason: null,
      acquired_at: at,
      released_at: null,
      updated_at: at,
    }
    const inserted = store.insertLease(row)
    emit(store, {
      kingdomId: input.kingdomId,
      eventType: 'LEASE_ACQUIRED',
      targetType: 'lease',
      targetId: inserted.lease_id,
      payload: { task: input.taskId, attempt: input.attemptNo, session: input.session, worker: input.workerBindingId },
    })
    return inserted
  })
}

export interface AdvanceLeaseInput {
  plan?: string | null
  decisionId?: string | null
  releaseEvidence?: string | null
  releaseReason?: string | null
  releasedAt?: string | null
}

/** 单一既有事务内推进 Lease；调用方必须持有 withImmediateTransaction。 */
function advanceLeaseStateInTransaction(
  store: KingdomStore,
  lease: LeaseRow,
  to: string,
  extra: AdvanceLeaseInput = {},
  at = now(),
): LeaseRow {
  const updated = store.updateLeaseState(lease.lease_id, lease.state, to, {
    plan: extra.plan,
    decisionId: extra.decisionId,
    releaseEvidence: extra.releaseEvidence,
    releaseReason: extra.releaseReason,
    releasedAt: extra.releasedAt,
  }, at)
  emit(store, {
    kingdomId: lease.kingdom_id,
    eventType: 'LEASE_STATE_CHANGED',
    targetType: 'lease',
    targetId: lease.lease_id,
    payload: { from: lease.state, to, plan: extra.plan !== undefined, decisionId: extra.decisionId ?? undefined },
  })
  return updated
}

/** CAS 推进 Lease 状态（转移合法性由 lease_state_guard trigger 权威执行）。 */
export function advanceLeaseState(store: KingdomStore, leaseId: string, to: string, extra: AdvanceLeaseInput = {}): LeaseRow {
  requireV4(store)
  const lease = store.getLease(leaseId)
  if (!lease) throw new GovernedApiError(`advanceLeaseState: lease ${leaseId} 不存在`)
  if (lease.state === 'RELEASED' && to === 'RELEASED') return lease
  return store.withImmediateTransaction(() => advanceLeaseStateInTransaction(store, lease, to, extra))
}

/** 写 Enforcement Plan（一次 NULL→value；lease_plan_once trigger 强制）。 */
export function setLeasePlan(store: KingdomStore, leaseId: string, planJson: string): LeaseRow {
  return advanceLeaseState(store, leaseId, store.getLease(leaseId)!.state, { plan: planJson })
}

/** late-bind Capability Decision（一次 NULL→value；lease_decision_once trigger 强制）。 */
export function bindCapabilityDecision(store: KingdomStore, leaseId: string, decisionId: string): LeaseRow {
  const lease = store.getLease(leaseId)
  if (!lease) throw new GovernedApiError(`bindCapabilityDecision: lease ${leaseId} 不存在`)
  if (lease.capability_decision_id !== null) {
    throw new GovernedApiError(`bindCapabilityDecision: lease ${leaseId} 已绑定 ${lease.capability_decision_id}（不可重绑）`)
  }
  return advanceLeaseState(store, leaseId, lease.state, { decisionId })
}

/**
 * release Lease（v6：仅 RELEASED 释放；必须带 release/cleanup evidence + released_at；
 * cleanup 不明 → 进 RECOVERING，禁止直接 RELEASED）。
 */
export function releaseExecutionLease(store: KingdomStore, leaseId: string, evidence: Record<string, unknown>, reason: string): LeaseRow {
  requireV4(store)
  const lease = store.getLease(leaseId)
  if (!lease) throw new GovernedApiError(`releaseExecutionLease: lease ${leaseId} 不存在`)
  if (lease.state === 'RELEASED') return lease
  const releasableFrom = new Set(['MATERIALIZING', 'RELEASING', 'RECOVERING'])
  if (!releasableFrom.has(lease.state)) {
    throw new GovernedApiError(`releaseExecutionLease: lease ${leaseId} 不能从 ${lease.state} 释放（合法：MATERIALIZING/RELEASING/RECOVERING）`)
  }
  return store.withImmediateTransaction(() => {
    const at = now()
    const updated = store.updateLeaseState(leaseId, lease.state, 'RELEASED', {
      releaseEvidence: JSON.stringify({ type: 'ReleaseEvidence/v1', payload: evidence }),
      releaseReason: reason,
      releasedAt: at,
    }, at)
    emit(store, {
      kingdomId: lease.kingdom_id,
      eventType: 'LEASE_RELEASED',
      targetType: 'lease',
      targetId: leaseId,
      payload: { reason, session: lease.session_ref },
    })
    return updated
  })
}

// ── 3. Capability Decision ───────────────────────────────────────────────────

export interface RecordDecisionInput {
  kingdomId: string
  taskId: string
  workerBindingId?: string | null
  supervisorBindingId?: string | null
  requirementSnapshot?: string | null
  ceilingSnapshot?: string | null
  proposedGrantSnapshot?: string | null
  scopeSnapshot?: string | null
  effectiveSnapshot?: string | null
  decision: 'GRANTED' | 'DENIED'
  enforcementStatus: 'ENFORCED' | 'NOT_ATTEMPTED' | 'UNAVAILABLE' | 'FAILED'
  enforcementEvidenceJson?: string | null
  requirementCoverage?: 'FULL' | 'PARTIAL' | 'NONE'
  reasonCode?: string | null
  decisionId?: string
  createdAt?: string
}

/** 落 Final Capability Decision（合法组合由行内双向 CHECK 权威强制；创建后不可改写）。 */
export function recordCapabilityDecision(store: KingdomStore, input: RecordDecisionInput): CapabilityDecisionRow {
  requireV4(store)
  if (input.decision === 'GRANTED' && input.enforcementStatus !== 'ENFORCED') {
    throw new GovernedApiError(`recordCapabilityDecision: GRANTED 只能配 ENFORCED（收到 ${input.enforcementStatus}）`)
  }
  if (input.decision === 'DENIED' && input.enforcementStatus === 'ENFORCED') {
    throw new GovernedApiError('recordCapabilityDecision: DENIED 不能配 ENFORCED')
  }
  return store.withImmediateTransaction(() => {
    const row: CapabilityDecisionRow = {
      decision_id: input.decisionId ?? randomUUID(),
      kingdom_id: input.kingdomId,
      task_id: input.taskId,
      worker_binding_id: input.workerBindingId ?? null,
      supervisor_binding_id: input.supervisorBindingId ?? null,
      requirement_snapshot: input.requirementSnapshot ?? null,
      ceiling_snapshot: input.ceilingSnapshot ?? null,
      proposed_grant_snapshot: input.proposedGrantSnapshot ?? null,
      scope_snapshot: input.scopeSnapshot ?? null,
      effective_snapshot: input.effectiveSnapshot ?? null,
      decision: input.decision,
      enforcement_status: input.enforcementStatus,
      enforcement_evidence_json: input.enforcementEvidenceJson ?? null,
      requirement_coverage: input.requirementCoverage ?? 'NONE',
      reason_code: input.reasonCode ?? null,
      execution_id: null,
      created_at: input.createdAt ?? now(),
    }
    const inserted = store.insertCapabilityDecision(row)
    emit(store, {
      kingdomId: input.kingdomId,
      eventType: 'CAPABILITY_DECISION_RECORDED',
      targetType: 'decision',
      targetId: inserted.decision_id,
      payload: { task: input.taskId, decision: input.decision, enforcementStatus: input.enforcementStatus },
    })
    return inserted
  })
}

// ── 4. Governed Execution ────────────────────────────────────────────────────

export interface CreateGovernedExecutionInput {
  taskId: string
  attemptNo: number
  workerBindingId: string
  leaseId: string
  capabilityDecisionId: string
  sessionId?: string | null
  executionId?: string
  startedAt?: string
  detail?: string | null
}

interface PreparedExecutionRows {
  execution: ExecutionRow
  decision: CapabilityDecisionRow
}

/** 单一既有事务内创建 governed Execution 并绑定 Decision。 */
function createGovernedExecutionInTransaction(
  store: KingdomStore,
  input: CreateGovernedExecutionInput,
): PreparedExecutionRows {
  const lease = store.getLease(input.leaseId)
  if (!lease) throw new GovernedApiError(`createGovernedExecution: lease ${input.leaseId} 不存在`)
  const decision = store.getCapabilityDecision(input.capabilityDecisionId)
  if (!decision) throw new GovernedApiError(`createGovernedExecution: decision ${input.capabilityDecisionId} 不存在`)

  const at = input.startedAt ?? now()
  const executionId = input.executionId ?? randomUUID()
  const row: ExecutionRow = {
    execution_id: executionId,
    task_id: input.taskId,
    attempt_no: input.attemptNo,
    worker_binding_id: input.workerBindingId,
    session_id: input.sessionId ?? lease.session_ref,
    state: 'STARTING',
    detail: input.detail ?? null,
    started_at: at,
    heartbeat_at: at,
    ended_at: null,
    pause_requested_at: null,
    executor_kind: null,
    provider: null,
    provider_source: null,
    requested_model: null,
    resolved_model: null,
    model_source: null,
    execution_profile_json: null,
    execution_contract: 'GOVERNED_PERSISTENT',
    lease_id: input.leaseId,
    capability_decision_id: input.capabilityDecisionId,
  }
  const execution = store.insertExecution(row)
  const boundDecision = store.bindDecisionExecution(input.capabilityDecisionId, executionId)
  if (!boundDecision || boundDecision.execution_id !== executionId) {
    throw new GovernedApiError(
      `createGovernedExecution: decision ${input.capabilityDecisionId} 未能绑定 execution ${executionId}`,
    )
  }
  emit(store, {
    kingdomId: lease.kingdom_id,
    eventType: 'EXECUTION_GOVERNED_CREATED',
    targetType: 'execution',
    targetId: executionId,
    payload: { task: input.taskId, attempt: input.attemptNo, lease: input.leaseId, decision: input.capabilityDecisionId },
  })
  return { execution, decision: boundDecision }
}

/**
 * 创建 GOVERNED_PERSISTENT Execution（TX-3 第一步）：
 * 同一事务内：写 Execution（FK+consistency trigger 校验 Lease/Decision 存在且一致）→
 * 回填 Decision.execution_id（单绑，GRANTED+ENFORCED only）。
 */
export function createGovernedExecution(store: KingdomStore, input: CreateGovernedExecutionInput): ExecutionRow {
  requireV4(store)
  return store.withImmediateTransaction(() => createGovernedExecutionInTransaction(store, input).execution)
}

// ── 5. Dispatch Intent / Evidence ────────────────────────────────────────────

export interface CreateDispatchIntentInput {
  kingdomId: string
  leaseId: string
  executionId: string
  taskId: string
  attemptNo: number
  session: SessionIdentity
  requestSnapshot: string
  inputRefJson: string
  payloadHash: string
  dispatchId?: string
  createdAt?: string
}

/** 单一既有事务内写入 Dispatch Intent。 */
function createDispatchIntentInTransaction(
  store: KingdomStore,
  input: CreateDispatchIntentInput,
): DispatchRecordRow {
  const execution = store.getExecution(input.executionId)
  if (!execution) throw new GovernedApiError(`createDispatchIntent: execution ${input.executionId} 不存在`)
  const lease = store.getLease(input.leaseId)
  if (!lease) throw new GovernedApiError(`createDispatchIntent: lease ${input.leaseId} 不存在`)

  const at = input.createdAt ?? now()
  const row: DispatchRecordRow = {
    dispatch_id: input.dispatchId ?? randomUUID(),
    kingdom_id: input.kingdomId,
    lease_id: input.leaseId,
    execution_id: input.executionId,
    task_id: input.taskId,
    attempt_no: input.attemptNo,
    runtime_type: input.session.runtimeType,
    runtime_instance_ref: input.session.runtimeInstanceRef,
    session_ref: input.session.sessionRef,
    state: 'INTENDED',
    dispatch_request_snapshot: input.requestSnapshot,
    dispatch_input_ref_json: input.inputRefJson,
    dispatch_payload_hash: input.payloadHash,
    runtime_dispatch_ref: null,
    runtime_execution_ref: null,
    receipt_json: null,
    terminal_evidence_json: null,
    output_ref_json: null,
    dispatched_at: null,
    receipt_at: null,
    terminal_at: null,
    created_at: at,
    updated_at: at,
  }
  const intent = store.insertDispatchIntent(row)
  emit(store, {
    kingdomId: input.kingdomId,
    eventType: 'DISPATCH_INTENDED',
    targetType: 'dispatch',
    targetId: intent.dispatch_id,
    payload: { lease: input.leaseId, execution: input.executionId, task: input.taskId, attempt: input.attemptNo },
  })
  return intent
}

/**
 * 写 Dispatch INTENDED（TX-3 的 COMMIT POINT）：
 * Runtime side effect（dispatch()）之前必须已持久化本记录；
 * 调用方在本函数返回（事务已提交）**之后**才允许调用 RuntimeAdapter.dispatch()。
 */
export function createDispatchIntent(store: KingdomStore, input: CreateDispatchIntentInput): DispatchRecordRow {
  requireV4(store)
  return store.withImmediateTransaction(() => createDispatchIntentInTransaction(store, input))
}

export interface PrepareGovernedDispatchInput {
  kingdomId: string
  taskId: string
  attemptNo: number
  workerBindingId: string
  leaseId: string
  capabilityDecisionId: string
  session: SessionIdentity
  requestSnapshot: string
  inputRefJson: string
  payloadHash: string
  executionId?: string
  dispatchId?: string
  preparedAt?: string
  detail?: string | null
}

export interface PreparedGovernedDispatchRows {
  execution: ExecutionRow
  decision: CapabilityDecisionRow
  intent: DispatchRecordRow
  lease: LeaseRow
}

/**
 * TX-3 COMMIT POINT：在一个真实事务内同时准备 Execution、Decision binding、
 * Dispatch Intent 与 EXECUTING Lease。这里仅调用无事务的 Store primitive，
 * 不能嵌套现有 create/advance public helper。
 */
export function prepareGovernedDispatch(
  store: KingdomStore,
  input: PrepareGovernedDispatchInput,
): PreparedGovernedDispatchRows {
  requireV4(store)
  return store.withImmediateTransaction(() => {
    const preparedAt = input.preparedAt ?? now()
    const startingLease = store.getLease(input.leaseId)
    if (!startingLease) throw new GovernedApiError(`prepareGovernedDispatch: lease ${input.leaseId} 不存在`)
    if (startingLease.state !== 'DISPATCH_READY') {
      throw new GovernedApiError(
        `prepareGovernedDispatch: lease ${input.leaseId} 状态 ${startingLease.state} ≠ DISPATCH_READY`,
      )
    }
    const leaseMatches = startingLease.kingdom_id === input.kingdomId
      && startingLease.task_id === input.taskId
      && startingLease.attempt_no === input.attemptNo
      && startingLease.worker_binding_id === input.workerBindingId
      && startingLease.capability_decision_id === input.capabilityDecisionId
      && startingLease.runtime_type === input.session.runtimeType
      && startingLease.runtime_instance_ref === input.session.runtimeInstanceRef
      && startingLease.session_ref === input.session.sessionRef
    if (!leaseMatches) {
      throw new GovernedApiError(
        `prepareGovernedDispatch: lease ${input.leaseId} 与 Task/Worker/Decision/Session identity 不一致`,
      )
    }
    const startingDecision = store.getCapabilityDecision(input.capabilityDecisionId)
    if (!startingDecision) {
      throw new GovernedApiError(`prepareGovernedDispatch: decision ${input.capabilityDecisionId} 不存在`)
    }
    const decisionMatches = startingDecision.kingdom_id === input.kingdomId
      && startingDecision.task_id === input.taskId
      && startingDecision.worker_binding_id === input.workerBindingId
      && startingDecision.decision === 'GRANTED'
      && startingDecision.enforcement_status === 'ENFORCED'
      && startingDecision.execution_id === null
    if (!decisionMatches) {
      throw new GovernedApiError(
        `prepareGovernedDispatch: decision ${input.capabilityDecisionId} 不是当前 Task/Worker 的未绑定 GRANTED+ENFORCED decision`,
      )
    }
    const preparedExecution = createGovernedExecutionInTransaction(store, {
      taskId: input.taskId,
      attemptNo: input.attemptNo,
      workerBindingId: input.workerBindingId,
      leaseId: input.leaseId,
      capabilityDecisionId: input.capabilityDecisionId,
      sessionId: input.session.sessionRef,
      executionId: input.executionId,
      startedAt: preparedAt,
      detail: input.detail,
    })
    const intent = createDispatchIntentInTransaction(store, {
      kingdomId: input.kingdomId,
      leaseId: input.leaseId,
      executionId: preparedExecution.execution.execution_id,
      taskId: input.taskId,
      attemptNo: input.attemptNo,
      session: input.session,
      requestSnapshot: input.requestSnapshot,
      inputRefJson: input.inputRefJson,
      payloadHash: input.payloadHash,
      dispatchId: input.dispatchId,
      createdAt: preparedAt,
    })
    const executingLease = advanceLeaseStateInTransaction(store, startingLease, 'EXECUTING', {}, preparedAt)
    return {
      execution: preparedExecution.execution,
      decision: preparedExecution.decision,
      intent,
      lease: executingLease,
    }
  })
}

export interface ReceiptInput {
  runtimeDispatchRef: string
  receiptJson: string
  at?: string
}

/**
 * 记录 Dispatch Receipt（TX-3R）：
 * INTENDED → DISPATCHED（runtime_dispatch_ref + dispatched_at）→ RECEIVED（receipt_json + receipt_at）。
 * DispatchReceipt 只证明 Runtime 接受了 dispatch，不等于 Terminal Evidence。
 */
export function recordDispatchReceipt(store: KingdomStore, dispatchId: string, input: ReceiptInput): DispatchRecordRow {
  requireV4(store)
  const dispatch = store.getDispatch(dispatchId)
  if (!dispatch) throw new GovernedApiError(`recordDispatchReceipt: dispatch ${dispatchId} 不存在`)
  if (dispatch.state === 'RECEIVED') return dispatch
  const at = input.at ?? now()
  return store.withImmediateTransaction(() => {
    let current = dispatch
    if (current.state === 'INTENDED') {
      current = store.updateDispatchState(dispatchId, 'INTENDED', 'DISPATCHED', {
        runtimeDispatchRef: input.runtimeDispatchRef,
        dispatchedAt: at,
      }, at)
    }
    if (current.state !== 'DISPATCHED') {
      throw new GovernedApiError(`recordDispatchReceipt: dispatch ${dispatchId} 状态 ${current.state} 不能进入 RECEIVED`)
    }
    const updated = store.updateDispatchState(dispatchId, 'DISPATCHED', 'RECEIVED', {
      receiptJson: input.receiptJson,
      receiptAt: at,
    }, at)
    emit(store, {
      kingdomId: dispatch.kingdom_id,
      eventType: 'DISPATCH_STATE_CHANGED',
      targetType: 'dispatch',
      targetId: dispatchId,
      payload: { from: dispatch.state, to: 'RECEIVED', runtimeDispatchRef: input.runtimeDispatchRef },
    })
    return updated
  })
}

/** RECEIVED → CORRELATED（绑定 runtime_execution_ref；TX-3R）。 */
export function correlateRuntimeExecution(store: KingdomStore, dispatchId: string, runtimeExecutionRef: string): DispatchRecordRow {
  requireV4(store)
  const dispatch = store.getDispatch(dispatchId)
  if (!dispatch) throw new GovernedApiError(`correlateRuntimeExecution: dispatch ${dispatchId} 不存在`)
  if (dispatch.state === 'CORRELATED') return dispatch
  if (dispatch.state !== 'RECEIVED') {
    throw new GovernedApiError(`correlateRuntimeExecution: dispatch ${dispatchId} 状态 ${dispatch.state} ≠ RECEIVED`)
  }
  return store.withImmediateTransaction(() => {
    const at = now()
    const updated = store.updateDispatchState(dispatchId, 'RECEIVED', 'CORRELATED', {
      runtimeExecutionRef,
    }, at)
    emit(store, {
      kingdomId: dispatch.kingdom_id,
      eventType: 'DISPATCH_STATE_CHANGED',
      targetType: 'dispatch',
      targetId: dispatchId,
      payload: { from: 'RECEIVED', to: 'CORRELATED', runtimeExecutionRef },
    })
    return updated
  })
}

export interface TerminalEvidenceInput {
  evidenceJson: string
  terminalAt?: string
  /** 若提供，同事务内把 Execution 推到该终态（须合法；结束后自动补 ended_at）。 */
  executionTerminalState?: 'COMPLETED' | 'FAILED' | 'ABORTED'
  /** 若提供，同事务内推进 Lease 到 SETTLING（须处于 EXECUTING）。 */
  settleLease?: boolean
}

/** 记录 Terminal Evidence（TX-4）：CORRELATED → TERMINAL（terminal_evidence_json + terminal_at）。 */
export function recordTerminalEvidence(store: KingdomStore, dispatchId: string, input: TerminalEvidenceInput): {
  dispatch: DispatchRecordRow
  execution?: ExecutionRow
  lease?: LeaseRow
} {
  requireV4(store)
  const dispatch = store.getDispatch(dispatchId)
  if (!dispatch) throw new GovernedApiError(`recordTerminalEvidence: dispatch ${dispatchId} 不存在`)
  if (dispatch.state === 'TERMINAL') return { dispatch }
  if (dispatch.state !== 'CORRELATED') {
    throw new GovernedApiError(`recordTerminalEvidence: dispatch ${dispatchId} 状态 ${dispatch.state} ≠ CORRELATED`)
  }
  const execution = store.getExecution(dispatch.execution_id)
  const lease = store.getLease(dispatch.lease_id)
  return store.withImmediateTransaction(() => {
    const at = input.terminalAt ?? now()
    const updatedDispatch = store.updateDispatchState(dispatchId, 'CORRELATED', 'TERMINAL', {
      terminalEvidenceJson: input.evidenceJson,
      terminalAt: at,
    }, at)
    let updatedExecution: ExecutionRow | undefined
    if (input.executionTerminalState && execution) {
      const to = asExecutionState(input.executionTerminalState)
      if (!isTerminalExecutionState(to)) {
        throw new GovernedApiError(`recordTerminalEvidence: executionTerminalState 必须是终态（收到 ${to}）`)
      }
      updatedExecution = store.transitionExecution(execution, to, { detail: `terminal evidence: ${dispatchId}` })
    }
    let updatedLease: LeaseRow | undefined
    if (input.settleLease && lease) {
      if (lease.state !== 'EXECUTING') {
        throw new GovernedApiError(`recordTerminalEvidence: settleLease 要求 lease ${lease.lease_id} 处于 EXECUTING（实际 ${lease.state}）`)
      }
      updatedLease = store.updateLeaseState(lease.lease_id, 'EXECUTING', 'SETTLING', {}, at)
    }
    emit(store, {
      kingdomId: dispatch.kingdom_id,
      eventType: 'DISPATCH_STATE_CHANGED',
      targetType: 'dispatch',
      targetId: dispatchId,
      payload: { from: 'CORRELATED', to: 'TERMINAL', executionTerminalState: input.executionTerminalState ?? undefined },
    })
    return { dispatch: updatedDispatch, execution: updatedExecution, lease: updatedLease }
  })
}

/** CAS 推进 Dispatch 状态（转移合法性由 dispatch_state_guard trigger 权威执行）。 */
export function advanceDispatchState(
  store: KingdomStore,
  dispatchId: string,
  to: string,
  extra: {
    runtimeDispatchRef?: string | null
    runtimeExecutionRef?: string | null
    receiptJson?: string | null
    terminalEvidenceJson?: string | null
    outputRefJson?: string | null
    dispatchedAt?: string | null
    receiptAt?: string | null
    terminalAt?: string | null
  } = {},
): DispatchRecordRow {
  requireV4(store)
  const dispatch = store.getDispatch(dispatchId)
  if (!dispatch) throw new GovernedApiError(`advanceDispatchState: dispatch ${dispatchId} 不存在`)
  if (dispatch.state === to) return dispatch
  return store.withImmediateTransaction(() => {
    const at = now()
    const updated = store.updateDispatchState(dispatchId, dispatch.state, to, extra, at)
    emit(store, {
      kingdomId: dispatch.kingdom_id,
      eventType: 'DISPATCH_STATE_CHANGED',
      targetType: 'dispatch',
      targetId: dispatchId,
      payload: { from: dispatch.state, to },
    })
    return updated
  })
}

// ── 6. Recovery（RECOVERING 入口；不改 Task 治理状态）────────────────────────

export type GovernedRecoveryReasonCode =
  | 'RECONCILE_UNKNOWN'
  | 'RECONCILE_UNTRUSTED'
  | 'DISPATCH_EXCEPTION'
  | 'TERMINAL_POLL_EXHAUSTED'

export interface GovernedRecoveryRows {
  dispatch: DispatchRecordRow
  lease: LeaseRow
  execution: ExecutionRow
}

/** Bounded, non-runtime-specific reasons for a post-TX-4 integrity incident. */
export type TerminalIntegrityReasonCode =
  | 'TRUST_FENCE_MISSING'
  | 'TRUST_FENCE_EXPECTATION_MISMATCH'
  | 'TRUST_FENCE_CHECK_FAILED'
  | 'TRUST_FENCE_RELEASE_FAILED'

export type TerminalIntegrityPhase = 'settlement' | 'release'

export interface DispatchTerminalIntegrityIncidentInput {
  dispatchId: string
  reasonCode: TerminalIntegrityReasonCode
  phase: TerminalIntegrityPhase
}

export interface DispatchTerminalIntegrityIncidentRows {
  dispatch: DispatchRecordRow
  lease: LeaseRow
  execution: ExecutionRow
  incident: EventRow
  incidentCreated: boolean
  /** RELEASED is deliberately not rolled back; it requires escalation. */
  escalated: boolean
}

/**
 * TX-4 post-terminal integrity seam.
 *
 * This is intentionally separate from markGovernedDispatchRecovering:
 * Dispatch and Execution are already terminal and must remain terminal.  The
 * exact Dispatch/Task/attempt relation is re-read inside one IMMEDIATE
 * transaction, then only a still-recoverable Lease is moved to RECOVERING and
 * one bounded incident event is appended.  Replays are a zero-event readback.
 */
export function recordDispatchTerminalIntegrityIncident(
  store: KingdomStore,
  input: DispatchTerminalIntegrityIncidentInput,
): DispatchTerminalIntegrityIncidentRows {
  requireV4(store)
  return store.withImmediateTransaction(() => {
    const dispatch = store.getDispatch(input.dispatchId)
    if (!dispatch) {
      throw new GovernedApiError(`recordDispatchTerminalIntegrityIncident: dispatch ${input.dispatchId} 不存在`)
    }
    const task = store.getTask(dispatch.task_id)
    const territory = task ? store.getTerritoryById(task.territory_id) : null
    const lease = store.getLease(dispatch.lease_id)
    const execution = store.getExecution(dispatch.execution_id)
    if (!task || !territory || territory.kingdom_id !== dispatch.kingdom_id || !lease || !execution) {
      throw new GovernedApiError(
        `recordDispatchTerminalIntegrityIncident: dispatch ${dispatch.dispatch_id} 的 Task/Lease/Execution 关系无法证明`,
      )
    }

    const exactRelation = dispatch.task_id === task.task_id
      && dispatch.attempt_no > 0
      && lease.kingdom_id === dispatch.kingdom_id
      && lease.task_id === dispatch.task_id
      && lease.attempt_no === dispatch.attempt_no
      && execution.task_id === dispatch.task_id
      && execution.attempt_no === dispatch.attempt_no
      && execution.lease_id === dispatch.lease_id
      && execution.execution_contract === 'GOVERNED_PERSISTENT'
    if (!exactRelation) {
      throw new GovernedApiError(
        `recordDispatchTerminalIntegrityIncident: dispatch ${dispatch.dispatch_id} 的 exact Task/attempt relation 不一致`,
      )
    }
    if (dispatch.state !== 'TERMINAL') {
      throw new GovernedApiError(
        `recordDispatchTerminalIntegrityIncident: dispatch ${dispatch.dispatch_id} 尚未处于 TERMINAL`,
      )
    }
    const executionState = asExecutionState(execution.state)
    if (!isTerminalExecutionState(executionState)) {
      throw new GovernedApiError(
        `recordDispatchTerminalIntegrityIncident: execution ${execution.execution_id} 尚未处于终态`,
      )
    }
    if (!new Set(['SETTLING', 'RELEASING', 'RECOVERING', 'RELEASED']).has(lease.state)) {
      throw new GovernedApiError(
        `recordDispatchTerminalIntegrityIncident: lease ${lease.lease_id} 状态 ${lease.state} 不属于 post-TX-4 处置窗口`,
      )
    }

    const existing = store.getOpenDispatchTerminalIntegrityIncident(
      dispatch.kingdom_id,
      dispatch.dispatch_id,
      dispatch.task_id,
      dispatch.attempt_no,
    )
    const incident = existing ?? store.appendEvent({
      event_id: randomUUID(),
      kingdom_id: dispatch.kingdom_id,
      event_type: 'DISPATCH_TERMINAL_INTEGRITY_INCIDENT',
      actor_role: 'SYSTEM',
      actor_id: 'kingdom-core',
      target_type: 'dispatch',
      target_id: dispatch.dispatch_id,
      payload_json: JSON.stringify({
        incident_code: 'DISPATCH_TERMINAL_INTEGRITY_INCIDENT',
        state: 'OPEN',
        attempt_no: dispatch.attempt_no,
        reason_code: input.reasonCode,
        phase: input.phase,
        relation: 'exact-dispatch-task-attempt',
      }),
      created_at: now(),
    })

    let currentLease = lease
    let escalated = false
    if (lease.state === 'SETTLING' || lease.state === 'RELEASING') {
      const at = now()
      currentLease = store.updateLeaseState(lease.lease_id, lease.state, 'RECOVERING', {
        releaseReason: `terminal integrity incident: ${input.reasonCode}`,
      }, at)
      emit(store, {
        kingdomId: dispatch.kingdom_id,
        eventType: 'LEASE_STATE_CHANGED',
        targetType: 'lease',
        targetId: lease.lease_id,
        payload: { from: lease.state, to: 'RECOVERING', reasonCode: input.reasonCode },
      })
    } else if (lease.state === 'RELEASED') {
      // A released Lease is an immutable historical outcome.  Add the
      // incident for escalation, but never attempt RELEASED → RECOVERING.
      escalated = true
    }

    return {
      dispatch,
      lease: currentLease,
      execution,
      incident,
      incidentCreated: existing === null,
      escalated,
    }
  })
}

/**
 * Atomically move one governed Dispatch, its Lease, and its Execution into
 * RECOVERING. This is shared by reconciliation and terminal-poll timeout.
 *
 * All related rows are re-read and validated before the first write. The
 * low-level CAS updates and recovery events share one transaction; the
 * independently transactional mark* helpers below must not be nested here.
 * Repeating the call after all three rows are RECOVERING is a zero-event,
 * zero-write idempotent readback.
 */
export function markGovernedDispatchRecovering(
  store: KingdomStore,
  dispatchId: string,
  reasonCode: GovernedRecoveryReasonCode,
): GovernedRecoveryRows {
  requireV4(store)
  return store.withImmediateTransaction(() => {
    const dispatch = store.getDispatch(dispatchId)
    if (!dispatch) throw new GovernedApiError(`markGovernedDispatchRecovering: dispatch ${dispatchId} 不存在`)
    const lease = store.getLease(dispatch.lease_id)
    if (!lease) throw new GovernedApiError(`markGovernedDispatchRecovering: lease ${dispatch.lease_id} 不存在`)
    const execution = store.getExecution(dispatch.execution_id)
    if (!execution) throw new GovernedApiError(`markGovernedDispatchRecovering: execution ${dispatch.execution_id} 不存在`)

    const consistent = lease.kingdom_id === dispatch.kingdom_id
      && lease.task_id === dispatch.task_id
      && lease.attempt_no === dispatch.attempt_no
      && execution.task_id === dispatch.task_id
      && execution.attempt_no === dispatch.attempt_no
      && execution.lease_id === dispatch.lease_id
      && execution.execution_contract === 'GOVERNED_PERSISTENT'
    if (!consistent) {
      throw new GovernedApiError(
        `markGovernedDispatchRecovering: dispatch ${dispatchId} 的 Execution/Lease 关联不一致`,
      )
    }

    const recoverableDispatchStates = new Set(['INTENDED', 'DISPATCHED', 'RECEIVED', 'CORRELATED', 'RECOVERING'])
    const recoverableLeaseStates = new Set([
      'ACQUIRED', 'PREPARING', 'MATERIALIZING', 'DISPATCH_READY',
      'EXECUTING', 'SETTLING', 'RELEASING', 'RECOVERING',
    ])
    const executionState = asExecutionState(execution.state)
    if (!recoverableDispatchStates.has(dispatch.state)) {
      throw new GovernedApiError(
        `markGovernedDispatchRecovering: dispatch ${dispatchId} 状态 ${dispatch.state} 不能进入 RECOVERING`,
      )
    }
    if (!recoverableLeaseStates.has(lease.state)) {
      throw new GovernedApiError(
        `markGovernedDispatchRecovering: lease ${lease.lease_id} 状态 ${lease.state} 不能进入 RECOVERING`,
      )
    }
    if (isTerminalExecutionState(executionState)) {
      throw new GovernedApiError(
        `markGovernedDispatchRecovering: execution ${execution.execution_id} 已终结为 ${executionState}`,
      )
    }

    const at = now()
    let currentDispatch = dispatch
    let currentLease = lease
    let currentExecution = execution

    if (dispatch.state !== 'RECOVERING') {
      currentDispatch = store.updateDispatchState(dispatch.dispatch_id, dispatch.state, 'RECOVERING', {}, at)
      emit(store, {
        kingdomId: dispatch.kingdom_id,
        eventType: 'DISPATCH_STATE_CHANGED',
        targetType: 'dispatch',
        targetId: dispatch.dispatch_id,
        payload: { from: dispatch.state, to: 'RECOVERING', reasonCode },
      })
    }
    if (lease.state !== 'RECOVERING') {
      currentLease = store.updateLeaseState(lease.lease_id, lease.state, 'RECOVERING', {}, at)
      emit(store, {
        kingdomId: dispatch.kingdom_id,
        eventType: 'LEASE_STATE_CHANGED',
        targetType: 'lease',
        targetId: lease.lease_id,
        payload: { from: lease.state, to: 'RECOVERING', reasonCode },
      })
    }
    if (executionState !== 'RECOVERING') {
      currentExecution = store.transitionExecution(execution, 'RECOVERING', {
        detail: `recovery required: ${reasonCode}`,
      })
      emit(store, {
        kingdomId: dispatch.kingdom_id,
        eventType: 'EXECUTION_RECOVERING',
        targetType: 'execution',
        targetId: execution.execution_id,
        payload: {
          task: execution.task_id,
          attempt: execution.attempt_no,
          dispatch: dispatch.dispatch_id,
          lease: lease.lease_id,
          from: execution.state,
          reasonCode,
        },
      })
    }

    return { dispatch: currentDispatch, lease: currentLease, execution: currentExecution }
  })
}

/** Lease 进 RECOVERING（RECOVERING 不改 Task 治理状态；仅重建证据）。 */
export function markLeaseRecovering(store: KingdomStore, leaseId: string): LeaseRow {
  const lease = store.getLease(leaseId)
  if (!lease) throw new GovernedApiError(`markLeaseRecovering: lease ${leaseId} 不存在`)
  if (lease.state === 'RECOVERING') return lease
  return advanceLeaseState(store, leaseId, 'RECOVERING')
}

/** Dispatch 进 RECOVERING（Intent 已存在但证据链断裂；禁盲目重发）。 */
export function markDispatchRecovering(store: KingdomStore, dispatchId: string): DispatchRecordRow {
  return advanceDispatchState(store, dispatchId, 'RECOVERING')
}

/** Execution 进 RECOVERING（v6 executions 状态；不改 Task 治理状态）。 */
export function markExecutionRecovering(store: KingdomStore, executionId: string): ExecutionRow {
  requireV4(store)
  const execution = store.getExecution(executionId)
  if (!execution) throw new GovernedApiError(`markExecutionRecovering: execution ${executionId} 不存在`)
  if (execution.state === 'RECOVERING') return execution
  return store.withImmediateTransaction(() => {
    const updated = store.transitionExecution(execution, 'RECOVERING', { detail: 'recovery: evidence reconstruction in progress' })
    emit(store, {
      kingdomId: store.getDefaultKingdom()?.kingdom_id ?? execution.task_id,
      eventType: 'EXECUTION_RECOVERING',
      targetType: 'execution',
      targetId: executionId,
      payload: { task: execution.task_id, attempt: execution.attempt_no },
    })
    return updated
  })
}
