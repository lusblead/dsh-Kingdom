# M3-S6 Release Gate Report（v0.8 · G1–G12）

> 日期：2026-08-19
> 依据：Owner v0.8 施工 Prompt §31（S6 不写新设计，只执行既有 Gate）
> 结论：**G1–G12 全部 PASS（84/84 全量测试 + PoC 实证引用）**；RC 未被阻塞。

---

## Gate 逐项证据

| Gate | 判定 | 证据（测试/源码/实证） |
|---|---|---|
| **G1 只有真实 ENFORCED 才能声称生效** | ✅ PASS | v6 行内双向 CHECK（GRANTED⇔ENFORCED，Direct SQL A-1..A-6）；S4 gate 仅 materialize 成功才写 GRANTED+ENFORCED（`m3s2-v4-s4-capability.test.ts`） |
| **G2 Cannot Enforce → zero execution** | ✅ PASS | S4 gate：ceiling 缺失→DENIED+UNAVAILABLE、materialize 失败→DENIED+FAILED，均无 Execution/Dispatch（S4 测试 3 项断言零执行） |
| **G3 Territory/workspace 外写真实拒绝** | ✅ PASS* | PoC E 组实证（C-011：界外写 `[sandbox: file access denied under workspace-write mode]`，outside.txt 从未产生）；S4 接线：workspace-write 映射 + preflight 要求 territoryPath + sandbox/mode 事件证据（*真实文件拒绝需 DSH 实机，注入阶段 S6-E2E 复核） |
| **G4 无自授/超 Ceiling/scope 外/partial fail-closed** | ✅ PASS | S4 resolver 测试（grant 缺→NONE、超 ceiling→NONE、ceiling null→全拒）；S4 gate 测试（coverage≠FULL→DENIED+NOT_ATTEMPTED） |
| **G5 evidence 强度诚实描述** | ✅ PASS | S6 G5/G9 测试：evidence 只含真实应用事实；serialized 断言不含 kernel/os-level/isolated vm；声明强度=证明强度 |
| **G6 Scoped Tool Bypass 被阻止** | ✅ PASS | S4 enforcement 测试：guard 对未授权工具返回拒绝理由（`capability not granted`）、restrict 只挂 allow 清单；PoC C 组实证 body 不执行 |
| **G7 并发 Execution policy 不串线** | ✅ PASS | S6 G7 测试：同 session 连续 materialize+cleanup 精确配对；不同 session disposer registry 隔离 |
| **G8 Escalation 不能扩大权限** | ✅ PASS | S4 enforcement：approvalPolicy=never 强制（preflight 拒绝非 never）；PoC D 组实证每个 ask rejected |
| **G9 trusted path containment 不冒充 kernel sandbox** | ✅ PASS | S6 G5/G9 测试（见 G5）；证据只声明 workspace-write 路径围栏 |
| **G10 同 Session 并发 acquire Lease 唯一成功** | ✅ PASS | DB 部分唯一索引 `lease_one_active_per_session`（Direct SQL A-10 + S6 G10 测试 UNIQUE 拒绝） |
| **G11 旧 Execution 未 reconcile 前不得开新 Attempt** | ✅ PASS | S6 G11 测试：RECOVERING 未释放 → UNIQUE(task_id,attempt_no) + one-active-per-session 双拒绝；reconcile 完成（带证据释放）后才可开新 lease |
| **G12 Foreign/Unmanaged Dispatch 不得静默污染** | ✅ PASS | S5 evidence G12 检测（外来 user 消息）+ S6 G12 测试：即使 terminal 事件存在，外来消息 → UNTRUSTED_RECOVERING（最高优先级，禁 settle/release 声称可信） |

## 全量证据基线

```text
Python v6 verifier ......... 49/49 PASS（v6 DDL 权威）
Kingdom 全量测试 ............ 84/84 PASS
  其中：S2 schema/domain 22 · S3 adapter 8 · S4 capability 11 · S5 dispatch 5 · S6 gate 5
     + 既有回归 33（execution-truth/governance/m1d-matrix/m2-organization/territory）
```

## 实机缺口（诚实声明，非阻塞）

- G3 真实文件写拒绝 / G6 真实 guard 拒绝 / G8 真实 approval 拒绝：PoC 已在 DSH 实机实证（E/C/D 组，C-011/C-009/C-018）；v0.8 的 governed 全链路实机 E2E（create→affinity→gate→dispatch→receipt→terminal→release）在**运行实例注入阶段**执行（poc 前缀隔离），届时作为 RC 最终证据。

## 结论

**G1–G12 全 PASS → v0.8 RC 未被阻塞。** 进入下一阶段：GUI 最小 Runtime Governance 接线 → Legacy 全回归 → v0.8 RC。
