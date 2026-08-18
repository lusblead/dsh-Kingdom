# M1-C Execution Truth — 设计稿 v2（冻结版）

> 状态：**已冻结**（用户裁决 2026-08-18：②③通过、①通过但扩展、④否决原方案；追加 ExecutionProfile 治理约束与 options 收紧）。本稿即实现依据，无需二次确认。
> 范围：ExecutionProfile + ExecutorFactory + Schema v2。不引入 Multi-Worker、不引入长期 Worker Session。

---

## 1. 目标（要证明的命题）

```text
Task.assigned_binding_id → Worker Binding → ExecutionProfile → ExecutorFactory
        → 实际 Runtime / Provider / Model → one-shot Execution
```

严格分离：`Supervisor Session ──→ delegation parent`；`Worker Binding ──→ execution identity/profile`。

## 2. 施工边界（冻结）

1. ExecutionProfile 是独立领域概念：`provider/model`；`session_id` 只管治理身份。
2. ExecutorFactory 是唯一执行解析入口；Core 仍只依赖 `WorkerExecutor`。
3. 优先 Binding profile；缺省回退全局 `workerProvider`，回退产生 `provider_source=global-fallback` 证据。
4. 每 attempt = 全新 one-shot execution；无长期 Worker Session；无 Multi-Worker。
5. Execution 保存真实执行证据（结构化列 + 不可变快照 JSON），不只写事件文本。
6. **requested ≠ resolved 分开**：`requested_model`（请求）→ `resolved_model`（DSH Runtime 解析结果）；远程 seam 不可见时 `null`（= 无证据，不是无模型）。未来 transport telemetry 才引入 `observed_model`（Provider/API 实际观测）。
7. M1-D 是 v0.6.0 硬 Release Gate（4+1 Session 矩阵 + E1/E2/E3 运行归属实验全 PASS）。
8. **ExecutionProfile 修改必须走 Trusted Admin Plane**：`kingdom_set_execution_profile`（独立工具，不塞进 bind_session），session-bound 下仅真实 OWNER；Chancellor/Supervisor/Worker/Stranger ❌。
9. **v1 冻结 `ExecutionProfileV1 { provider?: string; model?: string }`**：无 `options` 透传（未来 reasoning/temperature/tool policy 等逐项进 schema，严格 allowlist）。
10. **硬不变量：ExecutorFactory MUST NOT read `binding.model_name`**——`model_name` 只做席位/展示元数据，执行配置只读 `execution_profile`；用测试锁定（model_name=Model-A + profile.model=Model-B → requested 必须 Model-B）。

## 3. DSH seam 事实（不变，见 v1 稿）

- `agentOptions.model` 可传递 requested model（缺省继承 Supervisor）；`SubagentResult` 不含 model；in-process `run.localAgent.options.model` = DSH 解析后的有效模型 → **resolved_model**；remote 时 null。

## 4. Domain 模型

### 4.1 ExecutionProfileV1（冻结）

```ts
/** v1：只表达执行能力的两维（provider/model）。无 options 透传。 */
export interface ExecutionProfileV1 {
  provider?: string   // subagent provider 名（spawn/fork）；缺省 → 全局 workerProvider（fallback 证据）
  model?: string      // requested model（agentOptions.model）；缺省 → 继承父 Agent（parent-inherited 证据）
}
```

- **治理**：修改 profile 唯一入口 = `setExecutionProfile()`（Domain）/ `kingdom_set_execution_profile`（工具），session-bound 下经 `requireAdmin`（仅 OWNER）；declarative 保持演示现状。
- **不混用**：`session_id`=治理身份；`model_name/agent_name/session_meta`=席位展示元数据（ExecutorFactory 禁止读取，硬不变量）；`execution_profile`=执行配置。

### 4.2 ResolvedExecution（Factory 解析结果 + Execution 证据）

```ts
export type ProviderSource = 'binding' | 'global-fallback'
export type ModelSource = 'binding' | 'parent-inherited' | 'unknown'

export interface ResolvedExecution {
  provider: string
  providerSource: ProviderSource
  requestedModel: string | null      // profile.model ?? null（null=继承 parent）
  modelSource: ModelSource           // requestedModel ? 'binding' : 'parent-inherited'
  // resolvedModel 与完整快照在执行结算时补全（不可变，每节只写一次）
}
```

