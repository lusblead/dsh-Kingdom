/**
 * Product-child RunnerContext broker.
 *
 * The public launch surface deliberately knows only about a run-local
 * rendezvous directory.  Governance identity, Store objects, RunnerContext
 * handles, and versions stay inside the Product child.  The wire is a bounded
 * observation channel; it is not a second dispatch or settlement API.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { basename, dirname, isAbsolute, join, normalize, parse, relative, resolve } from 'node:path'
import type {
  RunnerContextHandle,
  RunnerContextPort,
  RunnerContextVersion,
  RunnerContextView,
} from './core/governed.js'

const PROTOCOL = 'dsh-kingdom-runner-broker/v1'
const MAX_FRAME_BYTES = 16 * 1024
const MAX_OBSERVATION_BYTES = 2 * 1024
const MAX_REQUEST_ID = 128
const MAX_TICKET = 128
const MAX_JSON_DEPTH = 4
const WIRE_PHASES = new Set(['OPEN', 'ACQUIRED', 'BOUND', 'TERMINAL', 'RECOVERING', 'RELEASED', 'UNAVAILABLE'])
const DISPATCH_STATES = new Set(['INTENDED', 'DISPATCHED', 'RECEIVED', 'CORRELATED', 'TERMINAL', 'RECOVERING', 'UNKNOWN'])
const EXECUTION_STATES = new Set(['STARTING', 'RUNNING', 'COMPLETED', 'FAILED', 'ABORTED', 'RECOVERING', 'UNKNOWN'])
const LEASE_STATES = new Set(['ACQUIRED', 'PREPARING', 'MATERIALIZING', 'DISPATCH_READY', 'EXECUTING', 'SETTLING', 'RELEASING', 'RELEASED', 'RECOVERING', 'UNKNOWN'])
const CLEANUP_STATUSES = new Set(['CONFIRMED', 'RETURNED_FALSE', 'THREW', 'MISSING_EVIDENCE', 'UNKNOWN'])
const ENVIRONMENT_KEYS = [
  'DSH_KINGDOM_BROKER_REQUIRED',
  'DSH_KINGDOM_BROKER_RENDEZVOUS_DIR',
  'DSH_KINGDOM_BROKER_LAUNCH_NONCE',
] as const
const DESCRIPTOR_KEYS = ['protocol', 'serverInstance', 'endpoint', 'createdAt'] as const
const CONNECTOR_BOOTSTRAP_KEYS = ['environment', 'descriptor'] as const
const MAX_DESCRIPTOR_BYTES = 2 * 1024
const PRODUCT_NONCE = /^[A-Za-z0-9_-]{43}$/u
const SERVER_INSTANCE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const METHODS = [
  'server.hello',
  'client.auth',
  'server.ready',
  'context.wait',
  'context.snapshot',
  'context.read',
  'runtime.observe',
  'broker.close',
] as const

type BrokerMethod = (typeof METHODS)[number]
type ClientRequestMethod = 'context.wait' | 'context.snapshot' | 'context.read' | 'runtime.observe' | 'broker.close'

export interface RunnerContextBrokerLaunchOptions {
  readonly runRoot: string
}

export interface RunnerContextBrokerEnvironment {
  readonly DSH_KINGDOM_BROKER_REQUIRED: '1'
  readonly DSH_KINGDOM_BROKER_RENDEZVOUS_DIR: string
  readonly DSH_KINGDOM_BROKER_LAUNCH_NONCE: string
}

export interface RunnerContextBrokerDescriptor {
  readonly protocol: typeof PROTOCOL
  readonly serverInstance: string
  readonly endpoint: string
  readonly createdAt: string
}

/** Serialized Product-issued bootstrap; it contains transport bootstrap only. */
export interface RunnerContextBrokerConnectionBootstrap {
  readonly environment: RunnerContextBrokerEnvironment
  readonly descriptor: RunnerContextBrokerDescriptor
}

export type RunnerContextBrokerConnectorInput =
  | RunnerContextBrokerEnvironment
  | RunnerContextBrokerConnectionBootstrap

export interface RunnerContextBrokerWireView {
  readonly phase: string
  readonly revision: number
  readonly dispatchState: string
  readonly executionState: string
  readonly leaseState: string
  readonly receiptObserved: boolean
  readonly correlated: boolean
  readonly terminalObserved: boolean
  readonly cleanupStatus: string | null
  readonly claimRecorded: boolean
}

export interface RunnerContextBrokerObservation {
  readonly phase?: string
  readonly revision?: number
  readonly dispatchState?: string
  readonly executionState?: string
  readonly leaseState?: string
  readonly receiptObserved?: boolean
  readonly correlated?: boolean
  readonly terminalObserved?: boolean
  readonly cleanupStatus?: string | null
  readonly claimRecorded?: boolean
}

export interface RunnerContextBrokerClient {
  readonly wait: () => Promise<RunnerContextBrokerWireView>
  readonly snapshot: () => Promise<RunnerContextBrokerWireView>
  readonly read: () => Promise<RunnerContextBrokerWireView>
  readonly observe: (observation: RunnerContextBrokerObservation) => Promise<{ readonly accepted: true }>
  readonly close: () => Promise<void>
}

/** Public launch object: no Store, governance ID, handle, version, or port. */
export interface RunnerContextBrokerLaunch {
  readonly childEnvironment: () => RunnerContextBrokerEnvironment
  readonly connect: () => Promise<RunnerContextBrokerClient>
  readonly close: () => Promise<void>
}

export interface RunnerContextBrokerCleanupReceipt {
  readonly status: 'CONFIRMED'
  readonly closeExecutions: 1
  readonly activeConnections: 0
  readonly activeRegistrations: 0
  readonly activeServers: 0
  readonly descriptorStatus: 'ABSENT'
  readonly endpointStatus: 'ABSENT' | 'NOT_APPLICABLE'
}

/** Additive Product-owned facade; transport bootstrap and cleanup only. */
export interface RunnerContextBrokerProductLifecycle {
  readonly bootstrap: () => Promise<RunnerContextBrokerConnectionBootstrap>
  readonly close: () => Promise<RunnerContextBrokerCleanupReceipt>
}

export class RunnerContextBrokerError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(`RunnerContextBroker ${code}: ${message}`)
    this.name = 'RunnerContextBrokerError'
    this.code = code
  }
}

