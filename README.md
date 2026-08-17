# dsh-Kingdom

独立 dsh 插件：安装后在 DSH 会话中初始化/接入一个本地王国。

```
下载插件 tgz
  ↓
dsh plugin --profile web add dsh-external-dsh-kingdom-0.3.0.tgz
  ↓
（重新）启动 DSH
  ↓
/kingdom init  或  说“初始化王国”
  ↓
开始拥有一个王国
```

## 安装（正式方式，无需 dev_inject）

发布产物是预构建 tgz（已编译 lib/ + bundle patch 声明），用户本机**不需要** bash、WSL、junction、DSH checkout 或 tsc：

```bash
dsh plugin --profile web add ./dsh-external-dsh-kingdom-0.3.0.tgz
```

安装后：
- 包被 pnpm 装进 profile，并因 `dsh.bundle.patch` 声明**自动加入 `dsh.profile.bundles`**；
- **完全退出并重新启动 DSH 后插件自动加载**（不依赖 dev_inject_plugin）；
- 首次进入会话执行 `/kingdom init`（或自然语言“初始化王国”）完成初始化。

### 安装时的 peer dependency warning 是预期的

安装时 pnpm 会打印 **5 条 unmet peer dependency warning**：

```
@deepseek-ai/dsh-commands / @deepseek-ai/dsh-llm / @deepseek-ai/dsh-tools / cordis / schemastery
```

**这是预期行为，不是安装失败，无需处理。** 原因：这 5 个包都由 DSH 的 base bundle 在运行时提供，
本插件作为 profile bundle 层加载时与宿主共享同一份实例。把它们声明成 `dependencies` 反而会装出
第二份副本，导致 cordis 上下文与服务注册表分裂（同一个服务出现两个不同的类实例）。
所以它们**必须**留在 `peerDependencies`，warning 只是 pnpm 在陈述“这些由宿主提供”这一事实。

判断安装是否成功看这个，而不是看 warning：重启 DSH 后 `/kingdom status` 能返回真实状态。

> Phase 2 的 Worker 执行依赖宿主的 `subagents` 服务（base bundle 默认注册 `spawn` / `fork` provider）。
> 本插件对它只做**结构化**调用、不 import 其类型，因此没有第 6 条 peer；
> 宿主若未提供该服务，`kingdom_start_task` 会明确报错，其余工具不受影响。

## 使用

| 命令 | 作用 |
|---|---|
| `/kingdom init` | 初始化或接入本地王国（幂等：无则新建，有则接入） |
| `/kingdom status` | 查看王国真实状态（王国/Owner/领地/绑定/任务/事件） |
| `/kingdom reset` | 重新扫描接入（不删除数据） |
| `/kingdom help` | 帮助 |

### 工具（模型可经自然语言调用）

**Phase 1（治理基础）**：`kingdom_init` / `kingdom_status` / `kingdom_create_territory` /
`kingdom_list_territories` / `kingdom_bind_role` / `kingdom_list_bindings`

**Phase 2（任务治理闭环）**：`kingdom_plan_task` / `kingdom_assign_task` /
`kingdom_start_task` / `kingdom_review_task` / `kingdom_list_tasks`

**Phase 3（GUI 适配）**：`kingdom_snapshot` / `kingdom_task_detail` / `kingdom_execution_control`

示例：
> “给当前项目创建一个 RAG 研发领。” → `kingdom_create_territory(name="RAG 研发领", workspace_path=<cwd>)`

## 任务治理闭环（Phase 2）

```
plan(Chancellor)  →  CREATED
assign(Supervisor) →  ASSIGNED
start(Supervisor)  →  RUNNING  ── Worker 以 one-shot subagent 执行 ──┐
                                                                     ↓
                              ┌────────────  REVIEW  ←── Worker 交回结构化 Claim
                              │                 │
              Supervisor 裁定 ├─ ACCEPT ──→  DONE（终态）
                              ├─ REWORK ──→  RUNNING（attempt+1，新 session，同一 Worker）
                              └─ FAIL   ──→  FAILED（终态）
```

### 核心不变量：Claim ≠ Fact

**Worker 说自己完成了，任务并不会因此完成。**

- Worker 交回的结构化结果落在 `worker_results` 表，那是一条 **Claim**（自述），
  任务只会进入 `REVIEW`，**永远不会**直接变成 `DONE`。
