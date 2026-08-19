# M3-V08-BLOCKER2-DIFFERENTIAL-ISOLATION（Blocker #2 差异定位报告）

> 日期：2026-08-19
> 状态：**根因 CONFIRMED**（unhandledRejection fatal stack 已捕获；证据链完整）
> 当前：V0.8_RC = HOLD；RELEASE = NOT AUTHORIZED；Blocker #2 定位完成，等待 Owner 授权修复

---

## A. Baseline（B0）

| Case | 动作 | PID before | PID after | turn/end reason | assistant | 结果 |
|---|---|---|---|---|---|---|
| B0 | 裸 `AgentRegistry.create` + followup（「只回复：OK」） | 38364 | 38364 | completed | ✓ | **PASS** |

## B. Difference Matrix（B0–首个失败边界）

| Case | Affinity | Lease | Resolve+Preflight | Materialize | Execution | Intent | Receipt | Correlate | 结果 |
|---|---|---|---|---|---|---|---|---|---|
| B0 | — | — | — | — | — | — | — | — | **PASS** |
| B1 | ✓ | — | — | — | — | — | — | — | **PASS** |
| B2 | ✓ | ✓ | — | — | — | — | — | — | **PASS** |
| B3 | ✓ | ✓ | ✓ | — | — | — | — | — | **EXIT**（实例退出） |
| B4+ | 按 Owner 指令：找到首个边界即停止，未继续 | | | | | | | | — |

## C. First Failing Boundary

```text
Last PASS  = B2（affinity + lease + followup → completed，PID 未变）
First EXIT = B3（新增 resolve + preflight 后，实例退出：PID 38364 → 19868，09:11:15 重启）
Added feature = adapter.capabilities(context)（内部触发 readEnforceableSet → presets.resolveMountable）
Suspected layer = S4（Capability Resolver / Enforcement seam：readEnforceableSet）
```

**关键**：B3 未包含 materialize（无 restrict/guard/sandbox/approval）——**退出与 materialize 无关**；边界在「首次调用 `capabilities()`（A∩B seam）」处。

## D. Runtime Evidence

### 1. fatal stack（prependListener 日志保全捕获，`fatal-unhandledRejection.err.log`）
```text
{"t":"2026-08-19T09:10:36.361Z","kind":"unhandledRejection","pid":38364,
 "stack":"Error: agent-presets: preset \"workspace-write\" not found
   (available: standard, code, minimal, cordis, anchored-standard, router-standard)
    at Proxy.resolve (D:\\deepseek-harness\\packages\\preset\\agent-presets\\src\\index.ts:218:13)
    at async Proxy.resolveMountable (D:\\deepseek-harness\\packages\\preset\\agent-presets\\src\\index.ts:234:20)"}
```

### 2. 时间线
```text
09:09:43 B0 PASS（pid 38364）
09:09:50 B1 PASS
09:09:58 B2 PASS
09:10:36 unhandledRejection 捕获（B3 内 capabilities → resolveMountable('workspace-write')）
09:11:15 self-heal 记录重启（实例 PID 38364 → 19868）
```

### 3. 因果链（自洽，覆盖全部历史退出）
```text
B3/gate 调用 adapter.capabilities(context)
→ readEnforceableSet(ctx, {presets})   [src/capability/dsh-enforcement.ts]
→ deps.presets.resolveMountable(lastPreset)
     lastPreset = session 事件 permission/preset 的值为 "workspace-write"（standard preset 装配时写入的值）
     resolveMountable 是 async：返回 rejected Promise（preset "workspace-write" 不存在）
→ 调用处【未 await】→ rejected Promise 未被消费
→ unhandledRejection
→ DSH installFailLoud（packages/boot/app-boot/src/index.ts:609-648）
→ process.exit(1)
→ 实例退出 → crash recovery 合成 turn/end {kind:"interrupted"}
```

