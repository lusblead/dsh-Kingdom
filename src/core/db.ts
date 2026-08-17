/**
 * dsh-kingdom — KingdomStore：node:sqlite 封装 + 6 表幂等建表。
 *
 * 治理纪律（Phase 1 轻量实现，基础设施后置）：
 * - 全部 CREATE TABLE IF NOT EXISTS，初始化幂等（重复 init = 接入，不覆盖）。
 * - 无 ORM / 无触发器 / 无 hash chain / 无 Command Bus（Phase 3+ 再上）。
 * - 权威状态只经本 Core 的公开方法写入；Agent 只能经 kingdom_* 工具进入。
 *
 * Phase 2 增量（零 migration，Owner 裁决 3/4）：
 * - 第 6 张表 worker_results（CREATE TABLE IF NOT EXISTS 幂等追加）。
 * - territories 防御性 UNIQUE index（CREATE UNIQUE INDEX IF NOT EXISTS，旧库直接生效）。
 * - tasks 表**一个字节都不改**：status 无 CHECK（2026-08-17 现场只读核对确认），
 *   状态机只在 Core 代码层（见 ./task.ts）。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { asTaskStatus, transition, type TaskStatus } from './task.js'
import {
  asExecutionState,
  isTerminalExecutionState,
  transitionExecution,
  type ExecutionState,
} from './execution.js'

/**
 * 记录在 kingdoms.schema_version 上的值。
 *
 * Phase 2 **刻意保持 1**：本插件没有任何按版本号分支的 migration 逻辑，
 * 建表全部幂等，任何 0.2.0 打开的旧库都会在开库瞬间收敛到同一套 6 表结构。
 * 此时把新库标成 2、旧库留在 1，只会制造一个「同结构不同版本号」的假差异。
 * 真正引入破坏性 migration 时再启用这个字段作为 gate。
 */