- 即使 Worker 自称 `outcome=FAILED`，任务也只到 `REVIEW` —— 那同样只是自述；
  只有 Supervisor 的 `FAIL` 裁定才让它成为 `FAILED` 这个**组织事实**。
- 唯一的例外方向是**宿主观察到的运行事实**：当 subagent 启动失败、异常退出、
  或没交出满足 `outputSchema` 的结果时，Core 才直接 `RUNNING → FAILED`
  并记 `WORKER_EXECUTION_FAILED` —— 这不是相信 Worker 的自述，是宿主自己看见的。
- **没有任何工具能把 Task 直接置为 DONE**；`DONE` 唯一入口是 `REVIEW` + Supervisor `ACCEPT`。

Worker 也没有「上报结果」的工具：它是 one-shot subagent，结构化结果经 `outputSchema`
由宿主接收后落库。Worker 从头到尾碰不到 Task 状态。

## GUI 适配（Phase 3）

### 唯一架构原则

```text
插件输出治理事实和活动语义
GUI 决定使用哪个人物、场景和动画
```

插件**不含任何美术知识**：没有 `chancellor.png`、`sleep.gif`，也没有
`sprite.knight.default.forge.work.idle`。它只输出 `{ role, state, activity }`，
正好是 GUI 端 Visual Resolver 的输入（另两维 `skin` / `scene` 属于 GUI 部署配置）。
换贴图、换场景、把骑士换成别的形象，插件一行都不用改。

自测里有一条可执行断言守住这个边界：Snapshot 的 JSON 中不得出现
`.png` / `.gif` / `sprite.` / `atlas` / `skin.` / `pose.` 等任何美术标识。

### 两类事实必须分开读

| | 含义 | GUI 用途 |
|---|---|---|
| `TaskView.status` | **治理事实**：组织对这件事的裁定进度 | 详情面板、任务列表 |
| `ExecutionView.state` | **运行事实**：某一次执行此刻的状况 | **人物是否在工作** |

`Task.RUNNING` **不代表**人物正在工作 —— REWORK 之后任务立刻回到 `RUNNING`，
但新的 Execution 还没创建，此时骑士是 `waiting`，不能假装干活。

### 状态映射

| 治理/运行事实 | 表演语义 |
|---|---|
| `TASK_PLANNED` | 宰相 `planning` / `plan`（一次性） |
| `TASK_ASSIGNED` | 主管 `assigning` / `assign`（一次性） |
| `Execution.RUNNING` | 骑士 `working` / `execute` |
| `Execution.PAUSED` | 骑士 `sleeping` |
| `WORKER_RESULT_SUBMITTED` | 骑士离开工作位；主管转入 `reviewing` / `review`（持续） |
| `TASK_REWORK_REQUESTED` | 主管 `reviewing` / `rework`；骑士 `waiting`（**不立即假装工作**） |
| `TASK_ACCEPTED` | 主管 `reviewing` / `accept`；骑士一次性 `celebrating` 后回 `idle` |
| `Execution` 终结 | 人物 Sprite 移除；**组织节点、姓名牌、详情保留** |
| 角色无绑定 | `absent`：同样只是不渲染人物，组织节点保留 |

一次性动作带 `transient: true` + `remainingMs` + `fallbackState`，
GUI 播完回落即可；持续状态是循环。整个 stage 是 (库状态, now) 的**纯函数**，
所以轮询就能拿到正确表演，服务端没有任何定时器。

### 读接口

工具形式（模型可调）：`kingdom_snapshot` / `kingdom_task_detail` 返回结构化 JSON。

本地 HTTP 通道（**默认关闭**，配置 `guiPort` 后启用，只绑 `127.0.0.1`）：

```
GET  /api/health
GET  /api/snapshot                      # 全量快照 + revision
GET  /api/tasks/<task_id>               # 验收标准/尝试历史/Claim/决策/事件/下一步动作
GET  /api/events?since=<seq>&limit=200  # 按 seq 增量拉取，升序
POST /api/commands/<name>               # plan / assign / review / execution.pause|resume|abort
```

