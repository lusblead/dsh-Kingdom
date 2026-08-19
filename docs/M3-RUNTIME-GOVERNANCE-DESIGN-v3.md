# M3-S1 Kingdom Runtime Governance Design v3（DESIGN FROZEN / OWNER APPROVED）

> 状态：**M3-S1 DESIGN FROZEN / OWNER APPROVED**（2026-08-19）。Stage 1–5 全部 OWNER_APPROVED_WITH_BLOCKING/REFINEMENT 并已落实。
> 依据：Owner 2026-08-19 架构裁决（M3-S0 ACCEPTED/CLOSED）+ Stage 1–5 分阶段裁决；全局经验 skill `kingdom-architecture` v1.0.0；
> 继承：`M3-CAPABILITY-GOVERNANCE-DESIGN.md` v2（冻结）、`DSH-SESSION-DISPATCH-AUDIT.md`（冻结）。
> 规格强制：**双层规格**——每个实质章节分 `A. Kingdom Contract`（Kingdom 要求 Runtime 提供什么语义）与
> `B. DSH Mapping`（dsh-Kingdom 如何用 DSH primitive 满足）。日后 Codex/OpenCode/Claude Code Mapping 平行新增，不改 Core。
> 红线：本稿为冻结实现依据；**DDL/表名/索引/migration number 全部归 M3-S2**；不触碰正式 Schema、不动 kingdom.db、不改 DSH、不发布；L3B `NOT_AUTHORIZED`。
> 审计判据（Stage 1 冻结）：**「若把 DSH 换成另一 Runtime，该 Kingdom 概念是否仍成立？」**——不成立则大概率不属于 Core。

---

## 0. 文档定位与本轮裁决目标

本稿取代「怎么让 dsh-Kingdom 的 Worker 更安全地执行」的旧 M3 语义，回答：

> **Kingdom 如何用 Runtime-independent Contract 治理一个长期 Agent Runtime Session，并由 DSH Adapter 给出第一套真实实现。**

覆盖 Owner 裁决 §18 所列 17 项（下按 §1–§17 逐项对应）。每一处「Kingdom Contract / DSH Mapping」分开写，禁止实现泄漏进 Core。

---

## 1. Kingdom / dsh-Kingdom 边界（裁决项 1）

### A. Kingdom Contract

- **Kingdom** = 跨 Runtime 的 Agent Governance Control Plane，Runtime-independent Domain Model。
  凡进入治理域的执行，必须可 **识别 / 授权 / 限制 / 关联责任 / 形成证据 / 进入账本**。
- **dsh-Kingdom** = 该模型的最小可运行 Reference Implementation + 第一套 Runtime Adapter 实验场。
- 长期稳定核心（方向文档既已冻结）＝ Authority / Scope / Assignment / Execution Evidence / Claim Verification / Ledger / Context Governance。
- 五层心智模型（冻结）：`5 Experience → 4 Context Governance → 3 Governance Core → 2 Runtime Control → 1 Agent Runtime`；Kingdom 价值在 **2+3+4**。

### B. DSH Mapping

- 当前 dsh-Kingdom 落在 DSH 上：DSH = 第一块真实 Runtime pressure test；M1/M2/M3 在 dsh-Kingdom 完成，**不代表这些能力属于 DSH**。
- Runtime Adapter Contract 是第一抽象层，DSH 原语（preset/guard/sandbox/approval/session）只进 adapter。

---

## 2. Worker / Runtime Binding / Session 关系（裁决项 2）

### A. Kingdom Contract

```text
Worker（长期组织身份/Binding）
   │ binds to
Runtime Binding {…}   ← 当前是「逻辑关系」，非已冻结独立数据实体
   │
   ▼
Runtime Session（实际运行身份，随 Runtime 可变）
```

- 永久不变量（冻结）：`Role ≠ Binding ≠ Runtime ≠ Runtime Session ≠ Model ≠ Assignment ≠ Execution`。
- Worker 责任历史跨 Session 连续；同一 Worker 未来可 2026-08→DSH Session、2026-12→另一 Runtime Session，责任链不因 Session 变更而中断。
- **Stage 1 硬约束（OWNER）**：`Runtime Binding` 当前只是 Worker↔Runtime/Session 的**逻辑关系**；设计图里出现这个框，**不等于未来一定有一张 `runtime_bindings` 表**。是否正式抽实体，待「第二个真实需求」（如同 Worker 并发多 Session / 多 Runtime 并存）出现后再裁决。

### B. DSH Mapping

- dsh-Kingdom 现有 `role_bindings.runtime_type / session_id / model_name / agent_name / session_meta` 已能承载最低 Runtime Binding 语义，v3 **继续复用**，不当场新建 `dsh_worker_sessions` 之类 DSH 专用对象。

> **本设计结论（供 §13 引用）**：v3 **不抽独立 RuntimeBinding 表**——`Runtime Binding` 保持为逻辑关系，落地于 `role_bindings.runtime_type + session_id`，待第二个真实 Runtime Adapter 落地时再做抽离裁决（避 speculative abstraction）。

#### `session_meta` 边界（Stage 1 冻结：opaque metadata）

- `session_meta` = **Runtime Adapter 自己管理的扩展数据**。
- **Kingdom Core 不得**逐步写入 `session_meta.xxx === …` 并据 DSH 特有字段做治理判断。
- 如未来需结构，用 versioned / namespaced JSON，但 **Core 原则上只把 Runtime-specific 内容当 opaque metadata**。
- 一个具体禁止：**不得为「同 Worker 多 Session」把多个 Session 塞进 `session_meta`**（那正是被禁止的架构债务）。

---

## 3. Territory affinity（裁决项 3）

### A. Kingdom Contract

