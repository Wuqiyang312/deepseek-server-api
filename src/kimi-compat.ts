/**
 * dsh-web-service — Kimi 服务 API 兼容层：REST 路由 + WS 依赖装配
 *
 * 把 kap-server（kimi 本地 web 服务）的 REST 协议复刻到 DSH 插件里：路径挂在独立的
 * `kimiPrefix`（默认 `/kimi`）之下，SDK 拼在 baseUrl 后的 `/api/v1/...`、`/api/v2/...`
 * 全部由本文件注册。响应走 kimi 信封 `{code,msg,data,request_id,details?}`，业务失败也回
 * HTTP 200 + 非零 code；只有鉴权（401/429）与文件流（404）用真实 HTTP 状态。
 *
 * 所有 DSH 宿主能力经 `ctx.get(...)` 取值并 `as any` + 能力探测；宿主缺位一律 try/catch
 * 回 50001，绝不让兼容层抛穿。workspace id 因 kimi 有 `wd_<slug>_<hash12>` 格式约束，
 * 这里维护 DSH id ↔ kimi 别名的双向映射；session id 无格式约束直接透传。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { HttpRouter } from './router.js'
import type { WebServiceConfig } from './types.js'
import {
  KimiErrorCode,
  isoTime,
  kimiErr,
  kimiErrWithData,
  kimiOk,
  kimiUlid,
  pageByCursor,
  parseActionSuffix,
  parseBoolQuery,
  parseCursorQuery,
  resolveRequestId,
  sendKimiJson,
  unsupportedActionMessage,
  type KimiEnvelope,
} from './kimi-contract.js'
import {
  KIMI_MAIN_AGENT_ID,
  buildTranscriptOps,
  foldMessages,
  foldTranscript,
  paginateTurns,
  promptContentToText,
  transcriptOpsSince,
} from './kimi-events.js'
import {
  applySessionPermission,
  foldSessionStats,
  liveRunningState,
  loadSessionEvents,
  readSessionPermission,
} from './sessions.js'
import {
  lookupMime,
  parseMultipart,
  resolveSessionCwd,
  safeJoin,
  sanitizeFilename,
  uniqueTarget,
} from './files.js'
import {
  askSessionStorage,
  listPendingBatches,
  rejectPendingBatchById,
  resolvePendingBatchById,
} from './user-questions.js'
import { submitPromptToSession } from './streaming.js'
import { FailureRateLimiter, type ApiKeyStore } from './api-keys-store.js'
import { kimiWsBroadcast, type KimiWsDeps } from './kimi-ws.js'
import { pluginVersion } from './version.js'

/** 进程世代 id：WS 事件流 epoch，客户端 cursor 的 epoch 与之不符即触发 resync */
export const KIMI_EPOCH = kimiUlid()

const KIMI_SERVER_ID = kimiUlid()
const KIMI_STARTED_AT = new Date().toISOString()

const DEFAULT_PAGE_SIZE = 20
const DEFAULT_MESSAGE_PAGE_SIZE = 50

// ==================== workspace id 别名 ====================

const WS_ID_RE = /^wd_[a-z0-9._-]+_[0-9a-f]{12}$/

function hash12(seed: string): string {
  return createHash('sha1').update(seed).digest('hex').slice(0, 12)
}

function slugOf(seed: string): string {
  const base = (seed.split(/[\\/]/).pop() || seed).toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
  return base || 'ws'
}

/** DSH workspace id（或任意回落 key）→ kimi `wd_<slug>_<hash12>` 别名（确定性，可重启还原） */
function kimiWorkspaceId(dshId: string): string {
  return `wd_${slugOf(dshId)}_${hash12(dshId)}`
}

const kimiToDshWorkspace = new Map<string, string>()
/** 合成别名（会话无注册工作区时按 cwd 生成）：值存 root 而非 DSH id */
const syntheticWorkspaceRoot = new Map<string, string>()

function rememberWorkspace(dshId: string): string {
  const alias = kimiWorkspaceId(dshId)
  kimiToDshWorkspace.set(alias, dshId)
  return alias
}

function aliasForRoot(root: string): string {
  const alias = kimiWorkspaceId(`root:${root}`)
  syntheticWorkspaceRoot.set(alias, root)
  return alias
}

/** kimi 别名 → { dshId?, root? }；未知返回 undefined */
function resolveKimiWorkspace(ctx: Context, alias: string): { dshId?: string; root?: string } | undefined {
  if (!WS_ID_RE.test(alias)) return undefined
  const dshId = kimiToDshWorkspace.get(alias)
  if (dshId !== undefined) return { dshId }
  const root = syntheticWorkspaceRoot.get(alias)
  if (root !== undefined) return { root }
  // 未知别名：按注册表反查一次（重启后映射丢失的还原路径）
  const registry = ctx.get('workspaceRegistry') as any
  if (registry && typeof registry.list === 'function') {
    try {
      for (const ws of registry.list()) {
        const candidate = rememberWorkspace(String(ws.id))
        if (candidate === alias) return { dshId: String(ws.id), root: String(ws.path) }
      }
    } catch { /* fallthrough */ }
  }
  return undefined
}

// ==================== 会话归档状态（进程内存） ====================

const archivedMemo = new Map<string, number>()

// ==================== 宿主取数helper ====================

type AnyValue = any

function svc(ctx: Context, name: string): AnyValue {
  try {
    return ctx.get(name) as AnyValue
  } catch {
    return undefined
  }
}

function dshSessionIdOf(raw: AnyValue): string {
  return String(raw?.sessionId ?? raw?.id ?? '')
}

/** 会话列表（DSH 原生形状）。宿主不可用 → 抛错由调用方回 50001 */
async function listDshSessions(ctx: Context): Promise<any[]> {
  const controller = svc(ctx, 'sessionController')
  if (controller && typeof controller.list === 'function') {
    const result = await controller.list({}, new AbortController().signal)
    return result?.items || []
  }
  return []
}

/** 会话是否存在（inspect / sessions.get / agents.get 三源取或） */
async function dshSessionExists(ctx: Context, sessionId: string): Promise<boolean> {
  if (!sessionId) return false
  const sessionsService = svc(ctx, 'sessions')
  try {
    if (sessionsService?.get && sessionsService.get(sessionId)) return true
  } catch { /* fallthrough */ }
  const agentsService = svc(ctx, 'agents')
  try {
    if (agentsService?.get && agentsService.get(sessionId)) return true
  } catch { /* fallthrough */ }
  const controller = svc(ctx, 'sessionController')
  if (controller && typeof controller.inspect === 'function') {
    try {
      const inspected = await controller.inspect(sessionId, new AbortController().signal)
      return Boolean(inspected)
    } catch { /* fallthrough */ }
  }
  return false
}

/** 会话元数据（标题/时间/cwd 等；inspect 与 live session 双源合并） */
async function dshSessionMeta(ctx: Context, sessionId: string): Promise<AnyValue | undefined> {
  let meta: AnyValue = undefined
  const controller = svc(ctx, 'sessionController')
  if (controller && typeof controller.inspect === 'function') {
    try {
      const inspected = await controller.inspect(sessionId, new AbortController().signal)
      meta = inspected?.meta
    } catch { /* fallthrough */ }
  }
  const sessionsService = svc(ctx, 'sessions')
  try {
    const live = sessionsService?.get ? sessionsService.get(sessionId) : undefined
    if (live?.header) meta = { ...(meta || {}), ...(typeof live.header === 'object' ? live.header : {}) }
  } catch { /* fallthrough */ }
  return meta
}

/** DSH workspace id →（若存在）反查会话所属工作区 */
function workspaceIdForSession(ctx: Context, sessionId: string): string | undefined {
  const registry = svc(ctx, 'workspaceRegistry')
  if (!registry || typeof registry.list !== 'function') return undefined
  try {
    for (const ws of registry.list()) {
      const ids = ws.sessionIds
      if (!ids) continue
      for (const sid of ids) if (String(sid) === sessionId) return String(ws.id)
    }
  } catch { /* fallthrough */ }
  return undefined
}

function workspacePathById(ctx: Context, dshId: string | undefined): string | undefined {
  if (!dshId) return undefined
  const registry = svc(ctx, 'workspaceRegistry')
  try {
    const ws = registry?.get?.(dshId)
    return ws ? String(ws.path) : undefined
  } catch {
    return undefined
  }
}

/** 会话当前模型选择：{provider, model, reasoningEffort} 或 undefined */
function sessionModelSelection(ctx: Context, sessionId: string): AnyValue {
  const controller = svc(ctx, 'sessionController')
  const agentsService = svc(ctx, 'agents')
  try {
    const agent = agentsService?.get ? agentsService.get(sessionId) : undefined
    if (agent && controller?.agents?.selectionFor) {
      return controller.agents.selectionFor(agent)?.current ?? undefined
    }
  } catch { /* fallthrough */ }
  return undefined
}

function modelStringOf(selection: AnyValue): string | undefined {
  if (!selection) return undefined
  const model = String(selection.model || '')
  if (!model) return undefined
  return selection.provider ? `${selection.provider}/${model}` : model
}

function lastTurnReasonOf(events: any[]): 'completed' | 'cancelled' | 'failed' | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]
    if (ev?.type !== 'turn/end') continue
    switch (String(ev?.data?.reason ?? '')) {
      case 'completed': return 'completed'
      case 'cancelled':
      case 'canceled':
      case 'interrupted':
      case 'aborted': return 'cancelled'
      case 'failed':
      case 'error':
      case 'blocked': return 'failed'
      default: return undefined
    }
  }
  return undefined
}

function lastUserPromptOf(events: any[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]
    if (ev?.type !== 'user/message') continue
    const content = ev?.data?.content
    const text = Array.isArray(content)
      ? content.filter((c: any) => c?.type === 'text').map((c: any) => String(c.text ?? '')).join('\n')
      : typeof content === 'string' ? content : ''
    if (text) return text.length > 2000 ? `${text.slice(0, 2000)}…` : text
  }
  return undefined
}

/** 事件里的最后一次 token 账本（近似 context_tokens） */
function contextTokensOf(events: any[]): number {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]
    const usage = ev?.type === 'assistant/message' ? ev?.data?.usage : ev?.type === 'usage' ? (ev?.data?.usage ?? ev?.data) : undefined
    if (!usage || typeof usage !== 'object') continue
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
    const total = num(usage.inputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens) + num(usage.outputTokens)
    if (total > 0) return total
  }
  return 0
}

