/**
 * 交付条目提问 → 主管专属收件 → 一次回复 → Owner 授权回读的闭环（17 号 Work Order）。
 *
 * 覆盖范围刻意只针对本轮新增事实与边界：
 * - Owner 只能经 canonical 管理窗口 prepare/commit 写入问题，重复提交幂等；
 * - 问题写给它被接受时的那个主管 binding，`TASK_ACCEPTED` 之后改绑/退任/换 session
 *   一律不可达且不被自动改投；
 * - 主管经 session-bound 入口从权威 events 账本读取只属于自己的问题并回复一次；
 * - 普通 snapshot / TaskDetail.relatedEvents / recentEvents / 事件轮询不暴露正文；
 * - 失败路径零写入：错主管、跨领地、伪造 questionId、冲突回复、条目改版。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KingdomStore } from '../lib/core/db.js'
import { issueOwnerControlCapability, ownerControlAuth } from '../lib/core/owner-control.js'
import { initializeKingdomFacts } from '../lib/core/kingdom.js'
import { bindRole, rebindSession, unbindRole } from '../lib/core/binding.js'
import { createTerritory, setTerritorySupervisor } from '../lib/core/territory.js'
import { reviewTask } from '../lib/core/task-service.js'
import type { CommandContext } from '../lib/core/task-service.js'
import { OwnerDecisionController, type OwnerDecisionControllerOptions, type OwnerDecisionInput, type OwnerOperationInput } from '../lib/core/owner-window.js'
import {
  DELIVERY_QUESTION_EVENT_TYPE,
  DELIVERY_REPLY_EVENT_TYPE,
  DELIVERY_REPLY_STATES,
  classifyDeliveryReplyAccess,
  deliveryContentHash,
  deliveryIdFor,
  deliveryQuestionEventId,
  deliveryQuestionThreadForItem,
  deliveryReplyEventId,
  deliveryReviewerBindingId,
  deriveDeliveryItems,
  readDeliveryQuestionInbox,
  readDeliveryQuestionInboxForSession,
  readDeliveryQuestionThread,
  replyToDeliveryQuestion,
} from '../lib/core/delivery-ack.js'
import { buildSnapshot, buildTaskDetail, toEventView } from '../lib/gui/snapshot.js'
import { buildPersonalWorkbench } from '../lib/gui/workbench.js'
import { buildSnapshot as snapshotForWorkbench } from '../lib/gui/snapshot.js'

const NOW = '2026-09-27T06:00:00.000Z'
const sessionBound = { mode: 'session-bound' as const, trustLevel: 'session-verified' as const, note: '' }
const declarative = { mode: 'declarative' as const, trustLevel: 'local-demo' as const, note: '' }

async function expectError(operation: () => unknown | Promise<unknown>, code: string): Promise<void> {
  try {
    await operation()
  } catch (error) {
    const actual = (error as { code?: string }).code
      ?? (error instanceof Error && error.message.startsWith(code) ? code : undefined)
    assert.equal(actual, code, (error as Error).message)
    return
  }
  assert.fail('expected a rejection with code ' + code)
}

interface FixtureOptions { actions?: string[]; dbPath?: string }

function fixture(t: { after(fn: () => void): void } | undefined, options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kingdom-delivery-question-'))
  const store = new KingdomStore(options.dbPath ?? ':memory:')
  const initialized = store.withImmediateTransaction(() => initializeKingdomFacts(store, '交付问答测试王国', '人类所有者'))
  const kingdomId = initialized.kingdomId
  const capability = issueOwnerControlCapability()
  const ownerAuth = ownerControlAuth(capability)
  bindRole(store, { kingdomId, roleType: 'SUPERVISOR', roleName: '主管甲', sessionId: 'supervisor-session-a' }, ownerAuth)
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
  const controller = new OwnerDecisionController(store, defaults)
  const actions = options.actions ?? ['delivery.item.ack', 'delivery.item.question']
  const decision: OwnerDecisionInput = {
    kingdomId, actions: actions as OwnerDecisionInput['actions'], ttlMs: 600000,
    scope: { kingdomWide: false, territoryIds: [territory.territory_id], bindingIds: [], roleTypes: [], targetSessionIds: [], workspaceRoots: [] },
  }
  const dispose = (): void => { controller.dispose(); store.close(); rmSync(root, { recursive: true, force: true }) }
  t?.after(() => { dispose() })
  const activate = (input: OwnerDecisionInput = decision) => controller.activate(capability, input).handle
  return { root, store, kingdomId, supervisor, worker, territory, controller, decision, capability, ownerAuth, activate, dispose }
}

/** 建一条 REVIEW 任务并用真实 reviewTask ACCEPT，因此接受事件与状态迁移都是生产形状。 */
function acceptTask(f: ReturnType<typeof fixture>, taskId: string, supervisorSessionId = 'supervisor-session-a',
  territoryId = f.territory.territory_id): { resultId: string } {
  const createdAt = NOW
  f.store.insertTask({ task_id: taskId, territory_id: territoryId, parent_task_id: null, title: '交付 ' + taskId,
    description: '清楚的范围', assigned_binding_id: f.worker.binding_id, status: 'REVIEW',
    acceptance_criteria: '核验产物', result_summary: null, created_at: createdAt, updated_at: createdAt })
  const resultId = 'result-' + taskId
  f.store.insertWorkerResult({ result_id: resultId, task_id: taskId, attempt_no: 1, worker_binding_id: f.worker.binding_id,
    session_id: 'private-session-should-not-leak', outcome: 'COMPLETED',
    result_json: JSON.stringify({ summary: '完成 ' + taskId, artifacts: ['证据一'], risks: [] }), created_at: createdAt })
  const result = reviewTask(f.store, { kingdomId: f.kingdomId, principal: { sessionId: supervisorSessionId }, auth: sessionBound },
    { taskId, decision: 'ACCEPT', reason: '问答闭环夹具' })
  assert.equal(result.ok, true, result.message)
  return { resultId }
}

function itemOf(f: ReturnType<typeof fixture>, taskId: string, index = 0) {
  const claim = f.store.latestWorkerResult(taskId)!
  return deriveDeliveryItems(taskId, claim)[index]!
}

function ackInputFor(f: ReturnType<typeof fixture>, taskId: string, itemIndex = 0): OwnerOperationInput {
  const claim = f.store.latestWorkerResult(taskId)!
  const item = deriveDeliveryItems(taskId, claim)[itemIndex]!
  return { action: 'delivery.item.ack', parameters: { task_id: taskId, delivery_id: deliveryIdFor(taskId),
    item_id: item.itemId, content_hash: item.contentHash, attempt_no: claim.attempt_no, result_id: claim.result_id } }
}

function questionOperation(f: ReturnType<typeof fixture>, taskId: string, questionText: string, itemIndex = 0): OwnerOperationInput {
  const claim = f.store.latestWorkerResult(taskId)!
  const item = deriveDeliveryItems(taskId, claim)[itemIndex]!
  return { action: 'delivery.item.question', parameters: { task_id: taskId, delivery_id: deliveryIdFor(taskId),
    item_id: item.itemId, content_hash: item.contentHash, attempt_no: claim.attempt_no, result_id: claim.result_id,
    question_text: questionText } }
}

