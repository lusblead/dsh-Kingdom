/**
 * 缺陷 4 定向测：默认产品入口下，显式改动选择必须走 session-bound。
 *
 * 默认配置是 `authMode=declarative`。改动证据要求「真实、当前、同领地 Supervisor
 * session」，因此显式选择入口（`kingdom_review_task` 带 change_* 字段）与
 * `kingdom_delivery_changes` 必须复用可信 ACTIVE Session → session-bound 上下文，
 * 而普通 ACCEPT 仍保持原有语义。
 *
 * 全流程只用临时 DSH_HOME、临时内存证据根与临时 Git 仓库；不接触正式 kingdom.db、
 * 正式 Territory、凭据或真实 DSH/Provider。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KingdomStore } from '../lib/core/db.js'
import {
  DELIVERY_CHANGE_SNAPSHOT_EVENT_TYPE,
  capturePostAndBuildChangeManifest,
  capturePreChangeSnapshot,
  changeSnapshotEventId,
  changeSnapshotEventPayload,
  type DeliveryChangeManifest,
} from '../lib/core/delivery-change.js'

const NOW = '2026-09-27T08:00:00.000Z'

function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kingdom-git-tool-'))
  const out = join(dir, 'out.txt')
  const err = join(dir, 'err.txt')
  const outFd = openSync(out, 'w')
  const errFd = openSync(err, 'w')
  let status = -1
  try {
    status = spawnSync('git', ['-C', cwd, ...args], { stdio: ['ignore', outFd, errFd], windowsHide: true }).status ?? -1
  } finally {
    closeSync(outFd); closeSync(errFd)
  }
  const stdout = readFileSync(out, 'utf8')
  rmSync(dir, { recursive: true, force: true })
  return { ok: status === 0, stdout }
}

interface ToolContext {
  tools: Map<string, { execute: (args: Record<string, unknown>, exec: unknown) => Promise<string> | string }>
  agents: Map<string, unknown>
  sessions: Map<string, unknown>
  testRoot: string
  setInitiator: (agent: unknown) => void
  teardown: () => void
}

/**
 * 启动真实插件（默认 authMode=declarative），并暴露工具注册表。
 * Session registry 是唯一可信身份 seam：只有注册表中 ACTIVE 的 session 才能升级。
 *
 * 不在这里删临时目录：SQLite 连接关闭前删除会 EPERM，因此由调用方在关库之后
 * 显式调用 `teardown()`。
 */
async function bootPlugin(): Promise<ToolContext> {
  const testRoot = mkdtempSync(join(tmpdir(), 'kingdom-tool-entry-'))
  const previousHome = process.env.DSH_HOME
  const previousEvidenceRoot = process.env.DSH_KINGDOM_EVIDENCE_ROOT
  process.env.DSH_HOME = testRoot
  process.env.DSH_KINGDOM_EVIDENCE_ROOT = join(testRoot, 'evidence')
  const tools = new Map<string, { execute: (args: Record<string, unknown>, exec: unknown) => Promise<string> | string }>()
  const agents = new Map<string, unknown>()
  const sessions = new Map<string, unknown>()
  let initiator: unknown = null
  const disposers: Array<() => void> = []
  const context = {
    commands: { register: () => () => undefined },
    tools: { register: (tool: { name: string }) => { tools.set(tool.name, tool as never); return () => tools.delete(tool.name) } },
    effect: (callback: () => unknown) => { const value = callback(); if (typeof value === 'function') disposers.push(value as () => void) },
    get: (name: string): unknown => ({
      agents: {
        get: (id: string) => agents.get(id),
        list: () => [...agents.values()],
        currentInitiator: () => initiator,
      },
      sessions: { get: (id: string) => sessions.get(id) },
    }[name]),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }
  const teardown = (): void => {
    for (const dispose of disposers.reverse()) dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousEvidenceRoot === undefined) delete process.env.DSH_KINGDOM_EVIDENCE_ROOT
    else process.env.DSH_KINGDOM_EVIDENCE_ROOT = previousEvidenceRoot
    rmSync(testRoot, { recursive: true, force: true })
  }
  const plugin = await import('../lib/index.js')
  plugin.apply(context as never, {
    kingdomName: 'unused defaults', ownerName: 'unused defaults', workerProvider: 'fixture',
    guiPort: 0, guiToken: '', guiAllowOrigins: ['*'], migrateV4: false,
  }, {})
  return { tools, agents, sessions, testRoot, setInitiator: (agent: unknown) => { initiator = agent }, teardown }
}

