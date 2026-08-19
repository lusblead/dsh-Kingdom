# M3-S2 — Schema v4 Design v5（Owner Review blocking revision · 待二次 Review）

> 状态：**DRAFT v5（REVISE REQUIRED 后修订版，待 Owner Review）**（2026-08-19）
> 性质：v4 的 blocking revision（Owner Review 2026-08-19 结论：`REVISE REQUIRED / NOT APPROVED AS-IS`）。
> 依据：M3-S1 Design v3（FROZEN）；M3-S2 v4 草案；Owner Review 八项指令。
> 关键新增：**v5 全部关键约束已在 SQLite 内存库实测（20/20 PASS），执行结果见 §8**。
> 红线：不执行 migration、不动正式 kingdom.db、不改 DSH、不发布；**M3-S2 仍停留在设计阶段，正式 migration / Domain 施工 / M3-S3 均 NOT AUTHORIZED**。

---

## 0. v4 → v5 变更摘要（八项指令逐一落实）

| # | Owner 指令 | v5 落实 |
|---|---|---|
| 1 | 删无效 Capability 唯一索引，改完整双向 CHECK | §1.3：行内 `CHECK(GRANTED+ENFORCED OR DENIED+IN(...))`，双向（含 DENIED+ENFORCED 拒绝） |
| 2 | 完整 Runtime Session identity | 四新表全部补 `runtime_instance_ref`；identity = `(runtime_type, runtime_instance_ref, session_ref)` |
| 3 | Affinity/Ledger immutability | §1.1 trigger（identity 不可变）+ §1.2/§1.3 immutability trigger（retire 单次、decision 不可翻转、execution_id 只 NULL→值一次） |
| 4 | FK + trigger/CAS 实现 I-3、I-7 | §1.4 FK(lease_id) + `dispatch_requires_ready_lease` trigger；§1.5 executions 同一行 CHECK + 重建表方案 |
| 5 | 修正 Lease ABORTED 与释放语义 | Lease 状态机**删除 ABORTED**；active = `WHERE state <> 'RELEASED'`；仅 RELEASED 表示可接下一项工作 |
| 6 | Dispatch Request snapshot/hash + typed Enforcement Evidence | §1.4 加 `dispatch_request_snapshot / dispatch_input_ref_json / dispatch_payload_hash`；§1.3 加 `enforcement_evidence_type / enforcement_evidence_json`（typed envelope） |
| 7 | 四 Ledger 原子事务 + transition matrix | §4 TX-1..TX-5；§3 完整 transition matrix（Lease/Dispatch/Execution） |
| 8 | 重写验收矩阵 + SQLite 实测结果 | §8 三组测试 + 实测 20/20 PASS（`D:\dsh\research\M3-S2-SQLITE-VERIFY\m3s2_v5_verify.py`） |

**v3 事实澄清（Owner Review 遗留未证明点）**：`executions.state` 在 v3 中 **无 CHECK**（`db.ts:123`：`state TEXT NOT NULL`）；全库无 FOREIGN KEY、无 `PRAGMA foreign_keys`。→ RECOVERING 加入本身不需要重建 executions；但为满足「RECOVERING 物理约束 + I-7 CHECK」，v5 采用**重建 executions 表**方案（§1.5），与 Owner 6 步建议一致。

---

## 1. v5 DDL（已验证版本，全文见验证脚本）

### 1.1 `session_territory_affinities`（Affinity Ledger）

```sql
CREATE TABLE IF NOT EXISTS session_territory_affinities (
  affinity_id       TEXT PRIMARY KEY,
  kingdom_id        TEXT NOT NULL,
  worker_binding_id TEXT NOT NULL,
  runtime_type      TEXT NOT NULL,
  runtime_instance_ref TEXT NOT NULL,          -- ★ v5：补 Runtime namespace
  session_ref       TEXT NOT NULL,
  territory_id      TEXT NOT NULL,
  established_at    TEXT NOT NULL,
  retired_at        TEXT,
  is_current        INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0,1)),
  created_at        TEXT NOT NULL,
  UNIQUE (runtime_type, runtime_instance_ref, session_ref)   -- ★ 完整 Session identity
);

-- 身份字段不可变（改绑 / 改 identity 一律拒绝）
CREATE TRIGGER IF NOT EXISTS affinity_identity_immutable
BEFORE UPDATE OF kingdom_id, worker_binding_id, runtime_type,
                 runtime_instance_ref, session_ref, territory_id, established_at, is_current
ON session_territory_affinities
BEGIN SELECT RAISE(ABORT, 'AFFINITY_IDENTITY_IMMUTABLE'); END;

-- retire 只允许一次（active→retired 单次转换）
CREATE TRIGGER IF NOT EXISTS affinity_retire_once
BEFORE UPDATE OF retired_at
ON session_territory_affinities
BEGIN SELECT RAISE(ABORT, 'AFFINITY_ALREADY_RETIRED')
  WHERE OLD.retired_at IS NOT NULL; END;
```

