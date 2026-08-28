/**
 * Copy the Owner-authorized GUI character allowlist into the lib-only package
 * boundary immediately before npm pack.  This is intentionally explicit:
 * no recursive copy and no user-controlled path is involved.
 */
import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceRoot = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(sourceRoot, '../..')
const targetRoot = join(packageRoot, 'lib', 'gui', 'assets', 'characters')
const files = [
  'chancellor-idle.svg',
  'chancellor-working.svg',
  'chancellor-thinking.svg',
  'chancellor-sleeping.svg',
  'supervisor-idle.svg',
  'supervisor-working.svg',
  'supervisor-thinking.svg',
  'supervisor-sleeping.svg',
  'knight-redraw-r1-idle.svg',
  'knight-redraw-r1-working.svg',
  'knight-redraw-r1-thinking.svg',
  'knight-redraw-r1-sleeping.svg',
]

mkdirSync(targetRoot, { recursive: true })
for (const file of files) {
  const source = join(sourceRoot, 'assets', 'characters', file)
  const target = join(targetRoot, file)
  const sourceSize = statSync(source).size
  copyFileSync(source, target)
  if (statSync(target).size !== sourceSize) throw new Error(`GUI character asset copy size mismatch: ${file}`)
}
