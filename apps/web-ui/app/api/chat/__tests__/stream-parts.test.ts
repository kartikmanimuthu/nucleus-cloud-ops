import { describe, it, expect } from 'vitest';
import { buildMemoryPart, humanizeReflection, humanizePlanning, isWorkingMemoryPayload, stripWorkingMemoryPrelude } from '@/app/api/chat/stream-parts';
import { buildUsagePart } from '../stream-parts';
import { buildSubagentPart, buildHeartbeatChunks } from '../stream-parts';

const WM_JSON = JSON.stringify({
    summary: 'User asked to connect Jira; site resource retrieved.',
    scratchpad: { openGoals: ['connect Jira'], keyFindings: [], resourceIds: [], pendingSteps: ['query board'] },
});

describe('buildMemoryPart', () => {
    it('counts markdown bullets (-) and returns them as `count`', () => {
        const summary = '- recalled fact one\n- recalled fact two\n- recalled fact three';
        const part = buildMemoryPart('recall', summary);
        expect(part.type).toBe('data-memory');
        expect(part.data).toEqual({ op: 'recall', summary, count: 3 });
    });

    it('counts `•` bullets', () => {
        const summary = '• fact one\n• fact two';
        const part = buildMemoryPart('save', summary);
        expect((part.data as any).count).toBe(2);
    });

    it('counts mixed -, *, • bullet markers', () => {
        const summary = '- fact one\n* fact two\n• fact three';
        const part = buildMemoryPart('recall', summary);
        expect((part.data as any).count).toBe(3);
    });

    it('returns count: null for prose with no bullets', () => {
        const summary = 'Recalled a general preference about deployment timing.';
        const part = buildMemoryPart('recall', summary);
        expect((part.data as any).count).toBeNull();
    });

    it('sets op to the passed value', () => {
        expect((buildMemoryPart('save', 'no bullets here').data as any).op).toBe('save');
        expect((buildMemoryPart('recall', 'no bullets here').data as any).op).toBe('recall');
    });
});

describe('humanizeReflection', () => {
    it('turns full reflector JSON into prose with no braces or quotes', () => {
        const raw = JSON.stringify({
            isComplete: false,
            analysis: 'The plan correctly lists AWS accounts before filtering.',
            issues: 'Missing region filter in step 2.',
            suggestions: 'Add a region parameter before executing.',
            updatedPlan: [],
        });
        const result = humanizeReflection(raw);
        expect(result).toBe(
            'The plan correctly lists AWS accounts before filtering.\n\nIssues: Missing region filter in step 2.\n\nNext: Add a region parameter before executing.'
        );
        expect(result).not.toMatch(/[{}]/);
        expect(result).not.toContain('"analysis"');
    });

    it('parses JSON wrapped in ```json fences', () => {
        const payload = JSON.stringify({
            isComplete: true,
            analysis: 'All steps completed successfully.',
            issues: '',
            suggestions: '',
        });
        const raw = '```json\n' + payload + '\n```';
        expect(humanizeReflection(raw)).toBe('All steps completed successfully.');
    });

    it('omits the Issues line when issues is "None for this step."', () => {
        const raw = JSON.stringify({
            isComplete: false,
            analysis: 'Step complete, nothing outstanding.',
            issues: 'None for this step.',
            suggestions: 'Continue to the next step.',
        });
        expect(humanizeReflection(raw)).toBe(
            'Step complete, nothing outstanding.\n\nNext: Continue to the next step.'
        );
    });

    it('returns raw text unchanged when JSON parsing fails', () => {
        const raw = 'This is not JSON at all, just plain reflector prose.';
        expect(humanizeReflection(raw)).toBe(raw);
    });

    it('returns raw text unchanged for JSON with an unclosed brace', () => {
        const raw = '{ "analysis": "incomplete';
        expect(humanizeReflection(raw)).toBe(raw);
    });

    it('parses JSON preceded by leading prose', () => {
        const payload = JSON.stringify({
            isComplete: false,
            analysis: 'Reviewed the plan against the goal.',
            issues: '',
            suggestions: 'Proceed to the next step.',
        });
        const raw = 'Here is my reflection:\n' + payload;
        expect(humanizeReflection(raw)).toBe(
            'Reviewed the plan against the goal.\n\nNext: Proceed to the next step.'
        );
    });

    it('omits the Next line when suggestions is missing', () => {
        const raw = JSON.stringify({
            isComplete: true,
            analysis: 'Everything checks out.',
        });
        expect(humanizeReflection(raw)).toBe('Everything checks out.');
    });

    it('keeps suggestions when the value is exactly "None" (asymmetric with the Issues omission rule)', () => {
        const raw = JSON.stringify({
            isComplete: false,
            analysis: 'Step in progress.',
            issues: '',
            suggestions: 'None',
        });
        expect(humanizeReflection(raw)).toBe('Step in progress.\n\nNext: None');
    });

    it('returns raw unchanged when a {...} span exists but has none of the reflector keys (guards against hijack by an unrelated embedded object)', () => {
        const raw = 'Some notes before an unrelated object: {"foo": "bar", "count": 3} and after.';
        expect(humanizeReflection(raw)).toBe(raw);
    });

    // reflectNode (apps/web-ui/lib/agent/planning-agent.ts) persists a pre-formatted
    // feedback string, never raw JSON — persisted reflection content must reach the
    // SAME prose shape the live JSON path produces. Mirrors planning-agent's exact
    // feedback template so the parsing is derived from the real format, not guessed.
    function buildReflectNodeFeedback(analysis: string, issues: string, suggestions: string, isComplete: boolean): string {
        return `🔍 **Reflection Analysis:**
${analysis}

${issues !== 'None' ? `⚠️ **Issues Found:** ${issues}` : ''}
${suggestions !== 'None' ? `💡 **Suggestions:** ${suggestions}` : ''}

**Task Complete:** ${isComplete ? '✅ Yes' : '❌ No, continuing...'}`;
    }

    it('converts the reflectNode feedback format (full sections) to the same prose shape as the JSON path', () => {
        const raw = buildReflectNodeFeedback(
            'The plan correctly lists AWS accounts before filtering.',
            'Missing region filter in step 2.',
            'Add a region parameter before executing.',
            false,
        );
        expect(humanizeReflection(raw)).toBe(
            'The plan correctly lists AWS accounts before filtering.\n\nIssues: Missing region filter in step 2.\n\nNext: Add a region parameter before executing.'
        );
    });

    it('omits the Issues line when the feedback format has no Issues section (reflector reported "None")', () => {
        const raw = buildReflectNodeFeedback('All good so far.', 'None', 'Keep going.', false);
        expect(humanizeReflection(raw)).toBe('All good so far.\n\nNext: Keep going.');
    });

    it('drops the Task Complete trailer from the feedback format entirely', () => {
        const raw = buildReflectNodeFeedback('Nothing left to do.', 'None', 'None', true);
        expect(humanizeReflection(raw)).toBe('Nothing left to do.');
    });
});

