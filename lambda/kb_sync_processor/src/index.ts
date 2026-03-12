import { SQSEvent } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { S3VectorsClient, PutVectorsCommand, DeleteVectorsCommand } from '@aws-sdk/client-s3vectors';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Clients & config
// ---------------------------------------------------------------------------

const region = process.env.AWS_REGION || 'ap-south-1';
const s3 = new S3Client({ region });
const bedrock = new BedrockRuntimeClient({ region });
const s3vectors = new S3VectorsClient({ region });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

const APP_TABLE = process.env.APP_TABLE_NAME!;
const KB_VECTOR_BUCKET = process.env.KB_VECTOR_BUCKET_NAME!;
const KB_VECTOR_INDEX = process.env.KB_VECTOR_INDEX_NAME!;
const STAGING_BUCKET = process.env.KB_STAGING_BUCKET_NAME!;
const BEDROCK_MODEL = process.env.BEDROCK_MODEL_ID || 'amazon.titan-embed-text-v2:0';

const EMBEDDING_CONCURRENCY = 5;
const VECTOR_BATCH_SIZE = 20;
const MAX_FILES = 50;
const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;

// ---------------------------------------------------------------------------
// Job payload types
// ---------------------------------------------------------------------------

export type JobType = 'file-upload' | 's3-sync' | 'confluence-sync' | 'bitbucket-sync';

export interface BaseJob {
  type: JobType;
  kbId: string;
  dsId: string;
  oldVectorKeys?: string[];
}

export interface FileUploadJob extends BaseJob {
  type: 'file-upload';
  stagingKey: string;
  fileName: string;
  mimeType: string;
}

export interface S3SyncJob extends BaseJob {
  type: 's3-sync';
  config: { bucketName: string; prefix?: string; filePatterns?: string[]; region?: string };
}

export interface ConfluenceSyncJob extends BaseJob {
  type: 'confluence-sync';
  config: {
    spaceKey: string;
    pageIds?: string[];
    baseUrl: string;
    email?: string;
    apiToken?: string;
  };
}

export interface BitbucketSyncJob extends BaseJob {
  type: 'bitbucket-sync';
  config: {
    workspace: string;
    project?: string;
    repoSlug?: string;
    branch?: string;
    paths?: string[];
    apiToken: string;
    email: string;
    baseUrl?: string;
  };
}

export type KBSyncJob = FileUploadJob | S3SyncJob | ConfluenceSyncJob | BitbucketSyncJob;

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

function chunkText(text: string, docName: string): Array<{ text: string; index: number; total: number; contentHash: string }> {
  const seps = ['\n\n', '\n', '. ', ' '];
  const raw = recursiveSplit(text, CHUNK_SIZE, seps);
  const total = raw.length;
  return raw.map((t, i) => ({
    text: `Document: ${docName} | Chunk ${i + 1}/${total}\n\n${t}`,
    index: i,
    total,
    contentHash: createHash('sha256').update(t).digest('hex').slice(0, 16),
  }));
}

function recursiveSplit(text: string, max: number, seps: string[]): string[] {
  if (text.length <= max) return text.trim() ? [text] : [];
  const sep = seps.find((s) => text.includes(s));
  if (!sep) return forceChunk(text, max);
  const parts: string[] = [];
  let buf = '';
  for (const part of text.split(sep)) {
    const candidate = buf ? buf + sep + part : part;
    if (candidate.length <= max) {
      buf = candidate;
    } else {
      if (buf) parts.push(buf);
      buf = part.length > max ? '' : part;
      if (part.length > max) parts.push(...recursiveSplit(part, max, seps.slice(1)));
    }
  }
  if (buf) parts.push(buf);
  // Add overlap
  const result: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const prev = i > 0 ? parts[i - 1].slice(-CHUNK_OVERLAP) : '';
    result.push((prev + parts[i]).slice(0, max));
  }
  return result.filter((s) => s.trim());
}

