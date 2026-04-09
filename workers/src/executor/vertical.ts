import { createLogger } from '../lib/logger.js';
import type { HandlerFn, JobExecutor } from './types.js';

const log = createLogger('vertical-executor');

export class VerticalExecutor implements JobExecutor {
    private readonly registry = new Map<string, HandlerFn>();

    registerHandler(jobName: string, handler: HandlerFn): void {
        this.registry.set(jobName, handler);
    }

    async execute(jobName: string, jobData: unknown): Promise<void> {
        const handler = this.registry.get(jobName);
        if (!handler) {
            throw new Error(`No handler registered for job: ${jobName}`);
        }
        log.debug('Executing job in-process', { jobName });
        await handler(jobData);
    }
}
