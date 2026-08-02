/**
 * Sub-agent run persistence — one row per dispatch_agent sub-agent, so a collapsed
 * card in the chat run rail can still be expanded after a page reload.
 *
 * The transcript deliberately lives here and NEVER in the dispatch_agent ToolMessage:
 * that message enters the orchestrator's context and would defeat the very isolation
 * sub-agents exist to provide.
 */

export interface SubagentTranscriptEntry {
    kind: 'ai' | 'tool';
    name?: string;
    text: string;
}

export interface SubagentRunRecord {
    tenantId: string;
    threadId: string;
    subagentId: string;
    role: string;
    task: string;
    status: string;
    toolCount: number;
    tokensIn: number;
    tokensOut: number;
    summary?: string | null;
    transcript?: SubagentTranscriptEntry[] | null;
}

export interface SubagentRunRepository {
    /** Upsert by (tenantId, threadId, subagentId) — a sub-agent is written once
     *  on completion, but a retried write must not create a duplicate row.
     *  Implementations MUST redact secrets before persisting. */
    save(record: SubagentRunRecord): Promise<void>;
    listByThread(tenantId: string, threadId: string): Promise<SubagentRunRecord[]>;
}
