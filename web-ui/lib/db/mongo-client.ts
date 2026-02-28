// ============================================================================
// Shared MongoDB Client (Singleton)
// Used by both the planning/fast agent and the deep agent modules.
// ============================================================================

import { MongoClient, Db } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGODB_DB_NAME || process.env.DEEP_AGENT_DB_NAME || 'nucleus_deep_agent';

// Use globalThis to survive Next.js hot-reloads in dev
const globalForMongo = globalThis as unknown as {
    mongoClient: MongoClient | undefined;
    mongoDb: Db | undefined;
};

let _client: MongoClient | undefined;
let _db: Db | undefined;

export async function getMongoClient(): Promise<MongoClient> {
    if (globalForMongo.mongoClient) {
        return globalForMongo.mongoClient;
    }

    if (!_client) {
        _client = new MongoClient(MONGODB_URI, {
            maxPoolSize: 10,
            connectTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        });

        await _client.connect();

        if (process.env.NODE_ENV !== 'production') {
            globalForMongo.mongoClient = _client;
        }
    }

    return _client;
}

export async function getDb(): Promise<Db> {
    if (globalForMongo.mongoDb) {
        return globalForMongo.mongoDb;
    }
    if (_db) {
        return _db;
    }

    const client = await getMongoClient();
    _db = client.db(DB_NAME);

    if (process.env.NODE_ENV !== 'production') {
        globalForMongo.mongoDb = _db;
    }

    return _db;
}

export async function closeMongoConnection(): Promise<void> {
    if (_client) {
        await _client.close();
        _client = undefined;
        _db = undefined;
        globalForMongo.mongoClient = undefined;
        globalForMongo.mongoDb = undefined;
    }
}
