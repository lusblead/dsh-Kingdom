# dsh-kingdom v1.0 发布手册

## 当前状态（先读）

- **Owner 发布授权**：2026-08-27 已授权 v1.0 发布，2026-08-28 要求继续推进；授权不等于技术门、独立审计、远端写入或发布完成。
- **本轮自动化**：隔离 stage 的 P0–P3 仍待重跑（`NOT_RUN`）。此前候选快照的 `192/192 PASS` 仅是历史记录，不能继承为本轮结果。
- **远端事实**：P4–P8 的精确暂存、commit/tag/push、GitHub Release、npm latest、Discussion 和 Market 复验均为 `NOT_RUN`。在这些事实出现并完成独立审计前，v1.0 不是已发布版本。
- **产品运行证据**：真实 Provider、正式数据库迁移、真实 DSH 重启恢复保持 `NOT_RUN`；不得以打包、静态检查或历史记录改写它们。

## v1.0 发布链与职责边界

本轮只允许 `scripts/release.ps1` 作为 P0–P3 的隔离技术门。它不拥有 v1.0 的 P4 选择权，也不能因自身成功而产生发布事实。

```text
P0 预检（隔离 stage）
→ P1 版本一致性
→ P2 typecheck + 全量测试
→ P3 prepack + npm pack + tgz 内容核验
→ 独立审计
→ P4 冻结 manifest 的逐路径精确暂存、commit、tag、push
→ P5 GitHub Release
→ P6 npm publish latest
→ P7 Discussion 公告
→ P8 只读远端对账与 Market 可见性检查
```

### P0–P3：仅技术门

使用隔离 stage 运行 P0–P3，并记录命令、退出码、tgz 文件名和内容核验。任一失败、候选漂移或缺少 tgz 都必须停止；不得将历史 `192/192` 代替本轮重跑。

`-DryRun` 的成功只表示它在 P4 前停止，绝不表示 commit、tag、push、GitHub Release、npm publish、Discussion 或 Market 已发生。

### P4：冻结 manifest 的精确暂存

只有独立审计通过后，Construction 发布主体才按 Work Order 冻结的逐路径 manifest 执行 P4。禁止使用脚本中的固定 `git add package.json README.md`，也禁止 `git add -A`；不得把 `.local/**`、证据、临时目录、正式数据库、凭据或未审查的 dirty 文件纳入 index。

P4 前须明确记录每个暂存路径及其审计依据。P4 之后若任一远端步骤部分成功，先只读对账已存在的远端事实，禁止盲目重复写入。

### P5–P8：远端事实而非脚本声称

| 阶段 | 需要的可核对事实 |
|---|---|
| P5 | GitHub Release `v1.0.0`、Release Notes 与必需 tgz 资产均可只读核对 |
| P6 | 官方 npm registry 的 `dsh-kingdom@1.0.0` 与 `latest` dist-tag 可只读核对 |
| P7 | Discussion 3064 的公告评论可只读核对 |
| P8 | packument `latest`、Release 资产与 Market 可见性分别核对；任一未核对保持 `NOT_RUN` |

## 发布物规则

- **必需资产**：P3 生成的版本化 `dsh-kingdom-<version>.tgz`。该包必须包含 `lib/**`，内置 GUI 也随 `lib/**` 交付。
- **可选资产**：GUI zip 仅可作为 GitHub Release 的辅助下载资产；它不替代 tgz，不是安装 GUI 的前提，也不能被写成独立前端或必需发布物。
- GUI 只在本地运行；不重新引入云端部署步骤。

## 发布前与发布后核对

发布前确认：Owner 授权、当前 Work Order、独立审计、P0–P3 本轮证据、冻结 manifest、许可证与资产来源均可核对。真实 Provider、正式数据库迁移和真实重启恢复若未执行，Release Notes 必须保留 `NOT_RUN`。

发布后按 P5–P8 的表逐项只读核对。只有事实已存在的阶段可以写为完成；发布后的知识同步也只能在对应远端事实核对后进行。

## 历史负知识

- pnpm 的 `minimumReleaseAge` 与镜像同步可能使新版本暂不可见；验证使用官方 `https://registry.npmjs.org`，但不得把等待或命令退出码写成发布完成。
- Discussion REST 创建评论曾返回 404；如需公告，使用经验证的 GraphQL 路径，并在 P7 后只读核对实际评论。
- Market 收录不因普通版本迭代而自动要求 Awesome PR；仅核心定位变化才另行评估。