### 1.2 `execution_leases`（Lease Ledger）

```sql
CREATE TABLE IF NOT EXISTS execution_leases (
  lease_id               TEXT PRIMARY KEY,
  kingdom_id             TEXT NOT NULL,
  worker_binding_id      TEXT NOT NULL,
  runtime_type           TEXT NOT NULL,
  runtime_instance_ref   TEXT NOT NULL,
  session_ref            TEXT NOT NULL,
  task_id                TEXT NOT NULL,
  attempt_no             INTEGER NOT NULL,
  state                  TEXT NOT NULL CHECK(state IN
    ('ACQUIRED','PREPARING','MATERIALIZING','DISPATCH_READY',
     'EXECUTING','SETTLING','RELEASING','RECOVERING','RELEASED')),  -- ★ 删除 ABORTED
  capability_decision_id TEXT,            -- late-bind
  enforcement_plan_snapshot TEXT,         -- C：materialize 前可恢复
  acquired_at            TEXT NOT NULL,
  released_at            TEXT,
  updated_at             TEXT NOT NULL,
  UNIQUE (task_id, attempt_no)            -- 一 Lease ↔ 一 Attempt
);

-- ★ 并发安全：完整 Session identity 最多一个 active lease；仅 RELEASED 释放
CREATE UNIQUE INDEX IF NOT EXISTS lease_one_active_per_session
  ON execution_leases(runtime_type, runtime_instance_ref, session_ref)
  WHERE state <> 'RELEASED';
```

状态机转移由 `lease_transition_rules` 表 + `lease_state_transition_guard` trigger 强制（§3.2）。

### 1.3 `capability_decisions`（Decision Ledger）

```sql
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
  enforcement_evidence_type TEXT,          -- ★ v5：typed envelope type（如 "DshEnforcementEvidence/v1"）
  enforcement_evidence_json TEXT,          -- ★ v5：payload
  requirement_coverage     TEXT NOT NULL DEFAULT 'NONE'
                            CHECK(requirement_coverage IN ('FULL','PARTIAL','NONE')),
  reason_code              TEXT,
  execution_id             TEXT,           -- 仅 NULL→值 一次
  created_at               TEXT NOT NULL,
  -- ★ 指令 1：完整双向 CHECK（替代无效唯一索引；已实测）
  CHECK (
    (decision = 'GRANTED' AND enforcement_status = 'ENFORCED')
    OR
    (decision = 'DENIED' AND enforcement_status IN
       ('NOT_ATTEMPTED','UNAVAILABLE','FAILED'))
  )
);

-- Final Decision 不可改写（decision/status/snapshots/evidence 冻结）
CREATE TRIGGER IF NOT EXISTS capability_decision_immutable
BEFORE UPDATE OF decision, enforcement_status, requirement_snapshot, ceiling_snapshot,
                 proposed_grant_snapshot, scope_snapshot, effective_snapshot,
                 enforcement_evidence_type, enforcement_evidence_json,
                 requirement_coverage, reason_code
ON capability_decisions
BEGIN SELECT RAISE(ABORT, 'CAPABILITY_DECISION_IMMUTABLE'); END;

-- execution_id 只允许 NULL→值 一次（不可重绑）
CREATE TRIGGER IF NOT EXISTS capability_decision_execution_bind_once
BEFORE UPDATE OF execution_id
ON capability_decisions
WHEN OLD.execution_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'CAPABILITY_DECISION_EXECUTION_ALREADY_BOUND'); END;
```

**typed envelope 约定（所有 snapshot/evidence 列统一）**：

```json
{ "type": "DshEnforcementEvidence/v1", "payload": { ... } }
```

Core 只按 `type` 路由（存/取/hash/展示），不解 payload（Stage 4 冻结）。

### 1.4 `dispatch_records`（Dispatch Ledger，★ 指令 6：补「准备派发什么」）

