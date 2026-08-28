import { readFileSync } from 'node:fs'

/**
 * v1.0 interactive Console presentation.
 *
 * This module owns browser state only.  The browser does not mint authority,
 * infer a principal from a payload, or write the Kingdom store.  The Host must
 * revalidate every command against the direct `/kingdom gui` control session.
 *
 * The HTML is intentionally dependency-free so the Coordinator can mount it
 * on the existing local server or another Host bridge without a build-time UI
 * framework.  Endpoint and command names are configurable at the seam; the
 * default names match the current GUI command vocabulary where possible.
 */


export const GUI_CHARACTER_ASSET_FILES = [
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
] as const

export type GuiCharacterAssetFile = typeof GUI_CHARACTER_ASSET_FILES[number]
export type GuiCharacterRole = 'CHANCELLOR' | 'SUPERVISOR' | 'WORKER'
export type GuiCharacterVisualState = 'idle' | 'working' | 'thinking' | 'sleeping'

export const GUI_CHARACTER_ASSET_PREFIX = '/gui-assets/characters/'

const GUI_CHARACTER_ASSET_SET = new Set<string>(GUI_CHARACTER_ASSET_FILES)

export const GUI_CHARACTER_ASSETS: Readonly<Record<GuiCharacterRole, Readonly<Record<GuiCharacterVisualState, string>>>> = {
  CHANCELLOR: {
    idle: `${GUI_CHARACTER_ASSET_PREFIX}chancellor-idle.svg`,
    working: `${GUI_CHARACTER_ASSET_PREFIX}chancellor-working.svg`,
    thinking: `${GUI_CHARACTER_ASSET_PREFIX}chancellor-thinking.svg`,
    sleeping: `${GUI_CHARACTER_ASSET_PREFIX}chancellor-sleeping.svg`,
  },
  SUPERVISOR: {
    idle: `${GUI_CHARACTER_ASSET_PREFIX}supervisor-idle.svg`,
    working: `${GUI_CHARACTER_ASSET_PREFIX}supervisor-working.svg`,
    thinking: `${GUI_CHARACTER_ASSET_PREFIX}supervisor-thinking.svg`,
    sleeping: `${GUI_CHARACTER_ASSET_PREFIX}supervisor-sleeping.svg`,
  },
  WORKER: {
    idle: `${GUI_CHARACTER_ASSET_PREFIX}knight-redraw-r1-idle.svg`,
    working: `${GUI_CHARACTER_ASSET_PREFIX}knight-redraw-r1-working.svg`,
    thinking: `${GUI_CHARACTER_ASSET_PREFIX}knight-redraw-r1-thinking.svg`,
    sleeping: `${GUI_CHARACTER_ASSET_PREFIX}knight-redraw-r1-sleeping.svg`,
  },
}

export function isGuiCharacterAssetFile(value: string): value is GuiCharacterAssetFile {
  return GUI_CHARACTER_ASSET_SET.has(value)
}

export function guiCharacterAssetLocations(fileName: GuiCharacterAssetFile): URL[] {
  return [
    new URL(`./assets/characters/${fileName}`, import.meta.url),
    new URL(`../../src/gui/assets/characters/${fileName}`, import.meta.url),
  ]
}

/**
 * The browser console embeds the Owner-authorized SVGs so the visible
 * character is a real inline SVG tree.  Keep the external allowlisted route
 * as a package/runtime asset surface too; this registry only reads the same
 * twelve named files from the emitted package or source checkout.
 */
function readGuiCharacterAsset(fileName: GuiCharacterAssetFile): string | null {
  for (const location of guiCharacterAssetLocations(fileName)) {
    try {
      const body = readFileSync(location, 'utf8')
      if (body.includes('<svg')) return body
    } catch {
      // The next explicit package/source location is the bounded fallback.
    }
  }
  return null
}

export const GUI_CHARACTER_ASSET_SVGS: Readonly<Record<GuiCharacterAssetFile, string | null>> =
  Object.freeze(Object.fromEntries(
    GUI_CHARACTER_ASSET_FILES.map(fileName => [fileName, readGuiCharacterAsset(fileName)]),
  ) as Record<GuiCharacterAssetFile, string | null>)

export const CONSOLE_APP_DEFAULT_ENDPOINTS = {
  control: '/api/control',
  snapshot: '/api/snapshot',
  taskDetail: '/api/tasks/{taskId}',
  command: '/api/commands/{command}',
  clientHeader: 'x-kingdom-client',
  csrfHeader: 'x-kingdom-csrf',
  requestIdHeader: 'x-kingdom-request-id',
  pollIntervalMs: 2500,
  staleAfterMs: 9000,
  readTimeoutMs: 10000,
  commandTimeoutMs: 75000,
} as const

export const CONSOLE_APP_DEFAULT_COMMANDS = {
  taskCreate: 'plan',
  assign: 'assign',
  start: 'start',
  review: 'review',
  executionPause: 'execution.pause',
  executionResume: 'execution.resume',
  executionAbort: 'execution.abort',
  controlRevoke: 'control.revoke',
} as const

export type ConsoleCapabilityState =
  | 'ACTIVE'
  | 'INACTIVE'
  | 'EXPIRED'
  | 'REVOKED'
  | 'FAILED'
  | 'UNKNOWN'

export interface ConsoleActionCapability {
  executable: boolean
  disabledReason: string | null
}

export interface ConsoleCapabilities {
  state: ConsoleCapabilityState
  active: boolean
  expiresAt: string | null
  csrfToken: string | null
  roleSessionBound: boolean
  commands: string[]
  reviewDecisions: string[]
  sandboxModes: string[]
  disabledReason: string | null
  actions: Record<string, ConsoleActionCapability>
}

export interface ConsoleActionState {
  action: string
  executable: boolean
  disabledReason: string | null
}

export interface ConsoleEndpointOptions {
  control?: string
  snapshot?: string
  taskDetail?: string
  command?: string
  clientHeader?: string
  csrfHeader?: string
  requestIdHeader?: string
  pollIntervalMs?: number
  staleAfterMs?: number
  readTimeoutMs?: number
  commandTimeoutMs?: number
}

export interface ConsoleCommandOptions {
  endpoints?: ConsoleEndpointOptions
  commands?: Partial<typeof CONSOLE_APP_DEFAULT_COMMANDS>
}

export interface ConsoleCommandEnvelope {
  name: string
  payload: Record<string, unknown>
}

export type ConsoleSection = 'overview' | 'organization' | 'tasks' | 'executions' | 'activity' | 'management' | 'ledger'

export const CONSOLE_APP_THEMES = [
  { id: 'parchment', label: '羊皮纸王国志', shortLabel: '羊皮' },
  { id: 'night', label: '夜蓝星图', shortLabel: '夜蓝' },
  { id: 'forest', label: '森林墨绿', shortLabel: '森林' },
  { id: 'wine', label: '酒红议会', shortLabel: '酒红' },
] as const

export type ConsoleTheme = typeof CONSOLE_APP_THEMES[number]['id']

export function normalizeConsoleTheme(value: unknown, fallback: ConsoleTheme = 'forest'): ConsoleTheme {
  return CONSOLE_APP_THEMES.some(theme => theme.id === value) ? value as ConsoleTheme : fallback
}

export interface ConsoleFragmentState {
  known: boolean
  section: ConsoleSection
  taskId: string | null
}

const CAPABILITY_STATES = new Set<ConsoleCapabilityState>([
  'ACTIVE', 'INACTIVE', 'EXPIRED', 'REVOKED', 'FAILED', 'UNKNOWN',
])

const ACTION_ALIASES: Record<string, string[]> = {
  'task.create': ['task.create', 'plan'],
  assign: ['assign'],
  start: ['start', 'governed-start', 'governed.start'],
  'review:accept': ['review:accept', 'review'],
  'review:rework': ['review:rework', 'review'],
  'review:fail': ['review:fail', 'review'],
  'review:handoff': ['review:handoff', 'review'],
  'execution:pause': ['execution:pause', 'execution.pause'],
  'execution:resume': ['execution:resume', 'execution.resume'],
  'execution:abort': ['execution:abort', 'execution.abort'],
  'control.revoke': ['control.revoke'],
}

const AUTHORITY_FIELDS = new Set([
  'session_id',
  'sessionId',
  'principal_id',
  'principalId',
  'agent_id',
  'agentId',
  'agent',
  'actor_id',
  'actorId',
  'owner_capability',
  'ownerCapability',
  'authorization',
  'cookie',
  'csrf_token',
  'csrfToken',
  'request_id',
  'requestId',
  'source_channel',
  'sourceChannel',
  'ticket',
  'launch_ticket',
  'launchTicket',
  'control_token',
  'controlToken',
  'activation_id',
  'activationId',
])

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function capabilityState(value: unknown): ConsoleCapabilityState {
  if (typeof value !== 'string') return 'UNKNOWN'
  const normalized = value.trim().toUpperCase()
  if (CAPABILITY_STATES.has(normalized as ConsoleCapabilityState)) {
    return normalized as ConsoleCapabilityState
  }
  if (normalized === 'READY' || normalized === 'ENABLED' || normalized === 'VALID') return 'ACTIVE'
  if (normalized === 'DISABLED' || normalized === 'INACTIVE') return 'INACTIVE'
  if (normalized === 'REVOKED' || normalized === 'CLOSED') return 'REVOKED'
  if (normalized === 'ERROR' || normalized === 'BROKEN') return 'FAILED'
  return 'UNKNOWN'
}

function capabilityEntry(value: unknown): ConsoleActionCapability {
  if (typeof value === 'boolean') {
    return { executable: value, disabledReason: value ? null : 'UNKNOWN' }
  }
  const entry = asRecord(value)
  const executable = entry.executable === true || entry.enabled === true || entry.allowed === true
  const rawReason = entry.disabledReason ?? entry.disabled_reason ?? entry.reason ?? entry.errorCode
  const reason = typeof rawReason === 'object' && rawReason !== null
    ? asString(asRecord(rawReason).code) ?? 'UNKNOWN'
    : asString(rawReason)
  return { executable, disabledReason: executable ? null : reason ?? 'UNKNOWN' }
}

/**
 * Normalize only structured Host action availability. Legacy string arrays
 * describe lifecycle possibilities, not authority, so they remain disabled.
 */
export function normalizeConsoleAllowedActions(input: unknown): Record<string, ConsoleActionCapability> {
  const actions: Record<string, ConsoleActionCapability> = {}
  if (Array.isArray(input)) {
    for (const value of input) {
      if (typeof value === 'string') {
        actions[value] = { executable: false, disabledReason: 'UNKNOWN' }
        continue
      }
      const item = asRecord(value)
      const action = asString(item.action ?? item.name)
      if (action !== null) actions[action] = capabilityEntry(item)
    }
    return actions
  }
  for (const [name, value] of Object.entries(asRecord(input))) {
    actions[name] = capabilityEntry(value)
  }
  return actions
}

/** Normalize the Host response without treating any browser field as authority. */
export function normalizeConsoleCapabilities(input: unknown, nowMs = Date.now()): ConsoleCapabilities {
  const root = asRecord(input)
  const control = asRecord(root.controlSession ?? root.control_session)
  const session = asRecord(root.session)
  const rawState = root.state ?? root.status ?? control.state ?? session.state ?? root.sessionState
  let state = capabilityState(rawState)
  if (root.active === true && state === 'UNKNOWN') state = 'ACTIVE'
  if (root.active === false && state === 'UNKNOWN') state = 'INACTIVE'
  const expiresAt = asString(root.expiresAt ?? root.expires_at ?? control.expiresAt ?? control.expires_at ?? session.expiresAt)
  if (state === 'ACTIVE' && expiresAt !== null) {
    const expiryMs = Date.parse(expiresAt)
    if (Number.isFinite(expiryMs) && expiryMs <= nowMs) state = 'EXPIRED'
  }

  const actions = normalizeConsoleAllowedActions(root.allowedActions ?? root.allowed_actions)
  const rawActions = asRecord(root.actions ?? root.capabilities ?? root.commandCoverage ?? root.command_coverage)
  for (const [name, value] of Object.entries(rawActions)) {
    if (actions[name] === undefined) actions[name] = capabilityEntry(value)
  }
  const commands = Array.isArray(root.commands) ? root.commands : []
  const rawReviewDecisions = root.reviewDecisions ?? root.review_decisions
  const reviewDecisions = Array.isArray(rawReviewDecisions)
    ? rawReviewDecisions.filter((value): value is string => typeof value === 'string').slice(0, 16)
    : []
  const rawSandboxModes = root.sandboxModes ?? root.sandbox_modes
  const sandboxModes = Array.isArray(rawSandboxModes)
    ? rawSandboxModes.filter((value): value is string => typeof value === 'string').slice(0, 16)
    : []
  const disabledReason = asString(root.disabledReason ?? root.disabled_reason ?? root.errorCode)
  const csrfToken = asString(root.csrfToken ?? root.csrf_token ?? control.csrfToken ?? session.csrfToken)
  const roleSessionBound = root.roleSessionBound === true
    || control.roleSessionBound === true
    || session.roleSessionBound === true
  return {
    state,
    active: root.active === true || state === 'ACTIVE',
    expiresAt,
    csrfToken,
    roleSessionBound,
    commands: commands.filter((command): command is string => typeof command === 'string'),
    reviewDecisions,
    sandboxModes,
    disabledReason,
    actions,
  }
}

function aliasesFor(action: string): string[] {
  return ACTION_ALIASES[action] ?? [action]
}

/** Resolve a UI button state; this is presentation gating, not authorization. */
export function resolveConsoleActionState(
  capabilities: ConsoleCapabilities | null | undefined,
  action: string,
  ownerOnly = false,
): ConsoleActionState {
  if (ownerOnly) {
    return { action, executable: false, disabledReason: 'DIRECT_SLASH_REQUIRED' }
  }
  const disabledForSession = capabilities?.state === 'EXPIRED'
    || capabilities?.state === 'REVOKED'
    || capabilities?.state === 'INACTIVE'
  if (!capabilities || capabilities.state === 'UNKNOWN' || capabilities.state === 'FAILED') {
    return { action, executable: false, disabledReason: 'UNKNOWN' }
  }
  if (disabledForSession) {
    return { action, executable: false, disabledReason: 'SESSION_AUTH_REQUIRED' }
  }
  const entry = aliasesFor(action)
    .map(alias => capabilities.actions[alias])
    .find(candidate => candidate !== undefined)
  if (entry?.executable === true) return { action, executable: true, disabledReason: null }
  return {
    action,
    executable: false,
    disabledReason: entry?.disabledReason ?? 'UNKNOWN',
  }
}

/** Require both the live control view and resource-scoped Host projection. */
export function resolveConsoleResourceActionState(
  capabilities: ConsoleCapabilities | null | undefined,
  allowedActions: unknown,
  action: string,
): ConsoleActionState {
  const control = resolveConsoleActionState(capabilities, action)
  if (!control.executable) return control
  const resourceActions = normalizeConsoleAllowedActions(allowedActions)
  const entry = aliasesFor(action)
    .map(alias => resourceActions[alias])
    .find(candidate => candidate !== undefined)
  if (entry?.executable === true) return { action, executable: true, disabledReason: null }
  return { action, executable: false, disabledReason: entry?.disabledReason ?? 'UNKNOWN' }
}

