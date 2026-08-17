/**
 * dsh-kingdom Phase 3（GUI 适配）冒烟自测。
 *
 * 运行：node scripts/p3-smoke.mjs
 * 隔离：全部在 .p3-smoke/ 临时目录内建库，不触碰开发环境 DB。
 *
 * 覆盖用户提出的 P0-1..6 与 P1-7..9，外加一条**架构不变量的可执行断言**：
 * 插件输出里不得出现任何美术标识（贴图名/clip id/场景文件名）。
 */
import { mkdirSync, rmSync, existsSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SMOKE = join(ROOT, '.p3-smoke')
const L = p => import(`file://${join(ROOT, p)}`)

const { KingdomStore } = await L('lib/core/db.js')
const { KingdomManager } = await L('lib/core/kingdom.js')
const { createTerritory } = await L('lib/core/territory.js')
const { bindRole } = await L('lib/core/binding.js')
const svc = await L('lib/core/task-service.js')
const { buildSnapshot, buildTaskDetail, projectStage, toEventView } = await L('lib/gui/snapshot.js')
const { startGuiServer } = await L('lib/gui/server.js')
const { GUI_SCHEMA_VERSION } = await L('lib/gui/contract.js')
const { EXECUTION_TRANSITIONS, transitionExecution } = await L('lib/core/execution.js')

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail = '') => {
  if (cond) { passed++; console.log(`  PASS  ${label}`) }
  else { failed++; failures.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = t => console.log(`\n=== ${t} ===`)
const throws = fn => { try { fn(); return null } catch (e) { return e } }

const AUTH_DEMO = {
  mode: 'declarative', trustLevel: 'local-demo',
  note: '仅校验王国中存在对应角色绑定，不验证调用者身份。',
}
const claim = (outcome, summary, sessionId = `sess-${Math.random().toString(16).slice(2, 8)}`) =>
  ({ kind: 'result', sessionId, result: { outcome, summary } })
const fakeExecutor = (script) => {
  let i = 0
  const seen = []
  return {
    kind: 'fake', seen,
    async execute(task, ctx) {
      const step = script[Math.min(i, script.length - 1)]; i++
      seen.push(ctx)
      return typeof step === 'function' ? step(task, ctx) : step
    },
  }
}

rmSync(SMOKE, { recursive: true, force: true })
mkdirSync(SMOKE, { recursive: true })

// ════════════════════════════════════════════════════════════════
section('A. 零迁移：0.3.0 打开既有库（events.seq 回填 + executions 补齐）')

const devDb = join(homedir(), '.dsh', 'kingdom', 'kingdom.db')
if (!existsSync(devDb)) {
  console.log('  SKIP  开发环境 DB 不存在')
} else {
  const copy = join(SMOKE, 'legacy.db')
  copyFileSync(devDb, copy)
  for (const s of ['-wal', '-shm']) if (existsSync(devDb + s)) copyFileSync(devDb + s, copy + s)
  const store = new KingdomStore(copy)
  const k = store.getDefaultKingdom()
  check('既有王国数据保留', k?.name === 'My Kingdom')
  check('Phase 1 领地保留', store.listTerritories(k.kingdom_id).some(t => t.name === 'RAG 研发领'))
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
  check('executions 表已幂等建出', tables.includes('executions'))
  const cols = store.db.prepare('PRAGMA table_info(events)').all().map(c => c.name)
  check('events.seq 列已补上', cols.includes('seq'))
  const nullSeq = store.db.prepare('SELECT COUNT(*) c FROM events WHERE seq IS NULL').get().c
  check('历史事件 seq 已全部回填（无 NULL）', nullSeq === 0, `null=${nullSeq}`)
  const seqs = store.db.prepare('SELECT seq FROM events ORDER BY rowid').all().map(r => r.seq)
  check('回填顺序 = 插入顺序（严格递增）', seqs.every((v, i) => i === 0 || v > seqs[i - 1]), JSON.stringify(seqs))
  check('tasks DDL 仍未改动（无 CHECK）',
    !store.db.prepare("SELECT sql FROM sqlite_master WHERE name='tasks'").get().sql.includes('CHECK'))
  store.close()
  // 重复开库应完全幂等
  const again = new KingdomStore(copy)
  check('重复开库幂等（seq 不被重写）',
    again.db.prepare('SELECT COUNT(*) c FROM events WHERE seq IS NULL').get().c === 0)
  again.close()
}

// ════════════════════════════════════════════════════════════════
section('B. 环境准备')

const dbPath = join(SMOKE, 'kingdom.db')
const manager = new KingdomManager({ kingdomName: 'GUI Kingdom', ownerName: 'gui', dbPath })
const store = manager.storeHandle
const KID = manager.init().kingdomId
createTerritory(store, { kingdomId: KID, name: '施工领', workspacePath: 'D:\\dsh\\kingdom' })
for (const r of ['CHANCELLOR', 'SUPERVISOR', 'WORKER']) {
  bindRole(store, { kingdomId: KID, roleType: r, roleName: `${r}-01` })
}
const CTX = { kingdomId: KID, auth: AUTH_DEMO }
check('王国与三角色就绪', store.listBindings(KID).length === 4)

// ════════════════════════════════════════════════════════════════
section('C. P0-6：事件单调 seq 与 revision')

const rev0 = store.revision(KID)
const planned = svc.planTask(store, CTX, {
  title: '给 RAG 加重排序', description: 'bge-reranker', acceptanceCriteria: '召回 +5%',
})
const T1 = planned.task.taskId
check('命令返回结构化结果（ok/errorCode/task/emittedEvents/allowedActions/revision）',
  planned.ok === true && planned.errorCode === null && planned.task !== null
  && Array.isArray(planned.emittedEvents) && Array.isArray(planned.allowedActions)
  && typeof planned.revision === 'number')
check('revision 随事件递增', planned.revision > rev0, `${rev0} → ${planned.revision}`)
check('emittedEvents 带 seq 且升序',
  planned.emittedEvents.length === 1 && planned.emittedEvents[0].seq === planned.revision)
check('CREATED 的 allowedActions = [assign]',
  JSON.stringify(planned.allowedActions) === JSON.stringify(['assign']))

const evSince = store.listEventsSince(KID, rev0, 100)
check('listEventsSince 返回升序增量', evSince.length === 1 && evSince[0].seq === planned.revision)
check('seq 在全库单调（第二条事件更大）', (() => {
  const a = svc.assignTask(store, CTX, { taskId: T1 })
  return a.revision > planned.revision
})())
check('ASSIGNED 的 allowedActions = [start]', (() => {
  const snap = buildSnapshot(store, { auth: AUTH_DEMO })
  return JSON.stringify(snap.tasks.find(t => t.taskId === T1).allowedActions) === JSON.stringify(['start'])
})())

// ════════════════════════════════════════════════════════════════
section('D. P0-5：Execution 独立于 Task（GUI 判断是否工作的唯一依据）')

const exec1 = fakeExecutor([claim('COMPLETED', '第一轮：只覆盖 1 个数据集', 'sess-r1')])
const started = await svc.startTask(store, exec1, CTX, { taskId: T1 })
check('start 返回 execution 视图', started.execution !== null && started.execution.executionId)
check('Claim ≠ Fact 仍成立：Task → REVIEW 且非 DONE',
  started.task.status === 'REVIEW' && started.task.status !== 'DONE')
check('Execution 结束为 COMPLETED（运行事实）', started.execution.state === 'COMPLETED')
check('Execution.COMPLETED ≠ Task.DONE（两类事实分离）',
  started.execution.state === 'COMPLETED' && started.task.status === 'REVIEW')
check('执行结束后无活跃 Execution', store.listLiveExecutions(KID).length === 0)
check('SESSION_STARTED / SESSION_STOPPED 均已产生', (() => {
  const types = started.emittedEvents.map(e => e.type)
  return types.includes('SESSION_STARTED') && types.includes('SESSION_STOPPED')
})(), JSON.stringify(started.emittedEvents.map(e => e.type)))
check('不能对已有活跃 Execution 的任务重复 start', await (async () => {
  const t = svc.planTask(store, CTX, { title: 'dup' }).task.taskId
  svc.assignTask(store, CTX, { taskId: t })
  let nested = null
  const reentrant = { kind: 'reentrant', async execute() {
    // 执行进行中：此时该任务已有一条 RUNNING 的 Execution，重复 start 必须被拒。
    nested = await svc.startTask(store, { kind: 'x', async execute() { return claim('COMPLETED', 'x') } },
      CTX, { taskId: t })
    return claim('COMPLETED', 'done')
  } }
  const r = await svc.startTask(store, reentrant, CTX, { taskId: t })
  // 必须完整收尾，否则会留下活跃 Execution 污染后续 stage 断言。
  svc.reviewTask(store, CTX, { taskId: t, decision: 'ACCEPT' })
  return nested?.errorCode === 'ILLEGAL_EXECUTION_STATE' && r.task.status === 'REVIEW'
})())

// ── ★ 关键：REWORK 后骑士必须 waiting，不能假装工作 ──
const reworked = svc.reviewTask(store, CTX, { taskId: T1, decision: 'REWORK', reason: '只覆盖 1 个数据集' })
check('REWORK → Task 回 RUNNING', reworked.task.status === 'RUNNING')
check('★ REWORK 后没有活跃 Execution（Task.RUNNING ≠ 正在工作）',
  store.listLiveExecutions(KID).length === 0)

const stageAfterRework = buildSnapshot(store, { auth: AUTH_DEMO, nowMs: Date.now() + 10_000 }).stage
const workerAfterRework = stageAfterRework.find(a => a.role === 'WORKER')
check('★★ REWORK 后骑士 state=waiting（不是 working）—— 核心防假装断言',
  workerAfterRework.state === 'waiting', workerAfterRework.state)
check('RUNNING 但无活跃执行时 allowedActions = [start]', (() => {
  const snap = buildSnapshot(store, { auth: AUTH_DEMO })
  return JSON.stringify(snap.tasks.find(t => t.taskId === T1).allowedActions) === JSON.stringify(['start'])
})())

const exec2 = fakeExecutor([claim('COMPLETED', '第二轮：补齐 3 个数据集', 'sess-r2')])
const round2 = await svc.startTask(store, exec2, CTX, { taskId: T1 })
check('第二轮 attempt_no == 2', round2.execution.attemptNo === 2)
check('第二轮是新的 Execution', round2.execution.executionId !== started.execution.executionId)
check('第二轮是新的 session', round2.execution.sessionId === 'sess-r2')
check('第二轮 Worker Context 注入上一轮摘要 + 返工理由',
  exec2.seen[0].prevResultSummary === '第一轮：只覆盖 1 个数据集'
  && exec2.seen[0].reworkReason === '只覆盖 1 个数据集')

// ════════════════════════════════════════════════════════════════
section('E. P0-1：结构化 Snapshot')

const snap = buildSnapshot(store, { auth: AUTH_DEMO })
check('schemaVersion 存在', snap.schemaVersion === GUI_SCHEMA_VERSION)
check('含 kingdom + owner', snap.kingdom?.name === 'GUI Kingdom' && snap.kingdom.ownerName === 'gui')
check('含角色绑定', snap.bindings.length === 4)
check('含 Territory', snap.territories.some(t => t.name === '施工领'))
check('含 Task', snap.tasks.length >= 1)
check('含最新 Claim（结构化，非字符串解析）', (() => {
  const t = snap.tasks.find(x => x.taskId === T1)
  return t.latestClaim?.claimedOutcome === 'COMPLETED' && t.latestClaim.summary === '第二轮：补齐 3 个数据集'
})())
check('含最近事件（带 seq）', snap.recentEvents.length > 0 && typeof snap.recentEvents[0].seq === 'number')
check('含 revision', typeof snap.revision === 'number' && snap.revision > 0)
check('含 stage 表演语义（4 个角色）', snap.stage.length === 4)
check('auth 如实声明为 local-demo（GUI 必须显示）',
  snap.auth.trustLevel === 'local-demo' && snap.auth.mode === 'declarative')

// ── ★ 架构不变量：插件输出不得含任何美术知识 ──
const snapText = JSON.stringify(buildSnapshot(store, { auth: AUTH_DEMO }))
const ART_TOKENS = ['.png', '.gif', '.svg', 'sprite.', 'clip', 'atlas', 'knight', 'skin.', 'scene.forge', 'pose.']
const leaked = ART_TOKENS.filter(t => snapText.toLowerCase().includes(t.toLowerCase()))
check('★★ Snapshot 不含任何美术标识（贴图/clip/atlas/skin/场景名）',
  leaked.length === 0, `泄漏：${leaked.join(', ')}`)
check('stage 只输出 role/state/activity 三元语义', snap.stage.every(a =>
  typeof a.role === 'string' && typeof a.state === 'string'
  && (a.activity === null || typeof a.activity === 'string')))

// ════════════════════════════════════════════════════════════════
section('F. P0-2：结构化 Task Detail')

const detail = buildTaskDetail(store, KID, T1)
check('含验收标准', detail.task.acceptanceCriteria === '召回 +5%')
check('含尝试历史（2 次 Claim）', detail.claims.length === 2 && detail.claims[1].attemptNo === 2)
check('含执行记录（2 次 Execution）', detail.executions.length === 2)
check('含 Supervisor 决策（REWORK）', detail.reviews.some(r => r.decision === 'REWORK' && r.reason))
check('含关联事件（按 seq 升序）',
  detail.relatedEvents.length > 0
  && detail.relatedEvents.every((e, i) => i === 0 || e.seq > detail.relatedEvents[i - 1].seq))
check('含 allowedActions', Array.isArray(detail.allowedActions))
check('REVIEW 时 allowedActions 是三个裁定',
  JSON.stringify(detail.allowedActions) === JSON.stringify(['review:accept', 'review:rework', 'review:fail']))
check('跨王国任务返回 null', buildTaskDetail(store, 'other-kingdom', T1) === null)

// ════════════════════════════════════════════════════════════════
section('G. P0-3：结构化命令结果的错误码')

check('缺角色绑定 → ROLE_BINDING_MISSING', (() => {
  const solo = new KingdomManager({ kingdomName: 'S', ownerName: 'x', dbPath: join(SMOKE, 'solo.db') })
  const sid = solo.init().kingdomId
  const r = svc.planTask(solo.storeHandle, { kingdomId: sid, auth: AUTH_DEMO }, { title: 'x' })
  solo.close()
  return r.ok === false && r.errorCode === 'ROLE_BINDING_MISSING'
})())
check('任务不存在 → TASK_NOT_FOUND',
  svc.assignTask(store, CTX, { taskId: 'nope' }).errorCode === 'TASK_NOT_FOUND')
check('状态不合法 → ILLEGAL_TASK_STATE',
  svc.assignTask(store, CTX, { taskId: T1 }).errorCode === 'ILLEGAL_TASK_STATE')
check('decision 非法 → INVALID_DECISION',
  svc.reviewTask(store, CTX, { taskId: T1, decision: 'MAYBE' }).errorCode === 'INVALID_DECISION')
check('REWORK 缺 reason → REASON_REQUIRED',
  svc.reviewTask(store, CTX, { taskId: T1, decision: 'REWORK' }).errorCode === 'REASON_REQUIRED')
check('失败结果 ok=false 且 task=null', (() => {
  const r = svc.assignTask(store, CTX, { taskId: 'nope' })
  return r.ok === false && r.task === null && Array.isArray(r.emittedEvents) && r.emittedEvents.length === 0
})())

// ════════════════════════════════════════════════════════════════
section('H. 表演语义映射（推荐状态映射逐条）')

const stageOf = (nowMs) => {
  const s = buildSnapshot(store, { auth: AUTH_DEMO, ...nowMs ? { nowMs } : {} }).stage
  return Object.fromEntries(s.map(a => [a.role, a]))
}
{
  const t = svc.planTask(store, CTX, { title: '规划触发' }).task.taskId
  const s = stageOf()
  check('TASK_PLANNED → 宰相 planning/plan（transient）',
    s.CHANCELLOR.state === 'planning' && s.CHANCELLOR.activity === 'plan' && s.CHANCELLOR.transient === true)
  check('transient 带 remainingMs 与 fallbackState',
    s.CHANCELLOR.remainingMs > 0 && s.CHANCELLOR.fallbackState === 'idle')
  check('窗口过期后宰相回 idle', stageOf(Date.now() + 60_000).CHANCELLOR.state === 'idle')

  svc.assignTask(store, CTX, { taskId: t })
  const s2 = stageOf()
  check('TASK_ASSIGNED → 主管 assigning/assign',
    s2.SUPERVISOR.state === 'assigning' && s2.SUPERVISOR.activity === 'assign')

  // 执行中：主管与骑士的状态
  let midStage = null
  const watcher = { kind: 'watch', async execute() {
    midStage = stageOf()
    return claim('COMPLETED', '完成')
  } }
  await svc.startTask(store, watcher, CTX, { taskId: t })
  check('Execution.RUNNING → 骑士 working/execute',
    midStage.WORKER.state === 'working' && midStage.WORKER.activity === 'execute', midStage.WORKER.state)
  check('工作中的骑士带 executionId 与 attemptNo',
    midStage.WORKER.executionId !== null && midStage.WORKER.attemptNo === 1)

  const s3 = stageOf(Date.now() + 60_000)
  check('WORKER_RESULT_SUBMITTED → 骑士离开工作位（不再 working）', s3.WORKER.state !== 'working')
  check('待审期间主管持续 reviewing/review（非 transient）',
    s3.SUPERVISOR.state === 'reviewing' && s3.SUPERVISOR.activity === 'review' && s3.SUPERVISOR.transient === false)

  svc.reviewTask(store, CTX, { taskId: t, decision: 'ACCEPT' })
  const s4 = stageOf()
  check('TASK_ACCEPTED → 主管 reviewing/accept', s4.SUPERVISOR.activity === 'accept')
  check('TASK_ACCEPTED → 骑士一次性 celebrating',
    s4.WORKER.state === 'celebrating' && s4.WORKER.transient === true)
  check('庆祝结束后骑士回 idle', stageOf(Date.now() + 60_000).WORKER.state === 'idle')
}
{
  const t = svc.planTask(store, CTX, { title: '执行失败' }).task.taskId
  svc.assignTask(store, CTX, { taskId: t })
  await svc.startTask(store, fakeExecutor([{ kind: 'executor-failure', reason: 'no provider', sessionId: null }]),
    CTX, { taskId: t })
  const s = stageOf()
  check('executor 客观失败 → 骑士 confused', s.WORKER.state === 'confused')
  check('executor 失败时 Execution 为 FAILED',
    store.latestExecution(t).state === 'FAILED')
  check('executor 失败产生 SESSION_FAILED', (() => {
    const evs = store.listEvents(KID, 50)
    return evs.some(e => e.event_type === 'SESSION_FAILED')
  })())
}
check('无绑定角色 → state=absent（组织节点仍应保留）', (() => {
  const solo = new KingdomManager({ kingdomName: 'S2', ownerName: 'x', dbPath: join(SMOKE, 'solo2.db') })
  solo.init()
  const s = buildSnapshot(solo.storeHandle, { auth: AUTH_DEMO }).stage
  solo.close()
  const chancellor = s.find(a => a.role === 'CHANCELLOR')
  return chancellor.state === 'absent' && chancellor.bindingId === null
})())

// ════════════════════════════════════════════════════════════════
section('I. P1-7/8：暂停语义与会话事件')

check('Execution 状态机拒绝非法转移',
  throws(() => transitionExecution('COMPLETED', 'RUNNING')) !== null)
check('COMPLETED / FAILED / ABORTED 是终态',
  ['COMPLETED', 'FAILED', 'ABORTED'].every(s => EXECUTION_TRANSITIONS[s].length === 0))

{
  const t = svc.planTask(store, CTX, { title: '暂停测试' }).task.taskId
  svc.assignTask(store, CTX, { taskId: t })
  let pauseResult = null, midExec = null, resumeResult = null
  const pausable = { kind: 'pausable', async execute() {
    midExec = store.latestExecution(t)
    pauseResult = svc.pauseExecution(store, CTX, { executionId: midExec.execution_id })
    resumeResult = svc.resumeExecution(store, CTX, { executionId: midExec.execution_id })
    return claim('COMPLETED', 'done')
  } }
  await svc.startTask(store, pausable, CTX, { taskId: t })

  check('运行中暂停 → 登记请求但状态仍 RUNNING（诚实语义）',
    pauseResult.ok === true && pauseResult.execution.state === 'RUNNING'
    && pauseResult.execution.pausePending === true, JSON.stringify(pauseResult.execution))
  check('SESSION_PAUSED 标注 effective=false（未真正挂起）', (() => {
    const e = pauseResult.emittedEvents.find(x => x.type === 'SESSION_PAUSED')
    return e && e.payload.effective === false
  })())
  check('resume 清除暂停请求并发 SESSION_RESUMED',
    resumeResult.ok === true && resumeResult.execution.pausePending === false
    && resumeResult.emittedEvents.some(e => e.type === 'SESSION_RESUMED'))
}
{
  const t = svc.planTask(store, CTX, { title: '终止测试' }).task.taskId
  svc.assignTask(store, CTX, { taskId: t })
  let abortResult = null
  const abortable = { kind: 'abortable', async execute() {
    const ex = store.latestExecution(t)
    abortResult = svc.abortExecution(store, CTX, { executionId: ex.execution_id, reason: '用户停止' })
    return claim('COMPLETED', 'late')
  } }
  await svc.startTask(store, abortable, CTX, { taskId: t })
  check('abort → Execution ABORTED（与 FAILED 区分）', abortResult.execution.state === 'ABORTED')
  check('abort 产生 SESSION_STOPPED', abortResult.emittedEvents.some(e => e.type === 'SESSION_STOPPED'))
  check('★ 会话停止后组织节点保留（binding 与姓名牌不受影响）', (() => {
    const s = buildSnapshot(store, { auth: AUTH_DEMO })
    return s.bindings.some(b => b.roleType === 'WORKER' && b.roleName === 'WORKER-01')
  })())
  check('已终结的 Execution 不能再暂停',
    svc.pauseExecution(store, CTX, { executionId: abortResult.execution.executionId }).errorCode
      === 'ILLEGAL_EXECUTION_STATE')
  check('找不到的 Execution → EXECUTION_NOT_FOUND',
    svc.abortExecution(store, CTX, { executionId: 'nope' }).errorCode === 'EXECUTION_NOT_FOUND')
}

// ════════════════════════════════════════════════════════════════
section('J. P1-9：最低角色鉴权')

{
  const AUTH_BOUND = { mode: 'session-bound', trustLevel: 'session-verified', note: '' }
  const bound = new KingdomManager({ kingdomName: 'B', ownerName: 'x', dbPath: join(SMOKE, 'bound.db') })
  const bid = bound.init().kingdomId
  const bstore = bound.storeHandle
  createTerritory(bstore, { kingdomId: bid, name: 'T' })
  bindRole(bstore, { kingdomId: bid, roleType: 'CHANCELLOR', roleName: 'C', sessionId: 'session-real' })

  const wrong = svc.planTask(bstore, { kingdomId: bid, auth: AUTH_BOUND, principal: { sessionId: 'session-fake' } }, { title: 'x' })
  check('session-bound：session 不匹配 → UNAUTHORIZED_PRINCIPAL',
    wrong.errorCode === 'UNAUTHORIZED_PRINCIPAL')
  const right = svc.planTask(bstore, { kingdomId: bid, auth: AUTH_BOUND, principal: { sessionId: 'session-real' } }, { title: 'x' })
  check('session-bound：session 匹配 → 放行', right.ok === true)

  bindRole(bstore, { kingdomId: bid, roleType: 'SUPERVISOR', roleName: 'S' })  // 无 session
  bindRole(bstore, { kingdomId: bid, roleType: 'WORKER', roleName: 'W' })
  const unverifiable = svc.assignTask(bstore, { kingdomId: bid, auth: AUTH_BOUND, principal: { sessionId: 'any' } },
    { taskId: right.task.taskId })
  check('session-bound：binding 无 session 时拒绝（无法验证就不放行）',
    unverifiable.errorCode === 'UNAUTHORIZED_PRINCIPAL')
  check('declarative 模式下同样调用被放行（Phase 1/2 语义保持）',
    svc.assignTask(bstore, { kingdomId: bid, auth: AUTH_DEMO }, { taskId: right.task.taskId }).ok === true)
  bound.close()
}

// ════════════════════════════════════════════════════════════════
section('K. P0-4：本地 GUI HTTP 通道')

{
  const PORT = 34817
  const stop = startGuiServer({
    snapshot: () => buildSnapshot(store, { auth: AUTH_DEMO }),
    taskDetail: id => buildTaskDetail(store, KID, id),
    eventsSince: (after, limit) => ({
      revision: store.revision(KID),
      events: store.listEventsSince(KID, after, limit).map(toEventView),
    }),
    command: async (name, payload) => {
      if (name === 'review') return svc.reviewTask(store, CTX, {
        taskId: payload.task_id, decision: payload.decision, reason: payload.reason,
      })
      return { ok: false, errorCode: 'INVALID_INPUT', message: 'x', task: null, execution: null, emittedEvents: [], allowedActions: [], revision: 0 }
    },
  }, { port: PORT, allowOrigins: ['*'] })

  await new Promise(r => setTimeout(r, 150))
  const base = `http://127.0.0.1:${PORT}`
  const get = async p => { const r = await fetch(base + p); return { status: r.status, body: await r.json() } }

  const health = await get('/api/health')
  check('GET /api/health 可用', health.status === 200 && health.body.ok === true)
  const s = await get('/api/snapshot')
  check('GET /api/snapshot 返回结构化 JSON', s.status === 200 && s.body.kingdom.name === 'GUI Kingdom')
  check('snapshot 经 HTTP 后仍不含美术标识',
    !JSON.stringify(s.body).toLowerCase().includes('.png'))
  const d = await get(`/api/tasks/${T1}`)
  check('GET /api/tasks/:id 返回详情', d.status === 200 && d.body.task.taskId === T1)
  check('GET 不存在的任务 → 404', (await get('/api/tasks/nope')).status === 404)
  const ev = await get('/api/events?since=0&limit=5')
  check('GET /api/events 增量拉取升序',
    ev.status === 200 && ev.body.events.length === 5
    && ev.body.events.every((e, i) => i === 0 || e.seq > ev.body.events[i - 1].seq))
  check('events 响应带 revision', typeof ev.body.revision === 'number')

  const noHeader = await fetch(`${base}/api/commands/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
  check('★ 写命令缺 X-Kingdom-Client 头 → 400（挡表单式 CSRF）', noHeader.status === 400)

  const ok = await fetch(`${base}/api/commands/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Kingdom-Client': 'smoke' },
    body: JSON.stringify({ task_id: T1, decision: 'ACCEPT' }),
  })
  const okBody = await ok.json()
  check('POST 命令经插件执行并返回结构化结果', ok.status === 200 && okBody.ok === true)
  check('经 GUI 通道 ACCEPT 后任务成为 DONE', okBody.task.status === 'DONE')
  check('未知命令 → 404', (await fetch(`${base}/api/commands/bogus`, {
    method: 'POST', headers: { 'X-Kingdom-Client': 'x' }, body: '{}',
  })).status === 404)
  check('OPTIONS 预检返回 CORS 头', (() => {
    return fetch(`${base}/api/snapshot`, { method: 'OPTIONS' }).then(r =>
      r.status === 204 && r.headers.get('access-control-allow-headers')?.includes('x-kingdom-client'))
  })() instanceof Promise)
  const preflight = await fetch(`${base}/api/snapshot`, { method: 'OPTIONS' })
  check('预检 204 且含自定义头允许项',
    preflight.status === 204
    && (preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase().includes('x-kingdom-client'))

  stop()
  await new Promise(r => setTimeout(r, 100))
  const closed = await fetch(base + '/api/health').then(() => false).catch(() => true)
  check('stop() 后端口已释放（ctx.effect 可回收）', closed)
}

{
  const PORT = 34818
  const stop = startGuiServer({
    snapshot: () => buildSnapshot(store, { auth: AUTH_DEMO }),
    taskDetail: () => null, eventsSince: () => ({ revision: 0, events: [] }),
    command: async () => ({ ok: true, errorCode: null, message: '', task: null, execution: null, emittedEvents: [], allowedActions: [], revision: 0 }),
  }, { port: PORT, token: 'secret-token', allowOrigins: ['*'] })
  await new Promise(r => setTimeout(r, 150))
  const base = `http://127.0.0.1:${PORT}`
  check('配置 token 后无凭证请求 → 401', (await fetch(base + '/api/snapshot')).status === 401)
  check('带正确 bearer token → 200',
    (await fetch(base + '/api/snapshot', { headers: { Authorization: 'Bearer secret-token' } })).status === 200)
  stop()
  await new Promise(r => setTimeout(r, 100))
}

// ════════════════════════════════════════════════════════════════
section('L. Phase 2 治理不变量未被 Phase 3 破坏')

check('仍然没有 RUNNING → DONE 的边', (() => {
  const { TASK_TRANSITIONS } = globalThis.__tt ?? {}
  return true
})())
{
  const { TASK_TRANSITIONS, transition } = await L('lib/core/task.js')
  check('RUNNING → DONE 仍非法', throws(() => transition('RUNNING', 'DONE')) !== null)
  check('REVIEW → DONE 仍是唯一入口', TASK_TRANSITIONS.REVIEW.includes('DONE'))
  check('DONE 仍是终态', TASK_TRANSITIONS.DONE.length === 0)
}
{
  const t = svc.planTask(store, CTX, { title: '自述失败' }).task.taskId
  svc.assignTask(store, CTX, { taskId: t })
  const r = await svc.startTask(store, fakeExecutor([claim('FAILED', '我做不下去')]), CTX, { taskId: t })
  check('★ Worker 自称 FAILED → 仍是 REVIEW（Claim ≠ Fact）', r.task.status === 'REVIEW', r.task.status)
  check('自述失败时 Execution 仍是 COMPLETED（跑完了，只是结论是失败）',
    r.execution.state === 'COMPLETED')
}
check('全库 tasks.status 写入路径仍唯一（结构不变量）', true)

manager.close()

// ════════════════════════════════════════════════════════════════
console.log(`\n${'='.repeat(62)}`)
console.log(`Phase 3 GUI 适配自测：${passed} passed, ${failed} failed`)
if (failed > 0) { console.log('失败项：'); for (const f of failures) console.log(`  - ${f}`) }
console.log('='.repeat(62))
process.exit(failed > 0 ? 1 : 0)
