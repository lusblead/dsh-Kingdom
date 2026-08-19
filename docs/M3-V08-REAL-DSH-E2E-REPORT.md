# M3-V08-REAL-DSH-E2E-REPORT（v3 最终版 · Owner REAL-DSH E2E COMPLETION WINDOW）

> 日期：2026-08-19
> 性质：Owner REAL-DSH E2E COMPLETION WINDOW 执行报告（A 最小稳定性诊断 + B 补全 12–20 + 完整 E2E + 正式入口 E2E）
> 裁决状态：**Blocker #2 = CLOSED**；**REAL DSH E2E = FULL PASS**；V0.8_RC = **HOLD（RC PHASE）**；RELEASE = **NOT AUTHORIZED**
> BLOCKER #2 = **CLOSED**（Owner V0.8 PRODUCTION-PATH CLOSURE 裁决：根因修复 + B0–B3 真实差分 + 完整 E2E + 正式入口 E2E 全部通过）

---

## 0. 汇总

- **A（最小稳定性诊断）完成**：三次真实模型 turn 全部伴随 dsh web 实例进程重启（PID 34800→29680→42888）；无 Windows 级崩溃事件；`turn/end reason=interrupted` 持久证据；worker 请求配置继承 `maxTokens=256000 / reasoningEffort=high`（疑似重请求诱因，**未证实**）；**未发现 Kingdom 治理代码直接触发进程退出**——但按 Owner 口径：根因 **UNRESOLVED**，不声称已证明非 S2–S6 缺陷。
- **B（补全 12–20）**：实时驱动在当前实例不可行（三次 followup → 三次重启）；**持久 session log 回收路径已验证可用**（sessionPersistence.readFrom 读出 attempt 6 完整 17 事件链，含 followup user/message id=`8d693a66`、turn/start、turn/end=interrupted）；attempt 6 以真实 interrupted 证据收尾（负例 F 真实 ×3）。

## 1. A — 最小稳定性诊断（结论：未发现 Kingdom 代码明确触发；根因 UNRESOLVED）

### 收集到的事实
| 证据 | 内容 |
|---|---|
| host/process restart 事实 | web 实例 PID：34800（09:33）→ 29680（15:54:06）→ **42888（16:03:34）**；三次重启时间戳与模型 turn 精确重叠（followup 后 22s 内） |
| injector self-heal | `purge-stale-tools` 于 07:44:54 / 07:47:35 / 07:54:13 / 08:03:42 UTC（=每次重启点）；无 error/crash 记录 |
| Windows 事件日志 | 15:40–16:00 无 Application Error / Event 1000 / 1001（**仅排除 native hard crash**；**不排除 DSH fail-loud `process.exit(1)`**——app-boot 对未接住的 `unhandledRejection` 写 `dsh: fatal load failure` 后 exit(1)，不产生 Windows crash 事件） |
| 持久 session log（attempt 6） | `turn/start`(turn=1) → `step/start` → `step/end` → **`turn/end {reason:{kind:'interrupted'}}`**；无 `assistant/message`；followup `user/message id=8d693a66` 在链中 |
| 模型请求配置 | `request/header`：`{provider:deepseek-vision, model:deepseek-v4-pro, maxTokens:256000, reasoningEffort:high}`（worker session 继承根 agent 配置——E2E 未覆盖此参数） |
| Kingdom 代码路径 | governed/dispatch/adapter 为纯库调用：无 `process.exit`/`process.kill`/未捕获异常处理；staging 工具错误（如 SQLite 绑定错误）由工具运行时捕获显示 ERROR，不杀进程 |

### 回答 Owner 问题：实例消失是否可能由当前 Kingdom governed execution 直接触发？
- **未发现** Kingdom 治理代码（S2–S6 lib 路径）直接触发进程退出的调用或异常路径；
- 重启**总是**发生在真实模型 turn 执行窗口（turn/start 之后、完成之前）——进程在 provider 响应返回前退出；
- 候选诱因（未证实）：worker session 继承 `maxTokens=256000 + reasoningEffort=high` 的重型模型请求与实例并发/资源交互；属 **E2E 参数与实例层**，非 Kingdom 治理逻辑；
- **结论：根因 UNRESOLVED（BLOCKER #2 = UNRESOLVED RUNTIME / INTEGRATION STABILITY）**。按 Owner 指令，不得声称已证明非 S2–S6 缺陷；不展开 DSH 上游研究。**措辞修正（FINAL WINDOW）**：无 Windows Application Error 事件**仅排除 native hard crash（段错误/原生崩溃）**；**不排除** DSH `installFailLoud()` 对未接住 `unhandledRejection` 的 `process.exit(1)` 显式退出路径（`packages/boot/app-boot/src/index.ts:609-648`）——该路径同样不产生 Windows crash 事件。历史 stderr 被下次启动覆盖，无法证实/排除该路径。

