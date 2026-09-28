import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KingdomStore } from '../lib/core/db.js'
import { issueOwnerControlCapability, issueOwnerOperationCapability, isOwnerControlCapability, ownerControlAuth, ownerInputHash } from '../lib/core/owner-control.js'
import { initializeKingdomFacts } from '../lib/core/kingdom.js'
import { bindRole } from '../lib/core/binding.js'
import { createTerritory, setTerritorySupervisor } from '../lib/core/territory.js'
import { reviewTask } from '../lib/core/task-service.js'
import { OwnerDecisionController, type OwnerDecisionControllerOptions, type OwnerDecisionInput, type OwnerOperationInput } from '../lib/core/owner-window.js'
import {
  DELIVERY_ACK_EVENT_TYPE,
  DELIVERY_QUESTION_EVENT_TYPE,
  DELIVERY_REPLY_EVENT_TYPE,
  LEGACY_ACCEPTANCE_EVIDENCE_NOTE,
  acceptedDelivery,
  classifyAcceptedDelivery,
  deliveryAckEventId,
  deliveryAcknowledgementView,
  deliveryContentHash,
  deliveryIdFor,
  deliveryItemId,
  deriveDeliveryItems,
  readDeliveryAcknowledgements,
  readLatestReviewEvent,
  recordDeliveryAcknowledgement,
  redactCredentialText,
  redactDeliveryText,
  trustedChangeRef,
  validateRepoRelativePath,
  validateSourceRevision,
} from '../lib/core/delivery-ack.js'
import { WORKBENCH_CSS, WORKBENCH_SCRIPT } from '../lib/gui/workbench-ui.js'
import { buildSnapshot } from '../lib/gui/snapshot.js'
import { renderConsoleApp } from '../lib/gui/console-app.js'
import { renderOwnerApp } from '../lib/gui/owner-ui.js'
import { OwnerLocalControlManager, normalizeLaunchAckHint, validateLaunchAckHint } from '../lib/gui/owner-control.js'
import { startGuiServer } from '../lib/gui/server.js'
import { GUI_SCHEMA_VERSION } from '../lib/gui/contract.js'

const NOW = '2026-09-27T06:00:00.000Z'
const auth = { mode: 'session-bound' as const, trustLevel: 'session-verified' as const, note: '' }

/**
 * Assert the structured error code. OwnerOperationError exposes `code` while its
 * message stays the operator-facing Chinese sentence, so match the code field
 * instead of re-asserting on wording.
 */
async function assertAckError(operation: () => unknown | Promise<unknown>, code: string): Promise<void> {
  try {
    await operation()
  } catch (error) {
    // OwnerOperationError carries `code`; the opaque-capability guard throws a plain
    // Error whose message starts with the same code.
    const actual = (error as { code?: string }).code
      ?? (error instanceof Error && error.message.startsWith(code) ? code : undefined)
    assert.equal(actual, code, (error as Error).message)
    return
  }
  assert.fail('expected a rejection with code ' + code)
}

function ackPayload(store: KingdomStore, kingdomId: string): Record<string, unknown>[] {
  return store.listEvents(kingdomId, 200).filter(row => row.event_type === DELIVERY_ACK_EVENT_TYPE)
    .map(row => JSON.parse(row.payload_json) as Record<string, unknown>)
}

/**
 * `storage.dbPath` switches the fixture to a real temporary SQLite file (used by the
 * catalogue-cap regression so it is not an in-memory-only shape); `storage.cleanupRoot`
 * is removed by the same dispose that closes the store.
 */
function fixture(t: { after(fn: () => void): void } | undefined, options: Partial<OwnerDecisionControllerOptions> = {},
  storage: { dbPath?: string; cleanupRoot?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kingdom-delivery-ack-'))
  const store = new KingdomStore(storage.dbPath ?? ':memory:')
  const initialized = store.withImmediateTransaction(() => initializeKingdomFacts(store, '交付知悉测试王国', '人类所有者'))
  const kingdomId = initialized.kingdomId
  const capability = issueOwnerControlCapability()
  const ownerAuth = ownerControlAuth(capability)
  bindRole(store, { kingdomId, roleType: 'SUPERVISOR', roleName: '主管', sessionId: 'supervisor-session' }, ownerAuth)
  bindRole(store, { kingdomId, roleType: 'WORKER', roleName: '执行者' }, ownerAuth)
  const supervisor = store.getBindingByRole(kingdomId, 'SUPERVISOR')!
  const worker = store.getBindingByRole(kingdomId, 'WORKER')!
  createTerritory(store, { kingdomId, name: '主领地', workspacePath: root }, ownerAuth)
  const territory = store.listTerritories(kingdomId)[0]!
  setTerritorySupervisor(store, { kingdomId, territoryId: territory.territory_id, supervisorBindingId: supervisor.binding_id }, ownerAuth)
  const defaults: OwnerDecisionControllerOptions = {
    validateTargetSession: async () => ({ ok: true }), validateExecutionProfile: async () => ({ ok: true }),
    listTargetSessions: async ({ sessionIds }) => sessionIds.map(id => ({ id, label: id })),
  }
  const controller = new OwnerDecisionController(store, { ...defaults, ...options })
  const decision: OwnerDecisionInput = {
    kingdomId, actions: ['delivery.item.ack'], ttlMs: 600000,
    scope: { kingdomWide: false, territoryIds: [territory.territory_id], bindingIds: [supervisor.binding_id],
      roleTypes: ['SUPERVISOR'], targetSessionIds: [], workspaceRoots: [] },
  }
  const dispose = (): void => { controller.dispose(); store.close(); rmSync(root, { recursive: true, force: true })
    if (storage.cleanupRoot) rmSync(storage.cleanupRoot, { recursive: true, force: true }) }
  t?.after(() => { dispose() })
  const activate = (input: OwnerDecisionInput = decision) => controller.activate(capability, input).handle
  return { root, store, kingdomId, supervisor, worker, territory, controller, decision, capability, ownerAuth, activate, dispose }
}

interface TaskOptions { status?: string; artifacts?: string[]; risks?: string[]; summary?: string; attemptNo?: number; createdAt?: string }

function addClaimedTask(f: ReturnType<typeof fixture>, taskId: string, options: TaskOptions = {}): { taskId: string; resultId: string } {
  const summary = options.summary ?? '完成首页与设置页改版，并给出可读摘要'
  const createdAt = options.createdAt ?? NOW
  f.store.insertTask({ task_id: taskId, territory_id: f.territory.territory_id, parent_task_id: null, title: '交付 ' + taskId,
    description: '清楚的范围', assigned_binding_id: f.worker.binding_id, status: options.status ?? 'REVIEW',
    acceptance_criteria: '核验产物', result_summary: null, created_at: createdAt, updated_at: createdAt })
  const resultId = 'result-' + taskId
  f.store.insertWorkerResult({ result_id: resultId, task_id: taskId, attempt_no: options.attemptNo ?? 1, worker_binding_id: f.worker.binding_id,
    session_id: 'private-session-should-not-leak', outcome: 'COMPLETED',
    result_json: JSON.stringify({ summary, artifacts: options.artifacts ?? ['src/gui/workbench-ui.ts', '第三份证据'], risks: options.risks ?? [] }),
    created_at: createdAt })
  return { taskId, resultId }
}

function acceptTask(f: ReturnType<typeof fixture>, taskId: string, attemptNo = 1, reviewer = f.supervisor.binding_id): void {
  // Fixture-only direct status write: this suite exercises acknowledgement, not the
  // Task lifecycle state machine (which has its own coverage elsewhere).
  // The ACCEPT payload mirrors the canonical producer in task-service.ts: it locks
  // the reviewed attempt, result id and result digest.
  const claim = f.store.latestWorkerResult(taskId)
  f.store.db.prepare('UPDATE tasks SET status = ? WHERE task_id = ?').run('DONE', taskId)
  f.store.appendEvent({
    event_id: 'accept-' + taskId + '-' + attemptNo, kingdom_id: f.kingdomId, event_type: 'TASK_ACCEPTED', actor_role: 'SUPERVISOR',
    actor_id: reviewer, target_type: 'task', target_id: taskId,
    payload_json: JSON.stringify({ decision: 'ACCEPT', reviewed_attempt_no: attemptNo, reviewer_binding_id: reviewer,
      reviewed_result_id: claim?.result_id ?? null, reviewed_result_digest: claim ? ownerInputHash(claim) : null, claimed_outcome: 'COMPLETED' }),
    created_at: NOW,
  })
}

/**
 * 写入 immutable v1.0.0 形状的 `TASK_ACCEPTED`：**没有** `reviewed_result_id` /
 * `reviewed_result_digest`，只有真实的旧字段。`extra` 用于构造形状不符的负例。
 */
function acceptTaskLegacyV1(f: ReturnType<typeof fixture>, taskId: string, attemptNo = 1, extra: Record<string, unknown> = {}): void {
  f.store.db.prepare('UPDATE tasks SET status = ? WHERE task_id = ?').run('DONE', taskId)
  f.store.appendEvent({
    event_id: 'accept-v1-' + taskId + '-' + attemptNo, kingdom_id: f.kingdomId, event_type: 'TASK_ACCEPTED', actor_role: 'SUPERVISOR',
    actor_id: f.supervisor.binding_id, target_type: 'task', target_id: taskId,
    payload_json: JSON.stringify({ decision: 'ACCEPT', reason: null, reviewer_binding_id: f.supervisor.binding_id,
      reviewed_attempt_no: attemptNo, claimed_outcome: 'COMPLETED', ...extra }),
    created_at: NOW,
  })
}

function currentItems(f: ReturnType<typeof fixture>, taskId: string) {
  const claim = f.store.latestWorkerResult(taskId)!
  return deriveDeliveryItems(taskId, claim)
}

/**
 * 真实 reviewTask 的 ACCEPT：像生产路径一样经 `transitionTask` 更新 `tasks.updated_at`，
 * 并写出真实形状的 `TASK_ACCEPTED`。`at` 只用于让本测试控制「接受时刻」。
 */
function reviewAcceptTask(f: ReturnType<typeof fixture>, taskId: string, at: string) {
  const previous = f.store.withImmediateTransaction.bind(f.store)
  f.store.withImmediateTransaction = function <T>(this: KingdomStore, fn: () => T): T {
    return previous(() => {
      f.store.db.prepare('UPDATE tasks SET updated_at = ? WHERE task_id = ?').run(at, taskId)
      return fn()
    })
  }
  try {
    return reviewTask(f.store, { kingdomId: f.kingdomId, principal: { sessionId: 'supervisor-session' }, auth },
      { taskId, decision: 'ACCEPT', reason: '边界回归' })
  } finally {
    f.store.withImmediateTransaction = previous
  }
}

function insertDeliveryTask(f: ReturnType<typeof fixture>, taskId: string, title: string, createdAt: string): void {
  f.store.insertTask({ task_id: taskId, territory_id: f.territory.territory_id, parent_task_id: null, title,
    description: '清楚的范围', assigned_binding_id: f.worker.binding_id, status: 'REVIEW',
    acceptance_criteria: '核验产物', result_summary: null, created_at: createdAt, updated_at: createdAt })
  f.store.insertWorkerResult({ result_id: 'result-' + taskId, task_id: taskId, attempt_no: 1, worker_binding_id: f.worker.binding_id,
    session_id: 'private-session-should-not-leak', outcome: 'COMPLETED',
    result_json: JSON.stringify({ summary: '完成 ' + taskId, artifacts: ['证据一'], risks: [] }), created_at: createdAt })
}

function ackOperation(f: ReturnType<typeof fixture>, taskId: string, itemIndex = 0): OwnerOperationInput {
  const claim = f.store.latestWorkerResult(taskId)!
  const item = deriveDeliveryItems(taskId, claim)[itemIndex]!
  return { action: 'delivery.item.ack', parameters: { task_id: taskId, delivery_id: deliveryIdFor(taskId),
    item_id: item.itemId, content_hash: item.contentHash, attempt_no: claim.attempt_no, result_id: claim.result_id } }
}

async function execute(f: ReturnType<typeof fixture>, handle: ReturnType<ReturnType<typeof fixture>['activate']>, input: OwnerOperationInput) {
  const preview = await f.controller.prepare(handle, input)
  const receipt = await f.controller.commit(handle, { prepareId: preview.prepareId, operationId: preview.operationId })
  return { preview, receipt }
}

/** Real `delivery.item.question` input for one exact item slot of the current attempt. */
function questionAsk(f: ReturnType<typeof fixture>, taskId: string, itemIndex: number, questionText: string): OwnerOperationInput {
  const claim = f.store.latestWorkerResult(taskId)!
  const item = deriveDeliveryItems(taskId, claim)[itemIndex]!
  return { action: 'delivery.item.question', parameters: { task_id: taskId, delivery_id: deliveryIdFor(taskId),
    item_id: item.itemId, content_hash: item.contentHash, attempt_no: claim.attempt_no, result_id: claim.result_id,
    question_text: questionText } }
}

// ── 1. 身份与版本（纯函数）────────────────────────────────────────

test('delivery item identity is stable across rebuilds while content version tracks the text', () => {
  const claim = { result_id: 'r1', task_id: 't1', attempt_no: 2, result_json: JSON.stringify({ summary: '摘要 A', artifacts: ['证据一'], risks: [] }) }
  const first = deriveDeliveryItems('t1', claim as never)
  const again = deriveDeliveryItems('t1', claim as never)
  assert.deepEqual(first.map(item => item.itemId), again.map(item => item.itemId))
  assert.deepEqual(first.map(item => item.contentHash), again.map(item => item.contentHash))
  assert.equal(first.length, 2)
  assert.equal(first[0]!.content.layer, 'SUMMARY')
  assert.equal(first[1]!.content.layer, 'EVIDENCE')
  assert.notEqual(first[0]!.itemId, first[1]!.itemId, 'summary and evidence items never share an identity')
  const changed = deriveDeliveryItems('t1', { ...claim, result_json: JSON.stringify({ summary: '摘要 B', artifacts: ['证据一'], risks: [] }) } as never)
  assert.equal(changed[0]!.itemId, first[0]!.itemId, 'the summary keeps its position identity')
  assert.notEqual(changed[0]!.contentHash, first[0]!.contentHash, 'changed text is a new content version')
  assert.equal(changed[1]!.contentHash, first[1]!.contentHash, 'an untouched child keeps its version')
  const appended = deriveDeliveryItems('t1', { ...claim, result_json: JSON.stringify({ summary: '摘要 A', artifacts: ['证据一', '证据二'], risks: [] }) } as never)
  assert.equal(appended[1]!.itemId, first[1]!.itemId, 'appending evidence keeps existing identities')
  assert.equal(appended[1]!.contentHash, first[1]!.contentHash)
  assert.notEqual(appended[2]!.itemId, first[1]!.itemId)
  assert.equal(deliveryItemId('d', 'EVIDENCE', 'ARTIFACT', 1), deliveryItemId('d', 'EVIDENCE', 'ARTIFACT', 1))
  assert.notEqual(deliveryItemId('d', 'EVIDENCE', 'ARTIFACT', 0), deliveryItemId('d', 'EVIDENCE', 'RISK', 0),
    'artifacts and risks never share an identity namespace')
})

test('content version is deterministic over structure, text and change-reference state', () => {
  const base = { layer: 'EVIDENCE' as const, label: '产物引用 1', detail: 'src/a.ts', sourceRef: { entityType: 'worker_results' as const, entityId: 'r1' },
    change: { kind: 'NOT_LOCATABLE' as const, repoPath: null, revision: null, reasonCode: 'X', note: 'n' }, details: [] }
  assert.equal(deliveryContentHash(base), deliveryContentHash({ ...base }))
  assert.notEqual(deliveryContentHash(base), deliveryContentHash({ ...base, detail: 'src/b.ts' }))
  assert.notEqual(deliveryContentHash(base), deliveryContentHash({ ...base, label: '其他' }))
  assert.notEqual(deliveryContentHash(base), deliveryContentHash({ ...base, change: { ...base.change, reasonCode: 'Y' } }))
  assert.notEqual(deliveryContentHash(base), deliveryContentHash({ ...base, change: { ...base.change, note: '另一段可见说明' } }),
    'the visible change note is part of the content version')
  assert.notEqual(deliveryContentHash(base), deliveryContentHash({ ...base, sourceRef: { entityType: 'worker_results', entityId: 'r2' } }))
})

// ── 2. 改动定位可信度 ────────────────────────────────────────────

test('change references only accept verified repo-relative paths and fixed revisions', () => {
  for (const bad of ['C:/work/secret.ts', 'C:\\work\\secret.ts', '/etc/passwd', '\\\\server\\share\\a.ts', '../../outside.ts', 'src/../../x.ts',
    '~/notes.md', 'src/.git/config', 'src//a.ts', 'src/./a.ts', '', 'src/a.ts\u0000', 'a'.repeat(600)]) {
    assert.equal(validateRepoRelativePath(bad), null, bad)
  }
  for (const good of ['src/gui/workbench.ts', 'docs/feature-flows/gui-personal-workbench/flow.md', 'a.ts']) {
    assert.equal(validateRepoRelativePath(good), good)
  }
  assert.equal(validateSourceRevision('9f8e7d6'), '9f8e7d6')
  assert.equal(validateSourceRevision('main~3..main'), 'main~3..main')
  assert.equal(validateSourceRevision('bad revision'), null)
  assert.equal(validateSourceRevision(''), null)
  assert.equal(validateSourceRevision('x'.repeat(201)), null)
  assert.deepEqual(trustedChangeRef('src/a.ts', '9f8e7d6'), { repoPath: 'src/a.ts', revision: '9f8e7d6' })
  assert.equal(trustedChangeRef('C:/abs/a.ts', '9f8e7d6'), null)
  assert.equal(trustedChangeRef('src/a.ts', null), null)
  assert.equal(trustedChangeRef(42, '9f8e7d6'), null)
})

test('worker-provided artifact text never becomes a located change link', () => {
  const items = deriveDeliveryItems('t1', { result_id: 'r1', task_id: 't1', attempt_no: 1,
    result_json: JSON.stringify({ summary: 's', artifacts: ['src/gui/workbench.ts', 'C:/Users/me/secret.txt', 'see commit 9f8e7d6'], risks: [] }) } as never)
  for (const item of items) {
    assert.equal(item.content.change.kind, 'NOT_LOCATABLE')
    assert.equal(item.content.change.repoPath, null)
    assert.equal(item.content.change.revision, null)
    assert.ok(item.content.change.reasonCode)
  }
})

// ── 3. 交付确认语义 ──────────────────────────────────────────────

test('only the supervisor ACCEPT for the same attempt confirms a delivery; a claim never does', (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'pending')
  assert.equal(acceptedDelivery(f.store, f.store.latestWorkerResult('pending'), readLatestReviewEvent(f.store, f.kingdomId, 'pending')), false)
  acceptTask(f, 'pending', 2)
  assert.equal(acceptedDelivery(f.store, f.store.latestWorkerResult('pending'), readLatestReviewEvent(f.store, f.kingdomId, 'pending')), false,
    'an ACCEPT for another attempt does not confirm this claim')
  f.store.appendEvent({ event_id: 'rework-pending', kingdom_id: f.kingdomId, event_type: 'TASK_REWORK_REQUESTED', actor_role: 'SUPERVISOR',
    actor_id: f.supervisor.binding_id, target_type: 'task', target_id: 'pending', payload_json: JSON.stringify({ decision: 'REWORK', reviewed_attempt_no: 1 }), created_at: NOW })
  assert.equal(acceptedDelivery(f.store, f.store.latestWorkerResult('pending'), readLatestReviewEvent(f.store, f.kingdomId, 'pending')), false,
    'a later REWORK supersedes the ACCEPT')
  acceptTask(f, 'pending', 1)
  assert.equal(acceptedDelivery(f.store, f.store.latestWorkerResult('pending'), readLatestReviewEvent(f.store, f.kingdomId, 'pending')), true)
  // A worker-authored event can never confirm a delivery.
  const forged = f.store.listEvents(f.kingdomId, 200).find(row => row.event_type === 'TASK_ACCEPTED')!
  f.store.appendEvent({ event_id: 'worker-forged', kingdom_id: f.kingdomId, event_type: 'TASK_ACCEPTED', actor_role: 'WORKER',
    actor_id: f.worker.binding_id, target_type: 'task', target_id: 'pending',
    payload_json: JSON.stringify({ decision: 'ACCEPT', reviewed_attempt_no: 1 }), created_at: NOW })
  f.store.db.prepare('UPDATE tasks SET status = ? WHERE task_id = ?').run('RUNNING', 'pending')
  assert.equal(acceptedDelivery(f.store, f.store.latestWorkerResult('pending'), readLatestReviewEvent(f.store, f.kingdomId, 'pending')), false,
    'a DONE-only status change with no supervisor ACCEPT is not a delivery')
  assert.equal(forged.event_type, 'TASK_ACCEPTED')
})