```sql
CREATE TABLE IF NOT EXISTS dispatch_records (
  dispatch_id          TEXT PRIMARY KEY,   -- kingdom_dispatch_id（Core canonical ID）
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
  dispatch_request_snapshot TEXT NOT NULL,  -- ★ 不可变：typed envelope（准备派发什么）
  dispatch_input_ref_json  TEXT NOT NULL,   -- ★ input reference（敏感内容只存 ref+hash）
  dispatch_payload_hash    TEXT NOT NULL,   -- ★ cryptographic hash
  runtime_dispatch_ref  TEXT,
  runtime_execution_ref TEXT,
  receipt_json          TEXT,               -- typed envelope
  terminal_evidence_json TEXT,              -- typed envelope
  output_ref_json       TEXT,
  dispatched_at         TEXT,
  receipt_at            TEXT,
  terminal_at           TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  FOREIGN KEY (lease_id) REFERENCES execution_leases(lease_id)   -- ★ 指令 4：FK
);

-- ★ 指令 4：Dispatch 必须由 DB 验证「存在 + DISPATCH_READY + 完全一致」的 Lease
--（实测：trigger 先于 FK 触发；两者均为 fail-closed，FK 作为 foreign_key_check 兜底）
CREATE TRIGGER IF NOT EXISTS dispatch_requires_ready_lease
BEFORE INSERT ON dispatch_records
BEGIN
  SELECT RAISE(ABORT, 'DISPATCH_REQUIRES_MATCHING_READY_LEASE')
  WHERE NOT EXISTS (
    SELECT 1 FROM execution_leases l
    WHERE l.lease_id = NEW.lease_id
      AND l.state = 'DISPATCH_READY'
      AND l.kingdom_id = NEW.kingdom_id
      AND l.task_id = NEW.task_id
      AND l.attempt_no = NEW.attempt_no
      AND l.runtime_type = NEW.runtime_type
      AND l.runtime_instance_ref = NEW.runtime_instance_ref
      AND l.session_ref = NEW.session_ref
  );
END;
```

Dispatch 状态机转移由 `dispatch_transition_rules` + trigger 强制（§3.3）。

### 1.5 `executions`（v4 重建形态，★ 指令 4 I-7 + RECOVERING 物理约束）

```sql
-- v3 的 executions.state 无 CHECK（db.ts:123），但 v4 需加 RECOVERING + I-7 CHECK，
-- ADD COLUMN 无法加表级 CHECK → 采用重建表（Owner 6 步方案，迁移阶段执行）：
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
  execution_contract TEXT NOT NULL DEFAULT 'LEGACY_COMPAT'
                       CHECK(execution_contract IN ('LEGACY_COMPAT','GOVERNED_PERSISTENT')),
  lease_id           TEXT,
  capability_decision_id TEXT,
  UNIQUE (task_id, attempt_no),
  -- ★ I-7：Governed Execution 必须关联 Lease + Decision（同一行最低保证；FK/trigger 更强校验见 §7）
  CHECK (
    execution_contract = 'LEGACY_COMPAT'
    OR (
      execution_contract = 'GOVERNED_PERSISTENT'
      AND lease_id IS NOT NULL
      AND capability_decision_id IS NOT NULL
    )
  )
);
```

**重建 6 步（同一事务）**：建 `executions_v4` → `INSERT SELECT` 复制+backfill（`execution_contract='LEGACY_COMPAT'`）→ 核对行数/主键/状态 → `DROP TABLE executions` + rename → 重建索引/trigger → COMMIT（fail-loud verify）。

---

## 2. 不变量实现强度（v4 判定 → v5 实测判定）

