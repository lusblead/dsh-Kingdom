/**
 * dsh-kingdom — 本地 GUI 连接通道（Phase 3，P0-4）。
 *
 * 浏览器 GUI **不能**直接读本地 `kingdom.db`，所以由插件在本机开一个
 * 只监听 `127.0.0.1` 的小型 HTTP 服务，把结构化 Snapshot / Task Detail /
 * 事件增量暴露出去，并转发写命令。
 *
 * Beta 采用**轮询**（建议 1–2s 拉一次 `/api/snapshot`，或用 `revision` 先探再拉），
 * 不做完整实时推送。`revision` 与事件 `seq` 让轮询也能拿到确定的顺序语义。
 *
 * ## 安全姿态（本地开发工具，非生产服务）
 *
 * - **显式激活**：`guiPort=0` 不会预启动固定端口；只有 direct `/kingdom gui`
 *   才会按需绑定一个实际回环端口并创建短期 control session。
 * - 只绑定 `127.0.0.1`，不监听外部网卡。
 * - 写命令要求自定义头 `X-Kingdom-Client`：自定义头会强制浏览器发预检，
 *   从而挡掉简单表单式 CSRF（恶意页面无法向本机端口静默提交命令）。
 * - 可选 `guiToken`：设置后所有请求需带 `Authorization: Bearer <token>`。
 * - 鉴权诚实度由 snapshot 的 `auth.trustLevel` 如实声明，GUI 必须显示。
 */
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { CommandResultView, SnapshotView, TaskDetailView } from './contract.js'
import { GUI_SCHEMA_VERSION } from './contract.js'
import type { EventView } from './contract.js'
import { CONSOLE_APP_HTML, guiCharacterAssetLocations, isGuiCharacterAssetFile, type GuiCharacterAssetFile } from './console-app.js'
import {
  DuplicateJsonKeyError,
  GUI_COMMAND_PAYLOAD_FIELDS,
  GUI_FORBIDDEN_PAYLOAD_FIELDS,
  GUI_OWNER_ONLY_HTTP_COMMANDS,
  GUI_SESSION_COMMANDS,
  GuiControlBroker,
  GuiControlExecutionContext,
  GuiControlFailure,
  type GuiControlInspectResult,
  type GuiControlReadContext,
  GuiControlRequestMeta,
  type GuiSessionCommand,
  parseStrictJsonObject,
} from './control-contract.js'

export interface GuiServerHandlers {
  snapshot(readContext?: GuiControlReadContext): SnapshotView
  taskDetail(taskId: string, readContext?: GuiControlReadContext): TaskDetailView | null
  eventsSince(afterSeq: number, limit: number): { revision: number; events: EventView[] }
  command(
    name: string,
    payload: Record<string, unknown>,
    control?: GuiControlExecutionContext,
  ): Promise<CommandResultView>
}

export interface GuiServerAddress {
  host: string
  port: number
  origin: string
}

export interface GuiServerOptions {
  port: number
  host?: string
  token?: string
  allowOrigins?: string[]
  control?: GuiControlBroker
  onListening?(address: GuiServerAddress): void
  onUnavailable?(error: Error): void
  logger?: { info(message: string): void; warn(message: string): void }
}

/** 写命令必须带的自定义头（存在即可，值不校验）。 */
const CLIENT_HEADER = 'x-kingdom-client'
const CSRF_HEADER = 'x-kingdom-csrf'
const REQUEST_ID_HEADER = 'x-kingdom-request-id'
const CONTROL_COOKIE = 'dsh_kingdom_control'
const FORBIDDEN_AUTHORITY_FIELDS = new Set<string>(GUI_FORBIDDEN_PAYLOAD_FIELDS)

const SESSION_COMMANDS = new Set<string>(GUI_SESSION_COMMANDS)
const OWNER_ONLY_HTTP_COMMANDS = new Set<string>(GUI_OWNER_ONLY_HTTP_COMMANDS)

function corsOrigin(req: IncomingMessage, allow: string[], localOrigin: string | null): string | null {
  const origin = req.headers.origin
  if (typeof origin !== 'string') return null
  if (localOrigin !== null && origin === localOrigin) return origin
  // `*` is retained as a compatibility config value, not as permission to
  // reflect an arbitrary web Origin into a loopback response.
  if (!allow.includes('*') && allow.includes(origin)) return origin
  return null
}

