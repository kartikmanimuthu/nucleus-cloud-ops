-- Subject LABEL only — never the key. 'Schedule' is what authorize() calls,
-- what SUBJECT_TO_MODULE maps, and what every compiled rule references.
--
-- The sidebar has always called this page "Cost Scheduler" (nav-config.ts:71,
-- under Cost Optimization, /app/schedules). The permission matrix showed the
-- raw registry key "Schedule" instead, which read as a different, vaguer thing
-- sitting confusingly under a "Schedules" module of the same name.
--
-- Its sibling under this module is 'SpotGuard' ("Spot Guard"), relabelled in
-- 20260812130000 for the same reason: match what the operator sees in the nav.

UPDATE "rbac_subjects" SET "label" = 'Cost Scheduler' WHERE "key" = 'Schedule' AND "tenantId" IS NULL;

-- Mandatory: any change to rbac_subjects must bump the global version, or every
-- already-running process keeps serving the old label from its cached snapshot.
UPDATE "rbac_global_version" SET "version" = "version" + 1 WHERE "id" = 1;
INSERT INTO "rbac_global_version" ("id", "version") VALUES (1, 1) ON CONFLICT ("id") DO NOTHING;
