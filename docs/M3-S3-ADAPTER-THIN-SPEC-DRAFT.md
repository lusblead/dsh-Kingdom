# M3-S3 Thin Spec — RuntimeAdapter Contract + DSH Persistent Backend（DRAFT）

> 状态：**DRAFT / 待 Owner M3-S2 implementation acceptance 后立即施工**（§17/§39：只允许形成本短实施规格，回答两个问题，然后施工，不写大型设计文档）。
> 依据：M3-S1 Design v3（FROZEN）+ M3-S2 v6（APPROVED）+ Owner v0.8 施工 Prompt §18–§20。
> 红线：不修改 DSH 上游源码；缺 seam 诚实返回 CANNOT_ENFORCE/BLOCKED/UNKNOWN；禁止偷偷 fork DSH / 用 Prompt 假装 enforcement。

---

## 1. RuntimeAdapter interface（Runtime-independent Contract）

```ts
/** 泛化 Runtime 引用（Core 不解释内部格式，M3-S1 冻结）。 */
interface RuntimeRefs {
  runtime_type: string            // 'dsh'
  runtime_instance_ref: string    // 本机 DSH host 实例稳定 id
  session_ref: string             // 持久 session id（AgentRegistry sessionId）
  runtime_dispatch_ref?: string   // 一次 dispatch 的 runtime 侧引用（messageId / inbox ref）
  runtime_execution_ref?: string  // 一次 execution 的 runtime 侧引用（turn / session log 游标）
}

interface SessionHandle {
  refs: RuntimeRefs
  agent: unknown                  // DSH Agent（adapter 私有；不升格 Core 类型）
  session: unknown                // DSH Session（adapter 私有）
  dispose(): Promise<void>        // 退役/卸载：停 loop、注销、删 session
}

interface RuntimeAdapter {
  readonly runtimeType: 'dsh'
  identify(): { runtime_type: string; runtime_instance_ref: string }

  // ── Session 生命周期（§20）──
  createSession(input: { cwd: string; agentPreset?: string }): Promise<SessionHandle>
  resumeSession(input: { sessionRef: string }): Promise<SessionHandle>
  observeSession(handle: SessionHandle): 'idle' | 'running' | 'maintenance' | 'gone' | 'unknown'
  retireSession(handle: SessionHandle): Promise<void>

  // ── Capability（§21–§23，S4 消费；本 Spec 只定形状）──
  capabilities(runtimeContext: unknown): RuntimeEnforceableSet   // context-bound
  preflight(enforcementRequest: unknown, runtimeContext: unknown): PreflightResult   // 纯检查、无副作用
  materialize(plan: unknown, runtimeContext: unknown): MaterializeResult             // Runtime mutation，dispatch 前
  cleanup(plan: unknown, runtimeContext: unknown): CleanupResult                     // teardown evidence

  // ── Dispatch / Evidence / Reconcile（§24–§28，S5 消费）──
  dispatch(input: { sessionRef: string; message: { role: 'user'; content: { type: 'text'; text: string }[] } }): Promise<DispatchReceipt>
  observeExecution(refs: RuntimeRefs): 'QUEUED' | 'RUNNING' | 'TERMINAL' | 'UNKNOWN'
  reconcile(kingdomDispatchId: string, refs: RuntimeRefs): ReconcileResult
}

interface DispatchReceipt { refs: RuntimeRefs; acceptedAt: string }   // 只证明「已可靠接受」，非 terminal
interface ReconcileResult {
  executionObservation: 'QUEUED' | 'RUNNING' | 'TERMINAL' | 'UNKNOWN'
  sessionObservation: 'AVAILABLE' | 'GONE' | 'UNKNOWN'
  evidence?: unknown
  terminalOutcome?: unknown
}
```

契约纪律（与 v6/S1 冻结一致）：
- `dispatch()` 只在 Kingdom **COMMIT POINT（createDispatchIntent 提交后）** 调用；
- `DispatchReceipt ≠ Terminal Evidence`；terminal 靠事件链重建（见 §3 映射）；
- `SESSION_GONE ≠ TERMINAL`；`UNKNOWN` 不超时自动 ABORT → RECOVERING + fail-closed；
- 全部泛化引用走 `RuntimeRefs`，Core 不解释 `runtime_dispatch_ref`/`runtime_execution_ref` 内部格式。

## 2. DSH Mapping（本机 DSH @ 00b7102f1d，源码核实）

**插件注入面**：`inject = ['agents']`（`ctx.agents` = AgentRegistry，acp/src/index.ts:45 等已验证）；`ctx.agents.create/resume/get/list`；`agent.session.header.cwd`（affinity 验证证据，C-011）；`agent.session.events`（持久日志）；`ctx.get('sessionPersistence')`（durable store，reconcile 用）。与 kingdom 现有一致：**结构型局部类型**（dsh-subagent.ts 模式），不新增 peer dep。

