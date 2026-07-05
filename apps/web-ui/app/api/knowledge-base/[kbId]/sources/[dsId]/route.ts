import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { chunkText, embedAndStoreChunks, deleteVectors } from '@/lib/knowledge-base/embedder';
import { validateDocumentInput } from '@/lib/knowledge-base/document-validation';
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

  const body = await request.json() as { name?: string; content?: string; config?: Record<string, unknown> };
  const updates: Partial<DataSource> = {};
  if (body.name?.trim()) updates.name = body.name.trim();

  // Document content edit → re-embed.
  if (ds.sourceType === 'document' && body.content !== undefined) {
    const valid = validateDocumentInput({ name: body.name ?? ds.name, content: body.content });
    if (!valid.ok) return NextResponse.json({ error: valid.error }, { status: 400 });
    try {
      const chunks = chunkText(valid.content, valid.name);
      const vectorKeys = await embedAndStoreChunks({
        chunks, knowledgeBaseId: kbId, dataSourceId: dsId,
        sourceType: 'document', documentName: valid.name, tenantId,
      });
      // Embed succeeded — only now remove the stale keys no longer present in
      // the new set, so a failed embed never leaves the document un-searchable.
      const staleKeys = ds.vectorKeys.filter((k) => !vectorKeys.includes(k));
      if (staleKeys.length > 0) await deleteVectors(staleKeys);
      updates.content = valid.content;
      updates.vectorKeys = vectorKeys;
      updates.vectorCount = vectorKeys.length;
      updates.status = 'synced';
      updates.config = { format: 'markdown', chunkCount: vectorKeys.length };
      updates.lastSyncAt = new Date().toISOString();
      await KnowledgeBaseService.updateDataSource(kbId, dsId, updates, tenantId);
      await KnowledgeBaseService.updateVectorCount(kbId, vectorKeys.length - ds.vectorCount, tenantId);
    } catch (error) {
      const isProviderError = error instanceof Error && error.name === 'ProviderConfigError';
      const message = error instanceof Error ? error.message : 'Failed to embed document';
      try {
        await KnowledgeBaseService.updateDataSource(kbId, dsId, {
          content: valid.content, status: 'error',
          lastErrorMessage: isProviderError ? 'No embedding provider configured' : 'Failed to process document',
          lastErrorDetail: message,
        }, tenantId);
      } catch {
        // best-effort error status write
      }
      return NextResponse.json({ error: message }, { status: isProviderError ? 400 : 500 });
    }
  } else {
    if (body.config) updates.config = { ...ds.config, ...body.config } as DataSource['config'];
    await KnowledgeBaseService.updateDataSource(kbId, dsId, updates, tenantId);
  }

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
