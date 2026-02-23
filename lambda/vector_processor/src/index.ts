
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import {
    S3VectorsClient,
    PutVectorsCommand
} from "@aws-sdk/client-s3vectors";
import * as cheerio from "cheerio";
import { S3Event, Context } from "aws-lambda";
import { Readable } from "stream";

// Clients
const s3 = new S3Client({});
const bedrock = new BedrockRuntimeClient({
    region: process.env.AWS_REGION
});
const s3vectors = new S3VectorsClient({
    region: process.env.AWS_REGION
});

// Environment Variables
const VECTOR_BUCKET_NAME = process.env.VECTOR_BUCKET_NAME || process.env.VECTOR_BUCKET_ARN!;
const VECTOR_INDEX_NAME = process.env.VECTOR_INDEX_NAME!;
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || "amazon.titan-embed-text-v2:0";

// Helper to stream to string
const streamToString = (stream: Readable): Promise<string> => {
    return new Promise((resolve, reject) => {
        const chunks: Uint8Array[] = [];
        stream.on("data", (chunk: any) => chunks.push(Buffer.from(chunk) as unknown as Uint8Array));
        stream.on("error", (err: any) => reject(err));
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    });
};

// Text Extraction (Recursive JSON traversal + HTML stripping)
const extractTextFromJson = (data: any, collectedText: string[] = []): string[] => {
    if (typeof data === 'object' && data !== null) {
        if (Array.isArray(data)) {
            data.forEach(item => extractTextFromJson(item, collectedText));
        } else {
            Object.values(data).forEach(value => extractTextFromJson(value, collectedText));
        }
    } else if (typeof data === 'string') {
        try {
            const $ = cheerio.load(data);
            const cleanText = $.text().replace(/\s+/g, ' ').trim();
            if (cleanText) collectedText.push(cleanText);
        } catch (e) {
            // If cheerio fails, just push the raw string
            collectedText.push(data);
        }
    }
    return collectedText;
};

// Embedding Generation
const getEmbedding = async (text: string): Promise<number[]> => {
    const command = new InvokeModelCommand({
        modelId: BEDROCK_MODEL_ID,
        body: JSON.stringify({ inputText: text.slice(0, 8000) }), // Basic truncation for Titan
        contentType: "application/json",
        accept: "application/json",
    });

    const response = await bedrock.send(command);

    // AWS SDK v3 returns Uint8Array for body
    const bodyString = new TextDecoder().decode(response.body);
    const responseBody = JSON.parse(bodyString);
    return responseBody.embedding;
};

// Simple Chunking
const chunkText = (text: string, chunkSize = 1000, overlap = 100): string[] => {
    const chunks: string[] = [];
    if (!text) return chunks;

    for (let i = 0; i < text.length; i += chunkSize - overlap) {
        chunks.push(text.slice(i, i + chunkSize));
    }
    return chunks;
};

export const handler = async (event: S3Event, context: Context): Promise<void> => {
    console.log("Processing event:", JSON.stringify(event, null, 2));

    for (const record of event.Records) {
        // Skip if not an object creation event (though resource policy should restrict this)
        if (!record.eventName.startsWith('ObjectCreated:')) continue;

        const srcBucket = record.s3.bucket.name;
        const srcKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

        console.log(`Processing file: s3://${srcBucket}/${srcKey}`);

        try {
            // 1. Get JSON from Source S3 Bucket
            const getObjParams = { Bucket: srcBucket, Key: srcKey };
            const s3Data = await s3.send(new GetObjectCommand(getObjParams));

            if (!s3Data.Body) {
                console.warn(`Empty body for ${srcKey}`);
                continue;
            }

            const bodyString = await streamToString(s3Data.Body as Readable);
            const articleJson = JSON.parse(bodyString);

            // 2. Extract Metadata for Vector
            const meta: any = {
                title: articleJson.title,
                slug: articleJson.slug,
                id: String(articleJson.id),
                documentId: articleJson.documentId,
                author: articleJson.author || "Unknown",
                source: `s3://${srcBucket}/${srcKey}`
            };

            // 3. Extract Text & Chunk
            // Flatten all text values and join them
            const allTextParts = extractTextFromJson(articleJson);
            const fullText = allTextParts.join(" ");

            if (!fullText) {
                console.warn(`No extractable text found in ${srcKey}`);
                continue;
            }

            const chunks = chunkText(fullText);
            console.log(`Generated ${chunks.length} chunks for ${srcKey}`);

            const vectorPayload = [];

            // 4. Generate Embeddings & Prepare Vectors (Concurrent Batches)
            const EMBEDDING_CONCURRENCY = 10;
            for (let i = 0; i < chunks.length; i += EMBEDDING_CONCURRENCY) {
                const chunkBatch = chunks.slice(i, i + EMBEDDING_CONCURRENCY);

                const batchResults = await Promise.all(chunkBatch.map(async (chunk, batchIdx) => {
                    const globalIdx = i + batchIdx;
                    try {
                        const embedding = await getEmbedding(chunk);
                        return {
                            id: `doc_${meta.documentId || meta.id || 'unknown'}_chunk_${globalIdx}`,
                            key: `doc_${meta.documentId || meta.id || 'unknown'}_chunk_${globalIdx}`,
                            data: { float32: embedding },
                            metadata: {
                                ...meta,
                                chunk_index: String(globalIdx),
                                text_content: chunk.slice(0, 500)
                            }
                        };
                    } catch (e) {
                        console.error(`Failed to generate embedding for chunk ${globalIdx}`, e);
                        return null;
                    }
                }));

                // Filter out failures
                const validVectors = batchResults.filter(v => v !== null);
                vectorPayload.push(...validVectors);
            }

            // 5. Ingest to S3 Vectors in Batches
            if (vectorPayload.length > 0) {
                const BATCH_SIZE = 20;
                for (let i = 0; i < vectorPayload.length; i += BATCH_SIZE) {
                    const batch = vectorPayload.slice(i, i + BATCH_SIZE);
                    console.log(`Ingesting batch ${Math.ceil((i + 1) / BATCH_SIZE)}/${Math.ceil(vectorPayload.length / BATCH_SIZE)} (${batch.length} vectors) to Bucket: ${VECTOR_BUCKET_NAME}, Index: ${VECTOR_INDEX_NAME}`);

                    try {
                        await s3vectors.send(new PutVectorsCommand({
                            vectorBucketName: VECTOR_BUCKET_NAME,
                            indexName: VECTOR_INDEX_NAME,
                            vectors: batch as any
                        }));
                    } catch (e) {
                        console.error(`Failed to ingest batch starting at index ${i}`, e);
                        throw e;
                    }
                }
                console.log(`Successfully ingested all vectors for ${srcKey}`);
            }

        } catch (error) {
            console.error(`Error processing ${srcKey}:`, error);
            // Don't throw error to avoid infinite retries on malformed files? 
            // Better to DLQ, but for now log and throw to see in CloudWatch.
            throw error;
        }
    }
};
