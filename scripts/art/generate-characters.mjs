/** Authoring source for the twelve self-contained Kingdom character SVGs.
 * Run from any directory with Node; writes only the explicit existing asset names.
 * Original Owner roles/palette are retained; 2026-09-08 shape and motion revision.
 */
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root=new URL('../../src/gui/assets/characters/',import.meta.url);
const ink='#28352f',skin='#efc69a',skinShade='#cf9970',gold='#d4b570',paper='#f2e4bb';
const path=(d,fill,extra='')=>`<path d="${d}" fill="${fill}" ${extra}/>`;
const line=(d,color=ink,width=2)=>`<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}"/>`;
const group=(name,content)=>`<g class="${name}" data-part="${name}">${content}</g>`;
const roles={
  chancellor:{label:'宰相',color:'#79648f',light:'#ab94b9',shade:'#514664',offset:'-.6s',identity:'高冠、银须、长袍和规划卷轴',action:'展开卷轴，提笔指示，回看全局'},
  supervisor:{label:'主管',color:'#578272',light:'#8eb6a0',shade:'#375b50',offset:'-1.8s',identity:'低帽、短披肩、领章和审查板',action:'稳住审查板，落笔核对，抬头确认'},
  knight:{label:'执行者',color:'#658ba3',light:'#a8c2cf',shade:'#415e73',offset:'-2.6s',identity:'护额、分片护甲、短披风和工具',action:'重心就位，抬臂检视工具，回收待续'},
};
const aliases={idle:['idle','ready','available'],working:['working','running','executing','reviewing'],thinking:['thinking','confused','planning','waiting-input'],sleeping:['sleeping','paused','resting'],offline:['offline','stopped','absent']};
const stateSelector=state=>`svg:is(${aliases[state].map(x=>`[data-state="${x}"]`).join(',')})`;

function face(role){
  const c=roles[role];
  const base=path('M27 24 Q27 16 40 16 Q53 16 53 25 L52 35 Q50 44 40 45 Q30 44 28 35Z',skin)+path('M48 25 L52 24 L51 36 Q48 42 41 43 L40 39 Q47 36 48 25Z',skinShade,'stroke="none"')+path('M26 28 Q21 26 24 33 L28 34 M53 28 Q58 26 56 33 L52 34',skin);
  const eyes=group('eyes-open',line('M32 29v2 M45 29v2',ink,2.6))+group('eyes-closed',line('M30.5 30q3 2.5 6 0 M43 30q3 2.5 6 0',ink,1.7));
  const brows=line('M30 25.5l6-.5 M43 25l5 .7',role==='chancellor'?'#e6ddc8':ink,2.3);
  const nose=path('M40 30l-2 5h4',skinShade,'stroke="none"');
  let hair;
  if(role==='chancellor') hair=path('M28 34 L32 35 L34 40 L40 42 L46 40 L49 34 L52 34 L51 43 L46 49 L40 52 L34 49 L29 43Z','#e8dfc9')+path('M31 35q5-3 9 1q5-4 9-1l-2 5l-7-1l-6 1Z','#f5ecd6')+line('M38 42h4','#746f61',1.5);
  else if(role==='supervisor')hair=path('M30 36q6-4 10 0q5-4 10 0l-3 3l-7-1l-6 1Z','#694732','stroke="none"')+line('M37 41h6','#8d5e42',1.5);
  else hair=line('M36 38q4 2 7-1','#76533a',1.7);
  let hat;
  if(role==='chancellor')hat=path('M25 23 L26 10 L31 7 L48 7 L54 12 L55 23Z',c.shade)+path('M29 9h18l4 5v7H29Z',c.color,'stroke="none"')+path('M24 21h32v6H24Z',gold)+path('M37 11h6v9h-6Z',c.light,'stroke="none"')+group('hat-follow',line('M53 13q7 1 8 7',gold,2)+path('M60 19h3v7h-3Z',gold,'stroke="none"'));
  else if(role==='supervisor')hat=group('hat-follow',path('M46 14Q55 4 62 8Q59 16 49 18Z','#b18a72')+line('M49 16l10-6',gold,1.5))+path('M24 24L27 14Q40 10 53 16L54 24Z',c.shade)+path('M27 18h25v5H27Z',c.color,'stroke="none"')+path('M22 23h35v5H22Z',gold);
  else hat=group('hat-follow',path('M40 14Q43 5 53 8L48 16Z',c.color))+path('M24 27V23Q25 10 40 10Q55 11 56 24v9l-7-3V24L40 21L31 24v10l-7-1Z',c.light)+path('M40 11v10l9 3v6l7 3V23Q53 11 40 11Z','#7d9bab','stroke="none"')+path('M22 25h35v5H22Z',c.shade)+path('M37 11h5v14h-5Z',gold,'stroke="none"');
  return group('head',base+eyes+brows+nose+hair+hat);
}

