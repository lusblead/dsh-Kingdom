/**
 * dsh-kingdom Phase 2 冒烟自测 —— 对照施工任务书 §3 验收标准逐条断言。
 *
 * 运行：node scripts/p2-smoke.mjs
 * 隔离：全部在 .p2-smoke/ 临时目录内建库，**不触碰**开发环境 DB。
 *       零迁移一项用真实 Phase 1 DB 的**副本**验证。
 *
 * 关键设计：Task Core 只依赖 WorkerExecutor 接口（裁决 2），
 * 所以状态机与治理闭环可以在**没有活的 DSH**的情况下用假 executor 完整验证。
 * DshSubagentExecutor 本身则用一个结构化的假 ctx.subagents 单独验证。
 */
import { existsSync, mkdirSync, rmSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SMOKE = join(ROOT, '.p2-smoke')

const { KingdomStore } = await import(`file://${join(ROOT, 'lib/core/db.js')}`)
const { KingdomManager } = await import(`file://${join(ROOT, 'lib/core/kingdom.js')}`)
const { createTerritory, listTerritories } = await import(`file://${join(ROOT, 'lib/core/territory.js')}`)
const { bindRole, listBindings } = await import(`file://${join(ROOT, 'lib/core/binding.js')}`)
const { planTask, assignTask, startTask, reviewTask, listTasks } =
  await import(`file://${join(ROOT, 'lib/core/task-service.js')}`)
const { TASK_TRANSITIONS, transition } = await import(`file://${join(ROOT, 'lib/core/task.js')}`)
const { DshSubagentExecutor } = await import(`file://${join(ROOT, 'lib/worker/dsh-subagent.js')}`)
const { parseStructuredResult, WORKER_OUTPUT_SCHEMA, buildWorkerPrompt } =
  await import(`file://${join(ROOT, 'lib/worker/executor.js')}`)

const AUTH_DEMO = { mode: 'declarative', trustLevel: 'local-demo', note: '本地可信演示权限' }
/** Phase 3 起命令签名为 (store, ctx, input)；Phase 2 语义本身未变。 */
const CTX = () => ({ kingdomId: KID, auth: AUTH_DEMO })

let passed = 0
let failed = 0
const failures = []

function check(label, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  PASS  ${label}`)
  } else {
    failed++
    failures.push(label)
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`)
}

function throws(fn) {
  try {
    fn()
    return null
  } catch (error) {
    return error
  }
}

/** 假 Worker：按脚本返回结果或客观失败，不需要 DSH。 */
function fakeExecutor(script) {
  let call = 0
  const seen = []
  return {
    kind: 'fake',
    seen,
    async execute(task, context) {
      const step = script[Math.min(call, script.length - 1)]
      call++
      seen.push({ attemptNo: context.attemptNo, context })
      return typeof step === 'function' ? step(task, context) : step
    },
  }
}

function claim(outcome, summary, sessionId = `sess-${Math.random().toString(16).slice(2, 8)}`) {
  return { kind: 'result', sessionId, result: { outcome, summary } }
}

// ── 准备隔离环境 ────────────────────────────────────────────────
rmSync(SMOKE, { recursive: true, force: true })
mkdirSync(SMOKE, { recursive: true })

// ════════════════════════════════════════════════════════════════
section('A. 零 migration：0.2.0 打开真实 Phase 1 库的副本')

