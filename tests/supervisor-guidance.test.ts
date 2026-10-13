import assert from 'node:assert/strict'
import test from 'node:test'
import { Script } from 'node:vm'
import { buildOwnerBindingGuidance, draftOwnerBindingIntent, type OwnerBindingIntentContext } from '../lib/core/owner-binding-intent.js'
import { ownerBindingFormPrefill, renderOwnerApp } from '../lib/gui/owner-ui.js'

const context = (): OwnerBindingIntentContext => ({
  kingdom_id: 'kingdom-local', target_session_ref: 'session-current', target_session_classification: 'ACTIVE',
  role_bindings: [], territories: [{ territory_id: 'territory-rd', name: '研发领', status: 'ACTIVE', kingdom_id: 'kingdom-local' }],
})
const guiInput = (command: string | null) => {
  assert.ok(command?.startsWith('/kingdom owner.gui '))
  return JSON.parse(command!.slice('/kingdom owner.gui '.length))
}

test('会话能按准确领地名准备首次主管任命，仍为零写和无 Owner 权限', () => {
  const current = context(), before = JSON.stringify(current)
  const draft = draftOwnerBindingIntent({ text: '让当前会话负责「研发领」', context: current })
  assert.equal(draft.status, 'DRAFT_READY')
  assert.equal(draft.operation?.kind, 'role.bind')
  assert.deepEqual(draft.intent.territory, { territory_id: 'territory-rd', name: '研发领' })
  assert.equal(draft.owner_authority, false)
  assert.equal(draft.write_effect, 'ZERO_WRITE')
  const guidance = buildOwnerBindingGuidance(draft, current)
  assert.equal(guidance.status, 'READY')
  assert.equal(guidance.owner_authority, false)
  assert.equal(guidance.write_effect, 'ZERO_WRITE')
  assert.match(guidance.summary, /研发领/u)
  assert.deepEqual(guiInput(guidance.canonical_owner_gui), {
    kingdomId: 'kingdom-local', actions: ['role.bind'], ttlMs: 600000,
    scope: { kingdomWide: false, territoryIds: ['territory-rd'], bindingIds: [], roleTypes: ['SUPERVISOR'],
      targetSessionIds: ['session-current'], workspaceRoots: [] },
  })
  assert.equal(JSON.stringify(current), before)
  assert.ok(guidance.steps.some(step => step.includes('查看变更预览')))
  assert.ok(guidance.steps.some(step => step.includes('确认应用此变更')))
  assert.equal(guidance.canonical_owner_gui!.includes('ownerId'), false)
  assert.equal(guidance.canonical_owner_gui!.includes('ticket'), false)
})

test('更换和接替主管表达复用原席位，仅准备一次 role.session 管理窗口', () => {
  for (const text of ['把「研发领」主管换成当前会话', '让当前会话接替「研发领」主管']) {
    const current = context()
    current.role_bindings = [{ binding_id: 'supervisor-seat', role_type: 'SUPERVISOR', role_name: '研发领主管',
      session_id: 'previous-session', status: 'ACTIVE', kingdom_id: 'kingdom-local' }]
    current.territories = [{ territory_id: 'territory-rd', name: '研发领', supervisor_binding_id: 'supervisor-seat', status: 'ACTIVE' }]
    const draft = draftOwnerBindingIntent({ text, context: current })
    assert.equal(draft.status, 'DRAFT_READY', text)
    assert.deepEqual(draft.operation, { kind: 'role.session', args: { binding_id: 'supervisor-seat', session_id: 'session-current' } })
    const guidance = buildOwnerBindingGuidance(draft, current)
    assert.equal(guidance.status, 'READY')
    assert.match(guidance.summary, /保留原席位及任务历史/u)
    const input = guiInput(guidance.canonical_owner_gui)
    assert.deepEqual(input.actions, ['role.session'])
    assert.deepEqual(input.scope.bindingIds, ['supervisor-seat'])
    assert.deepEqual(input.scope.territoryIds, ['territory-rd'])
    assert.deepEqual(input.scope.targetSessionIds, ['session-current'])
    assert.equal(input.scope.kingdomWide, false)
    assert.equal(current.role_bindings[0]!.session_id, 'previous-session')
  }
})

