# M3-S2 Implementation Report（v0.8 第一阶段 · S2 Schema v4 + Domain）

> 日期：2026-08-19
> 依据：Owner v0.8 施工总 Prompt §4–§16；M3-S2 Schema v4 Design v6（Owner 三次 Review APPROVED）
> 状态：**待 Owner M3-S2 implementation acceptance**；通过前不进入 S3，不对正式 kingdom.db 执行迁移。

---

## 1. Files changed

| 文件 | 变更 |
|---|---|
| `src/core/db.ts` | SCHEMA_VERSION 3→4；构造函数 FK 协议（F-1/F-2）+ 失败关连接；ensureSchemaV2/V3 gate 修复（各 gate/写自己的目标版本，杜绝「旧迁移直写 4 跳过 v4」陷阱）；新增 `ensureSchemaV4`（单事务迁移）+ `V4_LEDGER_SQL`/`V4_EXECUTIONS_STAGING_SQL`/`V4_EXECUTIONS_TRIGGERS_SQL`/`V4_DISPATCH_SQL` 四个 DDL 常量 + `verifyV4Objects` 终验；新增 v4 行接口（AffinityRow/LeaseRow/CapabilityDecisionRow/DispatchRecordRow）+ ExecutionRow 增 3 列；新增 4 套 Ledger 存储方法（CAS 版状态推进）；`StaleStateError`；`isSchemaV4` getter（版本 + v4 对象双确认） |
| `src/core/execution.ts` | 新增 `RECOVERING` 态（进入/恢复/终态转移；RECOVERING 不改 Task 治理状态） |
| `src/core/governed.ts` | **新增** Runtime Governance Domain API（§15 全部能力） |
| `src/core/kingdom.ts` | KingdomManagerOptions.migrateV4 → allowSchemaV4 透传 |
| `src/core/task-service.ts` | one-shot 路径显式 `execution_contract: 'LEGACY_COMPAT'`（LEGACY 显式声明） |
| `src/index.ts` | Config 增加 `migrateV4`（默认 false = 正式库 Gate 保护） |
| `tests/m3s2-v4-schema.test.ts` | **新增**：Gate / Migration（v3→v4、幂等、回滚、行保留、不伪造历史、终验）/ Direct SQL 49 项不变量移植 / FK 新连接 / TX 序列 / DELETE 拒绝 / 增量列 |
| `tests/m3s2-v4-domain.test.ts` | **新增**：Domain API 全链路（Affinity/Lease/Decision/Execution/Dispatch/Receipt/Correlation/Terminal/Release/Recovering/CAS/DELETE） |

## 2. Schema objects（v4 全量）

- **4 张新 Core Ledger 表**：`session_territory_affinities` / `execution_leases` / `capability_decisions` / `dispatch_records`；
- **executions 重建**：旧列（含 v2 证据列）全保留 + 新增 `execution_contract`/`lease_id`/`capability_decision_id`；
- **2 个 ADD COLUMN**：`tasks.capability_requirement_json` / `kingdoms.capability_ceiling_json`；
- **21 个 trigger**：affinity 3（identity/retire/no-delete）+ lease 8（I-11 acquire/identity/plan once/decision once/release evidence once/state guard+evidence 前置/INSERT 守卫/no-delete）+ decision 3（immutable/execution 单绑/no-delete）+ executions 2（governed consistency/contract immutable）+ dispatch 5（request immutable/ready-lease/state guard+evidence 前置/INSERT 守卫/no-delete）；
- **4 个新索引**：`affinity_one_current_per_worker` / `lease_one_active_per_session` / `capability_decision_execution_uk` / `executions_task_idx`（重建）；
- FK：`dispatch_records→execution_leases/executions`；`executions→execution_leases/capability_decisions`。

## 3. Migration strategy

- **v4 DDL 全部在 ensureSchemaV4 的 BEGIN IMMEDIATE 单事务内**（不进 SCHEMA_SQL bootstrap，避免迁移事务语义失效——§13 陷阱）；
- 顺序：ADD COLUMN 增量 → 三 Ledger → executions_v4 暂存表 → 全量复制 + `LEGACY_COMPAT` backfill → 行数校验 → DROP 旧 executions → RENAME 回 executions → 重建索引/trigger → dispatch_records（FK 直接指最终名）→ `schema_version=4` → 终验（sqlite_master 精确对象集 + foreign_key_check 空 + integrity_check ok）→ COMMIT；
- 任一步失败 ROLLBACK，库保持完整 v3 语义（实测：注入坏 state 行 → 整体回滚）；
- **正式 kingdom.db 受 Formal DB Migration Gate 保护**：默认 `migrateV4=false` 不自动迁移已有 v3 库（v3 功能照常、governed API fail-closed）；全新库自动 v4；Gate 放行时传 `migrateV4=true`。

## 4. Tests（全部 PASS）

| 组 | 覆盖 | 结果 |
|---|---|---|
| Python v6 verifier | `m3s2_v6_verify.py`（v6 DDL 权威） | **49/49 PASS**（本轮重跑） |
| Migration（新） | Gate 保护 / v3→v4 行保留+backfill+不伪造 / 重复开库幂等 / 中途失败回滚 / 全新库自动 v4 / FK 新连接 | 6/6 |
| Direct SQL（新） | v6 49 项 invariants 移植到生产 DDL（A-1..A-20 + E-1..E-21）+ DELETE 拒绝 + 增量列 | 49 项全过 + 2 |
| Domain（新） | valid path / 非法转移 / CAS 陈旧态 / 并发互斥（DB 唯一索引）/ territory 不匹配 / 非法 decision / immutable / 伪造关系 / DELETE 拒绝 / TX-0D..TX-5 全链 | 12/12 |
| 既有回归 | execution-truth / governance / m1d-matrix / m2-organization / territory | 33/33 全过 |

**总计：55/55 全量 PASS**（既有 33 + 新增 22）。

## 5. DB red-line check

- 正式 `C:\Users\ADMIN\.dsh\kingdom\kingdom.db`：**未触碰**（全程 :memory:/临时文件库；运行实例仍持旧 v0.7 代码打开 v3 库）；
- 施工前基线：kingdom repo `0f6a804`（dirty 仅为 docs/.agent 未跟踪 + 本次 5 个 src 修改 + 3 个新文件，**未 commit**）；
- 正式 DB 的 pre-migration SHA-256 采集推迟到 Formal DB Migration Gate（运行实例占用文件，§36 要求在受控窗口采集）。

## 6. Unresolved blockers

- 无技术阻塞。等待 Owner **M3-S2 implementation acceptance**；
- 通过后授权进入 S3（RuntimeAdapter Thin Spec + DSH Persistent Backend）；
- 正式 kingdom.db 迁移 = 独立 Formal DB Migration Gate 呈报（§36），不在 S3 范围内自动执行。
