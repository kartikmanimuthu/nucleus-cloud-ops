export type HandlerFn = (jobData: unknown) => Promise<unknown>;

export interface ExecuteOptions {
    /**
     * Stable idempotency token for this dispatch — the pg-boss job id. The
     * HorizontalExecutor stamps it as the ECS task `startedBy` so that a retry or
     * a resurrected job ADOPTS the already-running task instead of launching a
     * duplicate that would run a second concurrent AWS-mutating scan. Ignored by
     * the in-process VerticalExecutor.
     */
    idempotencyKey?: string;
    /**
     * Hard wall-clock cap for this dispatch, in ms. MUST be strictly less than the
     * originating queue's expireInSeconds so the executor gives up (and stops the
     * ECS task) BEFORE pg-boss expires the job and retries it. Ignored by the
     * VerticalExecutor.
     */
    timeoutMs?: number;
}

export interface JobExecutor {
    execute(jobName: string, jobData: unknown, opts?: ExecuteOptions): Promise<unknown>;
    registerHandler?(jobName: string, handler: HandlerFn): void;
}
