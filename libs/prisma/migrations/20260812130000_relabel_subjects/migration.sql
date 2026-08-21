-- Two subject LABELS only — never the key, which is what authorize() calls,
-- SUBJECT_TO_MODULE, and every compiled rule already reference.
--
-- 'User' -> 'Members': the sidebar has always called this page "Members"
-- (nav-config.ts, /app/iam/members); the permission matrix showed the raw
-- registry key "User" instead, which read as a different thing entirely.
--
-- 'Fargate Spot Guard' -> 'Spot Guard': matches the sidebar's own label
-- ("Spot Guard" in nav-config.ts) and the page title. "Fargate" is accurate
-- but the sidebar never says it, so the matrix shouldn't either.

UPDATE "rbac_subjects" SET "label" = 'Members'    WHERE "key" = 'User'      AND "tenantId" IS NULL;
UPDATE "rbac_subjects" SET "label" = 'Spot Guard'  WHERE "key" = 'SpotGuard' AND "tenantId" IS NULL;

-- Mandatory: any change to rbac_subjects must bump the global version, or
-- every already-running process keeps serving the old label from its cache.
UPDATE "rbac_global_version" SET "version" = "version" + 1 WHERE "id" = 1;
INSERT INTO "rbac_global_version" ("id", "version") VALUES (1, 1) ON CONFLICT ("id") DO NOTHING;
