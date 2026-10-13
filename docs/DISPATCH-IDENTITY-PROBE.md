# Dispatch identity probe — 2026-10-13

## 偏移与关键问题（必须首先阅读）

- 设计偏移：NONE；Core 保留 opaque Runtime 引用，Adapter 不取得治理权限。
- 最重要问题：持久化输入是正证据；缺少输入仍是 UNKNOWN，不能据此作废、释放 Lease 或重发。
- 未通过状态：Provider、真实 enforcement、terminal、冷 cleanup、安全作废和子目录写根均 NOT_RUN / UNKNOWN。
- 需要 Owner 裁决：NO；本探针验证关联与只读观察，不增加处置权限。

## 官方版本和复用选择

探针对调用方明确指定的已安装官方包读取各自 package.json。上一轮读取的 `dsh-agent`、`dsh-agent-loop`、`dsh-session`、`dsh-session-persistence-jsonl` 等组件均为 `0.1.5-rc.2`；安装目录名称不是组件版本。每次报告记录当前实际版本，结论仅对所列版本和该次明确指定的产品编译目录成立。

复用官方 Agent Registry、公开 maintenance / followup、`sessions.flush` 和 JSONL persistence handle，不复制 Runtime 存储、不新增上游 metadata。官方包采用 MIT 许可证；本轮没有新增产品依赖或 Provider 插件。Adapter 延续结构型完整 UserMessage，通过 Node UUID 和深层 Object.freeze 在调用前冻结消息；没有调用官方 `MessageId` / `freezeMessage` 构造器，不将这两个 API 写为实测链。真实 rc.2 followup 接受该完整消息仍须由产品探针证明。

匹配版本依据为安装包 `dsh-agent/README.md`、`dsh-session/README.md` 及其 `lib/types/index.d.ts`，`dsh-session-persistence/README.md` 及 `lib/types/handle.d.ts`，`dsh-session-persistence-jsonl/README.md`。公开说明和类型明确：

- `followup` 是 next-turn 入队并唤醒 driver，不是 terminal 或持久化 Receipt。
- `sessions.flush(session): Promise<boolean>` 在所有 durability listener 结束后返回；`true` 表示至少一个 listener 参与，`false` 表示没有 listener。`false` 不是“证明未派发”；也不是可靠接受。本探针装配官方 JSONL listener。
- persistence `open(id, 'read') / read(offset, length) / close()` 允许不 resume 的公开只读事件读取；read 的默认全量行为没有被产品 reconcile 使用。
- maintenance 预留真实 driver 的活动区间。本探针在该区间持有 reservation 到强杀，阻止模型轮次启动。

## 第二轮产品路径与证据边界

脚本：`scripts/e2e/dsh-dispatch-id-probe.mjs`。两个 case 都直接经过本轮编译的产品 Adapter 与 Core：

1. 真实 `DshRuntimeAdapter.createSession` 创建独立 Session；公开 maintenance 保持 driver 暂停。
2. 产品 `prepareDispatch` 冻结消息和单次 opaque token；此时未调用 followup。
3. 真实 Core `prepareGovernedDispatch` 完成 TX-3，将 Kingdom dispatch ID 和 planned Runtime ref 持久化到 `INTENDED`。它们与 Receipt、terminal 和治理事实明确分开。
4. `SENT_AFTER_FLUSH`：调用真实产品 `Adapter.dispatch`，仅在公开 flush 返回 true 后得到 Runtime Receipt；强杀 writer 前刻意不记录 Core Receipt。
5. `COMMIT_BEFORE_SEND`：TX-3 后不发送输入，直接强杀 writer；只对空 Session 完成一次 baseline flush，确保 reader 能读取。baseline flush 不是派发接受。
6. 两 case 启动全新 reader PID，只加载 session + persistence 服务，不 resume、不创建 Agent、不启模型。fresh 产品 Adapter 用真实已持久化 Core ref 调用 `.reconcile`；另用有界公开 read 交叉检查精确 inbox ref 数和 `turn/start` 数。
7. 断言正例为 `QUEUED / located=true`，未发送例为 `UNKNOWN / located=false`。均要求 Core 行/事件不变、Receipt 缺失、Lease 仍 EXECUTING、Execution 仍 STARTING、Task 仍 ASSIGNED、Claim 为0、模型 turn 为0。

权威、Binding、Capability Decision 和 cleanup plan 是显式直接写入隔离测试账本的 **FAKE_PREREQUISITES**；本探针只证明产品准备、Core TX-3、真实 DSH 派发耐久性和冷只读关联。它不是全受治理端到端、真实 sandbox/enforcement、Provider 成功、任务终态或最终验收证明。

运行方式：

```text
node scripts/e2e/dsh-dispatch-id-probe.mjs <installed-runtime-root> <isolated-output-root> <current-compiled-product-lib-root>
```

第三参数也可由 `KINGDOM_DISPATCH_ID_PROBE_LIB_ROOT` 显式提供；未提供则在启动 Runtime / 创建目录前拒绝。脚本不会默认为仓库旧 `lib`，不能用旧编译输出证明新源码。调用方负责先把当前源码编译到独立 stage；探针不执行构建。

