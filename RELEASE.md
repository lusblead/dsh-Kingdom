# dsh-kingdom 发布手册（固定流水线）

> 目标：任何版本发布走同一条可重复的链，市场侧更新自动可见，无需反复改 Awesome 条目；
> 每次发布/维护决策变更后，同步三处知识载体，让**后续所有相关会话**都知道（见「知识同步」）。

## 知识同步（让后续会话都知道）

项目状态有两套「会话间知识载体」，任何**发布完成**或**维护决策变更**后都必须同步：

| 载体 | 位置 | 何时更新 | 校验 |
|---|---|---|---|
| **Context Pack**（交接文档） | `D:\dsh\kingdom-install-test\.context-relay\packs\` | 每次阶段结束/发布后：`context_relay.py revise` 旧 pack → 更新 claims → finalize → validate → bundle | `validate` 0 error |
| **工程经验库** | `D:\dsh\kingdom\.agent\PROJECT_EXPERIENCE.md` + Obsidian `projects/dsh-kingdom/ENGINEERING_LESSONS.md` | 新经验/新负知识产生时：`/learn` 增量（新增 PX/EL） | `validate_docs.py --root D:\dsh\kingdom` |

新会话/换模型继续工作时：先读最新 Context Pack（`RESUME.md` → `HANDOFF.md`），再用 `recall_experience.py` 召回经验。

## 关键维护决策（已裁决，勿回退）

- **GUI 是纯本地组件**：界面、网关、数据全在用户机器上运行，不依赖任何云端服务（2026-08-18 裁决）。
- **云端页面已停止维护**：早期实验性的 `agent-governance-ui.luyus704.chatgpt.site` 不再部署/更新；README、GUI zip 文档中的指路已移除。不要在发布流程里再引入云端部署步骤。
- **Market 更新自动可见**：已安装用户经 npm latest / GitHub HEAD 双通道自动看到更新（TTL 30 分钟）；版本迭代无需再提 Awesome PR（仅核心定位变化才改 `data/plugins/lusblead__dsh-Kingdom.yml`）。
- **发布物一致性**：GitHub Release（tgz + GUI zip）→ npm latest → Discussion 3064 公告，三渠道同步。

## 发布链（一条命令）

```powershell
pwsh -File scripts/release.ps1 -Version <新版本> [-NotesFile changelog/v<版本>.md] [-GuiZip <gui zip 路径>]
```

流水线步骤（脚本自动执行并逐项 PASS/FAIL）：

```text
代码完成
   ↓
P0 预检（gh 认证 / npm 登录 / 工作树干净）
   ↓
P1 package.json + README 版本引用同步
   ↓
P2 测试（tsc --noEmit + node --test；GUI 测试在独立 GUI 包）
   ↓
P3 npm pack → dsh-kingdom-<v>.tgz
   ↓
P4 git commit + tag v<v> + push（含 tag）
   ↓
P5 GitHub Release v<v>（tgz + GUI zip + Release Notes）
   ↓
P6 npm publish（latest → 新版本）
   ↓
P7 Discussion 3064 公告（GraphQL addDiscussionComment）
   ↓
P8 Market 可见性检查（packument latest 传播确认 + Release 资产核对）
   ↓
已安装用户 30 分钟内看到 Update（dsh-market TTL）
```

- `-DryRun`：只走到 pack，不发布（预检 + bump + 测试 + pack）。
- 手工兜底顺序（等同 P1→P8）：`npm test` → bump → `npm pack` → `gh release create` → `npm publish` → Discussion 公告 → `npm view dsh-kingdom dist-tags` 复验。

## Market 更新机制（为什么不用每次提 Awesome PR）

| 用户安装方式 | Market 判断更新依据 |
|---|---|
| `dsh plugin add dsh-kingdom`（npm） | npm `latest` dist-tag（SemVer 比较，缓存 TTL 30 分钟） |
| `dsh plugin add github:lusblead/dsh-Kingdom` | GitHub 仓库 HEAD 变化（安装时锁定的 commit vs 当前 HEAD） |
| `file:` / `link:` 安装 | 不自动判断更新 |

**结论**：正常版本迭代（0.5.1 → 0.5.2 → 0.6.0）不需要改 Awesome 条目。
`awesome-dsh-plugin/data/plugins/lusblead__dsh-Kingdom.yml` 只描述"Kingdom 是什么、在哪、什么分类"；
**仅当核心定位变化**（一句话描述已不准确，如发展为 distributed multi-agent governance）才提一个改 yml 描述的小 PR。

## Release Notes 格式（让用户知道"为什么值得更新"）

Market 的 `Update available` 只回答"有新版吗"；GitHub Release Notes 回答"值不值得升"。
用浓缩价值格式（New / Governance / Assets / Quality）：

```markdown
## v0.6.0

### New
- <本版新增能力，用户可感知>

### Governance
- <治理语义变更/新裁决>

### Assets
- dsh-kingdom-0.6.0.tgz (npm latest)
- dsh-kingdom-gui-0.6.0.zip (standalone front-end)

### Quality
- <测试/验证摘要，如插件 n/n、GUI n/n、安装验证 n/n>
```

参考实现：v0.5.1 的 Release Notes（`gh release view v0.5.1`）。

## 注意事项（负知识）

- **pnpm minimumReleaseAge**：发布后 24h 内，用户 `dsh plugin add` 会被 pnpm 静默降级到旧版本（`@latest` 解析到成熟旧版且 exit 0）。安装新版本需 `--config.minimumReleaseAge=0`，或等发布满一天。dsh-market 的"立即更新"按钮已有 one-shot bypass。
- **npmmirror 同步延迟**：镜像 registry 可能滞后数小时；验证/安装用官方 `https://registry.npmjs.org`。
- **GUI zip 独立维护**：GUI 合并包（gui-source → vinext build → prebuilt-dist）与插件仓库分开；tgz 不含前端。发布时把 GUI zip 附到 Release 即可。
- **Discussion 公告**：REST 创建评论会 404，用 GraphQL `addDiscussionComment`（脚本已封装）。
- **Market 收录只做一次**：PR #1668 已合并；之后版本迭代不动 Awesome。

## 发布后检查清单

1. `npm view dsh-kingdom dist-tags --registry=https://registry.npmjs.org` → latest = 新版本
2. `gh release view v<v>` → 资产齐全（tgz + GUI zip）、Notes 渲染正常
3. Discussion 3064 出现公告评论
4. 已安装用户（npm 安装）等待 ≤30 分钟 → dsh-market 显示 Update available
5. 干净环境安装验证（可选）：`pwsh -File ..\kingdom-install-test\scripts\acceptance-v0X.ps1`
6. **知识同步**：revise 更新 Context Pack（finalize + validate + bundle）+ `/learn` 经验库增量（validate_docs.py 通过）——让后续会话知道本次发布与任何决策变更
