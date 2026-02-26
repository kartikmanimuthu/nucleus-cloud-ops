/**
 * Agent Ops — List Runs API
 * 
 * GET /api/agent-ops
 * Query params: tenantId, source, status, limit
 */

import { NextResponse } from 'next/server';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import type { TriggerSource, AgentOpsStatus } from '@/lib/agent-ops/types';

export async function GET(req: Request) {
    try {
        const url = new URL(req.url);
        const tenantId = url.searchParams.get('tenantId') || undefined;
        const source = url.searchParams.get('source') as TriggerSource | null;
        const status = url.searchParams.get('status') as AgentOpsStatus | null;
        const limit = parseInt(url.searchParams.get('limit') || '25', 10);

        const { runs, lastKey } = await agentOpsService.listRuns({
            tenantId,
            source: source || undefined,
            status: status || undefined,
            limit,
        });

        return NextResponse.json({
            runs,
            pagination: {
                lastKey,
                hasMore: !!lastKey,
            },
        });

    } catch (error) {
        console.error('[Agent Ops API] List runs error:', error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : 'Internal server error',
        }, { status: 500 });
    }
}
