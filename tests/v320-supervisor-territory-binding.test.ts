/**
 * 3.2.0 AC1–AC5：主管 ⇄ 领地完全绑定的命令层与事务层验收。
 *
 * Owner 口径（2026-09-28）：只要任命主管，就必须同时指定它的领地；席位与领地主理
 * 必须在同一个事务里写完，不允许出现"有主管、没领地"的中间态；领地已有在任主理时
 * 先解除再指派（不静默覆盖）；退任主管时同时解除它在领地上的主理关系。
 *
 * 这里走的是**真实 direct Slash 入口**（插件 apply 出来的 kingdom 命令），不是直接调用 Core，
 * 因此同时覆盖语法层拒绝与 Core 事务语义。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../lib/index.js'
import { KingdomStore } from '../lib/core/db.js'
import type { EventRow, KingdomStore as Store } from '../lib/core/db.js'

interface CapturedCommand {
  name: string
  handler(input: { rawInput: string }): Promise<{ kind: string; text: string }>
}

interface TestAgent { id: string; session: { id: string }; status: 'idle' | 'running' }

function makeHarness() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-kingdom-v320-supervisor-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const commands = new Map<string, CapturedCommand>()
  const disposers: Array<() => void> = []
  const agents = new Map<string, TestAgent>()
  const sessions = new Map<string, { id: string }>()
  const context = {
    tools: { register(): () => void { return () => undefined } },
    commands: {
      register(command: CapturedCommand): () => void {
        commands.set(command.name, command)
        return () => { commands.delete(command.name) }
      },
    },
    effect(callback: () => unknown): void {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer as () => void)
    },
    get(name: string): unknown {
      if (name === 'agents') {
        return { currentInitiator: () => undefined, get: (id: string) => agents.get(id), list: () => [...agents.values()] }
      }
      if (name === 'sessions') return { get: (id: string) => sessions.get(id) }
      return undefined
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }
  apply(context as never, {
    kingdomName: 'v320-supervisor-test', ownerName: 'test-owner', workerProvider: 'spawn',
    guiPort: 0, guiToken: '', guiAllowOrigins: ['*'], authMode: 'session-bound', migrateV4: true,
  })
  const addAgent = (id: string, status: TestAgent['status'] = 'idle'): void => {
    const session = { id }
    agents.set(id, { id, session, status })
    sessions.set(id, session)
  }
  addAgent('sup-session')
  addAgent('sup2-session')
  const close = (): void => {
    for (const dispose of disposers.reverse()) dispose()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
  return { root, commands, addAgent, close }
}

interface Scenario {
  store: Store
  kingdomId: string
  territoryA: string
  territoryB: string
  slash(rawInput: string): Promise<{ kind: string; text: string }>
  events(type: string): EventRow[]
  close(): void
}

/** 建好 harness + 王国 + 两个空领地，并返回真实 store 句柄供断言。 */
async function scenario(t: { after(fn: () => void): void }): Promise<Scenario> {
  const harness = makeHarness()
  const command = harness.commands.get('kingdom')!
  const slash = (rawInput: string) => command.handler({ rawInput })
  const initialized = await slash('init')
  assert.equal(initialized.kind, 'success', initialized.text)
  const opened = (): Store => new KingdomStore(join(harness.root, 'kingdom', 'kingdom.db'), { allowSchemaV4: true })
  let store = opened()
  const kingdomId = store.getDefaultKingdom()!.kingdom_id
  for (const name of ['领A', '领B']) {
    const created = await slash(`territory.create ${JSON.stringify({ name, workspace_path: harness.root })}`)
    assert.equal(created.kind, 'success', created.text)
  }
  store.close()
  store = opened()
  const territories = store.listTerritories(kingdomId).filter(row => row.status === 'ACTIVE')
  assert.equal(territories.length, 2)
  const byName = (name: string) => territories.find(row => row.name === name)!.territory_id
  t.after(() => { store.close(); harness.close() })
  return {
    store, kingdomId, territoryA: byName('领A'), territoryB: byName('领B'), slash,
    events: (type: string) => store.listEvents(kingdomId, 500).filter(row => row.event_type === type),
    close: () => { store.close(); harness.close() },
  }
}

