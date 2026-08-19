# FINAL V0.8 RC REPORT（dsh-Kingdom v0.8.0）

> 日期：2026-08-19
> 性质：Owner V0.8 RC PHASE AUTHORIZATION 十步执行终报
> 状态：
> ```text
> Formal DB Migration Gate = PASS
> Formal DB Migration       = AUTHORIZED + EXECUTED（正式 kingdom.db 已 v4，备份可回滚）
> v0.8 RC                   = COMPLETE（等待 Owner 最终批准）
> Release                   = NOT AUTHORIZED（等待 FINAL REPORT 批准）
> ```

---

## 0. 十步执行汇总

| # | 步骤 | 结果 |
|---|---|---|
| 1 | 更新 E2E 报告首页状态（Blocker #2 = CLOSED / REAL DSH E2E = FULL PASS） | ✅ `docs/M3-V08-REAL-DSH-E2E-REPORT.md` 首页已更新 |
| 2 | 最终 build + npm pack | ✅ `tsc` 干净；`dsh-kingdom-0.8.0.tgz`（178,800 B，82 文件）→ `dist-rc/` |
| 3 | 隔离 profile 安装 / fresh-init / governed smoke | ✅ 隔离 profile（`%TEMP%\kingdom-rc-home\profiles\rc-test`，bundles: dsh-base + dsh-headless + dsh-kingdom）从 tgz 安装 → 引导成功 → fresh-init（RC-Test 王国）→ 正式入口 governed smoke（GRANTED+ENFORCED、REWORK、同 session、REVIEW） |
| 4 | 实机 GUI smoke（只验证） | ✅ `127.0.0.1:34817` `/api/health`、`/api/snapshot`（kingdom/bindings/territories/tasks/liveExecutions/governance 全字段）、`/api/events` 正常；`auth.trustLevel=local-demo` 如实声明 |
| 5 | 正式 v3 DB 一致副本 → v4 migration（最终 build） | ✅ VACUUM INTO 一致副本 → 最终打包产物迁移 v3→v4 → 全项核验通过 |
| 6 | 呈报 Formal DB Migration Gate | ✅ Gate 证据完整呈报 |
| 7 | Owner 放行后迁移正式 kingdom.db | ✅ Owner 两次裁决放行 → 正式库执行迁移（先 VACUUM INTO 备份）→ post-migration 核验 + Legacy/Governed Smoke |
| 8 | 最终 full regression | ✅ `git diff --check` 0 · 全量测试 **106/106** · Python v6 verifier **49/49** |
| 9 | 清理所有 staging / E2E 临时工具 | ✅ 43 个 staging 工具全部 demote（`dev_stage_list` = 空）；隔离 profile 凭据副本/临时会话已删（rc-test profile 与 migration 证据保留） |
| 10 | 呈报 FINAL V0.8 RC REPORT | ✅ 本文件 |

## 1. 正式 DB Migration（Gate PASS → 执行 → post-migration 核验）

### 1.1 迁移前（一致快照 = VACUUM INTO 备份 `kingdom.db.backup-v3-before-v4.db`）
- schema_version = **3**；size = 163,840 B；SHA-256 = `848DEE78E285136B257F7A0BCBD32CECEF59D99D8B63CC0B13D7748EF1F7DEEF`
- 8 张旧表 row count：kingdoms 1 / territories 3 / role_bindings 6 / tasks 7 / events 85 / worker_results 6 / executions 6 / task_assignments 3
- 备份 integrity_check = ok

### 1.2 迁移执行（最终打包产物，Owner 放行后）
- `C:\Users\ADMIN\.dsh\kingdom\kingdom.db`：v3 → **v4**（`KingdomStore(allowSchemaV4: true)`，单次事务迁移）

### 1.3 post-migration 核验（正式库当前）
- schema_version = **4**；size = 245,760 B（post-v4 一致快照 SHA-256 = `6F1EECF09CDCE1C45B468CC620CA453A5B20629EBBF2EC29B8BAD81465D095D1`）
- 8 张旧表 row count 与迁移前**逐项一致**（1/3/6/7/85/6/6/3）
- `integrity_check = ok`；`foreign_key_check` = 空
- 历史 executions 全部回填 `LEGACY_COMPAT`（×6，不伪造历史）
- 4 张 v4 Ledger（session_territory_affinities / execution_leases / capability_decisions / dispatch_records）= **0 行**（无伪造治理历史）
- 增量列存在：tasks.capability_requirement_json / kingdoms.capability_ceiling_json ✓
- Python v6 verifier **49/49 PASS**

