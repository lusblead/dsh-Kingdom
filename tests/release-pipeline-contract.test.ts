import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const sourcePath = fileURLToPath(new URL('../scripts/release.ps1', import.meta.url))

async function releaseSource(): Promise<string> {
  return readFile(sourcePath, 'utf8')
}

for (const failedStep of ['build', 'test'] as const) {
  test(`release rejects a failed ${failedStep} process before packing even with a passing summary`, { skip: process.platform !== 'win32' }, async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'kingdom-release-gate-'))
    try {
      await mkdir(join(fixture, 'scripts'))
      await writeFile(join(fixture, 'scripts', 'release.ps1'), await releaseSource())
      await writeFile(join(fixture, 'package.json'), '{"version":"2.0.0"}')
      await writeFile(join(fixture, 'check.ps1'), `
$ErrorActionPreference = 'Stop'
$global:compileCalls = 0
function global:git { $global:LASTEXITCODE = 0 }
function global:npx {
  $global:compileCalls++
  $global:LASTEXITCODE = $(if ('${failedStep}' -eq 'build' -and $global:compileCalls -eq 2) { 1 } else { 0 })
}
function global:node {
  Write-Output 'ℹ pass 1'
  Write-Output 'ℹ fail 0'
  $global:LASTEXITCODE = $(if ('${failedStep}' -eq 'test') { 1 } else { 0 })
}
function global:npm { throw 'UNEXPECTED_PACK' }
try {
  & (Join-Path $PSScriptRoot 'scripts/release.ps1') -Version '2.0.0' -DryRun
  throw 'UNEXPECTED_RELEASE_SUCCESS'
} catch {
  if ($_.Exception.Message -notlike 'release aborted at: P2*') { Write-Error $_; exit 2 }
  Write-Output 'EXPECTED_P2_REJECTION'
  exit 0
}
`)
      const child = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-File', join(fixture, 'check.ps1')], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
      assert.equal(child.status, 0, child.stdout + child.stderr)
      assert.match(child.stdout, /EXPECTED_P2_REJECTION/u)
      assert.doesNotMatch(child.stdout + child.stderr, /UNEXPECTED_PACK|UNEXPECTED_RELEASE_SUCCESS/u)
    } finally {
      const owned = relative(resolve(tmpdir()), resolve(fixture))
      assert.ok(owned.startsWith('kingdom-release-gate-') && !owned.includes('..'))
      await rm(fixture, { recursive: true, force: true })
    }
  })
}

function fromMarker(source: string, marker: string): string {
  const index = source.indexOf(marker)
  assert.notEqual(index, -1, 'missing ' + marker)
  return source.slice(index)
}

test('P0-P3 local validation and fresh pack are fail-closed', async () => {
  const source = await releaseSource()

  assert.match(source, /function Check[\s\S]*if \(-not \$ok\) \{ throw "release aborted at: \$name" \}/u)
  assert.match(source, /# 0\) 本地预检/u)
  assert.match(source, /git status --porcelain/u)
  assert.match(source, /\$pkg\.version -eq \$Version/u)
  assert.doesNotMatch(source, /Set-Content package\.json/u)
  assert.match(source, /& npx tsc -p tsconfig\.json --noEmit/u)
  assert.match(source, /node --test tests\/\*\.test\.ts/u)
  assert.match(source, /npm pack --pack-destination \$packDestination/u)
  assert.match(source, /\$packExit -eq 0 -and -not \$tgzExistedBeforePack -and \$tgzExistsAfterPack/u)
})

test('DryRun stops after P3 before the external post-audit handoff', async () => {
  const source = await releaseSource()
  const p3 = source.indexOf('# 3) npm pack')
  const dryRun = source.indexOf('if ($DryRun) {', p3)
  const p4 = source.indexOf('# 4) P4-P8 post-audit external governed handoff')

  assert.ok(p3 < dryRun && dryRun < p4)
  assert.match(source.slice(dryRun, p4), /exit 0/u)
  assert.match(source.slice(dryRun, p4), /P4 及后续发布副作用在 DryRun 中明确终止/u)
})

test('P4-P8 are unreachable and legacy side-effect commands are absent', async () => {
  const source = await releaseSource()
  const handoff = fromMarker(source, '# 4) P4-P8 post-audit external governed handoff')

  assert.match(handoff, /throw @"/u)
  assert.match(handoff, /P4-P8 are intentionally unavailable in scripts\/release\.ps1/u)
  assert.match(handoff, /Non-DryRun does not stage, commit, tag, push, upload, publish, or announce/u)
  assert.doesNotMatch(source, /git add package\.json README\.md/u)
  assert.doesNotMatch(source, /git push origin main --tags/u)
  assert.doesNotMatch(source, /^\s*(?:&\s*)?npm\s+publish(?:\s|$)/mu)
  assert.doesNotMatch(source, /gh release create/u)
  assert.doesNotMatch(source, /\[switch\]\$FormalRelease/u)
})

test('future P4 and P6 handoff requires immutable identities', async () => {
  const handoff = fromMarker(
    await releaseSource(),
    '# 4) P4-P8 post-audit external governed handoff',
  )

  assert.match(handoff, /frozen explicit path manifest plus exact commit\/tag identity/u)
  assert.match(handoff, /separate post-audit external governed command/u)
  assert.match(handoff, /exact audited tgz path plus expected SHA-256/u)
  assert.match(handoff, /npm publish <exact-audited-tgz>/u)
})