test('a TASK_ACCEPTED for the same attempt but a different result id or digest never confirms a delivery', async (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'accepted')
  f.store.db.prepare('UPDATE tasks SET status = ? WHERE task_id = ?').run('DONE', 'accepted')
  const claim = f.store.latestWorkerResult('accepted')!
  const accept = (eventId: string, reviewedResultId: string | null, reviewedDigest: string | null): void => {
    f.store.appendEvent({ event_id: eventId, kingdom_id: f.kingdomId, event_type: 'TASK_ACCEPTED', actor_role: 'SUPERVISOR',
      actor_id: f.supervisor.binding_id, target_type: 'task', target_id: 'accepted',
      payload_json: JSON.stringify({ decision: 'ACCEPT', reviewed_attempt_no: claim.attempt_no,
        reviewed_result_id: reviewedResultId, reviewed_result_digest: reviewedDigest }), created_at: NOW })
  }
  const accepted = () => acceptedDelivery(f.store, claim, readLatestReviewEvent(f.store, f.kingdomId, 'accepted'))
  accept('accept-wrong-result', 'result-other', ownerInputHash(claim))
  assert.equal(accepted(), false, 'another result id for the same attempt is not this delivery')
  accept('accept-wrong-digest', claim.result_id, 'f'.repeat(64))
  assert.equal(accepted(), false, 'a digest that does not match the claim is not this delivery')
  accept('accept-legacy-shape', claim.result_id, null)
  assert.equal(accepted(), false, 'an ACCEPT without the reviewed digest cannot confirm a delivery')
  const handle = f.activate()
  await assertAckError(() => f.controller.prepare(handle, ackOperation(f, 'accepted', 0)), 'DELIVERY_NOT_CONFIRMED')
  assert.equal(ackPayload(f.store, f.kingdomId).length, 0, 'a mismatched ACCEPT writes zero acknowledgement facts')
  accept('accept-canonical', claim.result_id, ownerInputHash(claim))
  assert.equal(accepted(), true)
  const { receipt } = await execute(f, handle, ackOperation(f, 'accepted', 0))
  assert.equal(receipt.status, 'APPLIED')
  assert.equal(ackPayload(f.store, f.kingdomId).length, 1)
})

// ── 4. Core 事实写入：权限、幂等、版本、父子独立 ─────────────────

function recordInput(f: ReturnType<typeof fixture>, taskId: string, itemIndex = 0) {
  const claim = f.store.latestWorkerResult(taskId)!
  const item = deriveDeliveryItems(taskId, claim)[itemIndex]!
  return {
    kingdomId: f.kingdomId, deliveryId: deliveryIdFor(taskId), itemId: item.itemId,
    contentHash: item.contentHash, taskId, attemptNo: claim.attempt_no, resultId: claim.result_id,
    ownerId: f.store.getDefaultKingdom()!.owner_id, ownerBindingId: f.store.getBindingByRole(f.kingdomId, 'OWNER')?.binding_id ?? null,
    itemLabel: item.content.label, acknowledgedAt: NOW,
  }
}

test('delivery acknowledgement refuses unconfirmed deliveries, unknown items, stale versions and forged references', async (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'review-only')
  await assertAckError(() => recordDeliveryAcknowledgement(f.store, recordInput(f, 'review-only')), 'DELIVERY_NOT_CONFIRMED')
  assert.equal(ackPayload(f.store, f.kingdomId).length, 0, 'a rejected write leaves zero acknowledgement facts')

  addClaimedTask(f, 'accepted')
  acceptTask(f, 'accepted')
  const input = recordInput(f, 'accepted')
  await assertAckError(() => recordDeliveryAcknowledgement(f.store, { ...input, itemId: 'item:forged' }), 'DELIVERY_ITEM_UNKNOWN')
  await assertAckError(() => recordDeliveryAcknowledgement(f.store, { ...input, contentHash: 'f'.repeat(64) }), 'DELIVERY_ITEM_VERSION_STALE')
  await assertAckError(() => recordDeliveryAcknowledgement(f.store, { ...input, deliveryId: 'delivery:other:1:x' }), 'DELIVERY_VERSION_STALE')
  await assertAckError(() => recordDeliveryAcknowledgement(f.store, { ...input, attemptNo: 9 }), 'DELIVERY_VERSION_STALE')
  await assertAckError(() => recordDeliveryAcknowledgement(f.store, { ...input, ownerId: '' }), 'OWNER_CONTROL_REQUIRED')
  assert.equal(ackPayload(f.store, f.kingdomId).length, 0, 'every rejected branch keeps zero acknowledgement writes')

  const recorded = recordDeliveryAcknowledgement(f.store, input)
  assert.equal(recorded.deliveryId, input.deliveryId)
  assert.equal(recorded.eventSeq > 0, true)
  const row = f.store.getEventById(deliveryAckEventId(f.kingdomId, input.deliveryId, input.itemId, input.contentHash))!
  assert.equal(row.event_type, DELIVERY_ACK_EVENT_TYPE)
  assert.equal(row.actor_role, 'OWNER')
  assert.equal(row.actor_id, f.store.getDefaultKingdom()!.owner_id)
  assert.equal(row.target_type, 'delivery')
  assert.equal(row.target_id, input.deliveryId)
  assert.equal(row.created_at, NOW)
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>
  assert.equal(payload.contentHash, input.contentHash)
  assert.equal(payload.itemId, input.itemId)
  assert.equal(payload.meaning, 'OWNER_ACKNOWLEDGED_CURRENT_VERSION_ONLY')
  assert.equal(JSON.stringify(payload).includes('reason'), false, 'no reason or comprehension field is collected')
})

test('repeated acknowledgement of the same item version is idempotent and never writes twice', (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'accepted')
  acceptTask(f, 'accepted')
  const input = recordInput(f, 'accepted')
  const first = recordDeliveryAcknowledgement(f.store, input)
  const second = recordDeliveryAcknowledgement(f.store, input)
  assert.deepEqual(second, first)
  assert.equal(ackPayload(f.store, f.kingdomId).length, 1)
  // A different item in the same delivery is an independent fact.
  const other = recordDeliveryAcknowledgement(f.store, recordInput(f, 'accepted', 1))
  assert.notEqual(other.eventId, first.eventId)
  assert.equal(ackPayload(f.store, f.kingdomId).length, 2)
})

test('a changed item version leaves the old acknowledgement as history and requires a new one', async (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'accepted')
  acceptTask(f, 'accepted')
  const before = deriveDeliveryItems('accepted', f.store.latestWorkerResult('accepted')!)
  const input = recordInput(f, 'accepted')
  recordDeliveryAcknowledgement(f.store, input)

  // The same delivery timeline covers the next accepted attempt: identities stay, the version changes.
  f.store.insertWorkerResult({ result_id: 'result-accepted-2', task_id: 'accepted', attempt_no: 2, worker_binding_id: f.worker.binding_id,
    session_id: 'session-2', outcome: 'COMPLETED', result_json: JSON.stringify({ summary: '第二版摘要', artifacts: ['src/b.ts'], risks: [] }), created_at: NOW })
  acceptTask(f, 'accepted', 2)
  const after = deriveDeliveryItems('accepted', f.store.latestWorkerResult('accepted')!)
  assert.equal(after[0]!.itemId, before[0]!.itemId, 'the logical item keeps its identity across revision')
  assert.notEqual(after[0]!.contentHash, before[0]!.contentHash)
  assert.equal(deliveryIdFor('accepted'), input.deliveryId, 'one Task keeps one delivery timeline')

  const acknowledgements = readDeliveryAcknowledgements(f.store, f.kingdomId, input.deliveryId)
  assert.equal(acknowledgements.length, 1, 'the old version acknowledgement is preserved as history')
  const view = deliveryAcknowledgementView(acknowledgements, after[0]!, f.store.getDefaultKingdom()!.owner_id)
  assert.equal(view.state, 'PENDING_REVISION')
  assert.equal(view.acknowledged, false)
  assert.equal(view.historicalCount, 1)
  assert.equal(view.acknowledgedAt, null)

  const newInput = recordInput(f, 'accepted')
  assert.equal(newInput.deliveryId, input.deliveryId)
  assert.notEqual(newInput.contentHash, input.contentHash)
  // Replaying the exact already-recorded fact stays idempotent and never re-validates or duplicates.
  assert.deepEqual(recordDeliveryAcknowledgement(f.store, input), recordDeliveryAcknowledgement(f.store, input))
  assert.equal(ackPayload(f.store, f.kingdomId).length, 1)
  // A fabricated reference to the retired attempt cannot be recorded as a new fact.
  await assertAckError(() => recordDeliveryAcknowledgement(f.store, { ...newInput, attemptNo: input.attemptNo, resultId: input.resultId }), 'DELIVERY_VERSION_STALE')
  assert.equal(ackPayload(f.store, f.kingdomId).length, 1)
  recordDeliveryAcknowledgement(f.store, newInput)
  assert.equal(ackPayload(f.store, f.kingdomId).length, 2)
  const replayed = readDeliveryAcknowledgements(f.store, f.kingdomId, input.deliveryId)
  assert.equal(deliveryAcknowledgementView(replayed, after[0]!, f.store.getDefaultKingdom()!.owner_id).state, 'ACKNOWLEDGED')
  assert.equal(deliveryAcknowledgementView(replayed, after[0]!, f.store.getDefaultKingdom()!.owner_id).historicalCount, 1)
})

test('appending an artifact never re-points an existing risk item id at another item', (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'accepted', { artifacts: ['证据一'], risks: ['风险一', '风险二'] })
  acceptTask(f, 'accepted')
  const claim = f.store.latestWorkerResult('accepted')!
  const before = deriveDeliveryItems('accepted', claim)
  const riskBefore = before.filter(item => item.content.label.startsWith('执行者报告的风险'))
  assert.equal(riskBefore.length, 2)
  const firstRisk = before.find(item => item.content.label === '执行者报告的风险 1')!
  recordDeliveryAcknowledgement(f.store, { ...recordInput(f, 'accepted'), itemId: firstRisk.itemId,
    contentHash: firstRisk.contentHash, itemLabel: firstRisk.content.label })

  // The same accepted claim, but the Worker now declares one more artifact before the risks.
  const appended = deriveDeliveryItems('accepted', { ...claim, result_json: JSON.stringify({ summary: '完成首页与设置页改版，并给出可读摘要',
    artifacts: ['证据一', '证据二'], risks: ['风险一', '风险二'] }) } as never)
  const riskAfter = appended.filter(item => item.content.label.startsWith('执行者报告的风险'))
  assert.deepEqual(riskAfter.map(item => item.itemId), riskBefore.map(item => item.itemId), 'risk identities survive an appended artifact')
  assert.deepEqual(riskAfter.map(item => item.contentHash), riskBefore.map(item => item.contentHash), 'the same claim keeps the same risk versions')
  for (const itemId of riskBefore.map(item => item.itemId)) {
    const still = appended.find(item => item.itemId === itemId)!
    assert.equal(still.content.label.startsWith('执行者报告的风险'), true, 'an acknowledged risk id never resolves to the appended artifact')
  }
  const acknowledgements = readDeliveryAcknowledgements(f.store, f.kingdomId, deliveryIdFor('accepted'))
  const riskNow = appended.find(item => item.content.label === '执行者报告的风险 1')!
  assert.equal(deliveryAcknowledgementView(acknowledgements, riskNow, f.store.getDefaultKingdom()!.owner_id).state, 'ACKNOWLEDGED')
})

test('an outer summary acknowledgement never marks its child items acknowledged', (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'accepted', { artifacts: ['证据一', '证据二'], risks: ['风险一'] })
  acceptTask(f, 'accepted')
  const items = deriveDeliveryItems('accepted', f.store.latestWorkerResult('accepted')!)
  const ownerId = f.store.getDefaultKingdom()!.owner_id
  recordDeliveryAcknowledgement(f.store, recordInput(f, 'accepted', 0))
  const acknowledgements = readDeliveryAcknowledgements(f.store, f.kingdomId, recordInput(f, 'accepted').deliveryId)
  assert.equal(deliveryAcknowledgementView(acknowledgements, items[0]!, ownerId).state, 'ACKNOWLEDGED')
  for (const child of items.slice(1)) {
    assert.equal(deliveryAcknowledgementView(acknowledgements, child, ownerId).state, 'PENDING', child.content.label)
  }
  recordDeliveryAcknowledgement(f.store, recordInput(f, 'accepted', 3))
  const later = readDeliveryAcknowledgements(f.store, f.kingdomId, recordInput(f, 'accepted').deliveryId)
  assert.equal(deliveryAcknowledgementView(later, items[0]!, ownerId).acknowledged, true, 'a child acknowledgement never clears the summary')
  assert.equal(deliveryAcknowledgementView(later, items[1]!, ownerId).state, 'PENDING')
})

test('acknowledgements from another principal never count as Owner acknowledgement', (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'accepted')
  acceptTask(f, 'accepted')
  const input = recordInput(f, 'accepted')
  const item = deriveDeliveryItems('accepted', f.store.latestWorkerResult('accepted')!)[0]!
  f.store.appendEvent({ event_id: 'foreign-ack', kingdom_id: f.kingdomId, event_type: DELIVERY_ACK_EVENT_TYPE, actor_role: 'OWNER', actor_id: 'someone-else',
    target_type: 'delivery', target_id: input.deliveryId,
    payload_json: JSON.stringify({ version: 'KingdomDeliveryItemAck/v1', deliveryId: input.deliveryId, itemId: item.itemId, contentHash: item.contentHash }),
    created_at: NOW })
  const acknowledgements = readDeliveryAcknowledgements(f.store, f.kingdomId, input.deliveryId)
  assert.equal(acknowledgements.length, 1)
  assert.equal(deliveryAcknowledgementView(acknowledgements, item, f.store.getDefaultKingdom()!.owner_id).acknowledged, false)
  // The same record counts for its actual principal, proving the filter is by principal, not by shape.
  assert.equal(deliveryAcknowledgementView(acknowledgements, item, 'someone-else').acknowledged, true)
})

// ── 5. Canonical Owner 控制窗口：范围、冒名、失败零写入 ───────────

test('Owner window acknowledgement is scoped, idempotent and never touches task or review state', async (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'accepted')
  acceptTask(f, 'accepted')
  const handle = f.activate()
  const catalog = await f.controller.catalog(handle)
  assert.ok(catalog.deliveryItems && catalog.deliveryItems.length >= 2, 'confirmed delivery items are offered')
  assert.equal(catalog.deliveryItems!.every(item => item.acknowledgementState === 'PENDING'), true)
  assert.equal(JSON.stringify(catalog.deliveryItems).includes('private-session-should-not-leak'), false)

  const operation = ackOperation(f, 'accepted', 0)
  const { preview, receipt } = await execute(f, handle, operation)
  assert.match(preview.summary, /已知悉/u)
  assert.equal(receipt.target.type, 'delivery')
  assert.equal(receipt.target.id, recordInput(f, 'accepted').deliveryId)
  assert.equal(ackPayload(f.store, f.kingdomId).length, 1)
  const task = f.store.getTask('accepted')!
  assert.equal(task.status, 'DONE')
  assert.equal(readLatestReviewEvent(f.store, f.kingdomId, 'accepted')!.event_type, 'TASK_ACCEPTED')
  assert.equal(f.store.listEvents(f.kingdomId, 200).filter(row => row.event_type === 'TASK_ACCEPTED').length, 1)
  assert.equal(f.store.listEvents(f.kingdomId, 200).some(row => row.event_type === 'TASK_DONE' || row.event_type === 'TASK_STATUS_CHANGED'), false)

  const after = await f.controller.catalog(handle)
  const acknowledged = after.deliveryItems!.find(item => item.itemId === (operation.action === 'delivery.item.ack' ? operation.parameters.item_id : ''))
  assert.equal(acknowledged?.acknowledgementState, 'ACKNOWLEDGED')
  assert.equal(after.deliveryItems!.filter(item => item.acknowledgementState === 'ACKNOWLEDGED').length, 1)

  // The same version cannot be acknowledged twice through the canonical window.
  await assertAckError(async () => f.controller.prepare(handle, operation), 'DELIVERY_ITEM_ALREADY_ACKNOWLEDGED')
  assert.equal(ackPayload(f.store, f.kingdomId).length, 1)
})