interface BrokerRegistration {
  readonly port: RunnerContextPort
  readonly handle: RunnerContextHandle
  version: RunnerContextVersion
  readonly ticket: string
  revision: number
  connection: Socket | null
  revoked: boolean
}

interface CachedResponse {
  readonly digest: string
  readonly line: string
}

interface ServerConnectionState {
  readonly socket: Socket
  readonly challenge: string
  readonly serverInstance: string
  authenticated: boolean
  clientNonce: string | null
  registration: BrokerRegistration | null
  buffer: Buffer
  cache: Map<string, CachedResponse>
  inFlight: boolean
  closed: boolean
}

interface LaunchState {
  readonly runRoot: string
  readonly rendezvousDir: string
  readonly descriptorPath: string
  readonly endpoint: string
  readonly launchNonce: string
  readonly serverInstance: string
  readonly environment: RunnerContextBrokerEnvironment
  readonly descriptorCreated: Promise<void>
  server: Server | null
  connection: ServerConnectionState | null
  registration: BrokerRegistration | null
  registrationConsumed: boolean
  closed: boolean
  startError: unknown | null
  ready: Promise<void>
}

const launchStates = new WeakMap<object, LaunchState>()
const activeLaunches = new Set<RunnerContextBrokerLaunch>()
const productPorts = new Map<string, RunnerContextPort>()
let activeProductLaunch: RunnerContextBrokerLaunch | null = null

function protocolError(code: string, message: string): never {
  throw new RunnerContextBrokerError(code, message)
}

function boundedToken(value: unknown, label: string, max = MAX_TICKET): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max
    || value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
    protocolError('INVALID_INPUT', `${label} 必须是 bounded token`)
  }
  return value
}

function boundedRequestId(value: unknown): string {
  return boundedToken(value, 'requestId', MAX_REQUEST_ID)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStrictPlainObject(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && Object.getPrototypeOf(value) === Object.prototype
}

function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...allowed].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    protocolError('INVALID_BOOTSTRAP', `${label} 字段集合不匹配`)
  }
}

function productRendezvousDir(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024
    || !isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    protocolError('INVALID_BOOTSTRAP', 'rendezvous directory 必须是 bounded absolute path')
  }
  const resolved = resolve(value)
  const parent = dirname(resolved)
  const runRoot = dirname(parent)
  if (resolved !== normalize(value)
    || basename(resolved) !== 'runner-context-broker'
    || basename(parent) !== '.local'
    || runRoot === parse(runRoot).root) {
    protocolError('INVALID_BOOTSTRAP', 'rendezvous directory 不是 Product broker 目录')
  }
  return resolved
}

function productLaunchNonce(value: unknown): string {
  const token = boundedToken(value, 'launchNonce', 64)
  if (!PRODUCT_NONCE.test(token)) protocolError('INVALID_BOOTSTRAP', 'launchNonce 不是 Product-issued nonce')
  return token
}

function validateEnvironment(value: unknown): RunnerContextBrokerEnvironment {
  if (!isStrictPlainObject(value)) protocolError('INVALID_BOOTSTRAP', 'environment 必须是 plain object')
  requireExactKeys(value, ENVIRONMENT_KEYS, 'environment')
  if (value.DSH_KINGDOM_BROKER_REQUIRED !== '1') {
    protocolError('INVALID_BOOTSTRAP', 'environment required flag 不匹配')
  }
  const environment: RunnerContextBrokerEnvironment = {
    DSH_KINGDOM_BROKER_REQUIRED: '1',
    DSH_KINGDOM_BROKER_RENDEZVOUS_DIR: productRendezvousDir(value.DSH_KINGDOM_BROKER_RENDEZVOUS_DIR),
    DSH_KINGDOM_BROKER_LAUNCH_NONCE: productLaunchNonce(value.DSH_KINGDOM_BROKER_LAUNCH_NONCE),
  }
  return Object.freeze(environment)
}

function jsonDepth(value: unknown, depth = 0): number {
  if (depth > MAX_JSON_DEPTH) return depth
  if (Array.isArray(value)) return Math.max(depth, ...value.map(item => jsonDepth(item, depth + 1)))
  if (isPlainObject(value)) return Math.max(depth, ...Object.values(value).map(item => jsonDepth(item, depth + 1)))
  return depth
}

function hasControlText(value: unknown): boolean {
  if (typeof value === 'string') return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  if (Array.isArray(value)) return value.some(hasControlText)
  if (isPlainObject(value)) return Object.entries(value).some(([key, item]) => hasControlText(key) || hasControlText(item))
  return false
}

function boundedWireState(value: unknown, label: string, allowed: ReadonlySet<string>): void {
  if (typeof value !== 'string' || value.length > 32 || !allowed.has(value)) {
    protocolError('INVALID_OBSERVATION', `${label} 不是允许的 bounded broker state`)
  }
}

function validateObservation(value: unknown): asserts value is RunnerContextBrokerObservation {
  if (!isPlainObject(value)) protocolError('INVALID_OBSERVATION', 'runtime.observe observation 必须是 object')
  const allowed = new Set([
    'phase', 'revision', 'dispatchState', 'executionState', 'leaseState',
    'receiptObserved', 'correlated', 'terminalObserved', 'cleanupStatus', 'claimRecorded',
  ])
  if (Object.keys(value).some(key => !allowed.has(key))) {
    protocolError('UNKNOWN_FIELD', 'runtime.observe 不得包含治理/Runtime身份字段')
  }
  if (value.phase !== undefined) boundedWireState(value.phase, 'phase', WIRE_PHASES)
  if (value.dispatchState !== undefined) boundedWireState(value.dispatchState, 'dispatchState', DISPATCH_STATES)
  if (value.executionState !== undefined) boundedWireState(value.executionState, 'executionState', EXECUTION_STATES)
  if (value.leaseState !== undefined) boundedWireState(value.leaseState, 'leaseState', LEASE_STATES)
  if (value.cleanupStatus !== undefined && value.cleanupStatus !== null) {
    boundedWireState(value.cleanupStatus, 'cleanupStatus', CLEANUP_STATUSES)
  }
  for (const key of ['receiptObserved', 'correlated', 'terminalObserved', 'claimRecorded']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      protocolError('INVALID_OBSERVATION', `${key} 必须是 boolean`)
    }
  }
  if (value.revision !== undefined
    && (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0)) {
    protocolError('INVALID_OBSERVATION', 'revision 必须是 non-negative safe integer')
  }
}

