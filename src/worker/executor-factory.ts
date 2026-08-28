/**
 * dsh-kingdom — ExecutorFactory：唯一执行解析入口（v0.6.0，M1-C）。
 *
 * 冻结语义（用户裁决 2026-08-18）：
 * - `Task.assigned_binding_id → Worker Binding → ExecutionProfile → Executor`
 * - provider 来源：binding profile 优先，缺省回退全局 workerProvider（`global-fallback` 证据）；
 * - model 来源：profile.model（`binding`）或继承父 Agent（`parent-inherited`）——
 *   两种来源分开记录，绝不混成一个 runtime_source；
 * - **硬不变量：本模块禁止读取 binding.model_name**（席位展示元数据，不是执行配置）；
 * - 本 factory 只服务显式 `LEGACY_COMPAT` start；每 attempt = 全新 one-shot execution，
 *   无长期 Worker Session。canonical governed start 使用 governed executor，不经过本 factory。
 */
import { KingdomStore, TaskRow } from '../core/db.js'
import { parseExecutionProfile } from '../core/binding.js'
import { DshSubagentExecutor, SubagentsLike } from './dsh-subagent.js'
import { ExecutorInfo, WorkerExecutor } from './executor.js'

/** provider 来源证据。 */
export type ProviderSource = 'binding' | 'global-fallback'
/** model 来源证据。 */
export type ModelSource = 'binding' | 'parent-inherited' | 'unknown'

/** ExecutorFactory 解析结果（Execution 落库的证据快照，start 态）。 */
export interface ResolvedExecution {
  info: ExecutorInfo
}

/** ExecutorFactory 运行期入参。 */
export interface ResolveWorkerExecutionRuntime {
  subagents: SubagentsLike
  /** config.workerProvider（全局兼容回退）。 */
  globalProvider: string
  /** 委派父 Agent（exec.agent，永远来自 Supervisor 调用者——血缘/工作区，与 Worker Runtime 分离）。 */
  parent: unknown
  signal: AbortSignal
}

/** 解析失败（不启动 Execution，fail 明确）。 */
export interface ResolveError {
  error: string
}

export type ResolveWorkerExecutionResult =
  | { ok: true; info: ExecutorInfo; executor: WorkerExecutor }
  | { ok: false; error: string }

/**
 * 唯一执行解析入口。
 *
 * 解析顺序（确定性）：
 * 1. assigned_binding_id → binding（缺失/非 WORKER → 明确错误）；
 * 2. parse execution_profile_json（非法 JSON = 空 profile）；
 * 3. provider = profile.provider ?? globalProvider；
 *    provider_source = profile.provider ? 'binding' : 'global-fallback'；
 *    provider 未注册 → 明确错误（不启动 Execution）；
 * 4. requested_model = profile.model ?? null；
 *    model_source = requested_model ? 'binding' : 'parent-inherited'；
 * 5. executor = DshSubagentExecutor（info 携带解析结果）。
 */
export function resolveWorkerExecution(
  store: KingdomStore,
  task: TaskRow,
  runtime: ResolveWorkerExecutionRuntime,
): ResolveWorkerExecutionResult {
  const binding = task.assigned_binding_id ? store.getBindingById(task.assigned_binding_id) : null
  if (!binding) {
    return { ok: false, error: `错误：任务「${task.title}」未指派 Worker 绑定（assigned_binding_id 缺失或不存在）。` }
  }
  if (binding.role_type !== 'WORKER') {
    return { ok: false, error: `错误：任务「${task.title}」指派的绑定 ${binding.role_name} 不是 WORKER，无法执行。` }
  }

  // 硬不变量：执行解析绝不读 binding.model_name / agent_name / session_meta（席位展示元数据）。
  const profile = parseExecutionProfile(binding.execution_profile_json)

  const provider = profile?.provider?.trim() || runtime.globalProvider
  const providerSource: ProviderSource = profile?.provider?.trim() ? 'binding' : 'global-fallback'
  if (runtime.subagents.getProvider(provider) === undefined) {
    const available = runtime.subagents.list()
    return {
      ok: false,
      error: `错误：执行配置的 provider "${provider}" 未注册`
        + `（${providerSource === 'binding' ? '来自 Worker 执行配置' : '来自全局 workerProvider 回退'}；`
        + `当前可用：${available.length > 0 ? available.join(' / ') : '无'}）。`,
    }
  }

  const requestedModel = profile?.model?.trim() || null
  const modelSource: ModelSource = requestedModel ? 'binding' : 'parent-inherited'

  const info: ExecutorInfo = { provider, providerSource, requestedModel, modelSource }
  const executor = new DshSubagentExecutor({
    subagents: runtime.subagents,
    provider,
    model: requestedModel,
    parent: runtime.parent,
    signal: runtime.signal,
    info,
  })
  return { ok: true, info, executor }
}

