import assert from 'node:assert/strict'
import test from 'node:test'
import { planNotifications } from '../lib/notify.js'

const session = (overrides = {}) => ({
  id: 's1',
  title: 'Fix the login flow',
  workspaceTitle: 'app',
  status: 'running',
  pending: null,
  ...overrides,
})

test('first observation only seeds the state', () => {
  const { events, next } = planNotifications(new Map(), [session()])
  assert.deepEqual(events, [])
  assert.equal(next.get('s1'), 'running')
})

test('running -> completed produces one notification', () => {
  const previous = new Map([['s1', 'running']])
  const { events, next } = planNotifications(previous, [session({ status: 'completed' })])
  assert.equal(events.length, 1)
  assert.deepEqual(events[0], {
    id: 's1',
    status: 'completed',
    title: 'Fix the login flow',
    body: 'The session finished.',
  })
  assert.equal(next.get('s1'), 'completed')
})

test('running -> waiting includes the pending summary', () => {
  const previous = new Map([['s1', 'running']])
  const { events } = planNotifications(previous, [
    session({ status: 'waiting', pending: { kind: 'approval', summary: 'Allow the shell command?' } }),
  ])
  assert.equal(events.length, 1)
  assert.equal(events[0].status, 'waiting')
  assert.equal(events[0].body, 'Allow the shell command?')
})

test('waiting stays quiet while the state does not change', () => {
  const previous = new Map([['s1', 'waiting']])
  const { events, next } = planNotifications(previous, [
    session({ status: 'waiting', pending: { kind: 'question', summary: 'Which branch?' } }),
  ])
  assert.deepEqual(events, [])
  assert.equal(next.get('s1'), 'waiting')
})

test('waiting -> completed still notifies', () => {
  const previous = new Map([['s1', 'waiting']])
  const { events } = planNotifications(previous, [session({ status: 'completed' })])
  assert.equal(events.length, 1)
  assert.equal(events[0].status, 'completed')
})

test('running -> stopped notifies with the error wording', () => {
  const previous = new Map([['s1', 'running']])
  const { events } = planNotifications(previous, [session({ status: 'stopped' })])
  assert.equal(events.length, 1)
  assert.equal(events[0].body, 'The session stopped with an error.')
})

test('completed stays quiet on later snapshots', () => {
  const previous = new Map([['s1', 'completed']])
  const { events } = planNotifications(previous, [session({ status: 'completed' })])
  assert.deepEqual(events, [])
})

test('a session that disappears is forgotten, then seeds again', () => {
  const previous = new Map([['s1', 'running']])
  const disappeared = planNotifications(previous, [])
  assert.deepEqual(disappeared.events, [])
  assert.equal(disappeared.next.has('s1'), false)

  const reappeared = planNotifications(disappeared.next, [session({ status: 'running' })])
  assert.deepEqual(reappeared.events, [])
  assert.equal(reappeared.next.get('s1'), 'running')
})

test('title falls back to the workspace and then to the product name', () => {
  const previous = new Map([['s1', 'running'], ['s2', 'running']])
  const { events } = planNotifications(previous, [
    session({ id: 's1', title: '', workspaceTitle: 'my-app', status: 'completed' }),
    session({ id: 's2', title: '', workspaceTitle: '', status: 'completed' }),
  ])
  assert.equal(events[0].title, 'my-app')
  assert.equal(events[1].title, 'DeepSeek Harness')
})

test('text is collapsed and bounded', () => {
  const previous = new Map([['s1', 'running']])
  const { events } = planNotifications(previous, [
    session({
      status: 'waiting',
      pending: { summary: `  ${'question '.repeat(40)}  ` },
    }),
  ])
  assert.equal(events[0].body.length, 160)
  assert.equal(events[0].body.includes('  '), false)
})

test('a non-Map previous value is tolerated', () => {
  const { events, next } = planNotifications(undefined, [session()])
  assert.deepEqual(events, [])
  assert.equal(next.get('s1'), 'running')
})