function applyCors(req: IncomingMessage, res: ServerResponse, allow: string[], localOrigin: string | null): void {
  const origin = corsOrigin(req, allow, localOrigin)
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers',
    `Content-Type, Authorization, ${CLIENT_HEADER}, ${CSRF_HEADER}, ${REQUEST_ID_HEADER}`)
  res.setHeader('Access-Control-Max-Age', '600')
}

function requestMeta(req: IncomingMessage): GuiControlRequestMeta {
  const single = (value: string | string[] | undefined): string | null =>
    typeof value === 'string' ? value : Array.isArray(value) ? value[0] ?? null : null
  return {
    host: single(req.headers.host),
    origin: single(req.headers.origin),
    remoteAddress: req.socket.remoteAddress ?? null,
    fetchSite: single(req.headers['sec-fetch-site']),
  }
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie
  if (typeof header !== 'string') return null
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0 || part.slice(0, index).trim() !== name) continue
    try { return decodeURIComponent(part.slice(index + 1).trim()) }
    catch { return null }
  }
  return null
}

function controlStatus(code: GuiControlFailure['code']): number {
  switch (code) {
    case 'CONTROL_SESSION_REQUIRED': return 401
    case 'CONTROL_SESSION_EXPIRED':
    case 'CONTROL_TICKET_INVALID': return 410
    case 'CONTROL_BUSY':
    case 'CONTROL_REPLAY_DENIED': return 409
    default: return 403
  }
}

function sendControlFailure(res: ServerResponse, failure: GuiControlFailure): void {
  sendError(res, controlStatus(failure.code), failure.code, failure.message)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function sendSvg(res: ServerResponse, body: string): void {
  res.writeHead(200, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

function requestedCharacterAsset(path: string): GuiCharacterAssetFile | null {
  const prefix = '/gui-assets/characters/'
  if (!path.startsWith(prefix)) return null
  const encodedName = path.slice(prefix.length)
  if (!encodedName || encodedName.includes('/')) return null
  try {
    const name = decodeURIComponent(encodedName)
    return isGuiCharacterAssetFile(name) ? name : null
  } catch {
    return null
  }
}

function readCharacterAsset(fileName: Parameters<typeof guiCharacterAssetLocations>[0]): string | null {
  for (const location of guiCharacterAssetLocations(fileName)) {
    try {
      return readFileSync(location, 'utf8')
    } catch {
      // The compiled package and the source tree have different relative
      // locations; try the next allowlisted location before failing closed.
    }
  }
  return null
}

function sendError(res: ServerResponse, status: number, errorCode: string, message: string): void {
  sendJson(res, status, { ok: false, errorCode, message })
}

async function readJsonBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > limitBytes) throw new Error('request body too large')
    chunks.push(buf)
  }
  if (size === 0) return {}
  return parseStrictJsonObject(Buffer.concat(chunks).toString('utf8'))
}

function boundedFieldName(value: string): string {
  return value.length <= 80 ? value : `${value.slice(0, 80)}…`
}

function nestedForbiddenAuthorityField(value: unknown): string | null {
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (typeof current !== 'object' || current === null) continue
    if (Array.isArray(current)) {
      pending.push(...current)
      continue
    }
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (FORBIDDEN_AUTHORITY_FIELDS.has(key)) return key
      pending.push(child)
    }
  }
  return null
}

function validateCommandPayload(
  command: GuiSessionCommand,
  payload: Record<string, unknown>,
): string | null {
  const forbidden = nestedForbiddenAuthorityField(payload)
  if (forbidden) {
    return `HTTP payload 不得包含 Authority/identity 字段 "${boundedFieldName(forbidden)}"。`
  }
  const allowed = new Set(GUI_COMMAND_PAYLOAD_FIELDS[command])
  const unknown = Object.keys(payload).find(key => !allowed.has(key))
  if (unknown) return `命令 "${command}" 不接受字段 "${boundedFieldName(unknown)}"。`
  const nonString = Object.entries(payload).find(([, value]) => typeof value !== 'string')
  if (nonString) return `命令 "${command}" 的字段 "${boundedFieldName(nonString[0])}" 必须是 string。`
  return null
}

