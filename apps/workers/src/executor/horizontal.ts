import { ECSClient, RunTaskCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs';
import { createLogger } from '../lib/logger.js';
import { env } from '../env.js';
import type { JobExecutor } from './types.js';

const log = createLogger('horizontal-executor');

const INITIAL_POLL_INTERVAL_MS = 2000;
const MAX_POLL_INTERVAL_MS = 30000;
const DEFAULT_TIMEOUT_MS = 900000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRequiredEnv(name: string): string {
    const val = process.env[name];
    if (!val) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return val;
}

export class HorizontalExecutor implements JobExecutor {
    async execute(jobName: string, jobData: unknown): Promise<void> {
        try {
            return await this.run(jobName, jobData);
        } catch (err) {
            // pg-boss records handler rejections to the job table but does not emit
            // the 'error' event — without this, failures are invisible in the logs.
            log.error('Job execution failed', {
                jobName,
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
            });
            throw err;
        }
    }

    private async run(jobName: string, jobData: unknown): Promise<void> {
        // Read and validate config at execute time so missing vars produce clear errors
        const clusterArn = getRequiredEnv('HORIZONTAL_CLUSTER_ARN');
        const taskDefArn = getRequiredEnv('HORIZONTAL_TASK_DEF_ARN');
        const subnetsRaw = getRequiredEnv('HORIZONTAL_SUBNETS');
        const securityGroup = getRequiredEnv('HORIZONTAL_SECURITY_GROUP');
        const timeoutMs = parseInt(env.HORIZONTAL_TASK_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS), 10);
        const initialPollMs = parseInt(env.HORIZONTAL_POLL_INTERVAL_MS ?? String(INITIAL_POLL_INTERVAL_MS), 10);

        const subnets = subnetsRaw.split(',').map((s) => s.trim()).filter(Boolean);
        const ecsClient = new ECSClient({});

        log.info('Dispatching job to ECS Fargate', { jobName });

        // Launch ephemeral task
        const runResult = await ecsClient.send(
            new RunTaskCommand({
                cluster: clusterArn,
                taskDefinition: taskDefArn,
                launchType: 'FARGATE',
                networkConfiguration: {
                    awsvpcConfiguration: {
                        subnets,
                        securityGroups: [securityGroup],
                        assignPublicIp: 'DISABLED',
                    },
                },
                overrides: {
                    containerOverrides: [
                        {
                            name: 'WorkersContainer',
                            command: [
                                'node',
                                'dist/job-runner.js',
                                '--job',
                                jobName,
                                '--data',
                                JSON.stringify(jobData),
                            ],
                        },
                    ],
                },
            })
        );

        // Fail fast if ECS rejected the launch
        if (runResult.failures && runResult.failures.length > 0) {
            const reason = runResult.failures.map((f) => f.reason ?? 'unknown').join(', ');
            throw new Error(`ECS RunTask failed: ${reason}`);
        }

        if (!runResult.tasks || runResult.tasks.length === 0) {
            throw new Error('ECS RunTask returned no task launched');
        }

        const taskArn = runResult.tasks[0].taskArn!;
        log.info('ECS task launched', { jobName, taskArn });

        // Poll until STOPPED with exponential backoff
        const startTime = Date.now();
        let pollInterval = initialPollMs;

        while (true) {
            await sleep(pollInterval);

            if (Date.now() - startTime > timeoutMs) {
                throw new Error(
                    `HorizontalExecutor timed out waiting for task ${taskArn} after ${timeoutMs}ms`
                );
            }

            const describeResult = await ecsClient.send(
                new DescribeTasksCommand({
                    cluster: clusterArn,
                    tasks: [taskArn],
                })
            );

            const task = describeResult.tasks?.[0];
            if (!task) {
                continue;
            }

            if (task.lastStatus === 'STOPPED') {
                const exitCode = task.containers?.[0]?.exitCode;
                if (exitCode === 0) {
                    log.info('ECS task completed successfully', { jobName, taskArn });
                    return;
                }
                const stoppedReason = (task as { stoppedReason?: string }).stoppedReason ?? 'unknown';
                throw new Error(
                    `ECS task ${taskArn} exited with exit code ${exitCode} (reason: ${stoppedReason})`
                );
            }

            // Exponential backoff capped at MAX_POLL_INTERVAL_MS
            pollInterval = Math.min(pollInterval * 2, MAX_POLL_INTERVAL_MS);
        }
    }
}
