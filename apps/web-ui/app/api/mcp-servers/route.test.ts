import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getSessionUserId: vi.fn() }));
vi.mock('@/lib/tenant-config-service', () => ({
    TenantConfigService: { getConfig: vi.fn(), saveConfig: vi.fn(), deleteConfig: vi.fn() },
}));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));

const mockDisconnectTenantServers = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/agent/mcp-manager', () => ({
    getMCPManager: () => ({ disconnectTenantServers: mockDisconnectTenantServers }),
}));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getSessionUserId } from '@/lib/auth-session';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { AuditService } from '@/lib/audit-service';
import { GET, PUT, DELETE } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('GET /api/mcp-servers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await GET();
        expect(res).toBe(authError);
    });

    it('returns 401 when unauthenticated', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('Unauthenticated'));
        const res = await GET();
        expect(res.status).toBe(401);
    });

    it('returns default (empty) servers with isCustom: false when no config is saved', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.servers).toEqual([]);
        expect(body.isCustom).toBe(false);
    });

    it('returns saved servers with isCustom: true and masks secrets', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({
            mcpServers: { remote: { type: 'sse', url: 'https://h/sse', headers: { Authorization: 'Bearer secret-token' } } },
        });

        const res = await GET();
        const body = await res.json();

        expect(body.isCustom).toBe(true);
        expect(body.servers[0].id).toBe('remote');
        expect(JSON.stringify(body.servers)).not.toContain('secret-token');
    });

    it('falls back to defaults when the config read throws', async () => {
        vi.mocked(TenantConfigService.getConfig).mockRejectedValue(new Error('DB down'));

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.isCustom).toBe(false);
    });

    it('returns 500 when the saved config is malformed and merging throws', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ mcpServers: null } as any);

        const res = await GET();
        expect(res.status).toBe(500);
    });
});

describe('PUT /api/mcp-servers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getSessionUserId).mockResolvedValue('u1');
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await PUT(makeRequest({ config: { mcpServers: {} } }));
        expect(res).toBe(authError);
    });

    it('returns 400 for an invalid config', async () => {
        const res = await PUT(makeRequest({ config: { mcpServers: { bad: {} } } }));
        expect(res.status).toBe(400);
    });

    it('returns 401 when unauthenticated', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('Unauthenticated'));
        const res = await PUT(makeRequest({ config: { mcpServers: {} } }));
        expect(res.status).toBe(401);
    });

    it('still saves when reading the currently-stored config throws (non-fatal)', async () => {
        vi.mocked(TenantConfigService.getConfig).mockRejectedValue(new Error('DB down'));

        const res = await PUT(makeRequest({ config: { mcpServers: { local: { command: 'npx', args: [] } } } }));
        expect(res.status).toBe(200);
    });

    it('saves a valid config, disconnects cached MCP connections, and logs a success audit event', async () => {
        const res = await PUT(
            makeRequest({ config: { mcpServers: { local: { command: 'npx', args: ['-y', 'pkg'] } } } })
        );
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.isCustom).toBe(true);
        expect(TenantConfigService.saveConfig).toHaveBeenCalledWith(
            'mcp-servers',
            expect.objectContaining({ mcpServers: expect.objectContaining({ local: expect.anything() }) }),
            'tenant-1'
        );
        expect(mockDisconnectTenantServers).toHaveBeenCalledWith('tenant-1');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'integration.mcp.updated', status: 'success' })
        );
    });

    it('still succeeds when disconnecting cached connections fails (non-fatal)', async () => {
        mockDisconnectTenantServers.mockRejectedValueOnce(new Error('disconnect failed'));

        const res = await PUT(makeRequest({ config: { mcpServers: { local: { command: 'npx', args: [] } } } }));
        expect(res.status).toBe(200);
    });

    it('returns 500 when saveConfig throws', async () => {
        vi.mocked(TenantConfigService.saveConfig).mockRejectedValue(new Error('DB down'));

        const res = await PUT(makeRequest({ config: { mcpServers: { local: { command: 'npx', args: [] } } } }));
        expect(res.status).toBe(500);
    });
});

describe('DELETE /api/mcp-servers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getSessionUserId).mockResolvedValue('u1');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await DELETE();
        expect(res).toBe(authError);
    });

    it('returns 401 when unauthenticated', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('Unauthenticated'));
        const res = await DELETE();
        expect(res.status).toBe(401);
    });

    it('still resets when disconnecting cached connections fails (non-fatal)', async () => {
        mockDisconnectTenantServers.mockRejectedValueOnce(new Error('disconnect failed'));
        const res = await DELETE();
        expect(res.status).toBe(200);
    });

    it('resets to defaults, disconnects cached connections, and logs a success audit event', async () => {
        const res = await DELETE();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toMatchObject({ success: true, isCustom: false });
        expect(TenantConfigService.deleteConfig).toHaveBeenCalledWith('mcp-servers', 'tenant-1');
        expect(mockDisconnectTenantServers).toHaveBeenCalledWith('tenant-1');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'integration.mcp.reset', status: 'success' })
        );
    });

    it('returns 500 when deleteConfig throws', async () => {
        vi.mocked(TenantConfigService.deleteConfig).mockRejectedValue(new Error('DB down'));
        const res = await DELETE();
        expect(res.status).toBe(500);
    });
});
