/**
 * R3/R4 定向负测 —— 只覆盖 Code Review 列出的反例。
 *
 * 目标：
 * - 被 `.gitignore` 忽略的私有内容既不成为候选，正文也不落盘（只计数与保留路径名）；
 * - 未变化的超限文件不得被输出成「本窗口改动」；
 * - 普通目录（含 `internal`、`dist`、`node_modules`）不得被静默跳过；
 * - 显式空选择/空白条目 id 不得退化为普通 ACCEPT，证据结果引用缺失不得被跳过比对；
 * - Owner 窗口必须持有 `delivery.item.ack` 才能读差异正文；
 * - 证据目录位于工作区内时不得把自身快照算成改动。
 *
 * R4 追加（07-CODE-REVIEW-R3 的四个反例 + 一处竞态）：
 * - 子目录 Territory 必须枚举到工作区内的真实改动（Git 一律从 repo root 调用）；
 * - 只有尾部变化的大文件不得被前缀摘要误判成「未变化」；无法完整 hash 时只能 `UNKNOWN`；
 * - 枚举/读取预算截断不得把仍在磁盘上的文件报成 `DELETED`；
 * - tracked PEM 的私钥主体不得进入内容寻址 blob；
 * - 外层预读通过后、锁前改绑必须被锁内复核拦下（用受控注入复现该交错）。
 *
 * 只用一次性临时仓库、临时证据根与内存 DB；不接触正式 kingdom.db、正式 Territory、
 * 凭据或真实 DSH/Provider。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { KingdomStore } from '../lib/core/db.js'
import { initializeKingdomFacts } from '../lib/core/kingdom.js'
import { bindRole } from '../lib/core/binding.js'
import { createTerritory, setTerritorySupervisor } from '../lib/core/territory.js'
import { reviewTask } from '../lib/core/task-service.js'
import { issueOwnerControlCapability, ownerControlAuth } from '../lib/core/owner-control.js'
import { OwnerDecisionController } from '../lib/core/owner-window.js'
import {
  DELIVERY_CHANGE_SNAPSHOT_EVENT_TYPE,
  DEFAULT_DELIVERY_CHANGE_BOUNDS,
  buildDeliveryChangeManifest,
  capturePostAndBuildChangeManifest,
  capturePreChangeSnapshot,
  changeSnapshotEventId,
  changeSnapshotEventPayload,
  readWorkspaceSnapshot,
  validateChangeSelection,
  workspaceKeyOf,
  type DeliveryChangeBounds,
  type DeliveryChangeManifest,
} from '../lib/core/delivery-change.js'

const NOW = '2026-09-27T07:00:00.000Z'
const sessionAuth = { mode: 'session-bound' as const, trustLevel: 'session-verified' as const, note: '' }
const CANARY = 'KINGDOM-PRIVATE-CANARY-9f3a'

/** 本机沙箱拒绝父子进程匿名管道；stdout/stderr 必须分开重定向。 */
function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kingdom-git-boundary-'))
  const out = join(dir, 'out.txt')
  const err = join(dir, 'err.txt')
  const outFd = openSync(out, 'w')
  const errFd = openSync(err, 'w')
  let status = -1
  try {
    const result = spawnSync('git', ['-C', cwd, ...args], { stdio: ['ignore', outFd, errFd], windowsHide: true })
    status = result.status ?? -1
  } finally {
    closeSync(outFd); closeSync(errFd)
  }
  const stdout = readFileSync(out, 'utf8')
  rmSync(dir, { recursive: true, force: true })
  return { ok: status === 0, stdout }
}

function writeRepoFile(repo: string, relative: string, body: string | Buffer): void {
  const absolute = join(repo, ...relative.split('/'))
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, body)
}

/** 递归读取证据目录下的全部文件正文，用于证明私有内容从未落盘。 */
function readEvidenceBodies(root: string): string {
  if (!existsSync(root)) return ''
  const bodies: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    bodies.push(readFileSync(join(entry.parentPath ?? root, entry.name), 'utf8'))
  }
  return bodies.join('\n')
}

interface Fixture {
  root: string
  repo: string
  evidenceRoot: string
  store: KingdomStore
  kingdomId: string
  supervisorSession: string
  supervisor: { binding_id: string }
  territory: { territory_id: string }
  capability: ReturnType<typeof issueOwnerControlCapability>
  cleanup: () => void
}

function fixture(t: { after(fn: () => void): void }, options: { supervisorSession?: string } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'kingdom-boundary-'))
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  assert.equal(git(repo, ['init', '--quiet']).ok, true, 'temp git repo initializes')
  git(repo, ['config', 'user.email', 'test@example.invalid'])
  git(repo, ['config', 'user.name', 'Boundary Test'])
  // 把本地 `core.excludesFile` 显式指向不存在的临时路径：本机既没有仓库级也没有全局设置，
  // 这样一次性仓库的 ignore 来源完全由各用例自己可见地声明，不再继承宿主环境。
  git(repo, ['config', 'core.excludesFile', join(root, 'absent-excludes-file')])
  writeRepoFile(repo, 'src/app.ts', 'export const first = 1\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '--quiet', '-m', 'baseline'])
  const evidenceRoot = join(root, 'evidence')
  const previousEvidenceRoot = process.env.DSH_KINGDOM_EVIDENCE_ROOT
  process.env.DSH_KINGDOM_EVIDENCE_ROOT = evidenceRoot

  const store = new KingdomStore(':memory:')
  const initialized = store.withImmediateTransaction(() => initializeKingdomFacts(store, '边界测试王国', '人类所有者'))
  const kingdomId = initialized.kingdomId
  const capability = issueOwnerControlCapability()
  const ownerAuth = ownerControlAuth(capability)
  const supervisorSession = options.supervisorSession ?? 'boundary-supervisor-session'
  bindRole(store, { kingdomId, roleType: 'SUPERVISOR', roleName: '主管', sessionId: supervisorSession }, ownerAuth)
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
  return { root, repo, evidenceRoot, store, kingdomId, supervisorSession, supervisor, territory, capability, cleanup }
}

interface RunOptions {
  attemptNo?: number
  resultRef?: string | null
  bounds?: Partial<DeliveryChangeBounds>
  mutate?: (f: Fixture) => void
}

/** 模拟真实编排：PRE → 副作用 → POST → manifest → 快照事件。 */
function runAttempt(f: Fixture, taskId: string, options: RunOptions = {}): { manifest: DeliveryChangeManifest; resultId: string } {
  const attemptNo = options.attemptNo ?? 1
  const resultId = `result-${taskId}-${attemptNo}`
  const pre = capturePreChangeSnapshot({
    workspacePath: f.repo, taskId, attemptNo, territoryId: f.territory.territory_id, bounds: options.bounds,
  })
  assert.ok(pre, 'PRE snapshot is captured')
  options.mutate?.(f)
  const manifest = capturePostAndBuildChangeManifest({
    workspacePath: f.repo, pre, taskId, attemptNo, territoryId: f.territory.territory_id, bounds: options.bounds,
  })
  assert.ok(manifest, 'manifest is built')
  const worker = f.store.getBindingByRole(f.kingdomId, 'WORKER')!
  f.store.insertTask({ task_id: taskId, territory_id: f.territory.territory_id, parent_task_id: null, title: '交付 ' + taskId,
    description: null, assigned_binding_id: worker.binding_id, status: 'REVIEW', acceptance_criteria: '核验改动', result_summary: null,
    created_at: NOW, updated_at: NOW })
  f.store.insertWorkerResult({ result_id: resultId, task_id: taskId, attempt_no: attemptNo, worker_binding_id: worker.binding_id,
    session_id: 'private-session', outcome: 'COMPLETED',
    result_json: JSON.stringify({ outcome: 'COMPLETED', summary: '完成改动', artifacts: [], risks: [] }), created_at: NOW })
  f.store.appendEvent({ event_id: changeSnapshotEventId(f.kingdomId, taskId, attemptNo, null), kingdom_id: f.kingdomId,
    event_type: DELIVERY_CHANGE_SNAPSHOT_EVENT_TYPE, actor_role: 'SUPERVISOR', actor_id: f.supervisor.binding_id,
    target_type: 'task', target_id: taskId,
    payload_json: JSON.stringify(changeSnapshotEventPayload(manifest, options.resultRef === undefined ? resultId : options.resultRef)),
    created_at: NOW })
  return { manifest, resultId }
}

function supervisorContext(f: Fixture) {
  return { kingdomId: f.kingdomId, principal: { sessionId: f.supervisorSession }, auth: sessionAuth }
}

function acceptEvents(f: Fixture, taskId: string) {
  return f.store.listEvents(f.kingdomId, 400).filter(event => event.event_type === 'TASK_ACCEPTED' && event.target_id === taskId)
}

// ── 缺陷 1：Git 忽略的私有内容不得成为候选，正文不得落盘 ─────────────────

