# dsh-Kingdom v1.0 GUI 快速开始

> GUI 是本地插件界面，不会把浏览器、Cookie 或当前操作者提升为 Owner、Chancellor 或 Supervisor。真实 Provider、正式数据库迁移和跨重启恢复必须按各自证据判断，不能由界面可见或 npm 发布推导出来。

## 先分清“源码可见”和“已经验证”

| 证据 | 当前结论 | 不能推出什么 |
|---|---|---|
| 最新命令、控制台、投影与核心源码 | 可定位王国地图、管理中心、王国账本、任务导航、移交、沙箱、权限与恢复规则 | 不等于真实 Provider 或正式数据库通过 |
| 自动化测试与隔离打包 | 证明对应代码路径与发布包内容 | 不证明真实 DSH 会话、模型输出或人工 GUI 体验 |
| 真实浏览器 1024×768、390×844 | 由人工验收连续点击、刷新、键盘和窄屏体验 | 不替代真实 Provider 或正式数据库证据 |
| 真实 DSH、Provider、正式数据库 | 必须单独执行并留存相应证据 | 不能从静态源码、GUI 或发布状态反推 |

## 1. 最短打开路径

### 交付形态

v1.0 的 GUI 是插件内置组件，通过版本化 tgz 随 `lib/**` 交付。独立 GUI zip 不是安装或使用 GUI 的前提。

1. 首次使用时，由人类 Owner 在本地 DSH 中直接输入 exact `/kingdom` Slash，完成初始化、能力上限、领地、角色/会话和 Worker 执行方案。GUI 不代做这些 Owner 专属写入。
2. 在需要行使日常角色职权的真实 DSH 会话中直接输入：

   ```text
   /kingdom gui
   ```

3. 若本机浏览器完成带 ticket 的导航，一次性启动入口兑换后会重定向到干净的 `/console`。如果本机打开请求失败，控制会话虽已激活，但命令只显示不含 ticket 的干净 `/console` 参考地址；该地址不能完成一次性兑换，不要手工拼接、复制或复用启动值，直接重新执行 `/kingdom gui`。
4. 用完后回到 DSH，直接输入：

   ```text
   /kingdom gui stop
   ```

控制台只承载会话绑定的日常操作与只读观察。它不会把浏览器、Cookie、HTTP 成功响应或 DSH Session 变成 Owner。

### Owner 首次配置示意

以下只是公开命令形状；尖括号必须在本机替换，真实 Session、凭据和 Provider 私有配置不得写入文档、截图或日志：

```text
/kingdom init
/kingdom ceiling {"ceiling":{"tool:pwsh":true}}
/kingdom territory.create {"name":"<领地名>","workspace_path":"<工作区>"}
/kingdom role.bind {"role_type":"CHANCELLOR","role_name":"<执政官名称>","session_id":"<Chancellor-DSH-Session>"}
/kingdom role.bind {"role_type":"SUPERVISOR","role_name":"<主理人名称>","session_id":"<Supervisor-DSH-Session>"}
/kingdom role.bind {"role_type":"WORKER","role_name":"<执行者名称>"}
/kingdom territory.supervisor {"territory_id":"<领地-id>","supervisor_binding_id":"<Supervisor-绑定-id>"}
/kingdom execution-profile {"binding_id":"<Worker-绑定-id>","provider":"spawn","model":"<请求模型>"}
```

`territory.create` 的返回文本包含领地 id；角色绑定 id 可通过只读 `kingdom_list_bindings` 查询。把对应 id 填回 `territory.supervisor` 与 `execution-profile`，不要猜测或从 Session 反推。Owner 写命令只接受一个严格 JSON object；未知字段、额外 token、任意深度的重复字段，以及把 `OWNER.session_id` 当成权限来源的输入，都应在写入前拒绝。

## 2. 三个页面与片段导航

片段地址只表示页面内位置，不是权限、会话或事实来源。读取状态仍须通过本地控制通道。

| 页面 | 片段 | 用途 | 事实边界 |
|---|---|---|---|
| 王国地图 | `#overview` | 无外层容器的组织地图、动态领地/人物关系和人类优先的状态概览 | 以当前组织投影为准 |
| 管理中心 | `#management` | 单输入框创建任务；输入 `/` 选择领地，优先交给 Chancellor 或对应 Supervisor | 最终仍由 Core 校验角色、scope 与状态 |
| 王国账本 | `#ledger` | 按需展开领地名册、任务、执行和治理史册 | 运行观察、Worker Claim 与治理事实保持分层 |

账本内部仍可使用 `#organization`、`#tasks`、`#executions` 和 `#activity` 定位具体资料。任务深链使用 `#task=<编码后的任务-id>`。未知、空值或畸形片段会回退到王国地图，显示 `UNKNOWN_NAVIGATION`，且不执行写操作。

