/**
 * IAgentOpsRunRepository
 *
 * Contract for agent ops run persistence.
 * Implemented by AgentOpsRunDynamoRepository and AgentOpsRunPostgresRepository.
 * The feature flag USE_PG_AGENT_OPS controls which implementation is active.
 */
import type {
    AgentOpsRun,
    AgentOpsStatus,
    AgentOpsResult,
    AgentOpsClarification,
    AgentOpsApprovalRequest,
    TriggerSource,
    TriggerMetadata,
    AgentMode,
    RunListQuery,
} from '@/lib/agent-ops/types';

export type { RunListQuery };

export interface CreateRunParams {
    tenantId: string;
    source: TriggerSource;
    taskDescription: string;
    mode: AgentMode;
    trigger: TriggerMetadata;
    accountId?: string;
    accountName?: string;
    selectedSkill?: string;
    mcpServerIds?: string[];
    autoApprove?: boolean;
    model?: string;
}

export interface UpdateRunStatusExtra {
    result?: AgentOpsResult;
    error?: string;
    clarification?: AgentOpsClarification;
    approvalRequest?: AgentOpsApprovalRequest;
}

export interface IAgentOpsRunRepository {
    createRun(params: CreateRunParams): Promise<AgentOpsRun>;
    updateRunStatus(tenantId: string, runId: string, status: AgentOpsStatus, extra?: UpdateRunStatusExtra): Promise<void>;
    updateRunTrigger(tenantId: string, runId: string, trigger: TriggerMetadata): Promise<void>;
    updateApprovalMessageTs(tenantId: string, runId: string, slackMessageTs: string): Promise<void>;
    getRun(tenantId: string, runId: string): Promise<AgentOpsRun | null>;
    listRuns(query: RunListQuery): Promise<{ runs: AgentOpsRun[]; lastKey?: Record<string, unknown> }>;
    listRunsBySource(source: TriggerSource, limit?: number): Promise<AgentOpsRun[]>;
    findAwaitingApprovalRun(runId: string): Promise<AgentOpsRun | null>;
    findAwaitingApprovalRunByJiraIssue(issueKey: string): Promise<AgentOpsRun | null>;
    findAwaitingRunByJiraIssue(issueKey: string): Promise<AgentOpsRun | null>;
    findAwaitingRunBySlackThread(channelId: string, threadTs: string): Promise<AgentOpsRun | null>;
}