describe('humanizePlanning', () => {
    it('converts a raw JSON step array into a numbered-list summary', () => {
        const raw = '["Check EC2 instances in us-east-1", "Check ECS services", "Summarize findings"]';
        expect(humanizePlanning(raw)).toBe(
            'Drafted a 3-step plan:\n\n1. Check EC2 instances in us-east-1\n2. Check ECS services\n3. Summarize findings',
        );
    });

    it('handles fenced arrays and surrounding whitespace', () => {
        const raw = '```json\n["step one", "step two"]\n```';
        expect(humanizePlanning(raw)).toBe('Drafted a 2-step plan:\n\n1. step one\n2. step two');
    });

    it('handles the { "plan": [...] } object shape', () => {
        const raw = '{"plan": ["alpha", "beta"]}';
        expect(humanizePlanning(raw)).toBe('Drafted a 2-step plan:\n\n1. alpha\n2. beta');
    });

    it('returns genuine planner prose unchanged', () => {
        const raw = 'I will first check the instances, then the services.';
        expect(humanizePlanning(raw)).toBe(raw);
    });

    it('returns raw text unchanged when the array does not parse', () => {
        const raw = '["unterminated, "broken]';
        expect(humanizePlanning(raw)).toBe(raw);
    });
});

describe('isWorkingMemoryPayload', () => {
    it('detects a bare working-memory JSON object', () => {
        expect(isWorkingMemoryPayload(WM_JSON)).toBe(true);
    });

    it('detects a fenced working-memory JSON object', () => {
        expect(isWorkingMemoryPayload('```json\n' + WM_JSON + '\n```')).toBe(true);
    });

    it('rejects an ordinary answer', () => {
        expect(isWorkingMemoryPayload('Here is the brief:\n\n## Jira Connection\n- Site: …')).toBe(false);
    });

    it('rejects an answer that merely EMBEDS a WM-shaped object in substantial prose', () => {
        const raw = `The compaction payload looked like this: ${WM_JSON}\n\nAnd here is a long explanation of what each field means and why it matters for the run.`;
        expect(isWorkingMemoryPayload(raw)).toBe(false);
    });

    it('rejects JSON objects without the summary+scratchpad shape', () => {
        expect(isWorkingMemoryPayload('{"analysis": "done", "isComplete": true}')).toBe(false);
    });
});

