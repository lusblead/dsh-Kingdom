# Kingdom Context Governance 架构边界 v1

> 状态：**DRAFT / 待 Owner Review / 非实施规格 / 不授权施工**
> 日期：2026-08-19
> 输入：研究文档《Kingdom Token Efficiency 与 Context Governance 研究结论及 Owner 方向输入》（`C:\Users\ADMIN\Downloads\Kingdom Token Efficiency 与 Context Governance 研究结论及 Owner 方向输入.md`，2026-08-19）+ Owner 架构边界落盘指令。
> 性质：把研究结论转化为 **Kingdom 架构边界与 Roadmap**。不实施 Context Governance，不修改 M3-S2 v6 Schema，不因 Token Efficiency 扩大 M3 范围。
> 结论来源标记：`SOURCE-DERIVED`（研究文档所述研究机制/建议性质）、`OWNER-FROZEN`（Owner 裁决/方向，逐字或近逐字）、`ARCHITECTURAL-INFERENCE`（本 agent 推导，非研究直接证明）、`DEFERRED`（后续候选）、`EXCLUDED`（已排除）。
> 工作流边界：本任务（B）与 M3-S2 v6 三审（A）是**两条独立工作流**；本文档不得塞入 v6、不得阻塞或改写已冻结的 M3-S1 Runtime Governance 语义。

---

## 0. Status / Scope / Non-authorization

```text
基线：
  M3-S1 Runtime Governance Design v3 = DESIGN FROZEN / OWNER APPROVED
  M3-S2 Schema v4 Design v6         = DRAFT / 待 Owner 三次 Review
  M3-S2 migration / Domain 施工      = NOT AUTHORIZED
  M3-S3                              = NOT AUTHORIZED

本文档：
  Status   = DRAFT
  Review   = 待 Owner Review
  Scope    = 架构边界 + Roadmap + ADR 候选 + 风险矩阵
  Non-auth = 非实施规格；不授权施工；不得创建 Context Governance 代码骨架/空表/接口占位/未授权测试
```

本轮**唯一**允许修改：本主文档 + Context Pack claim/source 条目 + RESUME.md 状态说明。**不得修改**：`M3-S2-SCHEMA-V4-DESIGN-v6.md`、`src/`、`tests/`、migration、正式 kingdom.db、DSH、发布配置、版本号。

---

## 1. Executive Architecture Judgment

1. **Kingdom 的天然优势是「先减少不需要的信息」，而非「压缩已有信息」**（SOURCE-DERIVED，研究 §0/§6）。Kingdom 已掌握 Role/Authority/Territory/Task/Assignment/Execution/Claim/Decision/Artifact/Capability/Ledger/Runtime Session，因此主路线是 **Context Projection**，不是 Prompt Compression。
2. **Context Governance 是五层模型的第 4 层**（ARCHITECTURAL-INFERENCE，映射 M3-S0 裁决 §15 五层模型 `4. Context Governance: Manifest/Projection/Packet`）。它建立在 Governance Core（第 3 层）之上，消费 Canonical State，产出 Derived Projection。
3. **Context Packet 永远是 Derived Projection，不是第二事实源**（OWNER-FROZEN，D-4）。这是本边界文档的最高不变量。
4. **Provenance 是硬约束**（OWNER-FROZEN，D-5）：任何投影/摘要必须能回到 Canonical Ledger / Artifact。
5. **Tool Context 由 Effective Capability 确定性投影**（OWNER-FROZEN，D-6）：Token 优化不得扩大权限、不得绕过 Capability Decision。
6. **当前 M3 只吸收一件事：Token Usage observation seam，且为 RESERVE ONLY**（OWNER-FROZEN，§四 Q1）。Context Governance 本体全部 DEFERRED。
7. **明确排除**：AgentDropout 式自动治理角色删除、第二 Hierarchical Memory Store、通用 Prompt Compression 主路线（OWNER-FROZEN，研究 §12/§7）。

---

## 2. Source-derived Conclusions（研究结论 → 架构吸收判定）

