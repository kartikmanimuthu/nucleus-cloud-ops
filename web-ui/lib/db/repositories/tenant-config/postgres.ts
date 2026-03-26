/**
 * TenantConfigPostgresRepository
 *
 * PostgreSQL implementation of ITenantConfigRepository using Prisma ORM.
 * Reads/writes the `tenant_configs` table (defined in prisma/schema.prisma).
 *
 * Uses upsert (ON CONFLICT DO UPDATE equivalent) for saveConfig so migration
 * scripts can run idempotently.
 *
 * Multi-tenant safety: every query is scoped by tenantId — no cross-tenant data access.
 */
import { getPrismaClient } from '@/lib/db/pg-config';
import type { ITenantConfigRepository } from './interface';

export class TenantConfigPostgresRepository implements ITenantConfigRepository {
    async getConfig<T = unknown>(configKey: string, tenantId: string): Promise<T | null> {
        try {
            const record = await getPrismaClient().tenantConfig.findUnique({
                where: {
                    tenantId_configKey: { tenantId, configKey },
                },
            });
            if (!record) return null;
            return record.data as T;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`[TenantConfigPostgresRepository] Error getting config "${configKey}":`, error);
            throw new Error(`Failed to get config: ${msg}`);
        }
    }

    async saveConfig<T = unknown>(
        configKey: string,
        data: T,
        tenantId: string,
        updatedBy = 'system'
    ): Promise<void> {
        try {
            await getPrismaClient().tenantConfig.upsert({
                where: {
                    tenantId_configKey: { tenantId, configKey },
                },
                update: {
                    data: data as object,
                    updatedBy,
                },
                create: {
                    tenantId,
                    configKey,
                    data: data as object,
                    updatedBy,
                },
            });
            console.log(`[TenantConfigPostgresRepository] Saved config "${configKey}" for tenant "${tenantId}"`);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`[TenantConfigPostgresRepository] Error saving config "${configKey}":`, error);
            throw new Error(`Failed to save config: ${msg}`);
        }
    }

    async deleteConfig(configKey: string, tenantId: string): Promise<void> {
        try {
            await getPrismaClient().tenantConfig.deleteMany({
                where: { tenantId, configKey },
            });
            console.log(`[TenantConfigPostgresRepository] Deleted config "${configKey}" for tenant "${tenantId}"`);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`[TenantConfigPostgresRepository] Error deleting config "${configKey}":`, error);
            throw new Error(`Failed to delete config: ${msg}`);
        }
    }

    async listConfigs(tenantId: string): Promise<Array<{ configKey: string; updatedAt: string }>> {
        try {
            const records = await getPrismaClient().tenantConfig.findMany({
                where: { tenantId },
                select: { configKey: true, updatedAt: true },
                orderBy: { configKey: 'asc' },
            });
            return records.map((r) => ({
                configKey: r.configKey,
                updatedAt: r.updatedAt.toISOString(),
            }));
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[TenantConfigPostgresRepository] Error listing configs:', error);
            throw new Error(`Failed to list configs: ${msg}`);
        }
    }
}
