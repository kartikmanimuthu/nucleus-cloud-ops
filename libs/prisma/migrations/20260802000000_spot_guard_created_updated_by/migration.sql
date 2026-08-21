-- Audit ownership for Spot Guard registry rows.
--
-- enabledBy/disabledBy already existed but record only the MOST RECENT opt-in and opt-out, so
-- neither answers "who created this row" — a service the observer registered and a person later
-- enabled has different values for each. These mirror the Schedule model so the Spot Guard and
-- Cost Scheduler detail pages can show the same Created By / Last Modified By fields.
--
-- Defaulted to 'system': rows can be created without a human actor, and existing rows have no
-- recorded creator to backfill from.
ALTER TABLE "spot_guard_services"
    ADD COLUMN "createdBy" TEXT NOT NULL DEFAULT 'system',
    ADD COLUMN "updatedBy" TEXT NOT NULL DEFAULT 'system';
