import { NextRequest, NextResponse } from 'next/server';
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

const dynamoClient = new DynamoDBClient({
    region: process.env.AWS_REGION || 'ap-south-1',
});

const APP_TABLE_NAME = process.env.APP_TABLE_NAME || 'nucleus-app-app-table';

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
            // Get specific account status
            const result = await dynamoClient.send(new QueryCommand({
                TableName: APP_TABLE_NAME,
                KeyConditionExpression: 'pk = :pk AND sk = :sk',
                ExpressionAttributeValues: {
                    ':pk': { S: `ACCOUNT#${accountId}` },
                    ':sk': { S: 'METADATA' },
                },
            }));

            if (result.Items && result.Items.length > 0) {
                const item = unmarshall(result.Items[0]);
                accounts.push({
                    accountId: item.account_id || accountId,
                    accountName: item.account_name || accountId,
                    lastSyncedAt: item.lastSyncedAt,
                    lastSyncStatus: item.lastSyncStatus || 'never',
                    lastSyncResourceCount: item.lastSyncResourceCount,
                    lastSyncDurationMs: item.lastSyncDurationMs,
                    syncEnabled: item.syncEnabled !== false,
                });
            }
        } else {
            // Get all accounts with sync status
            const result = await dynamoClient.send(new QueryCommand({
                TableName: APP_TABLE_NAME,
                IndexName: 'GSI1',
                KeyConditionExpression: 'gsi1pk = :pk',
                ExpressionAttributeValues: {
                    ':pk': { S: 'TYPE#ACCOUNT' },
                },
            }));

            accounts = (result.Items || []).map(item => {
                const acc = unmarshall(item);
                return {
                    accountId: acc.account_id,
                    accountName: acc.account_name || acc.account_id,
                    lastSyncedAt: acc.lastSyncedAt,
                    lastSyncStatus: acc.lastSyncStatus || 'never',
                    lastSyncResourceCount: acc.lastSyncResourceCount,
                    lastSyncDurationMs: acc.lastSyncDurationMs,
                    syncEnabled: acc.syncEnabled !== false,
                };
            });
        }

        // Count active accounts (those that are enabled)
        const activeAccountsCount = accounts.filter(a => a.syncEnabled).length;

        return NextResponse.json({
            // Latest sync summary for UI stats cards
            latestSync,
            totalResources: latestSync?.totalResources || 0,
            accountsSynced: latestSync?.accountsSynced || activeAccountsCount,
            lastSyncedAt: latestSync?.syncedAt || null,
            // Account details
            accounts,
            accountCount: accounts.length,
        });

    } catch (error: any) {
        console.error('Error fetching sync status:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to fetch sync status' },
            { status: 500 }
        );
    }
}