async function ask(f: ReturnType<typeof fixture>, handle: ReturnType<ReturnType<typeof fixture>['activate']>, input: OwnerOperationInput) {
  const preview = await f.controller.prepare(handle, input)
  const receipt = await f.controller.commit(handle, { prepareId: preview.prepareId, operationId: preview.operationId })
  return { preview, receipt }
}

function questionEvents(f: ReturnType<typeof fixture>): Record<string, unknown>[] {
  return f.store.listEvents(f.kingdomId, 500).filter(row => row.event_type === DELIVERY_QUESTION_EVENT_TYPE)
    .map(row => JSON.parse(row.payload_json) as Record<string, unknown>)
}

function replyEvents(f: ReturnType<typeof fixture>): Record<string, unknown>[] {
  return f.store.listEvents(f.kingdomId, 500).filter(row => row.event_type === DELIVERY_REPLY_EVENT_TYPE)
    .map(row => JSON.parse(row.payload_json) as Record<string, unknown>)
}

function supervisorContext(f: ReturnType<typeof fixture>, sessionId = 'supervisor-session-a', mode: 'session-bound' | 'declarative' = 'session-bound'): CommandContext {
  return { kingdomId: f.kingdomId, auth: mode === 'declarative' ? declarative : sessionBound, principal: { sessionId } }
}

function inboxFor(f: ReturnType<typeof fixture>, bindingId: string, territoryIds?: string[]) {
  return readDeliveryQuestionInbox(f.store, f.kingdomId, { reviewerBindingId: bindingId, territoryIds })
}

// ── 1. Owner 提问事实 ────────────────────────────────────────────────

test('the canonical Owner window records exactly one bounded question fact and is idempotent on retry', async (t) => {
  const f = fixture(t)
  acceptTask(f, 'task-q1')
  const handle = f.activate()
  const input = questionOperation(f, 'task-q1', '请说明这次改动的回滚方式。')

  const first = await ask(f, handle, input)
  assert.equal(first.receipt.status, 'APPLIED')
  assert.equal(first.receipt.target.type, 'delivery')
  assert.equal(questionEvents(f).length, 1)
  const payload = questionEvents(f)[0]!
  assert.equal(payload.questionText, '请说明这次改动的回滚方式。')
  assert.equal(payload.reviewerBindingId, f.supervisor.binding_id)
  assert.equal(payload.itemId, itemOf(f, 'task-q1').itemId)
  assert.equal(payload.contentHash, itemOf(f, 'task-q1').contentHash)
  assert.equal(payload.acceptanceEvidenceKind, 'EXACT_RESULT_BOUND')

  // 同一 prepared operation 重试：回执幂等，不新增事实。
  const again = await f.controller.commit(handle, { prepareId: first.preview.prepareId, operationId: first.preview.operationId })
  assert.equal(again.operationId, first.receipt.operationId)
  assert.equal(again.receiptSeq, first.receipt.receiptSeq)
  assert.equal(questionEvents(f).length, 1)

  // 重新 prepare 同一文本是**另一次 Owner operation**：提问身份属于那次操作，而不是正文。
  // 因此它必须形成第二条独立事实 —— 绝不能被历史同文问题吞掉。
  const replay = await ask(f, handle, input)
  assert.notEqual(replay.preview.operationId, first.preview.operationId, '每次 prepare 都有自己的操作编号')
  assert.equal(questionEvents(f).length, 2, '新操作即使文本相同也是独立问题事实')
  assert.equal(questionEvents(f)[1]!.questionText, '请说明这次改动的回滚方式。')
  assert.notEqual(questionEvents(f)[1]!.questionId, questionEvents(f)[0]!.questionId)

  // 同一 operation 的事件 ID 仍精确可核对：重放命中既有事实，不会写出第二条。
  const item = itemOf(f, 'task-q1')
  assert.ok(f.store.getEventById(deliveryQuestionEventId({ kingdomId: f.kingdomId, deliveryId: deliveryIdFor('task-q1'),
    itemId: item.itemId, contentHash: item.contentHash, operationId: replay.preview.operationId })))

  // 不同的新问题仍可形成独立事实。
  await ask(f, handle, questionOperation(f, 'task-q1', '第二个问题：这条改动的取舍是什么？'))
  assert.equal(questionEvents(f).length, 3)

  // 提问不写知悉、不改任务状态。
  assert.equal(f.store.listEvents(f.kingdomId, 500).filter(row => row.event_type === 'OWNER_DELIVERY_ITEM_ACKNOWLEDGED').length, 0)
  assert.equal(f.store.getTask('task-q1')!.status, 'DONE')
})

test('the question action is authorized separately from acknowledgement and refuses stale or forged references with zero writes', async (t) => {
  const f = fixture(t, { actions: ['delivery.item.question'] })
  acceptTask(f, 'task-q2')
  const handle = f.activate()
  await ask(f, handle, questionOperation(f, 'task-q2', '这条改动怎么回滚？'))
  assert.equal(questionEvents(f).length, 1)

  const item = itemOf(f, 'task-q2')
  const claim = f.store.latestWorkerResult('task-q2')!
  const base = { task_id: 'task-q2', delivery_id: deliveryIdFor('task-q2'), item_id: item.itemId,
    content_hash: item.contentHash, attempt_no: claim.attempt_no, result_id: claim.result_id }

  await expectError(() => f.controller.prepare(handle, { action: 'delivery.item.question', parameters: { ...base, question_text: '旧版本' } as never }).then(() =>
    f.controller.prepare(handle, { action: 'delivery.item.question', parameters: { ...base, content_hash: 'f'.repeat(64), question_text: 'x' } })), 'DELIVERY_ITEM_VERSION_STALE')
  await expectError(() => f.controller.prepare(handle, { action: 'delivery.item.question',
    parameters: { ...base, item_id: 'item:' + 'a'.repeat(32), question_text: 'x' } }), 'DELIVERY_ITEM_UNKNOWN')
  await expectError(() => f.controller.prepare(handle, { action: 'delivery.item.question',
    parameters: { ...base, delivery_id: 'delivery:other', question_text: 'x' } }), 'DELIVERY_VERSION_STALE')
  await expectError(() => f.controller.prepare(handle, { action: 'delivery.item.question',
    parameters: { ...base, attempt_no: 7, question_text: 'x' } }), 'DELIVERY_VERSION_STALE')
  // 空问题与超长问题都被拒绝。
  await expectError(() => f.controller.prepare(handle, { action: 'delivery.item.question',
    parameters: { ...base, question_text: '   ' } }), 'INVALID_INPUT')
  await expectError(() => f.controller.prepare(handle, { action: 'delivery.item.question',
    parameters: { ...base, question_text: 'x'.repeat(2001) } }), 'INVALID_INPUT')
  assert.equal(questionEvents(f).length, 1, 'every rejected attempt writes nothing')
})

