// Read-only audit helper. Executes the current Owner page script with event/DOM
// doubles; does not claim to verify browser rendering or native form validation.
import fs from 'node:fs'
import vm from 'node:vm'

export const drain = () => new Promise(resolve => setImmediate(resolve))

export function storageDouble(values = new Map()) {
  return {
    values,
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  }
}

export function createOwnerUiHarness({ sourcePath, html, fetch, localStorage = storageDouble(), sessionStorage = storageDouble() }) {
  const source = html ?? fs.readFileSync(sourcePath, 'utf8')
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(source)?.[1]
  if (!script) throw new Error('Owner inline script not found')
  const nodes = new Map()
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase()
      this.children = []
      this.listeners = {}
      this.value = ''
      this.hidden = false
      this.disabled = false
      this.textContent = ''
      this.classList = { add() {} }; this.style = {}
    }
    set id(value) { this._id = value; nodes.set(value, this) }
    get id() { return this._id }
    append(...children) {
      for (const child of children) {
        child.parentElement = this
        this.children.push(child)
        if (this.tagName === 'SELECT' && this.children.length === 1) this.value = child.value
      }
    }
    replaceChildren(...children) { this.children = []; this.append(...children) }
    addEventListener(name, handler) { this.listeners[name] = handler }
    querySelectorAll(selector) {
      const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')])
      if (selector === '[name]') return descendants.filter(child => child.name)
      if (selector === '*') return descendants
      return descendants.filter(child => child.tagName === selector.toUpperCase())
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this) }
    setAttribute(name, value) { this[name] = value }
    focus() {}
  }
  for (const id of ['theme', 'status', 'activation', 'window', 'editor', 'scope', 'expiry', 'edit-fields', 'action', 'action-note', 'fields', 'prepare', 'operation-form', 'preview-panel', 'preview-summary', 'changes', 'preview-expiry', 'commit', 'edit-again', 'result-panel', 'result-title', 'result-message', 'result-meta', 'lookup', 'next', 'revoke']) {
    const element = new Element(['action', 'theme'].includes(id) ? 'select' : 'div')
    element.id = id
  }
  for (const id of ['activation', 'window', 'editor', 'preview-panel', 'result-panel', 'lookup', 'next']) nodes.get(id).hidden = true
  let requestSequence = 0
  const document = { getElementById: id => nodes.get(id), createElement: tag => new Element(tag), documentElement: { dataset: {} } }
  vm.runInNewContext(script, { document, localStorage, sessionStorage, crypto: { randomUUID: () => `request-${++requestSequence}` }, fetch, setInterval() {}, Date })
  return {
    nodes,
    localStorage,
    sessionStorage,
    el: id => nodes.get(id),
    event: async (id, name = 'click', value = {}) => {
      const element = nodes.get(id)
      if (!element?.listeners[name]) throw new Error(`Missing handler ${id}/${name}`)
      await element.listeners[name]({ preventDefault() {}, ...value })
      await drain()
    },
    ready: drain,
  }
}

// Usage: construct with renderOwnerApp(...) or sourcePath; await page.ready();
// set page.el('param-name').value; await page.event('operation-form', 'submit');
// await page.event('commit'); inspect page.el('edit-fields').disabled, etc.
// For refresh use another harness sharing sessionStorage/localStorage and fetch.

