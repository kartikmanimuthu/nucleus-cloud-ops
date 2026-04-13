import { WebSocketServer, WebSocket } from 'ws';
import { spawnPty, resizePty, killPty, reapStaleSessions } from './pty-manager';
import { buildAwsEnv, validateCredentials } from './credential-injector';
import type { WsClientMessage, WsServerMessage, AwsCredentials } from './types';

const PORT = parseInt(process.env.SHELL_SERVER_PORT ?? '3001', 10);
const HEARTBEAT_INTERVAL_MS = 30_000;
const STALE_SESSION_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours

const wss = new WebSocketServer({ port: PORT });

function send(ws: WebSocket, msg: WsServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

wss.on('connection', (ws, req) => {
    // Extract sessionId and credentials from query params
    const url = new URL(req.url ?? '/', `http://localhost`);
    const sessionId = url.searchParams.get('sessionId');
    const credsParam = url.searchParams.get('creds');

    if (!sessionId) {
        send(ws, { type: 'error', message: 'Missing sessionId' });
        ws.close(1008, 'Missing sessionId');
        return;
    }

    let creds: AwsCredentials | undefined;
    if (credsParam) {
        try {
            creds = JSON.parse(Buffer.from(credsParam, 'base64').toString('utf8')) as AwsCredentials;
            const credError = validateCredentials(creds);
            if (credError) {
                send(ws, { type: 'error', message: `Invalid credentials: ${credError}` });
                ws.close(1008, 'Invalid credentials');
                return;
            }
        } catch {
            send(ws, { type: 'error', message: 'Malformed credentials' });
            ws.close(1008, 'Malformed credentials');
            return;
        }
    }

    const cols = parseInt(url.searchParams.get('cols') ?? '220', 10);
    const rows = parseInt(url.searchParams.get('rows') ?? '50', 10);
    const region = creds?.region ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';

    const env = creds ? buildAwsEnv(creds) : { AWS_DEFAULT_REGION: region, AWS_REGION: region };

    let ptyInstance: ReturnType<typeof spawnPty>;
    try {
        ptyInstance = spawnPty({ sessionId, cols, rows, env });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to spawn PTY';
        send(ws, { type: 'error', message });
        ws.close(1011, message);
        return;
    }

    // Notify client of session info
    const expiresAt = creds?.expiresAt ?? new Date(Date.now() + STALE_SESSION_MAX_AGE_MS).toISOString();
    send(ws, { type: 'session_info', sessionId, expiresAt });

    // PTY → WebSocket
    ptyInstance.onData((data) => {
        send(ws, { type: 'output', data });
    });

    ptyInstance.onExit(({ exitCode }) => {
        send(ws, { type: 'exit', code: exitCode ?? 0 });
        ws.close(1000, 'PTY exited');
    });

    // WebSocket → PTY
    ws.on('message', (raw) => {
        let msg: WsClientMessage;
        try {
            msg = JSON.parse(raw.toString()) as WsClientMessage;
        } catch {
            return; // ignore malformed frames
        }

        switch (msg.type) {
            case 'input':
                ptyInstance.write(msg.data);
                break;
            case 'resize':
                resizePty(sessionId, msg.cols, msg.rows);
                break;
            case 'ping':
                send(ws, { type: 'pong' });
                break;
        }
    });

    ws.on('close', () => {
        killPty(sessionId);
    });

    ws.on('error', () => {
        killPty(sessionId);
    });
});

// Periodic stale session reaper
const reaper = setInterval(() => {
    reapStaleSessions(STALE_SESSION_MAX_AGE_MS);
}, HEARTBEAT_INTERVAL_MS);

// Graceful shutdown
function shutdown(): void {
    clearInterval(reaper);
    wss.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log(`shell-server listening on ws://0.0.0.0:${PORT}`);