## 3. 会话绑定的任务闭环

`/kingdom gui` 在激活时捕获当前 DSH Session。浏览器不能提交或改写 principal/session。不同角色的操作必须从对应的真实 DSH 会话重新激活，不能在页面里自报身份：

- 规划 `plan`：需要在任 Chancellor 的绑定会话；
- 指派 `assign`、启动 `start`、审查 `review` 与执行控制：需要任务所属领地在任 Supervisor 的精确绑定会话和 scope；
- 每次写入仍由 Host/Core 复核角色、scope、能力和状态机；按钮可用不等于最终授权。

短期控制会话的 action 只证明传输层准入，不预判具体角色或资源。例如，只要激活时捕获到非空 Session，控制视图可能允许提交 `plan`，最终仍由 Core 检查 Chancellor。对已有任务或 Execution，页面还会把控制视图与资源级 `allowedActions` 相交。两层都必须提供结构化且显式的 `executable=true`；旧式命令字符串列表只作兼容观察，不能授权。只看到命令名称、按钮或协议字段，不能推出当前资源或最终 Core 可执行。

### 3.1 规划与指派

1. 在“任务”区填写标题、领地、描述和可观察的验收标准，提交规划。成功后以刷新后的任务状态 `CREATED` 为准。
2. Supervisor 选择任务与目标 Worker Binding；只有最新动作投影允许 `assign` 时才提交。
3. 成功后核对任务状态 `ASSIGNED`、当前 Assignment 和 Worker。下拉框选择本身不是分配事实。

### 3.2 启动持久治理执行

1. 只有最新动作投影允许 `start` 时继续。
2. Supervisor Grant 只描述本次能力需求，不携带身份，也不能扩大 Owner Ceiling。
3. 沙箱模式只能使用 Host 列出的 `workspace-write` 或 `read-only`；未传值时 Host 默认 `workspace-write`，但 GUI 应显式展示选择。它是 Capability enforcement 的输入，不等同于已实证的操作系统隔离，也不会凭空增加 Capability。
4. 启动规范路径 `GOVERNED_PERSISTENT`。能力无法可靠 enforce 时应拒绝并保持 zero execution；不得自动降级到 `LEGACY_COMPAT`。
5. 分开读取任务治理状态与本次 Execution 运行状态。`Task.RUNNING` 不能证明 Runtime 正在执行。

Host 在访问 Runtime、Session、Lease 之前先检查同一任务是否已有未终结的持久治理 Execution。`STARTING`、`RUNNING`、`PAUSED` 或 `RECOVERING` 都会阻止新 attempt；其中恢复中返回 `EXISTING_EXECUTION_RECOVERING`，其他未结算状态返回 `EXISTING_EXECUTION_UNSETTLED`。此拒绝不改变任务，也不自动重试。

这是对调用前既有记录的 Host preflight guard，不是并发原子 claim。当前源码/测试未证明两个并发 start 不会同时越过查询；并发双启动仍是未验证边界。

### 3.3 呈报、审查与移交

Worker 输出只形成呈报（Claim）。收到结果后，任务进入待审状态 `REVIEW`；Runtime terminal 也不能直接产生 `DONE`。

| Supervisor 裁决 | 治理结果 | 含义 |
|---|---|---|
| 接受 `ACCEPT` | `DONE` | 唯一把 Worker Claim 接纳为完成事实的入口 |
| 返工 `REWORK` | `RUNNING` | 保持当前 Assignment；新的 attempt 仍须显式启动 |
| 判定失败 `FAIL` | `FAILED` | 形成失败治理事实；必须给出 reason |
| 移交 `HANDOFF` | `RUNNING` | 原子关闭旧 Assignment，并建立可追溯的新 Assignment |

移交必须提供 reason 与 `to_binding_id`。目标必须是当前王国中在任且不同于当前执行者的 Worker Binding。任一步失败都回滚；成功后仍需为新 Worker 显式启动下一个 attempt。

## 4. 执行控制的诚实边界

控制协议中存在 `execution.pause`、`execution.resume`、`execution.abort`，只说明命令形状已接线，不说明持久治理 Runtime 可被控制。

当前 `GOVERNED_PERSISTENT` 的可验证 Runtime control/reconcile seam 尚未实现和实证。对某个符合生命周期的控制候选，在 Session、Supervisor、scope、Host 与命令覆盖检查全部通过后，资源投影必须返回：

- `executable=false`；
- 原因码 `GOVERNED_RUNTIME_CONTROL_UNAVAILABLE`；
- 不修改 Execution、Task 或事件；
- 不把“请求已发送”显示成已经暂停、恢复或终止。

