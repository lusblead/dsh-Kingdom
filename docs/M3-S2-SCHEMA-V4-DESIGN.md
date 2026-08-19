# M3-S2 — Domain + Schema v4 Design（草案 · 待 Owner Review）

> 状态：**DRAFT（M3-S2 AUTHORIZED TO START，待 Owner Review）**（2026-08-19）
> 依据：M3-S1 Design v3（DESIGN FROZEN / OWNER APPROVED）；全局经验 skill `kingdom-architecture` v1.0.0；
> 现有实现基线：`src/core/db.ts`（Schema v3，`SCHEMA_VERSION=3`）、`src/core/task.ts`、`src/core/execution.ts`。
> 授权边界：**DDL 草案 ≠ 获准执行 migration**。本稿把 Schema v4 设计到可施工程度；正式迁移施工须再经 Owner Review。
> 红线：不执行 migration、不修改正式 kingdom.db、不动 DSH、不发布、不推翻 M3-S1 冻结语义。

---

## 0. 设计输入（冻结，来自 M3-S1）

- 四类事实分类：`A. Kingdom Core Fact / B. Core Runtime Reference / C. Adapter-owned opaque evidence / D. Runtime-specific detail`。
- 五套独立生命周期对象必须为独立 Core Ledger：
  **Session↔Territory Affinity / Execution Lease / Dispatch Record / Capability Decision / Execution Contract**。
- 关键冻结语义（全部沿用，不重述论证）：
  - Lease = Kingdom dispatch 互斥；一 Lease ↔ 一 Attempt；Lease 不依附 Execution；`capability_decision_id` late-bind；materialize 前 Plan 可恢复。
  - `GRANTED ⇔ ENFORCED`；`enforcement_status ∈ ENFORCED | NOT_ATTEMPTED | UNAVAILABLE | FAILED`；删 `GRANTED+UNAVAILABLE`。
  - `execution_contract ∈ LEGACY_COMPAT | GOVERNED_PERSISTENT`；Core 不看 `dispatch_backend`。
  - affinity：独立 ledger；同一 Session 不可改绑 Territory；`role_binding` 只放 current projection。
  - 不过度外键化：turns/tool_calls/guard_events 等 Runtime detail 不进 Kingdom 表。

---

## 1. Schema v4 Domain Model（事实层 → 表层映射）

| M3-S1 概念 | v4 表 | 四类 | 说明 |
|---|---|---|---|
| Kingdom / Territory / RoleBinding | `kingdoms` / `territories` / `role_bindings`（复用 v3） | A | 增挂载列（见 §3） |
| Task / Assignment / Execution / WorkerResult / Event | `tasks` / `task_assignments` / `executions` / `worker_results` / `events`（复用 v3） | A | executions 增列（见 §3） |
| **Session↔Territory Affinity** | `session_territory_affinities` ★新 | A | canonical ledger |
| **Execution Lease** | `execution_leases` ★新 | A | 独立 lifecycle |
| **Capability Decision** | `capability_decisions` ★新 | A | 含 Grant snapshot |
| **Dispatch Record / Intent** | `dispatch_records` ★新 | A | intent/receipt/refs |
| runtime refs | 各表 `runtime_type / session_ref / runtime_dispatch_ref / runtime_execution_ref` 列 | B | opaque |
| Plan / Evidence / runtime_meta | `*_snapshot` / `runtime_metadata` 列 | C | Adapter-owned |
| DSH MessageId 等细节 | 不进 v4 表；值进 `runtime_dispatch_ref` | D | Adapter-only |

**不新建**：`runtime_bindings` 表（Stage 1 DEFERRED）；`capability_grants` 表（Grant 并入 Decision snapshot）；任何 DSH 事件表。

---

## 2. 表级关系图（概念，非 DDL）