## 2. B — 补全主路径 12–20（结果）

### 实时驱动（attempt 6，极简 prompt「只回复：OK」）
| # | 主路径 | 结果 |
|---|---|---|
| 12 real Terminal Evidence | ⛔ 未获得 | turn/end=interrupted（无 assistant/message）→ **非 terminal**；实例重启无法继续实时轮询 |
| 13 Execution terminal ≠ Task DONE | ⛔ 未实时 | execution 停 RUNNING→RECOVERING；Task 保持 ASSIGNED（治理不变 ✅） |
| 14 real Claim | ⛔ 未实时 | — |
| 15–20 REWORK/resume/二次/cleanup/release | ⛔ 未实时 | 实例不稳定（3 次重启），按 Owner 指令停止实时尝试 |

### 已建立的替代/部分证据
- **持久 session log 回收路径（可复用）**：`sessionPersistence.readFrom` 成功读出 attempt 6 全部 17 事件（含 followup 消息 id、turn/start、turn/end=interrupted）——**terminal 回收的机制已验证**，待稳定实例复验窗口直接复用；
- **attempt 6 真实 interrupted 证据**：`turn/end {reason:{kind:'interrupted'}}` 落持久日志（真实，非 fake）；
- **负例 F（无法证明 terminal → RECOVERING 不 release）真实 ×3**（attempt 4/5/6，实例重启遗留 → decideRecovery=RECOVERING → applyRecovery 三对象转 RECOVERING，Task 不变）——**本窗口新增 attempt 6 一条真实证据**；
- 负例 H（REWORK same-session）与 C（guard deny 实时）未实时执行（实例不稳定），代码层 fake 测试 + 本窗口真实 gate/materialize/restrict+guard 装配证据覆盖。

## 3. 负例汇总（真实证据累计）

| 负例 | 状态 | 证据 |
|---|---|---|
| A 同 Session 第二 active Lease → DB 拒绝 | ✅ 真实 | UNIQUE constraint failed |
| B Territory mismatch → acquire 拒绝 | ✅ 真实 | task/lease territory 不一致 |
| C guard deny | ⚠️ 部分 | guard:monotonic-deny 真实装配（3× evidence）；实时模型调用未回收 |
| D workspace 外写 | ⚠️ 不可执行 | 实例无写工具；sandbox/mode=workspace-write 真实装配；PoC E 组实证 |
| E escalation 拒绝 | ✅ 部分 | approval/policy=never 真实落事件（3×） |
| F 无法证明 terminal → RECOVERING 不 release | ✅ **真实 ×3** | attempt 4/5/6 全部：dispatch/lease/execution→RECOVERING，Task 不变 |
| G foreign dispatch | ⚠️ 未实时 | 代码层 S5/S6 覆盖 |
| H REWORK same-session | ⚠️ 未实时 | 代码层 governed-runner 覆盖；session affinity Ledger 显示同 worker 多 session 退役/新建正确 |

## 4. 安全边界确认

✅ 仅测试 Kingdom（e2e 前缀）+ TEMP 库；正式 kingdom.db 未触碰（v3，无 v4 表——只读核实）；
✅ 无 commit/tag/push/publish；未改 package version；未继续 GUI；未降级；未绕过 fail-closed（全部 DENIED/RECOVERING 严格）；
✅ 未用 fake 冒充真实（attempt 6 interrupted 为真实持久证据）。

## 5. 结论与下一步（等待 Owner Review）

1. **S4 seam blocker = CLOSED**（真实 GRANTED+ENFORCED ×3 + 完整 evidence）；
2. **REAL DSH E2E = PARTIAL PASS**（主路径 1–11 + 负例 A/B/E/F 真实；12–20 受 UNRESOLVED RUNTIME/INTEGRATION STABILITY 阻塞）；
3. **建议**（供 Owner 裁决）：
   - 复验窗口在**稳定/低负载实例**重开，复用已建立的持久日志回收路径 + 分步短调用；
   - E2E worker session 创建时**覆盖 agentOptions.maxTokens/reasoningEffort 为低值**（当前继承 256K/high，疑似诱因），作为最小参数修正（不改 Kingdom 逻辑）；
   - 实例稳定性根因调查另行立项（不属 v0.8 施工范围，不展开 DSH 上游研究）；
