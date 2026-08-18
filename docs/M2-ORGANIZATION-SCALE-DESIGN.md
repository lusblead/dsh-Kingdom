# M2 Organization Scale — Scope & Architecture & Schema Design（冻结稿 v1）

> 状态：**设计冻结稿（等待 Owner Review）**——按用户裁决只做设计，不改数据库/代码/GUI。
> v0.6.0 保持稳定基线；冻结通过后再决定 v0.7.0 实现。
> 命题：**Kingdom 从一条治理链升级为可横向扩展的 Agent 组织。**

---

## 1. 阶段划分与依赖（用户裁决，冻结）

```text
M2-A Organization Topology     角色基数、Territory 归属/Scope、Binding 生命周期
  ↓
M2-B Assignment Ledger         不可变任务派遣历史（Handoff/多人协作的前提）
  ↓
M2-C Multi-Worker              多 Worker、不同任务并发、显式选 Worker（无自动调度器）
  ↓
M2-D Handoff                   Worker A → Supervisor 裁决 → Worker B（基于 Ledger）
  ↓
M2-E Multi-Supervisor + Territory Scope   横向扩展不破坏治理
  ↓
M2-F Scale Gate                v0.7.0 Release Gate（多会话/多 Worker/多 Territory 对抗式 E2E）
```

## 2. 角色基数（M2-A，冻结）

| 角色 | 基数 | 语义 |
|---|---|---|
| OWNER | ×1 | 常驻所有者（Trusted Admin Plane 承载者） |
| CHANCELLOR | ×1 | 规划职权（plan） |
| SUPERVISOR | ×N | 每个 Supervisor 治理一个/多个 Territory（scope） |
| WORKER | ×N | 每个 Worker 独立 ExecutionProfile（M1 已就绪） |

**API 迁移**：

```text
getBindingByRole('WORKER')      → 弃用（singleton 假设）
getBindingsByRole(roleType)     → 新增（返回数组）
getBindingById(bindingId)       → 保留（M1 已用）
```

**Singleton 是 Domain Policy，不是 API 偶然限制**：
- `bindRole`：OWNER/CHANCELLOR 创建第二个时**拒绝**（现有"同角色已存在"逻辑保留并强化为 policy 常量 `SINGLETON_ROLES = ['OWNER','CHANCELLOR']`）；
- SUPERVISOR/WORKER：允许 N 个绑定；`getBindingsByRole` 供派发/展示/scope 使用。

**绑定生命周期**：unbind 语义不变（OWNER 保护）；换届/改绑走 Trusted Admin Plane（M1-B 已收口）。

## 3. Territory Scope Model（M2-A/M2-E，冻结）

### 3.1 边界不变量（用户裁决）

```text
Role = 治理权力
Territory = 资源 / 工作上下文 Scope
```

**Territory 绝不重新变成权限层级**：`Supervisor A may govern Territory A` 与
`Worker B may execute in Territory A` 是 **scope relation**，不是
`Territory > Supervisor > Worker` 继承树。模型/Agent 工具/Runtime/Role/Territory 保持解耦。

### 3.2 v1 模型（激活既有列）

- `territories.supervisor_binding_id`（列已存在，从未写入）→ **激活为 Territory 主理 Supervisor**；
- Territory 创建时可选指定 supervisor_binding_id；缺省 = 未指派（全局 Supervisor 可治理，见 3.3）；
- **Supervisor scope**：`requireRole('SUPERVISOR')` 升级为 `requireRoleInScope(territoryId)`——
  该 Supervisor 必须等于 task.territory 的 supervisor_binding_id（或未指派时任意 Supervisor）；
- **Worker scope**：v1 不做 worker↔territory 硬绑定——Worker 的执行范围由 Supervisor 的 scope 决定
  （Supervisor 只能把其 scope 内领地的任务派给 Worker）。这是 scope relation 的最简 v1；
  worker↔territory 显式归属留 v1.1（若 Scale Gate 暴露需求）。

### 3.3 未指派领地的治理

未指派 supervisor 的领地 = 任意 SUPERVISOR 可治理（兼容 v0.6 单 Supervisor 迁移路径）；
指派后：**跨领地拒绝**（新错误码 `TASK_OUT_OF_SCOPE`），换届/改派经 Trusted Admin Plane。

