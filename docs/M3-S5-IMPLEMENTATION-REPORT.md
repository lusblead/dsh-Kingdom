# M3-S5 Implementation Report（v0.8 第四阶段 · S5 Dispatch Evidence + Reconciliation / Recovery）

> 日期：2026-08-19
> 依据：M3-S5 Thin Spec（已实施）；Owner v0.8 施工 Prompt §24–§30
> 状态：待 Owner 复核（S2/S3/S4 报告同样开放；S5 未触碰正式 DB、可逆）

---

## 1. Dispatch Evidence（`src/dispatch/evidence.ts`）

- `reconstructDispatchEvidence(session, runtimeDispatchRef)`：以 UserMessage.id 在事件流中定位 → 分析 tail → **QUEUED / RUNNING / TERMINAL / UNKNOWN** + `turnObserved` / `turnEndObserved` / `assistantMessageObserved` / `terminalReason`；
- **G12 检测**：`hasForeignDispatch` / `foreignUserMessages`——active dispatch 期间非本 dispatch 的 user 消息（id ≠ ref）→ 不可信。

## 2. Reconcile + Recovery（`src/dispatch/reconcile.ts`）

- `decideRecovery`（fail-closed 决策，无 ABORTED 分支——UNKNOWN 禁超时自动 ABORT）：
  - RUNNING/QUEUED → `WAIT`（不重发、不开新 attempt）；
  - TERMINAL → `TERMINAL_OK`；
  - UNKNOWN（含 **SESSION_GONE + UNKNOWN → RECOVERING**，SESSION_GONE ≠ TERMINAL）→ `RECOVERING`；
  - 外来消息 → `UNTRUSTED_RECOVERING`（最高优先级，禁 settle/release 声称可信）；
- `applyRecovery`：按决策标记 dispatch/lease/execution RECOVERING（**不改 Task 治理状态**）。

## 3. Governed Dispatch Service（`src/dispatch/service.ts`，TX-3..TX-5）

- `runGovernedDispatch`：Execution + Dispatch INTENDED（**COMMIT POINT**）→ **之后才** adapter.dispatch → Receipt（INTENDED→DISPATCHED→RECEIVED）→ Correlation（观测 turn → CORRELATED + Execution STARTING→RUNNING）→ Terminal Evidence（→TERMINAL + Execution 终态 + Lease SETTLING）；
- `settleAndRelease`：cleanup 不明 → **RECOVERING（禁 RELEASED）**；cleanup ok → RELEASED（带 release evidence）。

## 4. Crash Matrix（§30 A–J 语义 → 测试断言）

| 验证点 | 断言 |
|---|---|
| Crash D（INTENDED 无 dispatch） | 无 runtime ref → UNKNOWN → RECOVERING；Task 治理不变 |
| Crash G（CORRELATED 无 terminal） | 事件 RUNNING → WAIT（不 settle、不开新 attempt） |
| Crash H（terminal 后 cleanup 不明） | settleAndRelease(cleanupOk=false) → RECOVERING，禁 RELEASED |
| Crash I（cleanup 中） | 同上语义（RECOVERING 不释放） |
| 全程 | Task.status 保持不变（RECOVERING 不改治理事实） |

## 5. Tests（新增 5 项）

| 组 | 覆盖 | 结果 |
|---|---|---|
| evidence | 四态重建 + terminalReason + G12 外来检测 | 2/2 |
| reconcile | 决策规则（WAIT/TERMINAL_OK/RECOVERING/UNTRUSTED；SESSION_GONE≠TERMINAL；无 ABORTED 分支） | 1/1 |
| crash matrix | A–J 语义断言 + Task 治理不变 | 1/1 |
| 完整派发 | TX-3..TX-5 终态（execution/intent/receipt/correlate/terminal/decision 回填/lease SETTLING→RELEASED）+ terminal ≠ Task DONE | 1/1 |

**全量回归：79/79 PASS**（既有 74 + S5 5）。

## 6. 红线与诚实声明

- 正式 kingdom.db 未触碰；无 commit/tag/publish；
- terminal 证据只来自事件链（whenIdle 不参与）；Receipt ≠ Terminal（Stage 2 冻结）；
- 声明强度=证明强度：G12 只能声称「能检测并拒绝信任」，不声称完全阻止 ingress。

## 7. 下一步

S6（Release Gate G1–G12 验证执行）→ GUI 最小 Runtime Governance 接线 → Legacy 全回归 → v0.8 RC → 发布。
