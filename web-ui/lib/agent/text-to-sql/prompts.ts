import { TextToSQLFilters } from "./state";

// Strict patterns for filter value sanitization
const REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d+$/;
const ACCOUNT_ID_PATTERN = /^\d{12}$/;
const RESOURCE_TYPE_PATTERN = /^[a-z0-9_]+$/;

function sanitizeFilterValue(value: string, pattern: RegExp): string | null {
    return pattern.test(value) ? value : null;
}

export function buildSQLGenerationPrompt(
    schemaDescription: string,
    sampleRows: Record<string, unknown>[],
    filters?: TextToSQLFilters
): string {
    const sampleRowsJson = JSON.stringify(sampleRows.slice(0, 5), null, 2);

    // Describe filters in natural language — never embed raw values as SQL fragments
    const filterDescriptions: string[] = [];
    if (filters?.accountIds && filters.accountIds.length > 0) {
        const validIds = filters.accountIds.filter(id => sanitizeFilterValue(id, ACCOUNT_ID_PATTERN));
        if (validIds.length > 0) {
            filterDescriptions.push(`Filter by account_id IN (${validIds.map(id => `'${id}'`).join(', ')})`);
        }
    }
    if (filters?.region) {
        const valid = sanitizeFilterValue(filters.region, REGION_PATTERN);
        if (valid) filterDescriptions.push(`Filter by region = '${valid}'`);
    }
    if (filters?.resourceType) {
        const valid = sanitizeFilterValue(filters.resourceType, RESOURCE_TYPE_PATTERN);
        if (valid) filterDescriptions.push(`Filter by resource_type = '${valid}'`);
    }

    const filterSection =
        filterDescriptions.length > 0
            ? `\nActive inventory filters (must be included in WHERE clause in addition to tenant_id):\n${filterDescriptions.map((c) => `  - ${c}`).join("\n")}`
            : "";

    return `You are a PostgreSQL expert. Generate a single SELECT query for the inventory_resources table.

## Table Schema
${schemaDescription}

## Sample Rows
${sampleRowsJson}

## Rules
1. Only generate SELECT statements — never INSERT, UPDATE, DELETE, DROP, or any DDL.
2. Always include WHERE tenant_id = $1 as the first condition (tenant_id is a required parameter).
3. Only query the inventory_resources table — no JOINs to other tables.
4. Always include a LIMIT clause (default LIMIT 100 unless the question asks for a specific count or aggregation).
5. Use JSONB operators for tags and metadata columns:
   - Key existence: tags ? 'key'
   - Key-value match: tags->>'key' = 'value'
   - Nested access: metadata->>'attributeName'
6. For aggregations (COUNT, SUM, etc.), omit the LIMIT clause.
7. Use ILIKE for case-insensitive text matching on name, resource_id, status.
8. Return only columns relevant to the question — avoid SELECT * unless the question asks for full details.
${filterSection}

## Output
Return ONLY the SQL query. No explanation, no markdown code fences, no comments.`;
}

export function buildReflectionPrompt(
    question: string,
    sql: string,
    result: { rows: Record<string, unknown>[]; rowCount: number } | null,
    error: string | null
): string {
    let resultSection: string;
    if (error) {
        resultSection = `Query Error:\n${error}`;
    } else if (result) {
        const previewRows = result.rows.slice(0, 5);
        resultSection = `Row Count: ${result.rowCount}\nFirst ${previewRows.length} rows:\n${JSON.stringify(previewRows, null, 2)}`;
    } else {
        resultSection = "No result returned.";
    }

    return `Evaluate whether the SQL query correctly answered the user's question.

## User Question
${question}

## Generated SQL
${sql}

## Query Result
${resultSection}

## Evaluation Criteria
- ERROR: The query produced a database error — the SQL is invalid or references wrong columns/tables.
- EMPTY but WRONG: The query returned 0 rows but the question implies results should exist (e.g., asking for EC2 instances when the user can see them in the UI).
- EMPTY and CORRECT: The query returned 0 rows and that is a valid answer (e.g., "no Lambda functions in eu-west-1" — empty is correct).
- WRONG COLUMNS: The query returned data but is missing key columns needed to answer the question.
- WRONG AGGREGATION: The question asked for a count/sum/group-by but the query returned raw rows instead.
- CORRECT: The query returned data that directly answers the question.

## Output
Respond with JSON only — no explanation, no markdown:
{"satisfied": true, "feedback": "Brief reason why the result is correct."}
or
{"satisfied": false, "feedback": "Specific description of what is wrong and how to fix the SQL."}`;
}

export function buildSynthesisPrompt(
    question: string,
    sql: string,
    result: { rows: Record<string, unknown>[]; rowCount: number },
    wasRetried: boolean
): string {
    const previewRows = result.rows.slice(0, 100);
    const resultJson = JSON.stringify(previewRows, null, 2);

    const retryCaveat = wasRetried
        ? "\nNote: This answer required multiple attempts to generate. The data shown is the best available match, but may not perfectly reflect the exact question asked.\n"
        : "";

    return `You are a cloud infrastructure assistant. Answer the user's question using the query results below.

## User Question
${question}

## SQL Query Used
${sql}

## Query Results
Total rows: ${result.rowCount}
${previewRows.length < result.rowCount ? `(Showing first ${previewRows.length} of ${result.rowCount} rows)\n` : ""}${resultJson}
${retryCaveat}
## Rules
1. Answer the question directly and concisely — lead with the key finding.
2. Use a markdown table when listing multiple resources (include relevant columns like name, resource_id, region, status, account_id).
3. Include specific counts, IDs, names, and regions from the data — be precise.
4. If the result is empty, clearly state that no matching resources were found and suggest why (wrong region, no resources of that type, etc.).
5. Do not mention SQL, databases, queries, or technical implementation details.
6. Do not say "based on the query" or "the results show" — just answer naturally.
7. If rowCount > 100, mention that only the first 100 results are shown and the total count.`;
}
