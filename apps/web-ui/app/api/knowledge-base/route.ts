import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { getSessionTenantId } from '@/lib/auth-session';
import { getReadRowFilter } from '@/lib/rbac/row-filter';
import { AuditService } from '@/lib/audit-service';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    GET: { action: 'read', subject: 'KnowledgeBase' },
    POST: { action: 'create', subject: 'KnowledgeBase' },
};

// GET /api/knowledge-base
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const tenantId = await getSessionTenantId();
    // Gate 3. Layer 1 authz above settled WHETHER this caller may list
    // knowledge bases; this settles WHICH ones, in SQL, so the list stays honest.
    const knowledgeBases = await KnowledgeBaseService.listKnowledgeBases(tenantId, await getReadRowFilter('KnowledgeBase'));
    return NextResponse.json({ knowledgeBases });
  } catch (error) {
    console.error('[KB API] Error listing knowledge bases:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list knowledge bases' },
      { status: 500 },
    );
  }
}

// POST /api/knowledge-base
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let tenantId: string | undefined;
  try {
    tenantId = await getSessionTenantId();
    const body = await request.json();
    const { name, description } = body as { name?: string; description?: string };

    if (!name || !name.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    const knowledgeBase = await KnowledgeBaseService.createKnowledgeBase(
      { name: name.trim(), description },
      tenantId,
      session.user?.email ?? undefined,
    );

    AuditService.logUserAction({
      eventType: 'kb.knowledgebase.created',
      severity: 'medium',
      apiRoute: 'POST /api/knowledge-base',
      httpMethod: 'POST',
      action: 'Created Knowledge Base',
      resourceType: 'kb',
      resourceId: knowledgeBase.id,
      resourceName: knowledgeBase.name || knowledgeBase.id,
      user: session?.user?.email || 'unknown',
      userType: 'user',
      status: 'success',
      details: `Created knowledge base "${knowledgeBase.name}"`,
      metadata: { tenantId },
    }).catch(() => {});

    return NextResponse.json({ knowledgeBase }, { status: 201 });
  } catch (error) {
    console.error('[KB API] Error creating knowledge base:', error);
    AuditService.logUserAction({
      eventType: 'kb.knowledgebase.created',
      severity: 'medium',
      apiRoute: 'POST /api/knowledge-base',
      httpMethod: 'POST',
      action: 'Created Knowledge Base',
      resourceType: 'kb',
      resourceId: 'unknown',
      resourceName: 'unknown',
      user: session?.user?.email || 'unknown',
      userType: 'user',
      status: 'error',
      details: `Failed to create knowledge base: ${error instanceof Error ? error.message : 'Unknown error'}`,
      metadata: { ...(tenantId && { tenantId }) },
    }).catch(() => {});
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create knowledge base' },
      { status: 500 },
    );
  }
}