```text
kingdoms
  ├── territories ──────────────┐
  ├── role_bindings ──(current projection: session_id)──┐
  ├── tasks ── territory_id ────────────────────────────┤
  │     └── task_assignments (worker_binding_id)        │
  │     └── executions ── execution_contract           │
  │            ├── execution_leases (session_ref,      │
  │            │      task_id, attempt_no,             │
  │            │      capability_decision_id ◄── late-bind)
  │            └── capability_decisions (execution_id ◄── 成功反向)
  │                   └── enforcement plan/evidence snapshot (C)
  │            └── dispatch_records (lease_id, execution_id,
  │                   kingdom_dispatch_id, runtime refs, receipt/terminal) ──┐
  ├── session_territory_affinities (worker_binding_id, session_ref,        │
  │       territory_id, is_current) ── 独立 canonical ledger               │
  └── events（审计流）
```

---

## 3. DDL 草案（migration 目标形态，`ensureSchemaV4` 落库后）

### 3.1 新增表

```sql
-- ★1 Session ↔ Territory Affinity Ledger（canonical fact）
CREATE TABLE IF NOT EXISTS session_territory_affinities (
  affinity_id      TEXT PRIMARY KEY,
  kingdom_id       TEXT NOT NULL,
  worker_binding_id TEXT NOT NULL,
  runtime_type     TEXT NOT NULL,
  session_ref      TEXT NOT NULL,        -- B：opaque
  territory_id     TEXT NOT NULL,
  established_at   TEXT NOT NULL,
  retired_at       TEXT,                 -- session 退役（换 Session 时旧行关闭）
  is_current       INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL
);
-- 强不变量：同一 Session 一旦建立 affinity 不得改绑 → 一个 session_ref 至多一行
CREATE UNIQUE INDEX IF NOT EXISTS affinity_session_uk
  ON session_territory_affinities(session_ref);

-- ★2 Execution Lease Ledger（独立 lifecycle，可先于 Execution 存在）
CREATE TABLE IF NOT EXISTS execution_leases (
  lease_id               TEXT PRIMARY KEY,
  kingdom_id             TEXT NOT NULL,
  worker_binding_id      TEXT NOT NULL,
  runtime_type           TEXT NOT NULL,
  session_ref            TEXT NOT NULL,  -- B：opaque
  task_id                TEXT NOT NULL,
  attempt_no             INTEGER NOT NULL,
  state                  TEXT NOT NULL CHECK(state IN
    ('ACQUIRED','PREPARING','MATERIALIZING','DISPATCH_READY',
     'EXECUTING','SETTLING','RELEASING','RECOVERING','RELEASED','ABORTED')),
  capability_decision_id TEXT,           -- ◄ late-bind（acquire 时 NULL）
  enforcement_plan_snapshot TEXT,        -- C：materialize 前必须可恢复
  acquired_at            TEXT NOT NULL,
  released_at            TEXT,
  updated_at             TEXT NOT NULL,
  UNIQUE(task_id, attempt_no)            -- 一 Lease ↔ 一 Attempt
);
-- 并发安全：同一 session 最多一个 active lease（非 RELEASED/ABORTED）
CREATE UNIQUE INDEX IF NOT EXISTS lease_one_active_per_session
  ON execution_leases(session_ref)
  WHERE state NOT IN ('RELEASED','ABORTED');

-- ★3 Capability Decision Ledger（最终安全裁决）
CREATE TABLE IF NOT EXISTS capability_decisions (
  decision_id              TEXT PRIMARY KEY,
  kingdom_id               TEXT NOT NULL,
  task_id                  TEXT NOT NULL,
  worker_binding_id        TEXT,
  supervisor_binding_id    TEXT,
  requirement_snapshot     TEXT,          -- Task 需求（非权威）
  ceiling_snapshot         TEXT,          -- Owner Ceiling（授权时）
  proposed_grant_snapshot  TEXT,          -- Supervisor Grant（权威输入）
  scope_snapshot           TEXT,          -- Territory scope 绑定
  effective_snapshot       TEXT,          -- Resolver 最终结果
  decision                 TEXT NOT NULL CHECK(decision IN ('GRANTED','DENIED')),
  enforcement_status       TEXT NOT NULL CHECK(enforcement_status IN
    ('ENFORCED','NOT_ATTEMPTED','UNAVAILABLE','FAILED')),
  requirement_coverage     TEXT NOT NULL DEFAULT 'NONE'
                            CHECK(requirement_coverage IN ('FULL','PARTIAL','NONE')),
  reason_code              TEXT,
  execution_id             TEXT,          -- 仅 GRANTED+ENFORCED 回填
  created_at               TEXT NOT NULL
);
-- Stage 3 冻结：GRANTED ⇔ ENFORCED（唯一合法 GRANTED 组合）
CREATE UNIQUE INDEX IF NOT EXISTS capability_decision_granted_enforced_uk
  ON capability_decisions(decision_id)
  WHERE decision = 'GRANTED' AND enforcement_status <> 'ENFORCED';  -- 空索引 = 永远禁止该组合
-- 注：用「空必须」的 UNIQUE + WHERE 实现 CHECK 无法表达的跨列约束更稳（空结果即禁止）。

-- ★4 Dispatch Record / Intent Ledger（crash-safety protocol 核心）
CREATE TABLE IF NOT EXISTS dispatch_records (
  dispatch_id          TEXT PRIMARY KEY,   -- kingdom_dispatch_id（Core canonical ID）
  kingdom_id           TEXT NOT NULL,
  lease_id             TEXT NOT NULL,      -- governed dispatch ↔ active lease
  execution_id         TEXT NOT NULL,
  task_id              TEXT NOT NULL,
  attempt_no           INTEGER NOT NULL,
  runtime_type         TEXT NOT NULL,
  session_ref          TEXT NOT NULL,      -- B：opaque
  state                TEXT NOT NULL CHECK(state IN
    ('INTENDED','DISPATCHED','RECEIVED','CORRELATED','TERMINAL','FAILED','RECOVERING')),
  runtime_dispatch_ref TEXT,               -- B：opaque（DSH = MessageId 值）
  runtime_execution_ref TEXT,              -- B：opaque
  receipt_json         TEXT,               -- C：DispatchReceipt payload（acceptedAt 等）
  terminal_evidence_json TEXT,             -- C：Terminal Evidence payload
  output_ref_json      TEXT,               -- C：Output Reference payload
  dispatched_at        TEXT,
  receipt_at           TEXT,
  terminal_at          TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS dispatch_records_lease_idx ON dispatch_records(lease_id);
CREATE INDEX IF NOT EXISTS dispatch_records_execution_idx ON dispatch_records(execution_id);
```

