import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockConnect, mockClose, mockDb, mockExistsSync, instances, MongoClientMock } = vi.hoisted(() => {
    const mockConnect = vi.fn().mockResolvedValue(undefined);
    const mockClose = vi.fn().mockResolvedValue(undefined);
    const mockDb = vi.fn().mockReturnValue({ databaseName: 'fake-db' });
    const mockExistsSync = vi.fn().mockReturnValue(false);
    const instances: any[] = [];
    class MongoClientMock {
        connect = mockConnect;
        close = mockClose;
        db = mockDb;
        uri: string;
        options: unknown;
        constructor(uri: string, options: unknown) {
            this.uri = uri;
            this.options = options;
            instances.push(this);
        }
    }
    return { mockConnect, mockClose, mockDb, mockExistsSync, instances, MongoClientMock };
});

vi.mock('mongodb', () => ({ MongoClient: MongoClientMock }));
vi.mock('fs', () => ({ existsSync: mockExistsSync }));

const BASE_ENV = {
    NODE_ENV: 'development', MONGODB_URI: undefined, DOCDB_ENDPOINT: undefined, DOCDB_PORT: undefined,
    DOCDB_USERNAME: undefined, DOCDB_PASSWORD: undefined, MONGODB_DB_NAME: undefined, DEEP_AGENT_DB_NAME: undefined,
};

beforeEach(() => {
    vi.clearAllMocks();
    instances.length = 0;
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockDb.mockReturnValue({ databaseName: 'fake-db' });
    mockExistsSync.mockReturnValue(false);
    delete (globalThis as any).mongoClient;
    delete (globalThis as any).mongoDb;
});

// _client/_db and DB_NAME are module-scoped singletons (DB_NAME computed once at
// import time from env) — each test needs a pristine module instance to test the
// caching behavior in isolation, and to vary the env vars DB_NAME derives from.
async function freshModule(envOverrides: Record<string, unknown> = {}) {
    vi.resetModules();
    const env = { ...BASE_ENV, ...envOverrides };
    vi.doMock('mongodb', () => ({ MongoClient: MongoClientMock }));
    vi.doMock('fs', () => ({ existsSync: mockExistsSync }));
    vi.doMock('@/env', () => ({ env }));
    return import('./mongo-client');
}

describe('buildMongoUri (via getMongoClient)', () => {
    it('prefers an explicit MONGODB_URI over DocumentDB vars', async () => {
        const { getMongoClient } = await freshModule({
            MONGODB_URI: 'mongodb://explicit/db', DOCDB_ENDPOINT: 'docdb.internal', DOCDB_USERNAME: 'u', DOCDB_PASSWORD: 'p',
        });
        await getMongoClient();
        expect(instances[0].uri).toBe('mongodb://explicit/db');
    });

    it('builds a DocumentDB URI from individual env vars, URL-encoding the password', async () => {
        const { getMongoClient } = await freshModule({
            DOCDB_ENDPOINT: 'docdb.internal', DOCDB_USERNAME: 'admin', DOCDB_PASSWORD: 'p@ss/word',
        });
        await getMongoClient();
        expect(instances[0].uri).toContain('mongodb://admin:p%40ss%2Fword@docdb.internal:27017/');
        expect(instances[0].uri).toContain('replicaSet=rs0');
        expect(instances[0].uri).toContain('readPreference=secondaryPreferred');
    });

    it('uses the given DOCDB_PORT when set, else defaults to 27017', async () => {
        const { getMongoClient } = await freshModule({
            DOCDB_ENDPOINT: 'docdb.internal', DOCDB_USERNAME: 'admin', DOCDB_PASSWORD: 'p', DOCDB_PORT: '27018',
        });
        await getMongoClient();
        expect(instances[0].uri).toContain(':27018/');
    });

    it('appends tlsCAFile to the URI when the RDS CA bundle exists on disk', async () => {
        mockExistsSync.mockReturnValue(true);
        const { getMongoClient } = await freshModule({
            DOCDB_ENDPOINT: 'docdb.internal', DOCDB_USERNAME: 'admin', DOCDB_PASSWORD: 'p',
        });
        await getMongoClient();
        expect(instances[0].uri).toContain('&tlsCAFile=/etc/ssl/certs/rds-combined-ca-bundle.pem');
    });

    it('omits tlsCAFile from the URI when the CA bundle is absent', async () => {
        const { getMongoClient } = await freshModule({
            DOCDB_ENDPOINT: 'docdb.internal', DOCDB_USERNAME: 'admin', DOCDB_PASSWORD: 'p',
        });
        await getMongoClient();
        expect(instances[0].uri).not.toContain('tlsCAFile');
    });

    it('falls back to localhost when neither MONGODB_URI nor complete DocumentDB vars are set', async () => {
        const { getMongoClient } = await freshModule();
        await getMongoClient();
        expect(instances[0].uri).toBe('mongodb://localhost:27017');
    });

    it('falls back to localhost when DocumentDB vars are only partially set', async () => {
        const { getMongoClient } = await freshModule({ DOCDB_ENDPOINT: 'docdb.internal' }); // missing user/pass
        await getMongoClient();
        expect(instances[0].uri).toBe('mongodb://localhost:27017');
    });
});

