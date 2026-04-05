import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const { mockSend } = vi.hoisted(() => ({
    mockSend: vi.fn(),
}));

vi.mock('@aws-sdk/lib-dynamodb', async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual,
        DynamoDBDocumentClient: {
            from: vi.fn().mockReturnValue({
                send: mockSend
            }),
        },
        QueryCommand: vi.fn().mockImplementation((input) => ({ input }))
    };
});

vi.mock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: vi.fn(),
}));

// Import after mocks are established
import { fetchActiveSchedules, fetchScheduleById } from './dynamodb-service.js';

describe('DynamoDB Service Logic Validation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockSend.mockReset();
    });

    it('should generate correct GSI3 query for active schedules', async () => {
        mockSend.mockResolvedValue({ Items: [{ scheduleId: 's1', name: 'N1' }] });

        const results = await fetchActiveSchedules();

        expect(mockSend).toHaveBeenCalled();
        const callArgs = mockSend.mock.calls[0][0].input;

        expect(callArgs.IndexName).toBe('GSI3');
        expect(callArgs.KeyConditionExpression).toBe('gsi3pk = :statusVal');
        expect(callArgs.ExpressionAttributeValues[':statusVal']).toBe('STATUS#active');
        expect(results).toHaveLength(1);
    });

    it('should generate correct GSI3 lookup for schedule by ID', async () => {
        mockSend
            .mockResolvedValueOnce({ Items: [] })
            .mockResolvedValueOnce({ Items: [{ scheduleId: 'sched-123', name: 'Found' }] });

        const result = await fetchScheduleById('sched-123');

        expect(mockSend).toHaveBeenCalledTimes(2);

        const secondCallArgs = mockSend.mock.calls[1][0].input;
        expect(secondCallArgs.IndexName).toBe('GSI3');
        expect(secondCallArgs.KeyConditionExpression).toContain('gsi3pk = :gsi3pk');
        expect(secondCallArgs.ExpressionAttributeValues[':gsi3pk']).toBe('STATUS#inactive');
        expect(secondCallArgs.ExpressionAttributeValues[':gsi3sk']).toBe('TENANT#default#SCHEDULE#sched-123');

        expect(result?.scheduleId).toBe('sched-123');
    });
});
