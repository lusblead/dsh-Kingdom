import { createHash, randomUUID } from 'node:crypto'
import type { DispatchRecordRow, EventRow, KingdomStore } from './db.js'
import { requireAdmin, type AdminAuth } from './binding.js'
import { ownerInputHash } from './owner-control.js'
import { readDispatchUsage } from './usage.js'
import { readAdditionalBudgetUsage, readIncompleteRoleUsageSourceRefs } from './cost.js'

/** Exact Owner budget.policy parameters. Amounts are tokens, never a hard bill limit. */
export interface BudgetPolicyParameters {
  enabled: boolean
  limit_tokens: number
  reserve_tokens: number
  unknown_policy: 'BLOCK' | 'WARN'
  warning_percent?: number
}
export interface BudgetPolicyView {
  type: 'KingdomBudgetPolicy/v1'
  budgetId: string
  kingdomId: string
  enabled: boolean
  limitTokens: number
  reserveTokens: number
  unknownPolicy: 'BLOCK' | 'WARN'
  warningPercent: number
  sinceEventSeq: number
  revision: number
  updatedAt: string
}
export interface BudgetView {
  type: 'KingdomBudgetView/v1'
  scope: 'KINGDOM'
  coverage: 'OBSERVABLE_ONLY'
  policy: BudgetPolicyView | null
  state: 'OFF' | 'ALLOW' | 'WARN' | 'BLOCK_LIMIT' | 'BLOCK_UNKNOWN'
  verifiedTokens: number
  workerVerifiedTokens: number
  additionalVerifiedTokens: number
  reservedEstimateTokens: number
  exposureTokens: number
  remainingTokens: number | null
  pendingUnits: number
  unknownUnits: number
  attributionGapCount: number
  recoveryUnits: number
  amount: null
  amountStatus: 'UNKNOWN'
  note: string
}
declare const BUDGET_ADMISSION_HANDLE: unique symbol
export interface BudgetAdmissionHandle { readonly [BUDGET_ADMISSION_HANDLE]: true }
export interface BudgetAdmissionInput { kingdomId: string; taskId: string; attemptNo: number; workerBindingId: string }
export interface BudgetAdmissionBindingInput extends BudgetAdmissionInput { dispatchId: string; leaseId: string }
export class BudgetError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); this.name = 'BudgetError' }
}

interface StoredPolicy extends BudgetPolicyView { carriedAdmissionIds: string[]; carriedDispatchIds: string[]; carriedRoleSourceRefs: string[] }
interface AdmissionRecord extends BudgetAdmissionInput {
  type: 'KingdomBudgetAdmission/v1'
  admissionId: string
  budgetId: string | null
  policyRevision: number | null
  reservedTokens: number
  reservedAtSeq: number
  createdAt: string
  state: 'RESERVED' | 'BOUND' | 'CANCELLED'
  dispatchId: string | null
  leaseId: string | null
}
interface LiveAdmission { store: KingdomStore; record: AdmissionRecord; ended: boolean }
const admissionHandles = new WeakMap<object, LiveAdmission>()
const activeInvocations = new Map<string, LiveAdmission>()
/** Process-local observation only; historical IDs do not grant admission authority. */
export function isBudgetAdmissionInvocationActive(store: KingdomStore, admissionId: string): boolean {
  const live = activeInvocations.get(admissionId)
  return live?.store === store && !live.ended
}
const TERMINAL_DISPATCH = new Set(['TERMINAL', 'FAILED'])
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function reject(code: string, message: string): never { throw new BudgetError(code, message) }
function safeCount(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
function add(a: number, b: number): number {
  if (!safeCount(a) || !safeCount(b) || !Number.isSafeInteger(a + b)) reject('BUDGET_USAGE_INVALID', '用量或预留值不可安全计算。')
  return a + b
}
function exactObject(value: unknown, fields: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) reject('BUDGET_POLICY_INVALID', '政策必须是普通对象。')
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => !fields.includes(key)) || required.some(key => !Object.hasOwn(row, key))) reject('BUDGET_POLICY_INVALID', '政策字段缺失或不受支持。')
  return row
}

