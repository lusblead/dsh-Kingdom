# 外部维护者反馈（Evidence）

> 用途：保存外部维护者对 dsh-Kingdom 核心治理设计的**正向技术反馈**（首次明确的外部认可），
> 以及相关 PR 收尾记录。日期：2026-08-18。

## 1. 市场维护者 fkysly 对 #1668 的评价

收录 PR #1668 合并后，重复 PR #1562（旧分支 `add-dsh-kingdom`，v0.3.2 时代提交）
被维护者指出与 #1668 重复，并留下两条关键反馈：

### 1.1 描述保留（"I would rather keep it"）

> #1668 合并进的长版描述（territories / role bindings / bind-unbind-session /
> model-agent identity / plan→assign→execute→review / Claim ≠ Fact / local GUI console）
> 比 #1562 的短版更完整，维护者表示倾向保留现版，把最终选择权留给作者。

**结论：不改描述，关闭 #1562。**

### 1.2 代码强制的 Claim ≠ Fact 获得认可（核心价值）

> 维护者专门解释为什么愿意合并 #1668：
> 「`src/core/task-service.ts` 在代码里真正强制实现了 Claim ≠ Fact，而不只是 README 宣传。
> Worker claim 只能让 Task 到 REVIEW；只有 Supervisor ACCEPT 才能到 DONE。
> **That is the sort of claim I like, because it is checkable.**」

**意义**：维护者认可的不是"插件写得酷"，而是——**治理语义的宣传可以从代码中验证**。
这正是 Kingdom 的核心差异化：普通 Agent 插件靠 prompt 约定（模型可能遵守），
Kingdom 靠状态机 + 唯一写入通道强制（`transitionTask` 全库唯一 `UPDATE tasks.status`，
DONE 只有 REVIEW + ACCEPT 一条路径）。

## 2. 收尾记录

| PR | 状态 | 说明 |
|---|---|---|
| #1668 | ✅ MERGED（fkysly，98e97739） | 正式收录，entry 已进 main |
| #1562 | ✅ CLOSED（2026-08-18T13:19:26Z） | 重复提交，superseded by #1668；留言感谢评审并引用 Claim ≠ Fact |

## 3. 关联

- 代码证据：`src/core/db.ts` `transitionTask`（全库唯一 status 写入路径）、
  `src/core/task.ts`（冻结状态机）、`src/core/task-service.ts` `reviewTask`（DONE 唯一入口）。
- 经验库：`PX-ARCH-001` / `EL-GOVERNANCE-001`（Claim ≠ Fact 不变量）。
