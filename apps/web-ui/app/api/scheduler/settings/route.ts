import { NextRequest, NextResponse } from 'next/server';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { AuditService } from '@/lib/audit-service';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { getSessionTenantId } from '@/lib/auth-session';
import { getBoss } from '@/lib/boss-client';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    GET: { action: 'read', subject: 'Settings' },
    PUT: { action: 'update', subject: 'Settings' },
};

const VALID_INTERVALS = [5, 15, 30, 60] as const;
type ValidInterval = typeof VALID_INTERVALS[number];

const CONFIG_KEY = 'scheduler-cron';

function intervalToCron(minutes: number): string {
    switch (minutes) {
        case 5:  return '*/5 * * * *';
        case 15: return '*/15 * * * *';
        case 30: return '*/30 * * * *';
        case 60: return '0 * * * *';
        default: return '*/30 * * * *';
    }
}

// GET /api/scheduler/settings — Get current per-tenant scheduler config
export async function GET() {
    try {
        const tenantId = await getSessionTenantId();
        if (!tenantId) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
        }

        const config = await TenantConfigService.getConfig<{ intervalMinutes: number }>(CONFIG_KEY, tenantId);
        const intervalMinutes = config?.intervalMinutes ?? 30;

        return NextResponse.json({
            success: true,
            data: {
                intervalMinutes,
                cronExpression: intervalToCron(intervalMinutes),
                status: 'active',
                source: 'pg-boss',
            },
        });
    } catch (error: unknown) {
        console.error('API - Error fetching scheduler settings:', error);
        const message = error instanceof Error ? error.message : 'Failed to fetch scheduler settings';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}

// PUT /api/scheduler/settings — Update per-tenant scheduler interval
export async function PUT(request: NextRequest) {
    const tenantId = await getSessionTenantId();
    if (!tenantId) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const session = await getServerSession(authOptions);
        const updatedBy = session?.user?.email || 'api-user';

        const body = await request.json();
        const { scheduleInterval } = body;

        if (!scheduleInterval || !(VALID_INTERVALS as readonly number[]).includes(scheduleInterval)) {
            return NextResponse.json(
                { success: false, error: 'Invalid scheduleInterval. Must be 5, 15, 30, or 60.' },
                { status: 400 }
            );
        }

        const intervalMinutes = scheduleInterval as ValidInterval;

        // Persist to tenant_configs
        await TenantConfigService.saveConfig(CONFIG_KEY, { intervalMinutes }, tenantId, updatedBy);

        // Notify workers to reschedule live
        try {
            const boss = await getBoss();
            await boss.send('scheduler-reschedule', { tenantId, intervalMinutes });
        } catch (bossErr) {
            // Non-fatal — workers will pick up the new config on next restart
            console.warn('API - Failed to notify workers of reschedule (non-fatal):', bossErr);
        }

        // Audit log
        await AuditService.logUserAction({
            eventType: 'schedule.settings.updated',
            severity: 'medium',
            apiRoute: 'PUT /api/scheduler/settings',
            httpMethod: 'PUT',
            action: 'Update Scheduler Settings',
            resourceType: 'settings',
            resourceId: 'scheduler-cron',
            resourceName: 'Scheduler Cron Settings',
            user: updatedBy,
            userType: 'user',
            status: 'success',
            details: `Updated scheduler interval to ${intervalMinutes} minutes`,
            tenantId,
        });

        return NextResponse.json({
            success: true,
            data: {
                intervalMinutes,
                cronExpression: intervalToCron(intervalMinutes),
                source: 'pg-boss',
            },
            message: `Scheduler updated to run every ${intervalMinutes} minutes`,
        });
    } catch (error: unknown) {
        console.error('API - Error updating scheduler settings:', error);
        const message = error instanceof Error ? error.message : 'Failed to update scheduler settings';

        try {
            await AuditService.logUserAction({
                eventType: 'schedule.settings.updated',
                severity: 'medium',
                apiRoute: 'PUT /api/scheduler/settings',
                httpMethod: 'PUT',
                action: 'Update Scheduler Settings',
                resourceType: 'settings',
                resourceId: 'scheduler-cron',
                resourceName: 'Scheduler Cron Settings',
                user: 'system',
                userType: 'user',
                status: 'error',
                details: `Failed to update scheduler: ${message}`,
                tenantId,
            });
        } catch (auditErr) {
            console.error('Failed to log audit entry:', auditErr);
        }

        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
