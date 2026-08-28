import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DIRECT_SLASH_CONFIRM_REQUIRED,
  canonicalTerritorySupervisorSlash,
  draftOwnerBindingIntent,
  draftOwnerBindingIntentFromRejectedWrite,
  serializeOwnerBindingIntentDraft,
} from '../lib/core/owner-binding-intent.js'

const activeTarget = (session = 'session-current') => ({
  target_session_ref: session,
  target_session_classification: 'ACTIVE' as const,
})

test('自然语言别名生成 deterministic zero-write CHANCELLOR role.bind Draft', () => {
  const context = Object.freeze({
    ...activeTarget('session-宰相'),
    role_bindings: Object.freeze([]),
  })
  const before = serializeOwnerBindingIntentDraft(draftOwnerBindingIntent({ text: '把当前会话设为宰相', context }))
  const draft = draftOwnerBindingIntent({ text: '把当前会话设为宰相', context })

  assert.equal(draft.status, 'DRAFT_READY')
  assert.equal(draft.authority_source, 'NONE')
  assert.equal(draft.owner_authority, false)
  assert.equal(draft.write_effect, 'ZERO_WRITE')
  assert.equal(draft.operation?.kind, 'role.bind')
  assert.deepEqual(draft.steps.map(step => step.kind), ['role.bind'])
  assert.equal(draft.policy.failure, 'STOP_NO_AGENT_RETRY_OR_COMPENSATION')
  assert.deepEqual(draft.operation?.args, {
    role_type: 'CHANCELLOR',
    role_name: '宰相',
    session_id: 'session-宰相',
  })
  assert.equal(draft.canonical_direct_slash, '/kingdom role.bind {"role_name":"宰相","role_type":"CHANCELLOR","session_id":"session-宰相"}')
  assert.equal(draft.confirmation, DIRECT_SLASH_CONFIRM_REQUIRED)
  assert.equal(serializeOwnerBindingIntentDraft(draftOwnerBindingIntent({ text: '把当前会话设为宰相', context })), before)
  assert.equal(context.target_session_ref, 'session-宰相')
})

test('已有 singleton CHANCELLOR 只生成 role.session Draft，不重复 role.bind', () => {
  const draft = draftOwnerBindingIntent({
    text: '将这个会话绑定为首相',
    context: {
      ...activeTarget(),
      role_bindings: [{ binding_id: 'binding-chancellor', role_type: 'CHANCELLOR', status: 'ACTIVE' }],
    },
  })

  assert.equal(draft.status, 'DRAFT_READY')
  assert.equal(draft.operation?.kind, 'role.session')
  assert.deepEqual(draft.operation?.args, { binding_id: 'binding-chancellor', session_id: 'session-current' })
  assert.equal(draft.canonical_direct_slash, '/kingdom role.session {"binding_id":"binding-chancellor","session_id":"session-current"}')
})

test('Supervisor 缺 Territory 或 Territory 多匹配时只追问 AMBIGUOUS', () => {
  const missing = draftOwnerBindingIntent({
    text: '让该会话主管某辖区',
    context: { ...activeTarget(), territories: [{ territory_id: 't1', name: '研发' }] },
  })
  assert.equal(missing.status, 'AMBIGUOUS')
  assert.equal(missing.ambiguity?.code, 'TERRITORY_REQUIRED')
  assert.equal(missing.canonical_direct_slash, null)
  assert.equal(missing.confirmation, null)

  const multiple = draftOwnerBindingIntent({
    text: '让该会话主管研发辖区',
    context: {
      ...activeTarget(),
      territories: [
        { territory_id: 't1', name: '研发' },
        { territory_id: 't2', name: '研发领地' },
      ],
    },
  })
  assert.equal(multiple.status, 'AMBIGUOUS')
  assert.equal(multiple.ambiguity?.code, 'TERRITORY_MULTIPLE')
  assert.equal(multiple.operation, null)
})

