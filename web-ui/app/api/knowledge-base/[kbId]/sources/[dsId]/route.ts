import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { deleteVectors } from '@/lib/knowledge-base/embedder';
import { DEFAULT_TENANT_ID } from '@/lib/aws-config';

// DELETE /api/knowledge-base/[kbId]/sources/[dsId]
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ kbId: string; dsId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { kbId, dsId } = await params;

    const ds = await KnowledgeBaseService.getDataSource(kbId, dsId);
    if (!ds) {
      return NextResponse.json({ error: 'Data source not found' }, { status: 404 });
    }

    // Delete vectors first
    if (ds.vectorKeys.length > 0) {
      await deleteVectors(ds.vectorKeys);
    }

    // Delete data source record
    await KnowledgeBaseService.deleteDataSource(kbId, dsId);

    // Decrement KB counters
    await Promise.all([
      KnowledgeBaseService.updateDataSourceCount(kbId, -1, DEFAULT_TENANT_ID),
      KnowledgeBaseService.updateVectorCount(kbId, -ds.vectorCount, DEFAULT_TENANT_ID),
    ]);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[KB Sources API] Error deleting data source:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete data source' },
      { status: 500 },
    );
  }
}
