/** Personal workbench presentation. No model calls or authority are created here. */
export const WORKBENCH_CSS = String.raw`
.workbench-page { grid-column: 1 / -1; min-width: 0; width: 100%; }
.workbench-heading { display: flex; justify-content: space-between; align-items: start; gap: 24px; margin: 18px 0 24px; }
.workbench-heading h2 { font-size: clamp(25px, 3vw, 36px); margin: 6px 0; }
.workbench-heading p, .workbench-block > p { color: var(--muted); }
.workbench-grid { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(280px, 1fr); gap: 18px; }
.workbench-block { min-width: 0; padding: 20px; border: 1px solid var(--line); background: var(--patina); border-radius: 12px; }
.workbench-block h3 { font-size: 18px; margin-bottom: 8px; }
.workbench-block[data-priority="owner"] { border-top: 3px solid var(--gold); }
.workbench-list { display: grid; gap: 10px; margin-top: 16px; }
.workbench-item { display: grid; gap: 7px; padding: 14px 0; border-bottom: 1px solid var(--line); min-width: 0; }
.workbench-item:last-child { border-bottom: 0; }
.workbench-item a { color: var(--bamboo); text-decoration-thickness: 1px; text-underline-offset: 4px; font-weight: 600; overflow-wrap: anywhere; }
.workbench-item p, .workbench-item small { color: var(--muted); overflow-wrap: anywhere; }
.collaboration-plan { min-width: 0; overflow-wrap: anywhere; border-bottom: 1px solid var(--line); padding: 16px 0; }
.collaboration-plan > summary { cursor: pointer; font-weight: 600; }
.collaboration-plan .data-row { flex-wrap: wrap; gap: 6px; }
.collaboration-plan .workbench-item { padding-left: 12px; border-left: 2px solid var(--line); margin-top: 12px; }
.quick-task-form { display: flex; gap: 12px; margin: 18px 0 26px; }
.quick-task-form input { flex: 1; min-width: 0; min-height: 48px; }
.quick-task-form button { flex: 0 0 auto; }
.workbench-section-link { color: var(--gold); font-size: 13px; }
.task-detail-section { padding: 20px 0; border-bottom: 1px solid var(--line); }
.task-detail-section h3 { margin-bottom: 12px; font-size: 18px; }
.task-detail-section p { white-space: pre-wrap; overflow-wrap: anywhere; }
.task-detail-section p + p { margin-top: 9px; }
.task-evidence-states { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 14px 0; }
.task-evidence-states > div { padding: 13px; background: var(--panel-soft); border-radius: 8px; }
.task-evidence-states strong, .task-evidence-states span { display: block; }
.task-evidence-states span { margin-top: 6px; color: var(--muted); }
.task-detail-jump { display: flex; gap: 12px; flex-wrap: wrap; margin: 15px 0; }
.task-detail-jump a { color: var(--gold); }
.task-draft-panel { margin-bottom: 22px; border: 1px solid var(--line); border-radius: 12px; padding: 16px; background: var(--patina); }
.task-draft-panel > summary { cursor: pointer; font-weight: 600; }
.task-draft-panel .task-composer-card { margin-top: 16px; box-shadow: none; border: 0; padding: 0; }
.draft-fields { margin-top: 16px; display: grid; gap: 14px; }
.draft-fields textarea { min-height: 100px; }
.task-actions-inline { margin-top: 22px; }
.task-actions-inline .action-dock-head { display: block; }
.task-actions-inline .action-dock-head p { margin-top: 8px; }
.task-actions-inline .forms > .governance-flow { display: none; }
.map-page .council-grid.role-workbench-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; }
.role-workbench-layout:has(.role-inspector:not([hidden])) { grid-template-columns: minmax(0, 1fr) 310px; }
.role-inspector { padding: 20px; align-self: start; position: sticky; top: calc(var(--nav-height) + 20px); border: 1px solid var(--line); border-radius: 12px; background: var(--patina); }
.role-inspector h3 { font-size: 21px; margin: 16px 0 10px; }
.role-inspector p { margin-bottom: 10px; overflow-wrap: anywhere; }
.role-inspector .data-row { flex-wrap: wrap; }
.role-inspect-button { border: 0; padding: 5px 0; color: var(--gold); background: transparent; text-decoration: underline; text-underline-offset: 4px; }
/* Preserve the authored joint motion at a size where the gesture reads in the map. */
.role-workbench-layout .chancellor-card { grid-template-columns: 104px minmax(0, 1fr) auto; }
.role-workbench-layout .chancellor-card .pixel-sprite { width: 100px; height: 136px; }
.role-workbench-layout .org-node[data-role="supervisor"] { grid-template-columns: 96px minmax(0, 1fr); min-height: 148px; }
.role-workbench-layout .org-node[data-role="supervisor"] .pixel-sprite { width: 92px; height: 128px; }
.role-workbench-layout .org-node[data-role="worker"] { grid-template-columns: 92px minmax(0, 1fr); min-height: 140px; }
.role-workbench-layout .org-node[data-role="worker"] .pixel-sprite { width: 88px; height: 120px; }
.role-workbench-layout .org-node:is([data-stage-evidence="unbound"],[data-stage-evidence="absent"]) { grid-template-columns: minmax(0, 1fr); }
.settings-list { display: grid; gap: 20px; }
.settings-entry { border-top: 1px solid var(--line); padding-top: 16px; }
.settings-entry code { display: block; margin-top: 8px; user-select: all; overflow-wrap: anywhere; }
.usage-coverage { padding: 15px; border-left: 3px solid var(--gold); background: var(--panel-soft); margin: 14px 0; }
.usage-table { width: 100%; border-collapse: collapse; text-align: left; }
.usage-table th, .usage-table td { padding: 12px 8px; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
.usage-table th { color: var(--muted); font-weight: 500; }
/* 交付知悉清单：成果摘要 → 模块/事项 → 证据/改动 三层结构。 */
.delivery-item { display: grid; gap: 10px; }
.delivery-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.delivery-acceptance { display: flex; flex-wrap: wrap; gap: 8px; margin: 2px 0; }
.delivery-layer { display: grid; gap: 8px; padding: 11px 0 11px 14px; border-left: 2px solid var(--line); min-width: 0; }
.delivery-layer > h4 { font-size: 14px; margin: 0; color: var(--muted); font-weight: 600; letter-spacing: .04em; }
.delivery-module { display: grid; gap: 6px; padding: 8px 0 8px 12px; border-left: 2px solid var(--line); min-width: 0; }
.delivery-module > h5 { font-size: 14px; margin: 0; }
/* v3.2.0 版面修复：此前是 grid-template-columns: minmax(0,1fr) auto。
   右列 auto = max-content，而控制区里有一条 flex: 1 0 100% 的状态文本，
   它把右轨撑到最宽，左轨被压成 0 宽——正文因此退化成每行一两个字、竖排的"任/务/要/求"。
   改成分行 flex：正文占弹性主列（20rem 起），控制区按自身内容窄排，
   放不下时整体换行，而不是继续抢宽。 */
.delivery-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-start; min-width: 0; }
.delivery-row-body { flex: 1 1 20rem; display: grid; gap: 5px; min-width: 0; }
.delivery-row-body p { margin: 0; }
.delivery-row-label { font-weight: 600; }
.delivery-controls { flex: 0 1 auto; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; min-width: 0; max-width: 100%; }
/* 图标按钮的就地操作提示：一个包装层 + 一条提示节点。
   可用按钮的操作说明在 hover 或键盘 focus 时就地弹出，不挤动按钮行；禁用原因常驻可见，
   因为键盘用户必须能读到“为什么不可用”，而不是只看到 title。 */
.delivery-control-hint { position: relative; display: inline-flex; }
.delivery-control-status { flex: 1 0 100%; margin: 4px 0 0; font-size: 13px; color: var(--muted); overflow-wrap: anywhere; }
.delivery-control-hint > .delivery-control-status[data-control-status="AVAILABLE"] {
 position: absolute; top: calc(100% + 4px); left: 0; z-index: 6; display: none;
 width: max-content; max-width: min(320px, 80vw); margin: 0; padding: 6px 8px;
 border: 1px solid var(--line); border-radius: 8px; background: var(--panel-soft);
 color: var(--ink); box-shadow: 0 4px 12px rgba(0, 0, 0, .18);
}
.delivery-control-hint:hover > .delivery-control-status[data-control-status="AVAILABLE"],
.delivery-control-hint:focus-within > .delivery-control-status[data-control-status="AVAILABLE"] { display: block; }
.delivery-control-hint:has(> .delivery-control-status[data-control-status="DISABLED"]) { flex: 1 0 100%; flex-wrap: wrap; }
.delivery-state { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; padding: 2px 0; }
.delivery-state-icon { display: inline-block; flex: 0 0 16px; width: 16px; height: 16px; background: currentColor; -webkit-mask: var(--delivery-state-symbol, var(--icon-unknown)) center / contain no-repeat; mask: var(--delivery-state-symbol, var(--icon-unknown)) center / contain no-repeat; }
.delivery-state[data-ack-state="ACKNOWLEDGED"] { --delivery-state-symbol: var(--icon-known); font-weight: 600; }
.delivery-state[data-ack-state="PENDING"] { --delivery-state-symbol: var(--icon-pending); }
.delivery-state[data-ack-state="PENDING_REVISION"] { --delivery-state-symbol: var(--icon-revised); }
.delivery-state[data-ack-state="NOT_CONFIRMED"] { --delivery-state-symbol: var(--icon-unknown); }
/* 历史（v1.0.0）接受证据较弱：可见标注，不只靠颜色，也不是普通注脚。 */
.delivery-evidence-weak { margin: 0; padding: 9px 11px; border: 1px solid var(--line); border-left: 3px solid var(--gold); border-radius: 8px; background: var(--panel-soft); overflow-wrap: anywhere; }
.delivery-evidence-weak strong { display: inline-block; margin-right: 4px; }
.delivery-note { margin: 0; }
.icon-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-width: 44px; min-height: 44px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-soft); color: var(--ink); cursor: pointer; }
.icon-button .ui-icon { width: 20px; height: 20px; flex: 0 0 20px; }
.icon-button[disabled] { opacity: .6; cursor: not-allowed; }
/* 语义化禁用（仍可聚焦以便键盘读出原因）与原生 disabled 保持同一可见弱化。 */
.icon-button[aria-disabled="true"] { opacity: .6; cursor: not-allowed; }
.icon-button:focus-visible { outline: 3px solid var(--gold); outline-offset: 2px; }
.icon-button[aria-disabled="true"]:focus-visible { outline-style: dashed; }
.delivery-control-hint:focus-within > .icon-button { outline: 3px solid var(--gold); outline-offset: 2px; }
/* 复制 Owner 激活命令的就地反馈；失败与成功都写明，不只靠颜色。 */
.delivery-copy-status { margin: 4px 0 0; font-size: 13px; overflow-wrap: anywhere; }
.delivery-copy-failed { border-left: 3px solid var(--gold); padding-left: 8px; }
@media (prefers-reduced-motion: reduce) { .icon-button { transition: none; } }
.workbench-page [hidden] { display: none !important; }
#task-detail-content, #task-action-slot { min-width: 0; }
.task-return { display: inline-block; margin-bottom: 12px; color: var(--gold); }
@media (min-width: 761px) and (max-width: 1100px) {
 .realm-sidebar { flex-wrap: wrap; }
 .main-nav { order: 3; width: 100%; margin: 0; justify-content: center; }
 .main-nav a { flex: 1 1 0; }
}
@media (max-width: 760px) {
 .role-workbench-layout .chancellor-card { grid-template-columns: 88px minmax(0, 1fr); }
 .role-workbench-layout .chancellor-card .pixel-sprite { width: 84px; height: 116px; }
 .role-workbench-layout .org-node[data-role="supervisor"], .role-workbench-layout .org-node[data-role="worker"] { grid-template-columns: 82px minmax(0, 1fr); }
 .role-workbench-layout .org-node[data-role="supervisor"] .pixel-sprite, .role-workbench-layout .org-node[data-role="worker"] .pixel-sprite { width: 78px; height: 108px; }
 .role-workbench-layout .org-node:is([data-stage-evidence="unbound"],[data-stage-evidence="absent"]) { grid-template-columns: minmax(0, 1fr); }
 .main-nav { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); min-width: 0; max-width: 100%; width: 100%; margin: 0; }
 .main-nav a { min-width: 0; width: 100%; white-space: normal; text-align: center; }
}
@media (max-width: 1050px) { .role-workbench-layout:has(.role-inspector:not([hidden])) { grid-template-columns: minmax(0, 1fr); } .role-inspector { position: static; } }
@media (max-width: 700px) {
 .workbench-grid, .task-evidence-states { grid-template-columns: minmax(0, 1fr); }
 .workbench-heading { flex-direction: column; gap: 12px; }
 .workbench-block { padding: 16px; }
 .quick-task-form { flex-direction: column; }
 .usage-table { font-size: 12px; }
 .usage-table th, .usage-table td { padding: 9px 4px; }
 .main-nav a { flex: 0 0 auto; }
}
@media (max-width: 480px) { .main-nav .ui-icon { display: none; } }
`;

