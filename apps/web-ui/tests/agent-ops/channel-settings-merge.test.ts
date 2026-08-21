/**
 * Unit tests for the channel settings routes.
 *
 * Merge-on-blank: the settings forms promise "Leave blank to keep existing
 * values", but the PUT handlers once fully replaced the stored config — a blank
 * required secret 400'd, and blank optional secrets were silently wiped. Those
 * tests pin the fix: a blank incoming field must keep the existing stored value.
 *
 * Create/update split + declared permissions: saving is POST (`create`) or PUT
 * (`update`) depending on whether the channel is already configured, and reading
 * secrets back out moved to its own `update`-gated endpoint. Those tests pin the
 * permission contract — see lib/channels/secret-reveal.ts.
 *
 * Covers slack + jira (the two connectors reported), which exercise both the
 * single-required-secret and multi-optional-secret shapes shared by all five
 * channel routes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
    mockGetConfig,
    mockSaveConfig,
    mockGetSessionTenantId,
    mockGetAuthSession,
    mockLogUserAction,
    mockAuthorize,
    mockGetLinkForTenant,
    mockUpsertLink,
    mockFindTenantIdByTeamId,
} = vi.hoisted(() => ({
    mockGetConfig: vi.fn(),
    mockSaveConfig: vi.fn(),
    mockGetSessionTenantId: vi.fn(),
    mockGetAuthSession: vi.fn(),
    mockLogUserAction: vi.fn(),
    mockAuthorize: vi.fn(),
    mockGetLinkForTenant: vi.fn(),
    mockUpsertLink: vi.fn(),
    mockFindTenantIdByTeamId: vi.fn(),
}));

vi.mock('@/lib/tenant-config-service', () => ({
    TenantConfigService: { getConfig: mockGetConfig, saveConfig: mockSaveConfig },
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

// Slack's team_id → tenantId link — irrelevant to Jira, but the shared slack
// route imports it, so it must be mocked regardless of which channel a test targets.
vi.mock('@/lib/db/repository-factory', () => ({
    getSlackWorkspaceLinkRepository: () => ({
        getLinkForTenant: mockGetLinkForTenant,
        upsertLink: mockUpsertLink,
        findTenantIdByTeamId: mockFindTenantIdByTeamId,
    }),
}));

// Import after mocks
import {
    GET as slackGET,
    POST as slackPOST,
    PUT as slackPUT,
    authz as slackAuthz,
} from '../../app/api/agent-ops/settings/slack/route';
import {
    GET as jiraGET,
    POST as jiraPOST,
    PUT as jiraPUT,
    authz as jiraAuthz,
} from '../../app/api/agent-ops/settings/jira/route';
import {
    GET as revealGET,
    authz as revealAuthz,
} from '../../app/api/agent-ops/settings/[channel]/reveal/route';

function saveReq(body: unknown, method: 'POST' | 'PUT' = 'PUT'): Request {
    return new Request('http://localhost/api/agent-ops/settings/x', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

const putReq = (body: unknown) => saveReq(body, 'PUT');
const postReq = (body: unknown) => saveReq(body, 'POST');

function revealReq(channel: string) {
    return revealGET(new Request(`http://localhost/api/agent-ops/settings/${channel}/reveal`), {
        params: Promise.resolve({ channel }),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionTenantId.mockResolvedValue('tenant-1');
    mockGetAuthSession.mockResolvedValue({ user: { email: 'user@example.com' } });
    mockLogUserAction.mockResolvedValue(undefined);
    mockSaveConfig.mockResolvedValue(undefined);
    mockAuthorize.mockResolvedValue(null); // authorized by default
    // Default: tenant is already linked to a Slack workspace, so merge-on-blank
    // saves don't need to re-verify a bot token against the real Slack API.
    mockGetLinkForTenant.mockResolvedValue({ teamId: 'T-EXIST', tenantId: 'tenant-1', botUserId: 'B-EXIST' });
    mockUpsertLink.mockResolvedValue(undefined);
    mockFindTenantIdByTeamId.mockResolvedValue('tenant-1');
});

describe('Slack settings PUT — merge on blank', () => {
    it('keeps the existing signingSecret and botToken when both are left blank', async () => {
        mockGetConfig.mockResolvedValue({
            signingSecret: 'sign-existing',
            botToken: 'bot-existing',
            enabled: true,
        });

        const res = await slackPUT(putReq({ signingSecret: '', botToken: '', enabled: false }));

        expect(res.status).toBe(200);
        expect(mockSaveConfig).toHaveBeenCalledTimes(1);
        const saved = mockSaveConfig.mock.calls[0][1];
        expect(saved.signingSecret).toBe('sign-existing');
        expect(saved.botToken).toBe('bot-existing');
        expect(saved.enabled).toBe(false);
    });

    it('updates signingSecret but preserves the existing botToken when only the secret is provided', async () => {
        mockGetConfig.mockResolvedValue({
            signingSecret: 'sign-existing',
            botToken: 'bot-existing',
            enabled: true,
        });

        const res = await slackPUT(putReq({ signingSecret: 'sign-new', botToken: '', enabled: true }));

        expect(res.status).toBe(200);
        const saved = mockSaveConfig.mock.calls[0][1];
        expect(saved.signingSecret).toBe('sign-new');
        expect(saved.botToken).toBe('bot-existing');
    });

    it('400s when creating with a blank signingSecret and nothing stored', async () => {
        mockGetConfig.mockResolvedValue(null);

        const res = await slackPOST(postReq({ signingSecret: '', enabled: true }));

        expect(res.status).toBe(400);
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });
});

/**
 * The create/update split. Layer 1 gates POST on `create` and PUT on `update`;
 * these pin the other half of that contract — that the two methods are not
 * interchangeable, so a role holding one cannot reach the other's behaviour by
 * picking a different verb.
 */