function parseFrame(line: Buffer): Record<string, unknown> {
  if (line.length > MAX_FRAME_BYTES) protocolError('FRAME_TOO_LARGE', `NDJSON frame 超过 ${MAX_FRAME_BYTES} bytes`)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(line)
  } catch {
    protocolError('INVALID_UTF8', 'NDJSON frame 不是合法 UTF-8')
  }
  if (/\r|\n/u.test(text)) protocolError('INVALID_FRAME', '单帧不得含嵌入换行')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    protocolError('INVALID_JSON', 'NDJSON frame 不是合法 JSON object')
  }
  if (!isPlainObject(parsed)) protocolError('INVALID_JSON', 'NDJSON 顶层必须是 object')
  if (Object.keys(parsed).length > 16) protocolError('TOO_MANY_FIELDS', 'NDJSON 顶层字段不得超过 16 个')
  if (jsonDepth(parsed) > MAX_JSON_DEPTH) protocolError('TOO_DEEP', `NDJSON 深度不得超过 ${MAX_JSON_DEPTH}`)
  if (hasControlText(parsed)) protocolError('CONTROL_DATA', 'NDJSON 不接受控制字符')
  return parsed
}

function digestPayload(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function hmac(key: string, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('base64url')
}

function equalProof(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string') return false
  const left = Buffer.from(expected)
  const right = Buffer.from(actual)
  return left.length === right.length && timingSafeEqual(left, right)
}

function jsonLine(value: Record<string, unknown>): string {
  const line = `${JSON.stringify(value)}\n`
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
    protocolError('FRAME_TOO_LARGE', 'response frame 超过 16KiB')
  }
  return line
}

function send(socket: Socket, value: Record<string, unknown>): string {
  const line = jsonLine(value)
  if (!socket.write(line, 'utf8')) {
    socket.destroy(new RunnerContextBrokerError('BACKPRESSURE', 'broker socket backpressure 超出 bounded window'))
  }
  return line
}

function parseAllowed(value: Record<string, unknown>, allowed: readonly string[]): void {
  const set = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!set.has(key)) protocolError('UNKNOWN_FIELD', `method=${String(value.type)} 不允许字段 ${key}`)
  }
}

function parseMethod(value: Record<string, unknown>): BrokerMethod {
  if (typeof value.type !== 'string' || !(METHODS as readonly string[]).includes(value.type)) {
    protocolError('UNKNOWN_METHOD', `不支持的 broker method ${String(value.type)}`)
  }
  return value.type as BrokerMethod
}

function safeRunRoot(runRoot: string): string {
  if (typeof runRoot !== 'string' || !isAbsolute(runRoot)) {
    throw new RunnerContextBrokerError('UNSAFE_RENDEZVOUS', 'runRoot 必须是绝对路径')
  }
  const resolved = resolve(runRoot)
  const parsed = parse(resolved)
  if (resolved === parsed.root || /[\u0000-\u001f\u007f]/u.test(resolved)) {
    throw new RunnerContextBrokerError('UNSAFE_RENDEZVOUS', 'runRoot 不能是文件系统根或含控制字符')
  }
  return resolved
}

async function assertDirectoryPath(path: string, create: boolean): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new RunnerContextBrokerError('UNSAFE_RENDEZVOUS', `rendezvous path 不是安全目录: ${path}`)
  }
  try {
    const actual = await realpath(path)
    if (normalize(actual) !== normalize(path)) {
      throw new RunnerContextBrokerError('UNSAFE_RENDEZVOUS', `rendezvous path 是 reparse/symlink: ${path}`)
    }
  } catch (error: unknown) {
    if (error instanceof RunnerContextBrokerError) throw error
    throw new RunnerContextBrokerError('UNSAFE_RENDEZVOUS', `无法验证 rendezvous path: ${path}`)
  }
}

async function descriptorExists(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) throw new RunnerContextBrokerError('STALE_RENDEZVOUS', `拒绝复用 descriptor symlink: ${path}`)
    return true
  } catch (error: unknown) {
    if (error instanceof RunnerContextBrokerError) throw error
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') return false
    throw error
  }
}

async function pathAbsent(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return false
  } catch (error: unknown) {
    return (error as { code?: string }).code === 'ENOENT'
  }
}

