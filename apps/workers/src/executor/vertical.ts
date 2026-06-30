import { createLogger } from '../lib/logger.js';
import type { HandlerFn, JobExecutor } from './types.js';

const log = createLogger('vertical-executor');

export class VerticalExecutor implements JobExecutor {
    private readonly registry = new Map<string, HandlerFn>();

    registerHandler(jobName: string, handler: HandlerFn): void {
        this.registry.set(jobName, handler);
    }

    async execute(jobName: string, jobData: unknown): Promise<unknown> {
        const handler = this.registry.get(jobName);
        if (!handler) {
            throw new Error(`No handler registered for job: ${jobName}`);
        }
        log.debug('Executing job in-process', { jobName });
        try {
            return await handler(jobData);
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
}
