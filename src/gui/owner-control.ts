import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { OwnerControlCapability } from '../core/owner-control.js'
import type {
  OwnerDecisionController, OwnerDecisionHandle, OwnerDecisionInput, OwnerDecisionView,
} from '../core/owner-window.js'
import { parseStrictJsonObject, type GuiControlRequestMeta } from './control-contract.js'
import { renderOwnerApp } from './owner-ui.js'

export const OWNER_CONTROL_COOKIE = 'dsh_kingdom_owner'
const MAX_BODY_BYTES = 32_768
const MAX_REQUESTS = 128
const RECEIPT_GRACE_MS = 5 * 60_000
const secret = (): string => randomBytes(32).toString('base64url')

export class OwnerTransportError extends Error {
  constructor(readonly code: string, message: string, readonly status = 403) { super(message) }
}

export interface OwnerLocalControlOptions {
  controller: OwnerDecisionController
  expectedOrigin: string | (() => string)
  now?: () => number
}

/**
 * 非授权启动定位提示（launch hint）。
 *
 * 只描述人类刚点的那一条交付，用于在新标签页里预选；它不进入
 * `OwnerDecisionInput`、不改变授权含义，也不产生任何写入。
 */
export interface OwnerLaunchHintInput {
  task?: unknown
  item?: unknown
  contentHash?: unknown
  /** 提示指向的动作：知悉（`ack`）还是提问（`ask`）。只决定兑换后预选哪个动作，不参与授权。 */
  action?: unknown
}

export interface OwnerLaunchAckHint {
  task: string
  item: string
  contentHash: string
  /** `ack` = 预选逐条知悉；`ask` = 预选交付条目提问。 */
  action: 'ack' | 'ask'
}

/** `task` 与工作台公开引用 ID 同形（`src/gui/snapshot.ts` 的 `publicReferenceId`）。 */
const HINT_TASK = /^[A-Za-z0-9_.:@-]{1,96}$/u
/** `item` 的格式由 core 唯一决定：`item:` + 32 位小写十六进制（`deliveryItemId`）。 */
const HINT_ITEM = /^item:[0-9a-f]{32}$/u
const HINT_CONTENT_HASH = /^[0-9a-f]{64}$/u

/**
 * 按格式校验定位提示。三个字段要么全部合法，要么整体不成立：不部分采用。
 *
 * `input` 是拆分后的 direct 命令参数，因此能区分「未携带」（三个字段都
 * `undefined`）与「携带了但不完整/非法」。调用方必须把后者当作输入错误在激活前
 * 拒绝，而不是丢掉提示后照常激活——否则人类会以为新标签页仍会预选该条。
 */
export function validateLaunchAckHint(input: OwnerLaunchHintInput | undefined): { ok: true; hint: OwnerLaunchAckHint | null } | { ok: false; message: string } {
  if (!input) return { ok: true, hint: null }
  const provided = (['task', 'item', 'contentHash'] as const).filter(key => input[key] !== undefined)
  if (!provided.length) {
    if (input.action !== undefined) return { ok: false, message: 'hintAction 必须与 taskHint/itemHint/contentHashHint 同时提供。' }
    return { ok: true, hint: null }
  }
  if (provided.length < 3) {
    const missing = (['task', 'item', 'contentHash'] as const).filter(key => input[key] === undefined)
    return { ok: false, message: `taskHint/itemHint/contentHashHint 必须同时提供；缺少 ${missing.map(key => key + 'Hint').join('、')}。` }
  }
  for (const key of provided) {
    if (typeof input[key] !== 'string') return { ok: false, message: `${key}Hint 必须是 string。` }
  }
  // hintAction 只决定兑换后预选哪个动作，不改变授权；默认（未携带）是知悉。
  // 显式提供的 null/非法值不被当作「未携带」，与三个定位字段同样整体拒绝。
  const action = input.action === undefined ? 'ack' : input.action
  if (action !== 'ack' && action !== 'ask') return { ok: false, message: 'hintAction 只接受 ack 或 ask。' }
  const { task, item, contentHash } = input as { task: string; item: string; contentHash: string }
  if (!HINT_TASK.test(task)) return { ok: false, message: 'taskHint 不是合法的任务引用 ID。' }
  if (!HINT_ITEM.test(item)) return { ok: false, message: 'itemHint 不是合法的条目 ID（item: 加 32 位小写十六进制）。' }
  if (!HINT_CONTENT_HASH.test(contentHash)) return { ok: false, message: 'contentHashHint 不是合法的内容版本（64 位小写十六进制）。' }
  return { ok: true, hint: { task, item, contentHash, action } }
}

