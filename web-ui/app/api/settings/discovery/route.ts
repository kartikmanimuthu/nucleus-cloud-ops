import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { TenantConfigService } from '@/lib/tenant-config-service';

const DISCOVERY_CRON_KEY = 'discovery-cron';
const DEFAULT_PERIOD = 'daily';
const VALID_PERIODS = ['daily', 'weekly'] as const;
type DiscoveryPeriod = typeof VALID_PERIODS[number];

// GET /api/settings/discovery — get current discovery period for tenant
export async function GET() {
    console.log('API - GET /api/settings/discovery - Fetching discovery config');

    const authError = await authorize('read', 'Schedule');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const config = await TenantConfigService.getConfig<{ period: DiscoveryPeriod }>(DISCOVERY_CRON_KEY, tenantId);
        return NextResponse.json({ success: true, data: { period: config?.period ?? DEFAULT_PERIOD } });
    } catch (error) {
        console.error('API - Error fetching discovery config:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch discovery config' },
            { status: 500 }
        );
    }
}

// PUT /api/settings/discovery — save discovery period for tenant
export async function PUT(request: NextRequest) {
    console.log('API - PUT /api/settings/discovery - Saving discovery config');

    const authError = await authorize('update', 'Schedule');
    if (authError) return authError;

    try {
        const body = await request.json();
        const { period } = body as { period?: string };

        if (!period || !VALID_PERIODS.includes(period as DiscoveryPeriod)) {
            return NextResponse.json(
                { success: false, error: `period must be one of: ${VALID_PERIODS.join(', ')}` },
                { status: 400 }
            );
        }

        const tenantId = await getSessionTenantId();
        await TenantConfigService.saveConfig(DISCOVERY_CRON_KEY, { period }, tenantId, 'user');

        return NextResponse.json({ success: true, data: { period } });
    } catch (error) {
        console.error('API - Error saving discovery config:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to save discovery config' },
            { status: 500 }
        );
    }
}