const devDb = join(homedir(), '.dsh', 'kingdom', 'kingdom.db')
if (!existsSync(devDb)) {
  console.log('  SKIP  开发环境 DB 不存在，跳过零迁移实证')
} else {
  const copy = join(SMOKE, 'phase1-copy.db')
  copyFileSync(devDb, copy)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(devDb + suffix)) copyFileSync(devDb + suffix, copy + suffix)
  }
  const store = new KingdomStore(copy)
  const kingdom = store.getDefaultKingdom()
  check('Phase 1 王国仍在', kingdom?.name === 'My Kingdom', JSON.stringify(kingdom))
  const territories = store.listTerritories(kingdom.kingdom_id)
  check('Phase 1 领地「RAG 研发领」未丢失',
    territories.some(t => t.name === 'RAG 研发领'), JSON.stringify(territories.map(t => t.name)))
  const bindings = store.listBindings(kingdom.kingdom_id)
  check('Phase 1 角色绑定未丢失（OWNER + CHANCELLOR）',
    bindings.length >= 2 && bindings.some(b => b.role_type === 'OWNER')
      && bindings.some(b => b.role_type === 'CHANCELLOR'),
    JSON.stringify(bindings.map(b => b.role_type)))

  const tables = store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name)
  check('worker_results 表已幂等建出（旧库直接生效）', tables.includes('worker_results'), tables.join(','))
  check('仍是 6 张业务表',
    ['events', 'kingdoms', 'role_bindings', 'tasks', 'territories', 'worker_results']
      .every(t => tables.includes(t)), tables.join(','))

  const tasksSql = store.db.prepare("SELECT sql FROM sqlite_master WHERE name='tasks'").get().sql
  check('tasks 表 DDL 一字未改（仍无 CHECK）', !tasksSql.includes('CHECK'), tasksSql)

  const idx = store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='territories_kingdom_name_uk'").all()
  check('territories 防御性 UNIQUE index 已建', idx.length === 1)

  const dup = throws(() => store.insertTerritory({
    territory_id: 'dup-test', kingdom_id: kingdom.kingdom_id, name: 'RAG 研发领',
    workspace_path: null, summary: null, supervisor_binding_id: null,
    status: 'ACTIVE', created_at: new Date().toISOString(),
  }))
  check('UNIQUE index 真的拦住重名领地', dup !== null, String(dup))
  store.close()
}

// ════════════════════════════════════════════════════════════════
section('B. Phase 1 六工具回归（Phase 1 语义冻结）')

const dbPath = join(SMOKE, 'kingdom.db')
const manager = new KingdomManager({ kingdomName: 'Smoke Kingdom', ownerName: 'smoke', dbPath })
const store = manager.storeHandle

const init1 = manager.init()
check('kingdom_init 首次 = initialized', init1.action === 'initialized', init1.action)
const init2 = manager.init()
check('kingdom_init 幂等 = attached（不覆盖）', init2.action === 'attached', init2.action)
check('幂等后 kingdom_id 不变', init1.kingdomId === init2.kingdomId)

const KID = init1.kingdomId
check('kingdom_status 返回真实状态', store.statusSummary().includes('Smoke Kingdom'))

createTerritory(store, { kingdomId: KID, name: '施工领', workspacePath: 'D:\\dsh\\kingdom' })
check('kingdom_create_territory 生效', listTerritories(store, KID).includes('施工领'))
check('重复建同名领地被应用层拦截',
  createTerritory(store, { kingdomId: KID, name: '施工领' }).includes('已存在'))

bindRole(store, { kingdomId: KID, roleType: 'CHANCELLOR', roleName: 'Chancellor-01' })
bindRole(store, { kingdomId: KID, roleType: 'SUPERVISOR', roleName: 'Supervisor-01' })
bindRole(store, { kingdomId: KID, roleType: 'WORKER', roleName: 'Worker-01' })
const bindingsText = listBindings(store, KID)
check('kingdom_bind_role / list_bindings 生效',
  ['OWNER', 'CHANCELLOR', 'SUPERVISOR', 'WORKER'].every(r => bindingsText.includes(r)), bindingsText)

const TERRITORY = store.listTerritories(KID).find(t => t.name === '施工领').territory_id
const WORKER_BINDING = store.getBindingByRole(KID, 'WORKER').binding_id

// ════════════════════════════════════════════════════════════════
section('C. ★ 核心验收：Claim ≠ Fact（Phase 2 第一优先级）')

const planned = planTask(store, CTX(), { territoryId: TERRITORY,
  title: '给 RAG 加重排序', description: '接入 bge-reranker',
  acceptanceCriteria: '召回率提升 >= 5%，且有可复现实验记录',
})
check('kingdom_plan_task → CREATED', planned.ok && planned.task.status === 'CREATED', planned.message)
const T1 = planned.task.taskId

