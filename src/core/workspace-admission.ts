import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import type { KingdomStore } from './db.js'

export type WorkspaceAccess = 'READ_ONLY' | 'WRITE'
export interface WorkspaceAdmissionInput {
  kingdomId: string; taskId: string; attemptNo: number; workerBindingId: string
  workspacePath: string; access: WorkspaceAccess
}
interface Reservation extends WorkspaceAdmissionInput {
  type: 'KingdomWorkspaceAdmission/v1'; admissionId: string; workspaceKey: string
  state: 'RESERVED' | 'BOUND' | 'CANCELLED'; leaseId: string | null; dispatchId: string | null
}
declare const WORKSPACE_HANDLE: unique symbol
export interface WorkspaceAdmissionHandle { readonly [WORKSPACE_HANDLE]: true }
interface Live { store: KingdomStore; record: Reservation; closed: boolean }
const handles = new WeakMap<object, Live>()
export class WorkspaceAdmissionError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); this.name = 'WorkspaceAdmissionError' }
}
const deny = (code: string, message: string): never => { throw new WorkspaceAdmissionError(code, message) }

/** Resolve existing aliases. A missing directory is rechecked again before dispatch. */
export function canonicalWorkspaceKey(path: string): string {
  if (!path || typeof path !== 'string') return deny('WORKSPACE_PATH_REQUIRED', '无法确定工作目录。')
  let actual: string
  try { actual = realpathSync.native(path) }
  catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error
    // Resolve the nearest existing ancestor, including junctions, before a
    // missing suffix. Otherwise alias/new and actual/new could both reserve.
    let ancestor = resolve(path)
    const suffix: string[] = []
    for (;;) {
      try { actual = resolve(realpathSync.native(ancestor), ...suffix); break }
      catch (nested) {
        if ((nested as { code?: string }).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw nested
        suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor)
      }
    }
  }
  const normalized = actual.replaceAll('\\', '/').replace(/\/+$/u, '') || '/'
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
export function workspaceKeysOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b.endsWith('/') ? b : b + '/') || b.startsWith(a.endsWith('/') ? a : a + '/')
}
function records(store: KingdomStore, kingdomId: string): Reservation[] {
  const current = new Map<string, Reservation>()
  for (const event of store.listWorkspaceAdmissionEvents(kingdomId)) {
    let value: Reservation
    try { value = JSON.parse(event.payload_json) as Reservation } catch { return deny('WORKSPACE_LEDGER_INVALID', '资源接纳记录无法解析。') }
    if (value.type !== 'KingdomWorkspaceAdmission/v1' || value.kingdomId !== kingdomId || !value.admissionId
      || !value.taskId || !value.workerBindingId || !Number.isSafeInteger(value.attemptNo) || value.attemptNo < 1
      || !value.workspaceKey || !['READ_ONLY', 'WRITE'].includes(value.access)
      || !['RESERVED', 'BOUND', 'CANCELLED'].includes(value.state)) return deny('WORKSPACE_LEDGER_INVALID', '资源接纳记录不完整。')
    current.set(value.admissionId, value)
  }
  return [...current.values()]
}
function stillHeld(store: KingdomStore, record: Reservation): boolean {
  if (record.state === 'CANCELLED') return false
  if (record.state === 'RESERVED') return true
  const lease = record.leaseId ? store.getLease(record.leaseId) : null
  const dispatch = record.dispatchId ? store.getDispatch(record.dispatchId) : null
  return !lease || lease.state !== 'RELEASED' || !dispatch || !['TERMINAL', 'FAILED'].includes(dispatch.state)
}
function append(store: KingdomStore, record: Reservation): void {
  store.appendEvent({ event_id: randomUUID(), kingdom_id: record.kingdomId, event_type: `WORKSPACE_ADMISSION_${record.state}`,
    actor_role: 'SYSTEM', actor_id: 'kingdom-workspace-admission', target_type: 'workspace-admission', target_id: record.admissionId,
    payload_json: JSON.stringify(record), created_at: new Date().toISOString() })
}
function validateScope(store: KingdomStore, input: WorkspaceAdmissionInput): string {
  const task = store.getTask(input.taskId), worker = store.getBindingById(input.workerBindingId)
  const territory = task ? store.getTerritoryById(task.territory_id) : null
  if (!task || !territory || territory.kingdom_id !== input.kingdomId || territory.status !== 'ACTIVE'
    || task.assigned_binding_id !== input.workerBindingId || worker?.kingdom_id !== input.kingdomId
    || worker.role_type !== 'WORKER' || worker.status !== 'ACTIVE' || !['ASSIGNED', 'RUNNING'].includes(task.status)
    || !Number.isSafeInteger(input.attemptNo) || input.attemptNo < 1 || !['READ_ONLY', 'WRITE'].includes(input.access)) {
    return deny('WORKSPACE_SCOPE_MISMATCH', '任务、执行者、领地与资源范围不匹配。')
  }
  const key = canonicalWorkspaceKey(input.workspacePath)
  if (territory.workspace_path && canonicalWorkspaceKey(territory.workspace_path) !== key) {
    return deny('WORKSPACE_SCOPE_MISMATCH', '请求工作目录与任务领地不同。')
  }
  return key
}

