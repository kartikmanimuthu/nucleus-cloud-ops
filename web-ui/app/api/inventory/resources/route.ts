import { NextRequest, NextResponse } from 'next/server';
import { DynamoDBClient, QueryCommand, QueryCommandInput, BatchGetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

const dynamoClient = new DynamoDBClient({
    region: process.env.AWS_REGION || 'ap-south-1',
});

const INVENTORY_TABLE_NAME = process.env.INVENTORY_TABLE_NAME || 'nucleus-app-inventory-table';
const APP_TABLE_NAME = process.env.DYNAMODB_TABLE_NAME || 'nucleus-app-app-table';

export interface InventoryResource {
    pk: string;
    sk: string;
    resourceId: string;
    resourceArn: string;
    resourceType: string;
    name: string;
    region: string;
    state: string;
    accountId: string;
    lastDiscoveredAt: string;
    discoveryStatus: string;
    discoveryScanId?: string;
    tenantId?: string;
    tags?: Record<string, string>;
    Metadata?: Record<string, unknown>;
    RawMetadata?: Record<string, unknown>;
}

export interface ListResourcesParams {
    accountId?: string;
    accountIds?: string[];
    resourceType?: string;
    region?: string;
    state?: string;
    search?: string;
    limit?: number;
    lastEvaluatedKey?: string;
}

/**
 * GET /api/inventory/resources
 * List discovered resources with pagination and filtering
 * 
 * New Schema:
 * - pk: TENANT#{tenantId}#ACCOUNT#{accountId}
 * - sk: INVENTORY#{resourceType}#{resourceArn}
 * - GSI1: gsi1pk=TYPE#INVENTORY, gsi1sk={resourceType}#{region}#{name}
 * - GSI2: gsi2pk=REGION#{region}, gsi2sk={resourceType}#{timestamp}
 * - GSI3: gsi3pk=RESOURCE_TYPE#{resourceType}, gsi3sk={accountId}#{resourceId}
 */
export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);

        const params: ListResourcesParams = {
            accountId: searchParams.get('accountId') || undefined,
            accountIds: searchParams.get('accountIds')?.split(',').filter(Boolean) || undefined,
            resourceType: searchParams.get('resourceType') || undefined,
            region: searchParams.get('region') || undefined,
            state: searchParams.get('state') || undefined,
            search: searchParams.get('search') || undefined,
            limit: parseInt(searchParams.get('limit') || '50', 10),
            lastEvaluatedKey: searchParams.get('cursor') || undefined,
        };

        // Normalize: if accountIds has exactly one entry, treat as accountId for index optimization
        if (params.accountIds?.length === 1) {
            params.accountId = params.accountIds[0];
            params.accountIds = undefined;
        }

        let queryInput: QueryCommandInput;
        const filterExpression: string[] = [];
        const expressionAttributeValues: Record<string, unknown> = {};
        const expressionAttributeNames: Record<string, string> = {};

        // Default tenant ID (multi-tenant ready)
        const tenantId = 'default';

        // Build query based on filters - prioritize most selective index
        // Then apply remaining filters as FilterExpressions
        if (params.resourceType) {
            // Query by resource type (GSI3): RESOURCE_TYPE#{resourceType}
            queryInput = {
                TableName: INVENTORY_TABLE_NAME,
                IndexName: 'GSI3',
                KeyConditionExpression: 'gsi3pk = :pk',
                ExpressionAttributeValues: {
                    ':pk': { S: `RESOURCE_TYPE#${params.resourceType}` },
                },
                Limit: params.limit,
            };

            // Add accountId filter as key condition if provided
            if (params.accountId) {
                queryInput.KeyConditionExpression += ' AND begins_with(gsi3sk, :accountPrefix)';
                queryInput.ExpressionAttributeValues![':accountPrefix'] = { S: params.accountId };
            } else if (params.accountIds?.length) {
                // Multi-account: use OR filter expression
                const orClauses = params.accountIds.map((_, i) => `accountId = :aid${i}`);
                filterExpression.push(`(${orClauses.join(' OR ')})`);
                params.accountIds.forEach((id, i) => { expressionAttributeValues[`:aid${i}`] = { S: id }; });
            }

            // Add region as filter expression if provided
            if (params.region) {
                filterExpression.push('#region = :region');
                expressionAttributeValues[':region'] = { S: params.region };
                expressionAttributeNames['#region'] = 'region';
            }
        } else if (params.region) {
            // Query by region (GSI2): REGION#{region}
            queryInput = {
                TableName: INVENTORY_TABLE_NAME,
                IndexName: 'GSI2',
                KeyConditionExpression: 'gsi2pk = :pk',
                ExpressionAttributeValues: {
                    ':pk': { S: `REGION#${params.region}` },
                },
                Limit: params.limit,
            };

            // Add accountId filter if provided
            if (params.accountId) {
                filterExpression.push('accountId = :accountId');
                expressionAttributeValues[':accountId'] = { S: params.accountId };
            } else if (params.accountIds?.length) {
                const orClauses = params.accountIds.map((_, i) => `accountId = :aid${i}`);
                filterExpression.push(`(${orClauses.join(' OR ')})`);
                params.accountIds.forEach((id, i) => { expressionAttributeValues[`:aid${i}`] = { S: id }; });
            }
        } else if (params.accountId) {
            // Query by account (Main Table): TENANT#{tenantId}#ACCOUNT#{accountId}
            queryInput = {
                TableName: INVENTORY_TABLE_NAME,
                KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk_prefix)',
                ExpressionAttributeValues: {
                    ':pk': { S: `TENANT#${tenantId}#ACCOUNT#${params.accountId}` },
                    ':sk_prefix': { S: 'INVENTORY#' },
                },
                Limit: params.limit,
            };
        } else {
            // Query all resources (GSI1): TYPE#INVENTORY
            queryInput = {
                TableName: INVENTORY_TABLE_NAME,
                IndexName: 'GSI1',
                KeyConditionExpression: 'gsi1pk = :pk',
                ExpressionAttributeValues: {
                    ':pk': { S: 'TYPE#INVENTORY' },
                },
                Limit: params.limit,
            };
            // Multi-account filter on the all-resources path
            if (params.accountIds?.length) {
                const orClauses = params.accountIds.map((_, i) => `accountId = :aid${i}`);
                filterExpression.push(`(${orClauses.join(' OR ')})`);
                params.accountIds.forEach((id, i) => { expressionAttributeValues[`:aid${i}`] = { S: id }; });
            }
        }

        // Add filter for state if provided
        if (params.state) {
            filterExpression.push('#state = :state');
            expressionAttributeValues[':state'] = { S: params.state };
            expressionAttributeNames['#state'] = 'state';
        }

        // Add filter for search if provided
        if (params.search) {
            filterExpression.push('(contains(#name, :search) OR contains(resourceId, :search))');
            expressionAttributeValues[':search'] = { S: params.search };
            expressionAttributeNames['#name'] = 'name';
        }

        // Add filter for discoveryStatus = 'active' by default
        filterExpression.push('discoveryStatus = :activeStatus');
        expressionAttributeValues[':activeStatus'] = { S: 'active' };

        if (filterExpression.length > 0) {
            queryInput.FilterExpression = filterExpression.join(' AND ');
            queryInput.ExpressionAttributeValues = {
                ...queryInput.ExpressionAttributeValues,
                ...expressionAttributeValues,
            };
            if (Object.keys(expressionAttributeNames).length > 0) {
                queryInput.ExpressionAttributeNames = expressionAttributeNames;
            }
        }

        // Handle pagination cursor
        if (params.lastEvaluatedKey) {
            try {
                queryInput.ExclusiveStartKey = JSON.parse(
                    Buffer.from(params.lastEvaluatedKey, 'base64').toString('utf-8')
                );
            } catch {
                // Ignore invalid cursor
            }
        }

        const result = await dynamoClient.send(new QueryCommand(queryInput));

        const resources = (result.Items || []).map(item => {
            const resource = unmarshall(item) as InventoryResource;

            // Parse Metadata if it exists
            let metadata = {};
            if (resource.Metadata) {
                try {
                    metadata = typeof resource.Metadata === 'string'
                        ? JSON.parse(resource.Metadata)
                        : resource.Metadata;
                } catch (e) {
                    console.error(`Failed to parse Metadata for resource ${resource.resourceId}:`, e);
                }
            }

            return {
                resourceId: resource.resourceId,
                resourceArn: resource.resourceArn,
                resourceType: resource.resourceType,
                name: resource.name,
                region: resource.region,
                state: resource.state,
                accountId: resource.accountId,
                lastDiscoveredAt: resource.lastDiscoveredAt,
                discoveryScanId: resource.discoveryScanId,
                tags: resource.tags || {},
                metadata,
            };
        });

        // Collect distinct account IDs from results
        const accountIds = [...new Set(resources.map(r => r.accountId).filter(Boolean))];

        // Batch fetch account names from app table
        const accountNameMap: Record<string, string> = {};
        if (accountIds.length > 0) {
            try {
                const tenantId = process.env.DEFAULT_TENANT_ID || 'org-default';
                const keys = accountIds.map(id => ({
                    pk: { S: `TENANT#${tenantId}` },
                    sk: { S: `ACCOUNT#${id}` },
                }));
                // DynamoDB BatchGetItem max 100 keys
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
                    const items = batchResult.Responses?.[APP_TABLE_NAME] || [];
                    for (const item of items) {
                        const unmarshalledItem = unmarshall(item);
                        // accountId is a top-level field; sk = ACCOUNT#<accountId>
                        const accountId = (unmarshalledItem.accountId as string)
                            || (unmarshalledItem.sk as string)?.split('#')[1];
                        if (accountId && unmarshalledItem.accountName) {
                            accountNameMap[accountId] = unmarshalledItem.accountName as string;
                        }
                    }
                }
            } catch (e) {
                // Account name lookup is non-critical — log and continue
                console.warn('Could not fetch account names:', e);
            }
        }

        // Attach account names to resources
        const resourcesWithAccountNames = resources.map(r => ({
            ...r,
            accountName: accountNameMap[r.accountId],
        }));

        // Build pagination cursor
        let nextCursor: string | undefined;
        if (result.LastEvaluatedKey) {
            nextCursor = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
        }

        return NextResponse.json({
            resources: resourcesWithAccountNames,
            count: resourcesWithAccountNames.length,
            nextCursor,
            hasMore: !!result.LastEvaluatedKey,
        });

    } catch (error: unknown) {
        console.error('Error fetching inventory resources:', error);
        const message = error instanceof Error ? error.message : 'Failed to fetch resources';
        return NextResponse.json(
            { error: message },
            { status: 500 }
        );
    }
}
