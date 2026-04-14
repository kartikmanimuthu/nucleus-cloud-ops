import { NextRequest, NextResponse } from 'next/server';
import { ShellSessionService } from '@/lib/shell-session-service';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getSessionUserId } from '@/lib/auth-session';

async function terminateSession(id: string) {
    const tenantId = await getSessionTenantId();
    const userId = await getSessionUserId();
    console.log(`API - DELETE /api/shell/sessions/${id} - Terminating session`);
    return ShellSessionService.terminateSession(tenantId, userId, id);
}

export async function DELETE(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const authError = await authorize('create', 'CloudShell');
    if (authError) return authError;

    try {
        const { id } = await params;
        const session = await terminateSession(id);
        return NextResponse.json({ success: true, data: session });
    } catch (error) {
        console.error('API - Error terminating shell session:', error);
        const message = error instanceof Error ? error.message : 'Failed to terminate session';
        const status = message.includes('not found') ? 404 : 500;
        return NextResponse.json({ success: false, error: message }, { status });
    }
}

// sendBeacon only sends POST — support _method=DELETE for tab close cleanup
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const method = request.nextUrl.searchParams.get('_method');
    if (method !== 'DELETE') {
        return NextResponse.json({ success: false, error: 'Method not allowed' }, { status: 405 });
    }

    const authError = await authorize('create', 'CloudShell');
    if (authError) return authError;

    try {
        const { id } = await params;
        const session = await terminateSession(id);
        return NextResponse.json({ success: true, data: session });
    } catch (error) {
        // Silently handle — this fires during page unload, nobody reads the response
        return NextResponse.json({ success: false }, { status: 200 });
    }
}
