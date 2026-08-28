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
 * - v1：0.x–0.5.x（幂等 DDL 收敛）；
 * - v2：v0.6.0 执行证据列（M1-C）；
 * - v3：v0.7.0（M2 Organization Scale）——
 *   role_bindings tombstone（status/retired_at/retired_reason）、
 *   territories tombstone（deleted_at/deleted_reason）、
 *   task_assignments（权威派遣历史 + one-active 唯一索引）、
 *   Territory supervisor backfill（1 个 ACTIVE Supervisor → NULL scope 领地自动接管）。
 * - v4：v0.8.0（M3-S2 Schema v4 Design v6，Owner 三次 Review APPROVED 2026-08-19）——
 *   四套独立 Core Ledger（session_territory_affinities / execution_leases /
 *   capability_decisions / dispatch_records）+ executions 重建（增 execution_contract /
 *   lease_id / capability_decision_id 三列，旧行 backfill LEGACY_COMPAT）+
 *   tasks.capability_requirement_json / kingdoms.capability_ceiling_json 增量 +
 *   硬编码 transition trigger（含 INSERT 状态守卫）+ 完整 immutability/DELETE 保护 +
 *   每连接 PRAGMA foreign_keys=ON 协议。
 *
 * 迁移纪律（v2 起）：
 * - **每个 ensureSchemaVx 只 gate 自己的目标版本、只写自己的目标版本**
 *   （v2→2 / v3→3 / v4→4）。禁止用全局 SCHEMA_VERSION 做 gate/写入，
 *   否则 bump 全局版本会令旧迁移重跑并直写新版本、跳过目标迁移。
 * - v4 的 executions 重建（DROP + RENAME）与全部 v4 DDL 都在 ensureSchemaV4
 *   的**单事务**内完成；任一步失败 ROLLBACK，库保持完整旧语义。
 * - v4 DDL 不进 SCHEMA_SQL bootstrap（避免迁移事务语义失效；见 ensureSchemaV4 头注）。
 */
export const SCHEMA_VERSION = 4

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
  model_name   TEXT,
  agent_name   TEXT,
  session_meta TEXT,
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

CREATE TABLE IF NOT EXISTS task_assignments (
  assignment_id          TEXT PRIMARY KEY,
  task_id                TEXT NOT NULL,
  territory_id           TEXT NOT NULL,
  worker_binding_id      TEXT NOT NULL,
  assigned_by            TEXT NOT NULL,
  assigned_at            TEXT NOT NULL,
  ended_at               TEXT,
  end_reason             TEXT,
  previous_assignment_id TEXT,
  handoff_reason         TEXT,
  created_at             TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_assignment_per_task
  ON task_assignments(task_id) WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS task_assignments_task_idx ON task_assignments(task_id);
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
  /**
   * v0.7.0（M2）：Territory 主理 Supervisor（scope relation）。
   * NULL = 未指派 → **fail-closed**（无 Supervisor 可治理，TERRITORY_SUPERVISOR_MISSING）。
   */
  supervisor_binding_id: string | null
  /** ACTIVE | ARCHIVED | DELETED（v0.7.0：DELETED 为 tombstone，不物理删行）。 */
  status: string
  /** v0.7.0 tombstone 字段。 */
  deleted_at: string | null
  deleted_reason: string | null
  created_at: string
}

/**
 * v0.7.0（M2-B）：权威任务派遣历史（Assignment Ledger）。
 * tasks.assigned_binding_id 是当前投影；本表是可追溯历史。
 */
export interface TaskAssignmentRow {
  assignment_id: string
  task_id: string
  territory_id: string
  worker_binding_id: string
  /** 谁决定派发（Supervisor binding_id）。 */
  assigned_by: string
  assigned_at: string
  /** 关闭时间（HANDOFF / task-terminal 时写入）。 */
  ended_at: string | null
  /** 'handoff' | 'task-terminal'（REWORK 不关闭 Assignment）。 */
  end_reason: string | null
  /** 前序派遣（链表，须同 task、已关闭、非自身）。 */
  previous_assignment_id: string | null
  /** Supervisor 的转交理由（handoff 时）。 */
  handoff_reason: string | null
  created_at: string
}

export interface RoleBindingRow {
  binding_id: string
  kingdom_id: string
  role_type: string
  role_name: string
  runtime_type: string
  session_id: string | null
  /**
   * v0.4：会话身份预留字段（现在不必每次填写，但 schema 与工具面已留位）。
   * 模型名（如 deepseek-v4-pro / gpt-5.6）、agent 工具名（如 codex / dsh）、
   * 以及通用扩展槽 session_meta（JSON 字符串，承载 provider/版本/runtime 等任意未来字段）。
   */
  model_name: string | null
  agent_name: string | null
  session_meta: string | null
  /**
   * v0.6.0（M1-C）：执行配置（ExecutionProfileV1 JSON：{provider?, model?}）。
   * 与 model_name 严格分工：model_name 只是席位展示元数据，**ExecutorFactory 禁止读取**；
   * 执行解析只读本字段。非法 JSON 视为未配置。
   */
  execution_profile_json: string | null
  /**
   * v0.7.0（M2）：Binding tombstone——退任（unbind）从物理删除改为 ACTIVE→RETIRED，
   * 历史引用（task_assignments/executions/events/territories.supervisor_binding_id）永远可解析。
   */
  status: 'ACTIVE' | 'RETIRED'
  retired_at: string | null
  retired_reason: string | null
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
  /**
   * 该次执行的 runtime session id；LEGACY_COMPAT 每轮 REWORK 都是新的 one-shot，
   * GOVERNED_PERSISTENT 则记录被复用的长期 Worker Session。
   */
  session_id: string | null
  /** STARTING / RUNNING / PAUSED / COMPLETED / FAILED / ABORTED，见 ./execution.ts。 */
  state: string
  /** 终止原因等诊断信息（宿主观察，非 Worker 自述）。 */
  detail: string | null
  started_at: string
  /**
   * 最近一次**状态转移**的时刻，不是心跳。
   *
   * 诚实说明：LEGACY_COMPAT one-shot subagent seam 不提供任何进度回调
   * （`SubagentRun` 只有 `{id, localAgent, result, dispose}`），
   * 所以执行进行中没有任何可以周期性上报的信号，本字段在整个执行体内不会前进。
   *
   * **不要拿它做存活判定**：一次合法的长执行与一次挂死的执行，
   * 在这个字段上完全无法区分。插件崩溃/重载导致的残骸由加载期回收兜底
   * （见 task-service.ts 的 reclaimOrphanExecutions），那条路径不依赖本字段。
   */
  heartbeat_at: string | null
  ended_at: string | null
  /**
   * 暂停请求时间。
   *
   * LEGACY_COMPAT one-shot subagent 无法在一次 turn 中途真正挂起，因此"暂停"的诚实语义是：
   * 请求已登记，**在下一个 attempt 边界生效**。执行中的 Execution 会保持
   * `RUNNING` 并带 `pause_requested_at`（GUI 应显示"准备休息"而不是"已睡着"）。
   */
  pause_requested_at: string | null
  /**
   * v0.6.0（M1-C）执行证据列（不可变快照：start 时写入，结算时一次性补 resolved_model）。
   * 回答"哪个 Worker / 哪个 provider / 哪个 model / 哪个 run / 第几次 attempt"。
   */
  executor_kind: string | null
  /** 最终 subagent provider 名。 */
  provider: string | null
  /** 'binding' | 'global-fallback'。 */
  provider_source: string | null
  /** profile.model ?? null（null=继承父 Agent）。 */
  requested_model: string | null
  /** DSH Runtime 解析后的有效模型（in-process 可观察）；null=seam 无证据。 */
  resolved_model: string | null
  /** 'binding' | 'parent-inherited' | 'unknown'。 */
  model_source: string | null
  /** 不可变执行解析快照 JSON（requested/resolved/source 三节；关键字段以列为准）。 */
  execution_profile_json: string | null
  /**
   * v0.8（M3-S2 v6）：Execution Contract。
   * `LEGACY_COMPAT`（旧 one-shot 路径 backfill）/ `GOVERNED_PERSISTENT`（受治理持久执行）。
   * 创建后不可变（execution_contract_immutable trigger）。
   */
  execution_contract: string
  /** v0.8：GOVERNED_PERSISTENT 必关联的 Lease（FK → execution_leases）。 */
  lease_id: string | null
  /** v0.8：GOVERNED_PERSISTENT 必关联的 GRANTED+ENFORCED Decision（FK → capability_decisions）。 */
  capability_decision_id: string | null
}

/**
 * v0.8（M3-S2 v6）：Session ↔ Territory Affinity Ledger 行。
 * 完整 Runtime Session identity = (runtime_type, runtime_instance_ref, session_ref)。
 */
export interface AffinityRow {
  affinity_id: string
  kingdom_id: string
  worker_binding_id: string
  runtime_type: string
  runtime_instance_ref: string
  session_ref: string
  territory_id: string
  established_at: string
  retired_at: string | null
  /** 1=当前（retired_at 必 NULL）/ 0=已退役（retired_at 必非 NULL），行内 CHECK 强制。 */
  is_current: number
  created_at: string
}

/** v0.8（M3-S2 v6）：Execution Lease Ledger 行。 */
export interface LeaseRow {
  lease_id: string
  kingdom_id: string
  worker_binding_id: string
  runtime_type: string
  runtime_instance_ref: string
  session_ref: string
  territory_id: string
  task_id: string
  attempt_no: number
  /** ACQUIRED..RELEASED / RECOVERING，见 v6 transition matrix。 */
  state: string
  capability_decision_id: string | null
  enforcement_plan_snapshot: string | null
  release_evidence_json: string | null
  release_reason: string | null
  acquired_at: string
  released_at: string | null
  updated_at: string
}