脚本仅终止本次 fork 创建的子进程。每次创建随机名测试子目录，Session JSONL、测试 kernel DB 只留在指定的 ignored 本地输出目录。报告保存有界状态、版本和比较结果，不输出原始会话、消息文本、绝对个人路径或 exact Session/message ref。报告输出 `dispatch-id-probe-report.json`；此报告及测试账本不能进入发布包。

`tests/dsh-dispatch-id-probe.test.mjs` 的4项失败路径检查验证：不得隐式沿用旧lib、缺失输入不得提升为 QUEUED、turn/Claim/DONE/Receipt/release不得假造、正常退出/同PID不得冒充强杀和新进程读取。它们不是 Runtime 探针证据。

## 3.2.1 发布移植的版本核对

派发关联改动从第二轮整改基线形成有限 delta，移入 `3.2.0` 发布源码；不会用旧开发树覆盖 3.0—3.2 的功能。下列静态核对只说明公开接口匹配，不继承旧编译或旧运行的 PASS：

- 已读取安装的 `0.1.7-rc.2` 官方组件 README、package.json 和公开类型：`dsh-session`、`dsh-agent`、`dsh-session-persistence` 与 JSONL backend。这些组件均声明 MIT 许可证。
- `sessions.flush(session): Promise<boolean>`、完整 UserMessage `followup` 和 persistence `open(id, 'read') / read(offset, length) / close()` 的本轮调用形状与 `0.1.5-rc.2` 一致；`read` 返回 `{ eventState, events }`，产品读取 `events`，不假定数组返回。
- `0.1.7-rc.2` 的 Session README 与类型已将 `snapshotEvents`、`eventAt`、`ownEvents` 标记 deprecated，仍保留公开方法，并允许既有逻辑暂不迁移。本插件 live 观测继续依赖这一公开兼容面；本轮不改造既有 warm fence、cleanup 或 Runtime 投影。冷 persistence 观察使用公开异步 read handle。
- 每个目标 Runtime 版本都必须用本次发布源码的明确编译目录重新跑产品探针。真实结果在运行后单独记录；只有类型检查或 probe 断言测试通过时，Runtime 能力仍为 `NOT_RUN / UNKNOWN`。

## 结果记录

- 3.2.1 发布基线：本轮当前源码构建分别对实际官方0.1.5-rc.2和0.1.7-rc.2运行v2产品探针，四个case全部PASS。两条线均为SENT_AFTER_FLUSH输入1条/QUEUED、COMMIT_BEFORE_SEND输入0条/UNKNOWN，fresh reader读取前后Core不变、Provider和模型turn均0。该结果不外推完整治理或安全作废。

- 上一轮 v1：仅 Runtime 构造器 + followup + flush + 新 persistence reader，PASS；不代表本轮产品路径。
- 整改开发树 v2（发布移植前）：2026-10-13 本机 PASS，使用当时整改源码的独立编译 stage。所有装配的 DSH 组件实际为 `0.1.5-rc.2`；没有加载 Provider 插件。这不是 `3.2.1` 发布源码的实测结果。

| Case | 真 writer 强杀 / 新 reader PID | 持久化精确输入 | fresh Adapter observation | Core Receipt / Lease / Task / Claim | 模型 turn |
|---|---|---|---|---|---|
| SENT_AFTER_FLUSH | SIGKILL / YES | 1条；与 TX-3 planned ref 相同 | QUEUED，PERSISTED，complete=true | 无 / EXECUTING / ASSIGNED / 0 | 0 |
| COMMIT_BEFORE_SEND | SIGKILL / YES | 0条；planned ref 已存在 | UNKNOWN，PERSISTED，complete=true | 无 / EXECUTING / ASSIGNED / 0 | 0 |

两例均在 SEND 前确认 Core 已存 Kingdom ID 与 planned ref；reader observation 返回同一 ID/ref；Reader 对账前后隔离 Core 行和事件计数不变。实际报告在本地 ignored `dispatch-correlation-dev/probe/dispatch-id-probe-report.json`，不将本轮 PASS 外推到其他编译、版本或 backend。

## 不能推导的结论

- 未 flush、flush=false、throw 或超时均不能据此证明未派发。产品 prepared token 在第一次 side effect 前消耗；不确定时不能复用该 token 重发。
- `flush=true` 仅在当前公开 listener 与 backend 成功完成前提下支持持久化接受；不能外推到任意 backend 的 durability 实现。
- 找不到 ID 不证明未出境；查询完整性、原发送方失效屏障、迟发/未落盘输入和 enforcement cleanup 仍须单独证明。
- 持久 inbox 中排队消息可能在未来 resume 时执行。当前 turn 为0不证明未派发或安全作废。
- 只读恢复观察不重建原 Fence/cleanup context、不补写 Receipt、不 settle/release、不发 Claim、不推进 Task DONE。
- 强杀仅针对本探针拥有的 writer，不能授权终止其他产品 Session 或进程。