export const WORKBENCH_HTML = String.raw`
<section id="today" data-console-section="today" data-console-page="today" class="workbench-page" aria-labelledby="today-title">
 <header class="workbench-heading"><div><p class="section-kicker">个人工作台</p><h2 id="today-title">今天，从要紧的事开始</h2><p>需要你决定的事、执行进展和最近交付，都在这里。</p></div><button id="workbench-refresh" class="refresh" type="button">重新读取</button></header>
 <form id="quick-task-form" class="quick-task-form"><label class="sr-only" for="quick-task-goal">写下一句话目标</label><input id="quick-task-goal" autocomplete="off" placeholder="写下一句话目标，先整理为草稿" required><button class="primary" type="submit">整理任务草稿</button></form>
 <div class="workbench-grid">
  <section class="workbench-block" data-priority="owner"><h3>待我处理</h3><p>仅列出已明确需要人类决定的事项。</p><div id="today-owner" class="workbench-list"></div><a class="workbench-section-link" href="#inbox">查看待我处理 →</a></section>
  <section class="workbench-block"><h3>执行异常</h3><p>说明发生了什么、由谁继续处理。</p><div id="today-exceptions" class="workbench-list"></div></section>
  <section class="workbench-block"><h3>正在推进</h3><div id="today-active" class="workbench-list"></div></section>
  <section class="workbench-block"><h3>最近交付</h3><p>呈报、主管接受与人类验收分别展示。</p><div id="today-deliveries" class="workbench-list"></div></section>
 </div>
 <section class="workbench-block" style="margin-top:18px"><h3>团队内部处理</h3><p>主管审查与返工由团队继续推进，不计入你的待办。</p><div id="today-internal" class="workbench-list"></div></section>
 <section class="workbench-block" style="margin-top:18px" aria-labelledby="collaboration-title"><h3 id="collaboration-title">按需协作计划</h3><p>单执行者仍是默认。需要协作时，只采纳一份分工明确的计划，由指定主执行者负责整合。</p><div id="collaboration-plans"></div><details data-read-key="collaboration:resources"><summary>当前工作区占用</summary><div id="collaboration-resources"></div></details></section>
</section>
<section id="inbox" data-console-section="inbox" data-console-page="inbox" class="workbench-page" hidden aria-labelledby="inbox-title">
 <header class="workbench-heading"><div><p class="section-kicker">你的决定</p><h2 id="inbox-title">待我处理</h2><p>当前版本的人类治理入口仍为直接 Slash；这里帮助你找到准确事项。</p></div></header>
 <section class="workbench-block" data-priority="owner"><div id="inbox-owner" class="workbench-list"></div></section>
 <section class="workbench-block" style="margin-top:18px"><h3>由团队内部处理</h3><div id="inbox-internal" class="workbench-list"></div></section>
</section>
<section id="usage" data-console-section="usage" data-console-page="usage" class="workbench-page" hidden aria-labelledby="usage-title">
 <header class="workbench-heading"><div><p class="section-kicker">成本基线</p><h2 id="usage-title">用量</h2><p>查看 Provider 实报与覆盖缺口；Token 数量不等于费用账单。</p></div></header>
 <section class="workbench-block" aria-label="软预算与额外角色观测"><div id="budget-summary"></div><div id="role-cost-summary"></div><div id="cost-runtime-summary"></div><div id="prompt-cost-summary"></div></section>
 <section class="workbench-block"><div id="usage-summary"></div><div id="usage-content"></div></section>
</section>
<section id="settings" data-console-section="settings" data-console-page="settings" class="workbench-page" hidden aria-labelledby="settings-title">
 <header class="workbench-heading"><div><p class="section-kicker">运行与治理</p><h2 id="settings-title">设置</h2><p>现有入口及真实操作权限；未开放的能力不会显示为可执行按钮。</p></div></header>
 <div class="settings-list"><section class="workbench-block"><h3>当前控制通道</h3><p>角色操作来自激活本页的合法会话，每次提交仍由宿主重新核验。</p><div id="settings-control-slot"></div><p class="hint">在已绑定角色的 DSH 会话直接输入 /kingdom gui，按宿主提供的链接重新打开本页。</p></section><section class="workbench-block"><h3>人类所有者设置</h3><p>通过短期人类管理窗口配置王国、领地、任命、权限上限与模型。先由人类在 DSH 直接激活具体管理范围，再在网页预览并提交。</p><a class="workbench-section-link" href="/owner">打开人类管理窗口 →</a><div id="settings-owner-slot"></div></section><section class="workbench-block"><h3>外观与动态效果</h3><p>顶部可选择羊皮纸、夜蓝、森林与酒红主题。人物动作沿用当前王国风格；减少动态效果跟随系统偏好。</p></section><details class="workbench-block" id="settings-advanced"><summary>高级治理记录</summary><nav class="task-detail-jump"><a href="#ledger">王国账本</a><a href="#organization">领地名册</a><a href="#executions">执行记录</a><a href="#activity">治理史册</a></nav></details></div>
</section>
`;

