/**
 * Agent Ops Event — Dynamoose Model
 * 
 * Records every execution step (planning, tool calls, reflections, etc.)
 * PK: RUN#<runId>  |  SK: EVENT#<timestamp>#<sequence>
 */

import dynamoose from '../dynamoose-config';
import { AGENT_OPS_TABLE_NAME } from '../dynamoose-config';

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
    },
    {
        timestamps: false,
        saveUnknown: true, // Allow flexible metadata
    }
);

export const AgentOpsEventModel = dynamoose.model(
    `${AGENT_OPS_TABLE_NAME}`,
    AgentOpsEventSchema,
    {
        create: false,
        tableName: AGENT_OPS_TABLE_NAME,
    }
);