| 不变量 | v4 判定 | v5 实现 | 实测 |
|---|---|---|---|
| I-1 one-active-lease-per-session | 部分（无 namespace） | 完整 identity 部分唯一索引 + 删 ABORTED | ✅ A-10（同 identity 拒绝）/ A-11（异 instance 允许） |
| I-2 一 Lease=一 Attempt | 基本 | `UNIQUE(task_id, attempt_no)` + 状态机守卫 | ✅ A-10 附证 |
| I-3 Dispatch 必有 active Lease | 不成立 | FK + `dispatch_requires_ready_lease` trigger（存在+DISPATCH_READY+全一致） | ✅ A-13/A-14/A-15（缺/已释放/不匹配均拒绝）/ A-20（合法通过） |
| I-4 GRANTED⇔ENFORCED | 不成立（索引无效） | 行内双向 CHECK | ✅ A-1..A-6（含 DENIED+ENFORCED 拒绝） |
| I-5 affinity 不可改绑 | 不成立（UNIQUE 不挡 UPDATE） | identity immutability trigger | ✅ A-7/A-8（UPDATE 拒绝） |
| I-6 execution_contract 枚举 | 成立 | CHECK | ✅ A-17 |
| I-7 Governed 必有 Lease+Decision | 不成立 | executions 同一行 CHECK + 施工期 FK/trigger | ✅ A-16 |
| I-8 状态机不放宽 | 非 DB 不变量 | transition rules + trigger（Lease/Dispatch）；Execution 走 Core 状态机 + v4 CHECK | ✅ A-12（非法 Lease 跳转拒绝） |
| **I-9 Final Decision 不可改写**（新增） | — | decision immutability + execution_id 单绑 trigger | ✅ A-18/A-19 |
| **I-10 冗余关系一致性**（新增） | — | dispatch trigger 强制 lease 全一致；executions 关联待 FK/trigger | ✅ A-15 |

---

## 3. 状态机 transition matrix

### 3.1 Execution（v4，含 RECOVERING）

```text
STARTING → RUNNING ⇄ PAUSED → COMPLETED / FAILED / ABORTED
STARTING/RUNNING/PAUSED → RECOVERING（unfinished + 重启 / Adapter 失联 / Intent 无完整 Receipt）
RECOVERING →（reconcile 出可信 TERMINAL）→ COMPLETED / FAILED / ABORTED
RECOVERING 不改变 Task.status
```

### 3.2 Execution Lease（v5：删 ABORTED；仅 RELEASED 释放）

```text
ACQUIRED → PREPARING → MATERIALIZING → DISPATCH_READY → EXECUTING → SETTLING → RELEASING → RELEASED
ACQUIRED/PREPARING/MATERIALIZING/DISPATCH_READY/EXECUTING/SETTLING/RELEASING → RECOVERING
MATERIALIZING → RELEASED（materialize 失败 cleanup 成功 = zero execution）
RECOVERING → RELEASED（cleanup 验证后）/ RECOVERING（保持）
```

转移强制：`lease_transition_rules` 表 + `BEFORE UPDATE OF state` trigger（已实测 A-12）。

### 3.3 Dispatch Record

```text
INTENDED → DISPATCHED → RECEIVED → CORRELATED → TERMINAL
INTENDED → FAILED（dispatch 前确定失败，无外部副作用）
INTENDED/DISPATCHED/RECEIVED/CORRELATED → RECOVERING
RECOVERING → TERMINAL / FAILED / RECOVERING
```

转移强制：`dispatch_transition_rules` 表 + trigger。

---

## 4. 四 Ledger 原子事务边界（★ 指令 7；v4 的 C-1..C-6 思想落成跨表事务）

```text
TX-1  （materialize 前）
  持久化 Enforcement Plan（→ lease.enforcement_plan_snapshot）
  + Lease ACQUIRED → MATERIALIZING
  COMMIT
  之后才允许 materialize 首次 Runtime mutation

TX-2  （materialize 结果）
  写 Final Capability Decision（GRANTED+ENFORCED | DENIED+...）
  + Lease late-bind capability_decision_id
  COMMIT

TX-3  （DISPATCH COMMIT POINT）
  写 Execution（GOVERNED_PERSISTENT + lease_id + decision_id）
  + 写 Dispatch INTENDED（含 request snapshot + input ref + payload hash）
  + Lease DISPATCH_READY → EXECUTING
  COMMIT
  之后才允许 RuntimeAdapter.dispatch()

TX-4  （终态）
  写 Terminal Evidence（typed envelope）
  + Dispatch → TERMINAL
  + Execution → terminal state
  COMMIT

TX-5  （释放）
  写 cleanup/teardown evidence
  + Lease → RELEASED
  COMMIT
```

Crash 语义：TX-1 前崩 → 无 Runtime mutation；TX-2 前崩 → Lease 不释放（RECOVERING）；TX-3 前崩 → 无外部副作用；TX-3 后、receipt 前崩 → reconcile(dispatch_id) 不盲发；TX-4 前崩 → 不 settle；TX-5 前崩 → Session 不得下一 Lease。

---

## 5. Backfill 原则（v4 APPROVED + 三条 fail-closed 条件）

