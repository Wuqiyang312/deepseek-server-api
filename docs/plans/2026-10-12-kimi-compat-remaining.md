# kimi API 兼容层收尾（fs 路由 / steer 修复 / 挂接 / 冒烟 / 文档 / 出 lib）实现计划

> **面向 AI 代理的工作者：** 使用 caveman 模式与任何交互。简洁指令，减少 token 消耗。技术术语保持精确。使用 executing-plans 执行此计划。

**目标：** 把已写完的 kimi 兼容层（`src/kimi-{contract,events,ws,compat}.ts`，41 条 REST 路由 + WS）从「可编译」推进到「挂载可用」：补 fs 路由、修 steer 抢占、挂进 `src/index.ts`、冒烟验证、补文档、重出 lib。

**架构：** 兼容层挂在独立前缀（默认 `/kimi`）下的第二个 `HttpRouter`，自带 kimiAuth 闸门（不 setAuthService）；WS 走宿主 `webServer.registerUpgrade`（能力探测，缺失则跳过）或 standalone server 的 `upgrade` 事件。kimi 信封 `{code,msg,data,request_id,details}`，业务失败一律 HTTP 200 + 非零 code（文件流失败除外，用真实 HTTP 状态）。

**技术栈：** TypeScript（tsc 6.0.2，stub 环境下的 `@deepseek-ai/*`）、零依赖 RFC6455 WS（`src/kimi-ws.ts`）、Node 24 内置 `fetch`/`WebSocket` 冒烟。

