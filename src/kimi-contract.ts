/**
 * dsh-web-service — Kimi 服务 API 兼容层：契约原语（信封 / 错误码 / 分页 / request_id）
 *
 * 本文件把 `kimi web` 本地服务（kap-server）的 REST 协议原语在 DSH 侧复刻一份：
 * 响应信封 `{ code, msg, data, request_id, details? }`、数字业务错误码表、游标式分页
 * 与 ULID request_id。语义逐条对齐 kap-server 的 `protocol/envelope.ts`、
 * `protocol/error-codes.ts`、`protocol/pagination.ts`、`protocol/request-id.ts`。
 *
 * 与原生 `/api/v1`（`{ ok, data, error, code }`）互不干涉：兼容层自带发送函数，
 * 不复用 router.ts 的 sendJson。
 */

import type { ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'

// ==================== 信封 ====================

export interface KimiEnvelope<T> {
  code: number
  msg: string
  data: T | null
  request_id: string
  details?: unknown
}

/** 成功信封：HTTP 200/201 + code 0（201 的响应体仍是标准信封，与 kap-server 一致） */
export function kimiOk<T>(data: T, requestId: string): KimiEnvelope<T> {
  return { code: 0, msg: 'success', data, request_id: requestId }
}

/** 错误信封：data 为 null，需要携带 data 的错误（如审批已解决）由调用方用 kimiRawError 覆写 */
export function kimiErr(code: number, msg: string, requestId: string, details?: unknown): KimiEnvelope<null> {
  const env: KimiEnvelope<null> = { code, msg, data: null, request_id: requestId }
  if (details !== undefined) env.details = details
  return env
}

/** 发送信封。HTTP 状态默认 200 —— kap-server 的业务结果只以 code 表达。 */
export function sendKimiJson(res: ServerResponse, envelope: KimiEnvelope<unknown>, httpStatus = 200): void {
  if (res.headersSent) return
  const body = JSON.stringify(envelope)
  res.statusCode = httpStatus
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(body)
}

// ==================== 错误码（数值段位与 kap-server 完全一致） ====================

export const KimiErrorCode = {
  SUCCESS: 0,

  VALIDATION_FAILED: 40001,
  REQUEST_MALFORMED: 40002,

  AUTH_UNAUTHORIZED: 40101,
  AUTH_TOKEN_MISSING: 40111,
  AUTH_TOKEN_UNAUTHORIZED: 40112,
  AUTH_MODEL_NOT_RESOLVED: 40113,

  SESSION_NOT_FOUND: 40401,
  PROMPT_NOT_FOUND: 40402,
  MESSAGE_NOT_FOUND: 40403,
  APPROVAL_NOT_FOUND: 40404,
  QUESTION_NOT_FOUND: 40405,
  TASK_NOT_FOUND: 40406,
  FILE_NOT_FOUND: 40407,
  MCP_SERVER_NOT_FOUND: 40408,
  FS_PATH_NOT_FOUND: 40409,
  WORKSPACE_NOT_FOUND: 40410,
  FS_PERMISSION_DENIED: 40411,
  PROVIDER_NOT_FOUND: 40412,
  MODEL_NOT_FOUND: 40413,
  TERMINAL_NOT_FOUND: 40414,
  SKILL_NOT_FOUND: 40415,

  SESSION_BUSY: 40901,
  APPROVAL_ALREADY_RESOLVED: 40902,
  TASK_ALREADY_FINISHED: 40904,
  FS_IS_DIRECTORY: 40906,
  QUESTION_DISMISSED: 40909,
  COMPACTION_UNABLE: 40910,
  SESSION_UNDO_UNAVAILABLE: 40911,
  PAGE_TOKEN_MISMATCH: 40922,
  PROMPT_ID_CONFLICT: 40927,

  APPROVAL_EXPIRED: 41001,
  QUESTION_EXPIRED: 41002,
  FILE_EXPIRED: 41003,

  FILE_TOO_LARGE: 41301,
  FS_TOO_LARGE: 41302,
  FS_PATH_ESCAPES_SESSION: 41304,

  AUTH_RATE_LIMIT: 42901,

  INTERNAL_ERROR: 50001,
  PERSISTENCE_FAILURE: 50003,

  TOOL_EXECUTION_FAILED: 60001,
  TOOL_NOT_AVAILABLE: 60002,
} as const

export type KimiErrorCode = (typeof KimiErrorCode)[keyof typeof KimiErrorCode]

/**
 * 原生路由的字符串错误码 → kimi 数字码。兼容层复用原生实现时用它做回落映射，
 * 具体端点应优先显式指定语义码（NOT_FOUND 到底是会话还是文件，只有调用点知道）。
 */
export const DSH_CODE_TO_KIMI: Record<string, number> = {
  NOT_FOUND: KimiErrorCode.SESSION_NOT_FOUND,
  BAD_REQUEST: KimiErrorCode.VALIDATION_FAILED,
  UNAUTHORIZED: KimiErrorCode.AUTH_UNAUTHORIZED,
  PAYLOAD_TOO_LARGE: KimiErrorCode.FILE_TOO_LARGE,
  SERVICE_UNAVAILABLE: KimiErrorCode.INTERNAL_ERROR,
  INTERNAL_ERROR: KimiErrorCode.INTERNAL_ERROR,
  NOT_SUPPORTED: KimiErrorCode.INTERNAL_ERROR,
  UNKNOWN_PRESET: KimiErrorCode.VALIDATION_FAILED,
  SESSION_NOT_FOUND: KimiErrorCode.SESSION_NOT_FOUND,
  WORKSPACE_NOT_FOUND: KimiErrorCode.WORKSPACE_NOT_FOUND,
  NO_PENDING_QUESTION: KimiErrorCode.QUESTION_NOT_FOUND,
  NO_MODEL_SELECTION: KimiErrorCode.VALIDATION_FAILED,
}

/** 由原生错误（{ error, code } 形状）构造 kimi 错误信封 */
export function kimiErrFromDsh(
  fail: { error?: string; code?: string; status?: number },
  requestId: string,
): KimiEnvelope<null> {
  const code = DSH_CODE_TO_KIMI[fail.code || ''] ?? KimiErrorCode.INTERNAL_ERROR
  return kimiErr(code, fail.error || 'request failed', requestId)
}

/**
 * 携带 data 的错误信封。kap-server 有少数「业务失败但响应体有内容」的形态
 * （重复解决审批返回 40902 + data `{resolved:false}`），标准 kimiErr 的 data 恒为
 * null，这类需要单独构造。
 */
export function kimiErrWithData<T>(
  code: number,
  msg: string,
  requestId: string,
  data: T,
  details?: unknown,
): KimiEnvelope<T> {
  const env: KimiEnvelope<T> = { code, msg, data, request_id: requestId }
  if (details !== undefined) env.details = details
  return env
}

// ==================== 动作后缀（:fork / :compact / …） ====================

/**
 * 解析 `/sessions/{id}:action` 形式的路径尾巴，语义对齐 kap-server
 * `routes/action-suffix.ts`：以最后一个 `:` 分割，允许动作集合外的一律判非法。
 * 返回 `kind:'bare'`（无后缀）、`kind:'action'`（命中允许动作，或空后缀落到
 * defaultAction）、`kind:'invalid'`（有冒号但动作不被支持）。
 */
export type ParsedActionSuffix =
  | { kind: 'bare'; id: string }
  | { kind: 'action'; id: string; action: string }
  | { kind: 'invalid'; id: string; suffix: string; allowed: readonly string[] }

export function parseActionSuffix(
  tail: string,
  allowed: readonly string[],
  defaultAction?: string,
): ParsedActionSuffix {
  const sep = tail.lastIndexOf(':')
  if (sep <= 0) {
    // 无冒号（或冒号在首位 = 非法资源 id）：有默认动作则裸 id 走默认动作，否则裸返回
    if (defaultAction && tail) return { kind: 'action', id: tail, action: defaultAction }
    return { kind: 'bare', id: tail }
  }
  const id = tail.slice(0, sep)
  const suffix = tail.slice(sep + 1)
  if (!suffix) {
    if (defaultAction && id) return { kind: 'action', id, action: defaultAction }
    return { kind: 'invalid', id, suffix, allowed }
  }
  if (!id) return { kind: 'invalid', id, suffix, allowed }
  if (allowed.includes(suffix)) return { kind: 'action', id, action: suffix }
  return { kind: 'invalid', id, suffix, allowed }
}

/** 校验是否命中裸 id（如 questions 的 bare tail 也要能当已知 id 处理） */
export function unsupportedActionMessage(suffix: string, allowed: readonly string[]): string {
  return `unsupported action '${suffix}', expected one of: ${allowed.map((a) => `:${a}`).join(', ')}`
}

// ==================== request_id（ULID） ====================

const ULID_ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ULID_TIME_LENGTH = 10
const ULID_RANDOM_LENGTH = 16
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i

/** 生成 ULID（48bit 毫秒时间 + 80bit 随机，Crockford base32） */
export function kimiUlid(now: number = Date.now()): string {
  let time = now
  const chars: string[] = new Array(ULID_TIME_LENGTH)
  for (let i = ULID_TIME_LENGTH - 1; i >= 0; i -= 1) {
    chars[i] = ULID_ENCODING[time % 32]
    time = Math.floor(time / 32)
  }
  const rand = randomBytes(ULID_RANDOM_LENGTH)
  let out = chars.join('')
  for (let i = 0; i < ULID_RANDOM_LENGTH; i += 1) {
    out += ULID_ENCODING[rand[i] % 32]
  }
  return out
}

/** 客户端可用 X-Request-Id 指定；非法值重新生成（与 kap-server parseOrGenerateRequestId 同语义） */
export function resolveRequestId(headerValue: string | undefined): string {
  if (typeof headerValue === 'string' && ULID_PATTERN.test(headerValue)) {
    return headerValue.toUpperCase()
  }
  return kimiUlid()
}

// ==================== 游标式分页 ====================

export interface CursorQuery {
  before_id?: string
  after_id?: string
  page_size?: number
}

export interface KimiPage<T> {
  items: T[]
  has_more: boolean
}

export const KIMI_MAX_PAGE_SIZE = 100

/**
 * 解析游标分页参数。before_id / after_id 互斥，page_size 限 1..100；
 * 非法时返回错误信封（40001 + details 逐字段说明），由调用方直接发送。
 */
export function parseCursorQuery(
  query: Record<string, string>,
  requestId: string,
): { ok: true; cursor: CursorQuery } | { ok: false; envelope: KimiEnvelope<null> } {
  const details: Array<{ path: string; message: string }> = []
  const before = typeof query.before_id === 'string' && query.before_id !== '' ? query.before_id : undefined
  const after = typeof query.after_id === 'string' && query.after_id !== '' ? query.after_id : undefined
  if (before !== undefined && after !== undefined) {
    details.push({ path: 'before_id', message: 'before_id and after_id are mutually exclusive' })
  }
  let pageSize: number | undefined
  if (query.page_size !== undefined && query.page_size !== '') {
    const parsed = Number(query.page_size)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > KIMI_MAX_PAGE_SIZE) {
      details.push({ path: 'page_size', message: `page_size must be an integer between 1 and ${KIMI_MAX_PAGE_SIZE}` })
    } else {
      pageSize = parsed
    }
  }
  if (details.length > 0) {
    return { ok: false, envelope: kimiErr(KimiErrorCode.VALIDATION_FAILED, 'validation failed', requestId, details) }
  }
  return { ok: true, cursor: { before_id: before, after_id: after, page_size: pageSize } }
}