describe('Channel settings — create/update boundary', () => {
    it('POST 409s when the channel is already configured', async () => {
        mockGetConfig.mockResolvedValue({ signingSecret: 'sign-existing', enabled: true });

        const res = await slackPOST(postReq({ signingSecret: 'sign-new' }));

        expect(res.status).toBe(409);
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });

    it('PUT 404s when the channel is not configured yet', async () => {
        mockGetConfig.mockResolvedValue(null);

        const res = await slackPUT(putReq({ signingSecret: 'sign-new' }));

        expect(res.status).toBe(404);
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });

    it('POST creates when nothing is stored', async () => {
        mockGetConfig.mockResolvedValue(null);

        const res = await slackPOST(postReq({ signingSecret: 'sign-new', enabled: true }));

        expect(res.status).toBe(200);
        expect(mockSaveConfig).toHaveBeenCalledTimes(1);
        expect(mockSaveConfig.mock.calls[0][1].signingSecret).toBe('sign-new');
    });

    it('holds for Jira too — POST 409s on an existing config, PUT 404s without one', async () => {
        mockGetConfig.mockResolvedValue({ webhookSecret: 'hook-existing', enabled: true });
        expect((await jiraPOST(postReq({ webhookSecret: 'x' }))).status).toBe(409);

        mockGetConfig.mockResolvedValue(null);
        expect((await jiraPUT(putReq({ webhookSecret: 'x' }))).status).toBe(404);
    });
});

/**
 * Permission declarations. These are the whole point of the Channel subject: the
 * routes are gated by the manifest rbac-sync builds from these exports, so a
 * silent edit here is a silent permission change.
 */
describe('Channel settings — declared permissions', () => {
    it('maps every channel method to the Channel subject with the matching verb', () => {
        for (const authz of [slackAuthz, jiraAuthz]) {
            expect(authz.GET).toEqual({ action: 'read', subject: 'Channel' });
            expect(authz.POST).toEqual({ action: 'create', subject: 'Channel' });
            expect(authz.PUT).toEqual({ action: 'update', subject: 'Channel' });
            expect(authz.DELETE).toEqual({ action: 'delete', subject: 'Channel' });
        }
    });

    it('requires update — not read — to reveal stored secrets', () => {
        expect(revealAuthz.GET).toEqual({ action: 'update', subject: 'Channel' });
    });
});

