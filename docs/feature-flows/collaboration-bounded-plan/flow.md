---
feature_id: collaboration.bounded-plan
title: Explicit bounded personal collaboration plan
status: implemented
---

# 个人有界协作计划

## 设计范围与证据状态

依据 .local/construction-audit/20260912-v15-bounded-collaboration/00-WORK-ORDER.md。本合同已对照当前Core计划、资源接纳、advanceCollaboration、Owner及GUI源码核对，主流程全量460/460、官方DSH隔离旅程、16场景浏览器和Flow finalize通过。现有身份、Task、Owner prepare/commit/receipt、Capability Gate、预算及恢复机制继续作为权威接缝；本地测试和合成浏览器证据不等于真实Provider收益或人类验收。

单 Worker 仍是默认。需要协作时，宰相提出一层 EXPERT 或 TEAM 计划，人类在独立 Owner 窗口一次采纳整份确定内容。计入主整合者后最多三个不同 Worker。EXPERT 的专家强制只读；TEAM 使用明确资源范围。没有递归扩队、后台无界调度、自动 ACCEPT、角色升级或跨任务记忆。

计划包含父 Task、ID/版本/摘要、拆分理由、工作项 key/TaskID、范围、验收、领地和 Worker、访问模式、依赖、预期产物、整合者以及整项软额度/单次估计。文件列表表达责任，实际隔离以规范化真实工作区及运行时限制为准。

## 提案与一次采纳

```mermaid
flowchart TD
    E1(["E1 当前宰相明确提出协作"]) --> D1{"D1 父项为无父项的CREATED，成员/领地合法且计划有界无环"}
    D1 -->|否| X1(["X1 拒绝提案，保留现有任务"])
    D1 -->|是| T1["T1 Core记录版本化计划提案及内容摘要"]
    T1 --> A1["A1 GUI只读展示整份计划、整合责任与软预算"]
    A1 --> E2(["E2 人类在独立Owner窗口准备并明确采纳"])
    E2 --> D2{"D2 准确Owner动作与资源范围合法，版本摘要和父项仍匹配"}
    D2 -->|否| X2(["X2 拒绝或提示过期，保留输入和原操作编号"])
    D2 -->|是| T2["T2 同事务记录准确采纳、创建子Task及Owner回执"]
    T2 --> X3(["X3 已采纳，等待合法主管分配及推进；不自动派发"])
    G1[["G1 一层且最多三个Worker；专家只读，不能自授角色或能力"]] -.-> D1
    G2[["G2 人类采纳绑定原计划；Agent和旧Role Cookie不能代替Owner"]] -.-> D2
    G3[["G3 采纳和子Task原子且幂等；响应不明只能查询原回执"]] -.-> T2
    G9[["G9 只读有界投影，真实占用不等于排队；成本上界不冒充精确费用"]] -.-> A1
```

## 有界推进与整合

