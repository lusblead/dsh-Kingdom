# M3 Capability Governance — 设计稿 v1（APPROVED_WITH_REFINEMENTS 后）

> 状态：**设计冻结稿（等待 Owner Review）**。裁决已下：`APPROVED_WITH_REFINEMENTS → M3 Capability
> Governance design authorized`。本稿只解决四件事（用户指定）：Capability Vocabulary v1 /
> Policy Resolver / ToolPermissionAdapter Contract / Evidence & Gate。不写实现。
> M3 第一条设计不变量：**能力需求属于 Task，授权属于一次 Dispatch，实际能力属于 Execution。**

---

## 1. 冻结裁决记录（全部采纳）

| # | 裁决 | 状态 |
|---|---|---|
| ① | 三层分离：`Task.capability_requirements`（非权威需求）→ `Dispatch.capability_grant`（Supervisor 本轮授权）→ `Execution.effective_capabilities`（Runtime 实际强制）；**Grant 生命周期 = 单次 Execution**（终态自然失效，无 revoke daemon） | ✅ |
| ② | 制度 B：`Effective = Supervisor Grant ∩ Owner Ceiling ∩ Runtime Enforceable Set`；Territory 不参与资格、参与 **Scope** | ✅ |
| ③ | **CWD ≠ security boundary**（负知识）；filesystem 可做真边界（root scope），shell 仅有 initial cwd 无 containment 时判 `CAPABILITY_ENFORCEMENT_UNAVAILABLE` | ✅ |
| ④ | 六条解耦不变量（M3 Constitution） | ✅ |
| ⑤ | 不新增独立 Supervisor grant/revoke 命令（grant 绑 `kingdom_start_task(task_id, capability_grant=[...])`）；**Owner Ceiling 允许独立 Trusted Admin Plane：`kingdom_set_capability_ceiling`（仅真实 OWNER）** | ✅ |
| ⑥ | Execution 三层不可变快照（requirement/ceiling/grant/scope/effective，JSON）+ 独立列 `capability_decision`（GRANTED/PARTIAL/DENIED）+ `enforcement_status`（ENFORCED/UNAVAILABLE/FAILED）；**GRANTED+UNAVAILABLE 禁止进入 Execution → zero execution** | ✅ |
| ⑦ | Fail-closed 为 M3 最高不变量：resolve → ceiling → scope → runtime enforcement，任何一步无法证明 → DENY → 不创建 Worker run | ✅ |
| ⑧ | 事件语义 v1 冻结为「one authoritative decision → one evidence event，状态变化与事件事务一致」；不引入幂等协议 | ✅ |

## 2. M3 Constitution（六条解耦不变量，冻结）

```text
1. Agent Tool ≠ Role
2. Territory ≠ Permission Principal
3. Capability Grant ≠ Worker Identity
4. Capability Decision Event ≠ Runtime Enforcement
5. Capability Requirement ≠ Capability Grant
6. Requested Capability ≠ Effective Capability
```

## 3. Capability Vocabulary v1（只选可证明边界的）

### 3.1 DSH Runtime 强制能力事实（本稿核查，2026-08-18）

| DSH seam | 能力 | 证据 |
|---|---|---|
| `SubagentStartRequest.toolFilter` | 工具级移除（子 agent 创建窗口 `tools.restrict()`，prompt 与执行双面消失；未知名 fail-loud） | dsh-subagent types.ts / M1-C 已用 agentOptions 同 seam |
| `SandboxMode = read-only \| workspace-write \| danger-full-access` | **文件效果（写）限制**：read-only 仅必要 sinks；workspace-write 允许 workspace root + backend temp；danger-full-access 绕过 | sandbox/index.ts:23-29 |
| **"Network and process visibility are outside this vocabulary"** | **网络/进程可见性不在沙箱词汇内** | sandbox/index.ts:26-27 |
| `SandboxExecutionPolicy`（mode + workspaceRoot + sessionId） | 每次 capability 调用解析一次政策 | sandbox/index.ts:39-52 |
| `SandboxEnforcement = 'full' \| 'partial'` | **官方 enforce/cannot-enforce 判定**："partial = active backend/旧内核 ABI 无法治理全部承诺的文件效果；要求绝对边界的调用方不得视为 full" | sandbox/index.ts:54-59 |
| `sandbox/mode` 会话事件（log-only、durable、replayable、**可 delegation 播种到子会话**） | 沙箱模式可随子 agent 派发播种（M3 Grant→Dispatch 的现成通道） | sandbox-policy/session-mode.ts |
| escalation（`EscalationApprover`、`approveEscalation`） | danger 操作需审批的现成 seam | sandbox/escalation.ts |
| Windows ACL（per-workspace write SID）/ Linux landlock | workspace-write 的 OS 级强制后端 | sandbox-windows-acl / landlock launcher |

