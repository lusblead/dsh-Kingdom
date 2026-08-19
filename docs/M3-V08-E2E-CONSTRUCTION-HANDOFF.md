# 交接 Prompt：v0.8 完整 Persistent Worker E2E（主路径 12–20 复验）

> 接收者：下一个 dsh-Kingdom 施工会话（无需前置上下文，自本 Prompt 开始）
> 提交：dsh-Kingdom 开发 agent（2026-08-19）
> 当前状态：**V0.8_RC = HOLD；RELEASE = NOT AUTHORIZED**；Blocker #2 根因已修复并复验（代码层 100/100 + 真实差分 B0–B3 全 PASS），**剩余唯一施工项 = 完整 Persistent Worker E2E（Owner 指令第 8 步）**。

---

## 0. 先验证，再执行（30 秒）

```text
1. 确认 dsh web 实例 PID（应为 19868，或记录新 PID）：Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -match 'bin\.ts web' }
2. 确认 E2E 测试库存在：C:\Users\ADMIN\AppData\Local\Temp\kingdom-e2e\kingdom-e2e.db（TEMP 全新 v4，与正式库隔离）
3. 确认修复后 lib 可加载：D:\dsh\kingdom\lib-e2e\（若不存在：Remove-Item + Copy-Item D:\dsh\kingdom\lib D:\dsh\kingdom\lib-e2e -Recurse）
4. 全量回归（若未跑过）：node --test tests/*.test.ts（应 100/100）
若上述任一失败 → STOP 报告，不施工。
```

## 1. 背景（必读，30 秒）

dsh-Kingdom v0.8 = Persistent Governed Worker。S2(Schema v4+Domain) / S3(Adapter) / S4(Capability) / S5(Dispatch Evidence) / S6(Gate) 已施工并有 100 项测试。Blocker #2（真实模型 turn 导致 DSH 实例退出）根因已定位并修复：

```text
根因：readEnforceableSet 把 session 事件 permission/preset 的值（PermissionPresetService 预设名 "workspace-write"）
     错当 agentPresetId 传给 agentPresets.resolveMountable（两套体系混淆）；且 resolveMountable 是 async 但未 await
     → rejected Promise 未消费 → unhandledRejection → DSH installFailLoud → process.exit(1) → 实例退出
修复（已实施）：① DshEnforcementContext.agentPresetId 严格分离（permission/preset 值绝不进 agentPresets）
               ② readEnforceableSet 异步化 + await resolveMountable + try/catch 消费 rejection
               ③ normalizeToolInventory 不把 preset 元信息 name（如"标准模式"）当工具名（回退 session 装配面）
               ④ RuntimeAdapter.capabilities() → Promise<RuntimeEnforceableSet>
复验：代码层 100/100；真实差分 B0(bare)/B1(+affinity)/B2(+lease)/B3(+capabilities+resolver+preflight)
     全 PASS（PID 19868 不变、无 fatal、completed+assistant、B3 resolve coverage=FULL）
```

权威文档（按需读）：
- `D:\dsh\kingdom\docs\M3-V08-BLOCKER2-DIFFERENTIAL-ISOLATION.md`（根因证据 + 修复 + 复验矩阵）
- `D:\dsh\kingdom\docs\M3-V08-REAL-DSH-E2E-REPORT.md`（此前 E2E 部分证据与历史）
- `D:\dsh\kingdom\docs\STABILITY-FINDINGS.md`（调查 agent 结论，含 terminal outcome 收敛映射）

## 2. 本轮唯一任务：完整 Persistent Worker E2E（主路径 12–20）

Owner FINAL REAL-DSH VALIDATION WINDOW 指令：使用隔离、低负载、日志可保留的真实 DSH 实例，补跑：

```text
first governed execution → terminal → Claim → REWORK → SAME session_ref
→ second governed execution → terminal → cleanup → Lease RELEASED
```

### 必须记录（每个值都要落日志与报告）
```text
host PID（before/after，全程不得变化）
first/second session_ref（second 必须 == first —— H 断言）
dispatch refs（runtime_dispatch_ref）、execution refs（runtime_execution_ref）
turn/end reason、assistant/message presence
final execution state（应为 COMPLETED ×2）、final lease state（应为 RELEASED）、final task state（REVIEW）
```

