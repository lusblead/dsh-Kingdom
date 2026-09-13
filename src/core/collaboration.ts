import { randomUUID } from 'node:crypto'
import type { EventRow, KingdomStore, TaskRow } from './db.js'
import { requireAdmin, type AdminAuth } from './binding.js'
import { ownerInputHash } from './owner-control.js'
import { requireRole, type CommandContext } from './task-service.js'
import { readDispatchUsage } from './usage.js'
import { isBudgetAdmissionInvocationActive } from './budget.js'
import { readAdditionalBudgetUsage, readIncompleteRoleUsageSourceRefs } from './cost.js'

export interface CollaborationPlanItemInput {
  key: string
  title: string
  description: string
  acceptanceCriteria: string
  territoryId: string
  workerBindingId: string
  access: 'READ_ONLY' | 'WRITE'
  dependsOn: string[]
  expectedArtifact: string
}
export interface ProposeCollaborationPlanInput {
  parentTaskId: string
  expectedVersion?: number
  mode: 'EXPERT' | 'TEAM'
  reason: string
  integratorBindingId: string
  budgetTokens: number
  reserveTokens: number
  items: CollaborationPlanItemInput[]
}
export interface PlanAdoptionParameters { plan_id: string; version: number; digest: string }
export interface CollaborationPlanItem extends CollaborationPlanItemInput { taskId: string }
export interface CollaborationPlanView {
  type: 'KingdomCollaborationPlan/v1'
  planId: string
  kingdomId: string
  parentTaskId: string
  version: number
  digest: string
  state: 'PROPOSED' | 'ADOPTED' | 'STALE'
  mode: 'EXPERT' | 'TEAM'
  reason: string
  integratorBindingId: string
  budgetTokens: number
  reserveTokens: number
  items: CollaborationPlanItem[]
  childTaskIds: string[]
  proposedBy: string
  proposedAt: string
  proposedSeq: number
  adoptedAt: string | null
  adoptedSeq: number | null
}
interface PlanRecord extends Omit<CollaborationPlanView, 'state' | 'adoptedAt' | 'adoptedSeq'> {
  proposalEventId: string
  contextDigest: string
  parentContentDigest: string
  authority: 'SESSION_BOUND' | 'LOCAL_DEMO'
}
interface AdoptionRecord {
  type: 'KingdomCollaborationAdoption/v1'
  planId: string
  version: number
  digest: string
  parentTaskId: string
  childTaskIds: string[]
  carriedRoleSourceRefs: string[]
}
export class CollaborationError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); this.name = 'CollaborationError' }
}
function reject(code: string, message: string): never { throw new CollaborationError(code, message) }
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
function add(a: number, b: number): number {
  if (!count(a) || !count(b) || !count(a + b)) reject('PLAN_USAGE_INVALID', '协作用量不能安全计算。')
  return a + b
}
function text(value: unknown, field: string, max = 768): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) reject('PLAN_INPUT_INVALID', `${field} 必须为非空且有界的文本。`)
  return value.trim()
}
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.getOwnPropertySymbols(value).length) reject('PLAN_INPUT_INVALID', '输入必须是普通对象。')
  const row = value as Record<string, unknown>
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) reject('PLAN_INPUT_INVALID', '输入字段缺失或不受支持。')
  return row
}
function normalizeProposal(value: unknown): Required<ProposeCollaborationPlanInput> {
  const row = object(value, ['parentTaskId', 'mode', 'reason', 'integratorBindingId', 'budgetTokens', 'reserveTokens', 'items'], ['expectedVersion'])
  if (!['EXPERT', 'TEAM'].includes(row.mode as string) || !count(row.budgetTokens) || row.budgetTokens < 1
    || !count(row.reserveTokens) || row.reserveTokens < 1 || row.reserveTokens > row.budgetTokens
    || !count(row.expectedVersion ?? 0) || !Array.isArray(row.items) || row.items.length < 1 || row.items.length > 2) reject('PLAN_INPUT_INVALID', '计划模式、预算、版本或成员数量不合法；含整合者最多三个不同 Worker。')
  const items = row.items.map(value => {
    const item = object(value, ['key', 'title', 'description', 'acceptanceCriteria', 'territoryId', 'workerBindingId', 'access', 'dependsOn', 'expectedArtifact'])
    const key = text(item.key, 'key', 48)
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key) || !['READ_ONLY', 'WRITE'].includes(item.access as string)
      || row.mode === 'EXPERT' && item.access !== 'READ_ONLY' || !Array.isArray(item.dependsOn) || item.dependsOn.length > 2) reject('PLAN_INPUT_INVALID', '成员 key、访问方式或依赖不合法；专家只允许只读。')
    const dependsOn = item.dependsOn.map(dep => text(dep, 'dependsOn', 48))
    if (new Set(dependsOn).size !== dependsOn.length) reject('PLAN_DEPENDENCY_INVALID', '依赖不可重复。')
    return { key, title: text(item.title, 'title', 200), description: text(item.description, 'description', 4000),
      acceptanceCriteria: text(item.acceptanceCriteria, 'acceptanceCriteria', 2000), territoryId: text(item.territoryId, 'territoryId'),
      workerBindingId: text(item.workerBindingId, 'workerBindingId'), access: item.access as 'READ_ONLY' | 'WRITE', dependsOn,
      expectedArtifact: text(item.expectedArtifact, 'expectedArtifact', 1000) }
  })
  const integratorBindingId = text(row.integratorBindingId, 'integratorBindingId')
  if (new Set(items.map(item => item.key)).size !== items.length
    || new Set([integratorBindingId, ...items.map(item => item.workerBindingId)]).size !== items.length + 1) reject('PLAN_MEMBER_DUPLICATE', '成员 key 和 Worker 必须唯一，整合者另占一个席位。')
  const keys = new Set(items.map(item => item.key)), visiting = new Set<string>(), visited = new Set<string>()
  const visit = (key: string): void => {
    if (visiting.has(key)) reject('PLAN_DEPENDENCY_INVALID', '依赖不可成环。')
    if (visited.has(key)) return
    visiting.add(key)
    for (const dependency of items.find(item => item.key === key)!.dependsOn) {
      if (!keys.has(dependency) || dependency === key) reject('PLAN_DEPENDENCY_INVALID', '依赖必须指向本计划的其他成员。')
      visit(dependency)
    }
    visiting.delete(key); visited.add(key)
  }
  items.forEach(item => visit(item.key))
  return { parentTaskId: text(row.parentTaskId, 'parentTaskId'), expectedVersion: (row.expectedVersion ?? 0) as number,
    mode: row.mode as 'EXPERT' | 'TEAM', reason: text(row.reason, 'reason', 2000), integratorBindingId,
    budgetTokens: row.budgetTokens, reserveTokens: row.reserveTokens, items }
}
export function normalizePlanAdoptionParameters(value: unknown): PlanAdoptionParameters {
  const row = object(value, ['plan_id', 'version', 'digest'])
  if (!count(row.version) || row.version < 1 || typeof row.digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.digest)) reject('PLAN_INPUT_INVALID', '采纳必须准确指定计划、正整数版本和完整摘要。')
  return { plan_id: text(row.plan_id, 'plan_id'), version: row.version, digest: row.digest }
}
function planEvents(store: KingdomStore, kingdomId: string): EventRow[] {
  return store.db.prepare("SELECT * FROM events WHERE kingdom_id = ? AND event_type IN ('COLLABORATION_PLAN_PROPOSED', 'COLLABORATION_PLAN_ADOPTED') ORDER BY seq")
    .all(kingdomId) as unknown as EventRow[]
}
function parsePlan(event: EventRow): PlanRecord {
  try {
    const plan = JSON.parse(event.payload_json) as PlanRecord
    const { digest, ...content } = plan
    if (plan.type !== 'KingdomCollaborationPlan/v1' || plan.kingdomId !== event.kingdom_id || plan.planId !== event.target_id
      || event.actor_role !== 'CHANCELLOR' || event.actor_id !== plan.proposedBy
      || plan.proposalEventId !== event.event_id || plan.proposedSeq !== event.seq || ownerInputHash(content) !== digest) reject('PLAN_LEDGER_INVALID', '计划事件与内容摘要不一致。')
    return plan
  } catch (error) { if (error instanceof CollaborationError) throw error; return reject('PLAN_LEDGER_INVALID', '计划事件无法读取。') }
}
function latestRecord(store: KingdomStore, kingdomId: string, planId: string): { plan: PlanRecord; adoption: EventRow | null } | null {
  const events = planEvents(store, kingdomId).filter(event => event.target_id === planId)
  const proposal = events.filter(event => event.event_type === 'COLLABORATION_PLAN_PROPOSED').at(-1)
  if (!proposal) return null
  const plan = parsePlan(proposal)
  const adoption = events.filter(event => event.event_type === 'COLLABORATION_PLAN_ADOPTED').at(-1) ?? null
  if (adoption) {
    const value = JSON.parse(adoption.payload_json) as AdoptionRecord
    if (value.type !== 'KingdomCollaborationAdoption/v1' || value.planId !== plan.planId || value.version !== plan.version
      || adoption.actor_role !== 'OWNER' || adoption.actor_id !== store.getDefaultKingdom()?.owner_id
      || value.digest !== plan.digest || ownerInputHash(value.childTaskIds) !== ownerInputHash(plan.childTaskIds)) reject('PLAN_LEDGER_INVALID', '采纳事件不匹配当前计划。')
  }
  return { plan, adoption }
}
function parentContentDigest(parent: TaskRow): string {
  return ownerInputHash({ taskId: parent.task_id, territoryId: parent.territory_id, parentTaskId: parent.parent_task_id,
    title: parent.title, description: parent.description, acceptanceCriteria: parent.acceptance_criteria })
}
function parentAndContext(store: KingdomStore, kingdomId: string, input: Pick<ProposeCollaborationPlanInput, 'parentTaskId' | 'integratorBindingId' | 'items'>, proposedBy: string): { parent: TaskRow; digest: string } {
  const parent = store.getTask(input.parentTaskId)
  if (!parent || parent.parent_task_id !== null || parent.status !== 'CREATED' || parent.assigned_binding_id !== null
    || store.latestExecution(parent.task_id) || store.getActiveAssignmentForTask(parent.task_id)
    || store.listTasks(kingdomId).some(task => task.parent_task_id === parent.task_id)) reject('PLAN_PARENT_INVALID', '协作父项必须是尚未派发、没有父项或子项的 CREATED 任务。')
  const territoryIds = [...new Set([parent.territory_id, ...input.items.map(item => item.territoryId)])].sort()
  const territories = territoryIds.map(id => {
    const territory = store.getTerritoryById(id)
    if (!territory || territory.kingdom_id !== kingdomId || territory.status !== 'ACTIVE' || !territory.workspace_path) reject('PLAN_TERRITORY_INVALID', '计划领地必须属于当前王国且有效。')
    const supervisor = territory.supervisor_binding_id ? store.getBindingById(territory.supervisor_binding_id) : null
    if (!supervisor || supervisor.kingdom_id !== kingdomId || supervisor.role_type !== 'SUPERVISOR' || supervisor.status !== 'ACTIVE') reject('PLAN_TERRITORY_INVALID', '每个计划领地必须有当前有效主管。')
    return { territory, supervisor }
  })
  const workers = [input.integratorBindingId, ...input.items.map(item => item.workerBindingId)].sort().map(id => {
    const binding = store.getBindingById(id)
    if (!binding || binding.kingdom_id !== kingdomId || binding.role_type !== 'WORKER' || binding.status !== 'ACTIVE') reject('PLAN_WORKER_INVALID', '计划成员必须是当前王国有效 Worker。')
    return binding
  })
  const proposer = store.getBindingById(proposedBy)
  if (!proposer || proposer.kingdom_id !== kingdomId || proposer.role_type !== 'CHANCELLOR' || proposer.status !== 'ACTIVE') reject('PLAN_PROPOSER_INVALID', '计划提案的宰相身份已失效。')
  return { parent, digest: ownerInputHash({ parent, territories, workers, proposer }) }
}
function view(store: KingdomStore, record: { plan: PlanRecord; adoption: EventRow | null }): CollaborationPlanView {
  const { plan, adoption } = record
  let state: CollaborationPlanView['state'] = adoption ? 'ADOPTED' : 'PROPOSED'
  if (!adoption) {
    try { if (parentAndContext(store, plan.kingdomId, plan, plan.proposedBy).digest !== plan.contextDigest) state = 'STALE' }
    catch { state = 'STALE' }
  }
  return { type: plan.type, planId: plan.planId, kingdomId: plan.kingdomId, parentTaskId: plan.parentTaskId, version: plan.version,
    digest: plan.digest, state, mode: plan.mode, reason: plan.reason, integratorBindingId: plan.integratorBindingId,
    budgetTokens: plan.budgetTokens, reserveTokens: plan.reserveTokens, items: structuredClone(plan.items), childTaskIds: [...plan.childTaskIds],
    proposedBy: plan.proposedBy, proposedAt: plan.proposedAt, proposedSeq: plan.proposedSeq, adoptedAt: adoption?.created_at ?? null, adoptedSeq: adoption?.seq ?? null }
}
export function readCollaborationPlan(store: KingdomStore, kingdomId: string, planId: string): CollaborationPlanView | null {
  const record = latestRecord(store, kingdomId, planId)
  return record ? view(store, record) : null
}
export function listCollaborationPlans(store: KingdomStore, kingdomId: string): CollaborationPlanView[] {
  return [...new Set(planEvents(store, kingdomId).filter(event => event.event_type === 'COLLABORATION_PLAN_PROPOSED').map(event => event.target_id!))]
    .map(id => readCollaborationPlan(store, kingdomId, id)!).sort((a, b) => b.proposedSeq - a.proposedSeq)
}
export function proposeCollaborationPlan(store: KingdomStore, ctx: CommandContext, input: ProposeCollaborationPlanInput): CollaborationPlanView {
  const normalized = normalizeProposal(input)
  return store.withImmediateTransaction(() => {
    const role = requireRole(store, ctx, 'CHANCELLOR')
    if (!role.ok) reject(role.code, role.message)
    const prior = listCollaborationPlans(store, ctx.kingdomId).find(plan => plan.parentTaskId === normalized.parentTaskId)
    if (prior?.state === 'ADOPTED') reject('PLAN_ALREADY_ADOPTED', '已采纳计划不可静默改写。')
    if (normalized.expectedVersion !== (prior?.version ?? 0)) reject('PLAN_VERSION_STALE', '提案基准版本已变化，请读取当前计划。')
    const context = parentAndContext(store, ctx.kingdomId, normalized, role.binding.binding_id)
    const { expectedVersion: _, ...content } = normalized
    const items = content.items.map(item => ({ ...item, taskId: randomUUID() }))
    const proposedAt = new Date().toISOString(), proposalEventId = randomUUID()
    const withoutDigest: Omit<PlanRecord, 'digest'> = { ...content, type: 'KingdomCollaborationPlan/v1', planId: prior?.planId ?? randomUUID(),
      kingdomId: ctx.kingdomId, version: (prior?.version ?? 0) + 1, items, childTaskIds: items.map(item => item.taskId),
      proposedBy: role.binding.binding_id, proposedAt, proposedSeq: store.eventSequence() + 1, proposalEventId,
      contextDigest: context.digest, parentContentDigest: parentContentDigest(context.parent), authority: ctx.auth.mode === 'session-bound' ? 'SESSION_BOUND' : 'LOCAL_DEMO' }
    const plan: PlanRecord = { ...withoutDigest, digest: ownerInputHash(withoutDigest) }
    store.appendEvent({ event_id: proposalEventId, kingdom_id: ctx.kingdomId, event_type: 'COLLABORATION_PLAN_PROPOSED',
      actor_role: 'CHANCELLOR', actor_id: role.binding.binding_id, target_type: 'collaboration-plan', target_id: plan.planId,
      payload_json: JSON.stringify(plan), created_at: proposedAt })
    return view(store, { plan, adoption: null })
  })
}
export function adoptCollaborationPlan(store: KingdomStore, input: { kingdomId: string } & PlanAdoptionParameters, auth?: AdminAuth): string {
  const admin = requireAdmin(store, input.kingdomId, auth, { operation: 'plan.adopt', input })
  if (!admin.ok) return admin.message
  const params = normalizePlanAdoptionParameters({ plan_id: input.plan_id, version: input.version, digest: input.digest })
  const write = (): string => {
    const record = latestRecord(store, input.kingdomId, params.plan_id)
    if (!record || record.plan.version !== params.version || record.plan.digest !== params.digest) reject('PLAN_VERSION_STALE', '计划版本或内容摘要已变化。')
    if (record.adoption) reject('PLAN_ALREADY_ADOPTED', '该计划已经采纳，请查询原回执。')
    const plan = record.plan
    if (parentAndContext(store, input.kingdomId, plan, plan.proposedBy).digest !== plan.contextDigest) reject('PLAN_CONTEXT_STALE', '父项、角色或领地已变化，请重新提案。')
    const at = new Date().toISOString()
    for (const item of plan.items) {
      store.insertTask({ task_id: item.taskId, territory_id: item.territoryId, parent_task_id: plan.parentTaskId, title: item.title,
        description: item.description, acceptance_criteria: item.acceptanceCriteria, assigned_binding_id: null, status: 'CREATED', result_summary: null,
        capability_requirement_json: null, created_at: at, updated_at: at })
      store.appendEvent({ event_id: randomUUID(), kingdom_id: input.kingdomId, event_type: 'COLLABORATION_CHILD_CREATED', actor_role: 'SYSTEM',
        actor_id: 'kingdom-plan-adoption', target_type: 'task', target_id: item.taskId,
        payload_json: JSON.stringify({ planId: plan.planId, version: plan.version, digest: plan.digest, parentTaskId: plan.parentTaskId,
          proposalEventId: plan.proposalEventId, proposedBy: plan.proposedBy, proposalAuthority: plan.authority,
          ownerId: admin.ownerPrincipalId, assignmentCreated: false, grantCreated: false, ...admin.eventSource }), created_at: at })
    }
    const adoption: AdoptionRecord = { type: 'KingdomCollaborationAdoption/v1', planId: plan.planId, version: plan.version, digest: plan.digest,
      parentTaskId: plan.parentTaskId, childTaskIds: plan.childTaskIds, carriedRoleSourceRefs: readIncompleteRoleUsageSourceRefs(store, input.kingdomId) }
    store.appendEvent({ event_id: randomUUID(), kingdom_id: input.kingdomId, event_type: 'COLLABORATION_PLAN_ADOPTED', actor_role: 'OWNER',
      actor_id: admin.ownerPrincipalId, target_type: 'collaboration-plan', target_id: plan.planId,
      payload_json: JSON.stringify({ ...adoption, operation: 'plan.adopt', ...admin.eventSource }), created_at: at })
    return '协作计划已按准确版本采纳，子项已创建；仍需各领地主管正常派发、授权和验收，父项不会自动完成。'
  }
  return store.db.isTransaction ? write() : store.withImmediateTransaction(write)
}

