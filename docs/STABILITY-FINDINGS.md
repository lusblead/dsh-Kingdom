# dsh web governed execution 稳定性调查结论

**调查日期**：2026-08-19（Asia/Shanghai）

**DSH 基线**：`D:\deepseek-harness @ 00b7102f1d`

**结论状态**：`UNRESOLVED / CURRENTLY NOT REPRODUCIBLE`

**发布判定**：Blocker #2 仍不得关闭；本次没有取得历史退出的原始异常对象或退出码，同时发现一项独立的 Kingdom S3/S5 fail-closed 语义缺口。

## 1. 结论摘要

历史三次真实 worker turn 确实在 step 中途随 Node 进程消失而被截断，但现有证据不足以把退出归因于 Kingdom、`maxTokens=256000`、`reasoningEffort=high`、staging 跨调用生命周期或 Windows 硬崩溃。

本次在同一 PID 42888 上完成了四次真实模型对照，均取得 `assistant/message="OK"` 和 `turn/end {kind:"completed"}`：

| 对照 | worker 创建/驱动方式 | request/header | caller 条件 | 模型耗时 | 结果 |
| --- | --- | --- | --- | ---: | --- |
| A | 同一 staging 调用 create + followup | `deepseek-vision/deepseek-v4-pro`, `maxTokens=4096`, `high` | 新建小上下文 Flash 控制会话 | 2657 ms | 完成，PID 不变 |
| B | 同一 staging 调用 create + followup | 同上，`maxTokens=256000` | 新建小上下文 Flash 控制会话 | 2665 ms | 完成，PID 不变 |
| C | 同一 staging 调用 create + followup | 同上，`maxTokens=256000` | 原超长工作会话调用 staging | 1248 ms | 完成，PID 不变 |
| D | 第一次 staging 调用只 create；后续调用经 `agents.get()` followup | 同上，`maxTokens=256000` | 原超长工作会话调用 staging | 1295 ms | 完成，PID 不变 |

因此：

- `maxTokens=256000` **不是充分条件**；4096 可作为保守 profile，但本次证据不支持把它称为已证实修复。
- “真实 worker turn 必然重启”已被本次四次成功反例否定。
- staging execute 返回后 worker 被自动 dispose 的候选已由源码和跨调用实测共同排除。
- 历史故障更符合一个当时存在、当前已消失的 runtime/plugin/model 请求异常；若它形成未处理 Promise rejection，DSH 的 fail-loud 处理会明确 `exit(1)`。由于历史 stderr 被下一次启动覆盖，这仍是**最强候选而非已证实根因**。
- requested model 已由持久 `request/header` 证明；没有独立的服务端路由证据，effective model 保持 `UNKNOWN`。

## 2. 已确认事实

### 2.1 “interrupted”是崩溃恢复标记，不是 live cancel

DSH live cancel/dispose 在 `packages/core/agent-loop/src/agent.ts:303-304` 写入 `turn/end {kind:"aborted", reason:...}`。`packages/core/session/src/repair.ts:27-131` 只在重载一个 crash-orphaned 开放 turn 时合成 `turn/end {kind:"interrupted"}`；持久化后端也有对应 crash recovery 测试。

所以历史事件链：

```text
user/message -> turn/start -> step/start -> step/end
-- 持久日志在此截断 --
重载后合成 turn/end { kind: "interrupted" }
```

证明的是“进程/运行时在正常 turn/end 落盘前消失”，不能反推 `agent.cancel()`。

### 2.2 当前没有已证实的自动重启看门狗

`DSH-Web` 计划任务的 action 是：

```text
cmd /c cd /d D:\deepseek-harness &&
node --import tsx/esm apps/cli/src/bin.ts web > dsh-web.log 2> dsh-web.err.log
```

任务 XML 没有 `RestartOnFailure`，`MultipleInstancesPolicy=IgnoreNew`。Task Scheduler Operational 日志处于禁用状态，不能倒查历史退出码或启动方。

因此历史现象应准确描述为：**Node 先退出；随后有另一个调用重新运行了 DSH-Web 任务**。谁触发后半段仍为 `UNKNOWN`，不能写成“Scheduler 自动守护重启”。

### 2.3 历史致命 stderr 不可恢复