test('把当前会话设为准确领地主管的说法使用同一 exact 解析与失效拒绝', () => {
  const text = '把当前会话设为「研发领」的主管', current = context()
  const draft = draftOwnerBindingIntent({ text, context: current })
  assert.equal(draft.status, 'DRAFT_READY')
  assert.deepEqual(draft.intent.territory, { territory_id: 'territory-rd', name: '研发领' })
  assert.deepEqual(guiInput(buildOwnerBindingGuidance(draft, current).canonical_owner_gui).scope.territoryIds, ['territory-rd'])
  const expired = { ...current, target_session_classification: 'EXPIRED' as const }
  const expiredDraft = draftOwnerBindingIntent({ text, context: expired })
  assert.equal(expiredDraft.status, 'AMBIGUOUS')
  assert.equal(buildOwnerBindingGuidance(expiredDraft, expired).canonical_owner_gui, null)
  const differentName = { ...current, territories: [{ territory_id: 'territory-rd', name: '研发领地', aliases: ['研发领'] }] }
  assert.equal(draftOwnerBindingIntent({ text, context: differentName }).ambiguity?.code, 'TERRITORY_NOT_FOUND')
})

const multiTerritoryContext = (): OwnerBindingIntentContext => ({
  ...context(),
  role_bindings: [{ binding_id: 'supervisor-seat', role_type: 'SUPERVISOR', role_name: '共同主管',
    session_id: 'previous-session', status: 'ACTIVE', kingdom_id: 'kingdom-local' }],
  territories: [
    { territory_id: 'territory-a', name: '研发领', supervisor_binding_id: 'supervisor-seat', status: 'ACTIVE', kingdom_id: 'kingdom-local' },
    { territory_id: 'territory-b', name: '测试领', supervisor_binding_id: 'supervisor-seat', status: 'ACTIVE', kingdom_id: 'kingdom-local' },
  ],
})

test('同一主管席位负责多个领地时，引导列出全部准确范围并提示只想一领地应停止', () => {
  const current = multiTerritoryContext(), before = JSON.stringify(current)
  const draft = draftOwnerBindingIntent({ text: '把「研发领」主管换成当前会话', context: current })
  assert.equal(draft.status, 'DRAFT_READY')
  assert.deepEqual(draft.affected_territories?.map(row => row.territory_id), ['territory-a', 'territory-b'])
  const guidance = buildOwnerBindingGuidance(draft, current)
  assert.equal(guidance.status, 'READY')
  assert.match(guidance.summary, /会同时接替全部领地：「研发领」、「测试领」/u)
  assert.match(guidance.summary, /若只想接替其中一个领地，请停止确认/u)
  assert.ok(guidance.steps[0]!.includes('「研发领」、「测试领」'))
  const input = guiInput(guidance.canonical_owner_gui)
  assert.deepEqual(input.actions, ['role.session'])
  assert.deepEqual(input.scope.territoryIds, ['territory-a', 'territory-b'])
  assert.deepEqual(input.scope.bindingIds, ['supervisor-seat'])
  assert.deepEqual(input.scope.targetSessionIds, ['session-current'])
  assert.equal(input.scope.kingdomWide, false)
  assert.equal(JSON.stringify(current), before)
  assert.equal(guidance.owner_authority, false)
})

