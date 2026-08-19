# V0.8 RELEASE REPORT（dsh-Kingdom v0.8.0 正式发布）

> 日期：2026-08-19
> 裁决：Owner 最终批准 v0.8.0 Release（Blocker #2 = CLOSED；Claim Outcome Consistency = FIXED；v0.8 RC = APPROVED；v0.8.0 RELEASE = AUTHORIZED）
> 状态：**v0.8.0 已正式发布**（git tag + push + npm publish + GitHub Release + Market 验证 + 发布后 fresh-install smoke）

---

## 1. 发布十步执行记录

| # | 步骤 | 结果 |
|---|---|---|
| 1 | 最终 git status / diff 审计 | ✅ 工作树审计：51 个文件暂存（src/tests/docs/changelog/README/package.json）；`lib/`（构建产物）按 .gitignore 排除；`lib-e2e/`（陈旧证据副本）与 `.agent/`（学习元数据）不入库；源码与 Delta RC tgz 逐字节一致 |
| 2 | 提交 v0.8.0 完整代码与文档 | ✅ commit `d55cc25`（v0.8.0: Persistent Governed Worker — M3 Runtime Governance 全链） |
| 3 | 创建 tag v0.8.0 | ✅ `git tag v0.8.0` |
| 4 | push branch / tag | ✅ `main 0f6a804..d55cc25` + `v0.8.0` → github.com/lusblead/dsh-Kingdom |
| 5 | npm publish（最终 Delta RC tgz 对应源码） | ✅ 发布前核对：当前源码 `npm pack` SHA-256 == Delta RC tgz（`CCC6AB578A0EA3A19BE82BF4BA73496445727FB56DAB5903D8ADDBB472FC108B`）；`npm publish --registry=https://registry.npmjs.org/` → `+ dsh-kingdom@0.8.0`（tag latest，82 文件，183.2 kB） |
| 6 | npm registry 回读确认 | ✅ `npm view dsh-kingdom@0.8.0`：version=0.8.0、dist-tags.latest=0.8.0；下载 registry tarball SHA-256 == 本地 Delta RC tgz（逐字节一致，可安装） |
| 7 | GitHub Release v0.8.0 | ✅ https://github.com/lusblead/dsh-Kingdom/releases/tag/v0.8.0（附 `dsh-kingdom-0.8.0.tgz`；非 draft/prerelease；Release Notes 突出四点） |
| 8 | 更新 / 验证 Market 用户可见版本 | ✅ Market（dshmarket）快照为社区维护列表（awesome-dsh-plugin），dsh-Kingdom 条目已存在（owner=lusblead，npm=dsh-kingdom）；用户可见版本由 npm/GitHub 动态解析 → **npm latest = 0.8.0** + GitHub release v0.8.0 已上线（published 14:01:03Z） |
| 9 | 发布后 fresh-install smoke | ✅ 全新隔离 profile（`%TEMP%\kingdom-post-publish`）从 **npm registry** 安装 `dsh-kingdom@0.8.0`（78 lib 文件）→ headless 引导 → fresh-init（PP-Test 王国）→ 正式入口 governed 执行：**GRANTED+ENFORCED（FULL）→ worker turn error → execution FAILED → Claim FAILED（COMPLETED-pseudo=0）→ Task REVIEW → Lease RELEASED**（发布包上的 Claim 一致性验证通过） |
| 10 | V0.8 RELEASE REPORT | ✅ 本文件 |

## 2. Release Notes 四大亮点（已在 GitHub Release 呈现）

1. **Persistent Worker（长期 Worker）**：REWORK 后继续复用同一个 Runtime Session；Session 不可跨 Territory 漂移（retire 只能一次，live 复用不 resume）。
2. **Capability Governance（能力治理）**：Effective = Supervisor Grant ∩ Owner Ceiling ∩ Runtime Enforceable Set；无法证明可强制时 fail-closed（DENIED + zero execution，绝不"提醒后继续"）。
3. **Execution Lease（执行租约）**：每个 Session 同时只允许一个有效执行；完整 cleanup 后才释放；一 Lease = 一 Attempt。
4. **Evidence-driven Recovery（证据驱动恢复）**：interrupted / ambiguous 不再伪装成成功；Execution、Claim 与 Runtime Terminal Outcome 保持一致（COMPLETED/FAILED/ABORTED 收敛）。

## 3. 交付物与证据

- 源码：github.com/lusblead/dsh-Kingdom @ `v0.8.0`（commit `d55cc25`，branch main）
- npm：`dsh-kingdom@0.8.0`（registry.npmjs.org，dist-tags.latest）
- GitHub Release：`v0.8.0`（附 tgz + Release Notes）
- 正式数据库：已安全迁移 v4（`kingdom.db.backup-v3-before-v4.db` 可回滚，SHA-256 `848DEE78…`；旧 executions 保持 LEGACY_COMPAT，不伪造历史治理账本）
- 验证：回归 **111/111** · Python v6 verifier **49/49** · REAL DSH E2E FULL PASS · Formal DB Migration Gate PASS · Delta RC PASS · 发布后 fresh-install smoke PASS
- 报告：docs/`M3-V08-REAL-DSH-E2E-REPORT.md`、`FINAL-V08-RC-REPORT.md`、`M3-S2-FORMAL-DB-MIGRATION-GATE.md`、`V08-RC-GATE-REPORT.md`、`changelog/v0.8.0.md`

## 4. 发布纪律

- 发布过程中**未改任何代码**（源码与 Delta RC tgz 逐字节一致后发布；npm publish / 安装验证 / 发布后 smoke 全部与 RC 一致）
- 无异常 → 无需停止；发布动作全部完成

**v0.8 功能开发、真实运行验证、迁移、RC 与最终语义修复全部结束。dsh-Kingdom v0.8.0 已正式发布。**
