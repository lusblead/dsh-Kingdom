import { createHash, randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import type { EventRow, KingdomStore, RoleBindingRow, TerritoryRow } from './db.js'
import { bindRole, rebindSession, setExecutionProfile, type AdminAuth, type ExecutionProfileV1 } from './binding.js'
import { createTerritory, setTerritorySupervisor, updateTerritory } from './territory.js'
import { setCapabilityCeiling } from '../capability/admin.js'
import {
  isOwnerControlCapability, issueOwnerOperationCapability, revokeOwnerOperationCapability,
  ownerEventPayload, ownerInputHash, type OwnerControlCapability, type OwnerEventSource,
} from './owner-control.js'
import { initializeKingdomFacts } from './kingdom.js'
import { normalizeBudgetPolicyParameters, readBudgetPolicy, setBudgetPolicy, type BudgetPolicyParameters } from './budget.js'
import { adoptCollaborationPlan, listCollaborationPlans, readCollaborationPlan, normalizePlanAdoptionParameters, type PlanAdoptionParameters, type CollaborationPlanView } from './collaboration.js'
import {
  DELIVERY_ACK_EVENT_TYPE,
  CHANGE_EVIDENCE_LABEL,
  DELIVERY_QUESTION_NOTE,
  DELIVERY_QUESTION_EVENT_TYPE,
  DELIVERY_QUESTION_TEXT_LIMIT,
  DELIVERY_REPLY_STATES,
  boundedQuestionText,
  classifyAcceptedDelivery,
  deliveryAcknowledgementView,
  deliveryChangeItemId,
  deliveryIdFor,
  deliveryQuestionEventId,
  deliveryQuestionThreadForItem,
  deliveryReviewerBindingId,
  deriveDeliveryItems,
  listDeliveryQuestionHistory,
  readDeliveryAcknowledgements,
  readDeliveryItemVersion,
  readDeliveryQuestionThread,
  readLatestReviewEvent,
  recordDeliveryAcknowledgement,
  recordDeliveryQuestion,
  redactDeliveryText,
  type DeliveryAcceptanceEvidenceKind,
  type DeliveryChangeEvidenceInput,
  type DeliveryItemQuestionThread,
  type DeliveryItemVersionState,
  type DeliveryReplyState,
} from './delivery-ack.js'
import {
  readAcceptedChangeEvidence,
  readChangeEntry,
  resolveChangeEvidenceForDelivery,
  type DeliveryChangeEvidenceRef,
} from './delivery-change.js'

export const OWNER_MUTATION_ACTIONS = ['init', 'territory.create', 'territory.update', 'territory.supervisor', 'role.bind', 'role.session', 'ceiling', 'execution-profile', 'budget.policy', 'plan.adopt', 'delivery.item.ack', 'delivery.item.question'] as const
export type OwnerMutationAction = typeof OWNER_MUTATION_ACTIONS[number]
export type OwnerManagedRole = 'CHANCELLOR' | 'SUPERVISOR' | 'WORKER'
export interface OwnerDecisionScope {
  kingdomWide: boolean
  territoryIds: string[]
  bindingIds: string[]
  roleTypes: OwnerManagedRole[]
  targetSessionIds: string[]
  workspaceRoots: string[]
}
export interface OwnerDecisionInput {
  kingdomId: string | null
  actions: OwnerMutationAction[]
  scope: OwnerDecisionScope
  ttlMs: number
}
declare const OWNER_DECISION_HANDLE: unique symbol
export interface OwnerDecisionHandle { readonly [OWNER_DECISION_HANDLE]: true }
export interface OwnerDecisionView {
  decisionId: string
  kingdomId: string | null
  ownerId: string | null
  actions: OwnerMutationAction[]
  scope: OwnerDecisionScope
  createdAt: string
  expiresAt: string
  state: 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'CONSUMED'
}
export interface OwnerValidationFailure { ok: false; code: string; message: string }
export type OwnerValidationResult = { ok: true } | OwnerValidationFailure
export interface OwnerSessionValidationInput {
  kingdomId: string
  roleType: 'CHANCELLOR' | 'SUPERVISOR'
  bindingId: string | null
  sessionId: string
  signal: AbortSignal
}
export interface OwnerProfileValidationInput {
  kingdomId: string
  bindingId: string
  roleType: OwnerManagedRole
  profile: Readonly<ExecutionProfileV1> | null
  signal: AbortSignal
}
export interface OwnerRuntimeSessionChoice { id: string; label: string }
/** 交付清单条目：只有已被主管 ACCEPT 确认的交付才会出现。 */
export interface OwnerDeliveryItemChoice {
  taskId: string
  taskTitle: string
  deliveryId: string
  attemptNo: number
  resultId: string
  itemId: string
  contentHash: string
  layer: string
  label: string
  detail: string
  changeKind: string
  changeNote: string
  acknowledgementState: 'ACKNOWLEDGED' | 'PENDING' | 'PENDING_REVISION'
  acknowledgedAt: string | null
  /**
   * 本次确认交付实际依据的接受证据强度。`LEGACY_ATTEMPT_ONLY` 时
   * `acceptanceEvidenceNote` 必须原样展示给 Owner（历史接受证据较弱），
   * 且不得把它当作 exact result-bound。
   */
  acceptanceEvidenceKind: DeliveryAcceptanceEvidenceKind
  acceptanceEvidenceExact: boolean
  acceptanceEvidenceNote: string | null
  /**
   * 该条目已有的 Owner 提问元数据（不含正文）。正文只经
   * {@link OwnerDecisionController.readDeliveryQuestions} 在有效窗口内按精确条目返回。
   */
  questions: OwnerDeliveryItemQuestions | null
}

/** 条目提问的**元数据**：不含问题或回复正文。 */
export interface OwnerDeliveryItemQuestions {
  threadId: string
  totalCount: number
  /** 主管尚未回复的问题数；未被实际读取前只算「待领取」。 */
  pendingCount: number
  answeredCount: number
  /** 属于旧内容版本、仅留历史的问题数。 */
  historyCount: number
  lastAskedAt: string | null
  lastRepliedAt: string | null
  /** 最近一条问题的接收主管是否仍可回复；不可达时界面必须照实说明。 */
  latestReplyState: DeliveryReplyState | null
}

/**
 * Owner 只读问答历史入口的一条精确条目（不含问题或回复正文）。
 *
 * 与 `deliveryItems` 分开：它只来自既有提问事实，因此包含已经离开当前交付目录、
 * 目前无法重验的旧问答。它只供只读回看，**绝不**作为新提问目标；新提问仍须落在
 * 当前已确认交付目录内并逐条精确重验。
 */
export interface OwnerDeliveryQuestionHistoryChoice {
  taskId: string
  taskTitle: string
  itemId: string
  itemLabel: string
  lastAskedAt: string
  questionCount: number
  /** 已验证当前版本且尚无回复的条数；历史版与无法重验的都不计入。 */
  pendingCount: number
  answeredCount: number
  historyCount: number
  unverifiableCount: number
  latestItemVersion: DeliveryItemVersionState
  currentContentHash: string | null
}

/**
 * Owner 只读的条目问答线程。
 *
 * 与「查看改动」同款边界：只经有效 Owner 窗口、精确条目引用与本次动作授权返回，
 * **读取不写任何事实**、不自动知悉、也不替主管回复。
 */
export interface OwnerDeliveryQuestionEntry {
  questionId: string
  questionText: string
  askedAt: string
  ownerId: string
  /** 接受该交付的主管 binding；首版唯一合法接收者。 */
  reviewerBindingId: string
  replyState: DeliveryReplyState
  replyStateNote: string
  /**
   * 该问题相对当前交付目录的版本关系：已验证当前、可确认的旧版本，或无法重验。
   * 后两者仍可读、仍保留原文与回复，但**不计当前待办**，界面也不得据此声称
   * 「当前可回复」。
   */
  itemVersion: DeliveryItemVersionState
  /** 当前读取时该条目重新派生出的内容版本；无法派生时为 null。 */
  currentItemContentHash: string | null
  reply: { replyText: string; repliedAt: string; responderBindingId: string } | null
}

export interface OwnerDeliveryQuestionView {
  deliveryId: string
  taskId: string
  taskTitle: string
  itemId: string
  itemLabel: string
  /** 本次读取时该条目的当前内容版本；无法在当前交付目录中重验时为 null。 */
  contentHash: string | null
  questions: OwnerDeliveryQuestionEntry[]
  answeredCount: number
  /** 已验证当前版本且尚无回复的条数；历史版与无法重验的未答问题都不计入。 */
  pendingCount: number
  historyCount: number
  /** 当前交付目录无法重验该条目版本、因此不声称任何版本关系的条数。 */
  unverifiableCount: number
  note: string
}

/**
 * Owner 只读的已确认改动详情。
 *
 * 这是「主管确认的改动证据」的可读视图：只经有效 Owner 窗口、精确
 * task/evidence/entry id 与 scope 返回，**查看不写入任何事实**，也不自动知悉。
 */
export interface OwnerDeliveryChangeView {
  kind: 'SUPERVISOR_CONFIRMED_BOUNDED_WINDOW'
  label: string
  evidenceId: string
  entryId: string
  taskId: string
  taskTitle: string
  attemptNo: number
  status: string
  repoPath: string
  revision: string
  repoVcs: string
  repoHead: string | null
  coverageComplete: boolean
  coverageReasons: string[]
  labels: string[]
  note: string
  hunks: { kind: string; beforeLine: number | null; afterLine: number | null; text: string }[]
}
export interface OwnerDecisionControllerOptions {
  now?: () => number
  validationTimeoutMs?: number
  validateTargetSession: (input: OwnerSessionValidationInput) => Promise<OwnerValidationResult>
  validateExecutionProfile: (input: OwnerProfileValidationInput) => Promise<OwnerValidationResult>
  listTargetSessions: (input: { sessionIds: readonly string[]; signal: AbortSignal }) => Promise<readonly OwnerRuntimeSessionChoice[]>
}
export interface OwnerOperationCatalog {
  plans?: CollaborationPlanView[]
  territories: { id: string; name: string }[]
  bindings: { id: string; roleType: string; roleName: string }[]
  runtimeSessions: OwnerRuntimeSessionChoice[]
  workspaceRoots: string[]
  /**
   * 本次授权范围内的已确认交付条目；逐条知悉与逐条提问共用同一份目录。
   * 只要窗口授权了其中任一动作就返回；读取权限仍由各自动作单独把关。
   */
  deliveryItems?: OwnerDeliveryItemChoice[]
  /**
   * 本次授权范围内**已有提问记录**的精确条目只读入口（含已离开当前目录的旧问答）。
   * 只在窗口授权 `delivery.item.question` 时返回，供只读回看；不是新提问目标来源。
   */
  deliveryQuestionHistory?: OwnerDeliveryQuestionHistoryChoice[]
}
export type OwnerOperationInput =
  | { action: 'init'; parameters: { kingdom_name: string; owner_name: string } }
  | { action: 'territory.create'; parameters: { name: string; workspace_path: string; summary?: string | null } }
  | { action: 'territory.update'; parameters: { territory_id: string; name?: string; summary?: string | null } }
  | { action: 'territory.supervisor'; parameters: { territory_id: string; supervisor_binding_id: string } }
  | { action: 'role.bind'; parameters: { role_type: OwnerManagedRole; role_name: string; session_id?: string | null } }
  | { action: 'role.session'; parameters: { binding_id: string; session_id: string } }
  | { action: 'ceiling'; parameters: { ceiling: Record<string, boolean> } }
  | { action: 'execution-profile'; parameters: { binding_id: string; profile: ExecutionProfileV1 | null } }
  | { action: 'budget.policy'; parameters: BudgetPolicyParameters }
  | { action: 'plan.adopt'; parameters: PlanAdoptionParameters }
  | { action: 'delivery.item.ack'; parameters: { task_id: string; delivery_id: string; item_id: string; content_hash: string; attempt_no: number; result_id: string } }
  | { action: 'delivery.item.question'; parameters: { task_id: string; delivery_id: string; item_id: string; content_hash: string; attempt_no: number; result_id: string; question_text: string } }
export interface OwnerOperationPreview {
  prepareId: string
  operationId: string
  decisionId: string
  action: OwnerMutationAction
  summary: string
  changes: { label: string; before: string | null; after: string | null }[]
  affected: { territoryIds: string[]; bindingIds: string[] }
  createdAt: string
  expiresAt: string
}
export interface OwnerOperationReceipt {
  type: 'KingdomOwnerOperationReceipt/v1'
  operationId: string
  prepareId: string
  decisionId: string
  kingdomId: string
  ownerId: string
  action: OwnerMutationAction
  inputHash: string
  status: 'APPLIED'
  target: { type: 'kingdom' | 'territory' | 'binding' | 'collaboration-plan' | 'delivery'; id: string }
  receiptSeq: number
  appliedAt: string
  message: string
}
export class OwnerOperationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'OwnerOperationError' }
}

