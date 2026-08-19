# v0.8 Release Candidate Gate Report

> 日期：2026-08-19（**Owner Emergency Phase Hold 修正版**）
> 依据：Owner v0.8 施工 Prompt §35（RC Gate 清单）+ Owner 紧急暂停指令（2026-08-19）
> **状态结论：`V0.8_RC = HOLD_FOR_OWNER_REVIEW`；`RELEASE = NOT AUTHORIZED`**
> 说明：本报告**不再以任何 PASS 计数作为最终结论**。以下表格只保留证据记录；凡需实机/正式环境验证的 Gate 一律视为**未闭合**，统一待 Owner Review 后逐项放行。

---

## 全局状态（Owner Emergency Phase Hold 冻结）

```text
V0.8_RC   = HOLD_FOR_OWNER_REVIEW
RELEASE   = NOT AUTHORIZED
施工       = 已暂停（保留 S2–S6 全部代码与测试，不回滚、不重新设计、不删除功能）
正式 DB    = 未触碰（保持 v3，Gate 保护）
commit/tag/push/publish = 无
```

## RC Gate 证据记录（非结论；实机/正式类一律未闭合）

| # | Gate | 证据状态 | 闭合条件（Owner Review 后） |
|---|---|---|---|
| 1 | Schema v4 migration tests | 隔离测试通过（6 项） | ✅ 代码层闭合 |
| 2 | Historical DB migration copy | 只读副本实测通过（行保留 100%/backfill/零伪造/fk/integrity） | ⏳ **未闭合**：正式库迁移须 Formal DB Migration Gate 放行后执行 |
| 3 | v6 invariants | Python 49/49 + 生产 DDL 移植 49 项 | ✅ 代码层闭合 |
| 4 | Domain tests | 12 项 + governed runner 4 项 | ✅ 代码层闭合 |
| 5 | Persistent Worker E2E | 工具已接线 + fake 确定性测试 4 项 | ⏳ **未闭合**：真 DSH Session 全链 E2E 未执行（需运行实例验证窗口） |
| 6 | Capability adversarial | S4 8 项 | ✅ 代码层闭合 |
| 7 | Dispatch / reconciliation | S5 5 项 | ✅ 代码层闭合 |
| 8 | Crash matrix | S5/S6 | ✅ 代码层闭合 |
| 9 | Foreign dispatch safety | S5/S6 | ✅ 代码层闭合 |
| 10 | Legacy regression | 既有 33 项 + 全量 91/91 | ✅ 代码层闭合 |
| 11 | GUI functional smoke | 视图层 3 项通过 | ⏳ **未闭合**：实机 GUI 冒烟未执行 |
| 12 | install / fresh-init | 隔离 tgz 安装 + fresh-init v4 实测通过 | ⏳ **未闭合**：实机安装（profile 部署）未验证 |
| 13 | upgrade v0.7 → v0.8 | 正式库只读副本迁移实测通过 | ⏳ **未闭合**：正式升级须 Formal DB Migration Gate 放行后执行 |

## 全量测试基线（证据，非 Gate 结论）

```text
91/91 PASS（代码层）
  M3 新增 58：schema/migration 12 · domain 12 · adapter 8 · capability 11 · dispatch 5 · gate 5 · gui 3 · governed-runner 4
  既有 33：execution-truth · governance · m1d-matrix · m2-organization · territory
Python v6 verifier：49/49
```

## 结论（Owner Emergency Phase Hold 冻结）

**`V0.8_RC = HOLD_FOR_OWNER_REVIEW`；`RELEASE = NOT AUTHORIZED`。**
- 未闭合项（#2/#5/#11/#12/#13）全部属于**实机/正式环境验证**类，无代码侧阻塞；待 Owner Review 后逐项放行。
- 已暂停：GUI 进一步施工 / npm pack 后续 / install / migration / real-DSH E2E / release。
- 保留：S2–S6 全部代码与测试；不回滚、不重新设计、不删除已实现功能。
