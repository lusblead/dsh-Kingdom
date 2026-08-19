# M3-S5 Thin Spec — Dispatch Evidence + Reconciliation / Recovery（DRAFT）

> 状态：**DRAFT / 待 S4 施工后随 S5 阶段施工**（§24–§30；§39 允许的薄规格之一）。
> 依据：M3-S1 Stage 2 裁决（COMMIT POINT / Receipt≠Terminal / Reconcile 两维 / SESSION_GONE≠TERMINAL / UNKNOWN 禁超时 ABORT）+ M3-S2 v6 §4（TX-3R..TX-5）+ §7.2（C-1..C-7）+ DSH seam 核实 @ 00b7102f1d。

---

## 1. Dispatch Evidence Protocol（v6 TX-3R..TX-5 ↔ adapter ↔ governed API）

```text
createDispatchIntent（COMMIT POINT，先于 Runtime side effect）
  → adapter.dispatch()（followup 完整 UserMessage）
  → recordDispatchReceipt（INTENDED→DISPATCHED→RECEIVED；runtime_dispatch_ref=UserMessage.id，receipt_json+receipt_at）
  → correlateRuntimeExecution（→CORRELATED；runtime_execution_ref=turn/session log 游标）
  → recordTerminalEvidence（→TERMINAL；terminal_evidence_json+terminal_at；同事务 Execution→终态、Lease EXECUTING→SETTLING）
  → releaseExecutionLease（SETTLING→RELEASING→RELEASED；release evidence+released_at）
```

**Receipt 语义**：只证明「Runtime 可靠接受了 dispatch」。不证明成功/terminal/Claim 正确/Task DONE。
**Terminal 语义**：DSH 侧 = 事件链重建（见 §2）；Runtime terminal ≠ Task DONE（Claim → REVIEW 链保持）。

## 2. Terminal Evidence 重建（DSH，seam 已核实）

```text
持久证据 = turn/start(turn=n) → … → turn/end → assistant/message（known-event-types + splice 删除型 claim 证据，C-006/C-010）
agent.whenIdle() 仅同步辅助，非权威 terminal（C-010）
runtime_execution_ref = 该 turn 边界（turn=n）或 session log 游标
```

`src/dispatch/evidence.ts`：输入 `session.events`（或事件流），输出 `{ turnObserved, terminalEvent?, assistantMessage?, claimedAt? }`；无证据 → UNKNOWN。

## 3. Reconcile（两维独立，fail-closed）

```ts
// src/dispatch/reconcile.ts
reconcile(kingdomDispatchId, refs): {
  executionObservation: 'QUEUED' | 'RUNNING' | 'TERMINAL' | 'UNKNOWN'
    // QUEUED = INTENDED 已持久、未见 turn/start；RUNNING = 见 turn/start 无 terminal；
    // TERMINAL = 有 terminal 证据；UNKNOWN = 事件链不可判定
  sessionObservation: 'AVAILABLE' | 'GONE' | 'UNKNOWN'
    // AVAILABLE = live（ctx.agents.get(sessionRef)）或持久可恢复（sessionPersistence）；
    // GONE = session 已删；UNKNOWN = 均不可判定
  evidence?: unknown; terminalOutcome?: unknown
}
```

硬规则（Stage 2 冻结，全部落测试）：
- `SESSION_GONE ≠ TERMINAL`：session=GONE + execution=UNKNOWN → 仍 RECOVERING + fail-closed，不开新 attempt；
- `UNKNOWN` 禁止超时自动 ABORT：默认 remain RECOVERING → no new dispatch；处置须 Owner 治理裁决（事件+原因）；
- crash 关联用 `kingdom_dispatch_id`（dispatch 前已知、crash 后仍可查）→ `reconcile(kingdomDispatchId, …)`，不盲发。

## 4. Crash Matrix（v6 §7.2 C-1..C-7 + §30 A–J，全部做成测试）

| Crash 点 | 落库状态 | 恢复动作（期望） |
|---|---|---|
| A/J：plan commit 前 / host restart | Lease ACQUIRED/PREPARING，无 plan 或 plan 已持久 | 无 Runtime mutation → 可安全 release（zero execution）或续 materialize；不重复执行 |
| B：materialize 后 / final decision 前 | Lease MATERIALIZING + plan，无 decision | 不 release（cleanup 不明 → RECOVERING）；session 禁新 lease |
| C：decision 后 / intent 前 | Lease DISPATCH_READY + GRANTED decision，无 dispatch | cleanup/recovery；不 dispatch |
| D：INTENDED commit 后 / dispatch 前 | Dispatch INTENDED，无 runtime_dispatch_ref | reconcile(dispatch_id)：未见 turn → 可安全重发或 release（zero execution） |
| E：dispatch 后 / receipt 前 | INTENDED，runtime 侧可能已执行 | reconcile：事件链查 turn；UNKNOWN → RECOVERING，不盲发 |
| F：receipt 后 / correlation 前 | DISPATCHED→RECEIVED | reconcile 续 correlation；不重复 dispatch |
| G：correlation 后 / terminal 前 | CORRELATED | 等/查 terminal 证据；无证据 → RECOVERING |
| H：terminal 后 / cleanup 前 | Dispatch TERMINAL，Lease SETTLING | 续 cleanup → release；不 settle 两次 |
| I：cleanup 中 | Lease RELEASING | cleanup 不确定 → RECOVERING（不 RELEASED） |
| 全部 | — | 不重复执行 / 不错误 release / 不错误 settle / 不错误建新 attempt / 不伪造 terminal / 不改 Task 治理状态 |

## 5. Foreign / Unmanaged Dispatch Safety（G12 种子）

- **Prevent**：Lease = Kingdom governed dispatch mutual exclusion（非 Runtime 全局独占锁，不承诺外部进不来）；
- **Detect + fail-closed**：active Lease 期间 session 事件链出现**非本次 dispatch 的 turn/start 或外来 user 消息**（对比 runtime_dispatch_ref / 事件归属）→ dispatch/execution 标记 untrusted → **RECOVERING**，禁止 settle/release 并声称可信；
- 声明强度=证明强度：只能声称「能检测并拒绝信任」，不声称完全阻止 ingress。

## 6. Domain wiring（S2 governed API 已覆盖状态推进；S5 只加证据/协调层）

```text
src/dispatch/evidence.ts   事件链 → 证据对象
src/dispatch/reconcile.ts  reconcile(kingdomDispatchId, refs)（adapter 提供两维观察）
复用：recordDispatchReceipt / correlateRuntimeExecution / recordTerminalEvidence /
      advanceDispatchState / markLeaseRecovering / markDispatchRecovering / markExecutionRecovering / releaseExecutionLease
```

## 7. 施工顺序（S4 完成后执行）

1. `src/dispatch/evidence.ts` + `src/dispatch/reconcile.ts`；
2. adapter 补 `observeExecution` / `reconcile` 实现（事件链 + sessionPersistence）；
3. Crash matrix 测试（§4 全表，临时库 + 真 DSH session，poc 前缀隔离）+ Foreign dispatch 检测测试；
4. 回归 + 呈报 M3-S5 Implementation Report（§40 S5 格式）。
