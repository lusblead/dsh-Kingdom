# dsh-Kingdom - AI 项目经验簿

> 目的：维护当前项目中已经验证、能够直接改变未来 Agent 行动的工程经验。
>
> 本文档不是任务日志。按主题维护当前正确认识；历史变化由版本控制保存。
> 当前项目事实优先于全局经验库中的通用规则。

> 本检出（`D:\dsh\kingdom`，dsh 插件实现区）与 `D:\dsh-Kingdom` 检出（Adapter 边界/文档区）
> 共享同一项目 ID（`dsh-kingdom`）与同一份中心手册。实现类 PX 以本检出为准。

- 项目 ID：`dsh-kingdom`
- 项目类型：``agent-system`、`infrastructure-automation``
- 人类工程经验库：`C:\Users\ADMIN\Documents\Obsidian Vault\工程实践经验`
- 文档状态：active
- 创建日期：2026-08-17
- 最近整理：2026-08-17

## 工作区地图（2026-08-17 时点）

- 插件源码：`D:\dsh\kingdom\src`（编译产物 `lib/`，发布 `dsh-external-dsh-kingdom-<ver>.tgz`）
- 施工/审计任务书：`D:\dsh\research\Phase*-*.md`（属 `governor-records` 项目检出）
- DSH checkout（构建 + API 依据）：`D:\deepseek-harness`
- 当前版本：0.2.0（Phase 2 治理闭环，独立审计 PASS，无 P0/P1）

## 0. 快速索引

| ID | 主题 | 触发信号 | 作用域 | 状态 | 最后验证 |
|---|---|---|---|---|---|
| `PX-ARCH-001` | Worker Claim 与 Task Fact 必须分表且由第三方裁定 | 修改任务完成/失败判定、Worker 结果回收 | `src/core/task-service.ts`、`worker_results`、`tasks.status` | active | 2026-08-17 |
| `PX-DATA-001` | `tasks.status` 唯一写入路径 = `transitionTask` | 新增任何改任务状态的代码路径 | `src/core/db.ts`、`src/core/task.ts` | active | 2026-08-17 |
| `PX-DATA-002` | 幂等 DDL 做零迁移；不给 `schema_version` 造假 gate | 增删表/索引、考虑 migration | `SCHEMA_SQL`、`kingdoms.schema_version` | active | 2026-08-17 |
| `PX-TOOL-001` | dsh outputSchema 必须过宿主真实校验器 | 写 subagent outputSchema / 工具 schema | `src/worker/executor.ts` | active | 2026-08-17 |
| `PX-TOOL-002` | 结构化声明宿主服务面，避免新增 peer 与类型泄漏 | 调用 `ctx.<service>` 且不想加 peer 依赖 | `src/worker/dsh-subagent.ts`、`package.json` | active | 2026-08-17 |
| `PX-TEST-001` | 治理状态机用假 Executor 离线验证（无需模型 key） | 验收 Task 闭环 / 无 API key 环境 | `scripts/p2-smoke.mjs` | active | 2026-08-17 |
| `PX-OPS-001` | dev profile symlink 使「构建」= 向运行中的 DSH 发布 | 在 DSH 运行时执行 `tsc`/改 `lib/` | `~/.dsh/profiles/web/node_modules/@dsh-external/dsh-kingdom` | active | 2026-08-17 |
| `PX-WF-001` | 经 DSH HTTP API 开独立审计会话并取回结论 | 需要不共享上下文的独立审查 | `D:\dsh\research\run-phase2-audit.mjs` | active | 2026-08-17 |
| `PX-TEST-002` | 真实 spawn provider 端到端链路（NOT_RUN） | 拿到模型 API key 后 | `src/worker/dsh-subagent.ts` | candidate | 2026-08-17 |

## 1. 项目不变量与高优先级约束

记录无论并发、重试、故障或发布如何发生，都必须成立的项目级事实。每条使用稳定 `PX-*` ID。

### PX-ARCH-001：Worker Claim 与 Task Fact 必须分表，且只有第三方能把 Claim 变成 Fact