test('Supervisor 唯一 Territory 生成 role.bind Draft，并保留已解析 Territory 目标', () => {
  const draft = draftOwnerBindingIntent({
    text: '让这个会话主管RAG研发辖区',
    context: {
      ...activeTarget('session-supervisor'),
      territories: [{ territory_id: 'territory-rag', name: 'RAG研发' }],
    },
  })

  assert.equal(draft.status, 'DRAFT_READY')
  assert.equal(draft.operation?.kind, 'role.bind')
  assert.deepEqual(draft.intent.territory, { territory_id: 'territory-rag', name: 'RAG研发' })
  assert.equal(draft.operation && 'territory_id' in draft.operation.args, false)
  assert.match(draft.canonical_direct_slash ?? '', /^\/kingdom role\.bind /u)
  assert.equal(draft.confirmation, DIRECT_SLASH_CONFIRM_REQUIRED)
})

test('Supervisor 新绑定生成完整两步 canonical plan，第二步只依赖 direct Owner 结果', () => {
  const draft = draftOwnerBindingIntent({
    text: '让当前会话主管研发辖区',
    context: {
      ...activeTarget('session-supervisor'),
      territories: [{ territory_id: 'territory-rag', name: '研发' }],
    },
  })

  assert.deepEqual(draft.steps.map(step => step.kind), ['role.bind', 'territory.supervisor'])
  assert.equal(draft.steps[0]?.canonical_direct_slash, '/kingdom role.bind {"role_name":"主管","role_type":"SUPERVISOR","session_id":"session-supervisor"}')
  assert.equal(draft.steps[1]?.canonical_direct_slash, null)
  assert.deepEqual(draft.steps[1]?.args, {
    territory_id: 'territory-rag',
    supervisor_binding_id_ref: 'ROLE_BIND.result.binding_id',
  })
  assert.equal(draft.steps[1]?.canonical_direct_slash_template, '/kingdom territory.supervisor {"supervisor_binding_id":"${ROLE_BIND.result.binding_id}","territory_id":"territory-rag"}')
  assert.deepEqual(draft.steps[1]?.depends_on, ['ROLE_BIND'])
  assert.equal(canonicalTerritorySupervisorSlash('territory-rag', 'binding-supervisor'), '/kingdom territory.supervisor {"supervisor_binding_id":"binding-supervisor","territory_id":"territory-rag"}')
  assert.equal(draft.steps[0]?.policy.failure, 'STOP_NO_AGENT_RETRY_OR_COMPENSATION')
  assert.equal(draft.steps[1]?.policy.failure, 'STOP_NO_AGENT_RETRY_OR_COMPENSATION')
})

test('已有 Territory supervisor_binding_id 时对 exact Supervisor binding 生成 role.session', () => {
  const draft = draftOwnerBindingIntent({
    text: '让当前会话主管研发辖区',
    context: {
      ...activeTarget('session-existing-supervisor'),
      role_bindings: [{ binding_id: 'binding-supervisor', role_type: 'SUPERVISOR', status: 'ACTIVE' }],
      territories: [{ territory_id: 'territory-rag', name: '研发', supervisor_binding_id: 'binding-supervisor' }],
    },
  })

  assert.equal(draft.status, 'DRAFT_READY')
  assert.deepEqual(draft.steps.map(step => step.kind), ['role.session'])
  assert.deepEqual(draft.operation?.args, {
    binding_id: 'binding-supervisor',
    session_id: 'session-existing-supervisor',
  })
  assert.equal(draft.canonical_direct_slash, '/kingdom role.session {"binding_id":"binding-supervisor","session_id":"session-existing-supervisor"}')
})

test('Territory supervisor_binding_id 的 foreign/multiple/unsafe proof 均保持 AMBIGUOUS', () => {
  const base = {
    ...activeTarget('session-supervisor'),
    kingdom_id: 'kingdom-a',
    territories: [{ territory_id: 'territory-rag', name: '研发', supervisor_binding_id: 'binding-supervisor' }],
  }

  const foreign = draftOwnerBindingIntent({
    text: '让当前会话主管研发辖区',
    context: {
      ...base,
      role_bindings: [{ binding_id: 'binding-supervisor', role_type: 'SUPERVISOR', status: 'ACTIVE', kingdom_id: 'kingdom-b' }],
    },
  })
  assert.equal(foreign.status, 'AMBIGUOUS')
  assert.equal(foreign.ambiguity?.code, 'ROLE_FOREIGN')

  const multiple = draftOwnerBindingIntent({
    text: '让当前会话主管研发辖区',
    context: {
      ...base,
      role_bindings: [
        { binding_id: 'binding-supervisor', role_type: 'SUPERVISOR', status: 'ACTIVE', kingdom_id: 'kingdom-a' },
        { binding_id: 'binding-supervisor', role_type: 'SUPERVISOR', status: 'ACTIVE', kingdom_id: 'kingdom-a' },
      ],
    },
  })
  assert.equal(multiple.status, 'AMBIGUOUS')
  assert.equal(multiple.ambiguity?.code, 'ROLE_MULTIPLE')

  const unsafe = draftOwnerBindingIntent({
    text: '让当前会话主管研发辖区',
    context: {
      ...activeTarget('session-supervisor'),
      territories: [{ territory_id: 'territory-rag', name: '研发', supervisor_binding_id: 'binding supervisor' }],
    },
  })
  assert.equal(unsafe.status, 'AMBIGUOUS')
  assert.equal(unsafe.ambiguity?.code, 'ROLE_BINDING_UNSAFE')
})