/** governed 路径解析出的 Worker Runtime（provider/model）。 */
export interface GovernedWorkerRuntime {
  provider: string
  providerSource: ProviderSource
  /** governed Persistent Session 必须显式配置的模型（DSH deployment prompt 依赖 {{model}}）。 */
  model: string
  modelSource: 'binding'
}

export type ResolveGovernedWorkerRuntimeResult =
  | { ok: true; runtime: GovernedWorkerRuntime }
  | { ok: false; error: string }

/**
 * v0.8 governed 路径的执行解析（Owner V0.8 PRODUCTION-PATH CLOSURE A）。
 *
 * - 权威来源 = Worker binding 的 `execution_profile_json`（v0.6.0 M1-C 语义；**绝不读**
 *   `model_name` / `agent_name` / `session_meta` —— Role 与 Model 不重新绑定）；
 * - provider = profile.provider ?? globalProvider（全局 workerProvider config 回退，`global-fallback` 证据）；
 * - model = profile.model —— **必须显式配置合法模型**（真实 E2E 证实：DSH deployment prompt 段
 *   依赖 `{{model}}`，缺失 → `turn/end=error`、无 assistant）；缺失 → fail closed：
 *   明确 configuration error，不创建 Session、不 dispatch；
 * - 不覆盖 Worker 已显式配置的 provider/model（显式配置优先于全局回退）；
 * - 禁止 hardcode 任何单一模型（本函数零模型字面量）。
 */
export function resolveGovernedWorkerRuntime(
  store: KingdomStore,
  task: TaskRow,
  global: { globalProvider: string },
): ResolveGovernedWorkerRuntimeResult {
  const binding = task.assigned_binding_id ? store.getBindingById(task.assigned_binding_id) : null
  if (!binding) {
    return { ok: false, error: `错误：任务「${task.title}」未指派 Worker 绑定（assigned_binding_id 缺失或不存在）。` }
  }
  if (binding.role_type !== 'WORKER') {
    return { ok: false, error: `错误：任务「${task.title}」指派的绑定 ${binding.role_name} 不是 WORKER，无法执行。` }
  }
  const profile = parseExecutionProfile(binding.execution_profile_json)
  const provider = profile?.provider?.trim() || global.globalProvider
  const providerSource: ProviderSource = profile?.provider?.trim() ? 'binding' : 'global-fallback'
  if (!provider) {
    return {
      ok: false,
      error: `错误：Worker「${binding.role_name}」执行配置缺失 provider，且无全局 workerProvider 回退`
        + `——governed Persistent Session 需要 provider（fail closed，zero execution）。`,
    }
  }
  const model = profile?.model?.trim() || null
  if (!model) {
    return {
      ok: false,
      error: `错误：Worker「${binding.role_name}」未配置执行模型（execution_profile_json.model 缺失）。`
        + `governed Persistent Session 必须显式配置合法 model（DSH deployment prompt 依赖 {{model}}）；`
        + `请用 kingdom_set_execution_profile 为 Worker 配置 {"provider":"...","model":"..."}`
        + `（fail closed，zero execution，不创建 Session、不 dispatch）。`,
    }
  }
  return { ok: true, runtime: { provider, providerSource, model, modelSource: 'binding' } }
}

/**
 * 构造 Execution 落库用的不可变快照 JSON（requested/resolved/source 三节）。
 * start 时写 requested+source 节；结算时补 resolved 节（updateExecutionResolvedEvidence）。
 */
export function buildExecutionProfileSnapshot(
  info: ExecutorInfo,
  resolvedModel: string | null,
): string {
  return JSON.stringify({
    requested: {
      provider: info.provider,
      model: info.requestedModel,
    },
    resolved: {
      provider: info.provider,
      model: resolvedModel,
    },
    source: {
      provider: info.providerSource,
      model: info.modelSource,
    },
  })
}