- **Territory affinity 是 Kingdom canonical fact（治理事实）**，不是从 Runtime 状态反推而来的派生物。
- 核心不变式（Stage 1 冻结）：`Runtime observation ≠ Governance Fact`；与 `Chat ≠ Ledger` 同一原则。
- 一个长期 Runtime Session 有**且仅有**一个 Territory affinity；不允许带历史上下文的 Session 跨 Territory 漂移。
- 理由（不仅是 filesystem 权限）：Session = 长期上下文容器；即使 B 的权限正确，A 的历史上下文仍可泄入 B。
- 此为 Kingdom Runtime Governance 规则，非 DSH 专属。

### B. DSH Mapping

- DSH 的 `session.header.cwd` 是 workspace-write 的写边界（M3-S0 E 组实证：界内写成功、界外被拒）。
- **方向（Stage 1 裁决）**：Kingdom canonical state 先记录 `Session S → Territory T`；DSH Adapter 再**验证** `S.header.cwd == T.workspace_path`。
  - `Territory affinity` = 治理事实；`cwd` = **Runtime enforcement / verification evidence**。
  - 严禁把 `cwd` 当作 affinity 的事实源（否则 DSH cwd 配错时，Kingdom 会据错误 Runtime 状态改写治理事实）。

---

## 3bis. v3 Session 模型能力边界（Stage 1 冻结追加）

```text
Worker Binding
      │
      └── 当前最多一个 Persistent Runtime Session
                      │
                      └── exactly one Territory affinity
```

即 v3 冻结为：`Worker A → Session A → Territory A`。

- **v3 不支持**一个 Worker Binding 同时持有多个长期 Session（`Worker A → Session A→Territory A + Session B→Territory B`）= **DEFERRED**，待正式抽出 RuntimeBinding / Worker-Session Relation 实体时再裁决。
- **跨 Territory 迁移（Stage 1 冻结）**：不得把 Session A 的 cwd 改成 B 后继续用（= 跨 Scope 漂移）。
  正确路径 = Session A 永久属于 Territory A；Worker 需要去 Territory B 时，旧 Session A 不再作为当前 Session → 建立新 Session B → 显式留下历史证据，而非两个 Session 同时挂一个 Binding。
- **Stage 4 挂账（不 DDL，归 M3-S2）**：Territory affinity 的 canonical fact 须满足三点——①属 Kingdom Core fact；②不藏 `session_meta`；③不从 DSH cwd 反推。候选（不提前裁定）：`role_binding` 上的 current affinity，或独立 relation/ledger。

---

## 4. Execution Lease（裁决项 4）

### A. Kingdom Contract

**正式定义（Stage 2 冻结）**：Execution Lease = **Kingdom 对某个长期 Runtime Session 的一次执行占用权**。它回答：

```text
哪个 Worker，使用哪个 Session，为哪个 Task / Attempt，
在什么 Capability Decision 下，拥有当前这一次执行权。
```

**核心不变量（Stage 2 冻结）**：

```text
1. 一个 Runtime Session 最多一个 active Kingdom Execution Lease（DB 原子唯一约束）
2. 一个 Lease ↔ exactly one Task Attempt
3. 一个 governed Dispatch ↔ exactly one active Lease
   （禁止出现「Dispatch 已发生却找不到它属于哪个 Lease」）
```

并发安全（不靠 `if(!busy)` 先读后写）：

```text
acquire(session_id):
  SELECT busy? → false → INSERT         ✕ 禁止
  DB 原子 claim + DB 级唯一约束          ✓ 必须
```

**Lease 语义口径（Stage 2 冻结，防过度声称）**：

```text
Lease = Kingdom governed dispatch mutual exclusion
      （证明：同一 Session 不承载两个 Kingdom-managed Execution）

Lease ≠ Runtime 全局独占锁
      （不自动证明「DSH 世界里无人直接向该 Session 发消息」）
```

若未来要声称「Lease 期间 Session 绝不接受 Kingdom 外的 Dispatch」，须额外证明 Runtime ingress isolation（M3-S0 未证明这一点）。

**Release Lease 语义（Stage 2 收紧）**：release = 「该 Session 可安全接下一项 Kingdom 工作」，至少需：

```text
目标 Dispatch 已拥有可信 Terminal Evidence
+ 本 Execution 已 settle
+ Runtime 已确认不再执行这个 Dispatch
+ 本次临时 enforcement 已完成 teardown（或下次执行能确定性覆盖它）
```

- `terminal 但 cleanup 状态不明` → **不得**直接 release → 进入 recovery（Schema 表达留 Stage 4）。
- **Dispatch 尚未发生（materialize 失败，zero execution）** → cleanup → release Lease 是允许的，且 `zero Runtime Execution` 成立（与 fail-before-dispatch 兼容）。

---

### 4bis. 生命周期 + Dispatch Commit Point（Stage 2 冻结追加）

**Dispatch 前必须先留 Kingdom 持久事实**（否则可能重复 Dispatch）。完整顺序：

```text
validate
↓
resolve / preflight policy
↓
DENIED?
├─ yes → Decision Ledger，结束（zero execution）
└─ no
↓
acquire Lease（DB 原子 claim）
↓
prepare Runtime
↓
materialize Enforcement
↓
持久化 Execution
+ 持久化 Dispatch Intent
+ 生成 kingdom_dispatch_id（Kingdom ID，非 DSH MessageId）
↓
─────────────── COMMIT POINT ───────────────
↓
RuntimeAdapter.dispatch(...)                         ← 第一次产生 Runtime 外部副作用
↓
获得 Runtime Dispatch Reference
↓
持久化 Dispatch Receipt（acceptedAt）
↓
observe / correlate
↓
settle
↓
cleanup
↓
release Lease
```

- **`kingdom_dispatch_id`**（Stage 2 REQUIRED）：调用 Runtime **之前**已知、crash 后仍已知的稳定 ID；用于 Crash Correlation（`reconcile(kingdom_dispatch_id, …)`）。
- COMMIT POINT 之前任何一步崩 → Kingdom 知道「我原本准备派发什么」，不会盲发。

### B. DSH Mapping

