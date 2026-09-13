import {spawnSync} from 'node:child_process'
import {existsSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const suites = {
  governance: ['governance.test.ts', 'm3s2-v4-governed-runner.test.ts', 'command-recovery.test.ts'],
  gui: ['gui-governed-vertical-flow.test.ts', 'gui-owner-control.test.ts', 'gui-personal-workbench.test.ts'],
  lifecycle: ['gui-control-server.test.ts', 'gui-local-control-security.test.ts', 'command-recovery.test.ts', 'governed-reconcile.test.ts'],
}

export function runSmoke(suite) {
  if (!Object.hasOwn(suites, suite)) throw new Error('Unknown smoke suite')
  if (!existsSync(join(root, 'lib/index.js'))) throw new Error('Run npm run build before the smoke checks')
  // These tests create their own isolated fixtures. Never inspect or copy a user database.
  const result = spawnSync(process.execPath, ['--test', ...suites[suite].map(file => join(root, 'tests', file))], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}