- 状态：active
- 证据等级：direct
- 作用域：`src/core/task-service.ts`、`src/core/task.ts`、表 `worker_results`、`tasks.status`
- 触发条件：修改任务完成/失败判定、Worker 结果回收路径，或新增"让执行者上报结果"的工具
- 标签：`claim-vs-fact`、`state-machine`、`multi-agent`、`acceptance`
- 最后验证：2026-08-17

#### 问题与识别信号

- 现象：让 Worker（子 Agent）自述"我做完了"就把任务标 DONE，组织层失去对完成事实的控制。
- 识别信号：状态机里存在 `RUNNING → DONE`；或执行结果结构体里的 `outcome` 字段被直接用来选择目标状态。

#### 根因

Worker 的输出是**自述**（Claim），不是**组织事实**（Fact）。二者一旦共用一张表/一个字段，
"谁有权宣布完成"这个治理问题就被悄悄降级成了"谁先写入"。

#### 当前项目的正确做法

1. Claim 落 `worker_results`（每 attempt 一行，`UNIQUE(task_id, attempt_no)`），
   **不**改变 `tasks.status` 的终态语义；Claim 到达只把任务推到 `REVIEW`。
2. `outcome`（COMPLETED/FAILED/BLOCKED）只是被忠实记录的自述，**不参与任何自动状态决策**。
3. 唯一能产生 `DONE` 的路径是 `REVIEW` + Supervisor `ACCEPT`（`kingdom_review_task`）。
4. **关键的反直觉点**：Worker 自称 `FAILED` 也只到 `REVIEW`——自述失败同样只是 Claim；
   只有 Supervisor 的 `FAIL` 裁定才产生 `FAILED` 这个组织事实。
5. 唯一的例外方向是**宿主观察到的运行事实**：executor 启动失败 / `stopReason != completed` /
   未交出满足 outputSchema 的结果 → Core 直接 `RUNNING → FAILED` + `WORKER_EXECUTION_FAILED`，
   且**不落** `worker_results`（没有合法 Claim 就没有 Claim）。
6. Worker 没有任何"上报结果"的工具面。它是 one-shot subagent，结果经 `outputSchema`
   由宿主接收后落库——它在结构上就够不到 Task 状态。

#### 最短安全路径

- 诊断捷径：`grep -rn "'DONE'" src/core/` 看有没有 review 之外的路径产生 DONE。
- 快速验证：`node scripts/p2-smoke.mjs` 的 C/E/F 三节。
- 完整验证：断言 Worker 返回 `COMPLETED` 后 `store.getTask(id).status === 'REVIEW'` 且 `!== 'DONE'`；
  再断言 Worker 返回 `FAILED` 后仍是 `REVIEW`。

#### 避免与失败方法

- 不要用 `if (result.outcome === 'COMPLETED') → DONE`，这等于把裁定权交还给被裁定者。
- 不要因为"Worker 都说失败了"就自动 FAILED；那会让 Worker 单方面终结任务、逃避审查。
- 不要给 Worker 加 `report_result` 工具：一旦它能调工具，它就能触达状态。

#### 正确性条件与适用边界

- 必须成立：审查者与执行者是不同角色；宿主能独立观察 executor 的运行结果。
- 不适用：低风险、可重算、无组织问责的自动化步骤（此时 Claim 即 Fact 是可接受的简化）。

#### 可复用资产与证据

- 代码：`src/core/task-service.ts`（`startTask` 只有 REVIEW / FAILED 两种结局）
- 测试：`scripts/p2-smoke.mjs` C 组 5 项 + E 组 8 项
- 证据：独立审计（DSH 会话 `session-30ef144f`）PASS，静态审查第 3 项确认无 `RUNNING→DONE` 路径

#### 关联

- 项目工程章节：`EL-GOVERNANCE-001`
- 全局工程经验：`GX-AGENTSYSTEM-CLAIMFACT-001`

## 2. 标准工作流与安全捷径

记录经过验证的诊断、实现和验证路径。捷径必须包含安全条件与完整验证。

### PX-WF-001：经 DSH HTTP API 开一个不共享上下文的独立审计会话