### 4. 与历史证据闭合
- attempt 4/5/6/7（governed gate 路径）全部退出：gate 必调 capabilities → 同一 unhandledRejection；
- 裸探针（调查 agent + B0/B1/B2）成功：**不调用 capabilities / resolveMountable**；
- S4 seam 修复前（view() 版）attempt 1–3 在 gate resolution 即 DENIED（tools=0），未到达 followup，且**无 resolveMountable 调用**——与「修复后才开始退出」的时间线一致；
- 「followup 后模型 turn 期间退出」是表象：followup 入队与 gate 的 unhandledRejection 在同一工具调用内先后发生，实例在 gate 产生的未消费 rejection 的 fail-loud 时机退出。

### 5. 逐项核对（Owner 指令 §9 disposer/lifecycle 检查项）
| 检查项 | 结论 |
|---|---|
| disposer 意外提前执行 | 无关（边界在 capabilities，未到 materialize/cleanup） |
| plugin fiber/effect 生命周期 | 无关 |
| scope 在 followup 运行时 unwind | 无关 |
| guard/restrict 注册后未处理 rejection | **否——是 resolveMountable 的 rejected Promise 未消费** |
| setup callback 异步异常 | 无关（standard preset 装配正常） |
| 调用返回后自动清理 Runtime 能力面 | 无关 |

## E. 判断

```text
CONFIRMED
```
- 直接证据：unhandledRejection fatal stack（preset "workspace-write" not found，resolveMountable async 抛错）；
- 边界实验：B0/B1/B2 PASS → B3（首次 capabilities）EXIT；
- 闭合性：全部 4 次 governed 退出均可由该单一根因解释；裸探针路径不触达该代码。

## F. 建议的最小修复（待 Owner 授权实施；涉及接口变更，不擅自执行）

**根因**：`src/capability/dsh-enforcement.ts::readEnforceableSet` 调用 `deps.presets.resolveMountable(lastPreset)` 未 `await`（async 函数），rejected Promise 泄漏为 unhandledRejection。

**候选修复（择一，均不改 Schema/冻结语义/Scope）**：
1. **A（推荐，语义完整）**：`readEnforceableSet` 异步化（`await resolveMountable`，try/catch 消费 rejection）→ `RuntimeAdapter.capabilities()` 改 `Promise<RuntimeEnforceableSet>` → Resolver/service 调用方 `await`；fake/测试同步返回值经 `await` 兼容。preset 面（B）真实生效。
2. **B（最小、fail-closed）**：不异步化接口——`Promise.resolve(deps.presets.resolveMountable(lastPreset)).catch(() => {})` 消费 rejection；preset 面因无法同步取 async 结果而回退 session 装配面（功能上 B 面退化，但不再触发退出；语义降级，需 Owner 认可）。
3. **C（组合）**：A + 对 `permission/preset` 事件的 preset 名做合法化校验（unknown preset 名不进入 resolveMountable，直接回退 inventory）——防御 future 同类。

**推荐 A+C**（await + preset 名校验）；修复后跑全量回归 + 单次 B3/B4 复验确认不再退出。

---

# 追加：OWNER BLOCKER #2 CONFIRMED — MINIMAL FIX 已实施并复验（2026-08-19）

## G. 根因最终确认（数据来源 + async 边界）

```text
数据来源错误：
  readEnforceableSet 把 session 事件 permission/preset 的值（PermissionPresetService 预设名 "workspace-write"）
  错当 agentPresetId 传给 agentPresets.resolveMountable —— 两个不同体系（permission preset vs agent preset）。

async 边界错误：
  resolveMountable 是 async；调用处未 await → rejected Promise（preset 不存在）未被消费
  → unhandledRejection → DSH installFailLoud → process.exit(1) → 实例退出（BLOCKER #2 全部 4 次退出同根因）
```

## H. 已实施的最小修复（Owner 授权，2026-08-19）

