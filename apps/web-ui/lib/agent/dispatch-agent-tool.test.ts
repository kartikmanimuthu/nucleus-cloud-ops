import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./subagent', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./subagent')>();
    return { ...actual, runSubagent: vi.fn() };
});

import { runSubagent } from './subagent';
import { createRunBudgetLedger, createDispatchAgentTool, estimateSubagentTokens } from './dispatch-agent-tool';

const BUDGET = {
    enabled: true,
    maxConcurrentSubagents: 2,
    maxSubagentsPerRun: 3,
    // Large enough that the COUNT limit is what bites in the tests below that are
    // about the count. Token-ceiling behaviour gets its own describe block, where
    // the budget is sized deliberately against `estimateSubagentTokens`.
    maxSubagentTokensPerRun: 200_000,
    subagentMaxIterations: 4,
    subagentTimeoutMs: 5000,
};

/** Reserve and immediately settle, i.e. "this much has already been spent". */
function spend(ledger: ReturnType<typeof createRunBudgetLedger>, tokensIn: number, tokensOut: number) {
    const verdict = ledger.tryReserve();
    if (!verdict.ok) throw new Error(`expected a reservation, got: ${verdict.reason}`);
    verdict.reservation.settle(tokensIn, tokensOut);
}

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
        spend(ledger, 190_000, 5_000);

        const verdict = ledger.tryReserve();
        expect(verdict.ok).toBe(false);
        expect((verdict as { reason: string }).reason).toMatch(/token budget/i);
    });

    it('refuses everything when the budget is disabled', () => {
        const ledger = createRunBudgetLedger({ ...BUDGET, enabled: false });
        expect(ledger.tryReserve().ok).toBe(false);
    });
});

