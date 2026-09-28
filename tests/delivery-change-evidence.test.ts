/**
 * 主管确认的改动证据 —— 有界快照、内容寻址读取、ACCEPT 同事务绑定与负向边界。
 *
 * 真实临时 Git 仓库 + 临时 Kingdom DB + 临时本机证据根；不接触正式 kingdom.db、
 * 正式 Territory、凭据、真实 DSH/Provider。Git 子进程使用文件重定向 stdio
 * （本机沙箱拒绝父子进程匿名管道），与本实现路径一致。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { KingdomStore } from '../lib/core/db.js'
import { initializeKingdomFacts } from '../lib/core/kingdom.js'
import { bindRole } from '../lib/core/binding.js'
import { createTerritory, setTerritorySupervisor } from '../lib/core/territory.js'
import { reviewTask } from '../lib/core/task-service.js'
import { issueOwnerControlCapability, ownerControlAuth } from '../lib/core/owner-control.js'
import { OwnerDecisionController, type OwnerDecisionControllerOptions } from '../lib/core/owner-window.js'
import { OwnerLocalControlManager } from '../lib/gui/owner-control.js'
import { startGuiServer } from '../lib/gui/server.js'
import { buildSnapshot } from '../lib/gui/snapshot.js'
import { renderConsoleApp } from '../lib/gui/console-app.js'
import { renderOwnerApp } from '../lib/gui/owner-ui.js'
import {
  DELIVERY_CHANGE_SNAPSHOT_EVENT_TYPE,
  capturePostAndBuildChangeManifest,
  capturePreChangeSnapshot,
  changeSnapshotEventId,
  changeSnapshotEventPayload,
  readAcceptedChangeEvidence,
  readChangeEntry,
  resolveChangeEvidenceForDelivery,
  validateChangeSelection,
  verifyChangeManifest,
  workspaceKeyOf,
  type DeliveryChangeManifest,
} from '../lib/core/delivery-change.js'
import {
  CHANGE_EVIDENCE_LABEL,
  DELIVERY_ACK_EVENT_TYPE,
  DELIVERY_QUESTION_EVENT_TYPE,
  DELIVERY_REPLY_EVENT_TYPE,
  deliveryChangeItemId,
  deliveryIdFor,
  deriveDeliveryItems,
  readDeliveryQuestionInbox,
  readLatestReviewEvent,
  replyToDeliveryQuestion,
  validateRepoRelativePath,
} from '../lib/core/delivery-ack.js'

const NOW = '2026-09-27T06:00:00.000Z'
const sessionAuth = { mode: 'session-bound' as const, trustLevel: 'session-verified' as const, note: '' }
const declarativeAuth = { mode: 'declarative' as const, trustLevel: 'local-demo' as const, note: '' }

/**
 * 本机沙箱拒绝父子进程匿名管道，因此把 git 的 stdout/stderr 重定向到真实文件再读回。
 * 这不是实现的一部分，只是测试执行 git 的方式。
 */
function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kingdom-git-probe-'))
  const out = join(dir, 'out.txt')
  const fd = openSync(out, 'w')
  let result
  try {
    result = spawnSync('git', ['-C', cwd, ...args], { stdio: ['ignore', fd, fd], windowsHide: true })
  } finally {
    closeSync(fd)
  }
  const stdout = readFileSync(out, 'utf8')
  rmSync(dir, { recursive: true, force: true })
  return { ok: result.status === 0, stdout }
}

function writeRepoFile(repo: string, relative: string, body: string | Buffer): void {
  const absolute = join(repo, ...relative.split('/'))
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, body)
}

interface Fixture {
  root: string
  repo: string
  evidenceRoot: string
  store: KingdomStore
  kingdomId: string
  supervisor: { binding_id: string }
  worker: { binding_id: string }
  territory: { territory_id: string }
  capability: ReturnType<typeof issueOwnerControlCapability>
  repoFile: string
  cleanup: () => void
}

function fixture(t: { after(fn: () => void): void }): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'kingdom-change-'))
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  assert.equal(git(repo, ['init', '--quiet']).ok, true, 'temp git repo initializes')
  git(repo, ['config', 'user.email', 'test@example.invalid'])
  git(repo, ['config', 'user.name', 'Change Evidence Test'])
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const first = 1\nexport const second = 2\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '--quiet', '-m', 'baseline'])
  const evidenceRoot = join(root, 'evidence')
  const previousEvidenceRoot = process.env.DSH_KINGDOM_EVIDENCE_ROOT
  process.env.DSH_KINGDOM_EVIDENCE_ROOT = evidenceRoot

  const store = new KingdomStore(':memory:')
  const initialized = store.withImmediateTransaction(() => initializeKingdomFacts(store, '改动证据测试王国', '人类所有者'))
  const kingdomId = initialized.kingdomId
  const capability = issueOwnerControlCapability()
  const ownerAuth = ownerControlAuth(capability)
  bindRole(store, { kingdomId, roleType: 'SUPERVISOR', roleName: '主管', sessionId: 'supervisor-session' }, ownerAuth)
  bindRole(store, { kingdomId, roleType: 'WORKER', roleName: '执行者' }, ownerAuth)
  const supervisor = store.getBindingByRole(kingdomId, 'SUPERVISOR')!
  const worker = store.getBindingByRole(kingdomId, 'WORKER')!
  createTerritory(store, { kingdomId, name: '主领地', workspacePath: repo }, ownerAuth)
  const territory = store.listTerritories(kingdomId)[0]!
  setTerritorySupervisor(store, { kingdomId, territoryId: territory.territory_id, supervisorBindingId: supervisor.binding_id }, ownerAuth)

  const cleanup = (): void => {
    store.close()
    rmSync(root, { recursive: true, force: true })
    if (previousEvidenceRoot === undefined) delete process.env.DSH_KINGDOM_EVIDENCE_ROOT
    else process.env.DSH_KINGDOM_EVIDENCE_ROOT = previousEvidenceRoot
  }
  t.after(cleanup)
  return { root, repo, evidenceRoot, store, kingdomId, supervisor, worker, territory, capability, repoFile: 'src/app.ts', cleanup }
}

