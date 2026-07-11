/**
 * Unit tests for channel settings PUT merge-on-blank behavior.
 *
 * Bug: the settings forms promise "Leave blank to keep existing values", but the
 * PUT handlers fully replaced the stored config — a blank required secret 400'd,
 * and blank optional secrets were silently wiped. These tests pin the fix: a
 * blank incoming field must keep the existing stored value.
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
} = vi.hoisted(() => ({
    mockGetConfig: vi.fn(),
    mockSaveConfig: vi.fn(),
    mockGetSessionTenantId: vi.fn(),
    mockGetAuthSession: vi.fn(),
    mockLogUserAction: vi.fn(),
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

// Import after mocks
import { GET as slackGET, PUT as slackPUT } from '../../app/api/agent-ops/settings/slack/route';
import { GET as jiraGET, PUT as jiraPUT } from '../../app/api/agent-ops/settings/jira/route';

function putReq(body: unknown): Request {
    return new Request('http://localhost/api/agent-ops/settings/x', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function getReq(query = ''): Request {
    return new Request(`http://localhost/api/agent-ops/settings/x${query}`);
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionTenantId.mockResolvedValue('tenant-1');
    mockGetAuthSession.mockResolvedValue({ user: { email: 'user@example.com' } });
    mockLogUserAction.mockResolvedValue(undefined);
    mockSaveConfig.mockResolvedValue(undefined);
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

    it('400s when there is no existing config and signingSecret is blank', async () => {
        mockGetConfig.mockResolvedValue(null);

        const res = await slackPUT(putReq({ signingSecret: '', enabled: true }));

        expect(res.status).toBe(400);
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });
});

describe('Slack settings GET — reveal', () => {
    it('masks secrets by default (no reveal param)', async () => {
        mockGetConfig.mockResolvedValue({
            signingSecret: 'sign-1234567890',
            botToken: 'bot-1234567890',
            enabled: true,
        });

        const res = await slackGET(getReq());
        const body = await res.json();

        expect(body.signingSecret).not.toBe('sign-1234567890');
        expect(body.signingSecret).toContain('****');
        expect(body.botToken).toContain('****');
    });

    it('returns plaintext secrets when reveal=1', async () => {
        mockGetConfig.mockResolvedValue({
            signingSecret: 'sign-1234567890',
            botToken: 'bot-1234567890',
            enabled: true,
        });

        const res = await slackGET(getReq('?reveal=1'));
        const body = await res.json();

        expect(body.signingSecret).toBe('sign-1234567890');
        expect(body.botToken).toBe('bot-1234567890');
    });
});

describe('Jira settings GET — reveal', () => {
    it('returns plaintext webhookSecret and apiToken when reveal=1', async () => {
        mockGetConfig.mockResolvedValue({
            webhookSecret: 'hook-1234567890',
            apiToken: 'token-1234567890',
            baseUrl: 'https://x.atlassian.net',
            enabled: true,
        });

        const res = await jiraGET(getReq('?reveal=1'));
        const body = await res.json();

        expect(body.webhookSecret).toBe('hook-1234567890');
        expect(body.apiToken).toBe('token-1234567890');
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

    it('400s when there is no existing config and webhookSecret is blank', async () => {
        mockGetConfig.mockResolvedValue(null);

        const res = await jiraPUT(putReq({ webhookSecret: '', enabled: true }));

        expect(res.status).toBe(400);
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });
});