/** 用真实 Core 服务初始化王国、领地与主管/执行者绑定，再写入一个 REVIEW Task 与改动快照。 */
test('the default declarative configuration still requires a live session-bound supervisor for explicit change selection', async (t) => {
  const harness = await bootPlugin()
  const testRoot = harness.testRoot
  const repo = join(testRoot, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  assert.equal(git(repo, ['init', '--quiet']).ok, true)
  git(repo, ['config', 'user.email', 'test@example.invalid'])
  git(repo, ['config', 'user.name', 'Tool Entry Test'])
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const first = 1\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '--quiet', '-m', 'baseline'])

  const store = new KingdomStore(join(testRoot, 'kingdom', 'kingdom.db'))
  t.after(() => { store.close(); harness.teardown() })
  // `/kingdom init` 不在插件加载时自动执行：用同一临时 DB 上的显式初始化代替。
  const { initializeKingdomFacts } = await import('../lib/core/kingdom.js')
  const initialized = store.withImmediateTransaction(() => initializeKingdomFacts(store, '工具入口测试王国', '人类所有者'))
  const kingdomId = initialized.kingdomId
  assert.equal(store.getBindingByRole(kingdomId, 'OWNER') !== undefined, true, 'bootstrap created the Owner binding')

  // 用真实 Core 模块补齐角色与领地（插件内部 store 与本连接指向同一临时 DB 文件）。
  const { bindRole } = await import('../lib/core/binding.js')
  const { createTerritory, setTerritorySupervisor } = await import('../lib/core/territory.js')
  const { issueOwnerControlCapability, ownerControlAuth } = await import('../lib/core/owner-control.js')
  const capability = issueOwnerControlCapability()
  const ownerAuth = ownerControlAuth(capability)
  const liveSession = 'live-supervisor-session'
  bindRole(store, { kingdomId, roleType: 'SUPERVISOR', roleName: '主管', sessionId: liveSession }, ownerAuth)
  bindRole(store, { kingdomId, roleType: 'WORKER', roleName: '执行者' }, ownerAuth)
  const supervisor = store.getBindingByRole(kingdomId, 'SUPERVISOR')!
  const worker = store.getBindingByRole(kingdomId, 'WORKER')!
  createTerritory(store, { kingdomId, name: '主领地', workspacePath: repo }, ownerAuth)
  const territory = store.listTerritories(kingdomId)[0]!
  setTerritorySupervisor(store, { kingdomId, territoryId: territory.territory_id, supervisorBindingId: supervisor.binding_id }, ownerAuth)

  // 注册表里有一个 ACTIVE 的 DSH session（真实可信 seam：agent 必须是 currentInitiator）。
  const session = { id: liveSession, header: { cwd: repo } }
  const agent = { id: liveSession, session, status: 'running' }
  harness.agents.set(liveSession, agent)
  harness.sessions.set(liveSession, session)
  harness.setInitiator(agent)
  const toolExecution = (id: string) => ({ agent: id === liveSession ? agent : { session: { id } }, signal: { aborted: false } })

  const taskId = 'task-tool-entry'
  const attemptNo = 1
  const resultId = 'result-tool-entry'
  const pre = capturePreChangeSnapshot({ workspacePath: repo, taskId, attemptNo, territoryId: territory.territory_id })
  assert.ok(pre)
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const first = 1\nexport const second = 2\n')
  const manifest: DeliveryChangeManifest = capturePostAndBuildChangeManifest({
    workspacePath: repo, pre, taskId, attemptNo, territoryId: territory.territory_id,
  })!
  assert.ok(manifest)
  const entry = manifest.entries.find(candidate => candidate.path === 'src/app.ts')!

  // 在插件自己的连接上写入 Task/Claim/快照事件（同一临时 DB 文件）。
  store.insertTask({ task_id: taskId, territory_id: territory.territory_id, parent_task_id: null, title: '工具入口交付',
    description: null, assigned_binding_id: worker.binding_id, status: 'REVIEW', acceptance_criteria: '核验改动', result_summary: null,
    created_at: NOW, updated_at: NOW })
  store.insertWorkerResult({ result_id: resultId, task_id: taskId, attempt_no: attemptNo, worker_binding_id: worker.binding_id,
    session_id: 'private-session', outcome: 'COMPLETED',
    result_json: JSON.stringify({ outcome: 'COMPLETED', summary: '完成改动', artifacts: [], risks: [] }), created_at: NOW })
  store.appendEvent({ event_id: changeSnapshotEventId(kingdomId, taskId, attemptNo, null), kingdom_id: kingdomId,
    event_type: DELIVERY_CHANGE_SNAPSHOT_EVENT_TYPE, actor_role: 'SUPERVISOR', actor_id: supervisor.binding_id,
    target_type: 'task', target_id: taskId, payload_json: JSON.stringify(changeSnapshotEventPayload(manifest, resultId)), created_at: NOW })

  const review = harness.tools.get('kingdom_review_task')!
  const candidates = harness.tools.get('kingdom_delivery_changes')!
  assert.ok(review && candidates, 'both change-evidence tools are registered')

  // 1) 未注册（失活）session：显式选择与候选查看都必须零写入拒绝。
  const inactive = await review.execute(
    { task_id: taskId, decision: 'ACCEPT', change_evidence_id: manifest.evidenceId, change_entry_ids: [entry.entryId] },
    toolExecution('unknown-session'),
  )
  assert.match(inactive, /SUPERVISOR binding|session-bound/u, inactive)
  assert.equal(store.getTask(taskId)?.status, 'REVIEW')
  const inactiveCandidates = await candidates.execute({ task_id: taskId }, toolExecution('unknown-session'))
  assert.match(inactiveCandidates, /SUPERVISOR binding|session-bound/u, inactiveCandidates)
  assert.equal(store.listEvents(kingdomId, 400).some(event => event.event_type === 'TASK_ACCEPTED'), false)

  // 2) 默认配置（declarative）下的真实主管成功，且签名来自当前 ACTIVE session 的绑定。
  const accepted = await review.execute(
    { task_id: taskId, decision: 'ACCEPT', change_evidence_id: manifest.evidenceId, change_entry_ids: [entry.entryId] },
    toolExecution(liveSession),
  )
  assert.match(accepted, /DONE/u, accepted)
  assert.equal(store.getTask(taskId)?.status, 'DONE')
  const acceptEvent = store.listEvents(kingdomId, 400).find(event => event.event_type === 'TASK_ACCEPTED')!
  assert.equal(acceptEvent.actor_id, supervisor.binding_id)
  const payload = JSON.parse(acceptEvent.payload_json) as { delivery_change_evidence?: { entryIds?: string[] } }
  assert.deepEqual(payload.delivery_change_evidence?.entryIds, [entry.entryId])

  // 3) 候选查看：注册表里的 ACTIVE 主管可读；失活（registry 删除）后拒绝。
  const liveCandidates = await candidates.execute({ task_id: taskId }, toolExecution(liveSession))
  assert.match(liveCandidates, new RegExp(manifest.evidenceId), liveCandidates)
  harness.agents.delete(liveSession)
  const revoked = await candidates.execute({ task_id: taskId }, toolExecution('unknown-session'))
  assert.match(revoked, /SUPERVISOR binding|session-bound/u, revoked)
  // 恢复注册表，后续步骤仍在「真实 ACTIVE session」前提下验证。
  harness.agents.set(liveSession, agent)
  harness.sessions.set(liveSession, session)
  harness.setInitiator(agent)

  // 4) 普通 ACCEPT 仍保持旧语义：declarative 上下文即可，不需要 session 升级。
  //    （用一个新 Task 验证：REWORK 后再次进入 REVIEW。）
  const plainTask = 'task-tool-entry-plain'
  store.insertTask({ task_id: plainTask, territory_id: territory.territory_id, parent_task_id: null, title: '普通交付',
    description: null, assigned_binding_id: worker.binding_id, status: 'REVIEW', acceptance_criteria: '核验', result_summary: null,
    created_at: NOW, updated_at: NOW })
  store.insertWorkerResult({ result_id: 'result-plain', task_id: plainTask, attempt_no: 1, worker_binding_id: worker.binding_id,
    session_id: 'private-session', outcome: 'COMPLETED',
    result_json: JSON.stringify({ outcome: 'COMPLETED', summary: '完成', artifacts: [], risks: [] }), created_at: NOW })
  const plain = await review.execute({ task_id: plainTask, decision: 'ACCEPT' }, toolExecution('unknown-session'))
  assert.match(plain, /DONE/u, plain)
  const plainEvent = store.listEvents(kingdomId, 400).find(event => event.event_type === 'TASK_ACCEPTED' && event.target_id === plainTask)!
  const plainPayload = JSON.parse(plainEvent.payload_json) as Record<string, unknown>
  assert.equal(Object.hasOwn(plainPayload, 'delivery_change_evidence'), false, 'a plain ACCEPT binds no change evidence')

  // 5) 证据 drift 后，显式选择仍拒绝且不写第二条 TASK_ACCEPTED。
  unlinkSync(join(testRoot, 'evidence', 'manifests', `${manifest.evidenceId}.json`))
  const driftTask = 'task-tool-entry-drift'
  store.insertTask({ task_id: driftTask, territory_id: territory.territory_id, parent_task_id: null, title: '漂移交付',
    description: null, assigned_binding_id: worker.binding_id, status: 'REVIEW', acceptance_criteria: '核验', result_summary: null,
    created_at: NOW, updated_at: NOW })
  store.insertWorkerResult({ result_id: 'result-drift', task_id: driftTask, attempt_no: 1, worker_binding_id: worker.binding_id,
    session_id: 'private-session', outcome: 'COMPLETED',
    result_json: JSON.stringify({ outcome: 'COMPLETED', summary: '完成', artifacts: [], risks: [] }), created_at: NOW })
  store.appendEvent({ event_id: changeSnapshotEventId(kingdomId, driftTask, 1, null), kingdom_id: kingdomId,
    event_type: DELIVERY_CHANGE_SNAPSHOT_EVENT_TYPE, actor_role: 'SUPERVISOR', actor_id: supervisor.binding_id,
    target_type: 'task', target_id: driftTask, payload_json: JSON.stringify(changeSnapshotEventPayload(manifest, 'result-drift')), created_at: NOW })
  const drifted = await review.execute(
    { task_id: driftTask, decision: 'ACCEPT', change_evidence_id: manifest.evidenceId, change_entry_ids: [entry.entryId] },
    toolExecution(liveSession),
  )
  assert.match(drifted, /EVIDENCE_MISSING|不可信|缺失/u, drifted)
  assert.equal(store.getTask(driftTask)?.status, 'REVIEW')
  assert.equal(store.listEvents(kingdomId, 400).some(event => event.event_type === 'TASK_ACCEPTED' && event.target_id === driftTask), false)
})
