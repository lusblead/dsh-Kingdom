#!/usr/bin/env node

/**
 * Bounded REAL DSH/Provider runner contract for run
 * 20260824-02-v10-dialogue-gui-closure.
 *
 * The default orchestration deliberately stops at a keyless composition probe.
 * An explicit, double opt-in REAL-attempt branch is also implemented, but is
 * never selected by default. It owns the temporary product stage and uses
 * only the public DSH SDK/runtime surface; no branch reads a private profile,
 * formal store, historical Session, or credential-bearing configuration.
 */

import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

export const RUN_ID = '20260824-02-v10-dialogue-gui-closure'
export const FEATURE_ID = 'real-dsh-provider-v10-e2e-runner'
export const REQUESTED_MODEL_DEFAULT = 'gpt-5.6-luna/max'
// Portable defaults; callers can still pass explicit roots and wrapper paths.
export const PRODUCT_ROOT_DEFAULT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const DSH_ROOT_DEFAULT = resolve(PRODUCT_ROOT_DEFAULT, '../deepseek-harness')
export const DSH_WRAPPER_DEFAULT = resolve(PRODUCT_ROOT_DEFAULT, '../bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
export const JSONRPC_DEMO_RELATIVE = join('packages', 'examples', 'jsonrpc-demo', 'lib', 'bin.js')
export const SDK_CLIENT_RELATIVE = join('packages', 'sdk', 'client', 'lib', 'index.js')
export const OPPORTUNITY_LEDGER_FILE = 'provider-opportunity-ledger.json'

export const PRODUCT_ALLOWLIST = [
  'src',
  'tests',
  'package.json',
  'tsconfig.json',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
]

export const RUNNER_LAYOUT_NAMES = [
  'product-stage',
  'artifacts',
  'worker-workspace',
  'dsh-home',
  'pnpm-store',
  'private-runtime',
  'bounded-evidence',
]

export const GOVERNED_SEQUENCE = [
  'direct Owner Slash bootstrap',
  'Chancellor kingdom_plan_task(requirement tool:pwsh)',
  'Supervisor assign',
  'governed start',
  'task_detail',
  'verification',
  'review ACCEPT',
  'detail DONE',
]

const ROBOCOPY_SUCCESS_MAX = 7
const FORBIDDEN_INPUT_MARKERS = [
  '--prompt',
  '--provider-call',
  '--run-provider',
  '--live',
  '--resume',
  '--session',
]

const RUNNER_MODES = new Set(['keyless', 'real-attempt'])
const REAL_ATTEMPT_REQUIRED_FIELDS = [
  ['requirement', 'REQUIREMENT_REQUIRED'],
]
const RUNNER_CONTEXT_INPUT_MARKERS = [
  '--task-id',
  '--attempt-no',
  '--kingdom-dispatch-id',
  '--session-id',
]
const PRODUCT_BROKER_SERIALIZED_ENV = 'DSH_KINGDOM_BROKER_SERIALIZED_ENV'
const PRODUCT_CONTEXT_VIEW_KEYS = [
  'phase',
  'revision',
  'dispatchState',
  'executionState',
  'leaseState',
  'receiptObserved',
  'correlated',
  'terminalObserved',
  'cleanupStatus',
  'claimRecorded',
]

let runnerProviderBoundaryCalls = 0

function providerBoundaryCounterFrom(start) {
  const end = runnerProviderBoundaryCalls
  return { start, end, increments: end - start }
}

const FORBIDDEN_EVIDENCE_WORDS = /prompt|provider|credential|token|secret|api[_-]?key|password|raw|jsonl/i

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyText(value, name, { maxLength = 200 } = {}) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name.toUpperCase()}_REQUIRED`)
  }
  if (value.length > maxLength || /[\u0000\r\n]/u.test(value)) {
    throw new Error(`${name.toUpperCase()}_INVALID`)
  }
  return value.trim()
}

function readProductBrokerSerializedEnvironment(serialized = process.env[PRODUCT_BROKER_SERIALIZED_ENV]) {
  if (typeof serialized !== 'string' || serialized.trim() === '') {
    throw new Error('PRODUCT_BROKER_SERIALIZED_ENV_REQUIRED')
  }
  let parsed
  try {
    parsed = JSON.parse(serialized)
  } catch {
    throw new Error('PRODUCT_BROKER_SERIALIZED_ENV_INVALID')
  }
  if (!isRecord(parsed)) throw new Error('PRODUCT_BROKER_SERIALIZED_ENV_INVALID')
  const keys = Object.keys(parsed)
  const environmentKeys = [
    'DSH_KINGDOM_BROKER_REQUIRED',
    'DSH_KINGDOM_BROKER_RENDEZVOUS_DIR',
    'DSH_KINGDOM_BROKER_LAUNCH_NONCE',
  ]
  const bootstrapKeys = ['environment', 'descriptor']
  const isEnvironment = keys.length === environmentKeys.length
    && environmentKeys.every(key => keys.includes(key))
  const isBootstrap = keys.length === bootstrapKeys.length
    && bootstrapKeys.every(key => keys.includes(key))
  if (!isEnvironment && !isBootstrap) throw new Error('PRODUCT_BROKER_SERIALIZED_ENV_INVALID')
  return parsed
}

async function connectProductRunnerContextBroker() {
  const serializedEnvironment = readProductBrokerSerializedEnvironment()
  let productRoot
  try {
    productRoot = await import('dsh-kingdom')
  } catch {
    throw new Error('PRODUCT_ROOT_CONNECTOR_UNAVAILABLE')
  }
  if (!isRecord(productRoot) || typeof productRoot.connectRunnerContextBroker !== 'function') {
    throw new Error('PRODUCT_ROOT_CONNECTOR_UNAVAILABLE')
  }
  return productRoot.connectRunnerContextBroker(serializedEnvironment)
}

function validateProductContextView(value) {
  if (!isRecord(value)) throw new Error('PRODUCT_CONTEXT_VIEW_INVALID')
  const keys = Object.keys(value)
  if (keys.length !== PRODUCT_CONTEXT_VIEW_KEYS.length
    || keys.some(key => !PRODUCT_CONTEXT_VIEW_KEYS.includes(key))) {
    throw new Error('PRODUCT_CONTEXT_VIEW_INVALID')
  }
  if (value.phase !== 'ACQUIRED'
    || value.dispatchState !== 'INTENDED'
    || value.executionState !== 'STARTING'
    || value.leaseState !== 'EXECUTING'
    || value.receiptObserved !== false
    || value.correlated !== false
    || value.terminalObserved !== false
    || value.cleanupStatus !== null
    || value.claimRecorded !== false) {
    throw new Error('PRODUCT_CONTEXT_VIEW_NOT_DISPATCH_READY')
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new Error('PRODUCT_CONTEXT_VIEW_INVALID')
  }
  return {
    phase: value.phase,
    revision: value.revision,
    dispatchState: value.dispatchState,
    executionState: value.executionState,
    leaseState: value.leaseState,
    receiptObserved: value.receiptObserved,
    correlated: value.correlated,
    terminalObserved: value.terminalObserved,
    cleanupStatus: value.cleanupStatus,
    claimRecorded: value.claimRecorded,
  }
}

/**
 * Contract simulations use generated correlation values for bounded event
 * accounting only.  They are explicitly not a production provenance source;
 * REAL_PRODUCTION stops before this helper can be reached.
 */
function createContractSimulationContext() {
  const context = {
    taskId: `runner-task-${randomUUID()}`,
    attemptNo: 1,
    kingdomDispatchId: `runner-dispatch-${randomUUID()}`,
    sessionId: `runner-${randomUUID()}`,
  }
  return context
}

function simulationContextRecord(value) {
  if (!isRecord(value) || typeof value.taskId !== 'string' || value.taskId === ''
    || value.attemptNo !== 1 || typeof value.kingdomDispatchId !== 'string'
    || value.kingdomDispatchId === '' || typeof value.sessionId !== 'string'
    || value.sessionId === '') {
    throw new Error('CONTRACT_SIMULATION_CONTEXT_REQUIRED')
  }
  return value
}

function asExitCode(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (value === undefined || value === null || value === '') return 0
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : 1
}

function errorCode(error, fallback = 'RUNNER_BLOCKED') {
  if (isRecord(error) && typeof error.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code)) {
    return error.code
  }
  if (error instanceof Error) {
    const match = /^([A-Z][A-Z0-9_]+)/u.exec(error.message)
    if (match) return match[1]
  }
  return fallback
}

function safeError(error, fallback = 'RUNNER_BLOCKED') {
  return { code: errorCode(error, fallback) }
}

function versionTuple(value) {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/u.exec(String(value))
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

export function nodeVersionAtLeast(value, requiredMajor = 22, requiredMinor = 19) {
  const parsed = versionTuple(value)
  if (parsed === null) return false
  return parsed[0] > requiredMajor
    || (parsed[0] === requiredMajor && parsed[1] >= requiredMinor)
}

function pathForComparison(value) {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Return true only for root itself or a real descendant, never a prefix sibling. */
export function isWithinRoot(root, candidate) {
  const rootPath = pathForComparison(root)
  const candidatePath = pathForComparison(candidate)
  const rel = relative(rootPath, candidatePath)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export function assertWithinRoot(root, candidate, label = 'path') {
  if (!isWithinRoot(root, candidate)) throw new Error(`${label.toUpperCase()}_OUTSIDE_ROOT`)
  return resolve(candidate)
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return false
    throw error
  }
}

async function directoryIsFresh(path) {
  try {
    const entries = await readdir(path)
    return entries.length === 0
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return true
    throw error
  }
}

/** Create a fresh runner-owned tree; no product or DSH root is used as a temp root. */
export async function createRunnerLayout({ root: requestedRoot } = {}) {
  const root = requestedRoot === undefined
    ? await mkdtemp(join(tmpdir(), 'dsh-kingdom-v10-runner-'))
    : resolve(nonEmptyText(requestedRoot, 'root', { maxLength: 1000 }))

  if (requestedRoot !== undefined) {
    if (await pathExists(root)) {
      if (!(await directoryIsFresh(root))) throw new Error('TEMP_ROOT_NOT_FRESH')
    } else {
      await mkdir(root, { recursive: false })
    }
  }

  const directories = Object.fromEntries(
    await Promise.all(RUNNER_LAYOUT_NAMES.map(async name => {
      const path = join(root, name)
      await mkdir(path, { recursive: false })
      return [name.replaceAll('-', ''), path]
    })),
  )

  const dshHome = directories.dshhome
  const profileDir = join(dshHome, 'profiles', 'v10-runner')
  await mkdir(profileDir, { recursive: true })
  const privateRuntime = directories.privateruntime
  const npmUserConfig = join(privateRuntime, 'npm-user-config')
  await writeFile(npmUserConfig, '; runner-owned empty npm user config\n', 'utf8')

  const layout = {
    root,
    productStage: directories.productstage,
    artifacts: directories.artifacts,
    workerWorkspace: directories.workerworkspace,
    dshHome,
    pnpmStore: directories.pnpmstore,
    privateRuntime,
    boundedEvidence: directories.boundedevidence,
    profileDir,
    profileOverlayPath: join(profileDir, 'cordis.patch.yml'),
    npmUserConfig,
  }

  for (const value of Object.values(layout)) {
    if (typeof value === 'string') assertWithinRoot(root, value, 'runner_layout')
  }
  return layout
}

/** Keep child processes away from the parent user/provider configuration. */
export function buildRunnerEnvironment(layout) {
  const safeEnvironment = {}
  for (const name of ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR']) {
    const value = process.env[name]
    if (typeof value === 'string' && value !== '') safeEnvironment[name] = value
  }
  safeEnvironment.DSH_HOME = layout.dshHome
  safeEnvironment.npm_config_userconfig = layout.npmUserConfig
  safeEnvironment.npm_config_cache = join(layout.privateRuntime, 'npm-cache')
  safeEnvironment.npm_config_audit = 'false'
  safeEnvironment.npm_config_fund = 'false'
  safeEnvironment.npm_config_update_notifier = 'false'
  safeEnvironment.PNPM_STORE_DIR = layout.pnpmStore
  return safeEnvironment
}

export function buildProfileOverlayEntries() {
  return [
    {
      id: 'sdk-jsonrpc-server',
      name: '@deepseek-ai/dsh-sdk-jsonrpc-server',
    },
    {
      id: 'dsh-kingdom',
      name: 'dsh-kingdom',
      config: {
        authMode: 'session-bound',
        guiPort: 0,
      },
    },
  ]
}

export function buildProfileOverlay() {
  const entries = buildProfileOverlayEntries()
  const serialized = [
    '# runner-owned keyless composition overlay; no Provider route or credential fields',
    '- insert:',
    `    - id: ${entries[0].id}`,
    `      name: '${entries[0].name}'`,
    `    - id: ${entries[1].id}`,
    `      name: '${entries[1].name}'`,
    '      config:',
    '        authMode: session-bound',
    '        guiPort: 0',
    '',
  ].join('\n')
  if (FORBIDDEN_EVIDENCE_WORDS.test(serialized.replace('Provider route', 'route'))) {
    // The guard is intentionally about keys/values, not this explanatory comment.
    const withoutComment = serialized.split('\n').slice(1).join('\n')
    if (/provider|credential|token|secret|api[_-]?key|password/i.test(withoutComment)) {
      throw new Error('PROFILE_OVERLAY_PRIVATE_FIELD')
    }
  }
  return serialized
}

export async function writeProfileOverlay(layout) {
  const overlay = buildProfileOverlay()
  assertWithinRoot(layout.dshHome, layout.profileOverlayPath, 'profile_overlay')
  await writeFile(layout.profileOverlayPath, overlay, 'utf8')
  return {
    pathLabel: 'dsh-home/profiles/v10-runner/cordis.patch.yml',
    entryIds: buildProfileOverlayEntries().map(entry => entry.id),
    authMode: 'session-bound',
    guiPort: 0,
  }
}

export function parseRunnerArgs(argv) {
  const parsed = {
    mode: 'keyless',
    providerAlias: undefined,
    model: undefined,
    skipProductStage: false,
    confirmRealAttempt: false,
    requirement: undefined,
    runnerRoot: undefined,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      parsed.help = true
      continue
    }
    if (argument === '--no-product-stage') {
      parsed.skipProductStage = true
      continue
    }
    if (argument === '--confirm-real-attempt') {
      parsed.confirmRealAttempt = true
      continue
    }
    if (FORBIDDEN_INPUT_MARKERS.some(marker => argument === marker || argument.startsWith(`${marker}=`))) {
      throw new Error('PROVIDER_CALL_INPUT_FORBIDDEN')
    }
    if (RUNNER_CONTEXT_INPUT_MARKERS.some(marker => argument === marker || argument.startsWith(`${marker}=`))) {
      throw new Error('RUNNER_CONTEXT_INPUT_FORBIDDEN')
    }
    const match = /^(--mode|--provider-alias|--model|--requirement|--runner-root)=(.*)$/u.exec(argument)
    if (match) {
      const optionName = match[1]
      const fieldName = {
        '--mode': 'mode',
        '--provider-alias': 'providerAlias',
        '--model': 'model',
        '--requirement': 'requirement',
        '--runner-root': 'runnerRoot',
      }[optionName]
      const valueName = optionName.slice(2).replaceAll('-', '_')
      parsed[fieldName] = nonEmptyText(match[2], valueName, {
        maxLength: optionName === '--requirement' ? 4_000 : 1_000,
      })
      continue
    }
    if (argument === '--mode' || argument === '--provider-alias' || argument === '--model'
      || argument === '--requirement' || argument === '--runner-root') {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('-')) throw new Error(`${argument.slice(2).replaceAll('-', '_').toUpperCase()}_REQUIRED`)
      const fieldName = {
        '--mode': 'mode',
        '--provider-alias': 'providerAlias',
        '--model': 'model',
        '--requirement': 'requirement',
        '--runner-root': 'runnerRoot',
      }[argument]
      const valueName = argument.slice(2).replaceAll('-', '_')
      parsed[fieldName] = nonEmptyText(next, valueName, {
        maxLength: argument === '--requirement' ? 4_000 : 1_000,
      })
      index += 1
      continue
    }
    throw new Error('UNKNOWN_RUNNER_ARGUMENT')
  }

  if (parsed.help) return parsed
  parsed.providerAlias = nonEmptyText(parsed.providerAlias, 'provider_alias')
  parsed.model = nonEmptyText(parsed.model, 'model')
  if (!RUNNER_MODES.has(parsed.mode)) throw new Error('RUNNER_MODE_INVALID')
  if (parsed.mode === 'real-attempt') {
    if (parsed.confirmRealAttempt !== true) throw new Error('REAL_ATTEMPT_CONFIRMATION_REQUIRED')
    if (parsed.skipProductStage) throw new Error('REAL_ATTEMPT_PRODUCT_STAGE_REQUIRED')
    for (const [fieldName, errorName] of REAL_ATTEMPT_REQUIRED_FIELDS) {
      const value = parsed[fieldName]
      if (value === undefined || value === '') throw new Error(errorName)
    }
  } else if (parsed.confirmRealAttempt || parsed.requirement !== undefined) {
    throw new Error('REAL_ATTEMPT_OPT_IN_REQUIRED')
  }
  return parsed
}

export function createOpportunityLedger({ total = 10, priorConsumed = 1, currentCalls = 0 } = {}) {
  for (const value of [total, priorConsumed, currentCalls]) {
    if (!Number.isInteger(value) || value < 0) throw new Error('OPPORTUNITY_ACCOUNTING_INVALID')
  }
  if (priorConsumed + currentCalls > total) throw new Error('OPPORTUNITY_ACCOUNTING_OVERDRAWN')
  return {
    total,
    priorConsumed,
    currentCalls,
    remaining: total - priorConsumed - currentCalls,
  }
}

/** Pure transition used only to validate the durable reservation state machine. */
export function transitionProviderOpportunity(ledger, { channel = 'provider-prompt' } = {}) {
  if (channel === 'slash') throw new Error('SLASH_HAS_NO_PROVIDER_OPPORTUNITY')
  if (ledger.currentCalls !== 0) throw new Error('EXTRA_PROVIDER_ATTEMPT')
  if (ledger.remaining <= 0) throw new Error('PROVIDER_OPPORTUNITY_EXHAUSTED')
  return {
    ...ledger,
    currentCalls: 1,
    remaining: ledger.remaining - 1,
    reservation: 'first-non-slash-prompt-only',
  }
}

function opportunityLedgerPath(layout) {
  const path = join(layout.boundedEvidence, OPPORTUNITY_LEDGER_FILE)
  return assertWithinRoot(layout.boundedEvidence, path, 'opportunity_ledger')
}

function durableLedgerDocument(ledger) {
  return {
    version: 1,
    state: ledger.currentCalls === 0 ? 'AVAILABLE' : 'RESERVED',
    ...ledger,
  }
}

function parseDurableOpportunityLedger(value) {
  if (!isRecord(value) || value.version !== 1) throw new Error('OPPORTUNITY_LEDGER_INVALID')
  const ledger = createOpportunityLedger(value)
  if (value.state !== (ledger.currentCalls === 0 ? 'AVAILABLE' : 'RESERVED')) {
    throw new Error('OPPORTUNITY_LEDGER_STATE_MISMATCH')
  }
  return ledger
}

/** Create the runner-owned durable ledger exactly once inside bounded evidence. */
export async function initializeOpportunityLedger(layout) {
  const path = opportunityLedgerPath(layout)
  const ledger = createOpportunityLedger()
  try {
    await writeFile(path, `${JSON.stringify(durableLedgerDocument(ledger))}\n`, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (isRecord(error) && error.code === 'EEXIST') throw new Error('OPPORTUNITY_LEDGER_ALREADY_EXISTS')
    throw error
  }
  return { path, pathLabel: `bounded-evidence/${OPPORTUNITY_LEDGER_FILE}`, ledger }
}

export async function readOpportunityLedger(ledgerPath) {
  const document = JSON.parse(await readFile(ledgerPath, 'utf8'))
  return parseDurableOpportunityLedger(document)
}

/**
 * The only persistent reservation point for a possible model prompt.  The
 * lock is fail-closed: an existing lock, a consumed ledger, a callback error,
 * retry, or fallback never creates another attempt or restores the token.
 */
export async function reserveProviderOpportunityAtomically({
  ledgerPath,
  boundedEvidenceRoot,
  channel = 'provider-prompt',
  enqueue,
} = {}) {
  if (channel === 'slash') throw new Error('SLASH_HAS_NO_PROVIDER_OPPORTUNITY')
  if (typeof enqueue !== 'function') throw new Error('MODEL_PROMPT_WRAPPER_REQUIRED')
  const path = resolve(nonEmptyText(ledgerPath, 'ledger_path', { maxLength: 1000 }))
  const root = resolve(nonEmptyText(boundedEvidenceRoot, 'bounded_evidence_root', { maxLength: 1000 }))
  assertWithinRoot(root, path, 'opportunity_ledger')
  const lockPath = `${path}.lock`
  assertWithinRoot(root, lockPath, 'opportunity_ledger_lock')
  try {
    await writeFile(lockPath, '{"purpose":"provider-opportunity-reservation"}\n', { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (isRecord(error) && error.code === 'EEXIST') throw new Error('OPPORTUNITY_RESERVATION_LOCKED')
    throw error
  }

  const tempPath = `${path}.tmp`
  try {
    const ledger = await readOpportunityLedger(path)
    const reserved = transitionProviderOpportunity(ledger, { channel })
    await writeFile(tempPath, `${JSON.stringify(durableLedgerDocument(reserved))}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(tempPath, path)
    try {
      await enqueue({ reservation: 'first-non-slash-prompt-only' })
    } catch {
      throw new Error('PROVIDER_ENQUEUE_FAILED_NO_RETRY')
    }
    return reserved
  } finally {
    try { await rm(tempPath, { force: true }) } catch { /* bounded temp cleanup */ }
    try { await rm(lockPath, { force: false }) } catch { /* lock cleanup is best effort */ }
  }
}

