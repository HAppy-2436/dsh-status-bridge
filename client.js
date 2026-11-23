/**
 * DSH Status —— Client 半（在 DSH 渲染进程内运行，无 UI）。
 *
 * 负责：
 *   1. 订阅 ctx.uiSession.sessionStatus / ctx.sessions.list / ctx.workspaces.list
 *      聚合出 ClientSnapshot，事件驱动推给 Host 桥（不依赖 setTimeout，避免窗口隐藏被节流）。
 *   2. 长轮询 /dsh-status/client/commands，收到 openSession 时调用
 *      ctx.uiWorkspace.openSession(sessionId)。
 *
 * 协议见 docs/protocol.md §2/§3.2。
 */
window.__ModuleLoader__.load({
  id: 'dsh-status-bridge',
  factory() {
    const POLL_ERROR_DELAY_MS = 2000
    const RETRY_DELAYS_MS = [1000, 2000, 5000]

    return {
      // DSH 0.2.2-rc.2 起 `uiSession.sessionStatus` 是独立服务：不注入就读取会抛
      // "cannot get property ... without inject"，apply 直接失败 → 一条状态都不上报。
      inject: ['uiSession', 'uiSession.sessionStatus', 'sessions', 'workspaces', 'uiWorkspace'],
      apply(ctx) {
        const runtime = {
          stopped: false,
          dirty: false,
          inFlight: false,
          retryTimer: null,
          retryIndex: 0,
          disposers: [],
        }

        // 标题来自 Session 投影（懒加载）；缺标题时主动拉投影，最多重试 3 次（间隔 5s）。
        const titleRefreshState = new Map()
        const requestTitleRefresh = (sessionId) => {
          const now = Date.now()
          const state = titleRefreshState.get(sessionId) ?? { attempts: 0, lastAt: 0 }
          if (state.attempts >= 3 || now - state.lastAt < 5000) return
          state.attempts += 1
          state.lastAt = now
          titleRefreshState.set(sessionId, state)
          try {
            const pending = ctx.sessions?.refreshProjections?.(sessionId)
            if (pending && typeof pending.catch === 'function') pending.catch(() => {})
          } catch (error) {
            console.warn('[dsh-status] 拉取会话标题失败：', error)
          }
        }

        const scheduleFlush = () => {
          if (runtime.stopped) return
          runtime.dirty = true
          if (runtime.inFlight) return
          queueMicrotask(flush)
        }

        const scheduleRetry = () => {
          if (runtime.stopped || runtime.retryTimer) return
          const delay = RETRY_DELAYS_MS[Math.min(runtime.retryIndex, RETRY_DELAYS_MS.length - 1)]
          runtime.retryIndex += 1
          runtime.retryTimer = setTimeout(() => {
            runtime.retryTimer = null
            runtime.dirty = true
            flush()
          }, delay)
        }

        async function flush() {
          if (runtime.stopped || runtime.inFlight || !runtime.dirty) return
          runtime.dirty = false
          runtime.inFlight = true
          try {
            const snapshot = buildSnapshot(ctx, requestTitleRefresh)
            const response = await fetch('/dsh-status/client/state', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(snapshot),
              cache: 'no-store',
            })
            if (!response.ok) throw new Error(`state push HTTP ${response.status}`)
            runtime.retryIndex = 0
          } catch (error) {
            console.warn('[dsh-status] 状态上报失败：', error)
            runtime.dirty = true
            scheduleRetry()
          } finally {
            runtime.inFlight = false
            if (runtime.dirty && !runtime.stopped) queueMicrotask(flush)
          }
        }

        function executeCommand(command) {
          if (!command || command.type !== 'openSession' || typeof command.sessionId !== 'string') return
          try {
            ctx.uiWorkspace.openSession(command.sessionId)
          } catch (error) {
            console.warn('[dsh-status] 跳转会话失败：', error)
          }
        }

        async function pollCommands() {
          while (!runtime.stopped) {
            try {
              const response = await fetch('/dsh-status/client/commands', { cache: 'no-store' })
              if (!response.ok) throw new Error(`commands HTTP ${response.status}`)
              const data = await response.json()
              for (const command of data?.commands ?? []) executeCommand(command)
            } catch (error) {
              if (runtime.stopped) return
              console.warn('[dsh-status] 命令轮询失败：', error)
              await delay(POLL_ERROR_DELAY_MS)
            }
          }
        }

        // 订阅三份状态；任一变化都合并成一次上报
        const statusStore = ctx.uiSession?.sessionStatus
        if (statusStore?.subscribe) runtime.disposers.push(statusStore.subscribe(scheduleFlush))
        if (ctx.sessions?.list?.subscribe) runtime.disposers.push(ctx.sessions.list.subscribe(scheduleFlush))
        if (ctx.workspaces?.list?.subscribe) runtime.disposers.push(ctx.workspaces.list.subscribe(scheduleFlush))

        ctx.effect(() => () => {
          runtime.stopped = true
          for (const dispose of runtime.disposers) {
            try { dispose() } catch {}
          }
          runtime.disposers = []
          if (runtime.retryTimer) clearTimeout(runtime.retryTimer)
        }, 'dsh-status: client subscriptions')

        scheduleFlush()
        pollCommands()
      },
    }
  },
})