## 4. Assignment Ledger（M2-B，冻结）

### 4.1 新表 `task_assignments`（权威派遣历史）

```sql
CREATE TABLE IF NOT EXISTS task_assignments (
  assignment_id          TEXT PRIMARY KEY,
  task_id                TEXT NOT NULL,
  territory_id           TEXT NOT NULL,
  worker_binding_id      TEXT NOT NULL,
  assigned_by            TEXT NOT NULL,          -- Supervisor binding_id（谁决定派发）
  assigned_at            TEXT NOT NULL,
  ended_at               TEXT,                   -- 关闭时间（handoff/换人/终态）
  end_reason             TEXT,                   -- 'handoff' | 'rework' | 'task-terminal' | ...
  previous_assignment_id TEXT,                   -- 前序派遣（链表）
  handoff_reason         TEXT,                   -- Supervisor 的转交理由（handoff 时）
  created_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_assignments_task_idx ON task_assignments(task_id);
```

### 4.2 投影与历史分离

```text
tasks.assigned_binding_id  = 当前状态投影（方便查询，语义不变）
task_assignments           = 权威派遣历史（可答：之前派给谁/谁决定/为什么/几轮）
```

写入路径：
- `assignTask`（首派）：创建 assignment（previous=null）；
- `handoff`（M2-D）：旧 assignment CLOSED（end_reason='handoff', ended_at）→ 新 assignment（previous=旧 id）；
- 任务终态（DONE/FAILED）：当前 assignment CLOSED（end_reason='task-terminal'）。

与既有历史面并列（用户确认的结构一致性）：

```text
Task.status        = 当前治理事实
Executions         = 运行事实历史
Worker Results     = Claim 历史
Assignments        = 派遣事实历史
Events             = 审计事件流
```

## 5. Multi-Worker（M2-C，冻结）

### 5.1 并发边界（用户裁决）

```text
✅ 支持：不同任务并发执行（每个 Execution 独立 one-shot；每个 Worker 独立 ExecutionProfile）
✅ 支持：显式派给（Task 1 → Worker A，Task 2 → Worker B）
❌ 不做：自动调度器 / 任务自动拆分 / load balancing / swarm / 并发冲突解决
```

### 5.2 派发面

- `assignTask`：**workerBindingId 变必填**（多 Worker 下无默认 Worker）；
  `getBindingsByRole('WORKER')` 供 Supervisor 选择；校验 worker 属于当前王国（已有）；
- 同一任务不允许并发执行（现有 latestExecution 活跃守卫保留）；
- GUI：任务操作区列出候选 Worker（KingdomOpsPanel 的 assign 按钮从单选变下拉选择）。

### 5.3 执行面

- `resolveWorkerExecution` 已按 `assigned_binding_id → binding → ExecutionProfile` 解析（M1 就绪，零改动）；
- 证据列已按 Execution 行独立记录（M1 就绪）——不同 Worker 并发执行不同任务天然可追溯。

## 6. Handoff（M2-D，冻结）

### 6.1 语义：治理事件，不是赋值操作

```text
Worker A Attempt 1 → Claim/artifacts/risks
  ↓
Supervisor 审查 → 裁定 HANDOFF（reason = "需要前端能力"）
  ↓
Assignment A CLOSED（end_reason='handoff'）
Assignment B CREATED（previous=A, handoff_reason=...）
  ↓
task: REVIEW → RUNNING（复用既有转移，不新增状态）
  ↓
Worker B Attempt 2（上下文见 6.2）
```

### 6.2 Worker B 的上下文清单（冻结）

```text
原 Task
验收标准
Worker A 最新 Claim（summary）
已有 artifacts
risks
Handoff reason
Supervisor instruction（可选补充）
```

实现：`buildWorkerPrompt` 扩展注入 handoff 上下文（与 REWORK 注入同构）；
事件：`TASK_HANDED_OFF`（actor=SUPERVISOR，target=task，payload 含新旧 assignment、reason）。

### 6.3 状态机影响

