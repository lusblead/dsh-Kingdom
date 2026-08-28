/**
 * Shared seam between the loopback HTTP server and the direct-Slash-owned
 * local control broker.
 *
 * The values in this file are transport evidence only.  A cookie, CSRF token,
 * request id, browser payload, or HTTP request never creates Owner or Role
 * authority.  Only the broker may return the opaque execution context captured
 * from the direct `/kingdom gui` activation.
 */

/** Commands that the loopback GUI may submit after control-session admission. */
export const GUI_SESSION_COMMANDS = [
  'plan',
  'assign',
  'start',
  'review',
  'execution.pause',
  'execution.resume',
  'execution.abort',
  'control.revoke',
] as const

export type GuiSessionCommand = (typeof GUI_SESSION_COMMANDS)[number]

/** Exact browser-controlled top-level fields for each executable command. */
export const GUI_COMMAND_PAYLOAD_FIELDS: Record<GuiSessionCommand, readonly string[]> = {
  plan: ['title', 'description', 'acceptance_criteria', 'territory_id', 'capability_requirement_json'],
  assign: ['task_id', 'worker_binding_id'],
  start: ['task_id', 'grant_json', 'sandbox_mode'],
  review: ['task_id', 'decision', 'reason', 'to_binding_id'],
  'execution.pause': ['execution_id', 'reason'],
  'execution.resume': ['execution_id', 'reason'],
  'execution.abort': ['execution_id', 'reason'],
  'control.revoke': [],
}

/** Authority-shaped keys are forbidden at every structural depth. */
export const GUI_FORBIDDEN_PAYLOAD_FIELDS = [
  'session', 'session_id', 'sessionId', 'principal', 'principal_id', 'principalId',
  'principal_session_id', 'principalSessionId', 'agent', 'agent_id', 'agentId',
  'actor_id', 'actorId', 'owner', 'owner_control', 'ownerControl',
  'owner_capability', 'ownerCapability', 'authority', 'authorization',
  'cookie', 'csrf_token', 'csrfToken', 'request_id', 'requestId',
  'source_channel', 'sourceChannel', 'ticket', 'launch_ticket', 'launchTicket',
  'control_token', 'controlToken', 'activation_id', 'activationId',
] as const

export class DuplicateJsonKeyError extends Error {
  readonly key: string

  constructor(key: string) {
    super(`duplicate JSON key: ${key}`)
    this.name = 'DuplicateJsonKeyError'
    this.key = key
  }
}

/**
 * Parse one strict JSON object without allowing duplicate keys at any depth.
 * `JSON.parse` alone cannot enforce this because it silently keeps the last
 * duplicate value.
 */
export function parseStrictJsonObject(text: string): Record<string, unknown> {
  let offset = 0
  const fail = (): never => { throw new Error('invalid JSON object') }
  const skipWhitespace = (): void => {
    while (offset < text.length && /\s/u.test(text[offset]!)) offset++
  }
  const parseString = (): string => {
    if (text[offset] !== '"') return fail()
    const start = offset
    offset++
    while (offset < text.length) {
      const char = text[offset++]!
      if (char === '"') return JSON.parse(text.slice(start, offset)) as string
      if (char === '\\') {
        if (offset >= text.length) return fail()
        const escaped = text[offset++]!
        if (escaped === 'u') {
          if (!/^[0-9a-fA-F]{4}$/u.test(text.slice(offset, offset + 4))) return fail()
          offset += 4
        } else if (!/["\\/bfnrt]/u.test(escaped)) {
          return fail()
        }
      } else if (char < ' ') {
        return fail()
      }
    }
    return fail()
  }
  const parseNumber = (): void => {
    const match = text.slice(offset).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u)
    if (!match) return fail()
    offset += match[0].length
  }
  const parseValue = (): void => {
    skipWhitespace()
    const char = text[offset]
    if (char === '"') { parseString(); return }
    if (char === '{') { parseObject(); return }
    if (char === '[') { parseArray(); return }
    if (char === 't' && text.startsWith('true', offset)) { offset += 4; return }
    if (char === 'f' && text.startsWith('false', offset)) { offset += 5; return }
    if (char === 'n' && text.startsWith('null', offset)) { offset += 4; return }
    if (char === '-' || (char !== undefined && /[0-9]/u.test(char))) { parseNumber(); return }
    return fail()
  }
  const parseArray = (): void => {
    offset++
    skipWhitespace()
    if (text[offset] === ']') { offset++; return }
    while (true) {
      parseValue()
      skipWhitespace()
      if (text[offset] === ']') { offset++; return }
      if (text[offset] !== ',') return fail()
      offset++
      skipWhitespace()
      if (text[offset] === ']') return fail()
    }
  }
  const parseObject = (): void => {
    offset++
    skipWhitespace()
    const keys = new Set<string>()
    if (text[offset] === '}') { offset++; return }
    while (true) {
      const key = parseString()
      if (keys.has(key)) throw new DuplicateJsonKeyError(key)
      keys.add(key)
      skipWhitespace()
      if (text[offset] !== ':') return fail()
      offset++
      parseValue()
      skipWhitespace()
      if (text[offset] === '}') { offset++; return }
      if (text[offset] !== ',') return fail()
      offset++
      skipWhitespace()
      if (text[offset] === '}') return fail()
    }
  }

  parseValue()
  skipWhitespace()
  if (offset !== text.length) return fail()
  const parsed = JSON.parse(text) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fail()
  return parsed as Record<string, unknown>
}