4. **状态：重新进入 HOLD**。staging 工具（`kingdom_v08_e2e_*`）保留后侧供复验复用。

---

## 6. 追加：S3/S5 terminal fail-closed 修复（回应 STABILITY-FINDINGS §4.2，2026-08-19）

调查 agent（`STABILITY-FINDINGS.md`）发现独立 Kingdom 缺陷：**任意 `turn/end` 被判 TERMINAL → 写成 execution COMPLETED**，会把 crash-recovery 合成的 `interrupted` 等错误升级为成功。已实施 fail-closed 修复并回归：

### 修复内容
- `src/dispatch/evidence.ts`：TERMINAL 仅当同一归属 turn 满足 **① `turn/end.reason.kind == 'completed'` ② 存在 `assistant/message`**；`interrupted/aborted/blocked/error/max-tokens`/缺 reason/缺 assistant → **UNKNOWN**（fail-closed → reconcile 走 RECOVERING，绝不写 COMPLETED）。新增 `turnEndReason` 字段（容错两种真实形态：`data.reason.kind` 与 `data.kind`）。
- `src/adapter/dsh-backend.ts`（S3 粗观测 `reconstructExecutionObservation`）：同条件同步修正（避免 reconcile 两条入口语义分叉）。
- `src/dispatch/service.ts`：无需改动（`recordTerminalEvidence` 仅在 `evidence.state === 'TERMINAL'` 时触发——修复判定后 interrupted 自然不进 COMPLETED 路径）。

### 回归测试
- 新增：`interrupted/aborted/blocked/error/max-tokens` + `completed 无 assistant` → 均非 TERMINAL（UNKNOWN）；`completed + assistant` → TERMINAL；
- S3 粗观测同断言（含 interrupted → UNKNOWN）；
- 既有 fake 事件补 `reason:{kind:'completed'}`（对齐真实 DSH shape）；
- **全量 95/95 PASS**。

### 影响
- 历史 E2E 中 attempt 4/5/6 的 `turn/end reason=interrupted` 持久证据，在修复后**不会被升级为 COMPLETED**（此前路径会误写）；当前 DB 中三者均为 RECOVERING（正确）。
- 该修复不改变 schema/状态机/Scope；`git diff --check` 通过；正式 DB 未触碰；无 commit/tag/push/publish。

---

## 7. 追加：FINAL REAL-DSH VALIDATION WINDOW（2026-08-19 第 2 轮）

### 7.1 代码层完成（Owner 指令 1–4）
1. **terminal fail-closed 修复保留**；
2. **已知终态收敛**（不改 Schema/Scope）：
   - `completed + assistant → COMPLETED`；`aborted → ABORTED`；`blocked/error/max-tokens → FAILED`；`interrupted → RECOVERING`；`ambiguous/missing → RECOVERING`。
   - 实现：`src/dispatch/evidence.ts` 新增 `terminalOutcomeOf()` + `DispatchEvidence.terminalOutcome`；`src/dispatch/service.ts` 按 `terminalOutcome` 落 execution 终态（`recordTerminalEvidence.executionTerminalState`）；S3 粗观测 `reconstructExecutionObservation` 同条件对齐；
3. **回归测试**：outcome 收敛断言（aborted→ABORTED、blocked/error/max-tokens→FAILED、completed+assistant→COMPLETED、interrupted/missing/completed-无-assistant→非终态）+ 集成落账（execution 终态、dispatch TERMINAL、lease SETTLING）——**全量 97/97 PASS**；
4. **文档措辞修正**：无 Windows Application Error 事件**仅排除 native hard crash**；**不排除 DSH fail-loud `process.exit(1)`**（app-boot `installFailLoud()` 对未接住 `unhandledRejection` 的显式退出路径，`packages/boot/app-boot/src/index.ts:609-648`）。

### 7.2 真实 E2E（Owner 指令 5–7）：第 1 次尝试即触发实例退出 → 按指令 STOP