- 状态：active
- 证据等级：direct
- 作用域：`http://127.0.0.1:3080/api/*`、`D:\dsh\research\run-phase2-audit.mjs`
- 触发条件：需要一个不继承当前会话上下文的独立审查者来复核自己的产出
- 标签：`dsh-api`、`independent-review`、`orchestration`
- 最后验证：2026-08-17

#### 当前项目的正确做法

1. wire 格式：POST `/api/<dotted.method>`，body
   `{type:'client-request', rpcId, method, payload}`；响应 `{result:{ok, value|error}}`。
2. `session.create {cwd}` → `session.prompt {sessionId, mode:'queue', content:[{type:'text',text}]}`
   → 轮询 `session.history {sessionId, maxMessages}`。
3. **`cwd` 要覆盖审计需要读到的全部目录**。审计任务书自己引用了
   `D:\dsh\research\*`，所以 cwd 用 `D:\dsh` 而不是 `D:\dsh\kingdom`。
4. 在 prompt 开头显式给出授权边界（可读哪些目录、可跑命令、哪些只读、禁止改什么），
   否则审计会停下来要确认，得再用 `mode:'steer'` 补发。

#### 最短安全路径

- 诊断捷径：`curl -s .../api/session.list -d '{"type":"client-request","rpcId":"x","method":"session.list","payload":{}}'` 探活。
- 快速验证：`node run-phase2-audit.mjs poll <sid>` 看 `running` 与是否已出结论。

#### 避免与失败方法

- **`session.history` 返回的不是 `{messages}`，而是 `{events, hasMore, projections}`**；
  助手文本在 `event.data.message.content[]` 里，且与 `type:'reasoning'` 块混在一起。
  按 `{messages}` 或 `role` 字段解析会稳定得到 0 条——第一版解析器就是这么静默失败的。
  正确写法：过滤 `event.type === 'assistant/message'`，再取 `content` 中 `type==='text'` 的块。

#### 可复用资产与证据

- 脚本：`D:\dsh\research\run-phase2-audit.mjs`（create / poll / dump / steer 四个子命令）
- 证据：审计会话 `session-30ef144f-4c4f-4417-a8f3-ca6d63834038`，36455 events，一轮出结论

#### 关联

- 全局工程经验：`GX-SHARED-REVIEWLOOP-001`

## 3. 架构与模块边界

### PX-TOOL-002：结构化声明宿主服务面，而不是 import 宿主类型

- 状态：active
- 证据等级：direct
- 作用域：`src/worker/dsh-subagent.ts`、`package.json` 的 `peerDependencies`
- 触发条件：插件要调用 `ctx.<service>`，但不想为此新增 peer 依赖或让 `.d.ts` 泄漏宿主类型
- 标签：`plugin-boundary`、`structural-typing`、`peer-dependency`
- 最后验证：2026-08-17

#### 当前项目的正确做法

1. 在本地声明**所需最小结构面**（`SubagentsLike` / `SubagentRunLike` / `SubagentResultLike`），
   注释里写清对应 checkout 的定义位置与行号，便于日后核对漂移。
2. 用 `ctx.get('<service>')`（cordis 对未知名返回 `any`）拿服务，转成本地接口。
   `get` 不要求 `inject`，因此不会引入激活顺序耦合，服务缺失时也只是运行期明确报错。
3. 服务解析放在**工具边界**，Core 只依赖自己的接口（这里是 `WorkerExecutor`）。

#### 快速验证

```bash
grep -rh "^import" lib/*.js lib/**/*.js | sort -u   # 期望只有 node:* / 相对路径 / 原有 peer
```

#### 正确性条件与适用边界

- 必须成立：宿主接口稳定且有 checkout 可核对；本地结构面是真子集。
- 失效条件：宿主改了服务签名——结构化声明不会编译报错，只会运行期失败。
  所以**必须**在注释里留 checkout 行号，并在升级 dsh 后重新核对。

#### 关联

- 项目工程章节：`EL-INTEGRATION-001`

## 4. 数据、事务与一致性

### PX-DATA-001：`tasks.status` 的唯一写入路径是 `KingdomStore.transitionTask`

- 状态：active
- 证据等级：direct
- 作用域：`src/core/db.ts`、`src/core/task.ts`
- 触发条件：新增任何会改变任务状态的代码路径
- 标签：`single-writer`、`state-machine`、`invariant-enforcement`
- 最后验证：2026-08-17

