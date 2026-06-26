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
import { getTenantClient } from '@/lib/db/pg-config';
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

            const skip = (page - 1) * limit;
            const [totalCount, rows] = await Promise.all([
                getTenantClient(tenantId).account.count({ where }),
                getTenantClient(tenantId).account.findMany({
                    where,
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
