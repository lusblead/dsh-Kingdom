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
      .prepare('SELECT * FROM events WHERE kingdom_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(kingdomId, limit) as unknown as EventRow[]
  }

  appendEvent(row: EventRow): EventRow {
    this.db
      .prepare(
        `INSERT INTO events
           (event_id, kingdom_id, event_type, actor_role, actor_id, target_type, target_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      )
    return row
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
