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
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);line-height:1.55}main{width:min(100% - 40px,1020px);margin:auto;padding:26px 0 64px}header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:28px}a{color:var(--accent);text-underline-offset:4px}h1{font-size:clamp(1.7rem,4vw,2.5rem);font-weight:650;letter-spacing:.02em;margin:0 0 8px}h2{font-size:1.12rem;margin:0 0 12px}p{margin:8px 0}.eyebrow{letter-spacing:.15em;font-size:.76rem;color:var(--accent)}.muted,small{color:var(--muted)}.panel{padding:24px;border:1px solid var(--line);background:var(--panel);border-radius:14px;margin:18px 0;overflow-wrap:anywhere}.bar{display:flex;gap:16px;justify-content:space-between;align-items:start}.stack{display:grid;gap:15px}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.field{display:grid;gap:7px;min-width:0}.field.wide{grid-column:1/-1}label{font-weight:600}input,select,textarea,button{font:inherit}input,select,textarea{width:100%;min-width:0;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:10px 12px}textarea{min-height:90px;resize:vertical}button{border:1px solid var(--line);padding:10px 18px;border-radius:8px;cursor:pointer;background:var(--soft);color:var(--ink)}button.primary{background:var(--button);color:var(--button-ink);border-color:var(--button);font-weight:700}button:disabled{opacity:.5;cursor:default}:focus-visible{outline:3px solid var(--accent);outline-offset:3px}fieldset{border:0;margin:0;padding:0;min-width:0}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}.status{padding:12px 0;min-height:30px;white-space:pre-wrap}.tag{display:inline-block;border:1px solid var(--line);border-radius:20px;padding:3px 10px;margin:4px 7px 0 0;font-size:.84rem}.changes{margin:0}.change{border-top:1px solid var(--line);padding:12px 0}.change dt{font-weight:700}.change dd{margin:6px 0 0;white-space:pre-wrap}.before{color:var(--muted)}.after{color:var(--accent)}code{display:block;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--bg);padding:14px;border-radius:8px;font-size:.85rem}.ceiling-row{display:grid;grid-template-columns:minmax(0,1fr) 100px auto;gap:10px;align-items:end}.receipt-meta{font-size:.8rem;color:var(--muted);overflow-wrap:anywhere}[hidden]{display:none!important}#theme{width:auto}.title-note{max-width:70ch}.scope-summary{white-space:pre-line}.danger{border-color:var(--accent)}
@media(max-width:600px){main{width:calc(100% - 24px);padding-top:16px}header{align-items:start}.panel{padding:17px}.fields{grid-template-columns:minmax(0,1fr)}.bar{display:grid;gap:12px}.bar button{justify-self:start}.ceiling-row{grid-template-columns:minmax(0,1fr) 92px}.ceiling-row button{grid-column:1/-1;justify-self:start}.actions button{flex:1 1 auto}h1{font-size:1.85rem}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
</style></head><body><main>
<header><a href="/console#settings">← 返回工作台设置</a><label class="field" for="theme"><span class="muted">外观</span><select id="theme"><option value="forest">森林墨绿</option><option value="parchment">羊皮纸</option><option value="night">夜蓝星图</option><option value="wine">酒红议会</option></select></label></header>
<div class="eyebrow">KINGDOM / OWNER</div><h1>王国管理</h1><p class="title-note muted">在已授权范围内管理领地、角色与执行配置。每次变更先查看影响，再确认应用。</p>
<p id="status" class="status" role="status" aria-live="polite">正在检查管理窗口…</p>
<section id="activation" class="panel" hidden><h2>从本地打开管理窗口</h2><p>当前没有可用的管理授权。请由人类在 DSH 的直接命令入口打开一次管理窗口，再使用返回的短期链接。</p><p class="muted">普通工作台会话不会自动获得管理权；每个窗口都需要明确操作范围，并在十分钟内到期。</p><details><summary>首次初始化的本地命令</summary><p>只用于尚未建立王国的空库；初始化后需要按实际范围重新激活。</p><code>/kingdom owner.gui {"kingdomId":null,"actions":["init"],"scope":{"kingdomWide":false,"territoryIds":[],"bindingIds":[],"roleTypes":[],"targetSessionIds":[],"workspaceRoots":[]},"ttlMs":600000}</code></details></section>
<section id="window" class="panel" hidden><div class="bar"><div><h2>本次管理范围</h2><p id="scope" class="scope-summary"></p><p id="expiry" class="muted"></p></div><button id="revoke" class="danger" type="button">立即撤销管理窗口</button></div></section>
<section id="editor" class="panel" hidden><h2>准备变更</h2><form id="operation-form"><fieldset id="edit-fields"><div class="field"><label for="action">要进行的操作</label><select id="action" required></select></div><p id="action-note" class="muted"></p><div id="fields" class="fields"></div><div class="actions"><button id="prepare" class="primary" type="submit">查看变更预览</button></div></fieldset></form></section>
<section id="preview-panel" class="panel" hidden><h2>确认本次变更</h2><p id="preview-summary"></p><dl id="changes" class="changes"></dl><p id="preview-expiry" class="muted"></p><div class="actions"><button id="commit" class="primary" type="button">确认应用此变更</button><button id="edit-again" type="button">返回修改</button></div></section>
<section id="result-panel" class="panel" hidden><h2 id="result-title">操作结果</h2><p id="result-message"></p><p id="result-meta" class="receipt-meta"></p><div class="actions"><button id="lookup" type="button" hidden>查询本次操作结果</button><button id="next" type="button" hidden>准备下一项变更</button></div></section>
</main><script nonce="__OWNER_NONCE__">
(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const state = { control: null, decisionId: null, preview: null, busy: false, uncertain: false };
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
  const names = { init:'初始化王国', 'territory.create':'创建领地', 'territory.update':'修改领地名称与说明', 'territory.supervisor':'任命领地主管', 'role.bind':'登记新角色', 'role.session':'调整角色会话', ceiling:'调整王国权限上限', 'execution-profile':'设置执行模型', 'budget.policy':'调整软预算政策', 'plan.adopt':'采纳一份协作计划' };
  const roleNames = { CHANCELLOR:'宰相', SUPERVISOR:'主管', WORKER:'执行者' };
  const notes = { init:'初始化只创建王国与人类所有者，完成后本次授权即结束。', 'territory.create':'选择已存在且在授权根目录内的工作目录；这里不会创建目录。', 'territory.update':'保留工作目录和已有会话关系。', 'territory.supervisor':'仍有未决执行或工作占用时，变更将被拒绝。', 'role.bind':'主管与宰相需要真实运行会话；执行者会话由正常执行流程建立。', 'role.session':'仅调整主管或宰相；不会迁移执行者的持久会话。', ceiling:'此映射将替换王国上限。请完整列出本次需要配置的能力；它不会改变已在途的运行限制。', 'execution-profile':'保存的是请求配置；只有后续真实运行才能确认实际使用的模型。', 'budget.policy':'软预算按 Token 管理新增执行，不是费用硬上限。每次启动的预留是估计；关闭不重置统计起点，调整不会终止在途工作或释放恢复中的占用。' };
  notes['plan.adopt']='一次采纳完整计划及其固定版本。采纳只创建子任务；主管仍须合法分配、启动和审查，主执行者仍须实际整合。不会自动授权、派发或接受产物。';
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
  }
  function payload() {
    const action=el('action').value; const parameters={};
    for (const field of el('fields').querySelectorAll('[name]')) if (!field.disabled && field.value.trim() !== '') parameters[field.name]=field.value.trim();
    if (action==='execution-profile') { const binding_id=parameters.binding_id; if (!parameters.model) throw new Error('请填写明确的模型名称。'); const profile={...(parameters.provider?{provider:parameters.provider}:{}),model:parameters.model}; return {action,parameters:{binding_id,profile}}; }
    if (action==='ceiling') { const ceiling=Object.create(null); for (const row of el('ceiling-rows').children) { const name=row.querySelector('input').value.trim(); if (!name || Object.hasOwn(ceiling,name)) throw new Error('能力名称不能为空或重复。'); ceiling[name]=row.querySelector('select').value==='true'; } if (!Object.keys(ceiling).length) throw new Error('请至少配置一项能力。'); return {action,parameters:{ceiling}}; }
    if (action==='budget.policy') { const numeric={}; for (const key of ['limit_tokens','reserve_tokens','warning_percent']) { const value=Number(parameters[key]); if (!Number.isSafeInteger(value) || value<1 || key==='warning_percent' && value>100) throw new Error('预算额度、预留和阈值必须是范围内的正整数。'); numeric[key]=value; } if (numeric.reserve_tokens>numeric.limit_tokens) throw new Error('每次预留不能超过周期额度。'); return {action,parameters:{enabled:parameters.enabled==='true',...numeric,unknown_policy:parameters.unknown_policy}}; }
    if (action==='plan.adopt') { const plan=(state.control.catalog?.plans || []).find(item=>item.planId===parameters.plan_id && item.state==='PROPOSED'); const version=Number(parameters.version); if(!plan || !Number.isSafeInteger(version) || version<1 || version!==plan.version || parameters.digest!==plan.digest) throw new Error('请选择当前范围内的完整计划；版本或内容指纹已变化时请重新读取。'); return {action,parameters:{plan_id:plan.planId,version:plan.version,digest:plan.digest}}; }
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
  function lock(value) { state.busy=value; el('edit-fields').disabled=value || !!state.preview || state.uncertain || !active(); el('commit').disabled=value || !state.preview || !active() || state.uncertain; el('edit-again').disabled=value || state.uncertain; el('next').disabled=value || state.uncertain; }
  function scopeText(view) {
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
      options(el('action'),control.decision.actions.filter(action=>Object.hasOwn(names,action)).map(id=>({id,label:names[id]}))); renderFields(); lock(false); status('管理窗口已就绪。填写变更后先查看预览。'); tick();
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
  function receiptView(receipt) { clearPending(); state.uncertain=false; if (receipt.action==='init' && state.control) { state.control.decision.state='CONSUMED'; show('editor',false); show('activation',true); el('revoke').disabled=true; } show('result-panel',true); show('lookup',false); show('next',active()); text('result-title','变更已应用'); text('result-message',receipt.message); text('result-meta','操作 '+receipt.operationId+' · 记录 '+receipt.receiptSeq+' · '+new Date(receipt.appliedAt).toLocaleString()); show('preview-panel',false); status(receipt.action==='init'?'初始化已完成。本次单次授权已用完，日常管理需要按实际范围重新激活。':'已收到本次变更的服务端记录。'); }
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
})();
</script></body></html>`