function expectedEndpoint(rendezvousDir: string, launchNonce: string): string {
  const runRoot = dirname(dirname(rendezvousDir))
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\dsh-kingdom-broker-${createHash('sha256').update(runRoot).digest('hex').slice(0, 24)}-${launchNonce.slice(0, 12)}`
    : join(rendezvousDir, `${launchNonce}.sock`)
}

function descriptorPathFor(environment: RunnerContextBrokerEnvironment): string {
  return join(
    environment.DSH_KINGDOM_BROKER_RENDEZVOUS_DIR,
    `${environment.DSH_KINGDOM_BROKER_LAUNCH_NONCE}.json`,
  )
}

function validateDescriptor(value: unknown, environment: RunnerContextBrokerEnvironment): RunnerContextBrokerDescriptor {
  if (!isStrictPlainObject(value)) protocolError('INVALID_DESCRIPTOR', 'descriptor 必须是 plain object')
  requireExactKeys(value, DESCRIPTOR_KEYS, 'descriptor')
  if (value.protocol !== PROTOCOL) protocolError('FOREIGN_DESCRIPTOR', 'descriptor protocol 不匹配')
  const serverInstance = boundedToken(value.serverInstance, 'serverInstance', 128)
  if (!SERVER_INSTANCE.test(serverInstance)) protocolError('INVALID_DESCRIPTOR', 'serverInstance 不是 Product instance')
  const endpoint = boundedToken(value.endpoint, 'endpoint', 1024)
  if (endpoint !== expectedEndpoint(
    environment.DSH_KINGDOM_BROKER_RENDEZVOUS_DIR,
    environment.DSH_KINGDOM_BROKER_LAUNCH_NONCE,
  )) {
    protocolError('FOREIGN_DESCRIPTOR', 'descriptor endpoint 不属于该 Product environment')
  }
  const createdAt = boundedToken(value.createdAt, 'createdAt', 64)
  if (!Number.isFinite(Date.parse(createdAt))) protocolError('INVALID_DESCRIPTOR', 'descriptor createdAt 无效')
  return Object.freeze({
    protocol: PROTOCOL,
    serverInstance,
    endpoint,
    createdAt,
  })
}

async function readProductDescriptor(
  environment: RunnerContextBrokerEnvironment,
): Promise<RunnerContextBrokerDescriptor> {
  await assertDirectoryPath(environment.DSH_KINGDOM_BROKER_RENDEZVOUS_DIR, false)
  const path = descriptorPathFor(environment)
  let stat
  try {
    stat = await lstat(path)
  } catch (error: unknown) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') protocolError('RENDEZVOUS_NOT_FOUND', 'Product broker descriptor 不存在')
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DESCRIPTOR_BYTES) {
    protocolError('STALE_RENDEZVOUS', '拒绝非 Product-owned 或超限 descriptor')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    protocolError('INVALID_DESCRIPTOR', 'descriptor 不是合法 JSON')
  }
  return validateDescriptor(parsed, environment)
}

function sameDescriptor(left: RunnerContextBrokerDescriptor, right: RunnerContextBrokerDescriptor): boolean {
  return left.protocol === right.protocol
    && left.serverInstance === right.serverInstance
    && left.endpoint === right.endpoint
    && left.createdAt === right.createdAt
}

async function resolveConnectorTarget(input: RunnerContextBrokerConnectorInput): Promise<{
  readonly launchNonce: string
  readonly serverInstance: string
  readonly endpoint: string
}> {
  if (!isStrictPlainObject(input)) protocolError('INVALID_BOOTSTRAP', 'connector input 必须是 plain object')

  let environment: RunnerContextBrokerEnvironment
  let suppliedDescriptor: RunnerContextBrokerDescriptor | null = null
  const keys = Object.keys(input)
  if (keys.length === ENVIRONMENT_KEYS.length && ENVIRONMENT_KEYS.every(key => keys.includes(key))) {
    environment = validateEnvironment(input)
  } else {
    requireExactKeys(input, CONNECTOR_BOOTSTRAP_KEYS, 'connector bootstrap')
    environment = validateEnvironment(input.environment)
    suppliedDescriptor = validateDescriptor(input.descriptor, environment)
  }

  const descriptor = await readProductDescriptor(environment)
  if (suppliedDescriptor && !sameDescriptor(suppliedDescriptor, descriptor)) {
    protocolError('FOREIGN_DESCRIPTOR', 'serialized descriptor 与 Product-owned descriptor 不一致')
  }
  return {
    launchNonce: environment.DSH_KINGDOM_BROKER_LAUNCH_NONCE,
    serverInstance: descriptor.serverInstance,
    endpoint: descriptor.endpoint,
  }
}

async function removeOwnedDescriptor(state: LaunchState): Promise<void> {
  try {
    const stat = await lstat(state.descriptorPath)
    if (!stat.isFile() || stat.isSymbolicLink()) return
    const descriptor = JSON.parse(await readFile(state.descriptorPath, 'utf8')) as Record<string, unknown>
    if (descriptor.protocol !== PROTOCOL
      || descriptor.serverInstance !== state.serverInstance
      || descriptor.endpoint !== state.endpoint) return
    await rm(state.descriptorPath, { force: true })
  } catch (error: unknown) {
    const code = (error as { code?: string }).code
    if (code !== 'ENOENT') return
  }
}

function viewForBroker(view: RunnerContextView, revision: number): RunnerContextBrokerWireView {
  const dispatchState = view.dispatchState
  const executionState = view.executionState
  return Object.freeze({
    phase: view.phase,
    revision,
    dispatchState,
    executionState,
    leaseState: view.leaseState,
    receiptObserved: ['RECEIVED', 'CORRELATED', 'TERMINAL'].includes(dispatchState),
    correlated: ['CORRELATED', 'TERMINAL'].includes(dispatchState),
    terminalObserved: dispatchState === 'TERMINAL' || ['COMPLETED', 'FAILED', 'ABORTED'].includes(executionState),
    cleanupStatus: null,
    claimRecorded: false,
  })
}

function registrationAvailable(state: LaunchState): BrokerRegistration | null {
  const registration = state.registration
  if (!registration || registration.revoked) return null
  if (registration.port.currentPhase === 'RELEASED' || registration.port.currentPhase === 'RECOVERING') {
    registration.revoked = true
    state.registration = null
    return null
  }
  return registration
}

function revokeRegistration(state: LaunchState, reason: string): void {
  const registration = state.registration
  if (registration) {
    registration.revoked = true
    state.registration = null
  }
  if (state.connection?.registration) state.connection.registration = null
  if (state.connection && !state.connection.closed) {
    state.connection.closed = true
    state.connection.socket.destroy(new RunnerContextBrokerError('REVOKED', reason))
  }
}

function closeConnection(state: LaunchState, connection: ServerConnectionState): void {
  if (connection.closed) return
  connection.closed = true
  if (state.connection === connection) state.connection = null
  const registration = connection.registration
  if (registration && registration.connection === connection.socket) {
    registration.connection = null
    registration.revoked = true
    if (state.registration === registration) state.registration = null
  }
  connection.socket.destroy()
}

function connectionView(state: LaunchState, registration: BrokerRegistration): RunnerContextBrokerWireView {
  try {
    const view = registration.port.brokerSnapshot()
    return viewForBroker(view, registration.revision)
  } catch (error: unknown) {
    registration.revoked = true
    state.registration = null
    throw error
  }
}

function requestRevision(value: Record<string, unknown>, registration: BrokerRegistration): void {
  if (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision)
    || value.revision !== registration.revision) {
    protocolError('STALE_REVISION', 'caller 必须提供当前 broker 内部 revision')
  }
}

function requestTicket(value: Record<string, unknown>, registration: BrokerRegistration): void {
  if (value.ticket !== registration.ticket) protocolError('FOREIGN_TICKET', 'ticket 不属于当前 authenticated connection/context')
}

function wireRequestResponse(
  state: LaunchState,
  connection: ServerConnectionState,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const method = parseMethod(value)
  if (method === 'client.auth' || method === 'server.hello' || method === 'server.ready') {
    protocolError('INVALID_ORDER', `${method} 不是 client request`)
  }
  const requestId = boundedRequestId(value.requestId)
  const registration = connection.registration ?? registrationAvailable(state)
  if (!registration) protocolError('CONTEXT_UNAVAILABLE', '当前没有可用的 Product RunnerContext')
  requestTicket(value, registration)
  requestRevision(value, registration)

  if (method === 'runtime.observe') {
    parseAllowed(value, ['type', 'requestId', 'ticket', 'revision', 'observation'])
    const observation = value.observation
    const serialized = JSON.stringify(observation)
    if (serialized === undefined) protocolError('INVALID_OBSERVATION', 'runtime.observe observation 必须可序列化')
    if (Buffer.byteLength(serialized, 'utf8') > MAX_OBSERVATION_BYTES || jsonDepth(observation) > MAX_JSON_DEPTH) {
      protocolError('OBSERVATION_TOO_LARGE', 'runtime.observe 必须是 bounded non-authoritative observation')
    }
    validateObservation(observation)
    if (hasControlText(observation)) protocolError('CONTROL_DATA', 'runtime.observe 含控制字符')
    return { type: 'runtime.observe', requestId, ok: true, accepted: true }
  }

  if (method === 'broker.close') {
    parseAllowed(value, ['type', 'requestId', 'ticket', 'revision'])
    return { type: 'broker.close', requestId, ok: true }
  }

  parseAllowed(value, ['type', 'requestId', 'ticket', 'revision'])
  const nextRevision = registration.revision + 1
  if (!Number.isSafeInteger(nextRevision)) protocolError('REVISION_OVERFLOW', 'broker revision overflow')
  registration.revision = nextRevision
  const view = connectionView(state, registration)
  return { type: 'context.snapshot', requestId, ok: true, view: { ...view, revision: nextRevision } }
}

function handleFrame(state: LaunchState, connection: ServerConnectionState, line: Buffer): void {
  const value = parseFrame(line)
  const method = parseMethod(value)
  if (!connection.authenticated) {
    parseAllowed(value, ['type', 'clientNonce', 'proof'])
    if (method !== 'client.auth') protocolError('INVALID_ORDER', '认证前只接受 client.auth')
    const clientNonce = boundedToken(value.clientNonce, 'clientNonce', 256)
    const expected = hmac(state.launchNonce, `${PROTOCOL}|${connection.serverInstance}|${connection.challenge}|${clientNonce}`)
    if (!equalProof(expected, value.proof)) protocolError('AUTH_FAILED', 'client proof 不匹配')
    if (state.connection && state.connection !== connection) protocolError('SECOND_CONNECTION', 'broker 只允许一个 authenticated connection')
    const registration = registrationAvailable(state)
    connection.authenticated = true
    connection.clientNonce = clientNonce
    connection.registration = registration
    state.connection = connection
    if (registration) registration.connection = connection.socket
    const serverProof = hmac(state.launchNonce, `server|${PROTOCOL}|${connection.serverInstance}|${connection.challenge}|${clientNonce}`)
    const view = registration ? connectionView(state, registration) : null
    send(connection.socket, {
      type: 'server.ready',
      serverProof,
      ticket: registration?.ticket ?? null,
      view,
    })
    return
  }

  // Revalidate the owned Product context before consulting the replay cache.
  // A cached response is not permission to reuse a ticket after the port has
  // entered RECOVERING/RELEASED or the registration has been revoked.
  const activeRegistration = registrationAvailable(state)
  if (!activeRegistration || connection.registration !== activeRegistration) {
    closeConnection(state, connection)
    return
  }
  const requestId = boundedRequestId(value.requestId)
  const digest = digestPayload(value)
  const cached = connection.cache.get(requestId)
  if (cached) {
    if (cached.digest !== digest) protocolError('REQUEST_REPLAY', '同一 requestId 的 payload 不一致')
    connection.socket.write(cached.line, 'utf8')
    return
  }
  if (connection.inFlight) protocolError('IN_FLIGHT', '单 ticket 只接受 FIFO 单 in-flight request')
  connection.inFlight = true
  try {
    const response = wireRequestResponse(state, connection, value)
    const lineOut = jsonLine(response)
    connection.cache.set(requestId, { digest, line: lineOut })
    if (!connection.socket.write(lineOut, 'utf8')) {
      protocolError('BACKPRESSURE', 'broker socket backpressure 超出 bounded window')
    }
    if (method === 'broker.close') closeConnection(state, connection)
  } finally {
    connection.inFlight = false
  }
}

function attachServerConnection(state: LaunchState, socket: Socket): void {
  const connection: ServerConnectionState = {
    socket,
    challenge: randomBytes(32).toString('base64url'),
    serverInstance: state.serverInstance,
    authenticated: false,
    clientNonce: null,
    registration: null,
    buffer: Buffer.alloc(0),
    cache: new Map(),
    inFlight: false,
    closed: false,
  }
  if (state.connection && state.connection.authenticated) {
    // No response is an intentional fail-closed rejection.  Do not pass an
    // Error object to destroy before this socket has an error listener: that
    // would turn a protocol rejection into an uncaught process exception.
    socket.destroy()
    return
  }
  socket.setNoDelay(true)
  socket.setTimeout(5000, () => closeConnection(state, connection))
  socket.on('error', () => closeConnection(state, connection))
  socket.on('end', () => closeConnection(state, connection))
  socket.on('close', () => closeConnection(state, connection))
  socket.on('data', (chunk: Buffer) => {
    if (connection.closed) return
    connection.buffer = Buffer.concat([connection.buffer, chunk])
    if (connection.buffer.length > MAX_FRAME_BYTES) {
      closeConnection(state, connection)
      return
    }
    while (true) {
      const newline = connection.buffer.indexOf(0x0a)
      if (newline < 0) break
      const frame = connection.buffer.subarray(0, newline)
      connection.buffer = connection.buffer.subarray(newline + 1)
      try {
        handleFrame(state, connection, frame[frame.length - 1] === 0x0d ? frame.subarray(0, frame.length - 1) : frame)
      } catch (error: unknown) {
        closeConnection(state, connection)
        return
      }
      // A single socket is deliberately FIFO and single in-flight.  A second
      // pipelined frame cannot be proven to have observed the first ACK.
      if (connection.buffer.length > 0) {
        closeConnection(state, connection)
        return
      }
    }
  })
  send(socket, {
    type: 'server.hello',
    protocol: PROTOCOL,
    serverInstance: state.serverInstance,
    challenge: connection.challenge,
    methods: METHODS,
    maxFrame: MAX_FRAME_BYTES,
  })
}

async function startServer(state: LaunchState): Promise<void> {
  await assertDirectoryPath(state.runRoot, true)
  await assertDirectoryPath(dirname(state.rendezvousDir), true)
  await assertDirectoryPath(state.rendezvousDir, true)
  if (await descriptorExists(state.descriptorPath)) {
    throw new RunnerContextBrokerError('STALE_RENDEZVOUS', `拒绝覆盖既有 rendezvous descriptor: ${state.descriptorPath}`)
  }
  const descriptor = JSON.stringify({
    protocol: PROTOCOL,
    serverInstance: state.serverInstance,
    endpoint: state.endpoint,
    createdAt: new Date().toISOString(),
  })
  await writeFile(state.descriptorPath, `${descriptor}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      if (state.closed) {
        rejectReady(new RunnerContextBrokerError('CLOSED', 'broker 在 listen 前已关闭'))
        return
      }
      const server = createServer(socket => attachServerConnection(state, socket))
      state.server = server
      server.once('error', rejectReady)
      server.listen(state.endpoint, () => {
        server.removeListener('error', rejectReady)
        resolveReady()
      })
    })
  } catch (error: unknown) {
    await removeOwnedDescriptor(state)
    // A failed listen may be caused by an unrelated stale Unix socket.  Do
    // not unlink an endpoint unless this launch has proved ownership of it.
    throw error
  }
}