/** 三者同时存在且各自合法时返回提示，否则返回 null（不部分采用）。 */
export function normalizeLaunchAckHint(input: OwnerLaunchHintInput | undefined): OwnerLaunchAckHint | null {
  const checked = validateLaunchAckHint(input)
  return checked.ok ? checked.hint : null
}

/** 兑换成功后跳转的无票据地址；只带非授权提示字段，绝不带 ticket。 */
export function launchRedirectPath(hint: OwnerLaunchAckHint | null): string {
  if (!hint) return '/owner'
  // 动作意图必须随兑换一起交还：只写 ack_* 会让「提问」入口在被复制的 direct 命令
  // 走完后丢失提问动作与目标。
  const prefix = hint.action === 'ask' ? 'ask' : 'ack'
  return `/owner?${prefix}_task=` + encodeURIComponent(hint.task)
    + `&${prefix}_item=` + encodeURIComponent(hint.item)
    + `&${prefix}_hash=` + encodeURIComponent(hint.contentHash)
}

interface Ticket { handle: OwnerDecisionHandle; expiresAt: number; hint: OwnerLaunchAckHint | null }
interface BrowserWindow {
  handle: OwnerDecisionHandle
  csrf: string
  requests: Set<string>
  abort: AbortController
  timer: NodeJS.Timeout | null
  busy: boolean
  receiptExpiresAt: number
}

/** Transport references existing direct-human decisions; it never accepts an HTTP identity. */
export class OwnerLocalControlManager {
  private readonly tickets = new Map<string, Ticket>()
  private readonly windows = new Map<string, BrowserWindow>()
  private readonly now: () => number
  private closed = false
  constructor(private readonly options: OwnerLocalControlOptions) { this.now = options.now ?? Date.now }

  private origin(): string {
    return typeof this.options.expectedOrigin === 'function' ? this.options.expectedOrigin() : this.options.expectedOrigin
  }