describe('createRunBudgetLedger — the token ceiling actually binds (F4)', () => {
    it('bounds a concurrent fan-out by the TOKEN budget, not only the count', () => {
        // THE DEFECT. ToolNode dispatches a turn's dispatch_agent calls concurrently,
        // so every tryReserve runs BEFORE any sub-agent finishes and reports usage.
        // A ledger that gates on settled spend alone therefore consults the token
        // budget only after the fan-out it exists to bound has already been granted.
        const budget = { ...BUDGET, maxSubagentsPerRun: 16, maxSubagentTokensPerRun: 50_000 };
        const ledger = createRunBudgetLedger(budget);
        const estimate = estimateSubagentTokens(budget);

        // No settle() calls in between — this is the real fan-out ordering.
        const verdicts = Array.from({ length: 16 }, () => ledger.tryReserve());
        const granted = verdicts.filter(v => v.ok).length;

        expect(granted).toBe(Math.floor(50_000 / estimate));
        expect(granted).toBeLessThan(16);
        const refusal = verdicts.find(v => !v.ok) as { reason: string };
        expect(refusal.reason).toMatch(/token budget/i);
    });

    it('reconciles: a sub-agent that came in under estimate frees the difference', () => {
        const budget = { ...BUDGET, maxSubagentsPerRun: 16, maxSubagentTokensPerRun: 50_000 };
        const ledger = createRunBudgetLedger(budget);
        const estimate = estimateSubagentTokens(budget);
        const capacity = Math.floor(50_000 / estimate);

        const held = Array.from({ length: capacity }, () => ledger.tryReserve());
        expect(held.every(v => v.ok)).toBe(true);
        expect(ledger.tryReserve().ok).toBe(false);

        // Each one actually cost a fraction of its reservation. Releasing the
        // difference must let the run keep fanning out.
        for (const v of held) {
            if (v.ok) v.reservation.settle(100, 20);
        }
        expect(ledger.tryReserve().ok).toBe(true);
    });

    it('settle is idempotent — a double release cannot mint budget', () => {
        const budget = { ...BUDGET, maxSubagentsPerRun: 16, maxSubagentTokensPerRun: 50_000 };
        const ledger = createRunBudgetLedger(budget);
        const estimate = estimateSubagentTokens(budget);

        const first = ledger.tryReserve();
        if (!first.ok) throw new Error('expected a reservation');
        first.reservation.settle(estimate, 0);
        first.reservation.settle(estimate, 0);
        first.reservation.settle(estimate, 0);

        // One sub-agent that spent exactly its estimate leaves room for the rest —
        // no more, no less. Triple-settling must not have triple-counted the spend
        // (which would refuse too early) nor triple-released (which would overspend).
        const remaining = Array.from({ length: 16 }, () => ledger.tryReserve()).filter(v => v.ok).length;
        expect(remaining).toBe(Math.floor(50_000 / estimate) - 1);
    });

    it('distinguishes the count refusal from the token refusal', () => {
        const countBound = createRunBudgetLedger({ ...BUDGET, maxSubagentsPerRun: 1, maxSubagentTokensPerRun: 1_000_000 });
        countBound.tryReserve();
        const byCount = countBound.tryReserve() as { reason: string };

        const tokenBound = createRunBudgetLedger({ ...BUDGET, maxSubagentsPerRun: 16, maxSubagentTokensPerRun: 50_000 });
        let byToken = tokenBound.tryReserve();
        while (byToken.ok) byToken = tokenBound.tryReserve();

        expect(byCount.reason).toMatch(/sub-agent limit/i);
        expect(byCount.reason).not.toMatch(/token/i);
        expect((byToken as { reason: string }).reason).toMatch(/token budget/i);
    });

    it('says so plainly when one sub-agent cannot fit in the whole budget', () => {
        // A tenant who sets the minimum token budget alongside the maximum iteration
        // count has configured a run that can afford zero sub-agents. Refusing with
        // "token budget exhausted" before anything ran would be baffling; the message
        // has to name the misconfiguration.
        const ledger = createRunBudgetLedger({
            ...BUDGET, subagentMaxIterations: 16, maxSubagentTokensPerRun: 50_000,
        });
        const verdict = ledger.tryReserve();

        expect(verdict.ok).toBe(false);
        expect((verdict as { reason: string }).reason).toMatch(/exceeds the entire/i);
    });

    it('holds no state across runs', () => {
        const budget = { ...BUDGET, maxSubagentsPerRun: 16, maxSubagentTokensPerRun: 50_000 };
        const exhausted = createRunBudgetLedger(budget);
        let v = exhausted.tryReserve();
        while (v.ok) v = exhausted.tryReserve();

        expect(createRunBudgetLedger(budget).tryReserve().ok).toBe(true);
    });

    it('checks and increments synchronously, with no await in between', () => {
        // Two concurrent callers must never both observe the same free capacity.
        // An `await` anywhere between the check and the increment would reintroduce
        // exactly that race, so the call must not be thenable at all.
        const ledger = createRunBudgetLedger(BUDGET);
        const verdict = ledger.tryReserve();

        expect(verdict).not.toBeInstanceOf(Promise);
        expect((verdict as unknown as { then?: unknown }).then).toBeUndefined();
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

    it('redacts the report before it reaches the orchestrator', async () => {
        // The return value becomes a ToolMessage in the orchestrator's message list,
        // and route.ts persists every new message VERBATIM. That reaches two at-rest
        // sinks the subagent repository's redaction does not cover: `chat_messages`
        // (30-day TTL, and replayed to the browser by /api/threads/[id]/history) and
        // the LangGraph PostgresSaver checkpoint tables, which have NO TTL at all.
        vi.mocked(runSubagent).mockResolvedValue({
            ...okResult,
            report: 'api-worker connects to postgres://admin:letmein@db.internal:5432/app',
        });

        const result = await makeTool().invoke({ role: 'a', task: 't', expectedOutput: 'e' });

        expect(result).not.toContain('letmein');
        // Redacting must not change the type — LangGraph requires a string.
        expect(typeof result).toBe('string');
        // The finding stays actionable: only the credential is withheld.
        expect(result).toContain('db.internal');
    });

    it('leaves a report with no secrets in it byte-identical', async () => {
        // Over-redaction fails the operator too: a report the model worked hard to
        // compose must survive the boundary unchanged when it carries nothing secret.
        const clean = 'Findings: i-0abc123 (t3.medium) idle at 2% CPU; arn:aws:lambda:us-east-1:123456789012:function:api-worker last modified 2026-07-26.';
        vi.mocked(runSubagent).mockResolvedValue({ ...okResult, report: clean });

        expect(await makeTool().invoke({ role: 'a', task: 't', expectedOutput: 'e' })).toBe(clean);
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

    describe('reservation release (F4)', () => {
        // A stranded reservation is worse than no ceiling at all: it silently starves
        // the rest of the run. Every exit path must hand its capacity back.
        const budget = { ...BUDGET, maxSubagentsPerRun: 16, maxSubagentTokensPerRun: 200_000 };
        const estimate = estimateSubagentTokens(budget);
        const capacity = Math.floor(200_000 / estimate);

        type ResultOverride = Partial<Omit<typeof okResult, 'status'>> & { status?: 'done' | 'failed' };

        const runOnceWith = async (result: ResultOverride | Error) => {
            const ledger = createRunBudgetLedger(budget);
            const tool = createDispatchAgentTool({ model: {}, subagentTools: [], ledger, budget });
            if (result instanceof Error) vi.mocked(runSubagent).mockRejectedValue(result);
            else vi.mocked(runSubagent).mockResolvedValue({ ...okResult, ...result });

            await tool.invoke({ role: 'a', task: 't', expectedOutput: 'e' });
            return ledger;
        };

        /** How many more sub-agents this ledger will admit. */
        const remainingCapacity = (ledger: ReturnType<typeof createRunBudgetLedger>) =>
            Array.from({ length: 16 }, () => ledger.tryReserve()).filter(v => v.ok).length;

        it('releases on success, charging only what was actually used', async () => {
            const ledger = await runOnceWith({ tokensIn: 300, tokensOut: 50 });
            // 350 real tokens is a rounding error against the budget, so the run keeps
            // essentially all of its capacity — it must NOT still be holding a full
            // estimate for a sub-agent that has already finished.
            expect(remainingCapacity(ledger)).toBe(Math.floor((200_000 - 350) / estimate));
        });

        it('releases when the sub-agent times out or fails internally', async () => {
            const ledger = await runOnceWith({ status: 'failed', tokensIn: 100, tokensOut: 0 });
            expect(remainingCapacity(ledger)).toBe(Math.floor((200_000 - 100) / estimate));
        });

        it('releases when the sub-agent runtime rejects outright', async () => {
            // The catch path: a semaphore or sink failure spent no tokens, so the
            // reservation must come back whole.
            const ledger = await runOnceWith(new Error('semaphore exploded'));
            expect(remainingCapacity(ledger)).toBe(capacity);
        });
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
