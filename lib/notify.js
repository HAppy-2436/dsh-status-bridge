/**
 * Pure notification planning for the standalone fallback notifier.
 *
 * The menu bar app owns notifications whenever it is connected. This module
 * only decides which session-state transitions deserve a basic banner when no
 * app is listening, so the plugin is still useful on its own.
 */

const NOTIFY_STATUSES = new Set(['waiting', 'completed', 'stopped'])
const MAX_TEXT = 160

/** Collapse whitespace and bound the text that goes into a system banner. */
function clean(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
}

function titleOf(session) {
  return clean(session?.title) || clean(session?.workspaceTitle) || 'DeepSeek Harness'
}

function bodyOf(status, session) {
  if (status === 'waiting') {
    return clean(session?.pending?.summary) || 'A session is waiting for your input.'
  }
  if (status === 'completed') return 'The session finished.'
  return 'The session stopped with an error.'
}

/**
 * Compare the previous observation with the current bridge sessions.
 *
 * @param {Map<string, string>} previous sessionId -> status at the last observation
 * @param {Array<object>} sessions `BridgeState.sessions`
 * @returns {{events: Array<{id: string, status: string, title: string, body: string}>, next: Map<string, string>}}
 */
export function planNotifications(previous, sessions) {
  const before = previous instanceof Map ? previous : new Map()
  const next = new Map()
  const events = []

  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!session || typeof session.id !== 'string' || session.id === '') continue
    const status = typeof session.status === 'string' ? session.status : 'idle'
    next.set(session.id, status)
    if (!NOTIFY_STATUSES.has(status)) continue

    const previousStatus = before.get(session.id)
    if (previousStatus === undefined) continue // first observation: seed only
    if (previousStatus === status) continue

    const becameInteresting =
      status === 'waiting' ||
      (status === 'completed' && (previousStatus === 'running' || previousStatus === 'waiting')) ||
      (status === 'stopped' && (previousStatus === 'running' || previousStatus === 'waiting'))
    if (!becameInteresting) continue

    events.push({
      id: session.id,
      status,
      title: titleOf(session),
      body: bodyOf(status, session),
    })
  }

  return { events, next }
}