  checkTransport(meta: GuiControlRequestMeta, mutation = false, navigation = false): void {
    if (this.closed) throw new OwnerTransportError('OWNER_WINDOW_CLOSED', '管理通道已关闭。', 410)
    const expected = this.origin()
    let host = ''
    try {
      const url = new URL(expected)
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== expected) throw new Error()
      host = url.host
    } catch { throw new OwnerTransportError('OWNER_ORIGIN_DENIED', '管理通道尚未就绪。') }
    if (meta.host !== host || !['127.0.0.1', '::ffff:127.0.0.1'].includes(meta.remoteAddress ?? '')) {
      throw new OwnerTransportError('OWNER_ORIGIN_DENIED', '仅允许准确的本机回环地址。')
    }
    if ((mutation && meta.origin !== expected) || (!mutation && meta.origin !== null && meta.origin !== expected)) {
      throw new OwnerTransportError('OWNER_ORIGIN_DENIED', '请求来源与管理窗口不一致。')
    }
    // Same-site is insufficient: another loopback port is another origin.
    if (meta.fetchSite !== null && meta.fetchSite !== 'same-origin' && !(navigation && meta.fetchSite === 'none')) {
      throw new OwnerTransportError('OWNER_ORIGIN_DENIED', '跨站请求不能读取或使用管理窗口。')
    }
  }

  activate(capability: OwnerControlCapability, input: OwnerDecisionInput, hintInput?: OwnerLaunchHintInput): {
    launchTicket: string; launchPath: '/owner'; decisionId: string; expiresAt: string; ttlMs: number
  } {
    if (this.closed) throw new OwnerTransportError('OWNER_WINDOW_CLOSED', '管理通道已关闭。', 410)
    // 携带了却不完整/非法的定位提示在激活前整体拒绝：既不激活窗口，也不退化成
    // 「丢掉提示照常激活」，否则人类会以为新标签页仍会预选该条。
    const checked = validateLaunchAckHint(hintInput)
    if (!checked.ok) throw new OwnerTransportError('OWNER_LAUNCH_HINT_INVALID', `启动定位提示无效：${checked.message}`, 400)
    const activation = this.options.controller.activate(capability, input)
    for (const ticket of this.tickets.values()) this.options.controller.revoke(ticket.handle)
    this.tickets.clear()
    for (const window of this.windows.values()) this.invalidate(window, true)
    // Retain a bounded set of revoked references for receipt lookup, never for mutation.
    while (this.windows.size > 15) this.windows.delete(this.windows.keys().next().value!)
    const launchTicket = secret()
    const expiresAt = Math.min(this.now() + 30_000, Date.parse(activation.decision.expiresAt))
    // 提示只随一次性票据保存，兑换后立即丢弃；它不参与任何授权判断。
    this.tickets.set(launchTicket, { handle: activation.handle, expiresAt, hint: checked.hint })
    return { launchTicket, launchPath: '/owner', decisionId: activation.decision.decisionId,
      expiresAt: activation.decision.expiresAt,
      ttlMs: Math.max(0, Date.parse(activation.decision.expiresAt) - this.now()) }
  }

  redeem(ticket: string, meta: GuiControlRequestMeta): { cookie: string; maxAgeSeconds: number; redirectPath: string } {
    this.checkTransport(meta, false, true)
    const record = ticket.length <= 512 ? this.tickets.get(ticket) : undefined
    if (!record || this.now() >= record.expiresAt) {
      if (record) { this.tickets.delete(ticket); this.options.controller.revoke(record.handle) }
      throw new OwnerTransportError('OWNER_TICKET_INVALID', '启动链接已失效，请从本地直接入口重新打开。', 410)
    }
    this.tickets.delete(ticket)
    const view = this.options.controller.inspect(record.handle)
    if (!view || view.state !== 'ACTIVE') throw new OwnerTransportError('OWNER_WINDOW_EXPIRED', '管理授权已失效。', 410)
    const cookie = secret()
    const window: BrowserWindow = { handle: record.handle, csrf: secret(), requests: new Set(), abort: new AbortController(), timer: null, busy: false,
      receiptExpiresAt: Date.parse(view.expiresAt) + RECEIPT_GRACE_MS }
    const ttl = Math.max(0, Date.parse(view.expiresAt) - this.now())
    window.timer = setTimeout(() => this.invalidate(window), ttl + 1)
    window.timer.unref?.()
    this.windows.set(cookie, window)
    return { cookie, maxAgeSeconds: Math.max(1, Math.ceil((ttl + RECEIPT_GRACE_MS) / 1000)), redirectPath: launchRedirectPath(record.hint) }
  }

  private window(cookie: string | null, meta: GuiControlRequestMeta): BrowserWindow {
    this.checkTransport(meta)
    const window = cookie !== null && cookie.length <= 512 ? this.windows.get(cookie) : undefined
    if (!window) throw new OwnerTransportError('OWNER_WINDOW_REQUIRED', '请由人类从本地直接入口激活管理窗口。', 401)
    if (this.now() >= window.receiptExpiresAt) {
      this.invalidate(window)
      this.windows.delete(cookie!)
      throw new OwnerTransportError('OWNER_RECEIPT_WINDOW_EXPIRED', '结果查询宽限期已结束，请保留操作编号并重新核对。', 410)
    }
    return window
  }

  /**
   * 只读返回一条已由主管确认的改动条目详情。
   *
   * 不消耗 CSRF、不写任何事实、不产生知悉；有效性完全由 Core 的
   * `readDeliveryChange` 依据当前 ACTIVE 窗口、scope 与证据 hash 判定。
   */
  readChange(cookie: string | null, meta: GuiControlRequestMeta, params: { taskId: string; evidenceId: string; entryId: string }): unknown {
    const window = this.window(cookie, meta)
    return { ok: true, change: this.options.controller.readDeliveryChange(window.handle, params) }
  }

  /**
   * 只读返回一条已确认交付条目的问答线程。
   *
   * 不消耗 CSRF、不写任何事实、不产生知悉、也不替主管回复；有效性完全由 Core 的
   * `readDeliveryQuestions` 依据当前 ACTIVE 窗口、动作授权、scope 与精确条目判定。
   */
  readQuestions(cookie: string | null, meta: GuiControlRequestMeta, params: { taskId: string; itemId: string }): unknown {
    const window = this.window(cookie, meta)
    return { ok: true, questions: this.options.controller.readDeliveryQuestions(window.handle, params) }
  }

  async inspect(cookie: string | null, meta: GuiControlRequestMeta): Promise<unknown> {
    const window = this.window(cookie, meta)
    const decision = this.options.controller.inspect(window.handle)
    if (!decision) throw new OwnerTransportError('OWNER_WINDOW_EXPIRED', '管理授权已失效。', 410)
    if (decision.state !== 'ACTIVE') return { decision, csrfToken: null, catalog: null, receiptExpiresAt: new Date(window.receiptExpiresAt).toISOString() }
    const catalog = await this.options.controller.catalog(window.handle)
    const current = this.options.controller.inspect(window.handle)
    if (!current || current.state !== 'ACTIVE' || window.abort.signal.aborted) {
      throw new OwnerTransportError('OWNER_WINDOW_EXPIRED', '管理授权在读取期间失效。', 410)
    }
    return { decision: current, csrfToken: window.csrf, catalog, receiptExpiresAt: new Date(window.receiptExpiresAt).toISOString() }
  }

  receipt(cookie: string | null, meta: GuiControlRequestMeta, operationId: string, decisionId: string | null): unknown {
    const window = this.window(cookie, meta)
    if (!decisionId || !/^[A-Za-z0-9_-]{1,128}$/u.test(decisionId)) {
      throw new OwnerTransportError('OWNER_DECISION_REFERENCE_REQUIRED', '查询结果需要原管理决定编号。', 400)
    }
    if (this.options.controller.inspect(window.handle)?.decisionId !== decisionId) {
      throw new OwnerTransportError('OWNER_WINDOW_REPLACED',
        '管理窗口已被替换，当前凭据不能核对原窗口结果。请保留原决定与操作编号核对；不能据此判断原操作未应用，也不要重新提交。', 409)
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(operationId)) throw new OwnerTransportError('INVALID_BODY', '操作编号无效。', 400)
    const receipt = this.options.controller.receipt(window.handle, operationId)
    return receipt ? { ok: true, receipt } : { ok: true, receipt: null, status: 'NOT_RECORDED' }
  }

  async mutate(cookie: string | null, csrf: string | null, requestId: string | null,
    meta: GuiControlRequestMeta, action: 'prepare' | 'commit' | 'revoke', payload: Record<string, unknown>): Promise<unknown> {
    this.checkTransport(meta, true)
    const window = this.window(cookie, meta)
    if (!csrf || csrf !== window.csrf) throw new OwnerTransportError('OWNER_CSRF_DENIED', '管理窗口校验失效，请重新打开。')
    if (!requestId || !/^[A-Za-z0-9_-]{1,128}$/u.test(requestId)) throw new OwnerTransportError('OWNER_REQUEST_ID_REQUIRED', '请求必须有有效编号。', 400)
    if (window.abort.signal.aborted || this.options.controller.inspect(window.handle)?.state !== 'ACTIVE') {
      throw new OwnerTransportError('OWNER_WINDOW_EXPIRED', '管理授权已失效。', 410)
    }
    if (action === 'revoke') {
      if (Object.keys(payload).length) throw new OwnerTransportError('INVALID_BODY', '撤销请求不接受参数。', 400)
      // Revocation remains available while a validation is awaiting an external registry.
      this.invalidate(window, true)
      return { ok: true, decision: this.options.controller.inspect(window.handle),
        receiptExpiresAt: new Date(window.receiptExpiresAt).toISOString(), message: '管理窗口已撤销。五分钟内仍可核对已提交结果。' }
    }
    if (window.requests.has(requestId)) throw new OwnerTransportError('OWNER_REQUEST_REPLAY', '该请求编号已使用，请查询原操作结果。', 409)
    if (window.requests.size >= MAX_REQUESTS) throw new OwnerTransportError('OWNER_REQUEST_LIMIT', '管理窗口操作数量已达上限，请重新激活。', 409)
    if (window.busy) throw new OwnerTransportError('OWNER_BUSY', '已有操作处理中；可以随时撤销管理窗口。', 409)
    const fields = action === 'prepare' ? ['action', 'parameters'] : ['prepareId', 'operationId']
    if (Object.keys(payload).some(key => !fields.includes(key)) || fields.some(key => !(key in payload))) {
      throw new OwnerTransportError('INVALID_BODY', '请求字段不符合管理操作约定。', 400)
    }
    window.requests.add(requestId)
    window.busy = true
    try {
      if (action === 'prepare') {
        if (typeof payload.action !== 'string' || !payload.parameters || typeof payload.parameters !== 'object' || Array.isArray(payload.parameters)) {
          throw new OwnerTransportError('INVALID_BODY', '准备请求需要操作名称和结构化参数。', 400)
        }
        const preview = await this.options.controller.prepare(window.handle,
          payload as Parameters<OwnerDecisionController['prepare']>[1], { signal: window.abort.signal })
        return { ok: true, preview }
      }
      if (typeof payload.prepareId !== 'string' || typeof payload.operationId !== 'string') {
        throw new OwnerTransportError('INVALID_BODY', '提交只接受准备编号和操作编号。', 400)
      }
      const receipt = await this.options.controller.commit(window.handle,
        { prepareId: payload.prepareId, operationId: payload.operationId }, { signal: window.abort.signal })
      return { ok: true, receipt }
    } finally { window.busy = false }
  }

  private invalidate(window: BrowserWindow, startReceiptGrace = false): void {
    if (startReceiptGrace) window.receiptExpiresAt = Math.min(window.receiptExpiresAt, this.now() + RECEIPT_GRACE_MS)
    window.abort.abort()
    if (window.timer) { clearTimeout(window.timer); window.timer = null }
    this.options.controller.revoke(window.handle)
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    for (const window of this.windows.values()) this.invalidate(window)
    for (const ticket of this.tickets.values()) this.options.controller.revoke(ticket.handle)
    this.tickets.clear(); this.windows.clear(); this.options.controller.dispose()
  }
}