#### 根因

"状态机是唯一入口"如果只靠约定和注释，随时会被下一个 `UPDATE ... SET status` 绕过。
必须让它**在结构上无法绕过**。

#### 当前项目的正确做法

1. 全库**只有一处** `UPDATE tasks SET status`，位于 `KingdomStore.transitionTask`。
2. 该方法内部强制先调 `transition(from, to)`（`src/core/task.ts`），非法转移抛
   `TaskTransitionError`，一个字节都不会落库。
3. 库层读到未知状态字符串时 `asTaskStatus` 直接抛（fail-loud），不猜、不兜底。
4. 状态与附带字段（`assigned_binding_id`、`result_summary`）在**同一条 UPDATE** 里落库，
   避免"状态变了但指派没变"的中间态。

#### 快速验证

```bash
grep -rn "UPDATE tasks SET status" src/    # 期望恰好 1 处
```

这条 grep 本身就是不变量的可执行断言，建议在任何改动后重跑。

#### 关联

- 项目工程章节：`EL-STATEMACHINE-001`
- 全局工程经验：`GX-SHARED-SINGLEWRITER-001`

### PX-DATA-002：用幂等 DDL 做零迁移，并且不给 `schema_version` 造一个假 gate

- 状态：active
- 证据等级：direct
- 作用域：`src/core/db.ts` 的 `SCHEMA_SQL`、`kingdoms.schema_version`
- 触发条件：需要加表/加索引，或考虑要不要写 migration
- 标签：`zero-migration`、`idempotent-ddl`、`schema-version`
- 最后验证：2026-08-17

#### 当前项目的正确做法

1. 加表用 `CREATE TABLE IF NOT EXISTS`，加索引用 `CREATE UNIQUE INDEX IF NOT EXISTS`，
   全部放进开库即执行的 `SCHEMA_SQL`。旧库**打开瞬间就收敛**，不需要迁移脚本、不需要 rebuild。
2. 加约束到既有表要小心：0.2.0 给 `territories(kingdom_id, name)` 加 UNIQUE 索引是安全的
   （幂等、无需 rebuild、旧库直接生效），**前提是旧数据无重复**——有重复会 fail-loud，这是想要的。
3. **不改既有表的 DDL**。`tasks` 表一字未改，正因为施工前确认了 `status` 无 CHECK
   （改 CHECK 在 SQLite 里要 table-rebuild，那才是真 migration）。
4. `schema_version` 保持 1 未动：没有任何代码按它分支，幂等 DDL 已让新旧库结构一致。
   此时把新库标 2 只会制造"同结构不同版本号"的假差异。留到真有破坏性 migration 时再当 gate 用。

#### 完整验证

复制真实旧库为副本 → 用新版打开 → 断言：新表已建、旧数据条数不变、既有表 DDL 未变。
见 `scripts/p2-smoke.mjs` A 组 8 项。

#### 避免与失败方法

- 不要用 `sqlite_master.sql` 里有没有 `IF NOT EXISTS` 来断言幂等性——**SQLite 存的是规范化 DDL，
  会把 `IF NOT EXISTS` 剥掉**。要验幂等就重复执行该语句看是否抛错（独立审计首轮在这里误判过一次）。

#### 关联

- 项目工程章节：`EL-MIGRATION-001`

## 7. 测试、发布与故障恢复

### PX-TEST-001：治理状态机用假 Executor 离线验证，不依赖模型 key

- 状态：active
- 证据等级：direct
- 作用域：`scripts/p2-smoke.mjs`、`src/worker/executor.ts`
- 触发条件：要验收 Task 闭环，或身处没有模型 API key 的环境
- 标签：`seam`、`offline-test`、`fake-executor`
- 最后验证：2026-08-17

#### 当前项目的正确做法

1. Task Core 只依赖 `WorkerExecutor` 接口，因此注入一个假 executor 就能把
   plan/assign/start/review/rework/executor-failure 全链路跑完，**不需要活的 DSH、不需要模型 key**。
