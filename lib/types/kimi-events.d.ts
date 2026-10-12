/**
 * dsh-web-service — Kimi 兼容层：DSH 事件流 → kimi 事件 / 转录 / 消息投影
 *
 * DSH 核心只有一种会话事件日志（`session/event`，形如 `{ seq, type, data, time }`，
 * type 为 `turn/start`、`assistant/chunk`、`tool/call` 等斜杠命名）。kimi 契约要求的是
 * 另一套点命名事件（`turn.started`、`assistant.delta`…）与 L1–L4 转录结构
 * （turn → step → frame）。本模块是两者之间唯一的翻译层：
 *
 *   - `toKimiEvent`   : 单条 DSH 事件 → kimi 事件 payload（WS 帧 / SSE 帧共用）
 *   - `foldTranscript`: 事件日志 → kimi 转录（items/tasks/todos/prompts/meta）
 *   - `foldMessages`  : 事件日志 → kimi 消息列表（role + content 块）
 *
 * 转录的 turnId 用 `t<turn序号>`、stepId 用 `s<turn>-<step>`、frameId 由所属 step 与
 * 角色/工具调用号派生（`textFrameIdOf` 等），保证同一事件日志重放得到稳定 id，
 * 也让全量快照（foldTranscript）与增量 op（buildTranscriptOps）落到同一批节点上。
 * agentId 固定 `main`（DSH 会话无多 agent 转录面）。
 */
export declare const KIMI_MAIN_AGENT_ID = "main";
/**
 * 转录帧的稳定 id：由所属 step + 角色/工具调用号派生，不依赖事件序号。
 * 全量重放（foldTranscript）与增量投影（兼容层 transcriptOps）必须用同一套 id，
 * 客户端才能把后续 upsert 落到已有帧上而不是新建重复帧。
 */
export declare const textFrameIdOf: (stepId: string) => string;
export declare const thinkingFrameIdOf: (stepId: string) => string;
export declare const toolFrameIdOf: (stepId: string, callId: string) => string;
export declare const noticeFrameIdOf: (stepId: string, seq: number | undefined) => string;
/**
 * 单条 DSH 事件 → kimi 事件 payload。返回 undefined 表示该事件不进入 kimi 事件面
 * （例如 DSH 独有的 `step/end`、`permission/preset`，kimi 无对应类型）。
 *
 * payload 形状对齐 kap-server `protocol/events-zod.ts`：点命名 type + camelCase 字段。
 */
export declare function toKimiEvent(event: any): Record<string, unknown> | undefined;
export interface KimiTranscriptFrame {
    kind: 'text' | 'thinking' | 'tool' | 'notice';
    frameId: string;
    [key: string]: unknown;
}
export interface KimiTranscriptStep {
    kind: 'step';
    stepId: string;
    turnId: string;
    ordinal: number;
    state: 'running' | 'completed' | 'interrupted' | 'failed';
    frames: KimiTranscriptFrame[];
    startedAt?: string;
    endedAt?: string;
    usage?: Record<string, number>;
    finishReason?: string;
}
export interface KimiTranscriptTurn {
    kind: 'turn';
    turnId: string;
    ordinal: number;
    state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
    origin: {
        kind: string;
    };
    prompt?: string;
    steps: KimiTranscriptStep[];
    startedAt?: string;
    endedAt?: string;
    usage?: Record<string, number | undefined>;
    error?: string;
}
export interface KimiTranscript {
    agent_id: string;
    items: Array<KimiTranscriptTurn | Record<string, unknown>>;
    has_more: boolean;
    tasks: unknown[];
    interactions: unknown[];
    attachments: unknown[];
    todos: Array<Record<string, unknown>>;
    prompts: Array<Record<string, unknown>>;
    meta: Record<string, unknown>;
    agents: Array<Record<string, unknown>>;
    pending_interactions: string[];
    seq?: number;
}
/**
 * 事件日志 → kimi 转录（L1 turns / L2 steps / L3 frames）。
 * 只读投影：每次调用重放整段日志，因此进程重启或事件补齐后结果自然一致。
 */