### 3.2 现有表增量（Versioned + transactional + idempotent ADD COLUMN，模式同 `ensureSchemaV2/V3`）

```sql
-- executions：执行契约（backfill=LEGACY_COMPAT）+ lease/decision 关联
ALTER TABLE executions ADD COLUMN execution_contract TEXT NOT NULL DEFAULT 'LEGACY_COMPAT'
  CHECK(execution_contract IN ('LEGACY_COMPAT','GOVERNED_PERSISTENT'));
ALTER TABLE executions ADD COLUMN lease_id TEXT;
ALTER TABLE executions ADD COLUMN capability_decision_id TEXT;
-- 注：execution_contract 挂 executions（per-attempt 事实，一 Attempt 一 Execution）

-- tasks：能力需求（非权威，信息字段）
ALTER TABLE tasks ADD COLUMN capability_requirements_json TEXT;

-- kingdoms：Owner Ceiling（NULL = LEGACY_UNMANAGED）
ALTER TABLE kingdoms ADD COLUMN capability_ceiling_json TEXT;

-- role_bindings：复用 v3 已有 session_id 作为 current projection（不新增列，避免语义膨胀）；
-- 历史归属由 session_territory_affinities 提供（Current Projection ≠ History）。
```

### 3.3 `SCHEMA_VERSION = 4`（db.ts 常量更新 + `ensureSchemaV4()`）

