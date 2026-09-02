import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeSchemaQueryMock = vi.hoisted(() => vi.fn());
const executeReadOnlyQueryMock = vi.hoisted(() => vi.fn());
vi.mock('../db', () => ({
    executeSchemaQuery: executeSchemaQueryMock,
    executeReadOnlyQuery: executeReadOnlyQueryMock,
}));

import { describeSchemaNode } from './describe-schema';
import type { TextToSQLState } from '../state';

function baseState(overrides: Partial<TextToSQLState> = {}): TextToSQLState {
    return {
        question: 'q',
        conversationHistory: [],
        tenantId: 'tenant-1',
        modelConfig: null,
        filters: undefined,
        schemaDescription: '',
        sampleRows: [],
        generatedSQL: '',
        sqlResult: null,
        sqlError: null,
        reflectionFeedback: '',
        iteration: 0,
        maxIterations: 3,
        satisfied: false,
        finalAnswer: '',
        ...overrides,
    };
}

describe('describeSchemaNode', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns {} without querying when the schema is already cached', async () => {
        const result = await describeSchemaNode(baseState({ schemaDescription: 'id (uuid, nullable: NO)' }));
        expect(result).toEqual({});
        expect(executeSchemaQueryMock).not.toHaveBeenCalled();
    });

    it('describes the schema and fetches sample rows scoped to the tenant', async () => {
        executeSchemaQueryMock.mockResolvedValue([
            { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
            { column_name: 'name', data_type: 'text', is_nullable: 'YES' },
        ]);
        executeReadOnlyQueryMock.mockResolvedValue({ rows: [{ id: '1' }], rowCount: 1 });

        const result = await describeSchemaNode(baseState({ tenantId: 'tenant-9' }));

        expect(result.schemaDescription).toBe('id (uuid, nullable: NO)\nname (text, nullable: YES)');
        expect(result.sampleRows).toEqual([{ id: '1' }]);
        expect(executeReadOnlyQueryMock).toHaveBeenCalledWith(
            'SELECT * FROM inventory_resources WHERE tenant_id = $1 LIMIT 5',
            ['tenant-9'],
        );
    });

    it('degrades gracefully with an empty sampleRows when the sample query fails', async () => {
        executeSchemaQueryMock.mockResolvedValue([{ column_name: 'id', data_type: 'uuid', is_nullable: 'NO' }]);
        executeReadOnlyQueryMock.mockRejectedValue(new Error('sample query failed'));

        const result = await describeSchemaNode(baseState());
        expect(result.sampleRows).toEqual([]);
        expect(result.schemaDescription).toContain('id (uuid');
    });
});
