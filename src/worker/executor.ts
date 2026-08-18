/**
 * dsh-kingdom — WorkerExecutor 接口（Phase 2，Owner 裁决 2）。
 *
 * 裁决 2 的形状：**Task Core 只依赖本接口，绝不直接 import subagents。**
 * 换执行方式（one-shot subagent → 别的 runtime）不碰状态机。
 * Worker ≠ Subagent Session：Worker 是组织角色（role_binding），
 * subagent execution 只是它这一轮的执行载体。
 *
 * 本文件**零 dsh 依赖**：只有类型和纯函数，因此 Task Core 与自测都不需要活的 DSH。
 */
import type { TaskRow } from '../core/db.js'

/**
 * Worker 交回的结构化结果（受 subagent outputSchema 约束）。
 *
 * **这是 Claim，不是 Fact。** outcome 是 Worker 的自述，
 * 不参与任何自动状态决策：即使 outcome === 'FAILED'，
 * Task 也只推到 REVIEW，等 Supervisor 裁定（裁决 6）。
 */
export interface StructuredResult {
  /** Worker 自称的结果。 */
  outcome: 'COMPLETED' | 'FAILED' | 'BLOCKED'
  /** 一段可供 Supervisor 审查的自述摘要。 */
  summary: string
  /** 产出物（文件路径 / 制品标识），可选。 */
  artifacts?: string[]
  /** Worker 自述的风险与遗留问题，可选。 */
  risks?: string[]
}

/** 传给 Worker 的这一轮上下文（裁决 5：REWORK 时带上一轮摘要 + 返工理由）。 */
export interface WorkerContext {
  /** 原始 Task。 */
  task: TaskRow
  /** 验收标准（Task 的 acceptance_criteria）。 */
  acceptanceCriteria: string | null
  /** 第几次尝试，从 1 起。 */
  attemptNo: number
  /** 上一轮 Worker Claim 的摘要（仅 REWORK 时存在）。 */
  prevResultSummary?: string
  /** Supervisor 的 REWORK 理由（仅 REWORK 时存在）。 */
  reworkReason?: string
}

/**
 * 一次 Worker 执行的结果，只有两种：
 *
 * - `result`：subagent 正常返回**合法结构化结果** → Task 推到 REVIEW（Claim 到达）。
 * - `executor-failure`：启动失败 / 异常退出 / 无合法 outputSchema 输出
 *   → Core 直接 RUNNING → FAILED（裁决 6：**宿主观察到的运行事实**，不是相信 Worker 自述）。
 *
 * 注意这两者的区别就是 Phase 2 的治理核心：Worker 说自己失败了是 Claim（走 REVIEW），
 * 宿主看见 executor 没跑出合法结果是 Fact（直接 FAILED）。
 *
 * v0.6.0（M1-C）：两种结局都携带 `resolvedModel`（DSH Runtime 解析后的有效模型；
 * in-process 可观察，remote/不可观察为 null——seam 无证据，不是"无模型"）。
 */
export type WorkerExecutionOutcome =
  | { kind: 'result'; result: StructuredResult; sessionId: string | null; resolvedModel?: string | null }
  | { kind: 'executor-failure'; reason: string; sessionId: string | null; resolvedModel?: string | null }

/**
 * v0.6.0（M1-C）：执行器解析信息（ExecutorFactory 的解析结果，随 executor 携带）。
 *
 * Core 不自己解析 provider/model——信息经本字段从执行器带到落库点。
 * `resolvedModel` 不在 info 里（执行后才知道），经 outcome 返回。
 */
export interface ExecutorInfo {
  /** 最终 subagent provider 名。 */
  provider: string
  /** 'binding' | 'global-fallback'。 */
  providerSource: 'binding' | 'global-fallback'
  /** profile.model ?? null（null=继承父 Agent）。 */
  requestedModel: string | null
  /** 'binding' | 'parent-inherited' | 'unknown'。 */
  modelSource: 'binding' | 'parent-inherited' | 'unknown'
}

/** 薄执行封装。Task Core 只认这一个接口。 */
export interface WorkerExecutor {
  /** 供事件/诊断使用的执行器标识（如 `dsh-subagent:spawn`）。 */
  readonly kind: string
  /** v0.6.0：执行解析信息（可选——fake/测试执行器可不提供，落库为 null）。 */
  readonly info?: ExecutorInfo
  execute(task: TaskRow, ctx: WorkerContext): Promise<WorkerExecutionOutcome>
}

