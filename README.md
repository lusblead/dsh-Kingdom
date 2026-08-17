# dsh-Kingdom

独立 dsh 插件：安装后在 DSH 会话中初始化/接入一个本地王国。

```
下载插件 tgz
  ↓
dsh plugin --profile web add dsh-external-dsh-kingdom-0.2.0.tgz
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
dsh plugin --profile web add ./dsh-external-dsh-kingdom-0.2.0.tgz
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

## 数据位置

- 数据库：`<DSH_HOME 或 ~/.dsh>/kingdom/kingdom.db`
  （SQLite，6 表：kingdoms / territories / role_bindings / tasks / **worker_results** / events）
- 单文件、自包含；DSH 重启后王国状态完整恢复。
- 0.1.0 → 0.2.0 **零 migration**：`tasks` 表一字未改，`worker_results` 与领地唯一索引
  都以 `IF NOT EXISTS` 幂等追加，旧库打开即收敛，Phase 1 数据不丢失。

## 开发

```bash
# 需要 DSH checkout（开发期）
DSH_CHECKOUT=<checkout> bash scripts/build.sh   # 或手动 tsc
node scripts/p2-smoke.mjs                        # Phase 2 验收自测（隔离目录，不碰开发库）
npm pack                                         # 产出可分发 tgz
```

## 版本

- 0.2.0 — Phase 2：Task 治理闭环（plan/assign/start/review/list）+ `worker_results` 表
  + Worker one-shot subagent 执行 + **Claim ≠ Fact** 不变量；零 migration；
  加固：README peer 说明、领地防御性 UNIQUE 索引、死代码清理。
- 0.1.0 — Phase 1：init/status + Territory/Binding CRUD + 可安装 bundle（Clean Install Golden Path 通过）
