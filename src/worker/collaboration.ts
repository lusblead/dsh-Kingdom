import type { KingdomStore } from '../core/db.js'
import { assignTask, resolveGovernedStartSupervisor, type CommandContext } from '../core/task-service.js'
import { readCollaborationPlan, readCollaborationReadiness, type CollaborationPlanView } from '../core/collaboration.js'

export interface AdvanceCollaborationInput {
  planId: string
  version: number
  digest: string
  strategy: 'SERIAL' | 'PARALLEL'
  items: { taskId: string; grant: Record<string, boolean> }[]
}
export interface CollaborationStartInput { taskId: string; grantJson: string; sandboxMode: 'read-only' | 'workspace-write' }
export interface CollaborationStartResult { ok: boolean; message: string }
export interface AdvanceCollaborationResult {
  ok: boolean
  planId: string
  startedTaskIds: string[]
  failedTaskId: string | null
  reasonCode: string | null
  results: { taskId: string; ok: boolean; message: string }[]
}
class AdvanceError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'AdvanceError' }
}
const inflight = new WeakMap<KingdomStore, Set<string>>()
function fail(code: string, message: string): never { throw new AdvanceError(code, message) }
function ordinary(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && !Object.getOwnPropertySymbols(value).length
}
function normalize(value: AdvanceCollaborationInput): AdvanceCollaborationInput {
  if (!ordinary(value) || Object.keys(value).some(key => !['planId', 'version', 'digest', 'strategy', 'items'].includes(key))
    || typeof value.planId !== 'string' || !value.planId || value.planId.length > 768 || !Number.isSafeInteger(value.version) || value.version < 1
    || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest) || !['SERIAL', 'PARALLEL'].includes(value.strategy)
    || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 2
    || value.strategy === 'SERIAL' && value.items.length !== 1) fail('ADVANCE_INPUT_INVALID', '请选择准确版本；串行推进一个就绪项，并行一次至多两个独立项。')
  const items = value.items.map(item => {
    if (!ordinary(item) || Object.keys(item).some(key => !['taskId', 'grant'].includes(key)) || typeof item.taskId !== 'string' || !item.taskId || item.taskId.length > 768
      || !ordinary(item.grant) || Object.keys(item.grant).length > 64 || Object.entries(item.grant).some(([key, value]) => !key || key.length > 160 || typeof value !== 'boolean')) fail('ADVANCE_GRANT_INVALID', '每项必须给出有界、逐能力布尔值的当次 Grant。')
    return { taskId: item.taskId, grant: { ...item.grant } as Record<string, boolean> }
  })
  if (new Set(items.map(item => item.taskId)).size !== items.length) fail('ADVANCE_DUPLICATE_ITEM', '一个批次不能重复推进同一任务。')
  return { planId: value.planId, version: value.version, digest: value.digest, strategy: value.strategy, items }
}
function heldPlanWork(store: KingdomStore, plan: CollaborationPlanView): boolean {
  const members = new Set([plan.parentTaskId, ...plan.childTaskIds])
  if (store.listLeases(plan.kingdomId).some(lease => members.has(lease.task_id) && lease.state !== 'RELEASED')) return true
  if ([...members].some(id => store.listExecutions(id).some(execution => !['COMPLETED', 'FAILED', 'ABORTED'].includes(execution.state)))) return true
  for (const events of [store.listBudgetEvents(plan.kingdomId), store.listWorkspaceAdmissionEvents(plan.kingdomId)]) {
    const reservations = new Map<string, { taskId: string; state: string; leaseId: string | null; dispatchId: string | null }>()
    for (const event of events) {
      if (!event.event_type.includes('_ADMISSION_')) continue
      try { const value = JSON.parse(event.payload_json); if (members.has(value.taskId)) reservations.set(value.admissionId, value) }
      catch { return true }
    }
    if ([...reservations.values()].some(row => row.state === 'RESERVED' || row.state === 'BOUND'
      && (!row.leaseId || store.getLease(row.leaseId)?.state !== 'RELEASED' || !row.dispatchId || !['TERMINAL', 'FAILED'].includes(store.getDispatch(row.dispatchId)?.state ?? '')))) return true
  }
  return false
}
function check(store: KingdomStore, context: CommandContext | null, input: AdvanceCollaborationInput, taskId: string, ownLocks: Set<string>) {
  if (!context) fail('ADVANCE_CONTEXT_UNAVAILABLE', '当前主管身份不可读取，停止新增。')
  const plan = readCollaborationPlan(store, context.kingdomId, input.planId)
  if (!plan || plan.state !== 'ADOPTED' || plan.version !== input.version || plan.digest !== input.digest) fail('ADVANCE_PLAN_STALE', '必须指定已采纳计划的当前准确版本。')
  if (input.items.some(item => ![plan.parentTaskId, ...plan.childTaskIds].includes(item.taskId))
    || input.items.length > 1 && input.items.some(item => item.taskId === plan.parentTaskId)) fail('ADVANCE_SCOPE_INVALID', '批次只能包含本计划的独立子项，父项整合单独推进。')
  if (inflight.get(store)?.has(taskId) && !ownLocks.has(taskId)) fail('ADVANCE_ALREADY_IN_PROGRESS', '该任务已有推进调用，请查询原工作。')
  const authority = resolveGovernedStartSupervisor(store, context, taskId)
  if (!authority.ok) fail(authority.code, authority.message)
  const readiness = readCollaborationReadiness(store, context.kingdomId, taskId)
  if (!readiness?.ready) fail(readiness?.reasonCode ?? 'ADVANCE_NOT_READY', '依赖、成员或执行状态尚未就绪。')
  const task = authority.task
  const liveExecution = store.listExecutions(taskId).some(execution => !['COMPLETED', 'FAILED', 'ABORTED'].includes(execution.state))
  if (liveExecution || store.listLeases(context.kingdomId).some(lease => lease.task_id === taskId && lease.state !== 'RELEASED')) fail('ADVANCE_ALREADY_IN_PROGRESS', '已有在途或未结算执行，不重复推进。')
  if (task.status === 'RUNNING') {
    const claim = store.latestWorkerResult(taskId), execution = store.latestExecution(taskId)
    const rework = claim ? store.latestTaskReworkEvent(context.kingdomId, taskId, claim.attempt_no) : null
    if (!claim || !execution || execution.attempt_no !== claim.attempt_no || !rework) fail('ADVANCE_REWORK_REQUIRED', 'RUNNING 只有准确的最新 REWORK 才允许新尝试。')
  } else if (!['CREATED', 'ASSIGNED'].includes(task.status)) fail('ADVANCE_TASK_STATE', '该任务状态不允许启动。')
  if (task.status !== 'CREATED') {
    const assignment = store.getActiveAssignmentForTask(taskId)
    if (!assignment || assignment.worker_binding_id !== readiness.workerBindingId || assignment.territory_id !== task.territory_id) fail('ADVANCE_ASSIGNMENT_INVALID', '任务缺少准确的当前 Assignment。')
  }
  if (input.strategy === 'SERIAL' && heldPlanWork(store, plan)) fail('ADVANCE_SERIAL_WAIT', '串行策略等待计划中已有执行和预留完成对账。')
  return { context, plan, readiness, task }
}

