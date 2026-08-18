/**
 * dsh-kingdom — Territory 基础 CRUD（Phase 1）。
 * Territory 是长期资源/上下文边界，非权限链节点（与 Role 无关）。
 * 状态仅 ACTIVE | ARCHIVED（简单两态，不实现复杂状态机）。
 *
 * v0.5.1：新增删除（deleteTerritory）。治理语义（Owner 裁决 2026-08-18）：
 * - 领地下存在任务（任意状态）时**默认拒绝**删除；
 * - `force=true` 时级联：未终态任务（CREATED/ASSIGNED/RUNNING/REVIEW）经状态机
 *   统一标记 FAILED 并逐条留痕 `TASK_FAILED`（reason=领地级联删除），活跃 Execution
 *   一并 ABORTED；DONE/FAILED 是终态事实，不篡改；
 * - 无论哪种删除，`TERRITORY_DELETED` 事件必留痕（payload 含任务清单与原状态）。
 */
import { randomUUID } from 'node:crypto'
import { KingdomStore, TerritoryRow } from './db.js'
import { asExecutionState, isLiveExecutionState } from './execution.js'

export interface CreateTerritoryInput {
  kingdomId: string
  name: string
  workspacePath?: string
  summary?: string
}

export interface DeleteTerritoryInput {
  kingdomId: string
  /** 与 name 二选一；同时给出时 territoryId 优先。 */
  territoryId?: string
  name?: string
  /** true = 级联删除：领地下未终态任务统一标记 FAILED 并留痕。 */
  force?: boolean
  reason?: string
}

export function createTerritory(store: KingdomStore, input: CreateTerritoryInput): string {
  const name = input.name.trim()
  if (!name) return '错误：领地名称不能为空。'
  const existing = store.getTerritoryByName(input.kingdomId, name)
  if (existing) return `领地「${name}」已存在（id=${existing.territory_id}），未重复创建。`

  const now = new Date().toISOString()
  const territory = {
    territory_id: randomUUID(),
    kingdom_id: input.kingdomId,
    name,
    workspace_path: input.workspacePath?.trim() || null,
    summary: input.summary?.trim() || null,
    supervisor_binding_id: null,
    status: 'ACTIVE',
    created_at: now,
  }
  store.insertTerritory(territory)
  store.appendEvent({
    event_id: randomUUID(),
    kingdom_id: input.kingdomId,
    event_type: 'TERRITORY_CREATED',
    actor_role: null,
    actor_id: null,
    target_type: 'territory',
    target_id: territory.territory_id,
    payload_json: JSON.stringify({ name, workspace_path: territory.workspace_path }),
    created_at: now,
  })
  return `已创建领地「${name}」（id=${territory.territory_id}${territory.workspace_path ? `，工作区 ${territory.workspace_path}` : ''}）。`
}

export function listTerritories(store: KingdomStore, kingdomId: string): string {
  const rows: TerritoryRow[] = store.listTerritories(kingdomId)
  if (rows.length === 0) return '当前王国还没有领地。可创建第一个，例如“给当前项目建立一个 RAG 研发领”。'
  return rows
    .map((t: TerritoryRow) => `- ${t.name}（${t.status}${t.workspace_path ? `，${t.workspace_path}` : ''}${t.summary ? `，${t.summary}` : ''}）`)
    .join('\n')
}

/**
 * 删除领地（v0.5.1）。
 *
 * 治理语义（Owner 裁决 2026-08-18）：
 * - 无任务：直接删行 + `TERRITORY_DELETED` 留痕；
 * - 有任务且未 force：拒绝，返回 `错误：` 前缀（上层据此判定失败）；
 * - 有任务且 force：未终态任务经 `transitionTask` 统一标记 FAILED（逐条
 *   `TASK_FAILED` 事件，payload 携带原状态与级联原因），活跃 Execution 转 ABORTED，
 *   终态任务（DONE/FAILED）不篡改；随后删行 + `TERRITORY_DELETED` 留痕
 *   （payload 携带完整任务清单：task_id/title/原状态/最终状态）。
 */
export function deleteTerritory(store: KingdomStore, input: DeleteTerritoryInput): string {
  let territory = input.territoryId ? store.getTerritoryById(input.territoryId) : null
  if (territory && territory.kingdom_id !== input.kingdomId) territory = null // 越界 id 视同不存在
  if (!territory && input.name) territory = store.getTerritoryByName(input.kingdomId, input.name.trim())
  if (!territory) {
    const hint = input.territoryId ? `id=${input.territoryId}` : `name=${input.name}`
    return `错误：领地不存在（${hint}）。可先 /kingdom status 或 kingdom_list_territories 查看现有领地。`
  }

  const tasks = store.listTasks(input.kingdomId, { territoryId: territory.territory_id })
  const force = input.force === true
  if (tasks.length > 0 && !force) {
    return `错误：领地「${territory.name}」下还有 ${tasks.length} 个任务，不能删除。`
      + `如需级联删除（未终态任务将统一标记 FAILED、活跃执行终止、全部留痕），请传 force=true。`
  }

  const now = new Date().toISOString()
  const cascade: { task_id: string; title: string; original_status: string; final_status: string }[] = []
  let abortedExecutions = 0

  for (const task of tasks) {
    const original = task.status
    if (original === 'DONE' || original === 'FAILED') {
      // 终态事实不可篡改：原样保留，仅登记到 TERRITORY_DELETED 的清单里。
      cascade.push({ task_id: task.task_id, title: task.title, original_status: original, final_status: original })
      continue
    }
    const updated = store.transitionTask(task, 'FAILED')
    for (const execution of store.listExecutions(task.task_id)) {
      if (isLiveExecutionState(asExecutionState(execution.state))) {
        store.transitionExecution(execution, 'ABORTED', { detail: '领地删除级联终止' })
        abortedExecutions++
      }
    }
    store.appendEvent({
      event_id: randomUUID(),
      kingdom_id: input.kingdomId,
      event_type: 'TASK_FAILED',
      actor_role: null,
      actor_id: null,
      target_type: 'task',
      target_id: task.task_id,
      payload_json: JSON.stringify({
        reason: '领地级联删除',
        cascade_from_territory: territory.territory_id,
        territory_name: territory.name,
        original_status: original,
      }),
      created_at: now,
    })
    cascade.push({ task_id: task.task_id, title: task.title, original_status: original, final_status: updated.status })
  }

  store.deleteTerritoryRow(territory.territory_id)
  store.appendEvent({
    event_id: randomUUID(),
    kingdom_id: input.kingdomId,
    event_type: 'TERRITORY_DELETED',
    actor_role: null,
    actor_id: null,
    target_type: 'territory',
    target_id: territory.territory_id,
    payload_json: JSON.stringify({
      name: territory.name,
      workspace_path: territory.workspace_path,
      force,
      reason: input.reason ?? null,
      task_count: tasks.length,
      aborted_executions: abortedExecutions,
      tasks: cascade,
    }),
    created_at: now,
  })

  const changedCount = cascade.filter(t => t.original_status !== t.final_status).length
  const carriedCount = cascade.length - changedCount
  const cascadeNote = tasks.length > 0
    ? `领地内 ${tasks.length} 个任务已处理：${cascade.map(t => `${t.title}（${t.original_status}→${t.final_status}）`).join('、')}；`
      + `其中 ${changedCount} 个未终态任务标记 FAILED、${carriedCount} 个终态任务原样保留`
      + `${abortedExecutions > 0 ? `；终止 ${abortedExecutions} 条活跃执行` : ''}。`
    : ''
  return `已删除领地「${territory.name}」（id=${territory.territory_id}）。${cascadeNote}`
}