test('gitignored private content is never a candidate, never read into evidence, and is reported as partial coverage', () => {
  const f = fixture(test)
  const taskId = 'task-ignored-private'
  writeRepoFile(f.repo, '.gitignore', 'private.txt\nkeys/\n')
  git(f.repo, ['add', '.gitignore'])
  git(f.repo, ['commit', '--quiet', '-m', 'ignore private content'])
  // 基线时任务前已脏的普通文件，用来证明「有改动」而不是「枚举失败」。
  writeRepoFile(f.repo, 'src/app.ts', 'export const first = 1\nexport const second = 2\n')
  writeRepoFile(f.repo, 'private.txt', `${CANARY}\n`)
  writeRepoFile(f.repo, 'keys/private.pem', `-----BEGIN PRIVATE KEY-----\n${CANARY}\n-----END PRIVATE KEY-----\n`)
  const { manifest } = runAttempt(f, taskId, {
    mutate: () => {
      writeRepoFile(f.repo, 'src/app.ts', 'export const first = 1\nexport const second = 3\n')
      writeRepoFile(f.repo, 'private.txt', `${CANARY}-CHANGED\n`)
      writeRepoFile(f.repo, 'keys/private.pem', `-----BEGIN PRIVATE KEY-----\n${CANARY}-CHANGED\n-----END PRIVATE KEY-----\n`)
    },
  })
  // 私有路径不出现在任何一侧快照或条目里。
  assert.equal(manifest.entries.some(entry => entry.path.includes('private.txt')), false, 'ignored file is never a candidate')
  assert.equal(manifest.entries.some(entry => entry.path.includes('.pem')), false, 'ignored key is never a candidate')
  assert.equal(manifest.entries.some(entry => entry.path === 'src/app.ts'), true, 'the ordinary change is still detected')
  // 正文从未被持久复制：证据目录里没有任何 canary。
  assert.equal(readEvidenceBodies(f.evidenceRoot).includes(CANARY), false, 'ignored bodies are never persisted')
  assert.equal(JSON.stringify(manifest).includes(CANARY), false, 'the manifest never carries ignored bodies')
  // 忽略内容被如实报成「有意排除 + 部分覆盖」，不谎称完整。
  assert.equal(manifest.coverage.complete, false, 'excluding ignored content can never be reported as complete coverage')
  assert.ok(manifest.coverage.reasons.includes('IGNORED_CONTENT_EXCLUDED'), JSON.stringify(manifest.coverage.reasons))
  assert.ok(manifest.pre.coverage.ignoredPaths >= 2, 'ignored paths are counted')
  assert.ok(manifest.pre.coverage.ignoredSamples.some(sample => sample.includes('private.txt') || sample.includes('private.pem')),
    'ignored path-name samples are recorded (paths only, no bodies)')
})

// ── 缺陷 2：未变化的超限文件不得成为「本窗口改动」────────────────────────

test('an unchanged oversize file produces no change entry and no coverage claim', () => {
  const f = fixture(test)
  const taskId = 'task-oversize-unchanged'
  writeRepoFile(f.repo, 'big.txt', 'x'.repeat(300_000))
  git(f.repo, ['add', 'big.txt'])
  git(f.repo, ['commit', '--quiet', '-m', 'add big file'])
  const { manifest } = runAttempt(f, taskId, {
    mutate: () => writeRepoFile(f.repo, 'src/app.ts', 'export const first = 2\n'),
  })
  assert.equal(manifest.entries.some(entry => entry.path === 'big.txt'), false,
    `an oversize file with an equal bounded digest is not reported as a window change (entries=${manifest.entries.map(e => e.path).join(',')})`)
  assert.equal(manifest.entries.find(entry => entry.path === 'src/app.ts')?.status, 'MODIFIED')
  assert.equal(manifest.coverage.complete, true, JSON.stringify(manifest.coverage))
  // 超限文件只贡献有界摘要：正文从未被保留。
  const preSnapshot = readWorkspaceSnapshot(undefined, manifest.pre.snapshotId)!
  const bigObservation = preSnapshot.files.find(file => file.path === 'big.txt')!
  assert.equal(bigObservation.readability, 'READABLE', 'the bounded digest is still computed')
  assert.equal(bigObservation.retained, false, 'the oversize body is never retained')
  assert.equal(bigObservation.storedHash, null)
})

test('a real oversize change stays honestly labelled and can never claim complete coverage', () => {
  const f = fixture(test)
  const taskId = 'task-oversize-changed'
  writeRepoFile(f.repo, 'big.txt', 'x'.repeat(300_000))
  git(f.repo, ['add', 'big.txt'])
  git(f.repo, ['commit', '--quiet', '-m', 'add big file'])
  const { manifest } = runAttempt(f, taskId, {
    mutate: () => writeRepoFile(f.repo, 'big.txt', `${'x'.repeat(300_000)}y`),
  })
  const oversize = manifest.entries.find(entry => entry.path === 'big.txt')
  assert.ok(oversize, 'a real oversize change is still reported')
  assert.equal(oversize.status, 'MODIFIED')
  assert.equal(oversize.reasonCode, 'FILE_OVER_SIZE_LIMIT')
  assert.ok(oversize.labels.includes('BODY_NOT_COMPARED_BY_LINES'))
  assert.equal(manifest.coverage.complete, false, 'oversize changes can never claim complete line coverage')
  assert.ok(manifest.coverage.reasons.includes('FILE_OVER_SIZE_LIMIT'), JSON.stringify(manifest.coverage.reasons))
})

// ── 缺陷 3：普通目录不得被静默跳过；证据目录自身不算改动 ───────────────────

test('ordinary directories are never silently skipped, and the evidence root inside the workspace is excluded', () => {
  const f = fixture(test)
  const taskId = 'task-ordinary-directory'
  writeRepoFile(f.repo, 'internal/keep.txt', 'before\n')
  git(f.repo, ['add', 'internal/keep.txt'])
  git(f.repo, ['commit', '--quiet', '-m', 'add internal file'])
  // 证据目录就放在工作区内：它自己的快照文件不得被算成领地改动。
  const evidenceInsideWorkspace = join(f.repo, '.kingdom-evidence')
  const previous = process.env.DSH_KINGDOM_EVIDENCE_ROOT
  process.env.DSH_KINGDOM_EVIDENCE_ROOT = evidenceInsideWorkspace
  let manifest: DeliveryChangeManifest
  try {
    manifest = runAttempt(f, taskId, {
      mutate: () => writeRepoFile(f.repo, 'internal/keep.txt', 'after\n'),
    }).manifest
  } finally {
    if (previous === undefined) delete process.env.DSH_KINGDOM_EVIDENCE_ROOT
    else process.env.DSH_KINGDOM_EVIDENCE_ROOT = previous
  }
  const changed = manifest.entries.find(entry => entry.path === 'internal/keep.txt')
  assert.ok(changed, `a change under an ordinary directory is detected (entries=${manifest.entries.map(e => e.path).join(',')})`)
  assert.equal(changed.status, 'MODIFIED')
  assert.equal(manifest.entries.some(entry => entry.path.startsWith('.kingdom-evidence')), false,
    'the evidence directory inside the workspace is never reported as a change')
  assert.ok(manifest.pre.coverage.evidenceRootExcluded > 0 || manifest.post.coverage.evidenceRootExcluded > 0,
    'the excluded evidence root is accounted for')
  assert.equal(manifest.coverage.complete, false, 'an intentional in-workspace exclusion cannot claim complete coverage')
  assert.ok(manifest.coverage.reasons.includes('EVIDENCE_ROOT_EXCLUDED'), JSON.stringify(manifest.coverage.reasons))
})

// ── 缺陷 5：显式空选择与空白 entry id 不得退化为普通 ACCEPT ────────────────

test('An explicit empty or blank change selection is rejected instead of degrading to a plain ACCEPT', () => {
  const f = fixture(test)
  const taskId = 'task-empty-selection'
  const { manifest } = runAttempt(f, taskId, {
    mutate: () => writeRepoFile(f.repo, 'src/app.ts', 'export const first = 1\nexport const second = 9\n'),
  })
  const entry = manifest.entries.find(candidate => candidate.path === 'src/app.ts')!
  const rejected = [
    { change_evidence_id: manifest.evidenceId, change_entry_ids: [] as string[] },
    { change_evidence_id: manifest.evidenceId, change_entry_ids: [''] },
    { change_evidence_id: manifest.evidenceId, change_entry_ids: ['   '] },
    { change_evidence_id: '', change_entry_ids: [entry.entryId] },
    { change_evidence_id: '   ', change_entry_ids: [entry.entryId] },
  ]
  for (const input of rejected) {
    const result = reviewTask(f.store, supervisorContext(f), { taskId, decision: 'ACCEPT', ...input })
    assert.equal(result.ok, false, JSON.stringify(input))
    assert.equal(result.errorCode, 'CHANGE_SELECTION_INVALID', JSON.stringify(input))
  }
  assert.equal(f.store.getTask(taskId)?.status, 'REVIEW')
  assert.equal(acceptEvents(f, taskId).length, 0, 'a rejected selection writes zero facts')
})

test('a change snapshot without a result reference can never be confirmed against the current Claim', () => {
  const f = fixture(test)
  const taskId = 'task-null-result-ref'
  const { manifest } = runAttempt(f, taskId, {
    resultRef: null,
    mutate: () => writeRepoFile(f.repo, 'src/app.ts', 'export const first = 1\nexport const second = 4\n'),
  })
  const entry = manifest.entries.find(candidate => candidate.path === 'src/app.ts')!
  const result = reviewTask(f.store, supervisorContext(f), {
    taskId, decision: 'ACCEPT', change_evidence_id: manifest.evidenceId, change_entry_ids: [entry.entryId],
  })
  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'CHANGE_EVIDENCE_UNVERIFIED')
  assert.match(result.message, /结果/u)
  assert.equal(f.store.getTask(taskId)?.status, 'REVIEW')
  assert.equal(acceptEvents(f, taskId).length, 0)
})

// ── 缺陷 6：锁内复核当前 Territory Supervisor binding ─────────────────────

