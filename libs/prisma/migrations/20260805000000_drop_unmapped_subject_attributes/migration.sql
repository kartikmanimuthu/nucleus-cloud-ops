-- Three seeded subject attributes declare paths with no backing Prisma field,
-- which makes them authorable in a condition and untranslatable in a row filter:
-- a rule referencing one passes write-time validation and then throws
-- UntranslatableFilterError the first time a list endpoint evaluates it.
--
--   sys-sa-account-alias         Account has no `alias` column (nearest is `name`);
--                                mapping alias -> name would filter on a different
--                                field than the rule author asked for.
--   sys-sa-account-env           Account has no `tags` column at all.
--   sys-sa-certificate-accountid Certificate's account linkage lives in
--                                certificate_deployments, which schema.prisma models
--                                without a Prisma relation, so there is no `some:`
--                                filter to write.
--
-- Removing the declarations is the honest fix; adding the columns is a schema
-- change and a separate decision. prisma-filter-live.test.ts now asserts this
-- invariant, so re-adding either row without a SUBJECT_FIELDS entry fails CI.
--
-- Safe to run: zero rules reference these paths (verified — 0 of 102 live rules
-- carry conditions at all), so no grant changes meaning.
DELETE FROM "rbac_subject_attributes"
WHERE "id" IN (
    'sys-sa-account-alias',
    'sys-sa-account-env',
    'sys-sa-certificate-accountid'
);
