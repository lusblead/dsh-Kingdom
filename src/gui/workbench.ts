import type {
  ActionAvailability, ExecutionView, PersonalWorkbenchData, RuntimeGovernanceView,
  SourceRef, SupervisorDecisionView, TaskView, WorkbenchActionItem, WorkbenchDeliveryItem,
  WorkbenchQueue, WorkbenchRoleItem, WorkbenchUsageSummary, WorkbenchCostSummary, WorkbenchCollaborationView,
} from './contract.js'

export const WORKBENCH_ITEM_LIMIT = 40

/** All inputs are public projections. This module has no Store, command or model access. */
export interface PersonalWorkbenchInput {
  kingdomPresent: boolean
  bindings: { bindingId: string; roleType: string; roleName: string; status: string; sessionBound: boolean }[]
  territories: { territoryId: string; name: string; status: string; supervisorBindingId: string | null }[]
  tasks: {
    task: Pick<TaskView, 'taskId' | 'territoryId' | 'title' | 'status' | 'assignedBindingId' | 'latestClaim' | 'latestExecution' | 'updatedAt'>
    actionAvailability: ActionAvailability[]
    latestReview: SupervisorDecisionView | null
    claimExecutionMismatch: boolean
  }[]
  executions: Pick<ExecutionView, 'executionId' | 'taskId' | 'workerBindingId' | 'state'>[]
  governance: RuntimeGovernanceView
  cost?: WorkbenchCostSummary
  collaboration?: WorkbenchCollaborationView
}

const source = (entityType: string, entityId: string | null): SourceRef => ({ sourceType: 'table-row', entityType, entityId })
const rule = (ruleCode: string): SourceRef => ({ sourceType: 'derived-rule', entityType: 'projection-rule', entityId: null, ruleCode })
const live = (state: string): boolean => ['STARTING', 'RUNNING', 'PAUSED', 'RECOVERING'].includes(state)
const queue = <T>(items: T[]): WorkbenchQueue<T> => ({ totalCount: items.length, items: items.slice(0, WORKBENCH_ITEM_LIMIT), truncated: items.length > WORKBENCH_ITEM_LIMIT })

/** Sum only provider reports whose identity and numeric shape match this Dispatch. */
export function buildWorkbenchUsage(input: Pick<PersonalWorkbenchInput, 'governance' | 'executions'>): WorkbenchUsageSummary {
  let completeDispatches = 0
  let partialDispatches = 0
  let unavailableDispatches = 0
  const totals = { uncachedInputTokens: 0, outputTokens: 0, totalTokens: 0 }
  const dispatches = [...new Map(input.governance.dispatches.map(dispatch => [dispatch.dispatchId, dispatch])).values()]
  for (const dispatch of dispatches) {
    const report = dispatch.usage
    const matches = report?.type === 'KingdomDispatchUsage/v1' && report.source === 'provider-reported'
      && report.dispatchId === dispatch.dispatchId && report.taskId === dispatch.taskId && report.attemptNo === dispatch.attemptNo
    if (matches && report.status === 'PARTIAL') {
      partialDispatches += 1
      continue
    }
    const usage = matches && report.status === 'COMPLETE' ? report.usage : null
    if (!usage || ![usage.uncachedInputTokens, usage.outputTokens, usage.totalTokens].every(value => Number.isSafeInteger(value) && value >= 0)
      || !Object.keys(totals).every(key => Number.isSafeInteger(totals[key as keyof typeof totals] + usage[key as keyof typeof totals]))) {
      unavailableDispatches += 1
      continue
    }
    completeDispatches += 1
    totals.uncachedInputTokens += usage.uncachedInputTokens
    totals.outputTokens += usage.outputTokens
    totals.totalTokens += usage.totalTokens
  }
  const dispatchExecutionIds = new Set(dispatches.map(dispatch => dispatch.executionId))
  const executionsWithoutDispatch = input.executions.filter(execution => !dispatchExecutionIds.has(execution.executionId)).length
  return {
    scope: 'WORKER_DISPATCH_ONLY', totalDispatches: dispatches.length, completeDispatches, partialDispatches, unavailableDispatches,
    executionsWithoutDispatch,
    coverage: completeDispatches === 0 && partialDispatches === 0 ? 'UNAVAILABLE'
      : completeDispatches === dispatches.length && executionsWithoutDispatch === 0 ? 'COMPLETE' : 'PARTIAL',
    reportedTotals: completeDispatches ? totals : null,
    cost: null, costStatus: 'NOT_RECORDED',
    sourceRefs: [rule('WORKER_DISPATCH_USAGE_COVERAGE'), rule('WORKER_SUMMARY_EXCLUDES_OTHER_USAGE')],
  }
}