**attempt 7（极简 prompt「只回复：OK」）**：
- F1 完成：resession（sessionRef `93fc79c6…`）→ gate **GRANTED+ENFORCED** → execution+intent → 真实 followup（08:53:25 UTC）→ receipt `aa4c7af0…`（RECEIVED）；
- **随后实例再次退出**：PID 42888 → **38364**（08:59:54 UTC 创建）；self-heal 09:00:02 `purge-stale-tools` 重启标记；
- **exit evidence 已保全**（e2e-final.log：F1 全程 PID/refs；attempt 7 持久 session log 9 事件）：`agent/inbox/spliced`(followup aa4c7af0) → `turn/start{turn:1}` → 进程退出 → crash recovery 合成 **`turn/end{reason:{kind:'interrupted'}}`**，无 `assistant/message`；
- 收尾：attempt 7 按真实负例 F → dispatch/lease/execution 全 RECOVERING，Task 保持 ASSIGNED。

**关键对比**：调查 agent 在同一 PID 42888 上 4 次裸探针（create+followup 极简 prompt）全部成功；本窗口 governed 编排路径（gate→execution→intent→followup）第 1 次即触发退出。**累计 governed 流程真实 worker turn：4/4 触发实例退出**（attempt 4/5/6/7）；裸探针 4/4 成功。差异点 = governed 编排上下文（lease/execution/dispatch 落库 + 事件链）或实例时段性故障；根因仍 **UNRESOLVED**，未取得被覆盖前的原始 stderr/exit code。

### 7.3 负例/主路径真实证据累计（FINAL）
- 真实 GRANTED+ENFORCED：**×4**（attempt 4/5/6/7）；
- 真实负例 F（无法证明 terminal → RECOVERING 不 release）：**×4**（attempt 4/5/6/7），Task 治理全程不变；
- 主路径 12–20（terminal/Claim/REWORK/second/resume/release）：**未完成**（实例退出，按 Owner 指令不重试第三次）。

### 7.4 最终状态
```text
V0.8_RC          = HOLD
RELEASE          = NOT AUTHORIZED
Blocker #2       = UNRESOLVED（root cause 未闭合；governed 真实 turn 4/4 触发退出，裸探针 4/4 成功）
S3/S5 terminal   = fail-closed 修复 + outcome 收敛（97/97 PASS）
REAL DSH E2E     = PARTIAL PASS（1–11 + 负例 A/B/E/F 真实；12–20 阻塞）
正式 DB          = 未触碰（v3，只读核实）；无 commit/tag/push/publish；GUI 未继续
```
等待 Owner 裁决：Blocker #2 处置（另行立项调查 governed 编排与实例退出交互 / 换稳定实例复验 / 调整 RC 判定）；staging 工具与 e2e-final.log 保留作证据与复验入口。

---

## 8. 追加：完整 Persistent Worker E2E（主路径 12–20 真实闭环 · 2026-08-19 第 3 轮）

> 依据 `M3-V08-E2E-CONSTRUCTION-HANDOFF.md`：Blocker #2 根因已修复并复验（代码层 100/100 + 真实差分 B0–B3 全 PASS），本窗口补跑 Owner FINAL REAL-DSH VALIDATION WINDOW 唯一剩余施工项——**完整 Persistent Worker E2E**。
> **结论：主路径 12–20 全部真实闭环，PASS。** V0.8_RC 保持 **HOLD**（等待 Owner Review）；RELEASE = NOT AUTHORIZED。

### 8.1 环境与复验基线

| 项 | 值 |
|---|---|
| dsh web 实例 PID | **60268**（开始 10:10 / 结束 10:12 均为 60268，全程不变） |
| 测试库 | `C:\Users\ADMIN\AppData\Local\Temp\kingdom-e2e\kingdom-e2e.db`（TEMP 全新重建 v4，与正式库隔离；kingdom `c91e5d15…`） |
| lib | `lib-e2e`（与 `lib` 逐文件 SHA-256 一致；修复后代码，ESM 缓存经新实例 PID 60268 全新加载） |
| 全量回归 | `node --test tests/*.test.ts` = **100/100 PASS** |
| 正式 DB | 只读核实 `MAX(schema_version)=3`、无 v4 表（未触碰） |
| worker session 参数 | provider=`deepseek-vision`, model=`deepseek-v4-flash`（实例实际模型；修复 `{{model}}` 模板错误，见 §8.5） |
| Capability | requirement/ceiling/grant = `{tool:code_check, tool:notify}`，sandbox `workspace-write` |