## 5. Schema v2（冻结）

### 5.1 `role_bindings` 加 1 列

| 列 | 类型 | 语义 |
|---|---|---|
| `execution_profile_json` | TEXT NULL | ExecutionProfileV1 的 JSON；非法 JSON = 未配置（不猜） |

### 5.2 `executions` 加 7 列（核心证据独立列 = 审计事实）+ 快照 JSON

| 列 | 类型 | 语义 | 回答 |
|---|---|---|---|
| `executor_kind` | TEXT NULL | executor.kind（如 `dsh-subagent:spawn`） | 用了哪个 executor |
| `provider` | TEXT NULL | 最终 provider | 用什么执行方式 |
| `provider_source` | TEXT NULL | `binding` / `global-fallback` | provider 来自哪 |
| `requested_model` | TEXT NULL | profile.model ?? null | 请求了什么模型 |
| `resolved_model` | TEXT NULL | DSH 解析后模型（in-process）；null=seam 无证据 | 实际解析成什么 |
| `model_source` | TEXT NULL | `binding` / `parent-inherited` / `unknown` | model 来源 |
| `execution_profile_json` | TEXT NULL | 不可变解析快照（requested/resolved/source 三节） | 未来扩展参数与完整证据 |

快照 JSON 形态（**不是另一个真相源**，关键字段以列为准）：

```json
{
  "requested": { "provider": "spawn", "model": "gpt-5.6" },
  "resolved":  { "provider": "spawn", "model": "gpt-5.6" },
  "source":    { "provider": "binding", "model": "binding" }
}
```

写入规则：start 时写 requested/source 节 + 列；结算时**一次性**补 resolved 节与 `resolved_model` 列（此后不再改写——`transitionExecution` 不触碰证据列）。

### 5.3 Migration：正式 Schema v2（裁决 ④）

- `SCHEMA_VERSION = 2`（`kingdoms.schema_version`）。
- **新库**：建表后直接写 2。
- **旧库 v1→v2**：事务化幂等升级：

```text
BEGIN IMMEDIATE
  PRAGMA table_info gate（缺列才 ADD COLUMN）
  ADD role_bindings.execution_profile_json
  ADD executions.{executor_kind, provider, provider_source,
                  requested_model, resolved_model, model_source,
                  execution_profile_json}
  verify 全部预期列存在（缺失 → 抛错）
  UPDATE kingdoms SET schema_version = 2
COMMIT（失败 ROLLBACK）
```

- 仍保持"增量、安全、不重建"（不推翻零迁移哲学，升级为 **Versioned + transactional + idempotent ADD COLUMN**）；未来 v2→v3 同理。

## 6. ExecutorFactory（唯一执行解析入口）

`src/worker/executor-factory.ts`：

```ts
export function resolveWorkerExecution(
  store, ctx, task, runtime: { subagents, globalProvider, parent, signal },
): { resolution: ResolvedExecution; executor: WorkerExecutor } | { error: string }
```

解析顺序（确定性）：

```text
1. task.assigned_binding_id → binding（缺失/非 WORKER → WORKER_BINDING_INVALID）
2. profile = parse(binding.execution_profile_json)   // 非法 JSON = 空 profile
3. provider = profile.provider ?? globalProvider
   provider_source = profile.provider ? 'binding' : 'global-fallback'
   （provider 未注册 → 明确错误，不启动 Execution）
4. requested_model = profile.model ?? null
   model_source = requested_model ? 'binding' : 'parent-inherited'
   // 硬不变量：绝不读 binding.model_name
5. executor = new DshSubagentExecutor({ subagents, provider,
       model: requested_model, parent, signal })
   executor.info = { provider, providerSource, requestedModel, modelSource }
```

**Core 不动**：`startTask(store, executor, ctx, input)` 仍只依赖 `WorkerExecutor`；证据经 `executor.info`（新只读字段）与 `outcome.resolvedModel` 落库。

**DshSubagentExecutor 扩展**：`model?: string` → `agentOptions: model ? { model } : undefined`；结算后 `resolvedModel = run.localAgent?.options?.model ?? null` 并入 outcome。

## 7. 数据流