export function normalizeBudgetPolicyParameters(value: unknown): Required<BudgetPolicyParameters> {
  const p = exactObject(value, ['enabled', 'limit_tokens', 'reserve_tokens', 'unknown_policy', 'warning_percent'], ['enabled', 'limit_tokens', 'reserve_tokens', 'unknown_policy'])
  if (typeof p.enabled !== 'boolean' || !safeCount(p.limit_tokens) || p.limit_tokens < 1
    || !safeCount(p.reserve_tokens) || p.reserve_tokens < 1 || p.reserve_tokens > p.limit_tokens
    || !['BLOCK', 'WARN'].includes(p.unknown_policy as string)) reject('BUDGET_POLICY_INVALID', '额度和单次预留必须为正整数，预留不得超过额度；缺失策略必须为 BLOCK 或 WARN。')
  const warning = p.warning_percent ?? 80
  if (!Number.isSafeInteger(warning) || (warning as number) < 1 || (warning as number) > 100) reject('BUDGET_POLICY_INVALID', '告警比例必须在 1 到 100 之间。')
  return { enabled: p.enabled, limit_tokens: p.limit_tokens, reserve_tokens: p.reserve_tokens, unknown_policy: p.unknown_policy as 'BLOCK' | 'WARN', warning_percent: warning as number }
}

function readStoredPolicy(events: readonly EventRow[], kingdomId: string): StoredPolicy | null {
  const event = [...events].reverse().find(row => row.event_type === 'BUDGET_POLICY_UPDATED')
  if (!event) return null
  try {
    const p = JSON.parse(event.payload_json) as StoredPolicy
    if (p.type !== 'KingdomBudgetPolicy/v1' || p.kingdomId !== kingdomId || !p.budgetId || !safeCount(p.sinceEventSeq)
      || !Array.isArray(p.carriedAdmissionIds) || !Array.isArray(p.carriedDispatchIds)) reject('BUDGET_LEDGER_INVALID', '预算政策记录不完整。')
    normalizeBudgetPolicyParameters({ enabled: p.enabled, limit_tokens: p.limitTokens, reserve_tokens: p.reserveTokens, unknown_policy: p.unknownPolicy, warning_percent: p.warningPercent })
    if (p.carriedRoleSourceRefs !== undefined && (!Array.isArray(p.carriedRoleSourceRefs)
      || p.carriedRoleSourceRefs.some(ref => typeof ref !== 'string' || ref.length === 0))) reject('BUDGET_LEDGER_INVALID', '预算角色观察的带入来源不完整。')
    return { ...p, carriedRoleSourceRefs: p.carriedRoleSourceRefs ?? [], revision: event.seq }
  } catch (error) {
    if (error instanceof BudgetError) throw error
    return reject('BUDGET_LEDGER_INVALID', '预算政策记录无法解析。')
  }
}
function policyView(policy: StoredPolicy | null): BudgetPolicyView | null {
  if (!policy) return null
  return { type: policy.type, budgetId: policy.budgetId, kingdomId: policy.kingdomId, enabled: policy.enabled,
    limitTokens: policy.limitTokens, reserveTokens: policy.reserveTokens, unknownPolicy: policy.unknownPolicy,
    warningPercent: policy.warningPercent, sinceEventSeq: policy.sinceEventSeq, revision: policy.revision, updatedAt: policy.updatedAt }
}
export function readBudgetPolicy(store: KingdomStore, kingdomId: string): BudgetPolicyView | null {
  return policyView(readStoredPolicy(store.listBudgetEvents(kingdomId), kingdomId))
}
function admissions(events: readonly EventRow[]): Map<string, AdmissionRecord> {
  const result = new Map<string, AdmissionRecord>()
  for (const event of events) {
    if (!event.event_type.startsWith('BUDGET_ADMISSION_')) continue
    let record: AdmissionRecord
    try { record = JSON.parse(event.payload_json) as AdmissionRecord } catch { return reject('BUDGET_LEDGER_INVALID', '预算接纳记录无法解析。') }
    if (record.type !== 'KingdomBudgetAdmission/v1' || !record.admissionId || record.kingdomId !== event.kingdom_id
      || !safeCount(record.reservedTokens) || !safeCount(record.reservedAtSeq) || !Number.isSafeInteger(record.attemptNo)
      || record.attemptNo < 1 || !['RESERVED', 'BOUND', 'CANCELLED'].includes(record.state)) reject('BUDGET_LEDGER_INVALID', '预算接纳记录不完整。')
    result.set(record.admissionId, record)
  }
  return result
}
function isUnsettledDispatch(store: KingdomStore, dispatch: DispatchRecordRow): boolean {
  return !TERMINAL_DISPATCH.has(dispatch.state) || store.getLease(dispatch.lease_id)?.state !== 'RELEASED'
}