describe('Channel settings GET — always masked', () => {
    it('masks Slack secrets', async () => {
        mockGetConfig.mockResolvedValue({
            signingSecret: 'sign-1234567890',
            botToken: 'bot-1234567890',
            enabled: true,
        });

        const body = await (await slackGET()).json();

        expect(body.signingSecret).not.toBe('sign-1234567890');
        expect(body.signingSecret).toContain('****');
        expect(body.botToken).toContain('****');
    });

    it('masks Jira secrets while leaving non-secret fields readable', async () => {
        mockGetConfig.mockResolvedValue({
            webhookSecret: 'hook-1234567890',
            apiToken: 'token-1234567890',
            baseUrl: 'https://x.atlassian.net',
            enabled: true,
        });

        const body = await (await jiraGET()).json();

        expect(body.webhookSecret).toContain('****');
        expect(body.apiToken).toContain('****');
        expect(body.baseUrl).toBe('https://x.atlassian.net');
    });
});

describe('Channel secret reveal endpoint', () => {
    it('returns plaintext secrets and audits the reveal', async () => {
        mockGetConfig.mockResolvedValue({
            signingSecret: 'sign-1234567890',
            botToken: 'bot-1234567890',
            enabled: true,
        });

        const body = await (await revealReq('slack')).json();

        expect(body.signingSecret).toBe('sign-1234567890');
        expect(body.botToken).toBe('bot-1234567890');
        expect(mockLogUserAction).toHaveBeenCalledTimes(1);
        expect(mockLogUserAction.mock.calls[0][0]).toMatchObject({
            eventType: 'agent.settings.slack_secret_reveal',
            severity: 'high',
        });
    });

    it('returns only the fields marked secret, not the whole config', async () => {
        mockGetConfig.mockResolvedValue({
            webhookSecret: 'hook-1234567890',
            apiToken: 'token-1234567890',
            baseUrl: 'https://x.atlassian.net',
            botAccountId: 'acct-1',
            enabled: true,
        });

        const body = await (await revealReq('jira')).json();

        expect(body.webhookSecret).toBe('hook-1234567890');
        expect(body.apiToken).toBe('token-1234567890');
        expect(body.baseUrl).toBeUndefined();
        expect(body.botAccountId).toBeUndefined();
    });

    it('404s an unknown channel slug without touching stored config', async () => {
        const res = await revealReq('not-a-channel');

        expect(res.status).toBe(404);
        expect(mockGetConfig).not.toHaveBeenCalled();
        expect(mockLogUserAction).not.toHaveBeenCalled();
    });

    it('404s when the channel has no stored config', async () => {
        mockGetConfig.mockResolvedValue(null);

        const res = await revealReq('slack');

        expect(res.status).toBe(404);
        expect(mockLogUserAction).not.toHaveBeenCalled();
    });
});

describe('Jira settings PUT — merge on blank', () => {
    it('keeps existing webhookSecret and apiToken when blank, while updating a visible field', async () => {
        mockGetConfig.mockResolvedValue({
            webhookSecret: 'hook-existing',
            apiToken: 'token-existing',
            baseUrl: 'https://old.atlassian.net',
            enabled: true,
            autoApprove: false,
        });

        const res = await jiraPUT(
            putReq({
                webhookSecret: '',
                apiToken: '',
                baseUrl: 'https://new.atlassian.net',
                enabled: true,
            })
        );

        expect(res.status).toBe(200);
        const saved = mockSaveConfig.mock.calls[0][1];
        expect(saved.webhookSecret).toBe('hook-existing');
        expect(saved.apiToken).toBe('token-existing');
        expect(saved.baseUrl).toBe('https://new.atlassian.net');
    });

    it('400s when creating with a blank webhookSecret and nothing stored', async () => {
        mockGetConfig.mockResolvedValue(null);

        const res = await jiraPOST(postReq({ webhookSecret: '', enabled: true }));

        expect(res.status).toBe(400);
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });
});
