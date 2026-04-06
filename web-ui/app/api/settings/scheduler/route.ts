import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { TenantConfigService } from '@/lib/tenant-config-service';

const SCHEDULER_CRON_KEY = 'scheduler_cron';
const DEFAULT_CRON = '*/30 * * * *';

// GET /api/settings/scheduler — get current cron for tenant
export async function GET() {
    console.log('API - GET /api/settings/scheduler - Fetching scheduler cron config');

    const authError = await authorize('read', 'Schedule');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const config = await TenantConfigService.getConfig<{ cron: string }>(SCHEDULER_CRON_KEY, tenantId);
        return NextResponse.json({ success: true, data: { cron: config?.cron ?? DEFAULT_CRON } });
    } catch (error) {
        console.error('API - Error fetching scheduler cron config:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch scheduler config' },
            { status: 500 }
        );
    }
}

// PUT /api/settings/scheduler — save cron for tenant
export async function PUT(request: NextRequest) {
    console.log('API - PUT /api/settings/scheduler - Saving scheduler cron config');

    const authError = await authorize('update', 'Schedule');
    if (authError) return authError;

    try {
        const body = await request.json();
        const { cron } = body as { cron?: string };

        if (!cron || typeof cron !== 'string' || cron.trim() === '') {
            return NextResponse.json(
                { success: false, error: 'cron is required' },
                { status: 400 }
            );
        }

        // Basic cron validation: must have exactly 5 space-separated parts
        const parts = cron.trim().split(/\s+/);
        if (parts.length !== 5) {
            return NextResponse.json(
                { success: false, error: 'Invalid cron expression: must have exactly 5 fields' },
                { status: 400 }
            );
        }

        const tenantId = await getSessionTenantId();
        await TenantConfigService.saveConfig(SCHEDULER_CRON_KEY, { cron: cron.trim() }, tenantId, 'user');

        return NextResponse.json({ success: true, data: { cron: cron.trim() } });
    } catch (error) {
        console.error('API - Error saving scheduler cron config:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to save scheduler config' },
            { status: 500 }
        );
    }
}
