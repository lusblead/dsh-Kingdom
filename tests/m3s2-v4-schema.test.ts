/**
 * dsh-kingdom — M3-S2 Schema v4 验收测试（v0.8 / Owner 三次 Review APPROVED）。
 *
 * 覆盖（Owner v0.8 施工 Prompt §16）：
 * 1. Migration：v3 → v4（synthetic v3 库）、重复开库幂等、中途注入失败 ROLLBACK、
 *    行保留、legacy backfill、不伪造 Affinity/Lease/Decision/Dispatch、
 *    foreign_key_check / integrity_check / sqlite_master 精确对象；
 * 2. Gate：正式库保护——默认不开 v4（保持 v3，governed API fail-closed）；
 * 3. Direct SQL：移植 m3s2_v6_verify.py 全部 49 项 negative invariants 到生产 DDL
 *    （含 evidence 列 + swap 后表名 executions）。
 *
 * 全部在 :memory: 或临时文件库执行，零持久化，不碰正式 kingdom.db。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { KingdomStore, SCHEMA_SQL } from '../lib/core/db.js'
import { SchemaV4NotMigratedError, establishAffinity } from '../lib/core/governed.js'

const KID = 'k'
const NOW = 't0'

// ── synthetic v3 库构造（精确复刻 v2/v3 迁移后的形态）─────────────────────────

function buildSyntheticV3(dbPath: string, opts: { badExecutionState?: string } = {}): void {
  const db = new DatabaseSync(dbPath)
  db.exec(SCHEMA_SQL)
  // v2（M1-C 执行证据列）
  db.exec('ALTER TABLE role_bindings ADD COLUMN execution_profile_json TEXT')
  for (const c of ['executor_kind', 'provider', 'provider_source', 'requested_model', 'resolved_model', 'model_source', 'execution_profile_json']) {
    db.exec(`ALTER TABLE executions ADD COLUMN ${c} TEXT`)
  }
  // v3（M2 tombstone + task_assignments 已在 SCHEMA_SQL）
  db.exec('ALTER TABLE role_bindings ADD COLUMN status TEXT')
  db.exec('ALTER TABLE role_bindings ADD COLUMN retired_at TEXT')
  db.exec('ALTER TABLE role_bindings ADD COLUMN retired_reason TEXT')
  db.exec('ALTER TABLE territories ADD COLUMN deleted_at TEXT')
  db.exec('ALTER TABLE territories ADD COLUMN deleted_reason TEXT')
  db.exec(`UPDATE role_bindings SET status = 'ACTIVE' WHERE status IS NULL`)
  // events.seq
  db.exec('ALTER TABLE events ADD COLUMN seq INTEGER')
  db.exec('UPDATE events SET seq = rowid WHERE seq IS NULL')
  // 样本数据
  db.exec(`INSERT INTO kingdoms (kingdom_id, name, created_at, owner_id, owner_name, schema_version)
           VALUES ('${KID}', 'V3 王国', '${NOW}', 'o1', 'Tester', 3)`)
  db.exec(`INSERT INTO territories (territory_id, kingdom_id, name, workspace_path, summary, supervisor_binding_id, status, created_at)
           VALUES ('terr-A', '${KID}', '领地A', NULL, NULL, 'sup-1', 'ACTIVE', '${NOW}')`)
  db.exec(`INSERT INTO role_bindings (binding_id, kingdom_id, role_type, role_name, runtime_type, session_id,
           model_name, agent_name, session_meta, execution_profile_json, status, retired_at, retired_reason, principal_id, created_at, updated_at)
           VALUES
           ('sup-1', '${KID}', 'SUPERVISOR', 'Sup', 'dsh', NULL, NULL, NULL, NULL, NULL, 'ACTIVE', NULL, NULL, NULL, '${NOW}', '${NOW}'),
           ('w-1', '${KID}', 'WORKER', 'W', 'dsh', NULL, NULL, NULL, NULL, NULL, 'ACTIVE', NULL, NULL, NULL, '${NOW}', '${NOW}')`)
  db.exec(`INSERT INTO tasks (task_id, territory_id, parent_task_id, title, description, assigned_binding_id, status, acceptance_criteria, result_summary, created_at, updated_at)
           VALUES ('task-1', 'terr-A', NULL, 'T1', NULL, 'w-1', 'REVIEW', 'AC1', 'claim', '${NOW}', '${NOW}')`)
  const bad = opts.badExecutionState
  if (bad) {
    db.exec(`INSERT INTO executions (execution_id, task_id, attempt_no, worker_binding_id, session_id, state, detail, started_at, heartbeat_at, ended_at, pause_requested_at,
             executor_kind, provider, provider_source, requested_model, resolved_model, model_source, execution_profile_json)
             VALUES ('e-bad', 'task-1', 9, 'w-1', NULL, '${bad}', NULL, '${NOW}', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`)
  } else {
    db.exec(`INSERT INTO executions (execution_id, task_id, attempt_no, worker_binding_id, session_id, state, detail, started_at, heartbeat_at, ended_at, pause_requested_at,
             executor_kind, provider, provider_source, requested_model, resolved_model, model_source, execution_profile_json)
             VALUES
             ('e-1', 'task-1', 1, 'w-1', NULL, 'COMPLETED', 'done', '${NOW}', NULL, '${NOW}', NULL, 'dsh-subagent', 'spawn', 'binding', 'deepseek-v4-pro', 'deepseek-v4-pro', 'binding', '{"requested":{"provider":"spawn"}}'),
             ('e-2', 'task-1', 2, 'w-1', NULL, 'FAILED', NULL, '${NOW}', NULL, '${NOW}', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`)
  }
  db.exec(`INSERT INTO worker_results (result_id, task_id, attempt_no, worker_binding_id, session_id, outcome, result_json, created_at)
           VALUES ('r-1', 'task-1', 1, 'w-1', NULL, 'COMPLETED', '{"summary":"s"}', '${NOW}')`)
  db.exec(`INSERT INTO events (event_id, kingdom_id, event_type, actor_role, actor_id, target_type, target_id, payload_json, created_at)
           VALUES ('ev-1', '${KID}', 'TASK_CREATED', 'SUPERVISOR', 'sup-1', 'task', 'task-1', '{}', '${NOW}')`)
  db.exec(`INSERT INTO task_assignments (assignment_id, task_id, territory_id, worker_binding_id, assigned_by, assigned_at, ended_at, end_reason, previous_assignment_id, handoff_reason, created_at)
           VALUES ('as-1', 'task-1', 'terr-A', 'w-1', 'sup-1', '${NOW}', NULL, NULL, NULL, NULL, '${NOW}')`)
  db.close()
}

function v3TablesPresent(db: DatabaseSync): boolean {
  const names = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(r => r.name))
  return !names.has('execution_leases')
}

// ── 1. Gate：正式库保护 ──────────────────────────────────────────────────────

test('M3-S2 v4: Gate — 已有 v3 库默认不迁移（保持 v3，governed API fail-closed）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kingdom-v4-gate-'))
  const dbPath = join(dir, 'kingdom.db')
  try {
    buildSyntheticV3(dbPath)
    const store = new KingdomStore(dbPath) // 默认：不迁移
    assert.equal(store.schemaVersion, 3, '默认打开 v3 库必须保持 v3')
    assert.equal(store.isSchemaV4, false)
    assert.ok(v3TablesPresent(store.db), 'v4 表不得被创建')
    // legacy 功能仍可用
    const task = store.getTask('task-1')
    assert.equal(task?.title, 'T1')
    // governed API fail-closed
    assert.throws(() => {
      establishAffinity(store, {
        kingdomId: KID, workerBindingId: 'w-1',
        session: { runtimeType: 'dsh', runtimeInstanceRef: 'inst-1', sessionRef: 's-1' },
        territoryId: 'terr-A',
      })
    }, SchemaV4NotMigratedError)
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

// ── 2. Migration：v3 → v4 ────────────────────────────────────────────────────

test('M3-S2 v4: Migration — v3→v4 行保留 + LEGACY backfill + 不伪造历史 + 终验', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kingdom-v4-mig-'))
  const dbPath = join(dir, 'kingdom.db')
  try {
    buildSyntheticV3(dbPath)
    const store = new KingdomStore(dbPath, { allowSchemaV4: true })
    assert.equal(store.schemaVersion, 4)
    assert.equal(store.isSchemaV4, true)

    // 行保留 + LEGACY_COMPAT backfill
    const execs = store.listExecutions('task-1')
    assert.equal(execs.length, 2, 'executions 行数必须保留')
    for (const e of execs) {
      assert.equal(e.execution_contract, 'LEGACY_COMPAT', '旧 Execution 必须 backfill LEGACY_COMPAT')
      assert.equal(e.lease_id, null)
      assert.equal(e.capability_decision_id, null)
    }
    const e1 = execs.find(e => e.execution_id === 'e-1')!
    assert.equal(e1.state, 'COMPLETED')
    assert.equal(e1.provider, 'spawn', 'v2 证据列必须保留')
    assert.equal(e1.resolved_model, 'deepseek-v4-pro')
    assert.equal(e1.execution_profile_json, '{"requested":{"provider":"spawn"}}')

    // 不伪造治理历史（B-2/B-3/B-5：不反推 affinity、不伪造 lease/decision/dispatch）
    assert.equal(store.listAffinities(KID).length, 0)
    assert.equal(store.listLeases(KID).length, 0)
    assert.equal(store.listCapabilityDecisions(KID).length, 0)
    assert.equal(store.listDispatches(KID).length, 0)

    // legacy 功能完好
    assert.equal(store.getTask('task-1')?.status, 'REVIEW')
    assert.equal(store.latestWorkerResult('task-1')?.outcome, 'COMPLETED')
    assert.equal(store.getActiveAssignmentForTask('task-1')?.assignment_id, 'as-1')

    // 终验：fk / integrity / sqlite_master 精确对象
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), [], 'foreign_key_check 必须为空')
    const integrity = store.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    assert.equal(integrity.integrity_check, 'ok')
    const names = new Set((store.db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','index','trigger')`).all() as { name: string }[]).map(r => r.name))
    for (const required of [
      'session_territory_affinities', 'execution_leases', 'capability_decisions', 'dispatch_records', 'executions',
      'affinity_one_current_per_worker', 'lease_one_active_per_session', 'capability_decision_execution_uk', 'executions_task_idx',
      'affinity_identity_immutable', 'affinity_retire', 'affinity_no_delete',
      'lease_requires_matching_affinity', 'lease_identity_immutable', 'lease_plan_once', 'lease_decision_once',
      'lease_release_evidence_once', 'lease_state_guard', 'lease_insert_state_guard', 'lease_no_delete',
      'capability_decision_immutable', 'capability_decision_execution_bind', 'capability_decision_no_delete',
      'execution_governed_consistency', 'execution_contract_immutable',
      'dispatch_request_immutable', 'dispatch_requires_ready_lease', 'dispatch_state_guard', 'dispatch_insert_state_guard', 'dispatch_no_delete',
    ]) {
      assert.ok(names.has(required), `sqlite_master 缺对象: ${required}`)
    }
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('M3-S2 v4: Migration — 重复开库幂等', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kingdom-v4-idem-'))
  const dbPath = join(dir, 'kingdom.db')
  try {
    buildSyntheticV3(dbPath)
    const s1 = new KingdomStore(dbPath, { allowSchemaV4: true })
    assert.equal(s1.schemaVersion, 4)
    s1.close()
    const s2 = new KingdomStore(dbPath, { allowSchemaV4: true })
    assert.equal(s2.schemaVersion, 4, '重复开库不得重复迁移')
    assert.equal(s2.listExecutions('task-1').length, 2)
    assert.equal(s2.db.prepare('PRAGMA foreign_key_check').all().length, 0)
    s2.close()
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('M3-S2 v4: Migration — 中途注入失败必须整体 ROLLBACK（库保持 v3）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kingdom-v4-rollback-'))
  const dbPath = join(dir, 'kingdom.db')
  try {
    buildSyntheticV3(dbPath, { badExecutionState: 'BOGUS' }) // 非法 state 会让复制步骤违反新 CHECK
    assert.throws(() => new KingdomStore(dbPath, { allowSchemaV4: true }), /CHECK|constraint/i)
    // 回滚后：仍是完整 v3 语义
    const store = new KingdomStore(dbPath)
    assert.equal(store.schemaVersion, 3, '失败迁移必须回滚到 v3')
    assert.ok(v3TablesPresent(store.db), 'v4 对象不得残留')
    assert.equal(store.listExecutions('task-1').length, 1, '原 executions 表必须完好（含坏行）')
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('M3-S2 v4: Migration — 全新库自动 v4（含 executions v4 形态）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kingdom-v4-fresh-'))
  const dbPath = join(dir, 'kingdom.db')
  try {
    const store = new KingdomStore(dbPath) // 全新库默认即 v4
    assert.equal(store.schemaVersion, 4)
    assert.equal(store.isSchemaV4, true)
    const cols = new Set((store.db.prepare('PRAGMA table_info(executions)').all() as { name: string }[]).map(c => c.name))
    for (const c of ['execution_contract', 'lease_id', 'capability_decision_id', 'executor_kind', 'provider']) {
      assert.ok(cols.has(c), `全新库 executions 缺列 ${c}`)
    }
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

// ── 3. Direct SQL：v6 49 项 invariants（移植到生产 DDL）──────────────────────

/** 断言语句被拒且错误信息含任一 needle。 */
function expectReject(fn: () => void, needles: string | string[]): void {
  const list = typeof needles === 'string' ? [needles] : needles
  try {
    fn()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    assert.ok(list.some(n => msg.includes(n)), `被拒但原因不符: ${msg}（期望含 ${list.join(' / ')}）`)
    return
  }
  assert.fail(`期望被拒（含 ${list.join(' / ')}），但语句成功`)
}

