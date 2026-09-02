import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeDeepRun = vi.fn().mockResolvedValue(undefined);
const resumeDeepRun = vi.fn().mockResolvedValue(undefined);
const createDynamicExecutorGraph = vi.fn();

vi.mock('./deep-run-executor', () => ({
    executeDeepRun: (...a: unknown[]) => executeDeepRun(...a),
    resumeDeepRun: (...a: unknown[]) => resumeDeepRun(...a),
}));
vi.mock('./executor-graphs', () => ({
    createDynamicExecutorGraph: (...a: unknown[]) => { createDynamicExecutorGraph(...a); throw new Error('plan graph reached'); },
}));
vi.mock('./agent-ops-service', () => ({
    agentOpsService: {
        updateRunStatus: vi.fn().mockResolvedValue(undefined),
        recordEvent: vi.fn().mockResolvedValue(undefined),
        getRun: vi.fn().mockResolvedValue(null),
    },
}));
vi.mock('./run-manager', () => ({
    registerRun: () => new AbortController(),
    cleanupRun: vi.fn(),
    isAborted: () => false,
}));
vi.mock('../agent/mcp-manager', () => ({ getMCPManager: () => ({ connectServers: vi.fn() }) }));

import { executeAgentRun } from './agent-executor';

const run = (mode: string) => ({
    runId: 'r1', tenantId: 't1', taskDescription: 'do a thing', threadId: 'th1',
    mode, source: 'api', status: 'queued', autoApprove: false,
} as never);

describe('executeAgentRun mode dispatch', () => {
    beforeEach(() => vi.clearAllMocks());

    it('routes a deep run to the deep executor', async () => {
        await executeAgentRun(run('deep'));
        expect(executeDeepRun).toHaveBeenCalledTimes(1);
        expect(createDynamicExecutorGraph).not.toHaveBeenCalled();
    });

    it('leaves a plan run on the plan graph', async () => {
        await executeAgentRun(run('plan'));
        expect(executeDeepRun).not.toHaveBeenCalled();
    });

    it('treats legacy fast rows as plan, not deep', async () => {
        await executeAgentRun(run('fast'));
        expect(executeDeepRun).not.toHaveBeenCalled();
    });
});
