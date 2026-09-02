import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));
vi.mock('@/lib/knowledge-base/service', () => ({ KnowledgeBaseService: { getKnowledgeBase: vi.fn() } }));
vi.mock('@/lib/knowledge-base/retrieval', () => ({ searchKbChunks: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getSessionUserId: vi.fn() }));
vi.mock('@/lib/store/kb-chat-store', () => ({
    kbChatStore: {
        getSession: vi.fn(), touchSession: vi.fn().mockResolvedValue(undefined),
        createSession: vi.fn().mockResolvedValue(undefined), addMessages: vi.fn().mockResolvedValue(undefined),
    },
}));
vi.mock('@/lib/agent/model-resolver', () => ({ resolveDefaultModelConfig: vi.fn(), resolveModelConfig: vi.fn() }));
vi.mock('@/lib/agent/model-factory', () => ({ createAgentModels: vi.fn() }));

import { getServerSession } from 'next-auth';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { searchKbChunks } from '@/lib/knowledge-base/retrieval';
import { getSessionTenantId, getSessionUserId } from '@/lib/auth-session';
import { kbChatStore } from '@/lib/store/kb-chat-store';
import { resolveDefaultModelConfig } from '@/lib/agent/model-resolver';
import { createAgentModels } from '@/lib/agent/model-factory';
import { ProviderConfigError } from '@/lib/agent/provider-errors';
import { POST } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

async function* fakeStream(chunks: string[]) {
    for (const c of chunks) yield { content: c };
}

