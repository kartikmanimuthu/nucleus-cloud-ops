import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// --- Mocks ---

vi.mock('@/lib/shell-session-service', () => ({
    ShellSessionService: {
        createSession: vi.fn(),
        listSessions: vi.fn(),
        terminateSession: vi.fn(),
        getSession: vi.fn(),
        touchSession: vi.fn(),
    },
}));

vi.mock('@/lib/rbac/authorize', () => ({
    authorize: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: vi.fn().mockResolvedValue('tenant-test'),
    getSessionUserId: vi.fn().mockResolvedValue('user-test'),
}));

import { ShellSessionService } from '@/lib/shell-session-service';
import { GET, POST } from '@/app/api/shell/sessions/route';
import { DELETE } from '@/app/api/shell/sessions/[id]/route';

const mockService = ShellSessionService as unknown as {
    createSession: ReturnType<typeof vi.fn>;
    listSessions: ReturnType<typeof vi.fn>;
    terminateSession: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
};

const now = new Date().toISOString();
const SESSION = {
    id: 'sess-1',
    tenantId: 'tenant-test',
    userId: 'user-test',
    accountId: null,
    accountName: null,
    region: 'us-east-1',
    status: 'active',
    approvalMode: 'manual',
    startedAt: now,
    lastActiveAt: now,
    terminatedAt: null,
};

beforeEach(() => {
    vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GET /api/shell/sessions
// ---------------------------------------------------------------------------

describe('GET /api/shell/sessions', () => {
    it('returns active sessions', async () => {
        mockService.listSessions.mockResolvedValue([SESSION]);

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.data).toHaveLength(1);
        expect(body.data[0].id).toBe('sess-1');
    });

    it('returns 500 on service error', async () => {
        mockService.listSessions.mockRejectedValue(new Error('DB error'));

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(500);
        expect(body.success).toBe(false);
        expect(body.error).toBe('DB error');
    });
});

// ---------------------------------------------------------------------------
// POST /api/shell/sessions
// ---------------------------------------------------------------------------

describe('POST /api/shell/sessions', () => {
    it('creates a session and returns 201', async () => {
        mockService.createSession.mockResolvedValue(SESSION);

        const req = new NextRequest('http://localhost/api/shell/sessions', {
            method: 'POST',
            body: JSON.stringify({ region: 'us-east-1' }),
            headers: { 'Content-Type': 'application/json' },
        });

        const res = await POST(req);
        const body = await res.json();

        expect(res.status).toBe(201);
        expect(body.success).toBe(true);
        expect(body.data.id).toBe('sess-1');
    });

    it('returns 429 when max sessions reached', async () => {
        mockService.createSession.mockRejectedValue(
            new Error('Maximum concurrent sessions (3) reached')
        );

        const req = new NextRequest('http://localhost/api/shell/sessions', {
            method: 'POST',
            body: JSON.stringify({}),
            headers: { 'Content-Type': 'application/json' },
        });

        const res = await POST(req);
        const body = await res.json();

        expect(res.status).toBe(429);
        expect(body.success).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// DELETE /api/shell/sessions/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/shell/sessions/:id', () => {
    it('terminates a session', async () => {
        mockService.terminateSession.mockResolvedValue({ ...SESSION, status: 'terminated' });

        const req = new NextRequest('http://localhost/api/shell/sessions/sess-1', {
            method: 'DELETE',
        });

        const res = await DELETE(req, { params: Promise.resolve({ id: 'sess-1' }) });
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.data.status).toBe('terminated');
    });

    it('returns 404 when session not found', async () => {
        mockService.terminateSession.mockRejectedValue(new Error('Session not found'));

        const req = new NextRequest('http://localhost/api/shell/sessions/sess-999', {
            method: 'DELETE',
        });

        const res = await DELETE(req, { params: Promise.resolve({ id: 'sess-999' }) });
        const body = await res.json();

        expect(res.status).toBe(404);
        expect(body.success).toBe(false);
    });
});
