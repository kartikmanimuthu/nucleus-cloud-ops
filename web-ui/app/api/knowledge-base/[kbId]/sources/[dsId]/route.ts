import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { deleteVectors } from '@/lib/knowledge-base/embedder';
import { getSessionTenantId } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import type { DataSource } from '@/lib/knowledge-base/types';

function sanitize(ds: DataSource): DataSource {
  if (ds.sourceType === 'bitbucket') {
    return { ...ds, config: { ...(ds.config as Record<string, unknown>), apiToken: '***' } };
  }
  return ds;
}

// GET /api/knowledge-base/[kbId]/sources/[dsId] — status polling
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ kbId: string; dsId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { kbId, dsId } = await params;
  const tenantId = await getSessionTenantId();
  const kb = await KnowledgeBaseService.getKnowledgeBase(kbId, tenantId);
  if (!kb) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });

  const ds = await KnowledgeBaseService.getDataSource(kbId, dsId, tenantId);
  if (!ds) return NextResponse.json({ error: 'Data source not found' }, { status: 404 });

  return NextResponse.json({ dataSource: sanitize(ds) });
}

// PUT /api/knowledge-base/[kbId]/sources/[dsId] — edit config/name
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ kbId: string; dsId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { kbId, dsId } = await params;
  const tenantId = await getSessionTenantId();
  const kb = await KnowledgeBaseService.getKnowledgeBase(kbId, tenantId);
  if (!kb) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });

  const ds = await KnowledgeBaseService.getDataSource(kbId, dsId, tenantId);
  if (!ds) return NextResponse.json({ error: 'Data source not found' }, { status: 404 });

  const body = await request.json() as { name?: string; config?: Record<string, unknown> };
  const updates: Partial<DataSource> = {};
  if (body.name?.trim()) updates.name = body.name.trim();
  if (body.config) updates.config = { ...ds.config, ...body.config } as DataSource['config'];

  await KnowledgeBaseService.updateDataSource(kbId, dsId, updates, tenantId);
  const updated = await KnowledgeBaseService.getDataSource(kbId, dsId, tenantId);

  AuditService.logUserAction({
    eventType: 'kb.datasource.updated',
    severity: 'medium',
    apiRoute: 'PUT /api/knowledge-base/[kbId]/sources/[dsId]',
    httpMethod: 'PUT',
    action: 'Updated Data Source',
    resourceType: 'kb',
    resourceId: dsId,
    resourceName: updated?.name || dsId,
    user: session?.user?.email || 'unknown',
    userType: 'user',
    status: 'success',
    details: `Updated data source "${updated?.name || dsId}" in knowledge base ${kbId}`,
    metadata: { tenantId, kbId },
  }).catch(() => {});

  return NextResponse.json({ dataSource: sanitize(updated!) });
}

// DELETE /api/knowledge-base/[kbId]/sources/[dsId]
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ kbId: string; dsId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { kbId, dsId } = await params;
  const tenantId = await getSessionTenantId();
  const kb = await KnowledgeBaseService.getKnowledgeBase(kbId, tenantId);
  if (!kb) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });

  const ds = await KnowledgeBaseService.getDataSource(kbId, dsId, tenantId);
  if (!ds) return NextResponse.json({ error: 'Data source not found' }, { status: 404 });

  if (ds.vectorKeys.length > 0) await deleteVectors(ds.vectorKeys);
  await KnowledgeBaseService.deleteDataSource(kbId, dsId, tenantId);
  await Promise.all([
    KnowledgeBaseService.updateDataSourceCount(kbId, -1, tenantId),
    KnowledgeBaseService.updateVectorCount(kbId, -ds.vectorCount, tenantId),
  ]);

  AuditService.logUserAction({
    eventType: 'kb.datasource.deleted',
    severity: 'high',
    apiRoute: 'DELETE /api/knowledge-base/[kbId]/sources/[dsId]',
    httpMethod: 'DELETE',
    action: 'Deleted Data Source',
    resourceType: 'kb',
    resourceId: dsId,
    resourceName: ds.name || dsId,
    user: session?.user?.email || 'unknown',
    userType: 'user',
    status: 'success',
    details: `Deleted data source "${ds.name || dsId}" from knowledge base ${kbId}`,
    metadata: { tenantId, kbId },
  }).catch(() => {});

  return NextResponse.json({ success: true });
}
