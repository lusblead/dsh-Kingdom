# dsh-kingdom P0-P3 本地验证与打包工具
#
# 用法（PowerShell 7）：
#   pwsh -File scripts/release.ps1 -Version 1.0.0 -DryRun
#   pwsh -File scripts/release.ps1 -Version 1.0.0
#
# 前置：隔离 stage、工作树干净（仅允许 .agent/ 未跟踪）和已冻结版本。
# 说明：
# - 本脚本只执行 P0-P3，不选择候选文件、不暂存、不提交、不创建 tag，且不会执行远端动作。
# - P4-P8 只能在审计和 Owner gate 后由独立外部 governed 命令执行。
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+$')]
  [string]$Version,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$results = @()
function Check([string]$name, [bool]$ok, [string]$detail) {
  $script:results += [pscustomobject]@{ Name = $name; OK = $ok; Detail = $detail }
  Write-Host ("{0}  {1}  {2}" -f ($(if ($ok) { 'PASS' } else { 'FAIL' })), $name, $detail)
  if (-not $ok) { throw "release aborted at: $name" }
}

Set-Location $root

Write-Host "== dsh-kingdom 发布流水线 v$Version$(if ($DryRun) { ' [DRY-RUN]' } else { ' [FORMAL]' }) =="

# 0) 本地预检
$status = git status --porcelain 2>&1
$dirty = @($status | Where-Object { $_ -notmatch '^\?\? \.agent/' }).Count
Check "P0 工作树干净（仅 .agent/ 未跟踪）" ($dirty -eq 0) ($status -join ' | ')

# 1) 版本必须已冻结；脚本不再修改 package.json 或 README。
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
Check "P1 版本已冻结为 $Version" ($pkg.version -eq $Version) "current=$($pkg.version); expected=$Version"

# 2) 测试（tsc + node --test；所有模式均运行）
& npx tsc -p tsconfig.json --noEmit 2>&1 | Out-Null
Check "P2 tsc typecheck" ($LASTEXITCODE -eq 0) "exit=$LASTEXITCODE"
& npx tsc -p tsconfig.json 2>&1 | Out-Null
$testOut = & node --test tests/*.test.ts 2>&1 | Out-String
$testSummary = (($testOut -split [Environment]::NewLine | Select-String '^ℹ (pass|fail) ' | ForEach-Object { $_.Line.Trim() }) -join ' | ')
Check "P2 node --test 全绿" ($testOut -match 'ℹ pass \d+' -and $testOut -notmatch 'ℹ fail [1-9]') $testSummary

# 3) npm pack
$packDestination = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-kingdom-pack-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $packDestination -ErrorAction Stop | Out-Null
$tgz = Join-Path $packDestination "dsh-kingdom-$Version.tgz"
$tgzExistedBeforePack = [System.IO.File]::Exists($tgz)
$packOut = & npm pack --pack-destination $packDestination 2>&1 | Out-String
$packExit = $LASTEXITCODE
$tgzExistsAfterPack = [System.IO.File]::Exists($tgz)
$packDetail = "exit=$packExit; destination=$packDestination; before=$tgzExistedBeforePack; after=$tgzExistsAfterPack; output=$($packOut.Trim().Split("`n")[-1])"
Check "P3 npm pack 产出 $Version tgz" ($packExit -eq 0 -and -not $tgzExistedBeforePack -and $tgzExistsAfterPack) $packDetail

if ($DryRun) {
  Write-Host "P4 及后续发布副作用在 DryRun 中明确终止；P2/P3 已完成。"
  exit 0
}

# 4) P4-P8 post-audit external governed handoff
throw @"
P4-P8 are intentionally unavailable in scripts/release.ps1.
This script ends at P3. Non-DryRun does not stage, commit, tag, push, upload, publish, or announce.
Future P4 requires a frozen explicit path manifest plus exact commit/tag identity in a separate post-audit external governed command.
Future P6 requires an exact audited tgz path plus expected SHA-256 and must invoke npm publish <exact-audited-tgz> in that separate command.
"@
