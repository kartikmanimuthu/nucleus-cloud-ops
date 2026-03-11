import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { S3VectorsClient, QueryVectorsCommand } from '@aws-sdk/client-s3vectors';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { streamText } from 'ai';
import { getEmbedding } from '@/lib/knowledge-base/embedder';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { DEFAULT_TENANT_ID } from '@/lib/aws-config';

// ============================================================================
// AWS Clients
// ============================================================================

const credentialProvider = fromNodeProviderChain();

const s3VectorsClient = new S3VectorsClient({
  region: process.env.AWS_REGION || 'ap-south-1',
  credentials: credentialProvider,
});

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
const KB_VECTOR_BUCKET_NAME = process.env.KB_VECTOR_BUCKET_NAME;
const KB_VECTOR_INDEX_NAME =
  process.env.KB_VECTOR_INDEX_NAME || 'knowledge-base-embeddings';

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

    // Validate knowledgeBaseId ownership if provided
    if (knowledgeBaseId) {
      const kb = await KnowledgeBaseService.getKnowledgeBase(knowledgeBaseId, DEFAULT_TENANT_ID);
      if (!kb) {
        return NextResponse.json({ error: 'Knowledge base not found' }, { status: 404 });
      }
    }

    if (!KB_VECTOR_BUCKET_NAME) {
      console.error('[KB Query] Missing KB_VECTOR_BUCKET_NAME');
      return NextResponse.json(
        { error: 'Vector search is not configured. Check KB_VECTOR_BUCKET_NAME.' },
        { status: 503 },
      );
    }

    // 3. Embed the query
    const embedding = await getEmbedding(query);

    // 4. Query S3 Vectors
    const searchCommand = new QueryVectorsCommand({
      vectorBucketName: KB_VECTOR_BUCKET_NAME,
      indexName: KB_VECTOR_INDEX_NAME,
      queryVector: { float32: embedding },
      topK: 10,
      returnMetadata: true,
    });

    const searchResult = await s3VectorsClient.send(searchCommand);
    const rawVectors = searchResult.vectors || [];

    // 5. Filter by knowledgeBaseId if provided
    const filtered = knowledgeBaseId
      ? rawVectors.filter(
          (v) =>
            (v.metadata as Record<string, string> | undefined)?.knowledgeBaseId ===
            knowledgeBaseId,
        )
      : rawVectors;

    console.log(
      `[KB Query] Found ${filtered.length} results (of ${rawVectors.length} total) for: "${query.slice(0, 80)}"`,
    );

    // 6. Build context string from top results
    const contextString =
      filtered.length > 0
        ? filtered
            .map((v, i) => {
              const meta = (v.metadata || {}) as Record<string, string>;
              return `[${i + 1}] ${meta.documentName || 'Unknown Document'}\n${meta.text_content || ''}`;
            })
            .join('\n\n')
        : 'No relevant documents found in the knowledge base.';

    // 7. Build system prompt for document Q&A
    const systemPrompt = `You are a helpful assistant that answers questions based on the provided knowledge base documents.
Use only the information from the context below to answer questions.
If the answer is not found in the context, say so clearly.

Context:
${contextString}`;

    // 8. Build conversation history for multi-turn
    const conversationHistory = (messages || [])
      .filter((m) => m.content && m.content.trim())
      .map((m) => ({ role: m.role, content: m.content }));

    // 9. Stream response via Bedrock
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

    // 10. Build sources for X-AI-Sources header
    const sources: KBSource[] = filtered.map((v) => {
      const meta = (v.metadata || {}) as Record<string, string>;
      return {
        documentName: meta.documentName || 'Unknown',
        sourceType: meta.sourceType || 'file-upload',
        chunkIndex: meta.chunkIndex || '0',
        totalChunks: meta.totalChunks || '1',
        knowledgeBaseId: meta.knowledgeBaseId || '',
        dataSourceId: meta.dataSourceId || '',
        score: typeof (v as { score?: number }).score === 'number'
          ? (v as { score?: number }).score!
          : 0,
      };
    });

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