test('a question is refused for an unconfirmed delivery and for a window without the action', async (t) => {
  const f = fixture(t, { actions: ['delivery.item.question'] })
  // REVIEW 任务尚未被主管 ACCEPT：不能提问。
  f.store.insertTask({ task_id: 'task-unconfirmed', territory_id: f.territory.territory_id, parent_task_id: null, title: '未确认',
    description: null, assigned_binding_id: f.worker.binding_id, status: 'REVIEW', acceptance_criteria: null,
    result_summary: null, created_at: NOW, updated_at: NOW })
  f.store.insertWorkerResult({ result_id: 'result-unconfirmed', task_id: 'task-unconfirmed', attempt_no: 1, worker_binding_id: f.worker.binding_id,
    session_id: 's', outcome: 'COMPLETED', result_json: JSON.stringify({ summary: '自述', artifacts: [], risks: [] }), created_at: NOW })
  const handle = f.activate()
  const claim = f.store.latestWorkerResult('task-unconfirmed')!
  const item = deriveDeliveryItems('task-unconfirmed', claim)[0]!
  await expectError(() => f.controller.prepare(handle, { action: 'delivery.item.question',
    parameters: { task_id: 'task-unconfirmed', delivery_id: deliveryIdFor('task-unconfirmed'), item_id: item.itemId,
      content_hash: item.contentHash, attempt_no: 1, result_id: 'result-unconfirmed', question_text: 'x' } }), 'DELIVERY_NOT_CONFIRMED')
  assert.equal(questionEvents(f).length, 0)

  // 窗口只授权了知悉：不能读取问答正文，也不能提问。
  acceptTask(f, 'task-q3')
  const ackItem = itemOf(f, 'task-q3')
  await ask(f, f.activate({ ...f.decision, actions: ['delivery.item.ack', 'delivery.item.question'] }), ackInputFor(f, 'task-q3'))
  await ask(f, f.activate(), questionOperation(f, 'task-q3', '先写入一条问题'))
  const ackOnlyRead = f.activate({ ...f.decision, actions: ['delivery.item.ack'] })
  await expectError(() => f.controller.readDeliveryQuestions(ackOnlyRead, { taskId: 'task-q3', itemId: ackItem.itemId }), 'ACTION_NOT_AUTHORIZED')
  await expectError(() => f.controller.prepare(ackOnlyRead, questionOperation(f, 'task-q3', '另一个问题')), 'SCOPE_DENIED')
  assert.equal(questionEvents(f).length, 1)
})

// ── 2. 主管专属收件箱与一次回复 ──────────────────────────────────────

test('the bound supervisor reads only its own questions from the authoritative ledger and replies exactly once', async (t) => {
  const f = fixture(t)
  acceptTask(f, 'task-r1')
  const handle = f.activate()
  await ask(f, handle, questionOperation(f, 'task-r1', '回滚步骤是什么？'))
  await ask(f, handle, questionOperation(f, 'task-r1', '第二个问题：影响哪些文件？'))
  const questionId = questionEvents(f)[0]!.questionId as string

  // 只属于该 binding 的问题；正文只在 session-bound 入口可见。
  const inbox = inboxFor(f, f.supervisor.binding_id, [f.territory.territory_id])
  assert.equal(inbox.length, 2)
  assert.equal(inbox[0]!.question.questionText, '回滚步骤是什么？')
  assert.equal(inbox[0]!.question.replyState, 'REPLY_ACCESSIBLE')
  assert.deepEqual(inboxFor(f, 'binding-other'), [], 'another binding never sees these questions')

  const replied = replyToDeliveryQuestion(f.store, supervisorContext(f), { questionId, replyText: '按 evidence id 回滚对应提交。' })
  assert.equal(replied.ok, true, replied.ok ? replied.text : replied.message)
  assert.equal(replyEvents(f).length, 1)
  assert.equal(replyEvents(f)[0]!.responderBindingId, f.supervisor.binding_id)
  assert.equal(replyEvents(f)[0]!.questionId, questionId)

  // 同一文本重试幂等；冲突回复被拒绝。
  const retry = replyToDeliveryQuestion(f.store, supervisorContext(f), { questionId, replyText: '按 evidence id 回滚对应提交。' })
  assert.equal(retry.ok, true)
  assert.match(retry.ok ? retry.text : '', /未新增第二条事实/u)
  assert.equal(replyEvents(f).length, 1)
  const conflict = replyToDeliveryQuestion(f.store, supervisorContext(f), { questionId, replyText: '换一个说法。' })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.ok === false ? conflict.code : '', 'REPLY_ALREADY_RECORDED')
  assert.equal(replyEvents(f).length, 1)

  // 回复只写这一条对话事实：不写知悉、Task/Claim/ACCEPT/Owner acceptance/发布。
  const types = f.store.listEvents(f.kingdomId, 500).map(row => row.event_type)
  assert.equal(types.includes('OWNER_DELIVERY_ITEM_ACKNOWLEDGED'), false)
  assert.equal(types.filter(type => type === 'TASK_ACCEPTED').length, 1)
  assert.equal(f.store.getTask('task-r1')!.status, 'DONE')

  // 第二条问题仍未回复；问题按提问顺序列出。
  const after = inboxFor(f, f.supervisor.binding_id)
  assert.equal(after[0]!.question.reply, null)
  assert.equal(after[1]!.question.reply?.replyText, '按 evidence id 回滚对应提交。')
})

test('the supervisor entry is session-bound by default: declarative, wrong session, other binding and forged ids all write nothing', async (t) => {
  const f = fixture(t)
  acceptTask(f, 'task-r2')
  const handle = f.activate()
  await ask(f, handle, questionOperation(f, 'task-r2', '这次改动如何回滚？'))
  const questionId = questionEvents(f)[0]!.questionId as string

  const declarativeResult = replyToDeliveryQuestion(f.store, supervisorContext(f, 'supervisor-session-a', 'declarative'),
    { questionId, replyText: 'declarative 不应放行' })
  assert.equal(declarativeResult.ok, false)
  assert.equal(declarativeResult.ok === false ? declarativeResult.code : '', 'DELIVERY_QUESTION_SESSION_REQUIRED')

  const wrongSession = replyToDeliveryQuestion(f.store, supervisorContext(f, 'someone-else'), { questionId, replyText: 'wrong session' })
  assert.equal(wrongSession.ok, false)
  assert.equal(wrongSession.ok === false ? wrongSession.code : '', 'UNAUTHORIZED_PRINCIPAL')

  const forged = replyToDeliveryQuestion(f.store, supervisorContext(f), { questionId: 'question:' + 'a'.repeat(32), replyText: 'forged' })
  assert.equal(forged.ok, false)
  assert.equal(forged.ok === false ? forged.code : '', 'QUESTION_NOT_FOUND')

  const empty = replyToDeliveryQuestion(f.store, supervisorContext(f), { questionId, replyText: '   ' })
  assert.equal(empty.ok, false)
  assert.equal(empty.ok === false ? empty.code : '', 'INVALID_INPUT')

  const unreachableInbox = inboxFor(f, f.supervisor.binding_id)
  assert.equal(unreachableInbox.length, 1)
  assert.equal(replyEvents(f).length, 0, 'no failed path writes a reply')
})

