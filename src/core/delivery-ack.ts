/**
 * Owner delivery-item acknowledgement (Owner 逐条知悉).
 *
 * 本模块是「交付知悉」这一治理事实的**唯一** Canonical 定义处：交付条目的稳定
 * 身份、内容版本、层级结构，以及知悉回执的持久化形状。
 *
 * ## 事实分类
 *
 * - `OWNER_DELIVERY_ITEM_ACKNOWLEDGED` 事件 = Kingdom Core Fact：Owner principal
 *   对某条交付的**某个内容版本**的一次知悉。它写在既有 events 账本里，不新增表、
 *   不做 schema 迁移。
 * - 交付条目本身 = **确定性派生**：由「本 Task/attempt 的主管 ACCEPT + 该次 Claim」
 *   推导，不落库。因此不存在需要迁移的第二套任务状态机。
 *
 * ## 边界（不得越界）
 *
 * - 知悉只记录「已知悉该条当前版本」，不表示理解、质量认可、Task DONE、
 *   正式 Owner acceptance 或发布授权。它不修改 Task、主管审查、execution 或发布状态。
 * - Claim 的 `artifacts`/`risks` 是**执行者自述文本**，永远不能升级为仓库路径或安全链接。
 *   它们只作为可读证据文本渲染。
 * - 外层摘要知悉不覆盖子条：每条各自有独立 ID 与内容版本。
 */
import { createHash } from 'node:crypto'
import type { EventRow, KingdomStore, RoleBindingRow, TaskRow, WorkerResultRow } from './db.js'
import { ownerInputHash } from './owner-control.js'
import { readAcceptedChangeEvidence, resolveChangeEvidenceForDelivery } from './delivery-change.js'
import type { CommandContext } from './task-service.js'

export const DELIVERY_ACK_EVENT_TYPE = 'OWNER_DELIVERY_ITEM_ACKNOWLEDGED'
/** 知悉回执载荷版本；形状变化时必须递增，旧记录按旧版本读取。 */
export const DELIVERY_ACK_PAYLOAD_VERSION = 'KingdomDeliveryItemAck/v1'

/**
 * 交付条目提问与回复：**两条独立**的治理事实，写在既有 events 账本里。
 *
 * 它们与「知悉」无关：提问不是知悉、不是 ACCEPT、不是 Task DONE，也不改变任何
 * Task/Claim/审查/发布状态；回复同理。二者都不触发任何自动派发、唤醒或后续动作。
 */
export const DELIVERY_QUESTION_EVENT_TYPE = 'OWNER_DELIVERY_ITEM_QUESTIONED'
export const DELIVERY_REPLY_EVENT_TYPE = 'OWNER_DELIVERY_ITEM_ANSWERED'
export const DELIVERY_QUESTION_PAYLOAD_VERSION = 'KingdomDeliveryItemQuestion/v1'
export const DELIVERY_REPLY_PAYLOAD_VERSION = 'KingdomDeliveryItemReply/v1'

/** 需要最小化投影的事件类型；通用事件投影只保留元数据，绝不带问答正文。 */
export const DELIVERY_QUESTION_EVENT_TYPES: readonly string[] = [DELIVERY_QUESTION_EVENT_TYPE, DELIVERY_REPLY_EVENT_TYPE]

/** 载荷中永远不进入公开投影的字段：正文只经受权 Owner 窗口或当前责任主管 Tool 返回。 */
const QUESTION_BODY_KEYS: readonly string[] = ['questionText', 'replyText']

/** 交付页的三层结构：成果摘要 → 模块/事项 → 证据/改动。 */
export const DELIVERY_ITEM_LAYERS = ['SUMMARY', 'MODULE', 'EVIDENCE'] as const
export type DeliveryItemLayer = (typeof DELIVERY_ITEM_LAYERS)[number]

/**
 * 条目槽位：与所属层一起构成身份的命名空间。
 *
 * `artifacts`（产物引用）与 `risks`（执行者报告的风险）同属 EVIDENCE 层。
 * 若身份只用「层 + 位置」，追加一个 artifact 会把后面所有 risk 的位置整体
 * 后移，使旧的 risk 条目 ID 被另一个 artifact 占用——既有知悉会错误地指向
 * 另一条内容。因此身份必须带槽位，各类条目在各自槽位内独立编号。
 *
 * `CHANGE` 槽位承载「主管确认的改动证据」条目；它的身份来自稳定的 entry id，
 * 而不是位置，避免主管换选改动时旧条目 ID 被挪用。
 */
export const DELIVERY_ITEM_SLOTS = ['SUMMARY', 'ARTIFACT', 'RISK', 'CHANGE'] as const
export type DeliveryItemSlot = (typeof DELIVERY_ITEM_SLOTS)[number]

/**
 * 「查看改动」可信度分类。
 *
 * - `REPO_RELATIVE_VERIFIED`：可验证的仓库相对路径 + 固定源码版本/差异。只有
 *   主管在 ACCEPT 中显式选择、且本地内容寻址证据 hash 重验通过时才成立。
 * - `NOT_LOCATABLE`：无可信来源。GUI 必须明确显示「不可定位」而不是给出链接。
 */
export const DELIVERY_CHANGE_REF_KINDS = ['REPO_RELATIVE_VERIFIED', 'NOT_LOCATABLE'] as const
export type DeliveryChangeRefKind = (typeof DELIVERY_CHANGE_REF_KINDS)[number]

/** 界面与报告共用的固定标注：这是主管确认的改动证据，不是作者证据。 */
export const CHANGE_EVIDENCE_LABEL = '主管确认的改动证据'
export const CHANGE_EVIDENCE_NOTE = '本差异来自本次 Task/attempt 窗口前后的有界本地快照，并由该领地当前 ACTIVE 主管在同一事务的 ACCEPT 中显式选择确认。它只证明这些仓库相对路径在窗口内发生变化；不证明 Git 作者身份，也不证明由哪个执行者写入。'

/** 已确认改动证据的最小可投影形状（由 `delivery-change.ts` 解析后传入）。 */
export interface DeliveryChangeEvidenceItem {
  entryId: string
  /** 仓库相对路径；公开展示、链接与内容版本都用它，不使用工作区相对路径。 */
  repoPath: string
  status: string
  note: string
}

export interface DeliveryChangeEvidenceInput {
  evidenceId: string
  attemptNo: number
  repoHead: string | null
  coverageComplete: boolean
  coverageReasons: string[]
  note: string
  entries: DeliveryChangeEvidenceItem[]
}

export interface DeliveryChangeRef {
  kind: DeliveryChangeRefKind
  /** 仅 `REPO_RELATIVE_VERIFIED` 时存在，且必须通过严格校验。 */
  repoPath: string | null
  /** 固定源码版本或差异标识；缺失即不可信。 */
  revision: string | null
  reasonCode: string | null
  note: string
  /** 已确认证据的 manifest id 与条目 id；只在可信时存在。 */
  evidenceId?: string | null
  entryId?: string | null
  /** 固定标注「主管确认的改动证据」。 */
  evidenceLabel?: string | null
  /** 部分覆盖时的诚实提示；完整覆盖为 null。 */
  coverageNote?: string | null
}

export interface DeliveryItemDetail {
  label: string
  detail: string
  sourceRef: DeliverySourceRef | null
}

export interface DeliveryItemContent {
  layer: DeliveryItemLayer
  label: string
  detail: string
  sourceRef: DeliverySourceRef | null
  change: DeliveryChangeRef
  details: DeliveryItemDetail[]
}

export interface DeliveryItem {
  /** 稳定 ID：同一交付内同一角色条目在任意重建中保持相同。 */
  itemId: string
  /** 内容版本：条目内容（含主管接受的 attempt）变化时改变。 */
  contentHash: string
  content: DeliveryItemContent
}

export interface DeliverySourceRef {
  entityType: 'worker_results' | 'tasks' | 'executions'
  entityId: string | null
}

/** Owner 知悉一次回执；只记录 principal、条目/版本与时间，不采集理由或理解程度。 */
export interface DeliveryAcknowledgement {
  deliveryId: string
  itemId: string
  contentHash: string
  ownerId: string
  acknowledgedAt: string
  eventSeq: number
  eventId: string
  /** 该次知悉写入时交付所依据的接受证据强度（历史回执为 UNKNOWN）。 */
  acceptanceEvidenceKind: DeliveryAcceptanceEvidenceKind | 'UNKNOWN'
  /** 该次知悉写入时是否 exact result-bound。 */
  acceptanceEvidenceExact: boolean
}

export type DeliveryAcknowledgementState = 'ACKNOWLEDGED' | 'PENDING' | 'PENDING_REVISION'

/**
 * 主管 ACCEPT 确认交付时**实际可核对到**的证据强度。
 *
 * - `EXACT_RESULT_BOUND`：`TASK_ACCEPTED` 同时锁定了本次 Claim 的 `reviewed_result_id`
 *   与 `reviewed_result_digest`，且两者都与当前 Claim 一致。这是新格式的强证据。
 * - `LEGACY_ATTEMPT_ONLY`：immutable v1.0.0 的合法 `TASK_ACCEPTED` 只有
 *   `reviewed_attempt_no`（以及 decision/reviewer/claimed_outcome 等真实字段），
 *   既没有 `reviewed_result_id` 也没有 `reviewed_result_digest`。Owner 2026-09-27
 *   裁决允许知悉这类历史交付，但必须标注「历史接受证据较弱」：它只按真实事件字段
 *   与**同 Task/attempt 的唯一 WorkerResult** 判定，不冒充 exact result-bound。
 * - 新格式两字段只出现其一、digest 不一致、或 JSON 形状与真实 v1.0.0 事件不符时
 *   一律拒绝（`invalid`），不会退回弱判据，也不会静默隐藏历史交付。
 */
export const DELIVERY_ACCEPTANCE_EVIDENCE_KINDS = ['EXACT_RESULT_BOUND', 'LEGACY_ATTEMPT_ONLY'] as const
export type DeliveryAcceptanceEvidenceKind = (typeof DELIVERY_ACCEPTANCE_EVIDENCE_KINDS)[number]

/** 历史（v1.0.0）接受证据的固定标注文案；工作台与 Owner 窗口共用同一措辞。 */
export const LEGACY_ACCEPTANCE_EVIDENCE_NOTE = '历史接受证据较弱：该 Task/attempt 的 TASK_ACCEPTED 是 v1.0.0 旧格式，只有尝试编号，缺少被审查结果 ID 与内容摘要；本条按真实事件字段与同 Task/attempt 的唯一 WorkerResult 判定，不构成 exact result-bound 证据。'

export interface DeliveryAcceptanceEvidence {
  attemptNo: number
  /** 被审查结果的 ID；legacy 判定下是本 Task/attempt 唯一 WorkerResult 的 ID。 */
  resultId: string
  /** true 仅当 `reviewed_result_id` 与 `reviewed_result_digest` 都与当前 Claim 一致。 */
  exactResultBound: boolean
  /** 与事件 attempt 匹配的 WorkerResult 数量；legacy 必须恰好为 1。 */
  matchingResultCount: number
}

export interface DeliveryAcceptanceClassification {
  kind: DeliveryAcceptanceEvidenceKind
  evidence: DeliveryAcceptanceEvidence
  legacyNote: string | null
}

export interface DeliveryItemAcknowledgementView {
  state: DeliveryAcknowledgementState
  /** 当前版本是否已有 Owner 知悉。 */
  acknowledged: boolean
  /** 旧版本的知悉只留历史，不覆盖当前版本。 */
  historicalCount: number
  acknowledgedAt: string | null
  acknowledgedByOwnerId: string | null
  acknowledgementEventSeq: number | null
  /**
   * 当前版本那次知悉写入时依据的接受证据强度。
   * 旧回执或尚无当前版本知悉时为 `UNKNOWN`，不猜测。
   */
  acknowledgedAcceptanceEvidenceKind: DeliveryAcceptanceEvidenceKind | 'UNKNOWN'
  /** 当前版本那次知悉写入时是否 exact result-bound。 */
  acknowledgedAcceptanceEvidenceExact: boolean
}

// ── 身份与版本（纯函数；不依赖 store，便于 GUI 侧复用同一身份）────────

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

export function digestText(value: string): string {
  return hash(value)
}

