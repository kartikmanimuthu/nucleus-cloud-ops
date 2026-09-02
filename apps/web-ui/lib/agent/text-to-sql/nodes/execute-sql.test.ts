import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeReadOnlyQueryMock = vi.hoisted(() => vi.fn());
vi.mock('../db', () => ({ executeReadOnlyQuery: executeReadOnlyQueryMock }));

const validateSQLMock = vi.hoisted(() => vi.fn());
vi.mock('../sql-validator', () => ({ validateSQL: validateSQLMock }));

import { executeSQLNode } from './execute-sql';
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
        generatedSQL: 'SELECT * FROM inventory_resources WHERE tenant_id = $1',
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

describe('executeSQLNode', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns a validation error without executing when validateSQL rejects', async () => {
        validateSQLMock.mockReturnValue({ valid: false, sql: 'DROP TABLE x', error: 'Forbidden SQL keyword: DROP' });
        const result = await executeSQLNode(baseState({ generatedSQL: 'DROP TABLE x' }));
        expect(result).toEqual({ sqlError: 'Forbidden SQL keyword: DROP', sqlResult: null });
        expect(executeReadOnlyQueryMock).not.toHaveBeenCalled();
    });

    it('executes the validated SQL scoped to the state tenantId', async () => {
        validateSQLMock.mockReturnValue({ valid: true, sql: 'SELECT * FROM inventory_resources WHERE tenant_id = $1' });
        executeReadOnlyQueryMock.mockResolvedValue({ rows: [{ id: '1' }], rowCount: 1 });

        const result = await executeSQLNode(baseState({ tenantId: 'tenant-42' }));

        expect(executeReadOnlyQueryMock).toHaveBeenCalledWith('SELECT * FROM inventory_resources WHERE tenant_id = $1', ['tenant-42']);
        expect(result).toEqual({ sqlResult: { rows: [{ id: '1' }], rowCount: 1 }, sqlError: null });
    });

    it('returns the error message and null result when execution throws', async () => {
        validateSQLMock.mockReturnValue({ valid: true, sql: 'SELECT 1' });
        executeReadOnlyQueryMock.mockRejectedValue(new Error('connection refused'));

        const result = await executeSQLNode(baseState());
        expect(result).toEqual({ sqlError: 'connection refused', sqlResult: null });
    });

    it('stringifies a non-Error thrown value', async () => {
        validateSQLMock.mockReturnValue({ valid: true, sql: 'SELECT 1' });
        executeReadOnlyQueryMock.mockRejectedValue('raw string failure');

        const result = await executeSQLNode(baseState());
        expect(result.sqlError).toBe('raw string failure');
    });
});