test('a retired, re-sessioned or re-bound reviewer keeps the question visible but unreachable, and never hands it to a successor', async (t) => {
  const f = fixture(t)

  // (a) 退任：问题仍可见、明确不可达。
  acceptTask(f, 'task-r3')
  const handle = f.activate()
  await ask(f, handle, questionOperation(f, 'task-r3', '退任后还能回复吗？'))
  const questionId = questionEvents(f)[0]!.questionId as string
  unbindRole(f.store, { kingdomId: f.kingdomId, bindingId: f.supervisor.binding_id }, f.ownerAuth)
  const retired = replyToDeliveryQuestion(f.store, supervisorContext(f), { questionId, replyText: '迟到的回复' })
  assert.equal(retired.ok, false)
  assert.equal(retired.ok === false ? retired.code : '', 'UNAUTHORIZED_PRINCIPAL')
  const retiredThread = readDeliveryQuestionThread(f.store, f.kingdomId, deliveryIdFor('task-r3'))!
  assert.equal(retiredThread.questions[0]!.replyState, 'REVIEWER_BINDING_RETIRED')
  assert.equal(replyEvents(f).length, 0)
  // (b) 换 session：ACTIVE 但 session 已更换 → 不可达。
  const f2 = fixture(t)
  acceptTask(f2, 'task-r4')
  const handle2 = f2.activate()
  await ask(f2, handle2, questionOperation(f2, 'task-r4', '换了 session 还能回复吗？'))
  const questionId2 = questionEvents(f2)[0]!.questionId as string
  rebindSession(f2.store, { kingdomId: f2.kingdomId, bindingId: f2.supervisor.binding_id, sessionId: 'supervisor-session-b' }, f2.ownerAuth)
  const stale = replyToDeliveryQuestion(f2.store, supervisorContext(f2), { questionId: questionId2, replyText: '旧 session 的回复' })
  assert.equal(stale.ok, false)
  assert.equal(stale.ok === false ? stale.code : '', 'UNAUTHORIZED_PRINCIPAL')
  // 展示线程仍能看到原接收主管，但把「已换 session」如实标为不可达。
  const rebindThread = readDeliveryQuestionThread(f2.store, f2.kingdomId, deliveryIdFor('task-r4'))!
  assert.equal(classifyDeliveryReplyAccess(f2.store, f2.kingdomId, f2.supervisor.binding_id,
    f2.territory.territory_id ? f2.store.getTerritoryById(f2.territory.territory_id)!.supervisor_binding_id : null,
    'supervisor-session-a').state, 'REVIEWER_SESSION_CHANGED')
  assert.equal(rebindThread.questions[0]!.replyState, 'REPLY_ACCESSIBLE', 'the binding itself is still current; the stale caller is refused')

  // (c) 领地改绑给继任主管：继任者不能代答，问题也不改投。
  bindRole(f2.store, { kingdomId: f2.kingdomId, roleType: 'SUPERVISOR', roleName: '主管乙', sessionId: 'supervisor-session-c' }, f2.ownerAuth)
  const successor = f2.store.getBindingsByRole(f2.kingdomId, 'SUPERVISOR').find(binding => binding.session_id === 'supervisor-session-c')!
  setTerritorySupervisor(f2.store, { kingdomId: f2.kingdomId, territoryId: f2.territory.territory_id, supervisorBindingId: successor.binding_id }, f2.ownerAuth)
  const successorAttempt = replyToDeliveryQuestion(f2.store, supervisorContext(f2, 'supervisor-session-c'),
    { questionId: questionId2, replyText: '继任者代答' })
  assert.equal(successorAttempt.ok, false)
  assert.equal(successorAttempt.ok === false ? successorAttempt.code : '', 'QUESTION_NOT_ADDRESSED_TO_CALLER')
  const reboundThread = readDeliveryQuestionThread(f2.store, f2.kingdomId, deliveryIdFor('task-r4'))!
  assert.equal(reboundThread.questions[0]!.replyState, 'SUPERVISOR_REBOUND')
  assert.equal(reboundThread.questions[0]!.reply, null, 'the question is never transferred')
  assert.equal(replyEvents(f2).length, 0)
  assert.ok(DELIVERY_REPLY_STATES.includes('SUPERVISOR_REBOUND'))
})

test('a changed item version makes the old question and reply historical without moving them to the new content', async (t) => {
  const f = fixture(t)
  acceptTask(f, 'task-r5')
  const handle = f.activate()
  await ask(f, handle, questionOperation(f, 'task-r5', '旧版本的问题'))
  const questionId = questionEvents(f)[0]!.questionId as string
  const replied = replyToDeliveryQuestion(f.store, supervisorContext(f), { questionId, replyText: '旧版本的回复' })
  assert.equal(replied.ok, true)

  // 同一交付的新内容版本：条目 ID 不变、内容版本变化。
  const previousItem = itemOf(f, 'task-r5')
  // 尚未提交的提问不会写入任何事实。
  const pendingPreview = await f.controller.prepare(f.activate(), questionOperation(f, 'task-r5', '针对新版本的新问题'))
  assert.ok(pendingPreview.prepareId)
  assert.equal(questionEvents(f).length, 1, 'no question is written before commit')
  f.store.insertWorkerResult({ result_id: 'result-task-r5-b', task_id: 'task-r5', attempt_no: 2, worker_binding_id: f.worker.binding_id,
    session_id: 'private-session-should-not-leak', outcome: 'COMPLETED',
    result_json: JSON.stringify({ summary: '第二次交付', artifacts: ['证据一'], risks: [] }), created_at: NOW })
  const nextItem = itemOf(f, 'task-r5')
  assert.equal(nextItem.itemId, previousItem.itemId, 'the logical item keeps its stable id')
  assert.notEqual(nextItem.contentHash, previousItem.contentHash, 'the content version tracks the new text')

  const thread = deliveryQuestionThreadForItem(readDeliveryQuestionThread(f.store, f.kingdomId, deliveryIdFor('task-r5')),
    nextItem.itemId, nextItem.contentHash)!
  assert.equal(thread.questions.length, 1)
  assert.equal(thread.historyCount, 1, 'the old question is only history for the new version')
  assert.equal(thread.pendingCount, 0)

  // 旧版本的问题在当前内容版本下不可回复：回复校验以**问题记录**为准，先于当前交付校验。
  const stale = replyToDeliveryQuestion(f.store, supervisorContext(f), { questionId, replyText: '对旧版本的第二条回复' })
  assert.equal(stale.ok, false)
  assert.equal(stale.ok === false ? stale.code : '', 'REPLY_ALREADY_RECORDED')

  // 尚未回复的旧版本问题：条目内容版本漂移后也不能再写回复。
  const f2 = fixture(t)
  acceptTask(f2, 'task-r6')
  const handle2 = f2.activate()
  await ask(f2, handle2, questionOperation(f2, 'task-r6', '尚待回复的旧版本问题'))
  const pendingQuestionId = questionEvents(f2)[0]!.questionId as string
  // 历史 v1.0.0 ACCEPT 只有尝试编号、没有结果摘要，因此正文漂移不会先被 exact digest 门
  // 拦住；必须由 exact item/contentHash 重验拒绝，reply 仍为零写入。
  const acceptRow = f2.store.listEvents(f2.kingdomId, 400).find(row => row.event_type === 'TASK_ACCEPTED')!
  f2.store.db.prepare('UPDATE events SET payload_json = ? WHERE event_id = ?').run(JSON.stringify({
    decision: 'ACCEPT', reviewed_attempt_no: 1, reason: null,
    reviewer_binding_id: acceptRow.actor_id, claimed_outcome: null,
  }), acceptRow.event_id)
  // 同一 Task/attempt/result 的正文被改写：问题绑定的条目内容版本已经漂移。
  f2.store.db.prepare('UPDATE worker_results SET result_json = ? WHERE task_id = ? AND attempt_no = 1')
    .run(JSON.stringify({ summary: '被改写的摘要', artifacts: ['证据一'], risks: [] }), 'task-r6')
  const drifted = replyToDeliveryQuestion(f2.store, supervisorContext(f2), { questionId: pendingQuestionId, replyText: '对漂移版本回复' })
  assert.equal(drifted.ok, false)
  assert.equal(drifted.ok === false ? drifted.code : '', 'DELIVERY_ITEM_VERSION_STALE')
  assert.equal(replyEvents(f2).length, 0)
})