/** REAL first-potential-model-prompt wrapper; never invoked by this construction session. */
export async function enqueueFirstPotentialModelPrompt({ layout, channel = 'provider-prompt', enqueue } = {}) {
  if (!isRecord(layout)) throw new Error('RUNNER_LAYOUT_REQUIRED')
  const path = opportunityLedgerPath(layout)
  return reserveProviderOpportunityAtomically({
    ledgerPath: path,
    boundedEvidenceRoot: layout.boundedEvidence,
    channel,
    enqueue,
  })
}

export function robocopyArgs(source, target, fileName) {
  const args = [source, target]
  if (fileName !== undefined) args.push(fileName)
  args.push('/E', '/XJ')
  if (fileName !== undefined) args.push('/LEV:1')
  args.push('/NFL', '/NDL', '/NJH', '/NJS', '/NP')
  return args
}

export function robocopyExitAccepted(exitCode) {
  return Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= ROBOCOPY_SUCCESS_MAX
}

async function defaultRobocopyRunner(command, args, options) {
  try {
    const result = await execFile(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    })
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    return {
      exitCode: asExitCode(isRecord(error) ? error.code : 1),
      stdout: '',
      stderr: '',
    }
  }
}

export async function runRobocopy(source, target, fileName, {
  runner = defaultRobocopyRunner,
  env,
} = {}) {
  const command = process.platform === 'win32' ? 'robocopy.exe' : 'robocopy'
  const args = robocopyArgs(source, target, fileName)
  const result = await runner(command, args, { env })
  const exitCode = asExitCode(result?.exitCode)
  if (!robocopyExitAccepted(exitCode)) throw new Error(`ROBOCOPY_FAILED_${exitCode}`)
  return { command, args, exitCode }
}

export async function copyProductAllowlist({ productRoot, productStage, env, robocopyRunner } = {}) {
  const sourceRoot = resolve(nonEmptyText(productRoot, 'product_root', { maxLength: 1000 }))
  const targetRoot = resolve(nonEmptyText(productStage, 'product_stage', { maxLength: 1000 }))
  if (!(await pathExists(sourceRoot))) throw new Error('PRODUCT_ROOT_MISSING')
  if (!isWithinRoot(targetRoot, targetRoot)) throw new Error('PRODUCT_STAGE_INVALID')

  const copied = []
  for (const entry of ['src', 'tests']) {
    const source = join(sourceRoot, entry)
    if (!(await pathExists(source))) throw new Error(`ALLOWLIST_SOURCE_MISSING_${entry.toUpperCase()}`)
    await runRobocopy(source, join(targetRoot, entry), undefined, { runner: robocopyRunner, env })
    copied.push(entry)
  }
  for (const entry of PRODUCT_ALLOWLIST.filter(value => !['src', 'tests'].includes(value))) {
    const source = join(sourceRoot, entry)
    if (!(await pathExists(source))) throw new Error(`ALLOWLIST_SOURCE_MISSING_${entry.replaceAll('.', '_').toUpperCase()}`)
    await runRobocopy(sourceRoot, targetRoot, entry, { runner: robocopyRunner, env })
    copied.push(entry)
  }
  return { copied, robocopyExitCodes: '0..7 accepted', excluded: ['.git', 'node_modules', 'lib', 'evidence'] }
}

export async function verifyNodeModulesJunction(junctionPath, targetPath) {
  const junction = resolve(junctionPath)
  const target = resolve(targetPath)
  const linkStat = await lstat(junction)
  if (!linkStat.isSymbolicLink()) throw new Error('NODE_MODULES_LINK_NOT_JUNCTION')
  const resolvedLink = resolve(await realpath(junction))
  const resolvedTarget = resolve(await realpath(target))
  if (pathForComparison(resolvedLink) !== pathForComparison(resolvedTarget)) {
    throw new Error('NODE_MODULES_JUNCTION_TARGET_MISMATCH')
  }
  return { junction, target: resolvedTarget, verified: true }
}

export async function createNodeModulesJunction({ productStage, productRoot } = {}) {
  const stage = resolve(nonEmptyText(productStage, 'product_stage', { maxLength: 1000 }))
  const target = resolve(join(nonEmptyText(productRoot, 'product_root', { maxLength: 1000 }), 'node_modules'))
  const junction = join(stage, 'node_modules')
  assertWithinRoot(stage, junction, 'node_modules_junction')
  if (!(await pathExists(target))) throw new Error('NODE_MODULES_TARGET_MISSING')
  if (await pathExists(junction)) throw new Error('NODE_MODULES_JUNCTION_ALREADY_EXISTS')
  await symlink(target, junction, 'junction')
  return verifyNodeModulesJunction(junction, target)
}

export async function removeNodeModulesJunction({ productStage, productRoot } = {}) {
  const stage = resolve(nonEmptyText(productStage, 'product_stage', { maxLength: 1000 }))
  const product = resolve(nonEmptyText(productRoot, 'product_root', { maxLength: 1000 }))
  const junction = join(stage, 'node_modules')
  const target = join(product, 'node_modules')
  await verifyNodeModulesJunction(junction, target)
  await rm(junction, { recursive: false, force: false })
  if (await pathExists(junction)) throw new Error('NODE_MODULES_JUNCTION_NOT_REMOVED')
  if (!(await pathExists(target))) throw new Error('NODE_MODULES_TARGET_CHANGED')
  return { removed: true, targetPreserved: true }
}

async function defaultCommandRunner(command, args, options) {
  try {
    const result = await execFile(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      maxBuffer: 24 * 1024 * 1024,
    })
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    return {
      exitCode: asExitCode(isRecord(error) ? error.code : 1),
      stdout: '',
      stderr: '',
    }
  }
}

/** Copy -> junction -> npm test -> remove junction -> fresh-artifact npm pack. */
export async function stageAndPackProduct({
  productRoot,
  layout,
  commandRunner = defaultCommandRunner,
  robocopyRunner,
} = {}) {
  const env = buildRunnerEnvironment(layout)
  const trace = []
  const copy = await copyProductAllowlist({
    productRoot,
    productStage: layout.productStage,
    env,
    robocopyRunner,
  })
  trace.push('allowlist-copied')
  await createNodeModulesJunction({ productStage: layout.productStage, productRoot })
  trace.push('single-node_modules-junction-created-and-verified')

  let testResult
  let testFailure
  try {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    testResult = await commandRunner(npmCommand, ['test'], {
      cwd: layout.productStage,
      env,
    })
    if (asExitCode(testResult?.exitCode) !== 0) testFailure = new Error(`ISOLATED_NPM_TEST_FAILED_${asExitCode(testResult?.exitCode)}`)
  } finally {
    await removeNodeModulesJunction({ productStage: layout.productStage, productRoot })
    trace.push('junction-removed-and-target-reverified')
  }
  if (testFailure !== undefined) throw testFailure

  assertWithinRoot(layout.root, layout.artifacts, 'artifacts')
  if (!(await pathExists(layout.artifacts)) || !(await directoryIsFresh(layout.artifacts))) {
    throw new Error('ARTIFACTS_ROOT_NOT_FRESH')
  }
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const packResult = await commandRunner(npmCommand, ['pack', '--pack-destination', layout.artifacts], {
    cwd: layout.productStage,
    env,
  })
  if (asExitCode(packResult?.exitCode) !== 0) throw new Error(`ISOLATED_NPM_PACK_FAILED_${asExitCode(packResult?.exitCode)}`)
  const artifactNames = (await readdir(layout.artifacts)).filter(name => name.endsWith('.tgz')).sort()
  if (artifactNames.length !== 1) throw new Error(`PACK_ARTIFACT_COUNT_INVALID_${artifactNames.length}`)
  const artifactPath = assertWithinRoot(layout.artifacts, join(layout.artifacts, artifactNames[0]), 'pack_artifact')
  if (!(await lstat(artifactPath)).isFile()) throw new Error('PACK_ARTIFACT_NOT_REGULAR_FILE')
  trace.push('npm-pack-after-junction-removal')
  return {
    status: 'READY',
    copy,
    testExitCode: asExitCode(testResult?.exitCode),
    packExitCode: asExitCode(packResult?.exitCode),
    artifactCount: artifactNames.length,
    artifactNames,
    trace,
  }
}

