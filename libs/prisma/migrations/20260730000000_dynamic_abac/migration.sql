-- ═══════════════════════════════════════════════════════════════════════════════
-- Dynamic ABAC — registry, grants, attributes, routing, audit  (Workstream B)
--
-- Twelve new tables, two additive columns on `custom_roles`, one on `tenants`,
-- plus the CHECK constraints, protection triggers and the SYSTEM REGISTRY SEED.
--
-- ⚠️  HAND-AUTHORED — DO NOT REGENERATE THIS FILE WITH `prisma migrate dev`.
--
-- Three independent reasons, the first two matching the precedent set by
-- 20260725201753_add_spot_guard:
--
--   1. Prisma 5 does not emit CHECK constraints, and this feature depends on
--      several for correctness (rule target XOR, route mode/method, value types,
--      role level range). House convention is to hand-write them here.
--
--   2. `prisma migrate dev` emits DESTRUCTIVE drift-correction statements that
--      have nothing to do with this change. There is an untracked local migration
--      in this very repo (20260729164152_casl_local_host) that opens with:
--          DROP INDEX "agent_memories_embedding_hnsw"
--          DROP INDEX "idx_inventory_search_vector"
--          DROP INDEX "idx_kb_document_chunks_embedding"
--      Those three indexes are created by raw SQL in earlier migrations and cannot
--      be expressed in schema.prisma, so Prisma reads them as extraneous. Applying
--      that would silently destroy agent-memory vector search and inventory
--      full-text search. Commit c206e11 already had to repair exactly this.
--
--   3. THE SEED AT THE BOTTOM OF THIS FILE MUST LIVE IN THE MIGRATION, not in
--      libs/prisma/seed.ts. The container entrypoint runs `prisma migrate deploy`
--      and NEVER runs the seed, so anything seeded only in seed.ts does not exist
--      in production. Enforcement depends on these registry rows existing: without
--      them the compiler has no subjects or actions to resolve against and every
--      authorization check fails closed. This is the single most important
--      deployment detail in the whole feature. seed.ts carries the same content
--      for local development convenience only.
--
-- Every statement below is idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING),
-- so re-running against a partially-migrated database is safe.
--
-- Column naming: this schema does not use @map on fields, so Prisma emits
-- camelCase quoted identifiers ("tenantId", "isSystem", "moduleId"). All
-- constraints and triggers below quote them accordingly.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── Additive columns on existing tables ──────────────────────────────────────

ALTER TABLE "tenants"      ADD COLUMN IF NOT EXISTS "rbacVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "custom_roles" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "custom_roles" ADD COLUMN IF NOT EXISTS "isSystem"    BOOLEAN NOT NULL DEFAULT false;

