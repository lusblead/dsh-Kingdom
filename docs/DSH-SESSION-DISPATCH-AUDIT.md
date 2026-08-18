# DSH Independent Session Dispatch Audit（M3 架构纠正后）

> 目的：回答 Owner 裁决的四个问题——"Worker = 独立 DSH Session"是否可行、缺口在哪。
> 方法：只读源码调查（D:\deepseek-harness）。结论决定 Kingdom 下一阶段真正需要向上游要什么。
> 日期：2026-08-18。状态：**审计完成，四个问题有源码级答案。**

## 0. 结论先行

| # | 问题 | 答案 | 依据 |
|---|---|---|---|
| 1 | 已存在的 DSH Session 能否从另一 Session/插件接收新任务？ | ✅ **架构上能**——`AgentRegistry.resume({resumeSessionId})` → AgentHandle → `Agent.followup()`（durable inbox 注入 + wake） | agent/index.ts:139-213、agent-loop/agent.ts:113-133 |
| 2 | 能否不创建 subagent 触发新 turn？ | ✅ **能**——`Agent.followup()/send(message,'next-turn',wakeup=true)` 在现有 Agent 上排队并唤醒新 turn | agent-loop/agent.ts:113-132；subagent continuation 同机制先例 |
| 3 | 插件能否取得/证明 Session 真实 Agent identity 与 execution result？ | 🔶 **部分能**——identity 有（工具面 `exec.agent.session.id` + resume 时显式指定 session）；result 无公开"turn 完成回调"，需 Kingdom 观察持久 log（L3B TERMINAL_OBSERVED 同款路径） | agent/index.ts:139-141；session 持久事件（turn/start、assistant、tool/result） |
| 4 | 能否对 Session 的**一次执行**临时施加 tool/sandbox policy？ | 🔶 **部分能、缺口明确**——sandbox/mode 是 session 级持久事件（可切换但**无 per-execution 收窄+自动恢复**）；tools 限制只有 child 创建窗口（subagent toolFilter 先例），**对活 Agent 的 per-execution 限制无公开 seam** | sandbox-policy/session-mode.ts；tools scope-filtered dispatch（tools/index.ts:148-185）；subagent types.ts toolFilter |

**总判断**：Worker = 独立 DSH Session 的方向**上游架构支持**（Q1/Q2 已具备）；
真正的缺口集中在 **Q4（per-execution 能力收窄）** 与 **Q3 的后半（执行终态/身份证据的公开回执）**。

## 1. Q1/Q2 证据链（Session 派发机制）

```text
agent-loop 插件：creates scoped ReactLoopAgents, publishes them through the
agent/session registries, owns ordered teardown（agent-loop/index.ts:1-3）
        ↓
AgentRegistry.resume(ownerCtx, { resumeSessionId }) → AgentHandle
        （agent/index.ts:139-213——按持久化会话恢复 Agent）
        ↓
ReactLoopAgent.followup(input) → send(input, 'next-turn', wakeup=true)
        → inbox.splice（durable `agent/inbox/spliced` 事件，先落盘后投影）
        → wakeDriver（agent-loop/agent.ts:113-133）
        ↓
Inbox 从 session 持久 splice 事件 replay 重建（agent-loop/agent.ts:87-91 + inbox.ts:32-39）
        ——排队工作跨进程重启可恢复
```

**先例**：subagent 的 continuation manager 就是"外部向活 Agent inbox 注入 followup 并 wake"
（subagent/continuation.ts:11 "The Agent inbox is the only turn queue, so this manager owns…"、
:228 "Accepted waking message ids this manager has not yet seen leave the inbox"）。

**对 Kingdom 的含义**：`Worker Binding.session_id → AgentRegistry.resume → followup(Task prompt)`
是**官方支持的架构路径**，不是 hack。

## 2. Q3 证据链（身份与结果证明）

