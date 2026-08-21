-- rbac_protect_system_rows() (20260730000000_dynamic_abac) ends with an
-- unconditional `RETURN NEW`. NEW is always NULL in a DELETE trigger, and a
-- NULL return from a BEFORE DELETE row trigger silently cancels that row's
-- deletion — so every non-system DELETE on rbac_modules/rbac_actions/
-- rbac_subjects has been a silent no-op (0 rows affected, no error) since
-- that migration. The isSystem RAISE EXCEPTION path was and remains correct;
-- only the fall-through for ordinary rows was wrong. Deletes must return OLD.
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
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
