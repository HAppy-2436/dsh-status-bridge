# DSH Status Bridge（中文说明）

[English README](README.md)

把 DeepSeek Harness（DSH）的会话状态桥接到 [DSH Status](https://github.com/HAppy-2436/dsh-status)
macOS 菜单栏 App，并把 App 里的「跳转到会话」命令回传给 DSH。

## 组成

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 桥：注册 `/dsh-status` 路由（状态 / SSE / 命令），监听 `turn/end` 区分「已完成」与「已停止」，写 `~/.dsh-status/bridge.json`，可选拉起 App |
| `client.js` | Client 半（DSH 渲染进程内，无 UI）：聚合 `uiSession` / `sessions` / `workspaces` 状态推给 Host；长轮询执行 `uiWorkspace.openSession` |
| `lib/aggregate.js` | 纯函数：状态推导 / 计数 / 快照校验（Host 与测试共用） |
| `test/` | `node --test` 单元测试 + Host 路由集成测试 + Client 半假 ctx 测试 |

## 前置条件

- macOS（配套 App 是菜单栏 App）
- DSH desktop **0.2.1-rc.5** 及以上（0.2.x 系列；已在 `0.2.1-rc.5`、`0.2.2-rc.1` 实机验证）
- Node.js **>= 20**（DSH 自带，无需手动安装）
- 先安装配套 App：[dsh-status releases](https://github.com/HAppy-2436/dsh-status/releases)

## 安装

1. 安装 **DSH Status** App（DMG 拖到 `/Applications`，或用安装脚本装到 `~/Applications`）。
2. 打开 DSH：左侧边栏 **Plugins** → **Add plugin** → **Install a third-party plugin**
   → 包名输入 `dsh-status-bridge` → **Install** → **Enable now**。
   （若 npm 包尚不可用，在同一输入框改填 Git 地址 `github:HAppy-2436/dsh-status-bridge`。）
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
| `0.2.1-rc.5` | 实机验证通过 |
| `0.2.2-rc.1` | 实机验证通过 |
| 低于 `0.2.1-rc.5` 或 `>= 0.3.0` | 不支持（见 `engines.dsh`） |

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

## 已知限制

- Client 侧 `completionUnread` 是渲染进程内存态：DSH 重启后未读归零（与 DSH 自带提醒一致）。
- 多窗口/多标签时各 Client 各自上报，Host 取最后一次推送（单窗口假设）。
- Host 只能看到插件启动后的 `turn/end`；启动前已结束的会话按「已完成」处理。

## 开发 / 测试

```bash
export PATH="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin:$PATH"

npm run check          # node --check index.js client.js lib/aggregate.js
npm test               # node --test test/*.test.mjs（7 个测试）
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