### 1.4 正式库 Smoke（迁移后）
- **Legacy Smoke**（旧 one-shot 路径）：RC-SMOKE-LEGACY-2 任务 → `kingdom_start_task` → Worker 提交 COMPLETED Claim（摘要「按任务要求只回复了 OK…」）→ Task **REVIEW** ✓
- **Governed Smoke**（治理路径）：RC-SMOKE-GOVERNED 任务（requirement/ceiling = {tool:code_check, tool:notify}，fixture 直写并记录）→ `kingdom_start_task_governed` attempt 3（GRANTED+ENFORCED / execution **COMPLETED** / dispatch TERMINAL / Claim / REVIEW）→ `kingdom_review_task` REWORK → attempt 4（同 session **复用**，GRANTED+ENFORCED / COMPLETED / TERMINAL / Claim / REVIEW）→ 4 条 lease 全部 **RELEASED** → 4 次 attempt 同 session_ref（H ✓）
- 说明：首次 Legacy smoke 因父 agent 选到 running 会话致 subagent 失败（任务 FAILED，环境选择问题）；改用 idle 父 agent 后通过。正式库新增数据均为显式标记 `RC-SMOKE-*` 夹具（领地/角色/任务/执行记录），如实记录。

## 2. 隔离 profile 安装与冒烟（步骤 3 详情）

- 隔离 DSH_HOME（`%TEMP%\kingdom-rc-home`）+ 最小 profile（`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless` + `dsh-kingdom`）
- `dsh plugin --profile rc-test add <tgz>`：pnpm 从 tgz 安装成功（version 0.8.0、78 lib 文件、governed 工具在包内）
- `dsh --profile rc-test "<prompt>"` 引导成功（插件加载无错、模型可用）
- headless 驱动正式工具：init → territory → bind_role ×3 → set_territory_supervisor → set_execution_profile → plan → assign → **start_governed → REWORK → start_governed**：GRANTED+ENFORCED ×2、同 session（40a31372…）复用、leases RELEASED ×4、Task REVIEW
- 观察 1：headless profile 缺 code_check 插件 → 授权 code_check 时 gate 正确 fail-closed（coverage NONE → DENIED）——**隔离运行时验证了 fail-closed 语义**
- 观察 2：headless 运行时 worker turn 以 error 结束（execution FAILED）→ 同链在 web 运行时完整（COMPLETED）——判定为隔离 profile 运行时环境差异，非 Kingdom 缺陷（web 运行时复现对照：todo_write 授权 worker 极简 turn `completed` + assistant）

## 3. 正式路径诚实性观察（RC 阶段未改代码，呈报 Owner 决策）

- **Claim outcome 硬编码**：正式工具在 execution 终态为 FAILED（turn error）时仍落 `worker_results.outcome='COMPLETED'`（摘要取自事件链，无文本时回退占位）。Claim ≠ Fact 的治理语义仍成立（Task 只到 REVIEW），但 Claim 的 self-report 与实际 host 观察可能不一致——建议后续（非 RC）把 execution 终态纳入 Claim 落库（`outcome` 按 `terminalOutcome` 收敛）。

## 4. 最终回归（步骤 8）

- `git diff --check`：**0 错误**
- 全量测试：**106/106 PASS**（M1/M2/M3-S2..S6 全套 + seam 回归）
- Python v6 verifier（`m3s2_v6_verify.py`）：**49/49 PASS**

## 5. 安全边界（全程遵守）

- ✅ 无 commit / tag / push（HEAD 仍为 `0f6a804`，46 commits 未动）
- ✅ 无 npm publish、无 GitHub Release、无 Market 发布
- ✅ 正式库迁移前创建 VACUUM INTO 备份（`kingdom.db.backup-v3-before-v4.db`，SHA-256 已录，可回滚）；迁移后行数/完整性/无伪造数据全项核验
- ✅ 正式库迁移经 Owner 两次裁决放行（Gate 证据 + 详细顺序指令）；迁移执行中无并发写（实例空闲连接）
- ✅ GUI 仅验证（health/snapshot/events），未做美术施工
- ✅ 未新增功能/架构/重构（RC 阶段零代码改动；staging 工具全部清理）

## 6. 结论

```text
Blocker #2                 = CLOSED
REAL DSH E2E               = FULL PASS（staging 完整链 + 正式入口完整链 + 隔离 profile + 正式库 Smoke）
Formal DB Migration Gate   = PASS
Formal DB Migration        = AUTHORIZED + EXECUTED（正式 kingdom.db 现为 v4，备份可回滚）
v0.8 RC                    = COMPLETE（等待 Owner 最终批准）
Release                    = NOT AUTHORIZED
```

