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
  "subagents": [ SubagentRow, ... ]        // 子智能体会话：仅用于面板展示，不计入 counts
}
```

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
  "lastTurn": { "kind": "aborted", "at": 1762324799000 },
  "since": 1762324799000,                  // 进入当前状态的时刻
  "updatedAt": 1762324800000
}
```

`pending`：

```jsonc
{ "kind": "question" | "plan-review" | "approval" | "other", "summary": "示例问题" }
```

`lastTurn.kind` 取值来自 Host 侧 `turn/end.reason.kind`：
`completed` / `aborted` / `error` / `blocked` / `max-tokens`；未知时为 `null`。

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
  ]
}
```

- Client 只上报 `running || unread || pending` 的会话（非空闲）。
- Host 负责补 `lastTurn`、计算 `status` / `since` / `counts`。

### 状态推导规则（Host 执行，优先级从上到下）

1. `pending != null` → `waiting`
2. `running == true` → `running`
3. `unread == true` 且 `lastTurn.kind ∈ {aborted, error, blocked}` → `stopped`
4. `unread == true` → `completed`
5. 其他 → 丢弃（空闲，不进 BridgeState）

`since`：Host 缓存每个 session 上一次的 status，变化时记为当前时间（Host 重启后以首次收到的时间为准）。

## 3. HTTP 接口

前缀固定 `/dsh-status`。所有 JSON 请求/响应 `Content-Type: application/json`。

### 3.1 Native App 接口（Bearer token）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/dsh-status/state` | 返回当前 `BridgeState`（无状态时也返回结构，sessions 为空、client.connected=false） |
| `GET` | `/dsh-status/stream` | SSE 推送：连接后立即发一条 `event: state`，之后每次状态变化发一条；每 5s 发 `: ping` 注释保活 |
| `POST` | `/dsh-status/command` | 请求体 `{ "type": "openSession", "sessionId": "session-..." }`；返回 `{ "ok": true, "requestId": "..." }`；无法入队返回 503/400 |
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

## 4. Host 实现要点

- webserver 路由：`ctx.webServer.register({ kind: 'prefix', path: '/dsh-status', handler })`，
  handler 为 `(req, res) => void` 原生 Node 风格。
- Native 请求鉴权：校验 `Authorization` 头 token；并校验 `req.headers.host` 指向回环。
- Client 请求鉴权：`new Request('http://127.0.0.1' + req.url, { method, headers: new Headers(req.headers) })`
  后调用 `ctx.connection.admit(request)`，拒绝则 401/403（实现细节可简化，但必须拒绝未认证请求）。
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
