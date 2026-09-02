import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/gateway', () => ({ getGatewayService: vi.fn() }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));

import { getGatewayService } from '@/lib/gateway';
import { authorize } from '@/lib/rbac/authorize';
import { POST } from './route';

const makeRequest = (opts: { cookie?: string; apiKey?: string; auth?: string } = {}) => ({
    cookies: { get: (name: string) => (name.includes('next-auth.session-token') && opts.cookie ? { value: opts.cookie } : undefined) },
    headers: { get: (k: string) => (k === 'x-api-key' ? opts.apiKey ?? null : k === 'authorization' ? opts.auth ?? null : null) },
}) as any;

describe('POST /api/v1/trigger/api (backward-compat redirect)', () => {
    let handleInbound: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        handleInbound = vi.fn().mockResolvedValue(new Response('ok'));
        vi.mocked(getGatewayService).mockReturnValue({ handleInbound } as any);
        vi.mocked(authorize).mockResolvedValue(null);
    });

    it('delegates without an authorize check when there is no session cookie', async () => {
        const req = makeRequest({});
        await POST(req);
        expect(authorize).not.toHaveBeenCalled();
        expect(handleInbound).toHaveBeenCalledWith('api', req);
    });

    it('delegates without an authorize check when an x-api-key header is present, even with a session cookie', async () => {
        const req = makeRequest({ cookie: 'sess', apiKey: 'key-123' });
        await POST(req);
        expect(authorize).not.toHaveBeenCalled();
        expect(handleInbound).toHaveBeenCalledWith('api', req);
    });

    it('delegates without an authorize check when an authorization header is present, even with a session cookie', async () => {
        const req = makeRequest({ cookie: 'sess', auth: 'Bearer token' });
        await POST(req);
        expect(authorize).not.toHaveBeenCalled();
        expect(handleInbound).toHaveBeenCalledWith('api', req);
    });

    it('requires create:Agent when a browser session cookie is present with no API credentials', async () => {
        const req = makeRequest({ cookie: 'sess' });
        await POST(req);
        expect(authorize).toHaveBeenCalledWith('create', 'Agent');
        expect(handleInbound).toHaveBeenCalledWith('api', req);
    });

    it('returns the authorize error and never reaches the gateway when denied', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const req = makeRequest({ cookie: 'sess' });
        const res = await POST(req);

        expect(res).toBe(authError);
        expect(handleInbound).not.toHaveBeenCalled();
    });

    it('also checks the __Secure- prefixed cookie name', async () => {
        const req = {
            cookies: { get: (name: string) => (name === '__Secure-next-auth.session-token' ? { value: 'sess' } : undefined) },
            headers: { get: () => null },
        } as any;
        await POST(req);
        expect(authorize).toHaveBeenCalledWith('create', 'Agent');
    });
});