test('the Owner window refuses out-of-scope deliveries and unconfirmed claims without writing facts', async (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'accepted')
  acceptTask(f, 'accepted')
  addClaimedTask(f, 'review-only')
  const input = recordInput(f, 'review-only')
  const operation: OwnerOperationInput = { action: 'delivery.item.ack', parameters: { task_id: 'review-only', delivery_id: input.deliveryId,
    item_id: input.itemId, content_hash: input.contentHash, attempt_no: input.attemptNo, result_id: input.resultId } }
  const handle = f.activate()
  await assertAckError(async () => f.controller.prepare(handle, operation), 'DELIVERY_NOT_CONFIRMED')
  assert.equal(ackPayload(f.store, f.kingdomId).length, 0)

  const narrow = structuredClone(f.decision)
  narrow.scope.territoryIds = []
  narrow.scope.bindingIds = []
  narrow.scope.roleTypes = ['SUPERVISOR']
  const narrowHandle = f.activate(narrow)
  const catalog = await f.controller.catalog(narrowHandle)
  assert.deepEqual(catalog.deliveryItems, [], 'an unrelated scope never offers the delivery')
  await assertAckError(async () => f.controller.prepare(narrowHandle, ackOperation(f, 'accepted', 0)), 'SCOPE_DENIED')
  assert.equal(ackPayload(f.store, f.kingdomId).length, 0)

  const empty = structuredClone(f.decision)
  empty.scope.territoryIds = []; empty.scope.bindingIds = []; empty.scope.roleTypes = []
  const emptyHandle = f.activate(empty)
  await assertAckError(async () => f.controller.prepare(emptyHandle, ackOperation(f, 'accepted', 0)), 'SCOPE_DENIED')
  assert.equal(ackPayload(f.store, f.kingdomId).length, 0)
})

test('agent or role-session surfaces cannot mint an Owner control capability', async (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'accepted')
  acceptTask(f, 'accepted')
  const input = recordInput(f, 'accepted')
  const forged = { mode: 'session-bound' as const, ownerControl: { marker: true } }
  assert.equal(isOwnerControlCapability(forged.ownerControl), false)
  await assertAckError(() => issueOwnerOperationCapability(forged.ownerControl as never, f.store, f.kingdomId,
    { operation: 'delivery.item.ack', input: {} }, { source_channel: 'LOCAL_OWNER_GUI' }), 'OWNER_CONTROL_REQUIRED')
  const workerAuth = { mode: 'session-bound' as const, principal: { sessionId: 'supervisor-session' } } as never
  await assertAckError(() => issueOwnerOperationCapability(workerAuth, f.store, f.kingdomId,
    { operation: 'delivery.item.ack', input: {} }, { source_channel: 'LOCAL_OWNER_GUI' }), 'OWNER_CONTROL_REQUIRED')
  assert.equal(ackPayload(f.store, f.kingdomId).length, 0)
  assert.equal(input.ownerId, f.store.getDefaultKingdom()!.owner_id)
})

function insertRunningExecution(f: ReturnType<typeof fixture>, taskId: string, executionId: string): void {
  f.store.insertExecution({ execution_id: executionId, task_id: taskId, attempt_no: 1, worker_binding_id: f.worker.binding_id,
    session_id: 'unrelated-session', state: 'RUNNING', detail: null, started_at: NOW, heartbeat_at: null, ended_at: null,
    pause_requested_at: null, executor_kind: 'legacy', provider: null, provider_source: null, requested_model: null,
    resolved_model: null, model_source: null, execution_profile_json: null, execution_contract: 'LEGACY_COMPAT',
    lease_id: null, capability_decision_id: null })
}

test('a pure acknowledgement is never blocked by an unrelated unsettled execution in the same territory', async (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'accepted')
  acceptTask(f, 'accepted')
  addClaimedTask(f, 'other')
  insertRunningExecution(f, 'other', 'execution-other')
  const handle = f.activate()
  const { receipt } = await execute(f, handle, ackOperation(f, 'accepted', 0))
  assert.equal(receipt.status, 'APPLIED')
  assert.equal(ackPayload(f.store, f.kingdomId).length, 1, 'the acknowledgement fact is still written')
  assert.equal(f.store.getExecution('execution-other')!.state, 'RUNNING', 'acknowledgement changes no execution state')
})

test('the Owner catalog offers exactly what prepare accepts for kingdom-wide and supervisor-scoped windows', async (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'accepted')
  acceptTask(f, 'accepted')

  const supervised = structuredClone(f.decision)
  supervised.scope.territoryIds = []
  supervised.scope.bindingIds = [f.supervisor.binding_id]
  supervised.scope.roleTypes = ['SUPERVISOR']
  const supervisedHandle = f.activate(supervised)
  const supervisedCatalog = await f.controller.catalog(supervisedHandle)
  assert.ok((supervisedCatalog.deliveryItems ?? []).length >= 2, 'a territory supervised by an in-scope binding is offered')
  await execute(f, supervisedHandle, ackOperation(f, 'accepted', 0))

  const wide = structuredClone(f.decision)
  wide.scope.kingdomWide = true
  wide.scope.territoryIds = []
  wide.scope.bindingIds = []
  wide.scope.roleTypes = []
  const wideHandle = f.activate(wide)
  const wideCatalog = await f.controller.catalog(wideHandle)
  assert.ok((wideCatalog.deliveryItems ?? []).length >= 2, 'a kingdom-wide authorization offers the same delivery')
  const { receipt } = await execute(f, wideHandle, ackOperation(f, 'accepted', 1))
  assert.equal(receipt.status, 'APPLIED')
  assert.equal(ackPayload(f.store, f.kingdomId).length, 2)
})

test('the newest confirmed delivery stays reachable when older deliveries exceed the catalog item cap', async (t) => {
  const f = fixture(t)
  const artifacts = Array.from({ length: 8 }, (_, index) => `批量证据 ${index + 1}`)
  const risks = Array.from({ length: 8 }, (_, index) => `批量风险 ${index + 1}`)
  for (let index = 0; index < 13; index += 1) {
    const taskId = `bulk-${String(index).padStart(2, '0')}`
    addClaimedTask(f, taskId, { artifacts, risks, createdAt: `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00.000Z` })
    acceptTask(f, taskId)
  }
  const handle = f.activate()
  const items = (await f.controller.catalog(handle)).deliveryItems ?? []
  assert.equal(items.length > 200, true, 'the catalog really is over the item cap')
  assert.equal(items.some(item => item.taskId === 'bulk-12'), true, 'the newest delivery is still offered')
  assert.equal(items.some(item => item.taskId === 'bulk-00'), false, 'only the oldest deliveries fall beyond the cap')
})

test('a delivery created before the cap but accepted later stays acknowledgeable and its change stays readable', async (t) => {
  const f = fixture(t)
  const artifacts = Array.from({ length: 8 }, (_, index) => `批量证据 ${index + 1}`)
  const risks = Array.from({ length: 8 }, (_, index) => `批量风险 ${index + 1}`)
  // A 先创建、最后才被接受：工作台按「最近交付」把它排在最前，Owner 目录必须一致。
  insertDeliveryTask(f, 'old-accepted', '交付 old-accepted', '2026-09-01T00:00:00.000Z')
  for (let index = 0; index < 13; index += 1) {
    const taskId = `bulk-${String(index).padStart(2, '0')}`
    addClaimedTask(f, taskId, { artifacts, risks, createdAt: `2026-09-${String(index + 2).padStart(2, '0')}T00:00:00.000Z` })
    acceptTask(f, taskId)
  }
  const handle = f.activate()
  const before = (await f.controller.catalog(handle)).deliveryItems ?? []
  assert.equal(before.length > 200, true, 'the catalog really is over the item cap')
  assert.equal(before.some(item => item.taskId === 'old-accepted'), false, 'a task that is not accepted yet is not a delivery')

  // 真实 reviewTask 的 ACCEPT 会把 old-accepted 的 updated_at 推到最新。
  const accepted = reviewAcceptTask(f, 'old-accepted', '2026-09-30T00:00:00.000Z')
  assert.equal(accepted.ok, true, accepted.ok ? '' : accepted.message)
  const catalog = (await f.controller.catalog(handle)).deliveryItems ?? []
  const oldItems = catalog.filter(item => item.taskId === 'old-accepted')
  assert.equal(oldItems.length > 0, true,
    'an old task accepted last is still offered, exactly like the workbench shows it')
  assert.equal(catalog[0]!.taskId, 'old-accepted', 'the most recently accepted delivery is ordered first')
  assert.equal(oldItems.every(item => item.acknowledgementState === 'PENDING'), true)
  const first = oldItems[0]!
  const preview = await f.controller.prepare(handle, { action: 'delivery.item.ack', parameters: {
    task_id: first.taskId, delivery_id: first.deliveryId, item_id: first.itemId, content_hash: first.contentHash,
    attempt_no: first.attemptNo, result_id: first.resultId } })
  const receipt = await f.controller.commit(handle, { prepareId: preview.prepareId, operationId: preview.operationId })
  assert.equal(receipt.status, 'APPLIED', 'the late-accepted delivery can be acknowledged')
  assert.equal(ackPayload(f.store, f.kingdomId).length, 1)
  // 再次打开目录时该条已如实标为已知悉，证明目录与提交用的是同一批条目。
  const reopened = (await f.controller.catalog(handle)).deliveryItems ?? []
  assert.equal(reopened.find(item => item.itemId === first.itemId)?.acknowledgementState, 'ACKNOWLEDGED')
})

test('the Owner catalog never returns raw absolute paths or inline secrets from a Worker Claim', async (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'accepted', { artifacts: ['C:/Users/me/secret.txt', 'token=super-secret-value', 'src/gui/workbench.ts'], risks: ['/etc/passwd'] })
  acceptTask(f, 'accepted')
  const handle = f.activate()
  const catalog = await f.controller.catalog(handle)
  const json = JSON.stringify(catalog)
  for (const leaked of ['C:/Users/me/secret.txt', 'super-secret-value', '/etc/passwd']) {
    assert.equal(json.includes(leaked), false, `Owner catalog leaked ${leaked}`)
  }
  assert.ok(json.includes('[redacted-path]'), 'absolute paths are replaced by the projection placeholder')
  assert.equal((catalog.deliveryItems ?? []).some(item => item.detail.includes('src/gui/workbench.ts')), true,
    'a repo-relative evidence string stays readable as text; it is still not a link')
  assert.equal((catalog.deliveryItems ?? []).every(item => item.changeKind === 'NOT_LOCATABLE'), true)
})

// ── 6. 工作台投影：层级、稳定 ID、版本与父子独立 ─────────────────

function workbenchOf(f: ReturnType<typeof fixture>) {
  return buildSnapshot(f.store, { auth, nowMs: Date.parse(NOW) }).projection.workbench.data
}

test('workbench exposes the summary → module → evidence hierarchy only after supervisor ACCEPT', (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'review-only', { artifacts: ['证据一'], risks: ['风险一'] })
  const before = workbenchOf(f).deliveries.items.find(item => item.taskId === 'review-only')!
  assert.equal(before.supervisorAccepted, false)
  assert.equal(before.deliveryConfirmed, false)
  assert.equal(before.deliveryId, null)
  assert.equal(before.summaryItemId, null)
  assert.equal(before.summaryAcknowledgement, null)
  assert.deepEqual(before.modules, [])
  assert.match(before.acknowledgement.note, /不适用/u)

  acceptTask(f, 'review-only')
  const after = workbenchOf(f).deliveries.items.find(item => item.taskId === 'review-only')!
  assert.equal(after.supervisorAccepted, true)
  assert.equal(after.deliveryConfirmed, true)
  assert.ok(after.deliveryId && after.attemptNo === 1)
  assert.equal(after.summary, '完成首页与设置页改版，并给出可读摘要')
  assert.ok(after.summaryItemId && after.summaryContentHash)
  assert.equal(after.summaryAcknowledgement!.state, 'PENDING')
  assert.deepEqual(after.modules.map(module => module.label), ['模块 · 产物引用', '模块 · 执行者报告的风险'])
  assert.equal(after.modules[0]!.items.length, 1)
  assert.equal(after.modules[1]!.items.length, 1)
  assert.equal(after.modules[0]!.items[0]!.layer, 'EVIDENCE')
  assert.equal(after.modules[0]!.items[0]!.acknowledgement.state, 'PENDING')
  assert.equal(JSON.stringify(after).includes('private-session-should-not-leak'), false)
})

test('workbench revision, idempotency and parent/child independence are visible and stable', (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'accepted', { artifacts: ['证据一', '证据二'] })
  acceptTask(f, 'accepted')
  const first = workbenchOf(f).deliveries.items.find(item => item.taskId === 'accepted')!
  const second = workbenchOf(f).deliveries.items.find(item => item.taskId === 'accepted')!
  assert.equal(first.deliveryId, second.deliveryId, 'delivery identity is stable across snapshot rebuilds')
  assert.equal(first.summaryItemId, second.summaryItemId)
  assert.deepEqual(first.modules[0]!.items.map(item => item.itemId), second.modules[0]!.items.map(item => item.itemId))

  recordDeliveryAcknowledgement(f.store, recordInput(f, 'accepted', 0))
  const afterSummary = workbenchOf(f).deliveries.items.find(item => item.taskId === 'accepted')!
  assert.equal(afterSummary.summaryAcknowledgement!.acknowledged, true)
  assert.equal(afterSummary.summaryAcknowledgement!.historicalCount, 0)
  assert.equal(afterSummary.modules[0]!.items[0]!.acknowledgement.acknowledged, false, 'the outer summary never covers children')
  assert.equal(afterSummary.acknowledgement.acknowledgedCount, 1)
  assert.equal(afterSummary.acknowledgement.pendingCount, 2)
  const repeated = recordDeliveryAcknowledgement(f.store, recordInput(f, 'accepted', 0))
  assert.deepEqual(repeated, recordDeliveryAcknowledgement(f.store, recordInput(f, 'accepted', 0)))
  const stable = workbenchOf(f).deliveries.items.find(item => item.taskId === 'accepted')!
  assert.equal(stable.summaryAcknowledgement!.acknowledged, true, 'a repeated click leaves exactly one acknowledgement')
  assert.equal(stable.acknowledgement.acknowledgedCount, 1)
  assert.equal(ackPayload(f.store, f.kingdomId).length, 1)

  recordDeliveryAcknowledgement(f.store, recordInput(f, 'accepted', 1))
  const partial = workbenchOf(f).deliveries.items.find(item => item.taskId === 'accepted')!
  assert.equal(partial.acknowledgement.acknowledgedCount, 2)
  assert.equal(partial.modules[0]!.items[1]!.acknowledgement.acknowledged, false)
  assert.equal(partial.modules[0]!.items[0]!.acknowledgement.acknowledged, true)
})

test('unconfirmed or unimplemented change sources are explicitly not locatable in the projection', (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'accepted', { artifacts: ['C:/Users/me/secret.txt', 'src/gui/workbench.ts', 'commit deadbeef'] })
  acceptTask(f, 'accepted')
  const item = workbenchOf(f).deliveries.items.find(entry => entry.taskId === 'accepted')!
  for (const module of item.modules) {
    for (const entry of module.items) {
      assert.equal(entry.change.kind, 'NOT_LOCATABLE')
      assert.equal(entry.change.repoPath, null)
      assert.equal(entry.change.revision, null)
      assert.ok(entry.change.reasonCode)
      assert.match(entry.change.note, /不提供改动链接/u)
    }
  }
  assert.equal(JSON.stringify(item).includes('C:/Users/me/secret.txt'), false, 'absolute paths are redacted before the browser sees them')
})

// ── 7. GUI 操作：按钮优先、图标无障碍、无假提问入口 ─────────────

