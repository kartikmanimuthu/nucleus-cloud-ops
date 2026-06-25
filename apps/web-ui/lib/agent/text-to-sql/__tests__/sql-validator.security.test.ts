import { describe, it, expect } from 'vitest';
import { validateSQL } from '../sql-validator';

describe('SQL Validator Security', () => {
    it('blocks UNION-based table access', () => {
        expect(validateSQL(
            "SELECT * FROM inventory_resources WHERE tenant_id = $1 UNION SELECT * FROM auth_users"
        ).valid).toBe(false);
    });

    it('blocks subquery accessing other tables', () => {
        expect(validateSQL(
            "SELECT * FROM inventory_resources WHERE tenant_id = $1 AND account_id IN (SELECT id FROM accounts)"
        ).valid).toBe(false);
    });

    it('allows commented-out dangerous SQL (comments stripped)', () => {
        const result = validateSQL(
            "SELECT * FROM inventory_resources WHERE tenant_id = $1 -- UNION SELECT * FROM auth_users"
        );
        expect(result.valid).toBe(true);
    });

    it('blocks semicolon-separated statements', () => {
        expect(validateSQL(
            "SELECT * FROM inventory_resources WHERE tenant_id = $1; DELETE FROM inventory_resources"
        ).valid).toBe(false);
    });

    it('blocks GRANT/REVOKE', () => {
        expect(validateSQL("GRANT ALL ON inventory_resources TO public").valid).toBe(false);
        expect(validateSQL("REVOKE ALL ON inventory_resources FROM public").valid).toBe(false);
    });

    it('blocks COPY command', () => {
        expect(validateSQL(
            "COPY inventory_resources TO '/tmp/dump.csv' WHERE tenant_id = $1"
        ).valid).toBe(false);
    });

    it('is case-insensitive for dangerous keywords', () => {
        expect(validateSQL("insert INTO inventory_resources VALUES ($1)").valid).toBe(false);
        expect(validateSQL("DeLeTe FROM inventory_resources WHERE tenant_id = $1").valid).toBe(false);
    });
});
