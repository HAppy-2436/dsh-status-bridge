import { randomBytes } from 'node:crypto'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  abortCauseOf,
  buildBridgeState,
  createNotice,
  emptyBridgeState,
  normalizeClientSnapshot,
  noticeStatusFor,
  pruneNotices,
} from './lib/aggregate.js'
import { planNotifications } from './lib/notify.js'

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
const APP_URL = 'https://github.com/HAppy-2436/dsh-status/releases/latest'

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
  // DSH 0.2.2-rc.2 起，服务读取按「调用方 fiber 的 inject」鉴权：Connection.admit 内部要读
  // connection.authentication，直接调用会抛 `cannot get property "connection.authentication"
  // without inject`，浏览器半的请求全部 401。把这次调用放进声明了该服务的子 fiber；
  // 老版本（没有这个服务）子 fiber 保持 pending，回退到直接调用。
  let admitBrowserRequest = (request) => ctx.connection.admit(request)

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
  const commands = typeof ctx.get === 'function' ? ctx.get('commands') : undefined
  // 独立可用：App 没连上时，插件自己发基础 macOS 通知；App 连上后由 App 接管（更丰富的
  // 面板/跳转/声音/勿扰）。非 macOS 或显式关闭时不发。
  const fallbackNotifications = config?.fallbackNotifications !== false && process.platform === 'darwin'
  const APP_GRACE_MS = 10_000
  let lastAppSeenAt = 0
  let observedStatuses = new Map()

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

  function statusReport() {
    const state = currentState()
    const counts = state.counts
    const lines = [
      `DSH Status bridge ${PLUGIN_VERSION}`,
      `Sessions: ${counts.running} running, ${counts.waiting} waiting, ${counts.completed} completed, ${counts.stopped} stopped`,
      appPath
        ? `Menu bar app: installed (${appPath})`
        : 'Menu bar app: not installed — basic notifications are active.',
    ]
    if (!appPath) lines.push(`Optional menu bar panel: ${APP_URL}`)
    if (!state.client.connected) lines.push('DSH client snapshot: not connected yet.')
    return lines.join('\n')
  }

  function maybeNotifyFallback(state) {
    if (!fallbackNotifications) return
    const { events, next } = planNotifications(observedStatuses, state.sessions)
    observedStatuses = next
    // App 正在收听（或刚断开不到 10s）：把状态记下但不重复弹，避免 App 和插件各弹一次。
    if (sseClients.size > 0) return
    if (Date.now() - lastAppSeenAt < APP_GRACE_MS) return
    for (const event of events) notifyMac(event)
  }

  function broadcastState() {
    if (sseClients.size === 0 && !fallbackNotifications) return
    const state = currentState()
    maybeNotifyFallback(state)
    if (sseClients.size === 0) return
    const payload = `event: state\ndata: ${JSON.stringify(state)}\n\n`
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
    const reason = event.data?.reason
    const kind = reason?.kind ?? 'completed'
    const cancel = abortCauseOf(reason)
    const userStop = kind === 'aborted' && cancel === 'user'
    const at = Date.now()
    lastTurn.set(session.id, { kind, ...(cancel ? { cancel } : {}), at })
    // 焦点会话跑完：DSH 不置 completionUnread（用户正看着它），桥按 turn/end 补一条通知，
    // 不产生状态行、不计入 counts / 角标。见 docs/protocol.md §2「notices」。
    // 用户自己按停止：通知、临时行、状态行都不留（他按下停止时正看着这个会话），
    // 由 statusOf 的 cancel=user 分支把可能出现的 unread 行一并丢掉。
    const focus = focusedSessions.get(session.id)
    if (userStop) {
      // 用户主动停止：清掉上一轮可能残留的临时「已完成」行，且不生成新 notice / 临时行。
      focusedCompletions.delete(session.id)
    } else if (focus) {
      focusedCompletions.set(session.id, {
        kind: noticeStatusFor(kind),
        at,
        title: focus.title,
        workspaceId: focus.workspaceId,
        workspaceTitle: focus.workspaceTitle,
      })
      notices = pruneNotices([
        createNotice({
          sessionId: session.id,
          kind,
          cancel,
          at,
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
    lastAppSeenAt = Date.now()
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
      const admission = admitBrowserRequest(request)
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

  if (typeof ctx.inject === 'function') {
    ctx.effect(() => {
      const admissionFiber = ctx.inject(['connection', 'connection.authentication'], (admitCtx) => {
        admitBrowserRequest = (request) => admitCtx.connection.admit(request)
      })
      return () => {
        admitBrowserRequest = (request) => ctx.connection.admit(request)
        try { admissionFiber?.dispose?.() } catch {}
      }
    }, 'dsh-status: connection admission')
  }

  ctx.effect(() => {
    writeBridgeFile()
    // DSH 0.2.3 起 webServer 的默认 auth 是 'required'：没带 DSH 登录态的原生 App 会在进入
    // handler 前被 401 挡掉（0.1.6 及更早即因此断连）。本路由自己鉴权——原生接口校验回环
    // Host + Bearer token，Client 接口用 ctx.connection.admit——所以显式声明 anonymous，
    // 把准入交回桥，保持与 0.2.3 之前完全相同的安全模型。
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      auth: 'anonymous',
      handler: handleRequest,
    })
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
    if (!appPath) {
      console.info(`[dsh-status] basic notifications active; menu bar app not found. Optional app: ${APP_URL}`)
    }

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

  ctx.effect(() => {
    if (!commands || typeof commands.register !== 'function') return
    return commands.register({
      name: 'dsh-status',
      description: 'Show DSH Status bridge status and the optional menu bar app link',
      handler: () => {
        try {
          return { kind: 'success', text: statusReport() }
        } catch (error) {
          return { kind: 'error', text: `DSH Status: ${String(error)}` }
        }
      },
    })
  }, 'dsh-status: command')
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

function notifyMac(event) {
  const title = 'DSH Status'
  const subtitle = event.title
  const body = event.body
  const terminalNotifier = findTerminalNotifier()
  if (terminalNotifier) {
    execFile(
      terminalNotifier,
      ['-title', title, '-subtitle', subtitle, '-message', body, '-group', `dsh-status-${event.id}`],
      (error) => {
        if (error) notifyWithAppleScript(title, subtitle, body)
      },
    )
    return
  }
  notifyWithAppleScript(title, subtitle, body)
}

function notifyWithAppleScript(title, subtitle, body) {
  const script = `display notification ${appleScriptLiteral(body)} with title ${appleScriptLiteral(title)} subtitle ${appleScriptLiteral(subtitle)}`
  execFile('/usr/bin/osascript', ['-e', script], () => {})
}

function findTerminalNotifier() {
  const candidates = [
    '/opt/homebrew/bin/terminal-notifier',
    '/usr/local/bin/terminal-notifier',
    path.join(homedir(), '.npm-global/bin/terminal-notifier'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function appleScriptLiteral(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
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
