import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { getSessionTenantId } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { getBoss } from '@/lib/boss-client';
import type { S3BucketConfig, ConfluenceConfig, BitbucketConfig } from '@/lib/knowledge-base/types';

const JOB_TYPE_MAP = {
  's3-bucket': 's3-sync',
  'confluence': 'confluence-sync',
  'bitbucket': 'bitbucket-sync',
} as const;

export async function POST(
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
  if (ds.sourceType === 'file-upload') return NextResponse.json({ error: 'Re-sync not supported for file uploads' }, { status: 400 });

  const jobType = JOB_TYPE_MAP[ds.sourceType as keyof typeof JOB_TYPE_MAP];
  if (!jobType) return NextResponse.json({ error: `Unsupported source type: ${ds.sourceType}` }, { status: 400 });

  // Mark as syncing immediately
  await KnowledgeBaseService.updateDataSource(kbId, dsId, { status: 'syncing' }, tenantId);

  // Enqueue background job via pg-boss
  const boss = await getBoss();
  await boss.send('kb-sync', {
    type: jobType,
    kbId,
    dsId,
    tenantId,
    oldVectorKeys: ds.vectorKeys,
    config: ds.config as S3BucketConfig | ConfluenceConfig | BitbucketConfig,
  });

  AuditService.logUserAction({
    eventType: 'kb.datasource.sync_triggered',
    severity: 'low',
    apiRoute: 'POST /api/knowledge-base/[kbId]/sources/[dsId]/sync',
    httpMethod: 'POST',
    action: 'Triggered Data Source Sync',
    resourceType: 'kb',
    resourceId: dsId,
    resourceName: ds.name || dsId,
    user: session?.user?.email || 'unknown',
    userType: 'user',
    status: 'success',
    details: `Triggered sync for data source "${ds.name || dsId}" (type: ${ds.sourceType}) in knowledge base ${kbId}`,
    metadata: { tenantId, kbId, sourceType: ds.sourceType },
  }).catch(() => {});

  return NextResponse.json({ success: true, status: 'syncing' }, { status: 202 });
}