/** Both entry points check occupancy inside their fact-creation transaction. Unknown paths overlap conservatively. */
export function assertWorkspaceAvailable(store: KingdomStore, kingdomId: string, key: string | null, access: WorkspaceAccess): void {
    if (!store.db.isTransaction) return deny('WORKSPACE_TRANSACTION_REQUIRED', '工作区检查必须与执行或预留事实同事务。')
    const active = records(store, kingdomId).filter(record => stillHeld(store, record))
    const overlaps = (path: string | null | undefined): boolean => !key || !path || workspaceKeysOverlap(key, canonicalWorkspaceKey(path))
    const conflicts = active.filter(record => (!key || workspaceKeysOverlap(key, record.workspaceKey)) && (access === 'WRITE' || record.access === 'WRITE'))
    if (conflicts.length) return deny('WORKSPACE_BUSY', '重叠工作区正在使用或等待对账，本项排队，尚未访问执行会话。')
    // Pre-existing work without a resource record is conservatively exclusive.
    // This covers installation/upgrade while another governed Lease is unresolved.
    const representedLeases = new Set(active.map(record => record.leaseId).filter(Boolean))
    for (const lease of store.listLeases(kingdomId)) {
      if (lease.state === 'RELEASED' || representedLeases.has(lease.lease_id)) continue
      const other = store.getTerritoryById(lease.territory_id)
      if (overlaps(other?.workspace_path)) {
        return deny('WORKSPACE_LEGACY_LEASE_BUSY', '已有未结算执行缺少资源接纳记录，须先对账或串行等待。')
      }
    }
    for (const task of store.listTasks(kingdomId)) {
      const unrepresented = store.listExecutions(task.task_id).some(execution =>
        !['COMPLETED', 'FAILED', 'ABORTED'].includes(execution.state)
        && (!execution.lease_id || !representedLeases.has(execution.lease_id)))
      if (unrepresented && overlaps(store.getTerritoryById(task.territory_id)?.workspace_path)) {
        return deny('WORKSPACE_LEGACY_EXECUTION_BUSY', '已有兼容或未登记资源的执行占用重叠目录，请等待结束或先对账。')
      }
    }
    const pendingBudgets = new Map<string, { taskId: string; attemptNo: number; state: string }>()
    for (const event of store.listBudgetEvents(kingdomId)) {
      if (!event.event_type.startsWith('BUDGET_ADMISSION_')) continue
      try { const value = JSON.parse(event.payload_json); pendingBudgets.set(value.admissionId, value) }
      catch { return deny('WORKSPACE_LEGACY_BUDGET_INVALID', '已有预留无法核对，不能开始新的共享目录工作。') }
    }
    for (const other of pendingBudgets.values()) {
      if (other.state !== 'RESERVED' || active.some(record => record.taskId === other.taskId && record.attemptNo === other.attemptNo)) continue
      const task = store.getTask(other.taskId), territory = task ? store.getTerritoryById(task.territory_id) : null
      if (overlaps(territory?.workspace_path)) {
        return deny('WORKSPACE_LEGACY_PREPARATION_BUSY', '已有未决准备可能使用相同目录，请先核对。')
      }
    }
}