/** Parse the single-page fragment without rewriting unknown locations. */
export function parseConsoleFragment(hash: string): ConsoleFragmentState {
  const fragment = hash.replace(/^#/u, '')
  if (fragment === '' || fragment === 'overview') {
    return { known: true, section: 'overview', taskId: null }
  }
  if (fragment.startsWith('task=')) {
    try {
      const taskId = decodeURIComponent(fragment.slice('task='.length))
      return taskId.length > 0
        ? { known: true, section: 'tasks', taskId }
        : { known: false, section: 'overview', taskId: null }
    } catch {
      return { known: false, section: 'overview', taskId: null }
    }
  }
  if (['organization', 'tasks', 'executions', 'activity', 'management', 'ledger'].includes(fragment)) {
    return { known: true, section: fragment as ConsoleSection, taskId: null }
  }
  return { known: false, section: 'overview', taskId: null }
}

/** Prevent a slower Task-detail request from replacing a newer selection. */
export function shouldCommitConsoleTaskDetail(
  selectedTaskId: string,
  requestedTaskId: string,
  detail: unknown,
  requestEpoch: number,
  currentEpoch: number,
): boolean {
  if (requestEpoch !== currentEpoch || requestedTaskId !== selectedTaskId) return false
  const detailTaskId = asString(asRecord(asRecord(detail).task).taskId)
  return detailTaskId === requestedTaskId
}

/**
 * Build a command request from UI data and strip fields that must never be
 * accepted as an identity claim from the browser.
 */
export function buildConsoleCommand(name: string, payload: Record<string, unknown>): ConsoleCommandEnvelope {
  const safePayload = Object.fromEntries(
    Object.entries(payload).filter(([key]) => !AUTHORITY_FIELDS.has(key)),
  )
  return { name: name.trim(), payload: safePayload }
}

export function consoleEvidenceLabel(kind: unknown): string {
  switch (kind) {
    case 'GOVERNANCE_FACT': return '治理事实'
    case 'RUNTIME_OBSERVATION': return '运行观察'
    case 'WORKER_CLAIM': return '执行者呈报'
    case 'DERIVED_EXPLANATION': return '派生解释'
    default: return '尚未确认'
  }
}

const CONSOLE_APP_TEMPLATE = String.raw`<!doctype html>
<html lang="zh-CN" data-theme="forest">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='12' fill='%230E2528'/%3E%3Cpath d='M32 9 52 20v24L32 55 12 44V20z' fill='%23C99A4B'/%3E%3C/svg%3E">
  <title>Agent Kingdom · AgenticKingdom 治理档案</title>
  <style>
    :root {
      color-scheme: light;
      --gate: #E9DEC7;
      --gate-deep: #F4EAD5;
      --patina: #FFF9EB;
      --patina-raised: #F7EEDB;
      --panel-soft: rgba(255, 249, 234, .62);
      --field-bg: #F6EBD7;
      --bamboo: #392C20;
      --gold: #B38A4E;
      --jade: #3D734E;
      --cinnabar: #B75227;
      --danger-text: #B75227;
      --ink: #392C20;
      --muted: #78634D;
      --dim: #9A8468;
      --line: rgba(120, 99, 77, .22);
      --line-strong: rgba(179, 138, 78, .58);
      --shadow: 0 13px 30px rgba(79, 56, 27, .10);
      font-family: "Microsoft YaHei UI", "PingFang SC", sans-serif;
      background: var(--gate);
      color: var(--bamboo);
    }
    * { box-sizing: border-box; }
    html { background: var(--gate); scroll-behavior: smooth; }
    body { margin: 0; min-width: 320px; overflow-x: hidden; background: var(--gate); color: var(--bamboo); }
    button, input, textarea, select { font: inherit; }
    button { cursor: pointer; }
    button:disabled { cursor: not-allowed; }
    a:focus-visible, button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, summary:focus-visible {
      outline: 3px solid var(--gold); outline-offset: 3px;
    }
    h1, h2, h3, p { margin: 0; }
    h1, .display-title { font-family: STKaiti, KaiTi, "Noto Serif SC", serif; font-weight: 700; }
    h1 { font-size: 1.8rem; letter-spacing: .04em; line-height: 1.1; }
    h2 { font-size: clamp(1.15rem, 2vw, 1.55rem); line-height: 1.25; }
    h3 { font-size: .94rem; line-height: 1.35; }
    code, .mono, .meta, .button-reason, .evidence-kind, .source-ref, .code-badge {
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    a { color: inherit; }
    .console-shell { display: block; min-height: 100vh; }
    .realm-sidebar { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; gap: 26px; padding: 28px 20px 22px; background: var(--gate-deep); border-right: 1px solid var(--line); }
    .realm-brand { display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 12px; align-items: center; }
    .realm-seal { display: grid; place-items: center; width: 44px; height: 44px; border: 1px solid var(--gold); border-radius: 50% 50% 45% 45%; color: var(--gold); font: 1.35rem STKaiti, KaiTi, serif; }
    .brand-kicker, .section-kicker { color: var(--gold); font-size: .7rem; font-weight: 700; letter-spacing: .12em; }
    .brand-note { margin-top: 6px; color: var(--dim); font-size: .74rem; line-height: 1.45; }
    .main-nav { display: grid; gap: 5px; }
    .main-nav a { display: flex; align-items: center; justify-content: space-between; min-height: 42px; padding: 9px 11px; border-left: 2px solid transparent; color: var(--muted); text-decoration: none; }
    .main-nav a::after { content: "›"; color: var(--dim); }
    .main-nav a:hover, .main-nav a[aria-current="page"] { border-left-color: var(--gold); color: var(--bamboo); background: rgba(201, 154, 75, .08); }
    .main-nav a[aria-current="page"]::after { color: var(--gold); }
    .sidebar-boundary { margin-top: auto; padding: 13px 12px; background: rgba(79, 175, 131, .06); border-top: 1px solid rgba(79, 175, 131, .34); }
    .sidebar-boundary h2 { font: 700 .74rem "Microsoft YaHei UI", sans-serif; color: var(--jade); }
    .sidebar-boundary p { margin-top: 7px; color: var(--muted); font-size: .72rem; line-height: 1.55; }
    .console-main { min-width: 0; width: min(100% - 48px, 1320px); margin: 0 auto; padding: 30px 0 56px; }
    .kingdom-status { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding: 0 0 22px; border-bottom: 1px solid var(--line); }
    .kingdom-status h2 { margin-top: 7px; font-family: STKaiti, KaiTi, "Noto Serif SC", serif; font-size: clamp(1.55rem, 4vw, 2.4rem); letter-spacing: .02em; }
    .kingdom-status p:not(.section-kicker) { max-width: 64ch; margin-top: 8px; color: var(--muted); line-height: 1.6; }
    .control-stack { display: flex; align-items: flex-end; flex-direction: column; gap: 9px; flex: 0 0 auto; max-width: 100%; }
    .session-chip { display: inline-flex; align-items: center; gap: 8px; padding: 7px 10px; background: var(--patina); color: var(--muted); font-size: .72rem; white-space: nowrap; }
    .session-chip code, .code-badge { padding: 2px 5px; border-radius: 3px; background: rgba(232, 224, 206, .09); color: var(--dim); font-size: .65rem; letter-spacing: .04em; }
    .session-chip[data-state="ACTIVE"] { color: var(--jade); }
    .session-chip[data-state="ACTIVE"] code { color: var(--jade); }
    .session-chip[data-state="EXPIRED"], .session-chip[data-state="REVOKED"], .session-chip[data-state="FAILED"] { color: var(--danger-text); }
    .status-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 46px; padding: 10px 0; }
    .status-text { min-width: 0; color: var(--muted); font-size: .84rem; overflow-wrap: anywhere; }
    .status-text[data-level="success"] { color: var(--jade); }
    .status-text[data-level="error"], .status-text[data-level="unknown"] { color: var(--danger-text); }
    .status-text[data-level="stale"] { color: var(--gold); }
    .status-technical { width: 100%; margin: -2px 0 16px; color: var(--dim); font-size: .7rem; }
    .status-technical summary { width: fit-content; cursor: pointer; color: var(--dim); }
    .status-technical code { display: block; max-width: 100%; margin-top: 7px; padding: 8px 10px; background: var(--gate-deep); overflow-wrap: anywhere; }
    .refresh, .secondary { min-height: 38px; border: 1px solid var(--line); border-radius: 5px; background: transparent; color: var(--bamboo); padding: 8px 12px; }
    .refresh:hover:not(:disabled), .secondary:hover:not(:disabled) { border-color: var(--gold); color: var(--gold); }
    .skip-link { position: absolute; left: -9999px; top: 8px; z-index: 20; background: var(--gold); color: var(--gate-deep); padding: 8px 10px; border-radius: 4px; }
    .skip-link:focus { left: 8px; }
    .status-glossary { margin: 0 0 18px; color: var(--muted); font-size: .74rem; }
    .status-glossary summary { width: fit-content; cursor: pointer; color: var(--dim); }
    .glossary-list { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-top: 10px; padding: 12px; background: rgba(232, 224, 206, .035); }
    .glossary-list span { line-height: 1.55; }
    .glossary-list code { margin-left: 4px; color: var(--gold); }
    .capability-card { display: grid; grid-template-columns: minmax(220px, .85fr) minmax(0, 1.65fr); gap: 22px; align-items: center; padding: 15px 17px; margin-bottom: 20px; background: var(--patina); border-top: 1px solid rgba(79, 175, 131, .4); }
    .capability-card h2 { margin-top: 4px; font-size: 1rem; }
    .capability-copy { color: var(--muted); font-size: .8rem; line-height: 1.55; }
    .capability-copy strong { color: var(--bamboo); }
    .capability-actions { display: flex; justify-content: space-between; gap: 16px; align-items: center; }
    .capability-actions > * { min-width: 0; }
    .zones { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; position: relative; }
    .zone { min-width: 0; padding: 20px; background: var(--patina); border-top: 1px solid var(--line-strong); box-shadow: var(--shadow); }
    .zone-wide { grid-column: 1 / -1; }
    .zone-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding-bottom: 13px; margin-bottom: 16px; border-bottom: 1px solid var(--line); }
    .zone-head p { color: var(--dim); font-size: .74rem; }
    .council-zone { padding: 0; background: transparent; border-top: 0; box-shadow: none; }
    .council-zone > .zone-head { padding-inline: 2px; }
    .council-grid { display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(280px, .85fr); gap: 16px; align-items: stretch; }
    .realm-map, .attention-council { min-width: 0; margin: 0; padding: 18px; background: var(--patina); border-top: 2px solid var(--gold); box-shadow: var(--shadow); }
    .realm-map > summary { cursor: pointer; font-weight: 700; color: var(--bamboo); }
    .map-intro { margin: 9px 0 18px; color: var(--muted); font-size: .78rem; line-height: 1.55; }
    .realm-path { position: relative; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; margin: 8px 0 18px; }
    .realm-path::before { content: ""; position: absolute; left: 8%; right: 8%; top: 50%; height: 1px; background: rgba(201, 154, 75, .44); }
    .realm-node { position: relative; z-index: 1; display: grid; gap: 5px; min-width: 0; min-height: 102px; align-content: center; padding: 12px 10px; background: var(--gate); color: var(--muted); text-align: center; text-decoration: none; }
    .realm-node:hover { background: var(--patina-raised); color: var(--bamboo); }
    .realm-node strong { color: var(--bamboo); font-size: .84rem; overflow-wrap: anywhere; }
    .realm-node small { color: var(--dim); font-size: .68rem; line-height: 1.35; }
    .realm-node .code-badge { justify-self: center; }
    .territory-shelf { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-bottom: 14px; }
    .territory-link { min-width: 0; padding: 9px 10px; background: rgba(232, 224, 206, .045); color: var(--muted); text-decoration: none; overflow-wrap: anywhere; }
    .territory-link:hover { background: rgba(79, 175, 131, .1); color: var(--bamboo); }
    .territory-link strong, .territory-link span { display: block; }
    .territory-link strong { color: var(--bamboo); font-size: .78rem; }
    .territory-link span { margin-top: 3px; font-size: .68rem; }
    .attention-council { border-top-color: var(--cinnabar); }
    .attention-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 13px; }
    .attention-heading p { color: var(--dim); font-size: .7rem; }
    .task-layout { display: grid; grid-template-columns: minmax(210px, .72fr) minmax(0, 2fr); gap: 18px; }
    .task-navigator { min-width: 0; padding-right: 16px; border-right: 1px solid var(--line); }
    .task-nav-list { display: grid; gap: 7px; margin-top: 11px; }
    .task-link { display: grid; gap: 4px; min-width: 0; padding: 9px 10px; border-left: 2px solid var(--line); color: var(--muted); text-decoration: none; overflow-wrap: anywhere; }
    .task-link strong { color: var(--bamboo); font-size: .8rem; }
    .task-link:hover, .task-link[aria-current="page"] { border-left-color: var(--gold); background: rgba(201, 154, 75, .06); }
    .organization-grid, .execution-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .owner-management { padding: 15px; background: rgba(201, 154, 75, .06); border-top: 1px solid var(--gold); }
    .owner-management code { display: block; margin-top: 11px; padding: 9px; color: var(--gold); background: var(--gate-deep); overflow-wrap: anywhere; user-select: all; }
    .owner-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; margin-top: 10px; }
    .owner-actions button { min-width: 0; white-space: normal; }
    .evidence-rail { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; background: var(--line); }
    .rail-item { min-width: 0; padding: 10px 11px; background: var(--gate); }
    .rail-item[data-kind="GOVERNANCE_FACT"] { box-shadow: inset 0 2px 0 var(--gold); }
    .rail-item[data-kind="RUNTIME_OBSERVATION"] { box-shadow: inset 0 2px 0 var(--jade); }
    .rail-item[data-kind="WORKER_CLAIM"] { box-shadow: inset 0 2px 0 #AFA0D8; }
    .rail-item[data-kind="DERIVED_EXPLANATION"] { box-shadow: inset 0 2px 0 var(--cinnabar); }
    .rail-item span { display: block; color: var(--bamboo); font-size: .75rem; }
    .rail-item code { display: block; margin-top: 4px; color: var(--dim); font-size: .62rem; overflow-wrap: anywhere; }
    .metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; margin-top: 10px; background: var(--line); }
    .metric { min-width: 0; padding: 10px; background: var(--gate); text-decoration: none; }
    .metric strong { display: block; color: var(--gold); font: 1.05rem ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
    .metric span { display: block; margin-top: 4px; color: var(--muted); font-size: .68rem; }
    .metric .code-badge { display: inline-block; margin-top: 5px; }
    .data-list, .attention-list, .timeline-list { display: grid; gap: 8px; }
    .data-row, .timeline-item, .attention-item { min-width: 0; padding: 9px 10px; border-left: 2px solid var(--line); background: rgba(232, 224, 206, .035); overflow-wrap: anywhere; }
    .data-row { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
    .data-row span:first-child { color: var(--muted); }
    .data-row strong { text-align: right; }
    .state-value { display: inline-flex; justify-content: flex-end; align-items: center; gap: 7px; flex-wrap: wrap; }
    .timeline-item { border-left-color: var(--jade); }
    .attention-item { border-left-color: var(--gold); }
    .attention-item[data-severity="CRITICAL"] { border-left-color: var(--cinnabar); }
    .attention-item[data-severity="UNKNOWN"] { border-left-color: var(--dim); }
    .timeline-item p, .attention-item p { color: var(--bamboo); line-height: 1.5; }
    .meta { color: var(--muted); font-size: .72rem; line-height: 1.45; overflow-wrap: anywhere; }
    .source-ref { color: var(--dim); font-size: .68rem; margin-top: 6px; }
    .evidence-kind { display: inline-block; max-width: 100%; margin-bottom: 5px; padding: 3px 6px; background: rgba(232, 224, 206, .07); color: var(--dim); font-size: .64rem; white-space: normal; overflow-wrap: anywhere; }
    .action-dock { margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--line); }
    .action-dock-head { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
    .action-dock-head p { max-width: 58ch; color: var(--muted); font-size: .78rem; line-height: 1.5; }
    .forms { display: grid; gap: 8px; }
    details.form-card { padding: 0 14px 14px; background: var(--patina); border-left: 2px solid var(--line); }
    details.form-card summary { cursor: pointer; color: var(--bamboo); padding: 14px 2px; font-weight: 700; }
    .form-card[open] { border-left-color: var(--gold); }
    .form-card[open] summary { color: var(--gold); }
    .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .field { display: grid; gap: 5px; min-width: 0; }
    .field-wide { grid-column: 1 / -1; }
    label { color: var(--muted); font-size: .78rem; }
    input, textarea, select { width: 100%; min-height: 40px; border: 1px solid var(--line); border-radius: 4px; background: var(--gate-deep); color: var(--bamboo); padding: 8px 9px; }
    textarea { min-height: 76px; resize: vertical; }
    .form-actions { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin-top: 10px; }
    .primary { min-height: 40px; border: 1px solid var(--jade); border-radius: 4px; background: rgba(79, 175, 131, .12); color: #A9E2C5; padding: 8px 13px; font-weight: 700; }
    .primary:hover:not(:disabled) { background: rgba(79, 175, 131, .22); }
    .primary.danger { border-color: var(--cinnabar); background: rgba(209, 91, 75, .11); color: var(--danger-text); }
    .primary:disabled { border-color: var(--line); background: transparent; color: var(--dim); }
    .decision-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
    .decision-action { display: grid; gap: 5px; align-content: start; }
    .decision-action .primary { width: 100%; }
    .button-reason { color: var(--gold); font-size: .66rem; line-height: 1.35; }
    .hint { color: var(--dim); font-size: .72rem; line-height: 1.45; }
    .empty { color: var(--dim); font-size: .84rem; padding: 8px 0; }
    .danger-note { color: var(--gold); font-size: .74rem; margin-top: 10px; line-height: 1.55; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    [hidden] { display: none !important; }
    @media (max-width: 920px) {
      .console-shell { grid-template-columns: minmax(0, 1fr); }
      .realm-sidebar { position: static; height: auto; min-height: 0; padding: 18px max(16px, 4vw) 12px; border-right: 0; border-bottom: 1px solid var(--line); }
      .realm-brand { max-width: 420px; }
      .main-nav { display: flex; gap: 4px; overflow-x: auto; padding-bottom: 5px; scrollbar-width: thin; }
      .main-nav a { flex: 0 0 auto; border-left: 0; border-bottom: 2px solid transparent; padding: 8px 10px; }
      .main-nav a::after { display: none; }
      .main-nav a:hover, .main-nav a[aria-current="page"] { border-left-color: transparent; border-bottom-color: var(--gold); }
      .sidebar-boundary { display: none; }
      .console-main { width: min(100% - 32px, 1320px); padding-top: 22px; }
    }
    @media (max-width: 700px) {
      .kingdom-status, .status-bar, .capability-actions, .action-dock-head { align-items: flex-start; flex-direction: column; }
      .control-stack { align-items: flex-start; }
      .capability-actions > .form-actions { width: 100%; }
      .capability-card, .zones, .council-grid { grid-template-columns: minmax(0, 1fr); }
      .zone-wide, .evidence-rail { grid-column: auto; }
      .evidence-rail { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .attention-council { order: -1; }
      .realm-path { grid-template-columns: minmax(0, 1fr); }
      .realm-path::before { display: none; }
      .territory-shelf { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .task-layout, .organization-grid, .execution-grid, .form-grid { grid-template-columns: minmax(0, 1fr); }
      .task-navigator { border-right: 0; border-bottom: 1px solid var(--line); padding: 0 0 12px; }
      .field-wide { grid-column: auto; }
    }
    @media (max-width: 640px) {
      .console-shell, .realm-sidebar, .console-main, .main-nav, .kingdom-status, .control-stack, .status-bar, .status-glossary,
      .capability-card, .capability-actions, .zones, .zone, .council-grid, .realm-map, .attention-council, .evidence-rail,
      .rail-item, .organization-grid, .task-layout, .task-navigator, .execution-grid, .action-dock, .forms,
      details.form-card, .form-grid, .field, .decision-actions, .decision-action {
        min-width: 0;
        width: 100%;
        max-width: 100%;
      }
      .capability-card, .zones, .council-grid, .realm-path, .task-layout, .organization-grid, .execution-grid, .form-grid {
        grid-template-columns: minmax(0, 1fr);
      }
      .metric-grid, .evidence-rail, .territory-shelf, .owner-actions, .decision-actions {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .zone-wide, .evidence-rail, .field-wide { grid-column: auto; }
      .kingdom-status, .status-bar, .capability-actions, .action-dock-head, .zone-head, .attention-heading {
        align-items: flex-start;
        flex-direction: column;
      }
      .zone-head > *, .attention-heading > *, .data-row > * {
        min-width: 0;
        max-width: 100%;
        overflow-wrap: anywhere;
      }
      .session-chip { max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
      .status-text, .status-technical, .status-technical code, .kingdom-status p, .capability-copy, .meta, .hint, .empty,
      .button-reason, .data-row, .timeline-item, .attention-item, .realm-node, .rail-item, .metric, label, code {
        overflow-wrap: anywhere;
      }
      input, textarea, select, button { min-width: 0; max-width: 100%; }
      .evidence-rail .rail-item code { display: none; }
      #overview { order: 1; }
      #tasks { order: 2; }
      #executions { order: 3; }
      #organization { order: 4; }
      #activity { order: 5; }
      .evidence-rail { order: 6; }
    }
    @media (max-width: 390px) {
      .realm-sidebar { padding-inline: 12px; }
      .realm-brand { grid-template-columns: 38px minmax(0, 1fr); }
      .realm-seal { width: 38px; height: 38px; }
      .console-main { width: calc(100% - 16px); padding-bottom: 32px; }
      .main-nav { margin-inline: -2px; }
      .main-nav a { padding-inline: 9px; }
      .zone, .realm-map, .attention-council, details.form-card { padding-left: 11px; padding-right: 11px; }
      .realm-path, .territory-shelf, .decision-actions { grid-template-columns: minmax(0, 1fr); }
      .realm-node { min-height: 78px; text-align: left; }
      .realm-node .code-badge { justify-self: start; }
      .data-row { align-items: flex-start; flex-direction: column; gap: 3px; }
      .data-row strong, .state-value { justify-content: flex-start; text-align: left; }
      .form-actions .primary, .form-actions .refresh { width: 100%; }
      .owner-actions { grid-template-columns: minmax(0, 1fr); }
    }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; } }
    /* 0.8 owner-specified visual target: the console is a warm governance
       dossier. Keep the existing controls and evidence semantics, but move
       their chrome behind the organization map instead of presenting a dark
       admin rail. */
    :root {
      color-scheme: light;
      --gate: #E9DEC7;
      --gate-deep: #F4EAD5;
      --patina: #FFF9EB;
      --patina-raised: #F7EEDB;
      --bamboo: #392C20;
      --gold: #B38A4E;
      --jade: #3D734E;
      --cinnabar: #B75227;
      --danger-text: #B75227;
      --ink: #392C20;
      --muted: #78634D;
      --dim: #9A8468;
      --line: rgba(120, 99, 77, .22);
      --line-strong: rgba(179, 138, 78, .58);
      --shadow: 0 13px 30px rgba(79, 56, 27, .10);
      --texture: rgba(179, 138, 78, .035);
      --status-blocked: #A4373E;
      --status-blocked-wash: rgba(164, 55, 62, .12);
      --status-running: #B9821D;
      --status-running-wash: rgba(185, 130, 29, .14);
      --status-review: #5B67A4;
      --status-review-wash: rgba(91, 103, 164, .13);
      --status-done: #3D734E;
      --status-done-wash: rgba(61, 115, 78, .13);
      --status-idle: #6D665C;
      --status-idle-wash: rgba(109, 102, 92, .10);
      --status-unknown: #C26722;
      --status-unknown-wash: rgba(194, 103, 34, .13);
      --territory-1: #6F846D;
      --territory-2: #806B7B;
      --territory-3: #6F7880;
      --territory-4: #8D744E;
      --territory-5: #647D88;
      --territory-6: #8B5E5E;
      --territory-1-wash: rgba(91, 119, 91, .14);
      --territory-2-wash: rgba(119, 88, 108, .13);
      --territory-3-wash: rgba(91, 105, 117, .13);
      --territory-4-wash: rgba(141, 116, 78, .13);
      --territory-5-wash: rgba(100, 125, 136, .13);
      --territory-6-wash: rgba(139, 94, 94, .13);
      font-family: "Noto Sans SC", "Microsoft YaHei", sans-serif;
      background: var(--gate);
      color: var(--bamboo);
    }
    html[data-theme="night"] {
      color-scheme: dark;
      --gate: #101722;
      --gate-deep: #0F1621;
      --patina: #1B2636;
      --patina-raised: #243449;
      --panel-soft: rgba(28, 39, 55, .74);
      --field-bg: #162131;
      --bamboo: #F5ECD9;
      --gold: #D5B56F;
      --jade: #8BC99C;
      --cinnabar: #EE8C83;
      --danger-text: #FFAAA2;
      --ink: #F5ECD9;
      --muted: #CEC2AD;
      --dim: #B5A995;
      --line: rgba(213, 182, 120, .28);
      --line-strong: rgba(218, 185, 119, .52);
      --shadow: 0 13px 30px rgba(0, 0, 0, .42);
      --texture: rgba(230, 205, 156, .05);
      --status-blocked: #EE8C83;
      --status-running: #E2B46C;
      --status-review: #A8B6EF;
      --status-done: #8FCBA3;
      --status-idle: #BEB6AA;
      --status-unknown: #F0A45B;
      --status-blocked-wash: rgba(238, 140, 131, .13);
      --status-running-wash: rgba(226, 180, 108, .13);
      --status-review-wash: rgba(168, 182, 239, .12);
      --status-done-wash: rgba(143, 203, 163, .12);
      --status-idle-wash: rgba(190, 182, 170, .09);
      --status-unknown-wash: rgba(240, 164, 91, .13);
      --territory-1: #8FB69A;
      --territory-2: #C2A1BA;
      --territory-3: #AEBDCA;
      --territory-4: #D0B56E;
      --territory-5: #82B2C2;
      --territory-6: #C18B78;
      --territory-1-wash: rgba(102, 151, 117, .16);
      --territory-2-wash: rgba(170, 112, 151, .14);
      --territory-3-wash: rgba(118, 145, 166, .14);
      --territory-4-wash: rgba(208, 181, 110, .14);
      --territory-5-wash: rgba(130, 178, 194, .14);
      --territory-6-wash: rgba(193, 139, 120, .14);
    }
    html[data-theme="forest"] {
      color-scheme: dark;
      --gate: #14251D;
      --gate-deep: #12231B;
      --patina: #203B2E;
      --patina-raised: #2A4C3B;
      --panel-soft: rgba(31, 56, 44, .76);
      --field-bg: #193126;
      --bamboo: #F3EAD9;
      --gold: #CBAA65;
      --jade: #91CEA0;
      --cinnabar: #EF9186;
      --danger-text: #FFADA3;
      --ink: #F3EAD9;
      --muted: #CEC0AA;
      --dim: #B7AA94;
      --line: rgba(204, 172, 104, .27);
      --line-strong: rgba(209, 174, 103, .50);
      --shadow: 0 13px 30px rgba(0, 0, 0, .40);
      --texture: rgba(221, 194, 136, .05);
      --status-blocked: #EF9186;
      --status-running: #DFB268;
      --status-review: #ACB8ED;
      --status-done: #90CCA1;
      --status-idle: #C0B8AA;
      --status-unknown: #F0A45B;
      --status-blocked-wash: rgba(239, 145, 134, .13);
      --status-running-wash: rgba(223, 178, 104, .13);
      --status-review-wash: rgba(172, 184, 237, .12);
      --status-done-wash: rgba(144, 204, 161, .12);
      --status-idle-wash: rgba(192, 184, 170, .09);
      --status-unknown-wash: rgba(240, 164, 91, .13);
      --territory-1: #91C39F;
      --territory-2: #C5A5BC;
      --territory-3: #AEBFC8;
      --territory-4: #D2AD6B;
      --territory-5: #78AEB1;
      --territory-6: #C78D78;
      --territory-1-wash: rgba(111, 172, 126, .15);
      --territory-2-wash: rgba(172, 118, 155, .13);
      --territory-3-wash: rgba(122, 151, 162, .13);
      --territory-4-wash: rgba(210, 173, 107, .14);
      --territory-5-wash: rgba(120, 174, 177, .14);
      --territory-6-wash: rgba(199, 141, 120, .14);
    }
    html[data-theme="forest"], html[data-theme="forest"] body {
      background-image:
        radial-gradient(circle at 12% 5%, rgba(145, 195, 159, .10), transparent 28%),
        radial-gradient(circle at 88% 16%, rgba(203, 170, 101, .08), transparent 24%),
        repeating-linear-gradient(122deg, var(--texture) 0, var(--texture) 1px, transparent 1px, transparent 22px);
    }
    html[data-theme="wine"] {
      color-scheme: dark;
      --gate: #251419;
      --gate-deep: #251319;
      --patina: #3D222A;
      --patina-raised: #4C2A35;
      --panel-soft: rgba(60, 32, 40, .76);
      --field-bg: #321B23;
      --bamboo: #F6E9D7;
      --gold: #D3A45F;
      --jade: #91CA9D;
      --cinnabar: #F08D84;
      --danger-text: #FFAAA2;
      --ink: #F6E9D7;
      --muted: #D0BEA8;
      --dim: #B8A58F;
      --line: rgba(214, 168, 97, .27);
      --line-strong: rgba(215, 168, 95, .50);
      --shadow: 0 13px 30px rgba(0, 0, 0, .42);
      --texture: rgba(225, 190, 133, .05);
      --status-blocked: #F08D84;
      --status-running: #E0AF67;
      --status-review: #AAB7EA;
      --status-done: #91C79E;
      --status-idle: #C0B5AA;
      --status-unknown: #F2A15A;
      --status-blocked-wash: rgba(240, 141, 132, .13);
      --status-running-wash: rgba(224, 175, 103, .13);
      --status-review-wash: rgba(170, 183, 234, .12);
      --status-done-wash: rgba(145, 199, 158, .12);
      --status-idle-wash: rgba(192, 181, 170, .09);
      --status-unknown-wash: rgba(242, 161, 90, .13);
      --territory-1: #91BEA0;
      --territory-2: #D1A9C0;
      --territory-3: #B4C0CC;
      --territory-4: #D5B16B;
      --territory-5: #8DB5BE;
      --territory-6: #C99275;
      --territory-1-wash: rgba(103, 157, 119, .14);
      --territory-2-wash: rgba(185, 118, 153, .15);
      --territory-3-wash: rgba(126, 148, 169, .13);
      --territory-4-wash: rgba(213, 177, 107, .14);
      --territory-5-wash: rgba(141, 181, 190, .14);
      --territory-6-wash: rgba(201, 146, 117, .14);
    }
    html, body {
      background-color: var(--gate);
      background-image: repeating-linear-gradient(122deg, var(--texture) 0, var(--texture) 1px, transparent 1px, transparent 22px);
      color: var(--bamboo);
    }
    h1, h2, h3, .display-title { font-family: "Noto Serif SC", "Source Han Serif SC", STSong, serif; }
    .console-shell { display: block; min-height: 100vh; }
    .realm-sidebar { position: relative; top: auto; z-index: 5; width: 100%; height: 84px; min-height: 84px; display: flex; flex-direction: row; align-items: center; gap: clamp(18px, 4vw, 72px); padding: 12px max(18px, 5vw); background: var(--gate-deep); border: 0; border-bottom: 1px solid var(--line); box-shadow: 0 2px 14px rgba(79, 56, 27, .08); }
    .realm-brand { flex: 0 0 auto; grid-template-columns: 38px minmax(0, 1fr); gap: 10px; }
    .realm-seal { width: 38px; height: 38px; border-color: var(--gold); color: var(--gold); }
    .realm-seal-icon { width: 25px; height: 28px; display: block; }
    .realm-brand h1 { font-size: 1.18rem; letter-spacing: .02em; }
    .brand-kicker { color: var(--bamboo); letter-spacing: .04em; font-size: .64rem; }
    .brand-note { margin-top: 2px; color: var(--muted); font-size: .68rem; }
    .main-nav { display: flex; align-items: stretch; gap: clamp(2px, 1.4vw, 20px); margin-left: auto; }
    .main-nav a { min-height: 58px; padding: 18px 10px 12px; border: 0; border-bottom: 2px solid transparent; color: var(--muted); font-size: .78rem; }
    .main-nav a::after { display: none; }
    .main-nav a:hover, .main-nav a[aria-current="page"] { border: 0; border-bottom: 2px solid var(--gold); background: transparent; color: var(--bamboo); }
    .sidebar-boundary { display: none; }
    .console-main { width: min(100% - 40px, 1820px); margin: 0 auto; padding: 30px 0 60px; }
    .kingdom-status { align-items: flex-end; padding: 0 0 20px; border-bottom-color: var(--line-strong); }
    .kingdom-status h2 { color: var(--bamboo); font-size: clamp(1.65rem, 3.5vw, 2.4rem); }
    .kingdom-status p:not(.section-kicker) { color: var(--muted); }
    .section-kicker { color: var(--gold); letter-spacing: .16em; }
    .session-chip { background: var(--patina); border: 1px solid var(--line); color: var(--muted); }
    .session-chip[data-state="ACTIVE"] { color: var(--jade); }
    .refresh, .secondary { border-color: var(--line-strong); background: var(--patina); color: var(--bamboo); }
    .status-text { color: var(--muted); }
    .status-technical code, .owner-management code { background: #F0E3CA; }
    .status-glossary { color: var(--muted); }
    .glossary-list { background: rgba(255, 249, 235, .62); }
    .capability-card, .zone, .realm-map, .attention-council, details.form-card { background: var(--patina); box-shadow: var(--shadow); border-radius: 14px; }
    .capability-card { border-top-color: var(--gold); }
    .zones { display: block; }
    .zone { margin-top: 18px; border: 1px solid var(--line); border-top: 2px solid var(--gold); }
    .council-zone { margin-top: 0; padding: 0; border: 0; background: transparent; box-shadow: none; }
    .council-zone > .zone-head { padding-inline: 2px; }
    .council-grid { display: block; }
    .realm-map { position: relative; overflow: hidden; padding: clamp(18px, 2.4vw, 30px); border-top: 2px solid var(--gold); background-image: repeating-linear-gradient(-18deg, rgba(179, 138, 78, .025) 0, rgba(179, 138, 78, .025) 1px, transparent 1px, transparent 18px); }
    .realm-map::after { content: "✦"; position: absolute; right: 9%; top: 18%; color: rgba(179, 138, 78, .08); font-size: 8rem; line-height: 1; pointer-events: none; transform: rotate(-16deg); }
    .map-intro { color: var(--muted); }
    .realm-path { display: none; }
    .kingdom-organogram { position: relative; }
    .chancellor-card { position: relative; z-index: 2; display: grid; grid-template-columns: 64px minmax(0, 1fr) auto; align-items: center; gap: 16px; width: min(100%, 540px); margin: 0 auto 34px; padding: 14px 18px; background: var(--patina); border: 2px solid var(--cinnabar); box-shadow: var(--shadow); }
    .chancellor-card::after { content: ""; position: absolute; left: 50%; bottom: -35px; width: 1px; height: 35px; background: var(--gold); }
    .chancellor-card h3 { font-size: 1.08rem; color: var(--bamboo); }
    .chancellor-card p { margin-top: 4px; color: var(--muted); font-size: .74rem; line-height: 1.4; }
    .pixel-sprite { display: grid; place-items: center; width: 58px; height: 58px; overflow: hidden; image-rendering: pixelated; }
    .pixel-sprite > svg { display: block; width: 100%; height: 100%; image-rendering: pixelated; }
    .organogram-branches { --organogram-gap: 10px; position: relative; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--organogram-gap); padding-top: 20px; }
    .organogram-branches::before { content: ""; position: absolute; left: calc(16.6667% - 3.3333px); right: calc(16.6667% - 3.3333px); top: 0; height: 1px; background: var(--gold); }
    .organogram-branches[data-branch-count="0"] { grid-template-columns: minmax(0, 1fr); padding-top: 0; }
    .organogram-branches[data-branch-count="1"] { grid-template-columns: minmax(0, 1fr); }
    .organogram-branches[data-branch-count="2"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .organogram-branches[data-branch-count="3"] { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .organogram-branches[data-branch-count="0"]::before,
    .organogram-branches[data-branch-count="1"]::before { display: none; }
    .organogram-branches[data-branch-count="2"]::before { left: calc(25% - 2.5px); right: calc(25% - 2.5px); }
    .organogram-branches[data-branch-count="3"]::before { left: calc(16.6667% - 3.3333px); right: calc(16.6667% - 3.3333px); }
    .kingdom-organogram:has(> .organogram-branches[data-branch-count="0"]) > .chancellor-card::after { display: none; }
    .territory-column { position: relative; min-width: 0; padding: 20px 14px 16px; background: rgba(244, 234, 213, .56); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 6px 16px rgba(79, 56, 27, .06); }
    .territory-column[data-status="RUNNING"], .territory-column[data-status="ACTIVE"] { background: rgba(218, 232, 210, .56); border-color: rgba(61, 115, 78, .34); }
    .territory-column[data-status="REVIEW"], .territory-column[data-status="REWORK"] { background: rgba(232, 222, 239, .62); border-color: rgba(91, 103, 164, .32); }
    .territory-column[data-status="UNKNOWN"], .territory-column[data-status="FROZEN"], .territory-column[data-status="ARCHIVED"] { background: rgba(229, 229, 224, .7); border-color: rgba(109, 102, 92, .34); }
    .territory-column::before { content: ""; position: absolute; left: 50%; top: -20px; height: 20px; border-left: 1px solid var(--gold); }
    .territory-heading { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
    .territory-heading h3 { color: var(--bamboo); font-size: 1rem; }
    .territory-heading p { margin-top: 4px; color: var(--muted); font-size: .7rem; line-height: 1.4; }
    .territory-heading .code-badge { flex: 0 0 auto; }
    .org-connector { width: 1px; height: 18px; margin: 0 auto; background: var(--gold); }
    .org-node { position: relative; display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 10px; align-items: center; min-width: 0; padding: 10px; background: var(--patina); border: 1px solid var(--line); border-left: 3px solid var(--dim); border-radius: 10px; box-shadow: 0 4px 12px rgba(79, 56, 27, .07); }
    .org-node[data-status="RUNNING"], .org-node[data-status="ACTIVE"] { border-left-color: #2E6E87; }
    .org-node[data-status="REVIEW"], .org-node[data-status="REWORK"] { border-left-color: #5B67A4; }
    .org-node[data-status="DONE"], .org-node[data-status="ACCEPT"] { border-left-color: #3D734E; }
    .org-node[data-status="FAILED"], .org-node[data-status="CRITICAL"] { border-left-color: #B75227; }
    .org-node h4 { margin: 0; color: var(--bamboo); font: 700 .9rem/1.3 "Noto Serif SC", "Source Han Serif SC", STSong, serif; overflow-wrap: anywhere; }
    .org-node p { margin-top: 3px; color: var(--muted); font-size: .7rem; line-height: 1.4; overflow-wrap: anywhere; }
    .org-node .code-badge { display: inline-block; margin-top: 5px; }
    .worker-stack { display: grid; gap: 8px; margin-top: 10px; }
    .territory-column > .worker-stack { position: relative; }
    .territory-column > .worker-stack::before { content: ""; position: absolute; z-index: 0; left: 50%; top: -18px; bottom: 0; width: 1px; background: var(--gold); }
    .worker-stack .org-node { z-index: 1; grid-template-columns: 38px minmax(0, 1fr); padding: 8px; }
    .worker-stack .pixel-sprite { width: 38px; height: 38px; }
    .org-empty { padding: 12px; color: var(--muted); font-size: .76rem; border-left: 2px dashed var(--line-strong); background: rgba(255, 249, 235, .48); border-radius: 8px; }
    .org-node[data-stage-evidence="indeterminate"] { border-left-color: var(--gold); background: #FBF0D9; }
    .org-node[data-stage-evidence="unavailable"] { opacity: .72; }
    #territory-map-list { display: grid; }
    .organogram-branches > .unassigned-worker-rail,
    .organogram-branches > .org-empty { grid-column: 1 / -1; }
    .attention-council { margin-top: 16px; border: 1px solid var(--line); border-top: 2px solid var(--cinnabar); }
    .unassigned-worker-rail { display: grid; gap: 8px; margin-top: 12px; padding: 10px; border: 1px dashed var(--line-strong); border-radius: 10px; background: rgba(255, 249, 235, .72); }
    .unassigned-worker-rail > header { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
    .unassigned-worker-rail > header h3 { color: var(--bamboo); font-size: .82rem; }
    .unassigned-worker-rail > header p { color: var(--muted); font-size: .64rem; }
    .unassigned-worker-rail .worker-stack { margin-top: 0; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .evidence-rail { margin-top: 18px; background: var(--line); }
    .rail-item, .metric, .data-row, .timeline-item, .attention-item { background: var(--patina); }
    .organization-grid { display: block; }
    .owner-management { margin-top: 18px; background: rgba(244, 234, 213, .72); border-top-color: var(--gold); }
    input, textarea, select { background: #F6EBD7; color: var(--bamboo); border-color: var(--line-strong); }
    .primary { border-color: var(--jade); background: rgba(61, 115, 78, .10); color: var(--jade); }
    .primary.danger { border-color: var(--cinnabar); background: rgba(183, 82, 39, .08); color: var(--cinnabar); }
    @media (max-width: 760px) {
      .realm-sidebar { height: auto; min-height: 84px; flex-wrap: wrap; gap: 8px 18px; padding-block: 10px 0; }
      .main-nav { width: 100%; margin-left: 0; overflow-x: auto; }
      .main-nav a { min-height: 34px; padding: 5px 8px 9px; }
      .console-main { width: min(100% - 24px, 1820px); padding-top: 22px; }
      .kingdom-status { align-items: flex-start; }
    }
    /* P0 hero compression: the organization graph is the first readable
       artifact. Health, metrics, and technical state stay compact or
       secondary so the real topology reaches the fold. */
    .realm-sidebar { gap: clamp(14px, 3vw, 42px); }
    .main-nav a, .main-nav .nav-item { min-height: 58px; }
    .main-nav .nav-item { display: flex; align-items: center; gap: 5px; padding: 18px 10px 12px; border-bottom: 2px solid transparent; color: var(--muted); font-size: .78rem; }
    .main-nav .nav-note { color: var(--dim); font-size: .58rem; white-space: nowrap; }
    .main-nav .nav-disabled { cursor: not-allowed; opacity: .68; }
    .console-main { padding-top: 18px; }
    .kingdom-status { display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, .95fr); align-items: center; gap: 22px; padding-bottom: 12px; }
    .hero-copy { min-width: 0; }
    .hero-copy h2 { margin-top: 4px; font-size: clamp(1.45rem, 3vw, 2.15rem); }
    .hero-copy p:not(.section-kicker) { max-width: 60ch; margin-top: 5px; color: var(--muted); font-size: .72rem; line-height: 1.4; }
    .control-stack { display: grid; grid-template-columns: minmax(150px, .8fr) minmax(210px, 1.55fr) auto; align-items: center; gap: 7px; max-width: 100%; }
    .health-capsule { display: flex; align-items: center; min-width: 0; gap: 8px; padding: 7px 9px; background: var(--patina); border: 1px solid var(--line); border-radius: 6px; }
    .health-dot { flex: 0 0 9px; width: 9px; height: 9px; border-radius: 50%; background: var(--cinnabar); box-shadow: 0 0 0 3px rgba(183, 82, 39, .12); }
    .health-capsule[data-status="OK"] .health-dot, .health-capsule[data-status="HEALTHY"] .health-dot, .health-capsule[data-status="STABLE"] .health-dot { background: var(--jade); box-shadow: 0 0 0 3px rgba(61, 115, 78, .12); }
    .health-capsule[data-status="UNKNOWN"] .health-dot { background: var(--dim); box-shadow: 0 0 0 3px rgba(120, 99, 77, .12); }
    .health-copy { display: grid; min-width: 0; gap: 1px; }
    .health-copy small { color: var(--muted); font-size: .62rem; }
    .health-copy strong { min-width: 0; color: var(--bamboo); font-size: .76rem; overflow-wrap: anywhere; }
    .health-capsule .code-badge { margin-left: auto; }
    #overview-content.metric-grid { grid-column: 2; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; margin-top: 0; }
    #overview-content .metric { padding: 7px 8px; }
    #overview-content .metric strong { font-size: .88rem; }
    #overview-content .metric span { margin-top: 2px; font-size: .6rem; }
    .control-stack > #refresh-button { grid-column: 3; grid-row: 1; min-height: 32px; padding: 6px 10px; font-size: .7rem; }
    .status-bar { min-height: 28px; padding: 4px 0; }
    .status-text { font-size: .72rem; }
    .status-glossary { margin-bottom: 7px; font-size: .68rem; }
    .council-zone > .zone-head { margin-bottom: 7px; padding-bottom: 5px; }
    .council-zone > .zone-head h2 { font-size: .82rem; }
    .realm-map { min-height: 520px; padding: clamp(22px, 2.6vw, 36px); border-radius: 20px; background-image: radial-gradient(circle at 50% 0, color-mix(in srgb, var(--gold) 8%, transparent), transparent 34%), repeating-linear-gradient(-18deg, var(--texture) 0, var(--texture) 1px, transparent 1px, transparent 22px); }
    .realm-map > summary { display: flex; align-items: center; gap: 9px; width: fit-content; color: var(--bamboo); font-size: 1.08rem; letter-spacing: .08em; }
    .map-summary-icon { color: var(--gold); font-size: 1.2rem; }
    .map-intro { max-width: 64ch; margin: 8px 0 22px; color: var(--muted); font-size: .78rem; line-height: 1.65; }
    .chancellor-card { grid-template-columns: 86px minmax(0, 1fr) auto; gap: 16px; width: min(100%, 640px); margin-bottom: 31px; padding: 14px 18px; border-radius: 14px; }
    .chancellor-card h3 { font-size: 1.18rem; }
    .chancellor-card p { margin-top: 3px; font-size: .74rem; }
    .chancellor-card .pixel-sprite { width: 78px; height: 94px; }
    .chancellor-card::after { bottom: -32px; height: 32px; }
    .organogram-branches { gap: var(--organogram-gap); padding-top: 28px; }
    .territory-column { padding: 22px 18px 20px; border-radius: 16px; box-shadow: 0 14px 34px color-mix(in srgb, var(--territory-color, var(--gold)) 12%, transparent); }
    .territory-column::before { top: -28px; height: 28px; }
    .territory-heading { gap: 10px; padding-bottom: 13px; }
    .territory-heading h3 { font-size: 1.04rem; }
    .territory-heading p { margin-top: 4px; font-size: .7rem; }
    .territory-alert { display: flex; align-items: center; gap: 7px; min-height: 32px; margin: 12px 0; padding: 7px 9px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255, 249, 235, .74); color: var(--muted); font-size: .7rem; line-height: 1.35; }
    .territory-alert::before { content: ""; flex: 0 0 6px; width: 6px; height: 6px; border-radius: 50%; background: var(--dim); }
    .territory-alert[data-status="RUNNING"], .territory-alert[data-status="ACTIVE"] { border-color: rgba(46, 110, 135, .34); }
    .territory-alert[data-status="RUNNING"]::before, .territory-alert[data-status="ACTIVE"]::before { background: #2E6E87; }
    .territory-alert[data-status="REVIEW"], .territory-alert[data-status="REWORK"] { border-color: rgba(91, 103, 164, .34); }
    .territory-alert[data-status="REVIEW"]::before, .territory-alert[data-status="REWORK"]::before { background: #5B67A4; }
    .territory-alert[data-status="DONE"], .territory-alert[data-status="ACCEPT"] { border-color: rgba(61, 115, 78, .34); }
    .territory-alert[data-status="DONE"]::before, .territory-alert[data-status="ACCEPT"]::before { background: #3D734E; }
    .territory-alert[data-status="FAILED"], .territory-alert[data-status="CRITICAL"] { border-color: rgba(183, 82, 39, .42); color: var(--cinnabar); }
    .territory-alert[data-status="FAILED"]::before, .territory-alert[data-status="CRITICAL"]::before { background: var(--cinnabar); }
    .org-connector { height: 16px; }
    .org-connector.supervisor-to-worker { height: 18px; background: var(--gold); }
    .org-node { grid-template-columns: 72px minmax(0, 1fr); gap: 12px; padding: 11px 13px; border-radius: 12px; }
    .org-node .pixel-sprite { width: 64px; height: 78px; }
    .org-node h4 { font-size: .94rem; }
    .org-node p { margin-top: 3px; font-size: .7rem; }
    .worker-stack { gap: 12px; margin-top: 0; }
     .worker-stack .org-node { grid-template-columns: 52px minmax(0, 1fr); gap: 10px; padding: 9px 11px; min-height: 82px; }
     .worker-stack .pixel-sprite { width: 48px; height: 66px; }
     .worker-stack .org-node h4 { font-size: .84rem; }
     .worker-stack .org-node p { font-size: .66rem; line-height: 1.35; }
     .org-node[data-role="supervisor"] { grid-template-columns: 72px minmax(0, 1fr); min-height: 116px; }
     .org-node[data-role="supervisor"] .pixel-sprite { width: 72px; height: 92px; }
     .org-node[data-role="worker"] { grid-template-columns: 52px minmax(0, 1fr); min-height: 82px; }
     .org-node[data-role="worker"] .pixel-sprite { width: 50px; height: 68px; }
     .org-node[data-stage-evidence="missing"] .pixel-sprite,
     .org-node[data-stage-evidence="unsupported"] .pixel-sprite,
     .chancellor-card[data-stage-evidence="missing"] .pixel-sprite,
     .chancellor-card[data-stage-evidence="unsupported"] .pixel-sprite { opacity: .72; }
     .pixel-sprite[hidden] { display: none; }
     .org-node[data-stage-evidence="unbound"], .org-node[data-stage-evidence="absent"] { grid-template-columns: minmax(0, 1fr); }
     .chancellor-card[data-stage-evidence="unbound"], .chancellor-card[data-stage-evidence="absent"] { grid-template-columns: minmax(0, 1fr) auto; }
     .kingdom-organogram .code-badge, .territory-heading > .code-badge { display: none; }
    .organogram-footer { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 20px; margin-top: 22px; padding-top: 14px; border-top: 1px solid var(--line); color: var(--muted); font-size: .68rem; line-height: 1.5; }
    .organogram-footer strong { color: var(--bamboo); font-weight: 700; }
    .status-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 3px 5px; }
    .status-legend i { display: inline-block; width: 6px; height: 6px; margin-left: 2px; border-radius: 50%; background: var(--dim); }
    .status-legend i[data-tone="blocked"] { background: var(--cinnabar); }
    .status-legend i[data-tone="running"] { background: #2E6E87; }
    .status-legend i[data-tone="review"] { background: #5B67A4; }
    .status-legend i[data-tone="done"] { background: #3D734E; }
    .status-legend i[data-tone="idle"] { background: #6D665C; }
    .organogram-technical { margin-top: 7px; color: var(--dim); font-size: .64rem; }
    .organogram-technical summary, .developer-details summary { cursor: pointer; color: var(--muted); }
    .organogram-technical p { margin-top: 6px; line-height: 1.45; }
    .attention-council { margin-top: 8px; padding: 10px 12px; }
    .attention-council > summary { list-style: none; cursor: pointer; }
    .attention-council > summary::-webkit-details-marker { display: none; }
    .attention-council[open] > summary { margin-bottom: 9px; }
    .attention-heading { margin-bottom: 0; }
    .developer-details { margin-top: 8px; padding: 8px 10px; border-top: 1px solid var(--line); color: var(--muted); font-size: .68rem; }
    .developer-nav { display: flex; flex-wrap: wrap; gap: 8px 15px; margin-top: 7px; }
    .developer-nav a { color: var(--muted); text-decoration: none; }
    .developer-nav a:hover, .developer-nav a[aria-current="page"] { color: var(--gold); }

    /* GUI final pass: restore the four verified themes and keep the default
       surface human-first. Theme state is local presentation only. */
    .theme-picker { display: flex; align-items: center; gap: 8px; min-width: 0; margin: 0; padding: 5px 7px; border: 1px solid var(--line); border-radius: 999px; background: var(--patina); }
    .theme-picker-label { color: var(--muted); font-size: .66rem; white-space: nowrap; }
    .theme-swatches { display: flex; align-items: center; gap: 2px; }
    .theme-swatch { display: grid; width: 32px; height: 32px; place-items: center; border: 2px solid transparent; border-radius: 50%; background: transparent; color: var(--bamboo); }
    .theme-swatch > span { width: 19px; height: 19px; border: 1px solid rgba(255, 255, 255, .46); border-radius: 50%; box-shadow: 0 1px 4px rgba(0, 0, 0, .28); }
    .theme-swatch:hover, .theme-swatch[aria-pressed="true"] { border-color: var(--gold); background: var(--panel-soft); }
    .theme-swatch[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--gate), 0 0 0 4px var(--gold); }
    .theme-swatch[data-theme-choice="parchment"] > span { background: linear-gradient(135deg, #EFE2C4 50%, #956E35 50%); }
    .theme-swatch[data-theme-choice="night"] > span { background: linear-gradient(135deg, #18283B 50%, #D5B56F 50%); }
    .theme-swatch[data-theme-choice="forest"] > span { background: linear-gradient(135deg, #183026 50%, #C1A05C 50%); }
    .theme-swatch[data-theme-choice="wine"] > span { background: linear-gradient(135deg, #4B2331 50%, #D3A45F 50%); }
    .active-theme-name { min-width: 4em; color: var(--dim); font-size: .62rem; white-space: nowrap; }
    .status-technical code, .owner-management code { background: var(--patina-raised); }
    .glossary-list, .org-empty, .unassigned-worker-rail { background: var(--panel-soft); }
    input, textarea, select { background: var(--field-bg); }

    .territory-column { --territory-color: var(--territory-1); --territory-wash: var(--territory-1-wash); border: 1px solid var(--territory-color); border-top-width: 6px; background: linear-gradient(145deg, var(--territory-wash), var(--patina) 68%); }
    .territory-column[data-territory-tone="2"] { --territory-color: var(--territory-2); --territory-wash: var(--territory-2-wash); }
    .territory-column[data-territory-tone="3"] { --territory-color: var(--territory-3); --territory-wash: var(--territory-3-wash); }
    .territory-column[data-territory-tone="4"] { --territory-color: var(--territory-4); --territory-wash: var(--territory-4-wash); }
    .territory-column[data-territory-tone="5"] { --territory-color: var(--territory-5); --territory-wash: var(--territory-5-wash); }
    .territory-column[data-territory-tone="6"] { --territory-color: var(--territory-6); --territory-wash: var(--territory-6-wash); }
    .territory-column[data-status] { background: linear-gradient(145deg, var(--territory-wash), var(--patina) 68%); border-color: var(--territory-color); }
    .territory-heading { border-bottom-color: color-mix(in srgb, var(--territory-color) 42%, transparent); }
    .territory-heading h3::before { display: inline-block; width: .62em; height: .62em; margin-right: .5em; border-radius: 3px; background: var(--territory-color); content: ""; vertical-align: .04em; }
    .territory-alert { --alert-tone: var(--status-unknown); background: var(--patina); border-color: var(--alert-tone); color: var(--bamboo); }
    .territory-alert::before { background: var(--alert-tone); content: attr(data-status-icon); width: 14px; height: 14px; display: grid; place-items: center; color: var(--patina); font-size: .55rem; font-weight: 900; }
    .territory-alert[data-status-tone="blocked"] { --alert-tone: var(--status-blocked); }
    .territory-alert[data-status-tone="running"] { --alert-tone: var(--status-running); }
    .territory-alert[data-status-tone="review"] { --alert-tone: var(--status-review); }
    .territory-alert[data-status-tone="done"] { --alert-tone: var(--status-done); }
    .territory-alert[data-status-tone="idle"] { --alert-tone: var(--status-idle); }

    .chancellor-card, .org-node, .task-link, .task-summary-card { --tone: var(--status-unknown); --tone-wash: var(--status-unknown-wash); border-color: var(--tone); background: linear-gradient(135deg, var(--tone-wash), var(--patina) 72%); }
    .chancellor-card[data-status-tone="blocked"], .org-node[data-status-tone="blocked"], .task-link[data-status-tone="blocked"], .task-summary-card[data-status-tone="blocked"] { --tone: var(--status-blocked); --tone-wash: var(--status-blocked-wash); }
    .chancellor-card[data-status-tone="running"], .org-node[data-status-tone="running"], .task-link[data-status-tone="running"], .task-summary-card[data-status-tone="running"] { --tone: var(--status-running); --tone-wash: var(--status-running-wash); }
    .chancellor-card[data-status-tone="review"], .org-node[data-status-tone="review"], .task-link[data-status-tone="review"], .task-summary-card[data-status-tone="review"] { --tone: var(--status-review); --tone-wash: var(--status-review-wash); }
    .chancellor-card[data-status-tone="done"], .org-node[data-status-tone="done"], .task-link[data-status-tone="done"], .task-summary-card[data-status-tone="done"] { --tone: var(--status-done); --tone-wash: var(--status-done-wash); }
    .chancellor-card[data-status-tone="idle"], .org-node[data-status-tone="idle"], .task-link[data-status-tone="idle"], .task-summary-card[data-status-tone="idle"] { --tone: var(--status-idle); --tone-wash: var(--status-idle-wash); }
    .chancellor-card[data-status-tone="unknown"], .org-node[data-status-tone="unknown"], .task-link[data-status-tone="unknown"], .task-summary-card[data-status-tone="unknown"] { --tone: var(--status-unknown); --tone-wash: var(--status-unknown-wash); }
    .chancellor-card, .org-node { border-width: 2px; border-left-width: 5px; box-shadow: 0 7px 20px color-mix(in srgb, var(--tone) 18%, transparent); }
    .chancellor-card { border-left-width: 6px; }
    .status-pill { display: inline-flex; width: fit-content; max-width: 100%; align-items: center; gap: 5px; margin-top: 6px; padding: 3px 7px; border: 1px solid var(--tone); border-radius: 999px; background: var(--patina); color: var(--tone); font-size: .64rem; font-weight: 700; line-height: 1.25; }
    .status-pill::before { content: attr(data-status-icon); font-size: .72rem; }
    .status-legend i[data-tone="blocked"] { background: var(--status-blocked); }
    .status-legend i[data-tone="running"] { background: var(--status-running); }
    .status-legend i[data-tone="review"] { background: var(--status-review); }
    .status-legend i[data-tone="done"] { background: var(--status-done); }
    .status-legend i[data-tone="idle"] { background: var(--status-idle); }
    .node-task { display: block; margin-top: 5px; color: var(--bamboo); font-size: .76rem; line-height: 1.4; overflow-wrap: anywhere; }
    .chancellor-card .node-task { font-size: .8rem; }
    .node-details { grid-column: 1 / -1; margin-top: 4px; border-top: 1px solid color-mix(in srgb, var(--tone) 30%, transparent); color: var(--muted); font-size: .62rem; }
    .node-details summary { width: fit-content; padding-top: 5px; cursor: pointer; color: var(--muted); }
    .node-details p, .node-details code { display: block; margin-top: 5px; overflow-wrap: anywhere; }
    .node-details code { color: var(--dim); }
    .kingdom-organogram > .chancellor-card .code-badge { display: none; }

    .task-link { border: 1px solid var(--line); border-left: 5px solid var(--tone); border-radius: 8px; }
    .task-link:hover, .task-link[aria-current="page"] { border-left-color: var(--tone); box-shadow: inset 0 0 0 1px var(--tone); }
    .task-link .task-status { color: var(--tone); font-size: .7rem; font-weight: 700; }
    .task-link .task-status::before { margin-right: 5px; content: attr(data-status-icon); }
    .task-summary-card { padding: 14px; border: 2px solid var(--tone); border-left-width: 6px; border-radius: 10px; }
    .task-summary-card h3 { font-size: 1.08rem; }
    .task-summary-card p { margin-top: 8px; color: var(--muted); font-size: .78rem; line-height: 1.55; }
    .task-technical { margin-top: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-soft); }
    .task-technical > summary { cursor: pointer; color: var(--muted); font-size: .74rem; font-weight: 700; }
    .task-technical-body { display: grid; gap: 8px; margin-top: 10px; }

    .attention-item { border: 1px solid var(--line); border-left: 5px solid var(--status-running); border-radius: 8px; }
    .attention-item[data-severity="CRITICAL"], .attention-item[data-severity="FAILED"] { border-left-color: var(--status-blocked); }
    .attention-item[data-severity="UNKNOWN"] { border-left-color: var(--status-unknown); }
    .attention-technical { margin-top: 7px; color: var(--dim); font-size: .64rem; }
    .attention-technical summary { cursor: pointer; }
    .attention-heading .code-badge { display: none; }

    .developer-details, .management-hub { margin-top: 16px; padding: 0; border: 1px solid var(--line); border-top: 2px solid var(--gold); border-radius: 12px; background: var(--patina); box-shadow: var(--shadow); color: var(--muted); }
    .developer-details > summary, .management-hub > summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; cursor: pointer; color: var(--bamboo); font-size: .84rem; font-weight: 700; list-style: none; }
    .developer-details > summary::-webkit-details-marker, .management-hub > summary::-webkit-details-marker { display: none; }
    .developer-details > summary::after, .management-hub > summary::after { color: var(--gold); content: "+"; font-size: 1.1rem; }
    .developer-details[open] > summary::after, .management-hub[open] > summary::after { content: "−"; }
    .developer-details[open] > summary, .management-hub[open] > summary { border-bottom: 1px solid var(--line); }
    .developer-panel, .management-content { padding: 0 16px 16px; }
    .developer-nav { margin: 11px 0; }
    .developer-panel .zone { margin-top: 12px; box-shadow: none; }
    .developer-panel .evidence-rail { margin-top: 12px; }
    .management-hub { margin-bottom: 18px; }
    .management-heading-copy { display: grid; gap: 3px; }
    .management-heading-copy small { color: var(--muted); font-size: .68rem; font-weight: 400; }
    .delegation-guide { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 12px; margin: 16px 0 12px; padding: 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel-soft); }
    .delegation-step { display: grid; gap: 3px; min-height: 62px; align-content: center; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--patina); }
    .delegation-step strong { color: var(--bamboo); font-size: .82rem; }
    .delegation-step span { color: var(--muted); font-size: .68rem; line-height: 1.45; }
    .delegation-arrow { color: var(--gold); font-size: 1.3rem; }
    .form-route-note { margin: 0 0 12px; color: var(--muted); font-size: .72rem; line-height: 1.55; }
    .owner-management { margin-top: 14px; background: var(--panel-soft); }
    .action-dock { margin-top: 18px; }
    #kingdom-state-code { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
    @media (max-width: 760px) {
      .realm-sidebar { gap: 8px 18px; }
      .main-nav a, .main-nav .nav-item { min-height: 34px; padding: 5px 8px 9px; }
      .main-nav .nav-item { align-items: center; }
      .kingdom-status { grid-template-columns: minmax(0, 1fr); gap: 9px; }
      .control-stack { grid-template-columns: minmax(0, 1fr) auto; }
      #overview-content.metric-grid { grid-column: 1; }
      .control-stack > #refresh-button { grid-column: 2; grid-row: 2; }
      .realm-map { min-height: 0; }
      .organogram-branches,
      .organogram-branches[data-branch-count="1"],
      .organogram-branches[data-branch-count="2"],
      .organogram-branches[data-branch-count="3"] { grid-template-columns: minmax(0, 1fr); gap: 14px; padding: 20px 0 0 24px; }
      .organogram-branches::before,
      .organogram-branches[data-branch-count="1"]::before,
      .organogram-branches[data-branch-count="2"]::before,
      .organogram-branches[data-branch-count="3"]::before { display: block; left: 8px; right: auto; top: 0; bottom: auto; width: 1px; height: 40px; }
      .organogram-branches[data-branch-count="0"] { padding: 0; }
      .organogram-branches[data-branch-count="0"]::before { display: none; }
      .territory-column { margin: 0; padding: 18px 12px 14px 20px; }
      .territory-column::before { left: -16px; top: 20px; width: 16px; height: 1px; border-top: 1px solid var(--gold); border-left: 0; }
      .territory-column::after { content: ""; position: absolute; left: -16px; top: 20px; bottom: -34px; border-left: 1px solid var(--gold); }
      .organogram-branches[data-branch-count="1"] > .territory-column:nth-of-type(1)::after,
      .organogram-branches[data-branch-count="2"] > .territory-column:nth-of-type(2)::after,
      .organogram-branches[data-branch-count="3"] > .territory-column:nth-of-type(3)::after { display: none; }
      .org-connector { margin-inline: auto; }
      .chancellor-card { grid-template-columns: 48px minmax(0, 1fr); width: 100%; margin-bottom: 24px; }
      .chancellor-card .code-badge { grid-column: 2; justify-self: start; }
      .chancellor-card::after { left: 8px; bottom: -25px; height: 25px; }
      .organogram-footer { grid-template-columns: minmax(0, 1fr); }
      .theme-picker { margin-left: auto; }
      .delegation-guide { grid-template-columns: minmax(0, 1fr); }
      .delegation-arrow { justify-self: center; transform: rotate(90deg); }
    }
    @media (max-width: 640px) {
      .console-main { padding-top: 12px; }
      .hero-copy h2 { font-size: 1.45rem; }
      .hero-copy p:not(.section-kicker) { font-size: .66rem; }
      .control-stack { grid-template-columns: minmax(0, 1fr); }
      .health-capsule, #overview-content.metric-grid, .control-stack > #refresh-button { grid-column: 1; grid-row: auto; }
      #overview-content.metric-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .control-stack > #refresh-button { grid-column: 1; justify-self: start; }
      .health-capsule { padding: 6px 8px; }
      .theme-picker-label, .active-theme-name { display: none; }
      .theme-swatch { width: 38px; height: 38px; }
      .developer-panel, .management-content { padding-inline: 9px; }
       .chancellor-card { grid-template-columns: 46px minmax(0, 1fr); width: 100%; margin-bottom: 19px; }
       .chancellor-card .pixel-sprite { width: 44px; height: 50px; }
      .chancellor-card .code-badge { grid-column: 2; }
        .chancellor-card::after { bottom: -20px; height: 20px; }
       .territory-column { padding-left: 17px; }
        .org-connector { margin-inline: auto; }
       .organogram-footer { font-size: .61rem; }
       .chancellor-card { grid-template-columns: 58px minmax(0, 1fr); }
       .chancellor-card .pixel-sprite { width: 54px; height: 68px; }
       .org-node[data-role="supervisor"] { grid-template-columns: 56px minmax(0, 1fr); min-height: 78px; }
       .org-node[data-role="supervisor"] .pixel-sprite { width: 56px; height: 68px; }
       .org-node[data-role="worker"] { grid-template-columns: 40px minmax(0, 1fr); min-height: 62px; }
       .org-node[data-role="worker"] .pixel-sprite { width: 40px; height: 54px; }
     }
    @media (max-width: 390px) {
      .realm-sidebar { padding-inline: 12px; }
      .console-main { width: calc(100% - 16px); }
      .main-nav { margin-inline: -2px; }
      .main-nav a, .main-nav .nav-item { padding-inline: 7px; }
      #overview-content .metric { padding-inline: 5px; }
      #overview-content .metric strong { font-size: .76rem; }
       #overview-content .metric span { font-size: .55rem; }
       .realm-map { padding-inline: 10px; }
       .realm-sidebar { align-items: flex-start; }
       .theme-picker { width: 100%; justify-content: center; order: 3; margin-left: 0; border-radius: 10px; }
       .theme-swatch { width: 44px; height: 44px; }
       .chancellor-card { grid-template-columns: 50px minmax(0, 1fr); }
       .chancellor-card .pixel-sprite { width: 48px; height: 60px; }
       .org-node[data-role="supervisor"] { grid-template-columns: 48px minmax(0, 1fr); min-height: 70px; }
       .org-node[data-role="supervisor"] .pixel-sprite { width: 48px; height: 60px; }
       .org-node[data-role="worker"] { grid-template-columns: 36px minmax(0, 1fr); min-height: 58px; }
       .org-node[data-role="worker"] .pixel-sprite { width: 36px; height: 50px; }
     }

    /* Minimal three-page shell. The map is the homepage canvas, not a card
       inside a dashboard. Management and the ledger are separate views. */
    [data-console-page][hidden] { display: none !important; }
    .console-main { width: 100%; max-width: none; padding: clamp(18px, 2.6vw, 34px) clamp(18px, 4vw, 72px) 72px; }
    .zones { display: contents; }
    .map-page { margin: 0; padding: 0; border: 0; background: transparent; box-shadow: none; }
    .map-page .council-grid { display: block; }
    .realm-map { min-height: calc(100vh - 150px); margin: 0; padding: 0 !important; overflow: visible; border: 0 !important; border-radius: 0 !important; background: transparent !important; box-shadow: none !important; }
    .realm-map::after { right: 4%; top: 4%; color: color-mix(in srgb, var(--gold) 7%, transparent); font-size: clamp(5rem, 12vw, 11rem); }
    .map-heading { position: relative; z-index: 3; max-width: 52rem; margin-bottom: clamp(22px, 4vw, 46px); }
    .map-heading h2 { display: flex; align-items: center; gap: 10px; margin-top: 5px; font-size: clamp(1.65rem, 3.6vw, 2.8rem); }
    .map-heading .map-intro { margin: 8px 0 0; font-size: clamp(.74rem, 1.2vw, .9rem); }
    .kingdom-organogram { width: 100%; max-width: 2200px; margin: 0 auto; }
    .organogram-connection-layer, .territory-connection-layer { position: absolute; inset: 0; z-index: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
    .organogram-connection-layer path, .territory-connection-layer path { fill: none; stroke: var(--gold); stroke-width: 1.35; vector-effect: non-scaling-stroke; opacity: .8; }
    .chancellor-card, .organogram-branches { position: relative; z-index: 1; }
    .chancellor-card::after,
    .organogram-branches::before,
    .territory-column::before,
    .territory-column::after,
    .territory-column > .worker-stack::before { display: none !important; }
    .organogram-branches,
    .organogram-branches[data-branch-count] { grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); align-items: start; gap: clamp(24px, 3vw, 46px); padding-top: clamp(34px, 5vw, 58px); }
    .organogram-branches[data-branch-count="0"] { grid-template-columns: minmax(0, 1fr); padding-top: 0; }
    .organogram-branches[data-branch-count="1"] { grid-template-columns: minmax(0, min(100%, 820px)); justify-content: center; }
    .organogram-branches[data-branch-count="2"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .territory-column { align-self: start; min-width: 0; padding: clamp(18px, 2.3vw, 28px); }
    .territory-role-network { position: relative; display: grid; gap: clamp(24px, 3vw, 34px); margin-top: 16px; padding-top: 12px; }
    .territory-role-network > .org-node,
    .territory-role-network > .worker-stack { position: relative; z-index: 1; }
    .territory-role-network > .worker-stack { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 230px), 1fr)); gap: 12px; margin-top: 0; }
    .territory-role-network > .worker-stack .org-node { height: 100%; }
    .map-legend { width: fit-content; max-width: 100%; margin: 22px auto 0; color: var(--muted); font-size: .68rem; }
    .map-legend > summary { width: fit-content; margin: 0 auto; cursor: pointer; color: var(--muted); }
    .map-legend .organogram-footer { margin-top: 12px; }
    .map-legend .organogram-technical { margin: 8px 0 0; padding: 0; border: 0; }

    /* Host feedback remains available without turning the map homepage back
       into a dashboard row. Technical detail only appears when the Host
       supplies a concrete reason code. */
    .status-bar { position: fixed; z-index: 40; right: clamp(12px, 2vw, 28px); bottom: clamp(12px, 2vw, 28px); width: min(430px, calc(100vw - 24px)); min-height: 0; padding: 9px 13px; border: 1px solid var(--line-strong); border-radius: 999px; background: color-mix(in srgb, var(--patina-raised) 92%, transparent); box-shadow: var(--shadow); backdrop-filter: blur(12px); pointer-events: none; }
    .status-bar .status-text { font-size: .7rem; line-height: 1.4; }
    .status-technical:not([hidden]) { position: fixed; z-index: 41; right: clamp(12px, 2vw, 28px); bottom: clamp(58px, 6vw, 78px); width: min(430px, calc(100vw - 24px)); margin: 0; padding: 9px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--patina-raised); box-shadow: var(--shadow); }

    .developer-details, .management-hub { margin: 0; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
    .page-heading { max-width: 64rem; margin-bottom: 22px; padding-bottom: 14px; border-bottom: 1px solid var(--line); }
    .page-heading h2 { margin-top: 4px; font-size: clamp(1.55rem, 3vw, 2.35rem); }
    .page-heading > p:last-child { margin-top: 7px; color: var(--muted); line-height: 1.55; }
    .developer-panel, .management-content { padding: 0; }
    .management-content { display: flex; flex-direction: column; }
    .management-content > .action-dock { order: 1; }
    .management-content > .owner-management { order: 2; }
    .action-dock { display: flex; flex-direction: column; margin-top: 0; }
    .action-dock-head { margin-bottom: 12px; }
    .action-dock > .delegation-guide { order: 0; }
    .action-dock > .forms { order: 1; display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
    .action-dock > .capability-card { order: 2; margin-top: 16px; }
    .task-composer-card { padding: clamp(16px, 2.2vw, 24px); border: 1px solid var(--line); border-radius: 18px; background: linear-gradient(135deg, var(--panel-soft), var(--patina)); box-shadow: var(--shadow); }
    .task-composer-heading { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-bottom: 13px; }
    .task-composer-heading h3 { margin-top: 3px; font-size: 1.15rem; }
    .task-composer-heading > span { color: var(--muted); font-size: .7rem; }
    .task-composer-shell { position: relative; display: flex; align-items: center; gap: 8px; min-height: 58px; padding: 6px; border: 1px solid var(--line-strong); border-radius: 16px; background: var(--field-bg); box-shadow: inset 0 1px 0 color-mix(in srgb, var(--bamboo) 7%, transparent); }
    .task-composer-shell:focus-within { border-color: var(--gold); box-shadow: 0 0 0 3px color-mix(in srgb, var(--gold) 18%, transparent); }
    .task-composer-shell input { flex: 1 1 auto; min-width: 8rem; min-height: 44px; padding: 7px 9px; border: 0; background: transparent; box-shadow: none; font-size: clamp(.9rem, 1.4vw, 1.05rem); }
    .task-composer-shell input:focus { outline: 0; }
    .task-territory-chip { flex: 0 0 auto; max-width: min(38vw, 260px); padding: 7px 10px; overflow: hidden; border: 1px solid var(--territory-1); border-radius: 999px; color: var(--bamboo); background: var(--territory-1-wash); font-size: .72rem; text-overflow: ellipsis; white-space: nowrap; }
    .task-composer-submit { flex: 0 0 auto; min-height: 44px; padding-inline: 16px; border-radius: 11px; }
    .territory-command-menu { position: absolute; z-index: 20; left: 0; right: 0; top: calc(100% + 8px); display: grid; gap: 4px; max-height: 260px; padding: 8px; overflow-y: auto; border: 1px solid var(--line-strong); border-radius: 13px; background: var(--patina-raised); box-shadow: var(--shadow); }
    .territory-command-menu[hidden] { display: none; }
    .territory-command-option { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; padding: 10px 12px; border: 0; border-radius: 9px; background: transparent; color: var(--bamboo); text-align: left; }
    .territory-command-option:hover, .territory-command-option[aria-selected="true"] { background: var(--territory-1-wash); }
    .territory-command-option small { color: var(--muted); }
    .task-composer-meta { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 7px 14px; margin-top: 9px; color: var(--muted); font-size: .68rem; }
    .task-composer-meta kbd { padding: 1px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--field-bg); color: var(--bamboo); }

    @media (max-width: 760px) {
      .console-main { width: 100%; padding-inline: 14px; }
      .realm-map { min-height: 0; }
      .organogram-branches,
      .organogram-branches[data-branch-count="1"],
      .organogram-branches[data-branch-count="2"],
      .organogram-branches[data-branch-count="3"] { grid-template-columns: minmax(0, 1fr); padding: 34px 0 0; }
      .task-composer-heading { display: grid; }
      .task-composer-shell { flex-wrap: wrap; }
      .task-composer-shell input { flex: 1 1 60%; }
      .task-composer-submit { margin-left: auto; }
    }
    @media (max-width: 390px) {
      .console-main { padding-inline: 10px; }
      .realm-map { padding-inline: 0 !important; }
      .task-composer-shell { display: grid; grid-template-columns: minmax(0, 1fr) auto; }
      .task-territory-chip { grid-column: 1 / -1; max-width: 100%; justify-self: start; }
      .task-composer-shell input { min-width: 0; }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#overview">跳到王国总览</a>
  <div id="console-app" class="console-shell" data-console-app>
    <aside class="realm-sidebar" aria-label="王国侧栏">
      <header class="realm-brand">
        <div class="realm-seal" aria-hidden="true">
          <svg class="realm-seal-icon" viewBox="0 0 48 52" focusable="false">
            <path d="M24 2 44 10v16c0 12-8 19-20 24C12 45 4 38 4 26V10z" fill="none" stroke="currentColor" stroke-width="2.5"/>
            <path d="M15 19h18M18 19v15m12-15v15M13 34h22M20 13h8v8h-8z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div>
          <h1>Agent Kingdom</h1>
          <p class="brand-note">AgenticKingdom 治理档案</p>
        </div>
      </header>
      <nav id="main-navigation" class="main-nav" aria-label="主导航">
        <a href="#overview" data-nav-section="overview" aria-current="page">王国地图</a>
        <a href="#management" data-nav-section="management">管理中心</a>
        <a href="#ledger" data-nav-section="ledger">王国账本</a>
      </nav>
      <div class="theme-picker" role="group" aria-label="界面风格">
        <span class="theme-picker-label">界面风格</span>
        <div class="theme-swatches">
          <button class="theme-swatch" type="button" data-theme-choice="parchment" aria-label="切换为羊皮纸王国志" aria-pressed="false" title="羊皮纸王国志"><span aria-hidden="true"></span></button>
          <button class="theme-swatch" type="button" data-theme-choice="night" aria-label="切换为夜蓝星图" aria-pressed="false" title="夜蓝星图"><span aria-hidden="true"></span></button>
          <button class="theme-swatch" type="button" data-theme-choice="forest" aria-label="切换为森林墨绿" aria-pressed="true" title="森林墨绿"><span aria-hidden="true"></span></button>
          <button class="theme-swatch" type="button" data-theme-choice="wine" aria-label="切换为酒红议会" aria-pressed="false" title="酒红议会"><span aria-hidden="true"></span></button>
        </div>
        <span id="active-theme-name" class="active-theme-name" aria-live="polite">森林墨绿</span>
      </div>
      <section class="sidebar-boundary" aria-labelledby="authority-boundary-title">
        <h2 id="authority-boundary-title">权力边界</h2>
        <p>页面只呈现宿主明确开放的动作。人类所有者、代理与会话互不等同；浏览器不能自行获得治理权力。</p>
      </section>
    </aside>

    <main class="console-main">
      <header class="kingdom-status" data-console-page="ledger" hidden aria-labelledby="kingdom-state-title">
        <div class="hero-copy">
          <p class="section-kicker">你的 Agent 王国</p>
          <h2 id="kingdom-state-title">谁在负责什么，一眼看清</h2>
          <p>从领地到成员，从当前任务到需要关注的问题；展开卡片后再查看完整治理证据。</p>
        </div>
        <div class="control-stack">
          <div id="health-capsule" class="health-capsule" data-status="UNKNOWN" role="status" aria-live="polite">
            <span class="health-dot" aria-hidden="true"></span>
            <span class="health-copy"><small id="kingdom-health-title">王国健康</small><strong id="kingdom-state-detail">健康结论尚未确认</strong></span>
            <code id="kingdom-state-code" class="code-badge">UNKNOWN</code>
          </div>
          <div id="overview-content" class="metric-grid"><p class="empty">正在读取王国概况…</p></div>
          <button id="refresh-button" class="refresh" type="button">重新读取</button>
        </div>
      </header>

      <div class="status-bar" role="status" aria-live="polite">
        <span id="status-line" class="status-text" data-level="unknown">正在等待宿主能力与王国投影。</span>
      </div>
      <details id="status-technical" class="status-technical" hidden>
        <summary>技术详情</summary>
        <code id="status-technical-code">UNKNOWN</code>
      </details>

      <details class="status-glossary" data-console-page="ledger" hidden>
        <summary>首次查看状态词说明</summary>
        <div class="glossary-list">
          <span>待审 <code>REVIEW</code>：等待监督者 <code>SUPERVISOR</code> 作出决定</span>
          <span>恢复核对中 <code>RECOVERING</code>：执行结果未知，正在对账</span>
          <span>尚未运行 <code>NOT_RUN</code>：没有当前运行证据</span>
          <span>兼容执行路径 <code>LEGACY_COMPAT</code>：显式使用旧式一次性执行</span>
          <span>尚未确认 <code>UNKNOWN</code>：证据不足，不能推断</span>
        </div>
      </details>

      <section class="zones" aria-label="王国议政工作区">
        <section id="overview" data-console-section="overview" data-console-page="overview" class="zone zone-wide council-zone map-page" aria-labelledby="overview-title">
          <div class="zone-head sr-only"><div><p class="section-kicker">治理档案 · 组织总览</p><h2 id="overview-title">王国组织谱</h2></div><p id="overview-revision" class="meta"><span>投影版本尚未确认</span> <code class="code-badge">UNKNOWN</code></p></div>
          <div class="council-grid">
            <section class="realm-map" aria-labelledby="realm-map-title">
              <header class="map-heading"><p class="section-kicker">你的 Agent 王国</p><h2 id="realm-map-title"><span class="map-summary-icon" aria-hidden="true">✦</span>王国地图</h2><p class="map-intro">宰相统筹全局，领地主管承接任务，骑士完成使命。</p></header>
              <nav class="realm-path" aria-label="组织谱详情">
                <a class="realm-node" href="#organization" data-realm-node="owner"><span>王国所有者</span><strong id="realm-owner-name">人类所有者 · 尚未确认</strong><small>最终治理裁决</small><code class="code-badge">OWNER</code></a>
                <a class="realm-node" href="#organization" data-realm-node="chancellor"><span>执政官</span><strong id="realm-chancellor-name">尚未投影</strong><small id="realm-chancellor-meta">绑定数量尚未确认 <code class="code-badge">UNKNOWN</code></small><code class="code-badge">CHANCELLOR</code></a>
                <a class="realm-node" href="#organization" data-realm-node="supervisor"><span>领地主理人</span><strong id="realm-supervisor-name">尚未投影</strong><small id="realm-supervisor-meta">领地数量尚未确认 <code class="code-badge">UNKNOWN</code></small><code class="code-badge">SUPERVISOR</code></a>
                <a class="realm-node" href="#tasks" data-realm-node="worker"><span>执行者</span><strong id="realm-worker-name">尚未投影</strong><small id="realm-worker-meta">任务数量尚未确认 <code class="code-badge">UNKNOWN</code></small><code class="code-badge">WORKER</code></a>
              </nav>
              <div id="kingdom-organogram" class="kingdom-organogram" aria-label="宰相至领地主管与 Worker 组织谱">
                <svg id="organogram-connection-layer" class="organogram-connection-layer" aria-hidden="true"></svg>
                <article class="chancellor-card" data-role="CHANCELLOR" data-status-tone="unknown">
                   <span class="pixel-sprite" data-role="chancellor" data-animation-state="idle" role="img" aria-label="宰相像素人物"></span>
                  <div><p class="section-kicker">宰相</p><h3 id="organogram-chancellor-name">尚未确认</h3><p id="organogram-chancellor-meta">中央治理连接尚未确认</p><strong id="organogram-chancellor-task" class="node-task">当前任务尚未确认</strong><span id="organogram-chancellor-tone" class="status-pill" data-status-icon="?">状态尚未确认</span></div>
                  <code id="organogram-chancellor-state" class="code-badge">UNKNOWN</code>
                </article>
                <div id="territory-map-list" class="organogram-branches" data-branch-count="0" aria-label="领地组织分支">
                  <p class="org-empty">领地尚未投影。</p>
                </div>
              </div>
              <details class="map-legend">
                <summary>地图图例与技术注脚</summary>
                <div class="organogram-footer" aria-label="组织谱治理与资源图例">
                  <span><strong>组织关系</strong> 宰相 → 领地主管 → 骑士</span>
                  <span><strong>领地颜色</strong> 同一主题内稳定区分；换主题后同步换色</span>
                  <span class="status-legend"><strong>任务状态</strong><i data-tone="blocked"></i>异常 <i data-tone="running"></i>执行中 <i data-tone="review"></i>待复核 <i data-tone="done"></i>完成 <i data-tone="idle"></i>待命</span>
                </div>
                <p class="organogram-technical">Lease、Dispatch、Session 与 reason code 只在王国账本中查看；页面不会把技术字段当作业务状态。</p>
              </details>
            </section>
          </div>
        </section>

        <section id="ledger" data-console-section="ledger" data-console-page="ledger" class="developer-details ledger-page" hidden aria-labelledby="ledger-title">
          <header class="page-heading"><p class="section-kicker">独立页面</p><h2 id="ledger-title">王国账本</h2><p>任务、执行、裁决与证据都在这里，需要时再深入查看。</p></header>
          <div class="developer-panel">
            <nav class="developer-nav" aria-label="二级详情导航">
              <a href="#organization" data-nav-section="ledger">领地名册</a>
              <a href="#tasks" data-nav-section="ledger">任务详情</a>
              <a href="#executions" data-nav-section="ledger">执行记录</a>
              <a href="#activity" data-nav-section="ledger">治理史册</a>
            </nav>
            <nav class="evidence-rail" aria-label="四类证据">
              <div class="rail-item" data-kind="GOVERNANCE_FACT" title="规范标签 GOVERNANCE_FACT"><span>治理事实</span><code>GOVERNANCE_FACT</code></div>
              <div class="rail-item" data-kind="RUNTIME_OBSERVATION" title="规范标签 RUNTIME_OBSERVATION"><span>运行观察</span><code>RUNTIME_OBSERVATION</code></div>
              <div class="rail-item" data-kind="WORKER_CLAIM" title="规范标签 WORKER_CLAIM"><span>执行者呈报</span><code>WORKER_CLAIM</code></div>
              <div class="rail-item" data-kind="DERIVED_EXPLANATION" title="规范标签 DERIVED_EXPLANATION"><span>派生解释</span><code>DERIVED_EXPLANATION</code></div>
            </nav>

        <section id="organization" data-console-section="organization" class="zone zone-wide" aria-labelledby="organization-title">
          <div class="zone-head"><h2 id="organization-title">领地名册</h2><p>有界、脱敏的组织详情</p></div>
          <div class="organization-grid">
            <div id="organization-content" class="data-list"><p class="empty">组织信息尚未确认。</p></div>
          </div>
        </section>

        <section id="tasks" data-console-section="tasks" class="zone zone-wide" aria-labelledby="task-detail-title">
          <div class="zone-head"><h2 id="task-detail-title">任务</h2><p id="task-detail-revision" class="meta"><span>当前选择尚未确认</span> <code class="code-badge">UNKNOWN</code></p></div>
          <div class="task-layout">
            <nav id="task-navigator" class="task-navigator" aria-label="任务导航器">
              <h3>任务导航器</h3>
              <div id="task-navigation-list" class="task-nav-list"><p class="empty">尚无任务。</p></div>
            </nav>
            <div>
              <h3 style="margin-bottom: 10px">任务明细</h3>
              <div id="task-detail-content" class="data-list"><p class="empty">选择一个任务查看治理状态与证据。</p></div>
            </div>
          </div>
        </section>

        <section id="executions" data-console-section="executions" class="zone zone-wide" aria-labelledby="executions-title">
          <div class="zone-head"><h2 id="executions-title">执行</h2><p>运行观察，不等同于治理事实</p></div>
          <p class="hint" style="margin-bottom: 10px">宿主规范状态会原样保留为次级标签：尚未确认 <code>UNKNOWN</code>、恢复核对中 <code>RECOVERING</code>、尚未运行 <code>NOT_RUN</code>、兼容执行路径 <code>LEGACY_COMPAT</code>；不会改写为成功，也不会自动重试。</p>
          <div id="execution-content" class="execution-grid"><p class="empty">执行信息尚未确认或尚未运行。</p></div>
        </section>

        <section id="activity" data-console-section="activity" class="zone zone-wide" aria-labelledby="timeline-title">
          <div class="zone-head"><h2 id="timeline-title">史册</h2><p>按证据顺序记录治理流转</p></div>
          <h3 style="margin-bottom: 10px">流转记录</h3>
          <div id="timeline-content" class="timeline-list"><p class="empty">流转记录尚未确认。</p></div>
        </section>
        <details id="attention-zone" class="attention-council" aria-labelledby="attention-title">
          <summary class="attention-heading"><h3 id="attention-title">待裁决</h3><p id="attention-count">可见事项尚未确认 <code class="code-badge">UNKNOWN</code></p></summary>
          <div id="attention-content" class="attention-list"><p class="empty">待裁决事项尚未投影。</p></div>
        </details>
          </div>
        </section>
      </section>

      <section id="management" data-console-section="management" data-console-page="management" class="management-hub management-page" hidden aria-labelledby="management-title">
        <header class="page-heading"><p class="section-kicker">独立页面</p><h2 id="management-title">管理中心</h2><p>创建任务、主管派发、执行与复核都从这里进入。</p></header>
        <div class="management-content">
          <aside class="owner-management" data-owner-onboarding="true" aria-labelledby="owner-management-title">
            <h3 id="owner-management-title">王国根基设置</h3>
            <p class="danger-note">首次配置与人类所有者（OWNER）专属治理写入只能由人类直接输入 Slash 命令。此卡仅用于发现入口，页面不提交初始化、能力上限、领地、角色、会话或执行方案；executable=false。</p>
            <div class="owner-actions">
              <button class="refresh" type="button" disabled aria-disabled="true">初始化王国</button>
              <button class="refresh" type="button" disabled aria-disabled="true">设置能力上限</button>
              <button class="refresh" type="button" disabled aria-disabled="true">调整领地</button>
              <button class="refresh" type="button" disabled aria-disabled="true">任命或改绑成员</button>
              <button class="refresh" type="button" disabled aria-disabled="true">设置执行方案</button>
            </div>
            <code aria-label="可复制的直接 Slash 首次配置提示">/kingdom init · DIRECT_SLASH_REQUIRED</code>
          </aside>

      <section id="operation-forms" class="action-dock" aria-labelledby="actions-title">
        <div class="action-dock-head"><div><p class="section-kicker">可推进事项</p><h2 id="actions-title">按宿主许可行动</h2></div><p>按钮只反映实时操作许可；不可执行时显示宿主原因。写请求失败或结果未知时绝不自动重试。</p></div>
        <section class="capability-card" aria-labelledby="capability-title">
          <div>
            <p class="section-kicker">宿主操作许可</p>
            <h2 id="capability-title">当前可以安全推进的动作</h2>
            <p id="capability-state" class="capability-copy">操作通道：<strong id="capability-state-label">尚未确认</strong> <code id="capability-state-code" class="code-badge">UNKNOWN</code></p>
          </div>
          <div class="capability-actions">
            <div>
              <p id="capability-note" class="capability-copy">只有宿主明确开放的动作才可点击；每次提交仍由宿主重新校验。</p>
              <p id="capability-expiry" class="meta">有效期：尚未确认 · 投影版本：尚未确认</p>
            </div>
            <div class="form-actions">
              <button id="revoke-button" class="refresh" data-gated-action="control.revoke" type="button" disabled>关闭本地控制通道</button>
              <span class="button-reason" data-reason-for="control.revoke">暂时无法确认（UNKNOWN）</span>
            </div>
          </div>
        </section>
        <div class="delegation-guide" aria-label="常用任务流转">
          <div class="delegation-step"><strong>1 · 交给宰相统筹</strong><span>由宰相会话创建任务、明确目标并选择领地。</span></div>
          <span class="delegation-arrow" aria-hidden="true">➜</span>
          <div class="delegation-step"><strong>2 · 领地主管承接</strong><span>对应主管会话接手本领地任务，再决定派给哪位执行者。</span></div>
        </div>
        <div class="forms" aria-label="操作抽屉">
      <section class="task-composer-card" aria-labelledby="task-composer-title">
        <div class="task-composer-heading"><div><p class="section-kicker">最常用入口</p><h3 id="task-composer-title">交给宰相规划</h3></div><span>创建后由所属领地主管继续派发</span></div>
        <form id="task-create-form" novalidate>
          <label class="sr-only" for="task-title">任务名称</label>
          <div id="task-composer-shell" class="task-composer-shell">
            <span id="task-territory-chip" class="task-territory-chip" hidden></span>
            <input id="task-title" name="title" required autocomplete="off" aria-autocomplete="list" aria-controls="territory-command-menu" aria-expanded="false" placeholder="写下任务，按 / 选择领地">
            <select id="task-territory" name="territory_id" hidden aria-hidden="true" tabindex="-1"><option value="">由宿主选择</option></select>
            <button class="primary task-composer-submit" data-gated-action="task.create" type="submit" disabled>交给宰相</button>
            <div id="territory-command-menu" class="territory-command-menu" role="listbox" aria-label="选择任务所属领地" hidden></div>
          </div>
          <div class="task-composer-meta"><span id="task-composer-hint">输入任务名称；按 <kbd>/</kbd> 唤出领地。</span><span class="button-reason" data-reason-for="task.create">暂时无法确认（UNKNOWN）</span></div>
        </form>
      </section>

      <details class="form-card">
        <summary>领地主管接手并派发</summary>
        <form id="assign-form" novalidate>
          <p class="form-route-note">任务已进入所选领地后，由该领地绑定的主管会话决定具体执行者；不会跨领地代派。</p>
          <div class="form-grid">
            <div class="field"><label for="assign-task">任务</label><select id="assign-task" name="task_id" data-task-selector required><option value="">选择任务</option></select></div>
            <div class="field"><label for="assign-worker">执行者绑定</label><select id="assign-worker" name="worker_binding_id" required><option value="">等待宿主返回可用执行者</option></select></div>
          </div>
          <div class="form-actions"><button class="primary" data-gated-action="assign" data-resource-action="task" type="submit" disabled>主管确认派发</button><span class="button-reason" data-reason-for="assign">暂时无法确认（UNKNOWN）</span></div>
        </form>
      </details>

      <details class="form-card">
        <summary>开始执行</summary>
        <form id="start-form" novalidate>
          <div class="form-grid">
            <div class="field"><label for="start-task">任务</label><select id="start-task" name="task_id" data-task-selector required><option value="">选择任务</option></select></div>
            <div class="field"><label for="start-sandbox">沙箱模式</label><select id="start-sandbox" name="sandbox_mode" disabled aria-disabled="true"><option value="">等待宿主开放沙箱模式</option><option value="workspace-write">workspace-write</option><option value="read-only">read-only</option></select><span class="hint">只选择宿主已开放的输入；不能扩大能力，也不证明操作系统级隔离。</span></div>
            <div class="field field-wide"><label for="start-grant">监督者授予内容 <code>grant_json</code></label><textarea id="start-grant" name="grant_json">{"tool:pwsh":true}</textarea><span class="hint">仅作为宿主输入；宿主会单独核验授予范围与持久执行能力。</span></div>
          </div>
          <div class="form-actions"><button class="primary" data-gated-action="start" data-resource-action="task" type="submit" disabled>开始执行</button><span class="button-reason" data-reason-for="start">暂时无法确认（UNKNOWN）</span></div>
        </form>
      </details>

      <details class="form-card">
        <summary>裁决执行者呈报</summary>
        <form id="review-form" novalidate>
          <div class="form-grid">
            <div class="field"><label for="review-task">任务</label><select id="review-task" name="task_id" data-task-selector required><option value="">选择任务</option></select></div>
            <div id="review-handoff-field" class="field"><label for="review-handoff-binding">移交给</label><select id="review-handoff-binding" name="to_binding_id"><option value="">选择在任执行者绑定</option></select></div>
            <div class="field field-wide"><label for="review-reason">裁决理由</label><textarea id="review-reason" name="reason" placeholder="返工、失败或移交时请说明理由"></textarea></div>
          </div>
          <div class="decision-actions">
            <div class="decision-action"><button class="primary" data-gated-action="review:accept" data-resource-action="task" data-review-decision="ACCEPT" type="button" disabled>接受呈报</button><span class="button-reason" data-reason-for="review:accept">暂时无法确认（UNKNOWN）</span></div>
            <div class="decision-action"><button class="primary" data-gated-action="review:rework" data-resource-action="task" data-review-decision="REWORK" type="button" disabled>要求返工</button><span class="button-reason" data-reason-for="review:rework">暂时无法确认（UNKNOWN）</span></div>
            <div class="decision-action"><button class="primary danger" data-gated-action="review:fail" data-resource-action="task" data-review-decision="FAIL" type="button" disabled>判定失败</button><span class="button-reason" data-reason-for="review:fail">暂时无法确认（UNKNOWN）</span></div>
            <div class="decision-action"><button class="primary" data-gated-action="review:handoff" data-resource-action="task" data-review-decision="HANDOFF" type="button" disabled>移交</button><span class="button-reason" data-reason-for="review:handoff">暂时无法确认（UNKNOWN）</span></div>
          </div>
          <p class="danger-note">执行者呈报只是自述；任务先进入待审 <code>REVIEW</code>，只有监督者 <code>SUPERVISOR</code> 的决定被宿主接受后，治理事实才会改变。</p>
        </form>
      </details>

      <details class="form-card">
        <summary>控制执行</summary>
        <form id="execution-control-form" novalidate>
          <div class="form-grid">
            <div class="field"><label for="execution-control-id">执行记录</label><select id="execution-control-id" name="execution_id" required><option value="">选择宿主投影中的执行记录</option></select></div>
            <div class="field"><label for="execution-control-reason">操作理由（可选）</label><input id="execution-control-reason" name="reason" autocomplete="off"></div>
          </div>
          <div class="form-actions">
            <button class="primary" data-gated-action="execution:pause" data-resource-action="execution" data-execution-command="executionPause" type="button" disabled>暂停</button><span class="button-reason" data-reason-for="execution:pause">暂时无法确认（UNKNOWN）</span>
            <button class="primary" data-gated-action="execution:resume" data-resource-action="execution" data-execution-command="executionResume" type="button" disabled>继续</button><span class="button-reason" data-reason-for="execution:resume">暂时无法确认（UNKNOWN）</span>
            <button class="primary danger" data-gated-action="execution:abort" data-resource-action="execution" data-execution-command="executionAbort" type="button" disabled>终止</button><span class="button-reason" data-reason-for="execution:abort">暂时无法确认（UNKNOWN）</span>
          </div>
          <p class="danger-note"><code>pausePending</code> 只表示暂停请求已登记；只有宿主投影报告已暂停 <code>PAUSED</code> 才显示为已暂停。</p>
        </form>
      </details>
        </div>
      </section>
        </div>
      </section>
    </main>
  </div>

  <script>
  (() => {
    'use strict';
    const CONFIG = __CONSOLE_CONFIG__;
    const CHARACTER_ASSETS = __CONSOLE_CHARACTER_ASSETS__;
    const CHARACTER_SVGS = __CONSOLE_CHARACTER_SVGS__;
    const THEME_CHOICES = __CONSOLE_THEMES__;
    const THEME_STORAGE_KEY = 'dsh-kingdom.console.theme';
    const state = { capabilities: null, snapshot: null, detail: null, detailTaskId: '', detailEpoch: 0, selectedTaskId: '', selectedExecutionId: '', activeSection: 'overview', navigationHash: null, lastRevision: null, lastLoadedAt: 0, loading: false, commandBusy: false, commandRefreshPending: false, stale: false, requestCounter: 0, territoryChoices: [], selectedTerritoryId: '', territoryCommandIndex: 0, connectorFrame: 0 };
    const unavailableCharacterAssets = new Set();
    const byId = id => document.getElementById(id);
    const text = value => value === null || value === undefined || value === '' ? 'UNKNOWN' : String(value);
    const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const setText = (id, value) => { const node = byId(id); if (node) node.textContent = text(value); };
    const append = (parent, tag, value, className) => { const node = document.createElement(tag); if (className) node.className = className; node.textContent = text(value); parent.append(node); return node; };
    const setLabelWithCode = (id, value, codeValue) => { const node = byId(id); if (!node) return; node.replaceChildren(); append(node, 'span', value); if (codeValue) append(node, 'code', codeValue, 'code-badge'); };
    const clear = id => { const node = byId(id); if (node) node.replaceChildren(); return node; };
    const normalizeThemeChoice = (value, fallback) => THEME_CHOICES.some(theme => theme.id === value) ? value : (fallback || 'forest');
    const applyThemeChoice = (value, persist = true) => {
      const themeId = normalizeThemeChoice(value, 'forest'); const choice = THEME_CHOICES.find(theme => theme.id === themeId) || THEME_CHOICES.find(theme => theme.id === 'forest') || THEME_CHOICES[0];
      document.documentElement.dataset.theme = themeId;
      document.querySelectorAll('[data-theme-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.getAttribute('data-theme-choice') === themeId)));
      setText('active-theme-name', choice.label);
      if (persist) { try { localStorage.setItem(THEME_STORAGE_KEY, themeId); } catch (_) { /* presentation preference remains in-memory */ } }
      return themeId;
    };
    const initializeTheme = () => {
      let stored = 'forest';
      try { stored = localStorage.getItem(THEME_STORAGE_KEY) || 'forest'; } catch (_) { /* storage may be unavailable */ }
      applyThemeChoice(stored, false);
      document.querySelectorAll('[data-theme-choice]').forEach(button => button.addEventListener('click', () => applyThemeChoice(button.getAttribute('data-theme-choice') || 'forest')));
    };
    const stableReason = value => { const item = record(value); return typeof value === 'string' ? value : text(item.code || item.reason || item.errorCode); };
    const authoritativeStateValue = value => {
      if (value && typeof value === 'object') { const item = record(value); return typeof item.value === 'string' && item.value ? item.value : 'UNKNOWN'; }
      return value;
    };
    const stateMeaning = value => {
      const code = text(authoritativeStateValue(value)).trim().toUpperCase();
      const labels = {
        UNKNOWN: '尚未确认', NOT_RUN: '尚未运行', REVIEW: '待审', RECOVERING: '恢复核对中', LEGACY_COMPAT: '兼容执行路径',
        ACTIVE: '可用', INACTIVE: '未启用', EXPIRED: '已过期', REVOKED: '已关闭', FAILED: '已失败',
        OK: '安定', HEALTHY: '安定', STABLE: '安定', ATTENTION: '需要留意', DEGRADED: '需要留意', CRITICAL: '有要务待处置',
        PLANNED: '已立项', ASSIGNED: '已指派', RUNNING: '进行中', FROZEN: '冻结', DONE: '已完成', ABORTED: '已终止',
        STARTING: '正在启动', PAUSED: '已暂停', COMPLETED: '平台执行已结束', ACCEPT: '接受呈报', REWORK: '要求返工',
        FAIL: '判定失败', HANDOFF: '移交', NONE: '无', GOVERNED_PERSISTENT: '持久治理执行',
        WARNING: '需要留意', INFO: '提示', HIGH: '高', MEDIUM: '中', LOW: '低', PENDING: '待处理'
      };
      return { code, label: labels[code] || '状态待解释' };
    };
    const statusTone = value => {
      const code = text(authoritativeStateValue(value)).trim().toUpperCase();
      if (['FAILED', 'FAIL', 'ABORTED', 'CRITICAL', 'BLOCKED', 'CONFUSED'].includes(code)) return { tone: 'blocked', label: '异常或阻塞', icon: '!' , code, priority: 60 };
      if (['UNKNOWN', 'NOT_RUN', 'RECOVERING', 'INDETERMINATE', 'ATTENTION', 'DEGRADED'].includes(code)) return { tone: 'unknown', label: '尚未确认', icon: '?', code, priority: 50 };
      if (['REVIEW', 'REWORK', 'REVIEWING', 'PLANNING', 'HANDOFF'].includes(code)) return { tone: 'review', label: '待复核', icon: '◆', code, priority: 40 };
      if (['RUNNING', 'STARTING', 'WORKING', 'ASSIGNING'].includes(code)) return { tone: 'running', label: '执行中', icon: '▶', code, priority: 30 };
      if (['DONE', 'ACCEPT', 'COMPLETED', 'CELEBRATING'].includes(code)) return { tone: 'done', label: '已完成', icon: '✓', code, priority: 20 };
      if (['PLANNED', 'ASSIGNED', 'WAITING', 'IDLE', 'SLEEPING', 'PAUSED', 'ACTIVE', 'NONE', 'ABSENT'].includes(code)) return { tone: 'idle', label: '待命', icon: '○', code, priority: 10 };
      return { tone: 'unknown', label: '状态待解释', icon: '?', code, priority: 50 };
    };
    const taskStatusPresentation = (tasks, fallbackState) => {
      const candidates = (Array.isArray(tasks) ? tasks : []).map(task => { const item = record(task); const projectionData = record(record(item.projection).data); return { task, presentation: statusTone(item.status || projectionData.status || 'UNKNOWN') }; });
      if (!candidates.length) return { task: null, presentation: statusTone(fallbackState || 'UNKNOWN') };
      candidates.sort((left, right) => right.presentation.priority - left.presentation.priority || text(record(left.task).title).localeCompare(text(record(right.task).title), 'zh-CN'));
      return candidates[0];
    };
    const isActiveRole = role => stateMeaning(role && (role.status || role.state)).code === 'ACTIVE';
    const stateDisplay = value => { const meaning = stateMeaning(value); return meaning.label + '（' + meaning.code + '）'; };
    const reasonDisplay = value => {
      const code = text(value).trim().toUpperCase();
      const labels = {
        UNKNOWN: '暂时无法确认', SESSION_AUTH_REQUIRED: '需要有效角色会话', DIRECT_SLASH_REQUIRED: '仅可由人类直接输入 Slash',
        SCOPE_MISMATCH: '当前资源不在职权范围', DECISION_NOT_AVAILABLE: '宿主未开放这项裁决', SANDBOX_MODE_REQUIRED: '请选择宿主开放的沙箱模式',
        STALE_PROJECTION: '王国投影已过时，请先重新读取',
        CONTROL_SESSION_EXPIRED: '本地控制通道已过期', CONTROL_SESSION_REQUIRED: '需要本地控制通道', CONTROL_REPLAY_DENIED: '重复请求已拒绝',
        CONTROL_CSRF_DENIED: '请求校验失败', CONTROL_ORIGIN_DENIED: '请求来源被拒绝', INACTIVE: '操作通道未启用', EXPIRED: '操作通道已过期',
        REVOKED: '操作通道已关闭', FAILED: '操作通道校验失败'
      };
      return (labels[code] || '宿主拒绝此动作') + '（' + code + '）';
    };
    const actionDisplay = value => ({
      'task.create': '新建任务', plan: '新建任务', assign: '指派执行者', start: '开始执行',
      'review:accept': '接受呈报', 'review:rework': '要求返工', 'review:fail': '判定失败', 'review:handoff': '移交', review: '裁决呈报',
      'execution:pause': '暂停', 'execution.pause': '暂停', 'execution:resume': '继续', 'execution.resume': '继续',
      'execution:abort': '终止', 'execution.abort': '终止', 'control.revoke': '关闭本地控制通道'
    })[value] || value;
    const status = (message, level, technical) => {
      const node = byId('status-line'); if (!node) return; node.textContent = message; node.dataset.level = level || 'neutral';
      const detail = byId('status-technical'); const detailCode = byId('status-technical-code'); const technicalText = technical ? text(technical).slice(0, 240) : '';
      if (detail) { detail.hidden = !technicalText; if (!technicalText) detail.open = false; }
      if (detailCode) detailCode.textContent = technicalText;
    };
    const aliases = action => ({
      'task.create': ['task.create', 'plan'],
      assign: ['assign'],
      start: ['start', 'governed-start', 'governed.start'],
      'review:accept': ['review:accept', 'review'],
      'review:rework': ['review:rework', 'review'],
      'review:fail': ['review:fail', 'review'],
      'review:handoff': ['review:handoff', 'review'],
      'execution:pause': ['execution:pause', 'execution.pause'],
      'execution:resume': ['execution:resume', 'execution.resume'],
      'execution:abort': ['execution:abort', 'execution.abort'],
      'control.revoke': ['control.revoke']
    })[action] || [action];
    const capabilityState = value => {
      const normalized = String(value || '').trim().toUpperCase();
      if (['ACTIVE', 'INACTIVE', 'EXPIRED', 'REVOKED', 'FAILED', 'UNKNOWN'].includes(normalized)) return normalized;
      if (['READY', 'ENABLED', 'VALID'].includes(normalized)) return 'ACTIVE';
      if (['DISABLED', 'CLOSED'].includes(normalized)) return 'INACTIVE';
      if (['ERROR', 'BROKEN'].includes(normalized)) return 'FAILED';
      return 'UNKNOWN';
    };
    const normalizeAllowedActions = raw => {
      const actions = {};
      if (Array.isArray(raw)) {
        raw.forEach(value => {
          if (typeof value === 'string') { actions[value] = { executable: false, disabledReason: 'UNKNOWN' }; return; }
          const item = record(value); const action = typeof item.action === 'string' ? item.action : typeof item.name === 'string' ? item.name : '';
          if (!action) return; const executable = item.executable === true || item.enabled === true || item.allowed === true; actions[action] = { executable, disabledReason: executable ? null : stableReason(item.disabledReason || item.disabled_reason || item.reason || item.errorCode || 'UNKNOWN') };
        });
        return actions;
      }
      const source = record(raw); Object.keys(source).forEach(name => { const value = source[name]; const item = record(value); const executable = value === true || item.executable === true || item.enabled === true || item.allowed === true; actions[name] = { executable, disabledReason: executable ? null : stableReason(item.disabledReason || item.disabled_reason || item.reason || item.errorCode || 'UNKNOWN') }; });
      return actions;
    };
    const normalizeCapabilities = raw => {
      const root = record(raw); const control = record(root.controlSession || root.control_session); const session = record(root.session);
      let stateName = capabilityState(root.state || root.status || control.state || session.state || root.sessionState);
       if (root.active === true && stateName === 'UNKNOWN') stateName = 'ACTIVE';
       if (root.active === false && stateName === 'UNKNOWN') stateName = 'INACTIVE';
      const expiry = root.expiresAt || root.expires_at || control.expiresAt || control.expires_at || session.expiresAt || null;
      if (stateName === 'ACTIVE' && expiry && Number.isFinite(Date.parse(expiry)) && Date.parse(expiry) <= Date.now()) stateName = 'EXPIRED';
      const actions = normalizeAllowedActions(root.allowedActions || root.allowed_actions); const rawActions = record(root.actions || root.capabilities || root.commandCoverage || root.command_coverage);
      Object.keys(rawActions).forEach(name => { if (actions[name]) return; const value = rawActions[name]; const item = record(value); const executable = value === true || (value && typeof value === 'object' && (item.executable === true || item.enabled === true || item.allowed === true)); actions[name] = { executable, disabledReason: executable ? null : stableReason(item.disabledReason || item.disabled_reason || item.reason || item.errorCode || 'UNKNOWN') }; });
       const commands = Array.isArray(root.commands) ? root.commands.filter(name => typeof name === 'string') : [];
       const reviewDecisions = Array.isArray(root.reviewDecisions || root.review_decisions) ? (root.reviewDecisions || root.review_decisions).filter(value => typeof value === 'string').slice(0, 16) : []; const sandboxModes = Array.isArray(root.sandboxModes || root.sandbox_modes) ? (root.sandboxModes || root.sandbox_modes).filter(value => typeof value === 'string').slice(0, 16) : [];
       return { state: stateName, active: root.active === true || stateName === 'ACTIVE', expiresAt: expiry, csrfToken: typeof root.csrfToken === 'string' ? root.csrfToken : typeof control.csrfToken === 'string' ? control.csrfToken : typeof session.csrfToken === 'string' ? session.csrfToken : null, roleSessionBound: root.roleSessionBound === true || control.roleSessionBound === true || session.roleSessionBound === true, commands, reviewDecisions, sandboxModes, disabledReason: typeof root.disabledReason === 'string' ? root.disabledReason : null, actions };
    };
    const actionState = (action, ownerOnly, resourceScope) => {
      if (ownerOnly) return { executable: false, reason: 'DIRECT_SLASH_REQUIRED' };
      const capabilities = state.capabilities;
      if (!capabilities || capabilities.state === 'UNKNOWN' || capabilities.state === 'FAILED') return { executable: false, reason: 'UNKNOWN' };
      if (['INACTIVE', 'EXPIRED', 'REVOKED'].includes(capabilities.state)) return { executable: false, reason: 'SESSION_AUTH_REQUIRED' };
      if (state.stale && action !== 'control.revoke') return { executable: false, reason: 'STALE_PROJECTION' };
      let entry = null; aliases(action).some(name => { if (capabilities.actions[name]) { entry = capabilities.actions[name]; return true; } return false; });
      if (!entry || !entry.executable) return { executable: false, reason: entry && entry.disabledReason ? entry.disabledReason : 'UNKNOWN' };
      if (resourceScope) {
        const resourceActions = normalizeAllowedActions(resourceActionsFor(resourceScope)); let resourceEntry = null;
        aliases(action).some(name => { if (resourceActions[name]) { resourceEntry = resourceActions[name]; return true; } return false; });
        if (!resourceEntry || !resourceEntry.executable) return { executable: false, reason: resourceEntry && resourceEntry.disabledReason ? resourceEntry.disabledReason : 'UNKNOWN' };
      }
      return { executable: true, reason: null };
    };
    const renderGates = () => {
      document.querySelectorAll('[data-gated-action]').forEach(button => {
        const action = button.getAttribute('data-gated-action') || ''; const ownerOnly = button.getAttribute('data-owner-only') === 'true'; const resourceScope = button.getAttribute('data-resource-action') || ''; let gate = actionState(action, ownerOnly, resourceScope);
        if (action === 'start' && gate.executable && !String(byId('start-sandbox') && byId('start-sandbox').value || '')) gate = { executable: false, reason: 'SANDBOX_MODE_REQUIRED' };
        const reviewDecision = button.getAttribute('data-review-decision');
        if (reviewDecision && gate.executable) { const decisions = state.capabilities && Array.isArray(state.capabilities.reviewDecisions) ? state.capabilities.reviewDecisions.map(value => String(value).toUpperCase()) : []; if (!decisions.includes(reviewDecision)) gate = { executable: false, reason: 'DECISION_NOT_AVAILABLE' }; }
        button.disabled = !gate.executable || state.commandBusy; button.setAttribute('aria-disabled', String(button.disabled));
        const reason = document.querySelector('[data-reason-for="' + action + '"]'); if (reason) reason.textContent = gate.executable ? '可以执行' : reasonDisplay(gate.reason);
      });
    };
    const renderCapabilities = raw => {
      state.capabilities = normalizeCapabilities(raw); const value = state.capabilities; const chip = byId('session-chip');
      if (chip) chip.dataset.state = value.state; setText('session-chip-label', '操作通道：' + stateMeaning(value.state).label); setText('session-chip-code', value.state);
      setText('capability-state-label', stateMeaning(value.state).label + (value.roleSessionBound ? ' · 已绑定角色会话' : '')); setText('capability-state-code', value.state);
      setText('capability-expiry', '有效期：' + (value.expiresAt || '尚未确认') + ' · 投影版本：' + text(state.lastRevision));
      const note = byId('capability-note'); if (note) note.textContent = value.state === 'ACTIVE' ? '只有宿主明确开放的动作才可点击；每次写入都带校验信息与唯一请求号，宿主仍会再次核验。' : '操作通道不可用；浏览器不会构造治理身份。原因：' + reasonDisplay(value.disabledReason || value.state);
      renderCapabilityOptions(); renderGates();
    };
    const endpoint = (template, value) => template.replace('{taskId}', encodeURIComponent(value || '')).replace('{command}', encodeURIComponent(value || ''));
     const requestJson = async (url, init, timeoutMs) => {
       const headers = Object.assign({ Accept: 'application/json' }, init && init.headers ? init.headers : {}); const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), Number(timeoutMs || CONFIG.endpoints.readTimeoutMs || 10000)); let response;
       try { response = await fetch(url, Object.assign({ credentials: 'same-origin' }, init || {}, { headers, signal: controller.signal })); } catch (error) { if (error && error.name === 'AbortError') { const timeoutError = new Error('CONTROL_TIMEOUT'); timeoutError.code = 'UNKNOWN'; throw timeoutError; } throw error; } finally { clearTimeout(timeout); }
       let body = null;
       try { body = await response.json(); } catch (_) { body = null; }
       if (!response.ok) { const bodyObject = record(body); const code = text(bodyObject.errorCode || bodyObject.code || (response.status >= 500 ? 'UNKNOWN' : 'HTTP_' + response.status)); const error = new Error(text(bodyObject.message || code)); error.code = code; throw error; }
       return body || {};
     };
     const commandPayload = payload => { const clean = {}; Object.keys(payload || {}).forEach(key => { if (!['session_id', 'sessionId', 'principal_id', 'principalId', 'agent_id', 'agentId', 'agent', 'actor_id', 'actorId', 'owner_capability', 'ownerCapability', 'authorization', 'cookie', 'csrf_token', 'csrfToken', 'request_id', 'requestId', 'source_channel', 'sourceChannel', 'ticket', 'launch_ticket', 'launchTicket', 'control_token', 'controlToken', 'activation_id', 'activationId'].includes(key)) clean[key] = payload[key]; }); return clean; };
     const nextRequestId = () => { state.requestCounter += 1; try { if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID(); } catch (_) {} return 'console-' + Date.now().toString(36) + '-' + state.requestCounter.toString(36); };
     const controlFailureView = error => { const code = text(error && error.code); const stateName = code === 'CONTROL_SESSION_EXPIRED' ? 'EXPIRED' : code === 'CONTROL_SESSION_REQUIRED' ? 'INACTIVE' : code === 'CONTROL_REPLAY_DENIED' || code === 'CONTROL_CSRF_DENIED' || code === 'CONTROL_ORIGIN_DENIED' ? 'FAILED' : 'UNKNOWN'; return { state: stateName, active: false, expiresAt: null, csrfToken: null, roleSessionBound: false, commands: [], reviewDecisions: [], sandboxModes: [], disabledReason: code, actions: {} }; };
     const postCommand = async (commandName, payload) => { const capabilities = state.capabilities; if (!capabilities || capabilities.state !== 'ACTIVE' || !capabilities.csrfToken) { const error = new Error('CONTROL_CSRF_REQUIRED'); error.code = 'CONTROL_CSRF_REQUIRED'; throw error; } const command = commandPayload(payload); return requestJson(endpoint(CONFIG.endpoints.command, commandName), { method: 'POST', headers: { 'Content-Type': 'application/json', [CONFIG.endpoints.clientHeader]: 'console-app', [CONFIG.endpoints.csrfHeader]: capabilities.csrfToken, [CONFIG.endpoints.requestIdHeader]: nextRequestId() }, body: JSON.stringify(command) }, Number(CONFIG.endpoints.commandTimeoutMs || 75000)); };
     const optionValue = value => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
     const entityId = (reference, legacyId) => { const ref = record(reference); const canonicalId = ref.id; if (typeof canonicalId === 'string' && canonicalId) return canonicalId; const compatibleId = ref.entityId; if (typeof compatibleId === 'string' && compatibleId) return compatibleId; return typeof legacyId === 'string' ? legacyId : ''; };
     const hasEntityReference = reference => Object.keys(record(reference)).length > 0;
     const typedEntityId = (reference, expectedType) => { const ref = record(reference); const refType = typeof ref.type === 'string' ? ref.type : typeof ref.entityType === 'string' ? ref.entityType : ''; return refType === expectedType ? entityId(ref) : ''; };
     const canonicalOrLegacyEntityId = (reference, legacyId, expectedType) => hasEntityReference(reference) ? typedEntityId(reference, expectedType) : optionValue(legacyId);
     const executionIdOf = value => { const item = record(value); if (hasEntityReference(item.executionRef)) return typedEntityId(item.executionRef, 'execution'); if (hasEntityReference(item.entityRef)) return typedEntityId(item.entityRef, 'execution'); return optionValue(item.executionId || item.execution_id); };
     const executionTaskIdOf = value => { const item = record(value); return canonicalOrLegacyEntityId(item.taskRef, item.taskId || item.task_id, 'task'); };
     const renderSelect = (id, items, emptyLabel, selected) => { const select = byId(id); if (!select) return; const previous = selected === undefined ? select.value : selected; select.replaceChildren(); append(select, 'option', emptyLabel).value = ''; items.forEach(item => { const option = document.createElement('option'); option.value = optionValue(item.value); option.textContent = text(item.label); select.append(option); }); select.value = items.some(item => optionValue(item.value) === previous) ? previous : ''; };
     const closeTerritoryCommandMenu = () => {
       const input = byId('task-title'); const menu = byId('territory-command-menu'); if (menu) menu.hidden = true; if (input) input.setAttribute('aria-expanded', 'false'); state.territoryCommandIndex = 0;
     };
     const territoryCommandQuery = () => {
       const input = byId('task-title'); if (!input) return null; const slash = String(input.value || '').lastIndexOf('/'); return slash < 0 ? null : String(input.value || '').slice(slash + 1).trim().toLocaleLowerCase('zh-CN');
     };
     const chooseComposerTerritory = choice => {
       const select = byId('task-territory'); const input = byId('task-title'); const chip = byId('task-territory-chip'); const hint = byId('task-composer-hint');
       if (!choice || !optionValue(choice.value)) return;
       state.selectedTerritoryId = optionValue(choice.value); if (select) select.value = state.selectedTerritoryId;
       if (chip) { chip.hidden = false; chip.textContent = '/ ' + text(choice.label); }
       if (hint) hint.textContent = '任务将进入“' + text(choice.label) + '”；主管仍由宿主按真实绑定核验。';
       if (input) { const slash = String(input.value || '').lastIndexOf('/'); if (slash >= 0) input.value = String(input.value || '').slice(0, slash).trimEnd(); input.focus(); }
       closeTerritoryCommandMenu();
     };
     const clearComposerTerritory = () => {
       const select = byId('task-territory'); const chip = byId('task-territory-chip'); const hint = byId('task-composer-hint'); state.selectedTerritoryId = ''; if (select) select.value = ''; if (chip) { chip.hidden = true; chip.textContent = ''; } if (hint) hint.textContent = '输入任务名称；按 / 唤出领地。';
     };
     const renderTerritoryCommandMenu = () => {
       const menu = byId('territory-command-menu'); const input = byId('task-title'); if (!menu || !input) return; const query = territoryCommandQuery(); if (query === null) { closeTerritoryCommandMenu(); return; }
       const choices = state.territoryChoices.filter(choice => !query || text(choice.label).toLocaleLowerCase('zh-CN').includes(query)); menu.replaceChildren();
       if (!choices.length) { const empty = append(menu, 'p', '没有匹配的领地', 'empty'); empty.setAttribute('role', 'option'); state.territoryCommandIndex = 0; }
       else { state.territoryCommandIndex = Math.min(state.territoryCommandIndex, choices.length - 1); choices.forEach((choice, index) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'territory-command-option'; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === state.territoryCommandIndex)); button.dataset.territoryValue = optionValue(choice.value); append(button, 'strong', choice.label); append(button, 'small', '选择领地'); if (typeof button.addEventListener === 'function') button.addEventListener('click', () => chooseComposerTerritory(choice)); menu.append(button); }); }
       menu.hidden = false; input.setAttribute('aria-expanded', 'true');
     };
     const moveTerritoryCommandSelection = direction => {
       const options = Array.from(document.querySelectorAll('.territory-command-option')); if (!options.length) return; state.territoryCommandIndex = (state.territoryCommandIndex + direction + options.length) % options.length; options.forEach((option, index) => option.setAttribute('aria-selected', String(index === state.territoryCommandIndex))); const active = options[state.territoryCommandIndex]; if (active && typeof active.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest' });
     };
     const selectedTerritoryChoice = () => state.territoryChoices.find(choice => optionValue(choice.value) === state.selectedTerritoryId) || null;
     const composerTaskTitle = () => { const input = byId('task-title'); const value = String(input && input.value || ''); const slash = value.lastIndexOf('/'); return (slash >= 0 ? value.slice(0, slash) : value).trim(); };
     const renderCapabilityOptions = () => {
      const capabilities = state.capabilities || {};
      const modes = Array.isArray(capabilities.sandboxModes) ? capabilities.sandboxModes.map(value => ({ value, label: value })) : []; const sandbox = byId('start-sandbox'); const previousMode = sandbox ? sandbox.value : '';
      renderSelect('start-sandbox', modes, '尚未确认宿主沙箱模式', previousMode || (modes[0] && modes[0].value)); if (sandbox) { sandbox.disabled = modes.length === 0; sandbox.setAttribute('aria-disabled', String(sandbox.disabled)); }
    };
    const taskItems = () => Array.isArray(state.snapshot && state.snapshot.tasks) ? state.snapshot.tasks : [];
    const selectedTask = () => taskItems().find(task => text(task.taskId) === state.selectedTaskId) || null;
    const executionItems = () => {
      const items = []; const seen = new Set(); const addItems = values => { if (!Array.isArray(values)) return; values.forEach(item => { const value = record(item); const executionId = executionIdOf(value); if (!executionId || seen.has(executionId)) return; seen.add(executionId); items.push(value); }); };
      const projection = record(record(state.snapshot).projection); const projected = record(projection.executions); const projectedData = projected.data;
      addItems(Array.isArray(projectedData) ? projectedData : record(projectedData).items); addItems(record(state.snapshot).executions); addItems(record(state.snapshot).liveExecutions); addItems(record(state.detail).executions);
      return items;
    };
    const selectedExecution = () => executionItems().find(item => executionIdOf(item) === state.selectedExecutionId) || null;
    const structuredActions = value => {
      const item = record(value); const projection = record(item.projection); const data = record(projection.data);
      const candidates = [projection.allowedActions, data.actionAvailability, item.actionAvailability, item.allowedActions];
      for (const candidate of candidates) {
        if (Array.isArray(candidate) || (candidate && typeof candidate === 'object')) return { present: true, actions: normalizeAllowedActions(candidate) };
      }
      return { present: false, actions: {} };
    };
    const taskResourceActions = () => {
      if (state.detail && state.detailTaskId === state.selectedTaskId) { const structured = structuredActions(state.detail); if (structured.present) return structured.actions; }
      return structuredActions(selectedTask()).actions;
    };
    const executionResourceActions = () => {
      const execution = selectedExecution(); const structured = structuredActions(execution); if (structured.present) return structured.actions;
      const task = selectedTask(); const latest = record(task && task.latestExecution); const executionId = execution && executionIdOf(execution);
      return executionId && executionIdOf(latest) === executionId ? taskResourceActions() : {};
    };
    const resourceActionsFor = scope => scope === 'task' ? taskResourceActions() : scope === 'execution' ? executionResourceActions() : {};
    const parseFragment = hash => {
      const fragment = String(hash || '').replace(/^#/, '');
      if (!fragment || fragment === 'overview') return { known: true, section: 'overview', taskId: null };
      if (fragment.indexOf('task=') === 0) { try { const taskId = decodeURIComponent(fragment.slice(5)); return taskId ? { known: true, section: 'tasks', taskId } : { known: false, section: 'overview', taskId: null }; } catch (_) { return { known: false, section: 'overview', taskId: null }; } }
      if (['organization', 'tasks', 'executions', 'activity', 'management', 'ledger'].includes(fragment)) return { known: true, section: fragment, taskId: null };
      return { known: false, section: 'overview', taskId: null };
    };
    const pageForSection = section => ['organization', 'tasks', 'executions', 'activity', 'ledger'].includes(section) ? 'ledger' : section === 'management' ? 'management' : 'overview';
    const renderNavigation = () => {
      const activePage = pageForSection(state.activeSection);
      document.querySelectorAll('[data-nav-section]').forEach(link => { if (pageForSection(link.getAttribute('data-nav-section')) === activePage) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
      document.querySelectorAll('[data-console-page]').forEach(page => { page.hidden = page.getAttribute('data-console-page') !== activePage; });
      document.querySelectorAll('[data-task-link]').forEach(link => { if (link.getAttribute('data-task-id') === state.selectedTaskId) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
      if (activePage === 'overview') scheduleOrganogramConnectors();
    };
    const renderTaskNavigator = () => {
      const parent = clear('task-navigation-list'); if (!parent) return; const tasks = taskItems();
      if (!tasks.length) { addEmpty(parent, '尚无任务；可从“新建任务”开始。'); return; }
      tasks.slice(0, 200).forEach(task => { const link = document.createElement('a'); const presentation = statusTone(task.status); link.className = 'task-link'; link.href = '#task=' + encodeURIComponent(text(task.taskId)); link.dataset.statusTone = presentation.tone; link.setAttribute('data-task-link', 'true'); link.setAttribute('data-task-id', text(task.taskId)); append(link, 'strong', task.title); const statusNode = append(link, 'span', presentation.label, 'task-status'); statusNode.dataset.statusIcon = presentation.icon; if (text(task.taskId) === state.selectedTaskId) link.setAttribute('aria-current', 'page'); parent.append(link); });
    };
    const reconcileSelections = () => {
      const previousTaskId = state.selectedTaskId; const parsed = parseFragment(location.hash); const tasks = taskItems();
      state.activeSection = parsed.known ? parsed.section : 'overview';
      if (!parsed.known) state.selectedTaskId = '';
      else if (parsed.taskId !== null) state.selectedTaskId = parsed.taskId;
      else if (!tasks.some(task => text(task.taskId) === state.selectedTaskId)) state.selectedTaskId = tasks[0] ? text(tasks[0].taskId) : '';
      if (state.selectedTaskId !== previousTaskId) { state.detail = null; state.detailTaskId = ''; state.detailEpoch += 1; }
      const executions = executionItems(); const task = selectedTask(); const latestId = executionIdOf(record(task && task.latestExecution));
      if (!executions.some(item => executionIdOf(item) === state.selectedExecutionId)) state.selectedExecutionId = executions.some(item => executionIdOf(item) === latestId) ? latestId : executions[0] ? executionIdOf(executions[0]) : '';
      return parsed;
    };
    const renderSelectors = () => {
      const tasks = taskItems().map(task => ({ value: task.taskId, label: text(task.title) + ' · ' + stateDisplay(task.status) })); const organizationData = record(record(record(state.snapshot).projection).organization).data; const organization = record(organizationData); const hasProjectedTerritories = Array.isArray(organization.territories); const projectedTerritories = hasProjectedTerritories ? organization.territories : []; const legacyTerritories = Array.isArray(state.snapshot && state.snapshot.territories) ? state.snapshot.territories : []; const territories = (hasProjectedTerritories ? projectedTerritories : legacyTerritories).map(item => { const value = canonicalOrLegacyEntityId(item.territoryRef, item.territoryId, 'territory'); return { value, label: item.name || value }; }).filter(item => item.value);
      const projectedRoles = Array.isArray(organization.roles) ? organization.roles : [];
      const bindings = projectedRoles
        .filter(item => String(item.roleType || item.role_type || '').toUpperCase() === 'WORKER' && isActiveRole(item))
        .map(item => { const value = typedEntityId(item.bindingRef, 'binding'); return { value, label: text(item.roleName || item.role_name) + ' · ' + text(value) }; })
        .filter(item => item.value);
      document.querySelectorAll('[data-task-selector]').forEach(select => { renderSelect(select.id, tasks, '选择任务', state.selectedTaskId); }); state.territoryChoices = territories; renderSelect('task-territory', territories, '由宿主选择领地', state.selectedTerritoryId); if (state.selectedTerritoryId && !selectedTerritoryChoice()) clearComposerTerritory(); if (territoryCommandQuery() !== null) renderTerritoryCommandMenu(); renderSelect('assign-worker', bindings, '等待宿主返回可用执行者', undefined); renderSelect('review-handoff-binding', bindings, '选择在任执行者绑定', undefined);
      const executions = executionItems().map(item => ({ value: executionIdOf(item), label: stateDisplay(item.state || item.authoritativeState) + ' · ' + text(executionIdOf(item)) })); renderSelect('execution-control-id', executions, '选择宿主投影中的执行记录', state.selectedExecutionId);
    };
    const addDataRow = (parent, label, value, className) => { const row = document.createElement('div'); row.className = 'data-row ' + (className || ''); append(row, 'span', label); append(row, 'strong', value, 'mono'); parent.append(row); };
    const addStateRow = (parent, label, value, className) => { const row = document.createElement('div'); row.className = 'data-row ' + (className || ''); append(row, 'span', label); const valueNode = document.createElement('strong'); valueNode.className = 'state-value'; const meaning = stateMeaning(value); append(valueNode, 'span', meaning.label); append(valueNode, 'code', meaning.code, 'code-badge'); row.append(valueNode); parent.append(row); };
    const addMetric = (parent, label, value, href) => { const item = document.createElement(href ? 'a' : 'div'); item.className = 'metric'; if (href) item.href = href; const code = String(value ?? ''); const unknown = code === 'UNKNOWN' || code === 'UNKNOWN / NOT_RUN'; append(item, 'strong', unknown ? '尚未确认' : value); append(item, 'span', label); if (unknown) append(item, 'code', code, 'code-badge'); parent.append(item); };
    const addEmpty = (parent, value) => { if (parent) append(parent, 'p', value, 'empty'); };
    const countValue = (value, fallbackPresent, fallbackValue) => value === undefined || value === null ? fallbackPresent ? fallbackValue : 'UNKNOWN / NOT_RUN' : value;
    const readableCount = value => value === 'UNKNOWN' || value === 'UNKNOWN / NOT_RUN' ? '尚未确认' : text(value);
    const roleTitle = value => ({ OWNER: '王国所有者', CHANCELLOR: '执政官', SUPERVISOR: '领地主理人', WORKER: '执行者' })[String(value || '').toUpperCase()] || '成员';
    const renderLegacyKingdomMap = (snapshot, organizationData, taskCount) => {
      const kingdom = record(snapshot.kingdom); const legacyTerritories = Array.isArray(snapshot.territories) ? snapshot.territories : []; const legacyBindings = Array.isArray(snapshot.bindings) ? snapshot.bindings : [];
      const hasProjectedTerritories = Array.isArray(organizationData.territories); const projectedTerritories = hasProjectedTerritories ? organizationData.territories : []; const hasProjectedRoles = Array.isArray(organizationData.roles); const projectedRoles = hasProjectedRoles ? organizationData.roles : [];
      const territories = hasProjectedTerritories ? projectedTerritories : legacyTerritories; const roles = (hasProjectedRoles ? projectedRoles : legacyBindings).filter(isActiveRole);
      const rolesOf = roleType => roles.filter(item => isActiveRole(item) && String(item.roleType || item.role_type || '').toUpperCase() === roleType); const firstRoleName = roleType => { const role = rolesOf(roleType)[0]; return role ? text(role.roleName || role.role_name) : '尚未投影'; };
      const ownerRole = rolesOf('OWNER')[0]; setText('realm-owner-name', ownerRole ? text(ownerRole.roleName || ownerRole.role_name) : (snapshot.kingdom || organizationData.kingdomName ? '人类所有者' : '人类所有者 · 尚未确认'));
      const chancellors = rolesOf('CHANCELLOR'); setText('realm-chancellor-name', firstRoleName('CHANCELLOR')); if (chancellors.length) setText('realm-chancellor-meta', chancellors.length + ' 个在册绑定'); else setLabelWithCode('realm-chancellor-meta', '绑定数量尚未确认', 'UNKNOWN');
      const supervisors = rolesOf('SUPERVISOR'); const territoryCount = organizationData.territoryCount === undefined ? (hasProjectedTerritories ? territories.length : territories.length || 'UNKNOWN') : organizationData.territoryCount; setText('realm-supervisor-name', firstRoleName('SUPERVISOR')); if (readableCount(territoryCount) === '尚未确认') setLabelWithCode('realm-supervisor-meta', '领地数量尚未确认', 'UNKNOWN'); else setText('realm-supervisor-meta', '领地数量 ' + readableCount(territoryCount));
      const workers = rolesOf('WORKER'); setText('realm-worker-name', workers.length > 1 ? workers.length + ' 位执行者' : firstRoleName('WORKER')); if (readableCount(taskCount) === '尚未确认') setLabelWithCode('realm-worker-meta', '任务数量尚未确认', 'UNKNOWN'); else setText('realm-worker-meta', '任务数量 ' + readableCount(taskCount));
      const territoryParent = clear('territory-map-list'); if (!territoryParent) return;
      if (!territories.length) { addEmpty(territoryParent, '领地尚未投影。'); return; }
      territories.slice(0, 9).forEach(territory => { const link = document.createElement('a'); link.className = 'territory-link'; link.href = '#organization'; append(link, 'strong', territory.name || canonicalOrLegacyEntityId(territory.territoryRef, territory.territoryId, 'territory')); const taskLabel = territory.taskCount === undefined ? '任务数量尚未确认' : '任务 ' + territory.taskCount; append(link, 'span', taskLabel + ' · ' + stateDisplay(territory.status)); territoryParent.append(link); });
      if (organizationData.territoriesTruncated === true) addEmpty(territoryParent, '领地投影已截断；这里只显示有界摘要。');
      if (!kingdom.name && organizationData.kingdomName) kingdom.name = organizationData.kingdomName;
    };
    const fieldValue = (item, ...keys) => {
      const source = record(item);
      for (const key of keys) {
        const value = source[key];
        if (typeof value === 'string' && value) return value;
        if (value && typeof value === 'object') {
          const nested = record(value); const nestedValue = nested.id || nested.ref || nested.value || nested.bindingId || nested.territoryId;
          if (typeof nestedValue === 'string' && nestedValue) return nestedValue;
        }
      }
      return '';
    };
    const roleBindingRef = role => fieldValue(role, 'bindingRef', 'bindingId', 'binding_id', 'memberRef');
    const roleTerritoryRef = role => fieldValue(role, 'territoryRef', 'territoryId', 'territory_id', 'territory');
    const taskTerritoryRef = task => fieldValue(task, 'territoryRef', 'territoryId', 'territory_id', 'territory');
    const taskWorkerRef = task => fieldValue(task, 'assignedBindingId', 'assigned_binding_id', 'workerBindingRef', 'workerBindingId', 'worker_binding_id', 'bindingRef', 'bindingId');
    const sameRef = (left, right) => Boolean(left && right && String(left) === String(right));
    const stableStringHash = value => { let hash = 2166136261; for (const character of String(value || '')) { hash ^= character.codePointAt(0) || 0; hash = Math.imul(hash, 16777619); } return hash >>> 0; };
    const territoryToneAssignments = territories => {
      const entries = (Array.isArray(territories) ? territories : []).map((territory, index) => ({ territory, index, key: fieldValue(territory, 'territoryRef', 'territoryId', 'territory_id', 'id') || text(record(territory).name) + ':' + index }));
      const assigned = new Map(); const used = new Set();
      entries.slice().sort((left, right) => left.key.localeCompare(right.key)).forEach(entry => { const start = stableStringHash(entry.key) % 6; let slot = start; for (let offset = 0; offset < 6; offset += 1) { const candidate = (start + offset) % 6; if (!used.has(candidate) || used.size >= 6) { slot = candidate; break; } } used.add(slot); assigned.set(entry.territory, String(slot + 1)); });
      return assigned;
    };
    const stageMeaning = value => {
      const code = text(value).trim().toLowerCase();
      const labels = {
        absent: '未绑定', idle: '待命', working: '工作中', sleeping: '休息中',
        planning: '规划中', assigning: '派发中', reviewing: '复核中', review: '复核中', waiting: '等待执行',
        celebrating: '庆祝中', confused: '执行受阻', blocked: '执行受阻',
      };
      return { code, label: labels[code] || '状态待解释' };
    };
    const visualStateFor = (kind, value) => {
      const code = text(value).trim().toLowerCase();
      if (code === 'sleeping') return 'sleeping';
      if (code === 'planning' || code === 'confused' || code === 'blocked' || code === 'reviewing' || code === 'review') return 'thinking';
      if (code === 'assigning' || code === 'working') return 'working';
      if (code === 'waiting' || code === 'idle' || code === 'celebrating') return 'idle';
      return kind === 'WORKER' && code === 'pausepending' ? 'working' : null;
    };
    const exactStageFor = (snapshot, role, kind) => {
      const binding = roleBindingRef(role);
      if (!binding) return null;
      const actors = Array.isArray(record(snapshot).stage) ? snapshot.stage : [];
      return actors.find(actor => String(actor.role || '').toUpperCase() === kind
        && sameRef(fieldValue(actor, 'bindingId', 'binding_id', 'bindingRef'), binding)) || null;
    };
    const visualFor = (snapshot, role, kind) => {
      const binding = roleBindingRef(role);
      if (!binding) return { evidence: 'unbound', state: 'absent', visualState: null, asset: null, label: '未绑定 · 不渲染角色', actor: null };
      const actor = exactStageFor(snapshot, role, kind);
      if (!actor) return { evidence: 'missing', state: 'idle', visualState: 'idle', asset: CHARACTER_ASSETS[kind].idle, label: '待命 · 实时状态不可用', actor: null };
      const stateCode = text(actor.state).trim().toLowerCase();
      if (stateCode === 'absent') return { evidence: 'absent', state: stateCode, visualState: null, asset: null, label: '未绑定 · 不渲染角色', actor };
      if (actor.indeterminate === true) {
        return {
          evidence: 'indeterminate',
          state: stateCode,
          visualState: stateCode === 'confused' ? 'thinking' : 'idle',
          asset: CHARACTER_ASSETS[kind][stateCode === 'confused' ? 'thinking' : 'idle'],
          label: stateCode === 'confused' ? '实时状态不可用 · 多条执行证据' : '所属领地未确认 · 实时状态不可用',
          actor,
        };
      }
      const visualState = visualStateFor(kind, stateCode);
      if (!visualState) return { evidence: 'unsupported', state: stateCode, visualState: 'idle', asset: CHARACTER_ASSETS[kind].idle, label: '待命 · 状态不可解释', actor };
      const transient = actor.transient === true ? ' · 短暂动作' : '';
      return { evidence: 'exact', state: stateCode, visualState, asset: CHARACTER_ASSETS[kind][visualState], label: stageMeaning(stateCode).label + transient + ' · 实时状态', actor };
    };
    const characterLabel = kind => kind === 'CHANCELLOR' ? '宰相像素人物' : kind === 'SUPERVISOR' ? '主管像素人物' : '骑士像素人物';
    const characterAssetFile = asset => {
      const prefix = '/gui-assets/characters/';
      if (typeof asset !== 'string' || !asset.startsWith(prefix)) return null;
      const fileName = asset.slice(prefix.length);
      return Object.hasOwn(CHARACTER_SVGS, fileName) ? fileName : null;
    };
    const parseInlineCharacterSvg = markup => {
      if (typeof markup !== 'string' || !markup.includes('<svg')) return null;
      const template = document.createElement('template');
      template.innerHTML = markup;
      const root = template.content && typeof template.content.querySelector === 'function'
        ? template.content.querySelector('svg')
        : template.content && template.content.firstElementChild;
      return root && String(root.tagName || '').toLowerCase() === 'svg' ? root : null;
    };
    const characterRenderRoot = image => {
      if (image.shadowRoot) return image.shadowRoot;
      if (typeof image.attachShadow === 'function') {
        try { return image.attachShadow({ mode: 'open' }); } catch (_) { /* bounded light-DOM fallback */ }
      }
      return image;
    };
    const applyCharacterVisual = (image, kind, visual) => {
      image.dataset.role = String(kind).toLowerCase();
      image.dataset.animationState = visual.visualState || 'absent';
      image.dataset.stageEvidence = visual.evidence;
      const requestedAsset = visual.asset || '';
      const previousAsset = image.dataset.assetUrl || '';
      const label = characterLabel(kind);
      const renderRoot = characterRenderRoot(image);
      const resourceUnavailable = () => {
        if (image.dataset.resourceState === 'unavailable' && image.dataset.assetUrl === requestedAsset) return;
        if (requestedAsset) unavailableCharacterAssets.add(requestedAsset);
        image.hidden = true;
        image.dataset.resourceState = 'unavailable';
        if (typeof renderRoot.replaceChildren === 'function') renderRoot.replaceChildren();
        if (typeof image.removeAttribute === 'function') image.removeAttribute('src');
        if (typeof image.setAttribute === 'function') image.setAttribute('aria-label', label + ' · 角色资源不可用');
      };
      if (!requestedAsset) {
        image.hidden = true;
        image.dataset.assetUrl = '';
        image.dataset.resourceState = 'absent';
        if (typeof renderRoot.replaceChildren === 'function') renderRoot.replaceChildren();
        if (typeof image.removeAttribute === 'function') image.removeAttribute('src');
        return;
      }
      image.dataset.assetUrl = requestedAsset;
      if (unavailableCharacterAssets.has(requestedAsset)) {
        resourceUnavailable();
        return;
      }
      if (previousAsset === requestedAsset && image.dataset.resourceState === 'inline') {
        image.hidden = false;
        return;
      }
      const fileName = characterAssetFile(requestedAsset);
      const svg = fileName ? parseInlineCharacterSvg(CHARACTER_SVGS[fileName]) : null;
      if (!svg) {
        resourceUnavailable();
        return;
      }
      if (typeof svg.setAttribute === 'function') {
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('data-runtime-role', String(kind).toLowerCase());
        svg.setAttribute('data-runtime-state', visual.visualState || 'absent');
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');
      }
      if (typeof renderRoot.replaceChildren === 'function') renderRoot.replaceChildren(svg);
      image.hidden = false;
      image.dataset.resourceState = 'inline';
      if (typeof image.removeAttribute === 'function') image.removeAttribute('src');
      if (typeof image.setAttribute === 'function') image.setAttribute('aria-label', label);
    };
    const ownerRoleName = (snapshot, organizationData) => {
      const roles = (Array.isArray(organizationData.roles) ? organizationData.roles : Array.isArray(snapshot.bindings) ? snapshot.bindings : []).filter(isActiveRole);
      const owner = roles.find(item => isActiveRole(item) && String(item.roleType || item.role_type || '').toUpperCase() === 'OWNER');
      return owner ? text(owner.roleName || owner.role_name || owner.name) : (snapshot.kingdom || organizationData.kingdomName ? '人类所有者' : '人类所有者 · 尚未确认');
    };
    const renderOrgNode = (parent, role, kind, emptyText, snapshot, relatedTasks) => {
      if (!role || !isActiveRole(role)) { append(parent, 'div', emptyText, 'org-empty'); return; }
      const visual = visualFor(snapshot, role, kind);
      const work = taskStatusPresentation(relatedTasks, visual.state); const presentation = work.presentation;
      const node = document.createElement('article'); node.className = 'org-node'; node.dataset.role = kind.toLowerCase(); node.dataset.status = stateMeaning(role.status || role.state || 'UNKNOWN').code; node.dataset.statusTone = presentation.tone; node.dataset.stageEvidence = visual.evidence; node.dataset.animationState = visual.visualState || 'absent';
      const image = document.createElement('span'); image.className = 'pixel-sprite'; image.setAttribute('role', 'img'); applyCharacterVisual(image, kind, visual); node.append(image);
      const copy = document.createElement('div'); append(copy, 'h4', text(role.roleName || role.role_name || role.name || '尚未投影'));
      append(copy, 'p', kind === 'SUPERVISOR' ? '领地主管' : '执行者');
      append(copy, 'strong', work.task ? '当前任务 · ' + text(record(work.task).title) : '当前无已分配任务', 'node-task');
      const statusNode = append(copy, 'span', presentation.label, 'status-pill'); statusNode.dataset.statusIcon = presentation.icon;
      node.append(copy);
      const details = document.createElement('details'); details.className = 'node-details'; append(details, 'summary', '查看更多'); append(details, 'p', visual.label); const binding = roleBindingRef(role); if (binding) append(details, 'code', '成员绑定 · ' + binding); node.append(details); parent.append(node);
    };
    const createConnectorPath = (svg, source, target) => {
      if (!svg || typeof document.createElementNS !== 'function') return; const bend = Math.max(18, Math.abs(target.y - source.y) * .44); const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M ' + source.x + ' ' + source.y + ' C ' + source.x + ' ' + (source.y + bend) + ', ' + target.x + ' ' + (target.y - bend) + ', ' + target.x + ' ' + target.y); svg.append(path);
    };
    const pointWithin = (childRect, rootRect, edge) => ({ x: childRect.left - rootRect.left + childRect.width / 2, y: edge === 'top' ? childRect.top - rootRect.top : childRect.bottom - rootRect.top });
    const prepareConnectorLayer = (svg, rect) => { if (!svg || !rect || !rect.width || !rect.height) return false; svg.replaceChildren(); svg.setAttribute('viewBox', '0 0 ' + rect.width + ' ' + rect.height); svg.setAttribute('width', String(rect.width)); svg.setAttribute('height', String(rect.height)); return true; };
    const drawOrganogramConnectors = () => {
      const root = byId('kingdom-organogram'); const layer = byId('organogram-connection-layer'); if (!root || !layer || typeof root.getBoundingClientRect !== 'function') return; const rootRect = root.getBoundingClientRect(); if (!prepareConnectorLayer(layer, rootRect)) return;
      const chancellor = typeof root.querySelector === 'function' ? root.querySelector('.chancellor-card') : null; const territories = typeof root.querySelectorAll === 'function' ? Array.from(root.querySelectorAll('.territory-column')) : [];
      if (chancellor && typeof chancellor.getBoundingClientRect === 'function') { const source = pointWithin(chancellor.getBoundingClientRect(), rootRect, 'bottom'); territories.forEach(territory => { if (typeof territory.getBoundingClientRect === 'function') createConnectorPath(layer, source, pointWithin(territory.getBoundingClientRect(), rootRect, 'top')); }); }
      territories.forEach(territory => {
        const network = typeof territory.querySelector === 'function' ? territory.querySelector('.territory-role-network') : null; if (!network || typeof network.getBoundingClientRect !== 'function') return; const localLayer = network.querySelector('.territory-connection-layer'); const supervisor = network.querySelector('.org-node[data-role="supervisor"]'); const workers = Array.from(network.querySelectorAll('.org-node[data-role="worker"]')); const networkRect = network.getBoundingClientRect(); if (!prepareConnectorLayer(localLayer, networkRect) || !supervisor || typeof supervisor.getBoundingClientRect !== 'function') return; const source = pointWithin(supervisor.getBoundingClientRect(), networkRect, 'bottom'); workers.forEach(worker => { if (typeof worker.getBoundingClientRect === 'function') createConnectorPath(localLayer, source, pointWithin(worker.getBoundingClientRect(), networkRect, 'top')); });
      });
    };
    const scheduleOrganogramConnectors = () => {
      if (typeof globalThis.requestAnimationFrame !== 'function') return; if (state.connectorFrame && typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(state.connectorFrame); state.connectorFrame = globalThis.requestAnimationFrame(() => { state.connectorFrame = 0; drawOrganogramConnectors(); });
    };
    const renderKingdomMap = (snapshot, organizationData, taskCount) => {
      const kingdom = record(snapshot.kingdom); const legacyTerritories = Array.isArray(snapshot.territories) ? snapshot.territories : []; const legacyBindings = Array.isArray(snapshot.bindings) ? snapshot.bindings : [];
      const projectedTerritories = Array.isArray(organizationData.territories) ? organizationData.territories : []; const projectedRoles = Array.isArray(organizationData.roles) ? organizationData.roles : [];
      const territories = Array.isArray(organizationData.territories) ? projectedTerritories : legacyTerritories; const roles = (Array.isArray(organizationData.roles) ? projectedRoles : legacyBindings).filter(isActiveRole); const tasks = taskItems();
      const rolesOf = roleType => roles.filter(item => isActiveRole(item) && String(item.roleType || item.role_type || '').toUpperCase() === roleType);
      const firstRoleName = roleType => { const role = rolesOf(roleType)[0]; return role ? text(role.roleName || role.role_name || role.name) : '尚未投影'; };
       const chancellor = rolesOf('CHANCELLOR')[0]; const chancellorName = firstRoleName('CHANCELLOR'); const chancellorStatus = stateMeaning(chancellor && (chancellor.status || chancellor.state) || 'UNKNOWN'); const chancellorVisual = chancellor ? visualFor(snapshot, chancellor, 'CHANCELLOR') : { evidence: 'absent', state: 'absent', visualState: null, asset: null, label: '尚未投影', actor: null }; const chancellorWork = taskStatusPresentation(tasks, chancellorVisual.state);
       const query = typeof document.querySelector === 'function' ? selector => document.querySelector(selector) : () => null;
       const chancellorImage = query('.chancellor-card .pixel-sprite'); if (chancellorImage) applyCharacterVisual(chancellorImage, 'CHANCELLOR', chancellorVisual);
       const chancellorCard = query('.chancellor-card'); if (chancellorCard) { chancellorCard.dataset.stageEvidence = chancellorVisual.evidence; chancellorCard.dataset.animationState = chancellorVisual.visualState || 'absent'; chancellorCard.dataset.statusTone = chancellorWork.presentation.tone; }
       const chancellorTone = byId('organogram-chancellor-tone'); if (chancellorTone) chancellorTone.dataset.statusIcon = chancellorWork.presentation.icon;
       setText('realm-owner-name', ownerRoleName(snapshot, organizationData)); setText('realm-chancellor-name', chancellorName); setText('organogram-chancellor-name', chancellorName); setText('organogram-chancellor-meta', chancellor ? '中央协调 · ' + chancellorVisual.label : '中央治理连接尚未确认'); setText('organogram-chancellor-task', chancellorWork.task ? '重点任务 · ' + text(record(chancellorWork.task).title) : '当前无治理任务'); setText('organogram-chancellor-tone', chancellorWork.presentation.label); setText('organogram-chancellor-state', chancellor && chancellorVisual.evidence === 'exact' ? stageMeaning(chancellorVisual.state).code : 'UNKNOWN'); setText('realm-chancellor-meta', chancellor ? '在册 · ' + chancellorStatus.label + ' · ' + chancellorVisual.label : '成员状态尚未确认');
      const supervisors = rolesOf('SUPERVISOR'); setText('realm-supervisor-name', supervisors[0] ? text(supervisors[0].roleName || supervisors[0].role_name || supervisors[0].name) : '尚未投影'); setText('realm-supervisor-meta', territories.length ? '领地数量 ' + territories.length : '领地数量尚未确认');
      const workers = rolesOf('WORKER'); setText('realm-worker-name', workers.length > 1 ? workers.length + ' 位执行者' : workers[0] ? text(workers[0].roleName || workers[0].role_name || workers[0].name) : '尚未投影'); setText('realm-worker-meta', readableCount(taskCount) === '尚未确认' ? '任务数量尚未确认' : '任务数量 ' + readableCount(taskCount));
      const parent = clear('territory-map-list'); if (!parent) return; parent.className = 'organogram-branches'; parent.dataset.branchCount = '0';
      const renderedWorkerRefs = new Set();
      const appendUnassignedWorkers = () => {
        const unassigned = workers.filter(worker => {
          const binding = roleBindingRef(worker);
          return binding && !renderedWorkerRefs.has(binding);
        });
        if (!unassigned.length) return;
        const rail = document.createElement('section'); rail.className = 'unassigned-worker-rail'; rail.dataset.stageEvidence = 'indeterminate';
        const railHeading = document.createElement('header'); append(railHeading, 'h3', '所属领地未确认'); append(railHeading, 'p', '保留在册角色，不推断资源归属'); rail.append(railHeading);
        const railStack = document.createElement('div'); railStack.className = 'worker-stack'; unassigned.forEach(worker => { const binding = roleBindingRef(worker); renderOrgNode(railStack, worker, 'WORKER', '执行者尚未确认', snapshot, tasks.filter(task => binding && sameRef(taskWorkerRef(task), binding))); }); rail.append(railStack); parent.append(rail);
      };
      if (!territories.length) { addEmpty(parent, '领地尚未投影。'); appendUnassignedWorkers(); scheduleOrganogramConnectors(); return; }
      parent.dataset.branchCount = String(territories.length); const territoryTones = territoryToneAssignments(territories);
      territories.forEach(territory => {
        const territoryRef = fieldValue(territory, 'territoryRef', 'territoryId', 'territory_id', 'id'); const title = text(territory.name || territoryRef || '领地尚未命名');
        const territoryStatus = stateMeaning(territory.status || 'UNKNOWN'); const territoryPresentation = statusTone(territory.status || 'UNKNOWN'); const column = document.createElement('section'); column.className = 'territory-column'; column.dataset.territoryRef = territoryRef; column.dataset.territoryTone = territoryTones.get(territory) || '1'; column.dataset.status = territoryStatus.code;
        const heading = document.createElement('header'); heading.className = 'territory-heading'; const headingCopy = document.createElement('div'); append(headingCopy, 'h3', title); const territoryTasks = tasks.filter(task => sameRef(taskTerritoryRef(task), territoryRef)); append(headingCopy, 'p', territory.taskCount !== undefined ? '任务 ' + text(territory.taskCount) : territoryTasks.length ? '任务 ' + territoryTasks.length : '任务数量尚未确认'); heading.append(headingCopy); append(heading, 'code', stateMeaning(territory.status || 'UNKNOWN').code, 'code-badge'); column.append(heading);
        const territoryAlert = document.createElement('div'); territoryAlert.className = 'territory-alert'; territoryAlert.dataset.status = territoryStatus.code; territoryAlert.dataset.statusTone = territoryPresentation.tone; territoryAlert.dataset.statusIcon = territoryPresentation.icon; append(territoryAlert, 'span', '领地状态 · ' + territoryStatus.label); column.append(territoryAlert);
        const network = document.createElement('div'); network.className = 'territory-role-network'; const connectorLayer = typeof document.createElementNS === 'function' ? document.createElementNS('http://www.w3.org/2000/svg', 'svg') : document.createElement('svg'); connectorLayer.setAttribute('class', 'territory-connection-layer'); connectorLayer.setAttribute('aria-hidden', 'true'); network.append(connectorLayer);
         const supervisorRef = fieldValue(territory, 'supervisorBindingRef', 'supervisorBindingId', 'supervisor_binding_id'); const supervisor = supervisors.find(role => (supervisorRef && sameRef(roleBindingRef(role), supervisorRef)) || (roleTerritoryRef(role) && sameRef(roleTerritoryRef(role), territoryRef))) || null; renderOrgNode(network, supervisor, 'SUPERVISOR', '主管尚未确认；不推断绑定', snapshot, territoryTasks);
        const workerStack = document.createElement('div'); workerStack.className = 'worker-stack'; const assignedWorkers = workers.filter(role => roleTerritoryRef(role) && sameRef(roleTerritoryRef(role), territoryRef)); const assignedRefs = new Set(assignedWorkers.map(roleBindingRef).filter(Boolean)); tasks.filter(task => sameRef(taskTerritoryRef(task), territoryRef) && taskWorkerRef(task)).forEach(task => { if (assignedRefs.has(taskWorkerRef(task))) return; const fallback = workers.find(role => sameRef(roleBindingRef(role), taskWorkerRef(task)) && (!roleTerritoryRef(role) || sameRef(roleTerritoryRef(role), territoryRef))); if (fallback) { assignedWorkers.push(fallback); assignedRefs.add(taskWorkerRef(task)); } });
         if (!assignedWorkers.length) append(workerStack, 'div', '还没有骑士进入这片领地', 'org-empty'); else assignedWorkers.forEach(worker => { const binding = roleBindingRef(worker); if (binding) renderedWorkerRefs.add(binding); renderOrgNode(workerStack, worker, 'WORKER', '执行者尚未确认', snapshot, territoryTasks.filter(task => binding && sameRef(taskWorkerRef(task), binding))); });
        network.append(workerStack); column.append(network); parent.append(column);
      });
      appendUnassignedWorkers();
      if (organizationData.territoriesTruncated === true) addEmpty(parent, '地图显示宿主当前返回的有界领地；其余信息请在王国账本中查看。');
      scheduleOrganogramConnectors();
    };
    const renderOverview = snapshot => {
      const parent = clear('overview-content'); if (!parent) return;
      const projection = record(record(snapshot).projection); const data = record(record(projection.overview).data); const organizationData = record(record(projection.organization).data); const counts = record(data.statusCounts);
      const healthCode = data.health === undefined || data.health === null || data.health === '' ? 'UNKNOWN' : text(data.health);
      const taskCount = countValue(data.taskCount, Array.isArray(snapshot.tasks), Array.isArray(snapshot.tasks) ? snapshot.tasks.length : 0); const activeExecutionCount = countValue(data.activeExecutionCount, Array.isArray(snapshot.liveExecutions), Array.isArray(snapshot.liveExecutions) ? snapshot.liveExecutions.length : 0); const reviewCount = Object.hasOwn(counts, 'REVIEW') ? counts.REVIEW : 'UNKNOWN'; const attentionData = record(projection.attention).data; const attentionCount = Array.isArray(attentionData) ? attentionData.length : 'UNKNOWN';
      const healthMetrics = record(data.healthMetrics); const metricValue = key => typeof healthMetrics[key] === 'number' && Number.isFinite(healthMetrics[key]) ? healthMetrics[key] : null;
      const blockedWorkers = metricValue('blockedWorkers'); const frozenTerritories = metricValue('frozenTerritories'); const healthAttentionCount = metricValue('attentionCount');
      renderKingdomMap(snapshot, organizationData, taskCount);
      if (blockedWorkers !== null && frozenTerritories !== null && healthAttentionCount !== null) {
        addMetric(parent, '名骑士受阻', blockedWorkers, '#activity'); addMetric(parent, '个领地冻结', frozenTerritories, '#organization'); addMetric(parent, '处需关注', healthAttentionCount, '#activity');
      } else {
        addMetric(parent, '待审任务', reviewCount, '#tasks'); addMetric(parent, '进行中执行', activeExecutionCount, '#executions'); addMetric(parent, '当前可见待裁决', attentionCount, '#activity');
      }
      const health = stateMeaning(healthCode); const kingdom = record(snapshot.kingdom); const healthTitle = text(data.healthTitle || (kingdom.name ? kingdom.name + '健康' : '王国健康')); const healthLabel = text(data.healthLabel || ('状态 · ' + health.label));
      setText('kingdom-state-title', text(data.kingdomName || kingdom.name || '王国组织总览')); setText('kingdom-health-title', healthTitle);
      const healthNode = byId('health-capsule'); if (healthNode) healthNode.dataset.status = health.code;
      setText('kingdom-state-detail', healthLabel); setText('kingdom-state-code', health.code);
      if (attentionCount === 'UNKNOWN') setLabelWithCode('attention-count', '可见事项尚未确认', 'UNKNOWN'); else setText('attention-count', '可见事项 ' + text(attentionCount));
      if (snapshot.revision === undefined || snapshot.revision === null || snapshot.revision === '') setLabelWithCode('overview-revision', '投影版本尚未确认', 'UNKNOWN'); else setText('overview-revision', '投影版本 ' + text(snapshot.revision));
    };
    const renderOrganization = snapshot => {
      const parent = clear('organization-content'); if (!parent) return; const projection = record(record(snapshot).projection); const data = record(record(projection.organization).data); const kingdom = record(snapshot.kingdom); const legacyTerritories = Array.isArray(snapshot.territories) ? snapshot.territories : []; const legacyBindings = Array.isArray(snapshot.bindings) ? snapshot.bindings : []; const hasProjectedTerritories = Array.isArray(data.territories); const territories = hasProjectedTerritories ? data.territories : legacyTerritories; const hasProjectedRoles = Array.isArray(data.roles); const roles = (hasProjectedRoles ? data.roles : legacyBindings).filter(isActiveRole);
      if (!snapshot.kingdom && !Object.keys(data).length && !legacyTerritories.length && !legacyBindings.length) { addEmpty(parent, '组织信息尚未确认或尚未运行投影。'); return; }
      const bindingCount = data.bindingCount === undefined ? (hasProjectedRoles ? roles.length : legacyBindings.length) : data.bindingCount; const territoryCount = data.territoryCount === undefined ? (hasProjectedTerritories ? territories.length : legacyTerritories.length) : data.territoryCount;
      addDataRow(parent, '王国 · 治理事实', data.kingdomName || kingdom.name); addDataRow(parent, '领地数量', territoryCount); addDataRow(parent, '成员绑定数量', bindingCount);
      territories.slice(0, 8).forEach(territory => addStateRow(parent, '领地 · ' + text(territory.name || canonicalOrLegacyEntityId(territory.territoryRef, territory.territoryId, 'territory')), territory.status));
      roles.slice(0, 12).forEach(role => { const sessionText = role.sessionBound === true ? '角色会话已绑定' : role.sessionBound === false ? '角色会话未绑定' : '角色会话尚未确认'; addDataRow(parent, roleTitle(role.roleType || role.role_type), text(role.roleName || role.role_name) + ' · ' + sessionText); });
      if (data.rolesTruncated === true || data.territoriesTruncated === true) addEmpty(parent, '组织投影已截断；这里只显示有界摘要。');
    };
    const renderTaskDetail = (snapshot, detail) => {
      const parent = clear('task-detail-content'); if (!parent) return; const task = selectedTask(); if (!task) { addEmpty(parent, state.selectedTaskId ? '所选任务暂不可用，状态尚未确认。' : '选择一个任务查看进度；技术证据会保持折叠。'); setLabelWithCode('task-detail-revision', '当前选择尚未确认', 'UNKNOWN'); return; }
      const trustedDetail = detail && state.detailTaskId === state.selectedTaskId && text(record(detail.task).taskId) === state.selectedTaskId ? detail : null; const sourceTask = trustedDetail ? trustedDetail.task : task; const projectionData = record(record(record(trustedDetail || task).projection).data); const claim = record(projectionData.claim); const execution = record(projectionData.execution);
      const presentation = statusTone(sourceTask.status || record(projectionData.status).value); const latestClaim = record(sourceTask.latestClaim); const claimSummary = latestClaim.claimedOutcome || claim.outcome || '尚无执行者呈报';
      const summary = document.createElement('article'); summary.className = 'task-summary-card'; summary.dataset.statusTone = presentation.tone; append(summary, 'h3', sourceTask.title); const statusNode = append(summary, 'span', presentation.label, 'status-pill'); statusNode.dataset.statusIcon = presentation.icon; append(summary, 'p', sourceTask.description || ('当前进展 · ' + text(claimSummary))); parent.append(summary);
      const technical = document.createElement('details'); technical.className = 'task-technical'; append(technical, 'summary', '展开治理与技术详情'); const technicalBody = document.createElement('div'); technicalBody.className = 'task-technical-body'; addDataRow(technicalBody, '任务编号', sourceTask.taskId); addStateRow(technicalBody, '治理状态 · 治理事实', sourceTask.status || record(projectionData.status).value); addDataRow(technicalBody, '执行者呈报 · 自述证据', claimSummary); addStateRow(technicalBody, '执行状态 · 运行观察', sourceTask.latestExecution ? sourceTask.latestExecution.state : execution.state || 'NONE'); addDataRow(technicalBody, '尝试次数', sourceTask.attemptCount);
      const actions = normalizeAllowedActions(taskResourceActions()); const actionNames = Object.keys(actions); addDataRow(technicalBody, '宿主动作许可', actionNames.length ? actionNames.map(name => actionDisplay(name) + '：' + (actions[name].executable ? '可以执行' : reasonDisplay(actions[name].disabledReason))).join(' · ') : '尚未确认（UNKNOWN）');
      const reviews = trustedDetail && Array.isArray(trustedDetail.reviews) ? trustedDetail.reviews : []; if (reviews.length) reviews.slice(-3).forEach(review => addDataRow(technicalBody, '监督者裁决 · 治理事实', stateDisplay(review.decision) + ' · ' + text(review.reason))); else addDataRow(technicalBody, '裁决', '等待执行者呈报；进入待审（REVIEW）后由监督者（SUPERVISOR）决定'); technical.append(technicalBody); parent.append(technical); if (snapshot.revision === undefined || snapshot.revision === null || snapshot.revision === '') setLabelWithCode('task-detail-revision', '最近更新尚未确认', 'UNKNOWN'); else setText('task-detail-revision', '最近更新 · 版本 ' + text(snapshot.revision));
    };
     const renderExecutions = snapshot => {
      const parent = clear('execution-content'); if (!parent) return; const executions = executionItems();
      if (!executions.length) { addEmpty(parent, '执行信息尚未确认或尚未运行。'); return; }
      executions.slice(0, 100).forEach(execution => { const card = document.createElement('article'); card.className = 'data-list'; const executionId = executionIdOf(execution); const executionState = execution.state || execution.authoritativeState; addDataRow(card, '执行编号 · 运行观察', executionId); addStateRow(card, '执行状态', executionState); addDataRow(card, '所属任务', executionTaskIdOf(execution)); addStateRow(card, '执行契约', execution.executionContract || execution.execution_contract); addDataRow(card, '暂停请求', execution.pausePending === true || execution.pause_pending === true ? '已登记，尚未确认暂停（REQUESTED · NOT_PAUSED）' : '无（NONE）'); if (executionId === state.selectedExecutionId) card.setAttribute('aria-current', 'true'); parent.append(card); });
    };
    const entityRefText = reference => { const ref = record(reference); const type = typeof ref.type === 'string' && ref.type ? ref.type : typeof ref.entityType === 'string' ? ref.entityType : ''; const id = entityId(ref); return type && id ? text(type) + ':' + text(id) : '实体尚未确认'; };
    const sourceRefText = reference => {
      const item = record(reference); const sourceType = String(item.sourceType || '');
      if (sourceType === 'table-row') return typeof item.entityId === 'string' && item.entityId ? '表 ' + text(item.entityType) + ':' + text(item.entityId) : '表引用尚未确认';
      if (sourceType === 'event') return Number.isInteger(item.eventSeq) && item.eventSeq >= 0 ? '事件 #' + String(item.eventSeq) : '事件序号尚未确认';
      if (sourceType === 'derived-rule') return typeof item.ruleCode === 'string' && item.ruleCode ? '规则 ' + text(item.ruleCode) : '规则引用尚未确认';
      if (sourceType === 'runtime-evidence') return '运行证据 ' + (typeof item.entityType === 'string' && item.entityType ? text(item.entityType) : '来源尚未确认');
      return '来源尚未确认';
    };
    const sourceRefs = refs => Array.isArray(refs) ? refs.slice(0, 8).map(sourceRefText).join(' · ') : '来源尚未确认';
    const renderTimeline = snapshot => {
      const parent = clear('timeline-content'); if (!parent) return; const projection = record(record(snapshot).projection); const timeline = record(projection.timeline); const hasProjection = Array.isArray(timeline.data); const items = hasProjection ? timeline.data : [];
      if (!hasProjection) { addEmpty(parent, '流转记录尚未确认或尚未运行投影。'); return; }
      if (!items.length) { addEmpty(parent, '史册中尚无流转记录。'); return; }
      items.slice(0, 200).forEach(item => { const row = document.createElement('article'); row.className = 'timeline-item'; append(row, 'span', text(item.kind), 'evidence-kind'); append(row, 'p', text(item.summary)); append(row, 'div', '实体引用 ' + entityRefText(item.entityRef), 'entity-ref'); if (item.occurredAt) append(row, 'div', '记录时间 ' + text(item.occurredAt), 'meta'); append(row, 'div', sourceRefs(item.sourceRefs), 'source-ref'); parent.append(row); });
    };
    const renderAttention = snapshot => {
      const parent = clear('attention-content'); if (!parent) return; const projection = record(record(snapshot).projection); const attention = record(projection.attention); const hasProjection = Array.isArray(attention.data); const items = hasProjection ? attention.data : [];
      if (hasProjection) setText('attention-count', '可见事项 ' + items.length); else setLabelWithCode('attention-count', '可见事项尚未确认', 'UNKNOWN');
      if (!hasProjection) { addEmpty(parent, '待裁决事项尚未确认或尚未运行投影。'); return; }
      if (!items.length) { addEmpty(parent, '当前没有待裁决事项。'); return; }
      items.slice(0, 100).forEach(item => { const row = document.createElement('article'); row.className = 'attention-item'; row.dataset.severity = text(item.severity); const presentation = statusTone(item.severity); const badge = append(row, 'span', presentation.label, 'status-pill'); badge.dataset.statusIcon = presentation.icon; append(row, 'p', text(item.summary)); const technical = document.createElement('details'); technical.className = 'attention-technical'; append(technical, 'summary', '查看证据注脚'); append(technical, 'code', text(record(item.reason).code), 'code-badge'); append(technical, 'div', '实体引用 ' + entityRefText(item.entityRef), 'entity-ref'); append(technical, 'div', sourceRefs(item.sourceRefs), 'source-ref'); row.append(technical); parent.append(row); });
    };
     const renderSnapshot = snapshot => { state.snapshot = snapshot || {}; reconcileSelections(); renderSelectors(); renderTaskNavigator(); renderNavigation(); renderOverview(state.snapshot); renderOrganization(state.snapshot); renderTaskDetail(state.snapshot, state.detail); renderExecutions(state.snapshot); renderTimeline(state.snapshot); renderAttention(state.snapshot); renderGates(); };
     const loadDetail = async taskId => {
       const requestedTaskId = String(taskId || ''); const requestEpoch = ++state.detailEpoch;
       if (!requestedTaskId) { state.detail = null; state.detailTaskId = ''; return false; }
       let detail;
       try { detail = await requestJson(endpoint(CONFIG.endpoints.taskDetail, requestedTaskId)); }
       catch (_) { if (requestEpoch === state.detailEpoch && requestedTaskId === state.selectedTaskId) { state.detail = null; state.detailTaskId = ''; } return false; }
       const responseTaskId = text(record(record(detail).task).taskId);
       if (requestEpoch !== state.detailEpoch || requestedTaskId !== state.selectedTaskId || responseTaskId !== requestedTaskId) return false;
       state.detail = detail; state.detailTaskId = requestedTaskId; return true;
     };
     const refreshSelectedDetail = async () => {
       const taskId = state.selectedTaskId;
       try { const committed = await loadDetail(taskId); if (committed && state.snapshot) { renderTaskDetail(state.snapshot, state.detail); renderSelectors(); renderGates(); } }
       catch (_) { if (taskId === state.selectedTaskId) { state.detail = null; state.detailTaskId = ''; renderTaskDetail(state.snapshot || {}, null); renderGates(); } }
     };
       const applyNavigationFromLocation = shouldLoadDetail => {
         state.navigationHash = location.hash; const parsed = reconcileSelections(); renderSelectors(); renderTaskNavigator(); renderNavigation(); renderTaskDetail(state.snapshot || {}, state.detail); renderExecutions(state.snapshot || {}); renderGates();
         if (!parsed.known) status('导航位置未识别，已显示总览；未执行任何写操作。', 'unknown', 'UNKNOWN_NAVIGATION');
         if (['organization', 'tasks', 'executions', 'activity'].includes(parsed.section) && typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(() => { const sectionNode = byId(parsed.section); if (sectionNode && typeof sectionNode.scrollIntoView === 'function') sectionNode.scrollIntoView({ block: 'start' }); });
         if (shouldLoadDetail && parsed.known) void refreshSelectedDetail();
       };
     const selectTask = (taskId, pushHistory) => {
       const nextTaskId = String(taskId || ''); const preserveDetail = nextTaskId === state.selectedTaskId && state.detail !== null && state.detail !== undefined && state.detailTaskId === nextTaskId && text(record(record(state.detail).task).taskId) === nextTaskId; state.selectedTaskId = nextTaskId; if (!preserveDetail) { state.detail = null; state.detailTaskId = ''; state.detailEpoch += 1; } state.activeSection = 'tasks';
       if (pushHistory) history.pushState(null, '', nextTaskId ? '#task=' + encodeURIComponent(nextTaskId) : '#tasks');
       applyNavigationFromLocation(false); if (!preserveDetail) void refreshSelectedDetail();
     };
     const load = async (silent, commandRefresh = false) => {
       if (state.loading) { if (commandRefresh) state.commandRefreshPending = true; return; }
       if (state.commandBusy && !commandRefresh) return; state.loading = true; if (!silent) status('正在读取宿主能力与王国投影。', 'neutral');
       let controlError = null;
       try {
         try { renderCapabilities(await requestJson(CONFIG.endpoints.control)); } catch (error) { controlError = error; renderCapabilities(controlFailureView(error)); }
         const snapshot = await requestJson(CONFIG.endpoints.snapshot); state.snapshot = snapshot || {}; reconcileSelections();
         await loadDetail(state.selectedTaskId);
         const revision = snapshot.revision === undefined ? null : snapshot.revision; const changed = state.lastRevision === null || revision !== state.lastRevision; state.lastRevision = revision; state.lastLoadedAt = Date.now(); state.stale = false; renderSnapshot(snapshot); const expiresAt = state.capabilities && state.capabilities.expiresAt; setText('capability-expiry', '有效期：' + (expiresAt ? text(expiresAt) : '尚未确认') + ' · 投影版本：' + (revision === null || revision === '' ? '尚未确认' : text(revision))); if (controlError) status('操作通道暂不可用，写动作已禁用；王国投影已刷新。', 'error', text(controlError && (controlError.code || controlError.message))); else if (changed || !silent) status('王国投影已刷新 · ' + new Date(state.lastLoadedAt).toLocaleTimeString(), 'success');
         if (!parseFragment(location.hash).known) status('导航位置未识别，已显示总览；未执行任何写操作。', 'unknown', 'UNKNOWN_NAVIGATION');
       } catch (error) { state.stale = true; const code = text(error && (error.code || error.message)); status('王国投影暂不可用，正在继续读取。', code === 'UNKNOWN' ? 'unknown' : 'error', code + ' · 读取轮询继续；写操作绝不自动重试。'); }
       finally { state.loading = false; renderGates(); if (state.commandRefreshPending && !state.commandBusy) { state.commandRefreshPending = false; void load(false, true); } }
     };
     const submit = async (commandName, payload, action, ownerOnly, resourceScope) => {
       let gate = actionState(action, ownerOnly, resourceScope); if (gate.executable && action.indexOf('review:') === 0) { const decision = action.slice('review:'.length).toUpperCase(); const decisions = state.capabilities && Array.isArray(state.capabilities.reviewDecisions) ? state.capabilities.reviewDecisions.map(value => String(value).toUpperCase()) : []; if (!decisions.includes(decision)) gate = { executable: false, reason: 'DECISION_NOT_AVAILABLE' }; }
       if (!gate.executable) { status(actionDisplay(action) + '不可执行：' + reasonDisplay(gate.reason), gate.reason === 'UNKNOWN' ? 'unknown' : 'error'); renderGates(); return; }
       state.commandBusy = true; status('正在提交“' + actionDisplay(action) + '”；宿主将重新核验。', 'neutral'); renderGates();
       try { const result = await postCommand(commandName, payload); if (result && result.ok === false) { status('宿主拒绝“' + actionDisplay(action) + '”（' + text(result.errorCode || 'UNKNOWN') + '）；不会自动重试。', result.errorCode === 'UNKNOWN' ? 'unknown' : 'error'); return; } status('宿主已接收“' + actionDisplay(action) + '”；正在刷新证据。', 'success'); await load(false, true); }
       catch (error) { status('“' + actionDisplay(action) + '”结果未确认（' + text(error && (error.code || error.message)) + '）；不会自动重试。', error && error.code === 'UNKNOWN' ? 'unknown' : 'error'); }
       finally { state.commandBusy = false; renderGates(); if (state.commandRefreshPending && !state.loading) { state.commandRefreshPending = false; void load(false, true); } }
     };
     const revokeControl = async () => { const gate = actionState('control.revoke', false); if (!gate.executable) { status('无法关闭本地控制通道：' + reasonDisplay(gate.reason), gate.reason === 'UNKNOWN' ? 'unknown' : 'error'); renderGates(); return; } state.commandBusy = true; status('正在关闭本地控制通道；宿主将重新核验。', 'neutral'); renderGates(); try { await postCommand(CONFIG.commands.controlRevoke, {}); renderCapabilities({ state: 'REVOKED', active: false, disabledReason: 'CONTROL_SESSION_EXPIRED' }); status('本地控制通道已关闭（REVOKED）。', 'error'); } catch (error) { status('关闭结果未确认（' + text(error && (error.code || error.message)) + '）；不会自动重试。', error && error.code === 'UNKNOWN' ? 'unknown' : 'error'); } finally { state.commandBusy = false; renderGates(); } };
      const formValue = (form, name) => { const field = form.elements.namedItem(name); return field && 'value' in field ? String(field.value).trim() : ''; };
      const taskTitleInput = byId('task-title');
      if (taskTitleInput) {
        taskTitleInput.addEventListener('input', () => { state.territoryCommandIndex = 0; renderTerritoryCommandMenu(); });
        taskTitleInput.addEventListener('keydown', event => {
          const menu = byId('territory-command-menu'); const query = territoryCommandQuery(); const choices = query === null ? [] : state.territoryChoices.filter(choice => !query || text(choice.label).toLocaleLowerCase('zh-CN').includes(query));
          if (event.key === 'ArrowDown' && menu && !menu.hidden) { event.preventDefault(); moveTerritoryCommandSelection(1); }
          else if (event.key === 'ArrowUp' && menu && !menu.hidden) { event.preventDefault(); moveTerritoryCommandSelection(-1); }
          else if (event.key === 'Enter' && menu && !menu.hidden && choices.length) { event.preventDefault(); chooseComposerTerritory(choices[state.territoryCommandIndex] || choices[0]); }
          else if (event.key === 'Escape') { event.preventDefault(); closeTerritoryCommandMenu(); }
          else if (event.key === 'Backspace' && !String(taskTitleInput.value || '') && state.selectedTerritoryId) clearComposerTerritory();
        });
      }
      byId('refresh-button').addEventListener('click', () => { void load(false); });
      byId('revoke-button').addEventListener('click', () => { void revokeControl(); });
     byId('task-create-form').addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget; const title = composerTaskTitle(); if (!title) { status('请先写下任务名称（INVALID_INPUT）。', 'error'); return; } closeTerritoryCommandMenu(); void submit(CONFIG.commands.taskCreate, { title, territory_id: formValue(form, 'territory_id') }, 'task.create', false); });
    byId('assign-form').addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget; void submit(CONFIG.commands.assign, { task_id: formValue(form, 'task_id'), worker_binding_id: formValue(form, 'worker_binding_id') }, 'assign', false, 'task'); });
    byId('start-form').addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget; const grant = formValue(form, 'grant_json'); try { JSON.parse(grant); } catch (_) { status('监督者授予内容无法解析（INVALID_INPUT）。', 'error'); return; } void submit(CONFIG.commands.start, { task_id: formValue(form, 'task_id'), grant_json: grant, sandbox_mode: formValue(form, 'sandbox_mode') }, 'start', false, 'task'); });
    byId('review-form').addEventListener('submit', event => { event.preventDefault(); });
    document.querySelectorAll('[data-review-decision]').forEach(button => { button.addEventListener('click', () => { const form = byId('review-form'); const decision = String(button.getAttribute('data-review-decision') || '').toUpperCase(); const target = formValue(form, 'to_binding_id'); if (decision === 'HANDOFF' && !target) { status('移交前必须选择目标执行者绑定（INVALID_INPUT · to_binding_id）。', 'error'); return; } const payload = { task_id: formValue(form, 'task_id'), decision, reason: formValue(form, 'reason') }; if (decision === 'HANDOFF') payload.to_binding_id = target; void submit(CONFIG.commands.review, payload, 'review:' + decision.toLowerCase(), false, 'task'); }); });
    document.querySelectorAll('[data-task-selector]').forEach(select => { select.addEventListener('change', event => { selectTask(event.currentTarget.value, true); }); });
    byId('execution-control-id').addEventListener('change', event => { state.selectedExecutionId = event.currentTarget.value; renderExecutions(state.snapshot || {}); renderGates(); });
    document.querySelectorAll('[data-execution-command]').forEach(button => { button.addEventListener('click', () => { const commandKey = button.getAttribute('data-execution-command') || ''; const action = button.getAttribute('data-gated-action') || ''; const executionId = formValue(byId('execution-control-form'), 'execution_id'); const reason = formValue(byId('execution-control-form'), 'reason'); if (!executionId) { status('请先选择执行记录（INVALID_INPUT · execution_id）。', 'error'); return; } void submit(CONFIG.commands[commandKey], { execution_id: executionId, reason }, action, false, 'execution'); }); });
     const handleNavigationEvent = () => { if (state.navigationHash === location.hash) return; applyNavigationFromLocation(true); };
     addEventListener('hashchange', handleNavigationEvent); addEventListener('popstate', handleNavigationEvent);
     addEventListener('resize', scheduleOrganogramConnectors);
     if (typeof globalThis.ResizeObserver === 'function') { const organogram = byId('kingdom-organogram'); if (organogram) { const connectorObserver = new globalThis.ResizeObserver(scheduleOrganogramConnectors); connectorObserver.observe(organogram); } }
     setInterval(() => { if (state.lastLoadedAt && Date.now() - state.lastLoadedAt > CONFIG.endpoints.staleAfterMs) { state.stale = true; status('投影可能已过时 · 最近可信版本 ' + text(state.lastRevision) + ' · 请重新读取以核对。', 'stale', 'STALE'); renderGates(); } }, 1000);
    setInterval(() => { void load(true); }, CONFIG.endpoints.pollIntervalMs);
    initializeTheme(); applyNavigationFromLocation(false); void load(false);
  })();
  </script>
</body>
</html>`

/** Render the app with Coordinator-selected Host endpoints without adding a dependency. */
export function renderConsoleApp(options: ConsoleCommandOptions = {}): string {
  const endpoints = { ...CONSOLE_APP_DEFAULT_ENDPOINTS, ...(options.endpoints ?? {}) }
  const commands = { ...CONSOLE_APP_DEFAULT_COMMANDS, ...(options.commands ?? {}) }
  const config = JSON.stringify({ endpoints, commands }).replace(/</gu, '\\u003c')
  const characterAssets = JSON.stringify(GUI_CHARACTER_ASSETS).replace(/</gu, '\\u003c')
  const characterSvgs = JSON.stringify(GUI_CHARACTER_ASSET_SVGS).replace(/</gu, '\\u003c')
  const themes = JSON.stringify(CONSOLE_APP_THEMES).replace(/</gu, '\\u003c')
  return CONSOLE_APP_TEMPLATE
    .replace('__CONSOLE_CONFIG__', config)
    .replace('__CONSOLE_CHARACTER_ASSETS__', characterAssets)
    .replace('__CONSOLE_CHARACTER_SVGS__', characterSvgs)
    .replace('__CONSOLE_THEMES__', themes)
}

export const CONSOLE_APP_HTML = renderConsoleApp()