| 面 | 现状 | 证据 |
|---|---|---|
| 身份（派发时） | resume 时**显式指定** resumeSessionId——Worker 是谁由 Kingdom 决定并可在派发参数中固化 | agent/index.ts:139-141 |
| 身份（执行时） | 工具面 `exec.agent.session.id` 是 DSH Runtime 证明的（M1-A 已审计） | 已有 |
| 结果（结构化） | 无公开"turn 完成"回调；turn/start、assistant、tool/result 均在 session 持久 log——Kingdom 可用 L3B TERMINAL_OBSERVED 同款"观察持久终态"路径，但需自扫 | session 持久事件 |
| 结果（归属证明） | "本次结果确实由 S-A 的 Agent 产出"——经 resume 的 Agent 其 session 即 S-A，log 归属自然成立；需上游给公开回执才最稳 | — |

## 3. Q4 证据链（per-execution 能力收窄）

```text
sandbox/mode：session 级持久事件（log-only、durable、replayable）
  ✅ 可切换（Owner/测试场景运行时切）
  ✅ delegation 播种已有（source:'delegation'）
  ✕ 无 per-execution「任务开始收窄 → 任务结束自动恢复」seam
    （Kingdom 自己切两次 = 有竞态窗口，不满足 fail-closed）

tools 限制：scope-filtered dispatch（agent-scoped listeners 只见自己 agent 的调用）
  ✅ ReactLoopAgent 有 scope（createScope(loopCtx, this)）
  ✅ subagent child 创建窗口有 tools.restrict() 先例
  ✕ 对已 resume 的活 Agent 施加 per-execution 限制无公开 seam
```

## 4. 修订后的 DSH Upstream Gap Contract（替代 per-child 提案）

```text
1. Per-execution scoped policy（最高优先）：
   对已 resume 的 Agent，一次"任务执行"期间收窄 tool set / sandbox mode，
   执行结束后自动恢复——公开 apply/release seam + 生效证据回执
2. Task 执行归属回执：
   插件可取得「本次执行由 Session X 的 Agent 完成」的可信证据
   （turn 终态 + agent identity 绑定，不靠自扫持久 log）
3. 结构化执行终态观察点：
   turn 完成的公开通知/投影（替代 Kingdom 自扫 session log）
```

> 与之前 per-child 四条的差异：**不再要求 per-child sandbox override**（Worker 不是 child 了）；
> 改为对**已存在 Agent** 的 per-execution policy。第 1 条是 M3 Runtime Enforcement 的真正前置。

## 5. 对 M3 / M2 / M1-C 设计的影响（裁决落实）

1. **M3-D 保持 BLOCKED**——但 blocked 对象更新：从"per-child sandbox seam"改为
   "per-execution scoped policy on live Agent"（本报告 §4 第 1 条）。
2. **M3-C ToolPermissionAdapter** 重定位：面向 **Agent scope（resume 的 Worker Session）**，
   不再面向 subagent child；两阶段契约（preflight/materialize）保留但对象改变。
3. **M1-C 重解释（Owner 裁决）**：v0.6 的 ExecutionProfile/ExecutorFactory/one-shot =
   **过渡 backend**；目标模型 = `Binding.session_id → AgentRegistry.resume → followup(Task) →
   Session 自己执行 → Claim`。ExecutionProfile 重定位为"Worker 席位的 Session provisioning
   profile"（校验 S-A 实际 model 是否符合 profile），不再承担"每次创建 child 用哪个 provider"。
4. **v0.7 兼容**：subagent 执行链保留为过渡 backend（升级兼容规则同 M3 §7 的
   LEGACY_UNMANAGED 思路——目标 seam 落地后再迁移）。

## 6. 下一步建议

- 按 Owner 裁决：**M3 child-based Gap Proposal 停止**；
- M3 设计稿 v3 的修订方向 = 本报告 §4/§5（Worker Session dispatch 版）；
- 是否先向 DSH 上游提 §4 三条（或并入选定的 Discussion）——等你指令。
