import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import {
  chunkText,
  embedAndStoreChunks,
  deleteVectors,
  parseFileContent,
} from '@/lib/knowledge-base/embedder';
import { DEFAULT_TENANT_ID } from '@/lib/aws-config';
import type {
  S3BucketConfig,
  ConfluenceConfig,
  BitbucketConfig,
} from '@/lib/knowledge-base/types';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

const AWS_REGION = process.env.AWS_REGION || 'ap-south-1';
const MAX_FILES_PER_SYNC = 50;

// ---------------------------------------------------------------------------
// SSRF protection
// ---------------------------------------------------------------------------

const BLOCKED_PATTERNS = [
  /^https?:\/\/localhost/i,
  /^https?:\/\/127\./,
  /^https?:\/\/10\./,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
  /^https?:\/\/192\.168\./,
  /^https?:\/\/169\.254\./,
  /^https?:\/\/\[::1\]/,
  /^https?:\/\/\[fd/i,
];

function validateExternalUrl(url: string): void {
  if (!url.startsWith('https://') && !url.startsWith('http://')) {
    throw new Error(`Invalid URL scheme: ${url}`);
  }
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(url)) {
      throw new Error(`URL points to a private/internal network address: ${url}`);
    }
  }
}

// ---------------------------------------------------------------------------
// MIME type helpers
// ---------------------------------------------------------------------------

function getMimeType(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'pdf':
      return 'application/pdf';
    case 'md':
    case 'txt':
      return 'text/plain';
    case 'json':
      return 'application/json';
    case 'csv':
      return 'text/csv';
    case 'yaml':
    case 'yml':
      return 'text/yaml';
    default:
      return 'text/plain';
  }
}

const SUPPORTED_EXTENSIONS = new Set(['pdf', 'md', 'txt', 'json', 'csv', 'yaml', 'yml']);

function isSupportedKey(key: string): boolean {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  return SUPPORTED_EXTENSIONS.has(ext);
}

// ---------------------------------------------------------------------------
// HTML stripping helper (Confluence)
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// S3 Bucket sync
// ---------------------------------------------------------------------------

