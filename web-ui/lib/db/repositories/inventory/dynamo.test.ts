import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
    QueryCommand: vi.fn().mockImplementation(function(input: unknown) { return { input }; }),
    PutCommand: vi.fn().mockImplementation(function(input: unknown) { return { input }; }),
    BatchWriteCommand: vi.fn().mockImplementation(function(input: unknown) { return { input }; }),
    DeleteCommand: vi.fn().mockImplementation(function(input: unknown) { return { input }; }),
    ScanCommand: vi.fn().mockImplementation(function(input: unknown) { return { input }; }),
}));

vi.mock('@/lib/aws-config', () => ({
    getDynamoDBDocumentClient: vi.fn(),
    APP_TABLE_NAME: 'test-app-table',
    DEFAULT_TENANT_ID: 'org-default',
}));

import { getDynamoDBDocumentClient } from '@/lib/aws-config';
import { InventoryDynamoRepository } from './dynamo';

const makeItem = (overrides: Record<string, unknown> = {}) => ({
    pk: 'TENANT#org-default#ACCOUNT#acc-1',
    sk: 'INVENTORY#ec2_instances#arn:aws:ec2:us-east-1:acc-1:instance/i-123',
    gsi1pk: 'TYPE#INVENTORY',
    gsi1sk: 'ec2_instances#us-east-1#my-instance',
    gsi3pk: 'RESOURCE_TYPE#ec2_instances',
    gsi3sk: 'acc-1#i-123',
    tenantId: 'org-default',
    accountId: 'acc-1',
    region: 'us-east-1',
    resourceType: 'ec2_instances',
    resourceId: 'i-123',
    name: 'my-instance',
    state: 'running',
    tags: { Env: 'prod' },
    Metadata: JSON.stringify({ instanceType: 't3.micro' }),
    lastDiscoveredAt: '2024-01-01T00:00:00Z',
    discoveryStatus: 'active',
    ...overrides,
});