Beta 建议 **1–2 秒轮询** `/api/snapshot`（或先比较 `revision` 再决定是否重绘）。
事件带全库单调 `seq`，GUI 可据此判断哪个更新、是否漏事件；
漏了就重拉全量，而不是拿残缺事件流驱动动画。
**旧事件不得让已停止的人物重新出现** —— 每个 stage 状态都带 `sourceSeq` 供丢弃过期事件。

### 安全姿态（本地开发工具）

- GUI 通道**默认关闭**，必须显式配置 `guiPort` 才监听；只绑回环地址。
- 写命令要求自定义头 `X-Kingdom-Client`（强制 CORS 预检，挡表单式 CSRF）。
- 可选 `guiToken`：设置后所有请求需 `Authorization: Bearer <token>`。
- GUI **仍然经插件执行命令**，不直接写 SQLite。

### 鉴权诚实度

`authMode` 默认 `declarative`：只校验"王国中存在该角色绑定"，
**不验证调用者就是该角色**。Snapshot 的 `auth.trustLevel` 会如实报成 `local-demo`，
**GUI 在提供派发/复核/返工按钮时必须显著标注「本地可信演示权限」**。

配 `authMode: session-bound` 后，命令调用方 session 必须与 binding 的 `session_id` 一致；
binding 未绑 session 时直接拒绝（无法验证就不放行）。

### 已知 Beta 边界

- **`start` 不能从 GUI 触发**：启动 Worker 需要一个活的委派父 Agent
  （in-process provider 从它派生 workspace / 血缘 / 委派深度），HTTP 请求没有 Agent 上下文。
  该命令经通道调用会返回 `EXECUTOR_UNAVAILABLE`，GUI 应引导用户在 DSH 会话中触发。
- **暂停不能中断进行中的一轮**：one-shot subagent 无法在 turn 中途挂起。
  运行中暂停只登记请求，状态保持 `RUNNING` 并置 `pausePending: true`，
  在下一个 attempt 边界生效。GUI 应显示"准备休息"而**不是**直接播睡觉动画——那会谎报运行状态。
- 范围仍为**一名宰相 + 一名主管 + 一名骑士**；多角色实例、动态 `reports_to`、
  选举/任期、Territory 成员关系均未实现。

## 数据位置

- 数据库：`<DSH_HOME 或 ~/.dsh>/kingdom/kingdom.db`
  （SQLite，7 表：kingdoms / territories / role_bindings / tasks / worker_results / events / **executions**）
- 单文件、自包含；DSH 重启后王国状态完整恢复。
- **每一版都是零 migration**：
  - 0.1.0 → 0.2.0：`tasks` 表一字未改，`worker_results` 与领地唯一索引以 `IF NOT EXISTS` 幂等追加。
  - 0.2.0 → 0.3.0：`executions` 表幂等追加；`events.seq` 用 `PRAGMA table_info` 做存在性 gate 后
    `ADD COLUMN`（SQLite 下是 O(1) 元数据操作，不重写数据页），并按 `rowid`（= 插入顺序）
    确定性回填历史行。旧库打开即收敛，重复开库完全幂等。

## 开发

```bash
# 需要 DSH checkout（开发期）
DSH_CHECKOUT=<checkout> bash scripts/build.sh   # 或手动 tsc
node scripts/p2-smoke.mjs                        # Phase 2 治理闭环自测（81 断言）
node scripts/p3-smoke.mjs                        # Phase 3 GUI 适配自测（109 断言）
npm pack                                         # 产出可分发 tgz
```

## 版本

- 0.3.0 — Phase 3：GUI 适配。结构化 Snapshot / Task Detail / 命令结果；
  独立 Execution 生命周期（第 7 张表）；事件单调 `seq` 与 `revision`；
  本地 HTTP 通道（默认关闭）；暂停/恢复/终止与 `SESSION_*` 事件；
  可选 session-bound 角色鉴权。仍为零迁移。
- 0.2.0 — Phase 2：Task 治理闭环（plan/assign/start/review/list）+ `worker_results` 表
  + Worker one-shot subagent 执行 + **Claim ≠ Fact** 不变量；零 migration；
  加固：README peer 说明、领地防御性 UNIQUE 索引、死代码清理。
- 0.1.0 — Phase 1：init/status + Territory/Binding CRUD + 可安装 bundle（Clean Install Golden Path 通过）