**环境硬事实（勿再探测）：**
- typecheck / emit 统一用 `node_modules/.bin/tsc -p tsconfig.json [--noEmit]`。基线错误仅 1 个：`src/index.ts(35,22) TS2749`（stub schemastery 的 `z` 无泛型调用签名，**本任务不修、不算回归**）。
- BusyBox：无 `rg`/`python3`；`grep` 不支持 `--include`（用 Grep 工具）；大段追加用 bash heredoc。
- `lib/` 是 git 跟踪的构建产物，**必须**与 src 同步提交。
- HttpRouter（src/router.ts）：同 method 先注册者优先；`:name`→`([^/]+)`；尾部 `/*`→`params['*']`（可匹配基路径本身，空捕获解码为 `''`）；`auth:'admin'` 只跳过数据面闸门。
- kap-server 契约事实源（只读）：`/root/projects/kimi-code/packages/kap-server/src/routes/{fs,prompts,action-suffix}.ts`。
- 更全的代码摘录（带行号）：`/tmp/kimi-compat-extract/technical-excerpts.md`；交接原文：`/tmp/handoff-LIhBEe`。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/kimi-compat.ts` | 追加 fs 动作/下载路由；修 `prompts::steer` handler | 修改 |
| `src/index.ts` | kimi/kimiPrefix 配置、第二个 webServer.register、upgrade 挂接、info tool 补 kimiBaseUrl | 修改 |
| `src/types.ts` | `WebServiceConfig` 加 `kimi`/`kimiPrefix` | 修改 |
| `scripts/smoke-kimi-compat.mjs` | 端到端冒烟（REST + Node 内置 WebSocket） | 创建 |
| `README.md` / `README.zh.md` / `skills/dsh-web-service/SKILL.md` | kimi 兼容层章节 | 修改 |
| `lib/**` | tsc 重新 emit 的构建产物 | 重新生成并提交 |
| `tsconfig.check.json` / `tsconfig.kimi.json` | 临时配置 | 删除 |

已存在且直接复用（不改）：`handleFsAction`（src/kimi-compat.ts:1947，签名 `(res, rid, action, root, target, body)`，自身不鉴权、不 safeJoin、抛错带 `kimiCode`）、`resolveSessionCwd`/`safeJoin`（src/files.ts:119/139）、`sessionGate`（kimi-compat.ts:477）、`buildContentDisposition`（kimi-compat.ts，files GET 在用）、`parseActionSuffix`/`unsupportedActionMessage`（src/kimi-contract.ts:164/187）。

---

### 任务 1：fs 兼容路由（POST fs 动作 + GET 下载）

**文件：**
- 修改：`src/kimi-compat.ts`（在 L1745 `}, ADMIN)` 与 L1746 函数闭括号之间追加；L1274-1292 区域不动）

- [ ] **步骤 1：追加 POST 通用 fs 动作路由**

在 `registerKimiCompatRoutes` 末尾（最后一个 `}, ADMIN)` 之后、函数闭 `}` 之前）追加：

```ts
  // ---------- 会话文件系统动作（POST /sessions/{id}/{tail}，tail 须以 fs: 开头） ----------
  // 契约（kap-server routes/fs.ts）：通用 pattern，tail 不以 fs: 开头 → 40001 unsupported action。
  // 本路由注册在最末：同 method 先注册者优先，仅兜 fs 形态，其余 tail 已由先注册的 pattern 接住。
  const FS_SUPPORTED = ['list', 'stat', 'read', 'mkdir', 'search', 'grep'] as const

  router.post('/api/v1/sessions/:id/:tail', async (req, res, params, _q, body) => {
    const gate = await sessionGate(ctx, req, res, auth, params.id)
    if (!gate) return
    const { rid, sessionId } = gate
    const tail = String(params.tail || '')
    if (!tail.startsWith('fs:')) {
      fail(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, `unsupported action: ${tail}`, rid,
        [{ path: 'session_id', message: `unsupported action: ${tail}` }]))
      return
    }
    const action = tail.slice('fs:'.length)
    if (!(FS_SUPPORTED as readonly string[]).includes(action)) {
      const msg = unsupportedActionMessage(action, FS_SUPPORTED)
      fail(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, msg, rid,
        [{ path: 'action', message: msg }]))
      return
    }
    const root = (await resolveSessionCwd(ctx, sessionId)) || process.cwd()
    const rel = String(body?.path ?? '')
    const target = safeJoin(root, rel)
    if (target === undefined) {
      fail(res, kimiErr(KimiErrorCode.FS_PATH_ESCAPES_SESSION, `path escapes session root: ${rel}`, rid))
      return
    }
    try {
      await handleFsAction(res, rid, action as (typeof FS_SUPPORTED)[number], root, target, body ?? {})
    } catch (err: any) {
      // handleFsAction 自身不兜底；listDir 抛的 kimiCode 在此保留为真实错误码
      const code = typeof err?.kimiCode === 'number' ? err.kimiCode : KimiErrorCode.INTERNAL_ERROR
      fail(res, kimiErr(code, err?.message || 'fs action failed', rid))
    }
  }, ADMIN)
```

- [ ] **步骤 2：追加 GET 下载路由（紧接步骤 1 代码之后）**

```ts
  // ---------- 会话文件下载（GET /sessions/{id}/fs/*，wildcard 以 :download 结尾） ----------
  // 降级：不支持 Range/206 与 etag/304，全量流 + attachment；失败用真实 HTTP 状态（SDK download() 依赖非 2xx）
  router.get('/api/v1/sessions/:id/fs/*', async (req, res, params) => {
    const gate = await sessionGate(ctx, req, res, auth, params.id)
    if (!gate) return
    const { rid, sessionId } = gate
    let rel = String(params['*'] || '')
    if (rel.endsWith(':download')) rel = rel.slice(0, -':download'.length)
    if (!rel) {
      fail(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, 'path is empty', rid))
      return
    }
    const root = (await resolveSessionCwd(ctx, sessionId)) || process.cwd()
    const target = safeJoin(root, rel)
    if (target === undefined) {
      fail(res, kimiErr(KimiErrorCode.FS_PATH_ESCAPES_SESSION, `path escapes session root: ${rel}`, rid))
      return
    }
    let st: import('node:fs').Stats | undefined
    try { st = await fsp.stat(target) } catch { st = undefined }
    if (!st || !st.isFile()) {
      sendKimiJson(res, kimiErr(KimiErrorCode.FS_PATH_NOT_FOUND, `path not found: ${rel}`, rid), 404)
      return
    }
    res.statusCode = 200
    res.setHeader('Content-Type', lookupMime(path.basename(target)))
    res.setHeader('Content-Length', String(st.size))
    res.setHeader('Content-Disposition', buildContentDisposition(path.basename(target)))
    const stream = createReadStream(target)
    stream.on('error', (err: any) => {
      if (!res.headersSent) {
        sendKimiJson(res, kimiErr(KimiErrorCode.INTERNAL_ERROR, err?.message || 'read failed', rid), 500)
      } else {
        res.destroy()
      }
    })
    stream.pipe(res)
  }, ADMIN)
```

- [ ] **步骤 3：typecheck**

运行：`node_modules/.bin/tsc -p tsconfig.json --noEmit`
预期：仅剩基线 `src/index.ts(35,22) TS2749` 1 个错误；kimi-compat.ts 0 错误。

- [ ] **步骤 4：Commit**

```bash
git add src/kimi-compat.ts
git commit -m "feat(kimi): 补 fs 兼容路由（POST fs 动作 + GET 文件下载）"
```

---

### 任务 2：修 `prompts::steer` pattern 抢占

**文件：**
- 修改：`src/kimi-compat.ts:1274-1292`

背景：`/prompts::steer` pattern 编译为 `/prompts:([^/]+)`，会吞掉 `/prompts:abort`、`/prompts:{pid}:steer` 等单段冒号形态（现 handler 对非 `:steer` 一律 40001）。kap-server 语义（routes/prompts.ts + action-suffix.ts）：`::steer` = 批量 steer；单段冒号形态按单 prompt 动作处理（abort→`{aborted:true}`，steer→`{steered:true,prompt_ids:[id]}`）。

- [ ] **步骤 1：整段替换 L1274-1292 的 handler**

```ts
  router.post('/api/v1/sessions/:id/prompts::steer', async (req, res, params, _q, body) => {
    const gate = await sessionGate(ctx, req, res, auth, params.id)
    if (!gate) return
    const { rid, sessionId } = gate
    // 该 pattern 编译后为 `/prompts:([^/]+)`，会吞掉所有 `/prompts:<x>` 单段冒号形态：
    // ':steer' → 批量 steer；':abort' → 整会话 abort；':<pid>:steer' / ':<pid>:abort' → 单 prompt 动作。
    const colonTail = String((params as any).steer ?? '')
    if (colonTail === ':steer') {
      const ids = Array.isArray(body?.prompt_ids) ? body.prompt_ids.map(String).filter(Boolean) : []
      if (ids.length === 0) {
        fail(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, 'validation failed', rid,
          [{ path: 'prompt_ids', message: 'prompt_ids must be a non-empty array' }]))
        return
      }
      sendKimiJson(res, kimiOk({ steered: true, prompt_ids: ids }, rid))
      return
    }
    const inner = colonTail.startsWith(':') ? colonTail.slice(1) : colonTail
    const sep = inner.lastIndexOf(':')
    const maybeAction = sep > 0 ? inner.slice(sep + 1) : inner
    const promptId = sep > 0 ? inner.slice(0, sep) : ''
    if (maybeAction === 'abort') {
      const aborted = await abortDshSession(ctx, sessionId)
      sendKimiJson(res, kimiOk({ aborted, at_seq: 0 }, rid))
      return
    }
    if (maybeAction === 'steer') {
      if (!promptId) {
        fail(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, 'validation failed', rid,
          [{ path: 'prompt_id', message: 'prompt_id is required for :steer' }]))
        return
      }
      sendKimiJson(res, kimiOk({ steered: true, prompt_ids: [promptId] }, rid))
      return
    }
    fail(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, `unsupported action: prompts${colonTail}`, rid,
      [{ path: 'prompt_id', message: unsupportedActionMessage(maybeAction, ['abort', 'steer']) }]))
  }, ADMIN)
```

- [ ] **步骤 2：复核 `parseActionSuffix` 调用点（只读决策，不改 contract）**

运行：`Grep "parseActionSuffix" src/`（用 Grep 工具）
预期调用点：`kimi-contract.ts` 定义、`kimi-compat.ts` 的 sessions/:tail（L1062）、prompts/:tail（L1299 附近）、questions/:tail。sessions/:tail 对 `bare` 显式回 unsupported（L1068-1072），与 kap-server「无冒号且 defaultAction 存在→bare」语义行为等价。**决策：保持 src/kimi-contract.ts:164-184 现语义不动**（原版 `bare`/`invalid` 分支差异不影响这三处的最终响应）。在计划中记录此决策即可，不改代码。

- [ ] **步骤 3：typecheck**

运行：`node_modules/.bin/tsc -p tsconfig.json --noEmit`
预期：仅剩基线 TS2749。

- [ ] **步骤 4：Commit**

```bash
git add src/kimi-compat.ts
git commit -m "fix(kimi): prompts::steer 路由不再抢占 prompts:abort / :{pid}:steer 单段形态"
```

---

### 任务 3：`src/index.ts` 挂接（配置 + REST 前缀 + WS upgrade）

**文件：**
- 修改：`src/types.ts:152-178`（`WebServiceConfig` 内 `adminRemoteAccess` 之后追加两字段）
- 修改：`src/index.ts`（imports L7-27；Config schema L35-43；apply 内在 `registerApiKeyRoutes` 之后加块；standalone 块 L116-135；info tool L151-162）

- [ ] **步骤 1：`src/types.ts` 加配置字段**

在 `adminRemoteAccess?: boolean`（L169-172 注释块之后）与 `customSkillDirs` 之间追加：

```ts
  /** kimi API 兼容层开关，默认 true */
  kimi?: boolean
  /** kimi 兼容层路由前缀，默认 '/kimi' */
  kimiPrefix?: string
