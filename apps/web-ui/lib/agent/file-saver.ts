import fs from 'fs';
import path from 'path';
import { MemorySaver } from "@langchain/langgraph";
import { RunnableConfig } from "@langchain/core/runnables";
import { Checkpoint, CheckpointMetadata, CheckpointTuple, SerializerProtocol } from "@langchain/langgraph-checkpoint";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

interface SavedCheckpoint {
    checkpoint: Checkpoint;
    metadata: CheckpointMetadata;
    newVersions?: any;
}

interface SavedWrites {
    checkpointId: string;
    writes: any[];
    taskId: string;
}

export class FileSaver extends MemorySaver {
    private hydratedThreads = new Set<string>();

    constructor(serde?: SerializerProtocol) {
        super(serde);
    }

    private getCheckpointPath(threadId: string): string {
        const safeId = threadId.replace(/[^a-z0-9-]/gi, '_');
        return path.join(DATA_DIR, `checkpoint_${safeId}.json`);
    }

    private getWritesPath(threadId: string): string {
        const safeId = threadId.replace(/[^a-z0-9-]/gi, '_');
        return path.join(DATA_DIR, `writes_${safeId}.json`);
    }

    private async hydrate(threadId: string) {
        if (this.hydratedThreads.has(threadId)) return;

        // Load Checkpoints
        const cpPath = this.getCheckpointPath(threadId);
        if (fs.existsSync(cpPath)) {
            try {
                const data: Record<string, SavedCheckpoint> = JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
                for (const [k, v] of Object.entries(data)) {
                    const config = { configurable: { thread_id: threadId } };
                    // @ts-ignore
                    await super.put(config, v.checkpoint, v.metadata, v.newVersions || {});
                }
            } catch (e) {
                console.error(`Failed to hydrate checkpoints for ${threadId}:`, e);
            }
        }

        // Load Writes
        const wPath = this.getWritesPath(threadId);
        if (fs.existsSync(wPath)) {
            try {
                const data: SavedWrites[] = JSON.parse(fs.readFileSync(wPath, 'utf-8'));
                for (const w of data) {
                    const config = { configurable: { thread_id: threadId, checkpoint_id: w.checkpointId } };
                    await super.putWrites(config, w.writes, w.taskId);
                }
            } catch (e) {
                console.error(`Failed to hydrate writes for ${threadId}:`, e);
            }
        }

        this.hydratedThreads.add(threadId);
    }

    async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
        const threadId = config.configurable?.thread_id;
        if (threadId) await this.hydrate(threadId);
        return super.getTuple(config);
    }

    async put(
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        newVersions?: any
    ): Promise<RunnableConfig> {
        // @ts-ignore
        const result = await super.put(config, checkpoint, metadata, newVersions);

        const threadId = config.configurable?.thread_id;
        if (threadId) {
            const cpPath = this.getCheckpointPath(threadId);
            let data: Record<string, SavedCheckpoint> = {};
            if (fs.existsSync(cpPath)) {
                try {
                    data = JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
                } catch (e) { }
            }
            data[checkpoint.id] = { checkpoint, metadata, newVersions };
            fs.writeFileSync(cpPath, JSON.stringify(data, null, 2));
        }

        return result;
    }

    async putWrites(
        config: RunnableConfig,
        writes: any[],
        taskId: string
    ): Promise<void> {
        await super.putWrites(config, writes, taskId);

        const threadId = config.configurable?.thread_id;
        const checkpointId = config.configurable?.checkpoint_id;

        if (threadId && checkpointId) {
            const wPath = this.getWritesPath(threadId);
            let data: SavedWrites[] = [];
            if (fs.existsSync(wPath)) {
                try {
                    data = JSON.parse(fs.readFileSync(wPath, 'utf-8'));
                } catch (e) { }
            }
            data.push({ checkpointId, writes, taskId });
            fs.writeFileSync(wPath, JSON.stringify(data, null, 2));
        }
    }

    async *list(
        config: RunnableConfig,
        options?: any,
        before?: any
    ): AsyncGenerator<CheckpointTuple> {
        const threadId = config.configurable?.thread_id;
        if (threadId) await this.hydrate(threadId);
        // @ts-ignore
        yield* super.list(config, options, before);
    }
}