```mermaid
flowchart TD
    E3(["E3 当前真实Supervisor明确推进一个有界批次"]) --> D3{"D3 计划已采纳且有效，当前Scope/Worker/Assignment可核对"}
    D3 -->|否| X4(["X4 拒绝推进，显示准确权限或状态原因"])
    D3 -->|是| D4{"D4 所选工作项依赖均有当前有效的准确接受结果"}
    D4 -->|否| X5(["X5 等待或阻塞，显示前置Task及过期/失败原因"])
    D4 -->|是| A2["A2 定向准备有界摘要与准确产物引用，复用合法Assignment"]
    A2 --> A3["A3 Session副作用前在同一IMMEDIATE事务检查计划并预留预算与工作区"]
    A3 --> D5{"D5 预算与资源都允许新增，且无重复或未决派发"}
    D5 -->|否| C1["C1 仅取消可证明未派发的预留；未决或恢复占用保留"]
    C1 --> X6(["X6 显示预算/资源/恢复原因；等待合法处理，无自动重试"])
    D5 -->|是| A4["A4 原治理启动链核验Grant/Ceiling，TX-3重验并绑定准确Dispatch"]
    A4 -->|启动失败或不明| C1
    A4 -->|合法运行| T3["T3 子项按现有Task运行和Claim流程到REVIEW"]
    T3 --> E4(["E4 当前主管按正常Review裁定"])
    E4 --> D6{"D6 当前Claim证据满足验收"}
    D6 -->|否| X7(["X7 返工或失败；已采纳成员拒绝换员，仅准确已结算失败的本项可重试"])
    D6 -->|是| T4["T4 当前Supervisor ACCEPT，子Task到DONE"]
    T4 --> D7{"D7 所有工作项均已被接受且结果仍有效"}
    D7 -->|否| X8(["X8 保留进度，下一次明确推进再检查"])
    D7 -->|是| X9(["X9 父项整合就绪；父Task仍未完成"])
    E5(["E5 主管明确推进指定主Worker的父项整合"]) --> D8{"D8 依赖、当前身份、资源与预算重验通过"}
    D8 -->|否| X6
    D8 -->|是| A5["A5 主Worker在原治理链实际整合并另交Claim"]
    A5 --> D9{"D9 当前主管对父项Claim明确ACCEPT"}
    D9 -->|否| X7
    D9 -->|是| T5["T5 父Task经正常Review到DONE"]
    T5 --> X10(["X10 主管已接受整合产物；人类验收不自动推断"])
    G4[["G4 每次推进与异步治理边界后重验当前真实身份，再允许副作用"]] -.-> D3
    G4 -.-> D8
    G4 -.-> A4
    G5[["G5 依赖绑定准确Task/attempt/result/ACCEPT及产物版本，交接内容仍是Claim"]] -.-> D4
    G5 -.-> A2
    G6[["G6 重叠真实目录读共享写独占，覆盖链接别名、非团队Lease及活动Legacy执行"]] -.-> A3
    G6 -.-> C1
    G7[["G7 计划与王国预算叠加；协调风险上界单列，不伪装精确团队费用"]] -.-> A3
    G8[["G8 子项完成不代替父项整合及正常主管审查"]] -.-> D9
```

## 组件时序

```mermaid
sequenceDiagram
    participant Chancellor as 真实宰相
    actor Human as 人类Owner
    participant GUI as 独立Owner窗口和只读工作台
    participant Core as Core计划与原治理服务
    participant Store as 同一事实账本
    participant Supervisor as 当前真实主管
    participant Admission as 预算及工作区接纳
    participant Runtime as DSH Worker运行时
    Chancellor->>Core: 提案父项、工作项、依赖、整合者与额度
    Core->>Store: T1 记录版本化提案
    GUI->>Core: 只读当前计划及就绪/预算原因
    Core-->>GUI: 准确版本/摘要与有界明细
    Human->>GUI: 准备并一次采纳完整计划
    GUI->>Core: 原Owner prepare/commit，提交只传准备及操作编号
    Core->>Core: 重验人类范围、最新版本、父项和成员
    Core->>Store: T2 同事务采纳、子Task、来源事件及receipt
    alt 已提交但响应丢失
        GUI->>Core: 查询原decisionId和operationId
        Core-->>GUI: 原回执或未确认；不重发
    else 明确结果
        Core-->>GUI: 已采纳或拒绝，无自动派发
    end
    Supervisor->>Core: 当前身份推进一个ready批次
    Core->>Core: 依赖准确结果与Assignment/Scope检查
    Core->>Admission: Session副作用前同一IMMEDIATE事务检查计划并预留预算和读写资源
    alt 资源冲突、额度耗尽、缺口阻断或恢复占用
        Admission-->>Core: 确定原因及占用/依赖引用
        Core-->>GUI: 排队或阻塞；保留既有执行事实
    else 接纳允许
        Core->>Runtime: 原治理启动与Capability Gate
        Core->>Store: TX-3重验，绑定预留及准确Dispatch
        Runtime-->>Core: 客观运行结果与Worker Claim
        Core->>Store: T3 原流程到REVIEW，不自动DONE
        Supervisor->>Core: 对准确Claim正常Review
        Core->>Store: T4 ACCEPT后子项DONE
    end
    opt 所有子项当前有效并已接受
        Core-->>GUI: 父项整合就绪；仍待主Worker实际工作
        Supervisor->>Core: 再次明确推进父项整合
        Core->>Admission: 重验依赖、预算及资源
        Core->>Runtime: 指定主Worker定向接收结果引用并整合
        Runtime-->>Core: 父项新Claim
        Supervisor->>Core: 正常父项Review
        Core->>Store: T5 仅ACCEPT使父项DONE
    end
```