test('a concurrently re-bound territory supervisor cannot sign change evidence with the stale pre-read identity', () => {
  const f = fixture(test)
  const taskId = 'task-concurrent-rebind'
  const { manifest } = runAttempt(f, taskId, {
    mutate: () => writeRepoFile(f.repo, 'src/app.ts', 'export const first = 1\nexport const second = 5\n'),
  })
  const entry = manifest.entries.find(candidate => candidate.path === 'src/app.ts')!
  // 事务外预读：原 session 仍被解析为当前领地主管，显式选择本身合法。
  const ownerAuth = ownerControlAuth(f.capability)
  bindRole(f.store, { kingdomId: f.kingdomId, roleType: 'SUPERVISOR', roleName: '替换主管', sessionId: 'replacement-session' }, ownerAuth)
  const replacement = f.store.getBindingsByRole(f.kingdomId, 'SUPERVISOR').find(binding => binding.role_name === '替换主管')!
  setTerritorySupervisor(f.store, {
    kingdomId: f.kingdomId, territoryId: f.territory.territory_id, supervisorBindingId: replacement.binding_id,
  }, ownerAuth)
  // 并发改绑后，事务内的锁内复核必须发现调用者 session 不再是本领地主管。
  const result = reviewTask(f.store, supervisorContext(f), {
    taskId, decision: 'ACCEPT', change_evidence_id: manifest.evidenceId, change_entry_ids: [entry.entryId],
  })
  assert.equal(result.ok, false, 'the stale supervisor session cannot sign after a concurrent rebind')
  assert.ok(['UNAUTHORIZED_PRINCIPAL', 'TASK_OUT_OF_SCOPE'].includes(result.errorCode ?? ''),
    `the locked-in re-check rejects the stale identity (got ${result.errorCode})`)
  assert.equal(f.store.getTask(taskId)?.status, 'REVIEW')
  assert.equal(acceptEvents(f, taskId).length, 0, 'no TASK_ACCEPTED is written for the stale identity')
  // 伪造的锁外预读身份也不会留在事实里：没有任何事件以旧 binding 签署。
  assert.equal(f.store.listEvents(f.kingdomId, 400).some(event => event.event_type === 'TASK_ACCEPTED'), false)

  // 换回原主管后同一选择可以成立，且签名身份必须是当前锁内 binding。
  setTerritorySupervisor(f.store, {
    kingdomId: f.kingdomId, territoryId: f.territory.territory_id, supervisorBindingId: f.supervisor.binding_id,
  }, ownerAuth)
  const accepted = reviewTask(f.store, supervisorContext(f), {
    taskId, decision: 'ACCEPT', change_evidence_id: manifest.evidenceId, change_entry_ids: [entry.entryId],
  })
  assert.equal(accepted.ok, true, accepted.message)
  assert.equal(acceptEvents(f, taskId)[0]!.actor_id, f.supervisor.binding_id, 'the locked-in binding signs the evidence')
})

// ── 缺陷 7：Owner 读取差异正文必须持有 delivery.item.ack ───────────────────

test('an Owner window without delivery.item.ack cannot read change bodies even inside the same territory scope', () => {
  const f = fixture(test)
  const taskId = 'task-owner-action-scope'
  const { manifest } = runAttempt(f, taskId, {
    mutate: () => writeRepoFile(f.repo, 'src/app.ts', 'export const first = 1\nexport const second = 6\n'),
  })
  const entry = manifest.entries.find(candidate => candidate.path === 'src/app.ts')!
  reviewTask(f.store, supervisorContext(f), {
    taskId, decision: 'ACCEPT', change_evidence_id: manifest.evidenceId, change_entry_ids: [entry.entryId],
  })
  const controller = new OwnerDecisionController(f.store, {
    validateTargetSession: async () => ({ ok: true }), validateExecutionProfile: async () => ({ ok: true }),
    listTargetSessions: async ({ sessionIds }) => sessionIds.map(id => ({ id, label: id })),
  })
  const scope = { kingdomWide: false, territoryIds: [f.territory.territory_id], bindingIds: [], roleTypes: [], targetSessionIds: [], workspaceRoots: [] }
  // 同领地、同 scope，但本次窗口没有授权 delivery.item.ack。
  const unauthorized = controller.activate(f.capability, {
    kingdomId: f.kingdomId, actions: ['plan.adopt'], ttlMs: 600000, scope,
  }).handle
  assert.throws(
    () => controller.readDeliveryChange(unauthorized, { taskId, evidenceId: manifest.evidenceId, entryId: entry.entryId }),
    /未授权交付条目知悉动作/u,
  )
  // 对照：持有该动作的有效窗口仍可读取，且读取零写入。
  const authorized = controller.activate(f.capability, {
    kingdomId: f.kingdomId, actions: ['delivery.item.ack'], ttlMs: 600000, scope,
  }).handle
  const eventsBefore = f.store.listEvents(f.kingdomId, 400).length
  const view = controller.readDeliveryChange(authorized, { taskId, evidenceId: manifest.evidenceId, entryId: entry.entryId })
  assert.equal(view.repoPath, 'src/app.ts')
  assert.ok(view.hunks.some(hunk => hunk.text.includes('second = 6')))
  assert.equal(f.store.listEvents(f.kingdomId, 400).length, eventsBefore, 'reading a change never writes a fact')
  controller.dispose()
})

// ── 边界：没有 Git 基准时零采集，不伪造改动 ────────────────────────────────

