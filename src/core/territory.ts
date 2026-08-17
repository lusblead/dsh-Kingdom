/**
 * dsh-kingdom — Territory 基础 CRUD（Phase 1）。
 * Territory 是长期资源/上下文边界，非权限链节点（与 Role 无关）。
 * 状态仅 ACTIVE | ARCHIVED（简单两态，不实现复杂状态机）。
 */
import { randomUUID } from 'node:crypto'
import { KingdomStore, TerritoryRow } from './db.js'

export interface CreateTerritoryInput {
  kingdomId: string
  name: string
  workspacePath?: string
  summary?: string
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
