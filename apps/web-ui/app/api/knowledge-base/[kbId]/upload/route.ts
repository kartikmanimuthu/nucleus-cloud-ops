import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { getSessionTenantId } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { getBoss } from '@/lib/boss-client';

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const SUPPORTED_MIME = new Set(['application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json', 'text/yaml', 'application/x-yaml']);
const SUPPORTED_EXT = new Set(['pdf', 'md', 'txt', 'csv', 'json', 'yaml', 'yml']);

const s3 = new S3Client({ region: process.env.AWS_REGION });

const KB_STAGING_BUCKET = process.env.APP_BUCKET_NAME!;

function isSupportedFile(mimeType: string, fileName: string): boolean {
  if (SUPPORTED_MIME.has(mimeType)) return true;
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return SUPPORTED_EXT.has(ext);
}

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

  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  if (file.size > MAX_FILE_SIZE) return NextResponse.json({ error: `File exceeds 10 MB limit` }, { status: 400 });
  if (!isSupportedFile(file.type, file.name)) return NextResponse.json({ error: `Unsupported file type: ${file.type || file.name}` }, { status: 400 });

  // Stage file to S3
  const stagingKey = `kb-staging/tenants/${tenantId}/uploads/${kbId}/${randomUUID()}/${file.name}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  await s3.send(new PutObjectCommand({
    Bucket: KB_STAGING_BUCKET,
    Key: stagingKey,
    Body: buffer,
    ContentType: file.type || 'application/octet-stream',
  }));

  // Create data source record in 'syncing' state
  const ds = await KnowledgeBaseService.createDataSource(kbId, {
    name: file.name,
    sourceType: 'file-upload',
    config: { fileName: file.name, fileSize: file.size, mimeType: file.type, s3Key: stagingKey, chunkCount: 0 },
  }, tenantId);
  await KnowledgeBaseService.updateDataSource(kbId, ds.id, { status: 'syncing' }, tenantId);
  await KnowledgeBaseService.updateDataSourceCount(kbId, 1, tenantId);

  // Enqueue background job via pg-boss
  const boss = await getBoss();
  await boss.send('kb-sync', { type: 'file-upload', kbId, dsId: ds.id, tenantId, stagingKey, fileName: file.name, mimeType: file.type });

  AuditService.logUserAction({
    eventType: 'kb.file.uploaded',
    severity: 'low',
    apiRoute: 'POST /api/knowledge-base/[kbId]/upload',
    httpMethod: 'POST',
    action: 'Uploaded File',
    resourceType: 'kb',
    resourceId: ds.id,
    resourceName: file.name,
    user: session?.user?.email || 'unknown',
    userType: 'user',
    status: 'success',
    details: `Uploaded file "${file.name}" (${file.size} bytes) to knowledge base ${kbId}`,
    metadata: { tenantId, kbId, fileName: file.name, fileSize: file.size },
  }).catch(() => {});

  return NextResponse.json({ dataSource: ds }, { status: 202 });
}
