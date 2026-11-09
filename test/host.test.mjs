import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function createFakeCtx() {
  const routes = new Map()
  const listeners = new Map()
  const effectCleanups = []

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    let matched = null
    for (const route of routes.values()) {
      if (pathname.startsWith(route.path) && (matched === null || route.path.length > matched.path.length)) {
        matched = route
      }
    }
    if (!matched) {
      res.writeHead(404)
      res.end()
      return
    }
    matched.handler(req, res)
  })

  const webServer = {
    get port() { return server.address().port },
    getOrigin() { return `http://127.0.0.1:${server.address().port}` },
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }

  const connection = {
    admit: () => ({ peer: { id: 'browser' } }),
  }

  const ctx = {
    webServer,
    connection,
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effectCleanups.push(dispose)
      return dispose
    },
    on(event, callback) {
      listeners.set(event, callback)
      return () => listeners.delete(event)
    },
    emit(event, ...args) {
      listeners.get(event)?.(...args)
    },
  }

  return {
    ctx,
    server,
    routes,
    listeners,
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    },
    async dispose() {
      for (const dispose of effectCleanups.reverse()) {
        try { await dispose() } catch {}
      }
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-status-host-'))
  const stateDir = path.join(root, 'state')
  // 预先以宽松权限建目录，验证插件把已存在的 bridge 目录收紧到 0700
  await mkdir(stateDir, { recursive: true, mode: 0o755 })
  await chmod(stateDir, 0o755)
  process.env.DSH_STATUS_DIR = stateDir
  // 存在但不含可执行文件的假 App bundle：验证 appPath 解析，同时避免测试真的拉起本机菜单栏 App
  const fakeApp = path.join(root, 'DSH Status.app')
  await mkdir(fakeApp, { recursive: true })
  const fake = createFakeCtx()
  await fake.listen()
  const { apply } = await import('../index.js')
  apply(fake.ctx, { appPath: fakeApp })
  const bridge = JSON.parse(await readFile(path.join(stateDir, 'bridge.json'), 'utf8'))
  const base = `http://127.0.0.1:${bridge.port}`
  const auth = { authorization: `Bearer ${bridge.token}` }
  return { root, stateDir, fakeApp, fake, bridge, base, auth }
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options)
  const text = await response.text()
  let body = null
  try { body = text === '' ? null : JSON.parse(text) } catch { body = text }
  return { status: response.status, body }
}

test('Host 桥：bridge.json / 鉴权 / 状态合并 / 命令 / SSE / 卸载', async () => {
  const { root, stateDir, fakeApp, fake, bridge, base, auth } = await setup()
  try {
    // bridge.json
    assert.equal(bridge.version, 1)
    assert.equal(bridge.port, fake.server.address().port)
    assert.match(bridge.origin, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(bridge.token.length, 64)
    assert.equal(bridge.pluginVersion, '0.1.0')
    assert.equal(bridge.appPath, fakeApp)
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700, 'bridge 目录应为 0700')
    assert.equal((await stat(path.join(stateDir, 'bridge.json'))).mode & 0o777, 0o600, 'bridge.json 应为 0600')

    // health 免鉴权
    const health = await jsonRequest(`${base}/dsh-status/health`)
    assert.equal(health.status, 200)
    assert.equal(health.body.ok, true)

    // 原生接口需要 Bearer
    assert.equal((await jsonRequest(`${base}/dsh-status/state`)).status, 401)
    const initial = await jsonRequest(`${base}/dsh-status/state`, { headers: auth })
    assert.equal(initial.status, 200)
    assert.equal(initial.body.counts.attention, 0)
    assert.equal(initial.body.client.connected, false)

    // Client 推送快照（fake connection.admit 放行）
    const snapshot = {
      version: 1,
      sessions: [
        { id: 's-waiting', title: '选方案', workspaceId: 'w1', workspaceTitle: 'example-app', running: false, unread: false, pending: { kind: 'question', questions: [{ title: '示例问题' }] }, updatedAt: 1 },
        { id: 's-running', title: '跑测试', workspaceId: 'w1', workspaceTitle: 'example-app', running: true, unread: false, pending: null, updatedAt: 2 },
        { id: 's-unread', title: '写协议', workspaceId: 'w2', workspaceTitle: 'example-app', running: false, unread: true, pending: null, updatedAt: 3 },
        { id: 's-idle', title: '空闲', running: false, unread: false, pending: null, updatedAt: 4 },
      ],
    }
    const push = await jsonRequest(`${base}/dsh-status/client/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(snapshot),
    })
    assert.equal(push.status, 204)

    const merged = await jsonRequest(`${base}/dsh-status/state`, { headers: auth })
    assert.equal(merged.status, 200)
    assert.equal(merged.body.client.connected, true)
    assert.deepEqual(merged.body.counts, { waiting: 1, running: 1, completed: 1, stopped: 0, attention: 2 })
    const byId = new Map(merged.body.sessions.map((session) => [session.id, session]))
    assert.equal(byId.get('s-waiting').status, 'waiting')
    assert.deepEqual(byId.get('s-waiting').pending, { kind: 'question', summary: '示例问题' })
    assert.equal(byId.get('s-running').status, 'running')
    assert.equal(byId.get('s-unread').status, 'completed')
    assert.equal(byId.has('s-idle'), false)

    // turn/end aborted → unread 变已停止
    fake.ctx.emit('session/event', { id: 's-unread' }, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
    const stoppedState = await jsonRequest(`${base}/dsh-status/state`, { headers: auth })
    const stoppedSession = stoppedState.body.sessions.find((session) => session.id === 's-unread')
    assert.equal(stoppedSession.status, 'stopped')
    assert.deepEqual(stoppedState.body.counts, { waiting: 1, running: 1, completed: 0, stopped: 1, attention: 2 })

    // SSE 首帧
    const controller = new AbortController()
    const streamResponse = await fetch(`${base}/dsh-status/stream`, { headers: auth, signal: controller.signal })
    assert.equal(streamResponse.status, 200)
    assert.match(streamResponse.headers.get('content-type') ?? '', /text\/event-stream/)
    const reader = streamResponse.body.getReader()
    const first = await reader.read()
    const firstText = new TextDecoder().decode(first.value)
    assert.match(firstText, /event: state/)
    assert.match(firstText, /"counts"/)
    controller.abort()
    try { await reader.cancel() } catch {}

    // 命令长轮询：先挂起 GET，再 POST 命令，应立刻返回
    const pollPromise = jsonRequest(`${base}/dsh-status/client/commands`)
    await delay(80)
    const command = await jsonRequest(`${base}/dsh-status/command`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'openSession', sessionId: 'session-target' }),
    })
    assert.equal(command.status, 200)
    assert.equal(command.body.ok, true)
    assert.match(command.body.requestId, /^[0-9a-f]{12}$/)
    const polled = await pollPromise
    assert.equal(polled.status, 200)
    assert.deepEqual(polled.body.commands.map((item) => item.sessionId), ['session-target'])

    // 非法命令
    const bad = await jsonRequest(`${base}/dsh-status/command`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'nope' }),
    })
    assert.equal(bad.status, 400)
  } finally {
    await fake.dispose()
    await stat(path.join(stateDir, 'bridge.json')).then(
      () => assert.fail('bridge.json 应已删除'),
      () => {}
    )
    await rm(root, { recursive: true, force: true })
  }
})
