/**
 * AccountPostgresRepository
 *
 * PostgreSQL implementation of IAccountRepository using Prisma ORM.
 * Reads/writes the `accounts` table (defined in libs/prisma/schema.prisma).
 *
 * Key improvement over DynamoDB path: getAccounts uses server-side WHERE/ILIKE/LIMIT/OFFSET
 * instead of fetching all records and filtering in memory.
 *
 * Multi-tenant safety: every query is scoped by tenantId — no cross-tenant data access.
 */
import { andWhere, getTenantClient } from '@/lib/db/pg-config';
import type { UIAccount } from '@/lib/types';
import type { IAccountRepository, AccountFilters, AccountPage } from './interface';

export class AccountPostgresRepository implements IAccountRepository {
    async getAccounts(filters: AccountFilters): Promise<AccountPage> {
        try {
            const {
                searchTerm,
                statusFilter,
                connectionFilter,
                page = 1,
                limit = 10,
                tenantId = 'org-default',
                rowFilter,
            } = filters;

            const where: Record<string, unknown> = { tenantId };

            if (searchTerm && searchTerm.trim() !== '') {
                where.OR = [
                    { name: { contains: searchTerm, mode: 'insensitive' } },
                    { accountId: { contains: searchTerm, mode: 'insensitive' } },
                    { description: { contains: searchTerm, mode: 'insensitive' } },
                    { createdBy: { contains: searchTerm, mode: 'insensitive' } },
                ];
            }
            if (statusFilter && statusFilter !== 'all') {
                where.active = statusFilter === 'active';
            }
            if (connectionFilter && connectionFilter !== 'all') {
                where.connectionStatus = connectionFilter;
            }

            // Gate 3: intersect the caller's readable rows.
            const scoped = andWhere(where, rowFilter);

            const skip = (page - 1) * limit;
            const [totalCount, rows] = await Promise.all([
                getTenantClient(tenantId).account.count({ where: scoped }),
                getTenantClient(tenantId).account.findMany({
                    where: scoped,
                    skip,
                    take: limit,
                    orderBy: { createdAt: 'desc' },
                }),
            ]);

            return {
                accounts: rows.map((row) => this.transformToUIAccount(row)),
                totalCount,
            };
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[AccountPostgresRepository] Error in getAccounts:', error);
            throw new Error(`Failed to get accounts: ${msg}`);
        }
    }

    async getAccount(accountId: string, tenantId: string): Promise<UIAccount | null> {
        try {
            const record = await getTenantClient(tenantId).account.findFirst({
                where: { tenantId, accountId },
            });
            if (!record) return null;
            return this.transformToUIAccount(record);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[AccountPostgresRepository] Error in getAccount:', error);
            throw new Error(`Failed to get account: ${msg}`);
        }
    }

    async createAccount(account: Omit<UIAccount, 'id'>, tenantId: string): Promise<UIAccount> {
        try {
            const record = await getTenantClient(tenantId).account.create({
                data: {
                    tenantId,
                    accountId: account.accountId,
                    name: account.name,
                    roleArn: account.roleArn,
                    externalId: account.externalId,
                    regions: account.regions || [],
                    active: account.active ?? true,
                    description: account.description,
                    connectionStatus: 'unknown',
                    // Spot Guard opt-in. Omitted here originally, which meant the flag was
                    // silently dropped on create exactly as it was on update before the
                    // whitelist entry was added — the API returned 201 and nothing persisted.
                    spotAutomationEnabled: account.spotAutomationEnabled ?? false,
                    // Scaling Audit per-account opt-in — same silently-dropped-if-omitted
                    // gotcha as spotAutomationEnabled above.
                    scalingAuditEnabled: account.scalingAuditEnabled ?? false,
                    createdBy: account.createdBy || 'system',
                    updatedBy: account.updatedBy || 'system',
                },
            });
            return this.transformToUIAccount(record);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[AccountPostgresRepository] Error in createAccount:', error);
            throw new Error(`Failed to create account: ${msg}`);
        }
    }