/** v0.9 S2：四区只读 Console；数据只来自现有 GET projection seam。 */
export const READONLY_CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>dsh-Kingdom Read-only Projection Console</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; background: #111827; color: #e5e7eb; }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 0; background: #111827; }
    main { width: min(100% - 24px, 1180px); margin: 0 auto; padding: 16px 0 28px; }
    h1, h2, p { margin: 0; }
    h1 { font-size: 1.35rem; margin-bottom: 12px; }
    h2 { font-size: 1rem; margin-bottom: 8px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    section { min-width: 0; background: #1f2937; border: 1px solid #374151; border-radius: 10px; padding: 12px; overflow-wrap: anywhere; }
    .wide { grid-column: 1 / -1; }
    .muted { color: #9ca3af; font-size: .88rem; }
    .row { border-top: 1px solid #374151; padding: 8px 0; }
    .row:first-child { border-top: 0; padding-top: 0; }
    .tag { display: inline-block; color: #bfdbfe; font-size: .76rem; margin-right: 6px; }
    .attention { color: #fbbf24; }
    .critical { color: #fca5a5; }
    @media (max-width: 640px) {
      main { width: min(100% - 16px, 1180px); padding-top: 10px; }
      .grid { grid-template-columns: minmax(0, 1fr); }
      .wide { grid-column: auto; }
      section { padding: 10px; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Read-only Projection Console</h1>
    <p class="muted">Owner-only actions: DIRECT_SLASH_REQUIRED</p>
    <p id="status" class="muted">正在读取只读 Projection…</p>
    <div class="grid">
      <section id="overview" aria-labelledby="overview-title"><h2 id="overview-title">状态总览</h2><div class="content"></div></section>
      <section id="task-detail" aria-labelledby="task-title"><h2 id="task-title">Task Detail</h2><div class="content"></div></section>
      <section id="timeline" class="wide" aria-labelledby="timeline-title"><h2 id="timeline-title">Timeline</h2><div class="content"></div></section>
      <section id="attention" class="wide" aria-labelledby="attention-title"><h2 id="attention-title">Attention</h2><div class="content"></div></section>
    </div>
  </main>
  <script>
    (() => {
      const text = value => String(value ?? 'UNKNOWN');
      const line = (parent, label, value, className = '') => {
        const item = document.createElement('div');
        item.className = 'row ' + className;
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = label;
        const body = document.createElement('span');
        body.textContent = text(value);
        item.append(tag, body);
        parent.append(item);
      };
      const clear = id => {
        const content = document.querySelector('#' + id + ' .content');
        content.replaceChildren();
        return content;
      };
      const renderSnapshot = (snapshot, detail) => {
        const projection = snapshot.projection || {};
        const overview = projection.overview?.data || {};
        const overviewBox = clear('overview');
        line(overviewBox, 'Health', overview.health, overview.health === 'CRITICAL' ? 'critical' : '');
        line(overviewBox, 'Tasks', overview.taskCount);
        line(overviewBox, 'Active Execution', overview.activeExecutionCount);
        for (const action of overview.ownerActions || []) {
          line(overviewBox, 'Owner action', text(action.action) + ' — ' + text(action.disabledReason?.code), 'attention');
        }
        const taskBox = clear('task-detail');
        const task = snapshot.tasks?.[0];
        if (!task) line(taskBox, 'State', 'UNKNOWN — no task detail available');
        else {
          line(taskBox, 'Task status', text(task.status) + ' [GOVERNANCE_FACT]');
          line(taskBox, 'Claim', text(task.latestClaim?.claimedOutcome) + ' [WORKER_CLAIM]');
          line(taskBox, 'Execution', text(task.latestExecution?.state) + ' [RUNTIME_OBSERVATION]');
          line(taskBox, 'Actions', (detail?.projection?.data?.actionAvailability || []).map(a => text(a.action) + ': ' + text(a.disabledReason?.code || 'EXECUTABLE')).join('; ') || 'NONE');
        }
        const timelineBox = clear('timeline');
        for (const item of projection.timeline?.data || []) line(timelineBox, text(item.kind), item.summary);
        if (!(projection.timeline?.data || []).length) line(timelineBox, 'Timeline', 'UNKNOWN / NOT_RUN');
        const attentionBox = clear('attention');
        for (const item of projection.attention?.data || []) line(attentionBox, text(item.severity), text(item.reason?.code) + ' — ' + text(item.summary), item.severity.toLowerCase());
        if (!(projection.attention?.data || []).length) line(attentionBox, 'Attention', 'NONE');
      };
      const load = async () => {
        try {
          const response = await fetch('/api/snapshot', { headers: { Accept: 'application/json' } });
          if (!response.ok) throw new Error('snapshot HTTP ' + response.status);
          const snapshot = await response.json();
          let detail = null;
          const task = snapshot.tasks?.[0];
          if (task?.taskId) {
            const detailResponse = await fetch('/api/tasks/' + encodeURIComponent(task.taskId), { headers: { Accept: 'application/json' } });
            if (detailResponse.ok) detail = await detailResponse.json();
          }
          renderSnapshot(snapshot, detail);
          document.querySelector('#status').textContent = '只读 Projection 已加载；Console 不执行写动作。';
        } catch (error) {
          document.querySelector('#status').textContent = 'UNKNOWN — ' + text(error?.message || error);
        }
      };
      void load();
    })();
  </script>
</body>
</html>`

/**
 * 启动本地 GUI 通道。
 * @returns 关闭函数（挂到 ctx.effect，插件卸载/热重载时自动收回端口）。
 */
export function startGuiServer(handlers: GuiServerHandlers, options: GuiServerOptions): () => void {
  const host = options.host ?? '127.0.0.1'
  const allow = options.allowOrigins ?? ['*']
  const token = options.token?.trim() || null

  const server: Server = createServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      options.logger?.warn('dsh-kingdom GUI request failed with bounded INTERNAL_ERROR')
      if (!res.headersSent) {
        sendError(res, 500, 'INTERNAL_ERROR', 'local GUI request failed')
      } else {
        res.end()
      }
    })
  })

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${host}`)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const address = server.address()
    const localOrigin = typeof address === 'object' && address !== null
      ? `http://${host}:${address.port}`
      : null
    applyCors(req, res, allow, localOrigin)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const meta = requestMeta(req)
    const taskMatch = /^\/api\/tasks\/([^/]+)$/u.exec(path)
    const stateBearingRead = req.method === 'GET'
      && (path === '/api/snapshot' || path === '/api/events' || taskMatch !== null)
    const ticketRedemption = req.method === 'GET'
      && path === '/console'
      && url.searchParams.has('ticket')
      && options.control !== undefined
    const controlCookie = cookieValue(req, CONTROL_COOKIE)
    const bearerAuthenticated = token !== null
      && req.headers.authorization === `Bearer ${token}`
    let inspectedControl: GuiControlInspectResult | null | undefined
    const inspectControl = (): GuiControlInspectResult | null => {
      if (inspectedControl !== undefined) return inspectedControl
      inspectedControl = options.control?.inspect(controlCookie, meta) ?? null
      return inspectedControl
    }

    let readContext: GuiControlReadContext | undefined
    if (stateBearingRead) {
      if (localOrigin === null || (meta.origin !== null && meta.origin !== localOrigin)) {
        sendControlFailure(res, {
          ok: false,
          code: 'CONTROL_ORIGIN_DENIED',
          message: 'State-bearing GET 仅允许当前本地 GUI Origin 或受控的无 Origin 客户端。',
        })
        return
      }
      const inspected = inspectControl()
      if (inspected?.ok) {
        readContext = inspected.readContext
      } else if (options.control) {
        // An explicit invalid/expired cookie is never silently downgraded to
        // bearer or anonymous access.
        if (controlCookie !== null || inspected?.code !== 'CONTROL_SESSION_REQUIRED') {
          sendControlFailure(res, inspected!)
          return
        }
        if (!bearerAuthenticated) {
          sendControlFailure(res, {
            ok: false,
            code: 'CONTROL_SESSION_REQUIRED',
            message: 'State-bearing GET 需要有效 control cookie 或已配置且匹配的 bearer。',
          })
          return
        }
      } else {
        const expectedHost = new URL(localOrigin).host
        const exactRemote = meta.remoteAddress === '127.0.0.1'
          || meta.remoteAddress === '::ffff:127.0.0.1'
        if (meta.host !== expectedHost || !exactRemote) {
          sendControlFailure(res, {
            ok: false,
            code: 'CONTROL_ORIGIN_DENIED',
            message: 'State-bearing GET 仅允许精确的本地回环 Host 与连接地址。',
          })
          return
        }
        if (controlCookie !== null) {
          sendControlFailure(res, {
            ok: false,
            code: 'CONTROL_SESSION_REQUIRED',
            message: '当前 server 没有可验证该 control cookie 的 broker。',
          })
          return
        }
        if (!bearerAuthenticated) {
          sendControlFailure(res, {
            ok: false,
            code: 'CONTROL_SESSION_REQUIRED',
            message: 'State-bearing GET 需要有效 control cookie 或已配置且匹配的 bearer。',
          })
          return
        }
      }
    }

    const activeControlSession = controlCookie !== null && inspectControl()?.ok === true
    if (token !== null
      && !bearerAuthenticated
      && !ticketRedemption
      && !activeControlSession) {
      sendError(res, 401, 'UNAUTHORIZED', 'missing or invalid bearer token')
      return
    }

    if (req.method === 'GET' && path.startsWith('/gui-assets/characters/')) {
      const assetName = requestedCharacterAsset(path)
      if (assetName === null) {
        sendError(res, 404, 'GUI_ASSET_NOT_FOUND', 'unknown or disallowed GUI character asset')
        return
      }
      const asset = readCharacterAsset(assetName)
      if (asset === null) {
        sendError(res, 404, 'GUI_ASSET_UNAVAILABLE', 'allowlisted GUI character asset is unavailable')
        return
      }
      sendSvg(res, asset)
      return
    }

    if (req.method === 'GET' && path === '/console') {
      const ticket = url.searchParams.get('ticket')
      if (ticket !== null && options.control) {
        const redeemed = options.control.redeem(ticket, meta)
        if (!redeemed.ok) {
          sendControlFailure(res, redeemed)
          return
        }
        res.writeHead(303, {
          Location: '/console',
          'Set-Cookie': `${CONTROL_COOKIE}=${encodeURIComponent(redeemed.cookieValue)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`,
          'Cache-Control': 'no-store',
        })
        res.end()
        return
      }
      sendHtml(res, 200, CONSOLE_APP_HTML)
      return
    }

    if (req.method === 'GET' && (path === '/' || path === '/api/health')) {
      sendJson(res, 200, { ok: true, service: 'dsh-kingdom', schemaVersion: GUI_SCHEMA_VERSION })
      return
    }

    if (req.method === 'GET' && path === '/api/snapshot') {
      sendJson(res, 200, handlers.snapshot(readContext))
      return
    }

    if (req.method === 'GET' && path === '/api/control') {
      if (!options.control) {
        sendError(res, 401, 'CONTROL_SESSION_REQUIRED',
          '请先在本地 DSH 会话直接执行 /kingdom gui 激活控制会话。')
        return
      }
      const inspected = inspectControl()!
      if (!inspected.ok) {
        sendControlFailure(res, inspected)
        return
      }
      sendJson(res, 200, inspected.view)
      return
    }

    if (req.method === 'GET' && path === '/api/events') {
      const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10)
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10)
      sendJson(res, 200, handlers.eventsSince(
        Number.isFinite(since) && since > 0 ? since : 0,
        Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 200,
      ))
      return
    }

    if (req.method === 'GET' && taskMatch) {
      const detail = handlers.taskDetail(decodeURIComponent(taskMatch[1]!), readContext)
      if (!detail) {
        sendError(res, 404, 'TASK_NOT_FOUND', 'task not found in the current kingdom')
        return
      }
      sendJson(res, 200, detail)
      return
    }

    const commandMatch = /^\/api\/commands\/([a-z.-]+)$/u.exec(path)
    if (req.method === 'POST' && commandMatch) {
      const name = commandMatch[1]!
      if (OWNER_ONLY_HTTP_COMMANDS.has(name)) {
        sendError(res, 403, 'DIRECT_SLASH_REQUIRED',
          `Owner-only action "${name}" 只能由人类 Owner 直接执行 /kingdom Slash；GUI/HTTP 始终 executable=false。`)
        return
      }
      if (!SESSION_COMMANDS.has(name)) {
        sendError(res, 404, 'UNKNOWN_COMMAND', `unknown command "${name}"`)
        return
      }
      const command = name as GuiSessionCommand
      // 自定义头强制预检，挡掉简单表单式 CSRF。
      if (req.headers[CLIENT_HEADER] === undefined) {
        sendError(res, 400, 'MISSING_CLIENT_HEADER',
          `write commands require the ${CLIENT_HEADER} header`)
        return
      }
      if (!options.control) {
        sendError(res, 401, 'CONTROL_SESSION_REQUIRED',
          'GUI/HTTP 本身没有 Authority；请先直接执行 /kingdom gui。')
        return
      }
      const admitted = options.control.authorize(
        controlCookie,
        typeof req.headers[CSRF_HEADER] === 'string' ? req.headers[CSRF_HEADER] : null,
        typeof req.headers[REQUEST_ID_HEADER] === 'string' ? req.headers[REQUEST_ID_HEADER] : null,
        meta,
      )
      if (!admitted.ok) {
        sendControlFailure(res, admitted)
        return
      }
      let payload: Record<string, unknown>
      try {
        payload = await readJsonBody(req)
      } catch (error: unknown) {
        admitted.finish()
        const message = error instanceof DuplicateJsonKeyError
          ? `JSON body 不得包含重复字段 "${boundedFieldName(error.key)}"。`
          : error instanceof Error && error.message === 'request body too large'
            ? 'request body exceeds the bounded size limit'
            : 'request body must be one strict JSON object'
        sendError(res, 400, 'INVALID_BODY', message)
        return
      }
      const invalidPayload = validateCommandPayload(command, payload)
      if (invalidPayload) {
        admitted.finish()
        sendError(res, 400, 'INVALID_BODY', invalidPayload)
        return
      }
      if (command === 'control.revoke') {
        admitted.finish()
        options.control.revoke(controlCookie)
        res.setHeader('Set-Cookie', `${CONTROL_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`)
        sendJson(res, 200, { ok: true, message: '本地 GUI Control Session 已撤销。' })
        return
      }
      try {
        const result = await handlers.command(command, payload, admitted.context)
        sendJson(res, result.ok ? 200 : 409, result)
      } finally {
        admitted.finish()
      }
      return
    }

    sendError(res, 404, 'NOT_FOUND', `no route for ${req.method ?? 'GET'} ${path}`)
  }

  let retries = 0
  let retryTimer: NodeJS.Timeout | null = null
  let disposed = false

  /**
   * 端口占用时有界重试。
   *
   * HMR 的常见时序是「新实例先起、旧实例后卸」，此时端口还在旧实例手里。
   * 不重试的话，新实例的 GUI 通道会在整个生命周期里保持死掉——
   * 开发时表现为「改一次代码 GUI 就再也连不上，必须整体重启 DSH」。
   * 重试是有界的（最多 ~3 秒），避免真正的端口冲突变成无限循环。
   */
  const RETRY_DELAY_MS = 300
  const MAX_RETRIES = 10

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE' && !disposed && retries < MAX_RETRIES) {
      retries++
      retryTimer = setTimeout(() => {
        retryTimer = null
        if (!disposed) server.listen(options.port, host)
      }, RETRY_DELAY_MS)
      // 重试期间保持安静；只有最终放弃才告警，避免刷屏。
      if (retries === MAX_RETRIES) {
        options.logger?.warn(
          `dsh-kingdom GUI 通道：端口 ${options.port} 持续被占用，`
          + `已重试 ${MAX_RETRIES} 次仍失败，本次加载不提供 GUI 通道（请换 guiPort 或检查残留进程）。`,
        )
      }
      return
    }
    if (!disposed) {
      options.logger?.warn(`dsh-kingdom GUI 通道启动失败（${error.message}）`)
      options.onUnavailable?.(error)
    }
  })

  server.listen(options.port, host, () => {
    retries = 0
    const address = server.address()
    const actualPort = typeof address === 'object' && address !== null ? address.port : options.port
    options.onListening?.({ host, port: actualPort, origin: `http://${host}:${actualPort}` })
    options.logger?.info(
      `dsh-kingdom GUI 通道已监听 http://${host}:${actualPort}`
      + `（snapshot / tasks / events / commands${token ? '，已启用 bearer token' : ''}）`,
    )
  })

  return () => {
    disposed = true
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    server.close()
    server.closeAllConnections?.()
    options.control?.dispose()
  }
}
