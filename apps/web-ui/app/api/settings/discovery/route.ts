import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { AuditService } from '@/lib/audit-service';

const CONFIG_KEY = 'discovery-cron';
const VALID_PERIODS = ['daily', 'weekly', 'monthly'] as const;
type Period = typeof VALID_PERIODS[number];

function periodToNextEligible(lastRunAt: string | null, period: Period): string | null {
    if (!lastRunAt) return null;
    const ms = { daily: 86400000, weekly: 604800000, monthly: 2592000000 }[period];
    return new Date(new Date(lastRunAt).getTime() + ms).toISOString();
}

export async function GET() {
    console.log('API - GET /api/settings/discovery - Fetching discovery cron config');

    const authError = await authorize('read', 'Resource');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        if (!tenantId) {
            return NextResponse.json({ success: false, error: 'No tenant context' }, { status: 403 });
        }

        const config = await TenantConfigService.getConfig<{ period: Period; lastRunAt?: string }>(
            CONFIG_KEY,
            tenantId
        );
        const period: Period = config?.period ?? 'daily';
        const lastRunAt = config?.lastRunAt ?? null;

        return NextResponse.json({
            success: true,
            data: {
                period,
                lastRunAt,
                nextEligibleAt: periodToNextEligible(lastRunAt, period),
            },
        });
    } catch (error) {
        console.error('API - Error fetching discovery settings:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch discovery settings' },
            { status: 500 }
        );
    }
}

export async function PUT(request: NextRequest) {
    console.log('API - PUT /api/settings/discovery - Saving discovery cron config');

    const authError = await authorize('update', 'Resource');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        if (!tenantId) {
            return NextResponse.json({ success: false, error: 'No tenant context' }, { status: 403 });
        }

        const body = await request.json();
        const { period } = body as { period?: string };

        if (!period || !(VALID_PERIODS as readonly string[]).includes(period)) {
            return NextResponse.json(
                { success: false, error: 'period must be one of: daily, weekly, monthly' },
                { status: 400 }
            );
        }

        const session = await getServerSession(authOptions);
        const updatedBy = session?.user?.email || 'api-user';

        // Preserve existing lastRunAt when updating period
        const existing = await TenantConfigService.getConfig<{ period: Period; lastRunAt?: string }>(
            CONFIG_KEY,
            tenantId
        );
        await TenantConfigService.saveConfig(
            CONFIG_KEY,
            { period: period as Period, lastRunAt: existing?.lastRunAt ?? null },
            tenantId,
            updatedBy
        );

        await AuditService.logUserAction({
            eventType: 'inventory.discovery.settings.updated',
            severity: 'medium',
            apiRoute: 'PUT /api/settings/discovery',
            httpMethod: 'PUT',
            action: 'Update Discovery Settings',
            resourceType: 'settings',
            resourceId: CONFIG_KEY,
            resourceName: 'Discovery Cron Settings',
            user: updatedBy,
            userType: 'user',
            status: 'success',
            details: `Updated discovery scan period to ${period}`,
            tenantId,
        });

        return NextResponse.json({ success: true, data: { period } });
    } catch (error) {
        console.error('API - Error saving discovery settings:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to save discovery settings' },
            { status: 500 }
        );
    }
}
