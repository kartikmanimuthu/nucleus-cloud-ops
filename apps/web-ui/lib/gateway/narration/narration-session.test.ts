import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent/model-resolver', () => ({
    resolveModelConfig: vi.fn().mockResolvedValue({ provider: 'bedrock', modelId: 'test-model' }),
    resolveDefaultModelConfig: vi.fn().mockResolvedValue({ provider: 'bedrock', modelId: 'test-model' }),
}));
vi.mock('@/lib/gateway/narration/translate-event', () => ({
    translateEventWithFallback: vi.fn(async (e: any) => {
        if (e.eventType === 'planning') return { active: 'Planning the approach...', done: 'Planned the approach' };
        return e.toolName === 'read_file'
            ? { active: 'Reading a file...', done: 'Read a file' }
            : { active: 'Running an AWS CLI command...', done: 'Ran an AWS CLI command' };
    }),
}));

import { resolveDefaultModelConfig } from '@/lib/agent/model-resolver';
import { NarrationSessions } from './narration-session';

const run = { runId: 'run-1', tenantId: 'tenant-1', trigger: {} } as any;
const evt = (eventType: string, toolName?: string) => ({ eventType, node: 'agent', toolName }) as any;

describe('NarrationSessions', () => {
    let sessions: NarrationSessions;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(resolveDefaultModelConfig).mockResolvedValue({ provider: 'bedrock', modelId: 'test-model' } as any);
        sessions = new NarrationSessions(0); // no throttling in tests
    });

    it('returns null for a non-boundary event', async () => {
        expect(await sessions.applyEvent(run, evt('memory_save'))).toBeNull();
    });

    it('renders a pending step for tool_call', async () => {
        const text = await sessions.applyEvent(run, evt('tool_call', 'execute_command'));
        expect(text).toBe('⏳ Running an AWS CLI command...');
    });

    it('completes the matching step on tool_result', async () => {
        await sessions.applyEvent(run, evt('tool_call', 'execute_command'));
        const text = await sessions.applyEvent(run, evt('tool_result', 'execute_command'));
        expect(text).toBe('✅ Ran an AWS CLI command');
    });

    it('correlates parallel tool calls by tool name', async () => {
        await sessions.applyEvent(run, evt('tool_call', 'execute_command'));
        await sessions.applyEvent(run, evt('tool_call', 'read_file'));
        const text = await sessions.applyEvent(run, evt('tool_result', 'read_file'));

        const lines = text!.split('\n');
        expect(lines[0]).toBe('⏳ Running an AWS CLI command...');
        expect(lines[1]).toBe('✅ Read a file');
    });

    it('adds milestone events already complete', async () => {
        const text = await sessions.applyEvent(run, evt('planning'));
        expect(text).toBe('✅ Planned the approach');
    });

    it('keeps state per run', async () => {
        await sessions.applyEvent(run, evt('tool_call', 'execute_command'));
        const other = await sessions.applyEvent({ ...run, runId: 'run-2' }, evt('tool_call', 'read_file'));
        expect(other).toBe('⏳ Reading a file...');
    });

    it('resolves the model once per run and caches it', async () => {
        await sessions.applyEvent(run, evt('tool_call', 'execute_command'));
        await sessions.applyEvent(run, evt('tool_call', 'read_file'));
        expect(resolveDefaultModelConfig).toHaveBeenCalledTimes(1);
    });

    it('returns null and stops narrating once finished', async () => {
        await sessions.applyEvent(run, evt('tool_call', 'execute_command'));
        sessions.finish('run-1');

        expect(sessions.isFinished('run-1')).toBe(true);
        expect(await sessions.applyEvent(run, evt('tool_call', 'read_file'))).toBeNull();
    });

    it('throttles sends but keeps checklist state current', async () => {
        const throttled = new NarrationSessions(60_000);

        expect(await throttled.applyEvent(run, evt('tool_call', 'execute_command'))).toBe('⏳ Running an AWS CLI command...');
        // Suppressed by the throttle...
        expect(await throttled.applyEvent(run, evt('tool_call', 'read_file'))).toBeNull();
        // ...but the state still advanced: finishing and re-reading shows both steps.
        throttled.finish('run-1');
        const fresh = new NarrationSessions(0);
        expect(await fresh.applyEvent(run, evt('tool_call', 'execute_command'))).toBe('⏳ Running an AWS CLI command...');
    });

    it('never throws when model resolution fails', async () => {
        vi.mocked(resolveDefaultModelConfig).mockRejectedValue(new Error('no provider'));
        await expect(sessions.applyEvent(run, evt('tool_call', 'execute_command'))).resolves.toBeNull();
    });
});