| # | 研究机制 | 研究建议性质 | 吸收判定 | 来源 |
|---|---|---|---|---|
| S-1 | Centralized Context Projection（治理层统一决定谁参与/谁知道什么/给多少历史） | 可直接作为设计原则 | **吸收为 V1 原则**（Context Governance 中央投影，Worker 不自行承担组织 Context 构造） | 研究 §1.1 |
| S-2 | Context 分类治理（Governance/Task/Working History/Runtime Observations 不同策略） | 建议直接进入概念设计 | **吸收为 V1 原则**（D-3 四类 Context，默认处理原则各异） | 研究 §2 |
| S-3 | Provenance（摘要必须能定位回原始经历） | 直接冻结为硬原则 | **吸收为 V1 硬约束**（D-5；Summary ≠ 事实源） | 研究 §5 |
| S-4 | Capability-aware Tool Context（只暴露本次 Execution 允许的工具） | 建议直接吸收到交叉设计 | **吸收为 V1 原则**（D-6；与 Capability Decision 衔接） | 研究 §4 |
| S-5 | Failure-driven Policy Refinement（完整上下文成功/投影失败 → 找遗漏 → 改 Policy） | 机制有价值，保留 Roadmap | **DEFERRED 至 V2+**（Q5；演进链须经 Owner/Governance 审批） | 研究 §3 |
| S-6 | 通用 Prompt Compression（LLMLingua 等） | 非主路线，最后可选 | **EXCLUDED 主路线；DEFERRED 为可选 Last-mile**（只处理 lossy 允许内容） | 研究 §6 |
| S-7 | Worker Private Working Memory | Owner：值得做，不是现在 | **DEFERRED 至更远阶段**（Q4；边界先冻结） | 研究 §7A |
| S-8 | Agent participation dropout | Owner：不应该做 | **EXCLUDED**（Token optimizer 不得取消必要治理角色） | 研究 §7B |
| S-9 | 独立 Hierarchical Memory Store | Owner：不需要 | **EXCLUDED**（只借鉴 navigation + provenance；Derived Index 可建） | 研究 §7C |
| S-10 | Session Compaction / Renewal | Owner：可以考虑 | **DEFERRED 至 V2 候选**（Q3；边界先冻结） | 研究 §7D |
| S-11 | Context Policy 自动学习 | Owner：先保留考虑 | **DEFERRED**（Q5；先研究建议/审批模型，自动生效另裁） | 研究 §7E |

---

## 3. Owner Decisions（D-1..D-6，OWNER-FROZEN）

### D-1 Kingdom Token Efficiency 正式定义

> 利用 Kingdom 已掌握的治理状态，减少 Agent 不必要的信息、工具和历史输入，同时保证必要信息完整、来源可追溯、权限边界正确、责任链不被破坏。

目标不是 `Minimum Tokens`，而是：

```text
Minimum Unnecessary Context
+ Required Information Preserved
+ Governance Correctness Preserved
+ Traceability Preserved
```

**压缩率不是首要成功指标。**（OWNER-FROZEN，D-1；研究 §13 同义）

### D-2 主路线：Context Projection，不是 Prompt Compression

```text
Canonical Kingdom State
        ↓
Context Selection
        ↓
Context Projection
        ↓
Context Manifest
        ↓
Context Packet
        ↓
Runtime Session
        ↓
必要时对非结构化内容做 Last-mile Compaction
```

- Canonical State = 唯一事实基础；
- Context Manifest = 「选择了什么、为什么选择、依据什么 Policy」的可审计计划；
- Context Packet = 针对特定 Worker/Task/Territory/Assignment/Execution 构造的派生输入；
- Context Packet **不是**新的 Canonical State；
- Context Packet 可重建、可失效、可丢弃；
- Last-mile compression 只能处理允许 lossy compression 的内容。（OWNER-FROZEN，D-2；研究 §0/§1.1 同构）

### D-3 Context 分类治理（至少四类）

| 类型 | 内容示例 | 默认处理原则 |
|---|---|---|
| Governance Context | Authority、Assignment、Capability、Territory、Acceptance Criteria、Supervisor Decision | 高完整性，不允许随意 lossy compression |
| Task Context | Task 描述、相关 Artifact、代码对象、Previous Claim、当前目标 | 结构化选择，按 Task relevance 投影 |
| Working History | Previous attempts、未解决问题、当前思路、中间进度 | 可以 compact，但不得升级为事实源 |
| Runtime Observations | stdout、测试日志、网页正文、Tool Result、Build Output | 可最积极裁剪或摘要，但保留必要引用 |

**不同 Context 类型 ≠ 统一使用同一种摘要策略。**（OWNER-FROZEN，D-3；研究 §2 同构）

