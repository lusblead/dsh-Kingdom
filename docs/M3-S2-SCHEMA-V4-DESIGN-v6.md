# M3-S2 — Schema v4 Design v6（Owner 二次 Review blocking revision · 待三次 Review）

> 状态：**DRAFT v6（二次 Review 后修订版，待 Owner Review）**（2026-08-19）
> 性质：v5 的 blocking revision（Owner 二次 Review 结论：`REVISE REQUIRED / NOT APPROVED AS-IS`）。
> 依据：M3-S1 Design v3（FROZEN）；M3-S2 v4/v5 草案；Owner 二次 Review 九项指令。
> 关键：**v6 全部约束在 SQLite 内存库实测 49/49 PASS**（`D:\dsh\research\M3-S2-SQLITE-VERIFY\m3s2_v6_verify.py`，随 v6 一并提交，可重跑复验）。
> 红线：不执行 migration、不动正式 kingdom.db、不改 DSH、不发布；**M3-S2 停留设计阶段，migration / Domain 施工 / M3-S3 均 NOT AUTHORIZED**。

---

## 0. v5 → v6 变更摘要（九项指令逐一落实）

| # | Owner 指令 | v6 落实 |
|---|---|---|
| 1 | Affinity retirement/current 一致性 | §1.1：行内 `CHECK((is_current=1 AND retired_at IS NULL) OR (is_current=0 AND retired_at IS NOT NULL))`；retirement 专属 trigger（唯一联合转换 + 单次） |
| 2 | one-current-session-per-worker | §1.1：`UNIQUE(kingdom_id, worker_binding_id) WHERE is_current=1` |
| 3 | Lease↔Current Affinity↔Task Territory 闭环（I-11） | §1.2：`execution_leases.territory_id`（不可变）+ `lease_requires_matching_affinity` trigger（acquire 时验证 affinity current/retired=NULL/territory 匹配 + task.territory 匹配） |
| 4 | Lease/Decision/Dispatch/Execution 补全 UPDATE/DELETE immutability | §1.1–§1.4：identity/plan/decision/release-evidence 单次绑定 trigger；四 Ledger `BEFORE DELETE` fail-closed；`execution_contract` 不可变 |
| 5 | FK + 唯一性 + 匹配 trigger 闭合 | §1.2–§1.4：dispatch FK(lease_id, execution_id) + UNIQUE(lease_id)/UNIQUE(execution_id)；executions_v4 FK(lease_id, capability_decision_id)；decision UNIQUE(execution_id) WHERE NOT NULL；dispatch/execution 全一致匹配 trigger |
| 6 | TX 流程与 transition matrix 一致 + Receipt/Correlation 事务 | §4：TX-0D/A/1/2S/2F/3/3R/4/5（完全对齐状态矩阵，含 Receipt/Correlation 边界） |
| 7 | Enforcement/Terminal/Release Evidence 状态前置 | §1.2–§1.4：状态 guard 内嵌 evidence 前置（MATERIALIZING→plan 非空、DISPATCH_READY→GRANTED+ENFORCED+evidence、RECEIVED→ref+receipt、CORRELATED→exec ref、TERMINAL→terminal evidence、RELEASED→release evidence+released_at） |
| 8 | transition rule 真实 DDL 或硬编码 trigger | §1.2/§1.4：**硬编码到 trigger**（消除规则表可篡改 + Schema 数量问题）；并补 **INSERT 状态守卫**（Lease 只能 ACQUIRED 创建、Dispatch 只能 INTENDED 创建——堵住「INSERT 直写终态」的真实漏洞） |
| 9 | 随 v6 提交完整验证脚本 + 扩展测试 | §7：`m3s2_v6_verify.py` 一并提交，49 项实测 PASS |

**二次 Review 的 9 个穿透点逐一闭合**（§2 表）。

---

## 1. v6 DDL（已验证全文，见验证脚本）

### 1.1 `session_territory_affinities`（Affinity Ledger）

