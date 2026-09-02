import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockBedrockSend, mockPoolQuery } = vi.hoisted(() => ({
    mockBedrockSend: vi.fn(),
    mockPoolQuery: vi.fn(),
}));

vi.mock('../../../env.js', () => ({ env: { AWS_REGION: 'us-east-1', BEDROCK_MODEL_ID: 'amazon.titan-embed-text-v2:0', DATABASE_URL: 'postgres://test' } }));
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
    BedrockRuntimeClient: vi.fn().mockImplementation(function (this: any) { this.send = mockBedrockSend; }),
    InvokeModelCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
}));
vi.mock('pg', () => ({
    Pool: vi.fn().mockImplementation(function (this: any) { this.query = mockPoolQuery; }),
}));

import { getEmbedding, embedAndStore, deleteOldVectors, EMBEDDING_CONCURRENCY } from './embedding.js';
import type { Chunk } from './chunking.js';

function bedrockResponse(embedding: number[]) {
    return { body: new TextEncoder().encode(JSON.stringify({ embedding })) };
}

function chunk(index: number, total: number, text = `chunk ${index}`): Chunk {
    return { text, index, total, contentHash: `hash${index}` };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockBedrockSend.mockReset().mockImplementation(async () => bedrockResponse([0.1, 0.2, 0.3]));
    mockPoolQuery.mockReset().mockResolvedValue({ rows: [] });
});

describe('getEmbedding', () => {
    it('invokes the Bedrock embedding model and returns the parsed vector', async () => {
        const result = await getEmbedding('some text to embed');
        expect(result).toEqual([0.1, 0.2, 0.3]);
        const call = mockBedrockSend.mock.calls[0][0] as { input: any };
        expect(call.input.modelId).toBe('amazon.titan-embed-text-v2:0');
        expect(JSON.parse(call.input.body)).toEqual({ inputText: 'some text to embed' });
    });

    it('truncates input text to 8000 characters before sending', async () => {
        await getEmbedding('x'.repeat(10000));
        const call = mockBedrockSend.mock.calls[0][0] as { input: any };
        expect(JSON.parse(call.input.body).inputText).toHaveLength(8000);
    });
});

describe('embedAndStore', () => {
    it('embeds and upserts every chunk, scoped by tenantId, and returns their vector keys', async () => {
        const chunks = [chunk(0, 2), chunk(1, 2)];
        const keys = await embedAndStore({ chunks, kbId: 'kb1', dsId: 'ds1', sourceType: 's3', docName: 'doc.md', tenantId: 'tenant-1', docId: 'doc1' });

        expect(keys).toEqual(['kb_kb1_ds1_doc1_0_hash0', 'kb_kb1_ds1_doc1_1_hash1']);
        expect(mockPoolQuery).toHaveBeenCalledTimes(2);
        const [sql, params] = mockPoolQuery.mock.calls[0];
        expect(sql).toContain('ON CONFLICT ("vectorKey")');
        expect(params[0]).toBe('tenant-1');
        expect(params[3]).toBe('kb_kb1_ds1_doc1_0_hash0');
    });

    it('embeds chunks in batches of EMBEDDING_CONCURRENCY', async () => {
        const chunks = Array.from({ length: EMBEDDING_CONCURRENCY + 3 }, (_, i) => chunk(i, EMBEDDING_CONCURRENCY + 3));
        await embedAndStore({ chunks, kbId: 'kb1', dsId: 'ds1', sourceType: 's3', docName: 'doc.md', tenantId: 'tenant-1' });

        expect(mockBedrockSend).toHaveBeenCalledTimes(chunks.length);
        expect(mockPoolQuery).toHaveBeenCalledTimes(chunks.length);
    });

    it('formats the embedding as a pgvector literal', async () => {
        mockBedrockSend.mockImplementation(async () => bedrockResponse([1, 2, 3]));
        await embedAndStore({ chunks: [chunk(0, 1)], kbId: 'kb1', dsId: 'ds1', sourceType: 's3', docName: 'doc.md', tenantId: 'tenant-1' });
        const [, params] = mockPoolQuery.mock.calls[0];
        expect(params[11]).toBe('[1,2,3]');
    });

    it('defaults docId and extra metadata when not provided', async () => {
        const keys = await embedAndStore({ chunks: [chunk(0, 1)], kbId: 'kb1', dsId: 'ds1', sourceType: 's3', docName: 'doc.md', tenantId: 'tenant-1' });
        expect(keys[0]).toBe('kb_kb1_ds1__0_hash0');
        const [, params] = mockPoolQuery.mock.calls[0];
        expect(params[10]).toBe('{}');
    });
});

describe('deleteOldVectors', () => {
    it('does nothing for an empty key list', async () => {
        await deleteOldVectors([]);
        expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it('deletes all given keys in one batch when under the batch size', async () => {
        await deleteOldVectors(['k1', 'k2']);
        expect(mockPoolQuery).toHaveBeenCalledTimes(1);
        const [sql, params] = mockPoolQuery.mock.calls[0];
        expect(sql).toContain('DELETE FROM kb_document_chunks');
        expect(params[0]).toEqual(['k1', 'k2']);
    });

    it('splits more than 500 keys into multiple batched deletes', async () => {
        const keys = Array.from({ length: 750 }, (_, i) => `k${i}`);
        await deleteOldVectors(keys);
        expect(mockPoolQuery).toHaveBeenCalledTimes(2);
        expect(mockPoolQuery.mock.calls[0][1][0]).toHaveLength(500);
        expect(mockPoolQuery.mock.calls[1][1][0]).toHaveLength(250);
    });
});
