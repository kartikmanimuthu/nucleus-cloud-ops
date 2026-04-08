import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { streamText } from 'ai';
import { getEmbedding } from '@/lib/knowledge-base/embedder';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { getSessionTenantId } from '@/lib/auth-session';
import { getPrismaClient } from '@/lib/db/pg-config';

// ============================================================================
// AWS Clients
// ============================================================================

const credentialProvider = fromNodeProviderChain();

function getBedrockClient() {
  return createAmazonBedrock({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentialProvider: async () => {
      const creds = await credentialProvider();
      return {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      };
    },
  });
}

// ============================================================================
// Config
// ============================================================================

const GENERATION_MODEL_ID =
  process.env.ASK_AI_GENERATION_MODEL || 'global.anthropic.claude-sonnet-4-6';

// ============================================================================
// Types
// ============================================================================

export type KBSource = {
  documentName: string;
  sourceType: string;
  chunkIndex: string;
  totalChunks: string;
  knowledgeBaseId: string;
  dataSourceId: string;
  score: number;
};

interface ChunkRow {
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

// ============================================================================
// POST /api/knowledge-base/query
// ============================================================================

export async function POST(req: NextRequest) {
  try {
    // 1. Auth check
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Validate request body
    const body = await req.json();
    const { query, knowledgeBaseId, messages } = body as {
      query?: string;
      knowledgeBaseId?: string;
      messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
    };

    if (!query || !query.trim()) {
      return NextResponse.json({ error: 'query is required' }, { status: 400 });
    }

    // Always extract tenantId — needed for ownership check and tenant scoping
    const tenantId = await getSessionTenantId();

    // Validate knowledgeBaseId ownership if provided
    if (knowledgeBaseId) {
      const kb = await KnowledgeBaseService.getKnowledgeBase(knowledgeBaseId, tenantId);
      if (!kb) {
        return NextResponse.json({ error: 'Knowledge base not found' }, { status: 404 });
      }
    }

    // 3. Embed the query
    const embedding = await getEmbedding(query);
    const vectorLiteral = `[${embedding.join(',')}]`;

    // 4. Query pgvector for similar chunks
    const prisma = getPrismaClient();
    let results: ChunkRow[];

    if (knowledgeBaseId) {
      results = await prisma.$queryRawUnsafe<ChunkRow[]>(
        `SELECT "vectorKey", "documentName", "sourceType", "chunkIndex", "totalChunks",
                "knowledgeBaseId", "dataSourceId", "textContent",
                1 - (embedding <=> $1::vector) as score
         FROM kb_document_chunks
         WHERE "tenantId" = $2
           AND "knowledgeBaseId" = $3
         ORDER BY embedding <=> $1::vector
         LIMIT 10`,
        vectorLiteral, tenantId, knowledgeBaseId,
      );
    } else {
      // No specific KB — scope to all tenant chunks via tenantId
      results = await prisma.$queryRawUnsafe<ChunkRow[]>(
        `SELECT "vectorKey", "documentName", "sourceType", "chunkIndex", "totalChunks",
                "knowledgeBaseId", "dataSourceId", "textContent",
                1 - (embedding <=> $1::vector) as score
         FROM kb_document_chunks
         WHERE "tenantId" = $2
         ORDER BY embedding <=> $1::vector
         LIMIT 10`,
        vectorLiteral, tenantId,
      );
    }

    console.log(
      `[KB Query] Found ${results.length} results for: "${query.slice(0, 80)}"`,
    );

    // 5. Build context string from top results
    const contextString =
      results.length > 0
        ? results
            .map((r, i) => `[${i + 1}] ${r.documentName || 'Unknown Document'}\n${r.textContent || ''}`)
            .join('\n\n')
        : 'No relevant documents found in the knowledge base.';

    // 6. Build system prompt for document Q&A
    const systemPrompt = `You are a helpful assistant that answers questions based on the provided knowledge base documents.
Use only the information from the context below to answer questions.
If the answer is not found in the context, say so clearly.

Context:
${contextString}`;

    // 7. Build conversation history for multi-turn
    const conversationHistory = (messages || [])
      .filter((m) => m.content && m.content.trim())
      .map((m) => ({ role: m.role, content: m.content }));

    // 8. Stream response via Bedrock
    const result = streamText({
      model: getBedrockClient()(GENERATION_MODEL_ID),
      system: systemPrompt,
      messages: [
        ...conversationHistory,
        { role: 'user', content: query },
      ],
      maxTokens: 1500,
      temperature: 0.1,
    });

    // 9. Build sources for X-AI-Sources header
    const sources: KBSource[] = results.map((r) => ({
      documentName: r.documentName || 'Unknown',
      sourceType: r.sourceType || 'file-upload',
      chunkIndex: String(r.chunkIndex ?? '0'),
      totalChunks: String(r.totalChunks ?? '1'),
      knowledgeBaseId: r.knowledgeBaseId || '',
      dataSourceId: r.dataSourceId || '',
      score: typeof r.score === 'number' ? r.score : 0,
    }));

    const sourcesJson = JSON.stringify(sources);

    const response = result.toTextStreamResponse({
      headers: {
        'X-AI-Sources': encodeURIComponent(sourcesJson),
      },
    });

    return response;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    console.error('[KB Query] Error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
