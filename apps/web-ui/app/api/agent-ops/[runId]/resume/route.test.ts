import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent-ops/agent-ops-service', () => ({
    agentOpsService: { getRun: vi.fn(), updateRunStatus: vi.fn() },
}));
vi.mock('@/lib/agent-ops/agent-executor', () => ({ executeAgentRun: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/agent-ops/scheduled-notifier', () => ({ finalizeScheduledRun: vi.fn().mockResolvedValue(undefined) }));

import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { executeAgentRun } from '@/lib/agent-ops/agent-executor';
import { getSessionTenantId } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { POST } from './route';

const makeParams = (runId: string) => ({ params: Promise.resolve({ runId }) });
const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('POST /api/agent-ops/[runId]/resume', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 400 when userInput is blank', async () => {
        const res = await POST(makeRequest({ userInput: '  ' }), makeParams('run-1'));
        expect(res.status).toBe(400);
        expect(agentOpsService.getRun).not.toHaveBeenCalled();
    });

    it('returns 403 when the run does not exist for this tenant', async () => {
        vi.mocked(agentOpsService.getRun).mockResolvedValue(null);
        const res = await POST(makeRequest({ userInput: 'yes' }), makeParams('run-missing'));
        expect(res.status).toBe(403);
    });

    it('returns 409 when the run is not awaiting input', async () => {
        vi.mocked(agentOpsService.getRun).mockResolvedValue({ id: 'run-1', status: 'in_progress' } as any);
        const res = await POST(makeRequest({ userInput: 'yes' }), makeParams('run-1'));
        expect(res.status).toBe(409);
    });

    it('appends the clarification question and answer, marks in_progress, and re-executes', async () => {
        vi.mocked(agentOpsService.getRun).mockResolvedValue({
            id: 'run-1', status: 'awaiting_input', taskDescription: 'Stop the EC2 instance',
            clarification: { question: 'Which instance?' },
        } as any);
        vi.mocked(executeAgentRun).mockResolvedValue(undefined as any);

        const res = await POST(makeRequest({ userInput: 'i-12345' }), makeParams('run-1'));
        const body = await res.json();

        expect(agentOpsService.updateRunStatus).toHaveBeenCalledWith('tenant-1', 'run-1', 'in_progress');
        expect(executeAgentRun).toHaveBeenCalledWith(expect.objectContaining({
            taskDescription: expect.stringContaining('Which instance?'),
        }));
        expect(executeAgentRun).toHaveBeenCalledWith(expect.objectContaining({
            taskDescription: expect.stringContaining('i-12345'),
        }));
        expect(res.status).toBe(200);
        expect(body).toEqual({ runId: 'run-1', status: 'in_progress', message: 'Run resumed with clarification context.' });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.run.resumed' })
        );
    });

    it('appends a generic clarification note when the run has no stored clarification question', async () => {
        vi.mocked(agentOpsService.getRun).mockResolvedValue({
            id: 'run-1', status: 'awaiting_input', taskDescription: 'Stop the EC2 instance',
        } as any);
        vi.mocked(executeAgentRun).mockResolvedValue(undefined as any);

        await POST(makeRequest({ userInput: 'i-12345' }), makeParams('run-1'));
        expect(executeAgentRun).toHaveBeenCalledWith(expect.objectContaining({
            taskDescription: expect.stringContaining('User clarification: i-12345'),
        }));
    });

    it('returns 500 when a dependency throws', async () => {
        vi.mocked(agentOpsService.getRun).mockRejectedValue(new Error('DB down'));
        const res = await POST(makeRequest({ userInput: 'yes' }), makeParams('run-1'));
        expect(res.status).toBe(500);
    });
});