/**
 * 交付身份 = 一个 Task 的一条交付时间线。
 *
 * 刻意**不含** attempt/result：同一 Task 的后续已接受尝试是同一交付的新版本，
 * 因此条目 ID 保持稳定，旧知悉随内容版本变化自动降为历史。若是每次尝试换一个
 * 交付身份，旧知悉就无法作为「同一条目的历史」被识别。
 */
export function deliveryIdFor(taskId: string): string {
  return `delivery:${taskId}`
}

/**
 * 条目 ID 来自条目在交付结构中的**位置**（层 + 槽位 + 槽位内位置），
 * 不来自可变化的正文，因此同一逻辑条目改版后仍是同一条。新增条目会追加
 * 新 ID，旧条目 ID 不变；不同槽位（产物引用 / 风险）之间也不会互相挪用。
 */
export function deliveryItemId(deliveryId: string, layer: DeliveryItemLayer, slot: DeliveryItemSlot, position: number): string {
  return `item:${digestText(`${deliveryId}\u0000${layer}\u0000${slot}\u0000${position}`).slice(0, 32)}`
}

/**
 * 改动证据条目的身份来自稳定 entry id（= 仓库相对路径的摘要），不来自位置：
 * 主管换选或增删改动时，旧条目 ID 不会被另一条改动占用。
 */
export function deliveryChangeItemId(deliveryId: string, entryId: string): string {
  return `item:${digestText(`${deliveryId}\u0000EVIDENCE\u0000CHANGE\u0000${entryId}`).slice(0, 32)}`
}

/**
 * 内容版本 = 结构、标签、正文、证据文本与改动引用状态（含可见 note、已确认
 * 证据 id 与条目 id）的规范化摘要。
 *
 * 只在字段真实存在时把 evidenceId/entryId 纳入摘要，因此未带改动证据的既有
 * 条目版本保持不变，历史知悉不会被本次扩展误判为改版。
 */
export function deliveryContentHash(content: DeliveryItemContent): string {
  return digestText(JSON.stringify({
    v: 1,
    layer: content.layer,
    label: content.label,
    detail: content.detail,
    sourceRef: content.sourceRef ? { entityType: content.sourceRef.entityType, entityId: content.sourceRef.entityId } : null,
    change: { kind: content.change.kind, repoPath: content.change.repoPath, revision: content.change.revision, reasonCode: content.change.reasonCode, note: content.change.note,
      ...(content.change.evidenceId ? { evidenceId: content.change.evidenceId } : {}),
      ...(content.change.entryId ? { entryId: content.change.entryId } : {}) },
    details: content.details.map(detail => ({
      label: detail.label,
      detail: detail.detail,
      sourceRef: detail.sourceRef ? { entityType: detail.sourceRef.entityType, entityId: detail.sourceRef.entityId } : null,
    })),
  }))
}

/**
 * 严格校验仓库相对路径。
 *
 * 拒绝：绝对路径、Windows 盘符、UNC/网络共享、`..` 逃逸、`.git` 内部路径、控制字符、
 * 反斜杠（仓库相对路径一律使用 `/`）。任何不通过的值都不得成为链接。
 */
export function validateRepoRelativePath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const path = value.trim()
  if (!path || path.length > 512) return null
  if (/[\u0000-\u001f\u007f]/u.test(path)) return null
  if (path.includes('\\')) return null
  if (path.startsWith('/') || /^[A-Za-z]:/u.test(path) || path.startsWith('//')) return null
  if (path.startsWith('~')) return null
  const segments = path.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return null
  if (segments.some(segment => segment.toLowerCase() === '.git')) return null
  return path
}

/** 固定源码版本/差异标识：有界、无空白的 opaque 标识（含 git 的 `~`/`^` 相对写法）。 */
export function validateSourceRevision(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const revision = value.trim()
  if (!revision || revision.length > 200) return null
  // 连字符放在字符类末尾，避免 `/+-` 被解析成范围而意外放行 `~` 等 ASCII 字符。
  if (!/^[A-Za-z0-9._:@+~^/-]+$/u.test(revision)) return null
  return revision
}

/**
 * 只有「通过严格校验的仓库相对路径 + 固定版本」才构成可信改动引用。
 * 其余一切（任意 Claim 字符串、本机绝对路径、现有 `SourceRef`）都返回 null，
 * 由调用方明确渲染为不可定位。
 */
export function trustedChangeRef(repoPath: unknown, revision: unknown): { repoPath: string; revision: string } | null {
  const safePath = validateRepoRelativePath(repoPath)
  const safeRevision = validateSourceRevision(revision)
  return safePath && safeRevision ? { repoPath: safePath, revision: safeRevision } : null
}

function notLocatable(reasonCode: string): DeliveryChangeRef {
  return { kind: 'NOT_LOCATABLE', repoPath: null, revision: null, reasonCode,
    note: '本条目没有可验证的仓库相对路径与固定源码版本；不提供改动链接。执行者自述、本机绝对路径与现有 SourceRef 都不能当作安全链接。' }
}

// ── 交付确认（与工作台共用同一判据）──────────────────────────────────

export interface AcceptedDelivery {
  task: TaskRow
  claim: WorkerResultRow
}

/**
 * 只有**同一 Task/attempt 的主管 ACCEPT** 才确认交付。
 *
 * `TASK_ACCEPTED` 事件必须同时锁定本次 Claim 的 attempt、`result_id` 与内容
 * 摘要（`reviewed_result_digest`，与主管审查写入端使用同一 `ownerInputHash`）。
 * 只比对 attempt 会让一条针对同一 attempt 但另一份/已改内容的 ACCEPT 冒充确认，
 * 因此三者缺一不可。
 *
 * 这是严格的**布尔**判据：新格式必须两字段齐备并一致，两字段只出现其一即拒绝。
 * 需要区分「历史接受证据较弱」的调用方请看 {@link classifyAcceptedDelivery}。
 */
export function acceptedDelivery(store: KingdomStore, claim: WorkerResultRow | null, latestReview: EventRow | null): boolean {
  return classifyAcceptedDelivery(store, claim, latestReview) !== null
}

/**
 * immutable v1.0.0 `TASK_ACCEPTED` 的真实字段集合（除两个新格式字段外）。
 *
 * 这里刻意是**白名单**而不是「忽略未知字段」：旧格式判定要证明事件确实来自
 * v1.0.0 的既有写入端，而不是某条带了其它字段的其它形状事件。
 */
const V1_TASK_ACCEPTED_PAYLOAD_KEYS: readonly string[] = ['decision', 'reviewed_attempt_no', 'reason', 'reviewer_binding_id', 'claimed_outcome']

/**
 * v1.0.0 旧格式事件形状必须**恰好**是那五个真实字段：五个全部存在，且没有额外字段。
 *
 * 「缺字段」与「多字段」都说明这不是 v1.0.0 写入端的原始事件（该写入端恒定发出
 * 全部五个字段，见 `task-service.ts` 的 ACCEPT 分支），因此一律拒绝，不退回弱判据。
 */
function v1LegacyAcceptanceShape(payload: Record<string, unknown>): boolean {
  const keys = Object.keys(payload)
  if (keys.some(key => !V1_TASK_ACCEPTED_PAYLOAD_KEYS.includes(key))) return false
  if (keys.length !== V1_TASK_ACCEPTED_PAYLOAD_KEYS.length) return false
  if (payload.decision !== 'ACCEPT') return false
  if (!Number.isSafeInteger(payload.reviewed_attempt_no) || (payload.reviewed_attempt_no as number) < 1) return false
  if (payload.reason !== undefined && payload.reason !== null && typeof payload.reason !== 'string') return false
  if (payload.reviewer_binding_id !== undefined && payload.reviewer_binding_id !== null && typeof payload.reviewer_binding_id !== 'string') return false
  if (payload.claimed_outcome !== undefined && payload.claimed_outcome !== null && typeof payload.claimed_outcome !== 'string') return false
  return true
}

/**
 * 把一次主管 ACCEPT 判定为「exact result-bound」或「历史接受证据较弱」，或 null（拒绝）。
 *
 * 判据（任一条不成立即返回 null，不返回较弱证据）：
 * - Task 处于 `DONE`，最近一次主管裁定是 `TASK_ACCEPTED`（`readLatestReviewEvent`
 *   已限定 `actor_role = SUPERVISOR`）且 `decision = 'ACCEPT'`；
 * - `reviewed_attempt_no` 必须等于本次 Claim 的 attempt；
 * - **新格式**：`reviewed_result_id` 与 `reviewed_result_digest` 必须同时存在、均为
 *   字符串，并分别等于本次 Claim 的 `result_id` 与 `ownerInputHash(claim)`；
 * - **旧格式（v1.0.0）**：两个新格式字段必须**同时缺失**，payload 必须**恰好**由
 *   v1.0.0 的五个真实字段（decision / reviewed_attempt_no / reason /
 *   reviewer_binding_id / claimed_outcome）组成——缺一个或多一个都不是旧格式，
 *   且该 Task/attempt 恰好只有一条 WorkerResult 且就是本次 Claim。缺少这一唯一性
 *   核对时无法排除「同一 attempt 有多份结果」，因此拒绝。
 *
 * 旧格式只做上述真实字段核对，不虚构 result-bound 证据：它证明的是「该尝试的唯一
 * 已记录结果被接受」，而不是「该事件的摘要与这份内容一致」。
 */
export function classifyAcceptedDelivery(store: KingdomStore, claim: WorkerResultRow | null, latestReview: EventRow | null): DeliveryAcceptanceClassification | null {
  const task = store.getTask(claim?.task_id ?? '')
  if (!task || !claim) return null
  if (latestReview?.event_type !== 'TASK_ACCEPTED') return null
  if (task.status !== 'DONE') return null
  const payload = parseJson(latestReview.payload_json)
  if (payload.decision !== 'ACCEPT') return null
  if (payload.reviewed_attempt_no !== claim.attempt_no) return null
  if ((latestReview.target_type === null || latestReview.target_type === 'task') && latestReview.target_id !== claim.task_id) return null

  const reviewedResultId = payload.reviewed_result_id
  const reviewedResultDigest = payload.reviewed_result_digest
  const hasResultId = typeof reviewedResultId === 'string' && reviewedResultId !== ''
  const hasResultDigest = typeof reviewedResultDigest === 'string' && reviewedResultDigest !== ''
  if (hasResultId || hasResultDigest) {
    if (!hasResultId || !hasResultDigest) return null
    if (reviewedResultId !== claim.result_id) return null
    if (reviewedResultDigest !== ownerInputHash(claim)) return null
    return {
      kind: 'EXACT_RESULT_BOUND',
      evidence: { attemptNo: claim.attempt_no, resultId: claim.result_id, exactResultBound: true, matchingResultCount: 1 },
      legacyNote: null,
    }
  }

  if (!v1LegacyAcceptanceShape(payload)) return null
  const matchingResults = store.db
    .prepare('SELECT result_id FROM worker_results WHERE task_id = ? AND attempt_no = ? ORDER BY result_id ASC')
    .all(claim.task_id, claim.attempt_no) as unknown as { result_id: string }[]
  if (matchingResults.length !== 1 || matchingResults[0]!.result_id !== claim.result_id) return null
  return {
    kind: 'LEGACY_ATTEMPT_ONLY',
    evidence: { attemptNo: claim.attempt_no, resultId: claim.result_id, exactResultBound: false, matchingResultCount: matchingResults.length },
    legacyNote: LEGACY_ACCEPTANCE_EVIDENCE_NOTE,
  }
}

/** 读取某 Task 最近一次主管裁定事件（与投影窗口无关的精确读取）。 */
export function readLatestReviewEvent(store: KingdomStore, kingdomId: string, taskId: string): EventRow | null {
  return (store.db.prepare("SELECT * FROM events WHERE kingdom_id = ? AND target_type = 'task' AND target_id = ? AND actor_role = 'SUPERVISOR' AND event_type IN ('TASK_ACCEPTED', 'TASK_REWORK_REQUESTED', 'TASK_FAILED', 'TASK_HANDED_OFF') ORDER BY seq DESC LIMIT 1")
    .all(kingdomId, taskId) as unknown as EventRow[])[0] ?? null
}

// ── 条目派生 ─────────────────────────────────────────────────────────

