# M3-S3 Implementation Report（v0.8 第二阶段 · S3 Adapter Contract + DSH Persistent Backend）

> 日期：2026-08-19
> 依据：M3-S3 Thin Spec（DRAFT→已实施）；Owner v0.8 施工 Prompt §17–§20
> 状态：**待 Owner 复核**（S2 acceptance 仍开放；S3 为自主推进模式下依总 Prompt「一路推进到 v0.8.0」口径实施，未触碰正式 DB、可逆）

---

## 1. Adapter interface

`src/adapter/contract.ts`（**零 dsh import**，Runtime-independent，Core 只依赖本接口）：

```text
RuntimeRefs { runtimeType, runtimeInstanceRef, sessionRef, runtimeDispatchRef?, runtimeExecutionRef? }
SessionHandle { refs, agent(unknown), session(unknown), dispose() }
RuntimeAdapter
├── identify()
├── createSession / resumeSession / observeSession / retireSession
├── capabilities / preflight / materialize / cleanup（S4 消费；S3 诚实 CANNOT_ENFORCE）
└── dispatch / observeExecution / reconcile
DispatchReceipt { refs, acceptedAt }            ← 只证明「已接受」
ReconcileResult { executionObservation, sessionObservation, evidence?, terminalOutcome? }
```

## 2. DSH mapping（@ 00b7102f1d，结构型注入面，不新增 peer dep）

| Contract | DSH 实现（源码核实） |
|---|---|
| createSession | `AgentRegistry.create({sessionId: uuid, meta:{cwd, agentPreset}, agentOptions, setup})`——setup 挂 preset（`agentPresets.mount`） |
| resumeSession | `AgentRegistry.resume({resumeSessionId: session_ref, agentOptions})`——同一 session_ref 恢复同一长期会话 |
| dispatch | `agent.followup(完整 UserMessage)`——`runtimeDispatchRef` = UserMessage.id；不存在的 session 拒绝（不盲发） |
| observeSession | `agent.status`（idle/running）+ live registry |
| observeExecution | `session.events` 事件链重建：user/message→turn/start→turn/end→assistant/message → QUEUED/RUNNING/TERMINAL/UNKNOWN |
| reconcile | 两维独立：session 维 = live registry + `sessionPersistence.has` → AVAILABLE / 否则 UNKNOWN（不盲判 GONE）；execution 维 = 事件链，不可判 → UNKNOWN（fail-closed） |
| retireSession | `AgentHandle.dispose()` |
| capabilities/preflight/materialize/cleanup | S3 诚实返回声明/拒绝（`CANNOT_ENFORCE`），S4 实现 |

## 3. Persistent Session lifecycle

`src/adapter/session-store.ts`：
- `ensureWorkerSession`：无 current affinity → createSession → **establishAffinity（governed API）** → 更新 role_binding current projection；有 current → **resume 同一 session_ref**（REWORK 唤醒同一 Worker，不得每次 Task 自动新建）；
- `retireWorkerSession`：retire 旧 affinity（历史留 Ledger）+ 清 projection → 调用方可 create 新 Session（跨 Territory 语义：新建而非改绑）；
- 越权防护：非 ACTIVE WORKER binding 拒绝；一 Worker 一 current（DB 部分唯一索引权威）。

## 4. Tests

| 组 | 结果 |
|---|---|
| S3 adapter（新 8 项） | create/resume/retire 形状 + setup preset 装配 / dispatch→followup 完整消息+Receipt 引用 / observeExecution 四态事件链重建 / reconcile 两维 / ensureWorkerSession 建+续+退休重绑 / 越权拒绝——**8/8 PASS** |
| 全量回归 | **63/63 PASS**（既有 55 + S3 8） |

**E2E 诚实声明**：以上为 fake AgentsLike 的确定性单元验证（与 dsh-subagent 同款模式）。真 DSH session 的实机 E2E（create→affinity→resume 同 ref→REWORK 唤醒→事件链 terminal）将在运行实例注入阶段执行（S5/S6 harness，poc-m3s0 前缀隔离），届时作为 RC Gate 证据。

## 5. Unresolved Runtime gaps（诚实）

1. 无同步完成回执：`followup` 只保证入队；terminal = 事件链重建（v6 已按此设计）；
2. enforcement 装配点 = setup（create/resume 时）+ session-mode 切换（运行时）；S4 走 `permissionPresets.set`/`setSandboxMode`/`setApprovalPolicy`/guard；
3. `session.header.cwd` create 时固化、运行中不可改（与「禁跨界漂移」一致）；
4. reconcile 的 GONE 判定需显式删除证据（S5 细化）；当前缺证据一律 UNKNOWN（fail-closed）。

## 6. 下一步

S2 acceptance + S3 复核 → S4（Resolver + DSH Enforcement，spec 已备）→ S5（Dispatch Evidence + Recovery，spec 已备）→ S6 Gate → GUI → 回归 → RC → Release。
