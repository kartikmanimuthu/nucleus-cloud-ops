import { NextRequest, NextResponse } from 'next/server';
import { ShellSessionService } from '@/lib/shell-session-service';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getSessionUserId } from '@/lib/auth-session';

export async function GET() {
    const authError = await authorize('read', 'ShellSession');
    if (authError) return authError;

    try {
        console.log('API - GET /api/shell/sessions - Listing sessions');
        const tenantId = await getSessionTenantId();
        const userId = await getSessionUserId();
        const sessions = await ShellSessionService.listSessions(tenantId, userId);
        return NextResponse.json({ success: true, data: sessions });
    } catch (error) {
        console.error('API - Error listing shell sessions:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to list sessions' },
            { status: 500 }
        );
    }
}

export async function POST(request: NextRequest) {
    const authError = await authorize('create', 'ShellSession');
    if (authError) return authError;

    try {
        console.log('API - POST /api/shell/sessions - Creating session');
        const tenantId = await getSessionTenantId();
        const userId = await getSessionUserId();
        const body = await request.json().catch(() => ({}));
        const session = await ShellSessionService.createSession(tenantId, userId, {
            accountId: body.accountId,
            accountName: body.accountName,
            region: body.region,
        });
        return NextResponse.json({ success: true, data: session }, { status: 201 });
    } catch (error) {
        console.error('API - Error creating shell session:', error);
        const message = error instanceof Error ? error.message : 'Failed to create session';
        const status = message.includes('Maximum') ? 429 : 500;
        return NextResponse.json({ success: false, error: message }, { status });
    }
}