async function syncS3Bucket(
  config: S3BucketConfig,
  kbId: string,
  dsId: string,
): Promise<{ vectorKeys: string[]; count: number }> {
  const s3 = new S3Client({
    region: config.region || AWS_REGION,
    credentials: fromNodeProviderChain(),
  });

  // List objects
  const listResp = await s3.send(
    new ListObjectsV2Command({
      Bucket: config.bucketName,
      Prefix: config.prefix,
      MaxKeys: MAX_FILES_PER_SYNC,
    }),
  );

  let objects = (listResp.Contents || []).filter((obj) => obj.Key && isSupportedKey(obj.Key));

  // Filter by file patterns if provided
  if (config.filePatterns && config.filePatterns.length > 0) {
    objects = objects.filter((obj) => {
      const key = obj.Key!;
      return config.filePatterns!.some((pattern) => {
        const substring = pattern.replace(/\*/g, '');
        return substring === '' || key.includes(substring);
      });
    });
  }

  const allVectorKeys: string[] = [];

  for (const obj of objects.slice(0, MAX_FILES_PER_SYNC)) {
    const key = obj.Key!;
    try {
      const getResp = await s3.send(
        new GetObjectCommand({ Bucket: config.bucketName, Key: key }),
      );

      // Convert stream to Buffer
      const chunks: Uint8Array[] = [];
      for await (const chunk of getResp.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      const mimeType = getMimeType(key);
      const fileName = key.split('/').pop() || key;

      const text = await parseFileContent(buffer, mimeType, fileName);
      const kbChunks = chunkText(text, fileName);

      const vectorKeys = await embedAndStoreChunks({
        chunks: kbChunks,
        knowledgeBaseId: kbId,
        dataSourceId: dsId,
        sourceType: 's3-bucket',
        documentName: fileName,
        extraMetadata: { s3Key: key },
      });

      allVectorKeys.push(...vectorKeys);
    } catch (err) {
      console.error(`[KB Sync S3] Skipping ${key}:`, err);
    }
  }

  return { vectorKeys: allVectorKeys, count: allVectorKeys.length };
}

// ---------------------------------------------------------------------------
// Confluence sync
// ---------------------------------------------------------------------------

async function syncConfluence(
  config: ConfluenceConfig,
  kbId: string,
  dsId: string,
): Promise<{ vectorKeys: string[]; count: number }> {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  validateExternalUrl(baseUrl);
  const allVectorKeys: string[] = [];

  let pages: Array<{ id: string; title: string; body: string }> = [];

  if (config.pageIds && config.pageIds.length > 0) {
    // Fetch specific pages
    for (const pageId of config.pageIds.slice(0, MAX_FILES_PER_SYNC)) {
      try {
        const url = `${baseUrl}/wiki/rest/api/content/${pageId}?expand=body.view.value`;
        const resp = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!resp.ok) {
          console.error(`[KB Sync Confluence] Failed to fetch page ${pageId}: ${resp.status}`);
          continue;
        }
        const data = await resp.json();
        pages.push({
          id: data.id,
          title: data.title || pageId,
          body: data.body?.view?.value || '',
        });
      } catch (err) {
        console.error(`[KB Sync Confluence] Error fetching page ${pageId}:`, err);
      }
    }
  } else {
    // Fetch by space key
    try {
      const url = `${baseUrl}/wiki/rest/api/content?spaceKey=${encodeURIComponent(config.spaceKey)}&expand=body.view.value&limit=25`;
      const resp = await fetch(url, { headers: { Accept: 'application/json' } });
      if (resp.ok) {
        const data = await resp.json();
        const results: Array<{ id: string; title: string; body?: { view?: { value?: string } } }> =
          data.results || [];
        pages = results.slice(0, MAX_FILES_PER_SYNC).map((p) => ({
          id: p.id,
          title: p.title,
          body: p.body?.view?.value || '',
        }));
      } else {
        console.error(`[KB Sync Confluence] Failed to fetch space ${config.spaceKey}: ${resp.status}`);
      }
    } catch (err) {
      console.error('[KB Sync Confluence] Error fetching space:', err);
    }
  }

  for (const page of pages) {
    try {
      const text = stripHtml(page.body);
      if (!text) continue;

      const kbChunks = chunkText(text, page.title);
      const vectorKeys = await embedAndStoreChunks({
        chunks: kbChunks,
        knowledgeBaseId: kbId,
        dataSourceId: dsId,
        sourceType: 'confluence',
        documentName: page.title,
        extraMetadata: { confluencePageId: page.id },
      });
      allVectorKeys.push(...vectorKeys);
    } catch (err) {
      console.error(`[KB Sync Confluence] Error processing page ${page.id}:`, err);
    }
  }

  return { vectorKeys: allVectorKeys, count: allVectorKeys.length };
}

// ---------------------------------------------------------------------------
// Bitbucket sync
// ---------------------------------------------------------------------------