function usageOfEvents(events: any[]): Record<string, number> {
  const stats = foldSessionStats(events)
  const maxSeq = events.reduce((m: number, ev: any) => (typeof ev?.seq === 'number' && ev.seq > m ? ev.seq : m), 0)
  return {
    input_tokens: stats.usage.inputTokens,
    output_tokens: stats.usage.outputTokens,
    cache_read_tokens: stats.usage.cacheReadTokens,
    cache_creation_tokens: stats.usage.cacheWriteTokens,
    total_cost_usd: 0,
    context_tokens: contextTokensOf(events),
    context_limit: 0,
    turn_count: stats.turns,
    // 附带水位（buildWireSession 消费后剥离）
    __last_seq: maxSeq,
  }
}

function pendingInteractionOf(ctx: Context, sessionId: string): 'none' | 'question' {
  try {
    return listPendingBatches(sessionId).length > 0 ? 'question' : 'none'
  } catch {
    void ctx
    return 'none'
  }
}

export interface KimiWireSessionInput {
  id: string
  title?: string
  createdAt?: number
  updatedAt?: number
  /** DSH workspace id（可选；缺省时用 cwd 合成别名） */
  dshWorkspaceId?: string
  cwd?: string
  busy?: boolean
  events?: any[]
  /** 列表投影：不加载事件、usage/seq 全零 */
  lite?: boolean
  model?: string
}

/** 组装 kimi `sessionSchema` 形状的 wire 对象（字段逐条对齐 kap-server toWireSession） */
function buildWireSession(ctx: Context, input: KimiWireSessionInput): Record<string, unknown> {
  const events = input.events ?? []
  const cwd = input.cwd
    || (input.dshWorkspaceId ? workspacePathById(ctx, input.dshWorkspaceId) : undefined)
    || (input.id ? resolveSessionCwdSync(ctx, input.id) : undefined)
    || process.cwd()
  const workspaceAlias = input.dshWorkspaceId ? rememberWorkspace(input.dshWorkspaceId) : aliasForRoot(cwd)
  const createdAt = typeof input.createdAt === 'number' ? input.createdAt : Date.now()
  const updatedAt = typeof input.updatedAt === 'number' ? input.updatedAt : createdAt

  const archivedAt = archivedMemo.get(input.id)
  let usage = emptyUsage()
  let lastSeq = 0
  let messageCount = 0
  if (!input.lite) {
    usage = usageOfEvents(events)
    lastSeq = usage.__last_seq
    delete usage.__last_seq
    messageCount = foldMessages(events, input.id).length
  }

  const session: Record<string, unknown> = {
    id: input.id,
    workspace_id: workspaceAlias,
    title: input.title || '',
    created_at: isoTime(createdAt),
    updated_at: isoTime(updatedAt),
    busy: Boolean(input.busy),
    main_turn_active: Boolean(input.busy),
    pending_interaction: pendingInteractionOf(ctx, input.id),
    archived: archivedAt !== undefined ? true : undefined,
    archived_at: archivedAt === undefined ? undefined : isoTime(archivedAt),
    metadata: { cwd },
    agent_config: { model: input.model ?? '' },
    usage,
    permission_rules: [],
    message_count: messageCount,
    last_seq: lastSeq,
  }
  const reason = input.lite ? undefined : lastTurnReasonOf(events)
  if (reason !== undefined) session.last_turn_reason = reason
  if (!input.lite) {
    const lastPrompt = lastUserPromptOf(events)
    if (lastPrompt !== undefined) session.last_prompt = lastPrompt
  }
  // 未定义的可选字段从对象剔除，避免信封里出现 null 噪声
  for (const key of ['archived', 'archived_at', 'last_turn_reason', 'last_prompt']) {
    if (session[key] === undefined) delete session[key]
  }
  return session
}

function emptyUsage(): Record<string, number> {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_cost_usd: 0,
    context_tokens: 0,
    context_limit: 0,
    turn_count: 0,
  }
}

function resolveSessionCwdSync(ctx: Context, sessionId: string): string | undefined {
  // resolveSessionCwd 是异步的；这里同步版只走注册表反查，异步兜底由调用方补齐
  const wsId = workspaceIdForSession(ctx, sessionId)
  return wsId ? workspacePathById(ctx, wsId) : undefined
}

// ==================== 鉴权 ====================

export interface KimiAuthDeps {
  keyStore: ApiKeyStore
  limiter: FailureRateLimiter
}

function clientIp(req: IncomingMessage): string {
  return req.socket?.remoteAddress || 'unknown'
}

function bearerToken(req: IncomingMessage): string {
  const auth = req.headers['authorization']
  if (typeof auth === 'string' && auth.startsWith('Bearer ') && auth.slice(7).trim()) {
    return auth.slice(7).trim()
  }
  const xApiKey = req.headers['x-api-key']
  if (typeof xApiKey === 'string') return xApiKey.trim()
  return ''
}

/**
 * kimi 路由自带鉴权闸（路由注册为 auth:'admin' 绕过 router 数据面，统一在此收口）：
 * 未启用密钥时放行；失败限流按 IP 10 次/60s。返回 rid；已回复则返回 null。
 */
async function kimiAuth(req: IncomingMessage, res: ServerResponse, deps: KimiAuthDeps): Promise<string | null> {
  const rid = resolveRequestId(req.headers['x-request-id'] as string | undefined)
  const ip = clientIp(req)
  const { keyStore, limiter } = deps
  try {
    await keyStore.ensureReady()
  } catch { /* fail-closed：isEnforced 在降级态返回 true */ }
  if (!keyStore.isEnforced()) return rid
  if (limiter.isLimited(ip)) {
    sendKimiJson(res, kimiErr(KimiErrorCode.AUTH_RATE_LIMIT, 'too many failed attempts', rid), 429)
    return null
  }
  const token = bearerToken(req)
  let verdict = { ok: false as boolean }
  try {
    verdict = keyStore.verifyDataToken(token)
  } catch {
    verdict = { ok: false }
  }
  if (!token || !verdict.ok) {
    limiter.record(ip)
    sendKimiJson(res, kimiErr(KimiErrorCode.AUTH_UNAUTHORIZED, 'Unauthorized', rid), 401)
    return null
  }
  return rid
}

// ==================== 通用小工具 ====================

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  query: Record<string, string>,
  body: any,
) => Promise<void> | void

function fail<T>(res: ServerResponse, envelope: KimiEnvelope<T>, httpStatus = 200): void {
  sendKimiJson(res, envelope as KimiEnvelope<unknown>, httpStatus)
}