function torso(role){
  const c=roles[role];
  const boots=group('feet',path('M27 91h12v12H23v-6l4-2Z','#655446')+path('M43 91h12l2 7v5H41v-8Z','#655446')+line('M24 100h14 M43 100h13','#a28b65',2));
  const cape=group('cape',path(role==='chancellor'?'M24 47Q39 43 56 47L64 93L52 98L40 94L23 99L17 92Z':'M24 46Q39 41 56 47L62 81L53 86L40 81L21 87L18 76Z',c.shade)+path('M22 52l-3 31l5 7l5-42Z',c.light,'stroke="none" opacity=".45"'));
  let body;
  if(role==='chancellor')body=path('M27 47L39 44L52 47L55 71L59 95H22L26 71Z',c.color)+path('M31 48l8 7l8-8l-2 45H34Z',c.shade,'stroke="none"')+path('M29 48l3 1l3 44h-4Z',gold,'stroke="none"')+path('M47 49l3-1l-2 45h-4Z',gold,'stroke="none"')+path('M23 91h35v4H23Z',gold)+path('M27 70h26v6H27Z','#635440')+path('M37 69h9v8h-9Z',gold);
  else if(role==='supervisor')body=path('M27 47h26l3 38l-8 8H30l-6-8Z',c.color)+path('M25 47l14-3l16 4l4 10l-19-4l-19 5Z',c.light)+path('M35 51l5 4l5-4l-1 14h-8Z',paper)+path('M27 76h28v6H27Z','#705c42')+path('M37 75h9v8h-9Z',gold)+path('M28 83h10v12H25Z',c.shade)+path('M43 83h12l2 12H44Z',c.shade)+path('M38 57h5v6h-5Z',gold);
  else body=path('M27 46l13-3l14 4l2 34l-10 7H33l-9-7Z',c.shade)+path('M30 48l10 4l12-4l1 23l-13 5l-13-5Z',c.color)+path('M31 49l9 3l10-3v6l-10 3l-10-3Z',c.light,'stroke="none"')+path('M26 75h29v7H26Z','#6c5642')+path('M37 74h8v9h-8Z',gold)+path('M28 83l10 1l-1 13H25Z',c.light)+path('M44 84l11-1l3 14H44Z',c.light)+line('M28 90h9 M45 90h9',c.shade,2);
  return {boots,cape,body:group('torso',body)};
}

