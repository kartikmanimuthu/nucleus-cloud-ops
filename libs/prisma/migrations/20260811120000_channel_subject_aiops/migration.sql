-- Gives the integration channels (Slack, Telegram, Discord, Jira, Webhook) a
-- subject of their own, under the existing AIOps module.
--
-- Before this, every /api/agent-ops/settings/<channel> route gated on the
-- module-wide 'Settings' subject while lib/nav-config.ts had always listed
-- Channels, Slack and Telegram under module "AIOps". The nav and the API
-- therefore disagreed about who owns the feature: a role with full AIOps but no
-- Settings saw Channels in the sidebar, could open every Configure form, and got
-- a 403 on load and on save; a Settings admin with no AIOps could drive the API
-- but never see the page. Identical to the split the Providers page had before
-- it was moved (see the comment at nav-config.ts:43).
--
-- No new module, no new grants. 'Channel' hangs off sys-mod-aiops exactly as
-- sys-subj-knowledgebase / sys-subj-skill / sys-subj-memory do, so the CRUD grid
-- (rbac_module_actions) and the preset role rules AIOps already carries apply
-- unchanged — Owner/Admin CRUD, Member CRU, Viewer R. Nobody gains a permission
-- they did not already hold over AI Ops.
--
-- NOT a repoint: unlike 20260806120000_iam_module moving User/Role onto IAM,
-- 'Channel' is a brand-new subject key that no route referenced before, so there
-- is no existing rbac_subject_modules row to update and no uniqueness conflict
-- with rbac_subject_modules_global_key.
--
-- The 'Settings' module keeps every subject it had. What changes is that the
-- channel routes stop borrowing it.

INSERT INTO "rbac_subjects" ("id", "tenantId", "key", "label", "kind", "isSystem") VALUES
    ('sys-subj-channel', NULL, 'Channel', 'Integration Channel', 'resource', true)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "rbac_subject_modules" ("id", "tenantId", "subjectId", "moduleId") VALUES
    ('sys-sm-channel', NULL, 'sys-subj-channel', 'sys-mod-aiops')
ON CONFLICT ("id") DO NOTHING;
