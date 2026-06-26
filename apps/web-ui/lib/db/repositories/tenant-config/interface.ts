/**
 * ITenantConfigRepository
 *
 * Contract for tenant configuration persistence.
 * Implemented by TenantConfigDynamoRepository and TenantConfigPostgresRepository.
 * The repository-factory.ts reads USE_PG_TENANT_CONFIG and returns the active implementation.
 */
export interface ITenantConfigRepository {
    /**
     * Get a single config value by key.
     * Returns the parsed data payload, or null if not found.
     */
    getConfig<T = unknown>(configKey: string, tenantId: string): Promise<T | null>;

    /**
     * Save (upsert) a config value. Overwrites if key already exists.
     */
    saveConfig<T = unknown>(
        configKey: string,
        data: T,
        tenantId: string,
        updatedBy?: string
    ): Promise<void>;

    /**
     * Delete a config key. No-op if key does not exist.
     */
    deleteConfig(configKey: string, tenantId: string): Promise<void>;

    /**
     * List all config keys and their last-updated timestamps for a tenant.
     */
    listConfigs(tenantId: string): Promise<Array<{ configKey: string; updatedAt: string }>>;
}