interface ChangeOptions {
  attemptNo?: number
  resultId?: string
  beforeMutate?: (f: Fixture) => void
  mutate?: (f: Fixture) => void
  bounds?: { maxFileBytes?: number; maxStoredBytes?: number; maxFiles?: number }
}

/** 模拟两条真实执行路径的同一编排：PRE → 副作用 → POST → manifest → 事件。 */
function runAttempt(f: Fixture, taskId: string, options: ChangeOptions = {}): { manifest: DeliveryChangeManifest; resultId: string; attemptNo: number } {
  const attemptNo = options.attemptNo ?? 1
  const resultId = options.resultId ?? `result-${taskId}-${attemptNo}`
  options.beforeMutate?.(f)
  const pre = capturePreChangeSnapshot({
    workspacePath: f.repo, taskId, attemptNo, territoryId: f.territory.territory_id, bounds: options.bounds,
  })
  assert.ok(pre, 'PRE snapshot is captured before the execution side effect')
  options.mutate?.(f)
  const manifest = capturePostAndBuildChangeManifest({
    workspacePath: f.repo, pre, taskId, attemptNo, territoryId: f.territory.territory_id, bounds: options.bounds,
  })
  assert.ok(manifest, 'POST snapshot and manifest are built before the WorkerResult write')
  f.store.insertTask({ task_id: taskId, territory_id: f.territory.territory_id, parent_task_id: null, title: '交付 ' + taskId,
    description: null, assigned_binding_id: f.worker.binding_id, status: 'REVIEW', acceptance_criteria: '核验改动', result_summary: null,
    created_at: NOW, updated_at: NOW })
  f.store.insertWorkerResult({ result_id: resultId, task_id: taskId, attempt_no: attemptNo, worker_binding_id: f.worker.binding_id,
    session_id: 'private-session', outcome: 'COMPLETED',
    result_json: JSON.stringify({ outcome: 'COMPLETED', summary: '完成页面改版', artifacts: [], risks: [] }), created_at: NOW })
  f.store.appendEvent({ event_id: changeSnapshotEventId(f.kingdomId, taskId, attemptNo, null), kingdom_id: f.kingdomId,
    event_type: DELIVERY_CHANGE_SNAPSHOT_EVENT_TYPE, actor_role: 'SUPERVISOR', actor_id: f.supervisor.binding_id,
    target_type: 'task', target_id: taskId, payload_json: JSON.stringify(changeSnapshotEventPayload(manifest, resultId)), created_at: NOW })
  return { manifest, resultId, attemptNo }
}

function entryFor(manifest: DeliveryChangeManifest, path: string) {
  const entry = manifest.entries.find(candidate => candidate.path === path)
  assert.ok(entry, `manifest contains an entry for ${path}`)
  return entry
}

function supervisorContext(f: Fixture) {
  return { kingdomId: f.kingdomId, principal: { sessionId: 'supervisor-session' }, auth: sessionAuth }
}

function ownerController(f: Fixture, options: Partial<OwnerDecisionControllerOptions> = {}): OwnerDecisionController {
  const defaults: OwnerDecisionControllerOptions = {
    validateTargetSession: async () => ({ ok: true }), validateExecutionProfile: async () => ({ ok: true }),
    listTargetSessions: async ({ sessionIds }) => sessionIds.map(id => ({ id, label: id })),
  }
  return new OwnerDecisionController(f.store, { ...defaults, ...options })
}

function acceptEvents(f: Fixture, taskId: string) {
  return f.store.listEvents(f.kingdomId, 400).filter(event => event.event_type === 'TASK_ACCEPTED' && event.target_id === taskId)
}

// ── 正向：真实临时 Git 仓库中的未提交改动被准确确认并只读打开 ──

