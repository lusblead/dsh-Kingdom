import type { DisclosureCostMeta } from '../runtime-cost-observer.js'

export const DISCOVERY_TOOL_NAME = 'kingdom_find_tools'
export interface ToolDisclosureConfig {
  mode: 'off' | 'pilot'
  residentTools?: string[]
  phaseTools?: string[]
  maxResults?: number
  maxResultBytes?: number
}
interface Schema { name: string; description: string; parameters: unknown }
interface Assembly { tools: Schema[]; [key: string]: unknown }
interface Scope {
  tools?: { schemas?(): unknown; get?(name: string): unknown }
  on?(event: string, callback: (...args: any[]) => any): () => void
}
interface Agent { ctx: Scope }
interface State {
  active: boolean
  allowed: Set<string>
  discovered: Set<string>
  catalogStamp: string
  identities: Map<string, unknown>
  fallback: string | null
  dispose(): void
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const toolName = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value)

/** Display policy only. The existing Capability Gate remains authoritative for calls. */
export class ToolDisclosureRuntime {
  readonly config: Readonly<Required<ToolDisclosureConfig>>
  private readonly states = new WeakMap<object, State>()
  private readonly active = new Set<State>()
  private readonly observations = new WeakMap<object, DisclosureCostMeta>()

  constructor(config: ToolDisclosureConfig) {
    if (!config || !['off', 'pilot'].includes(config.mode)) throw new Error('Invalid tool disclosure mode')
    const residentTools = [...new Set(config.residentTools ?? [])], phaseTools = [...new Set(config.phaseTools ?? [])]
    const maxResults = config.maxResults ?? 3, maxResultBytes = config.maxResultBytes ?? 12000
    if (residentTools.length > 64 || phaseTools.length > 64 || ![...residentTools, ...phaseTools].every(toolName)
      || !Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 5
      || !Number.isSafeInteger(maxResultBytes) || maxResultBytes < 1024 || maxResultBytes > 64000) throw new Error('Invalid tool disclosure bounds')
    this.config = Object.freeze({ mode: config.mode, residentTools, phaseTools, maxResults, maxResultBytes })
  }

  metadata(assembly: object): DisclosureCostMeta | undefined { return this.observations.get(assembly) }

  private catalog(agent: Agent, state: State): Schema[] {
    const raw = agent.ctx.tools!.schemas!()
    if (!Array.isArray(raw)) throw new Error('TOOL_CATALOG_UNAVAILABLE')
    const result: Schema[] = [], names = new Set<string>(), identities = new Map<string, unknown>()
    for (const entry of raw) {
      if (!object(entry) || !toolName(entry.name) || !state.allowed.has(entry.name)) continue
      if (names.has(entry.name) || typeof entry.description !== 'string' || !object(entry.parameters)) throw new Error('TOOL_CATALOG_AMBIGUOUS')
      const definition = agent.ctx.tools!.get!(entry.name)
      if (!definition) continue
      names.add(entry.name); identities.set(entry.name, definition)
      result.push({ name: entry.name, description: entry.description, parameters: structuredClone(entry.parameters) })
    }
    const stamp = JSON.stringify(result)
    if (state.catalogStamp !== stamp || [...identities].some(([name, definition]) => state.identities.get(name) !== definition)) {
      state.discovered.clear(); state.catalogStamp = stamp; state.identities = identities
      state.fallback = null
    }
    return result
  }

