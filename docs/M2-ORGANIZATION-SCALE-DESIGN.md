# M2 Organization Scale — 设计冻结稿 v2（APPROVED_WITH_REQUIRED_REVISIONS 已修订）

> 状态：**冻结（Owner Review 修订已全部采纳）**。四项核心修订：①未指派 Territory fail-closed
> ②Binding DELETE→RETIRED tombstone ③Territory topology 纳入 Trusted Admin Plane ④Schema v3
> 承载历史身份与 scope 真实性。修订完成，**可直接实施**（无需第二轮批准）。v0.6.0 保持稳定基线。

---

## 1. 阶段划分与依赖（不变）

M2-A Topology → M2-B Ledger → M2-C Multi-Worker → M2-D Handoff → M2-E Scope → M2-F Gate（v0.7.0）。

## 2. 角色基数 + Binding 生命周期（M2-A，修订 ②）

### 2.1 基数（不变）

OWNER×1 / CHANCELLOR×1 / SUPERVISOR×N / WORKER×N。
API：`getBindingByRole` 弃用 → `getBindingsByRole()`（只返回 ACTIVE）+ `getBindingById()`（任意状态，历史解析）。
Singleton 是 Domain Policy：`SINGLETON_ROLES = ['OWNER','CHANCELLOR']` 创建第二个 **ACTIVE** 时拒绝；
SUPERVISOR/WORKER 允许多 ACTIVE。

### 2.2 Binding tombstone（修订 ②，冻结）

```text
role_bindings
├─ status          ACTIVE | RETIRED   （默认 ACTIVE）
├─ retired_at
└─ retired_reason
```

- `unbindRole()`：**DELETE → ACTIVE→RETIRED**（+ retired_at/retired_reason；reason 默认 '换届/解职'）；
- `getBindingsByRole()` / `getBindingByRole()`：只返回 ACTIVE；
- `getBindingById()`：任意状态——历史引用（task_assignments/executions/events.actor_id/territories.supervisor_binding_id）**始终可解析**（名字/角色/ExecutionProfile/退任时间）；
- 被引用任务的旧语义保留：展示层对 RETIRED 绑定显示"已退任"，治理操作因缺 ACTIVE 绑定明确报错。

## 3. Territory Scope（M2-A/M2-E，修订 ①③）

### 3.1 边界不变量（不变）

Role=治理权力、Territory=资源/上下文 scope；绝不变成权限层级。

### 3.2 未指派 Territory fail-closed（修订 ①，冻结）

```text
有 supervisor_binding_id → 只有该 Supervisor 可治理（scope relation）
无 supervisor_binding_id → 无 Supervisor 可治理 → TERRITORY_SUPERVISOR_MISSING（fail-closed）
```

**缺省权限配置绝不扩大权限**（与 M1 fail-closed 原则一致）。

### 3.3 v2→v3 兼容 backfill（冻结）

```text
迁移时：
  王国恰好 1 个 ACTIVE Supervisor → 所有 supervisor_binding_id IS NULL 的 Territory 自动 backfill
  0 个 ACTIVE Supervisor        → 保持 NULL（fail-closed）
```

v2 本就是 singleton Supervisor，老用户升级基本无感；新模型保持"不知道谁管就不允许任何人代管"。

### 3.4 Territory tombstone（修订 ④，冻结）

```text
territories.status: ACTIVE | ARCHIVED | DELETED
+ deleted_at
+ deleted_reason
```

- `deleteTerritory()`：物理删行 → tombstone（status=DELETED + deleted_at/reason）；force 级联语义保留
  （未终态任务 FAILED + 活跃执行 ABORTED + 事件留痕）；
- 历史任务/Assignment/Event 的 territory_id **永远可解析**（"Deleted Territory 仍可解析历史任务归属"）。

### 3.5 Topology Administration Plane（修订 ③，冻结）

```text
Topology Administration（session-bound 下 Trusted OWNER only）:
├─ territory.create
├─ territory.delete
├─ territory.set_supervisor
├─ binding.bind
├─ binding.retire（unbind）
└─ execution_profile.set

日常治理职权（不变）:
plan（CHANCELLOR）/ assign / start / review（SUPERVISOR scope-aware）
```