/** 会话级端点统一入口：鉴权 + 存在性校验；通过返回 {rid, sessionId} */
async function sessionGate(
  ctx: Context,
  req: IncomingMessage,
  res: ServerResponse,
  auth: KimiAuthDeps,
  rawTail: string,
): Promise<{ rid: string; sessionId: string } | null> {
  const rid = await kimiAuth(req, res, auth)
  if (rid === null) return null
  const sessionId = rawTail
  if (!sessionId || !(await dshSessionExists(ctx, sessionId))) {
    fail(res, kimiErr(KimiErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`, rid))
    return null
  }
  return { rid, sessionId }
}

function safeParseJson(value: string | undefined, fallback: unknown): unknown {
  if (value === undefined) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

/** 转录 agent_id 校验（kap-server isPlainAgentId 同语义） */
const AGENT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/
function validAgentId(value: unknown): value is string {
  return typeof value === 'string' && AGENT_ID_RE.test(value) && value !== '.' && value !== '..'
}

/** kimi 权限模式 → DSH preset；auto 依 available 名单探测，未知不落 */
const KIMI_PRESET_BY_MODE: Record<string, string> = {
  manual: 'ask', // ask → workspace-write（PRESET_ALIASES）
  yolo: 'full-access', // → danger-full-access
}

async function applyPermissionMode(ctx: Context, sessionId: string, mode: string): Promise<boolean> {
  let target = KIMI_PRESET_BY_MODE[mode]
  if (mode === 'auto') {
    const view = await readSessionPermission(ctx, sessionId)
    if ('error' in view) return false
    const hit = view.available.find((n) => n.toLowerCase().includes('auto'))
    if (!hit) return false
    target = hit
  }
  if (!target) return false
  const applied = await applySessionPermission(ctx, sessionId, target)
  return !('error' in applied)
}

// ==================== fs walk（受限目录遍历） ====================

const FS_SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__', '.next', 'dist', 'build'])
const FS_WALK_MAX_ENTRIES = 20000
const FS_TEXT_MAX_BYTES = 1024 * 1024

interface WalkVisitor {
  (file: string, rel: string): Promise<boolean | void>
}

async function walkFiles(root: string, visit: WalkVisitor): Promise<boolean> {
  let count = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!FS_SKIP_DIRS.has(entry.name)) stack.push(path.join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      count += 1
      if (count > FS_WALK_MAX_ENTRIES) return true
      const full = path.join(dir, entry.name)
      const stop = await visit(full, path.relative(root, full))
      if (stop === true) return true
    }
  }
  return false
}

async function statEntry(root: string, rel: string): Promise<Record<string, unknown> | undefined> {
  const target = safeJoin(root, rel)
  if (target === undefined) return undefined
  let st: import('node:fs').Stats
  try {
    st = await fsp.stat(target)
  } catch {
    return undefined
  }
  return {
    name: path.basename(target),
    path: path.relative(root, target).split(path.sep).join('/'),
    type: st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other',
    size: st.size,
    modified: new Date(st.mtimeMs).toISOString(),
  }
}

// ==================== WS 依赖装配 ====================

export interface KimiCompatOptions {
  config: WebServiceConfig
  keyStore: ApiKeyStore
  /** DSH webServer 不可用时（standalone）由 index.ts 传入的服务端口，用于 /meta 提示 */
  serverVersion?: string
}

/** 构建 kimi WS 协议所需的宿主依赖（index.ts 的 registerUpgrade / standalone upgrade 共用） */
export function buildKimiWsDeps(ctx: Context, opts: KimiCompatOptions): KimiWsDeps {
  const auth: KimiAuthDeps = { keyStore: opts.keyStore, limiter: authLimiter }
  return {
    epoch: KIMI_EPOCH,
    serverVersion: opts.serverVersion || pluginVersion,
    verifyToken(token: string): { ok: boolean; keyId?: string } {
      // 与 REST 同一闸门：未启用密钥 → 放行匿名；启用 → 必须命中有效 data token
      try {
        if (!opts.keyStore.isEnforced()) return { ok: true }
      } catch { /* fallthrough */ }
      if (!token) return { ok: false }
      try {
        return opts.keyStore.verifyDataToken(token)
      } catch {
        return { ok: false }
      }
    },
    async sessionExists(sessionId: string): Promise<boolean> {
      try {
        return await dshSessionExists(ctx, sessionId)
      } catch {
        return false
      }
    },
    async loadHistory(sessionId: string): Promise<any[]> {
      try {
        return await loadSessionEvents(ctx, sessionId)
      } catch {
        return []
      }
    },
    onSessionEvent(sessionId: string, listener: (event: any) => void): () => void {
      try {
        const off = (ctx as any).on('session/event', (session: any, event: any) => {
          try {
            if (String(session?.id ?? '') !== sessionId) return
            listener(event)
          } catch { /* 单条事件失败不影响连接 */ }
        })
        return typeof off === 'function' ? off : () => {}
      } catch {
        return () => {}
      }
    },
    async abortSession(sessionId: string): Promise<boolean> {
      return abortDshSession(ctx, sessionId)
    },
    warn(message: string, err?: unknown): void {
      console.warn(`[dsh-web-service kimi-ws] ${message}`, err ?? '')
    },
  }
  void auth
}

/** 两级 cancel：sessionController.cancel 优先，agents.get(...).cancel() 兜底 */
async function abortDshSession(ctx: Context, sessionId: string): Promise<boolean> {
  const controller = svc(ctx, 'sessionController')
  if (controller && typeof controller.cancel === 'function') {
    try {
      await controller.cancel({ sessionId })
      return true
    } catch { /* fallthrough */ }
  }
  const agentsService = svc(ctx, 'agents')
  try {
    const agent = agentsService?.get ? agentsService.get(sessionId) : undefined
    if (agent && typeof agent.cancel === 'function') {
      agent.cancel()
      return true
    }
  } catch { /* fallthrough */ }
  return false
}

// ==================== 全局文件存储（POST /files） ====================

const KIMI_FILES_DIR = path.join(os.tmpdir(), 'dsh-kimi-files')
interface StoredFile {
  filePath: string
  name: string
  mediaType: string
  size: number
  createdAt: string
}
const uploadedFiles = new Map<string, StoredFile>()

async function storeUploadedFile(metaId: string, data: Buffer, name: string, mediaType: string): Promise<StoredFile> {
  await fsp.mkdir(KIMI_FILES_DIR, { recursive: true })
  const filePath = path.join(KIMI_FILES_DIR, `${metaId}--${sanitizeFilename(name)}`)
  await fsp.writeFile(filePath, data)
  return { filePath, name, mediaType, size: data.length, createdAt: new Date().toISOString() }
}

// ==================== 路由注册 ====================

/**
 * 把 kimi REST 契约注册进一个独立的 HttpRouter（与原生路由互不干涉）。
 * 路径按 SDK 拼接规则写全 `/api/v1/...`、`/api/v2/...`；挂载前缀由 index.ts 决定。
 */
export function registerKimiCompatRoutes(
  ctx: Context,
  router: HttpRouter,
  opts: KimiCompatOptions,
): void {
  const auth: KimiAuthDeps = { keyStore: opts.keyStore, limiter: authLimiter }
  void auth

  // 框架级失败（JSON 解析失败、handler 抛穿、体过大）也用 kimi 信封表达
  router.setErrorFormatter((res, status, code, message, req) => {
    const rid = resolveRequestId(req?.headers['x-request-id'] as string | undefined)
    const dshToKimi: Record<string, number> = {
      UNAUTHORIZED: KimiErrorCode.AUTH_UNAUTHORIZED,
      PAYLOAD_TOO_LARGE: KimiErrorCode.FILE_TOO_LARGE,
      BAD_REQUEST: KimiErrorCode.REQUEST_MALFORMED,
      INTERNAL_ERROR: KimiErrorCode.INTERNAL_ERROR,
    }
    const env = kimiErr(dshToKimi[code] ?? KimiErrorCode.INTERNAL_ERROR, message, rid)
    sendKimiJson(res, env, status === 401 || status === 413 ? status : 200)
  })

  const ADMIN = { auth: 'admin' as const }

  // ---------- 健康与元信息 ----------
  router.get('/healthz', async (_req, res) => {
    const rid = resolveRequestId(undefined)
    sendKimiJson(res, kimiOk({ ok: true }, rid))
  }, { auth: 'public' })

  router.get('/api/v1/meta', async (req, res) => {
    const rid = await kimiAuth(req, res, auth)
    if (rid === null) return
    sendKimiJson(res, kimiOk({
      server_version: opts.serverVersion || pluginVersion,
      capabilities: {
        websocket: true,
        file_upload: true,
        fs_query: true,
        mcp: false,
        tasks: false,
        terminal: false,
      },
      server_id: KIMI_SERVER_ID,
      started_at: KIMI_STARTED_AT,
      open_in_apps: [],
      dangerous_bypass_auth: false,
      backend: 'v2',
      web_title: 'DSH Kimi Compat',
      experimental_flags: {},
      features: [],
    }, rid))
  }, ADMIN)

  // ---------- workspaces ----------
  router.get('/api/v1/workspaces', async (req, res) => {
    const rid = await kimiAuth(req, res, auth)
    if (rid === null) return
    try {
      const registry = svc(ctx, 'workspaceRegistry')
      const list: any[] = registry && typeof registry.list === 'function' ? registry.list() : []
      const items = list.map((ws) => wireWorkspace(ws))
      sendKimiJson(res, kimiOk({ items }, rid))
    } catch (err: any) {
      fail(res, kimiErr(KimiErrorCode.INTERNAL_ERROR, err?.message || 'workspace list failed', rid))
    }
  }, ADMIN)

  router.post('/api/v1/workspaces', async (req, res, _p, _q, body) => {
    const rid = await kimiAuth(req, res, auth)
    if (rid === null) return
    const root = typeof body?.root === 'string' ? body.root : ''
    if (!root || !path.isAbsolute(root)) {
      fail(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, 'validation failed', rid,
        [{ path: 'root', message: 'root must be an absolute path' }]))
      return
    }
    try {
      let st: import('node:fs').Stats | undefined
      try {
        st = await fsp.stat(root)
      } catch { st = undefined }
      if (!st || !st.isDirectory()) {
        fail(res, kimiErr(KimiErrorCode.FS_PATH_NOT_FOUND, `root ${root} does not exist`, rid))
        return
      }
      const registry = svc(ctx, 'workspaceRegistry')
      if (!registry) {
        fail(res, kimiErr(KimiErrorCode.INTERNAL_ERROR, 'workspace registry unavailable', rid))
        return
      }
      let ws = registry.get ? registry.get(root) : undefined
      if (!ws && typeof registry.resolveByPath === 'function') ws = await registry.resolveByPath(root)
      if (!ws && typeof registry.create === 'function') ws = await registry.create(root)
      if (!ws) {
        fail(res, kimiErr(KimiErrorCode.INTERNAL_ERROR, 'workspace create failed', rid))
        return
      }
      const name = typeof body?.name === 'string' && body.name ? body.name : undefined
      if (name && ws.setTitle) {
        try { await ws.setTitle(name) } catch { /* ignore */ }
      }
      sendKimiJson(res, kimiOk(wireWorkspace(ws), rid))
    } catch (err: any) {
      fail(res, kimiErr(KimiErrorCode.INTERNAL_ERROR, err?.message || 'workspace create failed', rid))
    }
  }, ADMIN)

  router.patch('/api/v1/workspaces/:id', async (req, res, params, _q, body) => {
    const rid = await kimiAuth(req, res, auth)
    if (rid === null) return
    const ref = resolveKimiWorkspace(ctx, params.id)
    const ws = dshWorkspace(ctx, ref)
    if (!ws) {
      fail(res, kimiErr(KimiErrorCode.WORKSPACE_NOT_FOUND, `workspace ${params.id} does not exist`, rid))
      return
    }
    const name = typeof body?.name === 'string' ? body.name : ''
    if (!name || name.length > 100) {
      fail(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, 'validation failed', rid,
        [{ path: 'name', message: 'name must be a non-empty string of at most 100 chars' }]))
      return
    }
    try {
      if (ws.setTitle) await ws.setTitle(name)
      sendKimiJson(res, kimiOk(wireWorkspace(ws), rid))
    } catch (err: any) {
      fail(res, kimiErr(KimiErrorCode.INTERNAL_ERROR, err?.message || 'workspace update failed', rid))
    }
  }, ADMIN)

  router.delete('/api/v1/workspaces/:id', async (req, res, params) => {
    const rid = await kimiAuth(req, res, auth)
    if (rid === null) return
    const ref = resolveKimiWorkspace(ctx, params.id)
    const ws = dshWorkspace(ctx, ref)
    if (!ws) {
      fail(res, kimiErr(KimiErrorCode.WORKSPACE_NOT_FOUND, `workspace ${params.id} does not exist`, rid))
      return
    }
    const registry = svc(ctx, 'workspaceRegistry')
    try {
      if (registry?.delete) await registry.delete(ws.id)
      sendKimiJson(res, kimiOk({ deleted: true }, rid))
    } catch (err: any) {
      fail(res, kimiErr(KimiErrorCode.INTERNAL_ERROR, err?.message || 'workspace delete failed', rid))
    }
  }, ADMIN)

  // trust 状态：DSH 无对应闸门，进程内存维护（默认 trusted，与 kimi 首次访问语义一致）
  const trustState = new Map<string, boolean>()
  router.get('/api/v1/workspaces/:id/trust', async (req, res, params) => {
    const rid = await kimiAuth(req, res, auth)
    if (rid === null) return
    const ref = resolveKimiWorkspace(ctx, params.id)
    if (!ref) {
      fail(res, kimiErr(KimiErrorCode.WORKSPACE_NOT_FOUND, `workspace ${params.id} does not exist`, rid))
      return
    }
    sendKimiJson(res, kimiOk({ trusted: trustState.get(params.id) !== false }, rid))
  }, ADMIN)
  router.post('/api/v1/workspaces/:id/trust', async (req, res, params) => {
    const rid = await kimiAuth(req, res, auth)
    if (rid === null) return
    const ref = resolveKimiWorkspace(ctx, params.id)
    if (!ref) {
      fail(res, kimiErr(KimiErrorCode.WORKSPACE_NOT_FOUND, `workspace ${params.id} does not exist`, rid))
      return
    }
    trustState.set(params.id, true)
    sendKimiJson(res, kimiOk({ trusted: true }, rid))
  }, ADMIN)
  router.post('/api/v1/workspaces/:id/untrust', async (req, res, params) => {
    const rid = await kimiAuth(req, res, auth)
    if (rid === null) return
    const ref = resolveKimiWorkspace(ctx, params.id)
    if (!ref) {
      fail(res, kimiErr(KimiErrorCode.WORKSPACE_NOT_FOUND, `workspace ${params.id} does not exist`, rid))
      return
    }
    trustState.set(params.id, false)
    sendKimiJson(res, kimiOk({ trusted: false }, rid))
  }, ADMIN)
  router.post('/api/v1/workspaces/:id/add-dir', async (req, res) => {
    const rid = await kimiAuth(req, res, auth)
    if (rid === null) return
    fail(res, kimiErr(KimiErrorCode.TOOL_NOT_AVAILABLE, 'add-dir is not supported on this DSH node', rid))
  }, ADMIN)

  // ---------- sessions 列表 / 创建 ----------
  router.get('/api/v1/sessions', async (req, res, _p, query) => {
    const rid = await kimiAuth(req, res, auth)
    if (rid === null) return
    const parsed = parseCursorQuery(query, rid)
    if (!parsed.ok) { fail(res, parsed.envelope); return }
    try {
      const raw = await listDshSessions(ctx)
      const busy = parseBoolQuery(query.busy)
      const includeArchive = parseBoolQuery(query.include_archive) === true
      const archivedOnly = parseBoolQuery(query.archived_only) === true
      const excludeEmpty = parseBoolQuery(query.exclude_empty) === true
      const workspaceFilter = query.workspace_id

      const built: Array<Record<string, unknown>> = []
      for (const s of raw) {
        const sid = dshSessionIdOf(s)
        if (!sid) continue
        const archivedAt = archivedMemo.get(sid)
        const archived = archivedAt !== undefined
        if (archivedOnly && !archived) continue
        if (!archivedOnly && archived && !includeArchive) continue
        const dshWsId = workspaceIdForSession(ctx, sid)
        const alias = dshWsId ? rememberWorkspace(dshWsId) : undefined
        if (workspaceFilter !== undefined && workspaceFilter !== '') {
          if (alias !== workspaceFilter) {
            fail(res, kimiErr(KimiErrorCode.WORKSPACE_NOT_FOUND, `workspace ${workspaceFilter} does not exist`, rid))
            return
          }
        }
        const events = excludeEmpty || query.page_size !== undefined ? [] : []
        const metaish = buildWireSession(ctx, {
          id: sid,
          title: s.title || '',
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          dshWorkspaceId: dshWsId,
          busy: Boolean(s.running),
          lite: true,
          events,
          model: modelStringOf(sessionModelSelection(ctx, sid)),
        })
        if (excludeEmpty) {
          // exclude_empty 语义 = 有 prompt 历史；lite 投影拿不到 last_prompt → 用消息数替代
          const msgs = foldMessages(await loadSessionEvents(ctx, sid), sid)
          if (msgs.length === 0) continue
        }
        built.push(metaish)
      }
      built.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      const page = pageByCursor(built, parsed.cursor, (item) => String(item.id))
      const items = busy === undefined ? page.items : page.items.filter((i) => i.busy === busy)
      sendKimiJson(res, kimiOk({ items, has_more: page.has_more }, rid))
    } catch (err: any) {
      fail(res, kimiErr(KimiErrorCode.INTERNAL_ERROR, err?.message || 'session list failed', rid))
    }
  }, ADMIN)

  router.post('/api/v1/sessions', async (req, res, _p, _q, body) => {
    const rid = await kimiAuth(req, res, auth)
    if (rid === null) return
    const cwd = typeof body?.metadata?.cwd === 'string' ? body.metadata.cwd : undefined
    const workspaceAlias = typeof body?.workspace_id === 'string' ? body.workspace_id : undefined
    if (workspaceAlias === undefined && cwd === undefined) {
      fail(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, 'validation failed', rid,
        [{ path: 'metadata.cwd', message: 'either workspace_id or metadata.cwd is required' }]))
      return
    }
    let workDir = cwd
    let dshWsId: string | undefined
    if (workspaceAlias !== undefined) {
      const ref = resolveKimiWorkspace(ctx, workspaceAlias)
      if (!ref) {
        fail(res, kimiErr(KimiErrorCode.WORKSPACE_NOT_FOUND, `workspace ${workspaceAlias} does not exist`, rid))
        return
      }
      const ws = dshWorkspace(ctx, ref)
      const root = ws ? String(ws.path) : ref.root
      if (!root) {
        fail(res, kimiErr(KimiErrorCode.WORKSPACE_NOT_FOUND, `workspace ${workspaceAlias} does not exist`, rid))
        return
      }
      if (cwd !== undefined && cwd !== root) {
        fail(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, 'validation failed', rid,
          [{ path: 'metadata.cwd', message: `metadata.cwd (${cwd}) must equal workspace root (${root})` }]))
        return
      }
      workDir = root
      dshWsId = ref.dshId
    }
    try {
      // 解析或注册 DSH 工作区（cwd 无注册 → resolveByPath/create）
      const registry = svc(ctx, 'workspaceRegistry')
      if (dshWsId === undefined && registry) {
        try {
          let ws = typeof registry.resolveByPath === 'function' ? await registry.resolveByPath(workDir) : undefined
          if (!ws && typeof registry.create === 'function') ws = await registry.create(workDir as string)
          if (ws) dshWsId = String(ws.id)
        } catch { /* 注册失败不阻断建会话 */ }
      }

      const sessionId = `session-${randomUUID()}`
      const controller = svc(ctx, 'sessionController')
      let createdId = sessionId
      if (controller && typeof controller.create === 'function') {
        const result = await controller.create({
          sessionId,
          workspaceId: dshWsId,
          cwd: workDir,
          agentPreset: undefined,
        })
        createdId = String(result?.sessionId ?? sessionId)
      } else {
        const agentsService = svc(ctx, 'agents')
        if (!agentsService?.create) {
          fail(res, kimiErr(KimiErrorCode.INTERNAL_ERROR, 'agent service unavailable', rid))
          return
        }
        await agentsService.create({ sessionId, meta: { cwd: workDir || process.cwd() } })
        if (dshWsId && registry?.get) {
          const ws = registry.get(dshWsId)
          if (ws?.attachSession) await ws.attachSession(sessionId)
        }
      }

      const title = typeof body?.title === 'string' ? body.title : ''
      if (title && controller?.rename) {
        try { await controller.rename({ sessionId: createdId, title }) } catch { /* ignore */ }
      }

      // agent_config.model → selectModel（必须保存/恢复全局默认，避免劫持部署默认模型）
      const modelAlias = typeof body?.agent_config?.model === 'string' ? body.agent_config.model.trim() : ''
      if (modelAlias && controller?.selectModel) {
        try {
          const defaultModelService = svc(ctx, 'agentDefaultModel')
          const previousDefault = defaultModelService && typeof defaultModelService.currentSelection === 'function'
            ? defaultModelService.currentSelection()
            : undefined
          const slash = modelAlias.lastIndexOf('/')
          const provider = slash > 0 ? modelAlias.slice(0, slash) : undefined
          const model = slash > 0 ? modelAlias.slice(slash + 1) : modelAlias
          await controller.selectModel({ sessionId: createdId, provider, model })
          if (previousDefault && defaultModelService?.saveSelection) {
            try { await defaultModelService.saveSelection(previousDefault) } catch { /* ignore */ }
          }
        } catch { /* 模型设置失败不影响会话创建 */ }
      }

      // permission_mode → 原生权限 preset
      const permissionMode = typeof body?.agent_config?.permission_mode === 'string' ? body.agent_config.permission_mode : ''
      if (permissionMode) {
        try { await applyPermissionMode(ctx, createdId, permissionMode) } catch { /* ignore */ }
      }

      const session = await wireSessionFull(ctx, createdId, { dshWorkspaceId: dshWsId, cwd: workDir })
      sendKimiJson(res, kimiOk(session, rid))
    } catch (err: any) {
      fail(res, kimiErr(KimiErrorCode.INTERNAL_ERROR, err?.message || 'session create failed', rid))
    }
  }, ADMIN)

  // ---------- 会话详情与子路径（/sessions/:tail；tail 可含 :action） ----------

  // GET /api/v1/sessions/{id}
  router.get('/api/v1/sessions/:tail', async (req, res, params) => {
    const gate = await sessionGate(ctx, req, res, auth, params.tail)
    if (!gate) return
    const { rid, sessionId } = gate
    try {
      const session = await wireSessionFull(ctx, sessionId)
      sendKimiJson(res, kimiOk(session, rid))
    } catch (err: any) {
      fail(res, kimiErr(KimiErrorCode.INTERNAL_ERROR, err?.message || 'session get failed', rid))
    }
  }, ADMIN)

  // POST /api/v1/sessions/{id}:action（abort/archive/restore/fork/compact/undo/btw/delete）
  const SESSION_ACTIONS = ['fork', 'compact', 'undo', 'abort', 'btw', 'restore', 'archive', 'delete'] as const
  router.post('/api/v1/sessions/:tail', async (req, res, params, _q, body) => {
    const rid = await kimiAuth(req, res, auth)
    if (rid === null) return
    const parsed = parseActionSuffix(params.tail, SESSION_ACTIONS)
    if (parsed.kind === 'invalid') {
      fail(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, 'validation failed', rid,
        [{ path: 'session_id', message: parsed.suffix ? unsupportedActionMessage(parsed.suffix, SESSION_ACTIONS) : `unsupported action: ${params.tail}` }]))
      return
    }
    if (parsed.kind === 'bare') {
      fail(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, `unsupported action: ${params.tail}`, rid,
        [{ path: 'session_id', message: `unsupported action: ${params.tail}` }]))
      return
    }
    const sessionId = parsed.id
    if (!(await dshSessionExists(ctx, sessionId))) {
      fail(res, kimiErr(KimiErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`, rid))
      return
    }
    try {
      switch (parsed.action) {
        case 'abort': {
          const aborted = await abortDshSession(ctx, sessionId)
          sendKimiJson(res, kimiOk({ aborted }, rid))
          return
        }
        case 'archive': {
          if (!archivedMemo.has(sessionId)) archivedMemo.set(sessionId, Date.now())
          sendKimiJson(res, kimiOk({ archived: true }, rid))
          return
        }
        case 'restore': {
          archivedMemo.delete(sessionId)
          const session = await wireSessionFull(ctx, sessionId)
          sendKimiJson(res, kimiOk(session, rid))
          return
        }
        case 'delete': {
          const sessionsService = svc(ctx, 'sessions')
          let deleted = false
          try {
            if (sessionsService?.remove) { await sessionsService.remove(sessionId); deleted = true }
            else {
              const agentsService = svc(ctx, 'agents')
              const agent = agentsService?.get ? agentsService.get(sessionId) : undefined
              if (agent?.dispose) { await agent.dispose(); deleted = true }
            }
          } catch { deleted = false }
          archivedMemo.delete(sessionId)
          sendKimiJson(res, kimiOk({ deleted }, rid))
          return
        }
        case 'fork': {
          // DSH 无历史复制能力：建同工作区新会话（标题继承），契约上返回新 session
          const title = typeof body?.title === 'string' && body.title ? body.title : undefined
          const meta = await dshSessionMeta(ctx, sessionId)
          const cwd = (meta?.cwd as string | undefined) || resolveSessionCwdSync(ctx, sessionId) || process.cwd()
          const created = await wireSessionFull(ctx, sessionId, { liteHint: true })
          void created
          const newId = await createCloneSession(ctx, title || String(meta?.title || ''), cwd)
          const session = await wireSessionFull(ctx, newId)
          sendKimiJson(res, kimiOk(session, rid))
          return
        }
        case 'compact': {
          fail(res, kimiErr(KimiErrorCode.COMPACTION_UNABLE, 'manual compaction is not available on this DSH node', rid))
          return
        }
        case 'undo': {
          fail(res, kimiErr(KimiErrorCode.SESSION_UNDO_UNAVAILABLE, 'conversation undo is not available on this DSH node', rid))
          return
        }
        case 'btw': {
          fail(res, kimiErr(KimiErrorCode.TOOL_NOT_AVAILABLE, 'not supported', rid))
          return
        }
      }
    } catch (err: any) {
      fail(res, kimiErr(KimiErrorCode.INTERNAL_ERROR, err?.message || 'session action failed', rid))
    }
  }, ADMIN)

  // GET/POST /sessions/:id/profile
  router.get('/api/v1/sessions/:id/profile', async (req, res, params) => {
    const gate = await sessionGate(ctx, req, res, auth, params.id)
    if (!gate) return
    try {
      const session = await wireSessionFull(ctx, gate.sessionId)
      sendKimiJson(res, kimiOk(session, gate.rid))
    } catch (err: any) {
      fail(res, kimiErr(KimiErrorCode.INTERNAL_ERROR, err?.message || 'profile get failed', gate.rid))
    }
  }, ADMIN)

  router.post('/api/v1/sessions/:id/profile', async (req, res, params, _q, body) => {
    const gate = await sessionGate(ctx, req, res, auth, params.id)
    if (!gate) return
    const { rid, sessionId } = gate
    try {
      const controller = svc(ctx, 'sessionController')
      const title = typeof body?.title === 'string' && body.title ? body.title : undefined
      if (title && controller?.rename) {
        try { await controller.rename({ sessionId, title }) } catch { /* ignore */ }
      }
      const modelAlias = typeof body?.agent_config?.model === 'string' ? body.agent_config.model.trim() : ''
      if (modelAlias && controller?.selectModel) {
        try {
          const defaultModelService = svc(ctx, 'agentDefaultModel')
          const previousDefault = defaultModelService?.currentSelection ? defaultModelService.currentSelection() : undefined
          const slash = modelAlias.lastIndexOf('/')
          await controller.selectModel({
            sessionId,
            provider: slash > 0 ? modelAlias.slice(0, slash) : undefined,
            model: slash > 0 ? modelAlias.slice(slash + 1) : modelAlias,
          })
          if (previousDefault && defaultModelService?.saveSelection) {
            try { await defaultModelService.saveSelection(previousDefault) } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }
      const permissionMode = typeof body?.agent_config?.permission_mode === 'string' ? body.agent_config.permission_mode : ''
      if (permissionMode) {
        try { await applyPermissionMode(ctx, sessionId, permissionMode) } catch { /* ignore */ }
      }
      if (Array.isArray(body?.permission_rules) && body.permission_rules.length > 0) {
        // DSH 无规则面：忽略并保持幂等成功
      }
      const session = await wireSessionFull(ctx, sessionId)
      sendKimiJson(res, kimiOk(session, rid))
    } catch (err: any) {
      fail(res, kimiErr(KimiErrorCode.INTERNAL_ERROR, err?.message || 'profile update failed', rid))
    }
  }, ADMIN)

  // GET /sessions/:id/status
  router.get('/api/v1/sessions/:id/status', async (req, res, params) => {
    const gate = await sessionGate(ctx, req, res, auth, params.id)
    if (!gate) return
    const { rid, sessionId } = gate
    try {
      const events = await loadSessionEvents(ctx, sessionId)
      const selection = sessionModelSelection(ctx, sessionId)
      const busy = busyOf(ctx, sessionId, events)
      const permission = await readSessionPermission(ctx, sessionId)
      const contextTokens = contextTokensOf(events)
      const status: Record<string, unknown> = {
        busy,
        thinking_level: String(selection?.reasoningEffort ?? 'medium'),
        permission: 'error' in permission ? 'default' : permission.preset,
        plan_mode: false,
        swarm_mode: false,
        context_tokens: contextTokens,
      }
      const model = modelStringOf(selection)
      if (model !== undefined) status.model = model
      sendKimiJson(res, kimiOk(status, rid))
    } catch (err: any) {
      fail(res, kimiErr(KimiErrorCode.INTERNAL_ERROR, err?.message || 'status failed', rid))
    }
  }, ADMIN)

  // ---------- messages ----------
  router.get('/api/v1/sessions/:id/messages', async (req, res, params, query) => {
    const gate = await sessionGate(ctx, req, res, auth, params.id)
    if (!gate) return
    const { rid, sessionId } = gate
    const parsed = parseCursorQuery({ ...query, page_size: query.page_size ?? String(DEFAULT_MESSAGE_PAGE_SIZE) }, rid)
    if (!parsed.ok) { fail(res, parsed.envelope); return }
    try {
      const events = await loadSessionEvents(ctx, sessionId)
      let desc = foldMessages(events, sessionId).reverse()
      const role = query.role
      if (role === 'user' || role === 'assistant' || role === 'tool' || role === 'system') {
        desc = desc.filter((m) => m.role === role)
      }
      const page = pageByCursor(desc, parsed.cursor, (m) => m.id)
      sendKimiJson(res, kimiOk({ items: page.items, has_more: page.has_more }, rid))
    } catch (err: any) {
      fail(res, kimiErr(KimiErrorCode.INTERNAL_ERROR, err?.message || 'messages failed', rid))
    }
  }, ADMIN)

  router.get('/api/v1/sessions/:id/messages/:messageId', async (req, res, params) => {
    const gate = await sessionGate(ctx, req, res, auth, params.id)
    if (!gate) return
    const { rid, sessionId } = gate
    try {
      const events = await loadSessionEvents(ctx, sessionId)
      const found = foldMessages(events, sessionId).find((m) => m.id === params.messageId)
      if (!found) {
        fail(res, kimiErr(KimiErrorCode.MESSAGE_NOT_FOUND, `message ${params.messageId} not found`, rid))
        return
      }
      sendKimiJson(res, kimiOk(found, rid))
    } catch (err: any) {
      fail(res, kimiErr(KimiErrorCode.INTERNAL_ERROR, err?.message || 'message get failed', rid))
    }
  }, ADMIN)

  // ---------- prompts ----------
  router.get('/api/v1/sessions/:id/prompts', async (req, res, params) => {
    const gate = await sessionGate(ctx, req, res, auth, params.id)
    if (!gate) return
    const { rid, sessionId } = gate
    try {
      const events = await loadSessionEvents(ctx, sessionId)
      const transcript = foldTranscript(events)
      const activeRaw = [...transcript.prompts].reverse().find((p: any) => p?.status === 'running')
      const active = activeRaw ? promptItemOf(activeRaw, sessionId) : null
      sendKimiJson(res, kimiOk({ active, queued: [] }, rid))
    } catch (err: any) {
      fail(res, kimiErr(KimiErrorCode.INTERNAL_ERROR, err?.message || 'prompts list failed', rid))
    }
  }, ADMIN)

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

  router.post('/api/v1/sessions/:id/prompts/:tail', async (req, res, params, _q, body) => {
    const gate = await sessionGate(ctx, req, res, auth, params.id)
    if (!gate) return
    const { rid, sessionId } = gate
    const promptActions = ['abort', 'steer'] as const
    const parsed = parseActionSuffix(params.tail, promptActions)
    if (parsed.kind !== 'action') {
      fail(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, 'validation failed', rid,
        [{ path: 'prompt_id', message: parsed.kind === 'invalid' ? unsupportedActionMessage(parsed.suffix, promptActions) : `unsupported action: ${params.tail}` }]))
      return
    }
    const promptId = parsed.id
    if (parsed.action === 'abort') {
      const aborted = await abortDshSession(ctx, sessionId)
      sendKimiJson(res, kimiOk({ aborted, at_seq: 0 }, rid))
      return
    }
    void promptId
    void body
    sendKimiJson(res, kimiOk({ steered: true, prompt_ids: [promptId] }, rid))
  }, ADMIN)

  router.post('/api/v1/sessions/:id/prompts', async (req, res, params, _q, body) => {
    const gate = await sessionGate(ctx, req, res, auth, params.id)
    if (!gate) return
    const { rid, sessionId } = gate
    const content = Array.isArray(body?.content) ? body.content : []
    if (content.length === 0) {
      fail(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, 'validation failed', rid,
        [{ path: 'content', message: 'content must be a non-empty array of blocks' }]))
      return
    }
    const promptId = typeof body?.prompt_id === 'string' && body.prompt_id ? body.prompt_id : kimiUlid()
    const text = promptContentToText(content)
    if (!text) {
      fail(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, 'prompt content carries no text', rid))
      return
    }
    try {
      // permission_mode / model 尽力应用（与 profile 更新同一写路径）
      const permissionMode = typeof body?.permission_mode === 'string' ? body.permission_mode : ''
      if (permissionMode) {
        try { await applyPermissionMode(ctx, sessionId, permissionMode) } catch { /* ignore */ }
      }
      const busy = busyOf(ctx, sessionId)
      void askSessionStorage.run({ sessionId }, () =>
        submitPromptToSession(ctx, sessionId, { prompt: text, mode: 'normal' }),
      ).catch((err: any) => {
        console.warn('[dsh-web-service kimi-compat] prompt submit failed:', err?.message || err)
        kimiWsBroadcast({ type: 'session.error', session_id: sessionId, payload: { message: String(err?.message || err) } })
      })
      const item = {
        prompt_id: promptId,
        user_message_id: promptId,
        status: busy ? 'queued' : 'running',
        content,
        created_at: new Date().toISOString(),
        ...(body?.metadata && typeof body.metadata === 'object' ? { metadata: body.metadata } : {}),
      }
      sendKimiJson(res, kimiOk(item, rid))
    } catch (err: any) {
      fail(res, kimiErr(KimiErrorCode.INTERNAL_ERROR, err?.message || 'prompt failed', rid))
    }
  }, ADMIN)

  // ---------- approvals（DSH 无审批面：如实空 / 40404） ----------
  router.get('/api/v1/sessions/:id/approvals', async (req, res, params) => {
    const gate = await sessionGate(ctx, req, res, auth, params.id)
    if (!gate) return
    sendKimiJson(res, kimiOk({ items: [] }, gate.rid))
  }, ADMIN)

  router.post('/api/v1/sessions/:id/approvals/:approvalId', async (req, res, params) => {
    const gate = await sessionGate(ctx, req, res, auth, params.id)
    if (!gate) return
    fail(res, kimiErr(KimiErrorCode.APPROVAL_NOT_FOUND, `approval ${params.approvalId} not found`, gate.rid))
  }, ADMIN)

  // ---------- questions（DSH ask 用户提问桥） ----------
  router.get('/api/v1/sessions/:id/questions', async (req, res, params) => {
    const gate = await sessionGate(ctx, req, res, auth, params.id)
    if (!gate) return
    const { rid, sessionId } = gate
    try {
      const items = listPendingBatches(sessionId).map((b) => wireQuestionRequest(sessionId, b))
      sendKimiJson(res, kimiOk({ items }, rid))
    } catch (err: any) {
      fail(res, kimiErr(KimiErrorCode.INTERNAL_ERROR, err?.message || 'questions list failed', rid))
    }
  }, ADMIN)

  router.post('/api/v1/sessions/:id/questions/:tail', async (req, res, params, _q, body) => {
    const gate = await sessionGate(ctx, req, res, auth, params.id)
    if (!gate) return
    const { rid, sessionId } = gate
    const parsed = parseActionSuffix(params.tail, ['dismiss'], 'resolve')
    if (parsed.kind === 'invalid') {
      fail(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, 'validation failed', rid,
        [{ path: 'question_id', message: unsupportedActionMessage(parsed.suffix, ['dismiss']) }]))
      return
    }
    const questionId = parsed.id
    const batches = listPendingBatches(sessionId)
    const batch = batches.find((b) => b.batchId === questionId)
    if (!batch) {
      if (resolvedQuestionMemo.has(questionId)) {
        fail(res, kimiErrWithData(
          KimiErrorCode.APPROVAL_ALREADY_RESOLVED, 'question already resolved', rid, { resolved: false },
        ))
        return
      }
      fail(res, kimiErr(KimiErrorCode.QUESTION_NOT_FOUND, `question ${questionId} not found`, rid))
      return
    }
    const isDismiss = parsed.kind === 'action' && parsed.action === 'dismiss'
    if (isDismiss) {
      const ok = rejectPendingBatchById(sessionId, questionId, 'dismissed via API')
      if (!ok) {
        fail(res, kimiErr(KimiErrorCode.QUESTION_NOT_FOUND, `question ${questionId} not found`, rid))
        return
      }
      resolvedQuestionMemo.set(questionId, Date.now())
      sendKimiJson(res, kimiOk({ dismissed: true, dismissed_at: new Date().toISOString() }, rid))
      return
    }
    const answers = body?.answers && typeof body.answers === 'object' ? body.answers : {}
    const mapped = batch.questions.map((q: any) => {
      const answer = answers[String(q?.id ?? '')]
      const { labels, custom } = kimiAnswerToDsh(q, answer)
      return { id: String(q?.id ?? ''), selected: labels, ...(custom !== undefined ? { custom } : {}) }
    })
    const ok = resolvePendingBatchById(sessionId, questionId, mapped)
    if (!ok) {
      fail(res, kimiErr(KimiErrorCode.QUESTION_NOT_FOUND, `question ${questionId} not found`, rid))
      return
    }
    resolvedQuestionMemo.set(questionId, Date.now())
    sendKimiJson(res, kimiOk({ resolved: true, resolved_at: new Date().toISOString() }, rid))
  }, ADMIN)

  // ---------- snapshot ----------
  router.get('/api/v1/sessions/:id/snapshot', async (req, res, params) => {
    const gate = await sessionGate(ctx, req, res, auth, params.id)
    if (!gate) return
    const { rid, sessionId } = gate
    try {
      const events = await loadSessionEvents(ctx, sessionId)
      const asOfSeq = events.reduce((m: number, ev: any) => (typeof ev?.seq === 'number' && ev.seq > m ? ev.seq : m), 0)
      const session = await wireSessionFull(ctx, sessionId, { events })
      const messages = foldMessages(events, sessionId)
      const questions = listPendingBatches(sessionId).map((b) => wireQuestionRequest(sessionId, b))
      sendKimiJson(res, kimiOk({
        as_of_seq: asOfSeq,
        epoch: KIMI_EPOCH,
        session,
        messages: { items: messages, has_more: false },
        in_flight_turn: null,
        subagents: [],
        pending_approvals: [],
        pending_questions: questions,
      }, rid))
    } catch (err: any) {
      fail(res, kimiErr(KimiErrorCode.INTERNAL_ERROR, err?.message || 'snapshot failed', rid))
    }
  }, ADMIN)

  // ---------- transcript ----------
  router.get('/api/v1/sessions/:id/transcript', async (req, res, params, query) => {
    const gate = await sessionGate(ctx, req, res, auth, params.id)
    if (!gate) return
    const { rid, sessionId } = gate
    if (!validAgentId(query.agent_id)) {
      fail(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, 'validation failed', rid,
        [{ path: 'agent_id', message: 'agent_id must be a plain agent id' }]))
      return
    }
    const pageSizeRaw = query.page_size
    let pageSize = DEFAULT_PAGE_SIZE
    if (pageSizeRaw !== undefined && pageSizeRaw !== '') {
      const n = Number(pageSizeRaw)
      if (!Number.isInteger(n) || n < 1 || n > 100) {
        fail(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, 'validation failed', rid,
          [{ path: 'page_size', message: 'page_size must be an integer between 1 and 100' }]))
        return
      }
      pageSize = n
    }
    if (query.before_turn && query.after_turn) {
      fail(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, 'validation failed', rid,
        [{ path: 'before_turn', message: 'before_turn and after_turn are mutually exclusive' }]))
      return
    }
    try {
      const events = await loadSessionEvents(ctx, sessionId)
      const transcript = foldTranscript(events)
      const page = paginateTurns(transcript.items as any[], {
        before_turn: query.before_turn,
        after_turn: query.after_turn,
        page_size: pageSize,
      })
      const ops = buildTranscriptOps(events)
      sendKimiJson(res, kimiOk({
        agent_id: query.agent_id,
        items: page.items,
        has_more: page.hasMore,
        tasks: transcript.tasks,
        interactions: transcript.interactions,
        attachments: transcript.attachments,
        todos: transcript.todos,
        prompts: transcript.prompts,
        meta: transcript.meta,
        agents: transcript.agents,
        pending_interactions: transcript.pending_interactions,
        seq: ops.latest_seq,
      }, rid))
    } catch (err: any) {
      fail(res, kimiErr(KimiErrorCode.INTERNAL_ERROR, err?.message || 'transcript failed', rid))
    }
  }, ADMIN)

  router.get('/api/v1/sessions/:id/transcript/ops', async (req, res, params, query) => {
    const gate = await sessionGate(ctx, req, res, auth, params.id)
    if (!gate) return
    const { rid, sessionId } = gate
    if (!validAgentId(query.agent_id)) {
      fail(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, 'validation failed', rid,
        [{ path: 'agent_id', message: 'agent_id must be a plain agent id' }]))
      return
    }
    const sinceRaw = query.since_seq
    const since = Number(sinceRaw)
    if (!Number.isInteger(since) || since < 0) {
      fail(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, 'validation failed', rid,
        [{ path: 'since_seq', message: 'since_seq must be a non-negative integer' }]))
      return
    }
    try {
      const events = await loadSessionEvents(ctx, sessionId)
      const result = transcriptOpsSince(events, since)
      sendKimiJson(res, kimiOk({
        agent_id: query.agent_id,
        batches: result.batches,
        latest_seq: result.latest_seq,
        complete: result.complete,
      }, rid))
    } catch (err: any) {
      fail(res, kimiErr(KimiErrorCode.INTERNAL_ERROR, err?.message || 'transcript ops failed', rid))
    }
  }, ADMIN)

  // ---------- goal / warnings / children / title ----------
  router.get('/api/v1/sessions/:id/goal', async (req, res, params) => {
    const gate = await sessionGate(ctx, req, res, auth, params.id)
    if (!gate) return
    sendKimiJson(res, kimiOk(null, gate.rid))
  }, ADMIN)

  router.get('/api/v1/sessions/:id/warnings', async (req, res, params) => {
    const gate = await sessionGate(ctx, req, res, auth, params.id)
    if (!gate) return
    sendKimiJson(res, kimiOk({ warnings: [] }, gate.rid))
  }, ADMIN)

  router.get('/api/v1/sessions/:id/children', async (req, res, params) => {
    const gate = await sessionGate(ctx, req, res, auth, params.id)
    if (!gate) return
    sendKimiJson(res, kimiOk({ items: [], has_more: false }, gate.rid))
  }, ADMIN)

  router.post('/api/v1/sessions/:id/children', async (req, res, params) => {
    const gate = await sessionGate(ctx, req, res, auth, params.id)
    if (!gate) return
    fail(res, kimiErr(KimiErrorCode.TOOL_NOT_AVAILABLE, 'child sessions are not supported on this DSH node', gate.rid), 200)
  }, ADMIN)

  router.post('/api/v1/sessions/:id/title/generate', async (req, res, params) => {
    const gate = await sessionGate(ctx, req, res, auth, params.id)
    if (!gate) return
    fail(res, kimiErr(KimiErrorCode.TOOL_NOT_AVAILABLE, 'title generation is not supported on this DSH node', gate.rid))
  }, ADMIN)

  // ---------- 文件上传 / 下载 ----------
  router.post('/api/v1/files', async (req, res, _p, _q, body: Buffer) => {
    const rid = await kimiAuth(req, res, auth)
    if (rid === null) return
    const contentType = String(req.headers['content-type'] || '')
    if (!Buffer.isBuffer(body) || !contentType.includes('multipart/form-data')) {
      fail(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, 'multipart/form-data is required', rid))
      return
    }
    try {
      const parts = parseMultipart(body, contentType)
      const file = parts.find((p) => p.name === 'file' && p.filename) || parts.find((p) => p.data && p.filename)
      if (!file || !file.filename) {
        fail(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, 'no file part in multipart body', rid))
        return
      }
      const nameOverride = parts.find((p) => p.name === 'name')
      const name = sanitizeFilename(
        (nameOverride?.data?.toString('utf8') || '').trim() || file.filename,
      )
      if (file.data.length > (opts.config.maxUploadBytes || 2 * 1024 * 1024 * 1024)) {
        fail(res, kimiErr(KimiErrorCode.FILE_TOO_LARGE, `file exceeds ${opts.config.maxUploadBytes} bytes`, rid))
        return
      }
      const metaId = `file_${randomBytes(12).toString('hex')}`
      const stored = await storeUploadedFile(metaId, file.data, name, file.mimeType || lookupMime(name))
      uploadedFiles.set(metaId, stored)
      sendKimiJson(res, kimiOk({
        id: metaId,
        name: stored.name,
        media_type: stored.mediaType,
        size: stored.size,
        created_at: stored.createdAt,
      }, rid))
    } catch (err: any) {
      fail(res, kimiErr(KimiErrorCode.INTERNAL_ERROR, err?.message || 'upload failed', rid))
    }
  }, { ...ADMIN, rawBody: true })

  router.get('/api/v1/files/:fileId', async (req, res, params) => {
    const rid = await kimiAuth(req, res, auth)
    if (rid === null) return
    const stored = uploadedFiles.get(params.fileId)
    if (!stored) {
      // 文件流的失败用真实 HTTP 状态（SDK download() 依赖非 2xx 判定）
      sendKimiJson(res, kimiErr(KimiErrorCode.FILE_NOT_FOUND, `file ${params.fileId} not found`, rid), 404)
      return
    }
    try {
      const stat = await fsp.stat(stored.filePath)
      res.statusCode = 200
      res.setHeader('Content-Type', stored.mediaType || 'application/octet-stream')
      res.setHeader('Content-Length', String(stat.size))
      res.setHeader('Content-Disposition', buildContentDisposition(stored.name))
      const stream = createReadStream(stored.filePath)
      stream.on('error', (err: any) => {
        if (!res.headersSent) {
          sendKimiJson(res, kimiErr(KimiErrorCode.INTERNAL_ERROR, err?.message || 'read failed', rid), 500)
        } else {
          res.destroy()
        }
      })
      stream.pipe(res)
    } catch (err: any) {
      sendKimiJson(res, kimiErr(KimiErrorCode.FILE_NOT_FOUND, `file ${params.fileId} not found`, rid), 404)
    }
  }, ADMIN)

  router.delete('/api/v1/files/:fileId', async (req, res, params) => {
    const rid = await kimiAuth(req, res, auth)
    if (rid === null) return
    const stored = uploadedFiles.get(params.fileId)
    if (!stored) {
      fail(res, kimiErr(KimiErrorCode.FILE_NOT_FOUND, `file ${params.fileId} not found`, rid))
      return
    }
    try { await fsp.unlink(stored.filePath) } catch { /* ignore */ }
    uploadedFiles.delete(params.fileId)
    sendKimiJson(res, kimiOk({ deleted: true }, rid))
  }, ADMIN)

  // ---------- v2 会话列表（GET /api/v2/sessions） ----------
  router.get('/api/v2/sessions', async (req, res, _p, query) => {
    const rid = await kimiAuth(req, res, auth)
    if (rid === null) return
    try {
      const raw = await listDshSessions(ctx)
      const archivedFilter = query['meta.archived'] ?? 'false'
      const workspaceFilter = multi(query['workspace.id'])
      const statusFilter = multi(query['activity.status'])
      const updatedAfter = numOr(query['meta.updated_after'])
      const updatedBefore = numOr(query['meta.updated_before'])
      const hasPrompt = parseBoolQuery(query['meta.has_prompt'])
      const sort = query.sort ?? 'meta.updated_at_desc'
      const pageSize = clampInt(numOr(query.page_size), 1, 500, DEFAULT_PAGE_SIZE)
      const page = clampInt(numOr(query.page) ?? 1, 1, 1_000_000, 1)
      const pageToken = query.page_token
      const fields = parseCsv(query.fields)
      const includeGit = parseCsv(query.include).has('git')
      void pageToken // page_token 与 page 互斥；本实现只用无状态 page

      const built: Array<Record<string, unknown>> = []
      for (const s of raw) {
        const sid = dshSessionIdOf(s)
        if (!sid) continue
        const archivedAt = archivedMemo.get(sid)
        const archived = archivedAt !== undefined
        if (archivedFilter === 'true' && !archived) continue
        if (archivedFilter === 'false' && archived) continue
        const dshWsId = workspaceIdForSession(ctx, sid)
        const cwd = (dshWsId ? workspacePathById(ctx, dshWsId) : undefined) ?? resolveSessionCwdSync(ctx, sid) ?? null
        const alias = dshWsId ? rememberWorkspace(dshWsId) : cwd ? aliasForRoot(cwd) : ''
        if (workspaceFilter.length > 0 && !workspaceFilter.includes(alias)) continue
        const createdAt = typeof s.createdAt === 'number' ? s.createdAt : Date.now()
        const updatedAt = typeof s.updatedAt === 'number' ? s.updatedAt : createdAt
        if (updatedAfter !== undefined && updatedAt < updatedAfter) continue
        if (updatedBefore !== undefined && updatedAt > updatedBefore) continue
        const busy = Boolean(s.running) || busyOf(ctx, sid)
        const questions = pendingInteractionOf(ctx, sid)
        const status = busy ? 'running' : questions === 'question' ? 'question' : idleStatusOf(ctx, sid)
        if (statusFilter.length > 0 && !statusFilter.includes(status)) continue
        const meta = s as any
        const lastPrompt = typeof meta.lastPrompt === 'string' ? meta.lastPrompt : null
        if (hasPrompt === true && !lastPrompt) continue
        if (hasPrompt === false && lastPrompt) continue
        const selection = sessionModelSelection(ctx, sid)
        const item: Record<string, unknown> = {
          id: sid,
          workspace: { id: alias, cwd },
          meta: {
            title: meta.title || null,
            last_prompt: lastPrompt,
            created_at: createdAt,
            updated_at: updatedAt,
            archived,
            archived_at: archivedAt ?? null,
          },
          activity: { status, model: modelStringOf(selection) ?? null },
        }
        if (fields.has('id') && fields.has('archived')) {
          built.push({ id: sid, archived })
          continue
        }
        if (includeGit) item.git = { branch: null, pull_request: null }
        built.push(item)
      }

      built.sort((a, b) => {
        const ua = Number((a.meta as any).updated_at)
        const ub = Number((b.meta as any).updated_at)
        const ca = Number((a.meta as any).created_at)
        const cb = Number((b.meta as any).created_at)
        switch (sort) {
          case 'meta.updated_at_asc': return ua - ub
          case 'meta.created_at_desc': return cb - ca
          default: return ub - ua
        }
      })
      const total = built.length
      const start = (page - 1) * pageSize
      const items = built.slice(start, start + pageSize)
      sendKimiJson(res, kimiOk({
        items,
        total,
        has_more: start + items.length < total,
        next_page_token: null,
      }, rid))
    } catch (err: any) {
      fail(res, kimiErr(KimiErrorCode.INTERNAL_ERROR, err?.message || 'v2 sessions list failed', rid))
    }
  }, ADMIN)

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

}

