/**
 * 纯函数：ClientSnapshot + turn/end 结果 → BridgeState。
 * 供 Host 桥与 node --test 共用（无 DSH 依赖）。
 */

export const STATUS_PRIORITY = { waiting: 0, running: 1, completed: 2, stopped: 3 }

const STOPPED_TURN_KINDS = new Set(['aborted', 'error', 'blocked'])

/** 根据 Client 快照条目与最近一次 turn 结束原因推导状态。 */
export function statusOf(entry, lastTurn) {
  if (!entry) return 'idle'
  if (entry.pending) return 'waiting'
  if (entry.running) return 'running'
  if (entry.unread) {
    const kind = lastTurn?.kind
    return STOPPED_TURN_KINDS.has(kind) ? 'stopped' : 'completed'
  }
  return 'idle'
}

/** 把 pendingInteraction 归一化为 { kind, summary }，未知形状也能给出兜底文案。 */
export function summarizePending(pending) {
  if (!pending || typeof pending !== 'object') return null
  const kind = typeof pending.kind === 'string' ? pending.kind : 'other'
  let summary = typeof pending.summary === 'string' ? pending.summary : null
  if (!summary && Array.isArray(pending.questions) && pending.questions.length > 0) {
    const question = pending.questions[0]
    const candidates = [question?.title, question?.question, question?.detail, question?.label]
    summary = candidates.find((value) => typeof value === 'string' && value.trim() !== '') ?? null
  }
  if (!summary) {
    const candidates = [pending.title, pending.reason, pending.displayReason, pending.message, pending.tool, pending.description]
    summary = candidates.find((value) => typeof value === 'string' && value.trim() !== '') ?? null
  }
  return { kind, summary: summary ?? null }
}

/** 空状态（未连接 / 无 Client 快照）。 */
export function emptyBridgeState({ now = Date.now(), dsh = {} } = {}) {
  return {
    version: 1,
    generatedAt: now,
    dsh,
    client: { connected: false, lastPushAt: null },
    counts: { waiting: 0, running: 0, completed: 0, stopped: 0, attention: 0 },
    sessions: [],
    subagents: [],
  }
}

/**
 * 合并 Client 快照与 Host 侧 turn/end 信息。
 * @param {object} options
 * @param {object|null} options.snapshot ClientSnapshot
 * @param {Map<string, {kind: string, at: number}>} options.lastTurn
 * @param {Map<string, {status: string, since: number}>} options.sinceCache 会被原地更新
 * @param {object} [options.dsh]
 * @param {boolean} [options.connected]
 * @param {number|null} [options.lastPushAt]
 * @param {number} [options.now]
 */
export function buildBridgeState({
  snapshot = null,
  lastTurn = new Map(),
  sinceCache = new Map(),
  dsh = {},
  connected = Boolean(snapshot),
  lastPushAt = null,
  now = Date.now(),
} = {}) {
  const sections = []
  const input = Array.isArray(snapshot?.sessions) ? snapshot.sessions : []
  for (const entry of input) {
    if (!entry || typeof entry.id !== 'string' || entry.id === '') continue
    const status = statusOf(entry, lastTurn.get(entry.id))
    if (status === 'idle') continue
    const previous = sinceCache.get(entry.id)
    let since
    if (previous && previous.status === status) {
      since = previous.since
    } else {
      since = now
      sinceCache.set(entry.id, { status, since })
    }
    sections.push({
      id: entry.id,
      title: typeof entry.title === 'string' ? entry.title : '',
      workspaceId: typeof entry.workspaceId === 'string' ? entry.workspaceId : null,
      workspaceTitle: typeof entry.workspaceTitle === 'string' ? entry.workspaceTitle : null,
      status,
      pending: status === 'waiting' ? summarizePending(entry.pending) : null,
      lastTurn: lastTurn.get(entry.id) ?? null,
      since,
      updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : now,
    })
  }

  sections.sort((left, right) => {
    const priority = (STATUS_PRIORITY[left.status] ?? 9) - (STATUS_PRIORITY[right.status] ?? 9)
    if (priority !== 0) return priority
    return (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
  })

  // 子智能体：只用于面板展示，不计入 counts / 图标 / 通知
  const subagentInput = Array.isArray(snapshot?.subagents) ? snapshot.subagents : []
  const subagents = []
  for (const entry of subagentInput) {
    if (!entry || typeof entry.id !== 'string' || entry.id === '') continue
    const status = statusOf(entry, lastTurn.get(entry.id))
    if (status === 'idle') continue
    subagents.push({
      id: entry.id,
      parentId: typeof entry.parentId === 'string' ? entry.parentId : null,
      title: typeof entry.title === 'string' ? entry.title : '',
      status,
      pending: status === 'waiting' ? summarizePending(entry.pending) : null,
      updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : now,
    })
  }
  subagents.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))

  const liveIds = new Set(sections.map((session) => session.id))
  for (const id of sinceCache.keys()) {
    if (!liveIds.has(id)) sinceCache.delete(id)
  }

  const counts = { waiting: 0, running: 0, completed: 0, stopped: 0, attention: 0 }
  for (const session of sections) counts[session.status] += 1
  counts.attention = counts.waiting + counts.completed + counts.stopped

  return {
    version: 1,
    generatedAt: now,
    dsh,
    client: { connected, lastPushAt },
    counts,
    sessions: sections,
    subagents,
  }
}

/** 宽松校验 ClientSnapshot，返回规范化后的对象；非法输入返回 null。 */
export function normalizeClientSnapshot(input, now = Date.now()) {
  if (!input || typeof input !== 'object') return null
  const sessions = Array.isArray(input.sessions) ? input.sessions : []
  const normalized = []
  const seen = new Set()
  for (const entry of sessions.slice(0, 200)) {
    if (!entry || typeof entry.id !== 'string' || entry.id === '' || seen.has(entry.id)) continue
    seen.add(entry.id)
    normalized.push({
      id: entry.id,
      title: typeof entry.title === 'string' ? entry.title : '',
      workspaceId: typeof entry.workspaceId === 'string' ? entry.workspaceId : null,
      workspaceTitle: typeof entry.workspaceTitle === 'string' ? entry.workspaceTitle : null,
      running: entry.running === true,
      unread: entry.unread === true,
      pending: entry.pending && typeof entry.pending === 'object' ? entry.pending : null,
      updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : now,
    })
  }
  const subagents = []
  if (Array.isArray(input.subagents)) {
    const seenSub = new Set()
    for (const entry of input.subagents.slice(0, 200)) {
      if (!entry || typeof entry.id !== 'string' || entry.id === '' || seenSub.has(entry.id)) continue
      seenSub.add(entry.id)
      subagents.push({
        id: entry.id,
        parentId: typeof entry.parentId === 'string' ? entry.parentId : null,
        title: typeof entry.title === 'string' ? entry.title : '',
        running: entry.running === true,
        unread: entry.unread === true,
        pending: entry.pending && typeof entry.pending === 'object' ? entry.pending : null,
        updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : now,
      })
    }
  }
  return { version: 1, sentAt: typeof input.sentAt === 'number' ? input.sentAt : now, sessions: normalized, subagents }
}
