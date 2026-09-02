import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEnv = vi.hoisted(() => ({
    LANGFUSE_ENABLED: undefined as string | undefined,
    LANGFUSE_PUBLIC_KEY: undefined as string | undefined,
    LANGFUSE_SECRET_KEY: undefined as string | undefined,
    LANGFUSE_HOST: undefined as string | undefined,
}));
vi.mock('@/env', () => ({ env: mockEnv }));

const CallbackHandlerMock = vi.hoisted(() => vi.fn().mockImplementation(function (this: any, config: unknown) { this.config = config; }));
vi.mock('langfuse-langchain', () => ({ CallbackHandler: CallbackHandlerMock }));

import { getLangfuseCallbackHandler } from './langfuse-config';

describe('getLangfuseCallbackHandler', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockEnv.LANGFUSE_ENABLED = undefined;
        mockEnv.LANGFUSE_PUBLIC_KEY = undefined;
        mockEnv.LANGFUSE_SECRET_KEY = undefined;
        mockEnv.LANGFUSE_HOST = undefined;
    });

    it('returns null when the feature flag is not "true"', async () => {
        expect(await getLangfuseCallbackHandler('thread-1')).toBeNull();
        mockEnv.LANGFUSE_ENABLED = 'yes';
        expect(await getLangfuseCallbackHandler('thread-1')).toBeNull();
    });

    it('warns and returns null when keys are missing despite the flag being enabled', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mockEnv.LANGFUSE_ENABLED = 'true';
        const result = await getLangfuseCallbackHandler('thread-1');
        expect(result).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Tracing disabled'));
        warnSpy.mockRestore();
    });

    it('builds a handler with sessionId only when userId and host are absent', async () => {
        mockEnv.LANGFUSE_ENABLED = 'true';
        mockEnv.LANGFUSE_PUBLIC_KEY = 'pk';
        mockEnv.LANGFUSE_SECRET_KEY = 'sk';

        await getLangfuseCallbackHandler('thread-1');

        expect(CallbackHandlerMock).toHaveBeenCalledWith({ publicKey: 'pk', secretKey: 'sk', sessionId: 'thread-1' });
    });

    it('includes baseUrl and userId when configured', async () => {
        mockEnv.LANGFUSE_ENABLED = 'true';
        mockEnv.LANGFUSE_PUBLIC_KEY = 'pk';
        mockEnv.LANGFUSE_SECRET_KEY = 'sk';
        mockEnv.LANGFUSE_HOST = 'https://langfuse.example.com';

        await getLangfuseCallbackHandler('thread-1', 'user-9');

        expect(CallbackHandlerMock).toHaveBeenCalledWith({
            publicKey: 'pk', secretKey: 'sk', sessionId: 'thread-1',
            baseUrl: 'https://langfuse.example.com', userId: 'user-9',
        });
    });
});