export const GUI_START_SANDBOX_MODES = ['workspace-write', 'read-only'] as const
export type GuiStartSandboxMode = (typeof GUI_START_SANDBOX_MODES)[number]

export const GUI_REVIEW_DECISIONS = ['ACCEPT', 'REWORK', 'FAIL', 'HANDOFF'] as const

/**
 * Canonical Owner-only actions advertised by the GUI as discoverable but
 * non-executable. The retired `setup.basic` HTTP spelling is deliberately not
 * advertised as an action; it remains deny-only below for fail-closed clients.
 */
export const GUI_OWNER_ONLY_ACTIONS = [
  'init',
  'reset',
  'ceiling',
  'territory.create',
  'territory.delete',
  'territory.supervisor',
  'role.bind',
  'role.unbind',
  'role.session',
  'execution-profile',
] as const

export type GuiOwnerOnlyAction = (typeof GUI_OWNER_ONLY_ACTIONS)[number]

/** Historical HTTP spellings remain explicit deny-only routes. */
export const GUI_OWNER_ONLY_HTTP_COMMANDS = [
  ...GUI_OWNER_ONLY_ACTIONS,
  'setup.basic',
  'binding.bind',
  'binding.unbind',
  'binding.session',
] as const

export const GUI_OWNER_DIRECT_SLASH_HINTS: Record<GuiOwnerOnlyAction, string> = {
  init: '/kingdom init',
  reset: '/kingdom reset',
  ceiling: '/kingdom ceiling {"ceiling":{"tool:pwsh":true}}',
  'territory.create': '/kingdom territory.create {"name":"<name>"}',
  'territory.delete': '/kingdom territory.delete {"territory_id":"<territory-id>","force":false}',
  'territory.supervisor': '/kingdom territory.supervisor {"territory_id":"<territory-id>","supervisor_binding_id":"<binding-id>"}',
  'role.bind': '/kingdom role.bind {"role_type":"SUPERVISOR","session_id":"<exact-dsh-session-id>"}',
  'role.unbind': '/kingdom role.unbind {"binding_id":"<binding-id>","reason":"<reason>"}',
  'role.session': '/kingdom role.session {"binding_id":"<binding-id>","session_id":"<exact-dsh-session-id>"}',
  'execution-profile': '/kingdom execution-profile {"binding_id":"<binding-id>","provider":"spawn","model":"<requested-model>"}',
}

export type GuiControlDisabledReason =
  | 'SESSION_AUTH_REQUIRED'
  | 'DIRECT_SLASH_REQUIRED'

export interface GuiControlActionView {
  executable: boolean
  disabledReason: GuiControlDisabledReason | null
  /** Loopback command name when executable; Owner-only actions always use null. */
  command: GuiSessionCommand | null
  /** Copyable direct Slash guidance for Owner-only actions only. */
  directSlashHint: string | null
}

export type GuiControlFailureCode =
  | 'CONTROL_SESSION_REQUIRED'
  | 'CONTROL_SESSION_EXPIRED'
  | 'CONTROL_ORIGIN_DENIED'
  | 'CONTROL_CSRF_DENIED'
  | 'CONTROL_REPLAY_DENIED'
  | 'CONTROL_BUSY'
  | 'CONTROL_TICKET_INVALID'

export interface GuiControlRequestMeta {
  host: string | null
  origin: string | null
  remoteAddress: string | null
  fetchSite: string | null
}

export interface GuiControlPublicView {
  active: true
  activationId: string
  expiresAt: string
  csrfToken: string
  roleSessionBound: boolean
  commands: string[]
  reviewDecisions: string[]
  sandboxModes: string[]
  actions: Record<string, GuiControlActionView>
  disabledReason: null
}

/**
 * Opaque to the HTTP server.  The broker creates this from direct activation;
 * browser data cannot construct or amend it.
 */
export interface GuiControlExecutionContext {
  readonly activationId: string
  readonly principalSessionId: string
  readonly signal: AbortSignal
}

/** Broker-originated read identity; never serialized or accepted from HTTP. */
export interface GuiControlReadContext {
  readonly principalSessionId: string | null
}

export interface GuiControlFailure {
  ok: false
  code: GuiControlFailureCode
  message: string
}

export interface GuiControlRedeemed {
  ok: true
  cookieValue: string
  view: GuiControlPublicView
}

export interface GuiControlInspected {
  ok: true
  view: GuiControlPublicView
  readContext: GuiControlReadContext
}

export interface GuiControlAuthorized {
  ok: true
  context: GuiControlExecutionContext
  view: GuiControlPublicView
  finish(): void
}

export type GuiControlRedeemResult = GuiControlRedeemed | GuiControlFailure
export type GuiControlInspectResult = GuiControlInspected | GuiControlFailure
export type GuiControlAuthorizeResult = GuiControlAuthorized | GuiControlFailure

export interface GuiControlBroker {
  redeem(ticket: string, meta: GuiControlRequestMeta): GuiControlRedeemResult
  inspect(cookieValue: string | null, meta: GuiControlRequestMeta): GuiControlInspectResult
  authorize(
    cookieValue: string | null,
    csrfToken: string | null,
    requestId: string | null,
    meta: GuiControlRequestMeta,
  ): GuiControlAuthorizeResult
  revoke(cookieValue: string | null): void
  dispose(): void
}