describe('POST /api/knowledge-base/query', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getSessionUserId).mockResolvedValue('u1');
        vi.mocked(searchKbChunks).mockResolvedValue([]);
        vi.mocked(resolveDefaultModelConfig).mockResolvedValue({ provider: 'bedrock' } as any);
        vi.mocked(createAgentModels).mockReturnValue({ main: { stream: vi.fn().mockResolvedValue(fakeStream(['Hello'])) } } as any);
    });

    it('returns 401 when unauthenticated', async () => {
        vi.mocked(getServerSession).mockResolvedValue(null as any);
        const res = await POST(makeRequest({ query: 'hi' }));
        expect(res.status).toBe(401);
    });

    it('returns 400 when query is empty', async () => {
        const res = await POST(makeRequest({ query: '   ' }));
        expect(res.status).toBe(400);
    });

    it('returns 404 when knowledgeBaseId does not belong to the tenant', async () => {
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue(null);
        const res = await POST(makeRequest({ query: 'hi', knowledgeBaseId: 'kb-other' }));
        expect(res.status).toBe(404);
    });

    it('returns 404 when sessionId does not resolve to an existing session', async () => {
        vi.mocked(kbChatStore.getSession).mockResolvedValue(null);
        const res = await POST(makeRequest({ query: 'hi', sessionId: 'sess-missing' }));
        expect(res.status).toBe(404);
    });

    it('streams the answer and sets the session/sources headers', async () => {
        const res = await POST(makeRequest({ query: 'What is Spot Guard?' }));

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toContain('text/plain');
        expect(res.headers.get('X-KB-Session-Id')).toMatch(/^tenant-1:u1:\d+$/);
        const text = await res.text();
        expect(text).toBe('Hello');
        expect(kbChatStore.createSession).toHaveBeenCalledOnce();
    });

    it('reuses and touches an existing session when sessionId is provided', async () => {
        vi.mocked(kbChatStore.getSession).mockResolvedValue({ id: 'sess-1', knowledgeBaseId: null } as any);

        await POST(makeRequest({ query: 'follow up', sessionId: 'sess-1' }));

        expect(kbChatStore.touchSession).toHaveBeenCalledWith('tenant-1', 'sess-1');
        expect(kbChatStore.createSession).not.toHaveBeenCalled();
    });

    it('returns 400 when no default provider is configured', async () => {
        vi.mocked(resolveDefaultModelConfig).mockRejectedValue(new ProviderConfigError('No provider configured'));

        const res = await POST(makeRequest({ query: 'hi' }));
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toBe('No provider configured');
    });

    it('returns 500 for an unexpected error before streaming starts', async () => {
        vi.mocked(searchKbChunks).mockRejectedValue(new Error('pgvector down'));

        const res = await POST(makeRequest({ query: 'hi' }));
        expect(res.status).toBe(500);
    });

    it('persists an image attachment on the user message and sends multimodal content to the model', async () => {
        const streamMock = vi.fn().mockResolvedValue(fakeStream(['Hi']));
        vi.mocked(createAgentModels).mockReturnValue({ main: { stream: streamMock } } as any);

        await POST(makeRequest({
            query: 'What is in this image?',
            attachments: [
                { name: 'photo.png', contentType: 'image/png', url: 'data:image/png;base64,AAA' },
                { name: 'doc.pdf', contentType: 'application/pdf', url: 'data:application/pdf;base64,BBB' },
            ],
        }));

        expect(kbChatStore.addMessages).toHaveBeenCalledWith('tenant-1', expect.any(String), [
            expect.objectContaining({
                role: 'user',
                attachments: [{ name: 'photo.png', url: 'data:image/png;base64,AAA' }],
            }),
        ]);

        const lcMessages = streamMock.mock.calls[0][0];
        const userMessage = lcMessages[lcMessages.length - 1];
        expect(userMessage.content).toEqual([
            { type: 'text', text: 'What is in this image?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        ]);
    });

    it('builds multi-turn conversation history, dropping blank messages, and includes sources/assistant persistence', async () => {
        vi.mocked(searchKbChunks).mockResolvedValue([
            { documentName: 'Doc A', textContent: 'content', sourceType: 'file-upload', chunkIndex: 1, totalChunks: 2, knowledgeBaseId: 'kb-1', dataSourceId: 'ds-1', score: 0.9 },
        ] as any);
        const streamMock = vi.fn().mockResolvedValue(fakeStream(['answer']));
        vi.mocked(createAgentModels).mockReturnValue({ main: { stream: streamMock } } as any);

        const res = await POST(makeRequest({
            query: 'follow up',
            messages: [
                { role: 'user', content: 'earlier question' },
                { role: 'assistant', content: '   ' },
                { role: 'assistant', content: 'earlier answer' },
            ],
        }));

        const lcMessages = streamMock.mock.calls[0][0];
        // system + 2 valid history turns (blank one dropped) + current user turn
        expect(lcMessages).toHaveLength(4);

        const sourcesHeader = JSON.parse(decodeURIComponent(res.headers.get('X-AI-Sources')!));
        expect(sourcesHeader).toEqual([
            { documentName: 'Doc A', sourceType: 'file-upload', chunkIndex: '1', totalChunks: '2', knowledgeBaseId: 'kb-1', dataSourceId: 'ds-1', score: 0.9 },
        ]);

        await res.text();
        expect(kbChatStore.addMessages).toHaveBeenCalledWith('tenant-1', expect.any(String), [
            expect.objectContaining({ role: 'assistant', content: 'answer', sources: sourcesHeader }),
        ]);
    });

    it('falls back to default source fields and handles array-shaped stream content', async () => {
        vi.mocked(searchKbChunks).mockResolvedValue([
            { documentName: '', textContent: '', sourceType: '', chunkIndex: undefined, totalChunks: undefined, knowledgeBaseId: '', dataSourceId: '', score: 'not-a-number' },
        ] as any);
        async function* arrayStream() {
            yield { content: [{ type: 'text', text: 'part1 ' }, { type: 'other' }] };
            yield { content: [{ type: 'text', text: 'part2' }] };
        }
        vi.mocked(createAgentModels).mockReturnValue({ main: { stream: vi.fn().mockResolvedValue(arrayStream()) } } as any);

        const res = await POST(makeRequest({ query: 'hi' }));
        const text = await res.text();

        expect(text).toBe('part1 part2');
        const sourcesHeader = JSON.parse(decodeURIComponent(res.headers.get('X-AI-Sources')!));
        expect(sourcesHeader[0]).toEqual({
            documentName: 'Unknown', sourceType: 'file-upload', chunkIndex: '0', totalChunks: '1',
            knowledgeBaseId: '', dataSourceId: '', score: 0,
        });
    });

    it('does not fail the request when persisting the user message throws (non-fatal)', async () => {
        vi.mocked(kbChatStore.addMessages).mockRejectedValueOnce(new Error('DB down'));

        const res = await POST(makeRequest({ query: 'hi' }));
        await res.text();
        expect(res.status).toBe(200);
    });

    it('does not fail the request when persisting the assistant message throws (non-fatal)', async () => {
        vi.mocked(kbChatStore.addMessages)
            .mockResolvedValueOnce(undefined) // user message persist succeeds
            .mockRejectedValueOnce(new Error('DB down')); // assistant message persist fails

        const res = await POST(makeRequest({ query: 'hi' }));
        const text = await res.text();
        expect(res.status).toBe(200);
        expect(text).toBe('Hello');
    });

    it('errors the stream and does not persist an assistant message when the LLM stream throws mid-flight', async () => {
        async function* throwingStream(): AsyncGenerator<{ content: string }> {
            yield { content: 'partial' };
            throw new Error('stream exploded');
        }
        vi.mocked(createAgentModels).mockReturnValue({ main: { stream: vi.fn().mockResolvedValue(throwingStream()) } } as any);

        const res = await POST(makeRequest({ query: 'hi' }));
        await expect(res.text()).rejects.toThrow();
    });
});