// ==================== 兼容层内部实现 ====================

const authLimiter = new FailureRateLimiter(10, 60_000)
/** 已解决问题的进程内存记录（重复回答 → 40902 + data{resolved:false}） */
const resolvedQuestionMemo = new Map<string, number>()

function multi(value: string | undefined): string[] {
  if (value === undefined || value === '') return []
  return value.split(',').map((x) => x.trim()).filter(Boolean)
}

function parseCsv(value: string | undefined): Set<string> {
  return new Set(multi(value))
}

function numOr(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function clampInt(v: number | undefined, min: number, max: number, fallback: number): number {
  if (v === undefined || !Number.isFinite(v)) return fallback
  return Math.min(Math.max(Math.trunc(v), min), max)
}

function buildContentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/** 工作区 wire（字段名逐条对齐 kap-server toWireWorkspace） */
function wireWorkspace(ws: any): Record<string, unknown> {
  const createdAt = typeof ws.createdAt === 'number' ? ws.createdAt : Date.now()
  const updatedAt = typeof ws.updatedAt === 'number' ? ws.updatedAt : createdAt
  return {
    id: rememberWorkspace(String(ws.id)),
    root: String(ws.path),
    name: String(ws.title || String(ws.id)),
    created_at: isoTime(createdAt),
    last_opened_at: isoTime(updatedAt),
    session_count: ws.sessionIds ? [...ws.sessionIds].length : 0,
  }
}

function dshWorkspace(ctx: Context, ref: { dshId?: string; root?: string } | undefined): any {
  if (!ref) return undefined
  const registry = svc(ctx, 'workspaceRegistry')
  try {
    if (ref.dshId && registry?.get) return registry.get(ref.dshId)
    if (ref.root && typeof registry?.resolveByPath === 'function') return registry.resolveByPath(ref.root)
  } catch { /* fallthrough */ }
  return undefined
}

/** 会话忙闲：宿主 live 状态优先，事件日志尾部 turn 收尾兜底 */
function busyOf(ctx: Context, sessionId: string, events?: any[]): boolean {
  try {
    const live = liveRunningState(ctx, sessionId)
    if (live !== undefined) return live
  } catch { /* fallthrough */ }
  if (events && events.length > 0) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const type = events[i]?.type
      if (type === 'turn/start') return true
      if (type === 'turn/end' || type === 'error') return false
    }
  }
  return false
}