### D-4 Context Packet 是 Derived Projection，不是第二事实源

```text
Context Packet
≠ Ledger ≠ Decision ≠ Claim ≠ Artifact ≠ Canonical Memory
```

- 重要结论必须尽可能回指：Ledger Record / Task / Assignment / Execution / Claim / Decision / Artifact / Event / Capability Decision。
- 摘要只能是导航和投影，不能替代原始治理事实。
- 允许未来建立：Derived Index / Projection Cache / Search Index / Context Manifest Index——但必须 `Derived / Rebuildable / Disposable / Non-authoritative`。
- **不得建立独立 Hierarchical Memory Store 作为第二套长期事实源。**（OWNER-FROZEN，D-4；研究 §7C 同义）

### D-5 Provenance 是硬约束

未来 Context Manifest / Context Packet 至少需要表达：

```text
packet_id
target_worker_binding_id
target_role
territory_id
task_id
assignment_id（如适用）
execution_id（如适用）
target_runtime_session_ref（如适用）
context_policy_id
context_policy_version
canonical_source_revision
generated_at
sections[]
```

每个重要 Context Item 至少要有：

```text
item_type
source_type
source_id / artifact_ref
source_revision 或 immutable hash
projection_reason
authority_level
```

**本轮只做概念设计，不创建数据库表。**（OWNER-FROZEN，D-5）

### D-6 Capability-aware Tool Context

```text
Capability Requirement
        ↓
Capability Decision
        ↓
Effective Capability
        ↓
本次 Execution 实际允许的 Tools
        ↓
Deterministic Concise Tool Manifest
        ↓
Context Packet
```

- 通用文本压缩器**不得**改写：tool name / parameter name / required 字段 / enum / capability identity / scope / authorization constraint / error contract。
- 未来允许自然语言辅助说明，但权威 Tool Manifest 必须由 **Authoritative Tool Schema 确定性生成**。
- Context optimization **不得扩大工具权限，也不得绕过 Capability Decision**。（OWNER-FROZEN，D-6；研究 §4 同构）

---

## 4. Impact on Current M3

```text
Q1：M3 是否需要 Token Usage observation seam？ → RESERVE ONLY（见 §5）
```

对当前 M3 的影响（ARCHITECTURAL-INFERENCE，基于 Owner 指令 §四）：

1. **当前 M3 唯一允许吸收的研究结果 = Token Usage observation seam（观测边界），不是 Context Governance 实施。**
2. **M3-S2 v6 Schema 零修改**：不增加 Token Ledger、不为 Token 指标新增 v4 表、不为 Token 指标新增 `executions` 列。
3. 不改变 Lease / Decision / Dispatch / Execution 治理状态机；Token Usage 不参与授权、拒绝、settlement 或 release 判断。
4. Token Efficiency 不属 M3 Release Gate（Stage 5 已冻结；Token 指标可进 Runtime Observability / Benchmark）。
5. Context Governance 全部概念（Manifest/Packet/Projection/Policy）**不进入 M3 施工范围**，不修改 M3-S2 v6。
6. 五层模型中第 4 层（Context Governance）语义与 M3-S1 冻结的第 2/3 层语义不冲突：第 4 层消费第 2/3 层的 Canonical State，不反向改写。

---

## 5. Token Usage Observation Seam（RESERVE ONLY）

### 5.1 裁决

```text
RESERVE ONLY
```

- 当前需要预留观测接缝；
- **不增加专门 Token Ledger**；
- **不为 Token 指标新增 M3-S2 v4 表 / executions 列**；
- 不改变 Lease、Decision、Dispatch、Execution 治理状态机；
- Token Usage **不参与**授权、拒绝、settlement、release 判断；
- Runtime 不提供数据时必须允许 `UNKNOWN`，不得使 Execution 失败。（OWNER-FROZEN，§四 Q1）

### 5.2 优先映射方案

```text
Adapter-owned Terminal Evidence
└── optional runtime_usage_observation
```

若现有 typed Terminal Evidence（typed envelope，v6 `terminal_evidence_json`）可容纳 → 复用 opaque evidence；若无法在不改 Schema 的情况下容纳 → **只记录接口 seam，持久化推迟到后续**。**不得因此修改 `M3-S2-SCHEMA-V4-DESIGN-v6.md`**（OWNER-FROZEN）。

