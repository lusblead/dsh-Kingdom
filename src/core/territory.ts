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
import { requireAdmin, type AdminAuth } from './binding.js'

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

export function createTerritory(store: KingdomStore, input: CreateTerritoryInput, auth?: AdminAuth): string {
  const admin = requireAdmin(store, input.kingdomId, auth)
  if (!admin.ok) return admin.message
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
    deleted_at: null,
    deleted_reason: null,
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
 * v0.7.0（M2）：设置 Territory 主理 Supervisor（Topology Administration Plane）。
 * - session-bound 下仅真实 OWNER 可执行（requireAdmin）；
 * - supervisorBindingId=null → 未指派 → fail-closed（TERRITORY_SUPERVISOR_MISSING，无 Supervisor 可治理）；
 * - 指派必须是当前王国的 ACTIVE SUPERVISOR 绑定。
 */
export function setTerritorySupervisor(
  store: KingdomStore,
  input: { kingdomId: string; territoryId: string; supervisorBindingId: string | null },
  auth?: AdminAuth,
): string {
  const admin = requireAdmin(store, input.kingdomId, auth)
  if (!admin.ok) return admin.message
  const territory = store.getTerritoryById(input.territoryId)
  if (!territory || territory.kingdom_id !== input.kingdomId) {
    return `错误：领地不存在（id=${input.territoryId}）。`
  }
  if (territory.status === 'DELETED') {
    return `错误：领地「${territory.name}」已删除（tombstone），不能修改主理。`
  }
  if (input.supervisorBindingId !== null) {
    const supervisor = store.getBindingById(input.supervisorBindingId)
    if (!supervisor || supervisor.kingdom_id !== input.kingdomId) {
      return `错误：找不到当前王国的绑定 ${input.supervisorBindingId}。`
    }
    if (supervisor.role_type !== 'SUPERVISOR' || supervisor.status !== 'ACTIVE') {
      return `错误：绑定 ${supervisor.role_name} 不是 ACTIVE 的 SUPERVISOR，不能作为领地主理。`
    }
  }
  store.updateTerritorySupervisor(territory.territory_id, input.supervisorBindingId)
  store.appendEvent({
    event_id: randomUUID(),
    kingdom_id: input.kingdomId,
    event_type: 'TERRITORY_SUPERVISOR_UPDATED',
    actor_role: admin.owner ? 'OWNER' : null,
    actor_id: admin.owner?.binding_id ?? null,
    target_type: 'territory',
    target_id: territory.territory_id,
    payload_json: JSON.stringify({
      name: territory.name,
      supervisor_binding_id: input.supervisorBindingId,
      unassigned: input.supervisorBindingId === null,
    }),
    created_at: new Date().toISOString(),
  })
  return input.supervisorBindingId === null
    ? `领地「${territory.name}」已解除主理（未指派 Supervisor → fail-closed：无 Supervisor 可治理该领地）。`
    : `领地「${territory.name}」主理 Supervisor 已设为 ${store.getBindingById(input.supervisorBindingId)!.role_name}。`
}

/**
 * 删除领地（v0.5.1 语义 + v0.7.0 tombstone + Admin Plane）。
 *
 * 治理语义（Owner 裁决 2026-08-18 + M2 修订）：
 * - 删除 = **tombstone**（status→DELETED，不物理删行，历史任务归属永远可解析）；
 * - session-bound 下仅真实 OWNER 可执行（Topology Administration Plane）；
 * - 有任务且未 force：拒绝；有任务且 force：未终态任务统一标记 FAILED、
 *   活跃 Execution ABORTED、终态不篡改；`TERRITORY_DELETED` 留痕（payload 含任务清单）。
 */
export function deleteTerritory(store: KingdomStore, input: DeleteTerritoryInput, auth?: AdminAuth): string {
  const admin = requireAdmin(store, input.kingdomId, auth)
  if (!admin.ok) return admin.message
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

  store.tombstoneTerritoryRow(territory.territory_id, input.reason ?? null)
  store.appendEvent({
    event_id: randomUUID(),
    kingdom_id: input.kingdomId,
    event_type: 'TERRITORY_DELETED',
    actor_role: admin.owner ? 'OWNER' : null,
    actor_id: admin.owner?.binding_id ?? null,
    target_type: 'territory',
    target_id: territory.territory_id,
    payload_json: JSON.stringify({
      name: territory.name,
      workspace_path: territory.workspace_path,
      force,
      reason: input.reason ?? null,
      status: 'DELETED',
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
