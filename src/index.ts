/**
 * dsh-kingdom — 独立 dsh 插件：会话内初始化/接入本地王国。
 *
 * 规范：
 * - 资源注册必须挂 ctx.effect（热重载/卸载自动清理）。
 * - 工具 schema 精简：description 短句点明用途，详解放 tool result。
 *
 * Phase 1 能力：
 * - /kingdom init（幂等：无则初始化，有则接入）
 * - /kingdom status（真实状态）
 * - 工具：kingdom_status / kingdom_create_territory / kingdom_list_territories /
 *   kingdom_delete_territory（v0.5.1：有任务拒绝 / force 级联）/ kingdom_bind_role /
 *   kingdom_list_bindings
 *
 * Phase 2 能力（Worker Claim Bridge → 治理闭环）：
 * - 工具：kingdom_plan_task / kingdom_assign_task /
 *   kingdom_start_task_governed / kingdom_review_task / kingdom_list_tasks
 * - `kingdom_start_task` 仅保留为显式选择的 LEGACY_COMPAT one-shot 兼容入口；
 *   正常 headless 执行必须走 governed persistent 路径。
 *
 * 治理底线（Phase 1 保持 + Phase 2 强化）：
 * - **无任何工具能把 Task 直接标 DONE**：DONE 唯一入口是 REVIEW + Supervisor ACCEPT。
 * - Worker 的结果只是 Claim（→ REVIEW），不是 Fact。
 * - 无任意 SQL 通道暴露给 Agent。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { KingdomManager } from './core/kingdom.js'
import { DshRuntimeAdapter } from './adapter/dsh-backend.js'
import { runGovernedTask } from './worker/governed-executor.js'
import { settleAndRelease } from './dispatch/service.js'
import { setCapabilityCeiling } from './capability/admin.js'
import {
  bindRole,
  listBindings,
  parseExecutionProfile,
  rebindSession,
  resolveBinding,
  setExecutionProfile,
  unbindRole,
  type AdminAuth,
  type ExecutionProfileV1,
} from './core/binding.js'
import type { KingdomStore, RoleBindingRow, TerritoryRow } from './core/db.js'
import { createRunnerContextPort } from './core/governed.js'
import type { RunnerContextPort } from './core/governed.js'
import {
  forgetRunnerContextPort,
  getRunnerContextPort,
  revokeRunnerContextBrokerContext,
} from './runner-context-broker.js'
import { asExecutionState, isTerminalExecutionState } from './core/execution.js'
import { createTerritory, deleteTerritory, listTerritories, setTerritorySupervisor } from './core/territory.js'
import {
  abortExecution,
  assignTask,
  listTasks,
  pauseExecution,
  planTask,
  reclaimOrphanExecutions,
  resolveGovernedStartSupervisor,
  resumeExecution,
  reviewTask,
  startTask,
  type CommandContext,
  type Principal,
} from './core/task-service.js'
import { buildSnapshot, buildTaskDetail, toEventView } from './gui/snapshot.js'
import { startGuiServer, type GuiServerAddress } from './gui/server.js'
import {
  type AuthView,
  type CommandResultView,
  type ProjectionSecurityContext,
} from './gui/contract.js'
import {
  DuplicateJsonKeyError,
  GUI_OWNER_ONLY_HTTP_COMMANDS,
  GUI_SESSION_COMMANDS,
  GUI_START_SANDBOX_MODES,
  type GuiControlExecutionContext,
  type GuiControlReadContext,
  parseStrictJsonObject,
} from './gui/control-contract.js'
import { LOCAL_CONTROL_LAUNCH_PATH, LocalControlManager } from './gui/local-control.js'
import type { SubagentsLike } from './worker/dsh-subagent.js'
import { resolveWorkerExecution } from './worker/executor-factory.js'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import {
  issueOwnerControlCapability,
  ownerControlAuth,
  type OwnerControlCapability,
} from './core/owner-control.js'
import {
  draftOwnerBindingIntent,
  draftOwnerBindingIntentFromRejectedWrite,
  serializeOwnerBindingIntentDraft,
  type OwnerBindingIntentContext,
  type RejectedOwnerBindingOperation,
  type TargetSessionClassification,
} from './core/owner-binding-intent.js'

export const name = 'dsh-kingdom'
export const inject = ['tools', 'commands']

export interface Config {
  kingdomName: string
  ownerName: string
  workerProvider: string
  guiPort: number
  guiToken: string
  guiAllowOrigins: string[]
  authMode: 'declarative' | 'session-bound'
  /** v0.8（M3-S2 v6）：允许对已有 v3 库执行 Schema v4 迁移（Formal DB Migration Gate 用）。 */
  migrateV4: boolean
}

/**
 * Process-local seams for deterministic integration verification. Normal
 * Cordis/DSH loading uses the two-argument apply(ctx, config) path. These
 * functions are not Config, HTTP, GUI payload, or persisted-state inputs.
 */
export interface ApplyDependencies {
  openLocalConsole?: (url: string) => boolean
  loadS4Policy?: () => Promise<{
    sandboxPolicy: { setSandboxMode(session: unknown, mode: string): void } | null
    approval: { setApprovalPolicy(session: unknown, policy: string): void } | null
  }>
}

/**
 * The public DSH runtime seam used by the Owner-binding boundary.  Keep this
 * local duck type instead of importing a concrete registry implementation: the
 * plugin is loaded against a host-provided bundle, while the identity checks
 * below intentionally depend only on the documented methods and object
 * identity.
 */
export interface KingdomDshAgentLike {
  readonly id?: unknown
  readonly session?: unknown
  readonly status?: unknown
}

export interface KingdomDshAgentRegistryLike {
  currentInitiator?: () => unknown
  get?: (id: string) => unknown
  list?: () => readonly unknown[]
}

export interface KingdomDshSessionRegistryLike {
  get?: (id: string) => unknown
}

export interface KingdomDshRegistrySeam {
  agents?: KingdomDshAgentRegistryLike | null
  sessions?: KingdomDshSessionRegistryLike | null
}

export interface KingdomToolExecutionLike {
  readonly agent?: unknown
  readonly signal?: { readonly aborted?: boolean } | null
}

export type TrustedToolSessionResolution =
  | {
      readonly classification: 'ACTIVE'
      readonly sessionId: string
      readonly agent: KingdomDshAgentLike
      readonly session: { readonly id?: unknown }
    }
  | {
      readonly classification: Exclude<TargetSessionClassification, 'ACTIVE'>
      readonly sessionId: string | null
      readonly reason: string
    }

export type LiveDirectSessionResolution =
  | {
      readonly ok: true
      readonly sessionId: string
      readonly agent: KingdomDshAgentLike
      readonly session: { readonly id?: unknown }
    }
  | {
      readonly ok: false
      readonly classification: Exclude<TargetSessionClassification, 'ACTIVE'>
      readonly reason: string
    }

function exactRuntimeToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && !/[\s\u0000-\u001f\u007f]/u.test(value)
}

function agentSession(agent: unknown): { agent: KingdomDshAgentLike; session: { readonly id?: unknown }; sessionId: string } | null {
  if (typeof agent !== 'object' || agent === null) return null
  const candidate = agent as KingdomDshAgentLike
  if (typeof candidate.session !== 'object' || candidate.session === null) return null
  const session = candidate.session as { readonly id?: unknown }
  if (!exactRuntimeToken(candidate.id) || !exactRuntimeToken(session.id)) return null
  return { agent: candidate, session, sessionId: candidate.id }
}

function failClassification(
  classification: Exclude<TargetSessionClassification, 'ACTIVE'>,
  sessionId: string | null,
  reason: string,
): TrustedToolSessionResolution {
  return { classification, sessionId, reason }
}

/**
 * Resolve the exact DSH Tool caller.  A non-empty session id is only a target
 * reference; it becomes an ACTIVE Principal after every public identity/life
 * check succeeds.  In particular, tool arguments are not accepted here.
 */