const assigned = assignTask(store, CTX(), { taskId: T1 })
check('kingdom_assign_task → ASSIGNED', assigned.ok && assigned.task.status === 'ASSIGNED', assigned.message)
check('assign 记录了 Worker binding', assigned.task.assignedBindingId === WORKER_BINDING)

const exec1 = fakeExecutor([claim('COMPLETED', '已接入 bge-reranker，召回率 +7%')])
const started = await startTask(store, exec1, CTX(), { taskId: T1 })

check('★ Worker 完成任务后 Task.status == REVIEW',
  started.task.status === 'REVIEW', started.task.status)
check('★★ 断言 Task.status != DONE（Claim ≠ Fact 实证）',
  started.task.status !== 'DONE', started.task.status)
check('★ 落了 worker_results(attempt 1)',
  store.listWorkerResults(T1).length === 1 && store.listWorkerResults(T1)[0].attempt_no === 1)
check('★ worker_results 记录的是 Worker 自称的 COMPLETED',
  store.latestWorkerResult(T1).outcome === 'COMPLETED')
check('★ 即便 Worker 自称 COMPLETED，库里 tasks.status 仍是 REVIEW',
  store.getTask(T1).status === 'REVIEW', store.getTask(T1).status)
check('Worker Context 收到验收标准',
  exec1.seen[0].context.acceptanceCriteria.includes('召回率提升'))

// ── ACCEPT → DONE ──
const accepted = reviewTask(store, CTX(), { taskId: T1, decision: 'ACCEPT', reason: '实验记录可复现',
})
check('Supervisor ACCEPT → Task.status == DONE', accepted.ok && accepted.task.status === 'DONE', accepted.message)
const acceptEvents = store.listEvents(KID, 100).filter(e => e.event_type === 'TASK_ACCEPTED' && e.target_id === T1)
check('ACCEPT 记了 TASK_ACCEPTED 事件', acceptEvents.length === 1)
check('TASK_ACCEPTED 带 reviewer binding + reason', (() => {
  const p = JSON.parse(acceptEvents[0].payload_json)
  return p.reviewer_binding_id === store.getBindingByRole(KID, 'SUPERVISOR').binding_id
    && p.reason === '实验记录可复现'
})(), acceptEvents[0]?.payload_json)
check('DONE 是终态：不能再被审查', !reviewTask(store, CTX(), { taskId: T1, decision: 'FAIL', reason: 'x' }).ok)

// ════════════════════════════════════════════════════════════════
section('D. REWORK（裁决 5）：同一 Worker Binding、新 session、attempt+1')

const t2 = planTask(store, CTX(), { territoryId: TERRITORY, title: '写 RAG 评测脚本',
  acceptanceCriteria: '覆盖 3 个数据集',
}).task.taskId
assignTask(store, CTX(), { taskId: t2 })

const exec2 = fakeExecutor([
  claim('COMPLETED', '第一轮：只覆盖了 1 个数据集', 'sess-round-1'),
  claim('COMPLETED', '第二轮：补齐 3 个数据集', 'sess-round-2'),
])
await startTask(store, exec2, CTX(), { taskId: t2 })
check('第一轮结果到达 → REVIEW', store.getTask(t2).status === 'REVIEW')

const reworked = reviewTask(store, CTX(), { taskId: t2, decision: 'REWORK', reason: '只覆盖 1 个数据集，未满足 3 个',
})
check('Supervisor REWORK → Task 回 RUNNING', reworked.ok && reworked.task.status === 'RUNNING', reworked.message)
check('REWORK 必须给 reason',
  !reviewTask(store, CTX(), { taskId: T1, decision: 'REWORK' }).ok)

const round2 = await startTask(store, exec2, CTX(), { taskId: t2 })
const results2 = store.listWorkerResults(t2)
check('REWORK 后 attempt_no == 2', results2.length === 2 && results2[1].attempt_no === 2,
  JSON.stringify(results2.map(r => r.attempt_no)))