/** Synchronous exact Owner helper, also callable inside the Owner receipt transaction. */
export function setBudgetPolicy(store: KingdomStore, input: { kingdomId: string; policy: BudgetPolicyParameters }, auth?: AdminAuth): string {
  const admin = requireAdmin(store, input.kingdomId, auth, { operation: 'budget.policy', input })
  if (!admin.ok) return admin.message
  if (!store.isSchemaV4) return 'BUDGET_SCHEMA_REQUIRED: 预算控制需要现有 v4 governed 结构；此操作不会自动迁移。'
  const p = normalizeBudgetPolicyParameters(input.policy)
  const write = (): string => {
    const events = store.listBudgetEvents(input.kingdomId)
    const previous = readStoredPolicy(events, input.kingdomId)
    const dispatches = store.listDispatches(input.kingdomId)
    const currentAdmissions = [...admissions(events).values()]
    const carriedDispatchIds = previous?.carriedDispatchIds ?? dispatches.filter(d => isUnsettledDispatch(store, d)).map(d => d.dispatch_id)
    const policy: StoredPolicy = {
      type: 'KingdomBudgetPolicy/v1', budgetId: previous?.budgetId ?? randomUUID(), kingdomId: input.kingdomId,
      enabled: p.enabled, limitTokens: p.limit_tokens, reserveTokens: p.reserve_tokens, unknownPolicy: p.unknown_policy,
      warningPercent: p.warning_percent, sinceEventSeq: previous?.sinceEventSeq ?? store.eventSequence(),
      revision: store.eventSequence() + 1, updatedAt: new Date().toISOString(), carriedDispatchIds,
      carriedAdmissionIds: previous?.carriedAdmissionIds ?? currentAdmissions.filter(a => a.state === 'RESERVED'
        || a.state === 'BOUND' && carriedDispatchIds.includes(a.dispatchId ?? '')).map(a => a.admissionId),
      carriedRoleSourceRefs: previous?.carriedRoleSourceRefs ?? readIncompleteRoleUsageSourceRefs(store, input.kingdomId),
    }
    store.appendEvent({ event_id: randomUUID(), kingdom_id: input.kingdomId, event_type: 'BUDGET_POLICY_UPDATED', actor_role: 'OWNER', actor_id: admin.ownerPrincipalId,
      target_type: 'kingdom', target_id: input.kingdomId, payload_json: JSON.stringify({ ...policy, operation: 'budget.policy', ...admin.eventSource }), created_at: policy.updatedAt })
    return p.enabled ? '软预算已保存，将限制后续新增接纳；已接纳工作继续，统计起点未重置。' : '软预算限制已关闭，历史用量和未决预留继续保留。'
  }
  return store.db.isTransaction ? write() : store.withImmediateTransaction(write)
}