describe('stripWorkingMemoryPrelude', () => {
    it('strips a leading fenced WM block, keeping the answer', () => {
        const raw = '```json\n' + WM_JSON + '\n```\nConnected to Jira. Here is the brief:';
        expect(stripWorkingMemoryPrelude(raw)).toBe('Connected to Jira. Here is the brief:');
    });

    it('leaves an answer without a WM prelude untouched', () => {
        const raw = 'Connected to Jira. Here is the brief:';
        expect(stripWorkingMemoryPrelude(raw)).toBe(raw);
    });

    it('leaves a leading non-WM code fence untouched', () => {
        const raw = '```json\n{"result": "ok"}\n```\nExplanation follows.';
        expect(stripWorkingMemoryPrelude(raw)).toBe(raw);
    });
});

describe('buildUsagePart', () => {
    it('builds a data-usage part', () => {
        expect(buildUsagePart(3, 4)).toEqual({ type: 'data-usage', data: { input: 3, output: 4 } });
    });
});

describe('buildSubagentPart', () => {
    const base = {
        id: 'sa-1', role: 'EC2 auditor', task: 'audit account 1',
        toolCount: 3, tokensIn: 900, tokensOut: 120,
    };

    it('builds a stable id so updates replace rather than append', () => {
        const part = buildSubagentPart({ ...base, status: 'running' });
        expect(part.type).toBe('data-subagent');
        expect(part.id).toBe('subagent-sa-1');
    });

    it('carries progress counters', () => {
        const part = buildSubagentPart({ ...base, status: 'running' });
        expect(part.data).toMatchObject({ role: 'EC2 auditor', status: 'running', toolCount: 3, tokensIn: 900 });
    });

    it('omits the transcript from the stream payload', () => {
        const part = buildSubagentPart({
            ...base, status: 'done', summary: 'found things',
            transcript: [{ kind: 'ai', text: 'internal reasoning' }],
        });
        expect(JSON.stringify(part.data)).not.toContain('internal reasoning');
        expect((part.data as { summary?: string }).summary).toBe('found things');
    });
});

// The heartbeat exists solely to keep bytes flowing so CloudFront's 60s
// originReadTimeout (infra/compute/index.ts:962) can't kill a long run. Its tick
// body lives here — not inline in route.ts — because nothing in the suite imports
// route.ts, so an inline tick is untested by construction.
describe('buildHeartbeatChunks', () => {
    const base = {
        id: 'sa-1', role: 'EC2 auditor', task: 'audit account 1',
        toolCount: 3, tokensIn: 900, tokensOut: 120,
    };

    it('re-emits one data-subagent part per in-flight sub-agent and no keep-alive', () => {
        const chunks = buildHeartbeatChunks([
            { ...base, id: 'sa-1', status: 'running' },
            { ...base, id: 'sa-2', status: 'running' },
        ]);
        expect(chunks).toHaveLength(2);
        expect(chunks.map((c) => c.type)).toEqual(['data-subagent', 'data-subagent']);
        expect(chunks.map((c: any) => c.id)).toEqual(['subagent-sa-1', 'subagent-sa-2']);
        expect(chunks.some((c) => c.type === 'data-keepalive')).toBe(false);
    });

    // REGRESSION GUARD for F1. `liveSubagents` empties as sub-agents reach their
    // terminal event, so a tick that only walks that map writes ZERO bytes during
    // the orchestrator's post-fan-out call — the longest silence and the largest
    // context in the run, exactly when the 60s origin timeout bites. A tick MUST
    // write something. This test fails if the empty-case branch is removed.
    it('emits exactly one keep-alive chunk when no sub-agent is in flight', () => {
        const chunks = buildHeartbeatChunks([]);
        expect(chunks).toHaveLength(1);
        expect(chunks[0].type).toBe('data-keepalive');
    });

    it('marks the keep-alive transient and gives it no sub-agent fields', () => {
        const [chunk] = buildHeartbeatChunks([]) as any[];
        // transient parts are delivered to the client but never appended to
        // message.parts, so a keep-alive cannot bloat the message or move the reducer.
        expect(chunk.transient).toBe(true);
        expect(chunk.id).toBeUndefined();
        expect(chunk.data).toEqual({});
        expect(JSON.stringify(chunk)).not.toMatch(/sa-1|EC2 auditor|audit account|transcript/);
    });

    it('still omits the transcript for a terminal event passed through the tick', () => {
        const chunks = buildHeartbeatChunks([{
            ...base, status: 'done', summary: 'found things',
            transcript: [{ kind: 'ai', text: 'internal reasoning' }],
        }]);
        expect(chunks).toHaveLength(1);
        expect(JSON.stringify(chunks[0])).not.toContain('internal reasoning');
        expect(JSON.stringify(chunks[0])).not.toContain('transcript');
    });
});
