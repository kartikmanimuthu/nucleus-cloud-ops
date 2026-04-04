import { NextRequest, NextResponse } from 'next/server';
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { getSessionTenantId } from '@/lib/auth-session';

const dynamoClient = new DynamoDBClient({
    region: process.env.AWS_REGION || 'ap-south-1',
});

const APP_TABLE_NAME = process.env.APP_TABLE_NAME || 'nucleus-app-app-table';
const INVENTORY_TABLE_NAME = process.env.INVENTORY_TABLE_NAME || 'nucleus-app-inventory-table';

/**
 * Single paginated pass over GSI1 to derive all three live stats:
 * - totalResources  : actual item count in inventory table
 * - accountsSynced  : number of distinct accountIds present
 * - lastDiscoveredAt: most recent lastDiscoveredAt timestamp
 */
async function getLiveStats(tenantId: string): Promise<{
    totalResources: number;
    accountsSynced: number;
    lastDiscoveredAt: string | null;
}> {
    let totalResources = 0;
    const accountIds = new Set<string>();
    let lastDiscoveredAt: string | null = null;
    let lastKey: Record<string, unknown> | undefined;

    do {
        const result = await dynamoClient.send(new QueryCommand({
            TableName: INVENTORY_TABLE_NAME,
            IndexName: 'GSI1',
            KeyConditionExpression: 'gsi1pk = :pk',
            ExpressionAttributeValues: {
                ':pk': { S: 'TYPE#INVENTORY' },
                ':tenantId': { S: tenantId },
            },
            FilterExpression: 'tenantId = :tenantId',
            ProjectionExpression: 'accountId, lastDiscoveredAt',
            ...(lastKey && { ExclusiveStartKey: lastKey }),
        }));

        totalResources += result.Count ?? 0;

        for (const item of result.Items ?? []) {
            const r = unmarshall(item);
            if (r.accountId) accountIds.add(r.accountId);
            if (r.lastDiscoveredAt && (!lastDiscoveredAt || r.lastDiscoveredAt > lastDiscoveredAt)) {
                lastDiscoveredAt = r.lastDiscoveredAt;
            }
        }

        lastKey = result.LastEvaluatedKey;
    } while (lastKey);

    return { totalResources, accountsSynced: accountIds.size, lastDiscoveredAt };
}

interface SyncStatus {
    scanId: string;
    totalResources: number;
    accountsSynced: number;
    syncedAt: string;
    status: string;
}

interface AccountSyncStatus {
    accountId: string;
    accountName: string;
    lastSyncedAt?: string;
    lastSyncStatus?: 'success' | 'failed' | 'running' | 'never';
    lastSyncResourceCount?: number;
    lastSyncDurationMs?: number;
    syncEnabled?: boolean;
}

/**
 * GET /api/inventory/status
 * Get inventory sync status including:
 * - Latest sync info (scanId, totalResources, accountsSynced, syncedAt)
 * - Account-level sync status (optional, by accountId param)
 * 
 * Schema:
 * Sync metadata: pk=SYNC#INVENTORY, sk=SCAN#{timestamp}#{uuid}
 */
export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const accountId = searchParams.get('accountId');
        const tenantId = await getSessionTenantId();

        // Get latest sync status from SYNC#INVENTORY entries
        const syncResult = await dynamoClient.send(new QueryCommand({
            TableName: APP_TABLE_NAME,
            KeyConditionExpression: 'pk = :pk',
            ExpressionAttributeValues: {
                ':pk': { S: 'SYNC#INVENTORY' },
            },
            ScanIndexForward: false, // Latest first
            Limit: 1,
        }));

        let latestSync: SyncStatus | null = null;
        if (syncResult.Items && syncResult.Items.length > 0) {
            const syncItem = unmarshall(syncResult.Items[0]);
            latestSync = {
                scanId: syncItem.scanId,
                totalResources: syncItem.totalResources || 0,
                accountsSynced: syncItem.accountsSynced || 0,
                syncedAt: syncItem.syncedAt,
                status: syncItem.status || 'completed',
            };
        }

        let accounts: AccountSyncStatus[] = [];

        if (accountId) {
            // Get specific account status — scope by tenant prefix
            const result = await dynamoClient.send(new QueryCommand({
                TableName: APP_TABLE_NAME,
                KeyConditionExpression: 'pk = :pk AND sk = :sk',
                ExpressionAttributeValues: {
                    ':pk': { S: `TENANT#${tenantId}#ACCOUNT#${accountId}` },
                    ':sk': { S: 'METADATA' },
                },
            }));

            if (result.Items && result.Items.length > 0) {
                const item = unmarshall(result.Items[0]);
                accounts.push({
                    accountId: item.accountId || accountId,
                    accountName: item.accountName || accountId,
                    lastSyncedAt: item.lastSyncedAt,
                    lastSyncStatus: item.lastSyncStatus || 'never',
                    lastSyncResourceCount: item.lastSyncResourceCount,
                    lastSyncDurationMs: item.lastSyncDurationMs,
                    syncEnabled: item.syncEnabled !== false,
                });
            }
        } else {
            // Get all accounts with sync status — scope by tenant
            const result = await dynamoClient.send(new QueryCommand({
                TableName: APP_TABLE_NAME,
                IndexName: 'GSI1',
                KeyConditionExpression: 'gsi1pk = :pk',
                ExpressionAttributeValues: {
                    ':pk': { S: `TYPE#ACCOUNT` },
                    ':tenantId': { S: tenantId },
                },
                FilterExpression: 'tenantId = :tenantId',
            }));

            accounts = (result.Items || []).map(item => {
                const acc = unmarshall(item);
                return {
                    accountId: acc.accountId,
                    accountName: acc.accountName || acc.accountId,
                    lastSyncedAt: acc.lastSyncedAt,
                    lastSyncStatus: acc.lastSyncStatus || 'never',
                    lastSyncResourceCount: acc.lastSyncResourceCount,
                    lastSyncDurationMs: acc.lastSyncDurationMs,
                    syncEnabled: acc.syncEnabled !== false,
                };
            });
        }

        const { totalResources, accountsSynced, lastDiscoveredAt } = await getLiveStats(tenantId);

        return NextResponse.json({
            latestSync,
            totalResources,
            accountsSynced,
            // Prefer explicit sync timestamp; fall back to most recent item discovery time
            lastSyncedAt: latestSync?.syncedAt || lastDiscoveredAt || null,
            accounts,
            accountCount: accounts.length,
        });

    } catch (error: unknown) {
        console.error('Error fetching sync status:', error);
        const message = error instanceof Error ? error.message : 'Failed to fetch sync status';
        return NextResponse.json(
            { error: message },
            { status: 500 }
        );
    }
}
