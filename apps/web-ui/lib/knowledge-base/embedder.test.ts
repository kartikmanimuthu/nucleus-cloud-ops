import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: vi.fn() }));
vi.mock('@/lib/agent/embeddings-factory', () => ({ getTenantEmbeddings: vi.fn() }));

import { getPrismaClient } from '@/lib/db/pg-config';
import { getTenantEmbeddings } from '@/lib/agent/embeddings-factory';
import {
    chunkText, computeContentHash, getEmbedding, embedAndStoreChunks, deleteVectors, parseFileContent,
} from './embedder';

describe('chunkText', () => {
    it('returns a single chunk for short text, prefixed with the document header', () => {
        const [chunk] = chunkText('Hello world', 'doc.txt');
        expect(chunk.text).toBe('Document: doc.txt | Chunk 1/1\n\nHello world');
        expect(chunk.index).toBe(0);
        expect(chunk.total).toBe(1);
        expect(chunk.contentHash).toBe(computeContentHash('Hello world'));
    });

    it('splits long text on paragraph breaks and overlaps subsequent chunks with the previous tail', () => {
        const para = (n: number) => `Paragraph ${n}. `.repeat(120); // > 1500 chars each
        const text = [para(1), para(2), para(3)].join('\n\n');
        const chunks = chunkText(text, 'big.txt');

        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks[0].index).toBe(0);
        expect(chunks[chunks.length - 1].index).toBe(chunks.length - 1);
        chunks.forEach((c) => expect(c.total).toBe(chunks.length));
        // Every chunk after the first carries a leading overlap from the previous raw chunk.
        expect(chunks[1].text.length).toBeGreaterThan(0);
    });

    it('falls back to a hard character split when text has no usable separators', () => {
        const text = 'x'.repeat(4000); // no \n\n, \n, '. ', or ' ' anywhere
        const chunks = chunkText(text, 'nosep.txt');
        expect(chunks.length).toBeGreaterThan(1);
    });

    it('recurses through separator tiers when a paragraph-level chunk is still too large', () => {
        // One giant "paragraph" (no \n\n) that only splits on '. ' or ' '.
        const text = Array.from({ length: 100 }, (_, i) => `Sentence number ${i} of some length here.`).join(' ');
        const chunks = chunkText(text, 'sentences.txt');
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.every((c) => c.text.length > 0)).toBe(true);
    });
});

describe('computeContentHash', () => {
    it('is deterministic and 16 hex characters long', () => {
        const h1 = computeContentHash('same content');
        const h2 = computeContentHash('same content');
        expect(h1).toBe(h2);
        expect(h1).toMatch(/^[0-9a-f]{16}$/);
    });

    it('differs for different content', () => {
        expect(computeContentHash('a')).not.toBe(computeContentHash('b'));
    });
});

describe('getEmbedding', () => {
    it('resolves the tenant embeddings provider and truncates the input to 8000 chars', async () => {
        const embedQuery = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
        vi.mocked(getTenantEmbeddings).mockResolvedValueOnce({ embedQuery } as any);

        const longText = 'a'.repeat(9000);
        const result = await getEmbedding(longText, 't1');

        expect(getTenantEmbeddings).toHaveBeenCalledWith('t1');
        expect(embedQuery).toHaveBeenCalledWith('a'.repeat(8000));
        expect(result).toEqual([0.1, 0.2, 0.3]);
    });
});