---

## 4. 字段语义与四类标注（抽要）

| 表 / 字段 | 类别 | 语义（Kingdom 理解到什么程度） |
|---|---|---|
| `execution_leases.capability_decision_id` | A | late-bind：acquire 时 NULL，materialize 后回填；不引入 PENDING |
| `execution_leases.enforcement_plan_snapshot` | C | Adapter-owned opaque；materialize 首次 mutation 前必须已写入（crash 可恢复） |
| `dispatch_records.runtime_dispatch_ref` | B | opaque；DSH = MessageId 的值；Core 不知内部规则 |
| `dispatch_records.state` | A | INTENDED → DISPATCHED → RECEIVED → CORRELATED → TERMINAL / FAILED；RECOVERING 例外 |
| `capability_decisions.proposed_grant_snapshot` | A | Supervisor Grant 历史事实（即使 DENY 也留存） |
| `capability_decisions.requirement_coverage` | A | **信息字段，非授权字段**；FULL 不自动 GRANTED |
| `session_territory_affinities.is_current` | A | current projection；历史靠行本身（retired_at） |

---

## 5. DB 级不变量 / 约束汇总

```text
I-1  一个 Runtime Session 最多一个 active Execution Lease
      → execution_leases 部分唯一索引 lease_one_active_per_session（WHERE state NOT IN (RELEASED,ABORTED)）
I-2  一个 Lease ↔ exactly one Task Attempt
      → UNIQUE(task_id, attempt_no)
I-3  一个 governed Dispatch ↔ exactly one active Lease
      → dispatch_records.lease_id NOT NULL + 应用层在 acquire 后、release 前创建（FK 语义，见 §7）
I-4  GRANTED ⇔ ENFORCED（唯一合法 GRANTED 组合）
      → capability_decisions 空必须唯一索引（GRANTED AND NOT ENFORCED → 禁止）
I-5  同一 Session 不得改绑 Territory
      → session_territory_affinities UNIQUE(session_ref)
I-6  execution_contract ∈ {LEGACY_COMPAT, GOVERNED_PERSISTENT}（CHECK）
I-7  execution_contract = GOVERNED_PERSISTENT 的 Execution 必须有 lease_id 关联（应用层 + §7）
I-8  Task/Execution 状态机不因 Schema 变化而放宽（Claim ≠ Fact 维持）
```

---

## 6. 状态生命周期（v4 冻结）

### Execution（`executions.state`，v3 状态机 + RECOVERING）

```text
STARTING → RUNNING ⇄ PAUSED → COMPLETED / FAILED / ABORTED
所有非终态（STARTING/RUNNING/PAUSED）→ RECOVERING（unfinished + host 重启 / Adapter 失联 /
  Dispatch 有 Intent 无完整 Receipt）
RECOVERING →（reconcile 出可信 TERMINAL）→ COMPLETED/FAILED/ABORTED
RECOVERING 不改变 Task.status（治理事实不动）
```

### Execution Lease（`execution_leases.state`）

```text
ACQUIRED → PREPARING → MATERIALIZING → DISPATCH_READY → EXECUTING → SETTLING → RELEASING → RELEASED
任一阶段 materialize 失败 → cleanup → RELEASED（zero execution）或 ABORTED（cleanup 不明 → RECOVERING）
RECOVERING：cleanup/状态不明时进入；期间该 session 禁新 lease/dispatch
```

### Dispatch Record（`dispatch_records.state`）

```text
INTENDED（COMMIT POINT 前，persist）→ DISPATCHED（调 runtime）→ RECEIVED（receipt 落）
→ CORRELATED（runtime_execution_ref 对上）→ TERMINAL（terminal evidence）
失败 / 异常 → FAILED；无法确认 → RECOVERING（UNKNOWN 不超时 ABORT）
```

