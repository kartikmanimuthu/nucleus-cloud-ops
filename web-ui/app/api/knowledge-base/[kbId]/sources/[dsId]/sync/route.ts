import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { getSessionTenantId } from '@/lib/auth-session';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { S3BucketConfig, ConfluenceConfig, BitbucketConfig } from '@/lib/knowledge-base/types';

const sqs = new SQSClient({ region: process.env.AWS_REGION });
const KB_SYNC_QUEUE_URL = process.env.KB_SYNC_QUEUE_URL!;

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

  const ds = await KnowledgeBaseService.getDataSource(kbId, dsId);
  if (!ds) return NextResponse.json({ error: 'Data source not found' }, { status: 404 });
  if (ds.sourceType === 'file-upload') return NextResponse.json({ error: 'Re-sync not supported for file uploads' }, { status: 400 });

  const jobType = JOB_TYPE_MAP[ds.sourceType as keyof typeof JOB_TYPE_MAP];
  if (!jobType) return NextResponse.json({ error: `Unsupported source type: ${ds.sourceType}` }, { status: 400 });

  // Mark as syncing immediately
  await KnowledgeBaseService.updateDataSource(kbId, dsId, { status: 'syncing' });

  // Enqueue background job — pass old vector keys so Lambda can clean them up
  await sqs.send(new SendMessageCommand({
    QueueUrl: KB_SYNC_QUEUE_URL,
    MessageBody: JSON.stringify({
      type: jobType,
      kbId,
      dsId,
      oldVectorKeys: ds.vectorKeys,
      config: ds.config as S3BucketConfig | ConfluenceConfig | BitbucketConfig,
    }),
  }));

  return NextResponse.json({ success: true, status: 'syncing' }, { status: 202 });
}
