# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.3.1] — 2026-08-18

### Fixed（热插拔生命周期，Phase 3 加固）

- **卸载时有在途 Worker 执行不再静默丢数据**：结算写入失败会抛出带可行动说明的错误，原始错误保留在 `cause` 中（可诊断）。
- **孤儿 Execution 自动回收**：加载期发现上次会话遗留的活跃 Execution → 判定为 `ABORTED`（reason=`reclaimed-on-load`），发出 `SESSION_STOPPED(reason=reclaimed-on-load)`；不替 Supervisor 裁定任务治理状态；任务可直接重新 `start`；attempt 号跳过被回收的那次（不撞 `UNIQUE(task_id, attempt_no)`）。
- **GUI 通道端口卸载/重绑**：卸载后端口立即释放，可立刻重绑同一端口（无 `EADDRINUSE` 残留）。
- **HMR 新旧实例重叠安全**：端口冲突时新实例不崩溃（只告警降级）；旧实例卸载后新实例自动重试接管端口（GUI 通道自愈）；自愈重试在 dispose 后停止（不留悬挂 timer）。
- 重复 dispose 幂等（不抛错）。

### Added

- `scripts/hotplug-audit.mjs`：热插拔审计（27 断言，覆盖卸载/重载/端口/在途执行/重叠实例）。
- `scripts/p3-smoke.mjs` 扩至 113 断言（含 GUI 契约一致性：ActorState/ExecutionView 对齐 GUI resolver）。

## [0.3.0] — 2026-08-17

### Added（Phase 3：GUI 适配层 + Execution 生命周期）

- `src/gui/`：结构化快照（`snapshot.ts`）、本地 HTTP 通道（`server.ts`，默认关闭、只绑 127.0.0.1、可选 bearer token）、契约（`contract.ts`，ActorState/ExecutionView 对齐 GUI resolver）。
- `src/core/execution.ts`：Execution 生命周期（运行事实与治理状态分离）。
- 新工具：`kingdom_snapshot` / `kingdom_task_detail` / `kingdom_execution_control`（pause/resume/abort）。
- 角色动画状态映射真实 Core 状态（ExecutionView.state = 运行事实，不假装干活）。

## [0.2.0] — 2026-08-17

### Added（Phase 2：Task 治理闭环）

- Task 状态机（Core 代码层冻结）：`CREATED → ASSIGNED → RUNNING → REVIEW → DONE/FAILED`（REWORK → RUNNING）；`transition()` 是唯一改 `tasks.status` 的路径。
- **Claim ≠ Fact**：Worker 结果只落 `worker_results` + Task → `REVIEW`；DONE 只能经 Supervisor `ACCEPT`；FAILED 双来源（Supervisor FAIL 决定 / executor 客观失败）。
- `worker_results` 表（第 6 张）：`UNIQUE(task_id, attempt_no)`，保存每个 attempt 的 Worker Claim。
- Worker 独立执行：`ctx.subagents.start` one-shot（经 `WorkerExecutor` / `DshSubagentExecutor` 薄封装，Task Core 不直接依赖 subagents）。
- REWORK：同一 Worker Binding + attempt+1 + 新 session + 注入 prevResult/reworkReason。
- 新工具：`kingdom_plan_task` / `kingdom_assign_task` / `kingdom_start_task` / `kingdom_review_task` / `kingdom_list_tasks`。
- 零 migration：tasks 表 DDL 未改；`worker_results` 幂等追加；Territory 加 `CREATE UNIQUE INDEX IF NOT EXISTS`。
- P2 加固：README peer 说明、删死代码、Territory UNIQUE。

### Fixed

- 修正任务书 outputSchema 字面错误（`enum` 需挂 `type`，否则 dsh 校验器拒绝导致 Worker 执行被打成 FAILED）。

## [0.1.0] — 2026-08-17

### Added（Phase 1：王国基础 + 可安装化）

- `/kingdom init`（幂等：无则初始化 + Owner，有则接入不覆盖）/ `/kingdom status` / `/kingdom reset` / `/kingdom help`。
- 工具：`kingdom_init` / `kingdom_status` / `kingdom_create_territory` / `kingdom_list_territories` / `kingdom_bind_role` / `kingdom_list_bindings`。
- 5 表 schema：kingdoms / territories / role_bindings / tasks / events。
- Owner 声明性本地身份（UUID + OS 用户名，无签名认证）。
- 可安装化：`dsh.bundle.patch` 声明 + `cordis.patch.yml`（insert 形态）+ 预构建 tgz（用户无需 bash/tsc/junction/checkout）。
- 重启恢复：DSH 关闭重开，王国状态完整。

---

## 兼容性说明

- **Tested with**: `@deepseek-ai/dsh` `0.1.0-rc.5`（checkout commit `47f94385`）。
- 安装时 5 条 peer dependency warning（dsh-commands/llm/tools/cordis/schemastery）是**预期行为**，这些包由 DSH 运行时提供。
- Worker 执行（`kingdom_start_task`）依赖宿主 `subagents` 服务与模型 key。