- 对应 M3-S0 A+B 组：`create/resume（setup=per-Dispatch 装配）→ followup(消息) → whenIdle → dispose`。
- `kingdom_dispatch_id` → DshAdapter → DSH UserMessage / MessageId；其中 `DSH MessageId = runtimeDispatchRef`，或由 Adapter 保存对应关系（M3-S5 定实现）。**Kingdom Dispatch ID ≠ DSH MessageId**（换 Runtime 未必有 MessageId）。
- `whenIdle` = **runtime synchronization helper**，**不是**权威 Terminal Evidence；证明「本 Dispatch 已结束」靠 `dispatchRef → turn → terminal evidence`（MessageId → splice → turn/start → turn/end → assistant/message）。
- `prepare + materialize` 落在 resume 的 **setup**（scope 新建，须重挂 preset/guard）；`dispatch` = durable followup。
- 「acquire/release lease」由 dsh-Kingdom 的 lease ledger 保证互斥（Kingdom 侧事实），DSH 侧不感知 lease。

---

## 5. Capability Domain Model（裁决项 5）

### A. Kingdom Contract

**两层模型（Stage 3 冻结）**：

```text
Kingdom Governance Layer
────────────────────────
Capability Requirement（Task 描述可能需要什么 → 非权威）
Supervisor Grant（本 Attempt 实际授权什么 → 权威输入）
Owner Ceiling
Capability Scope（Territory 绑定）
        │  policy resolution
        ▼
Effective Capability
        │
        ▼
Runtime Enforcement Layer
────────────────────────
Runtime Enforceable Set（context-bound，见 §6）
Enforcement Request
Enforcement Plan
Enforcement Evidence
```

**永久语义闭集（Stage 3 REVISE：删除含糊的 `Capability Request`，拆为三概念）**：

```text
Capability Requirement   = Task 非权威自我描述（information only）
Supervisor Grant         = Supervisor 本 Attempt 实际授权（权威输入）
Enforcement Request      = Resolver 治理裁决完成后交给 Adapter 的强制执行请求
Owner Ceiling / Capability Scope / Runtime Enforceable Set
Enforcement Plan / Enforcement Evidence
```

- 核心公式（冻结）：`Effective Capability = Supervisor Grant ∩ Owner Ceiling ∩ Runtime Enforceable Set`。
- Territory 只参与 Scope 绑定，不参与资格判定；`Authority ≠ Capability`。
- `Supervisor Grant` 与 `Capability Decision` 是**两个不同事实**（见 §11）；Grant 即使最终被 DENY，仍是历史事实。
- Runtime 无法证明 enforce ⇒ DENIED + zero execution（禁止"提醒模型注意→继续执行"）。

**流转链（Stage 3 冻结）**：

```text
Task Requirement（information only）
        │
        ▼
Supervisor Grant
        ├── ∩ Owner Ceiling
        └── ∩ Runtime Enforceable Set（context-bound）
                 │
                 ▼
        Effective Capability
                 │
                 ▼
        Enforcement Request
                 │
                 ▼
        Adapter.preflight / materialize
```

### B. DSH Mapping

- DSH 的 materialization = Capability Model → adapter：
  `Preset`（面最小化）+ `tools.guard`（权威拒绝，body 不执行）+ `setSandboxMode('workspace-write')`（effect containment）+ `setApprovalPolicy('never')`（防扩权）。
- 记 `DshEnforcementEvidence`，不进入 Kingdom Capability Schema。

---

## 6. Runtime Enforceable Set（裁决项 6）

### A. Kingdom Contract

- **`Runtime Enforceable Set` 是 context-bound / per-execution 事实，不是 Adapter 的静态能力宣传表（Stage 3 REJECTED 静态常量表述）**。
- 语义接口：`capabilities(runtimeContext) → RuntimeEnforceableSet`，其中 context 至少含 `runtime / session / territory(scope) / runtime configuration`。
- 例（同一 Runtime 不同 Session）：Session A cwd 正确、sandbox 可装 → `filesystem.write` 可 enforce；Session B 状态异常、cwd 不匹配、seam 不可用 → 这次不能 enforce。
- **可以保留 Adapter 静态能力声明**（`Adapter Capability Declaration` / `Supported Capability Set`），但它只是「这个 Adapter 写过这种实现」，**不直接参与安全公式**；真正进入 `Effective Capability` 计算的必须是「这次 Execution 实际可 enforce 的集合」。

### B. DSH Mapping

```text
DshAdapter 静态声明（Capability Declaration，非安全公式输入）:
  filesystem.write → 理论上支持 → workspace-path containment（trusted in-process fence）

DshAdapter.capabilities(runtimeContext)（实际参与计算）:
  依据 session cwd 是否匹配 territory.workspace_path、sandbox/guard/preset seam 是否可用
  → 本次 context 下的 RuntimeEnforceableSet
```


---

## 7. Enforcement Plan / Evidence（裁决项 7）

### A. Kingdom Contract

```text
CapabilityRuntimeAdapter {
  capabilities(runtimeContext) → RuntimeEnforceableSet          // context-bound
  preflight(enforcementRequest, runtimeContext) → EnforcementPlan | CannotEnforce
  materialize(plan, runtimeContext) → MaterializationResult
}
```

**两阶段边界（Stage 3 冻结）**：

- `preflight` = **side-effect free planning/check**——只回答「能不能 enforce？计划是什么？」；**不得**改 sandbox、挂 guard、改 session、dispatch message。
- `materialize` = **actual runtime mutation**。

**materialize「原子」语义收窄（Stage 3 冻结，禁止声称跨系统 ACID）**：

```text
✕ materialize = Runtime 五个内部 mutation 物理不可分割（不存在跨系统 ACID transaction）
✓ materialize = fail-before-dispatch 语义：
    全部需要的 enforcement 成功建立 + 能形成足够 Enforcement Evidence
    → 才允许 dispatch
    任何 enforcement step 失败
    → 禁止 dispatch
```