function idleStatusOf(ctx: Context, sessionId: string): string {
  try {
    const batches = listPendingBatches(sessionId)
    if (batches.length > 0) return 'question'
  } catch { /* fallthrough */ }
  return 'idle'
}

async function createCloneSession(ctx: Context, title: string, cwd: string): Promise<string> {
  const sessionId = `session-${randomUUID()}`
  const controller = svc(ctx, 'sessionController')
  if (controller && typeof controller.create === 'function') {
    const result = await controller.create({ sessionId, cwd })
    const id = String(result?.sessionId ?? sessionId)
    if (title && controller.rename) {
      try { await controller.rename({ sessionId: id, title }) } catch { /* ignore */ }
    }
    return id
  }
  const agentsService = svc(ctx, 'agents')
  await agentsService.create({ sessionId, meta: { cwd } })
  return sessionId
}

/** 完整 wire 会话（事件级字段：usage / message_count / last_seq / last_prompt） */
async function wireSessionFull(
  ctx: Context,
  sessionId: string,
  extra?: { events?: any[]; dshWorkspaceId?: string; cwd?: string; liteHint?: boolean },
): Promise<Record<string, unknown>> {
  const meta = await dshSessionMeta(ctx, sessionId)
  const events = extra?.events ?? (extra?.liteHint ? [] : await loadSessionEvents(ctx, sessionId))
  const dshWsId = extra?.dshWorkspaceId ?? workspaceIdForSession(ctx, sessionId)
  const cwd = extra?.cwd ?? meta?.cwd ?? resolveSessionCwdSync(ctx, sessionId)
  const selection = sessionModelSelection(ctx, sessionId)
  return buildWireSession(ctx, {
    id: sessionId,
    title: String(meta?.title ?? ''),
    createdAt: typeof meta?.createdAt === 'number' ? meta.createdAt : undefined,
    updatedAt: typeof meta?.updatedAt === 'number' ? meta.updatedAt : undefined,
    dshWorkspaceId: dshWsId,
    cwd,
    busy: busyOf(ctx, sessionId, events.length ? events : undefined),
    events,
    lite: extra?.liteHint === true,
    model: modelStringOf(selection) ?? '',
  })
}

