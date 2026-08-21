// ============================================================================
// Deep Agent Module — Threads API
// GET  /api/deep-agent/threads  → list all threads
// POST /api/deep-agent/threads  → create a new thread
// ============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import {
    listThreads,
    createThread,
} from '../../../../lib/deep-agent/db/chat-history-store';
import { AuditService } from '@/lib/audit-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    GET: { action: 'read', subject: 'Agent' },
    POST: { action: 'create', subject: 'Agent' },
};

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 100);
        const skip = parseInt(searchParams.get('skip') ?? '0', 10);
        const threads = await listThreads(limit, skip);
        return NextResponse.json({ threads });
    } catch (err: any) {
        console.error('[DeepAgent] List threads error:', err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const threadId = body.threadId || uuidv4();
        const thread = await createThread(
            threadId,
            body.title || 'New conversation',
            body.model || 'default',
        );

        let tenantId = 'unknown';
        let userEmail = 'unknown';
        try {
            tenantId = await getSessionTenantId();
            const session = await getAuthSession();
            userEmail = session?.user?.email || 'unknown';
        } catch {}

        AuditService.logUserAction({
            action: 'chat.thread.created',
            eventType: 'chat.thread.created',
            severity: 'low',
            apiRoute: 'POST /api/deep-agent/threads',
            httpMethod: 'POST',
            resourceType: 'Thread',
            resourceId: threadId,
            resourceName: body.title || 'New conversation',
            user: userEmail,
            userType: 'user',
            status: 'success',
            details: `Created deep agent thread`,
            tenantId,
            metadata: { tenantId },
        }).catch(() => {});

        return NextResponse.json({ thread }, { status: 201 });
    } catch (err: any) {
        console.error('[DeepAgent] Create thread error:', err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
