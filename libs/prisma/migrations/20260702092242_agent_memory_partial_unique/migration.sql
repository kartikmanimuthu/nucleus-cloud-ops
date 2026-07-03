-- Replace the full unique constraint with a live-rows-only partial unique index so a
-- superseded row and its same-key successor can coexist (supersede audit trail).
-- Index name verified in DB: agent_memories_tenantId_namespace_key_key
DROP INDEX "agent_memories_tenantId_namespace_key_key";

-- Plain index for lookup performance (mirrors the schema's @@index).
CREATE INDEX "agent_memories_tenantId_namespace_key_idx"
  ON "agent_memories"("tenantId", "namespace", "key");

-- Uniqueness applies to LIVE rows only.
CREATE UNIQUE INDEX "agent_memories_live_tenant_ns_key"
  ON "agent_memories" ("tenantId", "namespace", "key")
  WHERE "supersededById" IS NULL;
