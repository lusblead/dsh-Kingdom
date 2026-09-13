import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolDisclosureRuntime, DISCOVERY_TOOL_NAME } from '../lib/capability/tool-disclosure.js'

function fixture(options: Record<string, unknown> = {}) {
  const runtime = new ToolDisclosureRuntime({ mode: 'pilot', residentTools: ['read'], ...options })
  const definitions = new Map<string, { name: string; description: string; parameters: object; execute(): string }>()
  for (const [name, description] of [[DISCOVERY_TOOL_NAME, 'Find permitted tools'], ['read', 'Read a file'], ['edit', 'Edit a file'], ['search', 'Search text'], ['ungranted', 'Read private secrets']]) {
    definitions.set(name!, { name: name!, description: description!, parameters: { type: 'object', properties: {} }, execute() { return name! } })
  }
  const listeners: Array<(...args: any[]) => Promise<any>> = []
  const agent = { ctx: { tools: {
    schemas: () => [...definitions.values()].map(({ execute: _execute, ...schema }) => schema), get: (name: string) => definitions.get(name),
  }, on: (_name: string, fn: (...args: any[]) => Promise<any>) => { listeners.push(fn); return () => { listeners.splice(listeners.indexOf(fn), 1) } } } }
  const allowed = [DISCOVERY_TOOL_NAME, 'read', 'edit', 'search']
  const originalGuard = (name: string) => { if (!allowed.includes(name)) throw new Error('capability not granted'); return definitions.get(name)!.execute() }
  const assemble = async (after?: (tools: any[]) => any[], target: object = agent) => {
    const tools = agent.ctx.tools.schemas(); const base = { tools: after ? after(tools) : tools, sections: [], contexts: [], variables: {} }
    return listeners.length ? listeners[0]!(base, { agent: target }, async () => base) : base
  }
  return { runtime, definitions, agent, allowed, assemble, originalGuard, listeners }
}

test('pilot waits for later assembly, filters own-scope ungranted schemas, and discovers native tools only inside A', async () => {
  const f = fixture(); const dispose = f.runtime.install(f.agent, f.allowed)
  const first = await f.assemble(tools => [...tools, { name: 'late-ungranted', description: 'later plugin', parameters: {} }])
  assert.deepEqual(first.tools.map((s: any) => s.name), [DISCOVERY_TOOL_NAME, 'read'])
  const found = f.runtime.find({ query: 'edit' }, { agent: f.agent }) as any
  assert.equal(found.tools[0].name, 'edit'); assert.deepEqual(found.tools[0].parameters, { type: 'object', properties: {} })
  assert.deepEqual(first.tools.map((s: any) => s.name), [DISCOVERY_TOOL_NAME, 'read'], 'already issued assembly is immutable')
  const second = await f.assemble()
  assert.deepEqual(second.tools.map((s: any) => s.name), [DISCOVERY_TOOL_NAME, 'read', 'edit'])
  assert.equal(f.originalGuard('edit'), 'edit'); assert.throws(() => f.originalGuard('ungranted'), /not granted/)
  assert.deepEqual((f.runtime.find({ query: 'private secrets' }, { agent: f.agent }) as any).tools, [])
  assert.equal(f.runtime.metadata(second)?.mode, 'pilot')
  dispose(); assert.equal(f.listeners.length, 0)
  assert.throws(() => f.runtime.find({ query: 'edit' }, { agent: f.agent }), /NOT_AUTHORIZED/)
})

test('missing discovery grant falls back to exactly the granted native surface and never self-grants discovery', async () => {
  const f = fixture(); f.runtime.install(f.agent, ['read', 'edit'])
  const result = await f.assemble()
  assert.deepEqual(result.tools.map((s: any) => s.name), ['read', 'edit'])
  assert.equal(f.runtime.metadata(result)?.reasonCode, 'DISCOVERY_NOT_GRANTED')
  assert.throws(() => f.runtime.find({ query: 'edit' }, { agent: f.agent }), /NOT_AUTHORIZED/)
  f.runtime.dispose()
})

test('catalog and same-name shadow changes invalidate discovery without leaking the replacement outside A', async () => {
  const f = fixture(); f.runtime.install(f.agent, f.allowed)
  f.runtime.find({ query: 'search' }, { agent: f.agent })
  assert.ok((await f.assemble()).tools.some((s: any) => s.name === 'search'))
  f.definitions.set('search', { ...f.definitions.get('search')!, execute: () => 'new implementation' })
  assert.deepEqual((await f.assemble()).tools.map((s: any) => s.name), [DISCOVERY_TOOL_NAME, 'read'])
  f.runtime.find({ query: 'search' }, { agent: f.agent })
  assert.equal(f.originalGuard('search'), 'new implementation')
  assert.throws(() => f.originalGuard('ungranted'), /not granted/)
  f.runtime.dispose()
})

test('discovery response size is bounded and oversized authorized schemas restore A instead of becoming unreachable', async () => {
  const f = fixture({ maxResultBytes: 1024 })
  f.definitions.get('edit')!.description = 'edit ' + 'large schema '.repeat(300)
  f.runtime.install(f.agent, f.allowed)
  const found = f.runtime.find({ query: 'edit' }, { agent: f.agent }) as any
  assert.equal(found.fallback, 'AUTHORIZED_NATIVE_SURFACE_NEXT_STEP'); assert.ok(Buffer.byteLength(JSON.stringify(found)) <= 1024)
  const result = await f.assemble()
  assert.deepEqual(result.tools.map((s: any) => s.name), f.allowed)
  assert.equal(f.runtime.metadata(result)?.mode, 'off')
  assert.throws(() => f.originalGuard('ungranted'), /not granted/)
  f.runtime.dispose()
})

test('off mode has no listener, and live pilots reject wrong agents, invalid input, cancellation and overlapping installation', async () => {
  const disabled = fixture({ mode: 'off' }); disabled.runtime.install(disabled.agent, disabled.allowed)
  assert.equal(disabled.listeners.length, 0)
  const f = fixture(); f.runtime.install(f.agent, f.allowed)
  assert.throws(() => f.runtime.install(f.agent, f.allowed), /ALREADY_ACTIVE/)
  for (const args of [{ query: '' }, { query: 'x'.repeat(161) }, { query: 'read', principal: 'owner' }]) assert.throws(() => f.runtime.find(args, { agent: f.agent }), /QUERY_INVALID/)
  assert.throws(() => f.runtime.find({ query: 'read' }, { agent: {} }), /NOT_AUTHORIZED/)
  assert.throws(() => f.runtime.find({ query: 'read' }, { agent: f.agent, signal: AbortSignal.abort() }), /NOT_AUTHORIZED/)
  assert.equal((await f.assemble(undefined, {})).tools.length, 5, 'a scope listener does not mutate another agent assembly')
  f.runtime.dispose()
})
