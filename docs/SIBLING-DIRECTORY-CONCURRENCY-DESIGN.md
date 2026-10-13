# 同领地子目录并发：下一轮完整切片

状态：PROPOSED / NOT_IMPLEMENTED。此文冻结下一轮施工的最小边界，不声明真实 Runtime 已支持按子目录写入隔离。

## 偏移与关键问题（必须首先阅读）
- 设计偏移：NONE；同 Session 单 Lease、未知执行阻塞和 Capability fail-closed 保持不变。
- 最重要问题：资源接纳路径、Session cwd 和 Runtime 实际写根必须一致；当前没有按 attempt 收窄写根的真实证据。
- 未通过状态：Runtime 子目录写根 UNKNOWN / NOT_RUN；同领地兄弟子目录产品入口 NOT_IMPLEMENTED。
- 需要 Owner 裁决：实施前选择下述 Session 工作目录策略；本轮只提出方案。

## 当前源码与改动边界

`workspaceKeysOverlap` 已允许兄弟目录独立，保留其父子冲突判定。当前 `validateScope` 要求请求目录等于领地根，公开 governed 入口固定传领地根，Capability Gate 同样按领地根生成 enforcement request。仅放宽接纳会把锁缩到子目录而写权限仍覆盖父根，因此不能这样交付。

下轮需把单次 attempt 的资源目录作为受治理输入，由启动入口传到资源接纳、Session 策略和 Capability Gate，并持久化与 Dispatch/Lease 对应的事实。请求目录可以是领地根或其子树；领地范围外的祖先、兄弟、别名越界均拒绝。登记合法父目录时仍对重叠后代独占。

## 最小实现链

1. 定义 attempt 资源目录字段及其授权来源，Task/计划只能描述需求，不能扩大 Supervisor Grant 或 Owner Ceiling。
2. 复用 canonicalWorkspaceKey 的真实路径与现存祖先解析；接纳时和 TX-3 前都检查目录仍在领地根内，防止 junction/symlink 换向。
3. 公共启动与有界协作 item 显式传递资源目录，避免只改内部 helper。
4. 明确 Session 策略，不通过改 cwd 跨 Territory，也不绕过同 Session 单 active Lease。
5. Capability request、真实 Runtime 写根与资源接纳目录保持一致。必须经匹配版本的官方 API 核对和真实越界写探针；不能证明收窄就拒绝并发 WRITE。
6. 原子绑定资源、预算、Lease 和 Dispatch；恢复仍需可信终态、settlement 与 cleanup，不能因子目录分离豁免未知旧占用。

## Session 策略候选

原优先候选：Session 保持 Territory affinity，Runtime 每次 attempt 提供可证明的独立写根。第二轮已读取实际官方组件 0.1.5-rc.2 的 sandbox-policy 与 permission-presets 文档、类型和实现：公开请求只携带 Session/mode，写根来自不可变 SessionHeader.cwd，没有按 attempt 设置 workspaceRoot 的接口。该候选不能在这些公开接口上直接实施；其他实现途径的运行能力仍为 UNKNOWN / NOT_RUN。

备选：Worker 当前 Session 固定一个子目录，切换子目录时显式退役/替换 Session，并保留责任和关联历史。要核对现有 affinity/cwd 约束及配置入口后另行冻结，不能静默重建 Session。

下一轮应优先评估固定子目录 Session 的完整生命周期方案，并通过真实工具检查兄弟目录/父目录拒绝及临时目录例外。当前没有执行这些越界写探针，不据静态写根解析声称隔离已成立。

若两者均不可验证，继续使用领地根独占，不宣称子目录并发 WRITE 已完成。

## 旧占用与迁移

当前诊断分别标识资源 RESERVED、资源 BOUND、旧 Lease、非终态 Execution 和预算 RESERVED。迁移应先查询具名占用，核对真实执行、原 scope 与 cleanup，再由合法处置入口补齐资源记录或收敛。缺记录、缺进程所有权、目录不明、丢 receipt 均不能自动释放；不得通过降粒度登记把历史父根写权限伪装成子目录权限。

## 可观察验收

- 两个不同 Worker 在同领地 root/a、root/b 同时接纳；各自真实写入获准，写兄弟目录或父目录被 Runtime 拒绝。
- 登记 root 的 WRITE 阻挡 root/a 和 root/b；root/a 的 WRITE 阻挡其后代，同名路径前缀不被误判为祖先。
- 同 Worker/Session 的第二任务仍被 active Lease 拒绝，即使请求另一个子目录。
- READ_ONLY 共享对应真实只读 enforcement；与重叠 WRITE 互斥。
- 目录别名、缺失叶目录、junction/symlink 越界及接纳后改向在 dispatch 前拒绝。
- 旧 Lease、Execution、预算或资源准备缺证据时保持阻塞，并返回具名诊断。
- Capability materialize 或 cleanup 不明时不派发/不复用；崩溃后资源占用不能自动消失。
- 明确区分接纳单测、真实多进程数据库验证与真实 Runtime 越界写入验证；三者均有对应结果。

受影响契约：governed-start.supervisor-authz、collaboration.bounded-plan、governed-reconcile。下轮必须联动维护这些契约及失败路径测试。