/** Derive current work; past DENIED and ordinary in-flight receipts are not current incidents. */
export function buildPersonalWorkbench(input: PersonalWorkbenchInput): PersonalWorkbenchData {
  const ownerActions: WorkbenchActionItem[] = []
  const internalActions: WorkbenchActionItem[] = []
  const exceptions: WorkbenchActionItem[] = []
  const deliveries: WorkbenchDeliveryItem[] = []
  const activeBindings = input.bindings.filter(binding => binding.status === 'ACTIVE')
  const supervisors = new Map(activeBindings.filter(binding => binding.roleType === 'SUPERVISOR').map(binding => [binding.bindingId, binding]))
  const territories = new Map(input.territories.map(territory => [territory.territoryId, territory]))
  const ownerConfiguration = (kind: string, title: string, summary: string, territoryId: string | null = null): void => {
    ownerActions.push({ id: `${kind}:${territoryId ?? 'kingdom'}`, kind, title, summary, territoryId, taskId: null,
      responsibility: 'OWNER', responsibleBindingId: null, actionAvailability: [],
      sourceRefs: [rule(kind), ...(territoryId ? [source('territories', territoryId)] : [])] })
  }
  if (!input.kingdomPresent) {
    ownerConfiguration('KINGDOM_CONFIGURATION_REQUIRED', '建立王国', '尚未初始化王国。请通过现有的用户设置入口创建王国。')
  } else {
    if (!activeBindings.some(binding => binding.roleType === 'CHANCELLOR')) {
      ownerConfiguration('CHANCELLOR_CONFIGURATION_REQUIRED', '任命宰相', '当前没有有效的宰相绑定。需要用户通过现有任命入口完成配置。')
    }
    if (!input.territories.some(territory => territory.status === 'ACTIVE')) {
      ownerConfiguration('TERRITORY_CONFIGURATION_REQUIRED', '建立工作领地', '当前没有可用领地。需要用户通过现有设置入口创建领地。')
    }
    for (const territory of input.territories) {
      if (territory.status !== 'ACTIVE') continue
      if (!territory.supervisorBindingId || !supervisors.has(territory.supervisorBindingId)) {
        ownerConfiguration('TERRITORY_SUPERVISOR_CONFIGURATION_REQUIRED', `为「${territory.name}」指定主管`,
          '领地没有有效的在任主管。需要用户作任命决定；这不是任务的人类验收请求。', territory.territoryId)
      }
    }
  }

  const orderedTasks = [...input.tasks].sort((left, right) => right.task.updatedAt.localeCompare(left.task.updatedAt) || left.task.taskId.localeCompare(right.task.taskId))
  const recoveringTaskIds = new Set<string>()
  for (const item of orderedTasks) {
    const { task, actionAvailability } = item
    const territory = territories.get(task.territoryId)
    const supervisor = territory?.status === 'ACTIVE' && territory.supervisorBindingId ? supervisors.get(territory.supervisorBindingId) : null
    const responsibility = supervisor ? 'SUPERVISOR' as const : 'UNDETERMINED' as const
    const taskRefs = [source('tasks', task.taskId), source('territories', task.territoryId)]
    const action = (kind: string, summary: string, extraRefs: SourceRef[] = []): WorkbenchActionItem => ({
      id: `${kind}:${task.taskId}`, kind, taskId: task.taskId, territoryId: task.territoryId,
      title: task.title, summary, responsibility, responsibleBindingId: supervisor?.bindingId ?? null,
      actionAvailability, sourceRefs: [...taskRefs, ...extraRefs].slice(0, 8),
    })
    const dispatches = input.governance.dispatches.filter(dispatch => dispatch.taskId === task.taskId)
    const leases = input.governance.leases.filter(lease => lease.taskId === task.taskId)
    const recoveringDispatches = dispatches.filter(dispatch => dispatch.state === 'RECOVERING')
    const unreleased = leases.filter(lease => lease.state === 'RECOVERING' || (lease.state === 'TERMINAL' && !lease.releasedAt))
    const recovering = task.latestExecution?.state === 'RECOVERING' || recoveringDispatches.length > 0 || unreleased.length > 0
    if (recovering) {
      recoveringTaskIds.add(task.taskId)
      exceptions.push(action('EXECUTION_RECOVERY_REQUIRED', supervisor
        ? '主管需先核对原执行的运行证据与资源释放，再决定后续；当前不能视为已完成。'
        : '原执行的运行证据或资源释放尚未确认；当前没有可确认的有效主管，先核实领地任命。', [
        ...(task.latestExecution?.state === 'RECOVERING' ? [source('executions', task.latestExecution.executionId)] : []),
        ...recoveringDispatches.map(dispatch => source('dispatch_records', dispatch.dispatchId)),
        ...unreleased.map(lease => source('execution_leases', lease.leaseId)),
      ]))
    }
    if (item.claimExecutionMismatch) {
      exceptions.push(action('CLAIM_EXECUTION_MISMATCH', '执行者自述与同次执行的运行证据不一致，需要主管核验；尚不能确认交付。', [
        source('worker_results', task.latestClaim?.resultId ?? null), source('executions', task.latestExecution?.executionId ?? null),
      ]))
    }
    // Only the latest unambiguous denial before a still-pending start is current.
    const decisions = input.governance.decisions.filter(decision => decision.taskId === task.taskId)
    const newestTime = decisions.reduce((latest, decision) => decision.createdAt > latest ? decision.createdAt : latest, '')
    const newest = decisions.filter(decision => decision.createdAt === newestTime)
    const denial = newest.length === 1 && newest[0]!.decision === 'DENIED' ? newest[0] : null
    const pendingStart = actionAvailability.some(availability => availability.action === 'start' && availability.lifecycleAllowed)
    if (!recovering && denial && pendingStart && (!task.latestExecution || task.latestExecution.startedAt < denial.createdAt)) {
      exceptions.push(action('CAPABILITY_DENIED', `最近一次能力检查被拒绝${denial.reasonCode ? `（${denial.reasonCode}）` : ''}。由主管检查任务需求及运行配置；该记录不自动要求用户扩大权限。`, [source('capability_decisions', denial.decisionId)]))
    }
    if (task.status === 'REVIEW') {
      internalActions.push(action('SUPERVISOR_REVIEW', supervisor ? '执行者已提交自述，等待本领地主管审查。尚不是用户验收待办。' : '执行者已提交自述，但当前没有有效的领地主管；待任命明确后再审查。'))
    } else if (!recovering && task.status === 'CREATED') {
      internalActions.push(action('SUPERVISOR_ASSIGN', '任务已创建，等待领地主管选择执行者。'))
    } else if (!recovering && pendingStart) {
      internalActions.push(action(item.latestReview?.decision === 'REWORK' ? 'SUPERVISOR_REWORK' : 'SUPERVISOR_START',
        item.latestReview?.decision === 'REWORK' ? '主管已要求返工，下一次执行尚未开始。' : '任务已分配，等待主管启动执行。'))
    }
    if (task.latestClaim || task.status === 'DONE') {
      const accepted = task.status === 'DONE' && item.latestReview?.decision === 'ACCEPT'
        && item.latestReview.reviewedAttemptNo === task.latestClaim?.attemptNo
      deliveries.push({ taskId: task.taskId, title: task.title, status: task.status, claim: task.latestClaim,
        supervisorAccepted: accepted, supervisorDecision: item.latestReview, humanAcceptance: 'NOT_RECORDED', updatedAt: task.updatedAt,
        sourceRefs: [...taskRefs, ...(task.latestClaim ? [source('worker_results', task.latestClaim.resultId)] : []), ...(item.latestReview?.sourceRefs ?? [])].slice(0, 8) })
    }
  }

  const roles: WorkbenchRoleItem[] = activeBindings.map(binding => {
    const taskItems = orderedTasks.filter(({ task }) => binding.roleType === 'WORKER' ? task.assignedBindingId === binding.bindingId
      : binding.roleType === 'SUPERVISOR' ? territories.get(task.territoryId)?.supervisorBindingId === binding.bindingId
        : binding.roleType === 'CHANCELLOR')
    const taskIds = new Set(taskItems.map(({ task }) => task.taskId))
    const roleExecutions = input.executions.filter(execution => live(execution.state)
      && (binding.roleType === 'WORKER' ? execution.workerBindingId === binding.bindingId : taskIds.has(execution.taskId)))
    return { bindingId: binding.bindingId, roleType: binding.roleType, roleName: binding.roleName, sessionBound: binding.sessionBound,
      taskCount: taskItems.length, taskIds: [...taskIds].slice(0, WORKBENCH_ITEM_LIMIT), taskIdsTruncated: taskIds.size > WORKBENCH_ITEM_LIMIT,
      activeExecutionCount: roleExecutions.length, reviewTaskCount: taskItems.filter(({ task }) => task.status === 'REVIEW').length,
      recoveringTaskCount: taskItems.filter(({ task }) => recoveringTaskIds.has(task.taskId)).length,
      sourceRefs: [source('role_bindings', binding.bindingId), rule('ROLE_TASK_RESPONSIBILITY_DERIVED')] }
  })
  for (const plan of input.collaboration?.plans.items ?? []) {
    if (plan.state !== 'PROPOSED') continue
    ownerActions.push({ id: 'plan:' + plan.planId, kind: 'PLAN_ADOPTION', taskId: plan.parentTaskId, territoryId: null,
      title: '采纳协作计划 · ' + plan.title, summary: '审阅一份完整计划：分工、依赖、整合者及整项软预算。采纳后仍由主管合法推进，不自动派发。',
      responsibility: 'OWNER', responsibleBindingId: null, actionAvailability: [], sourceRefs: [source('tasks', plan.parentTaskId), rule('COLLABORATION_PLAN_PROPOSED')] })
  }
  const ownerQueue = queue(ownerActions)
  const omittedAdoptions = Math.max(0, (input.collaboration?.pendingAdoptionCount ?? 0) - (input.collaboration?.plans.items.filter(plan => plan.state === 'PROPOSED').length ?? 0))
  ownerQueue.totalCount += omittedAdoptions; ownerQueue.truncated ||= omittedAdoptions > 0
  return { ownerActions: ownerQueue, internalActions: queue(internalActions), exceptions: queue(exceptions), deliveries: queue(deliveries), roles: queue(roles), usage: buildWorkbenchUsage(input),
    collaboration: input.collaboration ?? { plans: queue([]), resources: queue([]), pendingAdoptionCount: 0 },
    cost: input.cost ?? { additionalRoles: null, budget: null, prompts: queue([]), runtime: { toolDisclosureMode: 'UNKNOWN', observerAvailable: null } } }
}
