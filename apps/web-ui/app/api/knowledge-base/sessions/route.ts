import { NextResponse } from 'next/server';
import { getSessionTenantId } from '@/lib/auth-session';
import { kbChatStore } from '@/lib/store/kb-chat-store';

// GET /api/knowledge-base/sessions — list saved KB chat sessions (tenant-shared)
export async function GET() {
  try {
    let tenantId: string;
    try {
      tenantId = await getSessionTenantId();
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const sessions = await kbChatStore.listSessions(tenantId);
    return NextResponse.json({ success: true, data: sessions });
  } catch (error) {
    console.error('API - Error listing KB chat sessions:', error);
    return NextResponse.json({ error: 'Failed to list sessions' }, { status: 500 });
  }
}