test('delivery GUI keeps layered evidence text, accessible icon controls and the authorized question control', () => {
  const html = renderConsoleApp()
  for (const marker of ['第一层 · 成果摘要', '第二层 · 模块/事项', '第三层 · 证据/改动']) assert.ok(html.includes(marker), marker)
  assert.match(html, /\.icon-button:focus-visible/u)
  // R5/R6：hover/focus 必须有可见提示。可用图标按钮同样要有一个邻接提示节点，语义化
  // 禁用的图标按钮仍需可被键盘读出原因。
  assert.match(html, /\.delivery-control-hint > \.delivery-control-status\[data-control-status="AVAILABLE"\]/u)
  assert.match(html, /\.delivery-control-hint:hover > \.delivery-control-status\[data-control-status="AVAILABLE"\]/u)
  assert.match(html, /\.delivery-control-hint:focus-within > \.delivery-control-status\[data-control-status="AVAILABLE"\]/u)
  assert.match(html, /\.icon-button\[aria-disabled="true"\]/u)
  assert.match(html, /\.delivery-control-hint:focus-within > \.icon-button/u)
  assert.ok(html.includes('aria-describedby'), 'a disabled control is described by its visible reason')
  assert.ok(html.includes('markControlDisabled'), 'the disabled reason is registered, not only written into a title')
  // 可用的「查看改动 / 知悉 / 复制 / 提问」四种控件都在同一包装层登记 hover/focus 操作说明。
  assert.equal((html.match(/markControlAvailable\(control\.host, button\)/gu) || []).length, 4,
    'each available icon control registers the same hover/focus hint mechanism')
  assert.equal(/button && typeof button\.closest === 'function'/u.test(html), false,
    'the hint node is attached through its explicit wrapper instead of DOM type probing')
  assert.equal(/if \(!line\.getAttribute\('class'\)\)/u.test(html), false,
    'the hint node is written once instead of duplicating className into an attribute')
  assert.match(html, /不可定位：/u)
  assert.match(html, /已知悉：/u)
  assert.match(html, /min-height: 44px/u)
  assert.match(html, /data-ack-state/u)
  assert.match(html, /data-status-icon/u)
  // The compiled static acknowledgement glyph replaces its template placeholder exactly once per button factory.
  assert.equal(html.includes('__DELIVERY_ICON'), false, 'no icon placeholder survives rendering')
  assert.ok(html.includes('M9 11l3 3L22 4'), 'the compiled acknowledge glyph is present')
  assert.ok(html.includes('aria-hidden="true"'))
  assert.match(html, /setAttribute\('aria-label',/u)
  // 17 号 Work Order 已授权 Agent 可见的收件/回复通道，因此这里必须有一个真实提问控件，
  // 但它只做精确定位与预选：不写事实、不代替 Owner 授权，也不与知悉互相触发。
  assert.ok(html.includes('提问'), 'the authorized question control exists')
  assert.ok(html.includes('__DELIVERY_ICON_ASK__') === false, 'the question icon is compiled, not left as a placeholder')
  assert.ok(html.includes('ownerAskHref'), 'the question control hands the exact triple to the canonical Owner window')
  assert.match(html, /不可定位/u)
  assert.match(html, /逐条知悉不代表理解、质量认可、人类验收、Task DONE 或发布授权/u)
  assert.equal(GUI_SCHEMA_VERSION, 1)
})

// ── 8. 工作台 → canonical Owner 窗口：准确条目入口、去重复长文案、无写入口 ──

test('workbench acknowledgement hands the exact task/item/contentHash to the Owner window without writing', () => {
  const html = renderConsoleApp()
  // 每个知悉图标按钮都携带 exact 三元组进入 canonical Owner Window。
  assert.ok(html.includes("'/owner?ack_task='"), 'the acknowledgement control links to the canonical Owner window')
  assert.ok(html.includes("'&ack_item='"))
  assert.ok(html.includes("'&ack_hash='"))
  assert.ok(html.includes('button.onclick = () => { globalThis.location.assign(ownerAckHref(item.taskId, item.itemId, item.contentHash)); };'),
    'the icon control only navigates; the Owner still authorizes, previews, submits and gets a receipt')
  // 摘要层与证据层条目都把自己的准确 ID 与内容版本交给知悉控件。
  assert.ok(html.includes('taskId: item.taskId, itemId: item.summaryItemId, contentHash: item.summaryContentHash'),
    'the summary layer passes its exact item id and content version')
  assert.ok(html.includes('taskId: taskId,\n        itemId: item.itemId, contentHash: item.contentHash'),
    'each evidence entry passes its exact item id and content version')
  // 图标按钮去掉重复长文案，但保留 accessible name、tooltip、键盘与相邻状态文本。
  assert.equal(/append\(button, 'span', label\)/u.test(html), false, 'no duplicated visible long label remains beside the icon')
  assert.match(html, /button\.setAttribute\('aria-label', label\)/u)
  assert.match(html, /button\.title = label/u)
  assert.match(html, /\.icon-button:focus-visible/u)
  assert.match(html, /data-ack-state/u)
  // 该入口不引入 sessionStorage、别名链或任何前端写入。
  assert.equal(/sessionStorage/u.test(html), false, 'the handoff is an exact URL, not browser storage or an alias chain')
  assert.equal(/ownerAckHref\([^)]*\)\s*;\s*globalThis\.location\.hash/u.test(html), false)
  // 无可信 revision/path 时，改动入口保持诚实不可定位，不生成链接；只有主管在
  // ACCEPT 中显式选择、且本地 hash 重验通过的条目才可定位并标注固定证据级别。
  assert.match(html, /delivery-change-policy/u)
  assert.match(html, /其余条目一律显示为「不可定位」/u)
  assert.match(html, /主管确认的改动证据/u)
  assert.match(html, /立即知悉|记下已知悉/u)
})

test('workbench question control stays an exact-triple handoff and never writes by itself', () => {
  const html = renderConsoleApp()
  // 提问与知悉共用同一套预选协议，只是目标动作与 URL 参数不同。
  assert.ok(html.includes("'/owner?ask_task='"), 'the question control links to the canonical Owner window')
  assert.ok(html.includes("'&ask_item='"))
  assert.ok(html.includes("'&ask_hash='"))
  assert.ok(html.includes('button.onclick = () => { globalThis.location.assign(ownerAskHref(item.taskId, item.itemId, item.contentHash)); };'),
    'the question icon only navigates; the Owner still writes the text, previews, submits and gets a receipt')
  // 摘要层与证据层条目都把自己的准确 ID 与内容版本交给提问控件。
  assert.ok(html.includes('addAskControl(summaryControls, { label: \'成果摘要\', taskId: item.taskId, itemId: item.summaryItemId,'),
    'the summary layer passes its exact item id and content version to the question control')
  assert.ok(html.includes('addAskControl(controls, { label: item.label, taskId: taskId, itemId: item.itemId,'),
    'each evidence entry passes its exact item id and content version to the question control')
  // 提问不是知悉：两条入口各自独立，且提问控件不携带任何正文或写入。
  assert.equal(/ask[^]*?delivery\.item\.ack/u.test(html), true, 'the two actions stay separate named actions')
  assert.equal(/ownerAskHref[^)]*\)\s*;\s*globalThis\.location\.hash/u.test(html), false)
  // 带截止时间与精确原因的无障碍说明仍然存在。
  assert.match(html, /aria-disabled/u)
  assert.match(html, /data-control-status/u)
})

// A DOM double (same shape as the existing Owner UI audit helper) that executes the bound page script.
//
// `search` is the address the browser actually rendered. `redirectLocation`, when set,
// mirrors how the runner follows a 303: the executed script sees the redirect target's
// query instead of the original request's, exactly like a real new page load.
type QuestionRoute = (url: string) => { ok: boolean; status: number; json: () => Promise<unknown> }

function ownerPageHarness(options: { search: string; deliveryItems?: unknown[]; actions?: string[]; redirectLocation?: string | null;
  controlView?: { decision?: unknown; catalog?: unknown }; questionRoute?: QuestionRoute }) {
  const html = renderOwnerApp('owner-delivery-ack-nonce-1234567890')
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(html)![1]
  const locationSearch = options.redirectLocation === undefined || options.redirectLocation === null
    ? options.search
    : (options.redirectLocation.startsWith('?') ? options.redirectLocation.slice(1) : options.redirectLocation)
  const nodes = new Map<string, any>()
  // Keyboard continuity is asserted through the focused element; the double records
  // every focus() so a re-render that drops the focused button is observable.
  const focused: any[] = []
  // The same double records scrollIntoView() so the viewport intent of a history
  // click is assertable next to focus instead of being claimed from source alone.
  const scrolled: any[] = []
  class Element {
    tagName: string; children: any[] = []; listeners: Record<string, Function> = {}
    value = ''; hidden = false; disabled = false; textContent = ''; title = ''; tabIndex = 0
    classList = { add() {} }; style: Record<string, string> = {}; attributes: Record<string, string> = {}
    constructor(tag = 'div') { this.tagName = tag.toUpperCase() }
    set id(value: string) { this._id = value; nodes.set(value, this) }
    get id(): string { return this._id }
    append(...kids: any[]) { for (const kid of kids) { kid.parentElement = this; this.children.push(kid); if (this.tagName === 'SELECT' && this.children.length === 1) this.value = kid.value } }
    replaceChildren(...kids: any[]) { this.children = []; this.append(...kids) }
    addEventListener(name: string, handler: Function) { this.listeners[name] = handler }
    setAttribute(name: string, value: string) { this.attributes[name] = String(value) }
    removeAttribute(name: string) { delete this.attributes[name] }
    querySelectorAll(selector: string) {
      const descendants = this.children.flatMap((child: any) => [child, ...child.querySelectorAll('*')])
      if (selector === '[name]') return descendants.filter((child: any) => child.name)
      if (selector === '*') return descendants
      return descendants.filter((child: any) => child.tagName === selector.toUpperCase())
    }
    querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child: any) => child !== this) }
    focus() { focused.push(this) }
    scrollIntoView() { scrolled.push(this) }
  }
  for (const id of ['theme', 'status', 'activation', 'window', 'editor', 'scope', 'expiry', 'edit-fields', 'action', 'action-note', 'fields', 'prepare', 'operation-form', 'preview-panel', 'preview-summary', 'changes', 'preview-expiry', 'commit', 'edit-again', 'result-panel', 'result-title', 'result-message', 'result-meta', 'lookup', 'next', 'revoke', 'change-panel', 'change-body', 'question-thread', 'question-thread-body', 'question-history', 'question-history-list']) {
    const element = new Element(['action', 'theme'].includes(id) ? 'select' : 'div'); element.id = id
  }
  const calls: { url: string; method?: string; body?: string }[] = []
  const decision = options.controlView?.decision ?? { decisionId: 'decision-ack', kingdomId: 'kingdom-1', state: 'ACTIVE', actions: options.actions ?? ['delivery.item.ack'],
    expiresAt: new Date(Date.now() + 600000).toISOString(), scope: { kingdomWide: true, territoryIds: [], bindingIds: [] } }
  const catalog = options.controlView?.catalog ?? { deliveryItems: options.deliveryItems ?? [] }
  const fetch = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, method: init?.method, body: typeof init?.body === 'string' ? init.body : undefined })
    // 问答只能经既有精确只读 GET 读取；测试可注入有序路由以覆盖乱序响应。
    if (options.questionRoute && url.includes('/delivery-questions?')) return options.questionRoute(url)
    if (url.endsWith('/prepare')) return { ok: true, status: 200, json: async () => ({ ok: true,
      preview: { prepareId: 'prepare-1', operationId: 'operation-1', summary: '预览', changes: [], expiresAt: new Date(Date.now() + 600000).toISOString() } }) }
    const body = url.endsWith('/control')
      ? { ok: true, csrfToken: 'fixture-csrf', decision, catalog }
      : { ok: false, errorCode: 'UNEXPECTED_REQUEST', message: 'no mutation is expected from a preselect' }
    return { ok: url.endsWith('/control'), status: url.endsWith('/control') ? 200 : 500, json: async () => body }
  }
  const document = { getElementById: (id: string) => nodes.get(id), createElement: (tag: string) => new Element(tag), documentElement: { dataset: {} } }
  const storage = () => { const values = new Map<string, string>(); return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)) }, removeItem: (key: string) => { values.delete(key) } } }
  const sessionStorage = storage()
  vm.runInNewContext(script, { document, location: { search: locationSearch }, localStorage: storage(), sessionStorage,
    crypto: { randomUUID: () => 'request-1' }, fetch, setInterval() {}, Date })
  return { nodes, calls, sessionStorage, focused, scrolled, el: (id: string) => nodes.get(id) }
}

test('Owner window exposes the separate question action, preselects only the exact item and reports an illegal hint', async () => {
  const item = ackChoice()
  const other = ackChoice({ itemId: 'item:cccccccccccccccccccccccccccccccc', contentHash: 'c'.repeat(64) })
  // 授权的动作目录里同时有知悉与提问：两者是独立动作，互不触发。
  const both = ownerPageHarness({ search: '', deliveryItems: [item, other], actions: ['delivery.item.ack', 'delivery.item.question'] })
  await drain(); await drain()
  const available = both.el('action').children.map(option => option.value)
  assert.equal(available.includes('delivery.item.ack'), true)
  assert.equal(available.includes('delivery.item.question'), true)
  // 切换到提问动作：字段区给出提问专属说明、文本输入与准确接收者。
  both.el('action').value = 'delivery.item.question'
  both.el('action').listeners.change()
  assert.match(both.nodes.get('action-note').textContent, /接受该交付的主管/u)
  assert.match(both.nodes.get('action-note').textContent, /不会自动转给继任者/u)
  assert.ok(both.el('param-question_text'), 'the question text field exists')
  assert.match(textOf(both.nodes.get('delivery-question-review')), /接收者：接受该交付的主管/u)

  // 工作台带入的 ask_* 提示：只预选准确三元组，且不写任何事实。
  const preselect = ownerPageHarness({ search: '?ask_task=task-1&ask_item=' + encodeURIComponent(item.itemId) + '&ask_hash=' + item.contentHash,
    deliveryItems: [item, other], actions: ['delivery.item.ack', 'delivery.item.question'] })
  await drain(); await drain()
  assert.equal(preselect.el('action').value, 'delivery.item.question', 'the question action is preselected')
  assert.equal(preselect.el('param-item_key').value, item.itemId)
  assert.match(textOf(preselect.nodes.get('delivery-question-review')), /三者一致/u)
  assert.equal(preselect.calls.every(call => call.method === undefined), true, 'preselection issues no mutation request')
  assert.equal(preselect.sessionStorage.values.size, 0)

  // 非法或不匹配的提示：清空选择、禁用准备，不退回目录里的其他条目。
  const illegal = ownerPageHarness({ search: '?ask_task=task-1&ask_task=task-2&ask_item=x&ask_hash=y',
    deliveryItems: [item], actions: ['delivery.item.question'] })
  await drain(); await drain()
  assert.equal(illegal.el('param-item_key').value, '', 'a duplicated parameter clears the selection')
  assert.equal(illegal.el('prepare').disabled, true)
  assert.match(textOf(illegal.nodes.get('delivery-question-review')), /不会退回目录中的其他条目/u)
  assert.equal(illegal.calls.every(call => call.method === undefined), true)

  const stale = ownerPageHarness({ search: '?ask_task=task-1&ask_item=' + encodeURIComponent(item.itemId) + '&ask_hash=' + 'f'.repeat(64),
    deliveryItems: [item], actions: ['delivery.item.question'] })
  await drain(); await drain()
  assert.equal(stale.el('param-item_key').value, '')
  assert.match(textOf(stale.nodes.get('delivery-question-review')), /不会提供替代或回退选择/u)

  // 窗口没有提问动作时：不做预选，并明确说明按实际范围重新激活。
  const notAuthorized = ownerPageHarness({ search: '?ask_task=task-1&ask_item=' + encodeURIComponent(item.itemId) + '&ask_hash=' + item.contentHash,
    deliveryItems: [item], actions: ['delivery.item.ack'] })
  await drain(); await drain()
  assert.match(notAuthorized.el('status').textContent, /授权范围不包含「就一条交付条目提问」/u)
  assert.equal(notAuthorized.el('action').value === 'delivery.item.question', false)
  assert.equal(notAuthorized.calls.every(call => call.method === undefined), true)
})

const drain = () => new Promise(resolve => setImmediate(resolve))
const textOf = (node: any): string => [node?.textContent ?? '', ...(node?.children ?? []).map(textOf)].join('\n')

function ackChoice(overrides: Record<string, unknown> = {}) {
  return { taskId: 'task-1', taskTitle: '交付 task-1', deliveryId: 'delivery:task-1', attemptNo: 1, resultId: 'result-task-1',
    itemId: 'item:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', contentHash: 'a'.repeat(64), layer: 'EVIDENCE', label: '产物引用 1',
    detail: '证据文本', changeKind: 'NOT_LOCATABLE', changeNote: '不提供改动链接。', acknowledgementState: 'PENDING', acknowledgedAt: null,
    acceptanceEvidenceKind: 'EXACT_RESULT_BOUND', acceptanceEvidenceExact: true, acceptanceEvidenceNote: null,
    ...overrides }
}

const askSearch = (item: { taskId: string; itemId: string; contentHash: string }) =>
  '?ask_task=' + item.taskId + '&ask_item=' + encodeURIComponent(item.itemId) + '&ask_hash=' + item.contentHash

/** The same three-way hint for a real `DeliveryItem`, which carries no taskId of its own. */
const exactAskSearch = (taskId: string, item: { itemId: string; contentHash: string }) =>
  '?ask_task=' + taskId + '&ask_item=' + encodeURIComponent(item.itemId) + '&ask_hash=' + item.contentHash

function questionEntry(text: string, itemVersion: string) {
  return { questionId: 'question:' + 'a'.repeat(32), questionText: text, askedAt: NOW, ownerId: 'owner-1',
    reviewerBindingId: 'sup-1', replyState: 'REPLY_ACCESSIBLE', replyStateNote: '该主管仍是本领地主理且持有 ACTIVE session，可读取并回复。',
    itemVersion, currentItemContentHash: itemVersion === 'UNVERIFIABLE' ? null : 'a'.repeat(64), reply: null }
}

function questionThreadBody(itemId: string, questions: ReturnType<typeof questionEntry>[], overrides: Record<string, unknown> = {}) {
  return { questions: {
    deliveryId: 'delivery:task-1', taskId: 'task-1', itemId, itemLabel: '条目 ' + itemId, contentHash: 'a'.repeat(64),
    questions, answeredCount: questions.filter(question => question.reply !== null).length,
    pendingCount: questions.filter(question => question.reply === null && question.itemVersion === 'CURRENT').length,
    historyCount: questions.filter(question => question.itemVersion === 'HISTORICAL').length,
    unverifiableCount: questions.filter(question => question.itemVersion === 'UNVERIFIABLE').length,
    currentQuestionId: null, currentContentHash: null, note: '问答正文只经有效管理窗口读取。', ...overrides } }
}

const settle = async () => { for (let index = 0; index < 6; index += 1) await drain() }

test('a question-only window receives the real same-scope delivery catalogue and the page submits only that exact triple', async (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'ask-only', { artifacts: ['src/gui/workbench-ui.ts'], risks: [] })
  acceptTask(f, 'ask-only')
  const handle = f.activate({ ...f.decision, actions: ['delivery.item.question'] })
  const catalog = await f.controller.catalog(handle)
  const entries = catalog.deliveryItems ?? []
  assert.ok(entries.length >= 2, 'a question-only window gets the same-scope catalogue instead of an empty one')
  const item = entries.find(entry => entry.layer === 'EVIDENCE')!
  assert.ok(item, 'the catalogue really contains the accepted evidence entry')
  // 目录来自真实 controller，而不是注入的假清单：同一条目也必须能被 prepare 接受。
  const decision = f.controller.inspect(handle)!
  const harness = ownerPageHarness({ search: askSearch(item), controlView: { decision, catalog } })
  await settle()
  assert.equal(harness.el('action').value, 'delivery.item.question', 'the only authorized action is preselected')
  assert.equal(harness.el('param-item_key').value, item.itemId, 'the exact real-catalogue entry is preselected')
  assert.equal(harness.sessionStorage.values.size, 0, 'the hint is never persisted into browser storage')
  assert.equal(harness.calls.every(call => call.method === undefined), true, 'preselection issues no mutation request')
  harness.el('param-question_text').value = '这条交付是怎么验证的？'
  harness.el('operation-form').listeners.submit({ preventDefault() {} })
  await settle()
  const prepare = harness.calls.find(call => call.url.endsWith('/prepare'))
  assert.ok(prepare, 'the page submits once the Owner fills the question')
  const sent = JSON.parse(String(prepare!.body)) as { action: string; parameters: Record<string, unknown> }
  assert.equal(sent.action, 'delivery.item.question')
  assert.equal(sent.parameters.task_id, item.taskId)
  assert.equal(sent.parameters.item_id, item.itemId)
  assert.equal(sent.parameters.content_hash, item.contentHash)
  assert.equal(sent.parameters.question_text, '这条交付是怎么验证的？')
  // 提问目录不放宽「查看改动」的动作门：同一窗口仍不能读改动正文。
  await assertAckError(() => f.controller.readDeliveryChange(handle,
    { taskId: item.taskId, evidenceId: 'e'.repeat(64), entryId: 'f'.repeat(64) }), 'ACTION_NOT_AUTHORIZED')
})

