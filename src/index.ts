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
import z from '@deepseek-ai/schemastery'
import { KingdomManager } from './core/kingdom.js'
import { bindRole, listBindings, rebindSession, unbindRole } from './core/binding.js'
import { createTerritory, listTerritories } from './core/territory.js'
import {
  abortExecution,
  assignTask,
  listTasks,
  pauseExecution,
  planTask,
  reclaimOrphanExecutions,
  resumeExecution,
  reviewTask,
  startTask,
  type CommandContext,
  type Principal,
} from './core/task-service.js'
import { buildSnapshot, buildTaskDetail, toEventView } from './gui/snapshot.js'
import { startGuiServer } from './gui/server.js'
import type { AuthView, CommandResultView } from './gui/contract.js'
import { DshSubagentExecutor, type SubagentsLike } from './worker/dsh-subagent.js'
import type { CommandResult } from '@deepseek-ai/dsh-commands'

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

  /**
   * v0.4：从工具执行上下文提取「调用方会话」注入 principal。
   * 配合 `authMode: session-bound`（requireRole 校验 principal.sessionId 与
   * binding.session_id 一致），让角色真正属于某个独立会话可被强制校验；
   * declarative 模式下 principal 仅是告知属性，不影响放行。
   */
  const sessionPrincipal = (exec: { agent?: { session?: { id?: string } } | null }): Principal | undefined => {
    const id = exec?.agent?.session?.id
    return typeof id === 'string' && id.length > 0 ? { sessionId: id } : undefined
  }

  // ── init 引导（首次初始化后给出组织方式；重点：角色应绑到独立会话，勿默认代跑）──
  // 地址语义（问题修复 v0.4.1）：
  //   · 后端数据网关 = 本插件 HTTP 通道（如 http://127.0.0.1:<guiPort>）——
  //     这是**填进前端页面连接框的地址**，不是要打开的页面。
  //   · 前端页面 = GUI 前端（vite dev http://localhost:5173，或部署站点）——
  //     由 GUI 部署方提供，插件不硬编码也不冒充。
  const gatewayUrl = config.guiPort > 0 ? `http://127.0.0.1:${config.guiPort}` : '（未开启，可配置 guiPort 后获得）'
  const guiLine = `后端数据网关：${gatewayUrl} —— 把它填入 GUI 前端的连接框；前端页面地址由 GUI 部署方提供（本地开发如 vite，或已部署站点），不要把网关地址当页面打开`
  const initGuidance = '\n\n接下来把王国组织起来。**重要：不要把全部角色默认安在当前会话身上——角色应绑定到各自的独立会话**：\n'
    + `① 绑定角色到独立会话（推荐）：用 kingdom_bind_session 为 CHANCELLOR / SUPERVISOR / WORKER 分别绑定具名 dsh 会话（可顺带填 model_name / agent_name）；`
    + `配 authMode=session-bound 后，只有被绑定的那个会话才能行使该角色职权。\n`
    + '② 快速演示（不推荐长期用）：会话纯文字逐步创建 —— 由当前会话代行各角色（角色席位 sessionId 为空，属本地演示兜底）。\n'
    + `GUI（可选）：${guiLine}`
  /** 首次初始化返回带引导文案；再次接入保持简洁。 */
  const initResultText = (result: ReturnType<typeof manager.init>): string =>
    result.action === 'initialized' ? `${result.detail}${initGuidance}` : result.detail

  // ── 加载期回收：清掉上一个插件生命周期留下的孤儿 Execution ──────
  //
  // Worker 是 one-shot in-process subagent，生命周期绑在插件 fiber 上，
  // 不可能跨越重载存活。所以开库时看到的"活跃"执行必然是残骸。
  // 不回收的话，GUI 会看到骑士永远在工作，且该任务再也无法重新 start。
  {
    const kingdomId = requireKingdom()
    if (kingdomId) {
      const reclaimed = reclaimOrphanExecutions(store, kingdomId)
      if (reclaimed > 0) {
        ctx.logger.info(`dsh-kingdom：已回收 ${reclaimed} 个上次运行残留的 Execution（标记为 ABORTED）`)
      }
    }
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
      return initResultText(result)
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
    description: '绑定一个角色（OWNER/CHANCELLOR/SUPERVISOR/WORKER）到 DSH 会话，Role 与 Session 解耦；可携带会话身份预留字段（模型名/agent 名/扩展元数据，可不填）',
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
    }) {
      const kingdomId = requireKingdom()
      if (!kingdomId) return '尚未初始化王国。请先 /kingdom init。'
      return bindRole(store, {
        kingdomId,
        roleType: args.role_type,
        roleName: args.role_name,
        sessionId: args.session_id,
        modelName: args.model_name,
        agentName: args.agent_name,
        sessionMeta: args.session_meta,
      })
    },
  })), 'dsh-kingdom: bind-role tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'kingdom_unbind_role',
    description: '解绑一个角色（换届通道）：按 role_type 或 binding_id 移除绑定。OWNER 受保护不可解绑。解绑后该角色空缺，可重新绑定',
    parameters: {
      role_type: { type: 'string', description: '角色：CHANCELLOR/SUPERVISOR/WORKER（与 binding_id 二选一）' },
      binding_id: { type: 'string', description: '绑定 id（与 role_type 二选一）' },
      reason: { type: 'string', description: '换届原因（会记入事件，可追溯）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { role_type?: string; binding_id?: string; reason?: string }) {
      const kingdomId = requireKingdom()
      if (!kingdomId) return '尚未初始化王国。请先 /kingdom init。'
      return unbindRole(store, {
        kingdomId,
        roleType: args.role_type,
        bindingId: args.binding_id,
        reason: args.reason,
      })
    },
  })), 'dsh-kingdom: unbind-role tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'kingdom_bind_session',
    description: '把角色绑定到（或改绑到）某个独立 DSH 会话，并更新会话身份预留字段（模型名/agent 名/扩展元数据）。null 清空、缺省不变。配合 authMode=session-bound 时按调用方会话校验身份',
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
    }) {
      const kingdomId = requireKingdom()
      if (!kingdomId) return '尚未初始化王国。请先 /kingdom init。'
      return rebindSession(store, {
        kingdomId,
        roleType: args.role_type,
        bindingId: args.binding_id,
        sessionId: args.session_id === undefined ? undefined : args.session_id,
        modelName: args.model_name === undefined ? undefined : args.model_name,
        agentName: args.agent_name === undefined ? undefined : args.agent_name,
        sessionMeta: args.session_meta === undefined ? undefined : args.session_meta,
      })
    },
  })), 'dsh-kingdom: bind-session tool')

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
    }, exec: { agent?: { session?: { id?: string } } | null }) {
      const kingdomId = requireKingdom()
      if (!kingdomId) return '尚未初始化王国。请先 /kingdom init。'
      return planTask(store, commandContext(kingdomId, sessionPrincipal(exec)), {
        title: args.title,
        description: args.description,
        acceptanceCriteria: args.acceptance_criteria,
        territoryId: args.territory_id,
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
      return assignTask(store, commandContext(kingdomId, sessionPrincipal(exec)), {
        taskId: args.task_id,
        workerBindingId: args.worker_binding_id,
      }).message
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
      const result = await startTask(store, executor, commandContext(kingdomId, sessionPrincipal(exec)), { taskId: args.task_id })
      return result.message
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
    async execute(args: { task_id: string; decision: string; reason?: string }, exec: { agent?: { session?: { id?: string } } | null }) {
      const kingdomId = requireKingdom()
      if (!kingdomId) return '尚未初始化王国。请先 /kingdom init。'
      return reviewTask(store, commandContext(kingdomId, sessionPrincipal(exec)), {
        taskId: args.task_id,
        decision: args.decision,
        reason: args.reason,
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
      const cmd = commandContext(kingdomId, sessionPrincipal(exec))
      switch (args.action.trim().toLowerCase()) {
        case 'pause': return pauseExecution(store, cmd, input).message
        case 'resume': return resumeExecution(store, cmd, input).message
        case 'abort': return abortExecution(store, cmd, input).message
        default: return `错误：action 必须是 pause / resume / abort 之一，收到 "${args.action}"。`
      }
    },
  })), 'dsh-kingdom: execution-control tool')

  // ── 本地 GUI 通道（默认关闭；配置 guiPort 后启用）────────────────

  if (config.guiPort > 0) {
    ctx.effect(() => startGuiServer({
      snapshot: () => buildSnapshot(store, { auth: authView }),
      taskDetail: (taskId) => {
        const kingdomId = requireKingdom()
        return kingdomId ? buildTaskDetail(store, kingdomId, taskId) : null
      },
      eventsSince: (afterSeq, limit) => {
        const kingdomId = requireKingdom()
        if (!kingdomId) return { revision: 0, events: [] }
        return {
          revision: store.revision(kingdomId),
          events: store.listEventsSince(kingdomId, afterSeq, limit).map(toEventView),
        }
      },
      command: (name, payload) => runGuiCommand(name, payload),
    }, {
      port: config.guiPort,
      ...config.guiToken ? { token: config.guiToken } : {},
      allowOrigins: config.guiAllowOrigins,
      logger: ctx.logger,
    }), 'dsh-kingdom: GUI channel')
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

  /** GUI 写命令的分发。GUI 仍然经插件执行命令，绝不直接写 SQLite。 */
  async function runGuiCommand(name: string, payload: Record<string, unknown>): Promise<CommandResultView> {
    const kingdomId = requireKingdom()
    if (!kingdomId) {
      return guiFailure('KINGDOM_NOT_INITIALIZED', '尚未初始化王国。请先 /kingdom init。')
    }
    const str = (key: string): string => typeof payload[key] === 'string' ? payload[key] : ''
    const opt = (key: string): string | undefined => typeof payload[key] === 'string' ? payload[key] : undefined
    const principal: Principal | undefined = typeof payload.session_id === 'string'
      ? { sessionId: payload.session_id }
      : undefined
    const cmd = commandContext(kingdomId, principal)

    switch (name) {
      case 'plan':
        return planTask(store, cmd, {
          title: str('title'),
          description: opt('description'),
          acceptanceCriteria: opt('acceptance_criteria'),
          territoryId: opt('territory_id'),
        })
      case 'assign':
        return assignTask(store, cmd, { taskId: str('task_id'), workerBindingId: opt('worker_binding_id') })
      case 'review':
        return reviewTask(store, cmd, {
          taskId: str('task_id'),
          decision: str('decision'),
          reason: opt('reason'),
        })
      case 'execution.pause':
        return pauseExecution(store, cmd, { executionId: str('execution_id'), reason: opt('reason') })
      case 'execution.resume':
        return resumeExecution(store, cmd, { executionId: str('execution_id'), reason: opt('reason') })
      case 'execution.abort':
        return abortExecution(store, cmd, { executionId: str('execution_id'), reason: opt('reason') })
      case 'start':
        // 诚实的 Beta 边界：启动 Worker 需要一个**活的委派父 Agent**
        // （in-process provider 从它派生 workspace / 血缘 / 委派深度）。
        // HTTP 请求没有 Agent 上下文，所以这条命令只能从 DSH 会话里
        // 经 kingdom_start_task 触发。这里明确报错，而不是伪造一次执行。
        return guiFailure('EXECUTOR_UNAVAILABLE',
          'kingdom_start_task 需要由 DSH 会话中的 Agent 触发（Worker subagent 需要委派父 Agent）。'
          + 'GUI 请引导用户在 DSH 会话中说“开始执行这个任务”，或调用 kingdom_start_task 工具。')
      default:
        return guiFailure('INVALID_INPUT', `未知命令 "${name}"。`)
    }
  }

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
          return { kind: 'success', text: initResultText(result) }
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
              'dsh-Kingdom v0.4（换届 + 会话归属）',
              '/kingdom init    初始化或接入本地王国（幂等；首次初始化后会给出创建方式二选一）',
              '/kingdom status  查看王国真实状态',
              '/kingdom reset   重新扫描接入（不删除数据）',
              '组织王国：先为角色绑定独立会话（kingdom_bind_session），不要默认由当前会话代跑全部角色',
              '换届与归属：kingdom_unbind_role 解绑；kingdom_bind_session 绑定/更换角色会话（含 model/agent 预留字段）',
              'GUI：前端页面由 GUI 部署方提供；后端网关 http://127.0.0.1:<guiPort> 填入前端连接框（默认关闭，配置 guiPort 开启）',
              '也可用自然语言：初始化王国 / 创建领地 / 绑定角色 / 规划任务 / 派发任务 / 审查结果',
              '',
              '任务闭环：plan → assign → start（Worker 执行）→ review（ACCEPT/REWORK/FAIL）',
              'Worker 交回的结果只是待审查的 Claim（任务进入 REVIEW），',
              '只有 Supervisor 的 ACCEPT 才能让任务成为 DONE。',
              '',
              'GUI：kingdom_snapshot / kingdom_task_detail 返回结构化 JSON；',
              '配置 guiPort 可开本地 HTTP 通道（默认关闭，只绑 127.0.0.1）。',
            ].join('\n'),
          }
        default:
          return { kind: 'error', text: `未知子命令 "${sub}"。可用：init / status / reset / help` }
      }
    },
  }), 'dsh-kingdom: /kingdom command')
}
