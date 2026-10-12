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
export const KIMI_MAIN_AGENT_ID = 'main';
/** DSH `turn/end` reason → kimi `turn.ended` reason（kimi 只认四个值） */
function kimiTurnReason(reason) {
    switch (reason) {
        case 'cancelled':
        case 'canceled':
        case 'interrupted':
        case 'aborted':
            return 'cancelled';
        case 'failed':
        case 'error':
            return 'failed';
        case 'blocked':
            return 'blocked';
        default:
            return 'completed';
    }
}
/** DSH 事件 `data.turn` / `data.step` 读数（缺失返回 undefined） */
function turnOf(event) {
    return typeof event?.data?.turn === 'number' ? event.data.turn : undefined;
}
function stepOf(event) {
    return typeof event?.data?.step === 'number' ? event.data.step : undefined;
}
const turnIdOf = (turn) => `t${turn ?? 0}`;
const stepIdOf = (turn, step) => `s${turn ?? 0}-${step ?? 0}`;
/**
 * 转录帧的稳定 id：由所属 step + 角色/工具调用号派生，不依赖事件序号。
 * 全量重放（foldTranscript）与增量投影（兼容层 transcriptOps）必须用同一套 id，
 * 客户端才能把后续 upsert 落到已有帧上而不是新建重复帧。
 */
export const textFrameIdOf = (stepId) => `${stepId}#text`;
export const thinkingFrameIdOf = (stepId) => `${stepId}#thinking`;
export const toolFrameIdOf = (stepId, callId) => `${stepId}#tool#${callId || 'call'}`;
export const noticeFrameIdOf = (stepId, seq) => `${stepId}#notice#${seq ?? 0}`;
/**
 * 单条 DSH 事件 → kimi 事件 payload。返回 undefined 表示该事件不进入 kimi 事件面
 * （例如 DSH 独有的 `step/end`、`permission/preset`，kimi 无对应类型）。
 *
 * payload 形状对齐 kap-server `protocol/events-zod.ts`：点命名 type + camelCase 字段。
 */
