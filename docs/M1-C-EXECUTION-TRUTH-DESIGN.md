# M1-C Execution Truth — 设计稿（v0.6.0）

> 状态：**设计冻结草案**——按用户流程要求，本稿完成并经用户裁决后才动数据库/代码。
> 范围：ExecutionProfile + ExecutorFactory + Schema 设计。不引入 Multi-Worker、不引入长期 Worker Session。

---

## 1. 目标（要证明的命题）

```text
Task.assigned_binding_id
        ↓
Worker Binding
        ↓
ExecutionProfile
        ↓
ExecutorFactory
        ↓
实际 Runtime / Provider / Model
        ↓
one-shot Execution
```

同时保持严格分离：

```text
Supervisor Session ──→ delegation parent（血缘/工作区/委派深度）
Worker Binding    ──→ execution identity/profile（执行能力）
两者互不混用
```

## 2. 施工边界（用户裁决冻结）

1. **ExecutionProfile 是独立领域概念**：表达 `provider/model/options`；`session_id` 只负责治理身份认证，不是执行配置。
2. **ExecutorFactory 是唯一执行解析入口**：`startTask` 不理解 DSH provider/model；Core 仍只依赖 `WorkerExecutor` 接口。
3. **优先 Binding profile，缺省回退全局 `workerProvider`**，回退必须产生 `runtime_source=global-fallback` 证据。
4. **每 attempt = 全新 one-shot execution**；无长期 Worker Session；无 Multi-Worker。
5. **Execution 保存真实执行证据**：可事后回答"哪个 Worker / 哪个 provider / 哪个 runtime / 哪个 model / 哪个 session/run 执行了第几次 attempt"——结构化落库，不只写事件文本。
6. **Binding 自报不成为假事实**：落库的 `requested_model` 与 `observed_model` 分开；DSH 无法证明实际模型时明确记录 requested/observed 差异。
7. **M1-D 是 v0.6.0 硬 Release Gate**：4+1 Session 对抗矩阵 + 至少两个不同 ExecutionProfile 的运行归属实验全 PASS 才发布。

## 3. DSH seam 事实核查（决定设计的硬约束）

| 事实 | 出处 | 设计含义 |
|---|---|---|
| `SubagentStartRequest.agentOptions?: AgentOptions`，`continuation.ts:414` 取 `agentOptions?.model ?? parent.options.model` | dsh-subagent types.ts:119 / continuation.ts | **requested model 可传递**（agentOptions.model），缺省继承 Supervisor |
| 子 agent 的 provider/model 默认继承 parent（`child-agent.ts:60-78`） | dsh-subagent | 未指定时"实际执行者=Supervisor 的运行时"——这正是 M1-C 要消除的隐式行为 |
| `SubagentResult` 只有 output/structured/stopReason（types.ts:219-238） | dsh-subagent | **run 结果不含 model** → observed 不能从 result 拿 |
| in-process run 的 `SubagentRun.localAgent: Agent | undefined`，其 `options.model` 是解析后模型（含继承） | types.ts:261 | **observed_model 来源**：in-process（spawn/fork）可读 `run.localAgent.options.model`；remote provider 时 undefined → 诚实记 null |
| `descriptor.agentModel`（child 日志持久化） | descriptor.ts:77/112 | 未来审计可查（插件不直接读，留给 DSH 面） |

## 4. Domain 模型

### 4.1 ExecutionProfile（Binding 上的执行配置，独立领域概念）

```ts
/** Worker Binding 的执行配置（v1 简化：结构化 JSON 挂 Binding，不做 Profile registry）。 */
export interface ExecutionProfile {
  /** subagent provider 名（dsh base 默认 spawn/fork）。缺省 → 回退全局 workerProvider。 */
  provider?: string
  /** requested model（传给子 agent 的 agentOptions.model）。缺省 → 继承父 Agent（Supervisor）。 */
  model?: string
  /** 扩展槽（v1 预留：maxTokens 等 AgentOptions 子集；DSH 不支持的能力由 Factory 拒绝并 fail 明确）。 */
  options?: Record<string, unknown>
}
```

- **不混用**：`session_id` = 治理身份；`model_name/agent_name/session_meta`（v0.4 预留字段）= 席位身份展示元数据；**执行配置只读 `execution_profile`**。
- v1 不建独立 `execution_profiles` 表（用户倾向）；Multi-Worker 阶段再决定是否抽共享 Profile registry。