// ── 3. 不泄露正文 ────────────────────────────────────────────────────

test('snapshots, task detail, recent events and event polling never expose the question or reply body', async (t) => {
  const f = fixture(t)
  acceptTask(f, 'task-l1')
  const handle = f.activate()
  const secretQuestion = '内部问题正文CANARY-QUESTION-9f3'
  const secretReply = '内部回复正文CANARY-REPLY-4b7'
  await ask(f, handle, questionOperation(f, 'task-l1', secretQuestion))
  const questionId = questionEvents(f)[0]!.questionId as string
  assert.equal(replyToDeliveryQuestion(f.store, supervisorContext(f), { questionId, replyText: secretReply }).ok, true)

  const snapshot = buildSnapshot(f.store, { auth: sessionBound })
  const detail = buildTaskDetail(f.store, f.kingdomId, 'task-l1')!
  const serialized = JSON.stringify({ snapshot, detail })
  assert.equal(serialized.includes(secretQuestion), false, 'the question body never enters a public projection')
  assert.equal(serialized.includes(secretReply), false, 'the reply body never enters a public projection')

  // 事件轮询（eventsSince 形状）也不带正文，只保留不含正文的最小元数据。
  const rows = f.store.listEvents(f.kingdomId, 500).filter(row =>
    row.event_type === DELIVERY_QUESTION_EVENT_TYPE || row.event_type === DELIVERY_REPLY_EVENT_TYPE)
  assert.equal(rows.length, 2)
  const views = rows.map(toEventView)
  const eventJson = JSON.stringify(views)
  assert.equal(eventJson.includes(secretQuestion), false)
  assert.equal(eventJson.includes(secretReply), false)
  for (const view of views) {
    if (view.type === DELIVERY_QUESTION_EVENT_TYPE) assert.equal(view.payload.questionText, '[redacted]')
    if (view.type === DELIVERY_REPLY_EVENT_TYPE) assert.equal(view.payload.replyText, '[redacted]')
  }
  // 元数据仍然可读：类型、目标与条目引用。
  const questionView = views.find(view => view.type === DELIVERY_QUESTION_EVENT_TYPE)!
  assert.equal(questionView.targetType, 'delivery')
  assert.equal(questionView.targetId, deliveryIdFor('task-l1'))
  assert.equal(typeof questionView.payload.itemId, 'string')

  // 工作台投影只给出计数与可达性，不带正文；提问本身不产生任何知悉。
  const workbenchJson = JSON.stringify(snapshot.projection.workbench)
  assert.equal(workbenchJson.includes(secretQuestion), false)
  assert.equal(workbenchJson.includes(secretReply), false)
  assert.match(workbenchJson, /deliveryQuestions/u)
  assert.match(workbenchJson, /"pendingQuestions":0/u)
  assert.equal(snapshot.projection.workbench.data.deliveries.items[0]!.summaryQuestions?.totalCount, 1)
  assert.equal(snapshot.projection.workbench.data.deliveries.items[0]!.summaryQuestions?.answeredCount, 1)

  // 只有有效 Owner 窗口能看到正文。
  const view = f.controller.readDeliveryQuestions(handle, { taskId: 'task-l1', itemId: itemOf(f, 'task-l1').itemId })
  assert.equal(view.questions[0]!.questionText, secretQuestion)
  assert.equal(view.questions[0]!.reply!.replyText, secretReply)
})

test('the read-only question thread requires an active window, the action and an exact current item', async (t) => {
  const f = fixture(t)
  acceptTask(f, 'task-l2')
  const item = itemOf(f, 'task-l2')
  const handle = f.activate()
  await ask(f, handle, questionOperation(f, 'task-l2', '只读线程'))

  await expectError(() => f.controller.readDeliveryQuestions(handle, { taskId: 'task-l2', itemId: 'item:' + 'a'.repeat(32) }),
    'DELIVERY_ITEM_UNKNOWN')
  await expectError(() => f.controller.readDeliveryQuestions(handle, { taskId: 'task-missing', itemId: item.itemId }),
    'SCOPE_DENIED')

  // 另一个 Fixture 的窗口只能看到自己领地的交付：跨领地读取被拒绝。
  const other = fixture(t)
  acceptTask(other, 'task-other')
  await ask(other, other.activate(), questionOperation(other, 'task-other', '别国的问题'))
  await expectError(() => other.controller.readDeliveryQuestions(other.activate(), { taskId: 'task-l2', itemId: item.itemId }),
    'SCOPE_DENIED')

  // 未提问的条目：明确说明没有记录，而不是给出空线程。
  const riskTask = fixture(t)
  acceptTask(riskTask, 'task-l3')
  const artifactItem = itemOf(riskTask, 'task-l3', 1)
  await expectError(() => riskTask.controller.readDeliveryQuestions(riskTask.activate(), { taskId: 'task-l3', itemId: artifactItem.itemId }),
    'DELIVERY_QUESTION_UNKNOWN')
})

