import { NextRequest, NextResponse } from 'next/server';
import { ShellSessionService } from '@/lib/shell-session-service';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getSessionUserId } from '@/lib/auth-session';

export async function DELETE(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const authError = await authorize('delete', 'ShellSession');
    if (authError) return authError;

    try {
        const { id } = await params;
        console.log(`API - DELETE /api/shell/sessions/${id} - Terminating session`);
        const tenantId = await getSessionTenantId();
        const userId = await getSessionUserId();
        const session = await ShellSessionService.terminateSession(tenantId, userId, id);
        return NextResponse.json({ success: true, data: session });
    } catch (error) {
        console.error('API - Error terminating shell session:', error);
        const message = error instanceof Error ? error.message : 'Failed to terminate session';
        const status = message.includes('not found') ? 404 : 500;
        return NextResponse.json({ success: false, error: message }, { status });
    }
}