### 4.2 ResolvedExecution（ExecutorFactory 的解析结果 + Execution 的不可变快照）

```ts
export interface ResolvedExecution {
  /** 最终 provider（binding profile 优先，否则全局 workerProvider）。 */
  provider: string
  /** 证据来源：'binding' | 'global-fallback'。 */
  runtimeSource: 'binding' | 'global-fallback'
  /** requested model：profile.model ?? null（null=继承父 Agent，DSH 语义）。 */
  requestedModel: string | null
}
```

## 5. Schema 设计（v1，幂等迁移，零破坏）

沿用 `ensureSessionProfileColumns` 的幂等模式（`PRAGMA table_info` gate + `ALTER TABLE ADD COLUMN`，SCHEMA_VERSION 保持 1）。

### 5.1 `role_bindings` 加 1 列

| 列 | 类型 | 语义 |
|---|---|---|
| `execution_profile_json` | TEXT NULL | ExecutionProfile 的 JSON（v1 简化；不合法 JSON 视为未配置，不猜） |

### 5.2 `executions` 加 4 列（不可变执行证据快照，创建时写入、结算不改写）

| 列 | 类型 | 语义 | 回答的问题 |
|---|---|---|---|
| `runtime_source` | TEXT NULL | `binding` / `global-fallback` | 配置来自哪 |
| `provider` | TEXT NULL | 最终 subagent provider 名 | 用什么执行方式 |
| `requested_model` | TEXT NULL | profile.model ?? null（null=继承 parent） | 请求了什么模型 |
| `observed_model` | TEXT NULL | in-process run 的 `localAgent.options.model`；不可得时 null（诚实标注，非"无模型"） | 实际观察到的模型 |

> 选 4 列而非单 JSON 列：事后可 SQL 直查（"哪些任务用了 fallback"、"哪个 model 跑了哪些 attempt"），且列本身就是不可变快照（`transitionExecution` 不触碰这几列）。

### 5.3 既有字段已覆盖的证据

`executions.worker_binding_id`（哪个 Worker）、`attempt_no`（第几次）、`session_id`（哪个实际 run/session）、`task_id`——加上 5.2 的 4 列，边界 5 完整可答。

## 6. ExecutorFactory（唯一执行解析入口）

新模块 `src/worker/executor-factory.ts`：

```ts
/** 唯一执行解析入口：Binding + 全局配置 → ResolvedExecution + WorkerExecutor。 */
export function resolveWorkerExecution(
  store: KingdomStore,
  ctx: { kingdomId: string },
  task: TaskRow,                       // 读 task.assigned_binding_id
  runtime: {
    subagents: SubagentsLike
    globalProvider: string             // config.workerProvider
    parent: unknown                    // exec.agent（delegation parent，永远来自 Supervisor 调用者）
    signal: AbortSignal
  },
): { resolution: ResolvedExecution; executor: WorkerExecutor } | { error: string }
```

解析顺序（确定性）：

```text
1. task.assigned_binding_id → binding（缺失/非 WORKER → 明确错误 WORKER_BINDING_INVALID）
2. binding.execution_profile_json 解析
   ├─ provider 合法（subagents.getProvider 存在）→ runtimeSource='binding'
   ├─ provider 缺失/非法 → 全局 workerProvider（存在则 runtimeSource='global-fallback'；不存在 → 明确错误）
3. requestedModel = profile.model ?? null（无验证通道——DSH 无 model 白名单，agentOptions.model 由 DSH 内部校验）
4. new DshSubagentExecutor({ subagents, provider, model: requestedModel, parent, signal })
   executor.info = { provider, runtimeSource, requestedModel }   // WorkerExecutor.info
```

**Core 不动**：`startTask(store, executor, ctx, input)` 仍只依赖 `WorkerExecutor` 接口；执行证据经 `executor.info`（新可选只读字段）落库——信息随执行器携带，Core 不自己解析 provider/model（边界 2）。

**DshSubagentExecutor 扩展**（`src/worker/dsh-subagent.ts`）：
- options 加 `model?: string` → `subagents.start(provider, { ..., agentOptions: model ? { model } : undefined })`；
- 结算后提取 `observedModel = run.localAgent?.options?.model ?? null`，并入 `WorkerExecutionOutcome`（新可选字段 `observedModel`）；
- `kind` 保持 `dsh-subagent:<provider>`（兼容既有事件/展示）。

## 7. 数据流（startTask 改造点）