test('the workbench question projection is metadata only and counts unreachable questions explicitly', async (t) => {
  const f = fixture(t)
  acceptTask(f, 'task-m1')
  const handle = f.activate()
  await ask(f, handle, questionOperation(f, 'task-m1', '一条问题'))
  const questionId = questionEvents(f)[0]!.questionId as string
  unbindRole(f.store, { kingdomId: f.kingdomId, bindingId: f.supervisor.binding_id }, f.ownerAuth)

  const snapshot = snapshotForWorkbench(f.store, { auth: sessionBound })
  const workbench = snapshot.projection.workbench.data
  assert.equal(workbench.deliveryQuestions.totalQuestions, 1)
  assert.equal(workbench.deliveryQuestions.pendingQuestions, 1)
  assert.equal(workbench.deliveryQuestions.unreachableQuestions, 1)
  const item = workbench.deliveries.items[0]!
  assert.equal(item.deliveryQuestions.length, 0, 'the summary layer is projected once, not duplicated into the evidence list')
  assert.equal(item.summaryQuestions?.totalCount, 1)
  assert.equal(item.summaryQuestions?.pendingCount, 1)
  assert.equal(item.summaryQuestions?.latestReplyState, 'REVIEWER_BINDING_RETIRED')
  assert.match(String(item.summaryQuestions!.threadId), /:item:/u)
  assert.equal(replyToDeliveryQuestion(f.store, supervisorContext(f), { questionId, replyText: 'x' }).ok, false)
})

test('the workbench question projection stays empty for a delivery with no questions', (t) => {
  const f = fixture(t)
  acceptTask(f, 'task-m2')
  const snapshot = snapshotForWorkbench(f.store, { auth: sessionBound })
  const workbench = buildPersonalWorkbench({
    kingdomPresent: true, kingdomId: f.kingdomId,
    bindings: [], territories: [], tasks: [], executions: [],
    governance: { workerSessions: [], leases: [], decisions: [], dispatches: [] },
    deliveryLayers: {},
  })
  assert.equal(workbench.deliveryQuestions.totalQuestions, 0)
  assert.match(workbench.deliveryQuestions.note, /不构成待办或通知/u)
  const item = snapshot.projection.workbench.data.deliveries.items[0]!
  assert.deepEqual(item.deliveryQuestions, [])
  assert.equal(item.summaryQuestions, null)
})

test('question text is redacted before it becomes a fact', async (t) => {
  const f = fixture(t)
  acceptTask(f, 'task-redact')
  const handle = f.activate()
  await ask(f, handle, questionOperation(f, 'task-redact',
    'Authorization: Bearer sk-question-secret 与本机路径 C:\\Users\\me\\secret.txt 有关吗？'))
  const payload = questionEvents(f)[0]!
  assert.equal(String(payload.questionText).includes('sk-question-secret'), false)
  assert.equal(String(payload.questionText).includes('C:\\Users\\me\\secret.txt'), false)
  assert.match(String(payload.questionText), /\[REDACTED\]/u)

  const questionId = payload.questionId as string
  assert.equal(replyToDeliveryQuestion(f.store, supervisorContext(f), { questionId, replyText: 'token is ready 已经处理' }).ok, true)
  const reply = replyEvents(f)[0]!
  assert.equal(reply.replyText, 'token is ready 已经处理', 'ordinary prose is not mangled')
})

test('the question action never grants acknowledgement and the acknowledgement action never grants questions', async (t) => {
  const f = fixture(t)
  acceptTask(f, 'task-sep')
  const handle = f.activate()
  const item = itemOf(f, 'task-sep')
  const claim = f.store.latestWorkerResult('task-sep')!
  const ackInput: OwnerOperationInput = { action: 'delivery.item.ack', parameters: { task_id: 'task-sep',
    delivery_id: deliveryIdFor('task-sep'), item_id: item.itemId, content_hash: item.contentHash,
    attempt_no: claim.attempt_no, result_id: claim.result_id } }
  await ask(f, handle, ackInput)
  assert.equal(questionEvents(f).length, 0, 'acknowledging does not create a question')
  await ask(f, handle, questionOperation(f, 'task-sep', '提问不写知悉'))
  assert.equal(f.store.listEvents(f.kingdomId, 500).filter(row => row.event_type === 'OWNER_DELIVERY_ITEM_ACKNOWLEDGED').length, 1)
  assert.equal(questionEvents(f).length, 1)

  // 陈旧知悉提示不能删除或覆盖问题事实。
  const thread = readDeliveryQuestionThread(f.store, f.kingdomId, deliveryIdFor('task-sep'))!
  assert.equal(thread.questions.length, 1)
  assert.equal(thread.questions[0]!.questionText, '提问不写知悉')
  assert.equal(deliveryContentHash(item.content), item.contentHash)
})

// ── 4. 接收主管由两个真实字段同时证明（19 号第 2 项）────────────────

test('a receiver is only directed when both the event actor and payload reviewer field are non-empty and equal', async (t) => {
  const f = fixture(t)
  acceptTask(f, 'task-rev1')
  const handle = f.activate()
  const accepted = f.store.listEvents(f.kingdomId, 400).find(row => row.event_type === 'TASK_ACCEPTED')!
  const original = JSON.parse(accepted.payload_json) as Record<string, unknown>
  const rowWith = (payload: Record<string, unknown>, actorId = accepted.actor_id) =>
    ({ ...accepted, actor_id: actorId, payload_json: JSON.stringify(payload) })
  const withoutReviewer = { ...original }
  delete withoutReviewer.reviewer_binding_id

  // 两字段一致：唯一可定向的接收者。
  assert.equal(deliveryReviewerBindingId(rowWith(original) as never), f.supervisor.binding_id)
  // 不一致：不猜测。
  assert.equal(deliveryReviewerBindingId(rowWith({ ...original, reviewer_binding_id: 'sup-forged' }) as never), null)
  // 只缺 payload 字段：actor_id 单独不能冒充接收者。
  assert.equal(deliveryReviewerBindingId(rowWith(withoutReviewer) as never), null)
  // 只缺 actor_id：payload 字段单独不能冒充接收者。
  assert.equal(deliveryReviewerBindingId(rowWith(original, '') as never), null)

  // 端到端：两字段不一致的真实事件不能产生任何提问事实。
  f.store.db.prepare('UPDATE events SET payload_json = ? WHERE event_id = ?')
    .run(JSON.stringify({ ...original, reviewer_binding_id: 'sup-forged' }), accepted.event_id)
  await expectError(() => f.controller.prepare(handle, questionOperation(f, 'task-rev1', '字段不一致时提问')),
    'DELIVERY_ACCEPT_REVIEWER_UNKNOWN')
  assert.equal(questionEvents(f).length, 0, 'a forged receiver writes nothing')

  // 缺少 payload reviewer 字段的真实事件同样 fail-closed。
  f.store.db.prepare('UPDATE events SET payload_json = ? WHERE event_id = ?').run(JSON.stringify(withoutReviewer), accepted.event_id)
  await expectError(() => f.controller.prepare(handle, questionOperation(f, 'task-rev1', '缺字段时提问')),
    'DELIVERY_ACCEPT_REVIEWER_UNKNOWN')
  assert.equal(questionEvents(f).length, 0)
})

// ── 5. 同一交付的第二个条目保留自己的线程（19 号第 4 项）──────────