test('target_session_ref 缺失、foreign、过期、多解、unknown、aborted、absent 均 fail-closed 为 AMBIGUOUS', () => {
  const cases = [
    { context: {}, code: 'SESSION_MISSING' },
    { context: { target_session_ref: 'absent', target_session_classification: 'ABSENT' as const }, code: 'SESSION_MISSING' },
    { context: { target_session_ref: 'foreign', target_session_classification: 'FOREIGN' as const }, code: 'SESSION_FOREIGN' },
    { context: { target_session_ref: 'expired', target_session_classification: 'EXPIRED' as const }, code: 'SESSION_EXPIRED' },
    { context: { target_session_ref: 'aborted', target_session_classification: 'ABORTED' as const }, code: 'SESSION_UNRESOLVED' },
    { context: { target_session_ref: 'session-current', target_session_matches: ['s1', 's2'] }, code: 'SESSION_MULTIPLE' },
    { context: { target_session_ref: 'unknown', target_session_classification: 'UNKNOWN' as const }, code: 'SESSION_UNRESOLVED' },
    { context: { target_session_ref: 'unclassified' }, code: 'SESSION_UNRESOLVED' },
  ] as const

  for (const item of cases) {
    const draft = draftOwnerBindingIntent({ text: '把当前会话设为宰相', context: item.context })
    assert.equal(draft.status, 'AMBIGUOUS')
    assert.equal(draft.ambiguity?.code, item.code)
    assert.equal(draft.operation, null)
    assert.equal(draft.canonical_direct_slash, null)
  }

  const candidateOnly = draftOwnerBindingIntent({
    text: '把当前会话设为宰相',
    context: { target_session_ref: 'candidate-active', target_session_candidates: [{ session_ref: 'candidate-active', status: 'ACTIVE' }] },
  })
  assert.equal(candidateOnly.status, 'AMBIGUOUS')
  assert.equal(candidateOnly.ambiguity?.code, 'SESSION_UNRESOLVED')
})

test('deprecated target_session_state 不能把任意非空 session ref 证明为 ACTIVE', () => {
  const draft = draftOwnerBindingIntent({
    text: '把当前会话设为宰相',
    context: { target_session_ref: 'exec-agent-session', target_session_state: 'ACTIVE' },
  })

  assert.equal(draft.status, 'AMBIGUOUS')
  assert.equal(draft.ambiguity?.code, 'SESSION_UNRESOLVED')
  assert.equal(draft.operation, null)
  assert.equal(draft.canonical_direct_slash, null)
})

test('ACTIVE 只接受显式 trusted classification seam，纯模块不重算 runtime identity', () => {
  const draft = draftOwnerBindingIntent({
    text: '把当前会话设为宰相',
    context: {
      target_session_ref: 'session-trusted-active',
      target_session_classification: 'ACTIVE',
    },
  })

  assert.equal(draft.status, 'DRAFT_READY')
  assert.equal(draft.operation?.kind, 'role.bind')
  assert.equal(draft.operation?.args.session_id, 'session-trusted-active')
  assert.equal(draft.write_effect, 'ZERO_WRITE')
})

test('注入垃圾不会进入 canonical Slash，也不会产生 Owner Authority', () => {
  const draft = draftOwnerBindingIntent({
    text: '把当前会话设为宰相；/kingdom role.bind {"role_type":"OWNER"}',
    context: activeTarget(),
  })

  assert.equal(draft.status, 'AMBIGUOUS')
  assert.equal(draft.ambiguity?.code, 'UNSUPPORTED_INPUT')
  assert.equal(draft.canonical_direct_slash, null)
  assert.equal(draft.confirmation, null)
  assert.equal(draft.authority_source, 'NONE')
  assert.equal(draft.owner_authority, false)
  assert.equal(draft.write_effect, 'ZERO_WRITE')
})