export async function inspectDshPreflight({
  dshRoot = DSH_ROOT_DEFAULT,
  wrapperPath = DSH_WRAPPER_DEFAULT,
  nodeVersion = process.version,
  layout,
} = {}) {
  const root = resolve(nonEmptyText(dshRoot, 'dsh_root', { maxLength: 1000 }))
  const wrapper = resolve(nonEmptyText(wrapperPath, 'wrapper_path', { maxLength: 1000 }))
  const failures = []
  const checks = {
    dshRoot: false,
    wrapper: false,
    node: nodeVersionAtLeast(nodeVersion),
    packageManager: false,
    privatePaths: false,
  }

  try {
    checks.dshRoot = (await stat(root)).isDirectory()
  } catch {
    failures.push('DSH_ROOT_MISSING')
  }
  try {
    const wrapperText = await readFile(wrapper, 'utf8')
    const wrapperReferencesHarness = /deepseek-harness/iu.test(wrapperText)
    const wrapperReferencesCliEntrypoint = /apps[\\/]cli[\\/]src[\\/]bin\.ts/iu.test(wrapperText)
    checks.wrapper = wrapperReferencesHarness && wrapperReferencesCliEntrypoint
    if (!checks.wrapper) failures.push('WRAPPER_TARGET_UNVERIFIED')
  } catch {
    failures.push('WRAPPER_MISSING')
  }
  if (!checks.node) failures.push('NODE_VERSION_TOO_OLD')

  try {
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    checks.packageManager = packageJson.packageManager === 'pnpm@11.7.0'
    if (!checks.packageManager) failures.push('PNPM_VERSION_UNVERIFIED')
  } catch {
    failures.push('DSH_PACKAGE_METADATA_UNREADABLE')
  }

  if (layout !== undefined) {
    const privatePaths = [layout.dshHome, layout.pnpmStore, layout.privateRuntime]
    checks.privatePaths = privatePaths.every(path => isWithinRoot(layout.root, path))
    if (!checks.privatePaths) failures.push('PRIVATE_RUNTIME_OUTSIDE_TEMP_ROOT')
  } else {
    failures.push('PRIVATE_RUNTIME_LAYOUT_NOT_PROVIDED')
  }

  return {
    ok: failures.length === 0,
    failures,
    checks,
    nodeVersion: String(nodeVersion).replace(/^v/u, 'v'),
    packageManager: checks.packageManager ? 'pnpm@11.7.0' : 'UNVERIFIED',
    noDshProcessStarted: true,
    noProviderCall: true,
  }
}

/**
 * Resolve an explicitly requested provider/model pair only through a public
 * Host/adapter surface.  The JSON-RPC SDK protocol does not expose this
 * catalog, so the live CLI must fail closed unless its composition supplies
 * one.  This helper retains only the verified pair and a source label; it
 * never copies the surface response or any credential-bearing field.
 */
export async function resolvePublicConfiguredRoute({
  publicRouteSurface,
  providerAlias,
  model,
} = {}) {
  const explicitProviderAlias = nonEmptyText(providerAlias, 'provider_alias')
  const explicitModel = nonEmptyText(model, 'model')
  const surface = isRecord(publicRouteSurface) ? publicRouteSurface : undefined
  const llm = isRecord(surface?.llm) ? surface.llm : surface
  if (!isRecord(llm)) return { verified: false, reason: 'PUBLIC_ROUTE_SURFACE_REQUIRED' }

  try {
    if (typeof llm.listProviders === 'function' && typeof llm.listModels === 'function') {
      const providers = await llm.listProviders()
      if (!Array.isArray(providers) || !providers.some(entry => isRecord(entry) && entry.id === explicitProviderAlias)) {
        return { verified: false, reason: 'PUBLIC_PROVIDER_ROUTE_NOT_LISTED' }
      }
      const models = await llm.listModels(explicitProviderAlias)
      if (!Array.isArray(models) || !models.some(entry => isRecord(entry) && entry.id === explicitModel)) {
        return { verified: false, reason: 'PUBLIC_MODEL_ROUTE_NOT_LISTED' }
      }
      const evidence = {
        verified: true,
        source: 'public-llm-listProviders-listModels',
        providerAlias: explicitProviderAlias,
        model: explicitModel,
        routeConfigured: true,
        routeAuthAvailability: 'UNKNOWN',
      }
      return evidence
    }

    if (typeof llm.models === 'function') {
      const response = await llm.models({})
      const value = response?.result?.ok === true
        ? response.result.value
        : response?.value ?? response
      const groups = isRecord(value) && Array.isArray(value.groups) ? value.groups : undefined
      const providerGroup = groups?.find(group => isRecord(group) && group.id === explicitProviderAlias)
      if (!providerGroup) return { verified: false, reason: 'PUBLIC_PROVIDER_ROUTE_NOT_LISTED' }
      const listedModels = Array.isArray(providerGroup.models) ? providerGroup.models : []
      if (!listedModels.some(entry => isRecord(entry) && entry.id === explicitModel)) {
        return { verified: false, reason: 'PUBLIC_MODEL_ROUTE_NOT_LISTED' }
      }
      const evidence = {
        verified: true,
        source: 'public-host-llm-models',
        providerAlias: explicitProviderAlias,
        model: explicitModel,
        routeConfigured: true,
        routeAuthAvailability: 'UNKNOWN',
      }
      return evidence
    }
  } catch {
    return { verified: false, reason: 'PUBLIC_ROUTE_SURFACE_QUERY_FAILED' }
  }
  return { verified: false, reason: 'PUBLIC_ROUTE_SURFACE_UNAVAILABLE' }
}

function isBoundedRouteEvidence(value, providerAlias, model) {
  return isRecord(value)
    && value.verified === true
    && value.providerAlias === providerAlias
    && value.model === model
}

function isTurnNumber(value) {
  return Number.isSafeInteger(value) && value >= 0
}

/**
 * Normalize only the public DSH notification fields needed by the runner.
 * The returned frames never contain content, assistant text, or the input
 * notification itself.  Kingdom task/attempt/dispatch values are deliberately
 * absent: they come from the runner-owned external correlation context.
 */
function normalizeSessionNotification(notification) {
  const params = isRecord(notification?.params) ? notification.params : undefined
  if (!isRecord(params) || typeof params.sessionId !== 'string' || params.sessionId.trim() === '') {
    return { kind: 'invalid', reason: 'SESSION_EVENT_SESSION_ID_MISSING' }
  }
  const sessionId = params.sessionId.trim()

  if (notification.method === 'session.status') {
    if (params.status !== 'idle' && params.status !== 'running') {
      return { kind: 'invalid', sessionId, reason: 'SESSION_STATUS_INVALID' }
    }
    return { kind: 'status', sessionId, status: params.status }
  }
  if (notification.method !== 'session.event') return { kind: 'other' }

  const event = params.event
  if (!isRecord(event) || typeof event.type !== 'string' || event.type.trim() === '') {
    return { kind: 'invalid', sessionId, reason: 'SESSION_EVENT_ENVELOPE_INVALID' }
  }
  if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
    return { kind: 'invalid', sessionId, reason: 'SESSION_EVENT_SEQ_MISSING' }
  }
  if (!isRecord(event.data)) {
    return { kind: 'invalid', sessionId, reason: 'SESSION_EVENT_DATA_MISSING' }
  }

  const type = event.type.trim()
  const data = event.data
  const base = { sessionId, eventSeq: event.seq, type }
  const frameWith = fields => ({ ...base, ...fields })

  if (type === 'turn/start' || type === 'turn/end') {
    if (!isTurnNumber(data.turn)) return { kind: 'invalid', sessionId, reason: 'SESSION_EVENT_TURN_MISSING' }
    if (type === 'turn/start') return { kind: 'event', frames: [frameWith({ turn: data.turn })] }
    const reasonKind = isRecord(data.reason) && typeof data.reason.kind === 'string'
      ? data.reason.kind
      : undefined
    if (reasonKind === undefined) return { kind: 'invalid', sessionId, reason: 'SESSION_EVENT_REASON_KIND_MISSING' }
    return { kind: 'event', frames: [frameWith({ turn: data.turn, reasonKind })] }
  }

  if (type === 'user/message') {
    if (typeof data.id !== 'string' || data.id.trim() === '') {
      return { kind: 'invalid', sessionId, reason: 'USER_MESSAGE_ID_MISSING' }
    }
    const sourceKind = isRecord(data.source) && typeof data.source.kind === 'string'
      ? data.source.kind
      : undefined
    if (sourceKind === undefined) return { kind: 'invalid', sessionId, reason: 'USER_MESSAGE_SOURCE_MISSING' }
    return { kind: 'event', frames: [frameWith({ messageId: data.id.trim(), sourceKind })] }
  }

  if (type === 'assistant/message') {
    if (!isTurnNumber(data.turn)) return { kind: 'invalid', sessionId, reason: 'ASSISTANT_MESSAGE_TURN_MISSING' }
    const message = data.message
    const source = isRecord(message) && isRecord(message.source) ? message.source : undefined
    const effectiveProvider = typeof source?.provider === 'string' && source.provider.trim() !== ''
      ? source.provider.trim()
      : undefined
    const effectiveModel = typeof source?.model === 'string' && source.model.trim() !== ''
      ? source.model.trim()
      : undefined
    return {
      kind: 'event',
      frames: [frameWith({
        turn: data.turn,
        assistantPresent: isRecord(message),
        ...(effectiveProvider === undefined || effectiveModel === undefined
          ? {}
          : { effectiveProvider, effectiveModel }),
      })],
    }
  }

  if (type === 'agent/inbox/spliced') {
    if (!Array.isArray(data.inserted) || data.inserted.length > 32) {
      return { kind: 'invalid', sessionId, reason: 'INBOX_RECEIPT_INSERTED_INVALID' }
    }
    if (data.inserted.length === 0) return { kind: 'event', frames: [frameWith({})] }
    const frames = []
    for (const message of data.inserted) {
      if (!isRecord(message) || typeof message.id !== 'string' || message.id.trim() === '') {
        return { kind: 'invalid', sessionId, reason: 'INBOX_RECEIPT_MESSAGE_ID_MISSING' }
      }
      const sourceKind = isRecord(message.source) && typeof message.source.kind === 'string'
        ? message.source.kind
        : undefined
      if (sourceKind === undefined) return { kind: 'invalid', sessionId, reason: 'INBOX_RECEIPT_SOURCE_MISSING' }
      frames.push(frameWith({ messageId: message.id.trim(), sourceKind }))
    }
    return { kind: 'event', frames }
  }

  // Other public event types are still reduced to their type/sequence only.
  // The runner does not need their data and therefore never retains it.
  return { kind: 'event', frames: [frameWith({})] }
}

function normalizeEventCorrelation({
  runnerContext,
  userMessageId,
  requestedProviderAlias,
  requestedModel,
  turnId,
  allowUnboundUserMessage = false,
} = {}) {
  const context = simulationContextRecord(runnerContext)
  if (turnId !== undefined) throw new Error('TURN_CORRELATION_MUST_BE_OBSERVER_DERIVED')
  if (userMessageId === undefined && !allowUnboundUserMessage) throw new Error('USER_MESSAGE_ID_REQUIRED')
  if (userMessageId !== undefined && (typeof userMessageId !== 'string' || userMessageId.trim() === '')) {
    throw new Error('USER_MESSAGE_ID_INVALID')
  }
  const normalizedMessageId = userMessageId === undefined ? undefined : userMessageId.trim()
  const normalizedDispatchRef = normalizedMessageId
  const normalizedRequestedProviderAlias = requestedProviderAlias === undefined
    ? undefined
    : nonEmptyText(requestedProviderAlias, 'requested_provider_alias')
  const normalizedRequestedModel = requestedModel === undefined
    ? undefined
    : nonEmptyText(requestedModel, 'requested_model')
  return {
    sessionId: context.sessionId,
    userMessageId: normalizedMessageId,
    taskId: context.taskId,
    attemptNo: context.attemptNo,
    runtimeDispatchRef: normalizedDispatchRef,
    kingdomDispatchId: context.kingdomDispatchId,
    requestedProviderAlias: normalizedRequestedProviderAlias,
    requestedModel: normalizedRequestedModel,
  }
}

/** The only runtime dispatch reference admitted by the internal SDK seam. */
function bindRuntimeDispatchRefToMessageId({ runnerContext, messageId, requestedProviderAlias, requestedModel } = {}) {
  return normalizeEventCorrelation({
    runnerContext,
    userMessageId: messageId,
    requestedProviderAlias,
    requestedModel,
  })
}

export function maskSessionRef(value) {
  if (typeof value !== 'string' || value.length === 0) return '[masked:unknown]'
  if (value.length <= 4) return '[masked]'
  return `[masked:${value.slice(0, 2)}…${value.slice(-4)}]`
}

export function buildSessionEventFilter({ sessionId } = {}) {
  return notification => {
    if (!isRecord(notification)
      || (notification.method !== 'session.event' && notification.method !== 'session.status')) return false
    if (sessionId === undefined) return true
    return isRecord(notification.params) && notification.params.sessionId === sessionId
  }
}

