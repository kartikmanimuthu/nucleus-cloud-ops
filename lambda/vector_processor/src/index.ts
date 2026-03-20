import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { S3VectorsClient, PutVectorsCommand, DeleteVectorsCommand } from "@aws-sdk/client-s3vectors";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";
import { SQSEvent, S3Event, Context } from "aws-lambda";
import { Readable } from "stream";
import { createResourceText, computeContentHash, InventoryResource } from "./resource-text";

// AWS Clients
const s3 = new S3Client({});
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION });
const s3vectors = new S3VectorsClient({ region: process.env.AWS_REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));

// Environment Variables
const VECTOR_BUCKET_NAME = process.env.VECTOR_BUCKET_NAME || process.env.VECTOR_BUCKET_ARN!;
const VECTOR_INDEX_NAME = process.env.VECTOR_INDEX_NAME!;
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || "amazon.titan-embed-text-v2:0";
const APP_TABLE_NAME = process.env.APP_TABLE_NAME!;
const AUDIT_TABLE_NAME = process.env.AUDIT_TABLE_NAME!;

// Concurrency limits to avoid Bedrock throttling
const EMBEDDING_CONCURRENCY = 5;
const VECTOR_BATCH_SIZE = 20;
const DELETE_BATCH_SIZE = 500;

const streamToString = (stream: Readable): Promise<string> =>
    new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        stream.on("error", reject);
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    });

const getEmbedding = async (text: string): Promise<number[]> => {
    const response = await bedrock.send(
        new InvokeModelCommand({
            modelId: BEDROCK_MODEL_ID,
            body: JSON.stringify({ inputText: text.slice(0, 8000) }),
            contentType: "application/json",
            accept: "application/json",
        })
    );
    const body = JSON.parse(new TextDecoder().decode(response.body));
    return body.embedding;
};

// ---------------------------------------------------------------------------
// DynamoDB helpers — track vector keys per account for stale cleanup
// PK: INVENTORY_VECTORS#<accountId>  SK: KEYS
// ---------------------------------------------------------------------------

async function getPreviousVectorKeys(accountId: string): Promise<string[]> {
    if (!APP_TABLE_NAME) return [];
    try {
        const res = await ddb.send(new GetCommand({
            TableName: APP_TABLE_NAME,
            Key: { pk: `INVENTORY_VECTORS#${accountId}`, sk: "KEYS" },
        }));
        return (res.Item?.vectorKeys as string[]) || [];
    } catch (err) {
        console.warn(`[VectorProcessor] Could not read previous keys for ${accountId}:`, err);
        return [];
    }
}

async function saveVectorKeys(accountId: string, keys: string[]): Promise<void> {
    if (!APP_TABLE_NAME) return;
    await ddb.send(new PutCommand({
        TableName: APP_TABLE_NAME,
        Item: {
            pk: `INVENTORY_VECTORS#${accountId}`,
            sk: "KEYS",
            vectorKeys: keys,
            updatedAt: new Date().toISOString(),
        },
    }));
}

// ---------------------------------------------------------------------------
// Audit log helper — writes to NucleusAuditTable (same schema as discovery Lambda)
// ---------------------------------------------------------------------------

async function writeAuditLog(params: {
    eventType: string;
    action: string;
    status: 'success' | 'error' | 'warning';
    resource: string;
    details: string;
    severity: 'info' | 'medium' | 'high' | 'critical';
    metadata?: Record<string, string | number>;
    accountId?: string;
}): Promise<void> {
    if (!AUDIT_TABLE_NAME) return;
    try {
        const auditId = randomUUID();
        const timestamp = new Date().toISOString();
        const expireAt = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60); // 30-day TTL

        await ddb.send(new PutCommand({
            TableName: AUDIT_TABLE_NAME,
            Item: {
                pk: `LOG#${auditId}`,
                sk: timestamp,
                gsi1pk: 'TYPE#LOG',
                gsi1sk: timestamp,
                gsi2pk: 'USER#system',
                gsi2sk: timestamp,
                gsi3pk: `EVENT#${params.eventType}`,
                gsi3sk: timestamp,
                expire_at: expireAt,
                id: auditId,
                timestamp,
                eventType: params.eventType,
                action: params.action,
                status: params.status,
                resource: params.resource,
                details: params.details,
                severity: params.severity,
                user: 'system',
                userType: 'system',
                source: 'vector-processor',
                accountId: params.accountId || '',
                ...(params.metadata ? { metadata: params.metadata } : {}),
            },
        }));
    } catch (err) {
        // Non-fatal — never let audit logging break the pipeline
        console.warn('[VectorProcessor] Failed to write audit log:', err);
    }
}

