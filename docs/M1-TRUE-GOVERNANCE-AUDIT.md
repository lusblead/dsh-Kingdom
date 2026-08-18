# M1 True Governance — 源码审计 + 对抗式负例实验报告

> 范围：dsh-kingdom v0.5.1（main @ 847c916，lib 为 0.5.1 正式安装产物）
> 方法：源码审计（G1–G4）+ 隔离库真实负例实验（node 直调正式安装 lib，`m1-audit.db` 用完即删，未触碰真实王国）
> 日期：2026-08-18
> 结论先行：**用户事前判断全部成立**——职权校验（requireRole）本身可靠，但①GUI 的 principal 是自报字段、②角色管理面（bind/unbind/bind_session）零调用者校验、③Worker Binding 完全不参与执行 Runtime 选择。

---

## 一、四个 Gate 结论总表

| Gate | 要解决的问题 | 审计结论 | 证据 |
|---|---|---|---|
| **G1 身份真实性** | 角色职权只能来自 DSH 实际 Session | ⚠️ **半边成立**：工具面 principal 来自 `exec.agent.session.id`（真实）；GUI 面 principal 来自 HTTP payload 自报 `session_id`（可伪造）。伪造链可走通：snapshot 暴露 binding.sessionId → GUI 伪造 → session-bound 下冒充 | §2.1 / §2.2 |
| **G2 管理权闭合** | 谁能任命/解绑/换届 | ❌ **未闭合**：bind_role / unbind_role / bind_session 三个工具无任何调用者校验；OWNER 仅受"不可解绑"保护。实验实证：任意调用者可改绑/解绑 CHANCELLOR、可自封 SUPERVISOR | §2.3 |
| **G3 Worker 执行真实性** | "Worker 属于哪个 Session/Model"到底是什么意思 | ❌ **语义不存在**：执行器 = `config.workerProvider`（全局配置）+ 调用者（Supervisor）的 `exec.agent` 派生 one-shot subagent；Worker Binding 的 session_id/model_name/session_meta/runtime_type **零参与**。`assigned_binding_id` 只是记录 | §2.4 |
| **G4 对抗式 E2E** | 正确调用 PASS、越权/伪造/旧任/换届后旧 Session 全 FAIL | 🔶 **职权层已实证**；管理面越权实证 FAIL（漏洞）；GUI 伪造全链待 session-bound 实例验收；真实多会话矩阵留到实现后 | §2.5 |

---

## 二、逐 Gate 证据

### 2.0 端到端实证（隔离 session-bound 实例，2026-08-18 补充）

在隔离 home（home-v051，`authMode: session-bound`、独立网关端口 34999）启动真实 DSH 实例后的完整攻击链实验：

| 用例 | 结果 | 证据 |
|---|---|---|
| E0 `POST /api/commands/init`（无鉴权，预期放行） | 放行 | `ok=true` |
| E1 `POST binding.bind`（无 principal，session-bound 模式） | **ALLOWED（漏洞）** | 成功绑定 CHANCELLOR→victim-session |
| E2 `POST plan` body `{session_id:"victim-session"}`（伪造） | **ALLOWED（漏洞）** | `errorCode=TERRITORY_MISSING`——已通过 requireRole，到达业务层 |
| E3 `POST plan` body `{session_id:"someone-else"}`（对照） | **DENY** | `UNAUTHORIZED_PRINCIPAL`（requireRole 本身正确） |
| E4 `GET /api/snapshot` | **泄露** | `bindings[].sessionId` 明文返回完整 id（`victim-session`） |

> 完整攻击链端到端成立：`GET /api/snapshot` 拿到 CHANCELLOR.sessionId → `POST plan` 伪造该 id → 职权校验放行。修复前 v0.5.1 在 session-bound 模式下可被任何能访问网关的人冒充 CHANCELLOR/SUPERVISOR。

---

## 二·补、逐 Gate 证据

### 2.1 G1 —— 工具面 principal 来源（可靠半边）

`src/index.ts:124-127`：

```ts
const sessionPrincipal = (exec: { agent?: { session?: { id?: string } } | null }): Principal | undefined => {
  const id = exec?.agent?.session?.id
  return typeof id === 'string' && id.length > 0 ? { sessionId: id } : undefined
}
```

- plan / assign / start / review 四个职权工具均经 `sessionPrincipal(exec)` 注入 principal，来源是 **DSH 运行时证明的调用方会话**。✓
- `requireRole`（`src/core/task-service.ts:126-158`）在 session-bound 下校验 `caller === binding.session_id`，binding 未绑 session 时拒绝（不猜）。✓

