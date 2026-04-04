import { NextRequest, NextResponse } from 'next/server';
import { DynamoDBClient, QueryCommand, QueryCommandInput, BatchGetItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import * as XLSX from 'xlsx';
import { getExportColumnsForType, resolveExportValue } from '@/lib/inventory/export-column-map';
import { getSessionTenantId } from '@/lib/auth-session';

const dynamoClient = new DynamoDBClient({
    region: process.env.AWS_REGION || 'ap-south-1',
});

const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
});

const INVENTORY_TABLE_NAME = process.env.INVENTORY_TABLE_NAME || 'nucleus-app-inventory-table';
const APP_TABLE_NAME = process.env.DYNAMODB_TABLE_NAME || 'nucleus-app-app-table';
const INVENTORY_BUCKET = process.env.INVENTORY_BUCKET_NAME || '';

interface ExportParams {
    accountId?: string;
    accountIds?: string[];
    resourceType?: string;
    region?: string;
    format?: 'xlsx' | 'csv';
}

/**
 * POST /api/inventory/export
 * Export discovered resources to Excel/CSV format
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json().catch(() => ({})) as ExportParams;
        const { accountId: singleAccountId, accountIds, resourceType, region, format = 'xlsx' } = body;

        // Normalize: single accountId or first of accountIds
        const accountId = singleAccountId || (accountIds?.length === 1 ? accountIds[0] : undefined);
        const multiAccountIds = !accountId && accountIds && accountIds.length > 1 ? accountIds : undefined;

        if (!INVENTORY_BUCKET) {
            return NextResponse.json(
                { error: 'Inventory bucket not configured' },
                { status: 500 }
            );
        }

        // Build query to fetch resources - using new inventory schema
        let queryInput: QueryCommandInput;
        const tenantId = await getSessionTenantId();

        if (accountId) {
            queryInput = {
                TableName: INVENTORY_TABLE_NAME,
                KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk_prefix)',
                ExpressionAttributeValues: {
                    ':pk': { S: `TENANT#${tenantId}#ACCOUNT#${accountId}` },
                    ':sk_prefix': { S: 'INVENTORY#' },
                    ':active': { S: 'active' },
                },
                FilterExpression: 'discoveryStatus = :active',
            };
        } else if (resourceType) {
            queryInput = {
                TableName: INVENTORY_TABLE_NAME,
                IndexName: 'GSI3',
                KeyConditionExpression: 'gsi3pk = :pk',
                ExpressionAttributeValues: {
                    ':pk': { S: `RESOURCE_TYPE#${resourceType}` },
                    ':active': { S: 'active' },
                },
                FilterExpression: 'discoveryStatus = :active',
            };
        } else {
            queryInput = {
                TableName: INVENTORY_TABLE_NAME,
                IndexName: 'GSI1',
                KeyConditionExpression: 'gsi1pk = :pk',
                ExpressionAttributeValues: {
                    ':pk': { S: 'TYPE#INVENTORY' },
                    ':active': { S: 'active' },
                },
                FilterExpression: 'discoveryStatus = :active',
            };
        }

        // Add region filter if provided
        if (region) {
            queryInput.FilterExpression = `${queryInput.FilterExpression} AND #region = :region`;
            queryInput.ExpressionAttributeValues![':region'] = { S: region };
            queryInput.ExpressionAttributeNames = { '#region': 'region' };
        }

        // Add multi-account filter if provided
        if (multiAccountIds?.length) {
            const orClauses = multiAccountIds.map((_, i) => `accountId = :aid${i}`);
            queryInput.FilterExpression = `${queryInput.FilterExpression} AND (${orClauses.join(' OR ')})`;
            multiAccountIds.forEach((id, i) => { queryInput.ExpressionAttributeValues![`:aid${i}`] = { S: id }; });
        }

        // Determine columns based on the resource type filter
        const exportColumns = getExportColumnsForType(resourceType ?? '_default');

        // Fetch all matching resources (with pagination) — collect raw objects first
        const rawResources: Record<string, unknown>[] = [];
        let lastEvaluatedKey: Record<string, unknown> | undefined;

        do {
            if (lastEvaluatedKey) {
                queryInput.ExclusiveStartKey = lastEvaluatedKey;
            }

            const result = await dynamoClient.send(new QueryCommand(queryInput));

            for (const item of result.Items || []) {
                const resource = unmarshall(item) as Record<string, unknown>;
                // Metadata is stored as a JSON string in DynamoDB — parse it so dot-path resolution works
                if (typeof resource.Metadata === 'string') {
                    try { resource.metadata = JSON.parse(resource.Metadata); } catch { resource.metadata = {}; }
                } else if (resource.Metadata && typeof resource.Metadata === 'object') {
                    resource.metadata = resource.Metadata;
                }
                rawResources.push(resource);
            }

            lastEvaluatedKey = result.LastEvaluatedKey;
        } while (lastEvaluatedKey && rawResources.length < 10000); // Cap at 10k rows

        const capped = !!lastEvaluatedKey && rawResources.length >= 10000;

        if (rawResources.length === 0) {
            return NextResponse.json(
                { error: 'No resources found matching the criteria' },
                { status: 404 }
            );
        }

        // Batch-fetch account names from the app table
        const accountNameMap: Record<string, string> = {};
        const distinctAccountIds = [...new Set(rawResources.map(r => r.accountId as string).filter(Boolean))];
        if (distinctAccountIds.length > 0) {
            try {
                const appTenantId = tenantId;
                const keys = distinctAccountIds.map(id => ({
                    pk: { S: `TENANT#${appTenantId}` },
                    sk: { S: `ACCOUNT#${id}` },
                }));
                for (let i = 0; i < keys.length; i += 100) {
                    const batch = keys.slice(i, i + 100);
                    const batchResult = await dynamoClient.send(new BatchGetItemCommand({
                        RequestItems: {
                            [APP_TABLE_NAME]: {
                                Keys: batch,
                                ProjectionExpression: 'pk, sk, accountId, accountName',
                            },
                        },
                    }));
                    for (const item of batchResult.Responses?.[APP_TABLE_NAME] || []) {
                        const row = unmarshall(item);
                        const id = (row.accountId as string) || (row.sk as string)?.split('#')[1];
                        if (id && row.accountName) accountNameMap[id] = row.accountName as string;
                    }
                }
            } catch (e) {
                console.warn('Could not fetch account names for export:', e);
            }
        }

        // Inject accountName into each resource and build export rows
        const resources: Record<string, string>[] = rawResources.map(resource => {
            if (accountNameMap[resource.accountId as string]) {
                resource.accountName = accountNameMap[resource.accountId as string];
            }
            const row: Record<string, string> = {};
            for (const col of exportColumns) {
                row[col.label] = resolveExportValue(resource, col.accessor);
            }
            return row;
        });

        // Create Excel workbook
        const workbook = XLSX.utils.book_new();
        const worksheet = XLSX.utils.json_to_sheet(resources);
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Resources');

        // Generate buffer
        const buffer = XLSX.write(workbook, { type: 'buffer', bookType: format === 'csv' ? 'csv' : 'xlsx' });

        // Upload to S3
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const uuid = crypto.randomUUID();
        const fileName = `exports/inventory-${timestamp}-${uuid}.${format}`;

        await s3Client.send(new PutObjectCommand({
            Bucket: INVENTORY_BUCKET,
            Key: fileName,
            Body: buffer,
            ContentType: format === 'csv'
                ? 'text/csv'
                : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }));

        // Generate pre-signed URL (valid for 1 hour)
        const downloadUrl = await getSignedUrl(
            s3Client,
            new GetObjectCommand({
                Bucket: INVENTORY_BUCKET,
                Key: fileName,
            }),
            { expiresIn: 3600 }
        );

        return NextResponse.json({
            success: true,
            fileName,
            resourceCount: resources.length,
            downloadUrl,
            expiresIn: '1 hour',
            ...(capped && { capped: true, warning: 'Export limited to 10,000 resources. Apply filters to narrow results.' }),
        });

    } catch (error) {
        console.error('Error exporting resources:', error);
        const message = error instanceof Error ? error.message : 'Failed to export resources';
        return NextResponse.json(
            { error: message },
            { status: 500 }
        );
    }
}
