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
 * - **默认关闭**：`guiPort` 缺省为 0。要用 GUI 必须显式配置端口——
 *   插件不会在用户不知情时打开监听端口。
 * - 只绑定 `127.0.0.1`，不监听外部网卡。
 * - 写命令要求自定义头 `X-Kingdom-Client`：自定义头会强制浏览器发预检，
 *   从而挡掉简单表单式 CSRF（恶意页面无法向本机端口静默提交命令）。
 * - 可选 `guiToken`：设置后所有请求需带 `Authorization: Bearer <token>`。
 * - 鉴权诚实度由 snapshot 的 `auth.trustLevel` 如实声明，GUI 必须显示。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { CommandResultView, SnapshotView, TaskDetailView } from './contract.js'
import { GUI_SCHEMA_VERSION } from './contract.js'
import type { EventView } from './contract.js'

export interface GuiServerHandlers {
  snapshot(): SnapshotView
  taskDetail(taskId: string): TaskDetailView | null
  eventsSince(afterSeq: number, limit: number): { revision: number; events: EventView[] }
  command(name: string, payload: Record<string, unknown>): Promise<CommandResultView>
}

export interface GuiServerOptions {
  port: number
  host?: string
  token?: string
  allowOrigins?: string[]
  logger?: { info(message: string): void; warn(message: string): void }
}

/** 写命令必须带的自定义头（存在即可，值不校验）。 */
const CLIENT_HEADER = 'x-kingdom-client'

const COMMANDS = new Set([
  'plan', 'assign', 'start', 'review',
  'execution.pause', 'execution.resume', 'execution.abort',
])

function corsOrigin(req: IncomingMessage, allow: string[]): string | null {
  const origin = req.headers.origin
  if (allow.includes('*')) return origin ?? '*'
  if (typeof origin === 'string' && allow.includes(origin)) return origin
  return null
}

function applyCors(req: IncomingMessage, res: ServerResponse, allow: string[]): void {
  const origin = corsOrigin(req, allow)
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', `Content-Type, Authorization, ${CLIENT_HEADER}`)
  res.setHeader('Access-Control-Max-Age', '600')
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
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/**
 * 启动本地 GUI 通道。
 * @returns 关闭函数（挂到 ctx.effect，插件卸载/热重载时自动收回端口）。
 */
export function startGuiServer(handlers: GuiServerHandlers, options: GuiServerOptions): () => void {
  const host = options.host ?? '127.0.0.1'
  const allow = options.allowOrigins ?? ['*']
  const token = options.token?.trim() || null

  const server: Server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        sendError(res, 500, 'INTERNAL_ERROR', error instanceof Error ? error.message : String(error))
      } else {
        res.end()
      }
    })
  })

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applyCors(req, res, allow)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    if (token !== null && req.headers.authorization !== `Bearer ${token}`) {
      sendError(res, 401, 'UNAUTHORIZED', 'missing or invalid bearer token')
      return
    }

    const url = new URL(req.url ?? '/', `http://${host}`)
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (req.method === 'GET' && (path === '/' || path === '/api/health')) {
      sendJson(res, 200, { ok: true, service: 'dsh-kingdom', schemaVersion: GUI_SCHEMA_VERSION })
      return
    }

    if (req.method === 'GET' && path === '/api/snapshot') {
      sendJson(res, 200, handlers.snapshot())
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

    const taskMatch = /^\/api\/tasks\/([^/]+)$/u.exec(path)
    if (req.method === 'GET' && taskMatch) {
      const detail = handlers.taskDetail(decodeURIComponent(taskMatch[1]!))
      if (!detail) {
        sendError(res, 404, 'TASK_NOT_FOUND', 'task not found in the current kingdom')
        return
      }
      sendJson(res, 200, detail)
      return
    }

    const commandMatch = /^\/api\/commands\/([a-z.]+)$/u.exec(path)
    if (req.method === 'POST' && commandMatch) {
      const name = commandMatch[1]!
      if (!COMMANDS.has(name)) {
        sendError(res, 404, 'UNKNOWN_COMMAND', `unknown command "${name}"`)
        return
      }
      // 自定义头强制预检，挡掉简单表单式 CSRF。
      if (req.headers[CLIENT_HEADER] === undefined) {
        sendError(res, 400, 'MISSING_CLIENT_HEADER',
          `write commands require the ${CLIENT_HEADER} header`)
        return
      }
      let payload: Record<string, unknown>
      try {
        payload = await readJsonBody(req)
      } catch (error: unknown) {
        sendError(res, 400, 'INVALID_BODY', error instanceof Error ? error.message : String(error))
        return
      }
      const result = await handlers.command(name, payload)
      sendJson(res, result.ok ? 200 : 409, result)
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
    }
  })

  server.listen(options.port, host, () => {
    retries = 0
    options.logger?.info(
      `dsh-kingdom GUI 通道已监听 http://${host}:${options.port}`
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
  }
}