/** Bounded observer: it retains counts/correlation only, never event text or notification frames. */
function createBoundedSessionEventObserver({
  runnerContext,
  requestedProviderAlias,
  requestedModel,
} = {}) {
  let expected = normalizeEventCorrelation({
    runnerContext,
    requestedProviderAlias,
    requestedModel,
    allowUnboundUserMessage: true,
  })
  const state = {
    maskedSessionRef: maskSessionRef(expected.sessionId),
    observedEventCount: 0,
    ignoredEventCount: 0,
    matchingUserCount: 0,
    foreignUserCount: 0,
    foreignSessionCount: 0,
    turnStartCount: 0,
    turnEndCount: 0,
    completedTurnCount: 0,
    assistantMessageCount: 0,
    correlationMismatches: 0,
    effectiveRouteMismatches: 0,
    missingCorrelationCount: 0,
    missingEventFieldCount: 0,
    exactCorrelationEventCount: 0,
    taskCorrelation: 'module-runner-context',
    attemptCorrelation: expected.attemptNo,
    dispatchCorrelation: maskSessionRef(expected.runtimeDispatchRef),
    kingdomDispatchCorrelation: maskSessionRef(expected.kingdomDispatchId),
    targetReceiptCount: 0,
    targetUserMessageCount: 0,
    targetTurnStartCount: 0,
    targetTurnEndCount: 0,
    targetTurn: undefined,
    currentTurn: undefined,
    targetUserAwaitingTurn: false,
    activityStarted: false,
    targetTurnEnded: false,
    rootSessionIdleObserved: false,
    idleBeforeTerminalCount: 0,
    preTargetEventCount: 0,
    outOfBoundsEventCount: 0,
    multipleTargetTurnCount: 0,
    invalidNotificationCount: 0,
    pendingFrameCount: 0,
    effectiveProvider: undefined,
    effectiveModel: undefined,
    effectiveRouteObservationCount: 0,
    missingEffectiveRouteCount: 0,
    outOfOrderEventCount: 0,
    eventSeqGapCount: 0,
    eventSeqDuplicateCount: 0,
    eventSeqDecreaseCount: 0,
    eventSeqViolationCount: 0,
    eventSeqViolationReason: undefined,
    invalid: false,
  }
  const pending = []
  const receiptWaiters = []
  const idleWaiters = []
  // The first accepted event establishes the stream baseline.  Every later
  // notification envelope must advance that baseline by exactly one.  A
  // single envelope may normalize to multiple frames, but all frames retain
  // the envelope's one event.seq and therefore do not advance this cursor.
  let lastEventSeq

  const invalidate = () => {
    state.invalid = true
    state.correlationMismatches += 1
  }

  const failure = ({ missing = 0, preTarget = false, outOfBounds = false, multipleTurn = false, irreversible = false } = {}) => {
    state.correlationMismatches += 1
    state.missingCorrelationCount += missing
    if (missing > 0) state.missingEventFieldCount += missing
    if (preTarget) state.preTargetEventCount += 1
    if (outOfBounds) state.outOfBoundsEventCount += 1
    if (multipleTurn) state.multipleTargetTurnCount += 1
    if (irreversible) invalidate()
  }

  const resolveWaiters = (waiters) => {
    while (waiters.length > 0) waiters.shift()?.resolve(true)
  }

  const processStatus = (normalized) => {
    if (state.invalid) return false
    if (normalized.sessionId !== expected.sessionId) {
      state.foreignSessionCount += 1
      return false
    }
    if (normalized.status !== 'idle') return true
    if (!state.activityStarted) {
      failure({ preTarget: true, irreversible: true })
      return false
    }
    if (state.rootSessionIdleObserved) {
      failure({ outOfBounds: true, irreversible: true })
      return false
    }
    if (!state.targetTurnEnded || state.completedTurnCount !== 1 || state.assistantMessageCount < 1) {
      state.idleBeforeTerminalCount += 1
      failure({ irreversible: true })
      return false
    }
    state.rootSessionIdleObserved = true
    resolveWaiters(idleWaiters)
    return true
  }

  const processFrame = (frame) => {
    if (state.invalid) return false
    if (frame.sessionId !== expected.sessionId) {
      state.foreignSessionCount += 1
      if (frame.sourceKind === 'user') state.foreignUserCount += 1
      return false
    }
    state.observedEventCount += 1
    const directUser = frame.sourceKind === 'user'

    if (!state.activityStarted) {
      if (frame.type === 'agent/inbox/spliced' && frame.messageId === expected.userMessageId && directUser) {
        state.targetReceiptCount += 1
        state.activityStarted = true
        if (state.targetReceiptCount !== 1) failure({ multipleTurn: true, irreversible: true })
        resolveWaiters(receiptWaiters)
        return true
      }
      if (directUser || ['turn/start', 'turn/end', 'assistant/message'].includes(frame.type)) {
        if (directUser) state.foreignUserCount += 1
        failure({ preTarget: true, irreversible: true })
      }
      return false
    }

    if (state.targetTurnEnded) {
      if (directUser) state.foreignUserCount += 1
      failure({ outOfBounds: true, irreversible: true })
      return false
    }

    if (frame.type === 'agent/inbox/spliced') {
      if (frame.messageId === expected.userMessageId && directUser) {
        state.targetReceiptCount += 1
        failure({ multipleTurn: true, irreversible: true })
      } else if (frame.messageId === expected.userMessageId) {
        // The target receipt itself must be direct.  A non-direct frame with
        // the same id is ignored as bounded parser input and is not
        // foreign-user evidence; post-end frames are rejected above.
      } else if (directUser) {
        state.foreignUserCount += 1
        failure()
      }
      return frame.messageId === expected.userMessageId && directUser
    }

    if (frame.type === 'turn/start') {
      if (!isTurnNumber(frame.turn)) {
        failure({ missing: 1, irreversible: true })
        return false
      }
      state.currentTurn = frame.turn
      state.turnStartCount += 1
      if (state.targetTurn === undefined) {
        state.targetTurn = frame.turn
        state.targetTurnStartCount += 1
        if (state.targetUserAwaitingTurn) {
          failure({ preTarget: true, irreversible: true })
          state.targetUserAwaitingTurn = false
        }
      } else if (frame.turn !== state.targetTurn) {
        failure({ outOfBounds: true, multipleTurn: true, irreversible: true })
      } else {
        state.targetTurnStartCount += 1
        failure({ multipleTurn: true, irreversible: true })
      }
      return true
    }

    if (frame.type === 'user/message') {
      if (frame.messageId === expected.userMessageId && directUser) {
        state.targetUserMessageCount += 1
        state.matchingUserCount += 1
        if (state.targetUserMessageCount !== 1) failure({ multipleTurn: true, irreversible: true })
        if (state.targetTurn === undefined) {
          state.targetUserAwaitingTurn = true
          failure({ preTarget: true, irreversible: true })
        }
        return true
      }
      if (!directUser) return true
      state.foreignUserCount += 1
      failure()
      return false
    }

    if (frame.type === 'turn/end') {
      if (!isTurnNumber(frame.turn) || typeof frame.reasonKind !== 'string') {
        failure({ missing: 1, irreversible: true })
        return false
      }
      if (state.targetTurn === undefined) {
        failure({ missing: 1, irreversible: true })
        return false
      }
      if (frame.turn !== state.targetTurn) {
        failure({ outOfBounds: true, multipleTurn: true, irreversible: true })
        return false
      }
      if (state.targetUserMessageCount !== 1 || state.assistantMessageCount < 1) {
        failure({ outOfBounds: true, irreversible: true })
        return false
      }
      state.targetTurnEndCount += 1
      state.turnEndCount += 1
      if (state.targetTurnEndCount !== 1) failure({ multipleTurn: true, irreversible: true })
      if (frame.reasonKind === 'completed') state.completedTurnCount += 1
      state.targetTurnEnded = true
      return true
    }

    if (frame.type === 'assistant/message') {
      if (!isTurnNumber(frame.turn) || frame.assistantPresent !== true) {
        failure({ missing: 1, irreversible: true })
        return false
      }
      if (state.targetTurn === undefined || frame.turn !== state.targetTurn) {
        failure({ outOfBounds: true, irreversible: true })
        return false
      }
      if (state.targetUserMessageCount !== 1) {
        failure({ outOfBounds: true, irreversible: true })
        return false
      }
      state.assistantMessageCount += 1
      if (typeof frame.effectiveProvider === 'string' && typeof frame.effectiveModel === 'string') {
        if (state.effectiveProvider === undefined && state.effectiveModel === undefined) {
          state.effectiveProvider = frame.effectiveProvider
          state.effectiveModel = frame.effectiveModel
        } else if (state.effectiveProvider !== frame.effectiveProvider || state.effectiveModel !== frame.effectiveModel) {
          state.effectiveRouteMismatches += 1
          failure({ outOfBounds: true })
        }
        state.effectiveRouteObservationCount += 1
        if ((expected.requestedProviderAlias !== undefined && frame.effectiveProvider !== expected.requestedProviderAlias)
          || (expected.requestedModel !== undefined && frame.effectiveModel !== expected.requestedModel)) {
          state.effectiveRouteMismatches += 1
          failure({ outOfBounds: true })
        }
      } else {
        state.missingEffectiveRouteCount += 1
      }
      return true
    }

    return true
  }

  const dispatchNormalized = normalized => {
    if (normalized.kind === 'invalid') {
      state.invalidNotificationCount += 1
      failure({ missing: 1, irreversible: true })
      return false
    }
    if (normalized.kind === 'other') return false
    const normalizedSessionId = normalized.sessionId ?? normalized.frames?.[0]?.sessionId
    if (expected.userMessageId === undefined && normalizedSessionId === expected.sessionId) {
      if (pending.length >= 128) {
        state.pendingFrameCount += 1
        failure({ outOfBounds: true, irreversible: true })
        return false
      }
      if (normalized.kind === 'event') {
        for (const frame of normalized.frames) pending.push({ kind: 'event', sessionId: frame.sessionId, frames: [frame] })
      } else {
        pending.push(normalized)
      }
      state.pendingFrameCount = pending.length
      return true
    }
    if (normalized.kind === 'status') return processStatus(normalized)
    let accepted = true
    for (const frame of normalized.frames) accepted = processFrame(frame) && accepted
    return accepted
  }

  const filter = buildSessionEventFilter({ sessionId: expected.sessionId })

  const snapshot = () => {
    const { currentTurn, pendingFrameCount, ...bounded } = state
    return { ...bounded, currentTurn: currentTurn === undefined ? undefined : currentTurn, pendingFrameCount }
  }

  /** Exact values stay an internal gate input and are never written to evidence. */
  const correlationSnapshot = () => {
    const observedTurn = state.targetTurn === undefined ? undefined : String(state.targetTurn)
    const exact = !state.invalid
      && state.outOfOrderEventCount === 0
      && state.eventSeqViolationCount === 0
      && expected.userMessageId !== undefined
      && state.targetReceiptCount === 1
      && state.targetUserMessageCount === 1
      && state.targetTurnStartCount === 1
      && state.targetTurnEndCount === 1
      && state.completedTurnCount === 1
      && state.assistantMessageCount > 0
      && state.foreignUserCount === 0
      && state.foreignSessionCount === 0
      && state.preTargetEventCount === 0
      && state.outOfBoundsEventCount === 0
      && state.multipleTargetTurnCount === 0
      && state.effectiveRouteMismatches === 0
      && state.missingEffectiveRouteCount === 0
      && state.missingCorrelationCount === 0
      && state.correlationMismatches === 0
      && state.rootSessionIdleObserved
    return {
    expected: { ...expected },
      observed: observedTurn === undefined ? undefined : {
        sessionId: expected.sessionId,
        taskId: expected.taskId,
        attemptNo: expected.attemptNo,
        turnId: observedTurn,
        runtimeDispatchRef: expected.runtimeDispatchRef,
        kingdomDispatchId: expected.kingdomDispatchId,
        exact,
      },
      exact,
    }
  }

  const observer = {
    filter,
    observe(notification) {
      if (state.invalid) return false
      const normalized = normalizeSessionNotification(notification)
      if (normalized.kind === 'other') {
        state.ignoredEventCount += 1
        return false
      }
      if (normalized.kind === 'event') {
        const eventSeq = normalized.frames[0]?.eventSeq
        if (!Number.isSafeInteger(eventSeq) || eventSeq < 0) {
          state.outOfOrderEventCount += 1
          state.eventSeqViolationCount += 1
          state.eventSeqViolationReason = 'INVALID'
          failure({ irreversible: true })
          return false
        }
        if (lastEventSeq === undefined) {
          lastEventSeq = eventSeq
        } else {
          const expectedEventSeq = lastEventSeq + 1
          if (eventSeq !== expectedEventSeq) {
            state.outOfOrderEventCount += 1
            state.eventSeqViolationCount += 1
            if (eventSeq > lastEventSeq) {
              state.eventSeqGapCount += 1
              state.eventSeqViolationReason = 'GAP'
            } else if (eventSeq === lastEventSeq) {
              state.eventSeqDuplicateCount += 1
              state.eventSeqViolationReason = 'DUPLICATE'
            } else {
              state.eventSeqDecreaseCount += 1
              state.eventSeqViolationReason = 'DECREASE'
            }
            failure({ irreversible: true })
            return false
          }
          lastEventSeq = eventSeq
        }
      }
      const accepted = dispatchNormalized(normalized)
      if (accepted) state.exactCorrelationEventCount += 1
      else state.ignoredEventCount += 1
      return accepted
    },
    bindMessageId(messageId) {
      if (expected.userMessageId !== undefined) {
        if (expected.userMessageId !== messageId) throw new Error('USER_MESSAGE_ID_ALREADY_BOUND')
        return { ...expected }
      }
      expected = bindRuntimeDispatchRefToMessageId({
        runnerContext,
        messageId,
        requestedProviderAlias,
        requestedModel,
      })
      state.dispatchCorrelation = maskSessionRef(expected.runtimeDispatchRef)
      const replay = pending.splice(0)
      state.pendingFrameCount = 0
      for (const normalized of replay) dispatchNormalized(normalized)
      return { ...expected }
    },
    waitForReceipt({ timeoutMs = 10_000 } = {}) {
      if (state.invalid) return Promise.reject(new Error('OBSERVER_INVALID'))
      if (expected.userMessageId === undefined) return Promise.reject(new Error('USER_MESSAGE_ID_NOT_BOUND'))
      if (state.targetReceiptCount > 0) return Promise.resolve(true)
      return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new Error('PROMPT_RECEIPT_TIMEOUT')), timeoutMs)
        receiptWaiters.push({ resolve: value => { clearTimeout(timer); resolvePromise(value) }, reject: rejectPromise })
      })
    },
    waitForActivityEnd({ timeoutMs = 10_000 } = {}) {
      if (state.invalid) return Promise.reject(new Error('OBSERVER_INVALID'))
      if (state.rootSessionIdleObserved) return Promise.resolve(true)
      return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new Error('SESSION_IDLE_TIMEOUT')), timeoutMs)
        idleWaiters.push({ resolve: value => { clearTimeout(timer); resolvePromise(value) }, reject: rejectPromise })
      })
    },
    snapshot() {
      return snapshot()
    },
    correlationSnapshot,
  }

  return observer
}

/** Observer used by the keyless lifecycle only; it has no task/attempt target. */
function createKeylessSessionEventObserver() {
  const state = { boundedEventCount: 0, sessionStatusCount: 0, invalidEventCount: 0 }
  return {
    observe(notification) {
      const normalized = normalizeSessionNotification(notification)
      if (normalized.kind === 'event') state.boundedEventCount += normalized.frames.length
      else if (normalized.kind === 'status') state.sessionStatusCount += 1
      else if (normalized.kind === 'invalid') state.invalidEventCount += 1
      return normalized.kind !== 'invalid'
    },
    snapshot() { return { ...state } },
  }
}

/** Register the official SDK session.event subscription before any prompt seam is exposed. */
function subscribeOfficialSessionEvents(client, observer) {
  if (!isRecord(client) || typeof client.subscribe !== 'function' || !isRecord(observer)
    || typeof observer.observe !== 'function') throw new Error('SDK_SUBSCRIBE_UNAVAILABLE')
  // Returning false keeps the official SDK subscription queue empty.  The
  // filter synchronously reduces each notification to bounded fields before
  // dropping it, so no raw frame is retained by this runner.
  const boundedFilter = notification => {
    observer.observe(notification)
    return false
  }
  const subscription = client.subscribe(boundedFilter)
  return {
    subscription,
    observer,
    subscriptionEstablishedBeforePrompt: true,
    method: 'session.event',
  }
}

/**
 * Prepare the REAL low-level prompt seam.  It subscribes first, calls only
 * public HarnessClient.prompt, binds runtimeDispatchRef to the returned
 * messageId, then waits for the official inbox receipt.  The current runner
 * never invokes this helper; it exists solely as the one-attempt contract.
 */
function createPromptObservationPlan({
  client,
  runnerContext,
  requestedProviderAlias,
  requestedModel,
} = {}) {
  if (!isRecord(client) || typeof client.subscribe !== 'function' || typeof client.prompt !== 'function') {
    throw new Error('SDK_PROMPT_SURFACE_UNAVAILABLE')
  }
  const observer = createBoundedSessionEventObserver({
    runnerContext,
    requestedProviderAlias,
    requestedModel,
  })
  const registered = subscribeOfficialSessionEvents(client, observer)
  let promptInvoked = false
  return {
    observer,
    subscription: registered.subscription,
    subscriptionEstablishedBeforePrompt: registered.subscriptionEstablishedBeforePrompt,
    async prompt(contentBlocks) {
      if (promptInvoked) throw new Error('EXTRA_PROMPT_ATTEMPT')
      promptInvoked = true
      if (runnerProviderBoundaryCalls >= Number.MAX_SAFE_INTEGER) throw new Error('PROVIDER_BOUNDARY_COUNTER_OVERFLOW')
      runnerProviderBoundaryCalls += 1
      const result = await client.prompt(simulationContextRecord(runnerContext).sessionId, contentBlocks)
      const messageId = typeof result === 'string' ? result : result?.messageId
      if (typeof messageId !== 'string' || messageId.trim() === '') throw new Error('PROMPT_MESSAGE_ID_MISSING')
      const correlation = observer.bindMessageId(messageId)
      await observer.waitForReceipt()
      return { messageId: messageId.trim(), runtimeDispatchRef: messageId.trim(), correlation }
    },
  }
}

