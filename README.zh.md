# DSH Status Bridge（中文说明）

[English README](README.md)

把 DeepSeek Harness（DSH）的**通知与会话状态**接到 macOS：会话完成、出错或等待你输入时
发系统通知；装上 [DSH Status](https://github.com/HAppy-2436/dsh-status) App 后，还会把
状态显示在菜单栏，并支持点击跳转、声音与勿扰。

想对比通知方案？见
[DSH 通知与状态：方案对比](https://github.com/HAppy-2436/dsh-status/blob/main/docs/notifications.zh.md)。

> **可选的菜单栏 App：** [下载 DSH Status](https://github.com/HAppy-2436/dsh-status/releases/latest)。
> 不装 App 也能收基础通知；App 额外提供菜单栏面板、点击跳转、提示音与勿扰。

## 组成

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 桥：注册 `/dsh-status` 路由（状态 / SSE / 命令），监听 `turn/end` 区分「已完成」与「已停止」、给焦点会话补 `notices`，写 `~/.dsh-status/bridge.json`，发独立通知，可选拉起 App |
| `client.js` | Client 半（DSH 渲染进程内，无 UI）：聚合 `uiSession` / `sessions` / `workspaces` 状态推给 Host；长轮询执行 `uiWorkspace.openSession` |
| `lib/aggregate.js` | 纯函数：状态推导 / 计数 / 快照校验（Host 与测试共用） |
| `lib/notify.js` | 纯函数：哪些状态变化需要发独立通知 |
| `test/` | `node --test` 单元测试 + Host 路由集成测试 + Client 半假 ctx 测试 |

## 前置条件

- macOS（通知与配套 App 都需要；Host 桥本身是纯 Node.js）
- DSH desktop **0.2.2-rc.2** 及以上（0.2.x 系列；已在 `0.2.3-alpha.2` 实机验证）。
  0.2.2-rc.2 改了路由准入、服务注入校验与会话状态服务，更早的 0.2.x 无法运行本插件。
- Node.js **>= 20**（DSH 自带，无需手动安装）
- 配套 App **可选**：不装 App 也能收到基础系统通知；装
  [DSH Status App](https://github.com/HAppy-2436/dsh-status/releases) 后才有菜单栏面板、
  点击跳转、声音与勿扰。

## 安装

1. 打开 DSH：左侧边栏 **Plugins** → **Add plugin** → **Install a third-party plugin**
   → 包名输入 `dsh-status-bridge` → **Install** → **Enable now**。
   若 registry 上没有 0.1.10 或更高版本，可在同一输入框改填 Git 地址
   `github:HAppy-2436/dsh-status-bridge`。
2. 插件激活后写 `~/.dsh-status/bridge.json`，开始发完成 / 出错 / 等待输入的 macOS 通知。
3. **可选：** 安装 [DSH Status App](https://github.com/HAppy-2436/dsh-status/releases)
   （DMG 拖到 `/Applications`）。插件发现 App 后会自动拉起；App 接管通知，并增加菜单栏面板。

如果 App 没有被自动拉起：手动启动一次即可。

## 不装 App 时的通知

App 没连上时，插件在每次有意义的状态变化时发一条通知：

- 会话**等待**你输入或审批；
- 一轮对话**完成**；
- 一轮对话**出错停止**。

你自己按停止不会通知。通知优先走 `terminal-notifier`，没装则退到 `osascript`；
没有 App 时点击跳转和提示音受限。App 连上后插件保持安静，由 App 接管通知。
可用 `fallbackNotifications: false` 关闭。

## 命令

- `/dsh-status` — 查看桥版本、会话计数、菜单栏 App 是否已安装，以及下载链接。
  收不到通知时，这也是最快的排查入口。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖插件 config：

```yaml
- id: dsh-status
  config:
    # 可选：显式指定 App 路径
    appPath: /Applications/DSH Status.app
    # App 没连上时由插件发基础 macOS 通知（默认 true）
    fallbackNotifications: true
```

App 路径按以下顺序探测，把第一个存在的路径写进 `bridge.json` 的 `appPath` 字段：

1. `config.appPath`
2. `DSH_STATUS_APP` 环境变量
3. `/Applications/DSH Status.app`
4. `~/Applications/DSH Status.app`

环境变量（仅开发用）：

- `DSH_STATUS_DIR` — 覆盖 `bridge.json` 所在目录（默认 `~/.dsh-status`）。

`bridge.json` 带版本号（`version: 1`）和 `pluginVersion` 字段；App 端忽略未知键，
因此插件与 App 可以独立升级。

## 兼容性

| DSH | 状态 |
| --- | --- |
| `0.2.3-alpha.2` | 实机验证通过 |
| `0.2.2-rc.2` – `0.2.2-rc.5` | 预期可用（API 相同，未实机验证） |
| 低于 `0.2.2-rc.2` 或 `>= 0.3.0` | 不支持（见 `engines.dsh`） |

DSH 0.2.3 起 web server 的默认准入变成 `required`。桥因此显式用 `auth: 'anonymous'`
注册路由，并在 handler 内自己鉴权（原生 App 用回环 `Host` + Bearer token，浏览器半用
`connection.admit`）。DSH 0.2.2-rc.2 起服务读取按调用方 fiber 的 `inject` 鉴权，所以
`admit` 放在声明了 `connection.authentication` 的子 fiber 里调用；没有该服务的老版本
回退到直接调用。

DSH 0.2.2-rc.2 还把 `ctx.uiSession.sessionStatus` 改成需要注入
（`uiSession.sessionStatus`）的独立服务，桥在 Client 半的 `inject` 里一并声明。0.1.8
之前的版本缺前者或缺后者，在 0.2.3+ 上都会表现为「连接不上」或「连上但没有会话行」。

## 会话过滤

统计只包含**顶层会话**，以下不计入（不显示、不进圆环、不发通知）：

- **子智能体会话**：`origin === 'subagent'` 或带父会话（`parentId` / `parentSessionId`）；
  面板里缩进显示，点击打开父会话；
- 已归档会话；
- 空白会话（`blank === true`）。

## 标题从哪里来

会话标题来自 Session 的 `title` 投影（列表行可能滞后/为空）：

- Client 半发现标题为空时，主动调用 `ctx.sessions.refreshProjections(sessionId)`（每会话最多重试 3 次）；
- Host 桥对**运行中会话**额外用 live Agent 的 `sessionProjections.stateOf(session, 'title')` 兜底；
- 仍拿不到时 App 显示「未命名会话」。

## 焦点会话的完成提醒

DSH 的 `completionUnread` 只在「跑完时不在主视图」才置位，所以正在看的会话跑完不会有
「已完成 / 已停止」行。桥为此单独补一条 `notices`：

- Client 半在每次快照里带上焦点会话（`focused`，取自 `retainedBy.mainView`）；
- Host 收到这些会话的 `turn/end` 时生成 `SessionNotice`（`kind` 由原因映射），保留 120s / 最多 20 条；
- **区分主动停止与出错停止**：`aborted` 的取消来源（`turn/end.reason.reason.kind`）写进
  `lastTurn.cancel`。`user` 表示用户自己按了停止：Host 不生成 notice / 临时行，并丢弃该会话的
  unread 状态行，所以 App 不弹横幅/提示音、面板不出现「已停止」行、角标不增加；
  `error`、被 hook/parent/dispose 打断等来源仍照常提醒；
- App 首帧只登记、之后按 `id` 去重，照常弹横幅与提示音；
- 同时补一条 `transient` 的「已完成」行：图标走「运行中 → 已完成」、角标 +1；
  App 行尾的 × 会 `POST /command {type:"dismiss"}` 让 Host 删掉它（角标 -1），右键菜单「全部忽略」发不带
  `sessionId` 的同一条命令清掉全部，
  该会话重新运行/待回答或 Client 报了未读时也会自动删。临时行只在 Host 内存里。

需要 App 侧 `dsh-status` **≥ 0.4.3** 才会显示；旧 App 忽略 `notices` / `cancel`，行为不变。
按 `cancel` 静音提醒需要 App **≥ 0.4.4 build 22**；丢弃「已停止」行/角标需要桥 **≥ 0.1.6**。

## 已知限制

- Client 侧 `completionUnread` 是渲染进程内存态：DSH 重启后未读归零（与 DSH 自带提醒一致）。
- 多窗口/多标签时各 Client 各自上报，Host 取最后一次推送（单窗口假设）。
- Host 只能看到插件启动后的 `turn/end`；启动前已结束的会话按「已完成」处理。

## 开发 / 测试

```bash
export PATH="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin:$PATH"

npm run check          # node --check index.js client.js lib/aggregate.js
npm test               # node --test test/*.test.mjs（15 个测试）
npm pack --dry-run     # 检查 npm 包内容
```

开发用 Host 桥 harness（不启动 DSH，用假 ctx）：

```bash
DSH_STATUS_DIR=/tmp/dsh-status-dev node test/dev-host.mjs
```

## 协议

插件与 App 之间的通信协议见 [docs/protocol.md](docs/protocol.md)，
任何字段变更必须先改协议文档。

## 发布

维护者在本机登录 npm 后：

```bash
npm run check
npm test
npm publish --access public
```

tag 必须与 `package.json` 版本一致（`v0.1.10` → `0.1.10`）。`.github/workflows/publish.yml`
是可选自动化：在 npm Trusted Publishing 配置启用后，推 tag 即可自动发布；在那之前先本机
发布，再推同名 tag。

## 许可证

MIT，见 [LICENSE](LICENSE)。
