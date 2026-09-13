/** Final presentation layer; the existing console owns all state and behavior. */
export const CONSOLE_DESIGN_CSS = String.raw`
/* Theme tokens: territory identity and operational status are separate. */
:root, html[data-theme="parchment"] {
  color-scheme: light;
  --gate: #eee8db; --gate-deep: #f7f2e8; --patina: #fffdf7; --patina-raised: #f2eddf;
  --panel-soft: #f5f0e6; --field-bg: #fffdf7; --bamboo: #302f28; --ink: #302f28;
  --muted: #5d6053; --dim: #626658; --gold: #765b20; --jade: #346744;
  --cinnabar: #a8393d; --danger-text: #a8393d; --line: #d0ccbc; --line-strong: #737b65;
  --shadow: 0 4px 16px rgba(43, 44, 33, .06); --texture: transparent;
  --status-running: #235f91; --status-review: #73528f; --status-done: #346744;
  --status-blocked: #a8393d; --status-unknown: #835a16; --status-idle: #62675c;
  --status-running-wash: #e9f1f8; --status-review-wash: #f1ebf7; --status-done-wash: #eaf2e9;
  --status-blocked-wash: #faeaea; --status-unknown-wash: #f6eedc; --status-idle-wash: #eeefe8;
  --territory-1: #5f7b63; --territory-2: #8a6785; --territory-3: #6a7b8b;
  --territory-4: #997638; --territory-5: #447d80; --territory-6: #a26e59;
  --focus-ring: #765b20; --connector: #737b65; --nav-height: 76px; --feedback-offset: 84px;
  font-family: "Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;
}
html[data-theme="night"] {
  color-scheme: dark;
  --gate: #131d29; --gate-deep: #162231; --patina: #1e2c3d; --patina-raised: #293a4c;
  --panel-soft: #1a2736; --field-bg: #172432; --bamboo: #edf2f5; --ink: #edf2f5;
  --muted: #bdc9d5; --dim: #a8b8c9; --gold: #dbbf82; --jade: #a0d4ae;
  --cinnabar: #ffaba8; --danger-text: #ffaba8; --line: #3a4c5c; --line-strong: #8094a5;
  --shadow: 0 4px 16px rgba(0, 0, 0, .16); --focus-ring: #dbbf82; --connector: #8094a5;
}
html[data-theme="forest"] {
  color-scheme: dark;
  --gate: #13251f; --gate-deep: #172c24; --patina: #1c342c; --patina-raised: #254137;
  --panel-soft: #1a2f27; --field-bg: #172b23; --bamboo: #f0f4ea; --ink: #f0f4ea;
  --muted: #b7c8bd; --dim: #a9bcb0; --gold: #d8be7c; --jade: #a0d4ae;
  --cinnabar: #ffaba8; --danger-text: #ffaba8; --line: #3b5448; --line-strong: #859b8b;
  --shadow: 0 4px 16px rgba(0, 0, 0, .15); --focus-ring: #d8be7c; --connector: #859b8b;
}
html[data-theme="wine"] {
  color-scheme: dark;
  --gate: #281c24; --gate-deep: #2f212a; --patina: #3b2a33; --patina-raised: #4c3642;
  --panel-soft: #35262f; --field-bg: #30222b; --bamboo: #f6edf0; --ink: #f6edf0;
  --muted: #d2bdc7; --dim: #c5adb8; --gold: #e1c08b; --jade: #a0d4ae;
  --cinnabar: #ffaba8; --danger-text: #ffaba8; --line: #604853; --line-strong: #a28792;
  --shadow: 0 4px 16px rgba(0, 0, 0, .16); --focus-ring: #e1c08b; --connector: #a28792;
}
html[data-theme="night"], html[data-theme="forest"], html[data-theme="wine"] {
  --status-running: #9fcbf5; --status-review: #d1b9f5; --status-done: #a0d4ae;
  --status-blocked: #ffaba8; --status-unknown: #e6c184; --status-idle: #bec8c1;
  --status-running-wash: rgba(159, 203, 245, .08); --status-review-wash: rgba(209, 185, 245, .08);
  --status-done-wash: rgba(160, 212, 174, .08); --status-blocked-wash: rgba(255, 171, 168, .08);
  --status-unknown-wash: rgba(230, 193, 132, .08); --status-idle-wash: rgba(190, 200, 193, .08);
  --territory-1: #94b99e; --territory-2: #b99cb5; --territory-3: #9faebc;
  --territory-4: #c3ab77; --territory-5: #89b1b3; --territory-6: #c19c86;
}
/* Typography, quiet surfaces, and visible keyboard paths. */
html, html[data-theme], body, html[data-theme] body { background: var(--gate); color: var(--bamboo); }
body { font-size: 14px; line-height: 1.6; }
h1, h2, h3, .display-title { font-family: "Noto Serif SC", "Source Han Serif SC", STSong, serif; }
button, input, textarea, select { font: inherit; }
code, kbd { font-family: Consolas, "SFMono-Regular", monospace; }
a, button, summary, input, textarea, select { -webkit-tap-highlight-color: transparent; }
a:focus-visible, button:focus-visible, summary:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 3px solid var(--focus-ring); outline-offset: 3px; }
.skip-link { z-index: 100; }
[data-console-section], [data-console-page], #ledger, #management { scroll-margin-top: calc(var(--nav-height) + var(--feedback-offset)); }
.ui-icon { display: inline-block; flex: 0 0 20px; width: 20px; height: 20px; color: currentColor; vertical-align: -.2em; }
.role-insignia { width: 20px; height: 20px; color: var(--gold); vertical-align: -.2em; }
.section-kicker, .brand-kicker { font-size: 12px; line-height: 1.5; letter-spacing: .08em; }
.meta, .hint, .source-ref, .evidence-kind, .button-reason, .danger-note, .code-badge,
.session-chip, .status-glossary, .organogram-footer, .organogram-technical, .map-legend,
.attention-technical, .node-details, .theme-picker-label, .active-theme-name,
.task-composer-meta, .task-composer-heading > span, .task-territory-chip { font-size: 12px; line-height: 1.6; }
.zone-head p, .attention-heading p, .brand-note, .rail-item code, .metric span,
.health-copy small, #overview-content .metric span, .unassigned-worker-rail > header p,
.management-heading-copy small, .territory-heading p { font-size: 12px; line-height: 1.55; }
.map-heading .map-intro, .hero-copy p:not(.section-kicker), .capability-copy, .action-dock-head p,
.form-route-note, .task-summary-card p, label, .rail-item span, .data-row { font-size: 14px; line-height: 1.65; }
.ledger-page { font-size: 14px; line-height: 1.65; }
.page-heading > p:not(.section-kicker), .ledger-page .timeline-item p, .ledger-page .attention-item > p { font-size: 14px; line-height: 1.65; }
.zone, .capability-card, details.form-card, .attention-council, .task-composer-card { border: 1px solid var(--line); border-radius: 12px; background: var(--patina); box-shadow: none; }
.zone { padding: 20px; }
.zone-head { align-items: center; }
.zone-head h2, .action-dock-head h2 { font-size: 18px; }
.zone.map-page { padding: 0; border: 0; background: transparent; }
/* Compact sticky navigation; names and theme preferences remain intact. */
.realm-sidebar { position: sticky; top: 0; z-index: 50; height: auto; min-height: var(--nav-height); gap: 24px; padding: 10px clamp(20px, 4vw, 64px); background: var(--gate-deep); box-shadow: 0 1px 0 var(--line); }
.realm-brand { min-width: 0; grid-template-columns: 40px minmax(0, 1fr); gap: 10px; }
.realm-brand h1 { font-size: 20px; line-height: 1.2; }
.realm-seal { width: 40px; height: 40px; border: 0; background: transparent; }
.realm-seal-icon { width: 36px; height: 36px; }
.realm-seal > .kingdom-brand-mark { display: block; width: 100%; height: 100%; }
.brand-note { margin-top: 3px; }
.main-nav { gap: 6px; padding: 0; margin-left: auto; overflow: visible; }
.main-nav a, .main-nav .nav-item { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; padding: 10px 14px; border: 1px solid transparent; border-radius: 8px; color: var(--muted); font-size: 14px; white-space: nowrap; }
.main-nav a:hover, .main-nav a[aria-current="page"] { border: 1px solid var(--line-strong); background: var(--patina-raised); color: var(--bamboo); }
.main-nav a[aria-current="page"] { box-shadow: inset 0 -2px var(--gold); }
.theme-picker { flex: 0 0 auto; gap: 8px; padding: 3px; border-radius: 10px; background: transparent; }
.theme-picker-label { padding-left: 6px; }
.theme-swatch { width: 40px; height: 40px; min-height: 40px; }
.theme-swatch > span { box-shadow: none; }
.theme-swatch[aria-pressed="true"] { box-shadow: none; border-color: var(--gold); background: var(--patina-raised); }
.active-theme-name { padding-right: 6px; }
.console-main { width: 100%; margin: 0 auto; padding: 20px clamp(20px, 4vw, 64px) 48px; }
.map-heading, .page-heading { margin-bottom: 24px; }
.map-heading h2, .page-heading h2 { font-size: clamp(26px, 2.6vw, 36px); line-height: 1.3; }
.page-heading h2 { display: flex; align-items: center; gap: 10px; }
.map-heading h2 .ui-icon { width: 28px; height: 28px; flex-basis: 28px; color: var(--gold); }
/* Read feedback where it occurs; technical reasons remain selectable. */
.feedback-stack { position: sticky; top: calc(var(--nav-height) + 8px); z-index: 30; margin-bottom: 16px; border-radius: 8px; background: var(--gate); }
.feedback-stack .status-bar { margin-bottom: 0; }
.feedback-stack .status-technical:not([hidden]) { max-height: min(32vh, 220px); margin: 6px 0 0; overflow: auto; }
html:has(.feedback-stack .status-technical:not([hidden])) { --feedback-offset: 132px; }
html:has(.feedback-stack .status-technical[open]:not([hidden])) { --feedback-offset: 300px; }
.status-bar, .status-technical:not([hidden]) { position: relative; inset: auto; z-index: auto; width: 100%; max-width: none; margin: 0 0 16px; padding: 10px 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-soft); box-shadow: none; backdrop-filter: none; pointer-events: auto; }
.status-bar { min-height: 42px; }
.status-bar .status-text { font-size: 12px; line-height: 1.6; }
.status-text[data-level="unknown"], .status-text[data-level="stale"] { color: var(--status-unknown); }
.status-text[data-level="error"] { color: var(--status-blocked); }
.status-technical:not([hidden]) { margin-top: -10px; font-size: 12px; }
.status-technical code, .owner-management code { background: var(--field-bg); border-radius: 6px; }
/* Organization hierarchy: restrained identity rules, legible role cards. */
.realm-map { min-height: 0; }
.realm-map::after { display: none; }
.organogram-connection-layer path, .territory-connection-layer path { stroke: var(--connector); stroke-width: 1.5; opacity: 1; }
.chancellor-card { width: min(100%, 560px); grid-template-columns: 80px minmax(0, 1fr) auto; gap: 12px; margin-bottom: 0; padding: 12px 16px; }
.chancellor-card .pixel-sprite { width: 76px; height: 96px; }
.chancellor-card h3 { font-size: 19px; }
.chancellor-card p, .org-node p, .worker-stack .org-node p { font-size: 12px; line-height: 1.55; }
.chancellor-card .node-task, .node-task { font-size: 14px; line-height: 1.55; }
.organogram-branches, .organogram-branches[data-branch-count] { gap: 20px; padding-top: 32px; }
.organogram-branches[data-branch-count="0"] { padding-top: 16px; }
.territory-column, .territory-column[data-status] { padding: 16px; background: var(--panel-soft); border: 1px solid var(--line); border-top: 3px solid var(--territory-color); border-radius: 12px; box-shadow: none; }
.territory-heading { padding-bottom: 10px; border-color: var(--line); }
.territory-heading h3 { font-size: 18px; line-height: 1.4; }
.territory-heading h3::before { width: 8px; height: 8px; border-radius: 2px; }
.territory-role-network { gap: 24px; margin-top: 12px; padding-top: 0; }
.chancellor-card, .org-node, .org-node[data-status], .task-summary-card { border: 1px solid var(--line); border-left: 3px solid var(--tone); border-radius: 10px; background: var(--patina); box-shadow: none; }
.org-node[data-stage-evidence="indeterminate"] { background: var(--patina); border-left-color: var(--status-unknown); }
.org-node[data-stage-evidence="unavailable"] { opacity: 1; }
.org-node[data-role="supervisor"] { grid-template-columns: 68px minmax(0, 1fr); min-height: 108px; padding: 12px; }
.org-node[data-role="supervisor"] .pixel-sprite { width: 68px; height: 88px; }
.worker-stack .org-node, .org-node[data-role="worker"] { grid-template-columns: 56px minmax(0, 1fr); min-height: 96px; padding: 10px 12px; }
.org-node[data-role="worker"] .pixel-sprite { width: 56px; height: 74px; }
.org-node h4, .worker-stack .org-node h4 { font: 700 15px/1.5 "Noto Sans SC", "Microsoft YaHei UI", sans-serif; }
.org-node[data-stage-evidence="unbound"], .org-node[data-stage-evidence="absent"] { grid-template-columns: minmax(0, 1fr); }
.org-node .node-details p, .org-node .node-details code { font-size: 12px; }
.node-details { border-top-color: var(--line); }
.organogram-footer { margin-top: 16px; gap: 12px 20px; }
.unassigned-worker-rail { padding: 12px; box-shadow: none; }
/* SVG masks are decorative; adjacent text remains the semantic label. */
[data-status-icon="!"] { --status-symbol: var(--icon-error); }
[data-status-icon="?"] { --status-symbol: var(--icon-unknown); }
[data-status-icon="◆"] { --status-symbol: var(--icon-review); }
[data-status-icon="▶"] { --status-symbol: var(--icon-run); }
[data-status-icon="✓"] { --status-symbol: var(--icon-accept); }
[data-status-icon="○"] { --status-symbol: var(--icon-idle); }
.status-pill::before, .task-link .task-status::before, .territory-alert[data-status]::before { content: ""; display: inline-block; flex: 0 0 14px; width: 14px; height: 14px; margin: 0; border-radius: 0; color: inherit; background: currentColor; mask: var(--status-symbol, var(--icon-unknown)) center / contain no-repeat; vertical-align: -.15em; }
.status-pill, .task-link .task-status { display: inline-flex; align-items: center; gap: 5px; color: var(--tone, var(--status-unknown)); font-size: 12px; line-height: 1.5; }
.status-pill { padding: 3px 7px; border-color: var(--line); background: var(--tone-wash, var(--status-unknown-wash)); }
.territory-alert, .territory-alert[data-status] { min-height: 32px; margin: 10px 0; padding: 6px 8px; border-color: var(--line); background: var(--patina); color: var(--alert-tone); font-size: 12px; line-height: 1.6; }
.territory-alert span::before { display: none; }
.org-node h4::before, .chancellor-card .section-kicker::before { content: ""; display: inline-block; width: 16px; height: 16px; margin-right: 6px; background: var(--gold); mask: var(--role-symbol) center / contain no-repeat; vertical-align: -.17em; }
.org-node[data-role="supervisor"] { --role-symbol: var(--icon-supervisor); }
.org-node[data-role="worker"] { --role-symbol: var(--icon-worker); }
.chancellor-card { --role-symbol: var(--icon-chancellor); }
.empty, .org-empty { display: flex; align-items: center; gap: 12px; min-height: 48px; margin: 0; padding: 12px; border: 1px dashed var(--line-strong); border-radius: 10px; background: var(--panel-soft); color: var(--muted); font-size: 14px; line-height: 1.65; overflow-wrap: anywhere; }
.empty::before, .org-empty::before { content: ""; flex: 0 0 32px; width: 32px; height: 28px; background: var(--muted); mask: var(--empty-illustration-bg) center / contain no-repeat; }
#territory-map-list > .empty { min-height: 132px; justify-content: center; }
#territory-map-list > .empty::before { flex-basis: 80px; width: 80px; height: 68px; }
.metric-grid > .empty { grid-column: 1 / -1; }
.metric-grid > .empty::before { display: none; }
/* Forms, ledger evidence, and the five-stage governance explanation. */
input, textarea, select { min-height: 44px; padding: 10px 12px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--field-bg); }
input::placeholder, textarea::placeholder { color: var(--dim); opacity: 1; }
.primary, .secondary, .refresh { min-height: 40px; border-radius: 8px; font-size: 14px; }
.primary { color: var(--bamboo); border-color: var(--line-strong); background: var(--patina-raised); }
.primary:hover:not(:disabled) { border-color: var(--gold); background: var(--patina-raised); }
.primary.danger { color: var(--status-blocked); border-color: var(--status-blocked); background: var(--status-blocked-wash); }
button:disabled, .primary:disabled { opacity: 1; color: var(--dim); border-color: var(--line); background: var(--panel-soft); cursor: not-allowed; }
.task-composer-shell { border-radius: 10px; box-shadow: none; }
.task-composer-shell input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
.task-composer-card { padding: 20px; }
details.form-card { padding: 0 16px 14px; }
details.form-card summary { min-height: 48px; font-size: 14px; }
.form-grid { gap: 14px; }
.button-reason { display: block; max-width: 72ch; margin-top: 4px; }
.task-link { padding: 12px; border: 1px solid var(--line); border-left: 3px solid var(--tone); background: var(--patina); }
.task-link strong { font-size: 14px; line-height: 1.55; }
.task-link:hover, .task-link[aria-current="page"] { background: var(--patina-raised); box-shadow: none; border-color: var(--tone); }
.data-row, .timeline-item, .attention-item { padding: 12px; border-radius: 8px; background: var(--panel-soft); }
.attention-item, .attention-item[data-severity] { --tone: var(--status-unknown); --tone-wash: var(--status-unknown-wash); border-left-color: var(--tone); }
.attention-item:has(> .status-pill[data-status-icon="!"]) { --tone: var(--status-blocked); --tone-wash: var(--status-blocked-wash); }
.attention-item:has(> .status-pill[data-status-icon="◆"]) { --tone: var(--status-review); --tone-wash: var(--status-review-wash); }
.attention-item:has(> .status-pill[data-status-icon="▶"]) { --tone: var(--status-running); --tone-wash: var(--status-running-wash); }
.attention-item:has(> .status-pill[data-status-icon="✓"]) { --tone: var(--status-done); --tone-wash: var(--status-done-wash); }
.attention-item:has(> .status-pill[data-status-icon="○"]) { --tone: var(--status-idle); --tone-wash: var(--status-idle-wash); }
.attention-item > .status-pill { border-color: var(--tone); }
.rail-item { padding: 12px; }
.evidence-rail { gap: 8px; background: transparent; }
.evidence-kind { color: var(--muted); background: var(--patina-raised); border-radius: 4px; }
.developer-nav { gap: 8px; margin-block: 16px; }
.developer-nav a { display: inline-flex; align-items: center; min-height: 40px; padding: 6px 12px; border: 1px solid var(--line); border-radius: 8px; font-size: 14px; }
.developer-nav a[aria-current="page"] { border-color: var(--gold); color: var(--bamboo); background: var(--patina-raised); }
.task-technical > summary, .health-copy strong { font-size: 14px; }
#overview-content .metric strong { font-size: 18px; }
.control-stack > #refresh-button { min-height: 40px; font-size: 14px; }
.governance-flow { margin: 16px 0; padding: 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel-soft); }
.governance-flow > figcaption { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin-bottom: 14px; }
.governance-flow > figcaption strong { color: var(--bamboo); font-size: 14px; }
.governance-flow > figcaption span { color: var(--muted); font-size: 12px; }
.flow-stages { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 20px; margin: 0; padding: 0; list-style: none; }
.flow-step { position: relative; min-width: 0; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--patina); }
.flow-step:not(:last-child)::after { content: ""; position: absolute; top: 26px; right: -19px; width: 18px; height: 18px; background: var(--muted); mask: var(--icon-next) center / contain no-repeat; }
.flow-step .ui-icon { display: block; margin-bottom: 8px; color: var(--gold); }
.flow-step strong { display: block; font-size: 14px; }
.flow-step span, .flow-step p, .flow-step small { display: block; margin-top: 4px; color: var(--muted); font-size: 12px; line-height: 1.55; }
.flow-branch { margin: 12px 0 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
/* Responsive layouts keep readable text and the existing graph geometry. */
@media (max-width: 1200px) {
  .theme-picker-label, .active-theme-name { display: none; }
  .realm-sidebar { gap: 16px; }
  .kingdom-status { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 900px) {
  .realm-sidebar { flex-wrap: wrap; gap: 8px 16px; }
  .realm-brand { flex: 1 1 auto; }
  .main-nav { order: 3; width: 100%; margin: 0; justify-content: center; }
  .main-nav a { flex: 1 1 0; }
  .theme-picker { margin-left: auto; }
  :root, html[data-theme] { --nav-height: 124px; }
  .flow-stages { gap: 20px; }
  .flow-step { padding: 10px; }
  .flow-step:not(:last-child)::after { right: -19px; width: 18px; }
}
@media (max-width: 760px) {
  .realm-sidebar { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; padding: 8px 14px; gap: 6px 8px; }
  .realm-brand { grid-template-columns: 32px minmax(0, 1fr); gap: 8px; }
  .realm-seal, .realm-seal-icon { width: 32px; height: 32px; }
  .realm-brand h1 { font-size: 16px; }
  .brand-note { font-size: 12px; }
  .main-nav { grid-column: 1 / -1; gap: 4px; }
  .main-nav a, .main-nav .nav-item { min-height: 44px; padding: 8px 6px; gap: 6px; font-size: 14px; }
  .main-nav .ui-icon { width: 18px; height: 18px; flex-basis: 18px; }
  .theme-picker { width: auto; order: initial; margin: 0; padding: 2px; border-radius: 10px; }
  .theme-swatch { width: 40px; height: 40px; }
  .console-main { width: 100%; padding: 16px 14px 32px; }
  .organogram-branches, .organogram-branches[data-branch-count] { grid-template-columns: minmax(0, 1fr); padding: 28px 0 0; gap: 16px; }
  .organogram-branches[data-branch-count="0"] { padding-top: 16px; }
  .chancellor-card { grid-template-columns: 66px minmax(0, 1fr); padding: 12px; margin-bottom: 0; }
  .chancellor-card .pixel-sprite { width: 62px; height: 80px; }
  .territory-column, .territory-column[data-status] { padding: 14px; }
  .organogram-footer { grid-template-columns: minmax(0, 1fr); }
  .flow-stages { grid-template-columns: minmax(0, 1fr); gap: 20px; }
  .flow-step { padding: 12px 12px 12px 44px; }
  .flow-step .ui-icon { position: absolute; top: 14px; left: 12px; }
  .flow-step:not(:last-child)::after { top: auto; bottom: -19px; left: 16px; right: auto; width: 18px; height: 18px; transform: rotate(90deg); }
  .empty, .org-empty { padding: 12px; }
  .empty::before, .org-empty::before { flex-basis: 40px; width: 40px; }
}
@media (max-width: 480px) {
  .brand-note { display: none; }
  .realm-brand h1 { max-width: 8em; font-size: 15px; line-height: 1.35; white-space: normal; overflow-wrap: normal; word-break: normal; }
  .territory-role-network > .worker-stack, .unassigned-worker-rail .worker-stack { grid-template-columns: minmax(0, 1fr); }
  .task-composer-card, .governance-flow { padding: 14px; }
  .task-composer-shell { display: flex; flex-wrap: wrap; }
  .task-composer-shell input { flex-basis: 100%; }
  .task-territory-chip { max-width: calc(100% - 90px); }
  .task-composer-submit { margin-left: auto; }
  .status-bar .status-text, .button-reason { font-size: 12px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; animation: none !important; transition: none !important; }
}
`
