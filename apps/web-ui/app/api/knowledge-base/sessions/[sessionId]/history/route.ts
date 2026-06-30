import { NextResponse } from 'next/server';
import { getSessionTenantId } from '@/lib/auth-session';
import { kbChatStore } from '@/lib/store/kb-chat-store';

// GET /api/knowledge-base/sessions/[sessionId]/history
// Returns the session's messages plus its stored knowledgeBaseId so the client can
// hydrate both the conversation and the KB selector in one call.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  try {
    const { sessionId } = await params;

    let tenantId: string;
    try {
      tenantId = await getSessionTenantId();
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const session = await kbChatStore.getSession(tenantId, sessionId);
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const messages = await kbChatStore.getMessages(tenantId, sessionId);
    return NextResponse.json({
      success: true,
      data: { messages, knowledgeBaseId: session.knowledgeBaseId, title: session.title },
    });
  } catch (error) {
    console.error('API - Error loading KB chat history:', error);
    return NextResponse.json({ error: 'Failed to load history' }, { status: 500 });
  }
}
