import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { S3VectorsClient, PutVectorsCommand } from "@aws-sdk/client-s3vectors";
import { SQSEvent, S3Event, Context } from "aws-lambda";
import { Readable } from "stream";
import { createResourceText, computeContentHash, InventoryResource } from "./resource-text";

// AWS Clients
const s3 = new S3Client({});
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION });
const s3vectors = new S3VectorsClient({ region: process.env.AWS_REGION });

// Environment Variables
const VECTOR_BUCKET_NAME = process.env.VECTOR_BUCKET_NAME || process.env.VECTOR_BUCKET_ARN!;
const VECTOR_INDEX_NAME = process.env.VECTOR_INDEX_NAME!;
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || "amazon.titan-embed-text-v2:0";

// Concurrency limits to avoid Bedrock throttling
const EMBEDDING_CONCURRENCY = 5;
const VECTOR_BATCH_SIZE = 20;

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

const processInventoryFile = async (srcBucket: string, srcKey: string): Promise<number> => {
    console.log(`[VectorProcessor] Processing: s3://${srcBucket}/${srcKey}`);

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
                        // Use resourceId + contentHash as key for deduplication
                        key: `${resource.resourceId}_${contentHash}`,
                        data: { float32: embedding },
                        metadata: {
                            resourceId: resource.resourceId,
                            resourceArn: resource.resourceArn || "",
                            resourceType: resource.resourceType || "",
                            name: resource.name || resource.resourceId,
                            region: resource.region || "",
                            accountId: resource.accountId || "",
                            state: resource.state || "",
                            service: resource.service || "",
                            contentHash,
                            // Store first 500 chars for RAG context display
                            text_content: text.slice(0, 500),
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

    // Ingest vectors to S3 Vectors in batches of 20
    for (let i = 0; i < vectorPayload.length; i += VECTOR_BATCH_SIZE) {
        const batch = vectorPayload.slice(i, i + VECTOR_BATCH_SIZE);
        const batchNum = Math.ceil((i + 1) / VECTOR_BATCH_SIZE);
        const totalBatches = Math.ceil(vectorPayload.length / VECTOR_BATCH_SIZE);

        console.log(`[VectorProcessor] Ingesting batch ${batchNum}/${totalBatches} (${batch.length} vectors)`);

        await s3vectors.send(
            new PutVectorsCommand({
                vectorBucketName: VECTOR_BUCKET_NAME,
                indexName: VECTOR_INDEX_NAME,
                vectors: batch as any,
            })
        );
    }

    console.log(`[VectorProcessor] Successfully ingested ${vectorPayload.length} vectors for ${srcKey}`);
    return vectorPayload.length;
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
                // Re-throw to let SQS handle retry / route to DLQ
                throw error;
            }
        }
    }

    console.log(`[VectorProcessor] Total vectors ingested: ${totalVectors}`);
};