test('the question panel labels every card and a slow older read never overwrites a faster re-selection', async () => {
  const itemA = ackChoice()
  const itemB = ackChoice({ itemId: 'item:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', contentHash: 'b'.repeat(64), label: '证据 B' })
  const slow: Array<(value: unknown) => void> = []
  const route: QuestionRoute = (url) => {
    const itemId = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('item') ?? ''
    if (itemId === itemB.itemId) return { ok: true, status: 200, json: async () => questionThreadBody(itemB.itemId, [questionEntry('B 的快速回答', 'CURRENT')]) }
    return { ok: true, status: 200, json: () => new Promise(resolve => slow.push(resolve)) }
  }
  const harness = ownerPageHarness({ search: askSearch(itemA), deliveryItems: [itemA, itemB], actions: ['delivery.item.question'], questionRoute: route })
  await settle()
  const body = harness.nodes.get('question-thread-body')
  assert.equal(slow.length > 0, true, 'the earlier request really is still in flight')
  // Owner 快速改选到 B：B 的响应先回来并渲染。
  harness.el('param-item_key').value = itemB.itemId
  harness.el('param-item_key').listeners.change()
  await settle()
  assert.match(textOf(body), /B 的快速回答/u)
  // 慢的 A 响应此刻才回来：必须丢弃，不能覆盖已改选后的面板。
  for (const resolve of slow) resolve(questionThreadBody(itemA.itemId, [questionEntry('A 的慢速回答', 'CURRENT')]))
  await settle()
  assert.match(textOf(body), /B 的快速回答/u)
  assert.equal(textOf(body).includes('A 的慢速回答'), false, 'a stale response never overwrites the newer panel')
})

/** A question route that answers with the real Core read for the requested exact item. */
const coreQuestionRoute = (controller: { readDeliveryQuestions: (handle: never, input: { taskId: string; itemId: string }) => unknown },
  handle: unknown): QuestionRoute => url => {
  const query = new URLSearchParams(url.slice(url.indexOf('?') + 1))
  return { ok: true, status: 200, json: async () => ({ questions: controller.readDeliveryQuestions(handle as never,
    { taskId: query.get('task') ?? '', itemId: query.get('item') ?? '' }) }) }
}

test('an exact question read re-verifies its item beyond the bounded display catalogue instead of calling it unverifiable', async (t) => {
  // A real temporary SQLite file, not an in-memory shortcut: the cap regression must
  // hold on the same durable store shape the running candidate uses.
  const dbRoot = mkdtempSync(join(tmpdir(), 'kingdom-catalogue-cap-'))
  const f = fixture(t, {}, { dbPath: join(dbRoot, 'kingdom.db'), cleanupRoot: dbRoot })
  // The questioned task is the oldest, so the bounded display catalogue never reaches it.
  addClaimedTask(f, 'task-old', { artifacts: ['证据 A', '证据 B'], risks: [] })
  acceptTask(f, 'task-old')
  // Twelve later tasks × 17 items each push every `task-old` item past the catalogue's cap.
  for (let index = 0; index < 12; index += 1) {
    const taskId = 'task-z' + String(index).padStart(2, '0')
    addClaimedTask(f, taskId, { artifacts: Array.from({ length: 8 }, (_, slot) => '产物 ' + slot),
      risks: Array.from({ length: 8 }, (_, slot) => '风险 ' + slot) })
    acceptTask(f, taskId)
  }
  const handle = f.activate({ ...f.decision, actions: ['delivery.item.question'] })
  const item = currentItems(f, 'task-old')[1]!
  await execute(f, handle, questionAsk(f, 'task-old', 1, '这条产物的验证方式是什么？'))

  const catalog = await f.controller.catalog(handle)
  assert.ok(catalog.deliveryItems!.length >= 200, 'the display catalogue stays bounded')
  assert.equal(catalog.deliveryItems!.some(entry => entry.itemId === item.itemId), false,
    'the questioned item really is truncated out of the display catalogue')

  // Exact read must independently re-derive the item and keep it CURRENT with a real pending question.
  const view = f.controller.readDeliveryQuestions(handle, { taskId: 'task-old', itemId: item.itemId })
  assert.equal(view.contentHash, item.contentHash, 'the exact read uses the real per-task version, not the capped catalogue')
  assert.equal(view.questions.length, 1)
  assert.equal(view.questions[0]!.itemVersion, 'CURRENT')
  assert.equal(view.pendingCount, 1)
  assert.equal(view.unverifiableCount, 0)
  // The write side already re-derives per task: the same item is a valid new question target.
  const preview = await f.controller.prepare(handle, questionAsk(f, 'task-old', 1, '另一个独立问题'))
  assert.equal(preview.action, 'delivery.item.question')
  // The read-only history entry from the same ledger also lists it as CURRENT.
  assert.equal((catalog.deliveryQuestionHistory ?? []).find(entry => entry.itemId === item.itemId)?.latestItemVersion, 'CURRENT')
})

test('an old question whose item left the current catalogue stays discoverable, read-only and is not a new question target', async (t) => {
  const f = fixture(t)
  const taskId = 'task-lost'
  addClaimedTask(f, taskId, { artifacts: ['证据一', '证据二', '证据三'], risks: [] })
  acceptTask(f, taskId)
  let handle = f.activate({ ...f.decision, actions: ['delivery.item.question'] })
  const gone = currentItems(f, taskId)[3]!
  await execute(f, handle, questionAsk(f, taskId, 3, '第三份证据的取舍是什么？'))
  // A new accepted attempt no longer derives that item at all: it is now genuinely unverifiable.
  f.store.insertWorkerResult({ result_id: 'result-lost-2', task_id: taskId, attempt_no: 2, worker_binding_id: f.worker.binding_id,
    session_id: 'private-session-should-not-leak', outcome: 'COMPLETED',
    result_json: JSON.stringify({ summary: '第二版', artifacts: ['证据一'], risks: [] }), created_at: NOW })
  acceptTask(f, taskId, 2)
  handle = f.activate({ ...f.decision, actions: ['delivery.item.question'] })

  const catalog = await f.controller.catalog(handle)
  assert.equal((catalog.deliveryItems ?? []).some(entry => entry.itemId === gone.itemId), false,
    'the unverifiable item is not in the current delivery catalogue')
  const history = catalog.deliveryQuestionHistory ?? []
  assert.equal(history.length, 1, 'the exact question record is still discoverable from the ledger')
  assert.equal(history[0]!.itemId, gone.itemId)
  assert.equal(history[0]!.latestItemVersion, 'UNVERIFIABLE')
  assert.equal(history[0]!.currentContentHash, null)
  assert.equal(history[0]!.questionCount, 1)

  // Exact read returns the body but labels the whole item unverifiable.
  const view = f.controller.readDeliveryQuestions(handle, { taskId, itemId: gone.itemId })
  assert.equal(view.contentHash, null)
  assert.equal(view.pendingCount, 0)
  assert.equal(view.unverifiableCount, 1)
  assert.equal(view.questions.every(question => question.itemVersion === 'UNVERIFIABLE'), true)

  // It must never become a new question target: prepare re-derives per task and rejects it.
  const claim2 = f.store.latestWorkerResult(taskId)!
  await assertAckError(() => f.controller.prepare(handle, { action: 'delivery.item.question', parameters: {
    task_id: taskId, delivery_id: deliveryIdFor(taskId), item_id: gone.itemId, content_hash: gone.contentHash,
    attempt_no: claim2.attempt_no, result_id: claim2.result_id, question_text: '还能再问吗？' } }), 'DELIVERY_ITEM_UNKNOWN')

  // The page exposes the read-only history entry and opens the real thread without any mutation.
  const decision = f.controller.inspect(handle)!
  const harness = ownerPageHarness({ search: '', controlView: { decision, catalog },
    questionRoute: coreQuestionRoute(f.controller, handle) })
  await settle()
  assert.equal(harness.el('question-history').hidden, false, 'the history panel is visible even without a deep link')
  const entries = harness.el('question-history-list').children
  assert.equal(entries.length, 1, 'the page lists exactly the discoverable question record')
  assert.match(textOf(entries[0]), /当前无法重验/u)
  assert.equal(entries[0].attributes['data-question-history'], 'READ_ONLY')
  assert.match(entries[0].title, /不会用作新提问目标/u)
  assert.equal(harness.el('param-item_key').children.some((option: any) => option.value === gone.itemId), false,
    'the history-only entry is never part of the prepare select')
  harness.focused.length = 0; harness.scrolled.length = 0
  entries[0].listeners.click()
  await settle()
  assert.match(textOf(harness.nodes.get('question-thread-body')), /第三份证据的取舍是什么/u)
  assert.match(textOf(harness.nodes.get('question-thread-body')), /无法重验/u)
  // The thread panel sits above the list: after a click the Owner must get feedback in
  // the current viewport, so focus and scroll land on the freshly rendered real heading.
  const heading = harness.nodes.get('question-thread-heading')
  assert.ok(heading, 'the real thread heading is rendered above the list')
  assert.equal(heading.tabIndex, -1, 'the heading is made programmatically focusable')
  assert.equal(harness.focused[harness.focused.length - 1], heading, 'clicking a history entry moves focus to the real thread heading')
  assert.equal(harness.scrolled[harness.scrolled.length - 1], heading, 'the viewport is brought back to the thread instead of staying at the list')
  assert.equal(harness.calls.some(call => call.method === 'POST'), false, 'opening a history entry writes nothing')

  // Scope and action gates still apply to the history entry: both windows list nothing.
  const narrowed = f.controller.activate(f.capability, { ...f.decision, actions: ['delivery.item.question'],
    scope: { ...f.decision.scope, territoryIds: [], bindingIds: [], roleTypes: [] } }).handle
  assert.deepEqual((await f.controller.catalog(narrowed)).deliveryQuestionHistory, [],
    'an out-of-scope window discovers no question history')
  const ackOnly = f.controller.activate(f.capability, { ...f.decision, actions: ['delivery.item.ack'] }).handle
  assert.deepEqual((await f.controller.catalog(ackOnly)).deliveryQuestionHistory, [],
    'a window without delivery.item.question discovers no question history')
  await assertAckError(() => f.controller.readDeliveryQuestions(ackOnly, { taskId, itemId: gone.itemId }), 'ACTION_NOT_AUTHORIZED')
})

test('a history click hands focus and the viewport to the fresh real thread, and a stale earlier read never steals them', async (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'task-h1', { artifacts: ['证据甲'], risks: [] })
  acceptTask(f, 'task-h1')
  addClaimedTask(f, 'task-h2', { artifacts: ['证据乙'], risks: [] })
  acceptTask(f, 'task-h2')
  const handle = f.activate({ ...f.decision, actions: ['delivery.item.question'] })
  const first = currentItems(f, 'task-h1')[1]!
  await execute(f, handle, questionAsk(f, 'task-h1', 1, '甲条目的验证方式？'))
  await execute(f, handle, questionAsk(f, 'task-h2', 1, '乙条目的验证方式？'))

  const decision = f.controller.inspect(handle)!
  const catalog = await f.controller.catalog(handle)
  assert.equal((catalog.deliveryQuestionHistory ?? []).length, 2, 'both questioned items are discoverable from the ledger')

  // A's exact read stays in flight; every other read is answered by the real Core.
  const core = coreQuestionRoute(f.controller, handle)
  const slow: Array<(value: unknown) => void> = []
  const route: QuestionRoute = url => {
    const itemId = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('item') ?? ''
    if (itemId === first.itemId) return { ok: true, status: 200, json: () => new Promise(resolve => slow.push(resolve)) }
    return core(url)
  }
  const harness = ownerPageHarness({ search: '', controlView: { decision, catalog }, questionRoute: route })
  await settle()
  const entries = harness.el('question-history-list').children
  assert.equal(entries.length, 2, 'the page lists both discoverable records')
  const buttonFor = (taskTitle: string) => entries.find((entry: any) => textOf(entry).includes(taskTitle))
  const firstButton = buttonFor('交付 task-h1')
  const secondButton = buttonFor('交付 task-h2')
  assert.ok(firstButton && secondButton && firstButton !== secondButton, 'each task keeps its own history button')

  // A 的读取仍在途中：不得抢焦点，也不得把视口从历史列表拉走。
  harness.focused.length = 0; harness.scrolled.length = 0
  firstButton.listeners.click()
  await settle()
  assert.equal(slow.length > 0, true, 'the earlier history read really is still in flight')
  assert.equal(harness.focused.length, 0, 'a pending history read moves no focus')
  assert.equal(harness.scrolled.length, 0, 'a pending history read moves no viewport')

  // Owner 改点 B：B 的真实 Core 线程渲染后，焦点与视口一起落到真实线程标题。
  secondButton.listeners.click()
  await settle()
  const body = harness.nodes.get('question-thread-body')
  assert.match(textOf(body), /乙条目的验证方式？/u)
  const heading = harness.nodes.get('question-thread-heading')
  assert.equal(harness.focused[harness.focused.length - 1], heading, 'focus lands on the thread the Owner actually selected')
  assert.equal(harness.scrolled[harness.scrolled.length - 1], heading, 'the viewport follows the newest selection')

  // 过期的 A 响应此刻才回来：丢弃，且绝不把焦点或视口跳回旧线程。
  harness.focused.length = 0; harness.scrolled.length = 0
  for (const resolve of slow) resolve({ questions: f.controller.readDeliveryQuestions(handle, { taskId: 'task-h1', itemId: first.itemId }) })
  await settle()
  assert.match(textOf(body), /乙条目的验证方式？/u)
  assert.equal(textOf(body).includes('甲条目的验证方式？'), false, 'the stale response never overwrites the newer panel')
  assert.equal(harness.focused.length, 0, 'a stale response never jumps focus to the old thread')
  assert.equal(harness.scrolled.length, 0, 'a stale response never pulls the viewport back to the old thread')
})

test('a fresh history read failure lands in the current viewport, and a stale earlier failure never covers or refocuses the newer thread', async (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'task-x1', { artifacts: ['证据丙'], risks: [] })
  acceptTask(f, 'task-x1')
  addClaimedTask(f, 'task-x2', { artifacts: ['证据丁'], risks: [] })
  acceptTask(f, 'task-x2')
  const handle = f.activate({ ...f.decision, actions: ['delivery.item.question'] })
  const first = currentItems(f, 'task-x1')[1]!
  await execute(f, handle, questionAsk(f, 'task-x1', 1, '丙条目的验证方式？'))
  await execute(f, handle, questionAsk(f, 'task-x2', 1, '丁条目的验证方式？'))

  const decision = f.controller.inspect(handle)!
  const catalog = await f.controller.catalog(handle)
  assert.equal((catalog.deliveryQuestionHistory ?? []).length, 2, 'both real questioned items are discoverable from the ledger')
  const core = coreQuestionRoute(f.controller, handle)
  const buttonFor = (harness: ReturnType<typeof ownerPageHarness>, taskTitle: string) =>
    harness.el('question-history-list').children.find((entry: any) => textOf(entry).includes(taskTitle))
  const itemOfUrl = (url: string) => new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('item') ?? ''

  // 新鲜失败：这一条历史条目的精确 GET 受控失败。线程详情在列表上方，失败必须落进当前
  // 视口，而不是只写在上方面板里让停在下方列表的 Owner 看不到。
  const failing: QuestionRoute = url => {
    if (itemOfUrl(url) === first.itemId) return { ok: false, status: 503,
      json: async () => ({ ok: false, errorCode: 'OWNER_READ_UNAVAILABLE', message: '受控读取失败：问答账本暂不可用。' }) }
    return core(url)
  }
  const fresh = ownerPageHarness({ search: '', controlView: { decision, catalog }, questionRoute: failing })
  await settle()
  const freshButton = buttonFor(fresh, '交付 task-x1')
  assert.ok(freshButton, 'the failing item keeps its read-only history button')
  fresh.focused.length = 0; fresh.scrolled.length = 0
  freshButton.listeners.click()
  await settle()
  const failedBody = fresh.nodes.get('question-thread-body')
  const failureNode = failedBody.children.find((child: any) => textOf(child).includes('读取失败'))
  assert.ok(failureNode, 'a fresh history read failure is written where the Owner can see it')
  assert.match(textOf(failureNode), /受控读取失败：问答账本暂不可用/u)
  assert.match(textOf(failureNode), /不会退回其他条目/u)
  assert.equal(failureNode.tabIndex, -1, 'the failure message is made programmatically focusable')
  assert.equal(fresh.focused[fresh.focused.length - 1], failureNode, 'a fresh failure moves focus to the visible failure message')
  assert.equal(fresh.scrolled[fresh.scrolled.length - 1], failureNode, 'a fresh failure brings the message into the current viewport')
  assert.equal(fresh.calls.some(call => call.method === 'POST'), false, 'a failed history read writes nothing')

  // 乱序失败：A 的失败受控停在途中，Owner 改点 B 并看到真实 Core 线程；A 的失败此刻才
  // 回来，既不得覆盖 B 的面板，也不得把焦点或视口抢回旧线程。
  const slowFailure: Array<(value: unknown) => void> = []
  const slow: QuestionRoute = url => {
    if (itemOfUrl(url) === first.itemId) return { ok: false, status: 503, json: () => new Promise(resolve => slowFailure.push(resolve)) }
    return core(url)
  }
  const stale = ownerPageHarness({ search: '', controlView: { decision, catalog }, questionRoute: slow })
  await settle()
  const staleFirst = buttonFor(stale, '交付 task-x1')
  const staleSecond = buttonFor(stale, '交付 task-x2')
  assert.ok(staleFirst && staleSecond && staleFirst !== staleSecond, 'each task keeps its own history button')
  stale.focused.length = 0; stale.scrolled.length = 0
  staleFirst.listeners.click()
  await settle()
  assert.equal(slowFailure.length > 0, true, 'the earlier failing read really is still in flight')
  assert.equal(stale.focused.length, 0, 'a pending failing read moves no focus')
  assert.equal(stale.scrolled.length, 0, 'a pending failing read moves no viewport')

  staleSecond.listeners.click()
  await settle()
  const staleBody = stale.nodes.get('question-thread-body')
  assert.match(textOf(staleBody), /丁条目的验证方式？/u)
  const heading = stale.nodes.get('question-thread-heading')
  assert.equal(stale.focused[stale.focused.length - 1], heading, 'the newer thread the Owner selected takes focus')
  assert.equal(stale.scrolled[stale.scrolled.length - 1], heading, 'the newer thread takes the current viewport')

  stale.focused.length = 0; stale.scrolled.length = 0
  for (const resolve of slowFailure) resolve({ ok: false, errorCode: 'OWNER_READ_UNAVAILABLE', message: '过期的 A 读取失败。' })
  await settle()
  assert.match(textOf(staleBody), /丁条目的验证方式？/u)
  assert.equal(textOf(staleBody).includes('读取失败'), false, 'a stale earlier failure never overwrites the newer panel')
  assert.equal(textOf(staleBody).includes('过期的 A 读取失败'), false)
  assert.equal(stale.focused.length, 0, 'a stale failure never steals focus from the newer thread')
  assert.equal(stale.scrolled.length, 0, 'a stale failure never pulls the viewport back to the old thread')
  assert.equal(stale.calls.some(call => call.method === 'POST'), false, 'zero POST across the fresh success, fresh failure and stale failure paths')
})

