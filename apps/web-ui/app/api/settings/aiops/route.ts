import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { AuditService } from '@/lib/audit-service';
import {
    SUBAGENT_CONFIG_KEY,
    BUDGET_BOUNDS,
    clampBudget,
    platformSubagentsEnabled,
    resolveSubagentBudget,
    validateBudgetInput,
} from '@/lib/agent/subagent-budget';

export async function GET() {
    console.log('API - GET /api/settings/aiops - Fetching sub-agent budget');

    const authError = await authorize('read', 'Agent');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        if (!tenantId) {
            return NextResponse.json({ success: false, error: 'No tenant context' }, { status: 403 });
        }

        const budget = await resolveSubagentBudget(tenantId);

        return NextResponse.json({
            success: true,
            data: {
                budget,
                // The UI renders sliders bounded by these, and explains why a
                // ceiling is what it is rather than silently clipping input.
                bounds: BUDGET_BOUNDS,
                platformEnabled: platformSubagentsEnabled(),
            },
        });
    } catch (error) {
        console.error('API - Error fetching AI Ops settings:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch AI Ops settings' },
            { status: 500 },
        );
    }
}

export async function PUT(request: NextRequest) {
    console.log('API - PUT /api/settings/aiops - Saving sub-agent budget');

    const authError = await authorize('update', 'Agent');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        if (!tenantId) {
            return NextResponse.json({ success: false, error: 'No tenant context' }, { status: 403 });
        }

        const body = await request.json();
        const validationError = validateBudgetInput(body);
        if (validationError) {
            return NextResponse.json({ success: false, error: validationError }, { status: 400 });
        }

        // Persist the CLAMPED value so a stored row can never exceed the ceiling
        // that was in force when it was written.
        const budget = clampBudget(body);

        const session = await getServerSession(authOptions);
        const updatedBy = session?.user?.email || 'api-user';

        await TenantConfigService.saveConfig(SUBAGENT_CONFIG_KEY, budget, tenantId, updatedBy);

        await AuditService.logUserAction({
            eventType: 'aiops.subagents.settings.updated',
            severity: 'medium',
            apiRoute: 'PUT /api/settings/aiops',
            httpMethod: 'PUT',
            action: 'Update AI Ops Sub-Agent Settings',
            resourceType: 'settings',
            resourceId: SUBAGENT_CONFIG_KEY,
            resourceName: 'AI Ops Sub-Agent Budget',
            user: updatedBy,
            userType: 'user',
            status: 'success',
            details: `Sub-agents ${budget.enabled ? 'enabled' : 'disabled'}; concurrency=${budget.maxConcurrentSubagents}, perRun=${budget.maxSubagentsPerRun}, tokenBudget=${budget.maxSubagentTokensPerRun}`,
            tenantId,
        });

        return NextResponse.json({ success: true, data: { budget } });
    } catch (error) {
        console.error('API - Error saving AI Ops settings:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to save AI Ops settings' },
            { status: 500 },
        );
    }
}