### 3.2 v1 候选清单

| Capability | Scope | 可证明边界？ | v1 结论 |
|---|---|---|---|
| `filesystem.write` | `territory.workspace_path` 子树 | ✅ workspace-write 模式 + full enforcement（ACL/landlock OS 级） | **v1 收录** |
| `filesystem.read` | workspace 内读；**读全局不受沙箱词汇约束**（沙箱只管写效果） | 🔶 读的 containment 无法由 SandboxMode 证明 | v1 收录但 scope 如实声明「写限 workspace、读不设界」；或留 v1.1 |
| `shell.execute` | initial cwd = workspace；**写效果可被 workspace-write 继承**（进程树 ACL/landlock）；**读全局、网络无限制** | 🔶 部分：写边界可证明；读/网络不可 | v1 收录为「shell.execute(write-scoped)」；`shell.execute(网络)` → CANNOT_ENFORCE → DENY |
| `network` | — | ❌ 沙箱词汇外，DSH 无网络沙箱 | **v1 排后**（留到 Runtime 提供网络边界后） |
| `git`（经 shell） | 随 shell 语义 | 🔶 | 并入 shell 处理，不单列 |

> 原则（用户裁决）：**绝不为功能数量把 shell 标成"Territory-scoped"**——Runtime 只能给 cwd 不能 containment 时，明确留后。

## 4. Policy Resolver（公式与算法，冻结方向）

### 4.1 公式

```text
Effective Capability
= Supervisor Grant(Dispatch)
∩ Owner Ceiling(王国)
∩ Runtime Enforceable Set(Runtime)
```

Territory 不参与资格判定；参与 **Scope 绑定**：

```text
filesystem.write + territory.workspace_path → filesystem.write(D:\project-A\**)
```

### 4.2 解析算法（fail-closed 为最高不变量）

```text
resolve(task, dispatch_grant, ceiling, territory, runtime_adapter):
  1. requirements = task.capability_requirements        （非权威，仅参考）
  2. for each cap in dispatch_grant:
       a. cap ∈ ceiling?                 否 → CAPABILITY_DENIED(来源=ceiling)
       b. scope = bind(cap, territory.workspace_path)   （Territory scope 绑定）
       c. runtime_adapter.ask(cap, scope) → enforce | cannot-enforce
          cannot-enforce                  → CAPABILITY_DENIED(来源=runtime)
  3. enforcement_status:
      全 enforce   → ENFORCED
      任一 UNAVAILABLE/FAILED → 该项拒绝；**GRANTED+UNAVAILABLE 组合禁止进入 Execution**
  4. capability_decision = GRANTED | PARTIAL | DENIED
  5. 任一步无法证明 → DENY → **不创建 Worker run（zero execution）**
```

**禁止的路径（冻结）**："当前 DSH 无法限制 shell 到 workspace，但问题不大，继续运行并给 warning"——**M3 中不存在**。

## 5. ToolPermissionAdapter Contract（DSH 事实映射）

### 5.1 判定接口（冻结）