### 8.2 主路径执行记录（attempt 1）

| 步骤 | 值 |
|---|---|
| resession | retire 旧 affinity → `AgentRegistry.create` 新 session **`7eef5798-6e10-4468-8ba4-ae9d0f201fed`**（affinity `70ae5cc2…`，is_current=1） |
| Capability Gate | **GRANTED+ENFORCED**（decision `4a56931f-89d5-4518-a682-ad93c29c1d5d`，coverage=FULL，materialize 真实装配 sandbox=workspace-write + approval=never + restrict/guard） |
| TX-3 | lease `f5f12692-6880-4fb0-bb15-19fa9531b807` → execution `ae5bd7a3-047c-48d4-b8e7-e337b2b509d4`（GOVERNED_PERSISTENT）→ intent `7894dd04-5a7a-4797-8a9d-0d2835727298`（COMMIT POINT）→ lease EXECUTING |
| dispatch + receipt | 极简 prompt「只回复：OK。不要调用任何工具。」→ receipt `b6cb9726-1f89-4441-8216-c910b83f06f2`（RECEIVED） |
| Terminal Evidence | **turn-1 `completed` + `assistant/message`（内容 "OK"）** → dispatch TERMINAL、execution **COMPLETED**、lease SETTLING |
| Claim 1 | worker_results(attempt 1, COMPLETED, summary="OK", session=`7eef5798…`) → Task **REVIEW** |
| TX-5（attempt 1） | adapter.cleanup(ok) + settleAndRelease → lease1 **RELEASED**（10:12:46，`settled-cleanup-ok-attempt1`）；session 无 active lease |
| REWORK | Task REVIEW→RUNNING（10:11:52，`TASK_REWORKED` 事件，Assignment 保持 ACTIVE） |

### 8.3 主路径执行记录（attempt 2，REWORK 后同 session 续用）

| 步骤 | 值 |
|---|---|
| ensureWorkerSession | current affinity → **resume 同一 session_ref `7eef5798-…`**（H 断言：second == first ✅；live handle 复用，见 §8.5-2） |
| Capability Gate | **GRANTED+ENFORCED**（decision `de2d373e-1915-44b5-84a2-195c405078c0`，coverage=FULL） |
| TX-3 | lease `55e69682-9318-4588-b3b8-93e166a60bff` → execution `81de3224-153c-4de0-b138-095964245709` → intent `92332ad9-4c0d-4474-8682-750c597dbb89` → lease EXECUTING |
| dispatch + receipt | 同极简 prompt → receipt `6f121ccf-f540-4082-9137-6e61f284230a`（RECEIVED） |
| Terminal Evidence | **turn-2 `completed` + `assistant/message`（内容 "OK"）** → dispatch TERMINAL、execution **COMPLETED**、lease SETTLING |
| Claim 2 | worker_results(attempt 2, COMPLETED, summary="OK", session=`7eef5798…`) → Task **REVIEW** |
| TX-5（attempt 2） | adapter.cleanup(ok, disposed=2) + settleAndRelease → lease2 **RELEASED**（10:12:55，`settled-cleanup-ok`）；`getActiveLeaseForSession` == **null** → **session 可复用** ✅ |

### 8.4 必须记录字段（handoff §2 逐项）与最终三态

| 字段 | attempt 1 | attempt 2 |
|---|---|---|
| host PID（before/after） | 60268 / 60268 | 60268 / 60268 |
| session_ref（H：second == first） | `7eef5798-…` | `7eef5798-…` ✅ 相同 |
| runtime_dispatch_ref | `b6cb9726-1f89-4441-8216-c910b83f06f2` | `6f121ccf-f540-4082-9137-6e61f284230a` |
| runtime_execution_ref | `turn-1` | `turn-2` |
| turn/end reason | `completed` | `completed` |
| assistant/message | true（"OK"） | true（"OK"） |
| 最终 execution state | **COMPLETED** | **COMPLETED** |
| 最终 lease state | **RELEASED**（10:12:46） | **RELEASED**（10:12:55） |
| 最终 task state | REVIEW | **REVIEW** |

**最终三态**：execution **COMPLETED ×2** · lease **RELEASED ×2**（final=RELEASED，session 无 active lease）· task **REVIEW**（Claim ≠ Fact，等 Supervisor 裁定）。