// Controller implementation follows the shared interfaces above. Only Core owns
// decision/preparation objects; transport receives an opaque handle and public views.

interface DecisionRecord {
  view: OwnerDecisionView
  authority: OwnerControlCapability
  abort: AbortController
  timer: ReturnType<typeof setTimeout>
  preparations: Map<string, Preparation>
}
interface Preparation {
  input: OwnerOperationInput
  inputHash: string
  fingerprint: string
  preview: OwnerOperationPreview
  receipt?: OwnerOperationReceipt
  committing?: Promise<OwnerOperationReceipt>
}
interface OperationContext {
  territoryIds: string[]
  bindingIds: string[]
  sessionIds: string[]
  fingerprint: string
  before: string | null
  after: string | null
  summary: string
}
const MANAGED_ROLES: readonly string[] = ['CHANCELLOR', 'SUPERVISOR', 'WORKER']
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** 条目提问元数据：只计数与时间，不含任何正文。 */
function ownerDeliveryItemQuestions(thread: DeliveryItemQuestionThread): OwnerDeliveryItemQuestions {
  const replied = thread.questions.filter(question => question.reply !== null)
  const asked = thread.questions.map(question => question.askedAt).sort()
  const answered = replied.map(question => question.reply!.repliedAt).sort()
  return {
    threadId: thread.deliveryId + ':' + thread.itemId,
    totalCount: thread.questions.length,
    pendingCount: thread.pendingCount,
    answeredCount: thread.answeredCount,
    historyCount: thread.historyCount,
    lastAskedAt: asked.length ? asked[asked.length - 1]! : null,
    lastRepliedAt: answered.length ? answered[answered.length - 1]! : null,
    latestReplyState: thread.questions.length ? thread.questions[thread.questions.length - 1]!.replyState : null,
  }
}

/** 固定的可达性说明；界面与报告共用，避免两处措辞漂移。 */
function classifyReplyStateNote(state: DeliveryReplyState): string {
  // `DELIVERY_REPLY_STATES` 是唯一状态清单：新增状态而忘记补说明时这里立刻失败，
  // 而不是静默回退成一句含糊的通用文案。
  if (!DELIVERY_REPLY_STATES.includes(state)) fail('DELIVERY_QUESTION_STATE_UNKNOWN', '未知的回复可达性状态。')
  const notes: Record<DeliveryReplyState, string> = {
    REPLY_ACCESSIBLE: '该问题仍由接受交付的主管负责：它仍是领地当前主理并持有 ACTIVE session，可读取并回复。',
    REVIEWER_BINDING_MISSING: '接受该交付时记录的主管绑定已不存在或不再是主管，本条不可达；不会改投继任主管。',
    REVIEWER_BINDING_RETIRED: '接受该交付的主管已退任，本条不可达；不会改投继任主管。',
    REVIEWER_SESSION_CHANGED: '该主管当前没有可用的 ACTIVE session，本条暂时不可达。',
    SUPERVISOR_REBOUND: '该领地已改由其他主管主理，本条仍归原接受主管，不可达；不会自动改投继任者。',
  }
  return notes[state]
}

function fail(code: string, message: string): never { throw new OwnerOperationError(code, message) }
function object(value: unknown, allowed: readonly string[], required: readonly string[] = allowed): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.getOwnPropertySymbols(value).length > 0) fail('INVALID_INPUT', '输入必须是普通 JSON 对象。')
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(result, key))) {
    fail('INVALID_INPUT', '输入存在未知字段或缺少必填字段。')
  }
  return result
}
function string(value: unknown, label: string, limit = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('INVALID_INPUT', `${label}必须是非空、长度受限的文本。`)
  }
  return value.trim()
}
function textOrNull(value: unknown, label: string): string | null {
  return value === null || value === '' ? null : string(value, label, 2000)
}
function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 200) fail('INVALID_INPUT', `${label}必须是至多 200 项的列表。`)
  return [...new Set(value.map(item => string(item, label)))].sort()
}
function directory(value: unknown): string {
  const path = string(value, '目录', 4096)
  if (!isAbsolute(path) || /^[\\/]{2}/u.test(path)) fail('INVALID_PATH', '目录必须是本机绝对路径，不能是网络共享。')
  try {
    const result = realpathSync.native(path)
    if (/^[\\/]{2}/u.test(result) || !statSync(result).isDirectory()) fail('INVALID_PATH', '目录必须是现存本机目录。')
    return result
  } catch (error) {
    if (error instanceof OwnerOperationError) throw error
    fail('INVALID_PATH', '目录不存在或无法解析。')
  }
}
function within(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}
function normalizeInput(raw: OwnerOperationInput): OwnerOperationInput {
  const outer = object(raw, ['action', 'parameters'])
  switch (outer.action) {
    case 'plan.adopt': return { action: 'plan.adopt', parameters: normalizePlanAdoptionParameters(outer.parameters) }
    case 'budget.policy': return { action: 'budget.policy', parameters: normalizeBudgetPolicyParameters(outer.parameters) }
    case 'init': {
      const p = object(outer.parameters, ['kingdom_name', 'owner_name'])
      return { action: 'init', parameters: { kingdom_name: string(p.kingdom_name, '王国名称', 120), owner_name: string(p.owner_name, 'Owner 名称', 120) } }
    }
    case 'territory.create': {
      const p = object(outer.parameters, ['name', 'workspace_path', 'summary'], ['name', 'workspace_path'])
      return { action: 'territory.create', parameters: { name: string(p.name, '领地名称', 120), workspace_path: directory(p.workspace_path), summary: p.summary === undefined ? null : textOrNull(p.summary, '领地说明') } }
    }
    case 'territory.update': {
      const p = object(outer.parameters, ['territory_id', 'name', 'summary'], ['territory_id'])
      if (!Object.hasOwn(p, 'name') && !Object.hasOwn(p, 'summary')) fail('INVALID_INPUT', '至少提供名称或说明。')
      return { action: 'territory.update', parameters: { territory_id: string(p.territory_id, '领地 ID'),
        ...(Object.hasOwn(p, 'name') ? { name: string(p.name, '领地名称', 120) } : {}),
        ...(Object.hasOwn(p, 'summary') ? { summary: textOrNull(p.summary, '领地说明') } : {}) } }
    }
    case 'territory.supervisor': {
      const p = object(outer.parameters, ['territory_id', 'supervisor_binding_id'])
      return { action: 'territory.supervisor', parameters: { territory_id: string(p.territory_id, '领地 ID'), supervisor_binding_id: string(p.supervisor_binding_id, '主管绑定 ID') } }
    }
    case 'role.bind': {
      const p = object(outer.parameters, ['role_type', 'role_name', 'session_id'], ['role_type', 'role_name'])
      if (!MANAGED_ROLES.includes(p.role_type as string)) fail('INVALID_ROLE', '仅支持宰相、主管和执行者。')
      const session = p.session_id === undefined || p.session_id === null ? null : string(p.session_id, 'Session ID')
      if (p.role_type === 'WORKER' && session !== null) fail('WORKER_SESSION_UNSUPPORTED', '执行者 Session 由正常 governed 执行路径建立。')
      if (p.role_type !== 'WORKER' && session === null) fail('TARGET_SESSION_REQUIRED', '主管和宰相必须选择已有真实 Session。')
      return { action: 'role.bind', parameters: { role_type: p.role_type as OwnerManagedRole, role_name: string(p.role_name, '角色名称', 120), session_id: session } }
    }
    case 'role.session': {
      const p = object(outer.parameters, ['binding_id', 'session_id'])
      return { action: 'role.session', parameters: { binding_id: string(p.binding_id, '绑定 ID'), session_id: string(p.session_id, 'Session ID') } }
    }
    case 'ceiling': {
      const p = object(outer.parameters, ['ceiling'])
      const ceiling = object(p.ceiling, p.ceiling && typeof p.ceiling === 'object' ? Object.keys(p.ceiling) : [])
      if (Object.keys(ceiling).length > 256) fail('INVALID_INPUT', '权限上限项过多。')
      const entries = Object.entries(ceiling).map(([key, value]) => {
        if (typeof value !== 'boolean' || string(key, '能力名称', 160) !== key) fail('INVALID_INPUT', '能力名必须规范、取值必须是布尔值。')
        return [key, value] as const
      }).sort(([a], [b]) => a.localeCompare(b))
      return { action: 'ceiling', parameters: { ceiling: Object.fromEntries(entries) } }
    }
    case 'execution-profile': {
      const p = object(outer.parameters, ['binding_id', 'profile'])
      let profile: ExecutionProfileV1 | null = null
      if (p.profile !== null) {
        const config = object(p.profile, ['provider', 'model'], [])
        if (!Object.keys(config).length) fail('INVALID_INPUT', '执行配置不能为空对象；清空请使用 null。')
        profile = { ...(Object.hasOwn(config, 'provider') ? { provider: string(config.provider, 'Provider') } : {}),
          ...(Object.hasOwn(config, 'model') ? { model: string(config.model, 'Model') } : {}) }
      }
      return { action: 'execution-profile', parameters: { binding_id: string(p.binding_id, '绑定 ID'), profile } }
    }
    case 'delivery.item.ack': {
      const p = object(outer.parameters, ['task_id', 'delivery_id', 'item_id', 'content_hash', 'attempt_no', 'result_id'])
      const attemptNo = p.attempt_no
      if (!Number.isSafeInteger(attemptNo) || (attemptNo as number) < 1 || (attemptNo as number) > 1_000_000) {
        fail('INVALID_INPUT', '交付尝试次数必须是正整数。')
      }
      const contentHash = string(p.content_hash, '条目内容版本', 128)
      if (!/^[0-9a-f]{64}$/u.test(contentHash)) fail('INVALID_INPUT', '条目内容版本必须是小写十六进制摘要。')
      return { action: 'delivery.item.ack', parameters: {
        task_id: string(p.task_id, '任务 ID'), delivery_id: string(p.delivery_id, '交付 ID'),
        item_id: string(p.item_id, '条目 ID'), content_hash: contentHash,
        attempt_no: attemptNo as number, result_id: string(p.result_id, '结果 ID') } }
    }
    case 'delivery.item.question': {
      const p = object(outer.parameters, ['task_id', 'delivery_id', 'item_id', 'content_hash', 'attempt_no', 'result_id', 'question_text'])
      const attemptNo = p.attempt_no
      if (!Number.isSafeInteger(attemptNo) || (attemptNo as number) < 1 || (attemptNo as number) > 1_000_000) {
        fail('INVALID_INPUT', '交付尝试次数必须是正整数。')
      }
      const contentHash = string(p.content_hash, '条目内容版本', 128)
      if (!/^[0-9a-f]{64}$/u.test(contentHash)) fail('INVALID_INPUT', '条目内容版本必须是小写十六进制摘要。')
      // 与知悉同款的「非空、长度受限」文本校验；正文随后在 Core 里统一脱敏并限长，
      // 因此事实里永远不保存未脱敏正文。
      const questionText = string(p.question_text, '问题内容', DELIVERY_QUESTION_TEXT_LIMIT)
      return { action: 'delivery.item.question', parameters: {
        task_id: string(p.task_id, '任务 ID'), delivery_id: string(p.delivery_id, '交付 ID'),
        item_id: string(p.item_id, '条目 ID'), content_hash: contentHash,
        attempt_no: attemptNo as number, result_id: string(p.result_id, '结果 ID'), question_text: questionText } }
    }
    default: return fail('INVALID_ACTION', '不支持该管理动作。')
  }
}
/** Trusted-local decision registry. Public IDs and JSON views never confer authority. */
export class OwnerDecisionController {
  private readonly decisions = new Map<OwnerDecisionHandle, DecisionRecord>()
  private readonly now: () => number
  private readonly timeout: number
  private disposed = false