**呈报 Owner 最终批准**：若批准 → 方可进行 commit/tag/push、npm publish、GitHub Release、Market 发布等后续发布动作（不在本授权内，需另行放行）。

---

## 7. FINAL DELTA RC（Claim Outcome Consistency 修复 · 2026-08-19）

> Owner V0.8 FINAL RELEASE BLOCKER：正式 governed 工具在 Execution terminalOutcome=FAILED 时仍创建 `worker_results.outcome='COMPLETED'`——发布前必须修复。

### 7.1 修复内容（`src/`，未改 Schema / M3 frozen contracts / Runtime state machine）

| 文件 | 变更 |
|---|---|
| `src/worker/governed-executor.ts` | `GovernedTaskResult.ok:true` 新增 **`terminalOutcome`**（取自 terminal 证据验证的 execution 终态 `COMPLETED/FAILED/ABORTED`） |
| `src/index.ts` | 工具层 Claim **按 `terminalOutcome` 收敛**（删除 hardcode `outcome: 'COMPLETED'`）：`COMPLETED→COMPLETED / FAILED→FAILED / ABORTED→ABORTED`；事件 `claimed_outcome` / `SESSION_STOPPED.reason` 同步；返回文本标注 `outcome=`；摘要仅来自真实 assistant 文本（无文本 → 诚实占位，不伪造"任务完成"类摘要） |
| 既有 fail-closed | UNKNOWN / RECOVERING（interrupted / ambiguous / 超窗）→ `runGovernedTask` 仍 `ok:false` → 工具 zero execution → **不创建任何 Claim**（无伪终态） |

### 7.2 回归测试（+5 → 全量 **111/111**）

- **A** completed + assistant → execution COMPLETED · Claim 收敛依据 COMPLETED ✓
- **B** error / blocked / max-tokens → execution FAILED · terminalOutcome FAILED（禁止 COMPLETED）✓
- **C** aborted → execution ABORTED · terminalOutcome ABORTED ✓
- **D** interrupted / completed-无-assistant → 非终态 → `ok:false` · **不生成任何 Claim** ✓
- **E** FAILED 且无 assistant/message → 摘要为诚实占位（不含"任务完成"/"满足验收"）✓

### 7.3 真实验证（两路径）

**① 隔离 profile headless error 路径**（复用 rc-test profile，新 tgz 重装后）：
- 新任务 RC-DELTA-ERR（grant `tool:todo_write`，GRANTED+ENFORCED / FULL）→ headless 运行时 worker turn **error**
- 结果：execution **FAILED** → **`worker_results.outcome = FAILED`**（result_json 同步）→ Task **REVIEW** → `COMPLETED-pseudo = 0` ✓
- 工具返回：「Governed Worker 已提交第 2 次尝试的 Claim（**outcome=FAILED**，长期 Session bd971937 复用）。摘要：(无最终消息文本；以 terminal 证据为准)」

**② Web Runtime 正常路径**（正式库 RC-SMOKE-GOV2 任务，grant `code_check+notify`）：
- worker turn `completed` + assistant（"OK"）
- 结果：execution **COMPLETED** → **`worker_results.outcome = COMPLETED`**（summary "OK"）→ Task **REVIEW** → Lease RELEASED ✓

### 7.4 Delta 回归与打包

- `tsc` ✓ · `git diff --check` = 0 ✓ · 全量测试 **111/111** ✓ · Python v6 verifier **49/49** ✓
- 重新 `npm pack`：`dsh-kingdom-0.8.0.tgz`（183,209 B，82 文件）
- tarball 核对：version 0.8.0 · 82 files · `lib/index.js` 含 `terminalOutcome` 收敛逻辑 · **无 `outcome: 'COMPLETED'` 硬编码** · `cordis.patch.yml` 在包内
- 新 tgz 隔离安装 smoke：rc-test profile remove+add 重装成功（version 0.8.0、terminalOutcome 生效）→ headless error 路径验证（7.3-①）

### 7.5 未重跑项（按 Owner Delta 授权）

- 未再迁移正式 DB（仍 v4，backup 完好）
- 未重跑完整 Formal Migration Gate / GUI / 全套 Persistent Worker E2E（无新 blocker，无需）

### 7.6 状态更新

```text
Release Blocker（Claim Outcome Consistency）= FIXED（代码 + A–E 回归 + 双路径真实验证）
v0.8 RC                                   = COMPLETE（等待 Owner 最终 Release Authorization）
Release                                   = NOT AUTHORIZED（仍禁 commit/tag/push、npm publish、GitHub Release、Market 发布）
```

**呈报 Owner 最终 Release Authorization**。