test('a real uncommitted change in a temp git repo is frozen, supervisor-confirmed in the ACCEPT transaction and read back by hash', () => {
  const f = fixture(test)
  const taskId = 'task-change-1'
  const { manifest } = runAttempt(f, taskId, {
    mutate: () => {
      writeFileSync(join(f.repo, 'src', 'app.ts'), 'export const first = 1\nexport const second = 99\nexport const third = 3\n')
      writeFileSync(join(f.repo, 'src', 'new-file.ts'), 'export const fresh = true\n')
    },
  })
  assert.equal(manifest.repo.vcs, 'GIT')
  assert.ok(manifest.repo.head && /^[0-9a-f]{7,64}$/u.test(manifest.repo.head))
  assert.equal(manifest.coverage.complete, true, 'a small clean repo is fully covered')
  const modified = entryFor(manifest, 'src/app.ts')
  assert.equal(modified.status, 'MODIFIED')
  assert.equal(modified.reasonCode, 'CONTENT_CHANGED_IN_WINDOW')
  assert.ok(modified.hunks.some(hunk => hunk.kind === 'ADDED' && hunk.text.includes('third = 3')))
  assert.ok(modified.hunks.some(hunk => hunk.kind === 'REMOVED' && hunk.text.includes('second = 2')))
  const added = entryFor(manifest, 'src/new-file.ts')
  assert.equal(added.status, 'ADDED')
  assert.ok(added.labels.includes('UNTRACKED_FILE_CREATED_IN_WINDOW'))

  const review = reviewTask(f.store, supervisorContext(f), {
    taskId, decision: 'ACCEPT', change_evidence_id: manifest.evidenceId, change_entry_ids: [modified.entryId],
  })
  assert.equal(review.ok, true, review.message)
  assert.equal(f.store.getTask(taskId)?.status, 'DONE')
  const accepted = acceptEvents(f, taskId)
  assert.equal(accepted.length, 1)
  const payload = JSON.parse(accepted[0]!.payload_json) as { delivery_change_evidence?: Record<string, unknown> }
  const bound = payload.delivery_change_evidence!
  assert.equal(bound.evidenceId, manifest.evidenceId)
  assert.deepEqual(bound.entryIds, [modified.entryId])
  assert.equal(bound.attemptNo, 1)
  assert.equal(bound.coverageComplete, true)
  // 事件只记 manifest/hash 与有界元数据，不含仓库正文、绝对路径或差异文本。
  const eventJson = accepted[0]!.payload_json
  assert.equal(eventJson.includes('third = 3'), false, 'the ledger never stores diff bodies')
  assert.equal(eventJson.includes(f.repo), false, 'the ledger never stores absolute workspace paths')

  // 条目派生：只有主管确认的改动才成为可定位条目，且固定标注证据级别。
  const ref = readAcceptedChangeEvidenceFor(f, taskId)
  const resolved = resolveChangeEvidenceForDelivery(undefined, ref)
  assert.ok(resolved)
  const claim = f.store.latestWorkerResult(taskId)!
  const items = deriveDeliveryItems(taskId, claim, resolved)
  const changeItem = items.find(item => item.content.change.entryId === modified.entryId)
  assert.ok(changeItem, 'the confirmed change becomes its own delivery item')
  assert.equal(changeItem.content.change.kind, 'REPO_RELATIVE_VERIFIED')
  assert.equal(changeItem.content.change.repoPath, 'src/app.ts')
  assert.equal(changeItem.content.change.evidenceLabel, CHANGE_EVIDENCE_LABEL)
  assert.match(changeItem.content.label, /主管确认的改动证据/u)
  assert.match(changeItem.content.change.note, /不证明 Git 作者身份/u)
  // 未选中的条目保持不可定位，不会被顺手升格。
  assert.equal(items.some(item => item.content.change.entryId === added.entryId), false)

  // 工作台投影：可定位条目不携带正文，只带精确引用与固定标注。
  const data = buildSnapshot(f.store, { auth: sessionAuth, nowMs: Date.parse(NOW) }).projection.workbench.data
  const delivery = data.deliveries.items.find(item => item.taskId === taskId)!
  const projected = delivery.modules.flatMap(module => module.items).find(item => item.change.entryId === modified.entryId)
  assert.ok(projected, 'workbench projects the confirmed change entry')
  assert.equal(projected.change.evidenceId, manifest.evidenceId)
  assert.equal(projected.change.evidenceLabel, CHANGE_EVIDENCE_LABEL)
  const projectionJson = JSON.stringify(data)
  assert.equal(projectionJson.includes('third = 3'), false, 'the public workbench projection never carries diff bodies')
  assert.equal(projectionJson.includes(f.repo), false, 'the public workbench projection never carries absolute paths')

  // Owner 只读读取：精确 task/evidence/entry，返回有界差异正文且零写入。
  const controller = ownerController(f)
  const handle = controller.activate(f.capability, {
    kingdomId: f.kingdomId, actions: ['delivery.item.ack'], ttlMs: 600000,
    scope: { kingdomWide: false, territoryIds: [f.territory.territory_id], bindingIds: [], roleTypes: [], targetSessionIds: [], workspaceRoots: [] },
  }).handle
  const eventsBefore = f.store.listEvents(f.kingdomId, 400).length
  const view = controller.readDeliveryChange(handle, { taskId, evidenceId: manifest.evidenceId, entryId: modified.entryId })
  assert.equal(view.label, '主管确认的改动证据')
  assert.equal(view.repoPath, 'src/app.ts')
  assert.equal(view.status, 'MODIFIED')
  assert.equal(view.coverageComplete, true)
  assert.ok(view.hunks.length > 0)
  assert.equal(f.store.listEvents(f.kingdomId, 400).length, eventsBefore, 'reading a change never writes a fact')
  assert.equal(f.store.listEvents(f.kingdomId, 400).some(event => event.event_type === DELIVERY_ACK_EVENT_TYPE), false,
    'reading a change never records an acknowledgement')
  controller.dispose()
})

// ── 负向：任务前已脏文件、未跟踪文件、二进制、超限 -------------------------------------------------

