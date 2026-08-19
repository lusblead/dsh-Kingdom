# 调查任务单：dsh web 实例在 governed execution 真实模型 turn 期间反复重启

> 提交：dsh-Kingdom v0.8 开发 agent（2026-08-19）
> 接办：独立调查 agent（无前置上下文，自本文件开始）
> 状态：**BLOCKER #2 = UNRESOLVED RUNTIME / INTEGRATION STABILITY**（v0.8 RC 的剩余阻塞项之一）
> 边界：调查只读为主；不得触碰正式 `C:\Users\ADMIN\.dsh\kingdom\kingdom.db`（保持 v3）；不得 commit/tag/push/publish；修改 DSH 上游需另获 Owner 授权。

---

## 1. 一句话问题

在 dsh web 运行实例上，通过 `AgentRegistry.create` 创建 worker 持久 Session 并用 `agent.followup` 驱动**真实模型 turn** 时，实例进程在 turn 执行期间（followup 后约 10–22 秒）**反复重启**；三次尝试（含极简 prompt「只回复 OK」）100% 复现。Kingdom governed execution 代码（S2–S6）本身不包含任何进程退出调用，且 gate/materialize/receipt 等**无模型 turn 的步骤全部稳定**。

## 2. 环境与复现入口

- DSH checkout：`D:\deepseek-harness` @ `00b7102f1d`（0.1.0-rc.7）
- 实例启动命令（PID 曾为 34800）：`node --import tsx/esm apps/cli/src/bin.ts web`（profile web，`C:\Users\ADMIN\.dsh\profiles\web\`）
- 注入器：dsh-super-injector（staging 工具机制，`D:\dsh\dsh-routing-suite\_release-injector\package\src\index.ts`）；staging execute 在实例进程内运行，可拿到真实 `ctx.get('agents')` / `ctx.get('permission')` / `ctx.get('sandboxPolicy')` / `ctx.get('approval')`
- 复现工具（staging，保留后侧可复用）：`kingdom_v08_e2e_*`（其中 `b1a6` = 极简 followup 触发；`readlog` = 读持久 session 日志）
- 测试库：`C:\Users\ADMIN\AppData\Local\Temp\kingdom-e2e\kingdom-e2e.db`（TEMP 全新 v4 库，与正式库完全隔离）
- 复现步骤：staging execute 内 `agents.create({sessionId, meta:{cwd}, agentOptions:{provider:'deepseek-vision', model:'deepseek-v4-pro'}})` → `agent.followup(完整 UserMessage)` → 进程在 turn 中退出 → 实例重启后 registry 清空（worker session 消失）

## 3. 精确现象（已收集的证据）

| 时间（UTC） | 事件 |
|---|---|
| 07:47:35 | 重启点 1（attempt 4 followup 后，模型 turn 中） |
| 07:54:13 | 重启点 2（attempt 5 followup 后） |
| 08:03:12 | attempt 6 followup 入队（极简 prompt「只回复一个词：OK。不要调用任何工具。」） |
| 08:03:34 | 实例进程 PID 29680 → 42888（followup 后 22 秒） |
| 08:03:42 | injector self-heal 记录 `purge-stale-tools`（= 重启标记） |

- **实例 PID 变迁**：34800（09:33 启动）→ 29680（15:54:06 本地）→ 42888（16:03:34 本地）
- **持久 session 日志**（`sessionPersistence.readFrom('4e4b0bf7-…')`，17 事件）：`user/message id=8d693a66`（= followup）→ `turn/start {turn:1}` → `step/start` → `step/end` → **`turn/end {reason:{kind:'interrupted'}}`**；**无 `assistant/message`**（模型未产出回复即中断）
- **模型请求配置**（`request/header` 事件）：`{provider:'deepseek-vision', model:'deepseek-v4-pro', maxTokens:256000, reasoningEffort:'high'}`——worker session 创建时只传了 provider/model，**maxTokens/reasoningEffort 从根 agent 继承**（当前会话根 agent 配置即 256K/high）
- Windows 事件日志（15:40–16:00）：**无** Application Error / Event 1000 / 1001 —— 排除 node 段错误、未捕获异常导致的硬崩溃
- injector self-heal.log：仅 `purge-stale-tools` / `cache-miss-healed` 正常记录，无 error/崩溃栈
- 掉线后 registry 仅剩当前会话（`session-1c94a91a…`，即我）；worker session 全部消失（随进程重启）

## 4. 已排查 / 已排除

- ❌ **Kingdom lib 直接触发退出**：`lib/core/governed.js`、`lib/dispatch/*`、`lib/adapter/*` 无 `process.exit` / `process.kill` / 未捕获异常处理器；staging 工具抛错（如 SQLite 参数绑定错误）由工具运行时捕获显示 `ERROR`，不杀进程
- ❌ **Windows 级硬崩溃**：事件日志无 crash 记录
- ❌ **复杂 turn / 工具调用**：极简 prompt（无工具调用）同样触发
- ⚠️ **疑似诱因（未证实）**：worker turn 继承 `maxTokens=256000 + reasoningEffort=high` 的重型 LLM 请求；与主会话并发时的资源/连接交互（实例同时服务当前会话 + worker turn 两个 256K/high 推理）
- ⚠️ **疑似诱因（未证实）**：staging execute 作用域对 `AgentHandle` 的生命周期处理（super-injector 是否在 execute 返回/超时后 dispose agent）——但该假设不能解释**进程重启**（dispose 不会重启进程），仅能解释 session 消失；进程重启本身是独立事实
- ⚠️ **注入器自身**：`purge-stale-tools` 每次重启出现，但它是重启后的自愈动作，非重启原因

## 5. 建议调查方向（按优先级）

1. **找到进程退出/重启的真实原因**：
   - 实例 stdout/stderr 去向（启动脚本/看门狗/重定向文件）——目前未定位到实例日志文件；`C:\Users\ADMIN\.dsh\logs\` 仅含 vision-router
   - 是否有看门狗 / 进程管理器 / npm script wrapper 在实例退出后自动重启（查 `bin.ts web` 启动链路、`apps/cli/src/bin.ts` 的进程管理）
   - dsh 是否有 idle/supervise/auto-restart 机制（查 `packages/host/*`、`packages/web/*`）
2. **模型请求与进程退出关联**：
   - 用**覆盖 agentOptions**（`maxTokens` 小值如 4096、`reasoningEffort:'low'`）创建 worker session 再 followup——若不再重启，则证实重型请求为诱因
   - 观察 worker turn 的 LLM 请求是否与主会话共享连接/上下文并发问题（`packages/llm/*`、`packages/agent-loop/*`）
3. **注入器 execute 生命周期**：
   - 确认 staging execute 返回/超时后 super-injector 是否 dispose execute 内创建的 agent/资源（`D:\dsh\dsh-routing-suite\_release-injector\package\src\index.ts`）——即使不解释重启，也影响"worker session 在实例存活时能否跨工具调用保留"（v0.8 persistent session 的实机前提）
4. **turn/end reason=interrupted 的来源**：`packages/core/agent-loop/src/*` 中 `reason:{kind:'interrupted'}` 的触发路径（dispose/cancel/进程退出），确认它记录于进程退出瞬间

## 6. 相关代码定位

- 实例入口：`D:\deepseek-harness\apps\cli\src\bin.ts`（`web` 命令）
- Agent 生命周期：`D:\deepseek-harness\packages\core\agent\src\index.ts`（AgentRegistry.create/resume、AgentHandle.dispose）
- Agent loop / turn 中断：`D:\deepseek-harness\packages\core\agent-loop\src\{agent.ts, index.ts}`
- 会话事件类型：`D:\deepseek-harness\packages\core\session\src\known-event-types.ts`
- 模型配置：`D:\deepseek-harness\packages\llm\llm\src\`、`packages\llm\llm-deepseek\src\`
- 持久 session 读取（已验证可用）：`ctx.get('sessionPersistence')` 的 `readFrom`/`load`（`packages/session/session-persistence-jsonl/src/`）
- 注入器 staging 机制：`D:\dsh\dsh-routing-suite\_release-injector\package\src\index.ts`（dev_stage_add/call）
- Kingdom 相关（供对照，非嫌疑）：`D:\dsh\kingdom\src\adapter\dsh-backend.ts`（createSession/followup）、`D:\dsh\kingdom\src\dispatch\service.ts`

## 7. 成功标准

回答一个问题：**dsh web 实例在 governed execution 真实模型 turn 期间反复重启的根因是什么（或给出可验证的排除结论 + 剩余候选）**；若证实与 Kingdom 代码相关，指明 S3/S4/S5 具体层与最小修复；若为实例/模型层，给出证据链与规避参数（如 worker session 应覆盖的 agentOptions）。调查输出写入本目录 `STABILITY-FINDINGS.md`。
