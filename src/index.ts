/**
 * @dsh-external/dsh-kingdom — 独立 dsh 插件：会话内初始化/接入本地王国。
 *
 * 规范：
 * - 资源注册必须挂 ctx.effect（热重载/卸载自动清理）。
 * - 工具 schema 精简：description 短句点明用途，详解放 tool result。
 *
 * Phase 1 能力：
 * - /kingdom init（幂等：无则初始化，有则接入）
 * - /kingdom status（真实状态）
 * - 工具：kingdom_status / kingdom_create_territory / kingdom_list_territories /
 *   kingdom_bind_role / kingdom_list_bindings
 *
 * Phase 2 能力（Worker Claim Bridge → 治理闭环）：
 * - 工具：kingdom_plan_task / kingdom_assign_task / kingdom_start_task /
 *   kingdom_review_task / kingdom_list_tasks
 * - Worker 经 one-shot subagent 执行（裁决 2），结果落 worker_results（裁决 4）。
 *
 * 治理底线（Phase 1 保持 + Phase 2 强化）：
 * - **无任何工具能把 Task 直接标 DONE**：DONE 唯一入口是 REVIEW + Supervisor ACCEPT。
 * - Worker 的结果只是 Claim（→ REVIEW），不是 Fact。
 * - 无任意 SQL 通道暴露给 Agent。
 */
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'
import { KingdomManager } from './core/kingdom.js'
import { bindRole, listBindings } from './core/binding.js'
import { createTerritory, listTerritories } from './core/territory.js'
import { assignTask, listTasks, planTask, reviewTask, startTask } from './core/task-service.js'
import { DshSubagentExecutor, type SubagentsLike } from './worker/dsh-subagent.js'
import type { CommandResult } from '@deepseek-ai/dsh-commands'

export const name = '@dsh-external/dsh-kingdom'
export const inject = ['tools', 'commands']

export interface Config {
  kingdomName: string
  ownerName: string
  workerProvider: string
}

export const Config = z.object({
  kingdomName: z.string().default('My Kingdom'),
  ownerName: z.string().default(''),
  /** Worker 执行用的 subagent provider（dsh base bundle 默认注册 spawn / fork）。 */
  workerProvider: z.string().default('spawn'),
})

