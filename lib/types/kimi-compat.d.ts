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
import type { Context } from '@deepseek-ai/cordis';
import type { HttpRouter } from './router.js';
import type { WebServiceConfig } from './types.js';
import { FailureRateLimiter, type ApiKeyStore } from './api-keys-store.js';
import { type KimiWsDeps } from './kimi-ws.js';
/** 进程世代 id：WS 事件流 epoch，客户端 cursor 的 epoch 与之不符即触发 resync */
export declare const KIMI_EPOCH: string;
export interface KimiWireSessionInput {
    id: string;
    title?: string;
    createdAt?: number;
    updatedAt?: number;
    /** DSH workspace id（可选；缺省时用 cwd 合成别名） */
    dshWorkspaceId?: string;
    cwd?: string;
    busy?: boolean;
    events?: any[];
    /** 列表投影：不加载事件、usage/seq 全零 */
    lite?: boolean;
    model?: string;
}
export interface KimiAuthDeps {
    keyStore: ApiKeyStore;
    limiter: FailureRateLimiter;
}
export interface KimiCompatOptions {
    config: WebServiceConfig;
    keyStore: ApiKeyStore;
    /** DSH webServer 不可用时（standalone）由 index.ts 传入的服务端口，用于 /meta 提示 */
    serverVersion?: string;
}
/** 构建 kimi WS 协议所需的宿主依赖（index.ts 的 registerUpgrade / standalone upgrade 共用） */
export declare function buildKimiWsDeps(ctx: Context, opts: KimiCompatOptions): KimiWsDeps;
/**
 * 把 kimi REST 契约注册进一个独立的 HttpRouter（与原生路由互不干涉）。
 * 路径按 SDK 拼接规则写全 `/api/v1/...`、`/api/v2/...`；挂载前缀由 index.ts 决定。
 */
export declare function registerKimiCompatRoutes(ctx: Context, router: HttpRouter, opts: KimiCompatOptions): void;
