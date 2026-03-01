// ============================================================================
// Shared MongoDB / DocumentDB Client (Singleton)
// Used by both the planning/fast agent and the deep agent modules.
//
// In production (ECS + DocumentDB) the following env vars are injected:
//   DOCDB_ENDPOINT, DOCDB_PORT, DOCDB_USERNAME, DOCDB_PASSWORD
//
// In local development set MONGODB_URI directly in .env.local.
// ============================================================================

import { MongoClient, Db } from 'mongodb';
import * as fs from 'fs';

// Path where the RDS CA bundle is baked into the Docker image (see Dockerfile.ecs)
const RDS_CA_BUNDLE_PATH = '/etc/ssl/certs/rds-combined-ca-bundle.pem';

function buildMongoUri(): string {
    // Prefer an explicit full URI (local dev / custom setups)
    if (process.env.MONGODB_URI) {
        return process.env.MONGODB_URI;
    }

    // Build from individual DocumentDB env vars injected by CDK / Secrets Manager
    const host = process.env.DOCDB_ENDPOINT;
    const port = process.env.DOCDB_PORT ?? '27017';
    const username = process.env.DOCDB_USERNAME;
    const password = process.env.DOCDB_PASSWORD;

    if (host && username && password) {
        const encodedPassword = encodeURIComponent(password);
        const tlsCAFile = fs.existsSync(RDS_CA_BUNDLE_PATH)
            ? `&tlsCAFile=${RDS_CA_BUNDLE_PATH}`
            : '';
        return (
            `mongodb://${username}:${encodedPassword}@${host}:${port}/` +
            `?tls=true${tlsCAFile}` +
            `&replicaSet=rs0&readPreference=secondaryPreferred&retryWrites=false`
        );
    }

    // Fallback for local development
    return 'mongodb://localhost:27017';
}

function buildMongoClientOptions() {
    // If the CA bundle exists on disk, pass it via tlsCAFile option as well
    // (belt-and-suspenders alongside the URI param)
    if (fs.existsSync(RDS_CA_BUNDLE_PATH)) {
        return {
            maxPoolSize: 10,
            connectTimeoutMS: 5000,
            socketTimeoutMS: 45000,
            tls: true,
            tlsCAFile: RDS_CA_BUNDLE_PATH,
        };
    }
    return {
        maxPoolSize: 10,
        connectTimeoutMS: 5000,
        socketTimeoutMS: 45000,
    };
}

const DB_NAME =
    process.env.MONGODB_DB_NAME ||
    process.env.DEEP_AGENT_DB_NAME ||
    'nucleus';

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
        _client = new MongoClient(buildMongoUri(), buildMongoClientOptions());

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
