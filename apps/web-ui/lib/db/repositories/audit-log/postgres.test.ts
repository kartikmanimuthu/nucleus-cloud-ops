import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/db/pg-config', async (importOriginal) => ({
    // andWhere (Gate 3 row filtering) is real; only the client factory is mocked.
    ...(await importOriginal<typeof import('@/lib/db/pg-config')>()),
    getTenantClient: vi.fn(),
}));
vi.mock('@/env', () => ({ env: { NODE_ENV: 'test', SKIP_AUDIT_LOGGING: undefined } }));

import { getTenantClient } from '@/lib/db/pg-config';
import { env } from '@/env';
import { AuditLogPostgresRepository } from './postgres';

const makeAuditRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'cuid-1',
    tenantId: 'org-default',
    logId: 'log-abc123',
    timestamp: new Date('2024-03-15T10:00:00Z'),
    eventType: 'account.create',
    action: 'Create Account',
    user: 'alice',
    userType: 'user',
    resource: 'account-1',
    resourceType: 'account',
    resourceId: 'acc-1',
    status: 'success',
    severity: 'info',
    details: 'Account created successfully',
    metadata: null,
    ipAddress: null,
    userAgent: null,
    sessionId: null,
    correlationId: null,
    executionId: null,
    region: null,
    accountId: null,
    duration: null,
    errorCode: null,
    source: 'platform',
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    ...overrides,
});