`kingdom_create_territory` / `kingdom_delete_territory` 当前**未接入 requireAdmin**（审计发现）——
M2 冻结：Territory 是组织拓扑本身，纳入 Trusted Admin Plane；新增 `territory.set_supervisor`
（修改 Territory 主理 Supervisor，OWNER-only）。

## 4. Assignment Ledger（M2-B，修订 ④ + 补强不变量）

### 4.1 表结构（不变 + 数据库层不变量）

```sql
CREATE TABLE IF NOT EXISTS task_assignments (
  assignment_id          TEXT PRIMARY KEY,
  task_id                TEXT NOT NULL,
  territory_id           TEXT NOT NULL,
  worker_binding_id      TEXT NOT NULL,
  assigned_by            TEXT NOT NULL,          -- Supervisor binding_id
  assigned_at            TEXT NOT NULL,
  ended_at               TEXT,
  end_reason             TEXT,                   -- 'handoff' | 'task-terminal'（REWORK 不关闭）
  previous_assignment_id TEXT,
  handoff_reason         TEXT,
  created_at             TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_assignment_per_task
  ON task_assignments(task_id) WHERE ended_at IS NULL;   -- 数据库层堵死双 active
CREATE INDEX IF NOT EXISTS task_assignments_task_idx ON task_assignments(task_id);
```

**数据库层不变量**：一个 Task 最多一个 active assignment（partial unique index）——
`tasks.assigned_binding_id` 与 Ledger 永远不会出现两个"当前事实"。

### 4.2 Core 事务内不变量（冻结）

`previous_assignment_id` 必须：
- 属于同一个 `task_id`；
- 已关闭（ended_at NOT NULL）；
- 不能指向自身；
- HANDOFF 时新 assignment 的 worker 与当前 active 不同。

### 4.3 Assignment 生命周期（修订，冻结）

```text
REWORK            → Assignment 保持 ACTIVE（同 Worker 新 attempt——不是重新派遣）
HANDOFF           → 旧 CLOSED（end_reason='handoff'）+ 新 CREATED（previous 链）
Task terminal     → 当前 CLOSED（end_reason='task-terminal'）
显式 reassignment → 未来（M2 范围外）
```

## 5. Multi-Worker（M2-C，裁决 5 修订）

### 5.1 并发边界（不变）

✅ 不同任务并发 + 显式派给；❌ 无自动调度/拆分/负载均衡/swarm。

### 5.2 workerBindingId 规则（裁决 5，冻结——不永远必填）

```text
0 active Workers                     → WORKER_BINDING_MISSING
1 active Worker + omitted            → 自动使用唯一 Worker（兼容 v0.6 自然语言体验）
N > 1 active Workers + omitted       → WORKER_AMBIGUOUS（必须显式指定）
显式提供                             → 永远按指定 Worker（校验 ACTIVE + 属于当前王国）
```

`getBindingsByRole('WORKER')` 供 Supervisor 显式选择；同一任务并发守卫保留。

## 6. HANDOFF（M2-D，裁决 4 批准 + 原子性要求）

```text
reviewTask(decision='HANDOFF', to_binding_id, reason)
→ 原子事务：
    ① 验证 Supervisor scope（task.territory 主理）
    ② 验证目标 Worker（ACTIVE、属于当前王国、≠当前 assignment worker）
    ③ 验证当前 active assignment
    ④ 关闭 Assignment A（end_reason='handoff'）
    ⑤ 创建 Assignment B（previous=A, handoff_reason=reason）
    ⑥ 更新 tasks.assigned_binding_id
    ⑦ REVIEW → RUNNING（既有转移）
    ⑧ 写 TASK_HANDED_OFF（actor=SUPERVISOR, payload 含新旧 assignment/reason）
    任一步失败 → 全部 ROLLBACK
```

Worker B 上下文：原 Task + 验收 + Worker A 最新 Claim + artifacts + risks + handoff reason + Supervisor instruction
（`buildWorkerPrompt` 扩展，与 REWORK 注入同构）。不新增 Task 状态。

