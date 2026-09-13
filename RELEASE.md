# dsh-kingdom 发布手册

发布使用独立工作区和明确文件清单，保留开发目录中的其他修改。发布授权、测试结果、远端可见性分别核对；本地打包成功不等于已发布。

## 准备和验证

1. 核实官方 npm 与 GitHub 上的现有版本、远端分支和发布权限。冻结本次范围，排除数据库、凭据、个人路径、本地报告与未确认许可的媒体。
2. 在独立工作区安装锁定依赖：`npm ci --registry=https://registry.npmjs.org`。运行 `npm run typecheck`、`npm test` 及三个隔离 smoke 入口：`scripts/p2-smoke.mjs`、`scripts/p3-smoke.mjs`、`scripts/hotplug-audit.mjs`。
3. 完成独立审查并修复具体问题，更新用户指南、版本说明、受影响流程契约和测试。Windows 专用发布脚本故障测试在其他系统跳过，其余测试必须通过。
4. 按明确清单形成源码提交。在干净工作区运行 `pwsh -File scripts/release.ps1 -Version 2.0.0 -DryRun`。此脚本只执行本地 P0–P3，编译和测试非零退出都会停止；不提交、不推送、不发布。
5. 冻结准确 tgz 和 SHA-256，核对公开入口、类型、12 个 SVG、指南与许可证。`prepack` 重新构建，避免旧编译产物混入。用提取的准确包检查官方 DSH 接线、GUI 四主题与窄屏、隔离安装和数据恢复；记录实际测试来源及未测项。

## 发布与对账

- 推送准确提交后等待 GitHub CI 通过，再创建同版本标签和 GitHub Release。仅上传核实过的 tgz、摘要和公开说明。
- 使用官方 registry 发布已测试的准确 tgz：`npm publish <absolute-tgz-path> --registry=https://registry.npmjs.org --access=public --tag=latest`。不要在此时重新选取开发目录打包。
- 核对 npm 版本、latest、dist integrity，GitHub main/tag/Release 及资产摘要。写入结果不明时先读远端再决定是否重试，不重复发布或覆盖标签。
- 本地 GUI 随插件交付，无需另行部署网站。外部市场收录和第三方镜像同步不由本项目保证；普通版本发布不自动向他人发送公告。

## 升级边界

DSH 兼容范围以本版 package.json 和用户指南为准。不要在插件目录安装第二份宿主 Core。升级前一致备份 SQLite，并在独立路径恢复验证；WAL 模式不能只复制主数据库。

正式用户数据库迁移、真实付费模型收益和真人验收必须有单独证据；隔离 fixture、GUI smoke 或绿色 CI 不能代替它们。保留原版本包与备份，以便回退。