export function toKimiEvent(event) {
    const turn = turnOf(event);
    const step = stepOf(event);
    switch (event?.type) {
        case 'turn/start':
            return {
                type: 'turn.started',
                agentId: KIMI_MAIN_AGENT_ID,
                turnId: turn ?? 0,
                origin: { kind: 'user' },
            };
        case 'user/message':
            // kimi 把用户消息落在 turn.started 的 prompt 字段上；事件面不单独广播 user 消息
            return undefined;
        case 'step/start':
            return {
                type: 'turn.step.started',
                agentId: KIMI_MAIN_AGENT_ID,
                turnId: turn ?? 0,
                step: step ?? 0,
            };
        case 'assistant/chunk': {
            const chunk = event?.data?.chunk;
            if (chunk?.type === 'text-delta') {
                return {
                    type: 'assistant.delta',
                    agentId: KIMI_MAIN_AGENT_ID,
                    turnId: turn ?? 0,
                    delta: typeof chunk.text === 'string' ? chunk.text : '',
                };
            }
            if (chunk?.type === 'reasoning-delta') {
                return {
                    type: 'thinking.delta',
                    agentId: KIMI_MAIN_AGENT_ID,
                    turnId: turn ?? 0,
                    delta: typeof chunk.text === 'string' ? chunk.text : '',
                };
            }
            return undefined;
        }
        case 'assistant/delta':
            return {
                type: 'assistant.delta',
                agentId: KIMI_MAIN_AGENT_ID,
                turnId: turn ?? 0,
                delta: typeof event?.data?.delta === 'string' ? event.data.delta : '',
            };
        case 'reasoning/delta':
            return {
                type: 'thinking.delta',
                agentId: KIMI_MAIN_AGENT_ID,
                turnId: turn ?? 0,
                delta: typeof event?.data?.delta === 'string' ? event.data.delta : '',
            };
        case 'tool/call':
            return {
                type: 'tool.call.started',
                agentId: KIMI_MAIN_AGENT_ID,
                turnId: turn ?? 0,
                toolCallId: String(event?.data?.callId ?? ''),
                name: String(event?.data?.name ?? ''),
                args: event?.data?.arguments,
            };
        case 'tool/result': {
            const block = firstToolResultBlock(event?.data?.message);
            return {
                type: 'tool.result',
                agentId: KIMI_MAIN_AGENT_ID,
                turnId: turn ?? 0,
                toolCallId: String(block?.toolCallId ?? event?.data?.callId ?? ''),
                output: block?.content ?? event?.data?.content,
                isError: block?.isError === true || Boolean(event?.data?.error),
            };
        }
        case 'todo/write':
            return {
                type: 'turn.step.completed',
                agentId: KIMI_MAIN_AGENT_ID,
                turnId: turn ?? 0,
                step: step ?? 0,
                finishReason: 'tool_calls',
            };
        case 'usage':
            return {
                type: 'turn.step.completed',
                agentId: KIMI_MAIN_AGENT_ID,
                turnId: turn ?? 0,
                step: step ?? 0,
                usage: kimiTokenUsage(event?.data?.usage ?? event?.data),
            };
        case 'assistant/message': {
            const usage = kimiTokenUsage(event?.data?.usage);
            return {
                type: 'turn.step.completed',
                agentId: KIMI_MAIN_AGENT_ID,
                turnId: turn ?? 0,
                step: step ?? 0,
                ...(usage ? { usage } : {}),
                finishReason: 'stop',
            };
        }
        case 'turn/end':
            return {
                type: 'turn.ended',
                agentId: KIMI_MAIN_AGENT_ID,
                turnId: turn ?? 0,
                reason: kimiTurnReason(event?.data?.reason),
            };
        case 'error':
            return {
                type: 'error',
                agentId: KIMI_MAIN_AGENT_ID,
                turnId: turn ?? 0,
                message: String(event?.data?.message ?? 'agent error'),
            };
        default:
            return undefined;
    }
}
/** DSH TokenUsage → kimi tokenUsageSchema（inputOther/output/inputCacheRead/inputCacheCreation） */
function kimiTokenUsage(usage) {
    if (!usage || typeof usage !== 'object')
        return undefined;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return {
        inputOther: num(usage.inputTokens),
        output: num(usage.outputTokens),
        inputCacheRead: num(usage.cacheReadTokens),
        inputCacheCreation: num(usage.cacheWriteTokens),
    };
}
function firstToolResultBlock(message) {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    return blocks.find((b) => b?.type === 'tool-result');
}
/** 扁平化 DSH 工具结果内容为文本（数组/对象都能落到一个字符串上） */
function flattenContent(content) {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        return content
            .map((x) => (typeof x?.text === 'string' ? x.text : typeof x === 'string' ? x : safeJson(x)))
            .join('\n');
    }
    return safeJson(content);
}
function safeJson(value) {
    try {
        return JSON.stringify(value ?? '');
    }
    catch {
        return String(value);
    }
}
/**
 * 事件日志 → kimi 转录（L1 turns / L2 steps / L3 frames）。
 * 只读投影：每次调用重放整段日志，因此进程重启或事件补齐后结果自然一致。
 */