test('the question panel labels real current and historical cards from Core without promising a reachability it never shows', async (t) => {
  const f = fixture(t)
  const taskId = 'task-ver'
  addClaimedTask(f, taskId, { artifacts: ['第一版证据'], risks: [] })
  acceptTask(f, taskId)
  const handle = f.activate({ ...f.decision, actions: ['delivery.item.question'] })
  const first = currentItems(f, taskId)[1]!
  await execute(f, handle, questionAsk(f, taskId, 1, '第一版问题'))
  // A new accepted attempt keeps the item slot identity but changes its content version.
  f.store.insertWorkerResult({ result_id: 'result-ver-2', task_id: taskId, attempt_no: 2, worker_binding_id: f.worker.binding_id,
    session_id: 'private-session-should-not-leak', outcome: 'COMPLETED',
    result_json: JSON.stringify({ summary: '第二版摘要', artifacts: ['第二版证据'], risks: [] }), created_at: NOW })
  acceptTask(f, taskId, 2)
  const revised = currentItems(f, taskId)[1]!
  assert.equal(revised.itemId, first.itemId, 'the item slot keeps its stable identity across the revision')
  assert.notEqual(revised.contentHash, first.contentHash, 'the content version really changed')
  await execute(f, handle, questionAsk(f, taskId, 1, '第二版问题'))

  const realThread = f.controller.readDeliveryQuestions(handle, { taskId, itemId: first.itemId })
  assert.equal(realThread.historyCount, 1)
  assert.equal(realThread.pendingCount, 1)

  const decision = f.controller.inspect(handle)!
  const catalog = await f.controller.catalog(handle)
  const harness = ownerPageHarness({ search: exactAskSearch(taskId, first), controlView: { decision, catalog },
    questionRoute: coreQuestionRoute(f.controller, handle) })
  await settle()
  const body = harness.nodes.get('question-thread-body')
  const cards = () => body.children.filter((child: any) => child.attributes && child.attributes['data-item-version'])
  assert.equal(cards().length, 2, 'both real question records render, in version order')
  assert.equal(cards()[0].attributes['data-item-version'], 'HISTORICAL')
  assert.equal(cards()[1].attributes['data-item-version'], 'CURRENT')
  assert.match(textOf(cards()[1]), /已验证当前版/u)
  assert.match(textOf(cards()[0]), /只对提问时的那一内容版本有效/u)
  assert.match(textOf(cards()[0]), /不能(在现在回复|回复)/u)
  assert.equal(textOf(cards()[0]).includes('下面按现在的事实'), false, 'no promise of a supervisor status the card never shows')
  assert.equal(textOf(cards()[0]).includes('当时的可达性'), false)
  assert.match(textOf(body), /1 条当前版待领取/u)
})

test('the question panel keeps keyboard focus on the newer pager button or the last revealed record', async (t) => {
  const f = fixture(t)
  const taskId = 'task-page'
  addClaimedTask(f, taskId, { artifacts: ['证据一'], risks: [] })
  acceptTask(f, taskId)
  const handle = f.activate({ ...f.decision, actions: ['delivery.item.question'] })
  const item = currentItems(f, taskId)[1]!
  for (let index = 0; index < 101; index += 1) await execute(f, handle, questionAsk(f, taskId, 1, '分页问题 ' + index))

  const decision = f.controller.inspect(handle)!
  const catalog = await f.controller.catalog(handle)
  const harness = ownerPageHarness({ search: exactAskSearch(taskId, item), controlView: { decision, catalog },
    questionRoute: coreQuestionRoute(f.controller, handle) })
  await settle()
  const body = harness.nodes.get('question-thread-body')
  const cards = () => body.children.filter((child: any) => child.attributes && child.attributes['data-item-version'])
  assert.equal(cards().length, 50, 'the first page stays bounded')
  const pager = () => body.children.find((child: any) => child.id === 'question-more')
  let more = pager()
  assert.ok(more, 'the panel offers a bounded way to reach the remaining records')
  assert.match(more.textContent, /显示更多提问记录/u)
  assert.equal(more.textContent.includes('显示更多历史记录'), false, 'the pager names the whole list, not only history')

  harness.focused.length = 0
  more.listeners.click()
  await settle()
  assert.equal(cards().length, 100)
  more = pager()
  assert.ok(more, 'one more page still remains')
  assert.equal(harness.focused[harness.focused.length - 1], more, 'focus moves to the new pager button instead of being lost')

  harness.focused.length = 0
  more.listeners.click()
  await settle()
  assert.equal(cards().length, 101, 'the remaining record is really rendered after the click')
  assert.equal(pager(), undefined, 'no more button once everything is shown')
  assert.equal(harness.focused[harness.focused.length - 1], cards()[100], 'focus lands on the last revealed record')
  assert.equal(cards()[100].tabIndex, -1, 'the fallback record is programmatically focusable for the keyboard')
})


test('Owner window preselects only an exact task/item/contentHash triple and never writes by itself', async () => {
  const item = ackChoice()
  const other = ackChoice({ itemId: 'item:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', contentHash: 'b'.repeat(64), label: '执行者报告的风险 1' })
  const matched = ownerPageHarness({ search: '?ack_task=task-1&ack_item=' + encodeURIComponent(item.itemId) + '&ack_hash=' + item.contentHash, deliveryItems: [item, other] })
  await drain(); await drain()
  assert.equal(matched.el('param-item_key').value, item.itemId, 'the exact catalog entry is preselected')
  assert.match(textOf(matched.nodes.get('delivery-ack-review')), /三者一致/u)
  assert.equal(matched.calls.every(call => call.method === undefined), true, 'preselection issues no mutation request')
  assert.equal(matched.sessionStorage.values.size, 0, 'the handoff is never persisted into browser storage')

  // A tampered content version must not fall back to another entry in the same delivery.
  const stale = ownerPageHarness({ search: '?ack_task=task-1&ack_item=' + encodeURIComponent(item.itemId) + '&ack_hash=' + 'c'.repeat(64), deliveryItems: [item, other] })
  await drain(); await drain()
  assert.equal(stale.el('param-item_key').value, '', 'a mismatched version selects nothing')
  assert.match(textOf(stale.nodes.get('delivery-ack-review')), /无法在当前授权范围定位该条交付/u)
  assert.equal(stale.calls.every(call => call.method === undefined), true)

  // A pending reference with no catalog match at all stays unlocated instead of picking the first item.
  const unknown = ownerPageHarness({ search: '?ack_task=task-1&ack_item=' + encodeURIComponent('item:' + 'd'.repeat(32)) + '&ack_hash=' + 'd'.repeat(64), deliveryItems: [item, other] })
  await drain(); await drain()
  assert.equal(unknown.el('param-item_key').value, '')
  assert.match(textOf(unknown.nodes.get('delivery-ack-review')), /不会提供替代或回退选择/u)
})

test('Owner window refuses an out-of-scope acknowledgement target instead of widening authority', async () => {
  const item = ackChoice()
  const outOfScope = ownerPageHarness({ search: '?ack_task=task-1&ack_item=' + encodeURIComponent(item.itemId) + '&ack_hash=' + item.contentHash,
    deliveryItems: [item], actions: ['budget.policy'] })
  await drain(); await drain()
  assert.match(outOfScope.el('status').textContent, /授权范围不包含/u)
  assert.equal(outOfScope.el('action').value === 'delivery.item.ack', false, 'an unauthorized action is never preselected')
  assert.equal(outOfScope.calls.every(call => call.method === undefined), true)
  // Malformed or duplicated query parameters never produce a target, and they must not
  // silently fall back to the catalog's first entry: the selection is cleared and prepare is disabled.
  const malformed = ownerPageHarness({ search: '?ack_task=task-1&ack_task=task-2&ack_item=x&ack_hash=y', deliveryItems: [item] })
  await drain(); await drain()
  assert.equal(malformed.el('action').value, 'delivery.item.ack', 'the authorized action is still selectable')
  assert.equal(malformed.el('param-item_key').value, '', 'a duplicated parameter clears the selection instead of defaulting to the first entry')
  assert.equal(malformed.el('prepare').disabled, true, 'an illegal present hint disables prepare')
  assert.equal(malformed.calls.every(call => call.method === undefined), true, 'clearing the selection issues no mutation request')
  assert.match(textOf(malformed.nodes.get('delivery-ack-review')), /不会退回目录中的其他条目/u)
  assert.equal(textOf(malformed.nodes.get('delivery-ack-review')).includes('三者一致'), false, 'a duplicated parameter is not treated as a preselection')

  // A parameter that is present but illegal for another reason (unsafe characters) behaves the same way.
  const unsafe = ownerPageHarness({ search: '?ack_task=task-1&ack_item=' + encodeURIComponent('item:../x') + '&ack_hash=' + item.contentHash, deliveryItems: [item] })
  await drain(); await drain()
  assert.equal(unsafe.el('param-item_key').value, '', 'an illegal character clears the selection')
  assert.equal(unsafe.el('prepare').disabled, true)

  // Absent parameters remain the only case that keeps the catalog default; a valid manual choice re-enables prepare.
  const absent = ownerPageHarness({ search: '', deliveryItems: [item] })
  await drain(); await drain()
  assert.equal(absent.el('param-item_key').value, item.itemId, 'without a hint the catalog default is kept')
  malformed.el('param-item_key').value = item.itemId
  malformed.el('param-item_key').listeners.change()
  assert.equal(malformed.el('prepare').disabled, false, 'a deliberate manual selection is still usable after an illegal hint')
})

// ── 9. immutable v1.0.0 接受证据：允许知悉但必须可见地标注弱证据 ──────

test('an immutable v1.0.0 TASK_ACCEPTED without result id or digest is accepted as weaker legacy evidence only', async (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'legacy', { artifacts: ['证据一'], risks: ['风险一'] })
  acceptTaskLegacyV1(f, 'legacy')
  const claim = f.store.latestWorkerResult('legacy')!
  const review = readLatestReviewEvent(f.store, f.kingdomId, 'legacy')!
  assert.equal(review.event_type, 'TASK_ACCEPTED')

  const classification = classifyAcceptedDelivery(f.store, claim, review)
  assert.equal(classification?.kind, 'LEGACY_ATTEMPT_ONLY', 'the old shape is confirmed, not rejected')
  assert.equal(classification?.evidence.exactResultBound, false, 'legacy evidence is never reported as exact result-bound')
  assert.equal(classification?.evidence.attemptNo, 1)
  assert.equal(classification?.evidence.matchingResultCount, 1, 'exactly one WorkerResult exists for this task/attempt')
  assert.equal(classification?.evidence.resultId, claim.result_id)
  assert.equal(classification?.legacyNote, LEGACY_ACCEPTANCE_EVIDENCE_NOTE)
  assert.match(classification!.legacyNote!, /历史接受证据较弱/u)
  assert.equal(acceptedDelivery(f.store, claim, review), true, 'a legal historical ACCEPT still confirms the delivery')

  // 知悉仍可记录，且回执如实记下当时依据的弱证据。
  const handle = f.activate()
  const catalog = await f.controller.catalog(handle)
  const legacyItems = (catalog.deliveryItems ?? []).filter(item => item.taskId === 'legacy')
  assert.ok(legacyItems.length >= 2, 'a legacy delivery is offered, never silently hidden')
  assert.equal(legacyItems.every(item => item.acceptanceEvidenceKind === 'LEGACY_ATTEMPT_ONLY'), true)
  assert.equal(legacyItems.every(item => item.acceptanceEvidenceExact === false), true)
  assert.equal(legacyItems.every(item => item.acceptanceEvidenceNote === LEGACY_ACCEPTANCE_EVIDENCE_NOTE), true,
    'the Owner catalog carries the visible weak-evidence note')
  assert.equal(legacyItems.every(item => item.acknowledgementState === 'PENDING'), true)

  const { preview, receipt } = await execute(f, handle, ackOperation(f, 'legacy', 0))
  assert.equal(receipt.status, 'APPLIED')
  assert.equal(ackPayload(f.store, f.kingdomId).length, 1)
  const previewLine = preview.changes.find(change => change.label === '接受证据强度')
  assert.ok(previewLine, 'the Owner preview states the acceptance evidence strength')
  assert.match(String(previewLine!.after), /历史接受证据较弱/u)
  assert.match(String(previewLine!.after), /不是 exact result-bound/u)
  const payload = ackPayload(f.store, f.kingdomId)[0]!
  assert.equal(payload.acceptanceEvidenceKind, 'LEGACY_ATTEMPT_ONLY')
  assert.equal(payload.acceptanceEvidenceExact, false)
  const acknowledgements = readDeliveryAcknowledgements(f.store, f.kingdomId, deliveryIdFor('legacy'))
  assert.equal(acknowledgements.length, 1)
  assert.equal(acknowledgements[0]!.acceptanceEvidenceKind, 'LEGACY_ATTEMPT_ONLY')
  assert.equal(acknowledgements[0]!.acceptanceEvidenceExact, false)

  // 知悉不改任务状态、主管审查或发布状态。
  assert.equal(f.store.getTask('legacy')!.status, 'DONE')
  assert.equal(f.store.listEvents(f.kingdomId, 200).filter(row => row.event_type === 'TASK_ACCEPTED').length, 1)
})

test('a v1.0.0 shape missing any of the five real fields is rejected instead of counting as legacy evidence', (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'v1-shape')
  f.store.db.prepare('UPDATE tasks SET status = ? WHERE task_id = ?').run('DONE', 'v1-shape')
  const claim = f.store.latestWorkerResult('v1-shape')!
  const canonical = { decision: 'ACCEPT', reviewed_attempt_no: claim.attempt_no, reason: null,
    reviewer_binding_id: f.supervisor.binding_id, claimed_outcome: 'COMPLETED' }
  const accept = (eventId: string, payload: Record<string, unknown>): void => {
    f.store.appendEvent({ event_id: eventId, kingdom_id: f.kingdomId, event_type: 'TASK_ACCEPTED', actor_role: 'SUPERVISOR',
      actor_id: f.supervisor.binding_id, target_type: 'task', target_id: 'v1-shape', payload_json: JSON.stringify(payload), created_at: NOW })
  }
  const current = () => classifyAcceptedDelivery(f.store, claim, readLatestReviewEvent(f.store, f.kingdomId, 'v1-shape'))
  for (const missing of ['reason', 'reviewer_binding_id', 'claimed_outcome'] as const) {
    const payload: Record<string, unknown> = { ...canonical }
    delete payload[missing]
    accept('accept-v1-missing-' + missing, payload)
    assert.equal(current(), null, `a v1.0.0 payload without ${missing} is not the real legacy shape`)
  }
  // 真实 v1 形状仍可识别：删字段的负例不是因为整条旧格式通道被关闭。
  accept('accept-v1-complete', canonical)
  assert.equal(current()?.kind, 'LEGACY_ATTEMPT_ONLY', 'the complete five-field v1.0.0 shape is still known and accepted')
})

test('the workbench and Owner window both show the weaker historical acceptance evidence', (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'legacy', { artifacts: ['证据一'], risks: [] })
  acceptTaskLegacyV1(f, 'legacy')
  const delivery = workbenchOf(f).deliveries.items.find(item => item.taskId === 'legacy')!
  assert.equal(delivery.supervisorAccepted, true, 'a legal legacy ACCEPT still counts as delivered')
  assert.equal(delivery.deliveryConfirmed, true)
  assert.equal(delivery.acceptanceEvidence?.kind, 'LEGACY_ATTEMPT_ONLY')
  assert.equal(delivery.acceptanceEvidence?.exactResultBound, false)
  assert.equal(delivery.acceptanceEvidence?.note, LEGACY_ACCEPTANCE_EVIDENCE_NOTE)
  assert.match(delivery.acknowledgement.note, /历史接受证据较弱/u, 'the acknowledgement note repeats the weak-evidence warning')
  assert.match(delivery.acknowledgement.note, /不代表理解、质量认可/u)

  // 强证据交付不出现弱证据标注，证明这不是一条永远为真的文案。
  addClaimedTask(f, 'exact', { artifacts: ['证据一'], risks: [] })
  acceptTask(f, 'exact')
  const strong = workbenchOf(f).deliveries.items.find(item => item.taskId === 'exact')!
  assert.equal(strong.acceptanceEvidence?.kind, 'EXACT_RESULT_BOUND')
  assert.equal(strong.acceptanceEvidence?.exactResultBound, true)
  assert.equal(strong.acceptanceEvidence?.note, null)
  assert.equal(strong.acknowledgement.note.includes('历史接受证据较弱'), false)

  // 工作台界面：弱证据有可见标注元素、属性与无障碍文本，且不是只靠颜色。
  assert.match(WORKBENCH_CSS, /\.delivery-evidence-weak/u)
  assert.match(WORKBENCH_SCRIPT, /addAcceptanceEvidence/u)
  assert.match(WORKBENCH_SCRIPT, /'历史接受证据较弱'/u)
  assert.match(WORKBENCH_SCRIPT, /setAttribute\('data-acceptance-evidence', 'LEGACY_ATTEMPT_ONLY'\)/u)
  assert.match(WORKBENCH_SCRIPT, /setAttribute\('role', 'note'\)/u)
})