/**
 * 对已按「新→旧」排序的数组做游标切片（与 kap-server messages 分页同语义：
 * before_id 取该条目之后（更旧）的部分，after_id 取该条目之前（更新）的部分）。
 */
export function pageByCursor<T>(desc: readonly T[], cursor: CursorQuery, idOf: (item: T) => string): KimiPage<T> {
  const size = cursor.page_size ?? 20
  let start = 0
  let end = desc.length
  if (cursor.before_id !== undefined) {
    const idx = desc.findIndex((item) => idOf(item) === cursor.before_id)
    if (idx >= 0) start = idx + 1
  } else if (cursor.after_id !== undefined) {
    const idx = desc.findIndex((item) => idOf(item) === cursor.after_id)
    if (idx >= 0) end = idx
  }
  const slice = desc.slice(start, end)
  return { items: slice.slice(0, size), has_more: slice.length > size }
}

/** 布尔查询参数：'true'/'1'/1/true → true，'false'/'0'/0/false → false，其余视为未提供 */
export function parseBoolQuery(value: string | undefined): boolean | undefined {
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  return undefined
}

/** ISO 时间（kimi 契约里所有时间字段都是 ISO 字符串，而非 DSH 原生的毫秒数） */
export function isoTime(ms: number | undefined | null): string {
  return new Date(typeof ms === 'number' && Number.isFinite(ms) ? ms : Date.now()).toISOString()
}