export function foldTranscript(events, opts) {
    const now = opts?.now ?? Date.now();
    const turns = [];
    const todos = [];
    const prompts = [];
    let current;
    let currentStep;
    let activity = 'idle';
    const closeStep = (state, atMs) => {
        if (!currentStep)
            return;
        currentStep.state = state;
        currentStep.endedAt = isoOrUndefined(atMs);
        current = undefined;
        currentStep = undefined;
    };
    const openStep = (event, atMs) => {
        const turn = turnOf(event);
        const step = stepOf(event);
        const built = {
            kind: 'step',
            stepId: stepIdOf(turn, step),
            turnId: turnIdOf(turn),
            ordinal: step ?? 0,
            state: 'running',
            frames: [],
            startedAt: isoOrUndefined(atMs),
        };
        if (current)
            current.steps.push(built);
        currentStep = built;
        return built;
    };
    for (const ev of events || []) {
        const atMs = typeof ev?.time === 'number' ? ev.time : undefined;
        const turn = turnOf(ev);
        switch (ev?.type) {
            case 'turn/start': {
                closeStep('interrupted', atMs);
                current = {
                    kind: 'turn',
                    turnId: turnIdOf(turn),
                    ordinal: (turn ?? turns.length) + 1,
                    state: 'running',
                    origin: { kind: 'user' },
                    steps: [],
                    startedAt: isoOrUndefined(atMs),
                };
                turns.push(current);
                activity = 'turn';
                prompts.push({
                    promptId: `p${turn ?? turns.length}`,
                    status: 'running',
                    createdAt: current.startedAt ?? new Date(now).toISOString(),
                });
                break;
            }
            case 'user/message': {
                const text = blocksText(ev?.data?.content);
                if (current)
                    current.prompt = text;
                const prompt = prompts[prompts.length - 1];
                if (prompt)
                    prompt.content = [{ type: 'text', text }];
                break;
            }
            case 'step/start': {
                if (!current) {
                    // 事件日志缺 turn/start（旧核心或截断）：按 step 自带 turn 补一个壳
                    current = {
                        kind: 'turn',
                        turnId: turnIdOf(turn),
                        ordinal: (turn ?? turns.length) + 1,
                        state: 'running',
                        origin: { kind: 'user' },
                        steps: [],
                        startedAt: isoOrUndefined(atMs),
                    };
                    turns.push(current);
                }
                if (currentStep)
                    closeStep('completed', atMs);
                openStep(ev, atMs);
                break;
            }
            case 'assistant/chunk': {
                const chunk = ev?.data?.chunk;
                const step = currentStep ?? openStep(ev, atMs);
                if (chunk?.type === 'text-delta') {
                    appendTextFrame(step, 'assistant', String(chunk.text ?? ''));
                }
                else if (chunk?.type === 'reasoning-delta') {
                    appendThinkingFrame(step, String(chunk.text ?? ''));
                }
                break;
            }
            case 'assistant/delta': {
                const step = currentStep ?? openStep(ev, atMs);
                appendTextFrame(step, 'assistant', String(ev?.data?.delta ?? ''));
                break;
            }
            case 'reasoning/delta': {
                const step = currentStep ?? openStep(ev, atMs);
                appendThinkingFrame(step, String(ev?.data?.delta ?? ''));
                break;
            }
            case 'tool/call': {
                const step = currentStep ?? openStep(ev, atMs);
                const callId = String(ev?.data?.callId ?? '');
                step.frames.push({
                    kind: 'tool',
                    frameId: toolFrameIdOf(step.stepId, callId),
                    toolCallId: callId,
                    name: String(ev?.data?.name ?? ''),
                    state: 'running',
                    input: ev?.data?.arguments,
                });
                break;
            }
            case 'tool/result': {
                const step = currentStep ?? openStep(ev, atMs);
                const block = firstToolResultBlock(ev?.data?.message);
                const callId = String(block?.toolCallId ?? ev?.data?.callId ?? '');
                const existing = step.frames.find((f) => f.kind === 'tool' && f.toolCallId === callId);
                const isError = block?.isError === true || Boolean(ev?.data?.error);
                const output = flattenContent(block?.content ?? ev?.data?.content);
                if (existing) {
                    existing.state = isError ? 'error' : 'done';
                    existing.output = output;
                }
                else {
                    step.frames.push({
                        kind: 'tool',
                        frameId: toolFrameIdOf(step.stepId, callId),
                        toolCallId: callId,
                        name: '',
                        state: isError ? 'error' : 'done',
                        output,
                    });
                }
                break;
            }
            case 'assistant/message': {
                const step = currentStep ?? openStep(ev, atMs);
                const message = ev?.data?.message;
                const text = blocksText(message?.content);
                const reasoning = blocksByType(message?.content, ['reasoning', 'thinking'])
                    .map((b) => String(b.text ?? ''))
                    .join('');
                // 有完整消息时以全文覆盖增量拼接结果，避免旧核心不发 chunk 时转录为空
                if (text)
                    replaceTextFrame(step, 'assistant', text);
                if (reasoning)
                    replaceThinkingFrame(step, reasoning);
                const usage = kimiTokenUsage(ev?.data?.usage);
                if (usage)
                    step.usage = usage;
                step.finishReason = 'stop';
                closeStep('completed', atMs);
                if (current && current.state === 'running')
                    current.state = 'running';
                break;
            }
            case 'usage': {
                const usage = kimiTokenUsage(ev?.data?.usage ?? ev?.data);
                if (usage && current) {
                    current.usage = current.usage
                        ? {
                            inputTokens: (current.usage.inputTokens ?? 0) + usage.inputOther,
                            outputTokens: (current.usage.outputTokens ?? 0) + usage.output,
                            cachedTokens: (current.usage.cachedTokens ?? 0) + usage.inputCacheRead,
                        }
                        : { inputTokens: usage.inputOther, outputTokens: usage.output, cachedTokens: usage.inputCacheRead };
                }
                break;
            }
            case 'todo/write': {
                const items = normalizeTodoItems(ev?.data?.todos);
                todos.length = 0;
                if (items.length) {
                    todos.push({
                        todoId: `todo${turns.length || 1}`,
                        items,
                        updatedAt: isoOrUndefined(atMs) ?? new Date(now).toISOString(),
                    });
                }
                break;
            }
            case 'step/end': {
                if (currentStep)
                    closeStep('completed', atMs);
                break;
            }
            case 'turn/end': {
                if (currentStep)
                    closeStep('completed', atMs);
                const reason = kimiTurnReason(ev?.data?.reason);
                if (current) {
                    // kimi turnStateSchema 没有 blocked：blocked 收尾按 failed 建模
                    current.state = reason === 'completed' ? 'completed' : reason === 'blocked' ? 'failed' : reason;
                    current.endedAt = isoOrUndefined(atMs);
                }
                const prompt = prompts[prompts.length - 1];
                if (prompt) {
                    prompt.status = reason === 'completed' ? 'completed' : reason;
                    prompt.finishedAt = isoOrUndefined(atMs) ?? new Date(now).toISOString();
                }
                activity = 'idle';
                current = undefined;
                break;
            }
            case 'error': {
                const step = currentStep ?? openStep(ev, atMs);
                step.frames.push({
                    kind: 'notice',
                    frameId: `f${ev?.seq ?? step.frames.length}`,
                    level: 'error',
                    source: 'agent',
                    message: String(ev?.data?.message ?? 'agent error'),
                });
                if (current) {
                    current.state = 'failed';
                    current.error = String(ev?.data?.message ?? 'agent error');
                    current.endedAt = isoOrUndefined(atMs);
                }
                activity = 'idle';
                currentStep = undefined;
                current = undefined;
                break;
            }
            default:
                break;
        }
    }
    // 未闭合的 turn/step：会话仍在运行时保持 running，否则按 idle 收尾
    if (currentStep)
        currentStep.state = activity === 'turn' ? 'running' : 'completed';
    if (current && current.state === 'running' && activity !== 'turn')
        current.state = 'completed';
    return {
        agent_id: KIMI_MAIN_AGENT_ID,
        items: turns,
        has_more: false,
        tasks: [],
        interactions: [],
        attachments: [],
        todos,
        prompts,
        meta: { activity },
        agents: [{ agentId: KIMI_MAIN_AGENT_ID, type: 'main' }],
        pending_interactions: [],
        seq: lastSeq(events),
    };
}
function appendTextFrame(step, role, text) {
    const last = step.frames[step.frames.length - 1];
    if (last && last.kind === 'text' && last.role === role) {
        ;
        last.text = String(last.text ?? '') + text;
        return;
    }
    step.frames.push({ kind: 'text', frameId: textFrameIdOf(step.stepId), role, text });
}
function replaceTextFrame(step, role, text) {
    const existing = step.frames.find((f) => f.kind === 'text' && f.role === role);
    if (existing) {
        existing.text = text;
        return;
    }
    step.frames.push({ kind: 'text', frameId: textFrameIdOf(step.stepId), role, text });
}
function appendThinkingFrame(step, text) {
    const last = step.frames[step.frames.length - 1];
    if (last && last.kind === 'thinking') {
        ;
        last.text = String(last.text ?? '') + text;
        return;
    }
    step.frames.push({ kind: 'thinking', frameId: thinkingFrameIdOf(step.stepId), text });
}
function replaceThinkingFrame(step, text) {
    const existing = step.frames.find((f) => f.kind === 'thinking');
    if (existing) {
        existing.text = text;
        return;
    }
    step.frames.push({ kind: 'thinking', frameId: thinkingFrameIdOf(step.stepId), text });
}
function blocksText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content
        .filter((c) => c?.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');
}
function blocksByType(content, types) {
    if (!Array.isArray(content))
        return [];
    return content.filter((c) => types.includes(String(c?.type)));
}
function normalizeTodoItems(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw
        .map((item) => ({
        title: typeof item?.content === 'string' ? item.content.trim() : '',
        status: item?.status === 'in_progress' || item?.status === 'completed' ? item.status : 'pending',
    }))
        .filter((item) => item.title !== '');
}
function lastSeq(events) {
    let max = 0;
    for (const ev of events || []) {
        if (typeof ev?.seq === 'number' && ev.seq > max)
            max = ev.seq;
    }
    return max;
}
function isoOrUndefined(ms) {
    return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}