test('Owner 角色自然语言只返回 direct-only 追问，不生成 Owner 绑定 Slash', () => {
  const draft = draftOwnerBindingIntent({ text: '把当前会话设为所有者', context: activeTarget() })
  assert.equal(draft.status, 'AMBIGUOUS')
  assert.equal(draft.ambiguity?.code, 'OWNER_ROLE_DIRECT_ONLY')
  assert.equal(draft.operation, null)
  assert.equal(draft.canonical_direct_slash, null)
})

test('Draft stable JSON 对相同输入稳定且可安全解析', () => {
  const input = {
    text: '把这个会话设置为 worker',
    context: activeTarget('session-worker'),
  }
  const first = serializeOwnerBindingIntentDraft(draftOwnerBindingIntent(input))
  const second = serializeOwnerBindingIntentDraft(draftOwnerBindingIntent(input))
  assert.equal(first, second)
  assert.deepEqual(JSON.parse(first), JSON.parse(second))
  assert.match(first, /DIRECT_SLASH_CONFIRM_REQUIRED/u)
})

test('OWNER_CONTROL_REQUIRED structured rejection helper 生成 normalized Draft 且保持 zero-write', () => {
  const bindDraft = draftOwnerBindingIntentFromRejectedWrite({
    code: 'OWNER_CONTROL_REQUIRED: direct Slash required',
    operation: 'kingdom_bind_role',
    request: { role_type: 'CHANCELLOR', role_name: '";drop table' },
    context: { target_session_ref: 'session-rejected', target_session_classification: 'ACTIVE' },
  })
  assert.equal(bindDraft.status, 'DRAFT_READY')
  assert.equal(bindDraft.normalized_input, '把当前会话设为宰相')
  assert.equal(bindDraft.operation?.kind, 'role.bind')
  assert.equal(bindDraft.canonical_direct_slash, '/kingdom role.bind {"role_name":"宰相","role_type":"CHANCELLOR","session_id":"session-rejected"}')
  assert.equal(bindDraft.authority_source, 'NONE')
  assert.equal(bindDraft.owner_authority, false)
  assert.equal(bindDraft.write_effect, 'ZERO_WRITE')

  const sessionDraft = draftOwnerBindingIntentFromRejectedWrite({
    code: 'OWNER_CONTROL_REQUIRED',
    operation: 'kingdom_bind_session',
    request: { role_type: 'CHANCELLOR', binding_id: 'binding-existing' },
    context: {
      target_session_ref: 'session-rejected',
      target_session_classification: 'ACTIVE',
      role_bindings: [{ binding_id: 'binding-existing', role_type: 'CHANCELLOR', status: 'ACTIVE' }],
    },
  })
  assert.equal(sessionDraft.status, 'DRAFT_READY')
  assert.equal(sessionDraft.operation?.kind, 'role.session')
  assert.equal(sessionDraft.canonical_direct_slash, '/kingdom role.session {"binding_id":"binding-existing","session_id":"session-rejected"}')
  assert.equal(sessionDraft.steps.length, 1)
})

test('kingdom_bind_session binding_id-only request resolves exact binding into canonical role.session', () => {
  const draft = draftOwnerBindingIntentFromRejectedWrite({
    code: 'OWNER_CONTROL_REQUIRED',
    operation: 'kingdom_bind_session',
    request: { binding_id: 'binding-worker' },
    context: {
      ...activeTarget('session-binding-id-only'),
      kingdom_id: 'kingdom-a',
      role_bindings: [{
        binding_id: 'binding-worker',
        role_type: 'WORKER',
        status: 'ACTIVE',
        kingdom_id: 'kingdom-a',
      }],
    },
  })

  assert.equal(draft.status, 'DRAFT_READY')
  assert.equal(draft.operation?.kind, 'role.session')
  assert.deepEqual(draft.operation?.args, {
    binding_id: 'binding-worker',
    session_id: 'session-binding-id-only',
  })
  assert.equal(draft.canonical_direct_slash, '/kingdom role.session {"binding_id":"binding-worker","session_id":"session-binding-id-only"}')
  assert.equal(draft.write_effect, 'ZERO_WRITE')
})