function wireUnavailable(): RunnerContextBrokerWireView {
  return Object.freeze({
    phase: 'UNAVAILABLE',
    revision: 0,
    dispatchState: 'UNKNOWN',
    executionState: 'UNKNOWN',
    leaseState: 'UNKNOWN',
    receiptObserved: false,
    correlated: false,
    terminalObserved: false,
    cleanupStatus: null,
    claimRecorded: false,
  })
}

function clientFrame(socket: Socket, value: Record<string, unknown>): Promise<Record<string, unknown>> {
  const line = jsonLine(value)
  return new Promise((resolveResponse, rejectResponse) => {
    let buffer = Buffer.alloc(0)
    const onError = (error: Error): void => {
      cleanup()
      rejectResponse(error)
    }
    const onClose = (): void => {
      cleanup()
      rejectResponse(new RunnerContextBrokerError('DISCONNECTED', 'broker connection disconnected'))
    }
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_FRAME_BYTES) {
        cleanup()
        rejectResponse(new RunnerContextBrokerError('FRAME_TOO_LARGE', 'response frame too large'))
        return
      }
      const newline = buffer.indexOf(0x0a)
      if (newline < 0) return
      const frame = buffer.subarray(0, newline)
      cleanup()
      try {
        resolveResponse(parseFrame(frame[frame.length - 1] === 0x0d ? frame.subarray(0, frame.length - 1) : frame))
      } catch (error: unknown) {
        rejectResponse(error)
      }
    }
    const cleanup = (): void => {
      socket.off('error', onError)
      socket.off('close', onClose)
      socket.off('data', onData)
    }
    socket.on('error', onError)
    socket.on('close', onClose)
    socket.on('data', onData)
    socket.write(line, 'utf8')
  })
}