### 5.3 建议接口级结构（只冻结 Adapter observation contract，非 Schema）

```text
RuntimeUsageObservation/v1
{
  measurement_basis: OBSERVED | REPORTED | ESTIMATED | UNKNOWN,
  input_tokens?: integer,
  output_tokens?: integer,
  cached_input_tokens?: integer,
  reasoning_tokens?: integer,
  total_tokens?: integer
}
```

要求（OWNER-FROZEN，研究 §10 同构）：

1. `OBSERVED / REPORTED / ESTIMATED / UNKNOWN` 不得混为一类；
2. 缺失字段保持缺失，不得用 0 冒充未知；
3. 不要求 Core 理解 Provider 私有计费细节；
4. 不把 Token Usage 变成 Capability 或 Governance Fact；
5. 当前只冻结 Adapter observation contract；
6. 若现有 typed Terminal Evidence 可容纳 → 复用现有 opaque evidence；
7. 若无法在不改 Schema 的情况下容纳 → 只记录接口 seam，持久化推迟到后续；
8. 不得因此修改 `M3-S2-SCHEMA-V4-DESIGN-v6.md`。

> **Token Usage seam 是当前 M3 唯一允许吸收的研究结果，而且只是观测边界，不是完整 Context Governance 实施。**（OWNER-FROZEN）

---

## 6. Context Governance V1（范围冻结）

V1 只包括（OWNER-FROZEN，研究 §8 同构）：

```text
Canonical State
Context Policy
Context Manifest
Role / Territory / Task Projection
Context Packet
Context Type Separation（D-3 四类）
Provenance（D-5）
Capability-aware Tool Context（D-6）
Deterministic Projection
```

V1 **不包括**：

```text
Private Worker Working Memory
Session Compaction / Session Renewal
learned Context Policy
automatic policy activation
LLMLingua
通用 Prompt Compressor
独立 Memory Store
Agent participation dropout
自动取消 Supervisor / Reviewer
大规模 Token Benchmark Framework
```

### V1 每个概念须回答的 7 问（本轮只概念设计，不设计正式 DDL）

| V1 概念 | ① 读取哪些 Canonical Facts | ② 输出什么 Derived Object | ③ 是否持久化 | ④ 失效/重建 | ⑤ 如何保留 Provenance | ⑥ 如何遵守 Role/Territory/Capability/Task scope | ⑦ 不能成为什么 |
|---|---|---|---|---|---|---|---|
| Canonical State | —（本身是源） | — | 是（Ledger） | 不可失效（权威） | — | 权威边界 | 不是投影 |
| Context Policy | Governance/Authority/Capability/Task 元数据 | Policy 定义（选择/投影规则） | 是（versioned） | 版本化，Owner 审批激活 | policy_id + version | 定义各 scope 边界 | 不是可被 LLM 自动改写的规则 |
| Context Manifest | 全量 Canonical State 快照索引 | 选择计划（选了谁/为何/依据哪 Policy） | 是（可审计） | 随 source revision 失效 | 引用 policy_id/version + source_revision | 记录所选 scope | 不是 Packet 本体 |
| Role/Territory/Task Projection | Role、Territory、Task、Assignment、Capability | 投影参数（谁该看什么） | 否（可重建） | 随 Canonical 变化重建 | projection_reason | 严格按 Role/Authority/Territory/Task 约束 | 不是权限授予（只投影，不扩权） |
| Context Packet | Manifest + 各类 Canonical Facts | 派生输入（发给特定 Worker/Task） | 可缓存但可丢弃 | 可失效/重建/丢弃 | packet_id + sections[] + item provenance | 只含该 scope 内内容 | **不是新 Canonical State / 不是事实源** |
| Context Type Separation | 四类 Context 源 | 分类标签 + 各自处理策略 | 概念 | 随分类规则版本 | 每类各自 provenance | 各类遵守各自 scope | 不是统一摘要策略 |
| Provenance | 所有被投影的源 | item 级引用元数据 | 是（随 Packet/Manifest） | 随源 revision | source_id/hash + projection_reason | 引用只指向有权访问的源 | 不是独立事实 |
| Capability-aware Tool Context | Capability Decision → Effective Capability | Deterministic Tool Manifest | 否（每次派生） | 随 Capability revision 失效 | 引用 capability_decision_id + schema rev | 只含本次 Execution 允许工具 | 不是权限授予；不被文本压缩器改写 |
| Deterministic Projection | 全量 Canonical | 可复现投影结果 | 记录选择结果 | 随源/Policy 版本 | 记录 policy + input revision + 选择结果 | 确定性遵守 scope | 不是自由 LLM 判断 |