计划任务使用 `>` 和 `2>`，每次启动会覆盖上一进程日志。当前 stderr 只有 PID 42888 的 SQLite experimental warning。

DSH `packages/boot/app-boot/src/index.ts:609-648` 对任何未被接住的 `unhandledRejection` 写：

```text
dsh: fatal load failure: <stack>
```

然后 `process.exit(1)`。所以 Windows 没有 Application Error 1000/1001 只排除了硬崩溃，不能排除这条显式退出路径。

### 2.4 参数来源

- `packages/llm/llm-deepseek/src/adapter.ts:93` 定义默认 `maxTokens=256000`。
- `AgentOptions` 在 `packages/core/agent/src/runtime-types.ts:24-30` 只公开 `provider`、`model`、`maxTokens`。
- `reasoningEffort` 不属于 `AgentOptions`；要覆盖它必须走 agent-scoped `agent/request` / model-selection setup。
- 因此历史 worker 的 256000/high 不是 Kingdom 从根 Agent 复制的事实；256000 是 DeepSeek adapter 默认值，high 来自请求选择层。

### 2.5 staging 生命周期

注入器 `dev_stage_call` 只是 `await t.execute(..., ctx)` 并捕获错误，没有调用级 timeout 或 disposer。`AgentRegistry.create()` 的 lifecycle effect 由调用方所属的注入器 plugin fiber 持有。

本次对照 D 进一步证明：第一次 staging execute 返回后，后续 execute 仍能通过 `agents.get(sessionId)` 找到同一个 idle worker，并成功驱动真实 turn。跨调用保留前提成立。

### 2.6 title 与 vision wrapper 的静态错误边界

- session-title 的 detached work 在 `packages/session/session-title/src/index.ts:519-535` 捕获 provider 失败并记 warning；`defer/track` 还为被丢弃的 Promise 注册 rejection handler（约 683-701）。没有发现 title 请求错误直接形成 unhandled rejection 的路径。
- `dsh-vision-router@1.6.2` 的 text wrapper 在已安装 `index.js:2547-2657` 主要是 `yield* ctx.llm.stream(...)`；错误会传播给 agent-loop，而 agent-loop driver 在 `packages/core/agent-loop/src/agent.ts:210-220` 有 containment。没有发现 wrapper 主请求路径中的显式进程退出。

## 3. 已排除与未排除

### 已排除

- Kingdom 源码主动 `process.exit/kill`。
- Windows Application Error 意义上的硬崩溃（限已有 Event Log 证据）。
- 极简 prompt 本身过于复杂。
- `maxTokens=256000` 单独作为充分触发条件。
- 原长上下文 caller + 256000/high Pro worker 作为当前必现组合。
- staging 调用返回即 dispose worker。
- session-title 普通 provider failure 未被接住（按当前源码）。

### 仍未排除（按优先级）

1. **历史瞬时 unhandled rejection**：来自 DSH/plugin/LLM transport 的某个当时失败分支，并由 `installFailLoud()` 触发 `exit(1)`。缺少被覆盖的 stderr，无法确认异常类型和栈。
2. **外部重新启动方**：Node 退出后的再次 `schtasks /Run` 调用者未知；Operational 日志禁用使历史归因断链。
3. **模型服务/路由瞬时状态**：07:47-08:03 的连续失败与 16:26-16:37 的连续成功属于不同时段；effective model 与服务端处理节点均无法独立证明。
4. **完整 governed E2E 特有交互**：本次探针覆盖真实 `AgentRegistry.create/followup`、跨调用持久 worker 和原 caller，但没有重跑 gate/lease/receipt 的完整 TEMP DB 编排。此前无模型的 governed 步骤稳定，因此优先级低于 runtime 未处理 rejection。

## 4. Kingdom 相关发现

### 4.1 S3 参数面：暂不把 4096 固化为“修复”

`src/adapter/dsh-backend.ts:71-76,178-180` 的内部 Agent 接口与 `agentOptions()` 只传 provider/model，尚不能设置 `maxTokens`。若 Owner 要求防御性执行 profile，最小改动应在 **S3 Adapter/session execution profile** 增加有界的 worker `maxTokens`，而不是在 S4/S5 猜测模型参数。