  constructor(private readonly store: KingdomStore, private readonly options: OwnerDecisionControllerOptions) {
    this.now = options.now ?? Date.now
    this.timeout = Math.min(30000, Math.max(1, options.validationTimeoutMs ?? 10000))
  }

  activate(capability: OwnerControlCapability, input: OwnerDecisionInput): { handle: OwnerDecisionHandle; decision: OwnerDecisionView } {
    if (this.disposed) fail('CONTROLLER_DISPOSED', '管理控制器已卸载。')
    if (!isOwnerControlCapability(capability)) fail('OWNER_CONTROL_REQUIRED', '只有可信直接入口能激活管理窗口。')
    const p = object(input, ['kingdomId', 'actions', 'scope', 'ttlMs'])
    const kingdomId = p.kingdomId === null ? null : string(p.kingdomId, '王国 ID')
    const actions = stringList(p.actions, '动作') as OwnerMutationAction[]
    if (!actions.length || actions.some(action => !OWNER_MUTATION_ACTIONS.includes(action))) fail('INVALID_ACTION', '管理动作集为空或不支持。')
    if (!Number.isSafeInteger(p.ttlMs) || (p.ttlMs as number) < 1 || (p.ttlMs as number) > 600000) fail('INVALID_TTL', '窗口有效期必须在 1 到 600000 毫秒内。')
    const s = object(p.scope, ['kingdomWide', 'territoryIds', 'bindingIds', 'roleTypes', 'targetSessionIds', 'workspaceRoots'])
    if (typeof s.kingdomWide !== 'boolean') fail('INVALID_INPUT', 'kingdomWide 必须是布尔值。')
    const scope: OwnerDecisionScope = { kingdomWide: s.kingdomWide,
      territoryIds: stringList(s.territoryIds, '领地 ID'), bindingIds: stringList(s.bindingIds, '绑定 ID'),
      roleTypes: stringList(s.roleTypes, '角色') as OwnerManagedRole[], targetSessionIds: stringList(s.targetSessionIds, 'Session ID'),
      workspaceRoots: stringList(s.workspaceRoots, '目录').map(directory) }
    if (scope.roleTypes.some(role => !MANAGED_ROLES.includes(role))) fail('INVALID_ROLE', '授权角色类型不受支持。')
    const kingdom = this.store.getDefaultKingdom()
    if (kingdomId === null) {
      if (kingdom || actions.length !== 1 || actions[0] !== 'init') fail('BOOTSTRAP_ONLY', '空库窗口只能初始化一次。')
      if (scope.kingdomWide || scope.territoryIds.length || scope.bindingIds.length || scope.roleTypes.length || scope.targetSessionIds.length || scope.workspaceRoots.length) {
        fail('BOOTSTRAP_ONLY', '初始化窗口不能携带后续管理范围。')
      }
    } else {
      if (!kingdom || kingdom.kingdom_id !== kingdomId || actions.includes('init')) fail('KINGDOM_MISMATCH', '王国不存在、已更换或不支持重复初始化。')
      for (const id of scope.territoryIds) {
        const row = this.store.getTerritoryById(id)
        if (!row || row.kingdom_id !== kingdomId || row.status === 'DELETED') fail('SCOPE_DENIED', '授权领地不存在或属于其他王国。')
      }
      for (const id of scope.bindingIds) {
        const row = this.store.getBindingById(id)
        if (!row || row.kingdom_id !== kingdomId || row.status !== 'ACTIVE' || !scope.roleTypes.includes(row.role_type as OwnerManagedRole)) {
          fail('SCOPE_DENIED', '授权绑定不存在、已退任或角色不在范围内。')
        }
      }
      if ((actions.includes('ceiling') || actions.includes('budget.policy')) && !scope.kingdomWide) fail('SCOPE_DENIED', '权限上限与预算政策必须取得王国级授权。')
    }
    const created = this.now()
    const view: OwnerDecisionView = { decisionId: randomUUID(), kingdomId, ownerId: kingdom?.owner_id ?? null,
      actions, scope, createdAt: new Date(created).toISOString(), expiresAt: new Date(created + (p.ttlMs as number)).toISOString(), state: 'ACTIVE' }
    // Persist activation before invalidating the previous usable window. A failed write cannot create authority.
    if (kingdom) this.event(kingdom.kingdom_id, kingdom.owner_id, 'OWNER_DECISION_CREATED', view.decisionId,
      { decision: view, source_channel: 'LOCAL_DIRECT_SLASH', authorization_source: 'LOCAL_DIRECT_SLASH' })
    for (const previous of this.decisions.values()) this.invalidate(previous, 'REVOKED')
    const handle = Object.freeze({}) as OwnerDecisionHandle
    const record: DecisionRecord = { view, authority: capability, abort: new AbortController(),
      timer: setTimeout(() => this.invalidate(record, 'EXPIRED'), p.ttlMs as number), preparations: new Map() }
    record.timer.unref?.()
    this.decisions.set(handle, record)
    return { handle, decision: clone(view) }
  }

  inspect(handle: OwnerDecisionHandle): OwnerDecisionView | null {
    const record = this.decisions.get(handle)
    if (!record) return null
    this.expire(record)
    return clone(record.view)
  }

  async catalog(handle: OwnerDecisionHandle): Promise<OwnerOperationCatalog> {
    const record = this.active(handle)
    const s = record.view.scope
    const sessions = await this.observe(record, undefined, signal => this.options.listTargetSessions({ sessionIds: [...s.targetSessionIds], signal }))
    this.active(handle)
    const kingdomId = record.view.kingdomId
    const bindings = kingdomId ? this.store.listBindings(kingdomId).filter(b => b.status === 'ACTIVE'
      && s.bindingIds.includes(b.binding_id) && s.roleTypes.includes(b.role_type as OwnerManagedRole)) : []
    return { territories: kingdomId ? this.store.listTerritories(kingdomId).filter(t => s.territoryIds.includes(t.territory_id))
      .map(t => ({ id: t.territory_id, name: t.name })) : [],
      bindings: bindings.map(b => ({ id: b.binding_id, roleType: b.role_type, roleName: b.role_name })),
      runtimeSessions: [...new Map(sessions.filter(item => s.targetSessionIds.includes(item.id))
        .map(item => [item.id, { id: item.id, label: string(item.label, 'Session 名称', 512) }])).values()],
      workspaceRoots: [...s.workspaceRoots],
      plans: kingdomId && record.view.actions.includes('plan.adopt') ? listCollaborationPlans(this.store, kingdomId).filter(plan => {
        try { this.context(record, { action: 'plan.adopt', parameters: { plan_id: plan.planId, version: plan.version, digest: plan.digest } }, randomUUID()); return true }
        catch { return false }
      }) : [],
      deliveryItems: kingdomId && (record.view.actions.includes('delivery.item.ack') || record.view.actions.includes('delivery.item.question'))
        ? this.deliveryItems(record) : [],
      deliveryQuestionHistory: kingdomId && record.view.actions.includes('delivery.item.question')
        ? this.deliveryQuestionHistory(record) : [] }
  }

  /**
   * 本次授权范围内的**已有提问记录**条目（只读历史入口）。
   *
   * 只读且不依赖有界交付目录：它按权威提问事实列出精确 task/item，再逐条用
   * `deliveryScopeAllows` 过滤，因此不含跨领地条目；不在当前目录、当前无法重验的
   * 旧问答也能在这里被发现。它不返回任何正文，也**不**进入新提问 prepare 的来源目录。
   */
  private deliveryQuestionHistory(record: DecisionRecord): OwnerDeliveryQuestionHistoryChoice[] {
    const kingdomId = record.view.kingdomId
    if (!kingdomId) return []
    const choices: OwnerDeliveryQuestionHistoryChoice[] = []
    for (const target of listDeliveryQuestionHistory(this.store, kingdomId)) {
      const task = this.store.getTask(target.taskId)
      if (!task) continue
      const territory = this.store.getTerritoryById(task.territory_id)
      if (!territory || territory.kingdom_id !== kingdomId || territory.status === 'DELETED') continue
      if (!this.deliveryScopeAllows(record, territory)) continue
      choices.push({ taskId: target.taskId, taskTitle: redactDeliveryText(task.title), itemId: target.itemId,
        itemLabel: target.itemLabel, lastAskedAt: target.lastAskedAt, questionCount: target.questionCount,
        pendingCount: target.pendingCount, answeredCount: target.answeredCount, historyCount: target.historyCount,
        unverifiableCount: target.unverifiableCount, latestItemVersion: target.latestItemVersion,
        currentContentHash: target.currentContentHash })
    }
    return choices
  }

  /**
   * 交付知悉的授权范围判据。
   *
   * catalog 与 prepare/commit 必须共用同一判据：否则会出现「清单可见、
   * 提交被拒」或「清单不可见、提交却可行」。`kingdomWide` 是 Owner 的最高
   * 授权级别；其余情况要求任务所在领地在 `territoryIds` 内，或该领地由
   * 授权 `bindingIds` 中的主管主理且本次授权声明了 SUPERVISOR 角色。
   */
  private deliveryScopeAllows(record: DecisionRecord, territory: TerritoryRow): boolean {
    const scope = record.view.scope
    if (scope.kingdomWide) return true
    if (!scope.territoryIds.length && !scope.bindingIds.length && !scope.roleTypes.length) return false
    if (scope.territoryIds.includes(territory.territory_id)) return true
    return scope.roleTypes.includes('SUPERVISOR')
      && !!territory.supervisor_binding_id
      && scope.bindingIds.includes(territory.supervisor_binding_id)
  }

  /**
   * 本次授权范围内的已确认交付条目。只有同一 Task/attempt 主管 ACCEPT 的交付才出现，
   * Worker Claim 永远不会进入该清单。
   */
  private deliveryItems(record: DecisionRecord): OwnerDeliveryItemChoice[] {
    const kingdomId = record.view.kingdomId
    if (!kingdomId) return []
    const ownerId = record.view.ownerId ?? ''
    const items: OwnerDeliveryItemChoice[] = []
    /**
     * 与工作台「最近交付」对齐：按交付最近更新/被接受的时间排序。
     *
     * 主管 ACCEPT 会经 `transitionTask` 更新 `tasks.updated_at`，因此「旧建但最近
     * 接受的交付」会排到工作台顶部；若这里仍按 `created_at` 截断，那条交付就会
     * 在工作台可见、却在 Owner 目录之外，既无法知悉也无法看差异。只改排序键，
     * 不新增第二套任务索引，也不改变条目上限语义。
     */
    const tasks = [...this.store.listTasks(kingdomId)].sort((a, b) =>
      b.updated_at.localeCompare(a.updated_at) || b.task_id.localeCompare(a.task_id))
    for (const task of tasks) {
      if (items.length >= 200) break
      if (task.status !== 'DONE') continue
      const territory = this.store.getTerritoryById(task.territory_id)
      if (!territory || territory.kingdom_id !== kingdomId || territory.status === 'DELETED') continue
      if (!this.deliveryScopeAllows(record, territory)) continue
      const claim = this.store.latestWorkerResult(task.task_id)
      if (!claim) continue
      const review = readLatestReviewEvent(this.store, kingdomId, task.task_id)
      const classification = classifyAcceptedDelivery(this.store, claim, review)
      if (!classification) continue
      const deliveryId = deliveryIdFor(task.task_id)
      const acknowledgements = readDeliveryAcknowledgements(this.store, kingdomId, deliveryId)
      const questions = readDeliveryQuestionThread(this.store, kingdomId, deliveryId)
      for (const item of deriveDeliveryItems(task.task_id, claim, this.changeEvidenceFor(kingdomId, task.task_id))) {
        const view = deliveryAcknowledgementView(acknowledgements, item, ownerId)
        const thread = deliveryQuestionThreadForItem(questions, item.itemId, item.contentHash)
        items.push({
          taskId: task.task_id,
          taskTitle: redactDeliveryText(task.title),
          deliveryId,
          attemptNo: claim.attempt_no,
          resultId: claim.result_id,
          itemId: item.itemId,
          contentHash: item.contentHash,
          layer: item.content.layer,
          label: item.content.label,
          detail: item.content.detail,
          changeKind: item.content.change.kind,
          changeNote: item.content.change.note,
          acknowledgementState: view.state,
          acknowledgedAt: view.acknowledgedAt,
          acceptanceEvidenceKind: classification.kind,
          acceptanceEvidenceExact: classification.evidence.exactResultBound,
          acceptanceEvidenceNote: classification.legacyNote,
          questions: thread ? ownerDeliveryItemQuestions(thread) : null,
        })
      }
    }
    return items
  }

