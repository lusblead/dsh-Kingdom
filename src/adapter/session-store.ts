/**
 * dsh-kingdom — v0.8 Persistent Worker Session Store（M3-S3，§20）。
 *
 * Worker ≠ Session（M3-S0 冻结）：Session 是 Worker 当前绑定的 Runtime 实例。
 * - 无 current Session → createSession → 取真实 session_ref → establishAffinity（governed API）
 *   → 更新 role_binding current projection（session_id）；
 * - 已有 current Session → resume 同一 session_ref（REWORK 唤醒同一 Worker）；
 * - 跨 Territory：禁止 UPDATE affinity → retire 旧 Session → create 新 Session → 新 affinity
 *   （v6 affinity trigger 权威强制；本层只编排）。
 */
import type { KingdomStore } from '../core/db.js'
import {
  establishAffinity,
  retireAffinity,
  type SessionIdentity,
} from '../core/governed.js'
import type { RuntimeAdapter, SessionHandle } from './contract.js'

export interface EnsureWorkerSessionInput {
  kingdomId: string
  workerBindingId: string
  /** v0.8 Worker 模型：一 Worker 一 current Session，exactly one Territory affinity。 */
  territoryId: string
  /** Territory 工作区路径（DSH createSession 的 meta.cwd = workspaceRoot）。 */
  cwd: string
  agentPreset?: string
  provider?: string
  model?: string
}

export interface EnsureWorkerSessionResult {
  handle: SessionHandle
  /** true = 本轮新建 Session；false = resume 既有 current Session。 */
  created: boolean
  affinity: { affinityId: string; territoryId: string; sessionRef: string }
}

/** 建立/恢复 Worker 的长期 Session 并落受治理 affinity（§20）。 */
export async function ensureWorkerSession(
  store: KingdomStore,
  adapter: RuntimeAdapter,
  input: EnsureWorkerSessionInput,
): Promise<EnsureWorkerSessionResult> {
  const current = store.getCurrentAffinityForWorker(input.kingdomId, input.workerBindingId)
  if (current) {
    // v0.8（Owner V0.8 PRODUCTION-PATH CLOSURE B）：session 仍 live → 复用同一 live handle。
    // DSH 的 agents.resume 对 live session 抛 `cannot prepare ... while it is live`；
    // 禁止 live 时强行 resume、禁止因 resume 失败新建第二个 session（same session_ref / Worker / Territory）。
    const live = adapter.getLiveHandle(current.session_ref)
    if (live) {
      return {
        handle: live,
        created: false,
        affinity: { affinityId: current.affinity_id, territoryId: current.territory_id, sessionRef: current.session_ref },
      }
    }
    // session 不 live、但可恢复 → resume persistent session_ref
    const handle = await adapter.resumeSession({
      sessionRef: current.session_ref,
      provider: input.provider,
      model: input.model,
    })
    return {
      handle,
      created: false,
      affinity: { affinityId: current.affinity_id, territoryId: current.territory_id, sessionRef: current.session_ref },
    }
  }
  // 无 current Session → 创建 → 绑定 affinity → 更新 current projection
  const handle = await adapter.createSession({
    cwd: input.cwd,
    agentPreset: input.agentPreset,
    provider: input.provider,
    model: input.model,
  })
  const session: SessionIdentity = {
    runtimeType: adapter.runtimeType,
    runtimeInstanceRef: adapter.identify().runtimeInstanceRef,
    sessionRef: handle.refs.sessionRef,
  }
  const affinity = bindWorkerSession(store, {
    kingdomId: input.kingdomId,
    workerBindingId: input.workerBindingId,
    session,
    territoryId: input.territoryId,
  })
  return {
    handle,
    created: true,
    affinity: { affinityId: affinity.affinityId, territoryId: affinity.territoryId, sessionRef: session.sessionRef },
  }
}

/** 落 affinity Ledger + 更新 role_binding current projection（v3 模型）。 */
export function bindWorkerSession(
  store: KingdomStore,
  input: {
    kingdomId: string
    workerBindingId: string
    session: SessionIdentity
    territoryId: string
  },
): { affinityId: string; territoryId: string; sessionRef: string } {
  const affinity = establishAffinity(store, {
    kingdomId: input.kingdomId,
    workerBindingId: input.workerBindingId,
    session: input.session,
    territoryId: input.territoryId,
  })
  store.updateBindingProfile(input.workerBindingId, { sessionId: input.session.sessionRef }, new Date().toISOString())
  return { affinityId: affinity.affinity_id, territoryId: affinity.territory_id, sessionRef: input.session.sessionRef }
}

/**
 * 跨 Territory 迁移：retire 旧 Session（留历史证据）→ 返回后由调用方 create 新 Session 并绑定新 territory。
 * 禁止 UPDATE affinity（v6 trigger 权威强制；本层显式走 retire 路径）。
 */
export function retireWorkerSession(
  store: KingdomStore,
  input: { kingdomId: string; workerBindingId: string },
): void {
  const current = store.getCurrentAffinityForWorker(input.kingdomId, input.workerBindingId)
  if (!current) return
  retireAffinity(store, current.affinity_id)
  // current projection 清空（历史归属仍可查 affinity Ledger；Current Projection ≠ History）
  store.updateBindingProfile(input.workerBindingId, { sessionId: null }, new Date().toISOString())
}
