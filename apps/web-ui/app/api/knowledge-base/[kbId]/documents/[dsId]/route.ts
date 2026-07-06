import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { getSessionTenantId } from '@/lib/auth-session';

// GET /api/knowledge-base/[kbId]/documents/[dsId] — read a document's markdown body
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
  if (!ds || ds.sourceType !== 'document') {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 });
  }
  const content = await KnowledgeBaseService.getDataSourceContent(kbId, dsId, tenantId);
  return NextResponse.json({ id: ds.id, name: ds.name, content: content ?? '' });
}