/** Deterministic read projection. Additional usage includes non-Worker sources only. */
export function readBudgetView(store: KingdomStore, kingdomId: string): BudgetView {
  const events = store.listBudgetEvents(kingdomId)
  const policy = readStoredPolicy(events, kingdomId)
  const start = policy?.sinceEventSeq ?? 0
  const records = [...admissions(events).values()].filter(a => !policy || a.reservedAtSeq > start || policy.carriedAdmissionIds.includes(a.admissionId))
  const dispatches = store.isSchemaV4 ? store.listDispatches(kingdomId) : []
  const createdSince = new Set(events.filter(e => e.event_type === 'DISPATCH_INTENDED' && e.seq > start).map(e => e.target_id))
  const budgetDispatchIds = new Set(records.filter(a => a.dispatchId).map(a => a.dispatchId!))
  const includedDispatches = dispatches.filter(d => !policy || createdSince.has(d.dispatch_id) || budgetDispatchIds.has(d.dispatch_id) || policy.carriedDispatchIds.includes(d.dispatch_id))
  const includedIds = new Set(includedDispatches.map(d => d.dispatch_id))
  let workerVerifiedTokens = 0, reservedEstimateTokens = 0, pendingUnits = 0, unknownUnits = 0, recoveryUnits = 0
  const bound = new Map(records.filter(a => a.state === 'BOUND' && a.dispatchId).map(a => [a.dispatchId!, a]))
  for (const dispatch of includedDispatches) {
    const observation = readDispatchUsage(store, dispatch.dispatch_id)
    const complete = observation?.status === 'COMPLETE' && observation.taskId === dispatch.task_id && observation.attemptNo === dispatch.attempt_no
      && observation.usage !== null && safeCount(observation.usage.totalTokens)
    const observed = complete ? observation.usage!.totalTokens : 0
    workerVerifiedTokens = add(workerVerifiedTokens, observed)
    const pending = !TERMINAL_DISPATCH.has(dispatch.state)
    if (pending) pendingUnits++
    else if (!complete) unknownUnits++
    const lease = store.getLease(dispatch.lease_id)
    if (dispatch.state === 'RECOVERING' || lease?.state === 'RECOVERING') recoveryUnits++
    if (pending || !complete) {
      const estimate = bound.get(dispatch.dispatch_id)?.reservedTokens || policy?.reserveTokens || 0
      reservedEstimateTokens = add(reservedEstimateTokens, Math.max(0, estimate - observed))
    }
  }
  for (const record of records) {
    if (record.state === 'CANCELLED' || record.state === 'BOUND' && includedIds.has(record.dispatchId ?? '')) continue
    const estimate = record.reservedTokens || policy?.reserveTokens || 0
    reservedEstimateTokens = add(reservedEstimateTokens, estimate)
    pendingUnits++
    if (record.state === 'BOUND' || !activeInvocations.has(record.admissionId)) unknownUnits++
  }
  const additional = readAdditionalBudgetUsage(store, kingdomId, start, policy?.carriedRoleSourceRefs ?? [])
  if (!additional || ![additional.verifiedTokens, additional.unknownUnits, additional.pendingUnits, additional.attributionGapCount].every(safeCount)) reject('BUDGET_USAGE_INVALID', '其他角色用量观察无法安全计算。')
  const verifiedTokens = add(workerVerifiedTokens, additional.verifiedTokens)
  pendingUnits = add(pendingUnits, additional.pendingUnits)
  unknownUnits = add(unknownUnits, additional.unknownUnits)
  // A live Supervisor request is not missing usage. Give each non-Worker
  // pending unit an explicit estimate; task attribution gaps do not invalidate
  // its proven kingdom ownership or deadlock that Supervisor's own dispatch.
  reservedEstimateTokens = add(reservedEstimateTokens, additional.pendingUnits * (policy?.reserveTokens ?? 0))
  const gaps = add(additional.attributionGapCount, store.isSchemaV4 ? 0 : 1)
  const exposureTokens = add(verifiedTokens, reservedEstimateTokens)
  let state: BudgetView['state'] = 'OFF'
  if (policy?.enabled) {
    if (policy.unknownPolicy === 'BLOCK' && (unknownUnits > 0 || !store.isSchemaV4)) state = 'BLOCK_UNKNOWN'
    else if (add(exposureTokens, policy.reserveTokens) > policy.limitTokens) state = 'BLOCK_LIMIT'
    else if (unknownUnits + gaps > 0 || exposureTokens >= policy.limitTokens * policy.warningPercent / 100) state = 'WARN'
    else state = 'ALLOW'
  }
  return {
    type: 'KingdomBudgetView/v1', scope: 'KINGDOM', coverage: 'OBSERVABLE_ONLY', policy: policyView(policy), state,
    verifiedTokens, workerVerifiedTokens, additionalVerifiedTokens: additional.verifiedTokens, reservedEstimateTokens, exposureTokens,
    remainingTokens: policy ? Math.max(0, policy.limitTokens - exposureTokens) : null,
    pendingUnits, unknownUnits, attributionGapCount: gaps, recoveryUnits, amount: null, amountStatus: 'UNKNOWN',
    note: '实报只涵盖可验证观察；预留是估计。共享、未归属和缺失单列，未知金额不填零。软预算只限制新的 governed 接纳，已在途工作仍可能继续计费。',
  }
}