const MAX_ITEM_TEXT = 4000
const REDACTED_PATH = '[redacted-path]'
const REDACTED_SECRET = '[REDACTED]'

/**
 * 公开呈现共用的凭据脱敏（工作台投影与 Owner 窗口都调用这里，避免两份正则漂移）。
 *
 * 这是**针对性**修复，不是通用秘密检测：只把「凭据关键字后跟一个值」整体替换为
 * 占位符，关键字与值之间允许 `=`/`:` 引号形式和空白。
 *
 * `Bearer` 之类的 scheme 后接真实令牌时必须连值一起遮住：
 * `Authorization: Bearer sk-secret` 里 `Bearer` 本身不是秘密，只遮 `Bearer`
 * 而留下 `sk-secret` 等于没有脱敏。因此先匹配「关键字 + scheme 字词 + 值」，
 * 再退回「关键字 + 值」。所有分支都以「值是行内非空白文本」收尾，不会吞掉
 * 后面的正文；scheme 只列出已知认证 scheme，不做「任意大写词」泛化匹配。
 *
 * 关键字与值之间没有 `=`/`:` 时只保留两种情况：裸 `Bearer` 后跟任意令牌，或
 * 关键字后跟一个**不是自然语言词**的值（含数字或 `_ - + / = @` 中的符号，如
 * `token opaqueFreeTextSecret99`）。`token is ready`、`secret was rotated` 这类
 * 普通交付正文因此不再被误遮；判据只看值的字符构成，不猜测它是不是秘密。
 *
 * 已知边界（刻意不修）：无关键字前缀的裸令牌、纯字母令牌（如 `token deadbeef`）、
 * 跨行值、被引号包裹的多词值都不在本模式识别范围内；本函数不声称能检测任意秘密。
 */
const CREDENTIAL_NAME = '(?:authorization|bearer|session(?:[_ .-]?id)?|principal(?:[_ .-]?id)?|private(?:[_ .-]?config)?|token|cookie|credential|secret|password|api[_ .-]?key|access[_ .-]?key|client[_ .-]?secret|connection[_ .-]?string|csrf)'
const CREDENTIAL_ASSIGNMENT = '(?:\\b\\s*["\']?\\s*(?:=|:)\\s*["\']?\\s*)'
const CREDENTIAL_VALUE = '[^\\s,;&}]+'
/** 无 `=`/`:` 时的值必须是数字或凭据常见符号构成的令牌；纯字母词按自然语言放过。 */
const CREDENTIAL_OPAQUE_VALUE = '(?=[^\\s,;&}]*[0-9_\\-/+@=])' + CREDENTIAL_VALUE
const CREDENTIAL_SCHEME = '(?:Bearer|Basic|Token|Digest|DPoP)'
const CREDENTIAL_BODY = `(?:${CREDENTIAL_NAME}${CREDENTIAL_ASSIGNMENT}${CREDENTIAL_SCHEME}\\s+${CREDENTIAL_VALUE}|${CREDENTIAL_NAME}${CREDENTIAL_ASSIGNMENT}${CREDENTIAL_VALUE}|bearer\\s+${CREDENTIAL_VALUE}|${CREDENTIAL_NAME}\\s+${CREDENTIAL_OPAQUE_VALUE})`
// 词边界必须放在捕获组之外：替换整段匹配时，组内的 `\b` 会让首个字符漏在占位符外。
export const CREDENTIAL_REDACTION_PATTERN = new RegExp(`\\b(?:${CREDENTIAL_BODY})`, 'giu')

/** 只做凭据关键字 + 完整值（含 Bearer 等 scheme）替换；调用方决定是否再做路径脱敏。 */
export function redactCredentialText(value: string): string {
  return value.replace(CREDENTIAL_REDACTION_PATTERN, '[REDACTED]')
}

/**
 * 交付文本的公开呈现脱敏。
 *
 * 沿用工作台投影既有的公开内容规则（`src/gui/snapshot.ts` 的
 * `sanitizePublicJsonString` public-content 分支）：本机绝对路径、UNC 路径与
 * 内联凭据替换为占位符。刻意只做这一件事——不做递归 JSON 遍历，也不是
 * 新的通用脱敏框架；核心派生一次脱敏，所有呈现面（Owner 窗口与工作台投影）
 * 都不会再看到原始 Claim 文本。
 */
