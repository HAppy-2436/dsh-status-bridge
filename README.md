# DSH Status Bridge

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin for **notifications
and status**. It sends native macOS notifications when a session finishes, errors,
or waits for your input, and bridges live session status to the
[DSH Status](https://github.com/HAppy-2436/dsh-status) menu bar app. The app adds
the menu bar panel, click-to-jump, sounds, and Do Not Disturb.

Comparing notification plugins? See
[DSH notifications and status: comparing the options](https://github.com/HAppy-2436/dsh-status/blob/main/docs/notifications.md).

> **Optional menu bar app:** [Download DSH Status](https://github.com/HAppy-2436/dsh-status/releases/latest).
> The plugin sends basic notifications without it; the app adds the menu bar panel,
> click-to-jump, sounds, and Do Not Disturb.

The plugin has two halves:

| File | Role |
| --- | --- |
| `index.js` | Host bridge: registers the `/dsh-status` routes (state / SSE / commands), listens for `turn/end` to tell completed from stopped turns, writes `~/.dsh-status/bridge.json`, sends standalone notifications, and optionally launches the app |
| `client.js` | Client half (runs inside the DSH renderer, no UI): aggregates `uiSession` / `sessions` / `workspaces` state and pushes it to the host; long-polls for `uiWorkspace.openSession` commands |
| `lib/aggregate.js` | Pure functions: state derivation, counting and snapshot validation (shared by the host and the tests) |
| `lib/notify.js` | Pure functions: which session-state transitions deserve a standalone notification |
| `test/` | `node --test` unit tests plus host-route integration tests and a fake-context client test |

## Requirements

- macOS for notifications and for the companion app (the host bridge itself is
  plain Node.js)
- DSH desktop **0.2.2-rc.2** or newer in the 0.2.x line (verified on `0.2.3-alpha.2`).
  0.2.2-rc.2 changed route admission, service-inject checks, and the Session
  status service; earlier 0.2.x releases cannot run this plugin.
- Node.js **>= 20** (bundled with DSH, nothing to install manually)
- The companion app is **optional**: without it the plugin still sends basic
  macOS notifications. Install the [DSH Status app](https://github.com/HAppy-2436/dsh-status/releases)
  for the menu bar panel, click-to-jump, sounds, and Do Not Disturb.

## Install

1. In DSH: sidebar **Plugins** → **Add plugin** → **Install a third-party plugin**
   → enter the package name `dsh-status-bridge` → **Install** → **Enable now**.
   If your registry does not have 0.1.10 or newer, paste the Git URL
   `github:HAppy-2436/dsh-status-bridge` in the same field instead.
2. The plugin writes `~/.dsh-status/bridge.json` and starts sending basic macOS
   notifications for completion, errors, and waiting-for-input events.
3. **Optional:** install the [DSH Status app](https://github.com/HAppy-2436/dsh-status/releases)
   (DMG → drag to `/Applications`). The plugin launches it automatically when it
   finds it; the app takes over notifications and adds the menu bar panel.

If the app was not launched automatically, start it manually once.

## Notifications without the app

When no app is connected, the plugin sends one notification per meaningful
transition:

- a session is **waiting** for your input or approval;
- a turn **completes**;
- a turn **stops with an error**.

It never notifies for a stop you triggered yourself. Notifications use
`terminal-notifier` when it is installed, otherwise `osascript`; click behavior
and sounds are limited without the app. Once the app connects, the plugin keeps
quiet and the app owns notifications. Disable the fallback with
`fallbackNotifications: false`.

## Commands

- `/dsh-status` — show the bridge version, session counts, whether the menu bar
  app is installed, and the download link. This is also the quickest way to see
  what the plugin is doing when notifications do not arrive.

## Configuration

Override the plugin config from the profile's `cordis.patch.yml`:

```yaml
- id: dsh-status
  config:
    # Optional: explicit app bundle path
    appPath: /Applications/DSH Status.app
    # Send basic macOS notifications when the app is not connected (default true)
    fallbackNotifications: true
```

The app bundle is resolved in this order, and the first existing path is written
into `bridge.json` as `appPath`:

1. `config.appPath`
2. `DSH_STATUS_APP` environment variable
3. `/Applications/DSH Status.app`
4. `~/Applications/DSH Status.app`

Environment variables (development only):

- `DSH_STATUS_DIR` — override the directory holding `bridge.json`
  (default `~/.dsh-status`).

`bridge.json` is versioned (`version: 1`) and contains `pluginVersion`; the app
ignores unknown keys, so plugin and app can be upgraded independently.

## Compatibility

| DSH | Status |
| --- | --- |
| `0.2.3-alpha.2` | verified on device |
| `0.2.2-rc.2` – `0.2.2-rc.5` | expected to work (same APIs, not verified on device) |
| older than `0.2.2-rc.2` or `>= 0.3.0` | unsupported (declared in `engines.dsh`) |

DSH 0.2.3 made web server admission default to `required`. The bridge therefore
registers its route with `auth: 'anonymous'` and keeps authenticating inside the
handler (loopback `Host` + bearer token for the app, `connection.admit` for the
browser half). Since DSH 0.2.2-rc.2 reads services against the calling fiber's
`inject`, that `admit` call runs inside a child fiber declaring
`connection.authentication`; older DSH without the service keeps the direct call.

DSH 0.2.2-rc.2 also turned `ctx.uiSession.sessionStatus` into a service that a
client plugin must inject (`uiSession.sessionStatus`), so the bridge declares it
together with the other Session services. Plugin versions before 0.1.8 miss the
anonymous admission or the injection and appear as "cannot connect" on 0.2.3+.

## Session filtering

Only **top-level** sessions are counted, displayed and notified:

- subagent sessions (`origin === 'subagent'`, or sessions with a parent) are
  listed indented in the panel but never counted in the menu bar icon or
  notifications;
- archived sessions are ignored;
- blank sessions are ignored.

## Titles

Session titles come from the Session `title` projection (list rows may lag or be
empty):

- the client half calls `ctx.sessions.refreshProjections(sessionId)` when a title
  is missing (at most 3 retries per session);
- the host bridge falls back to the live agent's
  `sessionProjections.stateOf(session, 'title')` for running sessions;
- the app shows "Untitled session" when nothing is available.

## Focus-session completion alerts

DSH sets `completionUnread` only when a turn ends outside the main view, so a session that finishes
while you are watching it never produces a "completed"/"stopped" row. The bridge reports it
separately as `notices`:

- the client half includes focused sessions in every snapshot (`focused`, derived from
  `retainedBy.mainView`);
- the host turns their `turn/end` into a `SessionNotice` (kind mapped from the reason) and keeps the
  last 120 s / at most 20 entries;
- **user stop vs error stop**: the abort cause (`turn/end.reason.reason.kind`) is exposed as
  `lastTurn.cancel`. For `user` the host emits no notice/transient row and drops the unread "stopped"
  row, so the app stays silent and the panel/badge show nothing; `error`,
  hook/parent/dispose cancellations still alert;
- the app registers the first frame, then de-duplicates by `id` and shows the usual banner and sound;
- the host also adds a `transient` "completed" row so the icon goes running → completed (badge +1);
  the × in the app's row posts `{type:"dismiss"}` and the host drops it (badge −1); the app's
  right-click "Dismiss All" posts the same command without `sessionId` to clear every row, as does the
  session running/waiting again or the client reporting it unread. Transient rows live in host
  memory only.

Requires `dsh-status` **>= 0.4.3**; older apps ignore `notices` / `cancel` and behave as before.
Silencing user-initiated stops requires the app at **>= 0.4.4 build 22**; dropping the "stopped"
row/badge as well requires bridge **>= 0.1.6**.

## Known limitations

- `completionUnread` on the client is renderer-memory state: unread counts reset
  after a DSH restart (same as DSH's own badges).
- With multiple windows/tabs each client pushes its own snapshot; the host keeps
  the last push (single-window assumption).
- The host only sees `turn/end` events that happen after the plugin starts;
  sessions finished before that are treated as completed.

## Development

```bash
export PATH="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin:$PATH"

npm run check          # node --check index.js client.js lib/aggregate.js
npm test               # node --test test/*.test.mjs (15 tests)
npm pack --dry-run     # inspect the tarball contents
```

A dev harness with a fake host context (no DSH needed) is available:

```bash
DSH_STATUS_DIR=/tmp/dsh-status-dev node test/dev-host.mjs
```

## Protocol

The wire protocol between the plugin and the app is documented in
[docs/protocol.md](docs/protocol.md). Any field change must update that document
first.

## Publishing

From a maintainer machine with npm login:

```bash
npm run check
npm test
npm publish --access public
```

The tag must match `package.json` (`v0.1.10` → `0.1.10`). The optional
`.github/workflows/publish.yml` automates the same steps with npm Trusted
Publishing once its OIDC configuration is enabled; until then, publish locally
and push a matching tag.

## License

MIT — see [LICENSE](LICENSE).