/** v0.8（M3-S2 v6）：Capability Decision Ledger 行。合法组合 GRANTED+ENFORCED / DENIED+{NOT_ATTEMPTED,UNAVAILABLE,FAILED}。 */
export interface CapabilityDecisionRow {
  decision_id: string
  kingdom_id: string
  task_id: string
  worker_binding_id: string | null
  supervisor_binding_id: string | null
  requirement_snapshot: string | null
  ceiling_snapshot: string | null
  proposed_grant_snapshot: string | null
  scope_snapshot: string | null
  effective_snapshot: string | null
  decision: string
  enforcement_status: string
  enforcement_evidence_json: string | null
  requirement_coverage: string
  reason_code: string | null
  execution_id: string | null
  created_at: string
}

/** v0.8（M3-S2 v6）：Dispatch Record / Intent Ledger 行（COMMIT POINT 先于 Runtime dispatch）。 */
export interface DispatchRecordRow {
  dispatch_id: string
  kingdom_id: string
  lease_id: string
  execution_id: string
  task_id: string
  attempt_no: number
  runtime_type: string
  runtime_instance_ref: string
  session_ref: string
  /** INTENDED..TERMINAL / FAILED / RECOVERING，见 v6 transition matrix。 */
  state: string
  dispatch_request_snapshot: string
  dispatch_input_ref_json: string
  dispatch_payload_hash: string
  runtime_dispatch_ref: string | null
  runtime_execution_ref: string | null
  receipt_json: string | null
  terminal_evidence_json: string | null
  output_ref_json: string | null
  dispatched_at: string | null
  receipt_at: string | null
  terminal_at: string | null
  created_at: string
  updated_at: string
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
  /** v0.8：Task 的非权威 Capability Requirement；旧 v3 库可能没有该列。 */
  capability_requirement_json?: string | null
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
  /** 该 attempt 的 runtime session id；仅 LEGACY_COMPAT 每轮 REWORK 都是新 one-shot session。 */
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
  /** 库的 schema 版本（经 kingdoms.schema_version 收敛；v4 判定用）。 */
  readonly schemaVersion: number

  constructor(dbPath: string, options: { allowSchemaV4?: boolean } = {}) {
    mkdirSync(dirname(dbPath), { recursive: true })
    const existed = isExistingDatabase(dbPath)
    this.existed = existed
    this.db = new DatabaseSync(dbPath)
    try {
      this.db.exec('PRAGMA journal_mode = WAL')
      // v0.8（M3-S2 v6 §6 / F-1..F-4）：FK 是连接级设置——每个连接开启 + 回读断言。
      // 必须在任何事务之前执行（SQLite 禁止在事务内切换 foreign_keys）。
      this.enableForeignKeys()
      this.db.exec(SCHEMA_SQL)
      this.ensureEventSequence()
      this.ensureSessionProfileColumns()
      this.ensureSchemaV2()
      this.ensureSchemaV3()
      // v0.8（M3-S2 v6）：Schema v4 迁移。
      // 正式 kingdom.db 受 Formal DB Migration Gate 保护：默认**不自动**迁移已有 v3 库
      // （打开真实库时保持 v3 语义继续可用，v4 Domain API 会 fail-closed 拒绝）；
      // 只有「全新库（无王国数据）」或显式 allowSchemaV4=true 才执行 v4。
      const fresh = !existed || this.getDefaultKingdom() === null
      const v4Migrated = options.allowSchemaV4 === true || fresh
      if (v4Migrated) {
        this.ensureSchemaV4()
      }
      // 空王国库（:memory:/新文件）的 UPDATE kingdoms 命中 0 行，
      // 但 v4 对象已建 → 版本按 MAX(库值, 已执行 v4 ? 4 : 0) 收敛。
      this.schemaVersion = Math.max(this.readSchemaVersion(), v4Migrated ? 4 : 0)
    } catch (error: unknown) {
      // 迁移/初始化失败：关闭连接再抛，避免句柄泄漏锁死文件（Windows EPERM）
      try { this.db.close() } catch { /* 已关闭则忽略 */ }
      throw error
    }
  }

  /**
   * v0.8（M3-S2 v6 F-1/F-2）：FK 连接级协议。
   * 每个连接创建后：PRAGMA foreign_keys=ON → 回读 → 断言 == 1（fail-loud）。
   */
  private enableForeignKeys(): void {
    this.db.exec('PRAGMA foreign_keys = ON')
    const row = this.db.prepare('PRAGMA foreign_keys').get() as unknown as { foreign_keys: number } | undefined
    if ((row?.foreign_keys ?? 0) !== 1) {
      throw new Error('Schema v4 FK protocol failed: PRAGMA foreign_keys read-back != 1（拒绝在 FK 关闭的连接上继续）')
    }
  }

