/**
 * dsh-web-service — Kimi 兼容层：WebSocket 传输与 kimi 控制帧
 *
 * kimi 前端/SDK 用 `/api/v1/ws` 承载会话事件流，DSH 宿主只提供 HTTP handler 与
 * `session/event` 事件源，因此这里自带一个零依赖的 RFC 6455 服务端（握手 + 帧编解码），
 * 并在其上实现 kap-server 的 WS 协议：`server_hello`（protocol_version 2）→ `client_hello`，
 * 控制帧 `{type,id,payload}` 对应 `{type:'ack',id,code,msg,payload}`，事件帧带
 * `seq`/`epoch`/`session_id`/`timestamp`，转录通道走 `transcript.reset`/`transcript.ops`。
 *
 * 升级入口优先用宿主 `webServer.registerUpgrade`（dsh-host-webserver ≥0.1.7 提供）；
 * 只有独立监听端口（standalonePort）走本插件自己的 `createServer`，两者共用这里的实现。
 */
import { createHash } from 'node:crypto';
import { KimiErrorCode, kimiUlid, isoTime } from './kimi-contract.js';
import { toKimiEvent, applyTranscriptEvent, foldTranscript, replayTranscript, KIMI_MAIN_AGENT_ID, } from './kimi-events.js';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const HEARTBEAT_MS = 20000;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const BEARER_PROTOCOL_PREFIX = 'kimi-code.bearer.';
const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;
function warnOf(deps) {
    return (message, err) => {
        if (typeof deps.warn === 'function')
            deps.warn(message, err);
        else if (err !== undefined)
            console.warn(`[dsh-web-service kimi-ws] ${message}`, err);
    };
}
function wsAccept(key) {
    return createHash('sha1').update(key + WS_GUID).digest('base64');
}
/** 从请求头/子协议取 bearer token：Authorization 优先，其次 kimi-code.bearer.<token> */
function extractToken(req) {
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ') && auth.slice(7).trim()) {
        return auth.slice(7).trim();
    }
    const protocols = String(req.headers['sec-websocket-protocol'] || '');
    for (const raw of protocols.split(',')) {
        const proto = raw.trim();
        if (proto.startsWith(BEARER_PROTOCOL_PREFIX))
            return proto.slice(BEARER_PROTOCOL_PREFIX.length);
    }
    return '';
}
function encodeFrame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.from([0x80 | opcode, len]);
    }
    else if (len <= 0xffff) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    }
    else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
}
function closePayload(code, reason) {
    const body = Buffer.from(reason.slice(0, 120), 'utf8');
    const out = Buffer.alloc(2 + body.length);
    out.writeUInt16BE(code, 0);
    body.copy(out, 2);
    return out;
}
const connections = new Set();
export function kimiWsConnectionCount() {
    return connections.size;
}
/** 向所有连接广播一个全局信号帧（volatile：不参与 cursor 对账） */
export function kimiWsBroadcast(event) {
    const frame = {
        type: event.type,
        seq: 0,
        volatile: true,
        ...(event.session_id ? { session_id: event.session_id } : {}),
        timestamp: new Date().toISOString(),
        payload: event.payload ?? {},
    };
    for (const conn of connections)
        conn.sendJson(frame);
}
/** 处理一次 HTTP upgrade；由宿主 webServer 的 registerUpgrade 或本地 server 的 upgrade 事件调用 */
export function handleKimiUpgrade(req, socket, head, deps) {
    const key = req.headers['sec-websocket-key'];
    const warn = warnOf(deps);
    if (typeof key !== 'string' || !key) {
        rejectUpgrade(socket, 400, 'Bad Request: missing Sec-WebSocket-Key');
        return;
    }
    const token = extractToken(req);
    let verdict = { ok: true };
    try {
        verdict = deps.verifyToken(token);
    }
    catch (err) {
        verdict = { ok: false };
        warn('verifyToken threw', err);
    }
    if (!verdict.ok) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
    }
    const requested = String(req.headers['sec-websocket-protocol'] || '')
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x.startsWith(BEARER_PROTOCOL_PREFIX));
    const lines = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${wsAccept(key)}`,
    ];
    // 浏览器要求服务端从候选里选定一个子协议，否则连接立即失败
    if (requested.length > 0)
        lines.push(`Sec-WebSocket-Protocol: ${requested[0]}`);
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    const conn = new KimiWsConnection(socket, deps);
    connections.add(conn);
    conn.start(head);
}
function rejectUpgrade(socket, status, reason) {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
}
/** 一条 WS 连接：帧解析状态机 + kimi 控制面 + 会话/转录订阅 */
class KimiWsConnection {
    socket;
    deps;
    buffer = Buffer.alloc(0);
    fragments = [];
    fragmentOpcode = 0;
    subscriptions = new Map();
    transcriptAgents = new Map();
    heartbeat = null;
    closed = false;
    connectionId = kimiUlid();
    warn;
    constructor(socket, deps) {
        this.socket = socket;
        this.deps = deps;
        this.warn = warnOf(deps);
    }
    start(head) {
        this.socket.on('data', (chunk) => this.onData(chunk));
        this.socket.on('error', (err) => {
            this.warn('socket error', err);
            this.shutdown(1011, 'internal error');
        });
        this.socket.on('close', () => this.cleanup());
        this.sendJson({
            type: 'server_hello',
            timestamp: new Date().toISOString(),
            payload: {
                ws_connection_id: this.connectionId,
                protocol_version: 2,
                heartbeat_ms: HEARTBEAT_MS,
                max_event_buffer_size: 1000,
                capabilities: { event_batching: false, compression: false },
            },
        });
        this.heartbeat = setInterval(() => {
            this.sendJson({ type: 'ping', timestamp: new Date().toISOString(), payload: { nonce: kimiUlid() } });
        }, HEARTBEAT_MS);
        if (head && head.length > 0)
            this.onData(head);
    }
    sendJson(value) {
        if (this.closed)
            return;
        try {
            this.socket.write(encodeFrame(OP_TEXT, Buffer.from(JSON.stringify(value), 'utf8')));
        }
        catch (err) {
            this.warn('send failed', err);
            this.shutdown(1011, 'send failed');
        }
    }
    ack(id, code, msg, payload) {
        this.sendJson({ type: 'ack', id, code, msg, payload });
    }
    errorFrame(code, msg, fatal, details) {
        this.sendJson({
            type: 'error',
            timestamp: new Date().toISOString(),
            payload: { code, msg, fatal, request_id: kimiUlid(), ...(details === undefined ? {} : { details }) },
        });
    }
    onData(chunk) {
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
        for (;;) {
            const frame = this.takeFrame();
            if (frame === null)
                return;
            this.handleFrame(frame.opcode, frame.payload, frame.fin);
            if (this.closed)
                return;
        }
    }
    takeFrame() {
        const buf = this.buffer;
        if (buf.length < 2)
            return null;
        const fin = (buf[0] & 0x80) !== 0;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
            if (buf.length < offset + 2)
                return null;
            len = buf.readUInt16BE(offset);
            offset += 2;
        }
        else if (len === 127) {
            if (buf.length < offset + 8)
                return null;
            const big = buf.readBigUInt64BE(offset);
            if (big > BigInt(MAX_FRAME_BYTES)) {
                this.failProtocol('frame too large');
                return null;
            }
            len = Number(big);
            offset += 8;
        }
        if (len > MAX_FRAME_BYTES) {
            this.failProtocol('frame too large');
            return null;
        }
        // 客户端帧必须掩码（RFC 6455 5.1）
        if (!masked) {
            this.failProtocol('client frame must be masked');
            return null;
        }
        if (buf.length < offset + 4 + len)
            return null;
        const mask = buf.subarray(offset, offset + 4);
        const payload = Buffer.alloc(len);
        for (let i = 0; i < len; i += 1)
            payload[i] = buf[offset + 4 + i] ^ mask[i % 4];
        this.buffer = buf.subarray(offset + 4 + len);
        return { opcode, payload, fin };
    }
    failProtocol(msg) {
        this.errorFrame(KimiErrorCode.VALIDATION_FAILED, msg, true);
        this.shutdown(1002, msg);
    }
    handleFrame(opcode, payload, fin) {
        if (opcode === OP_CLOSE) {
            this.socket.write(encodeFrame(OP_CLOSE, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0)));
            this.shutdown(1000, 'closed by client');
            return;
        }
        if (opcode === OP_PING) {
            this.sendPong(payload);
            return;
        }
        if (opcode === OP_PONG) {
            return;
        }
        if (opcode === OP_CONTINUATION || !fin) {
            if (opcode !== OP_CONTINUATION) {
                this.fragmentOpcode = opcode;
                this.fragments = [payload];
            }
            else if (this.fragments.length === 0) {
                // 孤儿 continuation：没有起始帧，整条丢弃
                return;
            }
            else {
                this.fragments.push(payload);
            }
            if (!fin)
                return;
            const full = Buffer.concat(this.fragments);
            this.fragments = [];
            const op = this.fragmentOpcode;
            this.fragmentOpcode = 0;
            this.handleMessage(op, full);
            return;
        }
        this.handleMessage(opcode, payload);
    }
    sendPong(payload) {
        if (this.closed)
            return;
        try {
            this.socket.write(encodeFrame(OP_PONG, payload));
        }
        catch {
            /* socket 已不可写，close 事件负责清理 */
        }
    }
    handleMessage(opcode, payload) {
        if (opcode !== OP_TEXT && opcode !== OP_BINARY)
            return;
        let message;
        try {
            message = JSON.parse(payload.toString('utf8'));
        }
        catch {
            this.errorFrame(KimiErrorCode.REQUEST_MALFORMED, 'invalid JSON frame', true);
            this.shutdown(1007, 'invalid JSON');
            return;
        }
        if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
            this.errorFrame(KimiErrorCode.VALIDATION_FAILED, 'frame requires a string type', false);
            return;
        }
        void this.handleControl(String(message.type), String(message.id ?? ''), message.payload ?? {});
    }
    async handleControl(type, id, payload) {
        try {
            switch (type) {
                case 'client_hello':
                case 'subscribe':
                    await this.subscribe(id, payload, type === 'client_hello');
                    return;
                case 'unsubscribe':
                    this.unsubscribe(id, payload);
                    return;
                case 'subscribe_v2':
                    await this.subscribeV2(id, payload);
                    return;
                case 'unsubscribe_v2':
                    this.unsubscribeV2(id, payload);
                    return;
                case 'abort':
                    await this.abort(id, payload);
                    return;
                case 'pong':
                    return;
                default:
                    if (type.startsWith('terminal_')) {
                        this.ack(id, KimiErrorCode.TOOL_NOT_AVAILABLE, 'terminal streams are not available on this DSH node', {});
                        return;
                    }
                    this.ack(id, KimiErrorCode.VALIDATION_FAILED, `unsupported control type: ${type}`, {});
            }
        }
        catch (err) {
            this.warn(`control ${type} failed`, err);
            this.errorFrame(KimiErrorCode.INTERNAL_ERROR, String(err?.message || err), false);
        }
    }
    /** 全局订阅集合，用于向宿主事件源注册一次（多个连接共享） */
    async subscribe(id, payload, fromHello) {
        const sessionIds = Array.isArray(payload?.session_ids)
            ? payload.session_ids.map(String)
            : fromHello && Array.isArray(payload?.subscriptions)
                ? payload.subscriptions.map(String)
                : [];
        const cursors = payload?.cursors ?? {};
        const agentFilter = payload?.agent_filter;
        const accepted = [];
        const notFound = [];
        const resyncRequired = [];
        const echoed = {};
        for (const sessionId of sessionIds) {
            if (!sessionId)
                continue;
            const exists = await this.deps.sessionExists(sessionId);
            if (!exists) {
                notFound.push(sessionId);
                continue;
            }
            const cursor = cursors[sessionId];
            const cursorSeq = typeof cursor?.seq === 'number' ? cursor.seq : undefined;
            if (cursor && typeof cursor.epoch === 'string' && cursor.epoch !== this.deps.epoch) {
                resyncRequired.push(sessionId);
                accepted.push(sessionId);
                this.ensureSubscription(sessionId, agentFilter);
                echoed[sessionId] = { seq: await this.watermark(sessionId), epoch: this.deps.epoch };
                this.sendJson({
                    type: 'resync_required',
                    timestamp: new Date().toISOString(),
                    payload: {
                        session_id: sessionId,
                        reason: 'epoch_changed',
                        current_seq: echoed[sessionId].seq,
                        epoch: this.deps.epoch,
                    },
                });
                continue;
            }
            const sub = this.ensureSubscription(sessionId, agentFilter);
            accepted.push(sessionId);
            if (cursorSeq === undefined) {
                echoed[sessionId] = { seq: await this.watermark(sessionId), epoch: this.deps.epoch };
                continue;
            }
            // 带 cursor：补放 cursor 之后的历史，再接 live
            sub.replaying = true;
            try {
                const history = await this.deps.loadHistory(sessionId);
                const replay = history.filter((ev) => typeof ev?.seq === 'number' && ev.seq > cursorSeq);
                sub.replaying = false;
                let last = cursorSeq;
                for (const ev of replay) {
                    last = ev.seq;
                    this.emitEvent(sessionId, ev);
                }
                const queued = sub.queue.splice(0, sub.queue.length);
                for (const ev of queued) {
                    if (typeof ev?.seq === 'number' && ev.seq <= last)
                        continue;
                    last = ev.seq;
                    this.emitEvent(sessionId, ev);
                }
                sub.cursorSeq = Math.max(last, sub.cursorSeq);
                echoed[sessionId] = { seq: sub.cursorSeq, epoch: this.deps.epoch };
            }
            catch (err) {
                sub.replaying = false;
                this.warn(`replay ${sessionId} failed`, err);
                echoed[sessionId] = { seq: cursorSeq, epoch: this.deps.epoch };
            }
        }
        this.ack(id, 0, 'success', {
            accepted,
            not_found: notFound,
            resync_required: resyncRequired,
            cursors: echoed,
        });
    }
    async watermark(sessionId) {
        try {
            const history = await this.deps.loadHistory(sessionId);
            let max = 0;
            for (const ev of history)
                if (typeof ev?.seq === 'number' && ev.seq > max)
                    max = ev.seq;
            return max;
        }
        catch {
            return 0;
        }
    }
    ensureSubscription(sessionId, agentFilter) {
        const agents = agentFilter && typeof agentFilter === 'object'
            ? new Set(Object.keys(agentFilter))
            : null;
        const existing = this.subscriptions.get(sessionId);
        if (existing) {
            existing.agents = agents ?? existing.agents;
            return existing;
        }
        const sub = { off: null, cursorSeq: 0, replaying: false, queue: [], agents };
        this.subscriptions.set(sessionId, sub);
        // live 事件先到但补放未完成时排队，补放结束后按 seq 去重再 flush
        try {
            sub.off = this.deps.onSessionEvent(sessionId, (event) => {
                if (this.closed)
                    return;
                if (sub.replaying) {
                    sub.queue.push(event);
                    return;
                }
                this.emitEvent(sessionId, event);
            });
        }
        catch (err) {
            this.warn(`subscribe ${sessionId} failed`, err);
        }
        return sub;
    }
    emitEvent(sessionId, event) {
        const sub = this.subscriptions.get(sessionId);
        const payload = toKimiEvent(event);
        if (payload === undefined) {
            if (sub && typeof event?.seq === 'number')
                sub.cursorSeq = Math.max(sub.cursorSeq, event.seq);
            return;
        }
        if (sub && typeof event?.seq === 'number' && event.seq <= sub.cursorSeq)
            return;
        if (sub && typeof event?.seq === 'number')
            sub.cursorSeq = event.seq;
        this.sendJson({
            type: String(payload.type),
            seq: typeof event?.seq === 'number' ? event.seq : 0,
            epoch: this.deps.epoch,
            ...(typeof event?.volatile === 'boolean' ? { volatile: event.volatile } : {}),
            session_id: sessionId,
            timestamp: isoTime(typeof event?.time === 'number' ? event.time : undefined),
            payload: { ...payload, agentId: KIMI_MAIN_AGENT_ID, sessionId },
        });
        void this.emitTranscript(sessionId, event);
    }
    /** 一条 DSH 事件 → 各已订阅 agent 的转录 op 帧；op 机 seq 逐 1 递增（与 REST /transcript、/transcript/ops 同编号） */
    emitTranscript(sessionId, event) {
        const agents = this.transcriptAgents.get(sessionId);
        if (!agents || agents.size === 0)
            return;
        const at = isoTime(typeof event?.time === 'number' ? event.time : undefined);
        for (const agentId of agents.keys()) {
            const entry = agents.get(agentId);
            if (!entry)
                continue;
            let ops = [];
            try {
                ops = applyTranscriptEvent(entry.state, event);
            }
            catch (err) {
                this.warn(`transcript op ${sessionId}/${agentId} failed`, err);
                continue;
            }
            // 状态机必须与 REST 端保持一致：无 op 时也要推进 eventSeq 水位，
            // 否则后续增量会落后于同一份事件日志重放出来的游标。
            if (typeof event?.seq === 'number' && event.seq > entry.state.eventSeq)
                entry.state.eventSeq = event.seq;
            if (ops.length === 0)
                continue;
            entry.state.seq += 1;
            this.sendJson({
                type: 'transcript.ops',
                seq: entry.state.seq,
                epoch: this.deps.epoch,
                timestamp: at,
                session_id: sessionId,
                payload: { type: 'transcript.ops', agent_id: agentId, ops, seq: entry.state.seq },
            });
        }
    }
    unsubscribe(id, payload) {
        const sessionIds = Array.isArray(payload?.session_ids) ? payload.session_ids.map(String) : [];
        const notFound = [];
        for (const sessionId of sessionIds) {
            if (!this.subscriptions.has(sessionId)) {
                notFound.push(sessionId);
                continue;
            }
            this.dropSubscription(sessionId);
        }
        this.ack(id, 0, 'success', {
            accepted: [...this.subscriptions.keys()],
            not_found: notFound,
            resync_required: [],
        });
    }
    dropSubscription(sessionId) {
        const sub = this.subscriptions.get(sessionId);
        if (!sub)
            return;
        try {
            sub.off?.();
        }
        catch (err) {
            this.warn(`unsubscribe ${sessionId} failed`, err);
        }
        this.subscriptions.delete(sessionId);
    }
    async subscribeV2(id, payload) {
        const sessionId = String(payload?.session_id ?? '');
        if (!sessionId || !(await this.deps.sessionExists(sessionId))) {
            this.ack(id, KimiErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`, {
                accepted: [],
                not_found: [sessionId],
                resync_required: [],
            });
            return;
        }
        const spec = payload?.transcript ?? {};
        const since = payload?.transcript_since ?? {};
        let agents = this.transcriptAgents.get(sessionId);
        if (!agents) {
            agents = new Map();
            this.transcriptAgents.set(sessionId, agents);
        }
        // '*' 通配展开为主 agent；DSH 侧目前只有 main 一路转录
        const specKeys = Object.keys(spec).flatMap((key) => (key === '*' ? [KIMI_MAIN_AGENT_ID] : [key]));
        const sinceOf = (agentId) => {
            const raw = since[agentId] ?? (agentId === KIMI_MAIN_AGENT_ID ? since['*'] : undefined);
            return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : undefined;
        };
        let history = null;
        const loadHistoryOnce = async () => {
            if (history === null) {
                try {
                    history = await this.deps.loadHistory(sessionId);
                }
                catch (err) {
                    this.warn(`loadHistory ${sessionId} failed`, err);
                    history = [];
                }
            }
            return history;
        };
        for (const agentId of specKeys) {
            if (spec[agentId] === 'off') {
                agents.delete(agentId);
                continue;
            }
            const sinceSeq = sinceOf(agentId);
            const events = await loadHistoryOnce();
            const replay = replayTranscript(events);
            replay.state.seq = replay.latest_seq;
            agents.set(agentId, { state: replay.state });
            const at = new Date().toISOString();
            if (sinceSeq !== undefined && sinceSeq <= replay.latest_seq) {
                // 客户端持有有效游标：补放增量而不是全量 reset
                for (const batch of replay.batches) {
                    if (batch.seq <= sinceSeq)
                        continue;
                    this.sendJson({
                        type: 'transcript.ops',
                        seq: batch.seq,
                        epoch: this.deps.epoch,
                        timestamp: at,
                        session_id: sessionId,
                        payload: { type: 'transcript.ops', agent_id: agentId, ops: batch.ops, seq: batch.seq },
                    });
                }
            }
            else {
                // 无游标或游标失效（重启/截断）：全量 reset，SDK 以此为对账基线
                const snapshot = foldTranscript(events);
                this.sendJson({
                    type: 'transcript.reset',
                    seq: replay.latest_seq,
                    epoch: this.deps.epoch,
                    timestamp: at,
                    session_id: sessionId,
                    payload: {
                        type: 'transcript.reset',
                        agent_id: agentId,
                        snapshot,
                        has_more_older: false,
                        seq: replay.latest_seq,
                    },
                });
            }
        }
        this.ensureSubscription(sessionId, null);
        this.ack(id, 0, 'success', {
            accepted: [sessionId],
            not_found: [],
            resync_required: [],
            cursors: { [sessionId]: { seq: await this.watermark(sessionId), epoch: this.deps.epoch } },
        });
    }
    unsubscribeV2(id, payload) {
        const sessionId = String(payload?.session_id ?? '');
        const agentIds = Array.isArray(payload?.agent_ids)
            ? payload.agent_ids.map(String)
            : undefined;
        const agents = this.transcriptAgents.get(sessionId);
        if (agents) {
            if (agentIds)
                for (const agentId of agentIds)
                    agents.delete(agentId);
            else
                agents.clear();
            if (agents.size === 0)
                this.transcriptAgents.delete(sessionId);
        }
        this.ack(id, 0, 'success', {
            accepted: [sessionId],
            not_found: sessionId ? [] : [''],
            resync_required: [],
        });
    }
    async abort(id, payload) {
        const sessionId = String(payload?.session_id ?? '');
        if (typeof this.deps.abortSession !== 'function') {
            this.ack(id, KimiErrorCode.INTERNAL_ERROR, 'abort is not supported by this DSH node', {});
            return;
        }
        if (!sessionId) {
            this.ack(id, KimiErrorCode.VALIDATION_FAILED, 'session_id is required', {});
            return;
        }
        const aborted = Boolean(await this.deps.abortSession(sessionId));
        const agents = this.transcriptAgents.get(sessionId);
        let atSeq = this.subscriptions.get(sessionId)?.cursorSeq ?? 0;
        if (agents)
            for (const entry of agents.values())
                atSeq = Math.max(atSeq, entry.state.seq);
        this.ack(id, 0, 'success', { aborted, at_seq: atSeq });
    }
    shutdown(code, reason) {
        if (this.closed)
            return;
        try {
            if (this.socket.writable)
                this.socket.write(encodeFrame(OP_CLOSE, closePayload(code, reason)));
        }
        catch {
            /* 忽略已断开 socket 的写入错误 */
        }
        this.cleanup();
        try {
            this.socket.end();
        }
        catch {
            /* fallthrough */
        }
    }
    cleanup() {
        if (this.closed)
            return;
        this.closed = true;
        if (this.heartbeat) {
            clearInterval(this.heartbeat);
            this.heartbeat = null;
        }
        for (const sessionId of [...this.subscriptions.keys()])
            this.dropSubscription(sessionId);
        this.subscriptions.clear();
        this.transcriptAgents.clear();
        connections.delete(this);
    }
}
//# sourceMappingURL=kimi-ws.js.map