不新增 Task 状态：HANDOFF = REVIEW→RUNNING 转移（现有 `TASK_TRANSITIONS.REVIEW` 已含 RUNNING）；
`reviewTask` 的 decision 集合 `['ACCEPT','REWORK','FAIL']` 扩展 `'HANDOFF'`（+ 新工具或并入 review）。
设计取舍：并入 `reviewTask(decision='HANDOFF', to_binding_id, reason)` 最贴合"治理事件"语义
（HANDOFF 是 Supervisor 对 Claim 的裁定之一），不新增独立工具面。

## 7. Schema v3（冻结）

| 变更 | 类型 | 说明 |
|---|---|---|
| `task_assignments` 新表 | 建表 | 权威派遣历史（4.1） |
| `territories.supervisor_binding_id` | 语义激活 | 列已存在（v1 schema），无 DDL |
| 索引 `task_assignments_task_idx` | 建索引 | IF NOT EXISTS |
| `SCHEMA_VERSION` 1→2→**3** | 版本 | 复用事务化幂等迁移（ensureSchemaV2 泛化）：

```text
BEGIN IMMEDIATE
  CREATE TABLE IF NOT EXISTS task_assignments (...)
  CREATE INDEX IF NOT EXISTS ...
  verify 表/列/索引存在（缺失即抛错）
  UPDATE kingdoms SET schema_version = 3
COMMIT（失败 ROLLBACK）
```

- 旧库 v2 → v3 开库即收敛；新库直接 v3；
- `role_bindings` 零 DDL（多绑定本就允许，只是业务层此前拒绝）。

## 8. v0.7.0 Scale Gate（M2-F，冻结）

### 8.1 验收图（v0.7.0 命题）

```text
                    OWNER
                      │
                 CHANCELLOR
                      │
          ┌───────────┴───────────┐
          │                       │
    Territory A             Territory B
          │                       │
   Supervisor A             Supervisor B
      │       │                 │
   Worker A Worker B          Worker C
      │       │                 │
    Task 1  Task 2            Task 3
```

### 8.2 对抗式证明项（全 PASS 才发布 v0.7.0）

1. 不同 Worker 使用不同 ExecutionProfile → **同时执行不同任务**（并发证据列独立）；
2. Supervisor A **不能治理** Territory B 的任务（`TASK_OUT_OF_SCOPE`）；
3. Worker A **不能冒充** Worker B（身份矩阵扩展：多 Worker 下的 start/claim 归属）；
4. Worker A → Worker B Handoff → **历史不丢失**（task_assignments 链 + Claim/Execution 全量可查）；
5. 换届后旧 Supervisor **失去职权**（scope 重算）；
6. 所有 Task / Assignment / Claim / Execution / Review → **完整追溯**（四条历史面 + 事件流）。

### 8.3 实验设计（沿用 M1-D 方法论）

- lib 级：多绑定矩阵（2 Supervisor × 2 Territory × 3 Worker × 并发任务）；
- 真实执行：两个 Worker（不同 ExecutionProfile）**并发**执行两个任务 + 一次真实 Handoff；
- 迁移：v2 旧库 → v3 收敛验证。

## 9. 待 Owner Review 裁决点

| # | 裁决点 | 推荐 |
|---|---|---|
| 1 | SUPERVISOR/WORKER 多绑定放行（singleton 改为 Domain Policy） | 批准 |
| 2 | Territory Scope v1 = 激活 `territories.supervisor_binding_id`；worker↔territory 硬绑定留 v1.1 | 批准 |
| 3 | Assignment Ledger 表结构（含 previous/handoff_reason 链表） | 批准 |
| 4 | HANDOFF 并入 `reviewTask(decision='HANDOFF', to_binding_id, reason)`，不新增 Task 状态 | 批准 |
| 5 | assignTask workerBindingId 变必填（多 Worker 无默认） | 批准 |
| 6 | Schema v3（task_assignments 表 + 版本迁移，role_bindings 零 DDL） | 批准 |
| 7 | v0.7.0 Gate = 8.2 六项证明全 PASS（M2-F） | 批准 |

> 按 M1-C 同款流程：本稿 Owner Review 通过后，才进入实现（不改 v0.6.0 稳定基线）。
