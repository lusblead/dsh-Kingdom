---
feature_id: gui.owner-control
title: Bounded human Owner GUI control
status: implemented
---

# GUI 人类管理窗口

人类从 canonical 直接 `/kingdom owner.gui` 入口建立范围明确、至多10分钟的 OwnerDecision。浏览器只消费该决定，Owner 永远是稳定的人类 principal。独立于 Role Plane，不创建 Agent 权限、任务裁定或记忆。

1.5 增加 `plan.adopt`：目录只呈现完整 Scope 覆盖的 PROPOSED 计划；预览固定计划 ID、版本、摘要、理由、成员范围/验收/依赖/产物、整合者与预算。提交在同一事务创建子 Task、采纳事件与 Owner 回执，不产生 Assignment、Grant 或 ACCEPT。准确协作流程见[有界协作](../collaboration-bounded-plan/flow.md)。

## 流程

```mermaid
flowchart TD
    E1(["E1 人类直接激活准确管理范围"]) --> D1{"D1 canonical能力、王国、动作、范围和期限合法"}
    D1 -->|否| X1(["X1 拒绝，不建立可写窗口"])
    D1 -->|是| T1["T1 记录有界OwnerDecision；空库bootstrap暂存内存"]
    T1 --> A1["A1 一次性ticket兑换独立Owner Cookie，清理URL"]
    A1 --> E2(["E2 网页准备结构化变更，含类型化软预算参数"])
    E2 --> D2{"D2 传输校验和决定有效，动作及资源在范围内"}
    D2 -->|否| X2(["X2 保留输入，拒绝写入"])
    D2 -->|是| A2["A2 核验相关目标或预算政策，固定规范化参数与事实版本"]
    A2 --> X3(["X3 返回准确影响预览及准备ID"])
    X3 --> E3(["E3 先保留准确决定及操作引用，再明确提交"])
    E3 --> T4["T4 标签页保留准确待确认引用"]
    T4 -->|存储失败，未发送| X2
    T4 -->|已保存，发送| D3{"D3 本操作已有同内容receipt"}
    D3 -->|是| X4(["X4 返回原receipt，不重复写入"])
    D3 -->|否| D4{"D4 决定仍有效，相关事实未变且动作特定检查通过"}
    D4 -->|否| X2
    D4 -->|是| T2["T2 精确一次性能力执行业务、Owner来源事件及receipt，同事务"]
    T2 --> X4
    E4(["E4 撤销、到期、替换或卸载"]) --> A3["A3 使内存写能力及等待中的校验失效"]
    A3 --> D5{"D5 显式撤销仍活跃的已有王国决定"}
    D5 -->|是| T3["T3 追加Owner决定撤销事件"]
    D5 -->|否| X5
    T3 --> X5(["X5 窗口不可再写，已有结果可核对"])
    E5(["E5 丢响应或刷新后恢复并查询原操作"]) --> D6{"D6 Cookie、原决定编号和只读宽限均匹配"}
    D6 -->|是| A4["A4 只读原决定中的准确操作回执"]
    D6 -->|否| X6(["X6 结果未知；显示原编号，不自动重发"])
    A4 --> D7{"D7 已有匹配回执"}
    D7 -->|是| X4
    D7 -->|否| X6
    X4 --> T5["T5 清除本标签页已确认引用"]
    X2 -->|明确陈旧预览或已回滚| T5
    G1[["G1 Agent与旧Role Cookie不产生Owner能力"]] -.-> D1
    G1 -.-> D2
    G2[["G2 提交只引用已准备内容；原子且幂等"]] -.-> T2
    G3[["G3 异步校验后重验，撤销不等待普通busy"]] -.-> D4
    G3 -.-> A3
    G4[["G4 查询绑定原决定；替换窗口不能被误报为未执行"]] -.-> D6
    G4 -.-> A4
```

## 组件交互

```mermaid
sequenceDiagram
    actor Human
    participant Slash
    participant Browser
    participant Broker
    participant Core
    participant Runtime
    participant Store
    Human->>Slash: owner.gui 严格范围JSON
    Slash->>Core: canonical能力激活有界决定
    Core->>Store: 已有王国记录决定事件
    Slash->>Broker: 建立一次性ticket
    Broker-->>Browser: 兑换后303到无ticket的/owner
    Human->>Browser: 选择结构化动作并准备
    Browser->>Broker: prepare + 独立Cookie/CSRF
    Broker->>Core: opaque决定handle及业务参数
    opt 动作涉及Session或模型
        Core->>Runtime: 有界核验目标Session或模型
        Runtime-->>Core: 当前可核验结果，不授予权限
    end
    opt budget.policy
        Core->>Store: 核对王国级范围和schema V4，读取政策并固定版本
    end
    Core-->>Browser: 规范化准确预览和准备ID
    Human->>Browser: 提交预览
    Browser->>Browser: sessionStorage仅保留decisionId/prepareId/operationId；失败则不发送
    Browser->>Broker: prepareId + operationId
    Broker->>Core: 重新检查撤销、Scope和相关对象
    alt 已有同内容结果
        Core->>Store: 查准确operation receipt
        Store-->>Browser: 原结果
    else 可以执行
        Core->>Store: 同一事务业务事实、Owner来源事件、receipt
        Store-->>Browser: 已提交receipt
    else 过期、撤销、对象变化、冲突或未知
        Core-->>Browser: 拒绝或先对账，不重复执行
    end
    opt 提交响应丢失或同标签页刷新
        Browser->>Broker: 原decisionId及operationId，只查询receipt
        Broker->>Core: 无新操作ID，无自动重发
        Core-->>Browser: 已应用或尚未确认
        Note over Browser,Broker: 窗口被替换或5分钟宽限结束时拒绝核对，不推断未执行
    end
    Human->>Broker: 撤销当前窗口，不等待普通busy
    Broker->>Core: 使决定/异步校验信号失效
```

