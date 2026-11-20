/**
 * 纯函数：ClientSnapshot + turn/end 结果 → BridgeState。
 * 供 Host 桥与 node --test 共用（无 DSH 依赖）。
 */

export const STATUS_PRIORITY = { waiting: 0, running: 1, completed: 2, stopped: 3 }

const STOPPED_TURN_KINDS = new Set(['aborted', 'error', 'blocked'])
/** DSH `AgentCancelCause`：`aborted` 回合的取消来源。 */
const CANCEL_CAUSES = new Set(['user', 'parent', 'hook', 'disposed', 'legacy'])

/** 焦点会话（DSH 主视图）跑完只发通知、不产生状态行，见 docs/protocol.md §2「notices」。 */
export const NOTICE_TTL_MS = 120_000
export const NOTICE_LIMIT = 20
export const FOCUS_LIMIT = 8

/** turn/end 原因 → 通知里的状态标签（与 statusOf 对已停止的判定保持一致）。 */
export function noticeStatusFor(turnKind) {
  return STOPPED_TURN_KINDS.has(turnKind) ? 'stopped' : 'completed'
}

/**
 * `turn/end.reason` → 取消来源（仅 `aborted` 有）：`user` 表示用户按了停止，
 * `parent` / `hook` / `disposed` / `legacy` 是其它打断来源。未知原因返回 null。
 * 这个字段用来区分「用户主动停止」和「出错/被系统停止」，App 据此决定要不要提醒。
 */
export function abortCauseOf(turnReason) {
  if (!turnReason || typeof turnReason !== 'object' || turnReason.kind !== 'aborted') return null
  const cause = turnReason.reason
  const kind = cause && typeof cause === 'object' ? cause.kind : null
  return CANCEL_CAUSES.has(kind) ? kind : null
}

function normalizeCancel(cancel) {
  return CANCEL_CAUSES.has(cancel) ? cancel : null
}

/** 生成一条完成通知；`id` 稳定（同一会话同一时刻只发一次），供 App 去重。 */
export function createNotice({
  sessionId,
  kind,
  cancel = null,
  at = Date.now(),
  title = '',
  workspaceId = null,
  workspaceTitle = null,
}) {
  const cause = kind === 'aborted' ? normalizeCancel(cancel) : null
  return {
    id: `${sessionId}:${at}`,
    sessionId,
    kind: noticeStatusFor(kind),
    ...(cause ? { cancel: cause } : {}),
    title: typeof title === 'string' ? title : '',
    workspaceId: typeof workspaceId === 'string' ? workspaceId : null,
    workspaceTitle: typeof workspaceTitle === 'string' ? workspaceTitle : null,
    at,
  }
}

/** 过滤过期/重复的通知并按时间倒序截断（保留最近 `limit` 条）。 */
export function pruneNotices(notices, { now = Date.now(), ttl = NOTICE_TTL_MS, limit = NOTICE_LIMIT } = {}) {
  const input = Array.isArray(notices) ? notices : []
  const seen = new Set()
  const kept = []
  for (const notice of input) {
    if (!notice || typeof notice !== 'object') continue
    if (typeof notice.sessionId !== 'string' || notice.sessionId === '') continue
    if (typeof notice.at !== 'number' || !Number.isFinite(notice.at)) continue
    if (now - notice.at > ttl) continue
    const id = typeof notice.id === 'string' && notice.id !== '' ? notice.id : `${notice.sessionId}:${notice.at}`
    if (seen.has(id)) continue
    seen.add(id)
    const cancel = normalizeCancel(notice.cancel)
    kept.push({
      id,
      sessionId: notice.sessionId,
      kind: notice.kind === 'stopped' ? 'stopped' : 'completed',
      ...(cancel ? { cancel } : {}),
      title: typeof notice.title === 'string' ? notice.title : '',
      workspaceId: typeof notice.workspaceId === 'string' ? notice.workspaceId : null,
      workspaceTitle: typeof notice.workspaceTitle === 'string' ? notice.workspaceTitle : null,
      at: notice.at,
    })
  }
  kept.sort((left, right) => right.at - left.at)
  return kept.slice(0, limit)
}