  install(agent: Agent, allowedTools: readonly string[]): () => void {
    if (this.config.mode === 'off') return () => {}
    if (!agent || typeof agent.ctx?.on !== 'function' || typeof agent.ctx.tools?.schemas !== 'function' || typeof agent.ctx.tools.get !== 'function') {
      throw new Error('TOOL_DISCLOSURE_SEAM_UNAVAILABLE')
    }
    if (this.states.get(agent)?.active) throw new Error('TOOL_DISCLOSURE_ALREADY_ACTIVE')
    if (!allowedTools.every(toolName)) throw new Error('TOOL_DISCLOSURE_ALLOWED_SET_INVALID')
    const state: State = { active: true, allowed: new Set(allowedTools), discovered: new Set(), catalogStamp: '', identities: new Map(), fallback: null, dispose() {} }
    this.catalog(agent, state)
    const listener = agent.ctx.on('system-prompt/assemble', async (_before: Assembly, context: { agent?: unknown }, next: () => Promise<Assembly>) => {
      const result = await next()
      if (!state.active || context.agent !== agent) return result
      if (!result || !Array.isArray(result.tools)) throw new Error('TOOL_DISCLOSURE_ASSEMBLY_INVALID')
      const allowed = result.tools.filter(schema => state.allowed.has(schema.name))
      const beforeBytes = bytes(allowed)
      let reason = state.fallback, catalog: Schema[] = []
      try { catalog = this.catalog(agent, state); reason = state.fallback }
      catch { reason = 'TOOL_CATALOG_UNAVAILABLE'; state.discovered.clear() }
      if (!state.allowed.has(DISCOVERY_TOOL_NAME)) reason = 'DISCOVERY_NOT_GRANTED'
      else if (!catalog.some(schema => schema.name === DISCOVERY_TOOL_NAME) || !allowed.some(schema => schema.name === DISCOVERY_TOOL_NAME)) reason = 'DISCOVERY_SCHEMA_UNAVAILABLE'
      const visible = new Set([DISCOVERY_TOOL_NAME, ...this.config.residentTools, ...this.config.phaseTools, ...state.discovered])
      const selected = reason ? allowed : allowed.filter(schema => visible.has(schema.name))
      // Keep the provider's native schemas and stable order. Never synthesize a
      // tool wrapper, grant a hidden capability, or re-install the Gate guard.
      const transformed = { ...result, tools: selected }
      this.observations.set(transformed, { toolsBefore: allowed.length, toolsAfter: selected.length, toolsBytesBefore: beforeBytes,
        toolsBytesAfter: bytes(selected), mode: reason ? 'off' : 'pilot', reasonCode: reason })
      return transformed
    })
    state.dispose = () => {
      if (!state.active) return
      // The listener must be gone before declaring teardown successful.
      listener(); state.active = false; state.discovered.clear(); this.states.delete(agent); this.active.delete(state)
    }
    this.states.set(agent, state); this.active.add(state)
    return state.dispose
  }

  find(input: unknown, execution: { agent?: unknown; signal?: AbortSignal }): unknown {
    const agent = execution.agent as Agent | undefined, state = agent && this.states.get(agent)
    if (execution.signal?.aborted || !state?.active || !state.allowed.has(DISCOVERY_TOOL_NAME)) throw new Error('TOOL_DISCOVERY_NOT_AUTHORIZED')
    if (!object(input) || Object.keys(input).some(key => key !== 'query') || typeof input.query !== 'string'
      || !input.query.trim() || input.query.length > 160) throw new Error('TOOL_DISCOVERY_QUERY_INVALID')
    const query = input.query.trim().toLocaleLowerCase(), terms = query.split(/\s+/u).filter(Boolean).slice(0, 8)
    const catalog = this.catalog(agent!, state)
    const scored = catalog.filter(schema => schema.name !== DISCOVERY_TOOL_NAME).map(schema => {
      const name = schema.name.toLocaleLowerCase(), description = schema.description.toLocaleLowerCase()
      const score = name === query ? 1000 : terms.reduce((score, term) => score + (name.includes(term) ? 10 : 0) + (description.includes(term) ? 1 : 0), 0)
      return { schema, score }
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.schema.name.localeCompare(b.schema.name))
    const selected: Schema[] = []
    for (const { schema } of scored) {
      if (selected.length === this.config.maxResults) break
      const proposed = [...selected, schema]
      const response = { tools: proposed, availableNextStep: true, truncated: false }
      if (bytes(response) > this.config.maxResultBytes) {
        // A schema too large to return is not silently undiscoverable. Restore
        // the same authorized native surface on the next step, with no resend.
        state.fallback = 'DISCOVERY_RESULT_TOO_LARGE'
        return { tools: [], availableNextStep: true, fallback: 'AUTHORIZED_NATIVE_SURFACE_NEXT_STEP', reasonCode: state.fallback }
      }
      selected.push(schema)
    }
    if (state.discovered.size + selected.filter(schema => !state.discovered.has(schema.name)).length > 32) {
      state.fallback = 'DISCOVERY_SET_LIMIT'
      return { tools: [], availableNextStep: true, fallback: 'AUTHORIZED_NATIVE_SURFACE_NEXT_STEP', reasonCode: state.fallback }
    }
    for (const schema of selected) state.discovered.add(schema.name)
    return { tools: selected, availableNextStep: true, truncated: scored.length > selected.length }
  }

  dispose(): void { for (const state of [...this.active]) state.dispose() }
}