// ---------- 聚合 ----------

function titleOf(item, listSnapshot, sessionId, requestTitleRefresh) {
  const projectionValues = item?.projectionValues
    ?? listSnapshot.projectionsBySession?.[sessionId]?.values
  const rawTitle = typeof item?.title === 'string' && item.title.trim() !== ''
    ? item.title
    : projectionValues?.title
  const title = typeof rawTitle === 'string' ? rawTitle : ''
  if (title.trim() === '') requestTitleRefresh(sessionId)
  return title
}

function buildSnapshot(ctx, requestTitleRefresh = () => {}) {
  const now = Date.now()
  const statusMap = ctx.uiSession?.sessionStatus?.getSnapshot?.()
  const listSnapshot = ctx.sessions?.list?.getSnapshot?.() ?? {}
  const items = Array.isArray(listSnapshot.items)
    ? listSnapshot.items
    : Object.values(listSnapshot.byId ?? {})
  const workspaceSnapshot = ctx.workspaces?.list?.getSnapshot?.() ?? {}
  const workspaces = Array.isArray(workspaceSnapshot.items) ? workspaceSnapshot.items : []
  const archived = new Set(workspaceSnapshot.archivedSessionIds ?? [])

  const sessionWorkspace = new Map()
  const workspaceTitles = new Map()
  for (const workspace of workspaces) {
    const workspaceId = workspace.workspaceId
    if (typeof workspaceId !== 'string') continue
    workspaceTitles.set(workspaceId, typeof workspace.title === 'string' ? workspace.title : '')
    for (const sessionId of workspace.sessionIds ?? []) sessionWorkspace.set(sessionId, workspaceId)
  }

  const bySession = new Map()
  for (const item of items) {
    // Client 列表快照的行用 id；Host 侧摘要用 sessionId —— 两种形状都兼容
    const key = typeof item?.sessionId === 'string'
      ? item.sessionId
      : (typeof item?.id === 'string' ? item.id : null)
    if (key) bySession.set(key, item)
  }

  // 焦点会话（DSH 主视图）：跑完时 completionUnread 不会置位，Host 靠这份信息补一次性通知。
  const focused = []
  for (const item of items) {
    if (focused.length >= 8) break
    const id = typeof item?.sessionId === 'string'
      ? item.sessionId
      : (typeof item?.id === 'string' ? item.id : null)
    if (!id || archived.has(id) || item?.blank === true) continue
    if ((item?.retainedBy?.mainView ?? 0) <= 0) continue
    const workspaceId = sessionWorkspace.get(id) ?? null
    focused.push({
      id,
      title: titleOf(item, listSnapshot, id, requestTitleRefresh),
      workspaceId,
      workspaceTitle: workspaceId
        ? workspaceTitles.get(workspaceId) ?? null
        : folderTitle(item?.cwd),
    })
  }

  const sessions = []
  const subagents = []
  for (const [sessionId, status] of statusMap ?? []) {
    if (!status || archived.has(sessionId)) continue
    const item = bySession.get(sessionId)
    if (item?.blank === true) continue

    // Client 行用 parentId/origin，Host 摘要用 parentSessionId
    const parentId = item?.parentSessionId ?? item?.parentId ?? null
    const isSubagent = item?.origin === 'subagent' || parentId !== null

    const pending = normalizePending(status.pendingInteraction)
    const running = status.running === true
    const unread = status.completionUnread === true
    if (!pending && !running && !unread) continue

    if (isSubagent) {
      // 子智能体：不计入统计/图标/通知，单独给面板展示
      subagents.push({
        id: sessionId,
        parentId,
        title: titleOf(item, listSnapshot, sessionId, requestTitleRefresh),
        running,
        unread,
        pending,
        updatedAt: typeof item?.updatedAt === 'number' ? item.updatedAt : now,
      })
      continue
    }

    const workspaceId = sessionWorkspace.get(sessionId) ?? null
    const workspaceTitle = workspaceId
      ? workspaceTitles.get(workspaceId) ?? null
      : folderTitle(item?.cwd)

    const title = titleOf(item, listSnapshot, sessionId, requestTitleRefresh)

    sessions.push({
      id: sessionId,
      title,
      workspaceId,
      workspaceTitle,
      running,
      unread,
      pending,
      updatedAt: typeof item?.updatedAt === 'number' ? item.updatedAt : now,
    })
  }

  return { version: 1, sentAt: now, sessions, subagents, focused }
}

function normalizePending(pending) {
  if (!pending || typeof pending !== 'object') return null
  const kind = typeof pending.kind === 'string' ? pending.kind : 'other'
  let summary = typeof pending.summary === 'string' ? pending.summary : null

  if (!summary && Array.isArray(pending.questions) && pending.questions.length > 0) {
    const question = pending.questions[0]
    summary = firstNonEmpty([question?.title, question?.question, question?.detail, question?.label])
  }
  if (!summary) {
    summary = firstNonEmpty([
      pending.title,
      pending.reason,
      pending.displayReason,
      pending.message,
      pending.description,
      pending.tool,
    ])
  }
  return { kind, summary: summary ?? null }
}

function firstNonEmpty(candidates) {
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

function folderTitle(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null
  const parts = cwd.split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : null
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
