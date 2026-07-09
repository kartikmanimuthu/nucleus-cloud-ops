import {
    ECSClient,
    RunTaskCommand,
    DescribeTasksCommand,
    ListTasksCommand,
    StopTaskCommand,
} from '@aws-sdk/client-ecs';
import { createLogger } from '../lib/logger.js';
import { env } from '../env.js';
import type { ExecuteOptions, JobExecutor } from './types.js';

const log = createLogger('horizontal-executor');

const INITIAL_POLL_INTERVAL_MS = 2000;
const MAX_POLL_INTERVAL_MS = 30000;
const DEFAULT_TIMEOUT_MS = 900000;
// How many CONSECUTIVE DescribeTasks failures to tolerate before giving up.
// ECS DescribeTasks throttling is routine at scale; one throttle must not kill an
// otherwise-healthy job and trigger a duplicate relaunch.
const MAX_CONSECUTIVE_POLL_ERRORS = 6;

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
    async execute(jobName: string, jobData: unknown, opts?: ExecuteOptions): Promise<void> {
        try {
            return await this.run(jobName, jobData, opts);
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

    private async run(jobName: string, jobData: unknown, opts?: ExecuteOptions): Promise<void> {
        // Read and validate config at execute time so missing vars produce clear errors
        const clusterArn = getRequiredEnv('HORIZONTAL_CLUSTER_ARN');
        const taskDefArn = getRequiredEnv('HORIZONTAL_TASK_DEF_ARN');
        const subnetsRaw = getRequiredEnv('HORIZONTAL_SUBNETS');
        const securityGroup = getRequiredEnv('HORIZONTAL_SECURITY_GROUP');
        // Per-dispatch timeout wins over the global default so it can be kept below
        // each queue's expireInSeconds (avoids pg-boss retrying a job whose task is
        // still running).
        const timeoutMs = opts?.timeoutMs
            ?? parseInt(env.HORIZONTAL_TASK_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS), 10);
        const initialPollMs = parseInt(env.HORIZONTAL_POLL_INTERVAL_MS ?? String(INITIAL_POLL_INTERVAL_MS), 10);

        const subnets = subnetsRaw.split(',').map((s) => s.trim()).filter(Boolean);
        const ecsClient = new ECSClient({});

        // ECS startedBy is capped at 128 chars; a pg-boss job id (uuid) fits easily.
        const startedBy = opts?.idempotencyKey ? `job-${opts.idempotencyKey}`.slice(0, 128) : undefined;

        // Idempotent launch: if this job was already dispatched (retry after a
        // transient poll error, or a resurrected job after a worker crash), adopt
        // the running task instead of launching a second one that would run a
        // duplicate concurrent scan.
        let taskArn: string | undefined;
        if (startedBy) {
            taskArn = await this.findRunningTask(ecsClient, clusterArn, startedBy);
            if (taskArn) {
                log.info('Adopting already-running ECS task (idempotent relaunch)', { jobName, taskArn, startedBy });
            }
        }

        if (!taskArn) {
            log.info('Dispatching job to ECS Fargate', { jobName, startedBy });
            const runResult = await ecsClient.send(
                new RunTaskCommand({
                    cluster: clusterArn,
                    taskDefinition: taskDefArn,
                    launchType: 'FARGATE',
                    startedBy,
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

            taskArn = runResult.tasks[0].taskArn!;
            log.info('ECS task launched', { jobName, taskArn });
        }

        // Poll until STOPPED with exponential backoff
        const startTime = Date.now();
        let pollInterval = initialPollMs;
        let consecutivePollErrors = 0;

        while (true) {
            await sleep(pollInterval);

            if (Date.now() - startTime > timeoutMs) {
                // Stop the leaked task BEFORE throwing, so a retry/resurrection does
                // not race a still-running duplicate against customer AWS resources.
                await this.stopTaskQuietly(ecsClient, clusterArn, taskArn, 'nucleus executor timeout');
                throw new Error(
                    `HorizontalExecutor timed out waiting for task ${taskArn} after ${timeoutMs}ms (task stopped)`
                );
            }

            let describeResult;
            try {
                describeResult = await ecsClient.send(
                    new DescribeTasksCommand({ cluster: clusterArn, tasks: [taskArn] })
                );
                consecutivePollErrors = 0;
            } catch (err) {
                consecutivePollErrors++;
                log.warn('DescribeTasks poll failed — tolerating transient error', {
                    jobName,
                    taskArn,
                    consecutivePollErrors,
                    error: err instanceof Error ? err.message : String(err),
                });
                if (consecutivePollErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
                    await this.stopTaskQuietly(ecsClient, clusterArn, taskArn, 'nucleus executor poll failure');
                    throw new Error(
                        `HorizontalExecutor lost track of task ${taskArn} after ${consecutivePollErrors} consecutive DescribeTasks failures (task stopped)`
                    );
                }
                pollInterval = Math.min(pollInterval * 2, MAX_POLL_INTERVAL_MS);
                continue;
            }

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

    /** Find a PENDING/RUNNING task previously launched for this idempotency token. */
    private async findRunningTask(
        ecsClient: ECSClient,
        clusterArn: string,
        startedBy: string,
    ): Promise<string | undefined> {
        try {
            const arns: string[] = [];
            for (const status of ['RUNNING', 'PENDING'] as const) {
                const res = await ecsClient.send(
                    new ListTasksCommand({ cluster: clusterArn, startedBy, desiredStatus: status })
                );
                if (res.taskArns?.length) arns.push(...res.taskArns);
            }
            return arns[0];
        } catch (err) {
            // If discovery of an existing task fails, fall through to a fresh launch.
            // Worst case is one duplicate — acceptable relative to never running.
            log.warn('ListTasks for idempotent adopt failed — will launch fresh', {
                startedBy,
                error: err instanceof Error ? err.message : String(err),
            });
            return undefined;
        }
    }

    private async stopTaskQuietly(
        ecsClient: ECSClient,
        clusterArn: string,
        taskArn: string,
        reason: string,
    ): Promise<void> {
        try {
            await ecsClient.send(new StopTaskCommand({ cluster: clusterArn, task: taskArn, reason }));
            log.info('Stopped leaked ECS task', { taskArn, reason });
        } catch (err) {
            log.error('Failed to stop leaked ECS task — may run to completion on its own', {
                taskArn,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
}