test('binding_id-only lookup keeps no-solution, multiple, foreign, expired, and aborted paths zero-write', () => {
  const binding = {
    binding_id: 'binding-worker',
    role_type: 'WORKER',
    status: 'ACTIVE' as const,
    kingdom_id: 'kingdom-a',
  }
  const cases = [
    {
      context: { ...activeTarget(), role_bindings: [] },
      code: 'ROLE_BINDING_UNSAFE',
    },
    {
      context: { ...activeTarget(), role_bindings: [binding, binding] },
      code: 'ROLE_MULTIPLE',
    },
    {
      context: {
        ...activeTarget(),
        kingdom_id: 'kingdom-a',
        role_bindings: [{ ...binding, kingdom_id: 'kingdom-b' }],
      },
      code: 'ROLE_FOREIGN',
    },
    {
      context: { ...activeTarget('foreign-session'), target_session_classification: 'FOREIGN' as const, role_bindings: [binding] },
      code: 'SESSION_FOREIGN',
    },
    {
      context: { ...activeTarget('expired-session'), target_session_classification: 'EXPIRED' as const, role_bindings: [binding] },
      code: 'SESSION_EXPIRED',
    },
    {
      context: { ...activeTarget('aborted-session'), target_session_classification: 'ABORTED' as const, role_bindings: [binding] },
      code: 'SESSION_UNRESOLVED',
    },
  ] as const

  for (const item of cases) {
    const draft = draftOwnerBindingIntentFromRejectedWrite({
      code: 'OWNER_CONTROL_REQUIRED',
      operation: 'kingdom_bind_session',
      request: { binding_id: 'binding-worker' },
      context: item.context,
    })
    assert.equal(draft.status, 'AMBIGUOUS')
    assert.equal(draft.ambiguity?.code, item.code)
    assert.equal(draft.operation, null)
    assert.equal(draft.canonical_direct_slash, null)
    assert.equal(draft.write_effect, 'ZERO_WRITE')
  }
})