export const SCHEMA_VERSION = 1

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS kingdoms (
  kingdom_id   TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  owner_id     TEXT NOT NULL,
  owner_name   TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS territories (
  territory_id  TEXT PRIMARY KEY,
  kingdom_id    TEXT NOT NULL,
  name          TEXT NOT NULL,
  workspace_path TEXT,
  summary       TEXT,
  supervisor_binding_id TEXT,
  status        TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_bindings (
  binding_id   TEXT PRIMARY KEY,
  kingdom_id   TEXT NOT NULL,
  role_type    TEXT NOT NULL CHECK(role_type IN ('OWNER','CHANCELLOR','SUPERVISOR','WORKER')),
  role_name    TEXT NOT NULL,
  runtime_type TEXT NOT NULL DEFAULT 'dsh',
  session_id   TEXT,
  principal_id TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id         TEXT PRIMARY KEY,
  territory_id    TEXT NOT NULL,
  parent_task_id  TEXT,
  title           TEXT NOT NULL,
  description     TEXT,
  assigned_binding_id TEXT,
  status          TEXT NOT NULL DEFAULT 'CREATED',
  acceptance_criteria TEXT,
  result_summary  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  event_id    TEXT PRIMARY KEY,
  kingdom_id  TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  actor_role  TEXT,
  actor_id    TEXT,
  target_type TEXT,
  target_id   TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_results (
  result_id          TEXT PRIMARY KEY,
  task_id            TEXT NOT NULL,
  attempt_no         INTEGER NOT NULL,
  worker_binding_id  TEXT,
  session_id         TEXT,
  outcome            TEXT NOT NULL,
  result_json        TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL,
  UNIQUE(task_id, attempt_no)
);

CREATE UNIQUE INDEX IF NOT EXISTS territories_kingdom_name_uk
  ON territories(kingdom_id, name);

CREATE TABLE IF NOT EXISTS executions (
  execution_id       TEXT PRIMARY KEY,
  task_id            TEXT NOT NULL,
  attempt_no         INTEGER NOT NULL,
  worker_binding_id  TEXT,
  session_id         TEXT,
  state              TEXT NOT NULL,
  detail             TEXT,
  started_at         TEXT NOT NULL,
  heartbeat_at       TEXT,
  ended_at           TEXT,
  pause_requested_at TEXT,
  UNIQUE(task_id, attempt_no)
);

CREATE INDEX IF NOT EXISTS executions_task_idx ON executions(task_id);
`

export interface KingdomRow {
  kingdom_id: string
  name: string
  created_at: string
  owner_id: string
  owner_name: string
  schema_version: number
}

export interface TerritoryRow {
  territory_id: string
  kingdom_id: string
  name: string
  workspace_path: string | null
  summary: string | null
  supervisor_binding_id: string | null
  status: string
  created_at: string
}

export interface RoleBindingRow {
  binding_id: string
  kingdom_id: string
  role_type: string
  role_name: string
  runtime_type: string
  session_id: string | null
  principal_id: string | null
  created_at: string
  updated_at: string
}

export interface EventRow {
  event_id: string
  kingdom_id: string
  event_type: string
  actor_role: string | null
  actor_id: string | null
  target_type: string | null
  target_id: string | null
  payload_json: string
  created_at: string
  /**
   * 王国内单调递增的事件序号（GUI 排序与断流检测用）。
   *
   * 由 `appendEvent` 在 IMMEDIATE 事务里分配，保证「读 MAX + 写入」原子。
   * GUI 用它判断：哪个事件更新、是否漏了事件、以及**旧事件不得让已停止的人物重新出现**。
   * 旧库由 `ensureEventSequence()` 按 rowid（即插入顺序）回填。
   */
  seq: number
}

/**
 * executions 行（Phase 3 新增第 7 张表）。
 *
 * **与 tasks 的分工**：`tasks.status` 是治理事实（组织裁定进度），
 * 本表是运行事实（某一次执行此刻的状况）。
 * `Task.RUNNING` 不等于"正在执行"——REWORK 后任务立刻回 RUNNING，
 * 但新 Execution 尚未创建。GUI 必须看本表才能决定人物是否在工作。
 */
export interface ExecutionRow {
  execution_id: string
  task_id: string
  attempt_no: number
  worker_binding_id: string | null
  /** 该次执行的 one-shot subagent session id（每轮 REWORK 都是新的）。 */
  session_id: string | null
  /** STARTING / RUNNING / PAUSED / COMPLETED / FAILED / ABORTED，见 ./execution.ts。 */
  state: string
  /** 终止原因等诊断信息（宿主观察，非 Worker 自述）。 */
  detail: string | null
  started_at: string
  heartbeat_at: string | null
  ended_at: string | null
  /**
   * 暂停请求时间。
   *
   * one-shot subagent 无法在一次 turn 中途真正挂起，因此"暂停"的诚实语义是：
   * 请求已登记，**在下一个 attempt 边界生效**。执行中的 Execution 会保持
   * `RUNNING` 并带 `pause_requested_at`（GUI 应显示"准备休息"而不是"已睡着"）。
   */
  pause_requested_at: string | null
}

/** tasks 行（Phase 1 schema，Phase 2 一字未改）。status 语义见 ./task.ts。 */
export interface TaskRow {
  task_id: string
  territory_id: string
  parent_task_id: string | null
  title: string
  description: string | null
  assigned_binding_id: string | null
  /** 权威状态。只经 KingdomStore.transitionTask 写入（全库唯一 status UPDATE）。 */
  status: string
  acceptance_criteria: string | null
  /** 最近一次 Worker Claim 的摘要。**是 Claim，不是完成事实**。 */
  result_summary: string | null
  created_at: string
  updated_at: string
}

/**
 * worker_results 行（Phase 2 新增第 6 张表，Owner 裁决 4）。
 *
 * **语义写死：本表保存 Worker Claim，不代表 Task Fact。**
 * 一行 = 一个 attempt 的 Worker 自述结果。Task 是否完成由 tasks.status 决定，
 * 而 tasks.status 只能由 Supervisor 经 kingdom_review_task 推到 DONE。
 * outcome 是 Worker 自称的 COMPLETED/FAILED/BLOCKED，**不参与**任何自动状态决策。
 */
export interface WorkerResultRow {
  result_id: string
  task_id: string
  /** 第几次尝试，从 1 起；REWORK 每轮 +1。UNIQUE(task_id, attempt_no)。 */
  attempt_no: number
  worker_binding_id: string | null
  /** 该 attempt 的 one-shot subagent session id（每轮 REWORK 都是新 session）。 */
  session_id: string | null
  /** Worker 自称的结果：COMPLETED / FAILED / BLOCKED。是 Claim。 */
  outcome: string
  /** 完整结构化 Claim（summary/artifacts/risks），JSON 文本。 */
  result_json: string
  created_at: string
}

export class KingdomStore {
  readonly db: DatabaseSync
  /** 已打开即存在（表已保证）；记录 init 结果供 status 用 */
  readonly existed: boolean

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    const existed = isExistingDatabase(dbPath)
    this.existed = existed
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA_SQL)
    this.ensureEventSequence()
  }

  /**
   * 给 events 补上单调序号列（0.2.0 → 0.3.0 唯一一处触及既有表的变更）。
   *
   * 仍然是纯增量、可重复执行、无 table-rebuild：
   * 1. `PRAGMA table_info` 做存在性 gate（`ADD COLUMN` 没有 IF NOT EXISTS）；
   * 2. 用 rowid（= 插入顺序）回填历史行，历史顺序因此可确定地重建；
   * 3. 索引用 `IF NOT EXISTS`。
   *
   * 注意 SQLite 的 `ALTER TABLE ... ADD COLUMN` 是 O(1) 元数据操作，
   * 不重写数据页，因此旧库开库仍然是瞬时收敛。
   */
  private ensureEventSequence(): void {
    const columns = this.db.prepare('PRAGMA table_info(events)').all() as unknown as { name: string }[]
    if (!columns.some(c => c.name === 'seq')) {
      this.db.exec('ALTER TABLE events ADD COLUMN seq INTEGER')
    }
    // rowid 即插入顺序；只回填未赋值的历史行，重复执行无副作用。
    this.db.exec('UPDATE events SET seq = rowid WHERE seq IS NULL')
    this.db.exec('CREATE INDEX IF NOT EXISTS events_kingdom_seq_idx ON events(kingdom_id, seq)')
  }

  /** 关闭连接（插件卸载/重载时调用，避免句柄泄漏）。 */
  close(): void {
    try {
      this.db.close()
    } catch {
      // 已关闭则忽略
    }
  }

  // ── kingdoms ────────────────────────────────────────────────

  listKingdoms(): KingdomRow[] {
    return this.db
      .prepare('SELECT * FROM kingdoms ORDER BY created_at')
      .all() as unknown as KingdomRow[]
  }

  getDefaultKingdom(): KingdomRow | null {
    const rows = this.listKingdoms()
    return rows[0] ?? null
  }

  insertKingdom(row: Omit<KingdomRow, 'schema_version'> & { schema_version?: number }): KingdomRow {
    const full: KingdomRow = {
      schema_version: SCHEMA_VERSION,
      ...row,
    }
    this.db
      .prepare(
        `INSERT INTO kingdoms (kingdom_id, name, created_at, owner_id, owner_name, schema_version)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(full.kingdom_id, full.name, full.created_at, full.owner_id, full.owner_name, full.schema_version)
    return full
  }

  // ── territories ─────────────────────────────────────────────

  listTerritories(kingdomId: string): TerritoryRow[] {
    return this.db
      .prepare('SELECT * FROM territories WHERE kingdom_id = ? ORDER BY created_at')
      .all(kingdomId) as unknown as TerritoryRow[]
  }

  getTerritoryByName(kingdomId: string, name: string): TerritoryRow | null {
    const rows = this.db
      .prepare('SELECT * FROM territories WHERE kingdom_id = ? AND name = ?')
      .all(kingdomId, name) as unknown as TerritoryRow[]
    return rows[0] ?? null
  }

  getTerritoryById(territoryId: string): TerritoryRow | null {
    const rows = this.db
      .prepare('SELECT * FROM territories WHERE territory_id = ?')
      .all(territoryId) as unknown as TerritoryRow[]
    return rows[0] ?? null
  }

  insertTerritory(row: TerritoryRow): TerritoryRow {
    this.db
      .prepare(
        `INSERT INTO territories
           (territory_id, kingdom_id, name, workspace_path, summary, supervisor_binding_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.territory_id,
        row.kingdom_id,
        row.name,
        row.workspace_path,
        row.summary,
        row.supervisor_binding_id,
        row.status,
        row.created_at,
      )
    return row
  }

  // ── role_bindings ───────────────────────────────────────────

  listBindings(kingdomId: string): RoleBindingRow[] {
    return this.db
      .prepare('SELECT * FROM role_bindings WHERE kingdom_id = ? ORDER BY created_at')
      .all(kingdomId) as unknown as RoleBindingRow[]
  }

  getBindingByRole(kingdomId: string, roleType: string): RoleBindingRow | null {
    const rows = this.db
      .prepare('SELECT * FROM role_bindings WHERE kingdom_id = ? AND role_type = ?')
      .all(kingdomId, roleType) as unknown as RoleBindingRow[]
    return rows[0] ?? null
  }

  getBindingById(bindingId: string): RoleBindingRow | null {
    const rows = this.db
      .prepare('SELECT * FROM role_bindings WHERE binding_id = ?')
      .all(bindingId) as unknown as RoleBindingRow[]
    return rows[0] ?? null
  }

  insertBinding(row: RoleBindingRow): RoleBindingRow {
    this.db
      .prepare(
        `INSERT INTO role_bindings
           (binding_id, kingdom_id, role_type, role_name, runtime_type, session_id, principal_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.binding_id,
        row.kingdom_id,
        row.role_type,
        row.role_name,
        row.runtime_type,
        row.session_id,
        row.principal_id,
        row.created_at,
        row.updated_at,
      )
    return row
  }

  updateBindingSession(bindingId: string, sessionId: string | null, updatedAt: string): void {
    this.db
      .prepare('UPDATE role_bindings SET session_id = ?, updated_at = ? WHERE binding_id = ?')
      .run(sessionId, updatedAt, bindingId)
  }

  // ── events ──────────────────────────────────────────────────

  listEvents(kingdomId: string, limit = 50): EventRow[] {
    return this.db
      .prepare('SELECT * FROM events WHERE kingdom_id = ? ORDER BY seq DESC LIMIT ?')
      .all(kingdomId, limit) as unknown as EventRow[]
  }

  /**
   * 按序号增量拉取（GUI 轮询用）：返回 seq > afterSeq 的事件，**升序**。
   *
   * GUI 据此判断是否漏事件（收到的首个 seq 应等于 afterSeq + 1），
   * 漏了就重新拉一次全量 snapshot，而不是拿残缺事件流去驱动动画。
   */
  listEventsSince(kingdomId: string, afterSeq: number, limit = 200): EventRow[] {
    return this.db
      .prepare('SELECT * FROM events WHERE kingdom_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(kingdomId, afterSeq, limit) as unknown as EventRow[]
  }

  /**
   * 王国当前 revision = 最大事件序号。
   *
   * 任何治理动作都会追加事件，所以这个数既是事件游标，也是"数据版本"：
   * GUI 比较 revision 就知道要不要重绘，不必 diff 整个 snapshot。
   */
  revision(kingdomId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM events WHERE kingdom_id = ?')
      .get(kingdomId) as unknown as { n: number } | undefined
    return row?.n ?? 0
  }

  /**
   * 追加事件并分配单调 seq。
   *
   * 「读 MAX(seq) + INSERT」放在 IMMEDIATE 事务里，避免并发写出重复序号
   * （SQLite 会串行化写事务）。序号在**全库**范围内单调，跨王国也不会回退。
   */
  appendEvent(row: Omit<EventRow, 'seq'> & { seq?: number }): EventRow {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const next = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM events')
        .get() as unknown as { n: number } | undefined
      const seq = (next?.n ?? 0) + 1
      this.db
        .prepare(
          `INSERT INTO events
             (event_id, kingdom_id, event_type, actor_role, actor_id, target_type, target_id, payload_json, created_at, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.event_id,
          row.kingdom_id,
          row.event_type,
          row.actor_role,
          row.actor_id,
          row.target_type,
          row.target_id,
          row.payload_json,
          row.created_at,
          seq,
        )
      this.db.exec('COMMIT')
      return { ...row, seq }
    } catch (error: unknown) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // ── tasks（Phase 2；schema 未改，状态机在 ./task.ts）──────────

  getTask(taskId: string): TaskRow | null {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE task_id = ?')
      .all(taskId) as unknown as TaskRow[]
    return rows[0] ?? null
  }

  /**
   * 列出王国内任务。tasks 无 kingdom_id 列（Phase 1 schema），
   * 经 territories 关联收敛到王国边界。
   */
  listTasks(kingdomId: string, filter: { territoryId?: string; status?: string } = {}): TaskRow[] {
    const clauses = ['te.kingdom_id = ?']
    const params: string[] = [kingdomId]
    if (filter.territoryId) {
      clauses.push('t.territory_id = ?')
      params.push(filter.territoryId)
    }
    if (filter.status) {
      clauses.push('t.status = ?')
      params.push(filter.status)
    }
    return this.db
      .prepare(
        `SELECT t.* FROM tasks t
           JOIN territories te ON te.territory_id = t.territory_id
          WHERE ${clauses.join(' AND ')}
          ORDER BY t.created_at`,
      )
      .all(...params) as unknown as TaskRow[]
  }

  insertTask(row: TaskRow): TaskRow {
    this.db
      .prepare(
        `INSERT INTO tasks
           (task_id, territory_id, parent_task_id, title, description, assigned_binding_id,
            status, acceptance_criteria, result_summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.task_id,
        row.territory_id,
        row.parent_task_id,
        row.title,
        row.description,
        row.assigned_binding_id,
        row.status,
        row.acceptance_criteria,
        row.result_summary,
        row.created_at,
        row.updated_at,
      )
    return row
  }

  /**
   * **全库唯一的 tasks.status 写入路径**（治理底线，Owner 裁决 1）。
   *
   * 先过 ./task.ts 的 transition() 校验，非法转移直接抛 TaskTransitionError，
   * 一个字节都不会落库。任何工具都无法绕过它把 Task 直接置 DONE
   * —— DONE 只能从 REVIEW 经 Supervisor 的 ACCEPT 决定到达。
   *
   * @param task 当前任务行（status 取自库，未知值 fail-loud）。
   * @param to 目标状态。
   * @param patch 与状态同事务落库的附带字段（如指派、Claim 摘要）。
   * @returns 落库后的新任务行。
   */
  transitionTask(
    task: TaskRow,
    to: TaskStatus,
    patch: { assigned_binding_id?: string | null; result_summary?: string | null } = {},
  ): TaskRow {
    const from = asTaskStatus(task.status)
    const next = transition(from, to)
    const now = new Date().toISOString()
    const assigned = patch.assigned_binding_id === undefined
      ? task.assigned_binding_id
      : patch.assigned_binding_id
    const summary = patch.result_summary === undefined ? task.result_summary : patch.result_summary
    this.db
      .prepare(
        `UPDATE tasks SET status = ?, assigned_binding_id = ?, result_summary = ?, updated_at = ?
          WHERE task_id = ?`,
      )
      .run(next, assigned, summary, now, task.task_id)
    return { ...task, status: next, assigned_binding_id: assigned, result_summary: summary, updated_at: now }
  }

  // ── worker_results（Phase 2 第 6 张表；保存 Claim，不是 Fact）──

  listWorkerResults(taskId: string): WorkerResultRow[] {
    return this.db
      .prepare('SELECT * FROM worker_results WHERE task_id = ? ORDER BY attempt_no')
      .all(taskId) as unknown as WorkerResultRow[]
  }

  latestWorkerResult(taskId: string): WorkerResultRow | null {
    const rows = this.db
      .prepare('SELECT * FROM worker_results WHERE task_id = ? ORDER BY attempt_no DESC LIMIT 1')
      .all(taskId) as unknown as WorkerResultRow[]
    return rows[0] ?? null
  }

  /** 已落库的最大 attempt_no；无结果时为 0。下一次尝试 = 本值 + 1。 */
  maxAttemptNo(taskId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(attempt_no), 0) AS n FROM worker_results WHERE task_id = ?')
      .get(taskId) as unknown as { n: number } | undefined
    return row?.n ?? 0
  }

  insertWorkerResult(row: WorkerResultRow): WorkerResultRow {
    this.db
      .prepare(
        `INSERT INTO worker_results
           (result_id, task_id, attempt_no, worker_binding_id, session_id, outcome, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.result_id,
        row.task_id,
        row.attempt_no,
        row.worker_binding_id,
        row.session_id,
        row.outcome,
        row.result_json,
        row.created_at,
      )
    return row
  }

  // ── executions（Phase 3 第 7 张表；运行事实，非治理事实）──────

  getExecution(executionId: string): ExecutionRow | null {
    const rows = this.db
      .prepare('SELECT * FROM executions WHERE execution_id = ?')
      .all(executionId) as unknown as ExecutionRow[]
    return rows[0] ?? null
  }

  listExecutions(taskId: string): ExecutionRow[] {
    return this.db
      .prepare('SELECT * FROM executions WHERE task_id = ? ORDER BY attempt_no')
      .all(taskId) as unknown as ExecutionRow[]
  }

  latestExecution(taskId: string): ExecutionRow | null {
    const rows = this.db
      .prepare('SELECT * FROM executions WHERE task_id = ? ORDER BY attempt_no DESC LIMIT 1')
      .all(taskId) as unknown as ExecutionRow[]
    return rows[0] ?? null
  }

  /** 王国内所有未终结的 Execution（人物应当在场的那些）。 */
  listLiveExecutions(kingdomId: string): ExecutionRow[] {
    return this.db
      .prepare(
        `SELECT e.* FROM executions e
           JOIN tasks t      ON t.task_id = e.task_id
           JOIN territories te ON te.territory_id = t.territory_id
          WHERE te.kingdom_id = ?
            AND e.state IN ('STARTING', 'RUNNING', 'PAUSED')
          ORDER BY e.started_at`,
      )
      .all(kingdomId) as unknown as ExecutionRow[]
  }

  insertExecution(row: ExecutionRow): ExecutionRow {
    this.db
      .prepare(
        `INSERT INTO executions
           (execution_id, task_id, attempt_no, worker_binding_id, session_id, state, detail,
            started_at, heartbeat_at, ended_at, pause_requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.execution_id,
        row.task_id,
        row.attempt_no,
        row.worker_binding_id,
        row.session_id,
        row.state,
        row.detail,
        row.started_at,
        row.heartbeat_at,
        row.ended_at,
        row.pause_requested_at,
      )
    return row
  }

  /**
   * **全库唯一的 executions.state 写入路径**（与 transitionTask 同构）。
   *
   * 先过 ./execution.ts 的 `transitionExecution()` 校验，非法转移抛错、不落库。
   * 终态自动补 `ended_at`，避免"已结束但没有结束时间"的半截记录。
   */
  transitionExecution(
    execution: ExecutionRow,
    to: ExecutionState,
    patch: { detail?: string | null; sessionId?: string | null; pauseRequestedAt?: string | null } = {},
  ): ExecutionRow {
    const from = asExecutionState(execution.state)
    const next = transitionExecution(from, to)
    const now = new Date().toISOString()
    const ended = isTerminalExecutionState(next) ? now : execution.ended_at
    const detail = patch.detail === undefined ? execution.detail : patch.detail
    const sessionId = patch.sessionId === undefined ? execution.session_id : patch.sessionId
    const pauseRequestedAt = patch.pauseRequestedAt === undefined
      ? execution.pause_requested_at
      : patch.pauseRequestedAt
    this.db
      .prepare(
        `UPDATE executions
            SET state = ?, detail = ?, session_id = ?, heartbeat_at = ?, ended_at = ?, pause_requested_at = ?
          WHERE execution_id = ?`,
      )
      .run(next, detail, sessionId, now, ended, pauseRequestedAt, execution.execution_id)
    return {
      ...execution,
      state: next,
      detail,
      session_id: sessionId,
      heartbeat_at: now,
      ended_at: ended,
      pause_requested_at: pauseRequestedAt,
    }
  }

  /** 心跳：只更新 heartbeat_at，不碰状态。GUI 据此判断执行是否还活着。 */
  touchExecution(executionId: string): void {
    this.db
      .prepare('UPDATE executions SET heartbeat_at = ? WHERE execution_id = ?')
      .run(new Date().toISOString(), executionId)
  }

  /** 登记暂停请求（不改状态；生效点见 ExecutionRow.pause_requested_at 注释）。 */
  setExecutionPauseRequest(executionId: string, at: string | null): void {
    this.db
      .prepare('UPDATE executions SET pause_requested_at = ? WHERE execution_id = ?')
      .run(at, executionId)
  }

  // ── status 汇总 ─────────────────────────────────────────────

  statusSummary(): string {
    const kingdom = this.getDefaultKingdom()
    if (!kingdom) {
      return '尚未初始化王国。请先执行 /kingdom init 或说“初始化王国”。'
    }
    const territories = this.listTerritories(kingdom.kingdom_id)
    const bindings = this.listBindings(kingdom.kingdom_id)
    const events = this.listEvents(kingdom.kingdom_id, 10)
    const tasks = this.listTasks(kingdom.kingdom_id)
    const lines = [
      `王国：${kingdom.name}（id=${kingdom.kingdom_id}）`,
      `Owner：${kingdom.owner_name}（id=${kingdom.owner_id}）`,
      `领地数：${territories.length}`,
      `角色绑定：${bindings.length}（${bindings.map(b => b.role_type).join('、') || '无'}）`,
      `任务数：${tasks.length}${tasks.length > 0 ? `（${summariseTaskStatuses(tasks)}）` : ''}`,
    ]
    if (territories.length > 0) {
      lines.push('领地：')
      for (const t of territories) {
        lines.push(`  - ${t.name}（${t.status}${t.workspace_path ? `，${t.workspace_path}` : ''}）`)
      }
    }
    if (events.length > 0) {
      lines.push('最近事件：')
      for (const e of events.slice(0, 5)) {
        lines.push(`  - ${e.created_at} ${e.event_type}${e.target_id ? ` → ${e.target_id}` : ''}`)
      }
    }
    return lines.join('\n')
  }
}

function isExistingDatabase(path: string): boolean {
  return existsSync(path)
}

/** "CREATED×1、REVIEW×2" 形式的状态直方图，供 status 一行展示。 */
function summariseTaskStatuses(tasks: TaskRow[]): string {
  const counts = new Map<string, number>()
  for (const t of tasks) counts.set(t.status, (counts.get(t.status) ?? 0) + 1)
  return [...counts.entries()].map(([status, n]) => `${status}×${n}`).join('、')
}