describe('buildMongoClientOptions (via getMongoClient)', () => {
    it('includes tls/tlsCAFile when the CA bundle exists on disk', async () => {
        mockExistsSync.mockReturnValue(true);
        const { getMongoClient } = await freshModule();
        await getMongoClient();
        expect(instances[0].options).toEqual({
            maxPoolSize: 10, connectTimeoutMS: 5000, socketTimeoutMS: 45000,
            tls: true, tlsCAFile: '/etc/ssl/certs/rds-combined-ca-bundle.pem',
        });
    });

    it('omits tls/tlsCAFile when the CA bundle is absent', async () => {
        const { getMongoClient } = await freshModule();
        await getMongoClient();
        expect(instances[0].options).toEqual({ maxPoolSize: 10, connectTimeoutMS: 5000, socketTimeoutMS: 45000 });
    });
});

describe('getMongoClient', () => {
    it('connects a newly constructed client and returns it', async () => {
        const { getMongoClient } = await freshModule();
        const client = await getMongoClient();
        expect(mockConnect).toHaveBeenCalledOnce();
        expect(client).toBe(instances[0]);
    });

    it('caches the client on globalThis outside production, to survive Next.js hot reload', async () => {
        const { getMongoClient } = await freshModule({ NODE_ENV: 'development' });
        await getMongoClient();
        expect((globalThis as any).mongoClient).toBe(instances[0]);
    });

    it('does not cache on globalThis in production', async () => {
        const { getMongoClient } = await freshModule({ NODE_ENV: 'production' });
        await getMongoClient();
        expect((globalThis as any).mongoClient).toBeUndefined();
    });

    it('reuses an already-cached globalThis client without constructing a new one', async () => {
        const { getMongoClient } = await freshModule();
        await getMongoClient();
        expect(instances).toHaveLength(1);
        await getMongoClient();
        expect(instances).toHaveLength(1); // no second construction
        expect(mockConnect).toHaveBeenCalledOnce();
    });

    it('in production, reuses the module-local client across repeated calls within the same process', async () => {
        const { getMongoClient } = await freshModule({ NODE_ENV: 'production' });
        const first = await getMongoClient();
        const second = await getMongoClient();
        expect(first).toBe(second);
        expect(instances).toHaveLength(1);
    });
});

describe('getDb', () => {
    it('gets the client and opens the database named by MONGODB_DB_NAME', async () => {
        const { getDb } = await freshModule({ MONGODB_DB_NAME: 'custom-db' });
        await getDb();
        expect(mockDb).toHaveBeenCalledWith('custom-db');
    });

    it('falls back to DEEP_AGENT_DB_NAME when MONGODB_DB_NAME is unset', async () => {
        const { getDb } = await freshModule({ DEEP_AGENT_DB_NAME: 'deep-agent-db' });
        await getDb();
        expect(mockDb).toHaveBeenCalledWith('deep-agent-db');
    });

    it('falls back to "nucleus" when neither DB name env var is set', async () => {
        const { getDb } = await freshModule();
        await getDb();
        expect(mockDb).toHaveBeenCalledWith('nucleus');
    });

    it('caches the db on globalThis outside production', async () => {
        const { getDb } = await freshModule();
        const db = await getDb();
        expect((globalThis as any).mongoDb).toBe(db);
    });

    it('does not cache the db on globalThis in production', async () => {
        const { getDb } = await freshModule({ NODE_ENV: 'production' });
        await getDb();
        expect((globalThis as any).mongoDb).toBeUndefined();
    });

    it('reuses an already-cached globalThis db without calling client.db again', async () => {
        const { getDb } = await freshModule();
        await getDb();
        expect(mockDb).toHaveBeenCalledOnce();
        await getDb();
        expect(mockDb).toHaveBeenCalledOnce(); // still just once
    });

    it('in production, reuses the module-local db across repeated calls', async () => {
        const { getDb } = await freshModule({ NODE_ENV: 'production' });
        const first = await getDb();
        const second = await getDb();
        expect(first).toBe(second);
        expect(mockDb).toHaveBeenCalledOnce();
    });
});

describe('closeMongoConnection', () => {
    it('closes the client and clears both local and global caches', async () => {
        const { getMongoClient, closeMongoConnection } = await freshModule();
        await getMongoClient();
        expect((globalThis as any).mongoClient).toBeDefined();

        await closeMongoConnection();

        expect(mockClose).toHaveBeenCalledOnce();
        expect((globalThis as any).mongoClient).toBeUndefined();
        expect((globalThis as any).mongoDb).toBeUndefined();
    });

    it('is a no-op when no client was ever created', async () => {
        const { closeMongoConnection } = await freshModule();
        await expect(closeMongoConnection()).resolves.toBeUndefined();
        expect(mockClose).not.toHaveBeenCalled();
    });

    it('forces a fresh connect on the next getMongoClient call after closing', async () => {
        const { getMongoClient, closeMongoConnection } = await freshModule();
        await getMongoClient();
        await closeMongoConnection();
        await getMongoClient();
        expect(instances).toHaveLength(2);
    });
});