test('a second item in the same delivery keeps its own question thread and is not hidden by the first item', async (t) => {
  const f = fixture(t)
  acceptTask(f, 'task-th1')
  const handle = f.activate()
  const summary = itemOf(f, 'task-th1', 0)
  const artifact = itemOf(f, 'task-th1', 1)
  assert.notEqual(summary.itemId, artifact.itemId, 'the two layers have different stable item ids')
  await ask(f, handle, questionOperation(f, 'task-th1', '摘要层的问题'))
  await ask(f, handle, questionOperation(f, 'task-th1', '证据条目的问题', 1))

  const all = readDeliveryQuestionThread(f.store, f.kingdomId, deliveryIdFor('task-th1'))!
  assert.equal(all.questions.length, 2)
  const artifactThread = deliveryQuestionThreadForItem(all, artifact.itemId, artifact.contentHash)
  assert.ok(artifactThread, 'the later item is not hidden behind the first question')
  assert.equal(artifactThread.questions.length, 1)
  assert.equal(artifactThread.questions[0]!.questionText, '证据条目的问题')

  // Owner 只读回读按目标条目过滤，而不是用首问代表整条交付。
  const view = f.controller.readDeliveryQuestions(handle, { taskId: 'task-th1', itemId: artifact.itemId })
  assert.equal(view.questions.length, 1)
  assert.equal(view.questions[0]!.questionText, '证据条目的问题')
  assert.equal(view.itemId, artifact.itemId)
})

// ── 6. 双连接不会写出两条回复事实（19 号第 7 项）────────────────────

test('two live connections on one database cannot write two different replies, and a failed BEGIN writes nothing', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kingdom-reply-race-'))
  const dbPath = join(root, 'kingdom.db')
  const f = fixture(t, { dbPath })
  acceptTask(f, 'task-race')
  const handle = f.activate()
  await ask(f, handle, questionOperation(f, 'task-race', '并发回复测试'))
  const questionId = questionEvents(f)[0]!.questionId as string

  const second = new KingdomStore(dbPath)
  t.after(() => { second.close(); rmSync(root, { recursive: true, force: true }) })

  // 第二个连接先写：成功，且事件 ID 只由 question 决定。
  const fromSecond = replyToDeliveryQuestion(second, supervisorContext(f), { questionId, replyText: '第二个连接的回复' })
  assert.equal(fromSecond.ok, true, fromSecond.ok ? fromSecond.text : fromSecond.message)
  const replies = () => f.store.listEvents(f.kingdomId, 500).filter(row => row.event_type === DELIVERY_REPLY_EVENT_TYPE)
  assert.equal(replies().length, 1)
  assert.equal(replies()[0]!.event_id, deliveryReplyEventId(f.kingdomId, questionId))

  // 第一个连接随后用不同文本：看到既有回复行并明确冲突，不再写出第二条事实。
  const conflict = replyToDeliveryQuestion(f.store, supervisorContext(f), { questionId, replyText: '第一个连接的另一个回复' })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.ok === false ? conflict.code : '', 'REPLY_ALREADY_RECORDED')
  assert.equal(replies().length, 1)

  // 同一文本重试幂等：回到同一条事实。
  const retry = replyToDeliveryQuestion(f.store, supervisorContext(f), { questionId, replyText: '第二个连接的回复' })
  assert.equal(retry.ok, true)
  assert.equal(replies().length, 1)

  // BEGIN IMMEDIATE 失败必须原样传播且零写：绝不当作「已有外层事务」继续。
  f.store.db.exec('BEGIN IMMEDIATE')
  try {
    assert.throws(() => replyToDeliveryQuestion(second, supervisorContext(f), { questionId, replyText: '锁被占用时的回复' }))
  } finally {
    f.store.db.exec('ROLLBACK')
  }
  assert.equal(replies().length, 1, 'a failed BEGIN writes no reply')
  assert.equal(replies()[0]!.event_id, deliveryReplyEventId(f.kingdomId, questionId))
})

// ── 7. 同一 session 的第二个主管 binding 不被遗漏（19 号第 6 项）────
test('the session inbox enumerates every ACTIVE supervisor binding instead of silently dropping the later one', async (t) => {
  const f = fixture(t)
  // 同一真实 session 合法持有第二个 SUPERVISOR 绑定，并主理第二个领地。
  bindRole(f.store, { kingdomId: f.kingdomId, roleType: 'SUPERVISOR', roleName: '主管乙', sessionId: 'supervisor-session-a' }, f.ownerAuth)
  const second = f.store.getBindingsByRole(f.kingdomId, 'SUPERVISOR').find(binding => binding.binding_id !== f.supervisor.binding_id)!
  assert.equal(second.session_id, 'supervisor-session-a')
  const secondRoot = join(f.root, 'second-territory')
  mkdirSync(secondRoot, { recursive: true })
  createTerritory(f.store, { kingdomId: f.kingdomId, name: '第二领地', workspacePath: secondRoot }, f.ownerAuth)
  const secondTerritory = f.store.listTerritories(f.kingdomId).find(territory => territory.name === '第二领地')!
  setTerritorySupervisor(f.store, { kingdomId: f.kingdomId, territoryId: secondTerritory.territory_id, supervisorBindingId: second.binding_id }, f.ownerAuth)

  acceptTask(f, 'task-bind1')
  acceptTask(f, 'task-bind2', 'supervisor-session-a', secondTerritory.territory_id)
  const handle = f.controller.activate(f.capability, { ...f.decision,
    scope: { ...f.decision.scope, territoryIds: [f.territory.territory_id, secondTerritory.territory_id] } }).handle
  await ask(f, handle, questionOperation(f, 'task-bind1', '第一绑定的问题'))
  await ask(f, handle, questionOperation(f, 'task-bind2', '第二绑定的问题'))

  const inbox = readDeliveryQuestionInboxForSession(f.store, f.kingdomId, 'supervisor-session-a')
  assert.equal(inbox.bindings.length, 2, 'both bindings of the session are proven, not just the first')
  assert.deepEqual(inbox.entries.map(entry => entry.question.questionText).sort(), ['第一绑定的问题', '第二绑定的问题'])
  // 只取第一个绑定的旧行为会静默漏掉第二个绑定的问题。
  const firstOnly = readDeliveryQuestionInbox(f.store, f.kingdomId, { reviewerBindingId: f.supervisor.binding_id,
    territoryIds: [f.territory.territory_id, secondTerritory.territory_id] })
  assert.equal(firstOnly.length, 1)
  // 未持有任何绑定或未知 session 时为空，由调用方 fail-closed。
  assert.deepEqual(readDeliveryQuestionInboxForSession(f.store, f.kingdomId, 'nobody').bindings, [])
  assert.deepEqual(readDeliveryQuestionInboxForSession(f.store, f.kingdomId, null).entries, [])
})

// ── 8. 锁前状态在等待写锁期间变化：锁内重验（21 号第 1 项）──────────

/**
 * 可控锁前 barrier：入口校验与写锁之间的窗口。
 *
 * 用真实第二条连接在 `BEGIN IMMEDIATE` **之前**改动授权事实（改绑 / 换 session / 退任），
 * 复现「A 先通过入口校验，B 提交，A 再取得写锁」的交错。这只是一个真实并发时点的
 * 确定性写法，不是产品代码路径。
 */
