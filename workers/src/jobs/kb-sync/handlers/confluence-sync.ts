import { chunkText } from '../lib/chunking.js';
import { embedAndStore } from '../lib/embedding.js';
import type { ConfluenceSyncJob } from '../types.js';
import { createLogger } from '../../../lib/logger.js';

const log = createLogger('kb-sync/confluence');

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

const BLOCKED = [/^https?:\/\/localhost/i, /^https?:\/\/127\./, /^https?:\/\/10\./, /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./, /^https?:\/\/192\.168\./, /^https?:\/\/169\.254\./];
function guardUrl(url: string) {
  if (!url.startsWith('http')) throw new Error(`Invalid URL: ${url}`);
  for (const p of BLOCKED) if (p.test(url)) throw new Error(`Blocked private URL: ${url}`);
}

// ---------------------------------------------------------------------------
// Confluence helpers
// ---------------------------------------------------------------------------

async function fetchConfluencePage(
  base: string, headers: Record<string, string>, pageId: string,
): Promise<{ id: string; title: string; body: string } | null> {
  const r = await fetch(`${base}/rest/api/content/${pageId}?expand=body.view.value`, { headers });
  if (!r.ok) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = await r.json() as any;
  return { id: d.id, title: d.title, body: d.body?.view?.value || '' };
}

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

// ---------------------------------------------------------------------------
// Confluence sync handler
// ---------------------------------------------------------------------------

export async function handleConfluenceSync(job: ConfluenceSyncJob): Promise<string[]> {
  const { baseUrl, spaceKey, pageIds, email, apiToken } = job.config;
  guardUrl(baseUrl);
  const base = baseUrl.replace(/\/$/, '');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (email && apiToken) headers['Authorization'] = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;

  let pages: Array<{ id: string; title: string; body: string }>;
  if (pageIds?.length) {
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

  // Deduplicate by page ID
  const seen = new Set<string>();
  pages = pages.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  log.info('Pages to ingest', { count: pages.length });

  const allKeys: string[] = [];
  for (const page of pages) {
    const text = page.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const keys = await embedAndStore({ chunks: chunkText(text, page.title), kbId: job.kbId, dsId: job.dsId, sourceType: 'confluence', docName: page.title, tenantId: job.tenantId, docId: page.id, extra: { confluencePageId: page.id } });
    allKeys.push(...keys);
  }
  return allKeys;
}