function forceChunk(text: string, max: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += max - CHUNK_OVERLAP) {
    chunks.push(text.slice(i, i + max));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

async function parseContent(buffer: Buffer, mimeType: string, fileName: string): Promise<string> {
  if (mimeType === 'application/pdf' || fileName.endsWith('.pdf')) {
    // Dynamic import to avoid bundling issues
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(buffer);
    return data.text;
  }
  return buffer.toString('utf-8');
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

async function getEmbedding(text: string): Promise<number[]> {
  const res = await bedrock.send(new InvokeModelCommand({
    modelId: BEDROCK_MODEL,
    body: JSON.stringify({ inputText: text.slice(0, 8000) }),
    contentType: 'application/json',
    accept: 'application/json',
  }));
  return JSON.parse(new TextDecoder().decode(res.body)).embedding;
}

async function embedAndStore(params: {
  chunks: ReturnType<typeof chunkText>;
  kbId: string;
  dsId: string;
  sourceType: string;
  docName: string;
  docId?: string;
  extra?: Record<string, string>;
}): Promise<string[]> {
  const { chunks, kbId, dsId, sourceType, docName, docId = '', extra = {} } = params;
  const keys: string[] = [];

  for (let i = 0; i < chunks.length; i += EMBEDDING_CONCURRENCY) {
    const batch = chunks.slice(i, i + EMBEDDING_CONCURRENCY);
    const embeddings = await Promise.all(batch.map((c) => getEmbedding(c.text)));

    const vectors = batch.map((chunk, j) => ({
      key: `kb_${kbId}_${dsId}_${docId}_${chunk.index}_${chunk.contentHash}`,
      data: { float32: embeddings[j] },
      metadata: {
        knowledgeBaseId: kbId,
        dataSourceId: dsId,
        sourceType,
        documentName: docName,
        chunkIndex: String(chunk.index),
        totalChunks: String(chunk.total),
        contentHash: chunk.contentHash,
        text_content: chunk.text.slice(0, 500),
        ...extra,
      },
    }));

    for (let b = 0; b < vectors.length; b += VECTOR_BATCH_SIZE) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await s3vectors.send(new PutVectorsCommand({ vectorBucketName: KB_VECTOR_BUCKET, indexName: KB_VECTOR_INDEX, vectors: vectors.slice(b, b + VECTOR_BATCH_SIZE) as any }));
    }
    keys.push(...vectors.map((v) => v.key));
  }
  return keys;
}

// ---------------------------------------------------------------------------
// DynamoDB helpers
// ---------------------------------------------------------------------------

function kbPK(kbId: string) { return `KB#${kbId}`; }
function dsSK(dsId: string) { return `DATASOURCE#${dsId}`; }
function tenantPK(tenantId: string) { return `TENANT#${tenantId}`; }
function kbSK(kbId: string) { return `KB#${kbId}`; }

const DEFAULT_TENANT = process.env.DEFAULT_TENANT_ID || 'org-default';

async function getDataSource(kbId: string, dsId: string) {
  const res = await ddb.send(new GetCommand({ TableName: APP_TABLE, Key: { pk: kbPK(kbId), sk: dsSK(dsId) } }));
  return res.Item;
}

async function updateDS(kbId: string, dsId: string, updates: Record<string, unknown>) {
  const parts = ['#updatedAt = :updatedAt'];
  const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
  const vals: Record<string, unknown> = { ':updatedAt': new Date().toISOString() };
  for (const [k, v] of Object.entries(updates)) {
    parts.push(`#${k} = :${k}`);
    names[`#${k}`] = k;
    vals[`:${k}`] = v;
  }
  await ddb.send(new UpdateCommand({
    TableName: APP_TABLE,
    Key: { pk: kbPK(kbId), sk: dsSK(dsId) },
    UpdateExpression: `SET ${parts.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: vals,
  }));
}

async function updateKBVectorCount(kbId: string, delta: number) {
  if (delta === 0) return;
  await ddb.send(new UpdateCommand({
    TableName: APP_TABLE,
    Key: { pk: tenantPK(DEFAULT_TENANT), sk: kbSK(kbId) },
    UpdateExpression: 'SET vectorCount = if_not_exists(vectorCount, :zero) + :delta, updatedAt = :now',
    ExpressionAttributeValues: { ':delta': delta, ':zero': 0, ':now': new Date().toISOString() },
  }));
}

async function deleteOldVectors(keys: string[]) {
  if (!keys?.length) return;
  for (let i = 0; i < keys.length; i += 500) {
    await s3vectors.send(new DeleteVectorsCommand({
      vectorBucketName: KB_VECTOR_BUCKET,
      indexName: KB_VECTOR_INDEX,
      keys: keys.slice(i, i + 500),
    }));
  }
}

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

const BLOCKED = [/^https?:\/\/localhost/i, /^https?:\/\/127\./, /^https?:\/\/10\./, /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./, /^https?:\/\/192\.168\./, /^https?:\/\/169\.254\./];
function guardUrl(url: string) {
  if (!url.startsWith('http')) throw new Error(`Invalid URL: ${url}`);
  for (const p of BLOCKED) if (p.test(url)) throw new Error(`Blocked private URL: ${url}`);
}

// ---------------------------------------------------------------------------
// Sync handlers
// ---------------------------------------------------------------------------

async function handleFileUpload(job: FileUploadJob): Promise<string[]> {
  const res = await s3.send(new GetObjectCommand({ Bucket: STAGING_BUCKET, Key: job.stagingKey }));
  const chunks: Uint8Array[] = [];
  for await (const c of res.Body as AsyncIterable<Uint8Array>) chunks.push(c);
  const buffer = Buffer.concat(chunks);
  const text = await parseContent(buffer, job.mimeType, job.fileName);
  const kbChunks = chunkText(text, job.fileName);
  return embedAndStore({ chunks: kbChunks, kbId: job.kbId, dsId: job.dsId, sourceType: 'file-upload', docName: job.fileName });
}

const SUPPORTED_EXT = new Set(['pdf', 'md', 'txt', 'json', 'csv', 'yaml', 'yml']);
function isSupportedKey(key: string) { return SUPPORTED_EXT.has(key.split('.').pop()?.toLowerCase() ?? ''); }
function getMime(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  return ext === 'pdf' ? 'application/pdf' : ext === 'json' ? 'application/json' : 'text/plain';
}

async function handleS3Sync(job: S3SyncJob): Promise<string[]> {
  const { S3Client: S3C, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const srcS3 = new S3C({ region: job.config.region || region });
  const list = await srcS3.send(new ListObjectsV2Command({ Bucket: job.config.bucketName, Prefix: job.config.prefix, MaxKeys: MAX_FILES }));
  let objects = (list.Contents || []).filter((o) => o.Key && isSupportedKey(o.Key));
  if (job.config.filePatterns?.length) {
    objects = objects.filter((o) => job.config.filePatterns!.some((p) => o.Key!.includes(p.replace(/\*/g, ''))));
  }
  const allKeys: string[] = [];
  for (const obj of objects.slice(0, MAX_FILES)) {
    try {
      const get = await srcS3.send(new GetObjectCommand({ Bucket: job.config.bucketName, Key: obj.Key! }));
      const chunks: Uint8Array[] = [];
      for await (const c of get.Body as AsyncIterable<Uint8Array>) chunks.push(c);
      const buf = Buffer.concat(chunks);
      const fileName = obj.Key!.split('/').pop() || obj.Key!;
      const text = await parseContent(buf, getMime(obj.Key!), fileName);
      const kbChunks = chunkText(text, fileName);
      const keys = await embedAndStore({ chunks: kbChunks, kbId: job.kbId, dsId: job.dsId, sourceType: 's3-bucket', docName: fileName, extra: { s3Key: obj.Key! } });
      allKeys.push(...keys);
    } catch (e) { console.error(`[KB Lambda] S3 skip ${obj.Key}:`, e); }
  }
  return allKeys;
}

// Fetch one Confluence page with body
async function fetchConfluencePage(
  base: string, headers: Record<string, string>, pageId: string,
): Promise<{ id: string; title: string; body: string } | null> {
  const r = await fetch(`${base}/rest/api/content/${pageId}?expand=body.view.value`, { headers });
  if (!r.ok) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = await r.json() as any;
  return { id: d.id, title: d.title, body: d.body?.view?.value || '' };
}

// Recursively collect a page + all descendants (no cap)
async function collectPageTree(
  base: string, headers: Record<string, string>, pageId: string, visited = new Set<string>(),
): Promise<Array<{ id: string; title: string; body: string }>> {
  if (visited.has(pageId)) return [];
  visited.add(pageId);
  const page = await fetchConfluencePage(base, headers, pageId);
  const results: Array<{ id: string; title: string; body: string }> = page ? [page] : [];
  let start = 0;
  while (true) {
    const r = await fetch(`${base}/rest/api/content/${pageId}/child/page?limit=50&start=${start}`, { headers });
    if (!r.ok) break;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = await r.json() as any;
    const children: Array<{ id: string }> = d.results || [];
    if (!children.length) break;
    for (const child of children) {
      results.push(...await collectPageTree(base, headers, child.id, visited));
    }
    if (!d._links?.next) break;
    start += children.length;
  }
  return results;
}

// Fetch all pages in a space with full pagination (no 25-page cap)
async function fetchAllSpacePages(
  base: string, headers: Record<string, string>, spaceKey: string,
): Promise<Array<{ id: string; title: string; body: string }>> {
  const pages: Array<{ id: string; title: string; body: string }> = [];
  let start = 0;
  while (true) {
    const r = await fetch(`${base}/rest/api/content?spaceKey=${encodeURIComponent(spaceKey)}&expand=body.view.value&limit=50&start=${start}`, { headers });
    if (!r.ok) break;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = await r.json() as any;
    const results: Array<{ id: string; title: string; body?: { view?: { value?: string } } }> = d.results || [];
    if (!results.length) break;
    pages.push(...results.map((p) => ({ id: p.id, title: p.title, body: p.body?.view?.value || '' })));
    if (!d._links?.next) break;
    start += results.length;
  }
  return pages;
}

async function handleConfluenceSync(job: ConfluenceSyncJob): Promise<string[]> {
  const { baseUrl, spaceKey, pageIds, email, apiToken } = job.config;
  guardUrl(baseUrl);
  const base = baseUrl.replace(/\/$/, '');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (email && apiToken) headers['Authorization'] = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;

  let pages: Array<{ id: string; title: string; body: string }>;
  if (pageIds?.length) {
    // Collect all trees sequentially to share visited set across all seed pages
    const visited = new Set<string>();
    const allPages: Array<{ id: string; title: string; body: string }> = [];
    for (const pid of pageIds) {
      const tree = await collectPageTree(base, headers, pid, visited);
      allPages.push(...tree);
    }
    pages = allPages;
  } else {
    pages = await fetchAllSpacePages(base, headers, spaceKey);
  }

  // Deduplicate by page ID (in case of overlapping trees)
  const seen = new Set<string>();
  pages = pages.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  console.log(`[KB Lambda] Confluence: ${pages.length} pages to ingest`);

  const allKeys: string[] = [];
  for (const page of pages) {
    const text = page.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const keys = await embedAndStore({ chunks: chunkText(text, page.title), kbId: job.kbId, dsId: job.dsId, sourceType: 'confluence', docName: page.title, docId: page.id, extra: { confluencePageId: page.id } });
    allKeys.push(...keys);
  }
  return allKeys;
}

// ---------------------------------------------------------------------------
// Bitbucket helpers
// ---------------------------------------------------------------------------

async function bbResolveBranch(apiBase: string, auth: string, workspace: string, repoSlug: string, preferred?: string): Promise<string> {
  if (preferred) return preferred;
  // Try main, then master, then repo default
  for (const b of ['main', 'master']) {
    const r = await fetch(`${apiBase}/2.0/repositories/${workspace}/${repoSlug}/refs/branches/${b}`, { headers: { Authorization: auth } });
    if (r.ok) return b;
  }
  const r = await fetch(`${apiBase}/2.0/repositories/${workspace}/${repoSlug}`, { headers: { Authorization: auth } });
  if (r.ok) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = await r.json() as any;
    return d.mainbranch?.name || 'main';
  }
  return 'main';
}

async function bbListRepoFiles(apiBase: string, auth: string, workspace: string, repoSlug: string, branch: string): Promise<string[]> {
  const files: string[] = [];
  let url: string | null = `${apiBase}/2.0/repositories/${workspace}/${repoSlug}/src/${branch}/?pagelen=100&max_depth=10`;
  while (url && files.length < MAX_FILES) {
    const r = await fetch(url, { headers: { Accept: 'application/json', Authorization: auth } });
    if (!r.ok) break;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = await r.json() as any;
    for (const v of (d.values || [])) {
      if (v.type === 'commit_file' && isSupportedKey(v.path)) files.push(v.path);
    }
    url = d.next || null;
  }
  return files.slice(0, MAX_FILES);
}

async function bbListWorkspaceRepos(apiBase: string, auth: string, workspace: string, project?: string): Promise<string[]> {
  const slugs: string[] = [];
  const q = project ? `&q=project.key="${encodeURIComponent(project)}"` : '';
  let url: string | null = `${apiBase}/2.0/repositories/${workspace}?pagelen=50${q}`;
  while (url) {
    const r = await fetch(url, { headers: { Accept: 'application/json', Authorization: auth } });
    if (!r.ok) break;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = await r.json() as any;
    for (const repo of (d.values || [])) slugs.push(repo.slug);
    url = d.next || null;
  }
  return slugs;
}

async function bbScrapeRepo(
  apiBase: string, auth: string, workspace: string, repoSlug: string,
  branch: string | undefined, paths: string[] | undefined,
  job: BitbucketSyncJob,
): Promise<string[]> {
  const resolvedBranch = await bbResolveBranch(apiBase, auth, workspace, repoSlug, branch);
  const filePaths = paths?.length ? paths.slice(0, MAX_FILES) : await bbListRepoFiles(apiBase, auth, workspace, repoSlug, resolvedBranch);
  const allKeys: string[] = [];
  for (const fp of filePaths) {
    try {
      const clean = fp.replace(/^\//, '');
      const r = await fetch(`${apiBase}/2.0/repositories/${workspace}/${repoSlug}/src/${resolvedBranch}/${clean}`, { headers: { Authorization: auth } });
      if (!r.ok) continue;
      const content = await r.text();
      const fileName = clean.split('/').pop() || clean;
      const text = await parseContent(Buffer.from(content, 'utf-8'), getMime(fileName), fileName);
      const keys = await embedAndStore({ chunks: chunkText(text, fileName), kbId: job.kbId, dsId: job.dsId, sourceType: 'bitbucket', docName: fileName, extra: { bitbucketRepo: `${workspace}/${repoSlug}`, bitbucketPath: clean } });
      allKeys.push(...keys);
    } catch (e) { console.error(`[KB Lambda] BB skip ${fp}:`, e); }
  }
  return allKeys;
}

async function handleBitbucketSync(job: BitbucketSyncJob): Promise<string[]> {
  const { workspace, project, repoSlug, branch, paths, apiToken, email, baseUrl } = job.config;
  const apiBase = (baseUrl || 'https://api.bitbucket.org').replace(/\/$/, '');
  guardUrl(apiBase);
  const auth = 'Basic ' + Buffer.from(`${email}:${apiToken}`).toString('base64');

  const repos = repoSlug ? [repoSlug] : await bbListWorkspaceRepos(apiBase, auth, workspace, project);
  console.log(`[KB Lambda] Bitbucket: ${repos.length} repo(s) to scrape in workspace=${workspace}`);

  const allKeys: string[] = [];
  for (const slug of repos) {
    const keys = await bbScrapeRepo(apiBase, auth, workspace, slug, branch, paths, job);
    allKeys.push(...keys);
  }
  return allKeys;
}

// ---------------------------------------------------------------------------
// SQS Handler
// ---------------------------------------------------------------------------

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const job: KBSyncJob = JSON.parse(record.body);
    const { kbId, dsId } = job;

    console.log(`[KB Lambda] Processing ${job.type} for KB=${kbId} DS=${dsId}`);

    // Get current DS to know old vector count
    const ds = await getDataSource(kbId, dsId);
    const oldVectorCount = (ds?.vectorCount as number) || 0;
    const oldVectorKeys: string[] = job.oldVectorKeys || (ds?.vectorKeys as string[]) || [];

    try {
      // Delete old vectors
      if (oldVectorKeys.length) {
        await deleteOldVectors(oldVectorKeys);
        await updateKBVectorCount(kbId, -oldVectorCount);
      }

      let vectorKeys: string[];
      switch (job.type) {
        case 'file-upload':    vectorKeys = await handleFileUpload(job); break;
        case 's3-sync':        vectorKeys = await handleS3Sync(job); break;
        case 'confluence-sync': vectorKeys = await handleConfluenceSync(job); break;
        case 'bitbucket-sync': vectorKeys = await handleBitbucketSync(job); break;
        default: throw new Error(`Unknown job type: ${(job as KBSyncJob).type}`);
      }

      await updateDS(kbId, dsId, {
        status: 'synced',
        vectorCount: vectorKeys.length,
        vectorKeys,
        lastSyncAt: new Date().toISOString(),
        lastSyncError: null,
      });
      await updateKBVectorCount(kbId, vectorKeys.length);

      console.log(`[KB Lambda] Done ${job.type} KB=${kbId} DS=${dsId} vectors=${vectorKeys.length}`);
    } catch (err) {
      console.error(`[KB Lambda] Error ${job.type} KB=${kbId} DS=${dsId}:`, err);
      await updateDS(kbId, dsId, {
        status: 'error',
        lastSyncError: err instanceof Error ? err.message : 'Sync failed',
      });
      throw err; // Re-throw so SQS retries / sends to DLQ
    }
  }
}
