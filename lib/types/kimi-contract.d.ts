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
import type { ServerResponse } from 'node:http';
export interface KimiEnvelope<T> {
    code: number;
    msg: string;
    data: T | null;
    request_id: string;
    details?: unknown;
}
/** 成功信封：HTTP 200/201 + code 0（201 的响应体仍是标准信封，与 kap-server 一致） */
export declare function kimiOk<T>(data: T, requestId: string): KimiEnvelope<T>;
/** 错误信封：data 为 null，需要携带 data 的错误（如审批已解决）由调用方用 kimiRawError 覆写 */
export declare function kimiErr(code: number, msg: string, requestId: string, details?: unknown): KimiEnvelope<null>;
/** 发送信封。HTTP 状态默认 200 —— kap-server 的业务结果只以 code 表达。 */
export declare function sendKimiJson(res: ServerResponse, envelope: KimiEnvelope<unknown>, httpStatus?: number): void;
export declare const KimiErrorCode: {
    readonly SUCCESS: 0;
    readonly VALIDATION_FAILED: 40001;
    readonly REQUEST_MALFORMED: 40002;
    readonly AUTH_UNAUTHORIZED: 40101;
    readonly AUTH_TOKEN_MISSING: 40111;
    readonly AUTH_TOKEN_UNAUTHORIZED: 40112;
    readonly AUTH_MODEL_NOT_RESOLVED: 40113;
    readonly SESSION_NOT_FOUND: 40401;
    readonly PROMPT_NOT_FOUND: 40402;
    readonly MESSAGE_NOT_FOUND: 40403;
    readonly APPROVAL_NOT_FOUND: 40404;
    readonly QUESTION_NOT_FOUND: 40405;
    readonly TASK_NOT_FOUND: 40406;
    readonly FILE_NOT_FOUND: 40407;
    readonly MCP_SERVER_NOT_FOUND: 40408;
    readonly FS_PATH_NOT_FOUND: 40409;
    readonly WORKSPACE_NOT_FOUND: 40410;
    readonly FS_PERMISSION_DENIED: 40411;
    readonly PROVIDER_NOT_FOUND: 40412;
    readonly MODEL_NOT_FOUND: 40413;
    readonly TERMINAL_NOT_FOUND: 40414;
    readonly SKILL_NOT_FOUND: 40415;
    readonly SESSION_BUSY: 40901;
    readonly APPROVAL_ALREADY_RESOLVED: 40902;
    readonly TASK_ALREADY_FINISHED: 40904;
    readonly FS_IS_DIRECTORY: 40906;
    readonly QUESTION_DISMISSED: 40909;
    readonly COMPACTION_UNABLE: 40910;
    readonly SESSION_UNDO_UNAVAILABLE: 40911;
    readonly PAGE_TOKEN_MISMATCH: 40922;
    readonly PROMPT_ID_CONFLICT: 40927;
    readonly APPROVAL_EXPIRED: 41001;
    readonly QUESTION_EXPIRED: 41002;
    readonly FILE_EXPIRED: 41003;
    readonly FILE_TOO_LARGE: 41301;
    readonly FS_TOO_LARGE: 41302;
    readonly FS_PATH_ESCAPES_SESSION: 41304;
    readonly AUTH_RATE_LIMIT: 42901;
    readonly INTERNAL_ERROR: 50001;
    readonly PERSISTENCE_FAILURE: 50003;
    readonly TOOL_EXECUTION_FAILED: 60001;
    readonly TOOL_NOT_AVAILABLE: 60002;
};
export type KimiErrorCode = (typeof KimiErrorCode)[keyof typeof KimiErrorCode];
/**
 * 原生路由的字符串错误码 → kimi 数字码。兼容层复用原生实现时用它做回落映射，
 * 具体端点应优先显式指定语义码（NOT_FOUND 到底是会话还是文件，只有调用点知道）。
 */
export declare const DSH_CODE_TO_KIMI: Record<string, number>;
/** 由原生错误（{ error, code } 形状）构造 kimi 错误信封 */
export declare function kimiErrFromDsh(fail: {
    error?: string;
    code?: string;
    status?: number;
}, requestId: string): KimiEnvelope<null>;
/**
 * 携带 data 的错误信封。kap-server 有少数「业务失败但响应体有内容」的形态
 * （重复解决审批返回 40902 + data `{resolved:false}`），标准 kimiErr 的 data 恒为
 * null，这类需要单独构造。
 */
export declare function kimiErrWithData<T>(code: number, msg: string, requestId: string, data: T, details?: unknown): KimiEnvelope<T>;
/**
 * 解析 `/sessions/{id}:action` 形式的路径尾巴，语义对齐 kap-server
 * `routes/action-suffix.ts`：以最后一个 `:` 分割，允许动作集合外的一律判非法。
 * 返回 `kind:'bare'`（无后缀）、`kind:'action'`（命中允许动作，或空后缀落到
 * defaultAction）、`kind:'invalid'`（有冒号但动作不被支持）。
 */
export type ParsedActionSuffix = {
    kind: 'bare';
    id: string;
} | {
    kind: 'action';
    id: string;
    action: string;
} | {
    kind: 'invalid';
    id: string;
    suffix: string;
    allowed: readonly string[];
};
export declare function parseActionSuffix(tail: string, allowed: readonly string[], defaultAction?: string): ParsedActionSuffix;
/** 校验是否命中裸 id（如 questions 的 bare tail 也要能当已知 id 处理） */
export declare function unsupportedActionMessage(suffix: string, allowed: readonly string[]): string;
/** 生成 ULID（48bit 毫秒时间 + 80bit 随机，Crockford base32） */
export declare function kimiUlid(now?: number): string;
/** 客户端可用 X-Request-Id 指定；非法值重新生成（与 kap-server parseOrGenerateRequestId 同语义） */
export declare function resolveRequestId(headerValue: string | undefined): string;
export interface CursorQuery {
    before_id?: string;
    after_id?: string;
    page_size?: number;
}
export interface KimiPage<T> {
    items: T[];
    has_more: boolean;
}
export declare const KIMI_MAX_PAGE_SIZE = 100;
/**
 * 解析游标分页参数。before_id / after_id 互斥，page_size 限 1..100；
 * 非法时返回错误信封（40001 + details 逐字段说明），由调用方直接发送。
 */
export declare function parseCursorQuery(query: Record<string, string>, requestId: string): {
    ok: true;
    cursor: CursorQuery;
} | {
    ok: false;
    envelope: KimiEnvelope<null>;
};
/**
 * 对已按「新→旧」排序的数组做游标切片（与 kap-server messages 分页同语义：
 * before_id 取该条目之后（更旧）的部分，after_id 取该条目之前（更新）的部分）。
 */
export declare function pageByCursor<T>(desc: readonly T[], cursor: CursorQuery, idOf: (item: T) => string): KimiPage<T>;
/** 布尔查询参数：'true'/'1'/1/true → true，'false'/'0'/0/false → false，其余视为未提供 */
export declare function parseBoolQuery(value: string | undefined): boolean | undefined;
/** ISO 时间（kimi 契约里所有时间字段都是 ISO 字符串，而非 DSH 原生的毫秒数） */
export declare function isoTime(ms: number | undefined | null): string;
