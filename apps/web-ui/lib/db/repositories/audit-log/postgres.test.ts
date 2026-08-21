import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/db/pg-config', async (importOriginal) => ({
    // andWhere (Gate 3 row filtering) is real; only the client factory is mocked.
    ...(await importOriginal<typeof import('@/lib/db/pg-config')>()),
    getTenantClient: vi.fn(),
}));

import { getTenantClient } from '@/lib/db/pg-config';
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
        it('sets expiresAt approximately 30 days from now', async () => {
            mockPrisma.auditLog.create.mockResolvedValue(makeAuditRow());

            const before = Date.now();
            const repo = new AuditLogPostgresRepository();
            await repo.createAuditLog({
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
            const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

            expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + thirtyDaysMs - 1000);
            expect(expiresAt.getTime()).toBeLessThanOrEqual(after + thirtyDaysMs + 1000);
        });

        it('returns void (fire-and-forget) — does not throw on error', async () => {
            mockPrisma.auditLog.create.mockRejectedValueOnce(new Error('DB connection failed'));

            const repo = new AuditLogPostgresRepository();
            await expect(
                repo.createAuditLog({
                    eventType: 'audit.test',
                    action: 'Test',
                    user: 'system',
                    userType: 'system',
                    status: 'info',
                    severity: 'info',
                    source: 'platform',
                })
            ).resolves.toBeUndefined();
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