function validateAdmissionInput(store: KingdomStore, input: BudgetAdmissionInput): void {
  const kingdom = store.getDefaultKingdom(), task = store.getTask(input.taskId), worker = store.getBindingById(input.workerBindingId)
  const territory = task ? store.getTerritoryById(task.territory_id) : null
  if (!kingdom || kingdom.kingdom_id !== input.kingdomId || !task || territory?.kingdom_id !== input.kingdomId
    || task.assigned_binding_id !== input.workerBindingId || !worker || worker.kingdom_id !== input.kingdomId || worker.role_type !== 'WORKER'
    || worker.status !== 'ACTIVE' || !Number.isSafeInteger(input.attemptNo) || input.attemptNo < 1
    || !['ASSIGNED', 'RUNNING'].includes(task.status)) reject('BUDGET_ADMISSION_SCOPE', '预算接纳的 Task、attempt 和 Worker 关系不成立。')
}
function eventId(action: string, admissionId: string): string {
  return `budget-${action}:${createHash('sha256').update(admissionId).digest('hex')}`
}
function appendAdmission(store: KingdomStore, record: AdmissionRecord, eventType: string, extra: Record<string, unknown> = {}): void {
  store.appendEvent({ event_id: eventId(eventType, record.admissionId), kingdom_id: record.kingdomId, event_type: eventType,
    actor_role: 'SYSTEM', actor_id: 'kingdom-budget-admission', target_type: 'budget-admission', target_id: record.admissionId,
    payload_json: JSON.stringify({ ...record, ...extra }), created_at: new Date().toISOString() })
}

/** No Runtime callback occurs inside this transaction; concurrent admissions serialize on the ledger. */
export function reserveBudgetAdmission(store: KingdomStore, input: BudgetAdmissionInput): BudgetAdmissionHandle {
  const write = (): AdmissionRecord => {
    validateAdmissionInput(store, input)
    const records = [...admissions(store.listBudgetEvents(input.kingdomId)).values()]
    if (records.some(a => a.taskId === input.taskId && a.attemptNo === input.attemptNo && a.state !== 'CANCELLED')) reject('BUDGET_ADMISSION_DUPLICATE', '该 Task/attempt 已接纳；请查询原工作，不重复派发。')
    const view = readBudgetView(store, input.kingdomId)
    if (view.state === 'BLOCK_UNKNOWN') reject('BUDGET_UNKNOWN_USAGE', '存在缺失或重启后尚未确认的用量；预算拒绝新增接纳。')
    if (view.state === 'BLOCK_LIMIT') reject('BUDGET_LIMIT_REACHED', '剩余额度不足以预留本次工作，已停止新增接纳。')
    const record: AdmissionRecord = { type: 'KingdomBudgetAdmission/v1', ...copy(input), admissionId: randomUUID(), budgetId: view.policy?.budgetId ?? null,
      policyRevision: view.policy?.revision ?? null, reservedTokens: view.policy?.reserveTokens ?? 0,
      reservedAtSeq: store.eventSequence() + 1, createdAt: new Date().toISOString(), state: 'RESERVED', dispatchId: null, leaseId: null }
    appendAdmission(store, record, 'BUDGET_ADMISSION_RESERVED')
    return record
  }
  const record = store.db.isTransaction ? write() : store.withImmediateTransaction(write)
  const handle = Object.freeze({}) as BudgetAdmissionHandle
  const live = { store, record, ended: false }
  admissionHandles.set(handle, live); activeInvocations.set(record.admissionId, live)
  return handle
}
function resolveLive(store: KingdomStore, handle: BudgetAdmissionHandle): { live: LiveAdmission; current: AdmissionRecord } {
  const live = typeof handle === 'object' && handle !== null ? admissionHandles.get(handle) : undefined
  if (!live || live.store !== store || live.ended) reject('BUDGET_ADMISSION_REQUIRED', '预算预留不是本次运行持有的有效接纳。')
  const current = admissions(store.listBudgetEvents(live.record.kingdomId)).get(live.record.admissionId)
  const identity = (a: AdmissionRecord) => ({ type: a.type, admissionId: a.admissionId, kingdomId: a.kingdomId, taskId: a.taskId,
    attemptNo: a.attemptNo, workerBindingId: a.workerBindingId, budgetId: a.budgetId, policyRevision: a.policyRevision,
    reservedTokens: a.reservedTokens, reservedAtSeq: a.reservedAtSeq, createdAt: a.createdAt })
  if (!current || ownerInputHash(identity(current)) !== ownerInputHash(identity(live.record))) reject('BUDGET_ADMISSION_MISMATCH', '预算预留的准确内容不匹配。')
  return { live, current }
}