export function apply(ctx: Context, config: Config): void {
  // 单一王国管理器（自包含 SQLite；KingdomStore 连接生命周期 = 插件生命周期）
  const manager = new KingdomManager({
    kingdomName: config.kingdomName,
    ownerName: config.ownerName || undefined,
  })
  // 卸载/重载时关闭 SQLite 连接（disposer 由 fiber 自动收集执行）
  ctx.effect(() => () => manager.close())
  const store = manager.storeHandle

  const requireKingdom = (): string | null => {
    const kingdom = store.getDefaultKingdom()
    return kingdom ? kingdom.kingdom_id : null
  }

  // ── 工具注册（全部挂 ctx.effect）────────────────────────────

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'kingdom_init',
    description: '初始化或接入本地王国（幂等：无则新建 kingdom.db，有则接入）',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      const result = manager.init()
      return result.detail
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
    description: '在当前王国创建一个领地（Territory），绑定工作区路径',
    parameters: {
      name: { type: 'string', required: true, description: '领地名，如 RAG 研发领' },
      workspace_path: { type: 'string', description: '工作区绝对路径，默认当前目录' },
      summary: { type: 'string', description: '领地一句话使命（可选）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { name: string; workspace_path?: string; summary?: string }) {
      const kingdomId = requireKingdom()
      if (!kingdomId) return '尚未初始化王国。请先 /kingdom init 或说“初始化王国”。'
      return createTerritory(store, {
        kingdomId,
        name: args.name,
        workspacePath: args.workspace_path,
        summary: args.summary,
      })
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
    name: 'kingdom_bind_role',
    description: '绑定一个角色（OWNER/CHANCELLOR/SUPERVISOR/WORKER）到 DSH 会话，Role 与 Session 解耦',
    parameters: {
      role_type: { type: 'string', required: true, description: '角色：OWNER/CHANCELLOR/SUPERVISOR/WORKER' },
      role_name: { type: 'string', description: '角色名，如 Worker-01' },
      session_id: { type: 'string', description: '绑定的 dsh session id（可选）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { role_type: string; role_name?: string; session_id?: string }) {
      const kingdomId = requireKingdom()
      if (!kingdomId) return '尚未初始化王国。请先 /kingdom init。'
      return bindRole(store, {
        kingdomId,
        roleType: args.role_type,
        roleName: args.role_name,
        sessionId: args.session_id,
      })
    },
  })), 'dsh-kingdom: bind-role tool')

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
    }) {
      const kingdomId = requireKingdom()
      if (!kingdomId) return '尚未初始化王国。请先 /kingdom init。'
      return planTask(store, {
        kingdomId,
        title: args.title,
        description: args.description,
        acceptanceCriteria: args.acceptance_criteria,
        territoryId: args.territory_id,
      }).text
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
    async execute(args: { task_id: string; worker_binding_id?: string }) {
      const kingdomId = requireKingdom()
      if (!kingdomId) return '尚未初始化王国。请先 /kingdom init。'
      return assignTask(store, {
        kingdomId,
        taskId: args.task_id,
        workerBindingId: args.worker_binding_id,
      }).text
    },
  })), 'dsh-kingdom: assign-task tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'kingdom_start_task',
    description: '触发 Worker 执行任务并等待其结果（Supervisor 职权）。结果只会让任务进入 REVIEW，不会直接完成任务',
    parameters: {
      task_id: { type: 'string', required: true, description: '任务 id（状态需为 ASSIGNED，或 REWORK 后的 RUNNING）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { task_id: string }, exec) {
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

      const executor = new DshSubagentExecutor({
        subagents,
        provider: config.workerProvider || 'spawn',
        parent: exec.agent,
        signal: exec.signal,
      })
      const result = await startTask(store, executor, { kingdomId, taskId: args.task_id })
      return result.text
    },
  })), 'dsh-kingdom: start-task tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'kingdom_review_task',
    description: '审查 Worker 提交的结果并裁定 ACCEPT/REWORK/FAIL（Supervisor 职权）。这是任务能变成 DONE 的唯一路径',
    parameters: {
      task_id: { type: 'string', required: true, description: '任务 id（状态需为 REVIEW）' },
      decision: { type: 'string', required: true, description: 'ACCEPT（接受→DONE）/ REWORK（返工→RUNNING）/ FAIL（判失败→FAILED）' },
      reason: { type: 'string', description: '裁定理由；REWORK 与 FAIL 必填' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { task_id: string; decision: string; reason?: string }) {
      const kingdomId = requireKingdom()
      if (!kingdomId) return '尚未初始化王国。请先 /kingdom init。'
      return reviewTask(store, {
        kingdomId,
        taskId: args.task_id,
        decision: args.decision,
        reason: args.reason,
      }).text
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
      return listTasks(store, {
        kingdomId,
        territoryId: args.territory_id,
        status: args.status,
      })
    },
  })), 'dsh-kingdom: list-tasks tool')

  // ── Slash 命令（确定性管理入口）──────────────────────────────

  ctx.effect(() => ctx.commands.register({
    name: 'kingdom',
    description: '初始化/接入本地王国，查看王国状态',
    input: { hint: 'init | status | reset | help' },
    handler: async (invocation): Promise<CommandResult> => {
      const line = invocation.rawInput.trim()
      const [sub] = line.split(/[\s]+/u).filter(Boolean)
      switch (sub ?? '') {
        case 'init': {
          const result = manager.init()
          return { kind: 'success', text: result.detail }
        }
        case 'status': {
          return { kind: 'success', text: store.statusSummary() }
        }
        case 'reset': {
          const result = manager.rescan()
          return { kind: 'success', text: `已重新接入。${result.detail}` }
        }
        case 'help':
        case '':
          return {
            kind: 'success',
            text: [
              'dsh-Kingdom v0.2（Phase 2：Worker Claim Bridge）',
              '/kingdom init    初始化或接入本地王国（幂等）',
              '/kingdom status  查看王国真实状态',
              '/kingdom reset   重新扫描接入（不删除数据）',
              '也可用自然语言：初始化王国 / 创建领地 / 绑定角色 / 规划任务 / 派发任务 / 审查结果',
              '',
              '任务闭环：plan → assign → start（Worker 执行）→ review（ACCEPT/REWORK/FAIL）',
              'Worker 交回的结果只是待审查的 Claim（任务进入 REVIEW），',
              '只有 Supervisor 的 ACCEPT 才能让任务成为 DONE。',
            ].join('\n'),
          }
        default:
          return { kind: 'error', text: `未知子命令 "${sub}"。可用：init / status / reset / help` }
      }
    },
  }), 'dsh-kingdom: /kingdom command')
}
