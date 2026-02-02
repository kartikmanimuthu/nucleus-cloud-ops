import { NextRequest, NextResponse } from 'next/server';
import { DynamoDBClient, QueryCommand, QueryCommandInput } from '@aws-sdk/client-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import * as XLSX from 'xlsx';

const dynamoClient = new DynamoDBClient({
    region: process.env.AWS_REGION || 'ap-south-1',
});

const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
});

const INVENTORY_TABLE_NAME = process.env.INVENTORY_TABLE_NAME || 'nucleus-app-inventory-table';
const INVENTORY_BUCKET = process.env.INVENTORY_BUCKET_NAME || '';

interface ExportParams {
    accountId?: string;
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
        const { accountId, resourceType, region, format = 'xlsx' } = body;

        if (!INVENTORY_BUCKET) {
            return NextResponse.json(
                { error: 'Inventory bucket not configured' },
                { status: 500 }
            );
        }

        // Build query to fetch resources
        let queryInput: QueryCommandInput;

        if (accountId) {
            queryInput = {
                TableName: INVENTORY_TABLE_NAME,
                KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk_prefix)',
                ExpressionAttributeValues: {
                    ':pk': { S: `ACCOUNT#${accountId}` },
                    ':sk_prefix': { S: 'RESOURCE#' },
                },
                FilterExpression: 'discoveryStatus = :active',
            };
            queryInput.ExpressionAttributeValues![':active'] = { S: 'active' };
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
                    ':pk': { S: 'TYPE#RESOURCE' },
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

        // Fetch all matching resources (with pagination)
        const resources: any[] = [];
        let lastEvaluatedKey: Record<string, any> | undefined;

        do {
            if (lastEvaluatedKey) {
                queryInput.ExclusiveStartKey = lastEvaluatedKey;
            }

            const result = await dynamoClient.send(new QueryCommand(queryInput));

            // Helper to get service name
            const getServiceName = (type: string): string => {
                const serviceMap: Record<string, string> = {
                    ec2_instances: "EC2",
                    rds_instances: "RDS",
                    ecs_services: "ECS",
                    asg_groups: "Auto Scaling",
                    dynamodb_tables: "DynamoDB",
                    docdb_instances: "DocumentDB",
                };
                return serviceMap[type] || type.replace(/_/g, " ").toUpperCase();
            };

            for (const item of result.Items || []) {
                const resource = unmarshall(item);
                resources.push({
                    'Resource ID': resource.resourceId,
                    'Name': resource.name,
                    'Service': getServiceName(resource.resourceType),
                    'Type': resource.resourceType,
                    'Region': resource.region,
                    'Account ID': resource.accountId,
                    'State': resource.state,
                    'ARN': resource.resourceArn,
                    'Last Discovered': resource.lastDiscoveredAt,
                    'Tags': resource.tags ? JSON.stringify(resource.tags) : '',
                });
            }

            lastEvaluatedKey = result.LastEvaluatedKey;
        } while (lastEvaluatedKey && resources.length < 10000); // Limit to 10k rows

        if (resources.length === 0) {
            return NextResponse.json(
                { error: 'No resources found matching the criteria' },
                { status: 404 }
            );
        }

        // Create Excel workbook
        const workbook = XLSX.utils.book_new();
        const worksheet = XLSX.utils.json_to_sheet(resources);
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Resources');

        // Generate buffer
        const buffer = XLSX.write(workbook, { type: 'buffer', bookType: format === 'csv' ? 'csv' : 'xlsx' });

        // Upload to S3
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `exports/inventory-${timestamp}.${format}`;

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
        });

    } catch (error: any) {
        console.error('Error exporting resources:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to export resources' },
            { status: 500 }
        );
    }
}
