import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

function createFakeCtx() {
  const routes = new Map()
  const listeners = new Map()
  const effectCleanups = []
  const injectCalls = []

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
    // 模拟 DSH 0.2.3+ 的 webServer 准入：默认 'required'，未声明 anonymous 的路由
    // 在进入 handler 前就被 401 拦掉（原生 App 没有 DSH 登录态）。
    if (matched.auth !== 'anonymous') {
      res.writeHead(401, { 'cache-control': 'no-store' })
      res.end('unauthorized')
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

  const commandDefs = new Map()
  const commands = {
    register(definition) {
      commandDefs.set(definition.name, definition)
      return () => commandDefs.delete(definition.name)
    },
  }

  const ctx = {
    webServer,
    connection,
    commands,
    get(service) {
      return service === 'commands' ? commands : undefined
    },
    // 模拟 Cordis 的 `ctx.inject(deps, callback)`：回调拿到一个声明了依赖的子 ctx。
    inject(deps, callback) {
      injectCalls.push([...deps])
      callback({ connection })
      return { dispose() {} }
    },
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
    injectCalls,
    commandDefs,
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
  apply(fake.ctx, { appPath: fakeApp, fallbackNotifications: false })
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
    assert.equal(bridge.pluginVersion, PACKAGE_VERSION)
    assert.equal(bridge.appPath, fakeApp)
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700, 'bridge 目录应为 0700')
    assert.equal((await stat(path.join(stateDir, 'bridge.json'))).mode & 0o777, 0o600, 'bridge.json 应为 0600')

    // health 免鉴权
    const health = await jsonRequest(`${base}/dsh-status/health`)
    assert.equal(health.status, 200)
    assert.equal(health.body.ok, true)

    // DSH 0.2.3 起 webServer 默认 auth='required'；桥必须显式 anonymous，自己校验 token / admit
    assert.equal(fake.routes.get('/dsh-status')?.auth, 'anonymous')
    // DSH 0.2.2-rc.2 起 admit 需要在声明了 connection.authentication 的 fiber 里调用
    assert.deepEqual(fake.injectCalls[0], ['connection', 'connection.authentication'])

    // /dsh-status 命令：状态报告 + 可选 App 的提示
    const commandDefinition = fake.commandDefs.get('dsh-status')
    assert.ok(commandDefinition, '/dsh-status should be registered')
    const commandResult = commandDefinition.handler({})
    assert.equal(commandResult.kind, 'success')
    assert.match(commandResult.text, /DSH Status bridge/)
    assert.match(commandResult.text, /Menu bar app: installed/)

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
      focused: [
        { id: 's-running', title: '跑测试', workspaceId: 'w1', workspaceTitle: 'example-app' },
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

    // turn/end error → unread 变已停止，保留行与角标（出错停止照常提醒）
    fake.ctx.emit('session/event', { id: 's-unread' }, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'Connection error.', code: 'TRANSPORT' } } } })
    const stoppedState = await jsonRequest(`${base}/dsh-status/state`, { headers: auth })
    const stoppedSession = stoppedState.body.sessions.find((session) => session.id === 's-unread')
    assert.equal(stoppedSession.status, 'stopped')
    assert.equal(stoppedSession.lastTurn.kind, 'error')
    assert.equal(stoppedSession.lastTurn.cancel, undefined)
    assert.equal(typeof stoppedSession.lastTurn.at, 'number')
    assert.deepEqual(stoppedState.body.counts, { waiting: 1, running: 1, completed: 0, stopped: 1, attention: 2 })

    // 用户主动停止 → 连「已停止」行 / 角标都不留
    fake.ctx.emit('session/event', { id: 's-unread' }, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    const userStoppedUnread = await jsonRequest(`${base}/dsh-status/state`, { headers: auth })
    assert.equal(userStoppedUnread.body.sessions.some((session) => session.id === 's-unread'), false)
    assert.equal(userStoppedUnread.body.counts.stopped, 0)
    // 恢复成出错停止，供后续断言使用
    fake.ctx.emit('session/event', { id: 's-unread' }, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'Connection error.', code: 'TRANSPORT' } } } })
    assert.equal((await jsonRequest(`${base}/dsh-status/state`, { headers: auth }))
      .body.sessions.find((session) => session.id === 's-unread').status, 'stopped')

    // 焦点会话跑完：DSH 不置 completionUnread，Host 按 turn/end 补一条 notice；
    // 客户端随后会把这行丢掉，Host 再补一条 transient 的「已完成」行（图标/面板用）
    fake.ctx.emit('session/event', { id: 's-running' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    const focusedState = await jsonRequest(`${base}/dsh-status/state`, { headers: auth })
    assert.equal(focusedState.body.notices.length, 1)
    assert.equal(focusedState.body.notices[0].sessionId, 's-running')
    assert.equal(focusedState.body.notices[0].kind, 'completed')
    assert.equal(focusedState.body.notices[0].title, '跑测试')
    assert.equal(focusedState.body.notices[0].workspaceTitle, 'example-app')
    // 快照里还写着 running → 仍按运行中显示，不重复加临时行
    assert.equal(focusedState.body.sessions.find((session) => session.id === 's-running').status, 'running')
    assert.equal(focusedState.body.sessions.find((session) => session.id === 's-running').transient, undefined)

    // 客户端丢掉该行（已读、非空闲）→ 出现 transient 已完成行，计入 counts
    const dropped = {
      version: 1,
      sentAt: Date.now(),
      sessions: snapshot.sessions.filter((entry) => entry.id !== 's-running'),
      focused: snapshot.focused,
    }
    await jsonRequest(`${base}/dsh-status/client/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(dropped),
    })
    const transientState = await jsonRequest(`${base}/dsh-status/state`, { headers: auth })
    const transientRow = transientState.body.sessions.find((session) => session.id === 's-running')
    assert.equal(transientRow.status, 'completed')
    assert.equal(transientRow.transient, true)
    assert.equal(transientRow.title, '跑测试')
    assert.deepEqual(transientState.body.counts, { waiting: 1, running: 0, completed: 1, stopped: 1, attention: 3 })

    // App 点「忽略」→ 临时行消失
    const dismiss = await jsonRequest(`${base}/dsh-status/command`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'dismiss', sessionId: 's-running' }),
    })
    assert.equal(dismiss.status, 200)
    const dismissed = await jsonRequest(`${base}/dsh-status/state`, { headers: auth })
    assert.equal(dismissed.body.sessions.some((session) => session.id === 's-running'), false)
    assert.deepEqual(dismissed.body.counts, { waiting: 1, running: 0, completed: 0, stopped: 1, attention: 2 })

    // 「全部忽略」：不带 sessionId 的 dismiss 清掉所有临时行
    fake.ctx.emit('session/event', { id: 's-running' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await jsonRequest(`${base}/dsh-status/client/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(dropped),
    })
    assert.equal((await jsonRequest(`${base}/dsh-status/state`, { headers: auth }))
      .body.sessions.find((session) => session.id === 's-running').transient, true)
    const dismissAll = await jsonRequest(`${base}/dsh-status/command`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'dismiss' }),
    })
    assert.equal(dismissAll.status, 200)
    assert.equal((await jsonRequest(`${base}/dsh-status/state`, { headers: auth }))
      .body.sessions.some((session) => session.id === 's-running'), false)

    // 会话重新开跑（新快照，sentAt 晚于 turn/end）→ 临时行同样消失
    fake.ctx.emit('session/event', { id: 's-running' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await jsonRequest(`${base}/dsh-status/client/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(dropped),
    })
    const again = await jsonRequest(`${base}/dsh-status/state`, { headers: auth })
    assert.equal(again.body.sessions.find((session) => session.id === 's-running').transient, true)
    await jsonRequest(`${base}/dsh-status/client/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...snapshot, sentAt: Date.now() }),
    })
    const restarted = await jsonRequest(`${base}/dsh-status/state`, { headers: auth })
    assert.equal(restarted.body.sessions.find((session) => session.id === 's-running').status, 'running')
    assert.equal(restarted.body.sessions.find((session) => session.id === 's-running').transient, undefined)

    // 焦点会话被用户按停止：不补 notice，也不留临时「已停止」行
    const noticesBeforeUserStop = (await jsonRequest(`${base}/dsh-status/state`, { headers: auth })).body.notices.length
    fake.ctx.emit('session/event', { id: 's-running' }, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    const userStoppedState = await jsonRequest(`${base}/dsh-status/state`, { headers: auth })
    assert.equal(userStoppedState.body.notices.length, noticesBeforeUserStop)
    assert.equal(userStoppedState.body.notices.some((notice) => notice.sessionId === 's-running' && notice.kind === 'stopped'), false)
    assert.equal(userStoppedState.body.sessions.find((session) => session.id === 's-running').lastTurn.cancel, 'user')
    // 客户端随后丢掉该行 → 不应再补 transient 行，counts 只保留出错停止的那一条
    await jsonRequest(`${base}/dsh-status/client/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(dropped),
    })
    const afterUserStop = await jsonRequest(`${base}/dsh-status/state`, { headers: auth })
    assert.equal(afterUserStop.body.sessions.some((session) => session.id === 's-running'), false)
    assert.deepEqual(afterUserStop.body.counts, { waiting: 1, running: 0, completed: 0, stopped: 1, attention: 2 })

    // 非焦点会话不补 notice（它走 completionUnread → completed 行）
    const beforeUnread = (await jsonRequest(`${base}/dsh-status/state`, { headers: auth })).body.notices.length
    fake.ctx.emit('session/event', { id: 's-unread' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    const noExtra = await jsonRequest(`${base}/dsh-status/state`, { headers: auth })
    assert.equal(noExtra.body.notices.length, beforeUnread)
    assert.equal(noExtra.body.sessions.find((session) => session.id === 's-unread').status, 'completed')

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

test('Host 桥：临时「已完成」行的竞态与清理', async () => {
  const { root, fake, base, auth } = await setup()
  const post = (body) => jsonRequest(`${base}/dsh-status/client/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const getState = async () => (await jsonRequest(`${base}/dsh-status/state`, { headers: auth })).body
  const row = { id: 's-focus', title: '焦点', workspaceId: 'w', workspaceTitle: 'ws', running: true, unread: false, pending: null, updatedAt: 1 }
  const focused = [{ id: 's-focus', title: '焦点', workspaceId: 'w', workspaceTitle: 'ws' }]
  try {
    await post({ version: 1, sentAt: Date.now(), sessions: [row], focused })
    fake.ctx.emit('session/event', { id: 's-focus' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })

    // 在途旧快照（turn/end 之后几十毫秒，但仍写着 running）不能删掉刚补的临时行
    await post({ version: 1, sentAt: Date.now() + 100, sessions: [row], focused })
    // 客户端按预期丢掉该会话 → 出现 transient 已完成行
    await post({ version: 1, sentAt: Date.now() + 200, sessions: [], focused })
    let state = await getState()
    const transientRow = state.sessions.find((session) => session.id === 's-focus')
    assert.equal(transientRow?.transient, true)
    assert.equal(transientRow?.status, 'completed')
    assert.deepEqual(state.counts, { waiting: 0, running: 0, completed: 1, stopped: 0, attention: 1 })

    // 仍在焦点里报 unread（DSH 主视图会立刻清掉的瞬时状态）→ 不能因此删掉临时行
    await post({ version: 1, sentAt: Date.now() + 300, sessions: [{ ...row, running: false, unread: true }], focused })
    state = await getState()
    assert.equal(state.sessions.find((session) => session.id === 's-focus')?.status, 'completed')
    // 未读随后被 DSH 清掉（会话再次不可见）→ 临时行仍在
    await post({ version: 1, sentAt: Date.now() + 400, sessions: [], focused })
    state = await getState()
    assert.equal(state.sessions.find((session) => session.id === 's-focus')?.transient, true)

    // 3s 之后真的重新开跑 → 临时行让位；再次丢掉会话也不该再冒出来
    await post({ version: 1, sentAt: Date.now() + 5_000, sessions: [row], focused })
    await post({ version: 1, sentAt: Date.now() + 5_200, sessions: [], focused })
    state = await getState()
    assert.equal(state.sessions.some((session) => session.id === 's-focus'), false)
    assert.deepEqual(state.counts, { waiting: 0, running: 0, completed: 0, stopped: 0, attention: 0 })
  } finally {
    await fake.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
