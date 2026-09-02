import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/repository-factory', () => ({ getAuditLogRepository: vi.fn() }));
vi.mock('@/env', () => ({ env: { NODE_ENV: 'test', SKIP_AUDIT_LOGGING: undefined } }));

import { env } from '@/env';
import { getAuditLogRepository } from '@/lib/db/repository-factory';
import { AuditService } from './audit-service';

const mockRepo = { createAuditLog: vi.fn(), getAuditLogs: vi.fn() };

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuditLogRepository).mockReturnValue(mockRepo as any);
    mockRepo.createAuditLog.mockResolvedValue(undefined);
    (env as any).NODE_ENV = 'test';
    (env as any).SKIP_AUDIT_LOGGING = undefined;
});

const BASE_LOG = {
    eventType: 'account.created', action: 'Created', resourceType: 'Account', resourceId: 'a1',
    resourceName: 'a1', user: 'a@b.co', userType: 'user' as const, status: 'success' as const,
    severity: 'low' as const, details: 'x', source: 'platform' as const, tenantId: 't1',
};

describe('createAuditLog', () => {
    it('delegates the cleaned payload to the active repository', async () => {
        await AuditService.createAuditLog(BASE_LOG);
        expect(mockRepo.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'account.created', action: 'Created', status: 'success', user: 'a@b.co',
        }));
    });

    it('skips logging entirely in development when SKIP_AUDIT_LOGGING is set', async () => {
        (env as any).NODE_ENV = 'development';
        (env as any).SKIP_AUDIT_LOGGING = 'true';
        await AuditService.createAuditLog(BASE_LOG);
        expect(mockRepo.createAuditLog).not.toHaveBeenCalled();
    });

    it('does not skip in development when SKIP_AUDIT_LOGGING is unset', async () => {
        (env as any).NODE_ENV = 'development';
        await AuditService.createAuditLog(BASE_LOG);
        expect(mockRepo.createAuditLog).toHaveBeenCalledOnce();
    });

    it('parses a legacy JSON-string payload before validating it', async () => {
        await AuditService.createAuditLog(JSON.stringify(BASE_LOG) as any);
        expect(mockRepo.createAuditLog).toHaveBeenCalledOnce();
    });

    it('drops a legacy payload that is an unparsable string, without throwing', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await AuditService.createAuditLog('not json {' as any);
        expect(mockRepo.createAuditLog).not.toHaveBeenCalled();
        consoleSpy.mockRestore();
    });

    it('drops a null/non-object/empty payload rather than writing a blank row', async () => {
        await AuditService.createAuditLog(null as any);
        await AuditService.createAuditLog({} as any);
        expect(mockRepo.createAuditLog).not.toHaveBeenCalled();
    });

    it('fills in defaults for a sparse payload', async () => {
        await AuditService.createAuditLog({ eventType: 'schedule.paused' } as any);
        const written = mockRepo.createAuditLog.mock.calls[0][0];
        expect(written.action).toBe('Unknown Action');
        expect(written.status).toBe('info');
        expect(written.user).toBe('system');
        expect(written.timestamp).toEqual(expect.any(String));
    });

    it('derives retentionDays from the event-type domain when not explicitly set', async () => {
        await AuditService.createAuditLog({ eventType: 'auth.session.login' } as any);
        expect(mockRepo.createAuditLog.mock.calls[0][0].retentionDays).toBe(365);
    });

    it('falls back to 90 retention days for an unrecognized domain', async () => {
        await AuditService.createAuditLog({ eventType: 'unknown-domain.thing' } as any);
        expect(mockRepo.createAuditLog.mock.calls[0][0].retentionDays).toBe(90);
    });

    it('honors an explicitly supplied retentionDays over the derived one', async () => {
        await AuditService.createAuditLog({ eventType: 'auth.login', retentionDays: 7 } as any);
        expect(mockRepo.createAuditLog.mock.calls[0][0].retentionDays).toBe(7);
    });

    it('swallows a repository error rather than throwing out to the caller', async () => {
        mockRepo.createAuditLog.mockRejectedValue(new Error('DB down'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(AuditService.createAuditLog(BASE_LOG)).resolves.toBeUndefined();
        consoleSpy.mockRestore();
    });
});

