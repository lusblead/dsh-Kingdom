import type {
  ActionAvailability, DeliveryItemQuestionState, DeliveryItemView, DeliveryModuleView, ExecutionView, PersonalWorkbenchData,
  RuntimeGovernanceView, SourceRef, SupervisorDecisionView, TaskView, WorkbenchAcceptanceEvidence,
  WorkbenchActionItem, WorkbenchDeliveryItem, WorkbenchQueue, WorkbenchRoleItem, WorkbenchUsageSummary,
  WorkbenchCostSummary, WorkbenchCollaborationView,
} from './contract.js'
import type { DeliveryAcceptanceEvidenceKind, DeliveryItemAcknowledgementView } from '../core/delivery-ack.js'

export const WORKBENCH_ITEM_LIMIT = 40

/**
 * 已确认交付的条目层输入。
 *
 * 由只读投影（`snapshot.ts`）用 core 的纯函数构造好后传入；本模块保持
 * 「无 Store、无命令、无 model」的性质，也自带终态知悉视图（不再二次推导版本）。
 */
export interface WorkbenchDeliverySource {
  deliveryId: string
  attemptNo: number
  /**
   * 主管 ACCEPT 实际依据的接受证据强度。
   * `LEGACY_ATTEMPT_ONLY` 时界面必须可见地标注「历史接受证据较弱」。
   */
  acceptanceEvidenceKind: DeliveryAcceptanceEvidenceKind
  /** 弱证据的固定标注文案；强证据为 null。 */
  acceptanceEvidenceNote: string | null
  /** 成果摘要层条目（执行者自述摘要），自身也有独立 ID 与内容版本。 */
  summary: WorkbenchSummaryItemProjection
  /** 成果摘要层的提问元数据（不含正文）；与 `deliveryQuestions` 汇总不重复计数。 */
  summaryQuestions: DeliveryItemQuestionState | null
  /** 证据层条目；顺序稳定，ID 与内容版本由 core 定义。 */
  evidence: WorkbenchDeliveryItemProjection[]
}

/** legacy 弱证据的界面回退文案（core 未给 note 时使用，措辞与 core 一致）。 */
const LEGACY_ACCEPTANCE_FALLBACK_NOTE = '历史接受证据较弱：该 Task/attempt 的 TASK_ACCEPTED 是 v1.0.0 旧格式，只有尝试编号，缺少被审查结果 ID 与内容摘要；本条按真实事件字段与同 Task/attempt 的唯一 WorkerResult 判定，不构成 exact result-bound 证据。'

/** 条目层的公开、有界投影；不含 store/runtime/session 引用。 */
export interface WorkbenchDeliveryItemProjection {
  itemId: string
  contentHash: string
  label: string
  detail: string
  change: DeliveryItemView['change']
  acknowledgement: DeliveryItemAcknowledgementView
  /** 提问元数据（计数与可达性），绝不含问题或回复正文。 */
  questions: DeliveryItemQuestionState | null
}

/** 后果摘要在交付区的首条呈现；它自身也是一条有独立版本的可知悉条目。 */
export interface WorkbenchSummaryItemProjection extends WorkbenchDeliveryItemProjection {
  layer: 'SUMMARY'
}

/** All inputs are public projections. This module has no Store, command or model access. */
export interface PersonalWorkbenchInput {
  kingdomPresent: boolean
  /** 已投影的王国 ID；只用于工作台生成准确的 Owner 激活命令，不授予任何权限。 */
  kingdomId?: string | null
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
  /**
   * 已确认交付的三层结构，按 taskId 索引；仅同一 Task/attempt 主管 ACCEPT 后存在。
   * 缺失时交付仍然显示，但明确标注尚未确认，且不给出条目层。
   */
  deliveryLayers?: Record<string, WorkbenchDeliverySource>
}

const source = (entityType: string, entityId: string | null): SourceRef => ({ sourceType: 'table-row', entityType, entityId })
const rule = (ruleCode: string): SourceRef => ({ sourceType: 'derived-rule', entityType: 'projection-rule', entityId: null, ruleCode })
const live = (state: string): boolean => ['STARTING', 'RUNNING', 'PAUSED', 'RECOVERING'].includes(state)
const queue = <T>(items: T[]): WorkbenchQueue<T> => ({ totalCount: items.length, items: items.slice(0, WORKBENCH_ITEM_LIMIT), truncated: items.length > WORKBENCH_ITEM_LIMIT })

/** 证据层条目的模块归属；顺序固定，未归入已知分组的条目自成模块且不丢失。 */
const DELIVERY_MODULE_LABELS: readonly { match: (label: string) => boolean; moduleId: string; label: string; detail: string }[] = [
  { match: label => label.startsWith('产物引用'), moduleId: 'artifacts', label: '模块 · 产物引用',
    detail: '执行者自述提出的产物引用文本；是 Claim，不是独立验证结果，也不构成仓库路径。' },
  { match: label => label.startsWith('执行者报告的风险'), moduleId: 'risks', label: '模块 · 执行者报告的风险',
    detail: '执行者自述的风险；未经核验，不代表已接受或已消除。' },
]

