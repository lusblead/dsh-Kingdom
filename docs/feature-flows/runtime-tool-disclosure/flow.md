---
feature_id: runtime.tool-disclosure
title: Authorized native tool progressive disclosure
status: implemented
---

# 已授权原生工具的按需展示

本流程让已受 Capability Gate 限制的 Worker 在有限试点中先看到常驻、阶段和发现工具，再通过 kingdom_find_tools 找到本次执行已获准的其他工具。检索只改变下一步提示中的工具展示，不执行目标工具、不授权、不包装原生调用，也不创建新的持久状态。默认 off。合同按源码及五项结构型测试核对，保持 proposed，等待官方 DSH 接缝探针及最终集成验证；不宣称 Token 或任务总成本已下降。

## 入口、前提与结果

- 插件 apply 读取 toolDisclosure；off 不注册发现工具、不安装展示监听。pilot 注册工具，并将安装接缝交给运行适配器。
- 既有 restrict、单调拒绝 guard、sandbox/approval 证据及当前状态检查全部成功后，materializeDshEnforcement 才以准确 Agent 对象及 request.tools 安装监听。此授权集合记为 A；常驻或阶段配置不会扩大 A。
- 必须具备 Agent 本地 on、tools.schemas、tools.get；同一 Agent 不得重叠安装。安装异常使 materialize 失败并沿用既有清理，不带病派发。
- 成功结果为下一次装配中按原顺序保留的原生 schema，或有原因码的 A 内回退。错误身份、取消、无发现授权、非法查询直接拒绝。零匹配是合法空结果。
- 本流程不增加数据库、审计事件或权限状态。观察持久化属于 runtime.cost-control，本流程只给转换后的装配对象附加内存元数据。

## 运行流程

```mermaid
flowchart TD
    E1(["E1 插件配置与已通过的执行限制"]) --> D1{"D1 配置为 pilot"}
    D1 -->|否| X1(["X1 off：不注册发现工具或安装展示监听"])
    D1 -->|是| A1["A1 注册发现工具；既有 enforcement 成功后安装 Agent 监听"]
    A1 -->|成功| X2(["X2 等待当前 Agent 的装配或检索"])
    A1 -->|安装异常| X3(["X3 拒绝或抛出异常；不生成可用展示结果"])
    E2(["E2 system-prompt/assemble"]) --> A2["A2 等待后续 middleware 完成"]
    A2 -->|完成| D2{"D2 监听仍活跃且 context.agent 是原对象"}
    A2 -->|宿主异常| X3
    D2 -->|否| X4(["X4 原样返回其他 Agent 或失活装配"])
    D2 -->|是| A3["A3 验证 tools 数组，取 A 内 schema 并刷新目录"]
    A3 -->|装配结构非法| X3
    A3 -->|结构有效| D3{"D3 目录、发现 schema 或检索界限要求回退"}
    D3 -->|是| A4["A4 保留装配中全部 A 内原生 schema，记录 off 与原因"]
    D3 -->|否| A5["A5 仅保留发现、常驻、阶段及已发现工具，记录 pilot 字节观察"]
    A4 --> X5(["X5 返回当前获准原生工具面"])
    A5 --> X6(["X6 返回缩小后的原生工具面"])
    E3(["E3 模型调用 kingdom_find_tools"]) --> D4{"D4 原 Agent 活跃、有发现授权、未取消且查询合法"}
    D4 -->|否| X3
    D4 -->|是| A6["A6 刷新 A 内目录，按名称与说明匹配并排序"]
    A6 -->|目录读取异常| X3
    A6 -->|目录可读| D5{"D5 候选响应字节及累计发现数量未越界"}
    D5 -->|否| A7["A7 标记内存回退原因，返回下一步恢复提示"]
    D5 -->|是| A8["A8 记入本执行发现集合，返回有界原生 schema"]
    A7 --> X7(["X7 下一次装配恢复 A；不重发当前请求"])
    A8 --> X8(["X8 下一次装配可见；零匹配返回空列表"])
    E4(["E4 执行清理或插件卸载"]) --> A9["A9 先卸载监听，再清除发现集合与 Agent 关联"]
    A9 -->|成功| X9(["X9 该 Agent 不能再检索；重复 dispose 无副作用"])
    A9 -->|卸载失败| X3
    G1[["G1 展示与检索不越过 A；原 Capability Gate 决定实际调用"]] -.-> A3
    G1 -.-> A6
    G2[["G2 只改变本 Agent 的后续装配，不改已发出对象"]] -.-> D2
    G2 -.-> A8
    G3[["G3 目录内容或同名定义身份变化清除旧发现与回退"]] -.-> A3
    G3 -.-> A6
    G4[["G4 大 schema 不会被静默永久隐藏；回退也不扩权"]] -.-> A7
    G4 -.-> A4
```