## 持久状态与推导状态

```mermaid
stateDiagram-v2
    state "协作计划事实" as Plan {
        [*] --> PROPOSED: T1 合法宰相提案 / 记录版本与摘要
        PROPOSED --> PROPOSED: T8 准确前版基准 / 追加下一版本，已采纳后不可改写
        PROPOSED --> ADOPTED: T2 准确人类采纳 / 同事务子Task及receipt
    }
    state "各子Task沿用原生命周期" as Item {
        [*] --> CREATED: T2 采纳事务 / 创建子Task
        CREATED --> ASSIGNED: T6 当前Supervisor合法分配 / 原Assignment Ledger
        ASSIGNED --> RUNNING: T7 原治理启动 / 预算资源及Gate通过
        RUNNING --> REVIEW: T3 Worker呈报 / Claim待审
        REVIEW --> DONE: T4 当前Supervisor ACCEPT / 正常审查
    }
    state "父Task整合" as Parent {
        PARENT_CREATED --> PARENT_ASSIGNED: T6 当前主管分配指定主Worker
        PARENT_ASSIGNED --> PARENT_RUNNING: T7 重新检查依赖与原治理启动
        PARENT_RUNNING --> PARENT_REVIEW: T3 主Worker实际整合并呈报
        PARENT_REVIEW --> PARENT_DONE: T5 当前Supervisor ACCEPT / 正常父项审查
    }
    state "工作区资源接纳事实" as Resource {
        [*] --> RESERVED: T9 Session前同事务预算及资源接纳
        RESERVED --> BOUND: T10 TX-3绑定准确Dispatch和Lease
        RESERVED --> CANCELLED: T11 安全未派发证明 / 取消未绑定预留
    }
```

子项和父项图复用原Task成功状态链，不允许跨越ASSIGNED或RUNNING。STALE、依赖就绪、资源是否仍占用、预算阻断、整合就绪均是当前事实推导，不写作新计划持久状态。BOUND资源是否释放由准确终态Dispatch和已释放Lease决定，不虚造资源RELEASED事件。返工、失败、交接及恢复沿用原服务和原合同；本流程不发明取消恢复的捷径。

## 失败、安全收缩与可观察结果

- 发布审查修复：已采纳成员的 HANDOFF 在写事务内拒绝，Task、Assignment 和事件不变。FAILED/ABORTED 仅在当前项最新 Claim、attempt、Execution 与 REWORK 摘要完全匹配且执行/Dispatch/Lease 均已结算时允许本项重试；普通未失败兄弟仍被阻断；多个已明确返工且已结算的失败成员可逐个重试，避免相互等待。TX-3仅排除当前调用准确下一尝试的DISPATCH_READY Lease，历史未决锁仍阻断。无资源记录的活动 Legacy 执行保守视为写占用，Legacy 启动与 governed 预留双向检查真实目录，检查与创建执行事实同处 IMMEDIATE 事务。