test('AC1：任命主管必须同时给出领地；语法层拒绝且零写入', async t => {
  const s = await scenario(t)
  const before = s.store.listEvents(s.kingdomId, 500).length

  const missingTerritory = await s.slash(`role.bind ${JSON.stringify({ role_type: 'SUPERVISOR', role_name: '没有领地的主管', session_id: 'sup-session' })}`)
  assert.equal(missingTerritory.kind, 'error', missingTerritory.text)
  assert.match(missingTerritory.text, /territory_id/u)
  assert.match(missingTerritory.text, /未写入/u)

  const wrongRole = await s.slash(`role.bind ${JSON.stringify({ role_type: 'WORKER', role_name: '越权的执行者', territory_id: s.territoryA })}`)
  assert.equal(wrongRole.kind, 'error', wrongRole.text)
  assert.match(wrongRole.text, /只用于任命 SUPERVISOR/u)

  assert.equal(s.store.listEvents(s.kingdomId, 500).length, before, '两种语法拒绝都不产生任何事件')
  assert.equal(s.store.getBindingsByRole(s.kingdomId, 'SUPERVISOR').length, 0)
  assert.equal(s.store.getBindingsByRole(s.kingdomId, 'WORKER').length, 0)
  assert.equal(s.store.getTerritoryById(s.territoryA)!.supervisor_binding_id, null)
})

test('AC2：席位与领地主理在同一事务里一次写入，两条事实同源', async t => {
  const s = await scenario(t)
  const bound = await s.slash(`role.bind ${JSON.stringify({ role_type: 'SUPERVISOR', role_name: '主理A', session_id: 'sup-session', territory_id: s.territoryA })}`)
  assert.equal(bound.kind, 'success', bound.text)

  const supervisor = s.store.getBindingByRole(s.kingdomId, 'SUPERVISOR')!
  assert.equal(supervisor.role_name, '主理A')
  assert.equal(s.store.getTerritoryById(s.territoryA)!.supervisor_binding_id, supervisor.binding_id,
    '任命成功后领地必须已经在同一事务里指向该席位')

  const roleBound = s.events('ROLE_BOUND')
  const supervisorUpdated = s.events('TERRITORY_SUPERVISOR_UPDATED')
  assert.equal(roleBound.length, 1)
  assert.equal(supervisorUpdated.length, 1)
  assert.equal(supervisorUpdated[0]!.target_id, s.territoryA)
  assert.equal(roleBound[0]!.actor_id, supervisorUpdated[0]!.actor_id, '两条事实记录同一个 Owner actor')
  assert.equal(JSON.parse(roleBound[0]!.payload_json).source_channel, 'LOCAL_DIRECT_SLASH')
  assert.equal(JSON.parse(supervisorUpdated[0]!.payload_json).source_channel, 'LOCAL_DIRECT_SLASH')
  assert.equal(JSON.parse(supervisorUpdated[0]!.payload_json).unassigned, false)
})

test('AC3：领地已有在任主理时任命被拒，且不会留下半写状态（整体回滚）', async t => {
  const s = await scenario(t)
  assert.equal((await s.slash(`role.bind ${JSON.stringify({ role_type: 'SUPERVISOR', role_name: '主理A', session_id: 'sup-session', territory_id: s.territoryA })}`)).kind, 'success')
  const first = s.store.getBindingByRole(s.kingdomId, 'SUPERVISOR')!
  const eventsBefore = s.store.listEvents(s.kingdomId, 500).length

  const second = await s.slash(`role.bind ${JSON.stringify({ role_type: 'SUPERVISOR', role_name: '抢占者', session_id: 'sup2-session', territory_id: s.territoryA })}`)
  assert.equal(second.kind, 'error', second.text)
  assert.match(second.text, /已有主理/u)
  assert.match(second.text, /先解除现有主理/u)

  // 关键：席位插入必须随领地拒绝一起回滚——库里没有"有主管、没领地"的半写状态。
  assert.equal(s.store.getBindingsByRole(s.kingdomId, 'SUPERVISOR').length, 1)
  assert.equal(s.store.getBindingByRole(s.kingdomId, 'SUPERVISOR')!.binding_id, first.binding_id)
  assert.equal(s.store.listEvents(s.kingdomId, 500).length, eventsBefore, '拒绝路径零事件')
  assert.equal(s.store.getTerritoryById(s.territoryA)!.supervisor_binding_id, first.binding_id)
})