test('Owner window renders the weak-evidence note for a legacy delivery item instead of implying exact evidence', async () => {
  const legacy = ackChoice({ acceptanceEvidenceKind: 'LEGACY_ATTEMPT_ONLY', acceptanceEvidenceExact: false,
    acceptanceEvidenceNote: LEGACY_ACCEPTANCE_EVIDENCE_NOTE })
  const harness = ownerPageHarness({ search: '?ack_task=task-1&ack_item=' + encodeURIComponent(legacy.itemId) + '&ack_hash=' + legacy.contentHash,
    deliveryItems: [legacy] })
  await drain(); await drain()
  assert.equal(harness.el('param-item_key').value, legacy.itemId)
  const review = textOf(harness.nodes.get('delivery-ack-review'))
  assert.match(review, /历史接受证据较弱/u)
  assert.match(review, /不构成 exact result-bound 证据/u)

  // 强证据条目仍明确显示 exact result-bound，弱证据文案不出现。
  const exact = ackChoice()
  const strong = ownerPageHarness({ search: '', deliveryItems: [exact] })
  await drain(); await drain()
  const strongReview = textOf(strong.nodes.get('delivery-ack-review'))
  assert.match(strongReview, /exact result-bound/u)
  assert.equal(strongReview.includes('历史接受证据较弱'), false)
})

test('a new-format ACCEPT with only one of result id or digest is rejected instead of falling back to legacy evidence', (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'partial')
  f.store.db.prepare('UPDATE tasks SET status = ? WHERE task_id = ?').run('DONE', 'partial')
  const claim = f.store.latestWorkerResult('partial')!
  const legacyFields = { decision: 'ACCEPT', reviewed_attempt_no: claim.attempt_no, reviewer_binding_id: f.supervisor.binding_id, claimed_outcome: 'COMPLETED' }
  const accept = (eventId: string, payload: Record<string, unknown>): void => {
    f.store.appendEvent({ event_id: eventId, kingdom_id: f.kingdomId, event_type: 'TASK_ACCEPTED', actor_role: 'SUPERVISOR',
      actor_id: f.supervisor.binding_id, target_type: 'task', target_id: 'partial', payload_json: JSON.stringify(payload), created_at: NOW })
  }
  const current = () => classifyAcceptedDelivery(f.store, claim, readLatestReviewEvent(f.store, f.kingdomId, 'partial'))
  accept('accept-id-only', { ...legacyFields, reviewed_result_id: claim.result_id })
  assert.equal(current(), null, 'a lone result id is a malformed new-format ACCEPT, not legacy evidence')
  accept('accept-digest-only', { ...legacyFields, reviewed_result_digest: ownerInputHash(claim) })
  assert.equal(current(), null, 'a lone digest is a malformed new-format ACCEPT, not legacy evidence')
  accept('accept-empty-strings', { ...legacyFields, reviewed_result_id: '', reviewed_result_digest: '' })
  assert.equal(current(), null, 'empty strings are not "present" for the new format')
  accept('accept-wrong-digest', { ...legacyFields, reviewed_result_id: claim.result_id, reviewed_result_digest: 'f'.repeat(64) })
  assert.equal(current(), null, 'a mismatched digest never confirms a delivery')
  accept('accept-unknown-field', { ...legacyFields, extra_unknown_field: 'x' })
  assert.equal(current(), null, 'a payload outside the real v1.0.0 field set is not treated as legacy evidence')
  accept('accept-canonical', { ...legacyFields, reviewed_result_id: claim.result_id, reviewed_result_digest: ownerInputHash(claim) })
  assert.equal(current()?.kind, 'EXACT_RESULT_BOUND', 'the canonical new format is still strictly verified')
})

test('the worker_results schema itself guarantees the unique result per task/attempt that legacy evidence relies on', (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'ambiguous')
  // 旧格式只按 attempt 判定，因此必须证明「同一 Task/attempt 只有一份结果」不是假设。
  assert.throws(() => f.store.insertWorkerResult({ result_id: 'result-ambiguous-second', task_id: 'ambiguous', attempt_no: 1,
    worker_binding_id: f.worker.binding_id, session_id: 'session-2', outcome: 'COMPLETED',
    result_json: JSON.stringify({ summary: '另一份结果', artifacts: [], risks: [] }), created_at: NOW }),
    /UNIQUE constraint failed: worker_results\.task_id, worker_results\.attempt_no/u,
    'the durable schema rejects a second result for the same task and attempt')
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM worker_results WHERE task_id = ? AND attempt_no = ?')
    .get('ambiguous', 1)!.count, 1)
})

// ── 10. 凭据脱敏：scheme 后的真实值必须整体遮住 ──────────────────────

test('inline credentials after an authorization scheme are redacted together with their value', () => {
  for (const input of [
    'Authorization: Bearer sk-secret',
    'authorization=Bearer sk-secret',
    'Authorization: "Bearer sk-secret"',
    'request used Authorization: Bearer sk-secret today',
    'Bearer sk-lone',
    'authorization header: Bearer sk-secret;',
  ]) {
    const redacted = redactCredentialText(input)
    assert.equal(redacted.includes('sk-secret'), false, input)
    assert.equal(redacted.includes('sk-lone'), false, input)
    assert.ok(redacted.includes('[REDACTED]'), input)
  }
  // scheme 名本身不是秘密，但只遮 scheme 等于没有脱敏；完整段落被替换成单个占位符。
  assert.equal(redactCredentialText('Authorization: Bearer sk-secret'), '[REDACTED]')
  assert.equal(redactCredentialText('token=super-secret-value'), '[REDACTED]')
  // 交付文本脱敏与工作台共用同一段凭据规则，路径规则仍然生效。
  const delivery = redactDeliveryText('Authorization: Bearer sk-secret at C:/Users/me/a.txt')
  assert.equal(delivery.includes('sk-secret'), false)
  assert.equal(delivery.includes('C:/Users/me/a.txt'), false)
  assert.match(delivery, /\[REDACTED\]/u)
  assert.match(delivery, /\[redacted-path\]/u)
})

test('a credential keyword followed by natural-language prose is not a credential, while a bare bearer value still is', () => {
  // 负例：关键字与值之间没有 `=`/`:` 时，后接普通交付正文不得被当成凭据而误遮。
  for (const input of [
    'token is ready',
    'the token was rotated',
    'secret sauce shipped with this release',
    '交付摘要：token is ready',
    'password reset link was sent',
  ]) {
    assert.equal(redactCredentialText(input), input, input)
  }
  // 正例：裸 Bearer 值（含纯字母令牌）仍整体遮蔽；显式的 `=`/`:` 与不透明令牌不回退。
  assert.equal(redactCredentialText('Bearer sk-lone'), '[REDACTED]')
  assert.equal(redactCredentialText('Bearer eyJhbGciOiJIUzI1NiJ9'), '[REDACTED]')
  assert.equal(redactCredentialText('token=super-secret-value'), '[REDACTED]')
  assert.equal(redactCredentialText('token opaqueFreeTextSecret99'), '[REDACTED]')
  assert.equal(redactCredentialText('Authorization: Bearer sk-secret'), '[REDACTED]')
})

test('a bearer token inside a Worker Claim is redacted in both the Owner catalog and the workbench projection', async (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'accepted', {
    summary: '部署完成，使用 Authorization: Bearer sk-secret 访问网关',
    artifacts: ['curl -H "Authorization: Bearer sk-secret" release-artifact-7'],
    risks: ['token=super-secret-value 仍留在脚本里'],
  })
  acceptTask(f, 'accepted')

  const handle = f.activate()
  const catalog = await f.controller.catalog(handle)
  const catalogJson = JSON.stringify(catalog)
  for (const leaked of ['sk-secret', 'super-secret-value']) {
    assert.equal(catalogJson.includes(leaked), false, `Owner catalog leaked ${leaked}`)
  }
  assert.ok(catalogJson.includes('[REDACTED]'), 'the Owner catalog shows the placeholder instead')
  assert.equal((catalog.deliveryItems ?? []).some(item => item.detail.includes('release-artifact-7')), true,
    'the non-secret remainder of the evidence text stays readable')

  const workbenchJson = JSON.stringify(workbenchOf(f))
  for (const leaked of ['sk-secret', 'super-secret-value']) {
    assert.equal(workbenchJson.includes(leaked), false, `workbench projection leaked ${leaked}`)
  }
  assert.ok(workbenchJson.includes('[REDACTED]'))
})

// ── 11. 未激活路径：工作台复制准确命令 → direct owner.gui hint → 一次性票据 → 303 → 预选 ──

/**
 * 在 vm 中运行工作台脚本里被抽取的那一段函数（复制命令构造、剪贴板回退、一次性
 * Owner 激活命令按钮）。只暴露一个 `__test` 出口，模拟真实按钮 click/复制，而不是
 * 另写一套等价逻辑。
 */
function extraction(source: string, marker: string, end: string): string {
  const start = source.indexOf(marker)
  assert.ok(start >= 0, `${marker} exists in the workbench script`)
  const stop = source.indexOf(end, start)
  assert.ok(stop > start, `${marker} extraction boundary exists`)
  return source.slice(start, stop)
}

function workbenchCopyHarness(options: { clipboard?: boolean } = {}) {
  const copy = extraction(WORKBENCH_SCRIPT, 'const ownerLaunchCommand = (entry, action) => {', '    const renderWorkbenchDelivery')
  const copied: string[] = []
  class Element {
    tagName: string; children: any[] = []; listeners: Record<string, Function> = {}; attributes: Record<string, string> = {}
    value = ''; textContent = ''; title = ''; disabled = false; className = ''; parentElement: any = null
    constructor(tag = 'div') { this.tagName = tag.toUpperCase() }
    append(...kids: any[]) { for (const kid of kids) { kid.parentElement = this; this.children.push(kid) } }
    addEventListener(name: string, handler: Function) { this.listeners[name] = handler }
    setAttribute(name: string, value: string) { this.attributes[name] = String(value) }
    getAttribute(name: string) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null }
    removeAttribute(name: string) { delete this.attributes[name] }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child: any) => child !== this) }
    querySelector(selector: string) {
      // 真实 DOM 的 querySelector 递归搜索后代；控件提示包了一层可访问包装，因此这里也递归。
      const descendants = this.children.flatMap((child: any) => [child, ...child.querySelectorAll('*')])
      if (selector === '[data-copy-status]') return descendants.find((child: any) => String(child.className).includes('delivery-copy-status')) ?? null
      return null
    }
    querySelectorAll(selector = '*') {
      if (selector === '*') return this.children.flatMap((child: any) => [child, ...child.querySelectorAll('*')])
      return this.children.filter((child: any) => child.tagName === selector.toUpperCase())
    }
  }
  const document = { createElement: (tag: string) => new Element(tag), body: new Element('body') }
  const context: Record<string, unknown> = {
    document,
    navigator: options.clipboard === false ? {} : { clipboard: { writeText: (value: string) => { copied.push(String(value)); return Promise.resolve() } } },
    append: (parent: any, tag: string, value: unknown, className?: string) => { const node = new Element(tag)
      if (value !== undefined && value !== null) node.textContent = String(value); if (className) node.className = className
      parent.append(node); return node },
    Promise,
  }
  const addIconButton = (parent: any, _iconHtml: string, label: string, key: string) => { const button = new Element('button')
    button.setAttribute('aria-label', label); button.setAttribute('data-focus-key', key); parent.append(button); return button }
  const api = new Function('addIconButton', 'append', 'globalThis', `${copy}
    return { ownerLaunchCommand, addLaunchHintControl };`)(addIconButton, context.append, context) as {
    ownerLaunchCommand: (entry: Record<string, unknown>, action?: string) => string
    addLaunchHintControl: (parent: unknown, entry: Record<string, unknown>, key: string, action?: string) => any
  }
  const parent = new Element('div'); parent.append(new Element('div'))
  const entry = { kingdomId: 'kingdom-1', territoryId: 'territory-1', supervisorBindingId: 'binding-supervisor',
    taskId: 'task-1', itemId: 'item:' + 'a'.repeat(32), contentHash: 'b'.repeat(64) }
  const button = api.addLaunchHintControl(parent, entry, 'delivery:task-1:launch')
  return { copied, api, button, parent, entry }
}

test('the workbench copy icon produces the exact minimal direct owner.gui command and really copies it on click', async () => {
  const harness = workbenchCopyHarness()
  const command = harness.api.ownerLaunchCommand(harness.entry)
  assert.ok(command.startsWith('/kingdom owner.gui '), 'the copy target is the direct Owner Control command')
  const envelope = JSON.parse(command.slice('/kingdom owner.gui '.length)) as Record<string, any>
  assert.deepEqual(envelope.actions, ['delivery.item.ack'], 'the command requests exactly the acknowledgement action')
  assert.equal(envelope.hintAction, 'ack')
  // 提问有各自独立的最小命令：只申请提问动作，并带回提问意图（hintAction）。
  const askCommand = harness.api.ownerLaunchCommand(harness.entry, 'ask')
  const askEnvelope = JSON.parse(askCommand.slice('/kingdom owner.gui '.length)) as Record<string, any>
  assert.deepEqual(askEnvelope.actions, ['delivery.item.question'], 'the question command requests exactly the question action')
  assert.equal(askEnvelope.hintAction, 'ask')
  assert.deepEqual(askEnvelope.scope, envelope.scope, 'both commands carry the same exact territory scope')
  assert.equal(askEnvelope.taskHint, 'task-1')
  assert.equal(askEnvelope.itemHint, harness.entry.itemId)
  assert.equal(askEnvelope.contentHashHint, harness.entry.contentHash)
  assert.equal(askCommand.includes('ticket'), false)
  // 复制命令只申请本条领地范围：主管绑定可能在快照之后退任或更换，命令不得依赖过时 binding。
  assert.deepEqual(envelope.scope, { kingdomWide: false, territoryIds: ['territory-1'], bindingIds: [],
    roleTypes: [], targetSessionIds: [], workspaceRoots: [] }, 'the scope is the exact territory, never kingdomWide and never a stale binding')
  assert.equal(envelope.kingdomId, 'kingdom-1')
  assert.equal(envelope.taskHint, 'task-1')
  assert.equal(envelope.itemId, undefined, 'the hint is never mixed into the authorized envelope')
  assert.equal(envelope.itemHint, harness.entry.itemId)
  assert.equal(envelope.contentHashHint, harness.entry.contentHash)
  assert.equal(envelope.ticket, undefined, 'the copied command never contains a launch ticket')
  assert.equal(command.includes('ticket'), false)
  // 命令不引用任何主管绑定：即使快照里的绑定已退任或更换，命令仍是「本领地 + 准确条目」。
  const withoutBinding = JSON.parse(harness.api.ownerLaunchCommand({ ...harness.entry, supervisorBindingId: null }).slice('/kingdom owner.gui '.length))
  assert.deepEqual(withoutBinding.scope, envelope.scope, 'the copied command is identical with or without a snapshot binding')
  assert.equal(command.includes('binding-supervisor'), false, 'no stale supervisor binding is baked into the copied command')
  assert.deepEqual(envelope.scope.bindingIds, [])
  assert.deepEqual(envelope.scope.roleTypes, [])

  // 真实 click 走剪贴板写入路径；按钮可达名称与提示不重复长文案。
  const button = harness.button
  assert.equal(button.disabled, false, 'an exact item enables the copy control')
  assert.equal(button.attributes['data-focus-key'], 'delivery:task-1:launch')
  assert.match(button.attributes['aria-label'], /复制本条 Owner 激活命令/u)
  assert.match(button.title, /不含票据|不授权/u)
  // R6：可用按钮也登记了 hover/focus 操作说明，且 aria-describedby 指向真实存在的提示节点
  // （不是只有 title，也不是为禁用分支单独写的文本）。
  const availableHint = harness.parent.children.flatMap((child: any) => child.children ?? [])
    .find((node: any) => node.attributes && node.attributes.id === button.attributes['aria-describedby'])
  assert.ok(availableHint, 'an available control points at its own hover/focus hint node')
  assert.equal(availableHint!.attributes['data-control-status'], 'AVAILABLE')
  assert.match(String(availableHint!.textContent), /复制|owner\.gui/u, 'the hint carries the operation description')
  assert.equal(harness.copied.length, 0)
  // 真实 click：页面脚本绑定的是 onclick，测试直接触发它，不另写等价复制逻辑。
  button.onclick()
  await drain(); await drain()
  assert.equal(harness.copied.length, 1, 'the click actually writes the command to the clipboard')
  assert.equal(harness.copied[0], command)
  // 提问控件真实复制提问专用命令，而不是退化成知悉命令。
  const askButton = harness.api.addLaunchHintControl(harness.parent, harness.entry, 'delivery:task-1:launch-ask', 'ask')
  askButton.onclick()
  await drain(); await drain()
  assert.equal(harness.copied.length, 2)
  assert.equal(harness.copied[1], askCommand)
  const status = harness.parent.querySelector('[data-copy-status]')
  assert.ok(status, 'a copy status line is rendered next to the control')
  assert.equal(status!.attributes['data-copy-status'], 'COPIED')
  assert.match(status!.textContent, /命令已复制/u)

  // 缺少准确范围或版本时按钮语义化禁用，且不生成任何命令。
  const missing = harness.api.addLaunchHintControl(harness.parent, { ...harness.entry, territoryId: null }, 'delivery:task-1:launch-2')
  assert.equal(missing.attributes['aria-disabled'], 'true', 'a missing exact scope marks the copy control aria-disabled instead of widening it')
  assert.equal(missing.attributes['data-disabled'], 'true')
  assert.match(missing.title, /替代范围/u)
  assert.ok(missing.attributes['aria-describedby'], 'the disabled control points at its visible reason')
  const reasonNode = harness.parent.children.flatMap(child => child.children ?? [])
    .find(node => node.attributes && node.attributes.id === missing.attributes['aria-describedby'])
  assert.ok(reasonNode, 'the visible reason node really exists next to the control')
  assert.match(String(reasonNode.textContent), /缺少准确的王国、领地、任务或内容版本/u)

  // 渲染后的工作台页面里，图标占位符已被静态资源替换，且没有引入任何浏览器存储或别名链。
  const html = renderConsoleApp()
  assert.equal(html.includes('__DELIVERY_ICON_COPY__'), false, 'the copy glyph placeholder never survives rendering')
  assert.ok(html.includes('<rect x="9" y="9" width="11" height="11" rx="2" />'), 'the compiled copy glyph is rendered')
  assert.match(html, /data-copy-status/u)
  assert.equal(/sessionStorage/u.test(html), false, 'the launch hint is an exact command string, not browser storage')
})

