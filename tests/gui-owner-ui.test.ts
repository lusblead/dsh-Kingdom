import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Script } from 'node:vm'
import { renderOwnerApp } from '../lib/gui/owner-ui.js'

test('owner UI is a nonce-bound self-contained structured form with all supported actions', () => {
  const html = renderOwnerApp('owner-ui-test-nonce-1234567890')
  assert.match(html, /<html lang="zh-CN"/u)
  assert.match(html, /<script nonce="owner-ui-test-nonce-1234567890">/u)
  assert.match(html, /<style nonce="owner-ui-test-nonce-1234567890">/u)
  assert.doesNotThrow(() => new Script(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(html)![1]))
  for (const action of ['territory.create', 'territory.update', 'territory.supervisor', 'role.bind', 'role.session', 'ceiling', 'execution-profile']) assert.ok(html.includes(action))
  assert.match(html, /data-theme=parchment/u)
  assert.match(html, /data-theme=night/u)
  assert.match(html, /data-theme=wine/u)
  assert.match(html, /max-width:600px/u)
  assert.match(html, /prefers-reduced-motion:reduce/u)
  assert.throws(() => renderOwnerApp('" unsafe'), /invalid owner page nonce/u)
})

test('owner UI keeps receipt lookup distinct from commit and never interpolates runtime values into HTML', () => {
  const html = renderOwnerApp('owner-ui-test-nonce-1234567890')
  assert.equal(html.includes('innerHTML'), false)
  assert.match(html, /request\('commit',\{prepareId:state\.preview\.prepareId,operationId:state\.preview\.operationId\}\)/u)
  assert.match(html, /request\('receipts\/'\+encodeURIComponent\(state\.preview\.operationId\)\)/u)
  assert.match(html, /页面不会自动重发变更/u)
  assert.match(html, /不等于确认没有副作用/u)
  assert.match(html, /五分钟宽限期内查询已提交结果/u)
  assert.match(html, /config\.headers\['X-Kingdom-Decision-Id'\]=state\.decisionId/u)
  assert.match(html, /if \(state\.decisionId === null\) state\.decisionId=control\.decision\.decisionId/u)
  assert.match(html, /control\.decision\.decisionId !== state\.decisionId\) throw new Error/u)
  assert.match(html, /只有后续真实运行才能确认实际使用的模型/u)
  assert.match(html, /留空使用现有配置默认值/u)
  assert.match(html, /if \(!parameters\.model\) throw new Error\('请填写明确的模型名称。'\)/u)
  assert.equal(html.includes('profile_mode'), false)
  assert.equal(html.includes('清除角色请求配置'), false)
  assert.match(html, /el\('revoke'\)\.addEventListener\('click',async\(\)=>\{\s*if \(!state\.control\) return/u)
  assert.equal(html.includes("provider:'spawn'"), false)
})
