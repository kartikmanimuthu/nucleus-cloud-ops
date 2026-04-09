import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @aws-sdk/client-ecs before importing the executor
const mockSend = vi.fn();
vi.mock('@aws-sdk/client-ecs', () => ({
    ECSClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
    RunTaskCommand: vi.fn().mockImplementation((input: unknown) => ({ input, _type: 'RunTask' })),
    DescribeTasksCommand: vi.fn().mockImplementation((input: unknown) => ({ input, _type: 'DescribeTasks' })),
}));

import { HorizontalExecutor } from './horizontal.js';
import { RunTaskCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs';

const TASK_ARN = 'arn:aws:ecs:us-east-1:123456789012:task/cluster/abc123';

const RUN_TASK_SUCCESS = {
    tasks: [{ taskArn: TASK_ARN }],
    failures: [],
};

const DESCRIBE_RUNNING = {
    tasks: [{ taskArn: TASK_ARN, lastStatus: 'RUNNING', containers: [{ exitCode: undefined }] }],
};

const DESCRIBE_STOPPED_OK = {
    tasks: [{ taskArn: TASK_ARN, lastStatus: 'STOPPED', containers: [{ exitCode: 0 }] }],
};

const DESCRIBE_STOPPED_FAIL = {
    tasks: [{ taskArn: TASK_ARN, lastStatus: 'STOPPED', containers: [{ exitCode: 1 }], stoppedReason: 'OOM' }],
};

function setEnv() {
    process.env.HORIZONTAL_CLUSTER_ARN = 'arn:aws:ecs:us-east-1:123:cluster/nucleus';
    process.env.HORIZONTAL_TASK_DEF_ARN = 'arn:aws:ecs:us-east-1:123:task-definition/ephemeral:1';
    process.env.HORIZONTAL_SUBNETS = 'subnet-aaa,subnet-bbb';
    process.env.HORIZONTAL_SECURITY_GROUP = 'sg-xyz';
    process.env.HORIZONTAL_TASK_TIMEOUT_MS = '900000';
}

function clearEnv() {
    delete process.env.HORIZONTAL_CLUSTER_ARN;
    delete process.env.HORIZONTAL_TASK_DEF_ARN;
    delete process.env.HORIZONTAL_SUBNETS;
    delete process.env.HORIZONTAL_SECURITY_GROUP;
    delete process.env.HORIZONTAL_TASK_TIMEOUT_MS;
}

describe('HorizontalExecutor', () => {
    beforeEach(() => {
        setEnv();
        mockSend.mockReset();
        vi.clearAllMocks();
    });

    afterEach(() => {
        clearEnv();
        vi.useRealTimers();
    });

    // Test 1: RunTaskCommand called with correct ECS config from env vars
    it('calls RunTaskCommand with cluster, taskDef, subnets, securityGroup from env vars', async () => {
        const { RunTaskCommand } = await import('@aws-sdk/client-ecs');
        mockSend
            .mockResolvedValueOnce(RUN_TASK_SUCCESS)
            .mockResolvedValueOnce(DESCRIBE_STOPPED_OK);

        const executor = new HorizontalExecutor();
        await executor.execute('scheduler-scan', { tenantId: 't1' });

        expect(RunTaskCommand).toHaveBeenCalledWith(
            expect.objectContaining({
                cluster: 'arn:aws:ecs:us-east-1:123:cluster/nucleus',
                taskDefinition: 'arn:aws:ecs:us-east-1:123:task-definition/ephemeral:1',
                launchType: 'FARGATE',
                networkConfiguration: {
                    awsvpcConfiguration: {
                        subnets: ['subnet-aaa', 'subnet-bbb'],
                        securityGroups: ['sg-xyz'],
                        assignPublicIp: 'DISABLED',
                    },
                },
            })
        );
    });

    // Test 2: container command override passes job name and serialized data
    it('sets containerOverrides.command with job name and JSON-serialized data', async () => {
        const { RunTaskCommand } = await import('@aws-sdk/client-ecs');
        mockSend
            .mockResolvedValueOnce(RUN_TASK_SUCCESS)
            .mockResolvedValueOnce(DESCRIBE_STOPPED_OK);

        const executor = new HorizontalExecutor();
        const jobData = { tenantId: 'tenant-1', accountId: 'acc-2' };
        await executor.execute('discovery-scan', jobData);

        expect(RunTaskCommand).toHaveBeenCalledWith(
            expect.objectContaining({
                overrides: {
                    containerOverrides: [
                        {
                            name: 'WorkersContainer',
                            command: [
                                'node',
                                'dist/job-runner.js',
                                '--job',
                                'discovery-scan',
                                '--data',
                                JSON.stringify(jobData),
                            ],
                        },
                    ],
                },
            })
        );
    });

    // Test 3: polls DescribeTasks until STOPPED
    it('polls DescribeTasksCommand until task reaches STOPPED status', async () => {
        const { DescribeTasksCommand } = await import('@aws-sdk/client-ecs');
        mockSend
            .mockResolvedValueOnce(RUN_TASK_SUCCESS)   // RunTask
            .mockResolvedValueOnce(DESCRIBE_RUNNING)   // poll 1: RUNNING
            .mockResolvedValueOnce(DESCRIBE_RUNNING)   // poll 2: RUNNING
            .mockResolvedValueOnce(DESCRIBE_STOPPED_OK); // poll 3: STOPPED

        // Use short poll interval for test speed
        process.env.HORIZONTAL_POLL_INTERVAL_MS = '1';
        const executor = new HorizontalExecutor();
        await executor.execute('kb-sync', {});

        // DescribeTasks called 3 times (3 polls)
        const describeCalls = (mockSend.mock.calls as Array<[{ _type: string }]>).filter(
            ([cmd]) => cmd._type === 'DescribeTasks'
        );
        expect(describeCalls.length).toBe(3);

        expect(DescribeTasksCommand).toHaveBeenCalledWith(
            expect.objectContaining({
                cluster: 'arn:aws:ecs:us-east-1:123:cluster/nucleus',
                tasks: [TASK_ARN],
            })
        );
        delete process.env.HORIZONTAL_POLL_INTERVAL_MS;
    });

    // Test 4: exit code 0 → resolves successfully
    it('resolves when task exits with code 0', async () => {
        mockSend
            .mockResolvedValueOnce(RUN_TASK_SUCCESS)
            .mockResolvedValueOnce(DESCRIBE_STOPPED_OK);

        const executor = new HorizontalExecutor();
        await expect(executor.execute('scheduler-scan', {})).resolves.toBeUndefined();
    });

    // Test 5: exit code non-zero → throws with exit code and task ARN
    it('throws when task exits with non-zero exit code', async () => {
        mockSend
            .mockResolvedValueOnce(RUN_TASK_SUCCESS)
            .mockResolvedValueOnce(DESCRIBE_STOPPED_FAIL);

        const executor = new HorizontalExecutor();
        await expect(executor.execute('scheduler-scan', {})).rejects.toThrow(/exit code 1/i);
    });

    // Test 6: RunTask returns failures array → throws immediately, no polling
    it('throws immediately when RunTask returns failures without polling', async () => {
        const { DescribeTasksCommand } = await import('@aws-sdk/client-ecs');
        mockSend.mockResolvedValueOnce({
            tasks: [],
            failures: [{ arn: 'arn:...', reason: 'RESOURCE:CPU', detail: 'no capacity' }],
        });

        const executor = new HorizontalExecutor();
        await expect(executor.execute('scheduler-scan', {})).rejects.toThrow(/RESOURCE:CPU/i);

        expect(DescribeTasksCommand).not.toHaveBeenCalled();
    });

    // Test 6b: RunTask returns empty tasks array → throws immediately
    it('throws immediately when RunTask returns empty tasks array', async () => {
        mockSend.mockResolvedValueOnce({ tasks: [], failures: [] });

        const executor = new HorizontalExecutor();
        await expect(executor.execute('scheduler-scan', {})).rejects.toThrow(/no task launched/i);
    });

    // Test 7: polling exceeds HORIZONTAL_TASK_TIMEOUT_MS → throws timeout error
    it('throws timeout error when task exceeds HORIZONTAL_TASK_TIMEOUT_MS', async () => {
        // Use real timers with very short values to avoid fake-timer async ordering issues
        process.env.HORIZONTAL_TASK_TIMEOUT_MS = '80';
        process.env.HORIZONTAL_POLL_INTERVAL_MS = '10';

        mockSend
            .mockResolvedValueOnce(RUN_TASK_SUCCESS)
            .mockResolvedValue(DESCRIBE_RUNNING); // always RUNNING

        const executor = new HorizontalExecutor();
        await expect(executor.execute('scheduler-scan', {})).rejects.toThrow(/timed out/i);
        delete process.env.HORIZONTAL_POLL_INTERVAL_MS;
    }, 5000);

    // Test 8: missing required env vars → throws descriptive error
    it('throws descriptive error when HORIZONTAL_CLUSTER_ARN is missing', async () => {
        delete process.env.HORIZONTAL_CLUSTER_ARN;

        const executor = new HorizontalExecutor();
        await expect(executor.execute('scheduler-scan', {})).rejects.toThrow(
            /HORIZONTAL_CLUSTER_ARN/
        );
    });

    it('throws descriptive error when HORIZONTAL_TASK_DEF_ARN is missing', async () => {
        delete process.env.HORIZONTAL_TASK_DEF_ARN;

        const executor = new HorizontalExecutor();
        await expect(executor.execute('scheduler-scan', {})).rejects.toThrow(
            /HORIZONTAL_TASK_DEF_ARN/
        );
    });

    it('throws descriptive error when HORIZONTAL_SUBNETS is missing', async () => {
        delete process.env.HORIZONTAL_SUBNETS;

        const executor = new HorizontalExecutor();
        await expect(executor.execute('scheduler-scan', {})).rejects.toThrow(
            /HORIZONTAL_SUBNETS/
        );
    });

    it('throws descriptive error when HORIZONTAL_SECURITY_GROUP is missing', async () => {
        delete process.env.HORIZONTAL_SECURITY_GROUP;

        const executor = new HorizontalExecutor();
        await expect(executor.execute('scheduler-scan', {})).rejects.toThrow(
            /HORIZONTAL_SECURITY_GROUP/
        );
    });

    // Test 9: exponential backoff — polls multiple times with increasing intervals
    it('uses exponential backoff when polling — resolves after multiple RUNNING responses', async () => {
        mockSend
            .mockResolvedValueOnce(RUN_TASK_SUCCESS)
            .mockResolvedValueOnce(DESCRIBE_RUNNING)
            .mockResolvedValueOnce(DESCRIBE_RUNNING)
            .mockResolvedValueOnce(DESCRIBE_RUNNING)
            .mockResolvedValueOnce(DESCRIBE_STOPPED_OK);

        process.env.HORIZONTAL_POLL_INTERVAL_MS = '1';
        const executor = new HorizontalExecutor();
        await expect(executor.execute('kb-sync', {})).resolves.toBeUndefined();

        const describeCalls = (mockSend.mock.calls as Array<[{ _type: string }]>).filter(
            ([cmd]) => cmd._type === 'DescribeTasks'
        );
        expect(describeCalls.length).toBe(4);
        delete process.env.HORIZONTAL_POLL_INTERVAL_MS;
    });
});
