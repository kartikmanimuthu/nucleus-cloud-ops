/**
 * Tenant Configuration Service
 *
 * Generic service for storing per-tenant configuration.
 * Delegates to the active repository implementation based on the
 * USE_PG_TENANT_CONFIG feature flag:
 *   - false (default): DynamoDB single-table via TenantConfigDynamoRepository
 *   - true:            PostgreSQL via TenantConfigPostgresRepository
 *
 * All callers use this static class — no changes needed at call sites.
 */

import { DEFAULT_TENANT_ID } from './aws-config';
import { getTenantConfigRepository } from './db/repository-factory';

export class TenantConfigService {
    /**
     * Get a configuration item by key.
     * Returns the parsed data payload, or null if not found.
     */
    static async getConfig<T = unknown>(
        configKey: string,
        tenantId: string = DEFAULT_TENANT_ID
    ): Promise<T | null> {
        return getTenantConfigRepository().getConfig<T>(configKey, tenantId);
    }

    /**
     * Save (put/overwrite) a configuration item.
     */
    static async saveConfig<T = unknown>(
        configKey: string,
        data: T,
        tenantId: string = DEFAULT_TENANT_ID,
        updatedBy = 'system'
    ): Promise<void> {
        return getTenantConfigRepository().saveConfig<T>(configKey, data, tenantId, updatedBy);
    }

    /**
     * Delete a configuration item (revert to defaults).
     */
    static async deleteConfig(
        configKey: string,
        tenantId: string = DEFAULT_TENANT_ID
    ): Promise<void> {
        return getTenantConfigRepository().deleteConfig(configKey, tenantId);
    }

    /**
     * List all config keys for a tenant.
     */
    static async listConfigs(
        tenantId: string = DEFAULT_TENANT_ID
    ): Promise<Array<{ configKey: string; updatedAt: string }>> {
        return getTenantConfigRepository().listConfigs(tenantId);
    }
}
