<div align="center">

# 🏰 dsh-Kingdom

**在 DeepSeek Harness 里，装一个插件，拥有一个自己的 Agent 王国。**

[![CI](https://github.com/lusblead/dsh-Kingdom/actions/workflows/ci.yml/badge.svg)](https://github.com/lusblead/dsh-Kingdom/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-1.0.0-blue)](https://github.com/lusblead/dsh-Kingdom/releases)
[![License](https://img.shields.io/badge/license-AGPL--3.0--or--later-green)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.1.0--rc.5-orange)](#1-前置要求)
[![Node](https://img.shields.io/badge/Node-%3E%3D22.19-339933)](#1-前置要求)

</div>

---

## 这是什么？

**dsh-Kingdom 是一个 DeepSeek Harness（DSH）插件**：产品目标是在不另行部署外部服务、独立数据库或单独 GUI 前端的前提下，在 DSH 中**创建并运行一个属于自己的最小王国**——


```text
你：初始化王国
DSH：已创建王国「My Kingdom」，你成为 Owner

你：给当前项目建一个 RAG 研发领
DSH：已创建领地「RAG 研发领」

你：让 Chancellor 把"检查测试情况"规划成任务，Supervisor 派给 Worker，
    再通过 `kingdom_start_task_governed` 执行并验收
DSH：任务 CREATED → ASSIGNED → RUNNING → REVIEW → DONE ✅
```

**插件实现本地持久化语义**：角色、领地、任务和验收记录写入本地 SQLite；正式数据库迁移仍须按对应版本的迁移边界执行。

---

## ✨ 核心特性

| 特性 | 说明 |
|---|---|
| 🚀 **零门槛安装** | 发布后的一个 tgz + 一条命令；内置 GUI 随 `lib/**` 交付，无需独立前端 |
| 🏛 **完整角色体系** | Owner / Chancellor / Supervisor / Worker，角色与 Session / 模型解耦 |
| 📋 **治理闭环语义** | 规划 → 分配 → 独立执行 → 验收，任务状态全程留痕 |
| ⚖️ **Claim ≠ Fact** | **Worker 说自己完成了 ≠ 任务完成**——完成权只在 Supervisor，代码强制，不是口头约定 |
| 👷 **Persistent Governed Worker** | 候选源码的 canonical headless 路径使用 `kingdom_start_task_governed`：Worker 绑定长期 DSH Session，结果结构化返回并经 Capability/Lease 治理 |
| 🔁 **返工留痕** | governed REWORK 复用同一 Worker Persistent Session；每次尝试（attempt）都有独立 Lease/Execution 记录 |
| 💾 **持久化与恢复语义** | 状态写入本地 SQLite；真实 DSH 重启恢复与正式数据库本轮未验证（`NOT_RUN`） |
| 🔄 **换届与会话归属**（v0.4） | `kingdom_unbind_role` 解绑 / `kingdom_bind_session` 把角色绑到**独立会话**；`session-bound` 模式下只有被绑定会话能行使职权 |
| 🪪 **会话身份预留字段**（v0.4） | 角色可携带 `model_name` / `agent_name` / `session_meta`（JSON 扩展槽）——现在不必填，未来完整会话逐步填满 |
| 🎛 **内置本地 GUI**（v1.0） | 直接执行 `/kingdom gui` 打开操作台，进行会话绑定的任务规划、指派、持久治理执行与审查；Owner 配置仍只走 direct Slash |
| 👑 **Persistent Governed Worker**（v0.8） | Worker 拥有**长期 DSH Session**（REWORK 唤醒同一 Worker）；Session ↔ Territory Affinity 不可改绑；每次执行经 **Capability Gate**（仅 GRANTED+ENFORCED 才 dispatch，Runtime 无法 enforce → **DENIED + zero execution**）；**Execution Lease** 互斥 + **Dispatch Intent**（crash 可 reconcile，不盲发）；terminal 证据来自事件链，**Runtime 跑完 ≠ Task DONE**（Claim → Supervisor 裁定链不变）。这是 canonical headless 路径 |
| 🛡️ **Fail-closed 能力治理**（v0.8） | 无自授 / 超 Ceiling / scope 外 / 部分 policy 一律拒绝；approval=never 禁扩权；workspace 外写真实拒绝；RECOVERING 状态如实显示，禁止显示成 Done |
| 🧩 **Legacy 兼容**（v0.8） | `kingdom_start_task` 仅在用户明确选择时作为 `LEGACY_COMPAT` one-shot 入口；不会作为默认路径、错误恢复建议或 persistent 失败 fallback |

---

## 🚀 快速开始

### 1. 前置要求

- **DeepSeek Harness（dsh）** ≥ `0.1.0-rc.5`
- **Node.js** ≥ `22.19`（内置 SQLite，插件零原生依赖）
- 一个可用的模型 API key（Worker 执行需要）

### 2. 安装 v1.0.0

**方式 A：npm**

```bash
dsh plugin --profile web add dsh-kingdom
```

**方式 B：从 GitHub Releases 下载 tgz**

从 [Releases](https://github.com/lusblead/dsh-Kingdom/releases) 下载 `dsh-kingdom-1.0.0.tgz`，然后：

```bash
dsh plugin --profile web add ./dsh-kingdom-1.0.0.tgz
```

内置 GUI 随 `lib/**` 包含在 tgz 中，不需要额外 GUI zip：

```bash
/kingdom gui       # 激活短期本地控制会话并打开内置操作台
/kingdom status    # 也可以从 DSH 会话查看王国真实状态
```

Owner 是本机人类操作者，不是 Agent 或 Session。Owner 专属写入必须由用户直接键入
exact `/kingdom` Slash；`OWNER.session_id` 永远保持 `null`。Chancellor、Supervisor、
Worker 才使用真实 DSH caller session 的会话绑定（`session-bound`）角色平面；历史
`declarative / local-demo` 语义不能解锁产品写入。

### 3. 用 GUI 完成最小治理闭环

1. 先由人类 Owner direct `/kingdom` Slash 完成初始化、能力上限、领地、角色/会话与 Worker 执行方案配置。
2. 在本地 DSH 会话直接键入 exact `/kingdom gui`；若本机浏览器完成带 ticket 的导航，一次性入口兑换后会重定向到干净的 `/console`。若本机打开请求失败，控制会话虽已激活，但命令只显示不含 ticket 的干净 `/console` 参考地址；该地址不能完成一次性兑换，不要手工拼接或复用启动值，直接重新执行 `/kingdom gui`。
3. GUI 只用于会话绑定的日常操作与只读观察：Chancellor 会话规划任务；任务领地的 Supervisor 会话负责指派、选择 Host 提供的沙箱模式、启动与审查。切换职权时要从对应真实 DSH 会话重新激活，不能由浏览器自报身份。
4. Worker 输出只会进入待审状态 `REVIEW`。Supervisor 选择接受 `ACCEPT` 后才进入 `DONE`；返工 `REWORK` 回到 `RUNNING` 并保留同一 Assignment，判定失败 `FAIL` 进入 `FAILED`。不用时执行 `/kingdom gui stop` 撤销控制会话并关闭本地 server。

Owner 专属 JSON Slash 命令只接受单个 object envelope；未知字段、额外 token、重复字段和
`OWNER.session_id` 改绑会在写入前拒绝。独立 GUI/HTTP 不能自行取得 Authority；只有 direct
`/kingdom gui` 激活闭包内的短期控制会话才可能执行日常角色操作，浏览器 payload 不能提交
principal/session/Owner capability。

---

## 🛠 工具一览

| 阶段 | 工具 |
|---|---|
| 王国基础 | **`/kingdom init`**（Owner direct）· `kingdom_status`（只读） |
| 领地 | **`/kingdom territory.* <JSON>`**（Owner direct）· `kingdom_list_territories`（只读） |
| 角色 | **`/kingdom role.* <JSON>`**（Owner direct）· `kingdom_list_bindings`（只读） |
| 能力治理 | **`/kingdom ceiling <JSON>`**（Owner direct） |
| 任务治理 | `kingdom_plan_task` · `kingdom_assign_task` · **`kingdom_start_task_governed`（CANONICAL HEADLESS）** · `kingdom_review_task` · `kingdom_list_tasks` |
| 显式兼容 | `kingdom_start_task`（`LEGACY_COMPAT` one-shot；必须传 `legacy_opt_in=true`，仅用户明确选择，不自动 fallback） |
| 执行控制 | `kingdom_execution_control` |
| GUI | **`/kingdom gui`**（打开）· **`/kingdom gui stop`**（撤销并关闭）· `kingdom_snapshot` · `kingdom_task_detail` |

> **领地删除（v0.5.1）**：`/kingdom territory.delete <JSON>` 遵循治理语义——
> 领地下存在任务（任意状态）时**默认拒绝**；传 `force=true` 才级联删除：未终态任务统一标记 `FAILED`、
> 活跃执行终止，`TERRITORY_DELETED` / `TASK_FAILED` 事件留痕；`DONE`/`FAILED` 终态任务不篡改。

> **Owner Ceiling（v0.8）**：在任何 governed start 前，用户直接执行
> `/kingdom ceiling {"ceiling":{"filesystem.write":true,"tool:pwsh":true}}`。
> `ceiling` 不是 Agent Grant，不能由 Tool 参数或 `exec.agent.session.id` 代替；未配置或越过
> Ceiling 仍由既有 Capability Gate 拒绝并完成 Lease cleanup。清空 Ceiling 只会保持 fail-closed。

---

## 🧠 它如何保证"治理是真的"？

这是 dsh-Kingdom 与其他 Agent 编排工具最根本的区别：

```text
Worker 交回结果 ──→ 这是一条 Claim（自述），只进 REVIEW
                        ↓
               Supervisor ACCEPT ──→ DONE（组织事实）
               Supervisor REWORK ──→ 返工（同一 Worker Persistent Session）
               Supervisor FAIL   ──→ FAILED（组织事实）
```

- **Worker 没有"完成"的权力**：它没有上报结果的工具，结果经宿主接收后落库，任务永远停在 `REVIEW`。
- **没有任何工具能把任务直接置为 DONE**——DONE 唯一入口是 Supervisor 的 ACCEPT。
- **即使是 Worker 自称失败**，任务也只到 REVIEW；FAILED 只能是 Supervisor 裁定，或宿主观察到执行器客观失败（启动失败/异常退出）。
- 每次执行（attempt）都记入 `worker_results`，返工历史完整可查。

> **一句话：模型可以提出动作，但只有程序决定状态。**

---

## 📁 数据与存储

| 项目 | 说明 |
|---|---|
| `~/.dsh/kingdom/kingdom.db` | 王国全部数据（SQLite，自包含） |
| Schema v4 | 在既有王国、领地、角色、任务、呈报、执行与事件之外，包含 Assignment、Affinity、Capability Decision、Lease 与 Dispatch 等治理账本 |

全新库或尚无王国数据的库可直接建立 v4；已有 v3 库默认保持 v3，不会自动迁移。只有经过 Formal DB Migration Gate 明确放行后才可迁移；未迁移时 GUI governed plan 与 governed start 均 fail-closed。本文档施工没有读取、迁移或验证正式数据库（`NOT_RUN`），不能据此声称旧库兼容或迁移通过。

---

## 🎛 GUI（王国操作台）

GUI 已内置在插件中，不需要下载或启动第二个前端项目。直接在本地 DSH 会话执行：

```text
/kingdom gui
```

插件只绑定 `127.0.0.1`，按实际监听端口生成一次性短期启动值，并请求本机浏览器打开 Console。启动值只兑换一次，随后重定向到干净的 `/console`；写请求还须通过 HttpOnly `SameSite=Strict` Cookie、CSRF、唯一 request id、精确 Origin 与单一在途请求检查。GUI/HTTP 本身没有 Authority，也不能构造 Owner 或角色身份。

### 操作台能力

- 首页就是无外层边框的“王国地图”：默认森林墨绿主题，可切换四种主题；领地颜色随主题区分，人物卡片按任务状态显示不同状态色。
- “管理中心”和“王国账本”是独立页面。首页只保留组织结构和一个主输入框；在输入框键入 `/` 可选择领地并发起常用任务，复杂技术信息放在展开详情中。
- 四类证据分别是治理事实（`GOVERNANCE_FACT`）、运行观察（`RUNTIME_OBSERVATION`）、执行者呈报（`WORKER_CLAIM`）与派生解释（`DERIVED_EXPLANATION`），不能压成一条“总体成功”。
- 日常主链是规划→指派→持久治理执行→呈报进入 `REVIEW`→Supervisor 裁决 `ACCEPT/REWORK/FAIL/HANDOFF`；持久路径失败不会自动降级到 `LEGACY_COMPAT`。
- Owner 专属动作始终不可执行（`executable=false / DIRECT_SLASH_REQUIRED`）。带状态 GET 需要有效本地控制 Cookie 或已配置 bearer；内部 `readContext` 来自 direct 激活时捕获的 Session，不接受浏览器自报，也不序列化到响应。
- 对 `GOVERNED_PERSISTENT`，暂停、恢复、终止当前都不可执行。合法生命周期候选在会话、Supervisor、scope、Host 与命令覆盖检查通过后，投影返回 `executable=false / GOVERNED_RUNTIME_CONTROL_UNAVAILABLE`；其他状态可能不列动作或先显示更早的拒绝原因。命令名称存在不代表可验证的 Runtime control seam 已实现。
- 未结算的持久治理 Execution 会在访问 Runtime/Session/Lease 前阻止新 attempt；对已有 Dispatch 关联的不可判定恢复路径，Dispatch、Lease、Execution 原子进入 `RECOVERING`，不改 Task、不自动重试或伪造终态。
- 事件与投影 payload 经过递归、有界脱敏，但这不是提交秘密的许可。
- 证据必须分层读取：静态源码/测试只是前置；fake Runtime、headless 浏览器、桌面真实连续交互、真实 DSH/Provider 是不同证据层级，不能互相替代。
> v1.0 GUI 的王国地图、管理中心、王国账本、任务→执行→审查、Authority 与恢复口径见
> [v1.0 GUI 快速开始](docs/v1.0/GUI_QUICK_START.md)。

---

## 🗺 路线图

| 版本 | 内容 | 状态 |
|---|---|---|
| 0.1.x | 王国基础：初始化/领地/角色绑定/重启恢复 | ✅ 已发布 |
| 0.2.x | 任务治理闭环：plan/assign/execute/review + **Claim ≠ Fact** | ✅ 已发布 |
| 0.3.x | 执行生命周期 + GUI 适配层 + 热插拔加固 | ✅ 已发布 |
| 0.4.x | **换届与会话归属**：unbind/bind_session、会话身份预留字段、session-bound 强制校验、init 引导 | ✅ 已发布 |
| 0.5.x | **领地删除**（拒绝优先 + force 级联 + 事件留痕）、GUI 删除控制、市场收录 | ✅ 已发布 |
| 0.8.0 | Persistent Governed Worker、Capability/Lease/Dispatch/Recovery | ✅ 已发布 |
| 0.9.0-alpha.1 | 内置可操作 GUI 最小闭环 | 本地源码阶段，尚未发布 |
| 1.0.0 | 王国地图、管理中心、王国账本、移交、沙箱与诚实的执行控制投影 | ✅ 当前版本 |

> 已发布版本与市场更新状态以 [Releases](https://github.com/lusblead/dsh-Kingdom/releases) 为准（发布流程见 [RELEASE.md](RELEASE.md)）。

---

## 📖 文档

- [v1.0 GUI 快速开始](docs/v1.0/GUI_QUICK_START.md) — 王国地图、管理中心、王国账本、任务→执行→审查、Authority 与恢复
- [LICENSE](LICENSE) — AGPL-3.0-or-later

## 🤝 参与贡献

欢迎提交 Issue / PR。开发环境需要 DSH checkout：

```bash
DSH_CHECKOUT=<checkout> bash scripts/build.sh   # 或手动 tsc
node scripts/p2-smoke.mjs                        # Phase 2 自测（81 断言）
node scripts/p3-smoke.mjs                        # Phase 3 自测（113 断言）
node scripts/hotplug-audit.mjs                   # 热插拔审计（27 断言）
npm pack                                         # 产出可分发 tgz
```

## 📜 许可证

[AGPL-3.0-or-later](LICENSE) © 2026 lusblead。v0.8.0 及更早版本保持其发布时的 BSD-3-Clause 许可。

---

<div align="center">

**Unofficial project, independently developed and maintained by community members.**

*DSH · Agent Kingdom · Multi-agent governance*

</div>
