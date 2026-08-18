# dsh-kingdom 发布流水线（固定链：test → bump → pack → Release → npm → Discussion → market 可见性检查）
#
# 用法（PowerShell 7）：
#   pwsh -File scripts/release.ps1 -Version 0.6.0
#   pwsh -File scripts/release.ps1 -Version 0.6.0 -NotesFile changelog/v0.6.0.md -GuiZip D:\...\dsh-kingdom-gui-0.6.0.zip
#   pwsh -File scripts/release.ps1 -Version 0.6.0 -DryRun        # 只走到 pack，不发布
#
# 前置：gh 已认证（lusblead）、npm 已登录、git 工作树干净（允许 .agent/ 未跟踪）。
# 说明：
# - Market 更新自动可见（npm latest / GitHub HEAD 双通道，TTL 30min），无需再提 Awesome PR；
#   只有插件核心定位变化才改 awesome-dsh-plugin 条目。
# - 发布后 24h 内用户安装会被 pnpm minimumReleaseAge 静默降级——RELEASE.md 已记录。
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$NotesFile,
  [string]$GuiZip,
  [switch]$SkipTests,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$results = @()
function Check([string]$name, [bool]$ok, [string]$detail) {
  $script:results += [pscustomobject]@{ Name = $name; OK = $ok; Detail = $detail }
  Write-Host ("{0}  {1}  {2}" -f ($(if ($ok) { 'PASS' } else { 'FAIL' })), $name, $detail)
  if (-not $ok -and -not $script:dry) { throw "release aborted at: $name" }
}
$script:dry = [bool]$DryRun
Set-Location $root

Write-Host "== dsh-kingdom 发布流水线 v$Version$(if ($DryRun) { ' [DRY-RUN]' }) =="

# 0) 预检
$ghOk = gh auth status 2>&1 | Out-String
Check "P0 gh 已认证" ($ghOk -match 'Logged in') (($ghOk -split "`n" | Select-String 'Logged in' | Select-Object -First 1).ToString().Trim())
$npmWho = npm whoami --registry=https://registry.npmjs.org 2>&1 | Out-String
Check "P0 npm 已登录" ($npmWho.Trim() -match 'lusblead|^\S+$') ($npmWho.Trim())
$status = git status --porcelain 2>&1
$dirty = @($status | Where-Object { $_ -notmatch '^\?\? \.agent/' }).Count
Check "P0 工作树干净（仅 .agent/ 未跟踪）" ($dirty -eq 0) ($status -join ' | ')
if ($script:dry) { $script:dry = $false } # 预检后的步骤才真正跳过

# 1) 版本 bump（package.json + README 版本引用同步）
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
Check "P1 当前版本 $($pkg.version) ≠ 目标 $Version" ($pkg.version -ne $Version) "from $($pkg.version) to $Version"
if (-not $DryRun) {
  $old = $pkg.version
  (Get-Content package.json -Raw).Replace('"version": "' + $old + '"', '"version": "' + $Version + '"') | Set-Content package.json -Encoding UTF8 -NoNewline
  # README 同步（badge / tgz 下载路径等显式旧版本号）
  (Get-Content README.md -Raw).Replace($old, $Version) | Set-Content README.md -Encoding UTF8 -NoNewline
  Check "P1 README 版本引用已同步" ((Select-String README.md -Pattern $old -SimpleMatch | Measure-Object).Count -eq 0) "replaced $old → $Version"
}