async function openBrokerSocket(endpoint: string): Promise<Socket> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      return await new Promise<Socket>((resolveSocket, rejectSocket) => {
        const connection = createConnection(endpoint)
        const onError = (error: Error): void => {
          connection.destroy()
          rejectSocket(error)
        }
        connection.once('error', onError)
        connection.once('connect', () => {
          connection.off('error', onError)
          connection.setNoDelay(true)
          connection.setTimeout(5000, () => connection.destroy(new RunnerContextBrokerError('TIMEOUT', 'broker response timeout')))
          resolveSocket(connection)
        })
      })
    } catch (error: unknown) {
      lastError = error
      const code = (error as { code?: string }).code
      if (!['ECONNREFUSED', 'ENOENT', 'ENOTFOUND'].includes(code ?? '') || attempt === 39) throw error
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  throw new RunnerContextBrokerError('CONNECT_FAILED', String(lastError ?? 'broker endpoint unavailable'))
}

async function connectClientTarget(target: {
  readonly endpoint: string
  readonly serverInstance: string
  readonly launchNonce: string
}): Promise<RunnerContextBrokerClient> {
  const socket = await openBrokerSocket(target.endpoint)
  const hello = await readInitialFrame(socket)
  parseAllowed(hello, ['type', 'protocol', 'serverInstance', 'challenge', 'methods', 'maxFrame'])
  if (hello.type !== 'server.hello' || hello.protocol !== PROTOCOL || hello.serverInstance !== target.serverInstance) {
    socket.destroy()
    throw new RunnerContextBrokerError('AUTH_FAILED', 'server hello 不匹配')
  }
  const clientNonce = randomBytes(32).toString('base64url')
  const proof = hmac(target.launchNonce, `${PROTOCOL}|${target.serverInstance}|${String(hello.challenge)}|${clientNonce}`)
  const ready = await clientFrame(socket, { type: 'client.auth', clientNonce, proof })
  parseAllowed(ready, ['type', 'serverProof', 'ticket', 'view'])
  const expectedServerProof = hmac(target.launchNonce, `server|${PROTOCOL}|${target.serverInstance}|${String(hello.challenge)}|${clientNonce}`)
  if (ready.type !== 'server.ready' || !equalProof(expectedServerProof, ready.serverProof)) {
    socket.destroy()
    throw new RunnerContextBrokerError('AUTH_FAILED', 'server proof 不匹配')
  }
  const ticket = ready.ticket
  if (ticket !== null) boundedToken(ticket, 'ticket')
  let revision = isPlainObject(ready.view) && typeof ready.view.revision === 'number'
    && Number.isSafeInteger(ready.view.revision) && ready.view.revision >= 0
    ? ready.view.revision
    : 0
  let requestCounter = 0
  let closed = false
  let inFlight = false
  const nextRequest = (): string => {
    requestCounter += 1
    if (requestCounter > Number.MAX_SAFE_INTEGER) throw new RunnerContextBrokerError('REVISION_OVERFLOW', 'request counter overflow')
    return `client-${requestCounter}-${randomUUID()}`
  }
  const request = async (method: ClientRequestMethod, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    if (closed) throw new RunnerContextBrokerError('CLOSED', 'client 已关闭')
    if (ticket === null) throw new RunnerContextBrokerError('CONTEXT_UNAVAILABLE', '当前没有 Product RunnerContext ticket')
    if (inFlight) throw new RunnerContextBrokerError('IN_FLIGHT', '单 ticket 只接受 FIFO 单 in-flight request')
    inFlight = true
    try {
      const response = await clientFrame(socket, {
        type: method,
        requestId: nextRequest(),
        ticket,
        revision,
        ...extra,
      })
      if (response.ok !== true) throw new RunnerContextBrokerError('REMOTE_REJECTED', String(response.error ?? 'broker rejected request'))
      if (isPlainObject(response.view) && typeof response.view.revision === 'number'
        && Number.isSafeInteger(response.view.revision) && response.view.revision >= 0) {
        revision = response.view.revision
      }
      return response
    } finally {
      inFlight = false
    }
  }
  const snapshot = async (method: 'context.wait' | 'context.snapshot' | 'context.read'): Promise<RunnerContextBrokerWireView> => {
    const response = await request(method)
    if (!isPlainObject(response.view)) throw new RunnerContextBrokerError('INVALID_RESPONSE', 'broker view 缺失')
    return response.view as unknown as RunnerContextBrokerWireView
  }
  return Object.freeze({
    wait: () => snapshot('context.wait'),
    snapshot: () => snapshot('context.snapshot'),
    read: () => snapshot('context.read'),
    observe: async (observation: RunnerContextBrokerObservation) => {
      const response = await request('runtime.observe', { observation })
      if (response.accepted !== true) throw new RunnerContextBrokerError('INVALID_RESPONSE', 'runtime.observe 未被接受')
      return { accepted: true as const }
    },
    close: async () => {
      if (closed) return
      try { await request('broker.close') } finally {
        closed = true
        socket.end()
      }
    },
  })
}

