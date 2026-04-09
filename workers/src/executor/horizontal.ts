import { createLogger } from '../lib/logger.js';
import type { JobExecutor } from './types.js';

const log = createLogger('horizontal-executor');

export class HorizontalExecutor implements JobExecutor {
    async execute(jobName: string, _jobData: unknown): Promise<void> {
        log.warn('HorizontalExecutor is a stub - ECS dispatch not yet implemented', { jobName });
    }
}
