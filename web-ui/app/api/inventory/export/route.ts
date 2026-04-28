import { NextRequest, NextResponse } from 'next/server';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as XLSX from 'xlsx';
import { getExportColumnsForType, resolveExportValue } from '@/lib/inventory/export-column-map';
import { getSessionTenantId } from '@/lib/auth-session';
import { getTenantClient } from '@/lib/db/pg-config';

const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
});

const APP_BUCKET = process.env.APP_BUCKET_NAME || '';

interface ExportParams {
    accountId?: string;
    accountIds?: string[];
    resourceType?: string;
    region?: string;
    format?: 'xlsx' | 'csv';
}

const EXPORT_CAP = 10_000;

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

        if (!APP_BUCKET) {
            return NextResponse.json(
                { error: 'App bucket not configured' },
                { status: 500 }
            );
        }

        const tenantId = await getSessionTenantId();
        const client = getTenantClient(tenantId);

        // Build Prisma where clause
        const where: Record<string, unknown> = { tenantId };
        if (accountId) where.accountId = accountId;
        if (multiAccountIds?.length) where.accountId = { in: multiAccountIds };
        if (resourceType) where.resourceType = resourceType;
        if (region) where.region = region;

        // Fetch resources (capped at 10k)
        const rows = await client.inventoryResource.findMany({
            where,
            orderBy: { discoveredAt: 'desc' },
            take: EXPORT_CAP + 1,
        });

        const capped = rows.length > EXPORT_CAP;
        const rawResources = capped ? rows.slice(0, EXPORT_CAP) : rows;

        if (rawResources.length === 0) {
            return NextResponse.json(
                { error: 'No resources found matching the criteria' },
                { status: 404 }
            );
        }

        // Batch-fetch account names
        const accountNameMap: Record<string, string> = {};
        const distinctAccountIds = [...new Set(rawResources.map(r => r.accountId))];
        if (distinctAccountIds.length > 0) {
            try {
                const accounts = await client.account.findMany({
                    where: { tenantId, accountId: { in: distinctAccountIds } },
                    select: { accountId: true, name: true },
                });
                for (const a of accounts) {
                    if (a.name) accountNameMap[a.accountId] = a.name;
                }
            } catch (e) {
                console.warn('Could not fetch account names for export:', e);
            }
        }

        // Determine columns based on the resource type filter
        const exportColumns = getExportColumnsForType(resourceType ?? '_default');

        // Map Postgres rows to export-compatible objects and build spreadsheet rows
        const resources: Record<string, string>[] = rawResources.map(row => {
            const resource: Record<string, unknown> = {
                name: row.name,
                state: row.status,
                region: row.region,
                accountId: row.accountId,
                accountName: accountNameMap[row.accountId] || '',
                resourceType: row.resourceType,
                resourceId: row.resourceId,
                tags: row.tags,
                metadata: row.metadata,
                lastDiscoveredAt: row.discoveredAt?.toISOString(),
                resourceArn: (row.metadata as Record<string, unknown>)?.arn || '',
            };

            const exportRow: Record<string, string> = {};
            for (const col of exportColumns) {
                exportRow[col.label] = resolveExportValue(resource, col.accessor);
            }
            return exportRow;
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
        const fileName = `inventory-exports/tenants/${tenantId}/inventory-${timestamp}-${uuid}.${format}`;

        await s3Client.send(new PutObjectCommand({
            Bucket: APP_BUCKET,
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
                Bucket: APP_BUCKET,
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