export interface CollaborationHandoff {
  taskId: string
  attemptNo: number
  resultId: string
  resultDigest: string
  acceptEventId: string
  acceptEventSeq: number
  summary: string
  artifacts: string[]
}
export interface CollaborationReadiness {
  planId: string
  version: number
  digest: string
  parentTaskId: string
  taskId: string
  kind: 'ITEM' | 'INTEGRATION'
  access: 'READ_ONLY' | 'WRITE'
  workerBindingId: string
  ready: boolean
  reasonCode: string | null
  blockingTaskIds: string[]
  handoffs: CollaborationHandoff[]
}
function acceptedHandoff(store: KingdomStore, kingdomId: string, item: CollaborationPlanItem): CollaborationHandoff | null {
  const task = store.getTask(item.taskId), result = store.latestWorkerResult(item.taskId), execution = store.latestExecution(item.taskId)
  if (!task || task.status !== 'DONE' || task.assigned_binding_id !== item.workerBindingId || !result || !execution
    || result.worker_binding_id !== item.workerBindingId || execution.worker_binding_id !== item.workerBindingId
    || result.attempt_no !== execution.attempt_no || execution.state !== 'COMPLETED' || result.outcome !== 'COMPLETED') return null
  const event = store.db.prepare("SELECT * FROM events WHERE kingdom_id = ? AND event_type = 'TASK_ACCEPTED' AND target_type = 'task' AND target_id = ? ORDER BY seq DESC LIMIT 1")
    .get(kingdomId, item.taskId) as unknown as EventRow | undefined
  if (!event || event.actor_role !== 'SUPERVISOR') return null
  try {
    const accepted = JSON.parse(event.payload_json) as Record<string, unknown>
    const territory = store.getTerritoryById(task.territory_id), supervisor = event.actor_id ? store.getBindingById(event.actor_id) : null
    if (accepted.decision !== 'ACCEPT' || accepted.reviewed_attempt_no !== result.attempt_no || accepted.reviewer_binding_id !== event.actor_id
      || accepted.reviewed_result_id !== result.result_id || accepted.reviewed_result_digest !== ownerInputHash(result)
      || !supervisor || supervisor.kingdom_id !== kingdomId || supervisor.role_type !== 'SUPERVISOR'
      || territory?.supervisor_binding_id !== event.actor_id || supervisor.status !== 'ACTIVE'
      || Date.parse(result.created_at) > Date.parse(event.created_at)) return null
    const payload = JSON.parse(result.result_json) as { summary?: unknown; artifacts?: unknown }
    if (typeof payload.summary !== 'string' || !payload.summary.trim()) return null
    const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts.filter((ref): ref is string => typeof ref === 'string' && ref.length > 0 && ref.length <= 768).slice(0, 8) : []
    return { taskId: item.taskId, attemptNo: result.attempt_no, resultId: result.result_id, resultDigest: ownerInputHash(result),
      acceptEventId: event.event_id, acceptEventSeq: event.seq, summary: payload.summary.slice(0, 2000), artifacts }
  } catch { return null }
}
/** A failed member may retry itself only after review of this exact settled attempt. */
function hasSettledFailedRework(store: KingdomStore, kingdomId: string, taskId: string, preparingLeaseId?: string): boolean {
  const task = store.getTask(taskId), execution = store.latestExecution(taskId), claim = store.latestWorkerResult(taskId)
  if (task?.status !== 'RUNNING' || !execution || !claim || !['FAILED', 'ABORTED'].includes(execution.state)
    || execution.attempt_no !== claim.attempt_no || claim.outcome !== execution.state
    || execution.worker_binding_id !== task.assigned_binding_id || claim.worker_binding_id !== task.assigned_binding_id
    || store.listExecutions(taskId).some(row => !['COMPLETED', 'FAILED', 'ABORTED'].includes(row.state))
    || store.listLeases(kingdomId).some(row => row.task_id === taskId && row.state !== 'RELEASED'
      && !(store.db.isTransaction && row.lease_id === preparingLeaseId && row.state === 'DISPATCH_READY'
        && row.attempt_no === execution.attempt_no + 1 && row.worker_binding_id === task.assigned_binding_id
        && row.territory_id === task.territory_id && !store.listDispatchesForTaskAttempt(taskId, row.attempt_no).length))
    || store.listDispatchesForTaskAttempt(taskId, execution.attempt_no).some(row => !['TERMINAL', 'FAILED'].includes(row.state))) return false
  const rework = store.latestTaskReworkEvent(kingdomId, taskId, claim.attempt_no)
  if (!rework) return false
  try {
    const reviewed = JSON.parse(rework.payload_json)
    return reviewed.decision === 'REWORK' && reviewed.reviewed_result_id === claim.result_id
      && reviewed.reviewed_result_digest === ownerInputHash(claim) && reviewed.reviewed_execution_id === execution.execution_id
  } catch { return false }
}
/** Read-only exact references. Handoff text remains an untrusted Worker Claim. */
export function readCollaborationReadiness(store: KingdomStore, kingdomId: string, taskId: string, preparingLeaseId?: string): CollaborationReadiness | null {
  const plan = listCollaborationPlans(store, kingdomId).find(plan => plan.parentTaskId === taskId || plan.childTaskIds.includes(taskId))
  if (!plan) return null
  const item = plan.items.find(item => item.taskId === taskId)
  const result: CollaborationReadiness = { planId: plan.planId, version: plan.version, digest: plan.digest, parentTaskId: plan.parentTaskId,
    taskId, kind: item ? 'ITEM' : 'INTEGRATION', access: item?.access ?? 'WRITE', workerBindingId: item?.workerBindingId ?? plan.integratorBindingId,
    ready: false, reasonCode: null, blockingTaskIds: [], handoffs: [] }
  const blocked = (reasonCode: string, tasks: string[] = []): CollaborationReadiness => ({ ...result, reasonCode, blockingTaskIds: tasks })
  if (plan.state !== 'ADOPTED') return blocked('PLAN_NOT_ADOPTED')
  const parent = store.getTask(plan.parentTaskId), task = store.getTask(taskId), worker = store.getBindingById(result.workerBindingId)
  const record = latestRecord(store, kingdomId, plan.planId)!
  const parentTerritory = parent ? store.getTerritoryById(parent.territory_id) : null
  if (!parent || parent.parent_task_id !== null || !task || !worker || worker.status !== 'ACTIVE' || worker.role_type !== 'WORKER'
    || !parentTerritory || parentTerritory.kingdom_id !== kingdomId || parentTerritory.status !== 'ACTIVE'
    || parentContentDigest(parent) !== record.plan.parentContentDigest
    || worker.kingdom_id !== kingdomId || task.assigned_binding_id !== null && task.assigned_binding_id !== result.workerBindingId) return blocked('PLAN_MEMBER_CHANGED', [taskId])
  for (const member of plan.items) {
    const child = store.getTask(member.taskId), territory = store.getTerritoryById(member.territoryId)
    const binding = store.getBindingById(member.workerBindingId)
    if (!child || child.parent_task_id !== plan.parentTaskId || child.territory_id !== member.territoryId || child.title !== member.title
      || child.description !== member.description || child.acceptance_criteria !== member.acceptanceCriteria
      || child.assigned_binding_id !== null && child.assigned_binding_id !== member.workerBindingId
      || !binding || binding.kingdom_id !== kingdomId || binding.role_type !== 'WORKER' || binding.status !== 'ACTIVE'
      || !territory || territory.kingdom_id !== kingdomId || territory.status !== 'ACTIVE') return blocked('PLAN_MEMBER_CHANGED', [member.taskId])
  }
  const retryingSettledFailure = hasSettledFailedRework(store, kingdomId, taskId, preparingLeaseId)
  const failed = [parent.task_id, ...plan.childTaskIds].filter(id => {
    const current = store.getTask(id), execution = store.latestExecution(id)
    return current?.status === 'FAILED' || execution?.state === 'RECOVERING'
      || current?.status !== 'DONE' && ['FAILED', 'ABORTED'].includes(execution?.state ?? '')
        && (!retryingSettledFailure || !hasSettledFailedRework(store, kingdomId, id, id === taskId ? preparingLeaseId : undefined))
      || store.listDispatchesForTaskAttempt(id, execution?.attempt_no ?? 0).some(dispatch => dispatch.state === 'RECOVERING')
  })
  if (failed.length) return blocked('PLAN_MEMBER_FAILED_OR_UNKNOWN', failed)
  if (!['CREATED', 'ASSIGNED', 'RUNNING'].includes(task.status)) return blocked('TASK_NOT_STARTABLE', [taskId])
  const dependencies = item ? plan.items.filter(member => item.dependsOn.includes(member.key)) : plan.items
  for (const dependency of dependencies) {
    const handoff = acceptedHandoff(store, kingdomId, dependency)
    if (!handoff) result.blockingTaskIds.push(dependency.taskId)
    else result.handoffs.push(handoff)
  }
  if (result.blockingTaskIds.length) return { ...result, reasonCode: 'DEPENDENCY_NOT_ACCEPTED_OR_STALE', handoffs: [] }
  return { ...result, ready: true }
}
/** Recompute before dispatch; caller-supplied or stale references never become authority. */
export function validateCollaborationHandoffs(store: KingdomStore, kingdomId: string, taskId: string, expected: readonly CollaborationHandoff[], preparingLeaseId?: string): boolean {
  const readiness = readCollaborationReadiness(store, kingdomId, taskId, preparingLeaseId)
  return !!readiness?.ready && ownerInputHash(readiness.handoffs) === ownerInputHash(expected)
}

