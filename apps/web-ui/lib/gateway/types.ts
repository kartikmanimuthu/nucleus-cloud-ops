// web-ui/lib/gateway/types.ts
import type { NextRequest } from 'next/server';
import type { AgentOpsRun, AgentOpsEvent, ScheduledTask } from '@/lib/agent-ops/types';

export type ChannelType = 'slack' | 'jira' | 'discord' | 'telegram' | 'webhook' | 'api';

export type DeliveryMode = 'streaming' | 'callback' | 'polling';

export interface HilCapabilities {
    clarification: boolean;
    approvalButtons: boolean;
    threadedReplies: boolean;
}

export interface GatewayMessage {
    channelType: ChannelType;
    tenantId: string;
    taskDescription: string;
    userId?: string;
    mode?: 'fast' | 'plan';
    autoApprove?: boolean;
    accountId?: string;
    accountName?: string;
    selectedSkill?: string;
    mcpServerIds?: string[];
    model?: string;
    replyContext?: ReplyContext;
    channelMeta: Record<string, unknown>;
}

export interface ReplyContext {
    runId: string;
    action: 'clarification_response' | 'approve' | 'reject';
    content?: string;
    tenantId?: string;
}

export type GatewayEventType =
    | 'run:started'
    | 'run:event'
    | 'run:completed'
    | 'run:failed'
    | 'run:cancelled'
    | 'hil:clarification'
    | 'hil:plan_approval'
    | 'hil:tool_approval';

export interface GatewayEvent {
    type: GatewayEventType;
    runId: string;
    tenantId: string;
    timestamp: Date;
    data: {
        event?: AgentOpsEvent;
        run?: AgentOpsRun;
        question?: string;
        planSteps?: string[];
        pendingTools?: string[];
        error?: string;
    };
}

/** Outcome category for a finished (or parked) scheduled run digest. */
export type ScheduledOutcome = 'result' | 'failure' | 'attention';

export interface ChannelAdapter {
    readonly channelType: ChannelType;
    readonly deliveryMode: DeliveryMode;
    readonly hilCapabilities: HilCapabilities;

    validateRequest(req: NextRequest): Promise<boolean>;
    parseInbound(req: NextRequest): Promise<GatewayMessage>;
    sendAck(req: NextRequest, runId: string): Promise<Response>;

    sendResult(run: AgentOpsRun, events: AgentOpsEvent[]): Promise<void>;
    sendError(run: AgentOpsRun, error: string): Promise<void>;

    sendClarification(run: AgentOpsRun, question: string): Promise<void>;
    sendApprovalRequest(run: AgentOpsRun, planSteps?: string[], pendingTools?: string[]): Promise<void>;

    sendStreamChunk?(run: AgentOpsRun, event: AgentOpsEvent): Promise<void>;

    /**
     * Proactive one-shot digest for a scheduled run (server → channel,
     * unidirectional). Destination comes from task.notification; credentials
     * from TenantConfig via run.tenantId. Implementations must never throw.
     */
    sendScheduledNotification?(task: ScheduledTask, run: AgentOpsRun, outcome: ScheduledOutcome): Promise<void>;

    getConfig(tenantId: string): Promise<Record<string, unknown>>;
}