```

- [ ] **步骤 2：`src/index.ts` imports 追加**

在 L27 `import type { WebServiceConfig } from './types.js'` 之后追加：

```ts
import type { Duplex } from 'node:stream'
import { buildKimiWsDeps, registerKimiCompatRoutes } from './kimi-compat.js'
import { handleKimiUpgrade } from './kimi-ws.js'
import { KimiErrorCode, kimiErr, resolveRequestId, sendKimiJson } from './kimi-contract.js'
```

- [ ] **步骤 3：Config schema 加两项（L35-43 的 `z.object({...})` 内，after `adminRemoteAccess` 行）**

```ts
  kimi: z.boolean().default(true).description('kimi API 兼容层开关（REST /kimi + WS）'),
  kimiPrefix: z.string().default('/kimi').description('kimi 兼容层路由前缀'),
```

- [ ] **步骤 4：apply 内挂接（插在 `registerApiKeyRoutes(router, config, keyStore)` 之后、`// 3. 挂载到 DSH 主 Web 服务器` 之前）**

```ts
  // 2.1 kimi API 兼容层：独立前缀下的第二个 router（自带 kimiAuth 闸门，勿 setAuthService）
  let kimiRouter: HttpRouter | null = null
  let kimiPrefix = '/kimi'
  if (config.kimi) {
    kimiPrefix = config.kimiPrefix || '/kimi'
    kimiRouter = new HttpRouter(config)
    registerKimiCompatRoutes(ctx, kimiRouter, { config, keyStore })

    ctx.effect(() => {
      return ctx.webServer.register({
        kind: 'prefix',
        path: kimiPrefix,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const handled = await kimiRouter!.dispatch(req, res, kimiPrefix)
          if (!handled && !res.headersSent) {
            const rid = resolveRequestId(req.headers['x-request-id'] as string | undefined)
            sendKimiJson(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, `Endpoint not found: ${req.url}`, rid), 404)
          }
        },
      })
    }, 'dsh-web-service: kimi compat prefix route')

    // WS：宿主 registerUpgrade 能力探测；缺失则跳过 WS（REST 仍可用）
    const kimiWsPath = `${kimiPrefix}/api/v1/ws`
    const webServer = ctx.get('webServer') as any
    if (typeof webServer?.registerUpgrade === 'function') {
      ctx.effect(() => webServer.registerUpgrade({
        path: kimiWsPath,
        handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => {
          handleKimiUpgrade(req, socket, head, buildKimiWsDeps(ctx, { config, keyStore }))
        },
      }), 'dsh-web-service: kimi ws upgrade')
    } else {
      console.warn('[dsh-web-service] webServer.registerUpgrade 不可用，kimi WS 未启用（REST 仍可用）')
    }
  }
```

