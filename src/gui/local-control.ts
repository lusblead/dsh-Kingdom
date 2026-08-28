/**
 * v0.9 Local GUI Control Session。
 *
 * 这不是一个 HTTP server，也不是另一个 Owner/Auth 平面。它只保存由
 * direct `/kingdom gui` 闭包创建的短期内存状态，并向 GUI server 暴露最小
 * 的 ticket redemption / request admission seam。所有 transport 值都只在
 * 内存中存在：不进入事件、Projection、日志或 domain payload。
 */
import { randomBytes } from 'node:crypto'
import type { Principal } from '../core/task-service.js'
import {
  GUI_OWNER_DIRECT_SLASH_HINTS,
  GUI_OWNER_ONLY_ACTIONS,
  GUI_REVIEW_DECISIONS,
  GUI_SESSION_COMMANDS,
  GUI_START_SANDBOX_MODES,
  GuiControlAuthorizeResult,
  type GuiControlActionView,
  GuiControlBroker,
  GuiControlExecutionContext,
  GuiControlFailure,
  GuiControlInspectResult,
  GuiControlPublicView,
  GuiControlRedeemResult,
  GuiControlRequestMeta,
  type GuiSessionCommand,
} from './control-contract.js'

export const LOCAL_CONTROL_REDIRECT_PATH = '/console'
export const LOCAL_CONTROL_LAUNCH_PATH = LOCAL_CONTROL_REDIRECT_PATH
export const LOCAL_CONTROL_SESSION_COOKIE = 'dsh_kingdom_control'
export const LOCAL_CONTROL_CSRF_HEADER = 'x-kingdom-csrf'
export const LOCAL_CONTROL_REQUEST_ID_HEADER = 'x-kingdom-request-id'

/**
 * Public action ids are UI vocabulary; `command` is the exact loopback route.
 * Lifecycle/state availability remains sourced from live Task/Execution
 * projections and is revalidated by Core on every command.
 */
const SESSION_ACTION_COMMANDS: Record<string, GuiSessionCommand> = {
  'task.create': 'plan',
  plan: 'plan',
  assign: 'assign',
  start: 'start',
  review: 'review',
  'review:accept': 'review',
  'review:rework': 'review',
  'review:fail': 'review',
  'review:handoff': 'review',
  'execution.pause': 'execution.pause',
  'execution:pause': 'execution.pause',
  'execution.resume': 'execution.resume',
  'execution:resume': 'execution.resume',
  'execution.abort': 'execution.abort',
  'execution:abort': 'execution.abort',
  'control.revoke': 'control.revoke',
}

const DEFAULT_TICKET_TTL_MS = 30_000
const DEFAULT_SESSION_TTL_MS = 10 * 60_000
const DEFAULT_MAX_REQUEST_IDS = 128
const MAX_TOKEN_LENGTH = 512

type Clock = () => number
type TokenFactory = () => string

export interface LocalControlOptions {
  /** HTTP Host must resolve to this exact IPv4 loopback address. */
  host?: string
  /** Browser Origin must equal this exact value; `*` is never accepted. */
  expectedOrigin: string | (() => string)
  ticketTtlMs?: number
  sessionTtlMs?: number
  maxRequestIds?: number
  now?: Clock
  tokenFactory?: TokenFactory
}

export interface LocalControlActivation {
  /** One-time secret for the GUI launch route; never log or persist it. */
  readonly launchTicket: string
  readonly launchPath: typeof LOCAL_CONTROL_LAUNCH_PATH
  readonly activationId: string
  readonly expiresAt: string
  readonly ttlMs: number
}

export interface LocalControlRedeemRequest {
  host: string
  /** Navigation requests may omit Origin; if present it is checked exactly. */
  origin?: string | null
}

export interface LocalControlCookie {
  readonly name: typeof LOCAL_CONTROL_SESSION_COOKIE
  readonly value: string
  readonly httpOnly: true
  readonly sameSite: 'Strict'
  readonly path: '/'
  readonly maxAgeSeconds: number
}

export interface LocalControlRedemption {
  readonly ok: true
  readonly status: 303
  readonly location: typeof LOCAL_CONTROL_REDIRECT_PATH
  readonly cookie: LocalControlCookie
  /** Returned to the GUI page through the redemption response, not a cookie. */
  readonly csrfToken: string
  readonly expiresAt: string
}

