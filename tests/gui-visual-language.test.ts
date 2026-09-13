import assert from 'node:assert/strict'
import test from 'node:test'
import { GUI_ICONS, KINGDOM_BRAND_SVG, EMPTY_STATE_SVG, GOVERNANCE_FLOW_HTML } from '../lib/gui/visual-assets.js'
import { renderConsoleApp } from '../lib/gui/console-app.js'

test('visual assets remain named-viewBox decorative SVG without active or remote content', () => {
  for (const [name, svg] of Object.entries({ ...GUI_ICONS, brand: KINGDOM_BRAND_SVG, emptyState: EMPTY_STATE_SVG })) {
    assert.match(svg, /^<svg\b/u, name)
    assert.match(svg, /viewBox="0 0 [\d.]+ [\d.]+"/u, name)
    assert.match(svg, /aria-hidden="true"/u, name)
    assert.match(svg, /focusable="false"/u, name)
    assert.match(svg, /currentColor/u, name)
    assert.doesNotMatch(svg, /<(?:script|foreignObject|image|iframe)\b|\bon\w+\s*=|(?:href|src)\s*=/iu, name)
  }
})

test('governance illustration is static guidance and preserves the acceptance boundary', () => {
  assert.match(GOVERNANCE_FLOW_HTML, /示意流程，不表示实时进度/u)
  assert.match(GOVERNANCE_FLOW_HTML, /主管接受后，任务才记为完成/u)
  assert.match(GOVERNANCE_FLOW_HTML, /REWORK/u)
  assert.match(GOVERNANCE_FLOW_HTML, /FAILED/u)
  assert.doesNotMatch(GOVERNANCE_FLOW_HTML, /<(?:button|input|form)\b|data-gated-action|aria-current/iu)
  const html = renderConsoleApp({ endpoints: { snapshot: '/custom/snapshot' } })
  assert.match(html, /"snapshot":"\/custom\/snapshot"/u)
  assert.doesNotMatch(html, /__(?:CONSOLE_DESIGN_CSS|KINGDOM_BRAND|ICON_\w+|GOVERNANCE_FLOW)__/u)
  assert.match(html, /GOVERNANCE_FACT/u)
  assert.match(html, /WORKER_CLAIM/u)
})
