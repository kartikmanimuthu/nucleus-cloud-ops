/**
 * API Channel Adapter
 *
 * Implements ChannelAdapter for direct API triggers. This is the simplest
 * adapter — no outbound notifications. Callers poll /api/agent-ops/[runId]
 * or use SSE for results.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type {
    ChannelAdapter,
    ChannelType,
    DeliveryMode,
    HilCapabilities,
    GatewayMessage,
} from '@/lib/gateway/types';
import type { AgentOpsRun, AgentOpsEvent } from '@/lib/agent-ops/types';

export class ApiAdapter implements ChannelAdapter {
    readonly channelType: ChannelType = 'api';
    readonly deliveryMode: DeliveryMode = 'polling';
    readonly hilCapabilities: HilCapabilities = {
        clarification: false,
        approvalButtons: false,
        threadedReplies: false,
    };

    async validateRequest(req: NextRequest): Promise<boolean> {
        // Check for session, bearer token, or API key
        const authHeader = req.headers.get('authorization');
        const apiKey = req.headers.get('x-api-key');

        // If any auth mechanism is present, consider it valid
        // (actual session validation happens at the route level via getServerSession)
        if (authHeader || apiKey) return true;

        // Try session-based auth — check for session cookie presence
        const sessionCookie = req.cookies?.get('next-auth.session-token') || req.cookies?.get('__Secure-next-auth.session-token');
        return !!sessionCookie;
    }

    async parseInbound(req: NextRequest): Promise<GatewayMessage> {
        const payload = await req.json();

        const tenantId = req.headers.get('x-tenant-id') || 'default';

        return {
            channelType: 'api',
            tenantId,
            taskDescription: payload.taskDescription?.trim() || '',
            mode: payload.mode || 'fast',
            autoApprove: payload.autoApprove ?? false,
            accountId: payload.accountId,
            accountName: payload.accountName,
            selectedSkill: payload.selectedSkill,
            mcpServerIds: payload.mcpServerIds,
            model: payload.model,
            channelMeta: {
                apiKeyId: req.headers.get('x-api-key') || undefined,
                clientId: req.headers.get('x-client-id') || undefined,
            },
        };
    }

    async sendAck(_req: NextRequest, runId: string): Promise<Response> {
        return NextResponse.json({
            runId,
            status: 'queued',
            message: 'Agent Ops run started',
        });
    }

    // API adapter has no outbound — caller polls /api/agent-ops/[runId] or uses SSE
    async sendResult(_run: AgentOpsRun, _events: AgentOpsEvent[]): Promise<void> {}
    async sendError(_run: AgentOpsRun, _error: string): Promise<void> {}
    async sendClarification(_run: AgentOpsRun, _question: string): Promise<void> {}
    async sendApprovalRequest(_run: AgentOpsRun, _planSteps?: string[], _pendingTools?: string[]): Promise<void> {}

    async getConfig(_tenantId: string): Promise<Record<string, unknown>> {
        return {};
    }
}