/** 根据 Client 快照条目与最近一次 turn 结束原因推导状态。 */
export function statusOf(entry, lastTurn) {
  if (!entry) return 'idle'
  if (entry.pending) return 'waiting'
  if (entry.running) return 'running'
  if (entry.unread) {
    const kind = lastTurn?.kind
    // 用户自己按的停止：不产生「已停止」行 / 角标（按下停止时他正看着这个会话）。
    // 这里返回 idle 让 buildBridgeState 丢弃该行，counts / 图标一并归零；
    // error / parent / hook / disposed 等来源仍按 stopped 保留。
    if (kind === 'aborted' && lastTurn?.cancel === 'user') return 'idle'
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
    notices: [],
  }
}

/**
 * 合并 Client 快照与 Host 侧 turn/end 信息。
 * @param {object} options
 * @param {object|null} options.snapshot ClientSnapshot
 * @param {Map<string, {kind: string, cancel?: string, at: number}>} options.lastTurn
 * @param {Map<string, {status: string, since: number}>} options.sinceCache 会被原地更新
 * @param {Array<object>} [options.notices] 焦点会话跑完的一次性通知（已发出，短时保留）
 * @param {Array<object>} [options.transientSessions] 焦点会话刚跑完的临时行（图标/面板用，可被 App 忽略）
 * @param {object} [options.dsh]
 * @param {boolean} [options.connected]
 * @param {number|null} [options.lastPushAt]
 * @param {number} [options.now]
 */
export function buildBridgeState({
  snapshot = null,
  lastTurn = new Map(),
  sinceCache = new Map(),
  notices = [],
  transientSessions = [],
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

  // 焦点会话刚跑完：DSH 认为「已读」，不会产生 completed 行；这里补一条临时行，
  // 让菜单栏图标走「运行中 → 已完成 → 空闲」而不是直接跳空闲。App 点「忽略」会让 Host 删除它。
  const present = new Set(sections.map((session) => session.id))
  for (const entry of Array.isArray(transientSessions) ? transientSessions : []) {
    if (!entry || typeof entry.id !== 'string' || entry.id === '' || present.has(entry.id)) continue
    const kind = entry.kind === 'stopped' ? 'stopped' : 'completed'
    present.add(entry.id)
    sections.push({
      id: entry.id,
      title: typeof entry.title === 'string' ? entry.title : '',
      workspaceId: typeof entry.workspaceId === 'string' ? entry.workspaceId : null,
      workspaceTitle: typeof entry.workspaceTitle === 'string' ? entry.workspaceTitle : null,
      status: kind,
      pending: null,
      lastTurn: lastTurn.get(entry.id) ?? { kind, at: typeof entry.at === 'number' ? entry.at : now },
      since: typeof entry.at === 'number' ? entry.at : now,
      updatedAt: typeof entry.at === 'number' ? entry.at : now,
      transient: true,
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
    notices: pruneNotices(notices, { now }),
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
  // 焦点会话（DSH 主视图）：跑完时 completionUnread 不会置位，Host 需要用这份信息补通知。
  const focused = []
  if (Array.isArray(input.focused)) {
    const seenFocus = new Set()
    for (const entry of input.focused.slice(0, FOCUS_LIMIT)) {
      if (!entry || typeof entry.id !== 'string' || entry.id === '' || seenFocus.has(entry.id)) continue
      seenFocus.add(entry.id)
      focused.push({
        id: entry.id,
        title: typeof entry.title === 'string' ? entry.title : '',
        workspaceId: typeof entry.workspaceId === 'string' ? entry.workspaceId : null,
        workspaceTitle: typeof entry.workspaceTitle === 'string' ? entry.workspaceTitle : null,
      })
    }
  }
  return { version: 1, sentAt: typeof input.sentAt === 'number' ? input.sentAt : now, sessions: normalized, subagents, focused }
}