export declare function foldTranscript(events: readonly any[], opts?: {
    now?: number;
}): KimiTranscript;
export interface KimiMessageContent {
    type: string;
    [key: string]: unknown;
}
export interface KimiMessage {
    id: string;
    session_id: string;
    role: 'user' | 'assistant' | 'tool' | 'system';
    content: KimiMessageContent[];
    created_at: string;
    prompt_id?: string;
    metadata?: Record<string, unknown>;
}
/**
 * 事件日志 → kimi 消息列表（按时间正序）。
 * `user/message` → user 消息；`assistant/message` → assistant 消息（含 tool_use 块，
 * 并把后续 `tool/result` 合成为独立 tool 消息，与 kimi 的 role 集合对齐）。
 */
export declare function foldMessages(events: readonly any[], sessionId: string): KimiMessage[];
/** 转录按 turn 分页（kimi `before_turn` / `after_turn` + page_size 语义） */
export declare function paginateTurns<T extends {
    ordinal: number;
}>(items: readonly T[], query: {
    before_turn?: string;
    after_turn?: string;
    page_size?: number;
}): {
    items: T[];
    hasMore: boolean;
};
/** 把 kimi 提示词内容块转成 DSH 的 user 消息文本（file/image 块降级为路径或名称提示） */
export declare function promptContentToText(content: readonly KimiMessageContent[]): string;
/**
 * 转录 op 的游标 seq 定义为「事件日志中截至此处、产生过 op 的事件个数」，而不是 DSH
 * 事件序号：SDK 要求 transcript.ops 的 seq 逐 1 连续（否则判为 gap 并回退全量）。
 * 因此 REST /transcript、REST /transcript/ops、WS transcript.reset、WS transcript.ops
 * 四处必须用同一套编号，且帧 id 必须与 foldTranscript 完全一致。
 */
export interface KimiTranscriptOpsBatch {
    seq: number;
    ops: Record<string, unknown>[];
}
export interface KimiTranscriptOpsResult {
    agent_id: string;
    batches: KimiTranscriptOpsBatch[];
    latest_seq: number;
    event_seq: number;
}
/** op 机的可重入状态（全量重放与 WS 增量推送共用） */
export interface KimiTranscriptOpState {
    turns: KimiTranscriptTurn[];
    prompts: Array<Record<string, unknown>>;
    todos: Array<Record<string, unknown>>;
    current?: KimiTranscriptTurn;
    currentStep?: KimiTranscriptStep;
    /** 已发出的 op 批次编号（= 转录游标 seq） */
    seq: number;
    /** 已消费到的 DSH 事件 seq 水位 */
    eventSeq: number;
    activity: 'idle' | 'turn';
}
export declare function createTranscriptOpState(): KimiTranscriptOpState;
/**
 * 一条 DSH 事件 → 转录 op 批次（无 op 时返回空数组，调用方不应计入 seq）。
 * 与 foldTranscript 的分支一一对应，产出同构的 turn/step/frame id。
 */
export declare function applyTranscriptEvent(state: KimiTranscriptOpState, ev: any): Record<string, unknown>[];
/** 全量重放事件日志，得到 op 批次序列与最新游标 */
export declare function buildTranscriptOps(events: readonly any[]): KimiTranscriptOpsResult;
/**
 * 回溯补放：取 seq > sinceSeq 的批次。
 * sinceSeq 大于当前最新游标（服务重启、日志截断等）时 complete:false，
 * 调用方（SDK）按契约回退到全量 transcript GET。
 */
export declare function transcriptOpsSince(events: readonly any[], sinceSeq: number): KimiTranscriptOpsResult & {
    complete: boolean;
};
/** 转录快照（agentTranscriptSnapshot 形状）+ 游标 seq */
export declare function transcriptSnapshotOf(events: readonly any[]): {
    snapshot: KimiTranscript;
    seq: number;
};
/**
 * 全量重放事件日志，返回可继续增量推进的 op 状态机（WS 订阅用）：
 * state.seq 即当前转录游标，后续每条 live 事件经 applyTranscriptEvent 产出 op 后 +1。
 */
export declare function replayTranscript(events: readonly any[]): {
    state: KimiTranscriptOpState;
    batches: KimiTranscriptOpsBatch[];
    latest_seq: number;
};