test('AC3/AC4：领地主理先解除再指派；1:1——一个主管席位只主理一个领地', async t => {
  const s = await scenario(t)
  assert.equal((await s.slash(`role.bind ${JSON.stringify({ role_type: 'SUPERVISOR', role_name: '主理A', session_id: 'sup-session', territory_id: s.territoryA })}`)).kind, 'success')
  assert.equal((await s.slash(`role.bind ${JSON.stringify({ role_type: 'SUPERVISOR', role_name: '主理B', session_id: 'sup2-session', territory_id: s.territoryB })}`)).kind, 'success')
  const mainA = s.store.getBindingByRole(s.kingdomId, 'SUPERVISOR')!
  const mainB = s.store.getBindingsByRole(s.kingdomId, 'SUPERVISOR').find(row => row.role_name === '主理B')!

  // (a) 目标领地已有在任主理 → 拒绝，原值不变。
  const replaced = await s.slash(`territory.supervisor ${JSON.stringify({ territory_id: s.territoryA, supervisor_binding_id: mainB.binding_id })}`)
  assert.equal(replaced.kind, 'error', replaced.text)
  assert.match(replaced.text, /已有主理/u)
  assert.equal(s.store.getTerritoryById(s.territoryA)!.supervisor_binding_id, mainA.binding_id, '被拒时原主理保持不变')

  // (b) 领A 解除后仍然是 1:1：主理B 已隶属领B，不能再主理领A。
  const released = await s.slash(`territory.supervisor ${JSON.stringify({ territory_id: s.territoryA, supervisor_binding_id: null })}`)
  assert.equal(released.kind, 'success', released.text)
  assert.equal(s.store.getTerritoryById(s.territoryA)!.supervisor_binding_id, null)
  const crossTerritory = await s.slash(`territory.supervisor ${JSON.stringify({ territory_id: s.territoryA, supervisor_binding_id: mainB.binding_id })}`)
  assert.equal(crossTerritory.kind, 'error', crossTerritory.text)
  assert.match(crossTerritory.text, /已隶属领地「领B」/u)
  assert.match(crossTerritory.text, /只能主理一个领地/u)
  assert.equal(s.store.getTerritoryById(s.territoryA)!.supervisor_binding_id, null, '被拒时保持空缺')
  assert.deepEqual(
    s.store.listTerritories(s.kingdomId).filter(row => row.supervisor_binding_id === mainB.binding_id).map(row => row.name),
    ['领B'], '一个席位始终只主理一个领地',
  )

  // (c) 席位要换领地必须先解除原领地：解除领B → 主理B 变为未隶属 → 才能接管领A。
  assert.equal((await s.slash(`territory.supervisor ${JSON.stringify({ territory_id: s.territoryB, supervisor_binding_id: null })}`)).kind, 'success')
  const reassigned = await s.slash(`territory.supervisor ${JSON.stringify({ territory_id: s.territoryA, supervisor_binding_id: mainB.binding_id })}`)
  assert.equal(reassigned.kind, 'success', reassigned.text)
  assert.equal(s.store.getTerritoryById(s.territoryA)!.supervisor_binding_id, mainB.binding_id)
  assert.equal(s.store.getTerritoryById(s.territoryB)!.supervisor_binding_id, null)
})

