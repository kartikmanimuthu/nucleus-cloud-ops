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

    // Must reference $1 for tenant_id
    if (!sql.includes('$1')) {
        return { valid: false, sql: rawSQL, error: 'Query must include $1 parameter for tenant_id isolation.' };
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