/** One bounded batch, using current Supervisor authority and the existing governed start callback. */
export async function advanceCollaboration(
  store: KingdomStore,
  currentContext: () => CommandContext | null,
  raw: AdvanceCollaborationInput,
  start: (input: CollaborationStartInput) => Promise<CollaborationStartResult>,
): Promise<AdvanceCollaborationResult> {
  const result: AdvanceCollaborationResult = { ok: false, planId: raw?.planId ?? '', startedTaskIds: [], failedTaskId: null, reasonCode: null, results: [] }
  const ownLocks = new Set<string>()
  const setFailure = (error: unknown, taskId: string | null): void => {
    if (result.reasonCode) return
    result.failedTaskId = taskId
    result.reasonCode = error instanceof AdvanceError ? error.code : 'ADVANCE_FAILED'
    if (taskId) result.results.push({ taskId, ok: false, message: error instanceof Error ? error.message : '协作推进失败。' })
  }
  try {
    const input = normalize(raw)
    result.planId = input.planId
    store.withImmediateTransaction(() => {
      const checked = input.items.map(item => check(store, currentContext(), input, item.taskId, ownLocks))
      for (const item of checked) if (item.task.status === 'CREATED') {
        const assigned = assignTask(store, item.context, { taskId: item.task.task_id, workerBindingId: item.readiness.workerBindingId })
        if (!assigned.ok) fail(assigned.errorCode ?? 'ADVANCE_ASSIGNMENT_FAILED', assigned.message)
      }
    })
    let locks = inflight.get(store)
    if (!locks) { locks = new Set(); inflight.set(store, locks) }
    for (const item of input.items) { locks.add(item.taskId); ownLocks.add(item.taskId) }
    const launched: Promise<void>[] = []
    for (const item of input.items) {
      if (result.reasonCode) break
      try {
        const checked = check(store, currentContext(), input, item.taskId, ownLocks)
        const pending = start({ taskId: item.taskId, grantJson: JSON.stringify(item.grant),
          sandboxMode: checked.readiness.access === 'READ_ONLY' ? 'read-only' : 'workspace-write' })
          .then(started => {
            if (!started || typeof started.ok !== 'boolean' || typeof started.message !== 'string') throw new AdvanceError('ADVANCE_RESULT_INVALID', '执行回调未提供可核对结果。')
            result.results.push({ taskId: item.taskId, ...started })
            if (started.ok) result.startedTaskIds.push(item.taskId)
            else if (!result.reasonCode) { result.reasonCode = 'ADVANCE_START_REJECTED'; result.failedTaskId = item.taskId }
          }).catch(error => setFailure(error, item.taskId))
        launched.push(pending)
        // Give an immediately rejected first admission a chance to stop the
        // next launch. Already admitted independent work is never cancelled.
        await Promise.resolve()
      } catch (error) { setFailure(error, item.taskId); break }
    }
    await Promise.all(launched)
    result.ok = result.reasonCode === null && result.results.length === input.items.length && result.results.every(item => item.ok)
  } catch (error) { setFailure(error, null) }
  finally {
    for (const taskId of ownLocks) inflight.get(store)?.delete(taskId)
  }
  return result
}
