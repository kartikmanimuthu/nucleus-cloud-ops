import type { WsClientMessage, WsServerMessage } from './types';

export type ShellClientOptions = {
    wsUrl: string;
    onOutput: (data: string) => void;
    onExit: (code: number) => void;
    onError: (message: string) => void;
    onOpen?: () => void;
    onClose?: () => void;
    reconnectDelayMs?: number;
    maxReconnects?: number;
};

export class ShellClient {
    private ws: WebSocket | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectCount = 0;
    private closed = false;

    private readonly wsUrl: string;
    private readonly onOutput: (data: string) => void;
    private readonly onExit: (code: number) => void;
    private readonly onError: (message: string) => void;
    private readonly onOpen?: () => void;
    private readonly onClose?: () => void;
    private readonly reconnectDelayMs: number;
    private readonly maxReconnects: number;

    constructor(opts: ShellClientOptions) {
        this.wsUrl = opts.wsUrl;
        this.onOutput = opts.onOutput;
        this.onExit = opts.onExit;
        this.onError = opts.onError;
        this.onOpen = opts.onOpen;
        this.onClose = opts.onClose;
        this.reconnectDelayMs = opts.reconnectDelayMs ?? 2000;
        this.maxReconnects = opts.maxReconnects ?? 5;
    }

    connect(): void {
        if (this.closed) return;
        this.ws = new WebSocket(this.wsUrl);

        this.ws.onopen = () => {
            this.reconnectCount = 0;
            this.startHeartbeat();
            this.onOpen?.();
        };

        this.ws.onmessage = (event) => {
            let msg: WsServerMessage;
            try {
                msg = JSON.parse(event.data as string) as WsServerMessage;
            } catch {
                return;
            }
            switch (msg.type) {
                case 'output':
                    this.onOutput(msg.data);
                    break;
                case 'exit':
                    this.onExit(msg.code);
                    this.dispose();
                    break;
                case 'error':
                    this.onError(msg.message);
                    break;
                case 'pong':
                    // heartbeat acknowledged — no-op
                    break;
                case 'session_info':
                    // session established — no-op for now
                    break;
            }
        };

        this.ws.onclose = () => {
            this.stopHeartbeat();
            this.onClose?.();
            if (!this.closed && this.reconnectCount < this.maxReconnects) {
                this.reconnectCount++;
                this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelayMs);
            }
        };

        this.ws.onerror = () => {
            this.onError('WebSocket connection error');
        };
    }

    sendInput(data: string): void {
        this.send({ type: 'input', data });
    }

    sendResize(cols: number, rows: number): void {
        this.send({ type: 'resize', cols, rows });
    }

    private send(msg: WsClientMessage): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    private startHeartbeat(): void {
        this.heartbeatTimer = setInterval(() => {
            this.send({ type: 'ping' });
        }, 25_000);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    dispose(): void {
        this.closed = true;
        this.stopHeartbeat();
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
        }
    }
}
