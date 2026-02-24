/**
 * Vanilla API Trigger Endpoint
 * 
 * POST /api/v1/trigger/api
 * 
 * Direct API trigger with JSON payload.
 * Supports any programmatic client.
 */

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { executeAgentRun } from '@/lib/agent-ops/agent-executor';
import type { ApiTriggerMeta, TriggerRequest } from '@/lib/agent-ops/types';

export async function POST(req: Request) {
    try {
        // 1. Authentication — Session (UI), Bearer token, or API key
        const session = await getServerSession(authOptions);
        const authHeader = req.headers.get('authorization');
        const apiKey = req.headers.get('x-api-key');

        // Basic auth validation (can be extended with proper API key management)
        if (!session && !authHeader && !apiKey) {
            return NextResponse.json({ error: 'Missing authentication' }, { status: 401 });
        }

        // 2. Parse JSON payload
        const payload = (await req.json()) as TriggerRequest;

        if (!payload.taskDescription?.trim()) {
            return NextResponse.json({
                error: 'Missing required field: taskDescription',
            }, { status: 400 });
        }

        // 3. Mode (now handled dynamically by evaluator, but DB needs a string)
        const mode = payload.mode || 'fast';

        // 4. Build trigger metadata
        const trigger: ApiTriggerMeta = {
            apiKeyId: apiKey || undefined,
            clientId: req.headers.get('x-client-id') || undefined,
        };

        // 5. Create run record
        const tenantId = req.headers.get('x-tenant-id') || 'default';
        const run = await agentOpsService.createRun({
            tenantId,
            source: 'api',
            taskDescription: payload.taskDescription.trim(),
            mode,
            trigger,
            accountId: payload.accountId,
            accountName: payload.accountName,
            selectedSkill: payload.selectedSkill,
            mcpServerIds: payload.mcpServerIds,
        });

        // 6. Execute agent asynchronously
        executeAgentRun(run).catch((err) => {
            console.error('[API Trigger] Execution error:', err);
        });

        // 7. Immediate acknowledgement
        return NextResponse.json({
            runId: run.runId,
            status: 'queued',
            message: 'Agent Ops run started',
            mode,
            threadId: run.threadId,
        });

    } catch (error) {
        console.error('[API Trigger] Error:', error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : 'Internal server error',
        }, { status: 500 });
    }
}
