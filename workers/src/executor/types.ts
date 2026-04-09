export type HandlerFn = (jobData: unknown) => Promise<void>;

export interface JobExecutor {
    execute(jobName: string, jobData: unknown): Promise<void>;
    registerHandler?(jobName: string, handler: HandlerFn): void;
}