```text
kingdom_start_task（工具边界，SUPERVISOR 会话）
  ├─ sessionPrincipal(exec) → requireRole(SUPERVISOR)      [不变]
  └─ resolveWorkerExecution(store, ctx, task, {subagents, globalProvider, parent: exec.agent, signal})
       ├─ 失败 → 明确错误（不启动 Execution）
       └─ 成功 → startTask(store, executor, ctx, {taskId})
            ├─ insertExecution(..., runtime_source, provider, requested_model,
            │                    observed_model: null, worker_binding_id, session_id: null)
            ├─ SESSION_STARTED / WORKER_EXECUTION_STARTED 事件 payload 增补
            │     provider / runtime_source / requested_model
            ├─ executor.execute(task, context) → outcome（含 observedModel）
            └─ settleExecution 落 worker_results + transitionExecution(COMPLETED/FAILED)
                 + 结算事件 payload 增补 observed_model
```

## 8. 事件与审计

| 事件 | payload 增补 |
|---|---|
| `SESSION_STARTED` / `WORKER_EXECUTION_STARTED` | `provider`、`runtime_source`、`requested_model` |
| 结算事件（RESULT_CLAIMED / WORKER_EXECUTION_FAILED 等） | `observed_model`（可空，注明 seam 限制） |

事件是审计面（完整 id 等照旧）；**结构化证据以 executions 列为准**（边界 5：不只写事件文本）。

## 9. requested vs observed 语义（边界 6）

| 字段 | 值 | 语义 |
|---|---|---|
| `requested_model` | profile.model / null | 请求了什么（null = 继承父 Agent/Supervisor，DSH 语义） |
| `observed_model` | `run.localAgent?.options?.model ?? null` | in-process 实际解析到的模型；`null` = seam 未暴露（remote/不可观察），**不是"无模型"** |

文档与 GUI 不把 `observed_model=null` 渲染成"没有模型"；README 明确：DSH 子 agent 的模型解析在宿主内部（descriptor.agentModel），插件记录 requested 与可观察的 observed 之差，不臆造事实。

## 10. 兼容性与迁移

- 两个幂等 `ADD COLUMN`（`ensureExecutionProfileColumns`），旧库开库即收敛，SCHEMA_VERSION 保持 1（非破坏性迁移，沿用零迁移哲学）。
- 未配置 execution_profile 的既有绑定：自动走 `global-fallback`（行为与 v0.5.x 完全一致，但从此有证据）。
- `binding.model_name`（v0.4 席位元数据）**不**升级为执行配置——避免"自报变事实"（边界 6）；README 明确两者分工。
- GUI：角色绑定面板可选增加 execution_profile 编辑（v0.6.0 范围）；BindingView 只读展示 `runtimeSource` 派生信息（不暴露内部配置细节）。

## 11. 测试计划

1. **单元（node --test，:memory:）**：
   - resolveWorkerExecution：binding profile 优先 / fallback 证据 / provider 非法拒绝 / assigned_binding 缺失拒绝；
   - insertExecution 快照列写入且 transitionExecution 不改写；
   - DshSubagentExecutor：agentOptions.model 传递（fake subagents 捕获请求）、observedModel 提取（fake run.localAgent）。
2. **集成（真实王国冒烟，备份含 WAL）**：配置两个 Worker profile（A: spawn+model-A、B: fork+model-B）→ 各自执行 → executions 行与事件证据核对。
3. **M1-D（v0.6.0 Release Gate，硬性）**：4+1 Session 对抗矩阵（S0-S3+SX，19 行用户矩阵）全 PASS + 运行归属实验（Worker A/B 不同 profile，runtime evidence 证明 executions.provider/requested_model/runtime_source 与绑定一致，且 observed_model 记录诚实）。

## 12. 待用户裁决点

1. **executions 用 4 个独立列**（推荐，可 SQL 直查）还是单 `execution_profile_json` 快照列？
2. **observed_model 来源**用 in-process `run.localAgent.options.model`（诚实、仅 in-process 可得；remote 记 null）——是否接受该 seam 边界？
3. **binding.model_name 保持"席位元数据"**（执行配置只看 execution_profile，避免自报变事实）——确认该分工？
4. 迁移方式沿用幂等 ADD COLUMN（SCHEMA_VERSION 保持 1）——确认？

裁决通过后：实现 → 测试 → M1-D E2E → v0.6.0 发布（release.ps1 + 知识同步）。