### 8.5 完成条件核对（handoff §4）——全部满足

| 条件 | 结果 |
|---|---|
| first/second session_ref 相同（H） | ✅ `7eef5798` == `7eef5798` |
| terminal ×2（completed+assistant） | ✅ turn-1/turn-2 均 completed + assistant/message（"OK"） |
| Claim ×2 → REVIEW | ✅ worker_results ×2 + task REVIEW |
| REWORK | ✅ REVIEW→RUNNING（同 Worker，Assignment 保持 ACTIVE） |
| cleanup | ✅ attempt1（e2b）+ attempt2（e6，disposed=2） |
| Lease RELEASED | ✅ ×2（含 release evidence/reason） |
| session 可复用（无 active lease） | ✅ `getActiveLeaseForSession == null` |
| PID 全程不变 | ✅ 60268 |
| fatal-*.err.log 无新增 | ✅ 仅修复前基线（17:10:36，PID 38364 时代）；本窗口零新增 |
| 无 interrupted | ✅ 两 turn 均 completed（无 crash-recovery 合成） |

### 8.6 新增 seam 发现（本轮未改任何代码；供 Owner 评估）

1. **worker session 必须配置 model**：无 model 的 session 触发 deployment prompt 段 `{{model}}` 模板错误 → `turn/end={kind:'error'}`（无 assistant）→ 按终态收敛映射应为 FAILED。插件 governed 工具构造 `DshRuntimeAdapter` 时 `model: null`（`lib/index.js`）——真实 governed 路径存在同类隐患，需在 worker provider/model 配置处补齐（本轮 E2E 显式传 provider/model 通过）。
2. **`agents.resume` 对 live session 抛 `cannot prepare session … while it is live`**（`PersistenceCoordinator.prepare`）——同进程 REWORK 续用必须复用 live handle（同一 session_ref 即同一持久 session）；插件 `runGovernedTask → ensureWorkerSession` 在 REWORK 后第二次调用会踩此 seam（建议 Adapter 层处理：live 优先复用、非 live 才 resume）。
3. **one-active-lease-per-session（部分唯一索引）**：SETTLING 仍占位，attempt 间必须先 TX-5 release 才能 acquire 新 lease——「一个 Session 最多一个 active Lease + Lease = 单 Attempt 互斥」由 DB 权威强制（非缺陷，契约如此）。
4. **注入器 staging ctx 的 `sandboxPolicy`/`approval` 是服务对象而非模块**：materialize 需直连 `@deepseek-ai/dsh-sandbox-policy` / `@deepseek-ai/dsh-user-approval` 模块面（`setSandboxMode`/`setApprovalPolicy`）；属测试工具 wiring 知识，非 lib 缺陷。

### 8.7 最终状态

```text
完整 Persistent Worker E2E（主路径 12–20）= PASS（真实闭环）
Blocker #2 根因修复          = 代码层 100/100 + B0–B3 真实差分 + 本窗口 governed 真实 turn 2/2 稳定
                              （对比修复前 governed 真实 turn 4/4 触发实例退出；裸探针 4/4 成功）
REAL DSH E2E                 = FULL PASS（此前 PARTIAL PASS：1–11 + 负例 A/B/E/F）
V0.8_RC                      = HOLD（等待 Owner Review）
RELEASE                      = NOT AUTHORIZED
正式 DB                      = 未触碰（v3，只读核实）；无 commit/tag/push/publish；GUI 未继续
staging 工具                 = `k08_e2e_init/e1/e2/e2b/e3/e4/e5/e6` 保留后侧（evidence + 复验入口）；
                              日志 `e2e-final.log` 全步骤可追溯；事件账本（LEASE/EXECUTION/DISPATCH/DECISION/CLAIM）完整
```

**呈报 Owner Review**：E2E 通过 → Blocker #2 可评估关闭 → RC 重评（本报告 §8 与 `M3-V08-BLOCKER2-DIFFERENTIAL-ISOLATION.md` 为证据）。

---

## 9. 追加：正式插件入口 REAL DSH E2E（Owner V0.8 PRODUCTION-PATH CLOSURE · 2026-08-19）

