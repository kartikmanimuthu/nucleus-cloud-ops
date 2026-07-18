-- Backfill Dashboard: ['read'] into existing custom roles so the new Dashboard module
-- does not lock out tenants that were created before the Dashboard permission existed.
-- Preset roles are re-seeded from ROLE_PERMISSIONS by the Prisma seed script.

UPDATE "custom_roles"
SET permissions = permissions || '{"Dashboard": ["read"]}'::jsonb
WHERE type = 'custom'
  AND (permissions->'Dashboard') IS NULL;
