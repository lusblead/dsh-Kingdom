# M3 Capability Governance — 设计稿 v2（APPROVED_WITH_BLOCKING_REVISIONS 后）

> 状态：**冻结稿 v2（等待 Owner 最终 Review）**。第二轮裁决已采纳：两个上游 seam 阻塞事实
> 写入负知识；Vocabulary 收窄为单项；Resolver 删除 PARTIAL；Adapter 重构为两阶段契约；
> Schema v4 改为 Capability Decision Ledger；升级兼容规则冻结；Gate 扩至 9 项。
> **M3-D Runtime Enforcement = BLOCKED_BY_CURRENT_DSH_SEAM——绝不假装实现。**

---

## 1. 两个上游 seam 阻塞事实（负知识，冻结）

### B-1：DSH 无 per-child sandbox mode 公开 start seam

```text
SubagentStartRequest 可传：agentOptions / outputSchema / maxDepth / toolFilter / persona / …
        ✕ 没有 sandboxMode
in-process child 的 sandbox = 捕获父 Session 已有的 explicit override
        → sandbox/mode(source=delegation) 在 child 创建前完成
        ✕ 调用 subagents.start() 时无法传新的 per-run policy
        ✕ child 发布后立即执行 prompt，无"run 返回后补 sandbox policy"窗口
```

**结论**：设计稿 v1 的"Supervisor Grant → DshSubagentExecutor → sandbox mode 播种"以当前公开
seam **不能直接实现**。当前 DSH adapter 必须诚实返回
`CANNOT_ENFORCE: DSH_PER_CHILD_SANDBOX_OVERRIDE_UNAVAILABLE`——**不 fork Core 假装存在**。

### B-2：toolFilter 不是完整 Capability Security Boundary

```text
ToolRestriction.allow/deny 只过滤 global tools；
scoped registrations 不受 restriction 影响；
run_code 等 reserved transport 不能被 restriction 命名。
```

**结论**：装了其他 DSH 插件 / agent preset 注册 scoped tool 后，`toolFilter.allow=[…]` 存在治理旁路。
**M3 不把 toolFilter 当最终强制边界。**

## 2. M3 阶段与裁决状态（Owner Review 2026-08-18）

```text
M3-A Capability Constitution        ✅ APPROVED
M3-B Policy Resolver                ✅ APPROVED_WITH_REFINEMENT
M3-C Runtime Adapter Contract       ⚠️ REVISE（本稿 v2 已修订）
M3-D Runtime Enforcement            ⛔ BLOCKED_BY_CURRENT_DSH_SEAM
Schema v4                           ⚠️ REVISE（本稿 v2 已修订为 Decision Ledger）
Release Gate                        ⚠️ EXPAND（9 项，本稿 v2）
```

施工顺序（冻结）：M3-A Capability Model → M3-B Policy Resolver → M3-C Runtime Adapter /
upstream seam → **确认可 enforce 之后**才公开 `capability_grant`。

## 3. Capability Vocabulary v1（单项，冻结）

```text
Capability Vocabulary v1 = { filesystem.write }
```

- **scope = Territory.workspace_path**；`filesystem.write(D:\project-A\**)`。
- **证据措辞精确**（G9 来源）：DSH FS surface 的写路径 fence 是
  **"trusted in-process path containment"**（fs-sandbox：canonicalize → workspace writable roots
  → 仅允许范围内 mutation；**read 全放行，只对 write/edit 做 fence**）——**不是 OS kernel sandbox**，
  不得混写。
- `filesystem.read` → v1.1+（DSH 明确 every mode permits reading——把无法 Territory-contain
  的能力放进 v1 会污染"Effective 真的可强制"命题）。
- `shell.execute` → v1 移出。未来定义为**复合能力**（workspace-scoped write + unrestricted host
  read + unrestricted network 三项残留 authority），**只有 Owner 明确接受全部三项**才能授权；
  未经接受即授权 = 违反 fail-closed。

## 4. Policy Resolver（v2：删除 PARTIAL）

### 4.1 公式（不变）

```text
Effective Capability = Supervisor Grant ∩ Owner Ceiling ∩ Runtime Enforceable Set
Territory 只参与 Scope 绑定；不参与资格。
```

