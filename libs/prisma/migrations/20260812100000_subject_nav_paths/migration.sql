-- Gives subjects the two columns modules already have, so a DESTINATION can be
-- gated by the subject that owns it instead of by its whole module.
--
-- Before this, lib/nav-config.ts annotated all nine Agentic Ops entries with
-- module "AIOps", so Providers could not be hidden without also hiding AI Ops,
-- Agent Ops, Memory, Skills, Knowledge Base and MCP Servers.
--
-- No `enabled` column: a subject is retired by unlinking it from its module,
-- which rule-compiler.ts:337-346 already treats as contributing nothing.

ALTER TABLE "rbac_subjects" ADD COLUMN IF NOT EXISTS "navPath" TEXT;
ALTER TABLE "rbac_subjects" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 100;

-- ── navPath for subjects that already own a page ────────────────────────────
-- WHERE "navPath" IS NULL so a tenant that has already authored one is never
-- clobbered by a redeploy.
UPDATE "rbac_subjects" SET "navPath" = '/app/dashboard',                    "sortOrder" = 10 WHERE "key" = 'Dashboard'     AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/accounts',                     "sortOrder" = 10 WHERE "key" = 'Account'       AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/audit',                        "sortOrder" = 20 WHERE "key" = 'AuditLog'      AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/inventory',                    "sortOrder" = 10 WHERE "key" = 'Resource'       AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/right-sizing',                 "sortOrder" = 30 WHERE "key" = 'RightSizing'    AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/schedules',                    "sortOrder" = 10 WHERE "key" = 'Schedule'       AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/cost-optimization/spot-guard', "sortOrder" = 20 WHERE "key" = 'SpotGuard'      AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/agent',                        "sortOrder" = 10 WHERE "key" = 'Agent'          AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/memory',                       "sortOrder" = 40 WHERE "key" = 'Memory'         AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/knowledge-base',               "sortOrder" = 50 WHERE "key" = 'KnowledgeBase'  AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/skills',                       "sortOrder" = 60 WHERE "key" = 'Skill'          AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/channels',                     "sortOrder" = 80 WHERE "key" = 'Channel'        AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/certificates',                 "sortOrder" = 20 WHERE "key" = 'Certificate'    AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/settings',                     "sortOrder" = 10 WHERE "key" = 'Settings'       AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/settings/organization',        "sortOrder" = 30 WHERE "key" = 'Tenant'         AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/iam',                          "sortOrder" = 10 WHERE "key" = 'IAM'            AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/iam/members',                  "sortOrder" = 20 WHERE "key" = 'User'           AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/iam/roles',                    "sortOrder" = 30 WHERE "key" = 'Role'           AND "navPath" IS NULL;

-- Discovery, Billing and the five Agent* capability subjects own no page and
-- keep navPath NULL: grantable in the matrix, never a nav owner.

-- ── new subjects for destinations that had none ─────────────────────────────
-- ScalingAudit is a BUG FIX, not a feature. lib/rbac/types.ts:82 maps it to
-- Inventory and the Scale Sentinel routes call authorize(..., 'ScalingAudit'),
-- but no rbac_subjects row ever existed. The compiler emits one rule per
-- SUBJECT, so `read Inventory` never produced `read ScalingAudit`. Masked today
-- because prod runs the legacy matrix; flipping DYNAMIC_ABAC_ENABLED without
-- this would 403 Scale Sentinel for every non-SuperAdmin.
INSERT INTO "rbac_subjects" ("id", "tenantId", "key", "label", "kind", "navPath", "sortOrder", "isSystem") VALUES
    ('sys-subj-provider',      NULL, 'Provider',      'LLM Provider',   'resource', '/app/agent-ops/providers',              70, true),
    ('sys-subj-agentops',      NULL, 'AgentOps',      'Agent Ops',      'resource', '/app/agent-ops',                        20, true),
    ('sys-subj-scheduledtask', NULL, 'ScheduledTask', 'Scheduled Task', 'resource', '/app/agent-ops/scheduled-tasks',        30, true),
    ('sys-subj-mcpserver',     NULL, 'McpServer',     'MCP Server',     'resource', '/app/agent-ops/mcp-settings',           90, true),
    ('sys-subj-scalingaudit',  NULL, 'ScalingAudit',  'Scale Sentinel', 'resource', '/app/cloud-operations/scale-sentinel',  40, true)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "rbac_subject_modules" ("id", "tenantId", "subjectId", "moduleId") VALUES
    ('sys-sm-provider',      NULL, 'sys-subj-provider',      'sys-mod-aiops'),
    ('sys-sm-agentops',      NULL, 'sys-subj-agentops',      'sys-mod-aiops'),
    ('sys-sm-scheduledtask', NULL, 'sys-subj-scheduledtask', 'sys-mod-aiops'),
    ('sys-sm-mcpserver',     NULL, 'sys-subj-mcpserver',     'sys-mod-aiops'),
    ('sys-sm-scalingaudit',  NULL, 'sys-subj-scalingaudit',  'sys-mod-inventory')
ON CONFLICT ("id") DO NOTHING;

-- ── mandatory cache invalidation ────────────────────────────────────────────
-- ability-cache.ts keys on `${rbac_global_version.version}.${tenants.rbacVersion}`.
-- Entries are immutable: bumping does not clear the cache, it makes old keys
-- unreachable. Without this, every running process keeps serving abilities
-- compiled before these subjects existed.
UPDATE "rbac_global_version" SET "version" = "version" + 1 WHERE "id" = 1;
INSERT INTO "rbac_global_version" ("id", "version") VALUES (1, 1) ON CONFLICT ("id") DO NOTHING;