```text
kingdom_start_task（SUPERVISOR 会话；requireRole 不变）
  └─ resolveWorkerExecution → startTask
       ├─ insertExecution(证据列 start 态 + 快照 requested/source 节)
       ├─ SESSION_STARTED / WORKER_EXECUTION_STARTED payload += provider/provider_source/requested_model/model_source
       ├─ executor.execute → outcome.resolvedModel
       └─ settleExecution：落 worker_results + 证据列补 resolved_model + 快照 resolved 节
            + 结算事件 payload += resolved_model
```

## 8. 事件与审计

| 事件 | payload 增补 |
|---|---|
| SESSION_STARTED / WORKER_EXECUTION_STARTED | `provider`、`provider_source`、`requested_model`、`model_source` |
| 结算事件（RESULT_CLAIMED / WORKER_EXECUTION_FAILED 等） | `resolved_model`（可空，seam 限制明示） |
| 新事件 `EXECUTION_PROFILE_UPDATED` | actor=OWNER（实际操作者）、target=binding、payload={role_type, provider, model} |

结构化证据以 executions 列为准（边界 5）。

## 9. requested / resolved /（未来 observed）语义

| 字段 | 值 | 语义 |
|---|---|---|
| `requested_model` | profile.model / null | 请求了什么（null=继承父 Agent） |
| `resolved_model` | `run.localAgent?.options?.model ?? null` | **DSH Runtime 解析后的有效模型**；null=seam 无证据（非"无模型"） |
| `observed_model` | （未来） | Provider/API transport 实际观测，DSH 提供 telemetry 后引入 |

GUI 三分类展示：**席位标注模型**（model_name）≠ **执行配置模型**（profile.model）≠ **最近实际解析模型**（resolved_model）——不混淆。

## 10. 兼容性

- 未配置 profile 的绑定：自动 `global-fallback` + `parent-inherited`（行为与 v0.5.x 一致，但从此有证据）——E3。
- `binding.model_name` 永不参与执行解析（硬不变量 + 测试锁定）。
- GUI BindingView：只读展示执行配置（不暴露内部细节）。

## 11. 测试计划

1. **Migration**：v1 旧库打开 → schema_version=2 + 全部预期列存在（事务原子性）。
2. **setExecutionProfile 治理**：session-bound 下 OWNER-only / 其他角色 DENY / declarative 保持；profile 校验（非法 JSON/未知键拒绝）。
3. **resolveWorkerExecution**：E1/E2/E3 三 case（见下）；硬不变量（model_name 不被读取）。
4. **DshSubagentExecutor**：agentOptions.model 传递、resolvedModel 提取（fake）。
5. **M1-D（Release Gate）**：4+1 Session 矩阵（19 行用户矩阵）+ 运行归属：

### E1：Binding 完全指定（必须 PASS）
```text
profile {provider=A, model=Model-A}
→ provider=A, provider_source=binding, requested_model=Model-A,
  resolved_model=Model-A, model_source=binding
```

### E2：Binding 只指定 Provider（必须如实记录继承）
```text
profile {provider=B}，Supervisor=Model-S
→ provider=B, provider_source=binding, requested_model=null,
  resolved_model=Model-S, model_source=parent-inherited
```

### E3：完全无 Profile（fallback 证据）
```text
profile=null
→ provider=global workerProvider, provider_source=global-fallback,
  requested_model=null, model_source=parent-inherited
```

## 12. 已冻结的裁决记录

| # | 裁决 | 结论 |
|---|---|---|
| 1 | 4 列 vs JSON | **双轨**：独立列（核心证据）+ 不可变快照 JSON（扩展参数） |
| 2 | observed seam | 接受，**改名 `resolved_model`**（DSH 解析结果）；observed 留给未来 telemetry |
| 3 | model_name 只做席位元数据 | 确认 + **硬不变量**（Factory 禁止读取）+ 测试锁定 |
| 4 | ADD COLUMN + v1 | **否决**：`SCHEMA_VERSION=2`，正式 v1→v2 事务化迁移 |
| 追加 | ExecutionProfile 治理 | 修改走 Trusted Admin Plane（独立工具 `kingdom_set_execution_profile`） |
| 追加 | options | v1 冻结 `{provider?, model?}`，无透传；未来逐项 allowlist 进 schema |