- `MaterializationResult` 语义须能表达：`success / failure`、`effective enforcement`、`enforcement evidence`、`cleanup/teardown responsibility`（暂不冻结具体字段名）。
- **partial failure（Stage 3 冻结）**：如 `guard✓ sandbox✓ approval✕` → 不得 dispatch；Adapter 须尝试 cleanup/rollback：
  - cleanup 成功 → zero dispatch → release Lease；
  - cleanup 是否成功无法确认 → **不得假装环境干净**：Lease 保留、Execution/Lease 进 recovery path、禁止下一个 Dispatch（与 Stage 2「cleanup 不明不 release Lease」一致）。

### B. DSH Mapping

**两类 Enforcement Evidence 分开（Stage 3 冻结）**：

```text
A. Per-Execution Enforcement Evidence（每次执行）
   = 这一次执行实际装了什么 policy（guard installed / sandbox mode applied /
     approval policy applied / scope verified）
   来源：persistent runtime event / trusted in-process receipt / adapter-observed effective state
   （须标明证据类型；不要求每次执行都主动攻击自己一次）

B. Adversarial Gate Evidence（M3-S6 Release Gate，非每次生产必需）
   = 我们测试过这套 enforcement 确实挡得住攻击
   （调用被 guard 禁止的工具 → 拒绝 → body 未执行）
```

- `tools.guard 拒绝结果` 属于 **Gate Evidence**，不是每次 Execution 的必备 Per-Execution Evidence——Worker 本次没调用被禁工具，不代表没有 Enforcement Evidence。
- `EnforcementEvidence` 不得过度声称强度（Stage 3 冻结）：`trusted in-process fence` 就写 `trusted in-process fence`，不得升 `OS isolation / kernel sandbox`。
- 泛化字段 `enforcement_evidence_snapshot`（typed，含证据类型）/ `enforcement_plan_snapshot` 属 adapter 扩展结构，不升格为 Core 字段。

---

## 8. Dispatch Contract（裁决项 8）

### A. Kingdom Contract

```text
RuntimeAdapter.dispatch(execution, kingdomDispatchId) → DispatchReceipt
DispatchReceipt {
  kingdomDispatchId        // Kingdom 生成，dispatch 前已知
  runtimeType
  sessionRef
  runtimeDispatchRef       // Runtime 的接收回执（DSH 下 = MessageId）
  runtimeExecutionRef?     // Runtime 当场能给才填
  acceptedAt
}
```

- **语义（Stage 2 冻结）**：`DispatchReceipt` 只证明 **「Runtime 已可靠接受这次 Dispatch」**，**不等于任务完成证据**。
- `DispatchReceipt ≠ Terminal Receipt ≠ Execution Evidence`（三者不可混，见 §9）。

### B. DSH Mapping

- dsh-Kingdom 用 **durable followup** 实现 dispatch；`DSH MessageId = runtimeDispatchRef`（M3-S5 定落点）。
- Turn/Dispatch Receipt API 仍是 **DSH upstream enhancement**，但非 M3 blocker；落地前用 `kingdom_dispatch_id → MessageId → splice → turn` 链自建 Receipt。

---

## 9. Receipt / Correlation / Execution Evidence（裁决项 9）

### A. Kingdom Contract

**DispatchReceipt 与 Execution Evidence 分离（Stage 2 冻结）**：

```text
A. Dispatch Receipt（dispatch 时刻）
   = Runtime 已可靠接受的证明（见 §8）

B. Execution Evidence（生命周期逐步形成，四元链条）
   Dispatch Reference
        ↓
   Runtime Execution Reference
        ↓
   Terminal Evidence
        ↓
   Output Reference
```

- `DispatchReceipt ≠ Terminal Receipt`；Adapter 不得声称「dispatch() 返回了 = 完成证据已存在」。
- 证据链满足 Claim ≠ Fact：Worker 的 Claim 不得单方面成事实；关联证据来自持久事实，不来自 live 内存。

### B. DSH Mapping

- DSH 持久关联链 = `MessageId → inbox splice（insert/claim 删除型）→ turn/start → turn/end → assistant/message`。
- `agent/inbox/claimed` 是 live-only，**不得**作持久证据（负知识 C-010）；持久 claim 证据 = 删除型 splice + turn 边界。
- 这是 `DshRuntimeEvidenceProvider`，不是 Kingdom Execution Evidence Protocol。

---

## 10. Reconciliation / Crash Recovery（裁决项 10）

### A. Kingdom Contract

**Reconcile 两维结果（Stage 2 REVISE 后冻结，替代单枚举五态）**：

```text
RuntimeAdapter.reconcile(kingdomDispatchId, …) → ReconciliationResult {
  executionObservation: QUEUED | RUNNING | TERMINAL | UNKNOWN
  sessionObservation:   AVAILABLE | GONE | UNKNOWN
  evidence:             [...]
  terminalOutcome?:     …      // 仅 TERMINAL 时有
}
```

- **核心（Stage 2 冻结）**：`Session 是否存在` 与 `Execution 是否终止` 是**两个不同维度**，必须分开观察。
- **`SESSION_GONE ≠ TERMINAL`**：session=GONE + execution=UNKNOWN → 仍 RECOVERING + fail-closed，**不得**开新 attempt。
  只有 Adapter 能证明「Session 已永久不可继续 + 该 Dispatch 无未来恢复执行可能」时，才依证据把 Execution 结算为（如）ABORTED。
- **UNKNOWN 禁止超时自动 ABORT**（Stage 2 冻结）：不得「RECOVERING 超 30s/5min → 估计死了 → ABORTED → Attempt 2」。persistent Dispatch 可能仍在 Runtime durable queue。默认 `UNKNOWN → remain RECOVERING → no new dispatch`；未来仅 Owner 明确治理裁决（留事件+原因）可强制处置。

### B. DSH Mapping

- DSH Adapter reconcile 用：`kingdom_dispatch_id → session_id → dispatch MessageId → persistent log → turn boundary → assistant output`。
- 两维来源：`executionObservation` 从持久 splice/turn 边界推断；`sessionObservation` 从 session 是否可 resume 判定。二者独立、不得合并成单值。