export type LocalControlRejectionCode =
  | 'LOCAL_CONTROL_CLOSED'
  | 'LOOPBACK_REQUIRED'
  | 'ORIGIN_MISMATCH'
  | 'ORIGIN_NOT_CONFIGURED'
  | 'LAUNCH_TICKET_REQUIRED'
  | 'LAUNCH_TICKET_INVALID'
  | 'LAUNCH_TICKET_EXPIRED'
  | 'SESSION_COOKIE_REQUIRED'
  | 'SESSION_INVALID'
  | 'SESSION_EXPIRED'
  | 'SESSION_REVOKED'
  | 'CSRF_REQUIRED'
  | 'CSRF_INVALID'
  | 'REQUEST_ID_REQUIRED'
  | 'REQUEST_ID_INVALID'
  | 'REQUEST_REPLAY'
  | 'REQUEST_WINDOW_EXHAUSTED'
  | 'MUTATION_IN_FLIGHT'

export interface LocalControlRejection {
  readonly ok: false
  readonly code: LocalControlRejectionCode
  readonly message: string
}

export interface LocalControlAuthority {
  /** Captured exact DSH Agent object; never accepted from the HTTP payload. */
  readonly agent: unknown
  /** Captured at activation time and re-used for session-bound Role checks. */
  readonly principal: Principal
  /** Aborted on TTL expiry, revoke, replacement, or plugin unload. */
  readonly signal: AbortSignal
}

export interface LocalControlAdmission {
  readonly ok: true
  readonly authority: LocalControlAuthority
  readonly expiresAt: string
  /** Must be called exactly once after the command handler settles. */
  readonly release: () => void
}

export type LocalControlRedemptionResult = LocalControlRedemption | LocalControlRejection
export type LocalControlAdmissionResult = LocalControlAdmission | LocalControlRejection

interface TicketRecord {
  readonly agent: unknown
  readonly sessionId: string | null
  readonly activationId: string
  readonly expiresAtMs: number
}

interface SessionRecord extends TicketRecord {
  readonly cookie: string
  readonly csrfToken: string
  readonly requestIds: Set<string>
  readonly abortController: AbortController
  expiresAtMs: number
  revoked: boolean
  inFlight: boolean
  expiryTimer: NodeJS.Timeout | null
}

function token(): string {
  return randomBytes(32).toString('base64url')
}

function getSessionId(agent: unknown): string | null {
  if (typeof agent !== 'object' || agent === null) return null
  const session = (agent as { session?: unknown }).session
  if (typeof session !== 'object' || session === null) return null
  const id = (session as { id?: unknown }).id
  return typeof id === 'string' && id.trim().length > 0 ? id : null
}

function validDuration(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback
}

function validLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value >= 1 ? Math.floor(value) : fallback
}

/** Accept `127.0.0.1` and `127.0.0.1:port`; reject localhost/IPv6/other hosts. */
export function isExactLoopbackHost(value: string, expectedHost = '127.0.0.1'): boolean {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) return false
  if (value.includes('/') || /\s/u.test(value) || value.startsWith('[')) return false
  const colon = value.lastIndexOf(':')
  const host = colon > -1 && value.indexOf(':') === colon ? value.slice(0, colon) : value
  const port = colon > -1 && value.indexOf(':') === colon ? value.slice(colon + 1) : null
  if (port !== null && (!/^\d+$/u.test(port) || Number(port) < 1 || Number(port) > 65535)) return false
  return host === expectedHost
}

/** The server is IPv4-loopback only; do not widen this to localhost or ::1. */
export function isExactLoopbackRemoteAddress(value: string | null): boolean {
  return value === '127.0.0.1' || value === '::ffff:127.0.0.1'
}

function readCookieValue(header: string | null | undefined): string | null {
  if (typeof header !== 'string') return null
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === LOCAL_CONTROL_SESSION_COOKIE) {
      const value = rest.join('=').trim()
      return value.length > 0 && value.length <= MAX_TOKEN_LENGTH ? value : null
    }
  }
  return null
}

