/**
 * InventoryDynamoRepository
 *
 * DynamoDB implementation of IInventoryRepository.
 * Reads/writes the inventory table using the existing DynamoDB schema.
 *
 * DynamoDB single-table access pattern:
 *   PK = TENANT#<tenantId>#ACCOUNT#<accountId>
 *   SK = INVENTORY#<resourceType>#<resourceArn>
 *   GSI1: gsi1pk = TYPE#INVENTORY (list all inventory)
 *   GSI2: gsi2pk = REGION#<region> (filter by region)
 *   GSI3: gsi3pk = RESOURCE_TYPE#<resourceType> (filter by type)
 */
import {
    QueryCommand,
    PutCommand,
    BatchWriteCommand,
    DeleteCommand,
    ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { getDynamoDBDocumentClient } from '@/lib/aws-config';
import type {
    IInventoryRepository,
    InventoryResource,
    InventoryFilters,
    InventoryPage,
    ResourceCount,
} from './interface';

const INVENTORY_TABLE_NAME =
    process.env.INVENTORY_TABLE_NAME || 'nucleus-app-inventory-table';

const buildPK = (tenantId: string, accountId: string) =>
    `TENANT#${tenantId}#ACCOUNT#${accountId}`;

const buildSK = (resourceType: string, resourceArn: string) =>
    `INVENTORY#${resourceType}#${resourceArn}`;

function transformItem(item: Record<string, unknown>): InventoryResource {
    const sk = (item.sk as string) || '';
    // SK format: INVENTORY#<resourceType>#<arn>
    const skParts = sk.replace('INVENTORY#', '').split('#');
    const resourceType = (item.resourceType as string) || skParts[0] || '';

    return {
        id: (item.resourceId as string) || '',
        tenantId: (item.tenantId as string) || '',
        accountId: (item.accountId as string) || '',
        region: (item.region as string) || '',
        resourceType,
        resourceId: (item.resourceId as string) || '',
        name: (item.name as string) || undefined,
        status: (item.state as string) || (item.status as string) || undefined,
        tags: (item.tags as Record<string, string>) || {},
        metadata: (item.Metadata
            ? (typeof item.Metadata === 'string'
                ? JSON.parse(item.Metadata)
                : item.Metadata)
            : {}) as Record<string, unknown>,
        discoveredAt: (item.lastDiscoveredAt as string) || new Date().toISOString(),
        updatedAt: (item.lastDiscoveredAt as string) || new Date().toISOString(),
    };
}

export class InventoryDynamoRepository implements IInventoryRepository {
    async listResources(filters: InventoryFilters): Promise<InventoryPage> {
        try {
            const {
                tenantId,
                accountId,
                region,
                resourceType,
                searchTerm,
                page = 1,
                limit = 50,
            } = filters;

            const client = await getDynamoDBDocumentClient();
            let items: Record<string, unknown>[] = [];

            if (resourceType) {
                // GSI3: query by resource type
                const params: Record<string, unknown> = {
                    TableName: INVENTORY_TABLE_NAME,
                    IndexName: 'GSI3',
                    KeyConditionExpression: 'gsi3pk = :pk',
                    ExpressionAttributeValues: {
                        ':pk': `RESOURCE_TYPE#${resourceType}`,
                    },
                };
                if (accountId) {
                    params.KeyConditionExpression =
                        'gsi3pk = :pk AND begins_with(gsi3sk, :acct)';
                    (params.ExpressionAttributeValues as Record<string, unknown>)[':acct'] =
                        accountId;
                }
                const resp = await client.send(new QueryCommand(params));
                items = (resp.Items || []) as Record<string, unknown>[];
            } else if (accountId) {
                // Main table: query by account
                const resp = await client.send(
                    new QueryCommand({
                        TableName: INVENTORY_TABLE_NAME,
                        KeyConditionExpression:
                            'pk = :pk AND begins_with(sk, :prefix)',
                        ExpressionAttributeValues: {
                            ':pk': buildPK(tenantId, accountId),
                            ':prefix': 'INVENTORY#',
                        },
                    })
                );
                items = (resp.Items || []) as Record<string, unknown>[];
            } else {
                // GSI1: all inventory for tenant
                const resp = await client.send(
                    new QueryCommand({
                        TableName: INVENTORY_TABLE_NAME,
                        IndexName: 'GSI1',
                        KeyConditionExpression: 'gsi1pk = :pk',
                        ExpressionAttributeValues: {
                            ':pk': 'TYPE#INVENTORY',
                        },
                    })
                );
                items = (resp.Items || []) as Record<string, unknown>[];
            }

            // Client-side filtering
            let filtered = items.filter(
                (i) => !i.tenantId || i.tenantId === tenantId
            );

            if (region) {
                filtered = filtered.filter((i) => i.region === region);
            }

            if (searchTerm) {
                const lower = searchTerm.toLowerCase();
                filtered = filtered.filter(
                    (i) =>
                        String(i.name || '').toLowerCase().includes(lower) ||
                        String(i.resourceId || '').toLowerCase().includes(lower)
                );
            }

            const total = filtered.length;
            const start = (page - 1) * limit;
            const paged = filtered.slice(start, start + limit);

            return {
                resources: paged.map(transformItem),
                total,
            };
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[InventoryDynamoRepository] Error in listResources:', error);
            throw new Error(`Failed to list resources: ${msg}`);
        }
    }

    async getResource(
        tenantId: string,
        accountId: string,
        resourceType: string,
        resourceId: string
    ): Promise<InventoryResource | null> {
        try {
            const client = await getDynamoDBDocumentClient();
            // Query GSI3 for the specific resource
            const resp = await client.send(
                new QueryCommand({
                    TableName: INVENTORY_TABLE_NAME,
                    IndexName: 'GSI3',
                    KeyConditionExpression:
                        'gsi3pk = :pk AND begins_with(gsi3sk, :sk)',
                    ExpressionAttributeValues: {
                        ':pk': `RESOURCE_TYPE#${resourceType}`,
                        ':sk': `${accountId}#${resourceId}`,
                    },
                })
            );
            const items = (resp.Items || []) as Record<string, unknown>[];
            const item = items.find(
                (i) => !i.tenantId || i.tenantId === tenantId
            );
            return item ? transformItem(item) : null;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[InventoryDynamoRepository] Error in getResource:', error);
            throw new Error(`Failed to get resource: ${msg}`);
        }
    }

    async upsertResource(
        resource: Omit<InventoryResource, 'id'>
    ): Promise<InventoryResource> {
        try {
            const client = await getDynamoDBDocumentClient();
            const now = new Date().toISOString();
            const resourceArn =
                `arn:aws:unknown:${resource.region}:${resource.accountId}:${resource.resourceType}/${resource.resourceId}`;

            const item = {
                pk: buildPK(resource.tenantId, resource.accountId),
                sk: buildSK(resource.resourceType, resourceArn),
                gsi1pk: 'TYPE#INVENTORY',
                gsi1sk: `${resource.resourceType}#${resource.region}#${resource.name || resource.resourceId}`,
                gsi2pk: `REGION#${resource.region}`,
                gsi2sk: `${resource.resourceType}#${now}`,
                gsi3pk: `RESOURCE_TYPE#${resource.resourceType}`,
                gsi3sk: `${resource.accountId}#${resource.resourceId}`,
                tenantId: resource.tenantId,
                accountId: resource.accountId,
                region: resource.region,
                resourceType: resource.resourceType,
                resourceId: resource.resourceId,
                name: resource.name,
                state: resource.status,
                tags: resource.tags,
                Metadata: JSON.stringify(resource.metadata),
                lastDiscoveredAt: resource.discoveredAt || now,
                discoveryStatus: 'active',
            };

            await client.send(
                new PutCommand({ TableName: INVENTORY_TABLE_NAME, Item: item })
            );

            return { ...resource, id: resource.resourceId };
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[InventoryDynamoRepository] Error in upsertResource:', error);
            throw new Error(`Failed to upsert resource: ${msg}`);
        }
    }

    async upsertBatch(
        resources: Omit<InventoryResource, 'id'>[]
    ): Promise<number> {
        if (!resources.length) return 0;

        try {
            const client = await getDynamoDBDocumentClient();
            const now = new Date().toISOString();
            let total = 0;

            const requests = resources.map((resource) => {
                const resourceArn =
                    `arn:aws:unknown:${resource.region}:${resource.accountId}:${resource.resourceType}/${resource.resourceId}`;
                return {
                    PutRequest: {
                        Item: {
                            pk: buildPK(resource.tenantId, resource.accountId),
                            sk: buildSK(resource.resourceType, resourceArn),
                            gsi1pk: 'TYPE#INVENTORY',
                            gsi1sk: `${resource.resourceType}#${resource.region}#${resource.name || resource.resourceId}`,
                            gsi2pk: `REGION#${resource.region}`,
                            gsi2sk: `${resource.resourceType}#${now}`,
                            gsi3pk: `RESOURCE_TYPE#${resource.resourceType}`,
                            gsi3sk: `${resource.accountId}#${resource.resourceId}`,
                            tenantId: resource.tenantId,
                            accountId: resource.accountId,
                            region: resource.region,
                            resourceType: resource.resourceType,
                            resourceId: resource.resourceId,
                            name: resource.name,
                            state: resource.status,
                            tags: resource.tags,
                            Metadata: JSON.stringify(resource.metadata),
                            lastDiscoveredAt: resource.discoveredAt || now,
                            discoveryStatus: 'active',
                        },
                    },
                };
            });

            // Batch write in chunks of 25
            for (let i = 0; i < requests.length; i += 25) {
                const batch = requests.slice(i, i + 25);
                await client.send(
                    new BatchWriteCommand({
                        RequestItems: { [INVENTORY_TABLE_NAME]: batch },
                    })
                );
                total += batch.length;
            }

            return total;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[InventoryDynamoRepository] Error in upsertBatch:', error);
            throw new Error(`Failed to batch upsert resources: ${msg}`);
        }
    }

    async getResourceCounts(tenantId: string): Promise<ResourceCount[]> {
        try {
            const client = await getDynamoDBDocumentClient();
            // Scan GSI1 and count in memory (DynamoDB limitation)
            const resp = await client.send(
                new QueryCommand({
                    TableName: INVENTORY_TABLE_NAME,
                    IndexName: 'GSI1',
                    KeyConditionExpression: 'gsi1pk = :pk',
                    ExpressionAttributeValues: { ':pk': 'TYPE#INVENTORY' },
                    ProjectionExpression: 'tenantId, resourceType',
                })
            );

            const items = (resp.Items || []) as Record<string, unknown>[];
            const counts: Record<string, number> = {};

            for (const item of items) {
                if (item.tenantId && item.tenantId !== tenantId) continue;
                const rt = (item.resourceType as string) || 'unknown';
                counts[rt] = (counts[rt] || 0) + 1;
            }

            return Object.entries(counts).map(([resourceType, count]) => ({
                resourceType,
                count,
            }));
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[InventoryDynamoRepository] Error in getResourceCounts:', error);
            throw new Error(`Failed to get resource counts: ${msg}`);
        }
    }

    async deleteResourcesByAccount(
        tenantId: string,
        accountId: string
    ): Promise<number> {
        try {
            const client = await getDynamoDBDocumentClient();
            const pk = buildPK(tenantId, accountId);

            const resp = await client.send(
                new QueryCommand({
                    TableName: INVENTORY_TABLE_NAME,
                    KeyConditionExpression:
                        'pk = :pk AND begins_with(sk, :prefix)',
                    ExpressionAttributeValues: {
                        ':pk': pk,
                        ':prefix': 'INVENTORY#',
                    },
                    ProjectionExpression: 'pk, sk',
                })
            );

            const items = resp.Items || [];
            if (!items.length) return 0;

            let deleted = 0;
            for (let i = 0; i < items.length; i += 25) {
                const batch = items.slice(i, i + 25).map((item) => ({
                    DeleteRequest: {
                        Key: { pk: item.pk, sk: item.sk },
                    },
                }));
                await client.send(
                    new BatchWriteCommand({
                        RequestItems: { [INVENTORY_TABLE_NAME]: batch },
                    })
                );
                deleted += batch.length;
            }

            return deleted;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[InventoryDynamoRepository] Error in deleteResourcesByAccount:', error);
            throw new Error(`Failed to delete resources: ${msg}`);
        }
    }
}