export function resolveTrustedToolSession(
  execution: KingdomToolExecutionLike | null | undefined,
  seam: KingdomDshRegistrySeam,
): TrustedToolSessionResolution {
  const target = agentSession(execution?.agent)
  if (!target) return failClassification('ABSENT', null, '缺少 exact exec.agent.session.id。')

  const agents = seam.agents
  const sessions = seam.sessions
  if (!agents || !sessions || typeof agents.currentInitiator !== 'function'
    || typeof agents.get !== 'function' || typeof sessions.get !== 'function') {
    return failClassification('UNKNOWN', target.sessionId, 'DSH agents/sessions registry seam 不完整。')
  }

  try {
    const initiator = agents.currentInitiator()
    if (initiator !== target.agent) {
      return failClassification('FOREIGN', target.sessionId, 'exec.agent 不是当前 DSH current initiator。')
    }
    if (agents.get(target.sessionId) !== target.agent) {
      return failClassification('FOREIGN', target.sessionId, 'agents.get 未返回同一 live Agent 对象。')
    }
    if (typeof agents.list === 'function') {
      const matches = agents.list().filter(item => agentSession(item)?.sessionId === target.sessionId)
      if (matches.length !== 1) {
        return failClassification('MULTIPLE', target.sessionId, 'live Agent registry 未能证明 target 唯一。')
      }
    }
    if (sessions.get(target.sessionId) !== target.session) {
      return failClassification('FOREIGN', target.sessionId, 'sessions.get 未返回同一 live Session 对象。')
    }
    if (target.agent.id !== target.session.id) {
      return failClassification('FOREIGN', target.sessionId, 'Agent id 与 Session id 不一致。')
    }
    if (target.agent.status === 'expired') {
      return failClassification('EXPIRED', target.sessionId, 'Agent/Session 已过期。')
    }
    if (target.agent.status !== 'running') {
      return failClassification('UNKNOWN', target.sessionId, `Agent status=${String(target.agent.status)} 不是 running。`)
    }
    if (execution?.signal?.aborted !== false) {
      return failClassification(execution?.signal?.aborted === true ? 'ABORTED' : 'UNKNOWN', target.sessionId,
        execution?.signal?.aborted === true ? 'Tool execution signal 已 aborted。' : '缺少未 aborted 的 Tool execution signal。')
    }
    return {
      classification: 'ACTIVE',
      sessionId: target.sessionId,
      agent: target.agent,
      session: target.session,
    }
  } catch (error: unknown) {
    return failClassification('UNKNOWN', target.sessionId,
      `DSH registry lookup 失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Validate a direct Owner Slash target without requiring current-initiator scope. */
export function validateLiveDirectSession(
  sessionId: string,
  seam: KingdomDshRegistrySeam,
): LiveDirectSessionResolution {
  if (!exactRuntimeToken(sessionId)) {
    return { ok: false, classification: 'ABSENT', reason: 'session_id 必须是非空 exact token。' }
  }
  const agents = seam.agents
  const sessions = seam.sessions
  if (!agents || !sessions || typeof agents.get !== 'function' || typeof sessions.get !== 'function') {
    return { ok: false, classification: 'UNKNOWN', reason: 'DSH agents/sessions registry seam 不完整。' }
  }
  try {
    const agent = agents.get(sessionId)
    const target = agentSession(agent)
    if (!target || target.sessionId !== sessionId || agent !== target.agent) {
      return { ok: false, classification: 'ABSENT', reason: 'session_id 不对应 live Agent。' }
    }
    if (typeof agents.list === 'function') {
      const matches = agents.list().filter(item => agentSession(item)?.sessionId === sessionId)
      if (matches.length !== 1) {
        return { ok: false, classification: 'MULTIPLE', reason: 'live Agent registry 未能证明 session 唯一。' }
      }
    }
    if (sessions.get(sessionId) !== target.session) {
      return { ok: false, classification: 'FOREIGN', reason: 'sessions.get 未返回绑定的 live Session 对象。' }
    }
    if (target.agent.id !== target.session.id) {
      return { ok: false, classification: 'FOREIGN', reason: 'Agent id 与 Session id 不一致。' }
    }
    if (target.agent.status !== 'idle' && target.agent.status !== 'running') {
      return { ok: false, classification: 'EXPIRED', reason: `Agent status=${String(target.agent.status)} 不可作为 live session。` }
    }
    return { ok: true, sessionId, agent: target.agent, session: target.session }
  } catch (error: unknown) {
    return { ok: false, classification: 'UNKNOWN', reason: `DSH registry lookup 失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export const Config = z.object({
  kingdomName: z.string().default('My Kingdom'),
  ownerName: z.string().default(''),
  /** Worker 执行用的 subagent provider（dsh base bundle 默认注册 spawn / fork）。 */
  workerProvider: z.string().default('spawn'),
  /**
   * 本地 GUI 通道端口。**默认 0 = 关闭** —— 不在用户不知情时打开监听端口。
   * 设为非零值即启用，只绑定 127.0.0.1。
   */
  guiPort: z.number().default(0),
  /** 可选 bearer token；设置后 GUI 所有请求都要带 Authorization 头。 */
  guiToken: z.string().default(''),
  /** CORS 允许的 Origin 列表；默认放开（服务只绑本机回环）。 */
  guiAllowOrigins: z.array(z.string()).default(['*']),
  /**
   * 角色鉴权强度。
   * `declarative`（默认，Phase 1/2 延续）只校验"王国中存在该角色绑定"，
   * **不验证调用者就是该角色** —— snapshot 会如实报 `trustLevel: local-demo`。
   * `session-bound` 额外要求调用方 session 与 binding.session_id 一致。
   */
  authMode: z.union(['declarative', 'session-bound'] as const).default('declarative'),
  /**
   * v0.8（M3-S2 v6）：允许对已有 v3 库执行 Schema v4 迁移。
   * **默认 false**：正式 kingdom.db 受 Formal DB Migration Gate 保护——
   * 全新库自动 v4；已有库保持 v3（governed API fail-closed）直到 Owner 明确 Gate 放行。
   */
  migrateV4: z.boolean().default(false),
})

/** Smallest capability fact used by the GUI thin slice's governed path. */
export const MINIMAL_CAPABILITY_JSON = '{"tool:pwsh":true}'

// R20 public root surface.  These helpers carry transport bootstrap only;
// Product registration/settlement helpers remain private to this module.
export {
  connectRunnerContextBroker,
  createRunnerContextBrokerLaunch,
  createRunnerContextBrokerProductLifecycle,
} from './runner-context-broker.js'
export type {
  RunnerContextBrokerClient,
  RunnerContextBrokerCleanupReceipt,
  RunnerContextBrokerConnectionBootstrap,
  RunnerContextBrokerConnectorInput,
  RunnerContextBrokerDescriptor,
  RunnerContextBrokerEnvironment,
  RunnerContextBrokerProductLifecycle,
} from './runner-context-broker.js'

const GUI_OWNER_ONLY_COMMAND_SET = new Set<string>(GUI_OWNER_ONLY_HTTP_COMMANDS)

/**
 * Format the direct GUI activation result without accepting any launch secret
 * as presentation data.  The ticket is handed only to the local URL opener;
 * command/done persistence, logger output, and domain events receive this
 * clean result instead.
 */
export function formatGuiLaunchCommandResult(
  origin: string,
  expiresAt: string,
  browserOpened: boolean,
): CommandResult {
  const cleanUrl = `${origin}${LOCAL_CONTROL_LAUNCH_PATH}`
  return browserOpened
    ? {
        kind: 'success',
        text: `GUI Control Session 已激活：${cleanUrl}；expiresAt=${expiresAt}。已请求在本机浏览器打开 Console。`,
      }
    : {
        kind: 'error',
        text: `GUI Control Session 已激活：${cleanUrl}；expiresAt=${expiresAt}。本机浏览器自动打开失败；未输出一次性 launch ticket，请重新执行 /kingdom gui 后重试。`,
  }
}

function throwOnGuiSetupFailure(value: string): void {
  if (/^(?:错误：|OWNER_CONTROL_REQUIRED|CONFIG_DENIED|UNKNOWN\/)/u.test(value)) throw new Error(value)
}

/** Reuse an ACTIVE same-name Territory without changing its topology. */
export function ensureGuiSetupTerritory(
  store: KingdomStore,
  input: { kingdomId: string; name: string; workspacePath?: string | null },
  auth: AdminAuth,
): TerritoryRow {
  const name = input.name.trim()
  const workspacePath = input.workspacePath?.trim() || null
  const existing = store.getTerritoryByName(input.kingdomId, name)
  if (existing) {
    if (existing.status !== 'ACTIVE') {
      throw new Error(`错误：setup.basic 不能复用 ${existing.status} 领地「${name}」；不会自动改写拓扑。`)
    }
    if (workspacePath !== null && existing.workspace_path !== workspacePath) {
      throw new Error(`错误：setup.basic 同名领地「${name}」的 workspace 冲突（已有 ${existing.workspace_path ?? '未设置'}，请求 ${workspacePath}）；不会自动改写拓扑。`)
    }
    return existing
  }

  try {
    const result = createTerritory(store, {
      kingdomId: input.kingdomId,
      name,
      workspacePath: workspacePath ?? undefined,
    }, auth)
    throwOnGuiSetupFailure(result)
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    if (/UNIQUE constraint failed: territories/u.test(detail)) {
      throw new Error(`错误：setup.basic 同名领地「${name}」已有 DELETED/tombstone 记录；不会自动重建或改写拓扑。`)
    }
    throw error
  }
  const created = store.getTerritoryByName(input.kingdomId, name)
  if (!created) throw new Error('错误：setup.basic 创建后找不到 Territory。')
  return created
}

/** Ensure setup role identity without ever binding a Worker to the activator. */
export function ensureGuiSetupBinding(
  store: KingdomStore,
  input: {
    kingdomId: string
    roleType: 'CHANCELLOR' | 'SUPERVISOR' | 'WORKER'
    roleName: string
    sessionId: string | null
  },
  auth: AdminAuth,
): RoleBindingRow {
  const existing = store.getBindingByRole(input.kingdomId, input.roleType)
  if (!existing) {
    const result = bindRole(store, {
      kingdomId: input.kingdomId,
      roleType: input.roleType,
      roleName: input.roleName,
      sessionId: input.sessionId,
    }, auth)
    throwOnGuiSetupFailure(result)
    const created = store.getBindingByRole(input.kingdomId, input.roleType)
    if (!created) throw new Error(`错误：setup.basic 创建 ${input.roleType} 后找不到 binding。`)
    return created
  }
  if ((input.roleType === 'CHANCELLOR' || input.roleType === 'SUPERVISOR')
    && existing.session_id !== input.sessionId) {
    const result = rebindSession(store, {
      kingdomId: input.kingdomId,
      bindingId: existing.binding_id,
      sessionId: input.sessionId,
    }, auth)
    throwOnGuiSetupFailure(result)
    return store.getBindingById(existing.binding_id) ?? existing
  }
  return existing
}

function sameGuiExecutionProfile(
  current: ExecutionProfileV1 | null,
  desired: ExecutionProfileV1,
): boolean {
  return (current?.model ?? null) === (desired.model ?? null)
    && (current?.provider ?? null) === (desired.provider ?? null)
}

/** Set the requested Worker profile only when its semantic value changes. */
export function ensureGuiSetupExecutionProfile(
  store: KingdomStore,
  input: { kingdomId: string; bindingId: string; profile: ExecutionProfileV1 },
  auth: AdminAuth,
): string | null {
  const binding = store.getBindingById(input.bindingId)
  if (!binding || binding.kingdom_id !== input.kingdomId) {
    throw new Error(`错误：找不到当前王国的 Worker binding ${input.bindingId}。`)
  }
  if (sameGuiExecutionProfile(parseExecutionProfile(binding.execution_profile_json), input.profile)) {
    return null
  }
  const result = setExecutionProfile(store, {
    kingdomId: input.kingdomId,
    bindingId: input.bindingId,
    profile: input.profile,
  }, auth)
  throwOnGuiSetupFailure(result)
  return result
}

/** Set Territory scope only when the target Supervisor binding changes. */
export function ensureGuiSetupTerritorySupervisor(
  store: KingdomStore,
  input: { kingdomId: string; territoryId: string; supervisorBindingId: string },
  auth: AdminAuth,
): string | null {
  const territory = store.getTerritoryById(input.territoryId)
  if (!territory || territory.kingdom_id !== input.kingdomId) {
    throw new Error(`错误：领地不存在（id=${input.territoryId}）。`)
  }
  if (territory.supervisor_binding_id === input.supervisorBindingId) return null
  const result = setTerritorySupervisor(store, {
    kingdomId: input.kingdomId,
    territoryId: input.territoryId,
    supervisorBindingId: input.supervisorBindingId,
  }, auth)
  throwOnGuiSetupFailure(result)
  return result
}

export function apply(ctx: Context, config: Config, dependencies: ApplyDependencies = {}): void {
  // 单一王国管理器（自包含 SQLite；KingdomStore 连接生命周期 = 插件生命周期）
  const manager = new KingdomManager({
    kingdomName: config.kingdomName,
    ownerName: config.ownerName || undefined,
    migrateV4: config.migrateV4,
  })
  // 卸载/重载时关闭 SQLite 连接（disposer 由 fiber 自动收集执行）
  ctx.effect(() => () => manager.close())
  const store = manager.storeHandle

  const requireKingdom = (): string | null => {
    const kingdom = store.getDefaultKingdom()
    return kingdom ? kingdom.kingdom_id : null
  }

  /** 如实声明本次部署的鉴权强度，GUI 必须把它显示出来。 */
  const authView: AuthView = config.authMode === 'session-bound'
    ? {
        mode: 'session-bound',
        trustLevel: 'session-verified',
        note: '命令调用方的 session 必须与角色 binding 的 session_id 一致。',
      }
    : {
        mode: 'declarative',
        trustLevel: 'local-demo',
        note: '仅校验王国中存在对应角色绑定，不验证调用者身份。'
          + 'GUI 若提供派发/复核/返工按钮，必须显著标注为「本地可信演示权限」。',
      }

  const commandContext = (kingdomId: string, principal?: Principal): CommandContext =>
    ({ kingdomId, auth: authView, ...principal ? { principal } : {} })

  const dshRegistrySeam = (): KingdomDshRegistrySeam => ({
    agents: ctx.get('agents') as KingdomDshAgentRegistryLike | undefined,
    sessions: ctx.get('sessions') as KingdomDshSessionRegistryLike | undefined,
  })

  const trustedToolPrincipal = (exec: KingdomToolExecutionLike): Principal | undefined => {
    const resolved = resolveTrustedToolSession(exec, dshRegistrySeam())
    return resolved.classification === 'ACTIVE' ? { sessionId: resolved.sessionId } : undefined
  }

  const targetSessionRef = (exec: KingdomToolExecutionLike): string | null => {
    const target = agentSession(exec.agent)
    return target?.sessionId ?? null
  }

  const ownerBindingIntentContext = (exec: KingdomToolExecutionLike): OwnerBindingIntentContext => {
    const kingdomId = requireKingdom()
    const resolved = resolveTrustedToolSession(exec, dshRegistrySeam())
    return {
      // This is only the target reference echoed by the runtime context.  The
      // explicit classification below is the only liveness/authority seam.
      target_session_ref: targetSessionRef(exec),
      target_session_classification: resolved.classification,
      kingdom_id: kingdomId,
      role_bindings: kingdomId
        ? store.listBindings(kingdomId).map(binding => ({
          binding_id: binding.binding_id,
          role_type: binding.role_type,
          role_name: binding.role_name,
          session_id: binding.session_id,
          status: binding.status,
          kingdom_id: binding.kingdom_id,
        }))
        : [],
      territories: kingdomId
        ? store.listTerritories(kingdomId).map(territory => ({
          territory_id: territory.territory_id,
          name: territory.name,
          status: territory.status,
          kingdom_id: territory.kingdom_id,
          supervisor_binding_id: territory.supervisor_binding_id,
        }))
        : [],
    }
  }

  /**
   * Public governed start 永远不接受 declarative 权限：调用者必须由 DSH Runtime
   * 提供可验证的 session，再由 Core 将它解析为该领地的 Supervisor binding。
   */
  const governedStartCommandContext = (kingdomId: string, principal?: Principal): CommandContext => ({
    kingdomId,
    auth: {
      mode: 'session-bound',
      trustLevel: 'session-verified',
      note: 'kingdom_start_task_governed 只接受由 DSH Runtime session 证明的 Supervisor 调用。',
    },
    ...principal ? { principal } : {},
  })

  type GuiControlContextWithAgent = GuiControlExecutionContext & { readonly agent?: unknown }

  /**
   * The ticket is a launch-only secret.  It may cross the local process into
   * the user's browser, but it must never enter CommandResult.text, logger
   * output, or a Kingdom event.  The host has no browser service in its public
   * Cordis surface, so use only the platform's existing URL opener seam.
   */
  const openLocalConsole = dependencies.openLocalConsole ?? ((url: string): boolean => {
    try {
      if (process.platform === 'win32') {
        const result = spawnSync('cmd.exe', ['/d', '/c', 'start', '', url], {
          stdio: 'ignore',
          windowsHide: true,
        })
        return result.error === undefined && result.status === 0
      }
      const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
      const result = spawnSync(command, [url], { stdio: 'ignore' })
      return result.error === undefined && result.status === 0
    } catch {
      return false
    }
  })

  /** Grant 仅表达当前已认证 Supervisor 授予的 capability，绝不承载调用者身份。 */
  const parseSupervisorGrant = (grantJson: string):
  | { ok: true; grant: Record<string, boolean> }
  | { ok: false; message: string } => {
    try {
      const parsed = JSON.parse(grantJson) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false, message: 'grant_json 必须是非空 JSON 对象。' }
      }
      const entries = Object.entries(parsed)
      if (entries.length === 0 || entries.some(([, allowed]) => typeof allowed !== 'boolean')) {
        return { ok: false, message: 'grant_json 必须是非空、value 全为 boolean 的 capability Grant 对象。' }
      }
      return { ok: true, grant: Object.fromEntries(entries) as Record<string, boolean> }
    } catch {
      return { ok: false, message: 'grant_json 必须是合法 JSON。' }
    }
  }

  /**
   * Shared governed-start orchestration seam.
   *
   * The Tool path and the local GUI path must enter the same Supervisor,
   * Capability Gate, persistent-session, dispatch, and Claim/REVIEW pipeline.
   * Tool callers are resolved from the complete DSH execution seam; GUI callers
   * carry only the exact broker-captured activation principal and agent, never
   * browser payload identity.
   */
  type GovernedStartCaller =
    | { kind: 'tool'; execution: KingdomToolExecutionLike }
    | { kind: 'gui'; principal: Principal; agent: unknown }

  const runGovernedStart = async (
    args: { taskId: string; grantJson: string; sandboxMode?: string },
    caller: GovernedStartCaller,
  ): Promise<string> => {
    const requestedSandboxMode = args.sandboxMode ?? 'workspace-write'
    if (!(GUI_START_SANDBOX_MODES as readonly string[]).includes(requestedSandboxMode)) {
      return `INPUT_DENIED [INVALID_SANDBOX_MODE]: sandbox_mode 必须是 ${GUI_START_SANDBOX_MODES.join(' / ')} 之一。`
    }
    const sandboxMode = requestedSandboxMode as (typeof GUI_START_SANDBOX_MODES)[number]
    const kingdomId = requireKingdom()
    if (!kingdomId) return '尚未初始化王国。请先 /kingdom init。'

    const principal = caller.kind === 'tool'
      ? trustedToolPrincipal(caller.execution)
      : caller.principal
    if (!principal) {
      return 'AUTHZ_DENIED [UNAUTHORIZED_PRINCIPAL]: 无法从 DSH Runtime 证明当前调用方的唯一活动 session。'
    }
    // Public governed start 不随全局 authMode 降级：真实 DSH session → Supervisor
    // binding → Territory scope 必须在任何 executor/session/lease 准备前全部通过。
    const supervisor = resolveGovernedStartSupervisor(
      store,
      governedStartCommandContext(kingdomId, principal),
      args.taskId,
    )
    if (!supervisor.ok) {
      return `AUTHZ_DENIED [${supervisor.code}]: ${supervisor.message}`
    }

    const parsedGrant = parseSupervisorGrant(args.grantJson)
    if (!parsedGrant.ok) {
      return `INPUT_DENIED [INVALID_SUPERVISOR_GRANT]: ${parsedGrant.message}`
    }

    if (!store.isSchemaV4) {
      return '错误：Schema v4 未迁移（正式 kingdom.db 迁移须经 Formal DB Migration Gate）；governed 执行不可用（fail-closed）。'
    }
    const loadedTask = supervisor.task
    if (loadedTask.status !== 'ASSIGNED' && loadedTask.status !== 'RUNNING') {
      return `错误：任务状态 ${loadedTask.status} 不可 governed 启动（仅 ASSIGNED / REWORK 后的 RUNNING）。`
    }
    const unsettledGovernedExecution = store.listExecutions(loadedTask.task_id)
      .slice()
      .reverse()
      .find(execution => execution.execution_contract === 'GOVERNED_PERSISTENT'
        && !isTerminalExecutionState(asExecutionState(execution.state)))
    if (unsettledGovernedExecution) {
      const code = unsettledGovernedExecution.state === 'RECOVERING'
        ? 'EXISTING_EXECUTION_RECOVERING'
        : 'EXISTING_EXECUTION_UNSETTLED'
      return `GOVERNED_EXECUTION_DENIED [${code}]: Task ${loadedTask.task_id} 已有未终结的 governed Execution `
        + `${unsettledGovernedExecution.execution_id}（${unsettledGovernedExecution.state}）。`
        + '请先完成 terminal/reconcile 对账；未访问 Runtime/Session/Lease，Task 保持不变且不会自动重试。'
    }
    const territory = store.getTerritoryById(loadedTask.territory_id)
    if (!territory) return '错误：任务领地缺失。'
    const worker = loadedTask.assigned_binding_id
    if (!worker) return '错误：任务未指派 Worker。'

    const agents = ctx.get('agents')
    if (!agents) {
      return '错误：当前 dsh 组合未提供 agents 服务（Persistent Session 不可用）；governed 执行不可用。'
    }
    // Owner V0.8 PRODUCTION-PATH CLOSURE（正式入口 E2E seam）：S4 materialize 需要**模块函数** seam
    // （`setSandboxMode = session.append('sandbox/mode')` / `setApprovalPolicy = session.append('approval/policy')`），
    // 而非 ctx 服务对象（SandboxPolicyService/ApprovalService 无这些方法，传服务 → MATERIALIZE_FAILED）。
    // 动态 import（懒解析）：失败 → null → materialize 报「缺失」→ DENIED（fail-closed，不崩溃插件）。
    const s4Seam = dependencies.loadS4Policy
      ? await dependencies.loadS4Policy()
      : await (async () => {
      try {
        // 变量 specifier：运行时经 dsh loader 解析（动态 seam；静态类型不做解析校验）
        const sbSpec = '@deepseek-ai/dsh-sandbox-policy'
        const apSpec = '@deepseek-ai/dsh-user-approval'
        const sandbox = (await import(sbSpec)) as { setSandboxMode: (session: unknown, mode: string) => void }
        const approval = (await import(apSpec)) as { setApprovalPolicy: (session: unknown, policy: string) => void }
        return {
          sandboxPolicy: { setSandboxMode: sandbox.setSandboxMode },
          approval: { setApprovalPolicy: approval.setApprovalPolicy },
        }
      } catch {
        return { sandboxPolicy: null, approval: null }
      }
    })()
    const adapter = new DshRuntimeAdapter({
      runtimeInstanceRef: `dsh-${hostname()}`,
      provider: config.workerProvider || 'spawn',
      model: null,
      agents,
      permission: ctx.get('permission'),
      sandboxPolicy: s4Seam.sandboxPolicy,
      approval: s4Seam.approval,
      presets: ctx.get('agentPresets'),
    })

    // attempt 编号必须纳入 Lease Ledger（zero-execution 的 gate 拒绝也会消耗 attempt_no，
    // 否则重试会撞 UNIQUE(task_id, attempt_no)——正式入口 E2E 实证）
    const leaseMax = store.listLeases(kingdomId)
      .filter((l) => l.task_id === loadedTask.task_id)
      .reduce((m, l) => Math.max(m, l.attempt_no), 0)
    const attemptNo = Math.max(store.nextAttemptNo(loadedTask.task_id), leaseMax + 1)
    let result: Awaited<ReturnType<typeof runGovernedTask>>
    try {
      result = await runGovernedTask({
        store, adapter, kingdomId, workerBindingId: worker,
        territoryId: loadedTask.territory_id, cwd: territory.workspace_path ?? process.cwd(),
        taskId: loadedTask.task_id, attemptNo, supervisorBindingId: supervisor.binding.binding_id,
        grant: parsedGrant.grant, requirementJson: store.getTaskCapabilityRequirement(loadedTask.task_id),
        sandboxMode,
        // Owner V0.8 PRODUCTION-PATH CLOSURE A：全局 workerProvider 仅作 provider 回退；
        // Worker 的 provider/model 权威来源 = execution_profile_json（runGovernedTask 内部解析，
        // model 缺失 → fail closed configuration error，不创建 Session、不 dispatch）。
        globalProvider: config.workerProvider || 'spawn',
        // 真实模型 turn 轮询窗口（正式入口 E2E 实证：默认 100ms×40=4s 太短，turn 未及 terminal）：
        // 1s × 60 = 60s；超窗 → fail-closed 返回（进 RECOVERING，由 reconcile 处理）。
        pollIntervalMs: 1000,
        maxPolls: 60,
      })
    } catch (error: unknown) {
      const detail = (error instanceof Error ? error.message : String(error)).slice(0, 256)
      const terminalDispatch = store.listDispatches(kingdomId).some(dispatch =>
        dispatch.task_id === loadedTask.task_id
        && dispatch.attempt_no === attemptNo
        && dispatch.state === 'TERMINAL',
      )
      if (terminalDispatch) {
        return `GOVERNED_SETTLEMENT_BLOCKED [UNPROVEN_TERMINAL_RELATION]: ${detail}；未写入 Claim/REVIEW。`
      }
      return `GOVERNED_EXECUTION_DENIED [DISPATCH_EXCEPTION]: ${detail}`
    }
    if (!result.ok) {
      const prefix = result.reason.startsWith('Capability DENIED') ? 'CAPABILITY_DENIED' : 'GOVERNED_EXECUTION_DENIED'
      return `${prefix}: ${result.reason}\n（任务保持 ${loadedTask.status}；请检查 Capability/Runtime 配置后，在同一 governed persistent 入口重试。不会自动降级为 LEGACY_COMPAT。）`
    }

    // R11 settlement-before-Claim：先从已提交的 canonical
    // Task/Execution/Lease/Dispatch relation 签发 product context，并消费同一
    // opaque handle + version 完成 settlement。若 exact relation、version 或
    // incident 记录无法证明，必须在任何 Claim/Task 写入前 fail-closed。
    const task = store.getTask(loadedTask.task_id)
    if (!task) return 'GOVERNED_SETTLEMENT_BLOCKED [RELATION_MISSING]: terminal Task 已消失，未写入 Claim。'
    let settledLease: ReturnType<KingdomStore['getLease']>
    let runnerContext: RunnerContextPort | null = null
    try {
      runnerContext = getRunnerContextPort(result.dispatchId)
        ?? createRunnerContextPort(store, { dispatchId: result.dispatchId })
      const activeRunnerContext = runnerContext
      const terminal = activeRunnerContext.read(activeRunnerContext.handle, activeRunnerContext.initialVersion)
      const settled = activeRunnerContext.settle(activeRunnerContext.handle, terminal.version, (context) => {
        // The callback receives the exact product-minted capability.  Do not
        // substitute result.* IDs: the port's bounded view is the relation
        // consumed by settlement and the same handle/version is in-flight.
        if (context.handle !== activeRunnerContext.handle || context.version !== terminal.version) {
          throw new Error('R11 RunnerContext settlement handle/version continuity failed')
        }
        return settleAndRelease(
          store,
          context.view.leaseId,
          result.cleanupReceipt,
          'governed-terminal-settlement',
          {
            adapter,
            fence: result.trustFence,
            leaseId: context.view.leaseId,
            sessionRef: context.view.sessionRef,
          },
        )
      })
      settledLease = settled.value
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return `GOVERNED_SETTLEMENT_BLOCKED [UNPROVEN_TERMINAL_RELATION]: ${detail}；未写入 Claim/REVIEW。`
    } finally {
      // Ticket/connection revocation is transport cleanup only.  It cannot
      // release a Lease or alter Claim/Dispatch governance facts.
      revokeRunnerContextBrokerContext(runnerContext)
      forgetRunnerContextPort(result.dispatchId)
    }

    // Claim 到达（Claim ≠ Fact）：结算完成或已明确进入 RECOVERING 后，才落
    // worker_results + Task RUNNING→REVIEW（不是 DONE）。普通 cleanup false/
    // throw/missing 与 post-TX-4 incident 都保留可信 terminal Claim。
    // Owner V0.8 FINAL RELEASE BLOCKER：Claim outcome 按已验证 terminalOutcome 收敛
    // （COMPLETED/FAILED/ABORTED）——禁止 hardcode COMPLETED；FAILED 不得生成 COMPLETED Claim；
    // summary 仅来自真实 assistant 文本，无文本 → 诚实回退占位（不伪造"任务完成"类摘要）。
    const running = task.status === 'ASSIGNED' ? store.transitionTask(task, 'RUNNING') : task
    const outcome = result.terminalOutcome
    const summary = result.summary
    store.insertWorkerResult({
      result_id: randomUUID(),
      task_id: task.task_id,
      attempt_no: attemptNo,
      worker_binding_id: worker,
      session_id: result.sessionRef,
      outcome,
      result_json: JSON.stringify({ outcome, summary }),
      created_at: new Date().toISOString(),
    })
    store.transitionTask(running, 'REVIEW', { result_summary: summary })
    const nowIso = new Date().toISOString()
    store.appendEvent({
      event_id: randomUUID(), kingdom_id: kingdomId, event_type: 'WORKER_RESULT_SUBMITTED',
      actor_role: 'WORKER', actor_id: worker, target_type: 'task', target_id: task.task_id,
      payload_json: JSON.stringify({ attempt_no: attemptNo, claimed_outcome: outcome, session_id: result.sessionRef, executor: 'dsh-governed:persistent' }),
      created_at: nowIso,
    })
    if (settledLease?.state === 'RELEASED') {
      store.appendEvent({
        event_id: randomUUID(), kingdom_id: kingdomId, event_type: 'SESSION_STOPPED',
        actor_role: 'WORKER', actor_id: worker, target_type: 'execution', target_id: result.executionId,
        payload_json: JSON.stringify({ task_id: task.task_id, attempt_no: attemptNo, reason: outcome === 'COMPLETED' ? 'completed' : outcome.toLowerCase() }),
        created_at: nowIso,
      })
    }
    const recoveryNotice = settledLease?.state === 'RECOVERING'
      ? result.cleanupReceipt.status === 'CONFIRMED'
        ? `\n注意：terminal settlement 未能安全释放（${settledLease.release_reason ?? 'integrity recovery'}），Lease=RECOVERING；不得复用该 Session 或发起新 Dispatch，须先完成 reconcile/恢复。`
        : `\n注意：enforcement cleanup 未确认（${result.cleanupReceipt.status}），Lease=RECOVERING；不得复用该 Session 或发起新 Dispatch，须先完成 reconcile/恢复。`
      : ''
    return `Governed Worker 已提交第 ${attemptNo} 次尝试的 Claim（outcome=${outcome}，长期 Session ${result.sessionRef.slice(-8)}${result.created ? ' 新建' : ' 复用'}）。\n`
      + `摘要：${summary}\n`
      + `任务「${task.title}」现在处于 **REVIEW**。这是一个待审查的 Claim，尚未成为任务完成事实——请 Supervisor 用 kingdom_review_task 裁定 ACCEPT / REWORK / FAIL。`
      + recoveryNotice
  }

  // ── init 引导（首次初始化后给出组织方式与内置 GUI 入口）──
  const guiLine = '直接键入 exact `/kingdom gui` 激活短期本地 control session 并打开内置操作台；不用时执行 `/kingdom gui stop`。'
  const initGuidance = '\n\nOwner Control 已建立：Owner 是稳定的人类本机 principal，OWNER.session_id 保持 null。\n'
    + 'Owner-only 初始化、Territory、角色/session、Execution Profile 与 Capability Ceiling 写入必须来自 direct `/kingdom` Slash；GUI/HTTP 只保留 session-bound Role 命令。\n'
    + 'Agent Role Plane 请为 CHANCELLOR / SUPERVISOR / WORKER 使用真实独立 DSH Session；正常执行入口是 kingdom_start_task_governed。\n'
    + `GUI：${guiLine}`
  /** 首次初始化返回带引导文案；再次接入保持简洁。 */
  const initResultText = (result: ReturnType<typeof manager.init>): string =>
    result.action === 'initialized' ? `${result.detail}${initGuidance}` : result.detail

  const ownerToolDenied = (
    rejection?: {
      operation: RejectedOwnerBindingOperation
      request: {
        role_type?: string | null
        role_name?: string | null
        session_id?: string | null
        binding_id?: string | null
        territory_id?: string | null
      }
      exec: KingdomToolExecutionLike
    },
  ): string => {
    if (!rejection) {
      return 'OWNER_CONTROL_REQUIRED: Owner-only 写操作只能通过 direct `/kingdom` Slash 执行；'
        + 'Agent Tool、未激活的 GUI/HTTP、工具参数和 caller session 不能代表 Owner。'
    }
    return serializeOwnerBindingIntentDraft(draftOwnerBindingIntentFromRejectedWrite({
      code: 'OWNER_CONTROL_REQUIRED',
      operation: rejection.operation,
      request: rejection.request,
      context: ownerBindingIntentContext(rejection.exec),
    }))
  }

  // ── 加载期孤儿处理：按 Execution Contract 保持事实诚实 ──────────
  //
  // LEGACY_COMPAT one-shot 随插件生命周期结束，可标记 ABORTED；
  // GOVERNED_PERSISTENT 的 Runtime outcome 在重启后未知，只能进入
  // RECOVERING 并等待显式对账，不能声称 Session 已停止或自动重试。
  {
    const kingdomId = requireKingdom()
    if (kingdomId) {
      const reclaimed = reclaimOrphanExecutions(store, kingdomId)
      if (reclaimed > 0) {
        ctx.logger.info(`dsh-kingdom：已按 Execution Contract 处理 ${reclaimed} 个加载期残留 Execution`)
      }
    }
  }


  // ── 工具注册（全部挂 ctx.effect）────────────────────────────

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'kingdom_init',
    description: 'Owner-only 写操作已关闭：请由用户直接键入 `/kingdom init`（Agent Tool 调用确定性 OWNER_CONTROL_REQUIRED）',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      return ownerToolDenied()
    },
  })), 'dsh-kingdom: init tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'kingdom_status',
    description: '查询当前王国真实状态：王国/Owner/领地/角色绑定/最近事件',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      return store.statusSummary()
    },
  })), 'dsh-kingdom: status tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'kingdom_create_territory',
    description: 'Owner-only：Agent Tool 不代行；请使用 `/kingdom territory.create <JSON>`',
    parameters: {
      name: { type: 'string', required: true, description: '领地名，如 RAG 研发领' },
      workspace_path: { type: 'string', description: '工作区绝对路径，默认当前目录' },
      summary: { type: 'string', description: '领地一句话使命（可选）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { name: string; workspace_path?: string; summary?: string }, exec: { agent?: { session?: { id?: string } } | null }) {
      return ownerToolDenied()
    },
  })), 'dsh-kingdom: create-territory tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'kingdom_list_territories',
    description: '列出当前王国的全部领地',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      const kingdomId = requireKingdom()
      if (!kingdomId) return '尚未初始化王国。请先 /kingdom init。'
      return listTerritories(store, kingdomId)
    },
  })), 'dsh-kingdom: list-territories tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'kingdom_delete_territory',
    description: 'Owner-only：Agent Tool 不代行；请使用 `/kingdom territory.delete <JSON>`（任务级联语义保持）',
    parameters: {
      territory_id: { type: 'string', description: '领地 id（与 name 二选一，优先）' },
      name: { type: 'string', description: '领地名（与 territory_id 二选一）' },
      force: { type: 'boolean', description: 'true = 级联删除（领地下有任务时必需）' },
      reason: { type: 'string', description: '删除原因（可选，记入 TERRITORY_DELETED 事件）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { territory_id?: string; name?: string; force?: boolean; reason?: string }, exec: { agent?: { session?: { id?: string } } | null }) {
      return ownerToolDenied()
    },
  })), 'dsh-kingdom: delete-territory tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'kingdom_set_territory_supervisor',
    description: 'Owner-only：Agent Tool 不代行；请使用 `/kingdom territory.supervisor <JSON>`',
    parameters: {
      territory_id: { type: 'string', required: true, description: '领地 id' },
      supervisor_binding_id: { type: 'string', description: 'ACTIVE SUPERVISOR 绑定 id；传 null 解除主理' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { territory_id: string; supervisor_binding_id?: string | null }, exec: { agent?: { session?: { id?: string } } | null }) {
      return ownerToolDenied()
    },
  })), 'dsh-kingdom: set-territory-supervisor tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'kingdom_bind_role',
    description: 'Owner-only：Agent Tool 不代行；请使用 `/kingdom role.bind <JSON>`（OWNER 不得绑定 Session）',
    parameters: {
      role_type: { type: 'string', required: true, description: '角色：OWNER/CHANCELLOR/SUPERVISOR/WORKER' },
      role_name: { type: 'string', description: '角色名，如 Worker-01' },
      session_id: { type: 'string', description: '绑定的 dsh session id（可选）' },
      model_name: { type: 'string', description: '会话身份预留：模型名，如 deepseek-v4-pro / gpt-5.6（可选）' },
      agent_name: { type: 'string', description: '会话身份预留：agent 工具名，如 codex / dsh（可选）' },
      session_meta: { type: 'string', description: '会话身份预留：任意扩展字段的 JSON 对象字符串（可选）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: {
      role_type: string
      role_name?: string
      session_id?: string
      model_name?: string
      agent_name?: string
      session_meta?: string
    }, exec: KingdomToolExecutionLike) {
      return ownerToolDenied({
        operation: 'kingdom_bind_role',
        request: {
          role_type: args.role_type,
          role_name: args.role_name,
          session_id: args.session_id,
        },
        exec,
      })
    },
  })), 'dsh-kingdom: bind-role tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'kingdom_unbind_role',
    description: 'Owner-only：Agent Tool 不代行；请使用 `/kingdom role.unbind <JSON>`（OWNER 受保护）',
    parameters: {
      role_type: { type: 'string', description: '角色：CHANCELLOR/SUPERVISOR/WORKER（与 binding_id 二选一）' },
      binding_id: { type: 'string', description: '绑定 id（与 role_type 二选一）' },
      reason: { type: 'string', description: '换届原因（会记入事件，可追溯）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { role_type?: string; binding_id?: string; reason?: string }, exec: { agent?: { session?: { id?: string } } | null }) {
      return ownerToolDenied()
    },
  })), 'dsh-kingdom: unbind-role tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'kingdom_bind_session',
    description: 'Owner-only：Agent Tool 不代行；请使用 `/kingdom role.session <JSON>`（OWNER.session_id 永远不是 Authority）',
    parameters: {
      role_type: { type: 'string', description: '角色：OWNER/CHANCELLOR/SUPERVISOR/WORKER（与 binding_id 二选一）' },
      binding_id: { type: 'string', description: '绑定 id（与 role_type 二选一）' },
      session_id: { type: 'string', description: '目标 dsh session id；传 null 清空' },
      model_name: { type: 'string', description: '模型名，如 deepseek-v4-pro / gpt-5.6；传 null 清空' },
      agent_name: { type: 'string', description: 'agent 工具名，如 codex / dsh；传 null 清空' },
      session_meta: { type: 'string', description: '任意扩展字段的 JSON 对象字符串；传 null 清空' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: {
      role_type?: string
      binding_id?: string
      session_id?: string | null
      model_name?: string | null
      agent_name?: string | null
      session_meta?: string | null
    }, exec: KingdomToolExecutionLike) {
      return ownerToolDenied({
        operation: 'kingdom_bind_session',
        request: {
          role_type: args.role_type,
          binding_id: args.binding_id,
          session_id: args.session_id,
        },
        exec,
      })
    },
  })), 'dsh-kingdom: bind-session tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'kingdom_draft_owner_binding_intent',
    description: '解析 bounded 自然语言 Owner 绑定意图；只返回 zero-write Draft，不执行绑定、不 mint Owner authority，最终须 direct /kingdom Slash 确认',
    parameters: {
      text: { type: 'string', required: true, description: '自然语言意图，例如“把当前会话设为宰相”或“让该会话主管 RAG 研发辖区”' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { text: string }, exec: KingdomToolExecutionLike) {
      const draft = draftOwnerBindingIntent({
        text: args.text,
        context: ownerBindingIntentContext(exec),
      })
      return serializeOwnerBindingIntentDraft(draft)
    },
  })), 'dsh-kingdom: owner-binding-intent draft tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'kingdom_list_bindings',
    description: '列出当前王国的全部角色绑定',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      const kingdomId = requireKingdom()
      if (!kingdomId) return '尚未初始化王国。请先 /kingdom init。'
      return listBindings(store, kingdomId)
    },
  })), 'dsh-kingdom: list-bindings tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'kingdom_set_execution_profile',
    description: 'Owner-only：Agent Tool 不代行；请使用 `/kingdom execution-profile <JSON>`',
    parameters: {
      role_type: { type: 'string', description: '角色：OWNER/CHANCELLOR/SUPERVISOR/WORKER（与 binding_id 二选一）' },
      binding_id: { type: 'string', description: '绑定 id（与 role_type 二选一）' },
      provider: { type: 'string', description: 'subagent provider 名（如 spawn/fork）；缺省回退全局 workerProvider' },
      model: { type: 'string', description: 'requested model（如 deepseek-v4-pro / gpt-5.6）；缺省继承父 Agent' },
      clear: { type: 'boolean', description: 'true = 清空执行配置（回退全局）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: {
      role_type?: string
      binding_id?: string
      provider?: string
      model?: string
      clear?: boolean
    }, exec: { agent?: { session?: { id?: string } } | null }) {
      return ownerToolDenied()
    },
  })), 'dsh-kingdom: set-execution-profile tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'kingdom_set_capability_ceiling',
    description: 'Owner-only：Agent Tool 不代行；请使用 `/kingdom ceiling <JSON>`；这是 governed persistent 的必要前置。',
    parameters: {
      ceiling_json: { type: 'string', description: 'capability allow-list JSON 对象，例如 {"filesystem.write":true,"tool:pwsh":true}；value 必须全为 boolean' },
      clear: { type: 'boolean', description: 'true = 清空 Ceiling（保持 governed execution fail-closed，直到重新配置）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { ceiling_json?: string; clear?: boolean }, exec: { agent?: { session?: { id?: string } } | null }) {
      return ownerToolDenied()
    },
  })), 'dsh-kingdom: set-capability-ceiling tool')

  // ── Phase 2：Task 治理闭环（5 个工具）──────────────────────────
  //
  // 注意这里**没有** kingdom_report_result 工具。Worker 是 one-shot subagent，
  // 它的结构化结果经 outputSchema 由宿主（DshSubagentExecutor）接收并落
  // worker_results —— 这是裁决 2「Worker ≠ Subagent Session」的实现方式。
  // Worker 自己没有任何工具能碰 Task 状态。

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'kingdom_plan_task',
    description: '规划一个任务并落入领地（Chancellor 职权），创建后状态为 CREATED',
    parameters: {
      title: { type: 'string', required: true, description: '任务标题' },
      description: { type: 'string', description: '任务详细描述' },
      acceptance_criteria: { type: 'string', description: '验收标准（Supervisor 审查的客观依据，强烈建议填写）' },
      territory_id: { type: 'string', description: '领地 id；王国只有一个领地时可省略' },
      capability_requirement_json: { type: 'string', description: '可选 Capability Requirement JSON；默认使用最小 governed requirement，并与 Task 同事务写入' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: {
      title: string
      description?: string
      acceptance_criteria?: string
      territory_id?: string
      capability_requirement_json?: string
    }, exec: { agent?: { session?: { id?: string } } | null }) {
      const kingdomId = requireKingdom()
      if (!kingdomId) return '尚未初始化王国。请先 /kingdom init。'
      const capabilityRequirementJson = args.capability_requirement_json === undefined
        ? MINIMAL_CAPABILITY_JSON
        : args.capability_requirement_json
      if (capabilityRequirementJson.trim() && !store.isSchemaV4) {
        return '错误：Schema v4 未迁移；PlanTask capability requirement 不可安全写入，命令拒绝（fail-closed）。'
      }
      return planTask(store, commandContext(kingdomId, trustedToolPrincipal(exec)), {
        title: args.title,
        description: args.description,
        acceptanceCriteria: args.acceptance_criteria,
        territoryId: args.territory_id,
        capabilityRequirementJson,
      }).message
    },
  })), 'dsh-kingdom: plan-task tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'kingdom_assign_task',
    description: '把任务派给 Worker 绑定（Supervisor 职权），CREATED → ASSIGNED',
    parameters: {
      task_id: { type: 'string', required: true, description: '任务 id' },
      worker_binding_id: { type: 'string', description: 'Worker binding id；省略则取王国里的 WORKER 绑定' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { task_id: string; worker_binding_id?: string }, exec: { agent?: { session?: { id?: string } } | null }) {
      const kingdomId = requireKingdom()
      if (!kingdomId) return '尚未初始化王国。请先 /kingdom init。'
      return assignTask(store, commandContext(kingdomId, trustedToolPrincipal(exec)), {
        taskId: args.task_id,
        workerBindingId: args.worker_binding_id,
      }).message
    },
  })), 'dsh-kingdom: assign-task tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'kingdom_start_task',
    description: 'LEGACY_COMPAT（仅显式选择）：用旧 one-shot Worker 执行任务并等待结果；不会自动作为 governed persistent 的 fallback。结果只会让任务进入 REVIEW，不会直接完成任务',
    parameters: {
      task_id: { type: 'string', required: true, description: '任务 id（状态需为 ASSIGNED，或 REWORK 后的 RUNNING）' },
      legacy_opt_in: { type: 'boolean', description: '必须显式传 true 选择 LEGACY_COMPAT；省略/false 永远拒绝，persistent 失败不会自动 fallback' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { task_id: string; legacy_opt_in?: boolean }, exec) {
      if (args.legacy_opt_in !== true) {
        return 'LEGACY_COMPAT_REQUIRED: kingdom_start_task 是旧 one-shot 兼容入口；必须显式传 legacy_opt_in=true。persistent governed 失败不会自动降级。'
      }
      const kingdomId = requireKingdom()
      if (!kingdomId) return '尚未初始化王国。请先 /kingdom init。'

      // Task Core 只认 WorkerExecutor 接口；subagents 的解析留在工具边界。
      const subagents = ctx.get('subagents') as SubagentsLike | undefined
      if (!subagents) {
        return '错误：当前 dsh 组合未提供 subagents 服务，无法执行 Worker。'
          + '请确认已加载 @deepseek-ai/dsh-subagent 及其 provider（base bundle 默认提供 spawn/fork）。'
      }
      if (!exec.agent) {
        return '错误：kingdom_start_task 需要由 Agent 调用（缺少委派父 Agent），无法启动 Worker subagent。'
      }

      const loadedTask = store.getTask(args.task_id)
      if (!loadedTask) return `错误：找不到任务 ${args.task_id}。`

      // v0.6.0（M1-C）：唯一执行解析入口——assigned_binding_id → Binding → ExecutionProfile → Executor。
      const resolved = resolveWorkerExecution(store, loadedTask, {
        subagents,
        globalProvider: config.workerProvider || 'spawn',
        parent: exec.agent,
        signal: exec.signal,
      })
      if (!resolved.ok) return resolved.error

      const result = await startTask(store, resolved.executor, commandContext(kingdomId, trustedToolPrincipal(exec)), { taskId: args.task_id })
      return result.message
    },
  })), 'dsh-kingdom: start-task tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'kingdom_start_task_governed',
    description: 'CANONICAL HEADLESS：以 Governed Persistent Worker 执行任务（v0.8）：真实 DSH caller session 中的 Supervisor + Territory scope 授权后，Worker 长期 DSH Session + Capability Gate（仅 GRANTED+ENFORCED 才 dispatch）+ Lease/Dispatch/Receipt/Evidence 全链；DENIED/CANNOT_ENFORCE → zero execution。需王国已迁移 Schema v4；Worker 获得并复用长期 Session（REWORK 唤醒同一 Worker）。失败只 fail-closed，不自动降级 LEGACY_COMPAT',
    parameters: {
      task_id: { type: 'string', required: true, description: '任务 id（状态需为 ASSIGNED，或 REWORK 后的 RUNNING）' },
      grant_json: { type: 'string', required: true, description: '当前已认证 Supervisor 的本次 capability Grant JSON（仅表达能力，不代表身份；如 {"tool:pwsh": true, "filesystem.write": true}）' },
      sandbox_mode: { type: 'string', description: 'workspace-write（默认，领地写边界）/ read-only' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { task_id: string; grant_json: string; sandbox_mode?: string }, exec: { agent?: { session?: { id?: string } } | null }) {
      return runGovernedStart({
        taskId: args.task_id,
        grantJson: args.grant_json,
        sandboxMode: args.sandbox_mode,
      }, { kind: 'tool', execution: exec })
    },
  })), 'dsh-kingdom: governed start-task tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'kingdom_review_task',
    description: '审查 Worker 提交的结果并裁定（Supervisor 职权，须在任务领地的主理范围内）。这是任务能变成 DONE 的唯一路径：ACCEPT（→DONE）/ REWORK（→RUNNING 同 Worker）/ FAIL（→FAILED）/ HANDOFF（→RUNNING 转交新 Worker，需 to_binding_id + reason）',
    parameters: {
      task_id: { type: 'string', required: true, description: '任务 id（状态需为 REVIEW）' },
      decision: { type: 'string', required: true, description: 'ACCEPT / REWORK / FAIL / HANDOFF' },
      reason: { type: 'string', description: '裁定理由；REWORK/FAIL/HANDOFF 必填' },
      to_binding_id: { type: 'string', description: 'HANDOFF 专用：目标 Worker binding id（ACTIVE）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { task_id: string; decision: string; reason?: string; to_binding_id?: string }, exec: { agent?: { session?: { id?: string } } | null }) {
      const kingdomId = requireKingdom()
      if (!kingdomId) return '尚未初始化王国。请先 /kingdom init。'
      return reviewTask(store, commandContext(kingdomId, trustedToolPrincipal(exec)), {
        taskId: args.task_id,
        decision: args.decision,
        reason: args.reason,
        to_binding_id: args.to_binding_id,
      }).message
    },
  })), 'dsh-kingdom: review-task tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'kingdom_list_tasks',
    description: '列出王国任务的真实状态（含尝试次数与最新 Worker Claim 摘要），可按领地/状态过滤',
    parameters: {
      territory_id: { type: 'string', description: '按领地过滤' },
      status: { type: 'string', description: '按状态过滤：CREATED/ASSIGNED/RUNNING/REVIEW/DONE/FAILED' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { territory_id?: string; status?: string }) {
      const kingdomId = requireKingdom()
      if (!kingdomId) return '尚未初始化王国。请先 /kingdom init。'
      return listTasks(store, kingdomId, {
        territoryId: args.territory_id,
        status: args.status,
      })
    },
  })), 'dsh-kingdom: list-tasks tool')

  // ── Phase 3：GUI 适配（结构化读接口 + Execution 控制）─────────────
  //
  // 架构原则：**插件输出治理事实和活动语义，GUI 决定人物、场景和动画。**
  // 因此这里返回的 stage 只有 { role, state, activity }，
  // 不会出现任何贴图名、clip id 或场景文件名。

  const jsonTool = (
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    execute: (args: Record<string, string | undefined>) => unknown,
  ) => ctx.tools.register(defineTool({
    name,
    description,
    parameters: parameters as never,
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: Record<string, string | undefined>) {
      return JSON.stringify(execute(args), null, 2)
    },
  }))

  ctx.effect(() => jsonTool(
    'kingdom_snapshot',
    '返回王国的结构化快照 JSON（王国/Owner/绑定/领地/任务/最新 Claim/活跃执行/表演状态/最近事件/revision），供 GUI 或需要精确数据的调用方使用',
    {},
    () => {
      const kingdomId = requireKingdom()
      if (!kingdomId) return { error: 'KINGDOM_NOT_INITIALIZED', message: '尚未初始化王国。请先 /kingdom init。' }
      return buildSnapshot(store, { auth: authView })
    },
  ), 'dsh-kingdom: snapshot tool')

  ctx.effect(() => jsonTool(
    'kingdom_task_detail',
    '返回单个任务的结构化详情 JSON：验收标准、尝试历史、全部 Claim、Supervisor 决策、执行记录、关联事件与允许的下一步动作',
    { task_id: { type: 'string', required: true, description: '任务 id' } },
    (args) => {
      const kingdomId = requireKingdom()
      if (!kingdomId) return { error: 'KINGDOM_NOT_INITIALIZED', message: '尚未初始化王国。请先 /kingdom init。' }
      const detail = buildTaskDetail(store, kingdomId, args.task_id ?? '')
      return detail ?? { error: 'TASK_NOT_FOUND', message: `找不到任务 ${args.task_id}。` }
    },
  ), 'dsh-kingdom: task-detail tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'kingdom_execution_control',
    description: '控制一次 Worker 执行的运行状态（Supervisor 职权）：pause 暂停 / resume 恢复 / abort 终止。只影响运行事实，不改变任务的治理状态',
    parameters: {
      execution_id: { type: 'string', required: true, description: 'Execution id（可从 kingdom_snapshot 的 liveExecutions 获取）' },
      action: { type: 'string', required: true, description: 'pause / resume / abort' },
      reason: { type: 'string', description: '原因（可选，会记入事件）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { execution_id: string; action: string; reason?: string }, exec: { agent?: { session?: { id?: string } } | null }) {
      const kingdomId = requireKingdom()
      if (!kingdomId) return '尚未初始化王国。请先 /kingdom init。'
      const input = { executionId: args.execution_id, reason: args.reason }
      const cmd = commandContext(kingdomId, trustedToolPrincipal(exec))
      switch (args.action.trim().toLowerCase()) {
        case 'pause': return pauseExecution(store, cmd, input).message
        case 'resume': return resumeExecution(store, cmd, input).message
        case 'abort': return abortExecution(store, cmd, input).message
        default: return `错误：action 必须是 pause / resume / abort 之一，收到 "${args.action}"。`
      }
    },
  })), 'dsh-kingdom: execution-control tool')

  // ── 本地 GUI 通道（direct `/kingdom gui` 激活；配置端口可预启动）────

  const GUI_HOST = '127.0.0.1'
  interface GuiRuntime {
    readonly address: GuiServerAddress
    readonly control: LocalControlManager
    readonly close: () => void
  }

  let guiRuntime: GuiRuntime | null = null
  let guiStartPromise: Promise<GuiRuntime> | null = null
  let guiStopRequested = false

  const projectionSecurityFor = (
    readContext?: GuiControlReadContext,
  ): ProjectionSecurityContext => {
    const principalSessionId = readContext?.principalSessionId
    if (typeof principalSessionId !== 'string' || principalSessionId.length === 0) return {}
    const kingdomId = requireKingdom()
    const supervisorBindingIds = new Set(
      kingdomId
        ? store.getBindingsByRole(kingdomId, 'SUPERVISOR')
          .filter(binding => binding.status === 'ACTIVE' && binding.session_id === principalSessionId)
          .map(binding => binding.binding_id)
        : [],
    )
    const scope = kingdomId
      ? store.listTerritories(kingdomId)
        .filter(territory => territory.supervisor_binding_id !== null
          && supervisorBindingIds.has(territory.supervisor_binding_id))
        .map(territory => `territory:${territory.territory_id}`)
      : []
    return {
      sessionVerified: true,
      principalSessionId,
      hostContext: true,
      commandCoverage: [...GUI_SESSION_COMMANDS],
      scope,
    }
  }

  const closeGuiRuntime = (runtime: GuiRuntime): void => {
    runtime.control.revokeAllSessions()
    try { runtime.close() } catch { /* server may already be unavailable */ }
    if (guiRuntime === runtime) guiRuntime = null
  }

  const ensureGuiServer = (): Promise<GuiRuntime> => {
    if (guiRuntime) return Promise.resolve(guiRuntime)
    if (guiStartPromise) return guiStartPromise
    guiStopRequested = false

    let closeServer: (() => void) | null = null
    const pending = new Promise<GuiRuntime>((resolve, reject) => {
      let listeningAddress: GuiServerAddress | null = null
      let settled = false
      const control = new LocalControlManager({
        host: GUI_HOST,
        // This remains empty until startGuiServer reports the actual port.
        // In particular, port=0 can never activate against a guessed origin.
        expectedOrigin: () => listeningAddress?.origin ?? '',
      })
      const safeClose = (): void => {
        try { closeServer?.() } catch { /* startup failure is already reported */ }
      }
      closeServer = () => {
        try { serverClose() } catch { /* server may not have reached listen */ }
      }
      // The returned close function is assigned after startGuiServer creates
      // its Server.  Keep the indirection local so callbacks never expose the
      // ticket or depend on a second launch protocol.
      let serverClose = (): void => undefined
      const onListening = (address: GuiServerAddress): void => {
        listeningAddress = address
        const runtime: GuiRuntime = {
          address,
          control,
          close: safeClose,
        }
        if (guiStopRequested) {
          control.revokeAllSessions()
          safeClose()
          settled = true
          reject(new Error('GUI_STOPPED_DURING_START'))
          return
        }
        guiRuntime = runtime
        settled = true
        resolve(runtime)
      }
      const onUnavailable = (error: Error): void => {
        if (settled) return
        settled = true
        control.dispose()
        reject(error)
      }
      serverClose = startGuiServer({
        snapshot: (readContext) => buildSnapshot(store, {
          auth: authView,
          security: projectionSecurityFor(readContext),
        }),
        taskDetail: (taskId, readContext) => {
          const kingdomId = requireKingdom()
          return kingdomId
            ? buildTaskDetail(store, kingdomId, taskId, {
              security: projectionSecurityFor(readContext),
            })
            : null
        },
        eventsSince: (afterSeq, limit) => {
          const kingdomId = requireKingdom()
          if (!kingdomId) return { revision: 0, events: [] }
          return {
            revision: store.revision(kingdomId),
            events: store.listEventsSince(kingdomId, afterSeq, limit).map(toEventView),
          }
        },
        command: (name, payload, context) => runGuiCommand(name, payload, context),
      }, {
        port: config.guiPort,
        host: GUI_HOST,
        ...config.guiToken ? { token: config.guiToken } : {},
        allowOrigins: config.guiAllowOrigins,
        control,
        onListening,
        onUnavailable,
        logger: ctx.logger,
      })
    })
    guiStartPromise = pending
    void pending.catch(() => {
      if (guiStartPromise === pending) guiStartPromise = null
    })
    return pending
  }

  const stopGuiServer = async (): Promise<void> => {
    guiStopRequested = true
    const pending = guiStartPromise
    if (pending && !guiRuntime) {
      try {
        const runtime = await pending
        closeGuiRuntime(runtime)
      } catch {
        // onUnavailable already failed closed and disposed the broker.
      }
    } else if (guiRuntime) {
      closeGuiRuntime(guiRuntime)
    }
    guiStartPromise = null
  }

  ctx.effect(() => () => { void stopGuiServer() })
  if (config.guiPort > 0) {
    void ensureGuiServer().catch((error: unknown) => {
      ctx.logger.warn(`dsh-kingdom GUI 通道启动失败（${error instanceof Error ? error.message : String(error)}）`)
    })
  }

  const guiFailure = (errorCode: CommandResultView['errorCode'], message: string): CommandResultView => ({
    ok: false,
    errorCode,
    message,
    task: null,
    execution: null,
    emittedEvents: [],
    allowedActions: [],
    revision: requireKingdom() ? store.revision(requireKingdom()!) : 0,
  })

  /** 把 Phase-1 风格（返回字符串）的领地/角色操作包装成 CommandResultView（M2：GUI 写层）。 */
  const plainResult = (text: string, kId: string): CommandResultView => {
    const failed = /^(?:错误：|OWNER_CONTROL_REQUIRED|CONFIG_DENIED|UNKNOWN\/|INPUT_DENIED|AUTHZ_DENIED|CAPABILITY_DENIED|GOVERNED_EXECUTION_DENIED)/u.test(text)
    const errorCode: CommandResultView['errorCode'] = !failed
      ? null
      : text.startsWith('AUTHZ_DENIED') ? 'SESSION_AUTH_REQUIRED'
        : text.startsWith('INPUT_DENIED') || text.startsWith('错误：') ? 'INVALID_INPUT'
          : text.startsWith('OWNER_CONTROL_REQUIRED') || text.startsWith('CONFIG_DENIED') ? 'SESSION_AUTH_REQUIRED'
            : 'WORKER_EXECUTION_FAILED'
    return {
      ok: !failed,
      errorCode,
      message: text,
      task: null,
      execution: null,
      emittedEvents: [],
      allowedActions: [],
      revision: store.revision(kId),
    }
  }

  /** GUI 写命令的分发。GUI 仍然经插件执行命令，绝不直接写 SQLite。 */
  async function runGuiCommand(
    name: string,
    payload: Record<string, unknown>,
    control?: GuiControlExecutionContext,
  ): Promise<CommandResultView> {
    if (GUI_OWNER_ONLY_COMMAND_SET.has(name)) {
      return guiFailure('SESSION_AUTH_REQUIRED',
        `DIRECT_SLASH_REQUIRED: Owner-only action "${name}" 不能由 GUI/HTTP 执行；请由人类 Owner 直接使用 /kingdom Slash。`)
    }
    const str = (key: string): string => typeof payload[key] === 'string' ? payload[key] : ''
    const opt = (key: string): string | undefined => typeof payload[key] === 'string' ? payload[key] : undefined

    if (!control || control.signal.aborted) {
      return guiFailure('SESSION_AUTH_REQUIRED', 'GUI Control Session 不存在或已撤销；命令未进入 Core。')
    }

    const kingdomId = requireKingdom()
    if (!kingdomId) {
      return guiFailure('KINGDOM_NOT_INITIALIZED', '尚未初始化王国。请由人类 Owner 先直接执行 `/kingdom init` 与所需 Owner-only 配置。')
    }
    // GUI role actions use the exact activation-time session, never a browser
    // field and never the configured declarative demo mode.
    const cmd = governedStartCommandContext(kingdomId, {
      sessionId: control.principalSessionId,
    })

    switch (name) {
      case 'territory.create':
        return plainResult(createTerritory(store, {
          kingdomId,
          name: str('name'),
          workspacePath: opt('workspace_path'),
          summary: opt('summary'),
        }), kingdomId)
      case 'territory.delete':
        return plainResult(deleteTerritory(store, {
          kingdomId,
          territoryId: opt('territory_id'),
          name: opt('name'),
          force: payload.force === true,
          reason: opt('reason'),
        }), kingdomId)
      case 'binding.bind':
        return plainResult(bindRole(store, {
          kingdomId,
          roleType: str('role_type'),
          roleName: opt('role_name'),
          sessionId: opt('session_id'),
          modelName: opt('model_name'),
          agentName: opt('agent_name'),
          sessionMeta: opt('session_meta'),
        }), kingdomId)
      case 'binding.unbind':
        return plainResult(unbindRole(store, {
          kingdomId,
          roleType: opt('role_type'),
          bindingId: opt('binding_id'),
          reason: opt('reason'),
        }), kingdomId)
      case 'binding.session':
        return plainResult(rebindSession(store, {
          kingdomId,
          roleType: opt('role_type'),
          bindingId: opt('binding_id'),
          sessionId: opt('session_id'),
          modelName: opt('model_name'),
          agentName: opt('agent_name'),
          sessionMeta: opt('session_meta'),
        }), kingdomId)
      case 'plan':
        if (!store.isSchemaV4) {
          return guiFailure('EXECUTOR_UNAVAILABLE', 'Schema v4 未迁移；GUI governed plan capability requirement 不可安全写入，命令拒绝。')
        }
        const capabilityRequirementJson = opt('capability_requirement_json') ?? MINIMAL_CAPABILITY_JSON
        const planned = planTask(store, cmd, {
          title: str('title'),
          description: opt('description'),
          acceptanceCriteria: opt('acceptance_criteria'),
          territoryId: opt('territory_id'),
          capabilityRequirementJson,
        })
        return planned
      case 'assign':
        return assignTask(store, cmd, { taskId: str('task_id'), workerBindingId: opt('worker_binding_id') })
      case 'review':
        return reviewTask(store, cmd, {
          taskId: str('task_id'),
          decision: str('decision'),
          reason: opt('reason'),
          to_binding_id: opt('to_binding_id'),
        })
      case 'execution.pause':
        return pauseExecution(store, cmd, { executionId: str('execution_id'), reason: opt('reason') })
      case 'execution.resume':
        return resumeExecution(store, cmd, { executionId: str('execution_id'), reason: opt('reason') })
      case 'execution.abort':
        return abortExecution(store, cmd, { executionId: str('execution_id'), reason: opt('reason') })
      case 'start':
        if (!control.principalSessionId.trim()) {
          return guiFailure('UNAUTHORIZED_PRINCIPAL', '激活时没有 exact agent.session.id；governed start 拒绝执行。')
        }
        const callerAgent = (control as GuiControlContextWithAgent).agent
        if (!callerAgent) {
          return guiFailure('EXECUTOR_UNAVAILABLE', '激活时没有 exact DSH Agent reference；GUI 不伪造 Worker 父 Agent。')
        }
        try {
          const started = await runGovernedStart({
            taskId: str('task_id'),
            grantJson: str('grant_json'),
            sandboxMode: opt('sandbox_mode'),
          }, {
            kind: 'gui',
            principal: { sessionId: control.principalSessionId },
            agent: callerAgent,
          })
          if (control.signal.aborted) {
            return plainResult('UNKNOWN/RECOVERY_REQUIRED: GUI Control Session 在 governed start 期间被撤销；请先刷新并对账，不自动重试。', kingdomId)
          }
          return plainResult(started, kingdomId)
        } catch (error: unknown) {
          const detail = error instanceof Error ? error.message : String(error)
          return plainResult(`UNKNOWN/RECOVERY_REQUIRED: governed start 结果不确定，请先刷新 Projection 对账；不自动重试。(${detail})`, kingdomId)
        }
      default:
        return guiFailure('INVALID_INPUT', `未知命令 "${name}"。`)
    }
  }

  // ── Direct local Owner Control Slash（唯一 Owner-only 写入口）────

  type JsonEnvelopeResult =
    | { ok: true; value: Record<string, unknown> }
    | { ok: false; message: string }

  const parseJsonEnvelope = (rest: string, allowed: readonly string[], required: readonly string[] = []): JsonEnvelopeResult => {
    if (!rest) return { ok: false, message: '需要一个 JSON object envelope；不得省略参数。' }
    let parsed: Record<string, unknown>
    try {
      parsed = parseStrictJsonObject(rest)
    } catch (error: unknown) {
      if (error instanceof DuplicateJsonKeyError) {
        return { ok: false, message: `JSON envelope 不得包含重复字段 "${error.key}"。` }
      }
      return { ok: false, message: 'JSON envelope 非法；必须是单个 JSON object。' }
    }
    const value = parsed
    const allowedSet = new Set(allowed)
    const unknown = Object.keys(value).filter(key => !allowedSet.has(key))
    if (unknown.length > 0) return { ok: false, message: `不允许的字段：${unknown.join(', ')}。` }
    const missing = required.filter(key => !Object.prototype.hasOwnProperty.call(value, key))
    if (missing.length > 0) return { ok: false, message: `缺少字段：${missing.join(', ')}。` }
    return { ok: true, value }
  }

  const directCommandParts = (rawInput: string): { sub: string; rest: string } => {
    let line = rawInput.trim()
    if (line.startsWith('/kingdom')) line = line.slice('/kingdom'.length).trim()
    const match = line.match(/^(\S+)(?:\s+([\s\S]*))?$/u)
    return { sub: match?.[1] ?? '', rest: match?.[2] ?? '' }
  }

  const ownerWrite = (operation: string, fn: () => string): string => {
    const kingdomId = requireKingdom()
    if (!kingdomId) return 'OWNER_CONTROL_REQUIRED: 请先直接执行 `/kingdom init` 建立 Owner principal。'
    try {
      // Each direct operation gets one IMMEDIATE boundary.  Core helpers may
      // append events inside it; failure rolls back all domain writes.
      return store.withImmediateTransaction(fn)
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return `UNKNOWN/RECOVERY_REQUIRED: Owner operation ${operation} 的写结果不确定；请先 /kingdom status 对账。(${detail})`
    }
  }

  const validateDirectSessionPayload = (operation: string, value: unknown): string | null => {
    if (value === undefined || value === null) return null
    if (typeof value !== 'string') return `INPUT_DENIED [${operation}]: session_id 必须是 string 或 null。`
    const seam = dshRegistrySeam()
    const live = validateLiveDirectSession(value, seam)
    if (live.ok) return null
    return `INPUT_DENIED [SESSION_${live.classification}]: ${live.reason}；direct /kingdom ${operation} 未写入。`
  }

  const ownerAuth = () => ownerControlAuth(issueOwnerControlCapability())

  ctx.effect(() => ctx.commands.register({
    name: 'kingdom',
    description: 'direct Owner Control：初始化、状态、内置 GUI 与精确 JSON 配置；独立 Agent Tool/HTTP payload 不得代行 Owner 写入',
    input: { hint: 'gui [start|stop] | init | status | ceiling <json> | territory.* <json> | role.* <json> | execution-profile <json> | help' },
    handler: async (invocation): Promise<CommandResult> => {
      const { sub, rest } = directCommandParts(invocation.rawInput)
      const auth = ownerAuth()
      switch (sub) {
        case 'gui': {
          const action = rest.trim().toLowerCase()
          if (action === 'stop') {
            await stopGuiServer()
            return {
              kind: 'success',
              text: 'GUI Control Session 已停止；活动控制会话已撤销，本地 GUI server 已关闭（如曾启动）。',
            }
          }
          if (action !== '' && action !== 'start') {
            return { kind: 'error', text: 'INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: `/kingdom gui` 只接受 start、stop 或无参数。' }
          }
          try {
            // ensureGuiServer resolves only from the server's onListening
            // callback, so port=0 uses the actual bound origin.
            const runtime = await ensureGuiServer()
            const activation = runtime.control.activate(invocation.agent)
            const launchUrl = `${runtime.address.origin}${activation.launchPath}?ticket=${encodeURIComponent(activation.launchTicket)}`
            const browserOpened = openLocalConsole(launchUrl)
            return formatGuiLaunchCommandResult(runtime.address.origin, activation.expiresAt, browserOpened)
          } catch {
            // Never reflect an exception into command/done if it could contain
            // a transport value.  The launch ticket is intentionally absent.
            return {
              kind: 'error',
              text: 'UNKNOWN/RECOVERY_REQUIRED: GUI Control Session 启动失败；未输出 launch ticket，请检查本地 GUI server 后重试。',
            }
          }
        }
        case 'init':
          if (rest) return { kind: 'error', text: 'INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: `/kingdom init` 不接受额外 token。' }
          try {
            return { kind: 'success', text: initResultText(manager.init()) }
          } catch (error: unknown) {
            const detail = error instanceof Error ? error.message : String(error)
            return { kind: 'error', text: `UNKNOWN/RECOVERY_REQUIRED: init 写结果不确定，请先对账。(${detail})` }
          }
        case 'status':
          if (rest) return { kind: 'error', text: 'INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: `/kingdom status` 不接受额外 token。' }
          return { kind: 'success', text: store.statusSummary() }
        case 'reset':
          if (rest) return { kind: 'error', text: 'INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: `/kingdom reset` 不接受额外 token。' }
          try { return { kind: 'success', text: `已重新接入。${manager.rescan().detail}` } }
          catch (error: unknown) {
            const detail = error instanceof Error ? error.message : String(error)
            return { kind: 'error', text: `UNKNOWN/RECOVERY_REQUIRED: reset 读结果不确定，请先对账。(${detail})` }
          }
        case 'ceiling': {
          const parsed = parseJsonEnvelope(rest, ['ceiling', 'ceiling_json', 'clear'])
          if (!parsed.ok) return { kind: 'error', text: `INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: ${parsed.message}` }
          const value = parsed.value
          if (value.clear !== undefined && typeof value.clear !== 'boolean') return { kind: 'error', text: 'INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: clear 必须是 boolean。' }
          if (value.clear === true && (value.ceiling !== undefined || value.ceiling_json !== undefined)) return { kind: 'error', text: 'INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: clear=true 不得同时提供 ceiling。' }
          let ceilingJson: string | null
          if (value.clear === true) ceilingJson = null
          else if (typeof value.ceiling_json === 'string') ceilingJson = value.ceiling_json
          else if (value.ceiling !== undefined) {
            if (typeof value.ceiling !== 'object' || value.ceiling === null || Array.isArray(value.ceiling)) return { kind: 'error', text: 'INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: ceiling 必须是 capability→boolean object。' }
            ceilingJson = JSON.stringify(value.ceiling)
          } else return { kind: 'error', text: 'INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: 请提供 ceiling object、ceiling_json 或 clear=true。' }
          const text = ownerWrite('ceiling', () => setCapabilityCeiling(store, { kingdomId: requireKingdom()!, ceilingJson }, auth))
          return { kind: text.startsWith('UNKNOWN/') || text.startsWith('CONFIG_DENIED') ? 'error' : 'success', text }
        }
        case 'territory.create': {
          const parsed = parseJsonEnvelope(rest, ['name', 'workspace_path', 'summary'], ['name'])
          if (!parsed.ok || typeof parsed.value.name !== 'string') return { kind: 'error', text: `INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: ${parsed.ok ? 'name 必须是 string。' : parsed.message}` }
          const value = parsed.value
          if (value.workspace_path !== undefined && typeof value.workspace_path !== 'string') return { kind: 'error', text: 'INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: workspace_path 必须是 string。' }
          if (value.summary !== undefined && typeof value.summary !== 'string') return { kind: 'error', text: 'INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: summary 必须是 string。' }
          const text = ownerWrite('territory.create', () => createTerritory(store, { kingdomId: requireKingdom()!, name: value.name as string, workspacePath: value.workspace_path as string | undefined, summary: value.summary as string | undefined }, auth))
          return { kind: text.startsWith('UNKNOWN/') || text.startsWith('错误：') ? 'error' : 'success', text }
        }
        case 'territory.delete': {
          const parsed = parseJsonEnvelope(rest, ['territory_id', 'name', 'force', 'reason'])
          if (!parsed.ok) return { kind: 'error', text: `INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: ${parsed.message}` }
          const value = parsed.value
          if (typeof value.territory_id !== 'string' && typeof value.name !== 'string') return { kind: 'error', text: 'INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: territory_id/name 二选一。' }
          if (value.force !== undefined && typeof value.force !== 'boolean') return { kind: 'error', text: 'INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: force 必须是 boolean。' }
          if (value.reason !== undefined && typeof value.reason !== 'string') return { kind: 'error', text: 'INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: reason 必须是 string。' }
          const text = ownerWrite('territory.delete', () => deleteTerritory(store, { kingdomId: requireKingdom()!, territoryId: value.territory_id as string | undefined, name: value.name as string | undefined, force: value.force as boolean | undefined, reason: value.reason as string | undefined }, auth))
          return { kind: text.startsWith('UNKNOWN/') || text.startsWith('错误：') ? 'error' : 'success', text }
        }
        case 'territory.supervisor': {
          const parsed = parseJsonEnvelope(rest, ['territory_id', 'supervisor_binding_id'], ['territory_id', 'supervisor_binding_id'])
          if (!parsed.ok) return { kind: 'error', text: `INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: ${parsed.message}` }
          const value = parsed.value
          if (typeof value.territory_id !== 'string' || (value.supervisor_binding_id !== null && typeof value.supervisor_binding_id !== 'string')) return { kind: 'error', text: 'INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: territory_id/supervisor_binding_id 类型错误。' }
          const text = ownerWrite('territory.supervisor', () => setTerritorySupervisor(store, { kingdomId: requireKingdom()!, territoryId: value.territory_id as string, supervisorBindingId: value.supervisor_binding_id as string | null }, auth))
          return { kind: text.startsWith('UNKNOWN/') || text.startsWith('错误：') ? 'error' : 'success', text }
        }
        case 'role.bind': {
          const parsed = parseJsonEnvelope(rest, ['role_type', 'role_name', 'session_id', 'model_name', 'agent_name', 'session_meta'], ['role_type'])
          if (!parsed.ok || typeof parsed.value.role_type !== 'string') return { kind: 'error', text: `INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: ${parsed.ok ? 'role_type 必须是 string。' : parsed.message}` }
          const value = parsed.value
          if ((value.role_type as string).toUpperCase() === 'OWNER') return { kind: 'error', text: 'OWNER_CONTROL_REQUIRED: OWNER projection 不得通过 role.bind 改绑为 Session。' }
          for (const key of ['role_name', 'session_id', 'model_name', 'agent_name', 'session_meta'] as const) {
            if (value[key] !== undefined && typeof value[key] !== 'string') return { kind: 'error', text: `INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: ${key} 必须是 string。` }
          }
          const liveSessionError = validateDirectSessionPayload('role.bind', value.session_id)
          if (liveSessionError) return { kind: 'error', text: liveSessionError }
          const text = ownerWrite('role.bind', () => bindRole(store, { kingdomId: requireKingdom()!, roleType: value.role_type as string, roleName: value.role_name as string | undefined, sessionId: value.session_id as string | undefined, modelName: value.model_name as string | undefined, agentName: value.agent_name as string | undefined, sessionMeta: value.session_meta as string | undefined }, auth))
          return { kind: text.startsWith('UNKNOWN/') || text.startsWith('错误：') || text.startsWith('角色 ') && text.includes('已有绑定') ? 'error' : 'success', text }
        }
        case 'role.unbind': {
          const parsed = parseJsonEnvelope(rest, ['role_type', 'binding_id', 'reason'])
          if (!parsed.ok) return { kind: 'error', text: `INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: ${parsed.message}` }
          const value = parsed.value
          if (value.role_type !== undefined && typeof value.role_type !== 'string') return { kind: 'error', text: 'INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: role_type 必须是 string。' }
          if (value.binding_id !== undefined && typeof value.binding_id !== 'string') return { kind: 'error', text: 'INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: binding_id 必须是 string。' }
          if (value.reason !== undefined && typeof value.reason !== 'string') return { kind: 'error', text: 'INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: reason 必须是 string。' }
          if ((value.role_type === undefined) === (value.binding_id === undefined)) return { kind: 'error', text: 'INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: role_type/binding_id 必须二选一。' }
          if (String(value.role_type ?? '').toUpperCase() === 'OWNER') return { kind: 'error', text: 'OWNER_CONTROL_REQUIRED: OWNER projection 不得退任。' }
          const text = ownerWrite('role.unbind', () => unbindRole(store, { kingdomId: requireKingdom()!, roleType: value.role_type as string | undefined, bindingId: value.binding_id as string | undefined, reason: value.reason as string | undefined }, auth))
          return { kind: text.startsWith('UNKNOWN/') || text.startsWith('错误：') ? 'error' : 'success', text }
        }
        case 'role.session': {
          const parsed = parseJsonEnvelope(rest, ['role_type', 'binding_id', 'session_id', 'model_name', 'agent_name', 'session_meta'])
          if (!parsed.ok) return { kind: 'error', text: `INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: ${parsed.message}` }
          const value = parsed.value
          // parseJsonEnvelope has already enforced the strict object,
          // duplicate-key, and unknown-field boundary.  For this valid
          // envelope, Owner is a projection rather than a runtime-session
          // target: resolve explicit role/binding Owner before the remaining
          // xor/type/live-session proof so mixed requests fail closed alike.
          const directKingdomId = requireKingdom()
          const directBinding = directKingdomId && typeof value.binding_id === 'string'
            ? resolveBinding(store, directKingdomId, undefined, value.binding_id)
            : null
          const explicitOwner = typeof value.role_type === 'string'
            && value.role_type.trim().toUpperCase() === 'OWNER'
          if (explicitOwner || directBinding?.role_type.trim().toUpperCase() === 'OWNER') {
            return { kind: 'error', text: 'OWNER_CONTROL_REQUIRED: OWNER.session_id 永远不作为 Owner Authority。' }
          }
          if ((value.role_type === undefined) === (value.binding_id === undefined)) return { kind: 'error', text: 'INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: role_type/binding_id 必须二选一。' }
          for (const key of ['role_type', 'binding_id', 'session_id', 'model_name', 'agent_name', 'session_meta'] as const) {
            if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'string') return { kind: 'error', text: `INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: ${key} 必须是 string 或 null。` }
          }
          const liveSessionError = validateDirectSessionPayload('role.session', value.session_id)
          if (liveSessionError) return { kind: 'error', text: liveSessionError }
          const text = ownerWrite('role.session', () => rebindSession(store, { kingdomId: requireKingdom()!, roleType: value.role_type as string | undefined, bindingId: value.binding_id as string | undefined, sessionId: value.session_id as string | null | undefined, modelName: value.model_name as string | null | undefined, agentName: value.agent_name as string | null | undefined, sessionMeta: value.session_meta as string | null | undefined }, auth))
          return { kind: text.startsWith('UNKNOWN/') || text.startsWith('错误：') ? 'error' : 'success', text }
        }
        case 'execution-profile': {
          const parsed = parseJsonEnvelope(rest, ['role_type', 'binding_id', 'provider', 'model', 'clear'])
          if (!parsed.ok) return { kind: 'error', text: `INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: ${parsed.message}` }
          const value = parsed.value
          if ((value.role_type === undefined) === (value.binding_id === undefined)) return { kind: 'error', text: 'INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: role_type/binding_id 必须二选一。' }
          if (value.clear !== undefined && typeof value.clear !== 'boolean') return { kind: 'error', text: 'INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: clear 必须是 boolean。' }
          for (const key of ['role_type', 'binding_id', 'provider', 'model'] as const) {
            if (value[key] !== undefined && typeof value[key] !== 'string') return { kind: 'error', text: `INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: ${key} 必须是 string。` }
          }
          if (value.clear !== true && typeof value.provider !== 'string' && typeof value.model !== 'string') return { kind: 'error', text: 'INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: 至少提供 provider/model，或 clear=true。' }
          const text = ownerWrite('execution-profile', () => setExecutionProfile(store, { kingdomId: requireKingdom()!, roleType: value.role_type as string | undefined, bindingId: value.binding_id as string | undefined, profile: value.clear === true ? null : { ...(typeof value.provider === 'string' ? { provider: value.provider } : {}), ...(typeof value.model === 'string' ? { model: value.model } : {}) } }, auth))
          return { kind: text.startsWith('UNKNOWN/') || text.startsWith('错误：') ? 'error' : 'success', text }
        }
        case 'help':
        case '':
          if (rest) return { kind: 'error', text: 'INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: help 不接受额外 token。' }
          return {
            kind: 'success',
            text: [
              'dsh-Kingdom Owner Control Plane（Owner ≠ Agent ≠ Session）',
              '/kingdom init    原子初始化/接入；OWNER.session_id 永远为 null',
              '/kingdom status  查看真实状态（只读）',
              '/kingdom ceiling {"ceiling":{"tool:pwsh":true}} | {"clear":true}',
              '/kingdom territory.create {"name":"研发领","workspace_path":"C:/work"}',
              '/kingdom territory.delete {"territory_id":"...","force":false}',
              '/kingdom territory.supervisor {"territory_id":"...","supervisor_binding_id":"..."}',
              '/kingdom role.bind {"role_type":"SUPERVISOR","role_name":"主理","session_id":"真实 DSH session"}',
              '/kingdom role.unbind {"binding_id":"...","reason":"换届"}',
              '/kingdom role.session {"binding_id":"...","session_id":"真实 DSH session"}',
              '/kingdom execution-profile {"binding_id":"...","provider":"spawn","model":"..."}',
              '以上写命令只接受一个 JSON object；unknown key、额外 token、Owner Session 均拒绝。',
              'Agent Role Plane：plan → assign → kingdom_start_task_governed（CANONICAL HEADLESS，Persistent Worker） → Claim(REVIEW) → Supervisor ACCEPT/REWORK/FAIL。',
              'LEGACY_COMPAT：kingdom_start_task 仅在用户明确选择旧 one-shot 兼容模式时显式调用；persistent 失败不会自动 fallback。',
               'GUI 需先由 direct `/kingdom gui` 激活；HTTP 只作无权 transport，命令仍经同一 Core/Role/Capability gates。',
            ].join('\n'),
          }
        default:
          return { kind: 'error', text: `INPUT_DENIED [OWNER_COMMAND_GRAMMAR]: 未知子命令 "${sub}"。请使用 /kingdom help。` }
      }
    },
  }), 'dsh-kingdom: /kingdom command')
}
