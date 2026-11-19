import { randomBytes } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  buildBridgeState,
  createNotice,
  emptyBridgeState,
  normalizeClientSnapshot,
  noticeStatusFor,
  pruneNotices,
} from './lib/aggregate.js'

/**
 * DSH Status 桥（Host 薄桥）：
 *   - 原生 App：GET /state、GET /stream(SSE)、POST /command（Bearer token）
 *   - Client 半：POST /client/state、GET /client/commands（浏览器同源鉴权）
 * 协议见 docs/protocol.md。
 */

const PLUGIN_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const DEFAULT_APP_PATHS = [
  '/Applications/DSH Status.app',
  path.join(homedir(), 'Applications', 'DSH Status.app'),
]

export const inject = ['webServer', 'connection']

const PREFIX = '/dsh-status'
const CLIENT_POLL_TIMEOUT_MS = 25_000
/** turn/end 之后的这段时间内，客户端可能还有在途的旧快照（running=true），不能据此清临时行。 */
const SETTLE_MS = 3_000
const HEARTBEAT_MS = 5_000

export function apply(ctx, config = {}) {
  const bridgeDir = process.env.DSH_STATUS_DIR || path.join(homedir(), '.dsh-status')
  const bridgeFile = path.join(bridgeDir, 'bridge.json')
  const token = randomBytes(32).toString('hex')
  const startedAt = Date.now()

  const hostAgents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  const hostProjections = typeof ctx.get === 'function' ? ctx.get('sessionProjections') : undefined
  const lastTurn = new Map() // sessionId -> { kind, at }
  const sinceCache = new Map() // sessionId -> { status, since }
  let focusedSessions = new Map() // sessionId -> { title, workspaceId, workspaceTitle }（DSH 主视图）
  let notices = [] // 焦点会话跑完的一次性通知，短时间内保留给 App 去重
  const focusedCompletions = new Map() // sessionId -> { kind, at, title, workspaceId, workspaceTitle }
  const sseClients = new Set()
  const commandQueue = []
  const commandWaiters = new Set()

  let snapshot = null
  let lastPushAt = null
  let disposed = false
  let heartbeatTimer = null
  let appLaunchTimer = null

  const origin = ctx.webServer.getOrigin ? ctx.webServer.getOrigin() : `http://127.0.0.1:${ctx.webServer.port}`
  const port = ctx.webServer.port
  const appPath = resolveAppPath(config?.appPath)

  // ---------- bridge.json ----------

  function bridgeInfo() {
    return {
      version: 1,
      pluginVersion: PLUGIN_VERSION,
      port,
      origin,
      token,
      pid: process.pid,
      startedAt,
      ...(appPath ? { appPath } : {}),
    }
  }

  function writeBridgeFile() {
    try {
      mkdirSync(bridgeDir, { recursive: true, mode: 0o700 })
      // 目录已存在时 mkdirSync 的 mode 不生效，显式收紧到 0700
      try { chmodSync(bridgeDir, 0o700) } catch {}
      const temporary = `${bridgeFile}.tmp`
      writeFileSync(temporary, JSON.stringify(bridgeInfo(), null, 2), { mode: 0o600 })
      renameSync(temporary, bridgeFile)
    } catch (error) {
      console.warn('[dsh-status] 写入 bridge.json 失败：', error)
    }
  }

  function removeBridgeFile() {
    try {
      rmSync(bridgeFile, { force: true })
    } catch {}
  }

  // ---------- 状态 ----------

  // 运行中的会话在 Host 侧有 live Agent，可直接读 title 投影补齐标题
  function withHostTitles(entries) {
    if (!Array.isArray(entries) || !hostAgents || !hostProjections) return entries
    return entries.map((entry) => {
      if (typeof entry.title === 'string' && entry.title.trim() !== '') return entry
      try {
        const session = hostAgents.get(entry.id)?.session
        const title = session ? hostProjections.stateOf(session, 'title') : undefined
        if (typeof title === 'string' && title.trim() !== '') return { ...entry, title }
      } catch {}
      return entry
    })
  }

  function transientSessions() {
    return [...focusedCompletions.entries()].map(([id, entry]) => ({ id, ...entry }))
  }

  function currentState() {
    const enriched = snapshot ? { ...snapshot, sessions: withHostTitles(snapshot.sessions) } : null
    return buildBridgeState({
      snapshot: enriched,
      lastTurn,
      sinceCache,
      notices,
      transientSessions: transientSessions(),
      dsh: { pid: process.pid },
      connected: snapshot != null,
      lastPushAt,
      now: Date.now(),
    })
  }

  function broadcastState() {
    if (sseClients.size === 0) return
    const payload = `event: state\ndata: ${JSON.stringify(currentState())}\n\n`
    for (const response of sseClients) {
      try {
        response.write(payload)
      } catch {
        sseClients.delete(response)
      }
    }
  }

  function onSessionEvent(session, event) {
    if (disposed || !session || !event) return
    if (event.type !== 'turn/end') return
    const kind = event.data?.reason?.kind ?? 'completed'
    lastTurn.set(session.id, { kind, at: Date.now() })
    // 焦点会话跑完：DSH 不置 completionUnread（用户正看着它），桥按 turn/end 补一条通知，
    // 不产生状态行、不计入 counts / 角标。见 docs/protocol.md §2「notices」。
    const focus = focusedSessions.get(session.id)
    if (focus) {
      focusedCompletions.set(session.id, {
        kind: noticeStatusFor(kind),
        at: Date.now(),
        title: focus.title,
        workspaceId: focus.workspaceId,
        workspaceTitle: focus.workspaceTitle,
      })
      notices = pruneNotices([
        createNotice({
          sessionId: session.id,
          kind,
          at: Date.now(),
          title: focus.title,
          workspaceId: focus.workspaceId,
          workspaceTitle: focus.workspaceTitle,
        }),
        ...notices,
      ])
    }
    broadcastState()
  }

  // ---------- 命令 ----------

  function enqueueCommand(input) {
    const command = {
      type: input.type,
      sessionId: input.sessionId,
      requestId: randomBytes(6).toString('hex'),
    }
    const waiter = commandWaiters.values().next().value
    if (waiter) {
      commandWaiters.delete(waiter)
      clearTimeout(waiter.timer)
      respondJson(waiter.response, 200, { commands: [command] })
    } else {
      commandQueue.push(command)
      if (commandQueue.length > 50) commandQueue.shift()
    }
    return command.requestId
  }

  function handleClientCommands(response) {
    if (commandQueue.length > 0) {
      respondJson(response, 200, { commands: commandQueue.splice(0, commandQueue.length) })
      return
    }
    const waiter = { response, timer: null }
    waiter.timer = setTimeout(() => {
      commandWaiters.delete(waiter)
      respondJson(response, 200, { commands: [] })
    }, CLIENT_POLL_TIMEOUT_MS)
    commandWaiters.add(waiter)
    response.on('close', () => {
      clearTimeout(waiter.timer)
      commandWaiters.delete(waiter)
    })
  }

  // ---------- HTTP ----------

  function handleRequest(req, res) {
    Promise.resolve()
      .then(() => route(req, res))
      .catch((error) => {
        console.warn('[dsh-status] 请求处理失败：', error)
        if (!res.headersSent) respondJson(res, 500, { error: 'internal' })
        else res.end()
      })
  }

  async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const routePath = url.pathname
    if (!routePath.startsWith(PREFIX)) return respondJson(res, 404, { error: 'not-found' })
    const endpoint = routePath.slice(PREFIX.length) || '/'
    const method = req.method ?? 'GET'

    if (method === 'GET' && endpoint === '/health') {
      return respondJson(res, 200, { ok: true, version: 1 })
    }

    // 原生 App 接口
    if (endpoint === '/state' || endpoint === '/stream' || endpoint === '/command') {
      if (!isNativeAuthorized(req)) return respondJson(res, 401, { error: 'unauthorized' })
      if (method === 'GET' && endpoint === '/state') {
        return respondJson(res, 200, currentState())
      }
      if (method === 'GET' && endpoint === '/stream') {
        return openStream(res)
      }
      if (method === 'POST' && endpoint === '/command') {
        const body = await readJson(req)
        if (!body || typeof body.type !== 'string') {
          return respondJson(res, 400, { error: 'bad-command' })
        }
        // App 点「忽略」：删掉焦点会话的临时「已完成」行（不打扰 Client 半）。
        // 带 sessionId 删一条；不带则「全部忽略」。
        if (body.type === 'dismiss') {
          let changed = false
          if (typeof body.sessionId === 'string' && body.sessionId !== '') {
            changed = focusedCompletions.delete(body.sessionId)
          } else if (focusedCompletions.size > 0) {
            focusedCompletions.clear()
            changed = true
          }
          if (changed) broadcastState()
          return respondJson(res, 200, { ok: true })
        }
        if (body.type !== 'openSession' || typeof body.sessionId !== 'string') {
          return respondJson(res, 400, { error: 'bad-command' })
        }
        const requestId = enqueueCommand({ type: 'openSession', sessionId: body.sessionId })
        return respondJson(res, 200, { ok: true, requestId })
      }
      return respondJson(res, 405, { error: 'method-not-allowed' })
    }

    // Client 半接口（浏览器同源，用 connection.admit 鉴权）
    if (endpoint === '/client/state' || endpoint === '/client/commands') {
      if (!(await isBrowserAuthorized(req))) return respondJson(res, 401, { error: 'unauthorized' })
      if (method === 'POST' && endpoint === '/client/state') {
        const body = await readJson(req)
        const normalized = normalizeClientSnapshot(body)
        if (!normalized) return respondJson(res, 400, { error: 'bad-snapshot' })
        snapshot = normalized
        focusedSessions = new Map((normalized.focused ?? []).map((entry) => [entry.id, entry]))
        // 临时行何时让位给真实状态：
        //   · 会话真的重新开跑 / 进入待回答（turn/end 之后 3s 之外的快照才可信，在途旧快照不算）；
        //   · 客户端报了未读、且该会话已经不在焦点里（真实 completed 行接管）。
        // 仍在焦点里的 unread 只是瞬时状态（DSH 主视图会立刻清掉），不能据此删临时行。
        const sentAt = typeof normalized.sentAt === 'number' ? normalized.sentAt : Date.now()
        const focusedNow = new Set((normalized.focused ?? []).map((entry) => entry.id))
        for (const entry of normalized.sessions) {
          const done = focusedCompletions.get(entry.id)
          if (!done) continue
          if (entry.running || entry.pending) {
            if (sentAt > done.at + SETTLE_MS) focusedCompletions.delete(entry.id)
          } else if (entry.unread && !focusedNow.has(entry.id)) {
            if (sentAt > done.at) focusedCompletions.delete(entry.id)
          }
        }
        lastPushAt = Date.now()
        broadcastState()
        return respondJson(res, 204, null)
      }
      if (method === 'GET' && endpoint === '/client/commands') {
        return handleClientCommands(res)
      }
      return respondJson(res, 405, { error: 'method-not-allowed' })
    }

    return respondJson(res, 404, { error: 'not-found' })
  }

  function openStream(res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(`event: state\ndata: ${JSON.stringify(currentState())}\n\n`)
    sseClients.add(res)
    res.on('close', () => sseClients.delete(res))
  }

  function isNativeAuthorized(req) {
    const host = req.headers.host
    if (typeof host !== 'string' || !isLoopbackHost(host)) return false
    return req.headers.authorization === `Bearer ${token}`
  }

  async function isBrowserAuthorized(req) {
    try {
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(key, value)
        else if (Array.isArray(value)) headers.set(key, value.join(', '))
      }
      const request = new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers })
      const admission = ctx.connection.admit(request)
      return Boolean(admission) && !('rejection' in admission)
    } catch (error) {
      console.warn('[dsh-status] 浏览器鉴权失败：', error)
      return false
    }
  }

  // ---------- App 拉起 ----------

  function scheduleAppLaunch() {
    if (!appPath) return
    const binary = path.join(appPath, 'Contents', 'MacOS', 'DSHStatusBar')
    if (!existsSync(binary)) return
    appLaunchTimer = setTimeout(() => {
      if (disposed) return
      try {
        execFileSync('pgrep', ['-f', binary], { stdio: 'ignore' })
        return
      } catch {}
      try {
        spawn(binary, [], { detached: true, stdio: 'ignore' }).unref()
      } catch (error) {
        console.warn('[dsh-status] 拉起菜单栏 App 失败：', error)
      }
    }, 800)
  }

  // ---------- 生命周期 ----------

  ctx.effect(() => {
    writeBridgeFile()
    const disposeRoute = ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: handleRequest })
    const disposeSessionEvent = ctx.on('session/event', onSessionEvent, { global: true })
    heartbeatTimer = setInterval(() => {
      // bridge.json 自愈：文件被删除时重写（App 2s 轮询发现路径）
      if (!existsSync(bridgeFile)) writeBridgeFile()
      for (const response of sseClients) {
        try {
          response.write(': ping\n\n')
        } catch {
          sseClients.delete(response)
        }
      }
    }, HEARTBEAT_MS)
    scheduleAppLaunch()

    return () => {
      disposed = true
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      if (appLaunchTimer) clearTimeout(appLaunchTimer)
      try { disposeSessionEvent?.() } catch {}
      try { disposeRoute?.() } catch {}
      for (const response of sseClients) {
        try { response.end() } catch {}
      }
      sseClients.clear()
      for (const waiter of commandWaiters) {
        clearTimeout(waiter.timer)
        try { respondJson(waiter.response, 200, { commands: [] }) } catch {}
      }
      commandWaiters.clear()
      removeBridgeFile()
    }
  }, 'dsh-status: bridge')
}

// ---------- 工具 ----------

function respondJson(res, status, body) {
  if (res.destroyed || res.writableEnded) return
  if (body === null) {
    res.writeHead(status)
    res.end()
    return
  }
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

function isLoopbackHost(host) {
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)
}

/**
 * 按顺序探测菜单栏 App：
 *   config.appPath → DSH_STATUS_APP 环境变量 → /Applications/DSH Status.app → ~/Applications/DSH Status.app
 * 返回实际存在的路径（写入 bridge.json），都没有则返回 null。
 */
function resolveAppPath(configured) {
  const candidates = []
  if (typeof configured === 'string' && configured.trim() !== '') candidates.push(configured.trim())
  const fromEnv = typeof process.env.DSH_STATUS_APP === 'string' ? process.env.DSH_STATUS_APP.trim() : ''
  if (fromEnv !== '') candidates.push(fromEnv)
  candidates.push(...DEFAULT_APP_PATHS)

  for (const raw of candidates) {
    const expanded = raw.replace(/^~(?=\/)/, homedir())
    if (existsSync(expanded)) return expanded
  }
  if (typeof configured === 'string' && configured.trim() !== '') {
    console.warn(`[dsh-status] appPath 不存在，且默认路径均未找到：${configured}`)
  }
  return null
}
