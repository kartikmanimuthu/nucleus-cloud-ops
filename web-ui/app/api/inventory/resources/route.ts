import { NextRequest, NextResponse } from 'next/server';
import { DynamoDBClient, QueryCommand, QueryCommandInput } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

const dynamoClient = new DynamoDBClient({
    region: process.env.AWS_REGION || 'ap-south-1',
});

const INVENTORY_TABLE_NAME = process.env.INVENTORY_TABLE_NAME || 'nucleus-app-inventory-table';

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
    Metadata?: Record<string, any>;
    RawMetadata?: Record<string, any>;
}

export interface ListResourcesParams {
    accountId?: string;
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
            resourceType: searchParams.get('resourceType') || undefined,
            region: searchParams.get('region') || undefined,
            state: searchParams.get('state') || undefined,
            search: searchParams.get('search') || undefined,
            limit: parseInt(searchParams.get('limit') || '50', 10),
            lastEvaluatedKey: searchParams.get('cursor') || undefined,
        };

        let queryInput: QueryCommandInput;
        let filterExpression: string[] = [];
        let expressionAttributeValues: Record<string, any> = {};
        let expressionAttributeNames: Record<string, string> = {};

        // Default tenant ID (multi-tenant ready)
        const tenantId = 'default';

        // Build query based on filters
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

            // Add accountId filter if provided
            if (params.accountId) {
                queryInput.KeyConditionExpression += ' AND begins_with(gsi3sk, :accountPrefix)';
                queryInput.ExpressionAttributeValues![':accountPrefix'] = { S: params.accountId };
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
                } catch {
                    // Ignore parse errors
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

        // Build pagination cursor
        let nextCursor: string | undefined;
        if (result.LastEvaluatedKey) {
            nextCursor = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
        }

        return NextResponse.json({
            resources,
            count: resources.length,
            nextCursor,
            hasMore: !!result.LastEvaluatedKey,
        });

    } catch (error: any) {
        console.error('Error fetching inventory resources:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to fetch resources' },
            { status: 500 }
        );
    }
}