/** Called only from the existing TX-3 after the exact Execution, Intent and EXECUTING Lease are written. */
export function bindBudgetAdmissionInTransaction(store: KingdomStore, handle: BudgetAdmissionHandle | undefined, input: BudgetAdmissionBindingInput): void {
  if (!store.db.isTransaction) reject('BUDGET_TRANSACTION_REQUIRED', '预算派发关联必须在既有 TX-3 内完成。')
  if (!handle) {
    if (readBudgetPolicy(store, input.kingdomId)?.enabled) reject('BUDGET_ADMISSION_REQUIRED', '启用预算时不可绕过接纳直接派发。')
    return
  }
  const { current } = resolveLive(store, handle)
  if (current.state !== 'RESERVED' || current.kingdomId !== input.kingdomId || current.taskId !== input.taskId
    || current.attemptNo !== input.attemptNo || current.workerBindingId !== input.workerBindingId) reject('BUDGET_ADMISSION_MISMATCH', '预留已消费或属于其他 Task/attempt/Worker。')
  const dispatch = store.getDispatch(input.dispatchId), lease = store.getLease(input.leaseId)
  if (!dispatch || dispatch.kingdom_id !== input.kingdomId || dispatch.task_id !== input.taskId || dispatch.attempt_no !== input.attemptNo
    || dispatch.lease_id !== input.leaseId || dispatch.state !== 'INTENDED' || !lease || lease.worker_binding_id !== input.workerBindingId
    || lease.state !== 'EXECUTING') reject('BUDGET_ADMISSION_MISMATCH', '预算关联的 Dispatch 或 Lease 不成立。')
  appendAdmission(store, { ...current, state: 'BOUND', dispatchId: input.dispatchId, leaseId: input.leaseId }, 'BUDGET_ADMISSION_BOUND')
}

/** Only closes accounting; it never releases, stops or edits any Runtime/Lease/Task fact. */
export function cancelBudgetAdmissionIfSafe(store: KingdomStore, handle: BudgetAdmissionHandle): boolean {
  return store.withImmediateTransaction(() => {
    const { current } = resolveLive(store, handle)
    if (current.state !== 'RESERVED') return false
    if (store.listDispatchesForTaskAttempt(current.taskId, current.attemptNo).length > 0) return false
    if (store.listLeases(current.kingdomId).some(lease => lease.task_id === current.taskId && lease.attempt_no === current.attemptNo && lease.state !== 'RELEASED')) return false
    if (store.listExecutions(current.taskId).some(execution => execution.attempt_no === current.attemptNo
      && !['COMPLETED', 'FAILED', 'ABORTED'].includes(execution.state))) return false
    appendAdmission(store, { ...current, state: 'CANCELLED' }, 'BUDGET_ADMISSION_CANCELLED', { reason: 'PROVEN_NO_DISPATCH_NO_ACTIVE_LEASE' })
    return true
  })
}

/** End only the in-memory invocation; unresolved persisted reservations remain visible after restart. */
export function finishBudgetAdmissionInvocation(handle: BudgetAdmissionHandle): void {
  const live = admissionHandles.get(handle)
  if (!live) return
  live.ended = true
  activeInvocations.delete(live.record.admissionId)
}
