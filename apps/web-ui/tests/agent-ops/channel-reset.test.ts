/**
 * Unit tests for the channel settings DELETE (reset) handlers.
 *
 * Reset deletes a channel's stored credentials so it returns to the unconfigured
 * state. Two things must hold:
 *   1. It is RBAC-gated — the credentials are destroyed irreversibly.
 *   2. Slack additionally drops the SlackWorkspaceLink. A link left behind keeps
 *      mapping the workspace's team_id to a tenant with no signing secret, so
 *      inbound slash commands fail signature verification (the exact production
 *      failure mode this table exists to prevent) instead of being rejected as
 *      unlinked.
 *
 * Covers slack (link-owning) + webhook (plain config-only) — the two shapes all
 * five channel routes reduce to.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
    mockDeleteConfig,
    mockGetConfig,
    mockSaveConfig,
    mockGetSessionTenantId,
    mockGetAuthSession,
    mockLogUserAction,
    mockAuthorize,
    mockGetLinkForTenant,
    mockUpsertLink,
    mockFindTenantIdByTeamId,
    mockDeleteLinkForTenant,
} = vi.hoisted(() => ({
    mockDeleteConfig: vi.fn(),
    mockGetConfig: vi.fn(),
    mockSaveConfig: vi.fn(),
    mockGetSessionTenantId: vi.fn(),
    mockGetAuthSession: vi.fn(),
    mockLogUserAction: vi.fn(),
    mockAuthorize: vi.fn(),
    mockGetLinkForTenant: vi.fn(),
    mockUpsertLink: vi.fn(),
    mockFindTenantIdByTeamId: vi.fn(),
    mockDeleteLinkForTenant: vi.fn(),
}));

vi.mock('@/lib/tenant-config-service', () => ({
    TenantConfigService: {
        getConfig: mockGetConfig,
        saveConfig: mockSaveConfig,
        deleteConfig: mockDeleteConfig,
    },
}));

vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: mockGetSessionTenantId,
    getAuthSession: mockGetAuthSession,
}));

vi.mock('@/lib/audit-service', () => ({
    AuditService: { logUserAction: mockLogUserAction },
}));

vi.mock('@/lib/rbac/authorize', () => ({
    authorize: mockAuthorize,
}));

vi.mock('@/lib/db/repository-factory', () => ({
    getSlackWorkspaceLinkRepository: () => ({
        getLinkForTenant: mockGetLinkForTenant,
        upsertLink: mockUpsertLink,
        findTenantIdByTeamId: mockFindTenantIdByTeamId,
        deleteLinkForTenant: mockDeleteLinkForTenant,
    }),
}));

// Import after mocks
import { DELETE as slackDELETE } from '../../app/api/agent-ops/settings/slack/route';
import { DELETE as webhookDELETE } from '../../app/api/agent-ops/settings/webhook/route';

const TENANT = 'tenant-abc';

beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionTenantId.mockResolvedValue(TENANT);
    mockGetAuthSession.mockResolvedValue({ user: { email: 'admin@example.com' } });
    mockAuthorize.mockResolvedValue(null); // authorized
    mockDeleteConfig.mockResolvedValue(undefined);
    mockDeleteLinkForTenant.mockResolvedValue(1);
    mockLogUserAction.mockResolvedValue(undefined);
});

describe('DELETE /api/agent-ops/settings/slack', () => {
    it('deletes the stored config and the workspace link', async () => {
        const res = await slackDELETE();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toMatchObject({ success: true, configured: false });
        expect(mockDeleteConfig).toHaveBeenCalledWith('agent-ops-slack', TENANT);
        expect(mockDeleteLinkForTenant).toHaveBeenCalledWith(TENANT);
    });

    it('is RBAC-gated — an unauthorized caller deletes nothing', async () => {
        const forbidden = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
        mockAuthorize.mockResolvedValue(forbidden);

        const res = await slackDELETE();

        expect(res.status).toBe(403);
        expect(mockDeleteConfig).not.toHaveBeenCalled();
        expect(mockDeleteLinkForTenant).not.toHaveBeenCalled();
    });

    it('audits the reset as a high-severity event', async () => {
        await slackDELETE();

        expect(mockLogUserAction).toHaveBeenCalledWith(
            expect.objectContaining({
                eventType: 'agent.settings.slack_reset',
                severity: 'high',
                httpMethod: 'DELETE',
                user: 'admin@example.com',
                metadata: { tenantId: TENANT },
            })
        );
    });

    it('surfaces a repository failure as a 500', async () => {
        mockDeleteConfig.mockRejectedValue(new Error('db down'));

        const res = await slackDELETE();
        const body = await res.json();

        expect(res.status).toBe(500);
        expect(body.error).toContain('db down');
    });
});

describe('DELETE /api/agent-ops/settings/webhook', () => {
    it('deletes the stored config', async () => {
        const res = await webhookDELETE();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toMatchObject({ success: true, configured: false });
        expect(mockDeleteConfig).toHaveBeenCalledWith('agent-ops-webhook', TENANT);
    });

    it('is RBAC-gated', async () => {
        mockAuthorize.mockResolvedValue(new Response(null, { status: 403 }));

        const res = await webhookDELETE();

        expect(res.status).toBe(403);
        expect(mockDeleteConfig).not.toHaveBeenCalled();
    });
});