/** Injected into the existing console closure; all Host text uses append/textContent. */
export const WORKBENCH_SCRIPT = String.raw`
    const readerDetails = new Map();
    const preserveWorkbenchView = render => {
      const active = document.activeElement; const focusId = active && active.id;
      const focusKey = active && typeof active.getAttribute === 'function' ? active.getAttribute('data-focus-key') : null;
      const selection = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
      const x = Number(globalThis.scrollX || 0); const y = Number(globalThis.scrollY || 0);
      const details = Array.from(document.querySelectorAll('details[data-read-key], details[id]'));
      details.forEach(node => readerDetails.set(node.getAttribute('data-read-key') || node.id, node.open));
      const anchors = Array.from(document.querySelectorAll('[data-read-anchor]'));
      const anchor = anchors.find(node => typeof node.getBoundingClientRect === 'function' && node.getBoundingClientRect().height > 0 && node.getBoundingClientRect().bottom > 140);
      const anchorKey = anchor && anchor.getAttribute('data-read-anchor'); const anchorTop = anchor ? anchor.getBoundingClientRect().top : null;
      render();
      document.querySelectorAll('details[data-read-key], details[id]').forEach(node => { const key = node.getAttribute('data-read-key') || node.id; if (readerDetails.has(key)) node.open = readerDetails.get(key); });
      const replacement = focusId ? byId(focusId) : focusKey ? Array.from(document.querySelectorAll('[data-focus-key]')).find(node => node.getAttribute('data-focus-key') === focusKey) : active;
      if (replacement && replacement.isConnected !== false && typeof replacement.focus === 'function' && !replacement.disabled) {
        if (document.activeElement !== replacement) replacement.focus({ preventScroll: true });
        if (selection && typeof replacement.setSelectionRange === 'function') { try { replacement.setSelectionRange(selection[0], selection[1]); } catch (_) {} }
      }
      const newAnchor = anchorKey ? Array.from(document.querySelectorAll('[data-read-anchor]')).find(node => node.getAttribute('data-read-anchor') === anchorKey) : null;
      const delta = newAnchor && typeof newAnchor.getBoundingClientRect === 'function' ? newAnchor.getBoundingClientRect().top - anchorTop : 0;
      if (typeof globalThis.scrollTo === 'function') globalThis.scrollTo({ left: x, top: Math.max(0, y + delta), behavior: 'instant' });
    };
    const workbenchData = snapshot => record(record(record(record(snapshot).projection).workbench).data);
    const queueItems = queue => Array.isArray(record(queue).items) ? queue.items : [];
    const friendly = (value, fallback) => value === null || value === undefined || value === '' ? fallback : String(value);
    const addTaskLink = (parent, taskId, label, key) => {
      if (!taskId) return append(parent, 'strong', label);
      const link = append(parent, 'a', label); link.href = '#task=' + encodeURIComponent(String(taskId)); link.setAttribute('data-focus-key', key || 'task-link:' + taskId); return link;
    };
    const renderWorkbenchQueue = (id, queue, emptyMessage) => {
      const parent = clear(id); if (!parent) return; const items = queueItems(queue);
      if (!queue || !Array.isArray(queue.items)) { addEmpty(parent, '当前宿主尚未提供此项投影，请重新读取或检查版本。'); return; }
      if (!items.length) addEmpty(parent, emptyMessage);
      items.forEach(item => { const card = document.createElement('article'); card.className = 'workbench-item'; card.setAttribute('data-read-anchor', id + ':' + item.id); addTaskLink(card, item.taskId, friendly(item.title, '治理事项'), id + ':' + item.id); append(card, 'p', item.summary); append(card, 'small', '负责处理：' + ({ OWNER: '人类所有者', CHANCELLOR: '宰相', SUPERVISOR: '领地主管', UNDETERMINED: '尚未确认' })[item.responsibility]); if (item.responsibility === 'OWNER') { const link = append(card, 'a', '查看当前合法入口'); link.href = '#settings'; } parent.append(card); });
      if (queue.truncated) addEmpty(parent, '当前显示 ' + items.length + ' / ' + queue.totalCount + ' 项；投影已注明截断。');
    };
    const executionExplanation = task => {
      const execution = record(task.latestExecution); const value = String(execution.state || 'NONE');
      if (value === 'RECOVERING') return '任务仍处于 ' + stateDisplay(task.status) + '；本次执行正在恢复核对。主管需核对原执行结果，不会自动重新派发。';
      if (String(task.status) === 'RUNNING' && !['STARTING', 'RUNNING', 'PAUSED'].includes(value)) return '任务处于处理中；当前没有正在运行的执行。返工决定不会自动启动下一次执行。';
      return '任务治理：' + stateDisplay(task.status) + ' · 本次执行：' + stateDisplay(value);
    };
    const claimSummaryPreview = value => {
      let preview = friendly(value, '尚无呈报摘要');
      if (typeof value === 'string' && value.length <= 32768) {
        try { const parsed = JSON.parse(value); if (parsed && !Array.isArray(parsed) && typeof parsed === 'object' && Object.getPrototypeOf(parsed) === Object.prototype && typeof parsed.summary === 'string') preview = parsed.summary; } catch (_) { /* Plain text remains plain text. */ }
      }
      const characters = Array.from(preview); return characters.length > 240 ? characters.slice(0, 240).join('') + '…' : preview;
    };
    const DELIVERY_STATE_LABELS = { ACKNOWLEDGED: 'Owner 已知悉该条当前版本', PENDING: '待你知悉（当前版本）', PENDING_REVISION: '已有旧版本知悉，当前版本待你知悉', NOT_CONFIRMED: '交付尚未确认' };
    const DELIVERY_STATE_SYMBOLS = { ACKNOWLEDGED: '✓', PENDING: '○', PENDING_REVISION: '↻', NOT_CONFIRMED: '?' };
    const addDeliveryState = (parent, state, extra) => {
      const row = document.createElement('span');
      row.className = 'delivery-state';
      row.setAttribute('data-ack-state', state);
      row.setAttribute('data-status-icon', DELIVERY_STATE_SYMBOLS[state] || '?');
      const icon = document.createElement('span'); icon.className = 'delivery-state-icon'; icon.setAttribute('aria-hidden', 'true'); row.append(icon);
      append(row, 'span', (DELIVERY_STATE_LABELS[state] || state) + (extra ? ' · ' + extra : ''));
      parent.append(row); return row;
    };
    /**
     * 接受证据强度标注。legacy v1.0.0 的 TASK_ACCEPTED 缺少被审查结果 ID 与内容摘要，
     * Owner 已裁决允许知悉，但工作台必须可见地标注「历史接受证据较弱」，且不得把它
     * 呈现为 exact result-bound。强证据不额外占位。
     */
    const addAcceptanceEvidence = (parent, evidence) => {
      const value = record(evidence);
      if (value.kind !== 'LEGACY_ATTEMPT_ONLY') return null;
      const notice = document.createElement('p');
      notice.className = 'delivery-evidence-weak';
      notice.setAttribute('data-acceptance-evidence', 'LEGACY_ATTEMPT_ONLY');
      notice.setAttribute('role', 'note');
      append(notice, 'strong', '历史接受证据较弱');
      append(notice, 'span', ' ' + friendly(value.note, '该 Task/attempt 的 TASK_ACCEPTED 是 v1.0.0 旧格式，只有尝试编号，缺少被审查结果 ID 与内容摘要；本条按真实事件字段与同 Task/attempt 的唯一 WorkerResult 判定，不构成 exact result-bound 证据。'));
      parent.append(notice); return notice;
    };
    const addIconButton = (parent, iconHtml, label, key) => {
      const button = append(parent, 'button', null, 'icon-button');
      button.type = 'button';
      button.setAttribute('data-focus-key', key);
      button.setAttribute('aria-label', label);
      button.title = label;
      const icon = document.createElement('span'); icon.className = 'ui-icon'; icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = iconHtml;
      button.append(icon);
      // 图标按钮不再重复长文案：可见状态由相邻的状态文本承担，名称与提示保留在 aria-label/title。
      return button;
    };
    // 知悉入口只把准确的三元组交给 canonical Owner 窗口预选；写入仍由 Owner 授权、预览、提交与回执完成。
    const ownerAckHref = (taskId, itemId, contentHash) => '/owner?ack_task=' + encodeURIComponent(String(taskId))
      + '&ack_item=' + encodeURIComponent(String(itemId)) + '&ack_hash=' + encodeURIComponent(String(contentHash));
    /**
     * 提问入口与知悉入口使用**同一套**精确三元组与预选协议，只是目标动作不同。
     *
     * 二者互不触发：打开提问不会写入知悉；打开知悉也不会产生问题。
     */
    const ownerAskHref = (taskId, itemId, contentHash) => '/owner?ask_task=' + encodeURIComponent(String(taskId))
      + '&ask_item=' + encodeURIComponent(String(itemId)) + '&ask_hash=' + encodeURIComponent(String(contentHash));
    /**
     * 本条交付的最小 Owner 激活命令；动作参数决定它是知悉命令还是提问命令。
     *
     * 只申请 delivery.item.ack 或 delivery.item.question 之一与**本条领地范围**（territoryIds
     * 只含本条领地），并携带非授权的 exact task/item/contentHash hint 与 hintAction；不含票据、
     * 不含 kingdomWide 兜底、不含本机路径或凭据。范围刻意不引用提交时的主管 bindingId：
     * 绑定可能在该快照之后退任或更换，而领地范围由 direct 入口按当前真实状态校验，命令不会
     * 因过时绑定而无法执行。复制本身不授权、不预选、不写任何事实：人类仍须直接在 DSH 执行它。
     */
    const ownerLaunchCommand = (entry, action) => {
      const ask = action === 'ask';
      const scope = { kingdomWide: false, territoryIds: [entry.territoryId], bindingIds: [],
        roleTypes: [], targetSessionIds: [], workspaceRoots: [] };
      const envelope = { kingdomId: entry.kingdomId, actions: [ask ? 'delivery.item.question' : 'delivery.item.ack'], scope, ttlMs: 600000 };
      return '/kingdom owner.gui ' + JSON.stringify({ ...envelope, hintAction: ask ? 'ask' : 'ack',
        taskHint: entry.taskId, itemHint: entry.itemId, contentHashHint: entry.contentHash });
    };
    /**
     * 复制命令文本。只使用浏览器 Clipboard API：没有它就没有可确认成功的复制路径，
     * 因此明确失败，不保留任何无法验证结果、也无法确认已复制的旧式回退。
     */
    const copyLaunchCommand = (entry, action) => {
      const command = ownerLaunchCommand(entry, action);
      const clipboard = globalThis.navigator && globalThis.navigator.clipboard;
      if (clipboard && typeof clipboard.writeText === 'function') return Promise.resolve(clipboard.writeText(command));
      return Promise.reject(new Error('浏览器没有提供 Clipboard API'));
    };
    /** 复制结果就地反馈：成功提示人类去 DSH 直接执行；失败明确说明未复制，不假装成功。 */
    const addCopyStatus = (parent, message, ok) => {
      const host = parent && parent.parentElement ? parent.parentElement : parent;
      if (!host) return null;
      const existing = host.querySelector('[data-copy-status]');
      if (existing) existing.remove();
      const line = append(host, 'p', message, ok ? 'delivery-copy-status' : 'delivery-copy-status delivery-copy-failed');
      line.setAttribute('data-copy-status', ok ? 'COPIED' : 'FAILED');
      line.setAttribute('role', 'status');
      return line;
    };
    /**
     * 给图标按钮加一层「就地操作提示」。
     *
     * 提示文本始终跟随控件，键盘聚焦禁用按钮后可经 aria-describedby 读出原因；
     * 「不可定位 / 已知悉」这类禁用原因不是次要注脚，直接可见，其余提示在 hover 或
     * focus 时显示。只加一层可访问包装与一段文案，不新增控件类型或第二套状态。
     */
    /**
     * 给图标按钮加一层「就地操作提示」。
     *
     * 提示节点始终挂在控件自己的包装层（由调用方直接传入，不靠 DOM 类型探测）：可用
     * 按钮的说明在 hover 或键盘 focus 时可见，禁用原因常驻可见，因为键盘用户必须能
     * 读到“为什么不可用”。两种情形共用这一个机制，不新增控件类型或第二套状态。
     */
    const addControlStatus = (host, button, message, state) => {
      // 状态行 id 只由控件自己的 focus key 派生，不读取父级属性，也不依赖 DOM 结构。
      const statusId = 'delivery-control-status-' + String(button.getAttribute('data-focus-key') || 'control').replace(/[^A-Za-z0-9_-]/g, '-');
      const line = append(host, 'p', message, 'delivery-control-status');
      line.setAttribute('data-control-status', state);
      line.setAttribute('id', statusId);
      button.setAttribute('aria-describedby', statusId);
      return line;
    };
    const addDeliveryControl = (parent, iconHtml, label, key) => {
      const host = append(parent, 'span', null, 'delivery-control-hint');
      const button = addIconButton(host, iconHtml, label, key);
      return { host, button };
    };
    /** 语义化的「不可用」：保留 aria-disabled 与精确原因，不把禁用原因藏进只读 title。 */
    const markControlDisabled = (host, button, reason) => {
      button.setAttribute('aria-disabled', 'true');
      button.setAttribute('data-disabled', 'true');
      button.onclick = null;
      addControlStatus(host, button, reason, 'DISABLED');
      return button;
    };
    /**
     * 可用的图标按钮：hover / 键盘 focus 时显示操作说明。
     *
     * 说明文本直接取调用方已经写好的 title：同一处文本同时服务 tooltip 与就地提示，
     * 不另造第二份会漂移的文案。调用方必须先设置 button.title。
     */
    const markControlAvailable = (host, button) => {
      addControlStatus(host, button, button.title, 'AVAILABLE');
      return button;
    };
    const addLaunchHintControl = (parent, entry, key, action) => {
      // 提问与知悉各自有一条最小 direct 命令：命令携带 hintAction，兑换后才会回到同一个
      // 动作与同一条目标，不会把提问入口悄悄退化成知悉入口。
      const ask = action === 'ask';
      const actionLabel = ask ? '提问' : '逐条知悉';
      const actionName = ask ? 'delivery.item.question' : 'delivery.item.ack';
      const exact = Boolean(entry.kingdomId) && Boolean(entry.territoryId) && Boolean(entry.taskId)
        && Boolean(entry.itemId) && Boolean(entry.contentHash);
      const control = addDeliveryControl(parent, '__DELIVERY_ICON_COPY__',
        exact
          ? '复制本条 Owner 激活命令：只申请' + actionLabel + '与本条领地范围，并携带该条 task/item/contentHash；命令不含票据，仍需你在 DSH 直接执行并授权'
          : '本条缺少准确的王国、领地、任务或内容版本，不能生成 Owner 激活命令',
        key);
      const button = control.button;
      if (!exact) {
        // 缺少准确范围时不生成命令；原因既在 aria-label/title，也在随焦点可读的可见提示里。
        button.setAttribute('aria-label', '本条缺少准确的王国、领地、任务或内容版本，不能生成 Owner 激活命令');
        button.title = '缺少准确的王国、领地、任务或内容版本；不会生成命令，也不提供替代范围。';
        control.host.setAttribute('title', button.title);
        return markControlDisabled(control.host, button, '不可用：缺少准确的王国、领地、任务或内容版本；不会生成命令，也不提供替代范围。');
      }
      button.title = '复制一条 direct /kingdom owner.gui 命令：只申请 ' + actionName + ' 与本条领地范围，携带该条准确 task/item/contentHash。复制不授权、不写入；请到 DSH 直接执行。';
      markControlAvailable(control.host, button);
      button.onclick = () => {
        const entryValue = { kingdomId: entry.kingdomId, territoryId: entry.territoryId,
          taskId: entry.taskId, itemId: entry.itemId, contentHash: entry.contentHash };
        const done = () => addCopyStatus(button, '命令已复制。请在 DSH 直接执行并核对授权范围；复制与执行都不会自动' + actionLabel + '该条。', true);
        const failed = () => addCopyStatus(button, '命令未复制：当前浏览器没有可用的 Clipboard API，本页无法交出这条 exact 命令。恢复方式：先在 DSH 直接激活包含 ' + actionName + ' 的管理窗口，再回到本页用条目' + actionLabel + '入口预选该条；单独点击入口或单独激活管理窗口都不会回到本条。', false);
        try { Promise.resolve(copyLaunchCommand(entryValue, action)).then(done, failed); } catch (_) { failed(); }
      };
      return button;
    };
    /**
     * 已确认改动证据的只读入口。
     *
     * 只有 REPO_RELATIVE_VERIFIED 且携带精确 evidenceId/entryId 时才生成链接；
     * 链接指向 canonical Owner 窗口，正文只在有效管理窗口内经只读接口返回。
     * 查看不写入、不自动知悉，也不改变 Task/Claim。
     */
    const ownerChangeHref = (taskId, evidenceId, entryId) => '/owner?change_task=' + encodeURIComponent(String(taskId))
      + '&change_evidence=' + encodeURIComponent(String(evidenceId)) + '&change_item=' + encodeURIComponent(String(entryId));
    const addChangeControl = (parent, change, key, taskId) => {
      const value = record(change);
      const trusted = value.kind === 'REPO_RELATIVE_VERIFIED' && Boolean(value.evidenceId) && Boolean(value.entryId) && Boolean(taskId);
      const label = trusted
        ? '查看改动（主管确认的改动证据）：' + friendly(value.repoPath, '未提供路径') + '，固定版本 ' + friendly(value.revision, '未提供版本') + '。只读，不写入，也不会自动知悉。'
        : '查看改动：不可定位。本条目没有可验证的仓库相对路径与固定源码版本，不提供链接。';
      const control = addDeliveryControl(parent, trusted ? '__DELIVERY_ICON_CHANGE__' : '__DELIVERY_ICON_UNLOCATED__', label, key);
      const button = control.button;
      if (!trusted) {
        button.title = friendly(value.note, '本条目没有可验证的仓库相对路径与固定源码版本；不提供改动链接。');
        control.host.setAttribute('title', button.title);
        return markControlDisabled(control.host, button, '不可定位：' + button.title);
      }
      button.title = '在有效的人类管理窗口中只读查看这条「主管确认的改动证据」；查看不写入、不自动知悉，也不改变任务或 Claim。';
      markControlAvailable(control.host, button);
      button.onclick = () => { globalThis.location.assign(ownerChangeHref(taskId, value.evidenceId, value.entryId)); };
      return button;
    };
    const addAcknowledgeControl = (parent, item, key) => {
      const acknowledged = Boolean(item.acknowledgement && item.acknowledgement.acknowledged);
      const exact = Boolean(item.taskId) && Boolean(item.itemId) && Boolean(item.contentHash);
      const control = addDeliveryControl(parent, '__DELIVERY_ICON_ACK__', acknowledged ? '已知悉（当前版本）' : '记下已知悉', key);
      const button = control.button;
      if (acknowledged) {
        button.setAttribute('aria-label', '该条当前版本已有 Owner 知悉；重复知悉不会新增记录');
        button.title = '该条当前版本已有 Owner 知悉；重复知悉不会新增记录。';
        control.host.setAttribute('title', button.title);
        return markControlDisabled(control.host, button, '已知悉：该条当前版本已有 Owner 知悉；重复知悉不会新增记录。');
      }
      if (!exact) {
        button.setAttribute('aria-label', '该条缺少准确的条目编号或内容版本，不能进入人类管理窗口');
        button.title = '该条缺少准确的条目编号或内容版本；不会打开管理窗口，也不提供替代选择。';
        control.host.setAttribute('title', button.title);
        return markControlDisabled(control.host, button, '不可用：缺少准确的条目编号或内容版本；不会打开管理窗口，也不提供替代选择。');
      }
      button.setAttribute('aria-label', '在人类管理窗口预选并记下已知悉「' + friendly(item.label, '该条') + '」当前版本；仍需由你授权、查看预览并确认提交，不采集理由或理解程度');
      button.title = '在人类管理窗口预选该条当前版本；仍需由你确认授权、查看预览并提交回执。不会一键写入。';
      markControlAvailable(control.host, button);
      button.onclick = () => { globalThis.location.assign(ownerAckHref(item.taskId, item.itemId, item.contentHash)); };
      return button;
    };
    /**
     * 就某条交付提问的入口。
     *
     * 只携带 exact task/item/contentHash 打开 canonical Owner 窗口并预选该条；提问
     * 仍由 Owner 填写、预览、提交与回执。工作台不写事实、不代替 Owner 授权，也不
     * 投影问答正文——正文只经有效管理窗口或当前责任主管的 session-bound Tool 读取。
     * 该控件与「知悉」完全分离：提问不会写入知悉，点击查看/提问也不会自动知悉。
     */
    const addAskControl = (parent, item, key) => {
      const exact = Boolean(item.taskId) && Boolean(item.itemId) && Boolean(item.contentHash);
      const state = record(item.questions);
      const total = Number(state.totalCount) || 0;
      const pending = Number(state.pendingCount) || 0;
      const unreachable = Boolean(total) && Boolean(state.latestReplyState) && state.latestReplyState !== 'REPLY_ACCESSIBLE';
      const summary = total
        ? '该条已有 ' + total + ' 条提问（' + pending + ' 待回复）' + (unreachable ? '；最近一条的接收主管当前不可达' : '')
        : '该条还没有提问记录';
      const control = addDeliveryControl(parent, '__DELIVERY_ICON_ASK__', exact
        ? '就这条交付向接受该交付的主管提问：' + summary + '。仍须由你在管理窗口填写问题、查看预览并确认提交'
        : '本条缺少准确的条目编号或内容版本，不能发起提问', key);
      const button = control.button;
      if (!exact) {
        button.setAttribute('aria-label', '该条缺少准确的条目编号或内容版本，不能发起提问');
        button.title = '该条缺少准确的条目编号或内容版本；不会打开管理窗口，也不提供替代选择。';
        control.host.setAttribute('title', button.title);
        return markControlDisabled(control.host, button, '不可用：缺少准确的条目编号或内容版本；不会打开管理窗口，也不提供替代选择。');
      }
      button.setAttribute('aria-label', '就「' + friendly(item.label, '该条') + '」向接受该交付的主管提问；' + summary + '。提问不是知悉，也不代表验收或任务完成');
      button.title = '在人类管理窗口中预选该条并填写一个具体问题；提问与答复各记一条对话事实，不改变任务状态、不自动派发或唤醒。仍需由你确认授权、查看预览并提交回执。';
      markControlAvailable(control.host, button);
      button.onclick = () => { globalThis.location.assign(ownerAskHref(item.taskId, item.itemId, item.contentHash)); };
      return button;
    };
    const addDeliveryEntry = (parent, taskId, item, keyPrefix, scope) => {
      const row = document.createElement('article'); row.className = 'delivery-row';
      const body = document.createElement('div'); body.className = 'delivery-row-body';
      append(body, 'p', friendly(item.label, '条目'), 'delivery-row-label');
      append(body, 'p', friendly(item.detail, '未提供内容'));
      const version = document.createElement('small');
      version.textContent = '内容版本 ' + String(item.contentHash || '').slice(0, 12) + '… · 条目编号 ' + friendly(item.itemId, '未提供');
      body.append(version);
      const questionState = record(item.questions);
      if (Number(questionState.totalCount) > 0) {
        append(body, 'small', '该条有 ' + Number(questionState.totalCount) + ' 条提问（' + Number(questionState.pendingCount) + ' 待主管回复）。未回复的问题在主管实际读取前只显示「待领取」；问答正文不进入本页。');
      }
      const controls = document.createElement('div'); controls.className = 'delivery-controls';
      const acknowledgement = record(item.acknowledgement);
      addDeliveryState(controls, String(acknowledgement.state || 'PENDING'),
        acknowledgement.acknowledgedAt ? '于 ' + friendly(new Date(acknowledgement.acknowledgedAt).toLocaleString(), '时间未知') : null);
      if (Number(acknowledgement.historicalCount) > 0) append(controls, 'small', '此前有 ' + acknowledgement.historicalCount + ' 次旧版本知悉，仅留历史，不覆盖当前版本。');
      addChangeControl(controls, item.change, keyPrefix + ':change', taskId);
      addAcknowledgeControl(controls, { label: item.label, acknowledgement: item.acknowledgement, taskId: taskId,
        itemId: item.itemId, contentHash: item.contentHash }, keyPrefix + ':ack');
      addAskControl(controls, { label: item.label, taskId: taskId, itemId: item.itemId,
        contentHash: item.contentHash, questions: item.questions }, keyPrefix + ':ask');
      // 一键复制的只是 direct 命令文本；授权、预选与写入都不在这里发生。
      // 知悉与提问各有一条最小命令：各自只申请对应动作，并在兑换后各自预选同一条目标。
      const launchHint = { kingdomId: scope.kingdomId, territoryId: scope.territoryId,
        supervisorBindingId: scope.supervisorBindingId, taskId: taskId, itemId: item.itemId, contentHash: item.contentHash };
      addLaunchHintControl(controls, launchHint, keyPrefix + ':launch', 'ack');
      addLaunchHintControl(controls, launchHint, keyPrefix + ':launch-ask', 'ask');
      row.append(body, controls); parent.append(row); return row;
    };
    const renderWorkbenchDelivery = (item, index) => {
      const card = document.createElement('article'); card.className = 'workbench-item delivery-item';
      const head = document.createElement('div'); head.className = 'delivery-head';
      addTaskLink(head, item.taskId, item.title, 'delivery:' + item.taskId);
      append(head, 'small', '任务治理：' + stateDisplay(item.status) + ' · 人类验收：尚未记录');
      card.append(head);
      const acceptance = document.createElement('div'); acceptance.className = 'delivery-acceptance';
      append(acceptance, 'small', item.supervisorAccepted
        ? '主管已接受本次尝试的呈报；只有同一尝试的主管 ACCEPT 才使这里显示为已交付。'
        : '主管接受尚未确认：执行者自述不等于交付，也不等于任务完成。');
      append(acceptance, 'small', '人类验收：尚未记录。');
      card.append(acceptance);
      // 弱接受证据在卡片顶部可见，且先于条目层出现；不可见地折叠在注脚里不算标注。
      if (item.deliveryConfirmed) addAcceptanceEvidence(card, item.acceptanceEvidence);
      if (!item.deliveryConfirmed) {
        append(card, 'p', '执行者自述：' + claimSummaryPreview(record(item.claim).summary));
        append(card, 'p', '该任务尚无可确认交付：不展示条目层，也不提供逐条知悉。');
        append(card, 'small', friendly(record(item.acknowledgement).note, ''));
        return card;
      }
      append(card, 'small', '交付编号 ' + friendly(item.deliveryId, '未提供') + ' · 已接受尝试第 ' + friendly(item.attemptNo, '未知') + ' 次。逐条知悉不代表理解、质量认可、人类验收、Task DONE 或发布授权。');
      // 复制命令所需的最小范围事实；缺任一项时按钮禁用，不以 kingdomWide 兜底。
      const launchScope = { kingdomId: item.kingdomId, territoryId: item.territoryId, supervisorBindingId: item.supervisorBindingId };
      const summaryLayer = document.createElement('section'); summaryLayer.className = 'delivery-layer';
      append(summaryLayer, 'h4', '第一层 · 成果摘要');
      const summaryRow = document.createElement('article'); summaryRow.className = 'delivery-row';
      const summaryBody = document.createElement('div'); summaryBody.className = 'delivery-row-body';
      append(summaryBody, 'p', friendly(item.summary, '未提供摘要'), 'delivery-row-label');
      append(summaryBody, 'small', '来源：执行者呈报摘要（Claim），不是独立验证结果。外层摘要知悉不覆盖子条。');
      const summaryControls = document.createElement('div'); summaryControls.className = 'delivery-controls';
      const summaryAcknowledgement = record(item.summaryAcknowledgement);
      if (item.summaryItemId) {
        addDeliveryState(summaryControls, String(summaryAcknowledgement.state || 'PENDING'),
          summaryAcknowledgement.acknowledgedAt ? '于 ' + friendly(new Date(summaryAcknowledgement.acknowledgedAt).toLocaleString(), '时间未知') : null);
        addChangeControl(summaryControls, { kind: 'NOT_LOCATABLE', note: '摘要条目是执行者自述文本，不构成仓库路径；不提供改动链接。' }, 'delivery-summary:' + item.taskId + ':change', item.taskId);
        addAcknowledgeControl(summaryControls, { label: '成果摘要', acknowledgement: summaryAcknowledgement,
          taskId: item.taskId, itemId: item.summaryItemId, contentHash: item.summaryContentHash }, 'delivery-summary:' + item.taskId + ':ack');
        addAskControl(summaryControls, { label: '成果摘要', taskId: item.taskId, itemId: item.summaryItemId,
          contentHash: item.summaryContentHash, questions: item.summaryQuestions }, 'delivery-summary:' + item.taskId + ':ask');
        addLaunchHintControl(summaryControls, { ...launchScope, taskId: item.taskId, itemId: item.summaryItemId,
          contentHash: item.summaryContentHash }, 'delivery-summary:' + item.taskId + ':launch');
      } else {
        addDeliveryState(summaryControls, 'PENDING');
        append(summaryControls, 'small', '摘要层条目投影尚未读取；不能据此判断已知悉。');
      }
      summaryRow.append(summaryBody, summaryControls); summaryLayer.append(summaryRow); card.append(summaryLayer);
      const evidenceLayer = document.createElement('section'); evidenceLayer.className = 'delivery-layer';
      append(evidenceLayer, 'h4', '第二层 · 模块/事项 → 第三层 · 证据/改动');
      append(evidenceLayer, 'small', '只有主管在 ACCEPT 中显式选择、且本地内容寻址证据 hash 重验通过的条目才显示为可定位，并固定标注「主管确认的改动证据」。其余条目一律显示为「不可定位」：执行者自述文本、本机绝对路径与现有 SourceRef 都不会被当作路径。查看差异正文需要有效的人类管理窗口，查看不写入也不自动知悉。', 'delivery-change-policy');
      const modules = Array.isArray(item.modules) ? item.modules : [];
      if (!modules.length) addEmpty(evidenceLayer, '本次交付没有可展示的模块/事项条目。');
      modules.forEach(module => {
        const box = document.createElement('section'); box.className = 'delivery-module';
        append(box, 'h5', friendly(module.label, '模块'));
        append(box, 'small', friendly(module.detail, '未提供模块说明'));
        const entries = Array.isArray(module.items) ? module.items : [];
        if (!entries.length) append(box, 'p', '本模块当前没有条目；这不表示无风险或已验证。');
        entries.forEach(entry => addDeliveryEntry(box, item.taskId, entry, 'delivery:' + item.taskId + ':' + entry.itemId, launchScope));
        evidenceLayer.append(box);
      });
      card.append(evidenceLayer);
      append(card, 'small', friendly(record(item.acknowledgement).note, ''));
      return card;
    };
    const renderWorkbench = snapshot => {
      const data = workbenchData(snapshot);
      renderWorkbenchQueue('today-owner', data.ownerActions, '当前没有明确需要你处理的事项。');
      renderWorkbenchQueue('inbox-owner', data.ownerActions, '当前没有明确需要你处理的事项。主管审查与返工会在下方单独列出。');
      renderWorkbenchQueue('today-exceptions', data.exceptions, '当前没有已投影的执行异常。');
      renderWorkbenchQueue('today-internal', data.internalActions, '当前没有等待团队内部处理的事项。');
      renderWorkbenchQueue('inbox-internal', data.internalActions, '当前没有等待团队内部处理的事项。');
      const active = clear('today-active'); if (active) { const tasks = taskItems().filter(task => ['CREATED', 'ASSIGNED', 'RUNNING', 'REVIEW'].includes(task.status)); if (!tasks.length) addEmpty(active, '尚无进行中的任务。可以先写下一句话目标。'); tasks.slice(0, 6).forEach(task => { const row = document.createElement('article'); row.className = 'workbench-item'; addTaskLink(row, task.taskId, task.title, 'active:' + task.taskId); append(row, 'p', executionExplanation(task)); active.append(row); }); if (tasks.length > 6) { const link = append(active, 'a', '查看全部 ' + tasks.length + ' 个任务'); link.href = '#tasks'; } }
      const deliveries = clear('today-deliveries'); if (deliveries) { const queue = data.deliveries; const items = queueItems(queue); if (!queue) addEmpty(deliveries, '最近交付投影尚未提供。'); else if (!items.length) addEmpty(deliveries, '尚无执行者呈报或交付记录。'); items.forEach((item, index) => deliveries.append(renderWorkbenchDelivery(item, index))); if (queue && queue.truncated) addEmpty(deliveries, '最近交付显示 ' + items.length + ' / ' + queue.totalCount + ' 项。'); }
      // 提问汇总只是元数据：正文不进入本页，也不构成待办或通知。旧内容版本的问题
      // 只留历史，既不算当前待办，也不在这里被说成「当前可回复」。
      const questions = record(data.deliveryQuestions);
      if (deliveries && Number(questions.totalQuestions) > 0) {
        append(deliveries, 'p', '条目提问：共 ' + Number(questions.totalQuestions) + ' 条'
          + '（' + Number(questions.pendingQuestions) + ' 条当前版待主管回复 / ' + Number(questions.answeredQuestions) + ' 已回复'
          + (Number(questions.unreachableQuestions) > 0 ? '；其中 ' + Number(questions.unreachableQuestions) + ' 条当前版提问的接收主管当前不可达，不会改投继任者' : '')
          + (Number(questions.historicalQuestions) > 0 ? '；另有 ' + Number(questions.historicalQuestions) + ' 条属于旧内容版本，仅留历史，不计当前待办' : '')
          + '）。' + friendly(questions.note, ''), 'hint');
      }
      renderCollaboration(data.collaboration); renderWorkbenchUsage(data.usage, data.cost); renderRoleInspector(snapshot);
    };
    const renderCollaboration = value => {
      const parent = clear('collaboration-plans'); const resources = clear('collaboration-resources'); if (!parent || !resources) return;
      const data = record(value); const plans = queueItems(data.plans); const held = queueItems(data.resources);
      const reasons = { PLAN_NOT_ADOPTED:'等待人类采纳整份计划', PLAN_MEMBER_CHANGED:'成员或任务范围已变化，需先核对计划', PLAN_MEMBER_FAILED_OR_UNKNOWN:'成员失败或执行尚未核对，停止新增工作', TASK_NOT_STARTABLE:'任务当前不在可启动状态', DEPENDENCY_NOT_ACCEPTED_OR_STALE:'前置结果尚未接受或已过期', PLAN_NOT_CURRENT:'计划已被替换，需读取当前版本' };
      const explain = (target, readiness, status) => {
        if (status === 'DONE') { append(target, 'p', '主管已接受本任务；不等于人类验收。'); return; }
        if (status === 'REVIEW') { append(target, 'p', '执行者已呈报，等待主管正常审查。'); return; }
        if (!readiness) { append(target, 'p', '就绪情况尚不可用；不能视为已获准启动。'); return; }
        append(target, 'p', readiness.ready ? '依赖条件已满足；启动时仍须核验身份、预算、能力及资源。' : (reasons[readiness.reasonCode] || '当前阻塞原因：' + friendly(readiness.reasonCode, '尚未确认')));
        (readiness.blockingTaskIds || []).forEach(id => addTaskLink(target, id, '核对前置或受影响任务 ' + id, 'plan-block:' + id));
        (readiness.acceptedResults || []).forEach(result => append(target, 'small', '已接受引用：' + result.taskId + ' · 第 ' + result.attemptNo + ' 次 · 结果 ' + result.resultId + ' · 接受记录 ' + result.acceptEventId));
      };
      if (!value) addEmpty(parent, '当前宿主尚未提供协作投影；不会假定已有计划或自动创建团队。');
      else if (!plans.length) addEmpty(parent, '暂无协作计划，沿用单执行者流程。');
      plans.forEach(plan => {
        const panel = document.createElement('details'); panel.className = 'collaboration-plan'; panel.setAttribute('data-read-key', 'plan:' + plan.planId); panel.setAttribute('data-read-anchor', 'plan:' + plan.planId);
        append(panel, 'summary', plan.title + ' · ' + ({PROPOSED:'待采纳',ADOPTED:'已采纳',STALE:'已过期，需重新核对'}[plan.state] || '状态待核对') + ' · 第 ' + plan.version + ' 版');
        addTaskLink(panel, plan.parentTaskId, '查看父任务与整合结果', 'plan-parent:' + plan.planId);
        addDataRow(panel, '协作方式', plan.mode === 'EXPERT' ? '主执行者与只读专家' : '独立工作项小团队');
        append(panel, 'p', '拆分理由：' + plan.reason); addDataRow(panel, '主整合者', friendly(plan.integratorName, plan.integratorBindingId));
        addDataRow(panel, '计划软额度 / 单次估计预留', plan.budgetTokens + ' / ' + plan.reserveTokens + ' Tokens');
        const budget = plan.budget;
        if (budget) {
          append(panel, 'p', ({ALLOW:'预算当前允许新增接纳',WARN:'预算有风险或接近额度',BLOCK_LIMIT:'整项额度不足，停止新增工作',BLOCK_UNKNOWN:'存在未确认成本，停止新增工作'}[budget.state] || '预算状态待核对'));
          addDataRow(panel, '成员执行实报 Token', budget.workerVerifiedTokens); addDataRow(panel, '同期王国协调成本上界 Token', budget.coordinationUpperBoundTokens);
          addDataRow(panel, '估计预留 / 风险敞口', budget.reservedEstimateTokens + ' / ' + budget.exposureTokens);
          addDataRow(panel, '剩余估计额度', budget.remainingTokens); addDataRow(panel, '在途 / 未确认 / 归属缺口', budget.pendingUnits + ' / ' + budget.unknownUnits + ' / ' + budget.attributionGapCount);
          append(panel, 'small', '协调上界含同期王国观测，不能当作精确团队费用或再次分摊。金额未知；王国预算也须同时允许。');
        } else append(panel, 'p', '尚无已采纳计划的用量视图；上方额度是计划值，不是零费用证明。');
        plan.items.forEach(item => {
          const row = document.createElement('article'); row.className = 'workbench-item'; addTaskLink(row, item.status === 'NOT_CREATED' ? null : item.taskId, item.title, 'plan-item:' + item.taskId);
          append(row, 'p', '负责人：' + friendly(item.workerName, item.workerBindingId) + ' · 领地：' + friendly(item.territoryName, item.territoryId) + ' · ' + (item.access === 'READ_ONLY' ? '只读专家' : '允许范围内写入'));
          append(row, 'p', '范围：' + item.description); append(row, 'p', '验收：' + item.acceptanceCriteria); append(row, 'p', '预期产物：' + item.expectedArtifact);
          append(row, 'p', '前置工作：' + (item.dependsOn.length ? item.dependsOn.map(key => friendly(plan.items.find(other => other.key === key)?.title, key)).join('、') : '无'));
          explain(row, item.readiness, item.status);
          const occupancy = held.filter(resource => resource.taskId === item.taskId);
          if (occupancy.length) occupancy.forEach(resource => append(row, 'small', '资源：' + (resource.recovery ? '恢复中，继续保留占用' : resource.state === 'BOUND' ? '已绑定本次执行' : '已预留，尚待绑定') + ' · 第 ' + resource.attemptNo + ' 次'));
          else append(row, 'small', '尚无本项资源接纳记录；不表示工作区空闲，也没有自动排队派发。');
          panel.append(row);
        });
        append(panel, 'h4', '父任务整合'); explain(panel, plan.integration, plan.parentStatus);
        append(panel, 'p', '子项完成后仍由主执行者实际整合、另交呈报并经主管审查；不会自动完成父任务。', 'hint');
        if (plan.state === 'PROPOSED') { const link = append(panel, 'a', '在独立管理窗口审阅并采纳'); link.href = '/owner'; link.setAttribute('data-focus-key', 'plan-adopt:' + plan.planId); }
        const identity = document.createElement('details'); identity.setAttribute('data-read-key', 'plan-identity:' + plan.planId); append(identity, 'summary', '查看固定计划编号与内容指纹'); append(identity, 'p', plan.planId + ' · 第 ' + plan.version + ' 版 · ' + plan.digest); panel.append(identity); parent.append(panel);
      });
      if (record(data.plans).truncated) addEmpty(parent, '仅显示 ' + plans.length + ' / ' + data.plans.totalCount + ' 份计划，请按任务继续核对。');
      if (!held.length) addEmpty(resources, '当前没有已投影的工作区预留；其他原有执行仍可能占用，实际启动前必须重新检查。');
      held.forEach(resource => { const row = document.createElement('article'); row.className = 'workbench-item'; addTaskLink(row, resource.taskId, '任务 ' + resource.taskId, 'resource:' + resource.taskId + ':' + resource.attemptNo); append(row, 'p', '第 ' + resource.attemptNo + ' 次 · ' + (resource.access === 'READ_ONLY' ? '共享只读' : '独占写入') + ' · ' + (resource.recovery ? '恢复中，继续占用' : resource.state === 'BOUND' ? '已绑定执行' : '已预留')); resources.append(row); });
      if (record(data.resources).truncated) addEmpty(resources, '资源占用列表已截断，不能据此判断工作区空闲。');
    };
    const renderAdditionalRoleCost = (parent, value, taskOnly) => {
      if (!value) { addEmpty(parent, '宰相与主管的观测尚不可用；不能按零计算。'); return; }
      append(parent, 'h3', taskOnly ? '准确归属于本任务的宰相与主管用量' : '宰相与主管的已观测用量');
      addDataRow(parent, '可核对的供应商实报 Token', friendly(value.verifiedTokens, '尚无完整实报，合计未知'));
      addDataRow(parent, '完整 / 已观测轮次', value.completeUnits + ' / ' + value.units);
      addDataRow(parent, '在途轮次 / 用量缺失轮次', value.pendingUnits + ' / ' + value.unknownUnits);
      addDataRow(parent, '有实报 / 已观测请求', value.reportedRequests + ' / ' + value.observedRequests);
      (Array.isArray(value.byRole) ? value.byRole : []).forEach(role => addDataRow(parent, (role.roleType === 'CHANCELLOR' ? '宰相' : role.roleType === 'SUPERVISOR' ? '主管' : friendly(role.roleType, '其他角色')) + '已完整实报 Token', friendly(role.verifiedTokens, '未知')));
      if (!taskOnly) { addDataRow(parent, '其中共享轮次 Token', friendly(value.sharedTokens, '尚无可累计的完整实报')); addDataRow(parent, '其中未归属 Token', friendly(value.unattributedTokens, '尚无可累计的完整实报')); addDataRow(parent, '共享或未归属轮次', value.attributionGapCount); append(parent, 'p', '共享和未归属是上述实报的组成部分，不再次累加，也不摊入某个任务。', 'hint'); }
      append(parent, 'p', taskOnly ? '本区只计准确关联本任务的轮次；共享、未归属、未接入的外部参与者及历史缺口均不摊入本任务。费用未知。' : friendly(value.coverageNote, '仅覆盖已接入的观测，外部参与者与历史缺口仍未知。') + ' 费用未知，未配置可信价格表。', 'hint');
    };
    const renderBudgetCost = cost => {
      const parent = clear('budget-summary'); const roles = clear('role-cost-summary'); const runtime = clear('cost-runtime-summary'); const prompts = clear('prompt-cost-summary');
      if (!parent || !roles || !runtime || !prompts) return;
      append(parent, 'h3', '王国软预算'); const budget = record(cost).budget;
      if (!budget) addEmpty(parent, '当前没有可读取的预算视图；这不表示余额充足或成本为零。');
      else {
        const labels = { OFF: '未启用预算拦截', ALLOW: '可接纳新的执行', WARN: '已接近额度或存在需留意的缺口', BLOCK_LIMIT: '额度不足，阻止新增执行', BLOCK_UNKNOWN: '存在未确认用量，阻止新增执行' };
        append(parent, 'p', labels[budget.state] || '预算状态未知', 'usage-coverage');
        addDataRow(parent, '预算周期内可核对实报 Token', budget.verifiedTokens);
        addDataRow(parent, '其中执行者 / 其他已观测角色', budget.workerVerifiedTokens + ' / ' + budget.additionalVerifiedTokens);
        addDataRow(parent, '已预留估计 Token', budget.reservedEstimateTokens);
        addDataRow(parent, '实报与预留合计（估计风险敞口）', budget.exposureTokens);
        addDataRow(parent, '剩余可接纳额度（估计）', friendly(budget.remainingTokens, '尚未设置'));
        addDataRow(parent, '在途 / 未确认 / 恢复中', budget.pendingUnits + ' / ' + budget.unknownUnits + ' / ' + budget.recoveryUnits);
        addDataRow(parent, '共享或未归属项', budget.attributionGapCount);
        const policy = budget.policy;
        if (policy) { addDataRow(parent, '政策额度 / 每次启动预留', policy.limitTokens + ' / ' + policy.reserveTokens + ' Tokens'); addDataRow(parent, '未知用量处理', policy.unknownPolicy === 'BLOCK' ? '阻止新增执行' : '提示后允许继续（风险由政策明确承担）'); addDataRow(parent, '提醒阈值', policy.warningPercent + '%'); addDataRow(parent, '统计起点 / 政策版本', '事件 ' + policy.sinceEventSeq + ' / ' + policy.revision); }
        append(parent, 'p', friendly(budget.note, '预算仅覆盖可观测用量。') + ' 预留是启动前估计，不是供应商账单。收紧政策只影响未来新增接纳，不会自动结束在途执行或释放恢复中的占用；关闭政策不重置统计起点。金额未知。', 'hint');
      }
      const manage = append(parent, 'a', '在管理窗口中调整预算政策'); manage.href = '/owner';
      renderAdditionalRoleCost(roles, record(cost).additionalRoles, false);
      append(runtime, 'h3', '工具展示试点'); const observed = record(record(cost).runtime);
      addDataRow(runtime, '当前配置', observed.toolDisclosureMode === 'off' ? '关闭（默认）' : observed.toolDisclosureMode === 'pilot' ? '有限试点已开启' : '未知，尚未读取运行配置');
      addDataRow(runtime, '角色用量观测接入', observed.observerAvailable === true ? '当前监听可用' : observed.observerAvailable === false ? '当前监听不可用，已有记录仍可查看' : '接入状态未知');
      append(runtime, 'p', '工具展示仅缩小本来已获准的工具集合，不增加权限。尚未获得真实冷暖缓存配对收益证据，不宣称节省比例。', 'hint');
      const list = record(record(cost).prompts); const items = Array.isArray(list.items) ? list.items : [];
      const details = document.createElement('details'); details.setAttribute('data-read-key', 'usage:assembly-byte-observations'); append(details, 'summary', '查看提示装配的字节观察'); prompts.append(details);
      append(details, 'p', '这里只统计装配阶段的片段字节，尚未代表最终请求。历史消息字节与 Token 估算未测；不能把字节下降当作任务总成本下降。', 'hint');
      if (!items.length) addEmpty(details, '尚无可用的提示装配观察。');
      items.forEach(item => { const row = document.createElement('article'); row.className = 'workbench-item'; append(row, 'strong', (item.roleType === 'CHANCELLOR' ? '宰相' : item.roleType === 'SUPERVISOR' ? '主管' : item.roleType === 'WORKER' ? '执行者' : '角色') + ' · 最近装配观察'); addDataRow(row, '工具数量（筛选前 / 后）', friendly(item.toolsBefore, '未知') + ' / ' + friendly(item.toolsAfter, '未知')); addDataRow(row, '工具 schema 字节（筛选前 / 后）', friendly(item.toolsBytesBefore, '未知') + ' / ' + friendly(item.toolsBytesAfter, '未知')); addDataRow(row, '本次观察模式', item.mode === 'pilot' ? '试点' : item.mode === 'off' ? '关闭' : '未知'); (Array.isArray(item.sections) ? item.sections : []).forEach(part => addDataRow(row, '提示片段 · ' + part.name, friendly(part.bytes, '未测') + ' 字节')); (Array.isArray(item.contexts) ? item.contexts : []).forEach(part => addDataRow(row, '上下文片段 · ' + part.name, friendly(part.bytes, '未测') + ' 字节')); if (item.partsTruncated) append(row, 'p', '片段列表已达显示上限，不能视为完整请求。', 'hint'); addDataRow(row, '历史消息字节 / Token 估算', '未测 / 未测'); if (item.reasonCode) addDataRow(row, '观察说明', item.reasonCode); details.append(row); });
      if (list.truncated) append(details, 'p', '仅显示有界的最近角色观察。', 'hint');
    };
    const renderWorkbenchUsage = (usage, cost) => {
      renderBudgetCost(cost);
      const summary = clear('usage-summary'); const content = clear('usage-content'); if (!summary || !content) return;
      if (!usage) { addEmpty(summary, '当前宿主尚未提供用量投影，请重新读取或检查版本。'); return; }
      const statusLabel = ({ COMPLETE: 'Worker Dispatch 报告覆盖完整', PARTIAL: 'Worker Dispatch 报告部分覆盖', UNAVAILABLE: 'Worker Dispatch 用量尚不可用' })[usage.coverage] || '报告覆盖尚未确认';
      append(summary, 'h3', statusLabel); append(summary, 'p', '本区统计范围：Worker Dispatch；宰相、主管与其他请求不在本区合计内。', 'usage-coverage');
      addDataRow(summary, '完整实报 / 全部 Dispatch', usage.completeDispatches + ' / ' + usage.totalDispatches); addDataRow(summary, '部分实报', usage.partialDispatches); addDataRow(summary, '实报不可用', usage.unavailableDispatches); addDataRow(summary, '没有 Dispatch 用量关联的执行', usage.executionsWithoutDispatch);
      if (usage.reportedTotals) { addDataRow(summary, '已完整报告部分的 Token 合计', usage.reportedTotals.totalTokens); addDataRow(summary, '其中未缓存输入 / 输出', usage.reportedTotals.uncachedInputTokens + ' / ' + usage.reportedTotals.outputTokens); } else addEmpty(summary, '尚无可累计的完整报告。合计无法确认，不能按零计算。');
      append(summary, 'p', '费用：尚未记录。推理属于输出，不重复累加。覆盖不足时，上述已报告部分不是整个任务或平台的总用量。', 'hint');
      const dispatches = Array.isArray(record(record(state.snapshot).governance).dispatches) ? state.snapshot.governance.dispatches : [];
      if (!dispatches.length) { addEmpty(content, '当前快照没有逐次 Dispatch 记录；可在任务详情查看已有证据。'); return; }
      append(content, 'h3', '当前投影中的逐次用量'); dispatches.forEach(dispatch => { const row = document.createElement('article'); row.className = 'workbench-item'; const task = taskItems().find(item => item.taskId === dispatch.taskId); addTaskLink(row, dispatch.taskId, task ? task.title : dispatch.taskId, 'usage:' + dispatch.dispatchId); addUsageObservation(row, dispatch); content.append(row); });
    };
    const detailSection = (parent, taskId, key, label) => { const section = document.createElement('section'); section.className = 'task-detail-section'; section.id = 'task-section-' + key; section.setAttribute('data-read-anchor', taskId + ':' + key); append(section, 'h3', label); parent.append(section); return section; };
    const addParagraph = (parent, label, value, fallback) => { append(parent, 'p', label + '：' + friendly(value, fallback)); };
    const addUsageObservation = (parent, dispatch) => { const observed = record(dispatch.usage); const counts = record(observed.usage); append(parent, 'p', '第 ' + dispatch.attemptNo + ' 次执行 · ' + (observed.status === 'COMPLETE' ? counts.totalTokens + ' Tokens；输入未缓存 ' + counts.uncachedInputTokens + '，输出 ' + counts.outputTokens + '（含推理）' : observed.status === 'PARTIAL' ? '部分覆盖：' + observed.reportedRequests + '/' + observed.observedRequests + ' 次请求有实报，合计尚未确认' : '用量不可用，不能按零计算')); if (observed.status === 'COMPLETE') append(parent, 'p', '缓存读取 ' + friendly(counts.cacheReadTokens, '未报告') + ' · 缓存写入 ' + friendly(counts.cacheWriteTokens, '未报告') + ' · 推理 ' + friendly(counts.reasoningTokens, '未单独报告') + '（属于输出，不重复累加）', 'hint'); };
    const renderWorkbenchTaskDetail = (snapshot, detail) => preserveWorkbenchView(() => {
      const parent = clear('task-detail-content'); if (!parent) return;
      const trusted = detail && state.detailTaskId === state.selectedTaskId && record(detail.task).taskId === state.selectedTaskId ? detail : null;
      const task = trusted ? trusted.task : selectedTask();
      if (!task) { addEmpty(parent, state.selectedTaskId ? '所选任务暂不可用，请重新读取；不会改选其他任务。' : '尚无任务，先展开任务草稿，写清目标和验收。'); return; }
      const id = task.taskId; const back = append(parent, 'a', '← 返回' + ({ today: '今日工作台', inbox: '待我处理', overview: '王国地图', map: '王国地图', usage: '用量' }[state.taskReturnSection] || '今日工作台'), 'task-return'); back.href = '#' + (state.taskReturnSection || 'today'); back.setAttribute('data-focus-key', 'task-back');
      const summary = document.createElement('article'); summary.className = 'task-summary-card'; summary.setAttribute('data-read-anchor', id + ':summary'); append(summary, 'h3', task.title); append(summary, 'p', executionExplanation(task)); parent.append(summary);
      const nav = document.createElement('nav'); nav.className = 'task-detail-jump'; nav.setAttribute('aria-label', '任务内容'); ['目标与验收', '当前进展', '交付及验证', '参与者', '用量', '历史'].forEach((label, index) => { const button = append(nav, 'button', label, 'role-inspect-button'); button.type = 'button'; button.setAttribute('data-focus-key', 'detail-jump:' + index); button.onclick = () => { const target = byId('task-section-' + ['goal', 'progress', 'delivery', 'participants', 'usage', 'history'][index]); if (target) { target.tabIndex = -1; target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'start' }); } }; }); parent.append(nav);
      const goal = detailSection(parent, id, 'goal', '目标与验收'); addParagraph(goal, '目标', task.title, '尚未填写'); addParagraph(goal, '范围', task.description, '尚未填写范围'); addParagraph(goal, '验收条件', task.acceptanceCriteria, '尚未填写验收条件');
      const progress = detailSection(parent, id, 'progress', '当前进展'); addStateRow(progress, '任务治理状态', task.status); addStateRow(progress, '本次执行状态', record(task.latestExecution).state || 'NONE'); addDataRow(progress, '尝试次数', task.attemptCount); append(progress, 'p', executionExplanation(task));
      const operations = append(progress, 'button', '查看此任务的合法操作', 'refresh'); operations.type = 'button'; operations.setAttribute('data-focus-key', 'task-operations'); operations.onclick = () => { const target = byId('operation-forms'); if (target) { target.tabIndex = -1; target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'start' }); } };
      const delivery = detailSection(parent, id, 'delivery', '交付及验证'); const claims = trusted && Array.isArray(trusted.claims) ? trusted.claims : task.latestClaim ? [task.latestClaim] : []; const reviews = trusted && Array.isArray(trusted.reviews) ? trusted.reviews : [];
      const statuses = document.createElement('div'); statuses.className = 'task-evidence-states'; const latest = record(task.latestExecution); const latestReview = reviews.slice().sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0))[reviews.length - 1];
      [['执行记录', stateDisplay(latest.state || 'NONE')], ['主管裁定', latestReview ? stateDisplay(latestReview.decision) : '尚无已读取的裁定记录'], ['人类验收', '尚未记录']].forEach(item => { const cell = document.createElement('div'); append(cell, 'strong', item[0]); append(cell, 'span', item[1]); statuses.append(cell); }); delivery.append(statuses);
      if (!trusted) append(delivery, 'p', '完整详情尚未读取成功。下方只显示快照已有的最近呈报；可重新读取补全历史。', 'hint');
      if (!claims.length) addEmpty(delivery, '尚无执行者呈报或产物记录。');
      claims.forEach(claim => { const card = document.createElement('article'); card.className = 'workbench-item'; append(card, 'strong', '第 ' + claim.attemptNo + ' 次执行者呈报 · 自述'); addParagraph(card, '自称结果', claim.claimedOutcome, '未提供'); addParagraph(card, '摘要', claim.summary, '未提供'); if (Array.isArray(claim.artifacts) && claim.artifacts.length) { append(card, 'strong', '产物引用'); claim.artifacts.forEach(artifact => append(card, 'p', artifact)); } else addEmpty(card, '未提供产物引用。'); if (Array.isArray(claim.risks) && claim.risks.length) addParagraph(card, '执行者报告的风险', claim.risks.join('\n'), '未提供'); delivery.append(card); });
      append(delivery, 'p', '验证说明：呈报与产物引用来自执行者自述。当前契约没有独立验证结果字段；主管裁定单独列出，人类验收尚未记录。', 'hint');
      const people = detailSection(parent, id, 'participants', '参与者'); const organization = record(record(record(snapshot.projection).organization).data); const roles = Array.isArray(organization.roles) ? organization.roles : []; const nameFor = bindingId => { const role = roles.find(item => roleBindingRef(item) === bindingId); return role ? friendly(role.roleName, bindingId) : friendly(bindingId, '尚未分配'); }; addParagraph(people, '领地', record(trusted && trusted.territory).name || ((snapshot.territories || []).find(item => item.territoryId === task.territoryId) || {}).name, '尚未确认'); addParagraph(people, '当前执行者', nameFor(task.assignedBindingId), '尚未分配'); const taskTerritory = (Array.isArray(organization.territories) ? organization.territories : []).find(item => typedEntityId(item.territoryRef, 'territory') === task.territoryId); const supervisorId = typedEntityId(record(taskTerritory).supervisorBindingRef, 'binding'); const supervisors = roles.filter(role => role.roleType === 'SUPERVISOR' && roleBindingRef(role) === supervisorId); addParagraph(people, '领地主管', supervisors.map(role => role.roleName).join('、'), '尚未确认'); addParagraph(people, '宰相', roles.filter(role => role.roleType === 'CHANCELLOR').map(role => role.roleName).join('、'), '尚未确认');
      const usage = detailSection(parent, id, 'usage', '用量'); const dispatches = trusted && Array.isArray(record(trusted.governance).dispatches) ? trusted.governance.dispatches : []; if (!dispatches.length) addEmpty(usage, '尚无可用的 Worker Dispatch 用量记录；不能按零计算。'); dispatches.forEach(dispatch => addUsageObservation(usage, dispatch)); append(usage, 'p', '以上覆盖此任务的 Worker Dispatch，不能单独视为整个任务账单。', 'hint'); renderAdditionalRoleCost(usage, trusted && trusted.additionalRoleCost, true);
      const historyPanel = detailSection(parent, id, 'history', '历史'); const historyItems = [];
      if (trusted) { (trusted.assignments || []).forEach(item => historyItems.push({ time: item.assignedAt, label: '分派 · ' + nameFor(item.workerBindingId), detail: item.handoffReason || item.endReason || '已记录责任绑定' })); (trusted.executions || []).forEach(item => historyItems.push({ time: item.startedAt, label: '第 ' + item.attemptNo + ' 次执行 · ' + stateDisplay(item.state), detail: item.detail || '运行观察' })); reviews.forEach(item => historyItems.push({ time: item.createdAt, label: '主管裁定 · ' + stateDisplay(item.decision), detail: item.reason || '未附理由' })); claims.forEach(item => historyItems.push({ time: item.createdAt, label: '第 ' + item.attemptNo + ' 次呈报 · 执行者自述', detail: item.summary || '未附摘要' })); }
      historyItems.sort((a, b) => String(a.time || '').localeCompare(String(b.time || ''))); if (!historyItems.length) addEmpty(historyPanel, trusted ? '尚无分派、执行或审查历史。' : '完整历史尚未读取成功，请重新读取。'); historyItems.forEach(item => { const row = document.createElement('article'); row.className = 'workbench-item'; append(row, 'strong', item.label); append(row, 'p', item.detail); append(row, 'small', friendly(item.time, '时间未提供')); historyPanel.append(row); });
      if (trusted && (trusted.relatedEventsTruncated || trusted.reviewsTruncated)) addEmpty(historyPanel, '历史事件或主管裁定已达到投影上限；这里展示有界窗口，不代表完整历史。');
      const technical = document.createElement('details'); technical.className = 'task-technical'; technical.setAttribute('data-read-key', id + ':technical'); append(technical, 'summary', '展开治理与技术详情'); addDataRow(technical, '任务编号', id); addDataRow(technical, '领地编号', task.territoryId); addDataRow(technical, '详情版本', trusted ? trusted.revision : '尚未读取'); parent.append(technical);
      setText('task-detail-revision', trusted ? '最近更新 · 详情版本 ' + trusted.revision : '完整详情尚未读取');
    });
    const renderRoleInspector = snapshot => {
      const shell = byId('role-inspector'); const parent = clear('role-inspector-content'); if (!shell || !parent) return; shell.hidden = !state.selectedRoleId; if (shell.hidden) return;
      const organization = record(record(record(snapshot.projection).organization).data); const role = (Array.isArray(organization.roles) ? organization.roles : []).find(item => roleBindingRef(item) === state.selectedRoleId);
      if (!role) { addEmpty(parent, '所选角色已不在当前投影中，请重新选择地图中的角色。'); return; }
      append(parent, 'h3', role.roleName); const kind = role.roleType; append(parent, 'p', ({ CHANCELLOR: '职责：统筹目标、规划任务，并交给所属领地。', SUPERVISOR: '职责：在所属领地分派任务、核对执行并审查呈报。', WORKER: '职责：在授权范围执行任务，提交产物与风险说明。' })[kind] || '职责以宿主组织绑定为准。');
      addParagraph(parent, '会话', role.sessionBound ? '已绑定' : '尚未绑定', '尚未确认');
      const rolesProjection = record(workbenchData(snapshot).roles); const projected = queueItems(rolesProjection).find(item => item.bindingId === state.selectedRoleId || typedEntityId(item.bindingRef, 'binding') === state.selectedRoleId);
      // v3.2.0：主管必须隶属领地；未隶属的遗留席位在此显式标注为待处理，不推断归属。
      if (kind === 'SUPERVISOR') {
        const seatTerritories = projected && Array.isArray(projected.territories) ? projected.territories : [];
        addParagraph(parent, '隶属领地', seatTerritories.length
          ? seatTerritories.map(item => text(item.name) + '（' + text(item.territoryId) + '）').join('、')
          : '未隶属领地（待处理）', '尚未确认');
      }
      const tasks = projected && Array.isArray(projected.taskIds) ? taskItems().filter(task => projected.taskIds.includes(task.taskId)) : taskItems().filter(task => kind === 'WORKER' ? task.assignedBindingId === state.selectedRoleId : kind === 'SUPERVISOR' ? task.territoryId === typedEntityId(role.territoryRef, 'territory') : false);
      append(parent, 'h4', '职责范围内的任务'); if (!tasks.length) addEmpty(parent, '当前没有已投影的关联任务。'); tasks.forEach(task => { const row = document.createElement('article'); row.className = 'workbench-item'; addTaskLink(row, task.taskId, task.title, 'role-task:' + task.taskId); append(row, 'p', executionExplanation(task)); parent.append(row); });
      if (projected) { addDataRow(parent, '进行中执行', projected.activeExecutionCount); addDataRow(parent, '待主管复核', projected.reviewTaskCount); addDataRow(parent, '恢复核对中', projected.recoveringTaskCount); if (projected.taskIdsTruncated) addEmpty(parent, '关联任务已截断：显示 ' + projected.taskIds.length + ' / ' + projected.taskCount + ' 项。'); }
    };
    const openRoleInspector = bindingId => { state.selectedRoleId = bindingId; renderRoleInspector(state.snapshot || {}); const inspector = byId('role-inspector'); if (inspector) { inspector.hidden = false; inspector.focus({ preventScroll: true }); inspector.scrollIntoView({ block: 'nearest' }); } };
    const addRoleInspectorButton = (parent, bindingId) => { if (!bindingId) return; const button = append(parent, 'button', '查看职责与任务', 'role-inspect-button'); button.type = 'button'; button.setAttribute('data-focus-key', 'role:' + bindingId); button.onclick = () => openRoleInspector(bindingId); };
    const stageWorkbenchGoal = goal => { const title = byId('task-title'); if (!title) return false; if (String(title.value || '').trim() && String(title.value || '').trim() !== goal) return false; title.value = goal; return true; };
    const consumeSubmittedDraft = payload => {
      const fields = [['task-title', 'title'], ['task-description', 'description'], ['task-acceptance', 'acceptance_criteria'], ['task-territory', 'territory_id']];
      const unchanged = fields.every(([id, key]) => { const input = byId(id); return input && String(input.value || '').trim() === String(payload[key] || '').trim(); });
      if (!unchanged) return false;
      fields.forEach(([id]) => { byId(id).value = ''; }); clearComposerTerritory();
      const quick = byId('quick-task-goal'); if (quick && String(quick.value || '').trim() === String(payload.title || '').trim()) quick.value = '';
      return true;
    };
    const mountWorkbench = () => {
      const tasks = byId('tasks'); const zones = document.querySelector('.zones'); if (tasks && zones) { tasks.setAttribute('data-console-page', 'tasks'); tasks.hidden = true; zones.append(tasks); }
      const management = byId('management'); if (management) management.setAttribute('data-console-page', 'legacy-management');
      const composer = document.querySelector('.task-composer-card'); if (composer && tasks) { const draft = document.createElement('details'); draft.id = 'task-draft-panel'; draft.className = 'task-draft-panel'; append(draft, 'summary', '新建任务 · 编辑草稿'); draft.append(composer); tasks.insertBefore(draft, tasks.firstChild); }
      const actionDock = byId('operation-forms'); const detailParent = byId('task-detail-content'); if (actionDock && detailParent) { actionDock.classList.add('task-actions-inline'); detailParent.parentElement.append(actionDock); }
      const capability = document.querySelector('.capability-card'); if (capability) byId('settings-control-slot').append(capability);
      const owner = document.querySelector('.owner-management'); if (owner) { owner.querySelectorAll('.owner-actions').forEach(node => node.remove()); byId('settings-owner-slot').append(owner); }
      const overview = byId('overview'); const grid = overview && overview.querySelector('.council-grid'); if (grid) { grid.classList.add('role-workbench-layout'); const inspector = document.createElement('aside'); inspector.id = 'role-inspector'; inspector.className = 'role-inspector'; inspector.hidden = true; inspector.tabIndex = -1; inspector.setAttribute('aria-label', '角色职责与任务'); const close = append(inspector, 'button', '关闭角色侧栏', 'refresh'); close.type = 'button'; close.onclick = () => { const roleId = state.selectedRoleId; state.selectedRoleId = ''; inspector.hidden = true; const original = Array.from(document.querySelectorAll('[data-focus-key]')).find(node => node.getAttribute('data-focus-key') === 'role:' + roleId); if (original) original.focus(); }; const content = document.createElement('div'); content.id = 'role-inspector-content'; inspector.append(content); grid.append(inspector); }
      const quick = byId('quick-task-form'); if (quick) quick.addEventListener('submit', event => { event.preventDefault(); const goal = String(byId('quick-task-goal').value || '').trim(); if (!goal) return; const title = byId('task-title'); if (!stageWorkbenchGoal(goal)) status('已有未提交草稿，请在任务页继续编辑。新目标保留在工作台输入框中。', 'neutral'); else status('草稿尚未提交，请补充范围和验收条件。', 'neutral'); history.pushState(null, '', '#tasks'); applyNavigationFromLocation(false); const draft = byId('task-draft-panel'); if (draft) { draft.open = true; readerDetails.set(draft.id, true); } if (title) { title.focus(); title.scrollIntoView({ block: 'center' }); } });
      const refresh = byId('workbench-refresh'); if (refresh) refresh.onclick = () => { void load(false); };
      const territory = byId('task-territory'); if (territory) territory.addEventListener('change', () => { state.selectedTerritoryId = territory.value; const chip = byId('task-territory-chip'); if (chip) chip.hidden = true; });
      document.addEventListener('click', event => { const target = event.target && typeof event.target.closest === 'function' ? event.target.closest('a[href]') : null; if (target && String(target.getAttribute('href') || '').startsWith('#task=') && state.activeSection !== 'tasks') state.taskReturnSection = state.activeSection === 'overview' ? 'map' : state.activeSection; });
      const header = document.querySelector('.realm-sidebar'); if (header) header.style.minHeight = '0'; const syncHeaderHeight = () => { if (header && typeof header.getBoundingClientRect === 'function') document.documentElement.style.setProperty('--nav-height', Math.ceil(header.getBoundingClientRect().height) + 'px'); }; syncHeaderHeight();
      if (header && typeof globalThis.ResizeObserver === 'function') { const headerObserver = new globalThis.ResizeObserver(syncHeaderHeight); headerObserver.observe(header); }
    };
`;
