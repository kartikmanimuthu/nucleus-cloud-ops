import * as pty from 'node-pty';
import type { PtySessionOptions } from './types';

interface PtyEntry {
    pty: pty.IPty;
    sessionId: string;
    createdAt: Date;
}

const sessions = new Map<string, PtyEntry>();

/**
 * Spawn a new PTY process for the given session.
 * Returns the IPty instance so the caller can attach data/exit listeners.
 */
export function spawnPty(options: PtySessionOptions): pty.IPty {
    const { sessionId, cols, rows, env } = options;

    if (sessions.has(sessionId)) {
        throw new Error(`PTY session already exists: ${sessionId}`);
    }

    const shell = process.env.SHELL ?? '/bin/bash';

    const instance = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: process.env.HOME ?? '/tmp',
        env: { ...process.env, ...env } as Record<string, string>,
    });

    sessions.set(sessionId, { pty: instance, sessionId, createdAt: new Date() });

    // Auto-reap when the process exits
    instance.onExit(() => {
        sessions.delete(sessionId);
    });

    return instance;
}

/**
 * Resize an existing PTY session.
 */
export function resizePty(sessionId: string, cols: number, rows: number): void {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    entry.pty.resize(cols, rows);
}

/**
 * Kill and remove a PTY session.
 */
export function killPty(sessionId: string): void {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    try {
        entry.pty.kill();
    } catch {
        // Already dead — ignore
    }
    sessions.delete(sessionId);
}

/**
 * Get the IPty instance for a session (undefined if not found).
 */
export function getPty(sessionId: string): pty.IPty | undefined {
    return sessions.get(sessionId)?.pty;
}

/**
 * Reap all sessions that have been idle longer than maxAgeMs.
 * Call periodically to prevent zombie PTY processes.
 */
export function reapStaleSessions(maxAgeMs: number): void {
    const now = Date.now();
    for (const [id, entry] of sessions) {
        if (now - entry.createdAt.getTime() > maxAgeMs) {
            killPty(id);
        }
    }
}

/** Number of active PTY sessions (for health checks). */
export function activeSessionCount(): number {
    return sessions.size;
}