`RECOVERING` 或终态 Execution 可能不列出控制动作，非法状态、身份或 scope 也可能先返回更早的拒绝原因；这些情况同样不能显示为可执行。即使绕过按钮直接提交，Core 仍先校验状态与 Supervisor scope：非法状态返回 `ILLEGAL_EXECUTION_STATE`；合法的持久执行候选返回 `EXECUTOR_UNAVAILABLE`，消息包含 `GOVERNED_RUNTIME_CONTROL_UNAVAILABLE`，两者都应零副作用。只有显式 `LEGACY_COMPAT` one-shot 的既有本地状态语义才可能在合法状态下处理这些命令；它不是持久路径失败后的自动 fallback。

## 5. Owner 权限边界

下列通用动作即使可发现，也必须始终显示 `executable=false / DIRECT_SLASH_REQUIRED`：

- 初始化或 reset；
- Capability Ceiling；
- Territory 创建、删除与 Supervisor 指派；
- Role 任命、退任或 Session 改绑；
- Worker Execution Profile。

首次配置没有 GUI 例外。历史复合配置 HTTP 拼写 `setup.basic` 只保留为 deny-only、zero-effect，不进入可执行闭包。正确做法是回到本地 DSH，由人类 Owner 直接输入 exact `/kingdom ...`，然后刷新控制台对账。

不要通过修改按钮、构造 POST 或重放 request id 尝试绕过。浏览器 payload 中的 session、principal、Agent、Owner capability、Cookie、CSRF、ticket 或 activation id 都不能建立 Authority。

### 带状态的读取与 `readContext`

`/api/snapshot`、`/api/events` 和 `/api/tasks/<id>` 是带状态的 GET：

- 只接受精确本地回环 Host/连接；存在 Origin 时必须匹配当前本地 GUI Origin；
- 需要有效控制 Cookie，或 server 已配置且匹配的 bearer；
- 显式无效或过期 Cookie 不会静默降级为 bearer；
- bearer 只准入读取，不产生角色 principal；
- 有效控制 Cookie 对应的 `readContext` 来自 direct `/kingdom gui` 激活时捕获的 Session，只在 Host 内部传给 snapshot 与任务明细投影，不从浏览器字段构造，也不序列化到响应；事件 GET 只复用读取准入并返回脱敏事件，不接收角色 `readContext`。

因此，能读取本地接口仍不等于拥有 Owner 或 Role Authority。

## 6. 状态与证据

### 四类证据不能合并

| 中文含义 | 规范标签 | 不能推出什么 |
|---|---|---|
| 治理事实 | `GOVERNANCE_FACT` | 不能单独证明 Runtime 真正完成 |
| 运行观察 | `RUNTIME_OBSERVATION` | 不能直接把任务置为 `DONE` |
| 执行者呈报 | `WORKER_CLAIM` | 不能替代 Supervisor 审查 |
| 派生解释 | `DERIVED_EXPLANATION` | 不是新 Ledger，也不能覆盖来源证据 |

### 必须原样保留的状态

| 中文含义 | 规范标签 | 应对方式 |
|---|---|---|
| 尚未确认 | `UNKNOWN` | 证据不足；刷新并对账，不猜测、不自动重试 |
| 恢复核对中 | `RECOVERING` | 等待 Runtime/ledger 证据收敛，不开新 attempt |
| 尚未运行 | `NOT_RUN` | 对应验证或探针没有执行，不能改写为 PASS |
| 兼容执行路径 | `LEGACY_COMPAT` | 仅用户显式选择；不是 persistent fallback |
| 视图已过时 | `STALE` | 手动刷新，以最新 revision 为边界 |
| 仅人类直接 Slash | `DIRECT_SLASH_REQUIRED` | 回到 DSH，由人类 Owner 直接输入命令 |
| 需要有效角色会话 | `SESSION_AUTH_REQUIRED` | 从正确绑定会话重新激活，不在浏览器自报身份 |
| 持久运行时控制不可用 | `GOVERNED_RUNTIME_CONTROL_UNAVAILABLE` | 对通过前置门控的合法候选保持不可执行，不谎报 pause/resume/abort |

Claim ≠ Fact：Worker Claim 只能把任务带到 `REVIEW`；只有 Supervisor `ACCEPT` 才能产生 `DONE`。

## 7. 故障与恢复

