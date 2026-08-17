/**
 * dsh-kingdom — DshSubagentExecutor：用 dsh one-shot subagent 执行 Worker（裁决 2）。
 *
 * 裁决 2 冻结的形状：
 * - Worker 用 `ctx.subagents.start(provider, { label, prompt, outputSchema })` **one-shot 独立执行**；
 * - **不**采用常驻 `ctx.agents.create`；
 * - 每次执行都是新的 execution/session（REWORK 也一样，裁决 5）；
 * - Structured Worker Result 由 subagent 的 `outputSchema` 约束，
 *   宿主（本类）接收后交给 Task Core 落 worker_results。
 *
 * 这也是为什么 `kingdom_report_result` **不是**独立工具：Worker 是 one-shot subagent，
 * 它没有机会自己调工具改 Task 状态 —— 结果只能经宿主这一条路回来。
 *
 * ## 为什么这里对 ctx.subagents 用结构化局部类型
 *
 * 本插件是独立分发的 tgz，peer 只声明 5 条（见 README）。为了不新增第 6 条 peer、
 * 也不让编译产物 .d.ts 泄漏 subagent 类型，这里按 dsh 已发布的接口**结构化**地
 * 声明所需最小面，而不 import `@deepseek-ai/dsh-subagent`。
 * 对应 checkout 定义（0.1.0/0.2.0 基线一致）：
 * - `SubagentRuntime.start(name, request)` — packages/subagent/subagent/src/index.ts:414
 * - `SubagentStartRequest{label,prompt,parent,signal,outputSchema}` — .../src/types.ts:100
 * - `SubagentRun{id,result,dispose}` / `SubagentResult{output,structured,stopReason}` — .../src/types.ts:219,249
 */
import {
  buildWorkerPrompt,
  parseStructuredResult,
  WORKER_OUTPUT_SCHEMA,
  type WorkerContext,
  type WorkerExecutionOutcome,
  type WorkerExecutor,
} from './executor.js'
import type { TaskRow } from '../core/db.js'

/** dsh `SubagentResult` 的最小结构面。 */
interface SubagentResultLike {
  readonly structured?: unknown
  readonly stopReason: string
}

/** dsh `SubagentRun` 的最小结构面。 */
interface SubagentRunLike {
  readonly id: string
  readonly result: Promise<SubagentResultLike>
  dispose(): Promise<void>
}

/** dsh `SubagentRuntime` 的最小结构面。 */
export interface SubagentsLike {
  start(name: string, request: {
    label?: string
    prompt: { type: 'text'; text: string }[]
    parent: unknown
    signal: AbortSignal
    outputSchema?: unknown
  }): Promise<SubagentRunLike>
  getProvider(name: string): unknown
  list(): string[]
}

/** 构造 DshSubagentExecutor 所需的一次性运行期入参。 */
export interface DshSubagentExecutorOptions {
  /** `ctx.get('subagents')` 拿到的 subagent 注册表。 */
  subagents: SubagentsLike
  /** provider 名（dsh base bundle 默认注册 `spawn` / `fork`）。 */
  provider: string
  /**
   * 发起委派的父 Agent（来自工具执行上下文 `exec.agent`）。
   * in-process provider 从它派生 workspace / 血缘 / 委派深度。
   */
  parent: unknown
  /** 调用方的取消信号（`exec.signal`）。 */
  signal: AbortSignal
}

/**
 * 判定 stopReason 是否算“正常跑完”。
 * 非 completed 一律视为宿主观察到的运行失败（裁决 6），不去解释 Worker 想说什么。
 */
function stopReasonFailure(stopReason: string): string | null {
  switch (stopReason) {
    case 'completed': return null
    case 'aborted': return 'subagent 执行被取消（aborted）'
    case 'error': return 'subagent 执行失败（模型或传输层 error）'
    case 'max-tokens': return 'subagent 未完成即触达 token 上限（max-tokens）'
    case 'refusal': return 'subagent 拒绝了该任务（refusal）'
    default: return `subagent 以异常终止原因结束（${stopReason}）`
  }
}

/**
 * 薄封装：把一次 Worker 执行落到一个 one-shot subagent run 上。
 *
 * 失败一律收敛成 `executor-failure`，**从不抛异常给 Task Core**
 * —— 让状态机只面对两种确定结局（result / executor-failure），
 * 而不是异常与返回值两条并行的控制流。
 */
export class DshSubagentExecutor implements WorkerExecutor {
  readonly kind: string

  private readonly options: DshSubagentExecutorOptions

  constructor(options: DshSubagentExecutorOptions) {
    this.options = options
    this.kind = `dsh-subagent:${options.provider}`
  }

  async execute(task: TaskRow, context: WorkerContext): Promise<WorkerExecutionOutcome> {
    const { subagents, provider, parent, signal } = this.options

    if (subagents.getProvider(provider) === undefined) {
      const available = subagents.list()
      return {
        kind: 'executor-failure',
        sessionId: null,
        reason: `未注册 subagent provider "${provider}"`
          + `（当前可用：${available.length > 0 ? available.join(' / ') : '无'}）`,
      }
    }

    // 启动阶段失败没有 run，也就没有 session id 可记。
    let run: SubagentRunLike
    try {
      run = await subagents.start(provider, {
        label: `Worker: ${task.title}`.slice(0, 80),
        prompt: [{ type: 'text', text: buildWorkerPrompt(context) }],
        parent,
        signal,
        outputSchema: WORKER_OUTPUT_SCHEMA,
      })
    } catch (error: unknown) {
      return {
        kind: 'executor-failure',
        sessionId: null,
        reason: `subagent 启动失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }

    // 已发布的 run 必须 dispose 才能达到静默，即使结果路径抛错。
    const sessionId = run.id
    try {
      const result = await run.result
      const failure = stopReasonFailure(result.stopReason)
      if (failure !== null) return { kind: 'executor-failure', sessionId, reason: failure }

      const structured = parseStructuredResult(result.structured)
      if (structured === null) {
        return {
          kind: 'executor-failure',
          sessionId,
          reason: 'subagent 正常结束但未交回合法的结构化结果（outputSchema 未满足）',
        }
      }
      return { kind: 'result', result: structured, sessionId }
    } catch (error: unknown) {
      // run.result 只在 seam 无法表达的基础设施故障时 reject。
      return {
        kind: 'executor-failure',
        sessionId,
        reason: `subagent 运行异常：${error instanceof Error ? error.message : String(error)}`,
      }
    } finally {
      try {
        await run.dispose()
      } catch {
        // dispose 失败不改写已判定的执行结局；run 已经落定。
      }
    }
  }
}
