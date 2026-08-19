# Formal DB Migration Gate（v0.8 · Schema v3 → v4）

> 日期：2026-08-19
> 依据：Owner v0.8 施工 Prompt §36——所有隔离迁移证据完成后单独呈报，**未经 Gate 放行不得主动迁移正式 kingdom.db**。
> 状态：**证据完备 · 待 Owner Gate 放行**。放行前正式 DB 保持 v3（运行实例 0.7 插件照常工作）。

---

## 1. 当前正式库状态（只读探测，未触碰）

```text
路径      : C:\Users\ADMIN\.dsh\kingdom\kingdom.db
schema    : 3（只读连接实测 MAX(schema_version)=3）
文件大小  : 143360 字节（运行实例占用，WAL 模式）
```

## 2. 隔离迁移证据（副本实测 —— 未触碰原件）

对正式库做**只读 VACUUM INTO 一致副本**，在副本上执行完整迁移（§4.1「copied historical DB」步骤）：

```text
副本 pre-migration：sha256=848dee78e285136b257f7a0bcbd32cecef59d99d8b63cc0b13d7748ef1f7deef size=163840 integrity=ok
行数基线：kingdoms=1 · territories=3 · bindings=6 · tasks=7 · executions=6 · worker_results=6 · events=85 · assignments=3

副本 post-migration：schema=4（isV4=true）
  - executions 6/6 全 LEGACY_COMPAT backfill（不猜测旧历史）
  - 零伪造治理：affinities=0 · leases=0 · decisions=0 · dispatches=0（B-2/B-3/B-5）
  - PRAGMA foreign_key_check = 空
  - PRAGMA integrity_check = ok
  - 行数保持：kingdoms/tasks/executions/events/bindings 全 match=true
  - legacy 回归（副本上）：kingdom「My Kingdom」/ territories / bindings / tasks 全部可读
```

## 3. 正式迁移执行方案（Gate 放行后，受控窗口内）

```text
1. 备份：正式 kingdom.db + -wal + -shm → 带时间戳副本（backup evidence）
2. 采集 pre 证据：sha256 / size / schema_version / integrity_check / 行数（与 §2 基线核对）
3. 执行：插件 config migrateV4=true → 开库触发 ensureSchemaV4（单事务；失败 ROLLBACK 保持 v3）
4. 采集 post 证据：foreign_key_check 空 / integrity_check ok / 行数保持 / executions LEGACY / 零伪造治理 / post sha256
5. legacy 回归：既有 33 项 + 王国数据抽查
6. 呈报执行报告（pre/post 证据对照）
```

**回滚预案**：迁移单事务，任一步失败自动 ROLLBACK 保持 v3；另持备份副本可整库还原。

## 4. 请 Owner 裁定

- **放行**：在受控窗口执行正式迁移（migrateV4=true），完成后呈报 pre/post 证据；
- **暂缓**：保持正式库 v3（governed 工具 fail-closed 拒绝），v0.8 其余功能（legacy + GUI 治理投影为空）不受影响；
- **附加条件**：可指定迁移窗口（如重启 dsh web 实例后）或先做 GUI/实机 E2E 复核再迁移。

## 5. 约束确认

- 放行前：不执行正式迁移、不改正式 DB、不发布；
- 放行后：仅执行 §3 方案，不做任何超出 Gate 范围的变更。