describe('getAuditLogs', () => {
    it('requires a tenantId and returns an empty page rather than throwing when it is missing', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const result = await AuditService.getAuditLogs({});
        expect(result).toEqual({ logs: [], nextPageToken: undefined });
        expect(mockRepo.getAuditLogs).not.toHaveBeenCalled();
        consoleSpy.mockRestore();
    });

    it('delegates to the repository with the tenantId and filters', async () => {
        mockRepo.getAuditLogs.mockResolvedValue({ logs: [{ id: '1' }], nextPageToken: 'tok' });
        const result = await AuditService.getAuditLogs({ status: 'error' }, 't1');
        expect(mockRepo.getAuditLogs).toHaveBeenCalledWith('t1', { status: 'error' });
        expect(result).toEqual({ logs: [{ id: '1' }], nextPageToken: 'tok' });
    });

    it('returns an empty page when the repository throws', async () => {
        mockRepo.getAuditLogs.mockRejectedValue(new Error('DB down'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(await AuditService.getAuditLogs({}, 't1')).toEqual({ logs: [], nextPageToken: undefined });
        consoleSpy.mockRestore();
    });
});

describe('getAuditLogsByCorrelation', () => {
    it('fetches by correlationId, capped at 100, and returns just the logs array', async () => {
        mockRepo.getAuditLogs.mockResolvedValue({ logs: [{ id: '1' }] });
        const result = await AuditService.getAuditLogsByCorrelation('corr-1', 't1');
        expect(mockRepo.getAuditLogs).toHaveBeenCalledWith('t1', { correlationId: 'corr-1', limit: 100 });
        expect(result).toEqual([{ id: '1' }]);
    });

    it('returns an empty array when getAuditLogs itself throws', async () => {
        // getAuditLogs has its own internal try/catch and never actually throws to a
        // caller — so this method's own catch only fires if the call throws some
        // other way. Spy on the method directly to exercise that catch for real.
        const spy = vi.spyOn(AuditService, 'getAuditLogs').mockRejectedValue(new Error('unexpected'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(await AuditService.getAuditLogsByCorrelation('corr-1', 't1')).toEqual([]);
        consoleSpy.mockRestore();
        spy.mockRestore();
    });
});

describe('getAuditLogStats', () => {
    it('aggregates counts and group-bys across the fetched logs', async () => {
        mockRepo.getAuditLogs.mockResolvedValue({
            logs: [
                { status: 'success', userType: 'user', severity: 'low', eventType: 'a.b', resourceType: 'Account' },
                { status: 'error', userType: 'admin', severity: 'critical', eventType: 'a.b', resourceType: 'Account' },
                { status: 'warning', userType: 'system', severity: 'medium', eventType: 'c.d', resourceType: 'Schedule' },
            ],
        });

        const stats = await AuditService.getAuditLogStats({}, 't1');

        expect(stats.totalLogs).toBe(3);
        expect(stats.successCount).toBe(1);
        expect(stats.errorCount).toBe(1);
        expect(stats.warningCount).toBe(1);
        expect(stats.systemEvents).toBe(1);
        expect(stats.userEvents).toBe(2); // user + admin
        expect(stats.criticalEvents).toBe(1);
        expect(stats.byEventType).toEqual({ 'a.b': 2, 'c.d': 1 });
        expect(stats.byResourceType).toEqual({ Account: 2, Schedule: 1 });
    });

    it('buckets a log missing the grouped field under "unknown"', async () => {
        mockRepo.getAuditLogs.mockResolvedValue({ logs: [{ status: 'success' }] });
        const stats = await AuditService.getAuditLogStats({}, 't1');
        expect(stats.byEventType).toEqual({ unknown: 1 });
    });

    it('caps the underlying fetch at 500 with no page token', async () => {
        mockRepo.getAuditLogs.mockResolvedValue({ logs: [] });
        await AuditService.getAuditLogStats({ status: 'error', nextPageToken: 'stale' }, 't1');
        expect(mockRepo.getAuditLogs).toHaveBeenCalledWith('t1', expect.objectContaining({ limit: 500, nextPageToken: undefined }));
    });

    it('returns a zeroed stats object when getAuditLogs itself throws', async () => {
        const spy = vi.spyOn(AuditService, 'getAuditLogs').mockRejectedValue(new Error('unexpected'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const stats = await AuditService.getAuditLogStats({}, 't1');
        expect(stats.totalLogs).toBe(0);
        expect(stats.byEventType).toEqual({});
        consoleSpy.mockRestore();
        spy.mockRestore();
    });
});

// NOTE: validateAndCleanAuditData's `if (!data || typeof data !== 'object') throw` is
// unreachable through the public createAuditLog entry point — its own guard just above
// already filters out null/non-object/empty-object payloads before this private method
// ever runs. Left untested, same convention as other documented-unreachable branches.

describe('getRequestContext', () => {
    const makeRequest = (headers: Record<string, string>) => ({
        headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
    }) as any;

    it('takes the first IP from a comma-separated x-forwarded-for', () => {
        const ctx = AuditService.getRequestContext(makeRequest({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }));
        expect(ctx.ipAddress).toBe('1.2.3.4');
    });

    it('falls back to x-real-ip when x-forwarded-for is absent', () => {
        const ctx = AuditService.getRequestContext(makeRequest({ 'x-real-ip': '9.9.9.9' }));
        expect(ctx.ipAddress).toBe('9.9.9.9');
    });

    it('falls back to "unknown" when neither header is present', () => {
        const ctx = AuditService.getRequestContext(makeRequest({}));
        expect(ctx.ipAddress).toBe('unknown');
    });

    it('defaults userAgent to "unknown" when absent', () => {
        const ctx = AuditService.getRequestContext(makeRequest({}));
        expect(ctx.userAgent).toBe('unknown');
    });

    it('passes through a real user-agent header', () => {
        const ctx = AuditService.getRequestContext(makeRequest({ 'user-agent': 'curl/8.0' }));
        expect(ctx.userAgent).toBe('curl/8.0');
    });

    it('uses the x-request-id header when present', () => {
        const ctx = AuditService.getRequestContext(makeRequest({ 'x-request-id': 'req-fixed-1' }));
        expect(ctx.requestId).toBe('req-fixed-1');
    });

    it('generates a request id when the header is absent', () => {
        const ctx = AuditService.getRequestContext(makeRequest({}));
        expect(ctx.requestId).toMatch(/^req-\d+-[a-z0-9]+$/);
    });
});

describe('logUserAction', () => {
    it('derives a domain.entity_action event type from resourceType and action', async () => {
        await AuditService.logUserAction({
            action: 'Created Account', resourceType: 'Account', resourceId: 'a1', resourceName: 'Prod',
            user: 'a@b.co', userType: 'user', status: 'success', details: 'x',
        });
        expect(mockRepo.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'Account.created_account', source: 'platform', resource: 'Prod',
        }));
    });

    it('honors an explicit eventType over the derived one', async () => {
        await AuditService.logUserAction({
            action: 'x', resourceType: 'Account', resourceId: 'a1', resourceName: 'Prod', user: 'a@b.co',
            userType: 'user', status: 'success', details: 'x', eventType: 'custom.event',
        });
        expect(mockRepo.createAuditLog.mock.calls[0][0].eventType).toBe('custom.event');
    });

    it('defaults severity to high on error, medium on warning, info otherwise', async () => {
        const base = { action: 'x', resourceType: 'Account', resourceId: 'a1', resourceName: 'r', user: 'a@b.co', userType: 'user' as const, details: 'x' };
        await AuditService.logUserAction({ ...base, status: 'error' });
        await AuditService.logUserAction({ ...base, status: 'warning' });
        await AuditService.logUserAction({ ...base, status: 'success' });
        const [c1, c2, c3] = mockRepo.createAuditLog.mock.calls;
        expect(c1[0].severity).toBe('high');
        expect(c2[0].severity).toBe('medium');
        expect(c3[0].severity).toBe('info');
    });

    it('honors an explicit severity over the status-derived default', async () => {
        await AuditService.logUserAction({
            action: 'x', resourceType: 'Account', resourceId: 'a1', resourceName: 'r', user: 'a@b.co',
            userType: 'user', status: 'error', details: 'x', severity: 'low',
        });
        expect(mockRepo.createAuditLog.mock.calls[0][0].severity).toBe('low');
    });

    it('falls back to resourceId as the resource label when resourceName is empty', async () => {
        await AuditService.logUserAction({
            action: 'x', resourceType: 'Account', resourceId: 'a1', resourceName: '', user: 'a@b.co',
            userType: 'user', status: 'success', details: 'x',
        });
        expect(mockRepo.createAuditLog.mock.calls[0][0].resource).toBe('a1');
    });

    it('reads tenantId from metadata.tenantId when not passed directly', async () => {
        await AuditService.logUserAction({
            action: 'x', resourceType: 'Account', resourceId: 'a1', resourceName: 'r', user: 'a@b.co',
            userType: 'user', status: 'success', details: 'x', metadata: { tenantId: 'meta-tenant' },
        });
        expect(mockRepo.createAuditLog.mock.calls[0][0].tenantId).toBe('meta-tenant');
    });

    it('omits tenantId entirely when neither source provides one', async () => {
        await AuditService.logUserAction({
            action: 'x', resourceType: 'Account', resourceId: 'a1', resourceName: 'r', user: 'a@b.co',
            userType: 'user', status: 'success', details: 'x',
        });
        expect(mockRepo.createAuditLog.mock.calls[0][0]).not.toHaveProperty('tenantId');
    });

    it('swallows an internal error rather than throwing out to the caller', async () => {
        // createAuditLog has its own internal try/catch and never actually throws — spy
        // on it directly to exercise this method's own catch for real.
        const spy = vi.spyOn(AuditService, 'createAuditLog').mockRejectedValue(new Error('boom'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(AuditService.logUserAction({
            action: 'x', resourceType: 'Account', resourceId: 'a1', resourceName: 'r', user: 'a@b.co',
            userType: 'user', status: 'success', details: 'x',
        })).resolves.toBeUndefined();
        consoleSpy.mockRestore();
        spy.mockRestore();
    });
});

describe('logResourceAction', () => {
    it('defaults user/userType/source to system when not supplied', async () => {
        await AuditService.logResourceAction({
            action: 'Sync', resourceType: 'Schedule', resourceId: 's1', resourceName: 'nightly', status: 'success', details: 'x',
        });
        expect(mockRepo.createAuditLog.mock.calls[0][0]).toMatchObject({ user: 'system', userType: 'system', source: 'system' });
    });

    it('honors explicit user/userType/source when supplied', async () => {
        await AuditService.logResourceAction({
            action: 'Sync', resourceType: 'Schedule', resourceId: 's1', resourceName: 'nightly', status: 'success', details: 'x',
            user: 'a@b.co', userType: 'user', source: 'agent',
        });
        expect(mockRepo.createAuditLog.mock.calls[0][0]).toMatchObject({ user: 'a@b.co', userType: 'user', source: 'agent' });
    });

    it('defaults severity to high on error, medium on warning, info otherwise', async () => {
        const base = { action: 'x', resourceType: 'Schedule', resourceId: 's1', resourceName: 'r', details: 'x' };
        await AuditService.logResourceAction({ ...base, status: 'error' });
        await AuditService.logResourceAction({ ...base, status: 'warning' });
        await AuditService.logResourceAction({ ...base, status: 'success' });
        const [c1, c2, c3] = mockRepo.createAuditLog.mock.calls;
        expect(c1[0].severity).toBe('high');
        expect(c2[0].severity).toBe('medium');
        expect(c3[0].severity).toBe('info');
    });

    it('honors an explicit severity over the status-derived default', async () => {
        await AuditService.logResourceAction({
            action: 'x', resourceType: 'Schedule', resourceId: 's1', resourceName: 'r', status: 'error', details: 'x', severity: 'low',
        });
        expect(mockRepo.createAuditLog.mock.calls[0][0].severity).toBe('low');
    });

    it('swallows an internal error rather than throwing', async () => {
        const spy = vi.spyOn(AuditService, 'createAuditLog').mockRejectedValue(new Error('boom'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(AuditService.logResourceAction({
            action: 'x', resourceType: 'Schedule', resourceId: 's1', resourceName: 'r', status: 'success', details: 'x',
        })).resolves.toBeUndefined();
        consoleSpy.mockRestore();
        spy.mockRestore();
    });
});

describe('logSystemEvent', () => {
    it('always sets user/userType/source to the system identity', async () => {
        await AuditService.logSystemEvent({ eventType: 'discovery.scan', action: 'Scan', status: 'success', details: 'x' });
        expect(mockRepo.createAuditLog.mock.calls[0][0]).toMatchObject({ user: 'system', userType: 'system', source: 'system' });
    });

    it('falls back to an empty resource label when resourceId is absent', async () => {
        await AuditService.logSystemEvent({ eventType: 'discovery.scan', action: 'Scan', status: 'success', details: 'x' });
        expect(mockRepo.createAuditLog.mock.calls[0][0].resource).toBe('');
    });

    it('defaults severity to high on error, medium on warning, info otherwise', async () => {
        const base = { eventType: 'discovery.scan', action: 'Scan', details: 'x' };
        await AuditService.logSystemEvent({ ...base, status: 'error' });
        await AuditService.logSystemEvent({ ...base, status: 'warning' });
        await AuditService.logSystemEvent({ ...base, status: 'success' });
        const [c1, c2, c3] = mockRepo.createAuditLog.mock.calls;
        expect(c1[0].severity).toBe('high');
        expect(c2[0].severity).toBe('medium');
        expect(c3[0].severity).toBe('info');
    });

    it('honors an explicit severity over the status-derived default', async () => {
        await AuditService.logSystemEvent({ eventType: 'x', action: 'x', status: 'error', details: 'x', severity: 'low' });
        expect(mockRepo.createAuditLog.mock.calls[0][0].severity).toBe('low');
    });

    it('swallows an internal error rather than throwing', async () => {
        const spy = vi.spyOn(AuditService, 'createAuditLog').mockRejectedValue(new Error('boom'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(AuditService.logSystemEvent({
            eventType: 'x', action: 'x', status: 'success', details: 'x',
        })).resolves.toBeUndefined();
        consoleSpy.mockRestore();
        spy.mockRestore();
    });
});

describe('logAgentEvent', () => {
    it('sets source=agent, userType=user, and user from userId', async () => {
        await AuditService.logAgentEvent({
            eventType: 'agent.tool.exec', action: 'execute_command', userId: 'u1', status: 'success',
            details: 'x', correlationId: 'thread-1',
        });
        expect(mockRepo.createAuditLog.mock.calls[0][0]).toMatchObject({ source: 'agent', userType: 'user', user: 'u1' });
    });

    it('defaults severity to medium on a non-error status', async () => {
        await AuditService.logAgentEvent({
            eventType: 'x', action: 'x', userId: 'u1', status: 'warning', details: 'x', correlationId: 'c1',
        });
        expect(mockRepo.createAuditLog.mock.calls[0][0].severity).toBe('medium');
    });

    it('defaults severity to high on an error status', async () => {
        await AuditService.logAgentEvent({
            eventType: 'x', action: 'x', userId: 'u1', status: 'error', details: 'x', correlationId: 'c1',
        });
        expect(mockRepo.createAuditLog.mock.calls[0][0].severity).toBe('high');
    });

    it('honors an explicit severity over the status-derived default', async () => {
        await AuditService.logAgentEvent({
            eventType: 'x', action: 'x', userId: 'u1', status: 'error', details: 'x', correlationId: 'c1', severity: 'low',
        });
        expect(mockRepo.createAuditLog.mock.calls[0][0].severity).toBe('low');
    });

    it('swallows an internal error rather than throwing', async () => {
        const spy = vi.spyOn(AuditService, 'createAuditLog').mockRejectedValue(new Error('boom'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(AuditService.logAgentEvent({
            eventType: 'x', action: 'x', userId: 'u1', status: 'success', details: 'x', correlationId: 'c1',
        })).resolves.toBeUndefined();
        consoleSpy.mockRestore();
        spy.mockRestore();
    });
});
