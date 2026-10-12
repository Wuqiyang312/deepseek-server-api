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
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
export interface KimiWsDeps {
    /** 校验 bearer token；ok:false 时连接被拒（HTTP 401） */
    verifyToken(token: string): {
        ok: boolean;
        keyId?: string;
    };
    /** 进程世代标识，作为事件流 epoch；重启后变化 → 客户端收到 resync_required */
    epoch: string;
    serverVersion: string;
    sessionExists(sessionId: string): Promise<boolean>;
    /** 会话持久事件（按 seq 升序），用于 cursor 补放 */
    loadHistory(sessionId: string): Promise<any[]>;
    /** 订阅 live 事件，返回取消订阅函数 */
    onSessionEvent(sessionId: string, listener: (event: any) => void): () => void;
    abortSession?(sessionId: string): Promise<boolean> | boolean;
    warn?(message: string, err?: unknown): void;
}
export declare function kimiWsConnectionCount(): number;
/** 向所有连接广播一个全局信号帧（volatile：不参与 cursor 对账） */
export declare function kimiWsBroadcast(event: {
    type: string;
    session_id?: string;
    payload?: Record<string, unknown>;
}): void;
/** 处理一次 HTTP upgrade；由宿主 webServer 的 registerUpgrade 或本地 server 的 upgrade 事件调用 */
export declare function handleKimiUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, deps: KimiWsDeps): void;