describe('embedAndStoreChunks', () => {
    const executeRawUnsafe = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getPrismaClient).mockReturnValue({ $executeRawUnsafe: executeRawUnsafe } as any);
        vi.mocked(getTenantEmbeddings).mockResolvedValue({
            embedQuery: vi.fn().mockResolvedValue([0.1, 0.2]),
        } as any);
        executeRawUnsafe.mockResolvedValue(undefined);
    });

    it('embeds and stores every chunk, scoping every raw insert to tenantId', async () => {
        const chunks = chunkText('Hello world', 'doc.txt');
        const keys = await embedAndStoreChunks({
            chunks, knowledgeBaseId: 'kb1', dataSourceId: 'ds1', sourceType: 'document',
            documentName: 'doc.txt', tenantId: 't1',
        });

        expect(keys).toEqual([`kb_kb1_ds1_0_${chunks[0].contentHash}`]);
        expect(executeRawUnsafe).toHaveBeenCalledTimes(1);
        // $executeRawUnsafe is NOT tenant-intercepted — tenantId must be the first bound param.
        expect(executeRawUnsafe.mock.calls[0][1]).toBe('t1');
        expect(executeRawUnsafe.mock.calls[0][2]).toBe('kb1');
    });

    it('processes chunks in batches of EMBEDDING_CONCURRENCY (5) without dropping any', async () => {
        const chunks = Array.from({ length: 12 }, (_, i) => ({
            contentHash: `hash${i}`, text: `chunk ${i}`, index: i, total: 12,
        }));
        const keys = await embedAndStoreChunks({
            chunks, knowledgeBaseId: 'kb1', dataSourceId: 'ds1', sourceType: 'document',
            documentName: 'doc.txt', tenantId: 't1',
        });
        expect(keys).toHaveLength(12);
        expect(executeRawUnsafe).toHaveBeenCalledTimes(12);
    });

    it('includes only the extraMetadata fields that were actually provided', async () => {
        const chunks = [{ contentHash: 'h1', text: 'x', index: 0, total: 1 }];
        await embedAndStoreChunks({
            chunks, knowledgeBaseId: 'kb1', dataSourceId: 'ds1', sourceType: 's3',
            documentName: 'doc.txt', tenantId: 't1', extraMetadata: { s3Key: 'path/to/file' },
        });

        const metadataJson = executeRawUnsafe.mock.calls[0][11];
        expect(JSON.parse(metadataJson)).toEqual({ s3Key: 'path/to/file' });
    });

    it('formats the embedding as a pgvector literal', async () => {
        vi.mocked(getTenantEmbeddings).mockResolvedValueOnce({
            embedQuery: vi.fn().mockResolvedValue([0.5, -0.25, 1]),
        } as any);
        const chunks = [{ contentHash: 'h1', text: 'x', index: 0, total: 1 }];
        await embedAndStoreChunks({
            chunks, knowledgeBaseId: 'kb1', dataSourceId: 'ds1', sourceType: 'document',
            documentName: 'doc.txt', tenantId: 't1',
        });
        const vectorLiteral = executeRawUnsafe.mock.calls[0][12];
        expect(vectorLiteral).toBe('[0.5,-0.25,1]');
    });

    it('returns an empty array without any DB calls for an empty chunk list', async () => {
        const keys = await embedAndStoreChunks({
            chunks: [], knowledgeBaseId: 'kb1', dataSourceId: 'ds1', sourceType: 'document',
            documentName: 'doc.txt', tenantId: 't1',
        });
        expect(keys).toEqual([]);
        expect(executeRawUnsafe).not.toHaveBeenCalled();
    });
});

describe('deleteVectors', () => {
    const executeRawUnsafe = vi.fn();
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getPrismaClient).mockReturnValue({ $executeRawUnsafe: executeRawUnsafe } as any);
        executeRawUnsafe.mockResolvedValue(undefined);
    });

    it('is a no-op for an empty key list, never touching the DB', async () => {
        await deleteVectors([]);
        expect(getPrismaClient).not.toHaveBeenCalled();
        expect(executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('deletes a single batch when under the batch size', async () => {
        await deleteVectors(['k1', 'k2']);
        expect(executeRawUnsafe).toHaveBeenCalledTimes(1);
        expect(executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM kb_document_chunks'), ['k1', 'k2']);
    });

    it('splits into multiple batches of 20 for a large key list', async () => {
        const keys = Array.from({ length: 45 }, (_, i) => `k${i}`);
        await deleteVectors(keys);
        expect(executeRawUnsafe).toHaveBeenCalledTimes(3); // 20 + 20 + 5
        expect(executeRawUnsafe.mock.calls[2][1]).toHaveLength(5);
    });
});

describe('parseFileContent', () => {
    it('parses PDF content via pdf-parse when the MIME type is application/pdf', async () => {
        vi.doMock('pdf-parse', () => ({ default: vi.fn().mockResolvedValue({ text: 'pdf text' }) }));
        vi.resetModules();
        const { parseFileContent: freshParse } = await import('./embedder');
        const result = await freshParse(Buffer.from('fake-pdf-bytes'), 'application/pdf', 'doc.pdf');
        expect(result).toBe('pdf text');
        vi.doUnmock('pdf-parse');
    });

    it('parses PDF content when the filename ends in .pdf even with a generic MIME type', async () => {
        vi.doMock('pdf-parse', () => ({ default: vi.fn().mockResolvedValue({ text: 'pdf via filename' }) }));
        vi.resetModules();
        const { parseFileContent: freshParse } = await import('./embedder');
        const result = await freshParse(Buffer.from('x'), 'application/octet-stream', 'doc.pdf');
        expect(result).toBe('pdf via filename');
        vi.doUnmock('pdf-parse');
    });

    it('decodes text-based MIME types as UTF-8', async () => {
        const result = await parseFileContent(Buffer.from('hello world', 'utf-8'), 'text/plain', 'a.txt');
        expect(result).toBe('hello world');
    });

    it('decodes markdown/json/yaml/csv by file extension regardless of MIME type', async () => {
        for (const ext of ['md', 'txt', 'csv', 'json', 'yaml', 'yml']) {
            const result = await parseFileContent(Buffer.from('content'), 'application/octet-stream', `f.${ext}`);
            expect(result).toBe('content');
        }
    });

    it('throws for an unsupported MIME type and filename', async () => {
        await expect(parseFileContent(Buffer.from('x'), 'application/zip', 'archive.zip'))
            .rejects.toThrow('Unsupported file type: application/zip (archive.zip)');
    });
});
