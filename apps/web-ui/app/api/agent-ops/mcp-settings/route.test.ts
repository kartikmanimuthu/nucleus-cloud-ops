import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent/mcp-config', () => ({
    DEFAULT_MCP_SERVERS: [{ id: 'default1' }],
    mergeConfigs: vi.fn(),
    defaultsToJson: vi.fn(),
    jsonToServerConfigs: vi.fn(),
    validateMcpConfig: vi.fn(),
}));
vi.mock('@/lib/tenant-config-service', () => ({
    TenantConfigService: { getConfig: vi.fn(), saveConfig: vi.fn(), deleteConfig: vi.fn() },
}));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));

import {
    DEFAULT_MCP_SERVERS, mergeConfigs, defaultsToJson, jsonToServerConfigs, validateMcpConfig,
} from '@/lib/agent/mcp-config';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { GET, PUT, DELETE } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('GET /api/agent-ops/mcp-settings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns default servers when no saved config exists', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        vi.mocked(mergeConfigs).mockReturnValue([{ id: 's1' }] as any);
        vi.mocked(defaultsToJson).mockReturnValue({ mcpServers: {} } as any);

        const res = await GET();
        const body = await res.json();

        expect(TenantConfigService.getConfig).toHaveBeenCalledWith('mcp-servers', 'tenant-1');
        expect(res.status).toBe(200);
        expect(body).toEqual({ servers: [{ id: 's1' }], config: { mcpServers: {} }, isCustom: false });
    });

    it('returns the saved config when one exists', async () => {
        const saved = { mcpServers: { s1: {} } };
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(saved as any);
        vi.mocked(mergeConfigs).mockReturnValue([{ id: 's1' }] as any);

        const res = await GET();
        const body = await res.json();
        expect(body.config).toEqual(saved);
        expect(body.isCustom).toBe(true);
    });

    it('falls back to defaults when the config read throws', async () => {
        vi.mocked(TenantConfigService.getConfig).mockRejectedValue(new Error('DB down'));
        vi.mocked(mergeConfigs).mockReturnValue([] as any);
        vi.mocked(defaultsToJson).mockReturnValue({ mcpServers: {} } as any);

        const res = await GET();
        expect(res.status).toBe(200);
        expect(mergeConfigs).toHaveBeenCalledWith(null);
    });

    it('returns 500 when tenant resolution fails', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('Unauthenticated'));
        const res = await GET();
        expect(res.status).toBe(500);
    });
});

describe('PUT /api/agent-ops/mcp-settings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
    });

    it('returns 400 for an invalid config', async () => {
        vi.mocked(validateMcpConfig).mockReturnValue({ ok: false, error: 'bad config' } as any);
        const res = await GET === GET ? await PUT(makeRequest({ config: {} })) : null as never;
        const body = await res!.json();
        expect(res!.status).toBe(400);
        expect(body.error).toBe('bad config');
        expect(TenantConfigService.saveConfig).not.toHaveBeenCalled();
    });

    it('saves the config and logs an audit event', async () => {
        const config = { mcpServers: { s1: {}, s2: {} } };
        vi.mocked(validateMcpConfig).mockReturnValue({ ok: true } as any);
        vi.mocked(jsonToServerConfigs).mockReturnValue([{ id: 's1' }, { id: 's2' }] as any);

        const res = await PUT(makeRequest({ config }));
        const body = await res.json();

        expect(TenantConfigService.saveConfig).toHaveBeenCalledWith('mcp-servers', config, 'tenant-1');
        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true, servers: [{ id: 's1' }, { id: 's2' }], config, isCustom: true });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.settings.mcp_updated' })
        );
    });

    it('returns 500 when saving fails', async () => {
        vi.mocked(validateMcpConfig).mockReturnValue({ ok: true } as any);
        vi.mocked(TenantConfigService.saveConfig).mockRejectedValue(new Error('DB down'));

        const res = await PUT(makeRequest({ config: { mcpServers: {} } }));
        expect(res.status).toBe(500);
    });
});

describe('DELETE /api/agent-ops/mcp-settings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
    });

    it('resets to defaults and logs an audit event', async () => {
        vi.mocked(defaultsToJson).mockReturnValue({ mcpServers: {} } as any);

        const res = await DELETE();
        const body = await res.json();

        expect(TenantConfigService.deleteConfig).toHaveBeenCalledWith('mcp-servers', 'tenant-1');
        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true, servers: DEFAULT_MCP_SERVERS, config: { mcpServers: {} }, isCustom: false });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.settings.mcp_reset' })
        );
    });

    it('returns 500 when deletion fails', async () => {
        vi.mocked(TenantConfigService.deleteConfig).mockRejectedValue(new Error('DB down'));
        const res = await DELETE();
        expect(res.status).toBe(500);
    });
});