    async updateAccount(
        accountId: string,
        updates: Partial<Omit<UIAccount, 'id' | 'accountId'>>,
        tenantId: string
    ): Promise<UIAccount> {
        try {
            const record = await getTenantClient(tenantId).account.update({
                where: {
                    tenantId_accountId: { tenantId, accountId },
                },
                data: {
                    ...(updates.name !== undefined && { name: updates.name }),
                    ...(updates.roleArn !== undefined && { roleArn: updates.roleArn }),
                    ...(updates.externalId !== undefined && { externalId: updates.externalId }),
                    ...(updates.regions !== undefined && { regions: updates.regions }),
                    ...(updates.active !== undefined && { active: updates.active }),
                    ...(updates.description !== undefined && { description: updates.description }),
                    ...(updates.connectionStatus !== undefined && { connectionStatus: updates.connectionStatus }),
                    ...(updates.connectionError !== undefined && { connectionError: updates.connectionError }),
                    ...(updates.updatedBy !== undefined && { updatedBy: updates.updatedBy }),
                    // Fargate Spot Guard. This whitelist is easy to miss: a field absent
                    // here is SILENTLY dropped — the API returns 200, the UI shows the new
                    // value from optimistic state, and nothing persists.
                    ...(updates.spotAutomationEnabled !== undefined && {
                        spotAutomationEnabled: updates.spotAutomationEnabled,
                    }),
                    ...(updates.spotAutomationStatus !== undefined && {
                        spotAutomationStatus: updates.spotAutomationStatus,
                    }),
                    ...(updates.spotAutomationCheckedAt !== undefined && {
                        spotAutomationCheckedAt: updates.spotAutomationCheckedAt
                            ? new Date(updates.spotAutomationCheckedAt)
                            : null,
                    }),
                    ...(updates.spotAutomationError !== undefined && {
                        spotAutomationError: updates.spotAutomationError,
                    }),
                    ...(updates.templateVersion !== undefined && { templateVersion: updates.templateVersion }),
                    // Scaling Audit per-account opt-in — same whitelist gotcha as above:
                    // omitted here means silently dropped, not persisted.
                    ...(updates.scalingAuditEnabled !== undefined && {
                        scalingAuditEnabled: updates.scalingAuditEnabled,
                    }),
                },
            });
            return this.transformToUIAccount(record);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[AccountPostgresRepository] Error in updateAccount:', error);
            throw new Error(`Failed to update account: ${msg}`);
        }
    }

    async deleteAccount(accountId: string, tenantId: string): Promise<void> {
        try {
            await getTenantClient(tenantId).account.deleteMany({
                where: { tenantId, accountId },
            });
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[AccountPostgresRepository] Error in deleteAccount:', error);
            throw new Error(`Failed to delete account: ${msg}`);
        }
    }

    private transformToUIAccount(record: {
        id: string;
        tenantId: string;
        accountId: string;
        name: string;
        roleArn: string;
        externalId: string | null;
        regions: string[];
        active: boolean;
        description: string | null;
        connectionStatus: string;
        connectionError?: string | null;
        // Fargate Spot Guard. Optional so this transform still accepts a record shape
        // selected before these columns existed.
        spotAutomationEnabled?: boolean;
        spotAutomationStatus?: string;
        spotAutomationCheckedAt?: Date | null;
        spotAutomationError?: string | null;
        templateVersion?: number | null;
        // Scaling Audit. Optional so this transform still accepts a record shape
        // selected before this column existed.
        scalingAuditEnabled?: boolean;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
        updatedBy: string;
    }): UIAccount {
        return {
            id: record.accountId,
            accountId: record.accountId,
            name: record.name,
            roleArn: record.roleArn,
            externalId: record.externalId ?? undefined,
            regions: record.regions,
            active: record.active,
            description: record.description ?? '',
            connectionStatus: record.connectionStatus as UIAccount['connectionStatus'],
            connectionError: record.connectionError ?? undefined,
            // Spot Guard readiness is surfaced SEPARATELY from connectionStatus on
            // purpose: that column has two writers (this service and the workers
            // discovery job, which derives it), so a Spot value there would be clobbered
            // by the next nightly scan — and "customer has not opted in" is not a broken
            // connection and must not paint the account red.
            spotAutomationEnabled: record.spotAutomationEnabled ?? false,
            spotAutomationStatus:
                (record.spotAutomationStatus as UIAccount['spotAutomationStatus']) ?? 'not_configured',
            spotAutomationCheckedAt: record.spotAutomationCheckedAt?.toISOString(),
            spotAutomationError: record.spotAutomationError ?? undefined,
            templateVersion: record.templateVersion ?? undefined,
            scalingAuditEnabled: record.scalingAuditEnabled ?? false,
            lastValidated: record.updatedAt.toISOString(),
            resourceCount: 0,
            schedulesCount: 0,
            monthlySavings: 0,
            createdAt: record.createdAt.toISOString(),
            updatedAt: record.updatedAt.toISOString(),
            createdBy: record.createdBy,
            updatedBy: record.updatedBy,
            tags: [],
        };
    }
}
