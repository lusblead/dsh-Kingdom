/** Self-contained management surface; all business values are rendered as text. */
export function renderOwnerApp(nonce: string): string {
  if (!/^[A-Za-z0-9_-]{20,100}$/u.test(nonce)) throw new Error('invalid owner page nonce')
  return OWNER_APP_HTML.replaceAll('__OWNER_NONCE__', nonce)
}

const OWNER_APP_HTML = String.raw`<!doctype html>
<html lang="zh-CN" data-theme="forest"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>王国管理 · dsh-Kingdom</title>
<style nonce="__OWNER_NONCE__">
:root{color-scheme:dark;--bg:#132920;--panel:#1d372b;--soft:#243f31;--ink:#f4ecda;--muted:#bec5b4;--line:#526346;--accent:#e4c483;--button:#f0d49a;--button-ink:#213123;font-family:system-ui,"Microsoft YaHei",sans-serif}
:root[data-theme=parchment]{color-scheme:light;--bg:#efe4cb;--panel:#faf3e3;--soft:#eee1c5;--ink:#392d21;--muted:#6e624d;--line:#b7a47d;--accent:#745326;--button:#674c28;--button-ink:#fff7e6}
:root[data-theme=night]{--bg:#101f35;--panel:#1b2c45;--soft:#223750;--ink:#edf1fa;--muted:#bac8dd;--line:#526a8a;--accent:#bbd2ee;--button:#c7dcef;--button-ink:#142239}
:root[data-theme=wine]{--bg:#301e29;--panel:#402a36;--soft:#4f3342;--ink:#f9e8e9;--muted:#d6b9c6;--line:#866573;--accent:#efc4b6;--button:#f0cbb6;--button-ink:#3b2430}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);line-height:1.55}main{width:min(100% - 40px,1020px);margin:auto;padding:26px 0 64px}header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:28px}a{color:var(--accent);text-underline-offset:4px}h1{font-size:clamp(1.7rem,4vw,2.5rem);font-weight:650;letter-spacing:.02em;margin:0 0 8px}h2{font-size:1.12rem;margin:0 0 12px}p{margin:8px 0}.eyebrow{letter-spacing:.15em;font-size:.76rem;color:var(--accent)}.muted,small{color:var(--muted)}.panel{padding:24px;border:1px solid var(--line);background:var(--panel);border-radius:14px;margin:18px 0;overflow-wrap:anywhere}.bar{display:flex;gap:16px;justify-content:space-between;align-items:start}.stack{display:grid;gap:15px}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.field{display:grid;gap:7px;min-width:0}.field.wide{grid-column:1/-1}label{font-weight:600}input,select,textarea,button{font:inherit}input,select,textarea{width:100%;min-width:0;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:10px 12px}textarea{min-height:90px;resize:vertical}button{border:1px solid var(--line);padding:10px 18px;border-radius:8px;cursor:pointer;background:var(--soft);color:var(--ink);min-height:44px}button.primary{background:var(--button);color:var(--button-ink);border-color:var(--button);font-weight:700}button:disabled{opacity:.5;cursor:default}:focus-visible{outline:3px solid var(--accent);outline-offset:3px}fieldset{border:0;margin:0;padding:0;min-width:0}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}.status{padding:12px 0;min-height:30px;white-space:pre-wrap}.tag{display:inline-block;border:1px solid var(--line);border-radius:20px;padding:3px 10px;margin:4px 7px 0 0;font-size:.84rem}.changes{margin:0}.change{border-top:1px solid var(--line);padding:12px 0}.change dt{font-weight:700}.change dd{margin:6px 0 0;white-space:pre-wrap}.before{color:var(--muted)}.after{color:var(--accent)}code{display:block;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--bg);padding:14px;border-radius:8px;font-size:.85rem}.ceiling-row{display:grid;grid-template-columns:minmax(0,1fr) 100px auto;gap:10px;align-items:end}.receipt-meta{font-size:.8rem;color:var(--muted);overflow-wrap:anywhere}[hidden]{display:none!important}#theme{width:auto}.title-note{max-width:70ch}.scope-summary{white-space:pre-line}.danger{border-color:var(--accent)}
@media(max-width:600px){main{width:calc(100% - 24px);padding-top:16px}header{align-items:start}.panel{padding:17px}.fields{grid-template-columns:minmax(0,1fr)}.bar{display:grid;gap:12px}.bar button{justify-self:start}.ceiling-row{grid-template-columns:minmax(0,1fr) 92px}.ceiling-row button{grid-column:1/-1;justify-self:start}.actions button{flex:1 1 auto}h1{font-size:1.85rem}}
.evidence-weak{padding:10px 12px;border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:8px;background:var(--soft);overflow-wrap:anywhere}
.evidence-weak strong{margin-right:4px}
.change-body{display:grid;gap:8px}
.change-body code{font-size:.82rem}
.change-body code[data-hunk=ADDED]{border-left:3px solid var(--accent)}
.change-body code[data-hunk=REMOVED]{opacity:.85;border-left:3px solid var(--line)}
.question-history-entry{text-align:left;width:100%;justify-self:start}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
</style></head><body><main>
<header><a href="/console#settings">← 返回工作台设置</a><label class="field" for="theme"><span class="muted">外观</span><select id="theme"><option value="forest">森林墨绿</option><option value="parchment">羊皮纸</option><option value="night">夜蓝星图</option><option value="wine">酒红议会</option></select></label></header>
<div class="eyebrow">KINGDOM / OWNER</div><h1>王国管理</h1><p class="title-note muted">在已授权范围内管理领地、角色与执行配置。每次变更先查看影响，再确认应用。</p>
<p id="status" class="status" role="status" aria-live="polite">正在检查管理窗口…</p>
<section id="activation" class="panel" hidden><h2>从本地打开管理窗口</h2><p>当前没有可用的管理授权。请由人类在 DSH 的直接命令入口打开一次管理窗口，再使用返回的短期链接。</p><p class="muted">普通工作台会话不会自动获得管理权；每个窗口都需要明确操作范围，并在十分钟内到期。</p><details><summary>首次初始化的本地命令</summary><p>只用于尚未建立王国的空库；初始化后需要按实际范围重新激活。</p><code>/kingdom owner.gui {"kingdomId":null,"actions":["init"],"scope":{"kingdomWide":false,"territoryIds":[],"bindingIds":[],"roleTypes":[],"targetSessionIds":[],"workspaceRoots":[]},"ttlMs":600000}</code></details></section>
<section id="window" class="panel" hidden><div class="bar"><div><h2>本次管理范围</h2><p id="scope" class="scope-summary"></p><p id="expiry" class="muted"></p></div><button id="revoke" class="danger" type="button">立即撤销管理窗口</button></div></section>
<section id="editor" class="panel" hidden><h2>准备变更</h2><form id="operation-form"><fieldset id="edit-fields"><div class="field"><label for="action">要进行的操作</label><select id="action" required></select></div><p id="action-note" class="muted"></p><div id="fields" class="fields"></div><div class="actions"><button id="prepare" class="primary" type="submit" title="先核对本次变更的准确影响，再决定是否提交。">查看变更预览</button></div></fieldset></form></section>
<section id="preview-panel" class="panel" hidden><h2>确认本次变更</h2><p id="preview-summary"></p><dl id="changes" class="changes"></dl><p id="preview-expiry" class="muted"></p><div class="actions"><button id="commit" class="primary" type="button" title="提交上面列出的准确变更；提交前会再次核对当前状态。">确认应用此变更</button><button id="edit-again" type="button" title="返回修改内容；修改后需要重新生成预览。">返回修改</button></div></section>
<section id="result-panel" class="panel" hidden><h2 id="result-title">操作结果</h2><p id="result-message"></p><p id="result-meta" class="receipt-meta"></p><div class="actions"><button id="lookup" type="button" hidden>查询本次操作结果</button><button id="next" type="button" hidden>准备下一项变更</button></div></section>
<section id="change-panel" class="panel" hidden><h2>主管确认的改动证据</h2><p class="muted">只读查看某条已由主管确认的改动。查看不写入任何事实，也不自动记为已知悉；它不是 Git 作者证据，也不改变任务或 Claim。</p><div id="change-body" class="change-body" aria-live="polite"></div></section>
<section id="question-thread" class="panel" hidden><h2>条目提问与主管回复</h2><p class="muted">只读查看这一条交付条目的提问与回复。读取不写入任何事实、不自动知悉、也不替你回复；未回复的问题只显示「待领取」，不表示主管已通知或已阅读。问答正文不进入工作台或任何通用事件投影。</p><div id="question-thread-body" class="change-body" aria-live="polite"></div></section>
<section id="question-history" class="panel" hidden><h2>问答历史（只读）</h2><p class="muted">这里列出本窗口授权范围内已有提问记录的条目，包括已离开当前交付目录、目前无法重验的旧问答。只读回看：不写入任何事实、不自动知悉，也不能作为新提问目标；新提问只能针对当前已确认交付条目。</p><div id="question-history-list" class="stack"></div></section>
</main><script nonce="__OWNER_NONCE__">
(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const state = { control: null, decisionId: null, preview: null, busy: false, uncertain: false, ackTarget: null, ackHintInvalid: false, askTarget: null, askHintInvalid: false, askThread: null, changeTarget: null, changeHintInvalid: false, questionLimit: 50, questionSeq: 0 };
  /**
   * 工作台知悉图标带入的准确条目引用（task/item/contentHash 三元组）。
   * 这里只做格式校验与预选；它不构成授权，也不写入任何事实。
   *
   * 必须区分两种情形：完全没有 ack_* 参数时保持目录默认选择；一旦出现 ack_*
   * 参数却非法（缺失、重复、超长或含非法字符），就按「目标非法」处理——
   * 清空选择并禁用准备，绝不退回目录第一条充当兜底成功路径。
   */
  const ackTargetFromLocation = () => {
    try {
      if (typeof location === 'undefined' || typeof location.search !== 'string') return { state: 'ABSENT' };
      const query = location.search.startsWith('?') ? location.search.slice(1) : location.search;
      if (!query) return { state: 'ABSENT' };
      const values = {};
      let present = false;
      for (const part of query.split('&')) {
        if (!part) continue;
        const at = part.indexOf('=');
        const key = decodeURIComponent(at < 0 ? part : part.slice(0, at));
        if (!['ack_task','ack_item','ack_hash'].includes(key)) continue;
        present = true;
        if (Object.hasOwn(values,key)) return { state: 'INVALID' };
        values[key] = at < 0 ? '' : decodeURIComponent(part.slice(at + 1));
      }
      if (!present) return { state: 'ABSENT' };
      const safe = value => typeof value === 'string' && /^[A-Za-z0-9_.:@-]{1,96}$/u.test(value) ? value : null;
      const taskId = safe(values.ack_task); const itemId = safe(values.ack_item); const contentHash = safe(values.ack_hash);
      return taskId && itemId && contentHash ? { state: 'TARGET', target: { taskId, itemId, contentHash } } : { state: 'INVALID' };
    } catch { return { state: 'INVALID' }; }
  };
  const ackHint = ackTargetFromLocation();
  state.ackTarget = ackHint.state === 'TARGET' ? ackHint.target : null;
  state.ackHintInvalid = ackHint.state === 'INVALID';
  /**
   * 工作台提问图标带入的准确条目引用（与知悉同款三元组，只是目标动作不同）。
   *
   * 纪律完全一致：没有 ask_* 参数时保持目录默认；一旦出现却缺失、重复或非法，
   * 就清空选择并禁用准备，绝不退回目录第一条。提问与知悉互不触发。
   */
  const askTargetFromLocation = () => {
    try {
      if (typeof location === 'undefined' || typeof location.search !== 'string') return { state: 'ABSENT' };
      const query = location.search.startsWith('?') ? location.search.slice(1) : location.search;
      if (!query) return { state: 'ABSENT' };
      const values = {};
      let present = false;
      for (const part of query.split('&')) {
        if (!part) continue;
        const at = part.indexOf('=');
        const key = decodeURIComponent(at < 0 ? part : part.slice(0, at));
        if (!['ask_task','ask_item','ask_hash'].includes(key)) continue;
        present = true;
        if (Object.hasOwn(values,key)) return { state: 'INVALID' };
        values[key] = at < 0 ? '' : decodeURIComponent(part.slice(at + 1));
      }
      if (!present) return { state: 'ABSENT' };
      const safe = value => typeof value === 'string' && /^[A-Za-z0-9_.:@-]{1,96}$/u.test(value) ? value : null;
      const taskId = safe(values.ask_task); const itemId = safe(values.ask_item); const contentHash = safe(values.ask_hash);
      return taskId && itemId && contentHash ? { state: 'TARGET', target: { taskId, itemId, contentHash } } : { state: 'INVALID' };
    } catch { return { state: 'INVALID' }; }
  };
  const askHint = askTargetFromLocation();
  state.askTarget = askHint.state === 'TARGET' ? askHint.target : null;
  state.askHintInvalid = askHint.state === 'INVALID';
  // 只读线程面板的目标：预选提示或本窗口刚提交的条目；不参与任何授权判断。
  state.askThread = state.askTarget ? { taskId: state.askTarget.taskId, itemId: state.askTarget.itemId } : null;
  /**
   * 工作台「查看改动」图标带入的精确引用（task/evidence/entry 三元组）。
   *
   * 与知悉提示同款纪律：完全没有 change_* 参数时不显示；一旦出现却缺失、重复或
   * 非法，就按「目标非法」处理并明确不做替代选择，绝不退回目录里其他条目。
   * 这些参数不构成授权：读取仍由服务端按当前 ACTIVE 窗口与 scope 判定。
   */
  const changeTargetFromLocation = () => {
    try {
      if (typeof location === 'undefined' || typeof location.search !== 'string') return { state: 'ABSENT' };
      const query = location.search.startsWith('?') ? location.search.slice(1) : location.search;
      if (!query) return { state: 'ABSENT' };
      const values = {};
      let present = false;
      for (const part of query.split('&')) {
        if (!part) continue;
        const at = part.indexOf('=');
        const key = decodeURIComponent(at < 0 ? part : part.slice(0, at));
        if (!['change_task','change_evidence','change_item'].includes(key)) continue;
        present = true;
        if (Object.hasOwn(values,key)) return { state: 'INVALID' };
        values[key] = at < 0 ? '' : decodeURIComponent(part.slice(at + 1));
      }
      if (!present) return { state: 'ABSENT' };
      const safeTask = value => typeof value === 'string' && /^[A-Za-z0-9_.:@-]{1,96}$/u.test(value) ? value : null;
      const safeDigest = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value) ? value : null;
      const taskId = safeTask(values.change_task);
      const evidenceId = safeDigest(values.change_evidence);
      const entryId = safeDigest(values.change_item);
      return taskId && evidenceId && entryId ? { state: 'TARGET', target: { taskId, evidenceId, entryId } } : { state: 'INVALID' };
    } catch { return { state: 'INVALID' }; }
  };
  const changeHint = changeTargetFromLocation();
  state.changeTarget = changeHint.state === 'TARGET' ? changeHint.target : null;
  state.changeHintInvalid = changeHint.state === 'INVALID';
  const pendingKey = 'dsh-kingdom.owner.pending.v1';
  let pendingInvalid = false;
  try { const raw=sessionStorage.getItem(pendingKey); if(raw) { const value=JSON.parse(raw);
    if(!value || !['decisionId','prepareId','operationId'].every(key=>typeof value[key]==='string' && value[key].length>0 && value[key].length<=768)) throw new Error('invalid pending reference');
    state.decisionId=value.decisionId; state.preview={prepareId:value.prepareId,operationId:value.operationId}; state.uncertain=true;
  } } catch { pendingInvalid=true; state.uncertain=true; }
  function rememberPending() { const raw=JSON.stringify({decisionId:state.decisionId,prepareId:state.preview.prepareId,operationId:state.preview.operationId});
    try { sessionStorage.setItem(pendingKey,raw); if(sessionStorage.getItem(pendingKey)!==raw) throw new Error(); }
    catch { const error=new Error('浏览器无法保留操作编号，本次尚未发送。请允许此页面使用会话存储后重新预览。'); error.confirmedRejection=true; throw error; }
  }
  function clearPending() { try { sessionStorage.removeItem(pendingKey); } catch {} }
  const names = { init:'初始化王国', 'territory.create':'创建领地', 'territory.update':'修改领地名称与说明', 'territory.supervisor':'任命领地主管', 'role.bind':'登记新角色', 'role.session':'调整角色会话', ceiling:'调整王国权限上限', 'execution-profile':'设置执行模型', 'budget.policy':'调整软预算政策', 'plan.adopt':'采纳一份协作计划', 'delivery.item.ack':'逐条记下已知悉交付' };
  const roleNames = { CHANCELLOR:'宰相', SUPERVISOR:'主管', WORKER:'执行者' };
  const notes = { init:'初始化只创建王国与人类所有者，完成后本次授权即结束。', 'territory.create':'选择已存在且在授权根目录内的工作目录；这里不会创建目录。', 'territory.update':'保留工作目录和已有会话关系。', 'territory.supervisor':'仍有未决执行或工作占用时，变更将被拒绝。', 'role.bind':'主管与宰相需要真实运行会话；执行者会话由正常执行流程建立。', 'role.session':'仅调整主管或宰相；不会迁移执行者的持久会话。', ceiling:'此映射将替换王国上限。请完整列出本次需要配置的能力；它不会改变已在途的运行限制。', 'execution-profile':'保存的是请求配置；只有后续真实运行才能确认实际使用的模型。', 'budget.policy':'软预算按 Token 管理新增执行，不是费用硬上限。每次启动的预留是估计；关闭不重置统计起点，调整不会终止在途工作或释放恢复中的占用。' };
  notes['plan.adopt']='一次采纳完整计划及其固定版本。采纳只创建子任务；主管仍须合法分配、启动和审查，主执行者仍须实际整合。不会自动授权、派发或接受产物。';
  notes['delivery.item.ack']='只对已被主管 ACCEPT 确认的交付条目生效，一次一条、只记当前内容版本，不采集理由或理解程度。它不改变任务状态、主管审查、正式 Owner acceptance 与发布状态。重复知悉同一版本不会新增记录。';
  names['delivery.item.question']='就一条交付条目提问';
  notes['delivery.item.question']='只对已被主管 ACCEPT 确认的交付条目生效，一次一条、只记当前内容版本。问题交给**接受该交付的主管**；如果原主管已退任、换了 session 或该领地已改绑，问题保持可见但明确不可达，不会自动转给继任者。提问不是知悉，也不改变任务状态、主管审查、Owner acceptance 与发布状态；重复提交同一条目的同一问题不会新增记录，回复由该主管在其 session-bound Agent Tool 中完成。';
  const text = (id, value) => { el(id).textContent = String(value ?? ''); };
  const status = value => text('status', value);
  const show = (id, visible) => { el(id).hidden = !visible; };
  const active = () => state.control?.decision?.state === 'ACTIVE' && Date.parse(state.control.decision.expiresAt) > Date.now();
  function applyTheme(value) { const theme = ['forest','parchment','night','wine'].includes(value) ? value : 'forest'; document.documentElement.dataset.theme = theme; el('theme').value = theme; try { localStorage.setItem('dsh-kingdom.console.theme', theme); } catch {} }
  let stored = 'forest'; try { stored = localStorage.getItem('dsh-kingdom.console.theme'); } catch {} applyTheme(stored);
  el('theme').addEventListener('change', () => applyTheme(el('theme').value));
  const make = (tag, value, className) => { const node = document.createElement(tag); if (value !== undefined) node.textContent = value; if (className) node.className = className; return node; };
  const options = (select, values) => { select.replaceChildren(); for (const value of values) { const option = make('option', value.label); option.value = value.id; select.append(option); } };
  function field(key, label, kind = 'text', choices, required = true) {
    const box = make('div', undefined, 'field' + (kind === 'textarea' ? ' wide' : ''));
    const input = make(kind === 'textarea' ? 'textarea' : kind === 'select' ? 'select' : 'input'); input.id = 'param-' + key; input.name = key; input.required = required;
    if (input.tagName === 'INPUT') input.type = kind;
    if (kind === 'select') options(input, choices || []);
    if (kind === 'text' || kind === 'textarea') input.maxLength = kind === 'textarea' ? 4000 : 2000;
    const title = make('label', label); title.htmlFor = input.id; box.append(title, input); el('fields').append(box); return input;
  }
  function allowedBindings(filter) { return (state.control.catalog?.bindings || []).filter(filter || (() => true)).map(item => ({id:item.id,label:(roleNames[item.roleType] || item.roleType) + ' · ' + item.roleName + ' · ' + item.id})); }
  function ceilingRow() {
    const row = make('div', undefined, 'ceiling-row');
    const box = make('label', '能力名称', 'field'); const input = make('input'); input.required = true; input.maxLength = 200; input.setAttribute('aria-label', '能力名称'); box.append(input);
    const selectBox = make('label', '是否允许', 'field'); const select = make('select'); select.setAttribute('aria-label', '是否允许'); options(select,[{id:'true',label:'允许'},{id:'false',label:'禁止'}]); selectBox.append(select);
    const remove = make('button','移除此项'); remove.type='button'; remove.addEventListener('click',()=>row.remove()); row.append(box,selectBox,remove); return row;
  }
  function renderFields() {
    state.preview = null; state.uncertain = false; show('preview-panel',false); show('result-panel',false); el('fields').replaceChildren();
    const action = el('action').value; const catalog = state.control.catalog || {}; text('action-note', notes[action]);
    const territories = (catalog.territories || []).map(item => ({id:item.id,label:item.name + ' · ' + item.id}));
    const sessions = (catalog.runtimeSessions || []).map(item => ({id:item.id,label:item.label + ' · ' + item.id}));
    if (action === 'init') { field('kingdom_name','王国名称'); field('owner_name','所有者显示名'); }
    if (action === 'territory.create') { field('name','领地名称'); field('workspace_path','已存在的工作目录'); field('summary','领地说明','textarea',undefined,false); const roots = make('p','允许的根目录：' + (catalog.workspaceRoots || []).join('；'),'muted'); roots.classList.add('wide'); el('fields').append(roots); }
    if (action === 'territory.update') { field('territory_id','领地','select',territories); field('name','新名称（不改请留空）','text',undefined,false); field('summary','新说明（不改请留空）','textarea',undefined,false); }
    if (action === 'territory.supervisor') { field('territory_id','领地','select',territories); field('supervisor_binding_id','主管','select',allowedBindings(item=>item.roleType==='SUPERVISOR')); }
    if (action === 'role.bind') {
      const role = field('role_type','角色','select',(state.control.decision.scope.roleTypes || []).map(id=>({id,label:roleNames[id]}))); field('role_name','角色名称');
      const session = field('session_id','运行会话','select',sessions); const update = () => { const needed = role.value !== 'WORKER'; session.required = needed; session.disabled = !needed; session.parentElement.hidden = !needed; }; role.addEventListener('change',update); update();
    }
    if (action === 'role.session') { field('binding_id','要调整的角色','select',allowedBindings(item=>['CHANCELLOR','SUPERVISOR'].includes(item.roleType))); field('session_id','新的运行会话','select',sessions); }
    if (action === 'execution-profile') {
      field('binding_id','要配置的角色','select',allowedBindings(item=>['CHANCELLOR','SUPERVISOR','WORKER'].includes(item.roleType)));
      field('provider','模型服务商（可选，留空使用现有配置默认值）','text',undefined,false); field('model','模型名称');
    }
    if (action === 'ceiling') { const rows=make('div',undefined,'stack field wide'); rows.id='ceiling-rows'; rows.append(ceilingRow()); const add=make('button','添加能力'); add.type='button'; add.addEventListener('click',()=>rows.append(ceilingRow())); el('fields').append(rows,add); }
    if (action === 'budget.policy') {
      field('enabled','预算拦截','select',[{id:'true',label:'启用，按政策检查新增执行'},{id:'false',label:'关闭，保留统计起点与已有记录'}]);
      const limit=field('limit_tokens','周期 Token 额度','number'); limit.min='1'; limit.step='1';
      const reserve=field('reserve_tokens','每次新执行预留 Token（估计）','number'); reserve.min='1'; reserve.step='1';
      field('unknown_policy','存在未知用量时','select',[{id:'BLOCK',label:'阻止新增执行，先核对未知用量'},{id:'WARN',label:'提示后继续，可能超过估计额度'}]);
      const warning=field('warning_percent','提醒阈值（百分比）','number'); warning.min='1'; warning.max='100'; warning.step='1'; warning.value='80';
    }
    if (action === 'plan.adopt') {
      const plans=(Array.isArray(catalog.plans)?catalog.plans:[]).filter(plan=>plan.state==='PROPOSED');
      const selection=field('plan_id','本次采纳的完整计划','select',plans.map(plan=>({id:plan.planId,label:plan.parentTaskId+' · 第 '+plan.version+' 版 · '+(plan.mode==='EXPERT'?'只读专家':'独立小团队')})));
      const version=field('version','固定版本','number'); version.readOnly=true;
      const digest=field('digest','内容指纹（固定）','textarea'); digest.readOnly=true; digest.rows=3; digest.style.overflowWrap='anywhere'; digest.style.wordBreak='break-all';
      const review=make('section',undefined,'field wide'); review.id='plan-adoption-review'; review.setAttribute('aria-live','polite'); el('fields').append(review);
      const update=()=>{ review.replaceChildren(); const plan=plans.find(item=>item.planId===selection.value); version.value=plan?String(plan.version):''; digest.value=plan?plan.digest:'';
        if(!plan){review.append(make('p',plans.length?'请选择一份计划，再核对完整分工。':'当前授权范围内没有可采纳计划；请先核对计划状态及本窗口范围。','muted'));return;}
        const binding=id=>(catalog.bindings || []).find(item=>item.id===id)?.roleName || id;
        const territory=id=>(catalog.territories || []).find(item=>item.id===id)?.name || id;
        review.append(make('h3','整份计划 · '+plan.parentTaskId),make('p','拆分理由：'+plan.reason),make('p','主整合者：'+binding(plan.integratorBindingId)),make('p','整项软额度 '+plan.budgetTokens+' Tokens；每次估计预留 '+plan.reserveTokens+' Tokens。金额未知。'));
        plan.items.forEach(item=>{const row=make('article',undefined,'change');row.append(make('h4',item.title),make('p','负责人：'+binding(item.workerBindingId)+' · 领地：'+territory(item.territoryId)+' · '+(item.access==='READ_ONLY'?'只读':'范围内写入')),make('p','范围：'+item.description),make('p','验收：'+item.acceptanceCriteria),make('p','前置工作：'+(item.dependsOn.length?item.dependsOn.map(key=>plan.items.find(other=>other.key===key)?.title || key).join('、'):'无')),make('p','预期产物：'+item.expectedArtifact));review.append(row);});
        review.append(make('p','所有子项接受后，由指定主执行者实际整合，再由主管正常审查父任务。此采纳不代表产物验收。','muted'));
      }; selection.addEventListener('change',update); update();
    }
    if (action === 'delivery.item.ack') {
      const all=(Array.isArray(catalog.deliveryItems)?catalog.deliveryItems:[]);
      const stateLabels={ACKNOWLEDGED:'该条当前版本已知悉',PENDING:'待知悉',PENDING_REVISION:'已有旧版本知悉，当前版本待知悉'};
      const selection=field('item_key','要记下已知悉的条目','select',all.map(item=>({id:item.itemId,label:item.taskTitle+' · '+(item.layer==='SUMMARY'?'成果摘要':'证据')+' · '+item.label+' · '+(stateLabels[item.acknowledgementState]||item.acknowledgementState)})));
      const detail=make('section',undefined,'field wide'); detail.id='delivery-ack-review'; detail.setAttribute('aria-live','polite'); el('fields').append(detail);
      // 工作台带入的三元组必须与当前授权范围目录完全一致才预选；否则不做任何替代选择。
      const target=state.ackTarget; state.ackTarget=null;
      // 「有但非法」与「没有」必须区分：前者清空选择并禁用准备，绝不默认其他条目。
      const invalidHint=state.ackHintInvalid;
      const matched=target?all.find(candidate=>candidate.taskId===target.taskId && candidate.itemId===target.itemId && candidate.contentHash===target.contentHash):null;
      if(target) selection.value=matched?matched.itemId:'';
      else if(invalidHint){ selection.value=''; el('prepare').disabled=true; }
      const update=()=>{
        detail.replaceChildren();
        if(invalidHint) detail.append(make('p','地址中的条目提示缺失、重复或非法，无法定位任何一条交付：已清空选择并禁用准备，不会退回目录中的其他条目。请重新读取清单后自行选择，或从工作台重新复制激活命令。','muted'));
        if(target) detail.append(make('p',matched
          ? '已按工作台提供的准确条目预选：任务、条目与内容版本三者一致。仍需由你查看变更预览并确认提交；知悉不会自动写入。'
          : '无法在当前授权范围定位该条交付：任务、条目与内容版本必须同时匹配。不会提供替代或回退选择；请重新读取清单后自行选择，或按实际范围重新激活管理窗口。','muted'));
        const item=all.find(candidate=>candidate.itemId===selection.value);
        if(!item){ detail.append(make('p',invalidHint?'当前没有可提交的条目；非法提示不会被当作有效目标。':all.length?'请选择一条交付条目后再核对。':'本次授权范围内没有已确认交付条目。只有已被主管 ACCEPT 确认的交付才会出现在这里；执行者自述不算交付。','muted')); el('prepare').disabled=invalidHint||all.length===0; return; }
        detail.append(make('h3','条目内容 · '+(item.layer==='SUMMARY'?'成果摘要':'证据/改动')));
        detail.append(make('p','任务：'+item.taskTitle+'（'+item.taskId+'） · 已接受尝试第 '+item.attemptNo+' 次'));
        detail.append(make('p','条目：'+item.label));
        detail.append(make('p','内容：'+item.detail));
        detail.append(make('p','改动定位：'+(item.changeKind==='REPO_RELATIVE_VERIFIED'?'可验证的仓库相对路径与固定版本':'不可定位')+'。'+item.changeNote));
        detail.append(make('p','内容版本：'+item.contentHash));
        // 接受证据强度必须在 Owner 窗口可见：legacy v1.0.0 的 TASK_ACCEPTED 缺少被审查
        // 结果 ID 与内容摘要，允许知悉但不得冒充 exact result-bound。
        if(item.acceptanceEvidenceKind==='LEGACY_ATTEMPT_ONLY') {
          const weak=make('p',undefined,'evidence-weak'); weak.setAttribute('data-acceptance-evidence','LEGACY_ATTEMPT_ONLY'); weak.setAttribute('role','note');
          weak.append(make('strong','历史接受证据较弱：'),make('span',item.acceptanceEvidenceNote || '该 Task/attempt 的 TASK_ACCEPTED 是 v1.0.0 旧格式，只有尝试编号，缺少被审查结果 ID 与内容摘要；本条按真实事件字段与同 Task/attempt 的唯一 WorkerResult 判定，不构成 exact result-bound 证据。'));          detail.append(weak);
        } else if(item.acceptanceEvidenceKind==='EXACT_RESULT_BOUND') {
          detail.append(make('p','接受证据强度：exact result-bound（TASK_ACCEPTED 锁定了本次结果 ID 与内容摘要，且两者都与当前呈报一致）。','muted'));
        } else {
          detail.append(make('p','接受证据强度未在本窗口中给出；按最弱解释处理，不要据此推断 exact result-bound。','muted'));
        }
        detail.append(make('p','当前知悉状态：'+(stateLabels[item.acknowledgementState]||item.acknowledgementState)+(item.acknowledgedAt?' · '+new Date(item.acknowledgedAt).toLocaleString():'')));
        detail.append(make('p','知悉只表示已知悉该条当前版本，不代表理解、质量认可、Task DONE、正式验收或发布授权；外层摘要知悉不覆盖子条。','muted'));
        el('prepare').disabled=item.acknowledgementState==='ACKNOWLEDGED';
        if(item.acknowledgementState==='ACKNOWLEDGED') detail.append(make('p','该条当前版本已记录 Owner 知悉；重复知悉不会新增记录。','muted'));
      };
      selection.addEventListener('change',update); update();
    }
    if (action === 'delivery.item.question') {
      const all=(Array.isArray(catalog.deliveryItems)?catalog.deliveryItems:[]);
      const selection=field('item_key','要提问的条目','select',all.map(item=>({id:item.itemId,label:item.taskTitle+' · '+(item.layer==='SUMMARY'?'成果摘要':'证据')+' · '+item.label+' · '+(item.questions?('已有 '+item.questions.totalCount+' 条提问'):'尚无提问')})));
      const question=field('question_text','要问主管的问题（一次一条，提交前可预览）','textarea');
      const detail=make('section',undefined,'field wide'); detail.id='delivery-question-review'; detail.setAttribute('aria-live','polite'); el('fields').append(detail);
      // 与知悉同款：工作台带入的三元组必须与当前授权目录完全一致才预选。
      const target=state.askTarget; state.askTarget=null;
      const invalidHint=state.askHintInvalid;
      const matched=target?all.find(candidate=>candidate.taskId===target.taskId && candidate.itemId===target.itemId && candidate.contentHash===target.contentHash):null;
      if(target) selection.value=matched?matched.itemId:'';
      else if(invalidHint){ selection.value=''; el('prepare').disabled=true; }
      const update=()=>{
        detail.replaceChildren();
        if(invalidHint) detail.append(make('p','地址中的条目提示缺失、重复或非法，无法定位任何一条交付：已清空选择并禁用准备，不会退回目录中的其他条目。请重新读取清单后自行选择，或从工作台重新复制激活命令。','muted'));
        if(target) detail.append(make('p',matched
          ? '已按工作台提供的准确条目预选：任务、条目与内容版本三者一致。仍需由你填写问题、查看变更预览并确认提交；提问不会自动写入。'
          : '无法在当前授权范围定位该条交付：任务、条目与内容版本必须同时匹配。不会提供替代或回退选择；请重新读取清单后自行选择，或按实际范围重新激活管理窗口。','muted'));
        const item=all.find(candidate=>candidate.itemId===selection.value);
        if(!item){ detail.append(make('p',invalidHint?'当前没有可提交的条目；非法提示不会被当作有效目标。':all.length?'请选择一条交付条目后再核对。':'本次授权范围内没有已确认交付条目。只有已被主管 ACCEPT 确认的交付才会出现在这里；执行者自述不算交付。','muted')); el('prepare').disabled=invalidHint||all.length===0; return; }
        detail.append(make('h3','条目的准确引用'));
        detail.append(make('p','任务：'+item.taskTitle+'（'+item.taskId+'） · 已接受尝试第 '+item.attemptNo+' 次'));
        detail.append(make('p','条目：'+item.label));
        detail.append(make('p','内容版本：'+item.contentHash));
        detail.append(make('p','接收者：接受该交付的主管；若其已退任、换 session 或领地已改绑，本条不可达，也不会自动改投继任者。','muted'));
        const questions=item.questions;
        detail.append(make('p', questions
          ? '该条已有 '+questions.totalCount+' 条提问（'+questions.pendingCount+' 待主管回复 / '+questions.answeredCount+' 已回复）。未回复的问题在主管实际读取前只显示「待领取」。'
          : '该条还没有提问记录。','muted'));
        detail.append(make('p','提问不是知悉：它不改变任务状态、主管审查、Owner acceptance 与发布状态，也不自动派发或唤醒任何 Agent。','muted'));
        el('prepare').disabled=invalidHint||!item.contentHash||!item.itemId;
        // 选条目即可只读回看：不要求先发新问题、也不要求带 ask_* 提示重开窗口。
        // 这里只触发既有精确只读 GET，不发送任何写请求、不自动知悉。
        if(item.itemId){ state.askThread={ taskId:item.taskId, itemId:item.itemId }; state.questionLimit=50; void renderQuestions(); }
      };
      selection.addEventListener('change',update); update();
    }
  }
  function payload() {
    const action=el('action').value; const parameters={};
    for (const field of el('fields').querySelectorAll('[name]')) if (!field.disabled && field.value.trim() !== '') parameters[field.name]=field.value.trim();
    if (action==='execution-profile') { const binding_id=parameters.binding_id; if (!parameters.model) throw new Error('请填写明确的模型名称。'); const profile={...(parameters.provider?{provider:parameters.provider}:{}),model:parameters.model}; return {action,parameters:{binding_id,profile}}; }
    if (action==='ceiling') { const ceiling=Object.create(null); for (const row of el('ceiling-rows').children) { const name=row.querySelector('input').value.trim(); if (!name || Object.hasOwn(ceiling,name)) throw new Error('能力名称不能为空或重复。'); ceiling[name]=row.querySelector('select').value==='true'; } if (!Object.keys(ceiling).length) throw new Error('请至少配置一项能力。'); return {action,parameters:{ceiling}}; }
    if (action==='budget.policy') { const numeric={}; for (const key of ['limit_tokens','reserve_tokens','warning_percent']) { const value=Number(parameters[key]); if (!Number.isSafeInteger(value) || value<1 || key==='warning_percent' && value>100) throw new Error('预算额度、预留和阈值必须是范围内的正整数。'); numeric[key]=value; } if (numeric.reserve_tokens>numeric.limit_tokens) throw new Error('每次预留不能超过周期额度。'); return {action,parameters:{enabled:parameters.enabled==='true',...numeric,unknown_policy:parameters.unknown_policy}}; }
    if (action==='plan.adopt') { const plan=(state.control.catalog?.plans || []).find(item=>item.planId===parameters.plan_id && item.state==='PROPOSED'); const version=Number(parameters.version); if(!plan || !Number.isSafeInteger(version) || version<1 || version!==plan.version || parameters.digest!==plan.digest) throw new Error('请选择当前范围内的完整计划；版本或内容指纹已变化时请重新读取。'); return {action,parameters:{plan_id:plan.planId,version:plan.version,digest:plan.digest}}; }
    if (action==='delivery.item.ack') { const item=(state.control.catalog?.deliveryItems || []).find(candidate=>candidate.itemId===parameters.item_key); if(!item) throw new Error('请选择当前范围内的一条已确认交付条目。'); return {action,parameters:{task_id:item.taskId,delivery_id:item.deliveryId,item_id:item.itemId,content_hash:item.contentHash,attempt_no:item.attemptNo,result_id:item.resultId}}; }
    if (action==='delivery.item.question') {
      const item=(state.control.catalog?.deliveryItems || []).find(candidate=>candidate.itemId===parameters.item_key);
      if(!item) throw new Error('请选择当前范围内的一条已确认交付条目。');
      const questionText=String(parameters.question_text || '').trim();
      if(!questionText) throw new Error('请填写要问主管的具体问题；提交前会先给出预览。');
      return {action,parameters:{task_id:item.taskId,delivery_id:item.deliveryId,item_id:item.itemId,content_hash:item.contentHash,attempt_no:item.attemptNo,result_id:item.resultId,question_text:questionText}};
    }
    if (action==='territory.update' && !parameters.name && !parameters.summary) throw new Error('请填写要修改的名称或说明。');
    return {action,parameters};
  }
  async function request(path, body) {
    const config={credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}};
    if (path.startsWith('receipts/')) config.headers['X-Kingdom-Decision-Id']=state.decisionId;
    if (body !== undefined) { config.method='POST'; config.headers['Content-Type']='application/json'; config.headers['X-Kingdom-Client']='owner-gui'; config.headers['X-Kingdom-CSRF']=state.control.csrfToken; config.headers['X-Kingdom-Request-Id']=crypto.randomUUID(); config.body=JSON.stringify(body); }
    const response=await fetch('/api/owner/'+path,config); let result;
    try { result=await response.json(); } catch { throw new Error('未收到可核对的服务端结果。'); }
    if (!response.ok || result.ok===false) { const error=new Error(result.message || '请求未成功。'); error.confirmedRejection=response.status===409 && ['PREVIEW_STALE','PREVIEW_EXPIRED','MUTATION_NOT_APPLIED'].includes(result.errorCode); throw error; }
    return result;
  }
  async function requestChange(target) {
    const query = 'task=' + encodeURIComponent(target.taskId) + '&evidence=' + encodeURIComponent(target.evidenceId) + '&item=' + encodeURIComponent(target.entryId);
    const response = await fetch('/api/owner/delivery-change?' + query, { credentials:'same-origin', cache:'no-store', headers:{ Accept:'application/json' } });
    let result;
    try { result = await response.json(); } catch { throw new Error('未收到可核对的服务端结果。'); }
    if (!response.ok || result.ok === false) throw new Error(result.message || '读取改动证据未成功。');
    return result;
  }
  /**
   * 只读渲染某条交付条目的问答线程。
   *
   * 与改动读取同款边界：缺窗口、未授权该动作、超范围或条目不存在都如实说明，
   * 不做替代选择；这里不发送任何写请求，也不自动知悉。
   */
  async function requestQuestions(target) {
    const query = 'task=' + encodeURIComponent(target.taskId) + '&item=' + encodeURIComponent(target.itemId);
    const response = await fetch('/api/owner/delivery-questions?' + query, { credentials:'same-origin', cache:'no-store', headers:{ Accept:'application/json' } });
    let result;
    try { result = await response.json(); } catch { throw new Error('未收到可核对的服务端结果。'); }
    if (!response.ok || result.ok === false) throw new Error(result.message || '读取问答记录未成功。');
    return result;
  }
  /**
   * 逐条卡片：先标出该问题相对当前交付目录的版本关系，再谈可达性。
   *
   * 历史版与无法重验的问题仍可读、仍显示原文与回复，但绝不能被读成「当前可回复」：
   * 它们不计当前待办，界面也要明说。这不是可写状态，只是本窗口的展示判定；写入端
   * 另有自己的版本门。
   */
  function questionCard(question) {
    const version = question.itemVersion === 'CURRENT' ? 'CURRENT' : question.itemVersion === 'UNVERIFIABLE' ? 'UNVERIFIABLE' : 'HISTORICAL';
    const card = make('article',undefined,'change');
    card.setAttribute('data-item-version',version);
    card.append(make('h4','提问 · ' + new Date(question.askedAt).toLocaleString()));
    card.append(make('p',version === 'CURRENT' ? '版本：已验证当前版（内容版本与提问时一致）'
      : version === 'UNVERIFIABLE' ? '版本：无法重验（当前交付目录无法重新派生该条目版本；不计当前待办，也不可回复）'
        : '版本：历史版（可确认的旧内容版本，仅留历史；不是当前待办，也不可回复）','muted'));
    card.append(make('p',question.questionText));
    card.append(make('p','接收者：' + question.reviewerBindingId,'muted'));
    card.append(make('p',version === 'CURRENT'
      ? question.replyStateNote
      // 不进当前回复的卡片不展示可达性判定：Core 只按此刻的 binding 与领地关系计算，
      // 既没有当时证据，也不能暗示旧问题现在仍可回复。因此这里只说明版本事实。
      : version === 'UNVERIFIABLE'
        ? '该问题不参与当前回复：当前交付无法重验它所属条目的内容版本，因此既不能当作当前版，也不能断言它是旧版；它不会作为当前待办，也不能回复。'
        : '该问题不参与当前回复：它只对提问时的那一内容版本有效；它不会作为当前待办，也不能在现在回复。',
      version === 'CURRENT' ? 'muted' : 'evidence-weak'));
    if (question.reply) {
      card.append(make('h4','主管回复 · ' + new Date(question.reply.repliedAt).toLocaleString()));
      card.append(make('p',question.reply.replyText));
      card.append(make('p','回复者：' + question.reply.responderBindingId,'muted'));
    } else if (version === 'HISTORICAL') {
      card.append(make('p','该历史版问题没有回复记录；它不会被算作当前待领取。','muted'));
    } else if (version === 'UNVERIFIABLE') {
      card.append(make('p','该问题没有回复记录，且当前无法重验其条目版本；它不会被算作当前待领取，也不能回复。','muted'));
    } else {
      card.append(make('p','待领取（尚未确认主管已读取）；这不表示已通知或已阅读。','muted'));
    }
    return card;
  }
  function renderQuestions(focusAfterRender) {
    const target = state.askThread;
    if (!target) return;
    show('question-thread', true);
    const body = el('question-thread-body'); if (!body) return;
    // 防串：快速改选条目后，慢的旧响应不得覆盖新面板。序号在每次发起读取时递增，
    // 响应回来时若已不是最新一次请求（或目标已换）就丢弃，不写任何 DOM。
    const seq = ++state.questionSeq;
    // 焦点意图按**本次调用**捕获，不放共享 state：这样它天然受上面的防串守卫约束，
    // 过期的 A 响应在守卫处就已返回，不会把焦点或视口跳到旧线程。
    // 'MORE' 是键盘连续翻页（点「更多」会重建整段 DOM，原按钮随即消失，渲染完成后
    // 把焦点交给新的「更多」按钮，或全部显示完时最后揭示的那张卡片）；'THREAD' 是
    // 从只读历史条目点入后，把焦点与视口送回上方真实线程标题。
    const limit = Math.max(1, state.questionLimit);
    body.replaceChildren(make('p','正在读取该条目的问答记录…','muted'));
    return (async () => {
      try {
        const thread = (await requestQuestions(target)).questions;
        if (seq !== state.questionSeq || state.askThread !== target) return;
        body.replaceChildren();
        const heading = make('h3', thread.taskTitle + ' · ' + thread.itemLabel);
        heading.id = 'question-thread-heading';
        body.append(heading);
        body.append(make('p','任务 '+thread.taskId+' · 条目 '+thread.itemId+' · '
          + (thread.contentHash ? '当前内容版本 '+thread.contentHash : '当前交付无法重验该条目版本'),'muted'));
        body.append(make('p','共 '+thread.questions.length+' 条提问（'+thread.pendingCount+' 条当前版待领取 / '+thread.answeredCount+' 条已回复'
          +(thread.historyCount?('；'+thread.historyCount+' 条属于旧内容版本，仅留历史，不计当前待办'):'')
          +(thread.unverifiableCount?('；'+thread.unverifiableCount+' 条当前无法重验，不计当前待办，也不可回复'):'')+'）。','muted'));
        const shown=Math.min(limit, thread.questions.length);
        let lastCard=null;
        for (const question of thread.questions.slice(0,shown)) { lastCard=questionCard(question); body.append(lastCard); }
        let more=null;
        if (thread.questions.length > shown) {
          // 文案必须覆盖整份列表：它展开的既有当前版，也有历史版和无法重验的记录。
          more = make('button','显示更多提问记录（已显示 '+shown+' / 共 '+thread.questions.length+' 条）');
          more.type='button'; more.id='question-more';
          more.title='继续显示余下的提问与回复；仍然只读，不写入任何事实。';
          more.addEventListener('click',()=>{ state.questionLimit=shown+50; void renderQuestions('MORE'); });
          body.append(more);
        }
        if(focusAfterRender==='MORE') {
          if(more) more.focus();
          else if(lastCard){ lastCard.tabIndex=-1; lastCard.focus(); }
        } else if(focusAfterRender==='THREAD') {
          // 只读历史列表在页面靠下，而线程详情在它上方：点完靠下的条目后，更新的内容
          // 落在当前视口之外。标题本身不可聚焦，这里临时给 tabIndex=-1 让程序化焦点成立，
          // 再把视口带到真实线程开头；焦点只在上面防串守卫通过后才动。
          heading.tabIndex=-1; heading.focus();
          if(typeof heading.scrollIntoView === 'function') heading.scrollIntoView({ block: 'start' });
        }
        body.append(make('p',thread.note,'muted'));
        body.append(make('p','只读查看：不写入任何事实，也不自动记为已知悉；回复只由接受该交付的主管在其 session-bound Agent Tool 中完成。','muted'));
      } catch (error) {
        if (seq !== state.questionSeq || state.askThread !== target) return;
        const failure = make('p','读取失败：'+error.message+' 不会退回其他条目；请确认管理窗口仍然有效、已授权该动作并在授权范围内。','muted');
        body.replaceChildren(failure);
        // 与新鲜成功同款：线程详情在历史列表上方，失败若只写进上方面板，停在下方列表的
        // Owner 看不到。这里仍只在**本次**失败通过上面防串守卫后，才把焦点与视口落到这条
        // 失败消息本身；自动预选/改选触发的读取不动焦点，避免页面加载时抢走键盘位置。
        // 过期 A 失败在守卫处已返回，既不会覆盖 B 的面板，也不会把焦点或视口跳回旧线程。
        if (focusAfterRender === 'THREAD') {
          failure.tabIndex=-1; failure.focus();
          if(typeof failure.scrollIntoView === 'function') failure.scrollIntoView({ block: 'start' });
        }
      }
    })();
  }
  /**
   * 只读问答历史入口。
   *
   * 只列出 Core 已按本窗口 scope 与 delivery.item.question 动作过滤后的既有提问条目
   * （含已离开当前交付目录、目前无法重验的旧问答）。按钮只切换只读线程目标：
   * 它不在表单内、也不进入 prepare 的目录来源，因此不能作为新提问目标，且不写任何事实。
   * 线程详情在列表上方，点击后由 renderQuestions('THREAD') 在真实响应就绪时才把
   * 焦点与视口送到线程标题，靠下的条目点完也有当前视口反馈。
   */
  function renderQuestionHistory() {
    const panel = el('question-history'); const list = el('question-history-list');
    if (!panel || !list) return;
    list.replaceChildren();
    const entries = Array.isArray(state.control?.catalog?.deliveryQuestionHistory) ? state.control.catalog.deliveryQuestionHistory : [];
    if (!entries.length) { panel.hidden = true; return; }
    panel.hidden = false;
    for (const entry of entries) {
      const version = entry.latestItemVersion === 'CURRENT' ? '当前版' : entry.latestItemVersion === 'UNVERIFIABLE' ? '当前无法重验' : '旧内容版本';
      const button = make('button', entry.taskTitle + ' · ' + entry.itemLabel + ' · ' + version
        + '（共 ' + entry.questionCount + ' 条提问，' + entry.pendingCount + ' 条当前版待领取）· 最后提问 ' + new Date(entry.lastAskedAt).toLocaleString());
      button.type='button'; button.className='question-history-entry';
      button.setAttribute('data-question-history','READ_ONLY');
      button.title='只读回看这一条的提问与回复；不会用作新提问目标，也不写入任何事实。';
      button.addEventListener('click',()=>{ state.askThread={ taskId:entry.taskId, itemId:entry.itemId }; state.questionLimit=50; void renderQuestions('THREAD'); });
      list.append(button);
    }
  }
  /**
   * 只读渲染已确认改动。缺窗口、超范围、证据漂移或条目不存在都如实说明，
   * 且不做替代选择；这里不发送任何写请求。
   */
  async function renderChange() {
    if (!state.changeTarget && !state.changeHintInvalid) return;
    show('change-panel', true);
    const body = el('change-body');
    body.replaceChildren();
    if (state.changeHintInvalid) {
      body.append(make('p','地址中的改动提示缺失、重复或非法：无法定位任何一条改动，也不会退回其他条目。请从工作台重新打开该条改动。','muted'));
      return;
    }
    body.append(make('p','正在读取该条改动证据…','muted'));
    try {
      const result = await requestChange(state.changeTarget);
      const change = result.change;
      body.replaceChildren();
      body.append(make('h3','主管确认的改动证据 · ' + change.status));
      body.append(make('p','任务：' + change.taskTitle + '（' + change.taskId + '） · 第 ' + change.attemptNo + ' 次尝试'));
      body.append(make('p','仓库相对路径：' + change.repoPath));
      body.append(make('p','固定版本：' + change.revision + ' · VCS：' + change.repoVcs + (change.repoHead ? '（基准 ' + String(change.repoHead).slice(0,12) + '）' : '')));
      body.append(make('p','证据级别：有界窗口观测 + 主管确认；不证明 Git 作者身份，也不证明由哪个执行者写入。','muted'));
      body.append(make('p', change.coverageComplete
        ? '覆盖：完整。'
        : '覆盖：部分（' + ((change.coverageReasons || []).join('、') || '存在未判定项') + '）；不得据此判断为完整覆盖。', 'muted'));
      body.append(make('p', change.note, 'muted'));
      const hunks = Array.isArray(change.hunks) ? change.hunks : [];
      if (!hunks.length) body.append(make('p','本条目没有可展示的行级片段（二进制、超限或正文未保留）。','muted'));
      for (const hunk of hunks.slice(0,200)) {
        const line = make('code', (hunk.kind === 'ADDED' ? '+ ' : '- ') + String(hunk.text));
        line.setAttribute('data-hunk', hunk.kind === 'ADDED' ? 'ADDED' : 'REMOVED');
        body.append(line);
      }
      body.append(make('p','只读查看：不写入任何事实，也不自动记为已知悉。逐条知悉仍须在管理窗口中另行准备、预览并提交。','muted'));
    } catch (error) {
      body.replaceChildren(make('p','读取失败：' + error.message + ' 不会退回其他条目；请确认管理窗口仍然有效并在授权范围内。','muted'));
    }
  }
  function lock(value) { state.busy=value; el('edit-fields').disabled=value || !!state.preview || state.uncertain || !active(); el('commit').disabled=value || !state.preview || !active() || state.uncertain; el('edit-again').disabled=value || state.uncertain; el('next').disabled=value || state.uncertain; el('commit').title=el('commit').disabled?'当前不能提交：需要先查看变更预览，且管理窗口必须有效。':'确认应用上面列出的准确变更。'; }  function scopeText(view) {
    const scope=view.scope; const catalog=state.control.catalog || {};
    const lines=[view.kingdomId?'王国：'+view.kingdomId:'仅允许初始化空王国', '操作：'+view.actions.map(action=>names[action] || action).join('、')];
    if (scope.kingdomWide) lines.push('包含明确授权的王国级配置');
    if (scope.territoryIds.length) lines.push('领地：'+(catalog.territories || []).map(item=>item.name).join('、'));
    if (scope.bindingIds.length) lines.push('角色：'+(catalog.bindings || []).map(item=>item.roleName).join('、'));
    return lines.join('\n');
  }
  async function load() {
    try {
      if(pendingInvalid) throw new Error('浏览器中的待确认操作引用无法读取。请保留当前页面并核对原操作记录后再继续。');
      if(state.uncertain && state.preview) { show('result-panel',true); show('lookup',true); show('next',false); text('result-title','正在恢复待确认操作'); text('result-meta','决定 '+state.decisionId+' · 操作 '+state.preview.operationId); }
      const control=await request('control');
      if (state.decisionId !== null && control.decision.decisionId !== state.decisionId) throw new Error('管理窗口已被替换。请保留原决定与操作编号核对结果，不要重新提交原变更。');
      if (state.decisionId === null) state.decisionId=control.decision.decisionId;
      state.control=control;
      if(state.uncertain && state.preview) { show('editor',false); show('preview-panel',false); lock(false); await lookupReceipt(); tick(); return; }
      if (!active()) { tick(); return; }
      show('activation',false); show('window',true); show('editor',true); text('scope',scopeText(control.decision));
      const available=control.decision.actions.filter(action=>Object.hasOwn(names,action));
      options(el('action'),available.map(id=>({id,label:names[id]})));
      let openNotice='';
      // 预选只发生在本次窗口确实授权了对应动作时；否则提示按实际范围重新激活。
      if(!available.includes('delivery.item.ack') && (state.ackTarget || state.ackHintInvalid)) {
        state.ackTarget=null; state.ackHintInvalid=false;
        openNotice='当前管理窗口的授权范围不包含「逐条记下已知悉交付」，无法预选该条目；请按实际范围重新激活管理窗口。';
      }
      if(!available.includes('delivery.item.question') && (state.askTarget || state.askHintInvalid)) {
        state.askTarget=null; state.askHintInvalid=false; state.askThread=null;
        openNotice='当前管理窗口的授权范围不包含「就一条交付条目提问」，无法预选该条目；请按实际范围重新激活管理窗口。';
      }
      if(state.ackTarget) el('action').value='delivery.item.ack';
      if(state.askTarget) el('action').value='delivery.item.question';
      renderFields(); lock(false); status(openNotice || '管理窗口已就绪。填写变更后先查看预览。'); tick();
      // 只读问答线程与历史入口在窗口就绪后单独渲染：它们不参与授权，也不写任何事实。
      renderQuestionHistory();
      void renderQuestions();
    } catch(error) { show('activation',true); show('editor',false); show('window',false); status(error.message); }
  }
  function expire(message) { show('activation',true); show('editor',false); el('commit').disabled=true; el('revoke').disabled=true; status(message); }
  function tick() { if (!state.control) return; const seconds=Math.max(0,Math.ceil((Date.parse(state.control.decision.expiresAt)-Date.now())/1000)); text('expiry','授权剩余 '+Math.floor(seconds/60)+' 分 '+seconds%60+' 秒'); if (!active()) { const receiptUntil=Date.parse(state.control.receiptExpiresAt || ''); expire(Number.isFinite(receiptUntil) && receiptUntil>Date.now()?'写窗口已到期或撤销，仍可在五分钟宽限期内查询已提交结果；新变更需要重新激活。':'管理窗口及结果查询宽限期已结束。请保留操作编号并重新核对。'); } }
  setInterval(tick,1000);
  el('action').addEventListener('change',renderFields);
  el('operation-form').addEventListener('submit',async event=>{
    event.preventDefault(); if (state.busy || state.uncertain || !active()) return; lock(true); status('正在核对范围与当前状态…');
    try { const result=await request('prepare',payload()); state.preview=result.preview; show('preview-panel',true); text('preview-summary',result.preview.summary); el('changes').replaceChildren();
      for (const change of result.preview.changes) { const row=make('div',undefined,'change'); row.append(make('dt',change.label),make('dd','当前：'+(change.before ?? '无'),'before'),make('dd','应用后：'+(change.after ?? '无'),'after')); el('changes').append(row); }
      text('preview-expiry','预览有效至 '+new Date(result.preview.expiresAt).toLocaleTimeString()+'。提交前会再次检查当前状态。'); status('请确认下面的准确变更。'); el('commit').focus();
    } catch(error) { status(error.message); } finally { lock(false); }
  });
  el('edit-again').addEventListener('click',()=>{ if (state.busy || state.uncertain) return; state.preview=null; show('preview-panel',false); lock(false); el('action').focus(); status('可修改内容；修改后需要重新生成预览。'); });
  /** 当前表单里选中的条目 ID；只用于提交后回读同一条目的问答线程。 */
  function selectedItemKey() { const node=el('param-item_key'); return node ? node.value : ''; }
  function receiptView(receipt) { clearPending(); state.uncertain=false; if (receipt.action==='init' && state.control) { state.control.decision.state='CONSUMED'; show('editor',false); show('activation',true); el('revoke').disabled=true; } show('result-panel',true); show('lookup',false); show('next',active()); text('result-title','变更已应用'); text('result-message',receipt.message); text('result-meta','操作 '+receipt.operationId+' · 记录 '+receipt.receiptSeq+' · '+new Date(receipt.appliedAt).toLocaleString()); show('preview-panel',false);
    // 提问提交成功后只读回读该条目的问答线程：新问题在主管实际读取前仍是「待领取」。
    if (receipt.action==='delivery.item.question') {
      const item=(state.control.catalog?.deliveryItems || []).find(candidate=>candidate.itemId===selectedItemKey());
      if(item) { state.askThread={ taskId:item.taskId, itemId:item.itemId }; void renderQuestions(); }
    }
    status(receipt.action==='init'?'初始化已完成。本次单次授权已用完，日常管理需要按实际范围重新激活。'
      :receipt.action==='delivery.item.question'?'已提交提问。它不会自动通知主管，也不改变任务状态；主管回复后可在此回读（未回复前只显示「待领取」）。'
      :'已收到本次变更的服务端记录。'); }
  el('commit').addEventListener('click',async()=>{
    if (state.busy || !state.preview || state.uncertain || !active()) return; lock(true); status('正在提交已确认的变更…');
    try { rememberPending(); receiptView((await request('commit',{prepareId:state.preview.prepareId,operationId:state.preview.operationId})).receipt); }
    catch(error) { state.uncertain=!error.confirmedRejection; show('result-panel',true); show('lookup',state.uncertain); show('next',false); text('result-title',error.confirmedRejection?'本次提交未应用':'结果待确认'); text('result-meta','决定 '+state.decisionId+' · 操作 '+state.preview.operationId);
      if(error.confirmedRejection) { clearPending(); state.preview=null; show('preview-panel',false); text('result-message',error.message+' 原输入已保留，请重新查看变更预览。'); status('本次未应用，可以修改内容并重新预览。'); }
      else { text('result-message',error.message+' 请查询同一操作的记录。页面不会自动重发变更；刷新页面后也会恢复此操作。'); status('请先查询本次结果，再决定下一步。'); }
    }
    finally { lock(false); }
  });
  async function lookupReceipt() {
    if (!state.preview || state.busy) return; lock(true);
    try { const result=await request('receipts/'+encodeURIComponent(state.preview.operationId)); if (result.receipt) receiptView(result.receipt); else { text('result-message','暂未发现本次操作的完成记录。这不等于确认没有副作用；请保留操作编号，待核对后再创建新变更。'); status('尚无完成记录；原操作不会被自动重试。'); } }
    catch(error) { status(error.message+' 原决定 '+state.decisionId+'；原操作 '+state.preview.operationId+'。'); } finally { lock(false); }
  }
  el('lookup').addEventListener('click',lookupReceipt);
  el('next').addEventListener('click',()=>{ if(state.busy || state.uncertain) return; state.preview=null; void load(); });
  el('revoke').addEventListener('click',async()=>{
    if (!state.control) return; el('revoke').disabled=true;
    try { const result=await request('revoke',{}); state.control.decision.state='REVOKED'; state.control.receiptExpiresAt=result.receiptExpiresAt; expire('管理窗口已撤销。五分钟内仍可查询已提交结果；未提交预览不能继续应用。'); }
    catch(error) { status(error.message+' 撤销尚未确认。'); el('revoke').disabled=false; }
  });
  void load();
  void renderChange();
})();
</script></body></html>`