export interface PlanBudgetView {
  scope: 'PLAN_WITH_KINGDOM_COORDINATION_UPPER_BOUND'
  planId: string
  limitTokens: number
  reserveTokens: number
  workerVerifiedTokens: number
  coordinationUpperBoundTokens: number
  reservedEstimateTokens: number
  exposureTokens: number
  remainingTokens: number
  pendingUnits: number
  unknownUnits: number
  attributionGapCount: number
  state: 'ALLOW' | 'WARN' | 'BLOCK_LIMIT' | 'BLOCK_UNKNOWN'
  amount: null
}
/** Members are exact; all observable concurrent kingdom coordination is a conservative upper bound. */
export function readPlanBudgetView(store: KingdomStore, kingdomId: string, planId: string): PlanBudgetView | null {
  const record = latestRecord(store, kingdomId, planId)
  if (!record?.adoption) return null
  const { plan, adoption } = record
  const adopted = JSON.parse(adoption.payload_json) as AdoptionRecord
  const members = new Set([plan.parentTaskId, ...plan.childTaskIds])
  const admissions = new Map<string, { admissionId: string; taskId: string; attemptNo: number; reservedTokens: number; state: string; dispatchId: string | null }>()
  for (const event of store.listBudgetEvents(kingdomId)) {
    if (!event.event_type.startsWith('BUDGET_ADMISSION_')) continue
    const value = JSON.parse(event.payload_json)
    if (members.has(value.taskId)) admissions.set(value.admissionId, value)
  }
  let workerVerifiedTokens = 0, reservedEstimateTokens = 0, pendingUnits = 0, unknownUnits = 0
  const dispatches = store.listDispatches(kingdomId).filter(dispatch => members.has(dispatch.task_id))
  const ids = new Set(dispatches.map(dispatch => dispatch.dispatch_id))
  for (const dispatch of dispatches) {
    const usage = readDispatchUsage(store, dispatch.dispatch_id)
    const complete = usage?.status === 'COMPLETE' && usage.taskId === dispatch.task_id && usage.attemptNo === dispatch.attempt_no
      && usage.usage !== null && count(usage.usage.totalTokens)
    const tokens = complete ? usage.usage!.totalTokens : 0
    workerVerifiedTokens = add(workerVerifiedTokens, tokens)
    const pending = !['TERMINAL', 'FAILED'].includes(dispatch.state)
    if (pending) pendingUnits++
    else if (!complete) unknownUnits++
    if (pending || !complete) reservedEstimateTokens = add(reservedEstimateTokens, Math.max(0, plan.reserveTokens - tokens))
  }
  for (const admission of admissions.values()) {
    if (admission.state === 'CANCELLED' || admission.state === 'BOUND' && ids.has(admission.dispatchId ?? '')) continue
    reservedEstimateTokens = add(reservedEstimateTokens, plan.reserveTokens); pendingUnits++
    if (admission.state === 'BOUND' || !isBudgetAdmissionInvocationActive(store, admission.admissionId)) unknownUnits++
  }
  // A legacy or otherwise unmatched Execution has no proven Dispatch usage.
  // Keep its risk visible instead of treating a missing metering seam as free.
  const dispatchAttempts = new Set(dispatches.map(dispatch => `${dispatch.task_id}:${dispatch.attempt_no}`))
  const reservedAttempts = new Set([...admissions.values()].filter(admission => admission.state !== 'CANCELLED')
    .map(admission => `${admission.taskId}:${admission.attemptNo}`))
  for (const taskId of members) for (const execution of store.listExecutions(taskId)) {
    const key = `${taskId}:${execution.attempt_no}`
    if (dispatchAttempts.has(key)) continue
    unknownUnits++
    if (!reservedAttempts.has(key)) {
      reservedEstimateTokens = add(reservedEstimateTokens, plan.reserveTokens)
      if (!['COMPLETED', 'FAILED', 'ABORTED'].includes(execution.state)) pendingUnits++
    }
  }
  const other = readAdditionalBudgetUsage(store, kingdomId, adoption.seq, adopted.carriedRoleSourceRefs)
  pendingUnits = add(pendingUnits, other.pendingUnits); unknownUnits = add(unknownUnits, other.unknownUnits)
  reservedEstimateTokens = add(reservedEstimateTokens, other.pendingUnits * plan.reserveTokens)
  const exposureTokens = add(add(workerVerifiedTokens, other.verifiedTokens), reservedEstimateTokens)
  const state = unknownUnits > 0 ? 'BLOCK_UNKNOWN' : add(exposureTokens, plan.reserveTokens) > plan.budgetTokens ? 'BLOCK_LIMIT'
    : other.attributionGapCount > 0 || exposureTokens >= plan.budgetTokens * 0.8 ? 'WARN' : 'ALLOW'
  return { scope: 'PLAN_WITH_KINGDOM_COORDINATION_UPPER_BOUND', planId, limitTokens: plan.budgetTokens, reserveTokens: plan.reserveTokens,
    workerVerifiedTokens, coordinationUpperBoundTokens: other.verifiedTokens, reservedEstimateTokens, exposureTokens,
    remainingTokens: Math.max(0, plan.budgetTokens - exposureTokens), pendingUnits, unknownUnits, attributionGapCount: other.attributionGapCount, state, amount: null }
}