// ---------------------------------------------------------------------------
// Delete stale vectors — keys that existed before but not in the new sync
// ---------------------------------------------------------------------------

async function deleteStaleVectors(staleKeys: string[]): Promise<void> {
    if (!staleKeys.length) return;
    console.log(`[VectorProcessor] Deleting ${staleKeys.length} stale vectors`);
    for (let i = 0; i < staleKeys.length; i += DELETE_BATCH_SIZE) {
        await s3vectors.send(new DeleteVectorsCommand({
            vectorBucketName: VECTOR_BUCKET_NAME,
            indexName: VECTOR_INDEX_NAME,
            keys: staleKeys.slice(i, i + DELETE_BATCH_SIZE),
        }));
    }
}

// ---------------------------------------------------------------------------
// Core processing
// ---------------------------------------------------------------------------

const processInventoryFile = async (srcBucket: string, srcKey: string): Promise<number> => {
    console.log(`[VectorProcessor] Processing: s3://${srcBucket}/${srcKey}`);

    // Extract accountId from key: normalized/{date}/{accountId}.json
    const accountId = srcKey.split("/").pop()?.replace(".json", "") || "";

    // Read the normalized inventory resources file
    const s3Data = await s3.send(new GetObjectCommand({ Bucket: srcBucket, Key: srcKey }));
    if (!s3Data.Body) {
        console.warn(`[VectorProcessor] Empty body for ${srcKey}`);
        return 0;
    }

    const bodyString = await streamToString(s3Data.Body as Readable);
    const resources: InventoryResource[] = JSON.parse(bodyString);

    if (!Array.isArray(resources) || resources.length === 0) {
        console.warn(`[VectorProcessor] No resources found in ${srcKey}`);
        return 0;
    }

    console.log(`[VectorProcessor] Embedding ${resources.length} resources from ${srcKey}`);

    const vectorPayload: any[] = [];

    // Process in concurrent batches to respect Bedrock rate limits
    for (let i = 0; i < resources.length; i += EMBEDDING_CONCURRENCY) {
        const batch = resources.slice(i, i + EMBEDDING_CONCURRENCY);

        const results = await Promise.all(
            batch.map(async (resource) => {
                if (!resource.resourceId) return null;

                const text = createResourceText(resource);
                if (!text) return null;

                const contentHash = computeContentHash(text);

                try {
                    const embedding = await getEmbedding(text);

                    return {
                        key: `${resource.resourceId}_${contentHash}`,
                        data: { float32: embedding },
                        metadata: {
                            resourceId: resource.resourceId,
                            resourceArn: resource.resourceArn || "",
                            resourceType: resource.resourceType || "",
                            name: resource.name || resource.resourceId,
                            region: resource.region || "",
                            accountId: resource.accountId || "",
                            accountName: resource.accountName || "",
                            state: resource.state || "",
                            service: resource.service || "",
                            contentHash,
                            text_content: text.slice(0, 1000),
                            source_key: srcKey,
                            lastDiscoveredAt: resource.lastDiscoveredAt || new Date().toISOString(),
                        },
                    };
                } catch (err) {
                    console.error(`[VectorProcessor] Failed embedding for ${resource.resourceId}:`, err);
                    return null;
                }
            })
        );

        vectorPayload.push(...results.filter(Boolean));
    }

    if (vectorPayload.length === 0) {
        console.warn(`[VectorProcessor] No vectors generated for ${srcKey}`);
        return 0;
    }

    // Deduplicate by key — duplicate resourceIds in the same file produce identical keys
    // and S3 Vectors rejects batches with duplicate keys (ValidationException)
    const seen = new Set<string>();
    const dedupedPayload = vectorPayload.filter(v => {
        if (seen.has(v.key)) return false;
        seen.add(v.key);
        return true;
    });
    if (dedupedPayload.length < vectorPayload.length) {
        console.warn(`[VectorProcessor] Deduplicated ${vectorPayload.length - dedupedPayload.length} duplicate keys from ${srcKey}`);
    }

    const newKeys = dedupedPayload.map(v => v.key);

    // Fetch previous keys before writing new ones
    const previousKeys = await getPreviousVectorKeys(accountId);

    // Ingest new vectors to S3 Vectors in batches of 20
    for (let i = 0; i < dedupedPayload.length; i += VECTOR_BATCH_SIZE) {
        const batch = dedupedPayload.slice(i, i + VECTOR_BATCH_SIZE);
        const batchNum = Math.ceil((i + 1) / VECTOR_BATCH_SIZE);
        const totalBatches = Math.ceil(dedupedPayload.length / VECTOR_BATCH_SIZE);

        console.log(`[VectorProcessor] Ingesting batch ${batchNum}/${totalBatches} (${batch.length} vectors)`);

        await s3vectors.send(
            new PutVectorsCommand({
                vectorBucketName: VECTOR_BUCKET_NAME,
                indexName: VECTOR_INDEX_NAME,
                vectors: batch as any,
            })
        );
    }

    // Delete stale vectors — keys from the previous sync that are no longer present
    const newKeySet = new Set(newKeys);
    const staleKeys = previousKeys.filter(k => !newKeySet.has(k));
    await deleteStaleVectors(staleKeys);

    // Persist new keys for next sync's stale cleanup
    await saveVectorKeys(accountId, newKeys);

    console.log(`[VectorProcessor] Successfully ingested ${dedupedPayload.length} vectors, deleted ${staleKeys.length} stale for ${srcKey}`);
    return dedupedPayload.length;
};