> Owner 裁决：Blocker #2 = CLOSED、REAL DSH E2E = FULL PASS；只修复完整 E2E 暴露的正式插件路径 seam，然后以**正式插件对外入口 `kingdom_start_task_governed`**（隔离 TEMP Kingdom/DB，不再用 staging 手工拼链）复验完整闭环。

### 9.1 结论

**正式入口完整 E2E = PASS。** 全程通过正式工具面（`tools.execute` 驱动已注册的 `kingdom_*` 工具，与模型调用同一代码路径）在隔离 TEMP 库（`%TEMP%\kingdom-e2e-prod5`，DSH_HOME 重定向 + 插件热重载）完成：

`init → create_territory → bind_role(SUPERVISOR/CHANCELLOR/WORKER) → set_territory_supervisor → set_execution_profile(provider+model) → plan_task → assign_task → start_task_governed(attempt 1) → review_task(REWORK) → start_task_governed(attempt 2, 同 session)`

### 9.2 Seam 修复清单（全部在 `src/`，回归 106/106 + 正式入口实证）

| # | Seam | 修复 | 测试 |
|---|---|---|---|
| A | Worker provider/model 解析：正式 governed tool 曾 `model:null`（DSH deployment prompt 段 `{{model}}` 缺失 → turn=error） | `resolveGovernedWorkerRuntime`（`executor-factory.ts`）：权威来源 = Worker `execution_profile_json`（绝不读 model_name 等席位元数据）；provider=profile ?? 全局 workerProvider；**model 必须显式配置，缺失 → fail closed configuration error（不创建 Session、不 dispatch、零 hardcode）**；`runGovernedTask` 前置解析并把 provider/model 显式传入 `ensureWorkerSession` | configured worker 正确解析 / model missing fail closed zero execution / 显式配置不被全局覆盖 |
| B | Live Session reuse：`agents.resume` 对 live session 抛 `cannot prepare … while it is live` | `RuntimeAdapter.getLiveHandle(sessionRef)`（契约新增）+ `DshRuntimeAdapter` 实现 + `ensureWorkerSession`：live → 复用同一 handle；不 live → resume；禁止 live 时强行 resume / 禁止因 resume 失败新建第二 session / 禁止退化 one-shot | live reuse 不调 resume / 不 live 可恢复 → resume / REWORK same session_ref / gone fail closed |
| C1 | S4 materialize 接线：正式 governed tool 曾把 ctx **服务对象**（SandboxPolicyService/ApprovalService，无 `setSandboxMode`/`setApprovalPolicy`）当模块传入 → `MATERIALIZE_FAILED` | 正式工具侧动态 import `@deepseek-ai/dsh-sandbox-policy` / `@deepseek-ai/dsh-user-approval` **模块函数**（`session.append('sandbox/mode'/'approval/policy')`）；解析失败 → null → DENIED（fail-closed，不崩溃插件） | 正式入口 E2E：GRANTED+ENFORCED ×2 实证 |
| C2 | **guard 语义**：`materializeDshEnforcement` 对**允许**工具返回 `null`，但 dsh ToolGuard 运行时仅 `undefined` 放行（`null` 被当拒绝 reason）→ 被授权工具全部 `Error: null` | guard 允许分支返回 `undefined`；`DshAgentScopeLike.guard` 类型同步 `string \| undefined` | s4 断言更新（allowed→undefined）；正式入口实证（被授权工具正常执行） |
| C3 | **轮询快照失效**：`runGovernedDispatch` 捕获一次 `session.events`，但真实 DSH `session.events` 是 **getter**（每次访问返回新投影数组）→ 后续 turn/end/assistant 永远不可见 → 60s 超时 CORRELATED | 轮询**每轮重读** `session.events`（correlation + terminal 两个循环） | 新增 getter 版回归测试（106/106） |
| C4 | attempt 编号忽略 Lease Ledger：gate 拒绝（zero-execution）后重试撞 `UNIQUE(task_id, attempt_no)` | 正式工具 `attemptNo = max(nextAttemptNo, max(该任务 lease attempt_no)+1)` | 正式入口 E2E（gate 拒绝后重试不再撞唯一约束） |
| C5 | 真实模型 turn 轮询窗口太短（默认 100ms×40=4s） | 正式工具显式 `pollIntervalMs: 1000, maxPolls: 60`（超窗 → fail-closed RECOVERING，由 reconcile 处理） | 正式入口 E2E（窗口内 terminal） |

### 9.3 正式入口 E2E 执行记录

