import { NextResponse } from 'next/server';
import { getSessionTenantId, getSessionUserId } from '@/lib/auth-session';
import { kbChatStore } from '@/lib/store/kb-chat-store';
import { AuditService } from '@/lib/audit-service';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    DELETE: { action: 'delete', subject: 'KnowledgeBase' },
};

// DELETE /api/knowledge-base/sessions/[sessionId] — delete a KB chat session (tenant-shared)
export async function DELETE(
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

    // Existence + tenant scope check (404 hides cross-tenant existence)
    const existing = await kbChatStore.getSession(tenantId, sessionId);
    if (!existing) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const ok = await kbChatStore.deleteSession(tenantId, sessionId);
    if (!ok) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    AuditService.logUserAction({
      eventType: 'kb.chat.session.deleted',
      severity: 'low',
      apiRoute: 'DELETE /api/knowledge-base/sessions/[sessionId]',
      httpMethod: 'DELETE',
      action: 'Deleted KB Chat Session',
      resourceType: 'kb-chat',
      resourceId: sessionId,
      resourceName: existing.title,
      user: await getSessionUserId().catch(() => 'unknown'),
      userType: 'user',
      status: 'success',
      details: `Deleted KB chat session ${sessionId}`,
      tenantId,
    }).catch(() => {});

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('API - Error deleting KB chat session:', error);
    return NextResponse.json({ error: 'Failed to delete session' }, { status: 500 });
  }
}