function cookie(req: IncomingMessage): string | null {
  const matches = (req.headers.cookie ?? '').split(';').filter(part => part.trim().startsWith(`${OWNER_CONTROL_COOKIE}=`))
  if (matches.length !== 1) return null
  try { return decodeURIComponent(matches[0]!.trim().slice(OWNER_CONTROL_COOKIE.length + 1)) } catch { return null }
}

function meta(req: IncomingMessage): GuiControlRequestMeta {
  const header = (key: string): string | null => typeof req.headers[key] === 'string' ? req.headers[key] as string : null
  return { host: header('host'), origin: header('origin'), remoteAddress: req.socket.remoteAddress ?? null, fetchSite: header('sec-fetch-site') }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const value = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(value) })
  res.end(value)
}

/** Runs before the Role Plane bearer/admission routes. Neither cookie upgrades the other. */
export async function handleOwnerRequest(req: IncomingMessage, res: ServerResponse, url: URL,
  manager: OwnerLocalControlManager | undefined): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/u, '') || '/'
  if (path !== '/owner' && !path.startsWith('/api/owner/')) return false
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  const nonce = secret()
  res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`)
  try {
    if (!manager) throw new OwnerTransportError('OWNER_CHANNEL_UNAVAILABLE', '请先从本地直接入口打开管理窗口。', 401)
    const requestMeta = meta(req)
    manager.checkTransport(requestMeta, req.method === 'POST', path === '/owner')
    if (req.method === 'GET' && path === '/owner') {
      if (url.searchParams.has('ticket')) {
        if ([...url.searchParams.keys()].some(key => key !== 'ticket') || url.searchParams.getAll('ticket').length !== 1) {
          throw new OwnerTransportError('OWNER_TICKET_INVALID', '启动链接无效。', 410)
        }
        const redeemed = manager.redeem(url.searchParams.get('ticket')!, requestMeta)
        // 303 到不含 ticket 的地址；只可能带上一次性票据里保存的非授权定位提示。
        res.writeHead(303, { Location: redeemed.redirectPath, 'Set-Cookie': `${OWNER_CONTROL_COOKIE}=${encodeURIComponent(redeemed.cookie)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${redeemed.maxAgeSeconds}` })
        res.end(); return true
      }
      const html = renderOwnerApp(nonce)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) })
      res.end(html); return true
    }
    // 已确认改动证据的只读读取：必须精确给出 task/evidence/item 三个参数，
    // 不接受多余字段、重复字段或任意路径；正文只从内容寻址证据目录重验后返回。
    if (req.method === 'GET' && path === '/api/owner/delivery-change') {
      const keys = [...url.searchParams.keys()]
      const allowed = ['task', 'evidence', 'item']
      if (keys.length !== allowed.length || new Set(keys).size !== allowed.length || keys.some(key => !allowed.includes(key))) {
        throw new OwnerTransportError('INVALID_BODY', '改动读取需要且只接受 task、evidence、item 三个精确参数。', 400)
      }
      const params = { taskId: url.searchParams.get('task') ?? '', evidenceId: url.searchParams.get('evidence') ?? '', entryId: url.searchParams.get('item') ?? '' }
      json(res, 200, manager.readChange(cookie(req), requestMeta, params)); return true
    }
    // 交付条目问答线程的只读读取：同样只接受 task、item 两个精确参数，
    // 正文只从权威 events 账本按精确条目读取，不作为通用事件投影暴露。
    if (req.method === 'GET' && path === '/api/owner/delivery-questions') {
      const keys = [...url.searchParams.keys()]
      const allowed = ['task', 'item']
      if (keys.length !== allowed.length || new Set(keys).size !== allowed.length || keys.some(key => !allowed.includes(key))) {
        throw new OwnerTransportError('INVALID_BODY', '问答读取需要且只接受 task、item 两个精确参数。', 400)
      }
      const params = { taskId: url.searchParams.get('task') ?? '', itemId: url.searchParams.get('item') ?? '' }
      json(res, 200, manager.readQuestions(cookie(req), requestMeta, params)); return true
    }
    if (url.search) throw new OwnerTransportError('INVALID_BODY', '管理接口不接受查询参数。', 400)
    if (req.method === 'GET' && path === '/api/owner/control') {
      json(res, 200, await manager.inspect(cookie(req), requestMeta)); return true
    }
    const receipt = /^\/api\/owner\/receipts\/([A-Za-z0-9_-]{1,128})$/u.exec(path)
    if (req.method === 'GET' && receipt) {
      const decisionId = typeof req.headers['x-kingdom-decision-id'] === 'string' ? req.headers['x-kingdom-decision-id'] : null
      json(res, 200, manager.receipt(cookie(req), requestMeta, receipt[1]!, decisionId)); return true
    }
    const mutation = /^\/api\/owner\/(prepare|commit|revoke)$/u.exec(path)
    if (req.method === 'POST' && mutation) {
      if (req.headers['x-kingdom-client'] !== 'owner-gui' || !/^application\/json(?:;|$)/iu.test(req.headers['content-type'] ?? '')) {
        throw new OwnerTransportError('INVALID_BODY', '管理操作需要结构化页面请求。', 400)
      }
      const chunks: Buffer[] = []; let bytes = 0
      for await (const raw of req) {
        const chunk = Buffer.from(raw); bytes += chunk.length
        if (bytes > MAX_BODY_BYTES) throw new OwnerTransportError('INVALID_BODY', '管理操作内容过长。', 413)
        chunks.push(chunk)
      }
      let body: Record<string, unknown>
      try { body = parseStrictJsonObject(Buffer.concat(chunks).toString('utf8')) }
      catch { throw new OwnerTransportError('INVALID_BODY', '管理操作必须是无重复字段的对象。', 400) }
      const header = (name: string): string | null => typeof req.headers[name] === 'string' ? req.headers[name] as string : null
      const result = await manager.mutate(cookie(req), header('x-kingdom-csrf'), header('x-kingdom-request-id'), requestMeta,
        mutation[1] as 'prepare' | 'commit' | 'revoke', body)
      if (mutation[1] === 'revoke') res.setHeader('Set-Cookie', `${OWNER_CONTROL_COOKIE}=${encodeURIComponent(cookie(req)!)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=300`)
      json(res, 200, result); return true
    }
    throw new OwnerTransportError('OWNER_ROUTE_NOT_FOUND', '未找到该管理入口。', 404)
  } catch (error: unknown) {
    const known = error instanceof Error && typeof (error as { code?: unknown }).code === 'string'
    const code = known ? String((error as { code?: unknown }).code) : 'OWNER_OPERATION_UNKNOWN'
    const safeCode = /^[A-Z0-9_]{1,80}$/u.test(code) ? code : 'OWNER_OPERATION_UNKNOWN'
    json(res, error instanceof OwnerTransportError ? error.status : known ? 409 : 500,
      { ok: false, errorCode: safeCode, message: known ? (error as Error).message.slice(0, 500) : '管理操作结果尚未确认，请先查询已有操作结果。' })
    return true
  }
}
