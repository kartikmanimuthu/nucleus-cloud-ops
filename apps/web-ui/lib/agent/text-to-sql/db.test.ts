import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockEnv = vi.hoisted(() => ({ DATABASE_URL: undefined as string | undefined }));
vi.mock('@/env', () => ({ env: mockEnv }));

const clientMock = vi.hoisted(() => ({
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
}));
const poolInstances = vi.hoisted(() => [] as any[]);
const PoolMock = vi.hoisted(() =>
    vi.fn().mockImplementation(function (this: any, opts: unknown) {
        this.opts = opts;
        this.connect = vi.fn().mockResolvedValue(clientMock);
        this.end = vi.fn().mockResolvedValue(undefined);
        poolInstances.push(this);
    }),
);
vi.mock('pg', () => ({ Pool: PoolMock }));

import { getTextToSQLPool, executeReadOnlyQuery, executeSchemaQuery, closeTextToSQLPool } from './db';

describe('text-to-sql db', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockEnv.DATABASE_URL = 'postgres://test';
        clientMock.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        clientMock.release.mockReset();
        poolInstances.length = 0;
    });

    afterEach(async () => {
        await closeTextToSQLPool();
    });

    describe('getTextToSQLPool', () => {
        it('throws when DATABASE_URL is not configured', async () => {
            mockEnv.DATABASE_URL = undefined;
            expect(() => getTextToSQLPool()).toThrow('DATABASE_URL is required for text-to-sql agent');
        });

        it('creates a small (max 3) singleton pool and reuses it', () => {
            const first = getTextToSQLPool();
            const second = getTextToSQLPool();
            expect(first).toBe(second);
            expect(PoolMock).toHaveBeenCalledTimes(1);
            expect(PoolMock).toHaveBeenCalledWith(expect.objectContaining({ max: 3 }));
        });
    });

    describe('executeReadOnlyQuery', () => {
        it('runs BEGIN/SET LOCAL/query/COMMIT and releases the client', async () => {
            clientMock.query
                .mockResolvedValueOnce(undefined) // BEGIN
                .mockResolvedValueOnce(undefined) // SET LOCAL
                .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }) // actual query
                .mockResolvedValueOnce(undefined); // COMMIT

            const result = await executeReadOnlyQuery('SELECT * FROM inventory_resources WHERE tenant_id = $1', ['t1']);

            expect(clientMock.query).toHaveBeenNthCalledWith(1, 'BEGIN TRANSACTION READ ONLY');
            expect(clientMock.query).toHaveBeenNthCalledWith(2, 'SET LOCAL statement_timeout = 10000');
            expect(clientMock.query).toHaveBeenNthCalledWith(3, 'SELECT * FROM inventory_resources WHERE tenant_id = $1', ['t1']);
            expect(clientMock.query).toHaveBeenNthCalledWith(4, 'COMMIT');
            expect(result).toEqual({ rows: [{ id: 1 }], rowCount: 1 });
            expect(clientMock.release).toHaveBeenCalledTimes(1);
        });

        it('defaults rowCount to 0 when the driver returns null', async () => {
            clientMock.query
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce({ rows: [], rowCount: null })
                .mockResolvedValueOnce(undefined);

            const result = await executeReadOnlyQuery('SELECT 1', []);
            expect(result.rowCount).toBe(0);
        });

        it('rolls back and releases on failure, then rethrows', async () => {
            clientMock.query
                .mockResolvedValueOnce(undefined) // BEGIN
                .mockResolvedValueOnce(undefined) // SET LOCAL
                .mockRejectedValueOnce(new Error('bad sql')) // actual query fails
                .mockResolvedValueOnce(undefined); // ROLLBACK

            await expect(executeReadOnlyQuery('SELECT bad', [])).rejects.toThrow('bad sql');
            expect(clientMock.query).toHaveBeenCalledWith('ROLLBACK');
            expect(clientMock.release).toHaveBeenCalledTimes(1);
        });

        it('still releases the client even if ROLLBACK itself fails', async () => {
            clientMock.query
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce(undefined)
                .mockRejectedValueOnce(new Error('bad sql'))
                .mockRejectedValueOnce(new Error('rollback failed'));

            await expect(executeReadOnlyQuery('SELECT bad', [])).rejects.toThrow('bad sql');
            expect(clientMock.release).toHaveBeenCalledTimes(1);
        });
    });

    describe('executeSchemaQuery', () => {
        it('runs the query in a read-only transaction and returns rows', async () => {
            clientMock.query
                .mockResolvedValueOnce(undefined) // BEGIN
                .mockResolvedValueOnce({ rows: [{ column_name: 'id' }] }) // query
                .mockResolvedValueOnce(undefined); // COMMIT

            const rows = await executeSchemaQuery('SELECT column_name FROM information_schema.columns');
            expect(rows).toEqual([{ column_name: 'id' }]);
            expect(clientMock.release).toHaveBeenCalledTimes(1);
        });

        it('rolls back and releases on failure, then rethrows', async () => {
            clientMock.query
                .mockResolvedValueOnce(undefined)
                .mockRejectedValueOnce(new Error('schema query failed'))
                .mockResolvedValueOnce(undefined);

            await expect(executeSchemaQuery('SELECT bad')).rejects.toThrow('schema query failed');
            expect(clientMock.query).toHaveBeenCalledWith('ROLLBACK');
        });
    });

    describe('closeTextToSQLPool', () => {
        it('ends the pool and clears the singleton so a new one is created next time', async () => {
            const pool = getTextToSQLPool();
            await closeTextToSQLPool();
            expect(pool.end).toHaveBeenCalledTimes(1);

            getTextToSQLPool();
            expect(PoolMock).toHaveBeenCalledTimes(2);
        });

        it('is a no-op when no pool has been created', async () => {
            await expect(closeTextToSQLPool()).resolves.toBeUndefined();
        });
    });
});
