# M3-S4 Implementation Report（v0.8 第三阶段 · S4 Capability Resolver + DSH Enforcement）

> 日期：2026-08-19
> 依据：M3-S4 Thin Spec（已实施）；Owner v0.8 施工 Prompt §21–§23
> 状态：待 Owner 复核（S2/S3 报告同样开放；S4 未触碰正式 DB、可逆）

---

## 1. Resolver（`src/capability/resolver.ts`，纯函数零 dsh 依赖）

```text
Effective = Supervisor Grant ∩ Owner Ceiling ∩ Runtime Enforceable Set
- Grant/Requirement/Ceiling 均为 capability 名 → boolean 映射（命名约定：tool:<name> /
  filesystem.write / filesystem.read / shell.exec / approval.never；未知能力 fail-closed）
- Owner Ceiling = 允许清单（交集语义）；NULL ceiling → 全拒（v6 B-4/B-7）
- requirement_coverage = FULL/PARTIAL/NONE（信息字段，不自动授权）
- isEnforceable：filesystem.write 需 workspace-write；approval.never 需 approval 机制；tool:* 需在可挂载工具面
```

## 2. DSH Enforcement（`src/capability/dsh-enforcement.ts` + adapter 接入）

- `materializeDshEnforcement`：① `agent.ctx.tools.restrict({allow})` + `tools.guard`（单调拒绝、body 不执行，C-009）② 一键 `permissionPresets.set(session, preset)` 或逐 `setSandboxMode`（sandbox-policy:69）+ `setApprovalPolicy('never')`（user-approval:142）③ **证据核验**：sandbox/mode、approval/policy、permission/preset 事件必须落持久日志；失败 → 拆除 disposer + CANNOT_ENFORCE；
- `cleanupDshEnforcement`：per-session disposer registry 拆除 per-execution guard/restrict（session 级政策保留）；
- `readEnforceableSet`：从 session 政策事件重建「当前 knob 面」（审计用）；
- adapter `capabilities(context)`：**机制可用性**（sandboxPolicy/permission 存在 → workspace-write；approval/permission 存在 → never；工具面 = ctx.tools.view()）——Resolver 的授权输入；`preflight` 纯检查（approval 必须 never、机制齐备、territoryPath 非空）；`materialize`/`cleanup` 全接通。

## 3. Capability Gate 编排（`src/capability/service.ts`，TX-0D..TX-2S/2F）

```text
resolve → coverage≠FULL / ceiling 缺失 → DENIED（NOT_ATTEMPTED/UNAVAILABLE）+ zero execution（lease 释放，无 Execution/Dispatch）
coverage=FULL → 写 plan（lease.enforcement_plan_snapshot）→ PREPARING → MATERIALIZING
→ preflight（失败 → DENIED+UNAVAILABLE）→ materialize（失败 → DENIED+FAILED + cleanup + zero execution）
→ 成功 → GRANTED+ENFORCED + evidence → bind decision → DISPATCH_READY
```

## 4. Tests（新增 11 项）

| 组 | 覆盖 | 结果 |
|---|---|---|
| resolver 纯函数 | 交集语义 / 无自授 / 超 Ceiling / ceiling 缺失 / isEnforceable 映射（含未知能力 fail-closed）/ effectiveTools | 3/3 |
| enforcement | 4 面应用 + typed evidence + guard 拒绝实证 / 缺后端 CANNOT_ENFORCE + 无 disposer 泄漏 / preset 一键路径 + readEnforceableSet 事件重建 | 3/3 |
| adapter surface | capabilities 机制可用性 / preflight 校验 / materialize+cleanup | 1/1 |
| gate 编排 | GRANTED 全路径（evidence+绑定+DISPATCH_READY+计划持久）/ ceiling 缺失 zero execution / 无自授 DENIED+NOT_ATTEMPTED / materialize 失败 DENIED+FAILED+零 Execution | 4/4 |

**全量回归：74/74 PASS**（既有 63 + S4 11）。

## 5. 红线与诚实声明

- 正式 kingdom.db 未触碰；无 commit/tag/publish；
- evidence 强度诚实：只记录真实应用的事实（sandbox/approval/tools/guards/事件证据），不写 OS isolation/kernel sandbox（G5/G9）；
- CANNOT_ENFORCE 一律 DENIED + zero execution（G2）；guard 单调拒绝实证（G6）；approval=never 禁扩权（G8）。

## 6. 下一步

S5（Dispatch Evidence + Recovery，薄规格已备）：`src/dispatch/evidence.ts` + `reconcile.ts` → Crash Matrix 测试 → G12 检测 → 回归 → 报告。