- [ ] **步骤 5：standalone server 同步 dispatch + upgrade（注意：kimi 分流必须先于原生 404 回退）**

在 standalone `createServer` 的 404 分支之后（L119-127 之间，紧跟 `const handled = await router.dispatch(...)` 的 `if (!handled...)` 块之后）加：

```ts
        if (kimiRouter) {
          const kimiHandled = await kimiRouter.dispatch(req, res, kimiPrefix)
          if (!kimiHandled && !res.headersSent) {
            const rid = resolveRequestId(req.headers['x-request-id'] as string | undefined)
            sendKimiJson(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, `Endpoint not found: ${req.url}`, rid), 404)
          }
        }
```

并在 `server.listen(...)` 之前加：

```ts
      if (kimiRouter) {
        const kimiWsPath = `${kimiPrefix}/api/v1/ws`
        server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
          let pathname = ''
          try {
            pathname = new URL(req.url || '/', 'http://localhost').pathname
          } catch { /* 保持空串，下方不命中 */ }
          if (pathname !== kimiWsPath) {
            socket.destroy()
            return
          }
          handleKimiUpgrade(req, socket, head, buildKimiWsDeps(ctx, { config, keyStore }))
        })
      }
```

- [ ] **步骤 6：info tool 补 kimiBaseUrl（L151-162 的 `info` 对象内追加）**

```ts
          kimiBaseUrl: config.kimi ? `http://127.0.0.1:${mainPort}${kimiPrefix}` : undefined,
```

- [ ] **步骤 7：typecheck**

运行：`node_modules/.bin/tsc -p tsconfig.json --noEmit`
预期：仅剩基线 `src/index.ts(35,22) TS2749`（本任务改了 index.ts 但未动 L35 的 `z<Config>` 写法，错误保持原样即非回归）。

- [ ] **步骤 8：Commit**

```bash
git add src/index.ts src/types.ts
git commit -m "feat(kimi): 挂接兼容层（kimi/kimiPrefix 配置 + /kimi 前缀 + WS upgrade）"
```

---

### 任务 4：`scripts/smoke-kimi-compat.mjs` 冒烟（REST + WS）

**文件：**
- 创建：`scripts/smoke-kimi-compat.mjs`
- 参照：`scripts/smoke-api-keys.mjs`（模板：L22-28 lib 动态导入、L32-35 check 汇总、L37-56 call、L59-78 真 server、L87-397 try/finally、L399-405 汇总 exit(1)）

- [ ] **步骤 1：编译到临时目录 `.smoke-lib/`（冒烟不依赖陈旧 lib）**

```bash
node_modules/.bin/tsc -p tsconfig.json --outDir .smoke-lib --declaration false --declarationMap false --sourceMap false
```

预期：emit 成功（基线 TS2749 在 index.ts——emit 仍会产出 index.js；若 tsc 因该错误拒绝 emit，则改为加 `--noEmitOnError false`）。

- [ ] **步骤 2：写冒烟脚本骨架（fake ctx + server 装配）**

脚本头部（imports / check / call 照搬 smoke-api-keys.mjs 模式），关键差异在装配：

```js
const ROOT = new URL('..', import.meta.url).pathname
const { HttpRouter } = await import(path.join(ROOT, '.smoke-lib/router.js'))
const { ApiKeyStore } = await import(path.join(ROOT, '.smoke-lib/api-keys-store.js'))
const { registerKimiCompatRoutes, buildKimiWsDeps } = await import(path.join(ROOT, '.smoke-lib/kimi-compat.js'))
const { handleKimiUpgrade } = await import(path.join(ROOT, '.smoke-lib/kimi-ws.js'))

