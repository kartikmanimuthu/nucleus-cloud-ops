import { describe, it, expect } from 'vitest';
import { validateSQL } from '../sql-validator';

describe('validateSQL', () => {
    it('passes a valid SELECT with tenant_id param', () => {
        const result = validateSQL("SELECT * FROM inventory_resources WHERE tenant_id = $1 LIMIT 100");
        expect(result.valid).toBe(true);
        expect(result.sql).toContain('LIMIT');
    });

    it('rejects INSERT statements', () => {
        const result = validateSQL("INSERT INTO inventory_resources (tenant_id) VALUES ($1)");
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/SELECT.*only/i);
    });

    it('rejects UPDATE statements', () => {
        expect(validateSQL("UPDATE inventory_resources SET name = 'x' WHERE tenant_id = $1").valid).toBe(false);
    });

    it('rejects DELETE statements', () => {
        expect(validateSQL("DELETE FROM inventory_resources WHERE tenant_id = $1").valid).toBe(false);
    });

    it('rejects DROP statements', () => {
        expect(validateSQL("DROP TABLE inventory_resources").valid).toBe(false);
    });

    it('rejects ALTER statements', () => {
        expect(validateSQL("ALTER TABLE inventory_resources ADD COLUMN x TEXT").valid).toBe(false);
    });

    it('rejects CREATE statements', () => {
        expect(validateSQL("CREATE TABLE evil (id TEXT)").valid).toBe(false);
    });

    it('rejects TRUNCATE statements', () => {
        expect(validateSQL("TRUNCATE inventory_resources").valid).toBe(false);
    });

    it('rejects queries without $1 tenant param', () => {
        const result = validateSQL("SELECT * FROM inventory_resources LIMIT 100");
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/tenant/i);
    });

    it('rejects queries referencing other tables', () => {
        const result = validateSQL("SELECT * FROM auth_users WHERE tenant_id = $1");
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/inventory_resources/i);
    });

    it('rejects queries referencing information_schema', () => {
        expect(validateSQL("SELECT * FROM information_schema.columns WHERE tenant_id = $1").valid).toBe(false);
    });

    it('rejects queries referencing pg_catalog', () => {
        expect(validateSQL("SELECT * FROM pg_catalog.pg_tables WHERE tenant_id = $1").valid).toBe(false);
    });

    it('appends LIMIT 500 when no LIMIT present', () => {
        const result = validateSQL("SELECT * FROM inventory_resources WHERE tenant_id = $1");
        expect(result.valid).toBe(true);
        expect(result.sql).toMatch(/LIMIT 500$/i);
    });

    it('preserves existing LIMIT if <= 500', () => {
        const result = validateSQL("SELECT * FROM inventory_resources WHERE tenant_id = $1 LIMIT 100");
        expect(result.valid).toBe(true);
        expect(result.sql).toMatch(/LIMIT 100/i);
    });

    it('caps LIMIT to 500 if > 500', () => {
        const result = validateSQL("SELECT * FROM inventory_resources WHERE tenant_id = $1 LIMIT 9999");
        expect(result.valid).toBe(true);
        expect(result.sql).toMatch(/LIMIT 500/i);
    });

    it('handles GROUP BY queries', () => {
        const result = validateSQL(
            "SELECT resource_type, COUNT(*) FROM inventory_resources WHERE tenant_id = $1 GROUP BY resource_type LIMIT 50"
        );
        expect(result.valid).toBe(true);
    });
});
