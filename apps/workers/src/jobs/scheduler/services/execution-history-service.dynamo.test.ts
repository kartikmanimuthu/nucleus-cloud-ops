import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('../../../env.js', () => ({ env: {} }));
vi.mock('@aws-sdk/lib-dynamodb', () => ({
    PutCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
    QueryCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
    UpdateCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
}));
vi.mock('./dynamodb-service.js', () => ({
    getDynamoDBClient: vi.fn(() => ({ send: mockSend })),
    APP_TABLE_NAME: 'app-table',
}));
vi.mock('./pg-service.js', () => ({ getExecutionHistory: vi.fn() }));

import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
    createExecutionRecord,
    updateExecutionRecord,
    getExecutionHistory,
} from './execution-history-service.js';
import type { ExecutionRecord } from '../types/index.js';

beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
});

describe('createExecutionRecord (DynamoDB path)', () => {
    it('writes a PutCommand item keyed by tenant/schedule and returns the record', async () => {
        mockSend.mockResolvedValueOnce({});
        const record = await createExecutionRecord({
            scheduleId: 's1', scheduleName: 'Nightly', tenantId: 't1', accountId: 'a1', triggeredBy: 'system',
        });

        expect(record.status).toBe('running');
        const call = mockSend.mock.calls[0][0] as { input: any };
        expect(call.input.TableName).toBe('app-table');
        expect(call.input.Item.pk).toBe(`TENANT#t1#SCHEDULE#s1`);
        expect(call.input.Item.gsi1pk).toBe('TYPE#EXECUTION');
        expect(call.input.Item.executionId).toBe(record.executionId);
    });

    it('re-throws when the PutCommand fails', async () => {
        mockSend.mockRejectedValueOnce(new Error('ProvisionedThroughputExceeded'));
        await expect(createExecutionRecord({
            scheduleId: 's1', scheduleName: 'Nightly', tenantId: 't1', triggeredBy: 'system',
        })).rejects.toThrow('ProvisionedThroughputExceeded');
    });
});

function baseRecord(): ExecutionRecord {
    return {
        executionId: 'e1', scheduleId: 's1', scheduleName: 'Nightly', tenantId: 't1', accountId: 'a1',
        status: 'running', triggeredBy: 'system', startTime: new Date(0).toISOString(),
        resourcesStarted: 0, resourcesStopped: 0, resourcesFailed: 0, ttl: 0,
    };
}

describe('updateExecutionRecord (DynamoDB path)', () => {
    it('builds the minimal update expression when no optional fields are given', async () => {
        mockSend.mockResolvedValueOnce({});
        await updateExecutionRecord(baseRecord(), { status: 'success' });

        const call = mockSend.mock.calls[0][0] as { input: any };
        expect(call.input.UpdateExpression).toBe('set #status = :status, endTime = :endTime, #duration = :duration');
        expect(call.input.ExpressionAttributeValues[':status']).toBe('success');
        expect(call.input.Key).toEqual({ pk: 'TENANT#t1#SCHEDULE#s1', sk: `EXEC#${new Date(0).toISOString()}#e1` });
    });

    it('appends optional fields to the update expression when provided', async () => {
        mockSend.mockResolvedValueOnce({});
        await updateExecutionRecord(baseRecord(), {
            status: 'partial', resourcesStarted: 2, resourcesStopped: 1, resourcesFailed: 1,
            errorMessage: 'one resource failed', details: { note: 'x' },
            schedule_metadata: { ec2: [], ecs: [], rds: [], asg: [], docdb: [] },
        });

        const call = mockSend.mock.calls[0][0] as { input: any };
        expect(call.input.UpdateExpression).toContain('resourcesStarted = :resourcesStarted');
        expect(call.input.UpdateExpression).toContain('resourcesStopped = :resourcesStopped');
        expect(call.input.UpdateExpression).toContain('resourcesFailed = :resourcesFailed');
        expect(call.input.UpdateExpression).toContain('errorMessage = :errorMessage');
        expect(call.input.UpdateExpression).toContain('details = :details');
        expect(call.input.UpdateExpression).toContain('schedule_metadata = :schedule_metadata');
        expect(call.input.ExpressionAttributeValues[':resourcesFailed']).toBe(1);
    });

    it('omits errorMessage from the expression when it is an empty string', async () => {
        mockSend.mockResolvedValueOnce({});
        await updateExecutionRecord(baseRecord(), { status: 'success', errorMessage: '' });
        const call = mockSend.mock.calls[0][0] as { input: any };
        expect(call.input.UpdateExpression).not.toContain('errorMessage');
    });

    it('re-throws when the UpdateCommand fails', async () => {
        mockSend.mockRejectedValueOnce(new Error('ConditionalCheckFailed'));
        await expect(updateExecutionRecord(baseRecord(), { status: 'success' })).rejects.toThrow('ConditionalCheckFailed');
    });
});

describe('getExecutionHistory (DynamoDB path)', () => {
    it('queries by tenant/schedule prefix, newest first, and returns the items', async () => {
        const items = [{ executionId: 'e2' }, { executionId: 'e1' }];
        mockSend.mockResolvedValueOnce({ Items: items });

        const result = await getExecutionHistory('s1', 't1', 10);

        expect(result).toEqual(items);
        const call = mockSend.mock.calls[0][0] as { input: any };
        expect(call.input.ExpressionAttributeValues[':pk']).toBe('TENANT#t1#SCHEDULE#s1');
        expect(call.input.ExpressionAttributeValues[':skPrefix']).toBe('EXEC#');
        expect(call.input.ScanIndexForward).toBe(false);
        expect(call.input.Limit).toBe(10);
    });

    it('returns an empty array when the query throws', async () => {
        mockSend.mockRejectedValueOnce(new Error('unavailable'));
        expect(await getExecutionHistory('s1', 't1')).toEqual([]);
    });

    it('returns an empty array when the response has no Items', async () => {
        mockSend.mockResolvedValueOnce({});
        expect(await getExecutionHistory('s1', 't1')).toEqual([]);
    });
});
