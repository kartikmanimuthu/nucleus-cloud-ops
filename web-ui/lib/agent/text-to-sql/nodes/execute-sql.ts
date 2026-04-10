import { validateSQL } from '../sql-validator';
import { executeReadOnlyQuery } from '../db';
import type { TextToSQLState } from '../state';

export async function executeSQLNode(state: TextToSQLState): Promise<Partial<TextToSQLState>> {
    // Validate before execution
    const validation = validateSQL(state.generatedSQL);
    if (!validation.valid) {
        console.log(`[TextToSQL] SQL validation failed: ${validation.error}`);
        return { sqlError: validation.error!, sqlResult: null };
    }

    try {
        const result = await executeReadOnlyQuery(validation.sql, [state.tenantId]);
        console.log(`[TextToSQL] Query executed: ${result.rowCount} rows returned`);
        return { sqlResult: result, sqlError: null };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[TextToSQL] SQL execution error: ${message}`);
        return { sqlError: message, sqlResult: null };
    }
}
