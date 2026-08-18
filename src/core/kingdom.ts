/**
 * dsh-kingdom — Kingdom 初始化/接入（幂等）。
 *
 * 语义（Owner 2026-08-17 裁决）：
 * - /kingdom init 幂等：首次建库 → 初始化；再次执行 → 接入（不覆盖、不重建）。
 * - Owner = 声明性本地身份：init 时生成稳定 owner_id(UUID) + owner_name(OS 用户名或显式名称)，
 *   仅作 Kingdom 内部稳定引用，不代表签名认证（TPM/Windows Hello/Principal/Owner Port 后置）。
 */
import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { KingdomStore, SCHEMA_VERSION } from './db.js'
import { kingdomDbPath } from '../paths.js'

export interface InitResult {
  action: 'initialized' | 'attached'
  kingdomId: string
  kingdomName: string
  ownerId: string
  ownerName: string
  territoryCount: number
  bindingCount: number
  detail: string
}

/** 当前 OS 用户名（显式名称缺失时的兜底）。 */
export function currentOsUser(): string {
  try {
    const info = userInfo()
    if (info && info.username && info.username.trim().length > 0) return info.username
  } catch {
    // 某些受限环境拿不到 userInfo，回退
  }
  return 'owner'
}

export interface KingdomManagerOptions {
  /** 显式 kingdom 名称；缺省 "My Kingdom" */
  kingdomName?: string
  /** 显式 owner 名称；缺省取 OS 用户名 */
  ownerName?: string
  dbPath?: string
}

export class KingdomManager {
  private readonly store: KingdomStore
  private readonly opts: Required<Pick<KingdomManagerOptions, 'kingdomName' | 'ownerName'>> & {
    dbPath: string
  }

  constructor(options: KingdomManagerOptions = {}) {
    this.opts = {
      kingdomName: options.kingdomName ?? 'My Kingdom',
      ownerName: options.ownerName ?? currentOsUser(),
      dbPath: options.dbPath ?? kingdomDbPath(),
    }
    this.store = new KingdomStore(this.opts.dbPath)
  }

  get storeHandle(): KingdomStore {
    return this.store
  }

  /**
   * init：扫描本机 → 无 kingdom.db 则初始化，有则接入。
   * 幂等：重复调用只接入，绝不覆盖既有数据。
   */
  init(): InitResult {
    const kingdom = this.store.getDefaultKingdom()

    if (!kingdom) {
      // ── 初始化路径 ──
      const now = new Date().toISOString()
      const kingdomId = randomUUID()
      const ownerId = randomUUID()
      const created: KingdomRowInput = {
        kingdom_id: kingdomId,
        name: this.opts.kingdomName,
        created_at: now,
        owner_id: ownerId,
        owner_name: this.opts.ownerName,
        schema_version: SCHEMA_VERSION,
      }
      this.store.insertKingdom(created)
      // Owner binding：principal_id = ownerId（Kingdom 内部稳定引用）
      this.store.insertBinding({
        binding_id: randomUUID(),
        kingdom_id: kingdomId,
        role_type: 'OWNER',
        role_name: `Owner-${this.opts.ownerName}`,
        runtime_type: 'dsh',
        session_id: null,
        model_name: null,
        agent_name: null,
        session_meta: null,
        execution_profile_json: null,
        status: 'ACTIVE',
        retired_at: null,
        retired_reason: null,
        principal_id: ownerId,
        created_at: now,
        updated_at: now,
      })
      this.store.appendEvent({
        event_id: randomUUID(),
        kingdom_id: kingdomId,
        event_type: 'KINGDOM_CREATED',
        actor_role: 'OWNER',
        actor_id: ownerId,
        target_type: 'kingdom',
        target_id: kingdomId,
        payload_json: JSON.stringify({ name: this.opts.kingdomName, owner: this.opts.ownerName }),
        created_at: now,
      })
      const result: InitResult = {
        action: 'initialized',
        kingdomId,
        kingdomName: this.opts.kingdomName,
        ownerId,
        ownerName: this.opts.ownerName,
        territoryCount: 0,
        bindingCount: 1,
        detail: `已初始化王国「${this.opts.kingdomName}」，Owner = ${this.opts.ownerName}（id=${ownerId}）。`,
      }
      return result
    }

    // ── 接入路径（王国已存在）──
    const territories = this.store.listTerritories(kingdom.kingdom_id)
    const bindings = this.store.listBindings(kingdom.kingdom_id)
    return {
      action: 'attached',
      kingdomId: kingdom.kingdom_id,
      kingdomName: kingdom.name,
      ownerId: kingdom.owner_id,
      ownerName: kingdom.owner_name,
      territoryCount: territories.length,
      bindingCount: bindings.length,
      detail:
        `已接入现有王国「${kingdom.name}」（id=${kingdom.kingdom_id}），` +
        `Owner = ${kingdom.owner_name}，${territories.length} 个领地，${bindings.length} 个角色绑定。`,
    }
  }

  /** 重新扫描接入（不删除任何数据）。 */
  rescan(): InitResult {
    return this.init()
  }

  close(): void {
    this.store.close()
  }
}

interface KingdomRowInput {
  kingdom_id: string
  name: string
  created_at: string
  owner_id: string
  owner_name: string
  schema_version: number
}
