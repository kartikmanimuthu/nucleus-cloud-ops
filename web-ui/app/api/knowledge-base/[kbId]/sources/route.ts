import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { getSessionTenantId } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import type { CreateDataSourceInput, DataSource } from '@/lib/knowledge-base/types';

function sanitizeDataSource(ds: DataSource): DataSource {
  if (ds.sourceType === 'bitbucket') {
    return {
      ...ds,
      config: { ...(ds.config as Record<string, unknown>), apiToken: '***' },
    };
  }
  return ds;
}

// GET /api/knowledge-base/[kbId]/sources
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
    const kb = await KnowledgeBaseService.getKnowledgeBase(kbId, tenantId);
    if (!kb) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
    }
    const dataSources = await KnowledgeBaseService.listDataSources(kbId, tenantId);
    return NextResponse.json({ dataSources: dataSources.map(sanitizeDataSource) });
  } catch (error) {
    console.error('[KB Sources API] Error listing data sources:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list data sources' },
      { status: 500 },
    );
  }
}

// POST /api/knowledge-base/[kbId]/sources
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ kbId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { kbId } = await params;
    const body = await request.json();
    const input = body as CreateDataSourceInput;

    if (!input.name || !input.name.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (!input.sourceType) {
      return NextResponse.json({ error: 'sourceType is required' }, { status: 400 });
    }

    const tenantId = await getSessionTenantId();
    const kb = await KnowledgeBaseService.getKnowledgeBase(kbId, tenantId);
    if (!kb) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
    }

    const dataSource = await KnowledgeBaseService.createDataSource(kbId, {
      name: input.name.trim(),
      sourceType: input.sourceType,
      config: input.config,
    }, tenantId);

    await KnowledgeBaseService.updateDataSourceCount(kbId, 1, tenantId);

    AuditService.logUserAction({
      action: 'Created Data Source',
      resourceType: 'kb',
      resourceId: dataSource.id,
      resourceName: dataSource.name || dataSource.id,
      user: session?.user?.email || 'unknown',
      userType: 'user',
      status: 'success',
      details: `Created data source "${dataSource.name}" in knowledge base ${kbId}`,
      metadata: { tenantId, kbId, sourceType: input.sourceType },
    }).catch(() => {});

    return NextResponse.json({ dataSource: sanitizeDataSource(dataSource) }, { status: 201 });
  } catch (error) {
    console.error('[KB Sources API] Error creating data source:', error);
    AuditService.logUserAction({
      action: 'Created Data Source',
      resourceType: 'kb',
      resourceId: 'unknown',
      resourceName: 'unknown',
      user: session?.user?.email || 'unknown',
      userType: 'user',
      status: 'error',
      details: `Failed to create data source: ${error instanceof Error ? error.message : 'Unknown error'}`,
      metadata: {},
    }).catch(() => {});
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create data source' },
      { status: 500 },
    );
  }
}
