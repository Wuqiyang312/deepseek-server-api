#!/usr/bin/env node
/** Kimi REST + WS 冒烟。Node 24；自动编译源码到 .smoke-lib，退出时清理。 */
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const LIB = path.join(ROOT, '.smoke-lib')
const KIMI = '/kimi'
const results = []
const clients = new Set()
const sockets = new Set()
let server, home, workspaceRoot
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

async function compile() {
  const args = ['-p', 'tsconfig.json', '--outDir', '.smoke-lib', '--declaration', 'false',
    '--declarationMap', 'false', '--sourceMap', 'false']
  let result = spawnSync(path.join(ROOT, 'node_modules/.bin/tsc'), args, { cwd: ROOT, encoding: 'utf8' })
  if (/TS5069/.test(result.stdout + result.stderr)) {
    // tsconfig 的 declarationDir 与 --declaration false 冲突；仅临时配置清空它。
    await mkdir(LIB, { recursive: true })
    await writeFile(path.join(LIB, 'tsconfig.json'), JSON.stringify({
      extends: '../tsconfig.json',
      compilerOptions: { declarationDir: null, outDir: '.', declaration: false,
        declarationMap: false, sourceMap: false, noEmitOnError: false },
    }))
    result = spawnSync(path.join(ROOT, 'node_modules/.bin/tsc'), ['-p', '.smoke-lib/tsconfig.json'],
      { cwd: ROOT, encoding: 'utf8' })
  }
  if (result.error) throw result.error
  const diagnostics = (result.stdout + result.stderr).trim()
  const lines = diagnostics.split('\n').filter(Boolean)
  if (result.status !== 0 && !(result.status === 2 && lines.length === 1 &&
      /^src\/index\.ts\(\d+,\d+\): error TS2749:/.test(lines[0]))) {
    throw new Error(`编译失败：${diagnostics}`)
  }
  if (diagnostics) console.log(`编译基线（已 emit）：${diagnostics}`)
}

