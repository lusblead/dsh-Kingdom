import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CONSOLE_APP_DEFAULT_COMMANDS,
  CONSOLE_APP_DEFAULT_ENDPOINTS,
  CONSOLE_APP_HTML,
  CONSOLE_APP_THEMES,
  buildConsoleCommand,
  consoleEvidenceLabel,
  normalizeConsoleAllowedActions,
  normalizeConsoleCapabilities,
  normalizeConsoleTheme,
  parseConsoleFragment,
  renderConsoleApp,
  resolveConsoleActionState,
  resolveConsoleResourceActionState,
  shouldCommitConsoleTaskDetail,
} from '../lib/gui/console-app.js'
import { GUI_CHARACTER_ASSET_FILES, GUI_CHARACTER_ASSET_SVGS } from '../lib/gui/console-app.js'

test('testConsoleShellPresentsChineseCouncilNavigationMapAndAccessibleActions', () => {
  for (const marker of ['Agent Kingdom', 'AgenticKingdom 治理档案', '王国组织谱', '王国健康', '待裁决', '王国组织', '领地名册', '管理中心', '王国账本', '流转记录', '执行者呈报', 'GOVERNANCE_FACT', 'RUNTIME_OBSERVATION', 'WORKER_CLAIM', 'DERIVED_EXPLANATION']) {
    assert.match(CONSOLE_APP_HTML, new RegExp(marker))
  }
  assert.doesNotMatch(CONSOLE_APP_HTML, /王国议政厅/u)
  for (const marker of ['task-create-form', 'assign-form', 'start-form', 'review-form', 'execution-control-form', 'start-grant', 'data-review-decision']) {
    assert.match(CONSOLE_APP_HTML, new RegExp(marker))
  }
  assert.match(CONSOLE_APP_HTML, /aria-label="四类证据"/u)
  assert.match(CONSOLE_APP_HTML, /aria-label="组织谱详情"/u)
  assert.match(CONSOLE_APP_HTML, /组织谱治理与资源图例/u)
  assert.match(CONSOLE_APP_HTML, /组织关系/u)
  assert.match(CONSOLE_APP_HTML, /领地颜色/u)
  assert.match(CONSOLE_APP_HTML, /任务状态/u)
  assert.match(CONSOLE_APP_HTML, /地图图例与技术注脚/u)
  assert.match(CONSOLE_APP_HTML, /data-console-page="overview"/u)
  assert.match(CONSOLE_APP_HTML, /data-console-page="management"/u)
  assert.match(CONSOLE_APP_HTML, /data-console-page="ledger"/u)
  assert.match(CONSOLE_APP_HTML, /人类所有者、代理与会话互不等同/u)
  assert.match(CONSOLE_APP_HTML, /data-realm-node="owner"/u)
  assert.match(CONSOLE_APP_HTML, /data-realm-node="chancellor"/u)
  assert.match(CONSOLE_APP_HTML, /data-realm-node="supervisor"/u)
  assert.match(CONSOLE_APP_HTML, /data-realm-node="worker"/u)
  assert.match(CONSOLE_APP_HTML, /--gate: #E9DEC7/u)
  assert.match(CONSOLE_APP_HTML, /--patina: #FFF9EB/u)
  assert.match(CONSOLE_APP_HTML, /--bamboo: #392C20/u)
  assert.match(CONSOLE_APP_HTML, /--gold: #B38A4E/u)
  assert.match(CONSOLE_APP_HTML, /--jade: #3D734E/u)
  assert.match(CONSOLE_APP_HTML, /--cinnabar: #B75227/u)
  assert.match(CONSOLE_APP_HTML, /Noto Serif SC/u)
  assert.match(CONSOLE_APP_HTML, /Noto Sans SC/u)
  assert.match(CONSOLE_APP_HTML, /kingdom-organogram/u)
  assert.match(CONSOLE_APP_HTML, /organogram-branches/u)
  assert.match(CONSOLE_APP_HTML, /pixel-sprite/u)
  for (const assetName of GUI_CHARACTER_ASSET_FILES) assert.match(CONSOLE_APP_HTML, new RegExp('/gui-assets/characters/' + assetName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')))
  assert.doesNotMatch(CONSOLE_APP_HTML, /class="pixel-sprite"[^>]+src="data:image\/svg\+xml/u)
  assert.match(CONSOLE_APP_HTML, /data-stage-evidence/u)
  assert.doesNotMatch(CONSOLE_APP_HTML, /--gate: #0E2528/u)
  assert.doesNotMatch(CONSOLE_APP_HTML, /grid-template-columns: 244px/u)
  assert.match(CONSOLE_APP_HTML, /max-width: 700px/u)
  assert.match(CONSOLE_APP_HTML, /max-width: 640px/u)
  assert.match(CONSOLE_APP_HTML, /max-width: 390px/u)
  assert.match(CONSOLE_APP_HTML, /\.evidence-kind[^}]*white-space: normal[^}]*overflow-wrap: anywhere/u)
  assert.match(CONSOLE_APP_HTML, /\.attention-council \{ order: -1; \}/u)
  assert.match(CONSOLE_APP_HTML, /\.main-nav \{ display: flex; gap: 4px; overflow-x: auto/u)
  assert.match(CONSOLE_APP_HTML, /body \{[^}]*overflow-x: hidden/u)
  assert.match(CONSOLE_APP_HTML, /skip-link/u)
  assert.match(CONSOLE_APP_HTML, /href="#overview">跳到王国总览/u)
  assert.match(CONSOLE_APP_HTML, /focus-visible/u)
  assert.match(CONSOLE_APP_HTML, /prefers-reduced-motion/u)
  for (const marker of ['主导航', '领地名册', '任务导航器', '执行', '史册', 'aria-current="page"', 'data-task-selector']) {
    assert.match(CONSOLE_APP_HTML, new RegExp(marker))
  }
  assert.match(CONSOLE_APP_HTML, /href="#overview"/u)
  assert.match(CONSOLE_APP_HTML, /href="#organization"/u)
  assert.match(CONSOLE_APP_HTML, /href="#tasks"/u)
  assert.match(CONSOLE_APP_HTML, /href="#executions"/u)
  assert.match(CONSOLE_APP_HTML, /href="#activity"/u)
  assert.match(CONSOLE_APP_HTML, /href="#management"/u)
  assert.match(CONSOLE_APP_HTML, /href="#ledger"/u)
  assert.match(CONSOLE_APP_HTML, /#task=/u)
  assert.match(CONSOLE_APP_HTML, /hashchange/u)
  assert.match(CONSOLE_APP_HTML, /popstate/u)
  for (const visibleEnglish of [/>Overview</u, />Organization</u, />Tasks</u, />Executions</u, />Activity</u, />Refresh</u, />Task navigator</u, />Host capability gate</u]) {
    assert.doesNotMatch(CONSOLE_APP_HTML, visibleEnglish)
  }
})

test('testConsoleDeclaresInlineFaviconWithoutNetworkRequest', () => {
  assert.match(CONSOLE_APP_HTML, /<link rel="icon" href="data:image\/svg\+xml,/u)
  assert.doesNotMatch(CONSOLE_APP_HTML, /<link rel="icon" href="(?:https?:|\/)\//u)
})

test('testConsoleRestoresFourThemesAndHumanFirstProgressiveDisclosure', () => {
  assert.deepEqual(CONSOLE_APP_THEMES.map(theme => theme.id), ['parchment', 'night', 'forest', 'wine'])
  assert.equal(normalizeConsoleTheme('forest'), 'forest')
  assert.equal(normalizeConsoleTheme('unsupported'), 'forest')
  for (const marker of [
    'data-theme-choice="parchment"',
    'data-theme-choice="night"',
    'data-theme-choice="forest"',
    'data-theme-choice="wine"',
    'dsh-kingdom.console.theme',
    'aria-label="界面风格"',
    '任务编号',
    '展开治理与技术详情',
    '查看证据注脚',
    'data-territory-tone',
    'data-status-tone',
    'task-composer-shell',
    'territory-command-menu',
  ]) assert.match(CONSOLE_APP_HTML, new RegExp(marker))
  assert.match(CONSOLE_APP_HTML, /<html lang="zh-CN" data-theme="forest">/u)
  assert.match(CONSOLE_APP_HTML, /data-theme-choice="forest"[^>]+aria-pressed="true"/u)
  assert.match(CONSOLE_APP_HTML, /data-theme-choice="parchment"[^>]+aria-pressed="false"/u)
  assert.match(CONSOLE_APP_HTML, /id="active-theme-name"[^>]*>森林墨绿</u)
  assert.match(CONSOLE_APP_HTML, /localStorage\.getItem\(THEME_STORAGE_KEY\) \|\| 'forest'/u)
  assert.match(CONSOLE_APP_HTML, /\.realm-map \{ min-height: calc\(100vh - 150px\);[^}]*border: 0 !important;[^}]*background: transparent !important;/u)
  assert.match(CONSOLE_APP_HTML, /\.status-bar \{ position: fixed;[^}]*pointer-events: none;/u)
  assert.match(CONSOLE_APP_HTML, /王国地图/u)
  assert.match(CONSOLE_APP_HTML, /宰相统筹全局，领地主管承接任务，骑士完成使命/u)
  assert.match(CONSOLE_APP_HTML, /当前任务 · /u)
  assert.match(CONSOLE_APP_HTML, /任务状态/u)
  for (const statusLabel of ['异常', '执行中', '待复核', '完成', '待命']) {
    assert.match(CONSOLE_APP_HTML, new RegExp(statusLabel, 'u'))
  }
  assert.doesNotMatch(CONSOLE_APP_HTML, /stateDisplay\(task\.status\) \+ ' · ' \+ text\(task\.taskId\)/u)
})

test('testOrganogramConnectorsFollowActualTerritoryCountAndElementGeometry', () => {
  assert.match(CONSOLE_APP_HTML, /data-branch-count="0"/u)
  assert.match(CONSOLE_APP_HTML, /parent\.dataset\.branchCount = String\(territories\.length\)/u)
  assert.doesNotMatch(CONSOLE_APP_HTML, /territories\.slice\(0, 3\)/u)
  assert.match(CONSOLE_APP_HTML, /id="organogram-connection-layer"/u)
  assert.match(CONSOLE_APP_HTML, /createConnectorPath/u)
  assert.match(CONSOLE_APP_HTML, /drawOrganogramConnectors/u)
  assert.match(CONSOLE_APP_HTML, /ResizeObserver/u)
  assert.match(CONSOLE_APP_HTML, /repeat\(auto-fit, minmax\(min\(100%, 340px\), 1fr\)\)/u)
  assert.match(CONSOLE_APP_HTML, /\.organogram-branches\[data-branch-count="2"\] \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/u)
  assert.match(CONSOLE_APP_HTML, /\.territory-role-network > \.worker-stack \{ display: grid; grid-template-columns: repeat\(auto-fit/u)
  assert.match(CONSOLE_APP_HTML, /\.chancellor-card::after,[\s\S]*?display: none !important;/u)
})

test('testManagementPresentsTheRealChancellorThenTerritorySupervisorRouteFirst', () => {
  for (const marker of ['常用任务流转', '交给宰相统筹', '交给宰相规划', '写下任务，按 / 选择领地', '领地主管承接', '领地主管接手并派发', '主管确认派发']) {
    assert.match(CONSOLE_APP_HTML, new RegExp(marker, 'u'))
  }
  assert.match(CONSOLE_APP_HTML, /按 <kbd>\/<\/kbd> 唤出领地/u)
  assert.match(CONSOLE_APP_HTML, /aria-autocomplete="list"/u)
  assert.match(CONSOLE_APP_HTML, /role="listbox"/u)
  assert.doesNotMatch(CONSOLE_APP_HTML, /id="task-acceptance"/u)
  assert.doesNotMatch(CONSOLE_APP_HTML, /id="task-description"/u)
  assert.match(CONSOLE_APP_HTML, /不会跨领地代派/u)
  assert.match(CONSOLE_APP_HTML, /CONFIG\.commands\.taskCreate[^\n]+\{ title, territory_id: formValue\(form, 'territory_id'\) \}/u)
  assert.match(CONSOLE_APP_HTML, /CONFIG\.commands\.assign[^\n]+task_id:[^\n]+worker_binding_id/u)
})

test('testConsoleMobileUsesSeparatePagesAndAFluidTaskComposer', () => {
  for (const marker of ['王国所有者', '投影版本尚未确认', '可见事项尚未确认', '绑定数量尚未确认', '任务数量尚未确认']) {
    assert.match(CONSOLE_APP_HTML, new RegExp(marker))
  }
  assert.match(CONSOLE_APP_HTML, /@media \(max-width: 640px\)/u)
  assert.match(CONSOLE_APP_HTML, /\.console-shell, \.realm-sidebar, \.console-main, \.main-nav, \.kingdom-status, \.control-stack, \.status-bar, \.status-glossary,[\s\S]*?min-width: 0;[\s\S]*?width: 100%;[\s\S]*?max-width: 100%;/u)
  assert.match(CONSOLE_APP_HTML, /\.zone-head > \*, \.attention-heading > \*, \.data-row > \* \{[\s\S]*?overflow-wrap: anywhere;/u)
  assert.match(CONSOLE_APP_HTML, /\.session-chip \{ max-width: 100%; white-space: normal; overflow-wrap: anywhere; \}/u)
  assert.match(CONSOLE_APP_HTML, /\.evidence-rail \.rail-item code \{ display: none; \}/u)
  assert.match(CONSOLE_APP_HTML, /\[data-console-page\]\[hidden\] \{ display: none !important; \}/u)
  assert.match(CONSOLE_APP_HTML, /pageForSection/u)
  assert.match(CONSOLE_APP_HTML, /\.task-composer-shell \{ position: relative; display: flex/u)
  assert.match(CONSOLE_APP_HTML, /@media \(max-width: 390px\) \{[\s\S]*?\.task-composer-shell \{ display: grid;/u)
  assert.doesNotMatch(CONSOLE_APP_HTML, /投影版本 UNKNOWN/u)
  assert.doesNotMatch(CONSOLE_APP_HTML, /可见事项 UNKNOWN/u)
  assert.doesNotMatch(CONSOLE_APP_HTML, /绑定数量 UNKNOWN/u)
  assert.doesNotMatch(CONSOLE_APP_HTML, /任务数量 UNKNOWN/u)
})

test('testConsoleShellKeepsOwnerBoundaryAndUsesExplicitChineseActionVerbs', () => {
  assert.match(CONSOLE_APP_HTML, /data-owner-onboarding="true"/u)
  assert.match(CONSOLE_APP_HTML, /王国根基设置/u)
  assert.match(CONSOLE_APP_HTML, /人类所有者（OWNER）专属治理写入只能由人类直接输入 Slash 命令/u)
  assert.match(CONSOLE_APP_HTML, /\/kingdom init · DIRECT_SLASH_REQUIRED/u)
  assert.doesNotMatch(CONSOLE_APP_HTML, /setup\.basic/u)
  assert.doesNotMatch(CONSOLE_APP_HTML, /id="setup-basic-form"/u)
  assert.doesNotMatch(CONSOLE_APP_HTML, /data-gated-action="setup\.basic"/u)
  assert.doesNotMatch(CONSOLE_APP_HTML, /CONFIG\.commands\.setup/u)
  assert.doesNotMatch(CONSOLE_APP_HTML, /name="worker_model"/u)
  assert.match(CONSOLE_APP_HTML, />交给宰相规划</u)
  assert.match(CONSOLE_APP_HTML, />主管确认派发</u)
  assert.match(CONSOLE_APP_HTML, />开始执行</u)
  assert.match(CONSOLE_APP_HTML, />暂停</u)
  assert.match(CONSOLE_APP_HTML, />继续</u)
  assert.match(CONSOLE_APP_HTML, />终止</u)
  assert.match(CONSOLE_APP_HTML, />接受呈报</u)
  assert.match(CONSOLE_APP_HTML, />要求返工</u)
  assert.match(CONSOLE_APP_HTML, />判定失败</u)
  assert.match(CONSOLE_APP_HTML, />移交</u)
  assert.match(CONSOLE_APP_HTML, /worker_binding_id/u)
  assert.match(CONSOLE_APP_HTML, /\{"tool:pwsh":true\}/u)
  assert.match(CONSOLE_APP_HTML, /data-review-decision="ACCEPT"/u)
  assert.match(CONSOLE_APP_HTML, /data-review-decision="REWORK"/u)
  assert.match(CONSOLE_APP_HTML, /data-review-decision="FAIL"/u)
  assert.match(CONSOLE_APP_HTML, /data-review-decision="HANDOFF"/u)
  assert.match(CONSOLE_APP_HTML, /DECISION_NOT_AVAILABLE/u)
  assert.match(CONSOLE_APP_HTML, /name="to_binding_id"/u)
  assert.match(CONSOLE_APP_HTML, /name="sandbox_mode"/u)
  assert.match(CONSOLE_APP_HTML, /workspace-write/u)
  assert.match(CONSOLE_APP_HTML, /read-only/u)
  assert.match(CONSOLE_APP_HTML, /execution-control-form/u)
  assert.match(CONSOLE_APP_HTML, /name="execution_id"/u)
  assert.match(CONSOLE_APP_HTML, /execution:pause/u)
  assert.match(CONSOLE_APP_HTML, /execution:resume/u)
  assert.match(CONSOLE_APP_HTML, /execution:abort/u)
  assert.match(CONSOLE_APP_HTML, /pausePending<\/code> 只表示暂停请求已登记/u)
  assert.match(CONSOLE_APP_HTML, /executable=false/u)
  assert.match(CONSOLE_APP_HTML, /DIRECT_SLASH_REQUIRED/u)
  assert.doesNotMatch(CONSOLE_APP_HTML, /name="session_id"/u)
  assert.doesNotMatch(CONSOLE_APP_HTML, /name="principal_id"/u)
  assert.match(CONSOLE_APP_HTML, /OWNER: '王国所有者'/u)
  assert.doesNotMatch(CONSOLE_APP_HTML, /OWNER: 'Owner'/u)
})

test('testConsoleShellUsesCommandEndpointAbstraction', () => {
  assert.equal(CONSOLE_APP_DEFAULT_ENDPOINTS.control, '/api/control')
  assert.equal(CONSOLE_APP_DEFAULT_ENDPOINTS.command, '/api/commands/{command}')
  assert.equal(CONSOLE_APP_DEFAULT_ENDPOINTS.clientHeader, 'x-kingdom-client')
  assert.equal(CONSOLE_APP_DEFAULT_ENDPOINTS.csrfHeader, 'x-kingdom-csrf')
  assert.equal(CONSOLE_APP_DEFAULT_ENDPOINTS.requestIdHeader, 'x-kingdom-request-id')
  assert.equal(Object.hasOwn(CONSOLE_APP_DEFAULT_COMMANDS, 'setup'), false)
  assert.equal(CONSOLE_APP_DEFAULT_COMMANDS.taskCreate, 'plan')
  assert.equal(CONSOLE_APP_DEFAULT_COMMANDS.executionPause, 'execution.pause')
  assert.equal(CONSOLE_APP_DEFAULT_COMMANDS.executionResume, 'execution.resume')
  assert.equal(CONSOLE_APP_DEFAULT_COMMANDS.executionAbort, 'execution.abort')
  assert.equal(CONSOLE_APP_DEFAULT_COMMANDS.controlRevoke, 'control.revoke')
  const customized = renderConsoleApp({
    endpoints: { control: '/control', command: '/control/{command}' },
    commands: { taskCreate: 'task.create' },
  })
  assert.match(customized, /\/control/u)
  assert.match(customized, /task\.create/u)
  assert.match(customized, /\/control\/\{command\}/u)
})

test('testCharacterVisualResolverMapsReviewAndBlockedToThinkingAssets', () => {
  const scriptMatch = CONSOLE_APP_HTML.match(/<script>([\s\S]*?)<\/script>/u)
  assert.ok(scriptMatch)
  const cutoff = scriptMatch[1].indexOf('    const visualFor =')
  assert.notEqual(cutoff, -1)
  const executablePrefix = scriptMatch[1].slice(0, cutoff)
    + '\n    harnessSink.capture = { visualStateFor };\n  })();'
  const fakeDocument = {
    getElementById: () => null,
    querySelectorAll: () => [],
    createElement: () => ({}),
  }
  const harnessSink: { capture?: { visualStateFor: (kind: string, value: string) => string | null } } = {}
  new Function('document', 'harnessSink', executablePrefix)(fakeDocument, harnessSink)
  assert.ok(harnessSink.capture)

  for (const kind of ['CHANCELLOR', 'SUPERVISOR', 'WORKER']) {
    assert.equal(harnessSink.capture.visualStateFor(kind, 'idle'), 'idle')
    assert.equal(harnessSink.capture.visualStateFor(kind, 'working'), 'working')
    assert.equal(harnessSink.capture.visualStateFor(kind, 'review'), 'thinking')
    assert.equal(harnessSink.capture.visualStateFor(kind, 'blocked'), 'thinking')
    assert.equal(harnessSink.capture.visualStateFor(kind, 'reviewing'), 'thinking')
    assert.equal(harnessSink.capture.visualStateFor(kind, 'confused'), 'thinking')
  }
})

test('testHumanStatusTonesAndTerritoryIdentityTonesStayOrthogonal', () => {
  const scriptMatch = CONSOLE_APP_HTML.match(/<script>([\s\S]*?)<\/script>/u)
  assert.ok(scriptMatch)
  const cutoff = scriptMatch[1].indexOf('    const stageMeaning =')
  assert.notEqual(cutoff, -1)
  const executablePrefix = scriptMatch[1].slice(0, cutoff)
    + '\n    harnessSink.capture = { statusTone, taskStatusPresentation, territoryToneAssignments };\n  })();'
  const fakeDocument = {
    getElementById: () => null,
    querySelectorAll: () => [],
    createElement: () => ({}),
  }
  const harnessSink: {
    capture?: {
      statusTone: (value: string) => { tone: string, label: string, icon: string }
      taskStatusPresentation: (tasks: Array<{ title: string, status: string }>, fallback: string) => { presentation: { tone: string }, task: { title: string } | null }
      territoryToneAssignments: (territories: Array<Record<string, unknown>>) => Map<Record<string, unknown>, string>
    }
  } = {}
  new Function('document', 'harnessSink', executablePrefix)(fakeDocument, harnessSink)
  assert.ok(harnessSink.capture)

  assert.deepEqual([
    harnessSink.capture.statusTone('FAILED').tone,
    harnessSink.capture.statusTone('RUNNING').tone,
    harnessSink.capture.statusTone('REVIEW').tone,
    harnessSink.capture.statusTone('DONE').tone,
    harnessSink.capture.statusTone('ASSIGNED').tone,
    harnessSink.capture.statusTone('UNKNOWN').tone,
  ], ['blocked', 'running', 'review', 'done', 'idle', 'unknown'])
  const work = harnessSink.capture.taskStatusPresentation([
    { title: '已经完成的任务', status: 'DONE' },
    { title: '需要处理的异常', status: 'FAILED' },
  ], 'idle')
  assert.equal(work.presentation.tone, 'blocked')
  assert.equal(work.task?.title, '需要处理的异常')

  const territories = [
    { territoryRef: { id: 'territory-a' } },
    { territoryRef: { id: 'territory-b' } },
    { territoryRef: { id: 'territory-c' } },
  ]
  const tones = harnessSink.capture.territoryToneAssignments(territories)
  assert.equal(new Set(territories.map(territory => tones.get(territory))).size, 3)
  assert.match(CONSOLE_APP_HTML, /\.territory-column\[data-territory-tone="2"\]/u)
  assert.match(CONSOLE_APP_HTML, /\.territory-column\[data-status\] \{ background: linear-gradient\(145deg, var\(--territory-wash\)/u)
})

test('testTerritorySelectorRendersEntityRefIdWithoutObjectStringification', () => {
  const scriptMatch = CONSOLE_APP_HTML.match(/<script>([\s\S]*?)<\/script>/u)
  assert.ok(scriptMatch)
  const cutoff = scriptMatch[1].indexOf('    const addDataRow =')
  assert.notEqual(cutoff, -1)
  const executablePrefix = scriptMatch[1].slice(0, cutoff)
    + '\n    harnessSink.capture = { state, renderSelect, renderSelectors };\n  })();'

  type FakeOption = { value: string, textContent: string, className?: string }
  const makeSelect = () => ({
    value: '',
    children: [] as FakeOption[],
    replaceChildren(...children: FakeOption[]) { this.children = children },
    append(child: FakeOption) { this.children.push(child) },
  })
  const selects = new Map([
    ['task-territory', makeSelect()],
    ['assign-worker', makeSelect()],
    ['review-handoff-binding', makeSelect()],
    ['execution-control-id', makeSelect()],
  ])
  const fakeDocument = {
    getElementById: (id: string) => selects.get(id) ?? null,
    querySelectorAll: () => [],
    createElement: () => ({ value: '', textContent: '' }),
  }
  const harnessSink: {
    capture?: {
      state: { snapshot: unknown },
      renderSelect: (id: string, items: unknown[], emptyLabel: string, selected?: string) => void,
      renderSelectors: () => void,
    },
  } = {}
  new Function('document', 'harnessSink', executablePrefix)(fakeDocument, harnessSink)
  assert.ok(harnessSink.capture)

  harnessSink.capture.state.snapshot = {
    projection: {
      organization: {
        data: {
          territories: [{
            territoryRef: { type: 'territory', id: 'territory-projected' },
            name: '投影领地',
          }, {
            territoryRef: { type: 'binding', id: 'territory-wrong-type' },
            territoryId: 'territory-legacy-conflict',
            name: '错类型领地',
          }],
          roles: [{
            bindingRef: { type: 'binding', id: 'worker-active' },
            roleType: 'WORKER',
            roleName: '在任执行者',
            status: { sourceKind: 'GOVERNANCE_FACT', value: 'ACTIVE', sourceRefs: [] },
          }, {
            bindingRef: { type: 'binding', id: 'worker-inactive' },
            roleType: 'WORKER',
            roleName: '离任执行者',
            status: { sourceKind: 'GOVERNANCE_FACT', value: 'INACTIVE', sourceRefs: [] },
          }, {
            bindingRef: { type: 'binding', id: 'worker-retired' },
            roleType: 'WORKER',
            roleName: '已退役执行者',
            status: { sourceKind: 'GOVERNANCE_FACT', value: 'RETIRED', sourceRefs: [] },
          }, {
            bindingRef: { type: 'binding', id: 'worker-status-missing' },
            roleType: 'WORKER',
            roleName: '状态缺失执行者',
          }, {
            bindingRef: { type: 'territory', id: 'worker-wrong-type' },
            roleType: 'WORKER',
            roleName: '错类型执行者',
            status: { sourceKind: 'GOVERNANCE_FACT', value: 'ACTIVE', sourceRefs: [] },
          }, {
            bindingRef: { type: 'binding', id: 'supervisor-active' },
            roleType: 'SUPERVISOR',
            roleName: '在任监督者',
            status: { sourceKind: 'GOVERNANCE_FACT', value: 'ACTIVE', sourceRefs: [] },
          }],
        },
      },
      executions: {
        data: {
          items: [{
            executionId: 'execution-legacy-conflict',
            taskId: 'task-legacy-conflict',
            executionRef: { type: 'execution', id: 'execution-canonical' },
            taskRef: { type: 'task', id: 'task-canonical' },
            authoritativeState: { sourceKind: 'RUNTIME_OBSERVATION', value: 'RECOVERING', sourceRefs: [] },
          }, {
            executionId: 'execution-legacy-wrong-ref',
            taskId: 'task-wrong-ref',
            executionRef: { type: 'task', id: 'not-an-execution' },
            taskRef: { type: 'task', id: 'task-wrong-ref' },
            authoritativeState: { sourceKind: 'RUNTIME_OBSERVATION', value: 'RUNNING', sourceRefs: [] },
          }],
        },
      },
    },
    bindings: [{ bindingId: 'worker-legacy-shadow', roleType: 'WORKER', roleName: '旧投影执行者' }],
  }
  harnessSink.capture.renderSelectors()
  assert.deepEqual(selects.get('task-territory')?.children.map(option => option.value), ['', 'territory-projected'])
  assert.deepEqual(selects.get('assign-worker')?.children.map(option => option.value), ['', 'worker-active'])
  assert.deepEqual(selects.get('review-handoff-binding')?.children.map(option => option.value), ['', 'worker-active'])
  assert.deepEqual(selects.get('execution-control-id')?.children.map(option => option.value), ['', 'execution-canonical'])
  assert.doesNotMatch(selects.get('task-territory')?.children.map(option => option.value).join('|') ?? '', /legacy-conflict|wrong-type/u)
  assert.doesNotMatch(selects.get('assign-worker')?.children.map(option => option.value).join('|') ?? '', /wrong-type/u)
  assert.doesNotMatch(selects.get('execution-control-id')?.children.map(option => option.value).join('|') ?? '', /legacy-conflict|wrong-ref/u)
  assert.doesNotMatch(selects.get('task-territory')?.children.map(option => option.value).join('|') ?? '', /\[object Object\]/u)

  harnessSink.capture.state.snapshot = {
    projection: {
      organization: {
        data: {
          territories: [{
            territoryRef: { entityType: 'territory', entityId: 'territory-compatible' },
            name: '兼容引用领地',
          }],
        },
      },
    },
  }
  harnessSink.capture.renderSelectors()
  assert.deepEqual(selects.get('task-territory')?.children.map(option => option.value), ['', 'territory-compatible'])

  harnessSink.capture.state.snapshot = {
    projection: { organization: { data: {} } },
    territories: [{ territoryId: 'territory-legacy', name: '兼容领地' }],
    bindings: [{ bindingId: 'worker-legacy', roleType: 'WORKER', roleName: '兼容执行者' }],
  }
  harnessSink.capture.renderSelectors()
  assert.deepEqual(selects.get('task-territory')?.children.map(option => option.value), ['', 'territory-legacy'])
  assert.deepEqual(selects.get('assign-worker')?.children.map(option => option.value), [''])
  assert.deepEqual(selects.get('review-handoff-binding')?.children.map(option => option.value), [''])

  harnessSink.capture.state.snapshot = {
    projection: { organization: { data: { roles: [], territories: [] } } },
    territories: [{ territoryId: 'territory-legacy-empty-shadow', name: '不应回退的旧领地' }],
    bindings: [{ bindingId: 'worker-legacy-empty-shadow', roleType: 'WORKER', roleName: '显式空投影旧执行者' }],
  }
  harnessSink.capture.renderSelectors()
  assert.deepEqual(selects.get('task-territory')?.children.map(option => option.value), [''])
  assert.deepEqual(selects.get('assign-worker')?.children.map(option => option.value), [''])
  assert.deepEqual(selects.get('review-handoff-binding')?.children.map(option => option.value), [''])

  harnessSink.capture.renderSelect('task-territory', [{ value: { id: 'must-not-stringify' }, label: '非法对象值' }], '由宿主选择领地')
  assert.deepEqual(selects.get('task-territory')?.children.map(option => option.value), ['', ''])
  assert.doesNotMatch(selects.get('task-territory')?.children.map(option => option.value).join('|') ?? '', /\[object Object\]/u)
  assert.match(CONSOLE_APP_HTML, /const canonicalId = ref\.id/u)
  assert.match(CONSOLE_APP_HTML, /const compatibleId = ref\.entityId/u)
  assert.match(CONSOLE_APP_HTML, /const typedEntityId =/u)
  assert.match(CONSOLE_APP_HTML, /if \(hasEntityReference\(item\.executionRef\)\) return typedEntityId\(item\.executionRef, 'execution'\)/u)
  assert.match(CONSOLE_APP_HTML, /canonicalOrLegacyEntityId\(item\.territoryRef, item\.territoryId, 'territory'\)/u)
  assert.doesNotMatch(CONSOLE_APP_HTML, /value: item\.territoryRef \|\| item\.territoryId/u)
})

test('testCharacterInlineSvgUsesAllowlistStableSameAssetAndFailsClosedWhenMissing', () => {
  const scriptMatch = CONSOLE_APP_HTML.match(/<script>([\s\S]*?)<\/script>/u)
  assert.ok(scriptMatch)
  const cutoff = scriptMatch[1].indexOf('    const ownerRoleName =')
  assert.notEqual(cutoff, -1)
  const executablePrefix = scriptMatch[1].slice(0, cutoff)
    + '\n    harnessSink.capture = { applyCharacterVisual };\n  })();'

  let inlineParseCount = 0
  const makeSvg = () => ({
    tagName: 'svg',
    attributes: {} as Record<string, string>,
    setAttribute(name: string, value: string) { this.attributes[name] = value },
  })
  const image = {
    dataset: {} as Record<string, string>,
    hidden: false,
    attributes: {} as Record<string, string>,
    children: [] as unknown[],
    getAttribute(name: string) { return this.attributes[name] ?? null },
    setAttribute(name: string, value: string) { this.attributes[name] = value },
    removeAttribute(name: string) { delete this.attributes[name] },
    replaceChildren(...children: unknown[]) { this.children = children },
  }
  const fakeDocument = {
    getElementById: () => null,
    querySelectorAll: () => [],
    createElement: (tagName: string) => tagName === 'template'
      ? {
          content: {
            querySelector: (selector: string) => selector === 'svg' ? makeSvg() : null,
            firstElementChild: makeSvg(),
          },
          set innerHTML(_value: string) { inlineParseCount += 1 },
        }
      : ({ dataset: {}, children: [], append() {}, replaceChildren() {} }),
  }
  const harnessSink: {
    capture?: {
      applyCharacterVisual: (target: typeof image, kind: string, visual: { evidence: string, visualState: string, asset: string }) => void
    }
  } = {}
  new Function('document', 'harnessSink', executablePrefix)(fakeDocument, harnessSink)
  assert.ok(harnessSink.capture)

  const missingVisual = { evidence: 'exact', visualState: 'thinking', asset: '/gui-assets/characters/missing.svg' }
  harnessSink.capture.applyCharacterVisual(image, 'CHANCELLOR', missingVisual)
  harnessSink.capture.applyCharacterVisual(image, 'CHANCELLOR', missingVisual)
  assert.equal(image.hidden, true)
  assert.equal(image.children.length, 0)
  assert.equal(image.dataset.resourceState, 'unavailable')
  assert.match(image.getAttribute('aria-label') ?? '', /角色资源不可用/u)

  const recoveredVisual = { evidence: 'exact', visualState: 'idle', asset: '/gui-assets/characters/chancellor-idle.svg' }
  harnessSink.capture.applyCharacterVisual(image, 'CHANCELLOR', recoveredVisual)
  assert.equal(inlineParseCount, 1, 'a valid allowlisted asset is parsed once')
  assert.equal(image.hidden, false)
  assert.equal(image.dataset.resourceState, 'inline')
  assert.equal(image.children.length, 1)
  assert.equal((image.children[0] as { tagName: string }).tagName, 'svg')
  assert.equal(image.getAttribute('src'), null)
  assert.equal(image.getAttribute('aria-label'), '宰相像素人物')
  harnessSink.capture.applyCharacterVisual(image, 'CHANCELLOR', recoveredVisual)
  assert.equal(inlineParseCount, 1, 'the same inline SVG asset is not rebuilt on polling')
  for (const assetName of GUI_CHARACTER_ASSET_FILES) {
    assert.match(GUI_CHARACTER_ASSET_SVGS[assetName] ?? '', /<svg[\s\S]*@keyframes/u, `${assetName} is embedded in the registry`)
  }
  assert.match(CONSOLE_APP_HTML, /const CHARACTER_SVGS =/u)
  assert.match(CONSOLE_APP_HTML, /data-runtime-state/u)
})

test('testConsoleRendersAuthoritativeOrganizationAndTypedEvidenceRefs', () => {
  const scriptMatch = CONSOLE_APP_HTML.match(/<script>([\s\S]*?)<\/script>/u)
  assert.ok(scriptMatch)
  const cutoff = scriptMatch[1].indexOf('const renderSnapshot =')
  assert.notEqual(cutoff, -1)
  const executablePrefix = scriptMatch[1].slice(0, cutoff)
    + '\n    harnessSink.capture = { state, renderKingdomMap, renderOrganization, renderExecutions, renderTimeline, renderAttention };\n  })();'

  type FakeNode = {
    tagName: string
    textContent: string
    className: string
    children: FakeNode[]
    dataset: Record<string, string>
    attributes: Record<string, string>
    append: (...children: FakeNode[]) => void
    replaceChildren: (...children: FakeNode[]) => void
    setAttribute: (name: string, value: string) => void
  }
  const makeNode = (tagName = 'div'): FakeNode => ({
    tagName,
    textContent: '',
    className: '',
    children: [],
    dataset: {},
    attributes: {},
    append(...children) { this.children.push(...children) },
    replaceChildren(...children) { this.children = children },
    setAttribute(name, value) { this.attributes[name] = value },
  })
  const nodes = new Map<string, FakeNode>([
    ['organization-content', makeNode()],
    ['realm-owner-name', makeNode()],
    ['realm-chancellor-name', makeNode()],
    ['realm-chancellor-meta', makeNode()],
    ['realm-supervisor-name', makeNode()],
    ['realm-supervisor-meta', makeNode()],
    ['realm-worker-name', makeNode()],
    ['realm-worker-meta', makeNode()],
    ['territory-map-list', makeNode()],
    ['timeline-content', makeNode()],
    ['attention-content', makeNode()],
    ['attention-count', makeNode()],
    ['execution-content', makeNode()],
  ])
  const fakeDocument = {
    getElementById: (id: string) => nodes.get(id) ?? null,
    querySelectorAll: () => [],
    createElement: (tagName: string) => makeNode(tagName),
  }
  const harnessSink: {
    capture?: {
      state: { snapshot: unknown; selectedExecutionId: string }
      renderKingdomMap: (snapshot: unknown, organizationData: unknown, taskCount: number) => void
      renderOrganization: (snapshot: unknown) => void
      renderExecutions: (snapshot: unknown) => void
      renderTimeline: (snapshot: unknown) => void
      renderAttention: (snapshot: unknown) => void
    }
  } = {}
  new Function('document', 'harnessSink', executablePrefix)(fakeDocument, harnessSink)
  assert.ok(harnessSink.capture)

  const snapshot = {
    kingdom: { name: '真实形状王国' },
    bindings: [{ bindingId: 'worker-legacy-shadow', roleType: 'WORKER', roleName: '不应覆盖的旧执行者' }],
    projection: {
      organization: {
        data: {
          kingdomName: '真实形状王国',
          bindingCount: 2,
          territoryCount: 1,
          roles: [{
            bindingRef: { type: 'binding', id: 'retired-supervisor' },
            roleType: 'SUPERVISOR',
            roleName: '退役主管不应渲染',
            territoryRef: { type: 'territory', id: 'territory-attention' },
            status: { sourceKind: 'GOVERNANCE_FACT', value: 'RETIRED', sourceRefs: [] },
          }, {
            bindingRef: { type: 'binding', id: 'retired-worker' },
            roleType: 'WORKER',
            roleName: '退役骑士不应渲染',
            territoryRef: { type: 'territory', id: 'territory-attention' },
            status: { sourceKind: 'GOVERNANCE_FACT', value: 'RETIRED', sourceRefs: [] },
          }],
          territories: [{
            territoryRef: { type: 'territory', id: 'territory-attention' },
            name: '待关注领地',
            status: {
              sourceKind: 'GOVERNANCE_FACT',
              value: 'ATTENTION',
              sourceRefs: [{ sourceType: 'table-row', entityType: 'territories', entityId: 'territory-attention' }],
            },
          }],
        },
      },
      executions: {
        data: {
          items: [{
            executionId: 'execution-legacy-conflict',
            taskId: 'task-legacy-conflict',
            executionRef: { type: 'execution', id: 'execution-canonical' },
            taskRef: { type: 'task', id: 'task-canonical' },
            authoritativeState: { sourceKind: 'RUNTIME_OBSERVATION', value: 'RECOVERING', sourceRefs: [] },
            executionContract: 'GOVERNED_PERSISTENT',
            pausePending: false,
          }],
        },
      },
      timeline: {
        data: [{
          id: 'timeline-real-shape',
          kind: 'GOVERNANCE_FACT',
          occurredAt: '2026-08-23T00:00:00.000Z',
          entityRef: { type: 'task', id: 'task-timeline' },
          authoritativeState: { sourceKind: 'GOVERNANCE_FACT', value: 'REVIEW', sourceRefs: [] },
          sourceRefs: [
            { sourceType: 'table-row', entityType: 'tasks', entityId: 'task-timeline' },
            { sourceType: 'event', entityType: 'events', entityId: null, eventSeq: 41 },
            { sourceType: 'derived-rule', entityType: 'projection-rule', entityId: null, ruleCode: 'TIMELINE_RULE' },
            { sourceType: 'runtime-evidence', entityType: 'runtime-observation', entityId: null },
          ],
          allowedActions: null,
          attentionReason: null,
          terminality: 'NON_TERMINAL',
          summary: '史册任务记录',
          requiresOwnerAction: false,
          rawEvidenceAvailable: false,
        }],
      },
      attention: {
        data: [{
          id: 'attention-real-shape',
          severity: 'ATTENTION',
          entityRef: { type: 'task', id: 'task-attention' },
          reason: { code: 'TASK_NEEDS_REVIEW', sourceRefs: [] },
          summary: '待裁决任务记录',
          sourceRefs: [
            { sourceType: 'event', entityType: 'events', entityId: null, eventSeq: 42 },
            { sourceType: 'derived-rule', entityType: 'projection-rule', entityId: null, ruleCode: 'ATTENTION_RULE' },
          ],
        }],
      },
    },
  }
  harnessSink.capture.state.snapshot = snapshot
  harnessSink.capture.state.selectedExecutionId = 'execution-canonical'
  harnessSink.capture.renderKingdomMap(snapshot, snapshot.projection.organization.data, 0)
  harnessSink.capture.renderOrganization(snapshot)
  harnessSink.capture.renderExecutions(snapshot)
  harnessSink.capture.renderTimeline(snapshot)
  harnessSink.capture.renderAttention(snapshot)

  const flattenedText = (node: FakeNode): string => [node.textContent, ...node.children.map(flattenedText)].filter(Boolean).join(' ')
  const countNodes = (node: FakeNode, predicate: (candidate: FakeNode) => boolean): number => (predicate(node) ? 1 : 0) + node.children.reduce((total, child) => total + countNodes(child, predicate), 0)
  const organizationText = flattenedText(nodes.get('organization-content')!)
  const executionText = flattenedText(nodes.get('execution-content')!)
  const timelineText = flattenedText(nodes.get('timeline-content')!)
  const attentionText = flattenedText(nodes.get('attention-content')!)
  assert.match(organizationText, /需要留意 ATTENTION/u)
  assert.equal(nodes.get('realm-supervisor-name')?.textContent, '尚未投影')
  assert.equal(nodes.get('realm-worker-name')?.textContent, '尚未投影')
  assert.doesNotMatch(organizationText, /退役主管不应渲染|退役骑士不应渲染/u)
  assert.equal(countNodes(nodes.get('territory-map-list')!, node => node.className === 'org-node'), 0, 'retired roles do not create organogram nodes')
  assert.equal(countNodes(nodes.get('territory-map-list')!, node => node.className === 'pixel-sprite'), 0, 'retired roles do not create pixel characters')
  assert.match(executionText, /执行编号 · 运行观察 execution-canonical/u)
  assert.match(executionText, /所属任务 task-canonical/u)
  assert.match(executionText, /执行状态 恢复核对中 RECOVERING/u)
  assert.doesNotMatch(executionText, /execution-legacy-conflict|task-legacy-conflict/u)
  assert.match(timelineText, /实体引用 task:task-timeline/u)
  assert.doesNotMatch(timelineText, /task-attention/u)
  assert.match(attentionText, /实体引用 task:task-attention/u)
  assert.doesNotMatch(attentionText, /task-timeline/u)
  assert.match(timelineText, /表 tasks:task-timeline/u)
  assert.match(timelineText, /事件 #41/u)
  assert.match(timelineText, /规则 TIMELINE_RULE/u)
  assert.match(timelineText, /运行证据 runtime-observation/u)
  assert.match(attentionText, /事件 #42/u)
  assert.match(attentionText, /规则 ATTENTION_RULE/u)
  assert.doesNotMatch([organizationText, timelineText, attentionText].join(' '), /\[object Object\]|UNKNOWN/u)

  const explicitEmptyOrganization = {
    kingdom: { name: '显式空组织王国' },
    territories: [{ territoryId: 'territory-legacy-without-count', name: '不应回退的旧领地' }],
    bindings: [{ bindingId: 'worker-legacy-without-count', roleType: 'WORKER', roleName: '不应推导计数的旧执行者' }],
    projection: { organization: { data: { roles: [], territories: [] } } },
  }
  harnessSink.capture.renderKingdomMap(explicitEmptyOrganization, explicitEmptyOrganization.projection.organization.data, 0)
  harnessSink.capture.renderOrganization(explicitEmptyOrganization)
  const explicitEmptyOrganizationText = flattenedText(nodes.get('organization-content')!)
  const explicitEmptyTerritoryMapText = flattenedText(nodes.get('territory-map-list')!)
  assert.match(explicitEmptyOrganizationText, /领地数量 0/u)
  assert.match(explicitEmptyOrganizationText, /成员绑定数量 0/u)
  assert.doesNotMatch(explicitEmptyOrganizationText, /不应推导计数的旧执行者/u)
  assert.doesNotMatch(explicitEmptyOrganizationText, /不应回退的旧领地/u)
  assert.doesNotMatch(explicitEmptyTerritoryMapText, /不应回退的旧领地/u)
})

test('testExpiredCapabilitiesDisableMutationControls', () => {
  const expired = normalizeConsoleCapabilities({
    state: 'ACTIVE',
    expiresAt: '2020-01-01T00:00:00.000Z',
    actions: { start: { executable: true } },
  }, Date.parse('2020-01-02T00:00:00.000Z'))
  assert.equal(expired.state, 'EXPIRED')
  assert.deepEqual(resolveConsoleActionState(expired, 'start'), {
    action: 'start', executable: false, disabledReason: 'SESSION_AUTH_REQUIRED',
  })
})

test('testActiveCapabilitiesExposeCoveredActions', () => {
  const active = normalizeConsoleCapabilities({
    active: true,
    state: 'ACTIVE',
    csrfToken: 'transport-only-token',
    roleSessionBound: true,
    commands: ['control.revoke'],
    reviewDecisions: ['ACCEPT', 'REWORK', 'FAIL', 'HANDOFF'],
    sandboxModes: ['workspace-write', 'read-only'],
    actions: {
      plan: { enabled: true },
      assign: true,
      start: { allowed: true },
      'review:accept': { executable: true },
      'review:handoff': { executable: true },
      'execution.pause': { executable: true },
      'control.revoke': { executable: true },
    },
  })
  assert.equal(active.state, 'ACTIVE')
  assert.equal(active.active, true)
  assert.equal(active.csrfToken, 'transport-only-token')
  assert.equal(active.roleSessionBound, true)
  assert.deepEqual(active.commands, ['control.revoke'])
  assert.deepEqual(active.reviewDecisions, ['ACCEPT', 'REWORK', 'FAIL', 'HANDOFF'])
  assert.deepEqual(active.sandboxModes, ['workspace-write', 'read-only'])
  assert.deepEqual(resolveConsoleActionState(active, 'owner.onboarding', true), {
    action: 'owner.onboarding', executable: false, disabledReason: 'DIRECT_SLASH_REQUIRED',
  })
  assert.equal(resolveConsoleActionState(active, 'task.create').executable, true)
  assert.equal(resolveConsoleActionState(active, 'assign').executable, true)
  assert.equal(resolveConsoleActionState(active, 'start').executable, true)
  assert.equal(resolveConsoleActionState(active, 'review:accept').executable, true)
  assert.equal(resolveConsoleActionState(active, 'review:handoff').executable, true)
  assert.equal(resolveConsoleActionState(active, 'execution:pause').executable, true)
  assert.equal(resolveConsoleActionState(active, 'control.revoke').executable, true)
})

test('testActiveControlViewDerivesActiveWithoutStateField', () => {
  const control = normalizeConsoleCapabilities({
    active: true,
    expiresAt: '2099-01-01T00:00:00.000Z',
    csrfToken: 'transport-only-token',
    roleSessionBound: true,
    commands: ['plan', 'assign', 'start', 'review', 'control.revoke'],
    actions: { 'control.revoke': { executable: true } },
    disabledReason: null,
  })
  assert.equal(control.state, 'ACTIVE')
  assert.equal(control.active, true)
  assert.equal(control.csrfToken, 'transport-only-token')
  assert.equal(control.roleSessionBound, true)
  assert.equal(resolveConsoleActionState(control, 'control.revoke').executable, true)
})

test('testMissingCapabilityUsesStableFailureCode', () => {
  const active = normalizeConsoleCapabilities({ state: 'ACTIVE', actions: {} })
  assert.deepEqual(resolveConsoleActionState(active, 'owner.onboarding', true), {
    action: 'owner.onboarding', executable: false, disabledReason: 'DIRECT_SLASH_REQUIRED',
  })
  assert.deepEqual(resolveConsoleActionState(active, 'start'), {
    action: 'start', executable: false, disabledReason: 'UNKNOWN',
  })
  assert.equal(resolveConsoleActionState(normalizeConsoleCapabilities({ state: 'FAILED' }), 'start').disabledReason, 'UNKNOWN')
  assert.equal(resolveConsoleActionState(normalizeConsoleCapabilities({ state: 'EXPIRED' }), 'start').disabledReason, 'SESSION_AUTH_REQUIRED')
})

test('testCommandNamesDoNotAuthorizeActionsWithoutStructuredHostAvailability', () => {
  const active = normalizeConsoleCapabilities({ state: 'ACTIVE', commands: ['start', 'execution.pause'] })
  assert.deepEqual(active.commands, ['start', 'execution.pause'])
  assert.equal(resolveConsoleActionState(active, 'start').executable, false)
  assert.equal(resolveConsoleActionState(active, 'execution:pause').executable, false)
})

test('testResourceActionsRequireStructuredExecutableProjection', () => {
  const active = normalizeConsoleCapabilities({
    state: 'ACTIVE',
    actions: { start: { executable: true }, 'execution.pause': { executable: true } },
  })
  assert.deepEqual(normalizeConsoleAllowedActions(['start']), {
    start: { executable: false, disabledReason: 'UNKNOWN' },
  })
  assert.equal(resolveConsoleResourceActionState(active, ['start'], 'start').executable, false)
  assert.equal(resolveConsoleResourceActionState(active, [{ action: 'start', executable: true }], 'start').executable, true)
  assert.equal(resolveConsoleResourceActionState(active, { start: { executable: true } }, 'start').executable, true)
  assert.equal(resolveConsoleResourceActionState(active, [{ action: 'execution:pause', executable: true }], 'execution:pause').executable, true)
  assert.deepEqual(resolveConsoleResourceActionState(active, [{ action: 'start', executable: false, disabledReason: 'SCOPE_MISMATCH' }], 'start'), {
    action: 'start', executable: false, disabledReason: 'SCOPE_MISMATCH',
  })
  assert.match(CONSOLE_APP_HTML, /return \{ present: true, actions: normalizeAllowedActions\(candidate\) \}/u)
})

test('testFragmentNavigationIsStableAndUnrecognizedHashesFailSoft', () => {
  assert.deepEqual(parseConsoleFragment(''), { known: true, section: 'overview', taskId: null })
  assert.deepEqual(parseConsoleFragment('#organization'), { known: true, section: 'organization', taskId: null })
  assert.deepEqual(parseConsoleFragment('#management'), { known: true, section: 'management', taskId: null })
  assert.deepEqual(parseConsoleFragment('#ledger'), { known: true, section: 'ledger', taskId: null })
  assert.deepEqual(parseConsoleFragment('#task=task%2Fwith%20space'), { known: true, section: 'tasks', taskId: 'task/with space' })
  assert.deepEqual(parseConsoleFragment('#task='), { known: false, section: 'overview', taskId: null })
  assert.deepEqual(parseConsoleFragment('#not-a-console-section'), { known: false, section: 'overview', taskId: null })
})

test('testOlderTaskDetailResponseCannotReplaceNewerSelection', () => {
  const detailA = { task: { taskId: 'task-a' } }
  assert.equal(shouldCommitConsoleTaskDetail('task-b', 'task-a', detailA, 1, 2), false)
  assert.equal(shouldCommitConsoleTaskDetail('task-a', 'task-a', detailA, 1, 2), false)
  assert.equal(shouldCommitConsoleTaskDetail('task-b', 'task-b', detailA, 2, 2), false)
  assert.equal(shouldCommitConsoleTaskDetail('task-a', 'task-a', detailA, 2, 2), true)
  assert.equal(shouldCommitConsoleTaskDetail('task-a', 'task-a', {}, 2, 2), false)
  assert.match(CONSOLE_APP_HTML, /if \(state\.selectedTaskId !== previousTaskId\) \{ state\.detail = null; state\.detailTaskId = ''; state\.detailEpoch \+= 1; \}/u)
})

test('testEmbeddedSelectionPreservesTrustedDetailAndSuccessfulPostRefreshesExactlyOnce', async () => {
  const scriptMatch = CONSOLE_APP_HTML.match(/<script>([\s\S]*?)<\/script>/u)
  assert.ok(scriptMatch)
  const cutoff = scriptMatch[1].indexOf('const revokeControl =')
  assert.notEqual(cutoff, -1)
  const executablePrefix = scriptMatch[1].slice(0, cutoff)
    + '\n    harnessSink.capture = { state, selectTask, load, submit };\n  })();'

  type EmbeddedNode = {
    id: string
    tagName: string
    textContent: string
    className: string
    value: string
    disabled: boolean
    hidden: boolean
    open: boolean
    children: EmbeddedNode[]
    dataset: Record<string, string>
    attributes: Record<string, string>
    append: (...children: EmbeddedNode[]) => void
    replaceChildren: (...children: EmbeddedNode[]) => void
    setAttribute: (name: string, value: string) => void
    getAttribute: (name: string) => string | null
    removeAttribute: (name: string) => void
    scrollIntoView: () => void
  }
  const makeNode = (tagName = 'div', id = ''): EmbeddedNode => ({
    id,
    tagName,
    textContent: '',
    className: '',
    value: '',
    disabled: false,
    hidden: false,
    open: false,
    children: [],
    dataset: {},
    attributes: {},
    append(...children) { this.children.push(...children) },
    replaceChildren(...children) { this.children = children },
    setAttribute(name, value) { this.attributes[name] = value },
    getAttribute(name) { return this.attributes[name] ?? null },
    removeAttribute(name) { delete this.attributes[name] },
    scrollIntoView() {},
  })
  const nodes = new Map<string, EmbeddedNode>()
  const nodeFor = (id: string): EmbeddedNode => {
    let node = nodes.get(id)
    if (!node) {
      node = makeNode('div', id)
      nodes.set(id, node)
    }
    return node
  }
  const actionButton = nodeFor('embedded-action')
  actionButton.setAttribute('data-gated-action', 'task.create')
  const reasonNode = nodeFor('embedded-action-reason')
  const fakeDocument = {
    getElementById: (id: string) => nodeFor(id),
    querySelectorAll: (selector: string) => selector === '[data-gated-action]' ? [actionButton] : [],
    querySelector: (selector: string) => selector.includes('data-reason-for') ? reasonNode : null,
    createElement: (tagName: string) => makeNode(tagName),
  }
  const fakeLocation = { hash: '#task=task-a' }
  const fakeHistory = {
    pushState(_state: unknown, _title: string, url: string) { fakeLocation.hash = url },
  }
  const fetchCalls: Array<{ url: string, method: string }> = []
  let postOutcome: 'success' | 'unknown' = 'success'
  let releaseSuccessfulPost: (() => void) | null = null
  const fakeResponse = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })
  const emptySnapshot = () => ({
    revision: 2,
    kingdom: null,
    bindings: [],
    territories: [],
    tasks: [],
    liveExecutions: [],
    projection: {
      overview: { data: { health: 'UNKNOWN', taskCount: 0, activeExecutionCount: 0, statusCounts: {}, ownerActions: [] } },
      organization: { data: { kingdomName: null, bindingCount: 0, territoryCount: 0, roles: [], territories: [], rolesTruncated: false, territoriesTruncated: false } },
      executions: { data: { items: [] } },
      timeline: { data: [] },
      attention: { data: [] },
    },
  })
  const fakeFetch = async (input: unknown, init?: { method?: string }) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    fetchCalls.push({ url, method })
    if (method === 'POST') {
      if (postOutcome === 'unknown') {
        throw Object.assign(new Error('COMMAND_RESULT_UNKNOWN'), { code: 'UNKNOWN' })
      }
      return await new Promise(resolve => {
        releaseSuccessfulPost = () => resolve(fakeResponse({ ok: true }))
      })
    }
    if (url.startsWith('/api/tasks/')) {
      const taskId = decodeURIComponent(url.slice('/api/tasks/'.length))
      return fakeResponse({ task: { taskId, title: '明细 ' + taskId, status: 'RUNNING', attemptCount: 0 } })
    }
    if (url === '/api/control') {
      return fakeResponse({ state: 'ACTIVE', active: true, csrfToken: 'transport-token', actions: { plan: { executable: true } }, reviewDecisions: [], sandboxModes: [] })
    }
    if (url === '/api/snapshot') return fakeResponse(emptySnapshot())
    throw new Error('UNEXPECTED_FETCH ' + method + ' ' + url)
  }
  const harnessSink: {
    capture?: {
      state: {
        capabilities: unknown
        snapshot: unknown
        detail: unknown
        detailTaskId: string
        detailEpoch: number
        selectedTaskId: string
        navigationHash: string | null
        loading: boolean
        commandBusy: boolean
        commandRefreshPending: boolean
        stale: boolean
      }
      selectTask: (taskId: string, pushHistory: boolean) => void
      load: (silent: boolean, commandRefresh?: boolean) => Promise<void>
      submit: (commandName: string, payload: Record<string, unknown>, action: string, ownerOnly: boolean, resourceScope?: string) => Promise<void>
    }
  } = {}
  new Function('document', 'location', 'history', 'fetch', 'harnessSink', executablePrefix)(
    fakeDocument,
    fakeLocation,
    fakeHistory,
    fakeFetch,
    harnessSink,
  )
  assert.ok(harnessSink.capture)

  const taskA = { taskId: 'task-a', title: '任务甲', status: 'RUNNING', attemptCount: 1, allowedActions: [] }
  const taskB = { taskId: 'task-b', title: '任务乙', status: 'RUNNING', attemptCount: 1, allowedActions: [] }
  const trustedDetailA = { task: taskA, projection: { data: {} } }
  harnessSink.capture.state.snapshot = { tasks: [taskA, taskB], projection: { executions: { data: { items: [] } } } }
  harnessSink.capture.state.selectedTaskId = 'task-a'
  harnessSink.capture.state.detail = trustedDetailA
  harnessSink.capture.state.detailTaskId = 'task-a'
  harnessSink.capture.selectTask('task-a', true)
  assert.strictEqual(harnessSink.capture.state.detail, trustedDetailA)
  assert.equal(harnessSink.capture.state.detailTaskId, 'task-a')
  assert.equal(fakeLocation.hash, '#task=task-a')
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(fetchCalls.filter(call => call.url.startsWith('/api/tasks/')).length, 0)

  harnessSink.capture.state.selectedTaskId = 'task-a'
  harnessSink.capture.state.detail = trustedDetailA
  harnessSink.capture.state.detailTaskId = 'task-a'
  const previousEpoch = harnessSink.capture.state.detailEpoch
  harnessSink.capture.selectTask('task-b', true)
  assert.equal(harnessSink.capture.state.detail, null)
  assert.equal(harnessSink.capture.state.detailTaskId, '')
  assert.ok(harnessSink.capture.state.detailEpoch > previousEpoch)
  assert.equal(fakeLocation.hash, '#task=task-b')
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(fetchCalls.filter(call => call.url.startsWith('/api/tasks/')).map(call => call.url), ['/api/tasks/task-b'])

  fakeLocation.hash = '#overview'
  harnessSink.capture.state.navigationHash = '#overview'
  harnessSink.capture.state.snapshot = emptySnapshot()
  harnessSink.capture.state.selectedTaskId = ''
  harnessSink.capture.state.detail = null
  harnessSink.capture.state.detailTaskId = ''
  harnessSink.capture.state.capabilities = {
    state: 'ACTIVE',
    active: true,
    csrfToken: 'transport-token',
    roleSessionBound: true,
    commands: ['plan'],
    reviewDecisions: [],
    sandboxModes: [],
    disabledReason: null,
    actions: { plan: { executable: true, disabledReason: null } },
  }
  harnessSink.capture.state.stale = false
  fetchCalls.length = 0
  postOutcome = 'success'
  releaseSuccessfulPost = null
  const successfulSubmit = harnessSink.capture.submit('plan', { title: '新任务' }, 'task.create', false)
  assert.equal(harnessSink.capture.state.commandBusy, true)
  assert.equal(actionButton.disabled, true)
  assert.deepEqual(fetchCalls, [{ url: '/api/commands/plan', method: 'POST' }])
  await harnessSink.capture.load(true)
  assert.deepEqual(fetchCalls, [{ url: '/api/commands/plan', method: 'POST' }])
  assert.ok(releaseSuccessfulPost)
  releaseSuccessfulPost()
  await successfulSubmit
  assert.equal(harnessSink.capture.state.commandBusy, false)
  assert.equal(fetchCalls.filter(call => call.method === 'POST').length, 1)
  assert.equal(fetchCalls.filter(call => call.url === '/api/control').length, 1)
  assert.equal(fetchCalls.filter(call => call.url === '/api/snapshot').length, 1)
  assert.equal(fetchCalls.filter(call => call.url.startsWith('/api/tasks/')).length, 0)

  fetchCalls.length = 0
  postOutcome = 'unknown'
  await harnessSink.capture.submit('plan', { title: '结果未知任务' }, 'task.create', false)
  assert.deepEqual(fetchCalls, [{ url: '/api/commands/plan', method: 'POST' }])
  assert.equal(harnessSink.capture.state.commandBusy, false)
  assert.equal(harnessSink.capture.state.commandRefreshPending, false)
  assert.match(nodeFor('status-line').textContent, /不会自动重试/u)

  fetchCalls.length = 0
  harnessSink.capture.state.stale = true
  await harnessSink.capture.submit('plan', { title: '过时投影任务' }, 'task.create', false)
  assert.deepEqual(fetchCalls, [])
  assert.equal(harnessSink.capture.state.commandBusy, false)
  assert.match(nodeFor('status-line').textContent, /王国投影已过时，请先重新读取/u)
})

test('testCommandEnvelopeDoesNotInventPrincipalOrSession', () => {
  const request = buildConsoleCommand('review', {
    session_id: 'fake-session',
    principal_id: 'fake-principal',
    owner_capability: 'fake-capability',
    agent_id: 'fake-agent',
    actor_id: 'fake-actor',
    csrf_token: 'fake-csrf',
    request_id: 'fake-request',
    source_channel: 'fake-channel',
    ticket: 'fake-ticket',
    sandbox_mode: 'read-only',
    to_binding_id: 'binding-safe-target',
    execution_id: 'execution-safe-target',
  })
  assert.equal(request.name, 'review')
  assert.deepEqual(request.payload, {
    sandbox_mode: 'read-only',
    to_binding_id: 'binding-safe-target',
    execution_id: 'execution-safe-target',
  })
  assert.equal(Object.hasOwn(request.payload, 'session_id'), false)
  assert.equal(Object.hasOwn(request.payload, 'principal_id'), false)
  assert.equal(Object.hasOwn(request.payload, 'owner_capability'), false)
  assert.equal(Object.hasOwn(request.payload, 'agent_id'), false)
  assert.equal(Object.hasOwn(request.payload, 'request_id'), false)
  assert.equal(Object.hasOwn(request.payload, 'ticket'), false)
  assert.match(CONSOLE_APP_HTML, /if \(decision === 'HANDOFF'\) payload\.to_binding_id = target/u)
})

test('testConsoleShellContainsPollingAndStaleStateControls', () => {
  assert.match(CONSOLE_APP_HTML, /api\/control/u)
  assert.match(CONSOLE_APP_HTML, /api\/snapshot/u)
  assert.match(CONSOLE_APP_HTML, /x-kingdom-client/u)
  assert.match(CONSOLE_APP_HTML, /x-kingdom-csrf/u)
  assert.match(CONSOLE_APP_HTML, /x-kingdom-request-id/u)
  assert.match(CONSOLE_APP_HTML, /control\.revoke/u)
  assert.match(CONSOLE_APP_HTML, /credentials: 'same-origin'/u)
  assert.match(CONSOLE_APP_HTML, /randomUUID/u)
  assert.match(CONSOLE_APP_HTML, /commandTimeoutMs/u)
  assert.match(CONSOLE_APP_HTML, /75000/u)
  assert.match(CONSOLE_APP_HTML, /readTimeoutMs/u)
  assert.match(CONSOLE_APP_HTML, /pollIntervalMs/u)
  assert.match(CONSOLE_APP_HTML, /max-width: 390px/u)
  assert.match(CONSOLE_APP_HTML, /STALE/u)
  assert.match(CONSOLE_APP_HTML, /STALE_PROJECTION/u)
  assert.match(CONSOLE_APP_HTML, /status\('投影可能已过时[\s\S]*?renderGates\(\)/u)
  assert.match(CONSOLE_APP_HTML, /写操作绝不自动重试/u)
  assert.match(CONSOLE_APP_HTML, /UNKNOWN/u)
})

test('testConsoleShellNamesIndeterminateAndErrorStates', () => {
  assert.match(CONSOLE_APP_HTML, /DIRECT_SLASH_REQUIRED/u)
  assert.match(CONSOLE_APP_HTML, /SESSION_AUTH_REQUIRED/u)
  assert.match(CONSOLE_APP_HTML, /UNKNOWN/u)
  assert.match(CONSOLE_APP_HTML, /执行者呈报只是自述/u)
  assert.match(CONSOLE_APP_HTML, /待审 <code>REVIEW<\/code>：等待监督者 <code>SUPERVISOR<\/code> 作出决定/u)
  assert.match(CONSOLE_APP_HTML, /恢复核对中 <code>RECOVERING<\/code>/u)
  assert.match(CONSOLE_APP_HTML, /尚未运行 <code>NOT_RUN<\/code>/u)
  assert.match(CONSOLE_APP_HTML, /兼容执行路径 <code>LEGACY_COMPAT<\/code>/u)
  assert.match(CONSOLE_APP_HTML, /尚未确认 <code>UNKNOWN<\/code>/u)
  assert.match(CONSOLE_APP_HTML, /const healthCode = data\.health === undefined \|\| data\.health === null \|\| data\.health === '' \? 'UNKNOWN' : text\(data\.health\)/u)
  assert.doesNotMatch(CONSOLE_APP_HTML, /snapshot\.kingdom \? 'OK' : 'UNKNOWN'/u)
  assert.match(CONSOLE_APP_HTML, /id="status-technical" class="status-technical" hidden/u)
  assert.match(CONSOLE_APP_HTML, /technicalText = technical \? text\(technical\)\.slice\(0, 240\) : ''/u)
  assert.match(CONSOLE_APP_HTML, /status\('王国投影暂不可用，正在继续读取。', code === 'UNKNOWN' \? 'unknown' : 'error', code \+ ' · 读取轮询继续；写操作绝不自动重试。'\)/u)
  assert.doesNotMatch(CONSOLE_APP_HTML, /王国投影暂不可用（' \+ code/u)
  assert.doesNotMatch(CONSOLE_APP_HTML, /snapshot unavailable/u)
})

test('testControlResponseWithoutActiveSessionFailsClosed', () => {
  const unavailable = normalizeConsoleCapabilities({ active: false, disabledReason: 'CONTROL_SESSION_REQUIRED' })
  assert.equal(unavailable.state, 'INACTIVE')
  assert.equal(unavailable.active, false)
  assert.equal(resolveConsoleActionState(unavailable, 'start').disabledReason, 'SESSION_AUTH_REQUIRED')
})

test('testEvidenceLabelsRemainSeparated', () => {
  assert.equal(consoleEvidenceLabel('GOVERNANCE_FACT'), '治理事实')
  assert.equal(consoleEvidenceLabel('RUNTIME_OBSERVATION'), '运行观察')
  assert.equal(consoleEvidenceLabel('WORKER_CLAIM'), '执行者呈报')
  assert.equal(consoleEvidenceLabel('DERIVED_EXPLANATION'), '派生解释')
  assert.equal(consoleEvidenceLabel('unexpected'), '尚未确认')
})