const KIMI = '/kimi'
const results = []
function check(name, ok, detail) { /* 同 smoke-api-keys.mjs L32-35 */ }

// ---- fake ctx：Map 服务 + 可触发/退订的 session/event 注册表 ----
const listeners = new Map() // event -> Set<fn>
const sessions = new Map()  // sid -> { id, header: { cwd, title }, createdAt, updatedAt, running }
const workspaces = [{ id: 'ws_main', path: await mkdtemp(path.join(tmpdir(), 'kimi-ws-')) }]
await writeFile(path.join(workspaces[0].path, 'hello.txt'), 'hello kimi\n')

const fakeCtx = {
  get(name) { return services.get(name) },
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(fn)
    return () => listeners.get(event)?.delete(fn)
  },
  effect(fn) { return fn() }, // 冒烟无 cordis 生命周期：立即执行，返回值忽略
  emit(event, ...args) { for (const fn of listeners.get(event) ?? []) fn(...args) },
}
const services = new Map(Object.entries({
  sessionController: {
    list: async () => [...sessions.values()].map((s) => ({ id: s.id, meta: { title: s.header.title }, createdAt: s.createdAt, updatedAt: s.updatedAt })),
    inspect: async (id) => sessions.has(id) ? { meta: { cwd: sessions.get(id).header.cwd, title: sessions.get(id).header.title } } : undefined,
    create: async (opts) => { const id = 'ses_smoke' + randomBytes(4).toString('hex'); sessions.set(id, { id, header: { cwd: opts?.cwd || workspaces[0].path, title: opts?.title || 'smoke' }, createdAt: Date.now(), updatedAt: Date.now(), running: false }); return { id } },
    rename: async () => true,
    selectModel: async () => true,
    cancel: async (id) => { const s = sessions.get(id); if (s) s.running = false; return true },
  },
  sessions: { get: (id) => sessions.get(id) },
  agents: new Map(),
  workspaceRegistry: { list: () => workspaces, resolve: (p) => workspaces.find((w) => w.path === p) },
  permissionPresets: { list: () => [] },
}))
```

注：上面是 fake 的**最小完备面**。若某条路由 500 且堆栈显示 `svc(ctx,'xxx')` 为 undefined，按 kimi-compat.ts 内 `svc(` 的调用清单补对应方法（先 `Grep "svc(ctx" src/kimi-compat.ts` 列全），逐个补到 services。这是预期内的迭代，不算计划外工作。

server 装配：

```js
const home = await mkdtemp(path.join(tmpdir(), 'dsh-kimi-smoke-'))
const store = new ApiKeyStore('', home)
await store.ensureReady()
const config = { pathPrefix: '/api/v1', cors: true, maxUploadBytes: 1024 * 1024 }
const router = new HttpRouter(config)
registerKimiCompatRoutes(fakeCtx, router, { config, keyStore: store })
const server = createServer(async (req, res) => {
  const handled = await router.dispatch(req, res, KIMI)
  if (!handled && !res.headersSent) { res.statusCode = 404; res.end('not found') }
})
server.on('upgrade', (req, socket, head) => {
  let pathname = ''
  try { pathname = new URL(req.url || '/', 'http://localhost').pathname } catch {}
  if (pathname !== `${KIMI}/api/v1/ws`) { socket.destroy(); return }
  handleKimiUpgrade(req, socket, head, buildKimiWsDeps(fakeCtx, { config, keyStore: store }))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
```

- [ ] **步骤 3：REST 断言块（按序写入 try{}）**

```js
const call = async (method, p, { token, body, raw } = {}) => { /* 同 smoke-api-keys.mjs L37-56，base 为 KIMI；raw 时 body 为 Buffer + 自定义 content-type */ }

// 建会话
let r = await call('POST', `${KIMI}/api/v1/sessions`, { body: { cwd: workspaces[0].path, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } } })
check('建会话 → 信封 code=0', r.body?.code === 0, `code=${r.body?.code}`)
const sid = r.body?.data?.id
```

需要**先读** `src/kimi-compat.ts` 的 `POST /api/v1/sessions` handler（L939-1041）与 `wireSessionFull`，把上面 body 形状对齐其实际读取的字段（cwd/message 字段名以源码为准）。随后断言：

```js
r = await call('GET', `${KIMI}/api/v1/sessions/${sid}`)
check('会话详情 → code=0 且 id 回显', r.body?.code === 0 && r.body?.data?.id === sid)

r = await call('POST', `${KIMI}/api/v1/sessions/${sid}/fs:list`, { body: { path: '.' } })
check('fs:list → entries 含 hello.txt', r.body?.code === 0 && (r.body?.data?.entries ?? []).some((e) => e.name === 'hello.txt'), `code=${r.body?.code} msg=${r.body?.msg}`)

r = await call('POST', `${KIMI}/api/v1/sessions/${sid}/fs:read`, { body: { path: 'hello.txt' } })
check('fs:read → content 匹配', r.body?.code === 0 && r.body?.data?.content === 'hello kimi\n')

r = await call('POST', `${KIMI}/api/v1/sessions/${sid}/fs:remove`, { body: { path: 'hello.txt' } })
check('fs:remove 不支持 → 40001', r.body?.code === 40001, `code=${r.body?.code}`)

r = await call('POST', `${KIMI}/api/v1/sessions/${sid}/bogus`, { body: {} })
check('非 fs tail → unsupported action 40001', r.body?.code === 40001)

r = await call('POST', `${KIMI}/api/v1/sessions/${sid}/fs:read`, { body: { path: '../etc/passwd' } })
check('路径越界 → 41304', r.body?.code === 41304, `code=${r.body?.code}`)

r = await call('GET', `${KIMI}/api/v1/sessions/${sid}/fs/hello.txt:download`)
check('fs 下载 → 200 + attachment', r.status === 200 && String(r.raw.headers.get('content-disposition')).includes('attachment'))

r = await call('GET', `${KIMI}/api/v1/sessions/${sid}/fs/nope.txt:download`)
check('下载缺失 → 真实 404 + 40409', r.status === 404 && r.body?.code === 40409, `status=${r.status}`)

r = await call('POST', `${KIMI}/api/v1/sessions/${sid}/prompts::steer`, { body: { prompt_ids: ['p1', 'p2'] } })
check('批量 steer → steered:true', r.body?.code === 0 && r.body?.data?.steered === true)

r = await call('POST', `${KIMI}/api/v1/sessions/${sid}/prompts:abort`, { body: {} })
check('prompts:abort 不再被 ::steer 抢占 → aborted', r.body?.code === 0 && r.body?.data?.aborted === true, `code=${r.body?.code} msg=${r.body?.msg}`)

r = await call('POST', `${KIMI}/api/v1/sessions/${sid}/prompts:p123:steer`, { body: {} })
check('prompts:{pid}:steer → prompt_ids=[pid]', r.body?.code === 0 && JSON.stringify(r.body?.data?.prompt_ids) === JSON.stringify(['p123']), JSON.stringify(r.body?.data))

// 鉴权：开启后 401/429
await store.setAuthEnabled(true)
const created = await store.create({ name: 'smoke' })
r = await call('GET', `${KIMI}/api/v1/sessions`)
check('鉴权开启 + 无 token → 401/40101', r.status === 401 && r.body?.code === 40101, `status=${r.status}`)
r = await call('GET', `${KIMI}/api/v1/sessions`, { token: created.plaintext })
check('有效 token → 200 code=0', r.status === 200 && r.body?.code === 0)
for (let i = 0; i < 11; i++) await call('GET', `${KIMI}/api/v1/sessions`, { token: 'bad' })
r = await call('GET', `${KIMI}/api/v1/sessions`, { token: created.plaintext })
check('失败限流 → 429/42901', r.status === 429 && r.body?.code === 42901, `status=${r.status}`)
await store.setAuthEnabled(false)

// transcript seq 与 buildTranscriptOps 一致（同源不变量）
const { buildTranscriptOps, replayTranscript } = await import(path.join(ROOT, '.smoke-lib/kimi-events.js'))
const fakeEvents = [ /* 3-4 条人工构造的 DSH session/event，形状照 src/kimi-events.ts 的 toKimiEvent 输入（先读该文件头部的类型注释） */ ]
const ops = buildTranscriptOps(fakeEvents)
r = await call('GET', `${KIMI}/api/v1/sessions/${sid}/transcript/ops`)
check('transcript/ops seq 逐 1 连续', Array.isArray(ops) && ops.every((o, i) => o.seq === i + 1), `ops=${ops.length}`)

// v2 列表
r = await call('GET', `${KIMI}/api/v2/sessions?page_size=10`)
check('v2 列表 → items/total/has_more', r.body?.code === 0 && Array.isArray(r.body?.data?.items) && typeof r.body?.data?.total === 'number')
```

注：两处「先读」是强制步骤——`POST /sessions` body 形状与 fakeEvents 形状必须以源码为准，不许猜。

- [ ] **步骤 4：WS 断言块（Node 24 内置 WebSocket，WS 路径与协议先读 src/kimi-ws.ts 的帧处理）**

```js
const { WebSocket } = globalThis
function wsConnect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}${KIMI}/api/v1/ws`, ['kimi-code.bearer.' + token])
    const inbox = []
    const waiters = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      inbox.push(msg)
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(msg)) { waiters[i].resolve(msg); waiters.splice(i, 1) }
      }
    })
    ws.addEventListener('open', () => resolve({
      ws, inbox,
      next: (pred, ms = 3000) => {
        const hit = inbox.find(pred)
        if (hit) return Promise.resolve(hit)
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('ws timeout')), ms)
          waiters.push({ pred, resolve: (m) => { clearTimeout(t); res(m) } })
        })
      },
      send: (obj) => ws.send(JSON.stringify(obj)),
    }))
    ws.addEventListener('error', reject)
  })
}

const bad = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}${KIMI}/api/v1/ws`, ['kimi-code.bearer.wrong'])
  ws.addEventListener('error', () => resolve(true))
  ws.addEventListener('open', () => { ws.close(); resolve(false) })
})
check('WS 错 token → 连接被拒', bad === true)