test('同席位其它领地新增、换绑、失效或外来时拒绝沿用原主管引导命令', () => {
  const current = multiTerritoryContext()
  const draft = draftOwnerBindingIntent({ text: '把「研发领」主管换成当前会话', context: current })
  const cases: OwnerBindingIntentContext[] = [
    { ...current, territories: [...current.territories!, { territory_id: 'territory-c', name: '发布领',
      supervisor_binding_id: 'supervisor-seat', status: 'ACTIVE', kingdom_id: 'kingdom-local' }] },
    { ...current, territories: current.territories!.map(row => row.territory_id === 'territory-b'
      ? { ...row, supervisor_binding_id: 'other-seat' } : row) },
    { ...current, territories: current.territories!.map(row => row.territory_id === 'territory-b'
      ? { ...row, status: 'EXPIRED' } : row) },
    { ...current, territories: current.territories!.map(row => row.territory_id === 'territory-b'
      ? { ...row, kingdom_id: 'another-kingdom' } : row) },
    { ...current, target_session_classification: 'EXPIRED' },
  ]
  for (const changed of cases) {
    const guidance = buildOwnerBindingGuidance(draft, changed)
    assert.equal(guidance.status, 'NEEDS_CLARIFICATION')
    assert.equal(guidance.canonical_owner_gui, null)
    assert.equal(guidance.owner_authority, false)
  }
  const foreign = cases[3]!
  const newDraft = draftOwnerBindingIntent({ text: '把「研发领」主管换成当前会话', context: foreign })
  assert.equal(newDraft.status, 'DRAFT_READY', '被点名领地有效，但其它同席位领地仍须核对')
  assert.equal(buildOwnerBindingGuidance(newDraft, foreign).canonical_owner_gui, null)
})

test('新表达不把名称前缀、旧后缀或别名猜成目标领地', () => {
  const current = context()
  current.territories = [{ territory_id: 'territory-rd', name: '研发领地', aliases: ['研发'] }]
  for (const text of ['让当前会话负责「研发」', '把「研发领」主管换成当前会话']) {
    const draft = draftOwnerBindingIntent({ text, context: current })
    assert.equal(draft.status, 'AMBIGUOUS')
    assert.equal(draft.ambiguity?.code, 'TERRITORY_NOT_FOUND')
    assert.equal(buildOwnerBindingGuidance(draft, current).canonical_owner_gui, null)
  }
  const legacy = draftOwnerBindingIntent({ text: '让当前会话主管研发辖区', context: current })
  assert.equal(legacy.status, 'DRAFT_READY', '存量语法保持兼容')
})

test('歧义、失效会话、Owner 意图和附加指令均不提供管理命令', () => {
  const cases: { text: string; current: OwnerBindingIntentContext }[] = [
    { text: '让当前会话负责「研发领」', current: { ...context(), target_session_classification: 'EXPIRED' } },
    { text: '让当前会话负责「研发领」', current: { ...context(), territories: [
      { territory_id: 'a', name: '研发领' }, { territory_id: 'b', name: '研发领' }] } },
    { text: '把当前会话设为Owner', current: context() },
    { text: '让当前会话负责「研发领」并删除任务', current: context() },
  ]
  for (const item of cases) {
    const draft = draftOwnerBindingIntent({ text: item.text, context: item.current })
    assert.equal(draft.status, 'AMBIGUOUS')
    const guidance = buildOwnerBindingGuidance(draft, item.current)
    assert.equal(guidance.status, 'NEEDS_CLARIFICATION')
    assert.equal(guidance.canonical_owner_gui, null)
    assert.equal(guidance.owner_authority, false)
  }
})

test('ready 草案不能覆盖已经改变的会话或主管关系', () => {
  const current = context()
  const draft = draftOwnerBindingIntent({ text: '让当前会话负责「研发领」', context: current })
  assert.equal(buildOwnerBindingGuidance(draft, { ...current, target_session_ref: 'another-session' }).canonical_owner_gui, null)
  assert.equal(buildOwnerBindingGuidance(draft, { ...current, kingdom_id: null }).canonical_owner_gui, null)
  assert.equal(buildOwnerBindingGuidance(draft, { ...current,
    role_bindings: [{ binding_id: 'new-supervisor', role_type: 'SUPERVISOR', status: 'ACTIVE' }],
    territories: [{ territory_id: 'territory-rd', name: '研发领', supervisor_binding_id: 'new-supervisor' }],
  }).canonical_owner_gui, null)
})