**实验（隔离库，session-bound 模式）**：

| 用例 | 结果 |
|---|---|
| B3a 真实 session 行使 CHANCELLOR | **PASS**（到达领地检查） |
| B3b 伪造/他人 session | **DENY**（`当前调用者不是 CHANCELLOR`） |
| B3c 无 principal（无法验证） | **DENY** |
| B4 换届后旧 Session | **DENY**（requireRole 语义正确） |
| B4b 新任 Session | **PASS** |

### 2.2 G1 —— GUI 面 principal 来源（可伪造半边，漏洞链）

`src/index.ts:645-648`（runGuiCommand）：

```ts
const principal: Principal | undefined = typeof payload.session_id === 'string'
  ? { sessionId: payload.session_id }
  : undefined
```

- GUI 的 `session_id` 是**浏览器自报字段**，不是 DSH 运行时证明。
- 放大链（完整攻击路径）：
  1. `GET /api/snapshot`（无鉴权读面）→ 返回 `bindings[].sessionId`（实测 snapshot 结构含该字段）；
  2. 攻击者拿到 SUPERVISOR 的 `session_id`；
  3. `POST /api/commands/review` body `{ session_id: <偷到的 id>, ... }` + `X-Kingdom-Client` 头（头值不校验，仅存在性检查，`server.ts:172-176`）；
  4. session-bound 模式下 `requireRole` 看到 `caller === binding.session_id` → **放行**。

> 结论：`requireRole` 无法区分 principal 是"DSH 证明的"还是"调用方声称的"。**信任必须建立在 principal 来源层，而不是 requireRole 层。**

### 2.3 G2 —— 角色管理面零校验（三个漏洞，全部实证）

`src/index.ts` 三个工具：`kingdom_bind_role`（257）、`kingdom_unbind_role`（294）、`kingdom_bind_session`（318）——execute 签名**均无 exec 参数**，不注入 principal，不经过 requireRole；直接调 `bindRole` / `unbindRole` / `rebindSession`（`src/core/binding.ts:71/137/176`）。

保护现状：`unbindRole` 仅拒绝解绑 OWNER（`binding.ts:147-149`）；**任命（bind）与改绑（bind_session）完全没有 OWNER 或任何管理面保护**。

**实验（隔离库）**：

| 用例 | 结果 | 含义 |
|---|---|---|
| B1 任意调用者 `rebindSession` 把 CHANCELLOR 改绑成自己声称的 session | **ALLOWED** | 任意会话可夺取 CHANCELLOR 席位 |
| B2 任意调用者 `unbindRole` 解绑 CHANCELLOR | **ALLOWED** | 任意会话可罢免 CHANCELLOR |
| B5 任意调用者 `bindRole` 自封 SUPERVISOR | **ALLOWED** | 任意会话可自封任何角色（除解绑 OWNER 外） |

**攻击链（用户判断确认）**：
```text
"你没有 Supervisor 权限"
        ↓
kingdom_bind_session(role_type=SUPERVISOR, session_id=<自己>)
        ↓
"现在我是了"
```

**附带发现（审计链失真）**：管理事件的 `actor_role` 记录的是**被操作角色的类型**（`binding.ts:110` ROLE_BOUND 的 actor_role=roleType、`actor_id: null`），不是实际操作者——事件流无法回答"谁任命了谁"。

### 2.4 G3 —— Worker Binding → Runtime 语义不存在

执行链全貌：

```text
组织身份：                        执行载体：
WORKER Binding                    Supervisor 当前 Agent（调用者 exec.agent）
    ↓                                     ↓
assigned_binding_id                DshSubagentExecutor
    ↓                                     ↓
（只写入任务行/事件，              subagents.start(config.workerProvider,
  不参与执行）                        { parent: exec.agent, ... })
```

证据：
- `src/index.ts:452-457`：`new DshSubagentExecutor({ subagents, provider: config.workerProvider || 'spawn', parent: exec.agent, signal })`——provider 是**全局配置**，parent 是**调用者（Supervisor）**；
- `src/worker/dsh-subagent.ts:107-128`：`subagents.start(provider, { label, prompt, parent, signal, outputSchema })`——**不读取 Worker binding 的任何字段**（session_id / model_name / session_meta / runtime_type 零参与）；
- `src/core/task-service.ts:307-326`：assignTask 校验并写入 `assigned_binding_id`，但 startTask 的 executor 由工具边界传入，与 binding 无关；
- execution 记录的 `session_id` 是 one-shot run.id（`dsh-subagent.ts:139`），**不是** Worker binding 的 session。

