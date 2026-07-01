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
import { ProviderConfigError, isProviderConfigError } from '@/lib/agent/provider-errors';

const makeRequest = (body?: unknown) => ({ json: vi.fn().mockResolvedValue(body ?? {}) }) as any;

const validDraftJson = JSON.stringify({
    name: 'Review Cost Trends',
    description: 'Use when asked to review AWS cost trends.',
    tier: 'read-only',
    content: '# Review Cost Trends\n1. Run `aws ce get-cost-and-usage`.',
});

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authorize).mockResolvedValue(null);
    vi.mocked(getSessionTenantId).mockResolvedValue('t1');
    vi.mocked(resolveDefaultModelConfig).mockResolvedValue({ provider: 'anthropic', modelId: 'm1' } as any);
});

describe('POST /api/skills/distill', () => {
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

    it('413s when transcript exceeds the size guard, without calling the model', async () => {
        const hugeTranscript = 'a'.repeat(600_001);
        const invoke = vi.fn();
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke }, reflector: {} } as any);
        const res = await POST(makeRequest({ transcript: hugeTranscript }));
        expect((res as any)._status).toBe(413);
        expect((res as any)._data.success).toBe(false);
        expect(invoke).not.toHaveBeenCalled();
    });

    it('sends the full transcript to the model with no truncation', async () => {
        const longTranscript = `USER: ${'b'.repeat(100_000)}`;
        const invoke = vi.fn().mockResolvedValue({ content: validDraftJson });
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke }, reflector: {} } as any);
        await POST(makeRequest({ transcript: longTranscript }));
        expect(invoke).toHaveBeenCalledOnce();
        const promptSent = invoke.mock.calls[0][0] as string;
        expect(promptSent).toContain(longTranscript);
    });

    it('returns the parsed draft on success', async () => {
        const invoke = vi.fn().mockResolvedValue({ content: validDraftJson });
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke }, reflector: {} } as any);
        const res = await POST(makeRequest({ transcript: 'USER: check my costs' }));
        expect((res as any)._status).toBe(200);
        expect((res as any)._data).toEqual({
            success: true,
            data: {
                name: 'Review Cost Trends',
                description: 'Use when asked to review AWS cost trends.',
                tier: 'read-only',
                content: '# Review Cost Trends\n1. Run `aws ce get-cost-and-usage`.',
            },
        });
    });

    it('502s when the model does not return valid JSON', async () => {
        const invoke = vi.fn().mockResolvedValue({ content: 'not json' });
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke }, reflector: {} } as any);
        const res = await POST(makeRequest({ transcript: 'USER: hi' }));
        expect((res as any)._status).toBe(502);
        expect((res as any)._data.success).toBe(false);
    });

    it('falls back to read-only when the model returns an invalid tier', async () => {
        const invoke = vi.fn().mockResolvedValue({
            content: JSON.stringify({ name: 'X', description: 'd', tier: 'nonsense', content: 'c' }),
        });
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke }, reflector: {} } as any);
        const res = await POST(makeRequest({ transcript: 'USER: hi' }));
        expect((res as any)._data.data.tier).toBe('read-only');
    });

    it('400s with the provider message when no default provider is configured', async () => {
        vi.mocked(resolveDefaultModelConfig).mockRejectedValue(new ProviderConfigError('No LLM provider is configured.'));
        const res = await POST(makeRequest({ transcript: 'USER: hi' }));
        expect((res as any)._status).toBe(400);
        expect((res as any)._data.error).toBe('No LLM provider is configured.');
    });
});