/** Called within the same admission transaction as plan checks and budget reservation. */
export function reserveWorkspaceAdmission(store: KingdomStore, input: WorkspaceAdmissionInput): WorkspaceAdmissionHandle {
  const write = (): Reservation => {
    const key = validateScope(store, input), all = records(store, input.kingdomId)
    if (all.some(record => record.taskId === input.taskId && record.attemptNo === input.attemptNo && record.state !== 'CANCELLED')) {
      return deny('WORKSPACE_ADMISSION_DUPLICATE', '该任务尝试已有资源接纳，请查询原执行。')
    }
    assertWorkspaceAvailable(store, input.kingdomId, key, input.access)
    const record: Reservation = { type: 'KingdomWorkspaceAdmission/v1', ...input, workspaceKey: key,
      admissionId: randomUUID(), state: 'RESERVED', leaseId: null, dispatchId: null }
    append(store, record); return record
  }
  const record = store.db.isTransaction ? write() : store.withImmediateTransaction(write)
  const handle = Object.freeze({}) as WorkspaceAdmissionHandle
  handles.set(handle, { store, record, closed: false }); return handle
}
function liveRecord(store: KingdomStore, handle: WorkspaceAdmissionHandle): { live: Live; record: Reservation } {
  const live = handle && handles.get(handle)
  if (!live || live.store !== store || live.closed) return deny('WORKSPACE_ADMISSION_REQUIRED', '资源接纳不是当前调用持有的原始凭据。')
  const record = records(store, live.record.kingdomId).find(value => value.admissionId === live.record.admissionId)
  if (!record || record.taskId !== live.record.taskId || record.attemptNo !== live.record.attemptNo
    || record.workerBindingId !== live.record.workerBindingId || record.workspaceKey !== live.record.workspaceKey
    || record.access !== live.record.access) return deny('WORKSPACE_ADMISSION_MISMATCH', '资源接纳身份发生变化。')
  return { live, record }
}
export function bindWorkspaceAdmissionInTransaction(store: KingdomStore, handle: WorkspaceAdmissionHandle | undefined,
  input: { kingdomId: string; taskId: string; attemptNo: number; workerBindingId: string; dispatchId: string; leaseId: string }): void {
  if (!store.db.isTransaction) return deny('WORKSPACE_TRANSACTION_REQUIRED', '资源关联必须与派发意图同事务。')
  // Older internal preparation callers remain valid only while no new resource
  // surface is active. Public governed starts always provide the new handle.
  if (!handle) {
    if (records(store, input.kingdomId).some(record => stillHeld(store, record))) return deny('WORKSPACE_ADMISSION_REQUIRED', '已有资源治理，不能绕过接纳创建派发。')
    return
  }
  const { record } = liveRecord(store, handle)
  const dispatch = store.getDispatch(input.dispatchId), lease = store.getLease(input.leaseId)
  if (record.access === 'READ_ONLY') {
    let plan: { type?: string; payload?: { sandboxMode?: string } } | null = null
    try { plan = JSON.parse(lease?.enforcement_plan_snapshot ?? 'null') } catch { /* fail below */ }
    if (plan?.type !== 'DshEnforcementPlan/v1' || plan.payload?.sandboxMode !== 'read-only') {
      return deny('WORKSPACE_ACCESS_MISMATCH', '只读共享接纳必须对应冻结且有效的只读执行计划。')
    }
  }
  if (record.state !== 'RESERVED' || record.kingdomId !== input.kingdomId || record.taskId !== input.taskId
    || record.attemptNo !== input.attemptNo || record.workerBindingId !== input.workerBindingId
    || dispatch?.task_id !== input.taskId || dispatch.attempt_no !== input.attemptNo || dispatch.lease_id !== input.leaseId
    || dispatch.state !== 'INTENDED' || lease?.state !== 'EXECUTING' || lease.worker_binding_id !== input.workerBindingId
    || validateScope(store, record) !== record.workspaceKey) return deny('WORKSPACE_ADMISSION_MISMATCH', '派发关系、目录或资源预留已变化。')
  append(store, { ...record, state: 'BOUND', dispatchId: input.dispatchId, leaseId: input.leaseId })
}
export function cancelWorkspaceAdmissionIfSafe(store: KingdomStore, handle: WorkspaceAdmissionHandle): boolean {
  const write = (): boolean => {
    const { record } = liveRecord(store, handle)
    if (record.state !== 'RESERVED' || store.listDispatchesForTaskAttempt(record.taskId, record.attemptNo).length
      || store.listLeases(record.kingdomId).some(lease => lease.task_id === record.taskId && lease.attempt_no === record.attemptNo && lease.state !== 'RELEASED')
      || store.listExecutions(record.taskId).some(execution => execution.attempt_no === record.attemptNo && !['COMPLETED', 'FAILED', 'ABORTED'].includes(execution.state))) return false
    append(store, { ...record, state: 'CANCELLED' }); return true
  }
  return store.db.isTransaction ? write() : store.withImmediateTransaction(write)
}
export function finishWorkspaceAdmissionInvocation(handle: WorkspaceAdmissionHandle): void {
  const live = handles.get(handle); if (live) live.closed = true
}
export function readWorkspaceReservations(store: KingdomStore, kingdomId: string): {
  taskId: string; attemptNo: number; access: WorkspaceAccess; state: string; recovery: boolean
}[] {
  return records(store, kingdomId).filter(record => stillHeld(store, record)).map(record => ({ taskId: record.taskId,
    attemptNo: record.attemptNo, access: record.access, state: record.state,
    recovery: !!record.leaseId && store.getLease(record.leaseId)?.state === 'RECOVERING' }))
}