### 建议执行方式（已验证可行的分步模式）
用 staging 工具（super-injector）在实例进程内执行，**每步短调用**（避免长阻塞超时）：
1. **e1**：resession（retire 旧 affinity → AgentRegistry.create 新 session → establishAffinity）→ runCapabilityGate（grant={tool:code_check,tool:notify}，requirement/ceiling 同）→ GRANTED+ENFORCED → createGovernedExecution → createDispatchIntent → advanceLeaseState(EXECUTING) → adapter.dispatch(极简 prompt「只回复：OK。不要调用任何工具。」) → recordDispatchReceipt → 记录全部 refs → 返回（不等待）
2. **e2**：读 live session 事件链（reconstructDispatchEvidence with runtimeDispatchRef）→ 若 completed+assistant → recordTerminalEvidence(executionTerminalState='COMPLETED', settleLease=true) → 落 Claim（insertWorkerResult + transitionTask→REVIEW，summary=assistant 文本）→ 记录终态
3. **e3**：REWORK（reviewTask decision='REWORK' 或 store.transitionTask(REVIEW→RUNNING)+事件）
4. **e4**：ensureWorkerSession（应有 current affinity → **resume 同一 session_ref**，断言 == first）→ 新 lease（attemptNo 递增）→ gate → execution → intent → followup → receipt → 返回
5. **e5**：第二次 terminal → Claim → REVIEW（同 e2）
6. **e6**：adapter.cleanup + settleAndRelease(cleanupOk=true) → lease RELEASED → 断言 getActiveLeaseForSession(session)==null（session 可复用）→ 汇总写报告

### 关键踩坑（负知识，勿重踩）
```text
1. ESM 缓存：实例进程按 URL 缓存 lib 模块——每次改 lib 后用【新目录名】复制（lib-e2e → lib-e2f…），
   或等实例重启；同目录重复制不会刷新缓存（实测 lib-v3 失效）。
2. attemptNo：必须用 store.listLeases(kingdomId) 的 max(attempt_no)+1（不是 maxExecutionAttemptNo——
   executions 表不含"只有 lease 无 execution"的 attempt，会撞 UNIQUE(task_id,attempt_no)）。
3. 极简 prompt + 短调用：真实模型 turn 约 1–3s；等待用轮询（每 2s × 最多 6 次），不要长同步阻塞。
4. 日志保全：staging execute 开头注册 process.prependListener('unhandledRejection'/'uncaughtException')
   写 stack 到 C:\Users\ADMIN\AppData\Local\Temp\kingdom-e2e\fatal-<kind>.err.log（不改 DSH 源码）。
5. permission/preset 事件值是 PermissionPresetService 预设名（workspace-write），≠ agentPresetId（standard）——
   materialize 的 permission.set 用它；capabilities 的 B 面只用 context.agentPresetId。
6. 若再次实例退出：STOP，保存证据（PID 变化 + fatal log + 持久 session log 的 turn/end reason），
   不重试第三次、不现场改代码（报告 suspected layer）。
```

## 3. 边界与红线（不变）

```text
禁止：正式 kingdom.db migration / commit / tag / push / publish / GUI 施工 / Release / Context Governance
     / 修改 Schema / 修改 M3-S1・v6 冻结语义 / 降级 one-shot / 关闭 fail-closed / 修改 DSH 上游源码
正式 DB：C:\Users\ADMIN\.dsh\kingdom\kingdom.db 保持 v3（只读核实：MAX(schema_version)=3，无 v4 表）
terminal outcome 映射（保持修复）：completed+assistant→COMPLETED；aborted→ABORTED；
  blocked/error/max-tokens→FAILED；interrupted→RECOVERING；ambiguous/missing→RECOVERING
```

## 4. 完成条件与输出

```text
完成 = 主路径 12–20 全部真实闭环：
  first/second session_ref 相同（H）· terminal×2（completed+assistant）· Claim×2 → REVIEW
  · REWORK· cleanup· Lease RELEASED· session 可复用（无 active lease）
  且 PID 全程不变、fatal-*.err.log 无新增、无 interrupted
输出 = 更新 D:\dsh\kingdom\docs\M3-V08-REAL-DSH-E2E-REPORT.md（§7.2 之后追加"完整 E2E"节，
      含全部 required 记录字段 + 最终三态）
完成后重新进入 HOLD 并呈报 Owner Review（E2E 通过 → Blocker #2 可评估关闭 → RC 重评）。
```

## 5. 交接工具与状态

- 复用 staging 工具（super-injector 后侧）：`kingdom_v08_e2e_*`（bcase/final 系列；若实例重启后工具被 purge，
  用 dev_stage_add 重建，execute 逻辑见本 Prompt §2 步骤描述 + 旧工具名可参考 e2e-bcase.log 输出格式）
- E2E 状态文件：`C:\Users\ADMIN\AppData\Local\Temp\kingdom-e2e\e2e-state.json`（kingdom/worker/task/session refs）
- 运行日志：`e2e-bcase.log` / `e2e-final.log` / `fatal-*.err.log`（均为 append，不覆盖）
- 持久 session log 读取：实例内 `ctx.get('sessionPersistence').load(sessionId)`（zstd 压缩，不可直接读文件）