/**
 * 约束 Worker 结构化输出的 JSON Schema。
 *
 * 必须落在 dsh 强制的 schema 子集内
 * （见 checkout `packages/core/tools/src/json-schema.ts`）：
 * - 根必须是 object（assertObjectJsonSchema）；
 * - `enum` 只允许挂在**已声明 scalar `type`** 的节点上
 *   —— 裸 `{ enum: [...] }` 会被判为 `.enum requires type or oneOf` 而拒绝，
 *   所以 outcome 显式写了 `type: 'string'`。
 */
export const WORKER_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['outcome', 'summary'],
  properties: {
    outcome: {
      type: 'string',
      enum: ['COMPLETED', 'FAILED', 'BLOCKED'],
      description: 'COMPLETED=你认为已完成；FAILED=你认为做不成；BLOCKED=被外部阻塞。这是你的声明，最终由 Supervisor 裁定。',
    },
    summary: {
      type: 'string',
      description: '给 Supervisor 审查用的自述摘要：做了什么、结果如何、是否满足验收标准。',
    },
    artifacts: {
      type: 'array',
      items: { type: 'string' },
      description: '产出物列表（文件路径或制品标识）。',
    },
    risks: {
      type: 'array',
      items: { type: 'string' },
      description: '风险与遗留问题。',
    },
  },
} as const

/** 未知值兜底为 BLOCKED 之前，先判定是否是合法 outcome。 */
function isOutcome(value: unknown): value is StructuredResult['outcome'] {
  return value === 'COMPLETED' || value === 'FAILED' || value === 'BLOCKED'
}

/** 只保留字符串项的数组；非数组返回 undefined。 */
function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((v): v is string => typeof v === 'string')
  return items.length > 0 ? items : undefined
}

/**
 * 把 subagent 交回的 `structured` 收敛成 StructuredResult。
 *
 * provider 已按 outputSchema 校验过，这里是**宿主侧的第二道防御**：
 * 形状不合法就返回 null，调用方据此判定 executor-failure（裁决 6）。
 * 不猜、不补默认值 —— 一个形状不对的 Claim 不是 Claim。
 */
export function parseStructuredResult(value: unknown): StructuredResult | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!isOutcome(record.outcome)) return null
  if (typeof record.summary !== 'string' || record.summary.trim().length === 0) return null
  const artifacts = stringArray(record.artifacts)
  const risks = stringArray(record.risks)
  return {
    outcome: record.outcome,
    summary: record.summary,
    ...artifacts ? { artifacts } : {},
    ...risks ? { risks } : {},
  }
}

/**
 * 构造这一轮 Worker 的 prompt。
 *
 * 裁决 5：REWORK 轮次必须注入「原 Task + Acceptance Criteria +
 * 上一轮 Result 摘要 + Supervisor REWORK reason」。
 * one-shot subagent 不继承父会话上下文，所以 prompt 必须自包含。
 */
export function buildWorkerPrompt(context: WorkerContext): string {
  const { task, acceptanceCriteria, attemptNo, prevResultSummary, reworkReason } = context
  const lines: string[] = [
    '你是本王国某个领地的 Worker，现在承接一个任务。请独立完成它，然后交回结构化结果。',
    '',
    `## 任务：${task.title}`,
  ]
  if (task.description) lines.push('', task.description)
  lines.push('', '## 验收标准', acceptanceCriteria?.trim() || '（未显式给出验收标准；请按任务描述的字面要求交付。）')

  if (attemptNo > 1) {
    lines.push(
      '',
      `## 这是第 ${attemptNo} 次尝试（返工）`,
      'Supervisor 审查了你上一轮的结果并要求返工。请针对返工理由改进，不要重复上一轮的问题。',
      '',
      '### 上一轮你提交的摘要',
      prevResultSummary?.trim() || '（上一轮无可用摘要。）',
      '',
      '### Supervisor 的返工理由',
      reworkReason?.trim() || '（未给出具体理由。）',
    )
  }

  lines.push(
    '',
    '## 交回要求',
    '按 outputSchema 交回 { outcome, summary, artifacts?, risks? }。',
    'outcome 是你的**自述**：COMPLETED / FAILED / BLOCKED。',
    '注意：你的结果是一个待审查的 Claim，不是任务完成的事实 —— 是否 DONE 由 Supervisor 裁定。',
    'summary 请写清楚你做了什么、是否满足每一条验收标准、以及你无法确认的地方。',
  )
  return lines.join('\n')
}