/** DSH 问题批次 → kimi QuestionRequest（question_id = batchId；options 归一 {id,label}） */
function wireQuestionRequest(sessionId: string, batch: { batchId: string; at: number; questions: any[] }): Record<string, unknown> {
  const items = batch.questions.map((q: any, qi: number) => {
    const rawOptions = Array.isArray(q?.options) ? q.options : []
    const options = rawOptions.map((o: any, oi: number) => ({
      id: String(o?.id ?? `o${oi}`),
      label: optionLabel(o, `选项${oi + 1}`),
      ...(typeof o?.description === 'string' && o.description ? { description: o.description } : {}),
    }))
    return {
      id: String(q?.id ?? `q${qi}`),
      question: String(q?.question ?? ''),
      ...(q?.header !== undefined ? { header: String(q.header) } : {}),
      // kimi 契约要求 2..4 个选项；DSH 侧不满足时原样返回（客户端按缺失兜底）
      options,
      multi_select: Boolean(q?.multiSelect ?? q?.multi_select ?? false),
      allow_other: true,
    }
  })
  return {
    question_id: batch.batchId,
    session_id: sessionId,
    agent_id: KIMI_MAIN_AGENT_ID,
    questions: items,
    created_at: isoTime(batch.at),
  }
}

function optionLabel(o: any, fallback: string): string {
  if (typeof o === 'string') return o
  const label = o?.label ?? o?.text ?? o?.value
  return label !== undefined && label !== null && String(label) ? String(label) : fallback
}