1. **概念严格分离**：`DshEnforcementContext` 新增 `agentPresetId`（真实 agent preset：standard/code/minimal/…）；`readEnforceableSet` 的 B 面**只用 `context.agentPresetId`** 调 `agentPresets.resolveMountable`；`permission/preset` 事件值仅作为 `RuntimeEnforceableSet.presetId`（permission preset 信息，供 materialize 的 `permission.set` 使用），**绝不**进入 agentPresets；
2. **数据来源修复**：追踪确认 "workspace-write" 来自 `permission/preset` 事件（PermissionPresetService 预设名）；修复后该值不再被传往 `agentPresets.resolve/resolveMountable`；
3. **A∩B 冻结语义维持**：Runtime Tool Surface = Actual Runtime Inventory ∩ Actual Agent Preset/Session Tool Surface；并修正 `normalizeToolInventory`——`resolveMountable` 返回 preset 元信息（`{id,name:'标准模式',…}`）时不再误取 name 为工具名（顶层/嵌套对象 name 不提取，仅数组元素 name），preset 面无法证明 → 回退 session 装配面（live schemas）；
4. **async 边界**：`readEnforceableSet` 异步化，`await resolveMountable` + try/catch 消费一切 rejection；`RuntimeAdapter.capabilities()` → `Promise<RuntimeEnforceableSet>`，Resolver/service 调用方 await；探测失败 → 空面 → resolver DENIED → zero execution（CANNOT_ENFORCE 语义），无未处理 rejection 泄漏；
5. **回归测试 A–D**（`tests/m3s2-v4-s4-capability.test.ts`）：
   - A：agentPreset=standard + sandbox 事件 workspace-write → resolveMountable 只收到 'standard'，永不被传 'workspace-write'；
   - B/C：resolveMountable 同步抛错 / async reject → 被捕获回退，`unhandledRejection` 计数为 0（不泄漏）；
   - D：正常 standard preset → A∩B 正确得到工具面；
   - 另加：preset 元信息对象（resolveMountable 真实返回形态）→ normalizeToolInventory → []；
   - **全量 100/100 PASS**。

## I. 真实差分复验（B0–B3，PID 19868，全部 PASS）

| Case | 动作 | PID before | PID after | capabilities.tools | resolve coverage | preflight | turn/end | assistant | 结果 |
|---|---|---|---|---|---|---|---|---|---|
| B0 | bare create+followup | 19868 | 19868 | — | — | — | completed | ✓ | **PASS** |
| B1 | +affinity | 19868 | 19868 | — | — | — | completed | ✓ | **PASS** |
| B2 | +lease | 19868 | 19868 | — | — | — | completed | ✓ | **PASS** |
| B3 | +capabilities+resolver+preflight | 19868 | 19868 | **53**（真实工具面） | **FULL**（code_check/notify） | ok | completed | ✓ | **PASS** |

- 无 fatal stderr（fatal-*.err.log 本轮无新增）；PID 全程 19868 不变；
- **修复前 B3 EXIT（实例退出）；修复后 B3 PASS（PID 不变）——差异闭合**。

## J. 判断（更新）

```text
根因：CONFIRMED（unhandledRejection fatal stack + 边界实验 + 修复后复验三重证据）
修复：已实施（概念分离 + await/catch + normalize 修正），代码层 100/100 + 真实 B0–B3 全 PASS
Blocker #2 状态：待 Owner Review（修复已生效；完整 E2E 12–20 复验窗口按 Owner 指令另行开启）
```

## 附：实验纪律核对（复验轮）

- 每 Case 新隔离 session/worker ✓；极简 prompt ✓；prependListener 日志保全（fatal-*.err.log）✓；
- 找到首个 PASS→EXIT 边界（B2→B3）即停止推进 ✓；未修改 DSH 上游/Schema/冻结语义 ✓；
- 未触碰正式 kingdom.db；无 commit/tag/push/publish ✓。

## 附：实验纪律核对

- 每 Case 新隔离 session/worker ✓；极简 prompt ✓；日志保全（prependListener → fatal-*.err.log）✓；
- 找到首个 PASS→EXIT 边界即停止（未跑 B4+）✓；未修改 DSH 上游/Schema/冻结语义 ✓；
- 未触碰正式 kingdom.db；无 commit/tag/push/publish ✓。