test('the copy icon reports a real failure instead of faking success when the browser has no clipboard', async () => {
  const harness = workbenchCopyHarness({ clipboard: false })
  const command = harness.api.ownerLaunchCommand(harness.entry)
  assert.ok(command.startsWith('/kingdom owner.gui '), 'the command text is still constructible without a clipboard')
  const button = harness.button
  assert.equal(button.disabled, false, 'the control stays enabled: the failure is reported after the click, not hidden')
  button.onclick()
  await drain(); await drain()
  assert.equal(harness.copied.length, 0, 'nothing is written anywhere when no Clipboard API exists')
  const status = harness.parent.querySelector('[data-copy-status]')
  assert.ok(status, 'the failure is reported next to the control')
  assert.equal(status!.attributes['data-copy-status'], 'FAILED', 'the status is explicitly FAILED, never COPIED')
  assert.match(status!.textContent, /命令未复制/u)
  assert.match(status!.textContent, /Clipboard API/u)
  assert.equal(/命令已复制/u.test(status!.textContent), false, 'a failed copy never claims the command was copied')
  // 也不再有无法验证结果的旧式复制回退：脚本里不存在这套路径。
  assert.equal(/execCommand/u.test(WORKBENCH_SCRIPT), false, 'no unverifiable copy fallback remains')
  assert.equal(/owner-launch-scratch/u.test(WORKBENCH_SCRIPT), false, 'the scratch element fallback is deleted, not left dead')
})

test('owner.gui hint fields are validated as a whole, rejected before activation, and never widen authorization', async () => {
  const f = fixture(undefined)
  try {
    const itemId = 'item:' + 'a'.repeat(32)
    const valid = { task: 'task-1', item: itemId, contentHash: 'b'.repeat(64) }
    assert.deepEqual(validateLaunchAckHint(valid), { ok: true, hint: { ...valid, action: 'ack' } })
    assert.deepEqual(normalizeLaunchAckHint(valid), { ...valid, action: 'ack' })
    // 提问命令必须把动作意图一并带来：默认仍是知悉，只有显式 ask 才预选提问。
    assert.deepEqual(validateLaunchAckHint({ ...valid, action: 'ask' }), { ok: true, hint: { ...valid, action: 'ask' } })
    for (const bad of ['delete', 'ACK', '', 7, null]) {
      assert.equal(validateLaunchAckHint({ ...valid, action: bad }).ok, false, JSON.stringify(bad))
    }
    // 只有动作而没有任何定位字段同样是无效提示，不静默丢弃。
    assert.equal(validateLaunchAckHint({ action: 'ask' }).ok, false)
    // 未携带提示仍是合法激活；只是不会预选。
    assert.deepEqual(validateLaunchAckHint({ task: undefined, item: undefined, contentHash: undefined }), { ok: true, hint: null })
    assert.deepEqual(validateLaunchAckHint(undefined), { ok: true, hint: null })

    // 三字段必须完整：缺少任一字段都是输入错误，整体拒绝，不部分采用。
    for (const partial of [
      { task: 'task-1' },
      { item: itemId },
      { contentHash: valid.contentHash },
      { task: 'task-1', item: itemId },
      { task: 'task-1', contentHash: valid.contentHash },
      { item: itemId, contentHash: valid.contentHash },
    ]) {
      const checked = validateLaunchAckHint(partial)
      assert.equal(checked.ok, false, JSON.stringify(partial))
      assert.match((checked as { message: string }).message, /必须同时提供/u)
      assert.equal(normalizeLaunchAckHint(partial), null, 'a partial hint is never partially adopted')
    }
    // 字段齐全但格式无效同样是错误，不是「静默丢弃后照常激活」。
    for (const malformed of [
      { ...valid, task: '../etc' },
      { ...valid, task: '' },
      { ...valid, item: 'x' },
      { ...valid, item: 'item:' + 'A'.repeat(32) },
      { ...valid, item: itemId + '0' },
      { ...valid, contentHash: 'b'.repeat(63) },
      { ...valid, contentHash: 'B'.repeat(64) },
      { task: 7, item: itemId, contentHash: valid.contentHash },
    ]) {
      const checked = validateLaunchAckHint(malformed as never)
      assert.equal(checked.ok, false, JSON.stringify(malformed))
      assert.equal(normalizeLaunchAckHint(malformed as never), null)
    }

    // hint 只是定位文本：它不是授权，也不进入 OwnerDecisionInput。
    const parsed = JSON.parse(JSON.stringify({ kingdomId: f.kingdomId, actions: ['delivery.item.ack'],
      scope: f.decision.scope, ttlMs: 600000,
      taskHint: 'task-1', itemHint: itemId, contentHashHint: 'b'.repeat(64) })) as Record<string, unknown>
    const { taskHint, itemHint, contentHashHint, ...authorization } = parsed
    assert.equal(Object.hasOwn(authorization, 'taskHint'), false)
    assert.deepEqual(Object.keys(authorization).sort(), ['actions', 'kingdomId', 'scope', 'ttlMs'])
    // 提示不改变授权：授权范围仍是 Owner 声明的领地范围，没有因 hint 扩大。
    const activation = f.controller.activate(f.capability, authorization as never)
    assert.deepEqual(activation.decision.scope, f.decision.scope)
    assert.deepEqual(activation.decision.actions, ['delivery.item.ack'])
    f.controller.revoke(activation.handle)

    // 激活前拒绝：非法提示既不激活窗口，也不写出任何管理决定事实。
    let now = Date.parse('2026-09-27T06:00:00.000Z')
    const origin = 'http://127.0.0.1:43210'
    const manager = new OwnerLocalControlManager({ controller: f.controller, expectedOrigin: () => origin, now: () => now })
    try {
      const decisionEventsBefore = f.store.listEvents(f.kingdomId, 400).filter(row => row.event_type === 'OWNER_DECISION_CREATED').length
      for (const bad of [{ task: 'task-1' }, { task: 'task-1', item: 'x', contentHash: 'b'.repeat(64) }]) {
        const error = await new Promise<{ code?: string; status?: number; message?: string } | null>(resolve => {
          try { manager.activate(f.capability, f.decision, bad); resolve(null) } catch (thrown) { resolve(thrown as never) }
        })
        assert.ok(error, 'an incomplete or malformed hint must not activate a window')
        const failure = error as { code?: string; status?: number }
        assert.equal(failure.code, 'OWNER_LAUNCH_HINT_INVALID')
        assert.equal(failure.status, 400)
        assert.equal(f.store.listEvents(f.kingdomId, 400).filter(row => row.event_type === 'OWNER_DECISION_CREATED').length, decisionEventsBefore,
          'a rejected hint writes no Owner decision fact')
      }
      // 未携带提示时 Location 必须是精确的 /owner，不附带任何 ack_* 参数。
      const navigation = { origin, host: '127.0.0.1:43210', remoteAddress: '127.0.0.1', fetchSite: 'none' } as never
      const none = manager.activate(f.capability, f.decision)
      const noneRedirect = manager.redeem(none.launchTicket, navigation)
      assert.equal(noneRedirect.redirectPath, '/owner', 'without a hint the redirect path stays exactly /owner')
      // 三个字段完整有效时才保存提示，并在兑换后只带这三个参数。
      const hinted = manager.activate(f.capability, f.decision, { task: 'task-1', item: itemId, contentHash: 'b'.repeat(64) })
      const hintedRedirect = manager.redeem(hinted.launchTicket, navigation)
      const query = new URLSearchParams(hintedRedirect.redirectPath.slice(hintedRedirect.redirectPath.indexOf('?') + 1))
      assert.deepEqual([...query.keys()].sort(), ['ack_hash', 'ack_item', 'ack_task'])
      assert.equal(hintedRedirect.redirectPath.includes('ticket'), false, 'the redirect never carries the one-time ticket')
      // 提问命令兑换后必须回到提问预选，而不是退化成 ack_* 而丢掉提问动作。
      const asked = manager.activate(f.capability, f.decision, { task: 'task-1', item: itemId, contentHash: 'b'.repeat(64), action: 'ask' })
      const askedRedirect = manager.redeem(asked.launchTicket, navigation)
      const askedQuery = new URLSearchParams(askedRedirect.redirectPath.slice(askedRedirect.redirectPath.indexOf('?') + 1))
      assert.deepEqual([...askedQuery.keys()].sort(), ['ask_hash', 'ask_item', 'ask_task'])
      assert.equal(askedQuery.get('ask_task'), 'task-1')
      assert.equal(askedQuery.get('ask_item'), itemId)
      assert.equal(askedQuery.get('ask_hash'), 'b'.repeat(64))
      assert.equal(askedRedirect.redirectPath.includes('ticket'), false, 'the redirect never carries the one-time ticket')
      // 非法动作在激活前整体拒绝，不激活任何窗口。
      const badAction = await new Promise<{ code?: string } | null>(resolve => {
        try { manager.activate(f.capability, f.decision, { task: 'task-1', item: itemId, contentHash: 'b'.repeat(64), action: 'delete' }); resolve(null) } catch (thrown) { resolve(thrown as never) }
      })
      assert.equal((badAction as { code?: string }).code, 'OWNER_LAUNCH_HINT_INVALID')
      now += 1
    } finally { manager.dispose() }
  } finally { f.dispose() }
})

test('a real HTTP ticket redemption 303s to the exact ack query and a fresh empty-sessionStorage page preselects it with zero writes', async (t) => {
  const f = fixture(t)
  addClaimedTask(f, 'launch', { artifacts: ['src/gui/workbench-ui.ts'], risks: [] })
  acceptTask(f, 'launch')
  let now = Date.now()
  let origin = ''
  const manager = new OwnerLocalControlManager({ controller: f.controller, expectedOrigin: () => origin, now: () => now })
  let resolveReady!: (value: string) => void
  const ready = new Promise<string>(resolve => { resolveReady = resolve })
  const close = startGuiServer({ snapshot: () => ({}) as never, taskDetail: () => null, eventsSince: () => ({ revision: 0, events: [] }),
    command: async () => ({}) as never },
  { port: 0, token: 'unrelated-role-bearer', ownerControl: manager, onListening: address => { origin = address.origin; resolveReady(origin) } })
  await ready
  try {
    const handle = f.activate()
    const catalog = await f.controller.catalog(handle)
    const item = (catalog.deliveryItems ?? []).find(entry => entry.layer === 'EVIDENCE')!
    assert.ok(item, 'the accepted delivery offers at least one evidence entry')
    // 人类从工作台复制并直接执行的那条命令：hint 与授权输入分离，不含票据。
    const activation = manager.activate(f.capability, f.decision, { task: item.taskId, item: item.itemId, contentHash: item.contentHash })
    const launchUrl = origin + activation.launchPath + '?ticket=' + encodeURIComponent(activation.launchTicket)
    assert.equal(launchUrl.includes('ack_'), false, 'the copied launch URL carries no ack query before redemption')

    // 真实 HTTP：票据兑换后 303 到不含 ticket 的 /owner?ack_*。
    const redeemed = await fetch(launchUrl, { redirect: 'manual' })
    assert.equal(redeemed.status, 303)
    const location = redeemed.headers.get('location')!
    assert.equal(location.startsWith('/owner?ack_task='), true, location)
    assert.equal(location.includes('ticket'), false, 'the redirect never carries the one-time ticket')
    const redirectQuery = new URLSearchParams(location.slice(location.indexOf('?') + 1))
    assert.equal(redirectQuery.get('ack_task'), item.taskId)
    assert.equal(redirectQuery.get('ack_item'), item.itemId)
    assert.equal(redirectQuery.get('ack_hash'), item.contentHash)
    assert.equal([...redirectQuery.keys()].length, 3, 'only the three locating hints are carried')
    const cookie = redeemed.headers.get('set-cookie')!.split(';', 1)[0]!
    assert.match(cookie, /^dsh_kingdom_owner=/u)

    // 重放同一票据不再兑换，也不产生任何写入。
    const afterRedeem = f.store.listEvents(f.kingdomId, 400).length
    const replay = await fetch(launchUrl, { redirect: 'manual' })
    assert.notEqual(replay.status, 303)
    assert.equal(f.store.listEvents(f.kingdomId, 400).length, afterRedeem, 'a replayed ticket writes nothing')

    // 新标签页：cookie 有效、sessionStorage 为空，页面只做预选，不提交、不写知悉。
    const control = await fetch(origin + '/api/owner/control', { headers: { cookie } })
    assert.equal(control.status, 200)
    const view = await control.json() as { decision: unknown; csrfToken: string; catalog: unknown }
    assert.ok(view.csrfToken, 'the redeemed cookie yields the real control view')
    const page = await fetch(origin + location, { headers: { cookie } })
    assert.equal(page.status, 200)
    const pageHtml = await page.text()
    assert.equal(pageHtml.includes(activation.launchTicket), false, 'the served page never contains the one-time ticket')
    assert.equal(pageHtml.includes(item.contentHash), false, 'the hint is applied to the selection, not baked into the page')
    const harness = ownerPageHarness({
      search: location.slice(location.indexOf('?')),
      controlView: { decision: view.decision, catalog: view.catalog },
    })
    await drain(); await drain()
    assert.equal(harness.sessionStorage.values.size, 0, 'the new page starts with an empty sessionStorage and stays that way')
    assert.equal(harness.el('param-item_key').value, item.itemId, 'the exact hinted entry is preselected from the real catalog')
    assert.match(textOf(harness.nodes.get('delivery-ack-review')), /三者一致/u)
    assert.equal(harness.calls.every(call => call.method === undefined), true, 'preselection issues no mutation request')
    assert.equal(ackPayload(f.store, f.kingdomId).length, 0, 'no acknowledgement fact exists before the Owner commits')

    // 错误 scope 的窗口：目录里没有该条，页面不得预选，更不能以其他条目或 kingdomWide 兜底。
    const wrongScope = { ...f.decision, scope: { ...f.decision.scope, territoryIds: [], bindingIds: [], roleTypes: [] } }
    const narrowed = manager.activate(f.capability, wrongScope as never, { task: item.taskId, item: item.itemId, contentHash: item.contentHash })
    const narrowedRedeem = await fetch(origin + narrowed.launchPath + '?ticket=' + encodeURIComponent(narrowed.launchTicket), { redirect: 'manual' })
    assert.equal(narrowedRedeem.status, 303)
    const narrowedCookie = narrowedRedeem.headers.get('set-cookie')!.split(';', 1)[0]!
    const narrowedControl = await fetch(origin + '/api/owner/control', { headers: { cookie: narrowedCookie } })
    const narrowedView = await narrowedControl.json() as { decision: unknown; catalog: any }
    assert.deepEqual(narrowedView.catalog.deliveryItems, [], 'a window without the delivery scope lists no delivery items')
    const outOfScopeLocation = narrowedRedeem.headers.get('location') ?? ''
    const outOfScope = ownerPageHarness({
      search: outOfScopeLocation.slice(outOfScopeLocation.indexOf('?')),
      controlView: { decision: narrowedView.decision, catalog: narrowedView.catalog },
    })
    await drain(); await drain()
    assert.equal(outOfScope.el('param-item_key').value, '', 'an out-of-scope hint selects nothing')
    assert.equal(outOfScope.el('prepare').disabled, true)
    assert.match(textOf(outOfScope.nodes.get('delivery-ack-review')), /不会提供替代或回退选择/u)
    assert.equal(outOfScope.calls.every(call => call.method === undefined), true)

    // 重放票据在页面侧也无法产生知悉：原始事件数不变。
    assert.equal(f.store.listEvents(f.kingdomId, 400).filter(row => row.event_type === DELIVERY_ACK_EVENT_TYPE).length, 0)
    assert.equal(ackPayload(f.store, f.kingdomId).length, 0, 'the replayed ticket still writes zero acknowledgement facts')
    // 提示不会被持久化到页面、日志或命令文本之外。
    assert.equal(launchUrl.includes(encodeURIComponent(item.contentHash)), false, 'the ticket URL never carries the hint')

    // 交付问答只读路由：必须精确给出 task/item 两个参数、必须带有效窗口 cookie。
    // 该窗口已在上面的重放兑换中被替换，因此重新兑换一次票据取得当前有效 cookie。
    const fresh = manager.activate(f.capability, { ...f.decision, actions: ['delivery.item.ack', 'delivery.item.question'] },
      { task: item.taskId, item: item.itemId, contentHash: item.contentHash })
    const freshRedeem = await fetch(origin + fresh.launchPath + '?ticket=' + encodeURIComponent(fresh.launchTicket), { redirect: 'manual' })
    assert.equal(freshRedeem.status, 303)
    const freshCookie = freshRedeem.headers.get('set-cookie')!.split(';', 1)[0]!
    const questionsUrl = origin + '/api/owner/delivery-questions?task=' + encodeURIComponent(item.taskId) + '&item=' + encodeURIComponent(item.itemId)
    const questionsNoCookie = await fetch(questionsUrl)
    assert.equal(questionsNoCookie.status, 401, 'the question read route requires a real Owner window')
    const questionsWrongShape = await fetch(questionsUrl + '&extra=1', { headers: { cookie: freshCookie } })
    assert.equal(questionsWrongShape.status, 400, 'extra query parameters are rejected')
    const questionsNoRecord = await fetch(questionsUrl, { headers: { cookie: freshCookie } })
    assert.equal(questionsNoRecord.status, 409)
    const noRecordBody = await questionsNoRecord.json() as { ok: boolean; errorCode?: string; questions?: unknown }
    assert.equal(noRecordBody.ok, false)
    assert.equal(noRecordBody.errorCode, 'DELIVERY_QUESTION_UNKNOWN', 'an item without questions is reported, not fabricated')
    // 只读：读取问答不写任何事实。
    assert.equal(f.store.listEvents(f.kingdomId, 400).filter(row =>
      row.event_type === DELIVERY_QUESTION_EVENT_TYPE || row.event_type === DELIVERY_REPLY_EVENT_TYPE).length, 0)
  } finally { close(); manager.dispose() }
})