function reject(code: LocalControlRejectionCode, message: string): LocalControlRejection {
  return { ok: false, code, message }
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function toContractFailure(rejection: LocalControlRejection): GuiControlFailure {
  let code: GuiControlFailure['code']
  switch (rejection.code) {
    case 'LOOPBACK_REQUIRED':
    case 'ORIGIN_MISMATCH':
    case 'ORIGIN_NOT_CONFIGURED':
      code = 'CONTROL_ORIGIN_DENIED'
      break
    case 'LAUNCH_TICKET_REQUIRED':
    case 'LAUNCH_TICKET_INVALID':
    case 'LAUNCH_TICKET_EXPIRED':
      code = 'CONTROL_TICKET_INVALID'
      break
    case 'SESSION_COOKIE_REQUIRED':
    case 'SESSION_INVALID':
    case 'SESSION_REVOKED':
      code = 'CONTROL_SESSION_REQUIRED'
      break
    case 'SESSION_EXPIRED':
    case 'LOCAL_CONTROL_CLOSED':
      code = 'CONTROL_SESSION_EXPIRED'
      break
    case 'CSRF_REQUIRED':
    case 'CSRF_INVALID':
      code = 'CONTROL_CSRF_DENIED'
      break
    case 'REQUEST_ID_REQUIRED':
    case 'REQUEST_ID_INVALID':
    case 'REQUEST_REPLAY':
    case 'REQUEST_WINDOW_EXHAUSTED':
      code = 'CONTROL_REPLAY_DENIED'
      break
    case 'MUTATION_IN_FLIGHT':
      code = 'CONTROL_BUSY'
      break
  }
  return { ok: false, code, message: rejection.message }
}

/**
 * In-process Local GUI Control Session manager.
 *
 * `activate()` is intended to be called only from the direct Slash handler.
 * `redeem()` and `admit()` are transport seams; neither one mints authority.
 */
export class LocalControlManager implements GuiControlBroker {
  private readonly host: string
  private readonly expectedOriginSource: string | (() => string)
  private readonly ticketTtlMs: number
  private readonly sessionTtlMs: number
  private readonly maxRequestIds: number
  private readonly now: Clock
  private readonly tokenFactory: TokenFactory
  private readonly tickets = new Map<string, TicketRecord>()
  private readonly sessions = new Map<string, SessionRecord>()
  private closed = false

  constructor(options: LocalControlOptions) {
    this.host = options.host ?? '127.0.0.1'
    this.expectedOriginSource = options.expectedOrigin
    this.ticketTtlMs = validDuration(options.ticketTtlMs, DEFAULT_TICKET_TTL_MS)
    this.sessionTtlMs = validDuration(options.sessionTtlMs, DEFAULT_SESSION_TTL_MS)
    this.maxRequestIds = validLimit(options.maxRequestIds, DEFAULT_MAX_REQUEST_IDS)
    this.now = options.now ?? Date.now
    this.tokenFactory = options.tokenFactory ?? token
  }

  private expectedOrigin(): string {
    const value = typeof this.expectedOriginSource === 'function'
      ? this.expectedOriginSource()
      : this.expectedOriginSource
    return typeof value === 'string' ? value.trim() : ''
  }

  private validateTransport(meta: GuiControlRequestMeta, requireOrigin: boolean): LocalControlRejection | null {
    if (this.closed) return reject('LOCAL_CONTROL_CLOSED', 'Local control session 已卸载。')
    if (!isExactLoopbackHost(meta.host ?? '', this.host) || !isExactLoopbackRemoteAddress(meta.remoteAddress)) {
      return reject('LOOPBACK_REQUIRED', '仅允许精确的 127.0.0.1 回环 Host 与连接地址。')
    }
    const expectedOrigin = this.expectedOrigin()
    if (expectedOrigin.length === 0 || expectedOrigin === '*') {
      return reject('ORIGIN_NOT_CONFIGURED', 'Local control 未配置精确 Origin。')
    }
    if (requireOrigin ? meta.origin !== expectedOrigin : meta.origin !== null && meta.origin !== expectedOrigin) {
      return reject('ORIGIN_MISMATCH', '请求 Origin 与激活的本地 GUI Origin 不一致。')
    }
    return null
  }

  private publicView(session: SessionRecord): GuiControlPublicView {
    const actions: Record<string, GuiControlActionView> = {}
    for (const [action, command] of Object.entries(SESSION_ACTION_COMMANDS)) {
      const executable = command === 'control.revoke' || session.sessionId !== null
      actions[action] = {
        executable,
        disabledReason: executable ? null : 'SESSION_AUTH_REQUIRED',
        command,
        directSlashHint: null,
      }
    }
    for (const action of GUI_OWNER_ONLY_ACTIONS) {
      actions[action] = {
        executable: false,
        disabledReason: 'DIRECT_SLASH_REQUIRED',
        command: null,
        directSlashHint: GUI_OWNER_DIRECT_SLASH_HINTS[action],
      }
    }
    return {
      active: true,
      activationId: session.activationId,
      expiresAt: iso(session.expiresAtMs),
      csrfToken: session.csrfToken,
      roleSessionBound: session.sessionId !== null,
      commands: [...GUI_SESSION_COMMANDS],
      reviewDecisions: [...GUI_REVIEW_DECISIONS],
      sandboxModes: [...GUI_START_SANDBOX_MODES],
      actions,
      disabledReason: null,
    }
  }

  private sessionFor(input: string | null): SessionRecord | LocalControlRejection {
    const cookie = readCookieValue(input) ?? input
    if (typeof cookie !== 'string' || cookie.length === 0 || cookie.length > MAX_TOKEN_LENGTH) {
      return reject('SESSION_COOKIE_REQUIRED', '缺少 HttpOnly local control session cookie。')
    }
    const session = this.sessions.get(cookie)
    if (!session) return reject('SESSION_INVALID', 'local control session 无效。')
    const now = this.now()
    if (session.revoked) return reject('SESSION_REVOKED', 'local control session 已撤销。')
    if (now >= session.expiresAtMs) {
      this.revokeRecord(session)
      return reject('SESSION_EXPIRED', 'local control session 已过期，请重新激活。')
    }
    return session
  }

  activate(agent: unknown): LocalControlActivation {
    if (this.closed) throw new Error('LOCAL_CONTROL_CLOSED: local control manager 已卸载。')
    this.revokeAll()
    const createdAt = this.now()
    const activationId = this.tokenFactory()
    const launchTicket = this.tokenFactory()
    const record: TicketRecord = {
      agent,
      sessionId: getSessionId(agent),
      activationId,
      expiresAtMs: createdAt + this.ticketTtlMs,
    }
    this.tickets.set(launchTicket, record)
    return {
      launchTicket,
      launchPath: LOCAL_CONTROL_LAUNCH_PATH,
      activationId,
      expiresAt: iso(record.expiresAtMs),
      ttlMs: this.ticketTtlMs,
    }
  }

  redeem(launchTicket: string, meta: GuiControlRequestMeta): GuiControlRedeemResult {
    const transport = this.validateTransport(meta, false)
    if (transport) return toContractFailure(transport)
    if (typeof launchTicket !== 'string' || launchTicket.length === 0 || launchTicket.length > MAX_TOKEN_LENGTH) {
      return toContractFailure(reject('LAUNCH_TICKET_REQUIRED', '缺少一次性 GUI launch ticket。'))
    }
    const record = this.tickets.get(launchTicket)
    if (!record) return toContractFailure(reject('LAUNCH_TICKET_INVALID', 'launch ticket 无效或已经使用。'))
    const now = this.now()
    if (now >= record.expiresAtMs) {
      this.tickets.delete(launchTicket)
      return toContractFailure(reject('LAUNCH_TICKET_EXPIRED', 'launch ticket 已过期，请重新执行 `/kingdom gui`。'))
    }

    // Consume before exposing the cookie/CSRF pair: redemption is one-time.
    this.tickets.delete(launchTicket)
    const cookie = this.tokenFactory()
    const csrfToken = this.tokenFactory()
    const session: SessionRecord = {
      ...record,
      cookie,
      csrfToken,
      requestIds: new Set(),
      abortController: new AbortController(),
      expiresAtMs: now + this.sessionTtlMs,
      revoked: false,
      inFlight: false,
      expiryTimer: null,
    }
    this.sessions.set(cookie, session)
    session.expiryTimer = setTimeout(() => {
      if (this.sessions.get(cookie) === session) this.revokeRecord(session)
    }, this.sessionTtlMs + 1)
    session.expiryTimer.unref?.()
    return {
      ok: true,
      cookieValue: cookie,
      view: this.publicView(session),
    }
  }

  inspect(cookieValue: string | null, meta: GuiControlRequestMeta): GuiControlInspectResult {
    // Same-origin browser GETs commonly omit Origin.  Read admission may
    // therefore accept null or the exact configured Origin; mutation
    // admission below remains exact-Origin-only.
    const transport = this.validateTransport(meta, false)
    if (transport) return toContractFailure(transport)
    const session = this.sessionFor(cookieValue)
    if (!('cookie' in session)) return toContractFailure(session)
    return {
      ok: true,
      view: this.publicView(session),
      // This identity was captured from the direct activation. It is not read
      // from a cookie value, query string, request body, or browser header.
      readContext: { principalSessionId: session.sessionId },
    }
  }

  authorize(
    cookieValue: string | null,
    csrfToken: string | null,
    requestId: string | null,
    meta: GuiControlRequestMeta,
  ): GuiControlAuthorizeResult {
    const transport = this.validateTransport(meta, true)
    if (transport) return toContractFailure(transport)
    const session = this.sessionFor(cookieValue)
    if (!('cookie' in session)) return toContractFailure(session)
    if (csrfToken !== session.csrfToken) {
      return toContractFailure(reject(csrfToken ? 'CSRF_INVALID' : 'CSRF_REQUIRED', '缺少或不匹配的 GUI CSRF token。'))
    }
    if (typeof requestId !== 'string' || requestId.trim() !== requestId || requestId.length === 0 || requestId.length > MAX_TOKEN_LENGTH) {
      return toContractFailure(reject(requestId ? 'REQUEST_ID_INVALID' : 'REQUEST_ID_REQUIRED', '每个 GUI 请求必须带非空 request id。'))
    }
    if (session.requestIds.has(requestId)) return toContractFailure(reject('REQUEST_REPLAY', 'request id 已经使用，拒绝重放。'))
    if (session.requestIds.size >= this.maxRequestIds) {
      return toContractFailure(reject('REQUEST_WINDOW_EXHAUSTED', '本地 control session 的 request-id 窗口已满，请重新激活。'))
    }
    if (session.inFlight) return toContractFailure(reject('MUTATION_IN_FLIGHT', '同一 local control session 已有 mutation 正在执行。'))

    session.requestIds.add(requestId)
    session.inFlight = true
    let released = false
    const finish = (): void => {
      if (released) return
      released = true
      session.inFlight = false
    }
    const context: GuiControlExecutionContext & { readonly agent: unknown } = {
      activationId: session.activationId,
      principalSessionId: session.sessionId ?? '',
      signal: session.abortController.signal,
      agent: session.agent,
    }
    return { ok: true, context, view: this.publicView(session), finish }
  }

  admit(request: {
    host: string
    origin?: string | null
    cookie?: string | null
    csrfToken?: string | null
    requestId?: string | null
    mutation?: boolean
  }): LocalControlAdmissionResult {
    const meta: GuiControlRequestMeta = {
      host: request.host,
      origin: request.origin ?? null,
      remoteAddress: '127.0.0.1',
      fetchSite: null,
    }
    const admitted = this.authorize(
      readCookieValue(request.cookie),
      request.csrfToken ?? null,
      request.requestId ?? null,
      meta,
    )
    if (!admitted.ok) {
      const matching = Object.entries({
        CONTROL_SESSION_REQUIRED: 'SESSION_INVALID',
        CONTROL_SESSION_EXPIRED: 'SESSION_EXPIRED',
        CONTROL_ORIGIN_DENIED: 'ORIGIN_MISMATCH',
        CONTROL_CSRF_DENIED: 'CSRF_INVALID',
        CONTROL_REPLAY_DENIED: 'REQUEST_REPLAY',
        CONTROL_BUSY: 'MUTATION_IN_FLIGHT',
      }).find(([key]) => key === admitted.code)
      return reject((matching?.[1] ?? 'SESSION_INVALID') as LocalControlRejectionCode, admitted.message)
    }
    const context = admitted.context
    return {
      ok: true,
      authority: {
        agent: (context as GuiControlExecutionContext & { agent: unknown }).agent,
        principal: context.principalSessionId ? { sessionId: context.principalSessionId } : {},
        signal: context.signal,
      },
      expiresAt: admitted.view.expiresAt,
      release: admitted.finish,
    }
  }

  revoke(cookieHeaderOrValue: string | null): void {
    const cookie = readCookieValue(cookieHeaderOrValue) ?? cookieHeaderOrValue
    if (typeof cookie !== 'string') return
    const session = this.sessions.get(cookie)
    if (!session) return
    this.revokeRecord(session)
  }

  revokeAllSessions(): void {
    this.revokeAll()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.revokeAll()
    this.tickets.clear()
  }

  dispose(): void {
    this.close()
  }

  private revokeAll(): void {
    for (const session of this.sessions.values()) this.revokeRecord(session)
    this.sessions.clear()
    this.tickets.clear()
  }

  private revokeRecord(session: SessionRecord): void {
    session.revoked = true
    session.inFlight = false
    if (session.expiryTimer) {
      clearTimeout(session.expiryTimer)
      session.expiryTimer = null
    }
    session.abortController.abort()
    this.sessions.delete(session.cookie)
  }
}

export function createLocalControl(options: LocalControlOptions): LocalControlManager {
  return new LocalControlManager(options)
}
