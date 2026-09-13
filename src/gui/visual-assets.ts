/**
 * Static, inline GUI artwork. No caller-supplied strings enter these templates.
 * Lucide paths are pinned to a537cb6eb323b885f4c60baf3cec1a995982d167;
 * complete source and license notices are in THIRD_PARTY_NOTICES.md.
 */
const ICON_OPEN = '<svg class="ui-icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';
const ICON_CLOSE = '</svg>';

/** Decorative icons must be paired with visible text or an accessible control name. */
export const GUI_ICONS = Object.freeze({
  map: ICON_OPEN + '<path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z" /><path d="M15 5.764v15" /><path d="M9 3.236v15" />' + ICON_CLOSE,
  management: ICON_OPEN + '<path d="M10 5H3" /><path d="M12 19H3" /><path d="M14 3v4" /><path d="M16 17v4" /><path d="M21 12h-9" /><path d="M21 19h-5" /><path d="M21 5h-7" /><path d="M8 10v4" /><path d="M8 12H3" />' + ICON_CLOSE,
  ledger: ICON_OPEN + '<path d="M12 5v16" /><path d="M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z" />' + ICON_CLOSE,
  refresh: ICON_OPEN + '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />' + ICON_CLOSE,
  chancellor: ICON_OPEN + '<path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z" /><path d="M5 21h14" />' + ICON_CLOSE,
  supervisor: ICON_OPEN + '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" />' + ICON_CLOSE,
  worker: ICON_OPEN + '<path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path d="M9 13v2" />' + ICON_CLOSE,
  plan: ICON_OPEN + '<rect width="8" height="4" x="8" y="2" rx="1" ry="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="M12 11h4" /><path d="M12 16h4" /><path d="M8 11h.01" /><path d="M8 16h.01" />' + ICON_CLOSE,
  assign: ICON_OPEN + '<path d="M15 6a9 9 0 0 0-9 9V3" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" />' + ICON_CLOSE,
  next: ICON_OPEN + '<path d="M5 12h14" /><path d="m12 5 7 7-7 7" />' + ICON_CLOSE,
  run: ICON_OPEN + '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />' + ICON_CLOSE,
  review: ICON_OPEN + '<rect width="8" height="4" x="8" y="2" rx="1" ry="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="m9 14 2 2 4-4" />' + ICON_CLOSE,
  accept: ICON_OPEN + '<circle cx="12" cy="12" r="10" /><path d="m16 9-5.5 5.5L8 12" />' + ICON_CLOSE,
  lock: ICON_OPEN + '<circle cx="12" cy="16" r="1" /><rect x="3" y="10" width="18" height="12" rx="2" /><path d="M7 10V7a5 5 0 0 1 10 0v3" />' + ICON_CLOSE,
  error: ICON_OPEN + '<circle cx="12" cy="12" r="10" /><line x1="12" x2="12" y1="8" y2="12" /><line x1="12" x2="12.01" y1="16" y2="16" />' + ICON_CLOSE,
  idle: ICON_OPEN + '<circle cx="12" cy="12" r="10" />' + ICON_CLOSE,
  unknown: ICON_OPEN + '<circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" />' + ICON_CLOSE,
  empty: ICON_OPEN + '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />' + ICON_CLOSE,
});

/** Original gate-and-organization brand mark; the adjacent wordmark supplies its name. */
export const KINGDOM_BRAND_SVG = `<svg class="kingdom-brand-mark" xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path d="M9 31V12h6v5h6v-5h6v5h6v-5h6v19H9Z" />
  <path d="M19 31v-7a5 5 0 0 1 10 0v7M24 31v5M12 36h24M12 36v3M36 36v3" />
  <circle cx="12" cy="41" r="2" /><circle cx="24" cy="38" r="2" /><circle cx="36" cy="41" r="2" />
</svg>`;

/** Original decorative empty state. It deliberately contains no role or binding claims. */
export const EMPTY_STATE_SVG = `<svg class="empty-state-art" xmlns="http://www.w3.org/2000/svg" width="240" height="128" viewBox="0 0 240 128" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path d="M84 67V27h12v9h16v-9h16v9h16v-9h12v40H84Z" />
  <path d="M109 67V53a11 11 0 0 1 22 0v14M76 67h88" />
  <path d="M120 74v10M62 84h116M62 84v12M120 84v12M178 84v12" stroke-dasharray="4 5" opacity=".55" />
  <rect x="43" y="96" width="38" height="20" rx="6" stroke-dasharray="4 5" opacity=".65" />
  <rect x="101" y="96" width="38" height="20" rx="6" stroke-dasharray="4 5" opacity=".65" />
  <rect x="159" y="96" width="38" height="20" rx="6" stroke-dasharray="4 5" opacity=".65" />
</svg>`;

/** Static governance guidance, never a projection of current task progress. */
export const GOVERNANCE_FLOW_HTML = `<figure class="governance-flow">
  <figcaption><strong>常用任务流转</strong><span>示意流程，不表示实时进度。</span></figcaption>
  <ol class="flow-stages">
    <li class="flow-step"><span class="flow-step-icon">${GUI_ICONS.plan}</span><div><strong>规划</strong><p>交给宰相统筹，明确目标与任务边界。</p></div></li>
    <li class="flow-step"><span class="flow-step-icon">${GUI_ICONS.assign}</span><div><strong>指派</strong><p>领地主管承接，指派执行者。</p></div></li>
    <li class="flow-step"><span class="flow-step-icon">${GUI_ICONS.run}</span><div><strong>执行</strong><p>执行者在获准范围内工作。</p></div></li>
    <li class="flow-step"><span class="flow-step-icon">${GUI_ICONS.review}</span><div><strong>呈报与审查</strong><p>执行者呈报结果，主管审查证据。</p></div></li>
    <li class="flow-step"><span class="flow-step-icon">${GUI_ICONS.accept}</span><div><strong>主管接受</strong><p>主管接受后，任务才记为完成（DONE）。</p></div></li>
  </ol>
  <p class="flow-branch">执行者的完成呈报不等于治理事实；平台执行结束（COMPLETED）也不等于任务完成（DONE）。审查要求返工（REWORK）时返回执行；审查判定失败（FAIL）时，任务标记为失败（FAILED）。</p>
</figure>`;
