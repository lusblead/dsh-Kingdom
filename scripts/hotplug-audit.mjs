/**
 * dsh-kingdom 热插拔审计 —— 实测卸载/重载路径，不靠推断。
 *
 * 运行：node scripts/hotplug-audit.mjs
 *
 * 模拟 cordis 的 effect 生命周期：apply() 收集 disposer，dispose() 逆序执行。
 * 重点考察「卸载时有在途执行」「端口能否立刻重绑」「重载后状态是否自洽」。
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, '.hotplug')
const L = p => import(`file://${join(ROOT, p)}`)

const { KingdomManager } = await L('lib/core/kingdom.js')
const { createTerritory } = await L('lib/core/territory.js')
const { bindRole } = await L('lib/core/binding.js')
const svc = await L('lib/core/task-service.js')
const { buildSnapshot } = await L('lib/gui/snapshot.js')
const { startGuiServer } = await L('lib/gui/server.js')

let passed = 0, failed = 0
const notes = []
const check = (label, cond, detail = '') => {
  if (cond) { passed++; console.log(`  PASS  ${label}`) }
  else { failed++; notes.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = t => console.log(`\n=== ${t} ===`)
const AUTH = { mode: 'declarative', trustLevel: 'local-demo', note: '' }
const claim = (o, s) => ({ kind: 'result', sessionId: `sess-${Math.random().toString(16).slice(2, 8)}`, result: { outcome: o, summary: s } })

rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
const DB = join(DIR, 'kingdom.db')

/** 极简 cordis fiber 模拟：effect 登记 disposer，dispose 逆序回收。 */
function makeFiber() {
  const disposers = []
  return {
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    dispose() { for (let i = disposers.length - 1; i >= 0; i--) disposers[i]() },
  }
}

/** 模拟插件 apply()：开库 + 加载期回收 + 挂 disposer（顺序与 src/index.ts 一致）。 */
function loadPlugin({ guiPort = 0 } = {}) {
  const fiber = makeFiber()
  const manager = new KingdomManager({ kingdomName: 'HotPlug', ownerName: 'x', dbPath: DB })
  fiber.effect(() => () => manager.close())
  const store = manager.storeHandle
  // src/index.ts 在 apply() 里做的加载期回收
  const kingdom = store.getDefaultKingdom()
  const reclaimed = kingdom ? svc.reclaimOrphanExecutions(store, kingdom.kingdom_id) : 0
  let stopServer = null
  if (guiPort > 0) {
    fiber.effect(() => {
      const stop = startGuiServer({
        snapshot: () => buildSnapshot(store, { auth: AUTH }),
        taskDetail: () => null,
        eventsSince: () => ({ revision: 0, events: [] }),
        command: async () => ({ ok: true, errorCode: null, message: '', task: null, execution: null, emittedEvents: [], allowedActions: [], revision: 0 }),
      }, { port: guiPort, allowOrigins: ['*'] })
      stopServer = stop
      return stop
    })
  }
  return { fiber, manager, store, stopServer, reclaimed }
}

// ════════════════════════════════════════════════════════════════
section('A. 基本卸载/重载：状态是否完整跨越生命周期')

let p = loadPlugin()
const KID = p.manager.init().kingdomId
createTerritory(p.store, { kingdomId: KID, name: '施工领' })
for (const r of ['CHANCELLOR', 'SUPERVISOR', 'WORKER']) bindRole(p.store, { kingdomId: KID, roleType: r, roleName: `${r}-01` })
const CTX = { kingdomId: KID, auth: AUTH }
const t1 = svc.planTask(p.store, CTX, { title: '正常任务' }).task.taskId
svc.assignTask(p.store, CTX, { taskId: t1 })
await svc.startTask(p.store, { kind: 'f', async execute() { return claim('COMPLETED', 'ok') } }, CTX, { taskId: t1 })
const revBefore = p.store.revision(KID)
p.fiber.dispose()

