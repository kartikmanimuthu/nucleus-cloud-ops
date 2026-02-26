import { DynamoDBClient, PutItemCommand, GetItemCommand, DeleteItemCommand, AttributeValue, QueryCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import {
    BaseCheckpointSaver,
    Checkpoint,
    CheckpointMetadata,
    CheckpointTuple,
    SerializerProtocol,
    PendingWrite
} from '@langchain/langgraph-checkpoint';
import { RunnableConfig } from '@langchain/core/runnables';

// Per-field threshold: offload to S3 once a single field exceeds 100KB.
// This is intentionally conservative — a DynamoDB item can hold up to 400KB total,
// but a checkpoint item contains up to 5 other fields (thread_id, checkpoint_id, etc.)
// plus both the serialized checkpoint AND metadata. If either individually exceeds
// 100KB we offload it, keeping the combined item well under the 400KB limit.
const S3_OFFLOAD_THRESHOLD = 100 * 1024;

// Hard ceiling: if the total marshalled item still exceeds this, force-offload the
// largest inline field before writing. 350KB gives ~50KB headroom for DynamoDB overhead.
const DYNAMO_ITEM_MAX_BYTES = 350 * 1024;

/** Returns true if the value is an S3 reference pointer (already offloaded). */
function isS3Ref(value: any): boolean {
    return value !== null && typeof value === 'object' && '__s3_ref__' in value;
}

export interface DynamoDBS3SaverFields {
    clientConfig?: any;
    checkpointsTableName: string;
    writesTableName: string;
    s3BucketName: string;
    s3ClientConfig?: any;
}

export class DynamoDBS3Saver extends BaseCheckpointSaver {
    private client: DynamoDBClient;
    private s3Client: S3Client;
    private checkpointsTableName: string;
    private writesTableName: string;
    private s3BucketName: string;

    constructor(fields: DynamoDBS3SaverFields, serde?: SerializerProtocol) {
        super(serde);
        this.client = new DynamoDBClient(fields.clientConfig || {});
        this.s3Client = new S3Client(fields.s3ClientConfig || {});
        this.checkpointsTableName = fields.checkpointsTableName;
        this.writesTableName = fields.writesTableName;
        this.s3BucketName = fields.s3BucketName;
    }

    async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
        const { thread_id, checkpoint_id } = config.configurable || {};

        if (!thread_id) {
            return undefined;
        }

        console.log(`[DynamoDBS3Saver] getTuple called for thread: ${thread_id}, checkpoint_id: ${checkpoint_id}`);

        const keys: Record<string, AttributeValue> = {
            thread_id: { S: thread_id },
        };

        if (checkpoint_id) {
            keys.checkpoint_id = { S: checkpoint_id };
        }

        // Determine if we need to query specifically by ID or get the latest
        let item: any;
        if (checkpoint_id) {
            const result = await this.client.send(new GetItemCommand({
                TableName: this.checkpointsTableName,
                Key: keys,
            }));
            item = result.Item ? unmarshall(result.Item) : undefined;
        } else {
            // Get the latest checkpoint for the thread
            // Since we use sort keys, we can query backwards
            const result = await this.client.send(new QueryCommand({
                TableName: this.checkpointsTableName,
                KeyConditionExpression: 'thread_id = :tid',
                ExpressionAttributeValues: {
                    ':tid': { S: thread_id }
                },
                ScanIndexForward: false,
                Limit: 1
            }));
            item = result.Items && result.Items.length > 0 ? unmarshall(result.Items[0]) : undefined;
        }

        if (!item) {
            return undefined;
        }

        // Restore checkpoint content (handle S3 offloading)
        let checkpoint = await this.loadData(item.checkpoint);
        let metadata = await this.loadData(item.metadata);

        // Process parent info if available
        let parentConfig: RunnableConfig | undefined = undefined;
        if (item.parent_checkpoint_id) {
            parentConfig = {
                configurable: {
                    thread_id: item.thread_id,
                    checkpoint_id: item.parent_checkpoint_id,
                },
            };
        }

        return {
            config: {
                configurable: {
                    thread_id: item.thread_id,
                    checkpoint_id: item.checkpoint_id,
                    checkpoint_ns: item.checkpoint_ns,
                },
            },
            checkpoint: (await this.serde.loadsTyped("json", JSON.stringify(checkpoint))) as Checkpoint,
            metadata: (await this.serde.loadsTyped("json", JSON.stringify(metadata))) as CheckpointMetadata,
            parentConfig,
        };
    }

    async *list(config: RunnableConfig, options?: any): AsyncGenerator<CheckpointTuple> {
        const { thread_id } = config.configurable || {};
        if (!thread_id) return;

        // Simple implementation for list (limited by DynamoDB Query constraints)
        // For full list support, we'd need more complex query logic or GSI support
        const result = await this.client.send(new QueryCommand({
            TableName: this.checkpointsTableName,
            KeyConditionExpression: 'thread_id = :tid',
            ExpressionAttributeValues: {
                ':tid': { S: thread_id }
            },
            ScanIndexForward: false,
            // Use limits from options if provided
            Limit: options?.limit,
        }));

        if (result.Items) {
            for (const rawItem of result.Items) {
                const item = unmarshall(rawItem);

                // Restore contents
                const checkpoint = await this.loadData(item.checkpoint);
                const metadata = await this.loadData(item.metadata);

                let parentConfig: RunnableConfig | undefined = undefined;
                if (item.parent_checkpoint_id) {
                    parentConfig = {
                        configurable: {
                            thread_id: item.thread_id,
                            checkpoint_id: item.parent_checkpoint_id,
                        },
                    };
                }

                yield {
                    config: {
                        configurable: {
                            thread_id: item.thread_id,
                            checkpoint_id: item.checkpoint_id,
                            checkpoint_ns: item.checkpoint_ns,
                        },
                    },
                    checkpoint: (await this.serde.loadsTyped("json", JSON.stringify(checkpoint))) as Checkpoint,
                    metadata: (await this.serde.loadsTyped("json", JSON.stringify(metadata))) as CheckpointMetadata,
                    parentConfig,
                };
            }
        }
    }

    async put(
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        newVersions: any
    ): Promise<RunnableConfig> {
        const thread_id = config.configurable?.thread_id;
        const checkpoint_ns = config.configurable?.checkpoint_ns ?? '';
        // IMPORTANT: Use checkpoint.id, not config.configurable.checkpoint_id
        // The checkpoint_id comes from the checkpoint object itself
        const checkpoint_id = checkpoint.id;
        // The parent_checkpoint_id is the previous checkpoint (from config)
        const parent_checkpoint_id = config.configurable?.checkpoint_id;

        if (!thread_id) {
            console.warn("[DynamoDBS3Saver.put] Missing thread_id in config, skipping save");
            return config;
        }

        console.log(`[DynamoDBS3Saver] Saving checkpoint. Thread: ${thread_id}, Checkpoint: ${checkpoint_id}`);

        // Serialize data
        const checkpointDump = await this.serde.dumpsTyped(checkpoint);
        const metadataDump = await this.serde.dumpsTyped(metadata);
        const decoder = new TextDecoder();
        const serializedCheckpoint = JSON.parse(decoder.decode(checkpointDump[1]));
        const serializedMetadata = JSON.parse(decoder.decode(metadataDump[1]));

        // Per-field S3 offload: each field that exceeds S3_OFFLOAD_THRESHOLD is stored in S3.
        let storedCheckpoint = await this.storeData(serializedCheckpoint, `checkpoint/${thread_id}/${checkpoint_id}`);
        let storedMetadata = await this.storeData(serializedMetadata, `metadata/${thread_id}/${checkpoint_id}`);

        // Combined-size guard: even if each field individually passed the per-field
        // threshold, the total DynamoDB item could still exceed 400KB. Measure the
        // expected item size and force-offload the largest still-inline field.
        const estimatedItemSize = (
            Buffer.byteLength(JSON.stringify(storedCheckpoint)) +
            Buffer.byteLength(JSON.stringify(storedMetadata)) +
            Buffer.byteLength(thread_id) +
            Buffer.byteLength(checkpoint_id) +
            Buffer.byteLength(checkpoint_ns || '') +
            Buffer.byteLength(parent_checkpoint_id || '') +
            256 // overhead for DynamoDB attribute names and marshalling
        );

        if (estimatedItemSize > DYNAMO_ITEM_MAX_BYTES) {
            console.warn(
                `[DynamoDBS3Saver] Combined item size ~${estimatedItemSize} bytes exceeds ` +
                `${DYNAMO_ITEM_MAX_BYTES} bytes. Force-offloading largest inline field to S3.`
            );
            // Determine which inline field is larger and offload it.
            const cpSize = isS3Ref(storedCheckpoint) ? 0 : Buffer.byteLength(JSON.stringify(storedCheckpoint));
            const mdSize = isS3Ref(storedMetadata) ? 0 : Buffer.byteLength(JSON.stringify(storedMetadata));
            if (cpSize >= mdSize && cpSize > 0) {
                storedCheckpoint = await this.forceOffload(serializedCheckpoint, `checkpoint/${thread_id}/${checkpoint_id}`);
            } else if (mdSize > 0) {
                storedMetadata = await this.forceOffload(serializedMetadata, `metadata/${thread_id}/${checkpoint_id}`);
            }
        }

        const item = {
            thread_id,
            checkpoint_id,
            checkpoint_ns,
            checkpoint: storedCheckpoint,
            metadata: storedMetadata,
            parent_checkpoint_id,
            type: checkpointDump[0] // Use the serialization type from serde
        };

        await this.client.send(new PutItemCommand({
            TableName: this.checkpointsTableName,
            Item: marshall(item, { removeUndefinedValues: true, convertClassInstanceToMap: true }),
        }));

        return {
            configurable: {
                thread_id,
                checkpoint_id,
                checkpoint_ns,
            },
        };
    }

    async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
        const { thread_id, checkpoint_id, checkpoint_ns } = config.configurable || {};

        if (!thread_id || !checkpoint_id) {
            console.warn("[DynamoDBS3Saver.putWrites] Missing thread_id or checkpoint_id in config, skipping writes");
            return;
        }

        console.log(`[DynamoDBS3Saver] Saving writes. Thread: ${thread_id}, Checkpoint: ${checkpoint_id}, Writes: ${writes.length}`);

        const writesItems = await Promise.all(writes.map(async (write, idx) => {
            // Serialize write data using serde to handle LangChain message objects
            // PendingWrite is usually [channel, value] tuple
            let serializedWrite: any;
            try {
                const writeDump = await this.serde.dumpsTyped(write);
                const decoder = new TextDecoder();
                serializedWrite = JSON.parse(decoder.decode(writeDump[1]));
            } catch (e) {
                // Fallback: try to convert to plain object
                console.warn(`[DynamoDBS3Saver.putWrites] Failed to serialize write ${idx}, using JSON fallback:`, e);
                serializedWrite = JSON.parse(JSON.stringify(write));
            }

            const storedWrite = await this.storeData(
                serializedWrite,
                `writes/${thread_id}/${checkpoint_id}/${taskId}/${idx}`
            );

            return {
                thread_id_checkpoint_id_checkpoint_ns: `${thread_id}#${checkpoint_id}#${checkpoint_ns || ''}`,
                task_id_idx: `${taskId}#${idx}`,
                write: storedWrite,
                type: 'write'
            };
        }));

        // Batch write items (DynamoDB limit is 25 items per batch)
        // Using Promise.all for parallelism
        await Promise.all(writesItems.map(item =>
            this.client.send(new PutItemCommand({
                TableName: this.writesTableName,
                Item: marshall(item, { removeUndefinedValues: true, convertClassInstanceToMap: true }),
            }))
        ));
    }

    // --- Helper for S3 Offloading ---

    private async storeData(data: any, keySuffix: string): Promise<any> {
        const jsonString = JSON.stringify(data);
        const size = Buffer.byteLength(jsonString);

        console.log(`[DynamoDBS3Saver] Data size: ${size} bytes. Threshold: ${S3_OFFLOAD_THRESHOLD}`);

        if (size > S3_OFFLOAD_THRESHOLD) {
            return this.uploadToS3(keySuffix, jsonString, size);
        }

        return data;
    }

    /** Force-upload data to S3 unconditionally (used by the combined-size guard). */
    private async forceOffload(data: any, keySuffix: string): Promise<any> {
        const jsonString = JSON.stringify(data);
        const size = Buffer.byteLength(jsonString);
        console.log(`[DynamoDBS3Saver] Force-offloading to S3. Size: ${size} bytes, Key: ${keySuffix}`);
        return this.uploadToS3(keySuffix, jsonString, size);
    }

    private async uploadToS3(keySuffix: string, jsonString: string, size: number): Promise<any> {
        const key = `${keySuffix}.json`;
        console.log(`[DynamoDBS3Saver] Offloading data to S3. Size: ${size} bytes, Key: ${key}`);

        await this.s3Client.send(new PutObjectCommand({
            Bucket: this.s3BucketName,
            Key: key,
            Body: jsonString,
            ContentType: 'application/json'
        }));

        return {
            __s3_ref__: {
                bucket: this.s3BucketName,
                key: key
            }
        };
    }

    private async loadData(data: any): Promise<any> {
        if (data && data.__s3_ref__) {
            const { bucket, key } = data.__s3_ref__;
            console.log(`[DynamoDBS3Saver] Loading data from S3. Key: ${key}`);

            // Fetch from S3
            const response = await this.s3Client.send(new GetObjectCommand({
                Bucket: bucket,
                Key: key
            }));

            const bodyString = await response.Body?.transformToString();
            if (!bodyString) {
                throw new Error(`Empty body from S3 for key: ${key}`);
            }

            return JSON.parse(bodyString);
        }

        return data;
    }
}