```sql
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
  -- ★ 指令1：retirement/current 一致性
  CHECK (
    (is_current = 1 AND retired_at IS NULL)
    OR
    (is_current = 0 AND retired_at IS NOT NULL)
  )
);

-- ★ 指令2：一 Worker 当前最多一个长期 Session（v3 模型）
CREATE UNIQUE INDEX IF NOT EXISTS affinity_one_current_per_worker
  ON session_territory_affinities(kingdom_id, worker_binding_id)
  WHERE is_current = 1;

-- identity 不可变（is_current/retired_at 由 retirement trigger 专管）
CREATE TRIGGER IF NOT EXISTS affinity_identity_immutable
BEFORE UPDATE OF kingdom_id, worker_binding_id, runtime_type,
                 runtime_instance_ref, session_ref, territory_id,
                 established_at, created_at
ON session_territory_affinities
BEGIN SELECT RAISE(ABORT, 'AFFINITY_IDENTITY_IMMUTABLE'); END;

-- ★ 指令1：retirement 唯一合法联合转换 (1,NULL)→(0,val) 且只能一次
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

-- ★ 指令4：Ledger 不可 DELETE
CREATE TRIGGER IF NOT EXISTS affinity_no_delete
BEFORE DELETE ON session_territory_affinities
BEGIN SELECT RAISE(ABORT, 'AFFINITY_NO_DELETE'); END;
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
  territory_id           TEXT NOT NULL,   -- ★ 指令3：I-11 snapshot（不可变）
  task_id                TEXT NOT NULL,
  attempt_no             INTEGER NOT NULL,
  state                  TEXT NOT NULL CHECK(state IN
    ('ACQUIRED','PREPARING','MATERIALIZING','DISPATCH_READY',
     'EXECUTING','SETTLING','RELEASING','RECOVERING','RELEASED')),
  capability_decision_id TEXT,
  enforcement_plan_snapshot TEXT,          -- typed envelope {type,payload}
  release_evidence_json  TEXT,             -- ★ 指令7：release evidence
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

-- ★ 指令3（I-11）：acquire 时验证 current Affinity + Task Territory 闭环
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

-- ★ 指令4：identity 不可变 / plan 单绑 / decision late-bind 单绑 / release evidence 单绑
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

-- ★ 指令8：transition matrix 硬编码 + ★ 指令7：evidence 前置
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

-- ★ 指令8：INSERT 状态守卫（Lease 只能 ACQUIRED 创建）
CREATE TRIGGER IF NOT EXISTS lease_insert_state_guard
BEFORE INSERT ON execution_leases
WHEN NEW.state <> 'ACQUIRED'
BEGIN SELECT RAISE(ABORT, 'LEASE_INSERT_MUST_BE_ACQUIRED'); END;

CREATE TRIGGER IF NOT EXISTS lease_no_delete
BEFORE DELETE ON execution_leases
BEGIN SELECT RAISE(ABORT, 'LEASE_NO_DELETE'); END;
```

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
  enforcement_evidence_json TEXT,           -- ★ 单 JSON typed envelope（消除双权威值）
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
  -- ★ 指令7：GRANTED 必须带持久执行证据
  CHECK (decision <> 'GRANTED' OR
    (enforcement_evidence_json IS NOT NULL AND json_valid(enforcement_evidence_json)=1))
);

-- ★ 指令5：同一 execution 最多绑定一个 Decision
CREATE UNIQUE INDEX IF NOT EXISTS capability_decision_execution_uk
  ON capability_decisions(execution_id) WHERE execution_id IS NOT NULL;

-- ★ 指令4：Final Decision 除 execution_id 外全不可变（含 kingdom/task/worker/supervisor/created_at）
CREATE TRIGGER IF NOT EXISTS capability_decision_immutable
BEFORE UPDATE OF kingdom_id, task_id, worker_binding_id, supervisor_binding_id,
                 requirement_snapshot, ceiling_snapshot, proposed_grant_snapshot,
                 scope_snapshot, effective_snapshot, decision, enforcement_status,
                 enforcement_evidence_json, requirement_coverage, reason_code, created_at
ON capability_decisions
BEGIN SELECT RAISE(ABORT, 'CAPABILITY_DECISION_IMMUTABLE'); END;