function buildDeliveryModules(sourceInput: WorkbenchDeliverySource | undefined): DeliveryModuleView[] {
  if (!sourceInput) return []
  const module = (moduleId: string, label: string, detail: string, items: WorkbenchDeliveryItemProjection[]): DeliveryModuleView => ({
    moduleId: sourceInput.deliveryId + ':' + moduleId, label, detail,
    items: items.map(item => ({ ...item, layer: 'EVIDENCE' as const })),
  })
  const evidence = sourceInput.evidence
  const modules: DeliveryModuleView[] = []
  const claimed = new Set<string>()
  for (const definition of DELIVERY_MODULE_LABELS) {
    const matched = evidence.filter(item => definition.match(item.label))
    for (const item of matched) claimed.add(item.itemId)
    if (matched.length) modules.push(module(definition.moduleId, definition.label, definition.detail, matched))
  }
  const rest = evidence.filter(item => !claimed.has(item.itemId))
  if (rest.length) modules.push(module('other-evidence', '模块 · 其他证据条目', '未归入已知证据分组的条目仍逐条列出。', rest))
  if (!modules.length) {
    modules.push(module('no-evidence', '模块 · 无证据条目',
      '本次已确认交付没有执行者提供的产物引用或风险条目；这不是「无风险」或「已验证」的证明。', []))
  }
  return modules
}

/**
 * 汇总条目知悉状态。
 *
 * 外层摘要与子条各自计数：摘要已知悉不等于子条已知悉，反之亦然。
 * 旧版本知悉只计入 `pendingRevisionCount` 的历史，不使当前版本显示为已知悉。
 *
 * `acceptanceEvidence` 为 legacy 弱证据时，弱证据标注拼进同一条 note：
 * Owner 无论读到哪一处都会看到「历史接受证据较弱」，不会把该交付误当成
 * exact result-bound。
 */
