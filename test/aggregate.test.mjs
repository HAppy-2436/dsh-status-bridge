import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildBridgeState,
  emptyBridgeState,
  normalizeClientSnapshot,
  statusOf,
  summarizePending,
} from '../lib/aggregate.js'

test('statusOf：优先级与 turn 结果', () => {
  assert.equal(statusOf({ pending: { kind: 'question' }, running: true }, null), 'waiting')
  assert.equal(statusOf({ running: true }, null), 'running')
  assert.equal(statusOf({ unread: true }, { kind: 'aborted' }), 'stopped')
  assert.equal(statusOf({ unread: true }, { kind: 'error' }), 'stopped')
  assert.equal(statusOf({ unread: true }, { kind: 'blocked' }), 'stopped')
  assert.equal(statusOf({ unread: true }, { kind: 'completed' }), 'completed')
  assert.equal(statusOf({ unread: true }, null), 'completed')
  assert.equal(statusOf({}, null), 'idle')
  assert.equal(statusOf(null, null), 'idle')
})

test('summarizePending：问题 / 计划审阅 / 审批 / 未知形状', () => {
  assert.deepEqual(
    summarizePending({ kind: 'question', questions: [{ title: '示例问题' }] }),
    { kind: 'question', summary: '示例问题' }
  )
  assert.deepEqual(
    summarizePending({ kind: 'plan-review', questions: [{ detail: '计划：先做 A 再做 B' }] }),
    { kind: 'plan-review', summary: '计划：先做 A 再做 B' }
  )
  assert.deepEqual(
    summarizePending({ kind: 'approval', reason: '执行 rm -rf 需要确认' }),
    { kind: 'approval', summary: '执行 rm -rf 需要确认' }
  )
  assert.deepEqual(summarizePending({ kind: 'other' }), { kind: 'other', summary: null })
  assert.equal(summarizePending(null), null)
})

test('buildBridgeState：合并、排序、计数与 since 稳定', () => {
  const snapshot = {
    version: 1,
    sessions: [
      { id: 's1', title: '空', running: false, unread: false, pending: null, updatedAt: 1 },
      { id: 's2', title: '跑', workspaceId: 'w', workspaceTitle: 'example-app', running: true, unread: false, pending: null, updatedAt: 20 },
      { id: 's3', title: '问', workspaceId: 'w', workspaceTitle: 'example-app', running: false, unread: false, pending: { kind: 'question', questions: [{ title: '选哪个？' }] }, updatedAt: 30 },
      { id: 's4', title: '完', running: false, unread: true, pending: null, updatedAt: 40 },
      { id: 's5', title: '停', running: false, unread: true, pending: null, updatedAt: 50 },
    ],
  }
  const lastTurn = new Map([['s5', { kind: 'aborted', at: 99 }]])
  const sinceCache = new Map()
  const now = 1_000
  const state = buildBridgeState({ snapshot, lastTurn, sinceCache, dsh: { pid: 1 }, now })

  assert.equal(state.sessions.length, 4)
  assert.deepEqual(state.sessions.map((session) => session.status), ['waiting', 'running', 'completed', 'stopped'])
  assert.deepEqual(state.counts, { waiting: 1, running: 1, completed: 1, stopped: 1, attention: 3 })
  assert.deepEqual(state.sessions[0].pending, { kind: 'question', summary: '选哪个？' })
  assert.equal(state.client.connected, true)
  assert.equal(sinceCache.get('s3').since, now)

  // 状态未变时 since 保持
  const state2 = buildBridgeState({ snapshot, lastTurn, sinceCache, now: now + 5_000 })
  assert.equal(state2.sessions.find((session) => session.id === 's3').since, now)

  // 状态变化时 since 更新
  const runningSnapshot = {
    version: 1,
    sessions: snapshot.sessions.map((entry) => (entry.id === 's2' ? { ...entry, running: false, unread: true } : entry)),
  }
  const state3 = buildBridgeState({ snapshot: runningSnapshot, lastTurn, sinceCache, now: now + 9_000 })
  assert.equal(state3.sessions.find((session) => session.id === 's2').since, now + 9_000)
  assert.equal(state3.sessions.find((session) => session.id === 's2').status, 'completed')
})

test('emptyBridgeState：未连接空状态', () => {
  const state = emptyBridgeState({ now: 1, dsh: { pid: 2 } })
  assert.deepEqual(state.counts, { waiting: 0, running: 0, completed: 0, stopped: 0, attention: 0 })
  assert.equal(state.client.connected, false)
  assert.deepEqual(state.sessions, [])
})

test('normalizeClientSnapshot：校验、去重、截断、兜底', () => {
  assert.equal(normalizeClientSnapshot(null), null)
  const empty = normalizeClientSnapshot({})
  assert.equal(empty.sessions.length, 0)

  const snapshot = normalizeClientSnapshot({
    sessions: [
      { id: 'a', running: 'yes', unread: 1, pending: null, updatedAt: 'bad' },
      { id: 'a', running: true },
      { id: '', running: true },
      { id: 'b', title: 3, workspaceId: 7, running: true, unread: false, pending: { kind: 'question' } },
    ],
  }, 123)

  assert.equal(snapshot.sessions.length, 2)
  assert.deepEqual(snapshot.sessions[0], {
    id: 'a', title: '', workspaceId: null, workspaceTitle: null,
    running: false, unread: false, pending: null, updatedAt: 123,
  })
  assert.equal(snapshot.sessions[1].title, '')
  assert.equal(snapshot.sessions[1].workspaceId, null)
  assert.equal(snapshot.sessions[1].running, true)
  assert.deepEqual(snapshot.sessions[1].pending, { kind: 'question' })
})