## 组件时序

```mermaid
sequenceDiagram
    participant Plugin as Kingdom 插件
    participant Gate as 既有执行限制
    participant Host as DSH Agent 本地工具与装配
    participant Disclosure as 展示试点
    participant Model as 模型工具调用
    participant Observer as 独立成本观察器
    Plugin->>Disclosure: 创建 runtime，默认 off
    alt pilot
        Plugin->>Host: 注册 kingdom_find_tools
        Gate->>Gate: 验证 restrict、guard、sandbox、approval
        Gate->>Disclosure: install(准确 Agent, A)
        alt 安装成功
            Disclosure->>Host: 检查目录并订阅 system-prompt/assemble
            Host->>Disclosure: 本步装配
            Disclosure->>Host: await next()
            Host-->>Disclosure: 后续 middleware 结果
            Disclosure->>Disclosure: 只处理准确 Agent；筛选 A 并刷新目录
            alt 发现不可用或已有回退原因
                Disclosure-->>Host: A 内原生 schema；off 与原因码
            else 正常试点
                Disclosure-->>Host: A 内常驻、阶段、发现及已发现 schema
            end
            Observer->>Disclosure: metadata(转换后装配对象)
            Disclosure-->>Observer: 数量及 UTF-8 JSON 字节，未测 Token
            Model->>Disclosure: find(query, 原 Agent, signal)
            alt 授权或输入无效
                Disclosure-->>Model: 抛错，无发现集合更新
            else 查询有效
                Disclosure->>Host: 读取当前 A 内原生目录与定义身份
                Disclosure-->>Model: 有界匹配或下一步恢复 A 提示
                Note over Disclosure,Host: 发现只影响下一次装配，不重发本步请求
            end
            Gate->>Disclosure: 执行清理 disposer
            Disclosure->>Host: 卸载监听后删除内存状态
        else 安装失败
            Gate->>Gate: 沿用既有逆序清理，报告失败或清理未确认
        end
    else off
        Note over Plugin,Host: 不注册发现工具，不安装展示监听；沿用已有工具面
    end
```

## 界限与失败处理

- 常驻、阶段名单各至多 64 项；工具名必须符合限定格式。默认返回 3 项，允许 1–5；默认响应上限 12000 字节，允许 1024–64000。查询只允许 query，去空白后非空，原字符串至多 160 字符，最多取 8 个搜索词。按精确名称优先，再按名称和说明词匹配排序；不调用模型或远程检索。
- 最多累计发现 32 个工具。响应过大置 DISCOVERY_RESULT_TOO_LARGE，累计越界置 DISCOVERY_SET_LIMIT；下一步保留装配里的 A。目录或同名定义对象变化会清空发现集合及回退原因。
- 缺发现授权为 DISCOVERY_NOT_GRANTED；缺发现 schema 为 DISCOVERY_SCHEMA_UNAVAILABLE；装配时目录不可读为 TOOL_CATALOG_UNAVAILABLE。这些路径恢复 A，不自授发现权限。检索时目录异常直接传播；非法装配数组和后续 middleware 异常也直接传播，不伪造成功。
- await next() 沿用宿主装配的超时与失败处理，本层不增加超时、重试或请求重发。检索同步执行，仅在入口检查取消。卸载先调用宿主 disposer，成功后才声明失活；异常由既有 enforcement cleanup 报告，不能宣称清理完成。插件重新配置为 off 后重建 runtime，不恢复旧发现状态。
- 观察只包含 A 内 schema 的筛选前后数量、UTF-8 JSON 字节、实际本步模式及原因码；它不是最终供应商请求、缓存命中或 Token 账单。当前配置与历史观察分开显示。此层不记录查询、prompt 正文或目录内容到持久账本。

## 测试与尚待验证

tests/v14-tool-disclosure.test.ts 的五项测试映射：后续装配与 A 内发现；缺发现授权回退；目录及同名对象变化失效；大 schema 有界回退；off、错 Agent、非法输入、取消、重叠安装和正常清理。既有 S4/S6 测试覆盖原 enforcement 和清理机制。

五项测试使用结构型本地宿主与原 guard fixture，不能证明真实 DSH middleware 顺序、官方加载器接入或供应商收益。累计 32 项越界、目录异常、宿主卸载异常等源码分支在此五项测试中没有独立故障注入；本轮仅维护文档，不补写产品测试。官方接缝、真实模型请求、冷暖缓存配对和阶段验收由主流程记录，未取得证据前保持 proposed。没有新增持久生命周期，因此不绘制状态图。