---

## 7. Context Governance V2 / Later Roadmap

### V2 候选（OWNER-FROZEN，研究 §8 同构）

```text
Working History Compaction
Runtime Observation Compaction
Session Compaction / Renewal
Failure-driven Context Policy Suggestion
Context Packet Evaluation
```

### 更远候选（OWNER-FROZEN）

```text
Private Worker Working Memory
Learned Context Policy
Optional Last-mile Prompt Compression
```

所有候选均标记：

```text
DEFERRED
NOT AUTHORIZED
```

不得写成已决定施工的功能。

---

## 8. Context Manifest and Context Packet Concepts

### 8.1 与现有 Ledger 的衔接（OWNER-FROZEN，§七 Q2）

```text
Ledger / Artifact          = Canonical Source
Context Manifest           = Selection Plan
Context Packet             = Materialized Derived Projection
Summary                    = Non-authoritative Navigation
Derived Index              = Rebuildable Accelerator
```

**不得复制 Task / Assignment / Execution / Claim / Decision / Artifact / Territory / Capability，形成第二套事实状态。**

### 8.2 概念对象（本轮不设计 DDL）

```text
Context Manifest
  ├── manifest_id
  ├── target (worker/task/territory/execution)
  ├── context_policy_id + version
  ├── canonical_source_revision
  └── sections[]（每 section = 选择了什么 + 为什么 + 依据）

Context Packet
  ├── packet_id（见 D-5 字段）
  ├── sections[]（每 item 带 provenance：item_type/source_type/source_id/source_revision/projection_reason/authority_level）
  └── 生命周期：可重建 / 可失效 / 可丢弃
```

---

## 9. Provenance Contract（OWNER-FROZEN，D-5 展开）

- 每个重要 Context Item 必须携带：`item_type / source_type / source_id|artifact_ref / source_revision|immutable hash / projection_reason / authority_level`。
- Packet/Manifest 级必须携带：`context_policy_id / context_policy_version / canonical_source_revision / generated_at`。
- **Summary ≠ 新事实源**：任何重要摘要必须 `Summary → source reference → Canonical Ledger / Artifact`。
- 未来允许 Derived Index / Projection Cache / Search Index / Context Manifest Index，但必须 `Derived / Rebuildable / Disposable / Non-authoritative`。
- 不得建立独立 Hierarchical Memory Store 作为第二套长期事实源。

---

## 10. Capability-aware Tool Context（OWNER-FROZEN，D-6 展开）

链路（见 §3 D-6）。权威 Tool Manifest 由 Authoritative Tool Schema 确定性生成；自然语言说明只能作为辅助，不能成为权威事实源。

**不得被通用文本压缩器直接改写**：

```text
tool name / parameter name / required 字段 / enum
capability identity / scope / authorization constraint / error contract
```

Context optimization **不得扩大工具权限，也不得绕过 Capability Decision**。Tool Context 的失效必须与 Capability revision 联动（见 R-3）。

---

## 11. Session Compaction / Renewal Boundary（DEFERRED 探索）

> 仅做未来架构探索，不施工。（OWNER-FROZEN，§七 Q3）

冻结边界：

```text
1. Worker identity ≠ Runtime Session（M3-S0 已冻结）
2. Session Renewal 不得在同一 Session 存在 active Lease 时静默发生
3. 正常路径必须先完成 Execution settlement、cleanup 和 Lease release
4. 旧 Session 必须显式 retire
5. 新 Session 必须显式建立新的 Affinity
6. 不得把旧 Session 的 affinity 直接 UPDATE 成新 Session
7. Assignment 可以继续归属于同一 Worker
8. Execution history 继续保留原始 Session Reference
9. 新 Session 的 Context Packet 必须引用 Canonical Ledger 和必要的旧 Session Artifact
10. Compaction Summary 不能成为新事实源
11. Recovery 场景是否允许在 active Lease 下 Session replacement，必须另立状态机和 ADR，不在本轮裁决
```

---

## 12. Private Working Memory Boundary（DEFERRED 探索）