| Contract | DSH 实现（已核实 seam） |
|---|---|
| `identify` | 常量 `'dsh'` + 宿主实例 id（如进程/主机标识；adapter 装配时固化） |
| `createSession` | `AgentRegistry.create({ sessionId: uuid, meta: { cwd, agentPreset? }, agentOptions: {provider, model}, setup })`（agent/src/index.ts:405）。**setup 是 per-execution capability 装配点**（§23/S4）：`agentPresets.mount(agentCtx, id)`（agent-presets/src/index.ts:275）+ guard/restrict + sandbox/approval 政策（C-005/C-018） |
| `resumeSession` | `AgentRegistry.resume({ resumeSessionId: sessionRef, agentOptions, setup })`（agent/src/index.ts:424）——**同一 session_ref 恢复同一长期会话**，REWORK 唤醒同一 Worker |
| `observeSession` | `agent.status`（'idle'/'running'，agent.ts:99）+ phase kind（maintenance）；`ctx.agents.get(sessionRef)` 是否存在（GONE 判定）；`session.events` 持久日志（turn/start、turn/end、assistant/message、tool/result、sandbox/mode、approval/policy） |
| `retireSession` | `AgentHandle.dispose()`（停 loop、注销、删 session、unwind scope） |
| `capabilities` | context-bound 动态集合：按 `(session, agentPreset, sandboxMode, approvalPolicy, guard 集合)` 收敛；静态声明仅 `Adapter Capability Declaration`，**不参与安全公式**（Stage 3 冻结） |
| `preflight` | 纯读：核对 enforcementRequest ∩ 当前 session/preset/guard/sandbox/approval 可 enforce；**零 mutation** |
| `materialize` | ① `setSandboxMode(session, mode)`（sandbox-policy/session-mode.ts:69，每切换一条 sandbox/mode 事件）② `setApprovalPolicy(session,'never')`（user-approval/src/index.ts:142）③ scope 内 `tools.guard/restrict`（tools/src，C-009 单调拒绝）④ preset 重挂载 → 产出 `DshEnforcementEvidence`（typed envelope）。**任一步失败 → DENIED + zero execution + cleanup**（fail-before-dispatch） |
| `cleanup` | 还原/拆除 enforcement：unwind scope / dispose、验证 teardown 事件（sandbox/mode、approval/policy）；不确定 → 保留 evidence，Lease 进 RECOVERING |
| `dispatch` | `agent.followup(完整 UserMessage)`（agent.ts:122）→ inbox 持久 splice 插入即视为「已接受」；`runtime_dispatch_ref` = **UserMessage.id**（PoC F1 实证 messageId），`acceptedAt` 记录时刻。**禁止裸 text block**（C-007 负知识） |
| `observeExecution` | 事件链重建：`turn/start → turn/end → assistant/message`（C-006/C-010）；`agent.whenIdle()`（agent.ts:195）仅同步辅助，非权威 terminal |
| `reconcile` | 两维独立：executionObservation 来自 session 事件链（turn 边界/terminal 证据）；sessionObservation 来自 `ctx.agents.get(sessionRef)`（live）+ `sessionPersistence`（持久可恢复 → AVAILABLE / 已删 → GONE / 均不可判定 → UNKNOWN） |

## 3. Persistent Worker 生命周期（§20，E2E 目标）

```text
Worker 无 current Session：
  adapter.createSession(cwd=territory.workspace_path)
  → session_ref 落库 + establishAffinity（governed API）
  → role_binding current projection 更新（v3 模型：一 Worker 一 current Session）

Worker 已有 Session：
  adapter.resumeSession(同一 session_ref)   ← REWORK 唤醒同一 Worker

跨 Territory：禁止 UPDATE affinity → retire 旧 Session（留历史证据）→ create 新 Session → 新 affinity
```

## 4. E2E 验收（S3 完成标准）

1. create → affinity → resume 同 session_ref（身份不变）；
2. REWORK 再次 dispatch 到**同一** session；
3. 同一 session 第二个 active Lease 被 DB 拒绝（G10 基础）；
4. dispatch 后事件链可重建 `turn/start → turn/end → assistant/message`；
5. Runtime terminal ≠ Task DONE（Claim → REVIEW 链保持）；
6. one-shot 路径继续 `LEGACY_COMPAT` 工作（回归）。

## 5. 诚实声明的 Runtime 缺口（S3 施工后如实上报）

- **无同步完成回执**：`followup` 只保证入队；terminal = 事件链重建（v6 已按此设计）；
- **enforcement 装配点 = setup（create/resume 时）+ session-mode 切换（运行时）**：DSH 无「execution 中途换 policy」的原生 API；S4 的 materialize 走这两条路；
- **session.header.cwd 在 create 时由 meta.cwd 固化**，运行中不可改（与「禁止跨界漂移」一致，属特性非缺口）。

## 6. 施工顺序（S2 acceptance 后立即执行）

1. `src/adapter/contract.ts`：RuntimeAdapter 接口 + 泛化类型（零 dsh import）；
2. `src/adapter/dsh-backend.ts`：DSH 实现（结构型依赖 `ctx.agents`/`agentPresets`/sandbox/approval，同 dsh-subagent.ts 的零 peer 模式）；
3. `src/adapter/session-store.ts`：session_ref ↔ worker/territory 的 governed 落库（走 governed.ts 的 establishAffinity）；
4. E2E 测试（临时库 + 真 DSH session，poc-m3s0 风格隔离前缀）；
5. 回归 + 呈报 M3-S3 Implementation Report（§40 S3 格式）。
