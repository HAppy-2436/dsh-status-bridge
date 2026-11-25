# DSH Status Bridge（中文说明）

[English README](README.md)

把 DeepSeek Harness（DSH）的会话状态桥接到 [DSH Status](https://github.com/HAppy-2436/dsh-status)
macOS 菜单栏 App，并把 App 里的「跳转到会话」命令回传给 DSH。

## 组成

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 桥：注册 `/dsh-status` 路由（状态 / SSE / 命令），监听 `turn/end` 区分「已完成」与「已停止」、给焦点会话补 `notices`，写 `~/.dsh-status/bridge.json`，可选拉起 App |
| `client.js` | Client 半（DSH 渲染进程内，无 UI）：聚合 `uiSession` / `sessions` / `workspaces` 状态推给 Host；长轮询执行 `uiWorkspace.openSession` |
| `lib/aggregate.js` | 纯函数：状态推导 / 计数 / 快照校验（Host 与测试共用） |
| `test/` | `node --test` 单元测试 + Host 路由集成测试 + Client 半假 ctx 测试 |

## 前置条件

- macOS（配套 App 是菜单栏 App）
- DSH desktop **0.2.2-rc.2** 及以上（0.2.x 系列；已在 `0.2.3-alpha.2` 实机验证）。
  0.2.2-rc.2 改了路由准入、服务注入校验与会话状态服务，更早的 0.2.x 无法运行本插件。
- Node.js **>= 20**（DSH 自带，无需手动安装）
- 先安装配套 App：[dsh-status releases](https://github.com/HAppy-2436/dsh-status/releases)

## 安装

1. 安装 **DSH Status** App（DMG 拖到 `/Applications`，或用安装脚本装到 `~/Applications`）。
2. 打开 DSH：左侧边栏 **Plugins** → **Add plugin** → **Install a third-party plugin**
   → 输入 Git 地址 `github:HAppy-2436/dsh-status-bridge` → **Install** → **Enable now**。
   npm 包名 `dsh-status-bridge` 在 0.1.8 或更高版本发布后同样可用。
3. 插件激活后写 `~/.dsh-status/bridge.json` 并尝试拉起 App；菜单栏出现鲸鱼/分段圆环图标即接入成功。
4. 点击 App 面板里的会话行会跳转到 DSH 对应会话。

如果 App 没有被自动拉起：手动启动一次即可。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖插件 config：

```yaml
- id: dsh-status
  config:
    # 可选：显式指定 App 路径
    appPath: /Applications/DSH Status.app
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

由 `.github/workflows/publish.yml` 在 tag 上发布（npm **Trusted Publishing / OIDC**，
不需要长期 token，也不需要 OTP；首次使用前需在 npmjs.com 包设置里配置
Trusted Publisher：GitHub Actions + 仓库 `HAppy-2436/dsh-status-bridge` +
workflow `publish.yml` + 允许 `npm publish`）：

```bash
npm version patch --no-git-tag-version
git commit -am "chore: release v0.1.1"
git tag v0.1.1
git push origin main --tags
```

workflow 会先跑校验和测试，然后用 OIDC 短期令牌执行
`npm publish --access public --provenance`（自动生成 provenance）；不要在本地手动 publish。

## 许可证

MIT，见 [LICENSE](LICENSE)。