describe('InventoryDynamoRepository', () => {
    let mockClient: { send: MockedFunction<any> };

    beforeEach(() => {
        mockClient = { send: vi.fn() };
        vi.mocked(getDynamoDBDocumentClient).mockResolvedValue(mockClient as any);
    });

    describe('listResources', () => {
        it('queries GSI1 when no accountId or resourceType filter', async () => {
            mockClient.send.mockResolvedValue({ Items: [makeItem()] });

            const repo = new InventoryDynamoRepository();
            const result = await repo.listResources({ tenantId: 'org-default' });

            expect(mockClient.send).toHaveBeenCalledOnce();
            expect(result.resources).toHaveLength(1);
            expect(result.total).toBe(1);
        });

        it('queries GSI3 when resourceType filter is provided', async () => {
            mockClient.send.mockResolvedValue({ Items: [makeItem()] });

            const repo = new InventoryDynamoRepository();
            await repo.listResources({ tenantId: 'org-default', resourceType: 'ec2_instances' });

            const callArg = mockClient.send.mock.calls[0][0];
            expect(callArg.input.IndexName).toBe('GSI3');
        });

        it('queries main table by pk when accountId filter is provided', async () => {
            mockClient.send.mockResolvedValue({ Items: [makeItem()] });

            const repo = new InventoryDynamoRepository();
            await repo.listResources({ tenantId: 'org-default', accountId: 'acc-1' });

            const callArg = mockClient.send.mock.calls[0][0];
            expect(callArg.input.IndexName).toBeUndefined();
            expect(callArg.input.ExpressionAttributeValues[':pk']).toBe(
                'TENANT#org-default#ACCOUNT#acc-1'
            );
        });

        it('filters by tenantId — cross-tenant isolation', async () => {
            mockClient.send.mockResolvedValue({
                Items: [
                    makeItem({ tenantId: 'org-default' }),
                    makeItem({ tenantId: 'other-tenant', accountId: 'acc-2' }),
                ],
            });

            const repo = new InventoryDynamoRepository();
            const result = await repo.listResources({ tenantId: 'org-default' });

            expect(result.resources.every((r) => r.tenantId === 'org-default')).toBe(true);
        });

        it('applies pagination with page and limit', async () => {
            const items = Array.from({ length: 10 }, (_, i) =>
                makeItem({ resourceId: `i-${i}`, gsi3sk: `acc-1#i-${i}` })
            );
            mockClient.send.mockResolvedValue({ Items: items });

            const repo = new InventoryDynamoRepository();
            const result = await repo.listResources({ tenantId: 'org-default', page: 2, limit: 3 });

            expect(result.resources).toHaveLength(3);
            expect(result.total).toBe(10);
        });

        it('filters by searchTerm on name', async () => {
            mockClient.send.mockResolvedValue({
                Items: [
                    makeItem({ name: 'prod-server' }),
                    makeItem({ name: 'dev-server', resourceId: 'i-456' }),
                ],
            });

            const repo = new InventoryDynamoRepository();
            const result = await repo.listResources({ tenantId: 'org-default', searchTerm: 'prod' });

            expect(result.resources).toHaveLength(1);
            expect(result.resources[0].name).toBe('prod-server');
        });
    });

    describe('getResource', () => {
        it('returns null when no items found', async () => {
            mockClient.send.mockResolvedValue({ Items: [] });

            const repo = new InventoryDynamoRepository();
            const result = await repo.getResource('org-default', 'acc-1', 'ec2_instances', 'i-999');

            expect(result).toBeNull();
        });

        it('returns resource when found', async () => {
            mockClient.send.mockResolvedValue({ Items: [makeItem()] });

            const repo = new InventoryDynamoRepository();
            const result = await repo.getResource('org-default', 'acc-1', 'ec2_instances', 'i-123');

            expect(result).not.toBeNull();
            expect(result!.resourceId).toBe('i-123');
        });
    });

    describe('upsertResource', () => {
        it('calls PutCommand and returns resource', async () => {
            mockClient.send.mockResolvedValue({});

            const repo = new InventoryDynamoRepository();
            const result = await repo.upsertResource({
                tenantId: 'org-default',
                accountId: 'acc-1',
                region: 'us-east-1',
                resourceType: 'ec2_instances',
                resourceId: 'i-123',
                name: 'my-instance',
                status: 'running',
                tags: {},
                metadata: {},
                discoveredAt: '2024-01-01T00:00:00Z',
                updatedAt: '2024-01-01T00:00:00Z',
            });

            expect(mockClient.send).toHaveBeenCalledOnce();
            expect(result.resourceId).toBe('i-123');
        });
    });

    describe('upsertBatch', () => {
        it('returns 0 for empty array', async () => {
            const repo = new InventoryDynamoRepository();
            const result = await repo.upsertBatch([]);
            expect(result).toBe(0);
            expect(mockClient.send).not.toHaveBeenCalled();
        });

        it('batches in chunks of 25 and returns total count', async () => {
            mockClient.send.mockResolvedValue({});

            const resources = Array.from({ length: 30 }, (_, i) => ({
                tenantId: 'org-default',
                accountId: 'acc-1',
                region: 'us-east-1',
                resourceType: 'ec2_instances',
                resourceId: `i-${i}`,
                tags: {},
                metadata: {},
                discoveredAt: '2024-01-01T00:00:00Z',
                updatedAt: '2024-01-01T00:00:00Z',
            }));

            const repo = new InventoryDynamoRepository();
            const result = await repo.upsertBatch(resources);

            expect(result).toBe(30);
            // 30 items → 2 batches (25 + 5)
            expect(mockClient.send).toHaveBeenCalledTimes(2);
        });
    });

    describe('getResourceCounts', () => {
        it('returns counts grouped by resourceType', async () => {
            mockClient.send.mockResolvedValue({
                Items: [
                    makeItem({ resourceType: 'ec2_instances' }),
                    makeItem({ resourceType: 'ec2_instances', resourceId: 'i-456' }),
                    makeItem({ resourceType: 'rds_instances', resourceId: 'db-1' }),
                ],
            });

            const repo = new InventoryDynamoRepository();
            const result = await repo.getResourceCounts('org-default');

            const ec2 = result.find((r) => r.resourceType === 'ec2_instances');
            const rds = result.find((r) => r.resourceType === 'rds_instances');
            expect(ec2?.count).toBe(2);
            expect(rds?.count).toBe(1);
        });

        it('cross-tenant isolation — excludes other tenant items', async () => {
            mockClient.send.mockResolvedValue({
                Items: [
                    makeItem({ tenantId: 'org-default', resourceType: 'ec2_instances' }),
                    makeItem({ tenantId: 'other-tenant', resourceType: 'ec2_instances', resourceId: 'i-999' }),
                ],
            });

            const repo = new InventoryDynamoRepository();
            const result = await repo.getResourceCounts('org-default');

            const ec2 = result.find((r) => r.resourceType === 'ec2_instances');
            expect(ec2?.count).toBe(1);
        });
    });

    describe('deleteResourcesByAccount', () => {
        it('returns 0 when no items found', async () => {
            mockClient.send.mockResolvedValue({ Items: [] });

            const repo = new InventoryDynamoRepository();
            const result = await repo.deleteResourcesByAccount('org-default', 'acc-1');

            expect(result).toBe(0);
        });

        it('batch deletes items and returns count', async () => {
            const items = Array.from({ length: 3 }, (_, i) => ({
                pk: `TENANT#org-default#ACCOUNT#acc-1`,
                sk: `INVENTORY#ec2_instances#arn:${i}`,
            }));
            mockClient.send
                .mockResolvedValueOnce({ Items: items }) // query
                .mockResolvedValue({}); // batch delete

            const repo = new InventoryDynamoRepository();
            const result = await repo.deleteResourcesByAccount('org-default', 'acc-1');

            expect(result).toBe(3);
        });
    });
});