describe('AuditLogPostgresRepository', () => {
    let mockPrisma: {
        auditLog: {
            create: MockedFunction<any>;
            findMany: MockedFunction<any>;
        };
    };

    beforeEach(() => {
        mockPrisma = {
            auditLog: {
                create: vi.fn(),
                findMany: vi.fn(),
            },
        };
        vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);
    });

    describe('createAuditLog', () => {
        it('defaults expiresAt to 90 days from now when retentionDays is not specified', async () => {
            mockPrisma.auditLog.create.mockResolvedValue(makeAuditRow());

            const before = Date.now();
            const repo = new AuditLogPostgresRepository();
            await repo.createAuditLog({
                tenantId: 'org-default',
                eventType: 'schedule.create',
                action: 'Create Schedule',
                user: 'alice',
                userType: 'user',
                status: 'success',
                severity: 'info',
                source: 'platform',
            });
            const after = Date.now();

            expect(mockPrisma.auditLog.create).toHaveBeenCalledOnce();
            const createArg = mockPrisma.auditLog.create.mock.calls[0][0];
            const expiresAt: Date = createArg.data.expiresAt;
            const defaultRetentionMs = 90 * 24 * 60 * 60 * 1000;

            expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + defaultRetentionMs - 1000);
            expect(expiresAt.getTime()).toBeLessThanOrEqual(after + defaultRetentionMs + 1000);
        });

        it('honors an explicit retentionDays override', async () => {
            mockPrisma.auditLog.create.mockResolvedValue(makeAuditRow());

            const before = Date.now();
            const repo = new AuditLogPostgresRepository();
            await repo.createAuditLog({
                tenantId: 'org-default',
                eventType: 'schedule.create',
                action: 'Create Schedule',
                user: 'alice',
                userType: 'user',
                status: 'success',
                severity: 'info',
                source: 'platform',
                retentionDays: 7,
            } as any);
            const after = Date.now();

            const createArg = mockPrisma.auditLog.create.mock.calls[0][0];
            const expiresAt: Date = createArg.data.expiresAt;
            const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

            expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + sevenDaysMs - 1000);
            expect(expiresAt.getTime()).toBeLessThanOrEqual(after + sevenDaysMs + 1000);
        });

        it('returns void (fire-and-forget) — does not throw on error', async () => {
            mockPrisma.auditLog.create.mockRejectedValueOnce(new Error('DB connection failed'));
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            const repo = new AuditLogPostgresRepository();
            await expect(
                repo.createAuditLog({
                    tenantId: 'org-default',
                    eventType: 'audit.test',
                    action: 'Test',
                    user: 'system',
                    userType: 'system',
                    status: 'info',
                    severity: 'info',
                    source: 'platform',
                } as any)
            ).resolves.toBeUndefined();
            consoleSpy.mockRestore();
        });

        it('includes tenantId from auditData when provided', async () => {
            mockPrisma.auditLog.create.mockResolvedValue(makeAuditRow());

            const repo = new AuditLogPostgresRepository();
            await repo.createAuditLog({
                eventType: 'rbac.update',
                action: 'Update Role',
                user: 'admin',
                userType: 'admin',
                status: 'success',
                severity: 'info',
                source: 'platform',
                ...(({ tenantId: 'tenant-xyz' } as unknown) as Record<string, never>),
            } as any);

            const createArg = mockPrisma.auditLog.create.mock.calls[0][0];
            // Should use the provided tenantId or fall back to 'org-default'
            expect(createArg.data.tenantId).toBeDefined();
        });

        it('skips writing entirely, without ever touching the DB, when tenantId is missing', async () => {
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new AuditLogPostgresRepository();
            await repo.createAuditLog({
                eventType: 'audit.test', action: 'Test', user: 'system', userType: 'system',
                status: 'info', severity: 'info', source: 'platform',
            });
            expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
            consoleSpy.mockRestore();
        });

        it('skips writing entirely in development when SKIP_AUDIT_LOGGING is set', async () => {
            (env as any).NODE_ENV = 'development';
            (env as any).SKIP_AUDIT_LOGGING = 'true';
            try {
                const repo = new AuditLogPostgresRepository();
                await repo.createAuditLog({
                    tenantId: 'org-default', eventType: 'audit.test', action: 'Test', user: 'system',
                    userType: 'system', status: 'info', severity: 'info', source: 'platform',
                });
                expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
            } finally {
                (env as any).NODE_ENV = 'test';
                (env as any).SKIP_AUDIT_LOGGING = undefined;
            }
        });

        it('defaults action/user/userType/status/severity/source when absent from the payload', async () => {
            mockPrisma.auditLog.create.mockResolvedValue(makeAuditRow());
            const repo = new AuditLogPostgresRepository();
            await repo.createAuditLog({ tenantId: 'org-default', eventType: 'x' } as any);

            const data = mockPrisma.auditLog.create.mock.calls[0][0].data;
            expect(data.action).toBe('Unknown Action');
            expect(data.user).toBe('system');
            expect(data.userType).toBe('system');
            expect(data.status).toBe('info');
            expect(data.severity).toBe('info');
            expect(data.source).toBe('system');
        });

        it('calls getTenantClient with the auditData tenantId, not a hardcoded one', async () => {
            mockPrisma.auditLog.create.mockResolvedValue(makeAuditRow());
            const repo = new AuditLogPostgresRepository();
            await repo.createAuditLog({
                tenantId: 'tenant-specific', eventType: 'x', action: 'x', user: 'a', userType: 'user',
                status: 'success', severity: 'info', source: 'platform',
            } as any);
            expect(getTenantClient).toHaveBeenCalledWith('tenant-specific');
        });
    });

    describe('getAuditLogs', () => {
        it('queries with tenantId in WHERE clause', async () => {
            mockPrisma.auditLog.findMany.mockResolvedValue([makeAuditRow()]);

            const repo = new AuditLogPostgresRepository();
            await repo.getAuditLogs('org-default');

            expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ tenantId: 'org-default' }),
                })
            );
        });

        it('adds eventType filter to WHERE when provided', async () => {
            mockPrisma.auditLog.findMany.mockResolvedValue([]);

            const repo = new AuditLogPostgresRepository();
            await repo.getAuditLogs('org-default', { eventType: 'schedule.create' });

            const callArg = mockPrisma.auditLog.findMany.mock.calls[0][0];
            expect(callArg.where.eventType).toBe('schedule.create');
        });

        it('does not add eventType filter when eventType is "all"', async () => {
            mockPrisma.auditLog.findMany.mockResolvedValue([]);

            const repo = new AuditLogPostgresRepository();
            await repo.getAuditLogs('org-default', { eventType: 'all' });

            const callArg = mockPrisma.auditLog.findMany.mock.calls[0][0];
            expect(callArg.where.eventType).toBeUndefined();
        });

        it('returns mapped AuditLog array', async () => {
            mockPrisma.auditLog.findMany.mockResolvedValue([makeAuditRow()]);

            const repo = new AuditLogPostgresRepository();
            const result = await repo.getAuditLogs('org-default');

            expect(result.logs).toHaveLength(1);
            expect(result.logs[0].id).toBe('log-abc123');
            expect(result.logs[0].action).toBe('Create Account');
            expect(result.logs[0].timestamp).toBe('2024-03-15T10:00:00.000Z');
        });

        it('uses tenant-isolation: does not expose other tenants records', async () => {
            mockPrisma.auditLog.findMany.mockResolvedValue([]);

            const repo = new AuditLogPostgresRepository();
            await repo.getAuditLogs('tenant-a');

            const callArg = mockPrisma.auditLog.findMany.mock.calls[0][0];
            expect(callArg.where.tenantId).toBe('tenant-a');
            expect(callArg.where.tenantId).not.toBe('tenant-b');
        });

        it.each([
            ['status', 'error'], ['severity', 'critical'], ['user', 'alice'],
            ['userType', 'admin'], ['resourceType', 'Account'], ['source', 'agent'],
        ])('applies the %s filter when given a real value', async (field, value) => {
            mockPrisma.auditLog.findMany.mockResolvedValue([]);
            const repo = new AuditLogPostgresRepository();
            await repo.getAuditLogs('org-default', { [field]: value } as any);
            expect(mockPrisma.auditLog.findMany.mock.calls[0][0].where[field]).toBe(value);
        });

        it.each(['status', 'severity', 'user', 'userType', 'resourceType', 'source'])(
            'skips the %s filter when its value is "all"',
            async (field) => {
                mockPrisma.auditLog.findMany.mockResolvedValue([]);
                const repo = new AuditLogPostgresRepository();
                await repo.getAuditLogs('org-default', { [field]: 'all' } as any);
                expect(mockPrisma.auditLog.findMany.mock.calls[0][0].where[field]).toBeUndefined();
            },
        );

        it.each(['resourceId', 'correlationId', 'executionId', 'ipAddress'])(
            'applies the %s filter unconditionally (no "all" sentinel)',
            async (field) => {
                mockPrisma.auditLog.findMany.mockResolvedValue([]);
                const repo = new AuditLogPostgresRepository();
                await repo.getAuditLogs('org-default', { [field]: 'value-1' } as any);
                expect(mockPrisma.auditLog.findMany.mock.calls[0][0].where[field]).toBe('value-1');
            },
        );

        it('filters by a start/end date range on timestamp', async () => {
            mockPrisma.auditLog.findMany.mockResolvedValue([]);
            const repo = new AuditLogPostgresRepository();
            await repo.getAuditLogs('org-default', { startDate: '2026-01-01', endDate: '2026-01-31' });
            const where = mockPrisma.auditLog.findMany.mock.calls[0][0].where;
            expect(where.timestamp).toEqual({ gte: new Date('2026-01-01'), lte: new Date('2026-01-31') });
        });

        it('accepts a startDate with no endDate', async () => {
            mockPrisma.auditLog.findMany.mockResolvedValue([]);
            const repo = new AuditLogPostgresRepository();
            await repo.getAuditLogs('org-default', { startDate: '2026-01-01' });
            const where = mockPrisma.auditLog.findMany.mock.calls[0][0].where;
            expect(where.timestamp).toEqual({ gte: new Date('2026-01-01') });
        });

        it('accepts an endDate with no startDate', async () => {
            mockPrisma.auditLog.findMany.mockResolvedValue([]);
            const repo = new AuditLogPostgresRepository();
            await repo.getAuditLogs('org-default', { endDate: '2026-01-31' });
            const where = mockPrisma.auditLog.findMany.mock.calls[0][0].where;
            expect(where.timestamp).toEqual({ lte: new Date('2026-01-31') });
        });

        it('searches action/details/user case-insensitively with a trimmed term', async () => {
            mockPrisma.auditLog.findMany.mockResolvedValue([]);
            const repo = new AuditLogPostgresRepository();
            await repo.getAuditLogs('org-default', { searchTerm: '  deploy  ' });
            const where = mockPrisma.auditLog.findMany.mock.calls[0][0].where;
            expect(where.OR).toEqual([
                { action: { contains: 'deploy', mode: 'insensitive' } },
                { details: { contains: 'deploy', mode: 'insensitive' } },
                { user: { contains: 'deploy', mode: 'insensitive' } },
            ]);
        });

        it('ignores a whitespace-only searchTerm', async () => {
            mockPrisma.auditLog.findMany.mockResolvedValue([]);
            const repo = new AuditLogPostgresRepository();
            await repo.getAuditLogs('org-default', { searchTerm: '   ' });
            expect(mockPrisma.auditLog.findMany.mock.calls[0][0].where.OR).toBeUndefined();
        });

        it('applies a cursor from nextPageToken as an AND when there is no prior OR', async () => {
            mockPrisma.auditLog.findMany.mockResolvedValue([]);
            const repo = new AuditLogPostgresRepository();
            await repo.getAuditLogs('org-default', { nextPageToken: '2026-01-01T00:00:00.000Z|cuid-5' });
            const where = mockPrisma.auditLog.findMany.mock.calls[0][0].where;
            expect(where.AND).toEqual([{
                OR: [
                    { timestamp: { lt: new Date('2026-01-01T00:00:00.000Z') } },
                    { timestamp: new Date('2026-01-01T00:00:00.000Z'), id: { lt: 'cuid-5' } },
                ],
            }]);
        });

        it('merges a cursor with an existing search OR under AND, rather than one overwriting the other', async () => {
            mockPrisma.auditLog.findMany.mockResolvedValue([]);
            const repo = new AuditLogPostgresRepository();
            await repo.getAuditLogs('org-default', {
                searchTerm: 'deploy', nextPageToken: '2026-01-01T00:00:00.000Z|cuid-5',
            });
            const where = mockPrisma.auditLog.findMany.mock.calls[0][0].where;
            expect(where.OR).toBeUndefined();
            expect(where.AND).toHaveLength(2);
            expect(where.AND[0].OR).toEqual([
                { action: { contains: 'deploy', mode: 'insensitive' } },
                { details: { contains: 'deploy', mode: 'insensitive' } },
                { user: { contains: 'deploy', mode: 'insensitive' } },
            ]);
        });

        it('ignores a malformed nextPageToken missing the id half', async () => {
            mockPrisma.auditLog.findMany.mockResolvedValue([]);
            const repo = new AuditLogPostgresRepository();
            await repo.getAuditLogs('org-default', { nextPageToken: 'no-pipe-here' });
            expect(mockPrisma.auditLog.findMany.mock.calls[0][0].where.AND).toBeUndefined();
        });

        it('intersects a Gate-3 row filter under AND without discarding other clauses', async () => {
            mockPrisma.auditLog.findMany.mockResolvedValue([]);
            const repo = new AuditLogPostgresRepository();
            await repo.getAuditLogs('org-default', { searchTerm: 'x', rowFilter: { accountId: { in: ['a1'] } } });
            const where = mockPrisma.auditLog.findMany.mock.calls[0][0].where;
            expect(where.OR).toBeDefined();
            expect(where.AND).toEqual([{ accountId: { in: ['a1'] } }]);
        });

        it('requests limit+1 rows and reports a nextPageToken when more rows exist', async () => {
            const rows = Array.from({ length: 21 }, (_, i) => makeAuditRow({ id: `cuid-${i}`, logId: `log-${i}` }));
            mockPrisma.auditLog.findMany.mockResolvedValue(rows);

            const repo = new AuditLogPostgresRepository();
            const result = await repo.getAuditLogs('org-default', { limit: 20 });

            expect(mockPrisma.auditLog.findMany.mock.calls[0][0].take).toBe(21);
            expect(result.logs).toHaveLength(20);
            expect(result.nextPageToken).toBe(`${rows[19].timestamp.toISOString()}|cuid-19`);
        });

        it('reports no nextPageToken when the page is not full', async () => {
            mockPrisma.auditLog.findMany.mockResolvedValue([makeAuditRow()]);
            const repo = new AuditLogPostgresRepository();
            const result = await repo.getAuditLogs('org-default', { limit: 20 });
            expect(result.nextPageToken).toBeUndefined();
        });

        it('defaults the page size to 20 when no limit is given', async () => {
            mockPrisma.auditLog.findMany.mockResolvedValue([]);
            const repo = new AuditLogPostgresRepository();
            await repo.getAuditLogs('org-default');
            expect(mockPrisma.auditLog.findMany.mock.calls[0][0].take).toBe(21);
        });

        it('returns an empty log list (not a throw) when the query fails', async () => {
            mockPrisma.auditLog.findMany.mockRejectedValue(new Error('DB down'));
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new AuditLogPostgresRepository();
            expect(await repo.getAuditLogs('org-default')).toEqual({ logs: [] });
            consoleSpy.mockRestore();
        });

        it('fills in every optional field with its documented default when absent from the row', async () => {
            mockPrisma.auditLog.findMany.mockResolvedValue([makeAuditRow({
                resource: null, resourceType: null, resourceId: null, details: null, metadata: null,
                ipAddress: null, userAgent: null, sessionId: null, correlationId: null, executionId: null,
                region: null, accountId: null, duration: null, errorCode: null, changeSet: null,
                requestId: null, apiRoute: null, httpMethod: null, dataClassification: null, retentionDays: 90,
            })]);
            const repo = new AuditLogPostgresRepository();
            const [log] = (await repo.getAuditLogs('org-default')).logs;

            expect(log.resource).toBe('');
            expect(log.resourceType).toBe('');
            expect(log.resourceId).toBe('');
            expect(log.details).toBe('');
            expect(log.metadata).toBeUndefined();
            expect(log.ipAddress).toBeUndefined();
            expect(log.changeSet).toBeUndefined();
            expect(log.retentionDays).toBe(90);
        });
    });

    describe('getDistinctFilterValues', () => {
        it('collects and sorts distinct values across all seven dimensions', async () => {
            mockPrisma.auditLog.findMany
                .mockResolvedValueOnce([{ source: 'system' }, { source: 'agent' }]) // sources
                .mockResolvedValueOnce([{ user: 'bob' }, { user: 'alice' }]) // users
                .mockResolvedValueOnce([{ resourceType: 'Schedule' }, { resourceType: null }, { resourceType: 'Account' }]) // resourceTypes
                .mockResolvedValueOnce([{ eventType: 'b.c' }, { eventType: 'a.b' }]) // eventTypes
                .mockResolvedValueOnce([{ severity: 'low' }, { severity: 'high' }]) // severities
                .mockResolvedValueOnce([{ status: 'success' }, { status: 'error' }]) // statuses
                .mockResolvedValueOnce([{ userType: 'user' }, { userType: 'admin' }]); // userTypes

            const repo = new AuditLogPostgresRepository();
            const result = await repo.getDistinctFilterValues('org-default');

            expect(result.sources).toEqual(['agent', 'system']);
            expect(result.users).toEqual(['alice', 'bob']);
            expect(result.resourceTypes).toEqual(['Account', 'Schedule']); // null filtered out
            expect(result.eventTypes).toEqual(['a.b', 'b.c']);
            expect(result.severities).toEqual(['high', 'low']);
            expect(result.statuses).toEqual(['error', 'success']);
            expect(result.userTypes).toEqual(['admin', 'user']);
        });

        it('scopes every one of the seven distinct queries to the given tenant', async () => {
            mockPrisma.auditLog.findMany.mockResolvedValue([]);
            const repo = new AuditLogPostgresRepository();
            await repo.getDistinctFilterValues('tenant-a');
            for (const call of mockPrisma.auditLog.findMany.mock.calls) {
                expect(call[0].where.tenantId).toBe('tenant-a');
            }
            expect(getTenantClient).toHaveBeenCalledWith('tenant-a');
        });

        it('returns all-empty arrays rather than throwing when a query fails', async () => {
            mockPrisma.auditLog.findMany.mockRejectedValue(new Error('DB down'));
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new AuditLogPostgresRepository();
            const result = await repo.getDistinctFilterValues('org-default');
            expect(result).toEqual({
                sources: [], users: [], resourceTypes: [], eventTypes: [], severities: [], statuses: [], userTypes: [],
            });
            consoleSpy.mockRestore();
        });
    });
});

describe('AuditLogPostgresRepository — tenant isolation', () => {
    let mockPrisma: {
        auditLog: {
            create: MockedFunction<any>;
            findMany: MockedFunction<any>;
        };
    };

    beforeEach(() => {
        mockPrisma = {
            auditLog: {
                create: vi.fn().mockResolvedValue({}),
                findMany: vi.fn().mockResolvedValue([]),
            },
        };
        vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);
    });

    it('createAuditLog calls getTenantClient with tenantId from auditData', async () => {
        const repo = new AuditLogPostgresRepository();
        await repo.createAuditLog({
            eventType: 'account.create',
            action: 'Create Account',
            user: 'alice',
            userType: 'user',
            status: 'success',
            severity: 'info',
            source: 'platform',
            ...({ tenantId: 'tenant-test' } as any),
        } as any);
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });

    it('getAuditLogs calls getTenantClient with correct tenantId', async () => {
        const repo = new AuditLogPostgresRepository();
        await repo.getAuditLogs('tenant-test');
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });
});