### 4.2 决策口径（v2 冻结）

```text
capability_decision  = GRANTED | DENIED      （授权是否合法——安全决策，无 PARTIAL）
requirement_coverage = FULL | PARTIAL | NONE （Task 需求满足多少——非权威参考）
enforcement_status   = ENFORCED | UNAVAILABLE | FAILED
```

**规则**：`GRANTED + UNAVAILABLE` 组合**禁止产生 Execution**（zero execution）；
`requirement_coverage` 只是信息字段，不赋予 Requirement 权威性（未来硬前置用
`required/optional` 另行裁决，现在不偷偷加）。

### 4.3 解析算法（fail-closed 最高不变量，不变）

```text
resolve(task, dispatch_grant, ceiling, territory, adapter):
  1. requirements = task.capability_requirements_json        （非权威）
  2. ceiling = kingdoms.capability_ceiling_json
     ceiling IS NULL → LEGACY_UNMANAGED（见 §7），不进入强制路径
  3. for each cap in dispatch_grant:
       cap ∈ ceiling?                否 → DENY(来源=ceiling)
       scope = bind(cap, territory.workspace_path)
       plan = adapter.preflight(cap, scope)
       plan = CannotEnforce        → DENY(来源=runtime)
  4. adapter.materialize(plan)     失败 → zero child / zero Execution（DENY）
  5. decision = GRANTED（全 enforce）| DENIED
  6. DENY → capability_decisions 留存 + CAPABILITY_DENIED 事件 + execution_id=NULL + zero run
```

## 5. ToolPermissionAdapter Contract（v2：两阶段）

```ts
interface CapabilityRuntimeAdapter {
  /** 阶段一：当前 provider/runtime 能否真强制？产出不可变计划或诚实 cannot-enforce。 */
  preflight(request: CapabilityRequest): EnforcementPlan | CannotEnforce
  /** 阶段二：在 child publication **之前**原子落计划；失败 = zero child / zero Execution。 */
  materialize(plan: EnforcementPlan, dispatchContext: DispatchContext): EnforcedDispatchConfig
}
```

- `EnforcementPlan` 不可变；`materialize` 原子（child 发布前落 policy，发布即带正确 policy）；
- **materialize 失败 → 不 start**（fail-before-publication）；
- 当前 DSH adapter（`DshCapabilityAdapter`）对需要 per-run sandbox narrowing 的请求
  **诚实返回** `CANNOT_ENFORCE: DSH_PER_CHILD_SANDBOX_OVERRIDE_UNAVAILABLE`；
- 可 enforce 面（当前 seam 实况）：`toolFilter`（global-tools 面，标注其边界）+ fs-sandbox
  写路径 fence（trusted-path containment，ENFORCED 声明时带证据类型标签）。

## 6. Schema v4（Decision Ledger，替代 v1 的 7 字段方案）

新表 `capability_decisions`（M2 Assignment Ledger 同构——**能力裁决事实**）：

```sql
CREATE TABLE IF NOT EXISTS capability_decisions (
  decision_id            TEXT PRIMARY KEY,
  kingdom_id             TEXT NOT NULL,
  task_id                TEXT NOT NULL,
  worker_binding_id      TEXT,
  supervisor_binding_id  TEXT,
  requirement_snapshot   TEXT,          -- Task 需求（非权威）
  ceiling_snapshot       TEXT,          -- 授权时 Owner Ceiling
  proposed_grant_snapshot TEXT,         -- Supervisor 本轮 grant
  scope_snapshot         TEXT,          -- Territory scope 绑定结果
  effective_snapshot     TEXT,          -- Resolver 最终结果
  decision               TEXT NOT NULL, -- GRANTED | DENIED
  enforcement_status     TEXT NOT NULL, -- ENFORCED | UNAVAILABLE | FAILED
  reason_code            TEXT,
  execution_id           TEXT,          -- GRANTED+ENFORCED 时回填；DENIED 为 NULL
  created_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS capability_decisions_task_idx ON capability_decisions(task_id);
```

三处挂载列：

```text
kingdoms.capability_ceiling_json     TEXT NULL   （NULL = LEGACY_UNMANAGED，见 §7）
tasks.capability_requirements_json   TEXT NULL
executions.capability_decision_id    TEXT NULL   （GRANTED+ENFORCED 后回填）
```