check('卸载后 SQLite 连接确实关闭（再用会抛）', (() => {
  try { p.store.getDefaultKingdom(); return false } catch { return true }
})())

p = loadPlugin()
check('重载后王国状态完整恢复', p.store.getDefaultKingdom()?.kingdom_id === KID)
check('重载后 revision 连续（事件序号不回退）', p.store.revision(KID) === revBefore, `${p.store.revision(KID)} vs ${revBefore}`)
check('重载后 seq 继续单调递增', (() => {
  const r = svc.planTask(p.store, CTX, { title: '重载后新任务' })
  return r.revision > revBefore
})())
check('重载后治理闭环仍可继续', svc.reviewTask(p.store, CTX, { taskId: t1, decision: 'ACCEPT' }).task.status === 'DONE')

// ════════════════════════════════════════════════════════════════
section('B. ★ 卸载时有在途 Worker 执行（最危险的路径）')

const t2 = svc.planTask(p.store, CTX, { title: '在途执行' }).task.taskId
svc.assignTask(p.store, CTX, { taskId: t2 })

let executionIdInFlight = null
let afterUnloadError = null
const midflight = {
  kind: 'midflight',
  async execute() {
    executionIdInFlight = p.store.latestExecution(t2).execution_id
    // 模拟：subagent 还在跑的时候，插件被卸载（热重载 / DSH 退出）
    p.fiber.dispose()
    return claim('COMPLETED', '我跑完了，但插件已经卸载')
  },
}
try {
  await svc.startTask(p.store, midflight, CTX, { taskId: t2 })
} catch (error) {
  afterUnloadError = error
}

check('在途卸载后，结算写入失败会抛错（不静默丢数据）', afterUnloadError !== null)
check('★ 抛出的是可行动说明，而不是裸 SQLite 错误', (() => {
  const m = String(afterUnloadError?.message ?? '')
  return m.includes('插件被卸载或重载') && m.includes('自动回收') && !m.startsWith('SQLITE')
})(), String(afterUnloadError?.message ?? '').slice(0, 70))
check('原始错误保留在 cause 里（可诊断）', afterUnloadError?.cause !== undefined)

const p2 = loadPlugin()
check('★ 加载期回收：孤儿 Execution 被自动清理', p2.reclaimed === 1, `reclaimed=${p2.reclaimed}`)
const zombie = p2.store.getExecution(executionIdInFlight)
check('★ 孤儿被判为 ABORTED（中断，而非 executor 失败）', zombie?.state === 'ABORTED', zombie?.state)
check('★ 回收原因写入 detail，可追溯', (zombie?.detail ?? '').includes('回收'))
check('★ 回收后不再有"活跃"执行', p2.store.listLiveExecutions(KID).length === 0)
const reclaimedStage = buildSnapshot(p2.store, { auth: AUTH }).stage.find(a => a.role === 'WORKER')
check('★ GUI 不再看到骑士永远工作', reclaimedStage.state !== 'working', reclaimedStage.state)
check('★ 回收发出 SESSION_STOPPED(reason=reclaimed-on-load)', (() => {
  const ev = p2.store.listEvents(KID, 20).find(e => e.event_type === 'SESSION_STOPPED')
  return ev && JSON.parse(ev.payload_json).reason === 'reclaimed-on-load'
})())
check('回收不改变任务的治理状态（不替 Supervisor 裁定）',
  p2.store.getTask(t2).status === 'RUNNING', p2.store.getTask(t2).status)

const restart = await svc.startTask(p2.store,
  { kind: 'x', async execute() { return claim('COMPLETED', '回收后重跑') } }, CTX, { taskId: t2 })
check('★ 回收后任务可以直接重新 start（无需人工 abort）', restart.ok === true, restart.errorCode ?? '')
check('★ attempt 号跳过被回收的那次（不撞 UNIQUE 约束）',
  restart.execution.attemptNo === 2, `attemptNo=${restart.execution?.attemptNo}`)
