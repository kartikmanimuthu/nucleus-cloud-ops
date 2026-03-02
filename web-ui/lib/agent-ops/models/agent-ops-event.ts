/**
 * Agent Ops Event — Dynamoose Model
 *
 * Single-table design (same table as AgentOpsRun).
 * PK: RUN#<runId>  |  SK: EVENT#<ISO-timestamp>#<hrtime-nanos>
 */

import dynamoose from '../dynamoose-config';
import { AGENT_OPS_TABLE_NAME } from '../dynamoose-config';

// ─── Exported Interfaces ───────────────────────────────────────────────

export type AgentEventType =
    | 'planning'
    | 'execution'
    | 'tool_call'
    | 'tool_result'
    | 'reflection'
    | 'revision'
    | 'final'
    | 'error';

export interface AgentOpsEvent {
    PK: string;                          // RUN#<runId>
    SK: string;                          // EVENT#<ISO-ts>#<nanos>
    runId: string;
    eventType: AgentEventType;
    node: string;                        // LangGraph node: evaluator, planner, generate, tools, reflect, final
    content?: string;                    // Capped at 10KB
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    toolOutput?: string;                 // Capped at 10KB
    metadata?: Record<string, unknown>;  // tokens, model, step, etc.
    createdAt: string;                   // ISO 8601
    ttl: number;                         // Unix epoch + 30 days
}

// ─── Dynamoose Schema ──────────────────────────────────────────────────

const AgentOpsEventSchema = new dynamoose.Schema(
    {
        PK: {
            type: String,
            hashKey: true,
        },
        SK: {
            type: String,
            rangeKey: true,
        },
        runId: {
            type: String,
            required: true,
        },
        eventType: {
            type: String,
            enum: ['planning', 'execution', 'tool_call', 'tool_result', 'reflection', 'revision', 'final', 'error'],
            required: true,
        },
        node: {
            type: String,
            required: true,
        },
        content: {
            type: String,
        },
        toolName: {
            type: String,
        },
        toolArgs: {
            type: Object,
        },
        toolOutput: {
            type: String,
        },
        metadata: {
            type: Object,
        },
        createdAt: {
            type: String,
            required: true,
        },
        ttl: {
            type: Number,
            required: true,
        },
    },
    {
        timestamps: false,
        saveUnknown: false,
    }
);

// ─── Model ─────────────────────────────────────────────────────────────

export const AgentOpsEventModel = dynamoose.model(
    AGENT_OPS_TABLE_NAME,
    AgentOpsEventSchema,
    {
        create: false, // Table is created by CDK
        tableName: AGENT_OPS_TABLE_NAME,
    }
);