function arms(role){
  const c=roles[role];
  const farUpper=path('M27 49Q21 47 18 56L18 65l9 1l5-9Z',c.color)+path('M18 61h10v6H18Z',c.light);
  let held;
  if(role==='chancellor')held=path('M10 59L29 60L31 80L12 79Z',paper)+path('M9 58h6v6H9Z',gold)+path('M11 76h6v7h-6Z',gold)+line('M16 65l9 1 M17 70l8 1 M18 75h6','#92774b',1.8);
  else if(role==='supervisor')held=path('M10 55L31 57L32 81L11 80Z','#6d5741')+path('M13 59l15 1l1 16l-15-1Z',paper)+path('M18 54h9v6h-9Z',gold)+line('M17 65l2 2l4-4 M17 71h7','#788a66',1.7);
  else held=path('M18 65l8-1l3 18l-10 1Z',c.shade)+path('M18 80h11v5H18Z',gold);
  const far=group('arm-far',farUpper+group('forearm-far',held+path('M16 65q-4 2-2 6l7 1l1-5Z',skin)));
  let near;
  if(role==='chancellor')near=path('M53 48q7-1 10 7l-3 9l-9-4Z',c.color)+group('forearm-near',path('M60 59l4 8l-7 7l-6-5Z',c.color)+path('M52 66l7-2l4 5l-7 5Z',gold)+path('M55 64q2-4 6-2l3 5l-4 4l-5-2Z',skin)+group('tool',line('M61 65l8-18','#755940',2.4)+path('M65 55q0-9 8-13q1 9-8 13Z',paper)));
  else if(role==='supervisor')near=path('M53 48q7 0 10 10l-5 9l-9-7Z',c.color)+group('forearm-near',path('M59 61l-12 4l-1 8l14-3l4-5Z',c.color)+path('M48 64l3 7l-5 3l-4-8Z',gold)+path('M43 64q-4 0-5 4l4 4l6-1l-1-6Z',skin)+group('tool',line('M43 66L29 62','#493f33',2)+path('M27 61l5-1l-2 4Z',gold,'stroke="none"')));
  else near=path('M53 47q10 0 12 12l-7 6l-9-10Z',c.light)+group('forearm-near',path('M59 60l8 7l-3 11l-9-5Z',c.color)+path('M57 68l9 2l-1 7l-10-3Z',c.light)+group('tool',path('M62 72l4-22l4 1l-4 22Z','#95724b')+path('M61 47l13 2l-1 9l-13-2Z',c.light)+path('M69 48l5 1l-1 9l-5-1Z',c.shade,'stroke="none"'))+path('M61 68q5-2 7 2l-1 5l-6 1l-3-4Z',skin));
  return {far,near:group('arm-near',near)};
}