/**
 * Lambda handler — triggered via SQS which receives S3 ObjectCreated events.
 * The SQS message body contains the S3 event notification JSON.
 *
 * Pipeline: Discovery ECS Task → S3 (normalized/) → SQS → this Lambda → S3 Vectors
 */
export const handler = async (event: SQSEvent, _context: Context): Promise<void> => {
    console.log(`[VectorProcessor] Received ${event.Records?.length ?? 0} SQS records`);

    let totalVectors = 0;

    for (const sqsRecord of event.Records) {
        // The SQS message body is the raw S3 event notification JSON
        let s3Event: S3Event;
        try {
            s3Event = JSON.parse(sqsRecord.body);
        } catch (err) {
            console.error("[VectorProcessor] Failed to parse SQS body:", err, sqsRecord.body);
            continue;
        }

        for (const s3Record of s3Event.Records || []) {
            if (!s3Record.eventName?.startsWith("ObjectCreated:")) continue;

            const srcBucket = s3Record.s3.bucket.name;
            const srcKey = decodeURIComponent(s3Record.s3.object.key.replace(/\+/g, " "));

            // Only process normalized inventory snapshot files
            if (!srcKey.startsWith("normalized/")) {
                console.log(`[VectorProcessor] Skipping ${srcKey} — not in normalized/ prefix`);
                continue;
            }

            try {
                const count = await processInventoryFile(srcBucket, srcKey);
                totalVectors += count;
            } catch (error) {
                console.error(`[VectorProcessor] Error processing ${srcKey}:`, error);
                const accountId = srcKey.split("/").pop()?.replace(".json", "") || "";
                await writeAuditLog({
                    eventType: 'inventory.vector_processing.failed',
                    action: 'vector_processing_failed',
                    status: 'error',
                    resource: srcKey,
                    details: `Vector processing failed for account ${accountId}: ${error instanceof Error ? error.message : String(error)}`,
                    severity: 'high',
                    accountId,
                    metadata: { sourceKey: srcKey },
                });
                // Re-throw to let SQS handle retry / route to DLQ
                throw error;
            }
        }
    }

    console.log(`[VectorProcessor] Total vectors ingested: ${totalVectors}`);
};