  /**
   * 只读返回一条已确认交付条目的完整问答线程。
   *
   * 有效性要求与 `readDeliveryChange` 同款：窗口 ACTIVE、本次授权包含
   * `delivery.item.question`、任务在授权范围内、该 task 确实存在写给它的问题记录。
   * 版本关系按该精确 task/item **独立重验**（不受有界展示目录截断影响）：命中当前
   * 派生版本即已验证当前版，命中的是旧版本即历史版；条目已无法从当前 ACCEPT/证据
   * 重验（例如 CHANGE 证据丢失）时仍可按精确 itemId 读回，但整条标为无法重验，
   * 不冒充当前版、也不可回复。任一不成立都失败，且不写任何事实、不自动知悉。
   */
  readDeliveryQuestions(handle: OwnerDecisionHandle, input: { taskId: string; itemId: string }): OwnerDeliveryQuestionView {
    const record = this.active(handle)
    const kingdomId = record.view.kingdomId
    if (!kingdomId) fail('DELIVERY_NOT_CONFIRMED', '当前窗口没有可读取交付的王国。')
    if (!record.view.actions.includes('delivery.item.question')) {
      fail('ACTION_NOT_AUTHORIZED', '本次管理窗口未授权交付条目提问动作，不能读取问答正文。')
    }
    const task = this.store.getTask(string(input.taskId, '任务 ID'))
    if (!task) fail('SCOPE_DENIED', '任务不存在或不属于当前王国。')
    const territory = this.store.getTerritoryById(task.territory_id)
    if (!territory || territory.kingdom_id !== kingdomId || territory.status === 'DELETED') fail('SCOPE_DENIED', '任务不属于当前王国。')
    if (!this.deliveryScopeAllows(record, territory)) fail('SCOPE_DENIED', '该交付不在本次授权范围内。')
    const itemId = string(input.itemId, '条目 ID')
    // 版本真值必须逐 Task/条目精确重验，**不能**取自有界展示目录：展示目录会截断
    // 较旧条目，若用它判断，真实仍是当前版的问题会被误标为无法重验。
    const currentItem = readDeliveryItemVersion(this.store, kingdomId, task.task_id, itemId)
    const thread = deliveryQuestionThreadForItem(readDeliveryQuestionThread(this.store, kingdomId, deliveryIdFor(task.task_id)),
      itemId, currentItem ? currentItem.contentHash : null)
    // 条目无法重验、也没有任何提问记录时仍是「未知条目」，不能被读成一条空线程。
    if (!thread && !currentItem) fail('DELIVERY_ITEM_UNKNOWN', '该条目已无法从当前交付重验，也没有可读取的问答记录。')
    if (!thread) fail('DELIVERY_QUESTION_UNKNOWN', '该条目当前版本还没有提问记录。')
    const review = readLatestReviewEvent(this.store, kingdomId, task.task_id)
    const reviewerBindingId = deliveryReviewerBindingId(review)
    return {
      deliveryId: thread.deliveryId,
      taskId: task.task_id,
      taskTitle: redactDeliveryText(task.title),
      itemId: thread.itemId,
      itemLabel: currentItem ? currentItem.label : thread.itemLabel,
      contentHash: currentItem ? currentItem.contentHash : null,
      questions: thread.questions.map(question => ({
        questionId: question.questionId,
        questionText: question.questionText,
        askedAt: question.askedAt,
        ownerId: question.ownerId,
        reviewerBindingId: question.reviewerBindingId,
        replyState: question.replyState,
        replyStateNote: classifyReplyStateNote(question.replyState),
        itemVersion: question.itemVersion,
        currentItemContentHash: question.currentItemContentHash,
        reply: question.reply ? { replyText: question.reply.replyText, repliedAt: question.reply.repliedAt,
          responderBindingId: question.reply.responderBindingId } : null,
      })),
      answeredCount: thread.answeredCount,
      pendingCount: thread.pendingCount,
      historyCount: thread.historyCount,
      unverifiableCount: thread.unverifiableCount,
      note: reviewerBindingId ? DELIVERY_QUESTION_NOTE
        : `${DELIVERY_QUESTION_NOTE} 另：该交付的接受事件没有记录主管绑定，无法确定接收者。`,
    }
  }

  /**
   * 已由主管在 ACCEPT 中显式选择、且本地 hash 重验通过的改动证据。
   * 缺失、漂移或未确认时返回 null：调用方显示「不可定位」，不退回执行者自述。
   */
  private changeEvidenceFor(kingdomId: string, taskId: string): DeliveryChangeEvidenceInput | null {
    const review = readLatestReviewEvent(this.store, kingdomId, taskId)
    const ref = readAcceptedChangeEvidence(review)
    return ref ? resolveChangeEvidenceForDelivery(undefined, ref) : null
  }

  private acceptedChangeRef(kingdomId: string, taskId: string): DeliveryChangeEvidenceRef | null {
    return readAcceptedChangeEvidence(readLatestReviewEvent(this.store, kingdomId, taskId))
  }

  /**
   * 只读返回一条已确认改动条目的有界详情。
   *
   * 有效性要求：窗口 ACTIVE、**本次授权动作包含 `delivery.item.ack`**、任务在本次
   * 授权范围内、该 task 确实存在一条主管 ACCEPT 绑定的改动证据、evidence id 与
   * entry id 精确匹配、该条目仍需出现在当前有效交付目录中，且本地 hash 重验通过。
   * 任一不成立都失败，且不写任何事实、不产生知悉。
   *
   * 只检查 ACTIVE + Territory scope 是不够的：同一领地的另一个管理窗口若没有该
   * 动作授权，就不能凭 id 读取差异正文。这里与 `catalog` 使用同一动作判据，
   * 不默认放行（也不新增只读动作）。
   */
  readDeliveryChange(handle: OwnerDecisionHandle, input: { taskId: string; evidenceId: string; entryId: string }): OwnerDeliveryChangeView {
    const record = this.active(handle)
    const kingdomId = record.view.kingdomId
    if (!kingdomId) fail('DELIVERY_NOT_CONFIRMED', '当前窗口没有可读取交付的王国。')
    if (!record.view.actions.includes('delivery.item.ack')) {
      fail('ACTION_NOT_AUTHORIZED', '本次管理窗口未授权交付条目知悉动作，不能读取改动证据正文。')
    }
    const task = this.store.getTask(string(input.taskId, '任务 ID'))
    if (!task) fail('SCOPE_DENIED', '任务不存在或不属于当前王国。')
    const territory = this.store.getTerritoryById(task.territory_id)
    if (!territory || territory.kingdom_id !== kingdomId || territory.status === 'DELETED') fail('SCOPE_DENIED', '任务不属于当前王国。')
    if (!this.deliveryScopeAllows(record, territory)) fail('SCOPE_DENIED', '该交付不在本次授权范围内。')
    const ref = this.acceptedChangeRef(kingdomId, task.task_id)
    const evidenceId = string(input.evidenceId, '证据 ID', 128)
    const entryId = string(input.entryId, '改动条目 ID', 128)
    if (!ref || ref.evidenceId !== evidenceId || !ref.entryIds.includes(entryId)) {
      fail('CHANGE_EVIDENCE_UNVERIFIED', '该改动引用不是本 Task 已由主管确认的证据，拒绝读取。')
    }
    // 必须仍属于当前有效交付目录：历史 ACCEPT 引用、已漂移证据或已不存在的条目
    // 都不能单独开放正文。
    const currentItem = this.deliveryItems(record).find(item => item.taskId === task.task_id
      && item.changeKind === 'REPO_RELATIVE_VERIFIED'
      && deliveryChangeItemId(item.deliveryId, entryId) === item.itemId)
    if (!currentItem) {
      fail('CHANGE_EVIDENCE_UNVERIFIED', '该改动条目不在当前有效交付目录内，拒绝读取。')
    }
    const opened = readChangeEntry(undefined, ref, entryId)
    if (!opened.ok) fail('CHANGE_EVIDENCE_UNVERIFIED', opened.reason)
    const entry = opened.entry
    return {
      kind: 'SUPERVISOR_CONFIRMED_BOUNDED_WINDOW',
      label: CHANGE_EVIDENCE_LABEL,
      evidenceId: ref.evidenceId,
      entryId: entry.entryId,
      taskId: task.task_id,
      taskTitle: redactDeliveryText(task.title),
      attemptNo: ref.attemptNo,
      status: entry.status,
      repoPath: entry.repoPath,
      revision: `evidence:${ref.evidenceId}`,
      repoVcs: opened.manifest.repo.vcs,
      repoHead: opened.manifest.repo.head,
      coverageComplete: opened.manifest.coverage.complete,
      coverageReasons: opened.manifest.coverage.reasons.slice(0, 16),
      labels: entry.labels.slice(0, 16),
      note: entry.note,
      hunks: entry.hunks.slice(0, 200).map(hunk => ({ kind: hunk.kind, beforeLine: hunk.beforeLine, afterLine: hunk.afterLine, text: hunk.text })),
    }
  }

  async prepare(handle: OwnerDecisionHandle, raw: OwnerOperationInput, options: { signal?: AbortSignal } = {}): Promise<OwnerOperationPreview> {
    const record = this.active(handle)
    if (record.preparations.size >= 128) fail('PREPARATION_LIMIT', '当前窗口准备次数已达上限，请重新激活。')
    const input = normalizeInput(raw)
    // 操作编号必须在预览与提交之间保持同一个：提问事实的身份以一次 Owner operation
    // 为界（同一编号重放幂等、不同编号即使文本相同也是两条独立事实），因此它先于
    // 预览计算生成，并同时用于指纹上下文与最终预览。
    const operationId = randomUUID()
    const context = this.context(record, input, operationId)
    await this.validate(record, input, options.signal)
    this.active(handle)
    const checked = this.context(record, input, operationId)
    if (checked.fingerprint !== context.fingerprint) fail('PREVIEW_STALE', '校验期间相关事实已改变，请重新预览。')
    const createdAt = new Date(this.now()).toISOString()
    const preview: OwnerOperationPreview = { prepareId: randomUUID(), operationId, decisionId: record.view.decisionId,
      action: input.action, summary: checked.summary, changes: this.changes(input, checked),
      affected: { territoryIds: checked.territoryIds, bindingIds: checked.bindingIds }, createdAt, expiresAt: record.view.expiresAt }
    record.preparations.set(preview.prepareId, { input: clone(input), inputHash: ownerInputHash(input), fingerprint: checked.fingerprint, preview })
    return clone(preview)
  }