  /** 当前库 schema 版本（kingdoms.schema_version 的 MAX；无王国视为 0）。 */
  private readSchemaVersion(): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(schema_version), 0) AS v FROM kingdoms')
      .get() as unknown as { v: number } | undefined
    return row?.v ?? 0
  }

  /** v0.8：库是否已具备 v4 结构（Domain API 前置校验用；非 v4 一律 fail-closed）。 */
  get isSchemaV4(): boolean {
    return this.schemaVersion >= 4 && this.hasV4Objects()
  }

  /**
   * v0.4：给 role_bindings 补会话身份预留列（model_name / agent_name / session_meta）。
   *
   * 与 ensureEventSequence 同款幂等增量迁移：`PRAGMA table_info` 做存在性 gate，
   * `ALTER TABLE ... ADD COLUMN` 缺啥补啥，重复执行无副作用、O(1) 元数据操作。
   * 旧库（0.3.x）开库瞬间收敛到 v0.4 结构，不重建表、不丢数据。
   */
  private ensureSessionProfileColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(role_bindings)').all() as unknown as { name: string }[]
    const names = new Set(columns.map(c => c.name))
    for (const column of ['model_name', 'agent_name', 'session_meta'] as const) {
      if (!names.has(column)) {
        this.db.exec(`ALTER TABLE role_bindings ADD COLUMN ${column} TEXT`)
      }
    }
  }

  /**
   * v0.6.0（M1-C，用户裁决 ④）：正式 Schema v2 迁移。
   *
   * Versioned + transactional + idempotent ADD COLUMN：
   * 1. 读 kingdoms.schema_version 判定是否需要升级（v1 → v2；新库建表后即 v2 无需动）；
   * 2. BEGIN IMMEDIATE → PRAGMA table_info gate 逐列 ADD COLUMN（缺啥补啥）→
   *    verify 全部预期列存在（缺失即抛错）→ UPDATE schema_version=2 → COMMIT；
   * 3. 任一步失败 ROLLBACK，开库即失败（fail-loud，不留下半迁移的库）。
   *
   * 仍保持"增量、安全、不重建"：ADD COLUMN 是 O(1) 元数据操作。
   */
  private ensureSchemaV2(): void {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(schema_version), 0) AS v FROM kingdoms')
      .get() as unknown as { v: number } | undefined
    // gate 自己的目标版本（2），不 gate 全局 SCHEMA_VERSION（见文件头迁移纪律）
    if ((row?.v ?? 0) >= 2) return

    const bindingColumns = ['execution_profile_json'] as const
    const executionColumns = [
      'executor_kind', 'provider', 'provider_source',
      'requested_model', 'resolved_model', 'model_source',
      'execution_profile_json',
    ] as const

    const tableColumns = (table: string): Set<string> => new Set(
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map(c => c.name),
    )

    this.db.exec('BEGIN IMMEDIATE')
    try {
      const bindings = tableColumns('role_bindings')
      for (const column of bindingColumns) {
        if (!bindings.has(column)) this.db.exec(`ALTER TABLE role_bindings ADD COLUMN ${column} TEXT`)
      }
      const executions = tableColumns('executions')
      for (const column of executionColumns) {
        if (!executions.has(column)) this.db.exec(`ALTER TABLE executions ADD COLUMN ${column} TEXT`)
      }
      // verify：全部预期列必须存在，缺失即失败（fail-loud，不静默通过半迁移）
      const afterBindings = tableColumns('role_bindings')
      const afterExecutions = tableColumns('executions')
      for (const column of bindingColumns) {
        if (!afterBindings.has(column)) throw new Error(`Schema v2 migration failed: role_bindings.${column} missing`)
      }
      for (const column of executionColumns) {
        if (!afterExecutions.has(column)) throw new Error(`Schema v2 migration failed: executions.${column} missing`)
      }
      // 注意：写本迁移的目标版本 2，而不是全局 SCHEMA_VERSION（v3 迁移的入口判断依赖它）。
      this.db.prepare('UPDATE kingdoms SET schema_version = ?').run(2)
      this.db.exec('COMMIT')
    } catch (error: unknown) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * v0.7.0（M2 Organization Scale）：Schema v3 迁移。
   *
   * 1. role_bindings tombstone：status（ACTIVE|RETIRED）/ retired_at / retired_reason；
   * 2. territories tombstone：deleted_at / deleted_reason（status 已有列，语义扩展 DELETED）；
   * 3. task_assignments 表与索引（SCHEMA_SQL 已建，这里 verify + 旧库兜底）；
   * 4. Territory supervisor backfill：恰好 1 个 ACTIVE Supervisor 时，
   *    把所有 supervisor_binding_id IS NULL 的 ACTIVE Territory 自动接管（v2 兼容，老用户无感）；
   *    0 个 ACTIVE Supervisor → 保持 NULL（fail-closed：无主理则无人可治理）。
   * 5. verify 全部预期列/表/索引 → UPDATE schema_version=3 → COMMIT（失败 ROLLBACK）。
   */
  private ensureSchemaV3(): void {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(schema_version), 0) AS v FROM kingdoms')
      .get() as unknown as { v: number } | undefined
    // gate 自己的目标版本（3），不 gate 全局 SCHEMA_VERSION（v0.8 迁移纪律）
    if ((row?.v ?? 0) >= 3) return

    const bindingColumns = ['status', 'retired_at', 'retired_reason'] as const
    const territoryColumns = ['deleted_at', 'deleted_reason'] as const

    this.db.exec('BEGIN IMMEDIATE')
    try {
      const tableColumns = (table: string): Set<string> => new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map(c => c.name),
      )
      const bindings = tableColumns('role_bindings')
      for (const column of bindingColumns) {
        if (!bindings.has(column)) this.db.exec(`ALTER TABLE role_bindings ADD COLUMN ${column} TEXT`)
      }
      const territories = tableColumns('territories')
      for (const column of territoryColumns) {
        if (!territories.has(column)) this.db.exec(`ALTER TABLE territories ADD COLUMN ${column} TEXT`)
      }
      // 旧库兜底：status 列缺省值统一为 ACTIVE（新增列默认 NULL → 归一化为 ACTIVE）
      this.db.exec(`UPDATE role_bindings SET status = 'ACTIVE' WHERE status IS NULL`)

      // backfill：恰好 1 个 ACTIVE Supervisor → NULL scope 领地自动接管（0 个 → fail-closed 保持 NULL）
      const supervisorCount = this.db
        .prepare(`SELECT COUNT(*) AS n FROM role_bindings WHERE role_type = 'SUPERVISOR' AND status = 'ACTIVE'`)
        .get() as unknown as { n: number }
      if (supervisorCount.n === 1) {
        this.db.exec(`
          UPDATE territories
             SET supervisor_binding_id = (
               SELECT binding_id FROM role_bindings
                WHERE role_type = 'SUPERVISOR' AND status = 'ACTIVE' LIMIT 1
             )
           WHERE supervisor_binding_id IS NULL AND status = 'ACTIVE'
        `)
      }

      // verify：全部预期列/表/索引存在，缺失即失败（fail-loud）
      const afterBindings = tableColumns('role_bindings')
      const afterTerritories = tableColumns('territories')
      for (const column of bindingColumns) {
        if (!afterBindings.has(column)) throw new Error(`Schema v3 migration failed: role_bindings.${column} missing`)
      }
      for (const column of territoryColumns) {
        if (!afterTerritories.has(column)) throw new Error(`Schema v3 migration failed: territories.${column} missing`)
      }
      const tables = this.db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','index')`).all() as unknown as { name: string }[]
      const names = new Set(tables.map(t => t.name))
      for (const required of ['task_assignments', 'one_active_assignment_per_task', 'task_assignments_task_idx']) {
        if (!names.has(required)) throw new Error(`Schema v3 migration failed: ${required} missing`)
      }
      // v3 迁移的目标版本写 3（不是全局 SCHEMA_VERSION——v4 迁移的入口判断依赖它）
      this.db.prepare('UPDATE kingdoms SET schema_version = ?').run(3)
      this.db.exec('COMMIT')
    } catch (error: unknown) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // ── v0.8（M3-S2 Schema v4 Design v6，Owner 三次 Review APPROVED）─────────
  //
  // 忠实实现 v6（M3-S2 Schema v4 Design v6 + 当时的 49/49 验证脚本）：
  // - 四套独立 Core Ledger：session_territory_affinities / execution_leases /
  //   capability_decisions / dispatch_records；
  // - executions 重建（v6 §14）：建 executions_v4 暂存表（v2 证据列 + 新增
  //   execution_contract/lease_id/capability_decision_id）→ 全量复制 + LEGACY_COMPAT
  //   backfill → 校验行数 → 删旧表 → RENAME 回 executions → 重建索引/trigger → 终验；
  // - 硬编码 transition trigger（含 INSERT 状态守卫）+ 完整 immutability + DELETE 保护；
  // - 每连接 PRAGMA foreign_keys=ON（构造函数 enableForeignKeys，v6 F-1..F-4）。
  //
  // 为什么 v4 DDL 不进 SCHEMA_SQL bootstrap（Owner v0.8 施工 Prompt §13）：
  // SCHEMA_SQL 在构造函数里先于任何事务执行；若 v4 对象提前进入 bootstrap，
  // 既有 v3 库开库瞬间就被建出 v4 表，ensureSchemaV4 的"单事务迁移 + 失败 ROLLBACK"
  // 语义失效。因此 v4 全部 DDL 只在 ensureSchemaV4 的 BEGIN IMMEDIATE 事务内落地。

  /** v4 Ledger 表（affinity/lease/decision）+ 各自索引与 trigger（不含 executions 重建与 dispatch）。 */
  static readonly V4_LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS session_territory_affinities (
  affinity_id       TEXT PRIMARY KEY,
  kingdom_id        TEXT NOT NULL,
  worker_binding_id TEXT NOT NULL,
  runtime_type      TEXT NOT NULL,
  runtime_instance_ref TEXT NOT NULL,
  session_ref       TEXT NOT NULL,
  territory_id      TEXT NOT NULL,
  established_at    TEXT NOT NULL,
  retired_at        TEXT,
  is_current        INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  UNIQUE (runtime_type, runtime_instance_ref, session_ref),
  CHECK (
    (is_current = 1 AND retired_at IS NULL)
    OR
    (is_current = 0 AND retired_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS affinity_one_current_per_worker
  ON session_territory_affinities(kingdom_id, worker_binding_id)
  WHERE is_current = 1;
CREATE TRIGGER IF NOT EXISTS affinity_identity_immutable
BEFORE UPDATE OF kingdom_id, worker_binding_id, runtime_type,
                 runtime_instance_ref, session_ref, territory_id,
                 established_at, created_at
ON session_territory_affinities
BEGIN SELECT RAISE(ABORT, 'AFFINITY_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS affinity_retire
BEFORE UPDATE OF is_current, retired_at
ON session_territory_affinities
BEGIN
  SELECT RAISE(ABORT, 'AFFINITY_RETIRE_ONLY_JOINT')
  WHERE NOT (
    OLD.is_current = 1 AND OLD.retired_at IS NULL
    AND NEW.is_current = 0 AND NEW.retired_at IS NOT NULL
  );
  SELECT RAISE(ABORT, 'AFFINITY_ALREADY_RETIRED')
  WHERE OLD.retired_at IS NOT NULL;
END;
CREATE TRIGGER IF NOT EXISTS affinity_no_delete
BEFORE DELETE ON session_territory_affinities
BEGIN SELECT RAISE(ABORT, 'AFFINITY_NO_DELETE'); END;

CREATE TABLE IF NOT EXISTS execution_leases (
  lease_id               TEXT PRIMARY KEY,
  kingdom_id             TEXT NOT NULL,
  worker_binding_id      TEXT NOT NULL,
  runtime_type           TEXT NOT NULL,
  runtime_instance_ref   TEXT NOT NULL,
  session_ref            TEXT NOT NULL,
  territory_id           TEXT NOT NULL,
  task_id                TEXT NOT NULL,
  attempt_no             INTEGER NOT NULL,
  state                  TEXT NOT NULL CHECK(state IN
    ('ACQUIRED','PREPARING','MATERIALIZING','DISPATCH_READY',
     'EXECUTING','SETTLING','RELEASING','RECOVERING','RELEASED')),
  capability_decision_id TEXT,
  enforcement_plan_snapshot TEXT,
  release_evidence_json  TEXT,
  release_reason         TEXT,
  acquired_at            TEXT NOT NULL,
  released_at            TEXT,
  updated_at             TEXT NOT NULL,
  UNIQUE (task_id, attempt_no),
  UNIQUE (runtime_type, runtime_instance_ref, session_ref, task_id, attempt_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS lease_one_active_per_session
  ON execution_leases(runtime_type, runtime_instance_ref, session_ref)
  WHERE state <> 'RELEASED';
CREATE TRIGGER IF NOT EXISTS lease_requires_matching_affinity
BEFORE INSERT ON execution_leases
BEGIN
  SELECT RAISE(ABORT, 'LEASE_REQUIRES_MATCHING_CURRENT_AFFINITY')
  WHERE NOT EXISTS (
    SELECT 1
    FROM session_territory_affinities a
    JOIN tasks t ON t.task_id = NEW.task_id
    WHERE a.kingdom_id = NEW.kingdom_id
      AND a.worker_binding_id = NEW.worker_binding_id
      AND a.runtime_type = NEW.runtime_type
      AND a.runtime_instance_ref = NEW.runtime_instance_ref
      AND a.session_ref = NEW.session_ref
      AND a.is_current = 1 AND a.retired_at IS NULL
      AND a.territory_id = NEW.territory_id
      AND t.territory_id = NEW.territory_id
  );
END;
CREATE TRIGGER IF NOT EXISTS lease_identity_immutable
BEFORE UPDATE OF kingdom_id, worker_binding_id, runtime_type, runtime_instance_ref,
                 session_ref, territory_id, task_id, attempt_no, acquired_at
ON execution_leases
BEGIN SELECT RAISE(ABORT, 'LEASE_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS lease_plan_once
BEFORE UPDATE OF enforcement_plan_snapshot
ON execution_leases
WHEN OLD.enforcement_plan_snapshot IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'LEASE_PLAN_ALREADY_SET'); END;
CREATE TRIGGER IF NOT EXISTS lease_decision_once
BEFORE UPDATE OF capability_decision_id
ON execution_leases
WHEN OLD.capability_decision_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'LEASE_DECISION_ALREADY_BOUND'); END;
CREATE TRIGGER IF NOT EXISTS lease_release_evidence_once
BEFORE UPDATE OF release_evidence_json, release_reason
ON execution_leases
WHEN OLD.release_evidence_json IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'LEASE_RELEASE_EVIDENCE_ALREADY_SET'); END;
CREATE TRIGGER IF NOT EXISTS lease_state_guard
BEFORE UPDATE OF state ON execution_leases
WHEN NEW.state <> OLD.state
BEGIN
  SELECT RAISE(ABORT, 'ILLEGAL_LEASE_TRANSITION') WHERE NOT (
    (OLD.state='ACQUIRED' AND NEW.state IN ('PREPARING','RECOVERING'))
    OR (OLD.state='PREPARING' AND NEW.state IN ('MATERIALIZING','RECOVERING'))
    OR (OLD.state='MATERIALIZING' AND NEW.state IN ('DISPATCH_READY','RECOVERING','RELEASED'))
    OR (OLD.state='DISPATCH_READY' AND NEW.state IN ('EXECUTING','RECOVERING'))
    OR (OLD.state='EXECUTING' AND NEW.state IN ('SETTLING','RECOVERING'))
    OR (OLD.state='SETTLING' AND NEW.state IN ('RELEASING','RECOVERING'))
    OR (OLD.state='RELEASING' AND NEW.state IN ('RELEASED','RECOVERING'))
    OR (OLD.state='RECOVERING' AND NEW.state IN ('RELEASED','RECOVERING'))
  );
  SELECT RAISE(ABORT, 'LEASE_MATERIALIZING_REQUIRES_PLAN')
  WHERE NEW.state='MATERIALIZING' AND (NEW.enforcement_plan_snapshot IS NULL OR json_valid(NEW.enforcement_plan_snapshot)=0);
  SELECT RAISE(ABORT, 'LEASE_DISPATCH_READY_REQUIRES_DECISION')
  WHERE NEW.state='DISPATCH_READY' AND NOT EXISTS (
    SELECT 1 FROM capability_decisions d
    WHERE d.decision_id = NEW.capability_decision_id
      AND d.decision='GRANTED' AND d.enforcement_status='ENFORCED'
      AND d.enforcement_evidence_json IS NOT NULL
  );
  SELECT RAISE(ABORT, 'LEASE_RELEASED_REQUIRES_EVIDENCE')
  WHERE NEW.state='RELEASED' AND (NEW.release_evidence_json IS NULL OR NEW.released_at IS NULL);
END;
CREATE TRIGGER IF NOT EXISTS lease_insert_state_guard
BEFORE INSERT ON execution_leases
WHEN NEW.state <> 'ACQUIRED'
BEGIN SELECT RAISE(ABORT, 'LEASE_INSERT_MUST_BE_ACQUIRED'); END;
CREATE TRIGGER IF NOT EXISTS lease_no_delete
BEFORE DELETE ON execution_leases
BEGIN SELECT RAISE(ABORT, 'LEASE_NO_DELETE'); END;

CREATE TABLE IF NOT EXISTS capability_decisions (
  decision_id              TEXT PRIMARY KEY,
  kingdom_id               TEXT NOT NULL,
  task_id                  TEXT NOT NULL,
  worker_binding_id        TEXT,
  supervisor_binding_id    TEXT,
  requirement_snapshot     TEXT,
  ceiling_snapshot         TEXT,
  proposed_grant_snapshot  TEXT,
  scope_snapshot           TEXT,
  effective_snapshot       TEXT,
  decision                 TEXT NOT NULL,
  enforcement_status       TEXT NOT NULL,
  enforcement_evidence_json TEXT,
  requirement_coverage     TEXT NOT NULL DEFAULT 'NONE'
                            CHECK(requirement_coverage IN ('FULL','PARTIAL','NONE')),
  reason_code              TEXT,
  execution_id             TEXT,
  created_at               TEXT NOT NULL,
  CHECK (
    (decision = 'GRANTED' AND enforcement_status = 'ENFORCED')
    OR
    (decision = 'DENIED' AND enforcement_status IN
       ('NOT_ATTEMPTED','UNAVAILABLE','FAILED'))
  ),
  CHECK (decision <> 'GRANTED' OR
    (enforcement_evidence_json IS NOT NULL AND json_valid(enforcement_evidence_json)=1))
);
CREATE UNIQUE INDEX IF NOT EXISTS capability_decision_execution_uk
  ON capability_decisions(execution_id) WHERE execution_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS capability_decision_immutable
BEFORE UPDATE OF kingdom_id, task_id, worker_binding_id, supervisor_binding_id,
                 requirement_snapshot, ceiling_snapshot, proposed_grant_snapshot,
                 scope_snapshot, effective_snapshot, decision, enforcement_status,
                 enforcement_evidence_json, requirement_coverage, reason_code, created_at
ON capability_decisions
BEGIN SELECT RAISE(ABORT, 'CAPABILITY_DECISION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS capability_decision_execution_bind
BEFORE UPDATE OF execution_id
ON capability_decisions
WHEN NEW.execution_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'CAPABILITY_DECISION_EXECUTION_ALREADY_BOUND')
  WHERE OLD.execution_id IS NOT NULL;
  SELECT RAISE(ABORT, 'CAPABILITY_DECISION_BIND_REQUIRES_GRANTED')
  WHERE NOT (OLD.decision='GRANTED' AND OLD.enforcement_status='ENFORCED');
END;
CREATE TRIGGER IF NOT EXISTS capability_decision_no_delete
BEFORE DELETE ON capability_decisions
BEGIN SELECT RAISE(ABORT, 'CAPABILITY_DECISION_NO_DELETE'); END;
`

  /**
   * executions 重建形态（暂存名 executions_v4，迁移后 RENAME 回 executions）。
   * = 旧 executions 全部列（含 v2 证据列）+ 新增 3 列（v6 §8.1）。
   */
  static readonly V4_EXECUTIONS_STAGING_SQL = `
CREATE TABLE IF NOT EXISTS executions_v4 (
  execution_id       TEXT PRIMARY KEY,
  task_id            TEXT NOT NULL,
  attempt_no         INTEGER NOT NULL,
  worker_binding_id  TEXT,
  session_id         TEXT,
  state              TEXT NOT NULL CHECK(state IN
    ('STARTING','RUNNING','PAUSED','RECOVERING','COMPLETED','FAILED','ABORTED')),
  detail             TEXT,
  started_at         TEXT NOT NULL,
  heartbeat_at       TEXT,
  ended_at           TEXT,
  pause_requested_at TEXT,
  executor_kind      TEXT,
  provider           TEXT,
  provider_source    TEXT,
  requested_model    TEXT,
  resolved_model     TEXT,
  model_source       TEXT,
  execution_profile_json TEXT,
  execution_contract TEXT NOT NULL DEFAULT 'LEGACY_COMPAT'
                       CHECK(execution_contract IN ('LEGACY_COMPAT','GOVERNED_PERSISTENT')),
  lease_id           TEXT,
  capability_decision_id TEXT,
  UNIQUE (task_id, attempt_no),
  CHECK (
    execution_contract = 'LEGACY_COMPAT'
    OR (
      execution_contract = 'GOVERNED_PERSISTENT'
      AND lease_id IS NOT NULL
      AND capability_decision_id IS NOT NULL
    )
  ),
  FOREIGN KEY (lease_id) REFERENCES execution_leases(lease_id),
  FOREIGN KEY (capability_decision_id) REFERENCES capability_decisions(decision_id)
);
`

  /** executions 重建后的 trigger（RENAME 回 executions 之后创建；不依赖 RENAME 自动改写）。 */
  static readonly V4_EXECUTIONS_TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS execution_governed_consistency
BEFORE INSERT ON executions
WHEN NEW.execution_contract = 'GOVERNED_PERSISTENT'
BEGIN
  SELECT RAISE(ABORT, 'EXECUTION_GOVERNED_REQUIRES_MATCHING_LEASE')
  WHERE NOT EXISTS (
    SELECT 1
    FROM execution_leases l
    JOIN capability_decisions d ON d.decision_id = NEW.capability_decision_id
    WHERE l.lease_id = NEW.lease_id
      AND l.task_id = NEW.task_id
      AND l.attempt_no = NEW.attempt_no
      AND l.capability_decision_id = NEW.capability_decision_id
      AND l.kingdom_id = d.kingdom_id
      AND d.task_id = NEW.task_id
      AND d.decision='GRANTED' AND d.enforcement_status='ENFORCED'
      AND (d.execution_id IS NULL OR d.execution_id = NEW.execution_id)
  );
END;
CREATE TRIGGER IF NOT EXISTS execution_contract_immutable
BEFORE UPDATE OF execution_contract ON executions
BEGIN SELECT RAISE(ABORT, 'EXECUTION_CONTRACT_IMMUTABLE'); END;
`

  /** Dispatch Ledger（executions 重建完成后创建；FK 直接指向最终名 executions）。 */
  static readonly V4_DISPATCH_SQL = `
CREATE TABLE IF NOT EXISTS dispatch_records (
  dispatch_id          TEXT PRIMARY KEY,
  kingdom_id           TEXT NOT NULL,
  lease_id             TEXT NOT NULL,
  execution_id         TEXT NOT NULL,
  task_id              TEXT NOT NULL,
  attempt_no           INTEGER NOT NULL,
  runtime_type         TEXT NOT NULL,
  runtime_instance_ref TEXT NOT NULL,
  session_ref          TEXT NOT NULL,
  state                TEXT NOT NULL CHECK(state IN
    ('INTENDED','DISPATCHED','RECEIVED','CORRELATED','TERMINAL','FAILED','RECOVERING')),
  dispatch_request_snapshot TEXT NOT NULL,
  dispatch_input_ref_json  TEXT NOT NULL,
  dispatch_payload_hash    TEXT NOT NULL,
  runtime_dispatch_ref  TEXT,
  runtime_execution_ref TEXT,
  receipt_json          TEXT,
  terminal_evidence_json TEXT,
  output_ref_json       TEXT,
  dispatched_at         TEXT,
  receipt_at            TEXT,
  terminal_at           TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  FOREIGN KEY (lease_id) REFERENCES execution_leases(lease_id),
  FOREIGN KEY (execution_id) REFERENCES executions(execution_id),
  UNIQUE (lease_id),
  UNIQUE (execution_id)
);
CREATE TRIGGER IF NOT EXISTS dispatch_request_immutable
BEFORE UPDATE OF dispatch_id, kingdom_id, lease_id, execution_id, task_id, attempt_no,
                 runtime_type, runtime_instance_ref, session_ref,
                 dispatch_request_snapshot, dispatch_input_ref_json, dispatch_payload_hash,
                 created_at
ON dispatch_records
BEGIN SELECT RAISE(ABORT, 'DISPATCH_REQUEST_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS dispatch_requires_ready_lease
BEFORE INSERT ON dispatch_records
BEGIN
  SELECT RAISE(ABORT, 'DISPATCH_REQUIRES_MATCHING_READY_LEASE')
  WHERE NOT EXISTS (
    SELECT 1
    FROM execution_leases l
    JOIN executions e ON e.execution_id = NEW.execution_id
    WHERE l.lease_id = NEW.lease_id
      AND l.state = 'DISPATCH_READY'
      AND l.kingdom_id = NEW.kingdom_id
      AND l.task_id = NEW.task_id
      AND l.attempt_no = NEW.attempt_no
      AND l.runtime_type = NEW.runtime_type
      AND l.runtime_instance_ref = NEW.runtime_instance_ref
      AND l.session_ref = NEW.session_ref
      AND e.task_id = NEW.task_id
      AND e.attempt_no = NEW.attempt_no
  );
END;
CREATE TRIGGER IF NOT EXISTS dispatch_state_guard
BEFORE UPDATE OF state ON dispatch_records
WHEN NEW.state <> OLD.state
BEGIN
  SELECT RAISE(ABORT, 'ILLEGAL_DISPATCH_TRANSITION') WHERE NOT (
    (OLD.state='INTENDED' AND NEW.state IN ('DISPATCHED','FAILED','RECOVERING'))
    OR (OLD.state='DISPATCHED' AND NEW.state IN ('RECEIVED','RECOVERING'))
    OR (OLD.state='RECEIVED' AND NEW.state IN ('CORRELATED','RECOVERING'))
    OR (OLD.state='CORRELATED' AND NEW.state IN ('TERMINAL','RECOVERING'))
    OR (OLD.state='RECOVERING' AND NEW.state IN ('TERMINAL','FAILED','RECOVERING'))
  );
  SELECT RAISE(ABORT, 'DISPATCH_RECEIVED_REQUIRES_REF_RECEIPT')
  WHERE NEW.state='RECEIVED' AND (NEW.runtime_dispatch_ref IS NULL OR NEW.receipt_json IS NULL OR NEW.receipt_at IS NULL);
  SELECT RAISE(ABORT, 'DISPATCH_CORRELATED_REQUIRES_EXEC_REF')
  WHERE NEW.state='CORRELATED' AND NEW.runtime_execution_ref IS NULL;
  SELECT RAISE(ABORT, 'DISPATCH_TERMINAL_REQUIRES_EVIDENCE')
  WHERE NEW.state='TERMINAL' AND (NEW.terminal_evidence_json IS NULL OR NEW.terminal_at IS NULL);
END;
CREATE TRIGGER IF NOT EXISTS dispatch_insert_state_guard
BEFORE INSERT ON dispatch_records
WHEN NEW.state <> 'INTENDED'
BEGIN SELECT RAISE(ABORT, 'DISPATCH_INSERT_MUST_BE_INTENDED'); END;
CREATE TRIGGER IF NOT EXISTS dispatch_no_delete
BEFORE DELETE ON dispatch_records
BEGIN SELECT RAISE(ABORT, 'DISPATCH_NO_DELETE'); END;
`

  /** v4 对象是否已存在（execution_leases 表是 v4 迁移完成的地标）。 */
  private hasV4Objects(): boolean {
    return this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_leases'`).get() !== undefined
  }

  /**
   * v0.8（M3-S2 v6）：Schema v4 迁移（单事务、可回滚、幂等 gate 于 schema_version>=4）。
   *
   * 顺序（v6 §14 + 本文件头迁移纪律）：
   * 1. gate：schema_version >= 4 **或 v4 对象已存在**（空王国库 schema_version 可能为 0）→ 已迁移，直接返回；
   * 2. BEGIN IMMEDIATE：
   *    a. ADD COLUMN tasks.capability_requirement_json / kingdoms.capability_ceiling_json；
   *    b. 四 Ledger 中三张（affinity/lease/decision）+ 索引 + trigger；
   *    c. 建 executions_v4 暂存表（旧列 + 3 新列 + FK）→ 全量复制 + LEGACY_COMPAT backfill
   *       → 校验行数一致（不一致即抛，整单回滚）；
   *    d. DROP 旧 executions → RENAME executions_v4 → executions → 重建索引；
   *    e. executions trigger（governed consistency / contract immutable）；
   *    f. dispatch_records + trigger（FK 直接指向最终名 executions）；
   *    g. UPDATE kingdoms.schema_version = 4；
   * 3. 终验（事务内 fail-loud）：sqlite_master 精确对象集、PRAGMA foreign_key_check 为空、
   *    PRAGMA integrity_check = ok；
   * 4. COMMIT；任一步失败 ROLLBACK，库保持完整 v3 语义。
   */
  private ensureSchemaV4(): void {
    if (this.readSchemaVersion() >= 4 || this.hasV4Objects()) return

    this.db.exec('BEGIN IMMEDIATE')
    try {
      // a. tasks / kingdoms 增量列（ADD COLUMN 无 IF NOT EXISTS，用 PRAGMA table_info gate）
      const tableColumns = (table: string): Set<string> => new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map(c => c.name),
      )
      if (!tableColumns('tasks').has('capability_requirement_json')) {
        this.db.exec('ALTER TABLE tasks ADD COLUMN capability_requirement_json TEXT')
      }
      if (!tableColumns('kingdoms').has('capability_ceiling_json')) {
        this.db.exec('ALTER TABLE kingdoms ADD COLUMN capability_ceiling_json TEXT')
      }

      // b. affinity / lease / decision Ledger（含索引与 trigger）
      this.db.exec(KingdomStore.V4_LEDGER_SQL)

      // c. executions 重建：暂存表 → 复制（LEGACY_COMPAT backfill）→ 行数校验
      this.db.exec(KingdomStore.V4_EXECUTIONS_STAGING_SQL)
      this.db.exec(`
        INSERT INTO executions_v4
          (execution_id, task_id, attempt_no, worker_binding_id, session_id, state,
           detail, started_at, heartbeat_at, ended_at, pause_requested_at,
           executor_kind, provider, provider_source, requested_model, resolved_model,
           model_source, execution_profile_json,
           execution_contract, lease_id, capability_decision_id)
        SELECT
           execution_id, task_id, attempt_no, worker_binding_id, session_id, state,
           detail, started_at, heartbeat_at, ended_at, pause_requested_at,
           executor_kind, provider, provider_source, requested_model, resolved_model,
           model_source, execution_profile_json,
           'LEGACY_COMPAT', NULL, NULL
        FROM executions
      `)
      const oldCount = this.db.prepare('SELECT COUNT(*) AS n FROM executions').get() as unknown as { n: number }
      const newCount = this.db.prepare('SELECT COUNT(*) AS n FROM executions_v4').get() as unknown as { n: number }
      if (oldCount.n !== newCount.n) {
        throw new Error(`Schema v4 migration failed: executions row count mismatch (old=${oldCount.n}, new=${newCount.n})`)
      }

      // d. 换表：删旧 → 暂存表 RENAME 回 executions → 重建索引
      this.db.exec('DROP TABLE executions')
      this.db.exec('ALTER TABLE executions_v4 RENAME TO executions')
      this.db.exec('CREATE INDEX IF NOT EXISTS executions_task_idx ON executions(task_id)')

      // e. executions trigger（改名后创建，不依赖 RENAME 自动改写）
      this.db.exec(KingdomStore.V4_EXECUTIONS_TRIGGERS_SQL)

      // f. dispatch_records + trigger（FK 直接指向最终名 executions）
      this.db.exec(KingdomStore.V4_DISPATCH_SQL)

      // g. schema_version = 4
      this.db.prepare('UPDATE kingdoms SET schema_version = ?').run(4)

      // 终验（事务内 fail-loud）
      this.verifyV4Objects()
      const fk = this.db.prepare('PRAGMA foreign_key_check').all() as unknown as unknown[]
      if (fk.length > 0) {
        throw new Error(`Schema v4 migration failed: foreign_key_check found ${fk.length} violation(s)`)
      }
      const integrity = this.db.prepare('PRAGMA integrity_check').get() as unknown as { integrity_check: string }
      if (integrity.integrity_check !== 'ok') {
        throw new Error(`Schema v4 migration failed: integrity_check = ${integrity.integrity_check}`)
      }

      this.db.exec('COMMIT')
    } catch (error: unknown) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** v4 迁移终验：sqlite_master 精确对象集（表/索引/trigger 全在、无多余 v4 对象缺失）。 */
  private verifyV4Objects(): void {
    const rows = this.db.prepare(
      `SELECT name, type FROM sqlite_master WHERE type IN ('table','index','trigger')`,
    ).all() as unknown as { name: string; type: string }[]
    const names = new Set(rows.map(r => r.name))
    const requiredTables = [
      'session_territory_affinities', 'execution_leases', 'capability_decisions', 'dispatch_records', 'executions',
    ]
    const requiredIndexes = [
      'affinity_one_current_per_worker', 'lease_one_active_per_session',
      'capability_decision_execution_uk', 'executions_task_idx',
    ]
    const requiredTriggers = [
      'affinity_identity_immutable', 'affinity_retire', 'affinity_no_delete',
      'lease_requires_matching_affinity', 'lease_identity_immutable', 'lease_plan_once',
      'lease_decision_once', 'lease_release_evidence_once', 'lease_state_guard',
      'lease_insert_state_guard', 'lease_no_delete',
      'capability_decision_immutable', 'capability_decision_execution_bind', 'capability_decision_no_delete',
      'execution_governed_consistency', 'execution_contract_immutable',
      'dispatch_request_immutable', 'dispatch_requires_ready_lease', 'dispatch_state_guard',
      'dispatch_insert_state_guard', 'dispatch_no_delete',
    ]
    for (const name of [...requiredTables, ...requiredIndexes, ...requiredTriggers]) {
      if (!names.has(name)) throw new Error(`Schema v4 migration failed: expected object missing: ${name}`)
    }
    // executions 必须是 v4 形态（含新列）
    const execColumns = new Set(
      (this.db.prepare('PRAGMA table_info(executions)').all() as unknown as { name: string }[]).map(c => c.name),
    )
    for (const column of ['execution_contract', 'lease_id', 'capability_decision_id', 'executor_kind']) {
      if (!execColumns.has(column)) throw new Error(`Schema v4 migration failed: executions.${column} missing`)
    }
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
      .prepare(`SELECT * FROM territories WHERE kingdom_id = ? AND status != 'DELETED' ORDER BY created_at`)
      .all(kingdomId) as unknown as TerritoryRow[]
  }

  getTerritoryByName(kingdomId: string, name: string): TerritoryRow | null {
    const rows = this.db
      .prepare(`SELECT * FROM territories WHERE kingdom_id = ? AND name = ? AND status != 'DELETED'`)
      .all(kingdomId, name) as unknown as TerritoryRow[]
    return rows[0] ?? null
  }

  /** 任意状态取领地（历史解析；含 DELETED tombstone）。 */
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

  /** v0.5.1：删除领地行。治理守卫（任务存在时拒绝/级联）由上层 territory.ts 负责。 */
  deleteTerritoryRow(territoryId: string): void {
    this.db.prepare('DELETE FROM territories WHERE territory_id = ?').run(territoryId)
  }

  /**
   * v0.7.0（M2）：Territory tombstone——ACTIVE → DELETED（不物理删行），
   * 历史任务/Assignment/Event 的 territory_id 永远可解析。
   */
  tombstoneTerritoryRow(territoryId: string, reason: string | null): void {
    const now = new Date().toISOString()
    this.db
      .prepare(`UPDATE territories SET status = 'DELETED', deleted_at = ?, deleted_reason = ? WHERE territory_id = ?`)
      .run(now, reason ?? null, territoryId)
  }

  /** v0.7.0（M2）：设置 Territory 主理 Supervisor（scope relation；NULL=未指派=fail-closed）。 */
  updateTerritorySupervisor(territoryId: string, supervisorBindingId: string | null): void {
    this.db.prepare('UPDATE territories SET supervisor_binding_id = ? WHERE territory_id = ?').run(supervisorBindingId, territoryId)
  }

  // ── task_assignments（v0.7.0 M2-B Assignment Ledger）──────────

  insertTaskAssignment(row: TaskAssignmentRow): TaskAssignmentRow {
    this.db
      .prepare(
        `INSERT INTO task_assignments
           (assignment_id, task_id, territory_id, worker_binding_id, assigned_by, assigned_at,
            ended_at, end_reason, previous_assignment_id, handoff_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.assignment_id, row.task_id, row.territory_id, row.worker_binding_id, row.assigned_by, row.assigned_at,
        row.ended_at, row.end_reason, row.previous_assignment_id, row.handoff_reason, row.created_at,
      )
    return row
  }

  /** 当前 active assignment（partial unique index 保证至多一条）。 */
  getActiveAssignmentForTask(taskId: string): TaskAssignmentRow | null {
    const rows = this.db
      .prepare(`SELECT * FROM task_assignments WHERE task_id = ? AND ended_at IS NULL LIMIT 1`)
      .all(taskId) as unknown as TaskAssignmentRow[]
    return rows[0] ?? null
  }

  /** 关闭当前 active assignment（handoff / task-terminal）。 */
  closeActiveAssignment(taskId: string, endReason: string): TaskAssignmentRow | null {
    const active = this.getActiveAssignmentForTask(taskId)
    if (!active) return null
    const now = new Date().toISOString()
    this.db
      .prepare(`UPDATE task_assignments SET ended_at = ?, end_reason = ? WHERE assignment_id = ?`)
      .run(now, endReason, active.assignment_id)
    return { ...active, ended_at: now, end_reason: endReason }
  }

  /** 按任务列出派遣历史（升序）。 */
  listTaskAssignments(taskId: string): TaskAssignmentRow[] {
    return this.db
      .prepare(`SELECT * FROM task_assignments WHERE task_id = ? ORDER BY created_at`)
      .all(taskId) as unknown as TaskAssignmentRow[]
  }

  // ── role_bindings ───────────────────────────────────────────

  listBindings(kingdomId: string): RoleBindingRow[] {
    return this.db
      .prepare('SELECT * FROM role_bindings WHERE kingdom_id = ? ORDER BY created_at')
      .all(kingdomId) as unknown as RoleBindingRow[]
  }

  getBindingByRole(kingdomId: string, roleType: string): RoleBindingRow | null {
    const rows = this.db
      .prepare(`SELECT * FROM role_bindings WHERE kingdom_id = ? AND role_type = ? AND status = 'ACTIVE'`)
      .all(kingdomId, roleType) as unknown as RoleBindingRow[]
    return rows[0] ?? null
  }

  /**
   * v0.7.0（M2）：按角色列出 **ACTIVE** 绑定（多 Worker/多 Supervisor）。
   * Singleton（OWNER/CHANCELLOR）是 Domain Policy，本 API 不再隐含假设。
   */
  getBindingsByRole(kingdomId: string, roleType: string): RoleBindingRow[] {
    return this.db
      .prepare(`SELECT * FROM role_bindings WHERE kingdom_id = ? AND role_type = ? AND status = 'ACTIVE' ORDER BY created_at`)
      .all(kingdomId, roleType) as unknown as RoleBindingRow[]
  }

  /**
   * v0.7.0（M2）：Binding tombstone——ACTIVE → RETIRED（历史引用永远可解析）。
   * unbind 语义从物理删除升级为退任。
   */
  retireBinding(bindingId: string, reason: string | null): void {
    const now = new Date().toISOString()
    this.db
      .prepare(`UPDATE role_bindings SET status = 'RETIRED', retired_at = ?, retired_reason = ?, updated_at = ? WHERE binding_id = ?`)
      .run(now, reason ?? null, now, bindingId)
  }

  /** 按 id 取绑定（**任意状态**——历史解析用；ACTIVE 过滤由调用方语义决定）。 */
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
           (binding_id, kingdom_id, role_type, role_name, runtime_type,
            session_id, model_name, agent_name, session_meta, execution_profile_json,
            status, retired_at, retired_reason, principal_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.binding_id,
        row.kingdom_id,
        row.role_type,
        row.role_name,
        row.runtime_type,
        row.session_id,
        row.model_name ?? null,
        row.agent_name ?? null,
        row.session_meta ?? null,
        row.execution_profile_json ?? null,
        row.status ?? 'ACTIVE',
        row.retired_at ?? null,
        row.retired_reason ?? null,
        row.principal_id,
        row.created_at,
        row.updated_at,
      )
    return row
  }

  /**
   * v0.4：更新一条绑定的会话身份（session_id + 预留字段）。
   *
   * 语义：`undefined` = 保持不变；`null` = 显式清空；字符串 = 覆盖。
   * 这是「角色真正属于某个独立会话」的写入通道（Phase 2 设计意图的落地）。
   */
  updateBindingProfile(
    bindingId: string,
    patch: {
      sessionId?: string | null
      modelName?: string | null
      agentName?: string | null
      sessionMeta?: string | null
    },
    updatedAt: string,
  ): void {
    const sets: string[] = []
    const params: (string | null)[] = []
    const put = (column: string, key: 'sessionId' | 'modelName' | 'agentName' | 'sessionMeta'): void => {
      if (patch[key] === undefined) return
      sets.push(`${column} = ?`)
      params.push(patch[key] ?? null)
    }
    put('session_id', 'sessionId')
    put('model_name', 'modelName')
    put('agent_name', 'agentName')
    put('session_meta', 'sessionMeta')
    if (sets.length === 0) return
    sets.push('updated_at = ?')
    params.push(updatedAt, bindingId)
    this.db
      .prepare(`UPDATE role_bindings SET ${sets.join(', ')} WHERE binding_id = ?`)
      .run(...params)
  }

  /** 兼容旧调用面：仅换 session（委托给 updateBindingProfile）。 */
  updateBindingSession(bindingId: string, sessionId: string | null, updatedAt: string): void {
    this.updateBindingProfile(bindingId, { sessionId }, updatedAt)
  }

  /** v0.6.0（M1-C）：执行配置（execution_profile_json）独立写入通道。 */
  setExecutionProfileJson(bindingId: string, json: string | null): void {
    this.db.prepare('UPDATE role_bindings SET execution_profile_json = ? WHERE binding_id = ?').run(json, bindingId)
  }

  /** v0.4：解绑（换届通道）。治理上由调用方决定谁可解绑；OWNER 由上层保护。 */
  deleteBinding(bindingId: string): void {
    this.db.prepare('DELETE FROM role_bindings WHERE binding_id = ?').run(bindingId)
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
   * Exact Dispatch lookup for one Task attempt.
   *
   * Integrity decisions must not scan a bounded event projection: the
   * dispatch/task/attempt relation is authoritative in dispatch_records.
   */
  listDispatchesForTaskAttempt(taskId: string, attemptNo: number): DispatchRecordRow[] {
    return this.db
      .prepare(
        `SELECT * FROM dispatch_records
           WHERE task_id = ? AND attempt_no = ?
           ORDER BY created_at ASC`,
      )
      .all(taskId, attemptNo) as unknown as DispatchRecordRow[]
  }

  /**
   * Exact, replay-safe lookup for an open terminal integrity incident.
   * The SQL predicate narrows by the exact Dispatch target; the bounded JSON
   * payload is then checked against the exact Task/attempt correlation.
   */
  getOpenDispatchTerminalIntegrityIncident(
    kingdomId: string,
    dispatchId: string,
    taskId: string,
    attemptNo: number,
  ): EventRow | null {
    // The Dispatch row is authoritative for the Task/attempt relation.  Do
    // not accept an event merely because its target_id happens to match a
    // caller-supplied string.
    const dispatch = this.getDispatch(dispatchId)
    if (
      !dispatch
      || dispatch.kingdom_id !== kingdomId
      || dispatch.task_id !== taskId
      || dispatch.attempt_no !== attemptNo
    ) return null
    const rows = this.db
      .prepare(
        `SELECT * FROM events
           WHERE kingdom_id = ?
             AND event_type = 'DISPATCH_TERMINAL_INTEGRITY_INCIDENT'
             AND target_type = 'dispatch'
             AND target_id = ?
           ORDER BY seq ASC`,
      )
      .all(kingdomId, dispatchId) as unknown as EventRow[]
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload_json) as {
          incident_code?: unknown
          state?: unknown
          attempt_no?: unknown
        }
        if (
          payload.incident_code === 'DISPATCH_TERMINAL_INTEGRITY_INCIDENT'
          && payload.state === 'OPEN'
          && payload.attempt_no === attemptNo
        ) {
          return row
        }
      } catch {
        // A malformed incident payload is not trusted as a matching incident.
      }
    }
    return null
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
   * v0.7.0（M2）：外层事务包装——HANDOFF 等**原子治理操作**（多步写 + 事件）整体提交/回滚。
   * appendEvent 的内层 BEGIN 在事务中会抛错，由 appendEvent 的嵌套容忍逻辑接管（见下）。
   */
  withImmediateTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error: unknown) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * 追加事件并分配单调 seq。
   *
   * 「读 MAX(seq) + INSERT」放在 IMMEDIATE 事务里，避免并发写出重复序号
   * （SQLite 会串行化写事务）。序号在**全库**范围内单调，跨王国也不会回退。
   *
   * v0.7.0（M2）：支持嵌套——已在 withImmediateTransaction 外层事务中时，
   * BEGIN/COMMIT 自动跳过（外层统一提交/回滚），保证 HANDOFF 等原子操作不半写。
   */
  appendEvent(row: Omit<EventRow, 'seq'> & { seq?: number }): EventRow {
    let outer = false
    try {
      this.db.exec('BEGIN IMMEDIATE')
    } catch {
      outer = true // 已在外层事务中（withImmediateTransaction）
    }
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
      if (!outer) this.db.exec('COMMIT')
      return { ...row, seq }
    } catch (error: unknown) {
      if (!outer) this.db.exec('ROLLBACK')
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
    const hasRequirementColumn = (this.db
      .prepare('PRAGMA table_info(tasks)')
      .all() as unknown as { name: string }[])
      .some(column => column.name === 'capability_requirement_json')
    if (!hasRequirementColumn && row.capability_requirement_json != null) {
      throw new Error('TASK_CAPABILITY_REQUIREMENT_UNAVAILABLE: Schema v4 未迁移，拒绝丢弃 Task requirement')
    }
    const columns = hasRequirementColumn ? ', capability_requirement_json' : ''
    const values = hasRequirementColumn ? ', ?' : ''
    this.db
      .prepare(
        `INSERT INTO tasks
           (task_id, territory_id, parent_task_id, title, description, assigned_binding_id,
             status, acceptance_criteria, result_summary, created_at, updated_at${columns})
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${values})`,
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
        ...(hasRequirementColumn ? [row.capability_requirement_json ?? null] : []),
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

  /**
   * executions 侧的最大 attempt_no。
   *
   * **不能只看 worker_results 来编下一个 attempt 号**：executor 客观失败、
   * 被 abort、以及重载后被回收的僵尸执行都只有 Execution 行、没有 Claim 行。
   * 只按 Claim 计数会重复发号，撞上 `UNIQUE(task_id, attempt_no)`。
   * 下一次尝试号必须取两者的最大值再 +1（见 nextAttemptNo）。
   */
  maxExecutionAttemptNo(taskId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(attempt_no), 0) AS n FROM executions WHERE task_id = ?')
      .get(taskId) as unknown as { n: number } | undefined
    return row?.n ?? 0
  }

  /** 下一次执行应使用的 attempt 号：Claim 与 Execution 两侧取大再 +1。 */
  nextAttemptNo(taskId: string): number {
    return Math.max(this.maxAttemptNo(taskId), this.maxExecutionAttemptNo(taskId)) + 1
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
            started_at, heartbeat_at, ended_at, pause_requested_at,
            executor_kind, provider, provider_source, requested_model, resolved_model, model_source,
            execution_profile_json, execution_contract, lease_id, capability_decision_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        row.executor_kind,
        row.provider,
        row.provider_source,
        row.requested_model,
        row.resolved_model,
        row.model_source,
        row.execution_profile_json,
        row.execution_contract ?? 'LEGACY_COMPAT',
        row.lease_id ?? null,
        row.capability_decision_id ?? null,
      )
    return row
  }

  /**
   * v0.6.0（M1-C）：结算时**一次性**补执行证据（resolved_model + 快照 resolved 节）。
   *
   * 证据列是不可变快照：start 时写 requested/source，此处只补 resolved——代码上
   * 全库唯一 UPDATE 证据列的位置，之后不再改写（transitionExecution 不触碰证据列）。
   */
  updateExecutionResolvedEvidence(
    executionId: string,
    resolvedModel: string | null,
    profileJson: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE executions SET resolved_model = ?, execution_profile_json = ? WHERE execution_id = ?`,
      )
      .run(resolvedModel, profileJson, executionId)
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

  /** 登记暂停请求（不改状态；生效点见 ExecutionRow.pause_requested_at 注释）。 */
  setExecutionPauseRequest(executionId: string, at: string | null): void {
    this.db
      .prepare('UPDATE executions SET pause_requested_at = ? WHERE execution_id = ?')
      .run(at, executionId)
  }

  // ── v0.8 Runtime Governance Ledgers（M3-S2 v6；约束由 DB trigger 权威执行）────

  // session_territory_affinities ────────────────────────────────

  insertAffinity(row: AffinityRow): AffinityRow {
    this.db
      .prepare(
        `INSERT INTO session_territory_affinities
           (affinity_id, kingdom_id, worker_binding_id, runtime_type, runtime_instance_ref,
            session_ref, territory_id, established_at, retired_at, is_current, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.affinity_id, row.kingdom_id, row.worker_binding_id, row.runtime_type,
        row.runtime_instance_ref, row.session_ref, row.territory_id, row.established_at,
        row.retired_at ?? null, row.is_current ?? 1, row.created_at,
      )
    return row
  }

  getAffinity(affinityId: string): AffinityRow | null {
    const rows = this.db.prepare('SELECT * FROM session_territory_affinities WHERE affinity_id = ?').all(affinityId) as unknown as AffinityRow[]
    return rows[0] ?? null
  }

  getAffinityBySession(session: { runtimeType: string; runtimeInstanceRef: string; sessionRef: string }): AffinityRow | null {
    const rows = this.db
      .prepare(`SELECT * FROM session_territory_affinities
                 WHERE runtime_type = ? AND runtime_instance_ref = ? AND session_ref = ?`)
      .all(session.runtimeType, session.runtimeInstanceRef, session.sessionRef) as unknown as AffinityRow[]
    return rows[0] ?? null
  }

  listAffinities(kingdomId: string): AffinityRow[] {
    return this.db
      .prepare('SELECT * FROM session_territory_affinities WHERE kingdom_id = ? ORDER BY created_at')
      .all(kingdomId) as unknown as AffinityRow[]
  }

  /** Worker 当前（未退役）Affinity；DB 部分唯一索引保证至多一条。 */
  getCurrentAffinityForWorker(kingdomId: string, workerBindingId: string): AffinityRow | null {
    const rows = this.db
      .prepare(`SELECT * FROM session_territory_affinities
                 WHERE kingdom_id = ? AND worker_binding_id = ? AND is_current = 1 LIMIT 1`)
      .all(kingdomId, workerBindingId) as unknown as AffinityRow[]
    return rows[0] ?? null
  }

  /**
   * 退役 affinity（唯一合法联合转换由 affinity_retire trigger 强制）。
   * 仅做数据写；Domain 层负责并发/事务与事件。
   */
  retireAffinityRow(affinityId: string, retiredAt: string): AffinityRow | null {
    this.db
      .prepare(`UPDATE session_territory_affinities SET is_current = 0, retired_at = ? WHERE affinity_id = ?`)
      .run(retiredAt, affinityId)
    return this.getAffinity(affinityId)
  }

  // execution_leases ────────────────────────────────────────────

  insertLease(row: LeaseRow): LeaseRow {
    this.db
      .prepare(
        `INSERT INTO execution_leases
           (lease_id, kingdom_id, worker_binding_id, runtime_type, runtime_instance_ref,
            session_ref, territory_id, task_id, attempt_no, state,
            capability_decision_id, enforcement_plan_snapshot, release_evidence_json, release_reason,
            acquired_at, released_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.lease_id, row.kingdom_id, row.worker_binding_id, row.runtime_type,
        row.runtime_instance_ref, row.session_ref, row.territory_id, row.task_id,
        row.attempt_no, row.state, row.capability_decision_id ?? null,
        row.enforcement_plan_snapshot ?? null, row.release_evidence_json ?? null,
        row.release_reason ?? null, row.acquired_at, row.released_at ?? null, row.updated_at,
      )
    return row
  }

  getLease(leaseId: string): LeaseRow | null {
    const rows = this.db.prepare('SELECT * FROM execution_leases WHERE lease_id = ?').all(leaseId) as unknown as LeaseRow[]
    return rows[0] ?? null
  }

  getLeaseByTaskAttempt(taskId: string, attemptNo: number): LeaseRow | null {
    const rows = this.db
      .prepare('SELECT * FROM execution_leases WHERE task_id = ? AND attempt_no = ?')
      .all(taskId, attemptNo) as unknown as LeaseRow[]
    return rows[0] ?? null
  }

  listLeases(kingdomId: string): LeaseRow[] {
    return this.db
      .prepare('SELECT * FROM execution_leases WHERE kingdom_id = ? ORDER BY acquired_at')
      .all(kingdomId) as unknown as LeaseRow[]
  }

  /** 某 Session 当前未释放的 Lease（部分唯一索引保证至多一条非 RELEASED）。 */
  getActiveLeaseForSession(session: { runtimeType: string; runtimeInstanceRef: string; sessionRef: string }): LeaseRow | null {
    const rows = this.db
      .prepare(`SELECT * FROM execution_leases
                 WHERE runtime_type = ? AND runtime_instance_ref = ? AND session_ref = ? AND state <> 'RELEASED'
                 LIMIT 1`)
      .all(session.runtimeType, session.runtimeInstanceRef, session.sessionRef) as unknown as LeaseRow[]
    return rows[0] ?? null
  }

  /**
   * CAS 推进 Lease 状态：`WHERE lease_id=? AND state=?`（期望旧态）。
   * 0 行更新 = 陈旧态（并发/重复调用）→ 抛 StaleStateError（fail-closed）。
   * 转移合法性由 lease_state_guard trigger 权威执行。
   */
  updateLeaseState(leaseId: string, expectedState: string, nextState: string, extra: {
    plan?: string | null
    decisionId?: string | null
    releaseEvidence?: string | null
    releaseReason?: string | null
    releasedAt?: string | null
  } = {}, at: string): LeaseRow {
    const sets = ['state = ?', 'updated_at = ?']
    const params: (string | number | null)[] = [nextState, at]
    if (extra.plan !== undefined) { sets.push('enforcement_plan_snapshot = ?'); params.push(extra.plan) }
    if (extra.decisionId !== undefined) { sets.push('capability_decision_id = ?'); params.push(extra.decisionId) }
    if (extra.releaseEvidence !== undefined) { sets.push('release_evidence_json = ?'); params.push(extra.releaseEvidence) }
    if (extra.releaseReason !== undefined) { sets.push('release_reason = ?'); params.push(extra.releaseReason) }
    if (extra.releasedAt !== undefined) { sets.push('released_at = ?'); params.push(extra.releasedAt) }
    params.push(leaseId, expectedState)
    const result = this.db
      .prepare(`UPDATE execution_leases SET ${sets.join(', ')} WHERE lease_id = ? AND state = ?`)
      .run(...params)
    if (result.changes !== 1) {
      throw new StaleStateError(`lease ${leaseId}`, expectedState, nextState)
    }
    const updated = this.getLease(leaseId)
    if (!updated) throw new Error(`lease ${leaseId} vanished after CAS update`)
    return updated
  }

  // capability_decisions ────────────────────────────────────────

  insertCapabilityDecision(row: CapabilityDecisionRow): CapabilityDecisionRow {
    this.db
      .prepare(
        `INSERT INTO capability_decisions
           (decision_id, kingdom_id, task_id, worker_binding_id, supervisor_binding_id,
            requirement_snapshot, ceiling_snapshot, proposed_grant_snapshot, scope_snapshot, effective_snapshot,
            decision, enforcement_status, enforcement_evidence_json, requirement_coverage,
            reason_code, execution_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.decision_id, row.kingdom_id, row.task_id, row.worker_binding_id ?? null,
        row.supervisor_binding_id ?? null, row.requirement_snapshot ?? null,
        row.ceiling_snapshot ?? null, row.proposed_grant_snapshot ?? null,
        row.scope_snapshot ?? null, row.effective_snapshot ?? null,
        row.decision, row.enforcement_status, row.enforcement_evidence_json ?? null,
        row.requirement_coverage ?? 'NONE', row.reason_code ?? null, row.execution_id ?? null,
        row.created_at,
      )
    return row
  }

  getCapabilityDecision(decisionId: string): CapabilityDecisionRow | null {
    const rows = this.db.prepare('SELECT * FROM capability_decisions WHERE decision_id = ?').all(decisionId) as unknown as CapabilityDecisionRow[]
    return rows[0] ?? null
  }

  listCapabilityDecisions(kingdomId: string): CapabilityDecisionRow[] {
    return this.db
      .prepare('SELECT * FROM capability_decisions WHERE kingdom_id = ? ORDER BY created_at')
      .all(kingdomId) as unknown as CapabilityDecisionRow[]
  }

  /** 绑定 Decision → Execution（一次 NULL→值，仅 GRANTED+ENFORCED；trigger 权威执行）。 */
  bindDecisionExecution(decisionId: string, executionId: string): CapabilityDecisionRow | null {
    this.db.prepare('UPDATE capability_decisions SET execution_id = ? WHERE decision_id = ?').run(executionId, decisionId)
    return this.getCapabilityDecision(decisionId)
  }

  // dispatch_records ────────────────────────────────────────────

  insertDispatchIntent(row: DispatchRecordRow): DispatchRecordRow {
    this.db
      .prepare(
        `INSERT INTO dispatch_records
           (dispatch_id, kingdom_id, lease_id, execution_id, task_id, attempt_no,
            runtime_type, runtime_instance_ref, session_ref, state,
            dispatch_request_snapshot, dispatch_input_ref_json, dispatch_payload_hash,
            runtime_dispatch_ref, runtime_execution_ref, receipt_json, terminal_evidence_json,
            output_ref_json, dispatched_at, receipt_at, terminal_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.dispatch_id, row.kingdom_id, row.lease_id, row.execution_id, row.task_id,
        row.attempt_no, row.runtime_type, row.runtime_instance_ref, row.session_ref,
        row.state, row.dispatch_request_snapshot, row.dispatch_input_ref_json,
        row.dispatch_payload_hash, row.runtime_dispatch_ref ?? null,
        row.runtime_execution_ref ?? null, row.receipt_json ?? null,
        row.terminal_evidence_json ?? null, row.output_ref_json ?? null,
        row.dispatched_at ?? null, row.receipt_at ?? null, row.terminal_at ?? null,
        row.created_at, row.updated_at,
      )
    return row
  }

  getDispatch(dispatchId: string): DispatchRecordRow | null {
    const rows = this.db.prepare('SELECT * FROM dispatch_records WHERE dispatch_id = ?').all(dispatchId) as unknown as DispatchRecordRow[]
    return rows[0] ?? null
  }

  listDispatches(kingdomId: string): DispatchRecordRow[] {
    return this.db
      .prepare('SELECT * FROM dispatch_records WHERE kingdom_id = ? ORDER BY created_at')
      .all(kingdomId) as unknown as DispatchRecordRow[]
  }

  /** CAS 推进 Dispatch 状态（期望旧态；转移合法性由 dispatch_state_guard trigger 权威执行）。 */
  updateDispatchState(dispatchId: string, expectedState: string, nextState: string, extra: {
    runtimeDispatchRef?: string | null
    runtimeExecutionRef?: string | null
    receiptJson?: string | null
    terminalEvidenceJson?: string | null
    outputRefJson?: string | null
    dispatchedAt?: string | null
    receiptAt?: string | null
    terminalAt?: string | null
  } = {}, at: string): DispatchRecordRow {
    const sets = ['state = ?', 'updated_at = ?']
    const params: (string | number | null)[] = [nextState, at]
    const put = (column: string, key: keyof typeof extra): void => {
      if (extra[key] !== undefined) { sets.push(`${column} = ?`); params.push(extra[key] ?? null) }
    }
    put('runtime_dispatch_ref', 'runtimeDispatchRef')
    put('runtime_execution_ref', 'runtimeExecutionRef')
    put('receipt_json', 'receiptJson')
    put('terminal_evidence_json', 'terminalEvidenceJson')
    put('output_ref_json', 'outputRefJson')
    put('dispatched_at', 'dispatchedAt')
    put('receipt_at', 'receiptAt')
    put('terminal_at', 'terminalAt')
    params.push(dispatchId, expectedState)
    const result = this.db
      .prepare(`UPDATE dispatch_records SET ${sets.join(', ')} WHERE dispatch_id = ? AND state = ?`)
      .run(...params)
    if (result.changes !== 1) {
      throw new StaleStateError(`dispatch ${dispatchId}`, expectedState, nextState)
    }
    const updated = this.getDispatch(dispatchId)
    if (!updated) throw new Error(`dispatch ${dispatchId} vanished after CAS update`)
    return updated
  }

  // tasks.capability_requirement_json / kingdoms.capability_ceiling_json（v6 增量）────

  getTaskCapabilityRequirement(taskId: string): string | null {
    if (!this.getTaskCapabilityRequirementColumn()) return null
    const row = this.db.prepare('SELECT capability_requirement_json FROM tasks WHERE task_id = ?').get(taskId) as unknown as { capability_requirement_json: string | null } | undefined
    return row?.capability_requirement_json ?? null
  }

  setTaskCapabilityRequirement(taskId: string, json: string | null): void {
    if (!this.getTaskCapabilityRequirementColumn()) {
      throw new Error('TASK_CAPABILITY_REQUIREMENT_UNAVAILABLE: Schema v4 未迁移')
    }
    this.db.prepare('UPDATE tasks SET capability_requirement_json = ? WHERE task_id = ?').run(json, taskId)
  }

  private getTaskCapabilityRequirementColumn(): boolean {
    return (this.db.prepare('PRAGMA table_info(tasks)').all() as unknown as { name: string }[])
      .some(column => column.name === 'capability_requirement_json')
  }

  getKingdomCapabilityCeiling(kingdomId: string): string | null {
    const row = this.db.prepare('SELECT capability_ceiling_json FROM kingdoms WHERE kingdom_id = ?').get(kingdomId) as unknown as { capability_ceiling_json: string | null } | undefined
    return row?.capability_ceiling_json ?? null
  }

  setKingdomCapabilityCeiling(kingdomId: string, json: string | null): void {
    this.db.prepare('UPDATE kingdoms SET capability_ceiling_json = ? WHERE kingdom_id = ?').run(json, kingdomId)
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

/**
 * v0.8（M3-S2 v6）：CAS 陈旧态失败。
 * `UPDATE ... WHERE state = <expected>` 命中 0 行 = 期望旧态已变化
 * （并发推进 / 重复调用 / 状态被其它路径改写）→ fail-closed，不静默继续。
 */
export class StaleStateError extends Error {
  constructor(entity: string, expectedState: string, nextState: string) {
    super(`Stale state: ${entity} 期望 ${expectedState} → ${nextState} 失败（当前状态已非期望旧态，拒绝覆盖）`)
    this.name = 'StaleStateError'
  }
}

/** "CREATED×1、REVIEW×2" 形式的状态直方图，供 status 一行展示。 */
function summariseTaskStatuses(tasks: TaskRow[]): string {
  const counts = new Map<string, number>()
  for (const t of tasks) counts.set(t.status, (counts.get(t.status) ?? 0) + 1)
  return [...counts.entries()].map(([status, n]) => `${status}×${n}`).join('、')
}