| 步骤（正式工具） | 结果 |
|---|---|
| `kingdom_init` | 初始化 TEMP 王国（schema v4，与正式库隔离） |
| `kingdom_create_territory` | terr-a（工作区 `%TEMP%\kingdom-e2e-prod5\terr-a`） |
| `kingdom_bind_role` ×3 | SUPERVISOR / CHANCELLOR / WORKER（declarative 席位） |
| `kingdom_set_territory_supervisor` | 领地主理 = E2E-Supervisor（fail-closed 前置） |
| `kingdom_set_execution_profile` | **provider=deepseek-vision, model=deepseek-v4-flash**（正式配置路径） |
| `kingdom_plan_task` / `assign_task` | 任务 CREATED → ASSIGNED（Assignment Ledger 落账） |
| `kingdom_start_task_governed`（attempt 1） | **「Session d97feb16 新建」→ Claim（summary=OK）→ Task REVIEW** |
| `kingdom_review_task` | REWORK → RUNNING（同 Worker Binding，Assignment 保持 ACTIVE） |
| `kingdom_start_task_governed`（attempt 2） | **「Session d97feb16 复用」（live 复用，未 resume）→ Claim（summary=OK）→ Task REVIEW** |

### 9.4 Owner D 验证清单——全部通过

| 项 | 证据 |
|---|---|
| provider/model 来自正式配置路径 | `execution_profile_json = {"provider":"deepseek-vision","model":"deepseek-v4-flash"}`（`kingdom_set_execution_profile` 写入；`resolveGovernedWorkerRuntime` 解析） |
| first session_ref == second session_ref | `d0031aeb-2923-487d-a140-cbf4d97feb16` == `d0031aeb-2923-487d-a140-cbf4d97feb16`（hAssert=true；attempt 2 工具回显「复用」） |
| live session 第二轮没有错误 resume | attempt 2 `created=false`（`getLiveHandle` 复用；未调用 `agents.resume`） |
| Capability GRANTED+ENFORCED | decision `fbcf7ff9…` / `173d6d2c…`（coverage FULL，enforcement_evidence 落账） |
| Execution COMPLETED ×2 | `24062997…` / `e12ba121…`（GOVERNED_PERSISTENT，ended_at 已落） |
| Lease RELEASED ×2 | `a9a2c5b6…`（10:43:44）/ `43a03f49…`（10:43:46），release evidence 完整 |
| Task REVIEW | status=REVIEW，result_summary=「OK」（Claim ≠ Fact） |
| PID 不变 | 60268（E2E 前后一致） |
| fatal log 无新增 | `%TEMP%\kingdom-e2e-prod5\fatal-*.err.log` 零文件；`e2e-prod.log` 全步骤可追溯 |

### 9.5 回归（Owner C）

- `git diff --check`：**通过**（无空白错误）
- 全量测试：**106/106 PASS**（新增：CLOSURE A ×3、CLOSURE B ×2、getter 版轮询 ×1；更新：REWORK live 复用、s3 live 复用语义、s4 guard 契约）
- Python v6 verifier（`m3s2_v6_verify.py`）：**49/49 PASS**

### 9.6 安全边界与状态

- 正式 `kingdom.db`：只读核实 `MAX(schema_version)=3`、无 v4 表、mtime 未变（**未触碰**）；E2E 全程在 `%TEMP%\kingdom-e2e-prod5` 隔离库
- 无 commit/tag/push/publish；GUI 未继续；未降级 one-shot、未关闭 fail-closed；未改 Schema / M3-S1 冻结语义（seam 修复均在既有契约内：provider/model 解析、session 获取、guard 语义、轮询重读、attempt 编号）
- 插件已热重载回正式库（DSH_HOME 恢复）；staging 工具 `k08_prod_*` 保留作证据

```text
V0.8_RC      = HOLD（等待 Owner Review）
RELEASE      = NOT AUTHORIZED
Blocker #2   = CLOSED（Owner 裁决）
REAL DSH E2E = FULL PASS（staging 完整链 + 正式入口完整链双路径）
```

**呈报 Owner**：A/B 两 seam 已修复（含测试）；正式入口 E2E 双 attempt 同 session 完整闭环 PASS；C3（guard 语义）/C4（轮询 getter）为正式入口暴露的**额外正式路径缺陷**，一并修复并回归；建议按 Owner 流程复核后进入 RC 重评。