/**
 * 事件日志 → kimi 消息列表（按时间正序）。
 * `user/message` → user 消息；`assistant/message` → assistant 消息（含 tool_use 块，
 * 并把后续 `tool/result` 合成为独立 tool 消息，与 kimi 的 role 集合对齐）。
 */
export function foldMessages(events, sessionId) {
    const out = [];
    for (const ev of events || []) {
        const created = isoOrUndefined(ev?.time) ?? new Date().toISOString();
        const id = `msg_${ev?.seq ?? out.length}`;
        if (ev?.type === 'user/message') {
            const blocks = [];
            const text = blocksText(ev?.data?.content);
            if (text)
                blocks.push({ type: 'text', text });
            out.push({ id, session_id: sessionId, role: 'user', content: blocks, created_at: created });
        }
        else if (ev?.type === 'assistant/message') {
            const message = ev?.data?.message;
            const blocks = [];
            const source = Array.isArray(message?.content) ? message.content : [];
            for (const part of source) {
                if (part?.type === 'text' && typeof part.text === 'string') {
                    if (part.text)
                        blocks.push({ type: 'text', text: part.text });
                }
                else if ((part?.type === 'reasoning' || part?.type === 'thinking') && typeof part.text === 'string') {
                    if (part.text)
                        blocks.push({ type: 'thinking', thinking: part.text });
                }
                else if (part?.type === 'tool-call' || part?.type === 'tool_use') {
                    blocks.push({
                        type: 'tool_use',
                        tool_call_id: String(part.toolCallId ?? part.id ?? ''),
                        tool_name: String(part.name ?? ''),
                        input: part.arguments ?? part.input,
                    });
                }
                else if (part?.type === 'tool-result') {
                    blocks.push({
                        type: 'tool_result',
                        tool_call_id: String(part.toolCallId ?? ''),
                        output: part.content,
                        is_error: part.isError === true,
                    });
                }
            }
            if (blocks.length === 0 && typeof message?.content === 'string' && message.content) {
                blocks.push({ type: 'text', text: message.content });
            }
            const msg = { id, session_id: sessionId, role: 'assistant', content: blocks, created_at: created };
            if (ev?.data?.usage && typeof ev.data.usage === 'object') {
                msg.metadata = { usage: ev.data.usage };
            }
            out.push(msg);
        }
        else if (ev?.type === 'tool/result') {
            const block = firstToolResultBlock(ev?.data?.message);
            out.push({
                id,
                session_id: sessionId,
                role: 'tool',
                content: [
                    {
                        type: 'tool_result',
                        tool_call_id: String(block?.toolCallId ?? ev?.data?.callId ?? ''),
                        output: block?.content ?? ev?.data?.content,
                        is_error: block?.isError === true || Boolean(ev?.data?.error),
                    },
                ],
                created_at: created,
            });
        }
        else if (ev?.type === 'error') {
            out.push({
                id,
                session_id: sessionId,
                role: 'system',
                content: [{ type: 'text', text: String(ev?.data?.message ?? 'agent error') }],
                created_at: created,
            });
        }
    }
    return out;
}
/** 转录按 turn 分页（kimi `before_turn` / `after_turn` + page_size 语义） */
export function paginateTurns(items, query) {
    const size = query.page_size ?? 20;
    let list = [...items];
    if (query.before_turn !== undefined) {
        const idx = list.findIndex((item) => item.turnId === query.before_turn);
        if (idx >= 0)
            list = list.slice(0, idx);
    }
    else if (query.after_turn !== undefined) {
        const idx = list.findIndex((item) => item.turnId === query.after_turn);
        if (idx >= 0)
            list = list.slice(idx + 1);
    }
    const page = list.slice(-size);
    return { items: page, hasMore: list.length > page.length };
}
/** 把 kimi 提示词内容块转成 DSH 的 user 消息文本（file/image 块降级为路径或名称提示） */
export function promptContentToText(content) {
    const parts = [];
    for (const block of content || []) {
        if (!block || typeof block !== 'object')
            continue;
        if (block.type === 'text' && typeof block.text === 'string') {
            parts.push(block.text);
        }
        else if (block.type === 'file') {
            const ref = block.path ?? block.file_id ?? block.name ?? '';
            parts.push(`[file: ${String(ref)}]`);
        }
        else if (block.type === 'image' || block.type === 'video') {
            const source = block.source;
            const ref = source?.file_id ?? source?.url ?? source?.path ?? block.name ?? '';
            parts.push(`[${block.type}: ${String(ref)}]`);
        }
    }
    return parts.join('\n');
}
function turnHeaderOf(turn) {
    const { steps: _steps, ...rest } = turn;
    return rest;
}
function stepHeaderOf(step) {
    const { frames: _frames, ...rest } = step;
    return rest;
}
export function createTranscriptOpState() {
    return { turns: [], prompts: [], todos: [], seq: 0, eventSeq: 0, activity: 'idle' };
}
/**
 * 一条 DSH 事件 → 转录 op 批次（无 op 时返回空数组，调用方不应计入 seq）。
 * 与 foldTranscript 的分支一一对应，产出同构的 turn/step/frame id。
 */
