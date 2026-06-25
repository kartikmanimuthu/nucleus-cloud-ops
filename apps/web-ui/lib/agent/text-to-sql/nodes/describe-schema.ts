import { executeSchemaQuery, executeReadOnlyQuery } from '../db';
import type { TextToSQLState } from '../state';

interface SchemaColumn {
    column_name: string;
    data_type: string;
    is_nullable: string;
}

export async function describeSchemaNode(state: TextToSQLState): Promise<Partial<TextToSQLState>> {
    // Skip if already cached
    if (state.schemaDescription) {
        return {};
    }

    // Query information_schema for column definitions
    const columns = await executeSchemaQuery(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_name = 'inventory_resources'
         ORDER BY ordinal_position`
    ) as SchemaColumn[];

    const schemaDescription = columns
        .map((c) => `${c.column_name} (${c.data_type}, nullable: ${c.is_nullable})`)
        .join('\n');

    // Fetch sample rows for context
    let sampleRows: Record<string, unknown>[] = [];
    try {
        const result = await executeReadOnlyQuery(
            'SELECT * FROM inventory_resources WHERE tenant_id = $1 LIMIT 5',
            [state.tenantId]
        );
        sampleRows = result.rows;
    } catch {
        // Non-fatal — agent can work without samples
    }

    return { schemaDescription, sampleRows };
}
