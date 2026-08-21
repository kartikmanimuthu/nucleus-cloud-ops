import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { deleteVectors } from '@/lib/knowledge-base/embedder';
import { getSessionTenantId } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import type { DataSource } from '@/lib/knowledge-base/types';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    GET: { action: 'read', subject: 'KnowledgeBase' },
    PUT: { action: 'update', subject: 'KnowledgeBase' },
    DELETE: { action: 'delete', subject: 'KnowledgeBase' },
};

function sanitizeDataSource(ds: DataSource): DataSource {
  if (ds.sourceType === 'bitbucket') {
    return {
      ...ds,
      config: { ...(ds.config as Record<string, unknown>), apiToken: '***' },
    };
  }
  return ds;
}

// GET /api/knowledge-base/[kbId]
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ kbId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { kbId } = await params;
    const tenantId = await getSessionTenantId();
    const [knowledgeBase, dataSources] = await Promise.all([
      KnowledgeBaseService.getKnowledgeBase(kbId, tenantId),
      KnowledgeBaseService.listDataSources(kbId, tenantId),
    ]);

    if (!knowledgeBase) {
      return NextResponse.json({ error: 'Knowledge base not found' }, { status: 404 });
    }

    return NextResponse.json({ knowledgeBase, dataSources: dataSources.map(sanitizeDataSource) });
  } catch (error) {
    console.error('[KB API] Error getting knowledge base:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get knowledge base' },
      { status: 500 },
    );
  }
}

// PUT /api/knowledge-base/[kbId]
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ kbId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { kbId } = await params;
    const tenantId = await getSessionTenantId();
    const body = await request.json();
    const { name, description, status } = body as {
      name?: string;
      description?: string;
      status?: 'active' | 'inactive';
    };

    const existing = await KnowledgeBaseService.getKnowledgeBase(kbId, tenantId);
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
    }

    if (status !== undefined) {
      if (status !== 'active' && status !== 'inactive') {
        return NextResponse.json(
          { success: false, error: "status must be 'active' or 'inactive'" },
          { status: 400 },
        );
      }
      await KnowledgeBaseService.setKnowledgeBaseStatus(kbId, tenantId, status);
    }

    if (name !== undefined || description !== undefined) {
      await KnowledgeBaseService.updateKnowledgeBase(kbId, { name, description }, tenantId);
    }

    AuditService.logUserAction({
      eventType: 'kb.knowledgebase.updated',
      severity: 'medium',
      apiRoute: 'PUT /api/knowledge-base/[kbId]',
      httpMethod: 'PUT',
      action: status !== undefined ? `${status === 'active' ? 'Activated' : 'Deactivated'} Knowledge Base` : 'Updated Knowledge Base',
      resourceType: 'kb',
      resourceId: kbId,
      resourceName: name || existing.name || kbId,
      user: session?.user?.email || 'unknown',
      userType: 'user',
      status: 'success',
      details: status !== undefined
        ? `Set knowledge base "${existing.name || kbId}" status to ${status}`
        : `Updated knowledge base "${name || kbId}"`,
      metadata: { tenantId },
    }).catch(() => {});

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[KB API] Error updating knowledge base:', error);
    AuditService.logUserAction({
      eventType: 'kb.knowledgebase.updated',
      severity: 'medium',
      apiRoute: 'PUT /api/knowledge-base/[kbId]',
      httpMethod: 'PUT',
      action: 'Updated Knowledge Base',
      resourceType: 'kb',
      resourceId: 'unknown',
      resourceName: 'unknown',
      user: session?.user?.email || 'unknown',
      userType: 'user',
      status: 'error',
      details: `Failed to update knowledge base: ${error instanceof Error ? error.message : 'Unknown error'}`,
      metadata: {},
    }).catch(() => {});
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update knowledge base' },
      { status: 500 },
    );
  }
}

// DELETE /api/knowledge-base/[kbId]
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ kbId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { kbId } = await params;
    const tenantId = await getSessionTenantId();

    // Pre-flight ownership check
    const kb = await KnowledgeBaseService.getKnowledgeBase(kbId, tenantId);
    if (!kb) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
    }

    // 1. Get all data sources
    const dataSources = await KnowledgeBaseService.listDataSources(kbId, tenantId);

    // 2. Cascade delete: vectors then data source records
    for (const ds of dataSources) {
      if (ds.vectorKeys.length > 0) {
        await deleteVectors(ds.vectorKeys);
      }
      await KnowledgeBaseService.deleteDataSource(kbId, ds.id, tenantId);
    }

    // 3. Delete the knowledge base itself
    await KnowledgeBaseService.deleteKnowledgeBase(kbId, tenantId);

    AuditService.logUserAction({
      eventType: 'kb.knowledgebase.deleted',
      severity: 'high',
      apiRoute: 'DELETE /api/knowledge-base/[kbId]',
      httpMethod: 'DELETE',
      action: 'Deleted Knowledge Base',
      resourceType: 'kb',
      resourceId: kbId,
      resourceName: kb.name || kbId,
      user: session?.user?.email || 'unknown',
      userType: 'user',
      status: 'success',
      details: `Deleted knowledge base "${kb.name || kbId}" and ${dataSources.length} data source(s)`,
      metadata: { tenantId },
    }).catch(() => {});

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[KB API] Error deleting knowledge base:', error);
    AuditService.logUserAction({
      eventType: 'kb.knowledgebase.deleted',
      severity: 'high',
      apiRoute: 'DELETE /api/knowledge-base/[kbId]',
      httpMethod: 'DELETE',
      action: 'Deleted Knowledge Base',
      resourceType: 'kb',
      resourceId: 'unknown',
      resourceName: 'unknown',
      user: session?.user?.email || 'unknown',
      userType: 'user',
      status: 'error',
      details: `Failed to delete knowledge base: ${error instanceof Error ? error.message : 'Unknown error'}`,
      metadata: {},
    }).catch(() => {});
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete knowledge base' },
      { status: 500 },
    );
  }
}