async function connectClient(state: LaunchState): Promise<RunnerContextBrokerClient> {
  await state.ready
  if (state.closed) throw new RunnerContextBrokerError('CLOSED', 'broker 已关闭')
  if (state.startError) throw new RunnerContextBrokerError('START_FAILED', String(state.startError))
  return connectRunnerContextBroker(environmentFor(state))
}

function readInitialFrame(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((resolveFrame, rejectFrame) => {
    let buffer = Buffer.alloc(0)
    const onError = (error: Error): void => { cleanup(); rejectFrame(error) }
    const onClose = (): void => { cleanup(); rejectFrame(new RunnerContextBrokerError('DISCONNECTED', 'broker closed before hello')) }
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      const newline = buffer.indexOf(0x0a)
      if (newline < 0) {
        if (buffer.length > MAX_FRAME_BYTES) {
          cleanup()
          rejectFrame(new RunnerContextBrokerError('FRAME_TOO_LARGE', 'hello too large'))
        }
        return
      }
      const frame = buffer.subarray(0, newline)
      cleanup()
      try { resolveFrame(parseFrame(frame)) } catch (error: unknown) { rejectFrame(error) }
    }
    const cleanup = (): void => {
      socket.off('error', onError)
      socket.off('close', onClose)
      socket.off('data', onData)
    }
    socket.on('error', onError)
    socket.on('close', onClose)
    socket.on('data', onData)
  })
}

function environmentFor(state: LaunchState): RunnerContextBrokerEnvironment {
  return Object.freeze({ ...state.environment })
}

/**
 * Public cross-realm connector.  It consumes only Product-issued transport
 * bootstrap and connects to the already-running child broker; it never looks
 * up a launch object, Store, governance ID, RunnerContext handle, or version.
 */
export async function connectRunnerContextBroker(
  input: RunnerContextBrokerConnectorInput,
): Promise<RunnerContextBrokerClient> {
  const target = await resolveConnectorTarget(input)
  return connectClientTarget(target)
}

export function createRunnerContextBrokerLaunch(
  options: RunnerContextBrokerLaunchOptions,
): RunnerContextBrokerLaunch {
  const runRoot = safeRunRoot(options.runRoot)
  const launchNonce = randomBytes(32).toString('base64url')
  const rendezvousDir = join(runRoot, '.local', 'runner-context-broker')
  const descriptorPath = join(rendezvousDir, `${launchNonce}.json`)
  const endpoint = expectedEndpoint(rendezvousDir, launchNonce)
  const state: LaunchState = {
    runRoot,
    rendezvousDir,
    descriptorPath,
    endpoint,
    launchNonce,
    serverInstance: randomUUID(),
    environment: {
      DSH_KINGDOM_BROKER_REQUIRED: '1',
      DSH_KINGDOM_BROKER_RENDEZVOUS_DIR: rendezvousDir,
      DSH_KINGDOM_BROKER_LAUNCH_NONCE: launchNonce,
    },
    descriptorCreated: Promise.resolve(),
    server: null,
    connection: null,
    registration: null,
    registrationConsumed: false,
    closed: false,
    startError: null,
    ready: Promise.resolve(),
  }
  state.ready = startServer(state).catch(error => {
    state.startError = error
    throw error
  })
  const launch: RunnerContextBrokerLaunch = Object.freeze({
    childEnvironment: () => environmentFor(state),
    connect: () => connectClient(state),
    close: async () => {
      if (state.closed) {
        if (activeProductLaunch === launch) activeProductLaunch = null
        return
      }
      state.closed = true
      revokeRegistration(state, 'broker closed')
      if (state.connection && !state.connection.closed) closeConnection(state, state.connection)
      await state.ready.catch(() => undefined)
      if (state.server) {
        await new Promise<void>(resolveClosed => state.server!.close(() => resolveClosed())).catch(() => undefined)
        state.server = null
      }
      await removeOwnedDescriptor(state)
      if (process.platform !== 'win32') await unlink(state.endpoint).catch(() => undefined)
      activeLaunches.delete(launch)
      if (activeProductLaunch === launch) activeProductLaunch = null
    },
  })
  launchStates.set(launch, state)
  activeLaunches.add(launch)
  return launch
}

/**
 * Public Product lifecycle.  The sole input is an absolute runRoot; the
 * returned facade exposes only serialized bootstrap and internally derived
 * bounded cleanup.  Canonical context registration remains in the existing
 * post-TX-3 registerProductRunnerContext path.
 */
