<div align="center">

# 🏰 dsh-Kingdom

**在 DeepSeek Harness 里，装一个插件，拥有一个自己的 Agent 王国。**

[![CI](https://github.com/lusblead/dsh-Kingdom/actions/workflows/ci.yml/badge.svg)](https://github.com/lusblead/dsh-Kingdom/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-3.3.0-blue)](docs/V3.3-RELEASE-NOTES.md)
[![License](https://img.shields.io/badge/license-AGPL--3.0--or--later-green)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.1.5--rc%20%7C%200.1.7--rc-orange)](#1-前置要求)
[![Node](https://img.shields.io/badge/Node-%3E%3D22.19-339933)](#1-前置要求)

</div>

---

## 这是什么？

**3.3.0 的日常工作台只有三个入口：运行总览、派发任务、主管设置。**先向 DSH 会话说明需求，再由 AI 核对实际任务、领地和角色。绑定或更换主管时，会话准备完整的人类管理窗口命令，你核对预览、确认并读回结果，无需编辑 JSON 或手查内部编号。先看 [当前使用指南](docs/CURRENT-USER-GUIDE.md) 和 [3.3 版本说明](docs/V3.3-RELEASE-NOTES.md)。

3.2.1 修复派发前关联、可靠接受回执与只读恢复对账，收紧受理/验收的换绑窗口，并明确资源占用后的重新请求要求。输入缺失仍为 UNKNOWN，不提供安全作废或自动重发。查看 [3.2.1 版本说明](docs/V3.2.1-RELEASE-NOTES.md)。

3.2.0 把**主管与领地完全绑定**：任命主管时必须同时指定它的领地，席位与领地主理在同一事务里原子写入（不再可能留下"有主管、没领地"的中间态）；一个领地至多一个在任主理，一个主管席位只主理一个领地；退任主管时同时解除其领地主理。同一版还修掉了交付记录区的版面塌陷。查看 [3.2 版本说明](docs/V3.2-RELEASE-NOTES.md)。

更早的 3.0.0 在 2.0 个人工作台之上加入 Owner 交付清单：逐条查看、知悉、核对主管确认的改动证据，并就具体条目向接受交付的主管提问。交付由 Owner 主动查看，宰相目前不会自动上报。查看 [3.0 使用指南](docs/V3.0-USER-GUIDE.md)、[版本说明与验证范围](docs/V3.0-RELEASE-NOTES.md) 和 [功能介绍](docs/DSH-KINGDOM-3.0-ANNOUNCEMENT.md)——3.0.0 的功能是随 3.1.0 一并发布的。已有任务、协作、用量与软预算能力见 [2.0 指南](docs/V2.0-USER-GUIDE.md)。

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
| 🚀 **随包交付** | 从官方 npm 或 GitHub 获取版本包；内置 GUI 随 `lib/**` 交付，无需独立前端 |
| 🧭 **三个日常入口**（3.3） | 运行总览查看任务、已登记会话、领地和状态；派发任务集中创建、指派与启动；主管设置由目标会话准备绑定或接替引导 |
| 🏛 **完整角色体系** | Owner / Chancellor / Supervisor / Worker，角色与 Session / 模型解耦 |
| 📋 **治理闭环语义** | 规划 → 分配 → 独立执行 → 验收，任务状态全程留痕 |
| ⚖️ **Claim ≠ Fact** | **Worker 说自己完成了 ≠ 任务完成**——完成权只在 Supervisor，代码强制，不是口头约定 |
| 🧭 **主管与领地完全绑定**（3.2） | 任命主管必须同时指定它的领地，席位与领地主理**同一事务**原子写入；一个领地至多一个在任主理，一个主管只主理一个领地；退任主管时同时解除其领地主理。存量"未隶属领地"的席位不会被自动归属，只在界面上标注待处理 |
| 👁️ **Owner 逐条知悉与提问**（3.0） | 交付摘要和细项独立呈现；知悉只记录 Owner 声明已知道该内容版本，不代替质量认可或任务完成；问题记在接受该交付的主管名下，待其主动读取并回复 |
| 🧾 **改动证据**（3.0） | 主管确认属于本交付的文件改动可展开查看，包括有界的未提交差异快照；标明证据级别，不把 Git 时间窗口误称为 Worker 作者证明 |
| 👷 **Persistent Governed Worker** | canonical headless 路径使用 `kingdom_start_task_governed`：Worker 绑定长期 DSH Session，结果结构化返回并经 Capability/Lease 治理 |
| 🔁 **返工留痕** | governed REWORK 复用同一 Worker Persistent Session；每次尝试（attempt）都有独立 Lease/Execution 记录 |
| 💾 **持久化与恢复语义** | 状态写入本地 SQLite；无法确认原执行时保持恢复核对，由主管先对账，不自动重发 |
| 🔄 **换届与会话归属**（v0.4） | `kingdom_unbind_role` 解绑 / `kingdom_bind_session` 把角色绑到**独立会话**；`session-bound` 模式下只有被绑定会话能行使职权 |
| 🪪 **会话身份预留字段**（v0.4） | 角色可携带 `model_name` / `agent_name` / `session_meta`（JSON 扩展槽）——现在不必填，未来完整会话逐步填满 |
| 🎛 **内置本地 GUI**（v1.0） | 直接执行 `/kingdom gui` 打开操作台，进行会话绑定的任务规划、指派、持久治理执行与审查；Owner 配置由人类直接命令或准确激活的管理窗口确认 |
| 👑 **Persistent Governed Worker**（v0.8） | Worker 拥有**长期 DSH Session**（REWORK 唤醒同一 Worker）；Session ↔ Territory Affinity 不可改绑；每次执行经 **Capability Gate**（仅 GRANTED+ENFORCED 才 dispatch，Runtime 无法 enforce → **DENIED + zero execution**）；**Execution Lease** 互斥 + **Dispatch Intent**（crash 可 reconcile，不盲发）；terminal 证据来自事件链，**Runtime 跑完 ≠ Task DONE**（Claim → Supervisor 裁定链不变）。这是 canonical headless 路径 |
| 🛡️ **Fail-closed 能力治理**（v0.8） | 无自授 / 超 Ceiling / scope 外 / 部分 policy 一律拒绝；approval=never 禁扩权；workspace 外写真实拒绝；RECOVERING 状态如实显示，禁止显示成 Done |
| 🧩 **Legacy 兼容**（v0.8） | `kingdom_start_task` 仅在用户明确选择时作为 `LEGACY_COMPAT` one-shot 入口；不会作为默认路径、错误恢复建议或 persistent 失败 fallback |

---

## 🚀 快速开始

### 1. 前置要求

- **DeepSeek Harness（dsh）**：本版 peer 声明与 3.1.0 相同，覆盖 `0.1.5-rc` 与 `0.1.7-0` 两条线；构建与回归在 CLI `0.1.5-rc.1` / 主要组件 `0.1.5-rc.2` 上完成。`0.1.7-rc.2` 的实机加载在 3.1.0 已验证（无 bundle 跳过，见 [3.1 版本说明](docs/V3.1-RELEASE-NOTES.md)）；**完整宿主和真人交互验收须以各版记录为准**（peer 声明未变，但不要把它当作已验证）。旧宿主请继续使用对应旧版插件
- **Node.js** ≥ `22.19`（内置 SQLite，插件零原生依赖）
- 一个可用的模型 API key（Worker 执行需要）

### 2. 安装 v3.3.0

从官方 [npm 3.3.0](https://www.npmjs.com/package/dsh-kingdom/v/3.3.0) 获取准确版本包，再安装到自己的 DSH Web profile：

```bash
npm pack dsh-kingdom@3.3.0 --registry=https://registry.npmjs.org
dsh plugin --profile web add ./dsh-kingdom-3.3.0.tgz
```

也可从 [GitHub v3.3.0 Release](https://github.com/lusblead/dsh-Kingdom/releases/tag/v3.3.0) 下载同名 tgz，执行第二条命令。安装或升级后重启原 Web profile，才会加载新包；使用其他 profile 时替换 `web`。升级前先核对未决执行并一致备份 SQLite。

内置 GUI 随 `lib/**` 包含在 tgz 中，不需要额外 GUI zip：

```bash
/kingdom gui       # 激活短期本地控制会话并打开内置操作台
/kingdom status    # 也可以从 DSH 会话查看王国真实状态
```

Owner 是本机人类操作者，不是 Agent 或 Session。管理操作可由用户直接键入
exact `/kingdom` Slash，或从 `/kingdom owner.gui` 准确激活的独立短时管理窗口完成；`OWNER.session_id` 永远保持 `null`。Chancellor、Supervisor、
Worker 才使用真实 DSH caller session 的会话绑定（`session-bound`）角色平面；历史
`declarative / local-demo` 语义不能解锁产品写入。

### 3. 用 GUI 完成最小治理闭环

先向 DSH 会话里的 AI 说明需求，完整步骤见 [当前使用指南](docs/CURRENT-USER-GUIDE.md)。历史版本指南保留供对应安装包参考。

1. 向 AI 说：“帮我查看 dsh-Kingdom 当前的王国、领地、角色和任务；先说明缺少哪些配置，再逐项引导我确认。”已有配置就继续使用；缺少配置时，由会话准备准确输入并说明人类确认步骤。
2. 在本地 DSH 会话直接键入 exact `/kingdom gui`；若本机浏览器完成带 ticket 的导航，一次性入口兑换后会重定向到干净的 `/console`。若本机打开请求失败，控制会话虽已激活，但命令只显示不含 ticket 的干净 `/console` 参考地址；该地址不能完成一次性兑换，不要手工拼接或复用启动值，直接重新执行 `/kingdom gui`。
3. **运行总览**查看任务、已登记会话、领地和状态；**派发任务**集中创建、指派与启动；**主管设置**复制绑定或更换请求，再到希望接任的会话交给 AI 引导。宰相会话创建任务，任务领地的主管会话指派、启动和审查。网页选择名称不会切换身份；切换会话后从该会话重新打开工作台。
4. Worker 输出只会进入待审状态 `REVIEW`。Supervisor 选择接受 `ACCEPT` 后才进入 `DONE`；返工 `REWORK` 回到 `RUNNING` 并保留同一 Assignment，判定失败 `FAIL` 进入 `FAILED`。不用时执行 `/kingdom gui stop` 撤销控制会话并关闭本地 server。

绑定主管可直接向目标会话说“让当前会话负责「前端」”；更换时说“把「前端」主管换成当前会话”。AI 准备完整窗口命令，你直接复制执行，打开链接、核对预览并确认，成功后再读回绑定。更换沿用原席位；如果该席位关联多个领地，引导会列出全部影响，确认后这些领地会一起由新会话负责。只想接替其中一个时停止确认，先让会话说明调整安排。

Owner 专属 JSON Slash 命令只接受单个 object envelope；未知字段、额外 token、重复字段和
`OWNER.session_id` 改绑会在写入前拒绝。独立 GUI/HTTP 不能自行取得 Authority；只有 direct
`/kingdom gui` 激活闭包内的短期控制会话才可能执行日常角色操作，浏览器 payload 不能提交
principal/session/Owner capability。

---

## 🛠 高级工具参考

日常先向会话说明需求，不需要记住下表。工具调用仍受真实会话角色和领地范围检查；会话准备人类管理操作时使用只读引导工具，不自动取得 Owner 权限。

| 阶段 | 工具 |
|---|---|
| 王国基础 | **`/kingdom init`**（Owner direct）· `kingdom_status`（只读） |
| 领地 | **`/kingdom territory.* <JSON>`**（Owner direct）· `kingdom_list_territories`（只读） |
| 角色 | **`/kingdom role.* <JSON>`**（Owner direct）· `kingdom_list_bindings`（只读） |
| 会话引导 | `kingdom_draft_owner_binding_intent`（只读准备绑定或接替步骤，不写入） |
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

全新库或尚无王国数据的库可直接建立 v4；已有 v3 库默认保持 v3，不会自动迁移。只有经过 Formal DB Migration Gate 明确放行后才可迁移；未迁移时 GUI governed plan 与 governed start 均 fail-closed。正式用户数据库迁移未在本版验证（`NOT_RUN`），不能据此声称任意旧库兼容或迁移通过。

---

## 🎛 GUI（王国操作台）

GUI 已内置在插件中，不需要下载或启动第二个前端项目。直接在本地 DSH 会话执行：

```text
/kingdom gui
```

插件只绑定 `127.0.0.1`，按实际监听端口生成一次性短期启动值，并请求本机浏览器打开 Console。启动值只兑换一次，随后重定向到干净的 `/console`；写请求还须通过 HttpOnly `SameSite=Strict` Cookie、CSRF、唯一 request id、精确 Origin 与单一在途请求检查。GUI/HTTP 本身没有 Authority，也不能构造 Owner 或角色身份。

### 操作台能力

- 3.3.0 默认进入“运行总览”，按任务与当前登记会话分别展示领地和状态；另有“派发任务”“主管设置”两个主入口，操作步骤见 [当前使用指南](docs/CURRENT-USER-GUIDE.md)。
- 王国地图、用量与账本保留为高级入口；四种主题和现有角色视觉保留。任务详情继续区分治理状态、执行观察和执行者自述；未提供会话运行观测时显示未知。
- 四类证据分别是治理事实（`GOVERNANCE_FACT`）、运行观察（`RUNTIME_OBSERVATION`）、执行者呈报（`WORKER_CLAIM`）与派生解释（`DERIVED_EXPLANATION`），不能压成一条“总体成功”。
- 日常主链是规划→指派→持久治理执行→呈报进入 `REVIEW`→Supervisor 裁决 `ACCEPT/REWORK/FAIL/HANDOFF`；持久路径失败不会自动降级到 `LEGACY_COMPAT`。
- 日常工作台中的 Owner 写入动作不直接执行（`executable=false / DIRECT_SLASH_REQUIRED`）；人类配置通过准确激活的独立管理窗口预览、确认。带状态 GET 需要有效本地控制 Cookie 或已配置 bearer；内部 `readContext` 来自 direct 激活时捕获的 Session，不接受浏览器自报，也不序列化到响应。
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
| 1.0.0 | 王国地图、管理中心、王国账本、移交、沙箱与诚实的执行控制投影 | ✅ 已发布 |
| 2.0.0 | 个人工作台、人类管理窗口、有界协作、用量与软预算、恢复约束 | 上一版本；发布状态以 Releases 为准 |
| 3.0.0 | Owner 交付清单、逐条知悉、主管确认的改动证据、条目问答 | 随 3.1.0 一并发布 |
| 3.1.0 | DSH 0.1.7 兼容（peer 分线声明）、无 live Agent 会话可绑定席位、`session_evidence` 证据字段 | ✅ 已发布，然后是 3.2.0 |
| 3.2.0 | 主管与领地完全绑定、交付区版面修复 | 已发布 |
| 3.2.1 | 单次派发关联、可靠 Receipt、只读恢复对账、事务授权与占用诊断修复 | 发布状态见 [Releases](https://github.com/lusblead/dsh-Kingdom/releases) 与 npm |
| 3.3.0 | 三个日常入口、任务/会话运行总览、集中派发、会话引导绑定与接替主管 | [GitHub](https://github.com/lusblead/dsh-Kingdom/releases/tag/v3.3.0) · [npm](https://www.npmjs.com/package/dsh-kingdom/v/3.3.0) |

> 已发布版本与市场更新状态以 [Releases](https://github.com/lusblead/dsh-Kingdom/releases) 为准（发布流程见 [RELEASE.md](RELEASE.md)）。

---

## 📖 文档

- [当前使用指南](docs/CURRENT-USER-GUIDE.md) — 3.3.0 三个日常入口、会话引导绑定/更换主管与派发步骤
- [3.3 版本说明](docs/V3.3-RELEASE-NOTES.md) — 简化工作台、会话引导和实际验证范围
- [3.2.1 版本说明](docs/V3.2.1-RELEASE-NOTES.md) — 派发关联、可靠 Receipt、只读恢复对账与事务授权修复
- [3.2 版本说明](docs/V3.2-RELEASE-NOTES.md) — 主管与领地完全绑定、原子写入与退任联动、交付区版面修复
- [3.1 版本说明](docs/V3.1-RELEASE-NOTES.md) — DSH 0.1.7 兼容范围与无 live Agent 会话的席位绑定
- [3.0 使用指南](docs/V3.0-USER-GUIDE.md) — 交付清单、知悉、查看改动与条目问答
- [3.0 版本说明](docs/V3.0-RELEASE-NOTES.md) — 新增内容及实际验证范围
- [3.0 功能介绍](docs/DSH-KINGDOM-3.0-ANNOUNCEMENT.md) — 面向使用者的文章草稿
- [2.0 使用指南](docs/V2.0-USER-GUIDE.md) — 上一版本的日常任务、协作与恢复
- [v1.0 GUI 快速开始](docs/v1.0/GUI_QUICK_START.md) — 历史版本参考
- [LICENSE](LICENSE) — AGPL-3.0-or-later

## 🤝 参与贡献

欢迎提交 Issue / PR。克隆源码后安装锁定依赖并构建；单元测试使用隔离夹具，不读取个人数据库或调用付费模型：

```bash
npm ci --registry=https://registry.npmjs.org
npm run typecheck
npm test
node scripts/p2-smoke.mjs        # 当前治理与恢复测试
node scripts/p3-smoke.mjs        # 当前 GUI 与人类管理窗口测试
node scripts/hotplug-audit.mjs   # 服务释放、撤销与恢复测试
npm pack                       # 从当前源码重新构建并打包
```

## 📜 许可证

[AGPL-3.0-or-later](LICENSE) © 2026 lusblead。v0.8.0 及更早版本保持其发布时的 BSD-3-Clause 许可。

---

<div align="center">

**Unofficial project, independently developed and maintained by community members.**

*DSH · Agent Kingdom · Multi-agent governance*

</div>