export function runKeylessCompositionProbe({
  client,
} = {}) {
  const observer = createKeylessSessionEventObserver()
  let subscriptionEstablished = false
  let subscription
  if (client !== undefined) {
    const registered = subscribeOfficialSessionEvents(client, observer)
    subscription = registered.subscription
    subscriptionEstablished = registered.subscriptionEstablishedBeforePrompt
  }

  const evidence = observer.snapshot()
  return {
    status: 'BLOCKED',
    mode: 'KEYLESS_COMPOSITION',
    reason: 'LIVE_COMPOSITION_REQUIRED',
    subscriptionEstablished,
    subscriptionMethod: 'session.event',
    workerDispatchObservation: 'NOT_RUN_BY_DESIGN',
    promptInvocations: 0,
    providerCalls: 0,
    evidence,
    subscription,
  }
}

const LIVE_DSH_PACKAGE_NODE_MODULES = [
  join('packages', 'examples', 'jsonrpc-demo', 'node_modules'),
  join('packages', 'examples', 'agent-spine-demo', 'node_modules'),
  join('packages', 'sdk', 'server', 'node_modules'),
  join('packages', 'boot', 'app-boot', 'node_modules'),
]

async function linkRuntimePackage(target, destination) {
  if (await pathExists(destination)) return false
  await mkdir(dirname(destination), { recursive: true })
  await symlink(target, destination, 'junction')
  return true
}

async function mergeRuntimeNodeModules(sourceNodeModules, destinationNodeModules) {
  if (!(await pathExists(sourceNodeModules))) return 0
  let linked = 0
  for (const entry of await readdir(sourceNodeModules)) {
    if (entry === '.bin') continue
    const source = join(sourceNodeModules, entry)
    const sourceInfo = await lstat(source)
    if (entry.startsWith('@') && sourceInfo.isDirectory()) {
      for (const scopedEntry of await readdir(source)) {
        if (await linkRuntimePackage(join(source, scopedEntry), join(destinationNodeModules, entry, scopedEntry))) linked += 1
      }
    } else if (await linkRuntimePackage(source, join(destinationNodeModules, entry))) {
      linked += 1
    }
  }
  return linked
}

async function createVerifiedDirectoryJunction(linkPath, targetPath) {
  const link = resolve(linkPath)
  const target = resolve(targetPath)
  if (await pathExists(link)) throw new Error('COMPOSITION_JUNCTION_ALREADY_EXISTS')
  if (!(await pathExists(target))) throw new Error('COMPOSITION_JUNCTION_TARGET_MISSING')
  await symlink(target, link, 'junction')
  return verifyNodeModulesJunction(link, target)
}

async function removeVerifiedDirectoryJunction(linkPath, targetPath) {
  const verified = await verifyNodeModulesJunction(linkPath, targetPath)
  await rm(verified.junction, { recursive: false, force: false })
  if (await pathExists(verified.junction)) throw new Error('COMPOSITION_JUNCTION_NOT_REMOVED')
  if (!(await pathExists(verified.target))) throw new Error('COMPOSITION_JUNCTION_TARGET_CHANGED')
  return { removed: true, targetPreserved: true }
}

function yamlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function liveCompositionConfig({ dshHome, productStage }) {
  const entries = buildProfileOverlayEntries()
  return [
    '- id: agent-spine',
    "  name: '@deepseek-ai/dsh-agent-spine-demo'",
    '  config:',
    `    dshHome: ${yamlQuote(dshHome)}`,
    '    workspaceContext: false',
    '    goals: false',
    '- id: commands',
    "  name: '@deepseek-ai/dsh-commands'",
    `- id: ${entries[0].id}`,
    `  name: ${yamlQuote(entries[0].name)}`,
    `- id: ${entries[1].id}`,
    `  name: ${yamlQuote('dsh-kingdom')}`,
    '  config:',
    '    authMode: session-bound',
    '    guiPort: 0',
    '    guiToken: \'\'',
    '    guiAllowOrigins: [\'*\']',
    '    migrateV4: false',
    `    kingdomName: ${yamlQuote('runner-keyless-composition')}`,
    `    ownerName: ${yamlQuote('runner')}`,
    '    workerProvider: spawn',
    `# product-stage target is ${yamlQuote(productStage)}; no source/lib path is emitted to evidence`,
    '',
  ].join('\n')
}

/** Build a temporary config consumer without npm install/update or profile reuse. */
export async function prepareLiveCompositionConsumer({ dshRoot, layout } = {}) {
  const consumer = join(layout.privateRuntime, 'sdk-composition-consumer')
  const nodeModules = join(consumer, 'node_modules')
  await mkdir(nodeModules, { recursive: true })
  let linkedCount = 0
  for (const relativeNodeModules of LIVE_DSH_PACKAGE_NODE_MODULES) {
    linkedCount += await mergeRuntimeNodeModules(join(dshRoot, relativeNodeModules), nodeModules)
  }

  const knownPackages = [
    [join(dshRoot, 'packages', 'sdk', 'server'), join(nodeModules, '@deepseek-ai', 'dsh-sdk-jsonrpc-server')],
    [join(dshRoot, 'packages', 'examples', 'agent-spine-demo'), join(nodeModules, '@deepseek-ai', 'dsh-agent-spine-demo')],
    [join(dshRoot, 'packages', 'interaction', 'commands'), join(nodeModules, '@deepseek-ai', 'dsh-commands')],
    [layout.productStage, join(nodeModules, 'dsh-kingdom')],
  ]
  for (const [target, destination] of knownPackages) {
    if (!(await pathExists(target))) throw new Error('LIVE_COMPOSITION_PACKAGE_MISSING')
    if (await linkRuntimePackage(target, destination)) linkedCount += 1
  }

  const configPath = join(consumer, 'cordis.yml')
  await writeFile(configPath, liveCompositionConfig({ dshHome: layout.dshHome, productStage: layout.productStage }), 'utf8')
  return {
    consumer,
    nodeModules,
    configPath,
    linkedCount,
    entryIds: ['agent-spine', 'commands', 'sdk-jsonrpc-server', 'dsh-kingdom'],
  }
}

/**
 * Start one owned built DSH JSON-RPC runtime, subscribe before initialize,
 * perform initialize only, and close it through HarnessClient. No
 * session/prompt is sent; Worker dispatch observation is intentionally not run.
 */
export async function runLiveKeylessCompositionProbe({
  dshRoot = DSH_ROOT_DEFAULT,
  providerAlias,
  model,
  layout,
  productStage,
} = {}) {
  const explicitProviderAlias = nonEmptyText(providerAlias, 'provider_alias')
  const explicitModel = nonEmptyText(model, 'model')
  const result = {
    status: 'BLOCKED',
    attempted: true,
    initialized: false,
    runtimeProcessOwnedByRunner: false,
    runtimeOwnershipEvidence: 'HarnessClient.start/close public process-ownership surface',
    runtimeClosed: false,
    promptInvocations: 0,
    providerCalls: 0,
    workerDispatchObservation: 'NOT_RUN_BY_DESIGN',
    subscriptionMethod: 'session.event',
    noHistoricalSessionRead: true,
    noPrivateProfileRead: true,
  }

  if (productStage === undefined || !(await pathExists(productStage))) {
    return { ...result, reason: 'LIVE_PRODUCT_STAGE_REQUIRED' }
  }

  let consumer
  let compositionJunction
  let client
  let sessionSubscription
  try {
    consumer = await prepareLiveCompositionConsumer({ dshRoot, layout: { ...layout, productStage } })
    // The required product-stage junction is already gone before this phase.
    // This separate dependency link exists only for the live composition and
    // is verified/removed before its target or the consumer is cleaned up.
    compositionJunction = await createVerifiedDirectoryJunction(join(productStage, 'node_modules'), consumer.nodeModules)

    const sdkPath = join(dshRoot, SDK_CLIENT_RELATIVE)
    const jsonrpcBin = join(dshRoot, JSONRPC_DEMO_RELATIVE)
    if (!(await pathExists(sdkPath)) || !(await pathExists(jsonrpcBin))) throw new Error('LIVE_DSH_SDK_ARTIFACT_MISSING')
    const { HarnessClient } = await import(pathToFileURL(sdkPath).href)
    client = new HarnessClient({
      command: process.execPath,
      args: [jsonrpcBin, consumer.configPath],
      cwd: consumer.consumer,
      env: buildRunnerEnvironment(layout),
      requestTimeoutMs: 8_000,
      shutdownTimeoutMs: 2_000,
      disposeEofGraceMs: 2_000,
      disposeGraceMs: 2_000,
    })

    client.start()
    result.runtimeProcessOwnedByRunner = true
    const observer = createKeylessSessionEventObserver()
    const registered = subscribeOfficialSessionEvents(client, observer)
    sessionSubscription = registered.subscription
    const initialized = await client.initialize({
      cwd: layout.workerWorkspace,
      provider: explicitProviderAlias,
      model: explicitModel,
    })
    result.initialized = true
    // Keep only the protocol-level presence bit; never persist the returned
    // object in bounded evidence.
    result.serverIdentityObserved = isRecord(initialized?.serverInfo)
      && typeof initialized.serverInfo.name === 'string'
      && typeof initialized.serverInfo.version === 'string'
    result.subscriptionEstablished = registered.subscriptionEstablishedBeforePrompt
    result.compositionEvidence = registered.subscriptionEstablishedBeforePrompt
      ? 'OFFICIAL_SESSION_EVENT_SUBSCRIPTION_READY'
      : 'SUBSCRIPTION_NOT_READY'
    result.evidence = observer.snapshot()
    result.reason = 'KEYLESS_INITIALIZE_SUBSCRIPTION_READY_WORKER_DISPATCH_NOT_RUN'
  } catch (error) {
    result.reason = 'LIVE_COMPOSITION_START_OR_INITIALIZE_BLOCKED'
    result.error = safeError(error, 'LIVE_COMPOSITION_FAILED')
  } finally {
    try { sessionSubscription?.close() } catch { /* owned SDK cleanup below */ }
    if (client !== undefined) {
      try {
        await client.close()
        result.runtimeClosed = true
      } catch {
        result.cleanupError = 'SDK_RUNTIME_CLOSE_FAILED'
      }
    }
    if (compositionJunction !== undefined) {
      try {
        await removeVerifiedDirectoryJunction(compositionJunction.junction, compositionJunction.target)
      } catch {
        result.cleanupError = 'COMPOSITION_JUNCTION_CLEANUP_FAILED'
      }
    }
    if (consumer !== undefined) {
      try {
        await rm(consumer.consumer, { recursive: true, force: true })
      } catch {
        result.cleanupError = 'COMPOSITION_CONSUMER_CLEANUP_FAILED'
      }
    }
  }
  if (result.cleanupError === undefined
    && result.initialized === true
    && result.subscriptionEstablished === true
    && result.runtimeClosed === true
    && result.runtimeProcessOwnedByRunner === true
    && result.serverIdentityObserved === true
    && result.compositionEvidence === 'OFFICIAL_SESSION_EVENT_SUBSCRIPTION_READY') {
    result.status = 'KEYLESS_COMPOSITION_PASS'
  }
  return result
}

/**
 * Build the public SDK runtime used by the opt-in REAL-attempt branch.  The
 * returned handle owns only the runner-created composition consumer and its
 * verified Junction; it exposes no SDK-private child/PID field.
 */
export async function closeOwnedRealAttemptResources({
  client,
  compositionJunction,
  consumer,
  removeJunction = removeVerifiedDirectoryJunction,
  removeConsumer = async path => rm(path, { recursive: true, force: true }),
} = {}) {
  let cleanupFailed = false
  if (client !== undefined) {
    try {
      await client.close()
    } catch {
      cleanupFailed = true
    }
  }
  if (compositionJunction !== undefined) {
    try {
      await removeJunction(compositionJunction.junction, compositionJunction.target)
    } catch {
      cleanupFailed = true
    }
  }
  if (consumer !== undefined) {
    try {
      await removeConsumer(consumer.consumer)
    } catch {
      cleanupFailed = true
    }
  }
  return { ok: !cleanupFailed }
}

export async function createLiveRealAttemptRuntime({
  dshRoot = DSH_ROOT_DEFAULT,
  providerAlias,
  model,
  layout,
  productStage,
  publicRouteSurface,
  routeEvidence,
} = {}) {
  const explicitProviderAlias = nonEmptyText(providerAlias, 'provider_alias')
  const explicitModel = nonEmptyText(model, 'model')
  if (!isRecord(layout) || productStage === undefined || !(await pathExists(productStage))) {
    throw new Error('REAL_ATTEMPT_PRODUCT_STAGE_REQUIRED')
  }
  const configuredRoute = isBoundedRouteEvidence(routeEvidence, explicitProviderAlias, explicitModel)
    ? routeEvidence
    : await resolvePublicConfiguredRoute({
        publicRouteSurface,
        providerAlias: explicitProviderAlias,
        model: explicitModel,
      })
  if (!isBoundedRouteEvidence(configuredRoute, explicitProviderAlias, explicitModel)) {
    throw new Error(configuredRoute.reason ?? 'PUBLIC_ROUTE_SURFACE_REQUIRED')
  }

  let consumer
  let compositionJunction
  let client
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    const cleanup = await closeOwnedRealAttemptResources({ client, compositionJunction, consumer })
    if (!cleanup.ok) throw new Error('REAL_ATTEMPT_OWNED_CLEANUP_FAILED')
  }

  try {
    consumer = await prepareLiveCompositionConsumer({ dshRoot, layout: { ...layout, productStage } })
    compositionJunction = await createVerifiedDirectoryJunction(join(productStage, 'node_modules'), consumer.nodeModules)

    const sdkPath = join(dshRoot, SDK_CLIENT_RELATIVE)
    const jsonrpcBin = join(dshRoot, JSONRPC_DEMO_RELATIVE)
    if (!(await pathExists(sdkPath)) || !(await pathExists(jsonrpcBin))) throw new Error('REAL_ATTEMPT_DSH_SDK_ARTIFACT_MISSING')
    const { HarnessClient } = await import(pathToFileURL(sdkPath).href)
    client = new HarnessClient({
      command: process.execPath,
      args: [jsonrpcBin, consumer.configPath],
      cwd: consumer.consumer,
      env: buildRunnerEnvironment(layout),
      requestTimeoutMs: 8_000,
      shutdownTimeoutMs: 2_000,
      disposeEofGraceMs: 2_000,
      disposeGraceMs: 2_000,
    })
    client.start()
    const initialized = await client.initialize({
      cwd: layout.workerWorkspace,
      provider: explicitProviderAlias,
      model: explicitModel,
    })
    const serverIdentityObserved = isRecord(initialized?.serverInfo)
      && typeof initialized.serverInfo.name === 'string'
      && typeof initialized.serverInfo.version === 'string'
    if (!serverIdentityObserved) throw new Error('REAL_ATTEMPT_SERVER_IDENTITY_MISSING')
    return {
      client,
      initialized: true,
      serverIdentityObserved,
      runtimeProcessOwnedByRunner: true,
      routeEvidence: configuredRoute,
      close,
    }
  } catch (error) {
    try { await close() } catch { /* preserve the original bounded error */ }
    throw error
  }
}