export function createRunnerContextBrokerProductLifecycle(
  runRoot: string,
): RunnerContextBrokerProductLifecycle {
  if (activeProductLaunch) {
    throw new RunnerContextBrokerError('SECOND_EPOCH', 'Product 同时只能激活一个 broker epoch')
  }
  const launch = createRunnerContextBrokerLaunch({ runRoot })
  activateRunnerContextBrokerLaunch(launch)
  const state = launchStates.get(launch)!
  let bootstrapPromise: Promise<RunnerContextBrokerConnectionBootstrap> | null = null
  let closePromise: Promise<RunnerContextBrokerCleanupReceipt> | null = null

  const lifecycle: RunnerContextBrokerProductLifecycle = Object.freeze({
    bootstrap: () => {
      bootstrapPromise ??= (async () => {
        await state.ready
        if (state.closed) throw new RunnerContextBrokerError('CLOSED', 'Product lifecycle 已关闭')
        const environment = environmentFor(state)
        const descriptor = await readProductDescriptor(environment)
        return Object.freeze({ environment, descriptor })
      })()
      return bootstrapPromise
    },
    close: () => {
      closePromise ??= (async () => {
        deactivateRunnerContextBrokerLaunch(launch)
        await launch.close()
        const descriptorAbsent = await pathAbsent(state.descriptorPath)
        const endpointStatus = process.platform === 'win32'
          ? 'NOT_APPLICABLE' as const
          : await pathAbsent(state.endpoint) ? 'ABSENT' as const : null
        const activeConnections = state.connection && !state.connection.closed ? 1 : 0
        const activeRegistrations = state.registration && !state.registration.revoked ? 1 : 0
        const activeServers = state.server ? 1 : 0
        if (!descriptorAbsent || endpointStatus === null
          || activeConnections !== 0 || activeRegistrations !== 0 || activeServers !== 0) {
          throw new RunnerContextBrokerError('CLEANUP_UNCERTAIN', 'Product broker owned resources 未证明终态为零')
        }
        return Object.freeze({
          status: 'CONFIRMED' as const,
          closeExecutions: 1 as const,
          activeConnections: 0 as const,
          activeRegistrations: 0 as const,
          activeServers: 0 as const,
          descriptorStatus: 'ABSENT' as const,
          endpointStatus,
        })
      })()
      return closePromise
    },
  })
  return lifecycle
}

/** Internal Product-only activation; not re-exported by the package root. */
export function activateRunnerContextBrokerLaunch(launch: RunnerContextBrokerLaunch): void {
  const state = launchStates.get(launch)
  if (!state) throw new RunnerContextBrokerError('INVALID_LAUNCH', 'launch 不是本模块签发对象')
  if (state.closed) throw new RunnerContextBrokerError('CLOSED', '已关闭的 broker launch 不能成为 Product epoch')
  if (activeProductLaunch && activeProductLaunch !== launch) {
    throw new RunnerContextBrokerError('SECOND_EPOCH', 'Product 同时只能激活一个 broker epoch')
  }
  activeProductLaunch = launch
}

/** Internal Product-only deactivation. */
export function deactivateRunnerContextBrokerLaunch(launch: RunnerContextBrokerLaunch): void {
  if (activeProductLaunch === launch) activeProductLaunch = null
}

export function getActiveRunnerContextBrokerLaunch(): RunnerContextBrokerLaunch | null {
  return activeProductLaunch
}

/**
 * Product-side registration after TX-3 commit.  The registration itself
 * acquires the exact canonical relation before any adapter dispatch side
 * effect.  The returned object is internal and must never cross the wire.
 */
export function registerRunnerContextBrokerContext(
  launch: RunnerContextBrokerLaunch,
  port: RunnerContextPort,
): { readonly ticket: string; readonly port: RunnerContextPort } {
  const state = launchStates.get(launch)
  if (!state || state.closed) throw new RunnerContextBrokerError('INVALID_LAUNCH', 'launch 不可用')
  if (state.registrationConsumed) throw new RunnerContextBrokerError('SECOND_CONTEXT', '当前 Product epoch 已消费 RunnerContext registration')
  // Consume the one registration slot before touching the canonical port. A
  // failed acquire/ticket path is not retryable on this epoch.
  state.registrationConsumed = true
  try {
    if (registrationAvailable(state)) throw new RunnerContextBrokerError('SECOND_CONTEXT', '已有 active RunnerContext')
    if (state.startError) throw new RunnerContextBrokerError('START_FAILED', String(state.startError))
    const acquired = port.currentPhase === 'OPEN'
      ? port.acquire(port.handle, port.initialVersion)
      : port.brokerSnapshot()
    const ticket = randomBytes(32).toString('base64url')
    const registration: BrokerRegistration = {
      port,
      handle: port.handle,
      version: acquired.version,
      ticket,
      revision: 0,
      connection: state.connection?.socket ?? null,
      revoked: false,
    }
    state.registration = registration
    if (state.connection) state.connection.registration = registration
    return Object.freeze({ ticket, port })
  } catch (error: unknown) {
    state.registration = null
    throw error
  }
}

/** Internal dispatch seam: remember the one Product context for settlement. */
export function rememberRunnerContextPort(dispatchId: string, port: RunnerContextPort): void {
  boundedToken(dispatchId, 'dispatchId', 256)
  if (productPorts.has(dispatchId) && productPorts.get(dispatchId) !== port) {
    throw new RunnerContextBrokerError('SECOND_CONTEXT', `dispatch ${dispatchId} 已有不同 RunnerContext`)
  }
  productPorts.set(dispatchId, port)
}

export function getRunnerContextPort(dispatchId: string): RunnerContextPort | null {
  return productPorts.get(dispatchId) ?? null
}

export function forgetRunnerContextPort(dispatchId: string): void {
  productPorts.delete(dispatchId)
}

/** Revoke only the transport ticket/connection; never mutates governance rows. */
export function revokeRunnerContextBrokerContext(port: RunnerContextPort | null): void {
  if (!port) return
  for (const launch of activeLaunches) {
    const state = launchStates.get(launch)
    if (!state?.registration || state.registration.port !== port) continue
    state.registration.revoked = true
    state.registration = null
    if (state.connection?.registration?.port === port) {
      state.connection.registration = null
      if (!state.connection.closed) closeConnection(state, state.connection)
    }
  }
}

/** Product dispatch helper: acquire/register when an active broker exists. */
export function registerProductRunnerContext(
  dispatchId: string,
  port: RunnerContextPort,
): { readonly ticket: string | null; readonly port: RunnerContextPort } {
  rememberRunnerContextPort(dispatchId, port)
  const launch = activeProductLaunch
  if (!launch) {
    const acquired = port.currentPhase === 'OPEN' ? port.acquire(port.handle, port.initialVersion) : port.brokerSnapshot()
    return Object.freeze({ ticket: null, port })
  }
  const registered = registerRunnerContextBrokerContext(launch, port)
  return Object.freeze({ ticket: registered.ticket, port })
}