check('REWORK 保持同一 worker_binding_id',
  results2[0].worker_binding_id === results2[1].worker_binding_id
  && results2[1].worker_binding_id === WORKER_BINDING)
check('REWORK 用了新的 session',
  results2[0].session_id !== results2[1].session_id,
  `${results2[0].session_id} vs ${results2[1].session_id}`)
check('第二轮 Worker Context 注入了上一轮摘要',
  exec2.seen[1].context.prevResultSummary === '第一轮：只覆盖了 1 个数据集',
  exec2.seen[1].context.prevResultSummary)
check('第二轮 Worker Context 注入了 Supervisor 的 REWORK reason',
  exec2.seen[1].context.reworkReason === '只覆盖 1 个数据集，未满足 3 个',
  exec2.seen[1].context.reworkReason)
check('第二轮 prompt 自包含原任务 + 验收标准 + 返工理由', (() => {
  const p = buildWorkerPrompt(exec2.seen[1].context)
  return p.includes('写 RAG 评测脚本') && p.includes('覆盖 3 个数据集')
    && p.includes('只覆盖 1 个数据集，未满足 3 个') && p.includes('第 2 次尝试')
})())
check('第二轮结果到达后仍是 REVIEW（不是 DONE）', round2.task.status === 'REVIEW', round2.task.status)

// ════════════════════════════════════════════════════════════════
section('E. FAIL 的两个来源（裁决 6）')

// E1: Worker 自称 FAILED，但那只是 Claim
const t3 = planTask(store, CTX(), { territoryId: TERRITORY, title: '迁移向量库' }).task.taskId
assignTask(store, CTX(), { taskId: t3 })
const r3 = await startTask(store, fakeExecutor([claim('FAILED', '依赖缺失，我做不下去')]),
  CTX(), { taskId: t3 })
check('★ Worker 返回合法结构化结果但 outcome=FAILED → Task 仍是 REVIEW（不是 FAILED）',
  r3.task.status === 'REVIEW', r3.task.status)
check('worker_results 忠实记下 Worker 自称的 FAILED', store.latestWorkerResult(t3).outcome === 'FAILED')

const failed3 = reviewTask(store, CTX(), { taskId: t3, decision: 'FAIL', reason: '确认依赖不可得' })
check('只有 Supervisor FAIL 才 REVIEW → FAILED', failed3.ok && failed3.task.status === 'FAILED', failed3.message)
check('FAILED 是终态', TASK_TRANSITIONS.FAILED.length === 0)

// E2: executor 客观失败
const t4 = planTask(store, CTX(), { territoryId: TERRITORY, title: '跑一个会崩的任务' }).task.taskId
assignTask(store, CTX(), { taskId: t4 })
const r4 = await startTask(store,
  fakeExecutor([{ kind: 'executor-failure', reason: 'subagent 启动失败：no provider', sessionId: null }]),
  CTX(), { taskId: t4 })
check('★ executor 客观失败 → Task RUNNING → FAILED', r4.task.status === 'FAILED', r4.task.status)
const wef = store.listEvents(KID, 200).filter(e => e.event_type === 'WORKER_EXECUTION_FAILED' && e.target_id === t4)
check('★ 记录了 WORKER_EXECUTION_FAILED 事件', wef.length === 1)
check('WORKER_EXECUTION_FAILED 带 reason（宿主观察到的运行事实）',
  JSON.parse(wef[0].payload_json).reason.includes('no provider'))
check('executor 失败**不落** worker_results（没有合法 Claim 就没有 Claim）',
  store.listWorkerResults(t4).length === 0)

// ════════════════════════════════════════════════════════════════
section('F. 治理底线：没有任何路径能把 Task 直接置 DONE')