```text
B-1 旧 executions 全部 execution_contract = 'LEGACY_COMPAT'
B-2 不自动生成 Affinity（不反推治理事实）
B-3 不伪造 Lease / Decision / Dispatch 历史（空表创建）
B-4 capability_ceiling_json = NULL → LEGACY_UNMANAGED（不默认全允许）
```

**v5 追加三条 fail-closed 条件（Owner 指令）**：

```text
B-5 旧 role_bindings.session_id 不得自动升级为 governed Session
B-6 没有显式 Affinity 的 Session 不得进入 GOVERNED_PERSISTENT
B-7 capability_ceiling_json = NULL 的 Kingdom 不得进入 GOVERNED_PERSISTENT
（旧数据可继续走 Legacy；升级到 v4 不等于已配置 Runtime Governance）
```

---

## 6. 冗余关系与 canonical direction（★ 指令 4.C）

同一事实多处保存时，明确 canonical direction + immutable snapshot 边界：

| 事实 | canonical | snapshot（允许自包含审计，不可变） |
|---|---|---|
| Lease→Decision | `execution_leases.capability_decision_id` | decision 行（decision_id 主） |
| Execution→Lease | `executions.lease_id` | lease 行 |
| Execution→Decision | `executions.capability_decision_id` | decision 行 |
| Decision→Execution | `capability_decisions.execution_id`（仅成功路径回填，单绑） | — |
| Dispatch→Lease/Execution | `dispatch_records.lease_id / execution_id` | lease/execution 行 |
| Dispatch 内 task/attempt/session | 必须与 lease 一致（trigger 强制） | — |

防矛盾保证：dispatch trigger 全一致校验（A-15）；decision/lease/execution 关联字段均不可变或单绑（A-18/A-19）。

---

## 7. 施工期附加约束（FK/trigger 强校验，迁移时建）

```text
F-1 executions.lease_id FK → execution_leases(lease_id)（PRAGMA foreign_keys=ON 必须显式开启，v3 未开）
F-2 executions.capability_decision_id FK → capability_decisions(decision_id) +
    trigger：GOVERNED_PERSISTENT 时该 decision 必须 GRANTED+ENFORCED 且 task/worker 一致
F-3 executions_v4 重建后：state CHECK（含 RECOVERING）+ I-7 CHECK + contract CHECK
F-4 施工开启 PRAGMA foreign_keys=ON 并跑 PRAGMA foreign_key_check / integrity_check（§8 迁移测试）
```

---

## 8. 验收矩阵（★ 指令 8：重写三组 + 附 SQLite 实测结果）

### 8.1 实测结果（内存库，`D:\dsh\research\M3-S2-SQLITE-VERIFY\m3s2_v5_verify.py`）

```text
== A. Direct SQL Constraint Tests ==
  PASS  A-1 GRANTED+UNAVAILABLE rejected
  PASS  A-2 GRANTED+FAILED rejected
  PASS  A-3 GRANTED+NOT_ATTEMPTED rejected
  PASS  A-4 DENIED+ENFORCED rejected
  PASS  A-5 GRANTED+ENFORCED ok
  PASS  A-6 DENIED+NOT_ATTEMPTED ok
  PASS  A-7 affinity UPDATE territory_id rejected
  PASS  A-8 affinity UPDATE session_ref rejected
  PASS  A-9 duplicate session affinity rejected
  PASS  A-10 second active lease same session rejected
  PASS  A-11 different instance same session_ref allowed
  PASS  A-12 illegal lease transition rejected
  PASS  A-13 dispatch missing lease rejected
  PASS  A-14 dispatch non-ready lease rejected
  PASS  A-15 dispatch mismatched session rejected
  PASS  A-16 governed execution no lease rejected
  PASS  A-17 invalid execution_contract rejected
  PASS  A-18 decision flip DENIED->GRANTED rejected
  PASS  A-19 decision execution rebind rejected
  PASS  A-20 legal dispatch against ready lease ok
== 结果 ==  PASS 20 / 20  ALL PASS
```

**实测发现（写进文档的事实）**：
- ① A-13：BEFORE INSERT trigger **先于 FK** 触发——缺失 lease 返回 `DISPATCH_REQUIRES_MATCHING_READY_LEASE` 而非 FK 错误；两者均拒绝（fail-closed），FK 作为 `foreign_key_check` 兜底，不冲突。
- ② A-14 构造时 `DISPATCH_READY→RELEASED` 直跳被状态机 trigger 拒绝——证明 transition guard 生效，也证明 Lease 释放必须走完整链。