2. 假 executor 按脚本返回 `{kind:'result'}` 或 `{kind:'executor-failure'}`，
   并记录收到的 `WorkerContext`，用来断言 REWORK 轮次确实注入了上一轮摘要与返工理由。
3. `DshSubagentExecutor` 自身用一个结构化的假 `ctx.subagents` 单测：
   provider 缺失 / start 抛错 / `stopReason=error` / structured 非法 / dispose 是否被调用。
4. 隔离目录 `.p2-smoke/`；零迁移一项用真实库的 `copyFileSync` 副本，绝不开真库。

#### 正确性条件与适用边界

- 这样验证的是**状态机语义**，不是真实 subagent 链路。
  真实 spawn provider 的端到端**必须单独标注 NOT_RUN**，不能让 81 项绿色掩盖它。
  独立审计明确保留了这一条为 freeze 后动作。

#### 可复用资产与证据

- 脚本：`scripts/p2-smoke.mjs`（81 断言，A–I 九组）
- 证据：81 passed / 0 failed；独立审计自写 89 断言复跑同样全绿

#### 关联

- 项目工程章节：`EL-GOVERNANCE-001`、`EL-INTEGRATION-001`

### PX-OPS-001：dev profile 用 symlink 直连源码时，「构建」等于「向运行中的 DSH 发布」

- 状态：active
- 证据等级：direct
- 作用域：`~/.dsh/profiles/web/node_modules/@dsh-external/dsh-kingdom` → `D:\dsh\kingdom`
- 触发条件：DSH web/headless 正在运行时执行 `tsc` 或以任何方式改写 `lib/`
- 标签：`hmr`、`dev-symlink`、`unintended-side-effect`
- 最后验证：2026-08-17

#### 问题与识别信号

- 现象：只做了构建和"隔离目录"冒烟测试，开发环境真实 DB 却出现了新版本才有的表/索引。
- 识别信号：DB 的 mtime 紧跟在 `lib/` 写入之后（本次实测差 **1.4 秒**）。

#### 根因

profile 里装的不是 tgz 拷贝，而是指向源码目录的**实时 symlink**。
`tsc` 一写出新 `lib/`，运行中的 DSH 就 HMR 重载了新版插件，
插件构造函数对**真实**数据库执行了新版 `SCHEMA_SQL`。
测试隔离了 DSH_HOME 是不够的——**副作用来自构建，不是来自测试**。

#### 当前项目的正确做法

1. 施工前先确认这个 symlink 是否存在：
   `ls -la ~/.dsh/profiles/*/node_modules/@dsh-external/`
2. 若存在，二选一：构建期间停掉 DSH web；或把 profile 改成安装 tgz 拷贝而非 symlink。
3. 事后取证：比对 `lib/*.js` 与 DB 的 mtime，秒级吻合即可判定是 HMR 而非测试所致。

#### 正确性条件与适用边界

- 本次影响可接受：幂等 DDL 纯增量，Phase 1 数据零丢失（1 王国 / 1 领地 / 2 绑定 / 3 事件不变），
  客观上成了一次真实环境的零迁移实证。但**不能依赖这种运气**——
  如果这次带的是破坏性 migration，损失就是真实的。

#### 可复用资产与证据

- 证据：`lib/core/db.js` 写于 15:54:15.920，`kingdom.db` 改于 15:54:17.318
- 记录：`D:\dsh\research\Phase2-施工完成说明-2026-08-17.md` §8

#### 关联

- 项目工程章节：`EL-DEVLOOP-001`

## 8. 构建、生成器与工具约束

### PX-TOOL-001：dsh 的 outputSchema 必须过宿主真实校验器，不能照抄文档字面

- 状态：active
- 证据等级：direct
- 作用域：`src/worker/executor.ts` 的 `WORKER_OUTPUT_SCHEMA`
- 触发条件：编写 subagent `outputSchema` 或任何交给 dsh 校验的 JSON Schema
- 标签：`json-schema`、`host-subset`、`contract-validation`
- 最后验证：2026-08-17

#### 问题与识别信号

- 现象：任务书给的 schema 字面 `"outcome": { "enum": ["COMPLETED","FAILED","BLOCKED"] }`
  看起来是标准 JSON Schema，实际会被 dsh 运行时拒绝。