-- execution_id：只允许一次 NULL→值，且只能 GRANTED+ENFORCED
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
```

### 1.4 `dispatch_records`（Dispatch Ledger）

```sql
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
  dispatch_request_snapshot TEXT NOT NULL,   -- 不可变
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
  FOREIGN KEY (execution_id) REFERENCES executions_v4(execution_id),
  -- ★ 指令5：一 Lease 一 Dispatch / 一 Execution 一 Dispatch
  UNIQUE (lease_id),
  UNIQUE (execution_id)
);

-- ★ 指令4：request identity + payload 完全不可变（INSERT 后 UPDATE 不能绕过）
CREATE TRIGGER IF NOT EXISTS dispatch_request_immutable
BEFORE UPDATE OF dispatch_id, kingdom_id, lease_id, execution_id, task_id, attempt_no,
                 runtime_type, runtime_instance_ref, session_ref,
                 dispatch_request_snapshot, dispatch_input_ref_json, dispatch_payload_hash,
                 created_at
ON dispatch_records
BEGIN SELECT RAISE(ABORT, 'DISPATCH_REQUEST_IMMUTABLE'); END;

-- ★ 指令5：Dispatch 必须由 DB 验证 DISPATCH_READY + 全一致 Lease + 存在 Execution
CREATE TRIGGER IF NOT EXISTS dispatch_requires_ready_lease
BEFORE INSERT ON dispatch_records
BEGIN
  SELECT RAISE(ABORT, 'DISPATCH_REQUIRES_MATCHING_READY_LEASE')
  WHERE NOT EXISTS (
    SELECT 1
    FROM execution_leases l
    JOIN executions_v4 e ON e.execution_id = NEW.execution_id
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

-- ★ 指令8：dispatch transition matrix 硬编码 + ★ 指令7：evidence 前置
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

-- ★ 指令8：INSERT 状态守卫（Dispatch 只能 INTENDED 创建）
CREATE TRIGGER IF NOT EXISTS dispatch_insert_state_guard
BEFORE INSERT ON dispatch_records
WHEN NEW.state <> 'INTENDED'
BEGIN SELECT RAISE(ABORT, 'DISPATCH_INSERT_MUST_BE_INTENDED'); END;

CREATE TRIGGER IF NOT EXISTS dispatch_no_delete
BEFORE DELETE ON dispatch_records
BEGIN SELECT RAISE(ABORT, 'DISPATCH_NO_DELETE'); END;
```

### 1.5 `executions_v4`（重建形态，含 I-7 + RECOVERING + FK）

```sql
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

-- ★ 指令5：Governed Execution 必须关联「存在且一致」的 Lease + GRANTED+ENFORCED Decision
CREATE TRIGGER IF NOT EXISTS execution_governed_consistency
BEFORE INSERT ON executions_v4
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

-- ★ 指令4：execution_contract 不可变
CREATE TRIGGER IF NOT EXISTS execution_contract_immutable
BEFORE UPDATE OF execution_contract ON executions_v4
BEGIN SELECT RAISE(ABORT, 'EXECUTION_CONTRACT_IMMUTABLE'); END;
```

---

## 2. 二次 Review 9 个穿透点闭合表（v6 实测）

| 穿透点（Owner 实测发现） | v6 修复 | 实测 |
|---|---|---|
| 只更新 retired_at 退役，is_current 仍 1 | CHECK 强制 (is_current,retired_at) 联合一致性 | ✅ E-1d |
| 退役后更新 is_current=0 被 identity trigger 拒 | is_current 移出 identity immutable，归 retirement trigger 专管 | ✅ E-1b/E-1c |
| UPDATE Lease 的 worker/session/task/attempt 成功 | `lease_identity_immutable` | ✅ E-5a/E-5b |
| 插入无 evidence 的 GRANTED+ENFORCED 成功 | decision CHECK：GRANTED→evidence 非空+json_valid | ✅ E-7 |
| UPDATE Decision 的 kingdom/task/worker 成功 | `capability_decision_immutable` 覆盖全部身份字段 | ✅ E-8a/E-8b |
| Governed Execution 用不存在的 Lease/Decision 成功 | executions_v4 FK + `execution_governed_consistency` | ✅ E-11a/E-11b |
| Dispatch 用不存在的 Execution 成功 | dispatch FK(execution_id) + ready trigger | ✅ E-13 |
| INSERT 后修改 Dispatch task/session/hash 成功 | `dispatch_request_immutable` | ✅ E-15 |
| Dispatch 无 Terminal Evidence 直接 TERMINAL | dispatch state guard evidence 前置 | ✅ E-17 |

**v6 额外发现并闭合（写进文档的实测量）**：INSERT 直写 `RELEASED`/`TERMINAL` 可绕过 UPDATE-only 状态 guard → 补 INSERT 状态守卫（E-19a/E-19b）。

---

## 3. 不变量总表（v6 实测状态）

| 不变量 | 实现 | 实测 |
|---|---|---|
| I-1 one-active-lease-per-session（完整 identity） | 部分唯一索引（state≠RELEASED） | ✅ A-10/A-11 |
| I-2 一 Lease=一 Attempt | UNIQUE(task_id,attempt_no) + identity immutable | ✅ E-5 |
| I-3 Dispatch 必有 active（READY）Lease 且一致 | FK + ready trigger（存在+READY+全一致） | ✅ A-13/A-14/A-15/A-20 |
| I-4 GRANTED⇔ENFORCED | 行内双向 CHECK | ✅ A-1..A-6 |
| I-5 Affinity 不可改绑 | identity immutable + UNIQUE(session identity) | ✅ A-7/A-8/A-9 |
| I-6 execution_contract 枚举 | CHECK + contract immutable | ✅ A-17/E-19 |
| I-7 Governed 必有存在且一致的 Lease+Decision | FK + consistency trigger | ✅ E-11/E-12 |
| I-8 状态机不放宽 | 硬编码 transition guard + INSERT 守卫 | ✅ A-12/E-19 |
| I-9 Final Decision 不可改写 | decision immutable + execution 单绑 + UNIQUE(execution_id) | ✅ A-18/A-19/E-9/E-10 |
| I-10 冗余关系一致性 | dispatch/execution 全一致 trigger | ✅ A-15/E-12/E-13/E-14 |
| **I-11 Lease↔Current Affinity↔Task Territory 闭环** | lease.territory_id + acquire trigger | ✅ E-3/E-4 |
| **I-12 一 Worker 当前一 Session** | affinity_one_current_per_worker | ✅ E-2 |
| **I-13 Ledger 不可 DELETE** | 四表 BEFORE DELETE | 脚本含（未单列） |

---

## 4. TX 流程（v6，与状态矩阵完全一致，含 Receipt/Correlation）

```text
TX-0D  preflight/resolution DENY
       写 DENIED Decision（NOT_ATTEMPTED）· 无 Lease / Execution / Dispatch
TX-A   原子 acquire Lease（ACQUIRED）
       同时验证 current Affinity + Task Territory（I-11）
TX-1   写 Enforcement Plan（typed envelope）
       ACQUIRED → PREPARING → MATERIALIZING（两次合法推进，同一事务）
       COMMIT → 之后才 materialize 首次 mutation
TX-2S  materialize 成功
       写 GRANTED+ENFORCED Decision + Evidence
       Lease late-bind capability_decision_id
       MATERIALIZING → DISPATCH_READY
TX-2F  materialize 失败
       写 DENIED Decision（FAILED）
       cleanup 成功：写 release evidence → RELEASED（zero execution）
       cleanup 不明：→ RECOVERING（Lease 保留，session 禁新 lease）
TX-3   写 Execution（GOVERNED_PERSISTENT + lease_id + decision_id）
       回填 Decision.execution_id（单绑，GRANTED+ENFORCED only）
       写 Dispatch INTENDED（request snapshot + input ref + payload hash）
       DISPATCH_READY → EXECUTING
       COMMIT = DISPATCH COMMIT POINT → 之后才 RuntimeAdapter.dispatch()
TX-3R  写 runtime_dispatch_ref + Receipt（typed envelope + receipt_at）
       INTENDED → DISPATCHED → RECEIVED
       写 runtime_execution_ref → CORRELATED
       不确定 → RECOVERING
TX-4   写 Terminal Evidence（typed envelope + terminal_at）
       Dispatch → TERMINAL
       Execution → terminal state
       Lease EXECUTING → SETTLING
TX-5   settlement 完成
       SETTLING → RELEASING
       写 cleanup/teardown evidence（release_evidence_json + release_reason）+ released_at
       RELEASING → RELEASED
```

**完整性闭环**：TX-3 补了 `Decision.execution_id` 回填（Owner 指出 v5 缺失）；TX-3R 补了 Receipt/Correlation 事务边界；TX-5 补了 release evidence 字段与前置。**E-21 实测完整 TX 序列通过全部 transition guard 并达终态**。

---

## 5. Backfill（v5 三条 fail-closed 条件保留）

```text
B-1 旧 executions 全部 LEGACY_COMPAT
B-2 不自动生成 Affinity（不反推治理事实）
B-3 不伪造 Lease/Decision/Dispatch 历史
B-4 NULL ceiling → LEGACY_UNMANAGED
B-5 旧 role_bindings.session_id 不自动升级 governed Session
B-6 无显式 Affinity 的 Session 不得进入 GOVERNED_PERSISTENT
B-7 NULL ceiling 的 Kingdom 不得进入 GOVERNED_PERSISTENT
```

---

## 6. FK 连接级强制（★ 阻塞 7）

`PRAGMA foreign_keys` 是**每连接运行时设置**，不是持久 Schema 状态。施工与运行必须：

```text
F-1 每次打开 Kingdom DB 连接：任何事务开始前执行 PRAGMA foreign_keys=ON
F-2 立即读取 PRAGMA foreign_keys 并断言 = 1（fail-loud，不静默继续）
F-3 所有测试连接同样开启（含新开连接复验 —— 实测 E-20）
F-4 migration 后运行 PRAGMA foreign_key_check（须为空）+ integrity_check
```

---

## 7. 验收矩阵 + 实测结果（★ 指令 9）

**验证脚本**：`D:\dsh\research\M3-S2-SQLITE-VERIFY\m3s2_v6_verify.py`（随 v6 一并提交，零持久化 :memory:，可重跑）。

### 7.1 实测结果（49/49 PASS）

```text
== 第一组：原 v5 20 项保留（v6 DDL 下）==
  PASS  A-1..A-20  （GRANTED 组合 6 项 / affinity 3 项 / lease 互斥 2 项 / 跳转 1 项
                    / dispatch 3 项 / execution 2 项 / decision 2 项 / 合法链路 1 项）
== 第二组：Owner 扩展测试（v6 新增，29 项）==
  PASS  E-1a..E-1d  Affinity retire 一致性（联合转换/不可恢复/不可二次/不可保留 current）
  PASS  E-2         同 Worker 第二个 current Affinity 拒绝
  PASS  E-3/E-4     Lease 无 matching Affinity / Territory 与 Task 不一致 拒绝
  PASS  E-5a/E-5b   Lease identity/task/worker UPDATE 拒绝
  PASS  E-6a/E-6b   Lease plan/decision rebind 拒绝
  PASS  E-7         GRANTED 无 Enforcement Evidence 拒绝
  PASS  E-8a/E-8b   Decision kingdom/task UPDATE 拒绝
  PASS  E-9         DENIED Decision 绑定 execution 拒绝
  PASS  E-10        同一 execution 绑定两个 Decision 拒绝
  PASS  E-11a/E-11b Governed Execution 不存在 Lease/Decision 拒绝
  PASS  E-12        Execution 与 Lease task/attempt 不一致拒绝
  PASS  E-13        Dispatch 不存在 Execution 拒绝
  PASS  E-14        同一 Lease 第二个 Dispatch 拒绝
  PASS  E-15        Dispatch request/hash UPDATE 拒绝
  PASS  E-16        无 Receipt 进入 RECEIVED 拒绝
  PASS  E-17        无 Terminal Evidence 进入 TERMINAL 拒绝
  PASS  E-18        无 release evidence 进入 RELEASED 拒绝
  PASS  E-19a/E-19b INSERT 状态守卫（Lease=ACQUIRED / Dispatch=INTENDED）
  PASS  E-20        FK 在新连接生效
  PASS  E-21        完整 TX 序列通过全部 transition guard 达终态
== 结果 ==  PASS 49 / 49  ALL PASS
```

**实测发现（事实）**：
- ① INSERT 可绕过 UPDATE-only 状态 guard（直写 RELEASED/TERMINAL）→ v6 已补 INSERT 守卫（E-19）。
- ② `lease_requires_matching_affinity` 硬编码引用 `tasks` 表——真实 schema 即如此，隔离测试库必须建同名表（不是 DDL 缺陷）。

### 7.2 Migration / Crash 测试（施工后必跑，本轮未执行）

```text
M-1  v3→v4 数据逐行保持（executions 重建核对行数/主键/状态）
M-2  重复开库幂等（ensureSchemaV4 版本 gate）
M-3  中途失败全量 rollback（单事务）
M-4  sqlite_master DDL 与预期一致（含 15+ trigger）
M-5  PRAGMA foreign_key_check 为空（foreign_keys=ON）
M-6  PRAGMA integrity_check = ok
M-7  旧 Execution 全部 LEGACY_COMPAT
M-8  旧 session_id 未生成 Affinity（B-5）
M-9  NULL ceiling 王国未进入 GOVERNED（B-7）

C-1  TX-1 前 crash → Runtime 无 mutation
C-2  materialize 后、TX-2 前 crash → Lease 不释放（RECOVERING）
C-3  TX-2 后、TX-3 前 crash → cleanup/recovery
C-4  TX-3 后、receipt 前 crash → reconcile(dispatch_id)，不盲发
C-5  TX-4 前 crash → 不 settle
C-6  cleanup 未确认（TX-5 前）→ Session 不能取得下一 Lease
C-7  两个 reconciler 并发 → 只有一个合法状态推进
```

---

## 8. 文档层修正（二次 Review §12）

```text
1. 数量表述修正：4 张新 Core Ledger 表 + executions 重建（增 3 列）+ tasks/kingdoms 各 1 个 ADD COLUMN
   （不再称「5 个 ADD COLUMN」；transition rule 已硬编码，Schema 数量 = 4 新表，非 6）
2. Gate 修正：v6 Owner APPROVED → 授权实施 M3-S2 migration+Domain → Migration/DB/Domain tests+regression+evidence
   → Owner 验收 M3-S2 implementation → 才授权进入 M3-S3（设计批准 ≠ M3-S2 完成）
```

---

## 9. 明确不做（防越权）

```text
✕ 不在正式 kingdom.db 执行 migration（等 Owner 三次 Review）
✕ 不新建 runtime_bindings / capability_grants / DSH 事件表 / transition 规则表
✕ 不把 MessageId/turn/guard/cwd 设计成 Kingdom 永久 Schema
✕ 不进入 M3-S3
✕ 不为便利 Schema 推翻 M3-S1 冻结语义
```

---

# 待 Owner 三次 Review

v6 已按九项指令全部修订，并在 SQLite 内存库实测 **49/49 PASS**（脚本随 v6 提交，可重跑复验）。请 Review：

1. 九项指令对照（§0）+ 9 穿透点闭合（§2）；
2. Affinity retirement/current 一致性 + one-current-per-worker（I-12）；
3. I-11 Lease↔Affinity↔Task Territory 闭环；
4. 硬编码 transition trigger + INSERT 守卫 + 完整 immutability + DELETE 保护；
5. TX-0D..TX-5（含 TX-3 的 Decision.execution_id 回填、TX-3R Receipt/Correlation、TX-5 release evidence）；
6. 三组验收矩阵（§7）+ 实测 49/49。

**Review 通过后**：授权实施 M3-S2 migration + Domain → Migration/DB/Domain tests + regression + evidence → Owner 验收 M3-S2 implementation → 才授权进入 M3-S3。
