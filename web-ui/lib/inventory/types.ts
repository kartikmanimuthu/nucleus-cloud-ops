/**
 * Shared Resource type for inventory module.
 * Single source of truth — used by column-registry, resource-grid, and inventory page.
 */
export interface Resource {
    resourceId: string;
    resourceArn: string;
    resourceType: string;
    name: string;
    region: string;
    state: string;
    accountId: string;
    lastDiscoveredAt: string;
    tags: Record<string, string>;
    metadata?: Record<string, unknown>;
}