/** kimi QuestionAnswer → DSH ask 应答（selected 存选项文本；other/skipped 降级） */
function kimiAnswerToDsh(question: any, answer: any): { labels: string[]; custom?: string } {
  if (!answer || typeof answer !== 'object') return { labels: [] }
  const options: any[] = Array.isArray(question?.options) ? question.options : []
  const labelOf = (id: string): string => {
    const hit = options.find((o: any, i: number) => String(o?.id ?? `o${i}`) === id)
    return hit !== undefined ? optionLabel(hit, id) : id
  }
  switch (answer.kind) {
    case 'single':
      return { labels: typeof answer.option_id === 'string' ? [labelOf(answer.option_id)] : [] }
    case 'multi':
      return { labels: Array.isArray(answer.option_ids) ? answer.option_ids.map((x: any) => labelOf(String(x))) : [] }
    case 'multi_with_other': {
      const labels = Array.isArray(answer.option_ids) ? answer.option_ids.map((x: any) => labelOf(String(x))) : []
      const custom = typeof answer.other_text === 'string' ? answer.other_text : undefined
      return custom !== undefined && custom !== '' ? { labels, custom } : { labels }
    }
    case 'other':
      return { labels: [], custom: typeof answer.text === 'string' ? answer.text : '' }
    case 'skipped':
      return { labels: [] }
    default: {
      // 宽松回落：直接给了 selected/labels 数组的调用方
      const raw = Array.isArray(answer.selected) ? answer.selected : Array.isArray(answer.labels) ? answer.labels : []
      return { labels: raw.map((x: any) => String(x)) }
    }
  }
}