### Capability Decision（不变，Stage 3 冻结）

```text
decision = GRANTED|DENIED；enforcement_status = ENFORCED|NOT_ATTEMPTED|UNAVAILABLE|FAILED
合法组合：GRANTED+ENFORCED；DENIED+NOT_ATTEMPTED/UNAVAILABLE/FAILED
```

---

## 7. v3 → v4 迁移 / backfill 方案

### 7.1 迁移步骤（`ensureSchemaV4()`，Versioned + transactional + idempotent）

```text
1. 读 kingdoms.schema_version，>= 4 → 直接返回（幂等）。
2. BEGIN IMMEDIATE。
3. CREATE TABLE IF NOT EXISTS 四张新表 + 三个索引（§3.1）。
4. PRAGMA table_info gate → ADD COLUMN（§3.2 五处；executions.execution_contract 带 DEFAULT 'LEGACY_COMPAT'）。
5. verify：全部预期表/列/索引存在，缺失即抛（fail-loud）。
6. UPDATE kingdoms SET schema_version = 4。
7. COMMIT；任一步失败 ROLLBACK（不留半迁移）。
```

### 7.2 backfill 规则（关键：**不臆造治理事实**）

```text
B-1  executions.execution_contract = 'LEGACY_COMPAT'
     （现存 executions 全是 v0.6/v0.7 one-shot 路径产物 → Legacy；不猜测任何行为 Governed）
B-2  session_territory_affinities **不自动 backfill**
     （现存 role_bindings.session_id 无法可靠推导 Territory 归属——
      恰好违反「affinity 不从 runtime 状态反推」原则；旧数据保持"无 affinity 记录"，
      由后续明确绑定动作补齐，或保持 Legacy 王国不加 affinity）
B-3  execution_leases / dispatch_records / capability_decisions **空表创建**，无旧数据
     （这三个对象在 v3 中不存在；旧 executions 不伪造 lease/dispatch/decision 历史）
B-4  kingdoms.capability_ceiling_json = NULL → LEGACY_UNMANAGED（沿用 v2 规则，不默认全允许）
```

### 7.3 兼容性

```text
- v3 库开库即收敛到 v4（无需用户操作）；旧工具链（v0.7 命令）不受影响（仅新增列/表）。
- role_bindings.session_id 继续作为 current projection 被旧 GUI/工具读取（不破坏）。
- 既有 executions 状态机（无 RECOVERING 的值）在升级后保持合法（RECOVERING 只新增，不要求旧行迁移）。
- 一次性 subagent 链（LEGACY_COMPAT）继续可用：execution_contract 默认值保证旧路径零改动。
```

---

## 8. Crash Consistency Analysis

```text
C-1  COMMIT POINT：dispatch_records 在 RuntimeAdapter.dispatch() 之前 INSERT（state=INTENDED）。
     crash 于 dispatch 后、receipt 前 → 重启见 INTENDED + lease_id → Adapter.reconcile(dispatch_id)
     问「这次到底有没有发生」，而非盲目重发（堵住重复 Dispatch）。
C-2  Lease 原子 acquire：active lease 由部分唯一索引强制，非 if(!busy) 先读后写；
     并发 acquire 同一 session 只有一个成功。
C-3  capability_decision_id late-bind：Lease 行在 acquire 时该列为 NULL；materialize 后
     在同一事务内写入 Decision 行 + 回填 lease.capability_decision_id → 不出现 PENDING 状态。
C-4  enforcement_plan_snapshot：materialize 首次 mutation 前必须已持久化到 lease 行；
     crash 后重启可恢复「当时准备装什么 policy」（Adapter-owned opaque，Core 不解语义）。
C-5  迁移事务：ensureSchemaV4 单事务，失败 ROLLBACK，绝不留下 v3/v4 混合形态。
C-6  RECOVERING 期间：该 session 的 lease 部分唯一索引仍生效（非 RELEASED/ABORTED）
     → 天然禁止新 lease/dispatch，直到 reconcile 结束。
```

