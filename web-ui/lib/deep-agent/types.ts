// ============================================================================
// Deep Agent Module — Types
// Fully segregated from the existing agent module. All changes to Deep Agent
// features should be made within web-ui/lib/deep-agent/ and related directories.
// ============================================================================

import { AccountContext } from '../agent/agent-shared';

// ---------------------------------------------------------------------------
// Agent Configuration
// ---------------------------------------------------------------------------

export interface DeepAgentConfig {
    model: string;
    autoApprove: boolean;
    accounts?: AccountContext[];
    accountId?: string;
    accountName?: string;
    selectedSkills?: string[];  // Multiple skills (or empty = auto-load all)
    mcpServerIds?: string[];
    tenantId?: string;
    threadId?: string;
}

// ---------------------------------------------------------------------------
// Todo Items
// ---------------------------------------------------------------------------

export type TodoStatus = 'pending' | 'in_progress' | 'done' | 'blocked';

export interface TodoItem {
    id: string;
    title: string;
    status: TodoStatus;
    notes?: string;
    createdAt: string;  // ISO timestamp
    updatedAt: string;  // ISO timestamp
}

// ---------------------------------------------------------------------------
// HITL Approvals
// ---------------------------------------------------------------------------

export type ApprovalDecisionType = 'approve' | 'edit' | 'reject';

export interface ApprovalDecision {
    type: ApprovalDecisionType;
    args?: Record<string, unknown>; // Edited args (only for 'edit')
    feedback?: string;              // Optional rejection feedback
}

export interface ApprovalActionRequest {
    name: string;          // Tool name
    args: Record<string, unknown>;
}

export interface ApprovalReviewConfig {
    actionName: string;
    allowedDecisions: ApprovalDecisionType[];
}

export interface PendingApproval {
    threadId: string;
    actionRequests: ApprovalActionRequest[];
    reviewConfigs: ApprovalReviewConfig[];
    timestamp: string;
}

// ---------------------------------------------------------------------------
// Subagent Tracking
// ---------------------------------------------------------------------------

export type SubagentStatus = 'pending' | 'running' | 'complete' | 'error';

export interface SubagentEvent {
    id: string;          // Tool call ID
    name: string;        // Subagent name (e.g. "aws-ops")
    description: string; // Task description
    status: SubagentStatus;
    startedAt?: string;
    completedAt?: string;
    result?: string;
    error?: string;
}

// ---------------------------------------------------------------------------
// Chat History
// ---------------------------------------------------------------------------

export interface DeepAgentMessage {
    id: string;
    role: 'user' | 'assistant' | 'tool';
    content: string;
    toolCalls?: Array<{ name: string; args: Record<string, unknown>; id: string }>;
    toolCallId?: string;    // For tool result messages
    toolName?: string;      // For tool result messages
    approvalRequest?: PendingApproval;
    subagentEvents?: SubagentEvent[];
    phase?: 'planning' | 'execution' | 'approval' | 'complete';
    timestamp: string;
}

export interface DeepAgentThread {
    threadId: string;
    title: string;
    model: string;
    messages: DeepAgentMessage[];
    todos: TodoItem[];
    createdAt: string;
    updatedAt: string;
}

// ---------------------------------------------------------------------------
// Streaming Events (from API to UI)
// ---------------------------------------------------------------------------

export type DeepAgentStreamEventType =
    | 'text-delta'
    | 'phase-marker'
    | 'tool-call'
    | 'tool-result'
    | 'approval-required'
    | 'approval-resolved'
    | 'subagent-start'
    | 'subagent-complete'
    | 'subagent-error'
    | 'todo-update'
    | 'error'
    | 'done';

export interface DeepAgentStreamEvent {
    type: DeepAgentStreamEventType;
    data: unknown;
}

// ---------------------------------------------------------------------------
// API Request / Response shapes
// ---------------------------------------------------------------------------

export interface DeepAgentChatRequest {
    threadId?: string;
    message: string;
    config: DeepAgentConfig;
    // For HITL resume
    resume?: {
        decisions: ApprovalDecision[];
    };
}

export interface DeepAgentApproveRequest {
    threadId: string;
    decisions: ApprovalDecision[];
}