---

### 10bis. `RECOVERING` 状态（裁决项 10 追加，Stage 2 APPROVED）

**语义（严格）**：`RECOVERING` = **Kingdom 当前无法确认该 Execution 的真实 Runtime 状态，正在重新建立证据**。

**它不代表**：

```text
✕ Worker 正在「恢复任务」（不是任务状态）
✕ Runtime 一定仍在运行
✕ Task 状态发生了治理变化
```

分层（Stage 2 冻结）：

```text
Task.status          = 治理事实（Claim ≠ Fact）
Execution.state      = Kingdom 对运行事实的认知状态（RECOVERING 属此层）
```

- Task 不得因 Execution 进入 RECOVERING 而自动 `FAILED / PAUSED / REWORK`。
- **进入规则**：unfinished Execution + host重启；或 Adapter 失联；或 Dispatch 有 Intent 但 Receipt/terminal evidence 不完整。
- 进入时：`Execution → RECOVERING`，且对应 Session **禁止获得新 Lease / 新 Dispatch**，直到 reconciliation 证据足够。
- **转出**：reconcile 出可信 `executionObservation=TERMINAL`（+ terminalOutcome）才转出；`SESSION_GONE` 不构成转出条件。

---

## 11. Capability Decision Ledger（裁决项 11）

### A. Kingdom Contract

- 能力裁决是治理事实（Assignments / Executions / WorkerResults / Events / **CapabilityDecisions** 五面并列）。
- **Capability Decision = 最终安全裁决（Stage 3 冻结），不是「授权意图」**：

```text
capability_decision  = GRANTED | DENIED       （安全决策，无 PARTIAL）
requirement_coverage = FULL | PARTIAL | NONE  （信息字段，非授权字段，不影响权限）
enforcement_status   = ENFORCED | NOT_ATTEMPTED | UNAVAILABLE | FAILED
```

- **`GRANTED ⇔ ENFORCED`**：`GRANTED` 代表「Governance 授权合法 + Runtime enforcement 已成功 materialize」。**唯一合法 GRANTED 组合 = `GRANTED + ENFORCED`**。

**合法/禁止组合（Stage 3 冻结）**：

| capability_decision | enforcement_status | 含义 | 合法 |
|---|---|---|---|
| GRANTED | ENFORCED | 允许执行（授权合法且已 enforce 成功） | ✓ |
| DENIED | NOT_ATTEMPTED | 治理层已拒（Ceiling/Authority/Scope），无需尝试 Runtime | ✓ |
| DENIED | UNAVAILABLE | Runtime 无法 enforce | ✓ |
| DENIED | FAILED | 原可 enforce，materialize 实际失败 | ✓ |
| GRANTED | UNAVAILABLE / FAILED / NOT_ATTEMPTED | — | ✕ 禁止 |

- **删除 `GRANTED + UNAVAILABLE`**（Stage 3 REJECTED）：若 EnforceableSet 无此 Capability，则 `Grant∩Ceiling∩EnforceableSet` 本就无法形成有效授权，故「GRANTED 且 UNAVAILABLE」逻辑自相矛盾。
- **`requirement_coverage` 禁止影响权限**（Stage 3 冻结）：`FULL → 自动 GRANTED` ✕；`PARTIAL → 自动 DENIED` ✕。除非未来正式引入 required/optional 前置模型（当前没有）。
- **Supervisor Grant ≠ Capability Decision**：Grant 是历史事实（Supervisor 想给什么），即使最终 DENY 依然留存；Decision 是最终允许结果。例：Grant=filesystem.write + Ceiling 拒 → Grant 存在 + Decision=DENIED(NOT_ATTEMPTED, OWNER_CEILING)。

### B. DSH Mapping

- 承 v2 `capability_decisions` 表结构（Decision Ledger 同构 M2 Assignment Ledger）；DSH 原语字段不进表，只进 snapshot。
- 新增 `NOT_ATTEMPTED` 状态进入 enforcement_status 枚举（Stage 3 REQUIRED）。

---

## 12. Schema v4（裁决项 12）

### A. Kingdom Contract（描述 Kingdom Facts，不描述 DSH 实现）

**Schema v4 总则（Stage 4 冻结）**：`存在于 Core 数据库 ≠ 属于 Core Domain Semantics`。
物理存储归属与语义归属是两件事：Kingdom 可以持久保存 Adapter payload，但 Core 只能「存/取/hash/展示/按 evidence_type 路由」，不能读 DSH 私有字段去推导治理决策。

**四类事实分类（Stage 4 REVISE 后冻结，取代旧的 Core vs metadata 二分）**：

```text
A. Kingdom Core Fact
   Kingdom 必须自己理解语义并做治理判断。
   Task / Assignment / Execution / Capability Decision / Execution Lease / Dispatch Record / Territory Affinity

B. Core Runtime Reference
   Kingdom 必须保存、关联、比较，但不解释内部格式（opaque reference）。
   runtime_type / runtime_instance_ref / session_ref / runtime_dispatch_ref / runtime_execution_ref
   （例：session_ref="abc123"——Kingdom 知道「本 Lease 与 Execution 同一 Session」，不关心 DSH 如何生成）

C. Adapter-owned opaque evidence
   Kingdom 为审计/恢复持久化，Core 只认 type（如 "DshEnforcementEvidence/v1"），不解释内部。
   enforcement_plan_snapshot / enforcement_evidence_snapshot / runtime_metadata

D. Runtime-specific detail
   只属于具体 Adapter，不进 Core 语义。
   DSH MessageId / turn/start / turn/end / preset 名 / guard 名 / sandbox-mode event / session.header.cwd
   （但 DSH MessageId 的「值」可存进 Core 通用 runtime_dispatch_ref；Core 只知道它是 dispatch reference）
```

**推荐概念结构（事实模型，非 DDL）**：

