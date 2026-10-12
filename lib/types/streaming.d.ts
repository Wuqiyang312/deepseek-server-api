/**
 * dsh-web-service - Streaming & Chat API Handlers
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionPromptInput } from './types.js';
export declare function registerStreamingRoutes(ctx: Context, router: any): void;
/** 提交 Prompt 到 Session 执行 */
export declare function submitPromptToSession(ctx: Context, sessionId: string, input: SessionPromptInput): Promise<void>;
