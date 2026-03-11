import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import {
  parseFileContent,
  chunkText,
  embedAndStoreChunks,
} from '@/lib/knowledge-base/embedder';
import { DEFAULT_TENANT_ID } from '@/lib/aws-config';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/xml',
  'text/xml',
  'application/yaml',
  'text/yaml',
  'text/x-yaml',
]);

function isSupportedFile(mimeType: string, fileName: string): boolean {
  if (SUPPORTED_MIME_TYPES.has(mimeType)) return true;
  if (mimeType.startsWith('text/')) return true;
  const ext = fileName.split('.').pop()?.toLowerCase();
  return ['pdf', 'md', 'txt', 'csv', 'json', 'yaml', 'yml'].includes(ext ?? '');
}

// POST /api/knowledge-base/[kbId]/upload
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ kbId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { kbId } = await params;
  let dsId: string | null = null;

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File size exceeds 10 MB limit (got ${Math.round(file.size / 1024 / 1024)}MB)` },
        { status: 400 },
      );
    }

    if (!isSupportedFile(file.type, file.name)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${file.type || file.name}` },
        { status: 400 },
      );
    }

    // Parse content
    const buffer = Buffer.from(await file.arrayBuffer());
    const text = await parseFileContent(buffer, file.type, file.name);

    // Chunk text
    const chunks = chunkText(text, file.name);

    // Create data source record in 'syncing' state
    const ds = await KnowledgeBaseService.createDataSource(kbId, {
      name: file.name,
      sourceType: 'file-upload',
      config: {
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
        s3Key: '',
        chunkCount: chunks.length,
      },
    });
    dsId = ds.id;

    // Update status to syncing
    await KnowledgeBaseService.updateDataSource(kbId, ds.id, { status: 'syncing' });

    // Embed and store chunks
    const vectorKeys = await embedAndStoreChunks({
      chunks,
      knowledgeBaseId: kbId,
      dataSourceId: ds.id,
      sourceType: 'file-upload',
      documentName: file.name,
      extraMetadata: { s3Key: '' },
    });

    // Update data source to synced
    await KnowledgeBaseService.updateDataSource(kbId, ds.id, {
      status: 'synced',
      vectorCount: vectorKeys.length,
      vectorKeys,
      lastSyncAt: new Date().toISOString(),
    });

    // Update KB counters
    await Promise.all([
      KnowledgeBaseService.updateDataSourceCount(kbId, 1, DEFAULT_TENANT_ID),
      KnowledgeBaseService.updateVectorCount(kbId, vectorKeys.length, DEFAULT_TENANT_ID),
    ]);

    // Return updated data source
    const updatedDs = await KnowledgeBaseService.getDataSource(kbId, ds.id);

    return NextResponse.json({ dataSource: updatedDs ?? ds, vectorCount: vectorKeys.length });
  } catch (error) {
    console.error('[KB Upload API] Error uploading file:', error);

    // Mark data source as errored if it was created
    if (dsId) {
      try {
        await KnowledgeBaseService.updateDataSource(kbId, dsId, {
          status: 'error',
          lastSyncError: error instanceof Error ? error.message : 'Unknown error',
        });
      } catch (updateErr) {
        console.error('[KB Upload API] Error updating data source status:', updateErr);
      }
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to upload file' },
      { status: 500 },
    );
  }
}