  async commit(handle: OwnerDecisionHandle, input: { prepareId: string; operationId: string }, options: { signal?: AbortSignal } = {}): Promise<OwnerOperationReceipt> {
    object(input, ['prepareId', 'operationId'])
    const record = this.decisions.get(handle)
    if (!record) fail('OWNER_DECISION_REQUIRED', '管理窗口无效。')
    const preparation = record.preparations.get(string(input.prepareId, '准备 ID'))
    if (!preparation || preparation.preview.operationId !== string(input.operationId, '操作 ID')) fail('OPERATION_MISMATCH', '操作 ID 与准备内容不匹配。')
    const existing = this.receipt(handle, input.operationId)
    if (existing) return existing
    this.active(handle)
    if (preparation.committing) return clone(await preparation.committing)
    const pending = this.apply(handle, record, preparation, options.signal)
    preparation.committing = pending
    try { return clone(await pending) } finally { preparation.committing = undefined }
  }

  receipt(handle: OwnerDecisionHandle, operationId: string): OwnerOperationReceipt | null {
    const record = this.decisions.get(handle)
    if (!record) return null
    for (const preparation of record.preparations.values()) {
      if (preparation.preview.operationId !== operationId) continue
      const kingdom = this.store.getDefaultKingdom()
      if (!kingdom || record.view.kingdomId !== null && record.view.kingdomId !== kingdom.kingdom_id) return null
      const row = this.store.getEventById(this.receiptEventId(kingdom.kingdom_id, operationId))
      if (!row) return null
      const payload = JSON.parse(row.payload_json) as OwnerOperationReceipt
      if (row.event_type !== 'OWNER_OPERATION_APPLIED' || row.actor_id !== kingdom.owner_id || payload.decisionId !== record.view.decisionId
        || payload.prepareId !== preparation.preview.prepareId || payload.operationId !== operationId || payload.inputHash !== preparation.inputHash) {
        fail('OPERATION_REPLAY_CONFLICT', '已有回执与该操作引用不一致。')
      }
      const result: OwnerOperationReceipt = { type: payload.type, operationId: payload.operationId, prepareId: payload.prepareId,
        decisionId: payload.decisionId, kingdomId: payload.kingdomId, ownerId: payload.ownerId, action: payload.action,
        inputHash: payload.inputHash, status: payload.status, target: payload.target, receiptSeq: row.seq, appliedAt: payload.appliedAt, message: payload.message }
      return clone(result)
    }
    return null
  }

  revoke(handle: OwnerDecisionHandle): OwnerDecisionView {
    const record = this.decisions.get(handle)
    if (!record) fail('OWNER_DECISION_REQUIRED', '管理窗口无效。')
    this.expire(record)
    const wasActive = record.view.state === 'ACTIVE'
    this.invalidate(record, 'REVOKED')
    if (wasActive && record.view.kingdomId && record.view.ownerId) {
      this.event(record.view.kingdomId, record.view.ownerId, 'OWNER_DECISION_REVOKED', record.view.decisionId,
        ownerEventPayload('revoke', { decision_id: record.view.decisionId }, { source_channel: 'LOCAL_OWNER_GUI', authorization_source: 'LOCAL_DIRECT_SLASH' }))
    }
    return clone(record.view)
  }

  dispose(): void {
    this.disposed = true
    for (const record of this.decisions.values()) this.invalidate(record, 'REVOKED')
  }

  private expire(record: DecisionRecord): void {
    if (this.now() >= Date.parse(record.view.expiresAt)) this.invalidate(record, 'EXPIRED')
  }
  private invalidate(record: DecisionRecord, state: 'EXPIRED' | 'REVOKED' | 'CONSUMED'): void {
    if (record.view.state !== 'ACTIVE') return
    record.view.state = state
    clearTimeout(record.timer)
    record.abort.abort(new OwnerOperationError(`OWNER_DECISION_${state}`, '管理窗口已失效。'))
  }
  private active(handle: OwnerDecisionHandle): DecisionRecord {
    const record = this.decisions.get(handle)
    if (!record) fail('OWNER_DECISION_REQUIRED', '管理窗口无效。')
    this.assertActive(record)
    return record
  }
  private assertActive(record: DecisionRecord): void {
    this.expire(record)
    if (this.disposed || record.view.state !== 'ACTIVE') fail(`OWNER_DECISION_${record.view.state}`, '管理窗口已到期、撤销或消费。')
    const kingdom = this.store.getDefaultKingdom()
    if (record.view.kingdomId === null ? !!kingdom : !kingdom || kingdom.kingdom_id !== record.view.kingdomId || kingdom.owner_id !== record.view.ownerId) {
      fail('KINGDOM_MISMATCH', '当前王国事实已改变。')
    }
  }