function motion(role){
  const c=roles[role],s=stateSelector;
  return `
/* SVG-wide coordinates make every joint pivot explicit and stable. */
svg{overflow:hidden;--phase:${c.offset}}
.weight,.breath,.head,.cape,.arm-far,.forearm-far,.arm-near,.forearm-near,.hat-follow{transform-box:view-box}
.weight{transform-origin:40px 99px;animation:weight 8s cubic-bezier(.42,0,.58,1) infinite}
.breath{transform-origin:40px 87px;animation:breathe 4s cubic-bezier(.37,0,.63,1) var(--phase) infinite}
.head{transform-origin:40px 44px;animation:idle-look 8s cubic-bezier(.4,0,.4,1) infinite}
.cape{transform-origin:40px 48px;animation:cloth 8s cubic-bezier(.4,0,.5,1) infinite}
.arm-far{transform-origin:27px 51px}.forearm-far{transform-origin:22px 64px}
.arm-near{transform-origin:54px 51px}.forearm-near{transform-origin:58px 63px}
.hat-follow{transform-origin:49px 18px;animation:hat-settle 8s ease-in-out infinite}
.eyes-open{transform-box:fill-box;transform-origin:center;animation:blink 8s linear var(--phase) infinite}
.eyes-closed{display:none}
${s('idle')} .arm-near{animation:idle-shoulder 8s cubic-bezier(.42,0,.24,1) infinite}
${s('idle')} .forearm-near{animation:idle-hand 8s cubic-bezier(.42,0,.24,1) infinite}
${s('working')} .weight{animation-name:work-weight}
${s('working')} .head{animation-name:work-look}
${s('working')} .arm-far{animation:steady-page 8s ease-in-out infinite}
${s('working')} .arm-near{animation:${role}-shoulder 8s cubic-bezier(.42,0,.24,1) infinite}
${s('working')} .forearm-near{animation:${role}-gesture 8s cubic-bezier(.42,0,.24,1) infinite}
${s('thinking')} .head{transform:rotate(-5deg);animation:consider 8s ease-in-out infinite}
${s('thinking')} .forearm-near{transform:rotate(-18deg);animation:thinking-hand 8s ease-in-out infinite}
${s('thinking')} .arm-near{transform:rotate(-6deg);animation:thinking-shoulder 8s ease-in-out infinite}
${s('sleeping')} .head{transform:rotate(9deg) translateY(1px);animation:rest-head 8s ease-in-out infinite}
${s('sleeping')} .arm-near{transform:rotate(9deg)}
${s('sleeping')} .arm-far{transform:rotate(-5deg)}
${s('sleeping')} .forearm-near{transform:rotate(8deg)}
${s('sleeping')} .eyes-open{display:none}
${s('sleeping')} .eyes-closed{display:inline}
${s('sleeping')} .weight{animation:none;transform:rotate(.4deg)}
${s('sleeping')} .breath{animation-duration:4s}
${s('offline')} .figure,${s('offline')} .ground-shadow{display:none}
@keyframes breathe{0%,100%{transform:scale(1,1)}42%{transform:scale(1.01,1.028)}68%{transform:scale(1.005,1.013)}}
@keyframes weight{0%,100%{transform:rotate(0deg)}20%,35%{transform:rotate(-6deg)}64%,78%{transform:rotate(5deg)}}
@keyframes work-weight{0%,7%,100%{transform:rotate(0deg)}14%{transform:rotate(3deg)}28%,39%{transform:rotate(-8deg)}51%{transform:rotate(-3deg)}63%,72%{transform:rotate(4deg)}83%,91%{transform:rotate(-5deg)}}
@keyframes cloth{0%,100%{transform:rotate(0deg)}16%{transform:rotate(-4deg)}33%,43%{transform:rotate(9deg)}53%{transform:rotate(3deg)}71%,83%{transform:rotate(-7deg)}93%{transform:rotate(3deg)}}
@keyframes hat-settle{0%,100%{transform:rotate(0deg)}29%{transform:rotate(-12deg)}43%{transform:rotate(5deg)}57%,79%{transform:rotate(0deg)}88%{transform:rotate(-6deg)}}
@keyframes idle-look{0%,10%,100%{transform:rotate(0deg) translateY(0)}23%,37%{transform:rotate(-16deg) translateY(3px)}49%,66%{transform:rotate(0deg) translateY(0)}80%,90%{transform:rotate(12deg) translateY(2px)}}
@keyframes idle-shoulder{0%,12%,100%{transform:rotate(0deg)}25%,37%{transform:rotate(-28deg)}49%,68%{transform:rotate(0deg)}80%,89%{transform:rotate(12deg)}}
@keyframes idle-hand{0%,12%,100%{transform:rotate(0deg)}25%,37%{transform:rotate(14deg)}49%,68%{transform:rotate(0deg)}80%,89%{transform:rotate(-18deg)}}
@keyframes blink{0%,27%,30%,72%,75%,100%{transform:scaleY(1)}28.5%,73.5%{transform:scaleY(.12)}}
@keyframes work-look{0%,8%,100%{transform:rotate(0deg) translateY(0)}27%,40%{transform:rotate(${role === 'knight' ? 20 : -20}deg) translateY(5px)}54%,68%{transform:rotate(6deg) translateY(1px)}82%,91%{transform:rotate(-13deg) translateY(3px)}}
@keyframes steady-page{0%,100%{transform:rotate(0deg)}16%{transform:rotate(6deg)}28%,43%{transform:rotate(-8deg)}56%,73%{transform:rotate(0deg)}83%,91%{transform:rotate(-4deg)}}
@keyframes chancellor-shoulder{0%,7%,100%{transform:rotate(0deg)}14%{transform:rotate(10deg)}28%,38%{transform:rotate(-58deg)}48%{transform:rotate(-38deg)}60%,71%{transform:rotate(0deg)}83%,90%{transform:rotate(-34deg)}}
@keyframes chancellor-gesture{0%,7%,100%{transform:rotate(0deg)}14%{transform:rotate(-12deg)}28%,38%{transform:rotate(28deg)}48%{transform:rotate(18deg)}60%,71%{transform:rotate(0deg)}83%,90%{transform:rotate(14deg)}}
@keyframes supervisor-shoulder{0%,8%,100%{transform:rotate(0deg)}16%{transform:rotate(-12deg)}27%,41%{transform:rotate(22deg)}54%,67%{transform:rotate(-30deg)}82%,91%{transform:rotate(16deg)}}
@keyframes supervisor-gesture{0%,8%,100%{transform:rotate(0deg)}17%{transform:rotate(15deg)}26%{transform:rotate(-32deg)}32%{transform:rotate(8deg)}40%{transform:rotate(-26deg)}54%,67%{transform:rotate(34deg)}81%{transform:rotate(-24deg)}90%{transform:rotate(-4deg)}}
@keyframes knight-shoulder{0%,7%,100%{transform:rotate(0deg)}14%{transform:rotate(12deg)}28%,38%{transform:rotate(-70deg)}47%{transform:rotate(-44deg)}59%,69%{transform:rotate(0deg)}82%,90%{transform:rotate(-42deg)}}
@keyframes knight-gesture{0%,7%,100%{transform:rotate(0deg)}14%{transform:rotate(-14deg)}28%,38%{transform:rotate(36deg)}47%{transform:rotate(18deg)}59%,69%{transform:rotate(0deg)}82%,90%{transform:rotate(22deg)}}
@keyframes consider{0%,100%{transform:rotate(-5deg) translateY(0)}20%,38%{transform:rotate(-23deg) translateY(7px)}58%,77%{transform:rotate(10deg) translateY(2px)}}
@keyframes thinking-shoulder{0%,100%{transform:rotate(-6deg)}22%,40%{transform:rotate(-32deg)}60%,78%{transform:rotate(8deg)}}
@keyframes thinking-hand{0%,100%{transform:rotate(-18deg)}22%,40%{transform:rotate(-40deg)}60%,78%{transform:rotate(10deg)}}
@keyframes rest-head{0%,100%{transform:rotate(9deg) translateY(1px)}40%,49%{transform:rotate(23deg) translateY(5px)}65%,77%{transform:rotate(5deg) translateY(.5px)}}
/* The console supplies page-clock phase to preserve motion across node reconstruction. */
.weight,.head,.cape,.hat-follow,.arm-far,.arm-near,.forearm-near{animation-delay:var(--kingdom-motion-offset,0s)}
.breath,.eyes-open{animation-delay:calc(var(--kingdom-motion-offset,0s) + var(--phase))}
/* Keep the state-specific resting pose. No scripts, SMIL, filters or external assets. */
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;
}

for(const [role,c] of Object.entries(roles)){
  const body=torso(role),hands=arms(role);
  const art=group('figure',body.boots+group('weight',body.cape+group('breath',hands.far+body.body+face(role)+hands.near)));
  for(const state of ['idle','working','thinking','sleeping']){
    const file=(role==='knight'?'knight-redraw-r1':role)+'-'+state+'.svg';
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 112" width="80" height="112" preserveAspectRatio="xMidYMid meet" role="img" focusable="false" aria-labelledby="character-title character-desc" data-role="${role}" data-state="${state}">
<title id="character-title">Kingdom ${c.label} · ${state}</title>
<desc id="character-desc">${c.identity}。${c.action}。克制的连续关节动作，支持减少动态效果。</desc>
<metadata>{"visualVersion":"kingdom-motion-r4-gui","role":"${role}","state":"${state}","cycleSeconds":8,"viewBox":[0,0,80,112],"origin":"Owner character redesign authorized 2026-09-08"}</metadata>
<style><![CDATA[${motion(role)}]]></style>
<g stroke="${ink}" stroke-width="2.1" stroke-linejoin="round" stroke-linecap="round">
<ellipse class="ground-shadow" cx="40" cy="104" rx="23" ry="3" fill="#07140e" opacity=".2" stroke="none"/>
${art}
</g></svg>\n`;
    writeFileSync(new URL(file,root),svg);
    console.log(fileURLToPath(new URL(file,root)));
  }
}