```text
Kingdom
├── Territories
├── Role Bindings
├── Session Territory Affinities   ★ 新 canonical ledger
├── Tasks
├── Assignments
├── Capability Decisions           ★ independent ledger
├── Execution Leases               ★ independent ledger
├── Executions
├── Dispatch Records               ★ independent ledger
├── Worker Results / Claims
└── Events

Worker Binding → Runtime Session Ref
   ├── Territory Affinity
   └── Execution Lease
         ├── Task / Attempt
         ├── Enforcement Plan（opaque，可恢复）
         └── Capability Decision（late-bound）
               └── Execution
                     └── Dispatch Record
                           └── runtime_dispatch_ref
                                 └── Runtime Evidence → Claim
```

> 此结构与 DSH 无关，换 Codex/OpenCode 仍成立（通过 Stage 1 审计判据）。

**不要过度外键化（Stage 4 冻结）**：Kingdom 表 = 治理需要直接查询和做决定的事实；Runtime detail = evidence payload / Adapter storage。禁止把 `turns / tool_calls / guard_events / sandbox_events / approval_events / runtime_messages` 全部升格成 Kingdom 表（那会把 Kingdom 变回 DSH 数据库）。「这个 Dispatch 是否 TERMINAL」属 Core；「turn/end event 第 7 字段是什么」不属 Core。

### B. DSH Mapping

- `role_bindings.session_id` 作 current projection（非 authority）；核心 runtime reference 存 Core 通用引用（`session_ref / runtime_dispatch_ref = MessageId 值`）。
- 迁移规则承 v2 §7（`LEGACY_UNMANAGED` / `ENFORCED` / `NOT_CONFIGURED`）。

> **门槛**：Schema v4 的具体 DDL、表名、索引、migration number 全部归 **M3-S2**；本稿只冻结事实模型与四类归属。

---

## 13. DSH Adapter Mapping（裁决项 13 + 双层总表）

| Kingdom Contract | DSH Mapping（dsh-Kingdom 用 DSH primitive 满足） |
|---|---|
| Execution Lease = acquire/constrain/drive/release | `AgentRegistry.resume`（setup 装配）→ COMMIT POINT（Intent 持久化）→ `followup`（dispatch）→ `whenIdle`（同步辅助，非终端证据）→ lease release |
| Dispatch Intent / kingdom_dispatch_id | Kingdom 侧持久 ID → DshAdapter → DSH UserMessage/MessageId（`MessageId = runtimeDispatchRef`，非 Kingdom ID） |
| 长期 Worker Session | `resume({resumeSessionId})` 恢复同一 session，身份/历史/政策事件持久重放 |
| Capability Surface 最小化 | agent preset 在 **setup** 挂载（global 工具层为空，M3-S0 C-005） |
| Runtime Enforceable Set（context-bound） | `capabilities(runtimeContext)` 依 session cwd/territory 匹配 + seam 可用性判定；静态声明仅作 Capability Declaration，不参与计算 |
| Enforcement Request（Resolver→Adapter） | Capability Model → `preflight`（无副作用）→ `materialize`（fail-before-dispatch） |
| Authoritative Deny | `tools.guard`（exec.name，body 不执行，M3-S0 C 组） |
| Effect Containment | `setSandboxMode('workspace-write')`（cwd 写边界；Territory affinity 由 Kingdom fact 记录，cwd 仅为 enforcement evidence） |
| Escalation Prevention | `setApprovalPolicy('never')`（扩权 fail-closed，M3-S0 D 组） |
| Receipt Evidence（Dispatch 时刻） | `MessageId`（runtimeDispatchRef）证明「已接受」，**不等于完成** |
| Terminal Evidence（生命周期） | MessageId → splice → turn/start → turn/end → assistant/message（M3-S0 F 组） |
| Reconciliation（两维） | `executionObservation`（splice/turn 边界）+ `sessionObservation`（能否 resume），独立不合并 |

---

## 14. Legacy one-shot compatibility（裁决项 14）

### A. Kingdom Contract

- one-shot subagent = **dsh-Kingdom Legacy / Compatibility Execution Path**，**不是** governed persistent execution 的自动 fallback。
- 用途限定：①旧版本王国兼容；②v0.6/v0.7 行为回归；③尚未迁移到 governed persistent execution 的旧王国。

**`Execution Contract`（Stage 5 REQUIRED，Runtime-independent 语义）**：

```text
execution_contract = LEGACY_COMPAT | GOVERNED_PERSISTENT
（枚举名 M3-S2 可调整）
```

- 解决 Stage 4 遗留问题：Core **不得**根据 `dispatch_backend === "dsh-one-shot"` 做治理判断。
- 正确方式：Core 讲 `execution_contract = LEGACY_COMPAT`，DSH Adapter 才知道「LEGACY_COMPAT → 当前实现 = one-shot subagent；GOVERNED_PERSISTENT → persistent DSH Session」。换 Runtime 仍成立。
- **Legacy 必须显式可观察**（Stage 5 REQUIRED）：Execution Evidence / Snapshot / GUI / Audit/Event 须能知道「这次是 Legacy 还是 Governed Persistent」。**禁止** GUI 显示「Worker A 正常执行」实际却临时造子 Agent 且无任何标识。
- Legacy 只能**显式进入**，不得系统内部 `try persistent catch → legacy`。

### B. DSH Mapping

- 保留 v0.6/v0.7 subagent 链，用途仅限上述三项。
- `LEGACY_COMPAT → DSH one-shot subagent`；`GOVERNED_PERSISTENT → resume + followup`。禁止 persistent dispatch 失败自动切 one-shot。

---

## 15. fail-closed / no automatic backend downgrade（裁决项 15）

### A. Kingdom Contract

```text
governed persistent backend unavailable → fail closed（不降级 one-shot）
```

**升为硬不变量（Stage 5 冻结）**：一个已按 Persistent Contract 创建的 Task Attempt，**要么按该 Contract 执行，要么不执行**；不得「安全模式跑不了 → 偷偷换一种方式把活干完」。