-- ── Registry ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "rbac_modules" (
    "id"          TEXT NOT NULL,
    "tenantId"    TEXT,
    "key"         TEXT NOT NULL,
    "label"       TEXT NOT NULL,
    "description" TEXT,
    "icon"        TEXT,
    "navPath"     TEXT,
    "sortOrder"   INTEGER NOT NULL DEFAULT 100,
    "isSystem"    BOOLEAN NOT NULL DEFAULT false,
    "enabled"     BOOLEAN NOT NULL DEFAULT true,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy"   TEXT NOT NULL DEFAULT 'system',
    CONSTRAINT "rbac_modules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "rbac_actions" (
    "id"          TEXT NOT NULL,
    "tenantId"    TEXT,
    "key"         TEXT NOT NULL,
    "label"       TEXT NOT NULL,
    "description" TEXT,
    "aliasOfKey"  TEXT,
    "isDangerous" BOOLEAN NOT NULL DEFAULT false,
    "isSystem"    BOOLEAN NOT NULL DEFAULT false,
    "sortOrder"   INTEGER NOT NULL DEFAULT 100,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy"   TEXT NOT NULL DEFAULT 'system',
    CONSTRAINT "rbac_actions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "rbac_subjects" (
    "id"        TEXT NOT NULL,
    "tenantId"  TEXT,
    "key"       TEXT NOT NULL,
    "label"     TEXT NOT NULL,
    "kind"      TEXT NOT NULL DEFAULT 'resource',
    "isSystem"  BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rbac_subjects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "rbac_subject_modules" (
    "id"        TEXT NOT NULL,
    "tenantId"  TEXT,
    "subjectId" TEXT NOT NULL,
    "moduleId"  TEXT NOT NULL,
    CONSTRAINT "rbac_subject_modules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "rbac_module_actions" (
    "id"        TEXT NOT NULL,
    "tenantId"  TEXT,
    "moduleId"  TEXT NOT NULL,
    "actionId"  TEXT NOT NULL,
    "grantable" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "rbac_module_actions_pkey" PRIMARY KEY ("id")
);

-- ── Grants ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "rbac_role_rules" (
    "id"         TEXT NOT NULL,
    "tenantId"   TEXT,
    "roleId"     TEXT NOT NULL,
    "actionId"   TEXT NOT NULL,
    "moduleId"   TEXT,
    "subjectId"  TEXT,
    "conditions" JSONB,
    "fields"     TEXT[] DEFAULT ARRAY[]::TEXT[],
    "inverted"   BOOLEAN NOT NULL DEFAULT false,
    "reason"     TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy"  TEXT NOT NULL DEFAULT 'system',
    CONSTRAINT "rbac_role_rules_pkey" PRIMARY KEY ("id")
);

-- ── Attributes — both sides of ABAC ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "rbac_subject_attributes" (
    "id"         TEXT NOT NULL,
    "tenantId"   TEXT,
    "subjectId"  TEXT NOT NULL,
    "path"       TEXT NOT NULL,
    "label"      TEXT NOT NULL,
    "valueType"  TEXT NOT NULL,
    "operators"  TEXT[] NOT NULL,
    "enumValues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isSystem"   BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "rbac_subject_attributes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "rbac_user_attributes" (
    "id"        TEXT NOT NULL,
    "tenantId"  TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "key"       TEXT NOT NULL,
    "value"     JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT NOT NULL,
    CONSTRAINT "rbac_user_attributes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "rbac_principal_attributes" (
    "id"        TEXT NOT NULL,
    "tenantId"  TEXT,
    "key"       TEXT NOT NULL,
    "label"     TEXT NOT NULL,
    "valueType" TEXT NOT NULL,
    "source"    TEXT NOT NULL DEFAULT 'user',
    "isSystem"  BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "rbac_principal_attributes_pkey" PRIMARY KEY ("id")
);

-- ── Routing and audit ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "rbac_route_permissions" (
    "id"          TEXT NOT NULL,
    "tenantId"    TEXT,
    "method"      TEXT NOT NULL,
    "pathPattern" TEXT NOT NULL,
    "actionKey"   TEXT NOT NULL,
    "subjectId"   TEXT,
    "mode"        TEXT NOT NULL DEFAULT 'require',
    "enforced"    BOOLEAN NOT NULL DEFAULT true,
    "sortOrder"   INTEGER NOT NULL DEFAULT 100,
    "reason"      TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy"   TEXT NOT NULL DEFAULT 'system',
    CONSTRAINT "rbac_route_permissions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "rbac_rule_change_log" (
    "id"         TEXT NOT NULL,
    "tenantId"   TEXT,
    "entityType" TEXT NOT NULL,
    "entityId"   TEXT NOT NULL,
    "operation"  TEXT NOT NULL,
    "before"     JSONB,
    "after"      JSONB,
    "actorId"    TEXT NOT NULL,
    "actorEmail" TEXT NOT NULL,
    "reason"     TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rbac_rule_change_log_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "rbac_global_version" (
    "id"      INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "rbac_global_version_pkey" PRIMARY KEY ("id")
);

-- ── Indexes ──────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS "rbac_modules_tenantId_key_key"    ON "rbac_modules" ("tenantId", "key");
CREATE        INDEX IF NOT EXISTS "rbac_modules_tenantId_enabled_idx" ON "rbac_modules" ("tenantId", "enabled");
CREATE UNIQUE INDEX IF NOT EXISTS "rbac_actions_tenantId_key_key"    ON "rbac_actions" ("tenantId", "key");
CREATE UNIQUE INDEX IF NOT EXISTS "rbac_subjects_tenantId_key_key"   ON "rbac_subjects" ("tenantId", "key");

CREATE UNIQUE INDEX IF NOT EXISTS "rbac_subject_modules_tenantId_subjectId_key" ON "rbac_subject_modules" ("tenantId", "subjectId");
CREATE        INDEX IF NOT EXISTS "rbac_subject_modules_moduleId_idx"           ON "rbac_subject_modules" ("moduleId");

CREATE UNIQUE INDEX IF NOT EXISTS "rbac_module_actions_tenantId_moduleId_actionId_key" ON "rbac_module_actions" ("tenantId", "moduleId", "actionId");

CREATE UNIQUE INDEX IF NOT EXISTS "rbac_role_rules_roleId_actionId_moduleId_subjectId_key" ON "rbac_role_rules" ("roleId", "actionId", "moduleId", "subjectId");
CREATE        INDEX IF NOT EXISTS "rbac_role_rules_roleId_idx"           ON "rbac_role_rules" ("roleId");
CREATE        INDEX IF NOT EXISTS "rbac_role_rules_tenantId_roleId_idx"  ON "rbac_role_rules" ("tenantId", "roleId");

-- The composite unique above does NOT actually enforce uniqueness: PostgreSQL
-- treats NULLs as distinct in a UNIQUE index, and exactly one of moduleId /
-- subjectId is always NULL by the XOR constraint below. Without these two partial
-- indexes a role could accumulate duplicate grants for the same (action, target),
-- which would then be deduped only by chance in the compiler. Prisma cannot
-- express partial unique indexes, so they are declared here.
CREATE UNIQUE INDEX IF NOT EXISTS "rbac_role_rules_module_target_key"
    ON "rbac_role_rules" ("roleId", "actionId", "moduleId") WHERE "subjectId" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "rbac_role_rules_subject_target_key"
    ON "rbac_role_rules" ("roleId", "actionId", "subjectId") WHERE "moduleId" IS NULL;

-- Same NULL-distinctness problem as the rule targets above, and for the same
-- reason: every SYSTEM row has tenantId IS NULL, so the composite uniques do not
-- constrain the global registry at all — two global modules could share the key
-- 'Accounts' and the compiler would silently pick whichever the query returned
-- first. These partial indexes are what actually make a global key unique.
CREATE UNIQUE INDEX IF NOT EXISTS "rbac_modules_global_key"              ON "rbac_modules" ("key")                          WHERE "tenantId" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "rbac_actions_global_key"              ON "rbac_actions" ("key")                          WHERE "tenantId" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "rbac_subjects_global_key"             ON "rbac_subjects" ("key")                         WHERE "tenantId" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "rbac_subject_modules_global_key"      ON "rbac_subject_modules" ("subjectId")            WHERE "tenantId" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "rbac_module_actions_global_key"       ON "rbac_module_actions" ("moduleId", "actionId")  WHERE "tenantId" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "rbac_principal_attributes_global_key" ON "rbac_principal_attributes" ("key")             WHERE "tenantId" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "rbac_subject_attributes_tenantId_subjectId_path_key" ON "rbac_subject_attributes" ("tenantId", "subjectId", "path");
CREATE UNIQUE INDEX IF NOT EXISTS "rbac_subject_attributes_global_key"   ON "rbac_subject_attributes" ("subjectId", "path") WHERE "tenantId" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "rbac_user_attributes_tenantId_userId_key_key"        ON "rbac_user_attributes" ("tenantId", "userId", "key");
CREATE        INDEX IF NOT EXISTS "rbac_user_attributes_tenantId_userId_idx"            ON "rbac_user_attributes" ("tenantId", "userId");
CREATE UNIQUE INDEX IF NOT EXISTS "rbac_principal_attributes_tenantId_key_key"          ON "rbac_principal_attributes" ("tenantId", "key");

CREATE INDEX IF NOT EXISTS "rbac_route_permissions_tenantId_method_sortOrder_idx" ON "rbac_route_permissions" ("tenantId", "method", "sortOrder");
CREATE INDEX IF NOT EXISTS "rbac_rule_change_log_tenantId_createdAt_idx"          ON "rbac_rule_change_log" ("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "rbac_rule_change_log_entityType_entityId_idx"         ON "rbac_rule_change_log" ("entityType", "entityId");

-- ── Foreign keys ─────────────────────────────────────────────────────────────

DO $$ BEGIN
    ALTER TABLE "rbac_subject_modules" ADD CONSTRAINT "rbac_subject_modules_subjectId_fkey"
        FOREIGN KEY ("subjectId") REFERENCES "rbac_subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "rbac_subject_modules" ADD CONSTRAINT "rbac_subject_modules_moduleId_fkey"
        FOREIGN KEY ("moduleId") REFERENCES "rbac_modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "rbac_module_actions" ADD CONSTRAINT "rbac_module_actions_moduleId_fkey"
        FOREIGN KEY ("moduleId") REFERENCES "rbac_modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "rbac_module_actions" ADD CONSTRAINT "rbac_module_actions_actionId_fkey"
        FOREIGN KEY ("actionId") REFERENCES "rbac_actions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "rbac_role_rules" ADD CONSTRAINT "rbac_role_rules_roleId_fkey"
        FOREIGN KEY ("roleId") REFERENCES "custom_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "rbac_role_rules" ADD CONSTRAINT "rbac_role_rules_actionId_fkey"
        FOREIGN KEY ("actionId") REFERENCES "rbac_actions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "rbac_role_rules" ADD CONSTRAINT "rbac_role_rules_moduleId_fkey"
        FOREIGN KEY ("moduleId") REFERENCES "rbac_modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "rbac_role_rules" ADD CONSTRAINT "rbac_role_rules_subjectId_fkey"
        FOREIGN KEY ("subjectId") REFERENCES "rbac_subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "rbac_subject_attributes" ADD CONSTRAINT "rbac_subject_attributes_subjectId_fkey"
        FOREIGN KEY ("subjectId") REFERENCES "rbac_subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "rbac_route_permissions" ADD CONSTRAINT "rbac_route_permissions_subjectId_fkey"
        FOREIGN KEY ("subjectId") REFERENCES "rbac_subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── CHECK constraints (Prisma 5 cannot express these) ────────────────────────

DO $$ BEGIN
    ALTER TABLE "rbac_role_rules" ADD CONSTRAINT "rbac_role_rules_target_xor_check"
        CHECK (("moduleId" IS NULL) <> ("subjectId" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "rbac_route_permissions" ADD CONSTRAINT "rbac_route_permissions_method_check"
        CHECK ("method" IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', '*'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "rbac_route_permissions" ADD CONSTRAINT "rbac_route_permissions_mode_check"
        CHECK ("mode" IN ('require', 'deny', 'public'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "rbac_route_permissions" ADD CONSTRAINT "rbac_route_permissions_subject_required_check"
        CHECK ("mode" <> 'require' OR "subjectId" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "rbac_subject_attributes" ADD CONSTRAINT "rbac_subject_attributes_value_type_check"
        CHECK ("valueType" IN ('string', 'number', 'boolean', 'string[]', 'date'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "rbac_principal_attributes" ADD CONSTRAINT "rbac_principal_attributes_value_type_check"
        CHECK ("valueType" IN ('string', 'number', 'boolean', 'string[]', 'date'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "rbac_principal_attributes" ADD CONSTRAINT "rbac_principal_attributes_source_check"
        CHECK ("source" IN ('user', 'builtin'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "rbac_subjects" ADD CONSTRAINT "rbac_subjects_kind_check"
        CHECK ("kind" IN ('resource', 'capability'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "rbac_rule_change_log" ADD CONSTRAINT "rbac_rule_change_log_operation_check"
        CHECK ("operation" IN ('create', 'update', 'delete'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "rbac_global_version" ADD CONSTRAINT "rbac_global_version_singleton_check"
        CHECK ("id" = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- custom_roles.level stops being derived from a permission COUNT (getAutoLevel)
-- and becomes an explicit admin-set field, so its domain now needs enforcing.
DO $$ BEGIN
    ALTER TABLE "custom_roles" ADD CONSTRAINT "custom_roles_level_range_check"
        CHECK ("level" BETWEEN 1 AND 4);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Triggers ─────────────────────────────────────────────────────────────────

-- System rows are seeded from code and are the substrate enforcement resolves
-- against. They may be relabelled, re-iconed and reordered freely; they may not
-- be deleted, and their key/isSystem may not change.
CREATE OR REPLACE FUNCTION rbac_protect_system_rows() RETURNS trigger AS $$
BEGIN
    IF OLD."isSystem" THEN
        IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'cannot delete system RBAC row %.%', TG_TABLE_NAME, OLD."id";
        END IF;
        IF NEW."key" IS DISTINCT FROM OLD."key" OR NEW."isSystem" IS DISTINCT FROM OLD."isSystem" THEN
            RAISE EXCEPTION 'cannot alter key/isSystem on system RBAC row %.%', TG_TABLE_NAME, OLD."id";
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "rbac_modules_protect"  ON "rbac_modules";
CREATE TRIGGER "rbac_modules_protect"  BEFORE UPDATE OR DELETE ON "rbac_modules"
    FOR EACH ROW EXECUTE FUNCTION rbac_protect_system_rows();

DROP TRIGGER IF EXISTS "rbac_actions_protect"  ON "rbac_actions";
CREATE TRIGGER "rbac_actions_protect"  BEFORE UPDATE OR DELETE ON "rbac_actions"
    FOR EACH ROW EXECUTE FUNCTION rbac_protect_system_rows();

DROP TRIGGER IF EXISTS "rbac_subjects_protect" ON "rbac_subjects";
CREATE TRIGGER "rbac_subjects_protect" BEFORE UPDATE OR DELETE ON "rbac_subjects"
    FOR EACH ROW EXECUTE FUNCTION rbac_protect_system_rows();

-- The ledger answers "who could do what on date X". An editable ledger cannot.
CREATE OR REPLACE FUNCTION rbac_ledger_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'rbac_rule_change_log is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "rbac_ledger_immutable" ON "rbac_rule_change_log";
CREATE TRIGGER "rbac_ledger_immutable" BEFORE UPDATE OR DELETE ON "rbac_rule_change_log"
    FOR EACH ROW EXECUTE FUNCTION rbac_ledger_append_only();

-- ═══════════════════════════════════════════════════════════════════════════════
-- SYSTEM REGISTRY SEED  (D-7)
--
-- Reproduces today's effective permissions EXACTLY. Nothing anyone can do changes
-- on release day; the rebuild is behaviour-neutral by construction and the
-- backfill script re-proves it before it commits.
--
-- Deterministic 'sys-*' ids: idempotent re-runs, and the compiler's tests can
-- reference known rows.
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO "rbac_global_version" ("id", "version") VALUES (1, 0) ON CONFLICT ("id") DO NOTHING;

-- ── Modules — exactly today's six ────────────────────────────────────────────

INSERT INTO "rbac_modules" ("id", "tenantId", "key", "label", "description", "icon", "navPath", "sortOrder", "isSystem") VALUES
    ('sys-mod-accounts',  NULL, 'Accounts',  'Accounts',  'Connected AWS accounts and the audit trail over them', 'Building2',  '/app/accounts',  10, true),
    ('sys-mod-schedules', NULL, 'Schedules', 'Schedules', 'Start/stop scheduling and Fargate Spot Guard',          'CalendarClock', '/app/schedules', 20, true),
    ('sys-mod-inventory', NULL, 'Inventory', 'Inventory', 'Discovered resources, discovery runs and right-sizing', 'Boxes',      '/app/inventory', 30, true),
    ('sys-mod-aiops',     NULL, 'AIOps',     'AI Ops',    'Agent, skills, memory and knowledge bases',             'Bot',        '/app/agent',     40, true),
    ('sys-mod-settings',  NULL, 'Settings',  'Settings',  'Users, roles, tenant configuration, billing, certificates', 'Settings', '/app/settings',  50, true),
    ('sys-mod-dashboard', NULL, 'Dashboard', 'Dashboard', 'Unified read-only dashboard',                           'LayoutDashboard', '/app/dashboard', 60, true)
ON CONFLICT ("id") DO NOTHING;

-- ── Actions — CRUD grantable, plus today's aliased verbs registered as data ──
--
-- Registering the aliases reproduces ACTION_MAP's behaviour exactly while making
-- "promote approve into its own grantable column" a row edit rather than a deploy.
-- 'manage' has no aliasOfKey: the compiler expands it to the module's grantable
-- actions, deliberately NOT to CASL's built-in `manage` wildcard, so adding a new
-- action later does not retroactively widen every existing manage grant.

INSERT INTO "rbac_actions" ("id", "tenantId", "key", "label", "description", "aliasOfKey", "isDangerous", "isSystem", "sortOrder") VALUES
    ('sys-act-create',   NULL, 'create',   'Create',   NULL,                                              NULL,     false, true, 10),
    ('sys-act-read',     NULL, 'read',     'Read',     NULL,                                              NULL,     false, true, 20),
    ('sys-act-update',   NULL, 'update',   'Update',   NULL,                                              NULL,     false, true, 30),
    ('sys-act-delete',   NULL, 'delete',   'Delete',   NULL,                                              NULL,     true,  true, 40),
    ('sys-act-execute',  NULL, 'execute',  'Execute',  'Runs a schedule now — changes running AWS compute', 'update', true,  true, 50),
    ('sys-act-approve',  NULL, 'approve',  'Approve',  'Approves a pending agent action or recommendation', 'update', false, true, 60),
    ('sys-act-export',   NULL, 'export',   'Export',   'Exports audit data',                              'read',   false, true, 70),
    ('sys-act-validate', NULL, 'validate', 'Validate', 'Validates account connectivity',                  'read',   false, true, 80),
    ('sys-act-use',      NULL, 'use',      'Use',      'Uses a capability without modifying it',          'read',   false, true, 90),
    ('sys-act-manage',   NULL, 'manage',   'Manage',   'Expands to every grantable action on the module',  NULL,     false, true, 100)
ON CONFLICT ("id") DO NOTHING;

-- ── Subjects — a direct transcription of SUBJECT_TO_MODULE ───────────────────

INSERT INTO "rbac_subjects" ("id", "tenantId", "key", "label", "kind", "isSystem") VALUES
    ('sys-subj-account',        NULL, 'Account',        'AWS Account',            'resource',   true),
    ('sys-subj-auditlog',       NULL, 'AuditLog',       'Audit Log',              'resource',   true),
    ('sys-subj-schedule',       NULL, 'Schedule',       'Schedule',               'resource',   true),
    ('sys-subj-spotguard',      NULL, 'SpotGuard',      'Fargate Spot Guard',     'resource',   true),
    ('sys-subj-resource',       NULL, 'Resource',       'Inventory Resource',     'resource',   true),
    ('sys-subj-discovery',      NULL, 'Discovery',      'Discovery Run',          'resource',   true),
    ('sys-subj-rightsizing',    NULL, 'RightSizing',    'Right-Sizing',           'resource',   true),
    ('sys-subj-agent',          NULL, 'Agent',          'AI Agent',               'resource',   true),
    ('sys-subj-skill',          NULL, 'Skill',          'Skill',                  'resource',   true),
    ('sys-subj-memory',         NULL, 'Memory',         'Agent Memory',           'resource',   true),
    ('sys-subj-knowledgebase',  NULL, 'KnowledgeBase',  'Knowledge Base',         'resource',   true),
    ('sys-subj-user',           NULL, 'User',           'User',                   'resource',   true),
    ('sys-subj-role',           NULL, 'Role',           'Role',                   'resource',   true),
    ('sys-subj-tenant',         NULL, 'Tenant',         'Organization',           'resource',   true),
    ('sys-subj-billing',        NULL, 'Billing',        'Billing',                'resource',   true),
    ('sys-subj-certificate',    NULL, 'Certificate',    'Certificate',            'resource',   true),
    ('sys-subj-dashboard',      NULL, 'Dashboard',      'Dashboard',              'resource',   true),
    -- Module-named subjects. Several call sites pass a MODULE name where a subject
    -- is expected — authorize('read', 'AIOps'), authorize('update', 'Settings') —
    -- and the legacy code absorbed that via `SUBJECT_TO_MODULE[x] ?? (x as Module)`.
    -- Without these rows the compiler finds no subject and fails closed, which
    -- would revoke access that works today. Found by enumerating the route
    -- manifest; asserted by parity.test.ts.
    ('sys-subj-aiops',          NULL, 'AIOps',          'AI Ops (module-wide)',   'resource',   true),
    ('sys-subj-settings',       NULL, 'Settings',       'Settings (module-wide)', 'resource',   true),
    -- Capability subjects for agent tools (Workstream H). No backing row exists;
    -- these gate what the agent may do AS the requesting user.
    ('sys-subj-agentshell',     NULL, 'AgentShell',     'Agent: shell commands',  'capability', true),
    ('sys-subj-agentfile',      NULL, 'AgentFile',      'Agent: file access',     'capability', true),
    ('sys-subj-agentstorage',   NULL, 'AgentStorage',   'Agent: S3 storage',      'capability', true),
    ('sys-subj-agentweb',       NULL, 'AgentWeb',       'Agent: web search',      'capability', true),
    ('sys-subj-agentmcp',       NULL, 'AgentMcp',       'Agent: MCP tools',       'capability', true)
ON CONFLICT ("id") DO NOTHING;

-- Subject -> module. The SpotGuard mapping carries the original rationale from
-- types.ts:40-53 verbatim in its description, because it is a deliberate choice
-- that looks like an oversight and has been "corrected" by mistake before.
INSERT INTO "rbac_subject_modules" ("id", "tenantId", "subjectId", "moduleId") VALUES
    ('sys-sm-account',       NULL, 'sys-subj-account',       'sys-mod-accounts'),
    ('sys-sm-auditlog',      NULL, 'sys-subj-auditlog',      'sys-mod-accounts'),
    ('sys-sm-schedule',      NULL, 'sys-subj-schedule',      'sys-mod-schedules'),
    ('sys-sm-spotguard',     NULL, 'sys-subj-spotguard',     'sys-mod-schedules'),
    ('sys-sm-resource',      NULL, 'sys-subj-resource',      'sys-mod-inventory'),
    ('sys-sm-discovery',     NULL, 'sys-subj-discovery',     'sys-mod-inventory'),
    ('sys-sm-rightsizing',   NULL, 'sys-subj-rightsizing',   'sys-mod-inventory'),
    ('sys-sm-agent',         NULL, 'sys-subj-agent',         'sys-mod-aiops'),
    ('sys-sm-skill',         NULL, 'sys-subj-skill',         'sys-mod-aiops'),
    ('sys-sm-memory',        NULL, 'sys-subj-memory',        'sys-mod-aiops'),
    ('sys-sm-knowledgebase', NULL, 'sys-subj-knowledgebase', 'sys-mod-aiops'),
    ('sys-sm-user',          NULL, 'sys-subj-user',          'sys-mod-settings'),
    ('sys-sm-role',          NULL, 'sys-subj-role',          'sys-mod-settings'),
    ('sys-sm-tenant',        NULL, 'sys-subj-tenant',        'sys-mod-settings'),
    ('sys-sm-billing',       NULL, 'sys-subj-billing',       'sys-mod-settings'),
    ('sys-sm-certificate',   NULL, 'sys-subj-certificate',   'sys-mod-settings'),
    ('sys-sm-dashboard',     NULL, 'sys-subj-dashboard',     'sys-mod-dashboard'),
    ('sys-sm-aiops',         NULL, 'sys-subj-aiops',         'sys-mod-aiops'),
    ('sys-sm-settings',      NULL, 'sys-subj-settings',      'sys-mod-settings'),
    ('sys-sm-agentshell',    NULL, 'sys-subj-agentshell',    'sys-mod-aiops'),
    ('sys-sm-agentfile',     NULL, 'sys-subj-agentfile',     'sys-mod-aiops'),
    ('sys-sm-agentstorage',  NULL, 'sys-subj-agentstorage',  'sys-mod-aiops'),
    ('sys-sm-agentweb',      NULL, 'sys-subj-agentweb',      'sys-mod-aiops'),
    ('sys-sm-agentmcp',      NULL, 'sys-subj-agentmcp',      'sys-mod-aiops')
ON CONFLICT ("id") DO NOTHING;

COMMENT ON TABLE "rbac_subject_modules" IS
    'SpotGuard maps to Schedules, NOT Inventory — a deliberate choice, not an oversight. '
    'Spot Guard calls ecs:UpdateService with forceNewDeployment, i.e. it RESTARTS LIVE '
    'PRODUCTION TASKS, exactly as the Cost Scheduler does. Right Sizing only reads '
    'CloudWatch and writes advice rows, which is why Inventory is right for it and wrong '
    'here. Mapping SpotGuard under Inventory would be a silent privilege escalation: every '
    'holder of Inventory:update would instantly gain the power to bounce production ECS '
    'services without anyone editing a role.';

-- ── Which grid cells exist — reproduces role-dialog.tsx allowedActions ───────
-- All four CRUD per module, except Dashboard which is read-only for everyone.

INSERT INTO "rbac_module_actions" ("id", "tenantId", "moduleId", "actionId", "grantable")
SELECT
    'sys-ma-' || m."key" || '-' || a."key",
    NULL,
    m."id",
    a."id",
    true
FROM "rbac_modules" m
CROSS JOIN "rbac_actions" a
WHERE m."tenantId" IS NULL
  AND a."tenantId" IS NULL
  AND a."key" IN ('create', 'read', 'update', 'delete')
  AND m."key" <> 'Dashboard'
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "rbac_module_actions" ("id", "tenantId", "moduleId", "actionId", "grantable") VALUES
    ('sys-ma-Dashboard-read', NULL, 'sys-mod-dashboard', 'sys-act-read', true)
ON CONFLICT ("id") DO NOTHING;

-- ── Preset roles — the four existing rows, now isSystem with explicit level ──
--
-- Inserted if absent because the seed does NOT run in the container, so a
-- production database may never have had them. Level is set explicitly (D-8),
-- matching what getAutoLevel() derives today, so nobody's assignment rights
-- change on release day.

INSERT INTO "custom_roles" ("id", "tenantId", "name", "type", "permissions", "level", "isSystem", "description", "createdBy", "createdAt", "updatedAt") VALUES
    ('preset-owner',  NULL, 'Owner',  'preset', '{}'::jsonb, 4, true, 'Full control over everything in the organization', 'system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('preset-admin',  NULL, 'Admin',  'preset', '{}'::jsonb, 3, true, 'Full control except deleting organization settings', 'system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('preset-member', NULL, 'Member', 'preset', '{}'::jsonb, 2, true, 'Can create and edit, but not delete or change settings', 'system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('preset-viewer', NULL, 'Viewer', 'preset', '{}'::jsonb, 1, true, 'Read-only across every module', 'system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- Existing installs already have these rows with permissions populated; mark them
-- as system and pin the level without touching the legacy permissions blob.
UPDATE "custom_roles" SET "isSystem" = true, "level" = 4 WHERE "id" = 'preset-owner'  AND "isSystem" = false;
UPDATE "custom_roles" SET "isSystem" = true, "level" = 3 WHERE "id" = 'preset-admin'  AND "isSystem" = false;
UPDATE "custom_roles" SET "isSystem" = true, "level" = 2 WHERE "id" = 'preset-member' AND "isSystem" = false;
UPDATE "custom_roles" SET "isSystem" = true, "level" = 1 WHERE "id" = 'preset-viewer' AND "isSystem" = false;

-- ── Preset grants — ROLE_PERMISSIONS materialised as module-level rules ──────
--
-- Byte-for-byte the matrix in apps/web-ui/lib/rbac/permissions.ts:
--   Owner   all six modules CRUD, Dashboard read
--   Admin   as Owner but Settings has no delete
--   Member  CRU on the four operational modules, Settings read, Dashboard read
--   Viewer  read everywhere

INSERT INTO "rbac_role_rules" ("id", "tenantId", "roleId", "actionId", "moduleId", "createdBy")
SELECT
    'sys-rule-' || g.role_id || '-' || g.module_key || '-' || act,
    NULL,
    g.role_id,
    a."id",
    m."id",
    'system'
FROM (VALUES
    ('preset-owner',  'Accounts',  ARRAY['create', 'read', 'update', 'delete']),
    ('preset-owner',  'Schedules', ARRAY['create', 'read', 'update', 'delete']),
    ('preset-owner',  'AIOps',     ARRAY['create', 'read', 'update', 'delete']),
    ('preset-owner',  'Inventory', ARRAY['create', 'read', 'update', 'delete']),
    ('preset-owner',  'Settings',  ARRAY['create', 'read', 'update', 'delete']),
    ('preset-owner',  'Dashboard', ARRAY['read']),

    ('preset-admin',  'Accounts',  ARRAY['create', 'read', 'update', 'delete']),
    ('preset-admin',  'Schedules', ARRAY['create', 'read', 'update', 'delete']),
    ('preset-admin',  'AIOps',     ARRAY['create', 'read', 'update', 'delete']),
    ('preset-admin',  'Inventory', ARRAY['create', 'read', 'update', 'delete']),
    ('preset-admin',  'Settings',  ARRAY['create', 'read', 'update']),
    ('preset-admin',  'Dashboard', ARRAY['read']),

    ('preset-member', 'Accounts',  ARRAY['create', 'read', 'update']),
    ('preset-member', 'Schedules', ARRAY['create', 'read', 'update']),
    ('preset-member', 'AIOps',     ARRAY['create', 'read', 'update']),
    ('preset-member', 'Inventory', ARRAY['create', 'read', 'update']),
    ('preset-member', 'Settings',  ARRAY['read']),
    ('preset-member', 'Dashboard', ARRAY['read']),

    ('preset-viewer', 'Accounts',  ARRAY['read']),
    ('preset-viewer', 'Schedules', ARRAY['read']),
    ('preset-viewer', 'AIOps',     ARRAY['read']),
    ('preset-viewer', 'Inventory', ARRAY['read']),
    ('preset-viewer', 'Settings',  ARRAY['read']),
    ('preset-viewer', 'Dashboard', ARRAY['read'])
) AS g(role_id, module_key, actions)
CROSS JOIN LATERAL unnest(g.actions) AS act
JOIN "rbac_modules" m ON m."key" = g.module_key AND m."tenantId" IS NULL
JOIN "rbac_actions" a ON a."key" = act          AND a."tenantId" IS NULL
JOIN "custom_roles" r ON r."id"  = g.role_id
ON CONFLICT ("id") DO NOTHING;

-- ── Principal attributes — the $var allowlist ────────────────────────────────

INSERT INTO "rbac_principal_attributes" ("id", "tenantId", "key", "label", "valueType", "source", "isSystem") VALUES
    ('sys-pa-user-id',                 NULL, 'user.id',                 'User ID',              'string',   'builtin', true),
    ('sys-pa-user-email',              NULL, 'user.email',              'User email',           'string',   'builtin', true),
    ('sys-pa-user-tenantid',           NULL, 'user.tenantId',           'Organization ID',      'string',   'builtin', true),
    ('sys-pa-user-roleid',             NULL, 'user.roleId',             'Role ID',              'string',   'builtin', true),
    ('sys-pa-user-allowedaccountids',  NULL, 'user.allowedAccountIds',  'Allowed AWS accounts', 'string[]', 'user',    true)
ON CONFLICT ("id") DO NOTHING;

-- ── Subject attributes — what conditions may reference ───────────────────────

INSERT INTO "rbac_subject_attributes" ("id", "tenantId", "subjectId", "path", "label", "valueType", "operators", "isSystem") VALUES
    ('sys-sa-schedule-accountid',    NULL, 'sys-subj-schedule',    'accountId',        'AWS Account',  'string',  ARRAY['$eq', '$ne', '$in', '$nin'],           true),
    ('sys-sa-schedule-active',       NULL, 'sys-subj-schedule',    'active',           'Active',       'boolean', ARRAY['$eq', '$ne'],                          true),
    ('sys-sa-schedule-timezone',     NULL, 'sys-subj-schedule',    'timezone',         'Timezone',     'string',  ARRAY['$eq', '$ne', '$in', '$nin'],           true),

    ('sys-sa-resource-accountid',    NULL, 'sys-subj-resource',    'accountId',        'AWS Account',  'string',  ARRAY['$eq', '$ne', '$in', '$nin'],           true),
    ('sys-sa-resource-type',         NULL, 'sys-subj-resource',    'resourceType',     'Resource type','string',  ARRAY['$eq', '$ne', '$in', '$nin'],           true),
    ('sys-sa-resource-region',       NULL, 'sys-subj-resource',    'region',           'Region',       'string',  ARRAY['$eq', '$ne', '$in', '$nin'],           true),
    ('sys-sa-resource-env',          NULL, 'sys-subj-resource',    'tags.Environment', 'Environment',  'string',  ARRAY['$eq', '$ne', '$in', '$nin', '$exists'], true),

    ('sys-sa-account-accountid',     NULL, 'sys-subj-account',     'accountId',        'AWS Account',  'string',  ARRAY['$eq', '$ne', '$in', '$nin'],           true),
    ('sys-sa-account-alias',         NULL, 'sys-subj-account',     'alias',            'Alias',        'string',  ARRAY['$eq', '$ne', '$in', '$nin'],           true),
    ('sys-sa-account-env',           NULL, 'sys-subj-account',     'tags.Environment', 'Environment',  'string',  ARRAY['$eq', '$ne', '$in', '$nin', '$exists'], true),

    ('sys-sa-certificate-domain',    NULL, 'sys-subj-certificate', 'domain',           'Domain',       'string',  ARRAY['$eq', '$ne', '$in', '$nin'],           true),
    ('sys-sa-certificate-accountid', NULL, 'sys-subj-certificate', 'accountId',        'AWS Account',  'string',  ARRAY['$eq', '$ne', '$in', '$nin'],           true),

    ('sys-sa-spotguard-accountid',   NULL, 'sys-subj-spotguard',   'accountId',        'AWS Account',  'string',  ARRAY['$eq', '$ne', '$in', '$nin'],           true),
    ('sys-sa-spotguard-clusterarn',  NULL, 'sys-subj-spotguard',   'clusterArn',       'Cluster ARN',  'string',  ARRAY['$eq', '$ne', '$in', '$nin'],           true)
ON CONFLICT ("id") DO NOTHING;