未来边界（OWNER-FROZEN，§七 Q4）：

```text
Private Working Memory
≠ Canonical Fact ≠ Claim ≠ Decision ≠ Capability ≠ Ledger
```

- 可保存临时 hypothesis、计划、中间状态；
- 可被删除或失效；
- 不得直接改变 Task / Execution / Capability 状态；
- 不得作为 Supervisor Review 的唯一证据；
- 若某内容需要进入组织事实，必须显式形成 Claim / Artifact / 其他受治理记录；
- 跨 Session 继承不得默认发生；
- 跨 Session 继承必须经过 Context Projection，并附 Provenance。

**本轮不得实现。**

---

## 13. Failure-driven Policy Refinement（DEFERRED 探索，OWNER-FROZEN，§七 Q5）

冻结演进链：

```text
Context Failure
        ↓
Policy Change Suggestion
        ↓
Benchmark / Evaluation
        ↓
Owner or Governance Approval
        ↓
Versioned Policy Activation
```

**禁止**：

```text
LLM 自动修改 Context Policy → 未经审批自动生产生效
```

Context Manifest 与 Context Packet 必须记录所使用的 Policy ID 与版本，保证失败能回溯到具体 Policy。

---

## 14. Minimal Token Benchmark（冻结最小方案，本轮不运行）

### 模式（固定三种，不新增第四种）

```text
A. One-shot Subagent
B. Persistent Worker + Full History
C. Persistent Worker + Kingdom Context Projection
```

### 固定场景

```text
Round 1：初始 Coding Task
Round 2：固定 Supervisor REWORK
Round 3：依赖前面结果的 Follow-up Task
```

### 记录

```text
input_tokens
output_tokens
peak_context_size
task_success
acceptance_criteria_result
tests_pass_fail
cached_input_tokens（仅 Runtime 真实提供时）
```

### 两项硬性 Gate（不增加新模式）

```text
Governance Correctness Gate  — 不得暴露无权访问的 Context 或 Tool
Traceability Gate            — 关键投影内容能够回到 Canonical Source
```

### 必须固定或记录

```text
Task fixture / Acceptance Criteria / Context Policy version
Runtime / Adapter version / 模型标识 / 代码基线 / 重试规则
```

### 不得加入

```text
LLMLingua / ACON compressor / HORMA memory / MemPO / AgentDropout
多种摘要算法 / 多种 Memory Architecture
```

Benchmark 目的：验证「Persistent Worker + Kingdom Context Projection 是否减少无关 Context，同时不降低任务质量、治理正确性和可追溯性」。（OWNER-FROZEN，§九；研究 §9 同构）

---

## 15. Architecture Decision Register（ADR 候选表，本轮不拆文件）

| ADR | 名称 | 当前状态 | V1 前需批准？ |
|---|---|---|---|
| ADR-CG-001 | Context Packet 是 Derived Projection，不是 Canonical State | PROPOSED | **是**（V1 最高不变量） |
| ADR-CG-002 | Context Provenance 与 Policy Version 是强制元数据 | PROPOSED | **是**（V1 硬约束） |
| ADR-CG-003 | Tool Context 必须由 Effective Capability 确定性投影 | PROPOSED | **是**（V1 原则） |
| ADR-M3-OBS-001 | Token Usage 是 Optional Adapter Observation，不是治理事实 | PROPOSED | **是**（M3 seam，若 M3 收 seam 则需确认） |
| ADR-CG-004 | Session Compaction / Renewal 生命周期 | DEFERRED | 否（V2 进入范围时再写） |
| ADR-CG-005 | Private Worker Working Memory 边界 | DEFERRED | 否（更远阶段再写） |
| ADR-CG-006 | Failure-driven Policy Suggestion 与审批激活 | DEFERRED | 否（V2 进入范围时再写） |
| ADR-CG-007 | Last-mile Prompt Compression 使用边界 | DEFERRED | 否（可选技术进入时再写） |

说明：ADR-CG-001/002/003 与 ADR-M3-OBS-001 需在 Context Governance V1 启动前批准；ADR-CG-004/005/006/007 等到对应功能真正进入范围后再写。

---

## 16. Risk Matrix（研究文档未充分覆盖的风险）

