---
feature_id: runtime.runner-context-transport
title: Bounded local RunnerContext transport
status: implemented
---

# 本地 RunnerContext 传输

本文只覆盖已实现的本地启动、认证连接、读取与关闭，不把进程间通信成功当作 Provider 执行、治理结算或 Lease 释放。真实 Provider runner 模式仍由原合同说明。

Product 使用绝对 runRoot，在其 .local/runner-context-broker 目录创建一次性描述文件和本地端点。Windows 使用原命名管道；Unix 使用 nonce 前20个base64url字符（120 bits）作为文件名，完整nonce继续参加认证。依照 [Node net 文档](https://nodejs.org/api/net.html#ipc-support)，Unix端点在任何文件或服务副作用前限制为103个UTF-8字节；超过时要求缩短runRoot。不会移到公共临时目录或删除无主socket。

```mermaid
flowchart TD
 E1([E1 Product请求本地launch]) --> D1{D1 绝对安全root且端点长度受支持}
 D1 -->|否| X1([X1 明确拒绝，未创建launch资源])
 D1 -->|是| T1[T1 安全目录中排他写描述文件并监听]
 T1 -->|失败| X1
 T1 -->|就绪| E2([E2 子进程提交准确bootstrap并连接])
 E2 --> D2{D2 描述文件属于当前环境且完整nonce认证成功}
 D2 -->|否| X2([X2 关闭不可信连接，无Product动作])
 D2 -->|是| A1[A1 单认证连接有界只读视图，定序防重放]
 A1 --> E3([E3 Product明确关闭或上下文撤销])
 E3 --> T2[T2 关闭自有连接服务并清理自有描述文件和端点]
 T2 --> X3([X3 仅报告传输资源关闭；不结算任务])
 G1[[G1 精确端点及完整nonce认证，短文件名不产生权限]] -.-> D2
 G2[[G2 路径检查和排他创建；只清理本launch确认持有的资源]] -.-> T1
 G2 -.-> T2
```

```mermaid
sequenceDiagram
 participant Product
 participant Broker
 participant OS
 participant Child
 Product->>Broker: createRunnerContextBrokerLaunch(runRoot)
 Broker->>Broker: 安全root与端点字节长度检查
 alt 超出Unix限制
  Broker-->>Product: SOCKET_PATH_TOO_LONG，未创建资源
 else 范围合法
  Broker->>OS: T1 安全目录、排他描述文件、本地监听
  Broker-->>Child: 准确序列化bootstrap
  Child->>Broker: 描述文件校验和完整nonce挑战应答
  Broker-->>Child: 有界视图或拒绝连接
  Product->>Broker: close
  Broker->>OS: T2 仅关闭和清理自有资源
 end
```

```mermaid
stateDiagram-v2
 [*] --> READY: T1 安全路径且启动成功 / 自有描述文件及端点
 READY --> CLOSED: T2 明确关闭 / 自有文件和连接清理
```

认证前每个连接有五秒超时，消息大小、FIFO、版本及请求重放继续受原broker约束。监听失败只清理已能证明本launch拥有的资源；不删除造成冲突的外来socket。创建前路径拒绝没有重试，用户可选择更短root重新启动。关闭不确定性保持拒绝，不产生执行结算证据。

验证涵盖：当前公共连接及跨进程bootstrap、错误描述文件/nonce/重放、单连接、关闭所有权；Unix UTF-8路径超长时目录保持空。Windows专项与Linux CI分别记录，未执行的平台不推断通过。
