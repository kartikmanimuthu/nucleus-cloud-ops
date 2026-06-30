import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import type { MessageContent } from '@langchain/core/messages';
import { getEmbedding } from '@/lib/knowledge-base/embedder';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { getSessionTenantId, getSessionUserId } from '@/lib/auth-session';
import { getPrismaClient } from '@/lib/db/pg-config';
import { kbChatStore } from '@/lib/store/kb-chat-store';
import { resolveDefaultModelConfig, resolveModelConfig } from '@/lib/agent/model-resolver';
import { createAgentModels } from '@/lib/agent/model-factory';
import { isProviderConfigError } from '@/lib/agent/provider-errors';

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
    const { query, knowledgeBaseId, messages, sessionId, model, attachments } = body as {
      query?: string;
      knowledgeBaseId?: string;
      messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
      sessionId?: string;
      model?: string;
      attachments?: Array<{ name: string; contentType: string; url: string }>;
    };

    // Image attachments (data URLs) for multimodal questions — images only.
    const imageAttachments = (attachments ?? []).filter(
      (a) => a && typeof a.url === 'string' && a.url.startsWith('data:image/'),
    );

    if (!query || !query.trim()) {
      return NextResponse.json({ error: 'query is required' }, { status: 400 });
    }

    // Always extract tenantId — needed for ownership check and tenant scoping
    const tenantId = await getSessionTenantId();
    const userId = await getSessionUserId();

    // Validate knowledgeBaseId ownership if provided
    if (knowledgeBaseId) {
      const kb = await KnowledgeBaseService.getKnowledgeBase(knowledgeBaseId, tenantId);
      if (!kb) {
        return NextResponse.json({ error: 'Knowledge base not found' }, { status: 404 });
      }
    }

    // Resolve (or create) the persisted chat session for this conversation.
    let sid: string;
    if (sessionId) {
      const existing = await kbChatStore.getSession(tenantId, sessionId);
      if (!existing) {
        return NextResponse.json({ error: 'Session not found' }, { status: 404 });
      }
      sid = existing.id;
      await kbChatStore.touchSession(tenantId, sid);
    } else {
      sid = `${tenantId}:${userId}:${Date.now()}`;
      await kbChatStore.createSession({
        sessionId: sid,
        tenantId,
        userId,
        title: query.trim().slice(0, 60),
        knowledgeBaseId: knowledgeBaseId ?? null,
      });
    }

    // Persist the user message immediately (before opening the stream),
    // including any image attachments so a reloaded session re-shows them.
    await kbChatStore
      .addMessages(tenantId, sid, [{
        role: 'user',
        content: query.trim(),
        attachments: imageAttachments.length > 0
          ? imageAttachments.map((a) => ({ name: a.name, url: a.url }))
          : undefined,
      }])
      .catch((e) => console.error('[KB Query] Failed to persist user message:', e));

    // 3. Embed the query via the tenant's configured provider
    const embedding = await getEmbedding(query, tenantId);
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

    // 8. Resolve the model — honor the user-selected model if provided, else the
    //    tenant default. The resolver validates the model belongs to the tenant's
    //    enabled provider and decrypts its credentials (no extra authz needed).
    const resolvedModelConfig = model
      ? await resolveModelConfig(model, tenantId)
      : await resolveDefaultModelConfig(tenantId);
    const llm = createAgentModels({
      ...resolvedModelConfig,
      maxTokens: 1500,
    }).main;

    // Current-turn user message — multimodal when images are attached.
    const userContent: MessageContent =
      imageAttachments.length > 0
        ? [
            { type: 'text', text: query },
            ...imageAttachments.map((a) => ({ type: 'image_url', image_url: { url: a.url } })),
          ]
        : query;

    const lcMessages = [
      new SystemMessage(systemPrompt),
      ...conversationHistory.map((m) =>
        m.role === 'assistant' ? new AIMessage(m.content) : new HumanMessage(m.content),
      ),
      new HumanMessage({ content: userContent }),
    ];

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

    // 10. Stream the answer as plain text (provider-agnostic LangChain stream)
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let full = '';
        try {
          const llmStream = await llm.stream(lcMessages);
          for await (const chunk of llmStream) {
            const content = chunk.content;
            const text =
              typeof content === 'string'
                ? content
                : Array.isArray(content)
                  ? content
                      .filter((c): c is { type: string; text: string } => (c as { type?: string }).type === 'text')
                      .map((c) => c.text)
                      .join('')
                  : '';
            if (text) {
              full += text;
              controller.enqueue(encoder.encode(text));
            }
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        } finally {
          // Persist whatever was produced (handles partial/aborted streams too).
          // Never awaited inside the read loop; failure must not break streaming.
          if (full) {
            kbChatStore
              .addMessages(tenantId, sid, [{ role: 'assistant', content: full, sources }])
              .catch((e) => console.error('[KB Query] Failed to persist assistant message:', e));
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-AI-Sources': encodeURIComponent(sourcesJson),
        'X-KB-Session-Id': sid,
        'Access-Control-Expose-Headers': 'X-AI-Sources, X-KB-Session-Id',
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    console.error('[KB Query] Error:', error);
    // No configured provider → 400 with a clear "configure a provider" message.
    const status = isProviderConfigError(error) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