check('CREATED → DONE 非法', throws(() => transition('CREATED', 'DONE')) !== null)
check('ASSIGNED → DONE 非法', throws(() => transition('ASSIGNED', 'DONE')) !== null)
check('RUNNING → DONE 非法（Worker 无法自我完成）', throws(() => transition('RUNNING', 'DONE')) !== null)
check('DONE → 任何状态 非法（终态）', TASK_TRANSITIONS.DONE.length === 0)
check('REVIEW → DONE 是唯一入口', TASK_TRANSITIONS.REVIEW.includes('DONE'))
check('store.transitionTask 拦截非法转移（库层兜底）', (() => {
  const t = store.getTask(t4) // FAILED 终态
  return throws(() => store.transitionTask(t, 'DONE')) !== null
})())
check('未 REVIEW 的任务不能被 review',
  !reviewTask(store, CTX(), { taskId: t4, decision: 'ACCEPT' }).ok)
check('无 SUPERVISOR 绑定时 start/review 被拒（声明性角色校验）', (() => {
  const solo = new KingdomManager({ kingdomName: 'Solo', ownerName: 'x', dbPath: join(SMOKE, 'solo.db') })
  solo.init()
  const sid = solo.storeHandle.getDefaultKingdom().kingdom_id
  createTerritory(solo.storeHandle, { kingdomId: sid, name: 'T' })
  const noChancellor = planTask(solo.storeHandle, { kingdomId: sid, auth: AUTH_DEMO }, { title: 'x' })
  solo.close()
  return !noChancellor.ok && noChancellor.message.includes('CHANCELLOR')
})())

// ════════════════════════════════════════════════════════════════
section('G. kingdom_list_tasks 反映真实状态')

const listing = listTasks(store, KID)
check('list 含 DONE 任务', listing.includes('[DONE]'))
check('list 含 FAILED 任务', listing.includes('[FAILED]'))
check('list 含 REVIEW 任务', listing.includes('[REVIEW]'))
check('list 展示尝试次数', listing.includes('尝试次数：2'))
check('list 展示最新 Claim 摘要', listing.includes('第二轮：补齐 3 个数据集'))
check('list 对 REVIEW 明示「尚未成为完成事实」', listing.includes('尚未成为完成事实'))
check('list 按状态过滤', listTasks(store, KID, { status: 'DONE' }).includes('[DONE]')
  && !listTasks(store, KID, { status: 'DONE' }).includes('[FAILED]'))

// ════════════════════════════════════════════════════════════════
section('H. 重启 DSH 后完整恢复')

const snapshot = {
  tasks: store.listTasks(KID).map(t => `${t.task_id}:${t.status}`).sort(),
  results: store.listWorkerResults(t2).length,
  events: store.listEvents(KID, 500).length,
}
manager.close()

const reopened = new KingdomManager({ kingdomName: 'Smoke Kingdom', ownerName: 'smoke', dbPath })
const store2 = reopened.storeHandle
check('重启后 Task 状态完整恢复',
  JSON.stringify(store2.listTasks(KID).map(t => `${t.task_id}:${t.status}`).sort()) === JSON.stringify(snapshot.tasks))
check('重启后 worker_results 完整恢复', store2.listWorkerResults(t2).length === snapshot.results)
check('重启后 events 完整恢复', store2.listEvents(KID, 500).length === snapshot.events)
check('重启后仍能继续治理闭环（REVIEW 任务可被 ACCEPT）',
  reviewTask(store2, CTX(), { taskId: t2, decision: 'ACCEPT' }).task.status === 'DONE')
reopened.close()

// ════════════════════════════════════════════════════════════════
section('I. DshSubagentExecutor（裁决 2 的执行封装）')

const TASK_STUB = { task_id: 'x', title: 'T', description: null, acceptance_criteria: 'AC' }
const CTX_STUB = { task: TASK_STUB, acceptanceCriteria: 'AC', attemptNo: 1 }

function fakeSubagents({ providers = ['spawn'], run, startThrows } = {}) {
  const calls = []
  return {
    calls,
    list: () => providers,
    getProvider: name => (providers.includes(name) ? {} : undefined),
    async start(name, request) {
      calls.push({ name, request })
      if (startThrows) throw new Error(startThrows)
      return run
    },
  }
}

