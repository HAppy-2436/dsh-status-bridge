import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  abortCauseOf,
  buildBridgeState,
  createNotice,
  emptyBridgeState,
  normalizeClientSnapshot,
  NOTICE_LIMIT,
  NOTICE_TTL_MS,
  noticeStatusFor,
  pruneNotices,
  statusOf,
  summarizePending,
} from '../lib/aggregate.js'

test('statusOf：优先级与 turn 结果', () => {
  assert.equal(statusOf({ pending: { kind: 'question' }, running: true }, null), 'waiting')
  assert.equal(statusOf({ running: true }, null), 'running')
  assert.equal(statusOf({ unread: true }, { kind: 'aborted' }), 'stopped')
  assert.equal(statusOf({ unread: true }, { kind: 'aborted', cancel: 'user' }), 'idle')
  assert.equal(statusOf({ unread: true }, { kind: 'aborted', cancel: 'parent' }), 'stopped')
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

test('buildBridgeState：用户主动停止不进面板 / counts', () => {
  const snapshot = {
    version: 1,
    sessions: [
      { id: 'user-stop', title: '主动停', running: false, unread: true, pending: null, updatedAt: 1 },
      { id: 'error-stop', title: '出错停', running: false, unread: true, pending: null, updatedAt: 2 },
    ],
  }
  const lastTurn = new Map([
    ['user-stop', { kind: 'aborted', cancel: 'user', at: 1 }],
    ['error-stop', { kind: 'error', at: 2 }],
  ])
  const state = buildBridgeState({ snapshot, lastTurn, now: 10 })
  assert.deepEqual(state.sessions.map((session) => session.id), ['error-stop'])
  assert.deepEqual(state.sessions[0].lastTurn, { kind: 'error', at: 2 })
  assert.deepEqual(state.counts, { waiting: 0, running: 0, completed: 0, stopped: 1, attention: 1 })
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

test('abortCauseOf：区分主动停止与其它打断来源', () => {
  assert.equal(abortCauseOf({ kind: 'aborted', reason: { kind: 'user' } }), 'user')
  assert.equal(abortCauseOf({ kind: 'aborted', reason: { kind: 'parent' } }), 'parent')
  assert.equal(abortCauseOf({ kind: 'aborted', reason: { kind: 'hook', reason: 'x' } }), 'hook')
  assert.equal(abortCauseOf({ kind: 'aborted', reason: { kind: 'disposed' } }), 'disposed')
  assert.equal(abortCauseOf({ kind: 'aborted', reason: { kind: 'legacy' } }), 'legacy')
  assert.equal(abortCauseOf({ kind: 'aborted' }), null, '旧记录没有取消来源')
  assert.equal(abortCauseOf({ kind: 'aborted', reason: { kind: 'future' } }), null)
  assert.equal(abortCauseOf({ kind: 'error', reason: { kind: 'user' } }), null, 'error 没有 cancel')
  assert.equal(abortCauseOf({ kind: 'completed' }), null)
  assert.equal(abortCauseOf(undefined), null)
})

test('notices：turn/end 原因映射与一次性通知生成', () => {
  assert.equal(noticeStatusFor('completed'), 'completed')
  assert.equal(noticeStatusFor('max-tokens'), 'completed')
  assert.equal(noticeStatusFor('aborted'), 'stopped')
  assert.equal(noticeStatusFor('error'), 'stopped')
  assert.equal(noticeStatusFor('blocked'), 'stopped')
  assert.equal(noticeStatusFor(undefined), 'completed')

  const notice = createNotice({ sessionId: 's1', kind: 'aborted', at: 1_000, title: '跑测试' })
  assert.deepEqual(notice, {
    id: 's1:1000', sessionId: 's1', kind: 'stopped',
    title: '跑测试', workspaceId: null, workspaceTitle: null, at: 1_000,
  })
  assert.equal(createNotice({ sessionId: 's2', kind: 'completed', at: 5 }).title, '')

  const userStopped = createNotice({ sessionId: 's3', kind: 'aborted', cancel: 'user', at: 7 })
  assert.equal(userStopped.kind, 'stopped')
  assert.equal(userStopped.cancel, 'user')
  assert.equal(createNotice({ sessionId: 's4', kind: 'error', cancel: 'user', at: 8 }).cancel, undefined)
})

test('pruneNotices：过期 / 重复 / 排序 / 截断', () => {
  const now = 1_000_000
  const kept = pruneNotices([
    { id: 'old', sessionId: 's-old', kind: 'completed', at: now - NOTICE_TTL_MS - 1 },
    { id: 'fresh', sessionId: 's1', kind: 'completed', at: now - 1_000 },
    { id: 'fresh', sessionId: 's1', kind: 'stopped', at: now - 1_000 },
    { id: 'user-stop', sessionId: 's2', kind: 'stopped', cancel: 'user', at: now - 2_000 },
    { sessionId: 's2', kind: 'weird', at: now - 5_000 },
    { sessionId: '', kind: 'completed', at: now },
    { sessionId: 's3', kind: 'completed', at: 'bad' },
    null,
  ], { now })
  assert.deepEqual(kept.map((notice) => notice.id), ['fresh', 'user-stop', 's2:995000'])
  assert.equal(kept[0].kind, 'completed')
  assert.equal(kept[1].cancel, 'user', '主动停止的取消来源被保留')
  assert.equal(kept[2].kind, 'completed', '未知 kind 归为 completed')
  assert.equal(kept[2].cancel, undefined)

  const many = Array.from({ length: NOTICE_LIMIT + 5 }, (_, index) => ({
    id: `n${index}`, sessionId: `s${index}`, kind: 'completed', at: now - index,
  }))
  const limited = pruneNotices(many, { now })
  assert.equal(limited.length, NOTICE_LIMIT)
  assert.equal(limited[0].id, 'n0', '最新的在前')
  assert.equal(limited.at(-1).id, `n${NOTICE_LIMIT - 1}`)
  assert.deepEqual(pruneNotices(null), [])
})

test('buildBridgeState：notices 透传但不参与 counts / 状态行', () => {
  const snapshot = {
    version: 1,
    sessions: [
      { id: 's1', title: '跑', running: true, unread: false, pending: null, updatedAt: 1 },
    ],
    focused: [{ id: 's1', title: '跑', workspaceId: 'w', workspaceTitle: 'example-app' }],
  }
  const notices = [createNotice({ sessionId: 's1', kind: 'completed', at: 999, title: '跑' })]
  const state = buildBridgeState({ snapshot, notices, now: 1_000 })
  assert.equal(state.sessions.length, 1)
  assert.deepEqual(state.counts, { waiting: 0, running: 1, completed: 0, stopped: 0, attention: 0 })
  assert.equal(state.notices.length, 1)
  assert.equal(state.notices[0].sessionId, 's1')
  assert.equal(state.notices[0].kind, 'completed')

  // 过期通知不再下发
  const stale = buildBridgeState({ snapshot, notices, now: 999 + NOTICE_TTL_MS + 1 })
  assert.deepEqual(stale.notices, [])

  // 未连接的空状态也带 notices 字段（App 侧可选解码）
  assert.deepEqual(emptyBridgeState({ now: 1 }).notices, [])
})

test('normalizeClientSnapshot：focused 焦点会话列表', () => {
  const snapshot = normalizeClientSnapshot({
    sessions: [],
    focused: [
      { id: 'f1', title: '跑测试', workspaceId: 'w1', workspaceTitle: 'example-app' },
      { id: 'f1', title: '重复' },
      { id: '' },
      { title: '缺 id' },
      { id: 'f2', title: 9, workspaceTitle: null },
    ],
  })
  assert.deepEqual(snapshot.focused, [
    { id: 'f1', title: '跑测试', workspaceId: 'w1', workspaceTitle: 'example-app' },
    { id: 'f2', title: '', workspaceId: null, workspaceTitle: null },
  ])
  assert.deepEqual(normalizeClientSnapshot({}).focused, [])
})

test('buildBridgeState：焦点会话的临时「已完成」行', () => {
  const snapshot = {
    version: 1,
    sessions: [
      { id: 's1', title: '还在跑', running: true, unread: false, pending: null, updatedAt: 1 },
    ],
  }
  const transientSessions = [
    { id: 's1', kind: 'completed', at: 900, title: '还在跑' },   // 快照里还有 → 不重复加行
    { id: 's2', kind: 'stopped', at: 950, title: '停', workspaceId: 'w', workspaceTitle: 'example-app' },
  ]
  const lastTurn = new Map([['s2', { kind: 'aborted', at: 950 }]])
  const state = buildBridgeState({ snapshot, transientSessions, lastTurn, now: 1_000 })

  assert.equal(state.sessions.length, 2)
  const s2 = state.sessions.find((session) => session.id === 's2')
  assert.equal(s2.status, 'stopped')
  assert.equal(s2.transient, true)
  assert.equal(s2.title, '停')
  assert.equal(s2.workspaceTitle, 'example-app')
  assert.equal(s2.since, 950)
  assert.deepEqual(state.counts, { waiting: 0, running: 1, completed: 0, stopped: 1, attention: 1 })

  // 真实行归一化后没有 transient 标记
  assert.equal(state.sessions.find((session) => session.id === 's1').transient, undefined)

  // completed 临时行
  const completed = buildBridgeState({
    snapshot: { version: 1, sessions: [] },
    transientSessions: [{ id: 's3', kind: 'completed', at: 1_000 }],
    now: 1_000,
  })
  assert.equal(completed.sessions[0].status, 'completed')
  assert.equal(completed.sessions[0].transient, true)
  assert.deepEqual(completed.counts, { waiting: 0, running: 0, completed: 1, stopped: 0, attention: 1 })
})
