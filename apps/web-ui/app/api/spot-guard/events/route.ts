import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { SpotGuardService } from '@/lib/spot-guard-service';
import type { SpotEventSeverity, SpotEventType } from '@/lib/db/repositories/spot-guard/interface';

// GET /api/spot-guard/events — the Spot Guard timeline
export async function GET(request: NextRequest) {
    const authError = await authorize('read', 'SpotGuard');
    if (authError) return authError;

    try {
        const { searchParams } = new URL(request.url);
        const page = parseInt(searchParams.get('page') || '1', 10);
        const limit = parseInt(searchParams.get('limit') || '50', 10);

        const { events, total } = await SpotGuardService.listEvents({
            tenantId: await getSessionTenantId(),
            spotServiceId: searchParams.get('serviceId') || undefined,
            accountId: searchParams.get('account') || undefined,
            serviceName: searchParams.get('serviceName') || undefined,
            eventType: (searchParams.get('eventType') as SpotEventType) || undefined,
            eventTypes:
                searchParams
                    .get('eventTypes')
                    ?.split(',')
                    .map((t) => t.trim())
                    .filter(Boolean) as SpotEventType[] | undefined,
            severity: (searchParams.get('severity') as SpotEventSeverity) || undefined,
            since: searchParams.get('since') || undefined,
            page,
            limit,
        });

        return NextResponse.json({
            success: true,
            data: events,
            count: events.length,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        });
    } catch (error: unknown) {
        console.error('API - Error fetching spot-guard events:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch events' },
            { status: 500 },
        );
    }
}
