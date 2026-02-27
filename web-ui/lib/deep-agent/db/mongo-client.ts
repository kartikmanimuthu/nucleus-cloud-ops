// ============================================================================
// Deep Agent Module — MongoDB Client (Singleton)
// ============================================================================

import { MongoClient, Db } from 'mongodb';
import { createLogger } from '../logger';

const log = createLogger('MongoClient');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DEEP_AGENT_DB_NAME || 'nucleus_deep_agent';

// Use globalThis to survive Next.js hot-reloads in dev
const globalForMongo = globalThis as unknown as {
    mongoClient: MongoClient | undefined;
    mongoDb: Db | undefined;
};

let _client: MongoClient | undefined;
let _db: Db | undefined;

export async function getMongoClient(): Promise<MongoClient> {
    if (globalForMongo.mongoClient) {
        log.debug('Reusing existing global MongoClient');
        return globalForMongo.mongoClient;
    }

    if (!_client) {
        log.info('Creating new MongoClient', {
            host: MONGODB_URI.split('@').pop(),
            db: DB_NAME,
            maxPoolSize: 10,
        });

        _client = new MongoClient(MONGODB_URI, {
            maxPoolSize: 10,
            connectTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        });

        try {
            await _client.connect();
            log.info('MongoDB connected successfully', { host: MONGODB_URI.split('@').pop() });
        } catch (err: any) {
            log.error('MongoDB connection failed', { error: err.message, stack: err.stack });
            throw err;
        }

        if (process.env.NODE_ENV !== 'production') {
            globalForMongo.mongoClient = _client;
            log.debug('MongoClient stored in globalThis (dev hot-reload safe)');
        }
    }

    return _client;
}

export async function getDb(): Promise<Db> {
    if (globalForMongo.mongoDb) {
        log.debug('Reusing existing global Db instance', { db: DB_NAME });
        return globalForMongo.mongoDb;
    }
    if (_db) {
        log.debug('Reusing module-level Db instance', { db: DB_NAME });
        return _db;
    }

    const client = await getMongoClient();
    _db = client.db(DB_NAME);
    log.info('Database handle acquired', { db: DB_NAME });

    if (process.env.NODE_ENV !== 'production') {
        globalForMongo.mongoDb = _db;
    }

    return _db;
}

export async function closeMongoConnection(): Promise<void> {
    if (_client) {
        log.info('Closing MongoDB connection...');
        await _client.close();
        _client = undefined;
        _db = undefined;
        globalForMongo.mongoClient = undefined;
        globalForMongo.mongoDb = undefined;
        log.info('MongoDB connection closed');
    } else {
        log.debug('closeMongoConnection called but no active client');
    }
}