> 结论：当前"Worker 绑定 session/model"只是**角色席位元数据**（方案一的形态），却未在文档/界面上如实声明；`workerProvider` 全局生效意味着**所有 Worker 用同一 provider**，Supervisor 派给谁不影响谁来执行。

### 2.5 G4 —— 对抗矩阵现状

| 用例 | 期望 | 当前实测 |
|---|---|---|
| Chancellor → plan | PASS | ✓（工具面真实 session） |
| Chancellor → assign | DENY | ✓（requireRole SUPERVISOR） |
| Supervisor → assign/start/review | PASS | ✓（同 requireRole） |
| Supervisor → plan | DENY | ✓ |
| Worker → plan/assign/review | DENY | ✓ |
| 旧 Supervisor Session 换届后 → review | DENY | ✓（B4） |
| 任意普通 Session → rebind Supervisor to self | **DENY** | ❌ **ALLOWED（漏洞 B1）** |
| GUI → 伪造 session_id | **DENY** | ❌ **可伪造（§2.2 漏洞链，待 session-bound 实例全链验收）** |
| Worker Claim → DONE | IMPOSSIBLE | ✓（状态机 + 唯一写入通道） |

---

## 三、修复建议（按优先级；待用户裁决后进入实现）

### P0（堵住已实证的击穿点）
1. **管理面收口（G2）**：引入 **Owner / Trusted Governance Administration Plane**——
   - `kingdom_bind_role`：仅 OWNER 会话（session-bound 下 OWNER binding 的 session）可任命；declarative 模式保持现状但 snapshot 已如实标注 local-demo；
   - `kingdom_unbind_role` / `kingdom_bind_session`：同上，仅 OWNER（或 Owner 授权的管理员位）可罢免/改绑；
   - 事件 actor 修正：管理事件记录**实际操作者**（principal session），不再把被操作角色当 actor。

2. **GUI principal 来源（G1）**：网关层**禁止从 payload 信任 session_id**——两种可选：
   - a. GUI 写命令在 session-bound 模式下直接拒绝（"GUI 是本地可信演示通道，职权操作请到 DSH 会话"），或
   - b. 网关与 DSH 运行时打通（HTTP 请求带 DSH 签发的会话凭证，由插件向宿主验证）——较重构；
   - 推荐先做 a（诚实边界，与 `start` 的处理同风格），b 留作后续。

### P1（语义与文档）
3. **G3 裁决后落实 Binding→Runtime**（见第四节）或明确"方案一：Worker 是组织身份，session/model 为席位元数据"并在 README/GUI 如实声明。

### P2（审计链完整性）
4. 管理事件 actor 修正（并入 1）；5. snapshot 对 session_id 的暴露策略（GUI 是否必须看到完整 sessionId——可考虑脱敏）。

---

## 四、G3 设计裁决点（交用户）

用户已给出两种合法设计，审计结论支持其判断：

| | 方案一：Worker=组织身份 | 方案二：Binding→Runtime（用户推荐） |
|---|---|---|
| 执行载体 | 永远 one-shot，provider 全局 | one-shot 不变，但 runtime/model/provider 由 Binding 决定 |
| session_id/model_name 语义 | 席位元数据（需如实声明） | 执行配置（决定真实执行者） |
| Role≠Runtime≠Model≠Session | 成立（但 Runtime 是全局的） | 成立（Runtime 挂在 Binding 上） |
| 多 Worker 自然扩展 | 需要另引入 per-task runtime 参数 | 天然（Worker A→DeepSeek、B→GPT） |
| 工作量 | 小（文档/声明） | 中（Binding schema + executor 工厂 + 校验） |

**推荐**：方案二（与用户一致），要点：
- 保持"每个 attempt = 新 one-shot execution"（不复活长驻 Session）；
- Binding 扩展 `runtime/provider` 字段（session_meta 已留扩展槽，或新增显式列）；
- `startTask` 工具边界按 `assigned_binding_id` 查 binding → 构造对应 provider 的 executor；binding 未配置 runtime 时回退全局 `workerProvider`（兼容现有部署）；
- supervisor 校验不变；执行事件记录实际 provider/模型。

---

## 五、验收建议（实现完成后）

按用户 G4 矩阵做**真实多会话对抗式 E2E**：用 DSH HTTP API 派生 4 个独立会话（Owner/Chancellor/Supervisor/Worker + 1 个攻击者会话），session-bound 模式全矩阵跑一遍（正确路径 PASS + 越权/伪造/旧任/换届后旧 Session 全 FAIL），并补 GUI 伪造链的端到端否定实验。
