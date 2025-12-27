// Lambda Handler - Entry point for AWS Lambda
import type { Handler } from 'aws-lambda';
import { logger } from './utils/logger.js';
import { runFullScan, runPartialScan } from './services/scheduler-service.js';
import type { SchedulerEvent, SchedulerResult } from './types/index.js';

/**
 * Lambda Handler
 * 
 * Supports two modes:
 * 1. Full Scan (no arguments): Processes all active schedules across all accounts
 * 2. Partial Scan (with scheduleId/scheduleName): Processes only the specified schedule
 * 
 * @param event - Lambda event with optional scheduleId/scheduleName
 * @returns SchedulerResult with execution summary
 */
export const handler: Handler<SchedulerEvent, SchedulerResult> = async (event) => {
    logger.info('Lambda invoked', { event });

    try {
        // Determine scan mode based on event payload
        const isPartialScan = event?.scheduleId || event?.scheduleName;
        const triggeredBy = event?.triggeredBy || 'system';

        if (isPartialScan) {
            // Partial scan - process specific schedule
            logger.info('Running partial scan', {
                scheduleId: event.scheduleId,
                scheduleName: event.scheduleName
            });
            return await runPartialScan(event, triggeredBy);
        } else {
            // Full scan - process all schedules
            logger.info('Running full scan');
            return await runFullScan(triggeredBy);
        }
    } catch (error) {
        logger.error('Lambda execution failed', error);

        // Return error result
        return {
            success: false,
            executionId: 'error',
            mode: event?.scheduleId ? 'partial' : 'full',
            schedulesProcessed: 0,
            resourcesStarted: 0,
            resourcesStopped: 0,
            resourcesFailed: 0,
            duration: 0,
            errors: [error instanceof Error ? error.message : String(error)],
        };
    }
};

export default handler;