export function applyTranscriptEvent(state, ev) {
    const ops = [];
    const atMs = typeof ev?.time === 'number' ? ev.time : undefined;
    const turn = turnOf(ev);
    const step = stepOf(ev);
    const turnId = turnIdOf(turn);
    const stepId = stepIdOf(turn, step);
    const closeCurrentStep = (st) => {
        const cur = state.currentStep;
        if (!cur)
            return;
        cur.state = st;
        cur.endedAt = isoOrUndefined(atMs);
        ops.push({ op: 'step.upsert', turnId: cur.turnId, step: stepHeaderOf(cur) });
        state.currentStep = undefined;
    };
    const openStep = () => {
        let cur = state.current;
        if (!cur) {
            cur = ensureTurn();
            ops.push({ op: 'turn.upsert', turn: turnHeaderOf(cur) });
        }
        const built = {
            kind: 'step',
            stepId,
            turnId: cur.turnId,
            ordinal: step ?? 0,
            state: 'running',
            frames: [],
            startedAt: isoOrUndefined(atMs),
        };
        cur.steps.push(built);
        state.currentStep = built;
        ops.push({ op: 'step.upsert', turnId: cur.turnId, step: stepHeaderOf(built) });
        return built;
    };
    const ensureTurn = () => {
        let cur = state.current;
        if (cur)
            return cur;
        const existing = state.turns.find((t) => t.turnId === turnId);
        if (existing) {
            state.current = existing;
            return existing;
        }
        cur = {
            kind: 'turn',
            turnId,
            ordinal: (turn ?? state.turns.length) + 1,
            state: 'running',
            origin: { kind: 'user' },
            steps: [],
            startedAt: isoOrUndefined(atMs),
        };
        state.turns.push(cur);
        state.current = cur;
        state.activity = 'turn';
        return cur;
    };
    const promptIdOf = (t) => `p${t.ordinal}`;
    if (typeof ev?.seq === 'number' && ev.seq > state.eventSeq)
        state.eventSeq = ev.seq;
    switch (ev?.type) {
        case 'turn/start': {
            closeCurrentStep('interrupted');
            const cur = ensureTurn();
            ops.push({ op: 'turn.upsert', turn: turnHeaderOf(cur) });
            state.prompts.push({
                promptId: promptIdOf(cur),
                status: 'running',
                createdAt: cur.startedAt ?? new Date().toISOString(),
            });
            ops.push({ op: 'prompt.upsert', prompt: state.prompts[state.prompts.length - 1] });
            break;
        }
        case 'user/message': {
            const text = blocksText(ev?.data?.content);
            const cur = state.current;
            if (cur) {
                cur.prompt = text;
                ops.push({ op: 'turn.upsert', turn: turnHeaderOf(cur) });
            }
            const prompt = state.prompts[state.prompts.length - 1];
            if (prompt) {
                prompt.content = [{ type: 'text', text }];
                ops.push({ op: 'prompt.upsert', prompt });
            }
            break;
        }
        case 'step/start': {
            closeCurrentStep('completed');
            openStep();
            break;
        }
        case 'assistant/chunk': {
            const chunk = ev?.data?.chunk;
            const st = state.currentStep ?? openStep();
            if (chunk?.type === 'text-delta')
                pushTextDelta(st, 'assistant', String(chunk.text ?? ''), ops);
            else if (chunk?.type === 'reasoning-delta')
                pushThinkingDelta(st, String(chunk.text ?? ''), ops);
            break;
        }
        case 'assistant/delta': {
            const st = state.currentStep ?? openStep();
            pushTextDelta(st, 'assistant', String(ev?.data?.delta ?? ''), ops);
            break;
        }
        case 'reasoning/delta': {
            const st = state.currentStep ?? openStep();
            pushThinkingDelta(st, String(ev?.data?.delta ?? ''), ops);
            break;
        }
        case 'tool/call': {
            const st = state.currentStep ?? openStep();
            const frame = {
                kind: 'tool',
                frameId: toolFrameIdOf(st.stepId, String(ev?.data?.callId ?? '')),
                toolCallId: String(ev?.data?.callId ?? ''),
                name: String(ev?.data?.name ?? ''),
                state: 'running',
                input: ev?.data?.arguments,
            };
            st.frames.push(frame);
            ops.push({ op: 'frame.upsert', turnId: st.turnId, stepId: st.stepId, frame });
            break;
        }
        case 'tool/result': {
            const st = state.currentStep ?? openStep();
            const block = firstToolResultBlock(ev?.data?.message);
            const callId = String(block?.toolCallId ?? ev?.data?.callId ?? '');
            const existing = st.frames.find((f) => f.kind === 'tool' && f.toolCallId === callId);
            const isError = block?.isError === true || Boolean(ev?.data?.error);
            const output = flattenContent(block?.content ?? ev?.data?.content);
            if (existing) {
                existing.state = isError ? 'error' : 'done';
                existing.output = output;
                ops.push({ op: 'frame.upsert', turnId: st.turnId, stepId: st.stepId, frame: existing });
            }
            else {
                const frame = {
                    kind: 'tool',
                    frameId: toolFrameIdOf(st.stepId, callId),
                    toolCallId: callId,
                    name: '',
                    state: isError ? 'error' : 'done',
                    output,
                };
                st.frames.push(frame);
                ops.push({ op: 'frame.upsert', turnId: st.turnId, stepId: st.stepId, frame });
            }
            break;
        }
        case 'assistant/message': {
            const st = state.currentStep ?? openStep();
            const message = ev?.data?.message;
            const text = blocksText(message?.content);
            const reasoning = blocksByType(message?.content, ['reasoning', 'thinking'])
                .map((b) => String(b.text ?? ''))
                .join('');
            if (text)
                upsertFrame(st, setFrameText(st, 'assistant', text), ops);
            if (reasoning)
                upsertFrame(st, setFrameThinking(st, reasoning), ops);
            const usage = kimiTokenUsage(ev?.data?.usage);
            if (usage)
                st.usage = usage;
            st.finishReason = 'stop';
            closeCurrentStep('completed');
            break;
        }
        case 'usage': {
            const usage = kimiTokenUsage(ev?.data?.usage ?? ev?.data);
            const cur = state.current;
            if (usage && cur) {
                cur.usage = cur.usage
                    ? {
                        inputTokens: (cur.usage.inputTokens ?? 0) + usage.inputOther,
                        outputTokens: (cur.usage.outputTokens ?? 0) + usage.output,
                        cachedTokens: (cur.usage.cachedTokens ?? 0) + usage.inputCacheRead,
                    }
                    : { inputTokens: usage.inputOther, outputTokens: usage.output, cachedTokens: usage.inputCacheRead };
                ops.push({ op: 'turn.upsert', turn: turnHeaderOf(cur) });
            }
            break;
        }
        case 'todo/write': {
            const items = normalizeTodoItems(ev?.data?.todos);
            if (items.length === 0)
                break;
            const todo = {
                todoId: `todo${state.turns.length || 1}`,
                items,
                updatedAt: isoOrUndefined(atMs) ?? new Date().toISOString(),
            };
            state.todos.length = 0;
            state.todos.push(todo);
            ops.push({ op: 'todo.upsert', todo });
            break;
        }
        case 'step/end': {
            closeCurrentStep('completed');
            break;
        }
        case 'turn/end': {
            closeCurrentStep('completed');
            const reason = kimiTurnReason(ev?.data?.reason);
            const cur = state.current;
            if (cur) {
                // kimi turnStateSchema 没有 blocked：blocked 收尾按 failed 建模
                cur.state = reason === 'blocked' ? 'failed' : reason;
                cur.endedAt = isoOrUndefined(atMs);
                ops.push({ op: 'turn.upsert', turn: turnHeaderOf(cur) });
            }
            const prompt = state.prompts[state.prompts.length - 1];
            if (prompt) {
                prompt.status = reason === 'blocked' ? 'failed' : reason;
                prompt.finishedAt = isoOrUndefined(atMs) ?? new Date().toISOString();
                ops.push({ op: 'prompt.upsert', prompt });
            }
            state.activity = 'idle';
            state.current = undefined;
            break;
        }
        case 'error': {
            const st = state.currentStep ?? openStep();
            const frame = {
                kind: 'notice',
                frameId: noticeFrameIdOf(st.stepId, typeof ev?.seq === 'number' ? ev.seq : undefined),
                level: 'error',
                source: 'agent',
                message: String(ev?.data?.message ?? 'agent error'),
            };
            st.frames.push(frame);
            ops.push({ op: 'frame.upsert', turnId: st.turnId, stepId: st.stepId, frame });
            const cur = state.current;
            if (cur) {
                cur.state = 'failed';
                cur.error = String(ev?.data?.message ?? 'agent error');
                cur.endedAt = isoOrUndefined(atMs);
                ops.push({ op: 'turn.upsert', turn: turnHeaderOf(cur) });
            }
            state.activity = 'idle';
            state.currentStep = undefined;
            state.current = undefined;
            break;
        }
        default:
            break;
    }
    return ops;
}
function upsertFrame(step, frame, ops) {
    if (!frame)
        return;
    ops.push({ op: 'frame.upsert', turnId: step.turnId, stepId: step.stepId, frame });
}
function pushTextDelta(step, role, delta, ops) {
    if (!delta)
        return;
    let frame = step.frames.find((f) => f.kind === 'text' && f.role === role);
    if (!frame) {
        frame = { kind: 'text', frameId: textFrameIdOf(step.stepId), role, text: delta };
        step.frames.push(frame);
    }
    else {
        frame.text = String(frame.text ?? '') + delta;
    }
    ops.push({ op: 'frame.upsert', turnId: step.turnId, stepId: step.stepId, frame });
}
function setFrameText(step, role, text) {
    if (!text)
        return undefined;
    let frame = step.frames.find((f) => f.kind === 'text' && f.role === role);
    if (!frame) {
        frame = { kind: 'text', frameId: textFrameIdOf(step.stepId), role, text };
        step.frames.push(frame);
    }
    else {
        frame.text = text;
    }
    return frame;
}
function pushThinkingDelta(step, delta, ops) {
    if (!delta)
        return;
    let frame = step.frames.find((f) => f.kind === 'thinking');
    if (!frame) {
        frame = { kind: 'thinking', frameId: thinkingFrameIdOf(step.stepId), text: delta };
        step.frames.push(frame);
    }
    else {
        frame.text = String(frame.text ?? '') + delta;
    }
    ops.push({ op: 'frame.upsert', turnId: step.turnId, stepId: step.stepId, frame });
}
function setFrameThinking(step, text) {
    if (!text)
        return undefined;
    let frame = step.frames.find((f) => f.kind === 'thinking');
    if (!frame) {
        frame = { kind: 'thinking', frameId: thinkingFrameIdOf(step.stepId), text };
        step.frames.push(frame);
    }
    else {
        frame.text = text;
    }
    return frame;
}
/** 全量重放事件日志，得到 op 批次序列与最新游标 */
export function buildTranscriptOps(events) {
    const replay = replayTranscript(events);
    return {
        agent_id: KIMI_MAIN_AGENT_ID,
        batches: replay.batches,
        latest_seq: replay.latest_seq,
        event_seq: replay.state.eventSeq,
    };
}
/**
 * 回溯补放：取 seq > sinceSeq 的批次。
 * sinceSeq 大于当前最新游标（服务重启、日志截断等）时 complete:false，
 * 调用方（SDK）按契约回退到全量 transcript GET。
 */
export function transcriptOpsSince(events, sinceSeq) {
    const all = buildTranscriptOps(events);
    if (sinceSeq > all.latest_seq)
        return { ...all, batches: [], complete: false };
    return { ...all, batches: all.batches.filter((b) => b.seq > sinceSeq), complete: true };
}
/** 转录快照（agentTranscriptSnapshot 形状）+ 游标 seq */
export function transcriptSnapshotOf(events) {
    const snapshot = foldTranscript(events);
    return { snapshot, seq: buildTranscriptOps(events).latest_seq };
}
/**
 * 全量重放事件日志，返回可继续增量推进的 op 状态机（WS 订阅用）：
 * state.seq 即当前转录游标，后续每条 live 事件经 applyTranscriptEvent 产出 op 后 +1。
 */
export function replayTranscript(events) {
    const state = createTranscriptOpState();
    const batches = [];
    for (const ev of events || []) {
        const ops = applyTranscriptEvent(state, ev);
        if (ops.length === 0)
            continue;
        state.seq += 1;
        batches.push({ seq: state.seq, ops });
    }
    return { state, batches, latest_seq: state.seq };
}
//# sourceMappingURL=kimi-events.js.map