## 持久事实

```mermaid
stateDiagram-v2
    [*] --> DECISION_RECORDED: T1 已有王国直接激活 / 记录来源及范围
    DECISION_RECORDED --> OPERATION_APPLIED: T2 有效精确提交 / 同事务业务及receipt
    OPERATION_APPLIED --> OPERATION_APPLIED: T2 后续另一个合法准备操作 / 追加独立receipt
    DECISION_RECORDED --> REVOKED: T3 显式撤销活跃窗口 / 追加撤销事件
    OPERATION_APPLIED --> REVOKED: T3 显式撤销活跃窗口 / 已提交事实不回退
    [*] --> OPERATION_APPLIED: T2 空库单次bootstrap / 初始化和决定引用及receipt同事务
    state "标签页会话存储，不含权限" as BrowserPending {
        NO_PENDING --> PENDING: T4 发送前 / 保存准确决定及操作引用
        PENDING --> NO_PENDING: T5 匹配回执或明确拒绝 / 清除引用
    }
```

## 边界与失败处理

- ticket 30秒、写入授权至多10分钟、服务端时间、固定127.0.0.1 Origin和Host、CSRF、SameSite Strict。Cookie仅引用内存窗口，并额外保留5分钟只读receipt查询期，以支持到期前提交丢响应后的核对；服务端同样检查此宽限，不依靠浏览器删Cookie实施期限。未认证页面不返回scope内目录，旧Role Cookie不接受。URL票据不进入日志、错误、事件、Referer或本地存储。
- first bootstrap只初始化姓名/王国名且OWNER.session_id=null，消费后不能扩大管理范围；重启不恢复可写窗口。历史决定与receipt保留在原事件账本。
- 支持init、territory.create/update/supervisor、非OWNER role.bind、主管/宰相role.session、王国ceiling、execution-profile、budget.policy、revoke。既有Territory路径和Worker affinity不通过便捷配置隐式改变。
- budget.policy 要求明确动作授权、王国级范围及schema V4。表单产生enabled布尔值、limit_tokens/reserve_tokens正安全整数、unknown_policy BLOCK或WARN、warning_percent 1至100（默认80）；预留不能超过额度，关闭也要求合法参数。准备固定当前政策和规范化字段，提交重验相关事实，沿用准确一次性能力、同事务政策事件/Owner来源/receipt。预算接纳计算归runtime.cost-control，不增加便捷写接口。
- 预算是新增执行的软接纳政策，不是供应商费用硬上限。此动作允许调整未来政策而保留在途工作，不使用拓扑变更的未决执行阻断规则；关闭不重置统计起点，不派发、终止、结算或释放工作。
- 创建目录必须存在、规范化且位于明确授权根；不创建目录、不执行命令。改绑、主管分配、ceiling、profile遇受影响的非终态Execution、未释放Lease或未结算Dispatch时拒绝。
- 校验Session只用真实registry，模型核验只证明当前路由元数据有效，保存不等于实际执行成功。默认异步校验10秒、最高30秒；撤销与超时中止校验，回调之后再核验。事务体没有await。
- 规范化参数与相关对象版本固定在服务端。浏览器不能替换业务参数或principal。相同operation与内容只形成一次receipt；异内容拒绝。异常事务回滚；响应丢失只能查询，不换ID重发。
- 查询必须携带原页面固定的decisionId；新窗口替换同名Cookie时返回明确的窗口替换错误，旧页保留原编号，不把跨窗口查不到解释为未执行。到期/替换/卸载只使内存权力失效；显式撤销仍活跃的已有王国决定才另写撤销事件，不虚构其他持久状态迁移。
- authorization_source=LOCAL_DIRECT_SLASH、source_channel=LOCAL_OWNER_GUI，actor_id=稳定Owner principal；不回写历史渠道。短期transport凭据只在内存。
- trusted-local 不等于每次点击真人在场证明；不声称有Windows Hello/WebAuthn。合成传输测试、官方DSH接入、真实人类输入和产品验收分别记录。

实现与测试映射在traceability.yaml按当前源码核对。1.4表单类型化、缺值/小数/预留超额校验映射tests/v14-cost-gui.test.ts；主流程browser-cost-report.json已记录键盘预算准备/提交和Core预算状态验证，Owner及usage为合成输入，不代替真实人类激活或Provider证据。本轮仅维护文档，不重跑产品测试。

发布修复：确定 PREVIEW_STALE 或明确事务回滚时保留输入、清除旧预览并允许重新预览；未知结果保留原引用，刷新优先核对回执，禁止新提交。存储不含票据、Cookie、CSRF或业务参数；新窗口不替代旧决定。窄屏完整显示只读计划指纹。