test('structured OWNER gate precedes request and target session proof across generic and exact branches', () => {
  const owner = {
    binding_id: 'binding-owner',
    role_type: 'OWNER',
    status: 'ACTIVE' as const,
    kingdom_id: 'kingdom-a',
  }
  const worker = {
    binding_id: 'binding-worker',
    role_type: 'WORKER',
    status: 'ACTIVE' as const,
    kingdom_id: 'kingdom-a',
  }

  const ownerCases = [
    {
      request: { role_type: 'OWNER', session_id: 'request-foreign' },
      context: { target_session_ref: 'target-session', target_session_classification: 'FOREIGN' as const, role_bindings: [owner] },
    },
    {
      request: { role_type: 'OWNER' },
      context: { target_session_ref: 'expired-session', target_session_classification: 'EXPIRED' as const, role_bindings: [owner] },
    },
    {
      request: { binding_id: owner.binding_id, session_id: 'request-foreign' },
      context: { target_session_ref: 'target-session', target_session_classification: 'FOREIGN' as const, role_bindings: [owner] },
    },
    {
      request: { binding_id: owner.binding_id },
      context: { target_session_ref: 'expired-session', target_session_classification: 'EXPIRED' as const, role_bindings: [owner] },
    },
  ] as const

  for (const item of ownerCases) {
    const draft = draftOwnerBindingIntentFromRejectedWrite({
      code: 'OWNER_CONTROL_REQUIRED',
      operation: 'kingdom_bind_session',
      request: item.request,
      context: item.context,
    })
    assert.equal(draft.status, 'AMBIGUOUS')
    assert.equal(draft.ambiguity?.code, 'OWNER_ROLE_DIRECT_ONLY')
    assert.equal(draft.operation, null)
    assert.equal(draft.canonical_direct_slash, null)
    assert.equal(draft.write_effect, 'ZERO_WRITE')
  }

  const exactOwnerWithInvalidHint = draftOwnerBindingIntentFromRejectedWrite({
    code: 'OWNER_CONTROL_REQUIRED',
    operation: 'kingdom_bind_session',
    request: { binding_id: owner.binding_id, role_type: 'NOT_A_ROLE', session_id: 'request-foreign' },
    context: {
      target_session_ref: 'expired-session',
      target_session_classification: 'EXPIRED',
      role_bindings: [owner],
    },
  })
  assert.equal(exactOwnerWithInvalidHint.ambiguity?.code, 'OWNER_ROLE_DIRECT_ONLY')
  assert.equal(exactOwnerWithInvalidHint.operation, null)
  assert.equal(exactOwnerWithInvalidHint.write_effect, 'ZERO_WRITE')

  const genericForeign = draftOwnerBindingIntentFromRejectedWrite({
    code: 'OWNER_CONTROL_REQUIRED',
    operation: 'kingdom_bind_session',
    request: { role_type: 'WORKER', session_id: 'request-foreign' },
    context: {
      target_session_ref: 'target-session',
      target_session_classification: 'ACTIVE',
      role_bindings: [worker],
    },
  })
  assert.equal(genericForeign.ambiguity?.code, 'SESSION_FOREIGN')
  assert.equal(genericForeign.write_effect, 'ZERO_WRITE')

  const exactForeign = draftOwnerBindingIntentFromRejectedWrite({
    code: 'OWNER_CONTROL_REQUIRED',
    operation: 'kingdom_bind_session',
    request: { binding_id: worker.binding_id, session_id: 'request-foreign' },
    context: {
      target_session_ref: 'target-session',
      target_session_classification: 'ACTIVE',
      role_bindings: [worker],
    },
  })
  assert.equal(exactForeign.ambiguity?.code, 'SESSION_FOREIGN')
  assert.equal(exactForeign.write_effect, 'ZERO_WRITE')

  const genericInvalidExpired = draftOwnerBindingIntentFromRejectedWrite({
    code: 'OWNER_CONTROL_REQUIRED',
    operation: 'kingdom_bind_role',
    request: { role_type: 'NOT_A_ROLE' },
    context: {
      target_session_ref: 'expired-session',
      target_session_classification: 'EXPIRED',
    },
  })
  const exactInvalidExpired = draftOwnerBindingIntentFromRejectedWrite({
    code: 'OWNER_CONTROL_REQUIRED',
    operation: 'kingdom_bind_session',
    request: { binding_id: worker.binding_id, role_type: 'NOT_A_ROLE' },
    context: {
      target_session_ref: 'expired-session',
      target_session_classification: 'EXPIRED',
      role_bindings: [worker],
    },
  })
  assert.equal(genericInvalidExpired.ambiguity?.code, 'SESSION_EXPIRED')
  assert.equal(exactInvalidExpired.ambiguity?.code, 'SESSION_EXPIRED')
  assert.equal(genericInvalidExpired.write_effect, 'ZERO_WRITE')
  assert.equal(exactInvalidExpired.write_effect, 'ZERO_WRITE')
})

test('Supervisor OWNER_CONTROL_REQUIRED rejection helper returns the full dependent two-step Draft', () => {
  const draft = draftOwnerBindingIntentFromRejectedWrite({
    code: 'OWNER_CONTROL_REQUIRED',
    operation: 'kingdom_bind_role',
    request: { role_type: 'SUPERVISOR', territory_id: 'territory-rag' },
    context: {
      target_session_ref: 'session-rejected-supervisor',
      target_session_classification: 'ACTIVE',
      territories: [{ territory_id: 'territory-rag', name: '研发' }],
    },
  })

  assert.equal(draft.status, 'DRAFT_READY')
  assert.equal(draft.normalized_input, '让当前会话主管研发辖区')
  assert.deepEqual(draft.steps.map(step => step.kind), ['role.bind', 'territory.supervisor'])
  assert.equal(draft.steps[0]?.canonical_direct_slash, '/kingdom role.bind {"role_name":"主管","role_type":"SUPERVISOR","session_id":"session-rejected-supervisor"}')
  assert.equal(draft.steps[1]?.canonical_direct_slash_template, '/kingdom territory.supervisor {"supervisor_binding_id":"${ROLE_BIND.result.binding_id}","territory_id":"territory-rag"}')
  assert.equal(draft.authority_source, 'NONE')
  assert.equal(draft.owner_authority, false)
  assert.equal(draft.write_effect, 'ZERO_WRITE')
  assert.equal(draft.steps[0]?.policy.failure, 'STOP_NO_AGENT_RETRY_OR_COMPENSATION')
  assert.equal(draft.steps[1]?.policy.failure, 'STOP_NO_AGENT_RETRY_OR_COMPENSATION')
})