export function redactDeliveryText(value: string): string {
  return redactCredentialText(value)
    .replace(/[A-Za-z]:[\\/][^\s<>"']*/gu, REDACTED_PATH)
    .replace(/\\\\[^\s<>"']*/gu, REDACTED_PATH)
    .replace(/(^|[\s("'=])\/[^\s<>"']*/gu, `$1${REDACTED_PATH}`)
    .replace(/\bprivate[-_][^\s<>"']+/giu, REDACTED_SECRET)
}

function bounded(value: string): string {
  const collapsed = redactDeliveryText(value).replace(/[\r\n\t]+/gu, ' ').trim()
  return collapsed.length > MAX_ITEM_TEXT ? `${collapsed.slice(0, MAX_ITEM_TEXT)}…` : collapsed
}

function summaryDetail(claim: WorkerResultRow): string {
  const payload = parseJson(claim.result_json)
  const raw = typeof payload.summary === 'string' ? payload.summary : ''
  return bounded(raw) || '执行者未提供摘要。'
}

function stringArray(value: unknown, limit: number): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').slice(0, limit) : []
}

/**
 * 从已确认的交付派生三层条目。
 *
 * 摘要层恒有 1 条（内容为执行者自述摘要）；每条 `artifacts` 与 `risks` 各派生一条
 * 证据层条目。所有条目都带独立 ID 与内容版本，外层知悉不会覆盖子条。
 *
 * 位置在每个槽位内独立编号，因此追加 artifact 不会移动既有 risk 的身份。
 *
 * `changeEvidence` 只在主管在 ACCEPT 中显式选择了改动引用、且本地内容寻址证据
 * hash 重验通过时传入。它派生的条目**不是**执行者自述，而是有界窗口观测 +
 * 主管确认；标签固定为「主管确认的改动证据」，且绝不声称 Git 证明作者身份。
 */
export function deriveDeliveryItems(taskId: string, claim: WorkerResultRow, changeEvidence?: DeliveryChangeEvidenceInput | null): DeliveryItem[] {
  const deliveryId = deliveryIdFor(taskId)
  const resultRef: DeliverySourceRef = { entityType: 'worker_results', entityId: claim.result_id }
  const payload = parseJson(claim.result_json)
  const artifacts = stringArray(payload.artifacts, 8)
  const risks = stringArray(payload.risks, 8)
  const slots: { content: DeliveryItemContent; slot: DeliveryItemSlot; position: number }[] = [
    {
      slot: 'SUMMARY',
      position: 0,
      content: {
        layer: 'SUMMARY',
        label: '成果摘要',
        detail: summaryDetail(claim),
        sourceRef: resultRef,
        change: notLocatable('DELIVERY_ITEM_IS_SUMMARY'),
        details: [],
      },
    },
    ...artifacts.map((artifact, index) => ({
      slot: 'ARTIFACT' as const,
      position: index,
      content: {
        layer: 'EVIDENCE' as const,
        label: `产物引用 ${index + 1}`,
        detail: bounded(artifact),
        sourceRef: resultRef,
        change: notLocatable('DELIVERY_EVIDENCE_TEXT_IS_WORKER_CLAIM'),
        details: [],
      },
    })),
    ...risks.map((risk, index) => ({
      slot: 'RISK' as const,
      position: index,
      content: {
        layer: 'EVIDENCE' as const,
        label: `执行者报告的风险 ${index + 1}`,
        detail: bounded(risk),
        sourceRef: resultRef,
        change: notLocatable('DELIVERY_RISK_TEXT_IS_WORKER_CLAIM'),
        details: [],
      },
    })),
  ]
  const items = slots.map(({ content, slot, position }) => ({
    itemId: deliveryItemId(deliveryId, content.layer, slot, position),
    contentHash: deliveryContentHash(content),
    content,
  }))
  for (const entry of changeEvidence?.entries ?? []) {
    const content = changeEvidenceItemContent(resultRef, changeEvidence!, entry)
    items.push({ itemId: deliveryChangeItemId(deliveryId, entry.entryId), contentHash: deliveryContentHash(content), content })
  }
  return items
}

/** 单条「主管确认的改动证据」条目的公开内容。 */
function changeEvidenceItemContent(
  resultRef: DeliverySourceRef,
  evidence: DeliveryChangeEvidenceInput,
  entry: DeliveryChangeEvidenceItem,
): DeliveryItemContent {
  const coverageNote = evidence.coverageComplete
    ? null
    : `部分覆盖：${evidence.coverageReasons.length ? evidence.coverageReasons.join('、') : '存在未采集或未判定项'}；该快照未完整覆盖全部文件。`
  const note = [CHANGE_EVIDENCE_NOTE, coverageNote].filter((value): value is string => Boolean(value)).join(' ')
  return {
    layer: 'EVIDENCE',
    label: `${CHANGE_EVIDENCE_LABEL} · ${bounded(entry.repoPath)}`,
    detail: bounded(`${entry.status} · ${entry.note}`),
    sourceRef: resultRef,
    change: {
      kind: 'REPO_RELATIVE_VERIFIED',
      repoPath: entry.repoPath,
      revision: `evidence:${evidence.evidenceId}`,
      reasonCode: 'SUPERVISOR_CONFIRMED_BOUNDED_WINDOW',
      note,
      evidenceId: evidence.evidenceId,
      entryId: entry.entryId,
      evidenceLabel: CHANGE_EVIDENCE_LABEL,
      coverageNote,
    },
    details: [],
  }
}

// ── 知悉回执读取 ─────────────────────────────────────────────────────

interface AckPayload {
  version?: unknown
  deliveryId?: unknown
  itemId?: unknown
  contentHash?: unknown
  acceptanceEvidenceKind?: unknown
  acceptanceEvidenceExact?: unknown
}

function readAck(row: EventRow): DeliveryAcknowledgement | null {
  if (row.event_type !== DELIVERY_ACK_EVENT_TYPE) return null
  if (row.actor_role !== 'OWNER' || typeof row.actor_id !== 'string' || row.actor_id === '') return null
  const payload = parseJson(row.payload_json) as AckPayload
  if (payload.version !== DELIVERY_ACK_PAYLOAD_VERSION) return null
  if (typeof payload.deliveryId !== 'string' || typeof payload.itemId !== 'string' || typeof payload.contentHash !== 'string') return null
  return {
    deliveryId: payload.deliveryId,
    itemId: payload.itemId,
    contentHash: payload.contentHash,
    ownerId: row.actor_id,
    acknowledgedAt: row.created_at,
    eventSeq: row.seq,
    eventId: row.event_id,
    // 旧回执没有这两个字段：如实读成 UNKNOWN，不猜测、也不据此拒绝历史事实。
    acceptanceEvidenceKind: DELIVERY_ACCEPTANCE_EVIDENCE_KINDS.includes(payload.acceptanceEvidenceKind as DeliveryAcceptanceEvidenceKind)
      ? payload.acceptanceEvidenceKind as DeliveryAcceptanceEvidenceKind
      : 'UNKNOWN',
    acceptanceEvidenceExact: payload.acceptanceEvidenceExact === true,
  }
}

/** 按 delivery + item 读取全部历史知悉（升序），包括旧版本。 */
export function readDeliveryAcknowledgements(store: KingdomStore, kingdomId: string, deliveryId: string): DeliveryAcknowledgement[] {
  const rows = store.db.prepare('SELECT * FROM events WHERE kingdom_id = ? AND event_type = ? AND target_type = ? AND target_id = ? ORDER BY seq ASC')
    .all(kingdomId, DELIVERY_ACK_EVENT_TYPE, 'delivery', deliveryId) as unknown as EventRow[]
  return rows.map(readAck).filter((ack): ack is DeliveryAcknowledgement => ack !== null)
}

/**
 * 汇总某交付内每条条目的当前知悉状态。
 *
 * - 当前 `contentHash` 已有知悉 → `ACKNOWLEDGED`
 * - 只有旧版本知悉 → `PENDING_REVISION`（旧知悉仅留历史）
 * - 从无知悉 → `PENDING`
 *
 * `ownerId` 是当前王国 Owner principal：知悉回执必须归属于该 principal，
 * 其他 actor 的历史事件（即使事件类型相同）都不构成 Owner 知悉。
 */
export function deliveryAcknowledgementView(
  acknowledgements: DeliveryAcknowledgement[],
  item: DeliveryItem,
  ownerId: string,
): DeliveryItemAcknowledgementView {
  const owned = acknowledgements.filter(ack => ack.ownerId === ownerId)
  const forItem = owned.filter(ack => ack.itemId === item.itemId)
  const current = forItem.find(ack => ack.contentHash === item.contentHash) ?? null
  const historical = forItem.filter(ack => ack.contentHash !== item.contentHash)
  return {
    state: current ? 'ACKNOWLEDGED' : historical.length > 0 ? 'PENDING_REVISION' : 'PENDING',
    acknowledged: current !== null,
    historicalCount: historical.length,
    acknowledgedAt: current?.acknowledgedAt ?? null,
    acknowledgedByOwnerId: current?.ownerId ?? null,
    acknowledgementEventSeq: current?.eventSeq ?? null,
    acknowledgedAcceptanceEvidenceKind: current?.acceptanceEvidenceKind ?? 'UNKNOWN',
    acknowledgedAcceptanceEvidenceExact: current?.acceptanceEvidenceExact ?? false,
  }
}

// ── 知悉写入（仅供 Core Owner Control Plane 调用）────────────────────

export class DeliveryAcknowledgementError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'DeliveryAcknowledgementError' }
}

function ackFail(code: string, message: string): never {
  throw new DeliveryAcknowledgementError(code, message)
}

/** 幂等事件 ID：同一交付条目版本的再次知悉不会写出第二条事实。 */
export function deliveryAckEventId(kingdomId: string, deliveryId: string, itemId: string, contentHash: string): string {
  return `owner-delivery-ack:${hash(`${kingdomId}\u0000${deliveryId}\u0000${itemId}\u0000${contentHash}`)}`
}

export interface RecordDeliveryAcknowledgementInput {
  kingdomId: string
  deliveryId: string
  itemId: string
  contentHash: string
  taskId: string
  attemptNo: number
  resultId: string
  ownerId: string
  ownerBindingId: string | null
  itemLabel: string
  acknowledgedAt: string
  /** 已确认的改动证据；仅在主管已选择且本地 hash 重验通过时传入，用于派生相同条目集合。 */
  changeEvidence?: DeliveryChangeEvidenceInput | null
  /**
   * Owner Control Plane 归因（source_channel / decision_id / operation_id）。
   * 与既有 `OWNER_OPERATION_APPLIED` 回执同款，便于把知悉事实回溯到具体操作。
   */
  attribution?: Record<string, unknown>
}

/**
 * 追加一条 Owner 知悉事实。
 *
 * 前置校验（任一失败即零写入）：
 * - Task 当前确实处于「主管 ACCEPT 确认交付」状态；
 * - 传入的 `deliveryId`/`itemId`/`contentHash` 与当前派生结果完全一致
 *   （防止对旧版本或伪造条目写入知悉）。
 *
 * 幂等：同一 (delivery, item, contentHash) 已有记录时原样返回，不追加事件。
 */
export function recordDeliveryAcknowledgement(store: KingdomStore, input: RecordDeliveryAcknowledgementInput): DeliveryAcknowledgement {
  if (!input.ownerId) ackFail('OWNER_CONTROL_REQUIRED', '知悉必须记录 Owner principal。')
  const eventId = deliveryAckEventId(input.kingdomId, input.deliveryId, input.itemId, input.contentHash)
  const existing = store.getEventById(eventId)
  if (existing) {
    const ack = readAck(existing)
    if (!ack) ackFail('ACK_EVENT_CONFLICT', '既有知悉记录与本次引用不一致，请重新核对。')
    return ack
  }
  const task = store.getTask(input.taskId)
  if (!task) ackFail('TASK_NOT_FOUND', '交付对应的任务不存在。')
  const claim = store.latestWorkerResult(input.taskId)
  const review = readLatestReviewEvent(store, input.kingdomId, input.taskId)
  const classification = classifyAcceptedDelivery(store, claim, review)
  if (!claim || !classification) {
    ackFail('DELIVERY_NOT_CONFIRMED', '该交付尚未由同一 Task/attempt 的主管 ACCEPT 确认，不能记录知悉。')
  }
  if (claim.attempt_no !== input.attemptNo || claim.result_id !== input.resultId) {
    ackFail('DELIVERY_VERSION_STALE', '交付的已接受版本已变化，请重新读取清单后再知悉。')
  }
  const derived = deliveryIdFor(input.taskId)
  if (derived !== input.deliveryId) ackFail('DELIVERY_VERSION_STALE', '交付标识与当前已接受版本不一致。')
  const item = deriveDeliveryItems(input.taskId, claim, input.changeEvidence).find(candidate => candidate.itemId === input.itemId)
  if (!item) ackFail('DELIVERY_ITEM_UNKNOWN', '该条目不在当前交付清单中，不能记录知悉。')
  if (item.contentHash !== input.contentHash) ackFail('DELIVERY_ITEM_VERSION_STALE', '该条目内容版本已变化，请重新读取后再知悉。')
  const row = store.appendEvent({
    event_id: eventId,
    kingdom_id: input.kingdomId,
    event_type: DELIVERY_ACK_EVENT_TYPE,
    actor_role: 'OWNER',
    actor_id: input.ownerId,
    target_type: 'delivery',
    target_id: input.deliveryId,
    payload_json: JSON.stringify({
      version: DELIVERY_ACK_PAYLOAD_VERSION,
      deliveryId: input.deliveryId,
      taskId: input.taskId,
      attemptNo: input.attemptNo,
      resultId: input.resultId,
      itemId: input.itemId,
      itemLabel: bounded(input.itemLabel),
      contentHash: input.contentHash,
      ownerId: input.ownerId,
      ownerBindingId: input.ownerBindingId,
      acknowledgedAt: input.acknowledgedAt,
      // 知悉时实际依据的接受证据强度随事实一起落账：旧格式交付的知悉也能被
      // 回溯为「历史接受证据较弱」，而不是事后与强证据混淆。
      acceptanceEvidenceKind: classification.kind,
      acceptanceEvidenceExact: classification.evidence.exactResultBound,
      meaning: 'OWNER_ACKNOWLEDGED_CURRENT_VERSION_ONLY',
      ...(input.attribution ?? {}),
    }),
    created_at: input.acknowledgedAt,
  })
  return { deliveryId: input.deliveryId, itemId: input.itemId, contentHash: input.contentHash,
    ownerId: input.ownerId, acknowledgedAt: input.acknowledgedAt, eventSeq: row.seq, eventId: row.event_id,
    acceptanceEvidenceKind: classification.kind, acceptanceEvidenceExact: classification.evidence.exactResultBound }
}

function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}

// ── 交付条目提问与回复（事实、读取与责任）────────────────────────────
//
// 这三个概念必须分开：
// - **问题**：Owner 在 canonical 管理窗口里就某个精确条目版本提交的一条提问。
// - **回复**：当时接受该交付的主管 binding 针对该 problem 作出的一条回复。
// - **可达性**：该主管此刻是否仍能回复——绑定是否仍 ACTIVE、session 是否仍是
//   当前、领地是否仍由它主理。不可达时明确说明，且**绝不**改投继任主管。
//
// 公开投影只保留元数据（见 {@link toDeliveryEventView}）：正文只经有效 Owner
// 窗口或当前责任主管的 session-bound Tool 返回。

/** 界面与报告共用的固定措辞：回复只说明主管回答了这个问题。 */
export const DELIVERY_QUESTION_NOTE = '提问与回复只是对话记录：它们不代表 Owner 知悉、质量认可、人类验收、Task DONE，也不改变任何任务、审查或发布状态。'
/** 未被主管实际读取时只能说「待领取」，不声称已通知或已阅读。 */
export const DELIVERY_QUESTION_UNCLAIMED = '待领取（尚未确认主管已读取）'

/**
 * 回复可达性。`REPLY_ACCESSIBLE` 之外的状态都不得写入回复：
 * 旧主管退任、session 更换或领地改绑时，问题保持可见但明确不可达，不会自动转给继任者。
 */
export const DELIVERY_REPLY_STATES = ['REPLY_ACCESSIBLE', 'REVIEWER_BINDING_MISSING', 'REVIEWER_BINDING_RETIRED', 'REVIEWER_SESSION_CHANGED', 'SUPERVISOR_REBOUND'] as const
export type DeliveryReplyState = (typeof DELIVERY_REPLY_STATES)[number]

/**
 * 一条问题相对**当前交付目录**的版本关系。
 *
 * - `CURRENT`：该条目此刻重新派生出的版本与问题冻结版本一致（已验证当前）。
 * - `HISTORICAL`：该条目仍可派生，但版本已变化（可确认的旧版本）。
 * - `UNVERIFIABLE`：该条目此刻无法从当前 ACCEPT/证据重新派生（例如 CHANGE 证据
 *   丢失或被替换）；既不能当成当前版，也不能断言它是旧版。后两者都不计当前待办、
 *   不可回复，但仍可读。
 */
export const DELIVERY_ITEM_VERSION_STATES = ['CURRENT', 'HISTORICAL', 'UNVERIFIABLE'] as const
export type DeliveryItemVersionState = (typeof DELIVERY_ITEM_VERSION_STATES)[number]

/** 版本关系判据：只有精确命中当前派生版本才算当前；派生失败一律 fail-as-unknown。 */
export function classifyDeliveryItemVersion(currentItemContentHash: string | null, questionContentHash: string): DeliveryItemVersionState {
  if (currentItemContentHash === null) return 'UNVERIFIABLE'
  return currentItemContentHash === questionContentHash ? 'CURRENT' : 'HISTORICAL'
}

export interface DeliveryQuestion {
  questionId: string
  deliveryId: string
  taskId: string
  itemId: string
  itemLabel: string
  contentHash: string
  attemptNo: number
  resultId: string
  /** `TASK_ACCEPTED` 事件所记的主管 binding；这是首版唯一合法的接收者。 */
  reviewerBindingId: string
  /** ACCEPT 证据强度与 exact result-bound（问题写入时冻结）。 */
  acceptanceEvidenceKind: DeliveryAcceptanceEvidenceKind | 'UNKNOWN'
  acceptanceEvidenceExact: boolean
  ownerId: string
  ownerBindingId: string | null
  /**
   * 写入这条问题的 prepared Owner operation；旧记录为 null。
   *
   * 它与事件 ID 互为核对：同一 operation 重放必须命中同一 ID，不同 operation
   * 不得因正文相同而被判为同一条问题。
   */
  operationId: string | null
  /** 已脱敏的问题正文；只经 Owner 授权窗口或责任主管 Tool 返回。 */
  questionText: string
  askedAt: string
  eventId: string
  eventSeq: number
  reply: DeliveryQuestionReply | null
  replyState: DeliveryReplyState
  /** 领地主理当前指向的 Supervisor binding；未指派或不存在时为 null。 */
  currentSupervisorBindingId: string | null
  /**
   * 这条问题相对**当前交付目录**的版本关系：已验证当前、可确认的旧版本，或无法重验。
   *
   * 逐条按该条目当前重新派生出的 `contentHash` 判定：后两者仍可读、仍保留原文与回复，
   * 但**不计当前待办**，界面也不得声称「当前可回复」。这不是可写状态，只是当前交付
   * 目录与问题冻结版本之间的比较结果。
   */
  itemVersion: DeliveryItemVersionState
  /** 该条目此刻重新派生出的内容版本；无法派生时为 null，此时不声称任何版本关系。 */
  currentItemContentHash: string | null
}

export interface DeliveryQuestionReply {
  questionId: string
  responderBindingId: string
  /** 已脱敏的回复正文。 */
  replyText: string
  repliedAt: string
  eventId: string
  eventSeq: number
}

/** 某交付条目的问答线程（Owner 窗口与工作台元数据共用入口）。 */
export interface DeliveryItemQuestionThread {
  deliveryId: string
  taskId: string
  itemId: string
  itemLabel: string
  /** 目标条目在本次读取中使用的当前内容版本；无法重验时为 null。 */
  contentHash: string | null
  questions: DeliveryQuestion[]
  answeredCount: number
  /** 已验证当前内容版本且尚无回复的条数；历史版与无法重验的未答问题都不计入。 */
  pendingCount: number
  /** 属于可确认的旧内容版本、仅留历史的条数。 */
  historyCount: number
  /** 当前交付目录无法重验该条目版本、因此不声称任何版本关系的条数。 */
  unverifiableCount: number
  /** 最近一条**当前版本**问题；没有当前版本问题时为 null。 */
  currentQuestionId: string | null
  /** 最近一条当前版本问题的内容版本；没有当前版本问题时为 null。 */
  currentContentHash: string | null
}

interface QuestionPayload {
  version?: unknown
  questionId?: unknown
  deliveryId?: unknown
  taskId?: unknown
  itemId?: unknown
  itemLabel?: unknown
  contentHash?: unknown
  attemptNo?: unknown
  resultId?: unknown
  reviewerBindingId?: unknown
  acceptanceEvidenceKind?: unknown
  acceptanceEvidenceExact?: unknown
  ownerId?: unknown
  ownerBindingId?: unknown
  operationId?: unknown
  questionText?: unknown
  askedAt?: unknown
}

interface ReplyPayload {
  version?: unknown
  questionId?: unknown
  responderBindingId?: unknown
  replyText?: unknown
  repliedAt?: unknown
}

function readQuestionRow(row: EventRow): Omit<DeliveryQuestion, 'reply' | 'replyState' | 'currentSupervisorBindingId' | 'itemVersion' | 'currentItemContentHash'> | null {
  if (row.event_type !== DELIVERY_QUESTION_EVENT_TYPE || row.actor_role !== 'OWNER') return null
  const payload = parseJson(row.payload_json) as QuestionPayload
  if (payload.version !== DELIVERY_QUESTION_PAYLOAD_VERSION) return null
  const questionId = payload.questionId
  if (typeof questionId !== 'string' || !DELIVERY_QUESTION_ID.test(questionId)) return null
  const fields = { deliveryId: payload.deliveryId, taskId: payload.taskId, itemId: payload.itemId, contentHash: payload.contentHash,
    resultId: payload.resultId, reviewerBindingId: payload.reviewerBindingId }
  for (const value of Object.values(fields)) if (typeof value !== 'string' || value === '') return null
  if (typeof payload.questionText !== 'string' || !payload.questionText) return null
  if (typeof payload.askedAt !== 'string' || payload.askedAt === '') return null
  return {
    questionId,
    deliveryId: payload.deliveryId as string,
    taskId: payload.taskId as string,
    itemId: payload.itemId as string,
    itemLabel: typeof payload.itemLabel === 'string' ? payload.itemLabel : '',
    contentHash: payload.contentHash as string,
    attemptNo: Number.isSafeInteger(payload.attemptNo) ? payload.attemptNo as number : 0,
    resultId: payload.resultId as string,
    reviewerBindingId: payload.reviewerBindingId as string,
    acceptanceEvidenceKind: DELIVERY_ACCEPTANCE_EVIDENCE_KINDS.includes(payload.acceptanceEvidenceKind as DeliveryAcceptanceEvidenceKind)
      ? payload.acceptanceEvidenceKind as DeliveryAcceptanceEvidenceKind : 'UNKNOWN',
    acceptanceEvidenceExact: payload.acceptanceEvidenceExact === true,
    ownerId: typeof payload.ownerId === 'string' ? payload.ownerId : row.actor_id ?? '',
    ownerBindingId: typeof payload.ownerBindingId === 'string' ? payload.ownerBindingId : null,
    operationId: typeof payload.operationId === 'string' && payload.operationId ? payload.operationId : null,
    questionText: payload.questionText,
    askedAt: payload.askedAt,
    eventId: row.event_id,
    eventSeq: row.seq,
  }
}

function readReplyRow(row: EventRow): DeliveryQuestionReply | null {
  if (row.event_type !== DELIVERY_REPLY_EVENT_TYPE || row.actor_role !== 'SUPERVISOR') return null
  const payload = parseJson(row.payload_json) as ReplyPayload
  if (payload.version !== DELIVERY_REPLY_PAYLOAD_VERSION) return null
  const questionId = payload.questionId
  if (typeof questionId !== 'string' || !DELIVERY_QUESTION_ID.test(questionId)) return null
  if (typeof payload.responderBindingId !== 'string' || !payload.responderBindingId) return null
  if (typeof payload.replyText !== 'string' || !payload.replyText) return null
  if (typeof payload.repliedAt !== 'string' || !payload.repliedAt) return null
  return { questionId, responderBindingId: payload.responderBindingId, replyText: payload.replyText,
    repliedAt: payload.repliedAt, eventId: row.event_id, eventSeq: row.seq }
}

/**
 * 问题事实 ID：**以一次 prepared Owner operation 为界**，不以正文去重。
 *
 * 同一 prepared operation 重试（含 submit 重放）由调用方传入同一 operationId，
 * 因此得到同一事件 ID，只写一条事实；两个**不同** operation 即使针对同一条目、
 * 同一内容版本、输入完全相同的文字，也各自形成独立问题——提问身份属于一次 Owner
 * 操作，不属于那段文本。
 *
 * 旧记录（冻结时尚未携带 operationId）用写入时冻结的 questionId/contentHash/正文
 * 派生，保证同一历史问题在任何重放中仍是同一身份。
 */
export function deliveryQuestionEventId(input: {
  kingdomId: string
  deliveryId: string
  itemId: string
  contentHash: string
  operationId?: string | null
  questionId?: string | null
  questionText?: string | null
}): string {
  const scope = `${input.kingdomId}\u0000${input.deliveryId}\u0000${input.itemId}\u0000${input.contentHash}`
  const identity = input.operationId
    ? `operation\u0000${input.operationId}`
    : `question\u0000${input.questionId ?? ''}\u0000${input.questionText ?? ''}`
  return `owner-delivery-question:${hash(`${scope}\u0000${identity}`)}`
}

/**
 * 幂等回复 ID：**只由 question ID 决定**，与正文无关。
 *
 * 一个问题因此至多存在一条回复事实行；同一文本重试回原事实，不同文本在同一
 * `BEGIN IMMEDIATE` 事务里看到既有回复行并明确冲突。事件 ID 不含正文，两个并发
 * 连接不可能各自写出「不同 ID 的双事实」。
 */
export function deliveryReplyEventId(kingdomId: string, questionId: string): string {
  return `owner-delivery-reply:${hash(`${kingdomId}\u0000${questionId}`)}`
}

/**
 * 读取一条已确认交付的**全部**提问与回复。**只按精确引用的既有事件行读取**，不依赖
 * 任何有界的最近事件投影：账本里没有记录的问题就不存在。
 *
 * 返回的线程按**问题自身**的 item/contentHash 归类，不用首问代表整条交付：
 * `itemId`/`itemLabel`/`contentHash` 只描述最早那条问题所属的条目，调用方必须用
 * {@link deliveryQuestionThreadForItem} 按目标条目过滤。
 */
export function readDeliveryQuestionThread(store: KingdomStore, kingdomId: string, deliveryId: string): DeliveryItemQuestionThread | null {
  const questions = store.db.prepare('SELECT * FROM events WHERE kingdom_id = ? AND event_type = ? AND target_type = ? AND target_id = ? ORDER BY seq ASC')
    .all(kingdomId, DELIVERY_QUESTION_EVENT_TYPE, 'delivery', deliveryId) as unknown as EventRow[]
  const replies = store.db.prepare('SELECT * FROM events WHERE kingdom_id = ? AND event_type = ? AND target_type = ? AND target_id = ? ORDER BY seq ASC')
    .all(kingdomId, DELIVERY_REPLY_EVENT_TYPE, 'delivery', deliveryId) as unknown as EventRow[]
  const replyByQuestion = new Map<string, DeliveryQuestionReply>()
  for (const row of replies) {
    const reply = readReplyRow(row)
    if (reply && !replyByQuestion.has(reply.questionId)) replyByQuestion.set(reply.questionId, reply)
  }
  const parsed = questions.map(readQuestionRow).filter((question): question is NonNullable<typeof question> => question !== null)
  if (!parsed.length) return null
  const taskId = parsed[0]!.taskId
  const territory = store.getTerritoryById(store.getTask(taskId)?.territory_id ?? '')
  const currentSupervisorBindingId = territory?.supervisor_binding_id ?? null
  // 当前内容版本逐 Task 重算一次，而不是用「最早那条问题」代表整条交付：同一条目的
  // 每条问题据此标明当前版/历史版，旧版仍可读但不再冒充当前可回复的待办。
  const currentVersions = currentItemContentHashes(store, kingdomId, [...new Set(parsed.map(question => question.taskId))])
  const threadQuestions: DeliveryQuestion[] = parsed.map(question => {
    const reply = replyByQuestion.get(question.questionId) ?? null
    const currentItemContentHash = currentVersions.get(question.taskId)?.get(question.itemId) ?? null
    return { ...question, reply, currentSupervisorBindingId,
      itemVersion: classifyDeliveryItemVersion(currentItemContentHash, question.contentHash),
      currentItemContentHash,
      replyState: classifyDeliveryReplyAccess(store, kingdomId, question.reviewerBindingId, currentSupervisorBindingId).state }
  })
  const latestCurrent = [...threadQuestions].reverse().find(question => question.itemVersion === 'CURRENT') ?? null
  return {
    deliveryId,
    taskId,
    itemId: threadQuestions[0]!.itemId,
    itemLabel: threadQuestions[0]!.itemLabel,
    contentHash: threadQuestions[0]!.contentHash,
    questions: threadQuestions,
    answeredCount: threadQuestions.filter(question => question.reply !== null).length,
    // 待领取决不把旧版或无法重验的未答问题算成当前待办：只有「已验证当前版本且尚无回复」才计入。
    pendingCount: threadQuestions.filter(question => question.reply === null && question.itemVersion === 'CURRENT').length,
    historyCount: threadQuestions.filter(question => question.itemVersion === 'HISTORICAL').length,
    unverifiableCount: threadQuestions.filter(question => question.itemVersion === 'UNVERIFIABLE').length,
    currentQuestionId: latestCurrent?.questionId ?? null,
    currentContentHash: latestCurrent?.contentHash ?? null,
  }
}
/**
 * 一个**已有提问记录**的精确条目（Owner 只读问答历史入口用；不含任何正文）。
 *
 * 它只从权威账本里的提问事实派生，因此条目即使已离开当前交付目录（例如 CHANGE
 * 证据丢失、条目已改版消失）也仍然可发现；是否可读仍由调用方按窗口 scope 与动作判定。
 */
export interface DeliveryQuestionHistoryTarget {
  deliveryId: string
  taskId: string
  itemId: string
  itemLabel: string
  questionCount: number
  /** 已验证当前版本且尚无回复的条数；历史版与无法重验的都不计入。 */
  pendingCount: number
  answeredCount: number
  historyCount: number
  unverifiableCount: number
  lastAskedAt: string
  /** 最近一条问题相对当前派生版本的版本关系。 */
  latestItemVersion: DeliveryItemVersionState
  /** 该条目此刻重新派生出的内容版本；无法派生时为 null。 */
  currentContentHash: string | null
}

/**
 * 列出本王国**已有提问记录**的精确条目索引（按最近提问时间倒序）。
 *
 * 只查既有提问事件账本，不依赖任何有界的最近事件投影或当前交付目录：这正是
 * 「旧问答仍可发现」的最小入口。正文与回复正文不在这里返回，调用方仍须按窗口
 * scope 过滤后展示，且这些条目**不能**被当作新提问目标（prepare 另有精确重验）。
 */
export function listDeliveryQuestionHistory(store: KingdomStore, kingdomId: string): DeliveryQuestionHistoryTarget[] {
  const rows = store.db.prepare('SELECT DISTINCT target_id FROM events WHERE kingdom_id = ? AND event_type = ? AND target_type = ?')
    .all(kingdomId, DELIVERY_QUESTION_EVENT_TYPE, 'delivery') as unknown as { target_id: string }[]
  const targets: DeliveryQuestionHistoryTarget[] = []
  for (const row of rows) {
    const thread = readDeliveryQuestionThread(store, kingdomId, row.target_id)
    if (!thread) continue
    const byItem = new Map<string, DeliveryQuestion[]>()
    for (const question of thread.questions) {
      const bucket = byItem.get(question.itemId)
      if (bucket) bucket.push(question)
      else byItem.set(question.itemId, [question])
    }
    for (const [itemId, questions] of byItem) {
      const latest = questions[questions.length - 1]!
      targets.push({
        deliveryId: thread.deliveryId, taskId: latest.taskId, itemId, itemLabel: latest.itemLabel,
        questionCount: questions.length,
        pendingCount: questions.filter(question => question.reply === null && question.itemVersion === 'CURRENT').length,
        answeredCount: questions.filter(question => question.reply !== null).length,
        historyCount: questions.filter(question => question.itemVersion === 'HISTORICAL').length,
        unverifiableCount: questions.filter(question => question.itemVersion === 'UNVERIFIABLE').length,
        lastAskedAt: latest.askedAt,
        latestItemVersion: latest.itemVersion,
        currentContentHash: latest.currentItemContentHash,
      })
    }
  }
  targets.sort((a, b) => b.lastAskedAt.localeCompare(a.lastAskedAt)
    || a.taskId.localeCompare(b.taskId) || a.itemId.localeCompare(b.itemId))
  return targets
}

/**
 * 一个 Task 此刻重新派生出的交付条目。
 *
 * 优先用「同一 Task/attempt 的主管 ACCEPT 确认交付 + 该 ACCEPT 绑定的改动证据」；
 * 尚未确认的新尝试（例如刚写入、还在 REVIEW 的 WorkerResult）也按其自述重新派生，
 * 这样已经改版却尚未被接受的旧问题不会继续冒充当前版本。无法派生（没有
 * WorkerResult）时返回 null，调用方据此不声称任何版本关系（fail-as-unknown，
 * 而不是把旧版当当前版）。
 */
function derivedDeliveryItemsForTask(store: KingdomStore, kingdomId: string, taskId: string): ReturnType<typeof deriveDeliveryItems> | null {
  const claim = store.latestWorkerResult(taskId)
  if (!claim) return null
  const review = readLatestReviewEvent(store, kingdomId, taskId)
  const accepted = classifyAcceptedDelivery(store, claim, review) !== null
  const ref = accepted ? readAcceptedChangeEvidence(review) : null
  const evidence = ref ? resolveChangeEvidenceForDelivery(undefined, ref) : null
  return deriveDeliveryItems(taskId, claim, evidence)
}

/**
 * 一个**精确条目**此刻重新派生出的版本（itemId、contentHash 与当前标签）。
 *
 * Owner 的精确 task/item 回读必须用它做版本真值，**不能**用有界展示目录：展示目录
 * 为了界面规模会截断较旧条目，但那些条目依然是可以精确重验的当前版本。返回 null
 * 表示该条目此刻无法从当前 ACCEPT/证据重新派生。
 */
export function readDeliveryItemVersion(store: KingdomStore, kingdomId: string, taskId: string, itemId: string):
{ itemId: string; contentHash: string; label: string } | null {
  const item = derivedDeliveryItemsForTask(store, kingdomId, taskId)?.find(candidate => candidate.itemId === itemId)
  return item ? { itemId: item.itemId, contentHash: item.contentHash, label: item.content.label } : null
}

/**
 * 每个 Task 各条目**当前重新派生**出的内容版本（itemId → contentHash）。
 *
 * 逐 Task 从真实 Claim/ACCEPT/证据重算，不受任何目录上限影响；无法派生的 Task
 * 整体缺席，调用方据此不声称任何版本关系。
 */
function currentItemContentHashes(store: KingdomStore, kingdomId: string, taskIds: readonly string[]): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>()
  for (const taskId of taskIds) {
    const items = derivedDeliveryItemsForTask(store, kingdomId, taskId)
    if (!items) continue
    result.set(taskId, new Map(items.map(item => [item.itemId, item.contentHash])))
  }
  return result
}

/** 在调用方给定的精确内容版本下重新标注已验证当前/历史版/无法重验与计数。 */
function markThreadVersions(thread: DeliveryItemQuestionThread, questions: DeliveryQuestion[],
  currentContentHash: string | null, itemLabel: string): DeliveryItemQuestionThread {
  const entries = questions.map(question => ({ ...question,
    itemVersion: classifyDeliveryItemVersion(currentContentHash, question.contentHash),
    currentItemContentHash: currentContentHash }))
  const latestCurrent = [...entries].reverse().find(question => question.itemVersion === 'CURRENT') ?? null
  return { ...thread,
    questions: entries,
    answeredCount: entries.filter(question => question.reply !== null).length,
    pendingCount: entries.filter(question => question.reply === null && question.itemVersion === 'CURRENT').length,
    historyCount: entries.filter(question => question.itemVersion === 'HISTORICAL').length,
    unverifiableCount: entries.filter(question => question.itemVersion === 'UNVERIFIABLE').length,
    currentQuestionId: latestCurrent?.questionId ?? null }
}

/**
 * 过滤出**某一交付条目**的问答线程。
 *
 * 按每条问题自己的 `itemId` 归类，再按调用方给出的精确 `contentHash` 区分已验证当前、
 * 历史版与无法重验；不以整条交付的首问代表其他条目。`contentHash` 为 null 表示当前
 * 交付目录无法重验该条目，此时所有问题都标为无法重验而不是当前版。条目下没有任何
 * 提问时返回 null，调用方据此说明「该条还没有提问记录」，而不是给出空线程或另一条的线程。
 */
export function deliveryQuestionThreadForItem(thread: DeliveryItemQuestionThread | null, itemId: string, contentHash: string | null): DeliveryItemQuestionThread | null {
  if (!thread) return null
  const questions = thread.questions.filter(question => question.itemId === itemId)
  if (!questions.length) return null
  const latest = questions[questions.length - 1]!
  const marked = markThreadVersions(thread, questions, contentHash, latest.itemLabel)
  return { ...marked, itemId, itemLabel: latest.itemLabel, contentHash }
}

/**
 * 回复可达性判据。
 *
 * 首版接收者是 `TASK_ACCEPTED` 所记的主管 binding（问题写入时冻结）。这里先看该
 * binding 自身：不存在 → `REVIEWER_BINDING_MISSING`；已退任 → `REVIEWER_BINDING_RETIRED`；
 * 领地当前主理已不是它 → `SUPERVISOR_REBOUND`；没有可用于回复的 session →
 * `REVIEWER_SESSION_CHANGED`。只有全部成立才是 `REPLY_ACCESSIBLE`，否则 fail-closed。
 *
 * `claimedSessionId` 是调用方**实际用来证明身份**的 session：它与 binding 当前
 * session 不一致（即主管已换 session）时同样不可达，避免旧 session 的调用者被误判为
 * 当前责任主管。
 */
export function classifyDeliveryReplyAccess(store: KingdomStore, kingdomId: string, reviewerBindingId: string, currentSupervisorBindingId: string | null, claimedSessionId?: string | null): { state: DeliveryReplyState; detail: string } {
  const binding = store.getBindingById(reviewerBindingId)
  if (!binding || binding.kingdom_id !== kingdomId || binding.role_type !== 'SUPERVISOR') {
    return { state: 'REVIEWER_BINDING_MISSING', detail: '接受该交付时记录的主管绑定已不存在或不是主管，本条提问不可达；不会改投继任主管。' }
  }
  if (binding.status !== 'ACTIVE') {
    return { state: 'REVIEWER_BINDING_RETIRED', detail: '接受该交付的主管已退任，本条提问不可达；不会改投继任主管。' }
  }
  if (!currentSupervisorBindingId || currentSupervisorBindingId !== reviewerBindingId) {
    return { state: 'SUPERVISOR_REBOUND', detail: '该领地已改由其他主管主理，本条提问仍归原接受主管，不可达；不会自动改投继任者。' }
  }
  if (!binding.session_id || (claimedSessionId !== undefined && claimedSessionId !== binding.session_id)) {
    return { state: 'REVIEWER_SESSION_CHANGED', detail: '该主管当前没有可用于回复的 ACTIVE session（或其 session 已更换），本条提问暂不可达。' }
  }
  return { state: 'REPLY_ACCESSIBLE', detail: '该主管仍是本领地主理且持有 ACTIVE session，可读取并回复本条提问。' }
}

/** 公开事件投影的最大字段集：问答正文永不出现。 */
export function toDeliveryQuestionEventPayload(row: EventRow): Record<string, unknown> {
  const payload = parseJson(row.payload_json)
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) result[key] = QUESTION_BODY_KEYS.includes(key) ? '[redacted]' : value
  return result
}

// ── 提问写入（仅供 Core Owner Control Plane 调用）────────────────────

export class DeliveryQuestionError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'DeliveryQuestionError' }
}

function questionFail(code: string, message: string): never {
  throw new DeliveryQuestionError(code, message)
}

const DELIVERY_QUESTION_ID = /^question:[0-9a-f]{32}$/u
export const DELIVERY_QUESTION_TEXT_LIMIT = 2000
export const DELIVERY_REPLY_TEXT_LIMIT = 4000

/**
 * 提问/回复正文的写入形状：先做与公开呈现同一套凭据与路径脱敏，再折叠空白并限长。
 *
 * 事实里因此永远不保存未脱敏正文；投影端即使错误地透传字段，也不会带出凭据或本机路径。
 */
export function boundedQuestionText(value: string, limit: number): string {
  const collapsed = redactDeliveryText(value).replace(/[\s]+/gu, ' ').trim()
  return collapsed.length > limit ? collapsed.slice(0, limit) : collapsed
}

export interface RecordDeliveryQuestionInput {
  kingdomId: string
  deliveryId: string
  taskId: string
  itemId: string
  itemLabel: string
  contentHash: string
  attemptNo: number
  resultId: string
  ownerId: string
  ownerBindingId: string | null
  /** 写入这条问题的 prepared Owner operation；同一 operation 重放必须幂等。 */
  operationId: string
  questionText: string
  askedAt: string
  /** 已确认的改动证据；与知悉同一来源，保证 CHANGE 条目的清单可重算。 */
  changeEvidence?: DeliveryChangeEvidenceInput | null
  attribution?: Record<string, unknown>
}

/**
 * 追加一条 Owner 提问事实。
 *
 * 前置校验（任一失败即零写入）：
 * - Task 当前确实处于「同一 Task/attempt 的主管 ACCEPT 确认交付」状态；
 * - 传入的 delivery/item/contentHash/attempt/result 与当前派生结果完全一致；
 * - `itemId` 必须正好指向一条提问槽位：入口每次只提交一条精确条目。
 *
 * 幂等：同一 `operationId`（即同一次 prepared operation 的重试与重放）已有记录时
 * 原样返回；**不同 operation 即使问题文字相同，也各自是一条独立问题事实**。
 */
export function recordDeliveryQuestion(store: KingdomStore, input: RecordDeliveryQuestionInput): { questionId: string; askedAt: string; eventId: string; eventSeq: number; created: boolean } {
  if (!input.ownerId) questionFail('OWNER_CONTROL_REQUIRED', '提问必须记录 Owner principal。')
  const operationId = boundedQuestionText(input.operationId, 200)
  if (!operationId) questionFail('INVALID_INPUT', '提问必须记录产生它的 Owner 操作编号。')
  const text = boundedQuestionText(input.questionText, DELIVERY_QUESTION_TEXT_LIMIT)
  if (!text) questionFail('INVALID_INPUT', '问题文本必须是非空、长度受限的文本。')
  const task = store.getTask(input.taskId)
  if (!task) questionFail('TASK_NOT_FOUND', '提问对应的任务不存在。')
  const claim = store.latestWorkerResult(input.taskId)
  const review = readLatestReviewEvent(store, input.kingdomId, input.taskId)
  const classification = classifyAcceptedDelivery(store, claim, review)
  if (!claim || !classification) questionFail('DELIVERY_NOT_CONFIRMED', '该交付尚未由同一 Task/attempt 的主管 ACCEPT 确认，不能提问。')
  if (claim.attempt_no !== input.attemptNo || claim.result_id !== input.resultId) {
    questionFail('DELIVERY_VERSION_STALE', '交付的已接受版本已变化，请重新读取清单后再提问。')
  }
  const deliveryId = deliveryIdFor(input.taskId)
  if (deliveryId !== input.deliveryId) questionFail('DELIVERY_VERSION_STALE', '交付标识与当前已接受版本不一致。')
  // CHANGE 条目只由「主管在 ACCEPT 中显式选择、且本地 hash 重验通过」的改动证据派生；
  // 与 Owner 目录、预览和知悉使用同一份证据，重建出的 itemId/contentHash 才可能一致。
  const item = deriveDeliveryItems(input.taskId, claim, input.changeEvidence).find(candidate => candidate.itemId === input.itemId)
  if (!item) questionFail('DELIVERY_ITEM_UNKNOWN', '该条目不在当前交付清单中，不能提问。')
  if (item.contentHash !== input.contentHash) questionFail('DELIVERY_ITEM_VERSION_STALE', '该条目内容版本已变化，请重新读取后再提问。')
  const reviewerBindingId = deliveryReviewerBindingId(review)
  if (!reviewerBindingId) questionFail('DELIVERY_ACCEPT_REVIEWER_UNKNOWN', '接受事件没有记录主管绑定，无法确定本问题的接收者。')
  const eventId = deliveryQuestionEventId({ kingdomId: input.kingdomId, deliveryId: input.deliveryId, itemId: input.itemId,
    contentHash: input.contentHash, operationId })
  const existing = store.getEventById(eventId)
  if (existing) {
    const question = readQuestionRow(existing)
    if (!question) questionFail('QUESTION_EVENT_CONFLICT', '既有提问记录与本次引用不一致，请重新核对。')
    // 同一 operation 只对应一条事实：内容必须与本次提交完全一致，否则是重放冲突。
    if (question.itemId !== input.itemId || question.contentHash !== input.contentHash || question.questionText !== text) {
      questionFail('QUESTION_EVENT_CONFLICT', '该操作编号已记录了另一条提问，拒绝改写既有事实。')
    }
    return { questionId: question.questionId, askedAt: question.askedAt, eventId: existing.event_id, eventSeq: existing.seq, created: false }
  }
  const questionId = `question:${hash(`${eventId}\u0000${reviewerBindingId}`).slice(0, 32)}`
  const row = store.appendEvent({
    event_id: eventId,
    kingdom_id: input.kingdomId,
    event_type: DELIVERY_QUESTION_EVENT_TYPE,
    actor_role: 'OWNER',
    actor_id: input.ownerId,
    target_type: 'delivery',
    target_id: input.deliveryId,
    payload_json: JSON.stringify({
      version: DELIVERY_QUESTION_PAYLOAD_VERSION,
      questionId,
      deliveryId: input.deliveryId,
      taskId: input.taskId,
      itemId: input.itemId,
      itemLabel: bounded(input.itemLabel),
      contentHash: input.contentHash,
      attemptNo: input.attemptNo,
      resultId: input.resultId,
      // 首版接收者固定为 ACCEPT 事件所记主管：事实里冻结，事后改绑也无法改投。
      reviewerBindingId,
      acceptanceEvidenceKind: classification.kind,
      acceptanceEvidenceExact: classification.evidence.exactResultBound,
      ownerId: input.ownerId,
      ownerBindingId: input.ownerBindingId,
      // 提问身份属于产生它的那次 Owner 操作，而不是那段文本。
      operationId,
      questionText: text,
      askedAt: input.askedAt,
      meaning: 'OWNER_QUESTION_FOR_ACCEPTING_SUPERVISOR_ONLY',
      ...(input.attribution ?? {}),
    }),
    created_at: input.askedAt,
  })
  return { questionId, askedAt: input.askedAt, eventId: row.event_id, eventSeq: row.seq, created: true }
}

/** 回复写入结果：`created=false` 表示同一回复文本已存在，未新增事实。 */
export interface RecordDeliveryReplyResult {
  questionId: string
  reply: DeliveryQuestionReply
  created: boolean
}

/**
 * 追加一条主管回复事实。
 *
 * 写入门槛（任一失败即零写入）：
 * - 问题必须存在于账本里，且属于本王国、本条交付；
 * - 传入 item/contentHash/attempt/result 必须与问题记录完全一致，同时仍等于当前
 *   已确认交付的派生结果（条目改版后不得回复到旧版本）；
 * - 回复者必须**正好**是问题记录的主管 binding，且该 binding 此刻仍 ACTIVE、仍是
 *   领地当前主理、其 session 仍是调用者用来证明身份的那个 session；
 * - CHANGE 条目必须按**当前 ACCEPT 引用**在同一写锁内重新读取并重验证据：证据漂移、
 *   被替换或条目改版时不再派生该条目，回复 fail-closed。
 *
 * 锁前入口校验（`replyToDeliveryQuestion`）只用于尽早拒绝与给出可读原因，**不是**
 * 写入授权：上面这些可变授权事实全部在 `BEGIN IMMEDIATE` 取得写锁之后重新读取。
 * 否则「A 先通过入口校验 → B 退任/改绑并提交 → A 再取锁写回复」会写出已失效的回复。
 * 幂等重试仍在锁内最先判定：既有回复行 + 同一文本原样返回，不因随后改绑而报错，
 * 也不会新增第二条事实。
 *
 * 一问最多一个当前回复，且**只由 question ID 决定回复事件 ID**：同一问题在任何
 * 并发连接上都只可能写出一条回复事实行。同一文本重试幂等；不同文本明确拒绝。
 * 「重验 + 单次写入」整体在 `store.withImmediateTransaction` 的 `BEGIN IMMEDIATE`
 * 事务内完成：该包装在取得写锁之前不执行回调，BEGIN 因 BUSY/LOCKED/I-O/MISUSE
 * 失败时原样抛出且**零回复写入**，绝不把 BEGIN 失败当作「已有外层事务」继续。
 * 两个并发连接因此被 SQLite 串行化，不会各自看到空回复而写出双事实。
 */
export function recordDeliveryReply(store: KingdomStore, input: {
  kingdomId: string
  questionId: string
  responderBindingId: string
  /**
   * 调用者用来证明身份的 session（Core 已由 DSH Runtime 核对的 ACTIVE session）。
   * 锁内会再与 responder binding 当前 session 比对：主管已换 session 时，旧 session
   * 的调用者不能被当作当前责任主管。
   */
  callerSessionId: string
  replyText: string
  repliedAt: string
  attribution?: Record<string, unknown>
}): RecordDeliveryReplyResult {
  return store.withImmediateTransaction(() => {
    const question = readQuestionById(store, input.kingdomId, input.questionId)
    if (!question) questionFail('QUESTION_NOT_FOUND', '该问题不存在或不属于本王国，不能回复。')
    if (question.reviewerBindingId !== input.responderBindingId) {
      questionFail('QUESTION_NOT_ADDRESSED_TO_CALLER', '该问题只由接受交付的主管负责回复；其他主管不能代答。')
    }
    const text = boundedQuestionText(input.replyText, DELIVERY_REPLY_TEXT_LIMIT)
    if (!text) questionFail('INVALID_INPUT', '回复文本必须是非空、长度受限的文本。')
    // 锁内重新核对绑定：入口校验之后退任的 binding 不再放行。
    const binding = store.getBindingById(input.responderBindingId)
    if (!binding || binding.kingdom_id !== input.kingdomId || binding.role_type !== 'SUPERVISOR' || binding.status !== 'ACTIVE') {
      questionFail('QUESTION_REVIEWER_UNREACHABLE', '接受该交付的主管绑定此刻不是本王国 ACTIVE 主管，不能回复。')
    }
    const task = store.getTask(question.taskId)
    const territory = store.getTerritoryById(task?.territory_id ?? '')
    if (!task || !territory || territory.kingdom_id !== input.kingdomId || territory.status === 'DELETED') {
      questionFail('TASK_NOT_IN_KINGDOM', '该问题对应的任务此刻不在本王国，不能回复。')
    }
    // 领地当前主理必须仍是这个 binding：入口校验之后发生的改绑同样在锁内被拒绝，
    // 且不会把问题改投继任主管。
    if (!territory.supervisor_binding_id || territory.supervisor_binding_id !== input.responderBindingId) {
      questionFail('SUPERVISOR_REBOUND', '该领地此刻已改由其他主管主理，本条提问不可达；不会自动改投继任者。')
    }
    // session 也必须在锁内重新比对：主管换 session 后，旧 session 不再能写回复。
    if (!binding.session_id || binding.session_id !== input.callerSessionId) {
      questionFail('QUESTION_REVIEWER_SESSION_CHANGED', '该主管此刻的 session 已更换，旧 session 不能写入回复。')
    }
    // 回复事件 ID 只由问题 ID 决定：先按精确 ID 查既有事实行，一问至多一条回复。
    const eventId = deliveryReplyEventId(input.kingdomId, question.questionId)
    const recorded = store.getEventById(eventId)
    if (recorded) {
      const reply = readReplyRow(recorded)
      if (!reply) questionFail('REPLY_EVENT_CONFLICT', '既有回复记录与本次引用不一致，请重新核对。')
      if (reply.replyText === text) return { questionId: question.questionId, reply, created: false }
      questionFail('REPLY_ALREADY_RECORDED', '该问题已有一条回复；同一问题最多一个当前回复，冲突回复被拒绝。')
    }
    const claim = store.latestWorkerResult(question.taskId)
    if (!claim) questionFail('DELIVERY_NOT_CONFIRMED', '该交付对应的结果不存在，不能回复。')
    if (claim.attempt_no !== question.attemptNo || claim.result_id !== question.resultId) {
      questionFail('DELIVERY_VERSION_STALE', '交付的已接受版本已变化，不能对该版本的问题回复。')
    }
    const review = readLatestReviewEvent(store, input.kingdomId, question.taskId)
    if (!classifyAcceptedDelivery(store, claim, review)) {
      questionFail('DELIVERY_NOT_CONFIRMED', '该交付已不再处于主管 ACCEPT 确认状态，不能回复。')
    }
    // 版本核对按问题**冻结时**的内容版本：问题只对它被提问的那个版本有效。
    // CHANGE 条目由主管确认的改动证据派生；证据在同一个写锁内**按当前 ACCEPT 引用**
    // 重新读取并重验，而不是沿用锁外解析出的旧对象。证据漂移/被替换/条目改版都会
    // fail-closed，因此回复不会把正文挪用到另一个条目或另一个内容版本上。
    const currentRef = readAcceptedChangeEvidence(review)
    const currentEvidence = currentRef ? resolveChangeEvidenceForDelivery(undefined, currentRef) : null
    const currentItems = deriveDeliveryItems(question.taskId, claim, currentEvidence)
    if (!currentItems.some(item => item.itemId === question.itemId && item.contentHash === question.contentHash)) {
      questionFail('DELIVERY_ITEM_VERSION_STALE', '该条目当前版本已变化或改动证据不可重验，不能对该版本的问题回复。')
    }
    const row = store.appendEvent({
      event_id: eventId,
      kingdom_id: input.kingdomId,
      event_type: DELIVERY_REPLY_EVENT_TYPE,
      actor_role: 'SUPERVISOR',
      actor_id: input.responderBindingId,
      target_type: 'delivery',
      target_id: question.deliveryId,
      payload_json: JSON.stringify({
        version: DELIVERY_REPLY_PAYLOAD_VERSION,
        questionId: question.questionId,
        deliveryId: question.deliveryId,
        taskId: question.taskId,
        itemId: question.itemId,
        contentHash: question.contentHash,
        attemptNo: question.attemptNo,
        resultId: question.resultId,
        responderBindingId: input.responderBindingId,
        replyText: text,
        repliedAt: input.repliedAt,
        meaning: 'SUPERVISOR_REPLY_TO_OWNER_QUESTION_ONLY',
        ...(input.attribution ?? {}),
      }),
      created_at: input.repliedAt,
    })
    return { questionId: question.questionId, created: true,
      reply: { questionId: question.questionId, responderBindingId: input.responderBindingId, replyText: text,
        repliedAt: input.repliedAt, eventId: row.event_id, eventSeq: row.seq } }
  })
}

/**
 * 按精确 questionId 从权威账本读取一条问题；形状不可核对或不属于该王国时为 null。
 */
export function readQuestionById(store: KingdomStore, kingdomId: string, questionId: string): DeliveryQuestion | null {
  if (!DELIVERY_QUESTION_ID.test(questionId)) return null
  const row = (store.db.prepare('SELECT * FROM events WHERE kingdom_id = ? AND event_type = ? ORDER BY seq ASC')
    .all(kingdomId, DELIVERY_QUESTION_EVENT_TYPE) as unknown as EventRow[])
    .map(readQuestionRow).find(candidate => candidate?.questionId === questionId)
  if (!row) return null
  const task = store.getTask(row.taskId)
  const territory = store.getTerritoryById(task?.territory_id ?? '')
  const currentSupervisorBindingId = territory?.supervisor_binding_id ?? null
  const currentItemContentHash = currentItemContentHashes(store, kingdomId, [row.taskId]).get(row.taskId)?.get(row.itemId) ?? null
  return { ...row, reply: null, currentSupervisorBindingId, currentItemContentHash,
    itemVersion: classifyDeliveryItemVersion(currentItemContentHash, row.contentHash),
    replyState: classifyDeliveryReplyAccess(store, kingdomId, row.reviewerBindingId, currentSupervisorBindingId).state }
}

/** `TASK_ACCEPTED` 事件所记的主管 binding；形状不可核对时为 null（fail-closed）。 */
export function deliveryReviewerBindingId(review: EventRow | null): string | null {
  if (review?.event_type !== 'TASK_ACCEPTED' || review.actor_role !== 'SUPERVISOR') return null
  const payload = parseJson(review.payload_json)
  const reviewBinding = typeof payload.reviewer_binding_id === 'string' && payload.reviewer_binding_id ? payload.reviewer_binding_id : null
  const actor = typeof review.actor_id === 'string' && review.actor_id ? review.actor_id : null
  // 两个真实字段必须**同时非空且相等**：只出现其一时不猜测接收者。
  // 否则任一单字段（伪造的 payload 或 actor_id）都能把问题定向到任意主管。
  if (!reviewBinding || !actor || reviewBinding !== actor) return null
  return reviewBinding
}

// ── 主管收件箱与回复（session-bound Tool 专用）────────────────────────

/**
 * 主管回复一个提问。
 *
 * 与收件箱共用同一套 session-bound 门槛：调用者必须已由 Core 证明为**真实、当前**的
 * 同领地 ACTIVE 主管 session；问题必须正好写给该 binding，且该 binding 仍是领地当前
 * 主理（退任、换 session、领地改绑一律拒绝，不改投继任者）。失败零写入。
 *
 * 这里的每一条都只是**早拒**：`recordDeliveryReply` 会在同一个写锁事务内用真实
 * caller session、当前 binding 状态、当前领地主理与当前 ACCEPT 证据重新核对一遍，
 * 因此锁前状态在等待写锁期间发生变化也不会写出失效回复。
 *
 * A question is answered at most once: the same reply text retried is idempotent, a
 * different reply for the same question is rejected. A reply writes only this one
 * conversation fact — never an acknowledgement, Task/Claim, supervisor ACCEPT, Owner
 * acceptance or release fact, and never a dispatch/follow-up/wakeup.
 */
export function replyToDeliveryQuestion(store: KingdomStore, ctx: CommandContext, input: { questionId: string; replyText: string }): { ok: true; text: string } | { ok: false; code: string; message: string } {
  if (ctx.auth.mode !== 'session-bound') {
    return { ok: false, code: 'DELIVERY_QUESTION_SESSION_REQUIRED',
      message: '错误：交付问答只能由真实 session-bound 主管读取与回复；declarative 低信任模式不放行。' }
  }
  const caller = ctx.principal?.sessionId ?? null
  if (!caller) {
    return { ok: false, code: 'UNAUTHORIZED_PRINCIPAL',
      message: '错误：无法从 DSH Runtime 证明当前调用方的真实 session，拒绝回复。' }
  }
  const bindings = store.getBindingsByRole(ctx.kingdomId, 'SUPERVISOR').filter(candidate => candidate.session_id === caller)
  if (!bindings.length) {
    return { ok: false, code: 'UNAUTHORIZED_PRINCIPAL',
      message: '错误：当前调用者没有与该 session 匹配的 ACTIVE SUPERVISOR binding，拒绝回复。' }
  }
  const questionId = typeof input.questionId === 'string' ? input.questionId.trim() : ''
  if (!/^question:[0-9a-f]{32}$/u.test(questionId)) {
    return { ok: false, code: 'QUESTION_NOT_FOUND', message: '错误：questionId 形状不合法，未写入任何回复。' }
  }
  const replyText = typeof input.replyText === 'string' ? input.replyText : ''
  if (!boundedQuestionText(replyText, DELIVERY_REPLY_TEXT_LIMIT)) {
    return { ok: false, code: 'INVALID_INPUT', message: '错误：回复内容必须是非空、长度受限的文本。' }
  }
  const found = readQuestionById(store, ctx.kingdomId, questionId)
  if (!found) return { ok: false, code: 'QUESTION_NOT_FOUND', message: '错误：该问题不存在或不属于当前王国，未写入任何回复。' }
  const task = store.getTask(found.taskId)
  if (!task) return { ok: false, code: 'QUESTION_NOT_FOUND', message: '错误：该问题对应的任务不存在。' }
  const territory = store.getTerritoryById(task.territory_id)
  if (!territory || territory.kingdom_id !== ctx.kingdomId || territory.status === 'DELETED') {
    return { ok: false, code: 'TASK_NOT_IN_KINGDOM', message: '错误：该问题对应的任务不属于当前王国。' }
  }
  if (!bindings.some(binding => binding.binding_id === territory.supervisor_binding_id)) {
    return { ok: false, code: 'TASK_OUT_OF_SCOPE',
      message: `错误：任务「${task.title}」属于领地「${territory.name}」，超出当前主管的治理范围。` }
  }
  // 只由接受该交付的主管回复：身份还必须是它本人，而不是任何一位在任主管。
  const responder = bindings.find(binding => binding.binding_id === found.reviewerBindingId)
  if (!responder) {
    const access = classifyDeliveryReplyAccess(store, ctx.kingdomId, found.reviewerBindingId, territory.supervisor_binding_id, caller)
    return { ok: false, code: 'QUESTION_NOT_ADDRESSED_TO_CALLER',
      message: `错误：该问题只由接受该交付的主管负责回复，其他主管不能代答。${access.detail}` }
  }
  try {
    const result = recordDeliveryReply(store, {
      kingdomId: ctx.kingdomId,
      questionId,
      responderBindingId: responder.binding_id,
      callerSessionId: caller,
      replyText,
      repliedAt: new Date().toISOString(),
      attribution: { source_channel: 'SUPERVISOR_TOOL', authorization_source: 'SESSION_BOUND' },
    })
    return { ok: true, text: result.created
      ? `已记录回复（问题 ${questionId}）。这是该问题的唯一当前回复；它不写知悉、Task/Claim、主管 ACCEPT、Owner acceptance 或发布事实，也不自动派发或唤醒任何后续动作。\n${result.reply.replyText}`
      : `该问题已有同一内容的回复记录，未新增第二条事实。\n${result.reply.replyText}` }
  } catch (error) {
    if (error instanceof DeliveryQuestionError) return { ok: false, code: error.code, message: `错误：${error.message}` }
    throw error
  }
}

/** 一个 session 的全部 ACTIVE SUPERVISOR 绑定及其合并收件箱。 */
export interface SessionDeliveryQuestionInbox {
  /** 该 session 当前可证明的全部 ACTIVE SUPERVISOR binding。 */
  bindings: RoleBindingRow[]
  entries: DeliveryQuestionInboxEntry[]
}

/**
 * 按 session 读取**全部**可证明绑定的收件箱。
 *
 * 一个 session 可以合法持有多个 ACTIVE SUPERVISOR 绑定；只取第一个会让后续绑定的问题
 * 静默消失。这里逐 binding 精确读取再合并：每条问题只有一个接收主管，因此不会重复。
 * 领地界仍是这些 binding 当前主理领地的并集，授权仍由调用方用真实 session 判定。
 * 找不到任何 binding 时返回空列表，由调用方 fail-closed。
 */
export function readDeliveryQuestionInboxForSession(store: KingdomStore, kingdomId: string, sessionId: string | null | undefined): SessionDeliveryQuestionInbox {
  const bindings = sessionId ? store.getBindingsByRole(kingdomId, 'SUPERVISOR').filter(binding => binding.session_id === sessionId) : []
  const bindingIds = new Set(bindings.map(binding => binding.binding_id))
  const territoryIds = store.listTerritories(kingdomId)
    .filter(territory => !!territory.supervisor_binding_id && bindingIds.has(territory.supervisor_binding_id))
    .map(territory => territory.territory_id)
  return {
    bindings,
    entries: bindings.flatMap(binding => readDeliveryQuestionInbox(store, kingdomId, { reviewerBindingId: binding.binding_id, territoryIds })),
  }
}

export interface DeliveryQuestionInboxScope {
  /** 调用者由 Core 证明的当前主管 binding；只返回**写给它**的问题。 */
  reviewerBindingId: string
  /** 该主管当前主理的领地；仅用于展示范围的界，授权仍由 session-bound 身份判定。 */
  territoryIds?: readonly string[]
}

/** 收件箱里的一条问题：正文、回复、当前可达性。 */
export interface DeliveryQuestionInboxEntry {
  question: DeliveryQuestion
  taskTitle: string
  territoryName: string
}

/**
 * 按权威账本精确读取**只属于该主管 binding**的提问。
 *
 * 刻意不是「最近事件投影」：逐条从 events 表按 delivery 精确查询，因此不会被
 * 有界的最近事件窗口截断，也不会看到其他主管或其他领地的问题。
 */
export function readDeliveryQuestionInbox(store: KingdomStore, kingdomId: string, scope: DeliveryQuestionInboxScope): DeliveryQuestionInboxEntry[] {
  const entries: DeliveryQuestionInboxEntry[] = []
  const allowed = scope.territoryIds ? new Set(scope.territoryIds) : null
  const rows = store.db.prepare('SELECT * FROM events WHERE kingdom_id = ? AND event_type = ? ORDER BY seq ASC')
    .all(kingdomId, DELIVERY_QUESTION_EVENT_TYPE) as unknown as EventRow[]
  const repliesByDelivery = new Map<string, Map<string, DeliveryQuestionReply>>()
  const deliveries = new Set<string>()
  const parsed = rows.map(readQuestionRow).filter((question): question is NonNullable<typeof question> => question !== null)
    .filter(question => question.reviewerBindingId === scope.reviewerBindingId)
  for (const question of parsed) {
    if (deliveries.has(question.deliveryId)) continue
    deliveries.add(question.deliveryId)
    const thread = readDeliveryQuestionThread(store, kingdomId, question.deliveryId)
    repliesByDelivery.set(question.deliveryId, new Map((thread?.questions ?? []).filter(item => item.reply).map(item => [item.questionId, item.reply!])))
  }
  // 当前内容版本逐 Task 重算一次：收件箱是主管决定「现在要不要回复」的地方，这里
  // 绝不能把旧版本未答问题算成当前待答复的提问。
  const currentVersions = currentItemContentHashes(store, kingdomId, [...new Set(parsed.map(question => question.taskId))])
  for (const question of parsed) {
    const task = store.getTask(question.taskId)
    if (!task) continue
    const territory = store.getTerritoryById(task.territory_id)
    if (!territory || territory.kingdom_id !== kingdomId || territory.status === 'DELETED') continue
    if (allowed && !allowed.has(territory.territory_id)) continue
    const reply = repliesByDelivery.get(question.deliveryId)?.get(question.questionId) ?? null
    const currentSupervisorBindingId = territory.supervisor_binding_id ?? null
    const currentItemContentHash = currentVersions.get(question.taskId)?.get(question.itemId) ?? null
    entries.push({ question: { ...question, reply, currentSupervisorBindingId, currentItemContentHash,
      itemVersion: classifyDeliveryItemVersion(currentItemContentHash, question.contentHash),
      replyState: classifyDeliveryReplyAccess(store, kingdomId, question.reviewerBindingId, currentSupervisorBindingId).state },
      taskTitle: bounded(task.title), territoryName: bounded(territory.name) })
  }
  return entries
}