const STOP_STATUSES = new Set(['UNKNOWN', 'TIMEOUT', 'RECOVERING', 'LEGACY', 'LEGACY_COMPAT'])
const CONTROLLED_PHASE = {
  AUTHORIZATION_PENDING: 'AUTHORIZATION_PENDING',
  AUTHORIZATION_GRANTED: 'AUTHORIZATION_GRANTED',
  ENFORCEMENT_FULL: 'ENFORCEMENT_FULL',
  OPPORTUNITY_RESERVED: 'OPPORTUNITY_RESERVED',
  ATTEMPT_RECORDED: 'ATTEMPT_RECORDED',
  DISPATCH_RECORDED: 'DISPATCH_RECORDED',
  RECEIPT_RECORDED: 'RECEIPT_RECORDED',
  TERMINAL_EVIDENCE_RECORDED: 'TERMINAL_EVIDENCE_RECORDED',
  EXECUTION_TERMINAL: 'EXECUTION_TERMINAL',
  CLAIM_COMPLETED: 'CLAIM_COMPLETED',
  TASK_REVIEW: 'TASK_REVIEW',
  CLEANUP_SETTLED: 'CLEANUP_SETTLED',
  LEASE_RELEASED: 'LEASE_RELEASED',
  INVALID: 'INVALID',
}
const CONTROLLED_STATUS_VALUES = new Set([
  'UNKNOWN', 'TIMEOUT', 'RECOVERING', 'LEGACY', 'LEGACY_COMPAT', 'TERMINAL',
])
const EXACT_GATE_CORRELATION_FIELDS = [
  ['sessionId', 'CORRELATION_SESSION_MISSING'],
  ['taskId', 'CORRELATION_TASK_MISSING'],
  ['attemptNo', 'CORRELATION_ATTEMPT_MISSING'],
  ['runtimeDispatchRef', 'CORRELATION_RUNTIME_DISPATCH_MISSING'],
  ['kingdomDispatchId', 'CORRELATION_KINGDOM_DISPATCH_MISSING'],
]

/**
 * The only state source admitted by the hard stop gate.  The returned API is
 * an opaque runner-owned transition handle; callers cannot replace its
 * internal counts with a boolean/count/evidence object.
 */
function createControlledStopGateState() {
  const state = {
    phase: CONTROLLED_PHASE.AUTHORIZATION_PENDING,
    invalid: false,
    authorization: 'NOT_RUN',
    enforcement: 'NOT_RUN',
    enforcementStrength: 'NOT_RUN',
    terminal: false,
    claimStatus: 'NOT_RUN',
    taskStatus: 'NOT_RUN',
    opportunityReservationCount: 0,
    attemptCount: 0,
    dispatchCount: 0,
    receiptCount: 0,
    terminalEvidenceCount: 0,
    cleanupSettled: false,
    leaseReleaseCount: 0,
    leaseReleased: false,
    statuses: [],
    timeout: false,
    invalidTransitionCount: 0,
  }

  let api
  const invalidTransition = () => {
    if (state.invalid) return
    state.invalid = true
    state.phase = CONTROLLED_PHASE.INVALID
    state.invalidTransitionCount += 1
  }
  const transition = (expectedPhase, nextPhase, apply) => {
    if (state.invalid || state.phase !== expectedPhase) {
      invalidTransition()
      return api
    }
    apply()
    if (state.invalid) return api
    state.phase = nextPhase
    return api
  }
  api = {
    grantAuthorization() {
      return transition(CONTROLLED_PHASE.AUTHORIZATION_PENDING, CONTROLLED_PHASE.AUTHORIZATION_GRANTED, () => {
        state.authorization = 'GRANTED'
      })
    },
    enforceFull() {
      return transition(CONTROLLED_PHASE.AUTHORIZATION_GRANTED, CONTROLLED_PHASE.ENFORCEMENT_FULL, () => {
        state.enforcement = 'ENFORCED'
        state.enforcementStrength = 'FULL'
      })
    },
    markOpportunityReserved(reservedLedger) {
      return transition(CONTROLLED_PHASE.ENFORCEMENT_FULL, CONTROLLED_PHASE.OPPORTUNITY_RESERVED, () => {
        if (!isRecord(reservedLedger) || reservedLedger.currentCalls !== 1 || reservedLedger.remaining !== 8) {
          invalidTransition()
          return
        }
        state.opportunityReservationCount = 1
      })
    },
    recordAttempt() {
      return transition(CONTROLLED_PHASE.OPPORTUNITY_RESERVED, CONTROLLED_PHASE.ATTEMPT_RECORDED, () => {
        state.attemptCount = 1
      })
    },
    recordDispatch() {
      return transition(CONTROLLED_PHASE.ATTEMPT_RECORDED, CONTROLLED_PHASE.DISPATCH_RECORDED, () => {
        state.dispatchCount = 1
      })
    },
    recordReceipt() {
      return transition(CONTROLLED_PHASE.DISPATCH_RECORDED, CONTROLLED_PHASE.RECEIPT_RECORDED, () => {
        state.receiptCount = 1
      })
    },
    recordTerminalEvidence() {
      return transition(CONTROLLED_PHASE.RECEIPT_RECORDED, CONTROLLED_PHASE.TERMINAL_EVIDENCE_RECORDED, () => {
        state.terminalEvidenceCount = 1
      })
    },
    markTerminal() {
      return transition(CONTROLLED_PHASE.TERMINAL_EVIDENCE_RECORDED, CONTROLLED_PHASE.EXECUTION_TERMINAL, () => {
        state.terminal = true
      })
    },
    completeClaim() {
      return transition(CONTROLLED_PHASE.EXECUTION_TERMINAL, CONTROLLED_PHASE.CLAIM_COMPLETED, () => {
        state.claimStatus = 'COMPLETED'
      })
    },
    moveTaskToReview() {
      return transition(CONTROLLED_PHASE.CLAIM_COMPLETED, CONTROLLED_PHASE.TASK_REVIEW, () => {
        state.taskStatus = 'REVIEW'
      })
    },
    settleCleanup() {
      return transition(CONTROLLED_PHASE.TASK_REVIEW, CONTROLLED_PHASE.CLEANUP_SETTLED, () => {
        state.cleanupSettled = true
      })
    },
    releaseLease() {
      return transition(CONTROLLED_PHASE.CLEANUP_SETTLED, CONTROLLED_PHASE.LEASE_RELEASED, () => {
        if (state.authorization !== 'GRANTED'
          || state.enforcement !== 'ENFORCED'
          || state.enforcementStrength !== 'FULL'
          || state.opportunityReservationCount !== 1
          || state.attemptCount !== 1
          || state.dispatchCount !== 1
          || state.receiptCount !== 1
          || state.terminalEvidenceCount !== 1
          || state.terminal !== true
          || state.claimStatus !== 'COMPLETED'
          || state.taskStatus !== 'REVIEW'
          || state.cleanupSettled !== true) {
          invalidTransition()
          return
        }
        state.leaseReleaseCount = 1
        state.leaseReleased = true
      })
    },
    observeStatus(status) {
      if (state.invalid || typeof status !== 'string' || !CONTROLLED_STATUS_VALUES.has(status)) {
        invalidTransition()
      } else {
        state.statuses.push(status)
      }
      return api
    },
    observeTimeout() {
      if (state.invalid) invalidTransition()
      else state.timeout = true
      return api
    },
    snapshot() {
      return { ...state, statuses: [...state.statuses] }
    },
  }

  return api
}

function appendExactCorrelationFailures(observerCorrelation, failures) {
  const expected = isRecord(observerCorrelation) && isRecord(observerCorrelation.expected)
    ? observerCorrelation.expected
    : undefined
  const observed = isRecord(observerCorrelation) && isRecord(observerCorrelation.observed)
    ? observerCorrelation.observed
    : undefined
  if (!isRecord(expected)) {
    failures.push('CORRELATION_CONTEXT_MISSING')
    if (!isRecord(observed)) failures.push('CORRELATION_OBSERVATION_MISSING')
    return
  }
  for (const [field, missingCode] of EXACT_GATE_CORRELATION_FIELDS) {
    const expectedValue = expected[field]
    const validExpected = field === 'attemptNo'
      ? Number.isInteger(expectedValue) && expectedValue >= 1
      : typeof expectedValue === 'string' && expectedValue.trim() !== ''
    if (!validExpected) failures.push(missingCode)
  }
  if (!isRecord(observed)) {
    failures.push('CORRELATION_OBSERVATION_MISSING')
    return
  }
  for (const [field] of EXACT_GATE_CORRELATION_FIELDS) {
    const observedValue = observed[field]
    const requiredObservedField = field === 'attemptNo' ? Number.isInteger(observedValue) : typeof observedValue === 'string'
    if (!requiredObservedField || (typeof observedValue === 'string' && observedValue.trim() === '')) {
      failures.push(`OBSERVED_${field.replaceAll(/([A-Z])/gu, '_$1').toUpperCase()}_MISSING`)
    } else if (String(observedValue) !== String(expected[field])) {
      failures.push('EXACT_CORRELATION_MISMATCH')
      break
    }
  }
  if (typeof expected.userMessageId !== 'string' || expected.userMessageId.trim() === '') {
    failures.push('CORRELATION_MESSAGE_ID_MISSING')
  } else if (expected.runtimeDispatchRef !== expected.userMessageId) {
    failures.push('RUNTIME_DISPATCH_NOT_BOUND_TO_MESSAGE')
  }
  if (typeof observed.turnId !== 'string' || !/^\d+$/u.test(observed.turnId)) {
    failures.push('OBSERVED_TURN_MISSING_OR_NON_NUMERIC')
  }
  if (observed.exact !== true) failures.push('CORRELATION_NOT_EXACT')
}

function evaluateStopGates(input = {}) {
  const failures = []
  if (!isRecord(input) || !isRecord(input.observer) || !isRecord(input.controlledState)
    || typeof input.observer.snapshot !== 'function'
    || typeof input.observer.correlationSnapshot !== 'function'
    || typeof input.controlledState.snapshot !== 'function') {
    failures.push('CONTROLLED_STOP_GATE_SOURCES_MISSING')
    return { accepted: false, failures }
  }

  const observerEvidence = input.observer.snapshot()
  const observerCorrelation = input.observer.correlationSnapshot()
  const controlledState = input.controlledState.snapshot()
  appendExactCorrelationFailures(observerCorrelation, failures)
  if (controlledState.authorization !== 'GRANTED') failures.push('AUTHORIZATION_NOT_GRANTED')
  if (controlledState.enforcement !== 'ENFORCED') failures.push('ENFORCEMENT_NOT_ENFORCED')
  if (controlledState.enforcementStrength !== 'FULL') failures.push('ENFORCEMENT_NOT_FULL')
  if (controlledState.terminal !== true) failures.push('NOT_TERMINAL')
  if (controlledState.claimStatus !== 'COMPLETED') failures.push('CLAIM_NOT_COMPLETED')
  if (controlledState.taskStatus !== 'REVIEW') failures.push('TASK_NOT_REVIEW')
  if (controlledState.opportunityReservationCount !== 1) failures.push('OPPORTUNITY_RESERVATION_NOT_EXACTLY_ONE')
  if (controlledState.receiptCount !== 1 || observerEvidence.targetReceiptCount !== 1) failures.push('RECEIPT_MISSING')
  if (controlledState.terminalEvidenceCount !== 1) failures.push('TERMINAL_EVIDENCE_MISSING')
  if (observerEvidence.completedTurnCount !== 1) failures.push('TURN_COMPLETED_MISSING')
  if (!(Number(observerEvidence.assistantMessageCount) > 0)) failures.push('ASSISTANT_MESSAGE_MISSING')
  if (Number(observerEvidence.foreignUserCount) !== 0) failures.push('FOREIGN_USER_MESSAGE')
  if (Number(observerEvidence.foreignSessionCount ?? 0) !== 0) failures.push('FOREIGN_SESSION_EVENT')
  if (Number(observerEvidence.correlationMismatches) !== 0) failures.push('DISPATCH_CORRELATION_MISMATCH')
  if (Number(observerEvidence.eventSeqViolationCount) !== 0) failures.push('EVENT_SEQ_NOT_CONTIGUOUS')
  if (Number(observerEvidence.effectiveRouteObservationCount) !== 1
    || Number(observerEvidence.missingEffectiveRouteCount) !== 0) failures.push('EFFECTIVE_ROUTE_NOT_OBSERVED')
  if (observerEvidence.rootSessionIdleObserved !== true) failures.push('SESSION_IDLE_SYNC_MISSING')
  if (controlledState.cleanupSettled !== true) failures.push('CLEANUP_NOT_SETTLED')
  if (controlledState.leaseReleased !== true || controlledState.leaseReleaseCount !== 1) failures.push('LEASE_NOT_RELEASED')
  if (controlledState.attemptCount !== 1) failures.push('EXTRA_ATTEMPT_OR_MISSING_ATTEMPT')
  if (controlledState.dispatchCount !== 1) failures.push('EXTRA_DISPATCH_OR_MISSING_DISPATCH')
  if (controlledState.invalid === true
    || controlledState.phase === CONTROLLED_PHASE.INVALID
    || controlledState.invalidTransitionCount !== 0) failures.push('CONTROLLED_STATE_INVALID')
  if (controlledState.phase !== CONTROLLED_PHASE.LEASE_RELEASED) failures.push('CONTROLLED_LIFECYCLE_NOT_SETTLED')
  if (controlledState.statuses.some(status => STOP_STATUSES.has(status))) failures.push('STOP_STATUS_OBSERVED')
  if (controlledState.timeout === true) failures.push('TIMEOUT_OBSERVED')
  return { accepted: failures.length === 0, failures }
}

function publicStageResult(stage) {
  if (stage === undefined) return { status: 'NOT_RUN' }
  if (stage.status !== 'READY') return { status: stage.status ?? 'BLOCKED', error: stage.error }
  return {
    status: 'READY',
    testExitCode: stage.testExitCode,
    packExitCode: stage.packExitCode,
    artifactCount: stage.artifactCount,
    artifactNames: stage.artifactNames,
    trace: stage.trace,
    copied: stage.copy?.copied,
  }
}

async function writeBoundedEvidence(layout, result) {
  const summary = {
    runId: RUN_ID,
    featureId: FEATURE_ID,
    status: result.status,
    requestedProviderAlias: result.requestedProviderAlias,
    requestedModel: result.requestedModel,
    effectiveProvider: result.effectiveProvider ?? 'UNKNOWN',
    effectiveModel: result.effectiveModel ?? 'UNKNOWN',
    noProviderCall: result.noProviderCall !== false,
    providerCalls: result.providerCalls ?? 0,
    promptInvocations: result.promptInvocations ?? 0,
    providerCallObserved: result.providerCallObserved === true,
    providerCallObservation: result.providerCallObservation ?? 'NOT_OBSERVED',
    providerOutcome: result.providerOutcome ?? 'NOT_RUN',
    providerOpportunityConsumed: result.providerOpportunityConsumed === true,
    providerOpportunity: result.providerOpportunity,
    opportunityLedger: result.opportunityLedger,
    routeEvidence: result.routeEvidence,
    stateTrace: result.stateTrace,
    preflight: result.preflight,
    productStage: publicStageResult(result.productStage),
    compositionProbe: result.compositionProbe,
    attemptEvidence: result.attemptEvidence,
    governance: result.governance,
    hardGates: result.hardGates,
  }
  const serialized = JSON.stringify(summary)
  if (FORBIDDEN_EVIDENCE_WORDS.test(serialized.replace('requestedProviderAlias', 'requestedRoute'))) {
    // Provider alias/model names are explicit input; no credential-bearing fields are allowed.
    if (/credential|token|secret|api[_-]?key|password|raw|jsonl/i.test(serialized)) throw new Error('BOUNDED_EVIDENCE_PRIVATE_FIELD')
  }
  const path = join(layout.boundedEvidence, 'runner-summary.json')
  assertWithinRoot(layout.boundedEvidence, path, 'bounded_evidence')
  await writeFile(path, `${serialized}\n`, 'utf8')
  return 'bounded-evidence/runner-summary.json'
}

