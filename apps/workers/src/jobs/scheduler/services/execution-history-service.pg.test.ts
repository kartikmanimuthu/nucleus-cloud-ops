import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../env.js', () => ({ env: { USE_PG_SCHEDULES: 'true' } }));
vi.mock('./dynamodb-service.js', () => ({ getDynamoDBClient: vi.fn(), APP_TABLE_NAME: 'app-table' }));
vi.mock('./pg-service.js', () => ({ getExecutionHistory: vi.fn() }));

import { getExecutionHistory as getExecutionHistoryPg } from './pg-service.js';
import { getDynamoDBClient } from './dynamodb-service.js';
import {
    createExecutionRecord,
    updateExecutionRecord,
    getExecutionHistory,
    getLastECSServiceState,
    getLastEC2InstanceState,
    getLastRDSInstanceState,
    getLastASGState,
} from './execution-history-service.js';
import type { ExecutionRecord } from '../types/index.js';

beforeEach(() => {
    vi.clearAllMocks();
    (getExecutionHistoryPg as any).mockReset();
});

describe('createExecutionRecord (USE_PG_SCHEDULES=true)', () => {
    it('returns a running record without touching DynamoDB', async () => {
        const record = await createExecutionRecord({
            scheduleId: 's1', scheduleName: 'Nightly', tenantId: 't1', accountId: 'a1', triggeredBy: 'system',
        });
        expect(record).toEqual(expect.objectContaining({
            scheduleId: 's1', scheduleName: 'Nightly', tenantId: 't1', accountId: 'a1',
            status: 'running', resourcesStarted: 0, resourcesStopped: 0, resourcesFailed: 0,
        }));
        expect(record.executionId).toBeTruthy();
        expect(getDynamoDBClient).not.toHaveBeenCalled();
    });

    it('reuses a pre-generated executionId when provided', async () => {
        const record = await createExecutionRecord({
            scheduleId: 's1', scheduleName: 'Nightly', tenantId: 't1', triggeredBy: 'web-ui', executionId: 'exec-fixed',
        });
        expect(record.executionId).toBe('exec-fixed');
        expect(record.accountId).toBe('unknown');
    });
});

describe('updateExecutionRecord (USE_PG_SCHEDULES=true)', () => {
    it('no-ops without touching DynamoDB', async () => {
        const record: ExecutionRecord = {
            executionId: 'e1', scheduleId: 's1', scheduleName: 'Nightly', tenantId: 't1', accountId: 'a1',
            status: 'running', triggeredBy: 'system', startTime: new Date().toISOString(),
            resourcesStarted: 0, resourcesStopped: 0, resourcesFailed: 0, ttl: 0,
        };
        await expect(updateExecutionRecord(record, { status: 'success' })).resolves.toBeUndefined();
        expect(getDynamoDBClient).not.toHaveBeenCalled();
    });
});

describe('getExecutionHistory (USE_PG_SCHEDULES=true)', () => {
    it('delegates to the PostgreSQL implementation with the default limit', async () => {
        (getExecutionHistoryPg as any).mockResolvedValue([]);
        await getExecutionHistory('s1', 't1');
        expect(getExecutionHistoryPg).toHaveBeenCalledWith('s1', 't1', 50);
    });

    it('passes through a custom limit', async () => {
        (getExecutionHistoryPg as any).mockResolvedValue([]);
        await getExecutionHistory('s1', 't1', 5);
        expect(getExecutionHistoryPg).toHaveBeenCalledWith('s1', 't1', 5);
    });
});

function execWith(metadata: Partial<ExecutionRecord['schedule_metadata']>): ExecutionRecord {
    return {
        executionId: 'e1', scheduleId: 's1', scheduleName: 'Nightly', tenantId: 't1', accountId: 'a1',
        status: 'success', triggeredBy: 'system', startTime: new Date().toISOString(),
        resourcesStarted: 0, resourcesStopped: 0, resourcesFailed: 0, ttl: 0,
        schedule_metadata: { ec2: [], ecs: [], rds: [], asg: [], docdb: [], ...metadata },
    };
}

