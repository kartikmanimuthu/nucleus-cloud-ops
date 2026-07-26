import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./subagent', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./subagent')>();
    return { ...actual, runSubagent: vi.fn() };
});

import { runSubagent } from './subagent';
import { createRunBudgetLedger, createDispatchAgentTool } from './dispatch-agent-tool';

const BUDGET = {
    enabled: true,
    maxConcurrentSubagents: 2,
    maxSubagentsPerRun: 3,
    maxSubagentTokensPerRun: 1000,
    subagentMaxIterations: 4,
    subagentTimeoutMs: 5000,
};

const okResult = {
    report: 'Findings: i-123 idle', toolCount: 2, tokensIn: 300, tokensOut: 50,
    status: 'done' as const, transcript: [],
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runSubagent).mockResolvedValue(okResult);
});

describe('createRunBudgetLedger', () => {
    it('allows reservations up to maxSubagentsPerRun', () => {
        const ledger = createRunBudgetLedger(BUDGET);
        expect(ledger.tryReserve().ok).toBe(true);
        expect(ledger.tryReserve().ok).toBe(true);
        expect(ledger.tryReserve().ok).toBe(true);

        const fourth = ledger.tryReserve();
        expect(fourth.ok).toBe(false);
        expect((fourth as { reason: string }).reason).toMatch(/per-run sub-agent limit/i);
    });

    it('refuses once the token budget is spent', () => {
        const ledger = createRunBudgetLedger(BUDGET);
        ledger.recordSpend(900, 200);

        const verdict = ledger.tryReserve();
        expect(verdict.ok).toBe(false);
        expect((verdict as { reason: string }).reason).toMatch(/token budget/i);
    });

    it('refuses everything when the budget is disabled', () => {
        const ledger = createRunBudgetLedger({ ...BUDGET, enabled: false });
        expect(ledger.tryReserve().ok).toBe(false);
    });
});

describe('dispatch_agent tool', () => {
    const makeTool = (budget = BUDGET) => createDispatchAgentTool({
        model: {},
        subagentTools: [{ name: 'describe_instances', invoke: async () => 'ok' }],
        ledger: createRunBudgetLedger(budget),
        budget,
    });

    it('returns the sub-agent report', async () => {
        const result = await makeTool().invoke({
            role: 'EC2 auditor', task: 'audit account 1', expectedOutput: 'idle instances',
        });
        expect(result).toContain('i-123 idle');
    });

    it('returns ONLY the report — raw sub-agent tool output never reaches the orchestrator', async () => {
        // The tool's return value becomes a ToolMessage in the orchestrator's
        // message list. If the transcript leaked into it, context isolation — the
        // entire reason sub-agents exist — would be defeated.
        vi.mocked(runSubagent).mockResolvedValue({
            ...okResult,
            transcript: [
                { kind: 'tool', name: 'describe_instances', text: 'RAW_TOOL_DUMP_MARKER' },
                { kind: 'ai', text: 'INTERNAL_REASONING_MARKER' },
            ],
        });

        const result = await makeTool().invoke({ role: 'a', task: 't', expectedOutput: 'e' });

        expect(result).toBe(okResult.report);
        expect(result).not.toContain('RAW_TOOL_DUMP_MARKER');
        expect(result).not.toContain('INTERNAL_REASONING_MARKER');
    });

    it('degrades gracefully instead of throwing when the budget is exhausted', async () => {
        const tool = makeTool({ ...BUDGET, maxSubagentsPerRun: 1 });
        await tool.invoke({ role: 'a', task: 't', expectedOutput: 'e' });

        const second = await tool.invoke({ role: 'b', task: 't', expectedOutput: 'e' });
        expect(second).toMatch(/perform this work yourself/i);
        expect(runSubagent).toHaveBeenCalledTimes(1);
    });

    it('emits running then done events', async () => {
        const events: Array<{ status: string }> = [];
        const budget = BUDGET;
        const tool = createDispatchAgentTool({
            model: {},
            subagentTools: [],
            ledger: createRunBudgetLedger(budget),
            budget,
            onSubagentEvent: e => events.push({ status: e.status }),
        });

        await tool.invoke({ role: 'a', task: 't', expectedOutput: 'e' });

        expect(events[0].status).toBe('running');
        expect(events[events.length - 1].status).toBe('done');
    });

    it('never throws when the sub-agent runtime rejects', async () => {
        vi.mocked(runSubagent).mockRejectedValue(new Error('unexpected'));
        const result = await makeTool().invoke({ role: 'a', task: 't', expectedOutput: 'e' });
        expect(result).toMatch(/unexpected/);
    });

    it('bounds concurrency to maxConcurrentSubagents', async () => {
        let active = 0;
        let peak = 0;
        vi.mocked(runSubagent).mockImplementation(async () => {
            active++; peak = Math.max(peak, active);
            await new Promise(r => setTimeout(r, 10));
            active--;
            return okResult;
        });

        const budget = { ...BUDGET, maxConcurrentSubagents: 2, maxSubagentsPerRun: 6 };
        const tool = makeTool(budget);
        await Promise.all(Array.from({ length: 5 }, (_, i) =>
            tool.invoke({ role: `r${i}`, task: 't', expectedOutput: 'e' })));

        expect(peak).toBeLessThanOrEqual(2);
    });

    it('does not reject when the progress sink throws', async () => {
        // The chat route's sink enqueues onto a ReadableStream, which throws once
        // the client disconnects — so a throwing sink is the normal client-abort
        // case, not a hypothetical. The tool must still return its report.
        const budget = BUDGET;
        const tool = createDispatchAgentTool({
            model: {},
            subagentTools: [],
            ledger: createRunBudgetLedger(budget),
            budget,
            onSubagentEvent: () => { throw new Error('sink exploded'); },
        });

        await expect(tool.invoke({ role: 'a', task: 't', expectedOutput: 'e' }))
            .resolves.toContain('i-123 idle');
    });
});