  private async observe<T>(record: DecisionRecord, request: AbortSignal | undefined, callback: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertActive(record)
    const abort = new AbortController()
    const signals = [record.abort.signal, ...(request ? [request] : [])]
    const listeners = signals.map(signal => {
      const listener = () => abort.abort(signal.reason ?? new OwnerOperationError('REQUEST_ABORTED', '请求已取消。'))
      if (signal.aborted) listener()
      else signal.addEventListener('abort', listener, { once: true })
      return { signal, listener }
    })
    const timer = setTimeout(() => abort.abort(new OwnerOperationError('VALIDATION_TIMEOUT', '运行环境校验超时。')), this.timeout)
    let onAbort: (() => void) | undefined
    try {
      if (abort.signal.aborted) fail('REQUEST_ABORTED', '请求或窗口已取消。')
      const interrupted = new Promise<never>((_, reject) => {
        onAbort = () => reject(abort.signal.reason instanceof OwnerOperationError ? abort.signal.reason : new OwnerOperationError('REQUEST_ABORTED', '请求已取消。'))
        abort.signal.addEventListener('abort', onAbort, { once: true })
      })
      const result = await Promise.race([Promise.resolve().then(() => callback(abort.signal)), interrupted])
      this.assertActive(record)
      if (abort.signal.aborted) fail('REQUEST_ABORTED', '请求已取消。')
      return result
    } catch (error) {
      if (error instanceof OwnerOperationError) throw error
      return fail('VALIDATION_UNAVAILABLE', '运行环境校验不可用。')
    } finally {
      clearTimeout(timer)
      if (onAbort) abort.signal.removeEventListener('abort', onAbort)
      for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener)
    }
  }

  private async validate(record: DecisionRecord, input: OwnerOperationInput, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) fail('REQUEST_ABORTED', '请求已取消。')
    const kingdomId = record.view.kingdomId!
    let result: OwnerValidationResult = { ok: true }
    if (input.action === 'role.bind' && input.parameters.role_type !== 'WORKER') {
      const p = input.parameters
      result = await this.observe(record, signal, signal => this.options.validateTargetSession({ kingdomId,
        roleType: p.role_type as 'CHANCELLOR' | 'SUPERVISOR', bindingId: null, sessionId: p.session_id!, signal }))
    } else if (input.action === 'role.session') {
      const p = input.parameters
      const binding = this.store.getBindingById(p.binding_id)!
      result = await this.observe(record, signal, signal => this.options.validateTargetSession({ kingdomId,
        roleType: binding.role_type as 'CHANCELLOR' | 'SUPERVISOR', bindingId: p.binding_id, sessionId: p.session_id, signal }))
    } else if (input.action === 'execution-profile') {
      const p = input.parameters
      const binding = this.store.getBindingById(p.binding_id)!
      result = await this.observe(record, signal, signal => this.options.validateExecutionProfile({ kingdomId,
        roleType: binding.role_type as OwnerManagedRole, bindingId: p.binding_id, profile: p.profile === null ? null : Object.freeze({ ...p.profile }), signal }))
    }
    this.assertActive(record)
    if (signal?.aborted) fail('REQUEST_ABORTED', '请求已取消。')
    if (!result || result.ok !== true) fail(result?.ok === false ? result.code : 'VALIDATION_UNAVAILABLE', result?.ok === false ? result.message : '运行环境未提供有效校验结果。')
  }

  private context(record: DecisionRecord, input: OwnerOperationInput, operationId: string): OperationContext {
    this.assertActive(record)
    if (!record.view.actions.includes(input.action)) fail('SCOPE_DENIED', '该动作未获本次授权。')
    const kingdomId = record.view.kingdomId
    const scope = record.view.scope
    const territories = new Set<string>(), bindings = new Set<string>(), sessions = new Set<string>()
    const facts: unknown[] = []
    let before: string | null = null, after: string | null = null, summary = ''
    const territory = (id: string): TerritoryRow => {
      const row = this.store.getTerritoryById(id)
      if (!row || row.kingdom_id !== kingdomId || row.status === 'DELETED' || !scope.territoryIds.includes(id)) fail('SCOPE_DENIED', '领地不在授权范围内或不可用。')
      territories.add(id); facts.push(row); return row
    }
    const binding = (id: string): RoleBindingRow => {
      const row = this.store.getBindingById(id)
      if (!row || row.kingdom_id !== kingdomId || row.status !== 'ACTIVE' || !scope.bindingIds.includes(id)
        || !scope.roleTypes.includes(row.role_type as OwnerManagedRole) || !MANAGED_ROLES.includes(row.role_type)) fail('SCOPE_DENIED', '绑定不在授权范围内或不可用。')
      bindings.add(id); facts.push(row); if (row.session_id) sessions.add(row.session_id); return row
    }
    const targetSession = (id: string, bindingId: string | null): void => {
      if (!scope.targetSessionIds.includes(id)) fail('SCOPE_DENIED', '目标 Session 不在授权范围内。')
      sessions.add(id)
      const occupants = this.store.listBindings(kingdomId!).filter(row => row.status === 'ACTIVE' && row.session_id === id && row.binding_id !== bindingId)
      facts.push(occupants)
      if (occupants.length) fail('SESSION_ALREADY_BOUND', '目标 Session 已属于其他活跃角色。')
    }
    const affectedBindingTerritories = (row: RoleBindingRow): void => {
      const related = this.store.listTerritories(kingdomId!).filter(t => t.supervisor_binding_id === row.binding_id)
      for (const t of related) territory(t.territory_id)
      if (row.role_type === 'WORKER') {
        if (this.store.isSchemaV4) {
          const affinities = this.store.listAffinities(kingdomId!).filter(a => a.worker_binding_id === row.binding_id && a.is_current === 1)
          facts.push(affinities)
          for (const affinity of affinities) { territory(affinity.territory_id); sessions.add(affinity.session_ref) }
        }
        for (const task of this.store.listTasks(kingdomId!)) {
          if (task.assigned_binding_id === row.binding_id && !['DONE', 'FAILED'].includes(task.status)) territory(task.territory_id)
        }
      }
      facts.push(related.map(t => t.territory_id).sort())
    }
    switch (input.action) {
      case 'delivery.item.ack': {
        const p = input.parameters
        const task = this.store.getTask(p.task_id)
        if (!task) fail('SCOPE_DENIED', '任务不存在或不属于当前王国。')
        const taskTerritory = this.store.getTerritoryById(task.territory_id)
        if (!taskTerritory || taskTerritory.kingdom_id !== kingdomId || taskTerritory.status === 'DELETED') {
          fail('SCOPE_DENIED', '任务不属于当前王国。')
        }
        // 与 catalog 共用同一范围判据；知悉不改配置或责任，因此这里只登记领地事实，
        // 不要求领地直接列在 territoryIds 中，也不参与 guardUnsettled。
        if (!this.deliveryScopeAllows(record, taskTerritory)) fail('SCOPE_DENIED', '该交付不在本次授权范围内。')
        territories.add(task.territory_id)
        facts.push(taskTerritory)
        const claim = this.store.latestWorkerResult(p.task_id)
        const review = readLatestReviewEvent(this.store, kingdomId!, p.task_id)
        const classification = classifyAcceptedDelivery(this.store, claim, review)
        if (!claim || !classification) {
          fail('DELIVERY_NOT_CONFIRMED', '该交付尚未由同一 Task/attempt 的主管 ACCEPT 确认，不能记录知悉。')
        }
        if (claim.attempt_no !== p.attempt_no || claim.result_id !== p.result_id) {
          fail('DELIVERY_VERSION_STALE', '交付的已接受版本已变化，请重新打开清单。')
        }
        // 接受证据强度进入 fingerprint：确认依据从强证据降为历史弱证据（或反之）时，
        // 预览必须失效，Owner 不能在不知情的情况下按旧预览提交。
        facts.push(claim, review, classification.kind, classification.evidence)
        const deliveryId = deliveryIdFor(p.task_id)
        if (deliveryId !== p.delivery_id) fail('DELIVERY_VERSION_STALE', '交付标识与当前已接受版本不一致。')
        const derived = deriveDeliveryItems(p.task_id, claim, this.changeEvidenceFor(kingdomId!, p.task_id))
        const item = derived.find(candidate => candidate.itemId === p.item_id)
        if (!item) fail('DELIVERY_ITEM_UNKNOWN', '该条目不在当前交付清单中。')
        if (item.contentHash !== p.content_hash) {
          fail('DELIVERY_ITEM_VERSION_STALE', '该条目内容版本已变化，请重新打开清单后再知悉。')
        }
        facts.push(item.contentHash)
        const ownerId = this.store.getDefaultKingdom()?.owner_id ?? ''
        const acknowledgements = readDeliveryAcknowledgements(this.store, kingdomId!, deliveryId)
        const view = deliveryAcknowledgementView(acknowledgements, item, ownerId)
        if (view.acknowledged) fail('DELIVERY_ITEM_ALREADY_ACKNOWLEDGED', '该条目当前版本已由 Owner 知悉；重复知悉不会新增记录。')
        facts.push(acknowledgements)
        before = view.acknowledgedAt
        after = JSON.stringify({ deliveryId, itemId: item.itemId, contentHash: item.contentHash, attemptNo: claim.attempt_no,
          acceptanceEvidenceKind: classification.kind, acceptanceEvidenceExact: classification.evidence.exactResultBound })
        summary = `记下已知悉「${item.content.label}」当前版本（不代表理解、质量认可、Task 完成或发布授权）`
        break
      }
      case 'delivery.item.question': {
        const p = input.parameters
        const task = this.store.getTask(p.task_id)
        if (!task) fail('SCOPE_DENIED', '任务不存在或不属于当前王国。')
        const taskTerritory = this.store.getTerritoryById(task.territory_id)
        if (!taskTerritory || taskTerritory.kingdom_id !== kingdomId || taskTerritory.status === 'DELETED') {
          fail('SCOPE_DENIED', '任务不属于当前王国。')
        }
        if (!this.deliveryScopeAllows(record, taskTerritory)) fail('SCOPE_DENIED', '该交付不在本次授权范围内。')
        territories.add(task.territory_id)
        facts.push(taskTerritory)
        const claim = this.store.latestWorkerResult(p.task_id)
        const review = readLatestReviewEvent(this.store, kingdomId!, p.task_id)
        const classification = classifyAcceptedDelivery(this.store, claim, review)
        if (!claim || !classification) {
          fail('DELIVERY_NOT_CONFIRMED', '该交付尚未由同一 Task/attempt 的主管 ACCEPT 确认，不能提问。')
        }
        if (claim.attempt_no !== p.attempt_no || claim.result_id !== p.result_id) {
          fail('DELIVERY_VERSION_STALE', '交付的已接受版本已变化，请重新打开清单。')
        }
        facts.push(claim, review, classification.kind, classification.evidence)
        const deliveryId = deliveryIdFor(p.task_id)
        if (deliveryId !== p.delivery_id) fail('DELIVERY_VERSION_STALE', '交付标识与当前已接受版本不一致。')
        // 接收者在写入前就固定：接受事件没有可核对的主管绑定时直接拒绝，而不是先写问题再猜接收者。
        const reviewerBindingId = deliveryReviewerBindingId(review)
        if (!reviewerBindingId) {
          fail('DELIVERY_ACCEPT_REVIEWER_UNKNOWN', '接受事件没有记录主管绑定，无法确定本问题的接收者。')
        }
        facts.push(reviewerBindingId)
        const derived = deriveDeliveryItems(p.task_id, claim, this.changeEvidenceFor(kingdomId!, p.task_id))
        const item = derived.find(candidate => candidate.itemId === p.item_id)
        if (!item) fail('DELIVERY_ITEM_UNKNOWN', '该条目不在当前交付清单中。')
        if (item.contentHash !== p.content_hash) {
          fail('DELIVERY_ITEM_VERSION_STALE', '该条目内容版本已变化，请重新打开清单后再提问。')
        }
        facts.push(item.contentHash)
        const questionText = boundedQuestionText(p.question_text, DELIVERY_QUESTION_TEXT_LIMIT)
        if (!questionText) fail('INVALID_INPUT', '问题内容必须是非空、长度受限的文本。')
        // 幂等只以**本次 Owner operation** 为界：同一 operationId 重放命中同一事件 ID，
        // 才会被判为「不会新增第二条事实」；不同 operation 即使条目与文本都相同，也各自
        // 形成独立问题。绝不按正文去重，否则新操作的提问会被历史同文问题吞掉。
        const operationEventId = deliveryQuestionEventId({ kingdomId: kingdomId!, deliveryId, itemId: item.itemId,
          contentHash: item.contentHash, operationId })
        const duplicate = this.store.getEventById(operationEventId) !== null
        const thread = deliveryQuestionThreadForItem(readDeliveryQuestionThread(this.store, kingdomId!, deliveryId),
          item.itemId, item.contentHash)
        facts.push(thread?.questions.map(question => [question.questionId, question.reply?.eventId ?? null]).sort() ?? null)
        before = thread ? `${thread.questions.length} 条提问（${thread.pendingCount} 待回复 / ${thread.answeredCount} 已回复）` : null
        after = JSON.stringify({ deliveryId, itemId: item.itemId, contentHash: item.contentHash, attemptNo: claim.attempt_no,
          reviewerBindingId, questionText, duplicate })
        summary = `就「${item.content.label}」当前版本向接受该交付的主管提一个具体问题（记录为一条对话事实，不是知悉，也不改变任务状态）`
        break
      }
      case 'plan.adopt': {
        const p = input.parameters, plan = readCollaborationPlan(this.store, kingdomId!, p.plan_id)
        if (!plan || plan.version !== p.version || plan.digest !== p.digest || plan.state !== 'PROPOSED') fail('PLAN_VERSION_STALE', '计划已变化、已采纳或不可采纳，请重新打开计划。')
        const parent = this.store.getTask(plan.parentTaskId)
        if (!parent || parent.status !== 'CREATED') fail('PLAN_CONTEXT_STALE', '父任务已变化，请重新提案。')
        territory(parent.territory_id); binding(plan.integratorBindingId)
        for (const item of plan.items) { territory(item.territoryId); binding(item.workerBindingId) }
        facts.push(plan, parent)
        after = JSON.stringify(plan); summary = '采纳这份协作计划（创建子项；授权、执行和验收仍由合法主管完成）'; break
      }
      case 'budget.policy': {
        if (!scope.kingdomWide) fail('SCOPE_DENIED', '预算政策需要王国级授权。')
        if (!this.store.isSchemaV4) fail('SCHEMA_V4_REQUIRED', '当前数据库不支持 governed 预算；不会自动迁移。')
        const previous = readBudgetPolicy(this.store, kingdomId!)
        facts.push(previous)
        before = previous ? JSON.stringify(previous) : null
        after = JSON.stringify(input.parameters)
        summary = '更新后续工作的软预算（已接纳工作继续，统计起点不重置）'; break
      }
      case 'init':
        if (kingdomId !== null || this.store.getDefaultKingdom()) fail('BOOTSTRAP_ONLY', '初始化只能用于空库。')
        after = JSON.stringify(input.parameters); summary = '初始化王国及常驻 Owner'; break
      case 'territory.create': {
        const p = input.parameters
        const path = directory(p.workspace_path)
        if (path !== p.workspace_path || !scope.workspaceRoots.some(root => directory(root) === root && within(path, root))) fail('SCOPE_DENIED', '工作目录超出已授权根或路径已变化。')
        const existing = this.store.getTerritoryByName(kingdomId!, p.name)
        facts.push(existing)
        if (existing) fail('NAME_CONFLICT', '该领地名称已存在。')
        after = JSON.stringify(p); summary = '创建领地'; break
      }
      case 'territory.update': {
        const p = input.parameters, row = territory(p.territory_id)
        const name = p.name ?? row.name
        const existing = this.store.getTerritoryByName(kingdomId!, name)
        facts.push(existing)
        if (existing && existing.territory_id !== row.territory_id) fail('NAME_CONFLICT', '该领地名称已存在。')
        before = JSON.stringify({ name: row.name, summary: row.summary })
        after = JSON.stringify({ name, summary: p.summary === undefined ? row.summary : p.summary }); summary = '更新领地名称和说明'; break
      }
      case 'territory.supervisor': {
        const p = input.parameters, row = territory(p.territory_id), supervisor = binding(p.supervisor_binding_id)
        if (supervisor.role_type !== 'SUPERVISOR') fail('INVALID_ROLE', '目标必须是活跃主管。')
        if (row.supervisor_binding_id) {
          // The previous relationship is historical input, not a request to edit
          // or re-authorize a retired role. Its old session still participates in
          // unsettled-work guards, even when the old binding is outside the new-write scope.
          const previous = this.store.getBindingById(row.supervisor_binding_id)
          if (previous && previous.kingdom_id !== kingdomId) fail('RELATED_BINDING_UNAVAILABLE', '旧主管引用不属于当前王国，无法安全修改责任。')
          facts.push({ previousSupervisor: previous, previousSupervisorId: row.supervisor_binding_id })
          bindings.add(row.supervisor_binding_id)
          if (previous?.session_id) sessions.add(previous.session_id)
        }
        before = row.supervisor_binding_id; after = supervisor.binding_id; summary = '更新领地主理主管'; break
      }
      case 'role.bind': {
        const p = input.parameters
        if (!scope.roleTypes.includes(p.role_type)) fail('SCOPE_DENIED', '该角色不在授权范围内。')
        if (p.role_type === 'CHANCELLOR') {
          const existing = this.store.getBindingByRole(kingdomId!, p.role_type)
          facts.push(existing)
          if (existing) fail('ROLE_ALREADY_BOUND', '宰相席位已有活跃绑定。')
        }
        if (p.session_id) targetSession(p.session_id, null)
        after = JSON.stringify(p); summary = '任命角色'; break
      }
      case 'role.session': {
        const p = input.parameters, row = binding(p.binding_id)
        if (!['CHANCELLOR', 'SUPERVISOR'].includes(row.role_type)) fail('WORKER_SESSION_UNSUPPORTED', '只允许改绑主管或宰相；执行者 affinity 不由此迁移。')
        affectedBindingTerritories(row)
        targetSession(p.session_id, row.binding_id)
        before = row.session_id; after = p.session_id; summary = '改绑角色 Session'; break
      }
      case 'ceiling':
        if (!scope.kingdomWide) fail('SCOPE_DENIED', '权限上限需要王国级授权。')
        if (!this.store.isSchemaV4) fail('SCHEMA_V4_REQUIRED', '当前数据库不支持权限上限；此操作不会自动迁移。')
        before = this.store.getKingdomCapabilityCeiling(kingdomId!); after = JSON.stringify(input.parameters.ceiling)
        facts.push(before); summary = '更新王国权限上限（下一次执行生效）'; break
      case 'execution-profile': {
        const p = input.parameters, row = binding(p.binding_id)
        affectedBindingTerritories(row)
        before = row.execution_profile_json; after = p.profile === null ? null : JSON.stringify(p.profile)
        summary = '更新 requested 执行配置（不代表实际运行成功）'; break
      }
    }
    const context: OperationContext = { territoryIds: [...territories].sort(), bindingIds: [...bindings].sort(), sessionIds: [...sessions].sort(),
      fingerprint: ownerInputHash(facts), before, after, summary }
    // `delivery.item.ack` 只追加 Owner 知悉事实，不改配置与责任，因此不受
    // 同领地不相关未结算执行/Lease/Dispatch 阻断。
    if (kingdomId && input.action !== 'territory.update' && input.action !== 'territory.create' && input.action !== 'budget.policy' && input.action !== 'plan.adopt' && input.action !== 'delivery.item.ack' && input.action !== 'delivery.item.question') this.guardUnsettled(kingdomId, input.action === 'ceiling', context)
    return context
  }

  private guardUnsettled(kingdomId: string, all: boolean, context: OperationContext): void {
    const affected = (territoryId: string | null, bindingId: string | null, sessionId: string | null): boolean => all
      || !!territoryId && context.territoryIds.includes(territoryId)
      || !!bindingId && context.bindingIds.includes(bindingId)
      || !!sessionId && context.sessionIds.includes(sessionId)
    for (const execution of this.store.listUnsettledOwnerExecutions(kingdomId)) {
      const task = this.store.getTask(execution.task_id)
      if (affected(task?.territory_id ?? null, execution.worker_binding_id, execution.session_id)) fail('UNSETTLED_EXECUTION', '影响范围内存在未结算执行，暂不能变更配置或责任。')
    }
    if (this.store.isSchemaV4) {
      const leases = this.store.listLeases(kingdomId)
      for (const lease of leases) {
        if (lease.state !== 'RELEASED' && affected(lease.territory_id, lease.worker_binding_id, lease.session_ref)) fail('UNSETTLED_LEASE', '影响范围内存在未释放 Lease，暂不能变更。')
      }
      for (const dispatch of this.store.listDispatches(kingdomId)) {
        if (['TERMINAL', 'FAILED'].includes(dispatch.state)) continue
        const lease = leases.find(row => row.lease_id === dispatch.lease_id)
        const task = this.store.getTask(dispatch.task_id)
        if (affected(lease?.territory_id ?? task?.territory_id ?? null, lease?.worker_binding_id ?? null, dispatch.session_ref)) fail('UNSETTLED_DISPATCH', '影响范围内存在未结算派发。')
      }
    }
  }

  private changes(input: OwnerOperationInput, context: OperationContext): OwnerOperationPreview['changes'] {
    const change = (label: string, before: string | null | undefined, after: string | null | undefined) => ({ label, before: before ?? null, after: after ?? null })
    switch (input.action) {
      case 'plan.adopt': {
        const plan = JSON.parse(context.after!) as CollaborationPlanView
        const worker = (id: string) => `${this.store.getBindingById(id)?.role_name ?? '执行者'}（${id}）`
        return [change('计划版本与内容摘要', null, `${plan.planId} / v${plan.version} / ${plan.digest}`),
          change('父任务', null, this.store.getTask(plan.parentTaskId)?.title),
          change('拆分理由', null, plan.reason), change('协作方式', null, plan.mode === 'EXPERT' ? '主执行者与只读专家' : '独立工作项小团队'),
          change('主整合者', null, worker(plan.integratorBindingId)), change('整项 Token 软预算', null, String(plan.budgetTokens)),
          change('每次工作估计预留', null, String(plan.reserveTokens)),
          ...plan.items.flatMap((item, i) => [change(`子项 ${i + 1}：${item.title}`, null, item.description),
            change(`子项 ${i + 1} 负责人及范围`, null, `${worker(item.workerBindingId)}；${this.store.getTerritoryById(item.territoryId)?.name}；${item.access === 'READ_ONLY' ? '只读' : '工作区写入独占'}`),
            change(`子项 ${i + 1} 验收`, null, item.acceptanceCriteria), change(`子项 ${i + 1} 前置依赖`, null, item.dependsOn.join('、') || '无'),
            change(`子项 ${i + 1} 预期产物`, null, item.expectedArtifact)])]
      }
      case 'budget.policy': {
        const previous = context.before ? JSON.parse(context.before) as ReturnType<typeof readBudgetPolicy> : null
        const p = input.parameters
        return [change('限制新增接纳', previous?.enabled ? '开启' : '关闭', p.enabled ? '开启' : '关闭'),
          change('Token 软预算', previous ? String(previous.limitTokens) : null, String(p.limit_tokens)),
          change('每次工作估计预留', previous ? String(previous.reserveTokens) : null, String(p.reserve_tokens)),
          change('用量未确认时', previous ? previous.unknownPolicy === 'BLOCK' ? '阻止新增接纳' : '告警并继续' : null, p.unknown_policy === 'BLOCK' ? '阻止新增接纳' : '告警并继续'),
          change('告警比例', previous ? `${previous.warningPercent}%` : null, `${p.warning_percent ?? 80}%`)]
      }
      case 'init': return [change('王国名称', null, input.parameters.kingdom_name), change('Owner 显示名', null, input.parameters.owner_name)]
      case 'territory.create': return [change('领地名称', null, input.parameters.name), change('本机工作目录', null, input.parameters.workspace_path), change('领地说明', null, input.parameters.summary)]
      case 'territory.update': {
        const before = JSON.parse(context.before!) as { name: string; summary: string | null }
        const after = JSON.parse(context.after!) as { name: string; summary: string | null }
        return [...(input.parameters.name !== undefined ? [change('领地名称', before.name, after.name)] : []),
          ...(input.parameters.summary !== undefined ? [change('领地说明', before.summary, after.summary)] : [])]
      }
      case 'territory.supervisor': {
        const describe = (id: string | null) => id ? `${this.store.getBindingById(id)?.role_name ?? '主管'}（${id}）` : null
        return [change('主理主管', describe(context.before), describe(context.after))]
      }
      case 'role.bind': return [change('角色身份', null, { CHANCELLOR: '宰相', SUPERVISOR: '主管', WORKER: '执行者' }[input.parameters.role_type]),
        change('角色名称', null, input.parameters.role_name), change('目标 Session', null, input.parameters.session_id)]
      case 'role.session': return [change('角色 Session', context.before, context.after)]
      case 'ceiling': {
        const before = context.before ? JSON.parse(context.before) as Record<string, boolean> : {}
        const after = input.parameters.ceiling
        const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
        if (!keys.length) return [change('王国权限上限', context.before === null ? null : '未允许任何能力', '未允许任何能力')]
        const permission = (value: boolean | undefined) => value === undefined ? '未配置（不授予）' : value ? '允许' : '禁止'
        return keys.map(key => change(`能力 ${key}`, permission(before[key]), permission(after[key])))
      }
      case 'execution-profile': {
        const before = context.before ? JSON.parse(context.before) as ExecutionProfileV1 : null
        const after = input.parameters.profile
        return [change('请求的 Provider', before?.provider, after?.provider), change('请求的模型', before?.model, after?.model)]
      }
      case 'delivery.item.ack': {
        const after = JSON.parse(context.after!) as { deliveryId: string; itemId: string; contentHash: string; attemptNo: number
          acceptanceEvidenceKind: DeliveryAcceptanceEvidenceKind; acceptanceEvidenceExact: boolean }
        const task = this.store.getTask(input.parameters.task_id)
        const item = deriveDeliveryItems(input.parameters.task_id, this.store.latestWorkerResult(input.parameters.task_id)!,
          this.changeEvidenceFor(this.store.getDefaultKingdom()?.kingdom_id ?? '', input.parameters.task_id))
          .find(candidate => candidate.itemId === after.itemId)
        return [change('任务', null, task?.title),
          change('已接受尝试', null, String(after.attemptNo)),
          change('条目', null, item ? `${item.content.label}` : after.itemId),
          change('条目内容', null, item?.content.detail),
          change('内容版本', null, after.contentHash),
          change('改动定位', null, item ? `${item.content.change.kind}${item.content.change.evidenceLabel ? ` · ${item.content.change.evidenceLabel}` : ''} · ${item.content.change.note}` : null),
          change('接受证据强度', null, after.acceptanceEvidenceExact
            ? 'EXACT_RESULT_BOUND：TASK_ACCEPTED 锁定了本次结果 ID 与内容摘要，且两者都与当前呈报一致。'
            : '历史接受证据较弱（LEGACY_ATTEMPT_ONLY）：该 Task/attempt 的 TASK_ACCEPTED 是 v1.0.0 旧格式，只有尝试编号，缺少被审查结果 ID 与内容摘要；本条按真实事件字段与同 Task/attempt 的唯一 WorkerResult 判定，不是 exact result-bound 证据。知悉仍只表示已知悉该条当前版本，不代表理解、质量认可、人类验收、Task DONE 或发布授权。'),
          change('Owner 知悉时间（本窗口提交后）', null, '提交时记录'),
          change('不改动的状态', null, '任务状态、主管审查、正式 Owner acceptance 与发布状态均不变')]
      }
      case 'delivery.item.question': {
        const after = JSON.parse(context.after!) as { deliveryId: string; itemId: string; contentHash: string; attemptNo: number
          reviewerBindingId: string; questionText: string; duplicate: boolean }
        const task = this.store.getTask(input.parameters.task_id)
        const item = deriveDeliveryItems(input.parameters.task_id, this.store.latestWorkerResult(input.parameters.task_id)!,
          this.changeEvidenceFor(this.store.getDefaultKingdom()?.kingdom_id ?? '', input.parameters.task_id))
          .find(candidate => candidate.itemId === after.itemId)
        const reviewer = this.store.getBindingById(after.reviewerBindingId)
        const territory = this.store.getTerritoryById(task?.territory_id ?? '')
        return [change('任务', null, task?.title),
          change('已接受尝试', null, String(after.attemptNo)),
          change('条目', null, item ? item.content.label : after.itemId),
          change('条目内容', null, item?.content.detail),
          change('内容版本', null, after.contentHash),
          change('接收者（接受该交付的主管）', null, reviewer ? `${reviewer.role_name}（${reviewer.binding_id}）` : after.reviewerBindingId),
          change('该领地当前主理主管', null, territory?.supervisor_binding_id ?? '未指派'),
          change('本次提交', null, after.duplicate
            ? '该条目当前版本的同一问题已有记录：不会新增第二条事实，也不会改变任何状态。'
            : '新增一条 Owner 提问事实；接收者仍是接受该交付的主管，当前未被读取前只显示「待领取」。'),
          change('问题的准确保留范围', null, after.duplicate
            ? '与既有记录一致，不重复写入。'
            : '只写入提问事实本身；不自动通知、不自动派发、不自动唤醒任何 Agent。'),
          change('不改动的状态', null, '任务状态、主管审查、知悉、正式 Owner acceptance 与发布状态均不变；提问不是知悉。'),
          change('回复', null, '由接受该交付的主管在其 session-bound Agent Tool 中回复；Owner 不代答，其他主管不能代答。')]
      }
    }
  }

  private async apply(handle: OwnerDecisionHandle, record: DecisionRecord, preparation: Preparation, signal?: AbortSignal): Promise<OwnerOperationReceipt> {
    this.active(handle)
    const context = this.context(record, preparation.input, preparation.preview.operationId)
    if (context.fingerprint !== preparation.fingerprint) fail('PREVIEW_STALE', '相关对象已变化，请重新预览。')
    await this.validate(record, preparation.input, signal)
    this.active(handle)
    if (signal?.aborted) fail('REQUEST_ABORTED', '请求已取消。')
    const result = this.store.withImmediateTransaction(() => {
      this.active(handle)
      const current = this.context(record, preparation.input, preparation.preview.operationId)
      if (current.fingerprint !== preparation.fingerprint || ownerInputHash(preparation.input) !== preparation.inputHash) fail('PREVIEW_STALE', '相关事实或准备内容已变化，请重新预览。')
      const source: OwnerEventSource = { source_channel: 'LOCAL_OWNER_GUI', authorization_source: 'LOCAL_DIRECT_SLASH',
        decision_id: record.view.decisionId, operation_id: preparation.preview.operationId }
      let kingdomId = record.view.kingdomId!, ownerId = record.view.ownerId!, target: OwnerOperationReceipt['target'], message: string
      if (preparation.input.action === 'init') {
        const p = preparation.input.parameters
        const initialized = initializeKingdomFacts(this.store, p.kingdom_name, p.owner_name, source)
        kingdomId = initialized.kingdomId; ownerId = initialized.ownerId; target = { type: 'kingdom', id: kingdomId }; message = initialized.detail
        this.event(kingdomId, ownerId, 'OWNER_DECISION_CONSUMED', record.view.decisionId, { decision: { ...record.view, state: 'CONSUMED' }, ...source })
      } else {
        const dispatched = this.mutate(record, preparation.input, source)
        target = dispatched.target; message = dispatched.message
      }
      const eventId = this.receiptEventId(kingdomId, preparation.preview.operationId)
      if (this.store.getEventById(eventId)) fail('OPERATION_REPLAY_CONFLICT', '操作回执已存在，请查询已有结果。')
      const appliedAt = new Date(this.now()).toISOString()
      const receipt: OwnerOperationReceipt = { type: 'KingdomOwnerOperationReceipt/v1', operationId: preparation.preview.operationId,
        prepareId: preparation.preview.prepareId, decisionId: record.view.decisionId, kingdomId, ownerId, action: preparation.input.action,
        inputHash: preparation.inputHash, status: 'APPLIED', target, receiptSeq: this.store.eventSequence() + 1, appliedAt, message }
      const row = this.store.appendEvent({ event_id: eventId, kingdom_id: kingdomId, event_type: 'OWNER_OPERATION_APPLIED',
        actor_role: 'OWNER', actor_id: ownerId, target_type: target.type, target_id: target.id,
        payload_json: JSON.stringify({ ...receipt, ...source }), created_at: appliedAt })
      receipt.receiptSeq = row.seq
      return receipt
    })
    preparation.receipt = result
    if (preparation.input.action === 'init') this.invalidate(record, 'CONSUMED')
    return result
  }

  /** Synchronous closed dispatcher: no callback or transport receives an administration capability. */
  private mutate(record: DecisionRecord, input: Exclude<OwnerOperationInput, { action: 'init' }>, source: OwnerEventSource): { target: OwnerOperationReceipt['target']; message: string } {
    const kingdomId = record.view.kingdomId!
    const beforeSeq = this.store.revision(kingdomId)
    const run = <T>(parameters: T, mutation: (store: KingdomStore, parameters: T, auth: AdminAuth) => string): string => {
      const capability = issueOwnerOperationCapability(record.authority, this.store, kingdomId, { operation: input.action, input: parameters }, source)
      try { return mutation(this.store, parameters, { mode: 'session-bound', ownerControl: capability }) }
      finally { revokeOwnerOperationCapability(capability) }
    }
    let message: string, eventType: string
    /** 本次是否真的追加了一条新业务事实；幂等重试时没有新事件，不能按「事件数恰好 1」判定失败。 */
    let appendedBusinessFact = true
    switch (input.action) {
      case 'plan.adopt':
        message = run({ kingdomId, ...input.parameters }, adoptCollaborationPlan)
        eventType = 'COLLABORATION_PLAN_ADOPTED'; break
      case 'budget.policy':
        message = run({ kingdomId, policy: input.parameters }, setBudgetPolicy)
        eventType = 'BUDGET_POLICY_UPDATED'; break
      case 'territory.create': {
        const p = input.parameters
        message = run({ kingdomId, name: p.name, workspacePath: p.workspace_path, summary: p.summary ?? undefined }, createTerritory)
        eventType = 'TERRITORY_CREATED'; break
      }
      case 'territory.update': {
        const p = input.parameters
        message = run({ kingdomId, territoryId: p.territory_id, name: p.name, summary: p.summary }, updateTerritory)
        eventType = 'TERRITORY_UPDATED'; break
      }
      case 'territory.supervisor': {
        const p = input.parameters
        message = run({ kingdomId, territoryId: p.territory_id, supervisorBindingId: p.supervisor_binding_id }, setTerritorySupervisor)
        eventType = 'TERRITORY_SUPERVISOR_UPDATED'; break
      }
      case 'role.bind': {
        const p = input.parameters
        message = run({ kingdomId, roleType: p.role_type, roleName: p.role_name, sessionId: p.session_id }, bindRole)
        eventType = 'ROLE_BOUND'; break
      }
      case 'role.session': {
        const p = input.parameters
        message = run({ kingdomId, bindingId: p.binding_id, sessionId: p.session_id }, rebindSession)
        eventType = 'BINDING_PROFILE_UPDATED'; break
      }
      case 'ceiling':
        run({ kingdomId, ceilingJson: JSON.stringify(input.parameters.ceiling) }, setCapabilityCeiling)
        message = '王国权限上限已保存；将用于后续执行，不改变已开始的工作。'
        eventType = 'CAPABILITY_CEILING_UPDATED'; break
      case 'execution-profile':
        run({ kingdomId, bindingId: input.parameters.binding_id, profile: input.parameters.profile }, setExecutionProfile)
        message = '请求的执行配置已保存；这不代表模型已实际运行成功。'
        eventType = 'EXECUTION_PROFILE_UPDATED'; break
      case 'delivery.item.ack': {
        const claim = this.store.latestWorkerResult(input.parameters.task_id)
        if (!claim) fail('DELIVERY_NOT_CONFIRMED', '交付对应的结果不存在。')
        const review = readLatestReviewEvent(this.store, kingdomId, input.parameters.task_id)
        const existing = readDeliveryAcknowledgements(this.store, kingdomId, input.parameters.delivery_id)
        const already = existing.some(ack => ack.itemId === input.parameters.item_id && ack.contentHash === input.parameters.content_hash
          && ack.ownerId === record.view.ownerId)
        if (!already) {
          const classification = classifyAcceptedDelivery(this.store, claim, review)
          if (!classification) fail('DELIVERY_NOT_CONFIRMED', '交付尚未由主管 ACCEPT 确认。')
          const changeEvidence = this.changeEvidenceFor(kingdomId, input.parameters.task_id)
          const item = deriveDeliveryItems(input.parameters.task_id, claim, changeEvidence).find(candidate => candidate.itemId === input.parameters.item_id)
          if (!item || item.contentHash !== input.parameters.content_hash) fail('DELIVERY_ITEM_VERSION_STALE', '条目内容版本已变化。')
          recordDeliveryAcknowledgement(this.store, {
            kingdomId,
            deliveryId: input.parameters.delivery_id,
            itemId: input.parameters.item_id,
            contentHash: input.parameters.content_hash,
            taskId: input.parameters.task_id,
            attemptNo: input.parameters.attempt_no,
            resultId: input.parameters.result_id,
            ownerId: record.view.ownerId!,
            ownerBindingId: this.store.getBindingByRole(kingdomId, 'OWNER')?.binding_id ?? null,
            itemLabel: item.content.label,
            acknowledgedAt: new Date(this.now()).toISOString(),
            attribution: { ...source },
            changeEvidence,
          })
        }
        message = already
          ? '该条目当前版本的 Owner 知悉记录已存在；未新增第二条事实。知悉不改变任务、审查与发布状态。'
          : '已记下 Owner 已知悉该条当前版本；这不代表理解、质量认可、Task DONE、正式验收或发布授权，也未改变任务、审查与发布状态。'
        eventType = DELIVERY_ACK_EVENT_TYPE; break
      }
      case 'delivery.item.question': {
        const claim = this.store.latestWorkerResult(input.parameters.task_id)
        if (!claim) fail('DELIVERY_NOT_CONFIRMED', '交付对应的结果不存在。')
        const review = readLatestReviewEvent(this.store, kingdomId, input.parameters.task_id)
        // 责任归属必须在事务内重算：预览时的接受主管身份、条目版本或领地改绑都可能已变化。
        const reviewerBindingId = deliveryReviewerBindingId(review)
        if (!reviewerBindingId) fail('DELIVERY_ACCEPT_REVIEWER_UNKNOWN', '接受事件没有记录主管绑定，无法确定本问题的接收者。')
        // CHANGE 条目只由「主管在 ACCEPT 中显式选择、且本地 hash 重验通过」的改动证据派生：
        // 预览、事务内校验与写入端必须复用**同一份**已重验证据，写入端才可能重算出同一
        // itemId/contentHash，而不是必报 DELIVERY_ITEM_UNKNOWN。
        const changeEvidence = this.changeEvidenceFor(kingdomId, input.parameters.task_id)
        const item = deriveDeliveryItems(input.parameters.task_id, claim, changeEvidence)
          .find(candidate => candidate.itemId === input.parameters.item_id)
        if (!item || item.contentHash !== input.parameters.content_hash) fail('DELIVERY_ITEM_VERSION_STALE', '条目内容版本已变化。')
        const questionText = boundedQuestionText(input.parameters.question_text, DELIVERY_QUESTION_TEXT_LIMIT)
        if (!questionText) fail('INVALID_INPUT', '问题内容必须是非空、长度受限的文本。')
        const operationId = source.operation_id
        if (!operationId) fail('OPERATION_MISMATCH', '本次管理操作没有操作编号，拒绝写入提问事实。')
        // 提问身份属于产生它的这次 Owner operation：同一编号重放由写入端的幂等分支核对
        // 并原样返回既有事实；不同编号即使文本相同也各自形成独立问题。这里不再按正文去重，
        // 「没有新事件」也不等于操作失败。
        const recorded = recordDeliveryQuestion(this.store, {
          kingdomId,
          deliveryId: input.parameters.delivery_id,
          taskId: input.parameters.task_id,
          itemId: input.parameters.item_id,
          itemLabel: item.content.label,
          contentHash: input.parameters.content_hash,
          attemptNo: input.parameters.attempt_no,
          resultId: input.parameters.result_id,
          ownerId: record.view.ownerId!,
          ownerBindingId: this.store.getBindingByRole(kingdomId, 'OWNER')?.binding_id ?? null,
          operationId,
          questionText,
          askedAt: new Date(this.now()).toISOString(),
          changeEvidence,
          attribution: { ...source },
        })
        appendedBusinessFact = recorded.created
        message = recorded.created
          ? `已记录 Owner 就该条目当前版本提出的问题，接收者为接受该交付的主管。当前只显示「待领取」：在主管实际读取前不声称已通知或已阅读；这不代表知悉、验收或任务完成，也不改变任务、审查与发布状态。`
          : '同一 Owner 操作重放：既有提问记录与本次引用一致，未新增第二条事实，也未改变任何状态。'
        eventType = DELIVERY_QUESTION_EVENT_TYPE; break
      }
    }
    const events = this.store.listEventsSince(kingdomId, beforeSeq, 20)
    const business = events.filter(event => event.event_type === eventType && event.actor_role === 'OWNER' && event.actor_id === record.view.ownerId
      && JSON.parse(event.payload_json).operation_id === source.operation_id)
    // 幂等提问没有新增事件：此时只核对既有事实仍指向同一条交付，不要求事件数为 1。
    if (!appendedBusinessFact && input.action === 'delivery.item.question') {
      const existing = readDeliveryQuestionThread(this.store, kingdomId, input.parameters.delivery_id)
      const matches = existing?.questions.some(question => question.itemId === input.parameters.item_id
        && question.contentHash === input.parameters.content_hash) ?? false
      if (!matches) fail('MUTATION_NOT_APPLIED', '既有提问事实与本次引用不一致，事务已回滚。')
      return { target: { type: 'delivery', id: input.parameters.delivery_id }, message }
    }
    if (business.length !== 1 || !business[0].target_id || !['kingdom', 'territory', 'binding', 'collaboration-plan', 'delivery'].includes(business[0].target_type ?? '')) {
      fail('MUTATION_NOT_APPLIED', 'Core 未产生准确业务事实，事务已回滚。')
    }
    return { target: { type: business[0].target_type as OwnerOperationReceipt['target']['type'], id: business[0].target_id }, message }
  }

  private event(kingdomId: string, ownerId: string, type: string, targetId: string, payload: Record<string, unknown>): EventRow {
    return this.store.appendEvent({ event_id: randomUUID(), kingdom_id: kingdomId, event_type: type, actor_role: 'OWNER', actor_id: ownerId,
      target_type: 'owner-decision', target_id: targetId, payload_json: JSON.stringify(payload), created_at: new Date(this.now()).toISOString() })
  }

  private receiptEventId(kingdomId: string, operationId: string): string {
    return `owner-operation-receipt:${createHash('sha256').update(`${kingdomId}\0${operationId}`).digest('hex')}`
  }
}
