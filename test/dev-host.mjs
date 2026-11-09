#!/usr/bin/env node
/**
 * 开发用 Host 桥 harness：不启动 DSH，用假 ctx 加载 index.js，
 * 起真实 HTTP 服务、写 ~/.dsh-status/bridge.json，并模拟 Client 半推送一份演示快照。
 *
 * 用途：在没有安装 DSH 插件的情况下，验证「Host 桥 ↔ 原生 App」真实链路。
 * 用法：node test/dev-host.mjs
 */
import http from 'node:http'
import { readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const routes = new Map()
const effectCleanups = []
const listeners = new Map()

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  let matched = null
  for (const route of routes.values()) {
    if (pathname.startsWith(route.path) && (matched === null || route.path.length > matched.path.length)) {
      matched = route
    }
  }
  if (!matched) {
    res.writeHead(404)
    res.end()
    return
  }
  matched.handler(req, res)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const ctx = {
  webServer: {
    get port() { return port },
    getOrigin() { return `http://127.0.0.1:${port}` },
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
  connection: { admit: () => ({ peer: { id: 'dev-harness' } }) },
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') effectCleanups.push(dispose)
    return dispose
  },
  on(event, callback) {
    listeners.set(event, callback)
    return () => listeners.delete(event)
  },
}

apply(ctx, {})

const bridgeFile = path.join(process.env.DSH_STATUS_DIR || path.join(homedir(), '.dsh-status'), 'bridge.json')
const bridge = JSON.parse(await readFile(bridgeFile, 'utf8'))
const base = `http://127.0.0.1:${bridge.port}`

// 模拟一次「homebrew 会话被用户停止」的 turn/end，Host 会把未读映射为已停止
listeners.get('session/event')?.({ id: 'session-homebrew' }, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })

const snapshot = {
  version: 1,
  sessions: [
    {
      id: 'session-erhu', title: '选哪种调音方案？', workspaceId: 'w-erhu', workspaceTitle: 'erhu',
      running: false, unread: false,
      pending: { kind: 'question', questions: [{ title: '选哪种调音方案？' }] },
      updatedAt: Date.now() - 60_000,
    },
    {
      id: 'session-dsh', title: '实现菜单栏图标', workspaceId: 'w-dsh-status', workspaceTitle: 'dsh-status',
      running: true, unread: false, pending: null, updatedAt: Date.now() - 1_000,
    },
    {
      id: 'session-stability', title: '测试出口节点', workspaceId: 'w-stability', workspaceTitle: 'stability',
      running: true, unread: false, pending: null, updatedAt: Date.now() - 2_000,
    },
    {
      id: 'session-protocol', title: '写桥接协议', workspaceId: 'w-dsh-status', workspaceTitle: 'dsh-status',
      running: false, unread: true, pending: null, updatedAt: Date.now() - 9 * 60_000,
    },
    {
      id: 'session-homebrew', title: '梳理 homebrew 配置', workspaceId: 'w-homebrew', workspaceTitle: 'homebrew',
      running: false, unread: true, pending: null, updatedAt: Date.now() - 42 * 60_000,
    },
  ],
}

const push = await fetch(`${base}/dsh-status/client/state`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(snapshot),
})
if (!push.ok) throw new Error(`push failed: ${push.status}`)

const state = await fetch(`${base}/dsh-status/state`, {
  headers: { authorization: `Bearer ${bridge.token}` },
}).then((response) => response.json())

console.log('[dev-host] ready')
console.log(`  origin : ${base}`)
console.log(`  token  : ${bridge.token.slice(0, 12)}…`)
console.log(`  counts : ${JSON.stringify(state.counts)}`)
console.log(`  bridge : ${bridgeFile}`)
console.log('  提示：保持本进程运行，再启动 DSH Status.app 即可看到真实 SSE 状态')

const shutdown = async () => {
  for (const dispose of effectCleanups.reverse()) {
    try { await dispose() } catch {}
  }
  await rm(bridgeFile, { force: true })
  server.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// 每 30s 重推一次，保持 client.connected 新鲜（App 侧断线判定是 12s 无数据）
setInterval(() => {
  fetch(`${base}/dsh-status/client/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(snapshot),
  }).catch(() => {})
}, 30_000)

await new Promise(() => {}) // 由 setInterval 保持进程存活