- 未采纳、版本被替换、父项或成员事实改变时拒绝推进；采纳过期须重新读取和准备。一次用户采纳不代替主管Assignment、Grant、Owner Ceiling或产物Review。
- index的runGovernedStart向runGovernedTask、Gate与派发传递内部stillAuthorized校验；S4、Session、preflight、materialize及trustFence等await之后，在后续副作用前重查当前Supervisor身份和范围。此内部回调不是模型可提供的权限参数，异步期间撤销不因旧的批次校验而失效。
- 准确依赖至少绑定计划版本、Task、最新attempt、result引用与有效主管ACCEPT；产物携带版本/内容摘要和引用，有限摘要定向进入Worker上下文。缺失、失败、过期或验收不明都会阻断后继；多数模型同意不构成验收。
- 无Task文件级enforcement时，重叠真实工作区实行读共享/写独占；目录链接和别名必须归一，非团队未释放Lease和旧尚未派发预算预留按独占保守参与冲突。计划检查、预算和资源预留在Session副作用前的同一IMMEDIATE事务完成，TX-3重新核验并绑定准确Dispatch，不能仅比较用户填写的文件清单。
- 王国与整项软预算同时约束新增工作。预算视图明确标为 PLAN_WITH_KINGDOM_COORDINATION_UPPER_BOUND：Worker准确实报、同期王国协调成本保守上界、估计预留和归属缺口分别显示，金额保持未测。不把协调共享来源重复累加或精确摊给某个工作项。
- 到达上限、发现依赖风险或无法证明收益时停止新增并行；既有工作仍按原治理对账。只有能证明未派发且无未结算运行/Lease的预留才允许取消；RECOVERING和未确认结果保留占用。缩为串行不等于终止所有Agent。
- 现阶段没有后台调度循环、自动重试或新增计时器。kingdom_advance_collaboration经真实调用身份进入advanceCollaboration：SERIAL一次一个且等待已有执行/预留结算，PARALLEL一次最多两个独立子项，父项整合单独推进。批次先同事务核验范围并完成正常分配，每次启动再次读取真实身份；首项立即拒绝可停止后续启动，已接纳独立工作不因另一项失败被取消。重复调用及RUNNING无最新准确REWORK均拒绝。运行超时、派发不明、恢复和清理沿用原governed路径；Owner准备验证沿用有界超时，过期和撤销继续生效。
- GUI只读显示计划摘要、采纳状态、各项依赖/预算原因、整合者和费用缺口。计划显示至多40份，Owner待采纳总数仍计全部提案；资源显示至多80项，只含Task/attempt、访问模式、接纳状态和恢复标记，不泄漏工作路径。无持久排队事实时只展示实际占用，无记录不代表空闲或自动排队。Owner仅从服务端完整Scope过滤目录中选择PROPOSED计划，version/digest只读，payload精确三字段；最终完整内容在服务端prepare预览重新确认，commit仍只带原准备/操作编号。
- 计划事实和决定属于Core事件，子项归Tasks、分配归Assignment Ledger，执行和资源归原执行服务及新增接纳事实；Adapter仅提供运行证据，不持有另一份治理真相。

## 验证与实际边界

测试映射覆盖：未采纳、错角色/范围、环及递归/成员超限、版本替换、父项变化、原子采纳及重放；依赖失败/过期/错误attempt、重复推进；同目录/重叠目录/链接别名/非团队Lease竞争及恢复占用；预算耗尽/缺失观测；所有子项接受后父项仍须实际整合及正常Review。代码映射只指实际文件和符号，完整验证由主流程统一记录。

- GUI专属5项及受影响成本/工作台/Owner回归37/37通过；资源GUI夹具必须先经真实Supervisor分配再申请接纳，不能跳过Core规则。
- browser-collaboration-report.json记录16个Owner/console四主题×1366/390场景，无水平溢出或JavaScript错误；键盘计划选择、预览、提交后只有1次采纳和2个子Task，Execution/Dispatch均为0，父项仍CREATED。另记录真实资源预留展示、合成缺失usage导致BLOCK_UNKNOWN及减少动态偏好。截图位于同run的screenshots-collaboration。浏览器使用独立库和synthetic canonical direct，不是实际真人或Provider请求；本轮不把截图结构检查称为像素复核。
- 官方闭包或本机脚本模型只能证明接缝，真实交付质量、人工协调时间、端到端时间和总成本需另行代表任务对照，未证明收益前协作不自动默认。主流程负责Flow最终验证/finalize、官方探针及独立视觉复核。