test('AC5：退任主管在同一事务里解除领地主理，领地随即回到 fail-closed', async t => {
  const s = await scenario(t)
  assert.equal((await s.slash(`role.bind ${JSON.stringify({ role_type: 'SUPERVISOR', role_name: '主理A', session_id: 'sup-session', territory_id: s.territoryA })}`)).kind, 'success')
  const supervisor = s.store.getBindingByRole(s.kingdomId, 'SUPERVISOR')!

  const retired = await s.slash(`role.unbind ${JSON.stringify({ binding_id: supervisor.binding_id, reason: '换届' })}`)
  assert.equal(retired.kind, 'success', retired.text)
  assert.match(retired.text, /领A/u)

  assert.equal(s.store.getBindingById(supervisor.binding_id)!.status, 'RETIRED')
  assert.equal(s.store.getTerritoryById(s.territoryA)!.supervisor_binding_id, null, '退任同时解除主理，不留悬挂引用')
  const release = s.events('TERRITORY_SUPERVISOR_UPDATED').find(row => JSON.parse(row.payload_json).unassigned === true)!
  assert.equal(release.target_id, s.territoryA)
  assert.equal(s.events('ROLE_UNBOUND').length, 1)
  // 领地已无主理：任何主管都不能治理（fail-closed 事实来自领地指针本身）。
  assert.equal(s.store.getTerritoryById(s.territoryA)!.supervisor_binding_id, null)
})

test('事务嵌套：内层用 SAVEPOINT；内层失败被捕获时只回滚内层写入，未捕获时整体回滚', () => {
  const store = new KingdomStore(':memory:')
  try {
    const now = new Date().toISOString()
    const kingdomId = 'tx-join-kingdom'
    store.insertKingdom({ kingdom_id: kingdomId, name: '事务重入', owner_id: 'o1', owner_name: 'Tester', created_at: now })
    const territory = (id: string, name: string) => store.insertTerritory({
      territory_id: id, kingdom_id: kingdomId, name, workspace_path: null, summary: null,
      supervisor_binding_id: null, status: 'ACTIVE', deleted_at: null, deleted_reason: null, created_at: now,
    })

    // 外层 + 内层都成功：内层只是加入外层事务，不重复 BEGIN（SQLite 禁止嵌套 BEGIN）。
    store.withImmediateTransaction(() => {
      territory('t-outer', '外层')
      store.withImmediateTransaction(() => { territory('t-inner', '内层') })
    })
    assert.deepEqual(store.listTerritories(kingdomId).map(row => row.name).sort(), ['内层', '外层'].sort())

    // 内层失败但**被内层调用方捕获**（3.2.0 原子通道就是这样把拒绝理由变成返回文案的）：
    // 内层写入必须真的回滚，而外层已提交的事实不受影响——这正是「join 外层」做不到的。
    store.withImmediateTransaction(() => {
      territory('t-outer-2', '外层二')
      try {
        store.withImmediateTransaction(() => {
          territory('t-inner-2', '内层二')
          throw new Error('rejected inside')
        })
      } catch { /* 调用方把拒绝变成文案，外层继续 */ }
    })
    assert.equal(store.listTerritories(kingdomId).some(row => row.territory_id === 't-inner-2'), false, '内层写入必须回滚')
    assert.equal(store.listTerritories(kingdomId).some(row => row.territory_id === 't-outer-2'), true, '外层写入保留')

    // 内层抛出且无人接管：异常穿透到最外层，整体回滚。
    assert.throws(() => store.withImmediateTransaction(() => {
      territory('t-rolled-back', '回滚')
      store.withImmediateTransaction(() => { throw new Error('inner failure') })
    }), /inner failure/u)
    assert.equal(store.listTerritories(kingdomId).some(row => row.territory_id === 't-rolled-back'), false)
    assert.equal(store.listTerritories(kingdomId).length, 3)

    // 回滚之后连接仍可正常开始新事务（深度计数没有被异常路径带偏）。
    store.withImmediateTransaction(() => { territory('t-after', '之后') })
    assert.equal(store.listTerritories(kingdomId).length, 4)
  } finally { store.close() }
})
