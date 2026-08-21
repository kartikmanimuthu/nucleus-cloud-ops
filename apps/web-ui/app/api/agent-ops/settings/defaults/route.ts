/**
 * AgentOps Default Configuration API Route
 *
 * GET /api/agent-ops/settings/defaults — Returns the tenant's Agent Ops defaults
 *   (default model + graph iteration limit), or configured:false when unset.
 * PUT /api/agent-ops/settings/defaults — Validates and saves the defaults.
 *   Both fields are required. New runs for the tenant use these defaults.
 */

import { NextResponse } from 'next/server';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { authorize } from '@/lib/rbac/authorize';
import {
    AGENT_OPS_DEFAULTS_KEY,
    FALLBACK_MAX_ITERATIONS,
    validateAgentOpsDefaults,
} from '@/lib/agent-ops/agent-ops-defaults';
import type { AgentOpsDefaultsConfig } from '@/lib/agent-ops/types';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    GET: { action: 'read', subject: 'Settings' },
};

export async function GET() {
    try {
        const tenantId = await getSessionTenantId();
        const config = await TenantConfigService.getConfig<AgentOpsDefaultsConfig>(AGENT_OPS_DEFAULTS_KEY, tenantId);

        if (!config) {
            // Not configured yet — surface the effective fallback iteration limit
            // so the form can pre-fill a sensible value.
            return NextResponse.json({
                configured: false,
                defaultModel: '',
                maxIterations: FALLBACK_MAX_ITERATIONS,
            });
        }

        return NextResponse.json({
            configured: true,
            defaultModel: config.defaultModel,
            maxIterations: config.maxIterations,
        });
    } catch (error: any) {
        console.error('[API /agent-ops/settings/defaults] GET error:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to fetch Agent Ops defaults' },
            { status: 500 }
        );
    }
}

export async function PUT(req: Request) {
    try {
        const authError = await authorize('update', 'Agent');
        if (authError) return authError;

        const tenantId = await getSessionTenantId();
        const body = (await req.json()) as Partial<AgentOpsDefaultsConfig>;

        const validationError = validateAgentOpsDefaults(body);
        if (validationError) {
            return NextResponse.json({ error: validationError }, { status: 400 });
        }

        const config: AgentOpsDefaultsConfig = {
            defaultModel: body.defaultModel!.trim(),
            maxIterations: Math.round(Number(body.maxIterations)),
        };

        await TenantConfigService.saveConfig(AGENT_OPS_DEFAULTS_KEY, config, tenantId);
        console.log('[API /agent-ops/settings/defaults] Saved Agent Ops defaults');

        const session = await getAuthSession();
        AuditService.logUserAction({
            eventType: 'agent.settings.defaults_updated',
            severity: 'medium',
            apiRoute: 'PUT /api/agent-ops/settings/defaults',
            httpMethod: 'PUT',
            action: 'Updated Agent Ops Defaults',
            resourceType: 'agent',
            resourceId: 'agent-ops-defaults',
            resourceName: 'Agent Ops Defaults',
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: `Set default model to "${config.defaultModel}" and graph limit to ${config.maxIterations}`,
            metadata: { tenantId },
        }).catch(() => {});

        return NextResponse.json({
            success: true,
            configured: true,
            defaultModel: config.defaultModel,
            maxIterations: config.maxIterations,
        });
    } catch (error: any) {
        console.error('[API /agent-ops/settings/defaults] PUT error:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to save Agent Ops defaults' },
            { status: 500 }
        );
    }
}