但本次 256000 对照也成功；在没有上游异常栈或更大样本前，4096 只能标为风险缓解选项，不能作为根因修复，也不能据此关闭 Blocker #2。

### 4.2 S3/S5 存在独立的 terminal 误判缺口

这项与进程退出原因无关，但会把历史 crash recovery 证据错误升级为成功：

- S3 `src/adapter/dsh-backend.ts` 的 `reconstructExecutionObservation()` 看到任意匹配 `turn/end` 就返回 `TERMINAL`。
- S5 `src/dispatch/evidence.ts:77-84` 同样把任意 `turn/end` 判为 `TERMINAL`，即使没有 `assistant/message`，只写“证据强度降级”。
- `src/dispatch/service.ts:123-127` 随后无条件把该 `TERMINAL` 记录成 execution `COMPLETED`。

DSH 的合法 turn reason 至少包括 `completed`、`aborted`、`blocked`、`error`、`max-tokens`、`interrupted`。恢复合成的 `interrupted` 绝不能产生 `COMPLETED`。

建议的最小 fail-closed 修复条件：

```text
只有同一归属 turn 同时满足：
1. turn/end.reason.kind == "completed"
2. 存在该 turn 的 assistant/message
才允许返回成功 TERMINAL 并写 execution COMPLETED。

interrupted / aborted / blocked / error / max-tokens / 缺 assistant
不得进入 TERMINAL_OK；在现有状态集合下先返回 UNKNOWN/RECOVERING，
或先扩展带 outcome 的终态模型后再映射 FAILED/ABORTED。
```

S3 粗观测和 S5 细证据必须同步修正并加回归测试，避免 reconcile 的两条入口语义分叉。

## 5. 后续取证与规避

### 5.1 在下一次复现前修复日志保全（需要 DSH Owner 授权）

不得再用覆盖重定向。建议 wrapper 为每个 PID/启动时间生成独立 stdout/stderr 文件，或追加并在每次启动写 PID marker；同时启用 Task Scheduler Operational 日志。只有这样才能把：

```text
worker session -> request/header -> stderr stack -> node exit code
-> task start event / 启动调用者 -> new PID
```

串成一条可验证证据链。

### 5.2 当前保守运行建议

- worker 可显式使用 `maxTokens=4096` 作为成本/资源上限，但标注为 mitigation，不声称已修复。
- 暂不伪造 `agentOptions.reasoningEffort='low'`；如需下一组实验，使用 agent-scoped `agent/request` setup。
- 每次真实 probe 保存 session id、message id、request/header、原始 turn reason、assistant 是否存在、PID 与 stderr；effective model 仍单独保持 `UNKNOWN`。
- 在 S3/S5 terminal 误判修复前，任何 `interrupted` 或“无 assistant 的 turn/end”均不得 settle/release 为成功。

## 6. 本次边界与清理

- 未读取、迁移或写入正式 Kingdom 数据库；正式库保持 v3 边界。
- 未修改 DSH 上游；未 commit/tag/push/publish。
- 仅创建了隔离 TEMP cwd 下的 DSH 测试 session 与一个控制 session。
- 本次新增的三个 staging 诊断工具已逐项 `dev_stage_demote` 移除；交接已有工具未改动。
- 诊断 worker 均已 idle；由于 staging create 调用没有保留 `AgentHandle`，未伪造 dispose。它们会由所属 plugin fiber/实例生命周期清理，持久事件保留作本次证据。

## 7. 最终判定

**根因尚未闭合。** 当前可验证结论是：历史进程退出确实截断了 turn；自动 Scheduler 重启、Kingdom 直接退出、固定 256K 参数、staging 自动 dispose 均不是已成立解释。本次四次相同核心路径成功，使问题从“当前 100% 必现”降级为“历史高频、当前不可复现的 runtime/integration 故障”。

Blocker #2 仍应保持 `UNRESOLVED`，直到至少取得一次未被覆盖的 fatal stderr/exit code，或在带持久日志的环境中达到 Owner 认可的稳定样本。同时，S3/S5 的 `interrupted -> TERMINAL -> COMPLETED` 语义缺口是可独立验证的 Kingdom blocker，应先以 fail-closed 回归测试修复。