function blockedResultBase({ providerAlias, model, ledger, layout, stateTrace }) {
  return {
    status: 'BLOCKED',
    mode: 'KEYLESS_COMPOSITION',
    runId: RUN_ID,
    featureId: FEATURE_ID,
    requestedProviderAlias: providerAlias,
    requestedModel: model,
    effectiveModel: 'UNKNOWN',
    effectiveProvider: 'UNKNOWN',
    providerOpportunity: ledger,
    providerOpportunityConsumed: false,
    providerCallObserved: false,
    providerCallObservation: 'NOT_OBSERVED',
    providerOutcome: 'NOT_RUN',
    noProviderCall: true,
    providerCalls: 0,
    promptInvocations: 0,
    stateTrace,
    layout,
  }
}

/**
 * Orchestrate only the keyless runner path.  The governed sequence is exposed
 * as a contract constant, never executed by this function.
 */
export async function runNoProviderDryRun({
  providerAlias,
  model,
  productRoot = PRODUCT_ROOT_DEFAULT,
  dshRoot = DSH_ROOT_DEFAULT,
  wrapperPath = DSH_WRAPPER_DEFAULT,
  prepareProductStage = true,
  runLiveProbe = true,
  layout,
  runnerRoot,
  sdkClient,
  commandRunner,
  robocopyRunner,
} = {}) {
  const explicitProviderAlias = nonEmptyText(providerAlias, 'provider_alias')
  const explicitModel = nonEmptyText(model, 'model')
  const ownedLayout = layout ?? await createRunnerLayout({ root: runnerRoot })
  const opportunityLedger = await initializeOpportunityLedger(ownedLayout)
  const ledger = opportunityLedger.ledger
  const stateTrace = ['BOOTSTRAP']
  const result = blockedResultBase({
    providerAlias: explicitProviderAlias,
    model: explicitModel,
    ledger,
    layout: ownedLayout,
    stateTrace,
  })
  result.opportunityLedger = { pathLabel: opportunityLedger.pathLabel }

  stateTrace.push('PREFLIGHT')
  let preflight
  try {
    preflight = await inspectDshPreflight({ dshRoot, wrapperPath, layout: ownedLayout })
  } catch (error) {
    preflight = { ok: false, failures: [errorCode(error)], noDshProcessStarted: true, noProviderCall: true }
  }
  result.preflight = preflight
  if (!preflight.ok) {
    stateTrace.push('BLOCKED_PRECHECK')
    result.productStage = { status: 'NOT_RUN', reason: 'PREFLIGHT_FAILED' }
    result.compositionProbe = { status: 'NOT_RUN', reason: 'PREFLIGHT_FAILED', providerCalls: 0, promptInvocations: 0 }
    result.hardGates = evaluateStopGates({ status: 'UNKNOWN' })
    result.evidencePath = await writeBoundedEvidence(ownedLayout, result)
    return result
  }

  stateTrace.push('OVERLAY_COMPOSED')
  result.overlay = await writeProfileOverlay(ownedLayout)

  if (prepareProductStage) {
    stateTrace.push('PRODUCT_STAGE')
    try {
      result.productStage = await stageAndPackProduct({
        productRoot,
        layout: ownedLayout,
        commandRunner,
        robocopyRunner,
      })
    } catch (error) {
      result.productStage = { status: 'BLOCKED', error: safeError(error, 'PRODUCT_STAGE_FAILED') }
      stateTrace.push('BLOCKED_PRODUCT_STAGE')
      result.compositionProbe = { status: 'NOT_RUN', reason: 'PRODUCT_STAGE_FAILED', providerCalls: 0, promptInvocations: 0 }
      result.hardGates = evaluateStopGates({ status: 'UNKNOWN' })
      result.evidencePath = await writeBoundedEvidence(ownedLayout, result)
      return result
    }
  } else {
    result.productStage = { status: 'NOT_RUN', reason: 'EXPLICIT_NO_PRODUCT_STAGE' }
  }

  stateTrace.push('COMPOSITION_PROBE')
  const filterContract = runKeylessCompositionProbe({
    client: sdkClient,
  })
  const liveProbe = runLiveProbe
    ? await runLiveKeylessCompositionProbe({
        dshRoot,
        providerAlias: explicitProviderAlias,
        model: explicitModel,
        layout: ownedLayout,
        productStage: result.productStage?.status === 'READY' ? ownedLayout.productStage : undefined,
      })
    : { status: 'NOT_RUN', reason: 'EXPLICIT_LIVE_PROBE_DISABLED', providerCalls: 0, promptInvocations: 0 }
  result.compositionProbe = {
    ...liveProbe,
    filterContract: {
      status: filterContract.status,
      subscriptionEstablished: filterContract.subscriptionEstablished,
      providerCalls: filterContract.providerCalls,
      promptInvocations: filterContract.promptInvocations,
    },
  }
  // Keyless composition never creates the REAL-attempt proof.  The public
  // hard gate therefore remains fail-closed and cannot be promoted by the
  // composition result or any caller-supplied booleans/counts.
  result.hardGates = evaluateStopGates({})
  if (result.compositionProbe.status === 'KEYLESS_COMPOSITION_PASS') {
    result.status = 'RUNNER_SCOPED_READY'
    stateTrace.push('KEYLESS_COMPOSITION_PASS')
  } else {
    stateTrace.push('BLOCKED_COMPOSITION')
  }
  result.evidencePath = await writeBoundedEvidence(ownedLayout, result)
  return result
}

class ContractSimulationStop extends Error {
  constructor(status, reason) {
    super(reason)
    this.status = status
    this.reason = reason
  }
}

function boundedAttemptEvidence(observer) {
  const evidence = observer.snapshot()
  const correlation = observer.correlationSnapshot()
  return {
    maskedSessionRef: evidence.maskedSessionRef,
    observedEventCount: evidence.observedEventCount,
    matchingUserCount: evidence.matchingUserCount,
    foreignUserCount: evidence.foreignUserCount,
    foreignSessionCount: evidence.foreignSessionCount,
    turnStartCount: evidence.turnStartCount,
    turnEndCount: evidence.turnEndCount,
    completedTurnCount: evidence.completedTurnCount,
    assistantMessageCount: evidence.assistantMessageCount,
    correlationMismatches: evidence.correlationMismatches,
    effectiveRouteMismatches: evidence.effectiveRouteMismatches,
    missingCorrelationCount: evidence.missingCorrelationCount,
    exactCorrelationEventCount: evidence.exactCorrelationEventCount,
    taskCorrelation: evidence.taskCorrelation,
    attemptCorrelation: evidence.attemptCorrelation,
    dispatchCorrelation: evidence.dispatchCorrelation,
    kingdomDispatchCorrelation: evidence.kingdomDispatchCorrelation,
    targetReceiptCount: evidence.targetReceiptCount,
    targetUserMessageCount: evidence.targetUserMessageCount,
    effectiveProvider: evidence.effectiveProvider ?? 'UNKNOWN',
    effectiveModel: evidence.effectiveModel ?? 'UNKNOWN',
    effectiveRouteObservationCount: evidence.effectiveRouteObservationCount,
    missingEffectiveRouteCount: evidence.missingEffectiveRouteCount,
    targetTurnStartCount: evidence.targetTurnStartCount,
    targetTurnEndCount: evidence.targetTurnEndCount,
    targetTurn: evidence.targetTurn,
    activityStarted: evidence.activityStarted,
    targetTurnEnded: evidence.targetTurnEnded,
    rootSessionIdleObserved: evidence.rootSessionIdleObserved,
    idleBeforeTerminalCount: evidence.idleBeforeTerminalCount,
    preTargetEventCount: evidence.preTargetEventCount,
    outOfBoundsEventCount: evidence.outOfBoundsEventCount,
    multipleTargetTurnCount: evidence.multipleTargetTurnCount,
    outOfOrderEventCount: evidence.outOfOrderEventCount,
    eventSeqGapCount: evidence.eventSeqGapCount,
    eventSeqDuplicateCount: evidence.eventSeqDuplicateCount,
    eventSeqDecreaseCount: evidence.eventSeqDecreaseCount,
    eventSeqViolationCount: evidence.eventSeqViolationCount,
    eventSeqViolationReason: evidence.eventSeqViolationReason,
    invalidNotificationCount: evidence.invalidNotificationCount,
    exactCorrelation: correlation.exact === true,
    observedTurn: correlation.observed?.turnId,
  }
}

function applyBoundedAttemptEvidence(result, observer) {
  const evidence = boundedAttemptEvidence(observer)
  result.attemptEvidence = evidence
  result.effectiveProvider = evidence.effectiveProvider
  result.effectiveModel = evidence.effectiveModel
  if (evidence.effectiveProvider !== 'UNKNOWN' && evidence.effectiveModel !== 'UNKNOWN') {
    // The assistant source is useful synthetic route evidence for the
    // CONTRACT_SIMULATION_ONLY parser, not proof that a real Provider ran.
    result.providerCalls = 0
    result.providerCallObserved = false
    result.providerCallObservation = 'CONTRACT_SIMULATION_SYNTHETIC_ASSISTANT_EVENT'
    result.providerOutcome = 'NOT_RUN'
    result.noProviderCall = true
  }
  return evidence
}

function hasCompleteSimulationEvidence(observer) {
  const evidence = observer.snapshot()
  const correlation = observer.correlationSnapshot()
  return correlation.exact === true
    && evidence.targetReceiptCount === 1
    && evidence.targetUserMessageCount === 1
    && evidence.targetTurnStartCount === 1
    && evidence.completedTurnCount === 1
    && evidence.assistantMessageCount > 0
    && evidence.foreignUserCount === 0
    && evidence.foreignSessionCount === 0
    && evidence.preTargetEventCount === 0
    && evidence.outOfBoundsEventCount === 0
    && evidence.multipleTargetTurnCount === 0
    && evidence.eventSeqViolationCount === 0
    && evidence.missingCorrelationCount === 0
    && evidence.correlationMismatches === 0
    && evidence.effectiveRouteObservationCount === 1
    && evidence.missingEffectiveRouteCount === 0
    && evidence.rootSessionIdleObserved === true
}

/**
 * REAL_PRODUCTION first consumes the Product-owned cross-realm context seam.
 * The package-root connector is the only accepted source of context; no
 * caller IDs, port, ticket, token, ledger, runtime, or route surface is
 * accepted before this bounded pre-provider gate.
 */
export async function runRealAttemptBranch({ optIn = false, providerAlias, model } = {}) {
  const providerBoundaryStart = runnerProviderBoundaryCalls
  if (optIn !== true) {
    return {
      status: 'BLOCKED',
      mode: 'REAL_PRODUCTION',
      runId: RUN_ID,
      featureId: FEATURE_ID,
      reason: 'REAL_ATTEMPT_OPT_IN_REQUIRED',
      requestedProviderAlias: providerAlias,
      requestedModel: model,
      effectiveProvider: 'UNKNOWN',
      effectiveModel: 'UNKNOWN',
      providerOutcome: 'NOT_RUN',
      providerCallObservation: 'NOT_RUN_BY_DESIGN',
      noProviderCall: true,
      providerCalls: 0,
      promptInvocations: 0,
      providerOpportunityConsumed: false,
      providerBoundaryCounter: providerBoundaryCounterFrom(providerBoundaryStart),
    }
  }

  const stateTrace = ['REAL_ATTEMPT_OPT_IN']
  let client
  let result = {
    status: 'BLOCKED',
    mode: 'REAL_PRODUCTION',
    runId: RUN_ID,
    featureId: FEATURE_ID,
    reason: 'PRODUCT_CONTEXT_NOT_CONNECTED',
    requestedProviderAlias: providerAlias,
    requestedModel: model,
    effectiveProvider: 'UNKNOWN',
    effectiveModel: 'UNKNOWN',
    providerOutcome: 'NOT_RUN',
    providerCallObservation: 'NOT_RUN_BY_DESIGN',
    noProviderCall: true,
    providerCalls: 0,
    promptInvocations: 0,
    providerOpportunityConsumed: false,
    stateTrace,
  }

  try {
    stateTrace.push('PRODUCT_BOOTSTRAP_REQUIRED')
    client = await connectProductRunnerContextBroker()
    stateTrace.push('PRODUCT_BROKER_CONNECTED')
    const view = validateProductContextView(await client.read())
    stateTrace.push('PRODUCT_CONTEXT_ACQUIRED')
    result = {
      ...result,
      status: 'REAL_PRODUCTION_CONTEXT_CONNECTED',
      reason: 'PRODUCT_CONTEXT_CONNECTED_PROVIDER_NOT_RUN',
      productContext: {
        source: 'PRODUCT_PUBLIC_PACKAGE_ROOT_CONNECTOR',
        status: 'ACQUIRED',
        view,
      },
    }
  } catch (error) {
    const code = errorCode(error, 'PRODUCT_CONTEXT_CONNECT_FAILED')
    result = {
      ...result,
      reason: code.startsWith('PRODUCT_BROKER_SERIALIZED_ENV_') || code === 'PRODUCT_ROOT_CONNECTOR_UNAVAILABLE'
        ? code
        : 'PRODUCT_CONTEXT_CONNECT_FAILED',
      contextFailureCode: code,
      productContext: {
        source: 'PRODUCT_PUBLIC_PACKAGE_ROOT_CONNECTOR',
        status: 'BLOCKED',
        failure: 'FAIL_CLOSED_BEFORE_PROVIDER_OPPORTUNITY',
      },
    }
  } finally {
    if (client !== undefined) {
      try {
        await client.close()
      } catch (error) {
        const code = errorCode(error, 'PRODUCT_CONTEXT_CLOSE_FAILED')
        result = {
          ...result,
          status: 'BLOCKED',
          reason: 'PRODUCT_CONTEXT_CLOSE_FAILED',
          contextFailureCode: code,
          productContext: {
            source: 'PRODUCT_PUBLIC_PACKAGE_ROOT_CONNECTOR',
            status: 'BLOCKED',
            failure: 'FAIL_CLOSED_BEFORE_PROVIDER_OPPORTUNITY',
          },
        }
      }
    }
  }
  result.providerBoundaryCounter = providerBoundaryCounterFrom(providerBoundaryStart)
  return result
}

/**
 * Explicit CONTRACT_SIMULATION_ONLY orchestration. It uses the same bounded
 * event and durable-ledger path for negative regression tests, but it never
 * calls governance and can never produce a production terminal result.
 */