describe('getLastECSServiceState', () => {
    const arn = 'arn:aws:ecs:us-east-1:123:service/c/svc';

    it('returns the last recorded desiredCount and asg_state from a successful stop', async () => {
        (getExecutionHistoryPg as any).mockResolvedValue([
            execWith({ ecs: [{ arn, resourceId: 'svc', clusterArn: 'c', action: 'stop', status: 'success', last_state: { desiredCount: 3, runningCount: 3, asg_state: [{ name: 'asg', minSize: 1, maxSize: 3, desiredCapacity: 2 }] } }] }),
        ]);
        const result = await getLastECSServiceState('s1', arn, 't1');
        expect(result).toEqual({ desiredCount: 3, asg_state: [{ name: 'asg', minSize: 1, maxSize: 3, desiredCapacity: 2 }] });
    });

    it('ignores a stop entry with desiredCount 0 and keeps searching', async () => {
        (getExecutionHistoryPg as any).mockResolvedValue([
            execWith({ ecs: [{ arn, resourceId: 'svc', clusterArn: 'c', action: 'stop', status: 'success', last_state: { desiredCount: 0, runningCount: 0 } }] }),
            execWith({ ecs: [{ arn, resourceId: 'svc', clusterArn: 'c', action: 'stop', status: 'success', last_state: { desiredCount: 4, runningCount: 4 } }] }),
        ]);
        const result = await getLastECSServiceState('s1', arn, 't1');
        expect(result).toEqual({ desiredCount: 4, asg_state: undefined });
    });

    it('ignores entries for a different ARN, a start action, or a failed status', async () => {
        (getExecutionHistoryPg as any).mockResolvedValue([
            execWith({ ecs: [{ arn: 'arn:other', resourceId: 'x', clusterArn: 'c', action: 'stop', status: 'success', last_state: { desiredCount: 5, runningCount: 5 } }] }),
            execWith({ ecs: [{ arn, resourceId: 'svc', clusterArn: 'c', action: 'start', status: 'success', last_state: { desiredCount: 5, runningCount: 5 } }] }),
            execWith({ ecs: [{ arn, resourceId: 'svc', clusterArn: 'c', action: 'stop', status: 'failed', error: 'x', last_state: { desiredCount: 5, runningCount: 5 } }] }),
        ]);
        expect(await getLastECSServiceState('s1', arn, 't1')).toBeNull();
    });

    it('returns null when no execution history exists', async () => {
        (getExecutionHistoryPg as any).mockResolvedValue([]);
        expect(await getLastECSServiceState('s1', arn, 't1')).toBeNull();
    });

    it('returns null when the history lookup throws', async () => {
        (getExecutionHistoryPg as any).mockRejectedValue(new Error('db down'));
        expect(await getLastECSServiceState('s1', arn, 't1')).toBeNull();
    });
});

describe('getLastEC2InstanceState', () => {
    const arn = 'arn:aws:ec2:us-east-1:123:instance/i-1';

    it('returns the last stopped state', async () => {
        (getExecutionHistoryPg as any).mockResolvedValue([
            execWith({ ec2: [{ arn, resourceId: 'i-1', action: 'stop', status: 'success', last_state: { instanceState: 'stopped', instanceType: 't3.micro' } }] }),
        ]);
        expect(await getLastEC2InstanceState('s1', arn, 't1')).toEqual({ instanceState: 'stopped', instanceType: 't3.micro' });
    });

    it('returns null when nothing matches', async () => {
        (getExecutionHistoryPg as any).mockResolvedValue([]);
        expect(await getLastEC2InstanceState('s1', arn, 't1')).toBeNull();
    });
});

describe('getLastRDSInstanceState', () => {
    const arn = 'arn:aws:rds:us-east-1:123:db:mydb';

    it('returns the last stopped state', async () => {
        (getExecutionHistoryPg as any).mockResolvedValue([
            execWith({ rds: [{ arn, resourceId: 'mydb', action: 'stop', status: 'success', last_state: { dbInstanceStatus: 'stopped', dbInstanceClass: 'db.t3.micro' } }] }),
        ]);
        expect(await getLastRDSInstanceState('s1', arn, 't1')).toEqual({ dbInstanceStatus: 'stopped', dbInstanceClass: 'db.t3.micro' });
    });

    it('returns null when nothing matches', async () => {
        (getExecutionHistoryPg as any).mockResolvedValue([]);
        expect(await getLastRDSInstanceState('s1', arn, 't1')).toBeNull();
    });
});

describe('getLastASGState', () => {
    const arn = 'arn:aws:autoscaling:us-east-1:123:autoScalingGroup:uuid:autoScalingGroupName/my-asg';

    it('returns the last stopped state when desiredCapacity was > 0', async () => {
        (getExecutionHistoryPg as any).mockResolvedValue([
            execWith({ asg: [{ arn, resourceId: 'my-asg', action: 'stop', status: 'success', last_state: { minSize: 1, maxSize: 3, desiredCapacity: 2 } }] }),
        ]);
        expect(await getLastASGState('s1', arn, 't1')).toEqual({ minSize: 1, maxSize: 3, desiredCapacity: 2 });
    });

    it('skips a stop entry whose desiredCapacity was already 0', async () => {
        (getExecutionHistoryPg as any).mockResolvedValue([
            execWith({ asg: [{ arn, resourceId: 'my-asg', action: 'stop', status: 'success', last_state: { minSize: 0, maxSize: 0, desiredCapacity: 0 } }] }),
        ]);
        expect(await getLastASGState('s1', arn, 't1')).toBeNull();
    });

    it('returns null when nothing matches', async () => {
        (getExecutionHistoryPg as any).mockResolvedValue([]);
        expect(await getLastASGState('s1', arn, 't1')).toBeNull();
    });
});
