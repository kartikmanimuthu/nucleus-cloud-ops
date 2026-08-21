-- ═══════════════════════════════════════════════════════════════════════════════
-- Scheduled agent tasks carry the creator's grant  (Workstream H — Gate 4)
--
-- ⚠️  HAND-AUTHORED — DO NOT REGENERATE THIS FILE WITH `prisma migrate dev`.
--
-- Same three reasons as 20260730000000_dynamic_abac, the first of which is the
-- one that bites here: `prisma migrate dev` emits DESTRUCTIVE drift-correction
-- statements unrelated to this change. The untracked local migration
-- 20260729164152_casl_local_host in this repo opens with
--     DROP INDEX "agent_memories_embedding_hnsw"
--     DROP INDEX "idx_inventory_search_vector"
--     DROP INDEX "idx_kb_document_chunks_embedding"
-- because those three indexes are created by raw SQL in earlier migrations and
-- cannot be expressed in schema.prisma, so Prisma reads them as extraneous.
-- Commit c206e11 already had to repair exactly this once.
--
-- Prisma 5 also does not emit CHECK constraints, and this change widens one.
--
-- Column naming: this schema does not use @map on these fields, so Prisma emits
-- camelCase quoted identifiers ("tenantId", "createdByUserId"). Quoted here to
-- match.
--
-- Every statement is idempotent (IF NOT EXISTS / IF EXISTS), so re-running
-- against a partially-migrated database is safe.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── Whose authority does this task run under? ────────────────────────────────
--
-- A scheduled task fires long after the session that created it has gone. Until
-- now the only record of its author was `createdBy`, which comes straight from
-- the REQUEST BODY (`body.createdBy || 'api'` in the create route) and is a
-- display string, not an identity — it cannot be used to make an authorization
-- decision. These two columns are written server-side from the session so that
-- the trigger path can recompile the creator's ability at EXECUTION time.
--
-- Deliberately NOT foreign keys. A task whose creator was deleted must remain
-- readable and auditable — an ON DELETE CASCADE would erase the evidence, and an
-- ON DELETE RESTRICT would block user offboarding. A dangling id is exactly the
-- signal the execution-time check is looking for: it fails closed.

ALTER TABLE "scheduled_tasks" ADD COLUMN IF NOT EXISTS "createdByUserId" TEXT;
ALTER TABLE "scheduled_tasks" ADD COLUMN IF NOT EXISTS "createdByRoleId" TEXT;

COMMENT ON COLUMN "scheduled_tasks"."createdByUserId" IS
    'auth_users.id of the creator. The task runs under THIS user''s permissions, '
    're-evaluated at every execution. NULL on rows created before Workstream H — '
    'those cannot be re-checked and are handled explicitly by the trigger guard.';

COMMENT ON COLUMN "scheduled_tasks"."createdByRoleId" IS
    'custom_roles.id held by the creator at creation time. Recorded for audit and '
    'drift detection ONLY — the execution-time check resolves the CURRENT role from '
    'user_tenant_roles, so a role swap cannot be frozen in place by this column.';

-- ── permission_revoked is a task STATE, not a run failure ────────────────────
--
-- When the creator's grant is gone the task must stop firing, and it must be
-- visibly different from `paused` (a human chose that) and from `deleted`. The
-- sweeper in apps/workers/src/jobs/agent-ops-scheduler only selects
-- taskStatus = 'active', so moving a task here is what actually stops it — the
-- new state is the enforcement, not just a label.

ALTER TABLE "scheduled_tasks" DROP CONSTRAINT IF EXISTS "scheduled_tasks_status_check";
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_status_check"
    CHECK ("taskStatus" IN ('active', 'paused', 'deleted', 'permission_revoked'));

-- Index the revocation lookup used by the admin UI ("which of my tasks stopped
-- and why"). The existing (tenantId, taskStatus) index already serves it, so no
-- new index is created here — recorded so the omission reads as a decision.