function barrierBeforeWriteLock(store: KingdomStore, run: () => void): () => void {
  const original = store.withImmediateTransaction.bind(store)
  let pending = true
  const patched = <T,>(fn: () => T): T => {
    if (pending) { pending = false; run() }
    return original(fn)
  }
  ;(store as unknown as { withImmediateTransaction: typeof patched }).withImmediateTransaction = patched
  return () => { (store as unknown as { withImmediateTransaction: typeof original }).withImmediateTransaction = original }
}

/** 文件库夹具：另开真实第二条连接，才能在线交错。 */
function fileBackedFixture(t: { after(fn: () => void): void }, prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const dbPath = join(root, 'kingdom.db')
  const f = fixture(t, { dbPath })
  const second = new KingdomStore(dbPath)
  t.after(() => { second.close(); rmSync(root, { recursive: true, force: true }) })
  return { f, second }
}

test('a rebind committed after entry validation but before the write lock leaves the reply unwritten', async (t) => {
  const { f, second } = fileBackedFixture(t, 'kingdom-reply-rebind-')
  acceptTask(f, 'task-barrier-rebind')
  const handle = f.activate()
  await ask(f, handle, questionOperation(f, 'task-barrier-rebind', '改绑之后还能回复吗？'))
  const questionId = questionEvents(f)[0]!.questionId as string
  const replies = () => f.store.listEvents(f.kingdomId, 500).filter(row => row.event_type === DELIVERY_REPLY_EVENT_TYPE)
  assert.equal(replies().length, 0)

  bindRole(second, { kingdomId: f.kingdomId, roleType: 'SUPERVISOR', roleName: '主管乙', sessionId: 'supervisor-session-b' }, f.ownerAuth)
  const successor = second.getBindingsByRole(f.kingdomId, 'SUPERVISOR').find(binding => binding.session_id === 'supervisor-session-b')!
  const restore = barrierBeforeWriteLock(f.store, () => {
    setTerritorySupervisor(second, { kingdomId: f.kingdomId, territoryId: f.territory.territory_id,
      supervisorBindingId: successor.binding_id }, f.ownerAuth)
  })
  try {
    const blocked = replyToDeliveryQuestion(f.store, supervisorContext(f), { questionId, replyText: '改绑后的回复' })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.ok === false ? blocked.code : '', 'SUPERVISOR_REBOUND')
  } finally { restore() }
  assert.equal(replies().length, 0, 'a rebind committed before the lock leaves zero new reply events')
  const thread = readDeliveryQuestionThread(f.store, f.kingdomId, deliveryIdFor('task-barrier-rebind'))!
  assert.equal(thread.questions[0]!.replyState, 'SUPERVISOR_REBOUND')
  assert.equal(thread.questions[0]!.reply, null, 'the question is never handed to the successor')
  // 继任主管的 session 不是原接收者：它既不能代答，也不会让问题改投。
  const successorAttempt = replyToDeliveryQuestion(f.store, supervisorContext(f, 'supervisor-session-b'),
    { questionId, replyText: '继任主管代答' })
  assert.equal(successorAttempt.ok, false)
  assert.equal(successorAttempt.ok === false ? successorAttempt.code : '', 'QUESTION_NOT_ADDRESSED_TO_CALLER')
  assert.equal(replies().length, 0)
})

test('a session change committed after entry validation but before the write lock leaves the reply unwritten', async (t) => {
  const { f, second } = fileBackedFixture(t, 'kingdom-reply-session-')
  acceptTask(f, 'task-barrier-session')
  const handle = f.activate()
  await ask(f, handle, questionOperation(f, 'task-barrier-session', '换 session 之后还能回复吗？'))
  const questionId = questionEvents(f)[0]!.questionId as string
  const replies = () => f.store.listEvents(f.kingdomId, 500).filter(row => row.event_type === DELIVERY_REPLY_EVENT_TYPE)

  const restore = barrierBeforeWriteLock(f.store, () => {
    rebindSession(second, { kingdomId: f.kingdomId, bindingId: f.supervisor.binding_id, sessionId: 'supervisor-session-b' }, f.ownerAuth)
  })
  try {
    const blocked = replyToDeliveryQuestion(f.store, supervisorContext(f), { questionId, replyText: '旧 session 的迟到回复' })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.ok === false ? blocked.code : '', 'QUESTION_REVIEWER_SESSION_CHANGED')
  } finally { restore() }
  assert.equal(replies().length, 0, 'a session change committed before the lock leaves zero new reply events')

  // 新 session 才是当前责任主管：同一问题允许由它写出唯一回复（正向对照）。
  const allowed = replyToDeliveryQuestion(f.store, supervisorContext(f, 'supervisor-session-b'),
    { questionId, replyText: '当前 session 的回复' })
  assert.equal(allowed.ok, true, allowed.ok ? allowed.text : allowed.message)
  assert.equal(replies().length, 1)
})

test('a retirement committed after entry validation but before the write lock leaves the reply unwritten', async (t) => {
  const { f, second } = fileBackedFixture(t, 'kingdom-reply-retire-')
  acceptTask(f, 'task-barrier-retire')
  const handle = f.activate()
  await ask(f, handle, questionOperation(f, 'task-barrier-retire', '退任之后还能回复吗？'))
  const questionId = questionEvents(f)[0]!.questionId as string
  const replies = () => f.store.listEvents(f.kingdomId, 500).filter(row => row.event_type === DELIVERY_REPLY_EVENT_TYPE)

  const restore = barrierBeforeWriteLock(f.store, () => {
    unbindRole(second, { kingdomId: f.kingdomId, bindingId: f.supervisor.binding_id }, f.ownerAuth)
  })
  try {
    const blocked = replyToDeliveryQuestion(f.store, supervisorContext(f), { questionId, replyText: '退任后的迟到回复' })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.ok === false ? blocked.code : '', 'QUESTION_REVIEWER_UNREACHABLE')
  } finally { restore() }
  assert.equal(replies().length, 0, 'a retirement committed before the lock leaves zero new reply events')
})

test('an idempotent retry of the same reply text returns the existing fact without a second write', async (t) => {
  const f = fixture(t)
  acceptTask(f, 'task-barrier-idem')
  const handle = f.activate()
  await ask(f, handle, questionOperation(f, 'task-barrier-idem', '重试幂等'))
  const questionId = questionEvents(f)[0]!.questionId as string
  const replies = () => f.store.listEvents(f.kingdomId, 500).filter(row => row.event_type === DELIVERY_REPLY_EVENT_TYPE)
  const first = replyToDeliveryQuestion(f.store, supervisorContext(f), { questionId, replyText: '同一条回复' })
  assert.equal(first.ok, true)
  assert.equal(replies().length, 1)
  const retry = replyToDeliveryQuestion(f.store, supervisorContext(f), { questionId, replyText: '同一条回复' })
  assert.equal(retry.ok, true)
  assert.match(retry.ok ? retry.text : '', /未新增第二条事实/u)
  assert.equal(replies().length, 1, 'the retry returns the same single fact')
})