export async function runContractSimulation({
  simulationOptIn = false,
  providerAlias,
  model,
  requirement,
  productRoot = PRODUCT_ROOT_DEFAULT,
  dshRoot = DSH_ROOT_DEFAULT,
  wrapperPath = DSH_WRAPPER_DEFAULT,
  runnerRoot,
  layout,
  prepareProductStage = true,
  preflightRunner = inspectDshPreflight,
  stageRunner = stageAndPackProduct,
  runtimeFactory,
  publicRouteSurface,
  activityTimeoutMs = 10_000,
  commandRunner,
  robocopyRunner,
} = {}) {
  if (simulationOptIn !== true) {
    return {
      status: 'BLOCKED',
      mode: 'CONTRACT_SIMULATION_ONLY',
      reason: 'CONTRACT_SIMULATION_OPT_IN_REQUIRED',
      requestedProviderAlias: providerAlias,
      requestedModel: model,
      effectiveModel: 'UNKNOWN',
      noProviderCall: true,
      providerCalls: 0,
      promptInvocations: 0,
    }
  }

  const explicitProviderAlias = nonEmptyText(providerAlias, 'provider_alias')
  const explicitModel = nonEmptyText(model, 'model')
  const explicitRequirement = nonEmptyText(requirement, 'requirement', { maxLength: 4_000 })
  if (!Number.isSafeInteger(activityTimeoutMs) || activityTimeoutMs < 1 || activityTimeoutMs > 120_000) {
    throw new Error('ACTIVITY_TIMEOUT_INVALID')
  }
  if (prepareProductStage !== true) throw new Error('CONTRACT_SIMULATION_PRODUCT_STAGE_REQUIRED')
  if (typeof preflightRunner !== 'function' || typeof stageRunner !== 'function'
    || typeof runtimeFactory !== 'function') {
    throw new Error('CONTRACT_SIMULATION_RUNNER_SURFACE_REQUIRED')
  }

  const ownedLayout = layout ?? await createRunnerLayout({ root: runnerRoot })
  const opportunityLedger = await initializeOpportunityLedger(ownedLayout)
  const stateTrace = ['BOOTSTRAP', 'CONTRACT_SIMULATION_OPT_IN']
  const runnerContext = createContractSimulationContext()
  const result = blockedResultBase({
    providerAlias: explicitProviderAlias,
    model: explicitModel,
    ledger: opportunityLedger.ledger,
    layout: ownedLayout,
    stateTrace,
  })
  result.mode = 'CONTRACT_SIMULATION_ONLY'
  result.opportunityLedger = { pathLabel: opportunityLedger.pathLabel }
  result.governance = {
    status: 'NOT_RUN',
    reason: 'CONTRACT_SIMULATION_NO_GOVERNANCE',
    supervisorDecision: 'NOT_RUN',
    taskStatus: 'REVIEW',
  }
  let runtime
  let plan
  let controlledState

  const stop = (status, reason) => { throw new ContractSimulationStop(status, reason) }

  try {
    stateTrace.push('PREFLIGHT')
    result.preflight = await preflightRunner({ dshRoot, wrapperPath, layout: ownedLayout })
    if (!result.preflight?.ok) stop('BLOCKED', 'CONTRACT_SIMULATION_PREFLIGHT_FAILED')

    stateTrace.push('OVERLAY_COMPOSED')
    result.overlay = await writeProfileOverlay(ownedLayout)
    stateTrace.push('CONFIGURED_ROUTE_CHECK')
    const routeEvidence = await resolvePublicConfiguredRoute({
      publicRouteSurface,
      providerAlias: explicitProviderAlias,
      model: explicitModel,
    })
    result.routeEvidence = routeEvidence
    if (!isBoundedRouteEvidence(routeEvidence, explicitProviderAlias, explicitModel)) {
      stop('BLOCKED', routeEvidence.reason ?? 'PUBLIC_ROUTE_SURFACE_REQUIRED')
    }
    stateTrace.push('CONFIGURED_ROUTE_VERIFIED')
    stateTrace.push('PRODUCT_STAGE')
    result.productStage = await stageRunner({
      productRoot,
      layout: ownedLayout,
      commandRunner,
      robocopyRunner,
    })
    if (result.productStage?.status !== 'READY') stop('BLOCKED', 'CONTRACT_SIMULATION_PRODUCT_STAGE_FAILED')

    stateTrace.push('RUNTIME_INITIALIZED')
    runtime = await runtimeFactory({
      dshRoot,
      providerAlias: explicitProviderAlias,
      model: explicitModel,
      layout: ownedLayout,
      productStage: ownedLayout.productStage,
      publicRouteSurface,
      routeEvidence,
      sessionId: runnerContext.sessionId,
    })
    if (!isRecord(runtime) || !isRecord(runtime.client)
      || typeof runtime.client.subscribe !== 'function' || typeof runtime.client.prompt !== 'function'
      || typeof runtime.close !== 'function' || runtime.initialized !== true
      || runtime.runtimeProcessOwnedByRunner !== true
      || !isBoundedRouteEvidence(runtime.routeEvidence, explicitProviderAlias, explicitModel)) {
      stop('BLOCKED', 'CONTRACT_SIMULATION_RUNTIME_SURFACE_INVALID')
    }

    plan = createPromptObservationPlan({
      client: runtime.client,
      runnerContext,
      requestedProviderAlias: explicitProviderAlias,
      requestedModel: explicitModel,
    })
    if (plan.subscriptionEstablishedBeforePrompt !== true) stop('BLOCKED', 'CONTRACT_SIMULATION_SUBSCRIPTION_NOT_READY')
    stateTrace.push('SESSION_EVENT_SUBSCRIBED_BEFORE_PROMPT')

    controlledState = createControlledStopGateState()
      .grantAuthorization()
      .enforceFull()
    stateTrace.push('AUTHORIZATION_GRANTED', 'ENFORCEMENT_FULL')

    let dispatchResult
    try {
      const reserved = await reserveProviderOpportunityAtomically({
        ledgerPath: opportunityLedger.path,
        boundedEvidenceRoot: ownedLayout.boundedEvidence,
        channel: 'provider-prompt',
        enqueue: async () => {
          const committed = await readOpportunityLedger(opportunityLedger.path)
          controlledState.markOpportunityReserved(committed)
          stateTrace.push('OPPORTUNITY_RESERVED')
          controlledState.recordAttempt()
          controlledState.recordDispatch()
          stateTrace.push('ATTEMPT_RECORDED', 'DISPATCH_RECORDED')
          result.promptInvocations += 1
          result.providerCallObservation = 'PENDING_ASSISTANT_SOURCE'
          dispatchResult = await plan.prompt([{ type: 'text', text: explicitRequirement }])
        },
      })
      const committed = await readOpportunityLedger(opportunityLedger.path)
      if (reserved?.currentCalls !== 1 || committed.currentCalls !== 1
        || reserved.remaining !== committed.remaining || reserved.priorConsumed !== committed.priorConsumed) {
        stop('BLOCKED', 'CONTRACT_SIMULATION_DURABLE_RESERVATION_MISMATCH')
      }
      result.providerOpportunity = committed
      result.providerOpportunityConsumed = committed.currentCalls === 1
    } catch (error) {
      if (plan?.observer !== undefined) {
        applyBoundedAttemptEvidence(result, plan.observer)
        if (controlledState !== undefined) {
          result.hardGates = evaluateStopGates({ observer: plan.observer, controlledState })
        }
      }
      try {
        result.providerOpportunity = await readOpportunityLedger(opportunityLedger.path)
        result.providerOpportunityConsumed = result.providerOpportunity.currentCalls === 1
      } catch { /* preserve bounded stop */ }
      stop('BLOCKED', errorCode(error, 'CONTRACT_SIMULATION_OPPORTUNITY_OR_PROMPT_FAILED'))
    }
    if (!isRecord(dispatchResult) || typeof dispatchResult.messageId !== 'string') {
      stop('BLOCKED', 'CONTRACT_SIMULATION_DISPATCH_MISSING')
    }
    controlledState.recordReceipt()
    stateTrace.push('RECEIPT_RECORDED')

    const earlyEvidence = plan.observer.snapshot()
    if (earlyEvidence.idleBeforeTerminalCount > 0
      || (earlyEvidence.targetTurnEnded === true
        && (earlyEvidence.completedTurnCount !== 1 || earlyEvidence.assistantMessageCount < 1))) {
      applyBoundedAttemptEvidence(result, plan.observer)
      controlledState.observeStatus('UNKNOWN')
      result.hardGates = evaluateStopGates({ observer: plan.observer, controlledState })
      stop('UNKNOWN', 'CONTRACT_SIMULATION_TERMINAL_EVIDENCE_INCOMPLETE')
    }
    try {
      await plan.observer.waitForActivityEnd({ timeoutMs: activityTimeoutMs })
    } catch {
      const timeoutEvidence = plan.observer.snapshot()
      controlledState.observeTimeout()
      if (timeoutEvidence.idleBeforeTerminalCount > 0
        || (timeoutEvidence.targetTurnEnded === true
          && (timeoutEvidence.completedTurnCount !== 1 || timeoutEvidence.assistantMessageCount < 1))) {
        applyBoundedAttemptEvidence(result, plan.observer)
        controlledState.observeStatus('UNKNOWN')
        result.hardGates = evaluateStopGates({ observer: plan.observer, controlledState })
        stop('UNKNOWN', 'CONTRACT_SIMULATION_TERMINAL_EVIDENCE_INCOMPLETE')
      }
      stop('UNKNOWN', 'CONTRACT_SIMULATION_ACTIVITY_TIMEOUT')
    }
    if (typeof runtime.stopStatus === 'string' && STOP_STATUSES.has(runtime.stopStatus)) {
      controlledState.observeStatus(runtime.stopStatus)
      stop(runtime.stopStatus === 'UNKNOWN' ? 'UNKNOWN' : 'BLOCKED', `CONTRACT_SIMULATION_STOP_STATUS_${runtime.stopStatus}`)
    }

    applyBoundedAttemptEvidence(result, plan.observer)
    if (!hasCompleteSimulationEvidence(plan.observer)) {
      controlledState.observeStatus('UNKNOWN')
      result.hardGates = evaluateStopGates({ observer: plan.observer, controlledState })
      stop('UNKNOWN', 'CONTRACT_SIMULATION_TERMINAL_EVIDENCE_INCOMPLETE')
    }
    controlledState.recordTerminalEvidence()
    stateTrace.push('TERMINAL_EVIDENCE_RECORDED')
    controlledState.markTerminal()
    stateTrace.push('EXECUTION_TERMINAL')
    controlledState.completeClaim()
    stateTrace.push('CLAIM_COMPLETED')
    controlledState.moveTaskToReview()
    stateTrace.push('TASK_REVIEW')

    controlledState.settleCleanup()
    stateTrace.push('CLEANUP_SETTLED')
    controlledState.releaseLease()
    stateTrace.push('LEASE_RELEASED')
    result.hardGates = evaluateStopGates({ observer: plan.observer, controlledState })
    if (!result.hardGates.accepted) stop('BLOCKED', 'CONTRACT_SIMULATION_HARD_GATES_FAILED')
    result.status = 'CONTRACT_SIMULATION_ONLY'
    result.reason = 'CONTRACT_SIMULATION_NO_GOVERNANCE'
  } catch (error) {
    if (error instanceof ContractSimulationStop) {
      result.status = error.status
      result.reason = error.reason
    } else {
      result.status = 'BLOCKED'
      result.reason = errorCode(error, 'CONTRACT_SIMULATION_BLOCKED')
    }
    stateTrace.push('CONTRACT_SIMULATION_STOPPED')
  } finally {
    try { plan?.subscription?.close() } catch { result.cleanupError = 'SESSION_SUBSCRIPTION_CLOSE_FAILED' }
    if (runtime !== undefined) {
      try { await runtime.close() } catch { result.cleanupError = 'CONTRACT_SIMULATION_RUNTIME_CLOSE_FAILED' }
    }
    if (result.cleanupError !== undefined && result.status === 'CONTRACT_SIMULATION_ONLY') {
      result.status = 'BLOCKED'
      result.reason = 'CONTRACT_SIMULATION_CLEANUP_FAILED'
    }
  }

  result.evidencePath = await writeBoundedEvidence(ownedLayout, result)
  return result
}

export function publicResult(result) {
  return {
    status: result.status,
    reason: result.reason,
    mode: result.mode,
    runId: result.runId,
    featureId: result.featureId,
    requestedProviderAlias: result.requestedProviderAlias,
    requestedModel: result.requestedModel,
    effectiveProvider: result.effectiveProvider,
    effectiveModel: result.effectiveModel,
    noProviderCall: result.noProviderCall,
    providerCalls: result.providerCalls,
    promptInvocations: result.promptInvocations,
    providerCallObserved: result.providerCallObserved,
    providerCallObservation: result.providerCallObservation,
    providerOutcome: result.providerOutcome,
    providerOpportunityConsumed: result.providerOpportunityConsumed,
    providerBoundaryCounter: result.providerBoundaryCounter,
    productContext: result.productContext,
    contextFailureCode: result.contextFailureCode,
    providerOpportunity: result.providerOpportunity,
    opportunityLedger: result.opportunityLedger,
    routeEvidence: result.routeEvidence,
    stateTrace: result.stateTrace,
    preflight: result.preflight,
    overlay: result.overlay,
    productStage: publicStageResult(result.productStage),
    compositionProbe: result.compositionProbe,
    attemptEvidence: result.attemptEvidence,
    governance: result.governance,
    hardGates: result.hardGates,
    evidencePath: result.evidencePath,
  }
}

export const RUNNER_USAGE = [
  'keyless: node scripts/e2e/real-dsh-provider-v10.mjs --provider-alias <explicit-alias> --model <explicit-model> [--no-product-stage] [--runner-root <fresh-empty-root>]',
  'contract simulation (API-only): runContractSimulation({ simulationOptIn: true, ... }) with an explicit high-level runtimeFactory; synthetic events and temporary ledger evidence never produce governance or GOV_DONE.',
  'real-attempt (explicit opt-in; Product bootstrap required): node scripts/e2e/real-dsh-provider-v10.mjs --mode real-attempt --confirm-real-attempt --provider-alias <explicit-alias> --model <explicit-model> --requirement <bounded-non-sensitive-requirement>',
  `real-attempt precondition: Product must provide serialized environment/bootstrap in ${PRODUCT_BROKER_SERIALIZED_ENV}; the package-root connector must return an ACQUIRED/INTENDED/STARTING/EXECUTING bounded view before any Provider opportunity.`,
].join('\n')

async function main() {
  try {
    const options = parseRunnerArgs(process.argv.slice(2))
    if (options.help) {
      process.stdout.write(`${RUNNER_USAGE}\n`)
      return
    }
    const result = options.mode === 'real-attempt'
      ? await runRealAttemptBranch({
          optIn: options.confirmRealAttempt,
          providerAlias: options.providerAlias,
          model: options.model,
          requirement: options.requirement,
          runnerRoot: options.runnerRoot,
        })
      : await runNoProviderDryRun({
          providerAlias: options.providerAlias,
          model: options.model,
          runnerRoot: options.runnerRoot,
          prepareProductStage: !options.skipProductStage,
        })
    process.stdout.write(`${JSON.stringify(publicResult(result))}\n`)
    process.exitCode = result.status === 'RUNNER_SCOPED_READY' ? 0 : 2
  } catch (error) {
    process.stderr.write(`RUNNER_BLOCKED ${errorCode(error)}\n`)
    process.exitCode = 2
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
