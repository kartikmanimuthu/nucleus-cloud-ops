import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent/mcp-config', () => ({ validateMcpConfig: vi.fn(), jsonToServerConfigs: vi.fn() }));
vi.mock('@/lib/agent/mcp-manager', () => ({ getMCPManager: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));

import { validateMcpConfig, jsonToServerConfigs } from '@/lib/agent/mcp-config';
import { getMCPManager } from '@/lib/agent/mcp-manager';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { handleMcpTest } from './mcp-test-handler';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;
const VALID_BODY = { id: 'server-1', entry: { command: 'npx', args: ['x'] } };

describe('handleMcpTest', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        vi.mocked(authorize).mockResolvedValue(NextResponse.json({ error: 'Forbidden' }, { status: 403 }));

        const res = await handleMcpTest(makeRequest(VALID_BODY));
        const body = await res.json();
        expect(res.status).toBe(403);
        expect(body).toEqual({ success: false, error: 'Forbidden' });
    });

    it('returns 401 when the tenant cannot be resolved', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('Unauthenticated'));
        const res = await handleMcpTest(makeRequest(VALID_BODY));
        expect(res.status).toBe(401);
    });

    it('returns 400 when id or entry is missing', async () => {
        const res = await handleMcpTest(makeRequest({ id: 'server-1' }));
        expect(res.status).toBe(400);
    });

    it('returns 400 when the single-server config fails validation', async () => {
        vi.mocked(validateMcpConfig).mockReturnValue({ ok: false, error: 'bad config' } as any);
        const res = await handleMcpTest(makeRequest(VALID_BODY));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toBe('bad config');
    });

    it('refuses to test an AWS-credential-injecting stdio server without an account context', async () => {
        vi.mocked(validateMcpConfig).mockReturnValue({ ok: true } as any);
        vi.mocked(jsonToServerConfigs).mockReturnValue([{ transport: 'stdio', requiresAwsCredentials: true }] as any);

        const res = await handleMcpTest(makeRequest(VALID_BODY));
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.error).toContain('can only be verified at run time');
    });

    it('probes the connection and returns the discovered tools on success', async () => {
        vi.mocked(validateMcpConfig).mockReturnValue({ ok: true } as any);
        vi.mocked(jsonToServerConfigs).mockReturnValue([{ transport: 'stdio', requiresAwsCredentials: false }] as any);
        const probeConnection = vi.fn().mockResolvedValue({ toolCount: 2, tools: ['a', 'b'] });
        vi.mocked(getMCPManager).mockReturnValue({ probeConnection } as any);

        const res = await handleMcpTest(makeRequest(VALID_BODY));
        const body = await res.json();

        expect(probeConnection).toHaveBeenCalledWith({ transport: 'stdio', requiresAwsCredentials: false });
        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true, toolCount: 2, tools: ['a', 'b'] });
    });

    it('allows a non-stdio (e.g. http) transport even when requiresAwsCredentials is set', async () => {
        vi.mocked(validateMcpConfig).mockReturnValue({ ok: true } as any);
        vi.mocked(jsonToServerConfigs).mockReturnValue([{ transport: 'http', requiresAwsCredentials: true }] as any);
        const probeConnection = vi.fn().mockResolvedValue({ toolCount: 0, tools: [] });
        vi.mocked(getMCPManager).mockReturnValue({ probeConnection } as any);

        const res = await handleMcpTest(makeRequest(VALID_BODY));
        const body = await res.json();
        expect(body.success).toBe(true);
    });

    it('returns a success:false envelope (not an HTTP error) when the probe throws', async () => {
        vi.mocked(validateMcpConfig).mockReturnValue({ ok: true } as any);
        vi.mocked(jsonToServerConfigs).mockReturnValue([{ transport: 'stdio' }] as any);
        vi.mocked(getMCPManager).mockReturnValue({ probeConnection: vi.fn().mockRejectedValue(new Error('spawn failed')) } as any);

        const res = await handleMcpTest(makeRequest(VALID_BODY));
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body).toEqual({ success: false, error: 'spawn failed' });
    });
});