- 收到 `UNKNOWN/RECOVERY_REQUIRED` 或写结果不确定时，不自动重试。先刷新，并用最新 revision、Task、Execution、Lease 和 Dispatch 对账。
- 对已有 Dispatch 关联的 terminal poll 耗尽或 reconcile 不可判定路径，当前恢复函数会在一个事务中把 Dispatch、Lease、Execution 原子推进到 `RECOVERING`；任一写入失败时全部回滚，重复调用是零写入、零重复事件的幂等读回。
- 上述三账本恢复不会改写 Task，不会伪造 terminal evidence、释放 Lease、重发 Dispatch 或开启新 attempt。
- 插件加载期发现孤立的 `GOVERNED_PERSISTENT` Execution 是另一条更保守的路径：只把 Execution 标为 `RECOVERING`，不声称 Session 已停止或 Lease 已释放。
- 控制会话过期、撤销或失效时，从正确 DSH 会话重新 direct `/kingdom gui` 激活；不要重放旧启动值、Cookie、CSRF 或 request id。
- 未知片段只回退“总览”。若任务选择仍不确定，保持 `UNKNOWN`，不要把默认页面当成目标任务事实。

## 8. 隐私与有界投影

- GUI 只监听精确回环地址 `127.0.0.1`，不是远程或生产服务。
- 临时启动值、HttpOnly Cookie、CSRF、request id 和 activation id 都只是传输证据，不是 Authority。
- 不要把凭据、API key、Provider 私有配置、完整 Session 导出、完整聊天、正式数据库或未脱敏日志放进表单、文档、截图与验收产物。
- 当前公开投影对事件 payload 与 Binding session metadata 做递归、确定性脱敏：敏感键/文本和路径被替换；投影输出中的单字符串最多 512 字符，单对象或数组最多 32 项，深度最多 6 层，总节点预算 512。
- `sourceRefs` 最多 8 条；Timeline、组织与执行摘要也各自有界。截断标记表示证据不完整，不能据此补猜。
- 这些是投影结构上限，不证明任意超大原始输入的字节数或 CPU 成本严格有界。脱敏是最后一道安全带，不是提交秘密的许可；公开投影生成过程不应修改持久化数据。

## 9. 临时验收口径

后续验收只使用全新、被忽略的临时 DSH home 与 SQLite v4，不读取或修改正式数据库。已有 v3 库默认不自动迁移，必须另行通过 Formal DB Migration Gate；本文不授权或验证该迁移：

1. fake runtime 只证明 Adapter/Host 路径，不冒充真实 DSH、Provider 或模型证据。
2. 在 1024×768 与 390×844 各走一次王国地图、管理中心、王国账本、任务深链、规划→指派→启动→呈报→审查与移交。
3. 对 `GOVERNED_PERSISTENT` 核对执行控制从不显示为可执行；符合生命周期且通过前置门控的候选显示 `GOVERNED_RUNTIME_CONTROL_UNAVAILABLE`，其他状态保留真实的缺席或更早拒绝原因。
4. 检查键盘焦点、横向阻断和浏览器 console 的 P0/P1 warning/error。
5. 检查 Owner 专属动作始终为 `DIRECT_SLASH_REQUIRED`，带状态读取和浏览器 payload 都不能伪造身份。
6. 只清理能够明确归属本次验收的临时资源，不碰正式数据或未知进程。

上述真实浏览器验收仍是 `NOT_RUN`。桌面操作时间窗限制已经解除，但本轮未执行真实点击；Markdown、链接、自动化测试与静态视觉检查均不能替代连续桌面交互证据。

## 10. 当前事实依赖

本指南静态复读以下最新源码与测试代码：

- `src/gui/console-app.ts`：王国地图、管理中心、王国账本、任务导航器、片段解析、中文状态解释和双层动作门控；
- `src/gui/control-contract.ts`、`src/gui/local-control.ts`、`src/gui/server.ts`：会话命令、Owner deny-only、严格 payload、短期控制会话、带状态 GET 与 `readContext`；
- `src/index.ts`：session-bound GUI 分发、governed start Host guard、direct Slash Owner 入口和未知结果恢复提示；
- `src/gui/snapshot.ts`：资源级 `allowedActions`、持久执行控制不可用、有界来源与递归脱敏；
- `src/core/task-service.ts`：Task→Execution→Review、HANDOFF 和执行控制 fail-closed；
- `src/core/governed.ts`、`src/dispatch/reconcile.ts`、`src/dispatch/service.ts`：三账本原子 `RECOVERING` 与幂等恢复；
- `tests/gui-interactive-console.test.ts`、`tests/gui-control-server.test.ts`、`tests/gui-v1-command-surface.test.ts`、`tests/gui-v1-vertical-flow.test.ts`、`tests/m3s2-v4-gui.test.ts`、`tests/governed-start-supervisor-authz.test.ts`、`tests/command-recovery.test.ts`、`tests/m3s2-v4-s5-dispatch.test.ts`：对应边界断言。本文档施工未复跑这些测试。