const c = await wsConnect(created?.plaintext ?? '')
const hello = await c.next((m) => m.type === 'server_hello')
check('server_hello protocol_version=2', hello.protocol_version === 2, JSON.stringify(hello))

c.send({ type: 'subscribe', session_id: sid }) // 消息字段名以 src/kimi-ws.ts 为准
const ack = await c.next((m) => String(m.type).includes('subscribed') || m.type === 'error')
check('subscribe ack', ack.type !== 'error', JSON.stringify(ack))

c.send({ type: 'subscribe_v2', session_id: sid }) // 同上，先读源码确认字段
const reset = await c.next((m) => m.type === 'transcript.reset' || m.type === 'transcript.ops')
check('subscribe_v2 → reset 或 ops（无游标）', reset.type === 'transcript.reset' || reset.type === 'transcript.ops')

// 注入 fake 事件 → transcript.ops seq 逐 1
fakeCtx.emit('session/event', { id: sid }, fakeEvents[0])
const op1 = await c.next((m) => m.type === 'transcript.ops')
const seqs = (op1.ops ?? op1.data?.ops ?? []).map((o) => o.seq)
check('WS ops seq 逐 1', seqs.length > 0 && seqs.every((s, i) => s === seqs[0] + i), JSON.stringify(seqs))
c.ws.close()
```

`transcript.reset`/`transcript.ops` 的载荷字段名（`ops` vs `data.ops`）以 src/kimi-ws.ts 实际发送为准；epoch 不符→`resync_required` 的断言可用「伪造错误 epoch 的 deps 再起一个 wsConnect 对」验证（构造一个 `buildKimiWsDeps` 返回值改 `epoch` 字段后再注册 upgrade 的临时 server 实例，或直接在第二次 connect 前 monkey-patch deps——任选其一，断言收到 `resync_required` 即可）。

- [ ] **步骤 5：运行冒烟**

```bash
node scripts/smoke-kimi-compat.mjs
```

预期：全部 PASS，末尾 `==== N/N 通过 ====`；失败时加载 `diagnose` 技能定位（最可能踩坑：fake ctx 缺服务、WS 帧字段名、fakeEvents 形状）。

- [ ] **步骤 6：清理 + Commit**

```bash
rm -rf .smoke-lib
git add scripts/smoke-kimi-compat.mjs
git commit -m "test(kimi): 兼容层端到端冒烟（REST 信封/分页/fs/steer/限流 + WS 协议）"
```

---

### 任务 5：文档（README / README.zh / SKILL.md）

**文件：**
- 修改：`README.md`、`README.zh.md`、`skills/dsh-web-service/SKILL.md`（三者均已有合法未提交改动，**增量**补章节，勿回滚既有内容）

- [ ] **步骤 1：读三个文件现有结构，找插入点**

用 Grep 找各文件的「功能特性 / Features」章节标题，kimi 章节插在其后。先读再写，保持各文件原有排版风格。

- [ ] **步骤 2：README.zh.md 插入章节（中文内容如下，英文版按同结构翻译）**

```markdown
## Kimi API 兼容层