# 2) 测试（tsc + node --test；GUI 测试在独立 GUI 包维护）
if ($SkipTests) {
  Check "P2 测试跳过（-SkipTests）" $true "skipped"
} elseif (-not $DryRun) {
  & npx tsc -p tsconfig.json --noEmit 2>&1 | Out-Null
  Check "P2 tsc typecheck" ($LASTEXITCODE -eq 0) "exit=$LASTEXITCODE"
  & npx tsc -p tsconfig.json 2>&1 | Out-Null
  $testOut = & node --test tests/*.test.ts 2>&1 | Out-String
  Check "P2 node --test 全绿" ($testOut -match '^ℹ pass \d+' -and $testOut -notmatch 'fail [1-9]') (($testOut -split "`n" | Select-String '^ℹ (pass|fail) ' | ForEach-Object { $_.Line.Trim() }) -join ' | ')
}

# 3) npm pack
if (-not $DryRun) {
  $packOut = & npm pack --pack-destination "$root\..\kingdom-install-test" 2>&1 | Out-String
  $tgz = "$root\..\kingdom-install-test\dsh-kingdom-$Version.tgz"
  Check "P3 npm pack 产出 $Version tgz" (Test-Path $tgz) $packOut.Trim().Split("`n")[-1]
}

# 4) git commit + tag + push
if (-not $DryRun) {
  & git add package.json README.md 2>&1 | Out-Null
  & git commit -m "chore: release v$Version" 2>&1 | Out-Null
  Check "P4 commit" ($LASTEXITCODE -eq 0) "chore: release v$Version"
  & git tag "v$Version" 2>&1 | Out-Null
  & git push origin main --tags 2>&1 | Out-Null
  Check "P4 push + tag v$Version" ($LASTEXITCODE -eq 0) "origin main + v$Version"
}

# 5) GitHub Release（tgz + GUI zip + Notes）
if (-not $DryRun) {
  $notes = if ($NotesFile -and (Test-Path $NotesFile)) { Get-Content $NotesFile -Raw }
            else { @"
## v$Version

### New
- （填写：本版新增能力）

### Governance
- （填写：治理语义变更）

### Assets
- dsh-kingdom-$Version.tgz (npm latest)
- dsh-kingdom-gui-$Version.zip (standalone front-end)

### Quality
- （填写：测试/验证摘要）
"@ }
  $guiArg = @()
  if ($GuiZip -and (Test-Path $GuiZip)) { $guiArg = @($GuiZip) }
  elseif (-not $GuiZip) { $cand = "$root\..\kingdom-install-test\dsh-kingdom-gui-$Version.zip"; if (Test-Path $cand) { $guiArg = @($cand) } }
  $relOut = & gh release create "v$Version" "$root\..\kingdom-install-test\dsh-kingdom-$Version.tgz" @guiArg --repo lusblead/dsh-Kingdom --title "v$Version" --notes $notes 2>&1 | Out-String
  Check "P5 GitHub Release v$Version" ($LASTEXITCODE -eq 0) $relOut.Trim()
}

# 6) npm publish
if (-not $DryRun) {
  $pubOut = & npm publish --registry=https://registry.npmjs.org 2>&1 | Out-String
  Check "P6 npm publish" ($pubOut -match 'dsh-kingdom@' + $Version) ($pubOut.Trim().Split("`n") | Select-Object -Last 2 | Out-String).Trim()
}

# 7) Discussion 公告（GraphQL addDiscussionComment；REST POST 404，勿用）
if (-not $DryRun) {
  $nodeId = gh api repos/deepseek-ai/deepseek-harness/discussions/3064 --jq .node_id 2>&1
  $body = "## 🏰 dsh-kingdom v$Version 发布`n`nGitHub Release: https://github.com/lusblead/dsh-Kingdom/releases/tag/v$Version`n`nnpm: dsh-kingdom@$Version (latest)。已安装用户经 dsh-market 自动看到 Update（TTL 30min）。详见 Release Notes。"
  $esc = $body.Replace('\', '\\').Replace('"', '\"').Replace("`n", '\n')
  $q = "mutation { addDiscussionComment(input: {discussionId: `"$nodeId`", body: `"$esc`"}) { comment { url } } }"
  $discOut = gh api graphql -f query=$q 2>&1 | Out-String
  Check "P7 Discussion 3064 公告" ($discOut -match 'discussioncomment') (($discOut -split "`n" | Select-String 'url' | Select-Object -First 1).Line.Trim())
}

# 8) Market 可见性检查（npm dist-tags 传播确认；已安装用户更新自动可见）
if (-not $DryRun) {
  $propagated = $false
  for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Seconds 15
    $doc = Invoke-RestMethod -Uri "https://registry.npmjs.org/dsh-kingdom" -UseBasicParsing
    if ($doc.'dist-tags'.latest -eq $Version) { $propagated = $true; break }
  }
  Check "P8 npm latest=$Version（传播确认）" $propagated "latest=$($doc.'dist-tags'.latest)"
  $assets = gh release view "v$Version" --repo lusblead/dsh-Kingdom --json assets --jq '.assets[].name' 2>&1 | Out-String
  Check "P8 Release 资产齐全" ($assets -match "dsh-kingdom-$Version.tgz") ($assets.Trim() -replace "`n", ' | ')
}

# 9) 摘要
Write-Host ""
$failed = @($results | Where-Object { -not $_.OK })
Write-Host ("===== 发布流水线 v$Version 汇总: {0}/{1} PASS =====" -f ($results.Count - $failed.Count), $results.Count)
if ($failed.Count -gt 0) { $failed | ForEach-Object { Write-Host "  FAIL $($_.Name): $($_.Detail)" }; exit 1 }
Write-Host "Market 自动可见：已安装用户 30 分钟内看到 Update（npm latest / GitHub HEAD 双通道）；无需提 Awesome PR。"
