# M3-S4 Thin Spec — Capability Resolver + DSH Enforcement（DRAFT）

> 状态：**DRAFT / 待 S3 施工后随 S4 阶段施工**（§21–§23；§39 允许的薄规格之一，只回答 Resolver 与 DSH 映射）。
> 依据：M3-S1 Stage 3 裁决（Capability 两层、preflight/materialize、GRANTED⇔ENFORCED）+ M3-S2 v6（capability_decisions Ledger / lease 计划与证据）+ DSH seam 源码核实 @ 00b7102f1d。
> 红线：Runtime 无法证明 enforce ⇒ **DENIED + zero execution**；不得「提醒模型注意 → 继续执行」；不得创建声称 GRANTED+ENFORCED 但实际没装 policy 的 Execution；evidence 不得夸大强度。

---

## 1. Resolver Pipeline（Core 侧，纯函数 + governed API）

```text
输入（全部来自治理事实/权威状态，非模型自述）：
  Task.capability_requirement_json   ← 非权威自我描述（Requirement）
  Supervisor Grant                   ← 本次 Attempt 权威授权（Supervisor 决定）
  Owner Ceiling                      ← kingdoms.capability_ceiling_json（王国上限）
  Runtime Enforceable Set            ← adapter.capabilities(runtimeContext)（context-bound，动态）
        ↓
Resolver（src/capability/resolver.ts，纯函数）
        ↓
Effective Capability = Grant ∩ Ceiling ∩ EnforceableSet
        ↓
requirement_coverage = FULL | PARTIAL | NONE   ← 信息字段，禁止 FULL→自动 GRANTED
        ↓
GRANTED 路径：preflight（无副作用）→ Enforcement Plan（persist 到 lease.enforcement_plan_snapshot）
            → materialize（Runtime mutation）→ DshEnforcementEvidence → recordCapabilityDecision(GRANTED+ENFORCED)
DENIED  路径：recordCapabilityDecision(DENIED + NOT_ATTEMPTED|UNAVAILABLE|FAILED)，zero execution
```

规则（冻结）：
1. **GRANTED ⇔ ENFORCED**（v6 行内双向 CHECK + 本 Spec 实现层双重保证）；
2. `preflight` **零副作用**：只核对 EnforcementRequest ∩ 当前 session/preset/sandbox/approval/guard 可 enforce；
3. **Enforcement Plan 在 materialize 前持久化**（`lease.enforcement_plan_snapshot`，typed envelope；crash 后可恢复）；
4. `materialize` **必须发生在 dispatch 前**；partial failure → cleanup + DENIED+FAILED，zero execution；cleanup 不明 → RECOVERING；
5. Runtime 无证据证明 enforce（无 sandbox 后端 / 无 approval 服务 / preset 缺失）→ **DENIED + UNAVAILABLE** + reason_code；
6. Core 只 `store / retrieve / hash / display / route by type` Adapter-owned evidence，不解释内部字段（M3-S1 冻结）。

## 2. Domain wiring（S2 governed API 已提供，S4 只加 Resolver 编排）

```ts
// src/capability/resolver.ts（纯函数；可单测，无 dsh import）
resolveEffectiveCapability(input: {
  requirement: Record<string, unknown>       // tasks.capability_requirement_json
  grant: Record<string, unknown>             // Supervisor Grant（本 Attempt）
  ceiling: Record<string, unknown> | null    // kingdoms.capability_ceiling_json
  enforceable: RuntimeEnforceableSet         // adapter.capabilities(runtimeContext)
}): { effective: Record<string, unknown>; coverage: 'FULL'|'PARTIAL'|'NONE'; deniedReasons: string[] }

// 编排（S4 服务层）：resolve → preflight → persist plan → materialize → decision
// 全部经 governed.ts：setLeasePlan / recordCapabilityDecision / bindCapabilityDecision / advanceLeaseState
```

## 3. DSH Enforcement Mapping（materialize 落点，seam 已核实 @ 00b7102f1d）

| Enforcement 面 | DSH 实现 |
|---|---|
| **Tool Surface**（只挂本次允许工具） | setup 装配点：`agentPresets.mount(agentCtx, id)`（agent-presets/src/index.ts:275）+ `tools.restrict`（agent 作用域过滤）——每次 create/resume 的 setup 按 Enforcement Plan 挂工具 |
| **Authoritative Guard**（越权调用 body 前拒绝） | `tools.guard`（tools/src；C-009：单调拒绝、body 不执行、拒绝物化为 isError 结果） |
| **Territory Write Containment** | `setSandboxMode(session, 'workspace-write')`（sandbox-policy/session-mode.ts:69）——workspaceRoot=session.header.cwd=territory.workspace_path（C-011 实证界外写拒绝） |
| **Approval（禁扩权）** | `setApprovalPolicy(session, 'never')`（user-approval/src/index.ts:142）——approval=never 语义：每个 ask 均 rejected（C-018 实证） |
| **一键 preset 路径** | `permissionPresets.set(session, name)`（permission-presets/src/index.ts:375）——sandbox+approval+permission/preset 事件一次应用（materialize 首选；等价于逐 knob setter 的事件面） |
| **Evidence（typed envelope）** | `{ type: 'DshEnforcementEvidence/v1', payload: { presetId?, sandboxMode, approvalPolicy, guards: string[], tools: string[], sessionRef, verifiedAt } }`——Core 只 hash/route |

**CANNOT_ENFORCE（→ DENIED + UNAVAILABLE）**：`ctx.shell.sandboxMode === undefined`（无 confining 后端）/ `ctx.approval` 缺失 / preset 名无法 resolve / guard 无法注册。

## 4. Adversarial 验收（S4 完成标准，G4/G6/G8/G9 种子）

1. **无自授**：Task requirement 自报超授权 → 不自动 GRANTED；
2. **超 Ceiling**：Grant ⊄ Ceiling → Effective 收缩，超出项 DENY；
3. **Scope 外**：要求写 Territory B 而 scope=A → DENY；
4. **Partial policy**：plan 只能装一半（sandbox ✓ approval ✕）→ 不 dispatch，DENIED+FAILED，cleanup；
5. **Guard bypass**：模型直接调未授权工具 → guard 拒绝、body 不执行（实证 C1）；
6. **Sandbox escape**：写 workspace 外 → 真实拒绝（实证 E 组）；
7. **Escalation**：approval=never 下任何 ask → rejected（实证 D 组）；
8. **GRANTED+ENFORCED 诚实性**：evidence 字段与事件面（sandbox/mode、approval/policy、permission/preset）逐一可核对，无夸大（不写 OS isolation/kernel sandbox）。

## 5. 施工顺序（S3 完成后执行）

1. `src/capability/resolver.ts`（纯函数 + 单测）；
2. `src/capability/dsh-enforcement.ts`（materialize/cleanup，走 permissionPresets/setSandboxMode/setApprovalPolicy/guard）；
3. 编排层：acquire → resolve → preflight → persist plan → materialize → decision（governed API）；
4. Adversarial 测试（上节 8 项）+ 回归；
5. 呈报 M3-S4 Implementation Report（§40 S4 格式）。
