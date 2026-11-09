import { test } from 'node:test'
import assert from 'node:assert/strict'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('Client 半：聚合快照 + 过滤 + 长轮询跳转', async () => {
  const captured = {}
  globalThis.window = {
    __ModuleLoader__: {
      load(module) { captured.module = module },
    },
  }

  const originalFetch = globalThis.fetch
  const requests = { states: [], commands: 0, opened: [] }

  globalThis.fetch = async (url, options = {}) => {
    const target = String(url)
    if (target.endsWith('/client/state')) {
      requests.states.push(JSON.parse(options.body))
      return new Response(null, { status: 204 })
    }
    if (target.endsWith('/client/commands')) {
      requests.commands += 1
      if (requests.commands === 1) {
        return Response.json({ commands: [{ type: 'openSession', sessionId: 'session-2' }] })
      }
      return new Promise(() => {}) // 挂起，模拟下一次长轮询
    }
    throw new Error(`unexpected fetch: ${target}`)
  }

  try {
    await import('../client.js')
    assert.equal(captured.module.id, 'dsh-status-bridge')
    const module = captured.module.factory()

    const sessionStatus = new Map([
      ['session-1', { running: false, completionUnread: false, pendingInteraction: { kind: 'question', questions: [{ title: '示例问题' }] } }],
      ['session-2', { running: true, completionUnread: false, pendingInteraction: null }],
      ['session-3', { running: false, completionUnread: true, pendingInteraction: null }],
      ['session-4', { running: false, completionUnread: false, pendingInteraction: null }],
      ['session-5', { running: true, completionUnread: false, pendingInteraction: null }],
      ['session-6', { running: false, completionUnread: true, pendingInteraction: null }],
    ])
    const sessionItems = [
      { sessionId: 'session-1', title: '示例问题', cwd: '/Users/x/example-app', updatedAt: 10 },
      { sessionId: 'session-2', title: '', cwd: '/Users/x/dsh-status', updatedAt: 20 },
      { sessionId: 'session-3', title: '写协议', cwd: '/Users/x/dsh-status', updatedAt: 30 },
      { sessionId: 'session-4', title: '空闲会话', cwd: '/Users/x/example-lab', updatedAt: 40 },
      { sessionId: 'session-5', title: '空白会话', cwd: '/Users/x/example-lab', updatedAt: 50, blank: true },
      { sessionId: 'session-6', title: '子会话', cwd: '/Users/x/dsh-status', updatedAt: 60, parentSessionId: 'session-2' },
    ]
    const workspaceItems = [
      { workspaceId: 'w-example-app', title: 'example-app', sessionIds: ['session-1'] },
      { workspaceId: 'w-dsh', title: 'dsh-status', sessionIds: ['session-2', 'session-3', 'session-5', 'session-6'] },
      { workspaceId: 'w-example-lab', title: 'example-lab', sessionIds: ['session-4'] },
    ]

    const cleanups = []
    const titleRefreshes = []
    const ctx = {
      uiSession: { sessionStatus: { getSnapshot: () => sessionStatus, subscribe: () => () => {} } },
      sessions: {
        list: { getSnapshot: () => ({ items: sessionItems }), subscribe: () => () => {} },
        refreshProjections: (sessionId) => { titleRefreshes.push(sessionId) },
      },
      workspaces: { list: { getSnapshot: () => ({ items: workspaceItems, archivedSessionIds: [] }), subscribe: () => () => {} } },
      uiWorkspace: { openSession: (sessionId) => requests.opened.push(sessionId) },
      effect(fn) { const dispose = fn(); if (typeof dispose === 'function') cleanups.push(dispose) },
    }

    module.apply(ctx)
    await delay(30)

    assert.ok(requests.states.length >= 1, '应至少推送一次快照')
    const snapshot = requests.states[requests.states.length - 1]
    const byId = new Map(snapshot.sessions.map((entry) => [entry.id, entry]))

    // 非空闲才上报；空白、子会话、空闲被过滤
    assert.equal(snapshot.sessions.length, 3)
    assert.equal(byId.has('session-4'), false)
    assert.equal(byId.has('session-5'), false)
    assert.equal(byId.has('session-6'), false)

    assert.equal(byId.get('session-1').running, false)
    assert.equal(byId.get('session-1').unread, false)
    assert.deepEqual(byId.get('session-1').pending, { kind: 'question', summary: '示例问题' })
    assert.equal(byId.get('session-1').workspaceId, 'w-example-app')
    assert.equal(byId.get('session-1').workspaceTitle, 'example-app')

    assert.equal(byId.get('session-2').running, true)
    assert.equal(byId.get('session-2').workspaceTitle, 'dsh-status')

    assert.equal(byId.get('session-3').unread, true)

    // 缺标题时主动拉取投影
    assert.ok(titleRefreshes.includes('session-2'), '缺标题的会话应请求 refreshProjections')

    // 长轮询收到的 openSession 已执行
    assert.deepEqual(requests.opened, ['session-2'])
    assert.ok(requests.commands >= 1)

    for (const dispose of cleanups.reverse()) {
      try { await dispose() } catch {}
    }
  } finally {
    globalThis.fetch = originalFetch
    delete globalThis.window
  }
})