---

## 9. Negative / Adversarial DB Tests（M3-S6 前置，v4 施工后必跑）

| # | 测试 | 预期 |
|---|---|---|
| T-1 | 同一 session_ref 并发 acquire 两个 lease | 第二个 INSERT 被部分唯一索引拒绝 |
| T-2 | dispatch_records 引用不存在的 lease_id | FK/应用层拒绝（或 fail-loud） |
| T-3 | INSERT capability_decisions(GRANTED, UNAVAILABLE) | 空必须唯一索引拒绝 |
| T-4 | INSERT capability_decisions(GRANTED, NOT_ATTEMPTED) | 拒绝 |
| T-5 | 同一 session_ref 建立第二条 affinity | UNIQUE(session_ref) 拒绝 |
| T-6 | executions.execution_contract = 'SOMETHING_ELSE' | CHECK 拒绝 |
| T-7 | v3→v4 升级重复开库 | 幂等，不重复 ADD/backfill，无副作用 |
| T-8 | 迁移中途模拟失败（断列） | ROLLBACK，库仍为 v3 语义完整 |
| T-9 | dispatch INTENDED 无 receipt → 重启 | 可 reconcile，不盲发第二次 |
| T-10 | execution_contract=GOVERNED_PERSISTENT 无 lease_id | 应用层拒绝（I-7） |
| T-11 | RECOVERING execution 试图更新 Task.status | Task 状态机拒绝（治理事实不动） |
| T-12 | 旧 executions 升级后 | 全部 LEGACY_COMPAT，行为不变 |

---

## 10. 验收矩阵（Owner Review 检查点）

```text
□ 五套独立对象（Affinity/Lease/Dispatch/Decision/Contract）均为独立表，未压回 executions JSON
□ 四类事实分类逐字段可标注（A/B/C/D）
□ I-1..I-8 全部可落地（唯一索引/CHECK/应用层）
□ 状态生命周期（Execution/Lease/Dispatch/Decision）各自冻结且互不越权
□ v3→v4 迁移幂等 + 事务 + fail-loud verify
□ backfill 不臆造治理事实（affinity 不自动反推、旧 executions=LEGACY_COMPAT）
□ crash consistency C-1..C-6 有对应约束支撑
□ 12 项 adversarial DB tests 可作为 M3-S6 Gate 前置
□ 未执行 migration / 未碰正式 DB / 未改 DSH / 未发布
```

---

## 11. 明确不做（防越权）

```text
✕ 不在正式 kingdom.db 执行 migration（等 Owner 二次 Review 通过）
✕ 不新增 runtime_bindings / capability_grants / DSH 事件表
✕ 不把 MessageId/turn/guard/cwd 设计成 Kingdom 永久 Schema
✕ 不进入 M3-S3 Persistent Worker Backend
✕ 不为便利 Schema 推翻任何 M3-S1 冻结语义
```

---

# 待 Owner Review

本稿把 M3-S2 设计到可施工程度（含 DDL 草案、迁移方案、12 项对抗测试）。请 Owner Review：

1. **表结构**：四张新表 + 三列增量的职责/字段/约束是否认可；
2. **约束强度**：I-1..I-8（尤其 I-4 用空必须唯一索引实现 GRANTED⇔ENFORCED、I-1 部分唯一索引实现 one-active-lease-per-session）是否可接受；
3. **backfill 原则**：不自动反推 affinity（B-2）是否认可；
4. **RECOVERING / lease / dispatch 状态机**（§6）是否与 M3-S1 冻结一致；
5. **验收矩阵**（§10）是否完整。

Review 通过后，才授权：写正式 migration、改正式 Domain 层，并进入 M3-S3。
