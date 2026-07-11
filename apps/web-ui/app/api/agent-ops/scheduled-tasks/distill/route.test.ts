import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
    NextRequest: vi.fn(),
    NextResponse: {
        json: vi.fn((data: unknown, init?: { status?: number }) => ({
            _data: data,
            _status: init?.status ?? 200,
            status: init?.status ?? 200,
            json: async () => data,
        })),
    },
}));

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/agent/model-resolver', () => ({ resolveDefaultModelConfig: vi.fn() }));
vi.mock('@/lib/agent/model-factory', () => ({ createAgentModels: vi.fn() }));
vi.mock('@/lib/agent/provider-errors', () => ({
    isProviderConfigError: vi.fn((err: unknown) => err instanceof ProviderConfigError),
    ProviderConfigError: class ProviderConfigError extends Error {
        constructor(message: string) {
            super(message);
            this.name = 'ProviderConfigError';
        }
    },
}));

import { POST } from './route';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { resolveDefaultModelConfig } from '@/lib/agent/model-resolver';
import { createAgentModels } from '@/lib/agent/model-factory';
import { ProviderConfigError } from '@/lib/agent/provider-errors';

const makeRequest = (body?: unknown) => ({ json: vi.fn().mockResolvedValue(body ?? {}) }) as any;

const validDraftJson = JSON.stringify({
    name: 'Daily Cost Anomaly Review',
    prompt: 'Every run, check account 111122223333 for cost anomalies. 1. Run `aws ce get-anomalies`. 2. Report anomalies over $50 in the run summary.',
    suggestedCron: '0 9 * * *',
    cadenceLabel: 'Daily at 9:00 AM',
});

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authorize).mockResolvedValue(null);
    vi.mocked(getSessionTenantId).mockResolvedValue('t1');
    vi.mocked(resolveDefaultModelConfig).mockResolvedValue({ provider: 'anthropic', modelId: 'm1' } as any);
});

describe('POST /api/agent-ops/scheduled-tasks/distill', () => {
    it('403s when authorize denies', async () => {
        vi.mocked(authorize).mockResolvedValue({ status: 403, _data: { error: 'Forbidden' }, _status: 403 } as any);
        const res = await POST(makeRequest({ transcript: 'USER: hi' }));
        expect(res).toEqual({ status: 403, _data: { error: 'Forbidden' }, _status: 403 });
    });

    it('400s on missing transcript', async () => {
        const res = await POST(makeRequest({}));
        expect((res as any)._status).toBe(400);
        expect((res as any)._data.success).toBe(false);
    });

    it('400s when the JSON body is null', async () => {
        const res = await POST({ json: vi.fn().mockResolvedValue(null) } as any);
        expect((res as any)._status).toBe(400);
        expect((res as any)._data.success).toBe(false);
    });

    it('413s when transcript exceeds the size guard, without calling the model', async () => {
        const invoke = vi.fn();
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke }, reflector: {} } as any);
        const res = await POST(makeRequest({ transcript: 'a'.repeat(600_001) }));
        expect((res as any)._status).toBe(413);
        expect(invoke).not.toHaveBeenCalled();
    });

    it('sends the full transcript to the model with no truncation', async () => {
        const longTranscript = `USER: ${'b'.repeat(100_000)}`;
        const invoke = vi.fn().mockResolvedValue({ content: validDraftJson });
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke }, reflector: {} } as any);
        await POST(makeRequest({ transcript: longTranscript }));
        expect(invoke).toHaveBeenCalledOnce();
        expect(invoke.mock.calls[0][0] as string).toContain(longTranscript);
    });

    it('returns the parsed draft on success', async () => {
        const invoke = vi.fn().mockResolvedValue({ content: validDraftJson });
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke }, reflector: {} } as any);
        const res = await POST(makeRequest({ transcript: 'USER: check my costs' }));
        expect((res as any)._status).toBe(200);
        expect((res as any)._data).toEqual({
            success: true,
            data: {
                name: 'Daily Cost Anomaly Review',
                prompt: 'Every run, check account 111122223333 for cost anomalies. 1. Run `aws ce get-anomalies`. 2. Report anomalies over $50 in the run summary.',
                suggestedCron: '0 9 * * *',
                cadenceLabel: 'Daily at 9:00 AM',
            },
        });
    });

    it('502s when the model does not return valid JSON', async () => {
        const invoke = vi.fn().mockResolvedValue({ content: 'not json' });
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke }, reflector: {} } as any);
        const res = await POST(makeRequest({ transcript: 'USER: hi' }));
        expect((res as any)._status).toBe(502);
    });

    it('falls back to a daily cron when suggestedCron is not a 5-field string', async () => {
        const invoke = vi.fn().mockResolvedValue({
            content: JSON.stringify({ name: 'X', prompt: 'p', suggestedCron: 'nonsense', cadenceLabel: 'l' }),
        });
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke }, reflector: {} } as any);
        const res = await POST(makeRequest({ transcript: 'USER: hi' }));
        expect((res as any)._data.data.suggestedCron).toBe('0 9 * * *');
    });

    it('400s with the provider message when no default provider is configured', async () => {
        vi.mocked(resolveDefaultModelConfig).mockRejectedValue(new ProviderConfigError('No LLM provider is configured.'));
        const res = await POST(makeRequest({ transcript: 'USER: hi' }));
        expect((res as any)._status).toBe(400);
        expect((res as any)._data.error).toBe('No LLM provider is configured.');
    });
});