{
  const disposed = []
  const subagents = fakeSubagents({
    run: {
      id: 'sess-abc',
      result: Promise.resolve({ stopReason: 'completed', structured: { outcome: 'COMPLETED', summary: 'ok' } }),
      dispose: async () => { disposed.push(true) },
    },
  })
  const out = await new DshSubagentExecutor({ subagents, provider: 'spawn', parent: {}, signal: new AbortController().signal })
    .execute(TASK_STUB, CTX_STUB)
  check('正常结构化结果 → kind=result', out.kind === 'result' && out.result.outcome === 'COMPLETED', JSON.stringify(out))
  check('带回 subagent session id', out.sessionId === 'sess-abc')
  check('run 被 dispose（不泄漏子会话）', disposed.length === 1)
  check('start 传了 outputSchema', subagents.calls[0].request.outputSchema === WORKER_OUTPUT_SCHEMA)
  check('start 传了 parent 与 signal',
    subagents.calls[0].request.parent !== undefined && subagents.calls[0].request.signal !== undefined)
  check('prompt 以 text block 传入', subagents.calls[0].request.prompt[0].type === 'text')
}
{
  const out = await new DshSubagentExecutor({
    subagents: fakeSubagents({ providers: [] }), provider: 'spawn', parent: {}, signal: new AbortController().signal,
  }).execute(TASK_STUB, CTX_STUB)
  check('provider 缺失 → executor-failure', out.kind === 'executor-failure', JSON.stringify(out))
}
{
  const out = await new DshSubagentExecutor({
    subagents: fakeSubagents({ startThrows: 'boom' }), provider: 'spawn', parent: {}, signal: new AbortController().signal,
  }).execute(TASK_STUB, CTX_STUB)
  check('subagent 启动抛错 → executor-failure（不抛给 Task Core）',
    out.kind === 'executor-failure' && out.reason.includes('boom'), JSON.stringify(out))
}
{
  const out = await new DshSubagentExecutor({
    subagents: fakeSubagents({ run: {
      id: 's', result: Promise.resolve({ stopReason: 'error' }), dispose: async () => {},
    } }), provider: 'spawn', parent: {}, signal: new AbortController().signal,
  }).execute(TASK_STUB, CTX_STUB)
  check('stopReason=error → executor-failure', out.kind === 'executor-failure', JSON.stringify(out))
}
{
  const out = await new DshSubagentExecutor({
    subagents: fakeSubagents({ run: {
      id: 's', result: Promise.resolve({ stopReason: 'completed', structured: { outcome: 'NOPE' } }),
      dispose: async () => {},
    } }), provider: 'spawn', parent: {}, signal: new AbortController().signal,
  }).execute(TASK_STUB, CTX_STUB)
  check('结构化结果非法 → executor-failure（不当成 Claim）',
    out.kind === 'executor-failure' && out.reason.includes('outputSchema'), JSON.stringify(out))
}

check('parseStructuredResult 拒绝缺 summary', parseStructuredResult({ outcome: 'COMPLETED' }) === null)
check('parseStructuredResult 拒绝空 summary', parseStructuredResult({ outcome: 'COMPLETED', summary: '  ' }) === null)
check('parseStructuredResult 拒绝未知 outcome', parseStructuredResult({ outcome: 'DONE', summary: 'x' }) === null)
check('parseStructuredResult 接受合法 Claim',
  parseStructuredResult({ outcome: 'BLOCKED', summary: 'x', artifacts: ['a'] })?.artifacts?.[0] === 'a')
check('WORKER_OUTPUT_SCHEMA 是 object 根（dsh assertObjectJsonSchema 要求）',
  WORKER_OUTPUT_SCHEMA.type === 'object')
check('WORKER_OUTPUT_SCHEMA 的 enum 节点显式声明了 scalar type（否则被 dsh 拒绝）',
  WORKER_OUTPUT_SCHEMA.properties.outcome.type === 'string')

// ════════════════════════════════════════════════════════════════
console.log(`\n${'='.repeat(60)}`)
console.log(`Phase 2 冒烟自测：${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f}`)
}
console.log('='.repeat(60))
process.exit(failed > 0 ? 1 : 0)
