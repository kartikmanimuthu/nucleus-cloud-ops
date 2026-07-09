export interface ValidationResult {
    valid: boolean;
    sql: string;
    error?: string;
}

const ALLOWED_TABLES = ['inventory_resources'];

const FORBIDDEN_KEYWORDS = [
    'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE',
    'TRUNCATE', 'GRANT', 'REVOKE', 'COPY', 'EXECUTE',
];

export function validateSQL(rawSQL: string): ValidationResult {
    // Strip SQL comments to prevent bypass
    let sql = rawSQL
        .replace(/--.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim();

    // Reject multiple statements
    const statements = sql.split(';').filter(s => s.trim().length > 0);
    if (statements.length > 1) {
        return { valid: false, sql: rawSQL, error: 'Multiple SQL statements are not allowed.' };
    }
    sql = statements[0].trim();

    // Must start with SELECT
    if (!/^\s*SELECT\b/i.test(sql)) {
        return { valid: false, sql: rawSQL, error: 'SELECT queries only — INSERT/UPDATE/DELETE/DDL are not allowed.' };
    }

    // Check for forbidden keywords
    for (const keyword of FORBIDDEN_KEYWORDS) {
        if (new RegExp(`\\b${keyword}\\b`, 'i').test(sql)) {
            return { valid: false, sql: rawSQL, error: `Forbidden SQL keyword: ${keyword}. Only SELECT queries are allowed.` };
        }
    }

    // Must contain a genuine tenant-id equality predicate bound to $1.
    // A bare `$1` reference is NOT enough — e.g. `WHERE $1 IS NOT NULL` references
    // $1 but returns every tenant's rows. Require `tenant_id = $1` (optionally
    // table-qualified, or the camelCase "tenantId" column), in either operand order.
    const TENANT_PREDICATE = /(?:\btenant_id\b|"tenantId")\s*=\s*\$1\b|\$1\s*=\s*(?:\btenant_id\b|"tenantId")/i;
    if (!TENANT_PREDICATE.test(sql)) {
        return {
            valid: false,
            sql: rawSQL,
            error: 'Query must filter by tenant with a tenant_id = $1 equality predicate for tenant isolation.',
        };
    }

    // Block system catalog access
    if (/\binformation_schema\b/i.test(sql) || /\bpg_catalog\b/i.test(sql) || /\bpg_\w+\b/i.test(sql)) {
        return { valid: false, sql: rawSQL, error: 'System catalog access is not allowed.' };
    }

    // Table allowlist — check all FROM/JOIN references
    const tablePattern = /\b(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_.]*)/gi;
    let match;
    while ((match = tablePattern.exec(sql)) !== null) {
        const tableName = match[1].toLowerCase();
        if (!ALLOWED_TABLES.includes(tableName)) {
            return { valid: false, sql: rawSQL, error: `Table "${match[1]}" is not allowed. Only inventory_resources can be queried.` };
        }
    }

    // LIMIT enforcement
    const limitMatch = sql.match(/\bLIMIT\s+(\d+)/i);
    if (limitMatch) {
        const limit = parseInt(limitMatch[1], 10);
        if (limit > 500) {
            sql = sql.replace(/\bLIMIT\s+\d+/i, 'LIMIT 500');
        }
    } else {
        sql = sql.replace(/\s*$/, ' LIMIT 500');
    }

    return { valid: true, sql };
}
