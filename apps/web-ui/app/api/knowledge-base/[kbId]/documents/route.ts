import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { getSessionTenantId } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { validateDocumentInput } from '@/lib/knowledge-base/document-validation';
import { chunkText, embedAndStoreChunks } from '@/lib/knowledge-base/embedder';

// POST /api/knowledge-base/[kbId]/documents — create an inline markdown document
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ kbId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { kbId } = await params;
  const tenantId = await getSessionTenantId();
  const kb = await KnowledgeBaseService.getKnowledgeBase(kbId, tenantId);
  if (!kb) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const valid = validateDocumentInput(body as { name?: string; content?: string });
  if (!valid.ok) return NextResponse.json({ error: valid.error }, { status: 400 });
  const { name, content } = valid;

  // Create the record first (pending), then embed synchronously.
  const ds = await KnowledgeBaseService.createDataSource(kbId, {
    name,
    sourceType: 'document',
    config: { format: 'markdown', chunkCount: 0 },
  }, tenantId);
  await KnowledgeBaseService.updateDataSourceCount(kbId, 1, tenantId);

  try {
    const chunks = chunkText(content, name);
    const vectorKeys = await embedAndStoreChunks({
      chunks,
      knowledgeBaseId: kbId,
      dataSourceId: ds.id,
      sourceType: 'document',
      documentName: name,
      tenantId,
    });

    await KnowledgeBaseService.updateDataSource(kbId, ds.id, {
      content,
      status: 'synced',
      vectorKeys,
      vectorCount: vectorKeys.length,
      config: { format: 'markdown', chunkCount: vectorKeys.length },
      lastSyncAt: new Date().toISOString(),
    }, tenantId);
    await KnowledgeBaseService.updateVectorCount(kbId, vectorKeys.length, tenantId);

    AuditService.logUserAction({
      eventType: 'kb.document.created',
      severity: 'low',
      apiRoute: 'POST /api/knowledge-base/[kbId]/documents',
      httpMethod: 'POST',
      action: 'Created Document',
      resourceType: 'kb',
      resourceId: ds.id,
      resourceName: name,
      user: session?.user?.email || 'unknown',
      userType: 'user',
      status: 'success',
      details: `Created document "${name}" in knowledge base ${kbId}`,
      metadata: { tenantId, kbId, chunkCount: vectorKeys.length },
    }).catch(() => {});

    const updated = await KnowledgeBaseService.getDataSource(kbId, ds.id, tenantId);
    return NextResponse.json({ dataSource: updated }, { status: 201 });
  } catch (error) {
    const isProviderError = error instanceof Error && error.name === 'ProviderConfigError';
    const message = error instanceof Error ? error.message : 'Failed to embed document';
    // Preserve content so the user can retry with an edit. Best-effort — a
    // failure here shouldn't mask the original embedding error below.
    try {
      await KnowledgeBaseService.updateDataSource(kbId, ds.id, {
        content,
        status: 'error',
        lastErrorMessage: isProviderError ? 'No embedding provider configured' : 'Failed to process document',
        lastErrorDetail: message,
      }, tenantId);
    } catch {
      // ignore
    }
    return NextResponse.json({ error: message }, { status: isProviderError ? 400 : 500 });
  }
}