test('pre-existing dirty, untracked, binary and oversize files are labelled honestly and never claimed as full coverage', () => {
  const f = fixture(test)
  const taskId = 'task-change-labels'
  const { manifest } = runAttempt(f, taskId, {
    // 任务前已经脏：PRE 时该文件相对 VCS 基准就有改动；二进制与超限文件在基线中已存在。
    beforeMutate: () => {
      writeFileSync(join(f.repo, 'src', 'app.ts'), 'export const first = 1\nexport const second = 21\n')
      writeFileSync(join(f.repo, 'src', 'blob.bin'), Buffer.from([0, 1, 2, 3, 0]))
      writeFileSync(join(f.repo, 'src', 'big.txt'), 'x'.repeat(16))
    },
    mutate: () => {
      writeFileSync(join(f.repo, 'src', 'app.ts'), 'export const first = 1\nexport const second = 22\n')
      writeFileSync(join(f.repo, 'src', 'untracked.ts'), 'export const loose = 1\n')
      writeFileSync(join(f.repo, 'src', 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
      writeFileSync(join(f.repo, 'src', 'big.txt'), 'x'.repeat(4000))
    },
    bounds: { maxFileBytes: 256, maxStoredBytes: 4096 },
  })
  const dirty = entryFor(manifest, 'src/app.ts')
  assert.equal(dirty.reasonCode, 'PRE_EXISTING_DIRTY_FILE_CHANGED')
  assert.ok(dirty.labels.includes('PRE_EXISTING_DIRTY_FILE'))
  assert.ok(dirty.labels.includes('AUTHORSHIP_NOT_PROVEN'), 'authorship is never claimed')
  assert.equal(dirty.baselineBodyUnavailable, false, 'the retained baseline body still shows removed lines')
  assert.equal(entryFor(manifest, 'src/untracked.ts').status, 'ADDED')
  const binary = entryFor(manifest, 'src/blob.bin')
  assert.equal(binary.binary, true)
  assert.equal(binary.reasonCode, 'BINARY_CONTENT_CHANGED')
  assert.equal(binary.hunks.length, 0, 'binary bodies are never rendered as lines')
  const oversize = entryFor(manifest, 'src/big.txt')
  assert.equal(oversize.reasonCode, 'FILE_OVER_SIZE_LIMIT')
  assert.equal(manifest.coverage.complete, false, 'binary/oversize changes can never be reported as complete line coverage')
  assert.ok(manifest.coverage.reasons.includes('BINARY_BODY_NOT_COMPARED_BY_LINES'))
  assert.ok(manifest.coverage.reasons.includes('FILE_OVER_SIZE_LIMIT'))
})

// ── 负向：主管身份、陈旧/伪造选择、漂移证据、重复确认、零写入 --------------------------------

test('declarative mode, wrong session, unrecognized entries, drifted evidence and duplicate ACCEPT all fail closed with zero writes', () => {
  const f = fixture(test)
  const taskId = 'task-change-negative'
  const { manifest } = runAttempt(f, taskId, {
    mutate: () => writeFileSync(join(f.repo, 'src', 'app.ts'), 'export const first = 1\nexport const second = 7\n'),
  })
  const entry = entryFor(manifest, 'src/app.ts')

  // declarative 低信任模式不能签发主管确认。
  const declarative = reviewTask(f.store, { kingdomId: f.kingdomId, principal: { sessionId: 'supervisor-session' }, auth: declarativeAuth }, {
    taskId, decision: 'ACCEPT', change_evidence_id: manifest.evidenceId, change_entry_ids: [entry.entryId],
  })
  assert.equal(declarative.ok, false)
  assert.equal(declarative.errorCode, 'CHANGE_EVIDENCE_SESSION_REQUIRED')
  assert.equal(f.store.getTask(taskId)?.status, 'REVIEW')

  // 其他 session 不能冒充主理主管。
  const wrongSession = reviewTask(f.store, { kingdomId: f.kingdomId, principal: { sessionId: 'other-session' }, auth: sessionAuth }, {
    taskId, decision: 'ACCEPT', change_evidence_id: manifest.evidenceId, change_entry_ids: [entry.entryId],
  })
  assert.equal(wrongSession.ok, false)
  assert.equal(wrongSession.errorCode, 'UNAUTHORIZED_PRINCIPAL')

  // 只给证据 ID、给空选择或选择快照外的条目都拒绝。
  for (const input of [
    { change_evidence_id: manifest.evidenceId },
    { change_evidence_id: manifest.evidenceId, change_entry_ids: [] as string[] },
    { change_evidence_id: manifest.evidenceId, change_entry_ids: ['0'.repeat(64)] },
  ]) {
    const rejected = reviewTask(f.store, supervisorContext(f), { taskId, decision: 'ACCEPT', ...input })
    assert.equal(rejected.ok, false, JSON.stringify(input))
    assert.equal(rejected.errorCode, 'CHANGE_SELECTION_INVALID')
  }
  // 冒充的 evidence id 不会命中本 Task 快照。
  const forged = reviewTask(f.store, supervisorContext(f), {
    taskId, decision: 'ACCEPT', change_evidence_id: 'f'.repeat(64), change_entry_ids: [entry.entryId],
  })
  assert.equal(forged.ok, false)
  assert.equal(forged.errorCode, 'CHANGE_EVIDENCE_UNVERIFIED')
  assert.equal(acceptEvents(f, taskId).length, 0, 'no failed attempt writes TASK_ACCEPTED')

  // 正文漂移（manifest 文件被删除）后 hash 重验失败，读取与确认都不可用。
  const manifestFile = join(f.evidenceRoot, 'manifests', `${manifest.evidenceId}.json`)
  assert.equal(existsSync(manifestFile), true)
  unlinkSync(manifestFile)
  const drifted = verifyChangeManifest(undefined, manifest.evidenceId)
  assert.equal(drifted.ok, false)
  assert.equal(drifted.code, 'EVIDENCE_MISSING')
  assert.equal(resolveChangeEvidenceForDelivery(undefined, {
    kind: 'SUPERVISOR_CONFIRMED_BOUNDED_WINDOW', evidenceId: manifest.evidenceId, attemptNo: 1,
    entryIds: [entry.entryId], selectionDigest: entry.entryId, entryCount: 1, selectedCount: 1,
    coverageComplete: true, coverageReasons: [], repoHead: null, note: '',
  }), null, 'drifted evidence resolves to nothing instead of a stale link')
  const stale = reviewTask(f.store, supervisorContext(f), {
    taskId, decision: 'ACCEPT', change_evidence_id: manifest.evidenceId, change_entry_ids: [entry.entryId],
  })
  assert.equal(stale.ok, false)
  assert.equal(stale.errorCode, 'CHANGE_EVIDENCE_UNVERIFIED')
  assert.equal(acceptEvents(f, taskId).length, 0)
})

test('a snapshot bound to another workspace can never be confirmed for this territory', () => {
  const f = fixture(test)
  const taskId = 'task-change-workspace'
  const { manifest } = runAttempt(f, taskId, {
    mutate: () => writeFileSync(join(f.repo, 'src', 'app.ts'), 'export const first = 1\nexport const second = 8\n'),
  })
  assert.equal(manifest.workspaceKey, workspaceKeyOf(f.repo))
  const otherWorkspace = mkdtempSync(join(tmpdir(), 'kingdom-other-workspace-'))
  assert.notEqual(manifest.workspaceKey, workspaceKeyOf(otherWorkspace))
  rmSync(otherWorkspace, { recursive: true, force: true })
  // 证据本身仍可重验；拒绝来自「不属于当前领地 canonical 工作区」。
  const verified = verifyChangeManifest(undefined, manifest.evidenceId)
  assert.equal(verified.ok, true)
  const selection = validateChangeSelection(undefined, verified.manifest, [entryFor(manifest, 'src/app.ts').entryId], { taskId, attemptNo: 1 })
  assert.equal(selection.ok, true)
  // 篡改 workspaceKey 后，同一 evidence id 不再通过重验，确认路径随之失效。
  const tampered = JSON.parse(readFileSync(join(f.evidenceRoot, 'manifests', `${manifest.evidenceId}.json`), 'utf8')) as Record<string, unknown>
  tampered.workspaceKey = 'a'.repeat(64)
  writeFileSync(join(f.evidenceRoot, 'manifests', `${manifest.evidenceId}.json`), JSON.stringify(tampered))
  assert.equal(verifyChangeManifest(undefined, manifest.evidenceId).ok, false)
  const rejected = reviewTask(f.store, supervisorContext(f), {
    taskId, decision: 'ACCEPT', change_evidence_id: manifest.evidenceId, change_entry_ids: [entryFor(manifest, 'src/app.ts').entryId],
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.errorCode, 'CHANGE_EVIDENCE_UNVERIFIED')
})

test('a snapshot bound to another territory of the same workspace can never be confirmed for this task', () => {
  const f = fixture(test)
  const taskId = 'task-change-territory'
  const ownerAuth = ownerControlAuth(f.capability)
  // 第二个领地指向**同一个** canonical 工作区：workspaceKey 相同，但 territory id 不同。
  createTerritory(f.store, { kingdomId: f.kingdomId, name: '同一工作区的第二领地', workspacePath: f.repo }, ownerAuth)
  const other = f.store.listTerritories(f.kingdomId).find(territory => territory.territory_id !== f.territory.territory_id)!
  const pre = capturePreChangeSnapshot({ workspacePath: f.repo, taskId, attemptNo: 1, territoryId: other.territory_id })
  assert.ok(pre, 'PRE snapshot is captured')
  writeFileSync(join(f.repo, 'src', 'app.ts'), 'export const first = 1\nexport const second = 81\n')
  const manifest = capturePostAndBuildChangeManifest({ workspacePath: f.repo, pre, taskId, attemptNo: 1, territoryId: other.territory_id })
  assert.ok(manifest, 'manifest is built')
  assert.equal(manifest.territoryId, other.territory_id)
  assert.equal(manifest.workspaceKey, workspaceKeyOf(f.repo))
  const entry = entryFor(manifest, 'src/app.ts')
  f.store.insertTask({ task_id: taskId, territory_id: f.territory.territory_id, parent_task_id: null, title: '交付 ' + taskId,
    description: null, assigned_binding_id: f.worker.binding_id, status: 'REVIEW', acceptance_criteria: '核验改动', result_summary: null,
    created_at: NOW, updated_at: NOW })
  f.store.insertWorkerResult({ result_id: 'result-' + taskId, task_id: taskId, attempt_no: 1, worker_binding_id: f.worker.binding_id,
    session_id: 'private-session', outcome: 'COMPLETED',
    result_json: JSON.stringify({ outcome: 'COMPLETED', summary: '完成改动', artifacts: [], risks: [] }), created_at: NOW })
  f.store.appendEvent({ event_id: changeSnapshotEventId(f.kingdomId, taskId, 1, null), kingdom_id: f.kingdomId,
    event_type: DELIVERY_CHANGE_SNAPSHOT_EVENT_TYPE, actor_role: 'SUPERVISOR', actor_id: f.supervisor.binding_id,
    target_type: 'task', target_id: taskId, payload_json: JSON.stringify(changeSnapshotEventPayload(manifest, 'result-' + taskId)), created_at: NOW })
  // 除 territory 外全部条件成立（结果引用、workspaceKey、条目、主管 session），仍必须拒绝。
  const rejected = reviewTask(f.store, supervisorContext(f), {
    taskId, decision: 'ACCEPT', change_evidence_id: manifest.evidenceId, change_entry_ids: [entry.entryId],
  })
  assert.equal(rejected.ok, false, 'a manifest from another territory of the same workspace is not this task\'s evidence')
  assert.equal(rejected.errorCode, 'CHANGE_EVIDENCE_UNVERIFIED')
  assert.match(rejected.message, /领地/u)
  assert.equal(f.store.getTask(taskId)?.status, 'REVIEW')
  assert.equal(acceptEvents(f, taskId).length, 0, 'a territory mismatch writes zero facts')
})

test('a plain ACCEPT never confirms the diff, and a second ACCEPT cannot duplicate the evidence', () => {
  const f = fixture(test)
  const taskId = 'task-change-plain-accept'
  const { manifest } = runAttempt(f, taskId, {
    mutate: () => writeFileSync(join(f.repo, 'src', 'app.ts'), 'export const first = 1\nexport const second = 9\n'),
  })
  const plain = reviewTask(f.store, supervisorContext(f), { taskId, decision: 'ACCEPT' })
  assert.equal(plain.ok, true)
  const accepted = acceptEvents(f, taskId)
  assert.equal(accepted.length, 1)
  const payload = JSON.parse(accepted[0]!.payload_json) as Record<string, unknown>
  assert.equal(Object.hasOwn(payload, 'delivery_change_evidence'), false, 'ordinary ACCEPT binds no change evidence')
  const claim = f.store.latestWorkerResult(taskId)!
  const items = deriveDeliveryItems(taskId, claim, null)
  assert.equal(items.some(item => item.content.change.kind === 'REPO_RELATIVE_VERIFIED'), false)
  assert.ok(items.filter(item => item.content.layer === 'EVIDENCE').every(item => item.content.change.kind === 'NOT_LOCATABLE'))
  // 证据仍然存在，只是没有被升格为主管确认；重复 ACCEPT 也不能补签。
  assert.equal(existsSync(join(f.evidenceRoot, 'manifests', `${manifest.evidenceId}.json`)), true)
  const again = reviewTask(f.store, supervisorContext(f), {
    taskId, decision: 'ACCEPT', change_evidence_id: manifest.evidenceId, change_entry_ids: [entryFor(manifest, 'src/app.ts').entryId],
  })
  assert.equal(again.ok, false)
  assert.equal(again.errorCode, 'ILLEGAL_TASK_STATE')
  assert.equal(acceptEvents(f, taskId).length, 1)
})

// ── 负向：Owner 只读边界、路径穿越与不存在的条目 --------------------------------------------

test('the Owner read path refuses unstarted windows, out-of-scope deliveries, unrecognized entries and path traversal', () => {
  const f = fixture(test)
  const taskId = 'task-change-owner-read'
  const { manifest } = runAttempt(f, taskId, {
    mutate: () => writeFileSync(join(f.repo, 'src', 'app.ts'), 'export const first = 1\nexport const second = 11\n'),
  })
  const entry = entryFor(manifest, 'src/app.ts')
  reviewTask(f.store, supervisorContext(f), {
    taskId, decision: 'ACCEPT', change_evidence_id: manifest.evidenceId, change_entry_ids: [entry.entryId],
  })
  const controller = ownerController(f)
  const decision = {
    kingdomId: f.kingdomId, actions: ['delivery.item.ack'] as const, ttlMs: 600000,
    scope: { kingdomWide: false, territoryIds: [f.territory.territory_id], bindingIds: [], roleTypes: [], targetSessionIds: [], workspaceRoots: [] },
  }
  const inScope = controller.activate(f.capability, { ...decision, actions: ['delivery.item.ack'] }).handle
  // 未选择的条目、其它 Task、冒充 evidence 都不返回正文。
  assert.throws(() => controller.readDeliveryChange(inScope, { taskId, evidenceId: manifest.evidenceId, entryId: '0'.repeat(64) }),
    /不是本 Task 已由主管确认的证据|不在主管确认的改动引用内/u)
  assert.throws(() => controller.readDeliveryChange(inScope, { taskId: 'missing-task', evidenceId: manifest.evidenceId, entryId: entry.entryId }), /任务不存在/u)
  // 越界窗口（无领地/绑定范围）不能读取该交付。
  const outOfScope = controller.activate(f.capability, {
    ...decision, actions: ['delivery.item.ack'],
    scope: { kingdomWide: false, territoryIds: [], bindingIds: [], roleTypes: [], targetSessionIds: [], workspaceRoots: [] },
  }).handle
  assert.throws(() => controller.readDeliveryChange(outOfScope, { taskId, evidenceId: manifest.evidenceId, entryId: entry.entryId }), /不在本次授权范围内/u)
  controller.dispose()

  // 路径纪律：manifest 条目一律是仓库相对路径；绝对路径、盘符与 `..` 都被拒绝。
  assert.ok(manifest.entries.every(candidate => validateRepoRelativePath(candidate.path) === candidate.path))
  assert.equal(validateRepoRelativePath('../../etc/passwd'), null)
  assert.equal(validateRepoRelativePath('C:/Windows/system32'), null)
  assert.equal(validateRepoRelativePath('/etc/passwd'), null)
  assert.equal(validateRepoRelativePath('src\\app.ts'), null)
  const notSelected = readChangeEntry(undefined, {
    kind: 'SUPERVISOR_CONFIRMED_BOUNDED_WINDOW', evidenceId: manifest.evidenceId, attemptNo: 1,
    entryIds: [], selectionDigest: 'x', entryCount: 1, selectedCount: 0, coverageComplete: true, coverageReasons: [], repoHead: null, note: '',
  }, entry.entryId)
  assert.equal(notSelected.ok, false)
  assert.equal(notSelected.code, 'CHANGE_ENTRY_UNKNOWN')
})

// ── Owner 页面与真实 HTTP 只读接口 ---------------------------------------------------------

test('the Owner page renders a strict read-only change view and the real HTTP read route enforces window, scope and exact ids', async (t) => {
  const f = fixture(test)
  const taskId = 'task-change-http'
  const { manifest } = runAttempt(f, taskId, {
    mutate: () => writeFileSync(join(f.repo, 'src', 'app.ts'), 'export const first = 1\nexport const second = 33\n'),
  })
  const entry = entryFor(manifest, 'src/app.ts')
  reviewTask(f.store, supervisorContext(f), {
    taskId, decision: 'ACCEPT', change_evidence_id: manifest.evidenceId, change_entry_ids: [entry.entryId],
  })
  const controller = ownerController(f)
  // 工作台不得自带差异正文：链接只携带精确引用，正文必须经管理窗口读取。
  const consoleHtml = renderConsoleApp()
  assert.match(consoleHtml, /\/owner\?change_task=/u)
  assert.match(consoleHtml, /change_evidence=/u)
  assert.match(consoleHtml, /change_item=/u)
  assert.equal(consoleHtml.includes('second = 33'), false)
  const ownerHtml = renderOwnerApp('delivery-change-nonce-123456')
  assert.match(ownerHtml, /主管确认的改动证据/u)
  assert.match(ownerHtml, /\/api\/owner\/delivery-change\?/u)
  assert.match(ownerHtml, /changeHintInvalid/u)

  let now = Date.now()
  let origin = ''
  const manager = new OwnerLocalControlManager({ controller, expectedOrigin: () => origin, now: () => now })
  let resolveReady!: (value: string) => void
  const ready = new Promise<string>(resolve => { resolveReady = resolve })
  const close = startGuiServer({ snapshot: () => ({}) as never, taskDetail: () => null, eventsSince: () => ({ revision: 0, events: [] }),
    command: async () => ({}) as never },
  { port: 0, token: 'unrelated-role-bearer', ownerControl: manager, onListening: address => { origin = address.origin; resolveReady(origin) } })
  await ready
  try {
    const readUrl = (cookie: string | null, params: string): Promise<Response> => fetch(origin + '/api/owner/delivery-change?' + params,
      cookie ? { headers: { cookie } } : undefined)
    // 没有管理窗口凭据时不返回任何正文。
    const unauthorized = await readUrl(null, `task=${taskId}&evidence=${manifest.evidenceId}&item=${entry.entryId}`)
    assert.equal(unauthorized.status, 401)
    assert.equal(JSON.stringify(await unauthorized.json()).includes('second = 33'), false)
    // 参数必须精确为三个；缺失或多余都拒绝。
    const malformed = await readUrl(null, `task=${taskId}&evidence=${manifest.evidenceId}`)
    assert.equal(malformed.status, 400)
    const extra = await readUrl(null, `task=${taskId}&evidence=${manifest.evidenceId}&item=${entry.entryId}&extra=1`)
    assert.equal(extra.status, 400)

    const activation = manager.activate(f.capability, {
      kingdomId: f.kingdomId, actions: ['delivery.item.ack'], ttlMs: 600000,
      scope: { kingdomWide: false, territoryIds: [f.territory.territory_id], bindingIds: [], roleTypes: [], targetSessionIds: [], workspaceRoots: [] },
    })
    const redeemed = await fetch(origin + activation.launchPath + '?ticket=' + encodeURIComponent(activation.launchTicket), { redirect: 'manual' })
    assert.equal(redeemed.status, 303)
    const cookie = redeemed.headers.get('set-cookie')!.split(';', 1)[0]!
    const eventsBefore = f.store.listEvents(f.kingdomId, 400).length
    const ok = await readUrl(cookie, `task=${taskId}&evidence=${manifest.evidenceId}&item=${entry.entryId}`)
    assert.equal(ok.status, 200)
    const body = await ok.json() as { ok: boolean; change: { repoPath: string; label: string; hunks: { text: string }[] } }
    assert.equal(body.ok, true)
    assert.equal(body.change.repoPath, 'src/app.ts')
    assert.equal(body.change.label, '主管确认的改动证据')
    assert.ok(body.change.hunks.some(hunk => hunk.text.includes('second = 33')))
    assert.equal(f.store.listEvents(f.kingdomId, 400).length, eventsBefore, 'the read-only route never writes a fact')
    // 冒充的条目 id 不返回正文。
    const unknown = await readUrl(cookie, `task=${taskId}&evidence=${manifest.evidenceId}&item=${'0'.repeat(64)}`)
    assert.notEqual(unknown.status, 200)
    assert.equal(JSON.stringify(await unknown.json()).includes('second = 33'), false)
  } finally {
    close()
    manager.dispose()
    controller.dispose()
  }
})

/** 读取该 Task 最近一次 TASK_ACCEPTED 绑定的改动证据引用。 */
function readAcceptedChangeEvidenceFor(f: Fixture, taskId: string) {
  const ref = readAcceptedChangeEvidence(readLatestReviewEvent(f.store, f.kingdomId, taskId))
  assert.ok(ref, 'the ACCEPT event binds change evidence')
  return ref
}

// ── CHANGE 条目的提问与回复闭环（19 号第 3 项）────────────────────────

test('a supervisor-confirmed CHANGE entry is questionable and answerable, and evidence drift fails closed', async (t) => {
  const f = fixture(t)
  const taskId = 'task-change-q1'
  const { manifest } = runAttempt(f, taskId, {
    mutate: () => { writeFileSync(join(f.repo, 'src', 'app.ts'), 'export const first = 1\nexport const second = 99\n') },
  })
  const modified = entryFor(manifest, 'src/app.ts')
  const review = reviewTask(f.store, supervisorContext(f), {
    taskId, decision: 'ACCEPT', change_evidence_id: manifest.evidenceId, change_entry_ids: [modified.entryId],
  })
  assert.equal(review.ok, true, review.message)

  // 从真实已接受证据重算 CHANGE 条目身份：与 Owner 目录、预览、写入端必须同源。
  const claim = f.store.latestWorkerResult(taskId)!
  const evidence = resolveChangeEvidenceForDelivery(undefined, readAcceptedChangeEvidenceFor(f, taskId))
  assert.ok(evidence)
  const changeItem = deriveDeliveryItems(taskId, claim, evidence)
    .find(item => item.itemId === deliveryChangeItemId(deliveryIdFor(taskId), modified.entryId))
  assert.ok(changeItem, 'the confirmed change entry is part of the delivery catalogue')
  assert.equal(changeItem.content.change.evidenceId, manifest.evidenceId)

  const controller = ownerController(f)
  const handle = controller.activate(f.capability, {
    kingdomId: f.kingdomId, actions: ['delivery.item.question'], ttlMs: 600000,
    scope: { kingdomWide: false, territoryIds: [f.territory.territory_id], bindingIds: [], roleTypes: [], targetSessionIds: [], workspaceRoots: [] },
  }).handle
  const input = { action: 'delivery.item.question', parameters: { task_id: taskId, delivery_id: deliveryIdFor(taskId),
    item_id: changeItem.itemId, content_hash: changeItem.contentHash, attempt_no: claim.attempt_no, result_id: claim.result_id,
    question_text: '为什么选择这个实现？' } } as never

  const preview = await controller.prepare(handle, input)
  const receipt = await controller.commit(handle, { prepareId: preview.prepareId, operationId: preview.operationId })
  assert.equal(receipt.status, 'APPLIED')
  const questions = f.store.listEvents(f.kingdomId, 400).filter(row => row.event_type === DELIVERY_QUESTION_EVENT_TYPE)
  assert.equal(questions.length, 1, 'questioning a confirmed CHANGE entry writes exactly one fact')
  const payload = JSON.parse(questions[0]!.payload_json) as Record<string, unknown>
  assert.equal(payload.itemId, changeItem.itemId)
  assert.equal(payload.contentHash, changeItem.contentHash)
  assert.equal(payload.reviewerBindingId, f.supervisor.binding_id)
  assert.equal(payload.acceptanceEvidenceKind, 'EXACT_RESULT_BOUND')

  // 回复在同一个写锁内按**当前 ACCEPT 引用**重新读取并重验 exact evidence/item/hash，
  // 因此 CHANGE 条目同样能闭环；调用边界不再预先解析、也不再传入证据对象。
  const replied = replyToDeliveryQuestion(f.store, supervisorContext(f),
    { questionId: String(payload.questionId), replyText: '为了保持既有调用方的兼容性。' })
  assert.equal(replied.ok, true, replied.ok ? replied.text : replied.message)
  assert.equal(f.store.listEvents(f.kingdomId, 400).filter(row => row.event_type === DELIVERY_REPLY_EVENT_TYPE).length, 1)

  // 负向：锁内重验不依赖任何锁外解析结果——同一已接受引用在写锁取得前漂移
  // （证据正文被删除）时，回复必须 fail-closed 且零写入。
  const pendingItem = deriveDeliveryItems(taskId, claim, evidence)
    .find(item => item.itemId === deliveryChangeItemId(deliveryIdFor(taskId), modified.entryId))!
  const pendingPreview = await controller.prepare(handle, { action: 'delivery.item.question', parameters: {
    task_id: taskId, delivery_id: deliveryIdFor(taskId), item_id: pendingItem.itemId, content_hash: pendingItem.contentHash,
    attempt_no: claim.attempt_no, result_id: claim.result_id, question_text: '证据漂移后还能回复吗？' } } as never)
  const pendingReceipt = await controller.commit(handle, { prepareId: pendingPreview.prepareId, operationId: pendingPreview.operationId })
  assert.equal(pendingReceipt.status, 'APPLIED')
  const pendingRows = f.store.listEvents(f.kingdomId, 400).filter(row => row.event_type === DELIVERY_QUESTION_EVENT_TYPE)
  assert.equal(pendingRows.length, 2)
  // `store.listEvents` 按 seq DESC 返回，数组下标不代表提交顺序：按第二次提交自己的
  // owner operation 精确选中新问，并先断言身份，避免误把已回复的首问当成待答问题。
  const pendingRow = pendingRows.find(row => (JSON.parse(row.payload_json) as Record<string, unknown>).operationId === pendingPreview.operationId)
  assert.ok(pendingRow, 'the second submitted question is selected by its own operation id')
  const pendingPayload = JSON.parse(pendingRow!.payload_json) as Record<string, unknown>
  assert.notEqual(pendingPayload.questionId, payload.questionId, 'the selected row is the newly submitted question, not the answered first one')
  assert.equal(pendingPayload.itemId, pendingItem.itemId)
  assert.equal(pendingPayload.contentHash, pendingItem.contentHash)
  const pendingQuestionId = String(pendingPayload.questionId)
  unlinkSync(join(f.evidenceRoot, 'manifests', `${manifest.evidenceId}.json`))
  const driftedReply = replyToDeliveryQuestion(f.store, supervisorContext(f),
    { questionId: pendingQuestionId, replyText: '证据漂移后的回复' })
  assert.equal(driftedReply.ok, false)
  assert.equal(driftedReply.ok === false ? driftedReply.code : '', 'DELIVERY_ITEM_VERSION_STALE')
  assert.equal(f.store.listEvents(f.kingdomId, 400).filter(row => row.event_type === DELIVERY_REPLY_EVENT_TYPE).length, 1,
    'a reply whose evidence drifted before the write lock writes nothing')

  // 证据丢失后的读态：正文仍可读，但必须区分为「无法重验」，不得再显示为当前可回复待办。
  // 主管 Tool 的收件箱按权威账本读取：两条问题都标 UNVERIFIABLE，当前版本为 null。
  const inboxEntries = readDeliveryQuestionInbox(f.store, f.kingdomId, {
    reviewerBindingId: f.supervisor.binding_id, territoryIds: [f.territory.territory_id] })
  assert.equal(inboxEntries.length, 2)
  assert.equal(inboxEntries.every(entry => entry.question.itemVersion === 'UNVERIFIABLE'), true,
    'a question whose CHANGE evidence is gone is never shown as the current version')
  assert.equal(inboxEntries.every(entry => entry.question.currentItemContentHash === null), true)
  // 主管 Tool 的 pending_only 只列当前版未答问题：证据丢失后这两条都不再进入当前待办。
  assert.equal(inboxEntries.filter(entry => entry.question.reply === null && entry.question.itemVersion === 'CURRENT').length, 0,
    'pending_only lists no question whose CHANGE evidence can no longer be re-verified')

  // Owner 只读回看：按精确 itemId 仍能读到正文，但整条标为无法重验、当前版本为 null。
  const ownerView = controller.readDeliveryQuestions(handle, { taskId, itemId: pendingItem.itemId })
  assert.equal(ownerView.contentHash, null)
  assert.equal(ownerView.questions.length, 2)
  assert.equal(ownerView.pendingCount, 0)
  assert.equal(ownerView.historyCount, 0)
  assert.equal(ownerView.unverifiableCount, 2)
  assert.equal(ownerView.questions.every(question => question.itemVersion === 'UNVERIFIABLE'), true)
  assert.equal(ownerView.questions.some(question => question.questionText === '证据漂移后还能回复吗？'), true,
    'the question body stays readable even though its item can no longer be re-derived')

  // 工作台投影只报计数：不把这批问题算成当前待办，也不虚构一条当前可回复条目；正文永不进入投影。
  const workbench = buildSnapshot(f.store, { auth: sessionAuth, nowMs: Date.parse(NOW) }).projection.workbench.data
  assert.equal(workbench.deliveryQuestions.pendingQuestions, 0)
  assert.equal(workbench.deliveryQuestions.historicalQuestions, 0)
  const lostDelivery = workbench.deliveries.items.find(item => item.taskId === taskId)!
  assert.equal(lostDelivery.deliveryQuestions.length, 0, 'the unverifiable item is not listed as a current delivery item')
  assert.equal(JSON.stringify(workbench).includes('证据漂移后还能回复吗'), false, 'the workbench never carries question bodies')

  // 负向：证据漂移后同一 CHANGE 条目不再派生，提问 fail-closed 且零写。
  await assert.rejects(() => controller.prepare(handle, input), (error: { code?: string }) => {
    assert.equal(error.code, 'DELIVERY_ITEM_UNKNOWN')
    return true
  })
  assert.equal(f.store.listEvents(f.kingdomId, 400).filter(row => row.event_type === DELIVERY_QUESTION_EVENT_TYPE).length, 2,
    'a drifted evidence path writes nothing')
  controller.dispose()
})