- 因为自动 fallback 同时改变六者：Runtime identity / Session history / Territory-context continuity / Capability enforcement / Execution evidence / Crash recovery semantics。

### B. DSH Mapping

- DSH 侧无可 enforce 或 session 丢失 → DENY + zero execution + 事件留存，不切 subagent。

---

## 16. adversarial Release Gate（裁决项 16）

**最终 Gate 数量：12 项（Stage 5 冻结）**。12 项全部 PASS，M3 governed persistent backend 才可声称 Release Gate 通过。

```text
G1–G5  Capability 基础安全与诚实标注（承 v2：ENFORCED 才有资格声称；zero execution；
       workspace 外写实测拒绝；对抗矩阵；诚实标注）
G6     Scoped Tool Bypass：agent-scoped tool 越权写 → 必须被挡
G7     并发隔离：Task A(write) 与 Task B(no-write) 并发，A policy 不污染 B
G8     Escalation 不可扩大权限：danger-full-access 请求 DENY，不绕过 Ceiling
G9     Evidence strength 正确：trusted-path-fence vs kernel sandbox 分测分记，不夸大
G10    Lease 互斥：同一 session 并发 acquire 只成功一个
G11    Crash / Reconciliation fail-closed：旧 Execution 未 reconcile 前不得开新 attempt
       （SESSION_GONE ≠ TERMINAL、UNKNOWN 禁止超时 ABORT）
G12    Foreign / Unmanaged Dispatch Safety（见下）
```

### G12 — Foreign / Unmanaged Dispatch Safety（非 Kingdom Dispatch 干扰安全，Stage 5 正式纳入）

**测试核心（不是「外部消息绝对不可能进入」）**：同一个长期 Session 在 active Lease 期间出现非 Kingdom 管理的 Dispatch 时，Kingdom 仍能保证**不把已被污染的执行继续当作可信 governed execution**。

**两种实现方式，满足其一即 PASS**：

```text
路径 A（Prevent）：active Kingdom Lease 下，非 Kingdom ingress → reject / isolate
路径 B（Detect + Fail Closed）：Runtime 无法完全阻止，但 Kingdom/Adapter 能可靠发现
        active Lease 期间出现未知 dispatchRef / turn / message
        → 检测 foreign dispatch
        → 本 Execution 不再视为 clean execution
        → 禁止正常 settle / ACCEPT 为可信结果
        → 对应 Session 禁止获得下一 Lease
        → 进入明确 reconciliation / integrity handling
```

**G12 FAIL（绝对禁止第三种情况）**：foreign dispatch 进入同一 Session 改变历史/触发 Turn，Kingdom 不知道，继续把结果当可信 → release Lease → 下一 Task。此情况下 **M3 governed persistent backend 不得发布为通过**。

**最小验收实验（M3-S6 至少一次）**：

```text
1. Worker Session S
2. Kingdom acquire Lease L
3. Kingdom dispatch Task A
4. Lease 尚 active 时，从治理链外向 Session S 注入另一有效 Dispatch
5. 观察：
   PASS A = foreign 被 Runtime 拒绝/隔离
   PASS B = foreign 能进但 Kingdom 检测到 → 标记不可信/进 recovery → 不正常 settle
            → 不 release 复用 → 不开下一 Attempt
   FAIL   = foreign 成功 + Kingdom 没发现 + Execution 正常 COMPLETED + Lease 正常释放
```

**G12 不扩大安全宣传（Stage 5 冻结）**：Detect+Fail-closed 通过只能声称「Kingdom 能检测非治理入口导致的 Session 完整性破坏，并拒绝继续信任/复用」；只有 Prevent 路径 + 足够证据的 Adapter 才能额外声明 ingress isolation。遵守「证明到哪强度就只声明哪强度」。

### 非 Gate（Stage 5 冻结）

```text
Token 使用量 / Token 是否比 one-shot 少 X% / Governance overhead ratio
→ 都不是 M3 Release Gate（G1–G12）
可进 Runtime Observability / Benchmark（第一阶段为 informative benchmark）
M3 首要目标 = 治理正确、权限可 enforce、执行可追溯、Crash fail-closed
```

---

## 17. 字段归属清单（裁决项 17 → Stage 4 REVISE 为四类）

### A. Kingdom Core Fact（治理事实，永久语义，独立 Core Ledger/Table）

```text
kingdom / territory / role_binding / task / assignment / execution / worker_result / event
★ execution_contract    → LEGACY_COMPAT | GOVERNED_PERSISTENT（Stage 5，Runtime-independent）
★ Execution Lease         → 独立 Core Ledger（可先于 Execution 存在）
★ Dispatch Record/Intent  → 独立 Core Ledger（kingdom_dispatch_id = Core canonical ID）
★ Capability Decision     → 独立 Core Ledger（zero-execution decision 合法存在）
★ Session Territory Affinity → 独立 Core relation/ledger
```

### B. Core Runtime Reference（opaque，Kingdom 保存/关联/比较，不解释格式）

```text
runtime_type / runtime_instance_ref / session_ref / runtime_dispatch_ref / runtime_execution_ref
```

### C. Adapter-owned opaque evidence / payload（Kingdom 持久化，Core 只存/取/hash/路由）

```text
enforcement_plan_snapshot / enforcement_evidence_snapshot / runtime_metadata
```

### D. Runtime-specific detail（Adapter-only，不进 Core 语义）

```text
DSH MessageId / turn/start / turn/end / preset 名 / guard 名 / sandbox-mode event / session.header.cwd
dispatch_backend（实现名；如需治理判断 → Stage 5 定义 portable mode，不得 if dispatch_backend==="dsh-one-shot"）
```

---

### 三套事实最终归属（Stage 4 核心答案）