function expectOk(fn: () => void): void {
  fn()
}

interface Ctx {
  wid: string
  iid: string
  sid: string
  territory: string
}

function makeCtx(store: KingdomStore, wid: string, iid: string, sid: string, territory = 'terr-A'): Ctx {
  store.db
    .prepare(`INSERT INTO session_territory_affinities
       (affinity_id, kingdom_id, worker_binding_id, runtime_type, runtime_instance_ref,
        session_ref, territory_id, established_at, is_current, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
    .run(`aff-${wid}-${sid}`, KID, wid, 'dsh', iid, sid, territory, NOW, NOW)
  return { wid, iid, sid, territory }
}

function leaseAcq(store: KingdomStore, ctx: Ctx, leaseId: string, task = 'task-1', attempt = 1, territory?: string): void {
  store.db
    .prepare(`INSERT INTO execution_leases (lease_id, kingdom_id, worker_binding_id, runtime_type,
       runtime_instance_ref, session_ref, territory_id, task_id, attempt_no, state, acquired_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACQUIRED', ?, ?)`)
    .run(leaseId, KID, ctx.wid, 'dsh', ctx.iid, ctx.sid, territory ?? ctx.territory, task, attempt, NOW, NOW)
}

function insertDecision(store: KingdomStore, decisionId: string, task: string, worker: string, decision: string, status: string, evidence: string | null, coverage = 'FULL'): void {
  store.db
    .prepare(`INSERT INTO capability_decisions (decision_id, kingdom_id, task_id, worker_binding_id,
       decision, enforcement_status, enforcement_evidence_json, requirement_coverage, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(decisionId, KID, task, worker, decision, status, evidence, coverage, NOW)
}

function leaseReady(store: KingdomStore, ctx: Ctx, leaseId: string, task = 'task-1', attempt = 1, territory?: string): string {
  leaseAcq(store, ctx, leaseId, task, attempt, territory)
  store.db.prepare(`UPDATE execution_leases SET enforcement_plan_snapshot='{"type":"plan/v1"}', state='PREPARING', updated_at='t1' WHERE lease_id=?`).run(leaseId)
  store.db.prepare(`UPDATE execution_leases SET state='MATERIALIZING', updated_at='t1' WHERE lease_id=?`).run(leaseId)
  const did = `d-${leaseId}`
  insertDecision(store, did, task, ctx.wid, 'GRANTED', 'ENFORCED', '{"type":"DshEnforcementEvidence/v1","payload":{}}')
  store.db.prepare(`UPDATE execution_leases SET capability_decision_id=?, state='DISPATCH_READY', updated_at='t1' WHERE lease_id=?`).run(did, leaseId)
  return did
}

function execGov(store: KingdomStore, execId: string, leaseId: string, decisionId: string, task = 'task-1', attempt = 1): void {
  store.db
    .prepare(`INSERT INTO executions (execution_id, task_id, attempt_no, worker_binding_id, state,
       started_at, execution_contract, lease_id, capability_decision_id)
       VALUES (?, ?, ?, ?, 'STARTING', ?, 'GOVERNED_PERSISTENT', ?, ?)`)
    .run(execId, task, attempt, 'w', NOW, leaseId, decisionId)
}

function dispatchIntended(store: KingdomStore, did: string, leaseId: string, execId: string, task = 'task-1', attempt = 1, iid = 'inst-1', sid = 's-A'): void {
  store.db
    .prepare(`INSERT INTO dispatch_records (dispatch_id, kingdom_id, lease_id, execution_id, task_id,
       attempt_no, runtime_type, runtime_instance_ref, session_ref, state,
       dispatch_request_snapshot, dispatch_input_ref_json, dispatch_payload_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'dsh', ?, ?, 'INTENDED', ?, ?, ?, ?, ?)`)
    .run(did, KID, leaseId, execId, task, attempt, iid, sid, '{"type":"req/v1"}', '{"ref":"in-1"}', 'h1', NOW, NOW)
}

test('M3-S2 v4: Direct SQL — v6 全部 49 项 invariants 移植（生产 DDL）', () => {
  const store = new KingdomStore(':memory:') // 全新库自动 v4 + FK 协议
  const insertTask = (taskId: string, territoryId: string): void => {
    store.insertTask({
      task_id: taskId, territory_id: territoryId, parent_task_id: null, title: `T-${taskId}`,
      description: null, assigned_binding_id: null, status: 'CREATED', acceptance_criteria: null,
      result_summary: null, created_at: NOW, updated_at: NOW,
    })
  }
  insertTask('task-1', 'terr-A')
  insertTask('task-2', 'terr-B')

  const w = makeCtx(store, 'w', 'inst-1', 's-A', 'terr-A')
  leaseReady(store, w, 'L1', 'task-1', 1)      // L1: DISPATCH_READY, d-L1
  execGov(store, 'e1', 'L1', 'd-L1', 'task-1', 1)
  dispatchIntended(store, 'd4', 'L1', 'e1', 'task-1', 1)

  // ══ 第一组：v5 20 项保留 ══
  expectReject(() => insertDecision(store, 'x1', 'task-1', 'w', 'GRANTED', 'UNAVAILABLE', null), 'CHECK')                       // A-1
  expectReject(() => insertDecision(store, 'x2', 'task-1', 'w', 'GRANTED', 'FAILED', null), 'CHECK')                            // A-2
  expectReject(() => insertDecision(store, 'x3', 'task-1', 'w', 'GRANTED', 'NOT_ATTEMPTED', null), 'CHECK')                    // A-3
  expectReject(() => insertDecision(store, 'x4', 'task-1', 'w', 'DENIED', 'ENFORCED', null), 'CHECK')                           // A-4
  expectOk(() => insertDecision(store, 'ok1', 'task-1', 'w', 'GRANTED', 'ENFORCED', '{"type":"e/v1"}'))                        // A-5
  expectOk(() => insertDecision(store, 'ok2', 'task-1', 'w', 'DENIED', 'NOT_ATTEMPTED', null, 'NONE'))                          // A-6
  expectReject(() => store.db.prepare(`UPDATE session_territory_affinities SET territory_id='terr-B' WHERE session_ref='s-A'`).run(), 'AFFINITY_IDENTITY_IMMUTABLE') // A-7
  expectReject(() => store.db.prepare(`UPDATE session_territory_affinities SET session_ref='s-C' WHERE session_ref='s-A'`).run(), 'AFFINITY_IDENTITY_IMMUTABLE') // A-8
  expectReject(() => store.db.prepare(`INSERT INTO session_territory_affinities (affinity_id,kingdom_id,worker_binding_id,runtime_type,runtime_instance_ref,session_ref,territory_id,established_at,is_current,created_at)
     VALUES ('aff-x','${KID}','w','dsh','inst-1','s-A','terr-A','t1',1,'t1')`).run(), 'UNIQUE') // A-9
  const w2 = makeCtx(store, 'w2', 'inst-1', 's-B', 'terr-A')
  expectReject(() => leaseAcq(store, w2, 'L2', 'task-1', 1), 'UNIQUE') // A-10 同 session 第二 active lease
  const w3 = makeCtx(store, 'w3', 'inst-2', 's-A', 'terr-A')
  expectOk(() => leaseAcq(store, w3, 'L3', 'task-1', 2)) // A-11 不同 instance 同 session_ref 允许
  expectReject(() => store.db.prepare(`UPDATE execution_leases SET state='RELEASED' WHERE lease_id='L3'`).run(), 'ILLEGAL_LEASE_TRANSITION') // A-12
  expectReject(() => dispatchIntended(store, 'd1', 'NO_SUCH', 'e1', 'task-1', 1), ['FOREIGN KEY', 'DISPATCH_REQUIRES_MATCHING_READY_LEASE']) // A-13
  // A-14 非 ready lease：走合法链到 RELEASED
  const w4 = makeCtx(store, 'w4', 'inst-1', 's-C', 'terr-A')
  leaseReady(store, w4, 'LR', 'task-1', 3)
  store.db.prepare(`UPDATE execution_leases SET state='RECOVERING' WHERE lease_id='LR'`).run()
  store.db.prepare(`UPDATE execution_leases SET state='RELEASED', released_at='t9', release_evidence_json='{"type":"rel/v1"}', release_reason='cleanup-ok' WHERE lease_id='LR'`).run()
  expectReject(() => dispatchIntended(store, 'd2', 'LR', 'e1', 'task-1', 1, 'inst-1', 's-C'), 'DISPATCH_REQUIRES_MATCHING_READY_LEASE') // A-14
  expectReject(() => dispatchIntended(store, 'd3', 'L1', 'e1', 'task-1', 1, 'inst-1', 's-C'), 'DISPATCH_REQUIRES_MATCHING_READY_LEASE') // A-15 session 不一致
  expectReject(() => store.db.prepare(`INSERT INTO executions (execution_id,task_id,attempt_no,state,started_at,execution_contract)
     VALUES ('e-gov-1','task-1',9,'STARTING','t','GOVERNED_PERSISTENT')`).run(), ['CHECK', 'EXECUTION_GOVERNED_REQUIRES_MATCHING_LEASE']) // A-16
  expectReject(() => store.db.prepare(`INSERT INTO executions (execution_id,task_id,attempt_no,state,started_at,execution_contract)
     VALUES ('e-1x','task-1',9,'STARTING','t','SOMETHING_ELSE')`).run(), 'CHECK') // A-17
  expectReject(() => store.db.prepare(`UPDATE capability_decisions SET decision='GRANTED', enforcement_status='ENFORCED' WHERE decision_id='ok2'`).run(), 'CAPABILITY_DECISION_IMMUTABLE') // A-18
  insertDecision(store, 'd-rebind', 'task-1', 'w', 'GRANTED', 'ENFORCED', '{"type":"e/v1"}')
  store.db.prepare(`UPDATE capability_decisions SET execution_id='e-X' WHERE decision_id='d-rebind'`).run()
  expectReject(() => store.db.prepare(`UPDATE capability_decisions SET execution_id='e-Y' WHERE decision_id='d-rebind'`).run(), 'CAPABILITY_DECISION_EXECUTION_ALREADY_BOUND') // A-19
  expectOk(() => {
    const row = store.db.prepare(`SELECT 1 FROM dispatch_records WHERE dispatch_id='d4' AND state='INTENDED'`).get()
    assert.ok(row, 'A-20 合法 dispatch 应存在')
  }) // A-20

  // ══ 第二组：Owner 扩展 29 项 ══
  const w5 = makeCtx(store, 'w5', 'inst-1', 's-D', 'terr-A')
  store.db.prepare(`UPDATE session_territory_affinities SET is_current=0, retired_at='t9' WHERE affinity_id='aff-w5-s-D'`).run()
  expectOk(() => undefined) // E-1a（成功退役）
  expectReject(() => store.db.prepare(`UPDATE session_territory_affinities SET is_current=1, retired_at=NULL WHERE affinity_id='aff-w5-s-D'`).run(), 'AFFINITY_RETIRE_ONLY_JOINT') // E-1b
  expectReject(() => store.db.prepare(`UPDATE session_territory_affinities SET is_current=0, retired_at='t10' WHERE affinity_id='aff-w5-s-D'`).run(), ['AFFINITY_ALREADY_RETIRED', 'AFFINITY_RETIRE_ONLY_JOINT']) // E-1c
  expectReject(() => store.db.prepare(`UPDATE session_territory_affinities SET retired_at='t9' WHERE affinity_id='aff-w-s-A'`).run(), 'AFFINITY_RETIRE_ONLY_JOINT') // E-1d
  expectReject(() => store.db.prepare(`INSERT INTO session_territory_affinities (affinity_id,kingdom_id,worker_binding_id,runtime_type,runtime_instance_ref,session_ref,territory_id,established_at,is_current,created_at)
     VALUES ('aff-w6','${KID}','w','dsh','inst-9','s-E','terr-A','t1',1,'t1')`).run(), 'UNIQUE') // E-2
  expectReject(() => store.db.prepare(`INSERT INTO execution_leases (lease_id,kingdom_id,worker_binding_id,runtime_type,runtime_instance_ref,session_ref,territory_id,task_id,attempt_no,state,acquired_at,updated_at)
     VALUES ('L5','${KID}','w','dsh','inst-1','s-NO-AFFINITY','terr-A','task-1',9,'ACQUIRED','t','t')`).run(), 'LEASE_REQUIRES_MATCHING_CURRENT_AFFINITY') // E-3
  expectReject(() => store.db.prepare(`INSERT INTO execution_leases (lease_id,kingdom_id,worker_binding_id,runtime_type,runtime_instance_ref,session_ref,territory_id,task_id,attempt_no,state,acquired_at,updated_at)
     VALUES ('L6','${KID}','w','dsh','inst-1','s-A','terr-B','task-1',9,'ACQUIRED','t','t')`).run(), 'LEASE_REQUIRES_MATCHING_CURRENT_AFFINITY') // E-4
  expectReject(() => store.db.prepare(`UPDATE execution_leases SET task_id='task-2' WHERE lease_id='L3'`).run(), 'LEASE_IDENTITY_IMMUTABLE') // E-5a
  expectReject(() => store.db.prepare(`UPDATE execution_leases SET worker_binding_id='w2' WHERE lease_id='L3'`).run(), 'LEASE_IDENTITY_IMMUTABLE') // E-5b
  expectReject(() => store.db.prepare(`UPDATE execution_leases SET enforcement_plan_snapshot='{"type":"plan/v2"}' WHERE lease_id='L1'`).run(), 'LEASE_PLAN_ALREADY_SET') // E-6a
  expectReject(() => store.db.prepare(`UPDATE execution_leases SET capability_decision_id='d-LR' WHERE lease_id='L1'`).run(), 'LEASE_DECISION_ALREADY_BOUND') // E-6b
  expectReject(() => insertDecision(store, 'x5', 'task-1', 'w', 'GRANTED', 'ENFORCED', null), 'CHECK') // E-7
  expectReject(() => store.db.prepare(`UPDATE capability_decisions SET kingdom_id='k2' WHERE decision_id='d-L1'`).run(), 'CAPABILITY_DECISION_IMMUTABLE') // E-8a
  expectReject(() => store.db.prepare(`UPDATE capability_decisions SET task_id='task-2' WHERE decision_id='d-L1'`).run(), 'CAPABILITY_DECISION_IMMUTABLE') // E-8b
  expectReject(() => store.db.prepare(`UPDATE capability_decisions SET execution_id='e-X' WHERE decision_id='ok2'`).run(), 'CAPABILITY_DECISION_BIND_REQUIRES_GRANTED') // E-9
  insertDecision(store, 'd-uniq1', 'task-1', 'w', 'GRANTED', 'ENFORCED', '{"type":"e/v1"}')
  insertDecision(store, 'd-uniq2', 'task-1', 'w', 'GRANTED', 'ENFORCED', '{"type":"e/v1"}')
  store.db.prepare(`UPDATE capability_decisions SET execution_id='e-uniq' WHERE decision_id='d-uniq1'`).run()
  expectReject(() => store.db.prepare(`UPDATE capability_decisions SET execution_id='e-uniq' WHERE decision_id='d-uniq2'`).run(), 'UNIQUE') // E-10
  expectReject(() => store.db.prepare(`INSERT INTO executions (execution_id,task_id,attempt_no,state,started_at,execution_contract,lease_id,capability_decision_id)
     VALUES ('e-g2','task-1',9,'STARTING','t','GOVERNED_PERSISTENT','NO_SUCH','d-L1')`).run(), ['FOREIGN KEY', 'EXECUTION_GOVERNED_REQUIRES_MATCHING_LEASE']) // E-11a
  expectReject(() => store.db.prepare(`INSERT INTO executions (execution_id,task_id,attempt_no,state,started_at,execution_contract,lease_id,capability_decision_id)
     VALUES ('e-g3','task-1',9,'STARTING','t','GOVERNED_PERSISTENT','L1','NO_SUCH')`).run(), ['FOREIGN KEY', 'EXECUTION_GOVERNED_REQUIRES_MATCHING_LEASE']) // E-11b
  expectReject(() => store.db.prepare(`INSERT INTO executions (execution_id,task_id,attempt_no,state,started_at,execution_contract,lease_id,capability_decision_id)
     VALUES ('e-g4','task-2',1,'STARTING','t','GOVERNED_PERSISTENT','L1','d-L1')`).run(), 'EXECUTION_GOVERNED_REQUIRES_MATCHING_LEASE') // E-12
  expectReject(() => dispatchIntended(store, 'd5', 'L1', 'NO_SUCH', 'task-1', 1), 'DISPATCH_REQUIRES_MATCHING_READY_LEASE') // E-13
  expectReject(() => dispatchIntended(store, 'd6', 'L1', 'e1', 'task-1', 1), 'UNIQUE') // E-14
  expectReject(() => store.db.prepare(`UPDATE dispatch_records SET dispatch_payload_hash='tampered' WHERE dispatch_id='d4'`).run(), 'DISPATCH_REQUEST_IMMUTABLE') // E-15
  store.db.prepare(`UPDATE dispatch_records SET state='DISPATCHED', runtime_dispatch_ref='r-1' WHERE dispatch_id='d4'`).run()
  expectReject(() => store.db.prepare(`UPDATE dispatch_records SET state='RECEIVED' WHERE dispatch_id='d4'`).run(), 'DISPATCH_RECEIVED_REQUIRES_REF_RECEIPT') // E-16
  store.db.prepare(`UPDATE dispatch_records SET state='RECEIVED', receipt_json='{"type":"receipt/v1"}', receipt_at='t2' WHERE dispatch_id='d4'`).run()
  store.db.prepare(`UPDATE dispatch_records SET state='CORRELATED', runtime_execution_ref='rx-1' WHERE dispatch_id='d4'`).run()
  expectReject(() => store.db.prepare(`UPDATE dispatch_records SET state='TERMINAL' WHERE dispatch_id='d4'`).run(), 'DISPATCH_TERMINAL_REQUIRES_EVIDENCE') // E-17
  const w6 = makeCtx(store, 'w6', 'inst-1', 's-F', 'terr-A')
  leaseReady(store, w6, 'LF', 'task-1', 5)
  store.db.prepare(`UPDATE execution_leases SET state='EXECUTING' WHERE lease_id='LF'`).run()
  store.db.prepare(`UPDATE execution_leases SET state='SETTLING' WHERE lease_id='LF'`).run()
  store.db.prepare(`UPDATE execution_leases SET state='RELEASING' WHERE lease_id='LF'`).run()
  expectReject(() => store.db.prepare(`UPDATE execution_leases SET state='RELEASED', released_at='t9' WHERE lease_id='LF'`).run(), 'LEASE_RELEASED_REQUIRES_EVIDENCE') // E-18
  expectReject(() => store.db.prepare(`INSERT INTO execution_leases (lease_id,kingdom_id,worker_binding_id,runtime_type,runtime_instance_ref,session_ref,territory_id,task_id,attempt_no,state,acquired_at,updated_at)
     VALUES ('LZ','${KID}','w6','dsh','inst-1','s-F','terr-A','task-1',6,'RELEASED','t','t')`).run(), 'LEASE_INSERT_MUST_BE_ACQUIRED') // E-19a
  expectReject(() => store.db.prepare(`INSERT INTO dispatch_records (dispatch_id,kingdom_id,lease_id,execution_id,task_id,attempt_no,runtime_type,runtime_instance_ref,session_ref,state,dispatch_request_snapshot,dispatch_input_ref_json,dispatch_payload_hash,created_at,updated_at)
     VALUES ('dz','${KID}','L1','e1','task-1',1,'dsh','inst-1','s-A','TERMINAL','{}','{}','h','t','t')`).run(), 'DISPATCH_INSERT_MUST_BE_INTENDED') // E-19b
  store.close()
})

test('M3-S2 v4: Direct SQL — FK 在新连接生效（F-3）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kingdom-v4-fk-'))
  const dbPath = join(dir, 'kingdom.db')
  try {
    const s1 = new KingdomStore(dbPath) // 全新库 v4
    s1.insertTask({ task_id: 'task-1', territory_id: 'terr-A', parent_task_id: null, title: 'T', description: null, assigned_binding_id: null, status: 'CREATED', acceptance_criteria: null, result_summary: null, created_at: NOW, updated_at: NOW })
    s1.close()
    const s2 = new KingdomStore(dbPath) // 新连接
    assert.equal(s2.isSchemaV4, true)
    // 无匹配 affinity 的 lease → 被拒（trigger + FK 协议生效）
    assert.throws(() => s2.db.prepare(`INSERT INTO execution_leases (lease_id,kingdom_id,worker_binding_id,runtime_type,runtime_instance_ref,session_ref,territory_id,task_id,attempt_no,state,acquired_at,updated_at)
       VALUES ('LX','${KID}','w','dsh','i','s','terr-A','task-1',1,'ACQUIRED','t','t')`).run(), /LEASE_REQUIRES_MATCHING_CURRENT_AFFINITY|FOREIGN KEY/)
    s2.close()
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('M3-S2 v4: Direct SQL — 完整 TX 序列（TX-0D..TX-5）达终态（E-21）', () => {
  const store = new KingdomStore(':memory:')
  store.insertTask({ task_id: 'tk', territory_id: 'terr-A', parent_task_id: null, title: 'T', description: null, assigned_binding_id: null, status: 'CREATED', acceptance_criteria: null, result_summary: null, created_at: NOW, updated_at: NOW })
  store.db.prepare(`INSERT INTO session_territory_affinities (affinity_id,kingdom_id,worker_binding_id,runtime_type,runtime_instance_ref,session_ref,territory_id,established_at,is_current,created_at)
     VALUES ('afx','${KID}','wx','dsh','ix','sx','terr-A','t0',1,'t0')`).run()
  // TX-0D：DENIED decision（无 lease/exec/dispatch）
  insertDecision(store, 'ddeny', 'tk', 'wx', 'DENIED', 'NOT_ATTEMPTED', null, 'NONE')
  // TX-A：acquire lease（I-11 闭环）
  store.db.prepare(`INSERT INTO execution_leases (lease_id,kingdom_id,worker_binding_id,runtime_type,runtime_instance_ref,session_ref,territory_id,task_id,attempt_no,state,acquired_at,updated_at)
     VALUES ('lx','${KID}','wx','dsh','ix','sx','terr-A','tk',1,'ACQUIRED','t0','t0')`).run()
  // TX-1：plan；ACQUIRED→PREPARING→MATERIALIZING
  store.db.prepare(`UPDATE execution_leases SET enforcement_plan_snapshot='{"type":"plan/v1"}', state='PREPARING' WHERE lease_id='lx'`).run()
  store.db.prepare(`UPDATE execution_leases SET state='MATERIALIZING' WHERE lease_id='lx'`).run()
  // TX-2S：GRANTED+ENFORCED + evidence；MATERIALIZING→DISPATCH_READY
  insertDecision(store, 'dg', 'tk', 'wx', 'GRANTED', 'ENFORCED', '{"type":"DshEnforcementEvidence/v1","payload":{}}')
  store.db.prepare(`UPDATE execution_leases SET capability_decision_id='dg', state='DISPATCH_READY' WHERE lease_id='lx'`).run()
  // TX-3：Execution + decision.execution_id 回填 + Dispatch INTENDED + DISPATCH_READY→EXECUTING
  execGov(store, 'ex', 'lx', 'dg', 'tk', 1)
  store.db.prepare(`UPDATE capability_decisions SET execution_id='ex' WHERE decision_id='dg'`).run()
  dispatchIntended(store, 'dx', 'lx', 'ex', 'tk', 1, 'ix', 'sx')
  store.db.prepare(`UPDATE execution_leases SET state='EXECUTING' WHERE lease_id='lx'`).run()
  // TX-3R：INTENDED→DISPATCHED→RECEIVED→CORRELATED
  store.db.prepare(`UPDATE dispatch_records SET state='DISPATCHED', runtime_dispatch_ref='rd-1' WHERE dispatch_id='dx'`).run()
  store.db.prepare(`UPDATE dispatch_records SET state='RECEIVED', receipt_json='{"type":"receipt/v1"}', receipt_at='t1' WHERE dispatch_id='dx'`).run()
  store.db.prepare(`UPDATE dispatch_records SET state='CORRELATED', runtime_execution_ref='re-1' WHERE dispatch_id='dx'`).run()
  // TX-4：terminal evidence；Dispatch→TERMINAL；Execution→terminal；Lease EXECUTING→SETTLING
  store.db.prepare(`UPDATE dispatch_records SET state='TERMINAL', terminal_evidence_json='{"type":"terminal/v1"}', terminal_at='t2' WHERE dispatch_id='dx'`).run()
  store.db.prepare(`UPDATE executions SET state='COMPLETED', ended_at='t2' WHERE execution_id='ex'`).run()
  store.db.prepare(`UPDATE execution_leases SET state='SETTLING' WHERE lease_id='lx'`).run()
  // TX-5：SETTLING→RELEASING→RELEASED + release evidence + released_at
  store.db.prepare(`UPDATE execution_leases SET state='RELEASING' WHERE lease_id='lx'`).run()
  store.db.prepare(`UPDATE execution_leases SET state='RELEASED', released_at='t3', release_evidence_json='{"type":"release/v1"}', release_reason='settled' WHERE lease_id='lx'`).run()
  // 终态断言
  assert.equal((store.db.prepare(`SELECT state FROM execution_leases WHERE lease_id='lx'`).get() as { state: string }).state, 'RELEASED')
  assert.equal((store.db.prepare(`SELECT state FROM dispatch_records WHERE dispatch_id='dx'`).get() as { state: string }).state, 'TERMINAL')
  assert.equal((store.db.prepare(`SELECT state FROM executions WHERE execution_id='ex'`).get() as { state: string }).state, 'COMPLETED')
  store.close()
})

test('M3-S2 v4: Direct SQL — 四 Ledger DELETE 全部拒绝（I-13）', () => {
  const store = new KingdomStore(':memory:')
  store.insertTask({ task_id: 'task-1', territory_id: 'terr-A', parent_task_id: null, title: 'T', description: null, assigned_binding_id: null, status: 'CREATED', acceptance_criteria: null, result_summary: null, created_at: NOW, updated_at: NOW })
  const ctx = makeCtx(store, 'w', 'inst-1', 's-A', 'terr-A')
  const did = leaseReady(store, ctx, 'L1', 'task-1', 1)
  execGov(store, 'e1', 'L1', did, 'task-1', 1)
  dispatchIntended(store, 'd1', 'L1', 'e1', 'task-1', 1)
  expectReject(() => store.db.prepare(`DELETE FROM session_territory_affinities WHERE affinity_id='aff-w-s-A'`).run(), 'AFFINITY_NO_DELETE')
  expectReject(() => store.db.prepare(`DELETE FROM execution_leases WHERE lease_id='L1'`).run(), 'LEASE_NO_DELETE')
  expectReject(() => store.db.prepare(`DELETE FROM capability_decisions WHERE decision_id='d-L1'`).run(), 'CAPABILITY_DECISION_NO_DELETE')
  expectReject(() => store.db.prepare(`DELETE FROM dispatch_records WHERE dispatch_id='d1'`).run(), 'DISPATCH_NO_DELETE')
  store.close()
})

test('M3-S2 v4: Direct SQL — tasks/kingdoms 增量列存在且可写', () => {
  const store = new KingdomStore(':memory:')
  store.insertKingdom({ kingdom_id: KID, name: 'K', created_at: NOW, owner_id: 'o1', owner_name: 'T' })
  store.insertTask({ task_id: 'task-1', territory_id: 'terr-A', parent_task_id: null, title: 'T', description: null, assigned_binding_id: null, status: 'CREATED', acceptance_criteria: null, result_summary: null, created_at: NOW, updated_at: NOW })
  store.setTaskCapabilityRequirement('task-1', '{"write":["terr-A"]}')
  store.setKingdomCapabilityCeiling(KID, '{"filesystem.write":true}')
  assert.equal(store.getTaskCapabilityRequirement('task-1'), '{"write":["terr-A"]}')
  assert.equal(store.getKingdomCapabilityCeiling(KID), '{"filesystem.write":true}')
  store.close()
})