```ts
interface ToolPermissionAdapter {
  /** 每项 grant 的强制能力判定：enforce（可证明）/ cannot-enforce（不可证明，拒绝）。 */
  ask(cap: CapabilityV1, scope: CapabilityScope): 'enforce' | 'cannot-enforce'
  /** 完整度来源（DSH SandboxEnforcement 的直译）。 */
  enforcement: 'full' | 'partial'
}
```

映射规则（冻结）：
- `toolFilter` → 工具级 enforce（capabilities 检查 + fail-loud 未知名）；
- `SandboxMode`（workspace-write）+ `SandboxEnforcement=full` → 文件写 scope enforce；
- `SandboxEnforcement=partial` → **视为 cannot-enforce**（要求绝对边界不得视为 full，DSH 原文）；
- 网络 → cannot-enforce（词汇外，v1 拒绝）。

### 5.2 Grant 播放入口（冻结）

```text
kingdom_start_task(task_id, capability_grant = [ {...} ])   ← Supervisor，scope-aware（M2 已就绪）
  ↓ resolve（§4）→ DENY 则零执行
  ↓ DshSubagentExecutor 扩展：agentOptions + toolFilter + sandbox mode 播种
```

`kingdom_set_capability_ceiling`（仅真实 OWNER，Trusted Admin Plane）→ 王国级 JSON 政策，
事件 `CAPABILITY_CEILING_UPDATED`（actor=OWNER，与 M1-B/M2 管理事件同审计口径）。

## 6. Evidence & Gate（什么证据才允许声称"真的被限制住了"）

### 6.1 Execution 不可变快照（Schema v4 候选）

```text
executions 新增（v4）：
  capability_requirement_snapshot  JSON   （Task 需求，非权威）
  capability_ceiling_snapshot      JSON   （授权时 Owner Ceiling）
  capability_grant_snapshot        JSON   （Supervisor 本轮 grant）
  capability_scope_snapshot        JSON   （Territory scope 绑定结果）
  effective_capability_snapshot    JSON   （Resolver 最终结果）
  capability_decision              TEXT   （GRANTED/PARTIAL/DENIED）  ← 独立列
  enforcement_status               TEXT   （ENFORCED/UNAVAILABLE/FAILED）  ← 独立列
```

### 6.2 证明门槛（Gate 冻结方向）

1. **ENFORCED 才有资格声称**：GRANTED + UNAVAILABLE 组合不存在于任何 Execution；
2. **零执行**：任何 DENY → 无 run 创建（dispatch 拒绝证据事件 `CAPABILITY_DENIED` 恰一次）；
3. **真实验证据**（对应 M1-D/M2-F 方法论）：workspace 外写入被 OS 级拒绝（ACL/landlock 实测）；
4. **对抗矩阵**：Worker 无自授 / 超 Ceiling 授权 DENY / scope 外路径 DENY / partial enforcement DENY；
5. **诚实标注**：`filesystem.read` 若无读 containment 证据，scope 必须声明"读不设界"，不得暗示受限。

## 7. 待 Owner Review 裁决点

| # | 裁决点 | 推荐 |
|---|---|---|
| 1 | Vocabulary v1 = `filesystem.write`（workspace-scoped）+ `shell.execute`（write-scoped，读/网络如实不设界）；`filesystem.read` 是否收录（读全局语义）或留 v1.1；`network` v1 排后 | 批准 |
| 2 | Resolver 算法 §4.2（fail-closed 顺序 + GRANTED+UNAVAILABLE 禁入） | 批准 |
| 3 | ToolPermissionAdapter 映射（partial enforcement 视为 cannot-enforce） | 批准 |
| 4 | Grant 绑 `kingdom_start_task`；Ceiling 独立 `kingdom_set_capability_ceiling`（OWNER-only） | 批准 |
| 5 | Schema v4：7 字段（5 JSON 快照 + 2 独立列） | 批准 |
| 6 | Gate = §6.2 五项证明全 PASS（含 workspace 外写入 OS 级拒绝实测） | 批准 |

> 评审通过后：实现 → 测试 → M3 Gate（真实验证据）→ v0.8.0（或并入后续版本）发布 + 知识同步。