数据流：

```text
GRANTED + ENFORCED → 创建 Execution → executions.capability_decision_id = decision_id
DENIED / UNAVAILABLE → decision 行留存 + CAPABILITY_DENIED 事件 + execution_id = NULL + zero run
```

结构并列（治理事实五面）：Assignments（派遣）/ Executions（运行）/ WorkerResults（Claim）/
Events（审计流）/ **CapabilityDecisions（能力裁决）**。

## 7. 升级兼容规则（冻结）

```text
kingdoms.capability_ceiling_json = NULL
  → LEGACY_UNMANAGED（明确状态，不是"默认全允许"）
  → 旧王国按 v0.7 行为运行；snapshot 明确标注 capabilityGovernance = inactive

Owner 执行 kingdom_set_capability_ceiling(...) 之后
  → ceiling != NULL → capabilityGovernance = ENFORCED
  → start_task 必须走 Capability Resolver（fail-closed）

显式提供 capability_grant 但 governance 尚未激活
  → CAPABILITY_GOVERNANCE_NOT_CONFIGURED（绝不静默忽略 grant）
```

## 8. Release Gate（9 项，冻结）

原 5 项保留：①ENFORCED 才有资格声称；②zero execution；③workspace 外写实测拒绝；
④对抗矩阵（无自授/超 Ceiling/scope 外/partial enforcement DENY）；⑤诚实标注。

新增 4 项：

```text
G6 Scoped Tool Bypass：注册 agent-scoped test tool 越权写文件 → 必须被挡
   （DSH ToolRestriction 明确不影响 scoped registrations——挡不住 = Gate FAIL，
    即 M3-D 未达成，不允许声称能力治理成立）
G7 并发隔离：Task A（write grant）与 Task B（no-write grant）同时运行 →
   A 的 policy 绝不污染 B（DSH sandbox delegation 从 parent override 捕获，
   是必须实测的风险点）
G8 Escalation 不可扩大权限：Worker 请求 danger-full-access / escalation → DENY，
   不能绕过 Ceiling（delegated child 的既有设计：scope 启动时固定，approval 操作自动拒绝）
G9 证据类型不混淆：DSH fs mutation = trusted-path-fence；shell process write =
   kernel/process sandbox——分测分记，不得统一写成 OS_SANDBOX
```

## 9. DSH Upstream Capability Gap Contract（供上游提案/后续对接）

Kingdom 需要 DSH 提供（按优先级）：

```text
1. per-child sandbox mode / policy override（SubagentStartRequest 级公开 seam）
2. creation-time all-tool guard（覆盖 global + scoped + composite transport，不只是 toolFilter）
3. enforcement evidence（child 实际生效 policy 的可信回执——对应 requested/effective 分离）
4. fail-before-publication semantics（materialize 失败则 child 不发布）
```

> Discussion 3085（M3 平台显示修复）不覆盖以上四条——值得作为独立上游提案补充；
> 在 seam 落地前，M3-D Runtime Enforcement 保持 BLOCKED，**不为赶 v0.8.0 假装实现**。

## 10. 裁决记录（第二轮，全部采纳）

| # | 项目 | 裁决 | 状态 |
|---|---|---|---|
| B-1/B-2 | 上游 seam 阻塞事实 | 写入负知识 | ✅ |
| ① | Vocabulary v1 = filesystem.write 单项；read/shell 移出；证据措辞 trusted-path containment | ✅ |
| ② | Resolver 删 PARTIAL；requirement_coverage 独立（FULL/PARTIAL/NONE） | ✅ |
| ③ | Adapter 两阶段 preflight/materialize；诚实 CANNOT_ENFORCE | ✅ |
| ④ | Grant/Ceiling 入口概念批准；grant 公开须待 seam 确认 | ✅ |
| ⑤ | Schema v4 = capability_decisions + 三挂载列 + execution.capability_decision_id | ✅ |
| ⑥ | LEGACY_UNMANAGED / ENFORCED / NOT_CONFIGURED 兼容规则 | ✅ |
| ⑦ | Gate 扩至 9 项（G6-G9） | ✅ |
