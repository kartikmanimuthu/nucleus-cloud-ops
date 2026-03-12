# Plan: Bitbucket Data Source Integration Revamp

## Task
Revamp the Bitbucket knowledge base data source to support workspace-level, project-level, and repo-level scraping with API Token auth (replacing deprecated App Password).

## Goal
Allow users to provide only a workspace (scrape all repos), optionally a project (scrape all repos under it), or optionally a specific repo — with optional branch (defaults to main/master). Auth via Atlassian API Token instead of deprecated App Password.

---

## Subtasks

### 1. Update `BitbucketConfig` type — `web-ui/lib/knowledge-base/types.ts`
- Replace `appPassword` with `apiToken` + `email`
- Make `repoSlug` optional
- Add optional `project` field
- Make `branch` optional (default main/master)

### 2. Update `BitbucketSyncJob` config — `lambda/kb_sync_processor/src/index.ts`
- Update the `BitbucketSyncJob.config` interface to match new fields
- Rewrite `handleBitbucketSync` to:
  - Use API Token auth (Basic auth with `email:apiToken`)
  - If only workspace → list all repos in workspace, scrape each
  - If project provided → list repos under that project, scrape each
  - If repoSlug provided → scrape only that repo
  - If branch not provided → try `main`, fallback to `master`, then repo default branch
  - Recursively list files in repos (handle directory traversal)

### 3. Update UI `BitbucketForm` — `web-ui/app/knowledge-base/[kbId]/sources/new/page.tsx`
- Replace "App Password" with "Email" + "API Token"
- Make "Repository Slug" optional
- Add "Project" field (optional)
- Make "Branch" optional with placeholder hint "Defaults to main/master"
- Update validation: only workspace + email + apiToken required

### 4. Update sync route sanitizer — `web-ui/app/api/knowledge-base/[kbId]/sources/route.ts`
- Mask `apiToken` instead of `appPassword`

### 5. Update sync route handler — `web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]/sync/route.ts`
- No structural changes needed (already passes config through)

---

## Files to modify
- `web-ui/lib/knowledge-base/types.ts`
- `lambda/kb_sync_processor/src/index.ts`
- `web-ui/app/knowledge-base/[kbId]/sources/new/page.tsx`
- `web-ui/app/api/knowledge-base/[kbId]/sources/route.ts`
- `web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]/route.ts` (if it also sanitizes)

## Files to create
- None

## Files to delete
- None

## Parallelizable
- Yes — Subtasks 1 (types) must go first, then 2/3/4 can run concurrently

## Approach
1. Update the TypeScript types first (single source of truth)
2. Rewrite the Lambda handler to support hierarchical scraping: workspace → projects → repos
3. Update the UI form to reflect optional fields and new auth model
4. Update API route sanitizers to mask `apiToken`

## Key Decisions
- Using Atlassian API Token (email + token) over deprecated App Password — per user's requirement and Atlassian's deprecation
- Bitbucket Cloud REST API v2.0 for listing workspace repos, project repos, and file trees
- Branch resolution order: user-provided → `main` → `master` → repo's default branch (from API)
- Recursive directory traversal via Bitbucket `/src/{branch}/` endpoint with pagination

## Risks / Side Effects
- Existing Bitbucket data sources using `appPassword` will need migration (old config shape changes)
- Rate limiting on Bitbucket API when scraping entire workspaces with many repos

## Assumptions
- Credentials provided: email=`kartikmanimuthu@smcindiaonline.com`, workspace=`rohitahuja1`, API token stored as env var
- Bitbucket Cloud (not Server) — using `api.bitbucket.org` endpoints
- The `/2.0/repositories/{workspace}` endpoint lists all repos in a workspace
- The `/2.0/repositories/{workspace}?q=project.key="{project}"` filters by project

---

[DONE]

Built: Bitbucket data source revamped — API Token auth (email + token), hierarchical scraping (workspace → project → repo),
optional branch with auto-resolution (main → master → repo default).

Files:
- web-ui/lib/knowledge-base/types.ts — BitbucketConfig: appPassword → apiToken+email, repoSlug/project/branch all optional
- lambda/kb_sync_processor/src/index.ts — rewrote handleBitbucketSync + added bbListWorkspaceRepos, bbListRepoFiles,
bbResolveBranch, bbScrapeRepo helpers
- lambda/kb_sync_processor/src/local-runner.ts — updated CLI args for new auth model
- web-ui/app/knowledge-base/[kbId]/sources/new/page.tsx — new BitbucketForm with Email + API Token, optional Project/Repo/Branch
fields
- web-ui/app/api/knowledge-base/[kbId]/sources/route.ts — sanitize apiToken instead of appPassword
- web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]/route.ts — same sanitizer fix

Test: Add a Bitbucket data source with just workspace + email + API token → it should list all repos and scrape them. Add a project
key to narrow to that project's repos. Add a repo slug to scrape only that repo.✓ Created checkpoint 2