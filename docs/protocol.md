# dsh-status-bridge 桥接协议 v1

`dsh-status-bridge` 插件（Host 桥 + Client 状态）与原生菜单栏 App
（[dsh-status](https://github.com/HAppy-2436/dsh-status) 仓库）之间唯一的通信约定。
**实现方（Host / Client / App / mock）必须严格按本文档，任何字段变更先改本文档。**

## 1. 发现与鉴权

Host 插件启动时写 `~/.dsh-status/bridge.json`（权限 0600，原子写入：先写 `.tmp` 再 rename）：

```json
{
  "version": 1,
  "pluginVersion": "0.1.0",
  "port": 49434,
  "origin": "http://127.0.0.1:49434",
  "token": "64 位 hex 随机串",
  "pid": 12345,
  "startedAt": 1762324800000,
  "appPath": "/Applications/DSH Status.app"
}
```

- `version` = bridge.json 格式版本（当前 1）；`pluginVersion` = 插件包版本（新增字段，
  App 忽略未知键，可安全忽略）。
- `port` / `origin` = DSH Host webserver 的监听端口（`ctx.webServer.port` / `getOrigin()`）。
- `appPath` = 实际解析到的菜单栏 App 路径（可选）。解析顺序：
  `config.appPath` → `DSH_STATUS_APP` 环境变量 → `/Applications/DSH Status.app`
  → `~/Applications/DSH Status.app`，取第一个存在的路径；都找不到时省略该字段。
- Native App 每 2s 轮询该文件（文件不存在 = DSH 未运行）；用 `Authorization: Bearer <token>`
  访问下面所有需要鉴权的接口。
- Client 半插件使用**同源相对路径**请求（`/dsh-status/...`），由 Host 用
  `ctx.connection.admit(request)` 校验浏览器身份；不需要 token。
- 鉴权失败返回 `401`；App 收到 401 后重新读取 `bridge.json`（可能已换 token）。

## 2. 数据结构

### BridgeState（Host → App）

```jsonc
{
  "version": 1,
  "generatedAt": 1762324800123,            // ms
  "dsh": { "pid": 12345, "version": "0.2.1-rc.5" },
  "client": { "connected": true, "lastPushAt": 1762324800000 },
  "counts": {
    "waiting": 1,      // 待回答
    "running": 2,      // 运行中
    "completed": 1,    // 已完成（未读）
    "stopped": 0,      // 已停止（未读）
    "attention": 2     // waiting + completed + stopped（菜单栏角标数字）
  },
  "sessions": [ SessionRow, ... ],         // 只含非空闲的**顶层**会话
  "subagents": [ SubagentRow, ... ],       // 子智能体会话：仅用于面板展示，不计入 counts
  "notices": [ SessionNotice, ... ]        // 焦点会话跑完的一次性通知（见下）
}
```

### SessionNotice

焦点会话（DSH 主视图里正在看的那个）跑完时，DSH 不置 `completionUnread`，所以没有
`completed` / `stopped` 行可通知。Host 在收到该会话的 `turn/end` 时补一条 notice，
App 据此弹一次通知；**notice 不产生面板行、不计入 counts / 角标**。

```jsonc
{
  "id": "session-7ca13994-...:1762324800123",  // 稳定唯一，App 按它去重
  "sessionId": "session-7ca13994-...",
  "kind": "completed",                     // completed | stopped（由 turn/end.reason.kind 映射，
                                           // aborted / error / blocked → stopped，其余 → completed）
  "cancel": "user",                        // 可选：aborted 的取消来源，见下
  "title": "示例会话标题",
  "workspaceId": "35084b06-...",
  "workspaceTitle": "example-app",
  "at": 1762324800123                      // ms
}
```

- Host 保留最近 120s、最多 20 条（`NOTICE_TTL_MS` / `NOTICE_LIMIT`），足够 SSE 重连；
- Host 只在「该会话出现在最近一次 Client 快照的 `focused` 里」时生成 notice，避免与普通
  completed 行重复提醒；
- App 首帧只登记不通知（与状态跃迁的「首帧基线不触发」一致），之后按 `id` 去重；
- `cancel == "user"` 表示用户自己按了停止：Host **不生成 notice、临时行或状态行**（连角标也不留；
  他停止时一定正看着这个会话）；`error` / `parent` / `hook` / `disposed` 等来源仍照常提醒。
  该字段主要保留给旧版桥（0.1.5）兼容：App 收到带 `cancel == "user"` 的 notice 会静音；
- 旧版 App 忽略 `notices` / `cancel` 字段；旧版 Host 不下发时 App 按空列表 / 未知来源处理（向后兼容）。

### SubagentRow

```jsonc
{
  "id": "242a87ce-...",
  "parentId": "session-b99ab867-...",       // 所属顶层会话
  "title": "你是 A（设计系统与一级页面）",
  "status": "running",                     // 同 SessionRow.status
  "pending": null,
  "updatedAt": 1762324799000
}
```

> 子智能体不参与 `counts` / 菜单栏图标 / 通知；面板里缩进显示在父会话下方，点击打开父会话。

### SessionRow

```jsonc
{
  "id": "session-7ca13994-...",
  "title": "示例会话标题",                 // 空则用 "未命名会话"
  "workspaceId": "35084b06-...",
  "workspaceTitle": "dsh-status",
  "status": "waiting",                     // waiting | running | completed | stopped
  "pending": null,                         // waiting 时非空
  "lastTurn": { "kind": "aborted", "cancel": "user", "at": 1762324799000 },
  "since": 1762324799000,                  // 进入当前状态的时刻
  "updatedAt": 1762324800000,
  "transient": true                        // 可选：焦点会话跑完的临时「已完成」行
}
```

`transient`：焦点会话跑完时 DSH 视为已读，不会产生 completed 行；Host 补一条临时行，
让 App 的图标/面板走「运行中 → 已完成」而不是直接跳空闲。App 可以
`POST /command {type:"dismiss", sessionId}` 让 Host 删除它；该会话重新运行、进入待回答，
或 Client 自己上报未读时，Host 也会自动删除。临时行只存在于 Host 内存：DSH 重启或桥重载后消失。

`pending`：

```jsonc
{ "kind": "question" | "plan-review" | "approval" | "other", "summary": "示例问题" }
```

`lastTurn.kind` 取值来自 Host 侧 `turn/end.reason.kind`：
`completed` / `aborted` / `error` / `blocked` / `max-tokens`；未知时为 `null`。
`lastTurn.cancel`（可选）只在 `kind == "aborted"` 时出现，取自 `turn/end.reason.reason.kind`，
即 DSH 的 `AgentCancelCause`：`user`（用户按停止）/ `parent` / `hook` / `disposed` / `legacy`
（旧记录没有取消来源）。`cancel == "user"` 且 `unread` 的条目会被 Host 直接丢弃（不进
`sessions` / `counts` / 角标）；error 等其它停止照常显示「已停止」。

### ClientSnapshot（Client → Host）

```jsonc
{
  "version": 1,
  "sentAt": 1762324800000,
  "sessions": [
    {
      "id": "session-...",
      "title": "示例会话标题",
      "workspaceId": "35084b06-...",
      "workspaceTitle": "dsh-status",
      "running": false,
      "unread": true,                      // = completionUnread
      "pending": { "kind": "question", "summary": "示例问题" },  // 或 null
      "updatedAt": 1762324800000
    }
  ],
  "focused": [                             // DSH 主视图里正在看的会话（通常 0～1 条，最多 8 条）
    {
      "id": "session-...",
      "title": "示例会话标题",
      "workspaceId": "35084b06-...",
      "workspaceTitle": "example-app"
    }
  ]
}
```

- Client 只上报 `running || unread || pending` 的会话（非空闲）。
- `focused` 是**全量**的焦点会话（不受上面的过滤影响），Host 用它决定要不要补 notice。
- Host 负责补 `lastTurn`、计算 `status` / `since` / `counts`。

### 状态推导规则（Host 执行，优先级从上到下）

1. `pending != null` → `waiting`
2. `running == true` → `running`
3. `unread == true` 且 `lastTurn.kind ∈ {aborted, error, blocked}` → `stopped`；
   其中 `lastTurn.kind == "aborted"` 且 `lastTurn.cancel == "user"`（用户主动停止）→ 丢弃
4. `unread == true` → `completed`
5. 其他 → 丢弃（空闲，不进 BridgeState）

`since`：Host 缓存每个 session 上一次的 status，变化时记为当前时间（Host 重启后以首次收到的时间为准）。

**焦点会话例外**：`completionUnread` 只在「跑完时不在主视图」才置位，正在看的会话跑完推导为 5
（丢弃）。Host 用 Client 快照里的 `focused` 补一条 `notices`（通知）和一条 `transient` 行
（图标/面板）——都在收到该会话 `turn/end` 时生成。用户自己按停止（`aborted` +
`cancel == "user"`）时**不生成** notice / 临时行，且该会话的 unread 状态行也会被丢弃；出错
（`error`）等其它停止照常生成。旧桥 0.1.5 仍可能发带 `cancel` 的 notice，App 会静音提醒。

## 3. HTTP 接口

前缀固定 `/dsh-status`。所有 JSON 请求/响应 `Content-Type: application/json`。

### 3.1 Native App 接口（Bearer token）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/dsh-status/state` | 返回当前 `BridgeState`（无状态时也返回结构，sessions 为空、client.connected=false） |
| `GET` | `/dsh-status/stream` | SSE 推送：连接后立即发一条 `event: state`，之后每次状态变化发一条；每 5s 发 `: ping` 注释保活 |
| `POST` | `/dsh-status/command` | 请求体 `{ "type": "openSession", "sessionId": "session-..." }`；返回 `{ "ok": true, "requestId": "..." }`；无法入队返回 503/400。`{ "type": "dismiss", "sessionId": "..." }` 删除临时「已完成」行，返回 `{ "ok": true }`；不带 `sessionId` 表示全部忽略（App 右键菜单「全部忽略」） |
| `GET` | `/dsh-status/health` | 无需鉴权，返回 `{ "ok": true, "version": 1 }`，供 App 判断端口存活 |

SSE 示例：

```
event: state
data: {"version":1,"generatedAt":...,"counts":{...},"sessions":[...]}

: ping
```

### 3.2 Client 半接口（同源，`ctx.connection.admit` 校验）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/dsh-status/client/state` | 请求体 `ClientSnapshot`；返回 `204`。Host 合并后广播给 App |
| `GET` | `/dsh-status/client/commands` | 长轮询：有命令立即返回 `{ "commands": [ { "type": "openSession", "sessionId": "...", "requestId": "..." } ] }`；无命令最多挂起 25s 后返回 `{ "commands": [] }` |

Client 行为要求：

- 状态变化时立即 `POST`；若上一次请求未返回，只置 dirty 标记，返回后立刻补发（不得依赖 `setTimeout`，
  窗口隐藏时会被 Chromium 节流）。失败后退避重试（1s/2s/5s）。
- 长轮询返回后立即再次发起（微任务即可），不要等定时器。
- 执行 `openSession`：调用 `ctx.uiWorkspace.openSession(sessionId)`，失败忽略并继续轮询。
- `focused` 取自 `ctx.sessions.list` 的行：`(row.retainedBy?.mainView ?? 0) > 0`（DSH 判断主视图
  用的就是这个字段，见 `@deepseek-ai/dsh-client-ui-session` 的 `isMain`）。

## 4. Host 实现要点

- webserver 路由：`ctx.webServer.register({ kind: 'prefix', path: '/dsh-status', auth: 'anonymous', handler })`，
  handler 为 `(req, res) => void` 原生 Node 风格。
  **`auth: 'anonymous'` 必须显式声明**：DSH 0.2.3 起 webServer 的默认准入是 `required`，
  没有 DSH 登录态的原生 App 会在进入 handler 之前被 401 拦掉（App 只看到 `unauthorized` 文本、
  SSE 永远收不到 `state` 事件）。桥在 handler 内自己完成下面两条鉴权，因此对 webServer 声明
  anonymous，安全模型与 0.2.3 之前一致（仅回环 + token / `admit`）。
- Native 请求鉴权：校验 `Authorization` 头 token；并校验 `req.headers.host` 指向回环。
- Client 请求鉴权：`new Request('http://127.0.0.1' + req.url, { method, headers: new Headers(req.headers) })`
  后调用 `ctx.connection.admit(request)`，拒绝则 401/403（实现细节可简化，但必须拒绝未认证请求）。
  **DSH 0.2.2-rc.2 起必须在声明了 `connection.authentication` 的 fiber 里调用 `admit`**
  （例如 `ctx.inject(['connection', 'connection.authentication'], (admitCtx) => …)`）：
  服务读取按调用方 fiber 的 `inject` 鉴权，直接调用会抛
  `cannot get property "connection.authentication" without inject`，浏览器半的请求全部 401。
- `lastTurn` 缓存：`ctx.on('session/event', { global: true }, (session, event) => { if (event.type === 'turn/end') lastTurn.set(...) })`。
- 状态变化时向所有 SSE 客户端广播完整 `BridgeState`（无需增量）。
- 卸载时：清理路由、关闭 SSE、删除 `bridge.json`（尽力而为）。
- 可选拉起 App：按 `config.appPath` → `DSH_STATUS_APP` → `/Applications/DSH Status.app`
  → `~/Applications/DSH Status.app` 的顺序解析 App bundle，激活时若 App 未运行则 `spawn`
  `Contents/MacOS/DSHStatusBar` 拉起；实际解析结果写入 `bridge.json` 的 `appPath`。
- `bridge.json` 的目录权限 0700、文件权限 0600；目录已存在时也要主动收紧到 0700。

## 5. App 实现要点

- 轮询 `bridge.json`（2s）→ 连 `/dsh-status/stream`（SSE）；断线后指数退避重连（0.5s→5s 封顶）。
- 超过 12s 没有收到任何数据（含心跳）视为断线：图标显示未连接态，面板显示「DSH 未连接」。
- 点击会话行：先 `POST /dsh-status/command`（失败进重试队列），再 `open "dsh://open"`。
- DSH 完全退出时 App 保持运行、显示未连接；bridge.json 重新出现后自动恢复。

## 6. mock 实现（P0 / 开发用）

App 仓库（`dsh-status`）的 `mock/bridge.js` 实现 3.1 全部接口（无 Client 接口），
写同样格式的 `bridge.json`，按场景脚本推送假状态并支持状态变化，供 App 联调和演示。App 支持
`DSH_STATUS_BRIDGE_FILE` 环境变量覆盖 `bridge.json` 路径。