function promptItemOf(prompt: any, sessionId: string): Record<string, unknown> {
  void sessionId
  return {
    prompt_id: String(prompt?.promptId ?? ''),
    user_message_id: String(prompt?.promptId ?? ''),
    status: prompt?.status === 'running' ? 'running' : prompt?.status === 'queued' ? 'queued' : 'completed',
    content: Array.isArray(prompt?.content) && prompt.content.length > 0
      ? prompt.content
      : [{ type: 'text', text: '' }],
    created_at: String(prompt?.createdAt ?? new Date().toISOString()),
  }
}

// ==================== fs 动作实现 ====================

async function handleFsAction(
  res: ServerResponse,
  rid: string,
  action: 'list' | 'stat' | 'read' | 'mkdir' | 'search' | 'grep',
  root: string,
  target: string,
  body: any,
): Promise<void> {
  switch (action) {
    case 'list': {
      const entries = await listDir(root, target)
      sendKimiJson(res, kimiOk({ entries }, rid))
      return
    }
    case 'stat': {
      let st: import('node:fs').Stats | undefined
      try {
        st = await fsp.stat(target)
      } catch { st = undefined }
      if (!st) {
        fail(res, kimiErr(KimiErrorCode.FS_PATH_NOT_FOUND, `path not found: ${String(body?.path ?? '')}`, rid))
        return
      }
      sendKimiJson(res, kimiOk({
        type: st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other',
        size: st.size,
        modified: new Date(st.mtimeMs).toISOString(),
        name: path.basename(target),
        path: path.relative(root, target).split(path.sep).join('/'),
      }, rid))
      return
    }
    case 'read': {
      let st: import('node:fs').Stats | undefined
      try {
        st = await fsp.stat(target)
      } catch { st = undefined }
      if (!st) {
        fail(res, kimiErr(KimiErrorCode.FS_PATH_NOT_FOUND, `path not found: ${String(body?.path ?? '')}`, rid))
        return
      }
      if (st.isDirectory()) {
        fail(res, kimiErr(KimiErrorCode.FS_IS_DIRECTORY, `path is a directory: ${String(body?.path ?? '')}`, rid))
        return
      }
      const offset = Math.max(0, Math.trunc(Number(body?.offset ?? 0)) || 0)
      const limit = Math.max(0, Math.trunc(Number(body?.limit ?? 0)) || 0)
      const raw = await fsp.readFile(target)
      if (raw.length > FS_TEXT_MAX_BYTES && offset === 0 && limit === 0) {
        fail(res, kimiErr(KimiErrorCode.FS_TOO_LARGE, `file exceeds ${FS_TEXT_MAX_BYTES} bytes; use offset/limit`, rid))
        return
      }
      const text = raw.toString('utf8')
      const slice = limit > 0 ? text.slice(offset, offset + limit) : text.slice(offset)
      sendKimiJson(res, kimiOk({
        content: slice,
        encoding: 'utf8',
        truncated: offset + slice.length < text.length,
        size: st.size,
      }, rid))
      return
    }
    case 'mkdir': {
      await fsp.mkdir(target, { recursive: body?.create_parents !== false })
      sendKimiJson(res, kimiOk({ created: true, path: path.relative(root, target).split(path.sep).join('/') }, rid))
      return
    }
    case 'search': {
      const pattern = String(body?.query ?? body?.pattern ?? '')
      if (!pattern) {
        fail(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, 'query is required', rid))
        return
      }
      const max = clampInt(numOr(String(body?.max_results ?? '')), 1, 500, 100)
      const needle = pattern.toLowerCase()
      const out: any[] = []
      const overflow = await walkFiles(root, async (file, rel) => {
        if (rel.toLowerCase().includes(needle)) {
          out.push(await statEntry(root, rel))
          if (out.length >= max) return true
        }
      })
      sendKimiJson(res, kimiOk({
        matches: out.filter(Boolean),
        truncated: overflow || out.length >= max,
      }, rid))
      return
    }
    case 'grep': {
      const pattern = String(body?.pattern ?? '')
      if (!pattern) {
        fail(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, 'pattern is required', rid))
        return
      }
      let re: RegExp
      try {
        re = new RegExp(pattern, body?.case_sensitive === false ? 'i' : '')
      } catch (err: any) {
        fail(res, kimiErr(KimiErrorCode.VALIDATION_FAILED, `invalid pattern: ${err?.message}`, rid))
        return
      }
      const max = clampInt(numOr(String(body?.max_results ?? '')), 1, 500, 100)
      const glob = typeof body?.glob === 'string' ? body.glob : undefined
      const matches: any[] = []
      const overflow = await walkFiles(root, async (file, rel) => {
        if (matches.length >= max) return true
        if (!globMatches(rel, glob)) return
        let st: import('node:fs').Stats | undefined
        try { st = await fsp.stat(file) } catch { return }
        if (!st || st.size > 2 * 1024 * 1024) return
        let text: string
        try { text = await fsp.readFile(file, 'utf8') } catch { return }
        if (text.includes('\u0000')) return
        const lines = text.split('\n')
        for (let i = 0; i < lines.length; i += 1) {
          re.lastIndex = 0
          if (!re.test(lines[i])) continue
          matches.push({ path: rel, line: i + 1, text: lines[i].slice(0, 500) })
          if (matches.length >= max) return true
        }
      })
      sendKimiJson(res, kimiOk({ matches, truncated: overflow || matches.length >= max }, rid))
      return
    }
  }
}

/** 目录列表（type 字段与 kimi 的 'file'|'directory' 对齐，按名排序） */
async function listDir(root: string, target: string): Promise<Array<Record<string, unknown>>> {
  let names: string[]
  try {
    names = await fsp.readdir(target)
  } catch {
    throw Object.assign(new Error(`path not found: ${path.relative(root, target)}`), { kimiCode: KimiErrorCode.FS_PATH_NOT_FOUND })
  }
  const out: Array<Record<string, unknown>> = []
  for (const name of names.sort()) {
    if (name === '.git' || name === 'node_modules') continue
    const entry = await statEntry(root, path.join(path.relative(root, target), name))
    if (entry) out.push(entry)
  }
  return out
}

function globMatches(rel: string, glob: string | undefined): boolean {
  if (!glob) return true
  // 极简 glob：* → 非分隔符任意串，** → 任意串，? → 单字符
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '[^/]')
  try {
    return new RegExp(`(^|/)${source}$`).test(rel.split(path.sep).join('/'))
  } catch {
    return true
  }
}
