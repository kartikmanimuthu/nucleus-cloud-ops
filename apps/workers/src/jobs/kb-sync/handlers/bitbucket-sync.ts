import { parseContent, isSupportedKey, getMime } from '../lib/parsing.js';
import { chunkText } from '../lib/chunking.js';
import { embedAndStore } from '../lib/embedding.js';
import type { BitbucketSyncJob } from '../types.js';
import { createLogger } from '../../../lib/logger.js';

const log = createLogger('kb-sync/bitbucket');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FILES = 50;

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

const BLOCKED = [/^https?:\/\/localhost/i, /^https?:\/\/127\./, /^https?:\/\/10\./, /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./, /^https?:\/\/192\.168\./, /^https?:\/\/169\.254\./];
function guardUrl(url: string) {
  if (!url.startsWith('http')) throw new Error(`Invalid URL: ${url}`);
  for (const p of BLOCKED) if (p.test(url)) throw new Error(`Blocked private URL: ${url}`);
}

// ---------------------------------------------------------------------------
// Bitbucket helpers
// ---------------------------------------------------------------------------

async function bbResolveBranch(apiBase: string, auth: string, workspace: string, repoSlug: string, preferred?: string): Promise<string> {
  if (preferred) return preferred;
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
      const keys = await embedAndStore({ chunks: chunkText(text, fileName), kbId: job.kbId, dsId: job.dsId, sourceType: 'bitbucket', docName: fileName, tenantId: job.tenantId, extra: { bitbucketRepo: `${workspace}/${repoSlug}`, bitbucketPath: clean } });
      allKeys.push(...keys);
    } catch (e) { log.warn('Skipping file', { path: fp, error: e instanceof Error ? e.message : String(e) }); }
  }
  return allKeys;
}

// ---------------------------------------------------------------------------
// Bitbucket sync handler
// ---------------------------------------------------------------------------

export async function handleBitbucketSync(job: BitbucketSyncJob): Promise<string[]> {
  const { workspace, project, repoSlug, branch, paths, apiToken, email, baseUrl } = job.config;
  const apiBase = (baseUrl || 'https://api.bitbucket.org').replace(/\/$/, '');
  guardUrl(apiBase);
  const auth = 'Basic ' + Buffer.from(`${email}:${apiToken}`).toString('base64');

  const repos = repoSlug ? [repoSlug] : await bbListWorkspaceRepos(apiBase, auth, workspace, project);
  log.info('Repos to scrape', { count: repos.length, workspace });

  const allKeys: string[] = [];
  for (const slug of repos) {
    const keys = await bbScrapeRepo(apiBase, auth, workspace, slug, branch, paths, job);
    allKeys.push(...keys);
  }
  return allKeys;
}
