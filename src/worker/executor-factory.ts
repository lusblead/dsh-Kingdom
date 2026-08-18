/**
 * dsh-kingdom — ExecutorFactory：唯一执行解析入口（v0.6.0，M1-C）。
 *
 * 冻结语义（用户裁决 2026-08-18）：
 * - `Task.assigned_binding_id → Worker Binding → ExecutionProfile → Executor`
 * - provider 来源：binding profile 优先，缺省回退全局 workerProvider（`global-fallback` 证据）；
 * - model 来源：profile.model（`binding`）或继承父 Agent（`parent-inherited`）——
 *   两种来源分开记录，绝不混成一个 runtime_source；
 * - **硬不变量：本模块禁止读取 binding.model_name**（席位展示元数据，不是执行配置）；
 * - 每 attempt = 全新 one-shot execution；无长期 Worker Session；无 Multi-Worker。
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