- 识别信号：`unsupported JSON schema: schema.properties.X.enum requires type or oneOf`。

#### 根因

dsh 只支持 JSON Schema 的一个**强制子集**
（`packages/core/tools/src/json-schema.ts`）：`enum`/`const` 只允许挂在**已声明 scalar `type`**
的节点上；根必须是 `object`（`assertObjectJsonSchema`）。标准合法 ≠ 宿主接受。

#### 当前项目的正确做法

1. enum 节点写全：`{ type: 'string', enum: [...] }`。
2. **构建期用宿主真实校验器验证字面量**，别靠读文档：

```bash
cd /d/deepseek-harness && cat > schema-check.tmp.ts <<'EOF'
import { assertObjectJsonSchema } from './packages/core/tools/src/json-schema.ts'
try { assertObjectJsonSchema(<你的 schema>); console.log('OK') }
catch (e) { console.log('REJECTED:', e.message) }
EOF
node --import tsx/esm schema-check.tmp.ts; rm -f schema-check.tmp.ts
```

3. 在自测里保留形状断言（`WORKER_OUTPUT_SCHEMA.properties.outcome.type === 'string'`），
   防止日后有人"清理"掉这个看似冗余的 `type`。

#### 避免与失败方法

- 这个错误的代价特别隐蔽：schema 被拒 → `subagents.start` 抛错 → 走 executor-failure →
  **任务被直接判 FAILED**。表面看像"Worker 执行失败"，实际是自己的 schema 写错了，
  而且是**每一次**执行都失败。

#### 关联

- 项目工程章节：`EL-INTEGRATION-001`

## 9. 待验证经验

只保留有明确验证计划的 `candidate` 条目。

### PX-TEST-002（candidate）：真实 spawn provider 的端到端链路

- 状态：candidate
- 证据等级：inferred
- 作用域：`src/worker/dsh-subagent.ts`、dsh `subagents` provider `spawn`
- 触发条件：拿到可用模型 API key 后
- 标签：`not-run`、`end-to-end`、`subagent`
- 最后验证：2026-08-17

> 本条为 NOT_RUN。上面的日期表示"最后一次确认它仍未被验证"，而不是验证通过的日期。

#### 验证计划

在有 key 的环境跑一条完整 ACCEPT 全链路
（plan → assign → start 真实 subagent → REVIEW → ACCEPT → DONE），
确认 `outputSchema` 约束下 `result.structured` 的实际形状与 `parseStructuredResult` 一致。

#### 现状

`DshSubagentExecutor` 与真实 `SubagentsLike` 的接口形状已按 checkout 基线
（`packages/subagent/subagent/src/index.ts:414`、`types.ts:100/219/249`）核对一致，
但**真实调用为 NOT_RUN**。独立审计已把这条列为 freeze 后动作。

#### 正确性条件与适用边界

- 在这条验证完成前，任何"Phase 2 已端到端可用"的表述都是超出证据的。
  状态机语义已验证，真实执行链路未验证——两者不能混为一谈。

## 10. 已废弃经验

废弃条目应保持简短，并指向替代条目。


---

## 条目模板

```markdown
### PX-CATEGORY-001：标题

- 状态：candidate | active | conflicting | deprecated
- 证据等级：inferred | direct | corroborated
- 作用域：`path/**`、module、table
- 触发条件：未来在什么场景下应召回
- 标签：`tag-a`、`tag-b`
- 最后验证：YYYY-MM-DD

#### 问题与识别信号
- 现象：
- 识别信号：

#### 根因
- 已确认根因或推测根因：

#### 当前项目的正确做法
1.
2.

#### 最短安全路径
- 诊断捷径：
- 实现捷径：
- 快速验证：
- 完整验证：

#### 避免与失败方法
- 不要……，因为……

#### 正确性条件与适用边界
- 必须成立：
- 不适用：
- 失效条件：

#### 可复用资产与证据
- 代码：
- 测试：
- 命令：
- 证据：

#### 关联
- 项目工程章节：`EL-TOPIC-001`
- 全局工程经验：`GX-PROFILE-TOPIC-001` 或 `GX-SHARED-TOPIC-001`
- 替代/冲突：
```