async function call(method, urlPath, { token, body, raw, requestId } = {}) {
  const headers = { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }
  if (token) headers.Authorization = 'Bearer ' + token
  if (requestId) headers['X-Request-Id'] = requestId
  const res = await fetch(`http://127.0.0.1:${server.address().port}${urlPath}`, {
    method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 文件下载 */ }
  return { status: res.status, body: json, text, raw: res }
}

async function startServer(ctx, config, store, HttpRouter, register, buildDeps, upgrade) {
  const router = new HttpRouter(config)
  register(ctx, router, { config, keyStore: store })
  const instance = createServer(async (req, res) => {
    try {
      const handled = await router.dispatch(req, res, KIMI)
      if (!handled && !res.headersSent) { res.statusCode = 404; res.end('not found') }
    } catch (err) { res.statusCode = 500; res.end(String(err.stack || err)) }
  })
  instance.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  instance.on('upgrade', (req, socket, head) => {
    let pathname = ''
    try { pathname = new URL(req.url || '/', 'http://localhost').pathname } catch { /* 无效 URL */ }
    if (pathname !== `${KIMI}/api/v1/ws`) { socket.destroy(); return }
    upgrade(req, socket, head, buildDeps(ctx, { config, keyStore: store }))
  })
  await new Promise((resolve, reject) => {
    instance.once('error', reject)
    instance.listen(0, '127.0.0.1', resolve)
  })
  return instance
}

function wsConnect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}${KIMI}/api/v1/ws`,
      ['kimi-code.bearer.' + token])
    clients.add(ws)
    const inbox = [], waiters = new Set()
    const timer = setTimeout(() => { ws.close(); reject(new Error('WS 握手超时')) }, 3000)
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      const waiter = [...waiters].find((w) => w.pred(msg))
      if (waiter) { waiters.delete(waiter); waiter.resolve(msg) }
      else inbox.push(msg)
    })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WS 连接被拒')) })
    ws.addEventListener('close', () => {
      clearTimeout(timer)
      clients.delete(ws)
      for (const waiter of waiters) waiter.reject(new Error('WS 已关闭'))
      waiters.clear()
    })
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolve({ ws, send: (obj) => ws.send(JSON.stringify(obj)), next: (pred, ms = 3000) => {
        const index = inbox.findIndex(pred)
        if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0])
        return new Promise((res, rej) => {
          const waiter = { pred, resolve: (msg) => { clearTimeout(t); res(msg) },
            reject: (err) => { clearTimeout(t); rej(err) } }
          const t = setTimeout(() => { waiters.delete(waiter); rej(new Error('WS 帧超时')) }, ms)
          waiters.add(waiter)
        })
      } })
    })
  })
}

try {
  await compile()
  const { HttpRouter } = await import(path.join(LIB, 'router.js'))
  const { ApiKeyStore } = await import(path.join(LIB, 'api-keys-store.js'))
  const { registerKimiCompatRoutes, buildKimiWsDeps } = await import(path.join(LIB, 'kimi-compat.js'))
  const { handleKimiUpgrade } = await import(path.join(LIB, 'kimi-ws.js'))
  const { buildTranscriptOps, replayTranscript } = await import(path.join(LIB, 'kimi-events.js'))
  const listeners = new Map(), sessions = new Map()
  workspaceRoot = await mkdtemp(path.join(tmpdir(), 'kimi-ws-'))
  const workspaces = [{ id: 'ws_main', path: workspaceRoot, sessionIds: new Set() }]
  await writeFile(path.join(workspaceRoot, 'hello.txt'), 'hello kimi\n')
  const services = new Map(Object.entries({
    sessionController: {
      list: async () => ({ items: [...sessions.values()].map((s) => ({ id: s.id,
        title: s.header.title, createdAt: s.createdAt, updatedAt: s.updatedAt, running: s.running })) }),
      inspect: async (id) => {
        const s = sessions.get(id)
        return s ? { meta: { ...s.header }, events: s.events.slice() } : undefined
      },
      create: async (opts) => {
        const id = opts.sessionId
        sessions.set(id, { id, header: { cwd: opts.cwd || workspaceRoot, title: 'smoke' },
          createdAt: Date.now(), updatedAt: Date.now(), running: false, events: [] })
        workspaces[0].sessionIds.add(id)
        return { sessionId: id }
      },
      rename: async ({ sessionId, title }) => { sessions.get(sessionId).header.title = title; return true },
      selectModel: async () => true,
      cancel: async ({ sessionId }) => { sessions.get(sessionId).running = false; return true },
    },
    sessions: { get: (id) => sessions.get(id) },
    agents: new Map(),
    workspaceRegistry: { list: () => workspaces, get: (id) => workspaces.find((w) => w.id === id),
      resolve: (p) => workspaces.find((w) => w.path === p),
      resolveByPath: async (p) => workspaces.find((w) => w.path === p) },
    permissionPresets: { list: () => [] },
  }))
  const fakeCtx = {
    get: (name) => services.get(name),
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(fn)
      return () => listeners.get(event)?.delete(fn)
    },
    effect: (fn) => fn(),
    emit(event, ...args) { for (const fn of listeners.get(event) ?? []) fn(...args) },
  }
  home = await mkdtemp(path.join(tmpdir(), 'dsh-kimi-smoke-'))
  const store = new ApiKeyStore('', home)
  await store.ensureReady()
  const config = { pathPrefix: '/api/v1', cors: true, maxUploadBytes: 1024 * 1024 }
  server = await startServer(fakeCtx, config, store, HttpRouter, registerKimiCompatRoutes,
    buildKimiWsDeps, handleKimiUpgrade)

  let r = await call('POST', `${KIMI}/api/v1/sessions`, {
    body: { metadata: { cwd: workspaceRoot }, title: 'kimi smoke' }, requestId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  })
  check('建会话 → 200 信封 code=0', r.status === 200 && r.body?.code === 0 &&
    typeof r.body?.data?.id === 'string', JSON.stringify(r.body))
  check('信封 msg/request_id + cwd/title 回显', r.body?.msg === 'success' &&
    r.body?.request_id === '01ARZ3NDEKTSV4RRFFQ69G5FAV' && r.body?.data?.metadata?.cwd === workspaceRoot &&
    r.body?.data?.title === 'kimi smoke')
  const sid = r.body?.data?.id
  if (!sessions.has(sid)) throw new Error('建会话失败，无法继续会话断言')
  const base = `${KIMI}/api/v1/sessions/${sid}`
  r = await call('GET', base)
  check('会话详情 → code=0 且 id 回显', r.status === 200 && r.body?.code === 0 && r.body?.data?.id === sid)
  r = await call('POST', `${base}/fs:list`, { body: { path: '.' } })
  check('fs:list → entries 含 hello.txt', r.body?.code === 0 &&
    r.body?.data?.entries?.some((e) => e.name === 'hello.txt'), JSON.stringify(r.body))
  r = await call('POST', `${base}/fs:read`, { body: { path: 'hello.txt' } })
  check('fs:read → content 匹配', r.body?.code === 0 && r.body?.data?.content === 'hello kimi\n')
  r = await call('POST', `${base}/fs:remove`, { body: { path: 'hello.txt' } })
  check('fs:remove 不支持 → HTTP 200/40001', r.status === 200 && r.body?.code === 40001)
  r = await call('POST', `${base}/bogus`, { body: {} })
  check('非 fs tail → HTTP 200/40001', r.status === 200 && r.body?.code === 40001)
  r = await call('POST', `${base}/fs:read`, { body: { path: '../etc/passwd' } })
  check('路径越界 → HTTP 200/41304', r.status === 200 && r.body?.code === 41304)
  r = await call('GET', `${base}/fs/hello.txt:download`)
  check('fs 下载 → 200 + attachment + 内容', r.status === 200 &&
    r.raw.headers.get('content-disposition')?.includes('attachment') && r.text === 'hello kimi\n')
  r = await call('GET', `${base}/fs/nope.txt:download`)
  check('下载缺失 → 真实 404 + 40409', r.status === 404 && r.body?.code === 40409)
  r = await call('POST', `${base}/prompts::steer`, { body: { prompt_ids: ['p1', 'p2'] } })
  check('批量 steer → steered + prompt_ids', r.body?.code === 0 && r.body?.data?.steered === true &&
    JSON.stringify(r.body?.data?.prompt_ids) === '["p1","p2"]')
  sessions.get(sid).running = true
  r = await call('POST', `${base}/prompts:abort`, { body: {} })
  check('prompts:abort → aborted 且 cancel 生效', r.body?.code === 0 &&
    r.body?.data?.aborted === true && sessions.get(sid).running === false)
  r = await call('POST', `${base}/prompts:p123:steer`, { body: {} })
  check('单 prompt steer → prompt_ids=[pid]', r.body?.code === 0 && r.body?.data?.steered === true &&
    JSON.stringify(r.body?.data?.prompt_ids) === '["p123"]')

  const created = await store.create({ name: 'smoke' })
  await store.setAuthEnabled(true)
  r = await call('GET', `${KIMI}/api/v1/sessions`)
  check('无 token → 401/40101', r.status === 401 && r.body?.code === 40101)
  r = await call('GET', `${KIMI}/api/v1/sessions`, { token: created.plaintext })
  check('有效 token → 200 code=0 且会话存在', r.status === 200 && r.body?.code === 0 &&
    r.body?.data?.items?.some((s) => s.id === sid))
  for (let i = 0; i < 11; i++) await call('GET', `${KIMI}/api/v1/sessions`, { token: 'bad' })
  r = await call('GET', `${KIMI}/api/v1/sessions`, { token: created.plaintext })
  check('失败限流 → 429/42901', r.status === 429 && r.body?.code === 42901)
  await store.setAuthEnabled(false)

  // DSH 输入 {seq,type,data,time}；转录 seq 属于 batches，不属于各 op。
  const fakeEvents = [
    { seq: 10, type: 'turn/start', data: { turn: 0 }, time: 1000 },
    { seq: 20, type: 'step/start', data: { turn: 0, step: 0 }, time: 2000 },
    { seq: 30, type: 'assistant/chunk', data: { turn: 0, step: 0,
      chunk: { type: 'text-delta', text: 'hello' } }, time: 3000 },
    { seq: 40, type: 'turn/end', data: { turn: 0, reason: 'completed' }, time: 4000 },
  ]
  sessions.get(sid).events.push(...fakeEvents)
  const expected = buildTranscriptOps(fakeEvents)
  check('buildTranscriptOps/replayTranscript seq 逐 1（非事件 seq）', expected.batches.length === 4 &&
    expected.batches.every((b, i) => b.seq === i + 1) && replayTranscript(fakeEvents).latest_seq === 4)
  r = await call('GET', `${base}/transcript/ops?agent_id=main&since_seq=0`)
  check('REST transcript/ops 非空、seq 连续且与同源一致', r.body?.code === 0 &&
    r.body?.data?.latest_seq === 4 && r.body?.data?.complete === true &&
    JSON.stringify(r.body?.data?.batches) === JSON.stringify(expected.batches))
  r = await call('GET', `${base}/transcript/ops?agent_id=main&since_seq=2`)
  check('REST transcript 增量游标 → [3,4]', r.body?.code === 0 &&
    JSON.stringify(r.body?.data?.batches?.map((b) => b.seq)) === '[3,4]')
  await call('POST', `${KIMI}/api/v1/sessions`, { body: { metadata: { cwd: workspaceRoot } } })
  r = await call('GET', `${KIMI}/api/v2/sessions?page_size=10`)
  check('v2 列表 → items/total/has_more', r.body?.code === 0 && r.body?.data?.items?.length === 2 &&
    r.body?.data?.total === 2 && r.body?.data?.has_more === false)
  r = await call('GET', `${KIMI}/api/v2/sessions?page_size=1&page=1`)
  const firstId = r.body?.data?.items?.[0]?.id
  check('v2 第 1 页 → 1 条/total=2/has_more', r.body?.code === 0 &&
    r.body?.data?.items?.length === 1 && r.body?.data?.total === 2 && r.body?.data?.has_more === true)
  r = await call('GET', `${KIMI}/api/v2/sessions?page_size=1&page=2`)
  check('v2 第 2 页 → 无重复/has_more=false', r.body?.code === 0 &&
    r.body?.data?.items?.length === 1 && r.body?.data?.items[0].id !== firstId && r.body?.data?.has_more === false)

  // REST 限流按 IP；WS 独立 token 校验。此处必须重新开启鉴权。
  await store.setAuthEnabled(true)
  let denied = false
  try { const bad = await wsConnect('wrong'); bad.ws.close() }
  catch (err) { if (err.message === 'WS 连接被拒') denied = true; else throw err }
  check('WS 错 token → 连接被拒', denied)
  const c = await wsConnect(created.plaintext)
  const hello = await c.next((m) => m.type === 'server_hello')
  check('server_hello payload.protocol_version=2', hello.payload?.protocol_version === 2)
  c.send({ type: 'subscribe', id: 'sub', payload: { session_ids: [sid] } })
  const ack = await c.next((m) => m.type === 'ack' && m.id === 'sub')
  check('subscribe ack code=0/accepted', ack.code === 0 && ack.payload?.accepted?.includes(sid))
  c.send({ type: 'subscribe_v2', id: 'v2', payload: { session_id: sid, transcript: { main: 'on' } } })
  const reset = await c.next((m) => m.type === 'transcript.reset')
  check('subscribe_v2 无游标 → reset/snapshot/seq=4', reset.session_id === sid &&
    reset.payload?.agent_id === 'main' && Array.isArray(reset.payload?.snapshot?.items) &&
    reset.seq === 4 && reset.payload?.seq === 4)
  const ackV2 = await c.next((m) => m.type === 'ack' && m.id === 'v2')
  check('subscribe_v2 ack', ackV2.code === 0 && ackV2.payload?.accepted?.includes(sid))
  const liveFrames = [], liveExpected = []
  for (const event of fakeEvents) {
    const live = { ...event, seq: event.seq + 40, data: { ...event.data, turn: 1 } }
    sessions.get(sid).events.push(live)
    // 每个事件到达时拍快照；全量 replay 的早期 op 可能引用后续会被更新的对象。
    liveExpected.push(JSON.parse(JSON.stringify(buildTranscriptOps(sessions.get(sid).events).batches.at(-1))))
    fakeCtx.emit('session/event', { id: sid }, live)
    liveFrames.push(await c.next((m) => m.type === 'transcript.ops'))
  }
  check('WS 注入 4 事件 → ops 非空 + seq [5,6,7,8]', liveFrames.length === 4 &&
    liveFrames.every((m, i) => m.seq === i + 5 && m.payload?.seq === m.seq &&
      m.session_id === sid && m.payload?.agent_id === 'main' && m.payload?.ops?.length > 0))
  check('WS live ops 与同源即时投影一致', JSON.stringify(liveFrames.map((m) =>
    ({ seq: m.seq, ops: m.payload.ops }))) === JSON.stringify(liveExpected))
  c.send({ type: 'subscribe_v2', id: 'replay', payload: { session_id: sid,
    transcript: { main: 'on' }, transcript_since: { main: 6 } } })
  const replayFrames = [await c.next((m) => m.type === 'transcript.ops'),
    await c.next((m) => m.type === 'transcript.ops')]
  check('subscribe_v2 游标 → ops [7,8]', replayFrames.every((m, i) => m.payload?.seq === i + 7))
  c.send({ type: 'subscribe', id: 'epoch', payload: { session_ids: [sid],
    cursors: { [sid]: { seq: 80, epoch: 'wrong-epoch' } } } })
  const resync = await c.next((m) => m.type === 'resync_required')
  check('错误 epoch → resync_required', resync.payload?.session_id === sid &&
    resync.payload?.reason === 'epoch_changed' && resync.payload?.epoch === reset.epoch)
  c.ws.close()
} catch (err) {
  check('冒烟执行异常', false, err.stack || String(err))
} finally {
  for (const ws of clients) ws.close()
  for (const socket of sockets) socket.destroy()
  if (server) await new Promise((resolve) => server.close(resolve))
  for (const dir of [home, workspaceRoot, LIB]) if (dir) await rm(dir, { recursive: true, force: true })
}
const passed = results.filter((r) => r.ok).length
console.log(`\n==== ${passed}/${results.length} 通过 ====`)
if (passed !== results.length) process.exitCode = 1