| # | 风险 | 描述 | 未来缓解方向（本轮不实现） |
|---|---|---|---|
| R-1 | Stale Context / TOCTOU | Context Packet 在 Canonical Revision N 生成，Execution 开始时事实已到 N+1 | source revision / generated_at / policy version / packet invalidation / Execution 前重验证 |
| R-2 | Cross-Territory Context Leakage | 投影把其他 Territory/Task/无权 Artifact 投给 Worker | Selection 同时受 Role/Authority/Territory/Task/Capability 约束，不按语义相似度检索 |
| R-3 | Capability 与 Tool Manifest 不同步 | Capability Decision 更新后旧 Tool Manifest 仍暴露已撤销 Tool | capability revision / invalidation seam |
| R-4 | Projection 不可复现 | Selection 依赖未记录 LLM 自由判断，无法复盘 | 区分 Deterministic Selection / Model-assisted Ranking；记录 Policy、input revision、选择结果 |
| R-5 | Provenance Reference 失效 | Artifact 覆盖/移动/删除后 Summary 无法回原始证据 | immutable artifact reference / version / hash |
| R-6 | Derived Projection 变成事实源 | GUI/Agent/服务只读 Context Packet 不读 Canonical Ledger | **Derived Projection 不得承载 authoritative write** |
| R-7 | Session Renewal 破坏 Lease 互斥 | active Lease 下换 Session，旧 Session 仍执行而新 Session 又获工作 | Renewal 必须与 Lease release/recovery protocol 联动 |
| R-8 | Private Memory 形成隐藏权威 | Worker 依赖 Private Memory 中未进 Ledger 的结论做后续 Claim | 要求可晋升路径和 Provenance |
| R-9 | Token 指标不可比较 | 不同 Runtime 对 cached/reasoning/input/output 定义不同 | 保留 measurement basis；不混合 reported/estimated/unknown 统计 |
| R-10 | Last-mile Compression 破坏结构化事实 | 压缩/重写 ID、SQL、migration、enum、command、acceptance criteria、tool schema、capability policy、ledger reference、code symbol | 上述内容禁止压缩/重写 |

---

## 17. Explicitly Excluded Directions（OWNER-FROZEN / EXCLUDED）

```text
1. AgentDropout 式自动治理角色删除        — Token optimizer 不得取消必须存在的 Supervisor/Reviewer/governance actor
2. 独立 Hierarchical Memory Store        — 不建第二套长期事实源；只借鉴 navigation + provenance
3. 通用 Prompt Compression 作为核心架构    — LLMLingua 等仅限未来 optional last-mile（lossy 允许内容）
4. 摘要作为事实                          — Summary ≠ 新事实源
5. 任何 Token 指标作为 M3 Release Gate    — Stage 5 已冻结：Token Efficiency 不属 G1–G12
6. 本轮实施 Context Governance 任何组件   — 非实施规格
```

---

## 18. Owner Review Matrix

请 Owner Review 以下检查点：

```text
□ 状态与授权表述一致（DRAFT / 待 Review / 非实施规格 / 不授权施工）
□ D-1..D-6 六条 Owner 方向是否逐字/近逐字落实
□ Q1（RESERVE ONLY）/Q2（衔接）/Q3（Session Renewal 边界）/Q4（Private Memory 边界）/Q5（Policy 审批链）五问答案是否认可
□ ADR 候选表（8 项，状态 PROPOSED/DEFERRED 分明；无 PROPOSED 写成 APPROVED）
□ Risk Matrix R-1..R-10 是否覆盖；无遗漏的 Kingdom 不变量风险
□ Benchmark 最小方案（3 模式 + 2 Gate + 固定场景）是否认可
□ 无把 DEFERRED 写成当前施工范围；无把研究结论伪装成已证明
□ 未修改 M3-S2 v6 / src / tests / migration / 正式 DB / DSH；未 commit/push/publish
```

---

## 附录 A：来源性质速查

| 标记 | 含义 |
|---|---|
| `SOURCE-DERIVED` | 来自研究文档（研究机制或建议性质），非 Owner 逐字裁决 |
| `OWNER-FROZEN` | Owner 裁决/方向输入，逐字或近逐字落实 |
| `ARCHITECTURAL-INFERENCE` | 本 agent 基于冻结语义的推导，非研究直接证明 |
| `DEFERRED` | 后续候选，当前 NOT AUTHORIZED |
| `EXCLUDED` | 已明确排除，不再作为 Roadmap 功能 |