test('a workspace without a usable Git baseline produces no snapshot and no change evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'kingdom-nonrepo-'))
  const previous = process.env.DSH_KINGDOM_EVIDENCE_ROOT
  process.env.DSH_KINGDOM_EVIDENCE_ROOT = join(root, 'evidence')
  try {
    mkdirSync(join(root, 'loose'), { recursive: true })
    writeFileSync(join(root, 'loose', 'file.txt'), 'no vcs here\n')
    const snapshot = capturePreChangeSnapshot({ workspacePath: join(root, 'loose'), taskId: 't', attemptNo: 1, territoryId: 'terr' })
    assert.equal(snapshot, null, 'without a Git baseline no snapshot is produced')
  } finally {
    if (previous === undefined) delete process.env.DSH_KINGDOM_EVIDENCE_ROOT
    else process.env.DSH_KINGDOM_EVIDENCE_ROOT = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test('a selection that includes an unproven entry is rejected by validateChangeSelection', () => {
  const f = fixture(test)
  const taskId = 'task-unproven-entry'
  const { manifest } = runAttempt(f, taskId, {
    mutate: () => writeRepoFile(f.repo, 'src/app.ts', 'export const first = 1\nexport const second = 7\n'),
  })
  const entry = manifest.entries.find(candidate => candidate.path === 'src/app.ts')!
  const forged = {
    ...manifest,
    entries: [...manifest.entries, {
      entryId: 'a'.repeat(64), path: 'src/unproven.ts', status: 'UNKNOWN' as const, reasonCode: 'FILE_CHANGE_UNPROVEN',
      labels: ['CHANGE_NOT_PROVEN'], note: '', binary: false, bodyRetained: false, beforeHash: null, afterHash: null,
      baselineBodyUnavailable: false, hunks: [],
    }],
  }
  const good = validateChangeSelection(undefined, forged, [entry.entryId], { taskId, attemptNo: 1 })
  assert.equal(good.ok, true)
  const bad = validateChangeSelection(undefined, forged, ['a'.repeat(64)], { taskId, attemptNo: 1 })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'CHANGE_ENTRY_UNPROVEN')
  assert.equal(DEFAULT_DELIVERY_CHANGE_BOUNDS.maxFileBytes, 262_144)
})

// ── R4 缺陷 A：子目录 Territory 必须真的枚举到工作区内的改动 ────────────────

test('a Territory that is a repository subdirectory still detects the real change inside it', () => {
  const f = fixture(test)
  const taskId = 'task-subdir-territory'
  // 领地工作区是仓库子目录：tracked 的 src/app.ts 在 PRE/POST 之间 old→new。
  const workspace = join(f.repo, 'src')
  // 用真实子目录领地承载本次 capture：Territory ID 会进入 manifest 并被 ACCEPT 精确复核。
  const ownerAuth = ownerControlAuth(f.capability)
  createTerritory(f.store, { kingdomId: f.kingdomId, name: '子目录领地', workspacePath: workspace }, ownerAuth)
  const subdirTerritory = f.store.listTerritories(f.kingdomId).find(territory => territory.workspace_path === workspace)!
  setTerritorySupervisor(f.store, {
    kingdomId: f.kingdomId, territoryId: subdirTerritory.territory_id, supervisorBindingId: f.supervisor.binding_id,
  }, ownerAuth)
  const pre = capturePreChangeSnapshot({ workspacePath: workspace, taskId, attemptNo: 1, territoryId: subdirTerritory.territory_id })
  assert.ok(pre, 'PRE snapshot is captured for the subdirectory workspace')
  assert.equal(pre.repo.scope, 'WORKSPACE_SUBDIR', `the workspace is recognized as a repository subdirectory (got ${pre.repo.scope})`)
  writeRepoFile(f.repo, 'src/app.ts', 'export const first = 1\nexport const second = 42\n')
  const manifest = capturePostAndBuildChangeManifest({ workspacePath: workspace, pre, taskId, attemptNo: 1, territoryId: subdirTerritory.territory_id })
  assert.ok(manifest, 'manifest is built for the subdirectory workspace')
  assert.equal(manifest.territoryId, subdirTerritory.territory_id, 'the manifest binds the exact subdirectory Territory')
  // 条目路径是**仓库相对**的：工作区相对映射只用于本地读取与身份，公开路径必须补回
  // 仓库前缀（合同要求「仓库相对路径」）。
  const changed = manifest.entries.find(entry => entry.repoPath === 'src/app.ts')
  assert.ok(changed, `a real change under a subdirectory Territory is detected (entries=${manifest.entries.map(e => e.repoPath).join(',') || '<empty>'})`)
  assert.equal(changed.path, 'app.ts', 'the internal read path stays workspace-relative')
  assert.equal(changed.status, 'MODIFIED')
  assert.equal(changed.reasonCode, 'CONTENT_CHANGED_IN_WINDOW')
  assert.equal(changed.beforeHash !== changed.afterHash, true, 'the complete content hash really changed')
  // 工作区内确实存在的真实改动不允许被报成「无改动 + 完整覆盖」。
  assert.equal(pre.coverage.observedFiles > 0, true, 'the baseline really observed workspace files')
  assert.equal(pre.coverage.complete, true, JSON.stringify(pre.coverage))
  // 主管候选与 Owner 详情展示的也是仓库相对路径（不是工作区相对路径）。
  const worker = f.store.getBindingByRole(f.kingdomId, 'WORKER')!
  f.store.insertTask({ task_id: taskId, territory_id: subdirTerritory.territory_id, parent_task_id: null,
    title: '交付 ' + taskId, description: null, assigned_binding_id: worker.binding_id, status: 'REVIEW',
    acceptance_criteria: '核验改动', result_summary: null, created_at: NOW, updated_at: NOW })
  f.store.insertWorkerResult({ result_id: `result-${taskId}`, task_id: taskId, attempt_no: 1, worker_binding_id: worker.binding_id,
    session_id: 'private-session', outcome: 'COMPLETED',
    result_json: JSON.stringify({ outcome: 'COMPLETED', summary: '完成改动', artifacts: [], risks: [] }), created_at: NOW })
  f.store.appendEvent({ event_id: changeSnapshotEventId(f.kingdomId, taskId, 1, null), kingdom_id: f.kingdomId,
    event_type: DELIVERY_CHANGE_SNAPSHOT_EVENT_TYPE, actor_role: 'SUPERVISOR', actor_id: f.supervisor.binding_id,
    target_type: 'task', target_id: taskId,
    payload_json: JSON.stringify(changeSnapshotEventPayload(manifest, `result-${taskId}`)), created_at: NOW })
  const accepted = reviewTask(f.store, supervisorContext(f), {
    taskId, decision: 'ACCEPT', change_evidence_id: manifest.evidenceId, change_entry_ids: [changed.entryId],
  })
  assert.equal(accepted.ok, true, accepted.ok ? '' : `${accepted.errorCode}: ${accepted.message}`)
  const controller = new OwnerDecisionController(f.store, {
    validateTargetSession: async () => ({ ok: true }), validateExecutionProfile: async () => ({ ok: true }),
    listTargetSessions: async ({ sessionIds }) => sessionIds.map(id => ({ id, label: id })),
  })
  const handle = controller.activate(f.capability, {
    kingdomId: f.kingdomId, actions: ['delivery.item.ack'], ttlMs: 600000,
    scope: { kingdomWide: false, territoryIds: [subdirTerritory.territory_id], bindingIds: [], roleTypes: [], targetSessionIds: [], workspaceRoots: [] },
  }).handle
  const view = controller.readDeliveryChange(handle, { taskId, evidenceId: manifest.evidenceId, entryId: changed.entryId })
  assert.equal(view.repoPath, 'src/app.ts', `the Owner detail shows the repo-relative path (got ${view.repoPath})`)
  controller.dispose()
})

// ── R4 缺陷 B：只在尾部变化的大文件不得漏报 ────────────────────────────────

test('a tracked file whose only change is its tail byte is never mistaken for an unchanged file', () => {
  const f = fixture(test)
  const taskId = 'task-oversize-tail'
  // 262145 字节：PRE/POST 大小相同、前 262144 字节相同，仅末字节不同。
  const head = 'x'.repeat(DEFAULT_DELIVERY_CHANGE_BOUNDS.maxFileBytes)
  writeRepoFile(f.repo, 'tail.txt', `${head}a`)
  git(f.repo, ['add', 'tail.txt'])
  git(f.repo, ['commit', '--quiet', '-m', 'add tail file'])
  const { manifest } = runAttempt(f, taskId, {
    mutate: () => writeRepoFile(f.repo, 'tail.txt', `${head}b`),
  })
  const tail = manifest.entries.find(entry => entry.path === 'tail.txt')
  assert.ok(tail, `a tail-only change is still reported (entries=${manifest.entries.map(e => e.path).join(',') || '<empty>'})`)
  assert.equal(tail.status, 'MODIFIED')
  assert.equal(tail.reasonCode, 'FILE_OVER_SIZE_LIMIT')
  assert.equal(tail.beforeHash !== tail.afterHash, true, 'the hash covers the whole file, not just its bounded head')
  assert.equal(manifest.coverage.complete, false, 'an oversize body is never claimed as complete line coverage')
})

test('a file too large to hash completely stays unproven instead of silently equal or silently missing', () => {
  const f = fixture(test)
  const taskId = 'task-hash-limit'
  writeRepoFile(f.repo, 'huge.txt', 'y'.repeat(64))
  git(f.repo, ['add', 'huge.txt'])
  git(f.repo, ['commit', '--quiet', '-m', 'add huge file'])
  const bounds = { maxHashBytes: 16 }
  const pre = capturePreChangeSnapshot({ workspacePath: f.repo, taskId, attemptNo: 1, territoryId: f.territory.territory_id, bounds })
  assert.ok(pre, 'PRE snapshot is captured')
  const huge = pre.files.find(file => file.path === 'huge.txt')!
  assert.equal(huge.readability, 'UNREADABLE', 'a file beyond the complete-hash bound is never called READABLE')
  assert.equal(huge.rawHash, null, 'no prefix digest ever masquerades as a complete content hash')
  writeRepoFile(f.repo, 'huge.txt', `${'y'.repeat(63)}z`)
  const manifest = capturePostAndBuildChangeManifest({ workspacePath: f.repo, pre, taskId, attemptNo: 1, territoryId: f.territory.territory_id, bounds })
  assert.ok(manifest, 'manifest is built')
  const entry = manifest.entries.find(candidate => candidate.path === 'huge.txt')
  assert.ok(entry, 'the unhashable path is reported as an unproven entry, not omitted')
  assert.equal(entry.status, 'UNKNOWN')
  assert.equal(entry.reasonCode, 'FILE_CHANGE_UNPROVEN')
  assert.equal(manifest.coverage.complete, false)
  const selection = validateChangeSelection(undefined, manifest, [entry.entryId], { taskId, attemptNo: 1 })
  assert.equal(selection.ok, false, 'an unproven entry can never be confirmed')
  assert.equal(selection.code, 'CHANGE_ENTRY_UNPROVEN')
})

// ── R4 缺陷 C：预算截断不得制造假删除 ──────────────────────────────────────

test('a file merely omitted by the enumeration budget is never reported as deleted', () => {
  const f = fixture(test)
  const taskId = 'task-budget-delete'
  // maxFiles=1：PRE 只采到未变的 b.txt，POST 新建排序靠前的 a.txt 后只采 a。
  writeRepoFile(f.repo, 'b.txt', 'stable\n')
  git(f.repo, ['add', 'b.txt'])
  git(f.repo, ['commit', '--quiet', '-m', 'add b'])
  const bounds = { maxFiles: 1 }
  const pre = capturePreChangeSnapshot({ workspacePath: f.repo, taskId, attemptNo: 1, territoryId: f.territory.territory_id, bounds })
  assert.ok(pre, 'PRE snapshot is captured')
  assert.equal(pre.files.some(file => file.path === 'b.txt'), true, 'the PRE snapshot really observed b.txt')
  // 枚举被文件预算截断：本快照「没有该路径」不再等于「它当时不存在」。
  assert.equal(pre.enumerationComplete, false)
  assert.equal(pre.files.some(file => file.path === 'a.txt'), false, 'a.txt did not exist yet')
  writeRepoFile(f.repo, 'a.txt', 'fresh\n')
  const manifest = capturePostAndBuildChangeManifest({ workspacePath: f.repo, pre, taskId, attemptNo: 1, territoryId: f.territory.territory_id, bounds })
  assert.ok(manifest, 'manifest is built')
  const stale = manifest.entries.find(entry => entry.path === 'b.txt')
  assert.ok(stale, 'the omitted-at-POST path is reported instead of being silently dropped')
  assert.notEqual(stale.status, 'DELETED', 'a file that still exists on disk is never reported as deleted')
  assert.equal(stale.status, 'UNKNOWN')
  assert.ok(['EXISTENCE_NOT_OBSERVED', 'FILE_CHANGE_UNPROVEN'].includes(stale.reasonCode), stale.reasonCode)
  assert.equal(existsSync(join(f.repo, 'b.txt')), true, 'b.txt really still exists')
  // 枚举被截断时新增同样不可确认：文件没进入基线快照不等于基线不存在。
  const fresh = manifest.entries.find(entry => entry.path === 'a.txt')
  assert.ok(fresh, 'the freshly created path is reported')
  assert.notEqual(fresh.status, 'ADDED', 'a truncated baseline can never prove a file was created in this window')
  assert.equal(fresh.status, 'UNKNOWN')
  assert.equal(manifest.coverage.complete, false, 'a truncated enumeration is never called complete coverage')
  assert.ok(manifest.coverage.reasons.includes('FILE_LIMIT_REACHED'), JSON.stringify(manifest.coverage.reasons))
  assert.ok(manifest.coverage.reasons.includes('ENUMERATION_INCOMPLETE'), JSON.stringify(manifest.coverage.reasons))
  for (const unproven of [stale, fresh]) {
    const selection = validateChangeSelection(undefined, manifest, [unproven.entryId], { taskId, attemptNo: 1 })
    assert.equal(selection.ok, false, 'a budget-omitted path can never be confirmed as a change')
    assert.equal(selection.code, 'CHANGE_ENTRY_UNPROVEN')
  }
})

test('a complete enumeration still proves a file created inside the window', () => {
  const f = fixture(test)
  const taskId = 'task-complete-enumeration-add'
  // 候选集合完整（没有任何预算截断）：基线快照里没有该路径 = 基线确实不存在。
  writeRepoFile(f.repo, 'b.txt', 'stable\n')
  git(f.repo, ['add', 'b.txt'])
  git(f.repo, ['commit', '--quiet', '-m', 'add b'])
  const { manifest } = runAttempt(f, taskId, {
    mutate: () => writeRepoFile(f.repo, 'a.txt', 'fresh\n'),
  })
  assert.equal(manifest.pre.coverage.complete && manifest.post.coverage.complete, true, JSON.stringify(manifest.coverage.reasons))
  const added = manifest.entries.find(entry => entry.path === 'a.txt')
  assert.ok(added, `a real creation is reported (entries=${manifest.entries.map(e => e.path).join(',') || '<empty>'})`)
  assert.equal(added.status, 'ADDED')
  assert.equal(added.reasonCode, 'FILE_APPEARED_IN_WINDOW')
  assert.ok(added.labels.includes('UNTRACKED_FILE_CREATED_IN_WINDOW'), added.labels.join(','))
})

test('a tracked file really removed inside the window is still reported as deleted', () => {
  const f = fixture(test)
  const taskId = 'task-real-delete'
  writeRepoFile(f.repo, 'gone.txt', 'temporary\n')
  git(f.repo, ['add', 'gone.txt'])
  git(f.repo, ['commit', '--quiet', '-m', 'add gone'])
  const { manifest } = runAttempt(f, taskId, {
    mutate: () => rmSync(join(f.repo, 'gone.txt'), { force: true }),
  })
  const deleted = manifest.entries.find(entry => entry.path === 'gone.txt')
  assert.ok(deleted, `a genuinely removed tracked file is reported (entries=${manifest.entries.map(e => e.path).join(',') || '<empty>'})`)
  assert.equal(deleted.status, 'DELETED', 'an explicitly observed absence is a real deletion')
  assert.equal(deleted.reasonCode, 'FILE_REMOVED_IN_WINDOW')
})

// ── R4 缺陷 D：tracked PEM 正文绝不进入内容寻址 blob ───────────────────────

test('a tracked PEM file never has its key body persisted into the evidence directory', () => {
  const f = fixture(test)
  const taskId = 'task-tracked-pem'
  const pemCanary = 'KINGDOM-PEM-BODY-CANARY-4c17'
  writeRepoFile(f.repo, 'key.pem', `-----BEGIN PRIVATE KEY-----\n${pemCanary}-BEFORE\n-----END PRIVATE KEY-----\n`)
  git(f.repo, ['add', 'key.pem'])
  git(f.repo, ['commit', '--quiet', '-m', 'add tracked pem'])
  const { manifest } = runAttempt(f, taskId, {
    mutate: () => writeRepoFile(f.repo, 'key.pem', `-----BEGIN PRIVATE KEY-----\n${pemCanary}-AFTER\n-----END PRIVATE KEY-----\n`),
  })
  const pem = manifest.entries.find(entry => entry.path === 'key.pem')
  assert.ok(pem, `the tracked PEM path is still reported as a bounded change (entries=${manifest.entries.map(e => e.path).join(',') || '<empty>'})`)
  assert.equal(pem.bodyRetained, false, 'the PEM body is never retained')
  assert.equal(pem.hunks.length, 0, 'no line fragments are derived from a PEM body')
  assert.equal(manifest.coverage.complete, false)
  assert.ok(manifest.coverage.reasons.includes('SENSITIVE_BODY_NOT_RETAINED'), JSON.stringify(manifest.coverage.reasons))
  // 证据目录里不存在任何私钥主体（只可能命中我们自己的标记文案）。
  const bodies = readEvidenceBodies(f.evidenceRoot)
  assert.equal(bodies.includes(pemCanary), false, 'the key body never reaches the evidence directory')
  assert.equal(JSON.stringify(manifest).includes(pemCanary), false, 'the manifest never carries the key body')
})

// ── R4 竞态：外层预读通过后、锁前改绑必须改用锁内身份 ──────────────────────

test('a rebind injected between the outer pre-read and the ACCEPT transaction is answered with the locked-in identity', () => {
  const f = fixture(test)
  const taskId = 'task-injected-rebind'
  const { manifest } = runAttempt(f, taskId, {
    mutate: () => writeRepoFile(f.repo, 'src/app.ts', 'export const first = 1\nexport const second = 11\n'),
  })
  const entry = manifest.entries.find(candidate => candidate.path === 'src/app.ts')!
  const ownerAuth = ownerControlAuth(f.capability)
  // 事务外的预读身份：原主管。
  assert.equal(f.store.getBindingByRole(f.kingdomId, 'SUPERVISOR')!.binding_id, f.supervisor.binding_id)
  const original = f.store.withImmediateTransaction.bind(f.store)
  let injected = false
  // 受控注入：让改绑恰好发生在外层预读之后、ACCEPT 事务正文之前——这正是既有
  // 「先调用 reviewTask、再改绑」测试覆盖不到的锁前交错（测试内直接改绑做不到）。
  f.store.withImmediateTransaction = function <T>(this: KingdomStore, fn: () => T): T {
    return original(() => {
      if (!injected) {
        injected = true
        bindRole(f.store, { kingdomId: f.kingdomId, roleType: 'SUPERVISOR', roleName: '锁内新主管', sessionId: 'midflight-session' },
          ownerControlAuth(f.capability))
        const replacement = f.store.getBindingsByRole(f.kingdomId, 'SUPERVISOR').find(binding => binding.role_name === '锁内新主管')!
        setTerritorySupervisor(f.store, {
          kingdomId: f.kingdomId, territoryId: f.territory.territory_id, supervisorBindingId: replacement.binding_id,
        }, ownerControlAuth(f.capability))
      }
      return fn()
    })
  }
  let result: ReturnType<typeof reviewTask>
  try {
    // 调用者仍是事务外预读到的原主管 session：预读会通过，锁内复核必须发现它已过期。
    result = reviewTask(f.store, supervisorContext(f), {
      taskId, decision: 'ACCEPT', change_evidence_id: manifest.evidenceId, change_entry_ids: [entry.entryId],
    })
  } finally {
    f.store.withImmediateTransaction = original
  }
  assert.equal(injected, true, 'the rebind really happened between the outer pre-read and the transaction body')
  const replacement = f.store.getBindingsByRole(f.kingdomId, 'SUPERVISOR').find(binding => binding.role_name === '锁内新主管')!
  assert.equal(result.ok, false, 'the stale pre-read identity cannot sign once the lock sees the rebind')
  assert.ok(['UNAUTHORIZED_PRINCIPAL', 'TASK_OUT_OF_SCOPE'].includes(result.errorCode ?? ''),
    `the lock-in re-check rejects the stale identity (got ${result.errorCode})`)
  assert.equal(f.store.getTerritoryById(f.territory.territory_id)?.supervisor_binding_id, replacement.binding_id,
    'the territory really points at the locked-in supervisor')
  assert.equal(acceptEvents(f, taskId).length, 0, 'no TASK_ACCEPTED is written from the stale pre-read identity')
  assert.equal(f.store.getTask(taskId)?.status, 'REVIEW', 'the task stays in REVIEW')
})

// ── R4 范围回退：Runtime cwd 原行为不变，采集只认 canonical workspace ────────

test('the runtime cwd fallback is preserved while diff capture only ever uses the canonical workspace', async () => {
  const { readFileSync: read } = await import('node:fs')
  const { join: joinPath, dirname: dirnamePath } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const repoRoot = joinPath(dirnamePath(fileURLToPath(import.meta.url)), '..')
  const indexSource = read(joinPath(repoRoot, 'src', 'index.ts'), 'utf8')
  const executorSource = read(joinPath(repoRoot, 'src', 'worker', 'governed-executor.ts'), 'utf8')
  // Runtime 输入保持既有行为：无 workspace 的旧 Territory 仍回退 process.cwd()。
  assert.ok(/cwd: territory\.workspace_path \?\? process\.cwd\(\)/u.test(indexSource),
    'the governed Runtime cwd keeps its original process.cwd() fallback')
  assert.equal(/cwd: territory\.workspace_path \?\? ['"]['"]/u.test(indexSource), false,
    'the Runtime cwd is never replaced by an empty string')
  // 差异采集不复用 Runtime 回退值：只接受 Territory 的 canonical workspace。
  assert.ok(/changeWorkspacePath: territory\.workspace_path \?\? null/u.test(indexSource),
    'diff capture receives the canonical workspace separately')
  assert.ok(/const changeWorkspacePath = input\.changeWorkspacePath \?\? null/u.test(executorSource),
    'the executor only captures when a canonical workspace was supplied')
  // 两个采集调用的取值必须是 canonical workspace，绝不能是可能回退到 process.cwd() 的
  // Runtime cwd（`reserveWorkspaceAdmission` 仍按既有语义使用 Runtime cwd）。
  const preCapture = executorSource.slice(executorSource.indexOf('const changePre ='),
    executorSource.indexOf('const run = await runGovernedDispatch'))
  const postCapture = executorSource.slice(executorSource.indexOf('const changeManifest ='),
    executorSource.indexOf('//    terminalOutcome'))
  for (const [label, block] of [['PRE', preCapture], ['POST', postCapture]] as const) {
    assert.ok(block.includes('workspacePath: changeWorkspacePath'), `${label} capture uses the canonical workspace`)
    assert.equal(block.includes('workspacePath: cwd'), false, `${label} capture never uses the Runtime cwd`)
  }
})

// ── R5 缺陷 1：未变化的 symlink 不得被确认为改动 ────────────────────────────

/**
 * 本机沙箱拒绝 `symlink(2)`（EPERM），所以这里用**两份同值观察**构造隔离 manifest：
 * 与 Codex R4 反例同一形状（两侧都是 `SYMLINK`、没有链接自身摘要），不接触真实
 * 文件系统语义，也不需要真实链接。真实链接版本的端到端反例见下一个测试。
 */
test('two identical symlink observations are never reported as a confirmable modification', () => {
  const f = fixture(test)
  const taskId = 'task-symlink-identical-observation'
  const symlinkObservation = (snapshotId: string, phase: 'PRE' | 'POST') => ({
    version: 'KingdomDeliveryWorkspaceSnapshot/v1' as const,
    snapshotId: '', phase, taskId, attemptNo: 1, territoryId: f.territory.territory_id,
    workspaceKey: workspaceKeyOf(f.repo)!, executionId: null, leaseId: null, dispatchId: null,
    repo: { vcs: 'GIT' as const, identity: 'a'.repeat(32), head: 'b'.repeat(40), scope: 'REPO_ROOT' as const, reason: null },
    capturedAt: NOW, files: [
      { path: 'src/app.ts', repoPath: 'src/app.ts', size: 21, binary: false, symlink: false, oversize: false, sensitive: false,
        retained: false, rawHash: '1'.repeat(64), storedHash: null, vcs: ' M', readability: 'READABLE' as const },
      { path: 'link.txt', repoPath: 'link.txt', size: 0, binary: false, symlink: true, oversize: false, sensitive: false,
        retained: false, rawHash: null, storedHash: null, vcs: null, readability: 'SYMLINK' as const },
    ],
    coverage: { complete: false, observedFiles: 1, retainedFiles: 0, omittedByLimit: 0, omittedUnreadable: 0, skippedSymlinks: 1,
      skippedOversize: 0, binaryFiles: 0, sensitiveBodiesSkipped: 0, ignoredPaths: 0, evidenceRootExcluded: 0,
      reasons: ['SYMLINK_SKIPPED'], ignoredSamples: [] },
    candidateScope: { kind: 'VCS_CANDIDATES' as const, candidateCount: 2, pathspec: '.', evidencePrefix: null, evidenceRootExcluded: 0 },
    enumerationComplete: true,
    ignoredPathIdentities: [], ignoredPathsComplete: true,
  })
  const writeSnapshot = (snapshot: ReturnType<typeof symlinkObservation>): string => {
    const body = JSON.stringify({ ...snapshot, snapshotId: '' })
    const id = createHash('sha256').update(body).digest('hex')
    mkdirSync(join(f.evidenceRoot, 'snapshots'), { recursive: true })
    writeFileSync(join(f.evidenceRoot, 'snapshots', `${id}.json`), JSON.stringify({ ...snapshot, snapshotId: id }))
    return id
  }
  const pre = symlinkObservation('', 'PRE')
  const post = symlinkObservation('', 'POST')
  const preId = writeSnapshot(pre)
  const postId = writeSnapshot(post)
  const manifest = buildDeliveryChangeManifest({
    pre: { ...pre, snapshotId: preId }, post: { ...post, snapshotId: postId },
  })
  assert.equal(manifest.ok, true, manifest.ok ? '' : manifest.reason)
  if (!manifest.ok) return
  const link = manifest.manifest.entries.find(entry => entry.repoPath === 'link.txt')
  assert.ok(link, `the symlink observation is still reported (entries=${manifest.manifest.entries.map(e => e.repoPath).join(',')})`)
  assert.equal(link.status, 'UNKNOWN', 'two identical symlink observations are never MODIFIED')
  assert.equal(link.reasonCode, 'SYMLINK_CHANGE_UNPROVEN')
  assert.ok(link.labels.includes('SYMLINK_NOT_FOLLOWED'), link.labels.join(','))
  assert.equal(link.beforeHash, null)
  assert.equal(link.afterHash, null)
  assert.equal(manifest.manifest.coverage.complete, false)
  const selection = validateChangeSelection(undefined, manifest.manifest, [link.entryId], { taskId, attemptNo: 1 })
  assert.equal(selection.ok, false, 'an unproven symlink entry can never be confirmed')
  assert.equal(selection.code, 'CHANGE_ENTRY_UNPROVEN')
  // 同一份 manifest 里两侧摘要相同的普通文件**不会**成为条目：普通文件能证明未变化，
  // 符号链接不能——这正是本条反例的全部要点。
  assert.equal(manifest.manifest.entries.some(entry => entry.repoPath === 'src/app.ts'), false,
    'an unchanged readable file is proven unchanged and never becomes a confirmation candidate')
})

test('an unchanged symbolic link is never reported as a confirmable change', (t) => {
  const f = fixture(test)
  const taskId = 'task-unchanged-symlink'
  // 目标放在**仓库之外**：产品没有任何正当理由读取它，因此它的正文一旦出现在证据目录里，
  // 就只可能来自「跟随符号链接」。仓库内的已跟踪文件不能用作目标——快照会合法保存它的正文，
  // 断言便会与符号链接无关地失败（这正是本用例早先的缺陷：Windows 上因无法创建符号链接而
  // 长期 skip，Linux CI 才第一次执行并暴露）。
  const outsideTarget = join(f.root, 'outside-target.txt')
  writeFileSync(outsideTarget, `${CANARY}\n`)
  try {
    symlinkSync(outsideTarget, join(f.repo, 'link.txt'))
  } catch (error) {
    t.skip(`this host cannot create a symbolic link: ${(error as Error).message}`)
    return
  }
  // 两个时点观察到的链接内容完全相同（目标未动、链接未动）：仍然没有「链接自身」的
  // 可比较摘要，因此不能证明变化，也不能被主管确认。
  const { manifest } = runAttempt(f, taskId, {
    mutate: () => writeRepoFile(f.repo, 'src/app.ts', 'export const first = 1\nexport const second = 12\n'),
  })
  const link = manifest.entries.find(entry => entry.repoPath === 'link.txt')
  assert.ok(link, `the symbolic link is still reported as a bounded observation (entries=${manifest.entries.map(e => e.repoPath).join(',')})`)
  assert.equal(link.status, 'UNKNOWN', 'an unchanged symlink is never MODIFIED')
  assert.equal(link.reasonCode, 'SYMLINK_CHANGE_UNPROVEN')
  assert.ok(link.labels.includes('SYMLINK_NOT_FOLLOWED'), link.labels.join(','))
  assert.ok(link.labels.includes('CHANGE_NOT_PROVEN'), link.labels.join(','))
  assert.equal(manifest.coverage.complete, false, 'a symlink can never claim complete line coverage')
  assert.ok(manifest.coverage.reasons.includes('SYMLINK_NOT_FOLLOWED'), JSON.stringify(manifest.coverage.reasons))
  const selection = validateChangeSelection(undefined, manifest, [link.entryId], { taskId, attemptNo: 1 })
  assert.equal(selection.ok, false, 'a symlink entry can never be confirmed as a change')
  assert.equal(selection.code, 'CHANGE_ENTRY_UNPROVEN')
  // 对照：同一份 manifest 里真实的内容改动仍可被确认，证明拒绝不是来自整条通道关闭。
  const real = manifest.entries.find(entry => entry.repoPath === 'src/app.ts')!
  assert.equal(validateChangeSelection(undefined, manifest, [real.entryId], { taskId, attemptNo: 1 }).ok, true, 'an ordinary content change stays confirmable')
  // 符号链接正文（目标内容）也从未被复制进证据目录：仓库外目标只可能被「跟随」读到。
  assert.equal(readEvidenceBodies(f.evidenceRoot).includes(CANARY), false,
    'the symlink target body is never persisted as the link body')
})

// ── R5 缺陷 2：有意排除的 ignored 内容不构成候选枚举截断 ────────────────────

test('an ignored file is outside the candidate set rather than an enumeration truncation, so a real new file is still confirmable', () => {
  const f = fixture(test)
  const taskId = 'task-ignored-plus-new'
  writeRepoFile(f.repo, '.gitignore', 'private.txt\n')
  git(f.repo, ['add', '.gitignore'])
  git(f.repo, ['commit', '--quiet', '-m', 'ignore private content'])
  writeRepoFile(f.repo, 'private.txt', `${CANARY}\n`)
  const { manifest } = runAttempt(f, taskId, {
    mutate: () => {
      writeRepoFile(f.repo, 'new.txt', 'fresh ordinary file\n')
      writeRepoFile(f.repo, 'private.txt', `${CANARY}-CHANGED\n`)
    },
  })
  // 顶层覆盖必须如实记成部分：ignored 内容确实没有被观察。
  assert.equal(manifest.pre.coverage.ignoredPaths > 0, true, 'the ignored path is counted')
  assert.equal(manifest.pre.coverage.complete, false, 'excluding ignored content is never complete coverage')
  assert.ok(manifest.coverage.reasons.includes('IGNORED_CONTENT_EXCLUDED'), JSON.stringify(manifest.coverage.reasons))
  assert.equal(manifest.entries.some(entry => entry.repoPath.includes('private.txt')), false, 'ignored content never becomes a candidate')
  // 但候选枚举本身没有被截断：窗口内新建的普通文件必须仍可确认为 ADDED。
  assert.ok(manifest.coverage.reasons.includes('ENUMERATION_INCOMPLETE') === false,
    'an intentional ignore exclusion is not an enumeration truncation')
  const added = manifest.entries.find(entry => entry.repoPath === 'new.txt')
  assert.ok(added, `a real creation with ignored content present is still reported (entries=${manifest.entries.map(e => e.repoPath).join(',') || '<empty>'})`)
  assert.equal(added.status, 'ADDED', `the new file is proven created, not ${added.reasonCode}`)
  assert.equal(added.reasonCode, 'FILE_APPEARED_IN_WINDOW')
  const selection = validateChangeSelection(undefined, manifest, [added.entryId], { taskId, attemptNo: 1 })
  assert.equal(selection.ok, true, `the real creation stays confirmable (${selection.ok ? '' : selection.reason})`)
  // 有意排除仍不使证据声称完整。
  assert.equal(manifest.coverage.complete, false)
  assert.equal(readEvidenceBodies(f.evidenceRoot).includes(CANARY), false, 'ignored bodies are never persisted')
})

test('an in-workspace evidence root is an intentional exclusion and never blocks proving a real creation', () => {
  const f = fixture(test)
  const taskId = 'task-evidence-root-plus-new'
  const evidenceInsideWorkspace = join(f.repo, '.kingdom-evidence')
  const previous = process.env.DSH_KINGDOM_EVIDENCE_ROOT
  process.env.DSH_KINGDOM_EVIDENCE_ROOT = evidenceInsideWorkspace
  let manifest: DeliveryChangeManifest
  try {
    manifest = runAttempt(f, taskId, {
      mutate: () => writeRepoFile(f.repo, 'new.txt', 'fresh ordinary file\n'),
    }).manifest
  } finally {
    if (previous === undefined) delete process.env.DSH_KINGDOM_EVIDENCE_ROOT
    else process.env.DSH_KINGDOM_EVIDENCE_ROOT = previous
  }
  assert.ok(manifest.coverage.reasons.includes('EVIDENCE_ROOT_EXCLUDED'), JSON.stringify(manifest.coverage.reasons))
  assert.equal(manifest.entries.some(entry => entry.repoPath.startsWith('.kingdom-evidence')), false,
    'the evidence directory itself is never reported as a change')
  const added = manifest.entries.find(entry => entry.repoPath === 'new.txt')
  assert.ok(added, 'the real creation is reported')
  assert.equal(added.status, 'ADDED', 'excluding the evidence root does not make ordinary existence unprovable')
  const selection = validateChangeSelection(undefined, manifest, [added.entryId], { taskId, attemptNo: 1 })
  assert.equal(selection.ok, true, 'the real creation remains confirmable')
  assert.equal(manifest.coverage.complete, false, 'an intentional in-workspace exclusion still keeps coverage partial')
})

// ── R6 缺陷 1：忽略规则变化不得制造假新增/假删除 ─────────────────────────────

/**
 * 一次性 Git 正例：基线时 `secret.txt` 被 `.gitignore` 排除，窗口内只去掉这一条规则，
 * 文件内容一字未改。它离开候选集合只是因为规则变化，绝不能写成窗口内新增。
 * 同一窗口里真实新建的普通文件仍必须可确认；`always-ignored.txt` 两个时点都被排除，
 * 用来证明 ignored 正文从未被读取或落盘。
 */
test('removing an ignore rule never turns an unchanged ignored file into a confirmable addition', () => {
  const f = fixture(test)
  const taskId = 'task-ignore-rule-removed'
  writeRepoFile(f.repo, '.gitignore', 'always-ignored.txt\nsecret.txt\n')
  git(f.repo, ['add', '.gitignore'])
  git(f.repo, ['commit', '--quiet', '-m', 'ignore secret and canary'])
  writeRepoFile(f.repo, 'always-ignored.txt', `${CANARY}\n`)
  writeRepoFile(f.repo, 'secret.txt', 'unchanged ignored content\n')
  const { manifest } = runAttempt(f, taskId, {
    mutate: () => {
      // 窗口内只去掉 secret.txt 的忽略规则（内容不变），并真实新建一个无关普通文件。
      writeRepoFile(f.repo, '.gitignore', 'always-ignored.txt\n')
      writeRepoFile(f.repo, 'new.txt', 'fresh ordinary file\n')
    },
  })
  const stale = manifest.entries.find(entry => entry.repoPath === 'secret.txt')
  assert.ok(stale, `the previously ignored path is still reported as unproven (entries=${manifest.entries.map(e => e.repoPath).join(',') || '<empty>'})`)
  assert.equal(stale.status, 'UNKNOWN', 'an unchanged file that merely left the ignore set is never ADDED')
  assert.equal(stale.reasonCode, 'IGNORED_TRANSITION_UNPROVEN')
  assert.ok(stale.labels.includes('CHANGE_NOT_PROVEN'), stale.labels.join(','))
  const refused = validateChangeSelection(undefined, manifest, [stale.entryId], { taskId, attemptNo: 1 })
  assert.equal(refused.ok, false, 'the ignore-transition entry can never be confirmed as a change')
  assert.equal(refused.code, 'CHANGE_ENTRY_UNPROVEN')
  // 有 ignored 内容时，窗口中真实新增的无关普通文件仍必须可确认。
  const added = manifest.entries.find(entry => entry.repoPath === 'new.txt')
  assert.ok(added, 'the unrelated real creation is still reported')
  assert.equal(added.status, 'ADDED')
  assert.equal(validateChangeSelection(undefined, manifest, [added.entryId], { taskId, attemptNo: 1 }).ok, true,
    'an unrelated real creation stays confirmable while ignored content exists')
  // 两个时点都被忽略的正文从未被读取或写入证据目录。
  assert.equal(readEvidenceBodies(f.evidenceRoot).includes(CANARY), false, 'ignored bodies are never persisted')
  assert.equal(JSON.stringify(manifest).includes(CANARY), false, 'the manifest never carries ignored bodies')
})

/**
 * 一次性 Git 反例：基线时没有任何规则排除 `secret.txt`，窗口内只新增一条 `.gitignore`
 * 规则，文件内容一字未改。它进入被排除集合只是因为规则变化，绝不能写成窗口内删除。
 */
test('adding an ignore rule never turns an unchanged file into a confirmable deletion', () => {
  const f = fixture(test)
  const taskId = 'task-ignore-rule-added'
  writeRepoFile(f.repo, '.gitignore', 'always-ignored.txt\n')
  git(f.repo, ['add', '.gitignore'])
  git(f.repo, ['commit', '--quiet', '-m', 'ignore canary only'])
  writeRepoFile(f.repo, 'always-ignored.txt', `${CANARY}\n`)
  writeRepoFile(f.repo, 'secret.txt', 'unchanged visible content\n')
  const { manifest } = runAttempt(f, taskId, {
    mutate: () => {
      // 窗口内只新增 secret.txt 的忽略规则（内容不变），并真实新建一个无关普通文件。
      writeRepoFile(f.repo, '.gitignore', 'always-ignored.txt\nsecret.txt\n')
      writeRepoFile(f.repo, 'new.txt', 'fresh ordinary file\n')
    },
  })
  const stale = manifest.entries.find(entry => entry.repoPath === 'secret.txt')
  assert.ok(stale, `the newly ignored path is still reported as unproven (entries=${manifest.entries.map(e => e.repoPath).join(',') || '<empty>'})`)
  assert.equal(stale.status, 'UNKNOWN', 'an unchanged file that merely entered the ignore set is never DELETED')
  assert.equal(stale.reasonCode, 'IGNORED_TRANSITION_UNPROVEN')
  assert.equal(existsSync(join(f.repo, 'secret.txt')), true, 'the file really still exists on disk')
  const refused = validateChangeSelection(undefined, manifest, [stale.entryId], { taskId, attemptNo: 1 })
  assert.equal(refused.ok, false, 'the ignore-transition entry can never be confirmed as a deletion')
  assert.equal(refused.code, 'CHANGE_ENTRY_UNPROVEN')
  const added = manifest.entries.find(entry => entry.repoPath === 'new.txt')
  assert.ok(added, 'the unrelated real creation is still reported')
  assert.equal(added.status, 'ADDED')
  assert.equal(validateChangeSelection(undefined, manifest, [added.entryId], { taskId, attemptNo: 1 }).ok, true)
  assert.equal(readEvidenceBodies(f.evidenceRoot).includes(CANARY), false, 'ignored bodies are never persisted')
})

/**
 * 被 ignore 排除的路径身份无法完整确认（枚举被字节预算截断）时，不得默认「未忽略」：
 * 缺项必须 fail-closed 成不可确认，而不是写成窗口内新增。
 */
test('an ignore list that cannot be fully confirmed never defaults to not ignored', () => {
  const f = fixture(test)
  const taskId = 'task-ignore-scope-unconfirmed'
  writeRepoFile(f.repo, '.gitignore', 'always-ignored.txt\n')
  git(f.repo, ['add', '.gitignore'])
  git(f.repo, ['commit', '--quiet', '-m', 'ignore one path'])
  writeRepoFile(f.repo, 'always-ignored.txt', `${CANARY}\n`)
  // 只给 ignore 清单 1 字节预算：枚举必然截断，被排除的路径身份无法完整确认。
  const { manifest } = runAttempt(f, taskId, {
    bounds: { maxIgnoredBytes: 1 },
    mutate: () => writeRepoFile(f.repo, 'new.txt', 'fresh ordinary file\n'),
  })
  const pre = readWorkspaceSnapshot(undefined, manifest.pre.snapshotId)
  assert.ok(pre, 'the PRE snapshot is still readable with its canonical shape')
  assert.equal(pre.ignoredPathsComplete, false, 'a truncated ignore enumeration is never called complete')
  assert.ok(manifest.coverage.reasons.includes('IGNORED_SCOPE_UNCONFIRMED'), JSON.stringify(manifest.coverage.reasons))
  const added = manifest.entries.find(entry => entry.repoPath === 'new.txt')
  assert.ok(added, 'the window creation is still reported instead of being silently dropped')
  assert.notEqual(added.status, 'ADDED', 'an unconfirmed ignore list never proves a window creation')
  assert.equal(added.status, 'UNKNOWN')
  assert.equal(added.reasonCode, 'IGNORED_TRANSITION_UNPROVEN')
  const refused = validateChangeSelection(undefined, manifest, [added.entryId], { taskId, attemptNo: 1 })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'CHANGE_ENTRY_UNPROVEN')
})

/**
 * 子目录领地里，排除内容可能只由仓库根的 `.gitignore` 决定：此时同样必须枚举出被排除的
 * 路径身份，否则缺项会被默认成「未被忽略」，忽略规则一变就产生假新增/假删除。
 */
test('a repository-root ignore rule is still detected for a subdirectory territory', () => {
  const f = fixture(test)
  writeRepoFile(f.repo, '.gitignore', 'src/secret.txt\n')
  git(f.repo, ['add', '.gitignore'])
  git(f.repo, ['commit', '--quiet', '-m', 'ignore a subdirectory path from the repo root'])
  writeRepoFile(f.repo, 'src/secret.txt', `${CANARY}\n`)
  // 只留下仓库根规则：删掉 git init 自带的 exclude 文件，确保检测不依赖它。
  rmSync(join(f.repo, '.git', 'info', 'exclude'), { force: true })
  const snapshot = capturePreChangeSnapshot({
    workspacePath: join(f.repo, 'src'), taskId: 'task-subdir-ignore', attemptNo: 1, territoryId: f.territory.territory_id,
  })
  assert.ok(snapshot, 'the subdirectory PRE snapshot is captured')
  assert.equal(snapshot.coverage.ignoredPaths, 1, 'the repo-root rule really excluded one path')
  assert.equal(snapshot.ignoredPathsComplete, true)
  assert.deepEqual(snapshot.ignoredPathIdentities, ['secret.txt'], 'the excluded identity is workspace-relative')
  assert.ok(snapshot.coverage.reasons.includes('IGNORED_CONTENT_EXCLUDED'), JSON.stringify(snapshot.coverage.reasons))
  assert.equal(readEvidenceBodies(f.evidenceRoot).includes(CANARY), false, 'the excluded body is never read')
})

// ── R7 缺陷 1：工作区**内部**嵌套忽略规则同样不得制造假新增/假删除 ────────────

/**
 * 一次性 Git 正例：排除只由工作区**内部**更深层的 `src/.gitignore` 决定。fixture 保证
 * 该仓库**根级没有任何 `.gitignore`**：`git init` 自带的 `.git/info/exclude` 被删除，
 * 本地 `core.excludesFile` 指向不存在的临时路径，仓库到工作区之间没有中间层目录，因此
 * 「本仓库看起来有没有 ignore 规则」的旧预判在这里必然落空——旧实现会跳过被排除身份的
 * 枚举，从而把只改嵌套规则、内容一字未改的 `src/secret.txt` 写成可确认新增。
 * 窗口内只去掉那一层嵌套规则、`src/secret.txt` 内容一字未改，它仍然绝不能被写成窗口内
 * 新增。同一窗口里真实新建的普通文件必须仍可确认——证明拒绝不是来自整条通道关闭。
 * ignored 正文不落盘的 canary 断言由 R6 用例覆盖，此处不重复根级 fixture。
 */
test('a nested workspace ignore rule is enumerated, so removing it never turns an unchanged file into a confirmable addition', () => {
  const f = fixture(test)
  const taskId = 'task-nested-ignore-rule-removed'
  // 唯一 ignore 来源是工作区内部的嵌套规则：仓库根无 `.gitignore`，`git init` 自带的
  // exclude 文件被删除，`core.excludesFile` 指向不存在的临时路径。
  rmSync(join(f.repo, '.git', 'info', 'exclude'), { force: true })
  writeRepoFile(f.repo, 'src/.gitignore', 'secret.txt\n')
  writeRepoFile(f.repo, 'src/secret.txt', 'unchanged nested ignored content\n')
  const mustExist = (): void => {
    assert.equal(existsSync(join(f.repo, 'src', 'secret.txt')), true, 'the nested ignored file really still exists on disk')
  }
  const { manifest } = runAttempt(f, taskId, {
    mutate: () => {
      // 窗口内只删掉嵌套规则（内容不变），并真实新建一个无关普通文件。
      rmSync(join(f.repo, 'src', '.gitignore'), { force: true })
      writeRepoFile(f.repo, 'new.txt', 'fresh ordinary file\n')
    },
  })
  mustExist()
  const pre = readWorkspaceSnapshot(undefined, manifest.pre.snapshotId)
  assert.ok(pre, 'the PRE snapshot is readable with its canonical shape')
  assert.equal(pre.ignoredPathsComplete, true, 'the nested rule identity set is enumerated and complete')
  // 基线时唯一被排除的身份就是嵌套规则排除的那个文件（根级身份集合没有任何贡献）。
  assert.deepEqual(pre.ignoredPathIdentities, ['src/secret.txt'],
    `only the nested rule excluded anything (identities=${pre.ignoredPathIdentities.join(',') || '<empty>'})`)
  assert.equal(pre.coverage.ignoredPaths, 1, 'the nested rule really excluded exactly one path')
  const stale = manifest.entries.find(entry => entry.repoPath === 'src/secret.txt')
  assert.ok(stale, `the nested previously ignored path is still reported as unproven (entries=${manifest.entries.map(e => e.repoPath).join(',') || '<empty>'})`)
  assert.equal(stale.status, 'UNKNOWN', 'an unchanged file that merely left a nested ignore rule is never ADDED')
  assert.equal(stale.reasonCode, 'IGNORED_TRANSITION_UNPROVEN')
  const refused = validateChangeSelection(undefined, manifest, [stale.entryId], { taskId, attemptNo: 1 })
  assert.equal(refused.ok, false, 'the nested ignore-transition entry can never be confirmed as a change')
  assert.equal(refused.code, 'CHANGE_ENTRY_UNPROVEN')
  // 嵌套规则不影响无关真实新增的可确认性。
  const added = manifest.entries.find(entry => entry.repoPath === 'new.txt')
  assert.ok(added, 'the unrelated real creation is still reported')
  assert.equal(added.status, 'ADDED')
  assert.equal(added.reasonCode, 'FILE_APPEARED_IN_WINDOW')
  assert.equal(validateChangeSelection(undefined, manifest, [added.entryId], { taskId, attemptNo: 1 }).ok, true,
    'an unrelated real creation stays confirmable while a nested ignore rule exists')
})

/**
 * 一次性 Git 反例：基线时工作区内部没有嵌套规则，窗口内只新增 `src/.gitignore` 排除
 * `src/secret.txt`，文件内容一字未改。它进入被排除集合只是因为规则变化，绝不能写成删除。
 * 与正例相同的 fixture 前提：仓库根无 `.gitignore`、无 `.git/info/exclude`、
 * `core.excludesFile` 指向不存在的临时路径，旧预判在这里同样必然落空。
 */
test('a newly added nested workspace ignore rule never turns an unchanged file into a confirmable deletion', () => {
  const f = fixture(test)
  const taskId = 'task-nested-ignore-rule-added'
  rmSync(join(f.repo, '.git', 'info', 'exclude'), { force: true })
  writeRepoFile(f.repo, 'src/secret.txt', 'unchanged visible nested content\n')
  const { manifest } = runAttempt(f, taskId, {
    mutate: () => {
      // 窗口内只新增嵌套忽略规则（内容不变），并真实新建一个无关普通文件。
      writeRepoFile(f.repo, 'src/.gitignore', 'secret.txt\n')
      writeRepoFile(f.repo, 'new.txt', 'fresh ordinary file\n')
    },
  })
  assert.equal(existsSync(join(f.repo, 'src', 'secret.txt')), true, 'the file really still exists on disk')
  const post = readWorkspaceSnapshot(undefined, manifest.post.snapshotId)
  assert.ok(post, 'the POST snapshot is readable with its canonical shape')
  assert.deepEqual(post.ignoredPathIdentities, ['src/secret.txt'],
    `the newly added nested rule is the only exclusion source (identities=${post.ignoredPathIdentities.join(',') || '<empty>'})`)
  const stale = manifest.entries.find(entry => entry.repoPath === 'src/secret.txt')
  assert.ok(stale, `the newly nested-ignored path is still reported as unproven (entries=${manifest.entries.map(e => e.repoPath).join(',') || '<empty>'})`)
  assert.equal(stale.status, 'UNKNOWN', 'an unchanged file that merely entered a nested ignore rule is never DELETED')
  assert.equal(stale.reasonCode, 'IGNORED_TRANSITION_UNPROVEN')
  const refused = validateChangeSelection(undefined, manifest, [stale.entryId], { taskId, attemptNo: 1 })
  assert.equal(refused.ok, false, 'the nested ignore-transition entry can never be confirmed as a deletion')
  assert.equal(refused.code, 'CHANGE_ENTRY_UNPROVEN')
  const added = manifest.entries.find(entry => entry.repoPath === 'new.txt')
  assert.ok(added, 'the unrelated real creation is still reported')
  assert.equal(added.status, 'ADDED')
  assert.equal(validateChangeSelection(undefined, manifest, [added.entryId], { taskId, attemptNo: 1 }).ok, true)
})