## 7. Schema v3（裁决 6，修订 ④，冻结）

```text
Schema v3
├─ task_assignments（表 + one_active_assignment_per_task 唯一索引 + task_idx）
├─ role_bindings.status / retired_at / retired_reason（tombstone）
├─ territories.deleted_at / deleted_reason（tombstone；status 已存在，语义扩展 DELETED）
├─ Territory supervisor backfill（1 ACTIVE Supervisor → NULL scope 领地 backfill；0 → fail-closed）
└─ SCHEMA_VERSION 2 → 3（事务化幂等迁移，失败 ROLLBACK；新库直接 v3）
```

`role_bindings 零 DDL` **取消**（修订 ②）。迁移顺序：加列/建表/索引 → backfill → verify → version bump。

## 8. v0.7.0 Scale Gate（M2-F，裁决 7 扩充）

### 8.1 原有六项（保留）

1. 不同 Worker 不同 ExecutionProfile 同时执行不同任务（并发证据列独立）；
2. Supervisor A 不能治理 Territory B（TASK_OUT_OF_SCOPE）；
3. Worker A 不能冒充 Worker B；
4. Handoff 历史不丢失（Ledger 链 + Claim/Execution 全量可查）；
5. 换届后旧 Supervisor 失去职权（scope 重算）；
6. Task/Assignment/Claim/Execution/Review 完整追溯。

### 8.2 新增验收（冻结）

```text
Topology
- Stranger / Worker / Supervisor 创建或删除 Territory → DENY
- 只有 OWNER 可以改 Territory Supervisor

Scope
- 未指派 Territory → 所有 Supervisor DENY（TERRITORY_SUPERVISOR_MISSING）
- Supervisor A → Territory B DENY
- Supervisor 退任后立即 DENY
- 新任接管后 PASS

Ledger
- 一个 Task 不可能出现两个 active assignments（DB 唯一索引 + 测试）
- REWORK 不产生新 Assignment
- HANDOFF 关闭旧 + 创建新（previous 链正确）
- Task terminal 关闭 active Assignment

History
- Retired Worker 仍能通过历史 Binding 解析（名字/角色/Profile/退任时间）
- Retired Supervisor 仍能回答"谁当时做了裁决"（events.actor_id 可解析）
- Deleted Territory 仍可解析历史任务归属

Compatibility
- v2 单 Supervisor + NULL scope → v3 自动 backfill
- v0.6 单 Worker assign 不传 worker_binding_id → 仍正常
```

## 9. 裁决记录（Owner Review，2026-08-18）

| # | 项目 | 裁决 | 状态 |
|---|---|---|---|
| 1 | SUPERVISOR/WORKER ×N | 批准，Binding 生命周期必须同时改（tombstone） | ✅ 采纳（§2.2） |
| 2 | Territory Scope | 有条件批准，未指派 Territory fail-closed（TERRITORY_SUPERVISOR_MISSING）+ backfill | ✅ 采纳（§3.2/3.3） |
| 3 | Assignment Ledger | 批准 + 补强不变量（one-active 唯一索引 / previous 约束 / REWORK 不关闭） | ✅ 采纳（§4） |
| 4 | HANDOFF 并入 reviewTask | 批准（原子事务） | ✅ 采纳（§6） |
| 5 | workerBindingId | 不批准原案 → "多 Worker 时必填"（0/1/N 规则） | ✅ 采纳（§5.2） |
| 6 | Schema v3 | 批准版本升级，内容扩大（role_bindings tombstone + territory tombstone + backfill） | ✅ 采纳（§7） |
| 7 | v0.7.0 Gate | 批准 + 增加安全/历史项（Topology/Scope/Ledger/History/Compatibility） | ✅ 采纳（§8.2） |
| 追加 | Territory 属于 Admin Plane | 冻结（territory.create/delete/set_supervisor + binding + profile 全 OWNER-only） | ✅ 采纳（§3.5） |

> **实施授权**：本冻结稿生效即实施（无需第二轮批准）。v0.7.0 发布以 §8 Gate 全 PASS 为硬条件。