async function syncBitbucket(
  config: BitbucketConfig,
  kbId: string,
  dsId: string,
): Promise<{ vectorKeys: string[]; count: number }> {
  const apiBase = (config.baseUrl || 'https://api.bitbucket.org').replace(/\/$/, '');
  validateExternalUrl(apiBase);
  const authHeader =
    'Basic ' + Buffer.from(`:${config.appPassword}`).toString('base64');

  const allVectorKeys: string[] = [];
  let filePaths: string[] = [];

  if (config.paths && config.paths.length > 0) {
    filePaths = config.paths.slice(0, MAX_FILES_PER_SYNC);
  } else {
    // List files from the repo root
    try {
      const url = `${apiBase}/2.0/repositories/${config.workspace}/${config.repoSlug}/src/${config.branch}/?pagelen=100`;
      const resp = await fetch(url, {
        headers: { Accept: 'application/json', Authorization: authHeader },
      });
      if (resp.ok) {
        const data = await resp.json();
        const values: Array<{ type: string; path: string }> = data.values || [];
        filePaths = values
          .filter((v) => v.type === 'commit_file' && isSupportedKey(v.path))
          .map((v) => v.path)
          .slice(0, MAX_FILES_PER_SYNC);
      } else {
        console.error(`[KB Sync Bitbucket] Failed to list files: ${resp.status}`);
      }
    } catch (err) {
      console.error('[KB Sync Bitbucket] Error listing files:', err);
    }
  }

  for (const filePath of filePaths) {
    try {
      const cleanPath = filePath.replace(/^\//, '');
      const url = `${apiBase}/2.0/repositories/${config.workspace}/${config.repoSlug}/src/${config.branch}/${cleanPath}`;
      const resp = await fetch(url, {
        headers: { Authorization: authHeader },
      });

      if (!resp.ok) {
        console.error(`[KB Sync Bitbucket] Failed to fetch ${filePath}: ${resp.status}`);
        continue;
      }

      const content = await resp.text();
      const fileName = cleanPath.split('/').pop() || cleanPath;
      const mimeType = getMimeType(fileName);
      const buffer = Buffer.from(content, 'utf-8');

      const text = await parseFileContent(buffer, mimeType, fileName);
      const kbChunks = chunkText(text, fileName);

      const vectorKeys = await embedAndStoreChunks({
        chunks: kbChunks,
        knowledgeBaseId: kbId,
        dataSourceId: dsId,
        sourceType: 'bitbucket',
        documentName: fileName,
        extraMetadata: {
          bitbucketRepo: `${config.workspace}/${config.repoSlug}`,
          bitbucketPath: cleanPath,
        },
      });

      allVectorKeys.push(...vectorKeys);
    } catch (err) {
      console.error(`[KB Sync Bitbucket] Error processing ${filePath}:`, err);
    }
  }

  return { vectorKeys: allVectorKeys, count: allVectorKeys.length };
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ kbId: string; dsId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { kbId, dsId } = await params;

  // Get data source record
  const ds = await KnowledgeBaseService.getDataSource(kbId, dsId);
  if (!ds) {
    return NextResponse.json({ error: 'Data source not found' }, { status: 404 });
  }

  const oldVectorCount = ds.vectorCount;

  // Set status to syncing
  await KnowledgeBaseService.updateDataSource(kbId, dsId, { status: 'syncing' });

  try {
    // Delete old vectors
    await deleteVectors(ds.vectorKeys);
    await KnowledgeBaseService.updateDataSource(kbId, dsId, { vectorCount: 0, vectorKeys: [] });
    await KnowledgeBaseService.updateVectorCount(kbId, -oldVectorCount, DEFAULT_TENANT_ID);

    let result: { vectorKeys: string[]; count: number };

    switch (ds.sourceType) {
      case 's3-bucket':
        result = await syncS3Bucket(ds.config as S3BucketConfig, kbId, dsId);
        break;
      case 'confluence':
        result = await syncConfluence(ds.config as ConfluenceConfig, kbId, dsId);
        break;
      case 'bitbucket':
        result = await syncBitbucket(ds.config as BitbucketConfig, kbId, dsId);
        break;
      default:
        return NextResponse.json(
          { error: `Sync not supported for source type: ${ds.sourceType}` },
          { status: 400 },
        );
    }

    // Update data source to synced
    await KnowledgeBaseService.updateDataSource(kbId, dsId, {
      status: 'synced',
      vectorCount: result.count,
      vectorKeys: result.vectorKeys,
      lastSyncAt: new Date().toISOString(),
    });

    // Update KB vector count (old count was already decremented above; add only the new count)
    await KnowledgeBaseService.updateVectorCount(
      kbId,
      result.count,
      DEFAULT_TENANT_ID,
    );

    return NextResponse.json({ success: true, vectorCount: result.count });
  } catch (error) {
    console.error('[KB Sync API] Error during sync:', error);

    // Mark as error
    try {
      await KnowledgeBaseService.updateDataSource(kbId, dsId, {
        status: 'error',
        lastSyncError: error instanceof Error ? error.message : 'Sync failed',
      });
    } catch (updateErr) {
      console.error('[KB Sync API] Failed to update error status:', updateErr);
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Sync failed' },
      { status: 500 },
    );
  }
}