挂载在独立前缀（默认 `/kimi`，配置项 `kimiPrefix`）下的 kimi 本地服务（kap-server）API 兼容层，可用 kimi 官方 SDK 直连：

```js
import { KimiClient } from '@kimi-code/sdk' // 以实际 SDK 包名为准
const client = new KimiClient({ baseUrl: 'http://127.0.0.1:3080/kimi', apiKey: '<data key>' })
```

- 开关：`kimi`（默认 `true`）；前缀：`kimiPrefix`（默认 `/kimi`）
- 鉴权：复用 API Key 体系；未开启鉴权时匿名可用，WS 走 `kimi-code.bearer.<token>` 子协议
- REST：`/kimi/api/v1/**`（信封 `{code,msg,data,request_id,details}`，业务失败 HTTP 200 + 非零 code）与 `/kimi/api/v2/sessions`
- WS：`/kimi/api/v1/ws`（server_hello protocol_version=2；subscribe/subscribe_v2）
- fs 动作支持子集：`list / stat / read / mkdir / search / grep`；文件下载 `GET /sessions/{id}/fs/*`（暂不支持 Range/etag）
- 降级语义（DSH 无对应能力，如实返回错误码）：`approvals`（空列表/40404）、`fork`（新建同工作区会话，不复制历史）、`compact`（40910）、`undo`（40911）、`btw`（60002）、`add-dir`（60002）、`title-generate`（60002）
- 宿主需支持 `webServer.registerUpgrade` 才启用 WS；缺失时仅 REST 可用（启动日志有警告）
```

（README.md 用英文版，SKILL.md 用简版要点 + 指回 README。）

- [ ] **步骤 3：Commit**

```bash
git add README.md README.zh.md skills/dsh-web-service/SKILL.md
git commit -m "docs(kimi): 补 kimi 兼容层章节（配置/端点/降级语义）"
```

---

### 任务 6：收尾（删临时 tsconfig、重出 lib、全量校验）

**文件：**
- 删除：`tsconfig.check.json`、`tsconfig.kimi.json`
- 重新生成：`lib/**`（tsc emit）

- [ ] **步骤 1：删临时配置**

```bash
rm tsconfig.check.json tsconfig.kimi.json
git status --short | grep tsconfig  # 预期无输出（两文件若从未被 git 跟踪则无删除可提交；若被跟踪则 git add -A 提交删除）
```

- [ ] **步骤 2：重新 emit lib（与 src 同步，含任务 1-3 的改动）**

```bash
node_modules/.bin/tsc -p tsconfig.json
```

预期：emit 成功；`git status --short` 显示 `lib/kimi-compat.js` 等含新改动（含 fs 路由与 router 通配）。

- [ ] **步骤 3：全量 typecheck + 冒烟回归**

```bash
node_modules/.bin/tsc -p tsconfig.json --noEmit   # 预期仅剩 src/index.ts(35,22) TS2749 基线
node scripts/smoke-api-keys.mjs                    # 既有冒烟不回退（依赖 lib/，步骤 2 已刷新）
node scripts/smoke-kimi-compat.mjs                 # 本任务新增冒烟（会自建 .smoke-lib 并自删）
```

- [ ] **步骤 4：提交 lib 产物**

```bash
git add -A lib
git commit -m "chore(kimi): 重新 emit lib，与 src 同步"
```

- [ ] **步骤 5：最终核对清单（在回复用户时如实声明）**

- 未验证项：① WS/REST 未经真实 DSH 宿主验证（仅冒烟级 fake ctx）；② approvals/fork/compact/undo/btw/add-dir/children 为降级语义；③ `webServer.registerUpgrade` 存在性是假设（已做能力探测）；④ `npm run build` 完整链路未跑（仅 tsc emit 级验证）。
- `git status` 应只剩本轮之前就存在的合法未提交改动（INSTALL.md/README 等在任务 5 提交后应干净）。

---

## 自检记录

**1. 规格覆盖度**（对照交接文档 §2）：fs 路由缺失→任务 1；steer 抢占→任务 2（含 parseActionSuffix 语义复核，决策=不改 contract）；index.ts 挂接→任务 3；冒烟→任务 4；文档→任务 5；收尾（删 tsconfig/重出 lib/typecheck）→任务 6。全覆盖。

**2. 占位符扫描**：任务 4 有两处「先读源码确认形状」——这是方向性指令而非实现留白（执行者必须读 `POST /sessions` handler 与 `kimi-ws.ts` 帧格式后填具体字段，因为这两处形状写死会必然写错）；其余步骤均含完整代码与命令。

**3. 类型一致性**：`handleFsAction` 第 3 参类型为字面量联合，任务 1 用 `as (typeof FS_SUPPORTED)[number]` 收窄一致；`sessionGate` 返回 `{rid, sessionId}` 在所有新 handler 中一致使用；任务 3 的 `kimiRouter`/`kimiPrefix` 变量名在 standalone 块复用一致；`buildKimiWsDeps(ctx, {config, keyStore})` 与 `KimiCompatOptions` 字段一致（`serverVersion` 可选，不传）。
