import { getEmbedding } from './embedder';
import { getPrismaClient } from '@/lib/db/pg-config';

export interface KbChunkHit {
    vectorKey: string;
    documentName: string;
    sourceType: string;
    chunkIndex: number;
    totalChunks: number;
    knowledgeBaseId: string;
    dataSourceId: string;
    textContent: string;
    score: number;
}

/**
 * Semantic search over kb_document_chunks (pgvector cosine). Scoped to the
 * tenant; optionally narrowed to a set of knowledge bases. When no ids are
 * given it searches ALL of the tenant's chunks. Never trusts a client tenantId —
 * callers pass the session/graph-resolved tenantId.
 */
export async function searchKbChunks(params: {
    tenantId: string;
    query: string;
    knowledgeBaseIds?: string[];
    limit?: number;
    minScore?: number;
}): Promise<KbChunkHit[]> {
    const { tenantId, query, knowledgeBaseIds, limit = 10, minScore = 0 } = params;
    if (!query.trim()) return [];

    const embedding = await getEmbedding(query, tenantId);
    const vectorLiteral = `[${embedding.join(',')}]`;
    const prisma = getPrismaClient();

    const cols = `"vectorKey", "documentName", "sourceType", "chunkIndex", "totalChunks",
                  "knowledgeBaseId", "dataSourceId", "textContent",
                  1 - (embedding <=> $1::vector) as score`;

    let rows: KbChunkHit[];
    if (knowledgeBaseIds && knowledgeBaseIds.length > 0) {
        rows = await prisma.$queryRawUnsafe<KbChunkHit[]>(
            `SELECT ${cols}
             FROM kb_document_chunks
             WHERE "tenantId" = $2 AND "knowledgeBaseId" = ANY($3::text[])
             ORDER BY embedding <=> $1::vector
             LIMIT ${Number(limit)}`,
            vectorLiteral, tenantId, knowledgeBaseIds,
        );
    } else {
        rows = await prisma.$queryRawUnsafe<KbChunkHit[]>(
            `SELECT ${cols}
             FROM kb_document_chunks
             WHERE "tenantId" = $2
             ORDER BY embedding <=> $1::vector
             LIMIT ${Number(limit)}`,
            vectorLiteral, tenantId,
        );
    }

    return minScore > 0 ? rows.filter((r) => (typeof r.score === 'number' ? r.score : 0) >= minScore) : rows;
}