function deliveryAcknowledgementSummary(
  modules: DeliveryModuleView[],
  summaryItem: WorkbenchSummaryItemProjection | null,
  acceptanceEvidence: WorkbenchAcceptanceEvidence | null = null,
): WorkbenchDeliveryItem['acknowledgement'] {
  const items = modules.flatMap(module => module.items)
  const acknowledgedSubItems = items.filter(item => item.acknowledgement.acknowledged)
  const acknowledgedCount = acknowledgedSubItems.length + (summaryItem?.acknowledgement.acknowledged ? 1 : 0)
  const totalItems = items.length + (summaryItem ? 1 : 0)
  const pendingCount = items.filter(item => item.acknowledgement.state === 'PENDING').length
    + (summaryItem && summaryItem.acknowledgement.state === 'PENDING' ? 1 : 0)
  const pendingRevisionCount = items.filter(item => item.acknowledgement.state === 'PENDING_REVISION').length
    + (summaryItem && summaryItem.acknowledgement.state === 'PENDING_REVISION' ? 1 : 0)
  const times = [...(summaryItem?.acknowledgement.acknowledgedAt ? [summaryItem.acknowledgement.acknowledgedAt] : []),
    ...acknowledgedSubItems.map(item => item.acknowledgement.acknowledgedAt ?? '').filter(Boolean)].sort()
  const whole = totalItems > 0 && acknowledgedCount === totalItems
  const base = whole
    ? '外层摘要与全部子条均已逐条知悉；这不等于人类验收、Task DONE 或发布授权。'
    : '逐条知悉只表示已知悉该条当前版本，不代表理解、质量认可、人类验收、Task DONE 或发布授权；外层摘要知悉不覆盖子条。'
  const legacy = acceptanceEvidence?.kind === 'LEGACY_ATTEMPT_ONLY'
  return {
    acknowledgedCount,
    pendingCount,
    pendingRevisionCount,
    lastAcknowledgedAt: times.length ? times[times.length - 1]! : null,
    note: legacy ? `${acceptanceEvidence.note} ${base}` : base,
  }
}

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
    // v3.2.0：领地与主管完全绑定。3.2.0 之前建立的、没有隶属领地的遗留主管席位不会被自动归属，
    // 其可见性由**席位投影**（roles[].territories 为空 → 界面标注「未隶属领地（待处理）」）承担；
    // 这里刻意不为每个遗留席位生成 Owner 待办：那样待办数量会随遗留席位线性膨胀，
    // 而真正可执行的任命入口是领地侧的「为某领地指定主管」。
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
      const layer = accepted ? input.deliveryLayers?.[task.taskId] ?? null : null
      const modules = buildDeliveryModules(layer ?? undefined)
      const summaryItem: WorkbenchSummaryItemProjection | null = layer
        ? { ...layer.summary, layer: 'SUMMARY' }
        : null
      // 问答元数据只做计数汇总：正文既不进工作台，也不进任何通用投影。
      // 摘要层由 `summaryQuestions` 单独承载，因此这里的 `deliveryQuestions` 只含
      // 证据层条目，汇总时也不会把同一条提问计两次。
      const questionStates: DeliveryItemQuestionState[] = modules.flatMap(module => module.items)
        .map(entry => entry.questions)
        .filter((state): state is DeliveryItemQuestionState => Boolean(state))
      const acceptanceEvidence: WorkbenchAcceptanceEvidence | null = layer
        ? { kind: layer.acceptanceEvidenceKind, exactResultBound: layer.acceptanceEvidenceKind === 'EXACT_RESULT_BOUND',
          note: layer.acceptanceEvidenceKind === 'LEGACY_ATTEMPT_ONLY'
            ? layer.acceptanceEvidenceNote ?? LEGACY_ACCEPTANCE_FALLBACK_NOTE
            : null }
        : null
      deliveries.push({ taskId: task.taskId, title: task.title, status: task.status, claim: task.latestClaim,
        supervisorAccepted: accepted, supervisorDecision: item.latestReview, humanAcceptance: 'NOT_RECORDED', updatedAt: task.updatedAt,
        deliveryConfirmed: accepted, acceptanceEvidence,
        deliveryId: accepted ? layer?.deliveryId ?? null : null, attemptNo: accepted ? layer?.attemptNo ?? null : null,
        kingdomId: input.kingdomId ?? null, territoryId: task.territoryId, territoryName: territory?.name ?? null,
        supervisorBindingId: territory?.supervisorBindingId ?? null,
        summary: summaryItem ? summaryItem.detail : null,
        summaryItemId: summaryItem ? summaryItem.itemId : null,
        summaryContentHash: summaryItem ? summaryItem.contentHash : null,
        summaryAcknowledgement: summaryItem ? summaryItem.acknowledgement : null,
        summaryQuestions: layer?.summaryQuestions ?? null,
        modules,
        deliveryQuestions: questionStates,
        acknowledgement: layer
          ? deliveryAcknowledgementSummary(modules, summaryItem, acceptanceEvidence)
          : { acknowledgedCount: 0, pendingCount: 0, pendingRevisionCount: 0, lastAcknowledgedAt: null,
            note: '交付尚未由主管 ACCEPT 确认，条目层与知悉不适用；执行者自述不构成交付。' },
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
    // v3.2.0：主管席位的领地归属直接来自领地投影（同一份事实）；空列表 = 未隶属领地。
    const seatTerritories = binding.roleType === 'SUPERVISOR'
      ? input.territories.filter(territory => territory.status === 'ACTIVE' && territory.supervisorBindingId === binding.bindingId)
        .map(territory => ({ territoryId: territory.territoryId, name: territory.name }))
      : []
    return { bindingId: binding.bindingId, roleType: binding.roleType, roleName: binding.roleName, sessionBound: binding.sessionBound,
      territories: seatTerritories,
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
    deliveryQuestions: deliveryQuestionSummary(deliveries),
    cost: input.cost ?? { additionalRoles: null, budget: null, prompts: queue([]), runtime: { toolDisclosureMode: 'UNKNOWN', observerAvailable: null } } }
}

/**
 * 交付条目提问的最小元数据汇总。
 *
 * 只做计数与事实陈述：不声称主管已读取、不生成待办、不改变任何任务状态。
 * 接收主管已退任、换 session 或领地改绑时，问题保持可见但计入不可达，绝不改投继任者。
 */
function deliveryQuestionSummary(deliveries: WorkbenchDeliveryItem[]): PersonalWorkbenchData['deliveryQuestions'] {
  const states = deliveries.flatMap(delivery => [...(delivery.summaryQuestions ? [delivery.summaryQuestions] : []), ...delivery.deliveryQuestions])
  const totalQuestions = states.reduce((total, state) => total + state.totalCount, 0)
  // `pendingCount` 已排除历史版：旧版未答问题只留历史，既不冒充当前待办，
  // 也不被算成「当前可回复但不可达」。
  const pendingQuestions = states.reduce((total, state) => total + state.pendingCount, 0)
  const answeredQuestions = states.reduce((total, state) => total + state.answeredCount, 0)
  const unreachableQuestions = states.filter(state => state.latestReplyState !== null && state.latestReplyState !== 'REPLY_ACCESSIBLE'
    && state.latestItemVersion === 'CURRENT')
    .reduce((total, state) => total + state.pendingCount, 0)
  const historicalQuestions = states.reduce((total, state) => total + state.historyCount, 0)
  return { totalQuestions, pendingQuestions, answeredQuestions, unreachableQuestions, historicalQuestions,
    note: totalQuestions
      ? `条目提问只记录对话事实。未回复的问题在主管实际读取前只显示「待领取」：这不表示已通知或已阅读，也不代表知悉、人类验收、Task DONE 或发布授权。${historicalQuestions ? `其中 ${historicalQuestions} 条属于旧内容版本，仅留历史，不计当前待办。` : ''}问答正文只经有效人类管理窗口或当前责任主管的 session-bound Agent Tool 读取。`
      : '当前没有条目提问记录。该汇总不含正文，也不构成待办或通知。' }
}
