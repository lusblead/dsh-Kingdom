<div align="center">

# 🏰 dsh-Kingdom

**在 DeepSeek Harness 里，装一个插件，拥有一个自己的 Agent 王国。**

[![CI](https://github.com/lusblead/dsh-Kingdom/actions/workflows/ci.yml/badge.svg)](https://github.com/lusblead/dsh-Kingdom/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.7.0-blue)](https://github.com/lusblead/dsh-Kingdom/releases)
[![License](https://img.shields.io/badge/license-BSD--3--Clause-green)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.1.0--rc.5-orange)](#compatibility)
[![Node](https://img.shields.io/badge/Node-%3E%3D22.19-339933)](#requirements)

</div>

---

## 这是什么？

**dsh-Kingdom 是一个 DeepSeek Harness（DSH）插件**：安装后，你不需要部署任何服务、数据库或 GUI，直接在 DSH 会话里用自然语言就能**创建并运行一个属于自己的最小王国**——

```text
你：初始化王国
DSH：已创建王国「My Kingdom」，你成为 Owner

你：给当前项目建一个 RAG 研发领
DSH：已创建领地「RAG 研发领」

你：让 Chancellor 把"检查测试情况"规划成任务，Supervisor 派给 Worker 执行，然后验收
DSH：任务 CREATED → ASSIGNED → RUNNING → REVIEW → DONE ✅
```

**王国是真实的**：角色、领地、任务、验收记录全部持久化在本地，重启 DSH 也不会消失。

---

## ✨ 核心特性

| 特性 | 说明 |
|---|---|
| 🚀 **零门槛安装** | 一个 tgz + 一条命令，无需 bash / tsc / 外部服务 / GUI |
| 🏛 **完整角色体系** | Owner / Chancellor / Supervisor / Worker，角色与 Session / 模型解耦 |
| 📋 **真实治理闭环** | 规划 → 分配 → 独立执行 → 验收，任务状态全程留痕 |
| ⚖️ **Claim ≠ Fact** | **Worker 说自己完成了 ≠ 任务完成**——完成权只在 Supervisor，代码强制，不是口头约定 |
| 👷 **Worker 独立执行** | 每次执行在独立 DSH 会话（one-shot subagent）进行，结果结构化返回 |
| 🔁 **返工留痕** | REWORK 后同一 Worker 新会话重做，每次尝试（attempt）都有记录 |
| 💾 **重启恢复** | 全部状态存本地 SQLite，关掉 DSH 再开，王国原样还在 |
| 🔄 **换届与会话归属**（v0.4） | `kingdom_unbind_role` 解绑 / `kingdom_bind_session` 把角色绑到**独立会话**；`session-bound` 模式下只有被绑定会话能行使职权 |
| 🪪 **会话身份预留字段**（v0.4） | 角色可携带 `model_name` / `agent_name` / `session_meta`（JSON 扩展槽）——现在不必填，未来完整会话逐步填满 |
| 🎭 **GUI 就绪**（可选） | 结构化快照 + 本地数据网关（默认关闭），前端页面由 GUI 部署方提供 |

---

## 🚀 快速开始

### 1. 前置要求

- **DeepSeek Harness（dsh）** ≥ `0.1.0-rc.5`
- **Node.js** ≥ `22.19`（内置 SQLite，插件零原生依赖）
- 一个可用的模型 API key（Worker 执行需要）

### 2. 安装

**方式 A：npm（推荐）**

```bash
dsh plugin --profile web add dsh-kingdom
```

**方式 B：从 GitHub Releases 下载 tgz**

从 [Releases](https://github.com/lusblead/dsh-Kingdom/releases) 下载 `dsh-kingdom-0.7.0.tgz`，然后：

```bash
dsh plugin --profile web add ./dsh-kingdom-0.7.0.tgz
```

> 安装时会打印 5 条 peer dependency warning——**这是预期的**（这些包由 DSH 运行时提供），不是失败。
> 判断安装成功：**重启 DSH 后** `/kingdom status` 能返回真实状态。

重启 DSH，插件自动加载。开始使用：

```bash
/kingdom init      # 初始化或接入本地王国（幂等）
/kingdom status    # 查看王国真实状态
```

### 3. 30 秒体验一个王国

```
你：初始化王国
你：给当前项目创建一个 RAG 研发领
你：任命一个 Chancellor 和 Supervisor，绑定一个 Worker
你：让 Chancellor 规划"检查测试情况"为任务，Supervisor 派给 Worker
你：开始执行任务
你：验收任务（ACCEPT / REWORK / FAIL）
你：王国现在什么情况？
```

每一步都用自然语言，模型自动调用对应的 `kingdom_*` 工具完成真实写入。

---

## 🛠 工具一览

| 阶段 | 工具 |
|---|---|
| 王国基础 | `kingdom_init` · `kingdom_status` |
| 领地 | `kingdom_create_territory` · `kingdom_list_territories` · `kingdom_delete_territory` |
| 角色 | `kingdom_bind_role` · `kingdom_unbind_role` · `kingdom_bind_session` · `kingdom_list_bindings` |
| 任务治理 | `kingdom_plan_task` · `kingdom_assign_task` · `kingdom_start_task` · `kingdom_review_task` · `kingdom_list_tasks` |
| 执行控制 | `kingdom_execution_control` |
| GUI（可选） | `kingdom_snapshot` · `kingdom_task_detail` |

> **领地删除（v0.5.1）**：`kingdom_delete_territory`（网关 `territory.delete`、GUI 操作台删除按钮）遵循治理语义——
> 领地下存在任务（任意状态）时**默认拒绝**；传 `force=true` 才级联删除：未终态任务统一标记 `FAILED`、
> 活跃执行终止，`TERRITORY_DELETED` / `TASK_FAILED` 事件留痕；`DONE`/`FAILED` 终态任务不篡改。

---

## 🧠 它如何保证"治理是真的"？

这是 dsh-Kingdom 与其他 Agent 编排工具最根本的区别：

```text
Worker 交回结果 ──→ 这是一条 Claim（自述），只进 REVIEW
                        ↓
               Supervisor ACCEPT ──→ DONE（组织事实）
               Supervisor REWORK ──→ 返工（同 Worker 新会话）
               Supervisor FAIL   ──→ FAILED（组织事实）
```

- **Worker 没有"完成"的权力**：它没有上报结果的工具，结果经宿主接收后落库，任务永远停在 `REVIEW`。
- **没有任何工具能把任务直接置为 DONE**——DONE 唯一入口是 Supervisor 的 ACCEPT。
- **即使是 Worker 自称失败**，任务也只到 REVIEW；FAILED 只能是 Supervisor 裁定，或宿主观察到执行器客观失败（启动失败/异常退出）。
- 每次执行（attempt）都记入 `worker_results`，返工历史完整可查。

> **一句话：模型可以提出动作，但只有程序决定状态。**

---

## 📁 数据与存储

| 路径 | 说明 |
|---|---|
| `~/.dsh/kingdom/kingdom.db` | 王国全部数据（SQLite，自包含） |
| 7 张表 | kingdoms · territories · role_bindings · tasks · worker_results · executions · events |

每一版升级都是**零 migration**——旧库打开即自动收敛，数据不丢。

---

## 🎛 GUI（王国操作台，可选）

GUI 是**独立的前端**，与插件的**后端数据网关**分离：

| 角色 | 地址 | 用途 |
|---|---|---|
| 前端页面 | **本地自托管**：Release 附带的 `dsh-kingdom-gui-*.zip`（解压后 `cd server && npx wrangler dev`，浏览器打开提示的地址）；开发时可 `vite dev` | 你打开的页面 |
| 后端数据网关 | `http://127.0.0.1:<guiPort>`（仅本机回环） | 填进**前端页面的连接框**，不要当页面打开 |

> **前端是纯本地组件**：界面、网关、数据全部在你自己的机器上，不需要任何云端服务。
> （早期实验性的云端页面 `agent-governance-ui.luyus704.chatgpt.site` 已停止维护，不再提供。）

### 三步用上 GUI（含"没有 GUI"的解法）

1. **开网关**：在 profile 的 `cordis.patch.yml` 为 dsh-kingdom 配置端口（整段替换，需重复默认键）：

```yaml
- id: dsh-kingdom
  name: dsh-kingdom
  config:
    kingdomName: My Kingdom
    ownerName: ""
    workerProvider: spawn
    guiPort: 34817        # 0=关闭（默认）；只绑 127.0.0.1
    guiToken: ""          # 可选：设置后请求需 Authorization: Bearer
    guiAllowOrigins:
      - "*"
    authMode: declarative
```

2. **重启 DSH**（让 guiPort 生效；`/kingdom help` 会显示网关地址）。
3. **本地打开前端页面**：从 [Releases](https://github.com/lusblead/dsh-Kingdom/releases) 下载 `dsh-kingdom-gui-*.zip` → 解压 → 在 `server` 目录运行 `npx wrangler dev` → 浏览器打开提示的地址（默认 `http://localhost:8787`）→ 连接框填入 `http://127.0.0.1:34817` → 看到王国与操作台。

> 默认安装**没有 GUI 是预期的**（`guiPort=0` 关闭、前端独立分发）：agent 说"没有 GUI"时，
> 按上面三步开启即可。整个过程在本地完成，离线/内网环境同样可用（Release 自带 prebuilt-dist，无需联网下载前端）。

### 操作台能力

- 读面：Snapshot / 任务详情 / 事件流（每 2.5s 轮询，revision 防回退）；
- 写面（经网关执行，非演示预览）：初始化王国、创建/删除领地（含级联语义确认）、绑定/解绑/换会话（含 model/agent 身份）、规划任务、派发、验收 ACCEPT/REWORK/FAIL、执行暂停/恢复/终止；
- 写命令要求 `X-Kingdom-Client` 头（CORS 预检，防简单表单式 CSRF）；
- **`start` 保持诚实边界**：启动 Worker 需要活的委派父 Agent，只能在 DSH 会话内用 `kingdom_start_task` 触发，GUI 不伪造执行；
- 鉴权强度由快照 `auth.trustLevel` 如实声明（`local-demo` / `session-verified`），GUI 必须展示。

---

## 🗺 路线图

| 版本 | 内容 | 状态 |
|---|---|---|
| 0.1.x | 王国基础：初始化/领地/角色绑定/重启恢复 | ✅ 已发布 |
| 0.2.x | 任务治理闭环：plan/assign/execute/review + **Claim ≠ Fact** | ✅ 已发布 |
| 0.3.x | 执行生命周期 + GUI 适配层 + 热插拔加固 | ✅ 已发布 |
| 0.4.x | **换届与会话归属**：unbind/bind_session、会话身份预留字段、session-bound 强制校验、init 引导 | ✅ 已发布 |
| 0.5.x | **领地删除**（拒绝优先 + force 级联 + 事件留痕）、GUI 删除控制、市场收录 | ✅ 已发布 |
| 未来 | 多 Worker、Handoff、GUI 正式版、完整治理后端 | 🚧 规划中 |

> 已安装用户经 dsh-market 自动看到新版本（Update available）；每个版本的发布说明见 [Releases](https://github.com/lusblead/dsh-Kingdom/releases)（发布流水线见 [RELEASE.md](RELEASE.md)）。

---

## 📖 文档

- [LICENSE](LICENSE) — BSD-3-Clause

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

[BSD-3-Clause](LICENSE) © 2026 lusblead

---

<div align="center">

**Unofficial project, independently developed and maintained by community members.**

*DSH · Agent Kingdom · Multi-agent governance*

</div>