| 对象 | Stage 4 裁决 |
|---|---|
| Execution Lease | 独立 Kingdom Core Ledger/Table |
| Dispatch Intent / Dispatch Record | 独立 Kingdom Core Ledger/Table |
| Capability Decision | 独立 Kingdom Core Ledger/Table |
| Supervisor Grant | Decision 内的权威输入 snapshot，**当前不单独建表** |
| Enforcement Plan | Adapter-owned opaque payload，**必须在 materialize 前可持久恢复**（挂 Lease） |
| Enforcement Evidence | Adapter-owned opaque evidence，随 Decision/Execution 持久审计 |
| Runtime-specific details | Adapter metadata/evidence |

---

### 关键语义约束（Stage 4 冻结）

1. **Territory affinity**：独立 `Session↔Territory Affinity Ledger`（非 `role_bindings.current_territory_id` 唯一权威）。强不变量：**同一长期 Session 一旦建 affinity，不得改绑另一 Territory**（跨领地 = 建新 Session）。`role_binding` 只能放 current projection（current_session_id），历史归属必须查 affinity ledger。换 Worker Session 不得覆盖 Session 历史领地。← 满足 `Current Projection ≠ History`。
2. **Execution Lease 不依附 Execution**：合法存在「Lease 已存在、Execution 尚不存在」（materialize 失败 → zero execution → cleanup → release）。Lease 需能独立表达 pre-dispatch 生命周期（identity/worker/session/task/attempt/acquired/released/phase）。否则 crash 后「Session 被占着但 DB 解释不了为什么」不可接受。
3. **`capability_decision_id` late-bind**：Lease acquire 时可为空；materialize 成功/失败 → 产生 Final Capability Decision → 再关联 Lease。不引入 `PENDING CapabilityDecision`（GRANTED|DENIED 保持干净）。
4. **Enforcement Plan 可恢复**：materialize 第一次产生 Runtime mutation 前，Plan 必须已持久化或被 Lease Ledger 稳定引用（Adapter-owned opaque payload，非 Core 语义，但持久化是 crash recovery 必需）。
5. **Capability Decision 独立存在**：`execution_id = NULL` 合法（DENIED+NOT_ATTEMPTED/UNAVAILABLE/FAILED → zero execution）；`Execution → capability_decision_id` 只是成功执行的反向关联。
6. **`kingdom_dispatch_id` = Core canonical ID**（非 Adapter metadata）；`runtime_dispatch_ref` = Core opaque Runtime Reference（DSH = MessageId 的值）。

---

## 18. 施工顺序（承 Owner §19，本设计不越权改序）

```text
M3-S1（本文档，FROZEN）→ M3-S2 Domain+Schema v4 → M3-S3 Adapter Contract + DSH Persistent Backend
→ M3-S4 Capability Resolver + DSH Enforcement Mapping → M3-S5 Dispatch Evidence + Reconciliation
→ M3-S6 Adversarial/Concurrency/Crash Gate → M3 RC
```

> **不得**「先做 Persistent Worker，之后再补 Lease/Evidence/Recovery」（否则产生「能跑但不可证明安全」的中间态）。

--- 红线复核：本稿全程未改正式 Schema、未动 kingdom.db、未改 DSH、未发布；L3B 未涉足；授权未变。---

## 分阶段裁定记录（staged ruling，已全部闭环）

- **Stage 1（架构边界 §1–§3）**：✅ `OWNER_APPROVED_WITH_REFINEMENT`——三级定位 / 双层规格 / RuntimeBinding 不抽独立表 APPROVED；`session_meta` opaque metadata APPROVED_WITH_CONSTRAINT；v3 一 Worker 最多一 Session one affinity；同 Worker 多 Session DEFERRED；affinity 从 cwd 推导 REJECTED；affinity 作 canonical fact REQUIRED。
- **Stage 2（Execution Lease §4/§4bis/§8/§9/§10/§10bis）**：✅ `OWNER_APPROVED_WITH_BLOCKING_REFINEMENTS`——①Dispatch Intent + `kingdom_dispatch_id` + COMMIT POINT；②DispatchReceipt ≠ Terminal Evidence；③Reconcile 两维；④SESSION_GONE ≠ TERMINAL。另冻结 Lease=Kingdom dispatch 互斥、一 Lease=一 Attempt、RECOVERING 不改 Task 状态、UNKNOWN 禁超时 ABORT、Lease 释放须可信 evidence、whenIdle 仅辅助。
- **Stage 3（Capability 两层 §5/§6/§7/§11）**：✅ `OWNER_APPROVED_WITH_BLOCKING_REFINEMENTS`——①拆 Requirement/Grant/EnforcementRequest；②EnforceableSet context-bound；③materialize=fail-before-dispatch、preflight 无副作用、partial failure→cleanup/recovery；④删 GRANTED+UNAVAILABLE、增 NOT_ATTEMPTED、GRANTED⇔ENFORCED。另 freezing Per-Execution Evidence ≠ Adversarial Gate Evidence。
- **Stage 4（Schema v4 边界 §12/§17）**：✅ `OWNER_APPROVED_WITH_BLOCKING_REFINEMENTS`——①affinity 独立 Core Ledger；②Lease 独立 Core Ledger（late-bind/plan 可恢复）；③Dispatch Intent 独立 Core Ledger；④Capability Decision 独立 Core Ledger；⑤Schema 四类分类。另冻结「存于 Core DB ≠ 属 Core 语义」+「不过度外键化」。
- **Stage 5（Legacy+Gate §14–§16）**：✅ `OWNER_APPROVED_WITH_BLOCKING_REFINEMENTS`——①Execution Contract（LEGACY_COMPAT/GOVERNED_PERSISTENT）显式化，Core 不看 dispatch_backend；②G12 正式纳入（Foreign/Unmanaged Dispatch Safety，Prevent OR Detect+Fail-closed），最终 Gate=12；③Token Efficiency 不属 Release Gate。

---

# M3-S1 结论

Stage 1–5 全部裁定并落实，本设计稿正式升为 **M3-S1 DESIGN FROZEN / OWNER APPROVED**，作为进入 **M3-S2 — Domain + Schema v4** 的冻结实现依据。DDL/表名/索引/migration number 仍全部归 M3-S2。