const singleControl = () => ({
  decision: { actions: ['role.bind'], scope: { kingdomWide: false, roleTypes: ['SUPERVISOR'], territoryIds: ['territory-rd'],
    bindingIds: [] as string[], targetSessionIds: ['session-current'], workspaceRoots: [] as string[] } },
  catalog: { territories: [{ id: 'territory-rd', name: '研发领' }], bindings: [] as { id: string; roleType: string; roleName: string }[],
    runtimeSessions: [{ id: 'session-current', label: '当前会话' }] },
})

test('单动作准确范围仅预填已有目录目标，预填本身不扩权或提交', () => {
  const control = singleControl(), before = JSON.stringify(control)
  assert.deepEqual(ownerBindingFormPrefill(control), { role_type: 'SUPERVISOR', role_name: '研发领主管',
    territory_id: 'territory-rd', session_id: 'session-current' })
  assert.equal(JSON.stringify(control), before)
  control.decision.actions = ['role.session']
  control.decision.scope.bindingIds = ['supervisor-seat']
  control.catalog.bindings = [{ id: 'supervisor-seat', roleType: 'SUPERVISOR', roleName: '研发领主管' }]
  assert.deepEqual(ownerBindingFormPrefill(control), { binding_id: 'supervisor-seat', session_id: 'session-current' })
})

test('同一主管席位的多领地接替仍仅预填该席位和会话，并保留全部领地影响提示', () => {
  const control = singleControl()
  control.decision.actions = ['role.session']
  control.decision.scope.bindingIds = ['supervisor-seat']
  control.decision.scope.territoryIds = ['territory-a', 'territory-b']
  control.catalog.bindings = [{ id: 'supervisor-seat', roleType: 'SUPERVISOR', roleName: '共同主管' }]
  control.catalog.territories = [{ id: 'territory-a', name: '研发领' }, { id: 'territory-b', name: '测试领' }]
  const before = JSON.stringify(control)
  assert.deepEqual(ownerBindingFormPrefill(control), { binding_id: 'supervisor-seat', session_id: 'session-current' })
  assert.equal(JSON.stringify(control), before)
  const html = renderOwnerApp('supervisor-guidance-test-nonce-123')
  assert.match(html, /本次更换同一主管席位的会话，会同时接替全部领地/u)
  assert.match(html, /若只想接替其中一个领地，请停止确认，不提交此变更/u)
  control.decision.scope.bindingIds.push('other-seat')
  assert.equal(ownerBindingFormPrefill(control), null, '增加席位不能借多领地预填扩大范围')
})

test('管理窗口多目标、宽范围或目录目标缺失时不会自动选择第一项', () => {
  const cases = [
    (c: ReturnType<typeof singleControl>) => { c.decision.actions.push('role.session') },
    (c: ReturnType<typeof singleControl>) => { c.decision.scope.kingdomWide = true },
    (c: ReturnType<typeof singleControl>) => { c.decision.scope.workspaceRoots.push('unrelated-root') },
    (c: ReturnType<typeof singleControl>) => { c.decision.scope.roleTypes.push('CHANCELLOR') },
    (c: ReturnType<typeof singleControl>) => { c.decision.scope.territoryIds.push('another-territory') },
    (c: ReturnType<typeof singleControl>) => { c.decision.scope.targetSessionIds.push('another-session') },
    (c: ReturnType<typeof singleControl>) => { c.catalog.runtimeSessions = [] },
    (c: ReturnType<typeof singleControl>) => { c.catalog.territories = [] },
    (c: ReturnType<typeof singleControl>) => { c.catalog.territories.push({ id: 'territory-rd', name: 'duplicate' }) },
  ]
  for (const change of cases) {
    const control = singleControl(); change(control)
    assert.equal(ownerBindingFormPrefill(control), null)
  }
  const html = renderOwnerApp('supervisor-guidance-test-nonce-123')
  assert.doesNotThrow(() => new Script(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(html)![1]))
  assert.match(html, /requireChoice\(sessions, '请选择运行会话'\)/u)
  assert.match(html, /requireChoice\(territories, '请选择领地'\)/u)
  assert.match(html, /requireChoice\(allowedBindings/u)
  assert.match(html, /request\('prepare',payload\(\)\)/u)
  assert.match(html, /request\('commit',\{prepareId:state\.preview\.prepareId/u)
})