import test from 'node:test'
import assert from 'node:assert/strict'
import { renderOwnerApp } from '../lib/gui/owner-ui.js'
const html = renderOwnerApp('owner-behavior-test-1234567890')
function fixture(mode, sessionStorage = storageDouble()) {
  const calls = []; let applied = false, decisionId = 'decision-one'
  const control = () => ({ ok: true, csrfToken: 'fixture-only-csrf', decision: { decisionId, kingdomId: null, state: 'ACTIVE', actions: ['init'], expiresAt: new Date(Date.now()+600000).toISOString(), scope: { kingdomWide:false, territoryIds:[], bindingIds:[] } }, catalog: {} })
  const receipt = () => ({ status:'APPLIED', action:'init', operationId:'operation-one', message:'Initialized fixture', receiptSeq:1, appliedAt:new Date().toISOString() })
  const fetch = async (url, options) => {
    calls.push({url, method: options?.method, body: options?.body})
    let data, status=200
    if(url.endsWith('/control')) data=control()
    else if(url.endsWith('/prepare')) data={ok:true,preview:{prepareId:'prepare-one',operationId:'operation-one',summary:'Initialize',changes:[],expiresAt:new Date(Date.now()+600000).toISOString()}}
    else if(url.endsWith('/commit')) {
      if(mode==='stale') { status=409; data={ok:false,errorCode:'PREVIEW_STALE',message:'Related facts changed'} }
      else { applied=mode==='lost-applied'; throw new Error('response lost') }
    } else if(url.includes('/receipts/')) data={ok:true,receipt:applied?receipt():null}
    else throw new Error('Unexpected request '+url)
    return {ok:status===200,status,json:async()=>data}
  }
  const page = () => createOwnerUiHarness({html,fetch,sessionStorage})
  const prepare = async p => { await p.ready(); p.el('param-kingdom_name').value='Fixture'; p.el('param-owner_name').value='Human'; await p.event('operation-form','submit') }
  return {page,prepare,calls,sessionStorage,replace:()=>{decisionId='replacement'}}
}
test('Owner UI confirmed stale rejection preserves input and permits a new preview without resubmitting', async () => {
  const f=fixture('stale'), p=f.page(); await f.prepare(p); await p.event('commit')
  assert.equal(p.el('edit-fields').disabled,false); assert.equal(p.el('commit').disabled,true)
  assert.equal(p.el('param-kingdom_name').value,'Fixture'); assert.equal(p.el('lookup').hidden,true)
  assert.equal(f.sessionStorage.values.size,0)
  await p.event('operation-form','submit'); assert.equal(p.el('commit').disabled,false)
  assert.equal(f.calls.filter(c=>c.url.endsWith('/commit')).length,1)
})
test('Owner UI reload recovers the exact applied operation after a lost response without another commit', async () => {
  const f=fixture('lost-applied'), p=f.page(); await f.prepare(p); await p.event('commit')
  assert.equal(p.el('edit-fields').disabled,true)
  const saved=JSON.parse(f.sessionStorage.getItem('dsh-kingdom.owner.pending.v1'))
  assert.deepEqual(saved,{decisionId:'decision-one',prepareId:'prepare-one',operationId:'operation-one'})
  const reload=f.page(); await reload.ready()
  assert.equal(reload.el('result-title').textContent,'变更已应用'); assert.equal(reload.el('lookup').hidden,true)
  assert.equal(f.sessionStorage.values.size,0)
  assert.equal(f.calls.filter(c=>c.url.endsWith('/commit')).length,1)
  assert.equal(f.calls.filter(c=>c.url.endsWith('/receipts/operation-one')).length,1)
})
test('Owner UI unresolved receipts and replaced decisions retain the original reference and block new work', async () => {
  const f=fixture('unknown'), p=f.page(); await f.prepare(p); await p.event('commit')
  const reload=f.page(); await reload.ready(); assert.equal(reload.el('edit-fields').disabled,true)
  assert.equal(reload.el('lookup').hidden,false); assert.equal(reload.el('next').hidden,true)
  await reload.event('next'); assert.equal(f.calls.filter(c=>c.url.endsWith('/prepare')).length,1)
  f.replace(); const replacement=f.page(); await replacement.ready()
  assert.match(replacement.el('status').textContent,/已被替换/)
  assert.match(f.sessionStorage.getItem('dsh-kingdom.owner.pending.v1'),/decision-one/)
  assert.equal(f.calls.filter(c=>c.url.endsWith('/commit')).length,1)
})
test('Owner UI does not send a mutation when its pending reference cannot be retained', async () => {
  const storage=storageDouble(); storage.setItem=()=>{throw new Error('disabled storage')}
  const f=fixture('lost-applied',storage), p=f.page(); await f.prepare(p); await p.event('commit')
  assert.equal(f.calls.filter(c=>c.url.endsWith('/commit')).length,0)
  assert.equal(p.el('edit-fields').disabled,false); assert.match(p.el('result-message').textContent,/尚未发送/)
})