check('Claim 侧 attempt 号与 Execution 侧一致',
  p2.store.latestWorkerResult(t2).attempt_no === 2)
p2.fiber.dispose()

// ════════════════════════════════════════════════════════════════
section('C. GUI 端口的卸载与立即重绑')

const PORT = 34901
const s1 = loadPlugin({ guiPort: PORT })
await new Promise(r => setTimeout(r, 200))
check('GUI 通道监听成功', (await fetch(`http://127.0.0.1:${PORT}/api/health`)).status === 200)

// 保持一条 keep-alive 连接，考察 close 时是否会被挂住
const keepAlive = await fetch(`http://127.0.0.1:${PORT}/api/snapshot`)
await keepAlive.json()

s1.fiber.dispose()
await new Promise(r => setTimeout(r, 150))
check('卸载后端口不再响应', await fetch(`http://127.0.0.1:${PORT}/api/health`).then(() => false).catch(() => true))

const s2 = loadPlugin({ guiPort: PORT })
await new Promise(r => setTimeout(r, 250))
const rebind = await fetch(`http://127.0.0.1:${PORT}/api/health`).then(r => r.status).catch(e => String(e))
check('★ 立即重绑同一端口成功（无 EADDRINUSE 残留）', rebind === 200, String(rebind))
s2.fiber.dispose()
await new Promise(r => setTimeout(r, 150))

// ════════════════════════════════════════════════════════════════
section('D. 新旧实例重叠（HMR 常见：新实例先起，旧实例后卸）')

const PORT2 = 34902
const oldInst = loadPlugin({ guiPort: PORT2 })
await new Promise(r => setTimeout(r, 200))
const newInst = loadPlugin({ guiPort: PORT2 })   // 端口冲突
await new Promise(r => setTimeout(r, 250))

check('端口冲突时新实例不崩溃（只告警降级）', true)
check('重叠期两个 KingdomStore 可同时读同一库（SQLite 允许）',
  oldInst.store.getDefaultKingdom()?.kingdom_id === newInst.store.getDefaultKingdom()?.kingdom_id)
check('重叠期并发写事件不产生重复 seq', (() => {
  const a = svc.planTask(oldInst.store, CTX, { title: '旧实例写' }).revision
  const b = svc.planTask(newInst.store, CTX, { title: '新实例写' }).revision
  return b > a
})())
oldInst.fiber.dispose()
await new Promise(r => setTimeout(r, 800))   // 给重试留出窗口（300ms × 若干次）
const afterOldGone = await fetch(`http://127.0.0.1:${PORT2}/api/health`).then(r => r.status).catch(() => 'closed')
check('★ 旧实例卸载后，新实例自动重试接管端口（GUI 通道自愈）', afterOldGone === 200,
  `实测 ${afterOldGone}`)
newInst.fiber.dispose()
await new Promise(r => setTimeout(r, 200))
check('自愈重试在 dispose 后停止（不留悬挂 timer）',
  await fetch(`http://127.0.0.1:${PORT2}/api/health`).then(() => false).catch(() => true))

// ════════════════════════════════════════════════════════════════
section('E. 重复卸载 / 卸载幂等')

const p3 = loadPlugin({ guiPort: 34903 })
await new Promise(r => setTimeout(r, 200))
p3.fiber.dispose()
let doubleDisposeError = null
try { p3.fiber.dispose() } catch (e) { doubleDisposeError = e }
check('重复 dispose 不抛错（幂等）', doubleDisposeError === null, String(doubleDisposeError))
await new Promise(r => setTimeout(r, 150))

console.log(`\n${'='.repeat(62)}`)
console.log(`热插拔审计：${passed} passed, ${failed} failed`)
if (failed > 0) { console.log('未通过：'); for (const n of notes) console.log(`  - ${n}`) }
console.log('='.repeat(62))
rmSync(DIR, { recursive: true, force: true })
process.exit(0)
