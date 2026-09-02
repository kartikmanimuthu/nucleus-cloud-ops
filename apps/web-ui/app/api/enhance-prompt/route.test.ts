import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/agent/model-resolver', () => ({ resolveDefaultModelConfig: vi.fn() }));
vi.mock('@/lib/agent/model-factory', () => ({ createAgentModels: vi.fn() }));

import { getSessionTenantId } from '@/lib/auth-session';
import { resolveDefaultModelConfig } from '@/lib/agent/model-resolver';
import { createAgentModels } from '@/lib/agent/model-factory';
import { ProviderConfigError } from '@/lib/agent/provider-errors';
import { POST } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('POST /api/enhance-prompt', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(resolveDefaultModelConfig).mockResolvedValue({ provider: 'bedrock', modelId: 'x' } as any);
    });

    it('returns 400 when prompt is missing', async () => {
        const res = await POST(makeRequest({}));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toBe('Prompt is required');
    });

    it('returns 400 with the provider message when no default provider is configured', async () => {
        vi.mocked(resolveDefaultModelConfig).mockRejectedValue(new ProviderConfigError('No provider configured'));

        const res = await POST(makeRequest({ prompt: 'fix my ec2s' }));
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toBe('No provider configured');
    });

    it('returns the enhanced prompt, stripped of enhanced_prompt tags', async () => {
        const invoke = vi.fn().mockResolvedValue({ content: '<enhanced_prompt>Do the thing clearly</enhanced_prompt>' });
        vi.mocked(createAgentModels).mockReturnValue({ reflector: { invoke } } as any);

        const res = await POST(makeRequest({ prompt: 'do thing' }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.enhancedPrompt).toBe('Do the thing clearly');
        expect(invoke).toHaveBeenCalledOnce();
    });

    it('returns 500 when the model invocation throws a non-provider error', async () => {
        const invoke = vi.fn().mockRejectedValue(new Error('Bedrock throttled'));
        vi.mocked(createAgentModels).mockReturnValue({ reflector: { invoke } } as any);

        const res = await POST(makeRequest({ prompt: 'do thing' }));
        const body = await res.json();

        expect(res.status).toBe(500);
        expect(body.error).toBe('Bedrock throttled');
    });
});