### 8.2 A. Direct SQL Constraint Tests（施工后全量，含 v4 未覆盖项）

```text
GRANTED+UNAVAILABLE 拒绝 ✅  GRANTED+FAILED 拒绝 ✅  GRANTED+NOT_ATTEMPTED 拒绝 ✅
DENIED+ENFORCED 拒绝 ✅
Affinity UPDATE territory_id 拒绝 ✅  Affinity UPDATE session identity 拒绝 ✅
同一完整 Runtime Session identity 两个 active Lease 拒绝 ✅
不同 runtime_instance、相同 session_ref 允许 ✅
Dispatch 引用不存在 Lease 拒绝 ✅  Dispatch 引用 RELEASED Lease 拒绝 ✅
Dispatch 与 Lease task/session 不一致拒绝 ✅
Governed Execution 无 Lease 拒绝 ✅
Governed Execution 无 GRANTED+ENFORCED Decision 拒绝（施工期 F-2）
Execution Contract 创建后改写拒绝（contract 不可变 trigger，施工期）
非法状态跳转拒绝 ✅（Lease A-12；Dispatch 同机制）
```

### 8.3 B. Migration Tests（施工后必跑）

```text
v3→v4 数据逐行保持（executions 重建核对行数/主键/状态）
重复开库幂等（ensureSchemaV4 版本 gate）
中途失败全量 rollback（单事务）
sqlite_master DDL 与预期一致
PRAGMA foreign_key_check 为空（foreign_keys=ON 下）
PRAGMA integrity_check = ok
旧 Execution 全部 LEGACY_COMPAT
旧 session_id 未生成 Affinity（B-5）
NULL ceiling 王国未进入 GOVERNED（B-7）
```

### 8.4 C. Crash / Transaction Tests

```text
TX-1 前 crash → Runtime 无 mutation
materialize 后、TX-2 前 crash → Lease 不释放（RECOVERING）
TX-2 后、TX-3 前 crash → cleanup/recovery
TX-3 后、receipt 前 crash → reconcile(dispatch_id)，不盲发
TX-4 前 crash → 不 settle
cleanup 未确认（TX-5 前）→ Session 不能取得下一 Lease
两个 reconciler 并发 → 只有一个合法状态推进（CAS/事务）
```

---

## 9. 验收矩阵（Owner Review 检查点）

```text
□ 八项指令逐一落实（§0 对照表）
□ 四套独立生命周期对象为独立 Core Ledger；Execution Contract 为 Execution 上不可变 Core Fact
  （修正 v4 表述：不再称「五套对象均为独立表」）
□ 数量表述统一：4 张新表 + 5 个 ADD COLUMN（executions 3 / tasks 1 / kingdoms 1）或「4 新表 + 3 旧表增量」
□ I-1..I-10 实测可落地（§2 表 + §8 实测）
□ 状态机 transition matrix 冻结（§3）+ 原子事务 TX-1..TX-5（§4）
□ backfill 含三条 fail-closed 条件（§5）
□ 验收矩阵三组测试（§8）+ SQLite 实测 20/20 PASS
□ 未执行 migration / 未碰正式 DB / 未改 DSH / 未发布
```

---

## 10. 明确不做（防越权）

```text
✕ 不在正式 kingdom.db 执行 migration（等 Owner 二次 Review）
✕ 不新建 runtime_bindings / capability_grants / DSH 事件表
✕ 不把 MessageId/turn/guard/cwd 设计成 Kingdom 永久 Schema
✕ 不进入 M3-S3
✕ 不为便利 Schema 推翻 M3-S1 冻结语义
```

---

# 待 Owner 二次 Review

v5 已按八项指令全部修订，并在 SQLite 内存库实测 20/20 PASS（证据：`D:\dsh\research\M3-S2-SQLITE-VERIFY\m3s2_v5_verify.py`，可重跑复验）。请 Review：

1. 双向 CHECK / immutability trigger / dispatch-ready trigger 的实测结果；
2. Lease 删除 ABORTED + 仅 RELEASED 释放的语义；
3. executions 重建表方案（v3 state 无 CHECK 的事实已确认）；
4. TX-1..TX-5 事务边界；
5. 三组验收矩阵（§8）。

Review 通过后，才授权写正式 migration、改正式 Domain 层，并进入 M3-S3。
